# Forward Mortgage Anchor Calculator

### 👉 [Open the calculator](https://itawinter.github.io/mortgage-anchor-forecast/)

**What would your Israeli mortgage cost if you took the same track out later?**

Israeli variable-rate mortgages re-read their interest **anchor** (עוגן) from
government bond yields at every reset. This page works out what the bond market
is currently pricing that anchor to be at each future reset — 1 month out, 12
months out, three years out — and what your monthly payment would be at each.

It is not a prediction. It is the rate the market will let you lock in today,
read off the Bank of Israel yield curve.

## What you get

- **Your anchor at every horizon**, for the five common tracks: variable and
  fixed, linked and unlinked, plus prime.
- **A monthly payment** at each projected rate, on your balance and remaining
  term.
- **Two readings side by side** — the raw market forward, and an *adjusted*
  figure with the term premium stripped out. The honest answer usually sits
  between them, and the gap tells you how much of the projection is premium
  rather than expectation.
- **The curve it all came from**, plotted, with each data source in its own
  colour so you can see exactly what went in.

## Using it

Three inputs: your **track**, the **term it prices off** (reset interval for a
variable track, mortgage term for a fixed one), and your **current anchor** as
your bank quotes it. Everything else already has a sensible default.

Leave *Anchor to contract* on and the projection starts from your actual
contract rate rather than the theoretical curve rate — banks read anchors off a
trailing average, so the two are rarely identical.

## A word on what this is

A forward rate is a **price, not a forecast**. It includes a term premium, so in
an upward-sloping curve forwards sit systematically above the average outcome
that actually materialises. Read these as the market-implied path, not as a
prediction of Bank of Israel policy.

The page is honest about its data. Where two sources meet, it says so. Where the
curve is held flat past the last real maturity, it draws a dashed line and says
"not data". If the Bank of Israel has published newer figures than the page is
using, it tells you.

**Nothing here is financial advice.**

The page has a **Method** section with the full write-up — the forward-rate
identity it uses, how calibration works, and what each term-premium adjustment
actually subtracts.

## The data

Everything comes from published sources, and the page refreshes itself:

| | |
|---|---|
| Government bond curve | Bank of Israel zero-coupon yield curve estimation, nominal and CPI-linked (Galil) |
| Short end, 1–12 months | Makam (central bank bills), live from the Tel Aviv Stock Exchange |
| Refreshed | weekdays, automatically — each source's own observation date is shown on the page |

Each leg carries its own date rather than one date for the page, because they are
observed on different days and a single date would misstate the older one.

## Running it yourself

No build step, no framework, no runtime dependencies — the calculator is one
self-contained HTML file.

```bash
npm install
npm run refresh   # pull the latest curves, rewrite curve.json
npm run serve     # http://localhost:8080
npm test          # 122 assertions
```

You can also just open the page and **drop a Bank of Israel workbook, a CSV, or a
`curve.json` onto it** — it reads `.xls` and `.xlsx` in the browser with no
tooling at all, which is how you check a new release before the job runs.

For how the pipeline works, the TASE endpoint, and the decisions behind the
merge → **[docs/pipeline.md](docs/pipeline.md)**.
