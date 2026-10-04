// Sequential calibration: fix content costs one at a time, in target-time order.
// Later items are made unbuyable while earlier ones are tuned, so each step
// only depends on content that is already settled.
// Usage: node tools/calibrate_seq.mjs tools/targets.json [resumeIndex]
import fs from 'node:fs';
import * as D from '../js/data.js';
import { simulate, applyOverrides } from './bot.mjs';

const targets = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const outFile = targets.out || 'tools/scratch/calibrated.json';
const items = [];
for (const id in targets.upgrades || {}) items.push({ kind: 'upgrades', id, target: targets.upgrades[id] });
for (const id in targets.kiln || {}) items.push({ kind: 'kiln', id, target: targets.kiln[id] });
for (const id in targets.great || {}) items.push({ kind: 'great', id, target: targets.great[id] });
const trialIds = Object.keys(targets.trials || {});
// trials are attempted after k_trials, roughly every other sweep
trialIds.forEach((id, k) => items.push({ kind: 'trials', id, target: (targets.kiln?.k_trials || 0) + 400 + k * 900, runTarget: targets.trials[id] }));
items.sort((a, b) => a.target - b.target);

const ov = { upgrades: {}, kiln: {}, trials: {}, great: {} };
const initial = {};
for (const it of items) {
  if (it.kind === 'upgrades') { initial[it.id] = D.UPGRADE_MAP[it.id].cost; ov.upgrades[it.id] = Infinity; }
  if (it.kind === 'kiln') { initial[it.id] = D.KILN_MAP[it.id].cost; ov.kiln[it.id] = Infinity; }
  if (it.kind === 'trials') { initial[it.id] = D.TRIAL_MAP[it.id].goal; ov.trials[it.id] = Infinity; }
  if (it.kind === 'great') { const g = D.GREAT.find(x => x.id === it.id); initial[it.id] = { glass: g.glass, sand: g.sand }; ov.great[it.id] = { glass: Infinity, sand: Infinity }; }
}
const resume = +(process.argv[3] || 0);
const prev = resume && fs.existsSync(outFile) ? JSON.parse(fs.readFileSync(outFile, 'utf8')) : null;

function setCost(it, c) {
  if (it.kind === 'great') {
    const i0 = initial[it.id];
    ov.great[it.id] = i0.glass ? { glass: c, sand: i0.sand ? c * i0.sand / i0.glass : 0 } : { glass: 0, sand: c };
  } else ov[it.kind][it.id] = c;
}
function startCost(it) {
  const c = initial[it.id];
  return it.kind === 'great' ? (c.glass || c.sand) : c;
}
function measure(r, it) {
  if (it.kind === 'trials') return r.trialsDone[it.id] ? r.trialsDone[it.id].runT : undefined;
  if (it.kind === 'great') return r.greats[D.GREAT.findIndex(g => g.id === it.id) + 1];
  return r.purchases[it.id];
}
function save() {
  const out = { upgrades: {}, kiln: {}, trials: {}, great: {} };
  for (const k of ['upgrades', 'kiln', 'trials']) for (const id in ov[k]) if (Number.isFinite(ov[k][id])) out[k][id] = +ov[k][id].toPrecision(2);
  for (const id in ov.great) if (Number.isFinite(ov.great[id].glass)) out.great[id] = { glass: +ov.great[id].glass.toPrecision(2), sand: +ov.great[id].sand.toPrecision(2) };
  fs.writeFileSync(outFile, JSON.stringify(out, null, 1));
}

for (let idx = 0; idx < items.length; idx++) {
  const it = items[idx];
  if (prev && idx < resume) {
    const v = prev[it.kind]?.[it.id];
    if (v !== undefined) { if (it.kind === 'great') ov.great[it.id] = v; else ov[it.kind][it.id] = v; continue; }
  }
  const tgt = it.kind === 'trials' ? it.runTarget : it.target;
  let logC = Math.log(startCost(it));
  const pts = [];
  let best = null;
  for (let attempt = 0; attempt < 8; attempt++) {
    setCost(it, Math.exp(logC));
    applyOverrides(ov);
    const horizon = it.kind === 'trials' ? it.target + 3600 : it.target + 1500;
    const r = simulate({ hours: horizon / 3600, profile: targets.profile || 'active', stopWhen: it });
    const got = measure(r, it);
    const err = got === undefined ? Infinity : Math.log((got + 60) / (tgt + 60));
    if (!best || Math.abs(err) < Math.abs(best.err)) best = { logC, err, got };
    console.log(`${String(idx).padStart(2)} ${it.id.padEnd(14)} try ${attempt} cost ${Math.exp(logC).toExponential(2)} got ${got ?? '-'} tgt ${tgt}`);
    if (Math.abs(err) < 0.05) break;
    if (got === undefined) { logC -= Math.log(it.kind === 'trials' ? 100 : 6); pts.length = 0; continue; }
    pts.push([logC, err]);
    if (pts.length >= 2) {
      const [a, b] = pts.slice(-2);
      const slope = (b[1] - a[1]) / (b[0] - a[0]);
      if (slope > 1e-3 && Number.isFinite(slope)) { logC = b[0] - b[1] / slope; continue; }
    }
    logC -= err / (it.kind === 'trials' ? 0.06 : 0.1);
  }
  setCost(it, Math.exp(best.logC));
  save();
}
console.log('done');
