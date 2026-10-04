// Summarise a full bot playthrough for each player profile.
// Usage: node tools/summary.mjs [hours]
import { simulate } from './bot.mjs';
import { fmtTime } from '../js/format.js';

const hours = +(process.argv[2] || 8);
const keys = [
  ['first sweep', r => r.events.find(e => e.type === 'sweep')?.t],
  ['stones', r => r.purchases.k_stones],
  ['doctrines', r => r.purchases.k_doctrines],
  ['fold', r => r.purchases.k_fold],
  ['prisms', r => r.purchases.k_prisms],
  ['trials', r => r.purchases.k_trials],
  ['cascade', r => r.purchases.k_cascade],
  ['third table', r => r.purchases.k_cascade2],
  ['the plans', r => r.purchases.k_great],
  ['all trials', r => { const t = Object.values(r.trialsDone).map(x => x.t); return t.length === 6 ? Math.max(...t) : undefined; }],
  ['ENDING', r => r.endedAt ?? undefined],
];
for (const profile of ['active', 'casual', 'idle']) {
  const r = simulate({ hours, profile });
  const sweeps = r.events.filter(e => e.type === 'sweep');
  const normal = sweeps.filter(e => !e.trial);
  const avg = normal.length ? normal.reduce((a, e) => a + e.runT, 0) / normal.length : 0;
  console.log(`\n== ${profile} == sweeps ${sweeps.length}, avg normal run ${fmtTime(avg)}, trial fails ${r.log.filter(l => l.includes('FAILED')).length}`);
  console.log(keys.map(([k, f]) => `${k}: ${f(r) !== undefined ? fmtTime(f(r)) : '—'}`).join(' · '));
}
