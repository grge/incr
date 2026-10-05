// Headless balance bot. Plays the game with the analytic steady-state model
// (the same model the game uses for offline progress), making decisions the
// way a reasonably attentive player might: it digs for relics by moving its
// hourglass stack onto dig sites, picks tables with things buried in them,
// sets stones where they help and sweeps when glass stops coming quickly.
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
  // clicks/sec while clicking is worthwhile, gleam catch chance, uses quakes,
  // seconds between decisions, how long a dig may take before the stack is moved onto it
  active: { clicksPerSec: 3, clickUntil: 1e9, quake: true, gleam: 0.8, think: 1, digPatience: 45 },
  casual: { clicksPerSec: 1, clickUntil: 900, quake: true, gleam: 0.4, think: 5, digPatience: 120 },
  idle: { clicksPerSec: 0.3, clickUntil: 300, quake: false, gleam: 0.1, think: 30, digPatience: 400 },
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
  const g = new Game({ analytic: true, rng: mulberry32(seed), seed });
  const log = [];
  const purchases = {};
  const events = [];
  const trialsDone = {};
  const greats = {};
  const relics = {};
  const novelty = [];   // [t, what] for every genuinely new thing
  let t = 0;
  const T = (x) => fmtTime(x).padStart(8);
  const note = (msg) => { const line = `${T(t)}  ${msg}`; log.push(line); if (verbose) console.log(line); };
  const isNew = (what) => { novelty.push([t, what]); };

  let peakRate = 0, runStartT = 0, lastReport = 0, endedAt = null, trialStart = 0;
  let sinceTrial = 0;
  let bestRun = 0;   // dust in the strongest recent normal run
  let noStoneUntil = 0;
  const deferred = {};
  const seen = new Set();
  const totalT = hours * 3600;
  const digSeen = new WeakMap();
  const digTimes = [];

  function options() {
    const opts = [];
    for (const u of D.UPGRADES) if (g.upgradeAvailable(u)) opts.push({ kind: 'up', id: u.id, cost: u.cost });
    for (const b of ['hourglass', 'crystal', 'prism']) if (g.buildingUnlocked(b) && g.s.owned[b] < g.buildingLimit(b)) opts.push({ kind: 'b', id: b, cost: g.costOf(b) });
    if (g.buildingUnlocked('stone') && g.s.owned.stone < g.stoneLimit()) opts.push({ kind: 'stone', id: 'stone', cost: g.costOf('stone') });
    return opts.sort((a, b) => a.cost - b.cost);
  }

  function buyStuff() {
    let stoneTried = false;
    for (let guard = 0; guard < 300; guard++) {
      const opts = options().filter(o => !(o.kind === 'stone' && (stoneTried || t % 15 !== 0 || noStoneUntil > t)));
      const o = opts[0];
      if (!o || g.s.dust < o.cost) break;
      if (o.kind === 'up') {
        g.buyUpgrade(o.id);
        if (!(o.id in purchases)) { purchases[o.id] = t; isNew('upgrade ' + o.id); }
        note(`buy ${D.UPGRADE_MAP[o.id].name} (${fmt(o.cost)})  rate ${fmt(g.baseRate())}/s hg ${g.s.owned.hourglass} cr ${g.s.owned.crystal}`);
      } else if (o.kind === 'b') {
        g.buyBuilding(o.id);
      } else {
        stoneTried = true;
        // only buy a stone if there is somewhere useful to put it
        const sug = g.suggestStone();
        if (!sug) { noStoneUntil = t + 120; continue; }
        g.buyBuilding('stone', false);
        g.place('stone', sug.t, sug.i, true);
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
        if (!(k.id in purchases)) { purchases[k.id] = t; isNew('kiln ' + k.id); }
        note(`KILN ${k.name} (${fmt(k.cost)} glass)`);
        continue;
      }
      const gs = g.has('great') ? g.greatNext() : null;
      const saveFor = Math.min(k ? k.cost : Infinity, gs && gs.glass ? gs.glass : Infinity);
      if (g.s.glass >= pc && pc * 5 < saveFor) { g.buyPolish(); continue; }
      break;
    }
    while (g.canBuildGreat()) {
      g.buildGreat();
      greats[g.s.great] = t;
      isNew('great ' + g.s.great);
      note(`GREAT stage ${g.s.great}: ${D.GREAT[g.s.great - 1].name}`);
    }
  }

  // The cell of table t where a grain is worth most.
  function bestCell(t) {
    const b = g.boards[t];
    let best = -1, bv = -1;
    for (let i = 0; i < b.n; i++) {
      if (b.isVoid(i)) continue;
      const v = g.grainValue(t, i);
      if (v > bv) { bv = v; best = i; }
    }
    return best;
  }

  function biggestStack() {
    let st = null;
    g.boards.forEach((b, t) => { for (const i of b.hourglasses) if (!st || b.hg[i] > st.n) st = { t, i, n: b.hg[i] }; });
    return st;
  }

  // The dig the bot is working on, if any.
  function targetDig() {
    const digs = g.visibleDigs();
    if (!digs.length) return null;
    digs.sort((a, b) => (a.need - a.prog) - (b.need - b.prog));
    return digs[0];
  }

  // Move the stack onto a slow dig, or back to the best cell; steer funnels the same way.
  function manageStack() {
    const st = biggestStack();
    const dig = targetDig();
    if (st) {
      let target = -1;
      if (dig && dig.t === st.t) {
        const cell = g.digCell(dig);
        const eta = (dig.need - dig.prog) / Math.max(1e-9, g.digRate(dig));
        if (cell === st.i || eta > prof.digPatience) target = cell;
      }
      if (target < 0) target = bestCell(st.t);
      if (target >= 0 && target !== st.i) g.move(st.t, st.i, target);
    }
    for (let t2 = 1; t2 < g.boards.length; t2++) {
      const b = g.boards[t2];
      const d2 = g.visibleDigs().find(d => d.t === t2);
      const want = d2 ? g.digCell(d2) : bestCell(t2);
      if (want >= 0 && b.funnel !== want) g.moveFunnel(t2, want);
    }
  }

  function clickCell() {
    const dig = targetDig();
    if (dig) return [dig.t, g.digCell(dig)];
    return [0, bestCell(0)];
  }

  function chooseDoctrine(table) {
    if (!g.has('doctrine')) return null;
    const relicsLeft = D.RELICS.length - g.relicCount();
    if (relicsLeft > 0 && table && table.features.dig >= 2 && g.doctrineAvailable('delve')) return 'delve';
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

  function chooseTable() {
    const cands = g.candidates();
    const relicsLeft = D.RELICS.length - g.relicCount();
    let best = 0, bs = -Infinity;
    cands.forEach((c, k) => {
      const f = c.features;
      const score = (relicsLeft > 0 ? 3 : 0.5) * f.dig + 0.2 * f.geode + 1.0 * f.spring - 0.3 * f.crack;
      if (score > bs) { bs = score; best = k; }
    });
    return best;
  }

  function doSweep(trial = null) {
    if (!g.s.trial) bestRun = Math.max(bestRun * 0.5, g.s.dustRun);
    const gain = g.glassGain();
    const runT = t - runStartT;
    events.push({ t, type: 'sweep', gain, runT, trial: g.s.trial });
    note(`SWEEP #${g.s.sweeps + 1} +${fmt(gain)} glass after ${fmtTime(runT)} (run ${fmt(g.s.dustRun)}, ${fmt(g.baseRate())}/s, ${g.boards[0].size}², hg ${g.s.owned.hourglass} cr ${g.s.owned.crystal} st ${g.s.owned.stone} pr ${g.s.owned.prism}, ${g.boards.length} tables, relics ${g.relicCount()})${g.s.trial ? ' [trial ' + g.s.trial + ']' : ''}`);
    const choice = chooseTable();
    const table = g.candidates()[choice];
    const doc = chooseDoctrine(table);
    if (trial) g.startTrial(trial, choice);
    else g.sweep(doc, null, choice);
    if (trial && doc && g.doctrineAvailable(doc)) g.s.doctrine = doc;
    g.recomputeFx();
    note(`  -> ${table.name} [${table.arch}, tier ${table.tier}] digs ${table.features.dig}${doc ? ' doctrine ' + doc : ''}`);
    if (trial) { note(`  start trial ${trial}`); trialStart = t; sinceTrial = 0; } else sinceTrial++;
    runStartT = t;
    peakRate = 0;
    noStoneUntil = 0;
    buyKiln();
  }

  function bestFold() {
    if (!g.has('fold')) return;
    const r0 = g.baseRate();
    const was = g.s.fold;
    if (!g.setFold(!was)) return;
    if (g.baseRate() < r0) g.setFold(was);
  }

  while (t < totalT) {
    // player actions
    if (g.canClick() && (t < prof.clickUntil || (profile === 'active' && targetDig()))) {
      const [ct, ci] = clickCell();
      if (ci >= 0) g.click(ct, ci, prof.clicksPerSec);
    }
    if (prof.quake && g.canQuake() && g.s.quakeCd <= 0) g.quake();
    if (g.s.gleam && g.rng() < prof.gleam / 6) g.catchGleam();
    for (const d of g.visibleDigs()) if (!digSeen.has(d)) digSeen.set(d, t);
    const open = g.s.digs.filter(d => !d.done && digSeen.has(d));
    g.tick(1);
    t += 1;
    for (const d of open) if (d.done) digTimes.push({ t, len: t - digSeen.get(d), ring: d.ring, tier: g.s.tableDefs[d.t]?.tier });
    // upgrades bought by automation (the Journeyman) count too
    for (const id in g.s.up) if (!(id in purchases)) { purchases[id] = t; isNew('upgrade ' + id); }
    for (const e of g.drainEvents()) {
      if (e.type === 'trialDone') { trialsDone[e.id] = { t, runT: t - trialStart }; isNew('trial ' + e.id); note(`TRIAL DONE ${e.id} after ${fmtTime(t - trialStart)}`); }
      if (e.type === 'relic') { relics[e.id] = t; isNew('relic ' + e.id); const dt = digTimes[digTimes.length - 1]; note(`RELIC ${D.RELIC_MAP[e.id].name} (${g.relicCount()}/${D.RELICS.length})${e.glass ? ' +' + fmt(e.glass) + ' glass' : ''}${dt && dt.t === t ? ` dug in ${fmtTime(dt.len)} (ring ${dt.ring})` : ''}`); }
      if (e.type === 'cache') { const dt = digTimes[digTimes.length - 1]; note(`cache +${fmt(e.amount)}${dt && dt.t === t ? ` dug in ${fmtTime(dt.len)} (ring ${dt.ring})` : ''}`); }
      if (e.type === 'terrain') { isNew('terrain ' + e.what); note(`TERRAIN ${e.what}`); }
      if (e.type === 'unlock') isNew('unlock ' + e.what);
      if (verbose && (e.type === 'ach' || e.type === 'journal')) note(`${e.type} ${e.id}`);
    }
    if (t % prof.think === 0) { manageStack(); buyStuff(); }
    for (const f of ['crystal', 'quake', 'gleam', 'stone', 'fold', 'prism', 'doctrine', 'trials', 'shape', 'great']) {
      if (!seen.has(f) && g.has(f)) { seen.add(f); note(`UNLOCK ${f}`); }
    }
    if (t % 60 === 0) bestFold();
    if (g.has('doctrine') && !g.s.doctrine) g.setDoctrine(chooseDoctrine(null));
    if (t % 10 === 0) buyKiln();

    // sweep policy
    const runT = t - runStartT;
    const gain = g.glassGain();
    if (g.s.trial) {
      // give up on a trial that is clearly not going to make it
      if (g.s.trials[g.s.trial] || runT > 900) {
        if (!g.s.trials[g.s.trial]) { deferred[g.s.trial] = 3; note(`  trial ${g.s.trial} FAILED (${fmt(g.s.dustRun)} / ${fmt(D.TRIAL_MAP[g.s.trial].goal)})`); }
        doSweep(null);
      }
    } else if (gain >= 1 && !noSweep) {
      const rate = gain / Math.max(1, runT);
      peakRate = Math.max(peakRate, rate);
      // the next thing glass is for: a kiln item, or the next stage of the Great Hourglass
      const nk = D.KILN.filter(k => g.kilnAvailable(k)).sort((a, b) => a.cost - b.cost)[0];
      const gs = g.has('great') ? g.greatNext() : null;
      const goal = Math.min(nk ? nk.cost : Infinity, gs && gs.glass ? gs.glass : Infinity);
      const next = Number.isFinite(goal);
      const need = next ? goal - g.s.glass : Infinity;
      const enough = gain >= Math.max(1, Math.min(g.s.glassAll * 0.5, need));
      // relics are permanent: finish the digs in reach before sweeping
      let digLeft = 0;
      for (const d of g.visibleDigs()) digLeft += (d.need - d.prog) / Math.max(1e-9, g.digRate(d) * 2);
      const digSoon = digLeft < prof.digPatience * 6 && g.visibleDigs().length > 0 && runT < 2400;
      // sweep when glass stops coming quickly, or when it buys the next kiln item twice over
      const shopping = next && gain >= 2 * need && runT > 240;
      if (((enough && rate < peakRate * 0.9 && runT > 120) || shopping || runT > 2400) && !digSoon) {
        let trial = null;
        if (g.has('trials') && sinceTrial >= 1) {
          // in list order, like a player working down the tab
          // only once normal runs comfortably beat the goal, like a player reading it
          const open = D.TRIALS.filter(tr => !g.s.trials[tr.id] && Number.isFinite(tr.goal) && !(deferred[tr.id] > 0) && tr.goal * 30 <= bestRun);
          for (const id in deferred) deferred[id]--;
          if (open.length) trial = open[0].id;
        }
        doSweep(trial);
      }
    }
    if (stopWhen) {
      const it = stopWhen;
      const done = it.kind === 'trials' ? trialsDone[it.id] : it.kind === 'great' ? greats[D.GREAT.findIndex(x => x.id === it.id) + 1] !== undefined
        : it.kind === 'relics' ? relics[it.id] !== undefined : purchases[it.id] !== undefined;
      if (done) break;
    }
    if (g.s.great >= D.GREAT.length && endedAt === null) { endedAt = t; note('*** THE GREAT HOURGLASS IS COMPLETE ***'); break; }
    if (t - lastReport >= 600) {
      lastReport = t;
      note(`.. run ${fmt(g.s.dustRun)} ${fmt(g.baseRate())}/s glass ${fmt(g.s.glass)}/${fmt(g.s.glassAll)} sand ${fmt(g.s.sand)} ach ${g.achCount()} relics ${g.relicCount()} digs ${g.visibleDigs().length}/${g.s.digs.filter(d => !d.done).length} polish ${g.s.polish}`);
    }
  }
  return { log, purchases, events, trialsDone, greats, relics, endedAt, novelty, digTimes, game: g, t };
}

// Longest stretches without anything new happening.
export function noveltyGaps(r, end = r.endedAt ?? r.t) {
  const ts = [0, ...r.novelty.map(n => n[0]).filter(x => x <= end), end].sort((a, b) => a - b);
  const gaps = [];
  for (let k = 1; k < ts.length; k++) gaps.push({ from: ts[k - 1], to: ts[k], len: ts[k] - ts[k - 1] });
  return gaps.sort((a, b) => b.len - a.len);
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  if (process.env.BOT_OVERRIDES) applyOverrides(JSON.parse(process.env.BOT_OVERRIDES));
  const args = process.argv.slice(2).filter(a => !a.startsWith('-'));
  const verbose = process.argv.includes('-v');
  const r = simulate({ hours: +(args[0] || 5), profile: args[1] || 'active', verbose, noSweep: process.argv.includes('--nosweep') });
  if (process.env.BOT_JSON) console.log(JSON.stringify({ purchases: r.purchases, events: r.events, trialsDone: r.trialsDone, greats: r.greats, relics: r.relics, endedAt: r.endedAt }));
  else {
    if (!verbose) console.log(r.log.join('\n'));
    const gaps = noveltyGaps(r).slice(0, 6);
    console.log(`novelty: ${r.novelty.length} new things; longest gaps: ${gaps.map(gp => `${fmtTime(gp.len)} @${fmtTime(gp.from)}`).join(', ')}`);
  }
}
