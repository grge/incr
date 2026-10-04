// Logic tests. Run: node tools/test.mjs
import assert from 'node:assert/strict';
import { Board, STONE, CRYSTAL, EMPTY, T_NONE, T_GEODE, T_BEDROCK, T_SPRING, T_CRACK, T_DIG, T_SLOPE } from '../js/sim.js';
import { Game } from '../js/game.js';
import { generateTable, terrainWindow, candidateArchetypes, mulberry32, SIZES, C } from '../js/terrain.js';
import * as D from '../js/data.js';

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ✓', name); } catch (e) { console.error('  ✗', name); throw e; }
}
const close = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol * Math.max(1, Math.abs(a), Math.abs(b));

// A board with a little of everything: bedrock, a crack, a slope field.
function terrainBoard(size = 9) {
  const b = new Board(size);
  b.terr[b.idx(2, 2)] = T_BEDROCK; b.kind[b.idx(2, 2)] = STONE;
  b.terr[b.idx(3, 2)] = T_BEDROCK; b.kind[b.idx(3, 2)] = STONE;
  b.terr[b.idx(6, 6)] = T_CRACK;
  for (const [x, y] of [[5, 3], [6, 3], [5, 4]]) { b.terr[b.idx(x, y)] = T_SLOPE; b.sdir[b.idx(x, y)] = 1; }
  b.rebuild();
  return b;
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

test('stones, slopes and cracks conserve sand', () => {
  const b = terrainBoard();
  let spilled = 0;
  for (let r = 0; r < 3000; r++) { b.add(b.idx(4, 4), 1); spilled += b.round().spilled; }
  for (let r = 0; r < 800; r++) spilled += b.round().spilled;
  assert.ok(Math.abs(b.totalGrains() + spilled - 3000) < 1e-9);
});

test('steady-state solver matches simulation (plain, folded, terrain)', () => {
  const cases = [];
  for (const fold of [false, true]) {
    const b = new Board(9);
    b.fold = fold;
    b.kind[b.idx(3, 4)] = STONE; b.kind[b.idx(5, 4)] = STONE; b.kind[b.idx(4, 3)] = STONE;
    b.rebuild();
    cases.push(['fold=' + fold, b]);
  }
  cases.push(['terrain', terrainBoard()]);
  for (const [name, b] of cases) {
    const src = b.idx(4, 4);
    const ones = new Float64Array(b.n);
    for (let i = 0; i < b.n; i++) ones[i] = b.isVoid(i) ? 0 : 1;
    const expected = b.solveValue(ones)[src];
    let topples = 0;
    const N = 20000;
    for (let r = 0; r < 300; r++) { b.add(src, 1); b.round(); }
    for (let r = 0; r < N; r++) { b.add(src, 1); topples += b.round().topples; }
    const per = topples / N;
    assert.ok(Math.abs(per - expected) / expected < 0.03, `${name}: sim ${per} vs solver ${expected}`);
  }
});

test('duality holds, with and without wind', () => {
  for (const wind of [false, true]) {
    const b = terrainBoard(11);
    if (wind) b.weights = [1, 2, 1, 0];
    b.kind[b.idx(5, 4)] = STONE; b.kind[b.idx(8, 8)] = CRYSTAL; b.val[b.idx(8, 8)] = 7;
    b.rebuild();
    assert.ok(b.allCellsDrain());
    const drop = new Float64Array(b.n); drop[b.idx(5, 5)] = 2; drop[b.idx(1, 8)] = 0.5;
    const u = b.solveTopples(drop);
    const v = b.solveValue(b.val);
    let a = 0, c = 0;
    for (let i = 0; i < b.n; i++) { a += u[i] * b.val[i]; c += drop[i] * v[i]; }
    assert.ok(Number.isFinite(a) && Math.abs(a - c) / c < 1e-6, `wind=${wind}: ${a} vs ${c}`);
  }
});

test('asymmetric rules never make the solver diverge', () => {
  // an east wind across a big table full of slopes used to blow up over-relaxation
  for (let seed = 1; seed <= 6; seed++) {
    const map = generateTable({ seed, tier: 8, arch: 'dunes' });
    const b = new Board(25);
    const w = terrainWindow(map, 25);
    b.terr.set(w.terr); b.sdir.set(w.sdir);
    for (let i = 0; i < b.n; i++) if (b.terr[i] === T_BEDROCK) b.kind[i] = STONE;
    b.weights = [1, 2, 1, 0];
    b.rebuild();
    const g = new Game({ analytic: true });
    g.boards[0] = b;
    g.ensureDrain(0, b);
    const ones = new Float64Array(b.n);
    for (let i = 0; i < b.n; i++) ones[i] = b.isVoid(i) ? 0 : 1;
    const v = b.solveValue(ones);
    for (let i = 0; i < b.n; i++) assert.ok(Number.isFinite(v[i]) && v[i] < 1e6, `seed ${seed} cell ${i}: ${v[i]}`);
  }
});

test('sand can never be trapped by stones', () => {
  const b = new Board(5);
  for (const [x, y] of [[1, 2], [3, 2], [2, 1]]) { assert.ok(b.canPlaceStone(b.idx(x, y))); b.kind[b.idx(x, y)] = STONE; }
  b.rebuild();
  assert.equal(b.canPlaceStone(b.idx(2, 3)), false, 'closing the ring must be refused');
});

test('generated tables always drain, at every size', () => {
  for (let tier = 1; tier <= 9; tier++) {
    for (let k = 0; k < 6; k++) {
      const seed = 1000 * tier + k;
      const map = generateTable({ seed, tier, first: tier === 1 && k === 0 });
      for (const size of SIZES) {
        const b = new Board(size);
        const w = terrainWindow(map, size);
        b.terr.set(w.terr); b.sdir.set(w.sdir);
        for (let i = 0; i < b.n; i++) if (b.terr[i] === T_BEDROCK) b.kind[i] = STONE;
        b.rebuild();
        assert.ok(b.allCellsDrain(), `tier ${tier} seed ${seed} size ${size}`);
      }
    }
  }
});

test('the first table: three dig sites at rings 2, 5 and 6, geodes near the centre', () => {
  const map = generateTable({ seed: 42, tier: 1, arch: 'first', first: true });
  const rings = map.digs.map(p => Math.max(Math.abs(p.mx - C), Math.abs(p.my - C))).sort((a, b) => a - b);
  assert.deepEqual(rings, [2, 5, 6]);
  const w = terrainWindow(map, 5);
  assert.ok(w.terr.some(t => t === T_GEODE), 'a geode on the starting 5×5');
  assert.ok(w.terr.some(t => t === T_DIG), 'a dig site on the starting 5×5');
});

test('each new kind of terrain is offered on the table that introduces it', () => {
  const R = mulberry32(5);
  assert.equal(candidateArchetypes(2, 2, R)[0], 'quarry');
  assert.equal(candidateArchetypes(3, 2, R)[0], 'spring');
  assert.equal(candidateArchetypes(4, 3, R)[0], 'dunes');
  assert.equal(candidateArchetypes(5, 2, R)[0], 'rift');
});

test('rule changes wear away terrain that would trap sand', () => {
  const g = new Game({ analytic: true });
  const b = g.boards[0];
  // a pocket open only to the west: an east wind (no westward grains) would trap it
  const c = b.idx(2, 2);
  for (const j of [b.idx(2, 1), b.idx(3, 2), b.idx(2, 3)]) { b.terr[j] = T_BEDROCK; b.kind[j] = STONE; }
  b.terr[c] = T_NONE; b.kind[c] = EMPTY;
  g.s.trial = 't_wind';
  g.applyRules(b, 0);
  assert.ok(b.allCellsDrain());
  assert.ok(g.s.edits.length >= 1, 'the change is remembered as a terrain edit');
});

test('relics go to sites that are deep enough', () => {
  const g = new Game({ analytic: true });
  g.s.digs = [];
  for (const ring of [1, 9, 3, 10, 0]) g.s.digs.push({ t: 0, mx: C + ring, my: C, ring, need: 1, prog: 0, relic: null, done: false });
  g.assignRelics();
  for (const d of g.s.digs) {
    if (d.relic === 'cache') continue;
    assert.ok(D.RELIC_MAP[d.relic].ring <= d.ring, `${d.relic} needs ring ${D.RELIC_MAP[d.relic].ring}, site is ${d.ring}`);
  }
  const ring0 = g.s.digs.find(d => d.ring === 0);
  assert.equal(ring0.relic, 'chisel', 'the nearest site gets the first relic');
  for (const id in D.RELIC_MAP) g.s.relics[id] = true;
  g.s.digs.forEach(d => { d.relic = null; });
  g.assignRelics();
  assert.ok(g.s.digs.every(d => d.relic === 'cache'), 'with every relic found, sites hold caches');
});

test('digging: the stack digs fastest on the site, and a dig yields its relic', () => {
  const g = new Game({ analytic: true });
  g.gainDust(1e4);
  for (let k = 0; k < 5; k++) g.buyBuilding('hourglass');
  const d = g.visibleDigs()[0];
  assert.ok(d, 'a dig site is visible on the first table');
  const site = g.digCell(d);
  const b = g.boards[0];
  const stack = b.hourglasses[0];
  const away = g.digRate(d);
  g.move(0, stack, site);
  const on = g.digRate(d);
  assert.ok(on > away * 2, `on the site ${on} vs away ${away}`);
  assert.ok(!g.has('stone'));
  for (let s = 0; s < 3600 && !d.done; s++) g.tick(1);
  assert.ok(d.done && g.s.relics.chisel, 'the first relic is the chisel');
  assert.ok(g.has('stone') && g.stoneLimit() > 0, 'which lets you set stones');
});

test('clicking a dig site digs it', () => {
  const g = new Game({ analytic: true });
  const d = g.visibleDigs()[0];
  const before = d.prog;
  g.click(d.t, g.digCell(d), 10);
  assert.ok(d.prog > before);
});

test('new hourglasses join the biggest stack', () => {
  const g = new Game({ analytic: true });
  g.gainDust(1e6);
  g.buyBuilding('hourglass');
  const b = g.boards[0];
  const first = b.hourglasses[0];
  g.move(0, first, 0);
  for (let k = 0; k < 8; k++) g.buyBuilding('hourglass');
  assert.equal(b.hourglasses.length, 1);
  assert.equal(b.hg[0], 9);
});

test('previews predict exactly what a move or a stone does', () => {
  const g = new Game({ analytic: true });
  g.gainDust(1e7);
  for (let k = 0; k < 12; k++) g.buyBuilding('hourglass');
  const b = g.boards[0];
  const from = b.hourglasses[0];
  const to = b.idx(0, 0);
  const r0 = g.baseRate();
  const pv = g.preview('hourglass', 0, to, from);
  assert.ok(pv.ok);
  g.move(0, from, to);
  assert.ok(close(g.baseRate() / r0, pv.ratio, 1e-6), `hourglass: ${g.baseRate() / r0} vs ${pv.ratio}`);
  g.s.relics.chisel = true; g.recomputeFx();
  g.s.owned.stone = 1; g.s.inv.stone = 1;
  const r1 = g.baseRate();
  const cell = [...Array(b.n).keys()].find(i => b.terr[i] === T_NONE && b.canPlaceStone(i) && i !== to);
  const sp = g.preview('stone', 0, cell);
  assert.ok(sp.ok);
  assert.ok(g.place('stone', 0, cell));
  assert.ok(close(g.baseRate() / r1, sp.ratio, 1e-5), `stone: ${g.baseRate() / r1} vs ${sp.ratio}`);
});

test('crystals only grow on geodes', () => {
  const g = new Game({ analytic: true });
  g.s.seen.crystal = true; g.recomputeFx();
  g.s.owned.crystal = 1; g.s.inv.crystal = 1;
  const b = g.boards[0];
  const plain = [...Array(b.n).keys()].find(i => b.terr[i] === T_NONE);
  const geode = [...Array(b.n).keys()].find(i => b.terr[i] === T_GEODE);
  assert.equal(g.place('crystal', 0, plain), false);
  assert.ok(g.place('crystal', 0, geode));
  assert.equal(g.geodeSlots(), [...b.terr].filter(t => t === T_GEODE).length);
});

test('the Shape tool breaks bedrock (within the limit) and turns slopes safely', () => {
  const g = new Game({ analytic: true });
  g.s.relics.pick = true; g.s.relics.vane = true; g.recomputeFx();
  const b = g.boards[0];
  const rocks = [];
  for (let k = 0; k < 4; k++) { const i = b.idx(k, 0); b.terr[i] = T_BEDROCK; b.kind[i] = STONE; rocks.push(i); }
  b.rebuild();
  for (let k = 0; k < 3; k++) assert.equal(g.shape(0, rocks[k]), 'break');
  assert.equal(g.shape(0, rocks[3]), false, 'only three per table per run');
  assert.equal(b.terr[rocks[0]], T_NONE);
  const s = b.idx(2, 4);
  b.terr[s] = T_SLOPE; b.sdir[s] = 0; b.rebuild();
  assert.equal(g.shape(0, s), 'turn');
  assert.notEqual(b.sdir[s], 0);
  assert.ok(b.allCellsDrain());
});

test('springs pour sand on their own', () => {
  const g = new Game({ analytic: true });
  const b = g.boards[0];
  b.terr[b.idx(1, 1)] = T_SPRING; b.rebuild(); g.layoutChanged();
  assert.equal(g.totalHourglasses(), 0);
  assert.ok(g.baseRate() > 0);
});

test('sweeping offers a choice of tables and plays the one chosen', () => {
  const g = new Game({ analytic: true, seed: 99 });
  g.gainDust(1e12);
  const c = g.candidates();
  assert.equal(c.length, 2);
  assert.deepEqual(g.candidates().map(x => x.seed), c.map(x => x.seed), 'stable until you sweep');
  g.s.relics.map = true; g.recomputeFx();
  assert.equal(g.candidates().length, 3, 'the Folded Map adds a third');
  const pick = g.candidates()[2];
  g.sweep(null, null, 2);
  assert.equal(g.mapFor(0).name, pick.name);
  assert.equal(g.s.tableDefs[0].seed, pick.seed);
  assert.notEqual(g.candidates()[0].seed, pick.seed, 'new candidates after a sweep');
});

test('a fresh run always has income or a way to get it', () => {
  const g = new Game({ analytic: true });
  assert.ok(g.canClick());
  g.gainDust(1e12);
  g.sweep();
  assert.ok(g.baseRate() > 0, 'after a sweep, the free hourglass pours');
  g.s.relics.tablet = true; g.recomputeFx();
  for (const t of D.TRIALS) {
    g.startTrial(t.id);
    assert.ok(g.baseRate() > 0 || g.canClick(), `trial ${t.id} has a way to earn`);
    assert.ok(Number.isFinite(g.baseRate()));
  }
});

test('save and load round-trip, terrain edits and digs included', () => {
  const g = new Game({ analytic: true, rng: mulberry32(7), seed: 7 });
  g.gainDust(1e9);
  for (let k = 0; k < 30; k++) g.buyBuilding('hourglass');
  g.buyUpgrade('u_hands');
  g.s.relics.pick = true; g.recomputeFx();
  const b = g.boards[0];
  const i = b.idx(0, 0);
  b.terr[i] = T_BEDROCK; b.kind[i] = STONE; b.rebuild();
  g.s.edits.push({ t: 0, ...Object.fromEntries([['mx', g.mapOfCell(b, i)[0]], ['my', g.mapOfCell(b, i)[1]]]), terr: T_BEDROCK });
  g.shape(0, i);
  g.s.digs[0].prog = 123;
  const json = g.serialize();
  const h = new Game({ analytic: true }).load(json);
  assert.ok(h);
  assert.equal(h.s.owned.hourglass, 30);
  assert.ok(h.s.up.u_hands && h.s.relics.pick);
  assert.equal(h.boards[0].terr[i], T_NONE, 'broken bedrock stays broken');
  assert.equal(h.s.digs[0].prog, 123);
  assert.equal(h.mapFor(0).name, g.mapFor(0).name);
  assert.ok(close(h.baseRate(), g.baseRate(), 1e-8));
});

test('saves from the first version are refused', () => {
  assert.equal(new Game({ analytic: true }).load({ v: 1, dust: 5 }), false);
});

test('content references are consistent', () => {
  for (const u of D.UPGRADES) {
    for (const r of u.req || []) assert.ok(D.UPGRADE_MAP[r], `${u.id} req ${r}`);
    if (u.kreq) assert.ok(D.KILN_MAP[u.kreq], `${u.id} kreq ${u.kreq}`);
  }
  for (const k of D.KILN) for (const r of k.req || []) assert.ok(D.KILN_MAP[r], `${k.id} req ${r}`);
  const ids = new Set();
  for (const a of D.ACHIEVEMENTS) { assert.ok(!ids.has(a.id)); ids.add(a.id); }
  let prev = 0;
  for (const r of D.RELICS) {
    assert.ok(r.ring >= prev, `${r.id}: relic rings never decrease`);
    prev = r.ring;
    assert.ok(r.name && r.desc && r.lore && r.icon);
  }
  for (const k in D.TERRAIN_TIPS) assert.ok(['geode', 'dig', 'bedrock', 'spring', 'slope', 'crack'].includes(k));
});

console.log(`${passed} tests passed`);
