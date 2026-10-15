// Lobbys leben nur im Speicher: eine LAN braucht keine Persistenz, und ein
// Neustart des Servers heißt ohnehin "alle neu rein". Testbar ohne Sockets.
//
// Ablauf: Lobby → Host startet eine SERIE → Teams stehen fest, Runden = Teams,
// jedes Team ist genau einmal Kerker (in Team-Reihenfolge), pro Runde eine
// neue Karte. Nach der letzten Runde steht der Serien-Sieger fest, die Lobby
// ist wieder frei (Teams bleiben als Vorschlag stehen).
import { ROLE, HERO_CLASS_IDS, DEFAULT_SETTINGS, SETTINGS_LIMITS, MIN_PLAYERS, MAX_PLAYERS, TEAM_NAMES, TEAM_COLORS, SERIES_POINTS, teamSizes, effectiveTeamSize } from '@tlg/shared';
import { randomInt } from 'node:crypto';

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export function makeCode(len = 5) {
  let s = '';
  for (let i = 0; i < len; i++) s += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return s;
}

export class LobbyError extends Error { constructor(code) { super(code); this.code = code; } }

export class LobbyManager {
  constructor({ rng = Math.random } = {}) {
    this.lobbies = new Map();  // code -> lobby
    this.byUser = new Map();   // userId -> code
    this.rng = rng;
  }

  create(user, { name } = {}) {
    if (this.byUser.has(user.id)) this.leave(user.id);
    let code; do code = makeCode(); while (this.lobbies.has(code));
    const lobby = {
      code, name: cleanName(name) || `${user.name}s Kerker`, hostId: user.id,
      status: 'waiting', settings: { ...DEFAULT_SETTINGS },
      members: new Map(), createdAt: Date.now(),
      teams: [],            // Vorschlag/Stand: Array von userId-Arrays, Index = Team
      series: null,         // laufende Serie (siehe startSeries)
      lastSeries: null,     // Abschluss der letzten Serie (Tabelle)
      matchId: null, matchNo: 0, players: null,
      stats: new Map(),     // userId -> { name, kills, deaths, kerkerRounds, heroRounds }
    };
    this.lobbies.set(code, lobby);
    this._add(lobby, user);
    return lobby;
  }

  join(user, code) {
    const lobby = this.lobbies.get(String(code || '').toUpperCase().trim());
    if (!lobby) throw new LobbyError('lobby_not_found');
    if (lobby.members.has(user.id)) return lobby;
    if (lobby.series) throw new LobbyError('series_running');
    if (lobby.members.size >= MAX_PLAYERS) throw new LobbyError('lobby_full');
    if (this.byUser.has(user.id)) this.leave(user.id);
    this._add(lobby, user);
    return lobby;
  }

  _add(lobby, user) {
    lobby.members.set(user.id, { id: user.id, name: user.name, ready: false, cls: HERO_CLASS_IDS[lobby.members.size % HERO_CLASS_IDS.length], connected: true });
    if (!lobby.stats.has(user.id)) lobby.stats.set(user.id, { name: user.name, kills: 0, deaths: 0, kerkerRounds: 0, heroRounds: 0 });
    this.byUser.set(user.id, lobby.code);
    this._placeInTeams(lobby, user.id);
  }

  leave(userId) {
    const code = this.byUser.get(userId);
    if (!code) return null;
    const lobby = this.lobbies.get(code);
    this.byUser.delete(userId);
    if (!lobby) return null;
    lobby.members.delete(userId);
    if (lobby.members.size === 0) { this.lobbies.delete(code); return { lobby, removed: true }; }
    if (lobby.hostId === userId) lobby.hostId = lobby.members.keys().next().value;
    for (const t of lobby.teams) { const i = t.indexOf(userId); if (i >= 0) t.splice(i, 1); }
    if (lobby.series) {
      // Leeres Team: seine Kerker-Runde entfällt. Serie mit <2 Teams ist vorbei.
      const s = lobby.series;
      s.teams = s.teams.filter(t => t.members.some(id => lobby.members.has(id)));
      if (s.teams.length < 2) this._endSeries(lobby, 'too_few_teams');
      else if (lobby.status === 'waiting' && s.teams.every(t => t.wasKerker)) this._endSeries(lobby, 'finished');
    } else this._normalizeTeams(lobby);
    return { lobby, removed: false };
  }

  get(userId) { const code = this.byUser.get(userId); return code ? this.lobbies.get(code) : null; }

  setReady(userId, ready) { const l = this._member(userId); l.m.ready = !!ready; return l.lobby; }
  setClass(userId, cls) {
    const l = this._member(userId);
    if (!HERO_CLASS_IDS.includes(cls)) throw new LobbyError('bad_class');
    l.m.cls = cls; return l.lobby;
  }
  setSettings(userId, patch) {
    const l = this._host(userId);
    if (l.lobby.series && patch.teamSize !== undefined) throw new LobbyError('series_running');
    const s = l.lobby.settings;
    for (const key of Object.keys(SETTINGS_LIMITS)) {
      if (patch[key] === undefined) continue;
      const [lo, hi] = SETTINGS_LIMITS[key];
      const v = Math.round(+patch[key]);
      if (!Number.isFinite(v) || v < lo || v > hi) throw new LobbyError('bad_settings');
      s[key] = v;
    }
    if (patch.teamSize !== undefined) this.shuffleTeams(userId);
    return l.lobby;
  }

  // ── Teams ──────────────────────────────────────────────
  /** Neu mischen: zufällige Verteilung nach teamSizes(). Nur außerhalb einer Serie. */
  shuffleTeams(userId) {
    const l = this._host(userId);
    if (l.lobby.series) throw new LobbyError('series_running');
    const ids = [...l.lobby.members.keys()];
    for (let i = ids.length - 1; i > 0; i--) { const j = Math.floor(this.rng() * (i + 1)); [ids[i], ids[j]] = [ids[j], ids[i]]; }
    const sizes = teamSizes(ids.length, l.lobby.settings.teamSize);
    l.lobby.teams = sizes.map(n => ids.splice(0, n));
    return l.lobby;
  }
  /** Host verschiebt einen Spieler in ein Team (0-basiert). Teamgrößen dürfen dabei abweichen; der Start prüft sie. */
  moveToTeam(userId, targetId, team) {
    const l = this._host(userId);
    if (l.lobby.series) throw new LobbyError('series_running');
    if (!l.lobby.members.has(targetId)) throw new LobbyError('member_not_found');
    team = Math.floor(+team);
    const maxTeams = teamSizes(l.lobby.members.size, l.lobby.settings.teamSize).length;
    if (!Number.isFinite(team) || team < 0 || team >= maxTeams) throw new LobbyError('bad_team');
    for (const t of l.lobby.teams) { const i = t.indexOf(targetId); if (i >= 0) t.splice(i, 1); }
    while (l.lobby.teams.length <= team) l.lobby.teams.push([]);
    l.lobby.teams[team].push(targetId);
    return l.lobby;
  }
  _placeInTeams(lobby, userId) {
    if (lobby.series) return;
    if (!lobby.teams.length) lobby.teams.push([]);
    let best = 0;
    for (let i = 1; i < lobby.teams.length; i++) if (lobby.teams[i].length < lobby.teams[best].length) best = i;
    lobby.teams[best].push(userId);
    this._normalizeTeams(lobby);
  }
  /** Nach Join/Leave/Teamgröße: Teamanzahl angleichen und Größen auf das Soll bringen
   *  (bestehende Zuordnung so weit wie möglich erhalten; nur Überzählige wandern). */
  _normalizeTeams(lobby) {
    const n = lobby.members.size;
    const sizes = teamSizes(n, lobby.settings.teamSize);
    const inTeam = new Set(lobby.teams.flat());
    for (const id of lobby.members.keys()) if (!inTeam.has(id)) (lobby.teams[0] ||= []).length >= 0 && lobby.teams[0].push(id);
    while (lobby.teams.length > sizes.length) { const last = lobby.teams.pop(); const smallest = lobby.teams.reduce((a, t, j) => (t.length < lobby.teams[a].length ? j : a), 0); lobby.teams[smallest].push(...last); }
    while (lobby.teams.length < sizes.length) lobby.teams.push([]);
    // Soll-Größen den aktuell größten Teams zuordnen (größere Soll-Werte zuerst), dann Überzählige verschieben.
    const order = lobby.teams.map((t, i) => i).sort((a, b) => lobby.teams[b].length - lobby.teams[a].length);
    const target = Array(lobby.teams.length).fill(0);
    order.forEach((teamIdx, rank) => { target[teamIdx] = sizes[rank]; });
    for (let guard = 0; guard < 64; guard++) {
      const over = lobby.teams.findIndex((t, i) => t.length > target[i]);
      const under = lobby.teams.findIndex((t, i) => t.length < target[i]);
      if (over < 0 || under < 0) break;
      lobby.teams[under].push(lobby.teams[over].pop());
    }
  }
  _validTeams(lobby) {
    const n = lobby.members.size;
    const sizes = teamSizes(n, lobby.settings.teamSize);
    const teams = lobby.teams.filter(t => t.length > 0);
    if (teams.length !== sizes.length) return false;
    const k = effectiveTeamSize(n, lobby.settings.teamSize);
    return teams.every(t => t.length >= k) && teams.flat().length === n;
  }

  // ── Serie ──────────────────────────────────────────────
  /** Host startet die Serie: Teams werden eingefroren, Runde 1 beginnt sofort. */
  startSeries(userId) {
    const l = this._host(userId);
    const lobby = l.lobby;
    if (lobby.series) throw new LobbyError('series_running');
    if (lobby.members.size < MIN_PLAYERS) throw new LobbyError('not_enough_players');
    if (!this._validTeams(lobby)) throw new LobbyError('bad_teams');
    const teams = lobby.teams.filter(t => t.length > 0).map((members, i) => ({ id: i, name: TEAM_NAMES[i], color: TEAM_COLORS[i], members: [...members], points: 0, wasKerker: false }));
    lobby.series = { teams, results: [], currentKerkerTeamId: null, startedAt: Date.now() };
    try {
      const r = this.startRound(userId);
      lobby.lastSeries = null;
      return r;
    } catch (e) { lobby.series = null; throw e; }
  }

  /** Nächste Runde (Host). Nicht-Hosts müssen bereit sein. */
  startRound(userId) {
    const l = this._host(userId);
    const lobby = l.lobby;
    if (!lobby.series) throw new LobbyError('no_series');
    if (lobby.status !== 'waiting') throw new LobbyError('already_started');
    const notReady = [...lobby.members.values()].filter(m => !m.ready && m.id !== lobby.hostId);
    if (notReady.length) throw new LobbyError('not_all_ready');
    const s = lobby.series;
    const kerkerTeam = s.teams.find(t => !t.wasKerker);
    if (!kerkerTeam) throw new LobbyError('no_series');
    const players = [...lobby.members.values()].map(m => ({
      id: m.id, name: m.name, cls: m.cls,
      role: kerkerTeam.members.includes(m.id) ? ROLE.KERKER : ROLE.HERO,
      team: s.teams.find(t => t.members.includes(m.id))?.id ?? null,
    }));
    if (!players.some(p => p.role === ROLE.HERO)) throw new LobbyError('bad_teams');
    kerkerTeam.wasKerker = true; s.currentKerkerTeamId = kerkerTeam.id;
    lobby.status = 'in_progress'; lobby.matchNo++;
    lobby.matchId = `${lobby.code}-${lobby.matchNo}`;
    lobby.players = players;
    return { lobby, players, settings: { durationMin: lobby.settings.durationMin }, seed: (randomInt(2 ** 31) ^ lobby.matchNo) >>> 0, round: roundNo(s), rounds: s.teams.length, kerkerTeam: { id: kerkerTeam.id, name: kerkerTeam.name, color: kerkerTeam.color } };
  }

  /** Rundenende: Punkte verbuchen, Serie fortschreiben oder abschließen. */
  finish(code, result) {
    const lobby = this.lobbies.get(code);
    if (!lobby || lobby.status !== 'in_progress') return null;
    const s = lobby.series;
    const players = lobby.players || [];
    for (const p of players) {
      const st = lobby.stats.get(p.id); if (!st) continue;
      if (p.role === ROLE.KERKER) st.kerkerRounds++; else st.heroRounds++;
    }
    for (const h of result?.heroes || []) { const st = lobby.stats.get(h.id); if (st) { st.kills += h.kills || 0; st.deaths += h.deaths || 0; } }
    for (const k of result?.kerkers || []) { const st = lobby.stats.get(k.id); if (st) st.kills += k.kills || 0; }
    if (s) {
      const kerkerTeam = s.teams.find(t => t.id === s.currentKerkerTeamId);
      const gained = new Map();
      if (result?.winner === 'kerker' && kerkerTeam) gained.set(kerkerTeam.id, SERIES_POINTS.kerkerWin);
      if (result?.winner === 'heroes') {
        for (const t of s.teams) if (t !== kerkerTeam) gained.set(t.id, SERIES_POINTS.heroWin);
        const deliverer = players.find(p => p.id === result.deliveredBy);
        if (deliverer && deliverer.team !== null && deliverer.team !== kerkerTeam?.id) gained.set(deliverer.team, (gained.get(deliverer.team) || 0) + SERIES_POINTS.deliverer);
      }
      for (const [id, pts] of gained) { const t = s.teams.find(t => t.id === id); if (t) t.points += pts; }
      s.results.push({ round: roundNo(s), kerkerTeam: kerkerTeam?.id ?? null, kerkerTeamName: kerkerTeam?.name ?? null, winner: result?.winner ?? null, reason: result?.reason, gained: [...gained] });
      s.currentKerkerTeamId = null;
    }
    lobby.status = 'waiting'; lobby.matchId = null; lobby.players = null;
    for (const m of lobby.members.values()) m.ready = false;
    if (s && s.teams.every(t => t.wasKerker)) this._endSeries(lobby, 'finished');
    return lobby;
  }

  abortSeries(userId) {
    const l = this._host(userId);
    if (!l.lobby.series) throw new LobbyError('no_series');
    if (l.lobby.status !== 'waiting') throw new LobbyError('already_started');
    this._endSeries(l.lobby, 'aborted');
    return l.lobby;
  }
  _endSeries(lobby, reason) {
    const s = lobby.series; if (!s) return;
    const standings = [...s.teams].sort((a, b) => b.points - a.points).map((t, i) => ({ rank: i + 1, ...t, members: t.members.filter(id => lobby.members.has(id)).map(id => lobby.members.get(id).name) }));
    lobby.lastSeries = { reason, standings, results: s.results, roundsPlayed: s.results.length, rounds: s.teams.length, winner: reason === 'finished' && standings.length ? standings[0].name : null };
    lobby.series = null;
    this._normalizeTeams(lobby);
  }

  list() {
    return [...this.lobbies.values()].map(l => ({ code: l.code, name: l.name, host: l.members.get(l.hostId)?.name, players: l.members.size, max: MAX_PLAYERS, status: l.series ? 'series' : l.status }));
  }

  publicState(lobby) {
    const n = lobby.members.size;
    const s = lobby.series;
    return {
      code: lobby.code, name: lobby.name, hostId: lobby.hostId, status: lobby.status, settings: lobby.settings, matchNo: lobby.matchNo,
      effectiveTeamSize: effectiveTeamSize(n, lobby.settings.teamSize), teamSizes: teamSizes(n, lobby.settings.teamSize),
      teams: s
        ? s.teams.map(t => ({ id: t.id, name: t.name, color: t.color, members: t.members.filter(id => lobby.members.has(id)), points: t.points, wasKerker: t.wasKerker }))
        : lobby.teams.map((members, i) => ({ id: i, name: TEAM_NAMES[i], color: TEAM_COLORS[i], members: members.filter(id => lobby.members.has(id)), points: 0, wasKerker: false })),
      teamsValid: s ? true : this._validTeams(lobby),
      series: s ? { round: s.results.length, rounds: s.teams.length, nextKerkerTeam: s.teams.find(t => !t.wasKerker)?.id ?? null, results: s.results } : null,
      lastSeries: lobby.lastSeries,
      members: [...lobby.members.values()].map(m => ({ id: m.id, name: m.name, ready: m.ready, cls: m.cls, connected: m.connected })),
      stats: [...lobby.stats.entries()].filter(([id]) => lobby.members.has(id)).map(([id, st]) => ({ id, ...st })),
      players: lobby.players || null,
    };
  }

  _member(userId) { const lobby = this.get(userId); if (!lobby) throw new LobbyError('not_in_lobby'); return { lobby, m: lobby.members.get(userId) }; }
  _host(userId) { const l = this._member(userId); if (l.lobby.hostId !== userId) throw new LobbyError('not_host'); return l; }
}
const roundNo = (s) => s.teams.filter(t => t.wasKerker).length;
function cleanName(s) { return String(s || '').replace(/[^\p{L}\p{N} _\-!?.']/gu, '').trim().slice(0, 32); }
