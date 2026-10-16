// Spielbildschirm: Canvas-Renderer, Eingabe, HUD. Zwei Sichten:
//  - Held: Kamera folgt dem eigenen Helden, Nebel des Krieges (Teamsicht vom Server).
//  - Kerker: ganze Karte, Kartenleiste unten, Klick setzt eine Karte.
import { h, fmtTime, errText } from '../ui';
import { sock } from '../net';
import type { User } from '../api';
import { EV, TICK_MS, HERO_CLASSES, KERKER_CARDS, KERKER_CARD_IDS, MONSTERS, MIN_PLACE_DIST, MIN_SPAWN_DIST, deserializeMap, isWall } from '@tlg/shared';
import { reasonText } from '../screens/lobby';
import { play, unlockAudio, setMuted, isMuted } from './sfx';
import { CLASS_COLOR, type GameRenderer, type Snap, type Ghost } from './renderer';
import { Renderer2D } from './render2d';
import { Renderer3D as Renderer3DLazy } from './render3d';

export type StartPayload = {
  matchId: string; role: 'hero' | 'kerker'; endsAt: number; you: { cls?: string };
  round: number; rounds: number; kerkerTeam: { id: number; name: string; color: string };
  teams: { id: number; name: string; color: string; members: string[] }[];
  map: { w: number; h: number; tiles: number[]; entrance: P; exit: P; artifact: P; seed?: number };
  heroes: { id: string; name: string; cls: string }[]; kerkers: { id: string; name: string }[];
};
type P = { x: number; y: number };

const KEYS: Record<string, [number, number]> = { KeyW: [0, -1], KeyS: [0, 1], KeyA: [-1, 0], KeyD: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] };

export function startGame(me: User, start: StartPayload, onBackToLobby: () => void) {
  const s = sock();
  const map = deserializeMap(start.map as any) as any;
  const isKerker = start.role === 'kerker';
  const teamColor = (id: string) => start.teams?.find(t => t.members.includes(id))?.color || 'inherit';
  const names = new Map<string, string>([...start.heroes.map(x => [x.id, x.name] as [string, string]), ...start.kerkers.map(x => [x.id, x.name] as [string, string])]);
  unlockAudio();

  // ── DOM ──
  const canvas = h('canvas');
  const hudTop = h('div', { class: 'hud top' });
  const hudLeft = h('div', { class: 'hud left' });
  const feed = h('div', { class: 'hud feed' });
  const cards = h('div', { class: 'cards' });
  const help = h('div', { class: 'help' });
  const muteBtn = h('button', { class: 'mute', title: 'Ton an/aus', onclick: () => { setMuted(!isMuted()); muteBtn.textContent = isMuted() ? '🔇' : '🔊'; } }, isMuted() ? '🔇' : '🔊');
  const vignette = h('div', { class: 'vignette' });
  const flash = h('div', { class: 'flash' });
  const root = h('div', { id: 'game' }, canvas, vignette, flash, hudTop, hudLeft, feed, cards, help, muteBtn);
  document.getElementById('app')!.replaceChildren(root);
  help.innerHTML = isKerker
    ? '<kbd>1</kbd>–<kbd>6</kbd> Karte wählen · Klick setzen · <kbd>Esc</kbd> abwählen · Fallen sind für Helden unsichtbar, Mauern dürfen nie versiegeln'
    : '<kbd>WASD</kbd> laufen · Maus zielen · <kbd>LMB</kbd> angreifen · <kbd>Space</kbd>/<kbd>RMB</kbd> Fähigkeit · Artefakt holen und zum Ausgang bringen';

  // ── Renderer: 3D (Three.js) wenn WebGL da ist, sonst 2D-Canvas. ?renderer=2d erzwingt 2D.
  const want2d = new URLSearchParams(location.search).get('renderer') === '2d';
  let renderer: GameRenderer;
  const explored = new Uint8Array(map.w * map.h);
  try {
    if (want2d) throw new Error('2d');
    const probe = document.createElement('canvas'); if (!probe.getContext('webgl2')) throw new Error('no webgl2');
    renderer = new Renderer3DLazy(root, canvas, map, isKerker);
  } catch (e) { if (!want2d) console.warn('3D-Renderer nicht verfügbar, 2D-Fallback:', e); renderer = new Renderer2D(root, canvas, map, isKerker); }

  // ── Zustand ──
  let prev: Snap | null = null, cur: Snap | null = null, curAt = 0;
  const feedLines: { el: HTMLElement; until: number }[] = [];
  let over: any = null;
  let selectedCard: string | null = null;
  const mouse = { x: 0, y: 0, down: false, rdown: false, mdown: false };
  const keys = new Set<string>();
  let reqId = 0;
  let shake = 0; let lastFrame = performance.now();
  let myHpLast = -1;

  // ── Netz ──
  const onSnap = (snap: Snap) => {
    prev = cur; cur = snap; curAt = performance.now();
    if (!isKerker && snap.vision) for (const e of snap.vision) markExplored(e.x, e.y, e.r);
    for (const ev of snap.events) handleEvent(ev);
    const meHero = snap.heroes.find(x => x.id === me.id);
    if (meHero) {
      if (myHpLast >= 0 && meHero.hp < myHpLast) { shake = Math.min(12, shake + 5 + (myHpLast - meHero.hp) / 6); flash.style.opacity = '1'; setTimeout(() => (flash.style.opacity = '0'), 90); play('hurt'); }
      myHpLast = meHero.hp;
    }
  };
  const onPlace = (r: any) => { if (!r.ok) toast(errText(r.error), 'var(--red)'); else play('place'); };
  s.on(EV.GAME_SNAPSHOT, onSnap);
  s.on('game:place_result', onPlace);

  function markExplored(cx: number, cy: number, r: number) {
    const x0 = Math.max(0, Math.floor(cx - r)), x1 = Math.min(map.w - 1, Math.ceil(cx + r));
    const y0 = Math.max(0, Math.floor(cy - r)), y1 = Math.min(map.h - 1, Math.ceil(cy + r));
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if ((x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2 <= (r + 0.5) ** 2) explored[y * map.w + x] = 1;
  }
  function toast(text: string, color = 'var(--text2)') {
    const el = h('div', { class: 'feedline', style: { color } }, text);
    feed.append(el); feedLines.push({ el, until: performance.now() + 6000 });
    while (feedLines.length > 7) feedLines.shift()!.el.remove();
  }
  function handleEvent(ev: any) {
    const n = (id: string) => names.get(id) || '?';
    renderer.event(ev, (id) => cur?.heroes.find(x => x.id === id));
    switch (ev.t) {
      case 'swing': if (ev.hero === me.id || !isKerker) play('swing'); break;
      case 'hit': play('hit'); break;
      case 'trap': toast(`${n(ev.hero)} ist in eine ${(KERKER_CARDS as any)[ev.type].name} getreten`, 'var(--red)'); play('trap'); break;
      case 'hero_dead': toast(`${n(ev.hero)} ist gefallen${ev.respawn ? '' : ' — endgültig'}`, 'var(--red)'); play('death'); if (ev.hero === me.id) shake = 14; break;
      case 'respawn': toast(`${n(ev.hero)} ist zurück`, 'var(--green)'); play('respawn'); break;
      case 'artifact_pick': toast(`${n(ev.hero)} trägt das Artefakt!`, 'var(--accent)'); play('pick'); break;
      case 'artifact_drop': toast('Das Artefakt liegt wieder am Boden', 'var(--accent)'); break;
      case 'monster_dead': toast(`${(MONSTERS as any)[ev.type].name} erledigt`); break;
      case 'wall_broken': toast('Eine Mauer ist gefallen'); play('wall'); break;
      case 'reveal': toast('Falle aufgedeckt!', 'var(--purple)'); play('reveal'); break;
      case 'ability': if (ev.id === 'heilkreis') play('heal'); if (ev.id === 'salve') play('shoot'); break;
    }
  }

  // ── Eingabe ──
  const onKey = (e: KeyboardEvent, down: boolean) => {
    if (over) return;
    if (down && e.code === 'Escape') { selectedCard = null; renderCards(); }
    if (isKerker && down && /^Digit[1-6]$/.test(e.code)) { selectedCard = KERKER_CARD_IDS[+e.code[5] - 1]; renderCards(); play('select'); }
    if (e.code in KEYS || e.code === 'Space') { e.preventDefault(); down ? keys.add(e.code) : keys.delete(e.code); }
  };
  const kd = (e: KeyboardEvent) => onKey(e, true), ku = (e: KeyboardEvent) => onKey(e, false);
  window.addEventListener('keydown', kd); window.addEventListener('keyup', ku);
  canvas.addEventListener('mousemove', e => { if (mouse.mdown || (isKerker && mouse.rdown)) renderer.pan(-e.movementX, -e.movementY); mouse.x = e.clientX; mouse.y = e.clientY; });
  canvas.addEventListener('mousedown', e => { e.preventDefault(); unlockAudio(); if (e.button === 0) { mouse.down = true; if (isKerker) kerkerClick(); } if (e.button === 1) mouse.mdown = true; if (e.button === 2) { mouse.rdown = true; if (isKerker) { selectedCard = null; renderCards(); } } });
  window.addEventListener('mouseup', e => { if (e.button === 0) mouse.down = false; if (e.button === 1) mouse.mdown = false; if (e.button === 2) mouse.rdown = false; });
  canvas.addEventListener('wheel', e => { e.preventDefault(); renderer.wheel(e.deltaY); }, { passive: false });
  canvas.addEventListener('contextmenu', e => e.preventDefault());
  window.addEventListener('blur', () => keys.clear());

  let lastAttackSent = false;
  const inputTimer = !isKerker ? setInterval(() => {
    if (over || !cur) return;
    let mx = 0, my = 0;
    for (const k of keys) if (KEYS[k]) { mx += KEYS[k][0]; my += KEYS[k][1]; }
    const w = screenToWorld(mouse.x, mouse.y);
    const meHero = cur.heroes.find(x => x.id === me.id);
    if (mouse.down && !lastAttackSent && meHero?.alive && (HERO_CLASSES as any)[meHero.cls].attack.kind === 'ranged') play('shoot');
    lastAttackSent = mouse.down;
    s.volatile.emit(EV.GAME_INPUT, { mx, my, aimX: w.x, aimY: w.y, attack: mouse.down, ability: mouse.rdown || keys.has('Space') });
  }, TICK_MS) : null;

  function kerkerClick() {
    if (!selectedCard || over) return;
    const w = screenToWorld(mouse.x, mouse.y);
    s.emit(EV.GAME_PLACE, { card: selectedCard, tx: Math.floor(w.x), ty: Math.floor(w.y), reqId: ++reqId });
  }
  function placementCheck(card: string, tx: number, ty: number): string | null {
    if (!cur) return null;
    if (tx < 0 || ty < 0 || tx >= map.w || ty >= map.h || isWall(map, tx, ty)) return 'not_floor';
    if (cur.walls.some((w: any) => w.tx === tx && w.ty === ty)) return 'not_floor';
    const def = (KERKER_CARDS as any)[card];
    if ((cur.mana ?? 0) < def.cost) return 'no_mana';
    const md = def.kind === 'monster' ? MIN_SPAWN_DIST : MIN_PLACE_DIST;
    for (const hh of cur.heroes) if (hh.alive && Math.hypot(hh.x - tx - 0.5, hh.y - ty - 0.5) < md) return 'too_close';
    for (const p of [map.entrance, map.exit, map.artifact]) if (p.x === tx && p.y === ty) return 'reserved_tile';
    return null;
  }

  const resize = () => renderer.resize();
  window.addEventListener('resize', resize);
  function screenToWorld(sx: number, sy: number) { return renderer.screenToWorld(sx, sy); }

  // ── Render-Schleife ──
  const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
  function interp<T extends { id: any; x: number; y: number }>(list: T[], prevList: T[] | undefined, t: number): T[] {
    if (!prevList) return list;
    const pm = new Map(prevList.map(p => [p.id, p]));
    return list.map(e => { const p = pm.get(e.id); return p ? { ...e, x: lerp(p.x, e.x, t), y: lerp(p.y, e.y, t) } : e; });
  }
  let raf = 0;
  function frame() {
    raf = requestAnimationFrame(frame);
    const now = performance.now(); const dt = Math.min(50, now - lastFrame); lastFrame = now;
    if (!cur) return;
    const t = Math.min(1, (now - curAt) / TICK_MS);
    const heroes = interp(cur.heroes, prev?.heroes, t);
    const monsters = interp(cur.monsters, prev?.monsters, t);
    const projectiles = interp(cur.projectiles, prev?.projectiles, t);
    const meHero = heroes.find(x => x.id === me.id) || null;
    shake *= 0.86; if (shake < 0.2) shake = 0;
    let ghost: Ghost = null;
    if (isKerker && selectedCard) { const w = screenToWorld(mouse.x, mouse.y); const tx = Math.floor(w.x), ty = Math.floor(w.y); ghost = { card: selectedCard, tx, ty, bad: placementCheck(selectedCard, tx, ty) }; }
    renderer.frame({ cur, prev, t, now, dt, heroes, monsters, projectiles, meHero, meId: me.id, isKerker, explored, vision: cur.vision || [], ghost, shake, teamColor });
    renderHud(meHero);
  }

  // ── HUD ──
  let lastHud = 0;
  function cooldownRing(frac: number, label: string, color: string) {
    const c = h('canvas', { width: 36, height: 36, class: 'ring' }); const g = c.getContext('2d')!;
    g.lineWidth = 4; g.strokeStyle = 'rgba(255,255,255,.12)'; g.beginPath(); g.arc(18, 18, 14, 0, 7); g.stroke();
    g.strokeStyle = color; g.beginPath(); g.arc(18, 18, 14, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * frac); g.stroke();
    g.fillStyle = '#fff'; g.font = 'bold 11px system-ui'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(label, 18, 18);
    return c;
  }
  function renderHud(meHero: any) {
    const now = performance.now();
    for (let i = feedLines.length - 1; i >= 0; i--) if (feedLines[i].until < now) { feedLines[i].el.remove(); feedLines.splice(i, 1); }
    if (now - lastHud < 100 || !cur) return; lastHud = now;
    const timeLeft = start.endsAt - cur.now;
    const parts: Node[] = [
      h('span', { class: 'muted' }, `Runde ${start.round}/${start.rounds} · Kerker `, h('b', { style: { color: start.kerkerTeam.color } }, start.kerkerTeam.name)),
      h('span', {}, '⏱ ', h('b', { style: { color: timeLeft < 60000 ? 'var(--red)' : 'inherit' } }, fmtTime(timeLeft))), h('span', {}, '♥ ', h('b', {}, String(cur.lives)))];
    if (isKerker) parts.push(h('span', { class: 'row' }, '✦ ', h('b', {}, String(cur.mana ?? 0)), h('span', { class: 'bar mana' }, h('i', { style: { width: `${(cur.mana ?? 0) / 2}%` } }))));
    else if (meHero) {
      const cls = (HERO_CLASSES as any)[meHero.cls];
      const cd = Math.max(0, meHero.abilityReadyAt - cur.now);
      parts.push(h('span', { class: 'row' }, h('span', { class: 'bar hp' }, h('i', { style: { width: `${100 * meHero.hp / meHero.maxHp}%`, background: meHero.hp / meHero.maxHp < .3 ? 'var(--red)' : '' } })), `${meHero.hp}/${meHero.maxHp}`));
      parts.push(h('span', { class: 'row' }, cooldownRing(cd ? 1 - cd / cls.ability.cd : 1, cd ? `${Math.ceil(cd / 1000)}` : '✓', cd ? '#a9a8c0' : '#5fc68a'), h('span', { style: { color: cd ? 'var(--text2)' : 'var(--green)' } }, cls.ability.name)));
      if (cur.artifact?.carrier === me.id) parts.push(h('b', { class: 'pulse', style: { color: 'var(--accent)' } }, '◆ Zum Ausgang!'));
      if (!meHero.alive) parts.push(h('b', { style: { color: 'var(--red)' } }, meHero.respawnAt ? `Tot — zurück in ${fmtTime(meHero.respawnAt - cur.now)}` : 'Endgültig gefallen'));
    }
    hudTop.replaceChildren(...parts);
    hudLeft.replaceChildren(...cur.heroes.map((hh: any) => h('div', { class: 'row', style: { opacity: hh.alive ? 1 : .5 } },
      h('span', { style: { color: CLASS_COLOR[hh.cls] } }, '●'), h('span', { style: { color: teamColor(hh.id) } }, hh.name), h('span', { class: 'bar', style: { width: '70px' } }, h('i', { style: { width: `${100 * hh.hp / hh.maxHp}%` } })),
      cur!.artifact?.carrier === hh.id ? h('span', { style: { color: 'var(--accent)' } }, '◆') : null)));
    vignette.style.opacity = meHero && meHero.alive ? String(Math.min(0.9, 1 - meHero.hp / meHero.maxHp)) : meHero ? '0.95' : '0';
    if (isKerker) renderCards();
  }
  function renderCards() {
    if (!isKerker) return;
    cards.replaceChildren(...KERKER_CARD_IDS.map((id, i) => {
      const def = (KERKER_CARDS as any)[id];
      return h('button', { class: 'cardbtn' + (selectedCard === id ? ' active' : '') + ((cur?.mana ?? 0) < def.cost ? ' poor' : ''), onclick: () => { selectedCard = selectedCard === id ? null : id; renderCards(); play('select'); } },
        h('span', { class: 'cardicon' }, cardIcon(id)), h('b', {}, `${i + 1} ${def.name}`), h('small', {}, `${def.cost} ✦`), h('div', { class: 'muted' }, cardHint(id)));
    }));
  }

  raf = requestAnimationFrame(frame);

  return {
    showOver(result: any, lobbyState: any) {
      over = result;
      keys.clear();
      const youWon = result.winner && (result.winner === 'heroes') !== isKerker;
      play(youWon ? 'win' : 'lose');
      const rows = [...(result.heroes || []).map((p: any) => h('tr', {}, h('td', {}, p.name), h('td', {}, (HERO_CLASSES as any)[p.cls]?.name || ''), h('td', {}, String(p.kills)), h('td', {}, String(p.deaths)))),
        ...(result.kerkers || []).map((p: any) => h('tr', {}, h('td', {}, p.name), h('td', {}, 'Kerker'), h('td', {}, `${p.kills} Kills`), h('td', {}, `${p.placed} gesetzt`)))];
      root.append(h('div', { class: 'overlay' }, h('div', { class: 'card over' },
        h('div', { class: 'over-title ' + (youWon ? 'win' : 'lose') }, result.winner === 'heroes' ? 'Die Helden entkommen!' : result.winner === 'kerker' ? 'Der Kerker behält alles.' : 'Match beendet'),
        h('p', { class: 'muted' }, reasonText(result.reason) + ` Dauer ${fmtTime(result.durationMs || 0)}.`),
        lobbyState?.teams ? h('div', { class: 'row', style: { gap: '14px', marginBottom: '10px' } }, ...lobbyState.teams.map((t: any) => h('span', { class: 'tag', style: { color: t.color, borderColor: t.color } }, `${t.name} ${t.points}`))) : null,
        lobbyState?.series ? h('p', { class: 'muted' }, lobbyState.series.round < lobbyState.series.rounds ? `Nächste Runde: ${lobbyState.series.round + 1} von ${lobbyState.series.rounds}` : 'Letzte Runde gespielt.') : lobbyState?.lastSeries?.winner ? h('p', {}, h('b', { style: { color: 'var(--accent)' } }, `Serie vorbei — Team ${lobbyState.lastSeries.winner} gewinnt!`)) : null,
        h('table', {}, h('tr', {}, h('th', {}, 'Spieler'), h('th', {}, 'Rolle'), h('th', {}, 'Kills'), h('th', {}, 'Tode')), ...rows),
        h('div', { style: { marginTop: '16px' } }, h('button', { class: 'primary', onclick: onBackToLobby }, 'Zurück zur Lobby')),
      )));
    },
    stop() {
      cancelAnimationFrame(raf);
      if (inputTimer) clearInterval(inputTimer);
      s.off(EV.GAME_SNAPSHOT, onSnap); s.off('game:place_result', onPlace);
      window.removeEventListener('keydown', kd); window.removeEventListener('keyup', ku); window.removeEventListener('resize', resize);
      renderer.dispose();
    },
  };
}

function cardHint(id: string) {
  return ({ stachel: 'versteckt, 35 Schaden', grube: 'versteckt, betäubt 2s', mauer: 'blockt, 60 HP', krabbler: 'schnell, schwach', brecher: 'zäh, hart', nebel: 'Sicht auf 2,5' } as any)[id];
}
function cardIcon(id: string) {
  return ({ stachel: '▲▲', grube: '◍', mauer: '▦', krabbler: '✶', brecher: '☗', nebel: '☁' } as any)[id];
}
