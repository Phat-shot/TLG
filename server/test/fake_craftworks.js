// Nachgebauter Craftworks-Server: genau die Endpunkte, die TLG benutzt.
// Token = "tok:<id>:<name>" — kein JWT, nur für Tests.
import http from 'node:http';

export function startFakeCraftworks() {
  const users = new Map();
  const server = http.createServer((req, res) => {
    const json = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      const b = body ? JSON.parse(body) : {};
      if (req.url === '/api/users/me') {
        const tok = (req.headers.authorization || '').replace('Bearer ', '');
        const u = users.get(tok);
        return u ? json(200, { id: u.id, username: u.name, is_guest: u.guest, avatar_color: '#abc' }) : json(401, { error: 'token_invalid' });
      }
      if (req.url === '/api/auth/guest' && req.method === 'POST') {
        if (b.privacyAccepted !== true) return json(400, { error: 'privacy_not_accepted' });
        const id = `g_${users.size + 1}`; const tok = `tok:${id}`;
        users.set(tok, { id, name: b.username, guest: true });
        return json(200, { access_token: tok, refresh_token: `ref:${id}`, user: { id, username: b.username, is_guest: true } });
      }
      if (req.url === '/api/auth/config') return json(200, { guest_login_enabled: true, registration_enabled: false });
      if (req.url === '/api/auth/refresh') { const id = String(b.refresh_token || '').replace('ref:', ''); const tok = `tok:${id}`; return users.has(tok) ? json(200, { access_token: tok }) : json(401, { error: 'invalid_token' }); }
      if (req.url === '/api/auth/logout') return json(200, { ok: true });
      json(404, { error: 'not_found' });
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    url: `http://127.0.0.1:${server.address().port}`,
    addUser: (id, name) => { users.set(`tok:${id}`, { id, name, guest: false }); return `tok:${id}`; },
    close: () => new Promise(r => server.close(r)),
  })));
}
