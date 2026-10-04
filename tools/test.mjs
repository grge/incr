// Logic tests. Run: node tools/test.mjs
import assert from 'node:assert/strict';
import { Board, STONE, CRYSTAL, EMPTY } from '../js/sim.js';
import { Game } from '../js/game.js';
import * as D from '../js/data.js';

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ✓', name); } catch (e) { console.error('  ✗', name); throw e; }
}

function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

test('toppling conserves sand', () => {
  const b = new Board(9);
  let added = 0, spilled = 0;
  const rng = mulberry32(1);
  for (let r = 0; r < 4000; r++) {
    const i = Math.floor(rng() * b.n);
    b.add(i, 1); added++;
    spilled += b.round().spilled;
  }
  for (let r = 0; r < 500; r++) spilled += b.round().spilled;
  assert.ok(Math.abs(b.totalGrains() + spilled - added) < 1e-9);
  assert.ok(b.isStable());
});

test('stones reflect sand and conserve it', () => {
  const b = new Board(7);
  b.kind[b.idx(2, 3)] = STONE; b.kind[b.idx(4, 3)] = STONE; b.kind[b.idx(3, 2)] = STONE;
  b.rebuild();
  let spilled = 0;
  for (let r = 0; r < 3000; r++) { b.add(b.idx(3, 3), 1); spilled += b.round().spilled; }
  for (let r = 0; r < 500; r++) spilled += b.round().spilled;
  assert.ok(Math.abs(b.totalGrains() + spilled - 3000) < 1e-9);
});

test('steady-state solver matches simulation', () => {
  for (const fold of [false, true]) {
    const b = new Board(9);
    b.fold = fold;
    b.kind[b.idx(3, 4)] = STONE; b.kind[b.idx(5, 4)] = STONE; b.kind[b.idx(4, 3)] = STONE;
    b.rebuild();
    const src = b.idx(4, 4);
    const ones = new Float64Array(b.n);
    for (let i = 0; i < b.n; i++) ones[i] = b.kind[i] === STONE ? 0 : 1;
    const expected = b.solveValue(ones)[src];
    let topples = 0;
    const N = 20000;
    for (let r = 0; r < 300; r++) { b.add(src, 1); b.round(); }
    for (let r = 0; r < N; r++) { b.add(src, 1); topples += b.round().topples; }
    const per = topples / N;
    assert.ok(Math.abs(per - expected) / expected < 0.03, `fold=${fold}: sim ${per} vs solver ${expected}`);
  }
});

test('duality: value map and topple map agree', () => {
  const b = new Board(11);
  b.kind[b.idx(5, 4)] = STONE; b.kind[b.idx(2, 2)] = CRYSTAL; b.val[b.idx(2, 2)] = 7;
  b.rebuild();
  const drop = new Float64Array(b.n); drop[b.idx(5, 5)] = 2; drop[b.idx(1, 8)] = 0.5;
  const u = b.solveTopples(drop);
  const v = b.solveValue(b.val);
  let a = 0, c = 0;
  for (let i = 0; i < b.n; i++) { a += u[i] * b.val[i]; c += drop[i] * v[i]; }
  assert.ok(Math.abs(a - c) / c < 1e-6);
});

test('sand can never be trapped by stones', () => {
  const b = new Board(5);
  for (const [x, y] of [[1, 2], [3, 2], [2, 1]]) { assert.ok(b.canPlaceStone(b.idx(x, y))); b.kind[b.idx(x, y)] = STONE; }
  b.rebuild();
  assert.equal(b.canPlaceStone(b.idx(2, 3)), false, 'closing the ring must be refused');
});

test('fold refuses to trap sand', () => {
  const g = new Game({ analytic: true });
  g.s.kiln.k_stones = 1; g.s.kiln.k_long = 1; g.s.kiln.k_fold = 1; g.recomputeFx();
  const b = g.boards[0];
  // a wall along the north row except an opening in the west edge
  for (let x = 1; x < b.size; x++) b.kind[b.idx(x, 1)] = STONE;
  b.rebuild();
  assert.ok(b.allCellsDrain());
  assert.equal(g.setFold(true), true);
  g.setFold(false);
});

test('a fresh run always has income or a way to get it', () => {
  const g = new Game({ analytic: true });
  assert.ok(g.canClick());
  g.gainDust(1e12);
  g.sweep();
  assert.ok(g.baseRate() > 0, 'after a sweep, the free hourglass pours');
  g.s.kiln.k_trials = 1; g.recomputeFx();
  for (const t of D.TRIALS) {
    g.startTrial(t.id);
    assert.ok(g.baseRate() > 0 || g.canClick(), `trial ${t.id} has a way to earn`);
  }
});

test('save and load round-trip', () => {
  const g = new Game({ analytic: true, rng: mulberry32(7) });
  g.gainDust(1e9);
  for (let k = 0; k < 30; k++) g.buyBuilding('hourglass');
  g.buyUpgrade('u_hands');
  const json = g.serialize();
  const h = new Game({ analytic: true }).load(json);
  assert.equal(h.s.owned.hourglass, 30);
  assert.ok(h.s.up.u_hands);
  assert.ok(Math.abs(h.baseRate() - g.baseRate()) / g.baseRate() < 1e-9);
});

test('blueprint restores layout after a sweep', () => {
  const g = new Game({ analytic: true });
  g.gainDust(1e30);
  for (const u of D.UPGRADES) if (g.upgradeAvailable(u)) g.buyUpgrade(u.id);
  for (let k = 0; k < 10; k++) g.buyBuilding('hourglass');
  const b = g.boards[0];
  const from = b.hourglasses[0];
  g.move(0, from, 0);
  g.sweep();
  g.gainDust(1e30);
  for (const u of D.UPGRADES) if (g.upgradeAvailable(u)) g.buyUpgrade(u.id);
  assert.equal(g.boards[0].size, 13);
  assert.ok(g.boards[0].hg[0] >= 1, 'stack is back in the corner once the table is big enough');
});

test('content references are consistent', () => {
  for (const u of D.UPGRADES) {
    for (const r of u.req || []) assert.ok(D.UPGRADE_MAP[r], `${u.id} req ${r}`);
    if (u.kreq) assert.ok(D.KILN_MAP[u.kreq], `${u.id} kreq ${u.kreq}`);
  }
  for (const k of D.KILN) for (const r of k.req || []) assert.ok(D.KILN_MAP[r], `${k.id} req ${r}`);
  const ids = new Set();
  for (const a of D.ACHIEVEMENTS) { assert.ok(!ids.has(a.id)); ids.add(a.id); }
});

console.log(`${passed} tests passed`);
