'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { P, FIX, SAMPLES, runFile, run, close, REF } = require('./helpers');

test('splitHeader separates names and units', () => {
  const cases = [
    ['Np (MMSTB)', 'Np', 'MMSTB'],
    ['Bg [cuft/SCF]', 'Bg', 'cuft/SCF'],
    ['Pressure, psia', 'Pressure', 'psia'],
    ['Gp in MMSCF', 'Gp', 'MMSCF'],
    ['Rs SCF/STB', 'Rs', 'SCF/STB'],
    ['Average Reservoir Pressure (psia)', 'Average Reservoir Pressure', 'psia'],
    ['Bo', 'Bo', '']
  ];
  for (const [raw, name, unit] of cases) {
    const h = P.splitHeader(raw);
    assert.equal(h.name, name, raw);
    assert.equal(h.unit, unit, raw);
  }
});

test('matchField maps many header spellings', () => {
  const cases = {
    p: ['P', 'p', 'Pressure', 'Pressure (psia)', 'Average reservoir pressure', 'Avg. Pressure', 'Pr', 'P avg'],
    Np: ['Np', 'NP (MMSTB)', 'Cumulative oil produced', 'Cum. Oil', 'Cum oil production', 'Oil produced'],
    Gp: ['Gp', 'Cumulative gas produced', 'Cum. Gas (MMscf)', 'Gas produced'],
    Rp: ['Rp', 'Cumulative GOR', 'Cum. GOR (scf/STB)'],
    Bo: ['Bo', 'Oil FVF', 'Oil formation volume factor', 'B_o'],
    Rs: ['Rs', 'Solution GOR', 'Solution gas-oil ratio', 'Rso'],
    Bg: ['Bg', 'Gas FVF', 'Gas formation volume factor (bbl/scf)', 'B_g']
  };
  for (const f of Object.keys(cases)) {
    for (const h of cases[f]) {
      const m = P.matchField(P.splitHeader(h));
      assert.ok(m, 'matched ' + h);
      assert.equal(m.field, f, h);
    }
  }
  for (const h of ['Date', 'Initial pressure', 'Oil rate', 'Water cut', 'Bubble point pressure']) {
    const m = P.matchField(P.splitHeader(h));
    assert.ok(!m || !['p', 'Np', 'Gp'].includes(m.field) || h === 'Water cut', 'no false match for ' + h);
  }
});

test('matchParam maps parameter labels', () => {
  const cases = {
    pi: ['pi', 'Pi (psia)', 'Initial pressure', 'Initial Pressure', 'Initial reservoir pressure, pi'],
    Boi: ['Boi', 'Initial oil FVF', 'Initial oil FVF, Boi'],
    Bgi: ['Bgi', 'Initial gas FVF, Bgi'],
    Rsi: ['Rsi', 'Initial solution GOR', 'Initial solution GOR, Rsi'],
    Swc: ['Swc', 'Swi', 'Connate water saturation', 'Sw'],
    Cw: ['Cw', 'Water compressibility', 'Water compressibility, Cw'],
    Cf: ['Cf', 'Formation compressibility', 'Rock compressibility', 'Pore compressibility'],
    phi: ['Porosity', 'phi', 'φ']
  };
  for (const k of Object.keys(cases)) {
    for (const h of cases[k]) {
      const m = P.matchParam(P.splitHeader(h));
      assert.ok(m, 'matched ' + h);
      assert.equal(m.field, k, h);
    }
  }
});

const SAME_AS_Q2 = [
  'q2_two_sheets.xlsx', 'q2_params_below_handout.xlsx', 'q2_params_right.xlsx', 'q2_title_units_row.xlsx',
  'q2_shuffled_long_headers.xlsx', 'q2_rp_column.xlsx', 'q2_no_boi_bgi_rsi.xlsx', 'q2_text_numbers_unicode.xlsx',
  'q2_percent_microsips.xlsx', 'q2_unsorted_rows.xlsx', 'q2_horizontal_params.xlsx', 'q2_inline_params.xlsx',
  'q2_no_units_field.xlsx', 'q2_si_units.xlsx', 'q2_libreoffice_saved.xlsx', 'q2_comma.csv', 'q2_semicolon_decimal_comma.csv'
];

for (const f of SAME_AS_Q2) {
  test('layout ' + f + ' gives the HW example answer', async () => {
    const r = await runFile(path.join(FIX, f));
    assert.deepEqual(r.analysis.errors, [], 'no parse errors');
    assert.equal(r.inputs.messages.errors.length, 0, 'no input errors');
    const R = r.result.results;
    assert.ok(R, 'has a result');
    close(R.N, REF.q2.N, 2e-6, 'N');
    close(R.m, REF.q2.m, 2e-5, 'm');
    close(R.G, REF.q2.G, 2e-5, 'G');
    assert.equal(r.result.fit.n, REF.q2.n);
    // parameters as in the handout
    close(r.inputs.params.pi, 2740, 1e-6, 'pi');
    close(r.inputs.params.Boi, 1.404, 1e-9, 'Boi');
    close(r.inputs.params.Bgi, 0.0009, 1e-6, 'Bgi');
    close(r.inputs.params.Rsi, 650, 1e-6, 'Rsi');
    close(r.inputs.params.Swc, 0.05, 1e-9, 'Swc');
    close(r.inputs.params.Cw, 3e-6, 1e-6, 'Cw');
    close(r.inputs.params.Cf, 4e-6, 1e-6, 'Cf');
  });
}

test('the HW 1 data in the handout layout (two-row header) gives the Q1 answer', async () => {
  for (const f of ['q1_two_row_header.xlsx', 'q1_simple.xlsx']) {
    const r = await runFile(path.join(FIX, f));
    assert.equal(r.analysis.production.headerSpan, f.startsWith('q1_two') ? 2 : 1, f);
    assert.equal(r.analysis.units.Bg, 'ft3/SCF');
    assert.equal(r.analysis.units.Gp, 'MMMSCF');
    const R = r.result.results;
    close(R.N, REF.q1.N, 1e-9, f + ' N');
    close(R.m, REF.q1.m, 1e-9, f + ' m');
    close(R.G, REF.q1.G, 1e-9, f + ' G');
    assert.equal(r.inputs.paramInfo.pi.source, 'derived');
    assert.equal(r.inputs.paramInfo.Boi.source, 'derived');
    assert.equal(r.inputs.paramInfo.Swc.source, 'default');
    assert.ok(r.inputs.messages.infos.some(m => m.code === 'efw-default'));
  }
});

test('handout layout: Boi, Bgi and Rsi come from the row at pi', async () => {
  const r = await runFile(path.join(FIX, 'q2_params_below_handout.xlsx'));
  assert.equal(r.inputs.paramInfo.pi.source, 'file');
  for (const k of ['Boi', 'Bgi', 'Rsi']) assert.equal(r.inputs.paramInfo[k].source, 'derived', k);
  assert.match(r.inputs.paramInfo.Boi.from, /2,740 psia/);
});

test('units: header units, inferred units and the Bg "/STB" typo', async () => {
  const a = (await runFile(path.join(FIX, 'q2_two_sheets.xlsx'))).analysis;
  assert.equal(a.units.Bg, 'rb/SCF');
  assert.equal(a.unitSource.Bg, 'header');
  assert.ok(a.infos.some(i => /per SCF/.test(i.text)));
  const b = (await runFile(path.join(FIX, 'q2_no_units_field.xlsx'))).analysis;
  assert.equal(b.units.Np, 'STB');
  assert.equal(b.units.Gp, 'SCF');
  assert.equal(b.units.Bg, 'ft3/SCF');
  assert.equal(b.unitSource.Bg, 'inferred');
});

test('percent saturation and microsip compressibility are converted', async () => {
  const r = await runFile(path.join(FIX, 'q2_percent_microsips.xlsx'));
  close(r.inputs.params.Swc, 0.05, 1e-12);
  close(r.inputs.params.Cw, 3e-6, 1e-12);
  close(r.inputs.params.Cf, 4e-6, 1e-12);
});

test('unsorted rows are sorted by cumulative oil, with a note', async () => {
  const r = await runFile(path.join(FIX, 'q2_unsorted_rows.xlsx'));
  const np = r.inputs.rows.map(x => x.Np);
  assert.deepEqual(np, np.slice().sort((x, y) => x - y));
  assert.ok(r.inputs.messages.infos.some(m => m.code === 'sorted'));
});

test('errors: no table, empty file, missing column, one point', async () => {
  let r = await runFile(path.join(FIX, 'err_no_table.xlsx'));
  assert.equal(r.analysis.errors[0].code, 'no-table');
  r = await runFile(path.join(FIX, 'err_empty.xlsx'));
  assert.equal(r.analysis.errors[0].code, 'no-table');
  r = await runFile(path.join(FIX, 'err_missing_bg.xlsx'));
  assert.equal(r.analysis.errors[0].code, 'missing-columns');
  assert.deepEqual(r.analysis.errors[0].fields, ['Bg']);
  assert.equal(r.analysis.warnings.filter(w => w.code === 'skipped').length, 0, 'no per-row noise for a missing column');
  r = await runFile(path.join(FIX, 'err_one_point.xlsx'));
  assert.equal(r.result.messages.errors[0].code, 'points');
  r = await runFile(path.join(SAMPLES, 'HW2_template.xlsx'));
  assert.equal(r.analysis.errors[0].code, 'no-rows');
});

test('a column picked by hand overrides the automatic match', async () => {
  const wb = await require('./helpers').readFile(path.join(FIX, 'q2_two_sheets.xlsx'));
  const auto = P.analyzeWorkbook(wb);
  const mapping = Object.assign({}, auto.production.mapping, { Bg: -1 });
  const broken = P.analyzeWorkbook(wb, { mapping });
  assert.equal(broken.errors[0].code, 'missing-columns');
  const fixed = run(wb, { overrides: { mapping: Object.assign({}, mapping, { Bg: auto.production.mapping.Bg }) } });
  close(fixed.result.results.N, REF.q2.N, 1e-9);
});

test('a unit picked by hand changes the conversion', async () => {
  const wb = await require('./helpers').readFile(path.join(FIX, 'q2_two_sheets.xlsx'));
  const base = run(wb);
  const asFt3 = run(wb, { overrides: { units: { Bg: 'ft3/SCF' } } });
  assert.equal(asFt3.analysis.units.Bg, 'ft3/SCF');
  assert.equal(asFt3.analysis.unitSource.Bg, 'user');
  close(asFt3.inputs.rows[1].Bg, base.inputs.rows[1].Bg / 5.615, 1e-12, 'Bg converted from ft3/SCF');
  // Bgi in the file says rb/SCF, so it is not converted: the mismatch shows up as a warning
  assert.ok(asFt3.inputs.messages.warnings.some(w => /5\.6/.test(w.text)));
  const gpScf = run(wb, { overrides: { units: { Gp: 'SCF' } } });
  close(gpScf.inputs.rows[1].Gp, 5988.8, 1e-12, 'Gp read as SCF');
});

test('edited parameters replace the file values', async () => {
  const wb = await require('./helpers').readFile(path.join(FIX, 'q2_two_sheets.xlsx'));
  const r = run(wb, { params: { Swc: 0, Cw: 0, Cf: 0 } });
  close(r.result.results.N, REF.q2NoEfw.N, 1e-9);
  assert.equal(r.inputs.paramInfo.Swc.source, 'user');
});

test('the known-answer sample gives N = 150 MMSTB and m = 0.40', async () => {
  const r = await runFile(path.join(SAMPLES, 'known_answer_N150_m040.xlsx'));
  close(r.result.results.N, 150e6, 5e-6);
  close(r.result.results.m, 0.40, 5e-5);
  assert.ok(r.result.fit.r2 > 0.999999);
});

test('synthetic fixtures give back the N and m they were built with', async () => {
  let r = await runFile(path.join(FIX, 'synthetic_N80_m025.xlsx'));
  close(r.result.results.N, 80e6, 1e-7);
  close(r.result.results.m, 0.25, 1e-6);
  r = await runFile(path.join(FIX, 'synthetic_large.xlsx'));
  assert.equal(r.result.fit.n, 399);
  close(r.result.results.N, 250e6, 1e-7);
  close(r.result.results.m, 0.6, 1e-6);
});
