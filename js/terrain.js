// Seeded terrain generation. Each table is generated at the largest size
// (25×25); the board you play on is the centre window of this map, which
// grows as you widen the table.
import { Board, STONE, T_NONE, T_GEODE, T_BEDROCK, T_SPRING, T_CRACK, T_DIG, T_SLOPE } from './sim.js';

export const MAP = 25;
export const C = 12;           // centre of the map
export const SIZES = [5, 7, 9, 11, 13, 15, 17, 19, 21, 23, 25];

// The table number (tier) at which each kind of terrain first appears.
export const TERRAIN_INTRO = { geode: 1, dig: 1, bedrock: 2, spring: 3, slope: 4, crack: 5 };

export function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

export const ARCHETYPES = {
  first: { names: ['The First Table'], blurb: 'A plain table, a few geodes, something buried.' },
  geode: { names: ['The Glittering Table', 'The Seam', 'The Geode Field'], blurb: 'Rich with geodes.' },
  quarry: { names: ['The Quarry', 'The Broken Table', 'The Rockfall'], blurb: 'Bedrock everywhere: natural pockets, if you can find them.' },
  spring: { names: ['The Wellspring', 'The Oasis', 'The Weeping Table'], blurb: 'Springs pour sand of their own.' },
  dunes: { names: ['The Dunes', 'The Tilted Table', 'The Long Slope'], blurb: 'Slopes carry sand downhill.' },
  rift: { names: ['The Rift', 'The Fissured Table', 'The Split Table'], blurb: 'Cracks swallow sand. Plug them, or steer around them.' },
  ruin: { names: ['The Ruin', 'The Buried Table', 'The Old Dig'], blurb: 'Many things buried here.' },
};

function archetypesFor(tier) {
  const a = ['geode', 'ruin'];
  if (tier >= TERRAIN_INTRO.bedrock) a.push('quarry');
  if (tier >= TERRAIN_INTRO.spring) a.push('spring');
  if (tier >= TERRAIN_INTRO.slope) a.push('dunes');
  if (tier >= TERRAIN_INTRO.crack) a.push('rift');
  return a;
}

// Pick distinct archetypes for a set of candidate tables. The newest feature
// is always offered first, so new terrain is never skipped by accident.
export function candidateArchetypes(tier, count, rng) {
  const all = archetypesFor(tier);
  const intro = Object.entries({ quarry: TERRAIN_INTRO.bedrock, spring: TERRAIN_INTRO.spring, dunes: TERRAIN_INTRO.slope, rift: TERRAIN_INTRO.crack })
    .find(([, t]) => t === tier);
  const out = [];
  if (intro) out.push(intro[0]);
  const pool = all.filter(a => !out.includes(a));
  while (out.length < count && pool.length) out.push(pool.splice(Math.floor(rng() * pool.length), 1)[0]);
  while (out.length < count) out.push(all[Math.floor(rng() * all.length)]);
  return out;
}

const ringOf = (x, y) => Math.max(Math.abs(x - C), Math.abs(y - C));

export function generateTable({ seed, tier = 1, arch = null, first = false }) {
  const R = mulberry32(seed >>> 0);
  const n = MAP * MAP;
  const terr = new Uint8Array(n);
  const rich = new Float32Array(n).fill(1);
  const sdir = new Int8Array(n);
  if (!arch) {
    const options = archetypesFor(tier);
    arch = first ? 'first' : options[Math.floor(R() * options.length)];
  }
  const allowed = (f) => tier >= TERRAIN_INTRO[f];
  const isIntro = (f) => tier === TERRAIN_INTRO[f];
  const ri = (a, b) => a + Math.floor(R() * (b - a + 1));
  const idx = (x, y) => y * MAP + x;
  const inMap = (x, y) => x >= 0 && y >= 0 && x < MAP && y < MAP;
  // pick a random free cell with ring in [r0, r1]
  const pick = (r0, r1, ok = (i) => terr[i] === T_NONE) => {
    for (let tries = 0; tries < 400; tries++) {
      const r = ri(r0, r1);
      const side = ri(0, 3), t = ri(-r, r);
      let x, y;
      if (side === 0) { x = C + t; y = C - r; } else if (side === 1) { x = C + r; y = C + t; }
      else if (side === 2) { x = C + t; y = C + r; } else { x = C - r; y = C + t; }
      if (!inMap(x, y)) continue;
      const i = idx(x, y);
      if (ok(i)) return [x, y];
    }
    return null;
  };
  const neighbourFree = (x, y) => {
    const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]].sort(() => R() - 0.5);
    for (const [dx, dy] of dirs) {
      const nx = x + dx, ny = y + dy;
      if (inMap(nx, ny) && terr[idx(nx, ny)] === T_NONE && ringOf(nx, ny) >= 2) return [nx, ny];
    }
    return null;
  };

  // ---- dig sites (placed first, so they get good spots)
  const digs = [];
  let digCount = first ? 3 : 1 + (arch === 'ruin' ? 2 : (R() < 0.45 ? 1 : 0));
  const digRings = first ? [[2, 2], [5, 5], [6, 6]] : [];
  for (let k = 0; k < digCount; k++) {
    // later tables bury things deeper
    const [r0, r1] = digRings[k] || (k === 0 ? [2, 5] : [4 + Math.min(4, Math.floor(tier / 5)), 10]);
    const p = pick(r0, r1);
    if (!p) continue;
    terr[idx(p[0], p[1])] = T_DIG;
    digs.push({ mx: p[0], my: p[1] });
  }

  // ---- geodes: veins of 1–3 cells; richer further out
  const veins = (first ? 4 : 4 + ri(0, 2)) + (arch === 'geode' ? 4 : 0);
  for (let k = 0; k < veins; k++) {
    const range = k === 0 ? [1, 2] : k === 1 ? [2, 4] : [2, 11];
    let p = pick(range[0], range[1]);
    if (!p) continue;
    const r = ringOf(p[0], p[1]);
    const richness = Math.round((1 + r * 0.22 + R() * 0.5) * (arch === 'geode' ? 1.3 : 1) * 4) / 4;
    const len = ri(1, 3);
    for (let j = 0; j < len && p; j++) {
      const i = idx(p[0], p[1]);
      terr[i] = T_GEODE;
      rich[i] = richness;
      p = neighbourFree(p[0], p[1]);
    }
  }

  // ---- bedrock ridges
  if (allowed('bedrock')) {
    const ridges = arch === 'quarry' ? ri(6, 9) : isIntro('bedrock') ? 3 : (R() < 0.6 ? ri(1, 3) : 0);
    for (let k = 0; k < ridges; k++) {
      let p = pick(2, 11);
      const len = ri(3, arch === 'quarry' ? 8 : 6);
      // ridges tend to run straight-ish
      let dir = ri(0, 3);
      for (let j = 0; j < len && p; j++) {
        const i = idx(p[0], p[1]);
        if (terr[i] !== T_NONE || ringOf(p[0], p[1]) < 2) break;
        terr[i] = T_BEDROCK;
        if (R() < 0.35) dir = (dir + (R() < 0.5 ? 1 : 3)) & 3;
        const nx = p[0] + [0, 1, 0, -1][dir], ny = p[1] + [-1, 0, 1, 0][dir];
        p = inMap(nx, ny) ? [nx, ny] : null;
      }
    }
  }

  // ---- springs
  if (allowed('spring')) {
    const count = arch === 'spring' ? 2 + (R() < 0.5 ? 1 : 0) : isIntro('spring') ? 1 : (R() < 0.35 ? 1 : 0);
    for (let k = 0; k < count; k++) {
      const p = pick(k === 0 ? 2 : 3, 8);
      if (p) terr[idx(p[0], p[1])] = T_SPRING;
    }
  }

  // ---- slopes: diamond-shaped fields that all lean one way
  if (allowed('slope')) {
    const fields = arch === 'dunes' ? ri(3, 4) : isIntro('slope') ? 2 : (R() < 0.4 ? 1 : 0);
    for (let k = 0; k < fields; k++) {
      const p = pick(2, 9);
      if (!p) continue;
      const rad = ri(1, 3), dir = ri(0, 3);
      for (let dy = -rad; dy <= rad; dy++) for (let dx = -rad; dx <= rad; dx++) {
        if (Math.abs(dx) + Math.abs(dy) > rad) continue;
        const x = p[0] + dx, y = p[1] + dy;
        if (!inMap(x, y) || ringOf(x, y) < 2) continue;
        const i = idx(x, y);
        if (terr[i] !== T_NONE) continue;
        terr[i] = T_SLOPE;
        sdir[i] = dir;
      }
    }
  }

  // ---- cracks: short fissures
  if (allowed('crack')) {
    const count = arch === 'rift' ? ri(3, 4) : isIntro('crack') ? 2 : (R() < 0.35 ? 1 : 0);
    for (let k = 0; k < count; k++) {
      let p = pick(3, 11);
      const len = ri(1, 3);
      for (let j = 0; j < len && p; j++) {
        terr[idx(p[0], p[1])] = T_CRACK;
        p = neighbourFree(p[0], p[1]);
      }
    }
  }

  // ---- make sure sand can always leave, at every size the table can be.
  // Remove offending bedrock / slope cells until every window drains.
  for (let guard = 0; guard < 200; guard++) {
    const bad = firstUndrainedWindow(terr, sdir);
    if (bad === null) break;
    // turn the nearest bedrock or slope cell to the trapped region back into plain ground
    let best = -1, bestD = Infinity;
    const [bx, by] = bad;
    for (let i = 0; i < n; i++) {
      if (terr[i] !== T_BEDROCK && terr[i] !== T_SLOPE) continue;
      const d = Math.abs(i % MAP - bx) + Math.abs(((i / MAP) | 0) - by);
      if (d < bestD) { bestD = d; best = i; }
    }
    if (best < 0) break;
    terr[best] = T_NONE;
  }

  const names = ARCHETYPES[arch].names;
  const name = names[Math.floor(R() * names.length)];
  const count = (t) => { let c = 0; for (let i = 0; i < n; i++) if (terr[i] === t) c++; return c; };
  return {
    seed, tier, arch, name, blurb: ARCHETYPES[arch].blurb,
    terr, rich, sdir, digs,
    features: {
      geode: count(T_GEODE), bedrock: count(T_BEDROCK), spring: count(T_SPRING),
      slope: count(T_SLOPE), crack: count(T_CRACK), dig: digs.length,
    },
  };
}

// Copy the terrain window for a board of size `size` from a map.
export function terrainWindow(map, size) {
  const off = C - (size >> 1);
  const terr = new Uint8Array(size * size), rich = new Float32Array(size * size), sdir = new Int8Array(size * size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const m = (y + off) * MAP + (x + off), i = y * size + x;
    terr[i] = map.terr[m]; rich[i] = map.rich[m]; sdir[i] = map.sdir[m];
  }
  return { terr, rich, sdir };
}

// Returns the map coordinates of a trapped cell for some window size, or null.
function firstUndrainedWindow(terr, sdir) {
  for (const size of SIZES) {
    const b = new Board(size);
    const w = terrainWindow({ terr, sdir, rich: new Float32Array(MAP * MAP) }, size);
    b.terr.set(w.terr);
    b.sdir.set(w.sdir);
    for (let i = 0; i < b.n; i++) if (b.terr[i] === T_BEDROCK) b.kind[i] = STONE;
    b.rebuild();
    if (!b.allCellsDrain()) {
      const trapped = trappedCell(b);
      const off = C - (size >> 1);
      return [trapped % size + off, ((trapped / size) | 0) + off];
    }
  }
  return null;
}

// The first cell that has no way for sand to leave (mirrors Board.allCellsDrain).
export function trappedCell(b) {
  const ok = new Uint8Array(b.n);
  const q = [];
  for (let i = 0; i < b.n; i++) {
    if (b.isVoid(i)) continue;
    for (let d = 0; d < 4; d++) if (b.tgt[i * 4 + d] === -1) { ok[i] = 1; q.push(i); break; }
  }
  while (q.length) {
    const c = q.pop();
    for (let p = b.inStart[c]; p < b.inStart[c + 1]; p++) { const s = b.inSrc[p]; if (!ok[s]) { ok[s] = 1; q.push(s); } }
  }
  for (let i = 0; i < b.n; i++) if (!b.isVoid(i) && !ok[i]) return i;
  return 0;
}

export function describeFeatures(f) {
  const parts = [];
  if (f.dig) parts.push(`${f.dig} dig site${f.dig > 1 ? 's' : ''}`);
  if (f.geode) parts.push(`${f.geode} geodes`);
  if (f.bedrock) parts.push('bedrock');
  if (f.spring) parts.push(`${f.spring} spring${f.spring > 1 ? 's' : ''}`);
  if (f.slope) parts.push('slopes');
  if (f.crack) parts.push('cracks');
  return parts.join(' · ');
}
