// Browser-Rauchtest: echter Client (client/dist) gegen echten TLG-Server gegen
// nachgebauten Craftworks. Zwei Spieler, ein Match, Screenshots beider Sichten.
// Aufruf: node scripts/check-client.mjs [screenshot-dir]
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createApp } from '../server/src/app.js';
import { startFakeCraftworks } from '../server/test/fake_craftworks.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = process.argv[2] || path.join(here, '..', 'tmp-shots');
const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); }
catch { try { ({ chromium } = require('/node-tools/node_modules/playwright')); } catch { console.error('playwright nicht gefunden'); process.exit(2); } }

const cw = await startFakeCraftworks();
const app = createApp({ craftworksUrl: cw.url, clientDist: path.join(here, '..', 'client', 'dist') });
await new Promise(r => app.server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${app.server.address().port}`;
const fail = (m) => { console.error('FEHLER:', m); process.exitCode = 1; };

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, headless: true });
try {
  const mk = async () => { const c = await browser.newContext({ viewport: { width: 1280, height: 800 } }); const p = await c.newPage(); p.on('pageerror', e => fail('pageerror: ' + e.message)); return p; };
  const A = await mk(), B = await mk();
  const guest = async (p, name) => {
    await p.goto(base);
    await p.getByPlaceholder('Spielername (2–24 Zeichen)').fill(name);
    await p.locator('input[type=checkbox]').check();
    await p.getByRole('button', { name: 'Rein in den Kerker' }).click();
    await p.getByText('Offene Lobbys').waitFor({ timeout: 5000 });
  };
  await guest(A, 'Anna'); await guest(B, 'Ben');
  await A.getByRole('button', { name: 'Lobby eröffnen' }).click();
  const code = (await A.locator('.code').textContent({ timeout: 5000 })).trim();
  if (!/^[A-Z2-9]{5}$/.test(code)) fail('Lobby-Code fehlt: ' + code);
  await B.getByPlaceholder('Code, z.B. K7X2M').fill(code);
  await B.getByRole('button', { name: 'Beitreten' }).last().click();
  await B.getByRole('button', { name: 'Bereit!' }).click({ timeout: 5000 });
  await A.getByText('✓ bereit').nth(1).waitFor({ timeout: 5000 });
  await A.locator('.card.wide').screenshot({ path: path.join(outDir, 'lobby.png') });
  await A.getByRole('button', { name: /Serie starten/ }).click();
  await A.locator('#game > canvas').waitFor({ timeout: 5000 });
  await B.locator('#game > canvas').waitFor({ timeout: 5000 });
  await A.waitForTimeout(600);
  const cardsA = await A.locator('.cardbtn').count(), cardsB = await B.locator('.cardbtn').count();
  const kerker = cardsA === 6 ? A : cardsB === 6 ? B : null;
  if (!kerker) throw new Error('keine Kartenleiste beim Kerker: ' + cardsA + '/' + cardsB);
  const hero = kerker === A ? B : A;
  if ((await hero.locator('.hud.top .ring').count()) !== 1) fail('Helden-HUD ohne Cooldown-Ring');
  if (!(await hero.locator('.hud.top').textContent()).includes('Runde 1/2')) fail('Helden-HUD ohne Rundeninfo');
  // Held läuft und greift an
  await hero.mouse.move(700, 400); await hero.keyboard.down('KeyD'); await hero.mouse.down();
  await hero.waitForTimeout(500); await hero.keyboard.up('KeyD'); await hero.mouse.up();
  // Kerker wählt Karte 1 und klickt irgendwo in die Karte (Ergebnis egal, es darf nur nichts brechen)
  await kerker.keyboard.press('Digit1');
  await kerker.mouse.click(900, 300);
  await kerker.waitForTimeout(400);
  await hero.screenshot({ path: path.join(outDir, 'hero.png') });
  await kerker.screenshot({ path: path.join(outDir, 'kerker.png') });
  const feed = await kerker.locator('.hud.feed').textContent();
  console.log('Kerker-Feed:', JSON.stringify(feed));
  console.log(process.exitCode ? 'Rauchtest FEHLGESCHLAGEN' : `Rauchtest ok — Screenshots in ${outDir}`);
} catch (e) { fail(e.stack || e.message); }
finally { await browser.close(); await app.close(); await cw.close(); }
