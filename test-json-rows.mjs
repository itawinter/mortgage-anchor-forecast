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

// ---------------------------------------------------------------------------
// The live TASE endpoint, verified 2026-08-01. Two real rows from
// POST api.tase.co.il/api/security/securitiesmarketdata, unedited. The visible
// table on the site has neither a yield nor a redemption date; the JSON behind
// it has both, plus a day count.
const live = { TradeDate: '31/07/2026', TotalRec: 12, Items: [
  { LastRate: 98.37, BaseRate: 98.36, BrutoYield: 3.27,
    RedemptionDate: '03/02/2027', DaysUntilRedemption: 186, TradeDate: null },
  { LastRate: 97.04, BaseRate: 97.03, BrutoYield: 3.28,
    RedemptionDate: '07/07/2027', DaysUntilRedemption: 340, TradeDate: null }
] };

console.log('\n# the observation date comes off the envelope, not the rows');
const env = parseJsonRows(live, { jsonPath:'Items', jsonTenorDays:'DaysUntilRedemption',
                                  jsonValue:'BrutoYield', jsonAsOf:'TradeDate' });
// TASE puts one TradeDate beside the array and leaves the per-row field null.
// Reading only the row gave today's date, which silently moved every tenor.
eq('dd/mm/yyyy envelope date, normalised', env.diag.asOf, '2026-07-31');
eq('not today', env.diag.asOf !== new Date().toISOString().slice(0,10), true);
eq('day count -> tenor', env.points.map(p=>+p[0].toFixed(6)),
   [+(186/365).toFixed(6), +(340/365).toFixed(6)]);
eq('yield read as published', env.points.map(p=>p[1]), [3.27, 3.28]);
eq('diag names the day-count field', env.diag.tenorFrom, 'days:DaysUntilRedemption');

console.log('\n# a row-level date still works when there is no envelope one');
eq('falls back to the first record',
   parseJsonRows({ Items:[{ Rate:'3.27', t:'6M', TradeDate:'31/07/2026' }] },
     { jsonPath:'Items', jsonTenor:'t', jsonValue:'Rate', jsonAsOf:'TradeDate' }).diag.asOf,
   '2026-07-31');

console.log('\n# the two independent readings of the same bill must agree');
// Price->yield and TASE's own BrutoYield are computed from different numbers.
// Over the same day count they agree to ~1bp, which is what makes both the
// conversion and the published yield credible. They are compared at the SAME
// tenor deliberately: derive the tenor from the redemption date instead and the
// disagreement is a day of day-count, not a yield error.
const fromPrice = parseJsonRows(live, { jsonPath:'Items',
  jsonTenorDays:'DaysUntilRedemption', jsonPrice:'LastRate', par:100 });
const gaps = fromPrice.points.map((p,i) => Math.abs(p[1] - env.points[i][1]));
console.log(`  price-implied ${fromPrice.points.map(p=>p[1].toFixed(3)).join(', ')}` +
            ` vs published ${env.points.map(p=>p[1]).join(', ')}`);
eq('within 2bp on both bills', gaps.every(g => g < 0.02), true);
// And the 6m bill still lands where makam.xlsx put it, from a live pull: 3.27%
// at 186d against the snapshot's 3.29% at 6m. 2bp, across two publishers, two
// observation dates a day apart and tenors a few days apart — which is the
// agreement that makes reading this endpoint as a Makam curve credible.
eq('186d bill within 3bp of makam.xlsx at 6m', Math.abs(env.points[0][1] - 3.29) <= 0.03, true);

console.log('\n# a day count beats a redemption date when both are given');
// One day of error at the very front of the curve is worth ~90bp, so when the
// source hands over its own count, that is the one to use.
eq('tenorDays wins', parseJsonRows(live,
   { jsonPath:'Items', jsonTenorDays:'DaysUntilRedemption',
     jsonMatures:'RedemptionDate', jsonValue:'BrutoYield', asOf:'2026-07-31' }
   ).diag.tenorFrom, 'days:DaysUntilRedemption');
eq('a zero or missing count is skipped, not treated as spot',
   parseJsonRows({Items:[{d:0,y:'3.3'},{d:null,y:'3.3'}]},
     {jsonPath:'Items',jsonTenorDays:'d',jsonValue:'y'}).points, []);

console.log(`\n${pass} passed, ${errs.length} failed`);
if (errs.length) { console.log('ISSUES:\n  '+errs.join('\n  ')); process.exit(1); }
