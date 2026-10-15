// ═══════════════════════════════════════════════════════════════════════
//  KERKER — Spiel-Engine. Rein, deterministisch, ohne Timer und ohne Sockets.
//  Der Worker ruft step(state, dt) auf; Eingaben kommen über applyInput /
//  placeCard. snapshotFor() ist die EINZIGE Stelle, die Zustand an Clients
//  herausgibt — und filtert pro Rolle (Helden sehen nie versteckte Fallen,
//  nie Monster außer Sicht, nie Kerker-Mana).
// ═══════════════════════════════════════════════════════════════════════
import {
  TILE, ROLE, HERO_CLASSES, HERO_RADIUS, HERO_VISION, NEBEL_VISION, CARRIER_SPEED_MUL,
  RESPAWN_MS, LIVES_PER_HERO, KERKER_MANA_START, KERKER_MANA_MAX, KERKER_MANA_PER_KILL,
  kerkerManaRegenPerSec, MIN_PLACE_DIST, MIN_SPAWN_DIST, MAX_WALLS, MAX_MONSTERS, MAX_TRAPS,
  WALL_HP, KERKER_CARDS, MONSTERS, PROJECTILE_RADIUS, DEFAULT_SETTINGS,
  generateMap, serializeMap, idx, isWall, inBounds, hasPath, findPath, lineOfSight,
  dist, clamp, angleDiff, moveCircle, circleBlocked, makeRng,
} from '@tlg/shared';

const MONSTER_REPATH_MS = 400;
const MONSTER_LEASH = 14;

export function createMatch({ seed, players, settings = {} }) {
  const cfg = { ...DEFAULT_SETTINGS, ...settings };
  const map = generateMap(seed);
  const heroes = new Map(), kerkers = new Map();
  for (const p of players) {
    if (p.role === ROLE.KERKER) kerkers.set(p.id, { id: p.id, name: p.name, mana: KERKER_MANA_START, placed: 0, kills: 0 });
    else heroes.set(p.id, makeHero(p, map));
  }
  const heroCount = heroes.size;
  return {
    seed, map, cfg, now: 0, tick: 0, phase: 'running', result: null,
    endsAt: cfg.durationMin * 60000,
    heroes, kerkers,
    lives: heroCount * LIVES_PER_HERO,
    manaRegen: kerkerManaRegenPerSec(heroCount) / Math.max(1, kerkers.size),
    monsters: new Map(), traps: new Map(), walls: new Map(), projectiles: new Map(), zones: new Map(),
    artifact: { x: map.artifact.x + 0.5, y: map.artifact.y + 0.5, carrier: null },
    nextId: 1, events: [], rng: makeRng(seed ^ 0x9e3779b9),
    inputs: new Map(),
  };
}

function makeHero(p, map) {
  const cls = HERO_CLASSES[p.cls] ? p.cls : 'krieger';
  const c = HERO_CLASSES[cls];
  return {
    id: p.id, name: p.name, cls, x: map.entrance.x + 0.5, y: map.entrance.y + 0.5,
    hp: c.hp, maxHp: c.hp, facing: 0, alive: true, respawnAt: 0,
    attackReadyAt: 0, abilityReadyAt: 0, stunnedUntil: 0, invisibleUntil: 0,
    dashUntil: 0, dashDx: 0, dashDy: 0, kills: 0, deaths: 0,
  };
}

// ── Eingaben ───────────────────────────────────────────────────────────
/** input: { mx, my ∈ [-1,1], aimX, aimY (Welt, Kacheln), attack, ability } */
export function applyInput(state, playerId, input) {
  if (!state.heroes.has(playerId)) return;
  const mx = clamp(+input.mx || 0, -1, 1), my = clamp(+input.my || 0, -1, 1);
  state.inputs.set(playerId, {
    mx, my,
    aimX: Number.isFinite(+input.aimX) ? +input.aimX : null,
    aimY: Number.isFinite(+input.aimY) ? +input.aimY : null,
    attack: !!input.attack, ability: !!input.ability,
  });
}

const blockedFn = (state) => (x, y) => isWall(state.map, x, y) || state.wallIdx.has(idx(state.map.w, x, y));
function rebuildWallIdx(state) {
  state.wallIdx = new Set();
  for (const w of state.walls.values()) state.wallIdx.add(idx(state.map.w, w.tx, w.ty));
}

/** Kerker setzt eine Karte. Liefert { ok } oder { ok:false, error }. */
export function placeCard(state, playerId, { card, tx, ty }) {
  const k = state.kerkers.get(playerId);
  if (!k) return { ok: false, error: 'not_kerker' };
  if (state.phase !== 'running') return { ok: false, error: 'not_running' };
  const def = KERKER_CARDS[card];
  if (!def) return { ok: false, error: 'unknown_card' };
  tx = Math.floor(+tx); ty = Math.floor(+ty);
  if (!inBounds(state.map, tx, ty)) return { ok: false, error: 'out_of_bounds' };
  if (!state.wallIdx) rebuildWallIdx(state);
  const blocked = blockedFn(state);
  if (blocked(tx, ty)) return { ok: false, error: 'not_floor' };
  const m = state.map;
  const isSpecial = (p) => p.x === tx && p.y === ty;
  if (isSpecial(m.entrance) || isSpecial(m.exit) || isSpecial(m.artifact)) return { ok: false, error: 'reserved_tile' };
  if (state.artifact.carrier === null && Math.floor(state.artifact.x) === tx && Math.floor(state.artifact.y) === ty) return { ok: false, error: 'reserved_tile' };
  if (k.mana < def.cost) return { ok: false, error: 'no_mana' };

  const minDist = def.kind === 'monster' ? MIN_SPAWN_DIST : MIN_PLACE_DIST;
  for (const h of state.heroes.values()) {
    if (h.alive && dist(h.x, h.y, tx + 0.5, ty + 0.5) < minDist) return { ok: false, error: 'too_close' };
  }
  const occupied = [...state.traps.values()].some(t => t.tx === tx && t.ty === ty)
    || [...state.monsters.values()].some(mo => Math.floor(mo.x) === tx && Math.floor(mo.y) === ty);
  if (occupied && def.kind !== 'zone') return { ok: false, error: 'occupied' };

  const id = state.nextId++;
  if (def.kind === 'trap') {
    if (state.traps.size >= MAX_TRAPS) return { ok: false, error: 'limit' };
    state.traps.set(id, { id, type: card, tx, ty, revealed: false });
  } else if (def.kind === 'wall') {
    if (state.walls.size >= MAX_WALLS) return { ok: false, error: 'limit' };
    for (const h of state.heroes.values()) if (h.alive && circleBlocked(h.x, h.y, HERO_RADIUS, (x, y) => x === tx && y === ty)) return { ok: false, error: 'occupied' };
    const test = (x, y) => blocked(x, y) || (x === tx && y === ty);
    // Nie den Kerker versiegeln: Eingang→Ausgang, Eingang→Artefakt, jeder Held→Ausgang.
    if (!hasPath(m, m.entrance, m.exit, test) || !hasPath(m, m.entrance, m.artifact, test)) return { ok: false, error: 'would_seal' };
    for (const h of state.heroes.values()) {
      if (!h.alive) continue;
      if (!hasPath(m, { x: Math.floor(h.x), y: Math.floor(h.y) }, m.exit, test)) return { ok: false, error: 'would_seal' };
    }
    state.walls.set(id, { id, tx, ty, hp: WALL_HP });
    rebuildWallIdx(state);
    for (const mo of state.monsters.values()) mo.path = null;
  } else if (def.kind === 'monster') {
    if (state.monsters.size >= MAX_MONSTERS) return { ok: false, error: 'limit' };
    const md = MONSTERS[def.monster];
    state.monsters.set(id, { id, type: def.monster, x: tx + 0.5, y: ty + 0.5, hp: md.hp, maxHp: md.hp, target: null, path: null, repathAt: 0, attackReadyAt: 0, home: { x: tx + 0.5, y: ty + 0.5 } });
  } else if (def.kind === 'zone') {
    state.zones.set(id, { id, type: card, x: tx + 0.5, y: ty + 0.5, r: def.radius, until: state.now + def.durationMs });
  }
  k.mana -= def.cost; k.placed++;
  state.events.push({ t: 'place', card, tx, ty, by: playerId });
  return { ok: true, id };
}

// ── Simulation ─────────────────────────────────────────────────────────
export function step(state, dt) {
  if (state.phase !== 'running') return [];
  if (!state.wallIdx) rebuildWallIdx(state);
  state.events = [];
  state.now += dt; state.tick++;
  const s = dt / 1000;
  const blocked = blockedFn(state);

  for (const k of state.kerkers.values()) k.mana = Math.min(KERKER_MANA_MAX, k.mana + state.manaRegen * s);
  for (const z of [...state.zones.values()]) if (z.until <= state.now) state.zones.delete(z.id);

  for (const h of state.heroes.values()) stepHero(state, h, s, blocked);
  stepProjectiles(state, s, blocked);
  for (const mo of [...state.monsters.values()]) stepMonster(state, mo, s, blocked);
  for (const h of state.heroes.values()) if (h.alive) checkTraps(state, h);
  checkArtifact(state);
  checkEnd(state);
  return state.events;
}

function heroSpeed(state, h) {
  let v = HERO_CLASSES[h.cls].speed;
  if (state.artifact.carrier === h.id) v *= CARRIER_SPEED_MUL;
  return v;
}

function stepHero(state, h, s, blocked) {
  if (!h.alive) {
    if (h.respawnAt && state.now >= h.respawnAt) {
      h.alive = true; h.hp = h.maxHp; h.x = state.map.entrance.x + 0.5; h.y = state.map.entrance.y + 0.5;
      h.respawnAt = 0; h.stunnedUntil = 0;
      state.events.push({ t: 'respawn', hero: h.id });
    }
    return;
  }
  const inp = state.inputs.get(h.id);
  const c = HERO_CLASSES[h.cls];
  if (inp && inp.aimX !== null) h.facing = Math.atan2(inp.aimY - h.y, inp.aimX - h.x);

  if (state.now < h.dashUntil) {
    const sp = c.ability.dashTiles / 0.2;
    const p = moveCircle(h.x, h.y, h.dashDx * sp * s, h.dashDy * sp * s, HERO_RADIUS, blocked);
    h.x = p.x; h.y = p.y;
    for (const mo of state.monsters.values()) {
      if (dist(mo.x, mo.y, h.x, h.y) < HERO_RADIUS + MONSTERS[mo.type].radius + 0.2 && !mo.pushedBy?.has?.(h.dashUntil)) {
        mo.pushedBy = mo.pushedBy || new Set(); mo.pushedBy.add(h.dashUntil);
        damageMonster(state, mo, c.ability.dmg, h);
        const p2 = moveCircle(mo.x, mo.y, h.dashDx * c.ability.push, h.dashDy * c.ability.push, MONSTERS[mo.type].radius, blocked);
        mo.x = p2.x; mo.y = p2.y;
      }
    }
    return;
  }
  if (state.now < h.stunnedUntil || !inp) return;

  let mx = inp.mx, my = inp.my;
  const len = Math.hypot(mx, my);
  if (len > 1) { mx /= len; my /= len; }
  if (len > 0) {
    const v = heroSpeed(state, h) * s;
    const p = moveCircle(h.x, h.y, mx * v, my * v, HERO_RADIUS, blocked);
    h.x = p.x; h.y = p.y;
  }
  if (inp.attack && state.now >= h.attackReadyAt) heroAttack(state, h, c);
  if (inp.ability && state.now >= h.abilityReadyAt) heroAbility(state, h, c, blocked);
}

function heroAttack(state, h, c) {
  const a = c.attack;
  h.attackReadyAt = state.now + a.cd;
  if (a.kind === 'melee') {
    state.events.push({ t: 'swing', hero: h.id, x: h.x, y: h.y, facing: h.facing, range: a.range });
    for (const mo of state.monsters.values()) {
      if (dist(mo.x, mo.y, h.x, h.y) > a.range + MONSTERS[mo.type].radius) continue;
      if (Math.abs(angleDiff(Math.atan2(mo.y - h.y, mo.x - h.x), h.facing)) > a.arc) continue;
      damageMonster(state, mo, a.dmg, h);
    }
    for (const w of [...state.walls.values()]) {
      if (dist(w.tx + 0.5, w.ty + 0.5, h.x, h.y) > a.range + 0.5) continue;
      if (Math.abs(angleDiff(Math.atan2(w.ty + 0.5 - h.y, w.tx + 0.5 - h.x), h.facing)) > a.arc) continue;
      damageWall(state, w, a.wallDmg);
    }
  } else {
    spawnProjectile(state, h, h.facing, a);
  }
}

function spawnProjectile(state, h, angle, a) {
  const id = state.nextId++;
  state.projectiles.set(id, {
    id, owner: h.id, x: h.x + Math.cos(angle) * 0.4, y: h.y + Math.sin(angle) * 0.4,
    vx: Math.cos(angle) * a.speed, vy: Math.sin(angle) * a.speed, dmg: a.dmg, wallDmg: a.wallDmg,
    left: a.range,
  });
}

function heroAbility(state, h, c, blocked) {
  const ab = c.ability;
  h.abilityReadyAt = state.now + ab.cd;
  state.events.push({ t: 'ability', hero: h.id, id: ab.id, x: h.x, y: h.y });
  switch (ab.id) {
    case 'schildstoss':
      h.dashUntil = state.now + 200; h.dashDx = Math.cos(h.facing); h.dashDy = Math.sin(h.facing);
      break;
    case 'salve':
      for (let i = 0; i < ab.count; i++) spawnProjectile(state, h, h.facing - ab.spread / 2 + ab.spread * i / (ab.count - 1), c.attack);
      break;
    case 'heilkreis':
      for (const o of state.heroes.values()) if (o.alive && dist(o.x, o.y, h.x, h.y) <= ab.radius) o.hp = Math.min(o.maxHp, o.hp + ab.heal);
      break;
    case 'spuersinn':
      h.invisibleUntil = state.now + ab.invisibleMs;
      for (const t of state.traps.values()) {
        if (!t.revealed && dist(t.tx + 0.5, t.ty + 0.5, h.x, h.y) <= ab.radius) { t.revealed = true; state.events.push({ t: 'reveal', trap: t.id, tx: t.tx, ty: t.ty }); }
      }
      for (const mo of state.monsters.values()) if (mo.target === h.id) { mo.target = null; mo.path = null; }
      break;
  }
}

function stepProjectiles(state, s, blocked) {
  for (const p of [...state.projectiles.values()]) {
    const dx = p.vx * s, dy = p.vy * s;
    const steps = Math.max(1, Math.ceil(Math.hypot(dx, dy) / 0.25));
    let gone = false;
    for (let i = 0; i < steps && !gone; i++) {
      p.x += dx / steps; p.y += dy / steps;
      const tx = Math.floor(p.x), ty = Math.floor(p.y);
      const wallKey = idx(state.map.w, tx, ty);
      if (state.wallIdx.has(wallKey)) {
        const w = [...state.walls.values()].find(w => w.tx === tx && w.ty === ty);
        if (w) damageWall(state, w, p.wallDmg);
        gone = true; break;
      }
      if (isWall(state.map, tx, ty)) { gone = true; break; }
      for (const mo of state.monsters.values()) {
        if (dist(mo.x, mo.y, p.x, p.y) <= MONSTERS[mo.type].radius + PROJECTILE_RADIUS) {
          damageMonster(state, mo, p.dmg, state.heroes.get(p.owner)); gone = true; break;
        }
      }
    }
    p.left -= Math.hypot(dx, dy);
    if (gone || p.left <= 0) state.projectiles.delete(p.id);
  }
}

function damageMonster(state, mo, dmg, by) {
  mo.hp -= dmg;
  state.events.push({ t: 'hit', x: mo.x, y: mo.y, dmg });
  if (mo.hp <= 0) {
    state.monsters.delete(mo.id);
    if (by) by.kills++;
    state.events.push({ t: 'monster_dead', id: mo.id, x: mo.x, y: mo.y, type: mo.type });
  }
}
function damageWall(state, w, dmg) {
  w.hp -= dmg;
  state.events.push({ t: 'wall_hit', tx: w.tx, ty: w.ty });
  if (w.hp <= 0) {
    state.walls.delete(w.id); rebuildWallIdx(state);
    for (const mo of state.monsters.values()) mo.path = null;
    state.events.push({ t: 'wall_broken', tx: w.tx, ty: w.ty });
  }
}

function visionRadius(state, h) {
  for (const z of state.zones.values()) if (dist(z.x, z.y, h.x, h.y) <= z.r) return NEBEL_VISION;
  return HERO_VISION;
}

function stepMonster(state, mo, s, blocked) {
  const md = MONSTERS[mo.type];
  // Ziel: nächster lebender, sichtbarer, nicht unsichtbarer Held in Aggro-Reichweite
  let target = mo.target ? state.heroes.get(mo.target) : null;
  if (!target || !target.alive || state.now < target.invisibleUntil || dist(target.x, target.y, mo.x, mo.y) > MONSTER_LEASH) { target = null; mo.target = null; }
  if (!target) {
    let best = null, bd = md.aggro;
    for (const h of state.heroes.values()) {
      if (!h.alive || state.now < h.invisibleUntil) continue;
      const d = dist(h.x, h.y, mo.x, mo.y);
      if (d < bd && lineOfSight(state.map, Math.floor(mo.x), Math.floor(mo.y), Math.floor(h.x), Math.floor(h.y), blocked)) { bd = d; best = h; }
    }
    if (best) { target = best; mo.target = best.id; mo.path = null; }
  }
  if (!target) return;
  const d = dist(target.x, target.y, mo.x, mo.y);
  if (d <= md.range + HERO_RADIUS) {
    if (state.now >= mo.attackReadyAt) {
      mo.attackReadyAt = state.now + md.cd;
      damageHero(state, target, md.dmg, 'monster');
    }
    return;
  }
  const tt = { x: Math.floor(target.x), y: Math.floor(target.y) };
  if (!mo.path || state.now >= mo.repathAt || (mo.pathGoal && (mo.pathGoal.x !== tt.x || mo.pathGoal.y !== tt.y))) {
    mo.path = findPath(state.map, { x: Math.floor(mo.x), y: Math.floor(mo.y) }, tt, blocked) || null;
    mo.pathGoal = tt; mo.repathAt = state.now + MONSTER_REPATH_MS;
  }
  let gx = target.x, gy = target.y;
  if (mo.path && mo.path.length) {
    const n = mo.path[0];
    gx = n.x + 0.5; gy = n.y + 0.5;
    if (dist(gx, gy, mo.x, mo.y) < 0.15) { mo.path.shift(); if (mo.path.length) { gx = mo.path[0].x + 0.5; gy = mo.path[0].y + 0.5; } }
  }
  const dx = gx - mo.x, dy = gy - mo.y, len = Math.hypot(dx, dy) || 1;
  const v = md.speed * s;
  const p = moveCircle(mo.x, mo.y, dx / len * v, dy / len * v, md.radius, blocked);
  mo.x = p.x; mo.y = p.y;
}

function damageHero(state, h, dmg, source) {
  if (!h.alive) return;
  h.hp -= dmg;
  state.events.push({ t: 'hero_hit', hero: h.id, dmg, source });
  if (h.hp <= 0) killHero(state, h, source);
}

function killHero(state, h, source) {
  h.alive = false; h.hp = 0; h.deaths++;
  if (state.artifact.carrier === h.id) { state.artifact.carrier = null; state.artifact.x = h.x; state.artifact.y = h.y; state.events.push({ t: 'artifact_drop', x: h.x, y: h.y }); }
  for (const k of state.kerkers.values()) { k.mana = Math.min(KERKER_MANA_MAX, k.mana + KERKER_MANA_PER_KILL / state.kerkers.size); k.kills++; }
  if (state.lives > 0) { state.lives--; h.respawnAt = state.now + RESPAWN_MS; }
  else h.respawnAt = 0;
  state.events.push({ t: 'hero_dead', hero: h.id, x: h.x, y: h.y, source, respawn: h.respawnAt > 0 });
}

function checkTraps(state, h) {
  const tx = Math.floor(h.x), ty = Math.floor(h.y);
  for (const t of [...state.traps.values()]) {
    if (t.tx !== tx || t.ty !== ty) continue;
    const def = KERKER_CARDS[t.type];
    state.traps.delete(t.id);
    state.events.push({ t: 'trap', type: t.type, tx, ty, hero: h.id });
    if (def.stunMs) h.stunnedUntil = state.now + def.stunMs;
    damageHero(state, h, def.dmg, 'trap');
  }
}

function checkArtifact(state) {
  const a = state.artifact;
  if (a.carrier === null) {
    for (const h of state.heroes.values()) {
      if (h.alive && dist(h.x, h.y, a.x, a.y) < HERO_RADIUS + 0.4) { a.carrier = h.id; state.events.push({ t: 'artifact_pick', hero: h.id }); break; }
    }
  } else {
    const h = state.heroes.get(a.carrier);
    a.x = h.x; a.y = h.y;
    if (Math.floor(h.x) === state.map.exit.x && Math.floor(h.y) === state.map.exit.y) endMatch(state, 'heroes', 'artifact_delivered');
  }
}

function checkEnd(state) {
  if (state.phase !== 'running') return;
  if (state.now >= state.endsAt) return endMatch(state, 'kerker', 'timeout');
  const anyAlive = [...state.heroes.values()].some(h => h.alive || h.respawnAt > 0);
  if (!anyAlive && state.heroes.size > 0) endMatch(state, 'kerker', 'all_dead');
}

export function endMatch(state, winner, reason) {
  if (state.phase !== 'running') return;
  state.phase = 'ended';
  state.result = {
    winner, reason, durationMs: state.now,
    heroes: [...state.heroes.values()].map(h => ({ id: h.id, name: h.name, cls: h.cls, kills: h.kills, deaths: h.deaths })),
    kerkers: [...state.kerkers.values()].map(k => ({ id: k.id, name: k.name, placed: k.placed, kills: k.kills })),
  };
  state.events.push({ t: 'end', winner, reason });
}

/** Spieler verlässt das Match: Held stirbt endgültig, Kerker-Seite wird kleiner. */
export function removePlayer(state, playerId) {
  const h = state.heroes.get(playerId);
  if (h) { if (h.alive) { killHero(state, h, 'left'); } h.respawnAt = 0; h.left = true; state.inputs.delete(playerId); }
  if (state.kerkers.delete(playerId) && state.kerkers.size === 0 && state.phase === 'running') endMatch(state, 'heroes', 'kerker_left');
  checkEnd(state);
}

// ── Snapshots (rollengefiltert) ────────────────────────────────────────
export function initialPayload(state, playerId) {
  const role = state.kerkers.has(playerId) ? ROLE.KERKER : ROLE.HERO;
  return {
    map: serializeMap(state.map), role, endsAt: state.endsAt,
    you: role === ROLE.HERO ? { cls: state.heroes.get(playerId).cls } : {},
    heroes: [...state.heroes.values()].map(h => ({ id: h.id, name: h.name, cls: h.cls })),
    kerkers: [...state.kerkers.values()].map(k => ({ id: k.id, name: k.name })),
  };
}

export function snapshotFor(state, playerId) {
  const base = { now: state.now, lives: state.lives, phase: state.phase, artifact: null, heroes: [], monsters: [], traps: [], walls: [], projectiles: [], zones: [], events: state.events };
  const kerker = state.kerkers.get(playerId);
  if (kerker) {
    base.mana = Math.floor(kerker.mana);
    base.heroes = [...state.heroes.values()].map(heroView);
    base.monsters = [...state.monsters.values()].map(monsterView);
    base.traps = [...state.traps.values()].map(t => ({ id: t.id, type: t.type, tx: t.tx, ty: t.ty, revealed: t.revealed }));
    base.walls = [...state.walls.values()].map(w => ({ id: w.id, tx: w.tx, ty: w.ty, hp: w.hp }));
    base.projectiles = [...state.projectiles.values()].map(projView);
    base.zones = [...state.zones.values()].map(zoneView);
    base.artifact = { x: state.artifact.x, y: state.artifact.y, carrier: state.artifact.carrier };
    return base;
  }
  // Helden: Teamsicht = Vereinigung der Sichtkreise aller lebenden Helden (mit Sichtlinie).
  const eyes = [...state.heroes.values()].filter(h => h.alive).map(h => ({ x: h.x, y: h.y, r: visionRadius(state, h) }));
  const blocked = blockedFn(state);
  const visible = (x, y) => eyes.some(e => dist(e.x, e.y, x, y) <= e.r && lineOfSight(state.map, Math.floor(e.x), Math.floor(e.y), Math.floor(x), Math.floor(y), blocked));
  base.vision = eyes;
  base.heroes = [...state.heroes.values()].map(heroView);
  base.monsters = [...state.monsters.values()].filter(m => visible(m.x, m.y)).map(monsterView);
  base.traps = [...state.traps.values()].filter(t => t.revealed).map(t => ({ id: t.id, type: t.type, tx: t.tx, ty: t.ty }));
  base.walls = [...state.walls.values()].filter(w => visible(w.tx + 0.5, w.ty + 0.5)).map(w => ({ id: w.id, tx: w.tx, ty: w.ty, hp: w.hp }));
  base.projectiles = [...state.projectiles.values()].map(projView);
  base.zones = [...state.zones.values()].filter(z => visible(z.x, z.y) || eyes.some(e => dist(e.x, e.y, z.x, z.y) <= z.r)).map(zoneView);
  base.artifact = { x: state.artifact.x, y: state.artifact.y, carrier: state.artifact.carrier };
  // Ereignisse, die versteckte Information tragen würden, gibt es nicht: "place" bleibt Kerker-intern.
  base.events = state.events.filter(e => e.t !== 'place');
  return base;
}
const heroView = (h) => ({ id: h.id, name: h.name, cls: h.cls, x: r2(h.x), y: r2(h.y), hp: Math.ceil(h.hp), maxHp: h.maxHp, facing: r2(h.facing), alive: h.alive, respawnAt: h.respawnAt, stunnedUntil: h.stunnedUntil, invisibleUntil: h.invisibleUntil, abilityReadyAt: h.abilityReadyAt, kills: h.kills, deaths: h.deaths });
const monsterView = (m) => ({ id: m.id, type: m.type, x: r2(m.x), y: r2(m.y), hp: Math.ceil(m.hp), maxHp: m.maxHp });
const projView = (p) => ({ id: p.id, x: r2(p.x), y: r2(p.y) });
const zoneView = (z) => ({ id: z.id, type: z.type, x: z.x, y: z.y, r: z.r, until: z.until });
const r2 = (v) => Math.round(v * 100) / 100;
