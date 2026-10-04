// Iteratively adjust content costs so the bot reaches each purchase at a target time.
// Usage: node tools/calibrate.mjs <targets.json> [iterations]
import fs from 'node:fs';
import * as D from '../js/data.js';
import { simulate, applyOverrides } from './bot.mjs';

const targets = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const iters = +(process.argv[3] || 8);
const hours = targets.hours || 1;
const profile = targets.profile || 'active';
const ov = { upgrades: {}, kiln: {}, trials: {}, great: {} };
for (const id in targets.upgrades || {}) ov.upgrades[id] = D.UPGRADE_MAP[id].cost;
for (const id in targets.kiln || {}) ov.kiln[id] = D.KILN_MAP[id].cost;
for (const id in targets.trials || {}) ov.trials[id] = D.TRIAL_MAP[id].goal;
for (const id in targets.great || {}) { const g = D.GREAT.find(x => x.id === id); ov.great[id] = { glass: g.glass, sand: g.sand }; }

function nice(c) {
  if (c <= 0) return 0;
  const e = Math.floor(Math.log10(c));
  const m = c / Math.pow(10, e);
  const opts = [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 7, 8, 10];
  let best = 1;
  for (const x of opts) if (Math.abs(Math.log(x / m)) < Math.abs(Math.log(best / m))) best = x;
  return +(best * Math.pow(10, e)).toPrecision(3);
}

const damp = targets.damp || 1.2;
let bestErr = Infinity, bestOv = null;
for (let it = 0; it < iters; it++) {
  applyOverrides(ov);
  const r = simulate({ hours, profile, noSweep: !!targets.noSweep });
  let err = 0;
  const rows = [];
  const adjust = (got, tgt) => {
    const ratio = got === undefined ? 2.5 : (got + 60) / (tgt + 60);
    err += Math.abs(Math.log(ratio));
    return Math.pow(1 / Math.max(0.05, Math.min(20, ratio)), damp);
  };
  for (const id in targets.upgrades || {}) {
    const got = r.purchases[id], tgt = targets.upgrades[id];
    ov.upgrades[id] *= Math.pow(adjust(got, tgt), 4);
    rows.push(`${id.padEnd(14)} tgt ${String(tgt).padStart(6)} got ${String(got ?? '-').padStart(6)} cost ${ov.upgrades[id].toExponential(2)}`);
  }
  for (const id in targets.kiln || {}) {
    const got = r.purchases[id], tgt = targets.kiln[id];
    ov.kiln[id] *= Math.pow(adjust(got, tgt), 2.5);
    rows.push(`${id.padEnd(14)} tgt ${String(tgt).padStart(6)} got ${String(got ?? '-').padStart(6)} cost ${ov.kiln[id].toExponential(2)}`);
  }
  for (const id in targets.trials || {}) {
    const tgt = targets.trials[id];
    const done = r.trialsDone[id];
    let f;
    if (!done) { f = r.events.some(e => e.trial === id) ? 0.03 : 1; err += 1; }
    else { const ratio = (done.runT + 30) / (tgt + 30); err += Math.abs(Math.log(ratio)); f = Math.pow(1 / ratio, 3); }
    ov.trials[id] *= f;
    rows.push(`${id.padEnd(14)} tgt ${String(tgt).padStart(6)} got ${String(done ? done.runT : '-').padStart(6)} goal ${ov.trials[id].toExponential(2)}`);
  }
  for (const id in targets.great || {}) {
    const idx = D.GREAT.findIndex(x => x.id === id) + 1;
    const got = r.greats[idx], tgt = targets.great[id];
    const f = Math.pow(adjust(got, tgt), 2.5);
    ov.great[id].glass *= f;
    ov.great[id].sand *= f;
    rows.push(`${id.padEnd(14)} tgt ${String(tgt).padStart(6)} got ${String(got ?? '-').padStart(6)} glass ${ov.great[id].glass.toExponential(2)} sand ${ov.great[id].sand.toExponential(2)}`);
  }
  console.log(`iter ${it} err ${err.toFixed(2)} ended ${r.endedAt}`);
  if (err < bestErr) { bestErr = err; bestOv = JSON.parse(JSON.stringify(ov)); }
  if (it === iters - 1 || err < 0.3) { console.log(rows.join('\n')); break; }
}
const out = { upgrades: {}, kiln: {}, trials: {}, great: {} };
for (const id in bestOv.upgrades) out.upgrades[id] = nice(bestOv.upgrades[id]);
for (const id in bestOv.kiln) out.kiln[id] = nice(bestOv.kiln[id]);
for (const id in bestOv.trials) out.trials[id] = nice(bestOv.trials[id]);
for (const id in bestOv.great) out.great[id] = { glass: nice(bestOv.great[id].glass), sand: nice(bestOv.great[id].sand) };
fs.writeFileSync(targets.out || 'tools/scratch/calibrated.json', JSON.stringify(out, null, 1));
console.log('best err', bestErr.toFixed(2), '->', targets.out || 'tools/scratch/calibrated.json');
