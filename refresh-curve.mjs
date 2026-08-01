#!/usr/bin/env node
/**
 * refresh-curve.mjs — pull the Israeli government zero-coupon curve and feed it
 * to the Forward Mortgage Anchor Calculator.
 *
 * Writes curve.json (which the page auto-loads when served from the same origin)
 * and optionally rewrites the page's built-in defaults with --inject.
 *
 * Default source is the Bank of Israel curve workbook:
 *   https://www.boi.org.il/boi_files/Statistics/shcd08_e.xls   (_h = Hebrew)
 * a WIDE table — one row per date, one column per maturity, most recent row
 * last. Reading .xls needs SheetJS:  npm i xlsx
 *
 * BOI also serves its series database over SDMX, if you prefer CSV/JSON:
 *   https://edge.boi.org.il/FusionEdgeServer/sdmx/v2/data/dataflow/BOI.STATISTICS/<FLOW>/1.0/?...
 * with format=csv | sdmx-json | xml | excel-series | excel-table, and
 * lastNObservations=N to take only the most recent points.
 *
 * Usage
 *   node refresh-curve.mjs                      # fetch the BOI workbook
 *   node refresh-curve.mjs --dump               # show the layout, parse nothing
 *   node refresh-curve.mjs --file shcd08_e.xls --verbose
 *   node refresh-curve.mjs --config curve-sources.json
 *
 *   --boi                  add the BOI workbook as a source explicitly
 *   --real                 treat the following sources as the CPI-linked (Galil) curve
 *   --dump                 print each sheet's first/last rows and exit
 *   --sheet <name|idx>     read only this sheet
 *   --layout wide|long     force the table orientation instead of auto-detecting
 *   --date <text>          take the row whose first cell contains this
 *   --row <n>              take this data row (1-based; negative counts from end)
 *   --tenor-col <name|idx> override tenor column detection (long tables)
 *   --value-col <name|idx> override value column detection (long tables)
 *   --tenor <years>        the source is a single tenor's series; label it this
 *   --json-path <a.b>      dig to the array of records in a JSON response
 *   --json-value <field>   the yield field on each record
 *   --json-tenor <field>   the maturity field, if the feed quotes one
 *   --json-matures <field> a REDEMPTION DATE field; tenor is computed from it
 *   --json-asof <field>    the observation date field (else today)
 *   --json-price <field>   the field is a PRICE per par, not a yield; the zero
 *                          rate is computed as (par/price)^(1/T) - 1
 *   --par <n>              par for --json-price (default 100)
 *   --inject <file.html>   also rewrite DEFAULT_NOMINAL / DEFAULT_REAL in the page
 *   --out <file.json>      output path (default ./curve.json)
 *   --verbose              print what was actually parsed, for diagnosis
 *
 * If auto-detection misreads the workbook, --dump shows exactly what is in it;
 * --layout / --sheet / --row pin it down without code changes.
 *
 * curve-sources.json:
 *   { "asOf": "auto",
 *     "nominal": [ {"url": "...", "tenor": 0.25}, {"url": "...", "tenor": 1} ],
 *     "real":    [ {"file": "galil.csv"} ] }
 */

import fs from "node:fs";
import path from "node:path";

/** BOI zero-coupon curve workbook. shcd08_h.xls is the same table in Hebrew. */
export const BOI_NOMINAL_XLS = "https://www.boi.org.il/boi_files/Statistics/shcd08_e.xls";

/* ---------------------------------------------------------------- CSV ---- */

/** RFC4180-ish split on one delimiter: honours quotes, doubled quotes, CRLF. */
function splitWith(src, delim) {
  const rows = [];
  let row = [], field = "", q = false;

  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (q) {
      if (c === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; }
        else q = false;
      } else field += c;
      continue;
    }
    if (c === '"') { q = true; continue; }
    if (c === delim) { row.push(field); field = ""; continue; }
    if (c === "\n" || c === "\r") {
      if (c === "\r" && src[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.some(v => v.trim() !== "")) rows.push(row);
      row = [];
      continue;
    }
    field += c;
  }
  row.push(field);
  if (row.some(v => v.trim() !== "")) rows.push(row);
  return rows;
}

/**
 * Parse CSV/TSV, choosing the delimiter by how CONSISTENT a column count it
 * produces — not by raw frequency. European exports (";" delimiter, decimal
 * commas) contain more commas than semicolons, so counting characters picks the
 * wrong one and silently shreds every value.
 */
export function parseDelimited(text) {
  const src = text.replace(/^﻿/, "");
  let best = null;
  for (const d of [",", ";", "\t", "|"]) {
    const rows = splitWith(src, d);
    if (!rows.length) continue;
    const counts = rows.map(r => r.length);
    const tally = new Map();
    for (const c of counts) tally.set(c, (tally.get(c) || 0) + 1);
    let modal = 0, modalHits = 0;
    for (const [c, n] of tally) if (n > modalHits || (n === modalHits && c > modal)) { modal = c; modalHits = n; }
    if (modal < 2) continue;                       // a single column means "not this delimiter"
    const score = modalHits * 1000 + modal;
    if (!best || score > best.score) best = { score, rows };
  }
  const rows = best ? best.rows : splitWith(src, ",");
  // Drop "#" comment lines. Data exports routinely carry a provenance header,
  // and a comment containing a comma otherwise parses as a two-column header row
  // and outscores the real one.
  return rows.filter(r => !String(r[0] ?? "").trim().startsWith("#"));
}

/* -------------------------------------------------------------- tenors ---- */

/**
 * Read a maturity into years. Handles "18M", "1.5", "1Y", "3 months",
 * "10 שנים", "6 חודשים", "P18M" (ISO 8601), "TENOR_18M", "M001|1 month".
 * Returns null when the string carries no maturity.
 *
 * opts.strict — for scanning candidate header rows. A bare number above 40 is
 * REJECTED rather than guessed as months. Without that, BOI's series-database
 * export turns "DWH_SRC_0340" into "340 months = 28.3 years", and a metadata row
 * outscores the row that actually holds the maturities.
 */
export function parseTenor(raw, opts = {}) {
  if (raw == null) return null;
  if (raw instanceof Date) return null;              // a date is never a maturity
  const s = String(raw).trim().toLowerCase();
  if (!s) return null;

  // "31/07/2026" would otherwise read as 31 years and quietly poison a curve.
  // Two-group forms must NOT accept "." as a separator: "0.25" is a maturity,
  // not a date, and treating it as one silently drops the short end.
  if (/^\d{1,4}[-/.]\d{1,4}[-/.]\d{1,4}$/.test(s)) return null;     // 31/07/2026, 2026-07-31
  if (/^\d{1,2}\/\d{2,4}$/.test(s)) return null;                    // 07/2026
  if (/^\d{1,2}-\d{4}$/.test(s) || /^\d{4}-\d{1,2}$/.test(s)) return null;
  if (/^[a-z]{3}\s+\w{3}\s+\d{1,2}\s+\d{4}/.test(s)) return null;   // Date.toString()

  // SDMX cells are "CODE|Human label". The code carries arbitrary digits, so read
  // the label instead — and require an explicit unit there, because a stray
  // number ("maturity in month 1") is not a maturity worth guessing at.
  if (s.includes("|")) {
    const label = s.slice(s.lastIndexOf("|") + 1).trim();
    return label ? readTenor(label, { requireUnit: true }) : null;
  }
  return readTenor(s, { strict: !!opts.strict });
}

function readTenor(s, o) {
  const iso = s.match(/^p(?:(\d+(?:\.\d+)?)y)?(?:(\d+(?:\.\d+)?)m)?$/);   // P18M, P2Y6M
  if (iso && (iso[1] || iso[2])) {
    return (parseFloat(iso[1] || 0)) + (parseFloat(iso[2] || 0)) / 12;
  }
  s = s.replace(/^(tenor|maturity|term|mat)[_\-\s:]*/, "");

  const hebMonth = /חוד/.test(s), hebYear = /שנ/.test(s);
  const num = s.match(/-?\d+(?:[.,]\d+)?/);
  if (!num) return null;
  const v = parseFloat(num[0].replace(",", "."));
  if (!Number.isFinite(v)) return null;

  if (hebMonth) return v / 12;
  if (hebYear) return v;

  // Accept "1-month" and "1 month" as well as "1m".
  const rest = s.slice(num.index + num[0].length).replace(/^[-\s]+/, "");
  if (/^(m|mo|mon|month|months|mths?)\b/.test(rest)) return v / 12;
  if (/^(y|yr|yrs|year|years)\b/.test(rest)) return v;
  if (/^(d|day|days)\b/.test(rest)) return v / 365;
  if (/^(w|wk|week|weeks)\b/.test(rest)) return v / 52;

  if (o.requireUnit) return null;
  if (o.strict) return (v > 0 && v <= 40) ? v : null;
  return v > 40 ? v / 12 : v;      // a bare "120" from hand-typed input is months
}

/** Read a percentage value; tolerates "3.40%", "3,40", "(0.5)". */
export function parseRate(raw) {
  if (raw == null) return null;
  let s = String(raw).trim();
  if (!s || /^(na|n\/a|-|\.\.|null)$/i.test(s)) return null;
  let neg = false;
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
  s = s.replace(/%/g, "").replace(/\s/g, "");
  // 3,40 (decimal comma) vs 1,234.5 (thousands)
  if (/,\d{1,2}$/.test(s) && !/\./.test(s)) s = s.replace(",", ".");
  else s = s.replace(/,/g, "");
  const v = parseFloat(s);
  if (!Number.isFinite(v)) return null;
  return neg ? -v : v;
}

const TENOR_HINTS = [
  "tenor", "maturity", "term", "years", "year", "yrs", "period", "horizon",
  "duration", "mat", "לפדיון", "טווח", "תקופה", "שנים"
];
const VALUE_HINTS = [
  "value", "rate", "yield", "obs_value", "obsvalue", "zero", "return",
  "תשואה", "ריבית", "שיעור"
];
const DATE_HINTS = ["date", "time_period", "timeperiod", "period", "תאריך"];

function scoreHeader(name, hints) {
  const n = String(name).trim().toLowerCase();
  let best = 0;
  for (const hint of hints) {
    if (n === hint) return 100;
    if (n.includes(hint)) best = Math.max(best, 60);
  }
  return best;
}

/**
 * Turn parsed rows into [[years, pct], ...].
 *
 * Two shapes are supported:
 *  - wide/long table with a maturity column and a value column
 *  - a single-tenor time series (pass opts.tenor); the latest date wins
 */
export function rowsToCurve(rows, opts = {}) {
  if (!rows.length) return { points: [], diag: { reason: "no rows" } };

  const header = rows[0].map(h => String(h).trim());
  const looksHeader = header.some(h => /[a-zא-ת]/i.test(h));
  const body = looksHeader ? rows.slice(1) : rows;
  const diag = { header: looksHeader ? header : null, rows: body.length };

  const pick = (override, hints) => {
    if (override != null && override !== "") {
      const asIdx = Number(override);
      if (Number.isInteger(asIdx) && String(asIdx) === String(override)) return asIdx;
      const i = header.findIndex(h => h.toLowerCase() === String(override).toLowerCase());
      if (i >= 0) return i;
      throw new Error(`column "${override}" not found in: ${header.join(", ")}`);
    }
    if (!looksHeader) return -1;
    let bi = -1, bs = 0;
    header.forEach((h, i) => { const s = scoreHeader(h, hints); if (s > bs) { bs = s; bi = i; } });
    return bs > 0 ? bi : -1;
  };

  let ti = pick(opts.tenorCol, TENOR_HINTS);
  let vi = pick(opts.valueCol, VALUE_HINTS);
  const di = pick(null, DATE_HINTS);

  // Single-tenor series: no maturity column, caller supplies the tenor.
  if (opts.tenor != null && (ti < 0 || ti === di)) {
    if (vi < 0) vi = lastNumericColumn(body);
    const dated = body
      .map(r => ({ d: di >= 0 ? String(r[di] || "").trim() : "", v: parseRate(r[vi]) }))
      .filter(x => x.v != null);
    if (!dated.length) return { points: [], diag: { ...diag, reason: "no numeric values" } };
    dated.sort((a, b) => a.d < b.d ? -1 : a.d > b.d ? 1 : 0);
    const latest = dated[dated.length - 1];
    return {
      points: [[Number(opts.tenor), latest.v]],
      diag: { ...diag, mode: "single-tenor", tenor: Number(opts.tenor), date: latest.d, valueCol: vi }
    };
  }

  if (ti < 0) {
    // Fall back to positional: first column tenor-ish, last numeric column value.
    const cand = body.find(r => parseTenor(r[0]) != null);
    if (cand) ti = 0;
  }
  if (vi < 0) vi = lastNumericColumn(body);
  if (ti < 0 || vi < 0 || ti === vi) {
    return { points: [], diag: { ...diag, reason: "could not identify tenor/value columns", ti, vi } };
  }

  // If the table carries dates, keep only the most recent observation date.
  let use = body;
  let asOf = null;
  if (di >= 0 && di !== ti) {
    const dates = [...new Set(body.map(r => String(r[di] || "").trim()).filter(Boolean))].sort();
    if (dates.length > 1) {
      asOf = dates[dates.length - 1];
      use = body.filter(r => String(r[di] || "").trim() === asOf);
    } else if (dates.length === 1) asOf = dates[0];
  }

  const byTenor = new Map();
  for (const r of use) {
    const t = parseTenor(r[ti]);
    const v = parseRate(r[vi]);
    if (t == null || v == null || !(t > 0)) continue;
    byTenor.set(t, v);              // later rows win
  }
  const points = [...byTenor.entries()].sort((a, b) => a[0] - b[0]);
  // Wide mode reports the span it read; report it here too, or a long-format
  // source shows a blank range in the page's provenance table.
  const range = points.length
    ? `${points[0][0]}y..${points[points.length - 1][0]}y` : null;
  return { points, diag: { ...diag, mode: "table", tenorCol: ti, valueCol: vi, asOf, range, kept: points.length } };
}

function lastNumericColumn(body) {
  const width = Math.max(...body.map(r => r.length));
  for (let i = width - 1; i >= 0; i--) {
    const hits = body.filter(r => parseRate(r[i]) != null).length;
    if (hits >= Math.max(1, Math.floor(body.length * 0.5))) return i;
  }
  return -1;
}

/* ------------------------------------------------------- wide tables ---- */

/**
 * Parse a WIDE curve table: one row per observation date, one column per
 * maturity. This is the shape of the Bank of Israel workbook
 * (Statistics/shcd08_e.xls), where the last row is the most recent date.
 *
 *        A          B      C      D            <- header row: maturities
 *   1 | Date      | 0.25 | 0.5  | 1   | ...
 *   2 | 01/07/26  | 3.38 | 3.29 | 3.22| ...
 *   n | 31/07/26  | 3.40 | 3.30 | 3.25| ...    <- taken by default
 *
 * opts.row    pick a data row explicitly (1-based; negative counts from the end)
 * opts.date   pick the row whose first cell contains this string
 */
export function rowsToCurveWide(rows, opts = {}) {
  if (!rows.length) return { points: [], diag: { reason: "no rows" } };

  // Header row = the row with the most DISTINCT maturities (min 3), read in
  // strict mode. Distinctness matters: BOI's export has metadata rows repeating
  // one code across every column ("B08|Central bank bills") which would
  // otherwise tie with the real maturity row on raw count.
  let hi = -1, best = 0, colTenor = null;
  const scanTo = Math.min(rows.length, 40);
  for (let i = 0; i < scanTo; i++) {
    const map = new Map();
    for (let c = 0; c < rows[i].length; c++) {
      const t = parseTenor(rows[i][c], { strict: true });
      if (t != null && t > 0 && t <= 50) map.set(c, t);
    }
    const distinct = new Set(map.values()).size;
    if (distinct > best) { best = distinct; hi = i; colTenor = map; }
  }
  if (hi < 0 || best < 3) {
    return { points: [], diag: { reason: `no header row with >=3 distinct maturities (best ${best})` } };
  }

  // Ascending maturities are a strong signal we read a header, not a data row.
  const tenors = [...colTenor.values()];
  const ascending = tenors.every((v, i) => i === 0 || v > tenors[i - 1]);

  const body = rows.slice(hi + 1);
  const usable = [];
  for (let i = 0; i < body.length; i++) {
    const r = body[i];
    let n = 0;
    for (const c of colTenor.keys()) if (parseRate(r[c]) != null) n++;
    if (n >= Math.max(2, Math.ceil(colTenor.size * 0.4))) usable.push({ i, r, n });
  }
  if (!usable.length) return { points: [], diag: { reason: "no data rows under the header", headerRow: hi + 1 } };

  // The date is not always in column A — BOI's series export puts it in B — so
  // look across every cell left of the first maturity column.
  const firstMat = Math.min(...colTenor.keys());
  const dateOf = r => {
    for (let c = 0; c < firstMat; c++) {
      const st = stampOf(r[c]);
      if (/^\d{4}-\d{2}-\d{2}$/.test(st)) return st;
    }
    return "";
  };

  let chosen;
  if (opts.date) {
    const want = String(opts.date).trim();
    chosen = usable.find(u => String(u.r[0] ?? "").includes(want)) ||
             usable.find(u => dateOf(u.r).includes(want));
    if (!chosen) return { points: [], diag: { reason: `no row matching date "${want}"`, rows: usable.length } };
  } else if (opts.row != null) {
    const k = Number(opts.row);
    chosen = k < 0 ? usable[usable.length + k] : usable[k - 1];
    if (!chosen) return { points: [], diag: { reason: `row ${k} out of range (1..${usable.length})` } };
  } else {
    chosen = usable[usable.length - 1];          // most recent
  }

  const points = [];
  for (const [c, t] of colTenor) {
    const v = parseRate(chosen.r[c]);
    if (v != null) points.push([t, v]);
  }
  points.sort((a, b) => a[0] - b[0]);

  // Label cells left of the first maturity column — BOI's workbook carries an
  // "Average type" (Calendar / CPI-dated) there, and which one you got matters.
  const label = chosen.r.slice(0, firstMat)
    .map(c => (c instanceof Date ? stampOf(c) : String(c ?? "").trim()))
    .filter(Boolean).join(" / ");

  return {
    points,
    diag: {
      mode: "wide", headerRow: hi + 1, ascendingHeader: ascending,
      maturityCols: colTenor.size, dataRows: usable.length,
      pickedRow: hi + 2 + chosen.i, asOf: dateOf(chosen.r),
      rowLabel: label || null,
      range: `${Math.min(...colTenor.values())}y..${Math.max(...colTenor.values())}y`,
      kept: points.length
    }
  };
}

/** Render whatever is in a date cell as YYYY-MM-DD when possible. */
function stampOf(cell) {
  if (cell == null) return "";
  if (cell instanceof Date && !isNaN(cell)) return cell.toISOString().slice(0, 10);
  const s = String(cell).trim();
  const dmy = s.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})$/);
  if (dmy) {
    let y = dmy[3];
    if (y.length === 2) y = (Number(y) > 70 ? "19" : "20") + y;
    return `${y}-${dmy[2].padStart(2, "0")}-${dmy[1].padStart(2, "0")}`;
  }
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  return s;
}

/**
 * Percent vs fraction. The page treats every rate as a percent, so a curve
 * stored as 0.034 must be scaled or the mortgage output is wrong by 100x.
 */
export function normaliseScale(points) {
  if (!points.length) return { points, note: null };
  const vals = points.map(p => p[1]).filter(v => Number.isFinite(v) && v !== 0);
  if (!vals.length) return { points, note: null };
  const max = Math.max(...vals.map(Math.abs));
  if (max > 0 && max < 0.25) {
    // Round after scaling: 0.034 * 100 is 3.4000000000000004 in binary floating point.
    return {
      points: points.map(([t, r]) => [t, Math.round(r * 100 * 1e6) / 1e6]),
      note: "values looked like fractions; scaled by 100"
    };
  }
  if (max > 40) return { points, note: `WARNING: max rate ${max} looks too large to be a percent` };
  return { points, note: null };
}

/* ----------------------------------------------------- spreadsheets ---- */

let XLSX = null;
async function loadXlsx() {
  if (XLSX) return XLSX;
  try { XLSX = (await import("xlsx")).default ?? (await import("xlsx")); }
  catch {
    throw new Error("reading .xls/.xlsx needs SheetJS — run:  npm i xlsx");
  }
  return XLSX;
}

/**
 * SheetJS builds date cells in LOCAL time; xls-lite builds them in UTC, and
 * stampOf reads both with toISOString(). East of UTC the two disagree by a day:
 * a midnight serial for 2026-07-15 came back as 2026-07-14 in Asia/Jerusalem —
 * the timezone this project is read from. Re-anchor the wall-clock components to
 * UTC at the reader boundary so every date cell means the same day everywhere.
 *
 * Apply this to SheetJS output only. xls-lite is already UTC; re-anchoring it
 * would introduce the very shift this removes.
 */
export function localDateToUTC(v) {
  if (!(v instanceof Date) || isNaN(v)) return v;
  return new Date(Date.UTC(
    v.getFullYear(), v.getMonth(), v.getDate(),
    v.getHours(), v.getMinutes(), v.getSeconds(), v.getMilliseconds()));
}

/** Workbook buffer -> [{name, rows}] with rows as arrays of raw cell values. */
export async function readSpreadsheet(buf) {
  const X = await loadXlsx();
  const wb = X.read(buf, { type: "buffer", cellDates: true, cellNF: false, cellText: false });
  return wb.SheetNames.map(name => ({
    name,
    rows: X.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: true, defval: null, blankrows: false })
      .map(row => row.map(localDateToUTC))
  }));
}

function dumpSheets(sheets) {
  for (const { name, rows } of sheets) {
    const width = Math.max(0, ...rows.map(r => r.length));
    console.log(`\n--- sheet "${name}"  ${rows.length} rows x ${width} cols ---`);
    const show = i => {
      const r = rows[i] || [];
      const cells = r.slice(0, 14).map(c =>
        c instanceof Date ? c.toISOString().slice(0, 10) : String(c ?? "").slice(0, 14));
      console.log(String(i + 1).padStart(5) + " | " + cells.join(" | ") + (r.length > 14 ? " | …" : ""));
    };
    for (let i = 0; i < Math.min(14, rows.length); i++) show(i);
    if (rows.length > 17) { console.log("      …"); for (let i = Math.max(14, rows.length - 3); i < rows.length; i++) show(i); }
  }
}

/* ---------------------------------------------------------- SDMX-JSON ---- */

/**
 * Extract [[years, pct], ...] from an SDMX-JSON 2.1/2.0 message by locating a
 * series dimension whose values parse as maturities.
 */
export function parseSdmxJson(obj, opts = {}) {
  const ds = obj?.data?.dataSets?.[0] || obj?.dataSets?.[0];
  const structRoot = obj?.data?.structures?.[0] || obj?.data?.structure || obj?.structure;
  if (!ds || !structRoot) return { points: [], diag: { reason: "not SDMX-JSON" } };

  const sDims = structRoot?.dimensions?.series || [];
  const oDims = structRoot?.dimensions?.observation || [];

  let ti = -1;
  sDims.forEach((d, i) => {
    if (ti >= 0) return;
    const vals = (d.values || []).map(v => v.id ?? v.name);
    const ok = vals.filter(v => parseTenor(v) != null).length;
    if (vals.length && ok === vals.length) ti = i;
  });

  const series = ds.series || {};
  const keys = Object.keys(series);
  if (!keys.length) return { points: [], diag: { reason: "no series in dataSet" } };

  // Latest observation index, so we read one date across all tenors.
  const obsVals = (oDims[0]?.values || []).map(v => v.id ?? v.name);

  const byTenor = new Map();
  let asOf = null;
  for (const key of keys) {
    const idx = key.split(":").map(Number);
    let tenor = null;
    if (ti >= 0) {
      const dv = sDims[ti]?.values?.[idx[ti]];
      tenor = parseTenor(dv?.id ?? dv?.name);
    } else if (opts.tenor != null) tenor = Number(opts.tenor);
    if (tenor == null || !(tenor > 0)) continue;

    const obs = series[key].observations || {};
    const oKeys = Object.keys(obs).map(Number).sort((a, b) => a - b);
    if (!oKeys.length) continue;
    const lastO = oKeys[oKeys.length - 1];
    const v = parseRate(Array.isArray(obs[lastO]) ? obs[lastO][0] : obs[lastO]);
    if (v == null) continue;
    byTenor.set(tenor, v);
    if (obsVals[lastO]) asOf = obsVals[lastO];
  }

  const points = [...byTenor.entries()].sort((a, b) => a[0] - b[0]);
  return { points, diag: { mode: "sdmx-json", tenorDim: ti >= 0 ? sDims[ti]?.id : null, asOf, kept: points.length } };
}

/* ------------------------------------------------------------- sources ---- */

/** Choose between wide and long readings of the same rows: more points wins. */
export function rowsToCurveAuto(rows, opts = {}) {
  const wide = rowsToCurveWide(rows, opts);
  if (opts.layout === "wide") return wide;
  const long = rowsToCurve(rows, opts);
  if (opts.layout === "long") return long;
  if (wide.points.length > long.points.length) return wide;
  if (long.points.length) return long;
  return wide.points.length ? wide : { points: [], diag: { wide: wide.diag, long: long.diag } };
}

export function parseSource(text, opts = {}) {
  const trimmed = text.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    let obj;
    try { obj = JSON.parse(trimmed); }
    catch (e) { return { points: [], diag: { reason: "invalid JSON: " + e.message } }; }

    // Already in our own schema?
    if (obj && (Array.isArray(obj.nominal) || Array.isArray(obj.real))) {
      return { points: null, curve: obj, diag: { mode: "curve.json passthrough" } };
    }
    // An explicit mapping wins: a securities listing has its own field names and
    // quotes bills by REDEMPTION DATE, not by tenor, so it cannot be guessed.
    if (opts.jsonValue || opts.jsonTenor || opts.jsonMatures || opts.jsonPath) {
      return parseJsonRows(obj, opts);
    }
    if (Array.isArray(obj)) {
      const pts = obj.map(r => Array.isArray(r)
          ? [parseTenor(r[0]), parseRate(r[1])]
          : [parseTenor(r.tenor ?? r.years ?? r.maturity), parseRate(r.rate ?? r.value ?? r.yield)])
        .filter(p => p[0] != null && p[1] != null && p[0] > 0)
        .sort((a, b) => a[0] - b[0]);
      return { points: pts, diag: { mode: "json array", kept: pts.length } };
    }
    return parseSdmxJson(obj, opts);
  }
  return rowsToCurveAuto(parseDelimited(text), opts);
}

/** Follow a dotted path: "d.Items", "0.rows". Returns undefined if it breaks. */
function dig(obj, path) {
  return String(path).split(".").reduce((o, k) => (o == null ? o : o[k]), obj);
}

/** The first array of objects in the response, breadth-first, for a bare --url. */
function firstArray(obj, depth = 0) {
  if (Array.isArray(obj) && obj.some(x => x && typeof x === "object")) return obj;
  if (!obj || typeof obj !== "object" || depth > 4) return null;
  for (const v of Object.values(obj)) {
    const hit = firstArray(v, depth + 1);
    if (hit) return hit;
  }
  return null;
}

const DAY = 86400000;

/** Whole years between two dates, actual/365. */
function yearsBetween(fromIso, to) {
  const a = Date.parse(fromIso), b = to instanceof Date ? to.getTime() : Date.parse(to);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return (b - a) / DAY / 365;
}

/**
 * Map an arbitrary JSON listing to curve points.
 *
 * Written for securities listings — a T-bill table quotes each bill by its
 * REDEMPTION DATE and its yield, so the maturity has to be computed rather than
 * read: `--json-matures <field>` turns a redemption date into a tenor measured
 * from the observation date. Field names are supplied rather than guessed,
 * because guessing them is how a curve ends up built from the wrong column.
 */
export function parseJsonRows(obj, o = {}) {
  const arr = o.jsonPath ? dig(obj, o.jsonPath) : firstArray(obj);
  if (!Array.isArray(arr)) {
    return { points: [], diag: { reason: o.jsonPath
      ? `no array at --json-path ${o.jsonPath}`
      : "no array of records found; pass --json-path" } };
  }

  // The observation date usually sits beside the array, not inside it: TASE
  // returns one TradeDate for the whole response and leaves the per-row field
  // null. Look at the envelope first, then a record, then give up and use today
  // — a silent fall back to today is how every tenor ends up a day out.
  const asOfField = o.jsonAsOf
    ? String(dig(obj, o.jsonAsOf) ?? dig(arr[0] || {}, o.jsonAsOf) ?? "").slice(0, 10)
    : "";
  const asOf = o.asOf || normaliseDate(asOfField) || asOfField
    || new Date().toISOString().slice(0, 10);

  const points = [], skipped = [];
  for (const row of arr) {
    if (!row || typeof row !== "object") continue;
    let t = null;
    if (o.jsonTenorDays) {
      // A listing that already carries days-to-redemption is worth preferring
      // over redemption-date arithmetic: the count and the quoted yield were
      // computed by the source at the same instant, so they agree with each
      // other. Deriving the count here instead means guessing which day the
      // source measured from, and at the front of the curve one day is ~90bp.
      const d = parseRate(dig(row, o.jsonTenorDays));
      t = d != null && d > 0 ? d / 365 : null;
    } else if (o.jsonMatures) {
      const raw = dig(row, o.jsonMatures);
      t = raw == null ? null : yearsBetween(asOf, normaliseDate(String(raw).slice(0, 10)) || raw);
    } else {
      t = parseTenor(dig(row, o.jsonTenor ?? "tenor"));
    }
    // A T-bill listing quotes a PRICE, not a yield — the TASE table has no
    // yield column at all. A Makam is a zero-coupon bill redeemed at par, so
    // the zero rate is exact rather than approximated:
    //     y = (par / price) ^ (1/T) - 1
    // annual-effective, which is the convention the page reads zero rates in.
    let r;
    if (o.jsonPrice) {
      const px = parseRate(dig(row, o.jsonPrice));
      const par = Number.isFinite(+o.par) ? +o.par : 100;
      r = (px != null && px > 0 && t > 0) ? (Math.pow(par / px, 1 / t) - 1) * 100 : null;
    } else {
      r = parseRate(dig(row, o.jsonValue ?? "rate"));
    }
    if (t == null || r == null || !(t > 0) || !Number.isFinite(r)) { skipped.push(row); continue; }
    points.push([Math.round(t * 1e6) / 1e6, Math.round(r * 1e6) / 1e6]);
  }

  // Several bills can redeem in the same month; keep the last seen, as elsewhere.
  const byT = new Map();
  for (const [t, r] of points) byT.set(t, r);
  const out = [...byT.entries()].sort((a, b) => a[0] - b[0]);
  return { points: out, diag: {
    mode: "json rows", records: arr.length, kept: out.length,
    skipped: skipped.length, asOf,
    range: out.length ? `${out[0][0]}y..${out[out.length - 1][0]}y` : null,
    tenorFrom: o.jsonTenorDays ? `days:${o.jsonTenorDays}`
      : o.jsonMatures ? `matures:${o.jsonMatures}` : `tenor:${o.jsonTenor ?? "tenor"}`,
    valueFrom: o.jsonPrice ? `price:${o.jsonPrice} -> yield` : `value:${o.jsonValue ?? "rate"}`
  } };
}

const BIN_RE = /\.(xls|xlsx|xlsm|xlsb|ods)(\?|#|$)/i;

/**
 * Fetch a source. `opts.body` switches to POST, which the TASE market API needs:
 * its securities table is a POST with a JSON filter, not a downloadable file.
 * `opts.headers` carries the Origin/Referer that API checks.
 */
async function fetchBuffer(url, opts = {}) {
  const res = await fetch(url, {
    method: opts.body != null ? "POST" : "GET",
    headers: {
      // BOI's static host rejects requests without a browser-ish UA.
      "User-Agent": "Mozilla/5.0 (compatible; forward-anchor-calculator)",
      "Accept": "application/vnd.ms-excel, application/vnd.openxmlformats-officedocument.spreadsheetml.sheet, text/csv, application/json, */*",
      ...(opts.body != null ? { "Content-Type": "application/json" } : {}),
      ...(opts.headers || {})
    },
    ...(opts.body != null ? { body: opts.body } : {}),
    redirect: "follow"
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

/** Sniff a workbook regardless of extension: XLS (OLE2) or XLSX (zip). */
function looksBinaryWorkbook(buf) {
  if (buf.length < 8) return false;
  const ole = [0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1];
  if (ole.every((b, i) => buf[i] === b)) return true;
  return buf[0] === 0x50 && buf[1] === 0x4B;                       // "PK"
}

/** Pick sheets to read: --sheet by name/index, else every sheet. */
function selectSheets(sheets, want) {
  if (want == null || want === "") return sheets;
  const idx = Number(want);
  if (Number.isInteger(idx) && String(idx) === String(want)) {
    const s = sheets[idx - 1];
    if (!s) throw new Error(`sheet ${idx} out of range (1..${sheets.length})`);
    return [s];
  }
  const s = sheets.find(x => x.name.toLowerCase() === String(want).toLowerCase()) ||
            sheets.find(x => x.name.toLowerCase().includes(String(want).toLowerCase()));
  if (!s) throw new Error(`no sheet matching "${want}" in: ${sheets.map(x => x.name).join(", ")}`);
  return [s];
}

const REAL_SHEET_RE = /real|cpi|index|linked|galil|צמוד|ריאל|גליל/i;

/* --------------------------------------------------------------- inject ---- */

const NOM_RE  = /(const\s+DEFAULT_NOMINAL\s*=\s*)\[[\s\S]*?\](\s*;)/;
const REAL_RE = /(const\s+DEFAULT_REAL\s*=\s*)\[[\s\S]*?\](\s*;)/;

export function formatPoints(points, indent = "  ") {
  const body = points.map(([t, r]) => `[${round(t)}, ${r.toFixed(2)}]`);
  const lines = [];
  for (let i = 0; i < body.length; i += 6) lines.push(indent + body.slice(i, i + 6).join(", "));
  return "[\n" + lines.join(",\n") + "\n]";
}
const round = t => Number(t.toFixed(6)).toString();

export function injectIntoHtml(html, curve) {
  let out = html, changed = [];
  if (curve.nominal?.length) {
    if (!NOM_RE.test(out)) throw new Error("DEFAULT_NOMINAL not found in page");
    out = out.replace(NOM_RE, (_m, a, b) => a + formatPoints(curve.nominal) + b);
    changed.push(`nominal (${curve.nominal.length} pts)`);
  }
  if (curve.real?.length) {
    if (!REAL_RE.test(out)) throw new Error("DEFAULT_REAL not found in page");
    out = out.replace(REAL_RE, (_m, a, b) => a + formatPoints(curve.real) + b);
    changed.push(`real (${curve.real.length} pts)`);
  }
  // The page reads dates and per-source ranges from BUILTIN_PROV, not from a
  // form field — they are properties of the files, so there is nothing to
  // hand-edit. `segs` is what the page splits the baked curve back apart by, so
  // it has to be rewritten whole.
  //
  // These are located by BALANCED SCANNING, not by regex. A lazy `[\s\S]*?\]`
  // does not stop at the array it was aimed at — it runs on to the next
  // plausible bracket and swallows whatever lies between, which silently
  // corrupts the page instead of failing.
  const legs = ["nominal", "real"].filter(l => curve[l]?.length);
  for (const leg of legs) {
    const block = legBlock(out, leg);
    if (!block) continue;
    let { from, to } = block;

    const d = curve.legAsOf?.[leg] || curve.asOf;
    if (d) {
      const seg = out.slice(from, to);
      const m = seg.match(/asOf:\s*(null|"[^"]*")/);
      if (m) {
        out = out.slice(0, from + m.index) + `asOf: ${JSON.stringify(d)}` +
              out.slice(from + m.index + m[0].length);
        to += JSON.stringify(d).length + 6 - m[0].length;
        changed.push(`${leg} date ${d}`);
      }
    }

    const segs = (curve.sources || [])
      .filter(x => x.leg === leg && Array.isArray(x.owns))
      .map(x => ({
        key: sourceKey(x.label), label: seriesTitle(x.label, leg),
        file: String(x.label).replace(/\s*\[[^\]]*\]\s*$/, ""),
        from: x.owns[0], to: x.owns[1], asOf: x.asOf || null
      }))
      .filter(x => x.key);
    if (!segs.length) continue;

    const span = arraySpan(out, "segs:", from, to);
    if (!span) continue;
    const indent = "    ";
    const body = "[\n" + segs.map(g =>
      `${indent}  { key: ${JSON.stringify(g.key)}, label: ${JSON.stringify(g.label)},\n` +
      `${indent}    file: ${JSON.stringify(g.file)}, from: ${g.from}, to: ${g.to}, ` +
      `asOf: ${JSON.stringify(g.asOf)} }`
    ).join(",\n") + `\n${indent}]`;
    out = out.slice(0, span.start) + body + out.slice(span.end);
    changed.push(`${leg} segs (${segs.length})`);
  }
  return { html: out, changed };
}

/* ----------------------------------------------------------------- main ---- */

function parseArgs(argv) {
  const o = { sources: [], out: "curve.json", verbose: false };
  let leg = "nominal";
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case "--real":      leg = "real"; break;
      case "--nominal":   leg = "nominal"; break;
      case "--url":       o.sources.push({ leg, url: next(), ...pending(o) }); break;
      case "--file":      o.sources.push({ leg, file: next(), ...pending(o) }); break;
      case "--tenor":     o._tenor = Number(next()); break;
      case "--tenor-col": o._tenorCol = next(); break;
      case "--json-path":    o._jsonPath = next(); break;
      case "--json-tenor":   o._jsonTenor = next(); break;
      case "--json-tenor-days": o._jsonTenorDays = next(); break;
      case "--json-value":   o._jsonValue = next(); break;
      case "--json-matures": o._jsonMatures = next(); break;
      case "--json-asof":    o._jsonAsOf = next(); break;
      case "--json-price":   o._jsonPrice = next(); break;
      case "--par":          o._par = next(); break;
      case "--label":       o._label = next(); break;
      case "--post":        o._body = next(); break;
      case "--header": {
        const h = next(), i = h.indexOf(":");
        if (i < 0) throw new Error(`--header wants "Name: value", got ${h}`);
        o._headers = { ...(o._headers || {}), [h.slice(0, i).trim()]: h.slice(i + 1).trim() };
        break;
      }
      case "--value-col": o._valueCol = next(); break;
      case "--sheet":     o.sheet = next(); break;
      case "--layout":    o._layout = next(); break;
      case "--date":      o._date = next(); break;
      case "--row":       o._row = next(); break;
      case "--dump":      o.dump = true; break;
      case "--boi":       o.sources.push({ leg, url: BOI_NOMINAL_XLS }); break;
      case "--config":    o.config = next(); break;
      case "--inject":    o.inject = next(); break;
      case "--out":       o.out = next(); break;
      case "--verbose": case "-v": o.verbose = true; break;
      case "--help": case "-h": o.help = true; break;
      default:
        if (a.startsWith("-")) throw new Error("unknown flag " + a);
        o.sources.push({ leg, file: a, ...pending(o) });
    }
  }

  // Per-source options normally attach to the source that FOLLOWS them, but
  // "--file x --row -1" reads just as naturally as "--row -1 --file x". Rather
  // than silently ignore a trailing flag, apply leftovers to every source.
  const leftover = pending(o);
  if (Object.keys(leftover).length) {
    for (const s of o.sources) for (const [k, v] of Object.entries(leftover)) {
      if (s[k] === undefined) s[k] = v;
    }
  }
  return o;
}
// --tenor / --tenor-col / --value-col apply to the source that follows them
function pending(o) {
  const p = {};
  if (o._tenor != null)    { p.tenor = o._tenor; delete o._tenor; }
  if (o._tenorCol != null) { p.tenorCol = o._tenorCol; delete o._tenorCol; }
  if (o._valueCol != null) { p.valueCol = o._valueCol; delete o._valueCol; }
  if (o._layout != null)   { p.layout = o._layout; delete o._layout; }
  if (o._date != null)     { p.date = o._date; delete o._date; }
  if (o._row != null)      { p.row = o._row; delete o._row; }
  if (o._jsonPath != null)    { p.jsonPath = o._jsonPath; delete o._jsonPath; }
  if (o._jsonTenor != null)   { p.jsonTenor = o._jsonTenor; delete o._jsonTenor; }
  if (o._jsonTenorDays != null) { p.jsonTenorDays = o._jsonTenorDays; delete o._jsonTenorDays; }
  if (o._jsonValue != null)   { p.jsonValue = o._jsonValue; delete o._jsonValue; }
  if (o._jsonMatures != null) { p.jsonMatures = o._jsonMatures; delete o._jsonMatures; }
  if (o._jsonAsOf != null)    { p.jsonAsOf = o._jsonAsOf; delete o._jsonAsOf; }
  if (o._jsonPrice != null)   { p.jsonPrice = o._jsonPrice; delete o._jsonPrice; }
  if (o._par != null)         { p.par = o._par; delete o._par; }
  if (o._label != null)       { p.label = o._label; delete o._label; }
  if (o._body != null)        { p.body = o._body; delete o._body; }
  if (o._headers != null)     { p.headers = o._headers; delete o._headers; }
  return p;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  // No source given: go straight at the BOI workbook.
  if (!args.help && !args.sources.length && !args.config) {
    args.sources.push({ leg: "nominal", url: BOI_NOMINAL_XLS });
    console.log(`no source given — using ${BOI_NOMINAL_XLS}`);
  }
  if (args.help) {
    const header = fs.readFileSync(new URL(import.meta.url), "utf8").split("*/")[0];
    console.log(header.split("\n")
      .filter(l => /^\s*(\/\*\*|\*)/.test(l))
      .map(l => l.replace(/^\s*\/?\*+ ?/, ""))
      .join("\n").trim());
    process.exit(0);
  }

  let sources = args.sources;
  if (args.config) {
    const cfg = JSON.parse(fs.readFileSync(args.config, "utf8"));
    for (const leg of ["nominal", "real"]) {
      for (const s of cfg[leg] || []) sources.push({ leg, ...s });
    }
    if (cfg.asOf && cfg.asOf !== "auto") args._asOf = cfg.asOf;
  }

  const curve = { asOf: null, source: "Bank of Israel", sources: [], nominal: [], real: [] };
  const merged = { nominal: new Map(), real: new Map() };
  // Which source ended up owning each maturity. Later sources overwrite, so a
  // source's own range is not what it contributed — shcd08 carries a 1y point
  // but makam takes that slot. The page colours the curve by this, so it has to
  // be ownership after merging, not the file's advertised range.
  const owner  = { nominal: new Map(), real: new Map() };
  const claim  = (leg, pts) => { for (const [t] of pts) owner[leg].set(t, curve.sources.length); };
  let failures = 0;

  /**
   * Merge one source's points into a leg.
   *
   * "Later sources win a shared maturity" is enough only when two sources quote
   * the SAME tenors. Real bills don't: the longest Makam matures at 0.93y, so
   * nothing landed on 1y, shcd08's mid-month 1y point survived, and the curve
   * ran 3.28% → 3.21% → 3.29% across 0.93y→1y→2y. A 7bp dip 25 days wide,
   * between a live bill yield and a fortnight-old fitted average — and the
   * forward-rate identity turns it into ~14bp at the 12-month horizon, because a
   * forward has to make up the dip.
   *
   * `governs: [lo, hi]` lets a source declare the span it is authoritative over,
   * so the fresher short-end instrument owns the front of the curve whether or
   * not it happens to quote the same maturities. Points already merged inside
   * that span are dropped, along with their ownership, so the source that lost
   * them does not go on claiming them. It applies when this source is merged, so
   * source order still matters.
   */
  const absorb = (leg, points, s) => {
    const g = s.governs;
    if (Array.isArray(g) && g.length === 2 && g.every(v => Number.isFinite(+v))) {
      const [lo, hi] = [+g[0], +g[1]];
      for (const t of [...merged[leg].keys()]) {
        if (t >= lo - 1e-9 && t <= hi + 1e-9) { merged[leg].delete(t); owner[leg].delete(t); }
      }
    }
    for (const [t, r] of points) merged[leg].set(t, r);
    claim(leg, points);
  };

  /**
   * Read one source into the merge. Returns false if it contributed nothing, so
   * the caller can try a fallback: the live Makam endpoint sits behind a WAF that
   * may refuse a CI runner, and a daily job that dies on that is worse than one
   * that keeps yesterday's committed snapshot.
   */
  const consumeSource = async (s) => {
    const label = s.url || s.file;
    try {
      const raw = s.url ? await fetchBuffer(s.url, { body: s.body, headers: s.headers })
                        : fs.readFileSync(s.file);
      const isBook = looksBinaryWorkbook(raw) || BIN_RE.test(label);

      if (isBook) {
        const all = await readSpreadsheet(raw);
        if (args.dump) { console.log(`\n=== ${label} ===`); dumpSheets(all); return true; }

        const chosen = selectSheets(all, s.sheet ?? args.sheet);
        let got = 0;
        for (const sh of chosen) {
          const res = rowsToCurveAuto(sh.rows, s);
          if (!res.points.length) {
            if (chosen.length === 1) {
              console.error(`  FAIL ${label} [${sh.name}] → ${JSON.stringify(res.diag)}`);
              console.error("       run with --dump to see the sheet layout");
            }
            continue;
          }
          // With no explicit sheet, route by sheet name; the CPI-linked curve
          // often ships in the same workbook as the nominal one.
          const leg = (s.sheet ?? args.sheet) ? s.leg
                    : (REAL_SHEET_RE.test(sh.name) ? "real" : s.leg);
          const { points, note } = normaliseScale(res.points);
          // Later sources win on a shared maturity — list the short-end source
          // last so it owns the overlap.
          absorb(leg, points, s);
          noteAsOf(curve, res.diag?.asOf);
          curve.sources.push({
            label: `${path.basename(label)} [${sh.name}]`, leg,
            asOf: normaliseDate(res.diag?.asOf || ""), range: res.diag?.range || null,
            points: points.length, detail: res.diag?.rowLabel || null
          });
          got += points.length;
          console.log(`  ok  ${label} [${sh.name}] → ${leg}: ${points.length} pt(s)` +
                      (res.diag?.asOf ? ` @ ${res.diag.asOf}` : "") +
                      (res.diag?.range ? ` · ${res.diag.range}` : ""));
          if (note) console.log(`      note: ${note}`);
          for (const o of outliers(points)) console.log(`      note: ${o}`);
          if (args.verbose) {
            console.log(`      diag ${JSON.stringify(res.diag)}`);
            console.log("      " + points.map(([t, r]) => `${round(t)}y=${r}`).join("  "));
          }
        }
        if (!got && chosen.length > 1) {
          console.error(`  FAIL ${label} → no sheet yielded a curve (${all.map(x => x.name).join(", ")})`);
          console.error("       run with --dump to see the sheet layout");
        }
        return got > 0;
      }

      const text = raw.toString("utf8");
      if (args.dump) {
        console.log(`\n=== ${label} (text) ===`);
        dumpSheets([{ name: "text", rows: parseDelimited(text) }]);
        return true;
      }
      const res = parseSource(text, s);

      if (res.curve) {                                  // a curve.json was handed to us
        // Carry its own source records through where it has them, so re-merging
        // a previous curve.json keeps each series attributed. Without this the
        // passed-through points end up owned by nobody, and the page draws them
        // as "between sources" grey even though it knows exactly where they came
        // from. Points a later source overwrites drop out of `owns` as usual.
        const prior = Array.isArray(res.curve.sources) ? res.curve.sources : [];
        for (const leg of ["nominal", "real"]) {
          const pts = (res.curve[leg] || []).map(([t, r]) => [Number(t), Number(r)]);
          if (!pts.length) continue;
          for (const [t, r] of pts) merged[leg].set(t, r);

          const mine = prior.filter(x => x.leg === leg && Array.isArray(x.owns));
          if (mine.length) {
            for (const src of mine) {
              const own = pts.filter(([t]) => t >= src.owns[0] - 1e-9 && t <= src.owns[1] + 1e-9);
              if (!own.length) continue;
              claim(leg, own);
              curve.sources.push({ label: src.label, leg,
                asOf: src.asOf || null, range: src.range || null, points: own.length,
                detail: src.detail || `carried from ${path.basename(label)}` });
            }
          } else {
            claim(leg, pts);
            curve.sources.push({ label: path.basename(label), leg,
              asOf: (res.curve.legAsOf || {})[leg] || res.curve.asOf || null,
              range: null, points: pts.length, detail: "curve.json passthrough" });
          }
        }
        if (res.curve.asOf) curve.asOf = res.curve.asOf;
        console.log(`  ok  ${label} → curve.json passthrough` +
          (prior.length ? ` (${prior.length} source record(s) carried)` : ""));
        return true;
      }

      if (!res.points.length) {
        console.error(`  FAIL ${label} → no points. ${JSON.stringify(res.diag)}`);
        console.error(`       first 300 chars: ${JSON.stringify(text.slice(0, 300))}`);
        return false;
      }
      const { points, note } = normaliseScale(res.points);
      absorb(s.leg, points, s);
      noteAsOf(curve, res.diag?.asOf);
      curve.sources.push({
        // An API path is not a name: the page keys a series' colour and title off
        // this label, so an endpoint called "securitiesmarketdata" loses both.
        // `label` in the config says what the data IS.
        label: s.label || path.basename(label), leg: s.leg,
        asOf: normaliseDate(res.diag?.asOf || ""), range: res.diag?.range || null,
        points: points.length, detail: res.diag?.rowLabel || null
      });
      console.log(`  ok  ${label} → ${s.leg}: ${points.length} pt(s)` +
                  (res.diag?.asOf ? ` @ ${res.diag.asOf}` : ""));
      if (note) console.log(`      note: ${note}`);
      for (const o of outliers(points)) console.log(`      note: ${o}`);
      if (args.verbose) {
        console.log(`      diag ${JSON.stringify(res.diag)}`);
        console.log("      " + points.map(([t, r]) => `${round(t)}y=${r}`).join("  "));
      }
      return true;
    } catch (e) {
      console.error(`  FAIL ${label} → ${e.message}`);
      return false;
    }
  };

  for (const s of sources) {
    let ok = await consumeSource(s);
    if (!ok && s.fallback) {
      const alt = s.fallback.url || s.fallback.file;
      console.error(`       falling back to ${alt}`);
      // The stand-in covers the same part of the curve, so it inherits the span
      // its parent governs — otherwise the snapshot would merge under a
      // different rule than the live source it replaces.
      ok = await consumeSource({ leg: s.leg, governs: s.governs, ...s.fallback });
      // A fallback that also fails is still one failed leg, not two.
    }
    if (!ok) failures++;
  }

  if (args.dump) return;               // inspection only, nothing to write

  curve.nominal = [...merged.nominal.entries()].sort((a, b) => a[0] - b[0]);
  curve.real    = [...merged.real.entries()].sort((a, b) => a[0] - b[0]);

  // Attach the maturity span each source actually won. A source that was fully
  // overwritten gets owns: null and is drawn by nobody — which is the truth.
  curve.sources.forEach((src, i) => {
    const ts = [...owner[src.leg].entries()].filter(([, o]) => o === i).map(([t]) => t);
    // round() formats for the console and returns a string; owns must be numeric
    // so the page can compare maturities against it without coercing.
    src.owns = ts.length ? [+round(Math.min(...ts)), +round(Math.max(...ts))] : null;
    src.ownsPoints = ts.length;
  });

  // A per-leg date, because the legs come from different files on different
  // dates. The top-level asOf is the freshest across everything, which is right
  // for "when was this curve.json built" and wrong for "when was the CPI-linked
  // curve observed" — stamping the real leg 2026-07-30 when the Galil file says
  // 2026-07-15 is a false claim about the data.
  curve.legAsOf = {};
  for (const leg of ["nominal", "real"]) {
    const ds = curve.sources.filter(s => s.leg === leg && s.ownsPoints && s.asOf).map(s => s.asOf);
    if (ds.length) curve.legAsOf[leg] = ds.sort().pop();
  }
  if (args._asOf) curve.asOf = args._asOf;
  if (!curve.asOf) curve.asOf = new Date().toISOString().slice(0, 10);

  if (!curve.nominal.length && !curve.real.length) {
    console.error("\nNothing parsed — refusing to write. Re-run with --verbose to see the raw response.");
    process.exit(1);
  }
  if (curve.nominal.length === 1 || curve.real.length === 1) {
    console.error("WARNING: a curve has a single point; interpolation will be flat. Add more tenors.");
  }

  fs.writeFileSync(args.out, serialiseCurve(curve));
  console.log(`\nwrote ${args.out}  nominal=${curve.nominal.length} real=${curve.real.length} asOf=${curve.asOf}`);

  if (args.inject) {
    const html = fs.readFileSync(args.inject, "utf8");
    const { html: out, changed } = injectIntoHtml(html, curve);
    fs.writeFileSync(args.inject, out);
    console.log(`injected into ${path.basename(args.inject)}: ${changed.join(", ")}`);
  }
  if (failures) process.exitCode = 2;
}

/** Span of the balanced {...} for one leg inside BUILTIN_PROV. */
function legBlock(text, leg) {
  const prov = text.indexOf("const BUILTIN_PROV");
  if (prov < 0) return null;
  const key = text.indexOf(`\n  ${leg}: {`, prov);
  if (key < 0) return null;
  const open = text.indexOf("{", key);
  const close = matchBracket(text, open, "{", "}");
  return close < 0 ? null : { from: open, to: close + 1 };
}

/** Span of the array following `marker` within [from, to). */
function arraySpan(text, marker, from, to) {
  const at = text.indexOf(marker, from);
  if (at < 0 || at >= to) return null;
  const open = text.indexOf("[", at);
  if (open < 0 || open >= to) return null;
  const close = matchBracket(text, open, "[", "]");
  return close < 0 ? null : { start: open, end: close + 1 };
}

/** Index of the bracket closing the one at `open`, honouring string literals. */
function matchBracket(text, open, o, c) {
  let depth = 0, q = null;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === "\\") i++;
      else if (ch === q) q = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") { q = ch; continue; }
    if (ch === o) depth++;
    else if (ch === c && --depth === 0) return i;
  }
  return -1;
}

/**
 * The page's key for a source file, so an injected curve lines up with the
 * upload buttons. Unknown files get no key: they still colour and label, but
 * they are not one of the three series the buttons manage.
 */
function sourceKey(label) {
  const f = String(label).toLowerCase();
  if (f.includes("makam")) return "makam";
  if (f.includes("shcd08")) return "shcd08";
  if (f.includes("shcd07")) return "shcd07";
  return null;
}

/** The chart name a series is published under. Mirrors seriesTitle() in the page. */
function seriesTitle(label, leg) {
  const k = sourceKey(label);
  if (k === "makam") return "Makam (T-bill) yields";
  if (k === "shcd08") return "Government bond yields \u00b7 nominal zero-coupon curve";
  if (k === "shcd07") return "Government bond yields \u00b7 CPI-linked (real) zero-coupon curve";
  return (leg === "real" ? "CPI-linked (real)" : "Nominal") + " zero curve";
}

/** Keep the LATEST date across merged sources — the curve is current to that. */
function noteAsOf(curve, raw) {
  if (!raw) return;
  const d = normaliseDate(raw);
  if (!curve.asOf || d > curve.asOf) curve.asOf = d;
}

/**
 * Flag a point that sits far off its neighbours. Reported, never removed —
 * dropping a bank's published number is not this script's call.
 */
export function outliers(points, thresholdBp = 30) {
  const out = [];
  for (let i = 0; i < points.length; i++) {
    const [t, v] = points[i];
    const prev = points[i - 1], next = points[i + 1];
    const ref = prev && next ? (prev[1] + next[1]) / 2 : (prev || next || [0, v])[1];
    const gap = Math.abs(v - ref) * 100;
    if (gap >= thresholdBp) {
      out.push(`${round(t)}y = ${v.toFixed(2)}% sits ${Math.round(gap)}bp off its neighbours — ` +
               `check it before relying on the short end`);
    }
  }
  return out;
}

/** One [tenor, rate] pair per line — this file is meant to be read and diffed. */
function serialiseCurve(c) {
  const leg = pts => pts.length
    ? "[\n" + pts.map(([t, r]) => `    [${round(t)}, ${r.toFixed(2)}]`).join(",\n") + "\n  ]"
    : "[]";
  const srcs = (c.sources || []).length
    ? "[\n" + c.sources.map(s => "    " + JSON.stringify(s)).join(",\n") + "\n  ]"
    : "[]";
  return `{
  "asOf": ${JSON.stringify(c.asOf)},
  "legAsOf": ${JSON.stringify(c.legAsOf || {})},
  "source": ${JSON.stringify(c.source)},
  "sources": ${srcs},
  "nominal": ${leg(c.nominal)},
  "real": ${leg(c.real)}
}
`;
}

function normaliseDate(s) {
  const t = String(s).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
  if (/^\d{4}-\d{2}$/.test(t)) return t + "-01";
  const dmy = t.match(/^(\d{1,2})[./](\d{1,2})[./](\d{4})$/);
  if (dmy) return `${dmy[3]}-${dmy[2].padStart(2, "0")}-${dmy[1].padStart(2, "0")}`;
  return t;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(e => { console.error("error: " + e.message); process.exit(1); });
}
