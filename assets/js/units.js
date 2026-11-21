/*
 * units.js
 * Number parsing and unit handling for the Havlena–Odeh Analyzer.
 * Works in the browser (global HOUnits) and in Node (module.exports).
 *
 * Base units used by the calculation engine:
 *   pressure  psia          oil volume  STB          gas volume  SCF
 *   GOR       SCF/STB       Bo, Bw      rb/STB       Bg          rb/SCF
 *   compressibility 1/psi   saturation, porosity  fraction
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.HOUnits = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var FT3_PER_BBL = 5.615;

  /* ---------- text clean-up ---------- */

  function cleanText(s) {
    if (s === null || s === undefined) return '';
    var t = String(s);
    try { t = t.normalize('NFKC'); } catch (e) { /* old engines */ }
    return t
      .replace(/[−‐-―﹣－]/g, '-')   // unicode minus and dashes
      .replace(/[    ]/g, ' ')           // non-breaking and thin spaces
      .replace(/[×✕⨯]/g, 'x')                  // multiplication signs
      .replace(/\s+/g, ' ')
      .trim();
  }

  /* ---------- numbers ---------- */

  var NUM_RE = /^([-+]?(?:\d[\d,]*(?:\.\d*)?|\.\d+))(?:\s*e\s*([-+]?\d+))?(?:\s*(?:x|\*)\s*10\s*(?:\^|\*\*)?\s*\(?\s*([-+]?\d+)\s*\)?)?\s*(%)?\s*(.*)$/i;

  /**
   * Parse a cell value that should hold a number, possibly with a unit:
   *   2740 | "2740 psia" | "4.00E−06 psi⁻¹" | "3.2 x 10-6" | "5%" | "1,234.5"
   * Returns {value, unit, percent} or null when there is no number.
   */
  function parseNumberWithUnit(v) {
    if (typeof v === 'number') return isFinite(v) ? { value: v, unit: '', percent: false } : null;
    if (v === null || v === undefined || typeof v === 'boolean') return null;
    var s = cleanText(v);
    if (!s) return null;
    var m = s.match(NUM_RE);
    if (!m) return null;
    var numStr = m[1];
    if (numStr.indexOf(',') >= 0) {
      if (numStr.indexOf('.') >= 0) numStr = numStr.replace(/,/g, '');           // 1,234.5
      else if (/^[-+]?\d{1,3}(,\d{3})+$/.test(numStr)) numStr = numStr.replace(/,/g, ''); // 12,345
      else numStr = numStr.replace(',', '.');                                    // 1,5 (decimal comma)
    }
    var value = parseFloat(numStr);
    if (!isFinite(value)) return null;
    if (m[2]) value *= Math.pow(10, parseInt(m[2], 10));
    if (m[3]) value *= Math.pow(10, parseInt(m[3], 10));
    var percent = !!m[4];
    if (percent) value /= 100;
    var unit = (m[5] || '').trim();
    // "1/psi" or "10^-6 1/psi" are units, not numbers
    if (/^[\/\^]/.test(unit) && (Math.abs(value - 1) < 1e-12 || unit.charAt(0) === '^') && !/\s/.test(s.slice(m[1].length, m[1].length + 1))) return null;
    // Reject things like "12abc" that are really text, but keep units such as "psia" or "1/psi"
    if (unit && /^[0-9]/.test(unit) && !isUnitLike(unit)) return null;
    return { value: value, unit: unit, percent: percent };
  }

  function parseNumber(v) {
    var r = parseNumberWithUnit(v);
    return r ? r.value : NaN;
  }

  /* ---------- unit catalog ---------- */

  // base = value * factor + offset
  var CATALOG = {
    pressure: [
      { id: 'psia', label: 'psia', factor: 1 },
      { id: 'psig', label: 'psig', factor: 1, offset: 14.696 },
      { id: 'bar', label: 'bar', factor: 14.5038 },
      { id: 'kPa', label: 'kPa', factor: 0.1450377 },
      { id: 'MPa', label: 'MPa', factor: 145.0377 },
      { id: 'atm', label: 'atm', factor: 14.696 }
    ],
    oil: [
      { id: 'STB', label: 'STB', factor: 1 },
      { id: 'MSTB', label: 'MSTB', factor: 1e3 },
      { id: 'MMSTB', label: 'MMSTB', factor: 1e6 },
      { id: 'Sm3', label: 'Sm³', factor: 6.28981 }
    ],
    gas: [
      { id: 'SCF', label: 'SCF', factor: 1 },
      { id: 'MSCF', label: 'MSCF', factor: 1e3 },
      { id: 'MMSCF', label: 'MMSCF', factor: 1e6 },
      { id: 'MMMSCF', label: 'MMMSCF (Bscf)', factor: 1e9 },
      { id: 'TSCF', label: 'TSCF', factor: 1e12 },
      { id: 'Sm3', label: 'Sm³', factor: 35.3147 }
    ],
    gor: [
      { id: 'SCF/STB', label: 'SCF/STB', factor: 1 },
      { id: 'MSCF/STB', label: 'MSCF/STB', factor: 1e3 },
      { id: 'Sm3/Sm3', label: 'Sm³/Sm³', factor: 5.6146 }
    ],
    bo: [
      { id: 'rb/STB', label: 'rb/STB', factor: 1 }
    ],
    bg: [
      { id: 'rb/SCF', label: 'rb/SCF', factor: 1 },
      { id: 'ft3/SCF', label: 'ft³/SCF', factor: 1 / FT3_PER_BBL },
      { id: 'rb/MSCF', label: 'rb/MSCF', factor: 1e-3 },
      { id: 'ft3/MSCF', label: 'ft³/MSCF', factor: 1e-3 / FT3_PER_BBL }
    ],
    bw: [
      { id: 'rb/STB', label: 'rb/STB', factor: 1 }
    ],
    rvol: [
      { id: 'rb', label: 'rb', factor: 1 },
      { id: 'Mrb', label: 'Mrb', factor: 1e3 },
      { id: 'MMrb', label: 'MMrb', factor: 1e6 },
      { id: 'rm3', label: 'rm³', factor: 6.28981 }
    ],
    comp: [
      { id: '1/psi', label: 'psi⁻¹', factor: 1 },
      { id: '1e-6/psi', label: '10⁻⁶ psi⁻¹', factor: 1e-6 },
      { id: '1/bar', label: 'bar⁻¹', factor: 1 / 14.5038 },
      { id: '1/kPa', label: 'kPa⁻¹', factor: 1 / 0.1450377 }
    ],
    frac: [
      { id: 'fraction', label: 'fraction', factor: 1 },
      { id: '%', label: '%', factor: 0.01 }
    ],
    ratio: [
      { id: '-', label: '–', factor: 1 }
    ],
    time: [
      { id: 'year', label: 'years', factor: 365.25 },
      { id: 'month', label: 'months', factor: 30.4375 },
      { id: 'day', label: 'days', factor: 1 },
      { id: 'hour', label: 'hours', factor: 1 / 24 }
    ]
  };

  var DEFAULTS = {
    pressure: 'psia', oil: 'MMSTB', gas: 'MMSCF', gor: 'SCF/STB',
    bo: 'rb/STB', bg: 'rb/SCF', bw: 'rb/STB', rvol: 'MMrb', comp: '1/psi', frac: 'fraction', ratio: '-', time: 'year'
  };

  function listUnits(kind) { return (CATALOG[kind] || []).slice(); }

  function getUnit(kind, id) {
    var list = CATALOG[kind] || [];
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }

  function label(kind, id) {
    var u = getUnit(kind, id);
    return u ? u.label : (id || '');
  }

  function toBase(kind, id, value) {
    if (!isFinite(value)) return NaN;
    var u = getUnit(kind, id) || getUnit(kind, DEFAULTS[kind]);
    if (!u) return value;
    return value * u.factor + (u.offset || 0);
  }

  function fromBase(kind, id, value) {
    if (!isFinite(value)) return NaN;
    var u = getUnit(kind, id) || getUnit(kind, DEFAULTS[kind]);
    if (!u) return value;
    return (value - (u.offset || 0)) / u.factor;
  }

  /* ---------- unit detection from header / cell text ---------- */

  function unitKey(text) {
    return cleanText(text).toLowerCase()
      .replace(/cubic\s*f(ee|oo)?t|cu\.?\s*ft\.?|ft\^?\s*3|rcf\b/g, 'ft3')
      .replace(/res(ervoir)?\.?\s*bbls?|r\.?\s*bbls?|rbbls?/g, 'rb')
      .replace(/[\s_.()\[\]{}]/g, '')
      .replace(/\*\*/g, '^');
  }

  function has(key, parts) {
    for (var i = 0; i < parts.length; i++) if (key.indexOf(parts[i]) >= 0) return true;
    return false;
  }

  /**
   * Detect a unit of the given kind from free text such as "MMSTB", "(cuft/SCF)", "psi⁻¹".
   * Returns {id, matched, note}. When nothing is recognised, matched is false and id is the default.
   */
  function detectUnit(kind, text) {
    var raw = cleanText(text);
    var k = unitKey(raw);
    var res = function (id, note) { return { id: id, matched: true, note: note || '' }; };
    if (!k) return { id: DEFAULTS[kind], matched: false, note: '' };

    switch (kind) {
      case 'pressure':
        if (has(k, ['psig'])) return res('psig');
        if (has(k, ['psi', 'lbf/in', 'lb/in'])) return res('psia');
        if (has(k, ['mpa'])) return res('MPa');
        if (has(k, ['kpa'])) return res('kPa');
        if (has(k, ['bar'])) return res('bar');
        if (has(k, ['atm'])) return res('atm');
        break;
      case 'oil':
        if (has(k, ['mmstb', 'mmbbl', 'mmbl', 'mmbo', '10^6', '1e6', 'million'])) return res('MMSTB');
        if (has(k, ['mstb', 'mbbl', 'mbo', '10^3', '1e3', 'thousand'])) return res('MSTB');
        if (has(k, ['sm3', 'm3'])) return res('Sm3');
        if (has(k, ['stb', 'bbl', 'bo', 'barrel'])) return res('STB');
        break;
      case 'gas':
        if (has(k, ['tscf', 'tcf', '10^12', 'trillion'])) return res('TSCF');
        if (has(k, ['mmmscf', 'mmmcf', 'bscf', 'bcf', '10^9', '1e9', 'billion'])) return res('MMMSCF');
        if (has(k, ['mmscf', 'mmcf', '10^6', '1e6', 'million'])) return res('MMSCF');
        if (has(k, ['mscf', 'mcf', '10^3', '1e3', 'thousand'])) return res('MSCF');
        if (has(k, ['sm3', 'm3'])) return res('Sm3');
        if (has(k, ['scf', 'cf', 'ft3'])) return res('SCF');
        break;
      case 'gor':
        if (has(k, ['m3/m3', 'sm3/sm3'])) return res('Sm3/Sm3');
        if (has(k, ['mscf/stb', 'mcf/stb', 'mscf/bbl', 'mcf/bbl'])) return res('MSCF/STB');
        if (has(k, ['scf/stb', 'scf/bbl', 'cf/stb', 'ft3/stb', 'scf/b', 'scf'])) return res('SCF/STB');
        break;
      case 'bo':
      case 'bw':
        if (has(k, ['rb/stb', 'bbl/stb', 'rb/bbl', 'bbl/bbl', 'm3/m3', 'rm3/sm3', 'rb', 'bbl', 'stb'])) return res('rb/STB');
        break;
      case 'bg': {
        var slash = k.indexOf('/');
        var num = slash >= 0 ? k.slice(0, slash) : k;
        var den = slash >= 0 ? k.slice(slash + 1) : '';
        if (has(k, ['rm3/sm3', 'm3/m3', 'm3/sm3'])) return res('ft3/SCF', 'rm³/Sm³ is the same ratio as ft³/SCF');
        var perM = has(den, ['mscf', 'mcf']);
        var isFt3 = has(num, ['ft3', 'cf']);
        var isRb = has(num, ['rb', 'bbl', 'res']);
        var typo = has(den, ['stb']);
        if (isFt3) return res(perM ? 'ft3/MSCF' : 'ft3/SCF', typo ? 'gas FVF is per SCF; "/STB" read as "/SCF"' : '');
        if (isRb) return res(perM ? 'rb/MSCF' : 'rb/SCF', typo ? 'gas FVF is per SCF; "/STB" read as "/SCF"' : '');
        break;
      }
      case 'rvol':
        if (has(k, ['mmrb', 'mmbbl', 'mmrbbl', '10^6', '1e6', 'million'])) return res('MMrb');
        if (has(k, ['mrb', 'mbbl', '10^3', '1e3', 'thousand'])) return res('Mrb');
        if (has(k, ['rm3', 'm3'])) return res('rm3');
        if (has(k, ['rb', 'bbl', 'barrel'])) return res('rb');
        break;
      case 'comp':
        if (has(k, ['10-6', '10^-6', '1e-6', 'e-6', 'microsip', 'μsip', 'µsip'])) return res('1e-6/psi');
        if (has(k, ['kpa'])) return res('1/kPa');
        if (has(k, ['bar'])) return res('1/bar');
        if (has(k, ['psi', '1/p'])) return res('1/psi');
        break;
      case 'time':
        if (/^(°|deg|º)|^(f|r|c|k)$|fahrenheit|rankine|celsius|kelvin/.test(k)) break; // a temperature, not a time
        if (has(k, ['hour', 'hr', '^h$'])) return res('hour');
        if (has(k, ['month', 'mo', 'mth'])) return res('month');
        if (has(k, ['day', 'date']) || k === 'd') return res('day');
        if (has(k, ['year', 'yr', 'yrs', 'annum']) || k === 'y' || k === 'a') return res('year');
        break;
      case 'frac':
        if (has(k, ['%', 'percent', 'pct'])) return res('%');
        if (has(k, ['frac', 'v/v', 'dimensionless', '-'])) return res('fraction');
        break;
      default:
        break;
    }
    return { id: DEFAULTS[kind], matched: false, note: '' };
  }

  /** Quick test used when splitting headers: does this text look like a unit? */
  function isUnitLike(text) {
    var k = unitKey(text);
    if (!k || k.length > 24) return false;
    if (/^(psi[ag]?|bar|kpa|mpa|atm|%|percent|fraction|frac|v\/v|-)$/.test(k)) return true;
    if (/^(years?|yrs?|months?|days?|hours?|hrs?|d|y|mo)$/.test(k)) return true;
    if (/^(m{0,3}|t|b)?(stb|scf|bbl|rb|cf|bo|mcf|scm|sm3|m3|rm3)$/.test(k)) return true;
    if (/^(rb|bbl|ft3|cf|m3|rm3|scf|mscf|mcf|sm3)\/(stb|scf|bbl|mscf|mcf|sm3|m3)$/.test(k)) return true;
    if (/^(1\/psi|psi-1|psi\^-1|\/psi|1\/bar|bar-1|1\/kpa)$/.test(k)) return true;
    if (/^10\^?-?\d+(\/psi|psi-1|stb|scf)?$/.test(k)) return true;
    return false;
  }

  /* ---------- formatting ---------- */

  function fmt(v, digits) {
    if (!isFinite(v)) return '–';
    var d = digits === undefined ? 3 : digits;
    return Number(v).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
  }

  /** Compact scientific notation using Unicode superscripts: 8.46 × 10¹⁰ */
  function fmtSci(v, sig) {
    if (!isFinite(v)) return '–';
    if (v === 0) return '0';
    var s = sig || 3;
    var exp = Math.floor(Math.log10(Math.abs(v)));
    var mant = v / Math.pow(10, exp);
    if (Math.abs(mant) >= 9.9995 && s <= 4) { mant /= 10; exp += 1; }
    var sup = String(exp).replace(/-/g, '⁻').replace(/[0-9]/g, function (d) { return '⁰¹²³⁴⁵⁶⁷⁸⁹'[+d]; });
    return mant.toFixed(Math.max(0, s - 1)) + ' × 10' + sup;
  }

  /** Smart number: plain decimals for normal magnitudes, scientific for very small/large. */
  function fmtAuto(v, sig) {
    if (!isFinite(v)) return '–';
    var a = Math.abs(v);
    var s = sig || 4;
    if (a !== 0 && (a < 1e-3 || a >= 1e7)) return fmtSci(v, s);
    var d = a === 0 ? 0 : Math.max(0, s - 1 - Math.floor(Math.log10(a)));
    return fmt(v, Math.min(d, 6));
  }

  return {
    FT3_PER_BBL: FT3_PER_BBL,
    cleanText: cleanText,
    parseNumber: parseNumber,
    parseNumberWithUnit: parseNumberWithUnit,
    CATALOG: CATALOG,
    DEFAULTS: DEFAULTS,
    listUnits: listUnits,
    getUnit: getUnit,
    label: label,
    toBase: toBase,
    fromBase: fromBase,
    detectUnit: detectUnit,
    isUnitLike: isUnitLike,
    unitKey: unitKey,
    fmt: fmt,
    fmtSci: fmtSci,
    fmtAuto: fmtAuto
  };
});
