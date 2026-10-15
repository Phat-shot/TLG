import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMatch, applyInput, placeCard, step, snapshotFor, removePlayer, initialPayload } from '../src/match/engine.js';
import { TICK_MS, KERKER_CARDS, KERKER_MANA_START, HERO_CLASSES, RESPAWN_MS, idx, isWall, bfsDistances, hasPath, findPath } from '@tlg/shared';

const players = (n = 4, kerkers = 1) => {
  const out = [];
  for (let i = 0; i < kerkers; i++) out.push({ id: `k${i}`, name: `Kerker${i}`, role: 'kerker' });
  const cls = ['krieger', 'schuetze', 'heiler', 'schurke'];
  for (let i = 0; i < n; i++) out.push({ id: `h${i}`, name: `Held${i}`, role: 'hero', cls: cls[i % 4] });
  return out;
};
const run = (st, ms) => { for (let t = 0; t < ms; t += TICK_MS) step(st, TICK_MS); };
/** Eine freie Bodenkachel weit weg von allen Helden (für Platzierungen). */
function farFloor(st, minDist = 8) {
  const m = st.map;
  const d = bfsDistances(m, m.entrance.x, m.entrance.y);
  let best = null;
  for (let y = 1; y < m.h - 1; y++) for (let x = 1; x < m.w - 1; x++) {
    if (isWall(m, x, y)) continue;
    if ((x === m.exit.x && y === m.exit.y) || (x === m.artifact.x && y === m.artifact.y)) continue;
    const dd = d[idx(m.w, x, y)];
    if (dd >= minDist && (!best || dd < best.d)) best = { x, y, d: dd };
  }
  return best;
}
/** Einen Helden direkt teleportieren (Testhilfe; die Engine erlaubt das nicht über Inputs). */
const tp = (st, id, x, y) => { const h = st.heroes.get(id); h.x = x + 0.5; h.y = y + 0.5; };

test('Match-Aufbau: Helden am Eingang, Kerker mit Startmana, Leben = Helden×2', () => {
  const st = createMatch({ seed: 1, players: players(4) });
  assert.equal(st.heroes.size, 4); assert.equal(st.kerkers.size, 1);
  assert.equal(st.lives, 8);
  assert.equal(st.kerkers.get('k0').mana, KERKER_MANA_START);
  for (const h of st.heroes.values()) { assert.equal(Math.floor(h.x), st.map.entrance.x); assert.ok(h.alive); }
  assert.equal(st.endsAt, 12 * 60000);
});

test('Platzierung: Boden, Mindestabstand, Mana, reservierte Kacheln', () => {
  const st = createMatch({ seed: 2, players: players(2) });
  const m = st.map;
  assert.equal(placeCard(st, 'h0', { card: 'stachel', tx: 1, ty: 1 }).error, 'not_kerker');
  assert.equal(placeCard(st, 'k0', { card: 'foo', tx: 1, ty: 1 }).error, 'unknown_card');
  assert.equal(placeCard(st, 'k0', { card: 'stachel', tx: 0, ty: 0 }).error, 'not_floor');
  assert.equal(placeCard(st, 'k0', { card: 'stachel', tx: m.entrance.x, ty: m.entrance.y }).error, 'reserved_tile');
  assert.equal(placeCard(st, 'k0', { card: 'stachel', tx: m.exit.x, ty: m.exit.y }).error, 'reserved_tile');
  assert.equal(placeCard(st, 'k0', { card: 'stachel', tx: m.artifact.x, ty: m.artifact.y }).error, 'reserved_tile');
  // direkt neben dem Eingang: zu nah an Helden
  const near = [[1,0],[-1,0],[0,1],[0,-1]].map(([dx,dy]) => ({ x: m.entrance.x+dx, y: m.entrance.y+dy })).find(p => !isWall(m, p.x, p.y));
  assert.equal(placeCard(st, 'k0', { card: 'stachel', tx: near.x, ty: near.y }).error, 'too_close');
  const f = farFloor(st);
  assert.equal(placeCard(st, 'k0', { card: 'stachel', tx: f.x, ty: f.y }).ok, true);
  assert.equal(placeCard(st, 'k0', { card: 'stachel', tx: f.x, ty: f.y }).error, 'occupied');
  assert.equal(st.kerkers.get('k0').mana, KERKER_MANA_START - KERKER_CARDS.stachel.cost);
  st.kerkers.get('k0').mana = 5;
  const f2 = farFloor(st, 9);
  assert.equal(placeCard(st, 'k0', { card: 'mauer', tx: f2.x, ty: f2.y }).error, 'no_mana');
});

test('Mauern dürfen den Kerker nie versiegeln', () => {
  const st = createMatch({ seed: 5, players: players(1) });
  st.kerkers.get('k0').mana = 10000;
  const m = st.map;
  // Versuche, den kürzesten Pfad Eingang→Artefakt Kachel für Kachel zuzumauern: irgendwann muss would_seal kommen,
  // und danach muss der Pfad weiterhin existieren.
  let sealed = 0, placed = 0;
  for (let round = 0; round < 40; round++) {
    const blocked = (x, y) => isWall(m, x, y) || st.wallIdx?.has(idx(m.w, x, y));
    const p = findPath(m, m.entrance, m.artifact, blocked);
    assert.ok(p, 'Pfad existiert nicht mehr — Kerker versiegelt');
    const cands = p.filter(t => Math.hypot(t.x + 0.5 - st.heroes.get('h0').x, t.y + 0.5 - st.heroes.get('h0').y) >= 4 && !(t.x === m.artifact.x && t.y === m.artifact.y));
    let ok = false;
    for (const cand of cands) {
      const r = placeCard(st, 'k0', { card: 'mauer', tx: cand.x, ty: cand.y });
      if (r.ok) { placed++; ok = true; break; }
      if (r.error === 'would_seal') sealed++; else if (!['limit', 'reserved_tile', 'occupied', 'too_close'].includes(r.error)) assert.fail('unerwartet: ' + r.error);
    }
    if (!ok) break;
  }
  assert.ok(sealed >= 1, 'would_seal wurde nie ausgelöst');
  const blocked = (x, y) => isWall(m, x, y) || st.wallIdx.has(idx(m.w, x, y));
  assert.ok(hasPath(m, m.entrance, m.artifact, blocked));
  assert.ok(hasPath(m, m.entrance, m.exit, blocked));
  assert.ok(placed >= 1);
});

test('Stachelfalle: versteckt für Helden, sichtbar für Kerker, löst beim Betreten aus', () => {
  const st = createMatch({ seed: 3, players: players(2) });
  const f = farFloor(st);
  assert.ok(placeCard(st, 'k0', { card: 'stachel', tx: f.x, ty: f.y }).ok);
  step(st, TICK_MS);
  const heroSnap = snapshotFor(st, 'h0'), kerkerSnap = snapshotFor(st, 'k0');
  assert.equal(heroSnap.traps.length, 0, 'Held sieht versteckte Falle');
  assert.equal(kerkerSnap.traps.length, 1);
  assert.equal(heroSnap.mana, undefined, 'Held sieht Kerker-Mana');
  assert.ok(!heroSnap.events.some(e => e.t === 'place'), 'Held bekommt place-Event');
  const hpBefore = st.heroes.get('h0').hp;
  tp(st, 'h0', f.x, f.y);
  step(st, TICK_MS);
  assert.equal(st.heroes.get('h0').hp, hpBefore - KERKER_CARDS.stachel.dmg);
  assert.equal(st.traps.size, 0, 'Falle wurde nicht verbraucht');
  assert.ok(st.events.some(e => e.t === 'trap'));
});

test('Fallgrube betäubt: Bewegung bleibt für die Dauer aus', () => {
  const st = createMatch({ seed: 3, players: players(1) });
  const f = farFloor(st);
  assert.ok(placeCard(st, 'k0', { card: 'grube', tx: f.x, ty: f.y }).ok);
  tp(st, 'h0', f.x, f.y);
  step(st, TICK_MS);
  const h = st.heroes.get('h0');
  assert.ok(h.stunnedUntil > st.now);
  const x0 = h.x;
  applyInput(st, 'h0', { mx: 1, my: 0 });
  run(st, 500);
  assert.equal(h.x, x0, 'bewegt sich trotz Betäubung');
  run(st, KERKER_CARDS.grube.stunMs);
  assert.notEqual(h.x, x0);
});

test('Schurke enthüllt Fallen im Umkreis, danach sieht das ganze Team sie', () => {
  const st = createMatch({ seed: 4, players: players(4) });
  const f = farFloor(st);
  assert.ok(placeCard(st, 'k0', { card: 'stachel', tx: f.x, ty: f.y }).ok);
  tp(st, 'h3', f.x + 1, f.y); // Schurke (Index 3) daneben — Kachel ist evtl. Mauer, Distanz zählt trotzdem
  applyInput(st, 'h3', { mx: 0, my: 0, ability: true });
  step(st, TICK_MS);
  assert.ok(st.events.some(e => e.t === 'reveal'));
  assert.equal(snapshotFor(st, 'h0').traps.length, 1);
});

test('Monster: sichtbar nur in Sicht, greift an, stirbt an Schaden, Kill zählt', () => {
  const st = createMatch({ seed: 6, players: players(1) });
  const f = farFloor(st, 10);
  assert.ok(placeCard(st, 'k0', { card: 'krabbler', tx: f.x, ty: f.y }).ok);
  step(st, TICK_MS);
  assert.equal(snapshotFor(st, 'h0').monsters.length, 0, 'Monster außer Sicht sichtbar');
  assert.equal(snapshotFor(st, 'k0').monsters.length, 1);
  tp(st, 'h0', f.x, f.y);
  const h = st.heroes.get('h0');
  run(st, 1000);
  assert.ok(h.hp < h.maxHp, 'Monster hat nicht angegriffen');
  assert.equal(snapshotFor(st, 'h0').monsters.length, 1);
  // Krieger haut zurück: zielt auf das Monster
  const mo = [...st.monsters.values()][0];
  applyInput(st, 'h0', { mx: 0, my: 0, aimX: mo.x, aimY: mo.y, attack: true });
  run(st, 3000);
  assert.equal(st.monsters.size, 0, 'Monster lebt noch');
  assert.equal(h.kills, 1);
});

test('Projektil des Schützen trifft Monster', () => {
  const st = createMatch({ seed: 6, players: [{ id: 'k0', role: 'kerker', name: 'K' }, { id: 'h0', role: 'hero', name: 'S', cls: 'schuetze' }] });
  const f = farFloor(st, 10);
  st.kerkers.get('k0').mana = 100;
  assert.ok(placeCard(st, 'k0', { card: 'brecher', tx: f.x, ty: f.y }).ok);
  const m = st.map;
  // Held zwei Kacheln daneben auf freier Linie suchen
  const spots = [[2,0],[-2,0],[0,2],[0,-2],[1,0],[-1,0],[0,1],[0,-1]].map(([dx,dy]) => ({ x: f.x+dx, y: f.y+dy })).filter(p => !isWall(m, p.x, p.y));
  const s = spots[0]; tp(st, 'h0', s.x, s.y);
  const mo = [...st.monsters.values()][0];
  applyInput(st, 'h0', { mx: 0, my: 0, aimX: mo.x, aimY: mo.y, attack: true });
  run(st, 700);
  assert.ok(mo.hp < mo.maxHp, 'Projektil hat nicht getroffen');
});

test('Heldentod: Leben sinkt, Respawn am Eingang, Kerker bekommt Mana', () => {
  const st = createMatch({ seed: 7, players: players(2) });
  const h = st.heroes.get('h0');
  const k = st.kerkers.get('k0');
  h.hp = 1;
  const f = farFloor(st);
  tp(st, 'h0', f.x, f.y);
  assert.equal(placeCard(st, 'k0', { card: 'stachel', tx: f.x, ty: f.y }).error, 'too_close');
  tp(st, 'h0', st.map.entrance.x, st.map.entrance.y);
  assert.ok(placeCard(st, 'k0', { card: 'stachel', tx: f.x, ty: f.y }).ok);
  k.mana = 0;
  tp(st, 'h0', f.x, f.y);
  step(st, TICK_MS);
  assert.ok(!h.alive); assert.equal(st.lives, 3); assert.ok(k.mana >= 25, 'Kill-Mana fehlt');
  run(st, RESPAWN_MS + TICK_MS);
  assert.ok(h.alive); assert.equal(h.hp, h.maxHp); assert.equal(Math.floor(h.x), st.map.entrance.x);
});

test('Sieg Helden: Artefakt aufnehmen (verlangsamt) und zum Ausgang bringen', () => {
  const st = createMatch({ seed: 8, players: players(1) });
  const h = st.heroes.get('h0');
  tp(st, 'h0', st.map.artifact.x, st.map.artifact.y);
  step(st, TICK_MS);
  assert.equal(st.artifact.carrier, 'h0');
  assert.ok(st.events.some(e => e.t === 'artifact_pick'));
  tp(st, 'h0', st.map.exit.x, st.map.exit.y);
  step(st, TICK_MS);
  assert.equal(st.phase, 'ended'); assert.equal(st.result.winner, 'heroes'); assert.equal(st.result.reason, 'artifact_delivered');
});

test('Sieg Kerker: Zeit abgelaufen / alle tot ohne Leben', () => {
  const st = createMatch({ seed: 9, players: players(1), settings: { durationMin: 8 } });
  run(st, 8 * 60000 + TICK_MS);
  assert.equal(st.phase, 'ended'); assert.equal(st.result.winner, 'kerker'); assert.equal(st.result.reason, 'timeout');

  const st2 = createMatch({ seed: 9, players: players(1) });
  st2.lives = 0;
  const h = st2.heroes.get('h0'); h.hp = 1;
  const f = farFloor(st2);
  assert.ok(placeCard(st2, 'k0', { card: 'stachel', tx: f.x, ty: f.y }).ok);
  tp(st2, 'h0', f.x, f.y);
  step(st2, TICK_MS);
  assert.equal(st2.phase, 'ended'); assert.equal(st2.result.reason, 'all_dead');
});

test('Verlässt der letzte Kerker, gewinnen die Helden; verlässt ein Held, fällt das Artefakt', () => {
  const st = createMatch({ seed: 10, players: players(2) });
  tp(st, 'h0', st.map.artifact.x, st.map.artifact.y); step(st, TICK_MS);
  removePlayer(st, 'h0');
  assert.equal(st.artifact.carrier, null);
  assert.equal(st.phase, 'running');
  removePlayer(st, 'k0');
  assert.equal(st.phase, 'ended'); assert.equal(st.result.reason, 'kerker_left');
});

test('Mana regeneriert bis zum Maximum', () => {
  const st = createMatch({ seed: 11, players: players(4) });
  const k = st.kerkers.get('k0');
  run(st, 10000);
  assert.ok(k.mana > KERKER_MANA_START);
  run(st, 120000);
  assert.equal(k.mana, 200);
});

test('Heilkreis heilt Teammitglieder im Umkreis', () => {
  const st = createMatch({ seed: 12, players: players(4) });
  const h0 = st.heroes.get('h0'); h0.hp = 10;
  applyInput(st, 'h2', { mx: 0, my: 0, ability: true });
  step(st, TICK_MS);
  assert.equal(h0.hp, 10 + HERO_CLASSES.heiler.ability.heal);
});

test('Nebel verkleinert den Sichtkreis des Teams', () => {
  const st = createMatch({ seed: 13, players: players(1) });
  const h = st.heroes.get('h0');
  assert.equal(snapshotFor(st, 'h0').vision[0].r, 6);
  const f = farFloor(st);
  st.kerkers.get('k0').mana = 100;
  assert.ok(placeCard(st, 'k0', { card: 'nebel', tx: f.x, ty: f.y }).ok);
  tp(st, 'h0', f.x, f.y);
  assert.equal(snapshotFor(st, 'h0').vision[0].r, 2.5);
  run(st, KERKER_CARDS.nebel.durationMs + TICK_MS);
  assert.equal(st.zones.size, 0);
});

test('initialPayload trägt Karte, Rolle und Klasse', () => {
  const st = createMatch({ seed: 14, players: players(2) });
  const p = initialPayload(st, 'h1');
  assert.equal(p.role, 'hero'); assert.equal(p.you.cls, 'schuetze'); assert.equal(p.map.tiles.length, st.map.w * st.map.h);
  assert.equal(initialPayload(st, 'k0').role, 'kerker');
});

test('Snapshot ist JSON-serialisierbar und klein genug (16 Spieler, volle Karte)', () => {
  const st = createMatch({ seed: 15, players: players(14, 2) });
  st.kerkers.get('k0').mana = 10000;
  let n = 0;
  for (let y = 1; y < st.map.h - 1 && n < 60; y++) for (let x = 1; x < st.map.w - 1 && n < 60; x++) {
    if (placeCard(st, 'k0', { card: n % 3 === 0 ? 'krabbler' : n % 3 === 1 ? 'stachel' : 'mauer', tx: x, ty: y }).ok) n++;
  }
  run(st, 2000);
  const s = JSON.stringify(snapshotFor(st, 'k0'));
  assert.ok(s.length < 40000, `Kerker-Snapshot ${s.length} Bytes`);
  assert.ok(JSON.stringify(snapshotFor(st, 'h0')).length < 20000);
});
