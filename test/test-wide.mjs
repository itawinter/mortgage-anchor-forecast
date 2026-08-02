import X from 'xlsx';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { rowsToCurveWide, rowsToCurveAuto, normaliseScale, readSpreadsheet, parseTenor } from '../tools/refresh-curve.mjs';
let pass=0,fail=0;
const eq=(n,g,w)=>{const a=JSON.stringify(g),b=JSON.stringify(w);
  if(a===b){pass++;console.log('  ok   '+n);}else{fail++;console.log('  FAIL '+n+'\n        got  '+a+'\n        want '+b);}};

const D = s => new Date(Date.UTC(+s.slice(0,4), +s.slice(5,7)-1, +s.slice(8,10)));

console.log('\n# date cells must not be read as maturities');
eq('31/07/2026', parseTenor('31/07/2026'), null);
eq('2026-07-31', parseTenor('2026-07-31'), null);
eq('Date object', parseTenor(D('2026-07-31')), null);
eq('7/2026', parseTenor('7/2026'), null);
eq('18M still works', parseTenor('18M'), 1.5);

console.log('\n# wide: numeric maturity headers, metadata rows above, Date cells');
const wide1 = [
  ['Bank of Israel — Zero-coupon yield curve (nominal)'],
  ['Percent, annual'],
  [],
  ['Date', 0.25, 0.5, 1, 2, 3, 5, 10, 20, 30],
  [D('2026-07-29'), 3.36, 3.27, 3.21, 3.37, 3.57, 3.77, 4.07, 4.37, 4.42],
  [D('2026-07-30'), 3.38, 3.29, 3.23, 3.38, 3.58, 3.78, 4.08, 4.38, 4.43],
  [D('2026-07-31'), 3.40, 3.30, 3.25, 3.40, 3.60, 3.80, 4.10, 4.40, 4.45],
];
const r1 = rowsToCurveWide(wide1);
eq('takes last row', r1.points, [[0.25,3.4],[0.5,3.3],[1,3.25],[2,3.4],[3,3.6],[5,3.8],[10,4.1],[20,4.4],[30,4.45]]);
eq('header row index', r1.diag.headerRow, 4);
eq('asOf from date cell', r1.diag.asOf, '2026-07-31');
eq('data row count', r1.diag.dataRows, 3);

console.log('\n# wide: text maturity headers, dd/mm/yyyy strings');
const wide2 = [
  ['Date','3M','6M','1Y','18M','2Y','5Y','10Y','30Y'],
  ['29/07/2026',3.36,3.27,3.21,3.26,3.37,3.77,4.07,4.42],
  ['31/07/2026',3.40,3.30,3.25,3.30,3.40,3.80,4.10,4.45],
];
const r2 = rowsToCurveWide(wide2);
eq('text headers', r2.points, [[0.25,3.4],[0.5,3.3],[1,3.25],[1.5,3.3],[2,3.4],[5,3.8],[10,4.1],[30,4.45]]);
eq('asOf from dd/mm/yyyy', r2.diag.asOf, '2026-07-31');

console.log('\n# wide: row / date selection');
eq('--row 1', rowsToCurveWide(wide1,{row:1}).diag.asOf, '2026-07-29');
eq('--row -2', rowsToCurveWide(wide1,{row:-2}).diag.asOf, '2026-07-30');
eq('--date match', rowsToCurveWide(wide1,{date:'2026-07-30'}).diag.asOf, '2026-07-30');
eq('--date miss reports', rowsToCurveWide(wide1,{date:'1999-01-01'}).points, []);
eq('--row out of range', rowsToCurveWide(wide1,{row:99}).points, []);

console.log('\n# wide: fractions get scaled');
const frac = [['Date',1,2,10],[D('2026-07-31'),0.0325,0.0340,0.0410]];
const rf = normaliseScale(rowsToCurveWide(frac).points);
eq('scaled to percent', rf.points, [[1,3.25],[2,3.4],[10,4.1]]);
eq('scale noted', /scaled by 100/.test(rf.note), true);
eq('percent left alone', normaliseScale([[1,3.25]]).note, null);
eq('absurd value warned', /too large/.test(normaliseScale([[1,325]]).note), true);

console.log('\n# auto-detect must not confuse wide and long');
eq('long stays long', rowsToCurveAuto([['TIME_PERIOD','TENOR','OBS_VALUE'],
  ['2026-07-31','0.25',3.40],['2026-07-31','1',3.25],['2026-07-31','10',4.10]]).diag.mode, 'table');
eq('wide stays wide', rowsToCurveAuto(wide1).diag.mode, 'wide');

console.log('\n# rejects a table with no maturity header');
eq('no header', rowsToCurveWide([['a','b'],['1','2']]).points, []);
eq('reason given', /no header row/.test(rowsToCurveWide([['a','b'],['1','2']]).diag.reason), true);

console.log('\n# real .xls round-trip through SheetJS (BIFF8)');
const wb = X.utils.book_new();
X.utils.book_append_sheet(wb, X.utils.aoa_to_sheet(wide1), 'Nominal');
X.utils.book_append_sheet(wb, X.utils.aoa_to_sheet([
  ['Date',1,2,5,10,30],
  [D('2026-07-30'),1.14,1.29,1.69,1.99,2.29],
  [D('2026-07-31'),1.15,1.30,1.70,2.00,2.30],
]), 'Real (CPI-linked)');
X.writeFile(wb, 'fixture.xls', { bookType: 'biff8' });
const sheets = await readSpreadsheet(fs.readFileSync('fixture.xls'));
eq('sheet names', sheets.map(s=>s.name), ['Nominal','Real (CPI-linked)']);
const nom = rowsToCurveAuto(sheets[0].rows), real = rowsToCurveAuto(sheets[1].rows);
eq('xls nominal', nom.points, [[0.25,3.4],[0.5,3.3],[1,3.25],[2,3.4],[3,3.6],[5,3.8],[10,4.1],[20,4.4],[30,4.45]]);
eq('xls real', real.points, [[1,1.15],[2,1.3],[5,1.7],[10,2],[30,2.3]]);
eq('xls asOf survives binary round-trip', nom.diag.asOf, '2026-07-31');
fs.unlinkSync('fixture.xls');       // gitignored, but don't litter the tree either

// A workbook written from Date objects round-trips through SheetJS's own
// timezone handling symmetrically, which hides a shift. The BOI files store bare
// integer serials with a date format, so build one of those and read it back
// under timezones either side of UTC: the observation date must not move.
console.log('\n# date serials read the same in every timezone');
{
  const ws = X.utils.aoa_to_sheet([['Date',1,2,10],[null,3.25,3.40,4.10]]);
  ws.A2 = { t:'n', v:46234, z:'dd/mm/yyyy' };          // 2026-07-31, midnight
  const wb2 = X.utils.book_new();
  X.utils.book_append_sheet(wb2, ws, 'Nominal');
  X.writeFile(wb2, 'fixture-serial.xls', { bookType:'biff8' });

  const read = tz => execFileSync(process.execPath, ['--input-type=module','-e', `
      import fs from 'node:fs';
      const { readSpreadsheet, rowsToCurveAuto } = await import('${import.meta.url}'.replace(/test\\/test-wide\\.mjs$/,'tools/refresh-curve.mjs'));
      const s = await readSpreadsheet(fs.readFileSync('fixture-serial.xls'));
      process.stdout.write(String(rowsToCurveAuto(s[0].rows).diag.asOf));
    `], { env: { ...process.env, TZ: tz }, encoding: 'utf8' }).trim();

  eq('UTC',              read('UTC'),              '2026-07-31');
  eq('Asia/Jerusalem',   read('Asia/Jerusalem'),   '2026-07-31');
  eq('America/New_York', read('America/New_York'), '2026-07-31');
  eq('Pacific/Auckland', read('Pacific/Auckland'), '2026-07-31');
  fs.unlinkSync('fixture-serial.xls');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
