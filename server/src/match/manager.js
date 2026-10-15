import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';

const WORKER = fileURLToPath(new URL('./worker.js', import.meta.url));

/** Startet/verwaltet Match-Worker. Ereignisse: ready, snapshot, place_result, ended, crash. */
export class MatchManager extends EventEmitter {
  constructor() { super(); this.matches = new Map(); }

  create(matchId, { seed, players, settings }) {
    if (this.matches.has(matchId)) throw new Error('match_exists');
    const worker = new Worker(WORKER, { workerData: { seed, players, settings } });
    const m = { id: matchId, worker, players, ended: false, reqId: 0 };
    this.matches.set(matchId, m);
    worker.on('message', (msg) => this.emit(msg.type, matchId, msg));
    worker.on('error', (err) => { console.error(`[match:${matchId}] worker error`, err); this.emit('crash', matchId, err); this.destroy(matchId); });
    worker.on('exit', () => { if (this.matches.get(matchId) === m) this.matches.delete(matchId); });
    return m;
  }
  input(matchId, playerId, input) { this.matches.get(matchId)?.worker.postMessage({ type: 'input', playerId, input }); }
  place(matchId, playerId, action) {
    const m = this.matches.get(matchId); if (!m) return null;
    const reqId = ++m.reqId;
    m.worker.postMessage({ type: 'place', playerId, action, reqId });
    return reqId;
  }
  remove(matchId, playerId) { this.matches.get(matchId)?.worker.postMessage({ type: 'remove', playerId }); }
  stop(matchId) { this.matches.get(matchId)?.worker.postMessage({ type: 'stop' }); }
  destroy(matchId) { const m = this.matches.get(matchId); if (!m) return; this.matches.delete(matchId); m.worker.terminate().catch(() => {}); }
  has(matchId) { return this.matches.has(matchId); }
}
