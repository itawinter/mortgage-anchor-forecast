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
        ├─ node refresh-curve.mjs --url <shcd08> --real --url <shcd07>
        │                         --nominal --file makam-short-end.csv
        │
        ├─ sanity-check the result   both legs present? short end? long end?
        │                            rates inside -5..25%?
        │
        └─ commit curve.json only if it changed and passed
                │
                └─ GitHub Pages redeploys → index.html fetches ./curve.json
```

Same-origin, so no CORS is involved — which is the whole reason this shape is
needed. A browser cannot fetch `boi.org.il` directly: those servers do not send
`Access-Control-Allow-Origin`, so the data has to be re-served from your own
origin. That is what the commit does.

**Order matters in that command.** Later sources win a shared maturity, so Makam
is listed last and owns the 1y overlap, where it reads 3.28% against shcd08's
3.21%. Reversing it silently changes the 1y point and the attribution of the
whole short end.

**A partial pull is the dangerous case**, not a total failure. If only one leg
parsed, a file would still be written and would drop a curve the page needs — so
the workflow validates before `curve.json` is replaced, and commits nothing if
the check fails. The run goes red instead.

## Two things are not yet wired, and both are visible

**1. The BOI URLs are inferred, not verified.** This was built in a sandbox that
could not reach `boi.org.il`, so `shcd07_e.xls`'s URL is taken by symmetry from
`shcd08_e.xls`'s. If either is wrong the refresh job **fails loudly** — the
refresher exits non-zero when a source will not parse — and nothing is
committed. Fix it in one place, `env:` in `refresh.yml`.

Watch the first scheduled run (or trigger it from the Actions tab). Green means
both URLs are right.

**2. The Makam short end is a snapshot, not a live pull.** `makam-short-end.csv`
holds the 1–12 month yields as of 2026-07-30. It is re-read every run, so those
points never change until you replace them.

To make it live, swap one line in `refresh.yml`:

```yaml
  --nominal --file makam-short-end.csv        # ← replace this
  --nominal --url "<endpoint>" --json-matures <field> --json-price <field>
```

Bear in mind what the TASE T-bill table actually contains: **prices, not
yields**, and **no redemption date column**. A Makam is a zero-coupon bill
redeemed at par, so the rate is computed exactly — `y = (par/price)^(1/T) − 1`,
which is `--json-price`. But the redemption date cannot be approximated: the
same 98.37 price implies **3.314%** redeeming 1 February and **2.884%**
redeeming 28 February, a **43bp** spread across one month. Take the date from a
real date field, not by decoding the month out of the security name.

The page itself warns when the two BOI curves have gone stale, using the
published release calendar — so a broken refresh surfaces on the page, not just
in the Actions log.

## Local use

```bash
npm install
npm run refresh     # pull the curves, rewrite curve.json
npm run serve       # http://localhost:8080
npm test            # parser, injection and mapping tests
```

`npm run serve` matters: opening `index.html` from the filesystem works, but the
`file://` protocol cannot fetch `./curve.json`, so the page falls back to its
baked-in curve. Serving it over HTTP is what exercises the real path.

## What is in here

| File | |
|---|---|
| `index.html` | the calculator — one self-contained file, no build step, no dependencies |
| `curve.json` | the current curve, rewritten by the scheduled job |
| `makam-short-end.csv` | the 1–12m short end, a snapshot pending a live endpoint |
| `refresh-curve.mjs` | fetches and parses the sources, merges them, writes `curve.json` |
| `xls-lite.mjs` | dependency-free `.xls`/`.xlsx` reader; inlined into the page so it can read a workbook you drop on it |
| `test-*.mjs` | 89 assertions over the parsers, the injector and the workbook reader |

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
