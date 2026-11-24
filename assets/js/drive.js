/*
 * drive.js
 * Finds the drive mechanism from the production and PVT data with Havlena–Odeh diagnostics,
 * then hands the chosen model to the engine for the full results.
 *
 *   1. Apparent N = F / (Eo + Efw) at each step. With depletion alone it is the same at every step.
 *   2. Candidate models, each fitted the Havlena–Odeh way:
 *        depletion               F = N (Eo + Efw)                               F against Et through the origin
 *        gas cap                 F = N [Eo + m Eg + (1 + m) Efw]                the gas-cap line (table form)
 *        water drive             F = N (Eo + Efw) + We,  We = U S               F/Et against S/Et: slope U, intercept N
 *        gas cap + water drive   F = N [Eo + m Eg + (1 + m) Efw] + U S          least squares in F/Et
 *      Aquifers: pot (S = pi − p), steady state (Schilthuis, S = ∫(pi − p) dt) and unsteady state
 *      (van Everdingen–Hurst, radial: S = Σ ΔP_j W_D(a (t − t_j)), with r_e/r_o and a = t_D per unit time fitted).
 *      A W_e column in the file replaces the aquifer models; a given m replaces the fitted one.
 *   3. A model counts only if it makes physical sense (N > 0, m > 0, U > 0), each mechanism in it carries at least
 *      2 % of F at some step, and the sign of its m and U survives the rounding of the table (90 % of trials).
 *      Among those, the lowest AICc (on the relative misfit of F) wins; within 2 of it, fewer parameters win.
 *   4. Without a time column, time-dependent aquifers are tried only when nothing simpler fits, with the rows
 *      taken as equal time steps (said so in the result).
 * Works in the browser (global HODrive) and in Node (module.exports).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./mbe.js'), require('./wdtable.js'));
  else root.HODrive = factory(root.HOEngine, root.HOWD);
})(typeof self !== 'undefined' ? self : this, function (E, WDT) {
  'use strict';

  function num(v) { return typeof v === 'number' && isFinite(v); }

  var MIN_SHARE = 0.02;   // a mechanism must carry at least 2 % of F at some step
  var ROBUST = 0.9;       // ... and keep its sign in 90 % of the rounding trials
  var POOR = 0.03;        // relative misfit of F above which a model does not explain the data
  var TREND = 0.05;       // apparent N may drift up to 5 % for depletion
  var SPREAD = 0.03;      // a straight line needs its x to vary by at least 3 % to give a slope

  /* ---------------- van Everdingen–Hurst W_D ---------------- */

  var CURVES = {}, PLATEAU = {};
  WDT.reD.forEach(function (r) {
    var key = String(r);
    CURVES[key] = WDT.WD[key].map(function (v) { return Math.log(v); });
    PLATEAU[key] = key === 'inf' ? Infinity : (r * r - 1) / 2;
  });
  var REDS = WDT.reD.map(function (r) { return r === 'inf' ? Infinity : r; });

  function reKey(reD) { return reD === Infinity || reD === 'inf' ? 'inf' : String(reD); }

  /** Dimensionless cumulative influx W_D(t_D) of a radial aquifer with r_e/r_o = reD (Infinity = infinite). */
  function wd(tD, reD) {
    if (!(tD > 0)) return 0;
    var key = reKey(reD), c = CURVES[key];
    var pos = (Math.log(tD) / Math.LN10 - WDT.logT0) * WDT.perDecade;
    if (pos <= 0) return 2 * Math.sqrt(tD / Math.PI) + tD / 2;              // early time, any aquifer size
    if (pos >= c.length - 1) return key === 'inf' ? (-4.29881 + 2.02566 * tD) / Math.log(tD) : PLATEAU[key];
    var i = Math.floor(pos), f = pos - i;
    return Math.exp(c[i] + f * (c[i + 1] - c[i]));
  }

  /* ---------------- pressure history and influx functions ---------------- */

  /**
   * Pressure history for the aquifer models: [{id, p, t}] in time order, starting at the initial state (p = pi).
   * mode 'column': t from the file (days); 'steps': the rows are equal time steps (t = 0, 1, 2 ...).
   */
  function history(rows, P, mode) {
    var list = rows.filter(function (r) { return num(r.p) && num(r.Np) && (mode !== 'column' || num(r.t)); });
    if (mode === 'column') list = list.slice().sort(function (a, b) { return (a.t - b.t) || (a.Np - b.Np); });
    if (!list.length) return [];
    var h = list.map(function (r, i) { return { id: r.id, p: r.p, t: mode === 'column' ? r.t : i }; });
    var first = list[0];
    if (first.Np === 0 || first.p >= P.pi) {
      h[0].p = P.pi;
    } else {
      // no initial row: production starts from pi at time 0 (or at the first time if that is not after 0)
      h.unshift({ id: null, p: P.pi, t: mode === 'column' ? Math.min(0, first.t) : -1 });
      if (mode !== 'column') h.forEach(function (x, i) { x.t = i; });
    }
    return h;
  }

  function potS(h, P) {
    var S = {};
    h.forEach(function (x) { if (x.id !== null) S[x.id] = P.pi - x.p; });
    return S;
  }

  /** Schilthuis steady state: S(t) = ∫ (pi − p) dt, trapezoids between the steps. */
  function steadyS(h, P) {
    var S = {}, acc = 0;
    for (var k = 0; k < h.length; k++) {
      if (k > 0) acc += 0.5 * ((P.pi - h[k].p) + (P.pi - h[k - 1].p)) * (h[k].t - h[k - 1].t);
      if (h[k].id !== null) S[h[k].id] = acc;
    }
    return S;
  }

  /** van Everdingen–Hurst superposition: S(t_k) = Σ_{j<k} ΔP_j W_D(a (t_k − t_j)), ΔP_0 = (p0 − p1)/2, ΔP_j = (p_{j−1} − p_{j+1})/2. */
  function vehS(h, reD, a, only) {
    var n = h.length, S = {};
    if (n < 2) return S;
    var dP = new Array(n - 1);
    dP[0] = (h[0].p - h[1].p) / 2;
    for (var j = 1; j < n - 1; j++) dP[j] = (h[j - 1].p - h[j + 1].p) / 2;
    for (var k = 1; k < n; k++) {
      var id = h[k].id;
      if (id === null || (only && !only[id])) continue;
      var s = 0;
      for (var jj = 0; jj < k; jj++) s += dP[jj] * wd(a * (h[k].t - h[jj].t), reD);
      S[id] = s;
    }
    return S;
  }

  /* ---------------- fits ---------------- */

  function etOf(t, m) { return t.Eo + m * t.Eg + (1 + m) * t.Efw; }

  /** F (or F − We) against Et through the origin: depletion, or a gas cap of known m. */
  function fitOrigin(inc, m) {
    var sxy = 0, sxx = 0;
    inc.forEach(function (t) { var e = etOf(t, m); sxy += t.Fnet * e; sxx += e * e; });
    var N = sxy / sxx;
    return { N: N, m: m, U: 0, We: function (t) { return t.F - t.Fnet; }, Fhat: function (t) { return N * etOf(t, m) + (t.F - t.Fnet); } };
  }

  /** Gas-cap line in the table form (F − We known). */
  function fitGas(inc) {
    var pts = inc.map(function (t) { return Object.assign({}, t); });
    var f = E.fitLine(pts);
    if (!f || f.degenerate) return null;
    var N = f.intercept, m = f.slope / f.intercept;
    return { N: N, m: m, U: 0, We: function (t) { return t.F - t.Fnet; }, Fhat: function (t) { return N * etOf(t, m) + (t.F - t.Fnet); } };
  }

  /** Water drive: F/Et = N + U S/Et (m fixed, 0 unless given); with U given, only N is fitted. */
  function fitWater(inc, S, m, Ufixed) {
    var xs = [], ys = [];
    inc.forEach(function (t) { var e = etOf(t, m); xs.push(S[t.id] / e); ys.push(t.F / e); });
    var N, U;
    if (num(Ufixed)) {
      U = Ufixed; N = 0;
      for (var i = 0; i < xs.length; i++) N += ys[i] - U * xs[i];
      N /= xs.length;
    } else {
      var f = E.linreg(xs, ys);
      if (!f || f.degenerate) return null;
      N = f.intercept; U = f.slope;
    }
    return { N: N, m: m, U: U, We: function (t) { return U * S[t.id]; }, Fhat: function (t) { return N * etOf(t, m) + U * S[t.id]; } };
  }

  /** Gas cap + water drive: F = N (Eo + Efw) + mN (Eg + Efw) + U S, least squares in F/(Eo + Efw). */
  function fitComb(inc, S) {
    var A = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], b = [0, 0, 0];
    var rowsX = inc.map(function (t) {
      var e = t.Eo + t.Efw;
      return { x: [1, (t.Eg + t.Efw) / e, S[t.id] / e], y: t.F / e };
    });
    var sc = [0, 1, 2].map(function (j) { return Math.max.apply(null, rowsX.map(function (r) { return Math.abs(r.x[j]); })) || 1; });
    rowsX.forEach(function (r) {
      var c = r.x.map(function (v, j) { return v / sc[j]; });
      for (var i = 0; i < 3; i++) { b[i] += c[i] * r.y; for (var k = 0; k < 3; k++) A[i][k] += c[i] * c[k]; }
    });
    var x = solve3(A, b);
    if (!x) return null;
    var N = x[0] / sc[0], mN = x[1] / sc[1], U = x[2] / sc[2], m = mN / N;
    return { N: N, m: m, U: U, We: function (t) { return U * S[t.id]; }, Fhat: function (t) { return N * etOf(t, m) + U * S[t.id]; } };
  }

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
    return x.every(num) ? x : null;
  }

  /** Relative misfit of F and AICc (k parameters). */
  function score(inc, fit, k) {
    var sse = 0, n = inc.length;
    inc.forEach(function (t) { var r = (t.F - fit.Fhat(t)) / t.F; sse += r * r; });
    var floor = n * 1e-14;
    var aicc = n - k - 1 > 0 ? n * Math.log(Math.max(sse, floor) / n) + 2 * k + 2 * k * (k + 1) / (n - k - 1) : Infinity;
    return { sse: sse, rms: Math.sqrt(sse / n), aicc: aicc, k: k, n: n };
  }

  /** Largest share of F carried by the gas cap (SDI) and by the water influx (WDI) over the points in the fit. */
  function shares(inc, fit) {
    var sdi = 0, wdi = 0;
    inc.forEach(function (t) {
      sdi = Math.max(sdi, fit.N * fit.m * t.Eg / t.F);
      wdi = Math.max(wdi, fit.We(t) / t.F);
    });
    return { sdi: sdi, wdi: wdi };
  }

  /* ---------------- unsteady-state aquifer: fit r_e/r_o and a ---------------- */

  function vehSearch(inc, h, gas, opts) {
    var span = h.length ? h[h.length - 1].t - h[0].t : 0;
    if (!(span > 0)) return null;
    var only = {};
    // on long files, search on at most 40 points, then fit all of them
    var pick = inc;
    if (inc.length > 40) pick = inc.filter(function (t, i) { return i % Math.ceil(inc.length / 40) === 0 || i === inc.length - 1; });
    pick.forEach(function (t) { only[t.id] = 1; });
    var lo = Math.log10(0.01 / span), hi = Math.log10(1e4 / span);
    var reds = opts.reD !== undefined && opts.reD !== null ? [opts.reD === 'inf' ? Infinity : opts.reD] : REDS;
    var best = null;
    function evalAt(reD, la, set, ids) {
      var S = vehS(h, reD, Math.pow(10, la), ids);
      var f = gas ? fitComb(set, S) : fitWater(set, S, opts.mKnown || 0, null);
      if (!f || !(f.N > 0) || !(f.U > 0) || (gas && !(f.m > 0))) return { sse: Infinity };
      var sc = score(set, f, 1);
      return { sse: sc.sse, fit: f, S: S };
    }
    reds.forEach(function (reD) {
      var grid = [], bi = -1;
      for (var la = lo; la <= hi + 1e-9; la += 1 / 12) {
        var v = evalAt(reD, la, pick, only).sse;
        grid.push([la, v]);
        if (v < Infinity && (bi < 0 || v < grid[bi][1])) bi = grid.length - 1;
      }
      if (bi < 0) return;
      // golden section between the grid neighbours
      var a = grid[Math.max(0, bi - 1)][0], b = grid[Math.min(grid.length - 1, bi + 1)][0];
      var g = (Math.sqrt(5) - 1) / 2;
      var c = b - g * (b - a), d = a + g * (b - a), fc = evalAt(reD, c, pick, only).sse, fd = evalAt(reD, d, pick, only).sse;
      for (var it = 0; it < 28; it++) {
        if (fc < fd) { b = d; d = c; fd = fc; c = b - g * (b - a); fc = evalAt(reD, c, pick, only).sse; }
        else { a = c; c = d; fc = fd; d = a + g * (b - a); fd = evalAt(reD, d, pick, only).sse; }
      }
      var laBest = fc < fd ? c : d;
      if (Math.min(fc, fd) > grid[bi][1]) laBest = grid[bi][0];
      var full = evalAt(reD, laBest, inc, null);
      if (full.sse < Infinity && (!best || full.sse < best.sse)) best = { sse: full.sse, fit: full.fit, S: full.S, reD: reD, a: Math.pow(10, laBest) };
    });
    return best;
  }

  /* ---------------- rounding robustness ---------------- */

  function rng(seed) {
    var s = seed >>> 0;
    return function () {
      s = (s + 0x6D2B79F5) >>> 0;
      var t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function quantile(sorted, q) {
    if (!sorted.length) return NaN;
    var pos = (sorted.length - 1) * q, lo = Math.floor(pos), hi = Math.ceil(pos);
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
  }

  /**
   * Refits a model on tables rounded differently within their last digit: the share of trials in which its gas cap
   * (m > 0) and aquifer (U > 0) keep their sign, and the 5, 50 and 95 % points of N, m and U.
   */
  function robustness(rows, P, baseOpts, cand, steps, trials) {
    var rand = rng(20261121), okGas = 0, okWater = 0, okN = 0, n = 0, Ns = [], ms = [], Us = [];
    function jit(s) { return s > 0 ? (rand() - 0.5) * s : 0; }
    for (var k = 0; k < trials; k++) {
      var rr = rows.map(function (r) { return Object.assign({}, r, { Bo: r.Bo + jit(steps.Bo), Rs: r.Rs + jit(steps.Rs), Bg: r.Bg + jit(steps.Bg) }); });
      var pp = Object.assign({}, P, { Boi: P.Boi + jit(steps.Boi), Bgi: P.Bgi + jit(steps.Bgi), Rsi: P.Rsi + jit(steps.Rsi) });
      var inc = E.computeTerms(rr, pp, baseOpts).filter(function (t) { return t.included; });
      if (inc.length < 2) continue;
      var f = cand.refit(inc);
      if (!f) continue;
      n++;
      if (f.N > 0) okN++;
      if (f.m > 0) okGas++;
      if (f.U > 0) okWater++;
      Ns.push(f.N); ms.push(f.m); Us.push(f.U);
    }
    var q = function (a) { a.sort(function (x, y) { return x - y; }); return [quantile(a, 0.05), quantile(a, 0.5), quantile(a, 0.95)]; };
    return { trials: n, gas: n ? okGas / n : 0, water: n ? okWater / n : 0, pos: n ? okN / n : 0, N: q(Ns), m: q(ms), U: q(Us) };
  }

  /* ---------------- apparent N ---------------- */

  function apparentN(inc, m) {
    var pts = inc.map(function (t) { return { id: t.id, p: t.p, Np: t.Np, v: t.Fnet / etOf(t, m) }; }).filter(function (q) { return num(q.v); });
    if (pts.length < 2) return { points: pts, change: 0, t: 0, mean: pts.length ? pts[0].v : NaN };
    var f = E.linreg(pts.map(function (q) { return q.Np; }), pts.map(function (q) { return q.v; }));
    var mean = pts.reduce(function (s, q) { return s + q.v; }, 0) / pts.length;
    var lo = Math.min.apply(null, pts.map(function (q) { return q.Np; })), hi = Math.max.apply(null, pts.map(function (q) { return q.Np; }));
    var change = f && !f.degenerate ? f.slope * (hi - lo) / mean : 0;
    var tstat = f && num(f.seSlope) && f.seSlope > 0 ? f.slope / f.seSlope : (f && f.slope !== 0 ? Infinity : 0);
    var vmin = Math.min.apply(null, pts.map(function (q) { return q.v; })), vmax = Math.max.apply(null, pts.map(function (q) { return q.v; }));
    return { points: pts, change: change, t: tstat, mean: mean, min: vmin, max: vmax, spread: (vmax - vmin) / mean };
  }

  /* ---------------- the candidates ---------------- */

  var NAMES = {
    depletion: 'Depletion drive',
    gascap: 'Gas-cap drive',
    water: 'Water drive',
    combination: 'Combination drive: gas cap and water'
  };
  var AQ_NAMES = { pot: 'pot aquifer', steady: 'steady-state aquifer', veh: 'unsteady-state aquifer', column: 'W_e from the file' };

  function build(rows, P, opts, timeMode) {
    var baseOpts = { includeEfw: opts.includeEfw, excluded: opts.excluded, aquifer: { mode: 'none' } };
    var colOpts = { includeEfw: opts.includeEfw, excluded: opts.excluded, aquifer: { mode: 'column' } };
    var base = E.computeTerms(rows, P, baseOpts);
    var inc = base.filter(function (t) { return t.included; });
    var cands = [];
    var mKnown = num(opts.mKnown) && opts.mKnown >= 0 ? opts.mKnown : null;
    var gasPossible = mKnown === null && !opts.undersaturated && inc.some(function (t) { return t.Eg !== 0; });
    var mech = opts.mech || 'auto';
    var allow = function (family) { return mech === 'auto' || mech === family; };
    var aqAllow = function (kind) { return !opts.aquifer || opts.aquifer === 'auto' || opts.aquifer === kind; };

    function add(c) {
      if (!c.fit) return;
      c.sc = score(c.inc, c.fit, c.k);
      c.share = shares(c.inc, c.fit);
      c.valid = c.fit.N > 0 && (!c.gas || c.fit.m > 0) && (!c.waterFitted || c.fit.U > 0);
      c.material = (!c.gas || c.share.sdi >= MIN_SHARE) && (!c.water || c.share.wdi >= MIN_SHARE);
      // a line whose x hardly changes cannot separate its two constants (above the bubble point, for example,
      // a pot aquifer grows in step with the oil and rock expansion)
      c.identifiable = true;
      var xs = null;
      if (!c.gas && c.water && c.waterFitted && c.S) xs = c.inc.map(function (t) { return c.S[t.id] / etOf(t, c.mFixed || 0); });
      else if (c.key === 'gascap') xs = c.inc.map(function (t) { return t.Eg / (t.Eo + t.Efw); });
      if (xs && xs.length >= 2) {
        var xm = xs.reduce(function (a, b) { return a + b; }, 0) / xs.length;
        c.xSpread = (Math.max.apply(null, xs) - Math.min.apply(null, xs)) / Math.abs(xm || 1);
        c.identifiable = c.xSpread >= SPREAD;
      }
      c.name = NAMES[c.family] + (c.aquifer ? ', ' + AQ_NAMES[c.aquifer] : '');
      cands.push(c);
    }

    if (opts.weColumn) {
      // the file gives W_e: the question is only whether there is a gas cap as well
      var colTerms = E.computeTerms(rows, P, colOpts);
      var cinc = colTerms.filter(function (t) { return t.included; });
      if (cinc.length >= 2) {
        if (allow('water') || allow('depletion')) {
          add({ key: 'water-column', family: 'water', aquifer: 'column', gas: false, water: true, waterFitted: false, k: 1, inc: cinc,
            fit: fitOrigin(cinc, mKnown || 0), refit: function (x) { return fitOrigin(x, mKnown || 0); }, baseOpts: colOpts, mFixed: mKnown || 0 });
        }
        if (gasPossible && (allow('combination') || allow('gascap'))) {
          add({ key: 'comb-column', family: 'combination', aquifer: 'column', gas: true, water: true, waterFitted: false, k: 2, inc: cinc,
            fit: fitGas(cinc), refit: fitGas, baseOpts: colOpts });
        }
      }
      return { cands: cands, inc: inc, base: base, gasPossible: gasPossible, mKnown: mKnown };
    }

    // no aquifer
    if (allow('depletion') || (mKnown !== null && allow('gascap'))) {
      var m0 = mKnown || 0;
      add({ key: mKnown ? 'gascap-known' : 'depletion', family: mKnown ? 'gascap' : 'depletion', gas: false, water: false, k: 1, inc: inc,
        fit: fitOrigin(inc, m0), refit: function (x) { return fitOrigin(x, m0); }, baseOpts: baseOpts, mFixed: m0 });
    }
    if (gasPossible && allow('gascap')) {
      add({ key: 'gascap', family: 'gascap', gas: true, water: false, k: 2, inc: inc, fit: fitGas(inc), refit: fitGas, baseOpts: baseOpts });
    }

    // aquifers
    var h = timeMode ? history(rows, P, timeMode) : history(rows, P, 'steps');
    var aqs = [];
    if (aqAllow('pot')) aqs.push({ kind: 'pot', S: potS(h, P), extra: 0, Ufixed: num(opts.potK) ? opts.potK : null });
    if (timeMode && aqAllow('steady')) aqs.push({ kind: 'steady', S: steadyS(h, P), extra: 0 });
    var waterFam = mKnown ? 'water' : 'water';
    aqs.forEach(function (aq) {
      var fixedU = num(aq.Ufixed);
      if (allow('water') || (mKnown !== null && allow('combination'))) {
        var mw = mKnown || 0;
        add({ key: 'water-' + aq.kind, family: mKnown ? 'combination' : waterFam, aquifer: aq.kind, gas: false, water: true, waterFitted: !fixedU,
          k: (fixedU ? 1 : 2) + aq.extra, inc: inc, S: aq.S, U: aq.Ufixed, mFixed: mw,
          fit: fitWater(inc, aq.S, mw, aq.Ufixed), refit: function (x) { return fitWater(x, aq.S, mw, aq.Ufixed); }, baseOpts: baseOpts });
      }
      if (gasPossible && allow('combination')) {
        if (fixedU) {
          // pot aquifer with K given: the gas-cap line with W_e known
          var withWe = inc.map(function (t) { return Object.assign({}, t, { Fnet: t.F - aq.Ufixed * aq.S[t.id] }); });
          add({ key: 'comb-' + aq.kind, family: 'combination', aquifer: aq.kind, gas: true, water: true, waterFitted: false, k: 2 + aq.extra,
            inc: withWe, S: aq.S, U: aq.Ufixed, fit: (function () { var f = fitGas(withWe); if (f) { f.U = aq.Ufixed; f.We = function (t) { return aq.Ufixed * aq.S[t.id]; }; } return f; })(),
            refit: function (x) {
              var w = x.map(function (t) { return Object.assign({}, t, { Fnet: t.F - aq.Ufixed * aq.S[t.id] }); });
              var f = fitGas(w); if (f) f.U = aq.Ufixed; return f;
            }, baseOpts: baseOpts });
        } else {
          add({ key: 'comb-' + aq.kind, family: 'combination', aquifer: aq.kind, gas: true, water: true, waterFitted: true, k: 3 + aq.extra,
            inc: inc, S: aq.S, fit: fitComb(inc, aq.S), refit: function (x) { return fitComb(x, aq.S); }, baseOpts: baseOpts });
        }
      }
    });
    if (timeMode && aqAllow('veh')) {
      var vopts = { reD: opts.reD, mKnown: mKnown };
      var extra = opts.reD !== undefined && opts.reD !== null ? 1 : 2;
      if (allow('water') || (mKnown !== null && allow('combination'))) {
        var v = vehSearch(inc, h, false, vopts);
        if (v) {
          var mw2 = mKnown || 0;
          add({ key: 'water-veh', family: mKnown ? 'combination' : 'water', aquifer: 'veh', gas: false, water: true, waterFitted: true, k: 2 + extra,
            inc: inc, S: v.S, reD: v.reD, a: v.a, mFixed: mw2, fit: v.fit, refit: function (x) { return fitWater(x, v.S, mw2, null); }, baseOpts: baseOpts });
        }
      }
      if (gasPossible && allow('combination')) {
        var v2 = vehSearch(inc, h, true, vopts);
        if (v2) {
          add({ key: 'comb-veh', family: 'combination', aquifer: 'veh', gas: true, water: true, waterFitted: true, k: 3 + extra,
            inc: inc, S: v2.S, reD: v2.reD, a: v2.a, fit: v2.fit, refit: function (x) { return fitComb(x, v2.S); }, baseOpts: baseOpts });
        }
      }
    }
    return { cands: cands, inc: inc, base: base, gasPossible: gasPossible, mKnown: mKnown, history: h };
  }

  function choose(cands, forced) {
    var eligible = cands.filter(function (c) { return c.valid && (forced || (c.material && c.robust && c.identifiable)) && isFinite(c.sc.aicc); });
    if (!eligible.length && forced) eligible = cands.filter(function (c) { return isFinite(c.sc.aicc); });
    if (!eligible.length) return null;
    eligible.sort(function (a, b) { return a.sc.aicc - b.sc.aicc; });
    var best = eligible[0];
    eligible.forEach(function (c) {
      if (c.sc.aicc <= eligible[0].sc.aicc + 2 && (c.k < best.k || (c.k === best.k && c.sc.aicc < best.sc.aicc))) best = c;
    });
    return best;
  }

  /* ---------------- saturation ---------------- */

  /**
   * Above the bubble point R_s stays at R_si and B_o rises as the pressure falls. If any production step shows that,
   * the oil started undersaturated, so there can be no initial gas cap.
   */
  function saturation(rows, P) {
    var prod = rows.filter(function (r) { return r.Np > 0 && num(r.p) && num(r.Rs) && num(r.Bo); });
    var tol = Math.max(0.5, 1e-3 * Math.abs(P.Rsi || 0));
    var under = prod.filter(function (r) { return r.Rs >= P.Rsi - tol && r.Bo > P.Boi + 1e-9; });
    var sat = prod.filter(function (r) { return r.Rs < P.Rsi - tol; });
    if (!under.length) return { undersaturated: false, below: sat.length > 0 };
    var pu = Math.min.apply(null, under.map(function (r) { return r.p; }));
    var ps = sat.length ? Math.max.apply(null, sat.map(function (r) { return r.p; })) : null;
    var fmt = function (v) { return Math.round(v).toLocaleString('en-US'); };
    var text = sat.length
      ? 'R_s stays at R_si and B_o rises down to ' + fmt(pu) + ' psia, so the oil started undersaturated (bubble point between ' + fmt(ps) + ' and ' + fmt(pu) + ' psia) and there is no initial gas cap.'
      : 'R_s stays at R_si and B_o rises at every step: the oil stays above its bubble point, so there is no free gas and no gas cap.';
    return { undersaturated: true, allAbove: !sat.length, pbLow: ps, pbHigh: pu, text: text };
  }

  /* ---------------- detection ---------------- */

  /**
   * rows/params as for the engine. opts: includeEfw, excluded (ids), precision {steps}, hasTime (rows carry t in days),
   * time: 'auto' | 'steps' | 'none' (used when there is no time column), mech: 'auto' | 'depletion' | 'gascap' | 'water' | 'combination',
   * aquifer: 'auto' | 'pot' | 'steady' | 'veh', potK (rb/psi, fixed), reD (fixed r_e/r_o), weColumn (use the W_e column),
   * mKnown (given m), undersaturated (no gas cap possible), trials (rounding trials).
   */
  function detect(rows, params, opts) {
    opts = Object.assign({}, opts || {});
    var P = params || {};
    var sat = saturation(rows, P);
    if (opts.undersaturated === undefined) { opts.undersaturated = sat.undersaturated; opts.undersaturatedText = sat.text; }
    var forced = opts.mech && opts.mech !== 'auto';
    var steps = opts.precision && opts.precision.steps;
    var hasSteps = steps && Object.keys(steps).some(function (k) { return steps[k] > 0; });
    var trials = opts.trials || 120;

    function run(timeMode) {
      var b = build(rows, P, opts, timeMode);
      b.cands.forEach(function (c) {
        c.robust = true;
        c.robustness = null;
        if (!hasSteps || !c.valid || !c.material || !c.identifiable || (!c.gas && !c.waterFitted)) return;
        var r = robustness(rows, P, c.baseOpts, c, steps, trials);
        c.robustness = r;
        c.robust = r.trials >= 20 && r.pos >= ROBUST && (!c.gas || r.gas >= ROBUST) && (!c.waterFitted || r.water >= ROBUST);
      });
      b.best = choose(b.cands, forced);
      if (b.best && hasSteps && !b.best.robustness && b.best.refit) b.best.robustness = robustness(rows, P, b.best.baseOpts, b.best, steps, trials);
      b.timeMode = timeMode;
      return b;
    }

    var timeMode = opts.hasTime ? 'column' : (opts.time === 'steps' ? 'steps' : null);
    var out = run(timeMode);
    var trendBase = apparentN(out.inc, out.mKnown || 0);
    out.trend = trendBase;
    out.assumedSteps = false;
    var depl = out.cands.filter(function (c) { return c.key === 'depletion' || c.key === 'gascap-known'; })[0];
    var deplPoor = depl && (depl.sc.rms > POOR || (Math.abs(trendBase.change) > TREND && Math.abs(trendBase.t) > 2));
    var bestPoor = !out.best || out.best.sc.rms > POOR || (depl && out.best === depl && deplPoor);
    if (!opts.hasTime && opts.time !== 'none' && opts.time !== 'steps' && !opts.weColumn && bestPoor) {
      var alt = run('steps');
      var ab = alt.best;
      if (ab && ab.water && (ab.aquifer === 'veh' || ab.aquifer === 'steady') && ab.sc.rms <= POOR &&
          (!out.best || ab.sc.aicc < out.best.sc.aicc - 4)) {
        alt.trend = trendBase;
        alt.assumedSteps = true;
        out = alt;
      } else {
        out.stepsTried = alt;
      }
    }
    out.saturation = sat;
    out.depletionPoor = !!deplPoor;
    out.forced = !!forced;
    out.evidence = evidence(out, opts);
    out.title = out.best ? NAMES[out.best.family] : 'Drive mechanism not clear';
    out.poor = !out.best || out.best.sc.rms > POOR;
    return out;
  }

  /* ---------------- the evidence, in words ---------------- */

  function pct(v) { var a = Math.abs(v * 100); return (a >= 10 ? a.toFixed(0) : a >= 1 ? a.toFixed(1) : a.toFixed(2)) + ' %'; }
  function mm(v) { return (v / 1e6).toFixed(v >= 1e8 ? 0 : 1); }
  function sg(v, d) { var s = v.toFixed(d); return v < 0 ? '−' + s.slice(1) : s; }
  function big(v) { return Math.round(v).toLocaleString('en-US'); }

  function aqText(c) {
    if (c.aquifer === 'veh') return 'unsteady-state aquifer (van Everdingen–Hurst, r_e/r_o = ' + (c.reD === Infinity ? '∞' : c.reD) + ')';
    return AQ_NAMES[c.aquifer];
  }

  function evidence(out, opts) {
    var ev = [], tr = out.trend, cands = out.cands, best = out.best;
    function find(key) { return cands.filter(function (c) { return c.key === key; })[0]; }
    // 1. depletion alone
    if (!opts.weColumn && tr.points.length >= 3) {
      var mk = out.mKnown ? ' with m = ' + out.mKnown : '';
      if (out.depletionPoor) {
        ev.push({ level: 'no', key: 'depletion', text: 'Depletion alone' + mk + ' would keep F/E_t the same at every step. Here it goes from ' + mm(tr.points[0].v) + ' to ' +
          mm(tr.points[tr.points.length - 1].v) + ' MMSTB (range ' + mm(tr.min) + ' to ' + mm(tr.max) + '), so more energy is acting.' });
      } else {
        ev.push({ level: 'yes', key: 'depletion', text: 'Depletion alone' + mk + ' explains the data: F/E_t stays within ' + pct(tr.spread / 2) + ' of ' + mm(tr.mean) + ' MMSTB at every step.' });
      }
    }
    // 2. gas cap
    if (opts.undersaturated) {
      ev.push({ level: 'info', key: 'gascap', text: opts.undersaturatedText || 'The oil starts undersaturated (R_s = R_si below p_i), so there is no initial gas cap.' });
    } else if (out.mKnown !== null && out.mKnown !== undefined) {
      ev.push({ level: 'info', key: 'gascap', text: 'm = ' + out.mKnown + ' is given, so the gas cap is not fitted.' });
    } else if (out.gasPossible) {
      var g = find('gascap') || find('comb-column');
      if (g) ev.push(gasLine(g, best));
    }
    // 3. water
    if (opts.weColumn) {
      var wc = find('water-column');
      if (wc) ev.push({ level: 'info', key: 'water', text: 'W_e comes from the file. With it, F − W_e against E_t gives N = ' + mm(wc.fit.N) + ' MMSTB (fits F within ' + pct(wc.sc.rms) + ').' });
    } else {
      ['pot', 'steady', 'veh'].forEach(function (kind) {
        var c = find('water-' + kind);
        if (!c) return;
        ev.push(waterLine(c, best));
      });
      if (!out.timeMode) {
        ev.push({ level: 'info', key: 'time', text: 'There is no time column, so only the pot aquifer can be tried. Steady- and unsteady-state aquifers need time; add a time or date column, or set the rows to equal time steps.' });
      }
    }
    if (out.assumedSteps) {
      ev.push({ level: 'info', key: 'time', text: 'There is no time column, so the rows are taken as equal time steps (for example, one per year) for the steady- and unsteady-state aquifers. If they are not, add a time column.' });
    }
    // 4. combination
    if (best && best.family === 'combination') {
      var u = best.aquifer === 'column' ? 'W_e from the file' : aqText(best) + (best.aquifer === 'pot' ? ', K = ' + big(best.fit.U) + ' rb/psi' : '');
      ev.push({ level: 'yes', key: 'comb', text: 'Gas cap and ' + u + ' together fit F within ' + pct(best.sc.rms) + ', with N = ' + mm(best.fit.N) + ' MMSTB and m = ' + sg(best.fit.m, 3) +
        '. The gas cap supplies up to ' + pct(best.share.sdi) + ' of F and the influx up to ' + pct(best.share.wdi) + '.' });
    }
    ['comb-pot', 'comb-steady', 'comb-veh'].forEach(function (key) {
      var c = find(key);
      if (!c || c === best) return;
      if (best && best.family === 'combination') return;
      if (c.valid && c.material && !c.robust) {
        ev.push({ level: 'no', key: 'comb', text: 'Adding a gas cap to the ' + aqText(c) + ' gives m = ' + sg(c.fit.m, 3) + ', but rounding the table within its last digit flips it in ' + pct(1 - c.robustness.gas) + ' of trials, so it is not counted.' });
      }
    });
    // 5. the choice
    if (best) {
      var others = cands.filter(function (c) { return c !== best && c.valid && c.material && c.robust && isFinite(c.sc.aicc); }).sort(function (a, b) { return a.sc.aicc - b.sc.aicc; });
      var lower = function (c) { return c.name.charAt(0).toLowerCase() + c.name.slice(1); };
      var txt = 'Best: ' + lower(best) + (best.aquifer === 'veh' ? ' (r_e/r_o = ' + (best.reD === Infinity ? '∞' : best.reD) + ')' : '') +
        ', which reproduces F within ' + pct(best.sc.rms) + ' (root mean square).';
      if (others.length && !out.forced) {
        var nx = others[0], extraK = nx.k - best.k;
        if (nx.sc.rms < best.sc.rms && extraK > 0) {
          txt += ' The ' + lower(nx) + ' fits a little closer (' + pct(nx.sc.rms) + ') but needs ' + extraK + ' more parameter' + (extraK > 1 ? 's' : '') + ', which these points do not justify.';
        } else txt += ' Next: ' + lower(nx) + ', within ' + pct(nx.sc.rms) + '.';
      }
      if (out.forced) txt = 'You chose this mechanism. ' + txt;
      ev.push({ level: best.sc.rms > POOR ? 'no' : 'yes', key: 'best', text: txt });
    } else {
      ev.push({ level: 'no', key: 'best', text: 'No model makes physical sense and fits the data. Check the units, the initial parameters and the PVT data.' });
    }
    return ev;
  }

  function gasLine(g, best) {
    var m = g.fit.m;
    var both = best && best.family === 'combination';
    if (!g.identifiable) return { level: 'no', key: 'gascap', text: 'The gas-cap line has almost no spread in E_g/E_t here, so its slope, and m, cannot be found.' };
    if (both && !(m > 0)) return { level: 'no', key: 'gascap', text: 'On its own, with no water influx, the gas-cap line gives m = ' + sg(m, 3) + ': a gas cap alone does not explain the data.' };
    if (!(m > 0)) return { level: 'no', key: 'gascap', text: 'The gas-cap line gives m = ' + sg(m, 3) + '. A gas cap cannot be negative, so there is no gas cap.' };
    if (!g.material) return { level: 'no', key: 'gascap', text: 'The gas-cap line gives m = ' + sg(m, 4) + ': the gas cap would supply under ' + pct(MIN_SHARE) + ' of F, so it does not count.' };
    if (!g.robust) return { level: 'no', key: 'gascap', text: 'The gas-cap line gives m = ' + sg(m, 3) + ', but rounding the table within its last digit makes it negative in ' + pct(1 - g.robustness.gas) + ' of trials, so the data show no clear gas cap.' };
    if (both) return { level: 'maybe', key: 'gascap', text: 'On its own, with no water influx, the gas-cap line gives m = ' + sg(m, 3) + ' and fits F within ' + pct(g.sc.rms) + ', less well than with the aquifer as well.' };
    if (best && best.gas) return { level: 'yes', key: 'gascap', text: 'The gas-cap line gives m = ' + sg(m, 3) + ' and fits F within ' + pct(g.sc.rms) + ': the gas cap supplies up to ' + pct(g.share.sdi) + ' of F.' };
    return { level: 'maybe', key: 'gascap', text: 'The gas-cap line gives m = ' + sg(m, 3) + ' and fits F within ' + pct(g.sc.rms) + ', less well than the model chosen.' };
  }

  function waterLine(c, best) {
    var name = aqText(c);
    var both = best && best.family === 'combination' && !c.gas;
    var name1 = name.charAt(0).toUpperCase() + name.slice(1) + (both ? ' alone, with no gas cap' : '');
    if (!c.identifiable) return { level: 'no', key: 'water-' + c.aquifer, text: name1 + ': its influx grows in step with the oil and rock expansion here, so the two cannot be told apart. Any such aquifer is already inside the apparent N.' };
    if (!(c.fit.U > 0) && c.waterFitted) return { level: 'no', key: 'water-' + c.aquifer, text: name1 + ': the best fit needs ' + (c.aquifer === 'pot' ? 'K' : c.aquifer === 'steady' ? 'C' : 'U') + ' < 0, water leaving the reservoir, so it does not apply.' };
    if (!c.valid) return { level: 'no', key: 'water-' + c.aquifer, text: name1 + ': the fit gives N ≤ 0, so it does not apply.' };
    if (!c.material) return { level: 'no', key: 'water-' + c.aquifer, text: name1 + ': the influx would supply under ' + pct(MIN_SHARE) + ' of F, so it does not count.' };
    if (!c.robust) return { level: 'no', key: 'water-' + c.aquifer, text: name1 + ': fits F within ' + pct(c.sc.rms) + ', but rounding the table within its last digit flips ' + (c.robustness.pos < ROBUST ? 'the sign of N' : 'the aquifer') + ' in ' + pct(1 - Math.min(c.robustness.water, c.robustness.pos)) + ' of trials.' };
    if (c.sc.rms > POOR) return { level: 'no', key: 'water-' + c.aquifer, text: name1 + ': misses F by ' + pct(c.sc.rms) + ' on average, so it does not explain the data.' };
    if (best && best.water && !best.gas && best.aquifer === c.aquifer) return { level: 'yes', key: 'water-' + c.aquifer, text: name1 + ': fits F within ' + pct(c.sc.rms) + ', with N = ' + mm(c.fit.N) + ' MMSTB; the influx supplies up to ' + pct(c.share.wdi) + ' of F.' };
    return { level: 'maybe', key: 'water-' + c.aquifer, text: name1 + ': fits F within ' + pct(c.sc.rms) + ' (N = ' + mm(c.fit.N) + ' MMSTB), less well than the model chosen.' };
  }

  return {
    wd: wd,
    REDS: REDS,
    history: history,
    potS: potS,
    steadyS: steadyS,
    vehS: vehS,
    fitOrigin: fitOrigin,
    fitWater: fitWater,
    fitComb: fitComb,
    apparentN: apparentN,
    saturation: saturation,
    detect: detect,
    NAMES: NAMES,
    AQ_NAMES: AQ_NAMES,
    MIN_SHARE: MIN_SHARE,
    POOR: POOR
  };
});
