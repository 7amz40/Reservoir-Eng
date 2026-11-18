/* Shared helpers for the Node tests. */
'use strict';
const fs = require('fs');
const path = require('path');

// JSZip: the vendored build in assets/vendor works in Node too, so no install is needed.
function loadJSZip() {
  return require(path.join(__dirname, '..', 'assets', 'vendor', 'jszip.v3.10.1.min.js'));
}
global.JSZip = loadJSZip();

const U = require('../assets/js/units.js');
const X = require('../assets/js/xlsxio.js');
const P = require('../assets/js/parser.js');
const E = require('../assets/js/mbe.js');

const FIX = path.join(__dirname, 'fixtures');
const SAMPLES = path.join(__dirname, '..', 'samples');

function bytes(file) {
  const buf = fs.readFileSync(file);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

async function readFile(file) {
  return X.readWorkbook(bytes(file), path.basename(file));
}

/** Full pipeline: workbook -> analysis -> inputs -> result. */
function run(wb, opts) {
  opts = opts || {};
  const analysis = P.analyzeWorkbook(wb, opts.overrides || {});
  const out = { analysis };
  if (analysis.errors.some(e => ['no-table', 'missing-columns', 'no-rows', 'empty'].includes(e.code))) return out;
  out.inputs = P.buildInputs(analysis, { params: opts.params || {} });
  out.result = E.analyze(out.inputs.rows, out.inputs.params, { includeEfw: opts.includeEfw !== false, excluded: opts.excluded || [], precision: out.inputs.precision });
  return out;
}

async function runFile(file, opts) { return run(await readFile(file), opts); }

/** Exact gas-cap reservoir data from the MBE (same model as tests/make_fixtures.py). */
function synthetic({ N = 150e6, m = 0.4, swc = 0.2, cw = 3e-6, cf = 5e-6, n = 9, pressures = null, K = 0 } = {}) {
  const pi = 3000, T = 640;
  const z = p => 0.80 + 0.06 * Math.pow(p / 3000 - 0.5, 2) + 0.02 * (1 - p / 3000);
  const bg = p => 0.00504 * z(p) * T / p;
  const rs = p => 600 - 0.19 * (pi - p) - 1.5e-5 * Math.pow(pi - p, 2);
  const bo = p => 1.30 - 1.1e-4 * (pi - p) - 6e-9 * Math.pow(pi - p, 2);
  const boi = bo(pi), bgi = bg(pi), rsi = rs(pi);
  const ps = pressures || Array.from({ length: n - 1 }, (_, i) => pi - 160 * (i + 1) - 6 * (i + 1) * (i + 1));
  const rows = [{ p: pi, Np: 0, Gp: 0, Bo: boi, Rs: rsi, Bg: bgi, We: 0 }];
  for (const p of ps) {
    const Bo = bo(p), Rs = rs(p), Bg = bg(p), dp = pi - p;
    const eo = (Bo - boi) + (rsi - Rs) * Bg;
    const eg = boi * (Bg / bgi - 1);
    const efw = boi * (cw * swc + cf) * dp / (1 - swc);
    const We = K * dp;
    const F = N * (eo + m * eg + (1 + m) * efw) + We;
    const Np = N * (6e-5 * dp + 1e-8 * dp * dp);
    const Rp = (F / Np - Bo) / Bg + Rs;
    rows.push({ p, Np, Gp: Rp * Np, Bo, Rs, Bg, We });
  }
  return { rows: rows.map((r, i) => Object.assign({ id: i, sheetRow: i + 2, Wp: 0, Bw: 1 }, r)), params: { pi, Boi: boi, Bgi: bgi, Rsi: rsi, Swc: swc, Cw: cw, Cf: cf } };
}

/** Relative closeness check. */
function close(actual, expected, rel, msg) {
  const tol = Math.abs(expected) * rel + 1e-12;
  if (!(Math.abs(actual - expected) <= tol)) {
    throw new Error((msg || 'value') + ': expected ' + expected + ' got ' + actual + ' (rel tol ' + rel + ')');
  }
}

// Reference answers
const REF = {
  q2: { N: 729.8677949061476e6, m: -0.06984561928929446, G: -79.52578628986935e9, r2: 0.6131771326122093, n: 10 },
  q2NoEfw: { N: 705.3051039910318e6, m: -0.057057843918046344 },
  q1: { N: 108.6467008239402e6, m: 0.541600632076894, G: 84.61911463582445e9, r2: 0.9677502298016208, n: 6 }
};

module.exports = { U, X, P, E, FIX, SAMPLES, bytes, readFile, run, runFile, synthetic, close, REF };
