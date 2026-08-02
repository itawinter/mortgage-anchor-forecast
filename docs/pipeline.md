# How the data gets in

The engineering half of this project: where the curve comes from, how it is
merged, and the decisions that are easy to undo by accident. The [README](../README.md)
covers what the page *is*.

## The refresh job

```
.github/workflows/refresh.yml     weekdays 04:00 UTC (07:00 Israel)
        │
        ├─ node tools/refresh-curve.mjs --config data/sources.json
        │        │
        │        ├─ shcd08_e.xls          nominal zero curve, 1y–15y
        │        ├─ shcd07_e.xls          real (Galil) zero curve, 1y–20y
        │        └─ TASE t_bills API      Makam short end, live · falls back
        │                                 to data/makam-short-end.csv
        │
        ├─ sanity-check the result   both legs present? short end? long end?
        │                            rates inside -5..25%?
        │
        ├─ bake the validated curve into index.html's built-in defaults
        │
        └─ commit curve.json + index.html if either changed and it passed
                │
                └─ GitHub Pages redeploys → index.html fetches ./curve.json
```

**Both files, always.** The page paints its baked-in curve first and only then
applies the fetched `curve.json`, so if the two disagree every load opens on the
older numbers and visibly corrects itself a moment later. Refreshing `curve.json`
alone also lets the baked copy drift further behind on every run, since nothing
else rewrites it. The bake step injects the file that just passed the check
rather than re-running the pull, so the page and `curve.json` cannot end up
describing different curves.

Same-origin, so no CORS is involved — which is the whole reason this shape is
needed. A browser cannot fetch `boi.org.il` or `market.tase.co.il` directly:
those servers do not send `Access-Control-Allow-Origin`, so the data has to be
re-served from your own origin. That is what the commit does.

`curve.json` lives at the repo **root**, next to `index.html`, because the page
fetches it as `./curve.json` and Pages serves the site from `/`. It is published
output, not source — which is why it is not in `data/`.

**Every source lives in `data/sources.json`** — URLs, request bodies, field
names, in one file read by both the scheduled job and `npm run refresh`. A URL
that moves is fixed once. Paths inside it resolve relative to the config file, so
it does not matter what directory you invoke it from.

**A partial pull is the dangerous case**, not a total failure. If only one leg
parsed, a file would still be written and would drop a curve the page needs — so
the workflow validates before `curve.json` is replaced, and commits nothing if
the check fails. The run goes red instead.

## The Makam short end, and the endpoint behind it

The short end is a live pull from the TASE securities API — the JSON the T-bills
page fetches for its own table:

```
POST https://api.tase.co.il/api/security/securitiesmarketdata
     {"dType":1,"lang":2,"cl1":"6","cl2":"0","pageNum":1}
```

Three things about it are worth knowing before you touch it:

- **`cl1: "6"` is the T-Bills group**, from
  `GET security/securitiesclassifications?lang=1`. `lang: 2` and `pageNum` are
  both required — omit either and the response is an empty list rather than an
  error, which is exactly the failure mode that looks like "no bills today".
  `cl1` must be the *string* `"6"`; the number returns nothing.
- **`Accept-Language` is what the WAF checks.** Without that header the endpoint
  answers `403` to an otherwise identical request. The other headers in
  `sources.json` (Origin, Referer, a browser UA) are also required. If you are
  debugging a 403, add headers one at a time — that is how this was found.
- **The JSON has what the visible table lacks.** The rendered table shows a price
  and no yield or redemption date, which makes a price→yield conversion look
  mandatory. The payload behind it carries `BrutoYield`, `RedemptionDate` **and**
  `DaysUntilRedemption`. Don't reason about a web app's data from its DOM.

**Yield and day count are both taken from TASE, not derived.** They were computed
there at the same instant, so they agree with each other. Deriving the tenor from
`RedemptionDate` instead means guessing which day TASE measured from, and at the
front of the curve one day of day-count error is worth about **90bp** — the
shortest bill on any given day is a few days from redemption, where the
annualisation multiplier is enormous. The price→yield path is still implemented
(`--json-price`, `y = (par/price)^(1/T) − 1`) and agrees with the published yield
to ~1bp over the same day count; `test/test-json-rows.mjs` asserts that agreement,
so the two readings cannot drift apart unnoticed.

**Cross-checked before being trusted:** the 186-day bill priced at 98.37 read
3.27% live, against 3.29% at 6m in the `makam.xlsx` snapshot from the day before —
2bp, across two publishers and two observation dates.

**If TASE refuses, the snapshot is used.** The Makam source declares
`fallback: makam-short-end.csv`, so a WAF that blocks the CI runner leaves the
short end stale rather than killing the job. `falling back to …` in the Actions
log is the signal that the live pull stopped working; it will not turn the run
red, so watch for it.

One known wrinkle: `DaysUntilRedemption` counts from *today* while the price is
from `TradeDate`. On a day the market does not trade, the tenor moves and the
yield does not, so the front point's two numbers drift a day apart. It only
matters at the very front, which the pipeline already flags in a note.

## The 1y splice, and why a source declares what it governs

Real bills mature on real dates, so the short end ends at the longest bill —
around 0.93y, not exactly 1y. "Later sources win a shared maturity" therefore
never fires at 1y, and the first version of this left `shcd08`'s mid-month 1y
point standing beside a live bill yield observed a fortnight later. The curve ran
**3.28% → 3.21% → 3.29%** across 0.93y→1y→2y: a 7bp dip, 25 days wide, between
two real sources that simply disagree about where 1y is.

A forward rate has to make that dip up. To get from a low 1y to an unchanged 2y,
the year in between must be priced higher — so the 12-month projection came out
**+16bp** where the same curve a day earlier said **+2bp**. Roughly 2bp of that
was the market and 14bp was the seam.

The fix is `governs` in `sources.json`. Makam declares `[0, 1]`: it is
authoritative over the 0–1y span, not merely over the maturities it happens to
quote, so points already merged inside that span are dropped along with their
ownership. `z(1y)` is then interpolated from the last bill to `shcd08`'s 2y point
— drawn grey, as "between two known sources" — and the 12-month delta reads +2bp
again. Nothing is invented: no maturity is fabricated and no level is shifted.

**Order still matters.** `governs` applies when a source is merged, so Makam is
listed last. Reversing the order changes the attribution of every maturity the
two sources share.

`test/test-merge.mjs` pins both halves of this, including an assertion that the
un-governed merge *does* produce the inflated delta, so the artefact cannot come
back unnoticed.

## Two implementations, on purpose

The page must work with **no tooling at all** — open `index.html`, drop a
workbook on it, and it parses locally. So the parsers live in both
`tools/refresh-curve.mjs` and inside `index.html`, and **must be changed in
both**: `parseDelimited`, `parseTenor`, `parseRate`, `rowsToCurve`,
`rowsToCurveWide`, `rowsToCurveAuto`, `normaliseScale`, `stampOf`, `seriesTitle`,
`sourceKey`/`sourceKeyOf`.

They are not identical — the CLI has diagnostics the page doesn't — so diff
*behaviour*, not text. `index.html` also contains an inlined copy of
`tools/xls-lite.mjs` (minus its `export`s) so it can read `.xls`/`.xlsx` in the
browser; editing the standalone file does not update the page.

Two traps found the hard way:

- **`stampOf` and timezones.** SheetJS builds date cells in local time, xls-lite
  builds them in UTC, and both are formatted with `toISOString()`. East of UTC
  that read every workbook date a day early — `2026-07-15` became `2026-07-14` in
  Asia/Jerusalem. `readSpreadsheet` now re-anchors SheetJS's dates
  (`localDateToUTC`); apply it to SheetJS output only.
- **The page keys colour and title off a source's *label*.** `sourceKeyOf`
  matches `makam` / `shcd08` / `shcd07`; a label that matches nothing loses its
  pinned colour and its series name. An API path makes a terrible label, which is
  why sources can set `label` explicitly.

## Language

English and Hebrew, both in `index.html`. `I18N` holds one flat table per
language; `t(key, vars)` interpolates `{name}` placeholders and **falls back to
English for any key Hebrew does not define**, so a half-finished translation
shows English rather than `undefined`.

- **Static markup** is tagged: `data-i18n` (textContent), `data-i18n-html`
  (innerHTML, for strings carrying markup) and `data-i18n-attr="aria-label:key"`.
- **Anything built in JS must go through `t()`.** `applyLang` re-renders, which is
  also what repaints the canvases — their labels are drawn, not DOM, so nothing
  else would update them.
- **Don't shadow `t`.** A local `const t = text.trim()` or a `knots.map(t => …)`
  silently turns every `t("key")` inside that scope into "call a string". This bit
  twice while translating; the locals are now `txt` and `mat`.
- **RTL is logical, not mirrored by hand.** `text-align: end`, `border-inline-start`,
  `padding-inline-start` and friends flip on their own under `dir="rtl"`. Only
  three things need explicit overrides: the today-row inset shadow, the `→` in
  raw→adjusted cells, and the letter-spacing on labels (tracking is a Latin
  device — Hebrew has no case, so spaced-out נתונים just looks broken).
- **Figures are not text.** `unicode-bidi: plaintext` on numeric cells stops the
  bidi algorithm reordering `+8 bp` or `3.28% → 3.28%` inside an RTL line, and the
  formula block is pinned `direction: ltr` because maths is written LTR in every
  language.
- Release types (`Calendar` / `CPI-dated`) are translated through `pub.*` keys to
  BOI's own Hebrew names, קלנדרי and מדדי.

The Hebrew is banking vocabulary rather than literal translation — עוגן, מרווח,
מק"מ, לוח שפיצר — because that is the wording the reader's own mortgage contract
uses.

## Design decisions worth not undoing

**The page holds *sources*, not merged curves.** `state.src` keyed by
`makam`/`shcd08`/`shcd07`; `mergeLeg()` rebuilds a leg from them. This is why
loading a fresh Makam file doesn't wipe the 2y–15y long end.

**Colours are pinned per source** (`SOURCES[].col`), not assigned by segment
position — position-based colouring silently reassigns hues when a source is
added or removed.

**Grey means "between two known sources".** Held-flat regions outside the data
extrapolate *one* source, so they keep that source's colour and say "not data"
with a dash instead. Don't collapse these into one treatment.

**Breakeven is withheld unless both legs are real data.** A breakeven computed
against a placeholder is an artefact of the invention, not an indicative figure.

**The staleness check is silent in two cases**: no readable date, and a date past
the end of the release calendar. "You're up to date" that really means "I ran out
of calendar" is worse than nothing. Makam is exempt — it's daily, on no such
schedule. The calendar in the page ends **2027-01-04**; extend it when BOI
publishes the next year.

**Injection uses balanced bracket scanning, not regex.** A lazy `[\s\S]*?\]`
aimed at `segs` once ran past it and ate the end of `BUILTIN_PROV` — a silently
corrupted page that the then-existing test still passed. `test-refresh.mjs` now
`new Function()`s the entire script after injection.

**Don't write dates or levels in prose beside data that refreshes daily.** The
injector rewrites the arrays, not the sentences around them, so anything hardcoded
there is stale by construction. The page renders its dates from the data instead.

## Layout

```
index.html               the calculator (contains an inlined copy of xls-lite.mjs);
                         its baked-in curve is rewritten by the scheduled job too
curve.json               current curve; rewritten by the scheduled job
tools/refresh-curve.mjs  fetch → parse → merge → curve.json; also --inject
tools/xls-lite.mjs       dependency-free .xls/.xlsx reader (source of the inlined copy)
data/sources.json        every source: URLs, POST bodies, field names, fallbacks
data/makam-short-end.csv 1–12m snapshot, the fallback if the live pull is refused
test/test-refresh.mjs     48 · parsers, dispatch, injection
test/test-wide.mjs        32 · wide tables, scaling, .xls round-trip, timezones
test/test-json-rows.mjs   29 · JSON listing → curve points, price→yield, live TASE shape
test/test-merge.mjs       13 · governs, splice artefacts, ownership
test/test-xls-lite.mjs     9 · reader vs SheetJS (needs the real workbooks at the root)
.github/workflows/       refresh.yml (cron), test.yml (push/PR)
```

`npm run serve` matters for local work: `file://` cannot fetch `./curve.json`, so
the page silently falls back to its baked-in curve. Serving over HTTP is the only
way to exercise the real path.
