// Seeded generation of one region. The ground is a patchwork of zones, each
// scattering its Voronoi seeds by a different recipe (basalt columns,
// mudflats, dunes, boulder fields, terraces); some regions have a river
// channel walled in by rock. Rock outcrops and ridges are walls, cracks are
// holes, and things are buried at depth.
import { FREE, ROCK, CRACK, OUT } from './voronoi.js';

export function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

// hard: how much stress a cell takes before it cracks; tint: colour shift
export const RECIPES = {
  mud: { name: 'Mudflats', desc: 'Cracked ground: cells of every size. Cracks easily.', hard: 0.7, tint: [12, 2, -10] },
  basalt: { name: 'Basalt', desc: 'Columns of even, near-hexagonal cells. Hard to crack.', hard: 1.4, tint: [-16, -12, -4] },
  dunes: { name: 'Dunes', desc: 'Long cells stretched by the wind.', hard: 0.9, tint: [18, 12, 0] },
  boulders: { name: 'Boulder field', desc: 'A few huge cells among fine gravel.', hard: 1.0, tint: [8, -8, -12] },
  terraces: { name: 'Terraces', desc: 'Bands of fine cells between bands of coarse ones.', hard: 1.0, tint: [-6, 6, -8] },
  river: { name: 'River', desc: 'A channel walled in by rock, running to the edge.', hard: 0.8, tint: [-10, 0, 14] },
};
export const RECIPE_IDS = ['mud', 'basalt', 'dunes', 'boulders', 'terraces'];

// A wobbly closed curve: radius as a function of angle.
function wobble(R, base, amp, terms = 4) {
  const ph = [], fr = [], am = [];
  for (let k = 0; k < terms; k++) { ph.push(R() * Math.PI * 2); fr.push(2 + k + Math.floor(R() * 2)); am.push(amp * (0.5 + R()) / (k + 1)); }
  return (a) => {
    let r = 1;
    for (let k = 0; k < terms; k++) r += am[k] * Math.sin(fr[k] * a + ph[k]);
    return base * r;
  };
}

export const BURIED_KINDS = {
  relic: { name: 'Relic', hint: 'Something glints under the sand.' },
  spring: { name: 'Spring', hint: 'The sand here is damp.' },
  ore: { name: 'Ore vein', hint: 'Purple grit is washing up here.' },
  cave: { name: 'Hollow', hint: 'The ground here sounds hollow.' },
};

export const RELICS = [
  { id: 'lens', name: 'Cracked Lens', desc: 'Every topple is worth twice as much.', fx: { value: 2 } },
  { id: 'trowel', name: 'Brass Trowel', desc: 'Sand wears the ground away twice as fast.', fx: { erode: 2 } },
  { id: 'shell', name: 'Spiral Shell', desc: 'Spouts pour twice as fast.', fx: { rate: 2 } },
  { id: 'coin', name: 'Old Coin', desc: 'Every topple is worth three times as much.', fx: { value: 3 } },
  { id: 'map', name: 'Folded Map', desc: 'Shows where everything is buried.', fx: { reveal: 1 } },
];

/**
 * @param {number} seed
 * @param {number} W raster size
 * @param {string|null} only force every zone to one recipe (sandbox)
 */
export function generateRegion(seed, W, only = null) {
  const R = mulberry32(seed >>> 0);
  const H = W;
  const n = W * H;
  const mask = new Uint8Array(n).fill(OUT);
  const ore = new Uint8Array(n);
  const river = new Uint8Array(n);
  const C = W / 2;
  const at = (x, y) => (x >= 0 && y >= 0 && x < W && y < H ? y * W + x : -1);

  // outline
  const outline = wobble(R, W * 0.44, 0.08, 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const dx = x + 0.5 - C, dy = y + 0.5 - C;
    if (Math.hypot(dx, dy) < outline(Math.atan2(dy, dx))) mask[y * W + x] = FREE;
  }
  const isFree = (x, y) => { const p = at(Math.floor(x), Math.floor(y)); return p >= 0 && mask[p] === FREE && !river[p]; };
  const randomFree = (rMin, rMax) => {
    for (let k = 0; k < 500; k++) {
      const a = R() * Math.PI * 2, r = rMin + R() * (rMax - rMin);
      const x = C + Math.cos(a) * r, y = C + Math.sin(a) * r;
      if (isFree(x, y)) return [x, y];
    }
    return [C, C];
  };
  const disc = (x0, y0, rad, fn) => {
    for (let y = Math.floor(y0 - rad); y <= y0 + rad; y++) for (let x = Math.floor(x0 - rad); x <= x0 + rad; x++) {
      const p = at(x, y);
      if (p >= 0 && Math.hypot(x + 0.5 - x0, y + 0.5 - y0) <= rad) fn(p);
    }
  };
  const blob = (x0, y0, base, fn) => {
    const f = wobble(R, base, 0.25, 3);
    const rad = base * 1.6;
    for (let y = Math.floor(y0 - rad); y <= y0 + rad; y++) for (let x = Math.floor(x0 - rad); x <= x0 + rad; x++) {
      const p = at(x, y);
      if (p < 0) continue;
      const dx = x + 0.5 - x0, dy = y + 0.5 - y0;
      if (Math.hypot(dx, dy) <= f(Math.atan2(dy, dx))) fn(p);
    }
  };
  const walk = (x0, y0, steps, len, turn, width, fn, heading = R() * Math.PI * 2) => {
    let x = x0, y = y0, a = heading;
    for (let s = 0; s < steps * len; s++) {
      if (s % len === 0) a += (R() - 0.5) * turn;
      x += Math.cos(a); y += Math.sin(a);
      disc(x, y, width / 2, fn);
    }
  };
  const setIfFree = (v) => (p) => { if (mask[p] === FREE && !river[p]) mask[p] = v; };

  // ---- a river: a channel walled in by rock, running from inland out over the edge
  const seeds = [];
  if (!only && R() < 0.7) {
    const a0 = R() * Math.PI * 2;
    let x = C + Math.cos(a0) * W * 0.13, y = C + Math.sin(a0) * W * 0.13, a = a0;
    const path = [];
    for (let s = 0; s < 600; s++) {
      path.push([x, y]);
      const p = at(Math.floor(x), Math.floor(y));
      if (p < 0 || mask[p] === OUT) break;
      a += (R() - 0.5) * 0.25 + 0.04 * Math.sin(s / 17);
      x += Math.cos(a); y += Math.sin(a);
    }
    // banks first (but not at the source, so sand can get in), then the bed
    path.forEach(([px, py], i) => { if (i > 6) disc(px, py, 7, (p) => { if (mask[p] === FREE) mask[p] = ROCK; }); });
    path.forEach(([px, py]) => disc(px, py, 3.5, (p) => { if (mask[p] !== OUT) { mask[p] = FREE; river[p] = 1; } }));
    for (let i = 0; i < path.length; i += 8) {
      const [px, py] = path[i];
      if (mask[at(Math.floor(px), Math.floor(py))] === FREE) seeds.push({ x: px, y: py, z: 'river' });
    }
  }

  // ---- rock and cracks
  const outcrops = 2 + Math.floor(R() * 3);
  for (let k = 0; k < outcrops; k++) { const [x, y] = randomFree(W * 0.14, W * 0.38); blob(x, y, 6 + R() * 10, setIfFree(ROCK)); }
  const ridges = 1 + Math.floor(R() * 2);
  for (let k = 0; k < ridges; k++) { const [x, y] = randomFree(W * 0.12, W * 0.35); walk(x, y, 5 + Math.floor(R() * 4), 8, 1.1, 3 + R() * 2, setIfFree(ROCK)); }
  const cracks = 1 + Math.floor(R() * 2);
  for (let k = 0; k < cracks; k++) { const [x, y] = randomFree(W * 0.18, W * 0.38); walk(x, y, 4 + Math.floor(R() * 3), 6, 1.6, 2, setIfFree(CRACK)); }
  // keep the middle open: it is where the first spout goes
  disc(C, C, W * 0.07, (p) => { if (mask[p] !== OUT && !river[p]) mask[p] = FREE; });

  // anything sealed off from the middle becomes rock
  const seen = new Uint8Array(n);
  const stack = [at(Math.floor(C), Math.floor(C))];
  seen[stack[0]] = 1;
  while (stack.length) {
    const p = stack.pop();
    const x = p % W, y = (p / W) | 0;
    for (const q of [at(x + 1, y), at(x - 1, y), at(x, y + 1), at(x, y - 1)]) {
      if (q >= 0 && !seen[q] && mask[q] === FREE) { seen[q] = 1; stack.push(q); }
    }
  }
  for (let p = 0; p < n; p++) if (mask[p] === FREE && !seen[p]) { mask[p] = ROCK; river[p] = 0; }
  for (let i = seeds.length - 1; i >= 0; i--) if (mask[at(Math.floor(seeds[i].x), Math.floor(seeds[i].y))] !== FREE) seeds.splice(i, 1);

  // ---- zones: a patchwork of recipes with organic borders
  const nz = only ? 1 : 3 + Math.floor(R() * 3);
  const zones = [];
  const ids = RECIPE_IDS.slice();
  for (let k = 0; k < nz; k++) {
    const [x, y] = k === 0 ? [C + (R() - 0.5) * 20, C + (R() - 0.5) * 20] : randomFree(W * 0.18, W * 0.4);
    const recipe = only || ids.splice(Math.floor(R() * ids.length), 1)[0] || RECIPE_IDS[Math.floor(R() * RECIPE_IDS.length)];
    zones.push({ x, y, recipe, a: R() * Math.PI });
  }
  const zone = new Uint8Array(n);
  const wf = [R() * 6, R() * 6, R() * 6, R() * 6];
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const wx = x + 14 * Math.sin(y / 23 + wf[0]) + 7 * Math.sin(y / 9 + wf[1]);
    const wy = y + 14 * Math.sin(x / 21 + wf[2]) + 7 * Math.sin(x / 11 + wf[3]);
    let best = 0, bd = Infinity;
    zones.forEach((z, k) => { const d = (z.x - wx) ** 2 + (z.y - wy) ** 2; if (d < bd) { bd = d; best = k; } });
    zone[y * W + x] = best;
  }

  // ---- seeds, recipe by recipe
  const MIN = 6;
  const near = (x, y, r) => seeds.some(s => (s.x - x) ** 2 + (s.y - y) ** 2 < r * r);
  const tryAdd = (zi, sd, gap = MIN) => {
    const p = at(Math.floor(sd.x), Math.floor(sd.y));
    if (p < 0 || mask[p] !== FREE || river[p] || zone[p] !== zi) return false;
    if (near(sd.x, sd.y, gap)) return false;
    seeds.push(sd);
    return true;
  };
  const lattice = (zi, a, dx, dy, shift, jitter, make) => {
    const ca = Math.cos(a), sa = Math.sin(a);
    const span = W;
    for (let j = -span / dy; j <= span / dy; j++) {
      for (let i = -span / dx; i <= span / dx; i++) {
        let u = i * dx + (j % 2 ? shift : 0), v = j * dy;
        u += (R() - 0.5) * jitter; v += (R() - 0.5) * jitter;
        const x = C + u * ca - v * sa, y = C + u * sa + v * ca;
        if (x < 0 || y < 0 || x >= W || y >= H) continue;
        tryAdd(zi, make(x, y, j));
      }
    }
  };
  zones.forEach((z, zi) => {
    const r = z.recipe;
    if (r === 'basalt') lattice(zi, z.a, 22, 19, 11, 2, (x, y) => ({ x, y, z: r }));
    else if (r === 'dunes') lattice(zi, z.a, 34, 13, 17, 4, (x, y) => ({ x, y, z: r, k: 2, a: z.a }));
    else if (r === 'terraces') {
      // rows across the slope: alternately fine and coarse
      const ca = Math.cos(z.a), sa = Math.sin(z.a);
      let v = -W;
      let fine = true;
      while (v < W) {
        const step = fine ? 11 : 30, along = fine ? 14 : 30;
        for (let u = -W; u < W; u += along) {
          const uu = u + (R() - 0.5) * 4;
          tryAdd(zi, { x: C + uu * ca - v * sa, y: C + uu * sa + v * ca, z: r });
        }
        v += step;
        fine = !fine;
      }
    } else if (r === 'boulders') {
      for (let k = 0; k < 400; k++) {
        const x = R() * W, y = R() * H;
        if (zone[at(Math.floor(x), Math.floor(y))] === zi && !near(x, y, 70)) tryAdd(zi, { x, y, z: r, w: 2.6, boulder: true }, 30);
      }
      const boulders = seeds.filter(q => q.boulder);
      for (let k = 0; k < 3000; k++) {
        const x = R() * W, y = R() * H;
        if (boulders.some(b => (b.x - x) ** 2 + (b.y - y) ** 2 < 32 * 32)) continue;
        tryAdd(zi, { x, y, z: r }, 15);
      }
    } else {
      // mudflats: dart throwing with a spacing that varies across the ground
      const ph = R() * 6;
      for (let k = 0; k < 4000; k++) {
        const x = R() * W, y = R() * H;
        const sp = 13 + 16 * (0.5 + 0.5 * Math.sin(x / 31 + ph) * Math.cos(y / 27 - ph));
        tryAdd(zi, { x, y, z: r }, sp);
      }
    }
  });
  // every free pocket gets at least one seed
  for (let k = 0; k < 2000; k++) {
    const x = R() * W, y = R() * H;
    const p = at(Math.floor(x), Math.floor(y));
    if (p >= 0 && mask[p] === FREE && !near(x, y, 24)) seeds.push({ x, y, z: river[p] ? 'river' : zones[zone[p]].recipe });
  }

  // ---- surface ore
  const veins = 2 + Math.floor(R() * 2);
  for (let k = 0; k < veins; k++) { const [x, y] = randomFree(W * 0.12, W * 0.36); blob(x, y, 5 + R() * 6, (p) => { if (mask[p] === FREE) ore[p] = 1; }); }

  // ---- buried things: deeper further out
  const buried = [];
  const bury = (kind, rMin, rMax, depth, extra = {}) => {
    for (let k = 0; k < 200; k++) {
      const [x, y] = randomFree(rMin, rMax);
      const p = at(Math.floor(x), Math.floor(y));
      if (mask[p] !== FREE) continue;
      if (buried.some(b => Math.hypot(b.x - x, b.y - y) < W * 0.1)) continue;
      buried.push({ kind, x, y, depth, r: extra.r || 0, relic: extra.relic });
      return;
    }
  };
  bury('relic', W * 0.05, W * 0.14, 2.5, { relic: RELICS[0].id });
  bury('relic', W * 0.14, W * 0.26, 4, { relic: RELICS[1].id });
  bury('relic', W * 0.2, W * 0.34, 6, { relic: RELICS[2].id });
  bury('relic', W * 0.26, W * 0.4, 9, { relic: RELICS[3].id });
  bury('relic', W * 0.2, W * 0.4, 7, { relic: RELICS[4].id });
  bury('spring', W * 0.14, W * 0.3, 4.5);
  bury('spring', W * 0.24, W * 0.4, 8);
  bury('ore', W * 0.1, W * 0.3, 3, { r: 9 });
  bury('ore', W * 0.2, W * 0.4, 6, { r: 11 });
  bury('cave', W * 0.12, W * 0.32, 5, { r: 7 });

  return { W, H, mask, ore, river, zone, zones, seeds, buried, spout: [C + 0.5, C + 0.5] };
}
