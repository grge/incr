// Sandpile simulation: an abelian sandpile on a square grid with
// buildings (stones block and reflect sand), optional east-west folding,
// biased toppling (tilt), and an analytic steady-state solver.

// Cell kinds. Hourglasses are not a kind: they stack on any non-stone cell (see `hg`).
export const EMPTY = 0, CRYSTAL = 1, STONE = 2, PRISM = 3;
export const KIND_NAMES = ['empty', 'crystal', 'stone', 'prism'];
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
    this.hg = new Int32Array(this.n);         // hourglasses stacked on each cell
    this.acc = new Float64Array(this.n);      // hourglass drop accumulators
    this.flash = new Float32Array(this.n);    // visual topple intensity
    this.val = new Float64Array(this.n).fill(1); // dust value per topple (pre global mult)
    this.fold = false;
    this.weights = [1, 1, 1, 1];
    this.keep = 1;                             // fraction of each sent grain that survives
    this.funnel = -1;
    this.toppled = new Int32Array(this.n);    // cells that toppled in the last round
    this.toppledK = new Float64Array(this.n);
    this.toppledCount = 0;
    this.spills = [];                          // recent spill events (sampled) for visuals
    this._K = new Float64Array(this.n);
    this._act = new Int32Array(this.n);
    this.rebuild();
  }

  idx(x, y) { return y * this.size + x; }

  // Recompute neighbour topology after a layout / rule change.
  rebuild() {
    const n = this.n, s = this.size, w = this.weights;
    this.tgt = new Int32Array(n * 4);
    this.out = new Float64Array(n);
    const inCount = new Int32Array(n + 1);
    for (let i = 0; i < n; i++) {
      const x = i % s, y = (i / s) | 0;
      for (let d = 0; d < 4; d++) {
        let t;
        if (this.kind[i] === STONE || w[d] <= 0) t = BLOCKED;
        else {
          let nx = x + DX[d], ny = y + DY[d];
          if (this.fold && (d === 1 || d === 3)) nx = (nx + s) % s;
          if (nx < 0 || ny < 0 || nx >= s || ny >= s) t = EXIT;
          else {
            const j = ny * s + nx;
            t = this.kind[j] === STONE ? BLOCKED : j;
          }
        }
        this.tgt[i * 4 + d] = t;
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
        if (t >= 0) { const p = fill[t]++; this.inSrc[p] = i; this.inW[p] = w[d]; }
      }
    }
    this.hourglasses = [];
    for (let i = 0; i < n; i++) if (this.hg[i] > 0) this.hourglasses.push(i);
  }

  add(i, amount) {
    if (i < 0 || i >= this.n || this.kind[i] === STONE) return;
    this.grains[i] += amount;
  }

  // Pour `perHourglass` grains (fractional) from every hourglass, using accumulators.
  feed(perHourglass) {
    const hs = this.hourglasses, acc = this.acc, g = this.grains, hg = this.hg;
    let dropped = 0;
    for (let j = 0; j < hs.length; j++) {
      const i = hs[j];
      acc[i] += perHourglass * hg[i];
      if (acc[i] >= 1) {
        const k = Math.floor(acc[i]);
        acc[i] -= k;
        g[i] += k;
        dropped += k;
      }
    }
    return dropped;
  }

  // One synchronous toppling round. Returns stats.
  round(sampleSpills = false) {
    const n = this.n, g = this.grains, K = this._K, act = this._act;
    const tgt = this.tgt, out = this.out, val = this.val, flash = this.flash;
    const kp = this.keep, w = this.weights.map(x => x * kp);
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
        if (t >= 0) g[t] += k * w[d];
        else if (t === EXIT) {
          spilled += k * w[d];
          if (sampleSpills && this.spills.length < 24) this.spills.push(i, d);
        }
      }
      topples += k;
      value += k * val[i];
      flash[i] = 1;
      this.toppled[j] = i;
      this.toppledK[j] = k;
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

  // Would every non-stone cell still have a path for sand to leave the table
  // if the kinds were `kinds` (defaults to current)?
  allCellsDrain(kinds = this.kind) {
    const n = this.n, s = this.size, w = this.weights;
    const ok = new Uint8Array(n);
    const queue = [];
    const sendsTo = (i, d) => {
      if (kinds[i] === STONE || w[d] <= 0) return BLOCKED;
      const x = i % s, y = (i / s) | 0;
      let nx = x + DX[d], ny = y + DY[d];
      if (this.fold && (d === 1 || d === 3)) nx = (nx + s) % s;
      if (nx < 0 || ny < 0 || nx >= s || ny >= s) return EXIT;
      const j = ny * s + nx;
      return kinds[j] === STONE ? BLOCKED : j;
    };
    // build reverse adjacency
    const rev = Array.from({ length: n }, () => []);
    for (let i = 0; i < n; i++) {
      if (kinds[i] === STONE) continue;
      for (let d = 0; d < 4; d++) {
        const t = sendsTo(i, d);
        if (t === EXIT && !ok[i]) { ok[i] = 1; queue.push(i); }
        else if (t >= 0) rev[t].push(i);
      }
    }
    while (queue.length) {
      const c = queue.pop();
      for (const p of rev[c]) if (!ok[p]) { ok[p] = 1; queue.push(p); }
    }
    for (let i = 0; i < n; i++) if (kinds[i] !== STONE && !ok[i]) return false;
    return true;
  }

  canPlaceStone(i) {
    if (this.kind[i] !== EMPTY || this.hg[i] > 0 || i === this.funnel) return false;
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
    return w[0] === w[2] && w[1] === w[3] && this.keep === 1;
  }

  // Steady-state topple rate per cell given drop rates per cell.
  solveTopples(drop, prev, tol = 1e-10) {
    const n = this.n, out = this.out, inS = this.inStart, inSrc = this.inSrc, inW = this.inW, kp = this.keep;
    const u = prev && prev.length === n ? Float64Array.from(prev) : new Float64Array(n);
    const om = this._symmetric() ? this._omega() : 1.0;
    let scale = 0;
    for (let i = 0; i < n; i++) scale += drop[i];
    if (scale <= 0) return new Float64Array(n);
    for (let it = 0; it < 20000; it++) {
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
    }
    return u;
  }

  // Expected value (sum of val over topples) caused by one grain dropped at each cell.
  solveValue(val, prev) {
    const n = this.n, out = this.out, tgt = this.tgt, w = this.weights.map(x => x * this.keep);
    const v = prev && prev.length === n ? Float64Array.from(prev) : new Float64Array(n);
    const om = this._symmetric() ? this._omega() : 1.0;
    for (let it = 0; it < 20000; it++) {
      let md = 0, mx = 1e-300;
      for (let x = 0; x < n; x++) {
        if (out[x] <= 0) { v[x] = 0; continue; }
        let s = val[x];
        const b = x * 4;
        for (let d = 0; d < 4; d++) { const t = tgt[b + d]; if (t >= 0) s += w[d] * v[t]; }
        const nv = s / out[x];
        const dd = nv - v[x];
        v[x] += om * dd;
        const ad = dd < 0 ? -dd : dd;
        if (ad > md) md = ad;
        if (v[x] > mx) mx = v[x];
      }
      if (md <= mx * 1e-10) break;
    }
    return v;
  }

  // Grow (or shrink) the board, keeping contents centred.
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

  static deserialize(o) {
    const b = new Board(o.size);
    if (Array.isArray(o.grains) && o.grains.length === b.n) b.grains.set(o.grains.map(x => Math.max(0, +x || 0)));
    if (Array.isArray(o.kind) && o.kind.length === b.n) b.kind.set(o.kind.map(x => (x | 0) % 4));
    if (Array.isArray(o.hg) && o.hg.length === b.n) b.hg.set(o.hg.map(x => Math.max(0, x | 0)));
    b.funnel = typeof o.funnel === 'number' ? o.funnel : -1;
    for (let i = 0; i < b.n; i++) b.acc[i] = Math.random();
    b.rebuild();
    if (!b.allCellsDrain()) {
      // corrupt layout: remove stones
      for (let i = 0; i < b.n; i++) if (b.kind[i] === STONE) b.kind[i] = EMPTY;
      b.rebuild();
      b.rebuild();
    }
    return b;
  }
}
