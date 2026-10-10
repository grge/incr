// Seeded generation of one region: an organic outline, rock outcrops and
// ridges (walls), cracks (holes), surface ore, and things buried at depth.
import { FREE, ROCK, CRACK, OUT } from './voronoi.js';

export function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

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

export function generateRegion(seed, W) {
  const R = mulberry32(seed >>> 0);
  const H = W;
  const n = W * H;
  const mask = new Uint8Array(n).fill(OUT);
  const ore = new Uint8Array(n);
  const C = W / 2;
  const at = (x, y) => (x >= 0 && y >= 0 && x < W && y < H ? y * W + x : -1);

  // outline
  const outline = wobble(R, W * 0.43, 0.09, 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const dx = x + 0.5 - C, dy = y + 0.5 - C;
    if (Math.hypot(dx, dy) < outline(Math.atan2(dy, dx))) mask[y * W + x] = FREE;
  }
  const inside = (x, y) => { const p = at(Math.floor(x), Math.floor(y)); return p >= 0 && mask[p] === FREE; };
  const randomFree = (rMin, rMax) => {
    for (let k = 0; k < 500; k++) {
      const a = R() * Math.PI * 2, r = rMin + R() * (rMax - rMin);
      const x = C + Math.cos(a) * r, y = C + Math.sin(a) * r;
      if (inside(x, y)) return [x, y];
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
  const path = (x0, y0, steps, len, turn, width, fn) => {
    let x = x0, y = y0, a = R() * Math.PI * 2;
    for (let s = 0; s < steps * len; s++) {
      if (s % len === 0) a += (R() - 0.5) * turn;
      x += Math.cos(a); y += Math.sin(a);
      disc(x, y, width / 2, fn);
    }
  };
  const setIfFree = (v) => (p) => { if (mask[p] === FREE) mask[p] = v; };

  // rock outcrops and ridges: walls that cells cannot reach through
  const outcrops = 3 + Math.floor(R() * 3);
  for (let k = 0; k < outcrops; k++) {
    const [x, y] = randomFree(W * 0.12, W * 0.38);
    blob(x, y, 6 + R() * 12, setIfFree(ROCK));
  }
  const ridges = 2 + Math.floor(R() * 2);
  for (let k = 0; k < ridges; k++) {
    const [x, y] = randomFree(W * 0.1, W * 0.35);
    path(x, y, 6 + Math.floor(R() * 5), 8, 1.1, 3 + R() * 2, setIfFree(ROCK));
  }
  // cracks: thin holes that swallow sand
  const cracks = 2 + Math.floor(R() * 2);
  for (let k = 0; k < cracks; k++) {
    const [x, y] = randomFree(W * 0.16, W * 0.38);
    path(x, y, 4 + Math.floor(R() * 4), 6, 1.6, 2, setIfFree(CRACK));
  }
  // keep the middle open: it is where the first spout goes
  disc(C, C, W * 0.08, (p) => { if (mask[p] !== OUT) mask[p] = FREE; });

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
  for (let p = 0; p < n; p++) if (mask[p] === FREE && !seen[p]) mask[p] = ROCK;

  // surface ore
  const veins = 2 + Math.floor(R() * 2);
  for (let k = 0; k < veins; k++) {
    const [x, y] = randomFree(W * 0.12, W * 0.36);
    blob(x, y, 5 + R() * 6, (p) => { if (mask[p] === FREE) ore[p] = 1; });
  }

  // buried things: deeper further out
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
  const relics = RELICS.map(r => r.id);
  bury('relic', W * 0.05, W * 0.14, 2.5, { relic: relics[0] });
  bury('relic', W * 0.14, W * 0.26, 4, { relic: relics[1] });
  bury('relic', W * 0.2, W * 0.34, 6, { relic: relics[2] });
  bury('relic', W * 0.26, W * 0.4, 9, { relic: relics[3] });
  bury('relic', W * 0.2, W * 0.4, 7, { relic: relics[4] });
  bury('spring', W * 0.14, W * 0.3, 4.5);
  bury('spring', W * 0.24, W * 0.4, 8);
  bury('ore', W * 0.1, W * 0.3, 3, { r: 9 });
  bury('ore', W * 0.2, W * 0.4, 6, { r: 11 });
  bury('cave', W * 0.12, W * 0.32, 5, { r: 7 });

  // a loose scatter of starting stakes near the middle
  const stakes = [];
  for (let k = 0; k < 200 && stakes.length < 9; k++) {
    const [x, y] = randomFree(0, W * 0.16);
    if (stakes.every(s => Math.hypot(s[0] - x, s[1] - y) > W * 0.07)) stakes.push([x, y]);
  }
  return { W, H, mask, ore, buried, stakes, spout: [C + 0.5, C + 0.5] };
}
