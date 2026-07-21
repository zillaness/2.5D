// Read a PDF drawing's title block and dimension text to set true scale.
//
// A vector PDF's geometry has a native size in points, but a CAD drawing is
// usually printed at a scale (SCALE 1:2) so the printed size ≠ the real part.
// We read the units and scale note from the title block, then find the
// dimension number that labels the view's overall size and derive the true
// scale from it — cross-checking the scale note and, on disagreement, trusting
// the printed dimension (the label is authoritative; export scale is flaky).
//
// This is the reliable "overall-size" calibration; per-edge dimension→span
// pairing is a later refinement. The result is always shown for confirmation.

// Parse a leading number: decimal, fraction, or mixed (ignores tolerances).
export function parseNumberLoose(s) {
  s = String(s).trim().replace(/^[⌀ØΦϕR=\s]+/i, '');
  let m = s.match(/^(\d+)\s+(\d+)\/(\d+)/); // mixed 1 1/2
  if (m) return +m[1] + (+m[2]) / (+m[3]);
  m = s.match(/^(\d+)\/(\d+)/);             // fraction 1/2
  if (m) return (+m[1]) / (+m[2]);
  m = s.match(/^(\d+(?:\.\d+)?|\.\d+)/);     // decimal
  return m ? parseFloat(m[1]) : null;
}

// Units, scale note, and a part name from the page's text items.
export function readTitleBlock(texts) {
  const joined = texts.map(t => t.str).join('  ');
  let units = null;
  if (/\bMILLIMET|\bMM\b/i.test(joined)) units = 'mm';
  else if (/\bINCH|\bINCHES\b|\bIN\.\b|UNITS?\s*[:=]?\s*IN\b/i.test(joined)) units = 'in';

  let scaleNote = null;
  const m = joined.match(/SCALE\s*[:=]?\s*(\d+(?:\.\d+)?)\s*[:/]\s*(\d+(?:\.\d+)?)/i);
  if (m) scaleNote = { drawn: parseFloat(m[1]), real: parseFloat(m[2]) };

  let name = null;
  const nm = joined.match(/(?:TITLE|PART\s*(?:NO\.?|NAME|#)?|DWG\.?\s*NO\.?)\s*[:.\-]?\s*([A-Za-z0-9][A-Za-z0-9 _.\-]{1,38})/i);
  if (nm) name = nm[1].trim().replace(/\s{2,}.*$/, '');

  return { units, scaleNote, name };
}

// Suggest the view's true overall width (mm) from the dimension text.
// Returns { realWidthMm, dim, note, conflict }.
export function suggestScale(view, texts, tb) {
  const printedW = view.w; // mm from points
  const factor = tb.scaleNote ? tb.scaleNote.real / tb.scaleNote.drawn : 1;
  const expected = printedW * factor;

  const cands = [];
  for (const t of texts) {
    const s = t.str.trim();
    if (/^[⌀ØΦϕR]/.test(s)) continue;          // diameter/radius — not an overall linear dim
    const val = parseNumberLoose(s);
    if (val == null || val <= 0) continue;
    const mm = tb.units === 'in' ? val * 25.4 : val; // unknown units → assume the number is mm
    cands.push({ str: s, mm });
  }
  let best = null, bestErr = Infinity;
  for (const c of cands) {
    const err = Math.abs(c.mm - expected) / (expected || 1);
    if (err < bestErr) { bestErr = err; best = c; }
  }
  if (best && bestErr < 0.25) {
    const trueScale = best.mm / printedW;
    const conflict = tb.scaleNote != null && Math.abs(trueScale - factor) > 0.1 * factor;
    const unitTxt = tb.units || 'mm?';
    return {
      realWidthMm: best.mm, dim: best.str,
      note: `read from drawing — overall width ${best.str} ${unitTxt}` +
            (tb.scaleNote ? `, scale ${tb.scaleNote.drawn}:${tb.scaleNote.real}` : '') +
            (conflict ? ' (dimension overrides the scale note)' : ''),
      conflict,
    };
  }
  return {
    realWidthMm: expected, dim: null,
    note: tb.scaleNote
      ? `scale ${tb.scaleNote.drawn}:${tb.scaleNote.real} from title block — confirm the width`
      : 'no dimension matched the width — set the overall width to confirm scale',
    conflict: false,
  };
}
