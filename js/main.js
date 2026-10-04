// Entry point: wires the game, renderer and UI together and runs the loop.
import { Game, SAVE_VERSION } from './game.js';
import { Renderer } from './render.js';
import { UI } from './ui.js';
import { fmt, fmtTime } from './format.js';

const SAVE_KEY = 'topple.save.v2';
const OLD_KEY = 'topple.save.v1';

function encode(str) { return btoa(unescape(encodeURIComponent(str))); }
function decode(b64) { return decodeURIComponent(escape(atob(b64))); }

function readSave(key = SAVE_KEY) {
  try { return localStorage.getItem(key); } catch (e) { return null; }
}

function writeSave(game) {
  try {
    localStorage.setItem(SAVE_KEY, game.serialize());
    return true;
  } catch (e) {
    return false;
  }
}

let game = new Game();
let offlineReport = null;
let oldSave = false;
const raw = readSave();
if (raw) {
  try {
    const data = JSON.parse(raw);
    if (game.load(data)) {
      const away = (Date.now() - (data.lastSave || Date.now())) / 1000;
      if (away > 30) offlineReport = game.offline(Math.min(away, 7 * 86400));
    } else game = new Game();
  } catch (e) {
    console.error('Could not load save', e);
    game = new Game();
  }
} else if (readSave(OLD_KEY)) {
  // a save from the first version of the game: the tables have changed too much to carry it over
  oldSave = !readSave('topple.v2.noticed');
}

const renderer = new Renderer(document.getElementById('board'));
const ui = new UI(game, renderer, {
  save: () => writeSave(game),
  exportSave: () => encode(game.serialize()),
  importSave: (text) => {
    try {
      const json = text.trim().startsWith('{') ? text.trim() : decode(text.trim());
      const o = JSON.parse(json);
      if (!o || o.v !== SAVE_VERSION) {
        ui.toast('Import failed', 'That save is from an older version of Topple, which works too differently to carry over.', 'warn');
        return;
      }
      resetting = true;
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
    ${offlineReport.sand > 0 ? `<p style="color:var(--gold)">+${fmt(offlineReport.sand)} sand</p>` : ''}
    ${offlineReport.relics > 0 ? `<p style="color:var(--gold)">and ${offlineReport.relics === 1 ? 'a relic' : offlineReport.relics + ' relics'}, dug up while you slept</p>` : ''}`;
  ui.modal(el, [{ label: 'Welcome back', cls: 'primary' }]);
} else if (oldSave) {
  const el = document.createElement('div');
  el.innerHTML = `<h2>The tables have changed</h2>
    <p>Topple has been rebuilt: every table now has its own ground — geodes, bedrock, springs, slopes, cracks — and things are buried under the sand.</p>
    <p>Your old save works too differently to carry over, so this is a fresh start. Thank you for playing the first version.</p>`;
  ui.modal(el, [{ label: 'Begin', cls: 'primary', fn: () => { try { localStorage.setItem('topple.v2.noticed', '1'); } catch (e) { /* ignore */ } } }]);
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
  if (document.hidden && !resetting) writeSave(game);
});
window.addEventListener('beforeunload', () => { if (!resetting) writeSave(game); });

// debugging hook
window.topple = { game, ui };
