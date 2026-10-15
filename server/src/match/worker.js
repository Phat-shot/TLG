// Ein Worker-Thread pro Match: tickt die Engine, nimmt Eingaben entgegen und
// schickt pro Tick genau ZWEI Snapshots (Helden-Teamsicht, Kerker-Sicht) —
// die Helden-Sicht ist für alle Helden identisch, also nur einmal rechnen.
import { parentPort, workerData } from 'node:worker_threads';
import { TICK_MS } from '@tlg/shared';
import { createMatch, applyInput, placeCard, step, snapshotFor, removePlayer, endMatch, initialPayload } from './engine.js';

const state = createMatch(workerData);
const anyHero = () => state.heroes.keys().next().value;
const anyKerker = () => state.kerkers.keys().next().value;

parentPort.postMessage({ type: 'ready', payloads: Object.fromEntries(workerData.players.map(p => [p.id, initialPayload(state, p.id)])) });

parentPort.on('message', (msg) => {
  switch (msg.type) {
    case 'input': applyInput(state, msg.playerId, msg.input); break;
    case 'place': parentPort.postMessage({ type: 'place_result', playerId: msg.playerId, reqId: msg.reqId, action: msg.action, result: placeCard(state, msg.playerId, msg.action) }); break;
    case 'remove': removePlayer(state, msg.playerId); break;
    case 'stop': endMatch(state, 'kerker', 'aborted'); finish(); break;
  }
});

let last = Date.now();
const timer = setInterval(() => {
  const now = Date.now();
  let dt = now - last; last = now;
  // Nach einer Hänger-Pause nicht "nachholen": maximal 4 Ticks Simulation pro Intervall.
  dt = Math.min(dt, TICK_MS * 4);
  while (dt > 0) { step(state, Math.min(dt, TICK_MS)); dt -= TICK_MS; }
  const hero = anyHero() ? snapshotFor(state, anyHero()) : null;
  const kerker = anyKerker() ? snapshotFor(state, anyKerker()) : null;
  parentPort.postMessage({ type: 'snapshot', hero, kerker });
  if (state.phase === 'ended') finish();
}, TICK_MS);

function finish() {
  clearInterval(timer);
  parentPort.postMessage({ type: 'ended', result: state.result });
  setTimeout(() => process.exit(0), 50);
}
