import { h, mount, errText } from '../ui';
import { sock } from '../net';
import { logout, type User } from '../api';
import { EV, HERO_CLASSES, HERO_CLASS_IDS, SETTINGS_LIMITS, MAX_PLAYERS } from '@tlg/shared';

export type LobbyState = {
  code: string; name: string; hostId: string; status: string; settings: { kerkerCount: number; durationMin: number }; matchNo: number;
  members: { id: string; name: string; ready: boolean; cls: string; pin: string; connected: boolean; kerkerTurns: number }[];
  tally: { id: string; name: string; kerkerTurns: number; heroWins: number; kerkerWins: number; matches: number }[];
  players: { id: string; name: string; role: string; cls: string }[] | null;
};
type LobbyListItem = { code: string; name: string; host: string; players: number; max: number; status: string };

export function showLobbyBrowser(me: User, list: LobbyListItem[], onLogout: () => void) {
  const err = h('div', { class: 'err' });
  const s = sock();
  const nameIn = h('input', { placeholder: 'Lobby-Name (optional)', maxlength: 32 });
  const codeIn = h('input', { placeholder: 'Code, z.B. K7X2M', maxlength: 5, style: { textTransform: 'uppercase' } });
  const items = h('div', { class: 'list' });
  const renderList = (l: LobbyListItem[]) => items.replaceChildren(
    ...(l.length ? l.map(x => h('div', { class: 'item' },
      h('div', {}, h('b', {}, x.name), ' ', h('span', { class: 'muted' }, `von ${x.host} · ${x.players}/${x.max}`), x.status !== 'waiting' ? h('span', { class: 'tag', style: { marginLeft: '8px' } }, 'läuft') : null),
      h('button', { onclick: () => s.emit(EV.LOBBY_JOIN, { code: x.code }) }, 'Beitreten'),
    )) : [h('p', { class: 'muted' }, 'Noch keine Lobby offen.')]),
  );
  renderList(list);
  const onList = (l: LobbyListItem[]) => renderList(l);
  const onErr = (e: { code: string }) => { err.textContent = errText(e.code); };
  s.on(EV.LOBBY_LIST_STATE, onList); s.on(EV.ERROR, onErr);
  mount(h('div', { class: 'center' }, h('div', { class: 'card wide' },
    h('div', { class: 'row between' }, h('h1', {}, 'Kerker', h('small', {}, `angemeldet als ${me.name}`)), h('button', { onclick: async () => { await logout(); onLogout(); } }, 'Abmelden')),
    h('div', { class: 'grid2', style: { marginTop: '14px' } },
      h('div', {}, h('h2', {}, 'Offene Lobbys'), items),
      h('div', {},
        h('h2', {}, 'Neue Lobby'), nameIn, h('div', { style: { marginTop: '8px' } }, h('button', { class: 'primary', onclick: () => s.emit(EV.LOBBY_CREATE, { name: nameIn.value }) }, 'Lobby eröffnen')),
        h('h2', { style: { marginTop: '22px' } }, 'Mit Code beitreten'), codeIn, h('div', { style: { marginTop: '8px' } }, h('button', { onclick: () => s.emit(EV.LOBBY_JOIN, { code: codeIn.value }) }, 'Beitreten')),
        err,
      ),
    ),
  )));
  return () => { s.off(EV.LOBBY_LIST_STATE, onList); s.off(EV.ERROR, onErr); };
}

export function showRoom(me: User, state: LobbyState, lastResult: any | null) {
  const s = sock();
  const isHost = state.hostId === me.id;
  const meM = state.members.find(m => m.id === me.id)!;
  const err = h('div', { class: 'err' });
  const onErr = (e: { code: string }) => { err.textContent = errText(e.code); };
  s.on(EV.ERROR, onErr);
  const clsSel = h('select', { onchange: (e: Event) => s.emit(EV.LOBBY_CLASS, { cls: (e.target as HTMLSelectElement).value }) },
    ...HERO_CLASS_IDS.map(id => h('option', { value: id, selected: meM.cls === id }, (HERO_CLASSES as any)[id].name)));
  const setting = (key: 'kerkerCount' | 'durationMin', label: string, unit: string) => {
    const [lo, hi] = (SETTINGS_LIMITS as any)[key];
    const inp = h('input', { type: 'number', min: lo, max: hi, value: state.settings[key], disabled: !isHost, style: { width: '90px' }, onchange: (e: Event) => s.emit(EV.LOBBY_SETTINGS, { [key]: +(e.target as HTMLInputElement).value }) });
    return h('div', { class: 'row between', style: { marginTop: '6px' } }, h('span', { class: 'muted' }, label), h('span', { class: 'row' }, inp, h('span', { class: 'muted' }, unit)));
  };
  const members = h('div', { class: 'list' }, ...state.members.map(m => h('div', { class: 'member' },
    h('span', { class: 'dot ' + (m.connected ? 'on' : '') }),
    h('span', {}, h('b', {}, m.name), m.id === state.hostId ? h('span', { class: 'tag', style: { marginLeft: '6px' } }, 'Host') : null, h('span', { class: 'muted' }, ` · ${(HERO_CLASSES as any)[m.cls].name} · ${m.kerkerTurns}× Kerker`)),
    h('span', { style: { color: m.ready || m.id === state.hostId ? 'var(--green)' : 'var(--text2)' } }, m.ready || m.id === state.hostId ? '✓ bereit' : 'wartet'),
    isHost ? h('select', { onchange: (e: Event) => s.emit(EV.LOBBY_ASSIGN, { userId: m.id, pin: (e.target as HTMLSelectElement).value }) },
      ...['auto', 'kerker', 'hero'].map(p => h('option', { value: p, selected: m.pin === p }, p === 'auto' ? 'Rotation' : p === 'kerker' ? 'fest Kerker' : 'fest Held')))
      : (m.pin !== 'auto' ? h('span', { class: 'tag ' + m.pin }, m.pin === 'kerker' ? 'fest Kerker' : 'fest Held') : h('span', { class: 'tag' }, 'Rotation')),
  )));
  const tally = state.tally.filter(t => t.matches > 0).sort((a, b) => (b.heroWins + b.kerkerWins) - (a.heroWins + a.kerkerWins));
  const tallyEl = tally.length ? h('table', {}, h('tr', {}, h('th', {}, 'Spieler'), h('th', {}, 'Siege Held'), h('th', {}, 'Siege Kerker'), h('th', {}, 'Matches')),
    ...tally.map(t => h('tr', {}, h('td', {}, t.name), h('td', {}, String(t.heroWins)), h('td', {}, String(t.kerkerWins)), h('td', {}, String(t.matches))))) : null;
  const resultEl = lastResult ? h('div', { class: 'item', style: { marginBottom: '12px', borderLeft: `3px solid ${lastResult.winner === 'heroes' ? 'var(--blue)' : 'var(--red)'}` } },
    h('div', {}, h('b', {}, lastResult.winner === 'heroes' ? 'Die Helden haben gewonnen' : lastResult.winner === 'kerker' ? 'Der Kerker hat gewonnen' : 'Match abgebrochen'),
      h('div', { class: 'muted' }, reasonText(lastResult.reason)))) : null;

  mount(h('div', { class: 'center' }, h('div', { class: 'card wide' },
    h('div', { class: 'row between' },
      h('div', {}, h('h1', {}, state.name), h('div', { class: 'muted' }, 'Code zum Beitreten: ', h('span', { class: 'code' }, state.code))),
      h('button', { onclick: () => s.emit(EV.LOBBY_LEAVE) }, 'Lobby verlassen')),
    h('div', { class: 'grid2', style: { marginTop: '16px' } },
      h('div', {}, resultEl, h('h2', {}, `Spieler (${state.members.length}/${MAX_PLAYERS})`), members, tallyEl ? h('h2', { style: { marginTop: '18px' } }, 'Abend-Wertung') : null, tallyEl),
      h('div', {},
        h('h2', {}, 'Deine Heldenklasse'), clsSel,
        h('p', { class: 'muted' }, (HERO_CLASSES as any)[meM.cls].ability.name + ' — ' + classHint(meM.cls)),
        h('h2', { style: { marginTop: '18px' } }, 'Einstellungen'),
        setting('kerkerCount', 'Kerker-Spieler', ''), setting('durationMin', 'Matchdauer', 'min'),
        h('div', { style: { marginTop: '18px' } },
          isHost
            ? h('button', { class: 'primary', onclick: () => s.emit(EV.LOBBY_START) }, `Match ${state.matchNo + 1} starten`)
            : h('button', { class: meM.ready ? '' : 'primary', onclick: () => s.emit(EV.LOBBY_READY, { ready: !meM.ready }) }, meM.ready ? 'Doch nicht bereit' : 'Bereit!')),
        h('p', { class: 'muted' }, 'Der Kerker wird automatisch rotiert: wer am seltensten dran war, baut als Nächstes.'),
        err,
      ),
    ),
  )));
  return () => s.off(EV.ERROR, onErr);
}
function classHint(cls: string) {
  return ({ krieger: 'Dash mit Rammstoß; haut Mauern schnell weg.', schuetze: 'Fächer aus fünf Pfeilen.', heiler: 'Heilt alle im Umkreis.', schurke: 'Deckt versteckte Fallen auf und wird kurz unsichtbar.' } as any)[cls] || '';
}
export function reasonText(r: string) {
  return ({ artifact_delivered: 'Das Artefakt hat den Ausgang erreicht.', timeout: 'Die Zeit ist abgelaufen.', all_dead: 'Alle Helden sind gefallen.', kerker_left: 'Der Kerker hat das Spiel verlassen.', aborted: 'Abgebrochen.', crash: 'Serverfehler im Match.' } as any)[r] || r;
}
