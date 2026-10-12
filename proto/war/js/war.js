// Skirmish rules. Every cell belongs to a player or to no one, and holds
// sand of its owner's colour. A cell topples when it holds as many grains as
// it has ways out, sending one grain each way. A grain that lands in someone
// else's cell destroys one of theirs; landing in an empty cell takes it.
//
// Spouts are fixed. Whoever owns the cell under a spout pours through it, and
// how much you pour in total grows with how many cells you own. Each spout you
// hold also gives you pull for wells: a well draws cells in from all around it
// (anyone's), packing them densely; lift it and the packed cells spread back
// out, and the sand they held floods outward.
import { Tess, buildGraph, FREE } from '../../js/voronoi.js';
import { mulberry32 } from '../../js/region.js';
import { computeRho, applyComb, relaxStep, wakeSeeds } from '../../js/shape.js';
import { generateMap } from './map.js';

export const RASTER = 320;
export const NEUTRAL = -1;
const COLLAPSED = -9;
export const RULES = {
  cells: 300,          // the map's cells; wells move them, never make them
  rounds: 24,          // toppling rounds per second
  flowBase: 1,         // grains/s every player pours, plus...
  flowPerCell: 0.08,   // ...this much per cell owned
  pullPerSpout: 2,     // pull for wells, per spout held
  maxPull: 8,          // the most pull one well can have
  accrete: 0.15,       // cells a well swallows per second, per pull
  capacity: 4,         // cells a well can hold beyond its share, per pull
  wellR: 26, minR: 14, maxR: 40,
  homeR: 24,           // starting land around each home spout
  garrisonR: 20, garrison: 3,   // neutral sand guarding the other spouts
  outAfter: 12,        // seconds with no spout before a player is out
  winShare: 0.8,       // ...or own this share of the cells
  relaxEvery: 0.08,    // seconds between relaxation steps while the land moves
  reach: 3.5,          // how far a well reaches for cells to swallow, in well radii
  wellGrace: 2,        // seconds someone else must hold a well's ground to break it
};

export class War {
  constructor(opts = {}) {
    this.seed = opts.seed ?? Math.floor(Math.random() * 1e9);
    this.flowMult = opts.flowMult || [1, 1];
    this.rng = mulberry32((this.seed ^ 0x5bd1e995) >>> 0);
    this.events = [];
    const W = this.W = RASTER;
    this.map = generateMap(this.seed, W);
    this.mask = this.map.mask;
    this.tess = new Tess(W, W, this.mask);
    this.spouts = this.map.spouts.map(s => ({ x: s.x, y: s.y, home: s.home, owner: s.home ?? NEUTRAL, share: 1, acc: 0 }));
    this.wells = [];
    this.nextWell = 1;
    this.time = 0;
    this.over = null;
    this.noSpout = [0, 0];
    this.cellsOwned = [0, 0];
    this.stats = { topples: [0, 0], peak: [0, 0], taken: [0, 0], released: [0, 0], swallowed: [0, 0], thrown: [0, 0] };
    this.roundAcc = 0;
    this.relaxAcc = 0;
    this.moving = false;
    this.pending = [];   // lifted or lost wells whose cells are about to collapse
    this.rho = computeRho(this.map.rho0, [], W);
    this.sow(RULES.cells);
    for (let k = 0; k < 14; k++) { relaxStep(this.tess, this.rho, this.mask, this.rng); applyComb(this.tess.seeds, this.map.comb, W); this.tess.rebuild(); }
    this.relayout(null, null);
    this.count();
  }

  emit(type, data = {}) { this.events.push({ type, t: this.time, ...data }); }
  drainEvents() { const e = this.events; this.events = []; return e; }

  // ------------------------------------------------------------ setup
  // Seeds in mirrored pairs, scattered in proportion to the ground's density.
  sow(count) {
    const W = this.W, R = this.rng, t = this.tess, rho = this.rho, mask = this.mask;
    for (const q of this.map.seeds) t.seeds.push(Object.assign({}, q));
    let max = 0;
    for (let p = 0; p < rho.length; p++) if (mask[p] === FREE && rho[p] > max) max = rho[p];
    let added = 0;
    for (let k = 0; k < 400000 && added < count; k++) {
      const x = R() * W, y = R() * W / 2;
      const p = t.pixel(x, y);
      if (mask[p] !== FREE || R() * max > rho[p]) continue;
      if (!t.canSeed(x, y, 3) || !t.canSeed(W - x, W - y, 3)) continue;
      t.seeds.push({ x, y }, { x: W - x, y: W - y });
      added += 2;
    }
    applyComb(t.seeds, this.map.comb, W);
    t.rebuild();
  }

  // Build the graph for the current cells and carry the sand over. Cells keep
  // their sand and owner as they drift; a cell that was swallowed pours its
  // sand into whichever cell now covers where it was (merging with it, or
  // fighting it); a cell that appeared starts empty, owned by whoever owned
  // that spot.
  relayout(prev, teleported) {
    const g = buildGraph(this.tess);
    const n = g.n;
    const own = new Int8Array(n).fill(NEUTRAL), grains = new Float64Array(n);
    if (!prev) {
      for (let c = 0; c < n; c++) {
        for (const sp of this.spouts) {
          const d = Math.hypot(g.cx[c] - sp.x, g.cy[c] - sp.y);
          if (sp.home !== null && d < RULES.homeR) { own[c] = sp.home; grains[c] = g.thr[c] - 1; }
          else if (sp.home === null && d < RULES.garrisonR) grains[c] = Math.min(g.thr[c] - 1, RULES.garrison);
        }
      }
      for (const sp of this.spouts) {
        const c = g.cellOf[this.tess.lab[this.tess.pixel(sp.x, sp.y)]];
        if (sp.home !== null) { own[c] = sp.home; grains[c] = g.thr[c] - 1; }
      }
    } else {
      const f0 = new Float64Array(n), f1 = new Float64Array(n), fN = new Float64Array(n);
      const has = new Uint8Array(n), self = new Int8Array(n).fill(-2);
      const lab = this.tess.lab;
      for (let oc = 0; oc < prev.g.n; oc++) {
        const s = prev.g.slotOf[oc];
        // a swallowed cell keeps its sand, now its new owner's; a collapsed
        // cell leaves its sand behind in whichever cell covers where it was
        const mode = teleported ? teleported.get(s) : undefined;
        let o = prev.own[oc];
        let tc = mode === COLLAPSED ? -1 : g.cellOf[s];
        if (mode !== undefined && mode !== COLLAPSED) o = mode;
        if (tc >= 0) self[tc] = o;
        else {
          const p = this.tess.pixel(prev.g.cx[oc], prev.g.cy[oc]);
          const s2 = p >= 0 ? lab[p] : -1;
          tc = s2 >= 0 ? g.cellOf[s2] : -1;
        }
        if (tc < 0) continue;
        const a = prev.grains[oc];
        if (o === 0) { f0[tc] += a; has[tc] |= 1; } else if (o === 1) { f1[tc] += a; has[tc] |= 2; } else { fN[tc] += a; has[tc] |= 4; }
      }
      for (let c = 0; c < n; c++) {
        if (!has[c]) {
          const p = this.tess.pixel(g.cx[c], g.cy[c]);
          const s = p >= 0 ? prev.lab[p] : -1;
          const oc = s >= 0 ? prev.g.cellOf[s] : -1;
          own[c] = oc >= 0 ? prev.own[oc] : NEUTRAL;
          continue;
        }
        const [o, a] = fight([[0, f0[c], has[c] & 1], [1, f1[c], has[c] & 2], [NEUTRAL, fN[c], has[c] & 4]], self[c]);
        own[c] = o; grains[c] = a;
      }
    }
    this.g = g;
    this.own = own;
    this.grains = grains;
    this.flash = new Float32Array(n);
    this.taken = new Float32Array(n);
    this.K = new Float64Array(n);
    this.act = new Int32Array(n);
    this.inc = [new Float64Array(n), new Float64Array(n)];
    this.stamp = new Int32Array(n);
    this.roundNo = 0;
    this.layoutV = (this.layoutV || 0) + 1;
  }

  // ------------------------------------------------------------ queries
  cellAt(x, y) {
    const p = this.tess.pixel(x, y);
    if (p < 0) return -1;
    const s = this.tess.lab[p];
    return s >= 0 ? this.g.cellOf[s] : -1;
  }
  ownerAt(x, y) { const c = this.cellAt(x, y); return c >= 0 ? this.own[c] : NEUTRAL; }
  flow(p) { return this.flowMult[p] * (RULES.flowBase + RULES.flowPerCell * this.cellsOwned[p]); }
  spoutsOf(p) { return this.spouts.filter(s => s.owner === p); }
  pullBudget(p) { return RULES.pullPerSpout * this.spoutsOf(p).length; }
  pullUsed(p) { return this.wells.reduce((a, w) => a + (w.owner === p ? w.pull : 0), 0); }
  pullFree(p) { return this.pullBudget(p) - this.pullUsed(p); }
  // when a player loses spouts, their wells weaken to fit what is left
  pullScale(p) { const u = this.pullUsed(p); return u > 0 ? Math.min(1, this.pullBudget(p) / u) : 1; }
  spoutRate(k) {
    const sp = this.spouts[k];
    if (sp.owner < 0) return 0;
    const mine = this.spoutsOf(sp.owner);
    const tot = mine.reduce((a, s) => a + s.share, 0) || 1;
    return this.flow(sp.owner) * sp.share / tot;
  }

  count() {
    const c = [0, 0];
    for (let i = 0; i < this.g.n; i++) if (this.own[i] >= 0) c[this.own[i]]++;
    this.cellsOwned = c;
    for (let p = 0; p < 2; p++) if (c[p] > this.stats.peak[p]) this.stats.peak[p] = c[p];
    for (const sp of this.spouts) {
      const o = this.ownerAt(sp.x, sp.y);
      if (o !== sp.owner) {
        const from = sp.owner;
        sp.owner = o;
        sp.share = 1;
        sp.acc = 0;
        this.emit('spout', { k: this.spouts.indexOf(sp), from, to: o });
      }
    }
  }

  // ------------------------------------------------------------ time
  tick(dt) {
    if (!(dt > 0) || this.over) return;
    this.time += dt;
    this.count();
    // pour
    this.spouts.forEach((sp, k) => {
      if (sp.owner < 0) return;
      sp.acc += this.spoutRate(k) * dt;
      const whole = Math.floor(sp.acc);
      if (whole <= 0) return;
      sp.acc -= whole;
      const c = this.cellAt(sp.x, sp.y);
      if (c >= 0) this.add(c, sp.owner, whole);
    });
    // topple
    this.roundAcc += dt * RULES.rounds;
    let rounds = Math.min(60, Math.floor(this.roundAcc));
    this.roundAcc -= Math.floor(this.roundAcc);
    while (rounds-- > 0) this.round();
    // a well breaks if someone else holds the ground under it for a moment
    for (const w of this.wells.slice()) {
      w.lost = this.ownerAt(w.x, w.y) === w.owner ? 0 : (w.lost || 0) + dt;
      if (w.lost >= RULES.wellGrace) this.dropWell(w, 'lost');
    }
    // the land settles (and keeps moving while a well is still filling)
    for (const w of this.wells) if (w.extra < this.capacity(w) && !(w.starved > this.time)) this.moving = true;
    if (this.moving) {
      this.relaxAcc += dt;
      if (this.relaxAcc >= RULES.relaxEvery) {
        this.relaxAcc = 0;
        const m = this.relaxStep();
        this.still = m < 0.08 ? this.still + 1 : 0;
        if (this.still >= 4 || ++this.relaxSteps > 400) this.moving = false;
      }
    }
    // the end
    for (let p = 0; p < 2; p++) {
      this.noSpout[p] = this.spoutsOf(p).length ? 0 : this.noSpout[p] + dt;
      if (this.noSpout[p] >= RULES.outAfter) return this.finish(1 - p, 'spouts');
      if (this.cellsOwned[p] >= RULES.winShare * this.g.n) return this.finish(p, 'land');
    }
  }

  finish(winner, reason) {
    this.over = { winner, reason, time: this.time };
    this.emit('over', this.over);
  }

  // Sand of player p arrives in cell c.
  add(c, p, k) {
    const o = this.own[c];
    if (o === p) { this.grains[c] += k; return; }
    const d = this.grains[c];
    if (k > d) { this.own[c] = p; this.grains[c] = k - d; this.taken[c] = 1; if (o >= 0) this.stats.taken[p]++; }
    else this.grains[c] = d - k;
  }

  // One synchronous toppling round. Returns how many cells toppled.
  round() {
    const g = this.g, { n, thr, nbrStart, nbr } = g;
    const own = this.own, gr = this.grains, K = this.K, act = this.act, inc = this.inc, stamp = this.stamp;
    let m = 0;
    for (let c = 0; c < n; c++) {
      if (own[c] >= 0 && gr[c] >= thr[c]) { K[c] = Math.floor(gr[c] / thr[c]); act[m++] = c; }
    }
    if (!m) return 0;
    const rn = ++this.roundNo;
    const touched = [];
    for (let j = 0; j < m; j++) {
      const c = act[j], k = K[c], o = own[c];
      gr[c] -= k * thr[c];
      this.flash[c] = 1;
      this.stats.topples[o] += k;
      const io = inc[o];
      for (let e = nbrStart[c]; e < nbrStart[c + 1]; e++) {
        const b = nbr[e];
        io[b] += k;
        if (stamp[b] !== rn) { stamp[b] = rn; touched.push(b); }
      }
    }
    for (const b of touched) {
      const a0 = inc[0][b], a1 = inc[1][b];
      inc[0][b] = inc[1][b] = 0;
      const o = own[b];
      if (o >= 0) {
        // the owner's own sand joins the defence
        const d = gr[b] + (o === 0 ? a0 : a1), a = o === 0 ? a1 : a0;
        if (a > d) { own[b] = 1 - o; gr[b] = a - d; this.taken[b] = 1; this.stats.taken[1 - o]++; }
        else gr[b] = d - a;
      } else {
        const [w, left] = fight([[NEUTRAL, gr[b], 1], [0, a0, a0 > 0], [1, a1, a1 > 0]], NEUTRAL);
        if (w !== NEUTRAL) this.taken[b] = 1;
        own[b] = w; gr[b] = left;
      }
    }
    return m;
  }

  // ------------------------------------------------------------ shaping
  reshape() {
    const eff = this.wells.map(w => ({ x: w.x, y: w.y, r: w.r, pull: w.pull * this.pullScale(w.owner) }));
    computeRho(this.map.rho0, eff, this.W, this.rho);
    this.moving = true;
    this.still = 0;
    this.relaxSteps = 0;
    wakeSeeds(this.tess.seeds);
  }

  relaxStep() {
    const prev = { g: this.g, own: this.own, grains: this.grains, lab: Int32Array.from(this.tess.lab) };
    const { moved } = relaxStep(this.tess, this.rho, this.mask, this.rng, { perStep: 0 });
    const teleported = new Map();   // slot -> new owner (swallowed) or COLLAPSED
    const jumps = this.accrete(teleported) + this.collapse(teleported);
    applyComb(this.tess.seeds, this.map.comb, this.W);
    this.tess.rebuild();
    this.relayout(prev, teleported);
    this.count();
    return jumps ? Math.max(moved, 1) : moved;
  }

  capacity(w) { return RULES.capacity * w.pull * this.pullScale(w.owner); }

  // Move cell `c`'s seed into cell `into` (splitting it). `mode` is the
  // swallowing player, or COLLAPSED. Returns success.
  jump(c, into, teleported, mode) {
    const g = this.g, seeds = this.tess.seeds;
    const a = this.rng() * Math.PI * 2, rr = 0.35 * Math.sqrt(g.area[into]) + 1;
    const nx = g.cx[into] + Math.cos(a) * rr, ny = g.cy[into] + Math.sin(a) * rr;
    const p = this.tess.pixel(nx, ny);
    if (p < 0 || this.mask[p] !== FREE) return false;
    const sd = seeds[g.slotOf[c]];
    sd.x = nx; sd.y = ny;
    sd._st = sd._mx = sd._my = undefined;
    teleported.set(g.slotOf[c], mode);
    return true;
  }

  spoutCells() { return new Set(this.spouts.map(sp => this.cellAt(sp.x, sp.y))); }

  // Each well swallows the nearest cells within reach that aren't its
  // owner's: they reappear inside the well, sand and all, as its owner's.
  accrete(teleported) {
    const g = this.g, own = this.own, seeds = this.tess.seeds;
    const anchors = this.spoutCells(), split = new Set();
    let n = 0;
    for (const w of this.wells) {
      const cap = this.capacity(w);
      if (w.extra >= cap) continue;
      w.acc += RULES.accrete * w.pull * this.pullScale(w.owner) * RULES.relaxEvery;
      while (w.acc >= 1 && w.extra < cap) {
        let lo = -1, ld = (w.r * RULES.reach) ** 2;
        for (let c = 0; c < g.n; c++) {
          if (own[c] === w.owner || anchors.has(c) || seeds[g.slotOf[c]].pin || teleported.has(g.slotOf[c])) continue;
          const d = (g.cx[c] - w.x) ** 2 + (g.cy[c] - w.y) ** 2;
          if (d < ld) { ld = d; lo = c; }
        }
        let hi = -1, ha = 12;
        for (let c = 0; c < g.n; c++) {
          if (own[c] !== w.owner || split.has(c) || teleported.has(g.slotOf[c])) continue;
          if ((g.cx[c] - w.x) ** 2 + (g.cy[c] - w.y) ** 2 > w.r * w.r) continue;
          if (g.area[c] > ha) { ha = g.area[c]; hi = c; }
        }
        if (lo < 0) { w.acc = 0; w.starved = this.time + 2; break; }
        if (hi < 0) break;
        w.acc -= 1;
        if (!this.jump(lo, hi, teleported, w.owner)) continue;
        split.add(hi);
        w.extra++;
        this.stats.swallowed[w.owner]++;
        n++;
      }
    }
    return n;
  }

  // A lifted (or broken) well bursts: as many of its owner's smallest cells
  // as it swallowed spring out over the front, each splitting the nearest
  // cell that isn't theirs, and carry their sand with them.
  collapse(teleported) {
    if (!this.pending.length) return 0;
    const g = this.g, seeds = this.tess.seeds, own = this.own;
    const anchors = this.spoutCells();
    let n = 0;
    for (const z of this.pending) {
      const near = [], out = [];
      for (let c = 0; c < g.n; c++) {
        if (seeds[g.slotOf[c]].pin || anchors.has(c) || teleported.has(g.slotOf[c])) continue;
        const d = Math.hypot(g.cx[c] - z.x, g.cy[c] - z.y);
        if (own[c] === z.owner && d < z.r * 1.3) near.push(c);
        else if (own[c] !== z.owner && d < z.r * RULES.reach * 1.3 && g.area[c] >= 12) out.push([c, d]);
      }
      near.sort((a, b) => g.area[a] - g.area[b]);
      out.sort((a, b) => a[1] - b[1]);
      const k = Math.min(z.extra, near.length - 1, out.length);
      for (let i = 0; i < k; i++) if (this.jump(near[i], out[i][0], teleported, z.owner)) n++;
      this.stats.thrown[z.owner] += k;
    }
    this.pending = [];
    return n;
  }

  // Wells. Returns the well, or a reason it could not be placed.
  addWell(p, x, y, pull = 2, r = RULES.wellR) {
    if (this.over) return 'over';
    if (this.ownerAt(x, y) !== p) return 'not yours';
    const free = this.pullFree(p);
    if (free < 0.5) return 'no pull';
    const w = { id: this.nextWell++, owner: p, x, y, r, pull: Math.min(pull, free, RULES.maxPull), t0: this.time, extra: 0, acc: 0 };
    this.wells.push(w);
    this.reshape();
    return w;
  }
  moveWell(w, x, y) {
    if (this.ownerAt(x, y) !== w.owner) return false;
    w.x = x; w.y = y;
    w.starved = 0;
    this.reshape();
    return true;
  }
  adjustWell(w, dir, radius = false) {
    if (radius) w.r = Math.max(RULES.minR, Math.min(RULES.maxR, w.r * (dir > 0 ? 1.12 : 0.9)));
    else w.pull = Math.max(0.5, Math.min(RULES.maxPull, this.pullFree(w.owner) + w.pull, w.pull + (dir > 0 ? 0.5 : -0.5)));
    // a weaker well lets go of what it can no longer hold
    const over = Math.floor(w.extra - this.capacity(w));
    if (over > 0) { w.extra -= over; this.pending.push({ x: w.x, y: w.y, r: w.r, extra: over, owner: w.owner }); }
    w.starved = 0;
    this.reshape();
  }
  // Lift a well: its packed cells spread back out.
  liftWell(w) { this.dropWell(w, 'lift'); }
  dropWell(w, why) {
    const i = this.wells.indexOf(w);
    if (i < 0) return;
    this.wells.splice(i, 1);
    if (why === 'lift') this.stats.released[w.owner]++;
    if (w.extra > 0) this.pending.push({ x: w.x, y: w.y, r: w.r, extra: w.extra, owner: w.owner });
    this.emit('well', { w, why });
    this.reshape();
  }

  adjustShare(k, dir) {
    const sp = this.spouts[k];
    sp.share = Math.max(0.25, Math.min(8, sp.share * (dir > 0 ? 1.25 : 0.8)));
  }

  nearestSpout(x, y, within) {
    let best = -1, bd = within * within;
    this.spouts.forEach((s, k) => { const d = (s.x - x) ** 2 + (s.y - y) ** 2; if (d < bd) { bd = d; best = k; } });
    return best;
  }
  nearestWell(x, y, within, p = null) {
    let best = null, bd = within * within;
    for (const w of this.wells) { if (p !== null && w.owner !== p) continue; const d = (w.x - x) ** 2 + (w.y - y) ** 2; if (d < bd) { bd = d; best = w; } }
    return best;
  }

  totalSand(p) { let s = 0; for (let c = 0; c < this.g.n; c++) if (this.own[c] === p) s += this.grains[c]; return s; }
}

// Forces meet in one cell: [owner, amount, present]. The largest wins and
// keeps what is left after the others. A tie for the top leaves the cell
// with `pref` (the defender) if it is there, otherwise with no one.
export function fight(forces, pref) {
  let best = null, sum = 0, tie = false, prefHere = false;
  for (const f of forces) {
    if (!f[2]) continue;
    sum += f[1];
    if (f[0] === pref) prefHere = true;
    if (!best || f[1] > best[1]) { best = f; tie = false; } else if (f[1] === best[1]) tie = true;
  }
  if (!best) return [NEUTRAL, 0];
  if (tie) return [prefHere ? pref : NEUTRAL, 0];
  return [best[0], Math.max(0, best[1] - (sum - best[1]))];
}
