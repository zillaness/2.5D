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
// ── Spec model ─────────────────────────────────────────────────────────────
//   firstCut       shoulder datum → centre of cut position 1        (in)
//   spacing        centre-to-centre distance between cuts           (in)
//   positions      number of cut positions (== pin count)
//   codeMin        smallest code digit (Schlage 0, Kwikset 1)
//   depthCount     number of standard depths
//   depthStep      material removed per one-unit-deeper code        (in)
//   rootRemovalAtMin  material removed at the SHALLOWEST code, from
//                     the uncut blade edge                          (in)
//   cutAngle       included angle of the V cutter                   (deg)
//   cutFlat        width of the flat at the bottom of a cut         (in)
//   macs           max adjacent cut spec (max |digit[i]-digit[i+1]|)
//   bladeHeight    uncut blade edge → blade back (the datum edge)   (in)
//
// The removal at a given code (distance the cut eats into the uncut top edge):
//   removal(code) = rootRemovalAtMin + (code - codeMin) * depthStep
// so the deepest code removes rootRemovalAtMin + (depthCount-1)*depthStep.
//
// ── Sourcing note ──────────────────────────────────────────────────────────
// Numbers below are cross-checked against multiple independent references
// (locksmith depth-and-spacing summaries, Lockwiki, and the cq.cx / PhysicalKeygen
// key-modelling projects). They agree on spacing, first cut, depth count, and
// increment. Treat them as verified for decoding/snapping, but re-confirm the
// per-code ROOT depths and the warded `sectionProfile` against a manufacturer
// chart before cutting a key you intend to insert into a real lock.

export const IN_TO_MM = 25.4;

// One depth-and-spacing spec, shared by SC1 (5-pin) and SC4 (6-pin) which
// differ only in position count.
const SCHLAGE_SPEC = {
  unit: 'in',
  firstCut: 0.231,
  spacing: 0.156,
  codeMin: 0,
  depthCount: 10,          // codes 0–9
  depthStep: 0.015,
  rootRemovalAtMin: 0.0,   // code 0 == uncut top edge
  cutAngle: 100,           // Schlage Classic uses a ~100° included angle
  cutFlat: 0.031,
  macs: 7,
  bladeHeight: 0.335,
};

const KWIKSET_SPEC = {
  unit: 'in',
  firstCut: 0.247,
  spacing: 0.150,
  codeMin: 1,
  depthCount: 7,           // codes 1–7
  depthStep: 0.023,
  rootRemovalAtMin: 0.008, // code 1 already removes a little material
  cutAngle: 90,
  cutFlat: 0.030,
  macs: 4,
  bladeHeight: 0.335,
};

// Master Lock M1 (padlock keyway). PROVISIONAL — only some fields are confirmed.
// Confirmed across sources: 4 cut positions, depths 0–7 (8 depths), increment
// 0.0155". NOT yet confirmed (proxy blocks the Master Lock technical manual):
// spacing, first cut, cut angle, MACS, root depths — the values below marked
// UNVERIFIED are best-estimates and must be replaced from the manufacturer chart
// (top of docs/key-refs/PULL-LIST) before this blank drives a cut key. The blank
// carries `verified: false` so the UI/mesh can warn or gate on it.
const MASTER_M1_SPEC = {
  unit: 'in',
  firstCut: 0.200,         // UNVERIFIED estimate
  spacing: 0.156,          // UNVERIFIED estimate (Master often cited at .156)
  codeMin: 0,
  depthCount: 8,           // codes 0–7  (confirmed: 0–7 depth-and-spacing set)
  depthStep: 0.0155,       // confirmed: Master increment .0155"
  rootRemovalAtMin: 0.0,   // UNVERIFIED estimate (code 0 == uncut)
  cutAngle: 90,            // UNVERIFIED estimate
  cutFlat: 0.030,          // UNVERIFIED estimate
  macs: 7,                 // UNVERIFIED estimate
  bladeHeight: 0.335,      // UNVERIFIED estimate
};

// sectionProfile (the warded blade cross-section) is intentionally null for now.
// It's the make-or-break data for a key that actually enters the lock and must
// be sourced/measured separately; v1 decodes bitting without it and the mesh can
// start from a plain rectangular blade until real profiles land.
// Roadmap order (per product owner): KW1, SC1, M1, SC4 first; then WR5, Y1, S1,
// A1, KW10 as the next wave. `verified` marks whether every spec number has been
// checked against an authoritative chart — provisional blanks should be gated /
// warned in the UI and never trusted to cut a physical key.
export const BLANKS = [
  {
    id: 'KW1',
    brand: 'Kwikset',
    keyway: 'KW1',
    name: 'Kwikset KW1 (5-pin)',
    positions: 5,
    verified: true,
    sectionProfile: null,
    spec: { ...KWIKSET_SPEC, positions: 5 },
  },
  {
    id: 'SC1',
    brand: 'Schlage',
    keyway: 'SC1',
    name: 'Schlage SC1 (5-pin)',
    positions: 5,
    verified: true,
    sectionProfile: null,
    spec: { ...SCHLAGE_SPEC, positions: 5 },
  },
  {
    id: 'M1',
    brand: 'Master Lock',
    keyway: 'M1',
    name: 'Master Lock M1 (4-pin, provisional)',
    positions: 4,
    verified: false,        // spacing/first-cut/angle/MACS not yet confirmed
    sectionProfile: null,
    spec: { ...MASTER_M1_SPEC, positions: 4 },
  },
  {
    id: 'SC4',
    brand: 'Schlage',
    keyway: 'SC4',
    name: 'Schlage SC4 (6-pin)',
    positions: 6,
    verified: true,
    sectionProfile: null,
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

// Inclusive [min, max] code digits allowed by a spec.
export function codeRange(spec) {
  return [spec.codeMin, spec.codeMin + spec.depthCount - 1];
}

// Distance from the shoulder datum to the centre of cut position i (0-based).
export function cutCentre(spec, i) {
  return spec.firstCut + i * spec.spacing;
}

// Material removed from the uncut top edge for a given code digit (inches).
export function removalForCode(spec, code) {
  return spec.rootRemovalAtMin + (code - spec.codeMin) * spec.depthStep;
}

// Snap a measured removal depth (inches) to the nearest standard code digit,
// clamped into the spec's legal range.
export function codeForRemoval(spec, removal) {
  const raw = Math.round((removal - spec.rootRemovalAtMin) / spec.depthStep) + spec.codeMin;
  const [lo, hi] = codeRange(spec);
  return Math.max(lo, Math.min(hi, raw));
}
