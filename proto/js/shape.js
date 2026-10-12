// Shaping the land: a target density field (the ground's own, deepened by
// wells), a stretch field (the comb), and relaxation of the cells towards
// them. Shared by the prototypes.
import { FREE } from './voronoi.js';
import { COMB } from './region.js';

// Target density: the ground's own, deepened around each well.
// Wells are { x, y, pull, r }.
export function computeRho(rho0, wells, W, out = new Float32Array(rho0.length)) {
  out.set(rho0);
  for (const w of wells) {
    if (!(w.pull > 0)) continue;
    const rad = w.r, R3 = rad * 3, R2 = R3 * R3;
    const x0 = Math.max(0, Math.floor(w.x - R3)), x1 = Math.min(W - 1, Math.ceil(w.x + R3));
    const y0 = Math.max(0, Math.floor(w.y - R3)), y1 = Math.min(W - 1, Math.ceil(w.y + R3));
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const d2 = (x + 0.5 - w.x) ** 2 + (y + 0.5 - w.y) ** 2;
      if (d2 > R2) continue;
      out[y * W + x] *= 1 + w.pull * Math.exp(-d2 / (rad * rad));
    }
  }
  return out;
}

// Each seed takes the stretch of the comb field where it stands.
export function applyComb(seeds, comb, W) {
  for (const sd of seeds) {
    if (!sd || sd.pin) continue;
    const gx = Math.min(COMB - 1, Math.max(0, Math.floor(sd.x / W * COMB))), gy = Math.min(COMB - 1, Math.max(0, Math.floor(sd.y / W * COMB)));
    const k = (gy * COMB + gx) * 2;
    const a = comb[k], b = comb[k + 1];
    sd.k = 1 + Math.min(1.6, Math.hypot(a, b));
    sd.a = 0.5 * Math.atan2(b, a);
    sd._c = undefined;
  }
}

/**
 * One relaxation step. Every free seed moves most of the way to the
 * density-weighted middle of its cell (weighting by density squared makes
 * cell areas shrink in proportion to density). Lloyd alone only shuffles cells
 * between neighbours, so the land also balances mass: the lightest cells are
 * swallowed and reappear inside the heaviest, which is how a well draws cells
 * in from around it.
 * @returns {{ moved: number, teleported: Set<number> }} the largest move and
 *   the slots of seeds that jumped (their cells did not move, they vanished)
 */
export function relaxStep(t, rho, mask, rng, opts = {}) {
  const step = opts.step || 0.9, range = opts.range || Infinity, avoid = opts.avoid || null;
  const donor = opts.donor || null;          // (lo, hi) => may cell lo be swallowed to split cell hi?
  const perStep = opts.perStep ?? 1 / 30;    // the most cells swallowed per step, as a share of all
  const lab = t.lab, W = t.W;
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
    let st = sd._st === undefined ? step : sd._st;
    const mx = tx - sd.x, my = ty - sd.y;
    if (sd._mx !== undefined && mx * sd._mx + my * sd._my < 0) st *= 0.5;
    else st = Math.min(step, st * 1.25);
    sd._st = st; sd._mx = mx; sd._my = my;
    const nx = sd.x + st * mx, ny = sd.y + st * my;
    const p = t.pixel(nx, ny);
    if (p < 0 || mask[p] !== FREE) continue;
    const d = Math.hypot(nx - sd.x, ny - sd.y);
    if (d > moved) moved = d;
    sd.x = nx; sd.y = ny;
  }
  const teleported = new Set();
  if (free.length > 8 && perStep > 0) {
    let tot = 0;
    for (const s of free) tot += mass[s];
    const mean = tot / free.length;
    const byMass = free.slice().sort((a, b) => mass[a] - mass[b]);
    const most = Math.max(1, Math.round(free.length * perStep));
    const used = new Set();
    let done = 0;
    for (let i = byMass.length - 1; i >= 0 && done < most; i--) {
      const hi = byMass[i];
      if (!(mass[hi] > 1.5 * mean)) break;
      const sh = t.seeds[hi];
      // the lightest cell within range of the heavy one
      let lo = -1;
      for (const s of byMass) {
        if (mass[s] >= 0.8 * mean) break;
        if (used.has(s) || s === hi) continue;
        if (donor && !donor(s, hi)) continue;
        const q = t.seeds[s];
        if ((q.x - sh.x) ** 2 + (q.y - sh.y) ** 2 > range * range) continue;
        lo = s;
        break;
      }
      if (lo < 0 || !(mass[hi] > 2.2 * mass[lo])) continue;
      const cx = sx[hi] / sw[hi], cy = sy[hi] / sw[hi];
      let ax = cx - sh.x, ay = cy - sh.y;
      const al = Math.hypot(ax, ay);
      if (al < 0.5) { const a = rng() * Math.PI * 2; ax = Math.cos(a); ay = Math.sin(a); } else { ax /= al; ay /= al; }
      const rr = Math.sqrt(mass[hi] / Math.max(1e-9, sw[hi] / mass[hi])) * 0.35 + 1;
      const nx = cx + ax * rr, ny = cy + ay * rr;
      const p = t.pixel(nx, ny);
      if (p < 0 || mask[p] !== FREE || (avoid && avoid[p])) continue;
      const sl = t.seeds[lo];
      sl.x = nx; sl.y = ny;
      sl._st = sl._mx = sl._my = undefined;
      used.add(lo); used.add(hi);
      teleported.add(lo);
      moved = Math.max(moved, 1);
      done++;
    }
  }
  return { moved, teleported };
}

// Reset every seed's step size (after the target shape changes).
export function wakeSeeds(seeds) {
  for (const sd of seeds) if (sd) sd._st = sd._mx = sd._my = undefined;
}
