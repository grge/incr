// Skirmish interface: score bar, tools, the selected spout or well, events,
// and the end of the match.
import { NEUTRAL, RULES } from './war.js';
import { COLORS } from './view.js';
import { fmtTime } from '../../../js/format.js';

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
const f1 = (x) => (x < 10 ? x.toFixed(1) : String(Math.round(x)));

export class UI {
  constructor(app) {
    this.app = app;
    this.tool = 'select';
    this.sel = null;          // { type: 'spout', k } | { type: 'well', w }
    this.drag = null;
    this.hoverPos = null;
    this.acc = 0;
  }
  get war() { return this.app.war; }
  get view() { return this.app.view; }

  init() {
    this.buildPanel();
    this.bindCanvas();
    this.layout();
    window.addEventListener('resize', () => this.layout());
    window.addEventListener('keydown', (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
      if (e.key === '1') this.setTool('select');
      else if (e.key === '2') this.setTool('well');
      else if (e.key === ' ') { e.preventDefault(); this.app.togglePause(); this.buildPanel(); }
      else if (e.key === 'Escape') { this.select(null); this.setTool('select'); }
      else if ((e.key === 'Delete' || e.key === 'Backspace') && this.sel && this.sel.type === 'well') this.lift(this.sel.w);
      else if ((e.key === '+' || e.key === '=') && this.sel) this.adjust(this.sel, 1);
      else if ((e.key === '-' || e.key === '_') && this.sel) this.adjust(this.sel, -1);
    });
  }

  layout() {
    const w = $('boardWrap').clientWidth;
    const narrow = window.innerWidth <= 900;
    const avH = narrow ? window.innerHeight * 0.6 : window.innerHeight - 200;
    this.view.resize(Math.max(280, Math.min(w, avH, 860)));
  }

  setTool(t) {
    this.tool = t;
    document.querySelectorAll('[data-tool]').forEach(b => b.classList.toggle('active', b.dataset.tool === t));
  }

  select(sel) { this.sel = sel; this.buildSel(); }

  // ---------------------------------------------------------------- input
  markerAt(x, y) {
    const r = Math.max(6, 14 / this.view.scale);
    const w = this.war.nearestWell(x, y, r);
    if (w) return { type: 'well', w };
    const k = this.war.nearestSpout(x, y, r);
    return k >= 0 ? { type: 'spout', k } : null;
  }

  bindCanvas() {
    const cv = this.view.canvas;
    cv.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const [x, y] = this.view.toRaster(e.clientX, e.clientY);
      const m = this.markerAt(x, y);
      if (m && m.type === 'well' && m.w.owner === 0) this.lift(m.w);
    });
    cv.addEventListener('wheel', (e) => {
      const [x, y] = this.view.toRaster(e.clientX, e.clientY);
      const m = this.markerAt(x, y);
      if (!m || !this.mine(m)) return;
      e.preventDefault();
      this.select(m);
      this.adjust(m, e.deltaY < 0 ? 1 : -1, e.shiftKey);
    }, { passive: false });
    cv.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      cv.setPointerCapture(e.pointerId);
      const [x, y] = this.view.toRaster(e.clientX, e.clientY);
      const m = this.markerAt(x, y);
      if (m) {
        this.select(m);
        if (m.type === 'well' && m.w.owner === 0) this.drag = { w: m.w, sx: x, sy: y, active: false };
        return;
      }
      if (this.tool === 'well') {
        const r = this.war.addWell(0, x, y, RULES.maxPull);
        if (typeof r === 'string') this.toast('', r === 'not yours' ? 'Wells go on your own land.' : r === 'no pull' ? 'All your pull is in use. Take more spouts, or lift a well.' : 'The match is over.', 'warn');
        else { this.select({ type: 'well', w: r }); this.setTool('select'); }
      } else this.select(null);
    });
    cv.addEventListener('pointermove', (e) => {
      const [x, y] = this.view.toRaster(e.clientX, e.clientY);
      this.hoverPos = [x, y];
      const d = this.drag;
      if (d) {
        if (!d.active && Math.hypot(x - d.sx, y - d.sy) > 3) d.active = true;
        if (d.active && this.war.wells.includes(d.w)) this.war.moveWell(d.w, x, y);
      }
    });
    const end = () => { this.drag = null; };
    cv.addEventListener('pointerup', end);
    cv.addEventListener('pointercancel', end);
    cv.addEventListener('pointerleave', () => { if (!this.drag) this.hoverPos = null; });
  }

  mine(m) { return m.type === 'well' ? m.w.owner === 0 : this.war.spouts[m.k].owner === 0; }

  adjust(m, dir, radius = false) {
    if (!this.mine(m)) return;
    if (m.type === 'well') this.war.adjustWell(m.w, dir, radius);
    else this.war.adjustShare(m.k, dir);
    this.refreshSel();
  }

  lift(w) {
    if (!this.war.wells.includes(w)) return;
    const held = w.extra;
    this.war.liftWell(w);
    if (held > 0) this.toast('', `Lifted: ${held} cell${held === 1 ? '' : 's'} burst out over the front.`, 'good');
    if (this.sel && this.sel.w === w) this.select(null);
  }

  // ---------------------------------------------------------------- selected
  // What the bar shows depends on this; when it changes the bar is rebuilt,
  // otherwise only its text is refreshed (so buttons are never swapped mid-click).
  selKind() {
    const m = this.sel;
    if (!m) return '';
    if (m.type === 'well') return this.war.wells.includes(m.w) ? `w${m.w.id}` : '';
    return `s${m.k}:${this.war.spouts[m.k].owner}`;
  }

  refreshSel() {
    if (this.selKind() !== this.selShown) this.buildSel();
    else if (this.selText) this.selText();
  }

  buildSel() {
    const box = $('sel');
    box.innerHTML = '';
    this.selText = null;
    this.selShown = this.selKind();
    const war = this.war, m = this.sel;
    if (!this.selShown) { this.sel = null; box.classList.add('hidden'); return; }
    box.classList.remove('hidden');
    const live = (f) => { const el = h('span'); this.selText = () => { const t = f(); if (el.textContent !== t) el.textContent = t; }; this.selText(); return el; };
    const b = (label, fn, title, cls = 'tool') => h('button', { class: cls, title, onclick: fn }, label);
    if (m.type === 'spout') {
      const sp = war.spouts[m.k];
      if (sp.owner === 0) {
        box.append(h('span', { class: 'sel-name you' }, sp.home !== null ? '⧗ Home spout' : '⧗ Spout'),
          live(() => { const rate = war.spoutRate(m.k); return `${f1(rate)} grains/s · ${Math.round(100 * rate / Math.max(1e-9, war.flow(0)))}% of your flow`; }),
          b('−', () => this.adjust(m, -1), 'Pour less here (−)'), b('+', () => this.adjust(m, 1), 'Pour more here (+)'));
      } else {
        box.append(h('span', { class: 'sel-name ' + (sp.owner === 1 ? 'rival' : '') }, sp.owner === 1 ? '⧗ Rival spout' : '⧗ Free spout'),
          h('span', { class: 'muted' }, 'Take the cell under it and it pours for you, and gives you pull for wells.'));
      }
    } else {
      const w = m.w;
      if (w.owner === 0) {
        box.append(h('span', { class: 'sel-name you' }, '● Well'),
          live(() => `pull ${w.pull} · holds ${w.extra} of ${Math.floor(war.capacity(w))} cells`),
          b('−', () => this.adjust(m, -1), 'Less pull (−)'), b('+', () => this.adjust(m, 1), 'More pull (+)'),
          h('span', { class: 'muted' }, 'size'), b('−', () => this.adjust(m, -1, true), 'Smaller: a tighter pocket, shorter reach (shift+wheel)'), b('+', () => this.adjust(m, 1, true), 'Bigger: a wider pocket, longer reach (shift+wheel)'),
          b('Lift ↯', () => this.lift(w), 'Lift it: its cells burst out over the front (right-click, Delete)', 'tool lift'));
      } else {
        box.append(h('span', { class: 'sel-name rival' }, '● Rival well'),
          live(() => `holds ${w.extra} cells. Take the ground under it for ${RULES.wellGrace}s to break it.`));
      }
    }
  }

  // ---------------------------------------------------------------- per frame
  frame(dt) {
    const war = this.war;
    for (const e of war.drainEvents()) this.onEvent(e);
    const hp = this.hoverPos;
    let ghost = null, hint = null, hoverWell = null;
    const over = hp && !this.drag ? this.markerAt(hp[0], hp[1]) : null;
    if (over && over.type === 'well') hoverWell = over.w;
    if (this.drag && this.drag.active) hint = { text: 'Wells must stay on your land.' };
    else if (over) {
      if (over.type === 'well') hint = { text: over.w.owner === 0 ? `Your well: holds ${over.w.extra} cells. Drag · wheel for pull · shift+wheel for size and reach · right-click to lift.` : `Rival well: holds ${over.w.extra} cells.` };
      else {
        const sp = war.spouts[over.k];
        hint = { text: sp.owner === 0 ? `Your spout: ${f1(war.spoutRate(over.k))} grains/s. Wheel or +/− to pour more or less here.` : sp.owner === 1 ? 'Rival spout. Take the cell under it.' : 'Free spout, guarded by a little sand. Take the cell under it.' };
      }
    } else if (hp && this.tool === 'well') {
      const ok = war.ownerAt(hp[0], hp[1]) === 0 && war.pullFree(0) >= 0.5;
      ghost = { pos: hp, ok, pull: Math.min(RULES.maxPull, Math.max(0.5, war.pullFree(0))) };
      hint = ok ? { text: `A well here would swallow cells that aren't yours within its reach. ${f1(war.pullFree(0))} pull free.` }
        : { text: war.pullFree(0) < 0.5 ? 'All your pull is in use.' : 'Wells go on your own land.', cls: 'bad' };
    }
    if (this.app.paused && !war.over) hint = { text: 'Paused. Space to carry on.' };
    this.setHint(hint);
    const hover = hp ? war.cellAt(hp[0], hp[1]) : -1;
    this.view.draw(dt, { hover, ghost, selected: this.sel, hoverWell });
    this.updateInfo(hover);
    this.acc += dt;
    if (this.acc > 0.2) { this.acc = 0; this.updateScore(); this.refreshSel(); }
  }

  setHint(hint) {
    const el = $('hint');
    const text = hint ? hint.text : '';
    if (el.textContent !== text) el.textContent = text;
    el.className = text ? (hint.cls || '') : 'hidden';
  }

  updateInfo(c) {
    const war = this.war, g = war.g;
    let text = ' ';
    if (c >= 0) {
      const o = war.own[c];
      const who = o === 0 ? 'Yours' : o === 1 ? "Rival's" : "No one's";
      const gr = Math.floor(war.grains[c]);
      text = `${who} · ${gr} grain${gr === 1 ? '' : 's'}` + (o === NEUTRAL ? (gr ? ' guarding it' : '') : ` · topples at ${g.thr[c]}`);
    } else if (this.hoverPos) text = this.tool === 'well' ? 'Click your land to set a well.' : 'Click a spout or well to select it.';
    const el = $('info');
    if (el.textContent !== text) el.textContent = text;
  }

  updateScore() {
    const war = this.war, n = war.g.n;
    const [a, b] = war.cellsOwned;
    $('barYou').style.width = `${100 * a / n}%`;
    $('barRival').style.width = `${100 * b / n}%`;
    const sp = (p) => { const k = war.spoutsOf(p).length; return `${k} spout${k === 1 ? '' : 's'}`; };
    $('youStat').textContent = `${a} cells · ${f1(war.flow(0))}/s · pull ${f1(war.pullUsed(0))}/${war.pullBudget(0)} · ${sp(0)}`;
    $('rivalStat').textContent = `${sp(1)} · pull ${f1(war.pullUsed(1))}/${war.pullBudget(1)} · ${f1(war.flow(1))}/s · ${b} cells`;
    let clock = fmtTime(war.time);
    for (let p = 0; p < 2; p++) if (war.noSpout[p] > 0) clock += ` · ${p === 0 ? 'you have' : 'rival has'} no spout: out in ${Math.ceil(RULES.outAfter - war.noSpout[p])}s`;
    $('clock').textContent = clock;
    const goal = Math.ceil(RULES.winShare * n);
    $('goal').textContent = `${goal} cells wins`;
  }

  onEvent(e) {
    if (e.type === 'spout') {
      if (e.to === 0) this.toast('Spout taken', 'It pours for you now, and gives you more pull for wells.', 'good');
      else if (e.from === 0) this.toast('Spout lost', e.to === 1 ? 'The rival took one of your spouts.' : 'One of your spouts was cut off.', 'warn');
      else if (e.to === 1) this.toast('', 'The rival took a spout.', 'info');
    } else if (e.type === 'well') {
      if (e.why === 'lost') this.toast('', e.w.owner === 0 ? `The rival broke your well: ${e.w.extra} cells burst out.` : `You broke a rival well: ${e.w.extra} cells burst out.`, e.w.owner === 0 ? 'warn' : 'good');
      else if (e.w.owner === 1 && e.w.extra > 0) this.toast('', `The rival lifted a well: ${e.w.extra} cells burst over the front.`, 'info');
    } else if (e.type === 'over') this.showEnd(e);
  }

  showEnd(o) {
    const war = this.war, win = o.winner === 0;
    const why = o.reason === 'land' ? (win ? 'You hold most of the land.' : 'The rival holds most of the land.') : (win ? 'The rival has no spouts left.' : 'You have no spouts left.');
    const s = war.stats;
    this.modal(h('div', { class: 'reveal' },
      h('h2', { class: win ? 'win' : 'lose' }, win ? 'Victory' : 'Defeat'),
      h('p', {}, `${why} (${fmtTime(o.time)})`),
      h('div', { class: 'stats end' },
        h('span', { class: 'k' }, ''), h('span', { class: 'k you' }, 'You'), h('span', { class: 'k rival' }, 'Rival'),
        h('span', { class: 'k' }, 'Most cells held'), h('span', {}, String(s.peak[0])), h('span', {}, String(s.peak[1])),
        h('span', { class: 'k' }, 'Cells taken from the other'), h('span', {}, String(s.taken[0])), h('span', {}, String(s.taken[1])),
        h('span', { class: 'k' }, 'Cells swallowed by wells'), h('span', {}, String(s.swallowed[0])), h('span', {}, String(s.swallowed[1])),
        h('span', { class: 'k' }, 'Wells lifted'), h('span', {}, String(s.released[0])), h('span', {}, String(s.released[1])))),
    [{ label: 'Rematch', fn: () => this.app.restart(war.seed) }, { label: 'New map', fn: () => this.app.restart() }]);
  }

  toast(title, text, kind = 'info') {
    const box = $('toasts');
    const el = h('div', { class: 'toast ' + kind }, title ? h('div', { class: 'tt' }, title) : null, h('div', {}, text));
    box.appendChild(el);
    while (box.children.length > 4) box.removeChild(box.firstChild);
    setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 400); }, 4000);
  }

  modal(content, actions) {
    const card = $('modalCard');
    card.innerHTML = '';
    card.appendChild(content);
    const row = h('div', { class: 'actions' });
    for (const a of actions) row.appendChild(h('button', { class: 'btn primary', onclick: () => { $('modal').classList.add('hidden'); if (a.fn) a.fn(); } }, a.label));
    card.appendChild(row);
    $('modal').classList.remove('hidden');
  }

  // ---------------------------------------------------------------- panel
  buildPanel() {
    const app = this.app, war = this.war;
    const panel = $('panel');
    panel.innerHTML = '';
    panel.appendChild(h('details', { class: 'about', open: true },
      h('summary', {}, 'How to play'),
      h('p', {}, 'You are gold, the rival is blue. Your spouts pour gold sand. A cell topples when it holds as many grains as it has ways out, sending one grain each way. A grain landing on someone else\'s cell destroys one of theirs; landing on an empty cell takes it.'),
      h('p', {}, h('b', {}, 'Flow'), ' grows with the cells you own and is shared between your spouts. Take a spout by taking the cell under it.'),
      h('p', {}, h('b', {}, 'Wells'), ' (2) go on your land. While you hold one, it swallows cells that aren\'t yours within its reach (the faint outer ring; bigger wells reach further), sand and all, and packs them in as yours: a deep, dense pocket. ', h('b', {}, 'Lift'), ' it (right-click) and those cells burst out over the front and land among the enemy, full of sand. Each spout you hold gives 2 pull for wells. If the rival holds the ground under a well for 2 seconds, it breaks open.'),
      h('p', {}, 'Win by owning 80% of the cells, or by leaving the rival with no spouts for 12 seconds.')));

    const tools = h('div', { class: 'tools' },
      h('button', { class: 'tool' + (this.tool === 'select' ? ' active' : ''), 'data-tool': 'select', onclick: () => this.setTool('select') }, '✋ Select (1)'),
      h('button', { class: 'tool' + (this.tool === 'well' ? ' active' : ''), 'data-tool': 'well', onclick: () => this.setTool('well') }, '● Well (2)'),
      h('button', { class: 'tool', onclick: () => { app.togglePause(); this.buildPanel(); } }, app.paused ? '▶ Resume' : '❚❚ Pause'));
    panel.append(h('h3', {}, 'Tools'), tools);
    const speed = h('div', { class: 'tools' }, h('span', { class: 'small muted' }, 'Speed '));
    for (const x of [1, 2, 4]) speed.appendChild(h('button', { class: 'tool' + (app.speed === x ? ' active' : ''), onclick: (e) => { app.speed = x; speed.querySelectorAll('.tool').forEach(b => b.classList.toggle('active', b === e.currentTarget)); } }, `${x}×`));
    panel.appendChild(speed);

    panel.appendChild(h('h3', {}, 'Match'));
    const level = h('select', { class: 'seed', onchange: (e) => { app.setLevel(e.target.value); } },
      ...['easy', 'normal', 'hard'].map(l => h('option', { value: l }, `Rival: ${l}`)));
    level.value = app.level;
    const seedIn = h('input', { type: 'number', value: String(war.seed), class: 'seed' });
    panel.appendChild(h('div', { class: 'btn-row' }, level));
    panel.appendChild(h('div', { class: 'btn-row' },
      h('button', { class: 'btn', onclick: () => app.restart(war.seed) }, 'Restart'),
      h('button', { class: 'btn', onclick: () => app.restart() }, 'New map')));
    panel.appendChild(h('div', { class: 'btn-row' }, seedIn, h('button', { class: 'btn', onclick: () => app.restart(+seedIn.value || 1) }, 'Load map')));
    panel.appendChild(h('p', { class: 'note' }, 'The rival changes difficulty from the next match. The map is the same for both sides, turned around.'));
    panel.appendChild(h('p', { class: 'note' }, 'Keys: 1 select · 2 well · +/− adjust the selected spout or well · Delete lifts the selected well · Space pause · Esc cancel.'));
    panel.appendChild(h('p', { class: 'note' }, h('a', { href: '../' }, '← The incremental prototype')));
    this.buildSel();
  }
}
