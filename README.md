# Forward Mortgage Anchor Calculator

What would the same Israeli mortgage track cost if you took it out later? This
reads the market-implied answer off the Bank of Israel government bond
zero-coupon curve, using the forward-rate identity, and reports the projected
**anchor** (עוגן) at each horizon.

**Live page → https://itawinter.github.io/mortgage-anchor-forecast/**

The curve refreshes itself. A scheduled job pulls the Bank of Israel tables,
rebuilds `curve.json`, and commits it; Pages redeploys on that commit and the
page picks it up on the next load. No download, no upload, no rebuild.

---

## How the automation works

```
.github/workflows/refresh.yml     weekdays 04:00 UTC (07:00 Israel)
        │
        ├─ node refresh-curve.mjs --config sources.json
        │        │
        │        ├─ shcd08_e.xls          nominal zero curve, 1y–15y
        │        ├─ shcd07_e.xls          real (Galil) zero curve, 1y–20y
        │        └─ TASE t_bills API      Makam short end, live · falls back
        │                                 to makam-short-end.csv
        │
        ├─ sanity-check the result   both legs present? short end? long end?
        │                            rates inside -5..25%?
        │
        └─ commit curve.json only if it changed and passed
                │
                └─ GitHub Pages redeploys → index.html fetches ./curve.json
```

Same-origin, so no CORS is involved — which is the whole reason this shape is
needed. A browser cannot fetch `boi.org.il` or `market.tase.co.il` directly:
those servers do not send `Access-Control-Allow-Origin`, so the data has to be
re-served from your own origin. That is what the commit does.

**Every source lives in `sources.json`** — URLs, request bodies, field names, in
one file read by both the scheduled job and `npm run refresh`. A URL that moves
is fixed once.

**Order matters in that file.** Later sources win a shared maturity, so Makam is
listed last and owns the short end. Reversing it silently changes the attribution
of every maturity the two sources share. Where two sources quote *different*
maturities either side of a join, winning the collision is not enough — a source
declares the span it governs instead. See *The 1y splice* below; getting this
wrong put 14bp of pure artifact into the 12-month projection.

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
- **`Accept-Language` is what the WAF checks.** Without that header the endpoint
  answers `403` to an otherwise identical request. The other headers in
  `sources.json` (Origin, Referer, a browser UA) are also required.
- **The JSON has what the visible table lacks.** The rendered table shows a price
  and no yield or redemption date, which makes a price→yield conversion look
  mandatory. The payload behind it carries `BrutoYield`, `RedemptionDate` **and**
  `DaysUntilRedemption`.

**Yield and day count are both taken from TASE, not derived.** They were computed
there at the same instant, so they agree with each other. Deriving the tenor from
`RedemptionDate` instead means guessing which day TASE measured from, and at the
front of the curve one day of day-count error is worth about **90bp** — the
shortest bill on any given day is a few days from redemption, where the
annualisation multiplier is enormous. The price→yield path is still implemented
(`--json-price`, `y = (par/price)^(1/T) − 1`) and agrees with the published yield
to ~1bp over the same day count; `test-json-rows.mjs` asserts that agreement, so
the two readings cannot drift apart unnoticed.

**Cross-checked before being trusted:** the 186-day bill priced at 98.37 reads
3.27% live, against 3.29% at 6m in the `makam.xlsx` snapshot from the day before —
2bp, across two publishers and two observation dates.

**If TASE refuses, the snapshot is used.** The Makam source declares
`fallback: makam-short-end.csv`, so a WAF that blocks the CI runner leaves the
short end stale rather than killing the job. `falling back to …` in the Actions
log is the signal that the live pull stopped working; it will not turn the run
red, so watch for it.

The page itself warns when the two BOI curves have gone stale, using the
published release calendar — so a broken refresh surfaces on the page, not just
in the Actions log. Makam is exempt: it is daily, on no such schedule.

### The 1y splice, and why a source declares what it governs

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

`test-merge.mjs` pins both halves of this, including an assertion that the
un-governed merge *does* produce the inflated delta, so the artifact cannot come
back unnoticed.

## Local use

```bash
npm install
npm run refresh          # pull the curves from sources.json, rewrite curve.json
npm run refresh:offline  # same, but the Makam snapshot instead of the live API
npm run serve            # http://localhost:8080
npm test                 # parser, injection and mapping tests
```

`npm run serve` matters: opening `index.html` from the filesystem works, but the
`file://` protocol cannot fetch `./curve.json`, so the page falls back to its
baked-in curve. Serving it over HTTP is what exercises the real path.

## What is in here

| File | |
|---|---|
| `index.html` | the calculator — one self-contained file, no build step, no dependencies |
| `curve.json` | the current curve, rewritten by the scheduled job |
| `sources.json` | every source, URL, request body and field name — the one place they are declared |
| `makam-short-end.csv` | the 1–12m short end as of 2026-07-30, the fallback if the live pull is refused |
| `refresh-curve.mjs` | fetches and parses the sources, merges them, writes `curve.json` |
| `xls-lite.mjs` | dependency-free `.xls`/`.xlsx` reader; inlined into the page so it can read a workbook you drop on it |
| `test-*.mjs` | 122 assertions over the parsers, the injector, the merge rules and the workbook reader |

The page also still accepts files by hand — one button per series in the **Zero
curve** panel — which is how you check a new release before the job runs, or
recover if a source moves.

## Setup, once

GitHub Pages needs enabling: **Settings → Pages → Source: Deploy from a branch →
`main` / `/ (root)`**. The refresh job needs no secrets; it uses the built-in
`GITHUB_TOKEN`, which `permissions: contents: write` in the workflow grants.

## Method, briefly

A zero-coupon curve `z(t)` prices money to every maturity today. Two points on
it pin down the rate the market is implicitly quoting for a loan that *starts*
at `T` and runs for `L` years — no-arbitrage forces it:

```
f(T, L) = [ (1 + z(T+L))^(T+L) / (1 + z(T))^T ]^(1/L) − 1
```

For a variable track the anchor at each reset is a government yield for a term
equal to the reset interval, so the anchor expected `N` months out is
`f(N/12, L/12)`. At `N = 0` this collapses to the spot rate, which is why the
table's first row is today.

**A forward rate is a price, not a forecast.** It embeds a term premium, so in
an upward-sloping curve forwards sit systematically above the average outcome
that materialises. The page shows a raw and an adjusted column for exactly that
reason, and the full write-up is in its Method section. Nothing here is
financial advice.
