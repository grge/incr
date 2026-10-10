// Small synthesized sound palette. Everything is generated with WebAudio;
// there are no sound files.

let ctx = null, master = null, noiseBuf = null;
let enabled = true, volume = 0.5;
let lastTick = 0, tickBudget = 0;

function init() {
  if (ctx) return ctx;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  ctx = new AC();
  master = ctx.createGain();
  master.gain.value = volume * 0.6;
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -18;
  comp.ratio.value = 4;
  master.connect(comp);
  comp.connect(ctx.destination);
  noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 1.5, ctx.sampleRate);
  const d = noiseBuf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  return ctx;
}

export function unlock() {
  if (!enabled) return;
  const c = init();
  if (c && c.state === 'suspended') c.resume();
}

export function setEnabled(on) {
  enabled = on;
  if (on && ctx) unlock();
  if (master) master.gain.value = on ? volume * 0.6 : 0;
}

export function setVolume(v) {
  volume = v;
  if (master && enabled) master.gain.value = v * 0.6;
}

function ready() { return enabled && ctx && ctx.state === 'running'; }

function noise(start, dur, freq, q, gain, type = 'bandpass') {
  const src = ctx.createBufferSource();
  src.buffer = noiseBuf;
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.frequency.value = freq;
  f.Q.value = q;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, start);
  g.gain.exponentialRampToValueAtTime(gain, start + 0.004);
  g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
  src.connect(f); f.connect(g); g.connect(master);
  src.start(start, Math.random() * 1.2, dur + 0.05);
  return f;
}

function tone(start, freq, dur, gain, type = 'sine') {
  const o = ctx.createOscillator();
  o.type = type;
  o.frequency.value = freq;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, start);
  g.gain.exponentialRampToValueAtTime(gain, start + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
  o.connect(g); g.connect(master);
  o.start(start);
  o.stop(start + dur + 0.05);
}

// Called every frame with the number of cells that toppled recently.
export function topples(cells) {
  if (!ready() || cells <= 0) return;
  const now = ctx.currentTime;
  tickBudget = Math.min(3, tickBudget + (now - lastTick) * 22);
  lastTick = now;
  if (tickBudget < 1) return;
  const n = Math.min(2, Math.floor(tickBudget));
  for (let k = 0; k < n; k++) {
    tickBudget -= 1;
    const loud = Math.min(1, 0.25 + Math.log10(1 + cells) * 0.3);
    noise(now + Math.random() * 0.03, 0.03 + Math.random() * 0.04, 2200 + Math.random() * 3800, 1.4, 0.05 * loud);
  }
}

export function drop() {
  if (!ready()) return;
  const now = ctx.currentTime;
  noise(now, 0.05, 1400 + Math.random() * 600, 2, 0.05);
}

export function quake() {
  if (!ready()) return;
  const now = ctx.currentTime;
  noise(now, 1.4, 90, 0.7, 0.5, 'lowpass');
  noise(now + 0.05, 1.1, 260, 0.9, 0.18, 'lowpass');
  const o = ctx.createOscillator();
  o.frequency.setValueAtTime(58, now);
  o.frequency.exponentialRampToValueAtTime(32, now + 1.2);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, now);
  g.gain.exponentialRampToValueAtTime(0.35, now + 0.05);
  g.gain.exponentialRampToValueAtTime(0.0001, now + 1.3);
  o.connect(g); g.connect(master);
  o.start(now); o.stop(now + 1.4);
}

export function gleamAppear() {
  if (!ready()) return;
  const now = ctx.currentTime;
  tone(now, 1568, 0.5, 0.05);
  tone(now + 0.07, 2093, 0.6, 0.04);
}

export function gleamCatch() {
  if (!ready()) return;
  const now = ctx.currentTime;
  [784, 988, 1175, 1568].forEach((f, i) => tone(now + i * 0.06, f, 0.7, 0.07, 'triangle'));
}

export function buy() {
  if (!ready()) return;
  const now = ctx.currentTime;
  tone(now, 660, 0.12, 0.05, 'triangle');
  noise(now, 0.04, 3000, 1.5, 0.03);
}

export function achievement() {
  if (!ready()) return;
  const now = ctx.currentTime;
  tone(now, 880, 0.5, 0.07, 'triangle');
  tone(now + 0.12, 1320, 0.8, 0.06, 'triangle');
}

export function milestone() {
  if (!ready()) return;
  const now = ctx.currentTime;
  [523, 659, 784].forEach((f, i) => tone(now + i * 0.08, f, 0.6, 0.06, 'triangle'));
}

export function sweep() {
  if (!ready()) return;
  const now = ctx.currentTime;
  const src = ctx.createBufferSource();
  src.buffer = noiseBuf;
  const f = ctx.createBiquadFilter();
  f.type = 'bandpass';
  f.Q.value = 0.8;
  f.frequency.setValueAtTime(4000, now);
  f.frequency.exponentialRampToValueAtTime(200, now + 1.4);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, now);
  g.gain.exponentialRampToValueAtTime(0.25, now + 0.2);
  g.gain.exponentialRampToValueAtTime(0.0001, now + 1.5);
  src.connect(f); f.connect(g); g.connect(master);
  src.start(now, 0, 1.5);
  tone(now + 0.9, 392, 1.6, 0.05, 'sine');
  tone(now + 1.0, 587, 1.8, 0.04, 'sine');
}

export function ending() {
  if (!ready()) return;
  const now = ctx.currentTime;
  [262, 330, 392, 523, 659, 784].forEach((f, i) => tone(now + i * 0.35, f, 3, 0.05, 'sine'));
}
