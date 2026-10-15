import { HERO_RADIUS } from './constants.js';

export const dist = (ax, ay, bx, by) => Math.hypot(ax - bx, ay - by);
export const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
export const tileOf = (v) => Math.floor(v);

/** Winkel-Differenz in [-π, π] */
export function angleDiff(a, b) {
  let d = a - b;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return d;
}

/** Kreis (Weltkoordinaten in Kacheln) gegen blockierte Kacheln — bewegt achsengetrennt (Sliding). */
export function moveCircle(x, y, dx, dy, r, blocked) {
  const nx = tryAxis(x, y, dx, 0, r, blocked);
  const ny = tryAxis(nx, y, 0, dy, r, blocked);
  return { x: nx, y: ny };
}
function tryAxis(x, y, dx, dy, r, blocked) {
  const tx = x + dx, ty = y + dy;
  if (!circleBlocked(tx, ty, r, blocked)) return dx ? tx : ty;
  // Schrittweise annähern (kleine Schritte, damit man an Wände anlegt statt zu stoppen)
  const steps = 4;
  let bx = x, by = y;
  for (let i = 1; i <= steps; i++) {
    const px = x + dx * i / steps, py = y + dy * i / steps;
    if (circleBlocked(px, py, r, blocked)) break;
    bx = px; by = py;
  }
  return dx ? bx : by;
}
export function circleBlocked(x, y, r, blocked) {
  const x0 = Math.floor(x - r), x1 = Math.floor(x + r);
  const y0 = Math.floor(y - r), y1 = Math.floor(y + r);
  for (let ty = y0; ty <= y1; ty++) for (let tx = x0; tx <= x1; tx++) {
    if (!blocked(tx, ty)) continue;
    const cx = clamp(x, tx, tx + 1), cy = clamp(y, ty, ty + 1);
    if ((cx - x) ** 2 + (cy - y) ** 2 < r * r) return true;
  }
  return false;
}
export { HERO_RADIUS };
