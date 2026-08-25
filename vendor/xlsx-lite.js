// © 2026 GoElev8.ai | Aaron Bryant. All rights reserved.
//
// Minimal .xlsx reader — just enough to pull a contact list off the
// first worksheet. Deliberately NOT a spreadsheet library: no formulas,
// no styles, no number formats, no .xls (that's an entirely different
// binary format). It exists so an operator handed an Excel file can
// import it directly instead of being told to go convert it to CSV,
// which is the loop that stalled Konquered Balance's contact import.
//
// An .xlsx is a ZIP of XML parts. Everything below is the ZIP central
// directory walk plus the two XML parts that hold cell text. Inflation
// uses the platform's own DecompressionStream, so this ships as ~200
// lines with no third-party code and no supply chain to trust.
//
// Exposed as window.XlsxLite.parseXlsx(arrayBuffer) -> Promise<string[][]>
(function (global) {
  'use strict';

  const SIG_EOCD = 0x06054b50;
  const SIG_CENTRAL = 0x02014b50;

  function findEOCD(dv) {
    // The end-of-central-directory record is last, but a trailing
    // comment can push it up to 64KB from the end, so scan backwards.
    const min = Math.max(0, dv.byteLength - 65558);
    for (let i = dv.byteLength - 22; i >= min; i--) {
      if (dv.getUint32(i, true) === SIG_EOCD) return i;
    }
    return -1;
  }

  async function inflateRaw(bytes) {
    // deflate-raw: ZIP stores the deflate payload without a zlib header.
    const stream = new global.DecompressionStream('deflate-raw');
    const writer = stream.writable.getWriter();
    writer.write(bytes);
    writer.close();
    const chunks = [];
    const reader = stream.readable.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    let len = 0;
    for (const c of chunks) len += c.length;
    const out = new Uint8Array(len);
    let off = 0;
    for (const c of chunks) { out.set(c, off); off += c.length; }
    return out;
  }

  // Read the ZIP into { filename: Uint8Array }. Only entries we ask for
  // are inflated — a workbook can carry a lot of parts we never touch.
  async function readZip(arrayBuffer, wanted) {
    const bytes = new Uint8Array(arrayBuffer);
    const dv = new DataView(arrayBuffer);
    const eocd = findEOCD(dv);
    if (eocd < 0) throw new Error('Not a valid .xlsx file (no ZIP directory found).');

    const count = dv.getUint16(eocd + 10, true);
    let ptr = dv.getUint32(eocd + 16, true);
    const decoder = new TextDecoder('utf-8');
    const out = {};

    for (let i = 0; i < count; i++) {
      if (ptr + 46 > dv.byteLength || dv.getUint32(ptr, true) !== SIG_CENTRAL) break;
      const method = dv.getUint16(ptr + 10, true);
      const compSize = dv.getUint32(ptr + 20, true);
      const nameLen = dv.getUint16(ptr + 28, true);
      const extraLen = dv.getUint16(ptr + 30, true);
      const commentLen = dv.getUint16(ptr + 32, true);
      const localOff = dv.getUint32(ptr + 42, true);
      const name = decoder.decode(bytes.subarray(ptr + 46, ptr + 46 + nameLen));
      ptr += 46 + nameLen + extraLen + commentLen;

      if (!wanted(name)) continue;

      // The local header repeats the name/extra with its own lengths;
      // the central directory's values are not reliable for the local
      // copy, so re-read them here.
      const lNameLen = dv.getUint16(localOff + 26, true);
      const lExtraLen = dv.getUint16(localOff + 28, true);
      const dataStart = localOff + 30 + lNameLen + lExtraLen;
      const raw = bytes.subarray(dataStart, dataStart + compSize);
      out[name] = method === 0 ? raw : await inflateRaw(raw);
    }
    return out;
  }

  const decodeXml = (s) => s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');

  // Concatenate every <t> in a chunk. Rich text splits one logical
  // string across several <r><t> runs, so joining is required or
  // "Mary Jane" comes back as just "Mary".
  function textOf(xml) {
    let s = '';
    const re = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>|<t\s*\/>/g;
    let m;
    while ((m = re.exec(xml)) !== null) s += m[1] == null ? '' : decodeXml(m[1]);
    return s;
  }

  function parseSharedStrings(xml) {
    if (!xml) return [];
    const items = [];
    const re = /<si(?:\s[^>]*)?>([\s\S]*?)<\/si>|<si\s*\/>/g;
    let m;
    while ((m = re.exec(xml)) !== null) items.push(m[1] == null ? '' : textOf(m[1]));
    return items;
  }

  // "BC12" -> 54 (zero-based column index)
  function colIndex(ref) {
    const letters = /^([A-Z]+)/.exec(ref.toUpperCase());
    if (!letters) return -1;
    let n = 0;
    for (const ch of letters[1]) n = n * 26 + (ch.charCodeAt(0) - 64);
    return n - 1;
  }

  function parseSheet(xml, shared) {
    const rows = [];
    const rowRe = /<row(?:\s[^>]*)?>([\s\S]*?)<\/row>|<row\s[^>]*\/>/g;
    let rm;
    while ((rm = rowRe.exec(xml)) !== null) {
      const inner = rm[1];
      const cells = [];
      if (inner) {
        const cellRe = /<c\s([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
        let cm;
        while ((cm = cellRe.exec(inner)) !== null) {
          const attrs = cm[1] || '';
          const body = cm[2] || '';
          const refM = /r="([A-Z]+\d+)"/i.exec(attrs);
          const idx = refM ? colIndex(refM[1]) : cells.length;
          const typeM = /t="([^"]+)"/.exec(attrs);
          const type = typeM ? typeM[1] : 'n';

          let val = '';
          if (type === 's') {
            const vm = /<v(?:\s[^>]*)?>([\s\S]*?)<\/v>/.exec(body);
            const i = vm ? parseInt(decodeXml(vm[1]), 10) : NaN;
            val = Number.isFinite(i) && shared[i] != null ? shared[i] : '';
          } else if (type === 'inlineStr') {
            val = textOf(body);
          } else {
            const vm = /<v(?:\s[^>]*)?>([\s\S]*?)<\/v>/.exec(body);
            val = vm ? decodeXml(vm[1]) : (type === 'str' ? textOf(body) : '');
          }
          if (idx >= 0) {
            while (cells.length < idx) cells.push('');
            cells[idx] = val;
          }
        }
      }
      rows.push(cells);
    }
    return rows;
  }

  // Resolve the FIRST sheet properly rather than assuming sheet1.xml —
  // a workbook whose tabs were reordered or deleted can have its first
  // visible sheet stored as sheet3.xml, and importing the wrong tab
  // silently is worse than failing.
  function firstSheetPath(workbookXml, relsXml) {
    if (!workbookXml || !relsXml) return null;
    const sheetM = /<sheet\s[^>]*\/?>/.exec(workbookXml);
    if (!sheetM) return null;
    const ridM = /r:id="([^"]+)"/.exec(sheetM[0]);
    if (!ridM) return null;
    const relRe = new RegExp('<Relationship\\s[^>]*Id="' + ridM[1] + '"[^>]*>');
    const relM = relRe.exec(relsXml);
    if (!relM) return null;
    const tgtM = /Target="([^"]+)"/.exec(relM[0]);
    if (!tgtM) return null;
    let target = tgtM[1].replace(/^\//, '');
    if (!target.startsWith('xl/')) target = 'xl/' + target.replace(/^\.\//, '');
    return target;
  }

  async function parseXlsx(arrayBuffer) {
    if (typeof global.DecompressionStream !== 'function') {
      throw new Error('This browser cannot open .xlsx files. Save the file as CSV and upload that instead, or paste the rows into the box below.');
    }
    const want = (n) =>
      n === 'xl/workbook.xml' ||
      n === 'xl/_rels/workbook.xml.rels' ||
      n === 'xl/sharedStrings.xml' ||
      /^xl\/worksheets\/[^/]+\.xml$/.test(n);

    const files = await readZip(arrayBuffer, want);
    const dec = new TextDecoder('utf-8');
    const asText = (n) => (files[n] ? dec.decode(files[n]) : null);

    const shared = parseSharedStrings(asText('xl/sharedStrings.xml'));
    let path = firstSheetPath(asText('xl/workbook.xml'), asText('xl/_rels/workbook.xml.rels'));
    if (!path || !files[path]) {
      const names = Object.keys(files).filter((n) => /^xl\/worksheets\/[^/]+\.xml$/.test(n)).sort();
      path = names[0];
    }
    if (!path) throw new Error('That .xlsx has no readable worksheet.');

    const rows = parseSheet(dec.decode(files[path]), shared);
    // Drop fully-blank trailing rows — Excel pads generously.
    while (rows.length && rows[rows.length - 1].every((c) => !String(c).trim())) rows.pop();
    return rows;
  }

  global.XlsxLite = { parseXlsx };
})(typeof window !== 'undefined' ? window : globalThis);
