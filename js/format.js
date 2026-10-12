// Number and time formatting helpers.

const SUFFIXES = ['', 'K', 'M', 'B', 'T', 'Qa', 'Qi', 'Sx', 'Sp', 'Oc', 'No', 'Dc'];

export function fmt(x, digits = 3) {
  if (x === undefined || x === null || Number.isNaN(x)) return '0';
  if (!Number.isFinite(x)) return '∞';
  const neg = x < 0;
  if (neg) x = -x;
  let s;
  if (x < 1000) {
    if (x < 10 && x !== Math.floor(x)) s = (Math.floor(x * 100) / 100).toFixed(x < 1 ? 2 : 1).replace(/\.0+$/, '');
    else if (x < 100 && x !== Math.floor(x)) s = (Math.floor(x * 10) / 10).toFixed(1).replace(/\.0$/, '');
    else s = String(Math.floor(x));
  } else {
    const e = Math.floor(Math.log10(x) + 1e-9);
    const tier = Math.floor(e / 3);
    if (tier < SUFFIXES.length) {
      const scaled = x / Math.pow(10, tier * 3);
      const intDigits = Math.floor(Math.log10(scaled) + 1e-9) + 1;
      const dec = Math.max(0, digits - intDigits);
      const p = Math.pow(10, dec);
      s = (Math.floor(scaled * p) / p).toFixed(dec) + SUFFIXES[tier];
    } else {
      const m = x / Math.pow(10, e);
      s = (Math.floor(m * 100) / 100).toFixed(2) + 'e' + e;
    }
  }
  return (neg ? '-' : '') + s;
}

export function fmtInt(x) {
  if (x < 1e6) return Math.floor(x).toLocaleString('en-US');
  return fmt(x);
}

export function fmtMult(x) {
  if (x < 100) return '×' + (Math.round(x * 100) / 100).toString();
  return '×' + fmt(x);
}

export function fmtTime(sec) {
  sec = Math.max(0, Math.floor(sec));
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

export function fmtRate(x) {
  return fmt(x) + '/s';
}
