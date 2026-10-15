import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LobbyManager, makeCode } from '../src/lobby.js';

const u = (i) => ({ id: `u${i}`, name: `User${i}` });

test('Lobby-Code: 5 Zeichen ohne verwechselbare Zeichen', () => {
  for (let i = 0; i < 200; i++) assert.match(makeCode(), /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{5}$/);
});

test('create/join/leave, Host-Wechsel, leere Lobby verschwindet', () => {
  const lm = new LobbyManager();
  const l = lm.create(u(1), { name: 'Abend <script>' });
  assert.equal(l.name, 'Abend script');
  lm.join(u(2), l.code.toLowerCase());
  assert.equal(l.members.size, 2);
  assert.throws(() => lm.join(u(3), 'XXXXX'), /lobby_not_found/);
  lm.leave('u1');
  assert.equal(l.hostId, 'u2');
  lm.leave('u2');
  assert.equal(lm.lobbies.size, 0);
});

test('Start braucht ≥2 Spieler und alle Nicht-Hosts bereit', () => {
  const lm = new LobbyManager();
  const l = lm.create(u(1));
  assert.throws(() => lm.start('u1'), /not_enough_players/);
  lm.join(u(2), l.code);
  assert.throws(() => lm.start('u1'), /not_all_ready/);
  assert.throws(() => lm.start('u2'), /not_host/);
  lm.setReady('u2', true);
  const { players, seed } = lm.start('u1');
  assert.equal(players.filter(p => p.role === 'kerker').length, 1);
  assert.ok(Number.isInteger(seed));
  assert.equal(l.status, 'in_progress');
  assert.throws(() => lm.join(u(3), l.code), /lobby_in_progress/);
});

test('Kerker rotiert: wer am seltensten Kerker war, ist dran; Pins gewinnen', () => {
  const lm = new LobbyManager({ rng: () => 0.5 });
  const l = lm.create(u(1));
  for (let i = 2; i <= 4; i++) { lm.join(u(i), l.code); }
  const seen = [];
  for (let round = 0; round < 4; round++) {
    for (let i = 2; i <= 4; i++) lm.setReady(`u${i}`, true);
    const { players } = lm.start('u1');
    seen.push(players.find(p => p.role === 'kerker').id);
    lm.finish(l.code, { winner: 'heroes' });
  }
  assert.equal(new Set(seen).size, 4, `jeder genau einmal Kerker: ${seen}`);
  lm.assign('u1', 'u3', 'kerker');
  for (let i = 2; i <= 4; i++) lm.setReady(`u${i}`, true);
  assert.equal(lm.start('u1').players.find(p => p.role === 'kerker').id, 'u3');
  lm.finish(l.code, { winner: 'kerker' });
  assert.equal(l.tally.get('u3').kerkerWins, 1);
  assert.equal(l.tally.get('u1').heroWins, 3);
});

test('kerkerCount > Mitglieder-1 wird gekappt; Einstellungen validiert', () => {
  const lm = new LobbyManager();
  const l = lm.create(u(1));
  lm.join(u(2), l.code);
  lm.setSettings('u1', { kerkerCount: 3, durationMin: 20 });
  assert.throws(() => lm.setSettings('u1', { durationMin: 99 }), /bad_settings/);
  assert.throws(() => lm.setSettings('u2', { durationMin: 10 }), /not_host/);
  lm.setReady('u2', true);
  const { players } = lm.start('u1');
  assert.equal(players.filter(p => p.role === 'kerker').length, 1);
  assert.equal(players.filter(p => p.role === 'hero').length, 1);
});

test('Klasse wählbar, ungültige Klasse abgelehnt; publicState ohne interne Felder', () => {
  const lm = new LobbyManager();
  const l = lm.create(u(1));
  lm.setClass('u1', 'schurke');
  assert.throws(() => lm.setClass('u1', 'magier'), /bad_class/);
  const s = lm.publicState(l);
  assert.equal(s.members[0].cls, 'schurke');
  assert.ok(!('payloads' in s));
  assert.equal(JSON.parse(JSON.stringify(s)).code, l.code);
});

test('Beitritt zu zweiter Lobby verlässt die erste', () => {
  const lm = new LobbyManager();
  const a = lm.create(u(1)); const b = lm.create(u(2));
  lm.join(u(1), b.code);
  assert.equal(lm.lobbies.has(a.code), false);
  assert.equal(b.members.size, 2);
});
