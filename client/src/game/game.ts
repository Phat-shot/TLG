// Spielbildschirm: Canvas-Renderer, Eingabe, HUD. Zwei Sichten:
//  - Held: Kamera folgt dem eigenen Helden, Nebel des Krieges (Teamsicht vom Server).
//  - Kerker: ganze Karte, Kartenleiste unten, Klick setzt eine Karte.
import { h, fmtTime, errText } from '../ui';
import { sock } from '../net';
import type { User } from '../api';
import { EV, TILE_PX, TICK_MS, HERO_CLASSES, KERKER_CARDS, KERKER_CARD_IDS, MONSTERS, HERO_VISION, NEBEL_VISION, MIN_PLACE_DIST, MIN_SPAWN_DIST, deserializeMap, isWall } from '@tlg/shared';
import { reasonText } from '../screens/lobby';
import { play, unlockAudio, setMuted, isMuted } from './sfx';
import { drawTiles, torchSpots, Particles, drawHeroFigure, drawMonsterFigure, drawWallBlock, drawTrapIcon, drawArtifact, drawExit, drawEntrance, drawZone, CLASS_COLOR } from './render';

export type StartPayload = {
  matchId: string; role: 'hero' | 'kerker'; endsAt: number; you: { cls?: string };
  round: number; rounds: number; kerkerTeam: { id: number; name: string; color: string };
  teams: { id: number; name: string; color: string; members: string[] }[];
  map: { w: number; h: number; tiles: number[]; entrance: P; exit: P; artifact: P; seed?: number };
  heroes: { id: string; name: string; cls: string }[]; kerkers: { id: string; name: string }[];
};
type P = { x: number; y: number };
type Snap = {
  now: number; lives: number; phase: string; mana?: number; vision?: { x: number; y: number; r: number }[];
  artifact: { x: number; y: number; carrier: string | null } | null;
  heroes: any[]; monsters: any[]; traps: any[]; walls: any[]; projectiles: any[]; zones: any[]; events: any[];
};

const KEYS: Record<string, [number, number]> = { KeyW: [0, -1], KeyS: [0, 1], KeyA: [-1, 0], KeyD: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] };
const T = TILE_PX;

export function startGame(me: User, start: StartPayload, onBackToLobby: () => void) {
  const s = sock();
  const map = deserializeMap(start.map as any) as any;
  const isKerker = start.role === 'kerker';
  const teamColor = (id: string) => start.teams?.find(t => t.members.includes(id))?.color || 'inherit';
  const names = new Map<string, string>([...start.heroes.map(x => [x.id, x.name] as [string, string]), ...start.kerkers.map(x => [x.id, x.name] as [string, string])]);
  unlockAudio();

  // ── DOM ──
  const canvas = h('canvas');
  const ctx = canvas.getContext('2d')!;
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

  // ── Vorgerenderte Kacheln ──
  const tileLayer = document.createElement('canvas');
  tileLayer.width = map.w * T; tileLayer.height = map.h * T;
  drawTiles(tileLayer.getContext('2d')!, map);
  const torches = torchSpots(map);
  const explored = new Uint8Array(map.w * map.h);
  const fogLayer = document.createElement('canvas');

  // ── Zustand ──
  let prev: Snap | null = null, cur: Snap | null = null, curAt = 0;
  const fx: { until: number; draw: (c: CanvasRenderingContext2D, k: number) => void }[] = [];
  const floaters: { x: number; y: number; text: string; color: string; born: number }[] = [];
  const particles = new Particles();
  const feedLines: { el: HTMLElement; until: number }[] = [];
  const wallBorn = new Map<number, number>();
  const lastPos = new Map<string, { x: number; y: number; moving: boolean }>();
  let over: any = null;
  let selectedCard: string | null = null;
  const mouse = { x: 0, y: 0, down: false, rdown: false };
  const keys = new Set<string>();
  let reqId = 0;
  let shake = 0; let lastFrame = performance.now();
  let myHpLast = -1;

  // ── Netz ──
  const onSnap = (snap: Snap) => {
    prev = cur; cur = snap; curAt = performance.now();
    if (!isKerker && snap.vision) for (const e of snap.vision) markExplored(e.x, e.y, e.r);
    for (const w of snap.walls) if (!wallBorn.has(w.id)) wallBorn.set(w.id, curAt);
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
  const floater = (x: number, y: number, text: string, color: string) => floaters.push({ x, y, text, color, born: performance.now() });
  function handleEvent(ev: any) {
    const now = performance.now();
    const n = (id: string) => names.get(id) || '?';
    const heroAt = (id: string) => cur?.heroes.find(x => x.id === id);
    switch (ev.t) {
      case 'swing': fx.push({ until: now + 140, draw: (c, k) => { c.strokeStyle = `rgba(255,255,255,${0.8 * (1 - k)})`; c.lineWidth = 4 * (1 - k) + 1; c.beginPath(); c.arc(ev.x * T, ev.y * T, ev.range * T * (0.6 + 0.4 * k), ev.facing - 1, ev.facing + 1); c.stroke(); } }); if (ev.hero === me.id || !isKerker) play('swing'); break;
      case 'hit': particles.burst(ev.x, ev.y, 7, '#ffd36b', 3, 350, 2.2, 0, true); floater(ev.x, ev.y - 0.3, `-${ev.dmg}`, '#ffd36b'); play('hit'); break;
      case 'hero_hit': { const hh = heroAt(ev.hero); if (hh) { particles.burst(hh.x, hh.y, 6, '#e0534f', 2.5, 300, 2); floater(hh.x, hh.y - 0.4, `-${ev.dmg}`, '#ff8a85'); } break; }
      case 'trap': toast(`${n(ev.hero)} ist in eine ${(KERKER_CARDS as any)[ev.type].name} getreten`, 'var(--red)');
        particles.burst(ev.tx + .5, ev.ty + .5, 18, ev.type === 'stachel' ? '#d8d8e8' : '#4a3a2a', 4, 500, 2.5, 6);
        fx.push({ until: now + 400, draw: (c, k) => { c.strokeStyle = `rgba(224,83,79,${1 - k})`; c.lineWidth = 3; c.strokeRect(ev.tx * T + 2 - k * 6, ev.ty * T + 2 - k * 6, T - 4 + k * 12, T - 4 + k * 12); } }); play('trap'); break;
      case 'hero_dead': toast(`${n(ev.hero)} ist gefallen${ev.respawn ? '' : ' — endgültig'}`, 'var(--red)'); particles.burst(ev.x, ev.y, 30, '#b8302c', 4, 700, 3, 8); particles.burst(ev.x, ev.y, 12, '#ffffff', 2, 500, 1.5, 0, true); play('death'); if (ev.hero === me.id) shake = 14; break;
      case 'respawn': toast(`${n(ev.hero)} ist zurück`, 'var(--green)'); particles.burst(map.entrance.x + .5, map.entrance.y + .5, 20, '#9fd8ff', 3, 600, 2, -4, true); play('respawn'); break;
      case 'artifact_pick': toast(`${n(ev.hero)} trägt das Artefakt!`, 'var(--accent)'); { const hh = heroAt(ev.hero); if (hh) particles.burst(hh.x, hh.y, 24, '#ffd86b', 3, 700, 2.5, -2, true); } play('pick'); break;
      case 'artifact_drop': toast('Das Artefakt liegt wieder am Boden', 'var(--accent)'); break;
      case 'monster_dead': particles.burst(ev.x, ev.y, 22, ev.type === 'brecher' ? '#7a1f1f' : '#c0392b', 4, 600, 3, 8); toast(`${(MONSTERS as any)[ev.type].name} erledigt`); break;
      case 'wall_hit': particles.burst(ev.tx + .5, ev.ty + .5, 5, '#a07a50', 3, 300, 2, 8); break;
      case 'wall_broken': toast('Eine Mauer ist gefallen'); particles.burst(ev.tx + .5, ev.ty + .5, 26, '#8a6a46', 4, 700, 3, 9); play('wall'); break;
      case 'reveal': toast('Falle aufgedeckt!', 'var(--purple)'); particles.burst(ev.tx + .5, ev.ty + .5, 14, '#c9a6ff', 2, 600, 2, -2, true); play('reveal'); break;
      case 'ability':
        if (ev.id === 'heilkreis') { fx.push({ until: now + 600, draw: (c, k) => { c.strokeStyle = `rgba(244,213,107,${1 - k})`; c.lineWidth = 3; c.beginPath(); c.arc(ev.x * T, ev.y * T, 4 * T * k, 0, 7); c.stroke(); } }); particles.burst(ev.x, ev.y, 30, '#fff0a0', 3, 800, 2, -3, true); play('heal'); }
        if (ev.id === 'schildstoss') particles.burst(ev.x, ev.y, 12, '#cfd6e6', 3, 400, 2);
        if (ev.id === 'salve') play('shoot');
        if (ev.id === 'spuersinn') { fx.push({ until: now + 500, draw: (c, k) => { c.strokeStyle = `rgba(180,138,232,${1 - k})`; c.lineWidth = 2; c.beginPath(); c.arc(ev.x * T, ev.y * T, 6 * T * k, 0, 7); c.stroke(); } }); }
        break;
      case 'place': if (isKerker) { particles.burst(ev.tx + .5, ev.ty + .5, 12, '#c9a6ff', 2.5, 450, 2, 0, true); } break;
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
  canvas.addEventListener('mousemove', e => { mouse.x = e.clientX; mouse.y = e.clientY; });
  canvas.addEventListener('mousedown', e => { e.preventDefault(); unlockAudio(); if (e.button === 0) { mouse.down = true; if (isKerker) kerkerClick(); } if (e.button === 2) { mouse.rdown = true; if (isKerker) { selectedCard = null; renderCards(); } } });
  window.addEventListener('mouseup', e => { if (e.button === 0) mouse.down = false; if (e.button === 2) mouse.rdown = false; });
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

  // ── Kamera ──
  const cam = { x: map.entrance.x + .5, y: map.entrance.y + .5, scale: 1 };
  function resize() {
    canvas.width = root.clientWidth * devicePixelRatio; canvas.height = root.clientHeight * devicePixelRatio;
    fogLayer.width = canvas.width; fogLayer.height = canvas.height;
    if (isKerker) cam.scale = Math.min((root.clientWidth - 20) / (map.w * T), (root.clientHeight - 170) / (map.h * T));
  }
  window.addEventListener('resize', resize); resize();
  function screenToWorld(sx: number, sy: number) {
    const W = root.clientWidth, H = root.clientHeight;
    return { x: (sx - W / 2) / (cam.scale * T) + cam.x, y: (sy - H / 2) / (cam.scale * T) + cam.y };
  }

  // ── Render ──
  const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
  function interp<T extends { id: any; x: number; y: number }>(list: T[], prevList: T[] | undefined, t: number): T[] {
    if (!prevList) return list;
    const pm = new Map(prevList.map(p => [p.id, p]));
    return list.map(e => { const p = pm.get(e.id); return p ? { ...e, x: lerp(p.x, e.x, t), y: lerp(p.y, e.y, t) } : e; });
  }
  const movingOf = (id: string, x: number, y: number) => {
    const l = lastPos.get(id);
    const moving = !!l && (Math.abs(l.x - x) > 0.002 || Math.abs(l.y - y) > 0.002);
    lastPos.set(id, { x, y, moving });
    return moving;
  };
  let raf = 0;
  function frame() {
    raf = requestAnimationFrame(frame);
    const now = performance.now(); const dt = Math.min(50, now - lastFrame); lastFrame = now;
    particles.step(dt);
    const W = root.clientWidth, H = root.clientHeight;
    ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
    ctx.fillStyle = '#07070b'; ctx.fillRect(0, 0, W, H);
    if (!cur) return;
    const t = Math.min(1, (now - curAt) / TICK_MS);
    const heroes = interp(cur.heroes, prev?.heroes, t);
    const monsters = interp(cur.monsters, prev?.monsters, t);
    const projectiles = interp(cur.projectiles, prev?.projectiles, t);
    const meHero = heroes.find(x => x.id === me.id);
    if (isKerker) { cam.x = map.w / 2; cam.y = map.h / 2 + 30 / (cam.scale * T); }
    else if (meHero) { cam.x = lerp(cam.x, meHero.x, 0.25); cam.y = lerp(cam.y, meHero.y, 0.25); cam.scale = 1; }
    shake *= 0.86; if (shake < 0.2) shake = 0;
    const sx = shake ? (Math.random() - .5) * shake : 0, sy = shake ? (Math.random() - .5) * shake : 0;

    ctx.save();
    ctx.translate(W / 2 + sx, H / 2 + sy); ctx.scale(cam.scale, cam.scale); ctx.translate(-cam.x * T, -cam.y * T);
    ctx.drawImage(tileLayer, 0, 0);
    // Fackeln (Lichtflecken)
    for (const tr of torches) {
      const fl = 0.85 + Math.sin(now / 90 + tr.x * 7) * 0.08 + Math.random() * 0.07;
      const g = ctx.createRadialGradient(tr.x * T, tr.y * T, 2, tr.x * T, tr.y * T, T * 2.2 * fl);
      g.addColorStop(0, 'rgba(255,170,70,.28)'); g.addColorStop(1, 'rgba(255,120,40,0)');
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(tr.x * T, tr.y * T, T * 2.2 * fl, 0, 7); ctx.fill();
      ctx.fillStyle = '#ffb34a'; ctx.beginPath(); ctx.arc(tr.x * T, tr.y * T - 2, 2.2, 0, 7); ctx.fill();
      ctx.fillStyle = '#5a3a1a'; ctx.fillRect(tr.x * T - 1, tr.y * T, 2, 5);
    }
    drawEntrance(ctx, map.entrance); drawExit(ctx, map.exit, now);
    for (const z of cur.zones) drawZone(ctx, z, now);
    for (const tr of cur.traps) drawTrapIcon(ctx, tr, now, isKerker && !tr.revealed);
    for (const w of cur.walls) drawWallBlock(ctx, w, now, now - (wallBorn.get(w.id) ?? now));
    if (cur.artifact && cur.artifact.carrier === null) { drawArtifact(ctx, cur.artifact.x, cur.artifact.y, now); if (Math.random() < 0.15) particles.burst(cur.artifact.x, cur.artifact.y, 1, '#ffe08a', 0.8, 900, 1.5, -1.5, true); }
    // Zeichenreihenfolge nach y (einfaches Depth-Sorting)
    const drawables: { y: number; draw: () => void }[] = [];
    for (const m of monsters) drawables.push({ y: m.y, draw: () => drawMonsterFigure(ctx, m, now, movingOf('m' + m.id, m.x, m.y)) });
    for (const hh of heroes) drawables.push({ y: hh.y, draw: () => drawHeroOrGhost(hh, hh.id === me.id) });
    drawables.sort((a, b) => a.y - b.y).forEach(d => d.draw());
    for (const p of projectiles) {
      const pp = prev?.projectiles.find((q: any) => q.id === p.id);
      ctx.strokeStyle = 'rgba(255,226,138,.5)'; ctx.lineWidth = 3; ctx.lineCap = 'round';
      if (pp) { ctx.beginPath(); ctx.moveTo(pp.x * T, pp.y * T); ctx.lineTo(p.x * T, p.y * T); ctx.stroke(); }
      ctx.shadowColor = '#ffe28a'; ctx.shadowBlur = 8; ctx.fillStyle = '#fff3c0'; ctx.beginPath(); ctx.arc(p.x * T, p.y * T, 3.5, 0, 7); ctx.fill(); ctx.shadowBlur = 0;
    }
    particles.draw(ctx);
    for (let i = fx.length - 1; i >= 0; i--) { if (fx[i].until < now) fx.splice(i, 1); else { const k = 1 - (fx[i].until - now) / 600; fx[i].draw(ctx, Math.max(0, Math.min(1, k))); } }
    for (let i = floaters.length - 1; i >= 0; i--) {
      const f = floaters[i]; const age = now - f.born; if (age > 900) { floaters.splice(i, 1); continue; }
      ctx.globalAlpha = 1 - age / 900; ctx.fillStyle = f.color; ctx.font = 'bold 13px system-ui'; ctx.textAlign = 'center';
      ctx.strokeStyle = 'rgba(0,0,0,.8)'; ctx.lineWidth = 3; ctx.strokeText(f.text, f.x * T, f.y * T - age / 30); ctx.fillText(f.text, f.x * T, f.y * T - age / 30);
      ctx.globalAlpha = 1;
    }
    if (isKerker) {
      for (const hh of heroes) if (hh.alive) { const r = cur.zones.some((z: any) => Math.hypot(z.x - hh.x, z.y - hh.y) <= z.r) ? NEBEL_VISION : HERO_VISION; ctx.strokeStyle = 'rgba(90,169,230,.22)'; ctx.setLineDash([6, 6]); ctx.lineDashOffset = -now / 80; ctx.beginPath(); ctx.arc(hh.x * T, hh.y * T, r * T, 0, 7); ctx.stroke(); ctx.setLineDash([]); ctx.fillStyle = 'rgba(90,169,230,.05)'; ctx.fill(); }
      if (selectedCard) {
        const w = screenToWorld(mouse.x, mouse.y); const tx = Math.floor(w.x), ty = Math.floor(w.y);
        const bad = placementCheck(selectedCard, tx, ty);
        ctx.fillStyle = bad ? 'rgba(224,83,79,.4)' : 'rgba(95,198,138,.4)'; ctx.fillRect(tx * T, ty * T, T, T);
        ctx.strokeStyle = bad ? '#e0534f' : '#5fc68a'; ctx.lineWidth = 2; ctx.strokeRect(tx * T + 1, ty * T + 1, T - 2, T - 2);
        const def = (KERKER_CARDS as any)[selectedCard];
        if (def.kind === 'zone') { ctx.strokeStyle = 'rgba(167,123,224,.6)'; ctx.setLineDash([4, 4]); ctx.beginPath(); ctx.arc((tx + .5) * T, (ty + .5) * T, def.radius * T, 0, 7); ctx.stroke(); ctx.setLineDash([]); }
        if (bad) { ctx.fillStyle = '#ffb3b0'; ctx.font = 'bold 11px system-ui'; ctx.textAlign = 'center'; ctx.fillText(errText(bad), (tx + .5) * T, ty * T - 6); }
      }
    }
    ctx.restore();
    if (!isKerker) drawFog(W, H, cur.vision || [], meHero);
    renderHud(meHero);
  }

  function drawHeroOrGhost(hh: any, isMe: boolean) {
    const nowSim = cur!.now; const now = performance.now();
    const px = hh.x * T, py = hh.y * T, r = 0.35 * T;
    if (!hh.alive) {
      ctx.globalAlpha = .4; ctx.fillStyle = '#9a9ab0'; ctx.beginPath(); ctx.arc(px, py, r, 0, 7); ctx.fill();
      ctx.strokeStyle = '#ccc'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(px - 5, py - 5); ctx.lineTo(px + 5, py + 5); ctx.moveTo(px + 5, py - 5); ctx.lineTo(px - 5, py + 5); ctx.stroke();
      ctx.globalAlpha = 1; ctx.fillStyle = '#ddd'; ctx.font = '12px system-ui'; ctx.textAlign = 'center'; ctx.fillText(hh.respawnAt ? `⟲ ${fmtTime(hh.respawnAt - nowSim)}` : '✝', px, py - r - 10); return;
    }
    if (nowSim < hh.invisibleUntil) ctx.globalAlpha = .4;
    drawHeroFigure(ctx, hh, now, movingOf(hh.id, hh.x, hh.y), cur!.artifact?.carrier === hh.id, isMe);
    if (nowSim < hh.stunnedUntil) { for (let i = 0; i < 3; i++) { const a = now / 300 + i * 2.1; ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(px + Math.cos(a) * 10, py - r - 14 + Math.sin(a) * 3, 2, 0, 7); ctx.fill(); } }
    ctx.fillStyle = '#fff'; ctx.font = 'bold 11px system-ui'; ctx.textAlign = 'center';
    ctx.strokeStyle = 'rgba(0,0,0,.8)'; ctx.lineWidth = 3; ctx.strokeText(hh.name, px, py - r - 12); ctx.fillStyle = teamColor(hh.id) === 'inherit' ? '#fff' : teamColor(hh.id); ctx.fillText(hh.name, px, py - r - 12);
    bar(px, py - r - 9, hh.hp / hh.maxHp, '#5fc68a', 28);
    ctx.globalAlpha = 1;
  }
  function bar(cx: number, y: number, frac: number, color: string, w: number) {
    ctx.fillStyle = 'rgba(0,0,0,.7)'; ctx.fillRect(cx - w / 2 - 1, y - 1, w + 2, 6);
    ctx.fillStyle = frac < 0.3 ? '#e0534f' : color; ctx.fillRect(cx - w / 2, y, w * Math.max(0, Math.min(1, frac)), 4);
  }
  function drawFog(W: number, H: number, vision: { x: number; y: number; r: number }[], meHero: any) {
    const f = fogLayer.getContext('2d')!;
    f.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
    f.globalCompositeOperation = 'source-over';
    f.fillStyle = '#07070b'; f.fillRect(0, 0, W, H);
    f.save(); f.translate(W / 2, H / 2); f.scale(cam.scale, cam.scale); f.translate(-cam.x * T, -cam.y * T);
    const x0 = Math.max(0, Math.floor(cam.x - W / 2 / T / cam.scale) - 1), x1 = Math.min(map.w - 1, Math.ceil(cam.x + W / 2 / T / cam.scale) + 1);
    const y0 = Math.max(0, Math.floor(cam.y - H / 2 / T / cam.scale) - 1), y1 = Math.min(map.h - 1, Math.ceil(cam.y + H / 2 / T / cam.scale) + 1);
    f.fillStyle = 'rgba(7,7,11,.7)';
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (explored[y * map.w + x]) { f.clearRect(x * T, y * T, T, T); f.fillRect(x * T, y * T, T, T); }
    f.globalCompositeOperation = 'destination-out';
    for (const e of vision) {
      const g = f.createRadialGradient(e.x * T, e.y * T, e.r * T * .55, e.x * T, e.y * T, e.r * T);
      g.addColorStop(0, 'rgba(0,0,0,1)'); g.addColorStop(1, 'rgba(0,0,0,0)');
      f.fillStyle = g; f.beginPath(); f.arc(e.x * T, e.y * T, e.r * T, 0, 7); f.fill();
    }
    f.restore();
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.drawImage(fogLayer, 0, 0); ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
    // warmes Licht um den eigenen Helden
    if (meHero?.alive) {
      const cx = W / 2 + (meHero.x - cam.x) * T, cy = H / 2 + (meHero.y - cam.y) * T;
      const g = ctx.createRadialGradient(cx, cy, 10, cx, cy, T * 5);
      g.addColorStop(0, 'rgba(255,200,120,.10)'); g.addColorStop(1, 'rgba(255,200,120,0)');
      ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    }
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
    },
  };
}

function cardHint(id: string) {
  return ({ stachel: 'versteckt, 35 Schaden', grube: 'versteckt, betäubt 2s', mauer: 'blockt, 60 HP', krabbler: 'schnell, schwach', brecher: 'zäh, hart', nebel: 'Sicht auf 2,5' } as any)[id];
}
function cardIcon(id: string) {
  return ({ stachel: '▲▲', grube: '◍', mauer: '▦', krabbler: '✶', brecher: '☗', nebel: '☁' } as any)[id];
}
