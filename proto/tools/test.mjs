// Engine tests for the prototype. Run: node proto/tools/test.mjs
import assert from 'node:assert/strict';
import { Tess, buildGraph, FREE } from '../js/voronoi.js';
import { Pile, solve } from '../js/pile.js';
import { generateRegion, mulberry32 } from '../js/region.js';

let passed = 0;
function test(name, fn) {
  const t0 = Date.now();
  try { fn(); passed++; console.log(`  ✓ ${name} (${Date.now() - t0}ms)`); } catch (e) { console.error('  ✗', name); throw e; }
}
const W = 320;

function tessFor(region, extra = []) {
  const t = new Tess(W, W, region.mask);
  for (const [x, y] of [...region.stakes, ...extra]) t.seeds.push({ x, y });
  t.rebuild();
  return t;
}

test('regions: a free middle, everything else reachable from it', () => {
  for (let seed = 1; seed <= 8; seed++) {
    const r = generateRegion(seed, W);
    assert.equal(r.mask[(W / 2) * W + W / 2], FREE);
    assert.ok(r.stakes.length >= 5, `seed ${seed}: ${r.stakes.length} stakes`);
    assert.ok(r.buried.length >= 8);
  }
});

test('every free pixel reachable belongs to a cell; graph is symmetric and drains', () => {
  const r = generateRegion(3, W);
  const t = tessFor(r);
  const g = buildGraph(t);
  let free = 0, labelled = 0;
  for (let p = 0; p < W * W; p++) if (r.mask[p] === FREE) { free++; if (t.lab[p] >= 0) labelled++; }
  assert.equal(labelled, free, 'growth reaches all free ground');
  for (let c = 0; c < g.n; c++) {
    for (let e = g.nbrStart[c]; e < g.nbrStart[c + 1]; e++) {
      const b = g.nbr[e];
      let back = false;
      for (let f = g.nbrStart[b]; f < g.nbrStart[b + 1]; f++) if (g.nbr[f] === c) back = true;
      assert.ok(back, `${c}-${b} symmetric`);
    }
    assert.ok(g.thr[c] >= 1);
  }
});

test('cells depend only on where the stakes are', () => {
  const r = generateRegion(5, W);
  const t = tessFor(r);
  const before = Int32Array.from(t.lab);
  const s = t.add(150, 120);
  t.move(s, 158, 131);
  t.remove(s);
  let diff = 0;
  for (let p = 0; p < W * W; p++) if (t.lab[p] !== before[p]) diff++;
  assert.equal(diff, 0);
});

test('steady-state solver matches the live sandpile', () => {
  const r = generateRegion(7, W);
  const t = tessFor(r);
  const g = buildGraph(t);
  const src = g.cellOf[t.lab[t.pixel(r.spout[0], r.spout[1])]];
  const ones = new Float64Array(g.n).fill(1);
  const drop = new Float64Array(g.n); drop[src] = 1;
  const v = solve(g, ones);
  const u = solve(g, drop);
  let a = 0; for (let c = 0; c < g.n; c++) a += u[c];
  assert.ok(Math.abs(a - v[src]) / v[src] < 1e-6, 'duality');
  const pile = new Pile(g);
  pile.fill(mulberry32(1));
  for (let k = 0; k < 400; k++) { pile.grains[src]++; for (let r2 = 0; r2 < 50; r2++) if (!pile.round(ones).wave) break; }
  let topples = 0;
  const N = 30000;
  for (let k = 0; k < N; k++) { pile.grains[src]++; for (;;) { const res = pile.round(ones); if (!res.wave) break; topples += res.topples; } }
  const per = topples / N;
  assert.ok(Math.abs(per - v[src]) / v[src] < 0.03, `sim ${per} vs solver ${v[src]}`);
});

test('a stake costs little to place', () => {
  const r = generateRegion(2, W);
  const t = tessFor(r);
  const t0 = performance.now();
  for (let k = 0; k < 20; k++) {
    const c = t.clone();
    const x = 100 + k * 6, y = 150;
    if (c.canSeed(x, y, 9)) { c.add(x, y); buildGraph(c); }
  }
  const ms = (performance.now() - t0) / 20;
  console.log(`    ${ms.toFixed(1)} ms per previewed stake`);
  assert.ok(ms < 60);
});

console.log(`${passed} tests passed`);
