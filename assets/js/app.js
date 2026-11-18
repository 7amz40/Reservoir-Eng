/*
 * app.js
 * Wires the Havlena–Odeh analyzer together: file loading, state, rendering and exports.
 * Depends on d3, JSZip and the HOUnits, HOXlsx, HOParser, HOEngine and HOCharts globals.
 */
(function () {
  'use strict';

  var U = window.HOUnits, X = window.HOXlsx, P = window.HOParser, E = window.HOEngine, C = window.HOCharts;
  var $ = function (id) { return document.getElementById(id); };
  var PREVIEW = window.HO_PREVIEW === true;
  if (PREVIEW) document.documentElement.classList.add('is-preview');

  /* ------------------------------------------------------------------
   * Example data set: a gas-cap oil reservoir, with the initial parameters on a second sheet
   * ------------------------------------------------------------------ */
  var EX_PROD = [
    ['P (psia)', 'Rs (SCF/STB)', 'Bo (rb/STB)', 'Bg (rb/SCF)', 'Np (MMSTB)', 'Gp (MMSCF)'],
    [2740, 650, 1.404, 0.0009, 0, 0],
    [2500, 592, 1.374, 0.0010, 7.88, 5988.8],
    [2290, 545, 1.349, 0.0011, 18.42, 15565],
    [2109, 507, 1.329, 0.0012, 29.15, 26818],
    [1949, 471, 1.316, 0.0013, 40.69, 39673],
    [1818, 442, 1.303, 0.0014, 50.14, 51394],
    [1702, 418, 1.294, 0.0015, 58.42, 62217],
    [1608, 398, 1.287, 0.0016, 65.39, 71603],
    [1535, 383, 1.280, 0.0017, 70.74, 79229],
    [1480, 370, 1.276, 0.0018, 74.54, 85348],
    [1440, 362, 1.273, 0.0018, 77.43, 89819]
  ];
  var EX_INIT = [
    ['Property', 'Value', 'Unit'],
    ['Initial pressure, pi', 2740, 'psia'],
    ['Initial oil FVF, Boi', 1.404, 'rb/STB'],
    ['Initial gas FVF, Bgi', 0.0009, 'rb/SCF'],
    ['Initial solution GOR, Rsi', 650, 'SCF/STB'],
    ['Connate water saturation, Swc', 0.05, 'fraction'],
    ['Water compressibility, Cw', 3e-6, '1/psi'],
    ['Formation compressibility, Cf', 4e-6, '1/psi'],
    ['Porosity', 0.25, 'fraction']
  ];
  function clone(rows) { return rows.map(function (r) { return r.slice(); }); }
  function exampleSource() {
    return {
      kind: 'example', name: 'Example data', fileName: 'havlena-odeh-example.xlsx',
      wb: { format: 'example', sheets: [{ name: 'Production', rows: clone(EX_PROD) }, { name: 'Initial', rows: clone(EX_INIT) }] }
    };
  }

  /* ------------------------------------------------------------------
   * Text helpers
   * ------------------------------------------------------------------ */
  var SYM = {
    p: '<var>p</var>', Np: '<var>N</var><sub>p</sub>', Gp: '<var>G</var><sub>p</sub>', Rp: '<var>R</var><sub>p</sub>',
    Bo: '<var>B</var><sub>o</sub>', Rs: '<var>R</var><sub>s</sub>', Bg: '<var>B</var><sub>g</sub>',
    Wp: '<var>W</var><sub>p</sub>', Bw: '<var>B</var><sub>w</sub>',
    pi: '<var>p</var><sub>i</sub>', Boi: '<var>B</var><sub>oi</sub>', Bgi: '<var>B</var><sub>gi</sub>', Rsi: '<var>R</var><sub>si</sub>',
    Swc: '<var>S</var><sub>wc</sub>', Cw: '<var>C</var><sub>w</sub>', Cf: '<var>C</var><sub>f</sub>', phi: '<var>φ</var>'
  };

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; });
  }
  /** Escape, then turn B_g, p_i, E_fw ... into italic symbols with subscripts. */
  function rich(text) {
    return esc(text)
      .replace(/\b([NmGK])\b/g, '<var>$1</var>')
      .replace(/\b([A-Za-z])_([A-Za-z]{1,3})\b/g, '<var>$1</var><sub>$2</sub>');
  }
  function minus(s) { return String(s).replace(/^-/, '−'); }
  function fmtFixed(v, d) {
    if (!isFinite(v)) return '–';
    return minus(Number(v).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }));
  }
  var fmtSig = C.fmtSig;
  /** Result numbers: about four significant digits, never scientific. */
  function fmtRes(v) {
    if (!isFinite(v)) return '–';
    var a = Math.abs(v);
    var d = a >= 1000 ? 0 : a >= 100 ? 1 : a >= 10 ? 2 : a >= 1 ? 3 : 4;
    return fmtFixed(v, d);
  }
  function fmtM(v) {
    if (!isFinite(v)) return '–';
    return Math.abs(v) >= 0.01 || v === 0 ? fmtFixed(v, 3) : fmtSig(v, 3);
  }
  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : (many || one + 's')); }

  /* ------------------------------------------------------------------
   * Output units
   * ------------------------------------------------------------------ */
  var N_DIV = { STB: 1, MSTB: 1e3, MMSTB: 1e6 };
  var G_DIV = { SCF: 1, MMSCF: 1e6, MMMSCF: 1e9 };
  var G_LABEL = { SCF: 'SCF', MMSCF: 'MMSCF', MMMSCF: 'Bscf' };

  /* ------------------------------------------------------------------
   * State
   * ------------------------------------------------------------------ */
  var state = {
    source: exampleSource(),
    overrides: {},       // {sheet, mapping, units}
    paramEdits: {},      // base units
    includeEfw: true,
    excluded: new Set(), // sheet row numbers left out of the fit
    labelsAll: false,
    mNow: null,
    out: { N: 'MMSTB', G: 'MMMSCF' },
    tableAll: false,
    aquifer: { mode: 'auto', K: 0 }, // 'auto' = the file's W_e column when it has one, else none
    aqNote: '',
    bundle: null,
    fileError: null
  };

  /* ------------------------------------------------------------------
   * Pipeline
   * ------------------------------------------------------------------ */
  var BLOCKING = { 'no-table': 1, 'missing-columns': 1, 'no-rows': 1, empty: 1 };

  function compute() {
    var wb = state.source.wb;
    var analysis = P.analyzeWorkbook(wb, state.overrides);
    var b = { analysis: analysis, inputs: null, result: null, blocking: false };
    b.blocking = analysis.errors.some(function (e) { return BLOCKING[e.code]; });
    if (!b.blocking && analysis.production && analysis.production.rows.length) {
      b.inputs = P.buildInputs(analysis, { params: state.paramEdits });
      b.aquifer = resolveAquifer(b.inputs);
      if (!b.inputs.messages.errors.length) {
        b.result = E.analyze(b.inputs.rows, b.inputs.params, engineOpts(b));
      }
    }
    return b;
  }

  function resolveAquifer(inputs) {
    var mode = state.aquifer.mode;
    if (mode === 'auto') mode = inputs && inputs.hasWe ? 'column' : 'none';
    if (mode === 'column' && !(inputs && inputs.hasWe)) mode = 'none';
    return { mode: mode, K: mode === 'pot' ? state.aquifer.K : 0 };
  }

  function engineOpts(b) {
    var ids = b.inputs.rows.filter(function (r) { return state.excluded.has(r.sheetRow); }).map(function (r) { return r.id; });
    return { includeEfw: state.includeEfw, excluded: ids, precision: b.inputs.precision, aquifer: b.aquifer };
  }

  function influxOn(b) { return !!(b.aquifer && b.aquifer.mode !== 'none'); }

  function recompute(opts) {
    opts = opts || {};
    var b = compute();
    state.bundle = b;
    renderAll(b, opts);
    return b;
  }

  /* ------------------------------------------------------------------
   * Rendering
   * ------------------------------------------------------------------ */
  function renderAll(b, opts) {
    renderAlert(b);
    renderSource(b);
    renderParams(b);
    renderAquifer(b);
    renderColumns(b);
    renderLedger(b);
    renderNotes(b);
    renderCharts(b, opts);
    renderTable(b);
    announce(b, opts);
  }

  function hasFit(b) { return !!(b.result && b.result.fit && b.result.results); }

  /* ---------- alert (file problems) ---------- */
  var ICON = {
    error: '<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="8" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M10 5.8v5.2" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/><circle cx="10" cy="14" r="1.1" fill="currentColor"/></svg>',
    warning: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 2.6L18.2 17H1.8z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><path d="M10 7.6v4.4" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/><circle cx="10" cy="14.5" r="1.05" fill="currentColor"/></svg>',
    info: '<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="8" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M10 9v5" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/><circle cx="10" cy="6.2" r="1.05" fill="currentColor"/></svg>',
    ok: '<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="8" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M6.4 10.3l2.4 2.4 4.8-5" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    file: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/></svg>'
  };

  function renderAlert(b) {
    var el = $('alert');
    var title = '', body = '', list = [];
    if (state.fileError) {
      title = state.fileError.title || ('Could not open ' + state.fileError.name);
      body = state.fileError.message;
      if (state.source && !state.fileError.title) list.push('Still showing: ' + state.source.name + '.');
    } else if (b.blocking) {
      var err = b.analysis.errors.filter(function (e) { return BLOCKING[e.code]; })[0];
      title = 'Could not find the data in ' + state.source.name;
      body = err.text;
      list = [
        'Use a header row with names such as p, Np, Gp, Bo, Rs and Bg. Units can follow in brackets, like Np (MMSTB).',
        'Put the initial parameters as label and value pairs on another sheet, or beside the table.',
        'Or start from the blank template and paste your numbers into it.'
      ];
    }
    if (!title) { el.hidden = true; el.innerHTML = ''; return; }
    el.innerHTML = ICON.error +
      '<div><h2>' + esc(title) + '</h2><p>' + rich(body) + '</p>' +
      (list.length ? '<ul>' + list.map(function (t) { return '<li>' + rich(t) + '</li>'; }).join('') + '</ul>' : '') +
      '<div class="alert-actions">' +
      '<button class="btn-quiet" type="button" data-act="template" data-download>Download the blank template</button>' +
      (state.source.kind !== 'example' ? '<button class="btn-quiet" type="button" data-act="example">Load the example</button>' : '') +
      (state.fileError ? '<button class="btn-quiet" type="button" data-act="dismiss">Dismiss</button>' : '') +
      '</div></div>';
    el.hidden = false;
  }

  /* ---------- source card ---------- */
  function renderSource(b) {
    var el = $('source');
    var s = state.source, a = b.analysis, prod = a.production;
    var html = '<div class="source-name">' + ICON.file + '<span>' + esc(s.name) +
      (s.kind === 'example' ? '<span class="tag">Example</span>' : '') + '</span></div>';
    if (prod && !b.blocking) {
      var hdr = prod.headerRow + 1;
      var hdrText = prod.headerSpan === 2 ? 'rows ' + hdr + '–' + (hdr + 1) : 'row ' + hdr;
      html += '<div class="source-meta">Table on sheet “' + esc(prod.sheetName) + '”, header on ' + hdrText + ', ' + plural(prod.rows.length, 'data row') + ' read' +
        (prod.skipped.length ? ', ' + prod.skipped.length + ' skipped' : '') + '.</div>';
      var sheets = {};
      Object.keys(a.params || {}).forEach(function (k) {
        var w = a.params[k].where || '';
        var sh = w.slice(0, w.lastIndexOf('!'));
        if (sh) sheets[sh] = 1;
      });
      var names = Object.keys(sheets);
      html += '<div class="source-meta">' + (names.length
        ? 'Initial parameters found on ' + names.map(function (n) { return '“' + esc(n) + '”'; }).join(' and ') + '.'
        : 'No initial parameters in the file; they are taken from the table.') + '</div>';
    } else if (s.wb) {
      html += '<div class="source-meta">' + plural(s.wb.sheets.length, 'sheet') + ' read.</div>';
    }
    el.innerHTML = html;
  }

  /* ---------- parameters ---------- */
  var PARAM_UI = [
    { k: 'pi', name: 'Initial pressure', kind: 'pressure', unitFrom: 'p' },
    { k: 'Boi', name: 'Initial oil FVF', kind: 'bo', unit: 'rb/STB' },
    { k: 'Bgi', name: 'Initial gas FVF', kind: 'bg', unitFrom: 'Bg' },
    { k: 'Rsi', name: 'Initial solution GOR', kind: 'gor', unitFrom: 'Rs' },
    { k: 'Swc', name: 'Connate water saturation', kind: 'frac', unit: 'fraction' },
    { k: 'Cw', name: 'Water compressibility', kind: 'comp', unit: '1/psi' },
    { k: 'Cf', name: 'Formation compressibility', kind: 'comp', unit: '1/psi' }
  ];

  function paramUnit(def, b) {
    if (def.unitFrom) return (b.analysis.units && b.analysis.units[def.unitFrom]) || U.DEFAULTS[def.kind];
    return def.unit;
  }
  function fmtInput(v) {
    if (!isFinite(v)) return '';
    if (v !== 0 && Math.abs(v) < 1e-4) return v.toExponential(2);
    return String(Number(v.toPrecision(7)));
  }

  function buildParams() {
    var box = $('params');
    box.innerHTML = PARAM_UI.map(function (d) {
      return '<div class="prm" data-k="' + d.k + '">' +
        '<label for="prm-' + d.k + '"><span class="sym">' + SYM[d.k] + '</span> <span class="nm">' + esc(d.name) + '</span></label>' +
        '<div class="prm-input"><input id="prm-' + d.k + '" type="text" inputmode="decimal" autocomplete="off" spellcheck="false" aria-describedby="src-' + d.k + '"><span class="unit" id="unit-' + d.k + '"></span></div>' +
        '<div class="prm-src" id="src-' + d.k + '"><span class="dot" aria-hidden="true"></span><span class="txt"></span>' +
        '<button type="button" class="linklike reset" hidden>Reset</button></div>' +
        '</div>';
    }).join('') + '<p class="prm-extra" id="prm-extra" hidden></p>';

    PARAM_UI.forEach(function (d) {
      var input = $('prm-' + d.k);
      var row = input.closest('.prm');
      var timer = null;
      function commit(final) {
        var raw = input.value.trim();
        if (!raw) {
          if (final) { delete state.paramEdits[d.k]; row.classList.remove('is-invalid'); input.removeAttribute('aria-invalid'); recompute({ keepFocus: true }); }
          return;
        }
        var parsed = U.parseNumberWithUnit(raw);
        if (!parsed) { row.classList.add('is-invalid'); input.setAttribute('aria-invalid', 'true'); return; }
        row.classList.remove('is-invalid'); input.removeAttribute('aria-invalid');
        var b = state.bundle;
        var unitId = paramUnit(d, b);
        var value = parsed.value;
        if (parsed.unit) {
          var det = U.detectUnit(d.kind, parsed.unit);
          if (det.matched) unitId = det.id;
        }
        var base = (d.kind === 'frac') ? (parsed.percent ? value : (unitId === '%' ? value / 100 : value)) : U.toBase(d.kind, unitId, value);
        state.paramEdits[d.k] = base;
        recompute({ keepFocus: true, quiet: !final });
      }
      input.addEventListener('input', function () { clearTimeout(timer); timer = setTimeout(function () { commit(false); }, 450); });
      input.addEventListener('change', function () { clearTimeout(timer); commit(true); });
      input.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') { clearTimeout(timer); commit(true); } });
      row.querySelector('.reset').addEventListener('click', function () {
        delete state.paramEdits[d.k];
        recompute();
        input.focus();
      });
    });
  }

  function renderParams(b) {
    var info = b.inputs ? b.inputs.paramInfo : {};
    var params = b.inputs ? b.inputs.params : {};
    PARAM_UI.forEach(function (d) {
      var input = $('prm-' + d.k);
      var unitId = paramUnit(d, b);
      $('unit-' + d.k).textContent = U.label(d.kind, unitId);
      var v = params[d.k];
      var shown = d.kind === 'frac' ? v : U.fromBase(d.kind, unitId, v);
      if (document.activeElement !== input) {
        input.value = isFinite(shown) ? fmtInput(shown) : '';
        input.closest('.prm').classList.remove('is-invalid');
      }
      var src = $('src-' + d.k);
      var inf = info[d.k] || { source: b.inputs ? 'missing' : 'none' };
      var txt = '';
      switch (inf.source) {
        case 'file': txt = 'From the file, ' + inf.where; break;
        case 'derived': txt = 'From the table, ' + (inf.from || ''); break;
        case 'default': txt = 'Not in the file, taken as 0'; break;
        case 'user': txt = 'Your value'; break;
        case 'missing': txt = 'Missing. Type a value.'; break;
        default: txt = 'Waiting for data';
      }
      src.setAttribute('data-src', inf.source);
      src.querySelector('.txt').textContent = txt;
      src.querySelector('.reset').hidden = inf.source !== 'user';
      input.disabled = !b.inputs;
    });
    var extra = $('prm-extra');
    if (b.inputs && isFinite(b.inputs.params.phi)) {
      extra.hidden = false;
      extra.innerHTML = 'Porosity ' + SYM.phi + ' = ' + esc(fmtInput(b.inputs.params.phi)) + ' is in the file. It is not needed for <var>N</var>, <var>m</var> or <var>G</var>.';
    } else extra.hidden = true;
    $('efw').checked = state.includeEfw;
  }

  /* ---------- water influx ---------- */
  /** Top of the K slider: the K at which W_e would equal F at some point. */
  function potKmax(b) {
    var k = 0;
    (b.result ? b.result.terms : []).forEach(function (t) {
      if (t.Np > 0 && t.dP > 0 && t.F > 0) k = Math.max(k, t.F / t.dP);
    });
    if (!(k > 0)) k = 1e5;
    var mag = Math.pow(10, Math.floor(Math.log10(k)));
    return Math.ceil(k / mag) * mag;
  }

  function renderAquifer(b) {
    var mode = b.aquifer ? b.aquifer.mode : 'none';
    var hasWe = !!(b.inputs && b.inputs.hasWe);
    document.querySelectorAll('input[name="aq"]').forEach(function (r) {
      r.checked = r.value === mode;
      r.disabled = !b.inputs || (r.value === 'column' && !hasWe);
    });
    var prod = b.analysis.production;
    $('aq-col-note').innerHTML = hasWe
      ? esc('Column ' + P.colLetter(prod.mapping.We) + ', “' + (prod.headers[prod.mapping.We].text || '') + '”')
      : rich(b.inputs && b.inputs.weEmpty ? 'The W_e column in this file is empty.' : 'There is no W_e column in this file.');
    $('aq-pot').hidden = mode !== 'pot';
    if (mode !== 'pot') return;
    var range = $('aq-range');
    var max = Math.max(potKmax(b), state.aquifer.K || 0);
    range.max = max;
    range.step = max / 1000;
    range.value = state.aquifer.K || 0;
    var kin = $('aq-k');
    if (document.activeElement !== kin) kin.value = fmtFixed(state.aquifer.K || 0, 0);
    $('aq-read').innerHTML = state.aqNote ? rich(state.aqNote) : '';
  }

  function findBestK() {
    var b = state.bundle;
    if (!b || !b.inputs) return;
    state.aquifer.mode = 'pot';
    var opts = engineOpts(b);
    var best = E.bestPotK(b.inputs.rows, b.inputs.params, opts);
    if (!best) {
      state.aqNote = 'At least three points are needed to find K.';
      recompute({ noAnim: true });
      return;
    }
    state.aquifer.K = Math.round(best.K);
    var note = best.negative
      ? 'The best fit would need K < 0, that is water leaving the reservoir, so K is set to 0.'
      : 'Best fit by least squares on F: K = ' + fmtFixed(best.K, 0) + ' rb/psi.';
    state.aqNote = note;
    var r = recompute({ noAnim: true });
    var R = r.result && r.result.results;
    if (R && !best.negative) {
      state.aqNote = note + (R.m < 0
        ? ' m is still negative (' + fmtM(R.m) + '), so a pot aquifer does not explain these data.'
        : ' The line then gives N = ' + fmtRes(R.N / 1e6) + ' MMSTB and m = ' + fmtM(R.m) + '.');
      renderAquifer(r);
    }
  }

  /* ---------- columns and units ---------- */
  var COL_UI = [
    { f: 'p', name: 'Average reservoir pressure' }, { f: 'Np', name: 'Cumulative oil' }, { f: 'Gp', name: 'Cumulative gas' },
    { f: 'Rp', name: 'Cumulative GOR (instead of Gp)' }, { f: 'Bo', name: 'Oil FVF' }, { f: 'Rs', name: 'Solution GOR' },
    { f: 'Bg', name: 'Gas FVF' }, { sub: 'Optional' }, { f: 'Wp', name: 'Cumulative water' }, { f: 'Bw', name: 'Water FVF' },
    { f: 'We', name: 'Cumulative water influx' }
  ];

  function renderColumns(b) {
    var a = b.analysis, wb = state.source.wb;
    var focusId = document.activeElement && document.activeElement.id;
    // sheet picker
    var sp = $('sheet-pick');
    if (wb && wb.sheets.length > 1) {
      var chosen = a.production ? a.production.sheetIndex : 0;
      var cands = {};
      (a.candidates || []).forEach(function (c) { cands[c.sheetIndex] = 1; });
      sp.hidden = false;
      sp.innerHTML = '<label for="sheet-sel">Sheet with the production table</label><select id="sheet-sel">' +
        wb.sheets.map(function (s, i) {
          return '<option value="' + i + '"' + (i === chosen ? ' selected' : '') + '>' + esc(s.name) + (cands[i] ? '' : ' (no table found)') + '</option>';
        }).join('') + '</select>';
      $('sheet-sel').onchange = function () {
        state.overrides = { sheet: +this.value };
        state.excluded.clear();
        recompute();
        var el = $('sheet-sel'); if (el) el.focus();
      };
    } else { sp.hidden = true; sp.innerHTML = ''; }

    var box = $('colmap');
    var prod = a.production;
    if (!prod) { box.innerHTML = '<p class="side-note">No table to map yet.</p>'; return; }
    var options = '<option value="-1">Not used</option>' + prod.headers.map(function (h) {
      return '<option value="' + h.index + '">' + esc(P.colLetter(h.index) + '  ' + (h.text || '(blank)')) + '</option>';
    }).join('');
    var html = '';
    COL_UI.forEach(function (c) {
      if (c.sub) { html += '<p class="sub-h">' + c.sub + '</p>'; return; }
      var f = c.f, def = P.FIELDS[f];
      var units = U.listUnits(def.kind);
      var curUnit = (a.units && a.units[f]) || U.DEFAULTS[def.kind];
      var unitCtl = units.length > 1
        ? '<select id="unit-' + f + '" aria-label="Unit of ' + esc(def.label) + '">' + units.map(function (u) {
          return '<option value="' + esc(u.id) + '"' + (u.id === curUnit ? ' selected' : '') + '>' + esc(u.label) + '</option>';
        }).join('') + '</select>'
        : '<span class="fixed-unit">' + esc(units[0].label) + '</span>';
      html += '<label class="sym" for="col-' + f + '" title="' + esc(c.name) + '">' + SYM[f] + '</label>' +
        '<select id="col-' + f + '" aria-label="Column for ' + esc(def.label) + '">' + options + '</select>' + unitCtl;
      var hint = '', warn = false;
      var src = a.unitSource ? a.unitSource[f] : '';
      if (prod.mapping[f] >= 0) {
        if (src === 'inferred') hint = 'Unit not in the header; guessed from the values.';
        else if (src === 'assumed' && def.kind !== 'bo' && def.kind !== 'bw') hint = 'Unit not in the header; assumed.';
        if (f === 'Bg' && a.unitText && /stb/i.test(a.unitText.Bg || '')) hint = 'Header says “' + a.unitText.Bg + '”; read as per SCF.';
      } else if (f === 'Rp' && prod.mapping.Gp >= 0) {
        hint = 'Not needed: G_p is given.';
      } else if (P.CORE_FIELDS.indexOf(f) >= 0 || (f === 'Gp' && prod.mapping.Rp < 0)) {
        hint = 'Choose the column for this value.'; warn = true;
      }
      if (hint) html += '<p class="hint' + (warn ? ' warn' : '') + '">' + rich(hint) + '</p>';
    });
    box.innerHTML = html;
    COL_UI.forEach(function (c) {
      if (c.sub) return;
      var f = c.f, sel = $('col-' + f);
      sel.value = String(prod.mapping[f]);
      sel.onchange = function () {
        var mapping = Object.assign({}, prod.mapping);
        mapping[f] = +this.value;
        state.overrides.mapping = mapping;
        state.overrides.sheet = prod.sheetIndex;
        if (state.overrides.units) delete state.overrides.units[f];
        state.excluded.clear();
        recompute();
        var el = $('col-' + f); if (el) el.focus();
      };
      var us = $('unit-' + f);
      if (us) us.onchange = function () {
        state.overrides.units = Object.assign({}, state.overrides.units || {});
        state.overrides.units[f] = this.value;
        state.overrides.sheet = prod.sheetIndex;
        recompute();
        var el = $('unit-' + f); if (el) el.focus();
      };
    });
    if (focusId && $(focusId) && focusId !== 'sheet-sel') $(focusId).focus();
  }

  /* ---------- ledger ---------- */
  function setRes(id, val, unit, ci, flag) {
    var el = $(id);
    el.querySelector('.val').textContent = val;
    el.querySelector('.u').textContent = unit || '';
    el.querySelector('.res-ci').textContent = ci || '';
    var old = el.querySelector('.res-flag');
    if (old) old.remove();
    if (flag) {
      var f = document.createElement('div');
      f.className = 'res-flag';
      f.innerHTML = ICON.warning + '<span>' + esc(flag) + '</span>';
      el.appendChild(f);
    }
    el.classList.toggle('is-empty', val === '–');
  }

  function renderLedger(b) {
    var nu = state.out.N, gu = state.out.G;
    if (!hasFit(b)) {
      $('eq').innerHTML = b.blocking ? 'No data yet' : 'Not enough data for a line';
      $('fitline').textContent = '';
      setRes('res-N', '–', nu); setRes('res-m', '–', ''); setRes('res-G', '–', G_LABEL[gu]);
      return;
    }
    var R = b.result.results, fit = b.result.fit;
    var a = R.N / N_DIV[nu], s = R.mN / N_DIV[nu];
    $('eq').innerHTML = '<var>y</var> = <strong class="n">' + esc(fmtRes(a)) + '</strong> ' + (s < 0 ? '−' : '+') + ' <strong class="n">' +
      esc(fmtRes(Math.abs(s))) + '</strong> <var>x</var> <span class="ledger-label">(' + esc(nu) + ')</span>';
    var aqText = '';
    if (b.aquifer && b.aquifer.mode === 'pot') aqText = ', pot aquifer <var>K</var> = ' + esc(fmtFixed(b.aquifer.K, 0)) + ' rb/psi';
    else if (b.aquifer && b.aquifer.mode === 'column') aqText = ', <var>W</var><sub>e</sub> from the file';
    $('fitline').innerHTML = 'R² = <strong>' + fit.r2.toFixed(3) + '</strong> from ' + plural(fit.n, 'point') + aqText;
    var ci = function (pair, div, fmt) {
      return pair ? '95 % range: ' + fmt(pair[0] / div) + ' to ' + fmt(pair[1] / div) : '';
    };
    setRes('res-N', fmtRes(R.N / N_DIV[nu]), nu, ci(R.ciN, N_DIV[nu], fmtRes), R.N <= 0 ? 'Not physical: see the fit notes' : '');
    setRes('res-m', fmtM(R.m), '', ci(R.ciM, 1, fmtM), R.N > 0 && R.m < 0 ? 'Negative: see the fit notes' : '');
    setRes('res-G', fmtRes(R.G / G_DIV[gu]), G_LABEL[gu], ci(R.ciG, G_DIV[gu], fmtRes), R.N > 0 && R.m < 0 ? 'Negative: see the fit notes' : '');
  }

  /* ---------- fit notes and statistics ---------- */
  function collectMessages(b) {
    var out = [], seen = {};
    function add(level, list) {
      (list || []).forEach(function (m) {
        if (seen[m.text]) return;
        seen[m.text] = 1;
        out.push({ level: level, text: m.text, code: m.code });
      });
    }
    var a = b.analysis;
    add('error', a.errors.filter(function (e) { return !BLOCKING[e.code]; }));
    if (b.inputs) add('error', b.inputs.messages.errors);
    if (b.result) add('error', b.result.messages.errors);
    add('warning', a.warnings);
    if (b.inputs) add('warning', b.inputs.messages.warnings);
    if (b.result) add('warning', b.result.messages.warnings);
    if (!state.includeEfw) out.push({ level: 'info', text: 'E_fw is switched off, so connate water and rock expansion are neglected.' });
    add('info', a.infos);
    if (b.inputs) add('info', b.inputs.messages.infos.filter(function (m) { return !(m.code === 'efw-default' && !state.includeEfw); }));
    if (b.result) add('info', b.result.messages.infos);
    if (hasFit(b) && !out.some(function (m) { return m.level !== 'info'; }) && b.result.fit.n >= 3 && b.result.fit.r2 >= 0.95) {
      out.unshift({ level: 'ok', text: 'The points fall close to a straight line (R² = ' + b.result.fit.r2.toFixed(3) + ').' });
    }
    return out;
  }

  function renderNotes(b) {
    var msgs = collectMessages(b);
    // the rounding check can name the points that move the most: offer to leave them out in one click
    var shakyRows = [];
    if (b.result && b.result.rounding && b.result.rounding.shaky) {
      var ids = b.result.rounding.shaky;
      shakyRows = b.result.terms.filter(function (t) { return ids.indexOf(t.id) >= 0 && t.included; });
      if (shakyRows.length !== ids.length) shakyRows = [];
    }
    $('notes').innerHTML = msgs.length ? msgs.map(function (m) {
      var act = '';
      if (m.code === 'rounding' && shakyRows.length) {
        var names = shakyRows.map(function (t) { return fmtFixed(t.p, 0); });
        act = '<button type="button" class="btn-quiet note-act" data-rows="' + shakyRows.map(function (t) { return t.sheetRow; }).join(',') + '">Leave out ' +
          (names.length > 1 ? names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1] : names[0]) + ' psia</button>';
      }
      return '<li class="note" data-level="' + m.level + '">' + ICON[m.level === 'ok' ? 'ok' : m.level] +
        '<span><span class="sr-only">' + ({ error: 'Error: ', warning: 'Warning: ', info: 'Note: ', ok: '' })[m.level] + '</span>' + rich(m.text) + act + '</span></li>';
    }).join('') : '<li class="note" data-level="info">' + ICON.info + '<span>No notes.</span></li>';

    var st = $('stats');
    if (!hasFit(b)) { st.innerHTML = '<dt>Points in the fit</dt><dd>–</dd>'; return; }
    var R = b.result.results, fit = b.result.fit, nu = state.out.N, div = N_DIV[nu];
    var usable = b.result.terms.filter(function (t) { return t.usable; }).length;
    var pm = function (v, se, d, f) { return f(v / d) + (isFinite(se) ? ' ± ' + f(fit.tcrit * se / d) : ''); };
    var rows = [
      ['Points in the fit', fit.n + ' of ' + usable],
      ['R²', fit.r2.toFixed(4)],
      ['Intercept, <var>N</var>', pm(R.N, R.seN, div, fmtRes) + ' ' + nu],
      ['Slope, <var>mN</var>', pm(R.mN, R.seMN, div, fmtRes) + ' ' + nu],
      ['<var>m</var>', fmtM(R.m) + (isFinite(R.seM) ? ' ± ' + fmtM(fit.tcrit * R.seM) : '')],
      ['Scatter of <var>y</var> about the line', isFinite(fit.s) ? fmtRes(fit.s / div) + ' ' + nu : '–'],
      ['Degrees of freedom', String(fit.dof)],
      ['Student <var>t</var> at 95 %', isFinite(fit.tcrit) ? fit.tcrit.toFixed(3) : 'needs 3 points']
    ];
    st.innerHTML = rows.map(function (r) { return '<dt>' + r[0] + '</dt><dd>' + esc(r[1]) + '</dd>'; }).join('');
  }

  /* ---------- charts ---------- */
  var mRange = { lo: 0, hi: 1, fit: NaN, key: '' };

  function hoPoints(b) {
    return b.result.terms.filter(function (t) { return t.usable; }).map(function (t) {
      return { key: t.sheetRow, x: t.x, y: t.y, p: t.p, included: t.included, F: t.F, Eo: t.Eo, Eg: t.Eg, Efw: t.Efw, We: t.We };
    });
  }

  /** A negative m has no physical meaning, so the drive indices are hidden while it lasts. */
  function negativeM(b) {
    return hasFit(b) && b.result.results.N > 0 && b.result.results.m < 0;
  }

  function anyEfw(b) {
    return !!(b.result && b.result.terms.some(function (t) { return t.usable && t.Efw > 0; }));
  }

  function renderCharts(b, opts) {
    opts = opts || {};
    var nu = state.out.N, div = N_DIV[nu];
    var ho = $('chart-ho'), chk = $('chart-check'), drv = $('chart-drive');
    if (!b.result || !b.result.terms.length) {
      var msg = b.blocking ? 'Load a file with production data to see the plot.' :
        (b.inputs && b.inputs.messages.errors.length ? 'Fix the reservoir parameters on the left to see the plot.' : 'No points to plot.');
      C.empty(ho, msg); C.empty(chk, msg); C.empty(drv, msg);
      C.legend($('legend-ho'), [], {}); C.legend($('legend-check'), [], {}); C.legend($('legend-drive'), [], {});
      renderExplorer(b, { reset: true });
      $('reset-points').hidden = true;
      return;
    }
    var fitOk = hasFit(b);
    var R = fitOk ? b.result.results : null;
    var efw = anyEfw(b);
    C.hoPlot(ho, {
      points: hoPoints(b),
      fit: fitOk ? { a: R.N, b: R.mN } : null,
      yDiv: div, yUnit: nu, efw: efw, influx: influxOn(b),
      labelsAll: state.labelsAll,
      Ntext: fitOk ? fmtRes(R.N / div) + ' ' + nu : '',
      mNtext: fitOk ? fmtRes(R.mN / div) + ' ' + nu : '',
      legendEl: $('legend-ho'),
      animate: !opts.noAnim,
      emptyText: 'No points below the initial pressure.',
      onToggle: toggleRow
    });
    $('reset-points').hidden = !b.result.terms.some(function (t) { return t.usable && t.userExcluded; });

    var inc = b.result.terms.filter(function (t) { return t.included; });
    C.originPlot(chk, {
      points: fitOk ? inc.map(function (t) { return { key: t.sheetRow, p: t.p, Et: t.Et, F: t.Fnet }; }) : [],
      influx: influxOn(b),
      slope: fitOk ? R.N : NaN,
      slopeText: fitOk ? 'slope *N* = ' + fmtRes(R.N / div) + ' ' + nu : '',
      nDiv: div, nUnit: nu,
      pointLabel: 'Point in the fit',
      lineLabel: 'Line through the origin with slope <var>N</var>',
      legendEl: $('legend-check'),
      xTitle: '*E*_t = *E*_o + *m* *E*_g + (1 + *m*) *E*_fw, rb/STB',
      emptyText: 'The check appears once N and m are found.'
    });
    C.driveBars(drv, {
      rows: fitOk ? inc.map(function (t) { return { key: t.sheetRow, p: t.p, DDI: t.DDI, SDI: t.SDI, CDI: t.CDI, WDI: t.WDI }; }) : [],
      showWater: efw,
      showInflux: influxOn(b),
      legendEl: $('legend-drive'),
      blockedText: negativeM(b) ? 'Not shown: the fitted m is ' + fmtM(R.m) + '. A negative gas cap would give a negative gas-cap drive index, which has no physical meaning. See the fit notes.' : ''
    });
    renderExplorer(b, opts);
  }

  function renderExplorer(b, opts) {
    var fitOk = hasFit(b);
    var range = $('m-range'), num = $('m-num'), btn = $('m-fit');
    var expEl = $('chart-exp'), scanEl = $('chart-scan');
    if (!fitOk) {
      range.disabled = true; num.disabled = true; btn.disabled = true;
      $('m-read').textContent = '';
      C.empty(expEl, 'Available once N and m are found.');
      C.empty(scanEl, 'Available once N and m are found.');
      C.legend($('legend-exp'), [], {});
      return;
    }
    range.disabled = false; num.disabled = false; btn.disabled = false;
    var terms = b.result.terms, mFit = b.result.results.m;
    var key = state.source.name + '|' + terms.filter(function (t) { return t.included; }).map(function (t) { return t.sheetRow; }).join(',') + '|' + state.includeEfw + '|' + JSON.stringify(state.paramEdits) + '|' + JSON.stringify(state.overrides);
    if (key !== mRange.key) {
      var minM = E.minValidM(terms);
      var lo = Math.min(0, mFit) - 0.25, hi = Math.max(1, 2.2 * Math.max(mFit, 0.25));
      if (isFinite(minM)) lo = Math.max(lo, minM + 0.02 * (hi - minM));
      mRange = { lo: lo, hi: hi, fit: mFit, key: key, scan: E.scanM(terms, lo, hi, 180) };
      range.min = lo; range.max = hi; range.step = ((hi - lo) / 1000).toPrecision(3);
      if (!(state.mNow >= lo && state.mNow <= hi)) state.mNow = mFit;
    }
    if (opts && opts.resetM) state.mNow = mFit;
    var m = Math.min(mRange.hi, Math.max(mRange.lo, state.mNow));
    state.mNow = m;
    range.value = m;
    if (document.activeElement !== num) num.value = m.toFixed(3);
    var ev = E.evaluateM(terms, m);
    var nu = state.out.N, div = N_DIV[nu];
    C.originPlot(expEl, {
      points: ev.points.map(function (q) { return { key: q.id, p: q.p, Et: q.Et, F: q.F }; }),
      slope: ev.N, slopeText: isFinite(ev.N) ? 'slope *N* = ' + fmtRes(ev.N / div) + ' ' + nu : '',
      nDiv: div, nUnit: nu,
      pointLabel: 'Point in the fit', lineLabel: 'Best line through the origin',
      legendEl: $('legend-exp'),
      xTitle: '*E*_t for this *m*, rb/STB',
      emptyText: 'For this m, some points have E_t ≤ 0. Choose a larger m.'
    });
    C.scanPlot(scanEl, {
      scan: mRange.scan, mFit: mFit, mNow: m, nDiv: div, nUnit: nu,
      onPick: function (mm) { state.mNow = mm; renderExplorer(state.bundle, {}); }
    });
    var read = '';
    if (ev.valid && isFinite(ev.N)) {
      var bend = bendOf(ev.points);
      read = 'At <var>m</var> = <strong>' + esc(fmtM(m)) + '</strong>, the best line through the origin gives <var>N</var> = <strong>' +
        esc(fmtRes(ev.N / div)) + ' ' + nu + '</strong>, and <var>F</var>/<var>E</var><sub>t</sub> varies by <strong>' + esc(fmtSig(ev.cv, 3)) + ' %</strong> between points. ' +
        (bend > 0.02 ? 'The points bend upward.' : bend < -0.02 ? 'The points bend downward.' : 'The points lie close to a straight line.');
      if (Math.abs(m - mFit) > 1e-9) read += ' The fitted value is <var>m</var> = ' + esc(fmtM(mFit)) + '.';
    } else {
      read = 'For <var>m</var> = ' + esc(fmtM(m)) + ', some points have <var>E</var><sub>t</sub> ≤ 0. Choose a larger <var>m</var>.';
    }
    $('m-read').innerHTML = read;
  }

  /** Relative trend of F/Et with Et: positive when the points curve upward. */
  function bendOf(points) {
    var pts = points.filter(function (q) { return q.Et > 0 && isFinite(q.impliedN); });
    if (pts.length < 3) return 0;
    var fit = E.linreg(pts.map(function (q) { return q.Et; }), pts.map(function (q) { return q.impliedN; }));
    if (!fit || fit.degenerate) return 0;
    var span = fit.xMax - fit.xMin;
    return fit.slope * span / Math.abs(fit.yMean || 1);
  }

  /* ---------- table ---------- */
  var TABLE_LIMIT = 30;

  function renderTable(b) {
    var tbl = $('calc'), foot = $('table-foot');
    if (!b.result || !b.result.terms.length) {
      tbl.innerHTML = '<tbody><tr><td style="text-align:left;position:static">No data.</td></tr></tbody>';
      foot.innerHTML = '';
      return;
    }
    var nu = state.out.N, div = N_DIV[nu];
    var efw = anyEfw(b);
    var cols = [
      { g: 'Data', h: SYM.p, u: 'psia', v: function (t) { return fmtFixed(t.p, 0); } },
      { g: 'Data', h: SYM.Np, u: 'MMSTB', v: function (t) { return fmtSig(t.Np / 1e6, 4); } },
      { g: 'Data', h: SYM.Gp, u: 'MMSCF', v: function (t) { return fmtSig(t.Gp / 1e6, 5); } },
      { g: 'Data', h: SYM.Rp, u: 'SCF/STB', v: function (t) { return t.Np > 0 ? fmtFixed(t.Rp, 1) : '–'; } },
      { g: 'Data', h: SYM.Bo, u: 'rb/STB', v: function (t) { return fmtFixed(t.Bo, 4); } },
      { g: 'Data', h: SYM.Rs, u: 'SCF/STB', v: function (t) { return fmtFixed(t.Rs, 1); } },
      { g: 'Data', h: SYM.Bg, u: 'rb/SCF', v: function (t) { return fmtSig(t.Bg, 4); } },
      { g: 'Expansion terms', h: 'Δ<var>p</var>', u: 'psi', v: function (t) { return fmtFixed(t.dP, 0); } },
      { g: 'Expansion terms', h: '<var>F</var>', u: 'MM rb', v: function (t) { return fmtSig(t.F / 1e6, 5); } }
    ].concat(influxOn(b) ? [
      { g: 'Expansion terms', h: '<var>W</var><sub>e</sub>', u: 'MM rb', v: function (t) { return isFinite(t.We) ? fmtSig(t.We / 1e6, 4) : '–'; } }
    ] : []).concat([
      { g: 'Expansion terms', h: '<var>E</var><sub>o</sub>', u: 'rb/STB', v: function (t) { return fmtSig(t.Eo, 4); } },
      { g: 'Expansion terms', h: '<var>E</var><sub>g</sub>', u: 'rb/STB', v: function (t) { return fmtSig(t.Eg, 4); } },
      { g: 'Expansion terms', h: '<var>E</var><sub>fw</sub>', u: 'rb/STB', v: function (t) { return efw ? fmtSig(t.Efw, 3) : '0'; } },
      { g: 'Straight line', h: '<var>x</var>', u: '', v: function (t) { return t.usable ? fmtSig(t.x, 4) : '–'; } },
      { g: 'Straight line', h: '<var>y</var>', u: nu, v: function (t) { return t.usable ? fmtSig(t.y / div, 5) : '–'; } },
      { g: 'Check at the fitted <var>m</var>', h: influxOn(b) ? '(<var>F</var> − <var>W</var><sub>e</sub>)/<var>E</var><sub>t</sub>' : '<var>F</var>/<var>E</var><sub>t</sub>', u: nu, v: function (t) { return t.usable && isFinite(t.impliedN) ? fmtSig(t.impliedN / div, 5) : '–'; } },
      { g: 'Check at the fitted <var>m</var>', h: 'DDI', u: '%', v: function (t) { return di(t, 'DDI'); } },
      { g: 'Check at the fitted <var>m</var>', h: 'SDI', u: '%', v: function (t) { return di(t, 'SDI'); } }
    ]);
    if (influxOn(b)) cols.push({ g: 'Check at the fitted <var>m</var>', h: 'WDI', u: '%', v: function (t) { return di(t, 'WDI'); } });
    if (efw) cols.push({ g: 'Check at the fitted <var>m</var>', h: 'CDI', u: '%', v: function (t) { return di(t, 'CDI'); } });
    var hideDI = negativeM(b);
    function di(t, k) {
      if (hideDI || !t.usable || !isFinite(t[k]) || !isFinite(t.sumDI) || t.sumDI === 0) return '–';
      return fmtFixed(100 * t[k] / t.sumDI, 1);
    }
    var groups = [];
    cols.forEach(function (c) {
      if (!groups.length || groups[groups.length - 1].g !== c.g) groups.push({ g: c.g, n: 1 });
      else groups[groups.length - 1].n++;
    });
    var focusId = document.activeElement && document.activeElement.id;
    var html = '<thead><tr class="grp">' + groups.map(function (g) {
      return '<th colspan="' + g.n + '" scope="colgroup">' + g.g + '</th>';
    }).join('') + '<th></th></tr><tr>' + cols.map(function (c, i) {
      var start = i > 0 && cols[i - 1].g !== c.g;
      return '<th scope="col"' + (start ? ' class="g-start"' : '') + '>' + c.h + (c.u ? '<span class="u">' + esc(c.u) + '</span>' : '<span class="u">&nbsp;</span>') + '</th>';
    }).join('') + '<th scope="col" class="g-start">In fit<span class="u">&nbsp;</span></th></tr></thead><tbody>';
    var terms = b.result.terms;
    var shown = state.tableAll ? terms : terms.slice(0, TABLE_LIMIT);
    shown.forEach(function (t) {
      var cls = !t.usable ? 'is-na' : (t.userExcluded ? 'is-out' : '');
      html += '<tr' + (cls ? ' class="' + cls + '"' : '') + '>' + cols.map(function (c, i) {
        var start = i > 0 && cols[i - 1].g !== c.g;
        return (i === 0 ? '<th scope="row"' : '<td') + (start ? ' class="g-start"' : '') + '>' + esc(c.v(t)) + (i === 0 ? '</th>' : '</td>');
      }).join('');
      if (t.usable) {
        html += '<td class="fitcell g-start"><label><input type="checkbox" id="fit-' + t.sheetRow + '" data-row="' + t.sheetRow + '"' + (t.included ? ' checked' : '') +
          '><span class="sr-only">Use the point at ' + esc(fmtFixed(t.p, 0)) + ' psia in the fit</span></label></td>';
      } else {
        html += '<td class="fitcell g-start"><span class="why">' + rich(t.reason) + '</span></td>';
      }
      html += '</tr>';
    });
    html += '</tbody>';
    tbl.innerHTML = html;
    tbl.querySelectorAll('input[type="checkbox"]').forEach(function (cb) {
      cb.addEventListener('change', function () { toggleRow(+this.getAttribute('data-row'), true); });
    });
    var fh = '<span>' + (hideDI ? 'Drive indices are left blank because the fitted <var>m</var> is negative.' : 'Drive indices are scaled to add up to 100 % at each pressure.') + ' Values are in field units.</span>';
    if (terms.length > TABLE_LIMIT) {
      fh += '<button class="btn-quiet" type="button" id="table-more">' + (state.tableAll ? 'Show the first ' + TABLE_LIMIT + ' rows' : 'Show all ' + terms.length + ' rows') + '</button>';
    }
    foot.innerHTML = fh;
    var more = $('table-more');
    if (more) more.onclick = function () { state.tableAll = !state.tableAll; renderTable(state.bundle); };
    if (focusId && /^fit-/.test(focusId) && $(focusId)) $(focusId).focus();
  }

  /* ---------- status for screen readers ---------- */
  function announce(b, opts) {
    if (opts && opts.quiet) return;
    var s = $('status');
    if (hasFit(b)) {
      var R = b.result.results;
      s.textContent = 'N = ' + fmtRes(R.N / N_DIV[state.out.N]) + ' ' + state.out.N + ', m = ' + fmtM(R.m) + ', G = ' + fmtRes(R.G / G_DIV[state.out.G]) + ' ' + G_LABEL[state.out.G] + '.';
    } else if (b.blocking) {
      s.textContent = 'The data could not be read. See the message at the top of the results.';
    }
  }

  /* ------------------------------------------------------------------
   * Actions
   * ------------------------------------------------------------------ */
  function toggleRow(sheetRow, fromKeyboard) {
    var active = document.activeElement;
    var fromPlot = !!(active && active.classList && active.classList.contains('hit'));
    if (state.excluded.has(sheetRow)) state.excluded.delete(sheetRow);
    else state.excluded.add(sheetRow);
    recompute({ noAnim: true });
    if (!fromKeyboard) return;
    if (fromPlot) {
      // keep focus on the same point in the redrawn plot
      document.querySelectorAll('#chart-ho circle.hit').forEach(function (c) {
        if (c.__data__ && c.__data__.key === sheetRow) c.focus();
      });
    } else {
      var cb = $('fit-' + sheetRow);
      if (cb) cb.focus();
    }
  }

  function setSource(src) {
    state.source = src;
    state.overrides = {};
    state.paramEdits = {};
    state.excluded = new Set();
    state.mNow = null;
    state.aquifer = { mode: 'auto', K: 0 };
    state.aqNote = '';
    state.tableAll = false;
    state.fileError = null;
    mRange.key = '';
    recompute({ resetM: true });
  }

  var MAX_BYTES = 25 * 1024 * 1024;

  function loadFile(file) {
    if (!file) return;
    if (file.size > MAX_BYTES) {
      state.fileError = { name: file.name, message: 'The file is larger than 25 MB. Remove extra sheets or columns and try again.' };
      renderAlert(state.bundle);
      return;
    }
    document.body.classList.add('is-busy');
    var read = file.arrayBuffer ? file.arrayBuffer() : new Promise(function (res, rej) {
      var fr = new FileReader();
      fr.onload = function () { res(fr.result); };
      fr.onerror = function () { rej(fr.error); };
      fr.readAsArrayBuffer(file);
    });
    read.then(function (buf) { return X.readWorkbook(buf, file.name); })
      .then(function (wb) {
        document.body.classList.remove('is-busy');
        setSource({ kind: 'file', name: file.name, fileName: file.name, size: file.size, wb: wb });
        $('main').focus({ preventScroll: true });
      })
      .catch(function (err) {
        document.body.classList.remove('is-busy');
        state.fileError = { name: file.name, message: (err && err.userFacing) ? err.message : 'The file could not be read (' + ((err && err.message) || 'unknown error') + ').' };
        renderAlert(state.bundle);
        $('alert').scrollIntoView({ block: 'nearest' });
      });
  }

  // On the hosted preview, files go through the viewer's save prompt (the "downloads" capability).
  var hostDownloads = null;
  if (window.claude && typeof window.claude.use === 'function') {
    window.claude.use('downloads').then(function (d) {
      if (!d) return;
      hostDownloads = d;
      document.documentElement.classList.add('has-downloads');
    }).catch(function () { /* not available in this view */ });
  }

  function download(name, data, mime) {
    if (hostDownloads) {
      hostDownloads.save({ filename: name, data: data }).catch(function (err) {
        var code = err && err.code;
        if (code === 'declined') return;
        state.fileError = { title: 'Could not save ' + name, message: code === 'rate_limited' ? 'A save prompt is already open. Try again in a moment.' : 'Saving files is not available here. Open index.html from the project folder to download files.' };
        renderAlert(state.bundle);
      });
      return;
    }
    var blob = data instanceof Blob ? data : new Blob([data], { type: mime });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = name; a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(url); a.remove(); }, 2000);
  }
  var XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

  function downloadTemplate() {
    X.writeXlsx([
      { name: 'Production', headerRows: 1, colWidths: [13, 14, 14, 14, 14, 14],
        rows: [['p (psia)', 'Np (MMSTB)', 'Gp (MMSCF)', 'Bo (rb/STB)', 'Rs (SCF/STB)', 'Bg (rb/SCF)']] },
      { name: 'Initial', headerRows: 1, colWidths: [32, 14, 12, 60],
        rows: [['Property', 'Value', 'Unit', 'Notes'],
          ['Initial pressure, pi', null, 'psia', ''],
          ['Initial oil FVF, Boi', null, 'rb/STB', 'Leave empty to take it from the table row at pi'],
          ['Initial gas FVF, Bgi', null, 'rb/SCF', 'Leave empty to take it from the table row at pi'],
          ['Initial solution GOR, Rsi', null, 'SCF/STB', 'Leave empty to take it from the table row at pi'],
          ['Connate water saturation, Swc', null, 'fraction', 'Swc, Cw and Cf can be left empty: then Efw = 0'],
          ['Water compressibility, Cw', null, '1/psi', ''],
          ['Formation compressibility, Cf', null, '1/psi', '']] }
    ]).then(function (bytes) { download('havlena-odeh-template.xlsx', bytes, XLSX_MIME); });
  }

  function downloadExample() {
    X.writeXlsx([
      { name: 'Production', headerRows: 1, colWidths: [12, 14, 13, 13, 13, 13], rows: clone(EX_PROD) },
      { name: 'Initial', headerRows: 1, colWidths: [32, 14, 12], rows: clone(EX_INIT) }
    ]).then(function (bytes) { download('havlena-odeh-example.xlsx', bytes, XLSX_MIME); });
  }

  function calcRows(b) {
    var head = ['p (psia)', 'Np (STB)', 'Gp (SCF)', 'Rp (SCF/STB)', 'Bo (rb/STB)', 'Rs (SCF/STB)', 'Bg (rb/SCF)', 'dp (psi)',
      'F (rb)', 'We (rb)', 'Eo (rb/STB)', 'Eg (rb/STB)', 'Efw (rb/STB)', 'x', 'y (STB)', '(F-We)/Et (STB)', 'DDI', 'SDI', 'WDI', 'CDI', 'In fit', 'Note'];
    var rows = [head];
    var hideDI = negativeM(b);
    b.result.terms.forEach(function (t) {
      var s = t.sumDI;
      var norm = function (k) { return !hideDI && t.usable && isFinite(t[k]) && isFinite(s) && s !== 0 ? t[k] / s : null; };
      rows.push([t.p, t.Np, t.Gp, t.Np > 0 ? t.Rp : null, t.Bo, t.Rs, t.Bg, t.dP, t.F, isFinite(t.We) ? t.We : null, t.Eo, t.Eg, t.Efw,
        t.usable ? t.x : null, t.usable ? t.y : null, t.usable && isFinite(t.impliedN) ? t.impliedN : null,
        norm('DDI'), norm('SDI'), norm('WDI'), norm('CDI'),
        t.usable ? (t.included ? 'yes' : 'no') : 'n/a', t.reason || (t.userExcluded ? 'left out by user' : '')]);
    });
    return rows;
  }

  function exportResults() {
    var b = state.bundle;
    if (!hasFit(b)) {
      state.fileError = { title: 'Nothing to export yet', message: 'There is no fitted line yet. Load data that gives N and m first.' };
      renderAlert(b);
      return;
    }
    var R = b.result.results, fit = b.result.fit, prm = b.inputs.params, info = b.inputs.paramInfo;
    var results = [
      ['Havlena–Odeh straight-line analysis', ''],
      ['Data', state.source.name],
      ['Points in the fit', fit.n],
      ['', ''],
      ['Result', 'Value', 'Unit', '95 % low', '95 % high'],
      ['N, oil initially in place', R.N, 'STB', R.ciN ? R.ciN[0] : null, R.ciN ? R.ciN[1] : null],
      ['N, oil initially in place', R.N / 1e6, 'MMSTB', R.ciN ? R.ciN[0] / 1e6 : null, R.ciN ? R.ciN[1] / 1e6 : null],
      ['m, gas-cap to oil-zone volume ratio', R.m, '-', R.ciM ? R.ciM[0] : null, R.ciM ? R.ciM[1] : null],
      ['mN, slope of the line', R.mN, 'STB', null, null],
      ['G, gas-cap gas initially in place', R.G, 'SCF', R.ciG ? R.ciG[0] : null, R.ciG ? R.ciG[1] : null],
      ['G, gas-cap gas initially in place', R.G / 1e9, 'Bscf', R.ciG ? R.ciG[0] / 1e9 : null, R.ciG ? R.ciG[1] / 1e9 : null],
      ['R squared', fit.r2, '', null, null],
      ['', ''],
      ['Method', '(F-We)/[Eo+(1+m)Efw] = N + mN Eg/[Eo+(1+m)Efw], fitted again with the new m until m stops changing; N = intercept, m = slope/intercept, G = mN Boi/Bgi'],
      ['Efw included', state.includeEfw ? 'yes' : 'no'],
      ['Water influx', b.aquifer.mode === 'pot' ? 'pot aquifer, We = K (pi - p)' : b.aquifer.mode === 'column' ? 'We column from the file' : 'none'],
      ['K, pot aquifer constant (rb/psi)', b.aquifer.mode === 'pot' ? b.aquifer.K : null]
    ];
    var inputs = [['Parameter', 'Value', 'Unit', 'Source']];
    [['pi', 'psia'], ['Boi', 'rb/STB'], ['Bgi', 'rb/SCF'], ['Rsi', 'SCF/STB'], ['Swc', 'fraction'], ['Cw', '1/psi'], ['Cf', '1/psi']].forEach(function (p) {
      var i = info[p[0]] || {};
      var src = { file: 'file ' + (i.where || ''), derived: 'table ' + (i.from || ''), default: 'not in file, 0', user: 'typed in the dashboard', missing: 'missing' }[i.source] || '';
      inputs.push([p[0], isFinite(prm[p[0]]) ? prm[p[0]] : null, p[1], src]);
    });
    var notes = [['Level', 'Note']].concat(collectMessages(b).map(function (m) { return [m.level, m.text.replace(/_/g, '')]; }));
    X.writeXlsx([
      { name: 'Results', headerRows: 0, colWidths: [38, 22, 10, 16, 16], rows: results },
      { name: 'Calculations', headerRows: 1, colWidths: [10, 14, 16, 12, 11, 12, 12, 9, 16, 14, 12, 12, 12, 10, 16, 16, 9, 9, 9, 9, 8, 24], rows: calcRows(b) },
      { name: 'Inputs', headerRows: 1, colWidths: [12, 14, 10, 34], rows: inputs },
      { name: 'Notes', headerRows: 1, colWidths: [10, 110], rows: notes }
    ]).then(function (bytes) {
      var base = String(state.source.fileName || 'data').replace(/\.[^.]+$/, '');
      download(base + (/havlena-odeh/i.test(base) ? '_results.xlsx' : '_Havlena-Odeh_results.xlsx'), bytes, XLSX_MIME);
    });
  }

  function exportCSV() {
    var b = state.bundle;
    if (!b.result) return;
    var base = String(state.source.fileName || 'data').replace(/\.[^.]+$/, '');
    download(base + '_calculations.csv', '﻿' + X.toCSV(calcRows(b)), 'text/csv;charset=utf-8');
  }

  function exportPNG(chartId, name) {
    var svg = document.querySelector('#' + chartId + ' svg');
    if (!svg) return;
    C.toPNG(svg, getComputedStyle(document.documentElement).getPropertyValue('--surface').trim() || '#fff', function (blob) {
      if (blob) download(name, blob, 'image/png');
    });
  }

  /* ------------------------------------------------------------------
   * Theme
   * ------------------------------------------------------------------ */
  var THEME_KEY = 'ho-analyzer-theme';
  function effectiveTheme() {
    var t = document.documentElement.getAttribute('data-theme');
    if (t === 'light' || t === 'dark') return t;
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  function syncThemeButton() {
    var dark = effectiveTheme() === 'dark';
    var btn = $('theme-btn');
    btn.setAttribute('aria-label', dark ? 'Switch to light theme' : 'Switch to dark theme');
    btn.querySelector('.i-moon').style.display = dark ? 'none' : '';
    btn.querySelector('.i-sun').style.display = dark ? '' : 'none';
  }
  function initTheme() {
    var saved = null;
    try { saved = window.localStorage.getItem(THEME_KEY); } catch (e) { saved = null; }
    if (saved === 'light' || saved === 'dark') document.documentElement.setAttribute('data-theme', saved);
    syncThemeButton();
    $('theme-btn').addEventListener('click', function () {
      var next = effectiveTheme() === 'dark' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', next);
      try { window.localStorage.setItem(THEME_KEY, next); } catch (e) { /* storage blocked */ }
      syncThemeButton();
      renderCharts(state.bundle, { noAnim: true });
    });
    if (window.matchMedia) {
      var mq = window.matchMedia('(prefers-color-scheme: dark)');
      var onChange = function () { syncThemeButton(); renderCharts(state.bundle, { noAnim: true }); };
      if (mq.addEventListener) mq.addEventListener('change', onChange); else if (mq.addListener) mq.addListener(onChange);
    }
  }

  /* ------------------------------------------------------------------
   * Events
   * ------------------------------------------------------------------ */
  function initEvents() {
    var fileInput = $('file'), drop = $('drop');
    drop.addEventListener('click', function () { fileInput.click(); });
    drop.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); fileInput.click(); }
    });
    fileInput.addEventListener('change', function () {
      if (this.files && this.files[0]) loadFile(this.files[0]);
      this.value = '';
    });

    // drag and drop anywhere on the page
    var overlay = $('drop-overlay'), depth = 0;
    function hasFiles(ev) {
      var t = ev.dataTransfer && ev.dataTransfer.types;
      return !!t && Array.prototype.indexOf.call(t, 'Files') >= 0;
    }
    window.addEventListener('dragenter', function (ev) {
      if (!hasFiles(ev)) return;
      ev.preventDefault(); depth++; overlay.hidden = false; drop.classList.add('is-over');
    });
    window.addEventListener('dragover', function (ev) { if (hasFiles(ev)) { ev.preventDefault(); ev.dataTransfer.dropEffect = 'copy'; } });
    window.addEventListener('dragleave', function (ev) {
      if (!hasFiles(ev)) return;
      depth = Math.max(0, depth - 1);
      if (!depth) { overlay.hidden = true; drop.classList.remove('is-over'); }
    });
    window.addEventListener('drop', function (ev) {
      if (!hasFiles(ev)) return;
      ev.preventDefault(); depth = 0; overlay.hidden = true; drop.classList.remove('is-over');
      var f = ev.dataTransfer.files && ev.dataTransfer.files[0];
      if (f) loadFile(f);
    });

    $('use-example').addEventListener('click', function () { setSource(exampleSource()); });
    $('dl-template').addEventListener('click', downloadTemplate);
    $('dl-example').addEventListener('click', downloadExample);
    $('export-btn').addEventListener('click', exportResults);
    $('csv-btn').addEventListener('click', exportCSV);
    $('png-ho').addEventListener('click', function () { exportPNG('chart-ho', 'havlena-odeh-plot.png'); });
    $('png-check').addEventListener('click', function () { exportPNG('chart-check', 'F-vs-Et-check.png'); });
    $('png-drive').addEventListener('click', function () { exportPNG('chart-drive', 'drive-indices.png'); });

    $('notes').addEventListener('click', function (ev) {
      var btn = ev.target.closest('button[data-rows]');
      if (!btn) return;
      btn.getAttribute('data-rows').split(',').forEach(function (r) { state.excluded.add(+r); });
      recompute({ noAnim: true });
      var reset = $('reset-points');
      if (reset && !reset.hidden) reset.focus();
    });

    $('alert').addEventListener('click', function (ev) {
      var btn = ev.target.closest('button[data-act]');
      if (!btn) return;
      var act = btn.getAttribute('data-act');
      if (act === 'template') downloadTemplate();
      else if (act === 'example') setSource(exampleSource());
      else if (act === 'dismiss') { state.fileError = null; renderAlert(state.bundle); }
    });

    $('efw').addEventListener('change', function () { state.includeEfw = this.checked; recompute({ noAnim: true }); });

    document.querySelectorAll('input[name="aq"]').forEach(function (r) {
      r.addEventListener('change', function () {
        if (!this.checked) return;
        state.aquifer.mode = this.value;
        state.aqNote = '';
        recompute({ noAnim: true });
      });
    });
    var aqTimer = null;
    function setK(v, quiet) {
      if (!(isFinite(v) && v >= 0)) return false;
      state.aquifer.K = v;
      state.aqNote = '';
      recompute({ noAnim: true, quiet: quiet });
      return true;
    }
    $('aq-k').addEventListener('input', function () {
      var el = this;
      clearTimeout(aqTimer);
      aqTimer = setTimeout(function () { setK(U.parseNumber(el.value), true); }, 350);
    });
    $('aq-k').addEventListener('change', function () {
      clearTimeout(aqTimer);
      if (!setK(U.parseNumber(this.value), false)) this.value = fmtFixed(state.aquifer.K || 0, 0);
    });
    $('aq-range').addEventListener('input', function () { setK(+this.value, true); });
    $('aq-best').addEventListener('click', findBestK);
    $('labels-all').addEventListener('change', function () { state.labelsAll = this.checked; renderCharts(state.bundle, { noAnim: true }); });
    $('reset-points').addEventListener('click', function () { state.excluded.clear(); recompute({ noAnim: true }); });
    $('out-N').addEventListener('change', function () { state.out.N = this.value; renderAll(state.bundle, { noAnim: true, quiet: true }); });
    $('out-G').addEventListener('change', function () { state.out.G = this.value; renderAll(state.bundle, { noAnim: true, quiet: true }); });

    var range = $('m-range'), num = $('m-num');
    range.addEventListener('input', function () { state.mNow = +this.value; renderExplorer(state.bundle, {}); });
    num.addEventListener('change', function () {
      var v = U.parseNumber(this.value);
      if (isFinite(v)) { state.mNow = v; renderExplorer(state.bundle, {}); }
      else this.value = isFinite(state.mNow) ? state.mNow.toFixed(3) : '';
    });
    num.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') this.dispatchEvent(new Event('change')); });
    $('m-fit').addEventListener('click', function () { renderExplorer(state.bundle, { resetM: true }); });

    // redraw charts when their width changes
    var lastW = {};
    var timer = null;
    if (window.ResizeObserver) {
      var ro = new ResizeObserver(function (entries) {
        var changed = entries.some(function (e) {
          var w = Math.round(e.contentRect.width);
          var id = e.target.id;
          if (lastW[id] === w) return false;
          var had = lastW[id] !== undefined;
          lastW[id] = w;
          return had;
        });
        if (!changed) return;
        clearTimeout(timer);
        timer = setTimeout(function () { renderCharts(state.bundle, { noAnim: true }); }, 120);
      });
      ['chart-ho', 'chart-check', 'chart-drive', 'chart-exp', 'chart-scan'].forEach(function (id) { ro.observe($(id)); });
    } else {
      window.addEventListener('resize', function () {
        clearTimeout(timer);
        timer = setTimeout(function () { renderCharts(state.bundle, { noAnim: true }); }, 150);
      });
    }

    // start with the sidebar sections folded on small screens
    if (window.matchMedia && window.matchMedia('(max-width: 900px)').matches) {
      $('sec-params').open = false;
      $('sec-cols').open = false;
    }
  }

  /* ------------------------------------------------------------------
   * Start
   * ------------------------------------------------------------------ */
  function start() {
    initTheme();
    buildParams();
    initEvents();
    recompute({ resetM: true });
  }

  // Expose a small API for tests and the browser console
  window.HOApp = {
    state: state,
    loadWorkbook: function (wb, name) { setSource({ kind: 'file', name: name || 'Workbook', fileName: name || 'workbook.xlsx', wb: wb }); return state.bundle; },
    loadExample: function () { setSource(exampleSource()); return state.bundle; },
    bundle: function () { return state.bundle; }
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
