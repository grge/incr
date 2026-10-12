// Prototype interface: tools (pour, taps, weights, the comb), the selected
// marker's controls, shop, scoring mode, overlays and a sandbox panel for
// experimenting with the mechanisms.
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

const TOOLS = [
  ['pour', '✋ Pour', '1'],
  ['tap', '⧗ Tap', '2'],
  ['weight', '● Weight', '3'],
  ['comb', '≋ Comb', '4'],
];
const TOOL_TIPS = {
  pour: 'Click or hold to drop sand. Drag a tap or weight to move it; click one to select it.',
  tap: 'Click to add a tap. Taps share one flow between them.',
  weight: 'Click to set a weight. It draws cells in and makes a well. Weights share one pull.',
  comb: 'Drag to stretch the ground along your stroke. Right-drag (or hold Alt) to smooth it back.',
};
const CUR = { dust: '✦', gems: '◆' };

export class UI {
  constructor(game, view, hooks) {
    this.g = game;
    this.v = view;
    this.hooks = hooks;
    this.tool = 'pour';
    this.overlay = 'none';
    this.showBuried = false;
    this.sel = null;       // { type: 'tap' | 'weight', k }
    this.drag = null;
    this.stroke = null;
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
      const t = TOOLS.find(x => x[2] === e.key);
      if (t) this.setTool(t[0]);
      else if (e.key === 'Escape') { this.select(null); this.setTool('pour'); }
      else if ((e.key === 'Delete' || e.key === 'Backspace') && this.sel) this.removeSel();
      else if ((e.key === '+' || e.key === '=') && this.sel) this.adjustSel(1);
      else if ((e.key === '-' || e.key === '_') && this.sel) this.adjustSel(-1);
    });
  }

  layout() {
    const wrap = $('boardWrap');
    const w = wrap.clientWidth;
    const narrow = window.innerWidth <= 900;
    const avH = narrow ? window.innerHeight * 0.62 : window.innerHeight - 190;
    this.v.resize(Math.max(280, Math.min(w, avH, 820)));
  }

  setTool(t) {
    this.tool = t;
    document.querySelectorAll('[data-tool]').forEach(b => b.classList.toggle('active', b.dataset.tool === t));
    this.pv = null;
  }

  select(sel) {
    this.sel = sel;
    this.buildSel();
  }

  // ---------------------------------------------------------------- input
  markerAt(x, y) { return this.g.markerAt(x, y, Math.max(6, 14 / this.v.scale)); }

  bindCanvas() {
    const cv = this.v.canvas;
    cv.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (this.tool === 'comb') return;
      const [x, y] = this.v.toRaster(e.clientX, e.clientY);
      const m = this.markerAt(x, y);
      if (m) this.remove(m);
    });
    cv.addEventListener('wheel', (e) => {
      const [x, y] = this.v.toRaster(e.clientX, e.clientY);
      const m = this.markerAt(x, y);
      if (!m) return;
      e.preventDefault();
      this.select(m);
      this.adjust(m, e.deltaY < 0 ? 1 : -1, e.shiftKey);
    }, { passive: false });
    cv.addEventListener('pointerdown', (e) => {
      const [x, y] = this.v.toRaster(e.clientX, e.clientY);
      if (this.tool === 'comb' && (e.button === 0 || e.button === 2)) {
        cv.setPointerCapture(e.pointerId);
        this.stroke = { last: [x, y], smooth: e.button === 2 || e.altKey };
        this.g.combStroke(x, y, x, y, this.stroke.smooth);
        return;
      }
      if (e.button !== 0) return;
      cv.setPointerCapture(e.pointerId);
      const m = this.markerAt(x, y);
      if (m) {
        this.select(m);
        this.drag = { ...m, sx: x, sy: y, active: false };
        return;
      }
      this.act(x, y);
    });
    cv.addEventListener('pointermove', (e) => {
      const [x, y] = this.v.toRaster(e.clientX, e.clientY);
      this.hoverPos = [x, y];
      if (this.stroke) {
        const [lx, ly] = this.stroke.last;
        if (Math.hypot(x - lx, y - ly) >= 1.5) {
          this.g.combStroke(lx, ly, x, y, this.stroke.smooth || e.altKey);
          this.stroke.last = [x, y];
        }
      }
      if (this.drag) {
        const d = this.drag;
        if (!d.active && Math.hypot(x - d.sx, y - d.sy) > 2) d.active = true;
        if (d.active) {
          if (d.type === 'tap') this.g.moveTap(d.k, x, y);
          else if (x >= 0 && y >= 0 && x < this.g.W && y < this.g.W) this.g.moveWeight(d.k, x, y);
        }
      }
      if (this.pour) this.pour.pos = [x, y];
    });
    const end = () => {
      this.drag = null;
      this.stroke = null;
      if (this.pour) { clearInterval(this.pour.timer); this.pour = null; }
    };
    cv.addEventListener('pointerup', end);
    cv.addEventListener('pointercancel', end);
    cv.addEventListener('pointerleave', () => { if (!this.drag && !this.stroke) this.hoverPos = null; });
  }

  act(x, y) {
    const g = this.g;
    if (this.tool === 'tap') {
      if (!g.addTap(x, y)) this.toast('', 'Taps must pour onto open ground.', 'warn');
      else this.select({ type: 'tap', k: g.s.taps.length - 1 });
    } else if (this.tool === 'weight') {
      if (!g.addWeight(x, y)) this.toast('', 'All your pull is in use. Lower another weight\'s pull, or buy a Lodestone.', 'warn');
      else this.select({ type: 'weight', k: g.s.weights.length - 1 });
    } else {
      if (this.sel) this.select(null);
      g.click(x, y);
      this.pour = { pos: [x, y], timer: setInterval(() => { if (this.pour) g.click(this.pour.pos[0], this.pour.pos[1]); }, 140) };
    }
  }

  adjust(m, dir, radius = false) {
    if (m.type === 'tap') this.g.adjustTap(m.k, dir);
    else this.g.adjustWeight(m.k, dir, radius);
    this.buildSel();
  }
  adjustSel(dir, radius = false) { if (this.sel) this.adjust(this.sel, dir, radius); }

  remove(m) {
    if (m.type === 'tap') { if (!this.g.removeTap(m.k)) { this.toast('', 'Keep at least one tap pouring.', 'warn'); return; } }
    else this.g.removeWeight(m.k);
    if (this.sel && this.sel.type === m.type) this.select(this.sel.k === m.k ? null : { type: m.type, k: this.sel.k - (this.sel.k > m.k ? 1 : 0) });
  }
  removeSel() { if (this.sel) this.remove(this.sel); }

  // The selected marker's controls (also the way to adjust them on touch screens).
  buildSel() {
    const box = $('sel');
    box.innerHTML = '';
    const g = this.g, m = this.sel;
    if (!m || (m.type === 'tap' && !g.s.taps[m.k]) || (m.type === 'weight' && !g.s.weights[m.k])) { this.sel = null; box.classList.add('hidden'); return; }
    box.classList.remove('hidden');
    const b = (label, fn, title) => h('button', { class: 'tool', title, onclick: fn }, label);
    if (m.type === 'tap') {
      const f = g.tapShare(m.k);
      box.append(h('span', { class: 'sel-name tap' }, '⧗ Tap'),
        h('span', {}, `${Math.round(f * 100)}% of the flow · ${fmt(g.flow() * f)} grains/s`),
        b('−', () => this.adjustSel(-1), 'Pour less here (−)'), b('+', () => this.adjustSel(1), 'Pour more here (+)'),
        b('Remove', () => this.removeSel(), 'Remove (Delete)'));
    } else {
      const w = g.s.weights[m.k];
      box.append(h('span', { class: 'sel-name weight' }, '● Weight'),
        h('span', {}, `pull ${w.pull} (${fmt(g.pullUsed())} of ${fmt(g.pullBudget())} used)`),
        b('−', () => this.adjustSel(-1), 'Less pull (−)'), b('+', () => this.adjustSel(1), 'More pull (+)'),
        h('span', { class: 'muted' }, 'size'), b('−', () => this.adjustSel(-1, true), 'Smaller (shift+wheel)'), b('+', () => this.adjustSel(1, true), 'Bigger (shift+wheel)'),
        b('Remove', () => this.removeSel(), 'Remove (Delete)'));
    }
  }

  // ---------------------------------------------------------------- per frame
  frame(dt) {
    const g = this.g;
    for (const e of g.drainEvents()) this.onEvent(e);
    const now = performance.now();
    let ghost = null, hint = null;
    const hp = this.hoverPos;
    const over = hp && !this.drag ? this.markerAt(hp[0], hp[1]) : null;
    if (this.drag && this.drag.active && this.drag.type === 'tap') {
      hint = this.tapHint(g.previewTap(hp[0], hp[1], this.drag.k), true);
    } else if (this.drag && this.drag.active && this.drag.type === 'weight') {
      hint = { text: 'The land is reshaping around the weight…' };
    } else if (over) {
      if (over.type === 'tap') hint = { text: `Tap: ${Math.round(g.tapShare(over.k) * 100)}% of the flow. Drag to move · wheel to pour more or less · right-click to remove.` };
      else hint = { text: `Weight: pull ${g.s.weights[over.k].pull}. Drag to move · wheel for pull, shift+wheel for size · right-click to remove.` };
    } else if (hp && this.tool === 'tap') {
      if (now - this.pvAt > 70) { this.pv = g.previewTap(hp[0], hp[1]); this.pvAt = now; }
      ghost = { type: 'tap', pos: hp, ok: !!(this.pv && this.pv.ok) };
      hint = this.tapHint(this.pv, false);
    } else if (hp && this.tool === 'weight') {
      const free = g.s.sandbox ? 2 : Math.min(2, g.pullBudget() - g.pullUsed());
      ghost = { type: 'weight', pos: hp, pull: Math.max(0, free), ok: free >= 0.5 };
      hint = free >= 0.5 ? { text: `${fmt(g.pullBudget() - g.pullUsed())} pull free.` } : { text: 'All your pull is in use.', cls: 'bad' };
    } else if (hp && this.tool === 'comb') {
      ghost = { type: 'comb', pos: hp, smooth: !!(this.stroke && this.stroke.smooth) };
    }
    if (g.moving && !hint && g.s.settings.relax) hint = { text: 'The land is settling…' };
    this.setHint(hint);
    const hover = hp ? g.cellAt(hp[0], hp[1]) : -1;
    this.v.draw(dt, { overlay: this.overlay, hover, ghost, selected: this.sel, showComb: this.tool === 'comb', showBuried: this.showBuried });
    this.updateInfo(hover);
    this.acc += dt;
    if (this.acc > 0.2) { this.acc = 0; for (const f of this.updaters) f(); }
  }

  tapHint(pv, moving) {
    if (!pv || !pv.ok) return { text: 'Taps must pour onto open ground.', cls: 'bad' };
    const pct = (pv.ratio - 1) * 100;
    const what = moving ? 'Here: ' : 'Add a tap here: ';
    const t = Math.abs(pct) < 0.05 ? 'no change to income.' : `${pct > 0 ? '+' : '−'}${Math.abs(pct).toFixed(Math.abs(pct) < 10 ? 1 : 0)}% income`;
    return { text: what + t, cls: pct > 0.05 ? 'good' : pct < -0.05 ? 'bad' : '' };
  }

  setHint(hint) {
    const el = $('hint');
    const text = hint ? hint.text : '';
    if (el.textContent !== text) el.textContent = text;
    el.className = text ? (hint.cls || '') : 'hidden';
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
      const z = g.region.zones[g.region.zone[p]];
      const parts = [
        (z ? RECIPES[z.recipe].name : '') + (g.region.river[p] ? ' (river)' : ''),
        `${nb} neighbour${nb === 1 ? '' : 's'}${exits.length ? ' + ' + exits.join(', ') : ''} → topples at ${gr.thr[c]}`,
        `${Math.floor(g.pile.grains[c])} grain${Math.floor(g.pile.grains[c]) === 1 ? '' : 's'}`,
        `${fmt(g.u[c])} topples/s`,
        `a grain here ≈ ${fmt(g.v[c] * g.valueMult())} dust`,
      ];
      const pr = g.pressureOf(gr.area[c]);
      parts.push(g.gem[c] > 0 ? `pressure ${pr.toFixed(1)} → ${fmt(g.gem[c] * g.gemMult())} ◆ per topple` : `pressure ${pr.toFixed(1)}`);
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
    } else if (e.type === 'region') { this.select(null); this.buildPanel(); }
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
      $('gems').textContent = fmt(s.gems);
      $('gemRate').textContent = `+${fmt(g.steady() ? g.expectedGems : g.gemEMA)}/s`;
      const N = g.denom();
      $('denom').textContent = N > 1 ? `1 grain = ${fmt(N)} sand (${g.denomName(N)})` : '1 grain = 1 sand';
    });

    panel.appendChild(h('details', { class: 'about', open: s.played < 60 ? true : null },
      h('summary', {}, 'About this prototype'),
      h('p', {}, 'Sand falls from taps. A cell topples when it holds as many grains as it has ways out (neighbours, plus the edge or a crack), and every topple earns dust.'),
      h('p', {}, 'How finely the ground is divided works like depth. Where cells are small, a grain needs many topples to get anywhere, so sand lingers: a well. You shape the land by deciding where it is deep:'),
      h('p', {}, h('b', {}, 'Taps'), ' share one flow, so adding one splits it. ', h('b', {}, 'Weights'), ' share one pull. Each draws cells in from the rest of the land and makes a well. ', h('b', {}, 'The comb'), ' stretches cells along your stroke, opening channels that sand runs along. The cells then settle into the shape you asked for.'),
      h('p', {}, 'Crowded cells (high pressure) also press out ', h('b', {}, 'gems'), ', which buy more pull and more ground. Turn on the Wells view to see the depth contours.'),
      h('p', {}, 'Sand wears the ground away, and things are buried, so watch for glints. The Survey switches scoring from the live sandpile to its exact average.')));

    // tools
    const tools = h('div', { class: 'tools' });
    for (const [id, label, key] of TOOLS) tools.appendChild(h('button', { class: 'tool' + (this.tool === id ? ' active' : ''), 'data-tool': id, title: `${TOOL_TIPS[id]} (${key})`, onclick: () => this.setTool(id) }, label));
    panel.append(h('h3', {}, 'Tools'), tools);
    const budgets = h('div', { class: 'stats' });
    const brow = (k, f) => { const v = h('span'); budgets.append(h('span', { class: 'k' }, k), v); upd(() => { v.textContent = f(); }); };
    brow('Flow', () => `${fmt(g.flow())} grains/s across ${s.taps.length} tap${s.taps.length > 1 ? 's' : ''}`);
    brow('Pull', () => `${fmt(g.pullUsed())} of ${fmt(g.pullBudget())} in ${s.weights.length} weight${s.weights.length === 1 ? '' : 's'}`);
    brow('Cells', () => `${g.g.n}`);
    panel.appendChild(budgets);

    // shop
    panel.appendChild(h('h3', {}, 'Shop'));
    for (const it of SHOP) {
      const btn = h('button', { class: 'btn buy ' + it.cur, onclick: () => g.buy(it.id) });
      const lvl = h('span', { class: 'lvl' });
      panel.appendChild(h('div', { class: 'shop-row' }, h('div', {}, h('div', { class: 'nm' }, it.name, lvl), h('div', { class: 'ds' }, it.desc)), btn));
      upd(() => {
        if (it.once && s[it.id]) { btn.textContent = 'Done'; btn.disabled = true; }
        else { btn.textContent = s.sandbox ? 'Free' : `${fmt(g.cost(it.id))} ${CUR[it.cur]}`; btn.disabled = !g.canBuy(it.id); }
        lvl.textContent = it.once ? '' : s.lv[it.id] ? ` · level ${s.lv[it.id]}` : '';
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
      scoreText.textContent = `${now} Live: ${fmt(g.liveEMA)}/s (${pct}% of the average) · average: ${fmt(g.expected)} ✦/s and ${fmt(g.expectedGems)} ◆/s.` + (s.survey ? '' : ' The Survey switches to the average.');
    });

    // the land
    panel.appendChild(h('h3', {}, 'The land'));
    const stats = h('div', { class: 'stats' });
    const rows = [
      ['Topples per grain', () => g.linger.toFixed(1)],
      ['Gem-pressing cells', () => `${g.gem.reduce((a, x) => a + (x > 0 ? 1 : 0), 0)}`],
      ['Highest pressure', () => { let m = 0; for (let c = 0; c < g.g.n; c++) m = Math.max(m, g.pressureOf(g.g.area[c])); return m.toFixed(1); }],
      ['Sand poured', () => `${fmt(g.realRate())}/s`],
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
    for (const [id, label] of [['none', 'Sand'], ['wells', 'Wells'], ['pressure', 'Pressure'], ['flow', 'Flow'], ['zones', 'Ground'], ['depth', 'Worn'], ['graph', 'Graph']]) {
      ov.appendChild(h('button', { class: 'tool' + (this.overlay === id ? ' active' : ''), 'data-ov': id, onclick: (e) => { this.overlay = id; ov.querySelectorAll('.tool').forEach(b => b.classList.toggle('active', b === e.currentTarget)); } }, label));
    }
    panel.appendChild(ov);
    panel.appendChild(h('p', { class: 'note' }, 'Wells: depth contours, darker where a grain earns more. Pressure: the crowded cells that press out gems. Flow: where sand topples most. Ground: the kinds of land and the comb. Worn: how far the ground has worn. Graph: neighbours and each cell\'s toppling threshold.'));

    // sandbox
    panel.appendChild(h('h3', {}, 'Sandbox'));
    const check = (id, label, get, set) => {
      const input = h('input', { type: 'checkbox', id, onchange: (e) => set(e.target.checked) });
      input.checked = !!get();
      panel.appendChild(h('div', { class: 'opt' }, input, h('label', { for: id }, label)));
    };
    check('sandbox', 'Free building (unlimited pull, upgrades cost nothing)', () => s.sandbox, v => { s.sandbox = v; this.buildSel(); });
    check('relax', 'The land settles into shape', () => s.settings.relax, v => { s.settings.relax = v; if (v) g.wake(); });
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
    ));
    panel.appendChild(h('div', { class: 'btn-row' },
      h('button', { class: 'btn', onclick: () => g.gain(Math.max(1000, s.dust * 9)) }, 'Dust ×10'),
      h('button', { class: 'btn', onclick: () => g.gainGems(Math.max(100, s.gems * 9)) }, 'Gems ×10'),
      h('button', { class: 'btn', onclick: () => { g.comb.fill(0); g.comb.set(g.region.comb); g.wake(); } }, 'Uncomb'),
    ));
    panel.appendChild(h('div', { class: 'btn-row' }, h('button', { class: 'btn warn', onclick: () => this.hooks.reset() }, 'Reset everything')));
    panel.appendChild(h('p', { class: 'note' }, 'Keys: 1 pour · 2 tap · 3 weight · 4 comb · +/− adjust the selected tap or weight · Delete removes it · Esc cancel.'));
    this.buildSel();
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
