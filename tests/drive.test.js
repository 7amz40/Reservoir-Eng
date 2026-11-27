// Drive-mechanism detection: aquifer functions, the candidate models, the choice, and real data with known answers.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { E, FIX, SAMPLES, runFile, synthetic, close } = require('./helpers');
const D = require('../assets/js/drive.js');

function edwardson(tD) {
  if (tD < 0.01) return 2 * Math.sqrt(tD / Math.PI);
  if (tD < 200) {
    const r = Math.sqrt(tD);
    return (1.12838 * r + 1.19328 * tD + 0.269872 * tD * r + 0.00855294 * tD * tD) / (1 + 0.616599 * r + 0.0413008 * tD);
  }
  return (-4.29881 + 2.02566 * tD) / Math.log(tD);
}

const detect = (s, opts = {}) => D.detect(s.rows, s.params, Object.assign({ includeEfw: true, hasTime: s.rows.some(r => r.t > 0) }, opts));

/* ---------- van Everdingen–Hurst W_D ---------- */

test('W_D of an infinite aquifer matches Edwardson et al. within 0.2 %', () => {
  for (const tD of [0.01, 0.05, 0.3, 1, 3, 10, 30, 100, 500, 3000, 1e4]) {
    close(D.wd(tD, Infinity), edwardson(tD), 2e-3, 'tD ' + tD);
  }
  // the table and its early-time series join smoothly
  close(D.wd(1e-3 * 0.999, Infinity), D.wd(1e-3 * 1.001, Infinity), 2e-3, 'join at 1e-3');
});

test('W_D of a finite aquifer rises to (r_eD² − 1)/2 and never decreases', () => {
  for (const reD of [1.5, 2, 5, 10, 50]) {
    close(D.wd(1e6, reD), (reD * reD - 1) / 2, 1e-9, 'plateau ' + reD);
    let last = 0;
    for (let lt = -3; lt <= 5; lt += 0.05) {
      const v = D.wd(Math.pow(10, lt), reD);
      assert.ok(v >= last - 1e-12, 'monotone at reD ' + reD + ', tD 1e' + lt.toFixed(2));
      last = v;
    }
  }
  // early on the boundary is not felt: every size gives the infinite-aquifer value
  close(D.wd(0.05, 5), D.wd(0.05, Infinity), 1e-6, 'early time');
});

test('van Everdingen–Hurst influx reproduces Dake exercise 9.2 (r_e/r_o = 5, U = 6446 bbl/psi, t_D = 5.67 t)', () => {
  const p = [2740, 2500, 2290, 2109, 1949, 1818, 1702, 1608, 1535, 1480, 1440];
  const h = p.map((x, i) => ({ id: i, p: x, t: i }));
  const S = D.vehS(h, 5, 5.671);
  // book (read from the W_D table): 3.775, 47.276 and 89.225 MM bbl at 1, 5 and 10 years
  close(6446 * S[1] / 1e6, 3.775, 4e-3, 'year 1');
  close(6446 * S[5] / 1e6, 47.276, 4e-3, 'year 5');
  close(6446 * S[10] / 1e6, 89.225, 2e-3, 'year 10');
});

test('steady-state influx is the time integral of the pressure drop', () => {
  const h = [{ id: 0, p: 3000, t: 0 }, { id: 1, p: 2900, t: 10 }, { id: 2, p: 2800, t: 30 }];
  const S = D.steadyS(h, { pi: 3000 });
  assert.equal(S[0], 0);
  close(S[1], 0.5 * 100 * 10, 1e-12, 'step 1');
  close(S[2], 500 + 0.5 * (100 + 200) * 20, 1e-12, 'step 2');
});

test('the pressure history starts at p_i, with or without an initial row', () => {
  const P = { pi: 3000 };
  const withInit = D.history([{ id: 0, p: 3000, Np: 0 }, { id: 1, p: 2800, Np: 5 }], P, 'steps');
  assert.deepEqual(withInit.map(x => [x.id, x.p, x.t]), [[0, 3000, 0], [1, 2800, 1]]);
  const noInit = D.history([{ id: 7, p: 2800, Np: 5, t: 365 }, { id: 8, p: 2700, Np: 9, t: 730 }], P, 'column');
  assert.deepEqual(noInit.map(x => [x.id, x.p, x.t]), [[null, 3000, 0], [7, 2800, 365], [8, 2700, 730]]);
});

/* ---------- the analyses behind each mechanism ---------- */

test('depletion: F against E_t through the origin gives N, and the drive indices add up to 1', () => {
  const s = synthetic({ m: 0 });
  const r = E.analyzeOrigin(s.rows, s.params, {});
  close(r.results.N, 150e6, 1e-9, 'N');
  for (const t of r.terms.filter(t => t.included)) close(t.sumDI, 1, 1e-9, 'sum of indices');
  assert.equal(r.fit.kind, 'origin');
});

test('water drive: F/E_t against W_e/E_t has slope 1 and meets the axis at N', () => {
  const s = synthetic({ m: 0, K: 40000 });
  const S = {};
  s.rows.forEach(r => { S[r.id] = s.params.pi - r.p; });
  const r = E.analyzeWater(s.rows, s.params, { S });
  close(r.results.N, 150e6, 1e-9, 'N');
  close(r.results.U, 40000, 1e-9, 'U');
  for (const t of r.terms.filter(t => t.included)) {
    close(t.y, r.results.N + t.x, 1e-9, 'slope 1 at ' + t.p);
    close(t.sumDI, 1, 1e-9, 'sum of indices');
  }
});

/* ---------- detection on exact synthetic reservoirs ---------- */

const CASES = [
  ['depletion', { m: 0 }, 'depletion', null, { N: 150e6 }],
  ['gas cap', { m: 0.4 }, 'gascap', null, { N: 150e6, m: 0.4 }],
  ['small gas cap', { m: 0.05 }, 'gascap', null, { N: 150e6, m: 0.05 }],
  ['pot aquifer', { m: 0, K: 40000 }, 'water', 'pot', { N: 150e6, U: 40000 }],
  ['unsteady-state aquifer', { m: 0, n: 11, veh: { U: 9000, reD: 5, a: 0.8 / 365.25 } }, 'water', 'veh', { N: 150e6 }],
  // a gas cap and a pot aquifer grow almost in step, so they need a longer history to tell apart on a rounded table
  ['gas cap and pot aquifer', { m: 0.3, K: 30000, n: 12 }, 'combination', 'pot', { N: 150e6, m: 0.3, U: 30000 }],
  ['gas cap and unsteady-state aquifer', { m: 0.3, n: 11, veh: { U: 9000, reD: 5, a: 0.8 / 365.25 } }, 'combination', 'veh', { N: 150e6, m: 0.3 }]
];
for (const [name, gen, family, aquifer, want] of CASES) {
  test('detects ' + name + ' and gives back its N' + (want.m ? ', m' : '') + (want.U ? ', aquifer constant' : ''), () => {
    const r = detect(synthetic(gen));
    assert.ok(r.best, 'a model is chosen');
    assert.equal(r.best.family, family, 'family');
    if (aquifer) assert.equal(r.best.aquifer, aquifer, 'aquifer');
    close(r.best.fit.N, want.N, 1e-4, 'N');
    if (want.m) close(r.best.fit.m, want.m, 1e-4, 'm');
    if (want.U) close(r.best.fit.U, want.U, 1e-4, 'U');
    assert.ok(!r.poor);
  });
}

test('an unsteady-state aquifer is found at the right size and time constant on exact data', () => {
  const r = detect(synthetic({ m: 0, n: 11, veh: { U: 9000, reD: 5, a: 0.8 / 365.25 } }));
  assert.equal(r.best.reD, 5);
  close(r.best.a, 0.8 / 365.25, 1e-3, 'a');
  close(r.best.fit.U, 9000, 1e-3, 'U');
});

test('undersaturated oil: no gas cap is tried, and the reason is given', () => {
  const s = synthetic({ m: 0, undersaturated: true });
  const r = detect(s);
  assert.equal(r.saturation.undersaturated, true);
  assert.ok(!r.cands.some(c => c.gas), 'no gas-cap model');
  assert.equal(r.best.family, 'depletion');
  assert.ok(r.evidence.some(e => /above its bubble point/.test(e.text)));
});

test('a given m replaces the fitted one', () => {
  const s = synthetic({ m: 0.4 });
  s.params.m = 0.4;
  const r = detect(s, { mKnown: 0.4 });
  assert.equal(r.best.key, 'gascap-known');
  close(r.best.fit.N, 150e6, 1e-9, 'N');
});

test('a W_e column is used instead of the aquifer models', () => {
  const s = synthetic({ m: 0.3, K: 30000 });
  const r = detect(s, { weColumn: true });
  assert.ok(r.cands.every(c => c.aquifer === 'column'));
  assert.equal(r.best.key, 'comb-column');
  close(r.best.fit.N, 150e6, 1e-9, 'N');
  close(r.best.fit.m, 0.3, 1e-9, 'm');
});

test('a chosen mechanism is used even when it does not fit', () => {
  const s = synthetic({ m: 0, K: 40000 });
  const r = detect(s, { mech: 'gascap' });
  assert.equal(r.best.family, 'gascap');
  assert.equal(r.forced, true);
  assert.ok(r.evidence.some(e => /You chose this mechanism/.test(e.text)));
});

test('without a time column, time-dependent aquifers are tried only when nothing simpler fits', () => {
  // a gas cap needs no time: the rows are not taken as time steps
  const g = synthetic({ m: 0.4 });
  const rg = detect(g, { hasTime: false });
  assert.equal(rg.best.family, 'gascap');
  assert.equal(rg.assumedSteps, false);
  // an unsteady-state aquifer with the time column removed: found by taking the rows as equal steps
  const w = synthetic({ m: 0, n: 11, veh: { U: 9000, reD: 5, a: 0.8 / 365.25 } });
  w.rows.forEach(r => { delete r.t; });
  const rw = detect(w, { hasTime: false });
  assert.equal(rw.assumedSteps, true);
  assert.equal(rw.best.aquifer, 'veh');
  close(rw.best.fit.N, 150e6, 1e-4, 'N');
  // ... unless the user says the rows are not equal steps
  const rn = detect(w, { hasTime: false, time: 'none' });
  assert.equal(rn.assumedSteps, false);
  assert.ok(rn.evidence.some(e => e.key === 'time'));
});

/* ---------- rounded data ---------- */

function rounded(s) {
  const sig = (v, n) => v ? Number(v.toPrecision(n)) : 0;
  s.rows.forEach(r => { r.Bo = Math.round(r.Bo * 1e4) / 1e4; r.Rs = Math.round(r.Rs); r.Bg = sig(r.Bg, 4); r.Np = sig(r.Np, 4); r.Gp = sig(r.Gp, 4); });
  const r0 = s.rows[0];
  Object.assign(s.params, { Boi: r0.Bo, Rsi: r0.Rs, Bgi: r0.Bg });
  const bgStep = Math.pow(10, Math.floor(Math.log10(Math.min.apply(null, s.rows.map(r => r.Bg)))) - 3);
  return { steps: { Bo: 1e-4, Rs: 1, Bg: bgStep, Boi: 1e-4, Rsi: 1, Bgi: bgStep } };
}

for (const [name, gen, family, aquifer] of CASES) {
  test('rounded table: still detects ' + name, () => {
    const s = synthetic(gen);
    const precision = rounded(s);
    const r = detect(s, { precision });
    assert.equal(r.best.family, family);
    if (aquifer) assert.equal(r.best.aquifer, aquifer);
    close(r.best.fit.N, 150e6, 0.1, 'N within 10 %');
    // the rounding range of N is reported, and it holds the true value or comes close
    const R = r.best.robustness;
    assert.ok(R && R.trials >= 20 && R.N[0] <= R.N[2], 'rounding range of N');
    assert.ok(R.N[0] < 150e6 * 1.02 && R.N[2] > 150e6 * 0.9, 'range ' + R.N.map(v => (v / 1e6).toFixed(1)).join(' to '));
  });
}

/* ---------- real data with known answers ---------- */

test('the example (HW Q1 data with S_wc, c_w and c_f): gas-cap drive, N = 112.1 MMSTB and m = 0.500', async () => {
  const r0 = await runFile(path.join(SAMPLES, 'havlena-odeh-example.xlsx'));
  const r = D.detect(r0.inputs.rows, r0.inputs.params, { includeEfw: true, precision: r0.inputs.precision });
  assert.equal(r.best.key, 'gascap');
  close(r.best.fit.N, 112.1272e6, 1e-5, 'N');
  close(r.best.fit.m, 0.50029, 1e-3, 'm');
  // without E_fw (c_w = c_f = 0) the same table gives the Q1 answer
  const r1 = D.detect(r0.inputs.rows, Object.assign({}, r0.inputs.params, { Cw: 0, Cf: 0 }), { includeEfw: true, precision: r0.inputs.precision });
  assert.equal(r1.best.key, 'gascap');
  close(r1.best.fit.N, 108.6467e6, 1e-5, 'N without Efw');
});

test('the HW Q2 data (Dake exercise 9.2, B_g rounded, no time): water drive, N near the book’s 312 MMSTB', async () => {
  const r0 = await runFile(path.join(FIX, 'q2_example.xlsx'));
  const r = D.detect(r0.inputs.rows, r0.inputs.params, { includeEfw: true, precision: r0.inputs.precision });
  assert.equal(r.best.family, 'water');
  assert.equal(r.best.aquifer, 'veh');
  assert.equal(r.assumedSteps, true);
  assert.ok(r.best.fit.N > 260e6 && r.best.fit.N < 330e6, 'N ' + r.best.fit.N);
  assert.ok(r.evidence.some(e => e.key === 'gascap' && /cannot be negative/.test(e.text)));
});

test('Dake exercise 9.2 with the book’s B_g and time (E_fw neglected, as in the book): water drive, N ≈ 312 MMSTB', () => {
  const Bg = [0.00093, 0.00098, 0.00107, 0.00117, 0.00128, 0.00139, 0.0015, 0.0016, 0.0017, 0.00176, 0.00182];
  const Rs = [650, 592, 545, 507, 471, 442, 418, 398, 383, 371, 364];
  const Np = [0, 7.88, 18.42, 29.15, 40.69, 50.14, 58.42, 65.39, 70.74, 74.54, 77.43];
  const Rp = [650, 760, 845, 920, 975, 1025, 1065, 1095, 1120, 1145, 1160];
  const p = [2740, 2500, 2290, 2109, 1949, 1818, 1702, 1608, 1535, 1480, 1440];
  const Bo = [1.404, 1.374, 1.349, 1.329, 1.316, 1.303, 1.294, 1.287, 1.280, 1.276, 1.273];
  const rows = p.map((x, i) => ({ id: i, sheetRow: i + 2, p: x, Np: Np[i] * 1e6, Gp: Np[i] * Rp[i] * 1e6, Bo: Bo[i], Rs: Rs[i], Bg: Bg[i], Wp: 0, Bw: 1, t: i * 365.25 }));
  const params = { pi: 2740, Boi: 1.404, Bgi: 0.00093, Rsi: 650, Swc: 0.05, Cw: 3e-6, Cf: 4e-6 };
  const precision = { steps: { Bo: 0.001, Rs: 1, Bg: 0.00001, Boi: 0.001, Rsi: 1, Bgi: 0.00001 } };
  const r = D.detect(rows, params, { includeEfw: false, precision, hasTime: true });
  assert.equal(r.best.family, 'water');
  assert.equal(r.best.aquifer, 'veh');
  close(r.best.fit.N, 312e6, 0.03, 'N');
  // a tiny gas cap would fit a little closer, but rounding flips its sign, so it is not counted
  const comb = r.cands.find(c => c.key === 'comb-veh');
  assert.ok(comb && comb.robust === false);
});

/* ---------- the sample files ---------- */

const SAMPLE_ANSWERS = [
  ['drive_depletion_N150.xlsx', 'depletion', null, 150e6, 0.002],
  ['drive_water_unsteady_N150.xlsx', 'water', 'veh', 150e6, 0.002],
  ['drive_gascap_water_N150_m030.xlsx', 'combination', 'pot', 150e6, 0.002],
  ['drive_undersaturated_N150.xlsx', 'depletion', null, 150e6, 0.002],
  ['known_answer_N150_m040.xlsx', 'gascap', null, 150e6, 1e-4]
];
// the other constants used to build the samples (tests/make_drive_samples.js)
const EXTRA = {
  'drive_water_unsteady_N150.xlsx': (b) => { close(b.fit.U, 9000, 0.01, 'U'); assert.equal(b.reD, 5); close(b.a * 365.25, 0.8, 0.01, 'a'); },
  'drive_gascap_water_N150_m030.xlsx': (b) => { close(b.fit.m, 0.3, 0.005, 'm'); close(b.fit.U, 30000, 0.01, 'K'); },
  'known_answer_N150_m040.xlsx': (b) => close(b.fit.m, 0.4, 1e-4, 'm')
};
for (const [file, family, aquifer, N, tol] of SAMPLE_ANSWERS) {
  test('sample ' + file + ': ' + family + (aquifer ? ' (' + aquifer + ')' : ''), async () => {
    const r0 = await runFile(path.join(SAMPLES, file));
    assert.equal(r0.analysis.errors.length, 0);
    const r = D.detect(r0.inputs.rows, r0.inputs.params, { includeEfw: true, precision: r0.inputs.precision, hasTime: r0.inputs.hasTime, undersaturated: r0.inputs.noGas ? true : undefined });
    assert.equal(r.best.family, family);
    if (aquifer) assert.equal(r.best.aquifer, aquifer);
    close(r.best.fit.N, N, tol, 'N');
    if (EXTRA[file]) EXTRA[file](r.best);
  });
}

test('above the bubble point a pot aquifer cannot be told apart from expansion, so it is not chosen', async () => {
  const r0 = await runFile(path.join(SAMPLES, 'drive_undersaturated_N150.xlsx'));
  assert.equal(r0.inputs.noGas, true);
  const r = D.detect(r0.inputs.rows, r0.inputs.params, { includeEfw: true, precision: r0.inputs.precision, undersaturated: true });
  const pot = r.cands.find(c => c.key === 'water-pot');
  assert.equal(pot.identifiable, false);
  assert.ok(pot.xSpread < 0.03);
  assert.ok(r.evidence.some(e => e.key === 'water-pot' && /cannot be told apart/.test(e.text)));
});
