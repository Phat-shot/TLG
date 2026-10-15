import { h, mount, errText } from '../ui';
import { sock } from '../net';
import { logout, type User } from '../api';
import { EV, HERO_CLASSES, HERO_CLASS_IDS, SETTINGS_LIMITS, MAX_PLAYERS, SERIES_POINTS } from '@tlg/shared';

export type Team = { id: number; name: string; color: string; members: string[]; points: number; wasKerker: boolean };
export type LobbyState = {
  code: string; name: string; hostId: string; status: string; settings: { teamSize: number; durationMin: number }; matchNo: number;
  effectiveTeamSize: number; teamSizes: number[]; teams: Team[]; teamsValid: boolean;
  series: { round: number; rounds: number; nextKerkerTeam: number | null; results: any[] } | null;
  lastSeries: { reason: string; standings: (Team & { rank: number; members: string[] })[]; results: any[]; roundsPlayed: number; rounds: number; winner: string | null } | null;
  members: { id: string; name: string; ready: boolean; cls: string; connected: boolean }[];
  stats: { id: string; name: string; kills: number; deaths: number; kerkerRounds: number; heroRounds: number }[];
  players: { id: string; name: string; role: string; cls: string; team: number | null }[] | null;
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
      h('div', {}, h('b', {}, x.name), ' ', h('span', { class: 'muted' }, `von ${x.host} · ${x.players}/${x.max}`), x.status !== 'waiting' ? h('span', { class: 'tag', style: { marginLeft: '8px' } }, x.status === 'series' ? 'Serie läuft' : 'läuft') : null),
      h('button', { onclick: () => s.emit(EV.LOBBY_JOIN, { code: x.code }), disabled: x.status === 'series' }, 'Beitreten'),
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
  const member = (id: string) => state.members.find(m => m.id === id);
  const series = state.series;
  const err = h('div', { class: 'err' });
  const onErr = (e: { code: string }) => { err.textContent = errText(e.code); };
  s.on(EV.ERROR, onErr);

  // ── Teams ──
  const teamBox = (t: Team) => {
    const isNext = series ? series.nextKerkerTeam === t.id : t.id === 0;
    return h('div', { class: 'team', style: { borderColor: t.color } },
      h('div', { class: 'row between' },
        h('b', { style: { color: t.color } }, `Team ${t.name}`),
        h('span', { class: 'muted' }, series ? `${t.points} Pkt${t.wasKerker && !isNext ? ' · war Kerker' : ''}` : `${t.members.length}/${state.teamSizes[t.id] ?? '?'}`)),
      isNext ? h('div', { class: 'tag kerker', style: { marginTop: '4px' } }, series ? 'Kerker in dieser Runde' : 'Kerker in Runde 1') : null,
      h('div', { class: 'list', style: { marginTop: '6px' } }, ...t.members.map(id => { const m = member(id); if (!m) return null; return h('div', { class: 'member' },
        h('span', { class: 'dot ' + (m.connected ? 'on' : '') }),
        h('span', {}, h('b', {}, m.name), m.id === state.hostId ? h('span', { class: 'tag', style: { marginLeft: '6px' } }, 'Host') : null, h('span', { class: 'muted' }, ` · ${(HERO_CLASSES as any)[m.cls].name}`)),
        h('span', { style: { color: m.ready || m.id === state.hostId ? 'var(--green)' : 'var(--text2)' } }, m.ready || m.id === state.hostId ? '✓ bereit' : 'wartet'),
        isHost && !series ? h('select', { title: 'Team wechseln', onchange: (e: Event) => s.emit(EV.LOBBY_TEAM, { userId: m.id, team: +(e.target as HTMLSelectElement).value }) },
          ...state.teams.map(o => h('option', { value: o.id, selected: o.id === t.id }, o.name))) : h('span'),
      ); })),
    );
  };
  const teamsEl = h('div', { class: 'teams' }, ...state.teams.map(teamBox));

  // ── Serie / Ergebnis ──
  const resultEl = lastResult ? h('div', { class: 'item', style: { marginBottom: '12px', borderLeft: `3px solid ${lastResult.winner === 'heroes' ? 'var(--blue)' : 'var(--red)'}` } },
    h('div', {}, h('b', {}, lastResult.winner === 'heroes' ? 'Die Helden haben gewonnen' : lastResult.winner === 'kerker' ? 'Der Kerker hat gewonnen' : 'Match abgebrochen'),
      h('div', { class: 'muted' }, reasonText(lastResult.reason)))) : null;
  const seriesEl = series ? h('div', {},
    h('h2', {}, `Serie · Runde ${Math.min(series.round + 1, series.rounds)} von ${series.rounds}`),
    series.results.length ? h('table', {}, h('tr', {}, h('th', {}, 'Runde'), h('th', {}, 'Kerker'), h('th', {}, 'Sieger'), h('th', {}, 'Punkte')),
      ...series.results.map((r: any) => h('tr', {}, h('td', {}, String(r.round)), h('td', {}, r.kerkerTeamName || '–'), h('td', {}, r.winner === 'heroes' ? 'Helden' : r.winner === 'kerker' ? 'Kerker' : '–'),
        h('td', {}, r.gained.map(([id, p]: [number, number]) => `${state.teams.find(t => t.id === id)?.name ?? id} +${p}`).join(', '))))) : null,
  ) : null;
  const lastSeriesEl = !series && state.lastSeries ? h('div', { class: 'item', style: { display: 'block', marginBottom: '12px', borderLeft: '3px solid var(--accent)' } },
    h('b', {}, state.lastSeries.winner ? `Serie vorbei — Team ${state.lastSeries.winner} gewinnt` : `Serie beendet (${state.lastSeries.reason === 'aborted' ? 'abgebrochen' : 'zu wenige Teams'})`),
    h('table', { style: { marginTop: '6px' } }, h('tr', {}, h('th', {}, '#'), h('th', {}, 'Team'), h('th', {}, 'Punkte'), h('th', {}, 'Spieler')),
      ...state.lastSeries.standings.map(t => h('tr', {}, h('td', {}, String(t.rank)), h('td', { style: { color: t.color } }, t.name), h('td', {}, String(t.points)), h('td', {}, t.members.join(', ')))))) : null;
  const statsRows = state.stats.filter(t => t.kerkerRounds + t.heroRounds > 0).sort((a, b) => b.kills - a.kills);
  const statsEl = statsRows.length ? h('details', { style: { marginTop: '14px' } }, h('summary', { class: 'muted' }, 'Spielerstatistik'),
    h('table', {}, h('tr', {}, h('th', {}, 'Spieler'), h('th', {}, 'Kills'), h('th', {}, 'Tode'), h('th', {}, 'Runden als Kerker')),
      ...statsRows.map(t => h('tr', {}, h('td', {}, t.name), h('td', {}, String(t.kills)), h('td', {}, String(t.deaths)), h('td', {}, String(t.kerkerRounds)))))) : null;

  // ── Rechte Spalte ──
  const clsSel = h('select', { onchange: (e: Event) => s.emit(EV.LOBBY_CLASS, { cls: (e.target as HTMLSelectElement).value }) },
    ...HERO_CLASS_IDS.map(id => h('option', { value: id, selected: meM.cls === id }, (HERO_CLASSES as any)[id].name)));
  const setting = (key: 'teamSize' | 'durationMin', label: string, unit: string, disabled: boolean) => {
    const [lo, hi] = (SETTINGS_LIMITS as any)[key];
    const inp = h('input', { type: 'number', min: lo, max: hi, value: state.settings[key], disabled, style: { width: '90px' }, onchange: (e: Event) => s.emit(EV.LOBBY_SETTINGS, { [key]: +(e.target as HTMLInputElement).value }) });
    return h('div', { class: 'row between', style: { marginTop: '6px' } }, h('span', { class: 'muted' }, label), h('span', { class: 'row' }, inp, h('span', { class: 'muted' }, unit)));
  };
  const n = state.members.length;
  const teamNote = state.effectiveTeamSize < state.settings.teamSize
    ? `Bei ${n} Spielern gilt Teamgröße ${state.effectiveTeamSize} (${state.settings.teamSize}er-Teams erst ab ${state.settings.teamSize * 2} Spielern).`
    : `${state.teams.length} Teams → ${state.teams.length} Runden, jedes Team ist einmal Kerker.`;
  const startLabel = series ? `Runde ${Math.min(series.round + 1, series.rounds)} starten` : `Serie starten (${state.teams.length} Runden)`;
  const hostControls = h('div', { style: { marginTop: '18px' } },
    isHost
      ? h('div', { class: 'row' },
          h('button', { class: 'primary', onclick: () => s.emit(EV.LOBBY_START), disabled: !series && !state.teamsValid }, startLabel),
          !series ? h('button', { onclick: () => s.emit(EV.LOBBY_SHUFFLE) }, 'Teams mischen') : h('button', { onclick: () => s.emit(EV.LOBBY_ABORT_SERIES) }, 'Serie abbrechen'))
      : h('button', { class: meM.ready ? '' : 'primary', onclick: () => s.emit(EV.LOBBY_READY, { ready: !meM.ready }) }, meM.ready ? 'Doch nicht bereit' : 'Bereit!'),
    !series && !state.teamsValid ? h('p', { class: 'err' }, 'Teams passen nicht: jedes Team braucht mindestens ' + state.effectiveTeamSize + ' Spieler, Anzahl ' + state.teamSizes.length + '.') : null,
  );

  mount(h('div', { class: 'center' }, h('div', { class: 'card wide' },
    h('div', { class: 'row between' },
      h('div', {}, h('h1', {}, state.name), h('div', { class: 'muted' }, 'Code zum Beitreten: ', h('span', { class: 'code' }, state.code))),
      h('button', { onclick: () => s.emit(EV.LOBBY_LEAVE) }, 'Lobby verlassen')),
    h('div', { class: 'grid2', style: { marginTop: '16px' } },
      h('div', {}, resultEl, lastSeriesEl, seriesEl, h('h2', { style: { marginTop: series ? '14px' : 0 } }, `Teams (${n}/${MAX_PLAYERS} Spieler)`), teamsEl, statsEl),
      h('div', {},
        h('h2', {}, 'Deine Heldenklasse'), clsSel,
        h('p', { class: 'muted' }, (HERO_CLASSES as any)[meM.cls].ability.name + ' — ' + classHint(meM.cls)),
        h('h2', { style: { marginTop: '18px' } }, 'Einstellungen'),
        setting('teamSize', 'Spieler pro Team', '', !isHost || !!series), setting('durationMin', 'Rundendauer', 'min', !isHost),
        h('p', { class: 'muted' }, teamNote),
        hostControls,
        h('p', { class: 'muted' }, `Punkte: Kerker-Sieg ${SERIES_POINTS.kerkerWin} fürs Kerker-Team · Helden-Sieg ${SERIES_POINTS.heroWin} für jedes Heldenteam, +${SERIES_POINTS.deliverer} fürs Team des Artefakt-Trägers.`),
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
