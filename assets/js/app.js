/*
 * app.js
 * Wires the Havlena–Odeh analyzer together: file loading, state, rendering and exports.
 * Depends on d3, JSZip and the HOUnits, HOXlsx, HOParser, HOEngine, HODrive and HOCharts globals.
 */
(function () {
  'use strict';

  var U = window.HOUnits, X = window.HOXlsx, P = window.HOParser, E = window.HOEngine, D = window.HODrive, C = window.HOCharts;
  var $ = function (id) { return document.getElementById(id); };
  var PREVIEW = window.HO_PREVIEW === true;
  if (PREVIEW) document.documentElement.classList.add('is-preview');

  /* ------------------------------------------------------------------
   * Example data set: a gas-cap oil reservoir from the course, in the units of its handout,
   * with the initial values on a second sheet. S_wc, C_w and C_f are not given for it, so E_fw = 0.
   * ------------------------------------------------------------------ */
  var EX_PROD = [
    ['Pressure (psia)', 'Np (MMSTB)', 'Gp (MMMSCF)', 'Bo (bbl/STB)', 'Rs (SCF/STB)', 'Bg (cuft/SCF)'],
    [3300, 0, 0, 1.2511, 510, 0.00488505],
    [3150, 3.295, 3.460, 1.2353, 477, 0.00516580],
    [3000, 5.903, 6.257, 1.2222, 450, 0.00539040],
    [2850, 8.852, 10.268, 1.2122, 425, 0.00567115],
    [2700, 11.503, 14.206, 1.2022, 401, 0.00600805],
    [2550, 14.513, 18.359, 1.1922, 375, 0.00634495],
    [2400, 17.730, 23.049, 1.1822, 352, 0.00673800]
  ];
  var EX_INIT = [
    ['Property', 'Value', 'Unit', 'Notes'],
    ['Initial pressure, pi', 3300, 'psia', ''],
    ['Initial oil FVF, Boi', 1.2511, 'bbl/STB', ''],
    ['Initial gas FVF, Bgi', 0.00488505, 'cuft/SCF', ''],
    ['Initial solution GOR, Rsi', 510, 'SCF/STB', ''],
    ['Connate water saturation, Swc', null, 'fraction', 'Not given for this reservoir, so Efw = 0'],
    ['Water compressibility, Cw', null, '1/psi', ''],
    ['Formation compressibility, Cf', null, '1/psi', '']
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
      .replace(/\b([NmGKU])\b/g, '<var>$1</var>')
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
    var b = { analysis: analysis, inputs: null, result: null, detection: null, model: null, blocking: false };
    b.blocking = analysis.errors.some(function (e) { return BLOCKING[e.code]; });
    if (!b.blocking && analysis.production && analysis.production.rows.length) {
      b.inputs = P.buildInputs(analysis, { params: state.paramEdits });
      if (!b.inputs.messages.errors.length) {
        b.detection = detect(b);
        b.model = b.detection.best;
        b.result = runModel(b);
        b.view = b.result.fit && b.result.fit.kind === 'origin' ? 'origin' : (b.result.fit && b.result.fit.kind === 'water' ? 'water' : 'line');
      }
    }
    return b;
  }

  function excludedIds(b) {
    return b.inputs.rows.filter(function (r) { return state.excluded.has(r.sheetRow); }).map(function (r) { return r.id; });
  }

  function engineOpts(b, extra) {
    return Object.assign({ includeEfw: state.includeEfw, excluded: excludedIds(b), precision: b.inputs.precision }, extra || {});
  }

  /** A W_e column in the file is used as it is, instead of an aquifer model. */
  function useWeColumn(inputs) {
    return !!(inputs && inputs.hasWe);
  }

  /** Finds the drive mechanism from the data: every mechanism is fitted and the one the data support is kept. */
  function detect(b) {
    var inp = b.inputs, P0 = inp.params, col = useWeColumn(inp);
    return D.detect(inp.rows, P0, {
      includeEfw: state.includeEfw, excluded: excludedIds(b), precision: inp.precision,
      hasTime: inp.hasTime, time: 'auto', mech: 'auto',
      aquifer: 'auto', weColumn: col,
      potK: null, reD: null,
      mKnown: isFinite(P0.m) && P0.m >= 0 ? P0.m : null,
      undersaturated: inp.noGas ? true : undefined,
      undersaturatedText: inp.noGas ? 'There are no R_s, B_g or G_p columns, so the oil is taken as undersaturated: no free gas and no gas cap.' : undefined
    });
  }

  /** The engine's analysis for the chosen model: its Havlena–Odeh line, N, m, W_e and the drive indices. */
  function runModel(b) {
    var c = b.model, rows = b.inputs.rows, P0 = b.inputs.params;
    if (!c) return E.analyzeOrigin(rows, P0, engineOpts(b, { mFixed: 0 }));
    if (c.key === 'depletion') return E.analyzeOrigin(rows, P0, engineOpts(b, { mFixed: 0 }));
    if (c.key === 'gascap-known') return E.analyzeOrigin(rows, P0, engineOpts(b, { mFixed: c.mFixed }));
    if (c.key === 'gascap') return E.analyze(rows, P0, engineOpts(b, { aquifer: { mode: 'none' } }));
    if (c.key === 'water-column') return E.analyzeOrigin(rows, P0, engineOpts(b, { mFixed: c.mFixed || 0, aquifer: { mode: 'column' } }));
    if (c.key === 'comb-column') return E.analyze(rows, P0, engineOpts(b, { aquifer: { mode: 'column' } }));
    if (c.key.indexOf('water-') === 0) return E.analyzeWater(rows, P0, engineOpts(b, { S: c.S, U: c.waterFitted ? null : c.U, mFixed: c.mFixed || 0 }));
    // gas cap and water drive: the gas-cap line with W_e from the fitted aquifer
    var We = {};
    Object.keys(c.S).forEach(function (id) { We[id] = c.fit.U * c.S[id]; });
    return E.analyze(rows, P0, engineOpts(b, { aquifer: { mode: 'series', We: We } }));
  }

  function influxOn(b) { return !!(b.model && b.model.water); }

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
    renderColumns(b);
    openWhereNeeded(b);
    renderLedger(b);
    renderNotes(b);
    renderCharts(b, opts);
    renderTable(b);
    announce(b, opts);
  }

  function hasFit(b) { return !!(b.result && b.result.fit && b.result.results); }

  /** Reservoir parameters and Columns and units start folded; a section opens when something in it needs fixing. */
  function openWhereNeeded(b) {
    if (b.analysis.errors.some(function (e) { return e.code === 'missing-columns'; })) $('sec-cols').open = true;
    if (b.inputs && b.inputs.messages.errors.length) $('sec-params').open = true;
  }

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

  /** A long value, such as 0.00488505, gets a wider box so no digit is hidden. */
  function fitParamBox(input) { input.closest('.prm').classList.toggle('is-wide', input.value.trim().length > 8); }

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
      input.addEventListener('input', function () { fitParamBox(input); clearTimeout(timer); timer = setTimeout(function () { commit(false); }, 450); });
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
        fitParamBox(input);
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

  /* ---------- drive mechanism: wording shared by the sidebar, the notes and the export ---------- */
  function reText(r) { return r === Infinity || r === 'inf' ? '∞' : String(r); }
  function pctText(v) { var a = Math.abs(v * 100); return (a >= 10 ? a.toFixed(0) : a >= 1 ? a.toFixed(1) : a.toFixed(2)) + ' %'; }

  /** Time constant of the unsteady-state aquifer in words: t_D per day, per year, or per row step. */
  function tdText(b, a) {
    if (b.detection && b.detection.timeMode === 'steps') return fmtSig(a, 3) + ' per row';
    return fmtSig(a * 365.25, 3) + ' per year';
  }

  /** The aquifer of a model, in words (rich text). */
  function aquiferText(b, c) {
    if (!c || !c.water) return '';
    if (c.aquifer === 'column') return 'W_e from the file';
    if (c.aquifer === 'pot') return 'Pot aquifer, K = ' + fmtFixed(c.fit.U, 0) + ' rb/psi';
    if (c.aquifer === 'steady') return 'Steady-state aquifer, C = ' + fmtSig(c.fit.U * (b.detection.timeMode === 'steps' ? 1 : 365.25), 4) + (b.detection.timeMode === 'steps' ? ' rb/psi per row' : ' rb/psi per year');
    if (c.aquifer === 'veh') return 'Unsteady-state aquifer (van Everdingen–Hurst), r_e/r_o = ' + reText(c.reD) + ', U = ' + fmtFixed(c.fit.U, 0) + ' rb/psi, t_D = ' + tdText(b, c.a);
    return '';
  }

  function familyName(b) {
    var c = b.model;
    if (!c) return 'No clear drive mechanism';
    return D.NAMES[c.family];
  }

  /** One line under the mechanism: what it consists of. */
  function familyLine(b) {
    var c = b.model, det = b.detection;
    if (!c) return 'No mechanism both makes physical sense and fits the data. The results below are for depletion alone.';
    var parts = [];
    var sat = det.saturation || {};
    if (c.family === 'depletion') {
      parts.push(b.inputs.noGas || sat.allAbove ? 'Oil and rock expansion above the bubble point' : 'Solution gas and rock expansion');
      parts.push('no gas cap, no water influx');
    } else if (c.family === 'gascap') {
      parts.push(c.key === 'gascap-known' ? 'Gas cap of the given size, m = ' + fmtM(c.mFixed) : 'Gas cap, m = ' + fmtM(b.result.results ? b.result.results.m : c.fit.m));
      parts.push('no water influx');
    } else if (c.family === 'water') {
      parts.push(aquiferText(b, c));
      if (!(c.mFixed > 0)) parts.push('no gas cap');
    } else {
      parts.push('Gas cap, m = ' + fmtM(b.result.results ? b.result.results.m : c.fit.m));
      parts.push(aquiferText(b, c).replace(/^./, function (x) { return x.toLowerCase(); }));
    }
    return parts.join('; ') + '.';
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
    var weCard = $('res-We');
    if (!hasFit(b)) {
      $('eq').innerHTML = b.blocking ? 'No data yet' : 'Not enough data for a line';
      $('fitline').textContent = '';
      setRes('res-N', '–', nu); setRes('res-m', '–', ''); setRes('res-G', '–', G_LABEL[gu]);
      weCard.hidden = true;
      $('ledger').classList.remove('has-we');
      renderRecovery(null, nu);
      return;
    }
    var R = b.result.results, fit = b.result.fit, c = b.model;
    var a = R.N / N_DIV[nu];
    if (b.view === 'origin') {
      $('eq').innerHTML = (influxOn(b) ? '<var>F</var> − <var>W</var><sub>e</sub>' : '<var>F</var>') + ' = <var>N</var> <var>E</var><sub>t</sub>, slope <var>N</var> = <strong class="n">' + esc(fmtRes(a)) + '</strong> <span class="ho-eq-label">' + esc(nu) + '</span>';
    } else if (b.view === 'water') {
      $('eq').innerHTML = '<var>y</var> = <strong class="n">' + esc(fmtRes(a)) + '</strong> + <var>x</var> <span class="ho-eq-label">(' + esc(nu) + '; slope 1)</span>';
    } else {
      var sl = R.mN / N_DIV[nu];
      $('eq').innerHTML = '<var>y</var> = <strong class="n">' + esc(fmtRes(a)) + '</strong> ' + (sl < 0 ? '−' : '+') + ' <strong class="n">' +
        esc(fmtRes(Math.abs(sl))) + '</strong> <var>x</var> <span class="ho-eq-label">(' + esc(nu) + ')</span>';
    }
    $('fitline').innerHTML = 'R² = <strong>' + fit.r2.toFixed(3) + '</strong> from ' + plural(fit.n, 'point');
    var ci = function (pair, div, fmt) {
      return pair ? '95 % range: ' + fmt(pair[0] / div) + ' to ' + fmt(pair[1] / div) : '';
    };
    var rob = c && c.robustness && c.robustness.trials >= 20 ? c.robustness : null;
    var nCi = ci(R.ciN, N_DIV[nu], fmtRes);
    if (rob && (rob.N[2] - rob.N[0]) > 0.02 * Math.abs(R.N)) nCi += (nCi ? '; ' : '') + 'rounding the table: ' + fmtRes(rob.N[0] / N_DIV[nu]) + ' to ' + fmtRes(rob.N[2] / N_DIV[nu]);
    setRes('res-N', fmtRes(R.N / N_DIV[nu]), nu, nCi, R.N <= 0 ? 'Not physical: see the fit notes' : '');
    $('res-N').querySelector('.res-how').innerHTML = b.view === 'origin' ? 'Slope of <var>F</var> against <var>E</var><sub>t</sub>' : 'Intercept of the line';
    if (R.mFixed) {
      setRes('res-m', fmtM(R.m), '', '');
      $('res-m').querySelector('.res-how').innerHTML = R.m > 0 ? 'Given in the file' : 'No gas cap in this mechanism';
    } else {
      setRes('res-m', fmtM(R.m), '', ci(R.ciM, 1, fmtM), R.N > 0 && R.m < 0 ? 'Negative: see the fit notes' : '');
      $('res-m').querySelector('.res-how').innerHTML = 'Slope ÷ intercept';
    }
    setRes('res-G', R.m === 0 ? '0' : fmtRes(R.G / G_DIV[gu]), G_LABEL[gu], R.m === 0 ? '' : ci(R.ciG, G_DIV[gu], fmtRes), R.N > 0 && R.m < 0 ? 'Negative: see the fit notes' : '');
    // water influx at the last step in the fit
    var inc = b.result.terms.filter(function (t) { return t.included; });
    var last = inc[inc.length - 1];
    var showWe = influxOn(b) && last && isFinite(last.We);
    weCard.hidden = !showWe;
    $('ledger').classList.toggle('has-we', !!showWe);
    if (showWe) {
      setRes('res-We', fmtRes(last.We / 1e6), 'MM rb', 'at ' + fmtFixed(last.p, 0) + ' psia: ' + pctText(last.We / last.F) + ' of F');
      $('res-We-how').innerHTML = rich(aquiferText(b, c));
    }
    renderRecovery(E.recovery(b.result.terms, R.N), nu, R.N);
  }

  /** RF as a percentage: 16.3, 4.25, 104. */
  function rfText(rf) {
    var a = rf * 100;
    return a >= 100 ? a.toFixed(0) : a >= 10 ? a.toFixed(1) : a.toFixed(2);
  }

  /** The recovery card: N_p at the latest step over N, what is left, and a bar. */
  function renderRecovery(rec, nu, N) {
    var bar = $('res-RF').querySelector('.res-bar span');
    if (!rec) {
      setRes('res-RF', '–', '', '');
      $('res-RF-how').innerHTML = '<var>N</var><sub>p</sub> ÷ <var>N</var>';
      bar.style.width = '0';
      return;
    }
    var d = N_DIV[nu];
    var told = fmtRes(rec.Np / d) + ' of ' + fmtRes(N / d) + ' ' + nu + ' produced' + (rec.remaining > 0 ? '; ' + fmtRes(rec.remaining / d) + ' ' + nu + ' remain' : '');
    setRes('res-RF', rfText(rec.RF), '%', told, rec.RF > 1 ? 'More than N: check the fit' : '');
    $('res-RF-how').innerHTML = '<var>N</var><sub>p</sub> ÷ <var>N</var> at ' + esc(fmtFixed(rec.p, 0)) + ' psia';
    bar.style.width = Math.min(100, rec.RF * 100).toFixed(2) + '%';
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
    if (!state.includeEfw) out.push({ level: 'info', code: 'efw-off', text: 'E_fw is switched off, so connate water and rock expansion are neglected.' });
    if (b.detection && b.model && b.model.sc.rms > D.POOR) {
      out.push({ level: 'warning', code: 'poor-fit', text: 'Even the best model misses F by ' + pctText(b.model.sc.rms) + ' on average, so treat these results with care. Check the units and the PVT data, or leave out points that do not follow the trend.' });
    }
    if (b.detection && !b.model) out.push({ level: 'warning', code: 'no-model', text: 'No mechanism both makes physical sense and fits the data. The results are for depletion alone.' });
    if (b.detection && b.detection.assumedSteps) out.push({ level: 'info', code: 'steps', text: 'There is no time column, so the rows are taken as equal time steps (for example, one per year) for the aquifer. If they are not, add a time column.' });
    add('info', a.infos);
    if (b.inputs) add('info', b.inputs.messages.infos.filter(function (m) { return !(m.code === 'efw-default' && !state.includeEfw); }));
    if (b.result) add('info', b.result.messages.infos);
    if (hasFit(b) && b.view !== 'origin' && !out.some(function (m) { return m.level !== 'info'; }) && b.result.fit.n >= 3 && b.result.fit.r2 >= 0.95) {
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
    var pm = function (v, se, d, f) { return f(v / d) + (isFinite(se) && isFinite(fit.tcrit) ? ' ± ' + f(fit.tcrit * se / d) : ''); };
    var rows = [['Points in the fit', fit.n + ' of ' + usable], ['R²', fit.r2.toFixed(4)]];
    if (b.view === 'origin') {
      rows.push(['Slope, <var>N</var>', pm(R.N, R.seN, div, fmtRes) + ' ' + nu]);
      rows.push(['<var>m</var>', fmtM(R.m) + (R.m > 0 ? ', given' : ', no gas cap')]);
      rows.push(['Scatter of <var>F</var> about the line', isFinite(fit.s) ? fmtRes(fit.s / 1e6) + ' MM rb' : '–']);
    } else if (b.view === 'water') {
      var c = b.model, uUnit = c && c.aquifer === 'steady' ? (b.detection.timeMode === 'steps' ? 'rb/psi per row' : 'rb/(psi·day)') : 'rb/psi';
      rows.push(['Intercept, <var>N</var>', pm(R.N, R.seN, div, fmtRes) + ' ' + nu]);
      if (c && c.aquifer === 'column') rows.push(['Water influx', '<var>W</var><sub>e</sub> from the file']);
      else rows.push(['Aquifer constant, ' + (c && c.aquifer === 'pot' ? '<var>K</var>' : c && c.aquifer === 'steady' ? '<var>C</var>' : '<var>U</var>'),
        (isFinite(R.seU) && isFinite(fit.tcrit) ? fmtSig(R.U, 4) + ' ± ' + (fit.tcrit * R.seU < 5e-5 * Math.abs(R.U) ? '0' : fmtSig(fit.tcrit * R.seU, 2)) : fmtSig(R.U, 4)) + ' ' + uUnit]);
      rows.push(['<var>m</var>', fmtM(R.m) + (R.m > 0 ? ', given' : ', no gas cap')]);
      rows.push(['Scatter of <var>y</var> about the line', isFinite(fit.s) ? fmtRes(fit.s / div) + ' ' + nu : '–']);
    } else {
      rows.push(['Intercept, <var>N</var>', pm(R.N, R.seN, div, fmtRes) + ' ' + nu]);
      rows.push(['Slope, <var>mN</var>', pm(R.mN, R.seMN, div, fmtRes) + ' ' + nu]);
      rows.push(['<var>m</var>', fmtM(R.m) + (isFinite(R.seM) ? ' ± ' + (fit.tcrit * R.seM < 5e-4 ? '0.000' : fmtM(fit.tcrit * R.seM)) : '')]);
      rows.push(['Scatter of <var>y</var> about the line', isFinite(fit.s) ? fmtRes(fit.s / div) + ' ' + nu : '–']);
    }
    rows.push(['Degrees of freedom', String(fit.dof)]);
    rows.push(['Student <var>t</var> at 95 %', isFinite(fit.tcrit) ? fit.tcrit.toFixed(3) : 'needs 3 points']);
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

  /** The Havlena–Odeh plot for the chosen model: its title, the line under it and the chart options. */
  function hoSpec(b, extra) {
    var nu = state.out.N, div = N_DIV[nu];
    var fitOk = hasFit(b);
    var R = fitOk ? b.result.results : null;
    var efw = anyEfw(b);
    var etTitle = R && R.mFixed && R.m > 0 ? '*E*_t' : (efw ? '(*E*_o + *E*_fw)' : '*E*_o');
    var hoOpts = Object.assign({
      points: hoPoints(b),
      fit: fitOk ? { a: R.N, b: R.mN } : null,
      yDiv: div, yUnit: nu, efw: efw, influx: influxOn(b),
      labelsAll: state.labelsAll,
      Ntext: fitOk ? fmtRes(R.N / div) + ' ' + nu : '',
      mNtext: fitOk ? fmtRes(R.mN / div) + ' ' + nu : '',
      emptyText: 'No points below the initial pressure.'
    }, extra || {});
    var title = 'Havlena–Odeh plot', sub = '';
    if (b.view === 'origin') {
      title = 'Havlena–Odeh plot: ' + (influxOn(b) ? '<var>F</var> − <var>W</var><sub>e</sub>' : '<var>F</var>') + ' against <var>E</var><sub>t</sub>';
      sub = 'With ' + (influxOn(b) ? 'the water influx known' : (R && R.m > 0 ? 'the gas cap known' : 'depletion alone')) + ', the points lie on a straight line through the origin, and its slope is <var>N</var>. Click a point to leave it out of the fit.';
      Object.assign(hoOpts, {
        fit: fitOk ? { a: 0, b: R.N } : null, yDiv: 1e6, yUnit: 'MM rb', noIntercept: true,
        xTitle: (R && R.m > 0 ? '*E*_t' : (efw ? '*E*_o + *E*_fw' : '*E*_o')) + ', rb/STB',
        yTitle: (influxOn(b) ? '*F* − *W*_e' : '*F*') + ', MM rb',
        slopeLabel: fitOk ? 'slope *N* = ' + fmtRes(R.N / div) + ' ' + nu : ''
      });
    } else if (b.view === 'water') {
      title = 'Havlena–Odeh plot: <var>F</var>/<var>E</var><sub>t</sub> against <var>W</var><sub>e</sub>/<var>E</var><sub>t</sub>';
      sub = 'With the right aquifer, the points lie on a straight line of slope 1 that meets the axis at <var>N</var>. Click a point to leave it out of the fit.';
      Object.assign(hoOpts, {
        points: hoPoints(b).map(function (q) { return Object.assign({}, q, { x: q.x / div }); }),
        fit: fitOk ? { a: R.N, b: div } : null,
        xTitle: '*W*_e / ' + etTitle + ', ' + nu, yTitle: '*F* / ' + etTitle + ', ' + nu,
        slopeLabel: 'slope 1'
      });
    } else {
      sub = (influxOn(b) ? 'With the water influx taken off <var>F</var>, the points' : 'The points') + ' lie on a straight line that meets the axis at <var>N</var>; its slope is <var>mN</var>. Click a point to leave it out of the fit.';
    }
    return { title: title, sub: sub, opts: hoOpts };
  }

  function renderCharts(b, opts) {
    opts = opts || {};
    $('calc-btn').disabled = !hasFit(b);
    var nu = state.out.N, div = N_DIV[nu];
    var ho = $('chart-ho'), chk = $('chart-check'), drv = $('chart-drive');
    if (!b.result || !b.result.terms.length) {
      var msg = b.blocking ? 'Load a file with production data to see the plot.' :
        (b.inputs && b.inputs.messages.errors.length ? 'Fix the reservoir parameters on the left to see the plot.' : 'No points to plot.');
      C.empty(ho, msg); C.empty(chk, msg); C.empty(drv, msg);
      C.legend($('legend-ho'), [], {}); C.legend($('legend-check'), [], {}); C.legend($('legend-drive'), [], {});
      renderExplorer(b, { reset: true });
      renderSketch(b);
      $('reset-points').hidden = true;
      return;
    }
    var fitOk = hasFit(b);
    var R = fitOk ? b.result.results : null;
    var efw = anyEfw(b);
    var spec = hoSpec(b, { legendEl: $('legend-ho'), animate: !opts.noAnim, onToggle: toggleRow });
    $('ho-title').innerHTML = spec.title;
    $('ho-sub').innerHTML = spec.sub;
    C.hoPlot(ho, spec.opts);
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
    renderSketch(b);
  }

  /* ---------- reservoir sketch: where the gas, oil and water are at each pressure ---------- */
  var sketch = { steps: null, at: 0, key: '', timer: null };

  function renderSketch(b) {
    var fitOk = hasFit(b), R = fitOk ? b.result.results : null;
    var steps = fitOk && R.N > 0 ? E.fluids(b.result.terms, R.N, R.m, b.inputs.params) : null;
    var ok = !!(steps && steps.length);
    $('sk-range').disabled = !ok;
    $('sk-play').disabled = !ok || steps.length < 2;
    if (!ok) {
      stopSketch();
      sketch.steps = null;
      C.empty($('sketch'), fitOk ? 'The sketch needs a positive N. See the fit notes.' : 'The sketch appears once N and m are found.');
      $('sk-out').textContent = '–';
      $('sk-side').innerHTML = '';
      return;
    }
    // a new data set opens on its latest step; otherwise the step shown stays
    var key = state.source.name + '|' + steps.map(function (st) { return st.id; }).join(',');
    if (key !== sketch.key) { sketch.key = key; sketch.at = steps.length - 1; stopSketch(); }
    sketch.steps = steps;
    sketch.at = Math.max(0, Math.min(steps.length - 1, sketch.at));
    var range = $('sk-range');
    range.max = steps.length - 1;
    range.value = sketch.at;
    drawSketch(b);
  }

  function drawSketch(b) {
    var steps = sketch.steps;
    if (!steps || !b || !hasFit(b)) return;
    var st = steps[sketch.at], s0 = steps[0];
    var R = b.result.results, c = b.model, nu = state.out.N, div = N_DIV[nu];
    var gasCap = R.m > 0;
    var row = b.inputs.rows.filter(function (r) { return r.id === st.id; })[0] || {};
    var aq = null;
    if (influxOn(b) && c) {
      var reD = c.reD === 'inf' ? Infinity : Number(c.reD);
      aq = c.aquifer === 'pot' ? { reach: 1.85, lines: ['Pot aquifer'] }
        : c.aquifer === 'steady' ? { reach: Infinity, lines: ['Aquifer', 'steady state'] }
        : c.aquifer === 'veh' ? { reach: isFinite(reD) ? reD : Infinity, lines: ['Aquifer', isFinite(reD) ? '*r*_e/*r*_o = ' + reText(c.reD) : 'infinite'] }
        : { reach: Infinity, lines: ['Aquifer', '*W*_e from the file'] };
    }
    var pText = fmtFixed(st.p, 0) + ' psia';
    var corner = ['*p* = ' + pText, '*N*_p = ' + (st.Np > 0 ? fmtRes(st.Np / div) : '0') + ' ' + nu];
    if (b.inputs.hasTime && isFinite(row.t)) corner.push('*t* = ' + fmtFixed(row.t / 365.25, row.t % 365.25 ? 1 : 0) + ' years');
    var pc = function (f) { return f < 0.0005 ? '0 %' : pctText(f); };
    var label = 'Reservoir sketch at ' + pText + ': ' + (gasCap ? 'gas cap' : 'free gas') + ' ' + pc(st.gas) + ', oil ' + pc(st.oil) +
      (aq ? ', water that came in ' + pc(st.water) : '') + ' of the hydrocarbon pore volume.';
    var geo = C.reservoirSketch($('sketch'), {
      now: st, start: s0, gasCap: gasCap, aquifer: aq,
      gasLines: gasCap ? ['Gas cap', '*m* = ' + fmtM(R.m)] : null,
      oilLines: ['Oil', '*N* = ' + fmtRes(R.N / div) + ' ' + nu],
      corner: corner, label: label
    });
    $('sk-out').textContent = pText;
    $('sk-range').setAttribute('aria-valuetext', pText);
    var hatchG = geo && geo.goc != null && geo.gocStart != null && geo.goc > geo.gocStart + 0.5;
    var hatchW = geo && geo.owc != null && geo.owc < geo.owcStart - 0.5;
    // the numbers beside it
    var hc = st.hcpv;
    var mmrb = function (f) { var v = f * hc / 1e6; return v < 0.05 ? '0' : fmtRes(v); };
    var share = function (f) { return f < 0.0005 ? '0 %' : pctText(f); };
    var line = function (cls, name, f) {
      return '<tr><th><span class="sk-sw ' + cls + '"></span>' + name + '</th><td>' + mmrb(f) + '</td><td>' + share(f) + '</td></tr>';
    };
    var anyGas = gasCap || steps.some(function (x) { return x.gas > 0.0005; });
    var rows = anyGas ? [line('sk-sw-gas', gasCap ? 'Gas cap' : 'Gas out of the oil', st.gas)] : [];
    rows.push(line('sk-sw-oil', 'Oil', st.oil));
    if (aq) rows.push(line('sk-sw-water', 'Water that came in', st.water));
    if (st.shrink > 0.0005) rows.push(line('sk-sw-rock', 'Rock and water expansion', st.shrink));
    var notes = ['Oil left: ' + fmtRes((R.N - st.Np) / div) + ' of ' + fmtRes(R.N / div) + ' ' + esc(nu) + '.'];
    if (R.m < 0) notes.push('The fitted <var>m</var> is negative, which has no physical meaning, so no gas cap is drawn. See the fit notes.');
    if (gasCap) notes.push('At the start the gas cap filled ' + pctText(s0.gas) + ' of the pore volume. Gas that comes out of the oil is drawn in the gas cap.');
    else if (anyGas) notes.push('Gas that comes out of the oil is drawn as bubbles.');
    if (st.over > 0.03) notes.push('At this pressure the fitted line does not balance exactly: oil' + (aq ? ', water' : '') + ' and rock expansion add up to ' + pctText(1 + st.over) + ' of the pore volume.');
    $('sk-side').innerHTML = '<p class="sk-h">At ' + esc(pText) + '</p>' +
      '<table class="sk-table"><thead><tr><th>Hydrocarbon pore volume</th><th>MM rb</th><th>Share</th></tr></thead><tbody>' + rows.join('') +
      '<tr class="sk-total"><th>Total at the start</th><td>' + fmtRes(hc / 1e6) + '</td><td>100 %</td></tr></tbody></table>' +
      notes.map(function (n) { return '<p class="sk-note">' + n + '</p>'; }).join('') +
      (hatchG || hatchW ? '<p class="sk-note"><span class="sk-sw sk-sw-hatch"></span>Hatched: where ' + (hatchG && hatchW ? 'gas or water has' : hatchW ? 'water has' : 'gas has') + ' moved in since the start.</p>' : '');
  }

  function setPlaying(on) {
    var btn = $('sk-play');
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    btn.querySelector('span').textContent = on ? 'Pause' : 'Play';
  }

  function stopSketch() {
    if (sketch.timer) clearTimeout(sketch.timer);
    sketch.timer = null;
    setPlaying(false);
  }

  /** Steps through the pressures from the start, about three seconds in all. */
  function playSketch() {
    if (sketch.timer) { stopSketch(); return; }
    var n = sketch.steps ? sketch.steps.length : 0;
    if (n < 2) return;
    if (sketch.at >= n - 1) sketch.at = 0;
    var stride = Math.max(1, Math.ceil(n / 40)), delay = Math.max(70, Math.min(450, 3000 / Math.ceil(n / stride)));
    var show = function () { $('sk-range').value = sketch.at; drawSketch(state.bundle); };
    var tick = function () {
      sketch.at = Math.min(n - 1, sketch.at + stride);
      show();
      if (sketch.at >= n - 1) stopSketch(); else sketch.timer = setTimeout(tick, delay);
    };
    setPlaying(true);
    show();
    sketch.timer = setTimeout(tick, delay);
  }

  /* ---------- calculations: every step from the data to the results, with the numbers put in ---------- */
  var cx = { id: null };

  /** v with n significant digits and thousands separators; × 10^k when it is very large or very small. */
  function sigText(v, n) {
    if (!isFinite(v)) return '–';
    if (v === 0) return '0';
    n = n || 5;
    var e = Math.floor(Math.log10(Math.abs(v)));
    if (e >= 6 || e <= -4) {
      var mant = Number((v / Math.pow(10, e)).toPrecision(n));
      if (Math.abs(mant) >= 10) { mant /= 10; e += 1; }
      return fmtFixed(mant, n - 1) + ' × 10<sup>' + minus(String(e)) + '</sup>';
    }
    return fmtFixed(v, Math.max(0, n - 1 - e));
  }

  /** A value from the data as it is written there; large ones as × 10⁶ or × 10⁹, tiny ones as × 10⁻ᵏ. */
  function givenText(v) {
    if (!isFinite(v)) return '–';
    var a = Math.abs(v);
    if (a >= 1e6) {
      var e = a >= 1e9 ? 9 : 6, mant = v / Math.pow(10, e);
      return fmtFixed(mant, decimalsOf(mant)) + ' × 10<sup>' + e + '</sup>';
    }
    if (a > 0 && a < 1e-4) return sciText(v);
    return fmtFixed(v, decimalsOf(v));
  }

  var cxOp = function (s) { return '<span class="op">' + s + '</span>'; };
  var cxFr = function (a, b) { return '<span class="frac"><span class="num">' + a + '</span><span class="den">' + b + '</span></span>'; };
  var cxPar = function (s) { return /× 10/.test(s) ? '(' + s + ')' : s; };   // a number written with × 10ᵏ, as a factor

  /** One worked line: the formula, the numbers put in, the result. */
  function cxLine(lhs, formula, numbers, result, unit) {
    var parts = ['<span class="part">' + lhs + cxOp('=') + formula + '</span>'];
    if (numbers) parts.push('<span class="part">' + cxOp('=') + numbers + '</span>');
    if (result != null) parts.push('<span class="part cx-res">' + cxOp('=') + '<b>' + result + '</b>' + (unit ? '<span class="cx-u">' + unit + '</span>' : '') + '</span>');
    return '<div class="eqn wrap cx-line">' + parts.join('') + '</div>';
  }
  function cxSec(no, title, html) {
    return '<section class="cx-sec"><h3><span class="cx-no">' + no + '</span>' + title + '</h3>' + html + '</section>';
  }
  function cxP(html) { return '<p class="cx-p">' + html + '</p>'; }

  function renderCalcs(b) {
    var body = $('cx-body');
    if (!b || !hasFit(b)) { body.innerHTML = cxP('The calculations appear once a straight line is fitted to the data.'); return; }
    var R = b.result.results, fit = b.result.fit, P0 = b.inputs.params, c = b.model;
    var terms = b.result.terms, inc = terms.filter(function (t) { return t.included; });
    var view = b.view, noGas = !!b.inputs.noGas, water = influxOn(b), aq = water ? c.aquifer : null;
    var efw = anyEfw(b), gas = R.m > 0;
    var mAx = view === 'line' ? (isFinite(fit.mAxes) ? fit.mAxes : R.m) : (gas ? R.m : 0);   // the m on the axes
    var V = rv, s5 = function (v) { return sigText(v, 5); }, g = function (v) { return cxPar(givenText(v)); };
    var F = V('F'), N = V('N'), m = V('m'), Np = V('N', 'p'), Gp = V('G', 'p'), Bo = V('B', 'o'), Boi = V('B', 'oi'), Bg = V('B', 'g'), Bgi = V('B', 'gi');
    var Rs = V('R', 's'), Rsi = V('R', 'si'), Rp = V('R', 'p'), Eo = V('E', 'o'), Eg = V('E', 'g'), Efw = V('E', 'fw'), Et = V('E', 't'), We = V('W', 'e');
    var Swc = V('S', 'wc'), Cw = V('C', 'w'), Cf = V('C', 'f'), pi = V('p', 'i'), p = V('p'), x = V('x'), y = V('y');
    var withEg = !noGas && (view === 'line' || gas);
    var withEt = view !== 'line';
    var aqSym = aq === 'pot' ? V('K') : aq === 'steady' ? V('C') : V('U');
    var S = c && c.S ? c.S : {};
    var tUnit = b.detection && b.detection.timeMode === 'steps' ? 'row' : 'day';
    var h = [];

    // 1 the initial values
    var gv = [[pi, givenText(P0.pi), 'psia'], [Boi, givenText(P0.Boi), 'rb/STB']];
    if (!noGas) gv.push([Bgi, givenText(P0.Bgi), 'rb/SCF'], [Rsi, givenText(P0.Rsi), 'SCF/STB']);
    if (efw) gv.push([Swc, givenText(P0.Swc), ''], [Cw, sciText(P0.Cw), 'psi<sup>−1</sup>'], [Cf, sciText(P0.Cf), 'psi<sup>−1</sup>']);
    if (gas && R.mFixed) gv.push([m, givenText(R.m), '(given)']);
    var n1 = ['Field units throughout: ' + Np + ' in STB, ' + Gp + ' in SCF, ' + Bo + ' in rb/STB, ' + Rs + ' in SCF/STB and ' + Bg + ' in rb/SCF (ft³/SCF ÷ 5.615). Values in other units were converted first.'];
    if (noGas) n1.push('There are no ' + Rs + ', ' + Bg + ' or ' + Gp + ' columns, so the oil is taken as undersaturated: ' + Rs + ' = ' + Rsi + ' and no gas comes out of it.');
    else if (!efw) n1.push(state.includeEfw ? Swc + ', ' + Cw + ' and ' + Cf + ' are not given, so ' + Efw + ' = 0.' : 'Water and rock expansion is switched off, so ' + Efw + ' = 0.');
    h.push(cxSec(1, 'Initial values', '<div class="cx-given">' + gv.map(function (q) { return '<span>' + q[0] + ' = ' + q[1] + (q[2] ? ' <span class="cx-u">' + q[2] + '</span>' : '') + '</span>'; }).join('') + '</div>' + n1.map(cxP).join('')));

    // 2 the terms at one pressure
    var pts = terms.filter(function (t) { return t.Np > 0 && isFinite(t.p); });
    if (!pts.some(function (t) { return t.id === cx.id; })) cx.id = (inc[0] || pts[0] || {}).id;
    var t = pts.filter(function (q) { return q.id === cx.id; })[0];
    var pick = pts.length <= 14
      ? '<div class="cx-chips" role="group" aria-label="Pressure">' + pts.map(function (q) {
          return '<button type="button" class="cx-chip" data-cx-id="' + esc(q.id) + '" aria-pressed="' + (q.id === cx.id) + '">' + fmtFixed(q.p, 0) + '</button>';
        }).join('') + '<span class="cx-u">psia</span></div>'
      : '<label class="cx-pick">Pressure <select id="cx-select">' + pts.map(function (q) {
          return '<option value="' + esc(q.id) + '"' + (q.id === cx.id ? ' selected' : '') + '>' + fmtFixed(q.p, 0) + ' psia</option>';
        }).join('') + '</select></label>';
    var L = [];
    if (t) {
      var row = b.inputs.rows.filter(function (r) { return r.id === t.id; })[0] || {};
      var data = [Np + ' = ' + givenText(t.Np) + ' STB'];
      if (!noGas) data.push(Gp + ' = ' + givenText(t.Gp) + ' SCF');
      data.push(Bo + ' = ' + givenText(t.Bo) + ' rb/STB');
      if (!noGas) data.push(Rs + ' = ' + givenText(t.Rs) + ' SCF/STB', Bg + ' = ' + givenText(t.Bg) + ' rb/SCF');
      if (t.Wp > 0) data.push(V('W', 'p') + ' = ' + givenText(t.Wp) + ' STB', V('B', 'w') + ' = ' + givenText(t.Bw) + ' rb/STB');
      if (aq === 'column') data.push(We + ' = ' + givenText(t.We) + ' rb');
      L.push(cxP('At ' + p + ' = ' + fmtFixed(t.p, 0) + ' psia the table gives ' + andList(data) + '.'));
      var wpF = t.Wp > 0 ? cxOp('+') + V('W', 'p') + ' ' + V('B', 'w') : '', wpN = t.Wp > 0 ? cxOp('+') + g(t.Wp) + ' × ' + givenText(t.Bw) : '';
      if (noGas) {
        L.push(cxLine(F, Np + ' ' + Bo + wpF, g(t.Np) + ' × ' + givenText(t.Bo) + wpN, s5(t.F), 'rb'));
        L.push(cxLine(Eo, Bo + cxOp('−') + Boi, givenText(t.Bo) + cxOp('−') + givenText(P0.Boi), s5(t.Eo), 'rb/STB'));
      } else {
        L.push(cxLine(Rp, cxFr(Gp, Np), cxFr(givenText(t.Gp), givenText(t.Np)), s5(t.Rp), 'SCF/STB'));
        L.push(cxLine(F, Np + ' [' + Bo + cxOp('+') + '(' + Rp + cxOp('−') + Rs + ') ' + Bg + ']' + wpF,
          g(t.Np) + ' × [' + givenText(t.Bo) + cxOp('+') + '(' + s5(t.Rp) + cxOp('−') + givenText(t.Rs) + ') × ' + givenText(t.Bg) + ']' + wpN, s5(t.F), 'rb'));
        L.push(cxLine(Eo, '(' + Bo + cxOp('−') + Boi + ')' + cxOp('+') + '(' + Rsi + cxOp('−') + Rs + ') ' + Bg,
          '(' + givenText(t.Bo) + cxOp('−') + givenText(P0.Boi) + ')' + cxOp('+') + '(' + givenText(P0.Rsi) + cxOp('−') + givenText(t.Rs) + ') × ' + givenText(t.Bg), s5(t.Eo), 'rb/STB'));
      }
      if (withEg) L.push(cxLine(Eg, Boi + ' (' + cxFr(Bg, Bgi) + cxOp('−') + '1)', givenText(P0.Boi) + ' × (' + cxFr(givenText(t.Bg), givenText(P0.Bgi)) + cxOp('−') + '1)', s5(t.Eg), 'rb/STB'));
      if (efw) L.push(cxLine(Efw, Boi + ' ' + cxFr(Cw + ' ' + Swc + cxOp('+') + Cf, '1' + cxOp('−') + Swc) + ' (' + pi + cxOp('−') + p + ')',
        givenText(P0.Boi) + ' × ' + cxFr(cxPar(sciText(P0.Cw)) + ' × ' + givenText(P0.Swc) + cxOp('+') + cxPar(sciText(P0.Cf)), '1' + cxOp('−') + givenText(P0.Swc)) + ' × (' + givenText(P0.pi) + cxOp('−') + givenText(t.p) + ')', s5(t.Efw), 'rb/STB'));
      // water influx at this step (in the water view it follows x and y, as it needs U from step 4)
      var weLines = [];
      if (water && aq !== 'column' && isFinite(S[t.id])) {
        var Uc = cxPar(s5(c.fit.U)), Sx = cxPar(s5(S[t.id]));
        var from = '<span class="part cx-from">' + (view === 'water' ? '(' + aqSym + ' from step 4)' : '(' + aqSym + ' found with ' + N + ' and ' + m + ', step 5)') + '</span>';
        if (aq === 'steady' && view !== 'water') weLines.push(cxP('The steady-state aquifer needs ∫ (' + pi + ' − ' + p + ') d' + V('t') + ' up to this step. Adding trapezoids between the steps gives ' + s5(S[t.id]) + ' psi·' + tUnit + (tUnit === 'row' ? ' (the rows taken as equal time steps)' : '') + '.'));
        if (aq === 'veh' && view !== 'water') weLines.push(cxP('The unsteady-state aquifer adds up the pressure steps Δ' + V('p', 'j') + ' since the start, each weighted by the dimensionless influx ' + V('W', 'D') + ' of a radial aquifer with ' + V('r', 'e') + '/' + V('r', 'o') + ' = ' + reText(c.reD) +
          ', at ' + V('t', 'D') + ' = ' + V('a') + ' ' + V('t') + ' with ' + V('a') + ' = ' + tdText(b, c.a) + '. For this step Σ Δ' + V('p', 'j') + ' ' + V('W', 'D') + ' = ' + s5(S[t.id]) + ' psi.'));
        var weF = aq === 'pot' ? aqSym + ' (' + pi + cxOp('−') + p + ')'
          : aq === 'steady' ? aqSym + ' ∫<sub>0</sub><sup><var>t</var></sup> (' + pi + cxOp('−') + p + ') d' + V('t')
          : aqSym + ' Σ<sub><var>j</var></sub> Δ' + V('p', 'j') + ' ' + V('W', 'D') + '(' + V('t', 'D') + cxOp('−') + V('t', 'D<var>j</var>') + ')';
        var weN = aq === 'pot' ? Uc + ' × (' + givenText(P0.pi) + cxOp('−') + givenText(t.p) + ')' : Uc + ' × ' + Sx;
        weLines.push(cxLine(We, weF, weN, s5(t.We), 'rb').replace(/<\/div>$/, from + '</div>'));
      }
      if (view !== 'water') L = L.concat(weLines);
      // the point on the line
      if (view === 'line') {
        var den = efw ? Eo + cxOp('+') + '(1' + cxOp('+') + m + ') ' + Efw : Eo;
        var denV = t.Eo + (1 + mAx) * t.Efw;
        if (efw) L.push(cxLine(V('E'), den, s5(t.Eo) + cxOp('+') + '(1' + cxOp('+') + fmtFixed(mAx, 4) + ') × ' + s5(t.Efw), s5(denV), 'rb/STB'));
        var dSym = efw ? V('E') : Eo;
        L.push(cxLine(x, cxFr(Eg, dSym), cxFr(s5(t.Eg), s5(denV)), s5(t.x), ''));
        L.push(cxLine(y, cxFr(water ? F + cxOp('−') + We : F, dSym), cxFr(water ? cxPar(s5(t.F)) + cxOp('−') + cxPar(s5(t.We)) : s5(t.F), s5(denV)), s5(t.y / 1e6), 'MMSTB'));
      } else {
        var etF = Eo + (gas ? cxOp('+') + m + ' ' + Eg : '') + (efw ? cxOp('+') + (gas ? '(1' + cxOp('+') + m + ') ' : '') + Efw : '');
        var etN = s5(t.Eo) + (gas ? cxOp('+') + fmtFixed(R.m, 4) + ' × ' + s5(t.Eg) : '') + (efw ? cxOp('+') + (gas ? '(1' + cxOp('+') + fmtFixed(R.m, 4) + ') × ' : '') + s5(t.Efw) : '');
        var etV = t.Eo + R.m * t.Eg + (1 + R.m) * t.Efw;
        if (gas || efw) L.push(cxLine(Et, etF, etN, s5(etV), 'rb/STB'));
        else L.push(cxP('With no gas cap and ' + Efw + ' = 0, ' + Et + ' = ' + Eo + ' = ' + s5(etV) + ' rb/STB.'));
        if (view === 'origin') {
          if (water) L.push(cxLine(y, F + cxOp('−') + We, cxPar(s5(t.F)) + cxOp('−') + cxPar(s5(t.We)), s5(t.Fnet / 1e6), 'MM rb'));
        } else {
          var sWhat = aq === 'pot' ? pi + ' − ' + p
            : aq === 'steady' ? '∫ (' + pi + ' − ' + p + ') d' + V('t') + ', added up in trapezoids between the steps' + (tUnit === 'row' ? ' (the rows taken as equal time steps)' : '')
            : 'Σ Δ' + V('p', 'j') + ' ' + V('W', 'D') + '(' + V('t', 'D') + ' − ' + V('t', 'D<var>j</var>') + '): the pressure steps since the start, each weighted by the dimensionless influx ' + V('W', 'D') + ' of a radial aquifer with ' + V('r', 'e') + '/' + V('r', 'o') + ' = ' + reText(c.reD) + ', at ' + V('t', 'D') + ' = ' + V('a') + ' ' + V('t') + ' with ' + V('a') + ' = ' + tdText(b, c.a);
          L.push(cxP('The aquifer function ' + V('S') + ' gives ' + We + ' = ' + aqSym + ' ' + V('S') + '. Here ' + V('S') + ' = ' + sWhat + '. At this pressure ' + V('S') + ' = ' + s5(S[t.id]) + (aq === 'steady' ? ' psi·' + tUnit : ' psi') + '.'));
          L.push(cxLine(x, cxFr(V('S'), Et), cxFr(s5(S[t.id]), s5(etV)), s5(S[t.id] / etV), ''));
          L.push(cxLine(y, cxFr(F, Et), cxFr(s5(t.F), s5(etV)), s5(t.F / etV), 'STB'));
          L = L.concat(weLines);
        }
      }
      if (!t.included) L.push(cxP('This point is ' + (t.usable ? 'left out of the fit' : 'not on the line: ' + esc(t.reason)) + '.'));
    }
    var intro2 = 'Pick a pressure to see its terms worked out.';
    h.push(cxSec(2, 'The terms at one pressure', cxP(intro2) + pick + L.join('')));

    // 3 all pressures, and 4 the least-squares line through the points in the fit
    var cols = [{ h: p, u: 'psia', f: function (q) { return fmtFixed(q.p, 0); } }, { h: F, u: 'MM rb', f: function (q) { return s5(q.F / 1e6); } }, { h: Eo, u: 'rb/STB', f: function (q) { return s5(q.Eo); } }];
    if (withEg) cols.push({ h: Eg, u: 'rb/STB', f: function (q) { return s5(q.Eg); } });
    if (efw) cols.push({ h: Efw, u: 'rb/STB', f: function (q) { return s5(q.Efw); } });
    if (water) cols.push({ h: We, u: 'MM rb', f: function (q) { return s5(q.We / 1e6); } });
    var xOf, yOf, xH, yH, yU, xU;
    if (view === 'line') {
      xOf = function (q) { return q.x; }; yOf = function (q) { return q.y / 1e6; };
      xH = x; xU = ''; yH = y; yU = 'MMSTB';
    } else if (view === 'origin') {
      xOf = function (q) { return q.x; }; yOf = function (q) { return q.Fnet / 1e6; };
      xH = Et; xU = 'rb/STB'; yH = water ? F + cxOp('−') + We : F; yU = 'MM rb';
    } else {
      var etOf = function (q) { return q.Eo + R.m * q.Eg + (1 + R.m) * q.Efw; };
      xOf = function (q) { return S[q.id] / etOf(q); }; yOf = function (q) { return q.F / etOf(q); };
      cols.push({ h: Et, u: 'rb/STB', f: function (q) { return s5(etOf(q)); } });
      xH = x + ' = ' + V('S') + '/' + Et; xU = 'psi·STB/rb'; yH = y + ' = ' + F + '/' + Et; yU = 'STB';
    }
    cols.push({ h: xH, u: xU, f: function (q) { return q.usable ? s5(xOf(q)) : '–'; } }, { h: yH, u: yU, f: function (q) { return q.usable ? s5(yOf(q)) : '–'; } });
    var head = function (cs) { return '<thead><tr>' + cs.map(function (cc) { return '<th>' + cc.h + (cc.u ? '<span class="cx-th-u">' + cc.u + '</span>' : '') + '</th>'; }).join('') + '</tr></thead>'; };
    var t3 = '<div class="cx-table-wrap"><table class="cx-table">' + head(cols.concat([{ h: 'In fit', u: '' }])) + '<tbody>' + pts.map(function (q) {
      return '<tr class="' + (q.id === cx.id ? 'is-on ' : '') + (q.included ? '' : 'is-out') + '" data-cx-id="' + esc(q.id) + '">' + cols.map(function (cc) { return '<td>' + cc.f(q) + '</td>'; }).join('') +
        '<td>' + (q.included ? 'yes' : q.usable ? 'no' : '–') + '</td></tr>';
    }).join('') + '</tbody></table></div>';
    h.push(cxSec(3, 'All pressures', cxP('The same terms at every pressure. Click a row to work it out in step 2.') + t3));

    var X = inc.map(xOf), Y = inc.map(yOf), n = X.length;
    var sum = function (a) { return a.reduce(function (s, v) { return s + v; }, 0); };
    var xm = sum(X) / n, ym = sum(Y) / n;
    var sec4 = [], sec5 = [];
    var Nv, slopeV;   // N in STB; the slope in the units of the line
    if (view === 'origin') {
      var sxy = sum(X.map(function (v, i) { return v * Y[i]; })), sxx = sum(X.map(function (v) { return v * v; }));
      slopeV = sxy / sxx;
      var etY = water ? Et + ' (' + yH + ')' : Et + ' ' + yH;
      sec4.push(cxP('With no intercept, the line ' + yH + ' = ' + N + ' ' + Et + ' goes through the origin. Least squares makes Σ (' + yH + cxOp('−') + N + ' ' + Et + ')² as small as possible, which gives ' + N + ' = Σ ' + etY + ' / Σ ' + Et + '². Over the ' + n + ' points in the fit:'));
      sec4.push('<div class="cx-table-wrap"><table class="cx-table">' + head([{ h: p, u: 'psia' }, { h: Et, u: 'rb/STB' }, { h: yH, u: 'MM rb' }, { h: Et + '²', u: '' }, { h: etY, u: '' }]) + '<tbody>' +
        inc.map(function (q, i) { return '<tr><td>' + fmtFixed(q.p, 0) + '</td><td>' + s5(X[i]) + '</td><td>' + s5(Y[i]) + '</td><td>' + s5(X[i] * X[i]) + '</td><td>' + s5(X[i] * Y[i]) + '</td></tr>'; }).join('') +
        '</tbody><tfoot><tr><td>Sum</td><td></td><td></td><td>' + s5(sxx) + '</td><td>' + s5(sxy) + '</td></tr></tfoot></table></div>');
      sec4.push(cxLine(N, cxFr('Σ ' + etY, 'Σ ' + Et + '²'), cxFr(s5(sxy), s5(sxx)), s5(slopeV), 'MMSTB'));
      Nv = slopeV * 1e6;
    } else {
      var dx = X.map(function (v) { return v - xm; }), dy = Y.map(function (v) { return v - ym; });
      var Sxx = sum(dx.map(function (v) { return v * v; })), Sxy = sum(dx.map(function (v, i) { return v * dy[i]; }));
      var fixedU = view === 'water' && fit.Ufixed;
      var bV = fixedU ? R.U : Sxy / Sxx, aV = ym - bV * xm;
      slopeV = bV;
      sec4.push(cxP('The straight line ' + y + ' = ' + V('a') + cxOp('+') + V('b') + ' ' + x + ' that fits the ' + n + ' points in the fit best makes Σ (' + y + cxOp('−') + V('a') + cxOp('−') + V('b') + ' ' + x + ')² as small as possible. ' +
        'With the means ' + V('x̄') + ' and ' + V('ȳ') + ', least squares gives ' + V('b') + ' = Σ (' + x + cxOp('−') + V('x̄') + ')(' + y + cxOp('−') + V('ȳ') + ') / Σ (' + x + cxOp('−') + V('x̄') + ')² and ' + V('a') + ' = ' + V('ȳ') + cxOp('−') + V('b') + ' ' + V('x̄') + '.'));
      sec4.push('<div class="cx-table-wrap"><table class="cx-table">' + head([{ h: p, u: 'psia' }, { h: x, u: xU }, { h: y, u: yU }, { h: x + cxOp('−') + V('x̄'), u: '' }, { h: y + cxOp('−') + V('ȳ'), u: '' }, { h: '(' + x + cxOp('−') + V('x̄') + ')²', u: '' }, { h: '(' + x + cxOp('−') + V('x̄') + ')(' + y + cxOp('−') + V('ȳ') + ')', u: '' }]) + '<tbody>' +
        inc.map(function (q, i) { return '<tr><td>' + fmtFixed(q.p, 0) + '</td><td>' + s5(X[i]) + '</td><td>' + s5(Y[i]) + '</td><td>' + s5(dx[i]) + '</td><td>' + s5(dy[i]) + '</td><td>' + s5(dx[i] * dx[i]) + '</td><td>' + s5(dx[i] * dy[i]) + '</td></tr>'; }).join('') +
        '</tbody><tfoot><tr><td>Sum</td><td>' + s5(sum(X)) + '</td><td>' + s5(sum(Y)) + '</td><td></td><td></td><td>' + s5(Sxx) + '</td><td>' + s5(Sxy) + '</td></tr></tfoot></table></div>');
      sec4.push(cxLine(V('x̄'), cxFr('Σ ' + x, V('n')), cxFr(s5(sum(X)), n), s5(xm), xU));
      sec4.push(cxLine(V('ȳ'), cxFr('Σ ' + y, V('n')), cxFr(s5(sum(Y)), n), s5(ym), yU));
      if (fixedU) sec4.push(cxP('The aquifer constant is given, so only the intercept is fitted: ' + V('b') + ' = ' + aqSym + ' = ' + s5(bV) + ' rb/psi.'));
      else sec4.push(cxLine(V('b'), cxFr('Σ (' + x + cxOp('−') + V('x̄') + ')(' + y + cxOp('−') + V('ȳ') + ')', 'Σ (' + x + cxOp('−') + V('x̄') + ')²'), cxFr(s5(Sxy), s5(Sxx)), s5(bV), view === 'line' ? 'MMSTB' : 'rb/psi'));
      sec4.push(cxLine(V('a'), V('ȳ') + cxOp('−') + V('b') + ' ' + V('x̄'), s5(ym) + cxOp('−') + cxPar(s5(bV)) + ' × ' + cxPar(s5(xm)), s5(aV), view === 'line' ? 'MMSTB' : 'STB'));
      Nv = view === 'line' ? aV * 1e6 : aV;
    }
    // how well the line fits
    var yHat = function (i) { return view === 'origin' ? slopeV * X[i] : (Nv / (view === 'line' ? 1e6 : 1)) + slopeV * X[i]; };
    var sse = sum(Y.map(function (v, i) { return Math.pow(v - yHat(i), 2); })), sst = sum(Y.map(function (v) { return Math.pow(v - ym, 2); }));
    sec4.push(cxLine(V('R') + '<sup>2</sup>', '1' + cxOp('−') + cxFr('Σ (' + y + cxOp('−') + V('ŷ') + ')²', 'Σ (' + y + cxOp('−') + V('ȳ') + ')²'), '1' + cxOp('−') + cxFr(s5(sse), s5(sst)), sst > 0 ? (1 - sse / sst).toFixed(3) : '1', ''));
    if (view === 'line' && efw && fit.rounds > 1) sec4.push(cxP('Both axes contain ' + m + ', so the line was fitted again with each new ' + m + ' until ' + m + ' stopped changing (' + fit.rounds + ' rounds). The numbers above are from the last round, with ' + m + ' = ' + fmtFixed(mAx, 4) + ' on the axes.'));
    var lineName = view === 'line' ? (water ? '(' + F + cxOp('−') + We + ')/' : F + '/') + (efw ? V('E') : Eo) + ' against ' + Eg + '/' + (efw ? V('E') : Eo)
      : view === 'origin' ? yH + ' against ' + Et : F + '/' + Et + ' against ' + V('S') + '/' + Et;
    h.push(cxSec(4, 'The straight line by least squares', cxP('The line is ' + lineName + '.') + sec4.join('')));

    // 5 the results
    // the final values are written as on the result cards
    var Nm = Nv / 1e6, Gv = (view === 'line' ? slopeV * 1e6 : R.m * Nv) * P0.Boi / P0.Bgi;
    var gText = function () { return sigText(Gv, 5) + '<span class="cx-u">SCF</span>' + cxOp('=') + '<b>' + fmtRes(Gv / 1e9) + '</b><span class="cx-u">Bscf</span>'; };
    if (view === 'line') {
      sec5.push(cxLine(N, 'intercept ' + V('a'), null, fmtRes(Nm), 'MMSTB'));
      sec5.push(cxLine(m, cxFr('slope ' + V('b'), 'intercept ' + V('a')), cxFr(s5(slopeV), s5(Nm)), fmtM(slopeV / Nm), ''));
      if (gas) sec5.push(cxLine(V('G'), cxFr(m + N + ' ' + Boi, Bgi), cxFr(cxPar(sigText(slopeV * 1e6, 5)) + ' × ' + givenText(P0.Boi), givenText(P0.Bgi)), gText(), ''));
    } else if (view === 'origin') {
      sec5.push(cxLine(N, 'slope', null, fmtRes(Nm), 'MMSTB'));
      if (gas) sec5.push(cxLine(V('G'), cxFr(m + N + ' ' + Boi, Bgi), cxFr(fmtM(R.m) + ' × ' + cxPar(sigText(Nv, 5)) + ' × ' + givenText(P0.Boi), givenText(P0.Bgi)), gText(), ''));
    } else {
      sec5.push(cxLine(N, 'intercept ' + V('a'), cxPar(sigText(Nv, 5)) + ' STB', fmtRes(Nm), 'MMSTB'));
      var cName = { pot: 'pot aquifer constant', steady: 'steady-state aquifer constant', veh: 'aquifer constant' }[aq] || 'aquifer constant';
      sec5.push(cxLine(aqSym, 'slope ' + V('b'), null, s5(slopeV), aq === 'steady' ? 'rb/(psi ' + tUnit + ')' : 'rb/psi'));
      sec5.push(cxP('The ' + cName + ' ' + aqSym + ' gives ' + We + ' = ' + aqSym + ' × ' + V('S') + ' at every step, so the points ' + F + '/' + Et + ' against ' + We + '/' + Et + ' lie on a line of slope 1 that meets the axis at ' + N + ' (the Havlena–Odeh plot).'));
    }
    if (water && view === 'line' && aq !== 'column') {
      sec5.push(cxP('The aquifer constant ' + aqSym + ' = ' + s5(c.fit.U) + (aq === 'steady' ? ' rb/(psi ' + tUnit + ')' : ' rb/psi') + ' was found together with ' + N + ' and ' + m + ', by least squares on ' + F + ' = ' + N + ' [' + Eo + cxOp('+') + m + ' ' + Eg + cxOp('+') + '(1' + cxOp('+') + m + ') ' + Efw + ']' + cxOp('+') + aqSym + ' ' + V('S') + '. With it, ' + We + ' at each step is ' + aqSym + ' × ' + V('S') + ', as in step 2.'));
    }
    var rec = E.recovery(terms, R.N);
    if (rec) sec5.push(cxLine('RF', cxFr(Np, N), cxFr(givenText(rec.Np) + ' STB', cxPar(sigText(Nv, 5)) + ' STB'), rfText(rec.RF), '%'));
    var lastT = inc[inc.length - 1];
    if (lastT && lastT.F > 0 && !negativeM(b)) {
      var di = [['DDI', cxFr(N + ' ' + Eo, F), cxFr(cxPar(sigText(Nv, 5)) + ' × ' + s5(lastT.Eo), s5(lastT.F)), Nv * lastT.Eo / lastT.F]];
      if (gas) di.push(['SDI', cxFr(N + ' ' + m + ' ' + Eg, F), cxFr(cxPar(sigText(Nv, 5)) + ' × ' + fmtFixed(R.m, 4) + ' × ' + s5(lastT.Eg), s5(lastT.F)), Nv * R.m * lastT.Eg / lastT.F]);
      if (water) di.push(['WDI', cxFr(We, F), cxFr(s5(lastT.We), s5(lastT.F)), lastT.We / lastT.F]);
      if (efw) di.push(['CDI', cxFr(N + (gas ? ' (1' + cxOp('+') + m + ') ' : ' ') + Efw, F), cxFr(cxPar(sigText(Nv, 5)) + ' × ' + (gas ? fmtFixed(1 + R.m, 4) + ' × ' : '') + s5(lastT.Efw), s5(lastT.F)), Nv * (1 + R.m) * lastT.Efw / lastT.F]);
      sec5.push(cxP('Drive indices at the last point in the fit, ' + fmtFixed(lastT.p, 0) + ' psia; they add up to ' + fmtFixed(di.reduce(function (s, d) { return s + d[3]; }, 0), 2) + ':'));
      di.forEach(function (d) { sec5.push(cxLine('<span class="word">' + d[0] + '</span>', d[1], d[2], fmtFixed(d[3], 3), '')); });
    }
    h.push(cxSec(5, 'Results', sec5.join('') + cxP('Numbers are rounded for display; the calculation keeps full precision, so working them out by hand can differ in the last digit.')));
    var keep = body.scrollTop;
    body.innerHTML = h.join('');
    body.scrollTop = keep;
  }

  function openCalcs() {
    var b = state.bundle, dlg = $('cx');
    if (!b || !hasFit(b)) return;
    renderCalcs(b);
    $('cx-body').scrollTop = 0;
    if (typeof dlg.showModal === 'function') dlg.showModal(); else dlg.setAttribute('open', '');
  }

  function closeCalcs() {
    var dlg = $('cx');
    if (typeof dlg.close === 'function') dlg.close(); else dlg.removeAttribute('open');
  }

  /** A pressure picked in step 2 or a row clicked in step 3. */
  function pickCalc(id) {
    cx.id = isNaN(Number(id)) ? id : Number(id);
    var at = $('cx-body').scrollTop;
    renderCalcs(state.bundle);
    $('cx-body').scrollTop = at;
  }

  function renderExplorer(b, opts) {
    var fitOk = hasFit(b);
    $('panel-explorer').hidden = !!(b.inputs && b.inputs.noGas);
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

  function rowOf(b, id) {
    var rows = b.inputs ? b.inputs.rows : [];
    for (var i = 0; i < rows.length; i++) if (rows[i].id === id) return rows[i];
    return null;
  }

  function renderTable(b) {
    var tbl = $('calc'), foot = $('table-foot');
    if (!b.result || !b.result.terms.length) {
      tbl.innerHTML = '<tbody><tr><td style="text-align:left;position:static">No data.</td></tr></tbody>';
      foot.innerHTML = '';
      return;
    }
    var nu = state.out.N, div = N_DIV[nu];
    var efw = anyEfw(b);
    var timeCol = b.inputs && b.inputs.hasTime ? [{ g: 'Data', h: '<var>t</var>', u: 'years', v: function (t) { var r = rowOf(b, t.id); return r && isFinite(r.t) ? fmtSig(r.t / 365.25, 4) : '–'; } }] : [];
    var cols = timeCol.concat([
      { g: 'Data', h: SYM.p, u: 'psia', v: function (t) { return fmtFixed(t.p, 0); } },
      { g: 'Data', h: SYM.Np, u: 'MMSTB', v: function (t) { return fmtSig(t.Np / 1e6, 4); } },
      { g: 'Data', h: SYM.Gp, u: 'MMSCF', v: function (t) { return fmtSig(t.Gp / 1e6, 5); } },
      { g: 'Data', h: SYM.Rp, u: 'SCF/STB', v: function (t) { return t.Np > 0 ? fmtFixed(t.Rp, 1) : '–'; } },
      { g: 'Data', h: SYM.Bo, u: 'rb/STB', v: function (t) { return fmtFixed(t.Bo, 4); } },
      { g: 'Data', h: SYM.Rs, u: 'SCF/STB', v: function (t) { return fmtFixed(t.Rs, 1); } },
      { g: 'Data', h: SYM.Bg, u: 'rb/SCF', v: function (t) { return fmtSig(t.Bg, 4); } },
      { g: 'Expansion terms', h: 'Δ<var>p</var>', u: 'psi', v: function (t) { return fmtFixed(t.dP, 0); } },
      { g: 'Expansion terms', h: '<var>F</var>', u: 'MM rb', v: function (t) { return fmtSig(t.F / 1e6, 5); } }
    ]).concat(influxOn(b) ? [
      { g: 'Expansion terms', h: '<var>W</var><sub>e</sub>', u: 'MM rb', v: function (t) { return isFinite(t.We) ? fmtSig(t.We / 1e6, 4) : '–'; } }
    ] : []).concat([
      { g: 'Expansion terms', h: '<var>E</var><sub>o</sub>', u: 'rb/STB', v: function (t) { return fmtSig(t.Eo, 4); } },
      { g: 'Expansion terms', h: '<var>E</var><sub>g</sub>', u: 'rb/STB', v: function (t) { return fmtSig(t.Eg, 4); } },
      { g: 'Expansion terms', h: '<var>E</var><sub>fw</sub>', u: 'rb/STB', v: function (t) { return efw ? fmtSig(t.Efw, 3) : '0'; } },
      { g: 'Straight line', h: '<var>x</var>', u: '', v: function (t) { return t.usable ? fmtSig(t.x, 4) : '–'; } },
      { g: 'Straight line', h: '<var>y</var>', u: nu, v: function (t) { return t.usable ? fmtSig(t.y / div, 5) : '–'; } },
      { g: 'Check at the fitted <var>N</var> and <var>m</var>', h: influxOn(b) ? '(<var>F</var> − <var>W</var><sub>e</sub>)/<var>E</var><sub>t</sub>' : '<var>F</var>/<var>E</var><sub>t</sub>', u: nu, v: function (t) { return t.usable && isFinite(t.impliedN) ? fmtSig(t.impliedN / div, 5) : '–'; } },
      { g: 'Check at the fitted <var>N</var> and <var>m</var>', h: 'DDI', u: '%', v: function (t) { return di(t, 'DDI'); } },
      { g: 'Check at the fitted <var>N</var> and <var>m</var>', h: 'SDI', u: '%', v: function (t) { return di(t, 'SDI'); } }
    ]);
    if (influxOn(b)) cols.push({ g: 'Check at the fitted <var>N</var> and <var>m</var>', h: 'WDI', u: '%', v: function (t) { return di(t, 'WDI'); } });
    if (efw) cols.push({ g: 'Check at the fitted <var>N</var> and <var>m</var>', h: 'CDI', u: '%', v: function (t) { return di(t, 'CDI'); } });
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
      s.textContent = familyName(b) + '. N = ' + fmtRes(R.N / N_DIV[state.out.N]) + ' ' + state.out.N + ', m = ' + fmtM(R.m) + ', G = ' + fmtRes(R.G / G_DIV[state.out.G]) + ' ' + G_LABEL[state.out.G] + '.';
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
      { name: 'Production', headerRows: 1, colWidths: [11, 13, 14, 14, 14, 14, 14, 13],
        rows: [['t (years)', 'p (psia)', 'Np (MMSTB)', 'Gp (MMSCF)', 'Bo (rb/STB)', 'Rs (SCF/STB)', 'Bg (rb/SCF)', 'Wp (MMSTB)']] },
      { name: 'Initial', headerRows: 1, colWidths: [32, 14, 12, 60],
        rows: [['Property', 'Value', 'Unit', 'Notes'],
          ['Initial pressure, pi', null, 'psia', ''],
          ['Initial oil FVF, Boi', null, 'rb/STB', 'Leave empty to take it from the table row at pi'],
          ['Initial gas FVF, Bgi', null, 'rb/SCF', 'Leave empty to take it from the table row at pi'],
          ['Initial solution GOR, Rsi', null, 'SCF/STB', 'Leave empty to take it from the table row at pi'],
          ['Connate water saturation, Swc', null, 'fraction', 'Swc, Cw and Cf can be left empty: then Efw = 0'],
          ['Water compressibility, Cw', null, '1/psi', ''],
          ['Formation compressibility, Cf', null, '1/psi', ''],
          ['Gas-cap ratio, m', null, '-', 'Only if known from geology: then m is not fitted'],
          ['', null, '', 'Production sheet: t and Wp are optional. Add a column We (MMrb) if the water influx is known.']] }
    ]).then(function (bytes) { download('havlena-odeh-template.xlsx', bytes, XLSX_MIME); });
  }

  function downloadExample() {
    X.writeXlsx([
      { name: 'Production', headerRows: 1, colWidths: [15, 13, 14, 14, 14, 14], rows: clone(EX_PROD) },
      { name: 'Initial', headerRows: 1, colWidths: [32, 14, 12, 42], rows: clone(EX_INIT) }
    ]).then(function (bytes) { download('havlena-odeh-example.xlsx', bytes, XLSX_MIME); });
  }

  function calcRows(b) {
    var head = ['t (years)', 'p (psia)', 'Np (STB)', 'Gp (SCF)', 'Rp (SCF/STB)', 'Bo (rb/STB)', 'Rs (SCF/STB)', 'Bg (rb/SCF)', 'dp (psi)',
      'F (rb)', 'We (rb)', 'Eo (rb/STB)', 'Eg (rb/STB)', 'Efw (rb/STB)', 'x', 'y (STB)', '(F-We)/Et (STB)', 'DDI', 'SDI', 'WDI', 'CDI', 'In fit', 'Note'];
    var rows = [head];
    var hideDI = negativeM(b);
    b.result.terms.forEach(function (t) {
      var s = t.sumDI;
      var norm = function (k) { return !hideDI && t.usable && isFinite(t[k]) && isFinite(s) && s !== 0 ? t[k] / s : null; };
      var r0 = rowOf(b, t.id);
      rows.push([r0 && isFinite(r0.t) ? r0.t / 365.25 : null, t.p, t.Np, t.Gp, t.Np > 0 ? t.Rp : null, t.Bo, t.Rs, t.Bg, t.dP, t.F, isFinite(t.We) ? t.We : null, t.Eo, t.Eg, t.Efw,
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
    var det = b.detection, c = b.model;
    var plain = function (t) { return String(t).replace(/_/g, ''); };
    var lineText = {
      origin: 'F - We = N Et through the origin, Et = Eo + m Eg + (1+m) Efw; N = slope',
      water: 'F/Et = N + We/Et (slope 1), We = U S from the aquifer model; N = intercept',
      line: '(F-We)/[Eo+(1+m)Efw] = N + mN Eg/[Eo+(1+m)Efw], fitted again with the new m until m stops changing; N = intercept, m = slope/intercept'
    }[b.view];
    var inc = b.result.terms.filter(function (t) { return t.included; });
    var last = inc[inc.length - 1];
    var rec = E.recovery(b.result.terms, R.N);
    var results = [
      ['Havlena–Odeh material balance analysis', ''],
      ['Data', state.source.name],
      ['Drive mechanism', familyName(b) + (det.forced ? ' (chosen by the user)' : ' (found from the data)')],
      ['', plain(familyLine(b))],
      ['Points in the fit', fit.n],
      ['', ''],
      ['Result', 'Value', 'Unit', '95 % low', '95 % high'],
      ['N, oil initially in place', R.N, 'STB', R.ciN ? R.ciN[0] : null, R.ciN ? R.ciN[1] : null],
      ['N, oil initially in place', R.N / 1e6, 'MMSTB', R.ciN ? R.ciN[0] / 1e6 : null, R.ciN ? R.ciN[1] / 1e6 : null],
      ['m, gas-cap to oil-zone volume ratio', R.m, '-', R.ciM ? R.ciM[0] : null, R.ciM ? R.ciM[1] : null],
      ['G, gas-cap gas initially in place', R.G, 'SCF', R.ciG ? R.ciG[0] : null, R.ciG ? R.ciG[1] : null],
      ['G, gas-cap gas initially in place', R.G / 1e9, 'Bscf', R.ciG ? R.ciG[0] / 1e9 : null, R.ciG ? R.ciG[1] / 1e9 : null],
      ['We, water influx at the last step', influxOn(b) && last ? last.We : null, 'rb', null, null],
      ['Np, oil produced at the last step', rec ? rec.Np : null, 'STB', null, null],
      ['RF, oil recovered so far (Np / N)', rec ? rec.RF * 100 : null, '%', null, null],
      ['Aquifer', influxOn(b) ? plain(aquiferText(b, c)) : 'none', '', null, null],
      ['Aquifer r_e/r_o', c && c.aquifer === 'veh' ? (c.reD === Infinity ? 'infinite' : c.reD) : null, '', null, null],
      ['R squared', fit.r2, '', null, null],
      ['', ''],
      ['Line', lineText],
      ['Efw included', state.includeEfw ? 'yes' : 'no'],
      ['Time', b.inputs.hasTime ? 'from the file' : (det.assumedSteps ? 'rows taken as equal time steps' : 'none')]
    ];
    var inputs = [['Parameter', 'Value', 'Unit', 'Source']];
    [['pi', 'psia'], ['Boi', 'rb/STB'], ['Bgi', 'rb/SCF'], ['Rsi', 'SCF/STB'], ['Swc', 'fraction'], ['Cw', '1/psi'], ['Cf', '1/psi']].forEach(function (p) {
      var i = info[p[0]] || {};
      var src = { file: 'file ' + (i.where || ''), derived: 'table ' + (i.from || ''), default: 'not in file, 0', user: 'typed in the dashboard', missing: 'missing' }[i.source] || '';
      inputs.push([p[0], isFinite(prm[p[0]]) ? prm[p[0]] : null, p[1], src]);
    });
    var notes = [['Level', 'Note']].concat(collectMessages(b).map(function (m) { return [m.level, m.text.replace(/_/g, '')]; }));
    X.writeXlsx([
      { name: 'Results', headerRows: 0, colWidths: [38, 60, 10, 16, 16], rows: results },
      { name: 'Calculations', headerRows: 1, colWidths: [10, 10, 14, 16, 12, 11, 12, 12, 9, 16, 14, 12, 12, 12, 10, 16, 16, 9, 9, 9, 9, 8, 24], rows: calcRows(b) },
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
   * One-page report: the results, the Havlena–Odeh plot and the inputs on one A4 page.
   * It goes through the browser's print dialog, where it can be saved as a PDF. Where printing
   * is blocked (the hosted preview), the same page comes as an HTML file to open and print.
   * ------------------------------------------------------------------ */
  var SERIF = '"STIX Two Text", Cambria, "Times New Roman", Times, serif';

  /* One serif face in four sizes (title 15 pt, headings 10.5 pt, text 9.5 pt; tables, captions and notes 8.5 pt), black on white.
     Every rule the report needs is set here, so it looks the same printed from the dashboard and as a file of its own. */
  var REPORT_CSS = [
    '#report { color: #000; background: #fff; font-family: var(--rp-serif); font-size: 9.5pt; font-weight: 400; line-height: 1.34; font-variant-numeric: lining-nums; hyphens: auto; -webkit-print-color-adjust: exact; print-color-adjust: exact; }',
    '#report * { box-sizing: border-box; }',
    '#report h1, #report h2, #report p, #report ol, #report table, #report figure { margin: 0; }',
    '#report b, #report strong { font-weight: 600; }',
    // math: italic symbols; upright sub- and superscripts in the same face, kept off the line spacing
    '#report var { font-family: inherit; font-size: 1em; font-style: italic; line-height: inherit; }',
    '#report sub, #report sup { position: relative; vertical-align: baseline; font-family: inherit; font-size: 0.72em; font-style: normal; line-height: 0; }',
    '#report sub { top: 0.3em; }',
    '#report sup { top: -0.45em; }',
    '#report var + sub { margin-left: 0.03em; }',
    // letterhead and title
    '#report .rp-letter { display: flex; align-items: center; gap: 3mm; padding-bottom: 2mm; font-size: 8.5pt; line-height: 1.3; }',
    '#report .rp-crest { flex: none; width: auto; height: 10mm; }',
    '#report .rp-date { margin-left: auto; align-self: flex-end; }',
    '#report .rp-head { padding: 2.6mm 0 2.4mm; border-top: 1pt solid #000; border-bottom: 0.5pt solid #000; text-align: center; }',
    '#report h1 { font-size: 15pt; font-weight: 600; line-height: 1.2; }',
    '#report .rp-sub { margin-top: 0.8mm; }',
    // text, headings, and the two columns of method and results
    '#report .rp-text { text-align: justify; }',
    '#report .rp-text + .rp-text { margin-top: 1.2mm; }',
    '#report .rp-summary { margin-top: 2.6mm; }',
    '#report h2 { margin: 3mm 0 1.2mm; font-size: 10.5pt; font-weight: 600; line-height: 1.25; }',
    '#report h2 .rp-no { display: inline-block; min-width: 6mm; }',
    '#report .rp-cols { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); column-gap: 7mm; align-items: start; }',
    // displayed equations: centred, numbered at the right
    '#report .rp-eqn { display: grid; grid-template-columns: 1fr auto 1fr; align-items: center; margin: 1.2mm 0; }',
    '#report .rp-eqn > span:first-child { grid-column: 2; }',
    '#report .rp-eqn > .rp-no { grid-column: 3; justify-self: end; }',
    '#report .rp-defs { display: grid; grid-template-columns: auto auto; justify-content: center; column-gap: 0.3em; row-gap: 0.5mm; margin: 1.2mm 0; }',
    '#report .rp-defs > span:nth-child(odd) { text-align: right; }',
    '#report .rp-frac { display: inline-flex; flex-direction: column; vertical-align: middle; margin: 0 0.12em; text-align: center; }',
    '#report .rp-frac > span { padding: 0 0.2em; line-height: 1.25; }',
    '#report .rp-frac > span + span { border-top: 0.5pt solid #000; }',
    // tables: caption above, three rules
    '#report table { width: 100%; border-collapse: collapse; border-bottom: 1pt solid #000; font-size: 8.5pt; line-height: 1.3; font-variant-numeric: lining-nums tabular-nums; }',
    '#report caption { caption-side: top; padding-bottom: 1mm; text-align: left; }',
    '#report thead tr:first-child th { border-top: 1pt solid #000; }',
    '#report thead th { border-bottom: 0.5pt solid #000; font-weight: 600; vertical-align: bottom; }',
    '#report thead th .rp-u { display: block; font-weight: 400; }',
    '#report thead th var, #report thead th sub { font-weight: 400; }',   // symbols stay as in the text
    '#report table.rp-narrow { width: auto; min-width: 55%; }',   // a table of few columns keeps to its content
    '#report th, #report td { padding: 0.45mm 1.4mm; text-align: right; vertical-align: baseline; white-space: nowrap; }',
    '#report th:first-child, #report td:first-child { padding-left: 0; text-align: left; }',
    '#report th:last-child, #report td:last-child { padding-right: 0; }',
    '#report .rp-l { text-align: left; }',
    '#report .rp-c { text-align: center; }',
    '#report tr.rp-gap td { font-style: italic; text-align: center; }',
    '#report .rp-note, #report figcaption { margin-top: 0.8mm; font-size: 8.5pt; text-align: justify; }',
    '#report .rp-tables { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 7mm; align-items: start; }',
    '#report .rp-tables .rp-note { width: 0; min-width: 100%; }',   // a note wraps to its table and does not widen it
    '#report figure { margin-top: 2.6mm; }',
    '#report .rp-chart svg { display: block; width: 100%; height: auto; }',
    // remarks and references
    '#report .rp-list { padding-left: 5mm; font-size: 8.5pt; }',
    '#report .rp-list li { text-align: justify; }',
    '#report .rp-list li + li { margin-top: 0.4mm; }',
    '#report .rp-refs p { padding-left: 5mm; text-indent: -5mm; font-size: 8.5pt; }',
    '#report .rp-refs p + p { margin-top: 0.4mm; }'
  ].join('\n');

  /** In the dashboard: the report is laid out off screen (so its chart can be drawn at size) and is all that prints. */
  var REPORT_PRINT_CSS = [
    '#report { position: absolute; left: -10000px; top: 0; width: 180mm; visibility: hidden; }',
    '@page { size: A4 portrait; margin: 13mm 15mm; }',
    '@media print {',
    '  html.print-report body { background: #fff !important; }',
    '  html.print-report body > :not(#report) { display: none !important; }',
    '  html.print-report #report { position: static; left: auto; width: auto; visibility: visible; }',
    '}'
  ].join('\n');

  /** As a file of its own: a sheet of paper on screen, the same page in print. */
  var REPORT_PAGE_CSS = [
    '@page { size: A4 portrait; margin: 13mm 15mm; }',
    'body { margin: 0; background: #e8ebed; }',
    '#report { width: 210mm; min-height: 297mm; margin: 0 auto 10mm; padding: 13mm 15mm; box-shadow: 0 1px 3px rgba(21, 25, 28, 0.18); }',
    '.rp-tools { width: 210mm; margin: 0 auto; padding: 6mm 0 4mm; font: 14px/1.4 system-ui, sans-serif; }',
    '.rp-tools button { font: inherit; padding: 8px 14px; border-radius: 6px; border: 1px solid #15191c; background: #15191c; color: #fff; cursor: pointer; }',
    '@media print { body { background: #fff; } #report { width: auto; min-height: 0; margin: 0; padding: 0; box-shadow: none; } .rp-tools { display: none; } }'
  ].join('\n');

  var REPORT_ROWS = 10;   // production rows shown in full; a longer table shows its first six and last three
  var REPORT_PAGE_PX = 271 * 96 / 25.4;   // the height of an A4 page less its margins, in CSS pixels
  var REPORT_CHART_ASPECT = 0.75;   // height of the plot over its width

  /** Math in the report: an italic symbol with an upright subscript, and a stacked fraction. */
  function rv(sym, sub) { return '<var>' + sym + '</var>' + (sub ? '<sub>' + sub + '</sub>' : ''); }
  function rfrac(num, den) { return '<span class="rp-frac"><span>' + num + '</span><span>' + den + '</span></span>'; }
  function reqn(body, no) { return '<p class="rp-eqn"><span>' + body + '</span><span class="rp-no">(' + no + ')</span></p>'; }
  function andList(a) { return a.length <= 2 ? a.join(' and ') : a.slice(0, -1).join(', ') + ' and ' + a[a.length - 1]; }

  /** Decimals that write x as given (up to six), and decimals for about four significant digits. */
  function decimalsOf(x) {
    if (!isFinite(x)) return 0;
    for (var d = 0; d < 6; d++) if (Math.abs(x - Number(x.toFixed(d))) <= 1e-9 * Math.max(1, Math.abs(x))) return d;
    return 6;
  }
  function dec4(x) { return !isFinite(x) || x === 0 ? 0 : Math.max(0, Math.min(6, 3 - Math.floor(Math.log10(Math.abs(x))))); }
  /** One number of decimals for a column: as many as its values are given to, at most six significant digits for the largest. */
  function colDecimals(xs) {
    var fin = xs.filter(function (x) { return isFinite(x); });
    if (!fin.length) return 0;
    var d = Math.max.apply(null, fin.map(decimalsOf)), big = Math.max.apply(null, fin.map(Math.abs));
    return big > 0 ? Math.min(d, Math.max(0, 5 - Math.floor(Math.log10(big)))) : d;
  }
  /** 3 × 10⁻⁶ style, for compressibilities. */
  function sciText(x) {
    if (!isFinite(x)) return '–';
    if (x === 0) return '0';
    var e = Math.floor(Math.log10(Math.abs(x))), mant = x / Math.pow(10, e);
    mant = Number(mant.toPrecision(6));
    return fmtFixed(mant, decimalsOf(mant)) + ' × 10<sup>' + C.minus(String(e)) + '</sup>';
  }

  function reportName(ext) {
    var base = String(state.source.fileName || 'data').replace(/\.[^.]+$/, '');
    return base + (/havlena-odeh/i.test(base) ? '_report' : '_Havlena-Odeh_report') + ext;
  }

  /** The report in the style of a short technical paper; the chart is drawn into .rp-chart afterwards. */
  function reportBody(b) {
    var det = b.detection, R = b.result.results, fit = b.result.fit, c = b.model;
    var fam = c ? c.family : 'depletion';
    var water = !!(c && c.water) && influxOn(b);
    var aq = water ? c.aquifer : null;
    var gas = R.m > 0;
    var efw = anyEfw(b);
    var terms = b.result.terms;
    var inc = terms.filter(function (t) { return t.included; });
    var last = inc[inc.length - 1];
    var weRow = water && last && isFinite(last.We);
    var rec = E.recovery(terms, R.N);
    var rows = b.inputs.rows;
    var nD = dec4(R.N / 1e6), gD = dec4(R.G / 1e9);
    var npD = colDecimals(rows.map(function (r) { return r.Np / 1e6; }));
    var mm = function (x) { return fmtFixed(x / 1e6, nD); };
    var range = function (pair, f) { return pair ? f(pair[0]) + '–' + f(pair[1]) : '–'; };
    var F = rv('F'), N = rv('N'), m = rv('m'), We = rv('W', 'e'), Eo = rv('E', 'o'), Eg = rv('E', 'g'), Efw = rv('E', 'fw'), Et = rv('E', 't'), Np = rv('N', 'p');
    var aqWords = { pot: 'a pot aquifer', steady: 'a steady-state aquifer (Schilthuis, 1936)', veh: 'an unsteady-state radial aquifer (van Everdingen and Hurst, 1949)', column: 'a water influx given in the data file' }[aq] || '';
    var mech = !c ? 'no drive mechanism that is both physically valid and consistent with the data; the results are therefore those for depletion alone'
      : fam === 'depletion' ? (b.inputs.noGas || (det.saturation || {}).allAbove ? 'a depletion drive above the bubble point, with no gas cap and no water influx' : 'a solution-gas (depletion) drive with no gas cap and no water influx')
      : fam === 'gascap' ? (c.key === 'gascap-known' ? 'a gas-cap drive, with the gas-cap size given in the data file, and no water influx' : 'a gas-cap drive with no water influx')
      : fam === 'water' ? 'a water drive with ' + aqWords + (c.mFixed > 0 ? '' : ' and no gas cap')
      : 'a combination drive: a gas cap together with ' + aqWords;
    var mechShort = !c ? 'depletion alone' : { depletion: 'a depletion drive', gascap: 'a gas-cap drive', water: 'a water drive', combination: 'a combined gas-cap and water drive' }[fam];
    var h = [];

    // letterhead and title
    var crest = document.querySelector('.brand-crest'), course = document.querySelector('.brand .course'), org = document.querySelector('.foot-course p + p');
    var day = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
    var letter = !!(crest || course || org);
    if (letter) {
      h.push('<div class="rp-letter">' + (crest ? '<img class="rp-crest" src="' + esc(crest.src) + '" alt="">' : '') +
        '<div>' + (course ? '<p>' + course.innerHTML + '</p>' : '') + (org ? '<p>' + esc(org.textContent) + '</p>' : '') + '</div>' +
        '<p class="rp-date">' + esc(day) + '</p></div>');
    }
    var dataName = state.source.name + (state.source.fileName && state.source.fileName !== state.source.name ? ' (' + state.source.fileName + ')' : '');
    h.push('<header class="rp-head"><h1>Material Balance Analysis by the Havlena–Odeh Method</h1>' +
      '<p class="rp-sub">Data: ' + esc(dataName) + '</p>' + (letter ? '' : '<p>' + esc(day) + '</p>') + '</header>');

    // summary
    var sum = ['The production and PVT data were analysed with the straight-line form of the material balance equation (Havlena and Odeh, 1963). The data indicate ' + mech + '.'];
    sum.push('The stock-tank oil initially in place is ' + N + ' = ' + mm(R.N) + ' MMSTB' + (R.ciN ? ' (95 % confidence interval ' + range(R.ciN, mm) + ' MMSTB)' : '') +
      (gas ? (R.mFixed ? '; with the given gas-cap ratio ' + m + ' = ' + fmtFixed(R.m, 3) : '; the ratio of gas-cap to oil-zone volume is ' + m + ' = ' + fmtFixed(R.m, 3)) +
        ', so the gas cap initially holds ' + rv('G') + ' = ' + fmtFixed(R.G / 1e9, gD) + ' Bscf' : '') + '.');
    if (weRow) sum.push('At ' + fmtFixed(last.p, 0) + ' psia the cumulative water influx is ' + We + ' = ' + fmtFixed(last.We / 1e6, dec4(last.We / 1e6)) + ' MM rb, ' + pctText(last.We / last.F) + ' of the underground withdrawal.');
    if (rec) sum.push('By ' + fmtFixed(rec.p, 0) + ' psia, ' + fmtFixed(rec.Np / 1e6, npD) + ' MMSTB had been produced, a recovery factor of ' + rfText(rec.RF) + ' %.');
    var diT = inc.filter(function (t) { return isFinite(t.sumDI) && t.sumDI > 0; });
    var diLast = diT[diT.length - 1];
    if (diLast && !negativeM(b)) {
      var di = [['DDI', 'depletion'], ['SDI', 'gas cap'], ['WDI', 'water'], ['CDI', 'rock and connate water']]
        .map(function (k) { return { name: k[1], v: Math.max(0, diLast[k[0]] / diLast.sumDI) }; })
        .filter(function (it) { return it.v >= 0.005; });
      sum.push('The drive indices at ' + fmtFixed(diLast.p, 0) + ' psia are ' + andList(di.map(function (it) { return fmtFixed(it.v, 2) + ' (' + it.name + ')'; })) + '.');
    }
    h.push('<p class="rp-text rp-summary"><b>Summary.</b> ' + sum.join(' ') + '</p>');

    // 1 Method
    var withEt = b.view !== 'line';
    var defs = [
      [F, '= ' + Np + ' [' + rv('B', 'o') + ' + (' + rv('R', 'p') + ' − ' + rv('R', 's') + ') ' + rv('B', 'g') + '] + ' + rv('W', 'p') + ' ' + rv('B', 'w')],
      [Eo, '= (' + rv('B', 'o') + ' − ' + rv('B', 'oi') + ') + (' + rv('R', 'si') + ' − ' + rv('R', 's') + ') ' + rv('B', 'g')],
      [Eg, '= ' + rv('B', 'oi') + ' (' + rv('B', 'g') + '/' + rv('B', 'gi') + ' − 1)'],
      [Efw, '= ' + rv('B', 'oi') + ' (' + rv('c', 'w') + ' ' + rv('S', 'wc') + ' + ' + rv('c', 'f') + ')(' + rv('p', 'i') + ' − ' + rv('p') + ')/(1 − ' + rv('S', 'wc') + ')']
    ];
    if (withEt) defs.push([Et, '= ' + Eo + ' + ' + m + ' ' + Eg + ' + (1 + ' + m + ') ' + Efw]);
    var why = [];
    if (b.view === 'origin' && !gas) why.push(m + ' = 0');
    if (!water) why.push(We + ' = 0');
    if (!efw) why.push(Efw + ' = 0' + (state.includeEfw ? ' (' + rv('S', 'wc') + ', ' + rv('c', 'w') + ' and ' + rv('c', 'f') + ' not given)' : ' (rock and connate-water expansion neglected)'));
    var meth = ['<h2><span class="rp-no">1</span>Method</h2>',
      '<p class="rp-text">The material balance of an oil reservoir with a gas cap and water influx is</p>',
      reqn(F + ' = ' + N + ' [' + Eo + ' + ' + m + ' ' + Eg + ' + (1 + ' + m + ') ' + Efw + '] + ' + We, 1),
      '<p class="rp-text">where ' + F + ' is the underground withdrawal and ' + Eo + ', ' + Eg + ' and ' + Efw + ' are the expansions of the oil, the gas cap, and the connate water and rock' + (withEt ? '; ' + Et + ' is the total expansion' : '') + ':</p>',
      '<div class="rp-defs">' + defs.map(function (d) { return '<span>' + d[0] + '</span><span>' + d[1] + '</span>'; }).join('') + '</div>',
      '<p class="rp-text">The drive mechanism was identified by fitting every candidate model (depletion; gas cap; water drive with a pot, steady-state or unsteady-state aquifer; gas cap with water drive) and keeping, of the physically valid models, the one with the lowest corrected Akaike information criterion (AICc); a model with fewer constants is preferred when it is within 2 of the lowest.</p>'];
    var lead = '<p class="rp-text">For ' + mechShort + (why.length ? ', with ' + andList(why) : '') + ', ';
    var fitWhat;
    if (b.view === 'water') {
      meth.push(lead + 'dividing Eq. (1) by ' + Et + ' gives</p>');
      meth.push(reqn(rfrac(F, Et) + ' = ' + N + ' + ' + rfrac(We, Et), 2));
      fitWhat = 'With the correct aquifer model the points lie on a straight line of unit slope whose intercept is ' + N + '.';
    } else if (b.view === 'origin') {
      meth.push(lead + 'Eq. (1) becomes a straight line through the origin,</p>');
      meth.push(reqn((water ? F + ' − ' + We : F) + ' = ' + N + ' ' + Et, 2));
      fitWhat = 'Its slope is ' + N + (gas ? ', with ' + m + ' given in the data file.' : '.');
    } else {
      var den = efw ? Eo + ' + (1 + ' + m + ') ' + Efw : Eo;
      meth.push(lead + 'Eq. (1) becomes the straight line</p>');
      meth.push(reqn(rfrac(water ? F + ' − ' + We : F, den) + ' = ' + N + ' + ' + m + N + ' ' + rfrac(Eg, den), 2));
      fitWhat = 'Its intercept is ' + N + ' and its slope ' + m + N + ', so ' + m + ' = slope/intercept and ' + rv('G') + ' = ' + m + N + ' ' + rv('B', 'oi') + '/' + rv('B', 'gi') + '.' +
        (efw ? ' Because ' + m + ' appears on both axes, the fit is repeated with each new ' + m + ' until ' + m + ' no longer changes.' : '');
    }
    var out = terms.filter(function (t) { return t.usable && !t.included; }).length;
    var aqFit = water && aq !== 'column';
    var fitText = 'The line was fitted by least squares' + (aqFit ? ', together with the aquifer constant' + (aq === 'veh' ? 's' : '') + ',' : '') +
      ' to the ' + fit.n + ' points below the initial pressure' + (out ? ' (' + plural(out, 'point') + ' left out)' : '') + '.';
    if (aqFit) {
      var aqEq = aq === 'pot' ? We + ' = ' + rv('K') + ' (' + rv('p', 'i') + ' − ' + rv('p') + ')'
        : aq === 'steady' ? We + ' = ' + rv('C') + ' ∫<sub>0</sub><sup><var>t</var></sup> (' + rv('p', 'i') + ' − ' + rv('p') + ') d' + rv('t')
        : We + ' = ' + rv('U') + ' Σ<sub><var>j</var></sub> Δ' + rv('p', 'j') + ' ' + rv('W', 'D') + '(' + rv('t', 'D') + ' − ' + rv('t', 'D<var>j</var>') + '),&emsp;' + rv('t', 'D') + ' = ' + rv('a') + ' ' + rv('t');
      meth.push('<p class="rp-text">' + fitWhat + ' The water influx was modelled with ' + aqWords + ',</p>');
      meth.push(reqn(aqEq, 3));
      meth.push('<p class="rp-text">' + (aq === 'veh' ? 'where ' + rv('W', 'D') + ' is the dimensionless influx of a radial aquifer at constant terminal pressure and Δ' + rv('p', 'j') + ' are the averaged pressure steps (Dake, 1978). ' : '') + fitText + '</p>');
    } else {
      meth.push('<p class="rp-text">' + fitWhat + (aq === 'column' ? ' The water influx ' + We + ' is taken from the data file.' : '') + ' ' + fitText + '</p>');
    }

    // 2 Results
    var t1 = [['Oil initially in place', N, mm(R.N), 'MMSTB', range(R.ciN, mm)]];
    if (gas) {
      t1.push(['Gas-cap ratio', m, fmtFixed(R.m, 3), '–', R.mFixed ? 'given' : range(R.ciM, function (x) { return fmtFixed(x, 3); })]);
      t1.push(['Gas-cap gas in place', rv('G'), fmtFixed(R.G / 1e9, gD), 'Bscf', R.mFixed ? '–' : range(R.ciG, function (x) { return fmtFixed(x / 1e9, gD); })]);
    }
    if (weRow) {
      t1.push(['Water influx', We, fmtFixed(last.We / 1e6, dec4(last.We / 1e6)), 'MM rb', '–']);
      if (aq === 'pot' || aq === 'veh') {
        var uD = dec4(c.fit.U);
        t1.push(['Aquifer constant', rv(aq === 'pot' ? 'K' : 'U'), fmtFixed(c.fit.U, uD), 'rb/psi', b.view === 'water' && R.ciU ? range(R.ciU, function (x) { return fmtFixed(x, uD); }) : '–']);
      }
      if (aq === 'steady') {
        var perRow = det.timeMode === 'steps', Cv = c.fit.U * (perRow ? 1 : 365.25);
        t1.push(['Aquifer constant', rv('C'), fmtFixed(Cv, dec4(Cv)), perRow ? 'rb/psi per row' : 'rb/(psi year)', '–']);
      }
      if (aq === 'veh') {
        t1.push(['Aquifer radius ratio', rv('r', 'e') + '/' + rv('r', 'o'), reText(c.reD), '–', '–']);
        var aV = det.timeMode === 'steps' ? c.a : c.a * 365.25;
        t1.push(['Dimensionless time constant', rv('a'), fmtFixed(aV, dec4(aV)), det.timeMode === 'steps' ? 'per row' : 'per year', '–']);
      }
    }
    if (rec) {
      t1.push(['Cumulative oil produced', Np, fmtFixed(rec.Np / 1e6, npD), 'MMSTB', '–']);
      t1.push(['Recovery factor', 'RF', rfText(rec.RF), '%', '–']);
    }
    t1.push(['Coefficient of determination', rv('R') + '<sup>2</sup>', fit.r2.toFixed(3), '–', '–']);
    var at = [];
    if (weRow && rec && last.p === rec.p) at.push(We + ', ' + Np + ' and RF are at ' + fmtFixed(rec.p, 0) + ' psia');
    else {
      if (weRow) at.push(We + ' is at ' + fmtFixed(last.p, 0) + ' psia');
      if (rec) at.push(Np + ' and RF are at ' + fmtFixed(rec.p, 0) + ' psia');
    }
    var hasOut = out > 0;
    var axisY = b.view === 'water' ? F + '/' + Et : b.view === 'origin' ? (water ? F + ' − ' + We : F) : (water ? '(' + F + ' − ' + We + ')' : F) + '/' + (efw ? '[' + Eo + ' + (1 + ' + m + ') ' + Efw + ']' : Eo);
    var axisX = b.view === 'water' ? We + '/' + Et : b.view === 'origin' ? Et : Eg + '/' + (efw ? '[' + Eo + ' + (1 + ' + m + ') ' + Efw + ']' : Eo);
    var lineTold = b.view === 'origin' ? 'The line through the origin has slope ' + N
      : b.view === 'water' ? 'The line has unit slope and intercept ' + N
      : 'The intercept of the line is ' + N + ' and its slope ' + m + N;
    var res = '<h2><span class="rp-no">2</span>Results</h2>' +
      '<table><caption><b>Table 1.</b> Results of the analysis' + (at.length ? '; ' + at.join('; ') : '') + '. CI: 95 % confidence interval of the least-squares fit.</caption>' +
      '<thead><tr><th>Quantity</th><th class="rp-c">Symbol</th><th>Value</th><th class="rp-l">Unit</th><th>95 % CI</th></tr></thead><tbody>' +
      t1.map(function (r) { return '<tr><td>' + r[0] + '</td><td class="rp-c">' + r[1] + '</td><td>' + r[2] + '</td><td class="rp-l">' + r[3] + '</td><td>' + r[4] + '</td></tr>'; }).join('') +
      '</tbody></table>' +
      '<figure><div class="rp-chart"></div><figcaption><b>Figure 1.</b> Havlena–Odeh plot of ' + axisY + ' against ' + axisX + '. ' + lineTold +
      '; filled points are used in the fit' + (hasOut ? ' and open points are left out' : '') + '.</figcaption></figure>';
    h.push('<div class="rp-cols"><section>' + meth.join('') + '</section><section>' + res + '</section></div>');

    // 3 Data
    var PNAME = { pi: 'Initial pressure', Boi: 'Initial oil FVF', Bgi: 'Initial gas FVF', Rsi: 'Initial solution GOR', Swc: 'Connate water saturation', Cw: 'Water compressibility', Cf: 'Formation compressibility' };
    var PSYM = { pi: rv('p', 'i'), Boi: rv('B', 'oi'), Bgi: rv('B', 'gi'), Rsi: rv('R', 'si'), Swc: rv('S', 'wc'), Cw: rv('c', 'w'), Cf: rv('c', 'f') };
    var PUNIT = { pi: 'psia', Boi: 'rb/STB', Bgi: 'rb/SCF', Rsi: 'SCF/STB', Swc: '–', Cw: 'psi<sup>−1</sup>', Cf: 'psi<sup>−1</sup>' };
    var info = b.inputs.paramInfo, prm = b.inputs.params, src = { file: [], derived: [], 'default': [], user: [], 'not-needed': [] };
    var t2 = ['pi', 'Boi', 'Bgi', 'Rsi', 'Swc', 'Cw', 'Cf'].map(function (k) {
      var inf = info[k] || {}, x = prm[k];
      if (src[inf.source]) src[inf.source].push(PSYM[k]);
      var val = inf.source === 'not-needed' ? '–' : (k === 'Cw' || k === 'Cf') ? sciText(x) : fmtFixed(x, decimalsOf(x));
      return '<tr><td>' + PNAME[k] + '</td><td class="rp-c">' + PSYM[k] + '</td><td>' + val + '</td><td class="rp-l">' + PUNIT[k] + '</td></tr>';
    });
    var srcNote = [];
    if (src.file.length) srcNote.push(andList(src.file) + ' from the data file');
    if (src.derived.length) srcNote.push(andList(src.derived) + ' from the table row at the initial pressure');
    if (src.user.length) srcNote.push(andList(src.user) + ' entered by the user');
    if (src['default'].length) srcNote.push(andList(src['default']) + ' not given and taken as 0');
    if (src['not-needed'].length) srcNote.push(andList(src['not-needed']) + ' not needed (no free gas)');
    var cols = [];
    if (b.inputs.hasTime) cols.push({ h: rv('t'), u: 'years', f: function (r) { return r.t / 365.25; } });
    cols.push({ h: rv('p'), u: 'psia', f: function (r) { return r.p; } });
    cols.push({ h: Np, u: 'MMSTB', f: function (r) { return r.Np / 1e6; } });
    if (!b.inputs.noGas) cols.push({ h: rv('G', 'p'), u: 'Bscf', f: function (r) { return r.Gp / 1e9; } });
    cols.push({ h: rv('B', 'o'), u: 'rb/STB', f: function (r) { return r.Bo; } });
    if (!b.inputs.noGas) {
      cols.push({ h: rv('R', 's'), u: 'SCF/STB', f: function (r) { return r.Rs; } });
      cols.push({ h: rv('B', 'g'), u: 'rb/SCF', f: function (r) { return r.Bg; } });
    }
    if (rows.some(function (r) { return isFinite(r.Wp) && r.Wp !== 0; })) cols.push({ h: rv('W', 'p'), u: 'MMSTB', f: function (r) { return r.Wp / 1e6; } });
    if (b.inputs.hasWe && rows.some(function (r) { return isFinite(r.We) && r.We !== 0; })) cols.push({ h: We, u: 'MM rb', f: function (r) { return r.We / 1e6; } });
    cols.forEach(function (col) {
      var d = colDecimals(rows.map(col.f));
      col.fmt = function (r) { var x = col.f(r); return isFinite(x) ? fmtFixed(x, d) : '–'; };
    });
    var termBy = {};
    terms.forEach(function (t) { termBy[t.id] = t; });
    var line = function (r) {
      var t = termBy[r.id];
      return '<tr>' + cols.map(function (col) { return '<td>' + col.fmt(r) + '</td>'; }).join('') + '<td class="rp-c">' + (t && t.included ? 'yes' : t && t.usable ? 'no' : '–') + '</td></tr>';
    };
    var shown = rows.length <= REPORT_ROWS ? rows.map(line).join('')
      : rows.slice(0, 6).map(line).join('') + '<tr class="rp-gap"><td colspan="' + (cols.length + 1) + '">' + plural(rows.length - 9, 'more row') + '</td></tr>' + rows.slice(-3).map(line).join('');
    h.push('<h2><span class="rp-no">3</span>Data</h2><div class="rp-tables">' +
      '<div><table><caption><b>Table 2.</b> Initial reservoir parameters.</caption><thead><tr><th>Parameter</th><th class="rp-c">Symbol</th><th>Value</th><th class="rp-l">Unit</th></tr></thead><tbody>' + t2.join('') + '</tbody></table>' +
      '<p class="rp-note">FVF: formation volume factor; GOR: gas–oil ratio. ' + (srcNote.length ? srcNote.join('; ').replace(/^./, function (ch) { return ch.toUpperCase(); }) + '.' : '') + '</p></div>' +
      '<div><table' + (cols.length < 5 ? ' class="rp-narrow"' : '') + '><caption><b>Table 3.</b> Production and PVT data.</caption><thead><tr>' + cols.map(function (col) { return '<th>' + col.h + '<span class="rp-u">' + col.u + '</span></th>'; }).join('') +
      '<th class="rp-c">In fit</th></tr></thead><tbody>' + shown + '</tbody></table>' +
      '<p class="rp-note">The first row is the initial state, not a point of the line' + (hasOut ? '; “no” marks points left out of the fit' : '') + '.</p></div></div>');

    // 4 Remarks: the notes the text above does not already give
    var skip = { 'efw-default': 1, 'efw-off': 1, steps: 1, 'no-model': 1 };
    var notes = collectMessages(b).filter(function (msg) { return msg.level !== 'ok' && !skip[msg.code]; }).slice(0, 3);
    if (notes.length) h.push('<h2><span class="rp-no">4</span>Remarks</h2><ol class="rp-list">' + notes.map(function (msg) { return '<li>' + rich(msg.text) + '</li>'; }).join('') + '</ol>');

    // references
    var refs = [];
    if (aq === 'veh') refs.push('Dake, L.P. 1978. <i>Fundamentals of Reservoir Engineering</i>. Amsterdam: Elsevier.');
    refs.push('Havlena, D. and Odeh, A.S. 1963. The Material Balance as an Equation of a Straight Line. <i>J Pet Technol</i> 15 (8): 896–900. https://doi.org/10.2118/559-PA.');
    if (aq === 'steady') refs.push('Schilthuis, R.J. 1936. Active Oil and Reservoir Energy. <i>Trans. AIME</i> 118 (1): 33–52. https://doi.org/10.2118/936033-G.');
    if (aq === 'veh') refs.push('van Everdingen, A.F. and Hurst, W. 1949. The Application of the Laplace Transformation to Flow Problems in Reservoirs. <i>J Pet Technol</i> 1 (12): 305–324. https://doi.org/10.2118/949305-G.');
    h.push('<h2>References</h2><div class="rp-refs">' + refs.map(function (r) { return '<p>' + r + '</p>'; }).join('') + '</div>');
    return h.join('');
  }

  /** Builds the report into the page, with its chart drawn in the light colours, ready to print. */
  function prepareReport(b) {
    clearReport();
    var style = document.createElement('style');
    style.id = 'report-style';
    style.textContent = REPORT_PRINT_CSS + '\n' + REPORT_CSS;
    document.head.appendChild(style);
    var el = document.createElement('div');
    el.id = 'report';
    el.setAttribute('aria-hidden', 'true');
    el.setAttribute('style', reportFonts());
    el.innerHTML = reportBody(b);
    document.body.appendChild(el);
    var chart = el.querySelector('.rp-chart');
    // the plot in print colours and the report's serif face, whatever the theme on screen
    var root = document.documentElement, theme = root.getAttribute('data-theme');
    var TOKENS = { '--paper': '#ffffff', '--surface': '#ffffff', '--grid-minor': '#f0f0f0', '--grid-major': '#d4d4d4', '--ink': '#000000', '--ink-2': '#1a1a1a',
      '--muted': '#4d4d4d', '--line': '#d9d9d9', '--line-strong': '#8c8c8c', '--font-body': SERIF, '--font-math': SERIF };
    root.setAttribute('data-theme', 'light');
    Object.keys(TOKENS).forEach(function (k) { root.style.setProperty(k, TOKENS[k]); });
    try {
      var opts = hoSpec(b, { animate: false, paperTitles: true }).opts;
      var z = fitToPage(el, function () {
        C.hoPlot(chart, Object.assign({}, opts, { height: Math.round(chart.clientWidth * REPORT_CHART_ASPECT) }));
      });
      if (z < 1) {
        el.dataset.zoom = z.toFixed(4);
        el.style.zoom = el.dataset.zoom;
      }
    } finally {
      Object.keys(TOKENS).forEach(function (k) { root.style.removeProperty(k); });
      if (theme === null) root.removeAttribute('data-theme'); else root.setAttribute('data-theme', theme);
    }
    root.classList.add('print-report');
    return el;
  }

  /**
   * One page: a report that runs long is laid out wider and shrunk back to the page width, by the
   * largest zoom that fits (found by halving). The plot is drawn again at each width, so its lettering
   * shrinks with the text. Returns the zoom, 1 when the report fits as it is.
   */
  function fitToPage(el, draw) {
    var room = REPORT_PAGE_PX - 24;   // a little to spare for the printer's fonts
    var fits = function (z) {
      el.style.width = (180 / z).toFixed(2) + 'mm';
      draw();
      return el.scrollHeight * z <= room && el.scrollWidth <= el.clientWidth + 1;   // and nothing sticks out at the side
    };
    if (fits(1)) return 1;
    var lo = 0.6, hi = 1;
    for (var i = 0; i < 7; i++) {
      var mid = (lo + hi) / 2;
      if (fits(mid)) lo = mid; else hi = mid;
    }
    fits(lo);
    return lo;
  }

  function reportFonts() { return '--rp-serif: ' + SERIF; }

  function clearReport() {
    var el = $('report'), style = $('report-style');
    if (el) el.remove();
    if (style) style.remove();
    document.documentElement.classList.remove('print-report');
  }

  /** The report as an HTML file of its own, to open and print. */
  function standaloneReport(el) {
    var fonts = document.querySelector('link[href*="fonts.googleapis.com/css"]');
    var z = el.dataset.zoom;
    return '<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
      '<title>' + esc(reportName('')) + '</title>' + (fonts ? fonts.outerHTML : '') +
      '<style>\n' + REPORT_CSS + '\n' + REPORT_PAGE_CSS + '\n' +
      (z ? '@media print { #report { zoom: ' + z + '; width: ' + (180 / +z).toFixed(2) + 'mm; } }\n' : '') + '</style></head><body>' +
      '<p class="rp-tools"><button type="button" onclick="window.print()">Print or save as PDF</button></p>' +
      '<div id="report" style="' + esc(reportFonts()) + '">' + el.innerHTML + '</div></body></html>';
  }

  function printReport() {
    var b = state.bundle;
    if (!hasFit(b) || !b.detection) {
      state.fileError = { title: 'Nothing to report yet', message: 'There is no fitted line yet. Load data that gives N and m first.' };
      renderAlert(b);
      return;
    }
    var el = prepareReport(b);
    var title = document.title, started = false, done = false;
    var onBefore = function () { started = true; };
    var finish = function () {
      if (done) return;
      done = true;
      window.removeEventListener('afterprint', finish);
      clearReport();
      document.title = title;
    };
    window.addEventListener('beforeprint', onBefore);
    window.addEventListener('afterprint', finish);
    document.title = reportName('');   // the name the print dialog suggests for the PDF
    try { window.print(); } catch (e) { /* printing blocked */ }
    setTimeout(function () {
      window.removeEventListener('beforeprint', onBefore);
      if (started) return;
      // printing is blocked here (the hosted preview): hand over the same page as a file to open and print
      var html = standaloneReport(el);
      finish();
      download(reportName('.html'), html, 'text/html');
    }, 400);
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
    $('report-btn').addEventListener('click', printReport);
    $('calc-btn').addEventListener('click', openCalcs);
    $('cx-close').addEventListener('click', closeCalcs);
    $('cx').addEventListener('click', function (e) { if (e.target === this) closeCalcs(); });   // a click on the backdrop
    $('cx-body').addEventListener('click', function (e) {
      var el = e.target.closest('[data-cx-id]');
      if (el) pickCalc(el.getAttribute('data-cx-id'));
    });
    $('cx-body').addEventListener('change', function (e) { if (e.target.id === 'cx-select') pickCalc(e.target.value); });
    // the report's serif, fetched ahead so that it is ready when the print dialog opens
    if (document.fonts && document.fonts.load) {
      ['400', '600', 'italic 400'].forEach(function (w) { document.fonts.load(w + ' 10pt "STIX Two Text"', 'Ag−Δ').catch(function () {}); });
    }
    $('csv-btn').addEventListener('click', exportCSV);
    $('png-ho').addEventListener('click', function () { exportPNG('chart-ho', 'havlena-odeh-plot.png'); });
    $('png-check').addEventListener('click', function () { exportPNG('chart-check', 'F-vs-Et-check.png'); });
    $('png-sketch').addEventListener('click', function () { exportPNG('sketch', 'reservoir-sketch.png'); });
    $('sk-play').addEventListener('click', playSketch);
    $('sk-range').addEventListener('input', function () {
      stopSketch();
      sketch.at = Number(this.value) || 0;
      drawSketch(state.bundle);
    });
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
    bundle: function () { return state.bundle; },
    // for the tests: the report laid out for print, its file version, and clearing it
    report: {
      prepare: function () { return !!prepareReport(state.bundle); },
      html: function () { var el = prepareReport(state.bundle), html = standaloneReport(el); clearReport(); return html; },
      clear: clearReport
    }
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
