// 2D-Canvas-Renderer als Fallback (kein WebGL oder ?renderer=2d).
import { TILE_PX, KERKER_CARDS, HERO_VISION, NEBEL_VISION, MONSTERS } from '@tlg/shared';
import { drawTiles, torchSpots, Particles, drawHeroFigure, drawMonsterFigure, drawWallBlock, drawTrapIcon, drawArtifact, drawExit, drawEntrance, drawZone } from './render';
import type { GameRenderer, View } from './renderer';
import { errText, fmtTime } from '../ui';

const T = TILE_PX;

export class Renderer2D implements GameRenderer {
  private ctx: CanvasRenderingContext2D;
  private tileLayer = document.createElement('canvas');
  private fogLayer = document.createElement('canvas');
  private torches: { x: number; y: number }[];
  private particles = new Particles();
  private fx: { until: number; draw: (c: CanvasRenderingContext2D, k: number) => void }[] = [];
  private floaters: { x: number; y: number; text: string; color: string; born: number }[] = [];
  private wallBorn = new Map<number, number>();
  private lastPos = new Map<string, { x: number; y: number }>();
  private cam = { x: 0, y: 0, scale: 1 };
  private now = 0;

  constructor(private container: HTMLElement, private canvas: HTMLCanvasElement, private map: any, private isKerker: boolean) {
    this.ctx = canvas.getContext('2d')!;
    this.tileLayer.width = map.w * T; this.tileLayer.height = map.h * T;
    drawTiles(this.tileLayer.getContext('2d')!, map);
    this.torches = torchSpots(map);
    this.cam.x = map.entrance.x + .5; this.cam.y = map.entrance.y + .5;
    this.resize();
  }
  resize() {
    this.canvas.width = this.container.clientWidth * devicePixelRatio; this.canvas.height = this.container.clientHeight * devicePixelRatio;
    this.fogLayer.width = this.canvas.width; this.fogLayer.height = this.canvas.height;
    if (this.isKerker) this.cam.scale = Math.min((this.container.clientWidth - 20) / (this.map.w * T), (this.container.clientHeight - 170) / (this.map.h * T));
  }
  wheel() {} pan() {}
  screenToWorld(sx: number, sy: number) {
    const W = this.container.clientWidth, H = this.container.clientHeight;
    return { x: (sx - W / 2) / (this.cam.scale * T) + this.cam.x, y: (sy - H / 2) / (this.cam.scale * T) + this.cam.y };
  }
  private moving(id: string, x: number, y: number) { const l = this.lastPos.get(id); this.lastPos.set(id, { x, y }); return !!l && (Math.abs(l.x - x) > 0.002 || Math.abs(l.y - y) > 0.002); }

  frame(v: View) {
    const { cur, now, dt } = v; this.now = now; const ctx = this.ctx, map = this.map, cam = this.cam;
    this.particles.step(dt);
    const W = this.container.clientWidth, H = this.container.clientHeight;
    ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
    ctx.fillStyle = '#07070b'; ctx.fillRect(0, 0, W, H);
    for (const w of cur.walls) if (!this.wallBorn.has(w.id)) this.wallBorn.set(w.id, now);
    if (this.isKerker) { cam.x = map.w / 2; cam.y = map.h / 2 + 30 / (cam.scale * T); }
    else if (v.meHero) { cam.x += (v.meHero.x - cam.x) * 0.25; cam.y += (v.meHero.y - cam.y) * 0.25; cam.scale = 1; }
    const sx = v.shake ? (Math.random() - .5) * v.shake : 0, sy = v.shake ? (Math.random() - .5) * v.shake : 0;
    ctx.save();
    ctx.translate(W / 2 + sx, H / 2 + sy); ctx.scale(cam.scale, cam.scale); ctx.translate(-cam.x * T, -cam.y * T);
    ctx.drawImage(this.tileLayer, 0, 0);
    for (const tr of this.torches) {
      const fl = 0.85 + Math.sin(now / 90 + tr.x * 7) * 0.08 + Math.random() * 0.07;
      const g = ctx.createRadialGradient(tr.x * T, tr.y * T, 2, tr.x * T, tr.y * T, T * 2.2 * fl);
      g.addColorStop(0, 'rgba(255,170,70,.28)'); g.addColorStop(1, 'rgba(255,120,40,0)');
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(tr.x * T, tr.y * T, T * 2.2 * fl, 0, 7); ctx.fill();
      ctx.fillStyle = '#ffb34a'; ctx.beginPath(); ctx.arc(tr.x * T, tr.y * T - 2, 2.2, 0, 7); ctx.fill();
    }
    drawEntrance(ctx, map.entrance); drawExit(ctx, map.exit, now);
    for (const z of cur.zones) drawZone(ctx, z, now);
    for (const tr of cur.traps) drawTrapIcon(ctx, tr, now, this.isKerker && !tr.revealed);
    for (const w of cur.walls) drawWallBlock(ctx, w, now, now - (this.wallBorn.get(w.id) ?? now));
    if (cur.artifact && cur.artifact.carrier === null) { drawArtifact(ctx, cur.artifact.x, cur.artifact.y, now); if (Math.random() < 0.15) this.particles.burst(cur.artifact.x, cur.artifact.y, 1, '#ffe08a', 0.8, 900, 1.5, -1.5, true); }
    const drawables: { y: number; draw: () => void }[] = [];
    for (const m of v.monsters) drawables.push({ y: m.y, draw: () => drawMonsterFigure(ctx, m, now, this.moving('m' + m.id, m.x, m.y)) });
    for (const hh of v.heroes) drawables.push({ y: hh.y, draw: () => this.drawHero(v, hh) });
    drawables.sort((a, b) => a.y - b.y).forEach(d => d.draw());
    for (const p of v.projectiles) {
      const pp = v.prev?.projectiles.find((q: any) => q.id === p.id);
      ctx.strokeStyle = 'rgba(255,226,138,.5)'; ctx.lineWidth = 3; ctx.lineCap = 'round';
      if (pp) { ctx.beginPath(); ctx.moveTo(pp.x * T, pp.y * T); ctx.lineTo(p.x * T, p.y * T); ctx.stroke(); }
      ctx.shadowColor = '#ffe28a'; ctx.shadowBlur = 8; ctx.fillStyle = '#fff3c0'; ctx.beginPath(); ctx.arc(p.x * T, p.y * T, 3.5, 0, 7); ctx.fill(); ctx.shadowBlur = 0;
    }
    this.particles.draw(ctx);
    for (let i = this.fx.length - 1; i >= 0; i--) { if (this.fx[i].until < now) this.fx.splice(i, 1); else this.fx[i].draw(ctx, Math.max(0, Math.min(1, 1 - (this.fx[i].until - now) / 600))); }
    for (let i = this.floaters.length - 1; i >= 0; i--) {
      const f = this.floaters[i]; const age = now - f.born; if (age > 900) { this.floaters.splice(i, 1); continue; }
      ctx.globalAlpha = 1 - age / 900; ctx.fillStyle = f.color; ctx.font = 'bold 13px system-ui'; ctx.textAlign = 'center';
      ctx.strokeStyle = 'rgba(0,0,0,.8)'; ctx.lineWidth = 3; ctx.strokeText(f.text, f.x * T, f.y * T - age / 30); ctx.fillText(f.text, f.x * T, f.y * T - age / 30); ctx.globalAlpha = 1;
    }
    if (this.isKerker) {
      for (const hh of v.heroes) if (hh.alive) { const r = cur.zones.some((z: any) => Math.hypot(z.x - hh.x, z.y - hh.y) <= z.r) ? NEBEL_VISION : HERO_VISION; ctx.strokeStyle = 'rgba(90,169,230,.22)'; ctx.setLineDash([6, 6]); ctx.lineDashOffset = -now / 80; ctx.beginPath(); ctx.arc(hh.x * T, hh.y * T, r * T, 0, 7); ctx.stroke(); ctx.setLineDash([]); ctx.fillStyle = 'rgba(90,169,230,.05)'; ctx.fill(); }
      if (v.ghost) {
        const { tx, ty, bad, card } = v.ghost;
        ctx.fillStyle = bad ? 'rgba(224,83,79,.4)' : 'rgba(95,198,138,.4)'; ctx.fillRect(tx * T, ty * T, T, T);
        ctx.strokeStyle = bad ? '#e0534f' : '#5fc68a'; ctx.lineWidth = 2; ctx.strokeRect(tx * T + 1, ty * T + 1, T - 2, T - 2);
        const def = (KERKER_CARDS as any)[card];
        if (def.kind === 'zone') { ctx.strokeStyle = 'rgba(167,123,224,.6)'; ctx.setLineDash([4, 4]); ctx.beginPath(); ctx.arc((tx + .5) * T, (ty + .5) * T, def.radius * T, 0, 7); ctx.stroke(); ctx.setLineDash([]); }
        if (bad) { ctx.fillStyle = '#ffb3b0'; ctx.font = 'bold 11px system-ui'; ctx.textAlign = 'center'; ctx.fillText(errText(bad), (tx + .5) * T, ty * T - 6); }
      }
    }
    ctx.restore();
    if (!this.isKerker) this.drawFog(W, H, v);
  }
  private drawHero(v: View, hh: any) {
    const ctx = this.ctx, cur = v.cur, now = this.now; const px = hh.x * T, py = hh.y * T, r = 0.35 * T;
    if (!hh.alive) {
      ctx.globalAlpha = .4; ctx.fillStyle = '#9a9ab0'; ctx.beginPath(); ctx.arc(px, py, r, 0, 7); ctx.fill();
      ctx.strokeStyle = '#ccc'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(px - 5, py - 5); ctx.lineTo(px + 5, py + 5); ctx.moveTo(px + 5, py - 5); ctx.lineTo(px - 5, py + 5); ctx.stroke();
      ctx.globalAlpha = 1; ctx.fillStyle = '#ddd'; ctx.font = '12px system-ui'; ctx.textAlign = 'center'; ctx.fillText(hh.respawnAt ? `⟲ ${fmtTime(hh.respawnAt - cur.now)}` : '✝', px, py - r - 10); return;
    }
    if (cur.now < hh.invisibleUntil) ctx.globalAlpha = .4;
    drawHeroFigure(ctx, hh, now, this.moving(hh.id, hh.x, hh.y), cur.artifact?.carrier === hh.id, hh.id === v.meId);
    if (cur.now < hh.stunnedUntil) for (let i = 0; i < 3; i++) { const a = now / 300 + i * 2.1; ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(px + Math.cos(a) * 10, py - r - 14 + Math.sin(a) * 3, 2, 0, 7); ctx.fill(); }
    const tc = v.teamColor(hh.id);
    ctx.font = 'bold 11px system-ui'; ctx.textAlign = 'center'; ctx.strokeStyle = 'rgba(0,0,0,.8)'; ctx.lineWidth = 3; ctx.strokeText(hh.name, px, py - r - 12); ctx.fillStyle = tc === 'inherit' ? '#fff' : tc; ctx.fillText(hh.name, px, py - r - 12);
    ctx.fillStyle = 'rgba(0,0,0,.7)'; ctx.fillRect(px - 15, py - r - 10, 30, 6); ctx.fillStyle = hh.hp / hh.maxHp < 0.3 ? '#e0534f' : '#5fc68a'; ctx.fillRect(px - 14, py - r - 9, 28 * Math.max(0, hh.hp / hh.maxHp), 4);
    ctx.globalAlpha = 1;
  }
  private drawFog(W: number, H: number, v: View) {
    const f = this.fogLayer.getContext('2d')!, cam = this.cam, map = this.map, ctx = this.ctx;
    f.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
    f.globalCompositeOperation = 'source-over'; f.fillStyle = '#07070b'; f.fillRect(0, 0, W, H);
    f.save(); f.translate(W / 2, H / 2); f.scale(cam.scale, cam.scale); f.translate(-cam.x * T, -cam.y * T);
    const x0 = Math.max(0, Math.floor(cam.x - W / 2 / T / cam.scale) - 1), x1 = Math.min(map.w - 1, Math.ceil(cam.x + W / 2 / T / cam.scale) + 1);
    const y0 = Math.max(0, Math.floor(cam.y - H / 2 / T / cam.scale) - 1), y1 = Math.min(map.h - 1, Math.ceil(cam.y + H / 2 / T / cam.scale) + 1);
    f.fillStyle = 'rgba(7,7,11,.7)';
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (v.explored[y * map.w + x]) { f.clearRect(x * T, y * T, T, T); f.fillRect(x * T, y * T, T, T); }
    f.globalCompositeOperation = 'destination-out';
    for (const e of v.vision) { const g = f.createRadialGradient(e.x * T, e.y * T, e.r * T * .55, e.x * T, e.y * T, e.r * T); g.addColorStop(0, 'rgba(0,0,0,1)'); g.addColorStop(1, 'rgba(0,0,0,0)'); f.fillStyle = g; f.beginPath(); f.arc(e.x * T, e.y * T, e.r * T, 0, 7); f.fill(); }
    f.restore();
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.drawImage(this.fogLayer, 0, 0); ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
    if (v.meHero?.alive) { const cx = W / 2 + (v.meHero.x - cam.x) * T, cy = H / 2 + (v.meHero.y - cam.y) * T; const g = ctx.createRadialGradient(cx, cy, 10, cx, cy, T * 5); g.addColorStop(0, 'rgba(255,200,120,.10)'); g.addColorStop(1, 'rgba(255,200,120,0)'); ctx.fillStyle = g; ctx.fillRect(0, 0, W, H); }
  }
  event(ev: any, heroAt: (id: string) => any) {
    const P = this.particles, now = this.now;
    const floater = (x: number, y: number, text: string, color: string) => this.floaters.push({ x, y, text, color, born: now });
    switch (ev.t) {
      case 'swing': this.fx.push({ until: now + 140, draw: (c, k) => { c.strokeStyle = `rgba(255,255,255,${0.8 * (1 - k)})`; c.lineWidth = 4 * (1 - k) + 1; c.beginPath(); c.arc(ev.x * T, ev.y * T, ev.range * T * (0.6 + 0.4 * k), ev.facing - 1, ev.facing + 1); c.stroke(); } }); break;
      case 'hit': P.burst(ev.x, ev.y, 7, '#ffd36b', 3, 350, 2.2, 0, true); floater(ev.x, ev.y - 0.3, `-${ev.dmg}`, '#ffd36b'); break;
      case 'hero_hit': { const hh = heroAt(ev.hero); if (hh) { P.burst(hh.x, hh.y, 6, '#e0534f', 2.5, 300, 2); floater(hh.x, hh.y - 0.4, `-${ev.dmg}`, '#ff8a85'); } break; }
      case 'trap': P.burst(ev.tx + .5, ev.ty + .5, 18, ev.type === 'stachel' ? '#d8d8e8' : '#4a3a2a', 4, 500, 2.5, 6); this.fx.push({ until: now + 400, draw: (c, k) => { c.strokeStyle = `rgba(224,83,79,${1 - k})`; c.lineWidth = 3; c.strokeRect(ev.tx * T + 2 - k * 6, ev.ty * T + 2 - k * 6, T - 4 + k * 12, T - 4 + k * 12); } }); break;
      case 'hero_dead': P.burst(ev.x, ev.y, 30, '#b8302c', 4, 700, 3, 8); P.burst(ev.x, ev.y, 12, '#ffffff', 2, 500, 1.5, 0, true); break;
      case 'respawn': P.burst(this.map.entrance.x + .5, this.map.entrance.y + .5, 20, '#9fd8ff', 3, 600, 2, -4, true); break;
      case 'artifact_pick': { const hh = heroAt(ev.hero); if (hh) P.burst(hh.x, hh.y, 24, '#ffd86b', 3, 700, 2.5, -2, true); break; }
      case 'monster_dead': P.burst(ev.x, ev.y, 22, ev.type === 'brecher' ? '#7a1f1f' : '#c0392b', 4, 600, 3, 8); break;
      case 'wall_hit': P.burst(ev.tx + .5, ev.ty + .5, 5, '#a07a50', 3, 300, 2, 8); break;
      case 'wall_broken': P.burst(ev.tx + .5, ev.ty + .5, 26, '#8a6a46', 4, 700, 3, 9); break;
      case 'reveal': P.burst(ev.tx + .5, ev.ty + .5, 14, '#c9a6ff', 2, 600, 2, -2, true); break;
      case 'ability':
        if (ev.id === 'heilkreis') { this.fx.push({ until: now + 600, draw: (c, k) => { c.strokeStyle = `rgba(244,213,107,${1 - k})`; c.lineWidth = 3; c.beginPath(); c.arc(ev.x * T, ev.y * T, 4 * T * k, 0, 7); c.stroke(); } }); P.burst(ev.x, ev.y, 30, '#fff0a0', 3, 800, 2, -3, true); }
        if (ev.id === 'schildstoss') P.burst(ev.x, ev.y, 12, '#cfd6e6', 3, 400, 2);
        if (ev.id === 'spuersinn') this.fx.push({ until: now + 500, draw: (c, k) => { c.strokeStyle = `rgba(180,138,232,${1 - k})`; c.lineWidth = 2; c.beginPath(); c.arc(ev.x * T, ev.y * T, 6 * T * k, 0, 7); c.stroke(); } });
        break;
      case 'place': if (this.isKerker) P.burst(ev.tx + .5, ev.ty + .5, 12, '#c9a6ff', 2.5, 450, 2, 0, true); break;
    }
    void MONSTERS;
  }
  dispose() {}
}
