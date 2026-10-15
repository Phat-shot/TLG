import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';

const PORT = +process.env.PORT || 3000;
const CRAFTWORKS_URL = process.env.CRAFTWORKS_URL;
if (!CRAFTWORKS_URL) { console.error('CRAFTWORKS_URL fehlt (z.B. https://dev.srz.one) — TLG hat keine eigene Nutzerverwaltung.'); process.exit(1); }

const here = path.dirname(fileURLToPath(import.meta.url));
const version = (() => { try { return fs.readFileSync(path.join(here, 'VERSION'), 'utf8').trim(); } catch { return 'dev'; } })();

const { server, io } = createApp({
  craftworksUrl: CRAFTWORKS_URL,
  clientDist: path.resolve(here, '../../client/dist'),
  version,
  corsOrigin: process.env.NODE_ENV === 'production' ? undefined : true,
});
server.listen(PORT, () => console.log(`TLG ${version} auf :${PORT}, Craftworks: ${CRAFTWORKS_URL}`));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { io.close(); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 2000).unref(); });
