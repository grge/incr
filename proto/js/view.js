// Draws the region: every pixel takes its cell's sand colour, with rock,
// cracks, ore and worn-away ground drawn into the same raster. Stakes,
// spouts and hints are drawn on top.
import { FREE, ROCK, CRACK, OUT } from './voronoi.js';
import { mulberry32 } from './region.js';

const PAL = [[86, 62, 42], [140, 102, 62], [196, 152, 94], [234, 196, 130]];
const STRATA = [[181, 116, 63], [138, 75, 51], [92, 70, 96], [52, 60, 84]];
const KIND_COL = { relic: '#ffd479', spring: '#7cc8ff', ore: '#c9a2ff', cave: '#e0e0e0' };

function heat(t) {
  // dark brown → orange → pale yellow
  const a = [[40, 26, 20], [200, 90, 40], [250, 200, 90], [255, 250, 220]];
  t = Math.max(0, Math.min(1, t)) * 3;
  const i = Math.min(2, Math.floor(t)), f = t - i;
  return [a[i][0] + (a[i + 1][0] - a[i][0]) * f, a[i][1] + (a[i + 1][1] - a[i][1]) * f, a[i][2] + (a[i + 1][2] - a[i][2]) * f];
}

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
    // per-cell colours
    const n = g.n;
    const cr = new Float32Array(n), cg = new Float32Array(n), cb = new Float32Array(n);
    let hm = 0, hv = null;
    if (o.overlay === 'flow') hv = game.u;
    else if (o.overlay === 'value') hv = game.v;
    if (hv) for (let c = 0; c < n; c++) if (hv[c] > hm) hm = hv[c];
    const decay = Math.exp(-dt * 6);
    for (let c = 0; c < n; c++) {
      let r, gg, b;
      if (hv) {
        [r, gg, b] = heat(hm > 0 ? Math.sqrt(hv[c] / hm) : 0);
      } else {
        const f = Math.min(1, pile.grains[c] / Math.max(1, g.thr[c] - 1));
        const t = f * 3, i = Math.min(2, Math.floor(t)), k = t - i;
        r = PAL[i][0] + (PAL[i + 1][0] - PAL[i][0]) * k;
        gg = PAL[i][1] + (PAL[i + 1][1] - PAL[i][1]) * k;
        b = PAL[i][2] + (PAL[i + 1][2] - PAL[i][2]) * k;
        if (pile.grains[c] >= g.thr[c]) { r = 255; gg = 244; b = 214; }
        const fl = pile.flash[c];
        if (fl > 0.02) { r += (255 - r) * fl * 0.7; gg += (226 - gg) * fl * 0.65; b += (160 - b) * fl * 0.5; pile.flash[c] = fl * decay; } else pile.flash[c] = 0;
      }
      if (c === o.hover) { r = r * 1.12 + 10; gg = gg * 1.12 + 10; b = b * 1.12 + 10; }
      cr[c] = r; cg[c] = gg; cb[c] = b;
    }
    const data = this.img.data;
    const lab = game.tess.lab, cellOf = g.cellOf, border = g.border, mask = game.mask, ore = game.ore, depth = game.depth, noise = this.noise;
    const pv = o.preview && o.preview.ok && o.preview.tess ? o.preview : null;
    const pl = pv ? pv.tess.lab : null, ps = pv ? pv.slot : -1;
    const depthMode = o.overlay === 'depth';
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
        else {
          r = cr[c]; gg = cg[c]; b = cb[c];
          const d = depth[p];
          if (depthMode) {
            const h = heat(Math.min(1, d / 10));
            r = h[0]; gg = h[1]; b = h[2];
          } else if (d > 0.05) {
            const layer = STRATA[Math.min(3, Math.floor(d / 3))];
            const k = Math.min(0.5, d * 0.1);
            r += (layer[0] - r) * k; gg += (layer[1] - gg) * k; b += (layer[2] - b) * k;
          }
          if (ore[p]) { const k = 0.3 + 0.15 * (nz > 1.04 ? sparkle : 0); r += (190 - r) * k; gg += (140 - gg) * k; b += (255 - b) * k; }
          if (border[p]) { r *= 0.62; gg *= 0.62; b *= 0.62; }
          r *= nz; gg *= nz; b *= nz;
        }
      }
      if (pl && pl[p] === ps) {
        const x = p % W, y = (p / W) | 0;
        const edge = (x > 0 && pl[p - 1] !== ps) || (x < W - 1 && pl[p + 1] !== ps) || (y > 0 && pl[p - W] !== ps) || (y < W - 1 && pl[p + W] !== ps);
        if (edge) { r = 169; gg = 226; b = 220; }
        else { r = r * 0.85 + 30; gg = gg * 0.85 + 40; b = b * 0.85 + 40; }
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
    if (o.overlay === 'graph') {
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

    // springs
    for (const [x, y] of game.springs) drawSpout(ctx, x * sc, y * sc, '#7cc8ff', this.time);
    // spouts
    game.s.spouts.forEach(([x, y], k) => {
      if (o.drag && o.drag.type === 'spout' && o.drag.k === k && o.drag.active) return;
      drawSpout(ctx, x * sc, y * sc, '#e3b26c', this.time);
    });
    // stakes
    game.tess.seeds.forEach((sd, slot) => {
      if (!sd) return;
      if (o.drag && o.drag.type === 'stake' && o.drag.slot === slot && o.drag.active) return;
      drawStake(ctx, sd.x * sc, sd.y * sc, slot === o.hoverStake);
    });
    // drag ghost
    if (o.drag && o.drag.active && o.drag.pos) {
      const [x, y] = o.drag.pos;
      ctx.globalAlpha = 0.8;
      if (o.drag.type === 'stake') drawStake(ctx, x * sc, y * sc, true);
      else drawSpout(ctx, x * sc, y * sc, '#e3b26c', this.time);
      ctx.globalAlpha = 1;
    }
    // placement ghost
    if (o.ghost) {
      const [x, y] = o.ghost.pos;
      ctx.globalAlpha = 0.6;
      if (o.ghost.type === 'stake') drawStake(ctx, x * sc, y * sc, true, !o.ghost.ok);
      else drawSpout(ctx, x * sc, y * sc, o.ghost.ok ? '#e3b26c' : '#f08a63', this.time);
      ctx.globalAlpha = 1;
    }
  }
}

function drawStake(ctx, x, y, hot, bad = false) {
  ctx.beginPath();
  ctx.arc(x, y, hot ? 4.5 : 3.2, 0, Math.PI * 2);
  ctx.fillStyle = bad ? '#f08a63' : '#2a1f16';
  ctx.fill();
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = bad ? '#f08a63' : hot ? '#fff3dc' : 'rgba(255,240,215,0.75)';
  ctx.stroke();
}

function drawSpout(ctx, x, y, col, t) {
  const s = 7;
  ctx.save();
  ctx.translate(x, y);
  ctx.fillStyle = 'rgba(20,15,10,0.55)';
  ctx.beginPath();
  ctx.arc(0, 0, s + 3, 0, Math.PI * 2);
  ctx.fill();
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
