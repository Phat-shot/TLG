// Zeichenroutinen: Kacheln, Figuren, Partikel. Alles prozedural, keine Assets.
import { TILE_PX, MONSTERS, isWall, makeRng } from '@tlg/shared';

export const CLASS_COLOR: Record<string, string> = { krieger: '#e8763f', schuetze: '#62cf8e', heiler: '#f4d56b', schurke: '#b48ae8' };
const T = TILE_PX;

// ── Kacheln (einmalig in eine Offscreen-Canvas) ──────────────────────
export function drawTiles(c: CanvasRenderingContext2D, map: any) {
  const rng = makeRng((map.seed ?? 1) + 77);
  const wallAt = (x: number, y: number) => isWall(map, x, y);
  // Boden
  for (let y = 0; y < map.h; y++) for (let x = 0; x < map.w; x++) {
    if (wallAt(x, y)) continue;
    const px = x * T, py = y * T;
    const v = rng.int(-6, 6);
    c.fillStyle = `rgb(${74 + v},${66 + v},${60 + v})`; c.fillRect(px, py, T, T);
    // Steinplatten-Fugen
    c.strokeStyle = 'rgba(0,0,0,.28)'; c.lineWidth = 1;
    c.strokeRect(px + .5, py + .5, T - 1, T - 1);
    if (rng.next() < 0.5) { c.beginPath(); c.moveTo(px + .5, py + rng.int(8, 24) + .5); c.lineTo(px + rng.int(10, 22), py + rng.int(8, 24) + .5); c.stroke(); }
    // Kiesel / Risse
    if (rng.next() < 0.25) { c.fillStyle = 'rgba(0,0,0,.18)'; c.beginPath(); c.arc(px + rng.int(4, 28), py + rng.int(4, 28), rng.int(1, 2), 0, 7); c.fill(); }
    if (rng.next() < 0.08) { c.strokeStyle = 'rgba(0,0,0,.35)'; c.beginPath(); const sx = px + rng.int(3, 20), sy = py + rng.int(3, 20); c.moveTo(sx, sy); c.lineTo(sx + rng.int(4, 10), sy + rng.int(2, 8)); c.lineTo(sx + rng.int(6, 14), sy + rng.int(6, 14)); c.stroke(); }
    // helle Kante oben-links
    c.fillStyle = 'rgba(255,255,255,.04)'; c.fillRect(px, py, T, 2); c.fillRect(px, py, 2, T);
  }
  // Mauern: Ziegel, mit "Stirnseite" nach unten, wo Boden angrenzt
  for (let y = 0; y < map.h; y++) for (let x = 0; x < map.w; x++) {
    if (!wallAt(x, y)) continue;
    const px = x * T, py = y * T;
    const faceBelow = !wallAt(x, y + 1) && y + 1 < map.h;
    const anyFloorNear = [[0, 1], [0, -1], [1, 0], [-1, 0], [1, 1], [-1, 1], [1, -1], [-1, -1]].some(([dx, dy]) => x + dx >= 0 && y + dy >= 0 && x + dx < map.w && y + dy < map.h && !wallAt(x + dx, y + dy));
    if (!anyFloorNear) { c.fillStyle = '#121220'; c.fillRect(px, py, T, T); continue; }
    // Oberseite
    c.fillStyle = '#2b2b40'; c.fillRect(px, py, T, T);
    c.strokeStyle = 'rgba(0,0,0,.4)'; c.lineWidth = 1;
    for (let row = 0; row < 4; row++) {
      const yy = py + row * 8 + .5;
      c.beginPath(); c.moveTo(px, yy); c.lineTo(px + T, yy); c.stroke();
      const off = row % 2 ? 8 : 0;
      for (let col = 0; col < 3; col++) { const xx = px + off + col * 16 + .5; if (xx < px + T) { c.beginPath(); c.moveTo(xx, yy); c.lineTo(xx, yy + 8); c.stroke(); } }
    }
    c.fillStyle = 'rgba(255,255,255,.06)'; c.fillRect(px, py, T, 1);
    if (faceBelow) {
      // Stirnseite: untere 10px dunkler mit Steinkanten
      c.fillStyle = '#1a1a2a'; c.fillRect(px, py + T - 10, T, 10);
      c.fillStyle = 'rgba(255,255,255,.07)'; c.fillRect(px, py + T - 10, T, 1);
      c.strokeStyle = 'rgba(0,0,0,.5)'; c.beginPath(); c.moveTo(px + 16.5, py + T - 10); c.lineTo(px + 16.5, py + T); c.stroke();
      // Schatten auf den Boden darunter
      const g = c.createLinearGradient(0, py + T, 0, py + T + 10);
      g.addColorStop(0, 'rgba(0,0,0,.45)'); g.addColorStop(1, 'rgba(0,0,0,0)');
      c.fillStyle = g; c.fillRect(px, py + T, T, 10);
    }
  }
  // Fackeln an ein paar Wandstücken (nur Dekor; die Lichtflecken malt der Renderer)
}

/** Fackelpositionen (Mauerkacheln mit Boden darunter), deterministisch. */
export function torchSpots(map: any): { x: number; y: number }[] {
  const rng = makeRng((map.seed ?? 1) + 991);
  const out: { x: number; y: number }[] = [];
  for (let y = 1; y < map.h - 1; y++) for (let x = 1; x < map.w - 1; x++) {
    if (isWall(map, x, y) && !isWall(map, x, y + 1) && rng.next() < 0.06) out.push({ x: x + .5, y: y + .85 });
  }
  return out;
}

// ── Partikel ─────────────────────────────────────────────────────────
export type Particle = { x: number; y: number; vx: number; vy: number; life: number; max: number; size: number; color: string; gravity?: number; glow?: boolean };
export class Particles {
  list: Particle[] = [];
  burst(x: number, y: number, n: number, color: string, speed = 3, life = 400, size = 3, gravity = 0, glow = false) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2, s = speed * (0.4 + Math.random() * 0.8);
      this.list.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life, max: life, size: size * (0.6 + Math.random() * 0.8), color, gravity, glow });
    }
  }
  step(dt: number) {
    const s = dt / 1000;
    for (let i = this.list.length - 1; i >= 0; i--) {
      const p = this.list[i];
      p.life -= dt; if (p.life <= 0) { this.list.splice(i, 1); continue; }
      p.x += p.vx * s; p.y += p.vy * s; p.vy += (p.gravity || 0) * s; p.vx *= 0.96; p.vy *= 0.96;
    }
    if (this.list.length > 1500) this.list.splice(0, this.list.length - 1500);
  }
  draw(c: CanvasRenderingContext2D) {
    for (const p of this.list) {
      const a = p.life / p.max;
      c.globalAlpha = a;
      if (p.glow) { c.shadowColor = p.color; c.shadowBlur = 8; }
      c.fillStyle = p.color; c.beginPath(); c.arc(p.x * T, p.y * T, p.size * a + 0.5, 0, 7); c.fill();
      c.shadowBlur = 0;
    }
    c.globalAlpha = 1;
  }
}

// ── Figuren ──────────────────────────────────────────────────────────
export function shadow(c: CanvasRenderingContext2D, px: number, py: number, r: number) {
  c.fillStyle = 'rgba(0,0,0,.35)'; c.beginPath(); c.ellipse(px, py + r * 0.9, r * 1.1, r * 0.45, 0, 0, 7); c.fill();
}

export function drawHeroFigure(c: CanvasRenderingContext2D, h: any, now: number, moving: boolean, carrying: boolean, isMe: boolean) {
  const px = h.x * T, py = h.y * T, r = 0.35 * T, col = CLASS_COLOR[h.cls] || '#fff';
  const bob = moving ? Math.sin(now / 90) * 1.5 : Math.sin(now / 600) * 0.6;
  const fx = Math.cos(h.facing), fy = Math.sin(h.facing);
  shadow(c, px, py, r);
  c.save(); c.translate(px, py + bob);
  if (isMe) { c.strokeStyle = 'rgba(255,255,255,.85)'; c.lineWidth = 2; c.setLineDash([4, 4]); c.lineDashOffset = -now / 40; c.beginPath(); c.arc(0, 0, r + 6, 0, 7); c.stroke(); c.setLineDash([]); }
  // Umhang / Körper
  const g = c.createRadialGradient(-r * .3, -r * .3, r * .2, 0, 0, r);
  g.addColorStop(0, lighten(col, 0.35)); g.addColorStop(1, darken(col, 0.35));
  c.fillStyle = g; c.beginPath(); c.arc(0, 0, r, 0, 7); c.fill();
  c.strokeStyle = 'rgba(0,0,0,.6)'; c.lineWidth = 1.5; c.stroke();
  // Gesicht (Augen in Blickrichtung)
  c.fillStyle = '#fff';
  c.beginPath(); c.arc(fx * r * .45 - fy * r * .3, fy * r * .45 + fx * r * .3, 2, 0, 7); c.arc(fx * r * .45 + fy * r * .3, fy * r * .45 - fx * r * .3, 2, 0, 7); c.fill();
  // Klassen-Ausrüstung
  c.save(); c.rotate(h.facing);
  c.lineCap = 'round';
  switch (h.cls) {
    case 'krieger': // Schild links, Schwert rechts
      c.fillStyle = '#9aa3b5'; c.beginPath(); c.ellipse(-2, -r * .9, 4, 8, 0, 0, 7); c.fill(); c.strokeStyle = '#444'; c.lineWidth = 1; c.stroke();
      c.strokeStyle = '#d8dde8'; c.lineWidth = 3; c.beginPath(); c.moveTo(r * .3, r * .8); c.lineTo(r * 1.5, r * .5); c.stroke();
      c.strokeStyle = '#7a5a2a'; c.lineWidth = 3; c.beginPath(); c.moveTo(r * .1, r * .85); c.lineTo(r * .4, r * .78); c.stroke();
      break;
    case 'schuetze': // Bogen vorne
      c.strokeStyle = '#8b5a2b'; c.lineWidth = 2.5; c.beginPath(); c.arc(r * .9, 0, r * .8, -1.2, 1.2); c.stroke();
      c.strokeStyle = 'rgba(255,255,255,.7)'; c.lineWidth = 1; c.beginPath(); c.moveTo(r * .9 + Math.cos(-1.2) * r * .8, Math.sin(-1.2) * r * .8); c.lineTo(r * .9 + Math.cos(1.2) * r * .8, Math.sin(1.2) * r * .8); c.stroke();
      break;
    case 'heiler': // Stab mit leuchtender Spitze
      c.strokeStyle = '#8b6b3a'; c.lineWidth = 2.5; c.beginPath(); c.moveTo(-r * .2, r * .9); c.lineTo(r * 1.2, -r * .6); c.stroke();
      c.shadowColor = '#f4d56b'; c.shadowBlur = 10; c.fillStyle = '#fff3b0'; c.beginPath(); c.arc(r * 1.2, -r * .6, 3 + Math.sin(now / 150), 0, 7); c.fill(); c.shadowBlur = 0;
      break;
    case 'schurke': // zwei Dolche, Kapuze
      c.strokeStyle = '#d0d4e0'; c.lineWidth = 2; c.beginPath(); c.moveTo(r * .4, r * .7); c.lineTo(r * 1.1, r * .9); c.moveTo(r * .4, -r * .7); c.lineTo(r * 1.1, -r * .9); c.stroke();
      c.fillStyle = 'rgba(0,0,0,.35)'; c.beginPath(); c.arc(-r * .2, 0, r * .75, Math.PI * .6, Math.PI * 1.4); c.fill();
      break;
  }
  c.restore();
  if (carrying) { c.shadowColor = '#ffd86b'; c.shadowBlur = 14; c.fillStyle = '#ffcf3f'; c.beginPath(); c.moveTo(0, -r - 14); c.lineTo(6, -r - 7); c.lineTo(0, -r); c.lineTo(-6, -r - 7); c.closePath(); c.fill(); c.shadowBlur = 0; }
  c.restore();
}

export function drawMonsterFigure(c: CanvasRenderingContext2D, m: any, now: number, moving: boolean) {
  const md = (MONSTERS as any)[m.type]; const px = m.x * T, py = m.y * T, r = md.radius * T;
  shadow(c, px, py, r);
  c.save(); c.translate(px, py);
  if (m.type === 'krabbler') {
    // Spinnenartig: 6 Beine wackeln
    c.strokeStyle = '#5a1515'; c.lineWidth = 2; c.lineCap = 'round';
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2 + (moving ? Math.sin(now / 60 + i) * 0.25 : 0);
      c.beginPath(); c.moveTo(Math.cos(a) * r * .6, Math.sin(a) * r * .6); c.lineTo(Math.cos(a) * r * 1.7, Math.sin(a) * r * 1.7 + 2); c.stroke();
    }
    const g = c.createRadialGradient(-r * .3, -r * .3, 1, 0, 0, r); g.addColorStop(0, '#e05a4a'); g.addColorStop(1, '#6a1a1a');
    c.fillStyle = g; c.beginPath(); c.arc(0, 0, r, 0, 7); c.fill();
    c.fillStyle = '#ffe3a0'; c.beginPath(); c.arc(-3, -2, 1.6, 0, 7); c.arc(3, -2, 1.6, 0, 7); c.fill();
  } else {
    // Brecher: massig, Hörner, Pulsieren
    const pulse = 1 + Math.sin(now / 250) * 0.03;
    c.scale(pulse, pulse);
    c.fillStyle = '#3a1010'; c.beginPath(); c.moveTo(-r * .9, -r * .5); c.lineTo(-r * 1.3, -r * 1.2); c.lineTo(-r * .5, -r * .8); c.closePath(); c.fill();
    c.beginPath(); c.moveTo(r * .9, -r * .5); c.lineTo(r * 1.3, -r * 1.2); c.lineTo(r * .5, -r * .8); c.closePath(); c.fill();
    const g = c.createRadialGradient(-r * .3, -r * .4, 2, 0, 0, r * 1.1); g.addColorStop(0, '#9c2b2b'); g.addColorStop(1, '#3d0d0d');
    c.fillStyle = g; c.beginPath(); c.arc(0, 0, r, 0, 7); c.fill();
    c.strokeStyle = 'rgba(0,0,0,.6)'; c.lineWidth = 2; c.stroke();
    c.fillStyle = '#ffb347'; c.beginPath(); c.arc(-r * .35, -r * .15, 2.5, 0, 7); c.arc(r * .35, -r * .15, 2.5, 0, 7); c.fill();
    c.strokeStyle = '#1a0505'; c.lineWidth = 2; c.beginPath(); c.moveTo(-r * .4, r * .4); c.lineTo(r * .4, r * .4); c.stroke();
  }
  c.restore();
}

export function drawWallBlock(c: CanvasRenderingContext2D, w: any, now: number, age: number) {
  const x = w.tx * T, y = w.ty * T;
  const pop = Math.min(1, age / 250); const sc = 0.6 + 0.4 * pop;
  c.save(); c.translate(x + T / 2, y + T / 2); c.scale(sc, sc); c.translate(-T / 2, -T / 2);
  c.fillStyle = '#6b4a2e'; c.fillRect(1, 1, T - 2, T - 2);
  c.fillStyle = '#7d583a'; c.fillRect(1, 1, T - 2, 4);
  c.strokeStyle = 'rgba(0,0,0,.45)'; c.lineWidth = 1;
  for (let row = 0; row < 3; row++) { c.beginPath(); c.moveTo(1, 6 + row * 9 + .5); c.lineTo(T - 1, 6 + row * 9 + .5); c.stroke(); const off = row % 2 ? 9 : 0; c.beginPath(); c.moveTo(off + 9.5, 6 + row * 9); c.lineTo(off + 9.5, 15 + row * 9); c.stroke(); c.beginPath(); c.moveTo(off + 20.5, 6 + row * 9); c.lineTo(off + 20.5, 15 + row * 9); c.stroke(); }
  c.strokeStyle = '#1b1b1b'; c.lineWidth = 1.5;
  if (w.hp < 45) { c.beginPath(); c.moveTo(6, 8); c.lineTo(14, 16); c.lineTo(11, 26); c.stroke(); }
  if (w.hp < 25) { c.beginPath(); c.moveTo(26, 5); c.lineTo(18, 14); c.lineTo(24, 24); c.stroke(); c.beginPath(); c.moveTo(14, 16); c.lineTo(22, 19); c.stroke(); }
  c.restore();
}

export function drawTrapIcon(c: CanvasRenderingContext2D, tr: any, now: number, hidden: boolean) {
  const x = tr.tx * T, y = tr.ty * T;
  c.save(); c.globalAlpha = hidden ? 0.7 : 1;
  if (tr.type === 'stachel') {
    c.fillStyle = '#2a2a35'; c.fillRect(x + 3, y + 22, T - 6, 6);
    for (let i = 0; i < 4; i++) {
      const g = c.createLinearGradient(0, y + 8, 0, y + 24); g.addColorStop(0, '#e8e8f0'); g.addColorStop(1, '#8a8a9a');
      c.fillStyle = g; c.beginPath(); c.moveTo(x + 4 + i * 7, y + 24); c.lineTo(x + 7.5 + i * 7, y + 7); c.lineTo(x + 11 + i * 7, y + 24); c.fill();
    }
  } else {
    c.fillStyle = '#07070c'; c.beginPath(); c.ellipse(x + 16, y + 18, 12, 8, 0, 0, 7); c.fill();
    c.strokeStyle = '#3a3a48'; c.lineWidth = 1.5; c.stroke();
    c.strokeStyle = 'rgba(255,255,255,.08)'; c.beginPath(); c.ellipse(x + 16, y + 17, 9, 5, 0, Math.PI, Math.PI * 2); c.stroke();
  }
  if (hidden) { c.strokeStyle = 'rgba(167,123,224,.9)'; c.setLineDash([3, 3]); c.lineDashOffset = -now / 60; c.strokeRect(x + 2, y + 2, T - 4, T - 4); c.setLineDash([]); }
  c.restore();
}

export function drawArtifact(c: CanvasRenderingContext2D, x: number, y: number, now: number) {
  const px = x * T, py = y * T + Math.sin(now / 300) * 3;
  const glow = 14 + Math.sin(now / 200) * 6;
  c.save();
  c.fillStyle = 'rgba(255,207,63,.12)'; c.beginPath(); c.arc(px, py, glow + 10, 0, 7); c.fill();
  c.shadowColor = '#ffd86b'; c.shadowBlur = glow;
  c.translate(px, py); c.rotate(now / 900);
  const g = c.createLinearGradient(-8, -8, 8, 8); g.addColorStop(0, '#fff2b0'); g.addColorStop(0.5, '#ffcf3f'); g.addColorStop(1, '#c98f12');
  c.fillStyle = g; c.beginPath(); c.moveTo(0, -11); c.lineTo(8, 0); c.lineTo(0, 11); c.lineTo(-8, 0); c.closePath(); c.fill();
  c.strokeStyle = 'rgba(255,255,255,.7)'; c.lineWidth = 1; c.beginPath(); c.moveTo(0, -11); c.lineTo(0, 11); c.moveTo(-8, 0); c.lineTo(8, 0); c.stroke();
  c.restore();
}

export function drawExit(c: CanvasRenderingContext2D, p: { x: number; y: number }, now: number) {
  const px = (p.x + .5) * T, py = (p.y + .5) * T;
  c.save();
  const g = c.createRadialGradient(px, py, 2, px, py, T * .7); g.addColorStop(0, 'rgba(95,208,224,.55)'); g.addColorStop(1, 'rgba(95,208,224,0)');
  c.fillStyle = g; c.beginPath(); c.arc(px, py, T * .7, 0, 7); c.fill();
  for (let i = 0; i < 3; i++) {
    c.strokeStyle = `rgba(120,230,240,${0.9 - i * 0.25})`; c.lineWidth = 2;
    c.beginPath(); c.arc(px, py, T * (0.18 + i * 0.1), now / (400 + i * 150) + i, now / (400 + i * 150) + i + 4.2); c.stroke();
  }
  c.fillStyle = '#cfeff5'; c.font = 'bold 10px system-ui'; c.textAlign = 'center'; c.fillText('AUSGANG', px, py - T * .55);
  c.restore();
}

export function drawEntrance(c: CanvasRenderingContext2D, p: { x: number; y: number }) {
  const x = p.x * T, y = p.y * T;
  c.save();
  for (let i = 0; i < 4; i++) { c.fillStyle = `rgba(0,0,0,${0.15 + i * 0.15})`; c.fillRect(x + 4 + i * 3, y + 4 + i * 3, T - 8 - i * 6, T - 8 - i * 6); }
  c.fillStyle = '#9a9ab0'; c.font = 'bold 10px system-ui'; c.textAlign = 'center'; c.fillText('EINGANG', x + T / 2, y - 4);
  c.restore();
}

export function drawZone(c: CanvasRenderingContext2D, z: any, now: number) {
  const px = z.x * T, py = z.y * T, r = z.r * T;
  const g = c.createRadialGradient(px, py, r * .2, px, py, r);
  g.addColorStop(0, 'rgba(110,70,190,.42)'); g.addColorStop(1, 'rgba(110,70,190,.05)');
  c.fillStyle = g; c.beginPath(); c.arc(px, py, r, 0, 7); c.fill();
  for (let i = 0; i < 5; i++) { const a = now / 2000 + i * 1.3; c.fillStyle = 'rgba(190,160,255,.18)'; c.beginPath(); c.arc(px + Math.cos(a) * r * .5, py + Math.sin(a * 1.3) * r * .5, r * .3, 0, 7); c.fill(); }
}

export function lighten(hex: string, f: number) { return mix(hex, '#ffffff', f); }
export function darken(hex: string, f: number) { return mix(hex, '#000000', f); }
function mix(a: string, b: string, f: number) {
  const pa = parse(a), pb = parse(b);
  return `rgb(${Math.round(pa[0] + (pb[0] - pa[0]) * f)},${Math.round(pa[1] + (pb[1] - pa[1]) * f)},${Math.round(pa[2] + (pb[2] - pa[2]) * f)})`;
}
function parse(hex: string) { const h = hex.replace('#', ''); return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]; }
