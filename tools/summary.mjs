// Summarise a full bot playthrough for each player profile.
// Usage: node tools/summary.mjs [hours]
import { simulate, noveltyGaps } from './bot.mjs';
import { fmtTime } from '../js/format.js';

const hours = +(process.argv[2] || 8);
const relicAt = (n) => (r) => { const t = Object.values(r.relics).sort((a, b) => a - b); return t[n - 1]; };
const keys = [
  ['first sweep', r => r.events.find(e => e.type === 'sweep')?.t],
  ['stones', r => r.relics.chisel],
  ['doctrines', r => r.relics.ledger],
  ['prisms', r => r.relics.shard],
  ['fold', r => r.relics.nail],
  ['trials', r => r.relics.tablet],
  ['12 relics', relicAt(12)],
  ['cascade', r => r.purchases.k_cascade],
  ['third table', r => r.purchases.k_cascade2],
  ['all relics', relicAt(24)],
  ['the plans', r => r.purchases.k_great],
  ['all trials', r => { const t = Object.values(r.trialsDone).map(x => x.t); return t.length === 6 ? Math.max(...t) : undefined; }],
  ['ENDING', r => r.endedAt ?? undefined],
];
for (const profile of (process.argv[3] ? [process.argv[3]] : ['active', 'casual', 'idle'])) {
  const r = simulate({ hours, profile });
  const sweeps = r.events.filter(e => e.type === 'sweep');
  const normal = sweeps.filter(e => !e.trial);
  const avg = normal.length ? normal.reduce((a, e) => a + e.runT, 0) / normal.length : 0;
  const gaps = noveltyGaps(r).slice(0, 4).map(g => `${fmtTime(g.len)} @${fmtTime(g.from)}`).join(', ');
  console.log(`\n== ${profile} == sweeps ${sweeps.length}, avg normal run ${fmtTime(avg)}, trial fails ${r.log.filter(l => l.includes('FAILED')).length}, new things ${r.novelty.length}`);
  console.log(keys.map(([k, f]) => `${k}: ${f(r) !== undefined ? fmtTime(f(r)) : '—'}`).join(' · '));
  console.log(`longest gaps without anything new: ${gaps}`);
}
