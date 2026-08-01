// Compare xls-lite against SheetJS on the real Bank of Israel workbooks.
import fs from 'node:fs';
import * as XLSX from 'xlsx';
import { JSDOM } from 'jsdom';
const dom = new JSDOM(''); globalThis.DOMParser = dom.window.DOMParser;
const { readWorkbook } = await import('./xls-lite.mjs');

const cell = v => v instanceof Date ? v.toISOString().slice(0,10)
  : typeof v === 'number' ? +v.toFixed(9) : (v == null ? null : String(v));

let pass = 0; const errs = [];
const eq = (n, a, b) => { if (JSON.stringify(a) === JSON.stringify(b)) { pass++; console.log('  ok   '+n); }
  else errs.push(`${n}\n        got  ${JSON.stringify(a)}\n        want ${JSON.stringify(b)}`); };

const FIXTURES = ['shcd08_e.xls','shcd07_e.xls','makam.xlsx'].filter(f => fs.existsSync(f));
if (!FIXTURES.length) {
  console.log('No workbook fixtures present — nothing to compare against.');
  console.log('Drop shcd08_e.xls / shcd07_e.xls / makam.xlsx beside this file to run it.');
  process.exit(0);
}
for (const f of FIXTURES) {
  console.log('\n# '+f);
  const buf = fs.readFileSync(f);
  const mine = await readWorkbook(buf.buffer.slice(buf.byteOffset, buf.byteOffset+buf.byteLength));

  const wb = XLSX.read(buf, { type:'buffer', cellDates:true });
  const ref = wb.SheetNames.map(n => ({ name:n,
    rows: XLSX.utils.sheet_to_json(wb.Sheets[n], { header:1, raw:true, defval:null }) }));

  eq('sheet names', mine.map(s=>s.name), ref.map(s=>s.name));
  for (let i=0;i<ref.length;i++) {
    const a = mine[i], b = ref[i];
    eq(`${b.name}: row count`, a.rows.length, b.rows.length);
    // compare every populated cell
    let diffs = 0, shown = 0;
    for (let r=0;r<b.rows.length;r++) {
      const br = b.rows[r]||[], ar = a.rows[r]||[];
      for (let c=0;c<br.length;c++) {
        const x = cell(ar[c]), y = cell(br[c]);
        if (x !== y && !(x==null&&y==null)) {
          diffs++;
          if (shown++ < 5) console.log(`       r${r+1}c${c+1}: mine=${JSON.stringify(x)} ref=${JSON.stringify(y)}`);
        }
      }
    }
    eq(`${b.name}: all cells match`, diffs, 0);
  }
}
console.log(`\n${pass} passed, ${errs.length} failed`);
if (errs.length) { console.log('ISSUES:\n  '+errs.join('\n  ')); process.exit(1); }
