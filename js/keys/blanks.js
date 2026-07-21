// Blank / keyway library — the domain data that turns "photograph an object"
// into "photograph a KEY". Each entry pairs a manufacturer keyway with its
// depth-and-spacing spec (how the bitting code maps to physical cut geometry).
//
// SCOPE: ordinary US residential pin-tumbler blanks only. Restricted, patented,
// registered, or "Do Not Duplicate" keyways (Medeco, Abloy, Mul-T-Lock, …) are
// deliberately absent — they are legally controlled and out of scope.
//
// ── Units ──────────────────────────────────────────────────────────────────
// US key specs are published in inches, so every length in a `spec` is inches.
// The rest of the app works in millimetres; convert at the mesh boundary with
// IN_TO_MM. Keeping the library in its native unit avoids rounding the source
// data and makes it checkable against a printed depth-and-spacing chart.
//
// ── Datum: the blade BACK, not the top edge ─────────────────────────────────
// Bitting is stored the way manufacturer charts print it: a "root depth" is the
// height of the bottom of a cut measured up from the blade's BACK (the straight,
// uncut edge). Deeper cut → smaller root depth. The blade back is the right
// reference for photo decoding because, unlike the top edge, it's never cut
// away, so it stays a clean straight line to register against.
//
// ── Spec model ─────────────────────────────────────────────────────────────
//   firstCut       shoulder datum → centre of cut position 1  (in)  [chart TFC]
//   spacing        centre-to-centre distance between cuts      (in)  [chart BCC]
//   positions      number of cut positions (== pin count)
//   codeMin        smallest code digit (Schlage/Master 0, Kwikset 1)
//   depthCount     number of standard depths
//   depthStep      root-depth change per one-unit code step    (in)  [increment]
//   rootDepthAtMin root depth of the codeMin (shallowest) cut  (in)
//   rootDepths     explicit per-code root depths (authoritative; indexed by
//                  code-codeMin). Present → used verbatim; else linear model.
//   bladeHeight    blade back → uncut top edge                 (in)
//   bladeThickness blade thickness (for the mesh extrude)       (in)  [approx]
//   cutAngle       included angle of the V cutter              (deg)
//   cutFlat        width of the flat at the bottom of a cut    (in)  [Root Cut]
//   macs           max adjacent cut spec (max |digit[i]-digit[i+1]|)
//
// Material a cut removes from the uncut top edge (needed by the mesh):
//   removal(code) = bladeHeight - rootDepth(code)
//
// ── Sources (dropped into docs/key-refs/, read directly) ────────────────────
// - Schlage Classic, Kwikset .023": Tyler J. Thomas, "Key Bitting
//   Specifications" (2025), pp. 76 & 57.
// - Master Lock M1 (1K blank): Master Lock Technical Manual 7000-0031, p.25
//   bitting table (1K row); angle/flat/MACS from the Thomas "Master Lock Pro
//   Series" .0155" entry (p.63), the same spec family as the 1K blank.
// Root depths, spacing, first cut and increments are taken verbatim from those
// charts. bladeThickness (and Kwikset bladeHeight) are approximate and refined
// at mesh time; they don't affect decoding, which uses the blade-back datum.

import { getWarding } from './warding.js';

export const IN_TO_MM = 25.4;

// Schlage Classic — SC1 (5-pin) / SC4 (6-pin) share one spec, differing only in
// position count.  Thomas 2025, p.76.
const SCHLAGE_SPEC = {
  unit: 'in',
  firstCut: 0.231,
  spacing: 0.156,
  codeMin: 0,
  depthCount: 10,          // codes 0–9
  depthStep: 0.015,
  rootDepthAtMin: 0.335,
  rootDepths: [0.335, 0.320, 0.305, 0.290, 0.275, 0.260, 0.245, 0.230, 0.215, 0.200],
  bladeHeight: 0.335,      // uncut top == the No.0 (shallowest) cut level
  bladeThickness: 0.083,   // approx
  cutAngle: 100,
  cutFlat: 0.031,
  macs: 7,
};

// Kwikset .023" — KW1 (5-pin).  Thomas 2025, p.57.
const KWIKSET_SPEC = {
  unit: 'in',
  firstCut: 0.247,
  spacing: 0.150,
  codeMin: 1,
  depthCount: 7,           // codes 1–7
  depthStep: 0.023,
  rootDepthAtMin: 0.329,
  rootDepths: [0.329, 0.306, 0.283, 0.260, 0.237, 0.214, 0.191], // code 1..7
  bladeHeight: 0.335,      // approx (chart gives root depths, not blade height)
  bladeThickness: 0.083,   // approx
  cutAngle: 90,
  cutFlat: 0.084,
  macs: 4,
};

// Master Lock M1 — the "1K" blank (Ilco M1 / 1092), 4-pin laminated padlock key.
// Root depths + blade width from the Master 7000-0031 manual's 1K row; angle,
// flat and MACS from the matching Thomas "Master Lock Pro Series" .0155" spec.
const MASTER_M1_SPEC = {
  unit: 'in',
  firstCut: 0.187,
  spacing: 0.125,
  codeMin: 0,
  depthCount: 8,           // codes 0–7
  depthStep: 0.0155,
  rootDepthAtMin: 0.2720,
  rootDepths: [0.2720, 0.2565, 0.2410, 0.2255, 0.2100, 0.1945, 0.1790, 0.1635],
  bladeHeight: 0.281,      // Master 1K "Key Blank Width"
  bladeThickness: 0.083,   // approx
  cutAngle: 90,
  cutFlat: 0.044,
  macs: 5,
};

// Roadmap order (per product owner): KW1, SC1, M1, SC4 first; then WR5, Y1, S1,
// A1, KW10 as the next wave. `verified` marks whether every spec number has been
// checked against an authoritative chart — all four below are verified.
//
// `warding` names the default warded cross-section (from js/warding.js) that the
// mesh extrudes to make a key that actually enters the lock. Schlage is sectional
// so `wardingOptions` lists the whole C-family; a flat blade won't reliably enter
// a paracentric Schlage keyway, which is why the real section matters.
export const BLANKS = [
  {
    id: 'KW1',
    brand: 'Kwikset',
    keyway: 'KW1',
    name: 'Kwikset KW1 (5-pin)',
    positions: 5,
    verified: true,
    warding: 'kwikset:kw1',
    wardingOptions: ['kwikset:kw1'],
    spec: { ...KWIKSET_SPEC, positions: 5 },
  },
  {
    id: 'SC1',
    brand: 'Schlage',
    keyway: 'SC1',
    name: 'Schlage SC1 (5-pin)',
    positions: 5,
    verified: true,
    warding: 'schlage:c',
    wardingOptions: ['schlage:c', 'schlage:ce', 'schlage:e', 'schlage:ef',
      'schlage:f', 'schlage:fg', 'schlage:g', 'schlage:h', 'schlage:j',
      'schlage:k', 'schlage:l'],
    spec: { ...SCHLAGE_SPEC, positions: 5 },
  },
  {
    id: 'M1',
    brand: 'Master Lock',
    keyway: 'M1',
    name: 'Master Lock M1 (4-pin)',
    positions: 4,
    verified: true,
    warding: 'master:k1',
    wardingOptions: ['master:k1'],
    spec: { ...MASTER_M1_SPEC, positions: 4 },
  },
  {
    id: 'SC4',
    brand: 'Schlage',
    keyway: 'SC4',
    name: 'Schlage SC4 (6-pin)',
    positions: 6,
    verified: true,
    warding: 'schlage:c',
    wardingOptions: ['schlage:c', 'schlage:ce', 'schlage:e', 'schlage:ef',
      'schlage:f', 'schlage:fg', 'schlage:g', 'schlage:h', 'schlage:j',
      'schlage:k', 'schlage:l'],
    spec: { ...SCHLAGE_SPEC, positions: 6 },
  },
];

export function getBlank(id) {
  return BLANKS.find(b => b.id === id) || null;
}

// Blanks whose every spec number is confirmed — the ones safe to cut from.
export function verifiedBlanks() {
  return BLANKS.filter(b => b.verified);
}

// Resolve a blank's warded cross-section polygon (mm). `wardingId` overrides the
// blank default — use it to pick a Schlage section from blank.wardingOptions.
export function wardingFor(blank, wardingId = null) {
  return getWarding(wardingId || blank.warding);
}

// Inclusive [min, max] code digits allowed by a spec.
export function codeRange(spec) {
  return [spec.codeMin, spec.codeMin + spec.depthCount - 1];
}

// Distance from the shoulder datum to the centre of cut position i (0-based).
export function cutCentre(spec, i) {
  return spec.firstCut + i * spec.spacing;
}

// Root depth (height of the cut bottom above the blade back) for a code digit.
// Uses the explicit chart array when present, else the linear increment model.
export function rootDepthForCode(spec, code) {
  if (spec.rootDepths) return spec.rootDepths[code - spec.codeMin];
  return spec.rootDepthAtMin - (code - spec.codeMin) * spec.depthStep;
}

// Snap a measured root depth (height above the blade back, inches) to the
// nearest standard code digit, clamped into the spec's legal range.
export function codeForRootDepth(spec, rootDepth) {
  const raw = Math.round((spec.rootDepthAtMin - rootDepth) / spec.depthStep) + spec.codeMin;
  const [lo, hi] = codeRange(spec);
  return Math.max(lo, Math.min(hi, raw));
}

// Material removed from the uncut top edge for a code digit (inches) — the depth
// the mesh carves into the blade.
export function removalForCode(spec, code) {
  return spec.bladeHeight - rootDepthForCode(spec, code);
}
