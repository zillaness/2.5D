// Copyright (C) 2026 Projects and Mods
// GPL-3.0-or-later WITH Commons Clause (non-commercial) - see LICENSE.

// Length parsing/formatting with mm ↔ inch support.
//
// parseLength accepts decimals ("12.7", ".5"), fractions ("1/2", "3/8"),
// mixed numbers ("1 1/2"), and unit suffixes:
//   millimetres   mm
//   centimetres   cm
//   metres        m
//   inches        in / inch / inches / "
//   feet          ft / foot / feet / '
//   feet+inches   1' 6"  ·  1 ft 6 in  ·  1'6-1/2"
// A bare number is read in `displayUnit`. Always returns millimetres.

const MM_PER = { mm: 1, cm: 10, m: 1000, in: 25.4, ft: 304.8 };

// Parse a decimal / fraction / mixed-number token into a plain number.
function parseNumberToken(s) {
  s = s.trim();
  if (!s) return null;
  let m = s.match(/^(-?\d+)\s+(\d+)\s*\/\s*(\d+)$/);        // mixed: 1 1/2
  if (m) {
    const whole = parseInt(m[1], 10), frac = parseInt(m[2], 10) / parseInt(m[3], 10);
    return whole < 0 ? whole - frac : whole + frac;
  }
  if ((m = s.match(/^(-?\d+)\s*\/\s*(\d+)$/))) return parseInt(m[1], 10) / parseInt(m[2], 10);
  if (/^-?(\d+\.?\d*|\.\d+)$/.test(s)) return parseFloat(s);
  return null;
}

export function parseLength(input, displayUnit = 'mm') {
  let s = String(input).trim().toLowerCase();
  if (!s) return null;
  // Normalize smart quotes to " and '.
  s = s.replace(/[“”]/g, '"').replace(/[‘’]/g, "'");
  // Comma as a decimal separator (European), e.g. "12,7" → "12.7". Only
  // between digits, so list/thousands commas elsewhere are left alone.
  s = s.replace(/(\d),(\d)/g, '$1.$2');

  // Feet (with optional inches): 1' 6", 1ft, 1 ft 6 in, 1'6-1/2"
  const feet = s.match(/^(-?\d*\.?\d+)\s*(?:'|ft|feet|foot)/);
  if (feet) {
    const ft = parseFloat(feet[1]);
    let rest = s.slice(feet.index + feet[0].length)
      .replace(/["]|in(?:ch(?:es)?)?/g, ' ').replace(/[-]/g, ' ').trim();
    const inches = rest ? (parseNumberToken(rest) || 0) : 0;
    const sign = /^-/.test(s) ? -1 : 1;
    return sign * (Math.abs(ft) * 12 + inches) * 25.4;
  }

  // Single unit suffix (check cm / mm before bare m).
  let unit = displayUnit, body = s;
  if (/"$/.test(s) || /in(?:ch(?:es)?)?\.?$/.test(s)) {
    unit = 'in'; body = s.replace(/"|in(?:ch(?:es)?)?\.?$/, '');
  } else if (/cm\.?$/.test(s)) { unit = 'cm'; body = s.replace(/cm\.?$/, ''); }
  else if (/mm\.?$/.test(s)) { unit = 'mm'; body = s.replace(/mm\.?$/, ''); }
  else if (/m\.?$/.test(s)) { unit = 'm'; body = s.replace(/m\.?$/, ''); }

  const val = parseNumberToken(body);
  if (val === null || !isFinite(val)) return null;
  return val * MM_PER[unit];
}

// mm -> display string in the given unit (no suffix; fields label the unit).
export function formatLength(mm, unit = 'mm') {
  if (!isFinite(mm)) return '';
  if (unit === 'in') return String(Math.round((mm / 25.4) * 1000) / 1000);
  return String(Math.round(mm * 100) / 100);
}

// mm -> labelled display string for read-outs ("12.7 mm" / "0.5 in").
export function formatLengthLabelled(mm, unit = 'mm') {
  return `${formatLength(mm, unit)} ${unit === 'in' ? 'in' : 'mm'}`;
}
