'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { U } = require('./helpers');

test('parseNumberWithUnit reads plain numbers, units, percent and scientific notation', () => {
  const cases = [
    [2740, 2740, ''],
    ['2740', 2740, ''],
    ['2,740 psia', 2740, 'psia'],
    ['1,234.5', 1234.5, ''],
    ['1,5', 1.5, ''],
    ['4.00E-06 psi-1', 4e-6, 'psi-1'],
    ['4.00E−06 psi⁻¹', 4e-6, 'psi-1'],
    ['3.2 x 10-6', 3.2e-6, ''],
    ['4 × 10⁻⁶ psi⁻¹', 4e-6, 'psi-1'],
    ['3e-6 1/psi', 3e-6, '1/psi'],
    ['9.0E−04', 9e-4, ''],
    ['7.5E+3', 7500, ''],
    ['650 scf/STB', 650, 'scf/STB'],
    [' 0.05 ', 0.05, ''],
    ['-12.5', -12.5, '']
  ];
  for (const [input, value, unit] of cases) {
    const r = U.parseNumberWithUnit(input);
    assert.ok(r, 'parsed ' + JSON.stringify(input));
    assert.ok(Math.abs(r.value - value) <= Math.abs(value) * 1e-12, JSON.stringify(input) + ' -> ' + r.value);
    assert.equal(r.unit, unit, 'unit of ' + JSON.stringify(input));
  }
  const pct = U.parseNumberWithUnit('5%');
  assert.equal(pct.value, 0.05);
  assert.equal(pct.percent, true);
});

test('parseNumberWithUnit rejects text and pure units', () => {
  for (const v of ['1/psi', '10^-6/psi', '-', 'N/A', '', '   ', null, undefined, true, 'psia', 'Bo', NaN, Infinity]) {
    assert.equal(U.parseNumberWithUnit(v), null, JSON.stringify(v));
  }
});

test('detectUnit understands common spellings', () => {
  const cases = [
    ['pressure', 'psia', 'psia'], ['pressure', 'psi', 'psia'], ['pressure', 'psig', 'psig'], ['pressure', 'bar', 'bar'],
    ['pressure', 'kPa', 'kPa'], ['pressure', 'MPa', 'MPa'],
    ['oil', 'MMSTB', 'MMSTB'], ['oil', 'MM STB', 'MMSTB'], ['oil', 'MMbbl', 'MMSTB'], ['oil', 'MSTB', 'MSTB'], ['oil', 'STB', 'STB'],
    ['oil', 'bbl', 'STB'], ['oil', '10^6 STB', 'MMSTB'], ['oil', 'Sm3', 'Sm3'],
    ['gas', 'MMSCF', 'MMSCF'], ['gas', 'MMscf', 'MMSCF'], ['gas', 'MMMSCF', 'MMMSCF'], ['gas', 'Bscf', 'MMMSCF'], ['gas', 'MSCF', 'MSCF'],
    ['gas', 'Mcf', 'MSCF'], ['gas', 'SCF', 'SCF'], ['gas', 'Tcf', 'TSCF'], ['gas', 'Sm3', 'Sm3'],
    ['gor', 'SCF/STB', 'SCF/STB'], ['gor', 'scf/bbl', 'SCF/STB'], ['gor', 'Sm3/Sm3', 'Sm3/Sm3'], ['gor', 'Mscf/STB', 'MSCF/STB'],
    ['bg', 'rb/SCF', 'rb/SCF'], ['bg', 'bbl/scf', 'rb/SCF'], ['bg', 'cuft/SCF', 'ft3/SCF'], ['bg', 'ft3/scf', 'ft3/SCF'],
    ['bg', 'ft³/SCF', 'ft3/SCF'], ['bg', 'rb/MSCF', 'rb/MSCF'], ['bg', 'res bbl/scf', 'rb/SCF'], ['bg', 'rm3/Sm3', 'ft3/SCF'],
    ['comp', 'psi⁻¹', '1/psi'], ['comp', '1/psi', '1/psi'], ['comp', '10^-6 1/psi', '1e-6/psi'], ['comp', 'microsips', '1e-6/psi'],
    ['comp', '1/bar', '1/bar'],
    ['frac', '%', '%'], ['frac', 'fraction', 'fraction']
  ];
  for (const [kind, text, id] of cases) {
    const d = U.detectUnit(kind, text);
    assert.equal(d.matched, true, kind + ' ' + text);
    assert.equal(d.id, id, kind + ' ' + text);
  }
  assert.equal(U.detectUnit('pressure', 'furlongs').matched, false);
});

test('a Bg header that says "/STB" is read as per SCF and flagged', () => {
  const d = U.detectUnit('bg', 'rb/STB');
  assert.equal(d.id, 'rb/SCF');
  assert.match(d.note, /per SCF/);
});

test('every unit converts to base and back', () => {
  for (const kind of Object.keys(U.CATALOG)) {
    for (const u of U.CATALOG[kind]) {
      const v = 123.456;
      const back = U.fromBase(kind, u.id, U.toBase(kind, u.id, v));
      assert.ok(Math.abs(back - v) < 1e-9, kind + ' ' + u.id);
    }
  }
  assert.equal(U.toBase('pressure', 'psig', 0), 14.696);
  assert.ok(Math.abs(U.toBase('bg', 'ft3/SCF', 5.615) - 1) < 1e-12);
  assert.equal(U.toBase('gas', 'MMMSCF', 1), 1e9);
});

test('isUnitLike recognises units and not names', () => {
  for (const t of ['psia', 'MMSTB', 'MMSCF', 'rb/STB', 'cuft/SCF', 'SCF/STB', '1/psi', 'psi⁻¹', '%', 'fraction', 'Bscf', 'Mcf']) {
    assert.equal(U.isUnitLike(t), true, t);
  }
  for (const t of ['Pressure', 'Np', 'Initial pressure', 'Swc', 'Gas FVF']) {
    assert.equal(U.isUnitLike(t), false, t);
  }
});
