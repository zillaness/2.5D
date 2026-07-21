// Bitting decode/encode — turn the photographed blade edge into a snapped
// bitting code, and (for testing / preview) turn a code back into an edge.
//
// The blade-edge profile is a list of samples { x, removal } where
//   x        = distance from the shoulder datum along the blade axis (in)
//   removal  = material removed at that x, measured DOWN from the uncut top
//              edge of the blade (in).  0 = uncut, larger = deeper cut.
//
// Reading the cut for position i means: look at the samples in a window around
// the standard cut centre, take the DEEPEST removal (the root/flat at the bottom
// of the V), and snap that to the nearest standard depth. We use the deepest
// point rather than the exact centre because it's robust to small datum error —
// the dominant error source for keys — without needing sub-thou photo precision.

import {
  cutCentre, removalForCode, codeForRemoval, codeRange,
} from './blanks.js';

// Half the run-per-depth of a V wall: at included angle A the wall leans
// (90 - A/2)° off vertical, so moving 1" of depth spreads tan(A/2)" sideways.
function wallRun(spec) {
  return Math.tan((spec.cutAngle * Math.PI / 180) / 2);
}

// ── Decode ───────────────────────────────────────────────────────────────────

// Read a bitting code from an edge profile.
//   profile : array of { x, removal } sorted-ish by x (we don't require sorted)
//   opts.window : half-width of the sampling window as a fraction of spacing
//                 (default 0.35 → ±35% of the pitch around each centre)
// Returns { code:[…], removals:[…], macs:{…} }.
export function decodeBitting(spec, profile, opts = {}) {
  const windowFrac = opts.window ?? 0.35;
  const half = spec.spacing * windowFrac;
  const code = [];
  const removals = [];

  for (let i = 0; i < spec.positions; i++) {
    const c = cutCentre(spec, i);
    let deepest = -Infinity;
    for (const s of profile) {
      if (s.x < c - half || s.x > c + half) continue;
      if (s.removal > deepest) deepest = s.removal;
    }
    if (deepest === -Infinity) deepest = 0; // no samples → treat as uncut
    removals.push(deepest);
    code.push(codeForRemoval(spec, deepest));
  }

  return { code, removals, macs: checkMACS(spec, code) };
}

// ── MACS ─────────────────────────────────────────────────────────────────────

// Max Adjacent Cut Spec: no two neighbouring digits may differ by more than
// spec.macs, or the cutter can't physically make both cuts. Returns
// { ok, violations:[{ i, a, b, diff }] }.
export function checkMACS(spec, code) {
  const violations = [];
  for (let i = 0; i < code.length - 1; i++) {
    const diff = Math.abs(code[i] - code[i + 1]);
    if (diff > spec.macs) violations.push({ i, a: code[i], b: code[i + 1], diff });
  }
  return { ok: violations.length === 0, violations };
}

// True if every digit sits inside the spec's legal depth range.
export function codeInRange(spec, code) {
  const [lo, hi] = codeRange(spec);
  return code.every(d => Number.isInteger(d) && d >= lo && d <= hi);
}

// ── Encode (synthetic edge — for tests, preview, and the mesh's cut profile) ──

// Turn a bitting code into a sampled edge profile, modelling each cut as a
// flat-bottomed V of the spec's angle. Overlapping walls from deep neighbours
// are unioned (deepest removal wins at each x), exactly as a real cutter leaves
// the blade. `step` is the sample pitch in inches (default 0.002").
export function encodeToProfile(spec, code, opts = {}) {
  const step = opts.step ?? 0.002;
  const run = wallRun(spec);
  const flatHalf = spec.cutFlat / 2;

  const lastCentre = cutCentre(spec, spec.positions - 1);
  const xEnd = lastCentre + spec.firstCut; // a little tail past the last cut
  const profile = [];

  for (let x = 0; x <= xEnd + 1e-9; x += step) {
    let removal = 0;
    for (let i = 0; i < spec.positions; i++) {
      const depth = removalForCode(spec, code[i]);
      if (depth <= 0) continue;
      const c = cutCentre(spec, i);
      const dx = Math.abs(x - c);
      // Inside the flat bottom: full depth. Outside: fall off along the wall.
      const cut = dx <= flatHalf ? depth : depth - (dx - flatHalf) / run;
      if (cut > removal) removal = cut;
    }
    profile.push({ x, removal: Math.max(0, removal) });
  }
  return profile;
}
