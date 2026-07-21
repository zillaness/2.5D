// App-side bitting decode — the brain behind the confirm/edit UI.
//
// Works in millimetres (what the rectified photo gives, via the card homography).
// The input is a blade HEIGHT PROFILE: samples { u, h } where
//   u = distance along the blade axis from the SHOULDER datum (mm, bow→tip)
//   h = blade height at u (mm) = distance from the blade back up to the edge.
// The UI produces this by projecting the traced top edge + back edge onto the
// blade axis; it also owns the three draggable handles (shoulder, cut centres,
// per-cut depth), which map onto the options below.

import { cutCentre, rootDepthForCode, codeRange } from './blanks.js';
import { checkMACS } from './bitting.js';

const IN = 25.4;

export const spacingMm = (spec) => spec.spacing * IN;
export const cutCentreMm = (spec, i) => cutCentre(spec, i) * IN;
export const rootDepthMm = (spec, code) => rootDepthForCode(spec, code) * IN;

// Snap a measured root depth (mm) to the nearest legal code + its residual (mm).
export function snapDepthMm(spec, mm) {
  const [lo, hi] = codeRange(spec);
  let best = lo, bd = Infinity;
  for (let c = lo; c <= hi; c++) {
    const d = Math.abs(mm - rootDepthMm(spec, c));
    if (d < bd) { bd = d; best = c; }
  }
  return { code: best, residual: bd };
}

// Decode a bitting code from a height profile.
//   opts.shoulderU  : shift the datum (mm) — the shoulder handle (default 0)
//   opts.window     : sampling half-width as a fraction of pitch (default 0.35)
//   opts.cutShift   : per-position u nudge (mm) — the cut-centre handles
//   opts.overrides  : { [position]: code } — the depth handle, user-set digit
// Returns { code, cuts:[{ i, u, depthMm, code, residual, overridden }], macs }.
export function decode(spec, profile, opts = {}) {
  const shoulderU = opts.shoulderU ?? 0;
  const half = (opts.window ?? 0.35) * spacingMm(spec);
  const cutShift = opts.cutShift || {};
  const overrides = opts.overrides || {};
  const cuts = [];

  for (let i = 0; i < spec.positions; i++) {
    const u = cutCentreMm(spec, i) + shoulderU + (cutShift[i] || 0);
    let deepest = Infinity;
    for (const s of profile) {
      if (s.u < u - half || s.u > u + half) continue;
      if (s.h < deepest) deepest = s.h;
    }
    if (deepest === Infinity) deepest = rootDepthMm(spec, spec.codeMin);
    const snap = snapDepthMm(spec, deepest);
    const overridden = Object.prototype.hasOwnProperty.call(overrides, i);
    cuts.push({
      i, u, depthMm: deepest,
      code: overridden ? overrides[i] : snap.code,
      residual: snap.residual, overridden,
    });
  }

  const code = cuts.map(c => c.code);
  // A large snap residual anywhere = the read is between two depths → the UI
  // should flag it for the user to confirm (the ambiguity we hit on the SC1).
  const worst = Math.max(0, ...cuts.filter(c => !c.overridden).map(c => c.residual));
  const halfStep = 0.5 * spec.depthStep * IN;
  return {
    code, cuts, macs: checkMACS(spec, code),
    ambiguous: cuts.filter(c => !c.overridden && c.residual > 0.7 * halfStep).map(c => c.i),
    worstResidual: worst,
  };
}

// ── geometry helpers the UI uses to build the profile ────────────────────────

// Project a traced edge polyline onto the blade axis and return h(u) samples.
// axis = { o:{x,y} shoulder point, d:{x,y} unit bow→tip, n:{x,y} unit back→edge }.
// topEdge / backEdge: arrays of {x,y} in mm. Sampled every `step` mm.
export function profileFromEdges(topEdge, backEdge, axis, step = 0.25) {
  const { o, d, n } = axis;
  const u = (p) => (p.x - o.x) * d.x + (p.y - o.y) * d.y;
  const v = (p) => (p.x - o.x) * n.x + (p.y - o.y) * n.y;
  const bin = (edge) => {
    const map = new Map();
    for (const p of edge) {
      const k = Math.round(u(p) / step);
      const val = v(p);
      const cur = map.get(k);
      // keep the extreme edge sample in each bin
      if (cur === undefined) map.set(k, val); else map.set(k, [cur, val]);
    }
    return map;
  };
  const topB = bin(topEdge), backB = bin(backEdge);
  const keys = [...topB.keys()].filter(k => backB.has(k)).sort((a, b) => a - b);
  const flat = (x) => Array.isArray(x) ? (x[0] + x[1]) / 2 : x;
  return keys.map(k => ({ u: k * step, h: Math.abs(flat(topB.get(k)) - flat(backB.get(k))) }));
}

// Convenience: axis from a shoulder point + tip point + a back-edge point.
export function axisFrom(shoulder, tip, backPoint) {
  const dx = tip.x - shoulder.x, dy = tip.y - shoulder.y;
  const L = Math.hypot(dx, dy) || 1;
  const d = { x: dx / L, y: dy / L };
  let n = { x: -d.y, y: d.x };
  // orient n from the back edge toward the cut edge (away from backPoint)
  const side = (backPoint.x - shoulder.x) * n.x + (backPoint.y - shoulder.y) * n.y;
  if (side > 0) n = { x: -n.x, y: -n.y };
  return { o: shoulder, d, n };
}
