// Entry point for the prototype.
import { Game } from './game.js';
import { View } from './view.js';
import { UI } from './ui.js';
import { fmt, fmtTime } from '../../js/format.js';

const KEY = 'topple.proto.v1';
let resetting = false;

function save(game) {
  if (resetting) return;
  try { localStorage.setItem(KEY, game.serialize()); } catch (e) { /* storage full or blocked */ }
}

let game, away = null;
try {
  const raw = localStorage.getItem(KEY);
  if (raw) {
    const st = JSON.parse(raw);
    game = new Game(st);
    away = game.offline((Date.now() - (st.lastSave || Date.now())) / 1000);
  }
} catch (e) { console.error('Could not load the prototype save', e); }
if (!game) game = new Game();

const view = new View(document.getElementById('board'), game);
const ui = new UI(game, view, {
  reset: () => {
    resetting = true;
    try { localStorage.removeItem(KEY); } catch (e) { /* ignore */ }
    location.reload();
  },
});
ui.init();
if (away && away.dust > 0) ui.toast('While you were away', `${fmtTime(away.sec)}: +${fmt(away.dust)} dust${away.finds ? `, and ${away.finds} thing${away.finds > 1 ? 's' : ''} uncovered` : ''}.`, 'good');

let last = performance.now(), saveAcc = 0;
function step(now) {
  let dt = (now - last) / 1000;
  last = now;
  if (dt > 1) { game.offline(dt); dt = 0.016; }   // tab was hidden: settle it on the average
  game.tick(Math.max(0, dt));
  ui.frame(Math.max(0, dt));
  saveAcc += dt;
  if (saveAcc > 10) { saveAcc = 0; save(game); }
  requestAnimationFrame(step);
}
requestAnimationFrame(step);
document.addEventListener('visibilitychange', () => { if (document.hidden) save(game); });
window.addEventListener('beforeunload', () => save(game));
window.proto = { game, ui, view };
