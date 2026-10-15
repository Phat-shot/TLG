import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAuth } from '../src/auth.js';

const fakeFetch = (handler) => async (url, init) => handler(new URL(url), init);
const jsonRes = (status, body) => ({ status, ok: status < 400, json: async () => body, text: async () => JSON.stringify(body) });

test('verifyAccessToken fragt Craftworks /api/users/me und cacht', async () => {
  let calls = 0;
  const auth = createAuth({ craftworksUrl: 'https://cw.example/', fetchImpl: fakeFetch((url, init) => {
    calls++;
    assert.equal(url.pathname, '/api/users/me');
    return init.headers.authorization === 'Bearer good' ? jsonRes(200, { id: 'abc', username: 'Anna', is_guest: false }) : jsonRes(401, { error: 'token_invalid' });
  }) });
  assert.equal(await auth.verifyAccessToken('bad'), null);
  const u = await auth.verifyAccessToken('good');
  assert.deepEqual(u, { id: 'abc', name: 'Anna', isGuest: false, avatarColor: null });
  await auth.verifyAccessToken('good');
  assert.equal(calls, 2, 'zweiter Aufruf kam nicht aus dem Cache');
  assert.equal(await auth.verifyAccessToken(''), null);
});

test('Craftworks nicht erreichbar → Fehler mit Code, kein stilles null', async () => {
  const auth = createAuth({ craftworksUrl: 'https://cw.example', fetchImpl: async () => { throw new Error('ECONNREFUSED'); } });
  await assert.rejects(() => auth.verifyAccessToken('x'), /craftworks_unreachable/);
});

test('Auth-Proxy leitet nur erlaubte Endpunkte weiter', async () => {
  let seen = null;
  const auth = createAuth({ craftworksUrl: 'https://cw.example', fetchImpl: fakeFetch((url, init) => { seen = { path: url.pathname, body: init.body, method: init.method }; return jsonRes(200, { access_token: 't' }); }) });
  const res = () => { const r = { code: 200, status(c) { r.code = c; return r; }, type() { return r; }, send(b) { r.body = b; return r; }, json(b) { r.body = JSON.stringify(b); return r; } }; return r; };
  const r1 = res();
  await auth.proxyAuth({ params: { sub: 'login' }, method: 'POST', body: { email: 'a@b.c', password: 'x' }, ip: '1.2.3.4' }, r1);
  assert.equal(seen.path, '/api/auth/login'); assert.equal(seen.method, 'POST'); assert.equal(r1.code, 200);
  const r2 = res();
  await auth.proxyAuth({ params: { sub: 'delete-everything' }, method: 'POST', body: {}, ip: '' }, r2);
  assert.equal(r2.code, 404);
});
