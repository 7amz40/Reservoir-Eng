'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { X, FIX, bytes, readFile } = require('./helpers');

test('writeXlsx and readXlsx round-trip numbers, text, unicode and blanks', async () => {
  const rows = [
    ['p (psia)', 'Name <&> "quoted"', 'Unicode ⁻¹ × φ', 'flag'],
    [2740, 'a & b', 'B_g ft³/SCF', true],
    [1.5e-7, null, '', false],
    [-12.25, 'x', 'line\nbreak', null]
  ];
  const data = await X.writeXlsx([{ name: 'First', rows, headerRows: 1, colWidths: [12, 20] }, { name: 'Second: [x]', rows: [['k', 1]] }]);
  const wb = await X.readWorkbook(data, 'roundtrip.xlsx');
  assert.equal(wb.sheets.length, 2);
  assert.equal(wb.sheets[0].name, 'First');
  assert.match(wb.sheets[1].name, /^Second\s+x$/, 'invalid sheet-name characters are replaced');
  const r = wb.sheets[0].rows;
  assert.equal(r[0][1], 'Name <&> "quoted"');
  assert.equal(r[0][2], 'Unicode ⁻¹ × φ');
  assert.equal(r[1][0], 2740);
  assert.equal(r[1][3], true);
  assert.equal(r[2][0], 1.5e-7);
  assert.equal(r[2][1], null);
  assert.equal(r[3][2], 'line\nbreak');
});

test('reads workbooks written by openpyxl and by LibreOffice', async () => {
  for (const f of ['q2_two_sheets.xlsx', 'q2_libreoffice_saved.xlsx']) {
    const wb = await readFile(path.join(FIX, f));
    assert.equal(wb.format, 'xlsx', f);
    const prod = wb.sheets.find(s => s.rows.some(r => r && r.some(c => /Np/.test(String(c)))));
    assert.ok(prod, f + ' has the production table');
    const row = prod.rows.find(r => r && r[0] === 2500);
    assert.ok(row, f + ' has the 2500 psia row');
  }
});

test('parseCSV handles delimiters, quotes, decimal commas and a BOM', () => {
  assert.deepEqual(X.parseCSV('a,b\n1,2\n'), [['a', 'b'], [1, 2]]);
  assert.deepEqual(X.parseCSV('﻿a;b\n1,5;2\n'), [['a', 'b'], [1.5, 2]]);
  assert.deepEqual(X.parseCSV('a\tb\n3\t4'), [['a', 'b'], [3, 4]]);
  assert.deepEqual(X.parseCSV('"x, y","say ""hi"""\n"multi\nline",7'), [['x, y', 'say "hi"'], ['multi\nline', 7]]);
});

test('reads both CSV fixtures', async () => {
  for (const f of ['q2_comma.csv', 'q2_semicolon_decimal_comma.csv']) {
    const wb = await readFile(path.join(FIX, f));
    assert.equal(wb.format, 'csv');
    assert.equal(wb.sheets.length, 1);
    const row = wb.sheets[0].rows.find(r => r && r[0] === 2500);
    assert.ok(row, f);
    assert.equal(row[4], 7.88, f + ' decimal handling');
  }
});

test('gives clear messages for files it cannot read', async () => {
  const expect = async (file, re) => {
    await assert.rejects(readFile(path.join(FIX, file)), (err) => {
      assert.equal(err.userFacing, true, file + ' error is user facing');
      assert.match(err.message, re, file);
      return true;
    });
  };
  await expect('q2_legacy.xls', /97–2003/);
  await expect('q2_open_document.ods', /OpenDocument/);
  await expect('err_not_a_workbook.xlsx', /could not be opened/);
  await assert.rejects(X.readWorkbook(new Uint8Array([0, 1, 2, 3, 0, 0, 7, 8]).buffer, 'blob.bin'), /not a spreadsheet/);
  await assert.rejects(X.readWorkbook(new Uint8Array([]).buffer, 'empty.csv'), /empty/);
  // an encrypted .xlsx is an OLE file with an .xlsx name
  const ole = new Uint8Array(64); ole.set([0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1]);
  await assert.rejects(X.readWorkbook(ole.buffer, 'locked.xlsx'), /password/);
});

test('toCSV quotes fields that need it', () => {
  assert.equal(X.toCSV([['a', 'b,c', 'say "x"'], [1, null, 'line\nbreak']]), 'a,"b,c","say ""x"""\r\n1,,"line\nbreak"');
});

test('a large workbook reads quickly', async () => {
  const t0 = Date.now();
  const wb = await readFile(path.join(FIX, 'synthetic_large.xlsx'));
  assert.ok(wb.sheets[0].rows.length > 400);
  assert.ok(Date.now() - t0 < 3000, 'read in under 3 s');
  void bytes;
});
