// Write calibrated costs back into js/data.js.
// Usage: node tools/apply_calibration.mjs tools/scratch/calibrated.json tools/targets.json
import fs from 'node:fs';

const cal = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const targets = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
let src = fs.readFileSync('js/data.js', 'utf8');

function nice(c) {
  if (!(c > 0)) return c;
  const e = Math.floor(Math.log10(c));
  const m = c / Math.pow(10, e);
  const opts = [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 7, 8, 10];
  let best = 1;
  for (const x of opts) if (Math.abs(Math.log(x / m)) < Math.abs(Math.log(best / m))) best = x;
  return +(best * Math.pow(10, e)).toPrecision(3);
}
const lit = (x) => {
  if (x === 0) return '0';
  if (x < 1e5) return String(x);
  const e = Math.floor(Math.log10(x) + 1e-9);
  const m = +(x / Math.pow(10, e)).toPrecision(3);
  return `${m}e${e}`;
};

// kiln: monotone in target order
const korder = Object.keys(targets.kiln).sort((a, b) => targets.kiln[a] - targets.kiln[b]);
let prev = 0;
for (const id of korder) {
  if (cal.kiln[id] === undefined) continue;
  let c = nice(cal.kiln[id]);
  if (c < prev * 1.1) c = nice(prev * 1.15);
  prev = c;
  const re = new RegExp(`(\\{ id: '${id}', name: '(?:[^'\\\\]|\\\\.)*', cost: )[0-9.e+]+`);
  if (!re.test(src)) throw new Error('kiln ' + id);
  src = src.replace(re, `$1${lit(c)}`);
}
for (const id in cal.upgrades) {
  const re = new RegExp(`(\\{ id: '${id}', name: '(?:[^'\\\\]|\\\\.)*', cost: )[0-9.e+]+`);
  if (!re.test(src)) throw new Error('upgrade ' + id);
  src = src.replace(re, `$1${lit(nice(cal.upgrades[id]))}`);
}
for (const id in cal.trials) {
  const re = new RegExp(`(\\{ id: '${id}', name: '(?:[^'\\\\]|\\\\.)*', goal: )[0-9.e+]+`);
  if (!re.test(src)) throw new Error('trial ' + id);
  src = src.replace(re, `$1${lit(nice(cal.trials[id]))}`);
}
for (const id in cal.great) {
  const g = cal.great[id];
  const re = new RegExp(`(\\{ id: '${id}', name: '(?:[^'\\\\]|\\\\.)*', glass: )[0-9.e+]+(, sand: )[0-9.e+]+`);
  if (!re.test(src)) throw new Error('great ' + id);
  src = src.replace(re, `$1${lit(nice(g.glass))}$2${lit(nice(g.sand))}`);
}
fs.writeFileSync('js/data.js', src);
console.log('applied');
