import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateMap, serializeMap, deserializeMap, bfsDistances, idx, isWall, findPath, lineOfSight, hasPath } from '../src/index.js';

test('Karte ist deterministisch pro Seed', () => {
  const a = generateMap(42), b = generateMap(42), c = generateMap(43);
  assert.deepEqual(Array.from(a.tiles), Array.from(b.tiles));
  assert.notDeepEqual(Array.from(a.tiles), Array.from(c.tiles));
});

test('Eingang, Ausgang und Artefakt liegen auf Boden und sind verbunden (100 Seeds)', () => {
  for (let seed = 1; seed <= 100; seed++) {
    const m = generateMap(seed);
    for (const p of [m.entrance, m.exit, m.artifact]) assert.ok(!isWall(m, p.x, p.y), `seed ${seed}: ${JSON.stringify(p)} ist Mauer`);
    const d = bfsDistances(m, m.entrance.x, m.entrance.y);
    assert.ok(d[idx(m.w, m.exit.x, m.exit.y)] >= 6, `seed ${seed}: Ausgang zu nah/unerreichbar`);
    assert.ok(d[idx(m.w, m.artifact.x, m.artifact.y)] > d[idx(m.w, m.exit.x, m.exit.y)], `seed ${seed}: Artefakt näher als Ausgang`);
    assert.ok(m.rooms.length >= 6, `seed ${seed}: nur ${m.rooms.length} Räume`);
    // Rand bleibt Mauer
    for (let x = 0; x < m.w; x++) { assert.ok(isWall(m, x, 0)); assert.ok(isWall(m, x, m.h - 1)); }
    for (let y = 0; y < m.h; y++) { assert.ok(isWall(m, 0, y)); assert.ok(isWall(m, m.w - 1, y)); }
  }
});

test('Jeder Raum ist vom Eingang erreichbar', () => {
  for (let seed = 1; seed <= 50; seed++) {
    const m = generateMap(seed);
    const d = bfsDistances(m, m.entrance.x, m.entrance.y);
    for (const r of m.rooms) assert.ok(d[idx(m.w, r.cx, r.cy)] >= 0, `seed ${seed}: Raum unerreichbar`);
  }
});

test('serialize/deserialize erhält die Karte', () => {
  const m = generateMap(7);
  const back = deserializeMap(JSON.parse(JSON.stringify(serializeMap(m))));
  assert.deepEqual(Array.from(back.tiles), Array.from(m.tiles));
  assert.deepEqual(back.exit, m.exit);
});

test('A* findet einen Pfad, der nur über Boden läuft und am Ziel endet', () => {
  const m = generateMap(3);
  const p = findPath(m, m.entrance, m.artifact);
  assert.ok(p && p.length > 0);
  for (const t of p) assert.ok(!isWall(m, t.x, t.y));
  assert.deepEqual(p[p.length - 1], m.artifact);
  const d = bfsDistances(m, m.entrance.x, m.entrance.y);
  assert.equal(p.length, d[idx(m.w, m.artifact.x, m.artifact.y)], 'A* ist nicht kürzester Pfad');
});

test('A* respektiert dynamische Blockaden', () => {
  const m = { w: 5, h: 3, tiles: Uint8Array.from([
    1,1,1,1,1,
    1,0,0,0,1,
    1,1,1,1,1]) };
  assert.ok(hasPath(m, { x: 1, y: 1 }, { x: 3, y: 1 }));
  const blocked = (x, y) => isWall(m, x, y) || (x === 2 && y === 1);
  assert.ok(!hasPath(m, { x: 1, y: 1 }, { x: 3, y: 1 }, blocked));
  assert.equal(findPath(m, { x: 1, y: 1 }, { x: 3, y: 1 }, blocked), null);
});

test('Sichtlinie wird von Mauern unterbrochen', () => {
  const m = { w: 5, h: 3, tiles: Uint8Array.from([
    1,1,1,1,1,
    1,0,1,0,1,
    1,1,1,1,1]) };
  assert.ok(!lineOfSight(m, 1, 1, 3, 1));
  m.tiles[idx(5, 2, 1)] = 0;
  assert.ok(lineOfSight(m, 1, 1, 3, 1));
});

test('Teamgrößen: immer ≥2 Teams, Rest auf die ersten Teams, Kerker-Team nie kleiner als die Teamgröße', async () => {
  const { teamSizes, effectiveTeamSize } = await import('../src/constants.js');
  assert.deepEqual(teamSizes(6, 2), [2, 2, 2]);
  assert.deepEqual(teamSizes(7, 2), [3, 2, 2]);
  assert.deepEqual(teamSizes(4, 2), [2, 2]);
  assert.deepEqual(teamSizes(5, 3), [3, 2]);          // 3er erst ab 6 → wirksam 2
  assert.equal(effectiveTeamSize(5, 3), 2);
  assert.deepEqual(teamSizes(3, 2), [1, 1, 1]);       // 2er erst ab 4 → wirksam 1
  assert.deepEqual(teamSizes(16, 1).length, 16);
  assert.deepEqual(teamSizes(16, 4), [4, 4, 4, 4]);
  assert.deepEqual(teamSizes(2, 2), [1, 1]);
  for (let n = 2; n <= 16; n++) for (let k = 1; k <= 8; k++) {
    const sz = teamSizes(n, k);
    assert.equal(sz.reduce((a, b) => a + b, 0), n);
    assert.ok(sz.length >= 2);
    assert.ok(Math.min(...sz) >= effectiveTeamSize(n, k));
  }
});
