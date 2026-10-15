// Socket-Schicht: Handshake-Auth über Craftworks, Lobby-Ereignisse, Match-Weiterleitung.
// Ein Nutzer = eine Verbindung (zweiter Tab verdrängt den ersten).
import { EV, ROLE, HERO_CLASS_IDS } from '@tlg/shared';
import { LobbyError } from './lobby.js';

const DISCONNECT_GRACE_MS = 45_000;

export function attachSocket(io, { auth, lobbies, matches, log = console }) {
  const sockets = new Map();     // userId -> socket
  const graceTimers = new Map(); // userId -> timeout

  io.use(async (socket, next) => {
    try {
      const user = await auth.verifyAccessToken(socket.handshake.auth?.token);
      if (!user) return next(new Error('unauthorized'));
      socket.data.user = user;
      next();
    } catch (e) { next(new Error(e.code || 'auth_failed')); }
  });

  const stateOf = (lobby) => lobbies.publicState(lobby);
  const broadcastLobby = (lobby) => io.to(`lobby:${lobby.code}`).emit(EV.LOBBY_STATE, stateOf(lobby));
  const broadcastList = () => io.emit(EV.LOBBY_LIST_STATE, lobbies.list());
  const roleRoom = (matchId, role) => `match:${matchId}:${role}`;
  const fail = (socket, e) => socket.emit(EV.ERROR, { code: e instanceof LobbyError ? e.code : 'server_error' });

  function joinMatchRooms(socket, lobby) {
    const p = lobby.players?.find(p => p.id === socket.data.user.id);
    if (!p || !lobby.payloads) return;
    socket.join(roleRoom(lobby.matchId, p.role));
    socket.emit(EV.GAME_START, { matchId: lobby.matchId, ...lobby.payloads[p.id] });
  }
  function leaveMatchRooms(socket, lobby) {
    if (!lobby?.matchId) return;
    socket.leave(roleRoom(lobby.matchId, ROLE.HERO)); socket.leave(roleRoom(lobby.matchId, ROLE.KERKER));
  }

  io.on('connection', (socket) => {
    const user = socket.data.user;
    const old = sockets.get(user.id);
    if (old && old !== socket) { old.emit(EV.ERROR, { code: 'replaced' }); old.disconnect(true); }
    sockets.set(user.id, socket);
    clearTimeout(graceTimers.get(user.id)); graceTimers.delete(user.id);
    socket.join(`user:${user.id}`);

    // Wiederverbinden: in bestehende Lobby/Match zurück
    const existing = lobbies.get(user.id);
    if (existing) {
      existing.members.get(user.id).connected = true;
      socket.join(`lobby:${existing.code}`);
      socket.emit(EV.LOBBY_STATE, stateOf(existing));
      if (existing.status === 'in_progress') joinMatchRooms(socket, existing);
      broadcastLobby(existing);
    }
    socket.emit('me', user);
    socket.emit(EV.LOBBY_LIST_STATE, lobbies.list());

    const guarded = (fn) => async (...args) => { try { await fn(...args); } catch (e) { if (!(e instanceof LobbyError)) log.error('[socket]', e); fail(socket, e); } };

    socket.on(EV.LOBBY_LIST, guarded(() => socket.emit(EV.LOBBY_LIST_STATE, lobbies.list())));

    socket.on(EV.LOBBY_CREATE, guarded(({ name } = {}) => {
      const prev = lobbies.get(user.id);
      if (prev) { socket.leave(`lobby:${prev.code}`); leaveMatchRooms(socket, prev); }
      const lobby = lobbies.create(user, { name });
      if (prev) { const r = lobbies.lobbies.get(prev.code); if (r) broadcastLobby(r); }
      socket.join(`lobby:${lobby.code}`);
      broadcastLobby(lobby); broadcastList();
    }));

    socket.on(EV.LOBBY_JOIN, guarded(({ code } = {}) => {
      const prev = lobbies.get(user.id);
      const lobby = lobbies.join(user, code);
      if (prev && prev.code !== lobby.code) { socket.leave(`lobby:${prev.code}`); leaveMatchRooms(socket, prev); const r = lobbies.lobbies.get(prev.code); if (r) broadcastLobby(r); }
      socket.join(`lobby:${lobby.code}`);
      lobby.members.get(user.id).connected = true;
      if (lobby.status === 'in_progress') joinMatchRooms(socket, lobby);
      broadcastLobby(lobby); broadcastList();
    }));

    socket.on(EV.LOBBY_LEAVE, guarded(() => leaveEverything(user.id, socket)));
    socket.on(EV.LOBBY_READY, guarded(({ ready } = {}) => broadcastLobby(lobbies.setReady(user.id, ready))));
    socket.on(EV.LOBBY_CLASS, guarded(({ cls } = {}) => broadcastLobby(lobbies.setClass(user.id, cls))));
    socket.on(EV.LOBBY_SETTINGS, guarded((patch = {}) => broadcastLobby(lobbies.setSettings(user.id, patch))));
    socket.on(EV.LOBBY_ASSIGN, guarded(({ userId, pin } = {}) => broadcastLobby(lobbies.assign(user.id, userId, pin))));

    socket.on(EV.LOBBY_START, guarded(() => {
      const { lobby, players, settings, seed } = lobbies.start(user.id);
      lobby.payloads = null;
      matches.create(lobby.matchId, { seed, players, settings });
      broadcastLobby(lobby); broadcastList();
    }));

    socket.on(EV.GAME_INPUT, (input) => {
      const lobby = lobbies.get(user.id);
      if (!lobby?.matchId || !input || typeof input !== 'object') return;
      matches.input(lobby.matchId, user.id, input);
    });
    socket.on(EV.GAME_PLACE, (action = {}) => {
      const lobby = lobbies.get(user.id);
      if (!lobby?.matchId) return;
      matches.place(lobby.matchId, user.id, { card: String(action.card || ''), tx: action.tx, ty: action.ty, clientReq: action.reqId });
    });
    socket.on(EV.GAME_LEAVE, guarded(() => {
      const lobby = lobbies.get(user.id);
      if (lobby?.matchId) { matches.remove(lobby.matchId, user.id); leaveMatchRooms(socket, lobby); }
    }));

    socket.on('disconnect', () => {
      if (sockets.get(user.id) !== socket) return;
      sockets.delete(user.id);
      const lobby = lobbies.get(user.id);
      if (!lobby) return;
      const m = lobby.members.get(user.id); if (m) m.connected = false;
      broadcastLobby(lobby);
      graceTimers.set(user.id, setTimeout(() => { graceTimers.delete(user.id); if (!sockets.has(user.id)) leaveEverything(user.id, null); }, DISCONNECT_GRACE_MS));
    });
  });

  function leaveEverything(userId, socket) {
    const lobby = lobbies.get(userId);
    if (!lobby) return;
    if (lobby.matchId) matches.remove(lobby.matchId, userId);
    if (socket) { socket.leave(`lobby:${lobby.code}`); leaveMatchRooms(socket, lobby); }
    const r = lobbies.leave(userId);
    if (r && !r.removed) broadcastLobby(r.lobby);
    else if (r?.removed && r.lobby.matchId) matches.stop(r.lobby.matchId);
    broadcastList();
  }

  const lobbyOfMatch = (matchId) => [...lobbies.lobbies.values()].find(l => l.matchId === matchId);

  matches.on('ready', (matchId, msg) => {
    const lobby = lobbyOfMatch(matchId); if (!lobby) return matches.destroy(matchId);
    lobby.payloads = msg.payloads;
    for (const p of lobby.players) { const s = sockets.get(p.id); if (s) joinMatchRooms(s, lobby); }
  });
  matches.on('snapshot', (matchId, msg) => {
    if (msg.hero) io.to(roleRoom(matchId, ROLE.HERO)).emit(EV.GAME_SNAPSHOT, msg.hero);
    if (msg.kerker) io.to(roleRoom(matchId, ROLE.KERKER)).emit(EV.GAME_SNAPSHOT, msg.kerker);
  });
  matches.on('place_result', (matchId, msg) => {
    io.to(`user:${msg.playerId}`).emit('game:place_result', { ...msg.result, reqId: msg.action?.clientReq });
  });
  const endMatch = (matchId, result) => {
    const lobby = lobbyOfMatch(matchId);
    if (!lobby) return;
    const code = lobby.code;
    lobbies.finish(code, result);
    lobby.payloads = null;
    io.to(`lobby:${code}`).emit(EV.GAME_OVER, { result, lobby: stateOf(lobby) });
    for (const s of io.sockets.adapter.rooms.get(roleRoom(matchId, ROLE.HERO)) || []) io.sockets.sockets.get(s)?.leave(roleRoom(matchId, ROLE.HERO));
    for (const s of io.sockets.adapter.rooms.get(roleRoom(matchId, ROLE.KERKER)) || []) io.sockets.sockets.get(s)?.leave(roleRoom(matchId, ROLE.KERKER));
    broadcastList();
  };
  matches.on('ended', (matchId, msg) => endMatch(matchId, msg.result));
  matches.on('crash', (matchId) => endMatch(matchId, { winner: null, reason: 'crash', heroes: [], kerkers: [] }));

  return { sockets };
}
