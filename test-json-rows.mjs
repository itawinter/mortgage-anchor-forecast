// Mapping an arbitrary securities listing to curve points.
import { parseSource, parseJsonRows } from './refresh-curve.mjs';
let pass=0; const errs=[];
const eq=(n,a,b)=>{ if(JSON.stringify(a)===JSON.stringify(b)){pass++;console.log('  ok   '+n);}
  else errs.push(`${n}\n        got  ${JSON.stringify(a)}\n        want ${JSON.stringify(b)}`); };

// A T-bill listing: bills quoted by redemption date and yield, nested, with
// extra rows that are not bills. This is the SHAPE such feeds take; the field
// names below are placeholders until the real ones are known.
const listing = { d: { Items: [
  { Name: 'מק"מ 0926', Redemption: '2026-09-30', Yield: '3.31', Kind: 'MAKAM' },
  { Name: 'מק"מ 1226', Redemption: '2026-12-31', Yield: '3.28', Kind: 'MAKAM' },
  { Name: 'מק"מ 0327', Redemption: '2027-03-31', Yield: '3.27', Kind: 'MAKAM' },
  { Name: 'מק"מ 0727', Redemption: '2027-07-31', Yield: '3.28', Kind: 'MAKAM' },
  { Name: 'not a bill', Redemption: null, Yield: null }
] } };

const r = parseJsonRows(listing, { jsonPath:'d.Items', jsonMatures:'Redemption',
                                   jsonValue:'Yield', asOf:'2026-07-31' });
console.log('# redemption dates -> tenors, measured from the observation date');
eq('four bills kept', r.points.length, 4);
eq('2m bill', r.points[0].map(x=>+x.toFixed(3)), [0.167, 3.31]);
eq('5m bill', r.points[1].map(x=>+x.toFixed(3)), [0.419, 3.28]);
eq('1y bill', r.points[3].map(x=>+x.toFixed(3)), [1.0, 3.28]);
eq('the non-bill row is skipped, and counted', r.diag.skipped, 1);
eq('diag names the fields it used', [r.diag.tenorFrom, r.diag.valueFrom],
   ['matures:Redemption','value:Yield']);

console.log('\n# the array is found without --json-path');
const auto = parseJsonRows(listing, { jsonMatures:'Redemption', jsonValue:'Yield', asOf:'2026-07-31' });
eq('auto-located array', auto.points.length, 4);

console.log('\n# a feed that quotes tenors directly');
const tenors = { rows: [ {t:'3M', y:'3.23'}, {t:'6M', y:'3.29'}, {t:'1Y', y:'3.28'} ] };
eq('tenor field', parseJsonRows(tenors,{jsonTenor:'t',jsonValue:'y'}).points,
   [[0.25,3.23],[0.5,3.29],[1,3.28]]);

console.log('\n# failure is reported, not silent');
eq('bad path', parseJsonRows(listing,{jsonPath:'d.Nope',jsonValue:'Yield'}).diag.reason,
   'no array at --json-path d.Nope');
eq('no array anywhere', parseJsonRows({a:1},{jsonValue:'Yield'}).points, []);
eq('wrong value field -> nothing kept, nothing invented',
   parseJsonRows(listing,{jsonPath:'d.Items',jsonMatures:'Redemption',jsonValue:'Nope'}).points, []);

console.log('\n# dispatch: parseSource routes to the mapper when fields are given');
eq('via parseSource', parseSource(JSON.stringify(listing),
   {jsonPath:'d.Items',jsonMatures:'Redemption',jsonValue:'Yield',asOf:'2026-07-31'}).points.length, 4);
eq('without fields, untouched', parseSource(JSON.stringify([[1,3.25]])).points, [[1,3.25]]);

console.log(`\n${pass} passed, ${errs.length} failed`);
if (errs.length) { console.log('ISSUES:\n  '+errs.join('\n  ')); process.exit(1); }

console.log('\n# price -> yield, against the real pasted TASE row');
// מ.ק.מ 217 · last price 98.37 agorot · the table has NO yield column.
const tase = { Items: [{ Name:'מ.ק.מ 217', Symbol:'מקמ217', Price:'98.37', Redemption:'2027-02-03' }] };
const px = parseJsonRows(tase, { jsonMatures:'Redemption', jsonPrice:'Price', asOf:'2026-08-01' });
eq('one bill priced into a zero rate', px.points.length, 1);
eq('98.37 at ~6m -> 3.28%', +px.points[0][1].toFixed(2), 3.28);
eq('diag says it converted a price', px.diag.valueFrom, 'price:Price -> yield');
// The loaded makam file puts 6m at 3.29% — the two agree to ~1bp, which is what
// makes the conversion and the Feb-2027 reading of "217" credible.
const makam6m = 3.29;
eq('within 2bp of makam.xlsx at the same tenor', Math.abs(px.points[0][1] - makam6m) < 0.02, true);

console.log('\n# the redemption DAY is not optional at the short end');
const dayShift = ['2027-02-01','2027-02-28'].map(d =>
  parseJsonRows({Items:[{Price:'98.37',Redemption:d}]},
    {jsonMatures:'Redemption',jsonPrice:'Price',asOf:'2026-08-01'}).points[0][1]);
const spreadBp = Math.round((dayShift[0] - dayShift[1]) * 100);
console.log(`  Feb 1 -> ${dayShift[0].toFixed(3)}%, Feb 28 -> ${dayShift[1].toFixed(3)}%  (${spreadBp} bp apart)`);
eq('a month of date error is worth tens of bp', spreadBp > 30, true);

console.log('\n# a price with no tenor cannot be converted, and is not guessed');
eq('no tenor -> skipped', parseJsonRows({Items:[{Price:'98.37'}]},
   {jsonPrice:'Price',jsonMatures:'Nope',asOf:'2026-08-01'}).points, []);
