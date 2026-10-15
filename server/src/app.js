import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import express from 'express';
import { Server } from 'socket.io';
import { createAuth } from './auth.js';
import { LobbyManager } from './lobby.js';
import { MatchManager } from './match/manager.js';
import { attachSocket } from './socket.js';

/** Baut App + HTTP-Server + Socket.io. Ohne listen(), damit Tests ihn selbst starten. */
export function createApp({ craftworksUrl, clientDist, version = 'dev', fetchImpl, log = console, corsOrigin }) {
  const auth = createAuth({ craftworksUrl, fetchImpl });
  const lobbies = new LobbyManager();
  const matches = new MatchManager();

  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '16kb' }));
  app.set('trust proxy', 1);

  app.get('/healthz', (req, res) => res.json({ ok: true, version, lobbies: lobbies.lobbies.size, matches: matches.matches.size }));
  app.get('/api/config', (req, res) => res.json({ craftworksUrl: auth.base, version }));
  app.all('/api/auth/:sub', (req, res) => auth.proxyAuth(req, res));
  app.all('/api/auth/:sub/:sub2', (req, res) => { req.params.sub = `${req.params.sub}/${req.params.sub2}`; return auth.proxyAuth(req, res); });
  app.get('/api/me', async (req, res) => {
    try {
      const user = await auth.verifyAccessToken(req.headers.authorization?.split(' ')[1]);
      if (!user) return res.status(401).json({ error: 'unauthorized' });
      res.json(user);
    } catch (e) { res.status(502).json({ error: e.code || 'craftworks_error' }); }
  });

  if (clientDist && fs.existsSync(clientDist)) {
    app.use(express.static(clientDist, { index: 'index.html', maxAge: '1h' }));
    app.get('/{*splat}', (req, res, next) => req.path.startsWith('/api/') || req.path.startsWith('/socket.io') ? next() : res.sendFile(path.join(clientDist, 'index.html')));
  } else {
    app.get('/', (req, res) => res.type('text').send('TLG-Server läuft; client/dist fehlt (npm run build).'));
  }

  const server = http.createServer(app);
  const io = new Server(server, { cors: corsOrigin ? { origin: corsOrigin } : undefined, maxHttpBufferSize: 16 * 1024 });
  attachSocket(io, { auth, lobbies, matches, log });

  const close = () => new Promise((resolve) => { for (const id of [...matches.matches.keys()]) matches.destroy(id); io.close(); server.close(() => resolve()); });
  return { app, server, io, auth, lobbies, matches, close };
}
