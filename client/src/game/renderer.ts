// Gemeinsame Schnittstelle der Renderer (3D mit Three.js, 2D-Canvas als Fallback).
export type Snap = {
  now: number; lives: number; phase: string; mana?: number; vision?: { x: number; y: number; r: number }[];
  artifact: { x: number; y: number; carrier: string | null } | null;
  heroes: any[]; monsters: any[]; traps: any[]; walls: any[]; projectiles: any[]; zones: any[]; events: any[];
};
export type Ghost = { card: string; tx: number; ty: number; bad: string | null } | null;
export type View = {
  cur: Snap; prev: Snap | null; t: number; now: number; dt: number;
  heroes: any[]; monsters: any[]; projectiles: any[]; meHero: any | null; meId: string;
  isKerker: boolean; explored: Uint8Array; vision: { x: number; y: number; r: number }[];
  ghost: Ghost; shake: number; teamColor: (id: string) => string;
};
export interface GameRenderer {
  resize(): void;
  frame(v: View): void;
  /** Bildschirm → Kachelkoordinaten (x, y in Kacheln, Bruchteile erlaubt) */
  screenToWorld(sx: number, sy: number): { x: number; y: number };
  /** Spielereignis (Treffer, Falle, Tod…) für Effekte; heroAt liefert die aktuelle Heldenposition */
  event(ev: any, heroAt: (id: string) => any): void;
  wheel(deltaY: number): void;
  pan(dx: number, dy: number): void;
  dispose(): void;
}
export const CLASS_COLOR: Record<string, string> = { krieger: '#e8763f', schuetze: '#62cf8e', heiler: '#f4d56b', schurke: '#b48ae8' };
