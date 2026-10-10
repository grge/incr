// Prototype rules. The land shapes itself: cells crack where sand is busiest
// and quiet cracked ground settles back together. You choose where to pour,
// what to upgrade, and occasionally chisel or shake the ground.
// Income comes from the live sandpile (each grain you see stands for N
// grains); the Survey switches to the exact steady-state average.
import { Tess, buildGraph, FREE, CRACK } from './voronoi.js';
import { Pile, solve } from './pile.js';
import { generateRegion, mulberry32, RELICS, RECIPES } from './region.js';

export const RASTER = 320;
export const BUDGET = 20;          // visible grains per second before the sand coarsens
const ROUNDS = 30;                 // live toppling rounds per second (more on big lands)
const ORE_K = 4;                   // a cell made entirely of ore is worth 5×
// Erosion and cracking follow each cell's *share* of all topples, so their
// total pace stays steady however rich the land becomes.
const ERODE = 80;                  // how fast sand wears the ground away
const CRACK_RATE = 0.3;            // stress added per second, shared out by topples
const MIN_AREA = 70;               // cells smaller than this never crack (before Fine Grain)
const SETTLE_AFTER = 90;           // seconds a quiet, cracked cell waits before settling back
const CHISEL_MAX = 3, CHISEL_REGEN = 40;
const TREMOR_CD = 45;
const SAVE_V = 2;

export const DENOMS = ['sand', 'grit', 'gravel', 'pebbles', 'stones', 'cobbles', 'boulders', 'crags', 'cliffs', 'mountains'];

export const SHOP = [
  { id: 'spout', name: 'Spout', desc: 'Pours a steady trickle of sand. Where you put it decides where the land cracks.', base: 40, growth: 1.9, item: true },
  { id: 'rate', name: 'Finer Sand', desc: 'Spouts pour twice as fast.', base: 150, growth: 12 },
  { id: 'value', name: 'Sifting', desc: 'Every topple is worth twice as much.', base: 600, growth: 15 },
  { id: 'brittle', name: 'Brittle Ground', desc: 'The ground cracks twice as fast under busy sand.', base: 250, growth: 20, max: 4 },
  { id: 'fine', name: 'Fine Grain', desc: 'Cracks can split the ground into smaller cells.', base: 2000, growth: 25, max: 3 },
  { id: 'erode', name: 'Harder Sand', desc: 'Sand wears the ground away twice as fast.', base: 400, growth: 10 },
  { id: 'survey', name: 'The Survey', base: 25000, once: true,
    desc: 'Understand the land: earn the exact average of what the sand does, instead of what it happens to do.' },
];
export const SHOP_MAP = Object.fromEntries(SHOP.map(x => [x.id, x]));

export function newState(seed = Math.floor(Math.random() * 1e9), only = null) {
  return {
    v: SAVE_V, seed, only, dust: 0, dustAll: 0, played: 0,
    seeds: null, spouts: null,
    inv: { spout: 0 },
    lv: { spout: 0, rate: 0, value: 0, brittle: 0, fine: 0, erode: 0 },
    survey: false, mode: 'live',
    found: [], relics: [],
    chisel: CHISEL_MAX, tremorCd: 0,
    stats: { topples: 0, maxWave: 0, clicks: 0, splits: 0, merges: 0 },
    settings: { fracture: true, settle: true },
    sandbox: false, speed: 1, lastSave: Date.now(),
  };
}

function encodeDepth(d) {
  const q = new Uint16Array(d.length);
  for (let i = 0; i < d.length; i++) q[i] = Math.min(65535, Math.round(d[i] * 50));
  const bytes = new Uint8Array(q.buffer);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
function decodeDepth(b64, n) {
  const s = atob(b64);
  const bytes = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
  const q = new Uint16Array(bytes.buffer);
  const d = new Float32Array(n);
  for (let i = 0; i < n && i < q.length; i++) d[i] = q[i] / 50;
  return d;
}
const packSeed = (s) => [s.x, s.y, s.z, s.w || 1, s.k || 1, s.a || 0, s.f ? 1 : 0];
const unpackSeed = (a) => ({ x: a[0], y: a[1], z: a[2], w: a[3], k: a[4], a: a[5], f: a[6] });

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
      inv: Object.assign(base.inv, s.inv), lv: Object.assign(base.lv, s.lv),
      stats: Object.assign(base.stats, s.stats), settings: Object.assign(base.settings, s.settings),
    });
    const st = this.s;
    this.region = generateRegion(st.seed, RASTER, st.only);
    this.W = RASTER;
    this.mask = this.region.mask.slice();
    this.ore = this.region.ore.slice();
    this.depth = st.depth ? decodeDepth(st.depth, RASTER * RASTER) : new Float32Array(RASTER * RASTER);
    delete st.depth;
    const seeds = st.seeds ? st.seeds.map(unpackSeed) : this.region.seeds.map(q => Object.assign({}, q));
    delete st.seeds;
    if (!st.spouts) st.spouts = [this.region.spout.slice()];
    this.springs = [];
    for (const i of st.found) this.applyFind(i, false);
    this.tess = new Tess(RASTER, RASTER, this.mask);
    this.tess.seeds = seeds;
    this.tess.rebuild();
    this.stress = new Float64Array(seeds.length + 64);
    this.calm = new Float64Array(seeds.length + 64);
    this.born = new Float64Array(seeds.length + 64).fill(-1e9);
    this.g = null;
    this.pile = null;
    this.srcAcc = [];
    this.roundAcc = 0;
    this.tickAcc = 0;
    this.liveEMA = 0;
    this.time = 0;
    this._pv = null;
    this.relayout(null, null);
    return this;
  }

  newRegion(seed, only = null) {
    const keep = { sandbox: this.s.sandbox, speed: this.s.speed, settings: this.s.settings };
    this.load(Object.assign(newState(seed, only), keep));
    this.emit('region');
  }

  serialize() {
    const st = Object.assign({}, this.s, {
      seeds: this.tess.seeds.filter(Boolean).map(packSeed),
      depth: encodeDepth(this.depth), lastSave: Date.now(),
    });
    return JSON.stringify(st);
  }

  // ------------------------------------------------------------ derived numbers
  relicFx(key) {
    let m = 1;
    for (const id of this.s.relics) { const r = RELICS.find(x => x.id === id); if (r && r.fx[key]) m *= r.fx[key]; }
    return m;
  }
  spoutRate() { return Math.pow(2, this.s.lv.rate) * this.relicFx('rate'); }
  valueMult() { return Math.pow(2, this.s.lv.value) * this.relicFx('value'); }
  erodeMult() { return Math.pow(2, this.s.lv.erode) * this.relicFx('erode'); }
  brittle() { return Math.pow(2, this.s.lv.brittle); }
  minArea() { return MIN_AREA * Math.pow(0.75, this.s.lv.fine); }
  sources() {
    const r = this.spoutRate();
    return [...this.s.spouts.map(([x, y]) => ({ x, y, rate: r })), ...this.springs.map(([x, y]) => ({ x, y, rate: r, spring: true }))];
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
    if (it.max !== undefined && this.s.lv[id] >= it.max) return false;
    return this.s.sandbox || this.s.dust >= this.cost(id);
  }

  cellAt(x, y) {
    const p = this.tess.pixel(x, y);
    if (p < 0) return -1;
    const s = this.tess.lab[p];
    return s >= 0 ? this.g.cellOf[s] : -1;
  }

  seedOf(c) { return this.tess.seeds[this.g.slotOf[c]]; }
  hardness(c) { const sd = this.seedOf(c); return (RECIPES[sd.z] || RECIPES.mud).hard * (sd.w > 1 ? 1.5 : 1); }
  // Stress at which cell c cracks: harder ground and smaller cells take more.
  crackAt(c) { return this.hardness(c) * Math.sqrt(400 / Math.max(1, this.g.area[c])); }

  // Per-cell value of a topple: ore makes it richer.
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

  growSlots() {
    const need = this.tess.seeds.length + 8;
    if (this.stress.length >= need) return;
    const grow = (a, fill = 0) => { const b = new Float64Array(need * 2).fill(fill); b.set(a); return b; };
    this.stress = grow(this.stress);
    this.calm = grow(this.calm);
    this.born = grow(this.born, -1e9);
  }

  // Rebuild the graph after the tessellation changed, carrying sand over.
  relayout(oldLab, oldG) {
    this.growSlots();
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
    const cv = this.cellValues(g, this.tess.lab);
    this.val = cv.val;
    this.oreN = cv.oreN;
    this.layoutV = (this.layoutV || 0) + 1;
    this.recalc();
  }

  // Steady-state maps: v = value of a grain dropped on each cell; u = topples/s.
  recalc() {
    if (!this.g) return;
    const g = this.g;
    this.v = solve(g, this.val, this.v && this.v.length === g.n ? this.v : null);
    this.drop = this.dropFor(g, this.tess);
    this.u = solve(g, this.drop, this.u && this.u.length === g.n ? this.u : null);
    let raw = 0;
    for (let c = 0; c < g.n; c++) raw += this.drop[c] * this.v[c];
    this.raw = raw;
    this.expected = raw * this.valueMult();
    const R = this.realRate();
    let tot = 0;
    for (let c = 0; c < g.n; c++) tot += this.u[c];
    this.linger = R > 0 ? tot / R : 0;
    // per cell: its share of all topples
    this.share = new Float64Array(g.n);
    for (let c = 0; c < g.n; c++) this.share[c] = tot > 0 ? this.u[c] / tot : 0;
    this._pv = null;
  }

  // ------------------------------------------------------------ time
  tick(dt) {
    const st = this.s;
    dt *= st.speed;
    if (!(dt > 0)) return;
    st.played += dt;
    this.time += dt;
    const N = this.denom();
    if (N !== this._lastN) { if (this._lastN) this.emit('denom', { N }); this._lastN = N; }
    // sources pour visible grains
    this.sources().forEach((q, k) => {
      this.srcAcc[k] = (this.srcAcc[k] || 0) + q.rate / N * dt;
      const whole = Math.floor(this.srcAcc[k]);
      if (whole > 0) {
        this.srcAcc[k] -= whole;
        const c = this.cellAt(q.x, q.y);
        if (c >= 0) this.pile.grains[c] += whole;
      }
    });
    // toppling rounds
    // big lands take longer for avalanches to cross: topple faster to keep up
    this.roundAcc += dt * ROUNDS * Math.max(1, Math.min(4, this.g.n / 250));
    let rounds = Math.floor(this.roundAcc);
    this.roundAcc -= rounds;
    rounds = Math.min(rounds, 240);
    let liveVal = 0;
    for (let r = 0; r < rounds; r++) {
      const res = this.pile.round(this.val);
      liveVal += res.value;
      st.stats.topples += res.topples * N;
      if (res.wave > st.stats.maxWave) st.stats.maxWave = res.wave;
    }
    const live = liveVal * N * this.valueMult();
    this.liveEMA += Math.min(1, dt / 8) * (live / dt - this.liveEMA);
    this.gain(this.steady() ? this.expected * dt : live);
    // timers
    st.chisel = Math.min(CHISEL_MAX, st.chisel + dt / CHISEL_REGEN);
    st.tremorCd = Math.max(0, st.tremorCd - dt);
    // slow processes: erosion, cracking, settling
    this.tickAcc += dt;
    if (this.tickAcc >= 0.25) { this.slow(this.tickAcc); this.tickAcc = 0; }
  }

  steady() { return this.s.survey && this.s.mode === 'steady'; }

  gain(x) {
    if (!(x > 0)) return;
    this.s.dust += x;
    this.s.dustAll += x;
  }

  slow(dt) {
    this.erode(dt);
    if (this.s.settings.fracture || this.s.settings.settle) this.evolve(dt);
  }

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

  // Cells crack under busy sand; quiet cracked ground settles back.
  evolve(dt) {
    const g = this.g, st = this.s;
    const splits = [], merges = [];
    const minA = this.minArea(), br = this.brittle() * CRACK_RATE;
    for (let c = 0; c < g.n; c++) {
      const slot = g.slotOf[c];
      const b = this.share[c];
      if (st.settings.fracture) {
        this.stress[slot] += b * br * dt;
        if (g.area[c] >= minA && this.stress[slot] >= this.crackAt(c)) splits.push(c);
      }
      if (st.settings.settle) {
        this.calm[slot] = b < 0.0005 ? this.calm[slot] + dt : 0;
        if (this.tess.seeds[slot].f && this.calm[slot] > SETTLE_AFTER && g.area[c] < minA * 4) merges.push(slot);
      }
    }
    if (!splits.length && !merges.length) return;
    splits.sort((a, b) => this.stress[g.slotOf[b]] - this.stress[g.slotOf[a]]);
    const doSplits = splits.slice(0, 4);
    const doMerges = merges.slice(0, 2);
    this.mutate(() => {
      for (const c of doSplits) this.splitCell(c);
      for (const slot of doMerges) {
        this.tess.seeds[slot] = null;
        this.calm[slot] = 0;
        st.stats.merges++;
      }
      this.tess.rebuild();
    });
    if (doSplits.length) this.emit('crack', { n: doSplits.length });
    if (doMerges.length) this.emit('settle', { n: doMerges.length });
  }

  // Split cell c in two across its long axis (no rebuild).
  splitCell(c) {
    const g = this.g, t = this.tess;
    const slot = g.slotOf[c];
    const sd = t.seeds[slot];
    this.stress[slot] = 0;
    const a = g.mxx[c], b = g.myy[c], h = g.mxy[c];
    const lam = (a + b) / 2 + Math.sqrt(((a - b) / 2) ** 2 + h * h);
    const th = 0.5 * Math.atan2(2 * h, a - b);
    for (const f of [0.8, 0.55, 0.35]) {
      const d = f * Math.sqrt(Math.max(1, lam));
      const x1 = g.cx[c] + Math.cos(th) * d, y1 = g.cy[c] + Math.sin(th) * d;
      const x2 = g.cx[c] - Math.cos(th) * d, y2 = g.cy[c] - Math.sin(th) * d;
      if (!t.canSeed(x1, y1, 3, slot) || !t.canSeed(x2, y2, 3, slot)) continue;
      // children keep the ground's character; boulders crack into smaller boulders
      const w = sd.w > 1 ? Math.max(1, sd.w * 0.8) : 1;
      const child = (x, y) => ({ x, y, z: sd.z, w, k: sd.k, a: sd.a, f: 1 });
      t.seeds[slot] = child(x1, y1);
      let ns = t.seeds.indexOf(null);
      if (ns < 0) ns = t.seeds.length;
      t.seeds[ns] = child(x2, y2);
      this.growSlots();
      this.stress[ns] = 0; this.calm[ns] = 0; this.calm[slot] = 0;
      this.born[slot] = this.time; this.born[ns] = this.time;
      this.s.stats.splits++;
      this._lastSplit = [slot, ns];
      return true;
    }
    return false;
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
      this.s.spouts = this.s.spouts.filter(([x, y]) => {
        if (this.mask[t.pixel(x, y)] === FREE) return true;
        this.s.inv.spout++;
        return false;
      });
      this.mutate(() => t.rebuild());
    } else if (b.kind === 'ore') {
      const cv = this.cellValues(this.g, this.tess.lab);
      this.val = cv.val; this.oreN = cv.oreN;
      this.recalc();
    } else this.recalc();
  }

  offline(sec) {
    if (!(sec > 5)) return null;
    sec = Math.min(sec, 8 * 3600);
    const before = this.s.dust, found = this.s.found.length, splits = this.s.stats.splits;
    this.gain(this.expected * sec);
    // the land keeps shaping itself, a step at a time
    for (let t = 0; t < sec;) {
      const step = Math.min(30, sec - t);
      this.slow(step);
      t += step;
      if (this.s.stats.splits - splits > 400) break;
    }
    return { sec, dust: this.s.dust - before, finds: this.s.found.length - found, splits: this.s.stats.splits - splits };
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
    if (!this.s.sandbox) this.s.dust -= this.cost(id);
    if (it.once) {
      this.s[id] = true;
      if (id === 'survey') { this.s.mode = 'steady'; this.emit('survey'); }
    } else {
      this.s.lv[id]++;
      if (it.item) this.s.inv[id]++;
    }
    this.recalc();
    return true;
  }

  click(x, y) {
    const c = this.cellAt(x, y);
    if (c < 0) return false;
    this.pile.grains[c] += 1;
    this.s.stats.clicks++;
    if (this.steady()) this.gain(this.denom() * this.v[c] * this.valueMult());
    return true;
  }

  // The Chisel: crack a cell of your choosing (a few charges, slowly regained).
  chisel(x, y) {
    const c = this.cellAt(x, y);
    if (c < 0) return 'none';
    if (this.s.chisel < 1 && !this.s.sandbox) return 'empty';
    if (this.g.area[c] < this.minArea()) return 'small';
    let ok = false;
    this.mutate(() => { ok = this.splitCell(c); this.tess.rebuild(); });
    if (!ok) return 'small';
    if (!this.s.sandbox) this.s.chisel -= 1;
    return 'ok';
  }

  // A Tremor: shake every seed a little and load the pile, for one big avalanche.
  tremor() {
    if (this.s.tremorCd > 0 && !this.s.sandbox) return false;
    const t = this.tess, R = this.rng;
    this.mutate(() => {
      t.seeds.forEach((q, k) => {
        if (!q) return;
        const x = q.x + (R() - 0.5) * 5, y = q.y + (R() - 0.5) * 5;
        if (t.canSeed(x, y, 3, k)) t.seeds[k] = Object.assign({}, q, { x, y, _c: undefined });
      });
      t.rebuild();
    });
    const g = this.g, pile = this.pile;
    let added = 0;
    for (let c = 0; c < g.n; c++) {
      if (R() < 0.6) { const k = Math.max(0, g.thr[c] - 1 - pile.grains[c]); pile.grains[c] += k; added += k * this.v[c]; }
    }
    for (let k = 0; k < 6; k++) { const c = Math.floor(R() * g.n); pile.grains[c] += 1; added += this.v[c]; }
    if (this.steady()) this.gain(added * this.denom() * this.valueMult());
    this.s.tremorCd = TREMOR_CD;
    this.emit('tremor');
    return true;
  }

  placeSpout(x, y) {
    if (this.s.inv.spout <= 0 && !this.s.sandbox) return false;
    if (this.cellAt(x, y) < 0) return false;
    this.s.spouts.push([x, y]);
    if (!this.s.sandbox) this.s.inv.spout--;
    this.recalc();
    return true;
  }

  moveSpout(k, x, y) {
    if (this.cellAt(x, y) < 0) return false;
    this.s.spouts[k] = [x, y];
    this.recalc();
    return true;
  }

  pocketSpout(k) {
    if (this.s.spouts.length <= 1) return false;
    this.s.spouts.splice(k, 1);
    this.s.inv.spout++;
    this.recalc();
    return true;
  }

  nearestSpout(x, y, within) {
    let best = -1, bd = within * within;
    this.s.spouts.forEach(([sx, sy], k) => { const d = (sx - x) ** 2 + (sy - y) ** 2; if (d < bd) { bd = d; best = k; } });
    return best;
  }

  // ------------------------------------------------------------ previews
  previewSpout(x, y, k = -1) {
    const c = this.cellAt(x, y);
    if (c < 0) return { ok: false };
    const rate = this.spoutRate();
    let raw = this.raw + rate * this.v[c];
    if (k >= 0) { const o = this.cellAt(this.s.spouts[k][0], this.s.spouts[k][1]); if (o >= 0) raw -= rate * this.v[o]; }
    return { ok: true, ratio: this.raw > 0 ? raw / this.raw : 1 };
  }

  // What would chiselling the cell under (x, y) do?
  previewChisel(x, y) {
    const c = this.cellAt(x, y);
    const key = `c:${c}:${this.layoutV}`;
    if (this._pv && this._pv.key === key) return this._pv.res;
    let res = { ok: false, cell: c };
    if (c >= 0 && this.g.area[c] >= this.minArea()) {
      const t = this.tess;
      const saved = t.seeds.slice();
      const savedLab = Int32Array.from(t.lab), savedDist = Float64Array.from(t.dist);
      const st = { stress: this.stress[this.g.slotOf[c]], splits: this.s.stats.splits, born: this.born.slice() };
      if (this.splitCell(c)) {
        t.rebuild();
        const g = buildGraph(t);
        const { val } = this.cellValues(g, t.lab);
        const v = solve(g, val);
        const drop = this.dropFor(g, t);
        let raw = 0;
        for (let k = 0; k < g.n; k++) raw += drop[k] * v[k];
        res = { ok: true, cell: c, ratio: this.raw > 0 ? raw / this.raw : 1, lab: Int32Array.from(t.lab), slots: this._lastSplit };
      }
      t.seeds = saved; t.lab.set(savedLab); t.dist.set(savedDist);
      this.stress[this.g.slotOf[c]] = st.stress; this.s.stats.splits = st.splits; this.born = st.born;
    }
    this._pv = { key, res };
    return res;
  }
}
