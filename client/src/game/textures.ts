// Prozedurale Texturen (Albedo + Normalmap) auf Canvas — keine Bilddateien.
import * as THREE from 'three';
import { makeRng } from '@tlg/shared';

const SIZE = 256;

function heightToNormal(h: Float32Array, size: number, strength = 2): THREE.DataTexture {
  const data = new Uint8Array(size * size * 4);
  const at = (x: number, y: number) => h[((y + size) % size) * size + ((x + size) % size)];
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const dx = (at(x + 1, y) - at(x - 1, y)) * strength, dy = (at(x, y + 1) - at(x, y - 1)) * strength;
    const len = Math.hypot(dx, dy, 1);
    const i = (y * size + x) * 4;
    data[i] = ((-dx / len) * 0.5 + 0.5) * 255; data[i + 1] = ((-dy / len) * 0.5 + 0.5) * 255; data[i + 2] = (1 / len) * 0.5 * 255 + 127; data[i + 3] = 255;
  }
  const t = new THREE.DataTexture(data, size, size); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.needsUpdate = true; return t;
}
function canvasTex(draw: (c: CanvasRenderingContext2D, size: number) => void): THREE.CanvasTexture {
  const cv = document.createElement('canvas'); cv.width = cv.height = SIZE;
  draw(cv.getContext('2d')!, SIZE);
  const t = new THREE.CanvasTexture(cv); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4; return t;
}
const noise2 = (rng: ReturnType<typeof makeRng>, size: number) => { const a = new Float32Array(size * size); for (let i = 0; i < a.length; i++) a[i] = rng.next(); return a; };
/** weiches Rauschen: mehrere Oktaven aus einem groben Gitter */
function smoothNoise(seed: number, size: number, octaves = 4) {
  const out = new Float32Array(size * size);
  let amp = 1, total = 0;
  for (let o = 0; o < octaves; o++) {
    const rng = makeRng(seed + o * 31); const cells = 4 << o; const g = noise2(rng, cells + 1);
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const fx = x / size * cells, fy = y / size * cells; const x0 = Math.floor(fx), y0 = Math.floor(fy); const tx = fx - x0, ty = fy - y0;
      const s = (a: number, b: number, t: number) => a + (b - a) * (t * t * (3 - 2 * t));
      const v = s(s(g[y0 * (cells + 1) + x0], g[y0 * (cells + 1) + x0 + 1], tx), s(g[(y0 + 1) * (cells + 1) + x0], g[(y0 + 1) * (cells + 1) + x0 + 1], tx), ty);
      out[y * size + x] += v * amp;
    }
    total += amp; amp *= 0.5;
  }
  for (let i = 0; i < out.length; i++) out[i] /= total;
  return out;
}

export function floorTextures() {
  const n = smoothNoise(11, SIZE);
  const height = new Float32Array(SIZE * SIZE);
  const map = canvasTex((c, s) => {
    const img = c.createImageData(s, s);
    for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) {
      // 2×2 Platten pro Kachel mit Fuge und abgeschrägter Kante
      const px = (x % (s / 2)) / (s / 2), py = (y % (s / 2)) / (s / 2);
      const edge = Math.min(px, 1 - px, py, 1 - py);
      const bevel = Math.min(1, edge / 0.06);
      const groove = edge < 0.025 ? 0 : 1;
      const v = n[y * s + x];
      height[y * s + x] = bevel * groove * (0.7 + v * 0.3);
      const base = 92 + (v - 0.5) * 50;
      const shade = groove ? (0.75 + bevel * 0.25) : 0.35;
      const i = (y * s + x) * 4;
      img.data[i] = base * shade * 1.05; img.data[i + 1] = (base - 6) * shade; img.data[i + 2] = (base - 14) * shade; img.data[i + 3] = 255;
    }
    c.putImageData(img, 0, 0);
  });
  return { map, normalMap: heightToNormal(height, SIZE, 3), roughness: 0.9 };
}

export function wallTextures() {
  const n = smoothNoise(23, SIZE);
  const height = new Float32Array(SIZE * SIZE);
  const map = canvasTex((c, s) => {
    const img = c.createImageData(s, s);
    const rows = 4, bh = s / rows;
    for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) {
      const row = Math.floor(y / bh); const off = row % 2 ? s / 4 : 0;
      const bx = ((x + off) % (s / 2)) / (s / 2), by = (y % bh) / bh;
      const edge = Math.min(bx, 1 - bx, by, 1 - by);
      const mortar = edge < 0.05 ? 1 : 0; const bevel = Math.min(1, (edge - 0.05) / 0.08);
      const v = n[y * s + x];
      height[y * s + x] = mortar ? 0 : 0.5 + bevel * 0.5 + (v - 0.5) * 0.2;
      const base = mortar ? 48 : 70 + (v - 0.5) * 40;
      const shade = mortar ? 1 : 0.8 + bevel * 0.2;
      const i = (y * s + x) * 4;
      img.data[i] = base * shade * 0.95; img.data[i + 1] = base * shade * 0.93; img.data[i + 2] = base * shade * 1.12; img.data[i + 3] = 255;
    }
    c.putImageData(img, 0, 0);
  });
  return { map, normalMap: heightToNormal(height, SIZE, 2.5), roughness: 0.85 };
}

export function woodTextures() {
  const n = smoothNoise(37, SIZE);
  const map = canvasTex((c, s) => {
    const img = c.createImageData(s, s);
    for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) {
      const grain = Math.sin((x / s) * 40 + n[y * s + x] * 6) * 0.5 + 0.5;
      const plank = Math.floor(y / (s / 4)); const seam = (y % (s / 4)) < 4 ? 0.5 : 1;
      const base = (70 + grain * 25 + (plank % 2) * 8) * seam;
      const i = (y * s + x) * 4; img.data[i] = base * 1.3; img.data[i + 1] = base * 0.85; img.data[i + 2] = base * 0.5; img.data[i + 3] = 255;
    }
    c.putImageData(img, 0, 0);
  });
  return { map, roughness: 0.8 };
}

/** Text als Sprite-Textur (Namen, Schadenszahlen). */
export function textSprite(text: string, color: string, size = 28, outline = true): THREE.Sprite {
  const cv = document.createElement('canvas'); const c = cv.getContext('2d')!;
  c.font = `bold ${size}px system-ui, sans-serif`;
  const w = Math.ceil(c.measureText(text).width) + 16; cv.width = Math.max(2, w); cv.height = size + 16;
  c.font = `bold ${size}px system-ui, sans-serif`; c.textBaseline = 'middle'; c.textAlign = 'center';
  if (outline) { c.lineWidth = 5; c.strokeStyle = 'rgba(0,0,0,.85)'; c.strokeText(text, cv.width / 2, cv.height / 2); }
  c.fillStyle = color; c.fillText(text, cv.width / 2, cv.height / 2);
  const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace;
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, transparent: true, depthWrite: false }));
  sp.scale.set(cv.width / 64, cv.height / 64, 1);
  return sp;
}
