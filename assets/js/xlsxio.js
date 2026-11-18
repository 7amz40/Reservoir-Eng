/*
 * xlsxio.js
 * Minimal, dependency-light reading and writing of Excel (.xlsx) and CSV files.
 * Uses JSZip for the zip container and a small XML parser, so it behaves the same
 * in the browser (global HOXlsx) and in Node (module.exports, for tests).
 *
 * readWorkbook(arrayBuffer, fileName) -> Promise<{format, sheets:[{name, rows:[[cell]]}]}>
 *   cell is a number, a string, a boolean, or null.
 * writeXlsx(sheets) -> Promise<Uint8Array>   (sheets: [{name, rows, colWidths, headerRows}])
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(root);
  else root.HOXlsx = factory(root);
})(typeof self !== 'undefined' ? self : this, function (root) {
  'use strict';

  function getJSZip() {
    if (typeof JSZip !== 'undefined') return JSZip; // eslint-disable-line no-undef
    if (root && root.JSZip) return root.JSZip;
    if (typeof globalThis !== 'undefined' && globalThis.JSZip) return globalThis.JSZip;
    throw new Error('The zip library (JSZip) did not load. Reload the page and try again.');
  }

  function FileFormatError(message, code) {
    var e = new Error(message);
    e.code = code || 'format';
    e.userFacing = true;
    return e;
  }

  /* ---------------- XML ---------------- */

  var ENT = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

  function decodeEntities(s) {
    if (s.indexOf('&') < 0) return s;
    return s.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, function (m, e) {
      if (e.charAt(0) === '#') {
        var code = (e.charAt(1) === 'x' || e.charAt(1) === 'X') ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        try { return isFinite(code) ? String.fromCodePoint(code) : m; } catch (err) { return m; }
      }
      return Object.prototype.hasOwnProperty.call(ENT, e) ? ENT[e] : m;
    });
  }

  function localName(n) {
    var i = n.indexOf(':');
    return i >= 0 ? n.slice(i + 1) : n;
  }

  function parseAttrs(s) {
    var out = {};
    var re = /([^\s=\/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
    var m;
    while ((m = re.exec(s)) !== null) {
      var v = decodeEntities(m[2] !== undefined ? m[2] : m[3]);
      out[m[1]] = v;
      var ln = localName(m[1]);
      if (!(ln in out)) out[ln] = v;
    }
    return out;
  }

  /** Tiny XML parser: returns {name:'#root', children:[...]} with element nodes {name, attrs, children} and text nodes {text}. */
  function parseXml(xml) {
    var rootNode = { name: '#root', attrs: {}, children: [] };
    var stack = [rootNode];
    var re = /<!\[CDATA\[([\s\S]*?)\]\]>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<(\/)?([A-Za-z_][\w.:-]*)((?:\s+[^\s=\/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/)?>|([^<]+)/g;
    var m;
    while ((m = re.exec(xml)) !== null) {
      var top = stack[stack.length - 1];
      if (m[1] !== undefined) { top.children.push({ text: m[1] }); continue; }
      if (m[3] !== undefined) {
        var name = localName(m[3]);
        if (m[2]) {
          for (var i = stack.length - 1; i > 0; i--) {
            if (stack[i].name === name) { stack.length = i; break; }
          }
          continue;
        }
        var node = { name: name, attrs: parseAttrs(m[4] || ''), children: [] };
        top.children.push(node);
        if (!m[5]) stack.push(node);
        continue;
      }
      if (m[6] !== undefined) top.children.push({ text: decodeEntities(m[6]) });
    }
    return rootNode;
  }

  function findAll(node, name, out) {
    out = out || [];
    if (!node || !node.children) return out;
    for (var i = 0; i < node.children.length; i++) {
      var c = node.children[i];
      if (c.name === name) out.push(c);
      if (c.children) findAll(c, name, out);
    }
    return out;
  }

  function findFirst(node, name) {
    if (!node || !node.children) return null;
    for (var i = 0; i < node.children.length; i++) {
      var c = node.children[i];
      if (c.name === name) return c;
      if (c.children) {
        var f = findFirst(c, name);
        if (f) return f;
      }
    }
    return null;
  }

  function childByName(node, name) {
    if (!node || !node.children) return null;
    for (var i = 0; i < node.children.length; i++) if (node.children[i].name === name) return node.children[i];
    return null;
  }

  function textOf(node) {
    if (!node) return '';
    if (node.text !== undefined) return node.text;
    var s = '';
    for (var i = 0; i < node.children.length; i++) s += textOf(node.children[i]);
    return s;
  }

  /** Text of a shared-string item or inline string: all <t> runs, ignoring phonetic runs. */
  function richText(node) {
    var s = '';
    (function walk(n) {
      if (!n || !n.children) return;
      for (var i = 0; i < n.children.length; i++) {
        var c = n.children[i];
        if (c.name === 'rPh' || c.name === 'phoneticPr') continue;
        if (c.name === 't') s += textOf(c);
        else if (c.children) walk(c);
      }
    })(node);
    return s;
  }

  /* ---------------- XLSX reading ---------------- */

  function decodeRef(ref) {
    var m = /^\$?([A-Za-z]+)\$?(\d+)$/.exec(ref || '');
    if (!m) return null;
    var letters = m[1].toUpperCase();
    var c = 0;
    for (var i = 0; i < letters.length; i++) c = c * 26 + (letters.charCodeAt(i) - 64);
    return { c: c - 1, r: parseInt(m[2], 10) - 1 };
  }

  function colLetter(c) {
    var s = '';
    c = c + 1;
    while (c > 0) { var m = (c - 1) % 26; s = String.fromCharCode(65 + m) + s; c = Math.floor((c - 1) / 26); }
    return s;
  }

  function resolvePath(baseDir, target) {
    if (!target) return '';
    if (target.charAt(0) === '/') return target.slice(1);
    var parts = (baseDir + target).split('/');
    var out = [];
    for (var i = 0; i < parts.length; i++) {
      if (parts[i] === '..') out.pop();
      else if (parts[i] !== '.' && parts[i] !== '') out.push(parts[i]);
    }
    return out.join('/');
  }

  function zipFile(zip, path) {
    var f = zip.file(path);
    if (f) return f;
    var lower = path.toLowerCase();
    var found = null;
    zip.forEach(function (p, entry) { if (!found && p.toLowerCase() === lower) found = entry; });
    return found;
  }

  function cellValue(c, shared) {
    var t = c.attrs.t || 'n';
    var v = childByName(c, 'v');
    var vText = v ? textOf(v) : null;
    switch (t) {
      case 's': {
        var i = parseInt(vText, 10);
        return (isFinite(i) && shared[i] !== undefined) ? shared[i] : null;
      }
      case 'inlineStr': {
        var is = childByName(c, 'is');
        return is ? richText(is) : (vText !== null ? vText : null);
      }
      case 'str': return vText !== null ? vText : null;
      case 'b': return vText === '1' || vText === 'true';
      case 'e': return null;
      case 'd': return vText;
      default: {
        if (vText === null || vText === '') return null;
        var n = Number(vText);
        return isFinite(n) ? n : vText;
      }
    }
  }

  function parseSheet(doc, shared) {
    var rows = [];
    var sheetData = findFirst(doc, 'sheetData');
    if (!sheetData) return rows;
    var nextRow = 0;
    for (var i = 0; i < sheetData.children.length; i++) {
      var rowNode = sheetData.children[i];
      if (rowNode.name !== 'row') continue;
      var rAttr = parseInt(rowNode.attrs.r, 10);
      var ri = isFinite(rAttr) ? rAttr - 1 : nextRow;
      nextRow = ri + 1;
      var arr = rows[ri] || (rows[ri] = []);
      var nextCol = 0;
      for (var j = 0; j < rowNode.children.length; j++) {
        var c = rowNode.children[j];
        if (c.name !== 'c') continue;
        var ci = nextCol;
        if (c.attrs.r) { var ref = decodeRef(c.attrs.r); if (ref) ci = ref.c; }
        nextCol = ci + 1;
        arr[ci] = cellValue(c, shared);
      }
    }
    for (var r = 0; r < rows.length; r++) {
      if (!rows[r]) rows[r] = [];
      for (var k = 0; k < rows[r].length; k++) if (rows[r][k] === undefined) rows[r][k] = null;
    }
    return rows;
  }

  function readXlsx(buf) {
    var JSZ = getJSZip();
    return JSZ.loadAsync(buf).then(function (zip) {
      var wbFile = zipFile(zip, 'xl/workbook.xml');
      if (!wbFile) {
        if (zipFile(zip, 'content.xml')) {
          throw FileFormatError('This looks like an OpenDocument spreadsheet (.ods). Save it as an Excel workbook (.xlsx) and upload it again.', 'ods');
        }
        if (zipFile(zip, 'Index/Document.iwa')) {
          throw FileFormatError('This looks like an Apple Numbers file. Export it to Excel (.xlsx) and upload it again.', 'numbers');
        }
        throw FileFormatError('This zip file is not an Excel workbook. Upload an .xlsx or .csv file.', 'zip');
      }
      var relsFile = zipFile(zip, 'xl/_rels/workbook.xml.rels');
      return Promise.all([wbFile.async('string'), relsFile ? relsFile.async('string') : Promise.resolve('')])
        .then(function (res) {
          var wb = parseXml(res[0]);
          var rels = {};
          if (res[1]) {
            findAll(parseXml(res[1]), 'Relationship').forEach(function (r) {
              rels[r.attrs.Id] = { target: r.attrs.Target, type: r.attrs.Type || '' };
            });
          }
          var ssPath = 'xl/sharedStrings.xml';
          Object.keys(rels).forEach(function (id) {
            if (/sharedStrings$/i.test(rels[id].type)) ssPath = resolvePath('xl/', rels[id].target);
          });
          var ssFile = zipFile(zip, ssPath);
          return (ssFile ? ssFile.async('string') : Promise.resolve('')).then(function (ssXml) {
            var shared = ssXml ? findAll(parseXml(ssXml), 'si').map(richText) : [];
            var sheetNodes = findAll(wb, 'sheet');
            var jobs = [];
            sheetNodes.forEach(function (s, idx) {
              var rid = s.attrs['r:id'] || s.attrs.id;
              var rel = rid ? rels[rid] : null;
              if (rel && rel.type && !/\/worksheet$/i.test(rel.type)) return; // chart sheets etc.
              var path = rel ? resolvePath('xl/', rel.target) : 'xl/worksheets/sheet' + (idx + 1) + '.xml';
              var f = zipFile(zip, path);
              if (!f) return;
              jobs.push(f.async('string').then(function (xml) {
                return { name: s.attrs.name || ('Sheet' + (idx + 1)), rows: parseSheet(parseXml(xml), shared) };
              }));
            });
            return Promise.all(jobs);
          });
        })
        .then(function (sheets) {
          if (!sheets.length) throw FileFormatError('The workbook has no worksheets with data.', 'empty');
          return { format: 'xlsx', sheets: sheets };
        });
    });
  }

  /* ---------------- CSV ---------------- */

  function countOutsideQuotes(line, d) {
    var n = 0, q = false;
    for (var i = 0; i < line.length; i++) {
      var ch = line.charAt(i);
      if (ch === '"') q = !q;
      else if (!q && ch === d) n++;
    }
    return n;
  }

  function detectDelimiter(text) {
    var lines = text.split(/\r\n|\n|\r/).filter(function (l) { return l.trim() !== ''; }).slice(0, 30);
    var best = ',', bestScore = 0;
    [',', ';', '\t', '|'].forEach(function (d) {
      var counts = lines.map(function (l) { return countOutsideQuotes(l, d); });
      var withD = counts.filter(function (c) { return c > 0; }).length;
      var total = counts.reduce(function (a, b) { return a + b; }, 0);
      var score = withD >= Math.max(1, Math.ceil(lines.length / 2)) ? total : 0;
      if (score > bestScore) { bestScore = score; best = d; }
    });
    return best;
  }

  function parseCSV(text) {
    text = String(text || '').replace(/^﻿/, '');
    var d = detectDelimiter(text);
    var rows = [], row = [], cell = '', q = false, quotedCell = false;
    function pushCell() {
      var v = quotedCell ? cell : cell.trim();
      row.push(v);
      cell = ''; quotedCell = false;
    }
    for (var i = 0; i < text.length; i++) {
      var ch = text.charAt(i);
      if (q) {
        if (ch === '"') {
          if (text.charAt(i + 1) === '"') { cell += '"'; i++; }
          else q = false;
        } else cell += ch;
        continue;
      }
      if (ch === '"' && cell.trim() === '') { q = true; quotedCell = true; cell = ''; continue; }
      if (ch === d) { pushCell(); continue; }
      if (ch === '\r' || ch === '\n') {
        if (ch === '\r' && text.charAt(i + 1) === '\n') i++;
        pushCell(); rows.push(row); row = [];
        continue;
      }
      cell += ch;
    }
    if (cell !== '' || row.length) { pushCell(); rows.push(row); }
    var decimalComma = d === ';';
    return rows.map(function (r) {
      return r.map(function (v) {
        if (v === '') return null;
        var s = v;
        if (decimalComma && /^\s*[-+]?\d+,\d+(e[-+]?\d+)?\s*$/i.test(s)) s = s.replace(',', '.');
        if (/^\s*[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?\s*$/i.test(s)) return Number(s);
        return v;
      });
    });
  }

  /* ---------------- entry point ---------------- */

  function sniff(bytes) {
    if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4B && (bytes[2] === 0x03 || bytes[2] === 0x05) ) return 'zip';
    if (bytes.length >= 8 && bytes[0] === 0xD0 && bytes[1] === 0xCF && bytes[2] === 0x11 && bytes[3] === 0xE0) return 'ole';
    return 'text';
  }

  function decodeText(bytes) {
    try {
      if (typeof TextDecoder !== 'undefined') return new TextDecoder('utf-8').decode(bytes);
    } catch (e) { /* fall through */ }
    var s = '';
    for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return s;
  }

  function readWorkbook(arrayBuffer, fileName) {
    var bytes = arrayBuffer instanceof Uint8Array ? arrayBuffer : new Uint8Array(arrayBuffer);
    var kind = sniff(bytes);
    var name = String(fileName || '').toLowerCase();
    if (kind === 'zip') {
      return readXlsx(bytes).catch(function (err) {
        if (err && err.userFacing) throw err;
        throw FileFormatError('This file could not be opened as an Excel workbook. It may be damaged. Open it in Excel, save it again as .xlsx, and upload the new file.', 'corrupt');
      });
    }
    if (kind === 'ole') {
      if (/\.(xlsx|xlsm)$/.test(name)) {
        return Promise.reject(FileFormatError('This workbook is password-protected. Remove the password in Excel (File > Info > Protect Workbook), save, and upload it again.', 'encrypted'));
      }
      return Promise.reject(FileFormatError('This is an older Excel 97–2003 file (.xls). In Excel choose File > Save As > Excel Workbook (.xlsx), then upload the new file.', 'xls'));
    }
    if (/\.(xlsx|xlsm|xls|ods)$/.test(name)) {
      return Promise.reject(FileFormatError('This file could not be opened as an Excel workbook. It may be damaged or password-protected.', 'corrupt'));
    }
    var text = decodeText(bytes);
    if (/[\u0000-\u0008\u000E-\u001F]/.test(text.slice(0, 2000))) {
      return Promise.reject(FileFormatError('This file is not a spreadsheet. Upload an Excel workbook (.xlsx) or a CSV file.', 'binary'));
    }
    var rows = parseCSV(text);
    if (!rows.length) return Promise.reject(FileFormatError('The file is empty.', 'empty'));
    var sheetName = (String(fileName || 'Data').replace(/^.*[\\\/]/, '').replace(/\.[^.]+$/, '') || 'Data');
    return Promise.resolve({ format: 'csv', sheets: [{ name: sheetName, rows: rows }] });
  }

  /* ---------------- XLSX writing ---------------- */

  function xmlEscape(s) {
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
  }

  function sheetXml(sheet) {
    var rows = sheet.rows || [];
    var headerRows = sheet.headerRows || 0;
    var parts = [];
    parts.push('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>');
    parts.push('<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">');
    if (headerRows > 0) {
      parts.push('<sheetViews><sheetView workbookViewId="0"><pane ySplit="' + headerRows + '" topLeftCell="A' + (headerRows + 1) + '" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>');
    }
    parts.push('<sheetFormatPr defaultRowHeight="15"/>');
    if (sheet.colWidths && sheet.colWidths.length) {
      parts.push('<cols>');
      sheet.colWidths.forEach(function (w, i) {
        parts.push('<col min="' + (i + 1) + '" max="' + (i + 1) + '" width="' + w + '" customWidth="1"/>');
      });
      parts.push('</cols>');
    }
    parts.push('<sheetData>');
    rows.forEach(function (row, r) {
      var cells = [];
      (row || []).forEach(function (v, c) {
        if (v === null || v === undefined || v === '') return;
        var ref = colLetter(c) + (r + 1);
        var style = r < headerRows ? ' s="1"' : '';
        if (typeof v === 'number') {
          if (!isFinite(v)) return;
          cells.push('<c r="' + ref + '"' + style + '><v>' + String(v) + '</v></c>');
        } else if (typeof v === 'boolean') {
          cells.push('<c r="' + ref + '"' + style + ' t="b"><v>' + (v ? 1 : 0) + '</v></c>');
        } else {
          cells.push('<c r="' + ref + '"' + style + ' t="inlineStr"><is><t xml:space="preserve">' + xmlEscape(v) + '</t></is></c>');
        }
      });
      parts.push('<row r="' + (r + 1) + '">' + cells.join('') + '</row>');
    });
    parts.push('</sheetData>');
    parts.push('</worksheet>');
    return parts.join('');
  }

  function safeSheetName(name, used) {
    var n = String(name || 'Sheet').replace(/[\\\/\?\*\[\]:]/g, ' ').trim().slice(0, 31) || 'Sheet';
    var base = n, k = 2;
    while (used[n.toLowerCase()]) { n = (base.slice(0, 28) + ' ' + k++); }
    used[n.toLowerCase()] = true;
    return n;
  }

  function writeXlsx(sheets) {
    var JSZ = getJSZip();
    var zip = new JSZ();
    var used = {};
    var names = sheets.map(function (s) { return safeSheetName(s.name, used); });
    var ct = ['<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">',
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
      '<Default Extension="xml" ContentType="application/xml"/>',
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>',
      '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'];
    sheets.forEach(function (s, i) {
      ct.push('<Override PartName="/xl/worksheets/sheet' + (i + 1) + '.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>');
    });
    ct.push('</Types>');
    zip.file('[Content_Types].xml', ct.join(''));
    zip.file('_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
      '</Relationships>');
    var wb = ['<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
      '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">',
      '<bookViews><workbookView/></bookViews><sheets>'];
    names.forEach(function (n, i) { wb.push('<sheet name="' + xmlEscape(n) + '" sheetId="' + (i + 1) + '" r:id="rId' + (i + 1) + '"/>'); });
    wb.push('</sheets></workbook>');
    zip.file('xl/workbook.xml', wb.join(''));
    var rels = ['<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'];
    sheets.forEach(function (s, i) {
      rels.push('<Relationship Id="rId' + (i + 1) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet' + (i + 1) + '.xml"/>');
    });
    rels.push('<Relationship Id="rId' + (sheets.length + 1) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>');
    rels.push('</Relationships>');
    zip.file('xl/_rels/workbook.xml.rels', rels.join(''));
    zip.file('xl/styles.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      '<fonts count="2"><font><sz val="11"/><name val="Calibri"/><family val="2"/></font><font><b/><sz val="11"/><name val="Calibri"/><family val="2"/></font></fonts>' +
      '<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>' +
      '<fill><patternFill patternType="solid"><fgColor rgb="FFE6EFEA"/><bgColor indexed="64"/></patternFill></fill></fills>' +
      '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
      '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
      '<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
      '<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/></cellXfs>' +
      '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
      '</styleSheet>');
    sheets.forEach(function (s, i) { zip.file('xl/worksheets/sheet' + (i + 1) + '.xml', sheetXml(s)); });
    return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE', compressionOptions: { level: 6 } });
  }

  function toCSV(rows) {
    return rows.map(function (r) {
      return (r || []).map(function (v) {
        if (v === null || v === undefined) return '';
        var s = String(v);
        return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
      }).join(',');
    }).join('\r\n');
  }

  return {
    readWorkbook: readWorkbook,
    readXlsx: readXlsx,
    parseCSV: parseCSV,
    parseXml: parseXml,
    writeXlsx: writeXlsx,
    toCSV: toCSV,
    colLetter: colLetter,
    decodeRef: decodeRef
  };
});
