// Optionale echte 3D-Modelle (glTF/GLB) statt der prozeduralen Figuren.
// client/public/models/manifest.json beschreibt sie; fehlt die Datei, bleibt alles prozedural.
// Beispiel:
// { "hero.krieger": { "url": "/models/knight.glb", "scale": 0.5, "yaw": 90,
//     "clips": { "idle": "Idle", "walk": "Walking_A", "attack": "1H_Melee_Attack_Chop" } },
//   "monster.krabbler": { "url": "/models/spider.glb", "scale": 0.4 } }
// `yaw` dreht das Modell so, dass es entlang +X blickt (Grad). Clip-Namen sind die des GLB.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

export type ModelDef = { url: string; scale?: number; yaw?: number; y?: number; clips?: { idle?: string; walk?: string; attack?: string } };
export type Manifest = Record<string, ModelDef>;

let manifestPromise: Promise<Manifest> | null = null;
const cache = new Map<string, Promise<{ scene: THREE.Group; clips: THREE.AnimationClip[] }>>();
const loader = new GLTFLoader();

export function loadManifest(): Promise<Manifest> {
  return manifestPromise ||= fetch('/models/manifest.json').then(r => r.ok ? r.json() : {}).catch(() => ({}));
}
function loadGlb(url: string) {
  return cache.get(url) || cache.set(url, new Promise((resolve, reject) => loader.load(url, g => resolve({ scene: g.scene, clips: g.animations }), undefined, reject))).get(url)!;
}

/** Hängt das Modell (geklont) an `parent`, versteckt `procedural` und liefert einen Animator. */
export async function attachModel(key: string, parent: THREE.Object3D, procedural: THREE.Object3D): Promise<ModelAnimator | null> {
  const def = (await loadManifest())[key];
  if (!def) return null;
  const { scene, clips } = await loadGlb(def.url);
  const inst = clone(scene);
  inst.scale.setScalar(def.scale ?? 1); inst.rotation.y = THREE.MathUtils.degToRad(def.yaw ?? 0); inst.position.y = def.y ?? 0;
  inst.traverse(o => { if ((o as THREE.Mesh).isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  procedural.visible = false; parent.add(inst);
  return new ModelAnimator(inst, clips, def.clips || {});
}
function clone(src: THREE.Group): THREE.Group {
  // SkeletonUtils.clone ist nötig für Skinned Meshes; für statische reicht clone().
  return (src.getObjectByProperty('isSkinnedMesh', true) ? skeletonClone(src) : src.clone()) as THREE.Group;
}
import { clone as skeletonClone } from 'three/addons/utils/SkeletonUtils.js';

export class ModelAnimator {
  private mixer: THREE.AnimationMixer;
  private actions: Record<string, THREE.AnimationAction | undefined> = {};
  private current: string | null = null;
  constructor(root: THREE.Object3D, clips: THREE.AnimationClip[], names: ModelDef['clips'] & {}) {
    this.mixer = new THREE.AnimationMixer(root);
    const find = (n?: string) => n ? clips.find(c => c.name === n) : undefined;
    for (const k of ['idle', 'walk', 'attack'] as const) { const c = find(names[k]) || (k === 'idle' ? clips[0] : undefined); if (c) this.actions[k] = this.mixer.clipAction(c); }
    if (this.actions.attack) { this.actions.attack.setLoop(THREE.LoopOnce, 1); this.actions.attack.clampWhenFinished = false; }
  }
  update(dt: number, moving: boolean) {
    const want = moving && this.actions.walk ? 'walk' : 'idle';
    if (want !== this.current && this.actions[want]) { const next = this.actions[want]!; next.reset().fadeIn(0.15).play(); if (this.current && this.actions[this.current]) this.actions[this.current]!.fadeOut(0.15); this.current = want; }
    this.mixer.update(dt / 1000);
  }
  attack() { const a = this.actions.attack; if (a) { a.reset().setEffectiveWeight(1).play(); } }
}
