// Entry point for the skirmish prototype.
import { War } from './war.js';
import { Bot } from './bot.js';
import { View } from './view.js';
import { UI } from './ui.js';

const LEVEL_KEY = 'topple.war.level';

const app = {
  war: null, bot: null, view: null, ui: null,
  speed: 1, paused: false,
  level: (() => { try { return localStorage.getItem(LEVEL_KEY) || 'normal'; } catch (e) { return 'normal'; } })(),
  start(seed) {
    this.war = new War({ seed: seed ?? Math.floor(Math.random() * 1e6) });
    this.bot = new Bot(this.war, 1, this.level);
  },
  restart(seed) {
    this.start(seed);
    this.view.setWar(this.war);
    this.paused = false;
    this.ui.select(null);
    this.ui.buildPanel();
    try { history.replaceState(null, '', `?map=${this.war.seed}`); } catch (e) { /* ignore */ }
  },
  setLevel(l) {
    this.level = l;
    try { localStorage.setItem(LEVEL_KEY, l); } catch (e) { /* ignore */ }
  },
  togglePause() { this.paused = !this.paused; },
};

const q = new URLSearchParams(location.search);
app.start(q.has('map') ? +q.get('map') : undefined);
app.view = new View(document.getElementById('board'), app.war);
app.ui = new UI(app);
app.ui.init();

let last = performance.now();
function step(now) {
  let dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  if (!app.paused && !app.war.over) {
    const d = dt * app.speed;
    app.war.tick(d);
    app.bot.tick(d);
  }
  app.ui.frame(dt);
  requestAnimationFrame(step);
}
requestAnimationFrame(step);
window.war = app;
