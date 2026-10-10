// The sandpile on an arbitrary graph. A cell topples when it holds as many
// grains as it has ways out (neighbours plus exits), sending one grain each
// way; grains sent through an exit are gone.
export class Pile {
  constructor(g) {
    this.g = g;
    this.grains = new Float64Array(g.n);
    this.flash = new Float32Array(g.n);
    this.K = new Float64Array(g.n);
    this.act = new Int32Array(g.n);
  }

  // Start close to the critical state, so avalanches begin straight away.
  fill(rng) {
    const { thr } = this.g;
    for (let c = 0; c < this.g.n; c++) this.grains[c] = Math.max(0, thr[c] - 1 - (rng() < 0.45 ? 1 : 0));
  }

  // Carry grains over from another pile through a cell mapping.
  inherit(old, map) {
    const { thr } = this.g;
    for (let c = 0; c < this.g.n; c++) {
      const o = map[c];
      this.grains[c] = o >= 0 && o < old.grains.length ? Math.min(old.grains[o], thr[c] - 1) : Math.max(0, thr[c] - 2);
    }
  }

  // One synchronous round. Returns {topples, value, wave, toppled[]}.
  round(val, odo) {
    const { n, thr, nbrStart, nbr } = this.g;
    const g = this.grains, K = this.K, act = this.act;
    let m = 0;
    for (let c = 0; c < n; c++) {
      if (g[c] >= thr[c] && thr[c] > 0) { K[c] = Math.floor(g[c] / thr[c]); act[m++] = c; }
    }
    let topples = 0, value = 0;
    for (let j = 0; j < m; j++) {
      const c = act[j], k = K[c];
      g[c] -= k * thr[c];
      for (let e = nbrStart[c]; e < nbrStart[c + 1]; e++) g[nbr[e]] += k;
      topples += k;
      value += k * val[c];
      if (odo) odo[c] += k;
      this.flash[c] = 1;
    }
    return { topples, value, wave: m };
  }
}

// Solve L x = rhs for the graph Laplacian L = diag(thr) - adjacency.
// x is the expected number of topples at each cell (rhs = grains dropped per
// cell), or, since L is symmetric, the value of a grain dropped at each cell
// (rhs = value of a topple at each cell).
export function solve(g, rhs, prev = null, tol = 1e-9) {
  const { n, thr, nbrStart, nbr } = g;
  for (let om = 1.8; ; om = 1) {
    const x = prev && prev.length === n ? Float64Array.from(prev) : new Float64Array(n);
    let minMd = Infinity, diverged = false;
    for (let it = 0; it < 20000; it++) {
      let md = 0, mx = 1e-300;
      for (let c = 0; c < n; c++) {
        if (thr[c] <= 0) { x[c] = 0; continue; }
        let s = rhs[c];
        for (let e = nbrStart[c]; e < nbrStart[c + 1]; e++) s += x[nbr[e]];
        const d = s / thr[c] - x[c];
        x[c] += om * d;
        if (x[c] < 0) x[c] = 0;
        const ad = d < 0 ? -d : d;
        if (ad > md) md = ad;
        if (x[c] > mx) mx = x[c];
      }
      if (md <= mx * tol) break;
      if (md < minMd) minMd = md;
      else if (om > 1 && (md > minMd * 1e4 || !(md < Infinity))) { diverged = true; break; }
    }
    if (!diverged || om <= 1) return x;
  }
}
