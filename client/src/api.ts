// Auth läuft komplett über den TLG-Server-Proxy nach Craftworks. Tokens liegen im localStorage.
export type User = { id: string; name: string; isGuest: boolean; avatarColor: string | null };

const KEY = 'tlg_tokens';
const toUser = (u: any): User => ({ id: u.id, name: u.username, isGuest: !!u.is_guest, avatarColor: u.avatar_color ?? null });
type Tokens = { access_token: string; refresh_token?: string };

export function getTokens(): Tokens | null {
  try { const s = localStorage.getItem(KEY); return s ? JSON.parse(s) : null; } catch { return null; }
}
export function setTokens(t: Tokens | null) {
  try { t ? localStorage.setItem(KEY, JSON.stringify(t)) : localStorage.removeItem(KEY); } catch { /* privat/blockiert */ }
}

async function post(path: string, body: unknown) {
  const res = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `http_${res.status}`), { code: data.error || `http_${res.status}`, status: res.status, data });
  return data;
}

export async function login(email: string, password: string) {
  const d = await post('/api/auth/login', { email, password });
  setTokens({ access_token: d.access_token, refresh_token: d.refresh_token });
  return toUser(d.user);
}
export async function guest(username: string, privacyAccepted: boolean) {
  const d = await post('/api/auth/guest', { username, privacyAccepted, language: 'de' });
  setTokens({ access_token: d.access_token, refresh_token: d.refresh_token });
  return toUser(d.user);
}
export async function refresh(): Promise<boolean> {
  const t = getTokens();
  if (!t?.refresh_token) return false;
  try {
    const d = await post('/api/auth/refresh', { refresh_token: t.refresh_token });
    setTokens({ ...t, access_token: d.access_token });
    return true;
  } catch { return false; }
}
export async function logout() {
  const t = getTokens();
  setTokens(null);
  if (t?.refresh_token) await post('/api/auth/logout', { refresh_token: t.refresh_token }).catch(() => {});
}
export async function me(): Promise<User | null> {
  const t = getTokens();
  if (!t) return null;
  const res = await fetch('/api/me', { headers: { authorization: `Bearer ${t.access_token}` } });
  if (res.status === 401) { if (await refresh()) return me(); setTokens(null); return null; }
  if (!res.ok) throw new Error('server_unreachable');
  return res.json();
}
export async function authConfig(): Promise<{ guest_login_enabled?: boolean; registration_enabled?: boolean }> {
  try { const r = await fetch('/api/auth/config'); return r.ok ? r.json() : {}; } catch { return {}; }
}
