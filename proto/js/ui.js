// Prototype interface: tools, shop, scoring mode, overlays and a sandbox
// panel for experimenting with the mechanisms.
import { SHOP, SHOP_MAP, GAP, BUDGET } from './game.js';
import { RELICS, BURIED_KINDS } from './region.js';
import { fmt, fmtTime } from '../../js/format.js';

const $ = (id) => document.getElementById(id);

function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const k in attrs) {
    const v = attrs[k];
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
  }
  return el;
}

const TOOL_TIPS = {
  pour: 'Click or hold to drop sand. Drag stakes and spouts to move them; right-click one to pick it up.',
  stake: 'Click open ground to drive a stake: it carves a new cell out of its neighbours. Hover to see what it would do.',
  spout: 'Click a cell to set a spout there. Hover to see what it would earn.',
};

export class UI {
  constructor(game, view, hooks) {
    this.g = game;
    this.v = view;
    this.hooks = hooks;
    this.tool = 'pour';
    this.overlay = 'none';
    this.showBuried = false;
    this.drag = null;
    this.hoverPos = null;
    this.pv = null;
    this.pvAt = 0;
    this.updaters = [];
    this.acc = 0;
  }

  init() {
    this.buildPanel();
    this.bindCanvas();
    this.layout();
    window.addEventListener('resize', () => this.layout());
    window.addEventListener('keydown', (e) => {
      if (e.target.tagName === 'INPUT') return;
      if (e.key === '1') this.setTool('pour');
      else if (e.key === '2') this.setTool('stake');
      else if (e.key === '3') this.setTool('spout');
      else if (e.key === 'Escape') { this.drag = null; this.setTool('pour'); }
    });
  }

  layout() {
    const wrap = $('boardWrap');
    const w = wrap.clientWidth;
    const narrow = window.innerWidth <= 900;
    const avH = narrow ? window.innerHeight * 0.65 : window.innerHeight - 150;
    this.v.resize(Math.max(280, Math.min(w, avH, 820)));
  }

  setTool(t) {
    this.tool = t;
    document.querySelectorAll('[data-tool]').forEach(b => b.classList.toggle('active', b.dataset.tool === t));
    this.pv = null;
  }

  // ---------------------------------------------------------------- input
  bindCanvas() {
    const cv = this.v.canvas;
    cv.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const [x, y] = this.v.toRaster(e.clientX, e.clientY);
      const k = this.g.nearestSpout(x, y, 7);
      if (k >= 0) { this.g.pocketSpout(k); return; }
      const s = this.g.tess.nearestSeed(x, y, 6);
      if (s >= 0 && !this.g.pocketStake(s)) this.toast('', 'A region needs at least two stakes.', 'warn');
    });
    cv.addEventListener('pointerdown', (e) => {
      if (e.button === 2) return;
      cv.setPointerCapture(e.pointerId);
      const [x, y] = this.v.toRaster(e.clientX, e.clientY);
      const k = this.g.nearestSpout(x, y, 7);
      const s = k < 0 ? this.g.tess.nearestSeed(x, y, 6) : -1;
      if (k >= 0) this.drag = { type: 'spout', k, sx: x, sy: y, pos: [x, y], active: false };
      else if (s >= 0) this.drag = { type: 'stake', slot: s, sx: x, sy: y, pos: [x, y], active: false };
      else this.act(x, y);
    });
    cv.addEventListener('pointermove', (e) => {
      const [x, y] = this.v.toRaster(e.clientX, e.clientY);
      this.hoverPos = [x, y];
      if (this.drag) {
        this.drag.pos = [x, y];
        if (!this.drag.active && Math.hypot(x - this.drag.sx, y - this.drag.sy) > 3) this.drag.active = true;
      }
      if (this.pour) this.pour.pos = [x, y];
    });
    const end = (e) => {
      if (this.drag) {
        const d = this.drag;
        this.drag = null;
        const [x, y] = this.v.toRaster(e.clientX, e.clientY);
        if (d.active) {
          // dropped off the board: back into your pocket
          const offBoard = x < 0 || y < 0 || x > this.g.W || y > this.g.W;
          if (d.type === 'stake') {
            if (offBoard) { if (!this.g.pocketStake(d.slot)) this.toast('', 'A region needs at least two stakes.', 'warn'); }
            else if (!this.g.moveStake(d.slot, x, y)) this.toast('', 'Stakes need open ground, at least a little way from other stakes.', 'warn');
          } else if (offBoard) this.g.pocketSpout(d.k);
          else if (!this.g.moveSpout(d.k, x, y)) this.toast('', 'Spouts must pour onto open ground.', 'warn');
        } else if (e.type === 'pointerup') this.act(d.sx, d.sy);
        this.pv = null;
      }
      if (this.pour) { clearInterval(this.pour.timer); this.pour = null; }
    };
    cv.addEventListener('pointerup', end);
    cv.addEventListener('pointercancel', end);
    cv.addEventListener('pointerleave', () => { if (!this.drag) this.hoverPos = null; });
  }

  act(x, y) {
    const g = this.g;
    if (this.tool === 'stake') {
      if (g.s.inv.stake <= 0 && !g.s.sandbox) { this.toast('', 'No stakes in your pocket. Buy one in the shop.', 'warn'); return; }
      if (!g.placeStake(x, y)) this.toast('', 'Stakes need open ground, at least a little way from other stakes.', 'warn');
      else if (g.s.inv.stake <= 0 && !g.s.sandbox) this.setTool('pour');
      this.pv = null;
    } else if (this.tool === 'spout') {
      if (g.s.inv.spout <= 0 && !g.s.sandbox) { this.toast('', 'No spouts in your pocket. Buy one in the shop.', 'warn'); return; }
      if (!g.placeSpout(x, y)) this.toast('', 'Spouts must pour onto open ground.', 'warn');
      else if (g.s.inv.spout <= 0 && !g.s.sandbox) this.setTool('pour');
    } else {
      g.click(x, y);
      this.pour = { pos: [x, y], timer: setInterval(() => { if (this.pour) g.click(this.pour.pos[0], this.pour.pos[1]); }, 140) };
    }
  }

  // ---------------------------------------------------------------- per frame
  frame(dt) {
    const g = this.g;
    for (const e of g.drainEvents()) this.onEvent(e);
    // previews
    const now = performance.now();
    let pv = null, ghost = null;
    if (this.drag && this.drag.active) {
      const [x, y] = this.drag.pos;
      if (now - this.pvAt > 70) {
        this.pv = this.drag.type === 'stake' ? g.previewStake(x, y, this.drag.slot) : g.previewSpout(x, y, this.drag.k);
        this.pvAt = now;
      }
      pv = this.pv;
    } else if (this.hoverPos && (this.tool === 'stake' || this.tool === 'spout')) {
      const [x, y] = this.hoverPos;
      const has = g.s.sandbox || g.s.inv[this.tool] > 0;
      if (has && now - this.pvAt > 70) {
        this.pv = this.tool === 'stake' ? g.previewStake(x, y) : g.previewSpout(x, y);
        this.pvAt = now;
      }
      pv = has ? this.pv : null;
      if (has) ghost = { type: this.tool, pos: [x, y], ok: !!(pv && pv.ok) };
    }
    this.setHint(pv);
    const hover = this.hoverPos ? g.cellAt(this.hoverPos[0], this.hoverPos[1]) : -1;
    const hoverStake = this.hoverPos && !this.drag ? g.tess.nearestSeed(this.hoverPos[0], this.hoverPos[1], 6) : -1;
    this.v.draw(dt, { overlay: this.overlay, hover, hoverStake, preview: pv, drag: this.drag, ghost, showBuried: this.showBuried });
    this.updateInfo(hover);
    this.acc += dt;
    if (this.acc > 0.2) { this.acc = 0; for (const f of this.updaters) f(); }
  }

  setHint(pv) {
    const el = $('hint');
    let text = '', cls = '';
    if (pv) {
      if (!pv.ok) { text = this.drag ? 'Can\'t go there.' : (this.tool === 'stake' ? 'Stakes need open ground, a little way from other stakes.' : 'Spouts must pour onto open ground.'); cls = 'bad'; }
      else {
        const pct = (pv.ratio - 1) * 100;
        text = Math.abs(pct) < 0.05 ? 'No change to income.' : `${pct > 0 ? '+' : '−'}${Math.abs(pct).toFixed(Math.abs(pct) < 10 ? 1 : 0)}% income`;
        cls = pct > 0.05 ? 'good' : pct < -0.05 ? 'bad' : '';
      }
    }
    el.textContent = text;
    el.className = text ? cls : 'hidden';
  }

  updateInfo(c) {
    const g = this.g, gr = g.g;
    let text = ' ';
    if (c >= 0) {
      const nb = gr.nbrStart[c + 1] - gr.nbrStart[c];
      const exits = [];
      if (gr.exE[c]) exits.push(`${gr.exE[c]} over the edge`);
      if (gr.exC[c]) exits.push(`${gr.exC[c]} into a crack`);
      const p = g.tess.pixel(this.hoverPos[0], this.hoverPos[1]);
      const parts = [
        `${nb} neighbour${nb === 1 ? '' : 's'}${exits.length ? ' + ' + exits.join(', ') : ''} → topples at ${gr.thr[c]}`,
        `${Math.floor(g.pile.grains[c])} grain${Math.floor(g.pile.grains[c]) === 1 ? '' : 's'}`,
        `${fmt(g.u[c])} topples/s`,
        `a grain here ≈ ${fmt(g.v[c] * g.valueMult())} dust`,
        `size ${Math.round(gr.area[c])}`,
      ];
      if (g.oreN[c]) parts.push(`ore ${Math.round(100 * g.oreN[c] / gr.area[c])}% (×${g.val[c].toFixed(2)})`);
      if (p >= 0 && g.depth[p] > 0.05) parts.push(`worn ${g.depth[p].toFixed(1)} deep`);
      text = parts.join(' · ');
    } else if (this.hoverPos) text = TOOL_TIPS[this.tool];
    const el = $('info');
    if (el.textContent !== text) el.textContent = text;
  }

  onEvent(e) {
    const g = this.g;
    if (e.type === 'find') {
      const b = e.b;
      if (b.kind === 'relic') {
        const r = RELICS.find(x => x.id === b.relic);
        this.modal(h('div', { class: 'reveal' }, h('div', { class: 'small muted' }, 'The sand wore away to reveal'), h('div', { class: 'big-icon' }, '✦'), h('h2', {}, r.name), h('p', {}, r.desc)), [{ label: 'Keep it' }]);
      } else if (b.kind === 'spring') this.toast('A spring!', 'Sand wells up out of the ground here, all on its own.', 'good');
      else if (b.kind === 'ore') this.toast('An ore vein', 'Topples on ore are worth up to five times as much. Small cells over it make the most of it.', 'good');
      else if (b.kind === 'cave') this.toast('The ground gives way', 'A hollow opened into a hole. Sand that falls in is lost; anything standing there went back to your pocket.', 'warn');
      this.rebuildFinds();
    } else if (e.type === 'denom') {
      this.toast('The sand coarsens', `Each grain you see is now ${fmt(e.N)} grains of sand (${g.denomName(e.N)}).`, 'info');
    } else if (e.type === 'survey') {
      this.toast('The Survey', 'You now earn the exact average of what the sand does. Switch back to live scoring any time to compare.', 'good');
      this.buildPanel();
    } else if (e.type === 'region') this.buildPanel();
  }

  toast(title, text, kind = 'info') {
    const box = $('toasts');
    const el = h('div', { class: 'toast ' + kind }, title ? h('div', { class: 'tt' }, title) : null, h('div', {}, text));
    box.appendChild(el);
    while (box.children.length > 4) box.removeChild(box.firstChild);
    setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 400); }, 4500);
  }

  modal(content, actions) {
    const card = $('modalCard');
    card.innerHTML = '';
    card.appendChild(content);
    const row = h('div', { class: 'actions' });
    for (const a of actions) row.appendChild(h('button', { class: 'btn primary', onclick: () => { if (a.fn) a.fn(); $('modal').classList.add('hidden'); } }, a.label));
    card.appendChild(row);
    $('modal').classList.remove('hidden');
  }

  // ---------------------------------------------------------------- panel
  buildPanel() {
    const g = this.g, s = g.s;
    const panel = $('panel');
    panel.innerHTML = '';
    this.updaters = [];
    const upd = (f) => { this.updaters.push(f); f(); };

    // header numbers
    upd(() => {
      $('dust').textContent = fmt(s.dust);
      const steady = s.survey && s.mode === 'steady';
      $('rate').textContent = `+${fmt(steady ? g.expected : g.liveEMA)}/s`;
      const N = g.denom();
      $('denom').textContent = N > 1 ? `1 grain = ${fmt(N)} sand (${g.denomName(N)})` : '1 grain = 1 sand';
    });

    panel.appendChild(h('details', { class: 'about', open: s.played < 60 ? true : null },
      h('summary', {}, 'About this prototype'),
      h('p', {}, 'One region of a larger world. Spouts pour sand; a cell topples when it holds as many grains as it has ways out (neighbours, plus the edge or a crack), and every topple earns dust.'),
      h('p', {}, 'Stakes carve the land into cells. Add them, drag them, pick them up (right-click) and watch where the sand goes. Rock is a wall; cracks and the edge swallow sand.'),
      h('p', {}, 'Where sand topples hardest the ground wears away, and small cells wear fastest. Things are buried: watch for glints.'),
      h('p', {}, 'At first you earn from the live sandpile. The Survey switches to its exact steady-state average.')));

    // tools
    const tools = h('div', { class: 'tools' });
    for (const [id, label] of [['pour', '✋ Pour'], ['stake', '⚑ Stakes'], ['spout', '⧗ Spouts']]) {
      const cnt = h('span', { class: 'n' });
      tools.appendChild(h('button', { class: 'tool' + (this.tool === id ? ' active' : ''), 'data-tool': id, onclick: () => this.setTool(id) }, label, cnt));
      if (id !== 'pour') upd(() => { cnt.textContent = s.sandbox ? ' ∞' : ` ${s.inv[id]}`; });
    }
    panel.append(h('h3', {}, 'Tools'), tools);

    // shop
    panel.appendChild(h('h3', {}, 'Shop'));
    for (const it of SHOP) {
      if (it.once && s[it.id] && it.id !== 'survey') continue;
      const btn = h('button', { class: 'btn buy', onclick: () => { if (g.buy(it.id)) { if (it.item) this.setTool(it.id); } } });
      const lvl = h('span', { class: 'lvl' });
      panel.appendChild(h('div', { class: 'shop-row' }, h('div', {}, h('div', { class: 'nm' }, it.name, lvl), h('div', { class: 'ds' }, it.desc)), btn));
      upd(() => {
        if (it.once && s[it.id]) { btn.textContent = 'Done'; btn.disabled = true; return; }
        const c = g.cost(it.id);
        btn.textContent = s.sandbox ? 'Free' : fmt(c);
        btn.disabled = !g.canBuy(it.id);
        lvl.textContent = it.once ? '' : it.item ? ` · ${s.lv[it.id]} bought` : s.lv[it.id] ? ` · ×${Math.pow(2, s.lv[it.id])}` : '';
      });
    }

    // scoring
    panel.appendChild(h('h3', {}, 'Scoring'));
    const scoreText = h('p', { class: 'note' });
    panel.appendChild(scoreText);
    if (s.survey) {
      const row = h('div', { class: 'tools' });
      for (const [m, label] of [['live', 'Live sandpile'], ['steady', 'Steady state']]) {
        row.appendChild(h('button', { class: 'tool' + (s.mode === m ? ' active' : ''), onclick: () => { s.mode = m; this.buildPanel(); } }, label));
      }
      panel.appendChild(row);
    }
    upd(() => {
      const live = s.survey && s.mode === 'steady' ? 'Earning the steady-state average.' : 'Earning from the topples you see.';
      scoreText.textContent = `${live} Live (last few seconds): ${fmt(g.liveEMA)}/s · steady-state average: ${fmt(g.expected)}/s.` + (s.survey ? '' : ' The Survey switches to the average.');
    });

    // the land
    panel.appendChild(h('h3', {}, 'The land'));
    const stats = h('div', { class: 'stats' });
    const rows = [
      ['Cells', () => `${g.g.n}`],
      ['Average neighbours', () => { let t = 0; for (let c = 0; c < g.g.n; c++) t += g.g.nbrStart[c + 1] - g.g.nbrStart[c]; return (t / Math.max(1, g.g.n)).toFixed(1); }],
      ['Topples per grain', () => g.linger.toFixed(1)],
      ['Sand poured', () => `${fmt(g.realRate())}/s`],
      ['Biggest avalanche', () => `${s.stats.maxWave} cells at once`],
      ['Time', () => fmtTime(s.played)],
    ];
    for (const [k, f] of rows) { const v = h('span'); stats.append(h('span', { class: 'k' }, k), v); upd(() => { v.textContent = f(); }); }
    panel.appendChild(stats);

    // finds
    panel.appendChild(h('h3', {}, 'Found'));
    this.findsEl = h('div', { class: 'finds' });
    panel.appendChild(this.findsEl);
    this.rebuildFinds();

    // view
    panel.appendChild(h('h3', {}, 'View'));
    const ov = h('div', { class: 'tools' });
    for (const [id, label] of [['none', 'Sand'], ['flow', 'Flow'], ['value', 'Value'], ['depth', 'Depth'], ['graph', 'Graph']]) {
      ov.appendChild(h('button', { class: 'tool' + (this.overlay === id ? ' active' : ''), onclick: (e) => { this.overlay = id; ov.querySelectorAll('.tool').forEach(b => b.classList.toggle('active', b === e.currentTarget)); } }, label));
    }
    panel.appendChild(ov);
    panel.appendChild(h('p', { class: 'note' }, 'Flow: where sand topples most. Value: what a grain dropped there earns. Depth: how far the ground has worn. Graph: who neighbours whom, and each cell\'s toppling threshold (orange cells have exits).'));

    // sandbox
    panel.appendChild(h('h3', {}, 'Sandbox'));
    const sb = h('input', { type: 'checkbox', id: 'sandbox', onchange: (e) => { s.sandbox = e.target.checked; } });
    sb.checked = !!s.sandbox;
    const sh = h('input', { type: 'checkbox', id: 'showb', onchange: (e) => { this.showBuried = e.target.checked; } });
    sh.checked = this.showBuried;
    panel.appendChild(h('div', { class: 'opt' }, sb, h('label', { for: 'sandbox' }, 'Free building (stakes, spouts and upgrades cost nothing)')));
    panel.appendChild(h('div', { class: 'opt' }, sh, h('label', { for: 'showb' }, 'Show everything buried')));
    const speed = h('div', { class: 'tools' }, h('span', { class: 'small muted' }, 'Speed '));
    for (const x of [1, 4, 16, 64]) speed.appendChild(h('button', { class: 'tool' + (s.speed === x ? ' active' : ''), onclick: (e) => { s.speed = x; speed.querySelectorAll('.tool').forEach(b => b.classList.toggle('active', b === e.currentTarget)); } }, `${x}×`));
    panel.appendChild(speed);
    const seedIn = h('input', { type: 'number', value: String(s.seed), class: 'seed' });
    panel.appendChild(h('div', { class: 'btn-row' },
      h('button', { class: 'btn', onclick: () => g.relax(), title: 'Move every stake to the middle of its cell (Lloyd relaxation): cells become rounder and more even.' }, 'Relax stakes'),
      h('button', { class: 'btn', onclick: () => g.gain(Math.max(1000, s.dust * 9)) }, 'Dust ×10'),
    ));
    panel.appendChild(h('div', { class: 'btn-row' },
      seedIn,
      h('button', { class: 'btn', onclick: () => g.newRegion(+seedIn.value || 1) }, 'Load region'),
      h('button', { class: 'btn', onclick: () => g.newRegion(Math.floor(Math.random() * 1e6)) }, 'Random region'),
    ));
    panel.appendChild(h('div', { class: 'btn-row' }, h('button', { class: 'btn warn', onclick: () => this.hooks.reset() }, 'Reset everything')));
    panel.appendChild(h('p', { class: 'note' }, `Keys: 1 pour · 2 stakes · 3 spouts · Esc cancel. Stakes must be ${GAP} units apart. The live sandpile shows at most ~${BUDGET} grains a second; beyond that each grain stands for more sand.`));
  }

  rebuildFinds() {
    const g = this.g, box = this.findsEl;
    if (!box) return;
    box.innerHTML = '';
    const found = g.s.found.map(i => g.region.buried[i]);
    if (!found.length) { box.appendChild(h('p', { class: 'note' }, 'Nothing yet. Where sand topples hardest, the ground wears away — and small cells wear away fastest. Look for glints.')); return; }
    for (const b of found) {
      if (b.kind === 'relic') { const r = RELICS.find(x => x.id === b.relic); box.appendChild(h('div', { class: 'find relic' }, h('b', {}, '✦ ' + r.name), ' — ' + r.desc)); }
      else box.appendChild(h('div', { class: 'find' }, BURIED_KINDS[b.kind].name));
    }
  }
}
