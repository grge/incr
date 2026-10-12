// Draws the skirmish: each cell in its owner's colour, brighter the fuller it
// is, with the front lines between players picked out. Spouts and wells are
// drawn on top.
import { ROCK, CRACK, OUT } from '../../js/voronoi.js';
import { mulberry32 } from '../../js/region.js';
import { NEUTRAL, RULES } from './war.js';

// empty → full, per owner
export const COLORS = [
  { lo: [96, 70, 40], hi: [246, 200, 120], ui: '#e8b86a', name: 'You' },
  { lo: [34, 52, 92], hi: [128, 176, 246], ui: '#7fb0f4', name: 'Rival' },
];
const NEUTRAL_LO = [58, 53, 48], NEUTRAL_HI = [104, 96, 86];

function mix(a, b, t) { return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]; }

export class View {
  constructor(canvas, war) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.W = war.W;
    this.off = document.createElement('canvas');
    this.off.width = this.off.height = this.W;
    this.octx = this.off.getContext('2d');
    this.img = this.octx.createImageData(this.W, this.W);
    const R = mulberry32(99);
    this.noise = new Float32Array(this.W * this.W);
    for (let i = 0; i < this.noise.length; i++) this.noise[i] = 1 + (R() - 0.5) * 0.12;
    this.time = 0;
    this.css = 640;
    this.setWar(war);
  }

  setWar(war) { this.war = war; }

  resize(css) {
    this.css = css;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.canvas.style.width = css + 'px';
    this.canvas.style.height = css + 'px';
    this.canvas.width = Math.round(css * dpr);
    this.canvas.height = Math.round(css * dpr);
    this.dpr = dpr;
    this.scale = css / this.W;
  }

  toRaster(clientX, clientY) {
    const r = this.canvas.getBoundingClientRect();
    return [(clientX - r.left) / this.scale, (clientY - r.top) / this.scale];
  }

  draw(dt, o = {}) {
    const war = this.war, g = war.g, W = this.W, n = g.n;
    this.time += dt;
    const own = war.own, gr = war.grains;
    const cr = new Float32Array(n), cg = new Float32Array(n), cb = new Float32Array(n);
    const decay = Math.exp(-dt * 7), slow = Math.exp(-dt * 2.5);
    for (let c = 0; c < n; c++) {
      const f = Math.min(1, gr[c] / Math.max(1, g.thr[c] - 1));
      let col;
      if (own[c] === NEUTRAL) col = mix(NEUTRAL_LO, NEUTRAL_HI, Math.min(1, gr[c] / 4));
      else col = mix(COLORS[own[c]].lo, COLORS[own[c]].hi, 0.15 + 0.85 * f);
      let [r, gg, b] = col;
      const fl = war.flash[c];
      if (fl > 0.02) { r += (255 - r) * fl * 0.55; gg += (250 - gg) * fl * 0.55; b += (235 - b) * fl * 0.55; war.flash[c] = fl * decay; } else war.flash[c] = 0;
      const tk = war.taken[c];
      if (tk > 0.02) { r += (255 - r) * tk * 0.6; gg += (255 - gg) * tk * 0.6; b += (255 - b) * tk * 0.6; war.taken[c] = tk * slow; } else war.taken[c] = 0;
      if (c === o.hover) { r = r * 1.1 + 12; gg = gg * 1.1 + 12; b = b * 1.1 + 12; }
      cr[c] = r; cg[c] = gg; cb[c] = b;
    }
    const data = this.img.data;
    const lab = war.tess.lab, cellOf = g.cellOf, border = g.border, mask = war.mask, noise = this.noise;
    const other = (q, oc) => { const s2 = lab[q]; const c2 = s2 >= 0 ? cellOf[s2] : -1; return c2 >= 0 && own[c2] !== oc; };
    for (let p = 0, j = 0; p < lab.length; p++, j += 4) {
      const m = mask[p], nz = noise[p];
      if (m === OUT) { data[j + 3] = 0; continue; }
      let r, gg, b;
      if (m === ROCK) { r = 50 * nz; gg = 46 * nz; b = 44 * nz; }
      else if (m === CRACK) { r = 10 * nz; gg = 8 * nz; b = 8 * nz; }
      else {
        const s = lab[p];
        const c = s >= 0 ? cellOf[s] : -1;
        if (c < 0) { r = 30; gg = 26; b = 22; }
        else {
          r = cr[c]; gg = cg[c]; b = cb[c];
          if (border[p]) {
            // the front: where this cell meets someone else's
            const x = p % W, oc = own[c];
            const front = oc !== NEUTRAL && ((x > 0 && other(p - 1, oc)) || (x < W - 1 && other(p + 1, oc)) || (p >= W && other(p - W, oc)) || (p + W < lab.length && other(p + W, oc)));
            if (front && oc !== NEUTRAL) { const k = 0.55; r += (255 - r) * k; gg += (250 - gg) * k; b += (240 - b) * k; }
            else { r *= 0.6; gg *= 0.6; b *= 0.6; }
          }
          r *= nz; gg *= nz; b *= nz;
        }
      }
      data[j] = r; data[j + 1] = gg; data[j + 2] = b; data[j + 3] = 255;
    }
    this.octx.putImageData(this.img, 0, 0);

    const ctx = this.ctx, sc = this.scale;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.css, this.css);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(this.off, 0, 0, this.css, this.css);

    // wells
    const sel = o.selected;
    for (const w of war.wells) {
      const on = sel && sel.type === 'well' && sel.w === w;
      drawWell(ctx, w, sc, war.capacity(w), on, this.time, w.lost > 0);
      if (on || (o.hoverWell === w)) {
        ctx.save();
        ctx.strokeStyle = COLORS[w.owner].ui;
        ctx.globalAlpha = 0.25;
        ctx.setLineDash([2, 6]);
        ctx.beginPath(); ctx.arc(w.x * sc, w.y * sc, w.r * RULES.reach * sc, 0, Math.PI * 2); ctx.stroke();
        ctx.restore();
      }
    }
    // spouts
    war.spouts.forEach((sp, k) => {
      const on = sel && sel.type === 'spout' && sel.k === k;
      const col = sp.owner === NEUTRAL ? '#b8ab9a' : COLORS[sp.owner].ui;
      drawSpout(ctx, sp.x * sc, sp.y * sc, col, this.time, on, sp.home !== null);
      if (sp.owner === 0 && war.spoutsOf(0).length > 1) {
        const rate = war.spoutRate(k);
        label(ctx, `${rate < 10 ? rate.toFixed(1) : Math.round(rate)}/s`, sp.x * sc, sp.y * sc + 19, col);
      }
    });
    // placing a well
    if (o.ghost) {
      const [x, y] = o.ghost.pos;
      ctx.globalAlpha = 0.65;
      drawWell(ctx, { x, y, r: RULES.wellR, pull: o.ghost.pull, owner: 0, extra: 0 }, sc, 1, false, this.time, !o.ghost.ok);
      ctx.save();
      ctx.strokeStyle = o.ghost.ok ? COLORS[0].ui : '#f08a63';
      ctx.globalAlpha = 0.22;
      ctx.setLineDash([2, 6]);
      ctx.beginPath(); ctx.arc(x * sc, y * sc, RULES.wellR * RULES.reach * sc, 0, Math.PI * 2); ctx.stroke();
      ctx.restore();
      ctx.globalAlpha = 1;
    }
  }
}

function label(ctx, text, x, y, col) {
  ctx.font = '600 11px Inter, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const w = ctx.measureText(text).width + 8;
  ctx.fillStyle = 'rgba(14,12,10,0.8)';
  ctx.fillRect(x - w / 2, y - 7, w, 14);
  ctx.fillStyle = col;
  ctx.fillText(text, x, y);
}

function drawWell(ctx, w, sc, cap, on, t, bad) {
  const col = bad ? '#f08a63' : COLORS[w.owner].ui;
  const x = w.x * sc, y = w.y * sc;
  ctx.save();
  ctx.strokeStyle = col;
  ctx.globalAlpha *= on ? 0.95 : 0.7;
  ctx.lineWidth = on ? 1.8 : 1.2;
  ctx.setLineDash([4, 4]);
  ctx.lineDashOffset = -t * 8 * (w.owner ? -1 : 1);
  ctx.beginPath(); ctx.arc(x, y, w.r * sc, 0, Math.PI * 2); ctx.stroke();
  ctx.setLineDash([]);
  ctx.globalAlpha = 1;
  const s = 4 + 1.8 * Math.sqrt(w.pull || 0);
  ctx.fillStyle = 'rgba(14,12,10,0.7)';
  ctx.beginPath(); ctx.arc(x, y, s + 4, 0, Math.PI * 2); ctx.fill();
  // how full it is: the cells it holds, of what it can hold
  const f = cap > 0 ? Math.min(1, (w.extra || 0) / cap) : 0;
  ctx.strokeStyle = col;
  ctx.lineWidth = 2.5;
  ctx.beginPath(); ctx.arc(x, y, s + 4, -Math.PI / 2, -Math.PI / 2 + f * Math.PI * 2); ctx.stroke();
  ctx.fillStyle = col;
  ctx.beginPath(); ctx.arc(x, y, s, 0, Math.PI * 2); ctx.fill();
  if (on) { ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(x, y, s + 8, 0, Math.PI * 2); ctx.stroke(); }
  ctx.restore();
}

function drawSpout(ctx, x, y, col, t, on, home) {
  const s = home ? 8.5 : 7;
  ctx.save();
  ctx.translate(x, y);
  ctx.fillStyle = 'rgba(14,12,10,0.65)';
  ctx.beginPath(); ctx.arc(0, 0, s + 4, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = col;
  ctx.lineWidth = home ? 2 : 1.4;
  ctx.beginPath(); ctx.arc(0, 0, s + 4, 0, Math.PI * 2); ctx.stroke();
  if (on) { ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(0, 0, s + 8, 0, Math.PI * 2); ctx.stroke(); }
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  ctx.moveTo(-s * 0.7, -s); ctx.lineTo(s * 0.7, -s); ctx.lineTo(0, 0); ctx.closePath();
  ctx.moveTo(-s * 0.7, s); ctx.lineTo(s * 0.7, s); ctx.lineTo(0, 0); ctx.closePath();
  ctx.stroke();
  ctx.fillStyle = col;
  const ph = (t * 1.5) % 1;
  ctx.beginPath(); ctx.arc(0, -s * 0.2 + ph * s, 1.3, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
}
