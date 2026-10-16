// Action-Screenshots für die Doku: echter Client, echter Server, nachgebauter Craftworks.
// Setzt über den Match-Worker Monster/Fallen/Mauern in die Nähe des Helden und fotografiert beide Sichten.
// Aufruf: node scripts/screenshots.mjs <ausgabe-ordner>
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createApp } from '../server/src/app.js';
import { startFakeCraftworks } from '../server/test/fake_craftworks.js';
import { bfsDistances, idx, isWall, deserializeMap, lineOfSight } from '@tlg/shared';

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = process.argv[2] || path.join(here, '..', 'tmp-shots');
const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch { ({ chromium } = require(process.env.PLAYWRIGHT_PATH || '/opt/node22/lib/node_modules/playwright')); }

const cw = await startFakeCraftworks();
const app = createApp({ craftworksUrl: cw.url, clientDist: path.join(here, '..', 'client', 'dist') });
await new Promise(r => app.server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${app.server.address().port}`;
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, headless: true, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
try {
  const mk = async () => { const c = await browser.newContext({ viewport: { width: 1600, height: 900 } }); const p = await c.newPage(); if (process.env.DEBUG_CONSOLE) { p.on('console', m => console.log('[console]', m.type(), m.text().slice(0, 400))); p.on('pageerror', e => console.log('[pageerror]', e.message)); } return p; };
  const pages = [];
  for (const name of ['Anna', 'Ben', 'Cem', 'Dana']) {
    const p = await mk(); pages.push(p);
    await p.goto(base);
    await p.getByPlaceholder('Spielername (2–24 Zeichen)').fill(name);
    await p.locator('input[type=checkbox]').check();
    await p.getByRole('button', { name: 'Rein in den Kerker' }).click();
    await p.getByText('Offene Lobbys').waitFor();
  }
  const [A, B, C, D] = pages;
  await A.getByRole('button', { name: 'Lobby eröffnen' }).click();
  const code = (await A.locator('.code').textContent()).trim();
  for (const p of [B, C, D]) { await p.getByPlaceholder('Code, z.B. K7X2M').fill(code); await p.getByRole('button', { name: 'Beitreten' }).last().click(); await p.getByRole('button', { name: 'Bereit!' }).click(); }
  await A.getByText('✓ bereit').nth(3).waitFor();
  await A.screenshot({ path: path.join(outDir, 'lobby.png') });
  await A.getByRole('button', { name: /Serie starten/ }).click();
  for (const p of pages) await p.locator('#game > canvas').waitFor();
  await A.waitForTimeout(500);

  const lobby = [...app.lobbies.lobbies.values()][0];
  const kerkerIds = lobby.players.filter(p => p.role === 'kerker').map(p => p.id);
  const heroIds = lobby.players.filter(p => p.role === 'hero').map(p => p.id);
  const map = deserializeMap(lobby.payloads[kerkerIds[0]].map);
  const d = bfsDistances(map, map.entrance.x, map.entrance.y);
  const tilesAt = (lo, hi) => { const out = []; for (let y = 1; y < map.h - 1; y++) for (let x = 1; x < map.w - 1; x++) { const dd = d[idx(map.w, x, y)]; if (dd >= lo && dd <= hi && !isWall(map, x, y)) out.push({ x, y }); } return out; };
  const results = new Map();
  app.matches.on('place_result', (id, msg) => results.set(msg.reqId, msg.result));
  const tryPlace = async (card, cands) => {
    for (const t of cands) {
      const reqId = app.matches.place(lobby.matchId, kerkerIds[0], { card, tx: t.x, ty: t.y });
      for (let i = 0; i < 40 && !results.has(reqId); i++) await new Promise(r => setTimeout(r, 25));
      const r = results.get(reqId);
      if (r?.ok) return t;
      if (r?.error === 'no_mana') return null;
    }
    return null;
  };
  const los = (t) => lineOfSight(map, map.entrance.x, map.entrance.y, t.x, t.y);
  // Kerker hat 60 Mana: Krabbler (30) mit Sichtlinie zum Eingang, dann Stachel (20); Mauer nach Regeneration
  const mo = await tryPlace('krabbler', tilesAt(6, 7).filter(los).concat(tilesAt(6, 8)));
  await tryPlace('stachel', tilesAt(4, 6));
  await A.waitForTimeout(5000);
  await tryPlace('mauer', tilesAt(5, 7).filter(t => d[idx(map.w, t.x, t.y)] % 2 === 0));
  console.log('Krabbler bei', mo);

  // Helden-Seiten: Browser-Fenster, dessen Spieler Held ist
  const pageOf = {}; const ids = ['g_1', 'g_2', 'g_3', 'g_4']; pages.forEach((p, i) => (pageOf[ids[i]] = p));
  const kerkerPage = pageOf[kerkerIds[0]]; const heroPages = heroIds.map(id => pageOf[id]);
  // Helden stehen am Eingang, zielen Richtung Monster und greifen an; der Krabbler kommt von selbst
  const aim = (t) => ({ x: 800 + (t.x + .5 - map.entrance.x - .5) * 32, y: 450 + (t.y + .5 - map.entrance.y - .5) * 32 });
  for (const hp of heroPages) { const a = mo ? aim(mo) : { x: 1000, y: 450 }; await hp.mouse.move(a.x, a.y); await hp.mouse.down(); }
  await A.waitForTimeout(1300);
  await heroPages[0].screenshot({ path: path.join(outDir, 'hero-action.png') });
  await heroPages[1].screenshot({ path: path.join(outDir, 'hero-action-2.png') });
  await heroPages[0].keyboard.press('Space');
  await A.waitForTimeout(700);
  await kerkerPage.keyboard.press('Digit4'); await kerkerPage.mouse.move(900, 300);
  await kerkerPage.screenshot({ path: path.join(outDir, 'kerker-action.png') });
  for (const hp of heroPages) await hp.mouse.up();
  console.log('ok', outDir);
} finally { await browser.close(); await app.close(); await cw.close(); }
