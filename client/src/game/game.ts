// Spielbildschirm: Canvas-Renderer, Eingabe, HUD. Zwei Sichten:
//  - Held: Kamera folgt dem eigenen Helden, Nebel des Krieges (Teamsicht vom Server).
//  - Kerker: ganze Karte, Kartenleiste unten, Klick setzt eine Karte.
import { h, fmtTime, errText } from '../ui';
import { sock } from '../net';
import type { User } from '../api';
import { EV, TILE_PX, TICK_MS, HERO_CLASSES, KERKER_CARDS, KERKER_CARD_IDS, MONSTERS, HERO_VISION, NEBEL_VISION, MIN_PLACE_DIST, MIN_SPAWN_DIST, deserializeMap, isWall } from '@tlg/shared';
import { reasonText } from '../screens/lobby';

export type StartPayload = {
  matchId: string; role: 'hero' | 'kerker'; endsAt: number; you: { cls?: string };
  round: number; rounds: number; kerkerTeam: { id: number; name: string; color: string };
  teams: { id: number; name: string; color: string; members: string[] }[];
  map: { w: number; h: number; tiles: number[]; entrance: P; exit: P; artifact: P };
  heroes: { id: string; name: string; cls: string }[]; kerkers: { id: string; name: string }[];
};
type P = { x: number; y: number };
type Snap = {
  now: number; lives: number; phase: string; mana?: number; vision?: { x: number; y: number; r: number }[];
  artifact: { x: number; y: number; carrier: string | null } | null;
  heroes: any[]; monsters: any[]; traps: any[]; walls: any[]; projectiles: any[]; zones: any[]; events: any[];
};

const CLASS_COLOR: Record<string, string> = { krieger: '#e06c3c', schuetze: '#5fc68a', heiler: '#f2d16b', schurke: '#a77be0' };
const KEYS: Record<string, [number, number]> = { KeyW: [0, -1], KeyS: [0, 1], KeyA: [-1, 0], KeyD: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] };

export function startGame(me: User, start: StartPayload, onBackToLobby: () => void) {
  const s = sock();
  const map = deserializeMap(start.map as any) as any;
  const isKerker = start.role === 'kerker';
  const teamColor = (id: string) => start.teams?.find(t => t.members.includes(id))?.color || 'inherit';
  const names = new Map<string, string>([...start.heroes.map(x => [x.id, x.name] as [string, string]), ...start.kerkers.map(x => [x.id, x.name] as [string, string])]);

  // ── DOM ──
  const canvas = h('canvas');
  const ctx = canvas.getContext('2d')!;
  const hudTop = h('div', { class: 'hud top' });
  const hudLeft = h('div', { class: 'hud left' });
  const feed = h('div', { class: 'hud feed' });
  const cards = h('div', { class: 'cards' });
  const help = h('div', { class: 'help' });
  const root = h('div', { id: 'game' }, canvas, hudTop, hudLeft, feed, cards, help);
  document.getElementById('app')!.replaceChildren(root);
  help.innerHTML = isKerker
    ? '<kbd>1</kbd>–<kbd>6</kbd> Karte wählen · Klick setzen · <kbd>Esc</kbd> abwählen · Fallen sind für Helden unsichtbar, Mauern dürfen nie versiegeln'
    : '<kbd>WASD</kbd> laufen · Maus zielen · <kbd>LMB</kbd> angreifen · <kbd>Space</kbd>/<kbd>RMB</kbd> Fähigkeit · Artefakt holen und zum Ausgang bringen';

  // ── Vorgerenderte Kacheln ──
  const tileLayer = document.createElement('canvas');
  tileLayer.width = map.w * TILE_PX; tileLayer.height = map.h * TILE_PX;
  drawTiles(tileLayer.getContext('2d')!, map);
  const explored = new Uint8Array(map.w * map.h);
  const fogLayer = document.createElement('canvas');

  // ── Zustand ──
  let prev: Snap | null = null, cur: Snap | null = null, curAt = 0;
  const fx: { until: number; draw: (c: CanvasRenderingContext2D) => void }[] = [];
  const feedLines: { el: HTMLElement; until: number }[] = [];
  let over: any = null;
  let selectedCard: string | null = null;
  const mouse = { x: 0, y: 0, down: false, rdown: false };
  const keys = new Set<string>();
  let reqId = 0;

  // ── Netz ──
  const onSnap = (snap: Snap) => {
    prev = cur; cur = snap; curAt = performance.now();
    if (!isKerker && snap.vision) for (const e of snap.vision) markExplored(e.x, e.y, e.r);
    for (const ev of snap.events) handleEvent(ev);
  };
  const onPlace = (r: any) => { if (!r.ok) toast(errText(r.error), 'var(--red)'); };
  s.on(EV.GAME_SNAPSHOT, onSnap);
  s.on('game:place_result', onPlace);

  function markExplored(cx: number, cy: number, r: number) {
    const x0 = Math.max(0, Math.floor(cx - r)), x1 = Math.min(map.w - 1, Math.ceil(cx + r));
    const y0 = Math.max(0, Math.floor(cy - r)), y1 = Math.min(map.h - 1, Math.ceil(cy + r));
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if ((x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2 <= (r + 0.5) ** 2) explored[y * map.w + x] = 1;
  }
  function toast(text: string, color = 'var(--text2)') {
    const el = h('div', { style: { color } }, text);
    feed.append(el); feedLines.push({ el, until: performance.now() + 6000 });
    while (feedLines.length > 7) feedLines.shift()!.el.remove();
  }
  function handleEvent(ev: any) {
    const now = performance.now();
    const n = (id: string) => names.get(id) || '?';
    switch (ev.t) {
      case 'swing': fx.push({ until: now + 120, draw: c => { c.strokeStyle = 'rgba(255,255,255,.7)'; c.lineWidth = 3; c.beginPath(); c.arc(ev.x * TILE_PX, ev.y * TILE_PX, ev.range * TILE_PX, ev.facing - 1, ev.facing + 1); c.stroke(); } }); break;
      case 'hit': fx.push({ until: now + 150, draw: c => { c.fillStyle = 'rgba(255,230,120,.8)'; c.beginPath(); c.arc(ev.x * TILE_PX, ev.y * TILE_PX, 6, 0, 7); c.fill(); } }); break;
      case 'trap': toast(`${n(ev.hero)} ist in eine ${(KERKER_CARDS as any)[ev.type].name} getreten`, 'var(--red)');
        fx.push({ until: now + 500, draw: c => { c.strokeStyle = '#e0534f'; c.lineWidth = 2; c.strokeRect(ev.tx * TILE_PX + 2, ev.ty * TILE_PX + 2, TILE_PX - 4, TILE_PX - 4); } }); break;
      case 'hero_dead': toast(`${n(ev.hero)} ist gefallen${ev.respawn ? '' : ' — endgültig'}`, 'var(--red)'); break;
      case 'respawn': toast(`${n(ev.hero)} ist zurück`, 'var(--green)'); break;
      case 'artifact_pick': toast(`${n(ev.hero)} trägt das Artefakt!`, 'var(--accent)'); break;
      case 'artifact_drop': toast('Das Artefakt liegt wieder am Boden', 'var(--accent)'); break;
      case 'monster_dead': toast(`${(MONSTERS as any)[ev.type].name} erledigt`); break;
      case 'wall_broken': toast('Eine Mauer ist gefallen'); break;
      case 'reveal': toast('Falle aufgedeckt!', 'var(--purple)'); break;
      case 'ability': if (ev.id === 'heilkreis') fx.push({ until: now + 400, draw: c => { c.strokeStyle = '#f2d16b'; c.lineWidth = 2; c.beginPath(); c.arc(ev.x * TILE_PX, ev.y * TILE_PX, 4 * TILE_PX, 0, 7); c.stroke(); } }); break;
      case 'place': if (isKerker) fx.push({ until: now + 300, draw: c => { c.strokeStyle = '#a77be0'; c.strokeRect(ev.tx * TILE_PX, ev.ty * TILE_PX, TILE_PX, TILE_PX); } }); break;
    }
  }

  // ── Eingabe ──
  const onKey = (e: KeyboardEvent, down: boolean) => {
    if (over) return;
    if (down && e.code === 'Escape') { selectedCard = null; renderCards(); }
    if (isKerker && down && /^Digit[1-6]$/.test(e.code)) { selectedCard = KERKER_CARD_IDS[+e.code[5] - 1]; renderCards(); }
    if (e.code in KEYS || e.code === 'Space') { e.preventDefault(); down ? keys.add(e.code) : keys.delete(e.code); }
  };
  const kd = (e: KeyboardEvent) => onKey(e, true), ku = (e: KeyboardEvent) => onKey(e, false);
  window.addEventListener('keydown', kd); window.addEventListener('keyup', ku);
  canvas.addEventListener('mousemove', e => { mouse.x = e.clientX; mouse.y = e.clientY; });
  canvas.addEventListener('mousedown', e => { e.preventDefault(); if (e.button === 0) { mouse.down = true; if (isKerker) kerkerClick(); } if (e.button === 2) { mouse.rdown = true; if (isKerker) { selectedCard = null; renderCards(); } } });
  window.addEventListener('mouseup', e => { if (e.button === 0) mouse.down = false; if (e.button === 2) mouse.rdown = false; });
  canvas.addEventListener('contextmenu', e => e.preventDefault());
  window.addEventListener('blur', () => keys.clear());

  const inputTimer = !isKerker ? setInterval(() => {
    if (over || !cur) return;
    let mx = 0, my = 0;
    for (const k of keys) if (KEYS[k]) { mx += KEYS[k][0]; my += KEYS[k][1]; }
    const w = screenToWorld(mouse.x, mouse.y);
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
  const cam = { x: 0, y: 0, scale: 1 };
  function resize() {
    canvas.width = root.clientWidth * devicePixelRatio; canvas.height = root.clientHeight * devicePixelRatio;
    fogLayer.width = canvas.width; fogLayer.height = canvas.height;
    if (isKerker) cam.scale = Math.min((root.clientWidth - 20) / (map.w * TILE_PX), (root.clientHeight - 170) / (map.h * TILE_PX));
  }
  window.addEventListener('resize', resize); resize();
  function screenToWorld(sx: number, sy: number) {
    const W = root.clientWidth, H = root.clientHeight;
    return { x: (sx - W / 2) / (cam.scale * TILE_PX) + cam.x, y: (sy - H / 2) / (cam.scale * TILE_PX) + cam.y };
  }

  // ── Render ──
  const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
  function interp<T extends { id: any; x: number; y: number }>(list: T[], prevList: T[] | undefined, t: number): T[] {
    if (!prevList) return list;
    const pm = new Map(prevList.map(p => [p.id, p]));
    return list.map(e => { const p = pm.get(e.id); return p ? { ...e, x: lerp(p.x, e.x, t), y: lerp(p.y, e.y, t) } : e; });
  }
  let raf = 0;
  function frame() {
    raf = requestAnimationFrame(frame);
    const W = root.clientWidth, H = root.clientHeight;
    ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
    ctx.fillStyle = '#07070b'; ctx.fillRect(0, 0, W, H);
    if (!cur) return;
    const t = Math.min(1, (performance.now() - curAt) / TICK_MS);
    const heroes = interp(cur.heroes, prev?.heroes, t);
    const monsters = interp(cur.monsters, prev?.monsters, t);
    const projectiles = interp(cur.projectiles, prev?.projectiles, t);
    const meHero = heroes.find(x => x.id === me.id);
    if (isKerker) { cam.x = map.w / 2; cam.y = map.h / 2 + 30 / (cam.scale * TILE_PX); }
    else if (meHero) { cam.x = meHero.x; cam.y = meHero.y; cam.scale = 1; }

    ctx.save();
    ctx.translate(W / 2, H / 2); ctx.scale(cam.scale, cam.scale); ctx.translate(-cam.x * TILE_PX, -cam.y * TILE_PX);
    ctx.drawImage(tileLayer, 0, 0);
    // Markierungen
    ring(map.entrance, '#8a8aa0', 'Eingang'); ring(map.exit, '#5fd0e0', 'Ausgang');
    for (const z of cur.zones) { ctx.fillStyle = 'rgba(120,80,200,.28)'; ctx.beginPath(); ctx.arc(z.x * TILE_PX, z.y * TILE_PX, z.r * TILE_PX, 0, 7); ctx.fill(); }
    for (const w of cur.walls) drawWall(w);
    for (const tr of cur.traps) drawTrap(tr);
    if (cur.artifact && cur.artifact.carrier === null) drawArtifact(cur.artifact.x, cur.artifact.y, performance.now());
    for (const m of monsters) drawMonster(m);
    for (const hh of heroes) drawHero(hh, hh.id === me.id);
    for (const p of projectiles) { ctx.fillStyle = '#ffe28a'; ctx.beginPath(); ctx.arc(p.x * TILE_PX, p.y * TILE_PX, 4, 0, 7); ctx.fill(); }
    const now = performance.now();
    for (let i = fx.length - 1; i >= 0; i--) { if (fx[i].until < now) fx.splice(i, 1); else fx[i].draw(ctx); }
    if (isKerker) {
      // Sichtkreise der Helden (was sie sehen können) + Platzierungs-Geist
      for (const hh of heroes) if (hh.alive) { const r = cur.zones.some((z: any) => Math.hypot(z.x - hh.x, z.y - hh.y) <= z.r) ? NEBEL_VISION : HERO_VISION; ctx.strokeStyle = 'rgba(90,169,230,.25)'; ctx.setLineDash([6, 6]); ctx.beginPath(); ctx.arc(hh.x * TILE_PX, hh.y * TILE_PX, r * TILE_PX, 0, 7); ctx.stroke(); ctx.setLineDash([]); }
      if (selectedCard) {
        const w = screenToWorld(mouse.x, mouse.y); const tx = Math.floor(w.x), ty = Math.floor(w.y);
        const bad = placementCheck(selectedCard, tx, ty);
        ctx.fillStyle = bad ? 'rgba(224,83,79,.45)' : 'rgba(95,198,138,.45)'; ctx.fillRect(tx * TILE_PX, ty * TILE_PX, TILE_PX, TILE_PX);
        const def = (KERKER_CARDS as any)[selectedCard];
        if (def.kind === 'zone') { ctx.strokeStyle = 'rgba(167,123,224,.6)'; ctx.beginPath(); ctx.arc((tx + .5) * TILE_PX, (ty + .5) * TILE_PX, def.radius * TILE_PX, 0, 7); ctx.stroke(); }
      }
    }
    ctx.restore();
    if (!isKerker) drawFog(W, H, cur.vision || []);
    renderHud(meHero);
  }

  function ring(p: P, color: string, label: string) {
    ctx.strokeStyle = color; ctx.lineWidth = 3; ctx.beginPath(); ctx.arc((p.x + .5) * TILE_PX, (p.y + .5) * TILE_PX, TILE_PX * .42, 0, 7); ctx.stroke();
    ctx.fillStyle = color; ctx.font = '11px system-ui'; ctx.textAlign = 'center'; ctx.fillText(label, (p.x + .5) * TILE_PX, (p.y - .2) * TILE_PX);
  }
  function drawWall(w: any) {
    const x = w.tx * TILE_PX, y = w.ty * TILE_PX;
    ctx.fillStyle = '#6b4a2e'; ctx.fillRect(x + 1, y + 1, TILE_PX - 2, TILE_PX - 2);
    ctx.strokeStyle = '#3a2816'; ctx.lineWidth = 2; ctx.strokeRect(x + 3, y + 3, TILE_PX - 6, TILE_PX - 6);
    if (w.hp < 60) { ctx.strokeStyle = '#1b1b1b'; ctx.beginPath(); ctx.moveTo(x + 6, y + 8); ctx.lineTo(x + 16, y + 18); ctx.lineTo(x + 12, y + 26); ctx.stroke(); }
    if (w.hp < 30) { ctx.beginPath(); ctx.moveTo(x + 26, y + 6); ctx.lineTo(x + 18, y + 14); ctx.lineTo(x + 24, y + 24); ctx.stroke(); }
  }
  function drawTrap(tr: any) {
    const x = tr.tx * TILE_PX, y = tr.ty * TILE_PX;
    ctx.globalAlpha = isKerker && !tr.revealed ? 0.75 : 1;
    if (tr.type === 'stachel') { ctx.fillStyle = '#c8c8d8'; for (let i = 0; i < 4; i++) { ctx.beginPath(); ctx.moveTo(x + 4 + i * 7, y + 26); ctx.lineTo(x + 7 + i * 7, y + 8); ctx.lineTo(x + 10 + i * 7, y + 26); ctx.fill(); } }
    else { ctx.fillStyle = '#0a0a10'; ctx.beginPath(); ctx.ellipse(x + 16, y + 17, 12, 9, 0, 0, 7); ctx.fill(); ctx.strokeStyle = '#2d2d3a'; ctx.stroke(); }
    if (isKerker && tr.revealed) { ctx.strokeStyle = '#a77be0'; ctx.strokeRect(x + 1, y + 1, TILE_PX - 2, TILE_PX - 2); }
    ctx.globalAlpha = 1;
  }
  function drawArtifact(x: number, y: number, now: number) {
    const px = x * TILE_PX, py = y * TILE_PX + Math.sin(now / 300) * 3;
    ctx.shadowColor = '#ffd86b'; ctx.shadowBlur = 16; ctx.fillStyle = '#ffcf3f';
    ctx.beginPath(); ctx.moveTo(px, py - 10); ctx.lineTo(px + 8, py); ctx.lineTo(px, py + 10); ctx.lineTo(px - 8, py); ctx.closePath(); ctx.fill();
    ctx.shadowBlur = 0;
  }
  function drawMonster(m: any) {
    const md = (MONSTERS as any)[m.type]; const px = m.x * TILE_PX, py = m.y * TILE_PX, r = md.radius * TILE_PX;
    ctx.fillStyle = m.type === 'brecher' ? '#7a1f1f' : '#c0392b';
    ctx.beginPath(); ctx.arc(px, py, r, 0, 7); ctx.fill();
    ctx.fillStyle = '#ffd1d1'; ctx.beginPath(); ctx.arc(px - r * .35, py - r * .2, 2, 0, 7); ctx.arc(px + r * .35, py - r * .2, 2, 0, 7); ctx.fill();
    bar(px, py - r - 7, m.hp / m.maxHp, '#e0534f', r * 2);
  }
  function drawHero(hh: any, isMe: boolean) {
    const px = hh.x * TILE_PX, py = hh.y * TILE_PX, r = 0.35 * TILE_PX; const col = CLASS_COLOR[hh.cls] || '#fff';
    const nowSim = cur!.now;
    if (!hh.alive) { ctx.globalAlpha = .35; ctx.fillStyle = '#888'; ctx.beginPath(); ctx.arc(px, py, r, 0, 7); ctx.fill(); ctx.fillStyle = '#ddd'; ctx.font = '12px system-ui'; ctx.textAlign = 'center'; ctx.fillText(hh.respawnAt ? `⟲ ${fmtTime(hh.respawnAt - nowSim)}` : '✝', px, py - r - 10); ctx.globalAlpha = 1; return; }
    if (nowSim < hh.invisibleUntil) ctx.globalAlpha = .45;
    if (isMe) { ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(px, py, r + 4, 0, 7); ctx.stroke(); }
    ctx.fillStyle = col; ctx.beginPath(); ctx.arc(px, py, r, 0, 7); ctx.fill();
    ctx.strokeStyle = '#111'; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(px + Math.cos(hh.facing) * r * 1.3, py + Math.sin(hh.facing) * r * 1.3); ctx.stroke();
    if (cur!.artifact?.carrier === hh.id) drawArtifact(hh.x, hh.y - .7, performance.now());
    if (nowSim < hh.stunnedUntil) { ctx.fillStyle = '#fff'; ctx.font = '12px system-ui'; ctx.textAlign = 'center'; ctx.fillText('✦ ✦', px, py - r - 18); }
    ctx.fillStyle = '#fff'; ctx.font = '11px system-ui'; ctx.textAlign = 'center'; ctx.fillText(hh.name, px, py - r - 9);
    bar(px, py - r - 6, hh.hp / hh.maxHp, '#5fc68a', 26);
    ctx.globalAlpha = 1;
  }
  function bar(cx: number, y: number, frac: number, color: string, w: number) {
    ctx.fillStyle = '#000a'; ctx.fillRect(cx - w / 2, y, w, 4); ctx.fillStyle = color; ctx.fillRect(cx - w / 2, y, w * Math.max(0, Math.min(1, frac)), 4);
  }
  function drawFog(W: number, H: number, vision: { x: number; y: number; r: number }[]) {
    const f = fogLayer.getContext('2d')!;
    f.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
    f.globalCompositeOperation = 'source-over';
    f.fillStyle = '#07070b'; f.fillRect(0, 0, W, H);
    f.save(); f.translate(W / 2, H / 2); f.scale(cam.scale, cam.scale); f.translate(-cam.x * TILE_PX, -cam.y * TILE_PX);
    const x0 = Math.max(0, Math.floor(cam.x - W / 2 / TILE_PX / cam.scale) - 1), x1 = Math.min(map.w - 1, Math.ceil(cam.x + W / 2 / TILE_PX / cam.scale) + 1);
    const y0 = Math.max(0, Math.floor(cam.y - H / 2 / TILE_PX / cam.scale) - 1), y1 = Math.min(map.h - 1, Math.ceil(cam.y + H / 2 / TILE_PX / cam.scale) + 1);
    f.fillStyle = 'rgba(7,7,11,.62)';
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (explored[y * map.w + x]) { f.clearRect(x * TILE_PX, y * TILE_PX, TILE_PX, TILE_PX); f.fillRect(x * TILE_PX, y * TILE_PX, TILE_PX, TILE_PX); }
    f.globalCompositeOperation = 'destination-out';
    for (const e of vision) {
      const g = f.createRadialGradient(e.x * TILE_PX, e.y * TILE_PX, e.r * TILE_PX * .7, e.x * TILE_PX, e.y * TILE_PX, e.r * TILE_PX);
      g.addColorStop(0, 'rgba(0,0,0,1)'); g.addColorStop(1, 'rgba(0,0,0,0)');
      f.fillStyle = g; f.beginPath(); f.arc(e.x * TILE_PX, e.y * TILE_PX, e.r * TILE_PX, 0, 7); f.fill();
    }
    f.restore();
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.drawImage(fogLayer, 0, 0); ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
  }

  // ── HUD ──
  let lastHud = 0;
  function renderHud(meHero: any) {
    const now = performance.now();
    for (let i = feedLines.length - 1; i >= 0; i--) if (feedLines[i].until < now) { feedLines[i].el.remove(); feedLines.splice(i, 1); }
    if (now - lastHud < 100 || !cur) return; lastHud = now;
    const timeLeft = start.endsAt - cur.now;
    const parts: Node[] = [
      h('span', { class: 'muted' }, `Runde ${start.round}/${start.rounds} · Kerker: `, h('b', { style: { color: start.kerkerTeam.color } }, start.kerkerTeam.name)),
      h('span', {}, '⏱ ', h('b', { style: { color: timeLeft < 60000 ? 'var(--red)' : 'inherit' } }, fmtTime(timeLeft))), h('span', {}, '♥ Leben ', h('b', {}, String(cur.lives)))];
    if (isKerker) parts.push(h('span', { class: 'row' }, '✦ Mana ', h('b', {}, String(cur.mana ?? 0)), h('span', { class: 'bar mana' }, h('i', { style: { width: `${(cur.mana ?? 0) / 2}%` } }))));
    else if (meHero) {
      const cls = (HERO_CLASSES as any)[meHero.cls];
      const cd = Math.max(0, meHero.abilityReadyAt - cur.now);
      parts.push(h('span', { class: 'row' }, h('span', { class: 'bar' }, h('i', { style: { width: `${100 * meHero.hp / meHero.maxHp}%` } })), `${meHero.hp}/${meHero.maxHp}`));
      parts.push(h('span', {}, `${cls.ability.name}: `, h('b', { style: { color: cd ? 'var(--text2)' : 'var(--green)' } }, cd ? `${(cd / 1000).toFixed(1)}s` : 'bereit')));
      if (cur.artifact?.carrier === me.id) parts.push(h('b', { style: { color: 'var(--accent)' } }, 'Du trägst das Artefakt — zum Ausgang!'));
    }
    hudTop.replaceChildren(...parts);
    hudLeft.replaceChildren(...cur.heroes.map((hh: any) => h('div', { class: 'row', style: { opacity: hh.alive ? 1 : .5 } },
      h('span', { style: { color: CLASS_COLOR[hh.cls] } }, '●'), h('span', { style: { color: teamColor(hh.id) } }, hh.name), h('span', { class: 'bar', style: { width: '70px' } }, h('i', { style: { width: `${100 * hh.hp / hh.maxHp}%` } })),
      cur!.artifact?.carrier === hh.id ? h('span', { style: { color: 'var(--accent)' } }, '◆') : null)));
    if (isKerker) renderCards();
  }
  function renderCards() {
    if (!isKerker) return;
    cards.replaceChildren(...KERKER_CARD_IDS.map((id, i) => {
      const def = (KERKER_CARDS as any)[id];
      return h('button', { class: 'cardbtn' + (selectedCard === id ? ' active' : '') + ((cur?.mana ?? 0) < def.cost ? ' poor' : ''), onclick: () => { selectedCard = selectedCard === id ? null : id; renderCards(); } },
        h('b', {}, `${i + 1} ${def.name}`), h('small', {}, `${def.cost} Mana`), h('div', { class: 'muted' }, cardHint(id)));
    }));
  }

  raf = requestAnimationFrame(frame);

  return {
    showOver(result: any, lobbyState: any) {
      over = result;
      keys.clear();
      const youWon = (result.winner === 'heroes') !== isKerker;
      const rows = [...(result.heroes || []).map((p: any) => h('tr', {}, h('td', {}, p.name), h('td', {}, (HERO_CLASSES as any)[p.cls]?.name || ''), h('td', {}, String(p.kills)), h('td', {}, String(p.deaths)))),
        ...(result.kerkers || []).map((p: any) => h('tr', {}, h('td', {}, p.name), h('td', {}, 'Kerker'), h('td', {}, `${p.kills} Kills`), h('td', {}, `${p.placed} gesetzt`)))];
      root.append(h('div', { class: 'overlay' }, h('div', { class: 'card' },
        h('h1', { style: { color: result.winner ? (youWon ? 'var(--green)' : 'var(--red)') : 'inherit' } }, result.winner === 'heroes' ? 'Die Helden entkommen!' : result.winner === 'kerker' ? 'Der Kerker behält alles.' : 'Match beendet'),
        h('p', { class: 'muted' }, reasonText(result.reason) + ` Dauer ${fmtTime(result.durationMs || 0)}.`),
        lobbyState?.teams ? h('div', { class: 'row', style: { gap: '14px', marginBottom: '10px' } }, ...lobbyState.teams.map((t: any) => h('span', { style: { color: t.color } }, `${t.name} ${t.points}`))) : null,
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

function drawTiles(c: CanvasRenderingContext2D, map: any) {
  for (let y = 0; y < map.h; y++) for (let x = 0; x < map.w; x++) {
    const wall = isWall(map, x, y);
    const px = x * TILE_PX, py = y * TILE_PX;
    if (wall) {
      c.fillStyle = '#1f1f2e'; c.fillRect(px, py, TILE_PX, TILE_PX);
      // Kante zu Bodenkacheln hin heller
      const edge = [[0, 1], [0, -1], [1, 0], [-1, 0]].some(([dx, dy]) => !isWall(map, x + dx, y + dy));
      if (edge) { c.fillStyle = '#2c2c40'; c.fillRect(px + 2, py + 2, TILE_PX - 4, TILE_PX - 4); }
    } else {
      const v = ((x * 7 + y * 13) % 5) * 3;
      c.fillStyle = `rgb(${58 + v},${52 + v},${48 + v})`; c.fillRect(px, py, TILE_PX, TILE_PX);
      c.strokeStyle = 'rgba(0,0,0,.18)'; c.strokeRect(px + .5, py + .5, TILE_PX - 1, TILE_PX - 1);
    }
  }
}
