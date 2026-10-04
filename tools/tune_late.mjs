// Joint tuning of trial goals and late-game costs using full playthroughs.
// Usage: node tools/tune_late.mjs [iterations]
import fs from 'node:fs';
import * as D from '../js/data.js';
import { simulate, applyOverrides } from './bot.mjs';

const iters = +(process.argv[2] || 6);
const trialTarget = 360;
const kilnT = { k_kiln2: 10500, k_quarry: 11000, k_cascade: 11400, k_horizon: 12000, k_cascade2: 12600, k_furnace: 13200, k_great: 13900 };
const greatT = { g_frame: 14200, g_lower: 14600, g_neck: 15000, g_upper: 15500, g_fill: 16100 };
const ov = { trials: {}, kiln: {}, great: {} };
for (const t of D.TRIALS) ov.trials[t.id] = t.goal;
for (const id in kilnT) ov.kiln[id] = D.KILN_MAP[id].cost;
for (const id in greatT) { const g = D.GREAT.find(x => x.id === id); ov.great[id] = { glass: g.glass, sand: g.sand }; }

let best = null;
for (let it = 0; it < iters; it++) {
  applyOverrides(ov);
  const r = simulate({ hours: 6, profile: 'active' });
  let err = 0;
  const rows = [];
  for (const t of D.TRIALS) {
    const d = r.trialsDone[t.id];
    const got = d ? d.runT : 1500;
    const ratio = (got + 30) / (trialTarget + 30);
    err += Math.abs(Math.log(ratio));
    ov.trials[t.id] *= Math.pow(1 / ratio, d ? 2.5 : 6);
    rows.push(`${t.id} ${d ? d.runT : '-'}s`);
  }
  for (const id in kilnT) {
    const got = r.purchases[id] ?? 22000;
    const ratio = (got + 300) / (kilnT[id] + 300);
    err += Math.abs(Math.log(ratio)) * 3;
    ov.kiln[id] *= Math.pow(1 / ratio, 12);
    rows.push(`${id} ${got}/${kilnT[id]}`);
  }
  for (const id in greatT) {
    const idx = D.GREAT.findIndex(x => x.id === id) + 1;
    const got = r.greats[idx] ?? 22000;
    const ratio = (got + 300) / (greatT[id] + 300);
    err += Math.abs(Math.log(ratio)) * 3;
    const f = Math.pow(1 / ratio, 12);
    ov.great[id].glass *= f; ov.great[id].sand *= f;
    rows.push(`${id} ${got}/${greatT[id]}`);
  }
  console.log(`iter ${it} err ${err.toFixed(2)} end ${r.endedAt}\n  ${rows.join(' · ')}`);
  if (!best || err < best.err) best = { err, ov: JSON.parse(JSON.stringify(ov)), it };
}
fs.writeFileSync('tools/scratch/late.json', JSON.stringify(best, null, 1));
console.log('best iter', best.it, best.err.toFixed(2));
