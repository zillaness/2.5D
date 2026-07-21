// Hole-callout parsing for imported drawings (Blueprint fork).
//
// A CAD drawing annotates its drilled holes with callouts like
// "4X ⌀.206 THRU  ⌴ ⌀.448 ▼ .151" (four ⌀0.206 through-holes, each counterbored
// ⌀0.448 deep 0.151). We (1) parse those callouts from the PDF text layer into
// structured specs and (2) match each spec to the circular hole loops in the
// geometry, then convert the matched loops into the app's parametric holes.
//
// Matching is by **diameter + multiplicity + concentric-rim**, never by text
// position. The text layer lives in unshifted points (y-down) while the geometry
// has been scaled to true mm and origin-shifted, so reconciling the two frames is
// fiddly and fragile; diameters and counts are frame-independent and reliable.
//
// The grammar accepts drafting glyphs *and* ASCII synonyms (⌀/Ø, ⌴/CBORE,
// ⌵/CSK, ▼/DEEP, THRU) so it reads real drawings and also round-trips through a
// minimal embedded PDF font (where only Ø survives).

import { parseNumberLoose } from './pdfScale.js';
import { fitCircle } from '../contour.js';

// A number: mixed (1 1/2), fraction (1/2), decimal (.206 / 1.5) or integer.
const NUM = String.raw`(?:\d+\s+\d+\/\d+|\d+\/\d+|\d*\.\d+|\d+(?:\.\d+)?)`;

// Fold drafting glyphs + spelling variants down to canonical ASCII keywords.
function normalize(raw) {
  return String(raw)
    .replace(/[⌀Ø∅Φφϕθ⊘]/g, ' ⌀ ')                                  // diameter
    .replace(/⌴/g, ' CBORE ')                                        // counterbore glyph
    .replace(/[⌵⌷∨]/g, ' CSK ')                                      // countersink glyph
    .replace(/[▼▽↧⤓]/g, ' DEEP ')                                    // depth glyph
    .replace(/\bC[’'’]?\s?BORE\b|\bCOUNTER\s?BORE\b|\bSF\b/gi, ' CBORE ')
    .replace(/\bC[’'’]?\s?SK\b|\bC[’'’]?\s?SINK\b|\bCOUNTER\s?SINK\b/gi, ' CSK ')
    .replace(/\bDEEP\b|\bDEPTH\b/gi, ' DEEP ')
    .replace(/\bTHRU\s*ALL\b|\bTHRU\b|\bTHROUGH\b/gi, ' THRU ')
    .replace(/°|\bDEG(?:REES?)?\b/gi, ' ')                            // angle unit — drop, keep the number
    .replace(/\s+/g, ' ')
    .trim();
}

function firstNum(s) {
  const m = s.match(new RegExp(NUM));
  return m ? parseNumberLoose(m[0]) : null;
}
// The number a keyword introduces, e.g. DEEP → its depth, ⌀ → its diameter.
function numAfter(s, kw) {
  const m = s.match(new RegExp(kw + `\\s*(` + NUM + `)`));
  return m ? parseNumberLoose(m[1]) : null;
}

// Parse one text fragment into a partial callout. A fragment may be a whole
// callout ("4X ⌀.206 THRU ⌴ ⌀.448 DEEP .151") or a continuation of the previous
// one (a lone "⌴ ⌀.448 DEEP .151" stacked on the line below).
function parseFragment(raw) {
  const s = normalize(raw);
  if (!s.includes('⌀')) return null;                 // no diameter → not a callout

  const f = { raw: raw.trim() };
  const mult = s.match(new RegExp(`^\\s*(\\d+)\\s*[X×]\\b`, 'i'));
  if (mult) f.count = +mult[1];

  // Split at the first modifier marker: everything before is the primary hole,
  // the CBORE / CSK tail describes its recess.
  const modIdx = (() => {
    const a = s.indexOf('CBORE'); const b = s.indexOf('CSK');
    const idxs = [a, b].filter(i => i >= 0);
    return idxs.length ? Math.min(...idxs) : -1;
  })();
  const head = modIdx >= 0 ? s.slice(0, modIdx) : s;
  const tail = modIdx >= 0 ? s.slice(modIdx) : '';

  if (head.includes('⌀')) f.dia = numAfter(head, '⌀');
  if (/\bTHRU\b/.test(head)) f.thru = true;
  const headDeep = numAfter(head, 'DEEP');
  if (headDeep != null) f.depth = headDeep;          // blind primary hole

  if (tail.includes('CBORE')) {
    f.cbore = true;
    f.cbDia = numAfter(tail, '⌀');
    f.cbDepth = numAfter(tail, 'DEEP');
  }
  if (tail.includes('CSK')) {
    f.csk = true;
    f.csDia = numAfter(tail, '⌀');
    // angle: an "X 82" separator, else the last bare number in the tail.
    const ang = tail.match(new RegExp(`[X×]\\s*(` + NUM + `)`));
    f.csAngle = ang ? parseNumberLoose(ang[1]) : null;
    if (f.csAngle == null) {                          // fall back to a trailing number
      const nums = tail.match(new RegExp(NUM, 'g')) || [];
      if (nums.length >= 2) f.csAngle = parseNumberLoose(nums[nums.length - 1]);
    }
  }
  // A fragment with no primary dia but a recess is a continuation.
  f.continuation = f.dia == null && (f.cbore || f.csk);
  return f;
}

function fragType(f) {
  if (f.cbore) return 'cb';
  if (f.csk) return 'cs';
  if (f.depth != null && !f.thru) return 'blind';
  return 'through';
}

// pdf.js fragments text arbitrarily (a leading Ø often arrives as its own
// item), so rebuild readable runs first: group items by line (same page + y),
// sort by x, and join neighbours unless a wide x-gap separates two columns.
// Items without positions (plain strings in tests) pass through unchanged.
export function reassembleRuns(texts) {
  const items = (texts || []).map(t => (t && t.str != null) ? t : { str: String(t) });
  if (!items.some(t => t.x != null && t.y != null)) return items.map(t => t.str);

  const lines = [];
  for (const t of items) {
    const ln = lines.find(l => (l.page || 0) === (t.page || 0) && Math.abs(l.y - t.y) <= 2);
    if (ln) ln.items.push(t); else lines.push({ y: t.y, page: t.page, items: [t] });
  }
  const runs = [];
  for (const ln of lines) {
    ln.items.sort((a, b) => a.x - b.x);
    let cur = null, curEnd = 0;
    for (const t of ln.items) {
      const gapTol = Math.max(8, (t.h || 0) * 1.5);
      if (cur && t.x - curEnd <= gapTol) cur.str += ' ' + t.str;
      else { cur = { str: t.str }; runs.push(cur); }
      curEnd = Math.max(curEnd, t.x + (t.w || 0));
    }
  }
  return runs.map(r => r.str);
}

// Parse the page's text items into hole-callout specs (values in drawing units).
// texts: [{ str, x?, y?, w?, page? }]. Positioned fragments are reassembled into
// per-line runs first; continuation fragments fold onto the previous primary.
export function parseCallouts(texts) {
  const out = [];
  let prev = null;
  for (const t of reassembleRuns(texts)) {
    const f = parseFragment(t);
    if (!f) continue;
    if (f.continuation && prev) {                     // stacked recess line
      if (f.cbore) { prev.cbore = true; prev.cbDia = f.cbDia; prev.cbDepth = f.cbDepth; }
      if (f.csk) { prev.csk = true; prev.csDia = f.csDia; prev.csAngle = f.csAngle; }
      prev.type = fragType(prev);
      continue;
    }
    if (f.dia == null) continue;                      // recess with no host — ignore
    const spec = {
      raw: f.raw, count: f.count || 1, dia: f.dia,
      thru: !!f.thru, depth: f.depth != null ? f.depth : null,
      cbore: !!f.cbore, cbDia: f.cbDia != null ? f.cbDia : null, cbDepth: f.cbDepth != null ? f.cbDepth : null,
      csk: !!f.csk, csDia: f.csDia != null ? f.csDia : null, csAngle: f.csAngle != null ? f.csAngle : null,
    };
    spec.type = fragType(spec);
    out.push(spec);
    prev = spec;
  }
  return out;
}

const DEFAULT_HOLE = {
  side: 'top',
  edgeTop: { mode: 'none', size: 0.5 },
  edgeBottom: { mode: 'none', size: 0.5 },
  screw: { std: 'custom', size: '', fit: 'clearance' },
};

// Fit each hole loop to a circle; keep only loops that really are circular.
function circleize(holes) {
  return holes.map((pts, idx) => {
    const c = fitCircle(pts);
    if (!c) return { idx, circular: false };
    const circular = c.rms <= 0.06 * c.r + 0.03;
    return { idx, circular, cx: c.cx, cy: c.cy, r: c.r, d: c.r * 2 };
  });
}

// Cluster circular loops that share a centre (a bore + its counterbore/-sink rim
// are concentric). Each group is sorted inner→outer.
function concentricGroups(circs) {
  const items = circs.filter(c => c.circular);
  const used = new Array(items.length).fill(false);
  const groups = [];
  for (let i = 0; i < items.length; i++) {
    if (used[i]) continue;
    const g = [items[i]]; used[i] = true;
    for (let j = i + 1; j < items.length; j++) {
      if (used[j]) continue;
      const tol = Math.max(0.3, 0.08 * Math.min(items[i].r, items[j].r));
      if (Math.hypot(items[i].cx - items[j].cx, items[i].cy - items[j].cy) <= tol) {
        g.push(items[j]); used[j] = true;
      }
    }
    g.sort((a, b) => a.r - b.r);
    groups.push({ members: g, cx: g[0].cx, cy: g[0].cy, bore: g[0].d, rim: g[g.length - 1].d });
  }
  return groups;
}

const round2 = n => Math.round(n * 100) / 100;

// Match parsed callouts to the geometry's hole loops. `mmPerUnit` converts the
// callout numbers (drawing units) to mm; the loops are already in mm.
// Returns { circles, consumed:Set<loopIdx>, applied:[{label,n}], unmatched:[] }.
export function matchCallouts(callouts, holes, mmPerUnit = 1) {
  const circs = circleize(holes || []);
  const groups = concentricGroups(circs);
  const usedGroup = new Set();
  const circles = [];
  const consumed = new Set();
  const applied = [];
  const unmatched = [];

  for (const co of callouts) {
    const Dmm = co.dia * mmPerUnit;
    const tol = Math.max(0.3, 0.06 * Dmm);
    // Candidate groups whose bore matches the callout diameter, closest first;
    // a concentric rim near cbDia/csDia breaks ties in favour of the recess.
    const cbRim = co.cbDia != null ? co.cbDia * mmPerUnit : (co.csDia != null ? co.csDia * mmPerUnit : null);
    const cands = groups
      .map((g, gi) => ({ gi, g, err: Math.abs(g.bore - Dmm) }))
      .filter(c => !usedGroup.has(c.gi) && c.err <= tol)
      .sort((a, b) => {
        if (cbRim != null) {
          const ra = Math.abs(a.g.rim - cbRim), rb = Math.abs(b.g.rim - cbRim);
          const am = ra <= Math.max(0.5, 0.1 * cbRim) ? 0 : 1, bm = rb <= Math.max(0.5, 0.1 * cbRim) ? 0 : 1;
          if (am !== bm) return am - bm;
        }
        return a.err - b.err;
      });

    let n = 0;
    for (const c of cands) {
      if (n >= co.count) break;
      usedGroup.add(c.gi);
      for (const m of c.g.members) consumed.add(m.idx);
      circles.push(makeCircle(co, c.g, mmPerUnit));
      n++;
    }
    if (n > 0) applied.push({ label: describe(co, n, mmPerUnit), n });
    if (n < co.count) unmatched.push({ callout: co, wanted: co.count, got: n });
  }
  return { circles, consumed, applied, unmatched };
}

function makeCircle(co, group, mmPerUnit) {
  const Dmm = co.dia * mmPerUnit;
  const c = { ...structuredClone(DEFAULT_HOLE), cx: round2(group.cx), cy: round2(group.cy), d: round2(Dmm), type: co.type };
  if (co.type === 'blind') c.depth = round2((co.depth || 0) * mmPerUnit);
  if (co.type === 'cb') {
    c.cbDia = round2((co.cbDia != null ? co.cbDia * mmPerUnit : group.rim));
    c.cbDepth = round2((co.cbDepth || 0) * mmPerUnit);
  }
  if (co.type === 'cs') {
    c.csDia = round2((co.csDia != null ? co.csDia * mmPerUnit : group.rim));
    c.csAngle = co.csAngle || 90;
  }
  return c;
}

function describe(co, n, mmPerUnit) {
  const d = round2(co.dia * mmPerUnit);
  let s = `${n}× ⌀${d} mm`;
  if (co.type === 'through') s += ' through';
  else if (co.type === 'blind') s += ` blind ▼${round2((co.depth || 0) * mmPerUnit)}`;
  else if (co.type === 'cb') s += ` c'bore ⌀${round2((co.cbDia || 0) * mmPerUnit)} ▼${round2((co.cbDepth || 0) * mmPerUnit)}`;
  else if (co.type === 'cs') s += ` c'sink ⌀${round2((co.csDia || 0) * mmPerUnit)}×${co.csAngle || 90}°`;
  return s;
}
