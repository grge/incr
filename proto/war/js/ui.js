// Skirmish interface. Everything happens on the board, with one finger or
// several at once:
//   hold your land      grow a well there (the longer, the stronger)
//   hold your well      make it stronger
//   tap your well       burst it
//   drag your well      move it
//   tap your node       focus your flow through it
import { RULES } from './war.js';
import { COLORS } from './view.js';
import { fmtTime } from '../../../js/format.js';

const HOLD_MS = 220;      // a press longer than this starts a well
const GROW_EVERY = 0.12;  // seconds per half point of pull while holding
const DRAG_PX = 12;       // a press that moves further than this is a drag
const HIT_PX = 26;        // how close a finger must be to a well or node
const SEEN_KEY = 'topple.war.seen';

const $ = (id) => document.getElementById(id);
const f1 = (x) => (x < 10 ? x.toFixed(1) : String(Math.round(x)));
const buzz = (ms) => { try { navigator.vibrate && navigator.vibrate(ms); } catch (e) { /* ignore */ } };

export class UI {
  constructor(app) {
    this.app = app;
    this.touches = new Map();
    this.acc = 0;
    this.toastT = 0;
    this.tipT = 0;
  }
  get war() { return this.app.war; }
  get view() { return this.app.view; }

  init() {
    this.bindBoard();
    this.bindOverlays();
    this.layout();
    window.addEventListener('resize', () => this.layout());
    window.addEventListener('keydown', (e) => {
      if (e.key === ' ' || e.key === 'Escape') { e.preventDefault(); this.toggleMenu(); }
    });
    let seen = false;
    try { seen = !!localStorage.getItem(SEEN_KEY); } catch (e) { /* ignore */ }
    if (!seen) this.show('intro');
    this.updateHud();
  }

  layout() {
    const wrap = $('boardWrap');
    this.view.resize(Math.max(200, wrap.clientWidth), Math.max(200, wrap.clientHeight));
  }

  // ---------------------------------------------------------------- overlays
  show(id) {
    for (const o of ['intro', 'menu', 'end']) $(o).classList.toggle('hidden', o !== id);
    this.app.paused = !!id;
    if (id === 'menu') this.markSegs();
  }
  toggleMenu() {
    if (!$('end').classList.contains('hidden')) return;
    this.show($('menu').classList.contains('hidden') && $('intro').classList.contains('hidden') ? 'menu' : null);
  }
  markSegs() {
    document.querySelectorAll('#levelSeg button').forEach(b => b.classList.toggle('on', b.dataset.level === this.app.level));
    document.querySelectorAll('#speedSeg button').forEach(b => b.classList.toggle('on', +b.dataset.speed === this.app.speed));
  }
  bindOverlays() {
    $('menuBtn').addEventListener('click', () => this.toggleMenu());
    $('startBtn').addEventListener('click', () => {
      try { localStorage.setItem(SEEN_KEY, '1'); } catch (e) { /* ignore */ }
      this.show(null);
    });
    $('menu').addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) { if (e.target === $('menu')) this.show(null); return; }
      if (b.dataset.level) { this.app.setLevel(b.dataset.level); this.markSegs(); this.flash('The new rival plays from the next match.'); return; }
      if (b.dataset.speed) { this.app.speed = +b.dataset.speed; this.markSegs(); return; }
      const act = b.dataset.act;
      if (act === 'resume') this.show(null);
      else if (act === 'rules') this.show('intro');
      else if (act === 'restart') { this.app.restart(this.war.seed); this.show(null); }
      else if (act === 'new') { this.app.restart(); this.show(null); }
    });
  }

  // ---------------------------------------------------------------- the board
  // What is under a finger at (x, y), for you (player 0).
  hit(x, y) {
    const war = this.war, r = HIT_PX / this.view.scale;
    const w = war.nearestWell(x, y, r, 0);
    if (w) return { type: 'well', w };
    const k = war.nearestNode(x, y, r);
    if (k >= 0 && war.nodes[k].owner === 0) return { type: 'node', k };
    if (war.ownerAt(x, y) === 0) return { type: 'land' };
    return { type: 'other' };
  }

  bindBoard() {
    const cv = this.view.canvas;
    cv.addEventListener('contextmenu', (e) => e.preventDefault());
    cv.addEventListener('pointerdown', (e) => {
      if (this.app.paused || this.war.over) return;
      try { cv.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      const [x, y] = this.view.toRaster(e.clientX, e.clientY);
      const t = { cx: e.clientX, cy: e.clientY, x, y, t: 0, mode: 'press', hit: this.hit(x, y), well: null, grow: 0 };
      this.touches.set(e.pointerId, t);
      if (t.hit.type === 'other') { t.mode = 'done'; this.tip(this.war.ownerAt(x, y) === 1 ? 'That is the rival\'s land.' : 'Wells go on your own land.'); }
    });
    cv.addEventListener('pointermove', (e) => {
      const t = this.touches.get(e.pointerId);
      if (!t) return;
      const [x, y] = this.view.toRaster(e.clientX, e.clientY);
      t.x = x; t.y = y;
      const moved = Math.hypot(e.clientX - t.cx, e.clientY - t.cy) > DRAG_PX;
      if (t.mode === 'press' && moved) t.mode = t.hit.type === 'well' ? 'drag' : 'done';
      if ((t.mode === 'drag' && this.war.wells.includes(t.hit.w)) || (t.mode === 'grow' && t.well && this.war.wells.includes(t.well))) {
        this.war.moveWell(t.mode === 'drag' ? t.hit.w : t.well, x, y);
      }
    });
    const end = (e) => {
      const t = this.touches.get(e.pointerId);
      if (!t) return;
      this.touches.delete(e.pointerId);
      if (t.mode !== 'press' || e.type === 'pointercancel') return;
      // a tap
      if (t.hit.type === 'well') this.burst(t.hit.w);
      else if (t.hit.type === 'node') {
        const on = this.war.toggleFocus(t.hit.k);
        this.tip(on ? 'Focused: most of your flow now pours through this node.' : 'Unfocused: your flow is shared evenly again.');
      } else this.tip('<b>Hold</b> your land to grow a well.');
    };
    cv.addEventListener('pointerup', end);
    cv.addEventListener('pointercancel', end);
  }

  burst(w) {
    if (!this.war.wells.includes(w)) return;
    const held = w.extra;
    this.war.liftWell(w);
    buzz(15);
    this.tip(held ? `Burst: <b>${held}</b> cell${held === 1 ? '' : 's'} thrown over the front.` : 'Released. It had not swallowed anything yet.');
  }

  // Holds turn into wells, and wells grow while held.
  updateTouches(dt) {
    const war = this.war;
    for (const t of this.touches.values()) {
      t.t += dt;
      if (t.mode === 'press' && t.t * 1000 >= HOLD_MS && t.hit.type !== 'other') {
        if (t.hit.type === 'well') { t.mode = 'grow'; t.well = t.hit.w; }
        else {
          const r = war.addWell(0, t.x, t.y, 1);
          if (typeof r === 'string') {
            t.mode = 'done';
            this.tip(r === 'no pull' ? 'No pull left. Burst a well, or take more nodes.' : 'Wells go on your own land.');
            continue;
          }
          t.mode = 'grow'; t.well = r;
          buzz(8);
        }
      }
      if (t.mode === 'grow') {
        if (!war.wells.includes(t.well)) { t.mode = 'done'; continue; }
        t.grow += dt;
        while (t.grow >= GROW_EVERY) {
          t.grow -= GROW_EVERY;
          const room = Math.min(RULES.maxPull, war.pullFree(0) + t.well.pull);
          if (t.well.pull + 0.5 <= room + 1e-9) war.setPull(t.well, t.well.pull + 0.5);
        }
        const max = Math.min(RULES.maxPull, war.pullFree(0) + t.well.pull);
        this.tip(`Well: pull <b>${t.well.pull}</b>${t.well.pull >= max ? (t.well.pull >= RULES.maxPull ? ' (as strong as a well gets)' : ' (all your pull)') : ''}. Slide to place it, let go to leave it.`, true);
      }
    }
  }

  // ---------------------------------------------------------------- per frame
  frame(dt) {
    const war = this.war;
    for (const e of war.drainEvents()) this.onEvent(e);
    if (!this.app.paused) this.updateTouches(dt);
    const holds = [];
    for (const t of this.touches.values()) {
      if (t.mode === 'press' && t.hit.type !== 'other' && t.hit.type !== 'well') holds.push({ x: t.x, y: t.y, frac: (t.t * 1000) / HOLD_MS * 0.25, ok: true });
      else if (t.mode === 'grow' && t.well) holds.push({ x: t.well.x, y: t.well.y, frac: t.well.pull / RULES.maxPull, ok: true });
    }
    this.view.draw(dt, { holds });
    this.acc += dt;
    if (this.acc > 0.2) { this.acc = 0; this.updateHud(); }
    if (this.tipT > 0) { this.tipT -= dt; if (this.tipT <= 0) this.defaultTip(); }
    if (this.toastT > 0) { this.toastT -= dt; if (this.toastT <= 0) $('toast').classList.add('hidden'); }
  }

  updateHud() {
    const war = this.war, n = war.g.n;
    const [a, b] = war.cellsOwned;
    $('youCount').textContent = a;
    $('rivalCount').textContent = b;
    $('barYou').style.width = `${100 * a / n}%`;
    $('barRival').style.width = `${100 * b / n}%`;
    const nodes = (p) => { const k = war.nodesOf(p).length; return `${k} node${k === 1 ? '' : 's'}`; };
    $('youInfo').textContent = `${nodes(0)} · ${f1(war.flow(0))}/s`;
    $('rivalInfo').textContent = `${f1(war.flow(1))}/s · ${nodes(1)}`;
    let clock = fmtTime(war.time);
    for (let p = 0; p < 2; p++) if (war.noNode[p] > 0) clock = `${p === 0 ? 'you' : 'rival'}: no nodes · ${Math.ceil(RULES.outAfter - war.noNode[p])}s`;
    $('clock').textContent = clock;
    const maxBudget = RULES.pullPerNode * war.nodes.length;
    $('pullBudget').style.width = `${100 * war.pullBudget(0) / maxBudget}%`;
    $('pullUsed').style.width = `${100 * war.pullUsed(0) / maxBudget}%`;
    $('pullText').textContent = `${f1(war.pullUsed(0))} / ${war.pullBudget(0)}`;
    if (this.tipT <= 0 && !this.tipShown) this.defaultTip();
  }

  defaultTip() {
    const war = this.war, mine = war.wells.filter(w => w.owner === 0);
    let t;
    if (!mine.length) t = war.pullFree(0) >= 0.5 ? '<b>Hold</b> your land to grow a well.' : 'Take more nodes for more pull.';
    else if (mine.some(w => w.extra >= war.capacity(w) - 0.5)) t = 'A well is full. <b>Tap</b> it to burst it over the front.';
    else t = '<b>Tap</b> a well to burst it · <b>drag</b> to move · <b>tap</b> a node to focus';
    $('tip').innerHTML = t;
    this.tipShown = false;
  }
  tip(html, sticky = false) {
    $('tip').innerHTML = html;
    this.tipT = sticky ? 0.3 : 2.5;
    this.tipShown = true;
  }
  flash(text, kind = '') {
    const el = $('toast');
    el.textContent = text;
    el.className = kind;
    this.toastT = 2.2;
  }

  onEvent(e) {
    if (e.type === 'node') {
      if (e.to === 0) { this.flash('Node taken: more flow, more pull', 'good'); buzz(10); }
      else if (e.from === 0) this.flash(e.to === 1 ? 'The rival took one of your nodes' : 'One of your nodes was cut off', 'bad');
      else if (e.to === 1) this.flash('The rival took a node', 'bad');
    } else if (e.type === 'well') {
      const w = e.w;
      if (w.extra > 0 || e.why === 'lift') this.view.shockwave(w.x, w.y, w.r * RULES.reach, w.owner);
      if (e.why === 'lost') this.flash(w.owner === 0 ? 'The rival broke your well' : 'You broke a rival well', w.owner === 0 ? 'bad' : 'good');
    } else if (e.type === 'over') this.showEnd(e);
  }

  showEnd(o) {
    const war = this.war, win = o.winner === 0, s = war.stats;
    const why = o.reason === 'land' ? (win ? 'You hold most of the cells.' : 'The rival holds most of the cells.') : (win ? 'The rival has no nodes left.' : 'You have no nodes left.');
    const row = (k, a, b) => `<span class="k">${k}</span><span>${a}</span><span>${b}</span>`;
    $('endCard').innerHTML = `
      <p class="result ${win ? 'win' : 'lose'}">${win ? 'Victory' : 'Defeat'}</p>
      <p class="small">${why} ${fmtTime(o.time)}.</p>
      <div class="endstats">
        <span></span><span class="h you">You</span><span class="h rival">Rival</span>
        ${row('Most cells held', s.peak[0], s.peak[1])}
        ${row('Cells taken in fighting', s.taken[0], s.taken[1])}
        ${row('Cells swallowed by wells', s.swallowed[0], s.swallowed[1])}
        ${row('Wells burst', s.released[0], s.released[1])}
      </div>
      <div class="actions"><button class="btn" id="newBtn">New map</button><button class="btn primary" id="againBtn">Rematch</button></div>`;
    this.show('end');
    $('againBtn').onclick = () => { this.app.restart(war.seed); this.show(null); };
    $('newBtn').onclick = () => { this.app.restart(); this.show(null); };
  }
}
