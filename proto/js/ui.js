// Prototype interface: tools, shop, scoring mode, overlays and a sandbox
// panel for experimenting with the mechanisms.
import { SHOP } from './game.js';
import { RELICS, BURIED_KINDS, RECIPES, RECIPE_IDS } from './region.js';
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
  pour: 'Click or hold to drop sand. Drag a spout to move it; right-click one to pick it up.',
  spout: 'Click a cell to set a spout there. Hover to see what it would earn.',
  chisel: 'Click a cell to crack it in two. Hover to see what that would do.',
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
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
      if (e.key === '1') this.setTool('pour');
      else if (e.key === '2') this.setTool('spout');
      else if (e.key === '3') this.setTool('chisel');
      else if (e.key === 't' || e.key === 'T') this.g.tremor();
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
      const k = this.g.nearestSpout(x, y, 8);
      if (k >= 0 && !this.g.pocketSpout(k)) this.toast('', 'Keep at least one spout pouring.', 'warn');
    });
    cv.addEventListener('pointerdown', (e) => {
      if (e.button === 2) return;
      cv.setPointerCapture(e.pointerId);
      const [x, y] = this.v.toRaster(e.clientX, e.clientY);
      const k = this.g.nearestSpout(x, y, 8);
      if (k >= 0) this.drag = { k, sx: x, sy: y, pos: [x, y], active: false };
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
          const offBoard = x < 0 || y < 0 || x > this.g.W || y > this.g.W;
          if (offBoard) { if (!this.g.pocketSpout(d.k)) this.toast('', 'Keep at least one spout pouring.', 'warn'); }
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
    if (this.tool === 'spout') {
      if (g.s.inv.spout <= 0 && !g.s.sandbox) { this.toast('', 'No spouts in your pocket. Buy one in the shop.', 'warn'); return; }
      if (!g.placeSpout(x, y)) this.toast('', 'Spouts must pour onto open ground.', 'warn');
      else if (g.s.inv.spout <= 0 && !g.s.sandbox) this.setTool('pour');
    } else if (this.tool === 'chisel') {
      const r = g.chisel(x, y);
      if (r === 'empty') this.toast('', 'The chisel is blunt. It sharpens itself over time.', 'warn');
      else if (r === 'small') this.toast('', 'That cell is too small to crack.', 'warn');
      this.pv = null;
    } else {
      g.click(x, y);
      this.pour = { pos: [x, y], timer: setInterval(() => { if (this.pour) g.click(this.pour.pos[0], this.pour.pos[1]); }, 140) };
    }
  }

  // ---------------------------------------------------------------- per frame
  frame(dt) {
    const g = this.g;
    for (const e of g.drainEvents()) this.onEvent(e);
    const now = performance.now();
    let pv = null, ghost = null;
    if (this.drag && this.drag.active) {
      const [x, y] = this.drag.pos;
      if (now - this.pvAt > 70) { this.pv = g.previewSpout(x, y, this.drag.k); this.pvAt = now; }
      pv = this.pv;
    } else if (this.hoverPos && this.tool === 'spout' && (g.s.sandbox || g.s.inv.spout > 0)) {
      const [x, y] = this.hoverPos;
      if (now - this.pvAt > 70) { this.pv = g.previewSpout(x, y); this.pvAt = now; }
      pv = this.pv;
      ghost = { pos: [x, y], ok: !!(pv && pv.ok) };
    } else if (this.hoverPos && this.tool === 'chisel') {
      const [x, y] = this.hoverPos;
      if (now - this.pvAt > 90) { this.pv = g.previewChisel(x, y); this.pvAt = now; }
      pv = this.pv;
    }
    this.setHint(pv);
    const hover = this.hoverPos ? g.cellAt(this.hoverPos[0], this.hoverPos[1]) : -1;
    this.v.draw(dt, { overlay: this.overlay, hover, preview: pv, drag: this.drag, ghost, showBuried: this.showBuried });
    this.updateInfo(hover);
    this.acc += dt;
    if (this.acc > 0.2) { this.acc = 0; for (const f of this.updaters) f(); }
  }

  setHint(pv) {
    const el = $('hint');
    let text = '', cls = '';
    if (pv) {
      if (!pv.ok) {
        if (this.tool === 'chisel') text = pv.cell >= 0 ? 'Too small to crack.' : '';
        else text = 'Spouts must pour onto open ground.';
        cls = 'bad';
      } else {
        const pct = (pv.ratio - 1) * 100;
        const what = this.tool === 'chisel' ? 'Crack it: ' : '';
        text = what + (Math.abs(pct) < 0.05 ? 'no change to income.' : `${pct > 0 ? '+' : '−'}${Math.abs(pct).toFixed(Math.abs(pct) < 10 ? 1 : 0)}% income`);
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
      const sd = g.seedOf(c);
      const nb = gr.nbrStart[c + 1] - gr.nbrStart[c];
      const exits = [];
      if (gr.exE[c]) exits.push(`${gr.exE[c]} over the edge`);
      if (gr.exC[c]) exits.push(`${gr.exC[c]} into a crack`);
      const p = g.tess.pixel(this.hoverPos[0], this.hoverPos[1]);
      const slot = gr.slotOf[c];
      const parts = [
        (RECIPES[sd.z] || RECIPES.mud).name + (sd.w > 1 ? ' (boulder)' : ''),
        `${nb} neighbour${nb === 1 ? '' : 's'}${exits.length ? ' + ' + exits.join(', ') : ''} → topples at ${gr.thr[c]}`,
        `${Math.floor(g.pile.grains[c])} grain${Math.floor(g.pile.grains[c]) === 1 ? '' : 's'}`,
        `${fmt(g.u[c])} topples/s`,
        `a grain here ≈ ${fmt(g.v[c] * g.valueMult())} dust`,
      ];
      if (gr.area[c] >= g.minArea()) parts.push(`stress ${Math.min(99, Math.floor(100 * g.stress[slot] / g.crackAt(c)))}%`);
      else parts.push('too small to crack');
      if (g.oreN[c]) parts.push(`ore ${Math.round(100 * g.oreN[c] / gr.area[c])}%`);
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
      else if (b.kind === 'ore') this.toast('An ore vein', 'Topples on ore are worth up to five times as much.', 'good');
      else if (b.kind === 'cave') this.toast('The ground gives way', 'A hollow opened into a hole. Sand that falls in is lost.', 'warn');
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

    upd(() => {
      $('dust').textContent = fmt(s.dust);
      $('rate').textContent = `+${fmt(g.steady() ? g.expected : g.liveEMA)}/s`;
      const N = g.denom();
      $('denom').textContent = N > 1 ? `1 grain = ${fmt(N)} sand (${g.denomName(N)})` : '1 grain = 1 sand';
    });

    panel.appendChild(h('details', { class: 'about', open: s.played < 60 ? true : null },
      h('summary', {}, 'About this prototype'),
      h('p', {}, 'One region of a larger world, a patchwork of different ground. Spouts pour sand; a cell topples when it holds as many grains as it has ways out (neighbours, plus the edge or a crack), and every topple earns dust.'),
      h('p', {}, 'The land shapes itself. Cells crack in two where sand is busiest, so the ground grows finer around your spouts and each grain topples more times. Cracked ground that sand stops reaching settles back together. Where you pour decides where it cracks.'),
      h('p', {}, 'Sand also wears the ground away, fastest in small busy cells; things are buried, so watch for glints. The Chisel cracks a cell of your choosing; a Tremor shakes everything.'),
      h('p', {}, 'At first you earn from the live sandpile. On a big, fine land the live sand can\'t keep up; the Survey switches to its exact steady-state average.')));

    // tools
    const tools = h('div', { class: 'tools' });
    const cnt = h('span', { class: 'n' }), ch = h('span', { class: 'n' });
    tools.appendChild(h('button', { class: 'tool' + (this.tool === 'pour' ? ' active' : ''), 'data-tool': 'pour', onclick: () => this.setTool('pour') }, '✋ Pour'));
    tools.appendChild(h('button', { class: 'tool' + (this.tool === 'spout' ? ' active' : ''), 'data-tool': 'spout', onclick: () => this.setTool('spout') }, '⧗ Spouts', cnt));
    tools.appendChild(h('button', { class: 'tool' + (this.tool === 'chisel' ? ' active' : ''), 'data-tool': 'chisel', onclick: () => this.setTool('chisel') }, '⚒ Chisel', ch));
    const trem = h('button', { class: 'tool tremor', onclick: () => g.tremor() });
    tools.appendChild(trem);
    upd(() => {
      cnt.textContent = s.sandbox ? ' ∞' : ` ${s.inv.spout}`;
      ch.textContent = s.sandbox ? ' ∞' : ` ${Math.floor(s.chisel)}`;
      const ready = s.tremorCd <= 0 || s.sandbox;
      trem.textContent = ready ? '≋ Tremor' : `≋ ${Math.ceil(s.tremorCd)}s`;
      trem.disabled = !ready;
    });
    panel.append(h('h3', {}, 'Tools'), tools);

    // shop
    panel.appendChild(h('h3', {}, 'Shop'));
    for (const it of SHOP) {
      const btn = h('button', { class: 'btn buy', onclick: () => { if (g.buy(it.id) && it.item) this.setTool(it.id); } });
      const lvl = h('span', { class: 'lvl' });
      panel.appendChild(h('div', { class: 'shop-row' }, h('div', {}, h('div', { class: 'nm' }, it.name, lvl), h('div', { class: 'ds' }, it.desc)), btn));
      upd(() => {
        const maxed = it.max !== undefined && s.lv[it.id] >= it.max;
        if ((it.once && s[it.id]) || maxed) { btn.textContent = it.once ? 'Done' : 'Max'; btn.disabled = true; }
        else { btn.textContent = s.sandbox ? 'Free' : fmt(g.cost(it.id)); btn.disabled = !g.canBuy(it.id); }
        lvl.textContent = it.once ? '' : it.item ? ` · ${s.lv[it.id]} bought` : s.lv[it.id] ? ` · level ${s.lv[it.id]}` : '';
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
      const pct = g.expected > 0 ? Math.round(100 * g.liveEMA / g.expected) : 100;
      const now = g.steady() ? 'Earning the steady-state average.' : 'Earning from the topples you see.';
      scoreText.textContent = `${now} Live: ${fmt(g.liveEMA)}/s (${pct}% of the average) · average: ${fmt(g.expected)}/s.` + (s.survey ? '' : ' The Survey switches to the average.');
    });

    // the land
    panel.appendChild(h('h3', {}, 'The land'));
    const stats = h('div', { class: 'stats' });
    const rows = [
      ['Cells', () => `${g.g.n}`],
      ['Cracks / settled', () => `${s.stats.splits} / ${s.stats.merges}`],
      ['Topples per grain', () => g.linger.toFixed(1)],
      ['Sand poured', () => `${fmt(g.realRate())}/s`],
      ['Smallest a cell can crack', () => `${Math.round(g.minArea())} px`],
      ['Biggest avalanche', () => `${s.stats.maxWave} cells at once`],
      ['Time', () => fmtTime(s.played)],
    ];
    for (const [k, f] of rows) { const v = h('span'); stats.append(h('span', { class: 'k' }, k), v); upd(() => { v.textContent = f(); }); }
    panel.appendChild(stats);
    panel.appendChild(h('p', { class: 'note' }, 'Ground here: ' + g.region.zones.map(z => RECIPES[z.recipe].name).join(', ') + (g.region.river.some(Boolean) ? ', and a river' : '') + '.'));

    // finds
    panel.appendChild(h('h3', {}, 'Found'));
    this.findsEl = h('div', { class: 'finds' });
    panel.appendChild(this.findsEl);
    this.rebuildFinds();

    // view
    panel.appendChild(h('h3', {}, 'View'));
    const ov = h('div', { class: 'tools' });
    for (const [id, label] of [['none', 'Sand'], ['zones', 'Ground'], ['flow', 'Flow'], ['value', 'Value'], ['depth', 'Depth'], ['graph', 'Graph']]) {
      ov.appendChild(h('button', { class: 'tool' + (this.overlay === id ? ' active' : ''), onclick: (e) => { this.overlay = id; ov.querySelectorAll('.tool').forEach(b => b.classList.toggle('active', b === e.currentTarget)); } }, label));
    }
    panel.appendChild(ov);
    panel.appendChild(h('p', { class: 'note' }, 'Ground: the kinds of land. Flow: where sand topples most (where it will crack). Value: what a grain dropped there earns. Depth: how far the ground has worn. Graph: neighbours and each cell\'s toppling threshold.'));

    // sandbox
    panel.appendChild(h('h3', {}, 'Sandbox'));
    const check = (id, label, get, set) => {
      const input = h('input', { type: 'checkbox', id, onchange: (e) => set(e.target.checked) });
      input.checked = !!get();
      panel.appendChild(h('div', { class: 'opt' }, input, h('label', { for: id }, label)));
    };
    check('sandbox', 'Free building (spouts, chisel, tremor and upgrades cost nothing)', () => s.sandbox, v => { s.sandbox = v; });
    check('fracture', 'Busy cells crack', () => s.settings.fracture, v => { s.settings.fracture = v; });
    check('settle', 'Quiet cracked cells settle back', () => s.settings.settle, v => { s.settings.settle = v; });
    check('showb', 'Show everything buried', () => this.showBuried, v => { this.showBuried = v; });
    const speed = h('div', { class: 'tools' }, h('span', { class: 'small muted' }, 'Speed '));
    for (const x of [1, 4, 16, 64]) speed.appendChild(h('button', { class: 'tool' + (s.speed === x ? ' active' : ''), onclick: (e) => { s.speed = x; speed.querySelectorAll('.tool').forEach(b => b.classList.toggle('active', b === e.currentTarget)); } }, `${x}×`));
    panel.appendChild(speed);
    const seedIn = h('input', { type: 'number', value: String(s.seed), class: 'seed' });
    const recipe = h('select', { class: 'seed' }, h('option', { value: '' }, 'Mixed ground'), ...RECIPE_IDS.map(id => h('option', { value: id }, 'All ' + RECIPES[id].name.toLowerCase())));
    recipe.value = s.only || '';
    panel.appendChild(h('div', { class: 'btn-row' }, seedIn, recipe));
    panel.appendChild(h('div', { class: 'btn-row' },
      h('button', { class: 'btn', onclick: () => g.newRegion(+seedIn.value || 1, recipe.value || null) }, 'Load region'),
      h('button', { class: 'btn', onclick: () => g.newRegion(Math.floor(Math.random() * 1e6), recipe.value || null) }, 'Random region'),
      h('button', { class: 'btn', onclick: () => g.gain(Math.max(1000, s.dust * 9)) }, 'Dust ×10'),
    ));
    panel.appendChild(h('div', { class: 'btn-row' }, h('button', { class: 'btn warn', onclick: () => this.hooks.reset() }, 'Reset everything')));
    panel.appendChild(h('p', { class: 'note' }, 'Keys: 1 pour · 2 spouts · 3 chisel · T tremor · Esc cancel.'));
  }

  rebuildFinds() {
    const g = this.g, box = this.findsEl;
    if (!box) return;
    box.innerHTML = '';
    const found = g.s.found.map(i => g.region.buried[i]);
    if (!found.length) { box.appendChild(h('p', { class: 'note' }, 'Nothing yet. Where sand topples hardest the ground wears away, and small cells wear fastest. Look for glints.')); return; }
    for (const b of found) {
      if (b.kind === 'relic') { const r = RELICS.find(x => x.id === b.relic); box.appendChild(h('div', { class: 'find relic' }, h('b', {}, '✦ ' + r.name), ' — ' + r.desc)); }
      else box.appendChild(h('div', { class: 'find' }, BURIED_KINDS[b.kind].name));
    }
  }
}
