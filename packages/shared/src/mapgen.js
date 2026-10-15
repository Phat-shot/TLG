// Prozeduraler Kerker: Räume + Korridore auf einem Gitter, deterministisch per Seed.
// Eingang und Ausgang liegen auf derselben Seite, das Artefakt am entferntesten
// Punkt — die Helden müssen rein, holen, und denselben Weg zurück ("Rein, holen, raus").
import { MAP_W, MAP_H, TILE } from './constants.js';
import { makeRng } from './rng.js';
import { idx, bfsDistances, isWall } from './grid.js';

export function generateMap(seed, opts = {}) {
  const w = opts.w ?? MAP_W, h = opts.h ?? MAP_H;
  const rng = makeRng(seed);
  const tiles = new Uint8Array(w * h).fill(TILE.WALL);
  const map = { w, h, tiles, rooms: [], seed };

  const carve = (x, y) => { if (x > 0 && y > 0 && x < w - 1 && y < h - 1) tiles[idx(w, x, y)] = TILE.FLOOR; };
  const carveRoom = (r) => { for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) carve(x, y); };
  const overlaps = (a, b) => a.x < b.x + b.w + 1 && a.x + a.w + 1 > b.x && a.y < b.y + b.h + 1 && a.y + a.h + 1 > b.y;

  const targetRooms = opts.rooms ?? 11;
  for (let tries = 0; tries < 400 && map.rooms.length < targetRooms; tries++) {
    const rw = rng.int(4, 9), rh = rng.int(4, 7);
    const r = { x: rng.int(1, w - rw - 2), y: rng.int(1, h - rh - 2), w: rw, h: rh };
    if (map.rooms.some(o => overlaps(r, o))) continue;
    r.cx = r.x + Math.floor(r.w / 2); r.cy = r.y + Math.floor(r.h / 2);
    map.rooms.push(r); carveRoom(r);
  }
  // Räume nach x sortieren und jeden mit einem zufälligen bereits verbundenen verbinden.
  map.rooms.sort((a, b) => a.cx - b.cx);
  for (let i = 1; i < map.rooms.length; i++) {
    const a = map.rooms[i], b = map.rooms[rng.int(Math.max(0, i - 3), i - 1)];
    corridor(carve, rng, a.cx, a.cy, b.cx, b.cy);
  }
  // Ein paar Extra-Schleifen, damit der Kerker nicht nur ein Baum ist (Mauern sonst zu stark).
  for (let k = 0; k < 3 && map.rooms.length > 3; k++) {
    const a = rng.pick(map.rooms), b = rng.pick(map.rooms);
    if (a !== b) corridor(carve, rng, a.cx, a.cy, b.cx, b.cy);
  }

  // Eingang: Raum ganz links. Artefakt: entferntester Raum (BFS). Ausgang: Raum nahe dem Eingang.
  const entranceRoom = map.rooms[0];
  map.entrance = { x: entranceRoom.cx, y: entranceRoom.cy };
  const dEntrance = bfsDistances(map, map.entrance.x, map.entrance.y);
  const reach = (r) => dEntrance[idx(w, r.cx, r.cy)];
  // Unerreichbare Räume notfalls anbinden
  for (const r of map.rooms) if (reach(r) < 0) corridor(carve, rng, r.cx, r.cy, entranceRoom.cx, entranceRoom.cy);
  const d2 = bfsDistances(map, map.entrance.x, map.entrance.y);
  const byDist = map.rooms.slice(1).sort((a, b) => d2[idx(w, b.cx, b.cy)] - d2[idx(w, a.cx, a.cy)]);
  const artifactRoom = byDist[0];
  map.artifact = { x: artifactRoom.cx, y: artifactRoom.cy };
  const exitCandidates = byDist.slice(1).filter(r => d2[idx(w, r.cx, r.cy)] >= 6);
  const exitRoom = exitCandidates.length ? exitCandidates[exitCandidates.length - 1] : byDist[byDist.length - 1];
  map.exit = { x: exitRoom.cx, y: exitRoom.cy };
  return map;
}

function corridor(carve, rng, x0, y0, x1, y1) {
  if (rng.next() < 0.5) { hline(carve, x0, x1, y0); vline(carve, y0, y1, x1); }
  else { vline(carve, y0, y1, x0); hline(carve, x0, x1, y1); }
}
function hline(carve, x0, x1, y) { for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x++) carve(x, y); }
function vline(carve, y0, y1, x) { for (let y = Math.min(y0, y1); y <= Math.max(y0, y1); y++) carve(x, y); }

/** Kompakte Übertragungsform (Base64 der Kacheln) für den Spielstart. */
export function serializeMap(map) {
  return {
    w: map.w, h: map.h, seed: map.seed,
    tiles: Array.from(map.tiles),
    entrance: map.entrance, exit: map.exit, artifact: map.artifact,
  };
}
export function deserializeMap(obj) {
  return { ...obj, tiles: Uint8Array.from(obj.tiles) };
}
export { isWall };
