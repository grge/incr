// Sandpile simulation: an abelian sandpile on a square grid with terrain
// (bedrock, cracks, slopes), buildings (stones block and reflect sand),
// optional east-west folding, and an analytic steady-state solver.

// Cell kinds (things you build). Hourglasses are not a kind: they stack on cells (see `hg`).
export const EMPTY = 0, CRYSTAL = 1, STONE = 2, PRISM = 3;
export const KIND_NAMES = ['empty', 'crystal', 'stone', 'prism'];

// Terrain (things the table comes with).
export const T_NONE = 0, T_GEODE = 1, T_BEDROCK = 2, T_SPRING = 3, T_CRACK = 4, T_DIG = 5, T_SLOPE = 6;
export const TERRAIN_NAMES = ['plain', 'geode', 'bedrock', 'spring', 'crack', 'dig site', 'slope'];

// N, E, S, W
export const DX = [0, 1, 0, -1];
export const DY = [-1, 0, 1, 0];

const EXIT = -1;
const BLOCKED = -2;

export class Board {
  constructor(size) {
    this.size = size;
    this.n = size * size;
    this.grains = new Float64Array(this.n);
    this.kind = new Uint8Array(this.n);
    this.terr = new Uint8Array(this.n);       // terrain type
    this.rich = new Float32Array(this.n).fill(1); // geode richness
    this.sdir = new Int8Array(this.n);         // slope direction (0..3) where terr is T_SLOPE
    this.hg = new Int32Array(this.n);          // hourglasses stacked on each cell
    this.acc = new Float64Array(this.n);       // pour accumulators
    this.flash = new Float32Array(this.n);     // visual topple intensity
    this.val = new Float64Array(this.n).fill(1); // dust value per topple (pre global mult)
    this.fold = false;
    this.weights = [1, 1, 1, 1];               // global toppling weights (wind)
    this.keep = 1;                             // fraction of each sent grain that survives
    this.funnel = -1;
    this.toppled = new Int32Array(this.n);     // cells that toppled in the last round
    this.toppledCount = 0;
    this.spills = [];                          // recent spill events (sampled) for visuals
    this._K = new Float64Array(this.n);
    this._act = new Int32Array(this.n);
    this.rebuild();
  }

  idx(x, y) { return y * this.size + x; }

  // A cell that can never hold sand: a stone, bedrock, or an open crack.
  isVoid(i) { return this.kind[i] === STONE || this.terr[i] === T_CRACK; }

  // Per-direction toppling weights of cell i (sum 4 unless the wind blows).
  cellWeights(i, out = [0, 0, 0, 0]) {
    if (this.terr[i] === T_SLOPE) {
      const d = this.sdir[i];
      out[0] = out[1] = out[2] = out[3] = 0;
      out[d] = 2; out[(d + 1) & 3] = 1; out[(d + 3) & 3] = 1;
    } else {
      const w = this.weights;
      out[0] = w[0]; out[1] = w[1]; out[2] = w[2]; out[3] = w[3];
    }
    return out;
  }

  // Where does cell i send grains in direction d, given kinds `kinds`?
  _target(i, d, kinds, w) {
    if (w <= 0) return BLOCKED;
    const s = this.size, x = i % s, y = (i / s) | 0;
    let nx = x + DX[d], ny = y + DY[d];
    if (this.fold && (d === 1 || d === 3)) nx = (nx + s) % s;
    if (nx < 0 || ny < 0 || nx >= s || ny >= s) return EXIT;
    const j = ny * s + nx;
    if (kinds[j] === STONE) return BLOCKED;
    if (this.terr[j] === T_CRACK) return EXIT;   // falls through the crack
    return j;
  }

  // Recompute neighbour topology after a layout / rule change.
  rebuild() {
    const n = this.n;
    this.tgt = new Int32Array(n * 4);
    this.wc = new Float64Array(n * 4);
    this.out = new Float64Array(n);
    this.hasSlopes = false;
    const inCount = new Int32Array(n + 1);
    const w = [0, 0, 0, 0];
    for (let i = 0; i < n; i++) {
      const vd = this.isVoid(i);
      if (this.terr[i] === T_SLOPE) this.hasSlopes = true;
      this.cellWeights(i, w);
      for (let d = 0; d < 4; d++) {
        const t = vd ? BLOCKED : this._target(i, d, this.kind, w[d]);
        this.tgt[i * 4 + d] = t;
        this.wc[i * 4 + d] = w[d];
        if (t !== BLOCKED) this.out[i] += w[d];
        if (t >= 0) inCount[t + 1]++;
      }
    }
    for (let i = 0; i < n; i++) inCount[i + 1] += inCount[i];
    this.inStart = inCount;
    this.inSrc = new Int32Array(inCount[n]);
    this.inW = new Float64Array(inCount[n]);
    const fill = inCount.slice(0, n);
    for (let i = 0; i < n; i++) {
      for (let d = 0; d < 4; d++) {
        const t = this.tgt[i * 4 + d];
        if (t >= 0) { const p = fill[t]++; this.inSrc[p] = i; this.inW[p] = this.wc[i * 4 + d]; }
      }
    }
    this.hourglasses = [];
    for (let i = 0; i < n; i++) if (this.hg[i] > 0) this.hourglasses.push(i);
  }

  add(i, amount) {
    if (i < 0 || i >= this.n || this.isVoid(i)) return;
    this.grains[i] += amount;
  }

  // One synchronous toppling round. Returns stats.
  round(sampleSpills = false) {
    const n = this.n, g = this.grains, K = this._K, act = this._act;
    const tgt = this.tgt, out = this.out, val = this.val, flash = this.flash, wc = this.wc;
    const kp = this.keep;
    let m = 0;
    for (let i = 0; i < n; i++) {
      if (g[i] >= 4) { K[i] = Math.floor(g[i] / 4); act[m++] = i; }
    }
    let topples = 0, value = 0, spilled = 0;
    this.toppledCount = m;
    if (sampleSpills) this.spills.length = 0;
    for (let j = 0; j < m; j++) {
      const i = act[j], k = K[i];
      g[i] -= k * out[i];
      const b = i * 4;
      for (let d = 0; d < 4; d++) {
        const t = tgt[b + d];
        if (t >= 0) g[t] += k * wc[b + d] * kp;
        else if (t === EXIT) {
          spilled += k * wc[b + d] * kp;
          if (sampleSpills && this.spills.length < 24) this.spills.push(i, d);
        }
      }
      topples += k;
      value += k * val[i];
      flash[i] = 1;
      this.toppled[j] = i;
    }
    return { topples, value, spilled, wave: m };
  }

  isStable() {
    const g = this.grains;
    for (let i = 0; i < this.n; i++) if (g[i] >= 4) return false;
    return true;
  }

  totalGrains() {
    let s = 0;
    for (let i = 0; i < this.n; i++) s += this.grains[i];
    return s;
  }

  // Would every cell that can hold sand still have a way for it to leave
  // the table, if the kinds were `kinds` (defaults to current)?
  allCellsDrain(kinds = this.kind) {
    const n = this.n;
    const ok = new Uint8Array(n);
    const queue = [];
    const rev = Array.from({ length: n }, () => []);
    const w = [0, 0, 0, 0];
    const isVoid = (i) => kinds[i] === STONE || this.terr[i] === T_CRACK;
    for (let i = 0; i < n; i++) {
      if (isVoid(i)) continue;
      this.cellWeights(i, w);
      for (let d = 0; d < 4; d++) {
        const t = this._target(i, d, kinds, w[d]);
        if (t === EXIT && !ok[i]) { ok[i] = 1; queue.push(i); }
        else if (t >= 0) rev[t].push(i);
      }
    }
    while (queue.length) {
      const c = queue.pop();
      for (const p of rev[c]) if (!ok[p]) { ok[p] = 1; queue.push(p); }
    }
    for (let i = 0; i < n; i++) if (!isVoid(i) && !ok[i]) return false;
    return true;
  }

  // Stones go on plain ground, slopes, or into cracks (plugging them).
  canPlaceStone(i) {
    if (this.kind[i] !== EMPTY || this.hg[i] > 0 || i === this.funnel) return false;
    const t = this.terr[i];
    if (t === T_GEODE || t === T_SPRING || t === T_DIG || t === T_BEDROCK) return false;
    const k = this.kind.slice();
    k[i] = STONE;
    return this.allCellsDrain(k);
  }

  _omega() {
    const s = this.size;
    return Math.min(1.95, 2 / (1 + Math.sin(Math.PI / (s + 1))));
  }

  _symmetric() {
    const w = this.weights;
    return !this.hasSlopes && w[0] === w[2] && w[1] === w[3];
  }

  // Steady-state topple rate per cell given drop rates per cell.
  solveTopples(drop, prev, tol = 1e-10) {
    const n = this.n, out = this.out, inS = this.inStart, inSrc = this.inSrc, inW = this.inW, kp = this.keep;
    let scale = 0;
    for (let i = 0; i < n; i++) scale += drop[i];
    if (scale <= 0) return new Float64Array(n);
    // Over-relaxation is only guaranteed to converge for symmetric rules; with
    // winds and slopes it can diverge, so fall back to plain Gauss–Seidel.
    for (let om = this._symmetric() ? this._omega() : 1.3; ; om = 1) {
      const u = prev && prev.length === n ? Float64Array.from(prev) : new Float64Array(n);
      let minMd = Infinity, diverged = false;
      for (let it = 0; it < 30000; it++) {
        let md = 0, mx = 1e-300;
        for (let x = 0; x < n; x++) {
          if (out[x] <= 0) { u[x] = 0; continue; }
          let s = drop[x];
          for (let p = inS[x]; p < inS[x + 1]; p++) s += kp * inW[p] * u[inSrc[p]];
          const nv = s / out[x];
          const d = nv - u[x];
          u[x] += om * d;
          if (u[x] < 0) u[x] = 0;
          const ad = d < 0 ? -d : d;
          if (ad > md) md = ad;
          if (u[x] > mx) mx = u[x];
        }
        if (md <= mx * tol) break;
        if (md < minMd) minMd = md;
        else if (om > 1 && (md > minMd * 1e4 || !(md < Infinity))) { diverged = true; break; }
      }
      if (!diverged || om <= 1) return u;
    }
  }

  // Expected value (sum of val over topples) caused by one grain dropped at each cell.
  solveValue(val, prev, tol = 1e-10) {
    const n = this.n, out = this.out, tgt = this.tgt, wc = this.wc, kp = this.keep;
    for (let om = this._symmetric() ? this._omega() : 1.3; ; om = 1) {
      const v = prev && prev.length === n ? Float64Array.from(prev) : new Float64Array(n);
      let minMd = Infinity, diverged = false;
      for (let it = 0; it < 30000; it++) {
        let md = 0, mx = 1e-300;
        for (let x = 0; x < n; x++) {
          if (out[x] <= 0) { v[x] = 0; continue; }
          let s = val[x];
          const b = x * 4;
          for (let d = 0; d < 4; d++) { const t = tgt[b + d]; if (t >= 0) s += kp * wc[b + d] * v[t]; }
          const nv = s / out[x];
          const dd = nv - v[x];
          v[x] += om * dd;
          if (v[x] < 0) v[x] = 0;
          const ad = dd < 0 ? -dd : dd;
          if (ad > md) md = ad;
          if (v[x] > mx) mx = v[x];
        }
        if (md <= mx * tol) break;
        if (md < minMd) minMd = md;
        else if (om > 1 && (md > minMd * 1e4 || !(md < Infinity))) { diverged = true; break; }
      }
      if (!diverged || om <= 1) return v;
    }
  }

  // Grow the board, keeping contents centred. Terrain of the new cells is left
  // plain; the game fills it in from the table's terrain map.
  resized(newSize) {
    const b = new Board(newSize);
    b.fold = this.fold;
    b.weights = this.weights.slice();
    b.keep = this.keep;
    const off = (newSize - this.size) >> 1;
    for (let y = 0; y < this.size; y++) {
      for (let x = 0; x < this.size; x++) {
        const nx = x + off, ny = y + off;
        if (nx < 0 || ny < 0 || nx >= newSize || ny >= newSize) continue;
        const i = this.idx(x, y), j = b.idx(nx, ny);
        b.grains[j] = this.grains[i];
        b.kind[j] = this.kind[i];
        b.terr[j] = this.terr[i];
        b.rich[j] = this.rich[i];
        b.sdir[j] = this.sdir[i];
        b.hg[j] = this.hg[i];
        b.acc[j] = this.acc[i];
      }
    }
    if (this.funnel >= 0) {
      const fx = this.funnel % this.size + off, fy = ((this.funnel / this.size) | 0) + off;
      b.funnel = (fx >= 0 && fy >= 0 && fx < newSize && fy < newSize) ? b.idx(fx, fy) : b.idx(newSize >> 1, newSize >> 1);
    }
    b.rebuild();
    return b;
  }

  serialize() {
    return {
      size: this.size,
      grains: Array.from(this.grains, g => Math.round(g)),
      kind: Array.from(this.kind),
      hg: Array.from(this.hg),
      funnel: this.funnel,
    };
  }

  // Terrain is not saved: it is regenerated from the table's seed and applied afterwards.
  static deserialize(o) {
    const b = new Board(o.size);
    if (Array.isArray(o.grains) && o.grains.length === b.n) b.grains.set(o.grains.map(x => Math.max(0, +x || 0)));
    if (Array.isArray(o.kind) && o.kind.length === b.n) b.kind.set(o.kind.map(x => (x | 0) % 4));
    if (Array.isArray(o.hg) && o.hg.length === b.n) b.hg.set(o.hg.map(x => Math.max(0, x | 0)));
    b.funnel = typeof o.funnel === 'number' ? o.funnel : -1;
    for (let i = 0; i < b.n; i++) b.acc[i] = Math.random();
    b.rebuild();
    return b;
  }
}
