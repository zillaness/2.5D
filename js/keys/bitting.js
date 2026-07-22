// Copyright (C) 2026 Projects and Mods
// GPL-3.0-or-later WITH Commons Clause (non-commercial) - see LICENSE.

// Bitting decode/encode — turn the photographed blade edge into a snapped
// bitting code, and (for testing / preview / the mesh cut profile) turn a code
// back into an edge.
//
// The blade-edge profile is a list of samples { x, height } where
//   x       = distance from the shoulder datum along the blade axis (in)
//   height  = height of the cut edge above the blade BACK at that x (in).
//             Uncut blade sits at spec.bladeHeight; a cut dips it down toward
//             the cut's root depth. This is the manufacturer's "root depth"
//             datum (see blanks.js) — the blade back is the reference because
//             it's never cut away.
//
// Reading the cut for position i: look at the samples in a window around the
// standard cut centre, take the LOWEST edge (the root/flat at the bottom of the
// V), and snap that height to the nearest standard depth. Lowest-point rather
// than exact-centre makes it robust to small datum error — the dominant error
// source for keys — without needing sub-thou photo precision.

import {
  cutCentre, rootDepthForCode, codeForRootDepth, codeRange,
} from './blanks.js';

// Horizontal run a V wall covers per unit of vertical rise. At included angle A
// each wall leans A/2 off the vertical bisector, so rising Δh spreads tan(A/2)·Δh
// sideways.
function wallRun(spec) {
  return Math.tan((spec.cutAngle * Math.PI / 180) / 2);
}

// ── Decode ───────────────────────────────────────────────────────────────────

// Read a bitting code from an edge profile.
//   profile : array of { x, height } (need not be sorted)
//   opts.window : half-width of the sampling window as a fraction of spacing
//                 (default 0.35 → ±35% of the pitch around each centre)
// Returns { code:[…], rootDepths:[…], macs:{…} }.
export function decodeBitting(spec, profile, opts = {}) {
  const windowFrac = opts.window ?? 0.35;
  const half = spec.spacing * windowFrac;
  const code = [];
  const rootDepths = [];

  for (let i = 0; i < spec.positions; i++) {
    const c = cutCentre(spec, i);
    let lowest = Infinity;
    for (const s of profile) {
      if (s.x < c - half || s.x > c + half) continue;
      if (s.height < lowest) lowest = s.height;
    }
    if (lowest === Infinity) lowest = spec.bladeHeight; // no samples → treat uncut
    rootDepths.push(lowest);
    code.push(codeForRootDepth(spec, lowest));
  }

  return { code, rootDepths, macs: checkMACS(spec, code) };
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
// are unioned (the LOWEST edge wins at each x), exactly as a real cutter leaves
// the blade. `step` is the sample pitch in inches (default 0.002").
export function encodeToProfile(spec, code, opts = {}) {
  const step = opts.step ?? 0.002;
  const run = wallRun(spec);
  const flatHalf = spec.cutFlat / 2;

  const lastCentre = cutCentre(spec, spec.positions - 1);
  const xEnd = lastCentre + spec.firstCut; // a little tail past the last cut
  const profile = [];

  for (let x = 0; x <= xEnd + 1e-9; x += step) {
    let height = spec.bladeHeight;
    for (let i = 0; i < spec.positions; i++) {
      const root = rootDepthForCode(spec, code[i]);
      const c = cutCentre(spec, i);
      const dx = Math.abs(x - c);
      // Inside the flat bottom: full-depth (root). Outside: wall rises back up.
      const edge = dx <= flatHalf ? root : root + (dx - flatHalf) / run;
      if (edge < height) height = edge;
    }
    profile.push({ x, height: Math.min(spec.bladeHeight, height) });
  }
  return profile;
}
