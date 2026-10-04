// Headless balance bot. Plays the game with the analytic steady-state model
// (the same model the game uses for offline progress), making decisions the
// way a reasonably attentive player might.
//
// Usage: node tools/bot.mjs [hours] [profile] [-v] [--nosweep]
import { Game } from '../js/game.js';
import * as D from '../js/data.js';
import { fmt, fmtTime } from '../js/format.js';

function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

export const PROFILES = {
  // clicks/sec while clicking is worthwhile, gleam catch chance, uses quakes
  active: { clicksPerSec: 3, clickUntil: 1e9, quake: true, gleam: 0.8, think: 1 },
  casual: { clicksPerSec: 1, clickUntil: 900, quake: true, gleam: 0.4, think: 5 },
  idle: { clicksPerSec: 0.3, clickUntil: 300, quake: false, gleam: 0.1, think: 30 },
};

export function applyOverrides(o = {}) {
  for (const id in (o.upgrades || {})) D.UPGRADE_MAP[id].cost = o.upgrades[id];
  for (const id in (o.kiln || {})) D.KILN_MAP[id].cost = o.kiln[id];
  for (const id in (o.trials || {})) D.TRIAL_MAP[id].goal = o.trials[id];
  for (const id in (o.great || {})) {
    const g = D.GREAT.find(x => x.id === id);
    Object.assign(g, o.great[id]);
  }
}

export function simulate({ hours = 5, profile = 'active', verbose = false, noSweep = false, seed = 12345, stopWhen = null } = {}) {
  const prof = PROFILES[profile];
  const g = new Game({ analytic: true, rng: mulberry32(seed) });
  const log = [];
  const purchases = {};
  const events = [];
  const trialsDone = {};
  const greats = {};
  let t = 0;
  const T = (x) => fmtTime(x).padStart(8);
  const note = (msg) => { const line = `${T(t)}  ${msg}`; log.push(line); if (verbose) console.log(line); };

  let peakRate = 0, runStartT = 0, lastReport = 0, endedAt = null, trialStart = 0;
  let sinceTrial = 0;
  let noStoneUntil = 0;
  const deferred = {};
  const seen = new Set();
  const totalT = hours * 3600;

  function options() {
    const opts = [];
    for (const u of D.UPGRADES) if (g.upgradeAvailable(u)) opts.push({ kind: 'up', id: u.id, cost: u.cost });
    for (const b of ['hourglass', 'crystal', 'prism']) if (g.buildingUnlocked(b)) opts.push({ kind: 'b', id: b, cost: g.costOf(b) });
    if (g.buildingUnlocked('stone') && g.s.owned.stone < g.stoneLimit()) opts.push({ kind: 'stone', id: 'stone', cost: g.costOf('stone') });
    return opts.sort((a, b) => a.cost - b.cost);
  }

  function buyStuff() {
    let stoneTried = false;
    for (let guard = 0; guard < 300; guard++) {
      const opts = options().filter(o => !(o.kind === 'stone' && (stoneTried || t % 15 !== 0)));
      const o = opts[0];
      if (!o || g.s.dust < o.cost) break;
      if (o.kind === 'up') {
        g.buyUpgrade(o.id);
        if (!(o.id in purchases)) purchases[o.id] = t;
        note(`buy ${D.UPGRADE_MAP[o.id].name} (${fmt(o.cost)})  rate ${fmt(g.baseRate())}/s hg ${g.s.owned.hourglass} cr ${g.s.owned.crystal}`);
      } else if (o.kind === 'b') g.buyBuilding(o.id);
      else {
        stoneTried = true;
        if (noStoneUntil > t) continue;
        g.buyBuilding('stone', true); // blueprint first
        if (g.s.inv.stone > 0) {
          const sug = g.suggestStone();
          if (sug) g.place('stone', sug.t, sug.i, true);
          else noStoneUntil = t + 120;
        }
      }
    }
  }

  function buyKiln() {
    for (let guard = 0; guard < 200; guard++) {
      const av = D.KILN.filter(k => g.kilnAvailable(k)).sort((a, b) => a.cost - b.cost);
      const k = av[0];
      const pc = g.polishCost();
      if (k && g.s.glass >= k.cost && k.cost <= pc * 5) {
        g.buyKiln(k.id);
        if (!(k.id in purchases)) purchases[k.id] = t;
        note(`KILN ${k.name} (${fmt(k.cost)} glass)`);
        continue;
      }
      if (g.s.glass >= pc && (!k || pc * 5 < k.cost)) { g.buyPolish(); continue; }
      break;
    }
    while (g.canBuildGreat()) {
      g.buildGreat();
      greats[g.s.great] = t;
      note(`GREAT stage ${g.s.great}: ${D.GREAT[g.s.great - 1].name}`);
    }
  }

  function chooseDoctrine() {
    if (!g.has('doctrine')) return null;
    let best = null, bestR = -1;
    for (const d of ['flow', 'facet']) {
      const prev = g.s.doctrine;
      g.s.doctrine = d; g.recomputeFx();
      const r = g.baseRate();
      if (r > bestR) { bestR = r; best = d; }
      g.s.doctrine = prev; g.recomputeFx();
    }
    return best;
  }

  function doSweep(trial = null) {
    const gain = g.glassGain();
    const runT = t - runStartT;
    events.push({ t, type: 'sweep', gain, runT, trial: g.s.trial });
    note(`SWEEP #${g.s.sweeps + 1} +${fmt(gain)} glass after ${fmtTime(runT)} (run ${fmt(g.s.dustRun)}, ${fmt(g.baseRate())}/s, ${g.boards[0].size}², hg ${g.s.owned.hourglass} cr ${g.s.owned.crystal} st ${g.s.owned.stone} pr ${g.s.owned.prism}, ${g.boards.length} tables)${g.s.trial ? ' [trial ' + g.s.trial + ']' : ''}`);
    const doc = chooseDoctrine();
    g.sweep(doc, trial);
    if (trial) { note(`  start trial ${trial}`); trialStart = t; sinceTrial = 0; } else sinceTrial++;
    runStartT = t;
    peakRate = 0;
    noStoneUntil = 0;
    buyKiln();
  }

  while (t < totalT) {
    // player actions
    if (g.canClick() && t < prof.clickUntil) {
      const a = g.analyze();
      const at = a.tables[0];
      let bv = 0;
      for (let i = 0; i < at.v.length; i++) bv = Math.max(bv, at.v[i] + (at.X ? at.X[i] : 1) * at.down);
      g.gainDust(prof.clicksPerSec * g.handGrains() * bv * g.dustMult());
    }
    if (prof.quake && g.canQuake() && g.s.quakeCd <= 0) g.quake();
    if (g.s.gleam && g.rng() < prof.gleam / 6) g.catchGleam();
    g.tick(1);
    t += 1;
    for (const e of g.drainEvents()) {
      if (e.type === 'bought' && D.UPGRADE_MAP[e.what] && !(e.what in purchases)) purchases[e.what] = t;
      if (e.type === 'trialDone') { trialsDone[e.id] = { t, runT: t - trialStart }; note(`TRIAL DONE ${e.id} after ${fmtTime(t - trialStart)}`); }
      if (verbose && (e.type === 'ach' || e.type === 'journal')) note(`${e.type} ${e.id}`);
    }
    if (t % prof.think === 0) buyStuff();
    for (const f of ['crystal', 'quake', 'gleam', 'stone', 'fold', 'prism', 'doctrine', 'trials', 'great']) {
      if (!seen.has(f) && g.has(f)) { seen.add(f); note(`UNLOCK ${f}`); }
    }
    if (!g.s.fold && g.has('fold')) g.setFold(true);
    if (g.has('doctrine') && !g.s.doctrine) g.setDoctrine(chooseDoctrine());
    if (t % 10 === 0) buyKiln();

    // sweep policy
    const runT = t - runStartT;
    const gain = g.glassGain();
    if (g.s.trial) {
      if (g.s.trials[g.s.trial] || runT > 1200) {
        if (!g.s.trials[g.s.trial]) { deferred[g.s.trial] = 3; note(`  trial ${g.s.trial} FAILED (${fmt(g.s.dustRun)} / ${fmt(D.TRIAL_MAP[g.s.trial].goal)})`); }
        doSweep(null);
      }
    } else if (gain >= 1 && !noSweep) {
      const rate = gain / Math.max(1, runT);
      peakRate = Math.max(peakRate, rate);
      const next = D.KILN.filter(k => g.kilnAvailable(k)).sort((a, b) => a.cost - b.cost)[0];
      const need = next ? next.cost - g.s.glass : Infinity;
      const enough = gain >= Math.max(1, Math.min(g.s.glassAll * 0.5, need));
      if ((enough && rate < peakRate * 0.9 && runT > 120) || runT > 2400) {
        let trial = null;
        if (g.has('trials') && sinceTrial >= 1) {
          // easiest-looking open trial that has not failed recently
          const open = D.TRIALS.filter(tr => !g.s.trials[tr.id] && Number.isFinite(tr.goal) && !(deferred[tr.id] > 0))
            .sort((a, b) => a.goal - b.goal);
          for (const id in deferred) deferred[id]--;
          if (open.length) trial = open[0].id;
        }
        doSweep(trial);
      }
    }
    if (stopWhen) {
      const it = stopWhen;
      if (it.kind === 'trials' ? trialsDone[it.id] : it.kind === 'great' ? greats[D.GREAT.findIndex(x => x.id === it.id) + 1] !== undefined : purchases[it.id] !== undefined) break;
    }
    if (g.s.great >= D.GREAT.length && endedAt === null) { endedAt = t; note('*** THE GREAT HOURGLASS IS COMPLETE ***'); }
    if (t - lastReport >= 600) {
      lastReport = t;
      note(`.. run ${fmt(g.s.dustRun)} ${fmt(g.baseRate())}/s glass ${fmt(g.s.glass)}/${fmt(g.s.glassAll)} sand ${fmt(g.s.sand)} ach ${g.achCount()} linger ${g.bestLinger.toFixed(1)} polish ${g.s.polish}`);
    }
  }
  return { log, purchases, events, trialsDone, greats, endedAt, game: g };
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  if (process.env.BOT_OVERRIDES) applyOverrides(JSON.parse(process.env.BOT_OVERRIDES));
  const args = process.argv.slice(2).filter(a => !a.startsWith('-'));
  const verbose = process.argv.includes('-v');
  const r = simulate({ hours: +(args[0] || 5), profile: args[1] || 'active', verbose, noSweep: process.argv.includes('--nosweep') });
  if (process.env.BOT_JSON) console.log(JSON.stringify({ purchases: r.purchases, events: r.events, trialsDone: r.trialsDone, greats: r.greats, endedAt: r.endedAt }));
  else if (!verbose) console.log(r.log.join('\n'));
}
