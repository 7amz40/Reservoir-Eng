/*
 * parser.js
 * Turns the cells of a workbook into the inputs of the material balance:
 *   1. finds the production / PVT table (any sheet, any header row, any column order),
 *   2. maps its columns to p, Np, Gp (or Rp), Bo, Rs, Bg (+ optional Wp, Bw),
 *   3. finds the initial reservoir parameters (separate sheet or a block in the same sheet),
 *   4. works out units (from headers, a units row, the cells, or the values themselves),
 *   5. converts everything to base units and fills gaps (e.g. Boi from the row at pi).
 * Works in the browser (global HOParser) and in Node (module.exports).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./units.js'));
  else root.HOParser = factory(root.HOUnits);
})(typeof self !== 'undefined' ? self : this, function (U) {
  'use strict';

  /* ---------------- definitions ---------------- */

  var FIELDS = {
    p: {
      label: 'Average reservoir pressure', symbol: 'p', kind: 'pressure', required: true,
      exact: ['p', 'pr', 'pres', 'press', 'pressure', 'pavg', 'pbar', 'pav', 'ps', 'pressurepsia', 'avgp', 'averagep',
        'avgpressure', 'averagepressure', 'reservoirpressure', 'avgreservoirpressure', 'averagereservoirpressure',
        'staticpressure', 'pstatic', 'preservoir', 'reservoirp'],
      tokens: ['p', 'pr', 'pavg', 'pressure'],
      contains: [['pressure']],
      neg: ['initial', 'bubble', 'saturation', 'original', 'dew', 'abandon']
    },
    Np: {
      label: 'Cumulative oil produced', symbol: 'N_p', kind: 'oil', required: true,
      exact: ['np', 'npcum', 'cumoil', 'cumulativeoil', 'oilcum', 'cumoilproduced', 'cumulativeoilproduced', 'oilproduced',
        'cumulativeoilproduction', 'cumoilproduction', 'producedoil', 'cumulativeproducedoil', 'cumoilprod', 'cumulativeoilprod'],
      tokens: ['np'],
      contains: [['cum', 'oil'], ['oil', 'produced'], ['oil', 'production']],
      neg: ['rate', 'daily', 'perday', 'initial', 'inplace', 'ratio', 'gor', 'fvf']
    },
    Gp: {
      label: 'Cumulative gas produced', symbol: 'G_p', kind: 'gas', required: false,
      exact: ['gp', 'gpcum', 'cumgas', 'cumulativegas', 'gascum', 'cumgasproduced', 'cumulativegasproduced', 'gasproduced',
        'cumulativegasproduction', 'cumgasproduction', 'producedgas', 'cumulativeproducedgas', 'cumgasprod'],
      tokens: ['gp'],
      contains: [['cum', 'gas'], ['gas', 'produced'], ['gas', 'production']],
      neg: ['rate', 'daily', 'perday', 'ratio', 'gor', 'gasoil', 'initial', 'inplace', 'fvf', 'cap']
    },
    Rp: {
      label: 'Cumulative produced GOR', symbol: 'R_p', kind: 'gor', required: false,
      exact: ['rp', 'rpcum', 'cumgor', 'cumulativegor', 'cumulativegasoilratio', 'cumgasoilratio', 'cumulativeproducedgor',
        'cumulativeproducedgasoilratio', 'cumulativeproducinggor', 'producedgor', 'cumproducedgor'],
      tokens: ['rp'],
      contains: [['cum', 'gor'], ['cum', 'gasoil'], ['cumulative', 'ratio']],
      neg: ['solution', 'initial']
    },
    Bo: {
      label: 'Oil formation volume factor', symbol: 'B_o', kind: 'bo', required: true,
      exact: ['bo', 'oilfvf', 'fvfoil', 'oilformationvolumefactor', 'formationvolumefactoroil', 'oilvolumefactor', 'boil'],
      tokens: ['bo'],
      contains: [['oil', 'formationvolume'], ['oil', 'fvf'], ['oil', 'volumefactor']],
      neg: ['initial', 'gas', 'water', 'twophase', 'total', 'cum']
    },
    Rs: {
      label: 'Solution gas-oil ratio', symbol: 'R_s', kind: 'gor', required: true,
      exact: ['rs', 'rso', 'solutiongor', 'solutiongasoilratio', 'gassolubility', 'solgor', 'dissolvedgor', 'solutiongas',
        'dissolvedgasoilratio', 'solutiongasratio'],
      tokens: ['rs'],
      contains: [['solution', 'gor'], ['solution', 'gasoil'], ['solution', 'gas'], ['dissolved', 'gas'], ['solubility']],
      neg: ['initial', 'cum']
    },
    Bg: {
      label: 'Gas formation volume factor', symbol: 'B_g', kind: 'bg', required: true,
      exact: ['bg', 'gasfvf', 'fvfgas', 'gasformationvolumefactor', 'formationvolumefactorgas', 'gasvolumefactor'],
      tokens: ['bg'],
      contains: [['gas', 'formationvolume'], ['gas', 'fvf'], ['gas', 'volumefactor']],
      neg: ['initial', 'oil', 'expansion']
    },
    Wp: {
      label: 'Cumulative water produced', symbol: 'W_p', kind: 'oil', required: false, optional: true,
      exact: ['wp', 'wpcum', 'cumwater', 'cumulativewater', 'watercum', 'cumwaterproduced', 'cumulativewaterproduced',
        'waterproduced', 'cumulativewaterproduction', 'producedwater'],
      tokens: ['wp'],
      contains: [['cum', 'water'], ['water', 'produced'], ['water', 'production']],
      neg: ['rate', 'cut', 'influx', 'daily', 'fvf', 'saturation', 'compress']
    },
    Bw: {
      label: 'Water formation volume factor', symbol: 'B_w', kind: 'bw', required: false, optional: true,
      exact: ['bw', 'waterfvf', 'fvfwater', 'waterformationvolumefactor', 'watervolumefactor'],
      tokens: ['bw'],
      contains: [['water', 'formationvolume'], ['water', 'fvf']],
      neg: ['initial']
    }
  };
  var FIELD_ORDER = ['p', 'Np', 'Gp', 'Rp', 'Bo', 'Rs', 'Bg', 'Wp', 'Bw'];
  var CORE_FIELDS = ['p', 'Np', 'Bo', 'Rs', 'Bg'];

  var PARAMS = {
    pi: {
      label: 'Initial reservoir pressure', symbol: 'p_i', kind: 'pressure',
      exact: ['pi', 'pinitial', 'pinit', 'pio', 'initialpressure', 'initialreservoirpressure', 'pressureinitial', 'originalpressure',
        'originalreservoirpressure', 'initialavgpressure', 'initialaveragepressure'],
      tokens: ['pi'],
      contains: [['initial', 'pressure'], ['original', 'pressure']],
      neg: ['bubble', 'saturation']
    },
    Boi: {
      label: 'Initial oil FVF', symbol: 'B_oi', kind: 'bo',
      exact: ['boi', 'initialoilfvf', 'initialoilformationvolumefactor', 'oilfvfinitial', 'initialbo', 'bo0'],
      tokens: ['boi'],
      contains: [['initial', 'oil', 'fvf'], ['initial', 'oil', 'formationvolume'], ['initial', 'oil', 'volumefactor']],
      neg: []
    },
    Bgi: {
      label: 'Initial gas FVF', symbol: 'B_gi', kind: 'bg',
      exact: ['bgi', 'initialgasfvf', 'initialgasformationvolumefactor', 'gasfvfinitial', 'initialbg', 'bg0'],
      tokens: ['bgi'],
      contains: [['initial', 'gas', 'fvf'], ['initial', 'gas', 'formationvolume'], ['initial', 'gas', 'volumefactor']],
      neg: []
    },
    Rsi: {
      label: 'Initial solution GOR', symbol: 'R_si', kind: 'gor',
      exact: ['rsi', 'initialsolutiongor', 'initialsolutiongasoilratio', 'initialrs', 'initialgor', 'rsinitial', 'rs0'],
      tokens: ['rsi'],
      contains: [['initial', 'solution'], ['initial', 'gor'], ['initial', 'gasoil']],
      neg: []
    },
    Swc: {
      label: 'Connate water saturation', symbol: 'S_wc', kind: 'frac',
      exact: ['swc', 'swi', 'sw', 'swirr', 'connatewatersaturation', 'connatewater', 'initialwatersaturation',
        'irreduciblewatersaturation', 'watersaturation'],
      tokens: ['swc', 'swi'],
      contains: [['connate', 'water'], ['water', 'saturation'], ['irreducible', 'water']],
      neg: ['compress']
    },
    Cw: {
      label: 'Water compressibility', symbol: 'C_w', kind: 'comp',
      exact: ['cw', 'watercompressibility', 'compressibilityofwater', 'cwater'],
      tokens: ['cw'],
      contains: [['water', 'compress']],
      neg: []
    },
    Cf: {
      label: 'Formation compressibility', symbol: 'C_f', kind: 'comp',
      exact: ['cf', 'cr', 'formationcompressibility', 'rockcompressibility', 'porecompressibility', 'porevolumecompressibility',
        'compressibilityofformation', 'compressibilityofrock'],
      tokens: ['cf'],
      contains: [['formation', 'compress'], ['rock', 'compress'], ['pore', 'compress']],
      neg: ['water', 'oil', 'gas', 'total']
    },
    phi: {
      label: 'Porosity', symbol: 'φ', kind: 'frac',
      exact: ['phi', 'porosity', 'por', 'averageporosity', 'avgporosity'],
      tokens: ['phi', 'porosity'],
      contains: [['porosity']],
      neg: []
    },
    m: {
      label: 'Gas-cap ratio (given)', symbol: 'm', kind: 'ratio',
      exact: ['m', 'gascapratio', 'gascapsize', 'initialgascapratio', 'gascaptooilratio', 'gascapvolumeratio', 'gascapoilratio'],
      tokens: [],
      contains: [['gas', 'cap', 'ratio'], ['gas', 'cap', 'size']],
      neg: ['inplace', 'gip']
    }
  };
  var PARAM_ORDER = ['pi', 'Boi', 'Bgi', 'Rsi', 'Swc', 'Cw', 'Cf', 'phi', 'm'];

  /* ---------------- header helpers ---------------- */

  function normKey(s) {
    return U.cleanText(s).toLowerCase().replace(/[φϕ]/g, 'phi').replace(/[^a-z0-9]/g, '');
  }

  function tokensOf(name) {
    return U.cleanText(name).toLowerCase().replace(/[φϕ]/g, 'phi')
      .split(/[\s,;:\/\-\.\(\)\[\]]+/)
      .map(function (t) { return t.replace(/[^a-z0-9]/g, ''); })
      .filter(Boolean);
  }

  /** "Np (MMSTB)" -> {name:'Np', unit:'MMSTB'}; also handles [unit], "name, unit", "name in unit". */
  function splitHeader(raw) {
    var s = U.cleanText(raw);
    var name = s, unit = '';
    var m = s.match(/^(.*?)[\s,]*[\(\[\{]\s*([^\)\]\}]*?)\s*[\)\]\}]\s*$/);
    if (m && m[1].trim()) { name = m[1]; unit = m[2]; }
    else {
      var m2 = s.match(/^(.*?)\s*,\s*([^,]+)$/);
      if (m2 && U.isUnitLike(m2[2])) { name = m2[1]; unit = m2[2]; }
      else {
        var m3 = s.match(/^(.*?)\s+in\s+(.+)$/i);
        if (m3 && U.isUnitLike(m3[2])) { name = m3[1]; unit = m3[2]; }
        else {
          var m4 = s.match(/^(\S+)\s+(\S+)$/);
          if (m4 && U.isUnitLike(m4[2]) && !U.isUnitLike(m4[1])) { name = m4[1]; unit = m4[2]; }
        }
      }
    }
    name = name.trim();
    return { raw: s, name: name, unit: unit.trim(), key: normKey(name), tokens: tokensOf(name) };
  }

  function matchDef(info, defs, order) {
    if (!info.key) return null;
    var best = null;
    for (var i = 0; i < order.length; i++) {
      var f = order[i], d = defs[f], rank = 0;
      if (d.exact.indexOf(info.key) >= 0) rank = 3;
      else if (info.tokens.length <= 5 && d.tokens.some(function (t) { return info.tokens.indexOf(t) >= 0; })) rank = 2;
      else if (d.contains.some(function (parts) { return parts.every(function (p) { return info.key.indexOf(p) >= 0; }); })) rank = 1;
      if (rank > 0 && rank < 3 && d.neg.some(function (n) { return info.key.indexOf(n) >= 0; })) rank = 0;
      if (rank > 0 && (!best || rank > best.rank)) best = { field: f, rank: rank };
      else if (rank > 0 && best && rank === best.rank) best.ambiguous = true;
    }
    if (best && best.ambiguous && best.rank < 3) return null;
    return best;
  }

  function matchField(info) { return matchDef(info, FIELDS, FIELD_ORDER); }
  function matchParam(info) { return matchDef(info, PARAMS, PARAM_ORDER); }

  function isEmpty(v) { return v === null || v === undefined || (typeof v === 'string' && v.trim() === ''); }
  function isEmptyRow(row) { return !row || row.every(isEmpty); }

  /** Score a row as a production-table header. */
  function scoreHeaderRow(row) {
    var matches = {};
    (row || []).forEach(function (cell, idx) {
      if (typeof cell !== 'string' || !cell.trim()) return;
      var info = splitHeader(cell);
      var mt = matchField(info);
      if (!mt) return;
      var prev = matches[mt.field];
      if (!prev || mt.rank > prev.rank) matches[mt.field] = { index: idx, rank: mt.rank, info: info };
    });
    var score = 0, rankSum = 0;
    CORE_FIELDS.forEach(function (f) { if (matches[f]) { score++; rankSum += matches[f].rank; } });
    if (matches.Gp || matches.Rp) { score++; rankSum += (matches.Gp || matches.Rp).rank; }
    return { score: score, rankSum: rankSum, matches: matches };
  }

  function isNumericCell(v) {
    if (typeof v === 'number') return isFinite(v);
    if (typeof v !== 'string') return false;
    var p = U.parseNumberWithUnit(v);
    return !!p && !p.unit;
  }

  /** Two-row headers (names on one row, more names or units on the next) are merged column by column. */
  function mergeHeaderRows(a, b) {
    var w = Math.max((a || []).length, (b || []).length), out = [];
    for (var c = 0; c < w; c++) {
      var parts = [];
      [a && a[c], b && b[c]].forEach(function (v) {
        if (v !== null && v !== undefined && String(v).trim()) parts.push(String(v).trim());
      });
      out.push(parts.join(' '));
    }
    return out;
  }

  function textOnlyRow(row) {
    var strings = 0;
    for (var c = 0; c < (row || []).length; c++) {
      var v = row[c];
      if (isEmpty(v)) continue;
      if (isNumericCell(v)) return false;
      if (typeof v === 'string') strings++;
    }
    return strings >= 2;
  }

  /** Header row for a sheet's production table: {row, span, cells} or null. */
  function headerCells(rows, r, span) {
    return span === 2 ? mergeHeaderRows(rows[r], rows[r + 1]) : (rows[r] || []);
  }

  function findProductionTables(wb) {
    var cands = [];
    (wb.sheets || []).forEach(function (sheet, si) {
      var rows = sheet.rows || [];
      var bestHere = null;
      function consider(r, span) {
        var sc = scoreHeaderRow(headerCells(rows, r, span));
        if (sc.score >= 3 && (!bestHere || sc.score > bestHere.score || (sc.score === bestHere.score && sc.rankSum > bestHere.rankSum))) {
          bestHere = { sheetIndex: si, sheetName: sheet.name, headerRow: r, headerSpan: span, score: sc.score, rankSum: sc.rankSum };
        }
      }
      for (var r = 0; r < Math.min(rows.length, 80); r++) {
        consider(r, 1);
        if (textOnlyRow(rows[r + 1]) && !isEmptyRow(rows[r])) {
          var single = scoreHeaderRow(rows[r]).score;
          var merged = scoreHeaderRow(mergeHeaderRows(rows[r], rows[r + 1])).score;
          if (merged > single) consider(r, 2);
        }
      }
      if (bestHere) cands.push(bestHere);
    });
    cands.sort(function (a, b) { return (b.score - a.score) || (b.rankSum - a.rankSum) || (a.sheetIndex - b.sheetIndex); });
    return cands;
  }

  /* ---------------- production table ---------------- */

  function unitTextFromCell(v) {
    if (typeof v !== 'string') return '';
    var t = U.cleanText(v).replace(/^[\(\[\{]\s*|\s*[\)\]\}]$/g, '');
    return U.isUnitLike(t) ? t : '';
  }

  function extractProduction(sheet, headerRow, mappingOverride, headerSpan) {
    var rows = sheet.rows || [];
    var span = headerSpan === 2 ? 2 : 1;
    var hdr = headerCells(rows, headerRow, span);
    var auto = scoreHeaderRow(hdr).matches;
    var headers = [];
    var width = 0;
    rows.forEach(function (r) { if (r && r.length > width) width = r.length; });
    for (var c = 0; c < width; c++) {
      var txt = hdr[c] === null || hdr[c] === undefined ? '' : String(hdr[c]);
      headers.push({ index: c, text: txt.trim(), label: txt.trim() || ('Column ' + (c + 1)) });
    }

    var mapping = {}, mappingSource = {};
    FIELD_ORDER.forEach(function (f) {
      if (mappingOverride && Object.prototype.hasOwnProperty.call(mappingOverride, f)) {
        mapping[f] = mappingOverride[f];
        mappingSource[f] = 'user';
      } else {
        mapping[f] = auto[f] ? auto[f].index : -1;
        mappingSource[f] = auto[f] ? 'auto' : 'none';
      }
    });

    // Optional units row right below the header ("psia", "MMSTB", ...)
    var next = rows[headerRow + span] || [];
    var unitHits = 0;
    FIELD_ORDER.forEach(function (f) { if (mapping[f] >= 0 && unitTextFromCell(next[mapping[f]])) unitHits++; });
    var unitsRow = unitHits >= 2;
    var dataStart = headerRow + span + (unitsRow ? 1 : 0);

    var unitTexts = {};
    FIELD_ORDER.forEach(function (f) {
      var idx = mapping[f];
      if (idx < 0) return;
      var t = splitHeader(hdr[idx]).unit;
      if (!t && unitsRow) t = unitTextFromCell(next[idx]);
      unitTexts[f] = t || '';
    });

    var out = [], skipped = [], inlineUnits = {};
    var lastDataRow = dataStart - 1;
    for (var r = dataStart; r < rows.length; r++) {
      var row = rows[r] || [];
      if (isEmptyRow(row)) continue;
      if (r > dataStart && scoreHeaderRow(row).score >= 3) break; // another table starts here
      var rec = { sheetRow: r + 1 };
      var numericCore = 0;
      FIELD_ORDER.forEach(function (f) {
        var idx = mapping[f];
        if (idx === undefined || idx < 0) { rec[f] = NaN; return; }
        var parsed = U.parseNumberWithUnit(row[idx]);
        rec[f] = parsed ? parsed.value : NaN;
        if (parsed && parsed.unit && !inlineUnits[f]) inlineUnits[f] = parsed.unit;
        if (parsed && CORE_FIELDS.indexOf(f) >= 0) numericCore++;
      });
      if (!isFinite(rec.p) || numericCore < 3) continue; // not a data row (notes, a parameter block, totals)
      // only columns that are mapped can be "missing" in a row; an unmapped column is reported once, elsewhere
      var miss = CORE_FIELDS.filter(function (f) { return mapping[f] >= 0 && !isFinite(rec[f]); });
      if (!isFinite(rec.Gp) && !isFinite(rec.Rp)) {
        if (rec.Np === 0) rec.Gp = 0;
        else if (mapping.Gp >= 0 || mapping.Rp >= 0) miss.push(mapping.Gp >= 0 ? 'Gp' : 'Rp');
      }
      if (miss.length) {
        skipped.push({ sheetRow: r + 1, reason: 'missing ' + miss.join(', ') });
        continue;
      }
      out.push(rec);
      lastDataRow = r;
    }

    return {
      sheetName: sheet.name,
      headerRow: headerRow,
      headerSpan: span,
      dataStart: dataStart,
      lastDataRow: lastDataRow,
      unitsRow: unitsRow,
      headers: headers,
      mapping: mapping,
      mappingSource: mappingSource,
      unitTexts: unitTexts,
      inlineUnits: inlineUnits,
      rows: out,
      skipped: skipped
    };
  }

  /* ---------------- parameters ---------------- */

  function sheetPriority(name) {
    return /init|param|reservoir|additional|propert|input|rock|fluid|data/i.test(name || '') ? 0 : 1;
  }

  function stripBrackets(t) { return U.cleanText(t).replace(/^[\(\[\{]\s*|\s*[\)\]\}]$/g, ''); }
  function unitLikeCell(v) {
    if (typeof v !== 'string') return '';
    if (matchParam(splitHeader(v))) return ''; // "Cf" is a label here, not cubic feet
    var t = stripBrackets(v);
    return U.isUnitLike(t) ? t : '';
  }

  /** Value for a parameter label at (r, c): to the right on the same row, or below it (horizontal tables). */
  function lookupValue(rows, r, c) {
    var row = rows[r] || [];
    var pending = '';
    for (var j = c + 1; j <= c + 6 && j < row.length; j++) {
      var v = row[j];
      if (isEmpty(v)) continue;
      var parsed = U.parseNumberWithUnit(v);
      if (parsed) {
        var unit = parsed.unit || pending || unitLikeCell(row[j + 1]);
        return { value: parsed.value, unit: unit, percent: parsed.percent, r: r, c: j, raw: v };
      }
      var u = unitLikeCell(v);
      if (u) { pending = u; continue; }
      break; // another label: the value is not on this row
    }
    pending = '';
    for (var i = r + 1; i <= r + 3 && i < rows.length; i++) {
      var below = (rows[i] || [])[c];
      if (isEmpty(below)) continue;
      var p2 = U.parseNumberWithUnit(below);
      if (p2) return { value: p2.value, unit: p2.unit || pending, percent: p2.percent, r: i, c: c, raw: below };
      var u2 = unitLikeCell(below);
      if (u2) { pending = u2; continue; }
      break;
    }
    return null;
  }

  function findParams(wb, skip) {
    var found = {};
    var order = (wb.sheets || []).map(function (s, i) { return i; })
      .sort(function (a, b) { return sheetPriority(wb.sheets[a].name) - sheetPriority(wb.sheets[b].name) || a - b; });
    order.forEach(function (si) {
      var sheet = wb.sheets[si];
      var rows = sheet.rows || [];
      var skipFrom = -1, skipTo = -1;
      if (skip && si === skip.sheetIndex) {
        skipFrom = skip.headerRow;
        skipTo = skip.headerRow + (skip.headerSpan || 1) - 1 + (skip.unitsRow ? 1 : 0);
      }
      for (var r = 0; r < rows.length; r++) {
        if (r >= skipFrom && r <= skipTo) continue;
        var row = rows[r] || [];
        for (var c = 0; c < row.length; c++) {
          var cell = row[c];
          if (typeof cell !== 'string' || !cell.trim()) continue;
          var hit = null, info;
          // "pi = 2740 psia" or "Swc: 0.2" in a single cell
          var inline = U.cleanText(cell).match(/^(.*?[A-Za-z\)\]])\s*[=:]\s*([-+]?(?:\d|\.\d).*)$/);
          if (inline) {
            var pv = U.parseNumberWithUnit(inline[2]);
            if (pv) {
              info = splitHeader(inline[1]);
              hit = { value: pv.value, unit: pv.unit, percent: pv.percent, r: r, c: c, raw: inline[2] };
            }
          }
          if (!hit) info = splitHeader(cell);
          var mt = matchParam(info);
          if (!mt) continue;
          if (!hit) hit = lookupValue(rows, r, c);
          if (!hit) continue;
          var entry = {
            value: hit.value, unitText: hit.unit || info.unit || '', percent: hit.percent,
            where: sheet.name + '!' + colLetter(hit.c) + (hit.r + 1), label: info.raw, rank: mt.rank, raw: hit.raw
          };
          var prev = found[mt.field];
          if (!prev) found[mt.field] = entry;
          else if (mt.rank > prev.rank) { entry.duplicate = prev; found[mt.field] = entry; }
          else if (Math.abs(prev.value - entry.value) > 1e-12 * Math.max(1, Math.abs(prev.value))) prev.duplicate = entry;
        }
      }
    });
    return found;
  }

  function colLetter(c) {
    var s = ''; c = c + 1;
    while (c > 0) { var m = (c - 1) % 26; s = String.fromCharCode(65 + m) + s; c = Math.floor((c - 1) / 26); }
    return s;
  }

  /* ---------------- units ---------------- */

  function median(a) {
    var b = a.filter(isFinite).slice().sort(function (x, y) { return x - y; });
    if (!b.length) return NaN;
    var h = Math.floor(b.length / 2);
    return b.length % 2 ? b[h] : (b[h - 1] + b[h]) / 2;
  }

  function detectUnits(prod, params) {
    var units = {}, notes = [];
    function fromText(f) {
      var kind = FIELDS[f].kind;
      var t = prod.unitTexts[f];
      if (t) {
        var d = U.detectUnit(kind, t);
        if (d.matched) return { id: d.id, source: 'header', text: t, note: d.note };
      }
      var inl = prod.inlineUnits[f];
      if (inl) {
        var d2 = U.detectUnit(kind, inl);
        if (d2.matched) return { id: d2.id, source: 'cell', text: inl, note: d2.note };
      }
      return null;
    }
    var rows = prod.rows;

    // pressure
    units.p = fromText('p') || { id: 'psia', source: 'assumed', text: '' };

    // Np by magnitude when not stated
    units.Np = fromText('Np');
    if (!units.Np) {
      var maxNp = Math.max.apply(null, rows.map(function (r) { return r.Np; }).filter(isFinite).concat([0]));
      units.Np = { id: maxNp < 1e4 ? 'MMSTB' : 'STB', source: 'assumed', text: '' };
    }
    units.Wp = fromText('Wp') || { id: units.Np.id, source: 'assumed', text: '' };

    units.Rs = fromText('Rs') || { id: 'SCF/STB', source: 'assumed', text: '' };
    units.Rp = fromText('Rp') || { id: 'SCF/STB', source: 'assumed', text: '' };
    units.Bo = fromText('Bo') || { id: 'rb/STB', source: 'assumed', text: '' };
    units.Bw = fromText('Bw') || { id: 'rb/STB', source: 'assumed', text: '' };

    // Bg: ratio p*Bg separates rb/SCF (~1.8-4.2) from ft3/SCF (~10-24) for usual reservoir T and z
    var pB = rows.map(function (r) { return U.toBase('pressure', units.p.id, r.p) * r.Bg; }).filter(function (v) { return isFinite(v) && v > 0; });
    var medPB = median(pB);
    units.Bg = fromText('Bg');
    if (!units.Bg) {
      units.Bg = { id: (isFinite(medPB) && medPB > 7) ? 'ft3/SCF' : 'rb/SCF', source: isFinite(medPB) ? 'inferred' : 'assumed', text: '' };
    } else if (isFinite(medPB)) {
      var scaled = medPB * U.getUnit('bg', units.Bg.id).factor; // p * Bg in rb/SCF terms
      if (scaled > 7.5) notes.push({ level: 'warning', text: 'B_g values look larger than rb/SCF usually are (p·B_g ≈ ' + U.fmt(scaled, 1) + ' psia·rb/SCF). If they are in ft³/SCF, change the B_g unit in Columns and units.' });
      else if (scaled < 0.9) notes.push({ level: 'warning', text: 'B_g values look smaller than usual for ' + U.label('bg', units.Bg.id) + '. Check the B_g unit in Columns and units.' });
    }
    if (units.Bg.note) notes.push({ level: 'info', text: 'B_g unit "' + units.Bg.text + '": ' + units.Bg.note + '.' });

    // Gp: choose the multiplier that gives a sensible cumulative GOR when the header does not say
    units.Gp = fromText('Gp');
    if (!units.Gp && prod.mapping.Gp >= 0) {
      var rsRef = Math.max.apply(null, rows.map(function (r) { return U.toBase('gor', units.Rs.id, r.Rs); }).filter(isFinite).concat([1]));
      var cand = ['SCF', 'MSCF', 'MMSCF', 'MMMSCF'];
      var bestId = 'MMSCF', bestD = Infinity;
      cand.forEach(function (id) {
        var ratios = rows.filter(function (r) { return r.Np > 0 && r.Gp > 0; }).map(function (r) {
          return U.toBase('gas', id, r.Gp) / U.toBase('oil', units.Np.id, r.Np) / rsRef;
        });
        var md = median(ratios);
        if (!isFinite(md) || md <= 0) return;
        var dist = Math.abs(Math.log10(md) - Math.log10(1.6));
        if (dist < bestD) { bestD = dist; bestId = id; }
      });
      units.Gp = { id: bestId, source: isFinite(bestD) ? 'inferred' : 'assumed', text: '' };
    }
    if (!units.Gp) units.Gp = { id: 'MMSCF', source: 'assumed', text: '' };

    return { units: units, notes: notes };
  }

  /* ---------------- main analysis ---------------- */

  function analyzeWorkbook(wb, overrides) {
    overrides = overrides || {};
    var res = {
      ok: false, errors: [], warnings: [], infos: [],
      sheets: (wb.sheets || []).map(function (s, i) { return { index: i, name: s.name, rows: (s.rows || []).length }; }),
      candidates: [], production: null, params: {}, units: {}, unitSource: {}
    };
    if (!wb.sheets || !wb.sheets.length) {
      res.errors.push({ code: 'empty', text: 'The file has no sheets with data.' });
      return res;
    }
    res.candidates = findProductionTables(wb);

    var chosen = null;
    if (overrides.sheet !== undefined && overrides.sheet !== null && wb.sheets[overrides.sheet]) {
      chosen = res.candidates.filter(function (c) { return c.sheetIndex === overrides.sheet; })[0] ||
        { sheetIndex: overrides.sheet, sheetName: wb.sheets[overrides.sheet].name, headerRow: firstNonEmptyRow(wb.sheets[overrides.sheet]), score: 0 };
    } else {
      chosen = res.candidates[0] || null;
    }

    if (!chosen) {
      res.errors.push({
        code: 'no-table',
        text: 'No production table was found. The file needs a header row with columns for pressure (p), cumulative oil (Np), cumulative gas (Gp) or cumulative GOR (Rp), Bo, Rs and Bg.'
      });
      var fallbackIdx = 0;
      chosen = { sheetIndex: fallbackIdx, sheetName: wb.sheets[fallbackIdx].name, headerRow: firstNonEmptyRow(wb.sheets[fallbackIdx]), score: 0 };
    }

    var prod = extractProduction(wb.sheets[chosen.sheetIndex], chosen.headerRow, overrides.mapping, chosen.headerSpan);
    prod.sheetIndex = chosen.sheetIndex;
    res.production = prod;

    var missing = CORE_FIELDS.filter(function (f) { return prod.mapping[f] < 0; });
    if (prod.mapping.Gp < 0 && prod.mapping.Rp < 0) missing.push('Gp');
    if (missing.length && !res.errors.length) {
      res.errors.push({
        code: 'missing-columns', fields: missing,
        text: 'Missing column' + (missing.length > 1 ? 's' : '') + ': ' + missing.map(function (f) { return FIELDS[f].symbol; }).join(', ') +
          '. Rename the header in your file or choose the column under Columns and units.'
      });
    }
    if (!missing.length && !prod.rows.length) {
      res.errors.push({ code: 'no-rows', text: 'The production table on sheet "' + prod.sheetName + '" has a header but no rows with numbers.' });
    }
    if (!missing.length) {
      if (prod.skipped.length <= 3) {
        prod.skipped.forEach(function (s) {
          res.warnings.push({ code: 'skipped', text: 'Row ' + s.sheetRow + ' on sheet "' + prod.sheetName + '" was skipped: ' + s.reason.replace(/\b(Np|Gp|Rp|Bo|Rs|Bg)\b/g, function (f) { return FIELDS[f].symbol; }) + '.' });
        });
      } else {
        var list = prod.skipped.slice(0, 6).map(function (s) { return s.sheetRow; }).join(', ') + (prod.skipped.length > 6 ? ' and more' : '');
        res.warnings.push({ code: 'skipped', text: prod.skipped.length + ' rows on sheet "' + prod.sheetName + '" were skipped because a value is missing (rows ' + list + ').' });
      }
    }

    res.params = findParams(wb, { sheetIndex: chosen.sheetIndex, headerRow: prod.headerRow, headerSpan: prod.headerSpan, unitsRow: prod.unitsRow });
    PARAM_ORDER.forEach(function (k) {
      var p = res.params[k];
      if (p && p.duplicate) {
        res.warnings.push({ text: PARAMS[k].symbol + ' appears twice in the file (' + p.where + ' and ' + p.duplicate.where + ') with different values. Using ' + p.where + '.' });
      }
    });

    if (prod.rows.length) {
      var du = detectUnits(prod, res.params);
      res.units = {};
      res.unitSource = {};
      Object.keys(du.units).forEach(function (f) {
        var src = du.units[f].source;
        if (overrides.units && overrides.units[f]) { res.units[f] = overrides.units[f]; res.unitSource[f] = 'user'; }
        else { res.units[f] = du.units[f].id; res.unitSource[f] = src; }
        res.unitText = res.unitText || {};
        res.unitText[f] = du.units[f].text || '';
      });
      du.notes.forEach(function (n) { (n.level === 'warning' ? res.warnings : res.infos).push({ text: n.text }); });
    }

    res.ok = res.errors.length === 0;
    return res;
  }

  function firstNonEmptyRow(sheet) {
    var rows = sheet.rows || [];
    for (var r = 0; r < rows.length; r++) if (!isEmptyRow(rows[r])) return r;
    return 0;
  }

  /* ---------------- base-unit inputs for the engine ---------------- */

  var PARAM_BASE = {
    pi: { kind: 'pressure', unit: 'psia' },
    Boi: { kind: 'bo', unit: 'rb/STB' },
    Bgi: { kind: 'bg', unit: 'rb/SCF' },
    Rsi: { kind: 'gor', unit: 'SCF/STB' },
    Swc: { kind: 'frac', unit: 'fraction' },
    Cw: { kind: 'comp', unit: '1/psi' },
    Cf: { kind: 'comp', unit: '1/psi' },
    phi: { kind: 'frac', unit: 'fraction' },
    m: { kind: 'ratio', unit: '-' }
  };

  /**
   * settings: { params: {pi: number|null, ...} in base units (user edits), }
   * Returns {rows, params, paramInfo, initialRow, messages}
   */
  function buildInputs(analysis, settings) {
    settings = settings || {};
    var userParams = settings.params || {};
    var msgs = { errors: [], warnings: [], infos: [] };
    var u = analysis.units || {};
    var prod = analysis.production;
    if (!prod) return { rows: [], params: {}, paramInfo: {}, messages: msgs };

    var rows = prod.rows.map(function (r, i) {
      var o = { id: i, sheetRow: r.sheetRow };
      o.p = U.toBase('pressure', u.p, r.p);
      o.Np = U.toBase('oil', u.Np, r.Np);
      o.Bo = U.toBase('bo', u.Bo, r.Bo);
      o.Rs = U.toBase('gor', u.Rs, r.Rs);
      o.Bg = U.toBase('bg', u.Bg, r.Bg);
      if (prod.mapping.Gp >= 0 && isFinite(r.Gp)) o.Gp = U.toBase('gas', u.Gp, r.Gp);
      else if (isFinite(r.Rp)) o.Gp = U.toBase('gor', u.Rp, r.Rp) * o.Np;
      else o.Gp = (o.Np === 0) ? 0 : NaN;
      o.Wp = (prod.mapping.Wp >= 0 && isFinite(r.Wp)) ? U.toBase('oil', u.Wp, r.Wp) : 0;
      o.Bw = (prod.mapping.Bw >= 0 && isFinite(r.Bw)) ? U.toBase('bw', u.Bw, r.Bw) : 1;
      return o;
    });

    // keep the time order: sort by cumulative oil (stable), so unsorted tables give the same answer
    var order = rows.map(function (r, i) { return i; });
    order.sort(function (a, b) {
      var ra = rows[a], rb = rows[b];
      var d = (isFinite(ra.Np) ? ra.Np : Infinity) - (isFinite(rb.Np) ? rb.Np : Infinity);
      if (d) return d;
      return (rb.p - ra.p) || (a - b);
    });
    var moved = order.some(function (v, i) { return v !== i; });
    if (moved) {
      rows = order.map(function (i) { return rows[i]; });
      rows.forEach(function (r, i) { r.id = i; });
      msgs.infos.push({ code: 'sorted', text: 'The rows were not in time order, so they were sorted by cumulative oil N_p.' });
    }

    // initial row: first row with Np = 0, otherwise the highest pressure
    var initialRow = null;
    for (var i = 0; i < rows.length; i++) if (rows[i].Np === 0) { initialRow = rows[i]; break; }
    var maxRow = rows.reduce(function (a, b) { return (!a || b.p > a.p) ? b : a; }, null);

    var P = {}, info = {};
    function setParam(k, value, source, extra) {
      P[k] = value;
      info[k] = Object.assign({ source: source, value: value }, extra || {});
    }
    function fileParam(k, columnUnitKind, columnUnitId) {
      var fp = analysis.params ? analysis.params[k] : null;
      if (!fp) return null;
      var meta = PARAM_BASE[k];
      var unitId = null, unitSource = 'column';
      if (fp.unitText) {
        var d = U.detectUnit(meta.kind, fp.unitText);
        if (d.matched) { unitId = d.id; unitSource = 'file'; }
      }
      if (!unitId) unitId = columnUnitId || meta.unit;
      var v = fp.value;
      var note = '';
      if (meta.kind === 'frac') {
        if (fp.percent) unitId = 'fraction'; // value already divided by 100
        else if (unitId === 'fraction' && v > 1) { v = v / 100; note = 'read as percent'; }
        else if (unitId === '%') { v = v / 100; unitId = 'fraction'; }
      }
      if (meta.kind === 'comp' && unitSource !== 'file' && v > 1e-3) {
        v = v * 1e-6; note = 'read as ×10⁻⁶ psi⁻¹';
      }
      var base = (meta.kind === 'frac' || meta.kind === 'ratio') ? v : U.toBase(meta.kind, unitId, v);
      return { value: base, where: fp.where, label: fp.label, raw: fp.raw, unitText: fp.unitText, unitId: unitId, note: note };
    }

    // pi
    var fpi = fileParam('pi', 'pressure', u.p);
    if (isFinite(userParams.pi)) setParam('pi', userParams.pi, 'user');
    else if (fpi) setParam('pi', fpi.value, 'file', fpi);
    else if (initialRow) setParam('pi', initialRow.p, 'derived', { from: 'row ' + initialRow.sheetRow + ' (Np = 0)' });
    else if (maxRow) {
      setParam('pi', maxRow.p, 'derived', { from: 'highest pressure in the data (row ' + maxRow.sheetRow + ')' });
      msgs.warnings.push({ text: 'Initial pressure p_i is not in the file, so the highest pressure in the data (' + U.fmt(maxRow.p, 0) + ' psia) is used. Enter p_i under Reservoir parameters if it is different.' });
    }

    var atPi = null;
    if (isFinite(P.pi)) {
      var tol = Math.max(0.5, 1e-4 * P.pi);
      for (var j = 0; j < rows.length; j++) if (Math.abs(rows[j].p - P.pi) <= tol) { atPi = rows[j]; break; }
    }
    var refRow = atPi || initialRow;

    [['Boi', 'Bo', 'bo', u.Bo], ['Bgi', 'Bg', 'bg', u.Bg], ['Rsi', 'Rs', 'gor', u.Rs]].forEach(function (spec) {
      var k = spec[0], col = spec[1];
      var fp = fileParam(k, spec[2], spec[3]);
      if (isFinite(userParams[k])) setParam(k, userParams[k], 'user');
      else if (fp) setParam(k, fp.value, 'file', fp);
      else if (refRow) setParam(k, refRow[col], 'derived', { from: 'row ' + refRow.sheetRow + ' (p = ' + U.fmt(refRow.p, 0) + ' psia)' });
      else {
        setParam(k, NaN, 'missing');
        msgs.errors.push({ text: PARAMS[k].symbol + ' is missing. Add it to the parameters in your file, include the initial row (Np = 0) in the table, or type it under Reservoir parameters.' });
      }
    });

    ['Swc', 'Cw', 'Cf'].forEach(function (k) {
      var fp = fileParam(k);
      if (isFinite(userParams[k])) setParam(k, userParams[k], 'user');
      else if (fp) {
        setParam(k, fp.value, 'file', fp);
        if (fp.note) msgs.infos.push({ text: PARAMS[k].symbol + ' = ' + fp.raw + ' in the file was ' + fp.note + '.' });
      } else setParam(k, 0, 'default');
    });
    var defaults = ['Swc', 'Cw', 'Cf'].filter(function (k) { return info[k].source === 'default'; });
    if (defaults.length === 3) {
      msgs.infos.push({ code: 'efw-default', text: 'S_wc, C_w and C_f are not in the file, so E_fw = 0 (connate water and rock expansion are neglected). Type them under Reservoir parameters to include E_fw.' });
    } else if (defaults.length) {
      msgs.infos.push({ code: 'efw-partial', text: defaults.map(function (k) { return PARAMS[k].symbol; }).join(' and ') + (defaults.length > 1 ? ' are' : ' is') + ' not in the file and is taken as 0.' });
    }
    ['phi', 'm'].forEach(function (k) {
      var fp = fileParam(k);
      if (isFinite(userParams[k])) setParam(k, userParams[k], 'user');
      else if (fp) setParam(k, fp.value, 'file', fp);
      else setParam(k, NaN, 'missing');
    });

    // sanity checks
    if (isFinite(P.Swc) && (P.Swc < 0 || P.Swc >= 1)) msgs.errors.push({ text: 'S_wc must be a fraction between 0 and 1, now ' + U.fmtAuto(P.Swc) + '. For 20 %, type 0.2 or 20%.' });
    ['Cw', 'Cf'].forEach(function (k) {
      if (isFinite(P[k]) && (P[k] < 0 || P[k] > 1e-3)) msgs.warnings.push({ text: PARAMS[k].symbol + ' = ' + U.fmtAuto(P[k]) + ' psi⁻¹ is outside the usual range (10⁻⁶ to 10⁻⁵ psi⁻¹).' });
    });
    if (isFinite(P.Boi) && (P.Boi < 0.8 || P.Boi > 4)) msgs.warnings.push({ text: 'B_oi = ' + U.fmtAuto(P.Boi) + ' rb/STB is unusual. Check the value and unit.' });
    if (isFinite(P.Bgi) && P.Bgi <= 0) msgs.errors.push({ text: 'B_gi must be greater than zero.' });

    if (refRow && info.Bgi && info.Bgi.source === 'file' && isFinite(refRow.Bg) && refRow.Bg > 0) {
      var ratio = P.Bgi / refRow.Bg;
      if (ratio > 4 && ratio < 8) msgs.warnings.push({ text: 'B_gi in the file is about 5.6 times B_g at p_i in the table. One of them is probably in ft³/SCF and the other in rb/SCF.' });
      else if (ratio > 1 / 8 && ratio < 1 / 4) msgs.warnings.push({ text: 'B_gi in the file is about 1/5.6 of B_g at p_i in the table. One of them is probably in rb/SCF and the other in ft³/SCF.' });
      else if (Math.abs(ratio - 1) > 0.05) msgs.warnings.push({ text: 'B_gi in the file (' + U.fmtAuto(P.Bgi) + ' rb/SCF) differs from B_g at p_i in the table (' + U.fmtAuto(refRow.Bg) + ' rb/SCF).' });
    }
    if (refRow && info.Boi && info.Boi.source === 'file' && isFinite(refRow.Bo) && Math.abs(P.Boi / refRow.Bo - 1) > 0.02) {
      msgs.warnings.push({ text: 'B_oi in the file (' + U.fmtAuto(P.Boi) + ') differs from B_o at p_i in the table (' + U.fmtAuto(refRow.Bo) + ').' });
    }
    if (isFinite(P.pi)) {
      var above = rows.filter(function (r) { return r.p > P.pi + 1e-6; });
      if (above.length) msgs.warnings.push({ text: above.length + ' row' + (above.length > 1 ? 's have' : ' has') + ' a pressure above p_i = ' + U.fmt(P.pi, 0) + ' psia. Those rows are left out of the fit.' });
    }
    if (isFinite(P.Rsi)) {
      var rsAbove = rows.filter(function (r) { return r.Rs > P.Rsi * 1.001; });
      if (rsAbove.length) msgs.warnings.push({ text: 'R_s is higher than R_si on ' + rsAbove.length + ' row' + (rsAbove.length > 1 ? 's' : '') + '. Check R_si and the R_s column.' });
    }
    for (var q = 1; q < rows.length; q++) {
      if (rows[q].Gp < rows[q - 1].Gp - 1e-6 * Math.max(1, Math.abs(rows[q - 1].Gp))) {
        msgs.warnings.push({ text: 'Cumulative gas G_p goes down at row ' + rows[q].sheetRow + ' while N_p goes up. Cumulative values should only grow; check that row.' });
        break;
      }
    }

    return { rows: rows, params: P, paramInfo: info, initialRow: initialRow, refRow: refRow, messages: msgs };
  }

  return {
    FIELDS: FIELDS,
    FIELD_ORDER: FIELD_ORDER,
    CORE_FIELDS: CORE_FIELDS,
    PARAMS: PARAMS,
    PARAM_ORDER: PARAM_ORDER,
    PARAM_BASE: PARAM_BASE,
    splitHeader: splitHeader,
    matchField: matchField,
    matchParam: matchParam,
    scoreHeaderRow: scoreHeaderRow,
    findProductionTables: findProductionTables,
    extractProduction: extractProduction,
    findParams: findParams,
    analyzeWorkbook: analyzeWorkbook,
    buildInputs: buildInputs,
    colLetter: colLetter
  };
});
