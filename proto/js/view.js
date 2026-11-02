// Draws the region: every pixel takes its cell's sand colour, with rock,
// cracks, ore, worn ground and crowded (gem-pressing) cells drawn into the
// same raster. Taps, weights, comb strokes and hints are drawn on top.
import { FREE, ROCK, CRACK, OUT } from './voronoi.js';
import { mulberry32, RECIPES, COMB } from './region.js';

const PAL = [[86, 62, 42], [140, 102, 62], [196, 152, 94], [234, 196, 130]];
const STRATA = [[181, 116, 63], [138, 75, 51], [92, 70, 96], [52, 60, 84]];
const KIND_COL = { relic: '#ffd479', spring: '#7cc8ff', ore: '#c9a2ff', cave: '#e0e0e0' };
const GEM = [196, 120, 255];
export const TAP_COL = '#e3b26c', WEIGHT_COL = '#b98cff', COMB_COL = '#a9e2dc';

function ramp(stops, t) {
  t = Math.max(0, Math.min(1, t)) * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(t)), f = t - i;
  const a = stops[i], b = stops[i + 1];
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
}
const HEAT = [[40, 26, 20], [200, 90, 40], [250, 200, 90], [255, 250, 220]];
// shallow ground is pale, wells are deep water-blue
const DEEP = [[226, 206, 168], [150, 176, 170], [72, 112, 150], [38, 52, 110], [24, 16, 58]];

export class View {
  constructor(canvas, game) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.game = game;
    this.W = game.W;
    this.off = document.createElement('canvas');
    this.off.width = this.off.height = this.W;
    this.octx = this.off.getContext('2d');
    this.img = this.octx.createImageData(this.W, this.W);
    const R = mulberry32(99);
    this.noise = new Float32Array(this.W * this.W);
    for (let i = 0; i < this.noise.length; i++) this.noise[i] = 1 + (R() - 0.5) * 0.12;
    this.time = 0;
    this.css = 640;
  }

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
    const game = this.game, g = game.g, W = this.W;
    this.time += dt;
    const pile = game.pile;
    const ov = o.overlay || 'none';
    // per-cell colours
    const n = g.n;
    const cr = new Float32Array(n), cg = new Float32Array(n), cb = new Float32Array(n);
    let hm = 0, hv = null;
    if (ov === 'flow') hv = game.u;
    if (hv) for (let c = 0; c < n; c++) if (hv[c] > hm) hm = hv[c];
    let gm = 0;
    for (let c = 0; c < n; c++) if (game.gem[c] > gm) gm = game.gem[c];
    const decay = Math.exp(-dt * 6);
    for (let c = 0; c < n; c++) {
      let r, gg, b;
      if (hv) [r, gg, b] = ramp(HEAT, hm > 0 ? Math.sqrt(hv[c] / hm) : 0);
      else {
        const f = Math.min(1, pile.grains[c] / Math.max(1, g.thr[c] - 1));
        [r, gg, b] = ramp(PAL, f);
        if (pile.grains[c] >= g.thr[c]) { r = 255; gg = 244; b = 214; }
        const fl = pile.flash[c];
        if (fl > 0.02) { r += (255 - r) * fl * 0.7; gg += (226 - gg) * fl * 0.65; b += (160 - b) * fl * 0.5; pile.flash[c] = fl * decay; } else pile.flash[c] = 0;
        if (ov === 'pressure') { const m = (r + gg + b) / 3 * 0.55; r = gg = b = m; }
      }
      // crowded cells press out gems: tint them violet
      const gp = game.gem[c];
      if (gp > 0 && ov !== 'flow') {
        const k = ov === 'pressure' ? 0.35 + 0.6 * Math.min(1, gp / Math.max(1, gm)) : Math.min(0.4, 0.12 + 0.15 * gp);
        r += (GEM[0] - r) * k; gg += (GEM[1] - gg) * k; b += (GEM[2] - b) * k;
      }
      if (c === o.hover) { r = r * 1.12 + 10; gg = gg * 1.12 + 10; b = b * 1.12 + 10; }
      cr[c] = r; cg[c] = gg; cb[c] = b;
    }
    const data = this.img.data;
    const lab = game.tess.lab, cellOf = g.cellOf, border = g.border, mask = game.mask, ore = game.ore, depth = game.depth, noise = this.noise;
    const zone = game.region.zone, zones = game.region.zones, river = game.region.river;
    const tints = zones.map(z => RECIPES[z.recipe].tint);
    const tk = ov === 'zones' ? 4 : 1;
    const depthMode = ov === 'depth';
    let pot = null, pmax = 1;
    if (ov === 'wells') { pot = game.potential(); pmax = game.vPixMax || 1; }
    const LV = 16;
    const sparkle = 0.5 + 0.5 * Math.sin(this.time * 3);
    for (let p = 0, j = 0; p < lab.length; p++, j += 4) {
      const m = mask[p];
      const nz = noise[p];
      if (m === OUT) { data[j + 3] = 0; continue; }
      let r, gg, b;
      if (m === ROCK) { r = 58 * nz; gg = 52 * nz; b = 47 * nz; }
      else if (m === CRACK) { r = 12 * nz; gg = 9 * nz; b = 8 * nz; }
      else {
        const s = lab[p];
        const c = s >= 0 ? cellOf[s] : -1;
        if (c < 0) { r = 30; gg = 24; b = 20; }
        else if (pot) {
          const t = pot[p] / pmax;
          [r, gg, b] = ramp(DEEP, t);
          const lv = Math.floor(t * LV);
          const x = p % W;
          const edge = (x < W - 1 && mask[p + 1] === FREE && Math.floor(pot[p + 1] / pmax * LV) !== lv) || (p + W < lab.length && mask[p + W] === FREE && Math.floor(pot[p + W] / pmax * LV) !== lv);
          if (edge) { const k = lv % 4 === 3 ? 0.75 : 0.4; r += (250 - r) * k; gg += (240 - gg) * k; b += (215 - b) * k; }
          if (border[p]) { r *= 0.85; gg *= 0.85; b *= 0.85; }
          if (game.gem[c] > 0) { r += (GEM[0] - r) * 0.25; gg += (GEM[1] - gg) * 0.25; b += (GEM[2] - b) * 0.25; }
        } else {
          r = cr[c]; gg = cg[c]; b = cb[c];
          const tint = tints[zone[p]];
          if (tint) { r += tint[0] * tk; gg += tint[1] * tk; b += tint[2] * tk; }
          const d = depth[p];
          if (depthMode) {
            [r, gg, b] = ramp(HEAT, Math.min(1, d / 10));
          } else if (d > 0.05) {
            const layer = STRATA[Math.min(3, Math.floor(d / 3))];
            const k = Math.min(0.5, d * 0.1);
            r += (layer[0] - r) * k; gg += (layer[1] - gg) * k; b += (layer[2] - b) * k;
          }
          if (river[p]) { r = r * 0.85 + 4; gg = gg * 0.9 + 10; b = b * 0.85 + 30; }
          if (ore[p]) { const k = 0.3 + 0.15 * (nz > 1.04 ? sparkle : 0); r += (190 - r) * k; gg += (140 - gg) * k; b += (255 - b) * k; }
          if (border[p]) { r *= 0.62; gg *= 0.62; b *= 0.62; }
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

    // the graph
    if (ov === 'graph') {
      ctx.strokeStyle = 'rgba(169,226,220,0.55)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let c = 0; c < n; c++) {
        for (let e = g.nbrStart[c]; e < g.nbrStart[c + 1]; e++) {
          const b = g.nbr[e];
          if (b < c) continue;
          ctx.moveTo(g.cx[c] * sc, g.cy[c] * sc);
          ctx.lineTo(g.cx[b] * sc, g.cy[b] * sc);
        }
      }
      ctx.stroke();
      ctx.font = `600 ${Math.max(9, Math.min(13, sc * 5))}px Inter, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      for (let c = 0; c < n; c++) {
        const ex = g.exE[c] + g.exC[c];
        ctx.fillStyle = ex ? '#f08a63' : '#ece2d3';
        ctx.fillText(String(g.thr[c]), g.cx[c] * sc, g.cy[c] * sc);
      }
    }

    // the comb: short strokes along the stretch
    if (o.showComb || ov === 'zones') {
      const cf = game.comb, cs = W / COMB * sc;
      ctx.strokeStyle = 'rgba(169,226,220,0.7)';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      for (let gy = 0; gy < COMB; gy++) for (let gx = 0; gx < COMB; gx++) {
        const k = (gy * COMB + gx) * 2;
        const str = Math.hypot(cf[k], cf[k + 1]);
        if (str < 0.12) continue;
        const mp = Math.floor((gy + 0.5) * W / COMB) * W + Math.floor((gx + 0.5) * W / COMB);
        if (mask[mp] === OUT) continue;
        const th = 0.5 * Math.atan2(cf[k + 1], cf[k]);
        const L = cs * 0.45 * Math.min(1, str / 1.2);
        const x = (gx + 0.5) * cs, y = (gy + 0.5) * cs;
        ctx.moveTo(x - Math.cos(th) * L, y - Math.sin(th) * L);
        ctx.lineTo(x + Math.cos(th) * L, y + Math.sin(th) * L);
      }
      ctx.stroke();
    }

    // buried things: hints once they are close to the surface
    const reveal = game.relicFx('reveal') > 1;
    game.region.buried.forEach((bd, i) => {
      if (game.s.found.includes(i)) return;
      const pr = game.buriedProgress(i);
      if (pr < 0.5 && !reveal && !o.showBuried) return;
      const a = pr < 0.5 ? 0.35 : 0.4 + 0.6 * (0.5 + 0.5 * Math.sin(this.time * 4 + i));
      ctx.globalAlpha = a;
      ctx.fillStyle = KIND_COL[bd.kind];
      ctx.font = `${Math.round(10 + 6 * pr)}px Inter, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(bd.kind === 'relic' ? '✦' : bd.kind === 'spring' ? '≈' : bd.kind === 'ore' ? '◆' : '◌', bd.x * sc, bd.y * sc);
      ctx.globalAlpha = 1;
    });

    // weights
    const sel = o.selected;
    game.s.weights.forEach((w, k) => {
      const on = sel && sel.type === 'weight' && sel.k === k;
      drawWeight(ctx, w.x * sc, w.y * sc, w.r * sc, w.pull, on, this.time);
    });
    // springs and taps
    for (const [x, y] of game.springs) drawTap(ctx, x * sc, y * sc, '#7cc8ff', this.time, 1);
    const many = game.s.taps.length > 1;
    game.s.taps.forEach((t, k) => {
      const on = sel && sel.type === 'tap' && sel.k === k;
      const f = game.tapShare(k);
      drawTap(ctx, t.x * sc, t.y * sc, TAP_COL, this.time, many ? 0.6 + 0.8 * Math.sqrt(f) : 1, on);
      if (many || on) label(ctx, `${Math.round(f * 100)}%`, t.x * sc, t.y * sc + 17, TAP_COL);
    });
    // zone names
    if (ov === 'zones') {
      ctx.font = `600 13px Inter, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      for (const z of zones) {
        const name = RECIPES[z.recipe].name;
        ctx.fillStyle = 'rgba(16,12,9,0.75)';
        const w = ctx.measureText(name).width + 12;
        ctx.fillRect(z.x * sc - w / 2, z.y * sc - 10, w, 20);
        ctx.fillStyle = '#ece2d3';
        ctx.fillText(name, z.x * sc, z.y * sc);
      }
    }
    // the tool under the pointer
    if (o.ghost) {
      const [x, y] = o.ghost.pos;
      ctx.globalAlpha = 0.6;
      if (o.ghost.type === 'tap') drawTap(ctx, x * sc, y * sc, o.ghost.ok ? TAP_COL : '#f08a63', this.time, 1);
      else if (o.ghost.type === 'weight') drawWeight(ctx, x * sc, y * sc, 26 * sc, o.ghost.pull || 0, false, this.time, !o.ghost.ok);
      else if (o.ghost.type === 'comb') {
        ctx.strokeStyle = o.ghost.smooth ? '#f08a63' : COMB_COL;
        ctx.setLineDash([3, 3]);
        ctx.beginPath(); ctx.arc(x * sc, y * sc, 12 * sc, 0, Math.PI * 2); ctx.stroke();
        ctx.setLineDash([]);
      }
      ctx.globalAlpha = 1;
    }
  }
}

function label(ctx, text, x, y, col) {
  ctx.font = '600 11px Inter, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const w = ctx.measureText(text).width + 8;
  ctx.fillStyle = 'rgba(16,12,9,0.78)';
  ctx.fillRect(x - w / 2, y - 7, w, 14);
  ctx.fillStyle = col;
  ctx.fillText(text, x, y);
}

function drawWeight(ctx, x, y, r, pull, on, t, bad = false) {
  ctx.save();
  ctx.strokeStyle = bad ? '#f08a63' : WEIGHT_COL;
  ctx.globalAlpha *= on ? 0.95 : 0.6;
  ctx.lineWidth = on ? 1.6 : 1.1;
  ctx.setLineDash([4, 4]);
  ctx.lineDashOffset = -t * 6;
  ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.stroke();
  ctx.setLineDash([]);
  ctx.globalAlpha = on ? 1 : 0.9;
  const s = 4 + 2.2 * Math.sqrt(pull);
  ctx.fillStyle = 'rgba(20,15,10,0.6)';
  ctx.beginPath(); ctx.arc(x, y, s + 3, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = bad ? '#f08a63' : WEIGHT_COL;
  ctx.beginPath(); ctx.arc(x, y, s, 0, Math.PI * 2); ctx.fill();
  if (on) { ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(x, y, s + 5, 0, Math.PI * 2); ctx.stroke(); }
  ctx.restore();
  if (pull) label(ctx, `pull ${pull % 1 ? pull.toFixed(1) : pull}`, x, y + s + 12, WEIGHT_COL);
}

function drawTap(ctx, x, y, col, t, size = 1, on = false) {
  const s = 7 * size;
  ctx.save();
  ctx.translate(x, y);
  ctx.fillStyle = 'rgba(20,15,10,0.55)';
  ctx.beginPath();
  ctx.arc(0, 0, s + 3, 0, Math.PI * 2);
  ctx.fill();
  if (on) { ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(0, 0, s + 6, 0, Math.PI * 2); ctx.stroke(); }
  ctx.strokeStyle = col;
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  ctx.moveTo(-s * 0.7, -s); ctx.lineTo(s * 0.7, -s); ctx.lineTo(0, 0); ctx.closePath();
  ctx.moveTo(-s * 0.7, s); ctx.lineTo(s * 0.7, s); ctx.lineTo(0, 0); ctx.closePath();
  ctx.stroke();
  ctx.fillStyle = col;
  const ph = (t * 1.5) % 1;
  ctx.beginPath();
  ctx.arc(0, -s * 0.2 + ph * s, 1.2, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}
