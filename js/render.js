// Canvas renderer for a sand table.
import { CRYSTAL, STONE, PRISM, T_GEODE, T_BEDROCK, T_SPRING, T_CRACK, T_DIG, T_SLOPE } from './sim.js';

const PAL = [
  [36, 29, 23],    // 0 grains
  [92, 69, 47],    // 1
  [154, 115, 68],  // 2
  [222, 174, 104], // 3
  [255, 236, 196], // 4+ (about to topple)
];
const PIPS = [
  [],
  [[0.5, 0.5]],
  [[0.3, 0.3], [0.7, 0.7]],
  [[0.27, 0.27], [0.5, 0.5], [0.73, 0.73]],
];

function heat(t) {
  // 0..1 -> dark teal -> sand -> white
  t = Math.max(0, Math.min(1, t));
  const stops = [[20, 40, 48], [44, 120, 128], [226, 178, 104], [255, 246, 222]];
  const x = t * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(x));
  const f = x - i;
  const a = stops[i], b = stops[i + 1];
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
}

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.dpr = 1;
    this.css = 400;
    this.pad = 6;
    this.particles = [];
    this.noise = null;
    this.noiseN = 0;
    this.time = 0;
    this.shakeT = 0;
    this.reduceMotion = false;
    this.showParticles = true;
  }

  resize(availW, availH) {
    const s = Math.max(240, Math.floor(Math.min(availW, availH)));
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.css = s;
    this.canvas.style.width = s + 'px';
    this.canvas.style.height = s + 'px';
    this.canvas.width = Math.round(s * this.dpr);
    this.canvas.height = Math.round(s * this.dpr);
  }

  geom(board) {
    const pad = this.pad;
    const cell = (this.css - pad * 2) / board.size;
    return { pad, cell, gap: Math.max(1, cell * 0.07) };
  }

  cellAt(board, clientX, clientY) {
    const r = this.canvas.getBoundingClientRect();
    const { pad, cell } = this.geom(board);
    const x = Math.floor((clientX - r.left - pad) / cell);
    const y = Math.floor((clientY - r.top - pad) / cell);
    if (x < 0 || y < 0 || x >= board.size || y >= board.size) return -1;
    return y * board.size + x;
  }

  cellCenter(board, i) {
    const r = this.canvas.getBoundingClientRect();
    const { pad, cell } = this.geom(board);
    const x = i % board.size, y = (i / board.size) | 0;
    return { x: r.left + pad + (x + 0.5) * cell, y: r.top + pad + (y + 0.5) * cell, cell };
  }

  ensureNoise(n) {
    if (this.noiseN === n) return;
    this.noise = new Float32Array(n);
    for (let i = 0; i < n; i++) this.noise[i] = (Math.random() - 0.5) * 0.12;
    this.noiseN = n;
  }

  shake() { if (!this.reduceMotion) this.shakeT = 0.45; }

  draw(board, dt, o = {}) {
    const ctx = this.ctx;
    this.time += dt;
    this.ensureNoise(board.n);
    const { pad, cell, gap } = this.geom(board);
    const s = board.size;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.css, this.css);
    if (this.shakeT > 0) {
      this.shakeT -= dt;
      const m = 5 * Math.max(0, this.shakeT / 0.45);
      ctx.translate((Math.random() - 0.5) * m * 2, (Math.random() - 0.5) * m * 2);
    }
    // table backing
    ctx.fillStyle = o.fold ? '#1b1712' : '#1a1511';
    roundRect(ctx, 0, 0, this.css, this.css, 12);
    ctx.fill();
    if (o.fold) {
      // hint the folded edges
      const grd = ctx.createLinearGradient(0, 0, this.css, 0);
      grd.addColorStop(0, 'rgba(169,226,220,0.18)');
      grd.addColorStop(0.03, 'rgba(169,226,220,0)');
      grd.addColorStop(0.97, 'rgba(169,226,220,0)');
      grd.addColorStop(1, 'rgba(169,226,220,0.18)');
      ctx.fillStyle = grd;
      ctx.fillRect(0, 0, this.css, this.css);
    }

    const decay = Math.exp(-dt * 7);
    const g = board.grains, kind = board.kind, flash = board.flash, noise = this.noise;
    const r = Math.max(1.5, Math.min(6, cell * 0.075));
    const showPips = cell >= 17;
    const heatMap = o.heat || null;
    let heatMax = 0;
    if (heatMap) for (let i = 0; i < board.n; i++) if (heatMap[i] > heatMax) heatMax = heatMap[i];

    for (let i = 0; i < board.n; i++) {
      const x = i % s, y = (i / s) | 0;
      const px = pad + x * cell + gap / 2, py = pad + y * cell + gap / 2, w = cell - gap;
      const tr = board.terr[i];
      if (tr === T_BEDROCK) {
        flash[i] = 0;
        drawBedrock(ctx, px, py, w, i);
        continue;
      }
      if (tr === T_CRACK) {
        flash[i] = 0;
        drawCrack(ctx, px, py, w, i, kind[i] === STONE);
        continue;
      }
      if (kind[i] === STONE) {
        flash[i] = 0;
        ctx.fillStyle = '#211c17';
        roundRect(ctx, px, py, w, w, Math.min(6, w * 0.2));
        ctx.fill();
        continue;
      }
      const gr = g[i];
      const lvl = gr >= 4 ? 4 : gr | 0;
      const c = PAL[lvl];
      const nz = 1 + noise[i];
      let cr = c[0] * nz, cg = c[1] * nz, cb = c[2] * nz;
      const f = flash[i];
      if (f > 0.01) {
        cr += (255 - cr) * f * 0.75; cg += (222 - cg) * f * 0.7; cb += (150 - cb) * f * 0.55;
        flash[i] = f * decay;
      } else flash[i] = 0;
      ctx.fillStyle = `rgb(${cr | 0},${cg | 0},${cb | 0})`;
      roundRect(ctx, px, py, w, w, Math.min(5, w * 0.18));
      ctx.fill();
      if (gr >= 4) {
        ctx.fillStyle = `rgba(255,250,235,${0.35 + 0.25 * Math.sin(this.time * 20 + i)})`;
        roundRect(ctx, px, py, w, w, Math.min(5, w * 0.18));
        ctx.fill();
      } else if (showPips && lvl > 0 && !heatMap) {
        ctx.fillStyle = lvl === 3 ? 'rgba(90,58,24,0.55)' : 'rgba(255,236,200,0.28)';
        for (const [ux, uy] of PIPS[lvl]) {
          ctx.beginPath();
          ctx.arc(px + ux * w, py + uy * w, r, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      if (heatMap && heatMax > 0) {
        const t = Math.sqrt(heatMap[i] / heatMax);
        const hc = heat(t);
        ctx.fillStyle = `rgba(${hc[0] | 0},${hc[1] | 0},${hc[2] | 0},0.78)`;
        roundRect(ctx, px, py, w, w, Math.min(5, w * 0.18));
        ctx.fill();
      }
      if (tr === T_GEODE && kind[i] !== CRYSTAL) drawGeode(ctx, px, py, w, board.rich[i], this.time, i);
      else if (tr === T_SPRING) drawSpring(ctx, px, py, w, this.time);
      else if (tr === T_SLOPE) drawSlope(ctx, px, py, w, board.sdir[i]);
      else if (tr === T_DIG) drawDig(ctx, px, py, w, o.digs ? o.digs.get(i) : null, this.time);
    }

    // buildings
    for (let i = 0; i < board.n; i++) {
      const k = kind[i];
      const hgN = board.hg[i];
      if (k === 0 && hgN === 0) continue;
      if (o.drag && o.drag.from === i && o.drag.active) continue;
      const x = i % s, y = (i / s) | 0;
      const cx = pad + (x + 0.5) * cell, cy = pad + (y + 0.5) * cell;
      if (k === STONE) drawStone(ctx, cx, cy, cell);
      else if (k === CRYSTAL) drawCrystal(ctx, cx, cy, cell, this.time, i);
      else if (k === PRISM) drawPrism(ctx, cx, cy, cell, this.time);
      if (hgN > 0) drawHourglass(ctx, cx, cy, cell, hgN, k !== 0, this.time);
      // a stack digging: keep the dig's progress visible around it
      if (hgN > 0 && o.digs && o.digs.has(i)) {
        const p = Math.min(1, o.digs.get(i));
        ctx.save();
        ctx.lineWidth = Math.max(2, cell * 0.06);
        ctx.strokeStyle = 'rgba(255,212,121,0.25)';
        ctx.beginPath();
        ctx.arc(cx, cy, cell * 0.44, 0, Math.PI * 2);
        ctx.stroke();
        ctx.strokeStyle = 'rgba(255,225,150,0.95)';
        ctx.beginPath();
        ctx.arc(cx, cy, cell * 0.44, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * p);
        ctx.stroke();
        ctx.restore();
      }
    }

    // funnel
    if (board.funnel >= 0) {
      const x = board.funnel % s, y = (board.funnel / s) | 0;
      const cx = pad + (x + 0.5) * cell, cy = pad + (y + 0.5) * cell;
      drawFunnel(ctx, cx, cy, cell, this.time, o.drag && o.drag.funnel && o.drag.active);
    }

    // gleam
    if (o.gleam !== undefined && o.gleam >= 0) {
      const x = o.gleam % s, y = (o.gleam / s) | 0;
      drawGleam(ctx, pad + (x + 0.5) * cell, pad + (y + 0.5) * cell, cell, this.time, o.gleamLife ?? 1);
    }

    // suggestion
    if (o.suggest !== undefined && o.suggest >= 0) {
      const x = o.suggest % s, y = (o.suggest / s) | 0;
      ctx.save();
      ctx.strokeStyle = `rgba(169,226,220,${0.6 + 0.4 * Math.sin(this.time * 6)})`;
      ctx.lineWidth = 2;
      ctx.setLineDash([4, 3]);
      roundRect(ctx, pad + x * cell + 1, pad + y * cell + 1, cell - 2, cell - 2, 5);
      ctx.stroke();
      ctx.restore();
    }

    // hover
    if (o.hover !== undefined && o.hover >= 0) {
      const x = o.hover % s, y = (o.hover / s) | 0;
      ctx.strokeStyle = o.hoverBad ? 'rgba(240,138,99,0.9)' : 'rgba(255,240,210,0.7)';
      ctx.lineWidth = 1.5;
      roundRect(ctx, pad + x * cell + 0.75, pad + y * cell + 0.75, cell - 1.5, cell - 1.5, 5);
      ctx.stroke();
    }

    // particles
    if (this.showParticles && !this.reduceMotion) this.updateParticles(board, dt, ctx, pad, cell, o.active);

    // drag ghost
    if (o.drag && o.drag.active && o.drag.px !== undefined) {
      const rr = this.canvas.getBoundingClientRect();
      const cx = o.drag.px - rr.left, cy = o.drag.py - rr.top;
      ctx.globalAlpha = 0.85;
      if (o.drag.funnel) drawFunnel(ctx, cx, cy, cell, this.time, false);
      else if (o.drag.hg > 0) drawHourglass(ctx, cx, cy, cell, o.drag.hg, false, this.time);
      else if (o.drag.kind === STONE) drawStone(ctx, cx, cy, cell);
      else if (o.drag.kind === CRYSTAL) drawCrystal(ctx, cx, cy, cell, this.time, 0);
      else if (o.drag.kind === PRISM) drawPrism(ctx, cx, cy, cell, this.time);
      ctx.globalAlpha = 1;
    }
  }

  updateParticles(board, dt, ctx, pad, cell, active) {
    const s = board.size;
    const P = this.particles;
    if (active) {
      const n = board.toppledCount;
      const spawn = Math.min(n, 5);
      for (let k = 0; k < spawn && P.length < 260; k++) {
        const i = board.toppled[(Math.random() * n) | 0];
        const x = i % s, y = (i / s) | 0;
        const ang = Math.random() * Math.PI * 2;
        const sp = (0.4 + Math.random() * 0.8) * cell * 1.6;
        P.push({ x: pad + (x + 0.5) * cell, y: pad + (y + 0.5) * cell, vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp - cell * 0.6, life: 0, max: 0.5 + Math.random() * 0.4, size: Math.max(1, cell * 0.06), c: '255,226,170' });
      }
      const sp = board.spills;
      for (let k = 0; k + 1 < sp.length && P.length < 300; k += 2) {
        if (Math.random() > 0.35) continue;
        const i = sp[k], d = sp[k + 1];
        const x = i % s, y = (i / s) | 0;
        const dx = [0, 1, 0, -1][d], dy = [-1, 0, 1, 0][d];
        P.push({ x: pad + (x + 0.5 + dx * 0.5) * cell, y: pad + (y + 0.5 + dy * 0.5) * cell, vx: dx * cell * 1.2 + (Math.random() - 0.5) * cell * 0.3, vy: dy * cell * 1.2 + cell * 0.8, life: 0, max: 0.6, size: Math.max(1, cell * 0.07), c: '222,174,104' });
      }
    }
    for (let k = P.length - 1; k >= 0; k--) {
      const p = P[k];
      p.life += dt;
      if (p.life >= p.max) { P[k] = P[P.length - 1]; P.pop(); continue; }
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vy += cell * 2.5 * dt;
      const a = 1 - p.life / p.max;
      ctx.fillStyle = `rgba(${p.c},${(a * 0.8).toFixed(3)})`;
      ctx.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size);
    }
  }
}

export function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function drawStone(ctx, cx, cy, cell) {
  const r = cell * 0.4;
  const grd = ctx.createRadialGradient(cx - r * 0.35, cy - r * 0.4, r * 0.1, cx, cy, r);
  grd.addColorStop(0, '#c9c2b8');
  grd.addColorStop(0.6, '#8b847b');
  grd.addColorStop(1, '#5d5750');
  ctx.fillStyle = grd;
  ctx.beginPath();
  ctx.ellipse(cx, cy, r, r * 0.9, 0.3, 0, Math.PI * 2);
  ctx.fill();
}

function drawCrystal(ctx, cx, cy, cell, t, seed) {
  const r = cell * 0.36;
  ctx.save();
  ctx.translate(cx, cy);
  ctx.beginPath();
  ctx.moveTo(0, -r); ctx.lineTo(r * 0.72, 0); ctx.lineTo(0, r); ctx.lineTo(-r * 0.72, 0); ctx.closePath();
  const shine = 0.5 + 0.5 * Math.sin(t * 1.7 + seed * 0.7);
  const grd = ctx.createLinearGradient(-r, -r, r, r);
  grd.addColorStop(0, `rgba(210,250,255,${0.75 + 0.2 * shine})`);
  grd.addColorStop(0.5, 'rgba(110,205,225,0.75)');
  grd.addColorStop(1, 'rgba(50,120,150,0.85)');
  ctx.fillStyle = grd;
  ctx.fill();
  ctx.strokeStyle = 'rgba(225,252,255,0.9)';
  ctx.lineWidth = Math.max(1, cell * 0.04);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(-r * 0.72, 0); ctx.lineTo(r * 0.72, 0);
  ctx.moveTo(0, -r); ctx.lineTo(0, r);
  ctx.strokeStyle = 'rgba(225,252,255,0.35)';
  ctx.stroke();
  ctx.restore();
}

function drawPrism(ctx, cx, cy, cell, t) {
  const r = cell * 0.36;
  ctx.save();
  ctx.translate(cx, cy);
  ctx.beginPath();
  ctx.moveTo(0, -r); ctx.lineTo(r * 0.9, r * 0.7); ctx.lineTo(-r * 0.9, r * 0.7); ctx.closePath();
  const grd = ctx.createLinearGradient(-r, 0, r, 0);
  const h = (t * 40) % 360;
  grd.addColorStop(0, `hsla(${h},80%,75%,0.8)`);
  grd.addColorStop(0.5, `hsla(${(h + 120) % 360},80%,75%,0.8)`);
  grd.addColorStop(1, `hsla(${(h + 240) % 360},80%,75%,0.8)`);
  ctx.fillStyle = 'rgba(60,40,90,0.75)';
  ctx.fill();
  ctx.strokeStyle = grd;
  ctx.lineWidth = Math.max(1.2, cell * 0.07);
  ctx.stroke();
  ctx.restore();
}

function drawHourglass(ctx, cx, cy, cell, n, small, t) {
  const sc = small ? 0.62 : 1;
  const w = cell * 0.26 * sc, h = cell * 0.34 * sc;
  const ox = small ? cell * 0.2 : 0, oy = small ? -cell * 0.18 : 0;
  ctx.save();
  ctx.translate(cx + ox, cy + oy);
  ctx.fillStyle = 'rgba(20,16,12,0.55)';
  ctx.beginPath();
  ctx.arc(0, 0, Math.max(w, h) * 1.25, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(-w, -h); ctx.lineTo(w, -h); ctx.lineTo(0, 0); ctx.lineTo(w, h); ctx.lineTo(-w, h); ctx.lineTo(0, 0); ctx.closePath();
  ctx.fillStyle = 'rgba(243,227,195,0.25)';
  ctx.fill();
  ctx.strokeStyle = '#f3e3c3';
  ctx.lineWidth = Math.max(1, cell * 0.045);
  ctx.lineJoin = 'round';
  ctx.stroke();
  // sand in bulbs
  ctx.fillStyle = '#e3b26c';
  ctx.beginPath();
  ctx.moveTo(-w * 0.55, -h * 0.45); ctx.lineTo(w * 0.55, -h * 0.45); ctx.lineTo(0, -h * 0.02); ctx.closePath();
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(-w * 0.8, h * 0.95); ctx.lineTo(w * 0.8, h * 0.95); ctx.lineTo(0, h * 0.45); ctx.closePath();
  ctx.fill();
  // trickle
  const ph = (t * 3) % 1;
  ctx.fillRect(-0.6, h * 0.05 + ph * h * 0.3, 1.2, h * 0.15);
  ctx.restore();
  if (n > 1 && cell >= 14) {
    const label = n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1) + 'k' : String(n);
    ctx.font = `600 ${Math.max(9, Math.min(13, cell * 0.3))}px Inter, sans-serif`;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'bottom';
    const tx = cx + cell * 0.47, ty = cy + cell * 0.48;
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(20,16,12,0.85)';
    ctx.strokeText(label, tx, ty);
    ctx.fillStyle = '#fff1d6';
    ctx.fillText(label, tx, ty);
  }
}

function drawFunnel(ctx, cx, cy, cell, t, ghost) {
  const r = cell * 0.36;
  ctx.save();
  ctx.translate(cx, cy);
  ctx.strokeStyle = ghost ? 'rgba(169,226,220,0.4)' : 'rgba(169,226,220,0.9)';
  ctx.lineWidth = Math.max(1.2, cell * 0.06);
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, Math.PI * 2);
  ctx.stroke();
  const ph = (t * 1.5) % 1;
  ctx.beginPath();
  ctx.arc(0, 0, r * (1 - ph), 0, Math.PI * 2);
  ctx.strokeStyle = `rgba(169,226,220,${0.5 * ph})`;
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(-r * 0.4, -r * 0.2); ctx.lineTo(0, r * 0.3); ctx.lineTo(r * 0.4, -r * 0.2);
  ctx.strokeStyle = 'rgba(169,226,220,0.9)';
  ctx.stroke();
  ctx.restore();
}

function drawGleam(ctx, cx, cy, cell, t, life) {
  const r = cell * (0.42 + 0.06 * Math.sin(t * 6));
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(t * 0.8);
  ctx.globalAlpha = Math.min(1, life * 3);
  const grd = ctx.createRadialGradient(0, 0, 0, 0, 0, r * 1.6);
  grd.addColorStop(0, 'rgba(255,240,180,0.95)');
  grd.addColorStop(0.35, 'rgba(255,212,121,0.55)');
  grd.addColorStop(1, 'rgba(255,212,121,0)');
  ctx.fillStyle = grd;
  ctx.beginPath();
  ctx.arc(0, 0, r * 1.6, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#fff6d8';
  ctx.beginPath();
  for (let k = 0; k < 8; k++) {
    const a = (k / 8) * Math.PI * 2;
    const rr = k % 2 === 0 ? r : r * 0.35;
    ctx.lineTo(Math.cos(a) * rr, Math.sin(a) * rr);
  }
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function drawBedrock(ctx, px, py, w, seed) {
  ctx.fillStyle = '#2b2622';
  roundRect(ctx, px, py, w, w, Math.min(4, w * 0.12));
  ctx.fill();
  // a few facets
  const r = (k) => ((Math.sin(seed * 12.9898 + k * 78.233) * 43758.5453) % 1 + 1) % 1;
  ctx.fillStyle = '#3a332d';
  ctx.beginPath();
  ctx.moveTo(px + w * 0.1, py + w * (0.3 + r(1) * 0.3));
  ctx.lineTo(px + w * (0.4 + r(2) * 0.2), py + w * 0.12);
  ctx.lineTo(px + w * 0.9, py + w * (0.25 + r(3) * 0.3));
  ctx.lineTo(px + w * (0.6 + r(4) * 0.2), py + w * 0.88);
  ctx.lineTo(px + w * 0.2, py + w * 0.85);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = 'rgba(0,0,0,0.35)';
  ctx.lineWidth = Math.max(1, w * 0.04);
  ctx.beginPath();
  ctx.moveTo(px + w * (0.3 + r(5) * 0.3), py + w * 0.2);
  ctx.lineTo(px + w * (0.45 + r(6) * 0.2), py + w * 0.6);
  ctx.stroke();
}

function drawCrack(ctx, px, py, w, seed, plugged) {
  ctx.fillStyle = '#0c0a09';
  roundRect(ctx, px, py, w, w, Math.min(4, w * 0.12));
  ctx.fill();
  const r = (k) => ((Math.sin(seed * 7.13 + k * 3.7) * 9631.17) % 1 + 1) % 1;
  ctx.strokeStyle = plugged ? 'rgba(120,110,100,0.5)' : 'rgba(90,70,50,0.9)';
  ctx.lineWidth = Math.max(1, w * 0.05);
  ctx.beginPath();
  ctx.moveTo(px + w * 0.15, py + w * (0.2 + r(1) * 0.2));
  ctx.lineTo(px + w * (0.4 + r(2) * 0.1), py + w * (0.45 + r(3) * 0.1));
  ctx.lineTo(px + w * (0.55 + r(4) * 0.1), py + w * (0.4 + r(5) * 0.2));
  ctx.lineTo(px + w * 0.85, py + w * (0.7 + r(6) * 0.15));
  ctx.stroke();
}

function drawGeode(ctx, px, py, w, rich, t, seed) {
  const a = Math.min(0.8, 0.3 + rich * 0.14);
  ctx.save();
  ctx.fillStyle = 'rgba(150,110,230,0.12)';
  roundRect(ctx, px, py, w, w, Math.min(5, w * 0.18));
  ctx.fill();
  ctx.strokeStyle = `rgba(190,150,255,${a * 0.75})`;
  ctx.lineWidth = Math.max(1, w * 0.035);
  roundRect(ctx, px + w * 0.05, py + w * 0.05, w * 0.9, w * 0.9, Math.min(5, w * 0.16));
  ctx.stroke();
  // a little druse of amethyst shards in one corner: more and longer on richer geodes
  const n = Math.max(2, Math.min(6, 1 + Math.round(rich * 1.3)));
  const bx = px + w * 0.84, by = py + w * 0.86;
  for (let k = 0; k < n; k++) {
    const ang = -Math.PI + 0.2 + k * ((Math.PI / 2 - 0.4) / (n - 1));
    const len = w * (0.2 + 0.035 * rich + 0.05 * (((seed * 7 + k * 5) % 3) / 2));
    const wid = w * 0.055;
    const tw = 0.5 + 0.5 * Math.sin(t * 2.1 + seed * 1.3 + k * 1.9);
    ctx.fillStyle = `rgba(${(195 + 40 * tw) | 0},${(160 + 50 * tw) | 0},255,${0.6 + 0.3 * tw})`;
    const dx = Math.cos(ang), dy = Math.sin(ang), nx = -dy, ny = dx;
    ctx.beginPath();
    ctx.moveTo(bx, by);
    ctx.lineTo(bx + dx * len * 0.62 + nx * wid, by + dy * len * 0.62 + ny * wid);
    ctx.lineTo(bx + dx * len, by + dy * len);
    ctx.lineTo(bx + dx * len * 0.62 - nx * wid, by + dy * len * 0.62 - ny * wid);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
}

function drawSpring(ctx, px, py, w, t) {
  const cx = px + w / 2, cy = py + w / 2;
  ctx.save();
  for (let k = 0; k < 2; k++) {
    const ph = (t * 0.8 + k * 0.5) % 1;
    ctx.strokeStyle = `rgba(120,200,255,${0.75 * (1 - ph)})`;
    ctx.lineWidth = Math.max(1, w * 0.05);
    ctx.beginPath();
    ctx.arc(cx, cy, w * (0.12 + 0.32 * ph), 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.fillStyle = 'rgba(150,215,255,0.9)';
  ctx.beginPath();
  ctx.arc(cx, cy, Math.max(1.5, w * 0.09), 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function drawSlope(ctx, px, py, w, dir) {
  const cx = px + w / 2, cy = py + w / 2;
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(dir * Math.PI / 2);
  ctx.strokeStyle = 'rgba(40,25,10,0.45)';
  ctx.lineWidth = Math.max(1.2, w * 0.08);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const off of [-0.12, 0.12]) {
    ctx.beginPath();
    ctx.moveTo(-w * 0.2, (off + 0.08) * w);
    ctx.lineTo(0, (off - 0.08) * w);
    ctx.lineTo(w * 0.2, (off + 0.08) * w);
    ctx.stroke();
  }
  ctx.restore();
}

function drawDig(ctx, px, py, w, prog, t) {
  const cx = px + w / 2, cy = py + w / 2;
  ctx.save();
  ctx.strokeStyle = `rgba(255,212,121,${0.55 + 0.25 * Math.sin(t * 3)})`;
  ctx.lineWidth = Math.max(1, w * 0.05);
  ctx.setLineDash([Math.max(2, w * 0.12), Math.max(2, w * 0.08)]);
  roundRect(ctx, px + w * 0.08, py + w * 0.08, w * 0.84, w * 0.84, Math.min(5, w * 0.16));
  ctx.stroke();
  ctx.setLineDash([]);
  if (prog !== null && prog !== undefined) {
    ctx.strokeStyle = 'rgba(255,225,150,0.95)';
    ctx.lineWidth = Math.max(1.5, w * 0.09);
    ctx.beginPath();
    ctx.arc(cx, cy, w * 0.3, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * Math.min(1, prog));
    ctx.stroke();
  }
  ctx.fillStyle = 'rgba(255,230,170,0.95)';
  ctx.font = `600 ${Math.max(8, w * 0.32)}px Inter, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('?', cx, cy + w * 0.02);
  ctx.restore();
}

// Small overview of a whole table map (for choosing the next table).
const MINI = { 0: '#5b4430', 1: '#a88be0', 2: '#2b2622', 3: '#6fc0ef', 4: '#0c0a09', 5: '#ffd479', 6: '#8a6a44' };
export function drawMinimap(canvas, map, opts = {}) {
  const MAPN = 25, C = 12;
  const css = opts.size || 150;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = css * dpr;
  canvas.height = css * dpr;
  canvas.style.width = css + 'px';
  canvas.style.height = css + 'px';
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = '#16120e';
  ctx.fillRect(0, 0, css, css);
  const reveal = opts.reveal ?? 12;
  const view = Math.min(C, opts.view ?? C);   // how many rings around the centre to draw
  const o = C - view, N = 2 * view + 1;
  const cell = css / N;
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const i = (y + o) * MAPN + (x + o);
    const ring = Math.max(Math.abs(x + o - C), Math.abs(y + o - C));
    const hidden = ring > reveal;
    ctx.fillStyle = hidden ? '#221c16' : MINI[map.terr[i]];
    ctx.fillRect(x * cell + 0.5, y * cell + 0.5, cell - 1, cell - 1);
  }
  // the starting window
  const st = (opts.start || 5) >> 1;
  ctx.strokeStyle = 'rgba(255,240,210,0.5)';
  ctx.lineWidth = 1;
  ctx.strokeRect((view - st) * cell, (view - st) * cell, (st * 2 + 1) * cell, (st * 2 + 1) * cell);
}
