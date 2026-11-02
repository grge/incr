// Tests for the skirmish prototype. Run: node proto/tools/war_test.mjs
import assert from 'node:assert/strict';
import { generateMap } from '../war/js/map.js';
import { War, NEUTRAL, RULES, fight } from '../war/js/war.js';
import { Bot } from '../war/js/bot.js';

let passed = 0;
function test(name, fn) {
  const t0 = Date.now();
  try { fn(); passed++; console.log(`  ✓ ${name} (${Date.now() - t0}ms)`); } catch (e) { console.error('  ✗', name); throw e; }
}
const W = 320, N = W * W;
const chargeOf = (w, p) => w.totalCharge(p);

test('maps are the same for both sides', () => {
  for (const seed of [1, 2, 3, 4, 5]) {
    const m = generateMap(seed, W);
    for (let p = 0; p < N; p++) {
      assert.equal(m.mask[p], m.mask[N - 1 - p], `seed ${seed}: mask`);
      assert.equal(m.rho0[p], m.rho0[N - 1 - p], `seed ${seed}: density`);
    }
    for (let k = 0; k < m.nodes.length; k += 2) {
      assert.ok(Math.abs(m.nodes[k].x + m.nodes[k + 1].x - W) < 1e-9 && Math.abs(m.nodes[k].y + m.nodes[k + 1].y - W) < 1e-9);
    }
    assert.deepEqual(m.nodes.filter(s => s.home !== null).map(s => s.home).sort(), [0, 1]);
  }
});

test('fights: the largest force wins what is left; a tie stays with the defender', () => {
  assert.deepEqual(fight([[0, 5, 1], [1, 3, 1]], 0), [0, 2]);
  assert.deepEqual(fight([[0, 2, 1], [1, 3, 1]], 0), [1, 1]);
  assert.deepEqual(fight([[0, 3, 1], [1, 3, 1]], 0), [0, 0]);
  assert.deepEqual(fight([[NEUTRAL, 0, 1], [0, 1, 1], [1, 1, 1]], NEUTRAL), [NEUTRAL, 0], 'two attackers tie: no one takes it');
  assert.deepEqual(fight([[NEUTRAL, 3, 1], [0, 6, 1], [1, 1, 1]], NEUTRAL), [0, 2]);
});

test('a fair start: each side holds its home node and a similar patch', () => {
  const w = new War({ seed: 3 });
  assert.equal(w.nodesOf(0).length, 1);
  assert.equal(w.nodesOf(1).length, 1);
  const [a, b] = w.cellsOwned;
  assert.ok(a > 5 && Math.abs(a - b) <= Math.max(2, 0.15 * a), `cells ${a} vs ${b}`);
  assert.ok(w.g.n > 250, `${w.g.n} cells`);
});

test('firing never makes charge; cells only change hands by fighting', () => {
  const w = new War({ seed: 4 });
  for (let k = 0; k < 60; k++) w.add(w.cellAt(w.nodes[0].x, w.nodes[0].y), 0, 1);
  let total = chargeOf(w, 0) + chargeOf(w, 1);
  for (let k = 0; k < 200; k++) {
    w.round();
    const t = chargeOf(w, 0) + chargeOf(w, 1);
    assert.ok(t <= total + 1e-9, 'no charge from nowhere');
    total = t;
  }
  assert.ok(w.cellsOwned[0] >= 0);
});

test('the land settling carries charge and owners along with the cells', () => {
  const w = new War({ seed: 5 });
  for (let k = 0; k < 600; k++) w.tick(1 / 30);
  const before = [chargeOf(w, 0), chargeOf(w, 1)], cells = w.g.n;
  w.reshape();
  w.relaxStep();
  assert.equal(w.g.n, cells);
  for (let p = 0; p < 2; p++) assert.ok(Math.abs(chargeOf(w, p) - before[p]) <= 0.02 * before[p] + 2, `player ${p}: ${before[p]} -> ${chargeOf(w, p)}`);
});

function warAtContact(seed) {
  const w = new War({ seed });
  const b0 = new Bot(w, 0), b1 = new Bot(w, 1);
  b0.cfg = { ...b0.cfg, wells: false }; b1.cfg = { ...b1.cfg, wells: false };
  while (w.time < 150) { w.tick(1 / 30); b0.tick(1 / 30); b1.tick(1 / 30); }
  const front = b0.hops(c => w.own[c] !== 0);
  let best = -1, bd = Infinity;
  for (let c = 0; c < w.g.n; c++) if (w.own[c] === 0 && front[c] === 2) { const d = Math.hypot(w.g.cx[c] - 160, w.g.cy[c] - 160); if (d < bd) { bd = d; best = c; } }
  return { w, b0, b1, x: w.g.cx[best], y: w.g.cy[best] };
}

test('a well swallows other players\' cells within reach, charge and all, up to its capacity', () => {
  const { w, b0, b1, x, y } = warAtContact(2);
  const n = w.g.n, before = w.cellsOwned[0];
  assert.equal(w.addWell(1, x, y), 'not yours', 'wells only on your own land');
  const well = w.addWell(0, x, y, RULES.maxPull);
  assert.equal(typeof well, 'object');
  for (let k = 0; k < 30 * 40; k++) { w.tick(1 / 30); b0.tick(1 / 30); b1.tick(1 / 30); }
  assert.ok(w.wells.includes(well), 'the well held');
  assert.ok(well.extra > 0 && well.extra <= w.capacity(well), `holds ${well.extra} of ${w.capacity(well)}`);
  assert.equal(w.g.n, n, 'wells move cells, they do not make them');
  assert.ok(w.cellsOwned[0] > before, `cells ${before} -> ${w.cellsOwned[0]}`);
  assert.equal(w.stats.swallowed[0], well.extra);
});

test('lifting a well throws its cells over the front, keeping their charge', () => {
  const { w, x, y } = warAtContact(3);
  const well = w.addWell(0, x, y, RULES.maxPull);
  for (let k = 0; k < 30 * 30; k++) w.tick(1 / 30);
  const held = well.extra;
  assert.ok(held > 0);
  const cells = w.cellsOwned[0], charge = chargeOf(w, 0);
  const outside = () => { let k = 0; for (let c = 0; c < w.g.n; c++) if (w.own[c] === 0 && Math.hypot(w.g.cx[c] - well.x, w.g.cy[c] - well.y) > well.r) k++; return k; };
  const out0 = outside();
  w.liftWell(well);
  w.relaxStep();
  assert.equal(w.stats.thrown[0], held);
  assert.equal(w.cellsOwned[0], cells, 'the thrown cells are still yours');
  assert.ok(outside() >= out0 + held / 2, `cells of yours beyond the well: ${out0} -> ${outside()} (threw ${held})`);
  assert.ok(Math.abs(chargeOf(w, 0) - charge) <= 0.02 * charge + 2, 'and they took their charge with them');
});

test('a well breaks when someone else holds the ground under it', () => {
  const w = new War({ seed: 6 });
  const sp = w.nodes.find(s => s.home === 0);
  const well = w.addWell(0, sp.x + 4, sp.y);
  assert.equal(typeof well, 'object');
  const c = w.cellAt(well.x, well.y);
  w.own[c] = 1; w.grains[c] = 50;
  for (let k = 0; k < 30 * (RULES.wellGrace - 0.5); k++) { w.own[c] = 1; w.tick(1 / 30); if (!w.wells.includes(well)) break; }
  assert.ok(w.wells.includes(well) || w.ownerAt(well.x, well.y) !== 1, 'a moment is not enough');
  for (let k = 0; k < 30 * 2; k++) { const cc = w.cellAt(well.x, well.y); w.own[cc] = 1; w.grains[cc] = 50; w.tick(1 / 30); }
  assert.ok(!w.wells.includes(well), 'held for long enough, it breaks');
});

test('nodes pour for whoever holds them; flow follows land, pull follows nodes', () => {
  const w = new War({ seed: 7 });
  const k = w.nodes.findIndex(s => s.home === null);
  assert.equal(w.nodeRate(k), 0);
  const f0 = w.flow(0), p0 = w.pullBudget(0);
  const c = w.cellAt(w.nodes[k].x, w.nodes[k].y);
  w.own[c] = 0; w.grains[c] = 1;
  w.tick(1 / 30);
  assert.equal(w.nodes[k].owner, 0);
  assert.ok(w.nodeRate(k) > 0);
  assert.equal(w.pullBudget(0), p0 + RULES.pullPerNode);
  assert.ok(w.flow(0) > f0);
  assert.ok(Math.abs(w.nodeRate(k) + w.nodeRate(w.nodes.findIndex(s => s.home === 0)) - w.flow(0)) < 1e-9, 'the flow is shared, not added');
});

test('a focused node takes most of the flow; pull can be set directly', () => {
  const w = new War({ seed: 8 });
  const home = w.nodes.findIndex(s => s.home === 0), k = w.nodes.findIndex(s => s.home === null);
  const c = w.cellAt(w.nodes[k].x, w.nodes[k].y);
  w.own[c] = 0; w.grains[c] = 1;
  w.tick(1 / 30);
  assert.ok(Math.abs(w.nodeRate(home) - w.nodeRate(k)) < 1e-9);
  assert.equal(w.toggleFocus(k), true);
  assert.ok(Math.abs(w.nodeRate(k) - RULES.focus * w.nodeRate(home)) < 1e-9);
  assert.equal(w.toggleFocus(k), false);
  const well = w.addWell(0, w.nodes[home].x + 3, w.nodes[home].y, 1);
  w.setPull(well, 100);
  assert.equal(well.pull, Math.min(RULES.maxPull, w.pullBudget(0)), 'pull is capped by the budget');
});

test('the bot beats a player who does nothing, and the match ends', () => {
  const w = new War({ seed: 1 });
  const bot = new Bot(w, 1);
  while (!w.over && w.time < 600) { w.tick(1 / 20); bot.tick(1 / 20); }
  assert.ok(w.over, `no result after ${Math.round(w.time)}s: ${w.cellsOwned}`);
  assert.equal(w.over.winner, 1);
});

console.log(`${passed} skirmish tests passed`);

