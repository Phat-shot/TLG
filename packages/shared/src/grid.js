// Gitter-Helfer: Index, Nachbarn, BFS, A*, Sichtlinie. Arbeitet auf einer
// "blocked"-Funktion, damit statische Karte + dynamische Mauern gemeinsam gelten.
import { TILE } from './constants.js';

export const idx = (w, x, y) => y * w + x;
export const inBounds = (map, x, y) => x >= 0 && y >= 0 && x < map.w && y < map.h;
export const isWall = (map, x, y) => !inBounds(map, x, y) || map.tiles[idx(map.w, x, y)] === TILE.WALL;

const N4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];

/** BFS-Distanzfeld ab (sx,sy). blocked(x,y) → true für unpassierbar. -1 = unerreichbar. */
export function bfsDistances(map, sx, sy, blocked = (x, y) => isWall(map, x, y)) {
  const dist = new Int32Array(map.w * map.h).fill(-1);
  if (blocked(sx, sy)) return dist;
  const q = [sx, sy];
  dist[idx(map.w, sx, sy)] = 0;
  let head = 0;
  while (head < q.length) {
    const x = q[head++], y = q[head++];
    const d = dist[idx(map.w, x, y)];
    for (const [dx, dy] of N4) {
      const nx = x + dx, ny = y + dy;
      if (!inBounds(map, nx, ny) || blocked(nx, ny)) continue;
      const i = idx(map.w, nx, ny);
      if (dist[i] !== -1) continue;
      dist[i] = d + 1;
      q.push(nx, ny);
    }
  }
  return dist;
}

export function hasPath(map, from, to, blocked) {
  const d = bfsDistances(map, from.x, from.y, blocked);
  return d[idx(map.w, to.x, to.y)] >= 0;
}

/** A* (4-Nachbarn, Manhattan). Liefert Kachelliste ohne Start, oder null. */
export function findPath(map, from, to, blocked = (x, y) => isWall(map, x, y), maxNodes = 4000) {
  if (from.x === to.x && from.y === to.y) return [];
  if (blocked(to.x, to.y)) return null;
  const w = map.w, size = w * map.h;
  const g = new Float32Array(size).fill(Infinity);
  const parent = new Int32Array(size).fill(-1);
  const closed = new Uint8Array(size);
  const h = (x, y) => Math.abs(x - to.x) + Math.abs(y - to.y);
  // simpler binärer Heap
  const heap = []; // [f, i]
  const push = (f, i) => { heap.push([f, i]); let k = heap.length - 1; while (k > 0) { const p = (k - 1) >> 1; if (heap[p][0] <= heap[k][0]) break; [heap[p], heap[k]] = [heap[k], heap[p]]; k = p; } };
  const pop = () => { const top = heap[0]; const last = heap.pop(); if (heap.length) { heap[0] = last; let k = 0; for (;;) { const l = 2 * k + 1, r = l + 1; let m = k; if (l < heap.length && heap[l][0] < heap[m][0]) m = l; if (r < heap.length && heap[r][0] < heap[m][0]) m = r; if (m === k) break; [heap[m], heap[k]] = [heap[k], heap[m]]; k = m; } } return top; };
  const si = idx(w, from.x, from.y), ti = idx(w, to.x, to.y);
  g[si] = 0; push(h(from.x, from.y), si);
  let expanded = 0;
  while (heap.length) {
    const [, i] = pop();
    if (closed[i]) continue;
    closed[i] = 1;
    if (i === ti) {
      const path = [];
      for (let c = ti; c !== si; c = parent[c]) path.push({ x: c % w, y: Math.floor(c / w) });
      return path.reverse();
    }
    if (++expanded > maxNodes) return null;
    const x = i % w, y = Math.floor(i / w);
    for (const [dx, dy] of N4) {
      const nx = x + dx, ny = y + dy;
      if (!inBounds(map, nx, ny) || blocked(nx, ny)) continue;
      const ni = idx(w, nx, ny);
      if (closed[ni]) continue;
      const ng = g[i] + 1;
      if (ng < g[ni]) { g[ni] = ng; parent[ni] = i; push(ng + h(nx, ny), ni); }
    }
  }
  return null;
}

/** Sichtlinie zwischen zwei Kachelmitten (Bresenham); Start/Ziel selbst dürfen Mauern sein. */
export function lineOfSight(map, x0, y0, x1, y1, blocked = (x, y) => isWall(map, x, y)) {
  let dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
  let err = dx + dy, x = x0, y = y0;
  for (;;) {
    if (x === x1 && y === y1) return true;
    if (!(x === x0 && y === y0) && blocked(x, y)) return false;
    const e2 = 2 * err;
    if (e2 >= dy) { err += dy; x += sx; }
    if (e2 <= dx) { err += dx; y += sy; }
  }
}
