// Prototype rules: one region shaped by stakes, fed by spouts, worn down by
// its own sand. Two ways of scoring: from the live sandpile (each grain you
// see stands for N grains), or — after the Survey — from the steady state.
import { Tess, buildGraph, FREE, CRACK } from './voronoi.js';
import { Pile, solve } from './pile.js';
import { generateRegion, mulberry32, RELICS } from './region.js';

export const RASTER = 320;
export const GAP = 9;              // stakes must be at least this far apart (raster px)
export const BUDGET = 20;          // visible grains per second before the sand coarsens
const ROUNDS = 30;                 // live toppling rounds per second
const ORE_K = 4;                   // a cell made entirely of ore is worth 5×
const ERODE = 2;                   // how fast sand wears the ground away
const SAVE_V = 1;

export const DENOMS = ['sand', 'grit', 'gravel', 'pebbles', 'stones', 'cobbles', 'boulders', 'crags', 'cliffs', 'mountains'];

export const SHOP = [
  { id: 'stake', name: 'Stake', desc: 'Carve a new cell out of the land.', base: 12, growth: 1.17, item: true },
  { id: 'spout', name: 'Spout', desc: 'Pours a steady trickle of sand.', base: 40, growth: 1.75, item: true },
  { id: 'rate', name: 'Finer Sand', desc: 'Spouts pour twice as fast.', base: 150, growth: 12 },
  { id: 'value', name: 'Sifting', desc: 'Every topple is worth twice as much.', base: 600, growth: 15 },
  { id: 'erode', name: 'Harder Sand', desc: 'Sand wears the ground away twice as fast.', base: 400, growth: 10 },
  { id: 'survey', name: 'The Survey', base: 25000, once: true,
    desc: 'Understand the land: earn the exact average of what the sand does, instead of what it happens to do.' },
];
export const SHOP_MAP = Object.fromEntries(SHOP.map(x => [x.id, x]));

export function newState(seed = Math.floor(Math.random() * 1e9)) {
  return {
    v: SAVE_V, seed, dust: 0, dustAll: 0, played: 0,
    stakes: null, spouts: null,
    inv: { stake: 0, spout: 0 },
    lv: { stake: 0, spout: 0, rate: 0, value: 0, erode: 0 },
    survey: false, mode: 'live',
    found: [], relics: [],
    stats: { topples: 0, maxWave: 0, clicks: 0 },
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
    const base = newState(s.seed);
    this.s = Object.assign(base, s, { inv: Object.assign(base.inv, s.inv), lv: Object.assign(base.lv, s.lv), stats: Object.assign(base.stats, s.stats) });
    const st = this.s;
    this.region = generateRegion(st.seed, RASTER);
    this.W = RASTER;
    this.mask = this.region.mask.slice();
    this.ore = this.region.ore.slice();
    this.depth = st.depth ? decodeDepth(st.depth, RASTER * RASTER) : new Float32Array(RASTER * RASTER);
    delete st.depth;
    if (!st.stakes) st.stakes = this.region.stakes.map(p => p.slice());
    if (!st.spouts) st.spouts = [this.region.spout.slice()];
    this.springs = [];
    for (const i of st.found) this.applyFind(i, false);
    this.tess = new Tess(RASTER, RASTER, this.mask);
    st.stakes = st.stakes.filter(Boolean);
    for (const [x, y] of st.stakes) this.tess.seeds.push({ x, y });
    this.tess.rebuild();
    this.g = null;
    this.pile = null;
    this.relayout(null, null);
    this.srcAcc = [];
    this.roundAcc = 0;
    this.erodeAcc = 0;
    this.liveEMA = 0;
    this.lastWave = 0;
    this._pv = null;
    this.recalc();
    return this;
  }

  newRegion(seed) {
    const keep = { sandbox: this.s.sandbox, speed: this.s.speed };
    this.load(Object.assign(newState(seed), keep));
    this.emit('region');
  }

  serialize() {
    const st = Object.assign({}, this.s, { stakes: this.s.stakes.filter(Boolean), depth: encodeDepth(this.depth), lastSave: Date.now() });
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
    return this.s.sandbox || this.s.dust >= this.cost(id);
  }

  cellAt(x, y) {
    const p = this.tess.pixel(x, y);
    if (p < 0) return -1;
    const s = this.tess.lab[p];
    return s >= 0 ? this.g.cellOf[s] : -1;
  }

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

  // Rebuild the graph after the tessellation changed, carrying sand over.
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
    const cv = this.cellValues(g, this.tess.lab);
    this.val = cv.val;
    this.oreN = cv.oreN;
    this.odo = new Float64Array(g.n);
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
    this.linger = 0;
    for (let c = 0; c < g.n; c++) this.linger += this.u[c];
    this.linger = R > 0 ? this.linger / R : 0;
    // erosion per pixel per second, for each cell: topples per grain poured, spread over the cell
    this.erodeRate = new Float64Array(g.n);
    for (let c = 0; c < g.n; c++) this.erodeRate[c] = R > 0 && g.area[c] ? ERODE * this.erodeMult() * (this.u[c] / R) / g.area[c] * 100 : 0;
    this._pv = null;
  }

  // ------------------------------------------------------------ time
  tick(dt) {
    const st = this.s;
    dt *= st.speed;
    if (!(dt > 0)) return;
    st.played += dt;
    const N = this.denom();
    if (N !== this._lastN) { if (this._lastN) this.emit('denom', { N }); this._lastN = N; }
    // sources pour visible grains
    const srcs = this.sources();
    srcs.forEach((q, k) => {
      this.srcAcc[k] = (this.srcAcc[k] || 0) + q.rate / N * dt;
      const whole = Math.floor(this.srcAcc[k]);
      if (whole > 0) {
        this.srcAcc[k] -= whole;
        const c = this.cellAt(q.x, q.y);
        if (c >= 0) this.pile.grains[c] += whole;
      }
    });
    // toppling rounds
    this.roundAcc += dt * ROUNDS;
    let rounds = Math.floor(this.roundAcc);
    this.roundAcc -= rounds;
    rounds = Math.min(rounds, 120);
    let liveVal = 0, wave = 0;
    for (let r = 0; r < rounds; r++) {
      const res = this.pile.round(this.val, this.odo);
      liveVal += res.value;
      st.stats.topples += res.topples * N;
      wave += res.wave;
      if (res.wave > st.stats.maxWave) st.stats.maxWave = res.wave;
    }
    this.lastWave = wave;
    const live = liveVal * N * this.valueMult();
    const a = Math.min(1, dt / 8);
    this.liveEMA += a * (live / dt - this.liveEMA);
    this.gain(st.survey && st.mode === 'steady' ? this.expected * dt : live);
    // the ground wears away
    this.erodeAcc += dt;
    if (this.erodeAcc >= 0.25) { this.erode(this.erodeAcc); this.erodeAcc = 0; }
  }

  gain(x) {
    if (!(x > 0)) return;
    this.s.dust += x;
    this.s.dustAll += x;
  }

  erode(dt) {
    const { lab } = this.tess, cellOf = this.g.cellOf, rate = this.erodeRate, d = this.depth;
    for (let p = 0; p < lab.length; p++) {
      const s = lab[p];
      if (s < 0) continue;
      const c = cellOf[s];
      if (c >= 0) d[p] += rate[c] * dt;
    }
    this.region.buried.forEach((b, i) => {
      if (this.s.found.includes(i)) return;
      const p = this.tess.pixel(b.x, b.y);
      if (d[p] >= b.depth) this.find(i);
    });
  }

  // Progress of a buried thing towards the surface (0..1).
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
      // stakes and spouts that fell in go back to your pocket
      this.s.stakes.forEach((q, k) => {
        if (!q) return;
        if (this.mask[this.tess.pixel(q[0], q[1])] !== FREE) { this.s.stakes[k] = null; this.tess.seeds[k] = null; this.s.inv.stake++; }
      });
      this.s.spouts = this.s.spouts.filter(([x, y]) => {
        if (this.mask[this.tess.pixel(x, y)] === FREE) return true;
        this.s.inv.spout++;
        return false;
      });
      this.mutate(() => this.tess.rebuild());
    } else if (b.kind === 'ore') {
      const cv = this.cellValues(this.g, this.tess.lab);
      this.val = cv.val; this.oreN = cv.oreN;
      this.recalc();
    } else this.recalc();
  }

  offline(sec) {
    if (!(sec > 5)) return null;
    sec = Math.min(sec, 8 * 3600);
    const before = this.s.dust, found = this.s.found.length;
    this.gain(this.expected * sec);
    this.erode(sec);
    return { sec, dust: this.s.dust - before, finds: this.s.found.length - found };
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
    if (this.s.survey && this.s.mode === 'steady') this.gain(this.denom() * this.v[c] * this.valueMult());
    return true;
  }

  placeStake(x, y) {
    if (this.s.inv.stake <= 0 && !this.s.sandbox) return false;
    if (!this.tess.canSeed(x, y, GAP)) return false;
    this.mutate(() => {
      const slot = this.tess.add(x, y);
      this.s.stakes[slot] = [x, y];
    });
    if (!this.s.sandbox) this.s.inv.stake--;
    return true;
  }

  moveStake(slot, x, y) {
    if (!this.tess.canSeed(x, y, GAP, slot)) return false;
    this.mutate(() => { this.tess.move(slot, x, y); this.s.stakes[slot] = [x, y]; });
    return true;
  }

  pocketStake(slot) {
    if (this.s.stakes.filter(Boolean).length <= 2) return false;
    this.mutate(() => { this.tess.remove(slot); this.s.stakes[slot] = null; });
    this.s.inv.stake++;
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

  // Lloyd relaxation: move every stake to the middle of its cell.
  relax() {
    this.mutate(() => {
      const g = this.g;
      for (let c = 0; c < g.n; c++) {
        const slot = g.slotOf[c];
        const x = g.cx[c], y = g.cy[c];
        if (this.tess.canSeed(x, y, GAP, slot)) { this.tess.seeds[slot] = { x, y }; this.s.stakes[slot] = [x, y]; }
      }
      this.tess.rebuild();
    });
  }

  // ------------------------------------------------------------ previews
  // What would a stake here (or the stake `slot` moved here) do?
  previewStake(x, y, slot = -1) {
    const key = `s:${Math.round(x * 2)}:${Math.round(y * 2)}:${slot}:${this.layoutV}:${this.s.spouts.length}`;
    if (this._pv && this._pv.key === key) return this._pv.res;
    let res;
    if (!this.tess.canSeed(x, y, GAP, slot)) res = { ok: false };
    else {
      const t = this.tess.clone();
      const s = slot >= 0 ? (t.move(slot, x, y), slot) : t.add(x, y);
      const g = buildGraph(t);
      const { val } = this.cellValues(g, t.lab);
      const v = solve(g, val);
      const drop = this.dropFor(g, t);
      let raw = 0;
      for (let c = 0; c < g.n; c++) raw += drop[c] * v[c];
      res = { ok: true, ratio: this.raw > 0 ? raw / this.raw : 1, tess: t, slot: s, cell: g.cellOf[s], g };
    }
    this._pv = { key, res };
    return res;
  }

  previewSpout(x, y, k = -1) {
    const c = this.cellAt(x, y);
    if (c < 0) return { ok: false };
    const rate = this.spoutRate();
    let raw = this.raw + rate * this.v[c];
    if (k >= 0) { const o = this.cellAt(this.s.spouts[k][0], this.s.spouts[k][1]); if (o >= 0) raw -= rate * this.v[o]; }
    return { ok: true, ratio: this.raw > 0 ? raw / this.raw : 1 };
  }
}
