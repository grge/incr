// Core game logic. No DOM access here, so it can be driven headlessly.
import { Board, EMPTY, CRYSTAL, STONE, PRISM, DX, DY } from './sim.js';
import * as D from './data.js';

export const SAVE_VERSION = 1;
const FIRST_SWEEP = 2e8;
const GLASS_EXP = 0.35;

export function newState() {
  return {
    v: SAVE_VERSION,
    dust: 0, dustRun: 0, dustAll: 0,
    glass: 0, glassAll: 0,
    sand: 0, sandAll: 0,
    sweeps: 0,
    owned: { hourglass: 0, crystal: 0, stone: 0, prism: 0 },
    inv: { hourglass: 0, crystal: 0, stone: 0, prism: 0 },
    up: {},
    kiln: {},
    polish: 0,
    doctrine: null,
    trial: null,
    trials: {},
    ach: {},
    journal: [],
    blueprint: [],
    tables: null,
    activeTable: 0,
    fold: false,
    great: 0,
    ended: false,
    quakeCd: 0,
    aftershock: 0,
    gleamTimer: 45,
    gleam: null,
    buffs: {},
    auto: { hourglass: true, upgrades: true, crystal: true, quake: true },
    settings: { sound: true, volume: 0.5, autoPlace: true, particles: true, survey: 0, reduceMotion: false },
    stats: {
      topples: 0, clicks: 0, handGrains: 0, quakes: 0, gleams: 0, maxWave: 0,
      played: 0, runTime: 0, lastSweepAt: -1e9, bestGain: 0, grains: 0,
    },
    flags: {},
    seen: {},
    lastSave: Date.now(),
  };
}

function rngInt(rng, n) { return Math.floor(rng() * n); }

export class Game {
  constructor(opts = {}) {
    this.analyticOnly = !!opts.analytic;
    this.rng = opts.rng || Math.random;
    this.events = [];
    this.s = newState();
    this.boards = [];
    this.roundAcc = 0;
    this.layoutVersion = 0;
    this.analysis = null;
    this.bestLinger = 0;
    this.tickAcc = 0;
    this.autoAcc = 0;
    this.slowAcc = 0;
    this.lastRoundStats = null;
    this.recentDust = 0;
    this.fx = null;
    this.recomputeFx();
    this.boards = [this.makeTable(0, this.startSize())];
    this.applyMemory();
    this.layoutChanged();
  }

  // ------------------------------------------------------------ events
  emit(type, data = {}) { this.events.push({ type, ...data }); }
  drainEvents() { const e = this.events; this.events = []; return e; }

  // ------------------------------------------------------------ effects
  kilnActive() { return this.s.trial !== 't_glassless'; }

  recomputeFx() {
    const fx = {
      rate: 1, hand: 1, dust: 1, crystal: 0, crystalMul: 1, prism: 0, glass: 1, stones: 0,
      quake: 1, quakeCd: 1, gleamFreq: 1, gleamPow: 1, size: D.START_SIZE, tables: 0,
      foldBonus: 1, stoneGlow: 1, memory: 0, reveal: 0, collectSand: false,
      unlocks: new Set(), auto: new Set(),
    };
    const apply = (f) => {
      for (const k in f) {
        const v = f[k];
        switch (k) {
          case 'rate': case 'dust': case 'crystalMul': case 'glass': case 'quake': case 'quakeCd':
          case 'gleamFreq': case 'gleamPow': case 'foldBonus': case 'stoneGlow':
            fx[k] *= v; break;
          case 'crystal': case 'prism': case 'stones': case 'tables':
            fx[k] += v; break;
          case 'hand': case 'size': case 'memory': case 'reveal':
            fx[k] = Math.max(fx[k], v); break;
          case 'unlock': fx.unlocks.add(v); break;
          case 'auto': fx.auto.add(v); break;
          case 'collectSand': fx.collectSand = true; break;
        }
      }
    };
    for (const id in this.s.up) if (D.UPGRADE_MAP[id]) apply(D.UPGRADE_MAP[id].fx);
    const kOn = this.kilnActive();
    for (const id in this.s.kiln) {
      const k = D.KILN_MAP[id];
      if (!k) continue;
      if (!kOn && !k.fx.auto && !k.fx.memory) continue;
      apply(k.fx);
    }
    for (const id in this.s.trials) if (D.TRIAL_MAP[id]) apply(D.TRIAL_MAP[id].fx);
    for (let i = 0; i < this.s.great; i++) apply(D.GREAT[i].fx);
    if (this.fx) {
      for (const u of fx.unlocks) if (!this.fx.unlocks.has(u) && !this.s.seen['unlock_' + u]) {
        this.s.seen['unlock_' + u] = true;
        this.emit('unlock', { what: u });
      }
    }
    this.fx = fx;
  }

  has(flag) { return this.fx.unlocks.has(flag); }
  hasAuto(flag) { return this.fx.auto.has(flag); }

  achCount() { return Object.keys(this.s.ach).length; }

  patienceMult() {
    return Math.min(8, 1 + 7 * this.s.stats.runTime / 2400);
  }

  polishMult() { return this.kilnActive() ? Math.pow(D.POLISH.mult, this.s.polish) : 1; }

  // Dust multiplier excluding temporary buffs.
  dustMultBase() {
    let m = this.fx.dust * this.polishMult() * (1 + D.ACH_BONUS * this.achCount());
    if (this.s.doctrine === 'patience') m *= this.patienceMult();
    if (this.s.fold && this.has('fold')) m *= this.fx.foldBonus;
    return m;
  }

  buffMult() {
    let m = 1;
    if (this.s.buffs.shimmer > 0) m *= 5;
    if (this.s.aftershock > 0) m *= 3;
    return m;
  }

  dustMult() { return this.dustMultBase() * this.buffMult(); }

  milestoneCount() {
    const n = this.s.owned.hourglass;
    let k = 0;
    for (const m of D.HG_MILESTONES) if (n >= m) k++;
    return k;
  }

  nextMilestone() {
    const n = this.s.owned.hourglass;
    for (const m of D.HG_MILESTONES) if (n < m) return m;
    return null;
  }

  baseHourglassRate() {
    let r = 0.5 * this.fx.rate * Math.pow(2, this.milestoneCount());
    if (this.s.doctrine === 'flow') r *= 3;
    return r;
  }

  hourglassRate() {
    let r = this.baseHourglassRate();
    if (this.s.buffs.sandstorm > 0) r *= 10;
    return r;
  }

  handGrains() { return this.fx.hand; }

  crystalBonus() {
    let c = (3 + this.fx.crystal) * this.fx.crystalMul;
    if (this.s.doctrine === 'facet') c *= 3;
    return c;
  }

  prismFactor() { return 2 + this.fx.prism; }

  maxSize() {
    let m = this.fx.size;
    if (this.s.trial === 't_narrow') m = Math.min(m, 9);
    return m;
  }

  startSize() {
    let size = D.START_SIZE;
    if (this.fx.memory >= 1) size = 7;
    if (this.fx.memory >= 2) size = 11;
    if (this.s.trial === 't_narrow') size = Math.min(size, 9);
    return size;
  }

  stoneLimit() { return this.has('stone') ? this.fx.stones : 0; }
  maxTables() { return 1 + (this.kilnActive() ? this.fx.tables : 0); }

  quakeCooldown() {
    let c = 60 * this.fx.quakeCd;
    if (this.s.doctrine === 'tremor') c /= 2;
    return c;
  }

  quakeSeconds() {
    let q = 30 * this.fx.quake;
    if (this.s.doctrine === 'tremor') q *= 2;
    return q;
  }

  canQuake() { return this.has('quake') && this.s.trial !== 't_still'; }
  gleamsOn() { return this.has('gleam') && this.s.trial !== 't_still'; }
  canClick() { return this.s.trial !== 't_still'; }

  gleamInterval() {
    let f = this.fx.gleamFreq;
    if (this.s.doctrine === 'tremor') f *= 2;
    return (60 + this.rng() * 90) / f;
  }

  gleamTTL() { return this.s.trials.t_scatter ? 20 : 13; }

  // ------------------------------------------------------------ tables
  rules() {
    return {
      fold: this.s.fold && this.has('fold'),
      weights: this.s.trial === 't_wind' ? [1, 2, 1, 0] : [1, 1, 1, 1],
      keep: this.s.trial === 't_crumble' ? 0.75 : 1,
    };
  }

  applyRules(b) {
    const r = this.rules();
    b.fold = r.fold;
    b.weights = r.weights;
    b.keep = r.keep;
    b.rebuild();
  }

  makeTable(index, size) {
    const b = new Board(size);
    for (let i = 0; i < b.n; i++) {
      b.grains[i] = this.rng() < 0.6 ? 3 : 2;
      b.acc[i] = this.rng();
    }
    if (index > 0) b.funnel = b.idx(size >> 1, size >> 1);
    this.applyRules(b);
    return b;
  }

  resizeTables(size) {
    for (let t = 0; t < this.boards.length; t++) {
      const old = this.boards[t];
      if (old.size >= size) continue;
      const nb = old.resized(size);
      const off = (size - old.size) >> 1;
      for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
        if (x >= off && y >= off && x < off + old.size && y < off + old.size) continue;
        const i = nb.idx(x, y);
        nb.grains[i] = 1 + rngInt(this.rng, 2);
        nb.acc[i] = this.rng();
      }
      this.applyRules(nb);
      this.boards[t] = nb;
    }
    this.layoutChanged();
    this.emit('resize', { size });
  }

  addTable() {
    const b = this.makeTable(this.boards.length, this.boards[0].size);
    this.boards.push(b);
    this.layoutChanged();
  }

  // Kinds / values / rules changed: every steady-state map must be re-solved.
  layoutChanged() {
    this.layoutVersion++;
    this.flowVersion = (this.flowVersion || 0) + 1;
  }

  // Only hourglass counts or positions changed: no re-solve needed.
  flowChanged() {
    this.flowVersion = (this.flowVersion || 0) + 1;
  }

  refreshVals() {
    const cb = this.crystalBonus(), pf = this.prismFactor(), sg = this.fx.stoneGlow;
    for (const b of this.boards) {
      const s = b.size;
      for (let i = 0; i < b.n; i++) {
        let v = 1;
        if (b.kind[i] === STONE) { b.val[i] = 0; continue; }
        const x = i % s, y = (i / s) | 0;
        let prisms = 0, stones = 0;
        for (let d = 0; d < 4; d++) {
          let nx = x + DX[d];
          const ny = y + DY[d];
          if (b.fold && (d === 1 || d === 3)) nx = (nx + s) % s;
          if (nx < 0 || ny < 0 || nx >= s || ny >= s) continue;
          const k = b.kind[ny * s + nx];
          if (k === PRISM) prisms++;
          else if (k === STONE) stones++;
        }
        if (b.kind[i] === CRYSTAL) {
          v = cb * Math.pow(pf, prisms);
          if (prisms >= 3) this.s.flags.prism3 = true;
        }
        if (sg > 1 && stones > 0) v *= Math.pow(sg, stones);
        b.val[i] = v;
      }
    }
  }

  // ------------------------------------------------------------ analysis
  // Per-grain maps that depend only on the layout (not on where hourglasses are):
  //   v      expected dust value (pre global multiplier) of one grain dropped at a cell
  //   linger expected topples caused by one grain dropped at a cell
  //   X      expected fraction of a grain that eventually leaves the table (1 unless sand crumbles)
  // By duality, total production = sum over sources of rate × v, so buying
  // hourglasses never needs a re-solve.
  layoutSolve() {
    const key = `${this.layoutVersion}:${this.crystalBonus()}:${this.prismFactor()}:${this.fx.stoneGlow}:${this.boards.length}`;
    if (this._layout && this._layout.key === key) return this._layout;
    this.refreshVals();
    const prev = this._layout;
    const tables = [];
    let linger = 0;
    for (let t = 0; t < this.boards.length; t++) {
      const b = this.boards[t];
      const pt = prev && prev.tables[t] && prev.tables[t].n === b.n ? prev.tables[t] : null;
      const v = b.solveValue(b.val, pt && pt.v);
      const ones = new Float64Array(b.n);
      for (let i = 0; i < b.n; i++) ones[i] = b.kind[i] === STONE ? 0 : 1;
      const l = b.solveValue(ones, pt && pt.linger);
      for (let i = 0; i < b.n; i++) if (l[i] > linger) linger = l[i];
      let X = null;
      if (b.keep < 1) {
        const ex = new Float64Array(b.n);
        for (let i = 0; i < b.n; i++) {
          for (let d = 0; d < 4; d++) if (b.tgt[i * 4 + d] === -1) ex[i] += b.weights[d] * b.keep;
        }
        X = b.solveValue(ex);
      }
      tables.push({ n: b.n, v, linger: l, X, down: 0 });
    }
    for (let t = tables.length - 2; t >= 0; t--) {
      const f = this.boards[t + 1].funnel, nt = tables[t + 1];
      tables[t].down = nt.v[f] + (nt.X ? nt.X[f] : 1) * nt.down;
    }
    this.bestLinger = Math.max(this.bestLinger, linger);
    this._layout = { key, tables, linger };
    return this._layout;
  }

  analyze() {
    const L = this.layoutSolve();
    const r = this.baseHourglassRate();
    const scatter = this.s.trial === 't_scatter';
    const key = `${this.flowVersion}:${r}:${L.key}:${scatter}`;
    if (this.analysis && this.analysis.key === key) return this.analysis;
    let inflow = 0, raw = 0, grainRate = 0, topplesAll = 0;
    const tables = [];
    for (let t = 0; t < this.boards.length; t++) {
      const b = this.boards[t], Lt = L.tables[t];
      const drop = new Float64Array(b.n);
      let hg = 0;
      for (const i of b.hourglasses) hg += b.hg[i];
      grainRate += hg * r;
      if (scatter) {
        let free = 0;
        for (let i = 0; i < b.n; i++) if (b.kind[i] !== STONE) free++;
        for (let i = 0; i < b.n; i++) if (b.kind[i] !== STONE) drop[i] = hg * r / free;
      } else {
        for (const i of b.hourglasses) drop[i] += r * b.hg[i];
      }
      if (t > 0 && b.funnel >= 0) drop[b.funnel] += inflow;
      let traw = 0, topples = 0, spill = 0;
      for (let i = 0; i < b.n; i++) {
        const d = drop[i];
        if (d === 0) continue;
        traw += d * Lt.v[i];
        topples += d * Lt.linger[i];
        spill += d * (Lt.X ? Lt.X[i] : 1);
      }
      raw += traw;
      topplesAll += topples;
      tables.push({ n: b.n, v: Lt.v, linger: Lt.linger, X: Lt.X, down: Lt.down, drop, raw: traw, topples, spill, u: null });
      inflow = spill;
    }
    this.analysis = { key, tables, raw, grainRate, spill: inflow, topples: topplesAll };
    return this.analysis;
  }

  // Steady-state topple rate per cell of table t (solved lazily).
  toppleMap(t) {
    const a = this.analyze();
    const at = a.tables[t];
    if (!at.u) {
      const prev = this._lastU && this._lastU[t] && this._lastU[t].length === at.n ? this._lastU[t] : null;
      at.u = this.boards[t].solveTopples(at.drop, prev);
      this._lastU = this._lastU || [];
      this._lastU[t] = at.u;
    }
    return at.u;
  }

  // dust per second at steady state (without temporary buffs)
  baseRate() { return this.analyze().raw * this.dustMultBase(); }
  // dust per second including buffs (sandstorm scales the flow linearly)
  currentRate() {
    let r = this.analyze().raw * this.dustMult();
    if (this.s.buffs.sandstorm > 0) r *= 10;
    return r;
  }

  sandMult() { return 50 * (this.s.great >= 4 ? 4 : 1); }
  sandRate() {
    if (!this.fx.collectSand) return 0;
    return this.analyze().spill * this.sandMult() * (this.s.buffs.sandstorm > 0 ? 10 : 1);
  }

  // ------------------------------------------------------------ placement
  costOf(type, owned = this.s.owned[type]) {
    const b = D.BUILDINGS[type];
    return b.base * Math.pow(b.growth, owned);
  }

  buildingUnlocked(type) {
    const b = D.BUILDINGS[type];
    return !b.unlock || this.has(b.unlock);
  }

  buildingLimit(type) {
    if (type === 'stone') return this.stoneLimit();
    return Infinity;
  }

  canBuy(type) {
    return this.buildingUnlocked(type) && this.s.owned[type] < this.buildingLimit(type) && this.s.dust >= this.costOf(type);
  }

  buyBuilding(type, place = true) {
    if (!this.canBuy(type)) return false;
    this.s.dust -= this.costOf(type);
    const before = type === 'hourglass' ? this.milestoneCount() : 0;
    this.s.owned[type]++;
    this.s.inv[type]++;
    if (place) this.autoPlace(type);
    this.emit('bought', { what: type });
    if (type === 'hourglass' && this.milestoneCount() > before) {
      this.emit('milestone', { n: this.s.owned.hourglass, mult: Math.pow(2, this.milestoneCount()) });
    }
    return true;
  }

  // Try blueprint first, then heuristic best cell. Leaves it in inventory on failure.
  autoPlace(type, allowHeuristic = this.s.settings.autoPlace) {
    if (this.s.inv[type] <= 0) return false;
    for (const e of this.s.blueprint) {
      if (e.type !== type) continue;
      const b = this.boards[e.t];
      if (!b) continue;
      const c = b.size >> 1;
      const x = c + e.dx, y = c + e.dy;
      if (x < 0 || y < 0 || x >= b.size || y >= b.size) continue;
      const i = b.idx(x, y);
      if (type === 'hourglass') {
        if (b.kind[i] === STONE || b.hg[i] >= (e.n || 1)) continue;
      } else {
        if (b.kind[i] !== EMPTY) continue;
        if (type === 'stone' && !b.canPlaceStone(i)) continue;
      }
      return this.place(type, e.t, i, true);
    }
    if (type === 'stone' || !allowHeuristic) return false;
    const best = this.bestCellFor(type);
    if (!best) return false;
    return this.place(type, best.t, best.i, true);
  }

  bestCellFor(type) {
    const a = this.analyze();
    let best = null;
    const pf = this.prismFactor(), cb = this.crystalBonus(), sg = this.fx.stoneGlow;
    for (let t = 0; t < this.boards.length; t++) {
      const b = this.boards[t], at = a.tables[t], s = b.size;
      const u = type === 'hourglass' ? null : this.toppleMap(t);
      for (let i = 0; i < b.n; i++) {
        let score;
        if (type === 'hourglass') {
          if (b.kind[i] === STONE) continue;
          score = at.v[i] + (at.X ? at.X[i] : 1) * at.down;
          if (t > 0) score *= 0.999; // prefer the top table on ties
        } else {
          if (b.kind[i] !== EMPTY) continue;
          const x = i % s, y = (i / s) | 0;
          let prisms = 0, stones = 0, gain = 0;
          for (let d = 0; d < 4; d++) {
            let nx = x + DX[d];
            const ny = y + DY[d];
            if (b.fold && (d === 1 || d === 3)) nx = (nx + s) % s;
            if (nx < 0 || ny < 0 || nx >= s || ny >= s) continue;
            const j = ny * s + nx;
            if (b.kind[j] === PRISM) prisms++;
            else if (b.kind[j] === STONE) stones++;
            else if (b.kind[j] === CRYSTAL) gain += u[j] * b.val[j] * (pf - 1);
          }
          if (type === 'crystal') {
            const nv = cb * Math.pow(pf, prisms) * Math.pow(sg, stones);
            score = u[i] * (nv - b.val[i]);
          } else {
            score = gain + u[i] * 1e-6;
          }
        }
        if (!best || score > best.score) best = { t, i, score };
      }
    }
    return best;
  }

  // Greedy search for a good stone cell (used by the Suggest button and the bot).
  suggestStone() {
    const a = this.analyze();
    let best = null;
    for (let t = 0; t < this.boards.length; t++) {
      const b = this.boards[t], at = a.tables[t];
      const u0 = this.toppleMap(t);
      let maxU = 0;
      for (let i = 0; i < b.n; i++) if (u0[i] > maxU) maxU = u0[i];
      const cands = [];
      for (let i = 0; i < b.n; i++) if (u0[i] >= maxU * 0.02 && b.kind[i] === EMPTY && b.hg[i] === 0 && i !== b.funnel) cands.push(i);
      cands.sort((p, q) => u0[q] - u0[p]);
      cands.length = Math.min(cands.length, 28);
      for (const i of cands) {
        if (!b.canPlaceStone(i)) continue;
        b.kind[i] = STONE;
        b.rebuild();
        const u = b.solveTopples(at.drop, u0, 1e-7);
        let traw = 0;
        for (let j = 0; j < b.n; j++) if (j !== i) traw += u[j] * b.val[j];
        b.kind[i] = EMPTY;
        b.rebuild();
        const score = (traw - at.raw) * (1 + (at.down > 0 ? 0 : 0));
        if (!best || score > best.score) best = { t, i, score };
      }
    }
    if (best && best.score > 0) return best;
    return null;
  }

  place(type, t, i, auto = false) {
    const b = this.boards[t];
    if (!b || i < 0 || i >= b.n) return false;
    if (this.s.inv[type] <= 0) return false;
    if (type === 'hourglass') {
      if (b.kind[i] === STONE) return false;
      b.hg[i]++;
      if (b.hg[i] === 1) b.rebuild();
      this.s.inv[type]--;
      this.flowChanged();
      return true;
    } else {
      if (b.kind[i] !== EMPTY) return false;
      const kind = D.BUILDINGS[type].kind;
      if (kind === STONE) {
        if (b.hg[i] > 0 || b.funnel === i) return false;
        if (!b.canPlaceStone(i)) {
          this.s.flags.triedTrap = true;
          if (!auto) this.emit('toast', { text: 'The sand would be trapped there. Stones must always leave it a way out.', kind: 'warn' });
          return false;
        }
        b.grains[i] = 0;
      }
      b.kind[i] = kind;
    }
    b.rebuild();
    this.s.inv[type]--;
    this.layoutChanged();
    return true;
  }

  // Remove the top thing on a cell (one hourglass, or the building) to inventory.
  removeAt(t, i, wholeStack = false) {
    const b = this.boards[t];
    if (!b) return false;
    if (b.hg[i] > 0) {
      const k = wholeStack ? b.hg[i] : 1;
      b.hg[i] -= k;
      this.s.inv.hourglass += k;
      b.rebuild();
      this.flowChanged();
      return 'hourglass';
    }
    const k = b.kind[i];
    if (k === EMPTY) return false;
    const type = D.KIND_TO_BUILDING[k];
    b.kind[i] = EMPTY;
    b.rebuild();
    this.s.inv[type]++;
    this.layoutChanged();
    return type;
  }

  // Drag: moves the hourglass stack if there is one, else the building (swapping).
  move(t, from, to) {
    const b = this.boards[t];
    if (!b || from === to) return false;
    if (b.hg[from] > 0) {
      if (b.kind[to] === STONE) return false;
      b.hg[to] += b.hg[from];
      b.hg[from] = 0;
      b.acc[to] = b.acc[from];
      b.rebuild();
      this.flowChanged();
      return true;
    }
    const kf = b.kind[from], kt = b.kind[to];
    if (kf === EMPTY) return false;
    if (kf === STONE && (b.hg[to] > 0 || b.funnel === to)) return false;
    if (kt === STONE && (b.hg[from] > 0 || b.funnel === from)) return false;
    const trial = b.kind.slice();
    trial[from] = kt;
    trial[to] = kf;
    if ((kf === STONE || kt === STONE) && !b.allCellsDrain(trial)) {
      this.s.flags.triedTrap = true;
      this.emit('toast', { text: 'The sand would be trapped there. Stones must always leave it a way out.', kind: 'warn' });
      return false;
    }
    b.kind[from] = kt;
    b.kind[to] = kf;
    if (kf === STONE) b.grains[to] = 0;
    if (kt === STONE) b.grains[from] = 0;
    b.rebuild();
    this.layoutChanged();
    return true;
  }

  moveFunnel(t, to) {
    const b = this.boards[t];
    if (!b || t === 0 || b.kind[to] === STONE || to < 0 || to >= b.n) return false;
    b.funnel = to;
    this.layoutChanged();
    this._layout = null;
    return true;
  }

  setFold(on) {
    if (!this.has('fold')) return false;
    const prevFold = this.s.fold;
    this.s.fold = on;
    const r = this.rules();
    for (const b of this.boards) {
      const saved = b.fold;
      b.fold = r.fold;
      if (!b.allCellsDrain()) {
        b.fold = saved;
        this.s.fold = prevFold;
        for (const bb of this.boards) { bb.fold = this.rules().fold; bb.rebuild(); }
        this.emit('toast', { text: 'Folding would trap sand behind your stones.', kind: 'warn' });
        return false;
      }
    }
    for (const b of this.boards) this.applyRules(b);
    this.layoutChanged();
    return true;
  }

  // ------------------------------------------------------------ upgrades
  upgradeAvailable(u) {
    if (this.s.up[u.id]) return false;
    if (u.req && !u.req.every(r => this.s.up[r])) return false;
    if (u.kreq && (!this.s.kiln[u.kreq] || !this.kilnActive())) return false;
    if (u.fx.size && this.s.trial === 't_narrow' && u.fx.size > 9) return false;
    return true;
  }

  buyUpgrade(id) {
    const u = D.UPGRADE_MAP[id];
    if (!u || !this.upgradeAvailable(u) || this.s.dust < u.cost) return false;
    this.s.dust -= u.cost;
    this.grantUpgrade(id);
    this.emit('bought', { what: id });
    return true;
  }

  grantUpgrade(id) {
    const u = D.UPGRADE_MAP[id];
    this.s.up[id] = 1;
    this.recomputeFx();
    if (u.fx.size) this.resizeTables(this.maxSize());
    this.layoutChanged();
  }

  applyMemory() {
    const ids = [];
    if (this.fx.memory >= 1) ids.push('u_hands', 'u_fine', 'u_t7');
    if (this.fx.memory >= 2) ids.push('u_sift', 'u_crystal', 'u_finer', 'u_t9', 'u_quake', 'u_facet', 'u_glimmer', 'u_t11');
    for (const id of ids) this.s.up[id] = 1;
    this.recomputeFx();
  }

  kilnAvailable(k) {
    if (this.s.kiln[k.id]) return false;
    if (k.req && !k.req.every(r => this.s.kiln[r])) return false;
    return true;
  }

  buyKiln(id) {
    const k = D.KILN_MAP[id];
    if (!k || !this.kilnAvailable(k) || this.s.glass < k.cost) return false;
    this.s.glass -= k.cost;
    this.s.kiln[id] = 1;
    this.recomputeFx();
    if (k.fx.tables && this.kilnActive()) {
      while (this.boards.length < this.maxTables()) this.addTable();
    }
    if (k.fx.memory) this.applyMemory();
    if (this.s.up && Object.keys(this.s.up).length) this.resizeTables(this.maxSize());
    this.layoutChanged();
    this.emit('bought', { what: id });
    return true;
  }

  polishCost() { return D.POLISH.base * Math.pow(D.POLISH.growth, this.s.polish); }

  buyPolish() {
    if (this.s.glass < this.polishCost()) return false;
    this.s.glass -= this.polishCost();
    this.s.polish++;
    return true;
  }

  // ------------------------------------------------------------ great hourglass
  greatNext() { return D.GREAT[this.s.great] || null; }

  canBuildGreat() {
    const g = this.greatNext();
    if (!g || !this.has('great')) return false;
    if (g.trials && Object.keys(this.s.trials).length < D.TRIALS.length) return false;
    return this.s.glass >= g.glass && this.s.sand >= g.sand;
  }

  buildGreat() {
    if (!this.canBuildGreat()) return false;
    const g = this.greatNext();
    this.s.glass -= g.glass;
    this.s.sand -= g.sand;
    this.s.great++;
    this.recomputeFx();
    this.layoutChanged();
    this.emit('great', { stage: this.s.great });
    return true;
  }

  // ------------------------------------------------------------ actions
  click(t, i, times = 1) {
    if (!this.canClick()) return false;
    const b = this.boards[t];
    if (!b || b.kind[i] === STONE) return false;
    const g = this.handGrains() * times;
    if (!this.analyticOnly) b.add(i, g);
    this.s.stats.clicks += times;
    this.s.stats.handGrains += g;
    this.s.flags.clickedThisRun = true;
    // income: the exact expected value of these grains
    const at = this.analyze().tables[t];
    const ev = g * (at.v[i] + (at.X ? at.X[i] : 1) * at.down) * this.dustMult();
    this.gainDust(ev);
    this.s.stats.topples += g * at.linger[i];
    this.lastClickValue = ev;
    return ev;
  }

  quake(power = 1) {
    if (!this.canQuake()) return false;
    const free = power === 1;
    if (free && this.s.quakeCd > 0) return false;
    const a = this.analyze();
    const total = Math.max(1, this.quakeSeconds() * a.grainRate) * power;
    let cells = 0;
    for (const b of this.boards) for (let i = 0; i < b.n; i++) if (b.kind[i] !== STONE) cells++;
    const per = total / cells;
    // income: the expected value of `per` grains on every cell
    let val = 0, topples = 0;
    for (let t = 0; t < this.boards.length; t++) {
      const b = this.boards[t], at = a.tables[t];
      for (let i = 0; i < b.n; i++) {
        if (b.kind[i] === STONE) continue;
        val += per * (at.v[i] + (at.X ? at.X[i] : 1) * at.down);
        topples += per * at.linger[i];
        if (!this.analyticOnly) b.grains[i] += Math.min(3 + power, Math.max(1, Math.round(per)));
      }
    }
    const ev = val * this.dustMult();
    this.gainDust(ev);
    this.s.stats.topples += topples;
    if (free) this.s.quakeCd = this.quakeCooldown();
    if (this.s.up.u_aftershock) this.s.aftershock = 10;
    this.s.stats.quakes++;
    this.emit('quake', { power, value: ev });
    return true;
  }

  catchGleam() {
    const gl = this.s.gleam;
    if (!gl) return null;
    this.s.gleam = null;
    this.s.stats.gleams++;
    const r = this.rng();
    const pow = this.fx.gleamPow;
    let text;
    if (r < 0.4) {
      const amt = Math.max(25, 60 * pow * this.baseRate());
      this.gainDust(amt);
      text = `Windfall! +${amt} dust`;
      this.emit('gleam', { kind: 'windfall', amount: amt });
    } else if (r < 0.65) {
      this.s.buffs.shimmer = 30 * pow;
      this.emit('gleam', { kind: 'shimmer', duration: 30 * pow });
      text = 'Shimmer';
    } else if (r < 0.85) {
      this.s.buffs.sandstorm = 15 * pow;
      this.emit('gleam', { kind: 'sandstorm', duration: 15 * pow });
      text = 'Sandstorm';
    } else {
      if (this.canQuake()) this.quake(2);
      else this.gainDust(Math.max(25, 60 * pow * this.baseRate()));
      this.emit('gleam', { kind: 'tremor' });
      text = 'Tremor';
    }
    return text;
  }

  gainDust(x) {
    if (!(x > 0)) return;
    this.s.dust += x;
    this.s.dustRun += x;
    this.s.dustAll += x;
  }

  // ------------------------------------------------------------ sweep (prestige)
  kilnVisible() { return this.s.sweeps > 0 || this.s.dustRun >= FIRST_SWEEP / 10; }

  glassGain() {
    if (this.s.dustRun < FIRST_SWEEP) return 0;
    return Math.floor(3 * Math.pow(this.s.dustRun / FIRST_SWEEP, GLASS_EXP) * this.fx.glass);
  }

  // Dust needed this run for a given glass gain.
  dustForGlass(g) {
    return FIRST_SWEEP * Math.pow(g / (3 * this.fx.glass), 1 / GLASS_EXP);
  }

  startingHourglasses() {
    if (this.s.trial === 't_still') return 5;
    return this.s.sweeps > 0 ? 1 : 0;
  }

  canSweep() { return this.glassGain() >= 1 || (this.s.trial !== null); }

  sweep(doctrine = this.s.doctrine, trial = null) {
    const gain = this.glassGain();
    const runTime = this.s.stats.runTime;
    this.s.glass += gain;
    this.s.glassAll += gain;
    if (gain > 0 || this.s.trial) this.s.sweeps++;
    if (gain > 0 && this.s.stats.played - this.s.stats.lastSweepAt < 180 && this.s.sweeps > 1) this.s.flags.quickSweep = true;
    this.s.stats.lastSweepAt = this.s.stats.played;
    this.s.stats.bestGain = Math.max(this.s.stats.bestGain, gain);
    // blueprint
    const bp = [];
    for (let t = 0; t < this.boards.length; t++) {
      const b = this.boards[t], c = b.size >> 1;
      for (let i = 0; i < b.n; i++) {
        const k = b.kind[i];
        const x = i % b.size, y = (i / b.size) | 0;
        const d = Math.abs(x - c) + Math.abs(y - c);
        if (b.hg[i] > 0) bp.push({ t, type: 'hourglass', dx: x - c, dy: y - c, n: b.hg[i], d: -1e6 + d });
        if (k === EMPTY) continue;
        bp.push({ t, type: D.KIND_TO_BUILDING[k], dx: x - c, dy: y - c, d });
      }
    }
    bp.sort((p, q) => p.d - q.d);
    if (bp.length) this.s.blueprint = bp.map(({ t, type, dx, dy, n }) => (n ? { t, type, dx, dy, n } : { t, type, dx, dy }));
    // reset run state
    const s = this.s;
    s.dust = 0;
    s.dustRun = 0;
    s.owned = { hourglass: 0, crystal: 0, stone: 0, prism: 0 };
    s.inv = { hourglass: 0, crystal: 0, stone: 0, prism: 0 };
    s.up = {};
    s.buffs = {};
    s.quakeCd = 0;
    s.aftershock = 0;
    s.gleam = null;
    s.gleamTimer = 30;
    s.stats.runTime = 0;
    s.flags.clickedThisRun = false;
    s.trial = trial;
    if (doctrine && this.doctrineAvailable(doctrine)) s.doctrine = doctrine;
    this.recomputeFx();
    this.applyMemory();
    const size = this.startSize();
    this.boards = [];
    for (let t = 0; t < this.maxTables(); t++) this.boards.push(this.makeTable(t, size));
    this.layoutChanged();
    const free = this.startingHourglasses();
    for (let k = 0; k < free; k++) {
      s.owned.hourglass++;
      s.inv.hourglass++;
      this.autoPlace('hourglass', true);
    }
    this.emit('sweep', { gain, runTime });
    return gain;
  }

  doctrineAvailable(d) {
    const def = D.DOCTRINES[d];
    if (!def || !this.has('doctrine')) return false;
    if (def.req && !this.has(def.req)) return false;
    return true;
  }

  setDoctrine(d) {
    // free choice only while none is chosen; otherwise at sweep time
    if (this.s.doctrine && this.s.doctrine !== d) return false;
    if (!this.doctrineAvailable(d)) return false;
    this.s.doctrine = d;
    this.recomputeFx();
    this.layoutChanged();
    return true;
  }

  startTrial(id) {
    if (!this.has('trials') || !D.TRIAL_MAP[id]) return false;
    this.sweep(this.s.doctrine, id);
    this.emit('toast', { text: `Trial begun: ${D.TRIAL_MAP[id].name}`, kind: 'info' });
    return true;
  }

  // ------------------------------------------------------------ time
  // Per-cell visual pour rates for a table. The on-screen sandpile is a faithful
  // picture of the flow, but softly capped so the table stays near the critical
  // state (and keeps its fractal look) even when the real flow is enormous.
  visualRates(b) {
    const r = this.hourglassRate();
    const key = `${this.flowVersion}:${r}:${b.n}`;
    if (b._visKey === key) return b._vis;
    const list = [];
    let total = 0;
    for (const i of b.hourglasses) {
      const a = r * b.hg[i];
      const v = a <= 3 ? a : 3 * (1 + Math.log(a / 3));
      list.push([i, v]);
      total += v;
    }
    const cap = 0.07 * b.n + 3;
    const k = total > cap ? cap / total : 1;
    for (const e of list) e[1] *= k;
    b._vis = list;
    b._visKey = key;
    return list;
  }

  // Simulate one synchronous (visual) round across all tables.
  doRound(sample = false) {
    const scatter = this.s.trial === 't_scatter';
    let inflow = 0, topples = 0, wave = 0;
    for (let t = 0; t < this.boards.length; t++) {
      const b = this.boards[t];
      if (t > 0 && b.funnel >= 0 && inflow > 0) b.grains[b.funnel] += inflow;
      for (const [i, rate] of this.visualRates(b)) {
        b.acc[i] += rate / D.ROUNDS_PER_SEC;
        if (b.acc[i] >= 1) {
          const k = Math.floor(b.acc[i]);
          b.acc[i] -= k;
          if (scatter) {
            for (let j = 0; j < k; j++) {
              let c = rngInt(this.rng, b.n), tries = 0;
              while (b.kind[c] === STONE && tries++ < 20) c = rngInt(this.rng, b.n);
              b.grains[c] += 1;
            }
          } else b.grains[i] += k;
        }
      }
      const r = b.round(sample);
      topples += r.topples;
      wave += r.wave;
      inflow = r.spilled;
    }
    if (wave > this.s.stats.maxWave) this.s.stats.maxWave = wave;
    this.lastRoundStats = { topples, wave };
  }

  // Income for `dt` seconds from the steady-state model.
  // `live` includes temporary buffs (offline progress does not).
  analyticAdvance(dt, live = false) {
    const a = this.analyze();
    const storm = live && this.s.buffs.sandstorm > 0 ? 10 : 1;
    const rate = live ? a.raw * this.dustMult() * storm : a.raw * this.dustMultBase();
    this.gainDust(rate * dt);
    this.s.stats.topples += a.topples * storm * dt;
    if (this.fx.collectSand) {
      const sr = a.spill * this.sandMult() * storm;
      this.s.sand += sr * dt;
      this.s.sandAll += sr * dt;
    }
  }

  // Main time step. `dt` in seconds.
  tick(dt, opts = {}) {
    if (!(dt > 0)) return;
    const s = this.s;
    s.stats.played += dt;
    s.stats.runTime += dt;
    // timers
    if (s.quakeCd > 0) s.quakeCd = Math.max(0, s.quakeCd - dt);
    if (s.aftershock > 0) s.aftershock = Math.max(0, s.aftershock - dt);
    for (const k in s.buffs) { s.buffs[k] -= dt; if (s.buffs[k] <= 0) delete s.buffs[k]; }
    // gleams
    if (this.gleamsOn()) {
      if (s.gleam) {
        s.gleam.ttl -= dt;
        if (s.gleam.ttl <= 0) s.gleam = null;
      } else {
        s.gleamTimer -= dt;
        if (s.gleamTimer <= 0) {
          s.gleamTimer = this.gleamInterval();
          const t = Math.min(s.activeTable, this.boards.length - 1);
          const b = this.boards[t];
          let c = rngInt(this.rng, b.n), tries = 0;
          while (b.kind[c] === STONE && tries++ < 50) c = rngInt(this.rng, b.n);
          s.gleam = { t, cell: c, ttl: this.gleamTTL(), max: this.gleamTTL() };
          this.emit('gleamSpawn');
        }
      }
    } else if (s.gleam) s.gleam = null;

    // income (buffs count while the game is open, not while offline)
    this.analyticAdvance(dt, !opts.offline);
    // the visible sandpile
    if (!this.analyticOnly && !opts.analytic) {
      this.roundAcc += dt * D.ROUNDS_PER_SEC;
      let n = Math.floor(this.roundAcc);
      this.roundAcc -= n;
      n = Math.min(n, opts.maxRounds || 45);
      for (let r = 0; r < n; r++) this.doRound(r === n - 1);
    }

    // automation
    this.autoAcc += dt;
    if (this.autoAcc >= 0.25) {
      this.autoAcc = 0;
      this.runAutomation();
    }
    // slow checks
    this.slowAcc += dt;
    if (this.slowAcc >= 1) {
      this.slowAcc = 0;
      this.slowChecks();
    }
  }

  runAutomation() {
    const s = this.s;
    if (this.hasAuto('quake') && s.auto.quake && this.canQuake() && s.quakeCd <= 0 && this.has('quake')) this.quake();
    if (this.hasAuto('upgrades') && s.auto.upgrades) {
      for (const u of D.UPGRADES) {
        if (this.upgradeAvailable(u) && s.dust >= u.cost) this.buyUpgrade(u.id);
      }
    }
    if (this.hasAuto('hourglass') && s.auto.hourglass) {
      let guard = 0;
      while (this.canBuy('hourglass') && guard++ < 50) this.buyBuilding('hourglass');
    }
    if (this.hasAuto('crystal') && s.auto.crystal) {
      let guard = 0;
      while (guard++ < 50) {
        const cc = this.buildingUnlocked('crystal') ? this.costOf('crystal') : Infinity;
        const pc = this.buildingUnlocked('prism') ? this.costOf('prism') : Infinity;
        if (cc <= pc && this.canBuy('crystal')) this.buyBuilding('crystal');
        else if (pc < cc && this.canBuy('prism')) this.buyBuilding('prism');
        else break;
      }
    }
  }

  slowChecks() {
    const s = this.s;
    // trial completion
    if (s.trial && !s.trials[s.trial] && s.dustRun >= D.TRIAL_MAP[s.trial].goal) {
      s.trials[s.trial] = true;
      this.recomputeFx();
      this.layoutChanged();
      this.emit('trialDone', { id: s.trial });
    }
    // special flags
    const b0 = this.boards[Math.min(s.activeTable, this.boards.length - 1)];
    if (!s.flags.overflow) {
      for (let i = 0; i < b0.n; i++) if (b0.grains[i] >= 1000) { s.flags.overflow = true; break; }
    }
    if (!s.flags.mandala && b0.size >= 9 && !this.analyticOnly) {
      if (isMandala(b0)) s.flags.mandala = true;
    }
    if (this.has('fold') && s.fold) s.flags.folded = true;
    // achievements
    let newAch = false;
    for (const a of D.ACHIEVEMENTS) {
      if (s.ach[a.id]) continue;
      let ok = false;
      try { ok = a.check(this); } catch (e) { ok = false; }
      if (ok) {
        s.ach[a.id] = true;
        newAch = true;
        this.emit('ach', { id: a.id });
      }
    }
    if (newAch) this.layoutChanged();
    // journal
    for (const j of D.JOURNAL) {
      if (s.journal.includes(j.id)) continue;
      let ok = false;
      try { ok = j.when(this); } catch (e) { ok = false; }
      if (ok) {
        s.journal.push(j.id);
        this.emit('journal', { id: j.id });
      }
    }
  }

  // ------------------------------------------------------------ save/load
  serialize() {
    this.s.tables = this.boards.map(b => b.serialize());
    this.s.lastSave = Date.now();
    return JSON.stringify(this.s);
  }

  load(json) {
    const o = typeof json === 'string' ? JSON.parse(json) : json;
    const base = newState();
    const s = Object.assign(base, o);
    s.owned = Object.assign(newState().owned, o.owned || {});
    s.inv = Object.assign(newState().inv, o.inv || {});
    s.stats = Object.assign(newState().stats, o.stats || {});
    s.settings = Object.assign(newState().settings, o.settings || {});
    s.auto = Object.assign(newState().auto, o.auto || {});
    s.flags = Object.assign({}, o.flags || {});
    s.buffs = Object.assign({}, o.buffs || {});
    s.journal = Array.isArray(o.journal) ? o.journal : [];
    s.blueprint = Array.isArray(o.blueprint) ? o.blueprint : [];
    this.s = s;
    this.recomputeFx();
    if (Array.isArray(o.tables) && o.tables.length) {
      this.boards = o.tables.map(t => Board.deserialize(t));
      for (const b of this.boards) this.applyRules(b);
    } else {
      this.boards = [this.makeTable(0, this.startSize())];
    }
    while (this.boards.length < this.maxTables()) this.addTable();
    if (this.boards[0].size < this.maxSize()) this.resizeTables(this.maxSize());
    this.layoutChanged();
    this._layout = null;
    this.analysis = null;
    return this;
  }

  // Grant offline progress for `sec` seconds. Returns gains.
  offline(sec) {
    if (!(sec > 0)) return null;
    const before = { dust: this.s.dust, sand: this.s.sand };
    this.s.stats.played += sec;
    this.s.stats.runTime += sec;
    this.s.quakeCd = Math.max(0, this.s.quakeCd - sec);
    this.s.buffs = {};
    this.s.aftershock = 0;
    this.s.gleam = null;
    this.analyticAdvance(sec, false);
    this.runAutomation();
    return { dust: this.s.dust - before.dust, sand: this.s.sand - before.sand, sec };
  }
}

export function isMandala(b) {
  const s = b.size, g = b.grains;
  let total = 0;
  for (let i = 0; i < b.n; i++) total += g[i];
  if (total < 100) return false;
  const f = (x, y) => Math.floor(g[y * s + x]);
  for (let y = 0; y < s; y++) {
    for (let x = 0; x < s; x++) {
      const v = f(x, y);
      if (v !== f(s - 1 - x, y) || v !== f(x, s - 1 - y) || v !== f(y, x)) return false;
    }
  }
  // buildings must be symmetric too
  for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) {
    const k = b.kind[y * s + x];
    if (k !== b.kind[y * s + (s - 1 - x)] || k !== b.kind[(s - 1 - y) * s + x] || k !== b.kind[x * s + y]) return false;
  }
  return true;
}
