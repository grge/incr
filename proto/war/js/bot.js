// A simple opponent. Every second or so it:
//   - pours harder from spouts near its front line, less from safe ones;
//   - picks a target: the nearest spout it doesn't hold;
//   - keeps one well just behind its front, facing the target, at full pull;
//   - after holding a well for a while, lifts it (the packed cells spread and
//     their sand floods forward) and sets a new one further ahead.
import { NEUTRAL, RULES } from './war.js';

export const LEVELS = {
  easy: { flow: 0.8, every: 2.5, hold: [30, 45], wells: true },
  normal: { flow: 1, every: 1.2, hold: [20, 32], wells: true },
  hard: { flow: 1.25, every: 0.8, hold: [16, 26], wells: true },
};

export class Bot {
  constructor(war, p, level = 'normal') {
    this.war = war;
    this.p = p;
    this.cfg = LEVELS[level] || LEVELS.normal;
    this.acc = 0;
    this.hold = this.pickHold();
    this.target = -1;
    war.flowMult[p] = this.cfg.flow;
  }

  pickHold() { const [a, b] = this.cfg.hold; return a + this.war.rng() * (b - a); }

  tick(dt) {
    this.acc += dt;
    if (this.acc < this.cfg.every) return;
    this.acc = 0;
    if (!this.war.over) this.think();
  }

  // Graph distance (in cells) from every cell to the nearest one matching `from`.
  hops(from) {
    const g = this.war.g, n = g.n;
    const d = new Int32Array(n).fill(1 << 20);
    const q = [];
    for (let c = 0; c < n; c++) if (from(c)) { d[c] = 0; q.push(c); }
    for (let i = 0; i < q.length; i++) {
      const c = q[i];
      for (let e = g.nbrStart[c]; e < g.nbrStart[c + 1]; e++) {
        const b = g.nbr[e];
        if (d[b] > d[c] + 1) { d[b] = d[c] + 1; q.push(b); }
      }
    }
    return d;
  }

  think() {
    const w = this.war, g = w.g, p = this.p, own = w.own;
    const front = this.hops(c => own[c] !== p);       // how deep inside our land each cell is
    const reach = this.hops(c => own[c] === p);       // how far each cell is from our land
    const enemy = this.hops(c => own[c] === 1 - p);   // how far from the enemy

    // pour harder near the front, hardest where the enemy is close
    w.spouts.forEach((sp) => {
      if (sp.owner !== p) return;
      const c = w.cellAt(sp.x, sp.y);
      const d = front[c], de = enemy[c];
      sp.share = de <= 3 ? 5 : d <= 1 ? 4 : d <= 3 ? 2.5 : d <= 6 ? 1.2 : 0.5;
    });

    // target: the nearest spout we don't hold
    let best = -1, bd = Infinity;
    w.spouts.forEach((sp, k) => {
      if (sp.owner === p) return;
      const c = w.cellAt(sp.x, sp.y);
      const d = reach[c] + (sp.owner === NEUTRAL ? 0 : 2);
      if (d < bd) { bd = d; best = k; }
    });
    this.target = best;
    if (best < 0 || !this.cfg.wells) return;
    const tg = w.spouts[best];

    // the anchor: our land, a couple of cells behind the front, nearest the target
    let anchor = -1, ad = Infinity;
    for (let c = 0; c < g.n; c++) {
      if (own[c] !== p || front[c] < 2 || front[c] > 3) continue;
      const d = Math.hypot(g.cx[c] - tg.x, g.cy[c] - tg.y);
      if (d < ad) { ad = d; anchor = c; }
    }
    if (anchor < 0) for (let c = 0; c < g.n; c++) {
      if (own[c] !== p) continue;
      const d = Math.hypot(g.cx[c] - tg.x, g.cy[c] - tg.y);
      if (d < ad) { ad = d; anchor = c; }
    }
    if (anchor < 0) return;
    const ax = g.cx[anchor], ay = g.cy[anchor];
    const budget = Math.min(RULES.maxPull, w.pullBudget(p));
    const mine = w.wells.filter(x => x.owner === p);
    if (!mine.length) {
      if (budget >= 1) { w.addWell(p, ax, ay, budget); this.hold = this.pickHold(); }
      return;
    }
    const well = mine[0];
    const age = w.time - well.t0;
    if (age > this.hold && Math.hypot(well.x - ax, well.y - ay) > well.r * 0.8) {
      // lift it: the packed sand floods forward; set the next one next time
      w.liftWell(well);
      return;
    }
    if (well.pull < budget - 0.25) w.adjustWell(well, 1);
  }
}
