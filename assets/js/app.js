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
    if (!state.includeEfw) out.push({ level: 'info', text: 'E_fw is switched off, so connate water and rock expansion are neglected.' });
    if (b.detection && b.model && b.model.sc.rms > D.POOR) {
      out.push({ level: 'warning', text: 'Even the best model misses F by ' + pctText(b.model.sc.rms) + ' on average, so treat these results with care. Check the units and the PVT data, or leave out points that do not follow the trend.' });
    }
    if (b.detection && !b.model) out.push({ level: 'warning', text: 'No mechanism both makes physical sense and fits the data. The results are for depletion alone.' });
    if (b.detection && b.detection.assumedSteps) out.push({ level: 'info', text: 'There is no time column, so the rows are taken as equal time steps (for example, one per year) for the aquifer. If they are not, add a time column.' });
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
  var REPORT_CSS = [
    '#report { color: #15191c; background: #fff; font-family: var(--rp-body); font-size: 9.2pt; line-height: 1.38; -webkit-print-color-adjust: exact; print-color-adjust: exact; }',
    '#report * { box-sizing: border-box; }',
    '#report h1, #report h2, #report p, #report ul, #report table { margin: 0; }',
    '#report var { font-family: var(--rp-math); font-style: italic; }',
    '#report sub { font-size: 0.72em; line-height: 0; }',
    '#report .rp-head { display: flex; align-items: center; gap: 4mm; padding-bottom: 2.6mm; border-bottom: 1.4pt solid #15191c; }',
    '#report .rp-crest { height: 13mm; width: auto; flex: none; }',
    '#report .rp-title { min-width: 0; }',
    '#report .rp-course { font-size: 8.6pt; color: #4a5258; }',
    '#report .rp-course strong { color: #15191c; }',
    '#report h1 { font-family: var(--rp-display); font-size: 15.5pt; font-weight: 700; line-height: 1.12; }',
    '#report .rp-org { font-size: 7.8pt; color: #6b7379; margin-top: 0.4mm; }',
    '#report .rp-meta { margin-left: auto; flex: none; text-align: right; font-size: 8.2pt; color: #4a5258; line-height: 1.45; white-space: nowrap; }',
    '#report .rp-meta strong { color: #15191c; font-weight: 600; }',
    '#report .rp-mech { margin-top: 2.6mm; font-size: 10.2pt; }',
    '#report .rp-mech b { font-weight: 700; }',
    '#report .rp-mech span { color: #4a5258; }',
    '#report .rp-results { display: grid; grid-template-columns: repeat(var(--rp-n, 4), minmax(0, 1fr)); margin-top: 2.6mm; border-top: 0.6pt solid #c9cfd3; border-bottom: 0.6pt solid #c9cfd3; }',
    '#report .rp-res { padding: 2mm 2.6mm 2.2mm; min-width: 0; }',
    '#report .rp-res:first-child { padding-left: 0; }',
    '#report .rp-res + .rp-res { border-left: 0.6pt solid #dfe3e6; }',
    '#report .rp-k { font-size: 7.6pt; color: #4a5258; }',
    '#report .rp-sym { font-family: var(--rp-math); font-style: italic; font-size: 1.3em; color: #15191c; margin-right: 1mm; }',
    '#report .rp-sym.rp-abbr { font-style: normal; font-size: 1.1em; }',
    '#report .rp-v { font-family: var(--rp-display); font-size: 16pt; font-weight: 600; line-height: 1.15; margin-top: 0.5mm; }',
    '#report .rp-v small { font-family: var(--rp-body); font-size: 8pt; font-weight: 500; color: #4a5258; margin-left: 1.2mm; }',
    '#report .rp-h, #report .rp-r { font-size: 7.2pt; color: #4a5258; margin-top: 0.4mm; }',
    '#report .rp-r { color: #6b7379; }',
    '#report .rp-f { font-size: 7.2pt; color: #9a5b00; font-weight: 600; margin-top: 0.4mm; }',
    '#report h2 { font-family: var(--rp-display); font-size: 11pt; font-weight: 600; margin: 3.2mm 0 1.2mm; }',
    '#report .rp-line { display: flex; flex-wrap: wrap; align-items: baseline; gap: 1mm 6mm; font-size: 9.4pt; }',
    '#report .rp-line strong { font-weight: 600; }',
    '#report .rp-line .ho-eq-label { color: #6b7379; font-size: 0.9em; }',
    '#report .rp-line .rp-r2 { margin-left: auto; color: #4a5258; }',
    '#report .legend { display: flex; flex-wrap: wrap; gap: 1mm 5mm; margin: 1.6mm 0 0; padding: 0; list-style: none; font-size: 8pt; color: #4a5258; }',
    '#report .legend li { display: inline-flex; align-items: center; gap: 1.6mm; }',
    '#report .legend svg { width: 16px; height: 10px; flex: none; overflow: visible; }',
    '#report .rp-chart svg { display: block; width: 100%; height: auto; }',
    '#report .rp-di { font-size: 8.6pt; color: #4a5258; margin-top: 0.8mm; }',
    '#report .rp-two { display: grid; grid-template-columns: minmax(0, 0.92fr) minmax(0, 1.28fr); gap: 7mm; }',
    '#report table { border-collapse: collapse; width: 100%; font-size: 8pt; font-variant-numeric: tabular-nums; }',
    '#report th, #report td { padding: 0.45mm 1.3mm; text-align: right; border-bottom: 0.4pt solid #e1e5e8; vertical-align: baseline; white-space: nowrap; }',
    '#report th:first-child, #report td:first-child { padding-left: 0; text-align: left; }',
    '#report thead th { font-weight: 600; color: #15191c; border-bottom: 0.8pt solid #15191c; vertical-align: bottom; }',
    '#report thead th small { display: block; font-weight: 400; color: #6b7379; }',
    '#report td.rp-src { text-align: left; color: #6b7379; white-space: normal; }',
    '#report tr.rp-out td { color: #8a9297; }',
    '#report tr.rp-gap td { text-align: center; color: #6b7379; font-style: italic; }',
    '#report .rp-notes { padding-left: 4mm; font-size: 7.8pt; color: #333a3f; }',
    '#report .rp-notes li + li { margin-top: 0.5mm; }',
    '#report .rp-foot { margin-top: 3mm; padding-top: 1.6mm; border-top: 0.6pt solid #c9cfd3; font-size: 7.2pt; color: #6b7379; }'
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

  var REPORT_ROWS = 12;   // production rows shown in full; a longer table shows its first six and last three
  var REPORT_PAGE_PX = 271 * 96 / 25.4;   // the height of an A4 page less its margins, in CSS pixels

  /** A number from the data table: up to six significant digits, thousands separated. */
  function fmtData(v) {
    if (!isFinite(v)) return '–';
    if (v === 0) return '0';
    var a = Math.abs(v);
    if (a >= 1e7 || a < 1e-5) return C.minus(v.toExponential(3));
    var parts = String(Number(v.toPrecision(6))).split('.');
    parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return C.minus(parts.join('.'));
  }

  function reportName(ext) {
    var base = String(state.source.fileName || 'data').replace(/\.[^.]+$/, '');
    return base + (/havlena-odeh/i.test(base) ? '_report' : '_Havlena-Odeh_report') + ext;
  }

  /** The report's text: everything but the chart, which is drawn into .rp-chart afterwards. */
  function reportBody(b) {
    var det = b.detection, R = b.result.results;
    var h = [];
    // heading: the course and the university when the page shows them
    var crest = document.querySelector('.brand-crest');
    var course = document.querySelector('.brand .course');
    var org = document.querySelector('.foot-course p + p');
    var day = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
    h.push('<header class="rp-head">' +
      (crest ? '<img class="rp-crest" src="' + esc(crest.src) + '" alt="">' : '') +
      '<div class="rp-title">' + (course ? '<p class="rp-course">' + course.innerHTML + '</p>' : '') +
      '<h1>Havlena–Odeh material balance analysis</h1>' +
      (org ? '<p class="rp-org">' + esc(org.textContent) + '</p>' : '') + '</div>' +
      '<p class="rp-meta">Data: <strong>' + esc(state.source.name) + '</strong>' +
      (state.source.fileName && state.source.fileName !== state.source.name ? '<br>' + esc(state.source.fileName) : '') +
      '<br>' + esc(day) + '</p></header>');
    // the mechanism found
    h.push('<p class="rp-mech">' + (b.model ? '<b>Drive mechanism: ' + esc(familyName(b)) + '</b>, ' + (det.forced ? 'chosen by the user' : 'found from the data') + '. '
      : '<b>Drive mechanism: no clear match.</b> ') +
      '<span>' + rich(familyLine(b)) + (det.assumedSteps ? ' Rows taken as equal time steps.' : '') + '</span></p>');
    // the result cards, as the dashboard shows them
    var cards = Array.prototype.filter.call(document.querySelectorAll('#ledger .res'), function (c) { return !c.hidden; });
    h.push('<div class="rp-results" style="--rp-n: ' + cards.length + '">' + cards.map(function (c) {
      var sym = c.querySelector('.res-sym'), flag = c.querySelector('.res-flag');
      var how = c.querySelector('.res-how').innerHTML, ci = c.querySelector('.res-ci').textContent;
      return '<div class="rp-res"><p class="rp-k"><span class="rp-sym' + (sym.classList.contains('res-abbr') ? ' rp-abbr' : '') + '">' + sym.innerHTML + '</span>' +
        esc(c.querySelector('.res-name').textContent) + '</p>' +
        '<p class="rp-v">' + esc(c.querySelector('.val').textContent) + '<small>' + esc(c.querySelector('.u').textContent) + '</small></p>' +
        (how ? '<p class="rp-h">' + how + '</p>' : '') + (ci ? '<p class="rp-r">' + esc(ci) + '</p>' : '') +
        (flag ? '<p class="rp-f">' + esc(flag.textContent) + '</p>' : '') + '</div>';
    }).join('') + '</div>');
    // the plot and its line
    var spec = hoSpec(b);
    h.push('<h2>' + spec.title + '</h2>');
    h.push('<p class="rp-line"><span>Fitted line: ' + $('eq').innerHTML + '</span><span class="rp-r2">' + $('fitline').innerHTML + '</span></p>');
    h.push('<ul class="legend"></ul><div class="rp-chart"></div>');
    var inc = b.result.terms.filter(function (t) { return t.included && isFinite(t.sumDI) && t.sumDI > 0; });
    var last = inc[inc.length - 1];
    if (last && !negativeM(b)) {
      var di = [['DDI', 'depletion'], ['SDI', 'gas cap'], ['WDI', 'water influx'], ['CDI', 'rock and water expansion']]
        .map(function (k) { return { name: k[1], v: Math.max(0, last[k[0]] / last.sumDI) }; })
        .filter(function (it) { return it.v >= 0.005; });
      h.push('<p class="rp-di">Drive indices at ' + esc(fmtFixed(last.p, 0)) + ' psia: ' + esc(di.map(function (it) { return it.name + ' ' + pctText(it.v); }).join(', ')) + '.</p>');
    }
    // the inputs: initial parameters and the production table
    var info = b.inputs.paramInfo, prm = b.inputs.params;
    var prmRows = PARAM_UI.map(function (d) {
      var unitId = paramUnit(d, b), v = prm[d.k];
      var shown = d.kind === 'frac' ? v : U.fromBase(d.kind, unitId, v);
      var inf = info[d.k] || {};
      var src = { file: 'File, ' + (inf.where || ''), derived: 'Table, ' + (inf.from || ''), 'default': 'Not in the file, 0', user: 'Typed in', 'not-needed': 'Not needed: no free gas' }[inf.source] || '';
      if (inf.source === 'not-needed') shown = NaN;
      return '<tr><td>' + SYM[d.k] + '</td><td>' + esc(isFinite(shown) ? fmtInput(shown) : '–') + '</td><td class="rp-src">' + esc(U.label(d.kind, unitId)) + '</td><td class="rp-src">' + esc(src) + '</td></tr>';
    });
    var rows = b.inputs.rows, gas = !b.inputs.noGas;
    var has = function (k) { return rows.some(function (r) { return isFinite(r[k]) && r[k] !== 0; }); };
    var cols = [];
    if (b.inputs.hasTime) cols.push({ h: '<var>t</var>', u: 'years', f: function (r) { return r.t / 365.25; } });
    cols.push({ h: SYM.p, u: 'psia', f: function (r) { return r.p; } });
    cols.push({ h: SYM.Np, u: 'MMSTB', f: function (r) { return r.Np / 1e6; } });
    if (gas) cols.push({ h: SYM.Gp, u: 'MMSCF', f: function (r) { return r.Gp / 1e6; } });
    cols.push({ h: SYM.Bo, u: 'rb/STB', f: function (r) { return r.Bo; } });
    if (gas) cols.push({ h: SYM.Rs, u: 'SCF/STB', f: function (r) { return r.Rs; } });
    if (gas) cols.push({ h: SYM.Bg, u: 'rb/SCF', f: function (r) { return r.Bg; } });
    if (has('Wp')) cols.push({ h: SYM.Wp, u: 'MMSTB', f: function (r) { return r.Wp / 1e6; } });
    if (b.inputs.hasWe && has('We')) cols.push({ h: '<var>W</var><sub>e</sub>', u: 'MM rb', f: function (r) { return r.We / 1e6; } });
    var termBy = {};
    b.result.terms.forEach(function (t) { termBy[t.id] = t; });
    var line = function (r) {
      var t = termBy[r.id], inFit = !!(t && t.included);
      return '<tr' + (inFit || !(t && t.usable) ? '' : ' class="rp-out"') + '>' + cols.map(function (c) { return '<td>' + esc(fmtData(c.f(r))) + '</td>'; }).join('') +
        '<td>' + (inFit ? '✓' : (t && t.usable ? 'left out' : '')) + '</td></tr>';
    };
    var body;
    if (rows.length <= REPORT_ROWS) body = rows.map(line).join('');
    else body = rows.slice(0, 6).map(line).join('') + '<tr class="rp-gap"><td colspan="' + (cols.length + 1) + '">' + plural(rows.length - 9, 'more row') + '</td></tr>' + rows.slice(-3).map(line).join('');
    h.push('<div class="rp-two"><section><h2>Initial parameters</h2><table><tbody>' + prmRows.join('') + '</tbody></table></section>' +
      '<section><h2>Production data</h2><table><thead><tr>' + cols.map(function (c) { return '<th>' + c.h + '<small>' + esc(c.u) + '</small></th>'; }).join('') +
      '<th>Fit</th></tr></thead><tbody>' + body + '</tbody></table></section></div>');
    // notes
    var notes = collectMessages(b).slice(0, 4);
    if (notes.length) h.push('<h2>Notes</h2><ul class="rp-notes">' + notes.map(function (m) { return '<li>' + rich(m.text) + '</li>'; }).join('') + '</ul>');
    h.push('<p class="rp-foot"><var>F</var> = <var>N</var> [<var>E</var><sub>o</sub> + <var>m E</var><sub>g</sub> + (1 + <var>m</var>) <var>E</var><sub>fw</sub>] + <var>W</var><sub>e</sub> ' +
      'as a straight line (Havlena and Odeh, 1963), fitted by least squares. Havlena–Odeh analyzer.</p>');
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
    var root = document.documentElement, theme = root.getAttribute('data-theme');
    root.setAttribute('data-theme', 'light');
    try {
      C.hoPlot(el.querySelector('.rp-chart'), hoSpec(b, { legendEl: el.querySelector('.legend'), animate: false, height: 285 }).opts);
    } finally {
      if (theme === null) root.removeAttribute('data-theme'); else root.setAttribute('data-theme', theme);
    }
    // one page: a report that still runs long is shrunk to fit (wider first, so it keeps the page width)
    var high = el.scrollHeight, room = REPORT_PAGE_PX - 24;   // a little to spare for the printer's fonts
    if (high > room) {
      var z = Math.max(0.6, room / high);
      el.dataset.zoom = z.toFixed(4);
      el.style.zoom = el.dataset.zoom;
      el.style.width = (180 / z).toFixed(2) + 'mm';
    }
    root.classList.add('print-report');
    return el;
  }

  function reportFonts() {
    var cs = getComputedStyle(document.documentElement);
    return '--rp-body: ' + cs.getPropertyValue('--font-body').trim() + '; --rp-display: ' + cs.getPropertyValue('--font-display').trim() + '; --rp-math: ' + cs.getPropertyValue('--font-math').trim();
  }

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
