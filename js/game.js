// Core game logic. No DOM access here, so it can be driven headlessly.
import {
  Board, EMPTY, CRYSTAL, STONE, PRISM, DX, DY,
  T_NONE, T_GEODE, T_BEDROCK, T_SPRING, T_CRACK, T_DIG, T_SLOPE, TERRAIN_NAMES,
} from './sim.js';
import * as D from './data.js';
import { generateTable, candidateArchetypes, mulberry32, trappedCell, MAP, C } from './terrain.js';

export const SAVE_VERSION = 2;
const FIRST_SWEEP = 1e9;
const GLASS_EXP = 0.35;
const SPRING_SHARE = 0.2;
const DIG_SPEED = 12;   // dig progress per second if every grain topples once on the site
const CLICK_DIG = 1;    // dig progress per grain dropped on a site by hand

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
    relics: {},
    fragments: 0,
    doctrine: null,
    trial: null,
    trials: {},
    ach: {},
    journal: [],
    tablesPlayed: 1,
    seedBase: Math.floor(Math.random() * 1e9),
    tableDefs: [],
    candidates: null,
    digs: [],
    edits: [],
    broken: {},
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
    settings: { sound: true, volume: 0.5, autoPlace: true, particles: true, reduceMotion: false },
    stats: {
      topples: 0, clicks: 0, handGrains: 0, quakes: 0, gleams: 0, maxWave: 0,
      played: 0, runTime: 0, lastSweepAt: -1e9, bestGain: 0, digs: 0,
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
    if (opts.seed !== undefined) this.s.seedBase = opts.seed;
    this.boards = [];
    this.maps = [];
    this.roundAcc = 0;
    this.layoutVersion = 0;
    this.flowVersion = 0;
    this.analysis = null;
    this.bestLinger = 0;
    this.autoAcc = 0;
    this.slowAcc = 0;
    this.lastRoundStats = null;
    this.fx = null;
    this.recomputeFx();
    this.applyMemory();
    this.s.tableDefs = [{ seed: this.s.seedBase, tier: 1, arch: 'first', first: true }];
    this.buildTables(this.startSize());
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
      dig: 1, geode: 1, spring: 1, choices: 2, startHg: 0, pick: 0, vane: 0, compass: 0, perRelic: 1,
      unlocks: new Set(), auto: new Set(),
    };
    const apply = (f) => {
      for (const k in f) {
        const v = f[k];
        switch (k) {
          case 'rate': case 'dust': case 'crystalMul': case 'glass': case 'quake': case 'quakeCd':
          case 'gleamFreq': case 'gleamPow': case 'foldBonus': case 'stoneGlow':
          case 'dig': case 'geode': case 'spring': case 'perRelic':
            fx[k] *= v; break;
          case 'crystal': case 'prism': case 'stones': case 'tables': case 'pick': case 'vane':
            fx[k] += v; break;
          case 'hand': case 'size': case 'memory': case 'reveal': case 'choices': case 'startHg': case 'compass':
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
    for (const id in this.s.relics) if (D.RELIC_MAP[id]) apply(D.RELIC_MAP[id].fx);
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

  has(flag) { return this.fx.unlocks.has(flag) || !!this.s.seen[flag]; }
  hasAuto(flag) { return this.fx.auto.has(flag); }

  achCount() { return Object.keys(this.s.ach).length; }
  relicCount() { return Object.keys(this.s.relics).length; }

  patienceMult() {
    return Math.min(8, 1 + 7 * this.s.stats.runTime / 2400);
  }

  polishMult() { return this.kilnActive() ? Math.pow(D.POLISH.mult, this.s.polish) : 1; }

  // Dust multiplier excluding temporary buffs.
  dustMultBase() {
    let m = this.fx.dust * this.polishMult() * (1 + D.ACH_BONUS * this.achCount());
    m *= Math.pow(this.fx.perRelic, this.relicCount());
    m *= 1 + 0.02 * this.s.fragments;
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

  totalHourglasses() {
    let n = 0;
    for (const b of this.boards) for (const i of b.hourglasses) n += b.hg[i];
    return n;
  }

  // Each spring pours a share of everything your hourglasses pour (at least a trickle).
  springRate(rate = this.baseHourglassRate()) {
    return Math.max(0.5, SPRING_SHARE * this.fx.spring * rate * this.totalHourglasses());
  }

  handGrains() { return this.fx.hand; }

  crystalBonus() {
    let c = (3 + this.fx.crystal) * this.fx.crystalMul;
    if (this.s.doctrine === 'facet') c *= 3;
    return c;
  }

  prismFactor() { return 2 + this.fx.prism; }

  digMult() { return this.fx.dig * (this.s.doctrine === 'delve' ? 3 : 1); }

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
  tableChoices() { return Math.max(2, this.fx.choices); }

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

  // ------------------------------------------------------------ tables & terrain
  rules() {
    return {
      fold: this.s.fold && this.has('fold'),
      weights: this.s.trial === 't_wind' ? [1, 2, 1, 0] : [1, 1, 1, 1],
      keep: this.s.trial === 't_crumble' ? 0.75 : 1,
    };
  }

  applyRules(b, t = this.boards.indexOf(b)) {
    const r = this.rules();
    b.fold = r.fold;
    b.weights = r.weights;
    b.keep = r.keep;
    b.rebuild();
    if (b.keep >= 1 && t >= 0) this.ensureDrain(t, b);
  }

  // Strange rules (an east wind, a fold) can leave a pocket of the terrain
  // with no way out. Wear away the nearest bedrock or slope until sand drains.
  ensureDrain(t, b) {
    for (let guard = 0; guard < 200 && !b.allCellsDrain(); guard++) {
      const trapped = trappedCell(b);
      const tx = trapped % b.size, ty = (trapped / b.size) | 0;
      let best = -1, bd = Infinity;
      for (let i = 0; i < b.n; i++) {
        if (b.terr[i] !== T_BEDROCK && b.terr[i] !== T_SLOPE) continue;
        const d = Math.abs(i % b.size - tx) + Math.abs(((i / b.size) | 0) - ty);
        if (d < bd) { bd = d; best = i; }
      }
      if (best < 0) break;
      if (b.terr[best] === T_BEDROCK) { b.kind[best] = EMPTY; b.grains[best] = 0; }
      b.terr[best] = T_NONE;
      const [mx, my] = this.mapOfCell(b, best);
      this.s.edits.push({ t, mx, my, terr: T_NONE });
      b.rebuild();
    }
  }

  mapFor(t) {
    const def = this.s.tableDefs[t];
    if (!def) return null;
    const m = this.maps[t];
    if (m && m.seed === def.seed && m.tier === def.tier && m.arch === (def.arch || m.arch)) return m;
    this.maps[t] = generateTable(def);
    return this.maps[t];
  }

  // The table definition for a table below the first, derived from the first's seed.
  defBelow(def, t) {
    return { seed: (def.seed * 31 + 7919 * t) >>> 0, tier: def.tier, arch: null };
  }

  // Board index of map cell (mx, my) for a board of this size, or -1 if not uncovered.
  cellOfMap(b, mx, my) {
    const off = C - (b.size >> 1);
    const x = mx - off, y = my - off;
    if (x < 0 || y < 0 || x >= b.size || y >= b.size) return -1;
    return y * b.size + x;
  }

  mapOfCell(b, i) {
    const off = C - (b.size >> 1);
    return [i % b.size + off, ((i / b.size) | 0) + off];
  }

  // Copy terrain (with this run's edits and finished digs) onto a board.
  applyTerrain(t, b) {
    const map = this.mapFor(t);
    if (!map) return;
    const off = C - (b.size >> 1);
    for (let y = 0; y < b.size; y++) for (let x = 0; x < b.size; x++) {
      const m = (y + off) * MAP + (x + off), i = y * b.size + x;
      b.terr[i] = map.terr[m];
      b.rich[i] = map.rich[m];
      b.sdir[i] = map.sdir[m];
    }
    for (const e of this.s.edits) {
      if (e.t !== t) continue;
      const i = this.cellOfMap(b, e.mx, e.my);
      if (i < 0) continue;
      b.terr[i] = e.terr;
      if (e.sdir !== undefined) b.sdir[i] = e.sdir;
    }
    for (const d of this.s.digs) {
      if (d.t !== t || !d.done) continue;
      const i = this.cellOfMap(b, d.mx, d.my);
      if (i >= 0 && b.terr[i] === T_DIG) b.terr[i] = T_NONE;
    }
    for (let i = 0; i < b.n; i++) {
      if (b.terr[i] === T_BEDROCK) { b.kind[i] = STONE; b.hg[i] = 0; b.grains[i] = 0; }
      else if (b.terr[i] === T_CRACK) { if (b.kind[i] !== STONE) { b.kind[i] = EMPTY; b.hg[i] = 0; } b.grains[i] = 0; }
    }
  }

  makeBoard(t, size) {
    const b = new Board(size);
    for (let i = 0; i < b.n; i++) {
      b.grains[i] = this.rng() < 0.6 ? 3 : 2;
      b.acc[i] = this.rng();
    }
    this.applyTerrain(t, b);
    if (t > 0) b.funnel = b.idx(size >> 1, size >> 1);
    this.applyRules(b, t);
    return b;
  }

  // Assign relics to dig sites that have none yet, nearest first.
  // Each relic needs a site at least `ring` from the centre.
  assignRelics() {
    const taken = new Set(this.s.digs.filter(d => !d.done && d.relic && d.relic !== 'cache').map(d => d.relic));
    const pool = D.RELICS.filter(r => !this.s.relics[r.id] && !taken.has(r.id));
    const open = this.s.digs.filter(d => !d.relic).sort((a, b) => (a.ring - b.ring) || (a.t - b.t));
    for (const d of open) {
      const k = pool.findIndex(r => r.ring <= d.ring);
      d.relic = k >= 0 ? pool.splice(k, 1)[0].id : 'cache';
    }
  }

  // Create dig records for table t from its map.
  addDigs(t) {
    const map = this.mapFor(t);
    if (!map) return;
    const found = this.relicCount();
    for (const p of map.digs) {
      const ring = Math.max(Math.abs(p.mx - C), Math.abs(p.my - C));
      this.s.digs.push({ t, mx: p.mx, my: p.my, ring, need: D.digNeed(ring, found), prog: 0, relic: null, done: false });
    }
    this.assignRelics();
  }

  // Build all tables for a fresh run from s.tableDefs.
  buildTables(size) {
    const s = this.s;
    s.digs = [];
    s.edits = [];
    s.broken = {};
    const count = this.maxTables();
    while (s.tableDefs.length < count) s.tableDefs.push(this.defBelow(s.tableDefs[0], s.tableDefs.length));
    s.tableDefs.length = count;
    this.maps = [];
    this.boards = [];
    for (let t = 0; t < count; t++) {
      this.addDigs(t);
      this.boards.push(this.makeBoard(t, size));
    }
    s.activeTable = 0;
    this.layoutChanged();
    this.noticeTerrain();
  }

  addTable() {
    const t = this.boards.length;
    this.s.tableDefs[t] = this.defBelow(this.s.tableDefs[0], t);
    this.addDigs(t);
    this.boards.push(this.makeBoard(t, this.boards[0].size));
    this.layoutChanged();
    this.noticeTerrain();
  }

  resizeTables(size) {
    const found = {};
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
      this.applyTerrain(t, nb);
      // what did the new ring(s) reveal?
      for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
        if (x >= off && y >= off && x < off + old.size && y < off + old.size) continue;
        const tt = nb.terr[nb.idx(x, y)];
        if (tt !== T_NONE) found[tt] = (found[tt] || 0) + 1;
      }
      this.applyRules(nb, t);
      this.boards[t] = nb;
    }
    this.layoutChanged();
    this.emit('resize', { size, found });
    this.noticeTerrain();
  }

  // Record which kinds of terrain have been seen (for tips, journal and upgrades).
  noticeTerrain() {
    for (const b of this.boards) {
      for (let i = 0; i < b.n; i++) {
        const name = ['', 'geode', 'bedrock', 'spring', 'crack', 'dig', 'slope'][b.terr[i]];
        if (!name || this.s.seen['seen_' + name]) continue;
        this.s.seen['seen_' + name] = true;
        this.s.seen['t_' + name] = true;
        this.emit('terrain', { what: name });
      }
    }
  }

  // Kinds / values / rules changed: every steady-state map must be re-solved.
  layoutChanged() {
    this.layoutVersion++;
    this.flowVersion++;
  }

  // Only hourglass counts or positions changed: no re-solve needed.
  flowChanged() {
    this.flowVersion++;
  }

  geodeMult() { return this.fx.geode; }

  crystalValueAt(b, i, prisms = null) {
    const s = b.size, x = i % s, y = (i / s) | 0;
    if (prisms === null) {
      prisms = 0;
      for (let d = 0; d < 4; d++) {
        let nx = x + DX[d];
        const ny = y + DY[d];
        if (b.fold && (d === 1 || d === 3)) nx = (nx + s) % s;
        if (nx < 0 || ny < 0 || nx >= s || ny >= s) continue;
        if (b.kind[ny * s + nx] === PRISM) prisms++;
      }
    }
    return this.crystalBonus() * b.rich[i] * this.geodeMult() * Math.pow(this.prismFactor(), prisms);
  }

  refreshVals() {
    const sg = this.fx.stoneGlow;
    for (const b of this.boards) {
      const s = b.size;
      for (let i = 0; i < b.n; i++) {
        if (b.isVoid(i)) { b.val[i] = 0; continue; }
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
        let v = 1;
        if (b.kind[i] === CRYSTAL) {
          v = this.crystalValueAt(b, i, prisms);
          if (prisms >= 3) this.s.flags.prism3 = true;
        }
        if (sg > 1 && stones > 0) v *= Math.pow(sg, stones);
        b.val[i] = v;
      }
    }
  }

  // ------------------------------------------------------------ analysis
  // Per-grain maps that depend only on the layout (not on where sand is poured):
  //   v      expected dust value (pre global multiplier) of one grain dropped at a cell
  //   linger expected topples caused by one grain dropped at a cell
  //   X      expected fraction of a grain that eventually leaves the table (1 unless sand crumbles)
  // By duality, total production = sum over sources of rate × v, so buying
  // hourglasses never needs a re-solve.
  layoutSolve() {
    const key = `${this.layoutVersion}:${this.crystalBonus()}:${this.prismFactor()}:${this.fx.stoneGlow}:${this.geodeMult()}:${this.boards.length}`;
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
      for (let i = 0; i < b.n; i++) ones[i] = b.isVoid(i) ? 0 : 1;
      const l = b.solveValue(ones, pt && pt.linger);
      for (let i = 0; i < b.n; i++) if (l[i] > linger) linger = l[i];
      let X = null;
      if (b.keep < 1) {
        const ex = new Float64Array(b.n);
        for (let i = 0; i < b.n; i++) {
          for (let d = 0; d < 4; d++) if (b.tgt[i * 4 + d] === -1) ex[i] += b.wc[i * 4 + d] * b.keep;
        }
        X = b.solveValue(ex);
      }
      tables.push({ n: b.n, v, linger: l, X, down: 0 });
    }
    for (let t = tables.length - 2; t >= 0; t--) {
      const f = this.boards[t + 1].funnel, nt = tables[t + 1];
      tables[t].down = f >= 0 ? nt.v[f] + (nt.X ? nt.X[f] : 1) * nt.down : 0;
    }
    this.bestLinger = Math.max(this.bestLinger, linger);
    this._layout = { key, tables, linger };
    return this._layout;
  }

  // Drop rates (grains/s) per cell of table t from hourglasses and springs.
  sourceDrops(b, r, spring) {
    const drop = new Float64Array(b.n);
    let total = 0;
    if (this.s.trial === 't_scatter') {
      let hg = 0, free = 0;
      for (const i of b.hourglasses) hg += b.hg[i];
      for (let i = 0; i < b.n; i++) if (!b.isVoid(i)) free++;
      for (let i = 0; i < b.n; i++) if (!b.isVoid(i)) drop[i] += hg * r / free;
      total += hg * r;
    } else {
      for (const i of b.hourglasses) { drop[i] += r * b.hg[i]; total += r * b.hg[i]; }
    }
    for (let i = 0; i < b.n; i++) if (b.terr[i] === T_SPRING && !b.isVoid(i)) { drop[i] += spring; total += spring; }
    return { drop, total };
  }

  analyze() {
    const L = this.layoutSolve();
    const r = this.baseHourglassRate();
    const spring = this.springRate(r);
    const key = `${this.flowVersion}:${r}:${spring}:${L.key}:${this.s.trial}`;
    if (this.analysis && this.analysis.key === key) return this.analysis;
    let inflow = 0, raw = 0, grainRate = 0, topplesAll = 0;
    const tables = [];
    for (let t = 0; t < this.boards.length; t++) {
      const b = this.boards[t], Lt = L.tables[t];
      const { drop, total } = this.sourceDrops(b, r, spring);
      grainRate += total;
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

  // Value of one grain dropped on cell i of table t (pre global multiplier).
  grainValue(t, i) {
    const at = this.analyze().tables[t];
    return at.v[i] + (at.X ? at.X[i] : 1) * at.down;
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

  // ------------------------------------------------------------ visible sand & digging
  // Per-cell visual pour rates for a table. The on-screen sandpile is a faithful
  // picture of the flow, but softly capped so the table stays near the critical
  // state (and keeps its fractal look) even when the real flow is enormous.
  visualRates(b) {
    const r = this.hourglassRate();
    const spring = this.springRate(r);
    const key = `${this.flowVersion}:${r}:${spring}:${b.n}`;
    if (b._visKey === key) return b._vis;
    const list = [];
    let total = 0;
    const soft = (a) => (a <= 3 ? a : 3 * (1 + Math.log(a / 3)));
    for (const i of b.hourglasses) {
      const v = soft(r * b.hg[i]);
      list.push([i, v]);
      total += v;
    }
    for (let i = 0; i < b.n; i++) {
      if (b.terr[i] !== T_SPRING || b.isVoid(i)) continue;
      const v = soft(spring);
      list.push([i, v]);
      total += v;
    }
    const cap = 0.07 * b.n + 3;
    const k = total > cap ? cap / total : 1;
    for (const e of list) e[1] *= k;
    b._vis = list;
    b._visKey = key;
    b._visTotal = total * k;
    return list;
  }

  // Expected visible topple rate per cell (what you see on screen), used for digging.
  visualToppleMap(t) {
    const b = this.boards[t];
    const vis = this.visualRates(b);
    let inflow = 0;
    if (t > 0) { this.visualRates(this.boards[t - 1]); inflow = this.boards[t - 1]._visTotal || 0; }
    const key = `${this.layoutVersion}:${b._visKey}:${inflow.toFixed(4)}:${this.s.trial}`;
    if (b._uvKey === key) return b._uv;
    const drop = new Float64Array(b.n);
    if (this.s.trial === 't_scatter') {
      let tot = 0, free = 0;
      for (const [, v] of vis) tot += v;
      for (let i = 0; i < b.n; i++) if (!b.isVoid(i)) free++;
      for (let i = 0; i < b.n; i++) if (!b.isVoid(i)) drop[i] = tot / free;
    } else for (const [i, v] of vis) drop[i] += v;
    if (t > 0 && b.funnel >= 0) drop[b.funnel] += inflow;
    b._uv = b.solveTopples(drop, b._uv && b._uv.length === b.n ? b._uv : null, 1e-8);
    b._uvKey = key;
    return b._uv;
  }

  digCell(d) {
    const b = this.boards[d.t];
    return b ? this.cellOfMap(b, d.mx, d.my) : -1;
  }

  visibleDigs() {
    return this.s.digs.filter(d => !d.done && this.digCell(d) >= 0);
  }

  // Total sand poured onto the visible tables (hourglasses and springs).
  visualPourTotal() {
    let tot = 0;
    for (const b of this.boards) { this.visualRates(b); tot += b._visTotal || 0; }
    return tot;
  }

  // Digging speed depends on how much of your sand topples on the site, not on
  // how much sand you have: pour onto it, wall it in, or steer sand towards it.
  digRate(d) {
    const i = this.digCell(d);
    if (i < 0) return 0;
    const tot = this.visualPourTotal();
    if (tot <= 0) return 0;
    return DIG_SPEED * this.digMult() * this.visualToppleMap(d.t)[i] / tot;
  }

  digAt(t, i) {
    return this.s.digs.find(d => d.t === t && !d.done && this.digCell(d) === i) || null;
  }

  advanceDigs(dt) {
    for (const d of this.s.digs) {
      if (d.done || this.digCell(d) < 0) continue;
      d.prog += this.digRate(d) * dt;
      if (d.prog >= d.need) this.completeDig(d);
    }
  }

  completeDig(d) {
    d.done = true;
    d.prog = d.need;
    this.s.stats.digs++;
    const b = this.boards[d.t];
    const i = this.digCell(d);
    if (b && i >= 0 && b.terr[i] === T_DIG) { b.terr[i] = T_NONE; b.rebuild(); }
    this.layoutChanged();
    if (d.relic && d.relic !== 'cache' && !this.s.relics[d.relic]) {
      this.s.relics[d.relic] = true;
      let glass = 0;
      if (this.s.doctrine === 'delve') {
        glass = Math.max(1, Math.round(0.15 * Math.max(this.s.stats.bestGain, this.glassGain())));
        this.s.glass += glass;
        this.s.glassAll += glass;
      }
      this.recomputeFx();
      if (D.RELIC_MAP[d.relic].fx.tables) while (this.boards.length < this.maxTables()) this.addTable();
      this.layoutChanged();
      this.emit('relic', { id: d.relic, glass });
    } else {
      this.s.fragments++;
      const amt = Math.max(100, 180 * this.baseRate());
      this.gainDust(amt);
      this.emit('cache', { amount: amt });
    }
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
    if (type === 'crystal') return this.geodeSlots();
    return Infinity;
  }

  // Crystals can only grow on uncovered geodes.
  geodeSlots() {
    let n = 0;
    for (const b of this.boards) for (let i = 0; i < b.n; i++) if (b.terr[i] === T_GEODE) n++;
    return n;
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

  // Hourglasses join your biggest stack; crystals and prisms go to the best
  // free cell (if auto-placing is on). Stones always wait in your pocket.
  autoPlace(type, allowHeuristic = this.s.settings.autoPlace) {
    if (this.s.inv[type] <= 0) return false;
    if (type === 'hourglass') {
      let best = null;
      this.boards.forEach((b, t) => {
        for (const i of b.hourglasses) if (!best || b.hg[i] > best.n) best = { t, i, n: b.hg[i] };
      });
      if (best) return this.place('hourglass', best.t, best.i, true);
    }
    if (type === 'stone' || !allowHeuristic) return false;
    const best = this.bestCellFor(type);
    if (!best) return false;
    return this.place(type, best.t, best.i, true);
  }

  // Can a building of this type sit on cell i (ignoring what is there now)?
  terrainAllows(type, b, i) {
    const t = b.terr[i];
    if (type === 'hourglass') return !b.isVoid(i);
    if (type === 'crystal') return t === T_GEODE;
    if (type === 'prism') return t === T_NONE || t === T_SLOPE;
    if (type === 'stone') return t === T_NONE || t === T_SLOPE || t === T_CRACK;
    return false;
  }

  bestCellFor(type) {
    const a = this.analyze();
    let best = null;
    const pf = this.prismFactor();
    for (let t = 0; t < this.boards.length; t++) {
      const b = this.boards[t], at = a.tables[t], s = b.size;
      const u = type === 'hourglass' ? null : this.toppleMap(t);
      for (let i = 0; i < b.n; i++) {
        let score;
        if (type === 'hourglass') {
          if (b.isVoid(i)) continue;
          score = at.v[i] + (at.X ? at.X[i] : 1) * at.down;
          if (t > 0) score *= 0.999; // prefer the top table on ties
        } else {
          if (b.kind[i] !== EMPTY || !this.terrainAllows(type, b, i)) continue;
          if (type === 'crystal') {
            score = u[i] * (this.crystalValueAt(b, i) * Math.pow(this.fx.stoneGlow, this.adjacentKinds(b, i, STONE)) - b.val[i]);
          } else {
            const x = i % s, y = (i / s) | 0;
            let gain = 0;
            for (let d = 0; d < 4; d++) {
              let nx = x + DX[d];
              const ny = y + DY[d];
              if (b.fold && (d === 1 || d === 3)) nx = (nx + s) % s;
              if (nx < 0 || ny < 0 || nx >= s || ny >= s) continue;
              const j = ny * s + nx;
              if (b.kind[j] === CRYSTAL) gain += u[j] * b.val[j] * (pf - 1);
            }
            score = gain + u[i] * 1e-6;
          }
        }
        if (!best || score > best.score) best = { t, i, score };
      }
    }
    return best;
  }

  adjacentKinds(b, i, kind) {
    const s = b.size, x = i % s, y = (i / s) | 0;
    let c = 0;
    for (let d = 0; d < 4; d++) {
      let nx = x + DX[d];
      const ny = y + DY[d];
      if (b.fold && (d === 1 || d === 3)) nx = (nx + s) % s;
      if (nx < 0 || ny < 0 || nx >= s || ny >= s) continue;
      if (b.kind[ny * s + nx] === kind) c++;
    }
    return c;
  }

  // Dust/s on table t if the layout of board b were as it is now (re-solves).
  rawWithLayout(t) {
    const b = this.boards[t];
    const at = this.analyze().tables[t];
    this.refreshVals();
    const v = b.solveValue(b.val, at.v, 1e-8);
    let raw = 0;
    for (let i = 0; i < b.n; i++) if (at.drop[i]) raw += at.drop[i] * (b.isVoid(i) ? 0 : v[i]);
    return raw;
  }

  // What would placing a building here (or moving the stack/building `from`
  // here) do to dust income? Returns { ok, ratio } where ratio is new/old.
  preview(type, t, i, from = -1) {
    const b = this.boards[t];
    if (!b || i < 0 || i >= b.n) return null;
    const key = `${this.flowVersion}:${this.layoutVersion}:${type}:${t}:${i}:${from}`;
    if (this._pv && this._pv.key === key) return this._pv.res;
    const a = this.analyze();
    const at = a.tables[t];
    const base = a.raw;
    let res = { ok: false, ratio: 1 };
    if (base > 0) {
      if (type === 'hourglass') {
        if (!b.isVoid(i)) {
          const n = from >= 0 ? b.hg[from] : 1;
          const r = this.baseHourglassRate();
          const gv = (c) => at.v[c] + (at.X ? at.X[c] : 1) * at.down;
          const delta = n * r * (gv(i) - (from >= 0 ? gv(from) : 0));
          res = { ok: true, ratio: (base + delta) / base };
        }
      } else if (type === 'crystal' || type === 'prism') {
        if (b.kind[i] === EMPTY && this.terrainAllows(type, b, i)) {
          const u = this.toppleMap(t);
          let delta;
          if (type === 'crystal') delta = u[i] * (this.crystalValueAt(b, i) - b.val[i]);
          else {
            delta = 0;
            const s = b.size, x = i % s, y = (i / s) | 0;
            for (let d = 0; d < 4; d++) {
              let nx = x + DX[d];
              const ny = y + DY[d];
              if (b.fold && (d === 1 || d === 3)) nx = (nx + s) % s;
              if (nx < 0 || ny < 0 || nx >= s || ny >= s) continue;
              const j = ny * s + nx;
              if (b.kind[j] === CRYSTAL) delta += u[j] * b.val[j] * (this.prismFactor() - 1);
            }
          }
          res = { ok: true, ratio: (base + delta) / base };
        }
      } else if (type === 'stone') {
        let ok;
        if (from >= 0) {
          const k = b.kind.slice(); k[from] = EMPTY; k[i] = STONE;
          ok = b.kind[i] === EMPTY && b.hg[i] === 0 && this.terrainAllows('stone', b, i) && b.allCellsDrain(k);
        } else ok = b.canPlaceStone(i);
        if (ok) {
          const saved = b.kind.slice();
          if (from >= 0) b.kind[from] = EMPTY;
          b.kind[i] = STONE;
          b.rebuild();
          const raw = this.rawWithLayout(t);
          b.kind.set(saved);
          b.rebuild();
          this.refreshVals();
          res = { ok: true, ratio: (base - at.raw + raw) / base };
        } else res = { ok: false, ratio: 1, trapped: this.terrainAllows('stone', b, i) && b.kind[i] === EMPTY && b.hg[i] === 0 };
      }
    }
    this._pv = { key, res };
    return res;
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
      for (let i = 0; i < b.n; i++) {
        if (u0[i] < maxU * 0.02 || b.kind[i] !== EMPTY || b.hg[i] > 0 || i === b.funnel) continue;
        if (!this.terrainAllows('stone', b, i)) continue;
        cands.push(i);
      }
      cands.sort((p, q) => u0[q] - u0[p]);
      cands.length = Math.min(cands.length, 28);
      for (const i of cands) {
        if (!b.canPlaceStone(i)) continue;
        b.kind[i] = STONE;
        b.rebuild();
        const u = b.solveTopples(at.drop, u0, 1e-7);
        let traw = 0;
        for (let j = 0; j < b.n; j++) if (!b.isVoid(j)) traw += u[j] * b.val[j];
        b.kind[i] = EMPTY;
        b.rebuild();
        // stones do not change how much sand leaves a table, so only this table's value matters
        const score = traw - at.raw;
        if (!best || score > best.score) best = { t, i, score };
      }
    }
    if (best && best.score > a.raw * 1e-4) return best;
    return null;
  }

  place(type, t, i, auto = false) {
    const b = this.boards[t];
    if (!b || i < 0 || i >= b.n) return false;
    if (this.s.inv[type] <= 0) return false;
    if (type === 'hourglass') {
      if (b.isVoid(i)) return false;
      b.hg[i]++;
      if (b.hg[i] === 1) b.rebuild();
      this.s.inv[type]--;
      this.flowChanged();
      return true;
    }
    if (b.kind[i] !== EMPTY || !this.terrainAllows(type, b, i)) return false;
    const kind = D.BUILDINGS[type].kind;
    if (kind === STONE) {
      if (b.hg[i] > 0 || b.funnel === i) return false;
      if (!b.canPlaceStone(i)) {
        this.s.flags.triedTrap = true;
        if (!auto) this.emit('toast', { text: 'The sand would be trapped there. Stones must always leave it a way out.', kind: 'warn' });
        return false;
      }
      if (b.terr[i] === T_CRACK) this.s.flags.plugged = true;
      b.grains[i] = 0;
    }
    if (kind === CRYSTAL && b.rich[i] * this.geodeMult() >= 3) this.s.flags.richCrystal = true;
    b.kind[i] = kind;
    b.rebuild();
    this.s.inv[type]--;
    this.layoutChanged();
    return true;
  }

  isBedrock(b, i) { return b.terr[i] === T_BEDROCK; }

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
    if (k === EMPTY || this.isBedrock(b, i)) return false;
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
      if (b.isVoid(to)) return false;
      b.hg[to] += b.hg[from];
      b.hg[from] = 0;
      b.acc[to] = b.acc[from];
      b.rebuild();
      this.s.flags.movedStack = true;
      this.flowChanged();
      return true;
    }
    const kf = b.kind[from], kt = b.kind[to];
    if (kf === EMPTY || this.isBedrock(b, from) || this.isBedrock(b, to)) return false;
    const tf = D.KIND_TO_BUILDING[kf], tt = kt === EMPTY ? null : D.KIND_TO_BUILDING[kt];
    if (!this.terrainAllows(tf, b, to) || (tt && !this.terrainAllows(tt, b, from))) {
      if (tf === 'crystal') this.emit('toast', { text: 'Crystals only grow on geodes.', kind: 'warn' });
      return false;
    }
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
    if (kf === STONE) { b.grains[to] = 0; if (b.terr[to] === T_CRACK) this.s.flags.plugged = true; }
    if (kt === STONE) b.grains[from] = 0;
    b.rebuild();
    this.layoutChanged();
    return true;
  }

  moveFunnel(t, to) {
    const b = this.boards[t];
    if (!b || t === 0 || to < 0 || to >= b.n || b.isVoid(to)) return false;
    b.funnel = to;
    this.layoutChanged();
    this._layout = null;
    return true;
  }

  // The Shape tool: break bedrock (Pickaxe) or turn a slope (Weathervane).
  canShape(t, i) {
    const b = this.boards[t];
    if (!b) return null;
    if (b.terr[i] === T_BEDROCK && this.fx.pick > (this.s.broken[t] || 0)) return 'break';
    if (b.terr[i] === T_SLOPE && this.fx.vane > 0 && b.kind[i] !== STONE) return 'turn';
    return null;
  }

  shape(t, i) {
    const what = this.canShape(t, i);
    if (!what) return false;
    const b = this.boards[t];
    const [mx, my] = this.mapOfCell(b, i);
    if (what === 'break') {
      b.terr[i] = T_NONE;
      b.kind[i] = EMPTY;
      b.grains[i] = 2;
      this.s.broken[t] = (this.s.broken[t] || 0) + 1;
      this.s.edits.push({ t, mx, my, terr: T_NONE });
    } else {
      // turn clockwise, skipping directions that would trap sand
      const start = b.sdir[i];
      for (let k = 1; k <= 4; k++) {
        b.sdir[i] = (start + k) & 3;
        b.rebuild();
        if (b.allCellsDrain()) break;
      }
      this.s.edits.push({ t, mx, my, terr: T_SLOPE, sdir: b.sdir[i] });
    }
    b.rebuild();
    this.layoutChanged();
    return what;
  }

  setFold(on) {
    if (!this.has('fold')) return false;
    const prevFold = this.s.fold;
    this.s.fold = on;
    const r = this.rules();
    for (const b of this.boards) {
      const saved = b.fold;
      b.fold = r.fold;
      b.rebuild();
      if (!b.allCellsDrain()) {
        b.fold = saved;
        this.s.fold = prevFold;
        for (const bb of this.boards) this.applyRules(bb);
        this.emit('toast', { text: 'Folding would trap sand behind your stones or the bedrock.', kind: 'warn' });
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
    if (u.need && !this.has(u.need)) return false;
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
    if (this.fx.memory >= 2) ids.push('u_sift', 'u_crystal', 'u_spade', 'u_finer', 'u_t9', 'u_quake', 'u_facet', 'u_glimmer', 'u_t11');
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
    if (this.boards[0].size < this.maxSize()) this.resizeTables(this.maxSize());
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
    if (!b || b.isVoid(i)) return false;
    const g = this.handGrains() * times;
    if (!this.analyticOnly) b.add(i, g);
    this.s.stats.clicks += times;
    this.s.stats.handGrains += g;
    this.s.flags.clickedThisRun = true;
    // digging by hand
    const dig = this.digAt(t, i);
    if (dig) {
      dig.prog += g * CLICK_DIG * this.digMult();
      if (dig.prog >= dig.need) this.completeDig(dig);
    }
    // income: the exact expected value of these grains
    const at = this.analyze().tables[t];
    const ev = g * this.grainValue(t, i) * this.dustMult();
    this.gainDust(ev);
    this.s.stats.topples += g * at.linger[i];
    return ev;
  }

  quake(power = 1) {
    if (!this.canQuake()) return false;
    const free = power === 1;
    if (free && this.s.quakeCd > 0) return false;
    const a = this.analyze();
    const total = Math.max(1, this.quakeSeconds() * a.grainRate) * power;
    let cells = 0;
    for (const b of this.boards) for (let i = 0; i < b.n; i++) if (!b.isVoid(i)) cells++;
    const per = total / cells;
    // income: the expected value of `per` grains on every cell
    let val = 0, topples = 0;
    for (let t = 0; t < this.boards.length; t++) {
      const b = this.boards[t], at = a.tables[t];
      for (let i = 0; i < b.n; i++) {
        if (b.isVoid(i)) continue;
        val += per * (at.v[i] + (at.X ? at.X[i] : 1) * at.down);
        topples += per * at.linger[i];
        if (!this.analyticOnly) b.grains[i] += Math.min(3 + power, Math.max(1, Math.round(per)));
      }
    }
    // a quake shakes loose a little of every dig
    for (const d of this.visibleDigs()) {
      d.prog += d.need * 0.03 * power;
      if (d.prog >= d.need) this.completeDig(d);
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
    const digs = this.visibleDigs();
    if (r < 0.35) {
      const amt = Math.max(25, 60 * pow * this.baseRate());
      this.gainDust(amt);
      text = 'Windfall';
      this.emit('gleam', { kind: 'windfall', amount: amt });
    } else if (r < 0.55) {
      this.s.buffs.shimmer = 30 * pow;
      this.emit('gleam', { kind: 'shimmer', duration: 30 * pow });
      text = 'Shimmer';
    } else if (r < 0.72) {
      this.s.buffs.sandstorm = 15 * pow;
      this.emit('gleam', { kind: 'sandstorm', duration: 15 * pow });
      text = 'Sandstorm';
    } else if (r < 0.87 && digs.length) {
      // the gleam points to something buried
      for (const d of digs) {
        d.prog += d.need * 0.2 * pow;
        if (d.prog >= d.need) this.completeDig(d);
      }
      this.emit('gleam', { kind: 'unearth' });
      text = 'Unearth';
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
    return Math.max(FIRST_SWEEP, FIRST_SWEEP * Math.pow(g / (3 * this.fx.glass), 1 / GLASS_EXP));
  }

  startingHourglasses() {
    let n = this.s.sweeps > 0 ? 1 : 0;
    n = Math.max(n, this.fx.startHg);
    if (this.s.trial === 't_still') n = Math.max(n, 5);
    return n;
  }

  canSweep() { return this.glassGain() >= 1 || (this.s.trial !== null); }

  // The tables offered for the next run. Generated once and kept until you sweep.
  candidates() {
    const s = this.s;
    const count = this.tableChoices();
    if (s.candidates && s.candidates.length >= count) return s.candidates;
    const tier = s.tablesPlayed + 1;
    const R = mulberry32((s.seedBase + 104729 * tier) >>> 0);
    const archs = candidateArchetypes(tier, count, R);
    const list = s.candidates ? s.candidates.slice() : [];
    for (let k = list.length; k < count; k++) {
      const def = { seed: Math.floor(R() * 4294967295) >>> 0, tier, arch: archs[k] };
      const map = generateTable(def);
      list.push({ ...def, name: map.name, blurb: map.blurb, features: map.features });
    }
    s.candidates = list;
    return list;
  }

  candidateMap(k) {
    const c = this.candidates()[k];
    return c ? generateTable(c) : null;
  }

  sweep(doctrine = this.s.doctrine, trial = null, choice = 0) {
    const s = this.s;
    const gain = this.glassGain();
    const runTime = s.stats.runTime;
    s.glass += gain;
    s.glassAll += gain;
    if (gain > 0 || s.trial) s.sweeps++;
    if (gain > 0 && s.stats.played - s.stats.lastSweepAt < 180 && s.sweeps > 1) s.flags.quickSweep = true;
    s.stats.lastSweepAt = s.stats.played;
    s.stats.bestGain = Math.max(s.stats.bestGain, gain);
    const cands = this.candidates();
    const c = cands[Math.max(0, Math.min(cands.length - 1, choice))];
    const funnels = this.boards.map(b => b.funnel < 0 ? null : this.mapOfCell(b, b.funnel));
    // reset run state
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
    s.tablesPlayed++;
    s.tableDefs = [{ seed: c.seed, tier: c.tier, arch: c.arch }];
    s.candidates = null;
    this.recomputeFx();
    this.applyMemory();
    this.buildTables(this.startSize());
    // keep funnels where they were, if they are still sensible
    funnels.forEach((f, t) => {
      const b = this.boards[t];
      if (!b || t === 0 || !f) return;
      const i = this.cellOfMap(b, f[0], f[1]);
      if (i >= 0 && !b.isVoid(i)) b.funnel = i;
    });
    const free = this.startingHourglasses();
    for (let k = 0; k < free; k++) {
      s.owned.hourglass++;
      s.inv.hourglass++;
      this.autoPlace('hourglass', true);
    }
    this.layoutChanged();
    this.emit('sweep', { gain, runTime, table: c.name });
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

  startTrial(id, choice = 0) {
    if (!this.has('trials') || !D.TRIAL_MAP[id]) return false;
    this.sweep(this.s.doctrine, id, choice);
    this.emit('toast', { text: `Trial begun: ${D.TRIAL_MAP[id].name}`, kind: 'info' });
    return true;
  }

  // ------------------------------------------------------------ time
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
          if (scatter && b.terr[i] !== T_SPRING) {
            for (let j = 0; j < k; j++) {
              let c = rngInt(this.rng, b.n), tries = 0;
              while (b.isVoid(c) && tries++ < 20) c = rngInt(this.rng, b.n);
              if (!b.isVoid(c)) b.grains[c] += 1;
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
    this.advanceDigs(dt);
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
          while (b.isVoid(c) && tries++ < 50) c = rngInt(this.rng, b.n);
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

  // Returns false if the save is from an incompatible older version.
  load(json) {
    const o = typeof json === 'string' ? JSON.parse(json) : json;
    if (!o || o.v !== SAVE_VERSION) return false;
    const base = newState();
    const s = Object.assign(base, o);
    for (const k of ['owned', 'inv', 'stats', 'settings', 'auto']) s[k] = Object.assign(newState()[k], o[k] || {});
    for (const k of ['flags', 'buffs', 'relics', 'trials', 'kiln', 'up', 'ach', 'seen', 'broken']) s[k] = Object.assign({}, o[k] || {});
    for (const k of ['journal', 'digs', 'edits', 'tableDefs']) s[k] = Array.isArray(o[k]) ? o[k] : [];
    this.s = s;
    this.recomputeFx();
    if (!s.tableDefs.length) s.tableDefs = [{ seed: s.seedBase, tier: 1, arch: 'first', first: true }];
    this.maps = [];
    if (Array.isArray(o.tables) && o.tables.length) {
      this.boards = o.tables.map((t, k) => {
        const b = Board.deserialize(t);
        this.applyTerrain(k, b);
        this.applyRules(b, k);
        return b;
      });
    } else {
      this.buildTables(this.startSize());
    }
    while (this.boards.length < this.maxTables()) this.addTable();
    if (this.boards[0].size < this.maxSize()) this.resizeTables(this.maxSize());
    this._layout = null;
    this.analysis = null;
    this.layoutChanged();
    return this;
  }

  // Grant offline progress for `sec` seconds. Returns gains.
  offline(sec) {
    if (!(sec > 0)) return null;
    const before = { dust: this.s.dust, sand: this.s.sand, relics: this.relicCount() };
    this.s.stats.played += sec;
    this.s.stats.runTime += sec;
    this.s.quakeCd = Math.max(0, this.s.quakeCd - sec);
    this.s.buffs = {};
    this.s.aftershock = 0;
    this.s.gleam = null;
    this.analyticAdvance(sec, false);
    this.runAutomation();
    return { dust: this.s.dust - before.dust, sand: this.s.sand - before.sand, relics: this.relicCount() - before.relics, sec };
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
  for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) {
    const k = b.kind[y * s + x];
    if (k !== b.kind[y * s + (s - 1 - x)] || k !== b.kind[(s - 1 - y) * s + x] || k !== b.kind[x * s + y]) return false;
  }
  return true;
}

export { TERRAIN_NAMES };
