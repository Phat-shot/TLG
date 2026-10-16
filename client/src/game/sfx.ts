// Synthetisierte Soundeffekte über WebAudio — keine Assets, läuft offline.
type Name = 'hit' | 'hurt' | 'trap' | 'pick' | 'death' | 'place' | 'swing' | 'shoot' | 'heal' | 'win' | 'lose' | 'wall' | 'reveal' | 'respawn' | 'select';
let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let enabled = true;

function ac() {
  if (!ctx) {
    try { ctx = new (window.AudioContext || (window as any).webkitAudioContext)(); master = ctx.createGain(); master.gain.value = 0.35; master.connect(ctx.destination); }
    catch { enabled = false; }
  }
  if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => {});
  return ctx;
}
export function unlockAudio() { ac(); }
export function setMuted(m: boolean) { enabled = !m; }
export function isMuted() { return !enabled; }

function tone(freq: number, dur: number, type: OscillatorType = 'square', vol = 1, slide = 0, delay = 0) {
  const c = ac(); if (!c || !master) return;
  const t0 = c.currentTime + delay;
  const o = c.createOscillator(), g = c.createGain();
  o.type = type; o.frequency.setValueAtTime(freq, t0);
  if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(20, freq + slide), t0 + dur);
  g.gain.setValueAtTime(0.0001, t0); g.gain.exponentialRampToValueAtTime(vol, t0 + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  o.connect(g); g.connect(master); o.start(t0); o.stop(t0 + dur + 0.02);
}
function noise(dur: number, vol = 0.5, hp = 800, delay = 0) {
  const c = ac(); if (!c || !master) return;
  const t0 = c.currentTime + delay;
  const buf = c.createBuffer(1, Math.ceil(c.sampleRate * dur), c.sampleRate);
  const d = buf.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length);
  const src = c.createBufferSource(); src.buffer = buf;
  const f = c.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = hp;
  const g = c.createGain(); g.gain.setValueAtTime(vol, t0); g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  src.connect(f); f.connect(g); g.connect(master); src.start(t0);
}

export function play(name: Name) {
  if (!enabled) return;
  switch (name) {
    case 'hit': noise(0.08, 0.4, 2000); tone(180, 0.08, 'square', 0.3, -80); break;
    case 'hurt': tone(140, 0.18, 'sawtooth', 0.35, -60); noise(0.12, 0.3, 400); break;
    case 'trap': noise(0.2, 0.6, 300); tone(90, 0.3, 'sawtooth', 0.4, -40); tone(1200, 0.06, 'square', 0.15); break;
    case 'pick': tone(660, 0.08, 'triangle', 0.4); tone(880, 0.1, 'triangle', 0.4, 0, 0.08); tone(1320, 0.18, 'triangle', 0.4, 0, 0.16); break;
    case 'death': tone(220, 0.5, 'sawtooth', 0.4, -180); noise(0.4, 0.4, 200, 0.05); break;
    case 'place': tone(520, 0.06, 'triangle', 0.3); tone(390, 0.1, 'triangle', 0.25, 0, 0.05); break;
    case 'swing': noise(0.07, 0.25, 1500); break;
    case 'shoot': tone(900, 0.07, 'square', 0.15, -500); break;
    case 'heal': tone(523, 0.12, 'sine', 0.3); tone(659, 0.12, 'sine', 0.3, 0, 0.1); tone(784, 0.25, 'sine', 0.3, 0, 0.2); break;
    case 'win': [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.25, 'triangle', 0.4, 0, i * 0.13)); break;
    case 'lose': [392, 349, 311, 262].forEach((f, i) => tone(f, 0.3, 'sawtooth', 0.3, 0, i * 0.18)); break;
    case 'wall': noise(0.25, 0.5, 150); tone(70, 0.25, 'square', 0.3, -30); break;
    case 'reveal': tone(1500, 0.05, 'sine', 0.3); tone(2000, 0.12, 'sine', 0.3, 0, 0.05); break;
    case 'respawn': tone(330, 0.1, 'triangle', 0.3); tone(440, 0.15, 'triangle', 0.3, 0, 0.1); break;
    case 'select': tone(700, 0.04, 'square', 0.12); break;
  }
}
