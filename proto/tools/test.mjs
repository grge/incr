// Engine tests for the prototype. Run: node proto/tools/test.mjs
import assert from 'node:assert/strict';
import { Tess, buildGraph, FREE } from '../js/voronoi.js';
import { Pile, solve } from '../js/pile.js';
import { generateRegion, mulberry32, RECIPE_IDS } from '../js/region.js';
import { Game, newState } from '../js/game.js';

if (!globalThis.btoa) {
  globalThis.btoa = (s) => Buffer.from(s, 'binary').toString('base64');
  globalThis.atob = (b) => Buffer.from(b, 'base64').toString('binary');
}

let passed = 0;
function test(name, fn) {
  const t0 = Date.now();
  try { fn(); passed++; console.log(`  ✓ ${name} (${Date.now() - t0}ms)`); } catch (e) { console.error('  ✗', name); throw e; }
}
const W = 320;

function symmetric(g) {
  for (let c = 0; c < g.n; c++) {
    for (let e = g.nbrStart[c]; e < g.nbrStart[c + 1]; e++) {
      const b = g.nbr[e];
      let back = false;
      for (let f = g.nbrStart[b]; f < g.nbrStart[b + 1]; f++) if (g.nbr[f] === c) back = true;
      assert.ok(back, `${c}-${b} symmetric`);
    }
    assert.ok(g.thr[c] >= 1);
  }
}

function settle(game, max = 400) {
  game.wake();
  let k = 0;
  for (; k < max; k++) { const m = game.relaxStep(); game.still = m < 0.08 ? game.still + 1 : 0; if (game.still >= 4) break; }
  game.moving = false;
  return k;
}

test('regions: a free middle, a density field, things buried', () => {
  for (let seed = 1; seed <= 8; seed++) {
    const r = generateRegion(seed, W);
    assert.equal(r.mask[(W / 2) * W + W / 2], FREE);
    assert.ok(r.buried.length >= 8);
    for (let p = 0; p < W * W; p++) if (r.mask[p] === FREE) assert.ok(r.rho0[p] > 0);
  }
});

test('a new region is sown and settled: all free ground in cells, graph symmetric', () => {
  const game = new Game(newState(3));
  const g = game.g;
  let free = 0, labelled = 0;
  for (let p = 0; p < W * W; p++) if (game.mask[p] === FREE) { free++; if (game.tess.lab[p] >= 0) labelled++; }
  assert.equal(labelled, free, 'growth reaches all free ground');
  assert.ok(g.n >= 200, `${g.n} cells`);
  symmetric(g);
});

test('cells depend only on where the seeds are', () => {
  const game = new Game(newState(5));
  const t = game.tess;
  const before = Int32Array.from(t.lab);
  const s = t.add({ x: 150, y: 120 });
  t.move(s, 158, 131);
  t.remove(s);
  let diff = 0;
  for (let p = 0; p < W * W; p++) if (t.lab[p] !== before[p]) diff++;
  assert.equal(diff, 0);
});

test('steady-state solver matches the live sandpile', () => {
  const game = new Game(newState(7));
  const g = game.g, t = game.tess, r = game.region;
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

test('every recipe makes a whole region', () => {
  for (const id of RECIPE_IDS) {
    const game = new Game(newState(11, id));
    assert.ok(game.g.n >= 200, `${id}: ${game.g.n} cells`);
    assert.ok(game.region.zones.every(z => z.recipe === id));
    symmetric(game.g);
  }
});

test('regrouping cells shares grains out instead of copying them', () => {
  const game = new Game(newState(2));
  const sum = () => game.pile.grains.reduce((a, x) => a + x, 0);
  for (let k = 0; k < 20; k++) game.tick(0.1);
  const before = sum();
  game.s.sandbox = true;
  game.addWeight(160, 160);
  game.adjustWeight(0, 1); game.adjustWeight(0, 1);
  for (let k = 0; k < 5; k++) game.relaxStep();
  const after = sum();
  assert.ok(after <= before * 1.02 + 20, `grains ${before} -> ${after}`);
  assert.ok(after >= before * 0.85, `grains ${before} -> ${after}`);
});

test('a weight draws cells in: a deeper, crowded well, with the cell count unchanged', () => {
  const game = new Game(newState(1));
  const [x, y] = [game.s.taps[0].x, game.s.taps[0].y];
  const near = () => { const g = game.g; let k = 0; for (let c = 0; c < g.n; c++) if (Math.hypot(g.cx[c] - x, g.cy[c] - y) < 26) k++; return k; };
  const n0 = game.g.n, k0 = near(), e0 = game.expected, gm0 = game.expectedGems;
  assert.ok(game.addWeight(x, y));
  for (let i = 0; i < 8; i++) game.adjustWeight(0, 1);
  assert.equal(game.s.weights[0].pull, 6, 'pull is capped by the budget');
  assert.equal(game.addWeight(x + 40, y), false, 'no pull left for a second weight');
  const steps = settle(game);
  assert.ok(steps < 400, 'the land settles');
  assert.equal(game.g.n, n0, 'weights move cells, they do not make them');
  assert.ok(near() > k0 * 2, `cells near the weight ${k0} -> ${near()}`);
  assert.ok(game.expected > e0 * 1.1, `income ${e0} -> ${game.expected}`);
  assert.ok(game.expectedGems > gm0 * 2 + 1, `gems ${gm0} -> ${game.expectedGems}`);
});

test('taps share one flow', () => {
  const game = new Game(newState(4));
  const R = game.realRate(), e0 = game.expected;
  const [x, y] = [game.s.taps[0].x + 30, game.s.taps[0].y];
  const pv = game.previewTap(x, y);
  assert.ok(pv.ok);
  assert.ok(game.addTap(x, y));
  assert.ok(Math.abs(game.realRate() - R) < 1e-9, 'adding a tap splits the flow');
  assert.ok(Math.abs(game.expected / e0 - pv.ratio) < 1e-6, 'the preview was right');
  game.adjustTap(1, 1);
  assert.ok(game.tapShare(1) > 0.5);
  assert.ok(Math.abs(game.realRate() - R) < 1e-9);
  assert.ok(game.removeTap(1));
  assert.equal(game.removeTap(0), false, 'the last tap stays');
});

test('the comb stretches cells along the stroke', () => {
  const game = new Game(newState(9, 'basalt'));
  const aniso = () => {
    const g = game.g; let s = 0, k = 0;
    for (let c = 0; c < g.n; c++) if (Math.abs(g.cy[c] - 160) < 30 && Math.abs(g.cx[c] - 160) < 60) { s += Math.log(g.mxx[c] / g.myy[c]); k++; }
    return s / k;
  };
  const a0 = aniso();
  for (let pass = 0; pass < 6; pass++) for (let y = 140; y <= 180; y += 8) game.combStroke(90, y, 230, y);
  settle(game);
  const a1 = aniso();
  assert.ok(a1 > a0 + 0.5, `log(mxx/myy) ${a0.toFixed(2)} -> ${a1.toFixed(2)}`);
});

test('crowded cells press out gems, live and on average', () => {
  const game = new Game(newState(1));
  game.addWeight(game.s.taps[0].x, game.s.taps[0].y);
  for (let i = 0; i < 8; i++) game.adjustWeight(0, 1);
  settle(game);
  for (let k = 0; k < 600; k++) game.tick(0.1);
  const g0 = game.s.gems;
  for (let k = 0; k < 3000; k++) game.tick(0.1);
  const live = (game.s.gems - g0) / 300;
  assert.ok(live > game.expectedGems * 0.6 && live < game.expectedGems * 1.4, `live ${live} vs ${game.expectedGems}`);
});

test('saves round-trip the shaped land', () => {
  const game = new Game(newState(8));
  game.addWeight(150, 150);
  game.combStroke(100, 200, 200, 200);
  for (let k = 0; k < 200; k++) game.tick(0.5);
  const h = new Game(JSON.parse(game.serialize()));
  assert.equal(h.g.n, game.g.n);
  assert.deepEqual(h.s.weights, game.s.weights);
  assert.ok(Math.abs(h.expected - game.expected) / game.expected < 1e-6);
});

console.log(`${passed} tests passed`);
