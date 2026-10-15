// Lobbys leben nur im Speicher: eine LAN braucht keine Persistenz, und ein
// Neustart des Servers heißt ohnehin "alle neu rein". Testbar ohne Sockets.
import { ROLE, HERO_CLASS_IDS, DEFAULT_SETTINGS, SETTINGS_LIMITS, MIN_PLAYERS, MAX_PLAYERS } from '@tlg/shared';
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
      matchId: null, matchNo: 0,
      tally: new Map(), // userId -> { name, wins, kerkerTurns, heroWins, kerkerWins }
    };
    this.lobbies.set(code, lobby);
    this._add(lobby, user);
    return lobby;
  }

  join(user, code) {
    const lobby = this.lobbies.get(String(code || '').toUpperCase().trim());
    if (!lobby) throw new LobbyError('lobby_not_found');
    if (lobby.members.has(user.id)) return lobby;
    if (lobby.status !== 'waiting') throw new LobbyError('lobby_in_progress');
    if (lobby.members.size >= MAX_PLAYERS) throw new LobbyError('lobby_full');
    if (this.byUser.has(user.id)) this.leave(user.id);
    this._add(lobby, user);
    return lobby;
  }

  _add(lobby, user) {
    lobby.members.set(user.id, { id: user.id, name: user.name, ready: false, cls: HERO_CLASS_IDS[lobby.members.size % HERO_CLASS_IDS.length], pin: 'auto', connected: true });
    if (!lobby.tally.has(user.id)) lobby.tally.set(user.id, { name: user.name, kerkerTurns: 0, heroWins: 0, kerkerWins: 0, matches: 0 });
    this.byUser.set(user.id, lobby.code);
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
    const s = l.lobby.settings;
    for (const key of Object.keys(SETTINGS_LIMITS)) {
      if (patch[key] === undefined) continue;
      const [lo, hi] = SETTINGS_LIMITS[key];
      const v = Math.round(+patch[key]);
      if (!Number.isFinite(v) || v < lo || v > hi) throw new LobbyError('bad_settings');
      s[key] = v;
    }
    return l.lobby;
  }
  /** Host pinnt ein Mitglied auf eine Rolle oder gibt es wieder frei ('auto'). */
  assign(userId, targetId, pin) {
    const l = this._host(userId);
    const t = l.lobby.members.get(targetId);
    if (!t) throw new LobbyError('member_not_found');
    if (!['auto', ROLE.KERKER, ROLE.HERO].includes(pin)) throw new LobbyError('bad_pin');
    t.pin = pin; return l.lobby;
  }

  /** Rollen für das nächste Match: gepinnte Kerker zuerst, dann die mit den wenigsten Kerker-Runden. */
  pickRoles(lobby) {
    const members = [...lobby.members.values()];
    const n = Math.min(lobby.settings.kerkerCount, members.length - 1);
    const kerkers = new Set(members.filter(m => m.pin === ROLE.KERKER).slice(0, n).map(m => m.id));
    const pool = members.filter(m => !kerkers.has(m.id) && m.pin !== ROLE.HERO);
    pool.sort((a, b) => (lobby.tally.get(a.id).kerkerTurns - lobby.tally.get(b.id).kerkerTurns) || (this.rng() - 0.5));
    for (const m of pool) { if (kerkers.size >= n) break; kerkers.add(m.id); }
    // Notfall: alle auf Held gepinnt → trotzdem jemand Kerker
    if (kerkers.size < n) for (const m of members) { if (kerkers.size >= n) break; if (!kerkers.has(m.id)) kerkers.add(m.id); }
    return members.map(m => ({ id: m.id, name: m.name, role: kerkers.has(m.id) ? ROLE.KERKER : ROLE.HERO, cls: m.cls }));
  }

  start(userId) {
    const l = this._host(userId);
    const lobby = l.lobby;
    if (lobby.status !== 'waiting') throw new LobbyError('already_started');
    if (lobby.members.size < MIN_PLAYERS) throw new LobbyError('not_enough_players');
    const notReady = [...lobby.members.values()].filter(m => !m.ready && m.id !== lobby.hostId);
    if (notReady.length) throw new LobbyError('not_all_ready');
    const players = this.pickRoles(lobby);
    for (const p of players) if (p.role === ROLE.KERKER) lobby.tally.get(p.id).kerkerTurns++;
    lobby.status = 'in_progress'; lobby.matchNo++;
    lobby.matchId = `${lobby.code}-${lobby.matchNo}`;
    lobby.players = players;
    return { lobby, players, settings: { ...lobby.settings }, seed: (randomInt(2 ** 31) ^ lobby.matchNo) >>> 0 };
  }

  finish(code, result) {
    const lobby = this.lobbies.get(code);
    if (!lobby || lobby.status !== 'in_progress') return null;
    for (const p of lobby.players || []) {
      const t = lobby.tally.get(p.id); if (!t) continue;
      t.matches++;
      if (result && p.role === ROLE.HERO && result.winner === 'heroes') t.heroWins++;
      if (result && p.role === ROLE.KERKER && result.winner === 'kerker') t.kerkerWins++;
    }
    lobby.status = 'waiting'; lobby.matchId = null; lobby.players = null;
    for (const m of lobby.members.values()) m.ready = false;
    return lobby;
  }

  list() {
    return [...this.lobbies.values()].map(l => ({ code: l.code, name: l.name, host: l.members.get(l.hostId)?.name, players: l.members.size, max: MAX_PLAYERS, status: l.status }));
  }

  publicState(lobby) {
    return {
      code: lobby.code, name: lobby.name, hostId: lobby.hostId, status: lobby.status, settings: lobby.settings,
      matchNo: lobby.matchNo,
      members: [...lobby.members.values()].map(m => ({ id: m.id, name: m.name, ready: m.ready, cls: m.cls, pin: m.pin, connected: m.connected, kerkerTurns: lobby.tally.get(m.id)?.kerkerTurns ?? 0 })),
      tally: [...lobby.tally.entries()].map(([id, t]) => ({ id, ...t })),
      players: lobby.players || null,
    };
  }

  _member(userId) { const lobby = this.get(userId); if (!lobby) throw new LobbyError('not_in_lobby'); return { lobby, m: lobby.members.get(userId) }; }
  _host(userId) { const l = this._member(userId); if (l.lobby.hostId !== userId) throw new LobbyError('not_host'); return l; }
}
function cleanName(s) { return String(s || '').replace(/[^\p{L}\p{N} _\-!?.']/gu, '').trim().slice(0, 32); }
