// Voronoi cells on a raster, grown outward from stakes. Growth only passes
// through free ground, so a rock wall really separates the cells on either
// side of it; cracks and the region's edge are where sand falls away.
export const FREE = 0, ROCK = 1, CRACK = 2, OUT = 3;

const MIN_SHARED = 2;   // pixels of shared border needed to count as neighbours

// Min-heap of (key, value) pairs.
class Heap {
  constructor(cap = 1 << 15) {
    this.k = new Float64Array(cap);
    this.v = new Int32Array(cap);
    this.n = 0;
  }
  push(key, val) {
    if (this.n === this.k.length) {
      const k = new Float64Array(this.n * 2), v = new Int32Array(this.n * 2);
      k.set(this.k); v.set(this.v); this.k = k; this.v = v;
    }
    let i = this.n++;
    const K = this.k, V = this.v;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (K[p] <= key) break;
      K[i] = K[p]; V[i] = V[p]; i = p;
    }
    K[i] = key; V[i] = val;
  }
  // Pops the smallest; returns its value and leaves its key in this.top.
  pop() {
    const K = this.k, V = this.v;
    const val = V[0];
    this.top = K[0];
    const n = --this.n;
    if (n > 0) {
      const key = K[n], v = V[n];
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= n) break;
        if (c + 1 < n && K[c + 1] < K[c]) c++;
        if (K[c] >= key) break;
        K[i] = K[c]; V[i] = V[c]; i = c;
      }
      K[i] = key; V[i] = v;
    }
    return val;
  }
}

export class Tess {
  constructor(W, H, mask) {
    this.W = W; this.H = H; this.mask = mask;
    this.lab = new Int32Array(W * H).fill(-1);
    this.dist = new Float64Array(W * H).fill(Infinity);
    this.seeds = [];      // slot -> {x, y} or null
    this.heap = new Heap();
  }

  clone() {
    const t = new Tess(this.W, this.H, this.mask);
    t.lab.set(this.lab);
    t.dist.set(this.dist);
    t.seeds = this.seeds.slice();
    return t;
  }

  pixel(x, y) {
    const px = Math.floor(x), py = Math.floor(y);
    if (px < 0 || py < 0 || px >= this.W || py >= this.H) return -1;
    return py * this.W + px;
  }

  // Is (x, y) free ground at least `gap` from every other seed?
  canSeed(x, y, gap, ignore = -1) {
    const p = this.pixel(x, y);
    if (p < 0 || this.mask[p] !== FREE) return false;
    const g2 = gap * gap;
    for (let s = 0; s < this.seeds.length; s++) {
      const q = this.seeds[s];
      if (!q || s === ignore) continue;
      const dx = q.x - x, dy = q.y - y;
      if (dx * dx + dy * dy < g2) return false;
    }
    return true;
  }

  nearestSeed(x, y, within) {
    let best = -1, bd = within * within;
    for (let s = 0; s < this.seeds.length; s++) {
      const q = this.seeds[s];
      if (!q) continue;
      const d = (q.x - x) ** 2 + (q.y - y) ** 2;
      if (d < bd) { bd = d; best = s; }
    }
    return best;
  }

  _claim(slot) {
    const sd = this.seeds[slot];
    const p = this.pixel(sd.x, sd.y);
    if (p < 0 || this.mask[p] !== FREE) return;
    const W = this.W;
    const d = Math.hypot((p % W) + 0.5 - sd.x, ((p / W) | 0) + 0.5 - sd.y);
    if (d < this.dist[p]) {
      this.dist[p] = d;
      this.lab[p] = slot;
      this.heap.push(this.dist[p], p);
    }
  }

  // Grow labels outward. Priority is the straight-line distance to the
  // label's seed, so open ground gets true Voronoi bisectors.
  _grow() {
    const { W, H, mask, lab, dist, seeds, heap } = this;
    while (heap.n > 0) {
      const p = heap.pop();
      if (heap.top > dist[p]) continue;
      const s = lab[p];
      const sd = seeds[s];
      if (!sd) continue;
      const x = p % W, y = (p / W) | 0;
      for (let k = 0; k < 4; k++) {
        const nx = x + (k === 0 ? 1 : k === 1 ? -1 : 0);
        const ny = y + (k === 2 ? 1 : k === 3 ? -1 : 0);
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const q = ny * W + nx;
        if (mask[q] !== FREE) continue;
        const nd = Math.hypot(nx + 0.5 - sd.x, ny + 0.5 - sd.y);
        if (nd < dist[q] - 1e-9) {
          dist[q] = nd;
          lab[q] = s;
          heap.push(nd, q);
        }
      }
    }
  }

  rebuild() {
    this.lab.fill(-1);
    this.dist.fill(Infinity);
    this.heap.n = 0;
    for (let s = 0; s < this.seeds.length; s++) if (this.seeds[s]) this._claim(s);
    this._grow();
  }

  // Changes always rebuild from scratch (about 20 ms): the cells are then a
  // pure function of where the stakes are, so previews match placements.
  add(x, y) {
    let slot = this.seeds.indexOf(null);
    if (slot < 0) slot = this.seeds.length;
    this.seeds[slot] = { x, y };
    this.rebuild();
    return slot;
  }

  remove(slot) {
    this.seeds[slot] = null;
    this.rebuild();
  }

  move(slot, x, y) {
    this.seeds[slot] = { x, y };
    this.rebuild();
  }
}

// Turn a tessellation into a sandpile graph: neighbours, exits, thresholds.
export function buildGraph(t) {
  const { W, H, lab, mask, seeds } = t;
  const cellOf = new Int32Array(seeds.length).fill(-1);
  const slotOf = [];
  for (let s = 0; s < seeds.length; s++) {
    if (!seeds[s]) continue;
    const p = t.pixel(seeds[s].x, seeds[s].y);
    if (p >= 0 && lab[p] === s) { cellOf[s] = slotOf.length; slotOf.push(s); }
  }
  const n = slotOf.length;
  const area = new Float64Array(n), cx = new Float64Array(n), cy = new Float64Array(n);
  const edgeC = new Int32Array(n), crackC = new Int32Array(n);
  const border = new Uint8Array(W * H);
  const pairs = new Map();
  const contact = (c, q) => {
    const m = q < 0 ? OUT : mask[q];
    if (m === OUT) edgeC[c]++;
    else if (m === CRACK) crackC[c]++;
  };
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const p = y * W + x;
      const a = lab[p];
      if (a < 0) continue;
      const ca = cellOf[a];
      if (ca < 0) continue;
      area[ca]++; cx[ca] += x + 0.5; cy[ca] += y + 0.5;
      for (let k = 0; k < 4; k++) {
        const nx = x + (k === 0 ? 1 : k === 1 ? -1 : 0);
        const ny = y + (k === 2 ? 1 : k === 3 ? -1 : 0);
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) { contact(ca, -1); border[p] = 1; continue; }
        const q = ny * W + nx;
        const b = lab[q];
        if (b === a) continue;
        border[p] = 1;
        if (b >= 0 && cellOf[b] >= 0) {
          if (k === 0 || k === 2) {
            const cb = cellOf[b];
            const key = ca < cb ? ca * 65536 + cb : cb * 65536 + ca;
            pairs.set(key, (pairs.get(key) || 0) + 1);
          }
        } else contact(ca, q);
      }
    }
  }
  const lists = Array.from({ length: n }, () => []);
  for (const [key, cnt] of pairs) {
    if (cnt < MIN_SHARED) continue;
    const a = Math.floor(key / 65536), b = key % 65536;
    lists[a].push([b, cnt]);
    lists[b].push([a, cnt]);
  }
  const nbrStart = new Int32Array(n + 1);
  for (let c = 0; c < n; c++) nbrStart[c + 1] = nbrStart[c] + lists[c].length;
  const nbr = new Int32Array(nbrStart[n]);
  const shared = new Float64Array(nbrStart[n]);
  const exE = new Int32Array(n), exC = new Int32Array(n), thr = new Int32Array(n);
  for (let c = 0; c < n; c++) {
    let tot = 0;
    lists[c].forEach(([b, cnt], k) => { nbr[nbrStart[c] + k] = b; shared[nbrStart[c] + k] = cnt; tot += cnt; });
    // a long stretch of edge counts as several missing neighbours
    const avg = lists[c].length ? tot / lists[c].length : 8;
    exE[c] = edgeC[c] >= MIN_SHARED ? Math.max(1, Math.round(edgeC[c] / avg)) : 0;
    exC[c] = crackC[c] >= MIN_SHARED ? Math.max(1, Math.round(crackC[c] / avg)) : 0;
    thr[c] = lists[c].length + exE[c] + exC[c];
    if (area[c] > 0) { cx[c] /= area[c]; cy[c] /= area[c]; }
  }
  // every cell must have a way out; a sealed cell (only possible in odd
  // corners) is given one so sand never piles up forever
  const ok = new Uint8Array(n);
  const stack = [];
  for (let c = 0; c < n; c++) if (exE[c] + exC[c] > 0) { ok[c] = 1; stack.push(c); }
  while (stack.length) {
    const c = stack.pop();
    for (let k = nbrStart[c]; k < nbrStart[c + 1]; k++) if (!ok[nbr[k]]) { ok[nbr[k]] = 1; stack.push(nbr[k]); }
  }
  for (let c = 0; c < n; c++) if (!ok[c]) { exE[c]++; thr[c]++; }
  return { n, slotOf, cellOf, area, cx, cy, nbrStart, nbr, shared, exE, exC, thr, border };
}

// Cell index under pixel p, or -1.
export function cellAtPixel(t, g, p) {
  if (p < 0) return -1;
  const s = t.lab[p];
  return s >= 0 ? g.cellOf[s] : -1;
}
