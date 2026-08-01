// Merging two sources that do not quote the same maturities.
//
// The bug this pins: real Makam bills mature on real dates, so the longest one
// sits at ~0.93y and NOTHING lands on 1y. "Later sources win a shared maturity"
// never fired, shcd08's mid-month 1y point survived beside a live bill yield
// observed a fortnight later, and the curve dipped 7bp over 25 days of maturity.
// The forward-rate identity then amplified that seam into ~14bp at the 12-month
// horizon — a number that read as a market view and was not one.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0; const errs = [];
const eq = (n, a, b) => { if (JSON.stringify(a) === JSON.stringify(b)) { pass++; console.log('  ok   ' + n); }
  else errs.push(`${n}\n        got  ${JSON.stringify(a)}\n        want ${JSON.stringify(b)}`); };

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'merge-'));
const p = f => path.join(dir, f);

// The real shapes, reduced to what matters. Bill tenors are the actual ones from
// the TASE pull on 2026-07-31; the long end is shcd08's own 1y..5y.
fs.writeFileSync(p('makam-live.csv'),
  'DATE,TENOR,YIELD\n' + [
    [0.010959, 3.65], [0.087671, 3.31], [0.183562, 3.17], [0.260274, 3.25],
    [0.336986, 3.24], [0.432877, 3.25], [0.509589, 3.27], [0.586301, 3.23],
    [0.682192, 3.23], [0.758904, 3.29], [0.835616, 3.29], [0.931507, 3.28]
  ].map(([t, y]) => `2026-07-31,${t}y,${y}`).join('\n') + '\n');

fs.writeFileSync(p('shcd08.csv'),
  'DATE,TENOR,YIELD\n' + [[1, 3.21], [2, 3.29], [3, 3.34], [4, 3.37], [5, 3.43]]
    .map(([t, y]) => `2026-07-15,${t}y,${y}`).join('\n') + '\n');

const run = governs => {
  const cfg = { nominal: [
    { file: p('shcd08.csv'), label: 'shcd08_e.xls' },
    { file: p('makam-live.csv'), label: 'makam · live', ...(governs ? { governs } : {}) }
  ] };
  fs.writeFileSync(p('sources.json'), JSON.stringify(cfg));
  execFileSync(process.execPath, ['refresh-curve.mjs', '--config', p('sources.json'),
    '--out', p('curve.json')], { encoding: 'utf8', stdio: 'pipe' });
  return JSON.parse(fs.readFileSync(p('curve.json'), 'utf8'));
};

/* The page's own maths, so the assertions are about what a reader would see. */
function monoSlopes(xs, ys) {
  const n = xs.length; if (n < 2) return [0];
  const d = new Array(n - 1), m = new Array(n);
  for (let i = 0; i < n - 1; i++) d[i] = (ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i]);
  m[0] = d[0];
  for (let i = 1; i < n - 1; i++) m[i] = (d[i - 1] * d[i] <= 0) ? 0 : (d[i - 1] + d[i]) / 2;
  m[n - 1] = d[n - 2];
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) { m[i] = 0; m[i + 1] = 0; continue; }
    const a = m[i] / d[i], b = m[i + 1] / d[i], s = a * a + b * b;
    if (s > 9) { const t = 3 / Math.sqrt(s); m[i] = t * a * d[i]; m[i + 1] = t * b * d[i]; }
  }
  return m;
}
function buildCurve(points) {
  const xs = [], ys = [];
  for (const [t, r] of [...points].sort((a, b) => a[0] - b[0])) { xs.push(t); ys.push(r / 100); }
  const sl = monoSlopes(xs, ys);
  return { z(t) {
    if (t <= xs[0]) return ys[0];
    if (t >= xs[xs.length - 1]) return ys[ys.length - 1];
    let i = 0; while (i < xs.length - 2 && t > xs[i + 1]) i++;
    const x0 = xs[i], x1 = xs[i + 1], y0 = ys[i], y1 = ys[i + 1];
    const h = x1 - x0, s = (t - x0) / h, s2 = s * s, s3 = s2 * s;
    return (2 * s3 - 3 * s2 + 1) * y0 + (s3 - 2 * s2 + s) * h * sl[i] +
           (-2 * s3 + 3 * s2) * y1 + (s3 - s2) * h * sl[i + 1];
  } };
}
const fwd = (c, T, L) => T <= 1e-9 ? c.z(L)
  : Math.pow(Math.pow(1 + c.z(T + L), T + L) / Math.pow(1 + c.z(T), T), 1 / L) - 1;
const deltaBp = c => Math.round((fwd(c, 1, 1) - fwd(c, 0, 1)) * 1e4);

console.log('\n# without `governs`: the seam the forward rate amplifies');
const plain = run(null);
const cPlain = buildCurve(plain.nominal);
eq('shcd08 keeps its 1y point', plain.nominal.some(([t]) => t === 1), true);
eq('z(1y) reads the mid-month average', +(cPlain.z(1) * 100).toFixed(2), 3.21);
eq('the curve dips between 0.93y and 1y', cPlain.z(1) < cPlain.z(0.931507), true);
// This is the artefact, asserted so it cannot come back unnoticed.
eq('12m forward is inflated by the dip', deltaBp(cPlain) > 12, true);

console.log('\n# with `governs: [0, 1]`: the fresher instrument owns the front');
const g = run([0, 1]);
const cG = buildCurve(g.nominal);
eq('the superseded 1y point is gone', g.nominal.some(([t]) => t === 1), false);
eq('every bill survives', g.nominal.filter(([t]) => t < 1).length, 12);
eq('the long end keeps everything above the span', g.nominal.filter(([t]) => t > 1).map(([t]) => t),
   [2, 3, 4, 5]);
eq('z(1y) is interpolated back to the bill level', +(cG.z(1) * 100).toFixed(2), 3.28);
eq('no dip left', cG.z(1) >= cG.z(0.931507) - 1e-9, true);
eq('12m delta collapses to the real few bp', deltaBp(cG) <= 4, true);

console.log('\n# ownership follows the points, so the page attributes them right');
const own = Object.fromEntries(g.sources.map(s => [s.label, [s.owns, s.ownsPoints]]));
eq('shcd08 no longer claims 1y', own['shcd08_e.xls'], [[2, 5], 4]);
eq('makam claims the whole short end', own['makam · live'], [[0.010959, 0.931507], 12]);

console.log('\n# a source that governs nothing still merges as before');
eq('unchanged without the field', run([]).nominal.length, plain.nominal.length);

fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n${pass} passed, ${errs.length} failed`);
if (errs.length) { console.log('ISSUES:\n  ' + errs.join('\n  ')); process.exit(1); }
