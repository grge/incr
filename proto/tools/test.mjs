// Engine tests for the prototype. Run: node proto/tools/test.mjs
import assert from 'node:assert/strict';
import { Tess, buildGraph, FREE } from '../js/voronoi.js';
import { Pile, solve } from '../js/pile.js';
import { generateRegion, mulberry32, RECIPE_IDS } from '../js/region.js';
import { Game, newState } from '../js/game.js';

let passed = 0;
function test(name, fn) {
  const t0 = Date.now();
  try { fn(); passed++; console.log(`  ✓ ${name} (${Date.now() - t0}ms)`); } catch (e) { console.error('  ✗', name); throw e; }
}
const W = 320;

function tessFor(region) {
  const t = new Tess(W, W, region.mask);
  t.seeds = region.seeds.map(q => Object.assign({}, q));
  t.rebuild();
  return t;
}

test('regions: a free middle, everything else reachable from it', () => {
  for (let seed = 1; seed <= 8; seed++) {
    const r = generateRegion(seed, W);
    assert.equal(r.mask[(W / 2) * W + W / 2], FREE);
    assert.ok(r.seeds.length >= 80, `seed ${seed}: ${r.seeds.length} seeds`);
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

test('cells depend only on where the seeds are', () => {
  const r = generateRegion(5, W);
  const t = tessFor(r);
  const before = Int32Array.from(t.lab);
  const s = t.add({ x: 150, y: 120 });
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

test('every recipe covers its ground', () => {
  for (const id of RECIPE_IDS) {
    const r = generateRegion(11, W, id);
    const t = tessFor(r);
    const g = buildGraph(t);
    assert.ok(g.n >= 60, `${id}: ${g.n} cells`);
    assert.ok(r.seeds.every(q => q.z === id || q.z === 'river'));
  }
});

test('busy cells crack, the graph stays sound, and cracking keeps a steady pace', () => {
  const game = new Game(newState(4));
  const n0 = game.g.n;
  for (let k = 0; k < 600; k++) game.tick(0.5);    // five minutes
  const g = game.g;
  assert.ok(g.n > n0 + 10, `cells ${n0} -> ${g.n}`);
  assert.ok(g.n < n0 + 400, `cells ${n0} -> ${g.n}: cracking ran away`);
  for (let c = 0; c < g.n; c++) for (let e = g.nbrStart[c]; e < g.nbrStart[c + 1]; e++) {
    const b = g.nbr[e];
    let back = false;
    for (let f = g.nbrStart[b]; f < g.nbrStart[b + 1]; f++) if (g.nbr[f] === c) back = true;
    assert.ok(back);
  }
  assert.ok(Number.isFinite(game.expected) && game.expected > 0);
});

test('the chisel cracks the cell you choose; a tremor loads the pile', () => {
  const game = new Game(newState(6));
  const n0 = game.g.n;
  const [x, y] = game.s.spouts[0];
  assert.equal(game.chisel(x, y), 'ok');
  assert.equal(game.g.n, n0 + 1);
  const pv = game.previewChisel(x, y);
  assert.ok(pv.ok && pv.ratio > 0);
  assert.equal(game.g.n, n0 + 1, 'previewing changes nothing');
  assert.ok(game.tremor());
  assert.equal(game.tremor(), false, 'tremors need to recharge');
});

test('saves round-trip the shaped land', () => {
  const game = new Game(newState(8));
  for (let k = 0; k < 200; k++) game.tick(0.5);
  const h = new Game(JSON.parse(game.serialize()));
  assert.equal(h.g.n, game.g.n);
  assert.ok(Math.abs(h.expected - game.expected) / game.expected < 1e-6);
});

console.log(`${passed} tests passed`);
