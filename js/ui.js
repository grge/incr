// DOM user interface: header, board interaction, side panel tabs, toasts, modals.
import * as D from './data.js';
import { CRYSTAL, STONE, PRISM } from './sim.js';
import { fmt, fmtInt, fmtTime, fmtMult } from './format.js';
import * as audio from './audio.js';

const $ = (id) => document.getElementById(id);

function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const k in attrs) {
    const v = attrs[k];
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'style') el.setAttribute('style', v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
  }
  return el;
}

const ROMAN = ['I', 'II', 'III', 'IV', 'V'];
const KIND_LABEL = { [CRYSTAL]: 'Crystal', [STONE]: 'Stone', [PRISM]: 'Prism' };

const UNLOCK_TIPS = {
  crystal: ['Crystals', 'Topples on a crystal\'s cell are worth more. Put them where sand falls hardest — under your hourglasses is a fine start.'],
  quake: ['Quake', 'Shake the table to scatter half a minute of sand across every cell at once.'],
  gleam: ['Glimmer', 'Watch for gleaming grains on the table and click them before they fade.'],
  stone: ['Stones', 'Sand bounces off stones. Wall in your hourglasses — but leave a gap — and sand will linger, toppling again and again.'],
  doctrine: ['Doctrines', 'Choose a doctrine in the Kiln. After this you can change it each time you sweep.'],
  fold: ['The Fold', 'Fold the table with the ⇄ button. Sand can then only fall off the north and south edges.'],
  prism: ['Prisms', 'A prism doubles the crystal multiplier of every crystal it touches (not diagonally). Crystals can touch several prisms.'],
  trials: ['Trials', 'Trials are runs with strange rules. Finish one for a permanent reward.'],
  great: ['The Great Hourglass', 'A new tab has appeared. This is what all the sand was for.'],
  aftershock: ['Aftershock', 'For 10 seconds after each quake, dust is tripled.'],
};

export class UI {
  constructor(game, renderer, hooks) {
    this.g = game;
    this.r = renderer;
    this.hooks = hooks;
    this.tab = 'table';
    this.tool = 'pour';
    this.placing = null;
    this.survey = 0;
    this.hover = -1;
    this.drag = null;
    this.suggest = -1;
    this.pour = null;
    this.structKey = '';
    this.updaters = [];
    this.panelAcc = 0;
    this.seenUps = new Set();
    this.nextDoctrine = null;
    this.tabDots = {};
    this.lastJournal = null;
    this.toppleAcc = 0;
    this.clickedOnce = game.s.stats.clicks > 0 || game.s.sweeps > 0;
    this.endingShown = false;
  }

  get table() { return Math.min(this.g.s.activeTable, this.g.boards.length - 1); }
  get board() { return this.g.boards[this.table]; }

  init() {
    this.bindBoard();
    this.bindToolbar();
    this.bindKeys();
    const j = this.g.s.journal;
    if (j.length) this.setTicker(D.JOURNAL.find(x => x.id === j[j.length - 1])?.text || '', false);
    this.applySettings();
    this.layout();
    window.addEventListener('resize', () => this.layout());
    this.renderPanel(true);
  }

  applySettings() {
    const st = this.g.s.settings;
    audio.setEnabled(!!st.sound);
    audio.setVolume(st.volume ?? 0.5);
    $('muteBtn').classList.toggle('off', !st.sound);
    this.r.reduceMotion = !!st.reduceMotion;
    this.r.showParticles = st.particles !== false;
  }

  layout() {
    const wrap = $('boardWrap');
    const w = wrap.clientWidth;
    const narrow = window.innerWidth <= 980;
    const avH = narrow ? window.innerHeight * 0.62 : window.innerHeight - 250;
    this.r.resize(Math.min(w, 760), Math.max(260, avH));
  }

  // ---------------------------------------------------------------- board input
  bindBoard() {
    const cv = this.r.canvas;
    cv.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const i = this.r.cellAt(this.board, e.clientX, e.clientY);
      if (i >= 0 && this.g.removeAt(this.table, i)) audio.buy();
    });
    cv.addEventListener('pointerdown', (e) => {
      if (e.button === 2) return;
      audio.unlock();
      this.pointer = { x: e.clientX, y: e.clientY };
      const i = this.r.cellAt(this.board, e.clientX, e.clientY);
      if (i < 0) return;
      cv.setPointerCapture(e.pointerId);
      const b = this.board, g = this.g;
      // gleam?
      if (g.s.gleam && g.s.gleam.t === this.table && g.s.gleam.cell === i) {
        const text = g.catchGleam();
        if (text) audio.gleamCatch();
        return;
      }
      if (this.placing) {
        const type = this.placing;
        if (g.place(type, this.table, i)) {
          audio.buy();
          if (g.s.inv[type] <= 0) this.setPlacing(null);
          this.suggest = -1;
        }
        return;
      }
      if (this.tool === 'remove') {
        if (g.removeAt(this.table, i, e.shiftKey)) audio.buy();
        return;
      }
      const hasItem = b.hg[i] > 0 || b.kind[i] !== 0 || (b.funnel === i && this.table > 0);
      if (hasItem) {
        this.drag = {
          from: i, hg: b.hg[i], kind: b.kind[i], funnel: b.hg[i] === 0 && b.kind[i] === 0 && b.funnel === i,
          sx: e.clientX, sy: e.clientY, px: e.clientX, py: e.clientY, active: false,
        };
        this.drag.timer = setTimeout(() => {
          if (this.drag && !this.drag.active) { const c = this.drag.from; this.drag = null; this.startPour(c); }
        }, 320);
      } else {
        this.startPour(i);
      }
    });
    cv.addEventListener('pointermove', (e) => {
      this.pointer = { x: e.clientX, y: e.clientY };
      const i = this.r.cellAt(this.board, e.clientX, e.clientY);
      this.hover = i;
      if (this.drag) {
        this.drag.px = e.clientX; this.drag.py = e.clientY;
        if (!this.drag.active && (Math.abs(e.clientX - this.drag.sx) + Math.abs(e.clientY - this.drag.sy) > 6)) {
          this.drag.active = true;
          clearTimeout(this.drag.timer);
          cv.classList.add('dragging');
        }
      }
      if (this.pour && i >= 0 && i !== this.pour.cell && this.board.kind[i] !== STONE) this.pour.cell = i;
    });
    const end = (e) => {
      if (this.drag) {
        clearTimeout(this.drag.timer);
        const d = this.drag;
        this.drag = null;
        cv.classList.remove('dragging');
        if (d.active) {
          const to = this.r.cellAt(this.board, e.clientX, e.clientY);
          if (to >= 0 && to !== d.from) {
            if (d.funnel) this.g.moveFunnel(this.table, to);
            else this.g.move(this.table, d.from, to);
          } else if (to < 0 && !d.funnel) {
            this.g.removeAt(this.table, d.from, true);
          }
        } else if (e.type === 'pointerup') {
          this.dropAt(d.from);
        }
      }
      this.stopPour();
    };
    cv.addEventListener('pointerup', end);
    cv.addEventListener('pointercancel', end);
    cv.addEventListener('pointerleave', () => { if (!this.drag) this.hover = -1; });
  }

  dropAt(i) {
    if (!this.g.canClick()) {
      this.toast('Still Hands', 'This trial does not allow clicking.', 'warn');
      return;
    }
    const ev = this.g.click(this.table, i);
    if (ev) {
      audio.drop();
      this.clickedOnce = true;
      const now = performance.now();
      if (this.pointer && (!this._lastFloat || now - this._lastFloat > 110)) {
        this._lastFloat = now;
        this.floater(this.pointer.x, this.pointer.y, '+' + fmt(ev));
      }
    }
  }

  startPour(i) {
    this.stopPour();
    this.dropAt(i);
    this.pour = { cell: i, t: 0 };
    this.pour.timer = setInterval(() => { if (this.pour) this.dropAt(this.pour.cell); }, 180);
  }

  stopPour() {
    if (this.pour) { clearInterval(this.pour.timer); this.pour = null; }
  }

  setPlacing(type) {
    this.placing = type;
    this.r.canvas.classList.toggle('placing', !!type);
    if (type === 'stone') {
      const s = this.g.suggestStone();
      this.suggest = s && s.t === this.table ? s.i : -1;
    } else this.suggest = -1;
    this.renderInventory();
  }

  bindToolbar() {
    for (const btn of document.querySelectorAll('.tool[data-tool]')) {
      btn.addEventListener('click', () => {
        this.tool = btn.dataset.tool;
        this.setPlacing(null);
        document.querySelectorAll('.tool[data-tool]').forEach(b => b.classList.toggle('active', b === btn));
      });
    }
    $('surveyBtn').addEventListener('click', () => {
      this.survey = (this.survey + 1) % 3;
      this.updateSurveyBtn();
    });
    $('quakeBtn').addEventListener('click', () => {
      audio.unlock();
      this.g.quake();
    });
    $('foldBtn').addEventListener('click', () => {
      this.g.setFold(!this.g.s.fold);
    });
    $('muteBtn').addEventListener('click', () => {
      const st = this.g.s.settings;
      st.sound = !st.sound;
      this.applySettings();
      if (st.sound) audio.unlock();
    });
    this.updateSurveyBtn();
  }

  updateSurveyBtn() {
    const b = $('surveyBtn');
    b.textContent = ['◎ Survey', '◎ Survey: value', '◎ Survey: flow'][this.survey];
    b.classList.toggle('active', this.survey > 0);
    b.title = ['Survey the table.', 'Brighter cells: a grain dropped here earns more. Put hourglasses on the brightest cell.', 'Brighter cells topple more often. Crystals belong here.'][this.survey];
  }

  bindKeys() {
    window.addEventListener('keydown', (e) => {
      if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) return;
      if (e.key === 'Escape') { this.setPlacing(null); this.closeModal(); }
      else if (e.key === 'q' || e.key === 'Q') this.g.quake();
      else if (e.key === 's' || e.key === 'S') { this.survey = (this.survey + 1) % 3; this.updateSurveyBtn(); }
      else if (['1', '2', '3'].includes(e.key)) {
        const t = +e.key - 1;
        if (t < this.g.boards.length) { this.g.s.activeTable = t; this.renderTableTabs(); }
      }
    });
  }

  // ---------------------------------------------------------------- per frame
  frame(dt) {
    const g = this.g, s = g.s;
    for (const e of g.drainEvents()) this.onEvent(e);
    // board
    const b = this.board;
    let heatMap = null;
    let mode = this.survey;
    if (this.placing === 'hourglass') mode = 1;
    else if (this.placing) mode = 2;
    if (mode === 1) {
      const at = g.analyze().tables[this.table];
      heatMap = this._heatV && this._heatKey === g.analyze().key + this.table ? this._heatV : null;
      if (!heatMap) {
        heatMap = new Float64Array(b.n);
        for (let i = 0; i < b.n; i++) heatMap[i] = b.kind[i] === STONE ? 0 : at.v[i] + (at.X ? at.X[i] : 1) * at.down;
        this._heatV = heatMap;
        this._heatKey = g.analyze().key + this.table;
      }
    } else if (mode === 2) {
      heatMap = g.toppleMap(this.table);
    }
    const gl = s.gleam && s.gleam.t === this.table ? s.gleam : null;
    this.r.draw(b, dt, {
      heat: heatMap,
      hover: this.hover,
      hoverBad: this.placing === 'stone' && this.hover >= 0 && !b.canPlaceStone(this.hover),
      drag: this.drag,
      gleam: gl ? gl.cell : -1,
      gleamLife: gl ? gl.ttl / gl.max : 1,
      suggest: this.placing === 'stone' ? this.suggest : -1,
      fold: b.fold,
      active: true,
    });
    if (g.lastRoundStats) {
      this.toppleAcc += g.lastRoundStats.wave;
      if (this.toppleAcc > 0) { audio.topples(this.toppleAcc); this.toppleAcc = 0; }
    }
    this.updateHeader();
    this.updateCellInfo();
    this.panelAcc += dt;
    if (this.panelAcc > 0.2) {
      this.panelAcc = 0;
      this.renderPanel(false);
      this.updateToolbar();
    }
  }

  updateHeader() {
    const g = this.g, s = g.s;
    setText('dust', fmt(s.dust));
    const rate = g.currentRate();
    setText('dustRate', rate > 0 ? `+${fmt(rate)}/s` : '');
    const showGlass = s.sweeps > 0 || g.kilnVisible();
    $('glassBox').classList.toggle('hidden', !showGlass);
    if (showGlass) setText('glass', fmt(s.glass));
    const showSand = g.fx.collectSand || s.sand > 0;
    $('sandBox').classList.toggle('hidden', !showSand);
    if (showSand) {
      setText('sand', fmt(s.sand));
      const sr = g.sandRate();
      setText('sandRate', sr > 0 ? `+${fmt(sr)}/s` : '');
    }
    // buffs
    const parts = [];
    if (s.buffs.shimmer > 0) parts.push(['shimmer', `Shimmer ×5 · ${Math.ceil(s.buffs.shimmer)}s`]);
    if (s.buffs.sandstorm > 0) parts.push(['sandstorm', `Sandstorm ×10 · ${Math.ceil(s.buffs.sandstorm)}s`]);
    if (s.aftershock > 0) parts.push(['aftershock', `Aftershock ×3 · ${Math.ceil(s.aftershock)}s`]);
    const key = parts.map(p => p[1]).join('|');
    if (key !== this._buffKey) {
      this._buffKey = key;
      const box = $('buffs');
      box.innerHTML = '';
      for (const [c, t] of parts) box.appendChild(h('span', { class: 'buff ' + c }, t));
    }
  }

  updateToolbar() {
    const g = this.g, s = g.s;
    const qb = $('quakeBtn');
    const showQ = g.has('quake');
    qb.classList.toggle('hidden', !showQ);
    if (showQ) {
      const can = g.canQuake();
      const cd = s.quakeCd, max = g.quakeCooldown();
      const ready = can && cd <= 0;
      qb.disabled = !ready;
      qb.classList.toggle('ready', ready);
      qb.querySelector('.quake-fill').style.width = ready ? '100%' : `${100 * (1 - cd / max)}%`;
      const lbl = !can ? '≋ Quake (barred)' : ready ? '≋ Quake' : `≋ ${Math.ceil(cd)}s`;
      if (qb.querySelector('.quake-label').textContent !== lbl) qb.querySelector('.quake-label').textContent = lbl;
    }
    const fb = $('foldBtn');
    fb.classList.toggle('hidden', !g.has('fold'));
    fb.classList.toggle('active', !!s.fold);
    this.renderTableTabs();
    this.renderInventory();
  }

  renderTableTabs() {
    const g = this.g;
    const box = $('tableTabs');
    if (g.boards.length <= 1) { box.classList.add('hidden'); return; }
    box.classList.remove('hidden');
    const a = g.analyze();
    const key = g.boards.length + ':' + this.table + ':' + a.tables.map(t => Math.round(100 * t.raw / (a.raw || 1))).join(',');
    if (key === this._ttKey) return;
    this._ttKey = key;
    box.innerHTML = '';
    g.boards.forEach((b, t) => {
      const share = a.raw > 0 ? Math.round(100 * a.tables[t].raw / a.raw) : 0;
      box.appendChild(h('button', {
        class: 'ttab' + (t === this.table ? ' active' : ''),
        title: t === 0 ? 'Your first table.' : 'Sand falling from the table above lands on the funnel ◎. Drag the funnel to move it.',
        onclick: () => { g.s.activeTable = t; this._ttKey = ''; this.renderTableTabs(); },
      }, `Table ${ROMAN[t]}`, h('span', { class: 'flow' }, `${share}%`)));
    });
  }

  renderInventory() {
    const g = this.g, s = g.s;
    const box = $('inventory');
    const types = Object.keys(s.inv).filter(k => s.inv[k] > 0);
    const key = types.map(t => t + s.inv[t]).join(',') + '|' + this.placing;
    if (key === this._invKey) return;
    this._invKey = key;
    box.innerHTML = '';
    box.classList.toggle('hidden', types.length === 0);
    for (const t of types) {
      const def = D.BUILDINGS[t];
      box.appendChild(h('button', {
        class: 'inv-chip' + (this.placing === t ? ' active' : ''),
        onclick: () => this.setPlacing(this.placing === t ? null : t),
        title: 'Click, then click a cell to place.',
      }, `${def.icon} `, h('span', { class: 'n' }, `${s.inv[t]}`), ` ${def.name.toLowerCase()}${s.inv[t] > 1 ? 's' : ''} to place`));
    }
    if (this.placing && this.placing !== 'stone' && s.inv[this.placing] > 0) {
      box.appendChild(h('button', { class: 'btn tiny', onclick: () => { while (s.inv[this.placing] > 0 && g.autoPlace(this.placing, true)); this.setPlacing(null); } }, 'Auto-place'));
    }
    if (this.placing === 'stone') {
      box.appendChild(h('button', {
        class: 'btn tiny', onclick: () => {
          const sug = g.suggestStone();
          if (sug) {
            if (sug.t !== this.table) { g.s.activeTable = sug.t; this._ttKey = ''; }
            this.suggest = sug.i;
          } else this.toast('Stones', 'No single stone would help right now. Try building a wall around your hourglasses by hand.', 'info');
        },
      }, 'Suggest a spot'));
    }
    const hint = $('placeHint');
    if (this.placing) {
      const tips = {
        hourglass: 'Click a cell to set an hourglass there.',
        crystal: 'Click a cell to grow a crystal. Bright cells topple most.',
        stone: 'Click a cell to set a stone. Sand bounces off it — wall in your hourglasses, but leave a way out.',
        prism: 'Click a cell next to crystals. Each crystal it touches is doubled.',
      };
      hint.textContent = tips[this.placing] + ' (Esc to stop)';
      hint.classList.remove('hidden');
    } else hint.classList.add('hidden');
  }

  updateCellInfo() {
    const el = $('cellInfo');
    const g = this.g, b = this.board, i = this.hover;
    let text;
    if (!this.clickedOnce) text = 'Click a cell to drop a grain of sand. Hold to pour.';
    else if (i < 0) text = this.g.s.sweeps === 0 && this.g.s.owned.hourglass > 0 && !this._dragTipShown ? 'Tip: drag an hourglass to move it. Right-click (or Pick up) returns it to your pocket.' : ' ';
    else {
      const x = i % b.size, y = (i / b.size) | 0;
      const parts = [`(${x + 1}, ${y + 1})`];
      if (b.kind[i] === STONE) parts.push('Stone');
      else {
        const gr = Math.floor(b.grains[i]);
        parts.push(`${fmtInt(gr)} grain${gr === 1 ? '' : 's'}`);
        if (b.kind[i] === CRYSTAL) parts.push(`Crystal ${fmtMult(b.val[i])}`);
        else if (b.kind[i] === PRISM) parts.push('Prism');
        else if (b.val[i] > 1) parts.push(`${fmtMult(b.val[i])}`);
        if (b.hg[i] > 0) parts.push(`⧗ ${b.hg[i]} hourglass${b.hg[i] > 1 ? 'es' : ''}`);
        if (b.funnel === i) parts.push('Funnel');
        const a = g.analyze().tables[this.table];
        const u = g.toppleMap(this.table);
        parts.push(`~${fmt(u[i])} topples/s`);
        const pv = (a.v[i] + (a.X ? a.X[i] : 1) * a.down) * g.dustMultBase();
        parts.push(`a grain here ≈ ${fmt(pv)} dust`);
      }
      text = parts.join(' · ');
    }
    if (el.textContent !== text) el.textContent = text;
  }

  floater(x, y, text, cls = '') {
    if (this.g.s.settings.reduceMotion) return;
    const el = h('div', { class: 'floater ' + cls, style: `left:${x}px;top:${y}px` }, text);
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 1000);
  }

  setTicker(text, animate = true) {
    const el = $('ticker');
    if (!animate) { el.textContent = text; return; }
    el.classList.add('fade');
    setTimeout(() => { el.textContent = text; el.classList.remove('fade'); }, 700);
  }

  // ---------------------------------------------------------------- events
  onEvent(e) {
    const g = this.g;
    switch (e.type) {
      case 'toast': this.toast('', e.text, e.kind || 'info'); break;
      case 'journal': {
        const j = D.JOURNAL.find(x => x.id === e.id);
        if (j) this.setTicker(j.text);
        if (this.tab !== 'journal') this.tabDots.journal = true;
        break;
      }
      case 'ach': {
        const a = D.ACHIEVEMENTS.find(x => x.id === e.id);
        if (a) this.toast('Achievement · ' + a.name, a.desc + ` (+${Math.round(D.ACH_BONUS * 100)}% dust)`, 'ach', 'ach-' + (this._achN = ((this._achN || 0) + 1) % 2));
        audio.achievement();
        if (this.tab !== 'records') this.tabDots.records = true;
        break;
      }
      case 'quake': {
        this.r.shake(); audio.quake();
        const rr = this.r.canvas.getBoundingClientRect();
        if (e.value > 0) this.floater(rr.left + rr.width / 2, rr.top + rr.height / 2, '+' + fmt(e.value), 'big');
        break;
      }
      case 'gleamSpawn': audio.gleamAppear(); break;
      case 'gleam': {
        const msg = {
          windfall: ['Windfall', `+${fmt(e.amount)} dust.`],
          shimmer: ['Shimmer', `Dust ×5 for ${Math.round(e.duration)} seconds.`],
          sandstorm: ['Sandstorm', `Hourglasses pour ×10 for ${Math.round(e.duration)} seconds.`],
          tremor: ['Tremor', 'A double-strength quake!'],
        }[e.kind];
        if (msg) this.toast('✦ ' + msg[0], msg[1], 'gleam', 'gleam');
        break;
      }
      case 'milestone':
        this.toast(`${e.n} hourglasses`, `Milestone! Hourglasses pour ${fmtMult(e.mult)} as fast as they used to.`, 'info', 'milestone');
        audio.milestone();
        break;
      case 'unlock': {
        const tip = UNLOCK_TIPS[e.what];
        if (tip) this.toast('Unlocked · ' + tip[0], tip[1], 'glass');
        break;
      }
      case 'sweep':
        audio.sweep();
        if (!g.s.settings.reduceMotion && this.r.canvas.animate) {
          this.r.canvas.animate([{ opacity: 0, filter: 'blur(6px)', transform: 'scale(0.96)' }, { opacity: 1, filter: 'blur(0)', transform: 'scale(1)' }], { duration: 1100, easing: 'ease-out' });
        }
        if (e.gain > 0) this.toast('The kiln roars', `+${fmt(e.gain)} glass.`, 'glass');
        this.setPlacing(null);
        this.structKey = '';
        break;
      case 'trialDone': {
        const t = D.TRIAL_MAP[e.id];
        this.toast('Trial complete · ' + t.name, t.reward + ' Sweep whenever you like.', 'ach');
        audio.achievement();
        break;
      }
      case 'great':
        audio.milestone();
        if (e.stage >= D.GREAT.length) this.showEnding();
        break;
      case 'resize': this.structKey = ''; break;
    }
  }

  toast(title, text, kind = 'info', group = null) {
    const box = $('toasts');
    if (group) {
      // replace an existing toast of the same group instead of stacking
      const old = box.querySelector(`[data-group="${group}"]`);
      if (old) old.remove();
    }
    const el = h('div', { class: 'toast ' + kind, 'data-group': group }, title ? h('div', { class: 'tt' }, title) : null, h('div', {}, text));
    box.appendChild(el);
    while (box.children.length > 4) box.removeChild(box.firstChild);
    setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 450); }, kind === 'ach' || kind === 'glass' ? 6500 : 4500);
  }

  modal(content, actions = [{ label: 'OK' }]) {
    const card = $('modalCard');
    card.innerHTML = '';
    card.appendChild(content);
    const row = h('div', { class: 'actions' });
    for (const a of actions) {
      row.appendChild(h('button', {
        class: 'btn ' + (a.cls || ''),
        onclick: () => { if (a.fn) a.fn(); if (!a.keep) this.closeModal(); },
      }, a.label));
    }
    card.appendChild(row);
    $('modal').classList.remove('hidden');
  }

  closeModal() { $('modal').classList.add('hidden'); }

  // ---------------------------------------------------------------- panel
  tabs() {
    const g = this.g;
    const t = [['table', 'Table']];
    if (g.kilnVisible()) t.push(['kiln', 'Kiln']);
    if (g.has('trials')) t.push(['trials', 'Trials']);
    if (g.has('great')) t.push(['great', 'Hourglass']);
    t.push(['journal', 'Journal'], ['records', 'Records'], ['options', '⚙']);
    return t;
  }

  structureKey() {
    const g = this.g, s = g.s;
    const avail = D.UPGRADES.filter(u => g.upgradeAvailable(u) && this.upgradeVisible(u)).map(u => u.id).join(',');
    const kavail = D.KILN.filter(k => g.kilnAvailable(k)).map(k => k.id).join(',');
    return [this.tab, this.tabs().map(x => x[0]).join(','), avail, kavail, Object.keys(s.up).length, Object.keys(s.kiln).length,
      [...g.fx.unlocks].join(','), s.trial, Object.keys(s.trials).length, s.great, s.sweeps, g.boards.length, s.doctrine,
      this.nextDoctrine, s.journal.length, g.achCount(), s.polish, g.has('doctrine'), s.ended].join('|');
  }

  upgradeVisible(u) {
    const s = this.g.s;
    if (this.seenUps.has(u.id)) return true;
    const ok = u.cost <= Math.max(s.dust, 1) * 25 || u.cost <= 100;
    if (ok) this.seenUps.add(u.id);
    return ok;
  }

  renderPanel(force) {
    const g = this.g;
    const kAfford = g.kilnVisible() && (D.KILN.some(k => g.kilnAvailable(k) && g.s.glass >= k.cost) || (g.glassGain() >= 1 && g.s.sweeps === 0));
    if (this.tab !== 'kiln') this.tabDots.kiln = kAfford;
    const gAfford = g.has('great') && g.canBuildGreat();
    if (this.tab !== 'great') this.tabDots.great = gAfford;
    const key = this.structureKey() + '|' + kAfford + gAfford;
    if (!force && key === this.structKey) {
      for (const f of this.updaters) f();
      return;
    }
    this.structKey = key;
    const tabsEl = $('tabs');
    tabsEl.innerHTML = '';
    const tabs = this.tabs();
    if (!tabs.find(t => t[0] === this.tab)) this.tab = 'table';
    for (const [id, label] of tabs) {
      tabsEl.appendChild(h('button', {
        class: 'tab' + (id === this.tab ? ' active' : ''), role: 'tab',
        onclick: () => { this.tab = id; this.tabDots[id] = false; this.renderPanel(true); },
      }, label, this.tabDots[id] && id !== this.tab ? h('span', { class: 'dot' }) : null));
    }
    const body = $('tabBody');
    const scroll = body.scrollTop;
    body.innerHTML = '';
    this.updaters = [];
    const fn = {
      table: () => this.renderTable(body), kiln: () => this.renderKiln(body), trials: () => this.renderTrials(body),
      great: () => this.renderGreat(body), journal: () => this.renderJournal(body), records: () => this.renderRecords(body),
      options: () => this.renderOptions(body),
    }[this.tab];
    fn();
    body.scrollTop = scroll;
    for (const f of this.updaters) f();
  }

  // ---- Table tab
  renderTable(body) {
    const g = this.g, s = g.s;
    if (s.trial) {
      const t = D.TRIAL_MAP[s.trial];
      const card = h('div', { class: 'trial active' }, h('div', { class: 't-head' }, h('span', { class: 't-name' }, 'Trial · ' + t.name)), h('div', { class: 't-rule muted' }, t.rule));
      const prog = h('div', { class: 'progress' }, h('div'));
      const lbl = h('div', { class: 'small muted' });
      card.append(prog, lbl);
      body.appendChild(card);
      this.updaters.push(() => {
        const p = Math.min(1, Math.log10(1 + s.dustRun) / Math.log10(1 + t.goal));
        prog.firstChild.style.width = `${(s.trials[s.trial] ? 1 : p) * 100}%`;
        lbl.textContent = s.trials[s.trial] ? 'Complete! Sweep in the Kiln to return.' : `${fmt(s.dustRun)} / ${fmt(t.goal)} dust this run`;
      });
    }
    body.appendChild(h('h3', {}, 'Buildings'));
    for (const type of ['hourglass', 'crystal', 'prism', 'stone']) {
      if (!g.buildingUnlocked(type)) continue;
      body.appendChild(this.buildingRow(type));
    }
    const avail = D.UPGRADES.filter(u => g.upgradeAvailable(u) && this.upgradeVisible(u)).sort((a, b) => a.cost - b.cost);
    if (avail.length) {
      body.appendChild(h('h3', {}, 'Upgrades'));
      const grid = h('div', { class: 'ups' });
      for (const u of avail.slice(0, 10)) grid.appendChild(this.upgradeCard(u));
      body.appendChild(grid);
    }
    const owned = D.UPGRADES.filter(u => s.up[u.id]);
    if (owned.length) {
      body.appendChild(h('h3', {}, `Bought this run (${owned.length})`));
      body.appendChild(h('div', { class: 'owned-list' }, owned.map(u => u.name).join(' · ')));
    }
    if (s.sweeps === 0 && !g.kilnVisible() && Object.keys(s.up).length >= 6) {
      body.appendChild(h('p', { class: 'note' }, 'Something behind the curtain is warming up. Keep going.'));
    }
  }

  buildingRow(type) {
    const g = this.g, s = g.s, def = D.BUILDINGS[type];
    const countEl = h('span', { class: 'count' });
    const desc = h('div', { class: 'bld-desc' });
    const buyBtn = h('button', { class: 'btn primary', onclick: () => this.buy(type, 1) });
    const btns = h('div', { class: 'bld-buttons' }, buyBtn);
    let maxBtn = null;
    if (type === 'hourglass' || type === 'crystal') {
      maxBtn = h('button', { class: 'btn tiny', onclick: () => this.buy(type, Infinity), title: 'Buy as many as you can afford' }, 'Max');
      btns.appendChild(maxBtn);
    }
    const row = h('div', { class: 'bld' },
      h('div', { class: 'bld-icon ' + type }, def.icon),
      h('div', { class: 'bld-name' }, def.name, countEl),
      btns, desc);
    let ms = null;
    if (type === 'hourglass') {
      ms = h('div', { class: 'milestone', title: 'Milestones double hourglass flow' }, h('div'));
      row.appendChild(ms);
    }
    this.updaters.push(() => {
      const n = s.owned[type];
      countEl.textContent = type === 'stone' ? `${n} / ${g.stoneLimit()}` : (n ? `×${fmtInt(n)}` : '');
      const cost = g.costOf(type);
      const atLimit = n >= g.buildingLimit(type);
      buyBtn.disabled = atLimit || s.dust < cost;
      buyBtn.classList.toggle('hint', type === 'hourglass' && n === 0 && s.sweeps === 0 && s.dust >= cost);
      buyBtn.innerHTML = atLimit ? 'Limit reached' : `Buy · <span class="cost">✦ ${fmt(cost)}</span>`;
      if (maxBtn) maxBtn.disabled = s.dust < cost;
      let d;
      if (type === 'hourglass') {
        const nm = g.nextMilestone();
        d = `Pours ${fmt(g.hourglassRate())} grains/s each` + (g.milestoneCount() ? ` (milestones ${fmtMult(Math.pow(2, g.milestoneCount()))})` : '') + (nm ? ` · at ${nm}: flow ×2` : '');
        if (ms) {
          const prev = D.HG_MILESTONES[g.milestoneCount() - 1] || 0;
          ms.firstChild.style.width = nm ? `${100 * (n - prev) / (nm - prev)}%` : '100%';
        }
      } else if (type === 'crystal') d = `Topples on its cell give ${fmtMult(g.crystalBonus())} dust.`;
      else if (type === 'prism') d = `Each touching crystal ${fmtMult(g.prismFactor())}. Touch several!`;
      else d = def.desc;
      if (desc.textContent !== d) desc.textContent = d;
    });
    return row;
  }

  buy(type, n) {
    const g = this.g;
    let k = 0;
    while (k < n && g.canBuy(type)) {
      g.buyBuilding(type, true);
      k++;
      if (k > 2000) break;
    }
    if (k > 0) {
      audio.buy();
      if (g.s.inv[type] > 0 && !this.placing) this.setPlacing(type);
    }
    this.renderPanel(false);
  }

  upgradeCard(u) {
    const g = this.g, s = g.s;
    const bar = h('div', { class: 'bar' });
    const price = h('div', { class: 'price' });
    const card = h('button', {
      class: 'up', onclick: () => {
        if (g.buyUpgrade(u.id)) { audio.buy(); this.renderPanel(true); }
      },
    }, h('div', { class: 'name' }, u.name), h('div', { class: 'desc' }, u.desc), price, bar);
    this.updaters.push(() => {
      const can = s.dust >= u.cost;
      card.classList.toggle('cant', !can);
      price.innerHTML = `<span class="cost">✦ ${fmt(u.cost)}</span>`;
      bar.style.width = `${Math.min(100, 100 * s.dust / u.cost)}%`;
    });
    return card;
  }

  // ---- Kiln tab
  renderKiln(body) {
    const g = this.g, s = g.s;
    body.appendChild(h('h2', {}, 'The Kiln'));
    const card = h('div', { class: 'sweep-card' });
    const gainEl = h('div', { class: 'gain' });
    const sub = h('div', { class: 'small muted' });
    const prog = h('div', { class: 'progress' }, h('div'));
    const btn = h('button', { class: 'btn glassy big', onclick: () => this.confirmSweep() }, s.trial ? 'Sweep & end trial' : 'Sweep the table');
    card.append(h('div', { class: 'row' }, h('div', {}, gainEl, sub), btn), prog);
    card.appendChild(h('p', { class: 'note' }, 'Sweeping clears the table: dust, hourglasses, buildings and upgrades are lost. Glass, kiln upgrades, achievements and your layout (as a blueprint) remain.'));
    body.appendChild(card);
    this.updaters.push(() => {
      const gain = g.glassGain();
      if (gain >= 1) {
        gainEl.textContent = `+${fmt(gain)} glass`;
        const next = g.dustForGlass(gain + 1);
        sub.textContent = `next glass at ${fmt(next)} dust this run · ${fmtTime(s.stats.runTime)} into this run`;
        prog.firstChild.style.width = `${100 * Math.max(0, Math.min(1, (s.dustRun - g.dustForGlass(gain)) / (next - g.dustForGlass(gain))))}%`;
      } else {
        gainEl.textContent = 'Not hot enough';
        sub.textContent = `Earn ${fmt(g.dustForGlass(1))} dust in one run to make glass (${fmt(s.dustRun)} so far).`;
        prog.firstChild.style.width = `${100 * Math.min(1, Math.log10(1 + s.dustRun) / Math.log10(g.dustForGlass(1)))}%`;
      }
      btn.disabled = !(gain >= 1 || s.trial);
    });

    if (g.has('doctrine')) {
      body.appendChild(h('h3', {}, 'Doctrine'));
      if (!s.doctrine) body.appendChild(h('p', { class: 'note' }, 'Choose your first doctrine now. Afterwards you may change it whenever you sweep.'));
      else body.appendChild(h('p', { class: 'note' }, 'Your doctrine shapes the current run. Pick one for the next sweep (dashed).'));
      const grid = h('div', { class: 'doctrines' });
      for (const id in D.DOCTRINES) {
        if (!g.doctrineAvailable(id)) continue;
        const d = D.DOCTRINES[id];
        const next = this.nextDoctrine || s.doctrine;
        grid.appendChild(h('button', {
          class: 'doc' + (s.doctrine === id ? ' active' : '') + (next === id && s.doctrine !== id ? ' next' : ''),
          onclick: () => {
            if (!s.doctrine) { g.setDoctrine(id); this.nextDoctrine = id; }
            else this.nextDoctrine = id;
            this.renderPanel(true);
          },
        }, h('div', { class: 'name' }, `${d.icon} ${d.name}`, s.doctrine === id ? h('span', { class: 'small muted' }, ' · now') : null), h('div', { class: 'desc' }, d.desc)));
      }
      body.appendChild(grid);
    }

    body.appendChild(h('h3', {}, 'Glasswork'));
    const grid = h('div', { class: 'ups' });
    const items = D.KILN.filter(k => s.kiln[k.id] || g.kilnAvailable(k));
    const next = D.KILN.filter(k => !s.kiln[k.id] && !g.kilnAvailable(k) && (k.req || []).some(r => s.kiln[r])).slice(0, 2);
    const unbought = items.filter(k => !s.kiln[k.id]).sort((a, b) => a.cost - b.cost);
    for (const k of unbought) grid.appendChild(this.kilnCard(k));
    // polish
    const pPrice = h('div', { class: 'price' });
    const pBar = h('div', { class: 'bar' });
    const pDesc = h('div', { class: 'desc' });
    const pCard = h('button', { class: 'up kiln', onclick: () => { if (g.buyPolish()) { audio.buy(); this.renderPanel(true); } } },
      h('div', { class: 'name' }, `Polish ${s.polish ? '· level ' + s.polish : ''}`), pDesc, pPrice, pBar);
    this.updaters.push(() => {
      const c = g.polishCost();
      pCard.classList.toggle('cant', s.glass < c);
      pPrice.textContent = `◇ ${fmt(c)}`;
      pBar.style.width = `${Math.min(100, 100 * s.glass / c)}%`;
      pDesc.textContent = `Dust ×2, again and again. Now ${fmtMult(g.polishMult())}.`;
    });
    grid.appendChild(pCard);
    for (const k of next) grid.appendChild(h('div', { class: 'up kiln locked' }, h('div', { class: 'name' }, '???'), h('div', { class: 'desc' }, `Requires ${k.req.map(r => D.KILN_MAP[r].name).join(' & ')}`), h('div', { class: 'price' }, `◇ ${fmt(k.cost)}`)));
    body.appendChild(grid);
    const bought = items.filter(k => s.kiln[k.id]);
    if (bought.length) {
      body.appendChild(h('h3', {}, `Made (${bought.length} / ${D.KILN.length})`));
      body.appendChild(h('div', { class: 'owned-list' }, bought.map(k => h('span', { title: k.desc }, k.name + ' · '))));
    }
    if (!g.kilnActive()) body.appendChild(h('p', { class: 'note' }, 'Glassless: kiln upgrades have no effect during this trial (automation still works).'));
  }

  kilnCard(k) {
    const g = this.g, s = g.s;
    const bar = h('div', { class: 'bar' });
    const card = h('button', {
      class: 'up kiln', onclick: () => { if (g.buyKiln(k.id)) { audio.buy(); this.renderPanel(true); } },
    }, h('div', { class: 'name' }, k.name), h('div', { class: 'desc' }, k.desc), h('div', { class: 'price' }, `◇ ${fmt(k.cost)}`), bar);
    this.updaters.push(() => {
      card.classList.toggle('cant', s.glass < k.cost);
      bar.style.width = `${Math.min(100, 100 * s.glass / k.cost)}%`;
    });
    return card;
  }

  confirmSweep() {
    const g = this.g, s = g.s;
    const gain = g.glassGain();
    if (s.settings.confirmSweep === false && !s.trial) { this.doSweep(null); return; }
    const content = h('div', {},
      h('h2', {}, s.trial ? 'End the trial?' : 'Sweep the table?'),
      h('p', {}, gain > 0 ? `The kiln will give you ${fmt(gain)} glass.` : 'You will get no glass for this run.'),
      h('ul', {}, h('li', {}, 'Lost: dust, hourglasses, crystals, stones, prisms and dust upgrades.'), h('li', {}, 'Kept: glass, kiln upgrades, achievements, trials, and your layout as a blueprint.')),
      g.has('doctrine') ? h('p', { class: 'muted small' }, `Doctrine for the next run: ${D.DOCTRINES[this.nextDoctrine || s.doctrine || 'flow'].name} (change it in the Kiln tab).`) : null,
    );
    this.modal(content, [
      { label: 'Not yet' },
      { label: s.trial ? 'End trial' : 'Sweep', cls: 'glassy', fn: () => this.doSweep(null) },
    ]);
  }

  doSweep(trial) {
    const g = this.g;
    const doc = this.nextDoctrine || g.s.doctrine || (g.has('doctrine') ? 'flow' : null);
    if (trial) g.startTrial(trial); else g.sweep(doc);
    if (trial && doc && g.doctrineAvailable(doc)) g.s.doctrine = doc;
    g.recomputeFx();
    this.nextDoctrine = null;
    this.seenUps.clear();
    this.hooks.save();
    this.renderPanel(true);
  }

  // ---- Trials
  renderTrials(body) {
    const g = this.g, s = g.s;
    body.appendChild(h('h2', {}, 'Trials'));
    body.appendChild(h('p', { class: 'note' }, 'Starting a trial sweeps the table (you still get any glass you have earned). Reach the goal within one run to complete it. Rewards are permanent.'));
    for (const t of D.TRIALS) {
      const done = !!s.trials[t.id];
      const active = s.trial === t.id;
      const card = h('div', { class: 'trial' + (done ? ' done' : '') + (active ? ' active' : '') },
        h('div', { class: 't-head' }, h('span', { class: 't-name' }, t.name), h('span', { class: 'small muted' }, done ? '✓ complete' : `goal ✦ ${fmt(t.goal)}`)),
        h('div', { class: 't-rule' }, t.rule),
        h('div', { class: 't-reward' }, 'Reward: ' + t.reward));
      if (active) {
        const prog = h('div', { class: 'progress' }, h('div'));
        card.appendChild(prog);
        this.updaters.push(() => { prog.firstChild.style.width = `${100 * Math.min(1, Math.log10(1 + s.dustRun) / Math.log10(1 + t.goal))}%`; });
        card.appendChild(h('button', { class: 'btn', onclick: () => this.confirmSweep() }, done ? 'Sweep and return' : 'Abandon (sweep)'));
      } else if (!done) {
        card.appendChild(h('button', {
          class: 'btn primary', onclick: () => {
            const gain = g.glassGain();
            this.modal(h('div', {}, h('h2', {}, t.name), h('p', {}, t.rule), h('p', { class: 'muted' }, `This sweeps the table now${gain > 0 ? ` (+${fmt(gain)} glass)` : ''}.`)),
              [{ label: 'Not yet' }, { label: 'Begin trial', cls: 'primary', fn: () => this.doSweep(t.id) }]);
          },
        }, 'Begin'));
      }
      body.appendChild(card);
    }
  }

  // ---- Great Hourglass
  renderGreat(body) {
    const g = this.g, s = g.s;
    body.appendChild(h('h2', {}, 'The Great Hourglass'));
    const wrap = h('div', { class: 'great-wrap' });
    wrap.appendChild(h('div', { class: 'great-svg', html: greatSVG(s.great, s.sand, D.GREAT[4].sand) }));
    const list = h('div', { style: 'flex:1;min-width:0' });
    D.GREAT.forEach((st, idx) => {
      const done = s.great > idx;
      const cur = s.great === idx;
      if (!done && !cur) {
        list.appendChild(h('div', { class: 'stage', style: 'opacity:.35' }, h('div', { class: 's-name' }, '???')));
        return;
      }
      const costs = [];
      if (st.glass) costs.push(`◇ ${fmt(st.glass)} glass`);
      if (st.sand) costs.push(`⁂ ${fmt(st.sand)} sand`);
      if (st.trials) costs.push('all trials');
      const el = h('div', { class: 'stage' + (done ? ' done' : '') },
        h('div', { class: 's-name' }, (done ? '✓ ' : '') + st.name),
        h('div', { class: 'small muted' }, st.desc),
        h('div', { class: 'small', style: 'color:var(--good)' }, st.reward),
        h('div', { class: 'small' }, costs.join(' · ')));
      if (cur) {
        const btn = h('button', { class: 'btn glassy', style: 'margin-top:6px', onclick: () => { if (g.buildGreat()) this.renderPanel(true); } }, 'Build');
        const prog = h('div', { class: 'progress' }, h('div'));
        el.append(prog, btn);
        this.updaters.push(() => {
          btn.disabled = !g.canBuildGreat();
          let p = 1;
          if (st.glass) p = Math.min(p, s.glass / st.glass);
          if (st.sand) p = Math.min(p, s.sand / st.sand);
          prog.firstChild.style.width = `${100 * Math.max(0, p)}%`;
        });
      }
      list.appendChild(el);
    });
    if (s.great >= D.GREAT.length) {
      list.appendChild(h('button', { class: 'btn glassy big', onclick: () => this.showEnding(true) }, s.ended ? 'Turn it again' : 'Turn the hourglass'));
    }
    wrap.appendChild(list);
    body.appendChild(wrap);
    if (!g.fx.collectSand) body.appendChild(h('p', { class: 'note' }, 'Sand is collected once the lower bulb is built: every grain that falls off your last table.'));
  }

  // ---- Journal
  renderJournal(body) {
    const s = this.g.s;
    body.appendChild(h('h2', {}, 'Journal'));
    const box = h('div', { class: 'journal' });
    const ids = [...s.journal].reverse();
    ids.forEach((id, k) => {
      const j = D.JOURNAL.find(x => x.id === id);
      if (j) box.appendChild(h('p', { class: k === 0 ? 'latest' : '' }, j.text));
    });
    body.appendChild(box);
    body.appendChild(h('p', { class: 'note' }, `${s.journal.length} of ${D.JOURNAL.length} pages found.`));
  }

  // ---- Records
  renderRecords(body) {
    const g = this.g, s = g.s, st = s.stats;
    body.appendChild(h('h2', {}, 'Records'));
    const stats = h('div', { class: 'stats' });
    const rows = [
      ['Time played', () => fmtTime(st.played)],
      ['This run', () => fmtTime(st.runTime)],
      ['Total topples', () => fmt(st.topples)],
      ['Sand poured', () => `${fmt(g.analyze().grainRate * (s.buffs.sandstorm > 0 ? 10 : 1))} grains/s`],
      ['Topples per grain (average)', () => { const a = g.analyze(); return a.grainRate > 0 ? (a.topples / a.grainRate).toFixed(1) : '—'; }],
      ['Largest wave', () => `${fmtInt(st.maxWave)} cells at once`],
      ['Grains dropped by hand', () => fmt(st.handGrains)],
      ['Dust this run / all time', () => `${fmt(s.dustRun)} / ${fmt(s.dustAll)}`],
      ['Glass made', () => fmt(s.glassAll)],
      ['Sweeps', () => fmtInt(s.sweeps)],
      ['Quakes', () => fmtInt(st.quakes)],
      ['Gleams caught', () => fmtInt(st.gleams)],
      ['Best linger (topples per grain)', () => g.bestLinger.toFixed(1)],
      ['Achievement bonus', () => `+${Math.round(g.achCount() * D.ACH_BONUS * 100)}% dust`],
      ['Total dust multiplier', () => fmtMult(g.dustMultBase())],
    ];
    const vals = [];
    for (const [k, f] of rows) {
      const v = h('span');
      stats.append(h('span', { class: 'k' }, k), v);
      vals.push([v, f]);
    }
    this.updaters.push(() => { for (const [v, f] of vals) { const t = f(); if (v.textContent !== t) v.textContent = t; } });
    body.appendChild(stats);
    body.appendChild(h('h3', {}, `Achievements (${g.achCount()} / ${D.ACHIEVEMENTS.length})`));
    const grid = h('div', { class: 'achs' });
    for (const a of D.ACHIEVEMENTS) {
      const got = !!s.ach[a.id];
      grid.appendChild(h('div', { class: 'ach' + (got ? ' got' : ''), title: got || !a.secret ? a.desc : 'A secret.' },
        h('div', { class: 'an' }, got || !a.secret ? a.name : '???'), h('div', { class: 'ad' }, got || !a.secret ? a.desc : 'A secret.')));
    }
    body.appendChild(grid);
  }

  // ---- Options
  renderOptions(body) {
    const g = this.g, s = g.s, st = s.settings;
    body.appendChild(h('h2', {}, 'Options'));
    const toggle = (label, get, set, title) => {
      const id = 'opt_' + label.replace(/\W/g, '');
      const input = h('input', { type: 'checkbox', class: 'switch', id, onchange: (e) => { set(e.target.checked); this.applySettings(); } });
      input.checked = !!get();
      body.appendChild(h('div', { class: 'opt', title }, h('label', { for: id }, label), input));
    };
    toggle('Sound', () => st.sound, v => { st.sound = v; });
    const vol = h('input', { type: 'range', min: '0', max: '1', step: '0.05', value: String(st.volume ?? 0.5), oninput: (e) => { st.volume = +e.target.value; this.applySettings(); } });
    body.appendChild(h('div', { class: 'opt' }, h('span', {}, 'Volume'), vol));
    toggle('Auto-place new hourglasses, crystals and prisms', () => st.autoPlace, v => { st.autoPlace = v; }, 'New buildings go to the best spot (or your blueprint). Stones always wait for you.');
    toggle('Particles', () => st.particles !== false, v => { st.particles = v; });
    toggle('Confirm before sweeping', () => st.confirmSweep !== false, v => { st.confirmSweep = v; });
    toggle('Reduce motion', () => st.reduceMotion, v => { st.reduceMotion = v; });
    if (g.fx.auto.size) {
      body.appendChild(h('h3', {}, 'Automation'));
      if (g.hasAuto('hourglass')) toggle('Apprentice buys hourglasses', () => s.auto.hourglass, v => { s.auto.hourglass = v; });
      if (g.hasAuto('upgrades')) toggle('Journeyman buys upgrades', () => s.auto.upgrades, v => { s.auto.upgrades = v; });
      if (g.hasAuto('crystal')) toggle('Artisan buys crystals & prisms', () => s.auto.crystal, v => { s.auto.crystal = v; });
      if (g.hasAuto('quake')) toggle('Seismograph triggers quakes', () => s.auto.quake, v => { s.auto.quake = v; });
    }
    body.appendChild(h('h3', {}, 'Save'));
    body.appendChild(h('p', { class: 'note' }, 'The game saves itself every few seconds in this browser.'));
    const ta = h('textarea', { class: 'save', placeholder: 'Exported save appears here. Paste a save here to import it.' });
    body.appendChild(ta);
    body.appendChild(h('div', { class: 'btn-row' },
      h('button', { class: 'btn', onclick: () => { this.hooks.save(); this.toast('', 'Saved.', 'info'); } }, 'Save now'),
      h('button', { class: 'btn', onclick: () => { ta.value = this.hooks.exportSave(); ta.select(); try { navigator.clipboard.writeText(ta.value).then(() => this.toast('', 'Save copied to clipboard.', 'info'), () => {}); } catch (e) { /* no clipboard */ } } }, 'Export'),
      h('button', { class: 'btn', onclick: () => { if (ta.value.trim()) this.hooks.importSave(ta.value.trim()); } }, 'Import'),
      h('button', {
        class: 'btn', style: 'margin-left:auto;color:var(--warn)', onclick: () => this.modal(h('div', {}, h('h2', {}, 'Erase everything?'), h('p', {}, 'This deletes your save completely. There is no undo.')),
          [{ label: 'Keep playing' }, { label: 'Erase', cls: 'primary', fn: () => this.hooks.reset() }]),
      }, 'Hard reset')));
    body.appendChild(h('h3', {}, 'How to play'));
    body.appendChild(h('div', { class: 'note' }, h('p', {}, 'Each cell holds up to three grains. A fourth makes it topple: one grain goes to each neighbour, and grains pushed off the edge are lost. Every topple earns dust.'),
      h('p', {}, 'Click or hold to pour sand. Drag hourglasses and buildings to move them; drag them off the table (or right-click) to pocket them. Survey shows where sand is worth most.'),
      h('p', {}, 'Keys: Q quake · S survey · 1–3 switch table · Esc cancel.')));
    body.appendChild(h('p', { class: 'note small' }, 'Topple · an incremental game. Made with sand and JavaScript.'));
  }

  // ---------------------------------------------------------------- ending
  showEnding(force = false) {
    const g = this.g, s = g.s;
    if (this.endingShown && !force) return;
    if (s.great < D.GREAT.length) return;
    this.endingShown = true;
    const lines = [
      'You set your hands on the great glass.',
      'Every grain you ever dropped is in it — every topple, every sweep, every table.',
      'It is heavier than the house. It is lighter than a held breath.',
      'You turn it over.',
      'For a moment, nothing.',
      'Then the first grain falls, onto a small table, in a quiet room,',
      'and somewhere a pile decides it has had enough.',
    ];
    const box = h('div', { class: 'ending' });
    lines.forEach((l, i) => { const p = h('p', { style: `animation-delay:${0.4 + i * 1.6}s` }, l); box.appendChild(p); });
    box.appendChild(h('p', { style: `animation-delay:${0.6 + lines.length * 1.6}s;font-style:normal;font-size:15px;color:var(--muted)` },
      `The End · ${fmtTime(s.stats.played)} · ${fmtInt(s.sweeps)} sweeps · ${fmt(s.stats.topples)} topples`));
    audio.ending();
    this.modal(box, [{ label: 'Keep playing', cls: 'glassy', fn: () => { s.ended = true; this.hooks.save(); } }]);
    s.ended = true;
  }
}

function setText(id, t) {
  const el = $(id);
  if (el.textContent !== t) el.textContent = t;
}

function greatSVG(stage, sand, sandGoal) {
  const op = (k) => (stage >= k ? 1 : 0.12);
  const fill = stage >= 5 ? 1 : stage >= 4 ? Math.min(1, sand / Math.max(1, sandGoal)) : 0;
  const lowerFill = stage >= 2 ? Math.min(1, 0.25 + 0.75 * (stage >= 5 ? 1 : Math.min(1, sand / Math.max(1, sandGoal * 0.5)))) : 0;
  const ly = 250 - 90 * lowerFill;
  const uy = 60 + 80 * (1 - fill);
  return `<svg viewBox="0 0 120 270" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <clipPath id="gUp"><path d="M22 22 H98 C98 70 66 112 60 135 C54 112 22 70 22 22 Z"/></clipPath>
      <clipPath id="gLo"><path d="M60 135 C66 158 98 200 98 248 H22 C22 200 54 158 60 135 Z"/></clipPath>
    </defs>
    <g opacity="${op(1)}" stroke="#6b5440" stroke-width="5">
      <line x1="12" y1="14" x2="12" y2="256"/><line x1="108" y1="14" x2="108" y2="256"/>
      <rect x="4" y="8" width="112" height="10" rx="3" fill="#3b2c20"/><rect x="4" y="252" width="112" height="10" rx="3" fill="#3b2c20"/>
    </g>
    <rect x="0" y="${ly}" width="120" height="${250 - ly}" fill="#e3b26c" clip-path="url(#gLo)" opacity="${stage >= 2 ? 0.95 : 0}"/>
    <rect x="0" y="${uy}" width="120" height="${140 - uy}" fill="#e3b26c" clip-path="url(#gUp)" opacity="${stage >= 4 ? 0.95 : 0}"/>
    <path d="M60 135 C66 158 98 200 98 248 H22 C22 200 54 158 60 135 Z" fill="none" stroke="#a9e2dc" stroke-width="2" opacity="${op(2)}"/>
    <path d="M22 22 H98 C98 70 66 112 60 135 C54 112 22 70 22 22 Z" fill="none" stroke="#a9e2dc" stroke-width="2" opacity="${op(4)}"/>
    <circle cx="60" cy="135" r="4" fill="none" stroke="#a9e2dc" stroke-width="2" opacity="${op(3)}"/>
    ${stage >= 5 ? '<line x1="60" y1="135" x2="60" y2="240" stroke="#e3b26c" stroke-width="1.5" stroke-dasharray="3 4"><animate attributeName="stroke-dashoffset" from="0" to="-14" dur="0.6s" repeatCount="indefinite"/></line>' : ''}
  </svg>`;
}
