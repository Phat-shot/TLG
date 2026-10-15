/** Winzige DOM-Helfer, damit die Screens ohne Framework lesbar bleiben. */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, any> = {}, ...children: (Node | string | null | undefined | false)[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on') && typeof v === 'function') (el as any)[k.toLowerCase()] = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k in el && typeof v !== 'string') (el as any)[k] = v;
    else el.setAttribute(k, String(v));
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) el.append(c instanceof Node ? c : document.createTextNode(c));
  return el;
}
export const app = () => document.getElementById('app')!;
export function mount(el: Element) { const a = app(); a.replaceChildren(el); }
export const fmtTime = (ms: number) => { const s = Math.max(0, Math.ceil(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
export const ERRORS: Record<string, string> = {
  invalid_credentials: 'E-Mail oder Passwort falsch.', email_not_verified: 'E-Mail noch nicht bestätigt (in Craftworks bestätigen).',
  guest_login_disabled: 'Gast-Zugang ist auf dem Craftworks-Server deaktiviert.', privacy_not_accepted: 'Bitte Datenschutz akzeptieren.',
  craftworks_unreachable: 'Craftworks-Server nicht erreichbar.', lobby_not_found: 'Lobby nicht gefunden.', lobby_full: 'Lobby ist voll.',
  lobby_in_progress: 'Match läuft bereits.', not_host: 'Nur der Host darf das.', not_all_ready: 'Nicht alle sind bereit.',
  not_enough_players: 'Mindestens 2 Spieler.', replaced: 'Anderswo neu verbunden — dieser Tab ist abgemeldet.', server_error: 'Serverfehler.',
  no_mana: 'Nicht genug Mana.', too_close: 'Zu nah an einem Helden.', would_seal: 'Würde den Kerker versiegeln.', not_floor: 'Kein Boden.',
  reserved_tile: 'Kachel ist reserviert.', occupied: 'Kachel ist belegt.', limit: 'Limit erreicht.',
};
export const errText = (code: string) => ERRORS[code] || code;
