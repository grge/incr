// Joint tuning of the late game with full playthroughs. Late kiln items,
// late upgrades, trial goals and the Great Hourglass all feed each other
// (each speeds up the next), so they are tuned together rather than one by one.
// Usage: node tools/tune_late.mjs base.json [iterations] [out.json]
import fs from 'node:fs';
import * as D from '../js/data.js';
import { simulate, applyOverrides } from './bot.mjs';
import { fmtTime } from '../js/format.js';

const base = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const iters = +(process.argv[3] || 10);
const outFile = process.argv[4] || 'tools/scratch/late.json';
const targets = JSON.parse(fs.readFileSync('tools/targets.json', 'utf8'));
const late = targets.late;

const ov = JSON.parse(JSON.stringify(base));
const items = [];
for (const id in late.kiln) items.push({ kind: 'kiln', id, tgt: late.kiln[id] });
for (const id in late.upgrades) items.push({ kind: 'upgrades', id, tgt: late.upgrades[id] });
for (const id in late.great) items.push({ kind: 'great', id, tgt: late.great[id] });
for (const id in targets.trials) items.push({ kind: 'trials', id, tgt: targets.trials[id] });
for (const it of items) {
  it.gain = it.kind === 'trials' ? 6 : 25;
  it.prevErr = null;
  if (it.kind === 'great') {
    const g = D.GREAT.find(x => x.id === it.id);
    ov.great[it.id] = ov.great[it.id] || { glass: g.glass, sand: g.sand };
    it.field = g.glass ? 'glass' : 'sand';
  } else if (ov[it.kind][it.id] === undefined) {
    ov[it.kind][it.id] = it.kind === 'kiln' ? D.KILN_MAP[it.id].cost : it.kind === 'upgrades' ? D.UPGRADE_MAP[it.id].cost : D.TRIAL_MAP[it.id].goal;
  }
}
const get = (it) => it.kind === 'great' ? ov.great[it.id][it.field] : ov[it.kind][it.id];
const set = (it, v) => { if (it.kind === 'great') ov.great[it.id][it.field] = v; else ov[it.kind][it.id] = v; };

let best = null;
const MAX = Math.log(1e4);
for (let n = 0; n < iters; n++) {
  applyOverrides(ov);
  const r = simulate({ hours: 6, profile: 'active' });
  const horizon = r.t;
  let err = 0;
  const rows = [];
  for (const it of items) {
    let got, e;
    if (it.kind === 'trials') {
      const d = r.trialsDone[it.id];
      got = d ? d.runT : undefined;
      e = got === undefined ? Math.log(4) : Math.log((got + 30) / (it.tgt + 30));
    } else {
      got = it.kind === 'great' ? r.greats[D.GREAT.findIndex(g => g.id === it.id) + 1] : r.purchases[it.id];
      e = got === undefined ? Math.log((horizon + 1800) / (it.tgt + 300)) : Math.log((got + 300) / (it.tgt + 300));
    }
    it.err = e;
    err += Math.abs(e);
    rows.push(`${it.id} ${got === undefined ? '-' : (it.kind === 'trials' ? got + 's' : fmtTime(got))}`);
  }
  console.log(`iter ${n} err ${err.toFixed(2)} end ${r.endedAt ? fmtTime(r.endedAt) : '-'}\n  ${rows.join(' · ')}`);
  if (!best || err < best.err) best = { err, it: n, ov: JSON.parse(JSON.stringify(ov)) };
  fs.writeFileSync(outFile, JSON.stringify(best.ov, null, 1));
  // reached too late → cheaper; too early → dearer. Halve the gain whenever we overshoot.
  for (const it of items) {
    if (it.prevErr !== null && Math.sign(it.err) !== Math.sign(it.prevErr) && Math.abs(it.err) > 0.01) it.gain *= 0.5;
    it.prevErr = it.err;
    set(it, get(it) * Math.exp(Math.max(-MAX, Math.min(MAX, -it.gain * it.err))));
  }
}
console.log('best iter', best.it, best.err.toFixed(2));
