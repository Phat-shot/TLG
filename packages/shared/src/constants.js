// Spielkonstanten — Single Source of Truth für Server UND Client.
// Alle Längen in Kacheln (tile), Zeiten in Millisekunden, Geschwindigkeiten in Kacheln/Sekunde.

export const TILE_PX = 32;
export const MAP_W = 48;
export const MAP_H = 32;

export const TICK_HZ = 20;
export const TICK_MS = 1000 / TICK_HZ;
export const SNAPSHOT_HZ = 20;

export const TILE = { FLOOR: 0, WALL: 1 };

export const ROLE = { HERO: 'hero', KERKER: 'kerker' };

export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 16;

export const DEFAULT_SETTINGS = {
  teamSize: 2,           // Spieler pro Team; wirksam ist min(teamSize, floor(n/2)), damit immer ≥2 Teams entstehen
  durationMin: 12,       // 8..20
};
export const SETTINGS_LIMITS = {
  teamSize: [1, 8],
  durationMin: [8, 20],
};
export const MAX_TEAMS = 16;
export const TEAM_NAMES = ['Rot', 'Blau', 'Grün', 'Gelb', 'Lila', 'Orange', 'Türkis', 'Pink', 'Braun', 'Grau', 'Weiß', 'Schwarz', 'Mint', 'Ocker', 'Indigo', 'Koralle'];
export const TEAM_COLORS = ['#e0534f', '#5aa9e6', '#5fc68a', '#f2d16b', '#a77be0', '#f08a3c', '#4fd1c5', '#f06fb0', '#a0785a', '#9aa0a6', '#f0f0f0', '#55555f', '#9ff0c8', '#c8a24a', '#6a5acd', '#ff7f6e'];
// Serien-Wertung: jedes Team ist genau einmal Kerker, Runden = Teams.
export const SERIES_POINTS = { kerkerWin: 3, heroWin: 2, deliverer: 1 };

/** Teamgröße, die bei n Spielern wirklich gilt (immer ≥2 Teams), und die Teamgrößen-Verteilung. */
export function effectiveTeamSize(n, teamSize) {
  return Math.max(1, Math.min(teamSize, Math.floor(n / 2)));
}
export function teamSizes(n, teamSize) {
  if (n < 2) return [n];
  const k = effectiveTeamSize(n, teamSize);
  const count = Math.min(MAX_TEAMS, Math.max(2, Math.floor(n / k)));
  const sizes = Array(count).fill(Math.floor(n / count));
  for (let i = 0; i < n % count; i++) sizes[i]++;
  return sizes;
}

// ── Helden ──────────────────────────────────────────────
export const HERO_RADIUS = 0.35; // Kollisionskreis in Kacheln
export const HERO_VISION = 6;    // Sichtradius in Kacheln
export const NEBEL_VISION = 2.5; // Sichtradius im Nebel
export const CARRIER_SPEED_MUL = 0.7;
export const RESPAWN_MS = 15000;
export const LIVES_PER_HERO = 2;   // gemeinsamer Lebensvorrat = Helden × 2

export const HERO_CLASSES = {
  krieger: {
    name: 'Krieger', hp: 140, speed: 4.0,
    attack: { kind: 'melee', range: 1.3, arc: Math.PI / 3, dmg: 30, cd: 600, wallDmg: 40 },
    ability: { id: 'schildstoss', name: 'Schildstoß', cd: 8000, dashTiles: 3, dmg: 20, push: 1.5 },
  },
  schuetze: {
    name: 'Schütze', hp: 90, speed: 4.2,
    attack: { kind: 'ranged', speed: 12, dmg: 22, cd: 700, range: 9, wallDmg: 10 },
    ability: { id: 'salve', name: 'Salve', cd: 10000, count: 5, spread: Math.PI / 5 },
  },
  heiler: {
    name: 'Heiler', hp: 100, speed: 4.0,
    attack: { kind: 'ranged', speed: 10, dmg: 10, cd: 800, range: 7, wallDmg: 5 },
    ability: { id: 'heilkreis', name: 'Heilkreis', cd: 12000, radius: 4, heal: 35 },
  },
  schurke: {
    name: 'Schurke', hp: 80, speed: 5.0,
    attack: { kind: 'melee', range: 1.0, arc: Math.PI / 2, dmg: 18, cd: 350, wallDmg: 15 },
    ability: { id: 'spuersinn', name: 'Spürsinn', cd: 15000, radius: 6, invisibleMs: 3000 },
  },
};
export const HERO_CLASS_IDS = Object.keys(HERO_CLASSES);

// ── Kerker ──────────────────────────────────────────────
export const KERKER_MANA_START = 60;
export const KERKER_MANA_MAX = 200;
export const KERKER_MANA_PER_KILL = 25;
// Regeneration pro Sekunde für die gesamte Kerker-Seite, skaliert mit der Heldenzahl.
export function kerkerManaRegenPerSec(heroCount) {
  return 2 + 0.35 * heroCount;
}
export const MIN_PLACE_DIST = 4;      // Fallen/Mauern: Mindestabstand zu lebenden Helden
export const MIN_SPAWN_DIST = 6;      // Monster: Mindestabstand zu lebenden Helden
export const MAX_WALLS = 40;
export const MAX_MONSTERS = 24;
export const MAX_TRAPS = 60;
export const WALL_HP = 60;

export const KERKER_CARDS = {
  stachel: { name: 'Stachelfalle', cost: 20, kind: 'trap',    dmg: 35 },
  grube:   { name: 'Fallgrube',    cost: 25, kind: 'trap',    dmg: 10, stunMs: 2000 },
  mauer:   { name: 'Mauer',        cost: 15, kind: 'wall' },
  krabbler:{ name: 'Krabbler',     cost: 30, kind: 'monster', monster: 'krabbler' },
  brecher: { name: 'Brecher',      cost: 80, kind: 'monster', monster: 'brecher' },
  nebel:   { name: 'Nebel',        cost: 35, kind: 'zone',    radius: 4, durationMs: 25000 },
};
export const KERKER_CARD_IDS = Object.keys(KERKER_CARDS);

export const MONSTERS = {
  krabbler: { name: 'Krabbler', hp: 40,  speed: 3.2, dmg: 8,  cd: 800,  range: 0.7, aggro: 7, radius: 0.3 },
  brecher:  { name: 'Brecher',  hp: 160, speed: 2.0, dmg: 25, cd: 1500, range: 0.9, aggro: 7, radius: 0.45 },
};

export const PROJECTILE_RADIUS = 0.15;

// ── Socket-Protokoll (Ereignisnamen) ────────────────────
export const EV = {
  // Client → Server
  LOBBY_CREATE: 'lobby:create', LOBBY_JOIN: 'lobby:join', LOBBY_LEAVE: 'lobby:leave',
  LOBBY_READY: 'lobby:ready', LOBBY_CLASS: 'lobby:class', LOBBY_SETTINGS: 'lobby:settings',
  LOBBY_TEAM: 'lobby:team', LOBBY_SHUFFLE: 'lobby:shuffle', LOBBY_START: 'lobby:start', LOBBY_LIST: 'lobby:list',
  LOBBY_ABORT_SERIES: 'lobby:abort_series',
  GAME_INPUT: 'game:input', GAME_PLACE: 'game:place', GAME_LEAVE: 'game:leave',
  // Server → Client
  LOBBY_STATE: 'lobby:state', LOBBY_LIST_STATE: 'lobby:list_state',
  GAME_START: 'game:start', GAME_SNAPSHOT: 'game:snapshot', GAME_OVER: 'game:over',
  ERROR: 'error',
};
