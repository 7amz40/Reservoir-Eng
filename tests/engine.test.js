'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { E, synthetic, close, REF } = require('./helpers');

test('Student t critical values (two-sided 95 %)', () => {
  close(E.tCrit95(1), 12.706, 1e-4);
  close(E.tCrit95(8), 2.306, 1e-4);
  close(E.tCrit95(30), 2.042, 1e-4);
  assert.ok(E.tCrit95(45) < 2.021 && E.tCrit95(45) > 2.000);
  assert.ok(E.tCrit95(1000) > 1.96 && E.tCrit95(1000) < 1.963);
  assert.ok(Number.isNaN(E.tCrit95(0)));
});

test('linreg matches hand calculations', () => {
  const f = E.linreg([1, 2, 3, 4, 5], [2.1, 3.9, 6.2, 7.8, 10.1]);
  close(f.slope, 1.99, 1e-12);
  close(f.intercept, 0.05, 1e-9);
  close(f.r2, 0.99730533, 1e-7);
  // standard errors: s^2 = SSE/(n-2), se_b = s/sqrt(Sxx)
  const sse = [2.1, 3.9, 6.2, 7.8, 10.1].reduce((a, y, i) => a + Math.pow(y - (0.05 + 1.99 * (i + 1)), 2), 0);
  close(f.seSlope, Math.sqrt(sse / 3 / 10), 1e-9);
  const exact = E.linreg([0, 1, 2], [1, 3, 5]);
  assert.equal(exact.r2, 1);
  assert.equal(E.linreg([1], [1]), null);
  assert.equal(E.linreg([2, 2, 2], [1, 2, 3]).degenerate, true);
});

for (const c of [
  { N: 150e6, m: 0.4 }, { N: 80e6, m: 0.25, swc: 0.25, cw: 3.5e-6, cf: 6e-6 }, { N: 300e6, m: 1.2 },
  { N: 50e6, m: 0.05 }, { N: 120e6, m: 0, swc: 0.3 }, { N: 90e6, m: 0.8, swc: 0, cw: 0, cf: 0 }
]) {
  test('recovers N = ' + c.N / 1e6 + ' MMSTB and m = ' + c.m + ' from exact data', () => {
    const s = synthetic(c);
    const r = E.analyze(s.rows, s.params, {});
    assert.ok(r.ok, JSON.stringify(r.messages));
    close(r.results.N, c.N, 1e-9, 'N');
    if (c.m === 0) assert.ok(Math.abs(r.results.m) < 1e-9, 'm = 0');
    else close(r.results.m, c.m, 1e-8, 'm');
    if (c.m === 0) assert.ok(Math.abs(r.results.G) < 1, 'G = 0');
    else close(r.results.G, c.m * c.N * s.params.Boi / s.params.Bgi, 1e-8, 'G');
    assert.ok(r.fit.r2 > 1 - 1e-12);
    // drive indices add up to one on an exact line
    for (const t of r.terms.filter(t => t.included)) close(t.DDI + t.SDI + t.CDI, 1, 1e-9, 'drive indices sum');
    // the explorer sees zero spread at the true m
    const ev = E.evaluateM(r.terms, c.m);
    assert.ok(ev.cv < 1e-7, 'spread at true m ' + ev.cv);
    close(ev.N, c.N, 1e-9, 'origin-fit N');
  });
}

test('the answer does not depend on row order', () => {
  const s = synthetic({ N: 150e6, m: 0.4 });
  const shuffled = s.rows.slice().reverse().map((r, i) => Object.assign({}, r, { id: i }));
  const a = E.analyze(s.rows, s.params, {}), b = E.analyze(shuffled, s.params, {});
  close(b.results.N, a.results.N, 1e-12);
  close(b.results.m, a.results.m, 1e-12);
});

test('switching E_fw off is the same as Swc = Cw = Cf = 0', () => {
  const s = synthetic({ N: 150e6, m: 0.4 });
  const off = E.analyze(s.rows, s.params, { includeEfw: false });
  const zero = E.analyze(s.rows, Object.assign({}, s.params, { Swc: 0, Cw: 0, Cf: 0 }), {});
  close(off.results.N, zero.results.N, 1e-12);
  assert.ok(Math.abs(off.results.N - 150e6) > 1e3, 'neglecting E_fw biases N on data that has it');
});

test('leaving points out of the fit', () => {
  const s = synthetic({ N: 150e6, m: 0.4 });
  const all = E.analyze(s.rows, s.params, {});
  const some = E.analyze(s.rows, s.params, { excluded: [1, 2] });
  assert.equal(some.fit.n, all.fit.n - 2);
  close(some.results.N, 150e6, 1e-9);
  assert.ok(some.messages.infos.some(m => m.code === 'excluded'));
  const two = E.analyze(s.rows, s.params, { excluded: [3, 4, 5, 6, 7, 8] });
  assert.equal(two.fit.n, 2);
  assert.ok(two.messages.infos.some(m => m.code === 'two'));
  const one = E.analyze(s.rows, s.params, { excluded: [2, 3, 4, 5, 6, 7, 8] });
  assert.equal(one.ok, false);
  assert.equal(one.messages.errors[0].code, 'points');
});

test('missing or bad parameters stop the analysis with a message', () => {
  const s = synthetic();
  assert.equal(E.analyze(s.rows, Object.assign({}, s.params, { Boi: NaN }), {}).messages.errors[0].code, 'params');
  assert.equal(E.analyze(s.rows, Object.assign({}, s.params, { Bgi: 0 }), {}).messages.errors[0].code, 'params');
  assert.equal(E.analyze(s.rows, Object.assign({}, s.params, { Swc: 1.2 }), {}).messages.errors[0].code, 'params');
});

test('rows that cannot be used are explained', () => {
  const s = synthetic();
  const rows = s.rows.concat([Object.assign({}, s.rows[3], { id: 99, sheetRow: 99, p: 3100 })]);
  const r = E.analyze(rows, s.params, {});
  const t0 = r.terms.find(t => t.id === 0), tHigh = r.terms.find(t => t.id === 99);
  assert.match(t0.reason, /initial point/);
  assert.match(tHigh.reason, /not below p_i/);
  close(r.results.N, 150e6, 1e-9);
});

test('a straight line through few distinct x values is reported', () => {
  const s = synthetic({ N: 150e6, m: 0.4 });
  const rows = [s.rows[0], s.rows[3], Object.assign({}, s.rows[3], { id: 50, sheetRow: 50 })];
  const r = E.analyze(rows, s.params, {});
  assert.equal(r.ok, false);
  assert.equal(r.messages.errors[0].code, 'degenerate');
});

test('minValidM and scanM bracket the answer', () => {
  const s = synthetic({ N: 150e6, m: 0.4 });
  const r = E.analyze(s.rows, s.params, {});
  const lo = E.minValidM(r.terms);
  assert.ok(lo < 0);
  for (const t of r.terms.filter(t => t.included)) assert.ok(t.Eo + t.Efw + (lo + 1e-6) * (t.Eg + t.Efw) > 0);
  const scan = E.scanM(r.terms, 0, 1, 200);
  const best = scan.filter(p => isFinite(p.cv)).sort((a, b) => a.cv - b.cv)[0];
  assert.ok(Math.abs(best.m - 0.4) <= 0.0051, 'scan minimum at ' + best.m);
});

test('the two example data sets match the reference answers', () => {
  const q2rows = [
    [2740, 650, 1.404, 0.0009, 0.00, 0], [2500, 592, 1.374, 0.0010, 7.88, 5988.8], [2290, 545, 1.349, 0.0011, 18.42, 15565],
    [2109, 507, 1.329, 0.0012, 29.15, 26818], [1949, 471, 1.316, 0.0013, 40.69, 39673], [1818, 442, 1.303, 0.0014, 50.14, 51394],
    [1702, 418, 1.294, 0.0015, 58.42, 62217], [1608, 398, 1.287, 0.0016, 65.39, 71603], [1535, 383, 1.280, 0.0017, 70.74, 79229],
    [1480, 370, 1.276, 0.0018, 74.54, 85348], [1440, 362, 1.273, 0.0018, 77.43, 89819]
  ].map((r, i) => ({ id: i, sheetRow: i + 2, p: r[0], Rs: r[1], Bo: r[2], Bg: r[3], Np: r[4] * 1e6, Gp: r[5] * 1e6 }));
  const prm = { pi: 2740, Boi: 1.404, Bgi: 0.0009, Rsi: 650, Swc: 0.05, Cw: 3e-6, Cf: 4e-6 };
  const r = E.analyze(q2rows, prm, {});
  close(r.results.N, REF.q2.N, 1e-12);
  close(r.results.m, REF.q2.m, 1e-12);
  close(r.results.G, REF.q2.G, 1e-12);
  close(r.fit.r2, REF.q2.r2, 1e-12);
  // the rounded example data give a negative slope and a poor fit: both are flagged
  assert.ok(r.messages.warnings.some(m => m.code === 'm-neg'));
  assert.ok(r.messages.warnings.some(m => m.code === 'r2'));
  const r2 = E.analyze(q2rows, prm, { includeEfw: false });
  close(r2.results.N, REF.q2NoEfw.N, 1e-12);
  close(r2.results.m, REF.q2NoEfw.m, 1e-12);

  const q1 = [[3300, 0, 0, 1.2511, 510, 0.00488505], [3150, 3.295, 3.460, 1.2353, 477, 0.00516580], [3000, 5.903, 6.257, 1.2222, 450, 0.00539040],
    [2850, 8.852, 10.268, 1.2122, 425, 0.00567115], [2700, 11.503, 14.206, 1.2022, 401, 0.00600805], [2550, 14.513, 18.359, 1.1922, 375, 0.00634495],
    [2400, 17.730, 23.049, 1.1822, 352, 0.00673800]].map((r, i) => ({ id: i, sheetRow: i + 3, p: r[0], Np: r[1] * 1e6, Gp: r[2] * 1e9, Bo: r[3], Rs: r[4], Bg: r[5] / 5.615 }));
  const q = E.analyze(q1, { pi: 3300, Boi: 1.2511, Bgi: 0.00488505 / 5.615, Rsi: 510, Swc: 0, Cw: 0, Cf: 0 }, {});
  close(q.results.N, REF.q1.N, 1e-12);
  close(q.results.m, REF.q1.m, 1e-12);
  close(q.results.G, REF.q1.G, 1e-12);
});

test('rounding check: the example data cannot pin down m', async () => {
  const { runFile, SAMPLES } = require('./helpers');
  const path = require('path');
  const r = await runFile(path.join(SAMPLES, 'havlena-odeh-example.xlsx'));
  const rc = r.result.rounding;
  assert.ok(rc && rc.trials >= 300);
  assert.ok(rc.m[0] < 0 && rc.m[2] > 0, 'the range of m crosses zero');
  const msg = r.result.messages.warnings.find(m => m.code === 'rounding');
  assert.ok(msg, 'rounding warning');
  assert.match(msg.text, /2,500 and 2,290 psia/);
  assert.match(msg.text, /N = 522\.6 MMSTB and m = 0\.005/);
  const neg = r.result.messages.warnings.find(m => m.code === 'm-neg');
  assert.match(neg.text, /N = 530\.2 MMSTB/);
  // the same numbers every time (seeded)
  const again = await runFile(path.join(SAMPLES, 'havlena-odeh-example.xlsx'));
  assert.deepEqual(again.result.rounding.m, rc.m);
});

test('rounding check stays quiet on precise data', async () => {
  const { runFile, SAMPLES } = require('./helpers');
  const path = require('path');
  const r = await runFile(path.join(SAMPLES, 'known_answer_N150_m040.xlsx'));
  assert.ok(![...r.result.messages.warnings, ...r.result.messages.infos].some(m => m.code === 'rounding'));
  const q1 = await runFile(path.join(SAMPLES, 'havlena-odeh-example-2.xlsx'));
  const info = q1.result.messages.infos.find(m => m.code === 'rounding');
  assert.ok(info, 'a mild note for the second example');
  assert.ok(!q1.result.messages.warnings.some(m => m.code === 'rounding'));
});

test('combination drive: W_e from a column gives back N and m', () => {
  const s = synthetic({ N: 120e6, m: 0.3, n: 10, K: 60000 });
  const r = E.analyze(s.rows, s.params, { aquifer: { mode: 'column' } });
  close(r.results.N, 120e6, 1e-9, 'N');
  close(r.results.m, 0.3, 1e-8, 'm');
  assert.ok(r.fit.r2 > 1 - 1e-12);
  for (const t of r.terms.filter(t => t.included)) {
    close(t.DDI + t.SDI + t.CDI + t.WDI, 1, 1e-9, 'drive indices with influx');
    assert.ok(t.WDI > 0);
  }
  // ignoring the influx spoils the line
  const none = E.analyze(s.rows, s.params, {});
  assert.ok(Math.abs(none.results.N - 120e6) > 1e6);
});

test('combination drive: the best pot-aquifer K is found by least squares', () => {
  const s = synthetic({ N: 120e6, m: 0.3, n: 10, K: 60000 });
  const rows = s.rows.map(r => Object.assign({}, r, { We: NaN }));
  const best = E.bestPotK(rows, s.params, {});
  close(best.K, 60000, 1e-6, 'K');
  close(best.N, 120e6, 1e-8, 'N');
  close(best.m, 0.3, 1e-7, 'm');
  assert.equal(best.negative, false);
  const r = E.analyze(rows, s.params, { aquifer: { mode: 'pot', K: best.K } });
  close(r.results.N, 120e6, 1e-6, 'N at best K');
  close(r.results.m, 0.3, 1e-5, 'm at best K');
  // data with no aquifer: the best K is zero, not negative
  const plain = synthetic({ N: 150e6, m: 0.4 });
  const b0 = E.bestPotK(plain.rows, plain.params, {});
  assert.ok(b0.K < 1, 'K is about zero: ' + b0.K);
});

test('combination drive: too large an aquifer is reported per point', () => {
  const s = synthetic({ N: 120e6, m: 0.3, n: 10 });
  const r = E.analyze(s.rows, s.params, { aquifer: { mode: 'pot', K: 1e9 } });
  assert.ok(r.terms.filter(t => t.Np > 0).every(t => t.reason === 'W_e is larger than F'));
  assert.equal(r.ok, false);
});
