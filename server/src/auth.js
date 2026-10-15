// Craftworks ist die einzige Nutzerverwaltung. TLG stellt keine Tokens aus und
// hat keine Nutzertabelle: ein Access-Token gilt genau dann, wenn Craftworks'
// GET /api/users/me ihn annimmt. Ergebnis wird kurz gecacht (Token-TTL bei
// Craftworks ist 15 min; der Client refresht über den /api/auth-Proxy).
const CACHE_MS = 60_000;
const CACHE_MAX = 2000;

export function createAuth({ craftworksUrl, fetchImpl = fetch, cacheMs = CACHE_MS }) {
  if (!craftworksUrl) throw new Error('CRAFTWORKS_URL fehlt');
  const base = craftworksUrl.replace(/\/+$/, '');
  const cache = new Map(); // token -> { user, until }

  async function verifyAccessToken(token) {
    if (!token || typeof token !== 'string' || token.length > 4096) return null;
    const hit = cache.get(token);
    if (hit && hit.until > Date.now()) return hit.user;
    let res;
    try {
      res = await fetchImpl(`${base}/api/users/me`, { headers: { authorization: `Bearer ${token}` } });
    } catch (e) {
      const err = new Error('craftworks_unreachable'); err.code = 'craftworks_unreachable'; throw err;
    }
    if (res.status === 401) { cache.delete(token); return null; }
    if (!res.ok) { const err = new Error('craftworks_error'); err.code = 'craftworks_error'; err.status = res.status; throw err; }
    const u = await res.json();
    const user = { id: u.id, name: u.username, isGuest: !!u.is_guest, avatarColor: u.avatar_color || null };
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
    cache.set(token, { user, until: Date.now() + cacheMs });
    return user;
  }

  // Weiterleitung der Auth-Endpunkte (login/guest/refresh/logout/config/register),
  // damit der Browser nur mit TLG spricht — keine CORS-Freigabe in Craftworks nötig.
  const ALLOWED = new Set(['login', 'guest', 'refresh', 'logout', 'config', 'register', 'magic-link', 'magic-link/exchange']);
  async function proxyAuth(req, res) {
    const sub = req.params.sub || '';
    if (!ALLOWED.has(sub)) return res.status(404).json({ error: 'not_found' });
    const init = { method: req.method, headers: { 'content-type': 'application/json', 'x-forwarded-for': req.ip } };
    if (req.method !== 'GET') init.body = JSON.stringify(req.body ?? {});
    let up;
    try { up = await fetchImpl(`${base}/api/auth/${sub}`, init); }
    catch { return res.status(502).json({ error: 'craftworks_unreachable' }); }
    const text = await up.text();
    res.status(up.status).type('application/json').send(text);
  }

  return { verifyAccessToken, proxyAuth, base, _cache: cache };
}
