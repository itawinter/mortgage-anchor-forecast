/**
 * xls-lite — read the cells of an Excel workbook with no dependencies.
 *
 * Enough of BIFF8 (.xls) and OOXML (.xlsx) to recover a sheet as a grid of
 * strings / numbers / Dates. That is all the curve parser needs: a header row
 * of maturities and a last data row. Written because the Bank of Israel
 * publishes these tables as .xls, and a page that cannot read them would send
 * every user through a spreadsheet round-trip first.
 *
 * Not a general Excel implementation. No formulas beyond cached results, no
 * styling, no charts. It is deliberately small enough to audit.
 *
 * Exported shape matches what the page's parser already consumes:
 *   [{ name, rows: [[cell, ...], ...] }, ...]
 */

/* ============================================================
   OLE2 / Compound File Binary — the container .xls lives in
   ============================================================ */
function readCFB(buf) {
  const d = new DataView(buf);
  const u8 = new Uint8Array(buf);
  const sig = [0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1];
  for (let i = 0; i < 8; i++) if (u8[i] !== sig[i]) throw new Error("not an OLE2 file");

  const sectorSize = 1 << d.getUint16(0x1E, true);
  const miniSize   = 1 << d.getUint16(0x20, true);
  const nFAT       = d.getUint32(0x2C, true);
  const dirStart   = d.getUint32(0x30, true);
  const miniCutoff = d.getUint32(0x38, true);
  const miniFATSt  = d.getUint32(0x3C, true);
  const nMiniFAT   = d.getUint32(0x40, true);
  const difatStart = d.getUint32(0x44, true);
  const nDIFAT     = d.getUint32(0x48, true);

  const off = s => (s + 1) * sectorSize;

  // DIFAT: 109 entries in the header, the rest chained through extra sectors.
  const difat = [];
  for (let i = 0; i < 109; i++) {
    const v = d.getUint32(0x4C + i * 4, true);
    if (v === 0xFFFFFFFF) break;
    difat.push(v);
  }
  let ds = difatStart;
  for (let n = 0; n < nDIFAT && ds !== 0xFFFFFFFE && ds !== 0xFFFFFFFF; n++) {
    const base = off(ds);
    const per = sectorSize / 4 - 1;
    for (let i = 0; i < per; i++) {
      const v = d.getUint32(base + i * 4, true);
      if (v !== 0xFFFFFFFF) difat.push(v);
    }
    ds = d.getUint32(base + per * 4, true);
  }

  const readChain = (arr, start) => {
    const out = [];
    let s = start, guard = 0;
    while (s !== 0xFFFFFFFE && s !== 0xFFFFFFFF && s < arr.length && guard++ < 1e6) {
      out.push(s);
      s = arr[s];
    }
    return out;
  };

  // FAT
  const fat = new Uint32Array(difat.length * (sectorSize / 4));
  difat.slice(0, nFAT || difat.length).forEach((sec, i) => {
    const base = off(sec);
    for (let j = 0; j < sectorSize / 4; j++) fat[i * (sectorSize / 4) + j] = d.getUint32(base + j * 4, true);
  });

  const catSectors = (sectors, size) => {
    const out = new Uint8Array(sectors.length * sectorSize);
    sectors.forEach((s, i) => out.set(u8.subarray(off(s), off(s) + sectorSize), i * sectorSize));
    return size == null ? out : out.subarray(0, size);
  };

  // miniFAT
  const miniFATBytes = catSectors(readChain(fat, miniFATSt), nMiniFAT * sectorSize);
  const miniFAT = new Uint32Array(miniFATBytes.buffer, miniFATBytes.byteOffset,
    Math.floor(miniFATBytes.byteLength / 4));

  // Directory
  const dirBytes = catSectors(readChain(fat, dirStart));
  const dv = new DataView(dirBytes.buffer, dirBytes.byteOffset, dirBytes.byteLength);
  const entries = [];
  for (let i = 0; i + 128 <= dirBytes.length; i++) {
    const b = i * 128;
    if (b + 128 > dirBytes.length) break;
    const nameLen = dv.getUint16(b + 0x40, true);
    if (!nameLen) continue;
    let name = "";
    for (let j = 0; j < nameLen - 2; j += 2) name += String.fromCharCode(dv.getUint16(b + j, true));
    entries.push({
      name,
      type: dv.getUint8(b + 0x42),
      start: dv.getUint32(b + 0x74, true),
      size: dv.getUint32(b + 0x78, true)
    });
  }

  const root = entries.find(e => e.type === 5);
  const miniStream = root ? catSectors(readChain(fat, root.start), root.size) : new Uint8Array(0);

  const streamOf = e => {
    if (e.size < miniCutoff) {
      const chain = readChain(miniFAT, e.start);
      const out = new Uint8Array(chain.length * miniSize);
      chain.forEach((s, i) => out.set(miniStream.subarray(s * miniSize, (s + 1) * miniSize), i * miniSize));
      return out.subarray(0, e.size);
    }
    return catSectors(readChain(fat, e.start), e.size);
  };

  return { entries, streamOf };
}

/* ============================================================
   BIFF8 record stream
   ============================================================ */
const DATE_FMT_IDS = new Set([14, 15, 16, 17, 22, 27, 30, 36, 45, 46, 47, 50, 57]);

/** Strip quoted literals and colour/condition blocks, then look for date codes. */
function isDateFormat(fmt) {
  if (!fmt) return false;
  const bare = String(fmt).replace(/\\[\s\S]/g, "").replace(/"[^"]*"/g, "").replace(/\[[^\]]*\]/g, "");
  return /[ymdhs]/i.test(bare) && !/^[^ymdhs]*$/i.test(bare);
}

/** Excel serial -> Date (UTC). 1900 system, including its phantom leap day. */
function serialToDate(v) {
  const days = Math.floor(v);
  const ms = Math.round((v - days) * 86400000);
  // Serial 60 is Excel's non-existent 1900-02-29; everything after it is off by one.
  const epoch = Date.UTC(1899, 11, 31);
  return new Date(epoch + (days - (days > 59 ? 1 : 0)) * 86400000 + ms);
}

function parseBIFF(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let p = 0;

  const sheets = [];        // { name, bofPos }
  const sst = [];
  const xfFmt = [];         // xf index -> format id
  const fmtStr = new Map(); // format id -> format string
  let cur = null;           // current worksheet being filled
  const grids = new Map();  // bofPos -> rows

  /** Read one BIFF8 unicode string starting at `at`; returns [text, bytesUsed]. */
  const readStr = (at, cchIn) => {
    let q = at;
    const cch = cchIn != null ? cchIn : dv.getUint16(q, true);
    if (cchIn == null) q += 2;
    const flags = dv.getUint8(q); q += 1;
    const wide = flags & 0x01, rich = flags & 0x08, ext = flags & 0x04;
    let runs = 0, extSz = 0;
    if (rich) { runs = dv.getUint16(q, true); q += 2; }
    if (ext)  { extSz = dv.getUint32(q, true); q += 4; }
    let s = "";
    for (let i = 0; i < cch; i++) {
      if (wide) { s += String.fromCharCode(dv.getUint16(q, true)); q += 2; }
      else      { s += String.fromCharCode(dv.getUint8(q)); q += 1; }
    }
    q += runs * 4 + extSz;
    return [s, q - at];
  };

  const put = (row, col, val) => {
    if (!cur) return;
    while (cur.length <= row) cur.push([]);
    const r = cur[row];
    while (r.length <= col) r.push(null);
    r[col] = val;
  };

  const numCell = (row, col, xf, v) => {
    const fmt = fmtStr.get(xfFmt[xf]);
    const isDate = DATE_FMT_IDS.has(xfFmt[xf]) || isDateFormat(fmt);
    put(row, col, isDate && v > 0 ? serialToDate(v) : v);
  };

  const rkToNum = rk => {
    const isInt = rk & 0x02, div100 = rk & 0x01;
    let v;
    if (isInt) v = rk >> 2;
    else {
      const b = new ArrayBuffer(8), bd = new DataView(b);
      // RK carries the HIGH 32 bits of the IEEE double, so it must land in the
      // first four bytes of a big-endian read — the low half stays zero.
      bd.setUint32(0, rk & 0xFFFFFFFC);
      v = bd.getFloat64(0);
    }
    return div100 ? v / 100 : v;
  };

  while (p + 4 <= bytes.length) {
    const id = dv.getUint16(p, true);
    const len = dv.getUint16(p + 2, true);
    const body = p + 4;
    if (body + len > bytes.length) break;

    switch (id) {
      case 0x0809: {                               // BOF
        const sub = dv.getUint16(body + 2, true);
        if (sub === 0x0010) { cur = []; grids.set(p, cur); }
        break;
      }
      case 0x000A: cur = null; break;              // EOF
      case 0x0085: {                               // BOUNDSHEET
        // pos(4) hidden(1) type(1) then a short unicode string: cch as ONE byte,
        // so readStr is handed the flags byte and the count separately.
        const pos = dv.getUint32(body, true);
        const [nm] = readStr(body + 7, dv.getUint8(body + 6));
        sheets.push({ name: nm, bofPos: pos });
        break;
      }
      case 0x041E: {                               // FORMAT
        const ifmt = dv.getUint16(body, true);
        const [s] = readStr(body + 2);
        fmtStr.set(ifmt, s);
        break;
      }
      case 0x00E0: xfFmt.push(dv.getUint16(body + 2, true)); break;   // XF
      case 0x00FC: {                               // SST (+ CONTINUEs)
        // Gather this record and every CONTINUE that follows it, keeping the
        // boundaries: a string can straddle one, and the flags byte restarts.
        const chunks = [{ off: body, len }];
        let q = p + 4 + len;
        while (q + 4 <= bytes.length && dv.getUint16(q, true) === 0x003C) {
          const cl = dv.getUint16(q + 2, true);
          chunks.push({ off: q + 4, len: cl });
          q += 4 + cl;
        }
        const total = chunks.reduce((a, c) => a + c.len, 0);
        const flat = new Uint8Array(total);
        let w = 0;
        for (const c of chunks) { flat.set(bytes.subarray(c.off, c.off + c.len), w); w += c.len; }
        // Boundaries in flat coordinates, so the reader can restart flags.
        const bounds = [];
        let acc = 0;
        for (const c of chunks) { acc += c.len; bounds.push(acc); }
        readSST(flat, bounds, sst);
        p = q;                                     // skip the CONTINUEs we consumed
        continue;
      }
      case 0x00FD: {                               // LABELSST
        const row = dv.getUint16(body, true), col = dv.getUint16(body + 2, true);
        put(row, col, sst[dv.getUint32(body + 6, true)] ?? "");
        break;
      }
      case 0x0204: {                               // LABEL
        const row = dv.getUint16(body, true), col = dv.getUint16(body + 2, true);
        const [s] = readStr(body + 6);
        put(row, col, s);
        break;
      }
      case 0x0203: {                               // NUMBER
        const row = dv.getUint16(body, true), col = dv.getUint16(body + 2, true);
        numCell(row, col, dv.getUint16(body + 4, true), dv.getFloat64(body + 6, true));
        break;
      }
      case 0x027E: {                               // RK
        const row = dv.getUint16(body, true), col = dv.getUint16(body + 2, true);
        numCell(row, col, dv.getUint16(body + 4, true), rkToNum(dv.getInt32(body + 6, true)));
        break;
      }
      case 0x00BD: {                               // MULRK
        const row = dv.getUint16(body, true);
        const c0 = dv.getUint16(body + 2, true);
        const n = (len - 6) / 6;
        for (let i = 0; i < n; i++) {
          const o = body + 4 + i * 6;
          numCell(row, c0 + i, dv.getUint16(o, true), rkToNum(dv.getInt32(o + 2, true)));
        }
        break;
      }
      case 0x0006: {                               // FORMULA (cached result)
        const row = dv.getUint16(body, true), col = dv.getUint16(body + 2, true);
        const xf = dv.getUint16(body + 4, true);
        // A cached string/bool/error has 0xFFFF in the top word; otherwise it's a double.
        if (dv.getUint16(body + 12, true) === 0xFFFF) {
          const kind = dv.getUint8(body + 6);
          if (kind === 0) put(row, col, "");       // string arrives in the next STRING record
          else if (kind === 1) put(row, col, !!dv.getUint8(body + 8));
          else put(row, col, null);
          cur && (cur._pendingStr = [row, col]);
        } else {
          numCell(row, col, xf, dv.getFloat64(body + 6, true));
        }
        break;
      }
      case 0x0201: {                               // BLANK
        put(dv.getUint16(body, true), dv.getUint16(body + 2, true), null);
        break;
      }
      case 0x00BE: {                               // MULBLANK
        const row = dv.getUint16(body, true), c0 = dv.getUint16(body + 2, true);
        const n = (len - 6) / 2;
        for (let i = 0; i < n; i++) put(row, c0 + i, null);
        break;
      }
      case 0x0207: {                               // STRING (result of the last FORMULA)
        if (cur && cur._pendingStr) {
          const [s] = readStr(body);
          put(cur._pendingStr[0], cur._pendingStr[1], s);
          cur._pendingStr = null;
        }
        break;
      }
      default: break;
    }
    p = body + len;
  }

  function readSST(flat, bounds, out) {
    const fd = new DataView(flat.buffer, flat.byteOffset, flat.byteLength);
    let q = 8;                                     // skip cstTotal, cstUnique
    const nextBound = at => bounds.find(b => b > at);
    while (q < flat.length && out.length < 1e6) {
      if (q + 3 > flat.length) break;
      const cch = fd.getUint16(q, true); q += 2;
      let flags = fd.getUint8(q); q += 1;
      let wide = flags & 0x01;
      const rich = flags & 0x08, ext = flags & 0x04;
      let runs = 0, extSz = 0;
      if (rich) { runs = fd.getUint16(q, true); q += 2; }
      if (ext)  { extSz = fd.getUint32(q, true); q += 4; }
      let s = "", read = 0;
      while (read < cch) {
        const bound = nextBound(q);
        // A CONTINUE boundary restarts with a fresh flags byte, and the
        // width can change mid-string — this is the trap in BIFF8 SST.
        if (bound != null && q === bound) { flags = fd.getUint8(q); wide = flags & 0x01; q += 1; }
        if (wide) { s += String.fromCharCode(fd.getUint16(q, true)); q += 2; }
        else      { s += String.fromCharCode(fd.getUint8(q)); q += 1; }
        read++;
      }
      q += runs * 4 + extSz;
      out.push(s);
    }
  }

  // Match sheets to their grids by BOF position within the stream.
  return sheets.map(sh => ({
    name: sh.name,
    rows: (grids.get(sh.bofPos) || []).map(r => r.map(c => (c === undefined ? null : c)))
  }));
}

/* ============================================================
   OOXML (.xlsx) — a zip of XML
   ============================================================ */
async function inflateRaw(bytes) {
  if (typeof DecompressionStream === "undefined") throw new Error("no DecompressionStream");
  const ds = new DecompressionStream("deflate-raw");
  const stream = new Blob([bytes]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function readZip(buf) {
  const d = new DataView(buf), u8 = new Uint8Array(buf);
  // End of central directory: scan back for the signature.
  let eocd = -1;
  for (let i = u8.length - 22; i >= 0 && i > u8.length - 66000; i--) {
    if (d.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("not a zip");
  const count = d.getUint16(eocd + 10, true);
  let p = d.getUint32(eocd + 16, true);
  const files = new Map();
  for (let i = 0; i < count; i++) {
    if (d.getUint32(p, true) !== 0x02014b50) break;
    const method = d.getUint16(p + 10, true);
    const csize = d.getUint32(p + 20, true);
    const nameLen = d.getUint16(p + 28, true);
    const extraLen = d.getUint16(p + 30, true);
    const cmtLen = d.getUint16(p + 32, true);
    const lho = d.getUint32(p + 42, true);
    const name = new TextDecoder().decode(u8.subarray(p + 46, p + 46 + nameLen));
    // Local header carries its own (possibly different) extra-field length.
    const lNameLen = d.getUint16(lho + 26, true);
    const lExtraLen = d.getUint16(lho + 28, true);
    const dataAt = lho + 30 + lNameLen + lExtraLen;
    files.set(name, { method, bytes: u8.subarray(dataAt, dataAt + csize) });
    p += 46 + nameLen + extraLen + cmtLen;
  }
  const out = new Map();
  for (const [name, f] of files) {
    out.set(name, f.method === 0 ? f.bytes : await inflateRaw(f.bytes));
  }
  return out;
}

const XLSX_DATE_FMT = /[ymdhs]/i;

async function parseXLSX(buf) {
  const zip = await readZip(buf);
  const dec = b => new TextDecoder().decode(b);
  const parseXml = t => new DOMParser().parseFromString(t, "application/xml");

  const shared = [];
  if (zip.has("xl/sharedStrings.xml")) {
    const doc = parseXml(dec(zip.get("xl/sharedStrings.xml")));
    for (const si of doc.getElementsByTagName("si")) {
      // <si> may hold one <t> or several inside <r> runs.
      shared.push([...si.getElementsByTagName("t")].map(t => t.textContent).join(""));
    }
  }

  // Which cell styles are dates.
  const dateXf = new Set();
  if (zip.has("xl/styles.xml")) {
    const doc = parseXml(dec(zip.get("xl/styles.xml")));
    const custom = new Map();
    for (const n of doc.getElementsByTagName("numFmt")) {
      custom.set(+n.getAttribute("numFmtId"), n.getAttribute("formatCode") || "");
    }
    const cellXfs = doc.getElementsByTagName("cellXfs")[0];
    if (cellXfs) {
      [...cellXfs.getElementsByTagName("xf")].forEach((xf, i) => {
        const id = +(xf.getAttribute("numFmtId") || 0);
        const code = custom.get(id);
        if (DATE_FMT_IDS.has(id) || (code && XLSX_DATE_FMT.test(code.replace(/"[^"]*"/g, "")))) {
          dateXf.add(i);
        }
      });
    }
  }

  // Sheet names in workbook order.
  const names = [];
  if (zip.has("xl/workbook.xml")) {
    const doc = parseXml(dec(zip.get("xl/workbook.xml")));
    for (const sh of doc.getElementsByTagName("sheet")) names.push(sh.getAttribute("name"));
  }

  const sheetFiles = [...zip.keys()].filter(k => /^xl\/worksheets\/sheet\d+\.xml$/.test(k))
    .sort((a, b) => (+a.match(/(\d+)/)[1]) - (+b.match(/(\d+)/)[1]));

  const colOf = ref => {
    let n = 0;
    for (const ch of ref) {
      const c = ch.toUpperCase();
      if (c < "A" || c > "Z") break;
      n = n * 26 + (c.charCodeAt(0) - 64);
    }
    return n - 1;
  };

  return sheetFiles.map((f, i) => {
    const doc = parseXml(dec(zip.get(f)));
    const rows = [];
    for (const row of doc.getElementsByTagName("row")) {
      const rIdx = +(row.getAttribute("r") || rows.length + 1) - 1;
      while (rows.length <= rIdx) rows.push([]);
      const out = rows[rIdx];
      for (const c of row.getElementsByTagName("c")) {
        const col = colOf(c.getAttribute("r") || "");
        if (col < 0) continue;
        while (out.length <= col) out.push(null);
        const t = c.getAttribute("t");
        const vEl = c.getElementsByTagName("v")[0];
        if (t === "inlineStr") {
          out[col] = [...c.getElementsByTagName("t")].map(x => x.textContent).join("");
          continue;
        }
        if (!vEl) { out[col] = null; continue; }
        const raw = vEl.textContent;
        if (t === "s") out[col] = shared[+raw] ?? "";
        else if (t === "str" || t === "e") out[col] = raw;
        else if (t === "b") out[col] = raw === "1";
        else {
          const num = Number(raw);
          const s = +(c.getAttribute("s") || 0);
          out[col] = (dateXf.has(s) && num > 0) ? serialToDate(num) : num;
        }
      }
    }
    return { name: names[i] || f.replace(/.*\//, ""), rows };
  });
}

/* ============================================================
   Entry point
   ============================================================ */
export async function readWorkbook(buf) {
  const u8 = new Uint8Array(buf);
  if (u8[0] === 0x50 && u8[1] === 0x4B) return parseXLSX(buf);       // "PK" — zip
  if (u8[0] === 0xD0 && u8[1] === 0xCF) {                            // OLE2
    const { entries, streamOf } = readCFB(buf);
    const wb = entries.find(e => /^(Workbook|Book)$/i.test(e.name));
    if (!wb) throw new Error("no Workbook stream in that .xls");
    return parseBIFF(streamOf(wb));
  }
  throw new Error("not an Excel workbook");
}

export { serialToDate, isDateFormat };
