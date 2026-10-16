// 3D-Renderer (Three.js): Kerker aus Instanzen mit prozeduralen Texturen, Figuren aus
// Grundkörpern mit prozeduraler Animation, Licht + Schatten + Bloom, Nebel des Krieges
// als Shader-Ebene. Keine Assets — alles entsteht zur Laufzeit.
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { MONSTERS, KERKER_CARDS, HERO_VISION, NEBEL_VISION, isWall, lineOfSight, makeRng } from '@tlg/shared';
import { floorTextures, wallTextures, woodTextures, textSprite } from './textures';
import { attachModel, type ModelAnimator } from './models';
import type { GameRenderer, View } from './renderer';
import { CLASS_COLOR } from './renderer';

const WALL_H = 1.1;
const MAX_LIGHTS = 10;
const TEAM_FALLBACK = '#dddddd';

export class Renderer3D implements GameRenderer {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private composer: EffectComposer;
  private bloom: UnrealBloomPass;
  private sun: THREE.DirectionalLight;
  private torchLights: THREE.PointLight[] = [];
  private torches: { x: number; y: number; mesh: THREE.Mesh }[] = [];
  private heroLight: THREE.PointLight;
  private heroes = new Map<string, Figure>();
  private monsters = new Map<number, Figure>();
  private walls = new Map<number, { mesh: THREE.Mesh; born: number }>();
  private traps = new Map<number, THREE.Group>();
  private zones = new Map<number, THREE.Mesh>();
  private projectiles = new Map<number, THREE.Mesh>();
  private artifact: THREE.Group;
  private artifactLight: THREE.PointLight;
  private exitRing: THREE.Group;
  private ghost: THREE.Group;
  private visionRings = new Map<string, THREE.Mesh>();
  private fogTex: THREE.DataTexture | null = null;
  private fogData: Uint8Array<ArrayBuffer> | null = null;
  private fogPlane: THREE.Mesh | null = null;
  private particles: ParticleSystem;
  private floaters: { sp: THREE.Sprite; born: number; x: number; z: number }[] = [];
  private fx: { until: number; born: number; obj: THREE.Object3D; update: (k: number) => void }[] = [];
  private camTarget = new THREE.Vector3();
  private camDist = 0;
  private camPan = new THREE.Vector2();
  private floorMat: THREE.MeshStandardMaterial; private wallMat: THREE.MeshStandardMaterial; private woodMat: THREE.MeshStandardMaterial;
  private raycaster = new THREE.Raycaster();
  private ground = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  private lastVisionKey = '';
  private clock = 0;

  constructor(private container: HTMLElement, private canvas: HTMLCanvasElement, private map: any, private isKerker: boolean) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
    this.renderer.shadowMap.enabled = true; this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping; this.renderer.toneMappingExposure = isKerker ? 1.35 : 1.2;
    this.scene.background = new THREE.Color(0x05050a);
    this.scene.fog = new THREE.FogExp2(0x07070d, isKerker ? 0.008 : 0.028);
    this.camera = new THREE.PerspectiveCamera(42, 1, 0.1, 200);

    // Licht
    this.scene.add(new THREE.HemisphereLight(0x6a6a90, 0x1a120c, isKerker ? 1.1 : 0.8));
    if (isKerker) this.scene.add(new THREE.AmbientLight(0x404058, 0.6));
    this.sun = new THREE.DirectionalLight(0xffe2c0, 1.4);
    this.sun.position.set(6, 14, 4); this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048); this.sun.shadow.bias = -0.0008; this.sun.shadow.normalBias = 0.02;
    const sc = this.sun.shadow.camera; const ext = isKerker ? 30 : 14; sc.left = -ext; sc.right = ext; sc.top = ext; sc.bottom = -ext; sc.near = 1; sc.far = 60;
    this.scene.add(this.sun); this.scene.add(this.sun.target);
    this.heroLight = new THREE.PointLight(0xffc890, isKerker ? 0 : 1.6, 7, 1.6); this.scene.add(this.heroLight);
    for (let i = 0; i < MAX_LIGHTS; i++) { const l = new THREE.PointLight(0xff9a40, 0, 5.5, 1.8); this.scene.add(l); this.torchLights.push(l); }

    // Materialien
    const ft = floorTextures(), wt = wallTextures(), wd = woodTextures();
    this.floorMat = new THREE.MeshStandardMaterial({ map: ft.map, normalMap: ft.normalMap, roughness: ft.roughness, metalness: 0.02 });
    this.wallMat = new THREE.MeshStandardMaterial({ map: wt.map, normalMap: wt.normalMap, roughness: wt.roughness, metalness: 0.05, normalScale: new THREE.Vector2(1.2, 1.2) });
    this.woodMat = new THREE.MeshStandardMaterial({ map: wd.map, roughness: wd.roughness });
    this.buildMap();

    this.artifact = this.makeArtifact(); this.scene.add(this.artifact);
    this.artifactLight = new THREE.PointLight(0xffc840, 2.2, 6, 1.5); this.scene.add(this.artifactLight);
    this.exitRing = this.makeExit(); this.scene.add(this.exitRing);
    this.scene.add(this.makeEntrance());
    this.ghost = this.makeGhost(); this.ghost.visible = false; this.scene.add(this.ghost);
    this.particles = new ParticleSystem(2500); this.scene.add(this.particles.points);
    if (!isKerker) this.buildFog();

    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.55, 0.5, 0.82);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());
    this.camTarget.set(map.entrance.x + .5, 0, map.entrance.y + .5);
    this.resize();
  }

  // ── Aufbau ───────────────────────────────────────────────────────
  private buildMap() {
    const m = this.map; const rng = makeRng((m.seed ?? 1) + 5);
    const floorTiles: [number, number][] = [], wallTiles: [number, number][] = [];
    for (let y = 0; y < m.h; y++) for (let x = 0; x < m.w; x++) {
      if (!isWall(m, x, y)) { floorTiles.push([x, y]); continue; }
      const near = [[0, 1], [0, -1], [1, 0], [-1, 0], [1, 1], [-1, 1], [1, -1], [-1, -1]].some(([dx, dy]) => x + dx >= 0 && y + dy >= 0 && x + dx < m.w && y + dy < m.h && !isWall(m, x + dx, y + dy));
      if (near) wallTiles.push([x, y]);
    }
    const floor = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 0.12, 1), this.floorMat, floorTiles.length);
    floor.receiveShadow = true;
    const mtx = new THREE.Matrix4(); const col = new THREE.Color();
    floorTiles.forEach(([x, y], i) => { mtx.makeTranslation(x + .5, -0.06, y + .5); floor.setMatrixAt(i, mtx); const v = 0.85 + rng.next() * 0.3; col.setRGB(v, v * 0.98, v * 0.95); floor.setColorAt(i, col); });
    floor.instanceColor!.needsUpdate = true;
    this.scene.add(floor);
    const walls = new THREE.InstancedMesh(new THREE.BoxGeometry(1, WALL_H, 1), this.wallMat, wallTiles.length);
    walls.castShadow = true; walls.receiveShadow = true;
    wallTiles.forEach(([x, y], i) => { mtx.makeTranslation(x + .5, WALL_H / 2, y + .5); walls.setMatrixAt(i, mtx); const v = 0.8 + rng.next() * 0.3; col.setRGB(v, v, v * 1.05); walls.setColorAt(i, col); });
    walls.instanceColor!.needsUpdate = true;
    this.scene.add(walls);
    // Sockel-/Bodenplatte unter allem, damit Lücken schwarz statt durchsichtig sind
    const base = new THREE.Mesh(new THREE.PlaneGeometry(m.w + 40, m.h + 40), new THREE.MeshStandardMaterial({ color: 0x050508, roughness: 1 }));
    base.rotation.x = -Math.PI / 2; base.position.set(m.w / 2, -0.2, m.h / 2); base.receiveShadow = true; this.scene.add(base);
    // Fackeln an Wänden mit Boden davor (Süden)
    const trng = makeRng((m.seed ?? 1) + 991);
    const torchGeo = new THREE.CylinderGeometry(0.03, 0.04, 0.35, 6); const torchMat = new THREE.MeshStandardMaterial({ color: 0x4a2e14, roughness: 1 });
    const flameGeo = new THREE.SphereGeometry(0.09, 8, 8); const flameMat = new THREE.MeshBasicMaterial({ color: 0xffa030 });
    for (const [x, y] of wallTiles) {
      if (y + 1 < m.h && !isWall(m, x, y + 1) && trng.next() < 0.07) {
        const g = new THREE.Group();
        const stick = new THREE.Mesh(torchGeo, torchMat); stick.rotation.x = 0.5; g.add(stick);
        const flame = new THREE.Mesh(flameGeo, flameMat); flame.position.set(0, 0.2, 0.08); g.add(flame);
        g.position.set(x + .5, 0.75, y + 1.02); this.scene.add(g);
        this.torches.push({ x: x + .5, y: y + 1.15, mesh: flame });
      }
    }
  }
  private makeArtifact() {
    const g = new THREE.Group();
    const core = new THREE.Mesh(new THREE.OctahedronGeometry(0.28), new THREE.MeshStandardMaterial({ color: 0xffd04a, emissive: 0xffb020, emissiveIntensity: 1.6, metalness: 0.6, roughness: 0.25 }));
    core.castShadow = true; g.add(core);
    const halo = new THREE.Mesh(new THREE.TorusGeometry(0.42, 0.02, 8, 32), new THREE.MeshBasicMaterial({ color: 0xffe08a })); halo.rotation.x = Math.PI / 2; g.add(halo);
    g.position.set(this.map.artifact.x + .5, 0.6, this.map.artifact.y + .5);
    return g;
  }
  private makeExit() {
    const g = new THREE.Group();
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.42, 0.05, 10, 40), new THREE.MeshStandardMaterial({ color: 0x5fd0e0, emissive: 0x3ec8dc, emissiveIntensity: 1.8 }));
    ring.rotation.x = Math.PI / 2; ring.position.y = 0.04; g.add(ring);
    const disc = new THREE.Mesh(new THREE.CircleGeometry(0.4, 32), new THREE.MeshBasicMaterial({ color: 0x1a6a78, transparent: true, opacity: 0.75 })); disc.rotation.x = -Math.PI / 2; disc.position.y = 0.03; g.add(disc);
    const light = new THREE.PointLight(0x5fd0e0, 1.6, 4, 1.5); light.position.y = 0.6; g.add(light);
    g.add(floorLabel('AUSGANG', '#cfeff5', -0.95));
    g.position.set(this.map.exit.x + .5, 0, this.map.exit.y + .5);
    return g;
  }
  private makeEntrance() {
    const g = new THREE.Group();
    const mat = new THREE.MeshStandardMaterial({ color: 0x2a2a38, roughness: 0.9 });
    for (let i = 0; i < 3; i++) { const s = new THREE.Mesh(new THREE.BoxGeometry(0.8 - i * 0.2, 0.1, 0.8 - i * 0.2), mat); s.position.y = -0.02 - i * 0.07; g.add(s); }
    g.add(floorLabel('EINGANG', '#9a9ab0', -1.15));
    g.position.set(this.map.entrance.x + .5, 0, this.map.entrance.y + .5);
    return g;
  }
  private makeGhost() {
    const g = new THREE.Group();
    const box = new THREE.Mesh(new THREE.BoxGeometry(0.98, 0.5, 0.98), new THREE.MeshBasicMaterial({ color: 0x5fc68a, transparent: true, opacity: 0.4 })); box.name = 'box'; box.position.y = 0.25; g.add(box);
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.9, 1, 48), new THREE.MeshBasicMaterial({ color: 0xa77be0, transparent: true, opacity: 0.5, side: THREE.DoubleSide })); ring.name = 'ring'; ring.rotation.x = -Math.PI / 2; ring.position.y = 0.05; g.add(ring);
    return g;
  }
  private static FOG_RES = 3; // Unterteilungen pro Kachel für weiche Ränder
  private buildFog() {
    const m = this.map; const R = Renderer3D.FOG_RES; const W = m.w * R, H = m.h * R;
    this.fogData = new Uint8Array(new ArrayBuffer(W * H * 4)).fill(255);
    this.fogTex = new THREE.DataTexture(this.fogData, W, H, THREE.RGBAFormat, THREE.UnsignedByteType);
    this.fogTex.magFilter = THREE.LinearFilter; this.fogTex.minFilter = THREE.LinearFilter; this.fogTex.needsUpdate = true;
    const mat = new THREE.MeshBasicMaterial({ color: 0x05050a, transparent: true, alphaMap: this.fogTex, depthWrite: false, fog: false });
    this.fogPlane = new THREE.Mesh(new THREE.PlaneGeometry(m.w, m.h), mat);
    this.fogPlane.rotation.x = -Math.PI / 2; this.fogPlane.position.set(m.w / 2, WALL_H + 0.4, m.h / 2);
    this.fogPlane.renderOrder = 50; this.scene.add(this.fogPlane);
  }
  resize() {
    const w = this.container.clientWidth, h = this.container.clientHeight;
    this.renderer.setSize(w, h, false); this.composer.setSize(w, h);
    this.camera.aspect = w / h; this.camera.updateProjectionMatrix();
    if (this.isKerker && !this.camDist) {
      const tan = Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2));
      this.camDist = Math.max((this.map.h * 1.12 / 2) / tan, (this.map.w / 2) / (tan * this.camera.aspect)) * 0.98;
    }
  }
  wheel(deltaY: number) { if (!this.isKerker) return; this.camDist = THREE.MathUtils.clamp(this.camDist * (deltaY > 0 ? 1.12 : 0.89), 8, 80); }
  pan(dx: number, dy: number) { if (!this.isKerker) return; this.camPan.x += dx * this.camDist * 0.0015; this.camPan.y += dy * this.camDist * 0.0015; }

  screenToWorld(sx: number, sy: number) {
    const r = this.container.getBoundingClientRect();
    const ndc = new THREE.Vector2(((sx - r.left) / r.width) * 2 - 1, -((sy - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const p = new THREE.Vector3();
    if (!this.raycaster.ray.intersectPlane(this.ground, p)) return { x: -1, y: -1 };
    return { x: p.x, y: p.z };
  }

  // ── Frame ────────────────────────────────────────────────────────
  frame(v: View) {
    const { cur, now, dt } = v; this.clock = now;
    const m = this.map;
    // Kamera
    if (this.isKerker) {
      const cx = m.w / 2 + this.camPan.x, cz = m.h / 2 + 1 + this.camPan.y;
      this.camTarget.set(cx, 0, cz);
      this.camera.position.set(cx, this.camDist * 0.94, cz + this.camDist * 0.34);
    } else if (v.meHero) {
      this.camTarget.lerp(new THREE.Vector3(v.meHero.x, 0, v.meHero.y), 0.18);
      this.camera.position.set(this.camTarget.x, 10.5, this.camTarget.z + 7.8);
    }
    if (v.shake) this.camera.position.add(new THREE.Vector3((Math.random() - .5) * v.shake * 0.04, (Math.random() - .5) * v.shake * 0.03, 0));
    this.camera.lookAt(this.camTarget.x, 0.4, this.camTarget.z);
    this.sun.position.set(this.camTarget.x + 6, 16, this.camTarget.z + 5); this.sun.target.position.copy(this.camTarget);
    this.scene.fog!.color.setHex(0x07070d);

    // Fackeln: nächste N bekommen echtes Licht, alle flackern
    const sorted = this.torches.map(t => ({ t, d: (t.x - this.camTarget.x) ** 2 + (t.y - this.camTarget.z) ** 2 })).sort((a, b) => a.d - b.d);
    for (let i = 0; i < MAX_LIGHTS; i++) {
      const l = this.torchLights[i]; const e = sorted[i];
      if (!e || (this.isKerker && i >= 6)) { l.intensity = 0; continue; }
      const fl = 0.8 + Math.sin(now / 90 + e.t.x * 7) * 0.12 + Math.random() * 0.1;
      l.position.set(e.t.x, 0.95, e.t.y); l.intensity = (this.isKerker ? 1.0 : 1.5) * fl;
    }
    for (const t of this.torches) { const s = 0.85 + Math.sin(now / 70 + t.x * 3) * 0.15; t.mesh.scale.set(s, 1 + (1 - s), s); }
    if (v.meHero?.alive) { this.heroLight.position.set(v.meHero.x, 1.3, v.meHero.y); this.heroLight.intensity = 1.6; } else this.heroLight.intensity = 0;

    // Artefakt / Ausgang
    if (cur.artifact && cur.artifact.carrier === null) {
      this.artifact.visible = true; this.artifact.position.set(cur.artifact.x, 0.6 + Math.sin(now / 350) * 0.08, cur.artifact.y);
      this.artifact.rotation.y = now / 800; this.artifact.children[1].rotation.z = now / 500;
      this.artifactLight.position.copy(this.artifact.position); this.artifactLight.intensity = 2 + Math.sin(now / 200) * 0.5;
      if (Math.random() < 0.2) this.particles.burst(cur.artifact.x, 0.6, cur.artifact.y, 1, 0xffe08a, 0.4, 1200, 0.07, 0.6);
    } else { this.artifact.visible = false; this.artifactLight.intensity = 0; }
    this.exitRing.children[0].rotation.z = now / 600; (this.exitRing.children[2] as THREE.PointLight).intensity = 1.4 + Math.sin(now / 250) * 0.4;
    if (Math.random() < 0.25) this.particles.burst(this.exitRing.position.x, 0.1, this.exitRing.position.z, 1, 0x7fe8f0, 0.3, 900, 0.06, 0.8);

    // Helden
    const seen = new Set<string>();
    for (const hh of v.heroes) {
      seen.add(hh.id);
      let f = this.heroes.get(hh.id);
      if (!f) { f = makeHeroFigure(hh, v.teamColor(hh.id)); this.scene.add(f.group); this.heroes.set(hh.id, f); }
      f.update(hh.x, hh.y, hh.facing, dt, now);
      f.setState({ alive: hh.alive, hp: hh.hp, maxHp: hh.maxHp, invisible: cur.now < hh.invisibleUntil, stunned: cur.now < hh.stunnedUntil, carrying: cur.artifact?.carrier === hh.id, isMe: hh.id === v.meId, respawnIn: hh.respawnAt ? hh.respawnAt - cur.now : 0 });
    }
    for (const [id, f] of this.heroes) if (!seen.has(id)) { this.scene.remove(f.group); this.heroes.delete(id); }
    // Monster
    const seenM = new Set<number>();
    for (const mo of v.monsters) {
      seenM.add(mo.id);
      let f = this.monsters.get(mo.id);
      if (!f) { f = makeMonsterFigure(mo); this.scene.add(f.group); this.monsters.set(mo.id, f); }
      f.update(mo.x, mo.y, f.facingFromMotion(mo.x, mo.y), dt, now);
      f.setState({ alive: true, hp: mo.hp, maxHp: mo.maxHp });
    }
    for (const [id, f] of this.monsters) if (!seenM.has(id)) { this.scene.remove(f.group); this.monsters.delete(id); }
    // Mauern
    const seenW = new Set<number>();
    for (const w of cur.walls) {
      seenW.add(w.id);
      let e = this.walls.get(w.id);
      if (!e) { const mesh = new THREE.Mesh(new THREE.BoxGeometry(0.92, 0.95, 0.92), this.woodMat.clone()); mesh.castShadow = true; mesh.receiveShadow = true; mesh.position.set(w.tx + .5, 0.475, w.ty + .5); this.scene.add(mesh); e = { mesh, born: now }; this.walls.set(w.id, e); }
      const k = Math.min(1, (now - e.born) / 250); const s = 0.5 + 0.5 * k; e.mesh.scale.set(s, s, s);
      const dmg = 1 - w.hp / 60; (e.mesh.material as THREE.MeshStandardMaterial).color.setRGB(1 - dmg * 0.5, 1 - dmg * 0.6, 1 - dmg * 0.6);
    }
    for (const [id, e] of this.walls) if (!seenW.has(id)) { this.scene.remove(e.mesh); this.walls.delete(id); }
    // Fallen
    const seenT = new Set<number>();
    for (const tr of cur.traps) {
      seenT.add(tr.id);
      let g = this.traps.get(tr.id);
      if (!g) { g = makeTrap(tr.type, this.isKerker && !tr.revealed); g.position.set(tr.tx + .5, 0, tr.ty + .5); this.scene.add(g); this.traps.set(tr.id, g); }
      const marker = g.getObjectByName('marker'); if (marker) { marker.visible = this.isKerker; marker.rotation.z = now / 900; (marker as THREE.Mesh).material = tr.revealed ? markerMatRevealed : markerMatHidden; }
    }
    for (const [id, g] of this.traps) if (!seenT.has(id)) { this.scene.remove(g); this.traps.delete(id); }
    // Nebel-Zonen
    const seenZ = new Set<number>();
    for (const z of cur.zones) {
      seenZ.add(z.id);
      let mesh = this.zones.get(z.id);
      if (!mesh) { mesh = new THREE.Mesh(new THREE.CylinderGeometry(z.r, z.r * 0.9, 0.9, 40, 1, true), new THREE.MeshBasicMaterial({ color: 0x7a4fd0, transparent: true, opacity: 0.22, side: THREE.DoubleSide, depthWrite: false })); mesh.position.set(z.x, 0.45, z.y); this.scene.add(mesh); this.zones.set(z.id, mesh); }
      mesh.rotation.y = now / 3000;
      if (Math.random() < 0.3) { const a = Math.random() * 6.28, rr = Math.random() * z.r; this.particles.burst(z.x + Math.cos(a) * rr, 0.2 + Math.random() * 0.5, z.y + Math.sin(a) * rr, 1, 0xb08cff, 0.15, 1500, 0.08, 0.3); }
    }
    for (const [id, mesh] of this.zones) if (!seenZ.has(id)) { this.scene.remove(mesh); this.zones.delete(id); }
    // Projektile
    const seenP = new Set<number>();
    for (const p of v.projectiles) {
      seenP.add(p.id);
      let mesh = this.projectiles.get(p.id);
      if (!mesh) { mesh = new THREE.Mesh(projGeo, projMat); this.scene.add(mesh); this.projectiles.set(p.id, mesh); }
      const prevP = cur === v.cur ? v.prev?.projectiles.find((q: any) => q.id === p.id) : null;
      mesh.position.set(p.x, 0.55, p.y);
      if (prevP) { const dx = p.x - prevP.x, dz = p.y - prevP.y; mesh.rotation.y = -Math.atan2(dz, dx); mesh.scale.set(1 + Math.hypot(dx, dz) * 3, 1, 1); }
      if (Math.random() < 0.6) this.particles.burst(p.x, 0.55, p.y, 1, 0xffe28a, 0.05, 250, 0.05, 0);
    }
    for (const [id, mesh] of this.projectiles) if (!seenP.has(id)) { this.scene.remove(mesh); this.projectiles.delete(id); }
    // Sichtkreise (Kerker) / Nebel des Krieges (Helden)
    if (this.isKerker) {
      const seenV = new Set<string>();
      for (const hh of v.heroes) {
        if (!hh.alive) continue; seenV.add(hh.id);
        const r = cur.zones.some((z: any) => Math.hypot(z.x - hh.x, z.y - hh.y) <= z.r) ? NEBEL_VISION : HERO_VISION;
        let ring = this.visionRings.get(hh.id);
        if (!ring) { ring = new THREE.Mesh(new THREE.RingGeometry(0.96, 1, 64), new THREE.MeshBasicMaterial({ color: 0x5aa9e6, transparent: true, opacity: 0.35, side: THREE.DoubleSide, depthWrite: false })); ring.rotation.x = -Math.PI / 2; ring.position.y = 0.08; this.scene.add(ring); this.visionRings.set(hh.id, ring); }
        ring.position.set(hh.x, 0.08, hh.y); ring.scale.set(r, r, 1); ring.rotation.z = now / 4000;
      }
      for (const [id, ring] of this.visionRings) if (!seenV.has(id)) { this.scene.remove(ring); this.visionRings.delete(id); }
      this.updateGhost(v);
    } else this.updateFog(v);

    this.particles.step(dt);
    for (let i = this.fx.length - 1; i >= 0; i--) { const e = this.fx[i]; if (e.until < now) { this.scene.remove(e.obj); this.fx.splice(i, 1); } else e.update((now - e.born) / (e.until - e.born)); }
    for (let i = this.floaters.length - 1; i >= 0; i--) { const f = this.floaters[i]; const age = now - f.born; if (age > 900) { this.scene.remove(f.sp); this.floaters.splice(i, 1); continue; } f.sp.position.set(f.x, 1.2 + age / 700, f.z); (f.sp.material as THREE.SpriteMaterial).opacity = 1 - age / 900; }
    this.composer.render();
  }

  private updateGhost(v: View) {
    const g = v.ghost;
    if (!g) { this.ghost.visible = false; return; }
    this.ghost.visible = true; this.ghost.position.set(g.tx + .5, 0, g.ty + .5);
    const box = this.ghost.getObjectByName('box') as THREE.Mesh; (box.material as THREE.MeshBasicMaterial).color.setHex(g.bad ? 0xe0534f : 0x5fc68a);
    const def = (KERKER_CARDS as any)[g.card]; const ring = this.ghost.getObjectByName('ring')!;
    ring.visible = def.kind === 'zone'; if (ring.visible) ring.scale.set(def.radius, def.radius, 1);
  }
  private tileState: Uint8Array | null = null;
  private updateFog(v: View) {
    if (!this.fogData || !this.fogTex) return;
    const m = this.map; const eyes = v.vision; const R = Renderer3D.FOG_RES; const W = m.w * R, H = m.h * R;
    const key = eyes.map(e => `${e.x.toFixed(2)},${e.y.toFixed(2)},${e.r}`).join('|');
    if (key === this.lastVisionKey) return; this.lastVisionKey = key;
    // 1) Kachelzustand: 0 unerforscht, 1 erforscht, 2 sichtbar (mit Sichtlinie)
    const st = this.tileState ||= new Uint8Array(m.w * m.h);
    for (let i = 0; i < st.length; i++) st[i] = v.explored[i] ? 1 : 0;
    const blocked = (x: number, y: number) => isWall(m, x, y) || v.cur.walls.some((w: any) => w.tx === x && w.ty === y);
    for (const e of eyes) {
      const ex = Math.floor(e.x), ey = Math.floor(e.y);
      for (let y = Math.max(0, Math.floor(e.y - e.r)); y <= Math.min(m.h - 1, Math.ceil(e.y + e.r)); y++) for (let x = Math.max(0, Math.floor(e.x - e.r)); x <= Math.min(m.w - 1, Math.ceil(e.x + e.r)); x++) {
        if ((x + .5 - e.x) ** 2 + (y + .5 - e.y) ** 2 > (e.r + 0.5) ** 2) continue;
        if (!lineOfSight(m, ex, ey, x, y, blocked)) continue;
        st[y * m.w + x] = 2;
      }
    }
    // 2) Feine Alpha-Textur: sichtbar → radialer Verlauf zum Rand, erforscht → 0.72, unerforscht → 1.
    //    PlaneGeometry: v=0 liegt nach der Drehung bei z=m.h, deshalb Zeilen spiegeln.
    const d = this.fogData;
    for (let gy = 0; gy < H; gy++) {
      const wy = (gy + 0.5) / R; const ty = Math.floor(wy); const row = (H - 1 - gy) * W;
      for (let gx = 0; gx < W; gx++) {
        const wx = (gx + 0.5) / R; const tx = Math.floor(wx);
        const s = st[ty * m.w + tx];
        let a = 1;
        if (s === 1) a = 0.72;
        else if (s === 2) {
          let best = 1;
          for (const e of eyes) { const dd = Math.hypot(wx - e.x, wy - e.y); const k = Math.min(1, Math.max(0, (dd - (e.r - 1.2)) / 1.2)); if (k < best) best = k; }
          a = 0.72 * best;
        }
        const i = (row + gx) * 4; const b = Math.round(a * 255);
        d[i] = b; d[i + 1] = b; d[i + 2] = b; d[i + 3] = 255;
      }
    }
    this.fogTex.needsUpdate = true;
  }

  // ── Ereignisse → Effekte ─────────────────────────────────────────
  event(ev: any, heroAt: (id: string) => any) {
    const P = this.particles; const now = this.clock;
    switch (ev.t) {
      case 'swing': { this.heroes.get(ev.hero)?.attack(now); const arc = new THREE.Mesh(new THREE.RingGeometry(ev.range * 0.6, ev.range, 24, 1, -1, 2), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.7, side: THREE.DoubleSide, depthWrite: false }));
        arc.rotation.x = -Math.PI / 2; arc.rotation.z = -ev.facing; arc.position.set(ev.x, 0.5, ev.y); this.scene.add(arc);
        this.fx.push({ obj: arc, born: now, until: now + 140, update: k => { (arc.material as THREE.MeshBasicMaterial).opacity = 0.7 * (1 - k); arc.scale.setScalar(0.8 + 0.3 * k); } }); break; }
      case 'hit': P.burst(ev.x, 0.6, ev.y, 10, 0xffd36b, 2.2, 400, 0.09, 0); this.floater(ev.x, ev.y, `-${ev.dmg}`, '#ffd36b'); break;
      case 'hero_hit': { const hh = heroAt(ev.hero); if (hh) { P.burst(hh.x, 0.7, hh.y, 8, 0xe0534f, 1.8, 350, 0.08, 0); this.floater(hh.x, hh.y, `-${ev.dmg}`, '#ff8a85'); } break; }
      case 'trap': P.burst(ev.tx + .5, 0.2, ev.ty + .5, 24, ev.type === 'stachel' ? 0xd8d8e8 : 0x6a4a2a, 2.5, 600, 0.1, -3); this.flashLight(ev.tx + .5, ev.ty + .5, 0xff4040, 3); break;
      case 'hero_dead': P.burst(ev.x, 0.5, ev.y, 40, 0xb8302c, 2.8, 800, 0.11, -4); P.burst(ev.x, 0.8, ev.y, 14, 0xffffff, 1.2, 600, 0.06, 1); break;
      case 'respawn': P.burst(this.map.entrance.x + .5, 0.3, this.map.entrance.y + .5, 30, 0x9fd8ff, 1.5, 900, 0.08, 1.5); this.flashLight(this.map.entrance.x + .5, this.map.entrance.y + .5, 0x9fd8ff, 2); break;
      case 'artifact_pick': { const hh = heroAt(ev.hero); if (hh) P.burst(hh.x, 0.9, hh.y, 30, 0xffd86b, 2, 900, 0.09, 1); break; }
      case 'monster_dead': P.burst(ev.x, 0.4, ev.y, 30, ev.type === 'brecher' ? 0x7a1f1f : 0xc0392b, 2.6, 700, 0.11, -4); break;
      case 'wall_hit': P.burst(ev.tx + .5, 0.6, ev.ty + .5, 6, 0xa07a50, 1.8, 350, 0.07, -3); break;
      case 'wall_broken': P.burst(ev.tx + .5, 0.5, ev.ty + .5, 36, 0x8a6a46, 2.6, 800, 0.12, -4); break;
      case 'reveal': P.burst(ev.tx + .5, 0.3, ev.ty + .5, 18, 0xc9a6ff, 1.2, 700, 0.08, 1); break;
      case 'ability':
        this.heroes.get(ev.hero)?.attack(now);
        if (ev.id === 'heilkreis') { const ring = new THREE.Mesh(new THREE.RingGeometry(0.9, 1, 48), new THREE.MeshBasicMaterial({ color: 0xf4d56b, transparent: true, opacity: 0.8, side: THREE.DoubleSide, depthWrite: false })); ring.rotation.x = -Math.PI / 2; ring.position.set(ev.x, 0.1, ev.y); this.scene.add(ring);
          this.fx.push({ obj: ring, born: now, until: now + 600, update: k => { ring.scale.setScalar(0.2 + 3.8 * k); (ring.material as THREE.MeshBasicMaterial).opacity = 0.8 * (1 - k); } }); P.burst(ev.x, 0.4, ev.y, 40, 0xfff0a0, 1.5, 1000, 0.08, 1.2); this.flashLight(ev.x, ev.y, 0xf4d56b, 2.5); }
        if (ev.id === 'schildstoss') P.burst(ev.x, 0.5, ev.y, 16, 0xcfd6e6, 2.2, 400, 0.08, 0);
        if (ev.id === 'spuersinn') { const ring = new THREE.Mesh(new THREE.RingGeometry(0.95, 1, 48), new THREE.MeshBasicMaterial({ color: 0xb48ae8, transparent: true, opacity: 0.8, side: THREE.DoubleSide, depthWrite: false })); ring.rotation.x = -Math.PI / 2; ring.position.set(ev.x, 0.1, ev.y); this.scene.add(ring);
          this.fx.push({ obj: ring, born: now, until: now + 500, update: k => { ring.scale.setScalar(0.2 + 5.8 * k); (ring.material as THREE.MeshBasicMaterial).opacity = 0.8 * (1 - k); } }); }
        break;
      case 'place': if (this.isKerker) P.burst(ev.tx + .5, 0.3, ev.ty + .5, 14, 0xc9a6ff, 1.4, 500, 0.08, 1); break;
    }
  }
  private floater(x: number, z: number, text: string, color: string) {
    const sp = textSprite(text, color, 30); sp.scale.multiplyScalar(0.5); sp.position.set(x, 1.2, z); this.scene.add(sp);
    this.floaters.push({ sp, born: this.clock, x, z });
  }
  private flashLight(x: number, z: number, color: number, intensity: number) {
    const l = new THREE.PointLight(color, intensity, 5, 1.5); l.position.set(x, 0.8, z); this.scene.add(l);
    const now = this.clock; this.fx.push({ obj: l, born: now, until: now + 350, update: k => { l.intensity = intensity * (1 - k); } });
  }
  dispose() { this.renderer.dispose(); this.composer.dispose(); }
}

/** Beschriftung flach auf dem Boden (vor der Markierung), damit nichts die Figuren verdeckt. */
function floorLabel(text: string, color: string, dz: number): THREE.Mesh {
  const sp = textSprite(text, color, 28); const mat = sp.material as THREE.SpriteMaterial;
  const w = sp.scale.x * 0.42, h = sp.scale.y * 0.42;
  const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ map: mat.map, transparent: true, depthWrite: false, opacity: 0.9 }));
  m.rotation.x = -Math.PI / 2; m.position.set(0, 0.03, dz); return m;
}

// ── Figuren ──────────────────────────────────────────────────────────
const projGeo = new THREE.SphereGeometry(0.08, 8, 8);
const projMat = new THREE.MeshBasicMaterial({ color: 0xfff3c0 });
const markerMatHidden = new THREE.MeshBasicMaterial({ color: 0xa77be0, transparent: true, opacity: 0.8, side: THREE.DoubleSide, depthWrite: false });
const markerMatRevealed = new THREE.MeshBasicMaterial({ color: 0xff6060, transparent: true, opacity: 0.8, side: THREE.DoubleSide, depthWrite: false });
const skinMat = new THREE.MeshStandardMaterial({ color: 0xe8c39e, roughness: 0.7 });
const darkMat = new THREE.MeshStandardMaterial({ color: 0x22222c, roughness: 0.8 });
const steelMat = new THREE.MeshStandardMaterial({ color: 0xc8ccd8, roughness: 0.35, metalness: 0.8 });
const woodMatS = new THREE.MeshStandardMaterial({ color: 0x7a4e26, roughness: 0.8 });
const glowMat = new THREE.MeshStandardMaterial({ color: 0xfff3b0, emissive: 0xf4d56b, emissiveIntensity: 0.7 });
const artifactMatS = new THREE.MeshStandardMaterial({ color: 0xffd04a, emissive: 0xffb020, emissiveIntensity: 1.4, metalness: 0.6, roughness: 0.3 });

type FigState = { alive: boolean; hp: number; maxHp: number; invisible?: boolean; stunned?: boolean; carrying?: boolean; isMe?: boolean; respawnIn?: number };
class Figure {
  group = new THREE.Group();
  body = new THREE.Group();
  limbs: { l: THREE.Object3D; phase: number; amp: number; axis: 'x' | 'z' }[] = [];
  hpBar: THREE.Sprite; hpCanvas: HTMLCanvasElement; lastHpFrac = -1;
  label?: THREE.Sprite; carry?: THREE.Mesh; ring?: THREE.Mesh; stars?: THREE.Group;
  animator: ModelAnimator | null = null;
  mats: THREE.MeshStandardMaterial[] = [];
  private baseColors = new Map<THREE.MeshStandardMaterial, THREE.Color>();
  private lastX = 0; private lastZ = 0; private phase = 0; private facing = 0; private attackUntil = 0;
  constructor(public radius: number) {
    this.group.add(this.body);
    this.hpCanvas = document.createElement('canvas'); this.hpCanvas.width = 64; this.hpCanvas.height = 8;
    this.hpBar = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(this.hpCanvas), transparent: true, depthWrite: false }));
    this.hpBar.scale.set(0.8, 0.1, 1); this.group.add(this.hpBar);
  }
  facingFromMotion(x: number, z: number) { const dx = x - this.lastX, dz = z - this.lastZ; return Math.hypot(dx, dz) > 0.003 ? Math.atan2(dz, dx) : this.facing; }
  update(x: number, z: number, facing: number, dt: number, now: number) {
    const moved = Math.hypot(x - this.lastX, z - this.lastZ); this.lastX = x; this.lastZ = z; this.facing = facing;
    this.group.position.set(x, 0, z);
    // Blickrichtung: Kachel-Winkel (x nach rechts, y nach unten) → Y-Rotation
    const target = -facing; let d = target - this.group.rotation.y; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI;
    this.group.rotation.y += d * Math.min(1, dt / 60);
    const moving = moved > 0.002;
    if (this.animator) { this.animator.update(dt, moving); return; }
    this.phase += moving ? moved * 9 : 0;
    const swing = moving ? Math.sin(this.phase) : Math.sin(now / 600) * 0.05;
    for (const lb of this.limbs) lb.l.rotation[lb.axis] = swing * lb.amp * (lb.phase ? -1 : 1);
    this.body.position.y = moving ? Math.abs(Math.sin(this.phase)) * 0.04 : Math.sin(now / 700) * 0.01;
    if (now < this.attackUntil) { const k = 1 - (this.attackUntil - now) / 220; const arm = this.limbs.find(l => (l.l as any).userData.arm === 'right'); if (arm) arm.l.rotation.x = -1.6 + k * 2.4; }
  }
  attack(now: number) { this.attackUntil = now + 220; this.animator?.attack(); }
  setState(s: FigState) {
    const frac = Math.max(0, s.hp / s.maxHp);
    if (frac !== this.lastHpFrac) { this.lastHpFrac = frac; const c = this.hpCanvas.getContext('2d')!; c.clearRect(0, 0, 64, 8); c.fillStyle = 'rgba(0,0,0,.7)'; c.fillRect(0, 0, 64, 8); c.fillStyle = frac < 0.3 ? '#e0534f' : '#5fc68a'; c.fillRect(1, 1, 62 * frac, 6); (this.hpBar.material as THREE.SpriteMaterial).map!.needsUpdate = true; }
    this.hpBar.position.y = this.radius * 3.2 + 0.25; this.hpBar.visible = s.alive;
    if (this.label) { this.label.position.y = this.radius * 3.2 + 0.5; this.label.visible = s.alive || true; }
    const opacity = !s.alive ? 0.35 : s.invisible ? 0.35 : 1;
    for (const m of this.mats) { if (!this.baseColors.has(m)) this.baseColors.set(m, m.color.clone()); m.transparent = opacity < 1; m.opacity = opacity; m.color.copy(this.baseColors.get(m)!); }
    if (!s.alive) { this.body.rotation.x = Math.PI / 2; this.body.position.y = -this.radius * 0.6; for (const m of this.mats) m.color.multiplyScalar(0.5); } else this.body.rotation.x = 0;
    if (this.carry) this.carry.visible = !!s.carrying;
    if (this.ring) { this.ring.visible = !!s.isMe && s.alive; }
    if (this.stars) this.stars.visible = !!s.stunned && s.alive;
  }
}

function makeHeroFigure(hh: any, teamColor: string): Figure {
  const f = new Figure(0.35);
  const col = new THREE.Color(CLASS_COLOR[hh.cls] || '#ffffff');
  const tcol = new THREE.Color(teamColor && teamColor !== 'inherit' ? teamColor : TEAM_FALLBACK);
  const bodyMat = new THREE.MeshStandardMaterial({ color: col, roughness: 0.6 });
  const cloakMat = new THREE.MeshStandardMaterial({ color: tcol, roughness: 0.9, side: THREE.DoubleSide });
  f.mats.push(bodyMat, cloakMat);
  const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.19, 0.3, 4, 10), bodyMat); torso.position.y = 0.55; torso.castShadow = true; f.body.add(torso);
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.15, 12, 12), skinMat); head.position.y = 0.95; head.castShadow = true; f.body.add(head);
  const hair = new THREE.Mesh(new THREE.SphereGeometry(0.155, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2), new THREE.MeshStandardMaterial({ color: col.clone().multiplyScalar(0.6), roughness: 0.9 })); hair.position.y = 0.97; f.body.add(hair);
  for (const s of [-1, 1]) { const eye = new THREE.Mesh(new THREE.SphereGeometry(0.025, 6, 6), darkMat); eye.position.set(0.13, 0.97, s * 0.06); f.body.add(eye); }
  // Umhang in Teamfarbe
  const cloak = new THREE.Mesh(new THREE.PlaneGeometry(0.34, 0.45), cloakMat); cloak.position.set(-0.17, 0.5, 0); cloak.rotation.y = Math.PI / 2; cloak.rotation.z = 0.15; cloak.castShadow = true; f.body.add(cloak);
  // Gliedmaßen (Drehpunkt oben)
  const limb = (geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number, len: number) => { const p = new THREE.Group(); p.position.set(x, y, z); const m = new THREE.Mesh(geo, mat); m.position.y = -len / 2; m.castShadow = true; p.add(m); f.body.add(p); return p; };
  const legGeo = new THREE.CylinderGeometry(0.06, 0.05, 0.32, 8), armGeo = new THREE.CylinderGeometry(0.05, 0.045, 0.3, 8);
  const legMat = new THREE.MeshStandardMaterial({ color: col.clone().multiplyScalar(0.5), roughness: 0.8 }); f.mats.push(legMat);
  const lL = limb(legGeo, legMat, 0, 0.36, -0.09, 0.32), lR = limb(legGeo, legMat, 0, 0.36, 0.09, 0.32);
  const aL = limb(armGeo, bodyMat, 0, 0.75, -0.24, 0.3), aR = limb(armGeo, bodyMat, 0, 0.75, 0.24, 0.3); (aR as any).userData.arm = 'right';
  f.limbs.push({ l: lL, phase: 0, amp: 0.7, axis: 'z' }, { l: lR, phase: 1, amp: 0.7, axis: 'z' }, { l: aL, phase: 1, amp: 0.5, axis: 'z' }, { l: aR, phase: 0, amp: 0.5, axis: 'z' });
  // Klassen-Ausrüstung in der rechten Hand (Kindobjekt des Arms) / linken
  const hand = (parent: THREE.Group, obj: THREE.Object3D) => { obj.position.y = -0.3; parent.add(obj); };
  switch (hh.cls) {
    case 'krieger': { const sword = new THREE.Group(); const blade = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.05, 0.015), steelMat); blade.position.x = 0.3; sword.add(blade); const guard = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.14, 0.03), woodMatS); sword.add(guard); hand(aR, sword);
      const shield = new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.17, 0.03, 16), new THREE.MeshStandardMaterial({ color: 0x8a94a8, metalness: 0.6, roughness: 0.4 })); shield.rotation.z = Math.PI / 2; shield.position.set(0.05, -0.2, -0.05); aL.add(shield);
      const helm = new THREE.Mesh(new THREE.ConeGeometry(0.17, 0.2, 12), steelMat); helm.position.y = 1.1; f.body.add(helm); break; }
    case 'schuetze': { const bow = new THREE.Mesh(new THREE.TorusGeometry(0.28, 0.015, 6, 24, Math.PI), woodMatS); bow.rotation.y = Math.PI / 2; bow.rotation.z = -Math.PI / 2; hand(aL, bow); const hood = new THREE.Mesh(new THREE.ConeGeometry(0.18, 0.25, 12), new THREE.MeshStandardMaterial({ color: 0x2f6b45, roughness: 0.9 })); hood.position.y = 1.08; f.body.add(hood);
      const quiver = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.35, 8), woodMatS); quiver.position.set(-0.2, 0.6, 0.1); quiver.rotation.x = 0.3; f.body.add(quiver); break; }
    case 'heiler': { const staff = new THREE.Group(); const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.025, 1.0, 8), woodMatS); pole.position.y = 0.2; staff.add(pole); const orb = new THREE.Mesh(new THREE.SphereGeometry(0.07, 10, 10), glowMat); orb.position.y = 0.75; staff.add(orb); const l = new THREE.PointLight(0xf4d56b, 0.35, 2); l.position.y = 0.75; staff.add(l); hand(aR, staff);
      const hat = new THREE.Mesh(new THREE.ConeGeometry(0.2, 0.3, 12), new THREE.MeshStandardMaterial({ color: 0xc9a23a, roughness: 0.8 })); hat.position.y = 1.15; f.body.add(hat); break; }
    case 'schurke': { for (const arm of [aL, aR]) { const dag = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.03, 0.012), steelMat); dag.position.set(0.12, -0.3, 0); arm.add(dag); }
      const hood = new THREE.Mesh(new THREE.SphereGeometry(0.17, 12, 8, 0, Math.PI * 2, 0, Math.PI * 0.6), new THREE.MeshStandardMaterial({ color: 0x3a2a55, roughness: 0.95 })); hood.position.y = 0.98; f.body.add(hood); break; }
  }
  // Name, Artefakt, Markierung für den eigenen Helden, Betäubungssterne
  f.label = textSprite(hh.name, teamColor && teamColor !== 'inherit' ? teamColor : '#ffffff', 26); f.label.scale.multiplyScalar(0.5); f.group.add(f.label);
  f.carry = new THREE.Mesh(new THREE.OctahedronGeometry(0.14), artifactMatS); f.carry.position.y = 1.45; f.carry.visible = false; f.body.add(f.carry);
  f.ring = new THREE.Mesh(new THREE.RingGeometry(0.42, 0.48, 32), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.7, side: THREE.DoubleSide, depthWrite: false })); f.ring.rotation.x = -Math.PI / 2; f.ring.position.y = 0.02; f.group.add(f.ring);
  f.stars = new THREE.Group(); for (let i = 0; i < 3; i++) { const s = new THREE.Mesh(new THREE.SphereGeometry(0.03, 6, 6), glowMat); s.position.set(Math.cos(i * 2.1) * 0.2, 1.25, Math.sin(i * 2.1) * 0.2); f.stars.add(s); } f.stars.visible = false; f.body.add(f.stars);
  attachModel(`hero.${hh.cls}`, f.group, f.body).then(a => { if (a) f.animator = a; }).catch(e => console.warn('Modell', hh.cls, e));
  return f;
}

function makeMonsterFigure(mo: any): Figure {
  const md = (MONSTERS as any)[mo.type];
  const f = new Figure(md.radius);
  if (mo.type === 'krabbler') {
    const bodyMat = new THREE.MeshStandardMaterial({ color: 0x8a2222, roughness: 0.6 }); f.mats.push(bodyMat);
    const body = new THREE.Mesh(new THREE.SphereGeometry(0.22, 12, 10), bodyMat); body.position.y = 0.22; body.scale.set(1.2, 0.8, 1); body.castShadow = true; f.body.add(body);
    const headM = new THREE.Mesh(new THREE.SphereGeometry(0.12, 10, 8), bodyMat); headM.position.set(0.22, 0.24, 0); f.body.add(headM);
    for (const s of [-1, 1]) { const eye = new THREE.Mesh(new THREE.SphereGeometry(0.03, 6, 6), new THREE.MeshStandardMaterial({ color: 0xffe3a0, emissive: 0xffc040, emissiveIntensity: 1.5 })); eye.position.set(0.31, 0.27, s * 0.05); f.body.add(eye); }
    const legGeo = new THREE.CylinderGeometry(0.02, 0.012, 0.36, 5);
    for (let i = 0; i < 6; i++) { const side = i < 3 ? -1 : 1; const p = new THREE.Group(); p.position.set(-0.12 + (i % 3) * 0.12, 0.22, side * 0.15); const leg = new THREE.Mesh(legGeo, darkMat); leg.position.set(0, -0.1, side * 0.14); leg.rotation.x = side * 0.9; p.add(leg); f.body.add(p); f.limbs.push({ l: p, phase: i % 2, amp: 0.5, axis: 'z' }); }
  } else {
    const bodyMat = new THREE.MeshStandardMaterial({ color: 0x6a1a1a, roughness: 0.7 }); f.mats.push(bodyMat);
    const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.32, 0.4, 4, 12), bodyMat); body.position.y = 0.6; body.castShadow = true; f.body.add(body);
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.2, 12, 10), bodyMat); head.position.set(0.1, 1.05, 0); f.body.add(head);
    for (const s of [-1, 1]) { const horn = new THREE.Mesh(new THREE.ConeGeometry(0.06, 0.3, 8), new THREE.MeshStandardMaterial({ color: 0x3a1010 })); horn.position.set(0.05, 1.22, s * 0.16); horn.rotation.z = -0.4; horn.rotation.x = s * 0.5; f.body.add(horn);
      const eye = new THREE.Mesh(new THREE.SphereGeometry(0.035, 6, 6), new THREE.MeshStandardMaterial({ color: 0xffb347, emissive: 0xff8020, emissiveIntensity: 1.5 })); eye.position.set(0.27, 1.08, s * 0.08); f.body.add(eye); }
    const legGeo = new THREE.CylinderGeometry(0.1, 0.08, 0.4, 8), armGeo = new THREE.CylinderGeometry(0.09, 0.07, 0.5, 8);
    const limb = (geo: THREE.BufferGeometry, x: number, y: number, z: number, len: number) => { const p = new THREE.Group(); p.position.set(x, y, z); const m = new THREE.Mesh(geo, bodyMat); m.position.y = -len / 2; m.castShadow = true; p.add(m); f.body.add(p); return p; };
    f.limbs.push({ l: limb(legGeo, 0, 0.4, -0.16, 0.4), phase: 0, amp: 0.5, axis: 'z' }, { l: limb(legGeo, 0, 0.4, 0.16, 0.4), phase: 1, amp: 0.5, axis: 'z' }, { l: limb(armGeo, 0, 0.85, -0.4, 0.5), phase: 1, amp: 0.4, axis: 'z' }, { l: limb(armGeo, 0, 0.85, 0.4, 0.5), phase: 0, amp: 0.4, axis: 'z' });
  }
  attachModel(`monster.${mo.type}`, f.group, f.body).then(a => { if (a) f.animator = a; }).catch(e => console.warn('Modell', mo.type, e));
  return f;
}

function makeTrap(type: string, hidden: boolean): THREE.Group {
  const g = new THREE.Group();
  if (type === 'stachel') {
    const base = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.04, 0.8), darkMat); base.position.y = 0.02; g.add(base);
    for (let i = 0; i < 9; i++) { const s = new THREE.Mesh(new THREE.ConeGeometry(0.04, 0.3, 6), steelMat); s.position.set(-0.25 + (i % 3) * 0.25, 0.18, -0.25 + Math.floor(i / 3) * 0.25); s.castShadow = true; g.add(s); }
  } else {
    const pit = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.3, 0.3, 24), new THREE.MeshStandardMaterial({ color: 0x050508, roughness: 1 })); pit.position.y = -0.14; g.add(pit);
    const rim = new THREE.Mesh(new THREE.TorusGeometry(0.4, 0.03, 6, 24), darkMat); rim.rotation.x = Math.PI / 2; rim.position.y = 0.02; g.add(rim);
  }
  const marker = new THREE.Mesh(new THREE.RingGeometry(0.42, 0.48, 32), hidden ? markerMatHidden : markerMatRevealed); marker.name = 'marker'; marker.rotation.x = -Math.PI / 2; marker.position.y = 0.06; g.add(marker);
  return g;
}

// ── Partikel ─────────────────────────────────────────────────────────
class ParticleSystem {
  points: THREE.Points;
  private pos: Float32Array; private col: Float32Array; private vel: Float32Array; private life: Float32Array; private max: Float32Array; private size: Float32Array; private grav: Float32Array; private base: Float32Array;
  private n: number; private head = 0;
  constructor(n: number) {
    this.n = n; this.pos = new Float32Array(n * 3); this.col = new Float32Array(n * 3); this.vel = new Float32Array(n * 3); this.life = new Float32Array(n); this.max = new Float32Array(n).fill(1); this.size = new Float32Array(n); this.grav = new Float32Array(n); this.base = new Float32Array(n * 3);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3)); geo.setAttribute('color', new THREE.BufferAttribute(this.col, 3)); geo.setAttribute('size', new THREE.BufferAttribute(this.size, 1));
    const mat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, vertexColors: true,
      uniforms: { scale: { value: 300 } },
      vertexShader: `attribute float size; varying vec3 vColor; uniform float scale; void main(){ vColor = color; vec4 mv = modelViewMatrix * vec4(position,1.0); gl_PointSize = size * scale / -mv.z; gl_Position = projectionMatrix * mv; }`,
      fragmentShader: `varying vec3 vColor; void main(){ vec2 d = gl_PointCoord - 0.5; float a = smoothstep(0.5, 0.1, length(d)); gl_FragColor = vec4(vColor * a, a); }`,
    });
    this.points = new THREE.Points(geo, mat); this.points.frustumCulled = false;
  }
  burst(x: number, y: number, z: number, count: number, color: number, speed: number, lifeMs: number, size: number, up: number) {
    const c = new THREE.Color(color);
    for (let k = 0; k < count; k++) {
      const i = this.head; this.head = (this.head + 1) % this.n;
      const a = Math.random() * Math.PI * 2, s = speed * (0.3 + Math.random() * 0.9), el = (Math.random() - 0.3) * 1.2;
      this.pos[i * 3] = x; this.pos[i * 3 + 1] = y; this.pos[i * 3 + 2] = z;
      this.vel[i * 3] = Math.cos(a) * s * Math.cos(el); this.vel[i * 3 + 1] = Math.sin(el) * s + up; this.vel[i * 3 + 2] = Math.sin(a) * s * Math.cos(el);
      this.life[i] = lifeMs; this.max[i] = lifeMs; this.size[i] = size * (0.6 + Math.random() * 0.8); this.grav[i] = up > 0.5 ? 0.5 : up < 0 ? -up * 2.5 : 1.5;
      this.base[i * 3] = c.r; this.base[i * 3 + 1] = c.g; this.base[i * 3 + 2] = c.b;
    }
  }
  step(dt: number) {
    const s = dt / 1000;
    for (let i = 0; i < this.n; i++) {
      if (this.life[i] <= 0) { this.col[i * 3] = this.col[i * 3 + 1] = this.col[i * 3 + 2] = 0; this.size[i] = 0; continue; }
      this.life[i] -= dt;
      this.pos[i * 3] += this.vel[i * 3] * s; this.pos[i * 3 + 1] += this.vel[i * 3 + 1] * s; this.pos[i * 3 + 2] += this.vel[i * 3 + 2] * s;
      this.vel[i * 3 + 1] -= this.grav[i] * s * 2; if (this.pos[i * 3 + 1] < 0.02) { this.pos[i * 3 + 1] = 0.02; this.vel[i * 3 + 1] *= -0.3; }
      const a = Math.max(0, this.life[i] / this.max[i]);
      this.col[i * 3] = this.base[i * 3] * a; this.col[i * 3 + 1] = this.base[i * 3 + 1] * a; this.col[i * 3 + 2] = this.base[i * 3 + 2] * a;
    }
    const g = this.points.geometry; (g.attributes.position as THREE.BufferAttribute).needsUpdate = true; (g.attributes.color as THREE.BufferAttribute).needsUpdate = true; (g.attributes.size as THREE.BufferAttribute).needsUpdate = true;
  }
}
