/*
 * mbe.js
 * Havlena–Odeh straight-line analysis of the oil material balance equation.
 *
 *   F   = Np [Bo + (Rp − Rs) Bg] + Wp Bw = Np Bo + (Gp − Np Rs) Bg + Wp Bw
 *   Eo  = (Bo − Boi) + (Rsi − Rs) Bg
 *   Eg  = Boi (Bg / Bgi − 1)
 *   Efw = Boi (Cw Swc + Cf) Δp / (1 − Swc)
 *   F   = N [Eo + m Eg + (1 + m) Efw] + We
 *
 * Unknown N and m (combination drive):  (F − We)/(Eo+Efw) = N + mN · (Eg+Efw)/(Eo+Efw)
 *   intercept = N,  slope = mN,  m = slope / intercept,  G = mN Boi / Bgi
 * We: none, a column of the file, or a pot aquifer We = K (pi − p) with K found by trial and error.
 *
 * All inputs in base units (psia, STB, SCF, SCF/STB, rb/STB, rb/SCF, 1/psi, fraction).
 * Works in the browser (global HOEngine) and in Node (module.exports).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.HOEngine = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ---------------- statistics ---------------- */

  var T_TABLE = [
    [1, 12.706], [2, 4.303], [3, 3.182], [4, 2.776], [5, 2.571], [6, 2.447], [7, 2.365], [8, 2.306], [9, 2.262],
    [10, 2.228], [11, 2.201], [12, 2.179], [13, 2.160], [14, 2.145], [15, 2.131], [16, 2.120], [17, 2.110],
    [18, 2.101], [19, 2.093], [20, 2.086], [21, 2.080], [22, 2.074], [23, 2.069], [24, 2.064], [25, 2.060],
    [26, 2.056], [27, 2.052], [28, 2.048], [29, 2.045], [30, 2.042], [40, 2.021], [60, 2.000], [120, 1.980]
  ];

  /** Two-sided 95 % Student t critical value. */
  function tCrit95(dof) {
    if (!(dof >= 1)) return NaN;
    if (dof <= 30 && Math.floor(dof) === dof) return T_TABLE[dof - 1][1];
    if (dof >= 120) {
      var inv = 1 / dof, invA = 1 / 120;
      return 1.960 + (1.980 - 1.960) * (inv / invA);
    }
    for (var i = 0; i < T_TABLE.length - 1; i++) {
      var a = T_TABLE[i], b = T_TABLE[i + 1];
      if (dof >= a[0] && dof <= b[0]) {
        var f = (1 / dof - 1 / a[0]) / (1 / b[0] - 1 / a[0]);
        return a[1] + f * (b[1] - a[1]);
      }
    }
    return 1.96;
  }

  /** Ordinary least squares y = a + b x with standard errors. */
  function linreg(xs, ys) {
    var n = xs.length;
    if (n < 2) return null;
    var sx = 0, sy = 0;
    for (var i = 0; i < n; i++) { sx += xs[i]; sy += ys[i]; }
    var xm = sx / n, ym = sy / n;
    var sxx = 0, sxy = 0, syy = 0;
    for (var j = 0; j < n; j++) {
      var dx = xs[j] - xm, dy = ys[j] - ym;
      sxx += dx * dx; sxy += dx * dy; syy += dy * dy;
    }
    var xRange = Math.max.apply(null, xs) - Math.min.apply(null, xs);
    var xScale = Math.max(Math.abs(xm), xRange, 1e-300);
    if (!(sxx > 1e-24 * xScale * xScale * n)) {
      return { n: n, degenerate: true, xMean: xm, yMean: ym, sxx: sxx };
    }
    var b = sxy / sxx;
    var a = ym - b * xm;
    var sse = 0;
    for (var k = 0; k < n; k++) { var r = ys[k] - (a + b * xs[k]); sse += r * r; }
    var dof = n - 2;
    var s2 = dof > 0 ? sse / dof : NaN;
    // all y equal (a flat line): R² is 1 when the points sit on it, not 0
    var flat = syy <= n * Math.pow(1e-9 * Math.max(Math.abs(ym), 1e-300), 2);
    var r2 = flat ? 1 : Math.max(0, 1 - sse / syy);
    if (n === 2) r2 = 1;
    var seB = dof > 0 ? Math.sqrt(s2 / sxx) : NaN;
    var seA = dof > 0 ? Math.sqrt(s2 * (1 / n + xm * xm / sxx)) : NaN;
    var covAB = dof > 0 ? -xm * s2 / sxx : NaN;
    var t = tCrit95(dof);
    return {
      n: n, dof: dof, slope: b, intercept: a, r2: r2, r: syy > 0 ? (sxy >= 0 ? 1 : -1) * Math.sqrt(r2) : 1,
      sse: sse, s: Math.sqrt(s2), seSlope: seB, seIntercept: seA, covAB: covAB, tcrit: t,
      xMean: xm, yMean: ym, sxx: sxx, xMin: Math.min.apply(null, xs), xMax: Math.max.apply(null, xs)
    };
  }

  /** Least squares line through the origin y = b x. */
  function originFit(xs, ys) {
    var sxy = 0, sxx = 0, n = xs.length;
    for (var i = 0; i < n; i++) { sxy += xs[i] * ys[i]; sxx += xs[i] * xs[i]; }
    if (!(sxx > 0)) return null;
    var b = sxy / sxx, sse = 0, syy = 0, ym = 0;
    for (var j = 0; j < n; j++) ym += ys[j] / n;
    for (var k = 0; k < n; k++) { var r = ys[k] - b * xs[k]; sse += r * r; syy += (ys[k] - ym) * (ys[k] - ym); }
    return { slope: b, sse: sse, rms: Math.sqrt(sse / n), r2: syy > 0 ? 1 - sse / syy : 1 };
  }

  function mean(a) { var s = 0; for (var i = 0; i < a.length; i++) s += a[i]; return a.length ? s / a.length : NaN; }
  function std(a) {
    if (a.length < 2) return 0;
    var m = mean(a), s = 0;
    for (var i = 0; i < a.length; i++) s += (a[i] - m) * (a[i] - m);
    return Math.sqrt(s / (a.length - 1));
  }

  /** Spearman rank correlation (for trend hints). */
  function spearman(xs, ys) {
    function ranks(v) {
      var idx = v.map(function (x, i) { return [x, i]; }).sort(function (p, q) { return p[0] - q[0]; });
      var r = new Array(v.length);
      for (var i = 0; i < idx.length;) {
        var j = i;
        while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
        var avg = (i + j) / 2 + 1;
        for (var k = i; k <= j; k++) r[idx[k][1]] = avg;
        i = j + 1;
      }
      return r;
    }
    if (xs.length < 3) return NaN;
    var rx = ranks(xs), ry = ranks(ys);
    var fit = linreg(rx, ry);
    return fit && !fit.degenerate ? fit.r : NaN;
  }

  function quantile(sorted, q) {
    if (!sorted.length) return NaN;
    var pos = (sorted.length - 1) * q, lo = Math.floor(pos), hi = Math.ceil(pos);
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
  }

  /** Small seeded random generator, so the rounding check gives the same numbers every time. */
  function mulberry32(seed) {
    return function () {
      seed |= 0; seed = seed + 0x6D2B79F5 | 0;
      var t = Math.imul(seed ^ seed >>> 15, 1 | seed);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }

  function sgn(s) { return String(s).replace(/^-/, '\u2212'); }

  /* ---------------- terms ---------------- */

  function num(v) { return typeof v === 'number' && isFinite(v); }

  /**
   * rows:   [{id, sheetRow, p, Np, Gp, Bo, Rs, Bg, Wp, Bw}] in base units
   * params: {pi, Boi, Bgi, Rsi, Swc, Cw, Cf}
   * opts:   {includeEfw: bool (default true), excluded: array or Set of row ids,
   *          aquifer: {mode: 'none' | 'column' | 'pot', K: rb/psi}}
   */
  function computeTerms(rows, params, opts) {
    opts = opts || {};
    var includeEfw = opts.includeEfw !== false;
    var aq = opts.aquifer || { mode: 'none' };
    var potK = aq.mode === 'pot' && num(aq.K) && aq.K > 0 ? aq.K : 0;
    var excluded = opts.excluded instanceof Set ? opts.excluded : new Set(opts.excluded || []);
    var P = params || {};
    var swc = num(P.Swc) ? P.Swc : 0, cw = num(P.Cw) ? P.Cw : 0, cf = num(P.Cf) ? P.Cf : 0;
    var efwFactor = includeEfw ? P.Boi * (cw * swc + cf) / (1 - swc) : 0;

    return rows.map(function (r) {
      var t = {
        id: r.id, sheetRow: r.sheetRow, p: r.p, Np: r.Np, Gp: r.Gp, Bo: r.Bo, Rs: r.Rs, Bg: r.Bg,
        Wp: num(r.Wp) ? r.Wp : 0, Bw: num(r.Bw) ? r.Bw : 1
      };
      t.dP = P.pi - r.p;
      t.Rp = r.Np > 0 ? r.Gp / r.Np : NaN;
      t.F = r.Np * r.Bo + (r.Gp - r.Np * r.Rs) * r.Bg + t.Wp * t.Bw;
      t.Eo = (r.Bo - P.Boi) + (P.Rsi - r.Rs) * r.Bg;
      t.Eg = P.Boi * (r.Bg / P.Bgi - 1);
      t.Efw = efwFactor * t.dP;
      if (!num(t.Efw)) t.Efw = 0;
      // cumulative water influx, rb
      if (aq.mode === 'column') t.We = num(r.We) ? r.We : (r.Np === 0 ? 0 : NaN);
      else if (potK) t.We = t.dP > 0 ? potK * t.dP : 0;
      else t.We = 0;
      t.Fnet = t.F - t.We;
      t.denom = t.Eo + t.Efw;
      t.x = (t.Eg + t.Efw) / t.denom;
      t.y = t.Fnet / t.denom;

      var reason = '';
      if (![t.p, t.Np, t.Gp, t.Bo, t.Rs, t.Bg].every(num)) reason = 'missing values';
      else if (!num(t.F) || !num(t.Eo) || !num(t.Eg)) reason = 'check the reservoir parameters';
      else if (r.Np <= 0) reason = 'initial point (Np = 0)';
      else if (!(t.dP > 0)) reason = 'pressure is not below p_i';
      else if (!num(t.We)) reason = 'W_e is missing';
      else if (!(t.denom > 1e-12)) reason = 'E_o + E_fw is not positive';
      else if (!num(t.x) || !num(t.y)) reason = 'cannot divide by E_o + E_fw';
      else if (!(t.Fnet > 0)) reason = t.We > 0 ? 'W_e is larger than F' : 'F is not positive';
      t.usable = !reason;
      t.reason = reason;
      t.userExcluded = excluded.has(r.id);
      t.included = t.usable && !t.userExcluded;
      return t;
    });
  }

  /* ---------------- m evaluation (explorer) ---------------- */

  /** For a given m, build Et and the through-origin fit F − We = N·Et; spread of the implied N = (F − We)/Et. */
  function evaluateM(terms, m) {
    var pts = [];
    terms.forEach(function (t) {
      if (!t.included) return;
      var Et = t.Eo + m * t.Eg + (1 + m) * t.Efw;
      var Fn = num(t.Fnet) ? t.Fnet : t.F;
      pts.push({ id: t.id, F: Fn, Et: Et, impliedN: Et > 0 ? Fn / Et : NaN, p: t.p });
    });
    var valid = pts.filter(function (q) { return q.Et > 0 && num(q.impliedN); });
    var res = { m: m, points: pts, n: pts.length, valid: valid.length === pts.length && pts.length > 0 };
    if (!res.valid) { res.N = NaN; res.cv = NaN; return res; }
    var fit = originFit(valid.map(function (q) { return q.Et; }), valid.map(function (q) { return q.F; }));
    res.N = fit ? fit.slope : NaN;
    res.r2Origin = fit ? fit.r2 : NaN;
    var imp = valid.map(function (q) { return q.impliedN; });
    var mu = mean(imp);
    res.impliedMean = mu;
    res.cv = mu > 0 ? 100 * std(imp) / mu : NaN;
    res.relRms = fit && mean(valid.map(function (q) { return q.F; })) > 0 ? 100 * fit.rms / mean(valid.map(function (q) { return q.F; })) : NaN;
    return res;
  }

  /** Lowest m for which every included point still has Et > 0. */
  function minValidM(terms) {
    var lo = -Infinity;
    terms.forEach(function (t) {
      if (!t.included) return;
      var a = t.Eo + t.Efw, b = t.Eg + t.Efw; // Et = a + m b
      if (b > 0) lo = Math.max(lo, -a / b);
    });
    return lo;
  }

  function scanM(terms, mMin, mMax, steps) {
    steps = steps || 120;
    var out = [];
    for (var i = 0; i <= steps; i++) {
      var m = mMin + (mMax - mMin) * i / steps;
      var e = evaluateM(terms, m);
      out.push({ m: m, cv: e.cv, N: e.N, relRms: e.relRms });
    }
    return out;
  }

  /* ---------------- rounding check ---------------- */

  /**
   * Re-runs the fit many times with B_o, R_s, B_g (and B_oi, B_gi, R_si) moved at random within their last digit.
   * steps: full step of the last digit of each input, in base units (0 = exact).
   * Returns the 5 %, 50 % and 95 % values of m and N, and how much each point's x moves.
   */
  function roundingCheck(rows, params, opts, steps, trials) {
    trials = trials || 400;
    var rand = mulberry32(20261119);
    var jit = function (step) { return step > 0 ? (rand() - 0.5) * step : 0; };
    var ms = [], Ns = [], xs = {};
    for (var t = 0; t < trials; t++) {
      var rr = rows.map(function (r) {
        return Object.assign({}, r, { Bo: r.Bo + jit(steps.Bo), Rs: r.Rs + jit(steps.Rs), Bg: r.Bg + jit(steps.Bg) });
      });
      var pp = Object.assign({}, params, { Boi: params.Boi + jit(steps.Boi), Bgi: params.Bgi + jit(steps.Bgi), Rsi: params.Rsi + jit(steps.Rsi) });
      var inc = computeTerms(rr, pp, opts).filter(function (x) { return x.included; });
      if (inc.length < 2) continue;
      var fit = linreg(inc.map(function (x) { return x.x; }), inc.map(function (x) { return x.y; }));
      if (!fit || fit.degenerate || !(fit.intercept > 0)) continue;
      ms.push(fit.slope / fit.intercept);
      Ns.push(fit.intercept);
      inc.forEach(function (x) { (xs[x.id] = xs[x.id] || []).push(x.x); });
    }
    ms.sort(function (a, b) { return a - b; });
    Ns.sort(function (a, b) { return a - b; });
    var xStd = {};
    Object.keys(xs).forEach(function (id) { xStd[id] = std(xs[id]); });
    return {
      trials: ms.length,
      m: [quantile(ms, 0.05), quantile(ms, 0.5), quantile(ms, 0.95)],
      N: [quantile(Ns, 0.05), quantile(Ns, 0.5), quantile(Ns, 0.95)],
      shareNegative: ms.filter(function (v) { return v < 0; }).length / Math.max(1, ms.length),
      xStd: xStd
    };
  }

  /* ---------------- pot aquifer ---------------- */

  /** Solve a 3 × 3 linear system by Gaussian elimination with partial pivoting. */
  function solve3(A, b) {
    var M = A.map(function (row, i) { return row.concat([b[i]]); });
    for (var c = 0; c < 3; c++) {
      var piv = c;
      for (var r = c + 1; r < 3; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
      if (Math.abs(M[piv][c]) < 1e-300) return null;
      var tmp = M[c]; M[c] = M[piv]; M[piv] = tmp;
      for (var r2 = c + 1; r2 < 3; r2++) {
        var f = M[r2][c] / M[c][c];
        for (var k = c; k < 4; k++) M[r2][k] -= f * M[c][k];
      }
    }
    var x = [0, 0, 0];
    for (var i = 2; i >= 0; i--) {
      var s = M[i][3];
      for (var j = i + 1; j < 3; j++) s -= M[i][j] * x[j];
      x[i] = s / M[i][i];
    }
    return x;
  }

  /**
   * Best pot-aquifer constant K (rb/psi) for We = K (pi − p): least squares on
   *   F = N (Eo + Efw) + mN (Eg + Efw) + K (pi − p)
   * over the points in the fit. A negative K (water leaving the reservoir) is not physical, so K = 0 then.
   */
  function bestPotK(rows, params, opts) {
    var o = Object.assign({}, opts || {}, { aquifer: { mode: 'none' } });
    var inc = computeTerms(rows, params, o).filter(function (t) { return t.included; });
    if (inc.length < 3) return null;
    // scale the columns so the normal equations stay well conditioned
    var cols = inc.map(function (t) { return [t.Eo + t.Efw, t.Eg + t.Efw, t.dP]; });
    var sc = [0, 1, 2].map(function (j) { return Math.max.apply(null, cols.map(function (c) { return Math.abs(c[j]); })) || 1; });
    var A = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], b = [0, 0, 0];
    inc.forEach(function (t, i) {
      var c = cols[i].map(function (v, j) { return v / sc[j]; });
      for (var r = 0; r < 3; r++) {
        b[r] += c[r] * t.F;
        for (var k = 0; k < 3; k++) A[r][k] += c[r] * c[k];
      }
    });
    var x = solve3(A, b);
    if (!x) return null;
    var N = x[0] / sc[0], mN = x[1] / sc[1], K = x[2] / sc[2];
    return { K: Math.max(0, K), Kraw: K, negative: K < 0, N: N, m: mN / N, n: inc.length };
  }

  /* ---------------- full analysis ---------------- */

  function analyze(rows, params, opts) {
    opts = opts || {};
    var msgs = { errors: [], warnings: [], infos: [] };
    var P = params || {};
    var res = { ok: false, terms: [], fit: null, results: null, validation: null, messages: msgs };

    var need = ['pi', 'Boi', 'Bgi', 'Rsi'];
    var SYM = { pi: 'p_i', Boi: 'B_oi', Bgi: 'B_gi', Rsi: 'R_si' };
    var missing = need.filter(function (k) { return !num(P[k]); });
    if (missing.length) {
      msgs.errors.push({ code: 'params', text: 'Enter ' + missing.map(function (k) { return SYM[k]; }).join(', ') + ' to run the analysis.' });
      return res;
    }
    if (!(P.Bgi > 0)) { msgs.errors.push({ code: 'params', text: 'B_gi must be greater than zero.' }); return res; }
    if (num(P.Swc) && (P.Swc < 0 || P.Swc >= 1)) { msgs.errors.push({ code: 'params', text: 'S_wc must be between 0 and 1.' }); return res; }

    var terms = computeTerms(rows, P, opts);
    res.terms = terms;
    var inc = terms.filter(function (t) { return t.included; });
    var usable = terms.filter(function (t) { return t.usable; });

    if (usable.length < 2) {
      msgs.errors.push({ code: 'points', text: 'At least two production points below p_i are needed to draw the line. The file has ' + usable.length + '.' });
      return res;
    }
    if (inc.length < 2) {
      msgs.errors.push({ code: 'points', text: 'At least two points must be included in the fit. Click excluded points on the plot to add them back.' });
      return res;
    }

    var fit = linreg(inc.map(function (t) { return t.x; }), inc.map(function (t) { return t.y; }));
    if (!fit || fit.degenerate) {
      msgs.errors.push({ code: 'degenerate', text: 'All included points have the same x value, so the slope cannot be found. Include more points or check B_g and B_gi.' });
      return res;
    }
    res.fit = fit;

    var N = fit.intercept, mN = fit.slope;
    if (Math.abs(mN) < 1e-11 * Math.abs(N)) mN = 0; // round-off on data with no gas cap
    var m = mN / N;
    var G = mN * P.Boi / P.Bgi;
    var R = {
      N: N, mN: mN, m: m, G: G,
      oilHCPV: N * P.Boi, gasCapHCPV: mN * P.Boi,
      seN: fit.seIntercept, seMN: fit.seSlope, seG: fit.seSlope * P.Boi / P.Bgi
    };
    if (num(fit.seIntercept) && num(fit.seSlope) && N !== 0) {
      var varM = (fit.seSlope * fit.seSlope) / (N * N) +
        (mN * mN) * (fit.seIntercept * fit.seIntercept) / Math.pow(N, 4) -
        2 * mN * fit.covAB / Math.pow(N, 3);
      R.seM = Math.sqrt(Math.max(0, varM));
    } else R.seM = NaN;
    var t = fit.tcrit;
    R.ciN = num(R.seN) ? [N - t * R.seN, N + t * R.seN] : null;
    R.ciM = num(R.seM) ? [m - t * R.seM, m + t * R.seM] : null;
    R.ciG = num(R.seG) ? [G - t * R.seG, G + t * R.seG] : null;
    res.results = R;

    // per-point values at the fitted N and m
    terms.forEach(function (tt) {
      tt.yFit = N + mN * tt.x;
      tt.resid = tt.y - tt.yFit;
      tt.Et = tt.Eo + m * tt.Eg + (1 + m) * tt.Efw;
      tt.impliedN = tt.Et > 0 ? tt.Fnet / tt.Et : NaN;
      var Fm = tt.F;
      if (Fm > 0 && num(tt.Et)) {
        tt.DDI = N * tt.Eo / Fm;
        tt.SDI = N * m * tt.Eg / Fm;
        tt.CDI = N * (1 + m) * tt.Efw / Fm;
        tt.WDI = num(tt.We) ? tt.We / Fm : 0;
        tt.sumDI = tt.DDI + tt.SDI + tt.CDI + tt.WDI;
      } else { tt.DDI = tt.SDI = tt.CDI = tt.WDI = tt.sumDI = NaN; }
    });

    // validation: F vs Et through the origin
    var ev = evaluateM(terms, m);
    res.validation = { N: ev.N, cv: ev.cv, r2Origin: ev.r2Origin, relRms: ev.relRms, impliedMean: ev.impliedMean };

    /* ---------- messages ---------- */
    var excludedCount = terms.filter(function (tt) { return tt.userExcluded && tt.usable; }).length;
    if (excludedCount) msgs.infos.push({ code: 'excluded', text: excludedCount + ' point' + (excludedCount > 1 ? 's are' : ' is') + ' left out of the fit by you.' });
    if (fit.n === 2) msgs.infos.push({ code: 'two', text: 'Only two points are in the fit, so the line passes through both and there is no check on fit quality.' });
    if (!(N > 0)) {
      msgs.errors.push({ code: 'N', text: 'The intercept N is zero or negative, which has no physical meaning. Check the units of B_g and G_p, the initial parameters, or leave out the points that do not follow the trend.' });
    }
    if (N > 0 && m < 0) {
      var withinNoise = fit.n >= 3 && num(R.seM) && Math.abs(m) <= t * R.seM;
      var noCap = evaluateM(terms, 0);
      var noCapText = num(noCap.N) && noCap.N > 0 ? ' With no gas cap (m = 0), the best line through the origin gives N = ' + (noCap.N / 1e6).toFixed(1) + ' MMSTB.' : '';
      if (withinNoise) {
        msgs.infos.push({ code: 'm-zero', text: 'm is slightly below zero (' + sgn(m.toFixed(3)) + ' ± ' + (t * R.seM).toFixed(3) + '), within the uncertainty of the fit, so the data show no clear gas cap. The drive indices are hidden while m is negative.' + noCapText });
      } else {
        var causes = (opts.aquifer && opts.aquifer.mode !== 'none') ? 'rounded or noisy data, or a water influx model that does not fit' : 'rounded or noisy data, or a drive this model leaves out, such as water influx';
        msgs.warnings.push({ code: 'm-neg', text: 'The slope of the line is negative, so m < 0 and G < 0. A gas cap cannot be negative, so the drive indices are hidden. Common causes are ' + causes + '.' + noCapText });
      }
    }
    if (fit.n >= 3 && fit.r2 < 0.9) {
      msgs.warnings.push({ code: 'r2', text: 'The points scatter around the line (R² = ' + fit.r2.toFixed(3) + '). Treat N and m with care.' });
    }
    if (fit.n >= 3 && N > 0 && m > 0 && num(R.seM) && R.seM > 0.5 * m) {
      msgs.warnings.push({ code: 'm-uncertain', text: 'm is poorly defined by these points: m = ' + m.toFixed(3) + ' ± ' + (t * R.seM).toFixed(3) + ' at 95 % confidence.' });
    }
    if (fit.n >= 3 && fit.xMax - fit.xMin < 0.05 * Math.max(Math.abs(fit.xMean), 1e-12) && fit.xMax - fit.xMin < 0.02) {
      msgs.warnings.push({ code: 'x-narrow', text: 'The points cover a very narrow range of x, so the slope (and m) is poorly defined.' });
    }
    if (N > 0 && m >= 0 && inc.length >= 5) {
      var imp = inc.map(function (tt) { return tt.impliedN; });
      var rho = spearman(inc.map(function (tt) { return tt.Np; }), imp);
      var spread = (Math.max.apply(null, imp) - Math.min.apply(null, imp)) / N;
      if (rho > 0.8 && spread > 0.03) {
        msgs.infos.push({ code: 'influx', text: (opts.aquifer && opts.aquifer.mode !== 'none')
          ? '(F − W_e) / E_t still rises as oil is produced: the water influx may be too small.'
          : 'F / E_t keeps rising as oil is produced. This is a typical sign of water influx: try a pot aquifer under Water influx.' });
      }
    }
    // how much does rounding in the inputs move the answer?
    var steps = opts.precision && opts.precision.steps;
    if (steps && N > 0 && fit.n >= 3 && Object.keys(steps).some(function (k) { return steps[k] > 0; })) {
      var trials = opts.roundingTrials || Math.max(80, Math.min(400, Math.round(4000 / Math.max(1, inc.length))));
      var rc = roundingCheck(rows, P, opts, steps, trials);
      res.rounding = rc;
      var mSpan = rc.m[2] - rc.m[0], nSpan = (rc.N[2] - rc.N[0]) / N;
      var wide = (rc.m[0] < 0 && rc.m[2] > 0) || nSpan > 0.3 || mSpan > Math.max(0.2, Math.abs(m));
      if (rc.trials >= 50 && (wide || mSpan > 0.05 || nSpan > 0.1)) {
        var note = opts.precision.note;
        var text = (note ? note + ', and the answer' : 'The answer') + ' depends ' + (wide ? 'strongly' : 'somewhat') + ' on ' + (note ? 'that rounding' : 'rounding in the data') +
          '. Moving B_o, R_s and B_g only within their last digit gives m from ' + sgn(rc.m[0].toFixed(3)) + ' to ' + sgn(rc.m[2].toFixed(3)) +
          ' and N from ' + (rc.N[0] / 1e6).toFixed(0) + ' to ' + (rc.N[2] / 1e6).toFixed(0) + ' MMSTB.';
        // the points whose x moves by more than half the spread of x are the ones to question first
        var xr = fit.xMax - fit.xMin;
        var shaky = inc.filter(function (tt) { return rc.xStd[tt.id] > 0.5 * xr; });
        if (shaky.length && inc.length - shaky.length >= 3) {
          var keep = inc.filter(function (tt) { return shaky.indexOf(tt) < 0; });
          var f2 = linreg(keep.map(function (tt) { return tt.x; }), keep.map(function (tt) { return tt.y; }));
          var names = shaky.map(function (tt) { return Math.round(tt.p).toLocaleString('en-US'); });
          var list = names.length === 1 ? names[0] : names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1];
          text += ' The point' + (shaky.length > 1 ? 's' : '') + ' at ' + list + ' psia move' + (shaky.length > 1 ? '' : 's') + ' the most';
          if (f2 && !f2.degenerate && f2.intercept > 0) {
            text += '; without ' + (shaky.length > 1 ? 'them' : 'it') + ', N = ' + (f2.intercept / 1e6).toFixed(1) + ' MMSTB and m = ' + sgn((f2.slope / f2.intercept).toFixed(3)) + '.';
          } else text += '.';
          rc.shaky = shaky.map(function (tt) { return tt.id; });
        }
        (wide ? msgs.warnings : msgs.infos).push({ code: 'rounding', text: text });
      }
    }

    var negDen = terms.filter(function (tt) { return tt.reason === 'E_o + E_fw is not positive'; }).length;
    if (negDen) msgs.warnings.push({ code: 'eo', text: negDen + ' point' + (negDen > 1 ? 's have' : ' has') + ' E_o + E_fw ≤ 0 and cannot be plotted. Check B_oi and R_si.' });
    var negF = terms.filter(function (tt) { return tt.reason === 'F is not positive'; }).length;
    if (negF) msgs.warnings.push({ code: 'F', text: negF + ' point' + (negF > 1 ? 's have' : ' has') + ' F ≤ 0. Check the units of G_p and B_g.' });

    res.ok = msgs.errors.length === 0;
    return res;
  }

  return {
    tCrit95: tCrit95,
    linreg: linreg,
    originFit: originFit,
    spearman: spearman,
    computeTerms: computeTerms,
    evaluateM: evaluateM,
    minValidM: minValidM,
    scanM: scanM,
    roundingCheck: roundingCheck,
    bestPotK: bestPotK,
    analyze: analyze
  };
});
