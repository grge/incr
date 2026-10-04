// Entry point: wires the game, renderer and UI together and runs the loop.
import { Game } from './game.js';
import { Renderer } from './render.js';
import { UI } from './ui.js';
import { fmt, fmtTime } from './format.js';

const SAVE_KEY = 'topple.save.v1';

function encode(str) { return btoa(unescape(encodeURIComponent(str))); }
function decode(b64) { return decodeURIComponent(escape(atob(b64))); }

function readSave() {
  try { return localStorage.getItem(SAVE_KEY); } catch (e) { return null; }
}

function writeSave(game) {
  try {
    localStorage.setItem(SAVE_KEY, game.serialize());
    return true;
  } catch (e) {
    return false;
  }
}

const game = new Game();
let offlineReport = null;
const raw = readSave();
if (raw) {
  try {
    const data = JSON.parse(raw);
    game.load(data);
    const away = (Date.now() - (data.lastSave || Date.now())) / 1000;
    if (away > 30) offlineReport = game.offline(Math.min(away, 7 * 86400));
  } catch (e) {
    console.error('Could not load save', e);
  }
}

const renderer = new Renderer(document.getElementById('board'));
const ui = new UI(game, renderer, {
  save: () => writeSave(game),
  exportSave: () => encode(game.serialize()),
  importSave: (text) => {
    try {
      const json = text.trim().startsWith('{') ? text.trim() : decode(text.trim());
      JSON.parse(json);
      localStorage.setItem(SAVE_KEY, json);
      location.reload();
    } catch (e) {
      ui.toast('Import failed', 'That does not look like a Topple save.', 'warn');
    }
  },
  reset: () => {
    resetting = true;
    try { localStorage.removeItem(SAVE_KEY); } catch (e) { /* ignore */ }
    location.reload();
  },
});
let resetting = false;
ui.init();

if (offlineReport && offlineReport.dust > 0) {
  const el = document.createElement('div');
  el.innerHTML = `<h2>While you were away</h2>
    <p>${fmtTime(offlineReport.sec)} passed. Your hourglasses kept pouring.</p>
    <p style="font-size:20px;color:var(--sand)">+${fmt(offlineReport.dust)} dust</p>
    ${offlineReport.sand > 0 ? `<p style="color:var(--gold)">+${fmt(offlineReport.sand)} sand</p>` : ''}`;
  ui.modal(el, [{ label: 'Welcome back', cls: 'primary' }]);
}

// ------------------------------------------------------------------ loop
let last = performance.now();
let saveAcc = 0;

function step(now) {
  let dt = (now - last) / 1000;
  last = now;
  if (dt < 0) dt = 0;
  if (dt > 0.5) {
    // long gap (tab was hidden / device slept): settle it analytically
    game.tick(dt, { analytic: true });
    dt = 0.016;
  } else {
    game.tick(dt);
  }
  ui.frame(dt);
  saveAcc += dt;
  if (saveAcc > 10) { saveAcc = 0; writeSave(game); }
  requestAnimationFrame(step);
}
requestAnimationFrame(step);

// keep earning in background tabs (rAF is paused there)
setInterval(() => {
  if (!document.hidden) return;
  const now = performance.now();
  const dt = (now - last) / 1000;
  if (dt > 0.9) {
    last = now;
    game.tick(dt, { analytic: true });
  }
}, 1000);

document.addEventListener('visibilitychange', () => {
  if (document.hidden) writeSave(game);
});
window.addEventListener('beforeunload', () => { if (!resetting) writeSave(game); });

// debugging hook
window.topple = { game, ui };
