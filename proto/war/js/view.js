// Draws the skirmish as an abstract network. Underneath, a soft field of
// territory; on top, every cell as a point joined to its neighbours, filling
// with its owner's charge and ringing when it fires. Nodes are hexagons,
// wells are vortices, bursts are shockwaves.
import { ROCK, CRACK, OUT } from '../../js/voronoi.js';
import { NEUTRAL, RULES } from './war.js';

export const COLORS = [
  { rgb: [64, 224, 208], css: '#40e0d0', name: 'You' },
  { rgb: [255, 128, 72], css: '#ff8048', name: 'Rival' },
];
const SLATE = '#5a6678';
const BASE = [17, 21, 29], ROCKC = [30, 36, 47];

const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const rgba = (c, a) => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a})`;

export class View {
  constructor(canvas, war) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.W = war.W;
    this.off = document.createElement('canvas');
    this.off.width = this.off.height = this.W;
    this.octx = this.off.getContext('2d');
    this.img = this.octx.createImageData(this.W, this.W);
    this.time = 0;
    this.cw = this.ch = 360;
    this.waves = [];
    this.fieldAt = -1;
    this.setWar(war);
  }

  setWar(war) {
    this.war = war;
    this.waves = [];
    this.fieldAt = -1;
    if (this.cw) this.resize(this.cw, this.ch);
  }

  // Fit the land to a cw × ch box, turned so that your home is at the bottom
  // (or on the left, on a wide screen).
  resize(cw, ch) {
    this.cw = cw; this.ch = ch;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.canvas.style.width = cw + 'px';
    this.canvas.style.height = ch + 'px';
    this.canvas.width = Math.round(cw * dpr);
    this.canvas.height = Math.round(ch * dpr);
    this.dpr = dpr;
    const war = this.war, W = this.W, C = W / 2;
    const home = war.nodes.find(nd => nd.home === 0);
    const want = ch >= cw ? Math.PI / 2 : Math.PI;
    // quarter turns only: they are cheap to draw
    const th = Math.round((want - Math.atan2(home.y - C, home.x - C)) / (Math.PI / 2)) * (Math.PI / 2);
    const cs = Math.cos(th), sn = Math.sin(th);
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    const mask = war.mask;
    for (let y = 0; y < W; y += 2) for (let x = 0; x < W; x += 2) {
      if (mask[y * W + x] === OUT) continue;
      const dx = x + 0.5 - C, dy = y + 0.5 - C;
      const u = cs * dx - sn * dy, v = sn * dx + cs * dy;
      if (u < u0) u0 = u; if (u > u1) u1 = u; if (v < v0) v0 = v; if (v > v1) v1 = v;
    }
    const pad = 14;
    const s = Math.min((cw - 2 * pad) / (u1 - u0 + 2), (ch - 2 * pad) / (v1 - v0 + 2));
    this.scale = s; this.cs = Math.round(cs); this.sn = Math.round(sn);
    this.ox = cw / 2 - s * (u0 + u1) / 2;
    this.oy = ch / 2 - s * (v0 + v1) / 2;
    this.cache = document.createElement('canvas');
    this.cache.width = this.canvas.width;
    this.cache.height = this.canvas.height;
    this.fieldAt = -1;
  }

  // raster → screen (css px), and back
  P(x, y) {
    const dx = x - this.W / 2, dy = y - this.W / 2, s = this.scale;
    return [this.ox + s * (this.cs * dx - this.sn * dy), this.oy + s * (this.sn * dx + this.cs * dy)];
  }
  toRaster(clientX, clientY) {
    const r = this.canvas.getBoundingClientRect();
    const dx = (clientX - r.left - this.ox) / this.scale, dy = (clientY - r.top - this.oy) / this.scale;
    return [this.W / 2 + this.cs * dx + this.sn * dy, this.W / 2 - this.sn * dx + this.cs * dy];
  }

  // A ring that sweeps out from (x, y) to radius r (raster units).
  shockwave(x, y, r, owner) { this.waves.push({ x, y, r, owner, t: 0 }); }

  draw(dt, o = {}) {
    const war = this.war, g = war.g, W = this.W, n = g.n;
    this.time += dt;
    const own = war.own, gr = war.grains;
    const fill = new Float32Array(n);
    for (let c = 0; c < n; c++) fill[c] = Math.min(1, gr[c] / Math.max(1, g.thr[c]));

    // ---- the territory field (redrawn about 20 times a second)
    this.fieldAt -= dt;
    const ctx = this.ctx, sc = this.scale, P = (x, y) => this.P(x, y);
    if (this.fieldAt < 0 || this.layoutSeen !== war.layoutV) {
      this.fieldAt = 0.05;
      this.layoutSeen = war.layoutV;
      this.field(fill);
      // scale and turn it once into a screen-sized cache
      const k = this.cache.getContext('2d'), C = W / 2, dp = this.dpr;
      k.setTransform(1, 0, 0, 1, 0, 0);
      k.clearRect(0, 0, this.cache.width, this.cache.height);
      k.setTransform(dp * sc * this.cs, dp * sc * this.sn, -dp * sc * this.sn, dp * sc * this.cs,
        dp * (this.ox - sc * (this.cs * C - this.sn * C)), dp * (this.oy - sc * (this.sn * C + this.cs * C)));
      k.imageSmoothingEnabled = true;
      k.imageSmoothingQuality = 'medium';
      k.drawImage(this.off, 0, 0, W, W);
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.drawImage(this.cache, 0, 0);
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.vectors(dt, o, fill, P, sc);
  }

  field(fill) {
    const war = this.war, g = war.g, n = g.n, own = war.own;
    const data = this.img.data;
    const lab = war.tess.lab, cellOf = g.cellOf, border = g.border, mask = war.mask;
    const col = new Array(n);
    for (let c = 0; c < n; c++) {
      const oc = own[c];
      let base = oc === NEUTRAL ? BASE : mix(BASE, COLORS[oc].rgb, 0.13 + 0.12 * fill[c]);
      const tk = war.taken[c];
      if (tk > 0.02) base = mix(base, [255, 255, 255], 0.35 * tk);
      col[c] = base;
    }
    for (let p = 0, j = 0; p < lab.length; p++, j += 4) {
      const m = mask[p];
      if (m === OUT) { data[j + 3] = 0; continue; }
      let r, gg, b;
      if (m === ROCK) [r, gg, b] = ROCKC;
      else if (m === CRACK) { r = 2; gg = 3; b = 6; }
      else {
        const s = lab[p];
        const c = s >= 0 ? cellOf[s] : -1;
        if (c < 0) [r, gg, b] = BASE;
        else {
          [r, gg, b] = col[c];
          if (border[p]) { r *= 0.8; gg *= 0.8; b *= 0.8; }
        }
      }
      data[j] = r; data[j + 1] = gg; data[j + 2] = b; data[j + 3] = 255;
    }
    this.octx.putImageData(this.img, 0, 0);
  }

  vectors(dt, o, fill, P, sc) {
    const war = this.war, g = war.g, n = g.n, own = war.own, gr = war.grains, ctx = this.ctx;
    const pts = new Float32Array(n * 2);
    for (let c = 0; c < n; c++) { const [x, y] = P(g.cx[c], g.cy[c]); pts[2 * c] = x; pts[2 * c + 1] = y; }

    // ---- links between cells
    const paths = [new Path2D(), new Path2D()], neutral = new Path2D(), front = new Path2D();
    for (let c = 0; c < n; c++) {
      for (let e = g.nbrStart[c]; e < g.nbrStart[c + 1]; e++) {
        const b = g.nbr[e];
        if (b < c) continue;
        const a = own[c], d = own[b];
        const path = a === d ? (a === NEUTRAL ? neutral : paths[a]) : (a !== NEUTRAL && d !== NEUTRAL ? front : paths[a === NEUTRAL ? d : a]);
        path.moveTo(pts[2 * c], pts[2 * c + 1]);
        path.lineTo(pts[2 * b], pts[2 * b + 1]);
      }
    }
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(90,102,120,0.14)';
    ctx.stroke(neutral);
    for (let p = 0; p < 2; p++) { ctx.strokeStyle = rgba(COLORS[p].rgb, 0.28); ctx.stroke(paths[p]); }
    ctx.lineWidth = 1.6;
    ctx.strokeStyle = `rgba(255,240,220,${0.45 + 0.25 * Math.sin(this.time * 9)})`;
    ctx.stroke(front);

    // ---- cells: a ring, filled as they charge, ringing out when they fire
    const ring = [new Path2D(), new Path2D()], core = [new Path2D(), new Path2D()], nring = new Path2D(), ncore = new Path2D();
    const rad = new Float32Array(n);
    for (let c = 0; c < n; c++) {
      const r = Math.max(1.6, Math.min(7, 0.3 * Math.sqrt(g.area[c]))) * sc;
      rad[c] = r;
      const x = pts[2 * c], y = pts[2 * c + 1], oc = own[c];
      const rp = oc === NEUTRAL ? nring : ring[oc];
      rp.moveTo(x + r, y); rp.arc(x, y, r, 0, Math.PI * 2);
      const f = oc === NEUTRAL ? Math.min(1, gr[c] / 4) : fill[c];
      if (f > 0.02) {
        const cp = oc === NEUTRAL ? ncore : core[oc];
        const ri = r * Math.sqrt(f) * 0.85;
        cp.moveTo(x + ri, y); cp.arc(x, y, ri, 0, Math.PI * 2);
      }
    }
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(90,102,120,0.28)'; ctx.stroke(nring);
    ctx.fillStyle = 'rgba(120,132,150,0.5)'; ctx.fill(ncore);
    for (let p = 0; p < 2; p++) {
      ctx.strokeStyle = rgba(COLORS[p].rgb, 0.7); ctx.stroke(ring[p]);
      ctx.fillStyle = COLORS[p].css; ctx.fill(core[p]);
    }
    const decay = Math.exp(-dt * 5), slow = Math.exp(-dt * 2.5);
    ctx.lineWidth = 1.4;
    for (let c = 0; c < n; c++) {
      const fl = war.flash[c];
      if (fl > 0.03 && own[c] !== NEUTRAL) {
        ctx.strokeStyle = rgba(COLORS[own[c]].rgb, fl * 0.9);
        ctx.beginPath(); ctx.arc(pts[2 * c], pts[2 * c + 1], rad[c] * (1 + (1 - fl) * 1.6), 0, Math.PI * 2); ctx.stroke();
        war.flash[c] = fl * decay;
      } else war.flash[c] = 0;
      if (war.taken[c] > 0.02) war.taken[c] *= slow; else war.taken[c] = 0;
    }

    // ---- wells
    const k = Math.max(1, Math.min(1.6, sc / 1.6));   // glyphs grow a little on big boards
    for (const w of war.wells) { const [x, y] = P(w.x, w.y); drawWell(ctx, w, x, y, sc, war.capacity(w), this.time, w.owner === 0, k); }
    // ---- nodes
    war.nodes.forEach((nd, i) => { const [x, y] = P(nd.x, nd.y); drawNode(ctx, nd, x, y, war.nodeRate(i), this.time, k); });
    // ---- wells being grown under a finger
    for (const hd of o.holds || []) {
      const [x, y] = P(hd.x, hd.y);
      ctx.save();
      ctx.strokeStyle = hd.ok ? COLORS[0].css : '#ff5a5a';
      ctx.globalAlpha = 0.9;
      ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(x, y, 30, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * Math.min(1, hd.frac || 0)); ctx.stroke();
      ctx.globalAlpha = 0.3; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(x, y, 30, 0, Math.PI * 2); ctx.stroke();
      ctx.restore();
    }
    // ---- shockwaves
    this.waves = this.waves.filter(wv => wv.t < 1);
    for (const wv of this.waves) {
      wv.t += dt / 0.7;
      const e = 1 - Math.pow(1 - Math.min(1, wv.t), 3);
      ctx.strokeStyle = rgba(COLORS[wv.owner].rgb, 0.8 * (1 - wv.t));
      ctx.lineWidth = 3 * (1 - wv.t) + 1;
      const [x, y] = P(wv.x, wv.y);
      ctx.beginPath(); ctx.arc(x, y, wv.r * sc * e, 0, Math.PI * 2); ctx.stroke();
    }
  }
}

function drawWell(ctx, w, x, y, sc, cap, t, mine, k = 1) {
  const c = COLORS[w.owner];
  const R = w.r * sc;
  const spin = t * (0.6 + 0.12 * w.pull) * (w.owner ? -1 : 1);
  ctx.save();
  ctx.lineCap = 'round';
  // the reach
  if (mine) {
    ctx.strokeStyle = rgba(c.rgb, 0.16);
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 7]);
    ctx.beginPath(); ctx.arc(x, y, w.r * RULES.reach * sc, 0, Math.PI * 2); ctx.stroke();
    ctx.setLineDash([]);
  }
  // the vortex: arcs turning inwards
  for (let k = 0; k < 3; k++) {
    const rr = R * (1 - k * 0.3);
    ctx.strokeStyle = rgba(c.rgb, 0.55 - k * 0.1);
    ctx.lineWidth = 2;
    for (let a = 0; a < 3; a++) {
      const a0 = spin * (1 + k * 0.5) + a * Math.PI * 2 / 3 + k;
      ctx.beginPath(); ctx.arc(x, y, rr, a0, a0 + 1.1); ctx.stroke();
    }
  }
  // how full it is
  const f = cap > 0 ? Math.min(1, (w.extra || 0) / cap) : 0;
  const r0 = 9 * k;
  ctx.fillStyle = 'rgba(8,10,14,0.85)';
  ctx.beginPath(); ctx.arc(x, y, r0, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = rgba(c.rgb, 0.3); ctx.lineWidth = 3;
  ctx.beginPath(); ctx.arc(x, y, r0, 0, Math.PI * 2); ctx.stroke();
  ctx.strokeStyle = c.css;
  ctx.beginPath(); ctx.arc(x, y, r0, -Math.PI / 2, -Math.PI / 2 + f * Math.PI * 2); ctx.stroke();
  ctx.fillStyle = c.css;
  ctx.beginPath(); ctx.arc(x, y, (2.5 + Math.min(4, w.pull * 0.5)) * k, 0, Math.PI * 2); ctx.fill();
  if (w.lost > 0) {
    ctx.strokeStyle = `rgba(255,90,90,${0.5 + 0.5 * Math.sin(t * 20)})`;
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(x, y, r0 + 4, 0, Math.PI * 2); ctx.stroke();
  }
  ctx.restore();
}

function hex(ctx, x, y, r, rot = 0) {
  ctx.beginPath();
  for (let k = 0; k < 6; k++) {
    const a = rot + k * Math.PI / 3;
    if (k) ctx.lineTo(x + r * Math.cos(a), y + r * Math.sin(a)); else ctx.moveTo(x + r * Math.cos(a), y + r * Math.sin(a));
  }
  ctx.closePath();
}

function drawNode(ctx, nd, x, y, rate, t, k = 1) {
  const R = (nd.home !== null ? 13 : 11) * k;
  const owned = nd.owner !== NEUTRAL;
  const col = owned ? COLORS[nd.owner].css : SLATE;
  ctx.save();
  ctx.fillStyle = 'rgba(8,10,14,0.9)';
  hex(ctx, x, y, R + 2); ctx.fill();
  ctx.strokeStyle = col;
  ctx.lineWidth = 2;
  hex(ctx, x, y, R); ctx.stroke();
  if (nd.home !== null) { ctx.lineWidth = 1; hex(ctx, x, y, R - 4); ctx.stroke(); }
  if (owned) {
    // a spinner whose speed is the flow through it
    const a = t * (1 + rate * 0.6);
    ctx.fillStyle = col;
    for (let k = 0; k < 3; k++) {
      const b = a + k * Math.PI * 2 / 3;
      ctx.beginPath(); ctx.arc(x + Math.cos(b) * 4.5 * k, y + Math.sin(b) * 4.5 * k, 1.8 * k, 0, Math.PI * 2); ctx.fill();
    }
    if (nd.share > 1) {
      // focused: a pulsing outer hex
      ctx.strokeStyle = col;
      ctx.globalAlpha = 0.45 + 0.4 * Math.sin(t * 6);
      ctx.lineWidth = 2;
      hex(ctx, x, y, R + 6 + 1.5 * Math.sin(t * 6)); ctx.stroke();
    }
  } else {
    ctx.fillStyle = col;
    ctx.beginPath(); ctx.arc(x, y, 2.2, 0, Math.PI * 2); ctx.fill();
  }
  ctx.restore();
}
