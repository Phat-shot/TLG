// Ganzer Fluss über echte Sockets: Login-Proxy → Lobby → Start → Snapshots → Platzieren → Ende.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { io as ioc } from 'socket.io-client';
import { createApp } from '../src/app.js';
import { startFakeCraftworks } from './fake_craftworks.js';
import { EV } from '@tlg/shared';

let cw, app, base;
before(async () => {
  cw = await startFakeCraftworks();
  app = createApp({ craftworksUrl: cw.url, log: { error: () => {} } });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${app.server.address().port}`;
});
after(async () => { await app.close(); await cw.close(); });

const connect = (token) => new Promise((resolve, reject) => {
  const s = ioc(base, { auth: { token }, transports: ['websocket'], reconnection: false });
  s.once('connect', () => resolve(s)); s.once('connect_error', reject);
});
const waitFor = (s, ev, pred = () => true, ms = 4000) => new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error(`timeout ${ev}`)), ms);
  const h = (d) => { if (pred(d)) { clearTimeout(t); s.off(ev, h); resolve(d); } };
  s.on(ev, h);
});

test('Gast-Login über den Proxy liefert Craftworks-Tokens; /api/me prüft sie', async () => {
  const r = await fetch(`${base}/api/auth/guest`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'Lanparty', privacyAccepted: true }) });
  assert.equal(r.status, 200);
  const d = await r.json();
  assert.ok(d.access_token);
  const me = await fetch(`${base}/api/me`, { headers: { authorization: `Bearer ${d.access_token}` } });
  assert.equal(me.status, 200);
  assert.equal((await me.json()).name, 'Lanparty');
  assert.equal((await fetch(`${base}/api/me`, { headers: { authorization: 'Bearer nope' } })).status, 401);
  assert.equal((await fetch(`${base}/api/auth/admin`, { method: 'POST' })).status, 404);
});

test('Socket ohne gültiges Token wird abgewiesen', async () => {
  await assert.rejects(connect('nope'), /unauthorized/);
});

test('Kompletter Match-Fluss mit drei Spielern', async () => {
  const tA = cw.addUser('a', 'Anna'), tB = cw.addUser('b', 'Ben'), tC = cw.addUser('c', 'Cem');
  const A = await connect(tA), B = await connect(tB), C = await connect(tC);
  try {
    A.emit(EV.LOBBY_CREATE, { name: 'Testabend' });
    const st1 = await waitFor(A, EV.LOBBY_STATE);
    assert.equal(st1.members.length, 1); assert.equal(st1.hostId, 'a');
    const list = await waitFor(B, EV.LOBBY_LIST_STATE, l => l.length === 1);
    assert.equal(list[0].name, 'Testabend');

    B.emit(EV.LOBBY_JOIN, { code: st1.code.toLowerCase() });
    C.emit(EV.LOBBY_JOIN, { code: st1.code });
    await waitFor(A, EV.LOBBY_STATE, s => s.members.length === 3);

    A.emit(EV.LOBBY_START);
    const err = await waitFor(A, EV.ERROR);
    assert.equal(err.code, 'not_all_ready');

    B.emit(EV.LOBBY_READY, { ready: true }); C.emit(EV.LOBBY_READY, { ready: true });
    const stR = await waitFor(A, EV.LOBBY_STATE, s => s.members.filter(m => m.ready).length === 2);
    // 3 Spieler, Teamgröße 2 → wirksam 1 → drei Einzelteams, Team Rot (0) ist zuerst Kerker. Host schiebt C nach Rot.
    assert.equal(stR.effectiveTeamSize, 1); assert.equal(stR.teams.length, 3);
    const cTeam = stR.teams.findIndex(t => t.members.includes('c'));
    const redOccupant = stR.teams[0].members[0];
    if (cTeam !== 0) {
      A.emit(EV.LOBBY_TEAM, { userId: 'c', team: 0 });
      A.emit(EV.LOBBY_TEAM, { userId: redOccupant, team: cTeam });
      await waitFor(A, EV.LOBBY_STATE, s => s.teams[0].members.length === 1 && s.teams[0].members[0] === 'c' && s.teamsValid);
    }

    A.emit(EV.LOBBY_START);
    const [gA, gB, gC] = await Promise.all([waitFor(A, EV.GAME_START), waitFor(B, EV.GAME_START), waitFor(C, EV.GAME_START)]);
    assert.equal(gC.role, 'kerker'); assert.equal(gA.role, 'hero'); assert.equal(gB.role, 'hero');
    assert.equal(gA.round, 1); assert.equal(gA.rounds, 3); assert.equal(gA.kerkerTeam.name, 'Rot'); assert.equal(gA.teams.length, 3);
    assert.equal(gA.map.tiles.length, 48 * 32);
    assert.deepEqual(gA.map.entrance, gC.map.entrance);

    // Snapshots: Held ohne Mana und ohne versteckte Fallen, Kerker mit Mana
    const sA = await waitFor(A, EV.GAME_SNAPSHOT);
    const sC = await waitFor(C, EV.GAME_SNAPSHOT);
    assert.equal(sA.mana, undefined); assert.ok(Array.isArray(sA.vision)); assert.equal(typeof sC.mana, 'number');

    // Kerker platziert: einmal ungültig (am Eingang), einmal gültig weit weg
    C.emit(EV.GAME_PLACE, { card: 'stachel', tx: gC.map.entrance.x, ty: gC.map.entrance.y, reqId: 1 });
    const bad = await waitFor(C, 'game:place_result', r => r.reqId === 1);
    assert.equal(bad.error, 'reserved_tile');
    const far = findFar(gC.map);
    C.emit(EV.GAME_PLACE, { card: 'stachel', tx: far.x, ty: far.y, reqId: 2 });
    const good = await waitFor(C, 'game:place_result', r => r.reqId === 2);
    assert.equal(good.ok, true, JSON.stringify(good));
    const sC2 = await waitFor(C, EV.GAME_SNAPSHOT, s => s.traps.length === 1);
    assert.equal(sC2.traps[0].revealed, false);
    const sA2 = await waitFor(A, EV.GAME_SNAPSHOT);
    assert.equal(sA2.traps.length, 0, 'Held sieht versteckte Falle');

    // Held bewegt sich: Eingabe wirkt
    const x0 = sA2.heroes.find(h => h.id === 'a').x;
    A.emit(EV.GAME_INPUT, { mx: 1, my: 0 });
    await new Promise(r => setTimeout(r, 300));
    A.emit(EV.GAME_INPUT, { mx: 0, my: 0 });
    const sA3 = await waitFor(A, EV.GAME_SNAPSHOT);
    const x1 = sA3.heroes.find(h => h.id === 'a').x;
    assert.notEqual(x0, x1, 'Held hat sich nicht bewegt (oder Mauer direkt rechts)');

    // Ein Held verlässt das Spiel, der Kerker geht → Helden gewinnen, Lobby wieder "waiting"
    B.emit(EV.GAME_LEAVE);
    C.emit(EV.LOBBY_LEAVE);
    const over = await waitFor(A, EV.GAME_OVER);
    assert.equal(over.result.winner, 'heroes'); assert.equal(over.result.reason, 'kerker_left');
    assert.equal(over.lobby.status, 'waiting');
    // Kerker-Team Rot ist weg → zwei Teams übrig, beide haben als Helden +2 bekommen, Serie läuft weiter (Runde 2 von 2)
    assert.ok(over.lobby.series, 'Serie sollte weiterlaufen');
    assert.equal(over.lobby.series.rounds, 2); assert.equal(over.lobby.series.round, 1);
    assert.deepEqual(over.lobby.teams.map(t => [t.name, t.points]), [['Blau', 2], ['Grün', 2]]);
    assert.equal(over.lobby.stats.find(t => t.id === 'a').heroRounds, 1);
    await new Promise(r => setTimeout(r, 200));
    assert.equal(app.matches.matches.size, 0, 'Worker nicht aufgeräumt');
  } finally { A.close(); B.close(); C.close(); }
});

test('Zweite Verbindung desselben Nutzers verdrängt die erste; Reconnect landet in der Lobby', async () => {
  const t = cw.addUser('d', 'Dana');
  const D1 = await connect(t);
  D1.emit(EV.LOBBY_CREATE, {});
  const st = await waitFor(D1, EV.LOBBY_STATE);
  const replaced = waitFor(D1, EV.ERROR, e => e.code === 'replaced');
  const D2 = ioc(base, { auth: { token: t }, transports: ['websocket'], reconnection: false });
  const st2P = waitFor(D2, EV.LOBBY_STATE, s => s.code === st.code);
  await replaced;
  const st2 = await st2P;
  assert.equal(st2.members[0].connected, true);
  D1.close(); D2.close();
});

function findFar(map) {
  const e = map.entrance;
  for (let y = 1; y < map.h - 1; y++) for (let x = 1; x < map.w - 1; x++) {
    if (map.tiles[y * map.w + x] !== 0) continue;
    if (Math.hypot(x - e.x, y - e.y) < 8) continue;
    if ((x === map.exit.x && y === map.exit.y) || (x === map.artifact.x && y === map.artifact.y)) continue;
    return { x, y };
  }
  throw new Error('kein Platz');
}
