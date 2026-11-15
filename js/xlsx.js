/*
 * Reads the first sheet of an Excel .xlsx file as rows of cell text, with no library. An .xlsx file is a
 * zip archive of XML files; the browser's DecompressionStream unzips them.
 * Loaded as a plain script in the browser (window.RC.xlsx) and with require() in Node tests.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else (root.RC = root.RC || {}).xlsx = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const SAVE_AS_CSV = 'Save the sheet as CSV, then choose the CSV file.';
  const NOT_EXCEL = "The app can't read Numbers or old Excel (.xls) files. Save the sheet as .xlsx or CSV, then choose that file.";

  // ---------- Zip ----------

  // The files in a zip archive by name, as { method, data }, from its central directory at the end.
  function zipEntries(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let end = bytes.length - 22;
    while (end >= 0 && view.getUint32(end, true) !== 0x06054b50) end--;
    if (end < 0) throw new Error('no end of central directory');
    const entries = new Map();
    let at = view.getUint32(end + 16, true);
    for (let i = view.getUint16(end + 10, true); i > 0; i--) {
      if (view.getUint32(at, true) !== 0x02014b50) throw new Error('bad central directory');
      const nameLength = view.getUint16(at + 28, true);
      const local = view.getUint32(at + 42, true);
      const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
      entries.set(new TextDecoder().decode(bytes.subarray(at + 46, at + 46 + nameLength)), {
        method: view.getUint16(at + 10, true),
        data: bytes.subarray(start, start + view.getUint32(at + 20, true)),
      });
      at += 46 + nameLength + view.getUint16(at + 30, true) + view.getUint16(at + 32, true);
    }
    return entries;
  }

  // A file in the archive as text, or null when it isn't there. Method 0 is stored, 8 is deflated.
  async function zipText(entries, name) {
    const entry = entries.get(name);
    if (!entry) return null;
    if (entry.method === 0) return new TextDecoder().decode(entry.data);
    if (entry.method !== 8) throw new Error(`zip method ${entry.method}`);
    return new Response(new Blob([entry.data]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).text();
  }

  // ---------- XML ----------

  // Spreadsheet XML is machine-written and regular, so a few patterns read the parts needed here.
  // Each tag may carry a namespace prefix, like <x:c>.
  const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
  const unescape = (text) => text.replace(/&(#x[\da-f]+|#\d+|\w+);/gi, (whole, name) => {
    if (name[0] !== '#') return ENTITIES[name] || whole;
    return String.fromCodePoint(name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : Number(name.slice(1)));
  });

  // Every <tag> element as [attributes, inner XML].
  const elements = (xml, tag) => [...xml.matchAll(new RegExp(`<(?:\\w+:)?${tag}\\b([^>]*?)(?:/>|>([\\s\\S]*?)</(?:\\w+:)?${tag}>)`, 'g'))]
    .map((match) => [match[1], match[2] || '']);

  const attribute = (attributes, name) => {
    const match = new RegExp(`(?:^|\\s)(?:\\w+:)?${name}="([^"]*)"`).exec(attributes);
    return match ? unescape(match[1]) : null;
  };

  // The text of a string, which may be split into formatted runs. Phonetic guides (<rPh>) are left out.
  const runText = (inner) => elements(inner.replace(/<(?:\w+:)?rPh\b[\s\S]*?<\/(?:\w+:)?rPh>/g, ''), 't')
    .map(([, text]) => unescape(text)).join('');

  // ---------- Cells ----------

  // Excel's built-in number formats that show a date.
  const DATE_FORMAT_IDS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 45, 46, 47, 50, 51, 52, 53, 54, 55, 56, 57, 58]);
  // A custom format shows a date when it has y, m or d outside quoted text, [colors] and escaped characters.
  const isDateCode = (code) => /[ymd]/i.test(code.replace(/"[^"]*"|\[[^\]]*\]|\\./g, ''));

  // The cell styles (by index) that show a date, from styles.xml.
  function dateStyles(stylesXml) {
    const custom = new Map(elements(stylesXml, 'numFmt').map(([attributes]) => [Number(attribute(attributes, 'numFmtId')), attribute(attributes, 'formatCode') || '']));
    const [cellXfs] = elements(stylesXml, 'cellXfs');
    const styles = new Set();
    elements(cellXfs ? cellXfs[1] : '', 'xf').forEach(([attributes], index) => {
      const id = Number(attribute(attributes, 'numFmtId'));
      if (DATE_FORMAT_IDS.has(id) || (custom.has(id) && isDateCode(custom.get(id)))) styles.add(index);
    });
    return styles;
  }

  // Excel stores a date as a count of days. Workbooks from old Macs count from 1904.
  const dateText = (days, from1904) => new Date((from1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 30)) + Math.round(days * 86400000)).toISOString().slice(0, 10);

  // "C7" is the third column, 2 counting from 0.
  const columnOf = (ref) => [...ref.replace(/\d+$/, '')].reduce((n, letter) => n * 26 + letter.charCodeAt(0) - 64, 0) - 1;

  function cellText(attributes, inner, book) {
    const type = attribute(attributes, 't') || 'n';
    if (type === 'inlineStr') return runText(inner);
    const [value] = elements(inner, 'v');
    const raw = value ? unescape(value[1]) : '';
    if (type === 's') return book.strings[Number(raw)] || '';
    if (type === 'b') return raw === '1' ? 'TRUE' : 'FALSE';
    if (type === 'n' && raw && book.dateStyles.has(Number(attribute(attributes, 's') || 0))) return dateText(Number(raw), book.from1904);
    return raw;
  }

  // ---------- Workbook ----------

  async function readSheet(entries) {
    const workbook = await zipText(entries, 'xl/workbook.xml');
    if (workbook === null) throw new Error(NOT_EXCEL);
    const [first] = elements(workbook, 'sheet');
    const id = first && attribute(first[0], 'id');
    const relations = elements((await zipText(entries, 'xl/_rels/workbook.xml.rels')) || '', 'Relationship');
    const relation = relations.find(([attributes]) => attribute(attributes, 'Id') === id);
    const target = relation ? attribute(relation[0], 'Target') : 'worksheets/sheet1.xml';
    const sheet = await zipText(entries, target.startsWith('/') ? target.slice(1) : `xl/${target}`);
    if (sheet === null) throw new Error('no sheet');
    const book = {
      strings: elements((await zipText(entries, 'xl/sharedStrings.xml')) || '', 'si').map(([, inner]) => runText(inner)),
      dateStyles: dateStyles((await zipText(entries, 'xl/styles.xml')) || ''),
      from1904: /date1904="(?:1|true)"/.test(workbook),
    };
    return elements(sheet, 'row').map(([, rowXml]) => {
      const cells = [];
      for (const [attributes, inner] of elements(rowXml, 'c')) {
        const ref = attribute(attributes, 'r');
        const column = ref ? columnOf(ref) : cells.length;
        while (cells.length < column) cells.push('');
        cells[column] = cellText(attributes, inner, book);
      }
      return cells;
    });
  }

  /*
   * The first sheet of an .xlsx file as rows of cell text. A date shows as 2024-05-31. Throws a message
   * that says what to do instead when the file isn't an .xlsx file, is damaged, or the browser can't unzip.
   */
  async function sheetRows(bytes) {
    if (typeof DecompressionStream === 'undefined') throw new Error(`This browser can't open Excel files. ${SAVE_AS_CSV}`);
    try {
      return await readSheet(zipEntries(bytes));
    } catch (e) {
      throw e.message === NOT_EXCEL ? e : new Error(`That Excel file couldn't be read. ${SAVE_AS_CSV}`);
    }
  }

  return { sheetRows, NOT_EXCEL };
});
