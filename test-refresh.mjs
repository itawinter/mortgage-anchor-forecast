import { parseDelimited, parseTenor, parseRate, rowsToCurve, parseSdmxJson,
         parseSource, injectIntoHtml, formatPoints } from './refresh-curve.mjs';
import fs from 'node:fs';
let pass=0, fail=0;
const eq=(name,got,want)=>{ const g=JSON.stringify(got), w=JSON.stringify(want);
  if(g===w){pass++;console.log('  ok   '+name);} else {fail++;console.log('  FAIL '+name+'\n        got  '+g+'\n        want '+w);} };

console.log('\n# parseTenor');
eq('18M',parseTenor('18M'),1.5);
eq('1.5',parseTenor('1.5'),1.5);
eq('1Y',parseTenor('1Y'),1);
eq('3 months',parseTenor('3 months'),0.25);
eq('10 years',parseTenor('10 years'),10);
eq('P18M',parseTenor('P18M'),1.5);
eq('P2Y6M',parseTenor('P2Y6M'),2.5);
eq('TENOR_18M',parseTenor('TENOR_18M'),1.5);
eq('hebrew months',parseTenor('6 חודשים'),0.5);
eq('hebrew years',parseTenor('10 שנים'),10);
eq('bare 120 -> months',parseTenor('120'),10);
eq('bare 30 -> years',parseTenor('30'),30);
eq('junk',parseTenor('total'),null);
eq('empty',parseTenor(''),null);

console.log('\n# parseRate');
eq('3.40%',parseRate('3.40%'),3.4);
eq('decimal comma',parseRate('3,40'),3.4);
eq('thousands',parseRate('1,234.5'),1234.5);
eq('paren negative',parseRate('(0.5)'),-0.5);
eq('na',parseRate('N/A'),null);
eq('dash',parseRate('-'),null);

console.log('\n# CSV: BOI-style long table with dates, two observation dates');
const csv = 'TIME_PERIOD,TENOR,OBS_VALUE\n2026-07-30,0.25,3.38\n2026-07-30,1,3.22\n2026-07-31,0.25,3.40\n2026-07-31,1,3.25\n2026-07-31,18M,3.30\n2026-07-31,10Y,4.10\n';
const r1 = rowsToCurve(parseDelimited(csv));
eq('latest date only', r1.points, [[0.25,3.4],[1,3.25],[1.5,3.3],[10,4.1]]);
eq('asOf detected', r1.diag.asOf, '2026-07-31');

console.log('\n# CSV: semicolon + decimal comma + quoted header');
const csv2 = '"Maturity (years)";"Zero yield"\n0,25;3,40\n1;3,25\n10;4,10\n';
eq('eu format', rowsToCurve(parseDelimited(csv2)).points, [[0.25,3.4],[1,3.25],[10,4.1]]);

console.log('\n# CSV: no header, positional');
eq('headerless', rowsToCurve(parseDelimited('0.25,3.40\n1,3.25\n10,4.10\n')).points,
   [[0.25,3.4],[1,3.25],[10,4.1]]);

console.log('\n# CSV: single-tenor time series with --tenor');
const ts = 'TIME_PERIOD,OBS_VALUE\n2026-07-29,3.28\n2026-07-30,3.29\n2026-07-31,3.30\n';
const r2 = rowsToCurve(parseDelimited(ts), {tenor:1.5});
eq('single tenor takes latest', r2.points, [[1.5,3.3]]);
eq('single tenor date', r2.diag.date, '2026-07-31');

console.log('\n# CSV: tab separated');
eq('tsv', rowsToCurve(parseDelimited('TENOR\tVALUE\n1\t3.25\n2\t3.40\n')).points, [[1,3.25],[2,3.4]]);

console.log('\n# CSV: quoted field containing the delimiter');
eq('quoted comma', parseDelimited('a,"b,c",d\n1,2,3\n')[0], ['a','b,c','d']);

console.log('\n# CSV: CRLF + BOM');
eq('crlf+bom', rowsToCurve(parseDelimited('﻿TENOR,VALUE\r\n1,3.25\r\n2,3.40\r\n')).points,
   [[1,3.25],[2,3.4]]);

console.log('\n# SDMX-JSON');
const sdmx = { data: { structures:[{ dimensions:{
    series:[{id:'FREQ',values:[{id:'D'}]},{id:'TENOR',values:[{id:'0.25'},{id:'1'},{id:'10'}]}],
    observation:[{id:'TIME_PERIOD',values:[{id:'2026-07-30'},{id:'2026-07-31'}]}] }}],
  dataSets:[{ series:{
    '0:0':{observations:{'0':[3.38],'1':[3.40]}},
    '0:1':{observations:{'0':[3.22],'1':[3.25]}},
    '0:2':{observations:{'0':[4.08],'1':[4.10]}} }}] } };
const r3 = parseSdmxJson(sdmx);
eq('sdmx points', r3.points, [[0.25,3.4],[1,3.25],[10,4.1]]);
eq('sdmx tenor dim', r3.diag.tenorDim, 'TENOR');
eq('sdmx asOf', r3.diag.asOf, '2026-07-31');

console.log('\n# parseSource dispatch');
eq('json array of pairs', parseSource('[[1,3.25],[2,3.40]]').points, [[1,3.25],[2,3.4]]);
eq('json array of objects', parseSource('[{"tenor":"18M","rate":"3.30%"}]').points, [[1.5,3.3]]);
eq('curve.json passthrough', parseSource('{"asOf":"2026-07-31","nominal":[[1,3.25]]}').curve.nominal, [[1,3.25]]);
eq('csv via dispatch', parseSource('TENOR,VALUE\n1,3.25\n').points, [[1,3.25]]);
eq('bad json', parseSource('{oops').points, []);

console.log('\n# failure surfaces, not silence');
eq('empty text -> no points', parseSource('').points, []);
eq('text with no numbers', parseSource('header only\nno data here\n').points, []);

console.log('\n# injectIntoHtml round-trip against the real page');
const PAGE = ['index.html','mortgage-forward-anchor.html'].find(f => fs.existsSync(f));
const html = fs.readFileSync(PAGE,'utf8');
const inj = injectIntoHtml(html, { asOf:'2026-08-15',
  nominal:[[0.25,3.55],[1,3.40],[1.5,3.42],[10,4.25]], real:[[1,1.30],[10,2.10]] });
const nm = inj.html.match(/const DEFAULT_NOMINAL = \[([\s\S]*?)\];/);
const rm = inj.html.match(/const DEFAULT_REAL = \[([\s\S]*?)\];/);
eq('nominal injected', nm[1].replace(/\s+/g,' ').trim(), '[0.25, 3.55], [1, 3.40], [1.5, 3.42], [10, 4.25]');
eq('real injected', rm[1].replace(/\s+/g,' ').trim(), '[1, 1.30], [10, 2.10]');
// The date now lands in BUILTIN_PROV, per leg — that is where the page reads it.
const prov = inj.html.match(/const BUILTIN_PROV = \{([\s\S]*?)\n\};/)[1];
eq('nominal date injected', /nominal:[\s\S]{0,240}?asOf: "2026-08-15"/.test(prov), true);
eq('real date injected',    /real:[\s\S]{0,240}?asOf: "2026-08-15"/.test(prov), true);
eq('inject reports both dates', inj.changed.filter(c=>c.includes('2026-08-15')).length, 2);

// The WHOLE script must still parse. Checking only the arrays it rewrote misses
// an injection whose replacement span ran past its target and ate the code
// after it — which is exactly what a lazy regex does to a nested array.
const script = inj.html.match(/<script>\n"use strict";([\s\S]*)<\/script>/)[1];
let parses = true, why = '';
try { new Function(script); } catch (e) { parses = false; why = e.message; }
eq('injected page still parses as JS', parses ? true : why, true);
eq('BUILTIN_PROV survives injection intact',
   /const BUILTIN_PROV = \{[\s\S]*?\n\};/.test(inj.html) &&
   /const SOURCES = \[/.test(inj.html), true);
// and segs are rewritten, with keys the page's upload buttons can match
eq('segs injected with source keys',
   (inj.html.match(/key: "(makam|shcd08|shcd07)"/g) || []).length >= 1, true);
// injected page must still be valid JS
fs.writeFileSync('/tmp/inj-check.mjs', (inj.html.match(/const DEFAULT_NOMINAL[\s\S]*?const DEFAULT_REAL = \[[\s\S]*?\];/)||[''])[0]+'\nconsole.log("parsed",DEFAULT_NOMINAL.length,DEFAULT_REAL.length);');
console.log('\n# injected arrays are valid JS');
const { execSync } = await import('node:child_process');
console.log('  '+execSync('node /tmp/inj-check.mjs').toString().trim());
// idempotency
const inj2 = injectIntoHtml(inj.html, { asOf:'2026-08-15', nominal:[[0.25,3.55],[1,3.40],[1.5,3.42],[10,4.25]], real:[[1,1.30],[10,2.10]] });
eq('inject is idempotent', inj2.html === inj.html, true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
