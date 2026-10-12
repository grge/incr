// A skirmish map: the same on both sides (point-symmetric about the middle),
// with each player's home spout at one end of the long axis, neutral spouts
// between them, rock and cracks, and a patchwork of ground recipes expressed
// as density and stretch fields.
import { FREE, ROCK, CRACK, OUT } from '../../js/voronoi.js';
import { mulberry32, COMB } from '../../js/region.js';

export const MAP_RECIPES = ['mud', 'basalt', 'dunes', 'boulders', 'terraces'];

export function generateMap(seed, W = 320) {
  const R = mulberry32(seed >>> 0);
  const n = W * W;
  const C = W / 2;
  const mask = new Uint8Array(n).fill(OUT);
  const at = (x, y) => (x >= 0 && y >= 0 && x < W && y < W ? y * W + x : -1);
  const mirror = (p) => n - 1 - p;
  const sym = (fn) => (p) => { fn(p); fn(mirror(p)); };

  // outline: longer along the axis between the two homes; only even
  // harmonics, so it is the same after a half turn
  const axis = R() * Math.PI;
  const harm = [4, 6].map(f => ({ f, a: (0.02 + R() * 0.03), ph: R() * Math.PI * 2 }));
  const radius = (a) => {
    let r = 1 + 0.12 * Math.cos(2 * (a - axis));
    for (const h of harm) r += h.a * Math.sin(h.f * a + h.ph);
    return W * 0.4 * r;
  };
  for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) {
    const dx = x + 0.5 - C, dy = y + 0.5 - C;
    if (Math.hypot(dx, dy) < radius(Math.atan2(dy, dx))) mask[y * W + x] = FREE;
  }
  const ux = Math.cos(axis), uy = Math.sin(axis);   // along the axis
  const vx = -uy, vy = ux;                           // across it
  const pos = (u, v) => [C + ux * u + vx * v, C + uy * u + vy * v];

  // spouts: homes at the ends, three neutral pairs between
  const L = W * 0.4 * 1.12;
  const spouts = [];
  const pair = (u, v, home = false) => {
    const [x, y] = pos(u, v);
    spouts.push({ x, y, home: home ? 0 : null });
    spouts.push({ x: W - x, y: W - y, home: home ? 1 : null });
  };
  pair(-L * 0.72, (R() - 0.5) * W * 0.06, true);
  pair(-L * 0.3, (0.5 + R() * 0.12) * W * 0.4 * (R() < 0.5 ? 1 : -1));
  pair(-L * 0.06, -(0.45 + R() * 0.15) * W * 0.4);
  pair(-L * 0.45, (R() < 0.5 ? 1 : -1) * (0.15 + R() * 0.2) * W * 0.4);
  const nearSpout = (x, y, d) => spouts.some(s => Math.hypot(s.x - x, s.y - y) < d);

  const disc = (x0, y0, rad, fn) => {
    for (let y = Math.floor(y0 - rad); y <= y0 + rad; y++) for (let x = Math.floor(x0 - rad); x <= x0 + rad; x++) {
      const p = at(x, y);
      if (p >= 0 && Math.hypot(x + 0.5 - x0, y + 0.5 - y0) <= rad) fn(p);
    }
  };
  const blob = (x0, y0, base, fn) => {
    const ph = [R() * 6, R() * 6, R() * 6], fr = [2, 3, 5];
    const f = (a) => base * (1 + 0.25 * Math.sin(fr[0] * a + ph[0]) + 0.15 * Math.sin(fr[1] * a + ph[1]) + 0.1 * Math.sin(fr[2] * a + ph[2]));
    const rad = base * 1.6;
    for (let y = Math.floor(y0 - rad); y <= y0 + rad; y++) for (let x = Math.floor(x0 - rad); x <= x0 + rad; x++) {
      const p = at(x, y);
      if (p < 0) continue;
      const dx = x + 0.5 - x0, dy = y + 0.5 - y0;
      if (Math.hypot(dx, dy) <= f(Math.atan2(dy, dx))) fn(p);
    }
  };
  const walk = (x0, y0, steps, len, turn, width, fn) => {
    let x = x0, y = y0, a = R() * Math.PI * 2;
    for (let s = 0; s < steps * len; s++) {
      if (s % len === 0) a += (R() - 0.5) * turn;
      x += Math.cos(a); y += Math.sin(a);
      disc(x, y, width / 2, fn);
    }
  };
  const setIfFree = (v) => sym((p) => { if (mask[p] === FREE) mask[p] = v; });
  const randomSpot = (minFromSpout) => {
    for (let k = 0; k < 400; k++) {
      const x = C + (R() - 0.5) * W * 0.8, y = C + (R() - 0.5) * W * 0.8;
      const p = at(Math.floor(x), Math.floor(y));
      if (p < 0 || mask[p] !== FREE || nearSpout(x, y, minFromSpout)) continue;
      return [x, y];
    }
    return null;
  };

  // rock outcrops and ridges are walls; cracks are holes
  const outcrops = 2 + Math.floor(R() * 2);
  for (let k = 0; k < outcrops; k++) { const q = randomSpot(34); if (q) blob(q[0], q[1], 6 + R() * 8, setIfFree(ROCK)); }
  const ridges = 1 + Math.floor(R() * 2);
  for (let k = 0; k < ridges; k++) { const q = randomSpot(30); if (q) walk(q[0], q[1], 4 + Math.floor(R() * 3), 8, 1.1, 3 + R() * 2, setIfFree(ROCK)); }
  const cracks = 1 + Math.floor(R() * 2);
  for (let k = 0; k < cracks; k++) { const q = randomSpot(36); if (q) walk(q[0], q[1], 3 + Math.floor(R() * 3), 6, 1.6, 2, setIfFree(CRACK)); }
  // spouts stand on open ground
  for (const s of spouts) disc(s.x, s.y, 10, (p) => { if (mask[p] !== OUT) mask[p] = FREE; });

  // anything sealed off from the homes becomes rock
  const seen = new Uint8Array(n);
  const start = at(Math.floor(spouts[0].x), Math.floor(spouts[0].y));
  const stack = [start];
  seen[start] = 1;
  while (stack.length) {
    const p = stack.pop();
    const x = p % W, y = (p / W) | 0;
    for (const q of [at(x + 1, y), at(x - 1, y), at(x, y + 1), at(x, y - 1)]) {
      if (q >= 0 && !seen[q] && mask[q] === FREE) { seen[q] = 1; stack.push(q); }
    }
  }
  // every spout must be reachable; otherwise try another layout
  if (spouts.some(sp => !seen[at(Math.floor(sp.x), Math.floor(sp.y))])) return generateMap(seed + 7919, W);
  for (let p = 0; p < n; p++) if (mask[p] === FREE && !seen[p]) mask[p] = ROCK;

  // ground recipes: zones on one half, mirrored onto the other
  const nz = 2 + Math.floor(R() * 2);
  const zones = [];
  const pool = MAP_RECIPES.slice();
  for (let k = 0; k < nz; k++) {
    const u = (R() - 0.5) * L * 1.4, v = (R() - 0.5) * W * 0.6;
    const [x, y] = pos(-Math.abs(u) - 8, v);
    const recipe = pool.splice(Math.floor(R() * pool.length), 1)[0];
    const z = { x, y, recipe, a: R() * Math.PI, ph: R() * 6, ph2: R() * 6 };
    zones.push(z);
  }
  const half = zones.length;
  for (let k = 0; k < half; k++) { const z = zones[k]; zones.push(Object.assign({}, z, { x: W - z.x, y: W - z.y })); }
  const zone = new Uint8Array(n);
  const wf = [R() * 6, R() * 6, R() * 6, R() * 6];
  for (let p = 0; p < n / 2; p++) {
    const x = p % W, y = (p / W) | 0;
    const wx = x + 12 * Math.sin(y / 23 + wf[0]) + 6 * Math.sin(y / 9 + wf[1]);
    const wy = y + 12 * Math.sin(x / 21 + wf[2]) + 6 * Math.sin(x / 11 + wf[3]);
    let best = 0, bd = Infinity;
    zones.forEach((z, k) => { const d = (z.x - wx) ** 2 + (z.y - wy) ** 2; if (d < bd) { bd = d; best = k; } });
    zone[p] = best;
    zone[mirror(p)] = best < half ? best + half : best - half;
  }

  // density and stretch fields
  const rho0 = new Float32Array(n).fill(1);
  const comb = new Float32Array(COMB * COMB * 2);
  const seeds = [];
  const boulders = [];
  zones.forEach((z, zi) => {
    if (z.recipe !== 'boulders' || zi >= half) return;
    for (let k = 0; k < 300 && boulders.length < 6; k++) {
      const x = R() * W, y = R() * W;
      const p = at(Math.floor(x), Math.floor(y));
      if (p < 0 || zone[p] !== zi || mask[p] !== FREE || nearSpout(x, y, 30)) continue;
      if (Math.hypot(x - C, y - C) < 18) continue;
      if (boulders.some(b => Math.hypot(b[0] - x, b[1] - y) < 40 || Math.hypot(W - b[0] - x, W - b[1] - y) < 40)) continue;
      boulders.push([x, y, 11 + R() * 7]);
    }
  });
  for (const [bx, by, br] of boulders) {
    seeds.push({ x: bx, y: by, z: 'boulder', w: 1 + br / 12, pin: true });
    seeds.push({ x: W - bx, y: W - by, z: 'boulder', w: 1 + br / 12, pin: true });
  }
  const allBoulders = boulders.flatMap(([x, y, r]) => [[x, y, r], [W - x, W - y, r]]);
  for (let p = 0; p < n / 2; p++) {
    const x = p % W, y = (p / W) | 0;
    const z = zones[zone[p]];
    let r = 1;
    if (z.recipe === 'mud') r = 0.5 + 1.0 * (0.5 + 0.5 * Math.sin(x / 21 + z.ph) * Math.cos(y / 17 + z.ph2));
    else if (z.recipe === 'terraces') r = Math.sin((-x * Math.sin(z.a) + y * Math.cos(z.a)) / 15 + z.ph) > 0 ? 1.9 : 0.6;
    else if (z.recipe === 'boulders') {
      r = 1.3;
      for (const [bx, by, br] of allBoulders) if ((bx - x) ** 2 + (by - y) ** 2 < br * br) { r = 0.06; break; }
    }
    rho0[p] = r;
    rho0[mirror(p)] = r;
  }
  for (let gy = 0; gy < COMB; gy++) for (let gx = 0; gx < COMB; gx++) {
    const x = Math.min(W - 1, Math.floor((gx + 0.5) * W / COMB)), y = Math.min(W - 1, Math.floor((gy + 0.5) * W / COMB));
    const z = zones[zone[y * W + x]];
    if (z.recipe !== 'dunes') continue;
    const k = (gy * COMB + gx) * 2;
    comb[k] = Math.cos(2 * z.a) * 1.0;
    comb[k + 1] = Math.sin(2 * z.a) * 1.0;
  }

  return { W, mask, rho0, comb, seeds, spouts, zones, zone, axis };
}
