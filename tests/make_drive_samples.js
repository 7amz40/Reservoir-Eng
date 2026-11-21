// Writes one sample workbook per drive mechanism into samples/, from exact material-balance data.
// The values keep enough decimals for the dashboard to give back the answers used to build them
// (in the file names and in README.md); the HW example shows what textbook rounding does.
// Run: node tests/make_drive_samples.js
const fs = require('fs');
const path = require('path');
const { X, synthetic } = require('./helpers');

const OUT = path.join(__dirname, '..', 'samples');
const r = (v, d) => Number(v.toFixed(d));

function book({ s, time = false, gas = true, wp = false }) {
  const head = (time ? ['t (years)'] : []).concat(['p (psia)', 'Np (MMSTB)'], gas ? ['Gp (MMSCF)'] : [], ['Bo (rb/STB)'], gas ? ['Rs (SCF/STB)', 'Bg (rb/SCF)'] : [], wp ? ['Wp (MMSTB)'] : []);
  const rows = [head].concat(s.rows.map((x, i) => (time ? [r(x.t / 365.25, 4)] : []).concat(
    [r(x.p, 1), r(x.Np / 1e6, 6)], gas ? [r(x.Gp / 1e6, 4)] : [], [r(x.Bo, 6)], gas ? [r(x.Rs, 3), r(x.Bg, 9)] : [], wp ? [0] : [])));
  const P = s.params;
  const init = [['Property', 'Value', 'Unit'],
    ['Initial pressure, pi', P.pi, 'psia'],
    ['Initial oil FVF, Boi', r(P.Boi, 6), 'rb/STB']]
    .concat(gas ? [['Initial gas FVF, Bgi', r(P.Bgi, 9), 'rb/SCF'], ['Initial solution GOR, Rsi', r(P.Rsi, 3), 'SCF/STB']] : [])
    .concat([['Connate water saturation, Swc', P.Swc, 'fraction'], ['Water compressibility, Cw', P.Cw, '1/psi'], ['Formation compressibility, Cf', P.Cf, '1/psi']]);
  return [
    { name: 'Production', headerRows: 1, colWidths: head.map(() => 13), rows },
    { name: 'Initial', headerRows: 1, colWidths: [32, 14, 12], rows: init }
  ];
}

const SAMPLES = [
  ['drive_depletion_N150.xlsx', book({ s: synthetic({ m: 0, n: 10 }) })],
  ['drive_water_unsteady_N150.xlsx', book({ s: synthetic({ m: 0, n: 11, veh: { U: 9000, reD: 5, a: 0.8 / 365.25 } }), time: true })],
  ['drive_gascap_water_N150_m030.xlsx', book({ s: synthetic({ m: 0.3, K: 30000, n: 12 }) })],
  ['drive_undersaturated_N150.xlsx', book({ s: synthetic({ m: 0, n: 8, undersaturated: true }), gas: false })]
];

(async () => {
  for (const [name, sheets] of SAMPLES) {
    const bytes = await X.writeXlsx(sheets);
    fs.writeFileSync(path.join(OUT, name), Buffer.from(bytes));
    console.log('wrote samples/' + name);
  }
})();
