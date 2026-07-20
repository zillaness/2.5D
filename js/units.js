// Length parsing/formatting with mm ↔ inch support.
//
// parseLength accepts decimals ("12.7", ".5"), fractions ("1/2", "3/8"),
// mixed numbers ("1 1/2"), and unit suffixes (`"` or "in" for inches, "mm").
// A bare number is read in `displayUnit`. Always returns millimetres.

export function parseLength(input, displayUnit = 'mm') {
  let s = String(input).trim().toLowerCase();
  if (!s) return null;
  let unit = displayUnit;
  if (/["”]/.test(s) || /in(ch(es)?)?\s*\.?\s*$/.test(s)) unit = 'in';
  if (/mm\s*$/.test(s)) unit = 'mm';
  s = s.replace(/["”]/g, '').replace(/(inch(es)?|in|mm)\s*\.?\s*$/, '').trim();

  let val = null;
  let m = s.match(/^(-?\d+)\s+(\d+)\s*\/\s*(\d+)$/);       // mixed: 1 1/2
  if (m) {
    const whole = parseInt(m[1], 10);
    const frac = parseInt(m[2], 10) / parseInt(m[3], 10);
    val = whole < 0 ? whole - frac : whole + frac;
  } else if ((m = s.match(/^(-?\d+)\s*\/\s*(\d+)$/))) {     // fraction: 3/8
    val = parseInt(m[1], 10) / parseInt(m[2], 10);
  } else if (/^-?(\d+\.?\d*|\.\d+)$/.test(s)) {             // decimal
    val = parseFloat(s);
  }
  if (val === null || !isFinite(val)) return null;
  return unit === 'in' ? val * 25.4 : val;
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
