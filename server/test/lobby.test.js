import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LobbyManager, makeCode } from '../src/lobby.js';

const u = (i) => ({ id: `u${i}`, name: `User${i}` });
const fill = (lm, l, from, to) => { for (let i = from; i <= to; i++) lm.join(u(i), l.code); };
const readyAll = (lm, l) => { for (const id of l.members.keys()) if (id !== l.hostId) lm.setReady(id, true); };

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

test('Teams: 6 Spieler mit 2er-Teams → 3 Teams, Beitritt landet im kleinsten Team, Verlassen räumt auf', () => {
  const lm = new LobbyManager({ rng: () => 0.5 });
  const l = lm.create(u(1));
  fill(lm, l, 2, 6);
  const st = lm.publicState(l);
  assert.deepEqual(st.teamSizes, [2, 2, 2]);
  assert.deepEqual(st.teams.map(t => t.members.length), [2, 2, 2]);
  assert.equal(st.teamsValid, true);
  assert.equal(st.effectiveTeamSize, 2);
  lm.join(u(7), l.code);
  assert.deepEqual(lm.publicState(l).teams.map(t => t.members.length).sort(), [2, 2, 3]);
  lm.leave('u7'); lm.leave('u6');
  const st2 = lm.publicState(l);
  assert.deepEqual(st2.teamSizes, [3, 2]);          // 5 Spieler: 2er-Teams, Rest aufs erste Team
  assert.deepEqual(st2.teams.map(t => t.members.length).sort(), [2, 3]);
  assert.equal(st2.teamsValid, true);
});

test('Teamgröße 2 erst ab 4 Spielern wirksam, sonst Einzelteams', () => {
  const lm = new LobbyManager();
  const l = lm.create(u(1));
  fill(lm, l, 2, 3);
  assert.equal(lm.publicState(l).effectiveTeamSize, 1);
  assert.equal(lm.publicState(l).teams.length, 3);
  lm.join(u(4), l.code);
  assert.equal(lm.publicState(l).effectiveTeamSize, 2);
  assert.equal(lm.publicState(l).teams.length, 2);
});

test('Host verschiebt Spieler und mischt; ungültige Teams blockieren den Start', () => {
  const lm = new LobbyManager({ rng: () => 0.3 });
  const l = lm.create(u(1));
  fill(lm, l, 2, 4);
  assert.throws(() => lm.moveToTeam('u2', 'u1', 1), /not_host/);
  assert.throws(() => lm.moveToTeam('u1', 'u9', 1), /member_not_found/);
  assert.throws(() => lm.moveToTeam('u1', 'u2', 5), /bad_team/);
  // alle in Team 0 → Team 1 leer → ungültig
  for (const id of ['u1', 'u2', 'u3', 'u4']) lm.moveToTeam('u1', id, 0);
  assert.equal(lm.publicState(l).teamsValid, false);
  readyAll(lm, l);
  assert.throws(() => lm.startSeries('u1'), /bad_teams/);
  lm.shuffleTeams('u1');
  assert.equal(lm.publicState(l).teamsValid, true);
  lm.moveToTeam('u1', 'u1', 1); lm.moveToTeam('u1', 'u2', 1); lm.moveToTeam('u1', 'u3', 0); lm.moveToTeam('u1', 'u4', 0);
  assert.equal(lm.publicState(l).teamsValid, true);
  lm.moveToTeam('u1', 'u3', 1);
  assert.equal(lm.publicState(l).teamsValid, false); // 1 vs 3 bei 2er-Teams
  lm.moveToTeam('u1', 'u3', 0);
  assert.equal(lm.publicState(l).teamsValid, true);
  assert.deepEqual(lm.publicState(l).teams.map(t => t.members.sort()), [['u3', 'u4'], ['u1', 'u2']]);
});

test('Serie: Runden = Teams, jedes Team genau einmal Kerker, Punkte und Abschluss', () => {
  const lm = new LobbyManager({ rng: () => 0.5 });
  const l = lm.create(u(1));
  fill(lm, l, 2, 6);
  assert.throws(() => lm.startSeries('u1'), /not_all_ready/);
  readyAll(lm, l);
  const r1 = lm.startSeries('u1');
  assert.equal(r1.round, 1); assert.equal(r1.rounds, 3);
  assert.equal(r1.players.filter(p => p.role === 'kerker').length, 2);
  assert.equal(r1.players.filter(p => p.role === 'hero').length, 4);
  const team0 = l.series.teams[0].members;
  assert.deepEqual(r1.players.filter(p => p.role === 'kerker').map(p => p.id).sort(), [...team0].sort());
  assert.throws(() => lm.join(u(7), l.code), /series_running/);
  assert.throws(() => lm.setSettings('u1', { teamSize: 3 }), /series_running/);
  assert.throws(() => lm.startRound('u1'), /already_started/);

  // Runde 1: Kerker gewinnt → Team 0 +3
  lm.finish(l.code, { winner: 'kerker', reason: 'timeout', heroes: [], kerkers: [] });
  assert.equal(l.series.teams[0].points, 3);
  assert.equal(lm.publicState(l).series.round, 1);
  assert.equal(l.status, 'waiting');
  assert.ok([...l.members.values()].every(m => m.id === l.hostId || !m.ready), 'Ready wurde nicht zurückgesetzt');

  // Runde 2: Team 1 ist Kerker, Helden gewinnen, Träger aus Team 2 → Team 0 +2, Team 2 +3
  readyAll(lm, l);
  const r2 = lm.startRound('u1');
  assert.equal(r2.round, 2); assert.equal(r2.kerkerTeam.id, 1);
  const team2hero = l.series.teams[2].members[0];
  lm.finish(l.code, { winner: 'heroes', reason: 'artifact_delivered', deliveredBy: team2hero, heroes: [{ id: team2hero, kills: 2, deaths: 1 }], kerkers: [] });
  assert.deepEqual(l.series.teams.map(t => t.points), [5, 0, 3]);
  assert.equal(l.stats.get(team2hero).kills, 2);

  // Runde 3: Team 2 Kerker, gewinnt → [5,0,6] → Serie vorbei, Sieger Grün
  readyAll(lm, l);
  const r3 = lm.startRound('u1');
  assert.equal(r3.kerkerTeam.id, 2);
  lm.finish(l.code, { winner: 'kerker', reason: 'all_dead', heroes: [], kerkers: [] });
  assert.equal(l.series, null);
  assert.equal(l.lastSeries.reason, 'finished');
  assert.deepEqual(l.lastSeries.standings.map(s => [s.name, s.points]), [['Grün', 6], ['Rot', 5], ['Blau', 0]]);
  assert.equal(l.lastSeries.winner, 'Grün');
  assert.equal(l.lastSeries.results.length, 3);
  // danach wieder frei: beitreten geht, neue Serie geht
  lm.join(u(7), l.code);
  assert.equal(lm.publicState(l).series, null);
  assert.throws(() => lm.startRound('u1'), /no_series/);
});

test('Verlässt ein ganzes Team die Serie, entfällt seine Kerker-Runde; unter 2 Teams endet die Serie', () => {
  const lm = new LobbyManager({ rng: () => 0.5 });
  const l = lm.create(u(1));
  fill(lm, l, 2, 3);          // 3 Einzelteams
  readyAll(lm, l);
  lm.startSeries('u1');
  lm.finish(l.code, { winner: 'kerker', reason: 'timeout', heroes: [], kerkers: [] });
  const team1 = l.series.teams[1].members[0];
  lm.leave(team1);
  assert.equal(lm.publicState(l).series.rounds, 2);
  assert.equal(l.series.teams.length, 2);
  readyAll(lm, l);
  const r = lm.startRound('u1');
  assert.equal(r.round, 2); assert.equal(r.rounds, 2);
  lm.finish(l.code, { winner: 'heroes', reason: 'artifact_delivered', heroes: [], kerkers: [] });
  assert.equal(l.series, null);
  assert.equal(l.lastSeries.roundsPlayed, 2);

  const l2 = lm.create(u(10)); lm.join(u(11), l2.code); readyAll(lm, l2); lm.startSeries('u10');
  lm.finish(l2.code, { winner: 'kerker', reason: 'timeout', heroes: [], kerkers: [] });
  lm.leave('u11');
  assert.equal(l2.series, null); assert.equal(l2.lastSeries.reason, 'too_few_teams');
});

test('Serie abbrechen nur zwischen Runden und nur vom Host', () => {
  const lm = new LobbyManager();
  const l = lm.create(u(1)); lm.join(u(2), l.code); readyAll(lm, l);
  lm.startSeries('u1');
  assert.throws(() => lm.abortSeries('u1'), /already_started/);
  lm.finish(l.code, { winner: 'kerker', reason: 'timeout', heroes: [], kerkers: [] });
  assert.throws(() => lm.abortSeries('u2'), /not_host/);
  lm.abortSeries('u1');
  assert.equal(l.series, null); assert.equal(l.lastSeries.reason, 'aborted');
});

test('Klasse wählbar, ungültige Klasse abgelehnt; publicState serialisierbar und ohne interne Felder', () => {
  const lm = new LobbyManager();
  const l = lm.create(u(1));
  lm.setClass('u1', 'schurke');
  assert.throws(() => lm.setClass('u1', 'magier'), /bad_class/);
  assert.throws(() => lm.setSettings('u1', { durationMin: 99 }), /bad_settings/);
  const s = JSON.parse(JSON.stringify(lm.publicState(l)));
  assert.equal(s.members[0].cls, 'schurke');
  assert.ok(!('payloads' in s) && !('roundInfo' in s));
  assert.equal(s.teams[0].name, 'Rot');
});

test('Beitritt zu zweiter Lobby verlässt die erste', () => {
  const lm = new LobbyManager();
  const a = lm.create(u(1)); const b = lm.create(u(2));
  lm.join(u(1), b.code);
  assert.equal(lm.lobbies.has(a.code), false);
  assert.equal(b.members.size, 2);
});
