// Prototype rules: shaping the space sand moves through.
//
// The ground is divided into cells, and how finely it is divided is a kind of
// depth: where cells are small, a grain needs many topples to get anywhere,
// so sand lingers there like a well. You don't place cells. You place:
//   taps    – share one flow budget between them (where sand falls),
//   weights – share one pull budget (they draw cells in, deepening wells),
//   combs   – strokes that stretch cells along a direction (channels).
// The cells then relax towards the shape you asked for, continuously.
// Topples earn dust; topples in deep, crowded cells also press out gems.
import { Tess, buildGraph, FREE, CRACK } from './voronoi.js';
import { Pile, solve } from './pile.js';
import { generateRegion, mulberry32, RELICS, COMB } from './region.js';

export const RASTER = 320;
export const BUDGET = 20;          // visible grains per second before the sand coarsens
const ROUNDS = 30;                 // live toppling rounds per second (more on big lands)
const ORE_K = 4;                   // a cell made entirely of ore is worth 5×
const ERODE = 80;                  // erosion, shared out by each cell's share of topples
const BASE_CELLS = 230;
const RELAX_EVERY = 0.08;          // seconds between relaxation steps while the land is moving
const RELAX_STEP = 0.9;            // how far a seed moves towards the middle of its cell each step
const SAVE_V = 3;

export const DENOMS = ['sand', 'grit', 'gravel', 'pebbles', 'stones', 'cobbles', 'boulders', 'crags', 'cliffs', 'mountains'];

// cur: what it costs ('dust' or 'gems')
export const SHOP = [
  { id: 'pour', name: 'Finer Sand', cur: 'dust', base: 60, growth: 6, desc: 'Twice the flow, shared between your taps.' },
  { id: 'value', name: 'Sifting', cur: 'dust', base: 400, growth: 12, desc: 'Every topple gives twice the dust.' },
  { id: 'erode', name: 'Harder Sand', cur: 'dust', base: 300, growth: 10, desc: 'Sand wears the ground away twice as fast.' },
  { id: 'pull', name: 'Lodestone', cur: 'gems', base: 40, growth: 2.5, desc: '+3 pull to share between your weights.' },
  { id: 'ground', name: 'More Ground', cur: 'gems', base: 80, growth: 2.2, desc: '+40 cells: more ground to shape.' },
  { id: 'press', name: 'Pressure', cur: 'gems', base: 300, growth: 4, desc: 'Crowded cells press out twice as many gems.' },
  { id: 'survey', name: 'The Survey', cur: 'dust', base: 20000, once: true,
    desc: 'Earn the exact average of what the sand does, instead of what it happens to do.' },
];
export const SHOP_MAP = Object.fromEntries(SHOP.map(x => [x.id, x]));

export function newState(seed = Math.floor(Math.random() * 1e9), only = null) {
  return {
    v: SAVE_V, seed, only, dust: 0, dustAll: 0, gems: 0, gemsAll: 0, played: 0,
    seeds: null, taps: null, weights: [], comb: null,
    lv: { pour: 0, value: 0, erode: 0, pull: 0, ground: 0, press: 0 },
    survey: false, mode: 'live',
    found: [], relics: [],
    stats: { topples: 0, maxWave: 0, clicks: 0 },
    settings: { relax: true },
    sandbox: false, speed: 1, lastSave: Date.now(),
  };
}

function b64FromBytes(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
function bytesFromB64(b64) {
  const s = atob(b64);
  const bytes = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
  return bytes;
}
function encodeDepth(d) {
  const q = new Uint16Array(d.length);
  for (let i = 0; i < d.length; i++) q[i] = Math.min(65535, Math.round(d[i] * 50));
  return b64FromBytes(new Uint8Array(q.buffer));
}
function decodeDepth(b64, n) {
  const q = new Uint16Array(bytesFromB64(b64).buffer);
  const d = new Float32Array(n);
  for (let i = 0; i < n && i < q.length; i++) d[i] = q[i] / 50;
  return d;
}
const packSeed = (s) => [s.x, s.y, s.z || '', s.pin ? 1 : 0, s.w || 1];
const unpackSeed = (a) => ({ x: a[0], y: a[1], z: a[2] || undefined, pin: !!a[3], w: a[4] || 1 });

export class Game {
  constructor(state = null) {
    this.events = [];
    this.rng = mulberry32((Date.now() & 0xffff) + 7);
    this.load(state || newState());
  }

  emit(type, data = {}) { this.events.push({ type, ...data }); }
  drainEvents() { const e = this.events; this.events = []; return e; }

  // ------------------------------------------------------------ setup
  load(s) {
    const base = newState(s.seed, s.only);
    this.s = Object.assign(base, s, {
      lv: Object.assign(base.lv, s.lv), stats: Object.assign(base.stats, s.stats), settings: Object.assign(base.settings, s.settings),
    });
    const st = this.s;
    const W = this.W = RASTER;
    this.region = generateRegion(st.seed, W, st.only);
    this.mask = this.region.mask.slice();
    this.ore = this.region.ore.slice();
    this.depth = st.depth ? decodeDepth(st.depth, W * W) : new Float32Array(W * W);
    delete st.depth;
    this.comb = st.comb ? new Float32Array(bytesFromB64(st.comb).buffer) : this.region.comb.slice();
    delete st.comb;
    if (!st.taps) st.taps = [{ x: this.region.spout[0], y: this.region.spout[1], share: 1 }];
    this.springs = [];
    for (const i of st.found) this.applyFind(i, false);
    this.tess = new Tess(W, W, this.mask);
    this.time = 0;
    this.srcAcc = [];
    this.roundAcc = 0;
    this.tickAcc = 0;
    this.relaxAcc = 0;
    this.still = 0;
    this.liveEMA = 0;
    this.gemEMA = 0;
    this.g = null;
    this.pile = null;
    this.v = this.u = null;
    this.refArea = 0;
    this.computeRho();
    if (st.seeds) {
      this.tess.seeds = st.seeds.map(unpackSeed);
      delete st.seeds;
      this.applyComb();
      this.tess.rebuild();
    } else {
      this.sowSeeds(BASE_CELLS);
      for (let k = 0; k < 14; k++) this.relaxStep(false);
    }
    this.relayout(null, null);
    this.wake();
    return this;
  }

  newRegion(seed, only = null) {
    const keep = { sandbox: this.s.sandbox, speed: this.s.speed, settings: this.s.settings };
    this.load(Object.assign(newState(seed, only), keep));
    this.emit('region');
  }

  serialize() {
    return JSON.stringify(Object.assign({}, this.s, {
      seeds: this.tess.seeds.filter(Boolean).map(packSeed),
      depth: encodeDepth(this.depth),
      comb: b64FromBytes(new Uint8Array(this.comb.buffer.slice(0))),
      lastSave: Date.now(),
    }));
  }

  // ------------------------------------------------------------ budgets and multipliers
  relicFx(key) {
    let m = 1;
    for (const id of this.s.relics) { const r = RELICS.find(x => x.id === id); if (r && r.fx[key]) m *= r.fx[key]; }
    return m;
  }
  flow() { return Math.pow(2, this.s.lv.pour) * this.relicFx('rate'); }
  valueMult() { return Math.pow(2, this.s.lv.value) * this.relicFx('value'); }
  erodeMult() { return Math.pow(2, this.s.lv.erode) * this.relicFx('erode'); }
  gemMult() { return Math.pow(2, this.s.lv.press); }
  pullBudget() { return 6 + 3 * this.s.lv.pull; }
  pullUsed() { return this.s.weights.reduce((a, w) => a + w.pull, 0); }
  cellBudget() { return BASE_CELLS + 40 * this.s.lv.ground; }
  steady() { return this.s.survey && this.s.mode === 'steady'; }

  // Sources: taps share the flow budget; springs pour on their own.
  sources() {
    const f = this.flow();
    const tot = this.s.taps.reduce((a, t) => a + t.share, 0) || 1;
    return [...this.s.taps.map(t => ({ x: t.x, y: t.y, rate: f * t.share / tot })), ...this.springs.map(([x, y]) => ({ x, y, rate: f * 0.25, spring: true }))];
  }
  realRate() { return this.sources().reduce((a, q) => a + q.rate, 0); }
  denom() {
    const R = this.realRate();
    return R <= BUDGET ? 1 : Math.pow(10, Math.ceil(Math.log10(R / BUDGET)));
  }
  denomName(N = this.denom()) { return DENOMS[Math.min(DENOMS.length - 1, Math.round(Math.log10(N)))]; }
  cost(id) {
    const it = SHOP_MAP[id];
    return it.once ? it.base : it.base * Math.pow(it.growth, this.s.lv[id] || 0);
  }
  canBuy(id) {
    const it = SHOP_MAP[id];
    if (it.once && this.s[id]) return false;
    return this.s.sandbox || this.s[it.cur] >= this.cost(id);
  }

  cellAt(x, y) {
    const p = this.tess.pixel(x, y);
    if (p < 0) return -1;
    const s = this.tess.lab[p];
    return s >= 0 ? this.g.cellOf[s] : -1;
  }

  // ------------------------------------------------------------ the shape of the land
  // Target density: the ground's own (from its recipe), deepened by weights.
  computeRho() {
    const W = this.W, n = W * W, r0 = this.region.rho0;
    const rho = this.rho || (this.rho = new Float32Array(n));
    rho.set(r0);
    for (const w of this.s.weights) {
      const rad = w.r, R2 = (rad * 3) ** 2;
      const x0 = Math.max(0, Math.floor(w.x - rad * 3)), x1 = Math.min(W - 1, Math.ceil(w.x + rad * 3));
      const y0 = Math.max(0, Math.floor(w.y - rad * 3)), y1 = Math.min(W - 1, Math.ceil(w.y + rad * 3));
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
        const d2 = (x + 0.5 - w.x) ** 2 + (y + 0.5 - w.y) ** 2;
        if (d2 > R2) continue;
        rho[y * W + x] *= 1 + w.pull * Math.exp(-d2 / (rad * rad));
      }
    }
    this.rhoV = (this.rhoV || 0) + 1;
  }

  // Scatter `count` seeds in proportion to the target density.
  sowSeeds(count) {
    const W = this.W, R = this.rng, t = this.tess;
    if (!t.seeds.length) for (const q of this.region.seeds) t.seeds.push(Object.assign({}, q, { pin: true }));
    let max = 0;
    for (let p = 0; p < this.rho.length; p++) if (this.mask[p] === FREE && !this.region.river[p] && this.rho[p] > max) max = this.rho[p];
    let added = 0;
    for (let k = 0; k < 200000 && added < count; k++) {
      const x = R() * W, y = R() * W;
      const p = t.pixel(x, y);
      if (this.mask[p] !== FREE || this.region.river[p]) continue;
      if (R() * max > this.rho[p]) continue;
      if (!t.canSeed(x, y, 3)) continue;
      let slot = t.seeds.indexOf(null);
      if (slot < 0) slot = t.seeds.length;
      t.seeds[slot] = { x, y };
      added++;
    }
    this.applyComb();
    t.rebuild();
  }

  // Each seed takes the stretch of the comb field where it stands.
  applyComb() {
    const W = this.W, cf = this.comb;
    for (const sd of this.tess.seeds) {
      if (!sd) continue;
      const gx = Math.min(COMB - 1, Math.max(0, Math.floor(sd.x / W * COMB))), gy = Math.min(COMB - 1, Math.max(0, Math.floor(sd.y / W * COMB)));
      const k = (gy * COMB + gx) * 2;
      const a = cf[k], b = cf[k + 1];
      const str = Math.min(1.6, Math.hypot(a, b));
      sd.k = 1 + str;
      sd.a = 0.5 * Math.atan2(b, a);
      sd._c = undefined;
    }
  }

  // One step of weighted Lloyd relaxation: every free seed moves part of the
  // way to the density-weighted middle of its cell. Weighting by density
  // squared makes cell areas shrink in proportion to density. Lloyd alone only
  // shuffles cells between neighbours, so the land also balances mass: the
  // lightest cells (least ground times density) are swallowed and reappear
  // inside the heaviest, which is how a well draws cells in from far away.
  relaxStep(relayout = true) {
    const t = this.tess, lab = t.lab, rho = this.rho, W = this.W;
    const n = t.seeds.length;
    const sw = new Float64Array(n), sx = new Float64Array(n), sy = new Float64Array(n), mass = new Float64Array(n);
    for (let p = 0; p < lab.length; p++) {
      const s = lab[p];
      if (s < 0) continue;
      const r = rho[p], w = r * r;
      sw[s] += w; sx[s] += w * ((p % W) + 0.5); sy[s] += w * (((p / W) | 0) + 0.5);
      mass[s] += r;
    }
    let moved = 0;
    const free = [];
    for (let s = 0; s < n; s++) {
      const sd = t.seeds[s];
      if (!sd || sd.pin || !sw[s]) continue;
      free.push(s);
      const tx = sx[s] / sw[s], ty = sy[s] / sw[s];
      // a seed that doubles back (caught between two shapes of its cell) slows down
      let st = sd._st === undefined ? RELAX_STEP : sd._st;
      const mx = tx - sd.x, my = ty - sd.y;
      if (sd._mx !== undefined && mx * sd._mx + my * sd._my < 0) st *= 0.5;
      else st = Math.min(RELAX_STEP, st * 1.25);
      sd._st = st; sd._mx = mx; sd._my = my;
      const nx = sd.x + st * mx, ny = sd.y + st * my;
      const p = t.pixel(nx, ny);
      if (p < 0 || this.mask[p] !== FREE) continue;
      const d = Math.hypot(nx - sd.x, ny - sd.y);
      if (d > moved) moved = d;
      sd.x = nx; sd.y = ny;
    }
    // mass balance: pair the lightest cells with the heaviest
    if (free.length > 8) {
      let tot = 0;
      for (const s of free) tot += mass[s];
      const mean = tot / free.length;
      free.sort((a, b) => mass[a] - mass[b]);
      const most = Math.max(1, Math.round(free.length / 30));
      for (let k = 0; k < most; k++) {
        const lo = free[k], hi = free[free.length - 1 - k];
        if (!(mass[hi] > 1.5 * mean && mass[lo] < 0.8 * mean && mass[hi] > 2.2 * mass[lo])) break;
        const sl = t.seeds[lo], sh = t.seeds[hi];
        const cx = sx[hi] / sw[hi], cy = sy[hi] / sw[hi];
        // split the heavy cell: the swallowed seed reappears beside its middle
        let ax = cx - sh.x, ay = cy - sh.y;
        const al = Math.hypot(ax, ay);
        if (al < 0.5) { const a = this.rng() * Math.PI * 2; ax = Math.cos(a); ay = Math.sin(a); } else { ax /= al; ay /= al; }
        const rr = Math.sqrt(sw[hi] ? (mass[hi] / (sw[hi] / mass[hi])) : 4) * 0.35 + 1;
        const nx = cx + ax * rr, ny = cy + ay * rr;
        const p = t.pixel(nx, ny);
        if (p < 0 || this.mask[p] !== FREE || this.region.river[p]) continue;
        sl.x = nx; sl.y = ny;
        sl._st = sl._mx = sl._my = undefined;
        moved = Math.max(moved, 1);
      }
    }
    this.applyComb();
    if (relayout) this.mutate(() => t.rebuild());
    else t.rebuild();
    return moved;
  }

  // Something changed the shape: let the land settle again.
  wake() {
    this.still = 0;
    this.moving = true;
    this.relaxSteps = 0;
    for (const sd of this.tess.seeds) if (sd) sd._st = sd._mx = sd._my = undefined;
  }

  // Grow or shrink to the cell budget (More Ground).
  matchCellBudget() {
    const live = this.tess.seeds.filter(q => q && !q.pin).length;
    const want = this.cellBudget();
    if (live < want) { this.sowSeeds(want - live); this.wake(); }
  }

  // ------------------------------------------------------------ graph & steady state
  cellValues(g, lab) {
    const oreN = new Float64Array(g.n);
    for (let p = 0; p < lab.length; p++) {
      if (!this.ore[p]) continue;
      const s = lab[p];
      if (s >= 0 && g.cellOf[s] >= 0) oreN[g.cellOf[s]]++;
    }
    const val = new Float64Array(g.n);
    for (let c = 0; c < g.n; c++) val[c] = 1 + ORE_K * (g.area[c] ? oreN[c] / g.area[c] : 0);
    return { val, oreN };
  }

  // Gems per topple: only in crowded cells, more the more crowded.
  pressureOf(area) { return this.refArea / Math.max(1, area); }
  gemsPer(area) { const p = this.pressureOf(area); return p > 3 ? Math.log2(p / 3) + 0.25 : 0; }

  dropFor(g, tess, srcs = this.sources()) {
    const drop = new Float64Array(g.n);
    for (const q of srcs) {
      const p = tess.pixel(q.x, q.y);
      const s = p >= 0 ? tess.lab[p] : -1;
      const c = s >= 0 ? g.cellOf[s] : -1;
      if (c >= 0) drop[c] += q.rate;
    }
    return drop;
  }

  relayout(oldLab, oldG) {
    const g = buildGraph(this.tess);
    const pile = new Pile(g);
    if (this.pile && oldLab && oldG) {
      const map = new Int32Array(g.n);
      for (let c = 0; c < g.n; c++) {
        const p = this.tess.pixel(g.cx[c], g.cy[c]);
        const s = p >= 0 ? oldLab[p] : -1;
        map[c] = s >= 0 ? oldG.cellOf[s] : -1;
      }
      pile.inherit(this.pile, map);
    } else pile.fill(this.rng);
    this.g = g;
    this.pile = pile;
    if (!this.refArea) {
      let free = 0;
      for (let p = 0; p < this.mask.length; p++) if (this.mask[p] === FREE) free++;
      this.refArea = free / BASE_CELLS;
    }
    const cv = this.cellValues(g, this.tess.lab);
    this.val = cv.val;
    this.oreN = cv.oreN;
    this.gem = new Float64Array(g.n);
    for (let c = 0; c < g.n; c++) this.gem[c] = this.gemsPer(g.area[c]);
    this.layoutV = (this.layoutV || 0) + 1;
    this.recalc();
  }

  // full: the land or its values changed (not just where sand is poured)
  recalc(full = true) {
    if (!this.g) return;
    const g = this.g;
    if (full || !this.v || this.v.length !== g.n) { this.v = solve(g, this.val, this.v && this.v.length === g.n ? this.v : null); this.vVer = (this.vVer || 0) + 1; }
    this.drop = this.dropFor(g, this.tess);
    this.u = solve(g, this.drop, this.u && this.u.length === g.n ? this.u : null);
    let raw = 0, gems = 0, tot = 0;
    for (let c = 0; c < g.n; c++) { raw += this.drop[c] * this.v[c]; gems += this.u[c] * this.gem[c]; tot += this.u[c]; }
    this.raw = raw;
    this.expected = raw * this.valueMult();
    this.expectedGems = gems * this.gemMult();
    const R = this.realRate();
    this.linger = R > 0 ? tot / R : 0;
    this.share = new Float64Array(g.n);
    for (let c = 0; c < g.n; c++) this.share[c] = tot > 0 ? this.u[c] / tot : 0;
  }

  // ------------------------------------------------------------ time
  tick(dt) {
    const st = this.s;
    const real = dt;
    dt *= st.speed;
    if (!(dt > 0)) return;
    st.played += dt;
    this.time += dt;
    const N = this.denom();
    if (N !== this._lastN) { if (this._lastN) this.emit('denom', { N }); this._lastN = N; }
    this.sources().forEach((q, k) => {
      this.srcAcc[k] = (this.srcAcc[k] || 0) + q.rate / N * dt;
      const whole = Math.floor(this.srcAcc[k]);
      if (whole > 0) {
        this.srcAcc[k] -= whole;
        const c = this.cellAt(q.x, q.y);
        if (c >= 0) this.pile.grains[c] += whole;
      }
    });
    this.roundAcc += dt * ROUNDS * Math.max(1, Math.min(4, this.g.n / 250));
    let rounds = Math.floor(this.roundAcc);
    this.roundAcc -= rounds;
    rounds = Math.min(rounds, 240);
    let liveVal = 0, liveGems = 0;
    for (let r = 0; r < rounds; r++) {
      const res = this.pile.round(this.val, null, this.gem);
      liveVal += res.value;
      liveGems += res.value2;
      st.stats.topples += res.topples * N;
      if (res.wave > st.stats.maxWave) st.stats.maxWave = res.wave;
    }
    const live = liveVal * N * this.valueMult(), gems = liveGems * N * this.gemMult();
    const a = Math.min(1, dt / 8);
    this.liveEMA += a * (live / dt - this.liveEMA);
    this.gemEMA += a * (gems / dt - this.gemEMA);
    if (this.steady()) { this.gain(this.expected * dt); this.gainGems(this.expectedGems * dt); }
    else { this.gain(live); this.gainGems(gems); }
    // the land relaxes towards its target shape (in real time, not sped up)
    if (this.moving && st.settings.relax) {
      this.relaxAcc += real;
      if (this.relaxAcc >= RELAX_EVERY) {
        this.relaxAcc = 0;
        const m = this.relaxStep();
        this.still = m < 0.08 ? this.still + 1 : 0;
        if (this.still >= 4 || ++this.relaxSteps > 400) this.moving = false;
      }
    }
    this.tickAcc += dt;
    if (this.tickAcc >= 0.25) { this.erode(this.tickAcc); this.tickAcc = 0; }
  }

  gain(x) { if (x > 0) { this.s.dust += x; this.s.dustAll += x; } }
  gainGems(x) { if (x > 0) { this.s.gems += x; this.s.gemsAll += x; } }

  erode(dt) {
    const { lab } = this.tess, g = this.g, d = this.depth;
    const k = ERODE * this.erodeMult();
    const rate = new Float64Array(g.n);
    for (let c = 0; c < g.n; c++) rate[c] = g.area[c] ? k * this.share[c] / g.area[c] : 0;
    for (let p = 0; p < lab.length; p++) {
      const s = lab[p];
      if (s < 0) continue;
      const c = g.cellOf[s];
      if (c >= 0) d[p] += rate[c] * dt;
    }
    this.region.buried.forEach((b, i) => {
      if (this.s.found.includes(i)) return;
      if (d[this.tess.pixel(b.x, b.y)] >= b.depth) this.find(i);
    });
  }

  buriedProgress(i) {
    const b = this.region.buried[i];
    return Math.min(1, this.depth[this.tess.pixel(b.x, b.y)] / b.depth);
  }

  find(i) {
    this.s.found.push(i);
    this.applyFind(i, true);
    this.emit('find', { i, b: this.region.buried[i] });
  }

  applyFind(i, live) {
    const b = this.region.buried[i];
    const W = RASTER;
    const disc = (r, fn) => {
      for (let y = Math.floor(b.y - r); y <= b.y + r; y++) for (let x = Math.floor(b.x - r); x <= b.x + r; x++) {
        if (x < 0 || y < 0 || x >= W || y >= W) continue;
        if (Math.hypot(x + 0.5 - b.x, y + 0.5 - b.y) <= r) fn(y * W + x);
      }
    };
    if (b.kind === 'relic') { if (!this.s.relics.includes(b.relic)) this.s.relics.push(b.relic); }
    else if (b.kind === 'spring') this.springs.push([b.x, b.y]);
    else if (b.kind === 'ore') disc(b.r, (p) => { if (this.mask[p] === FREE) this.ore[p] = 1; });
    else if (b.kind === 'cave') disc(b.r, (p) => { if (this.mask[p] === FREE) this.mask[p] = CRACK; });
    if (!live) return;
    if (b.kind === 'cave') {
      const t = this.tess;
      t.seeds.forEach((q, k) => { if (q && this.mask[t.pixel(q.x, q.y)] !== FREE) t.seeds[k] = null; });
      for (const tp of this.s.taps) if (this.mask[t.pixel(tp.x, tp.y)] !== FREE) { tp.x = W / 2; tp.y = W / 2; }
      this.mutate(() => t.rebuild());
      this.matchCellBudget();
    } else if (b.kind === 'ore') {
      const cv = this.cellValues(this.g, this.tess.lab);
      this.val = cv.val; this.oreN = cv.oreN;
      this.recalc();
    } else this.recalc();
  }

  offline(sec) {
    if (!(sec > 5)) return null;
    sec = Math.min(sec, 8 * 3600);
    const before = this.s.dust, gb = this.s.gems, found = this.s.found.length;
    this.gain(this.expected * sec);
    this.gainGems(this.expectedGems * sec);
    this.erode(sec);
    return { sec, dust: this.s.dust - before, gems: this.s.gems - gb, finds: this.s.found.length - found };
  }

  // ------------------------------------------------------------ actions
  mutate(fn) {
    const oldLab = Int32Array.from(this.tess.lab), oldG = this.g;
    fn();
    this.relayout(oldLab, oldG);
  }

  buy(id) {
    if (!this.canBuy(id)) return false;
    const it = SHOP_MAP[id];
    if (!this.s.sandbox) this.s[it.cur] -= this.cost(id);
    if (it.once) {
      this.s[id] = true;
      if (id === 'survey') { this.s.mode = 'steady'; this.emit('survey'); }
    } else this.s.lv[id]++;
    if (id === 'ground') this.matchCellBudget();
    if (id === 'press') { for (let c = 0; c < this.g.n; c++) this.gem[c] = this.gemsPer(this.g.area[c]); }
    this.recalc(false);
    return true;
  }

  click(x, y) {
    const c = this.cellAt(x, y);
    if (c < 0) return false;
    this.pile.grains[c] += 1;
    this.s.stats.clicks++;
    if (this.steady()) { const N = this.denom(); this.gain(N * this.v[c] * this.valueMult()); }
    return true;
  }

  // taps ------------------------------------------------------------
  addTap(x, y) {
    if (this.cellAt(x, y) < 0) return false;
    this.s.taps.push({ x, y, share: 1 });
    this.recalc(false);
    return true;
  }
  moveTap(k, x, y) {
    if (this.cellAt(x, y) < 0) return false;
    this.s.taps[k].x = x; this.s.taps[k].y = y;
    this.recalc(false);
    return true;
  }
  removeTap(k) {
    if (this.s.taps.length <= 1) return false;
    this.s.taps.splice(k, 1);
    this.recalc(false);
    return true;
  }
  adjustTap(k, dir) {
    const t = this.s.taps[k];
    t.share = Math.max(0.25, Math.min(16, t.share * (dir > 0 ? 1.25 : 0.8)));
    this.recalc(false);
  }
  tapShare(k) { const tot = this.s.taps.reduce((a, t) => a + t.share, 0); return this.s.taps[k].share / tot; }

  // weights ----------------------------------------------------------
  addWeight(x, y) {
    const free = this.pullBudget() - this.pullUsed();
    if (free < 0.5 && !this.s.sandbox) return false;
    const p = this.tess.pixel(x, y);
    if (p < 0 || this.mask[p] === 3) return false;
    this.s.weights.push({ x, y, pull: this.s.sandbox ? 2 : Math.min(2, free), r: 26 });
    this.reshape();
    return true;
  }
  moveWeight(k, x, y) {
    const w = this.s.weights[k];
    w.x = x; w.y = y;
    this.reshape();
  }
  removeWeight(k) { this.s.weights.splice(k, 1); this.reshape(); }
  adjustWeight(k, dir, radius = false) {
    const w = this.s.weights[k];
    if (radius) w.r = Math.max(12, Math.min(70, w.r * (dir > 0 ? 1.12 : 0.9)));
    else {
      const room = this.s.sandbox ? Infinity : this.pullBudget() - this.pullUsed() + w.pull;
      w.pull = Math.max(0.5, Math.min(room, w.pull + (dir > 0 ? 0.5 : -0.5)));
    }
    this.reshape();
  }
  reshape() { this.computeRho(); this.wake(); }

  // the comb ---------------------------------------------------------
  // Stretch the ground along a stroke from (x0,y0) to (x1,y1); `smooth` undoes it.
  combStroke(x0, y0, x1, y1, smooth = false) {
    const W = this.W, cf = this.comb, cs = W / COMB;
    const dx = x1 - x0, dy = y1 - y0;
    const len = Math.hypot(dx, dy);
    if (len < 0.5 && !smooth) return;
    const th = Math.atan2(dy, dx);
    const c2 = Math.cos(2 * th), s2 = Math.sin(2 * th);
    const rad = 12;
    const steps = Math.max(1, Math.ceil(len / 2));
    for (let i = 0; i <= steps; i++) {
      const px = x0 + dx * i / steps, py = y0 + dy * i / steps;
      for (let gy = Math.floor((py - rad) / cs); gy <= (py + rad) / cs; gy++) for (let gx = Math.floor((px - rad) / cs); gx <= (px + rad) / cs; gx++) {
        if (gx < 0 || gy < 0 || gx >= COMB || gy >= COMB) continue;
        const d = Math.hypot((gx + 0.5) * cs - px, (gy + 0.5) * cs - py);
        if (d > rad) continue;
        const f = 0.12 * (1 - d / rad);
        const k = (gy * COMB + gx) * 2;
        if (smooth) { cf[k] *= 1 - f * 2; cf[k + 1] *= 1 - f * 2; }
        else { cf[k] += (c2 * 1.6 - cf[k]) * f; cf[k + 1] += (s2 * 1.6 - cf[k + 1]) * f; }
      }
    }
    this.wake();
  }

  // The tap or weight under (x, y), if any: { type, k }.
  markerAt(x, y, within) {
    const t = this.nearest(this.s.taps, x, y, within);
    if (t >= 0) return { type: 'tap', k: t };
    const w = this.nearest(this.s.weights, x, y, within);
    return w >= 0 ? { type: 'weight', k: w } : null;
  }

  // Income if a new tap (or tap k, moved) poured at (x, y), relative to now.
  previewTap(x, y, k = -1) {
    const c = this.cellAt(x, y);
    if (c < 0) return { ok: false };
    const f = this.flow();
    const taps = this.s.taps.map((t, i) => (i === k ? { x, y, share: t.share } : t));
    if (k < 0) taps.push({ x, y, share: 1 });
    const tot = taps.reduce((a, t) => a + t.share, 0);
    let raw = 0;
    for (const t of taps) { const ct = this.cellAt(t.x, t.y); if (ct >= 0) raw += f * t.share / tot * this.v[ct]; }
    for (const [sx, sy] of this.springs) { const ct = this.cellAt(sx, sy); if (ct >= 0) raw += f * 0.25 * this.v[ct]; }
    return { ok: true, cell: c, ratio: this.raw > 0 ? raw / this.raw : 1 };
  }

  nearest(list, x, y, within) {
    let best = -1, bd = within * within;
    list.forEach((q, k) => { const d = (q.x - x) ** 2 + (q.y - y) ** 2; if (d < bd) { bd = d; best = k; } });
    return best;
  }

  // ------------------------------------------------------------ the potential, for the overlay
  // A smoothed per-pixel map of how much a grain dropped there earns (log scale).
  potential() {
    if (this.vPixV === this.vVer) return this.vPix;
    const W = this.W, n = W * W, lab = this.tess.lab, cellOf = this.g.cellOf;
    const a = this.vPix || (this.vPix = new Float32Array(n));
    const m = new Float32Array(n);
    for (let p = 0; p < n; p++) {
      const s = lab[p];
      const c = s >= 0 ? cellOf[s] : -1;
      a[p] = c >= 0 ? Math.log(1 + this.v[c]) : 0;
      m[p] = c >= 0 ? 1 : 0;
    }
    // masked box blur, three passes, so contours run smoothly across cells
    const tmp = new Float32Array(n), tm = new Float32Array(n);
    const R = 3;
    for (let pass = 0; pass < 3; pass++) {
      for (let y = 0; y < W; y++) {
        let s = 0, c = 0;
        for (let x = -R; x < W + R; x++) {
          if (x + R < W) { s += a[y * W + x + R] * m[y * W + x + R]; c += m[y * W + x + R]; }
          if (x - R - 1 >= 0) { s -= a[y * W + x - R - 1] * m[y * W + x - R - 1]; c -= m[y * W + x - R - 1]; }
          if (x >= 0 && x < W) { tmp[y * W + x] = c > 0 ? s / c : 0; tm[y * W + x] = c > 0 ? 1 : 0; }
        }
      }
      for (let x = 0; x < W; x++) {
        let s = 0, c = 0;
        for (let y = -R; y < W + R; y++) {
          if (y + R < W) { s += tmp[(y + R) * W + x] * tm[(y + R) * W + x]; c += tm[(y + R) * W + x]; }
          if (y - R - 1 >= 0) { s -= tmp[(y - R - 1) * W + x] * tm[(y - R - 1) * W + x]; c -= tm[(y - R - 1) * W + x]; }
          if (y >= 0 && y < W && m[y * W + x]) a[y * W + x] = c > 0 ? s / c : 0;
        }
      }
    }
    let mx = 0;
    for (let p = 0; p < n; p++) if (m[p] && a[p] > mx) mx = a[p];
    this.vPixMax = mx;
    this.vPixV = this.vVer;
    return a;
  }
}
