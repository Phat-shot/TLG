import { me as fetchMe, type User } from './api';
import { connect, disconnect, sock } from './net';
import { showLogin } from './screens/login';
import { showLobbyBrowser, showRoom, type LobbyState } from './screens/lobby';
import { startGame, type StartPayload } from './game/game';
import { h, mount } from './ui';
import { EV } from '@tlg/shared';

let user: User | null = null;
let cleanup: (() => void) | null = null;
let game: ReturnType<typeof startGame> | null = null;
let lobby: LobbyState | null = null;
let lobbyList: any[] = [];
let lastResult: any = null;

function swap(fn: () => (() => void) | void) { cleanup?.(); cleanup = fn() || null; }

async function boot() {
  mount(h('div', { class: 'center' }, h('p', { class: 'muted' }, 'Verbinde…')));
  try { user = await fetchMe(); } catch { mount(h('div', { class: 'center' }, h('div', { class: 'card' }, h('h2', {}, 'TLG-Server nicht erreichbar'), h('button', { onclick: boot }, 'Erneut versuchen')))); return; }
  if (!user) return showLogin(u => { user = u; enter(); });
  enter();
}

function enter() {
  const s = connect(() => { user = null; disconnect(); boot(); });
  s.on('me', (u: User) => { user = u; });
  s.on(EV.LOBBY_LIST_STATE, (l: any[]) => { lobbyList = l; if (!lobby && !game) swap(() => showLobbyBrowser(user!, lobbyList, onLogout)); });
  s.on(EV.LOBBY_STATE, (st: LobbyState) => {
    const wasIn = !!lobby;
    lobby = st;
    if (!st.members.some(m => m.id === user!.id)) { lobby = null; if (!game) swap(() => showLobbyBrowser(user!, lobbyList, onLogout)); return; }
    if (game) return; // im Match: Lobby-Updates still mitführen
    if (!wasIn) lastResult = null;
    swap(() => showRoom(user!, st, lastResult));
  });
  s.on(EV.GAME_START, (p: StartPayload) => {
    game?.stop();
    cleanup?.(); cleanup = null;
    game = startGame(user!, p, () => { game?.stop(); game = null; if (lobby) swap(() => showRoom(user!, lobby!, lastResult)); else swap(() => showLobbyBrowser(user!, lobbyList, onLogout)); });
  });
  s.on(EV.GAME_OVER, ({ result, lobby: st }: any) => {
    lastResult = result; lobby = st;
    if (game) game.showOver(result, st);
    else swap(() => showRoom(user!, st, lastResult));
  });
  s.on(EV.ERROR, (e: { code: string }) => { if (e.code === 'replaced') { disconnect(); mount(h('div', { class: 'center' }, h('div', { class: 'card' }, h('h2', {}, 'Anderswo neu verbunden'), h('p', { class: 'muted' }, 'Dieser Tab wurde abgemeldet.'), h('button', { onclick: () => location.reload() }, 'Hier weiterspielen')))); } });
  s.on('disconnect', () => { if (!game) mount(h('div', { class: 'center' }, h('p', { class: 'muted' }, 'Verbindung verloren — verbinde neu…'))); });
  swap(() => showLobbyBrowser(user!, lobbyList, onLogout));
}
function onLogout() { user = null; lobby = null; disconnect(); boot(); }

boot();
