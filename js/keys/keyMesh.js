// Copyright (C) 2026 Projects and Mods
// GPL-3.0-or-later WITH Commons Clause (non-commercial) - see LICENSE.

// Native key mesh generator — the on-device replacement for keygen+OpenSCAD.
//
// Builds a printable 3D key from a blank + bitting code, entirely in JS:
//   1. take the warded cross-section (blade end-on, t×h) for the keyway,
//   2. loft it along the blade length L, milling the top edge down to each cut's
//      root depth (the bitting), and
//   3. add a generic bow.
//
// Coordinates (mm): x = L along the blade (0 = shoulder datum, +x → tip),
// y = t (thickness, warding is centred on 0), z = h (height above blade back).
//
// The bitting only lowers the blade's TOP edge, and for these keyways the profile
// above the grooves is a single top span between two top corners. So we can loft
// with fixed topology — clip the two top corners down to the milled height at each
// L — instead of doing full 3-D CSG. Validated against keygen's SC1 output.

import earcut from '../../vendor/earcut.js';
import {
  wardingFor, cutCentre, rootDepthForCode, codeRange, IN_TO_MM,
} from './blanks.js';
import { toBinarySTL } from '../exporters.js';
import { getBow, getBowHoles } from './bows.js';
import { initManifold } from './manifold-loader.js';

// ── keygen-faithful tip / shoulder specs (per bow family) ────────────────────
// TIP: the nose is a ROUNDED, asymmetric point. apexFrac = apex height / blade
// height (where the two edges meet); topRamp / botRamp = mm the top / back edge
// travel in x to reach the apex. Numbers extracted from keygen (see keycheck).
const TIP_SPECS = {
  schlage: { apexFrac: 0.351, topRamp: 4.995, botRamp: 2.352 },
  kwikset: { apexFrac: 0.368, topRamp: 4.297, botRamp: 2.456 },
  master:  { apexFrac: 0.500, topRamp: 3.243, botRamp: 3.243 },
  best:    { apexFrac: 0.505, topRamp: 4.233, botRamp: 2.456 },
};
const DEFAULT_TIP = { apexFrac: 0.42, topRamp: 4.0, botRamp: 2.4 };
function tipSpecFor(blank) { return TIP_SPECS[blank.bow] || DEFAULT_TIP; }

// SHOULDER fillet: concave arc(s) blending the bow neck into the blade edge(s).
// R = fillet radius (mm); edges = which edge(s) carry the fillet.
const FILLET_SPECS = {
  schlage: { R: 1.04, edges: 'both' },
  kwikset: { R: 3.6,  edges: 'both' },
  master:  { R: 0.86, edges: 'top'  },
  best:    { R: 3.5,  edges: 'both' },
};
const DEFAULT_FILLET = { R: 1.0, edges: 'both' };
function filletSpecFor(blank) { return FILLET_SPECS[blank.bow] || DEFAULT_FILLET; }

// ── small mesh builder ───────────────────────────────────────────────────────
class Mesh {
  constructor() { this.pos = []; this.idx = []; }
  v(x, y, z) { this.pos.push(x, y, z); return this.pos.length / 3 - 1; }
  tri(a, b, c) { this.idx.push(a, b, c); }
  quad(a, b, c, d) { this.tri(a, b, c); this.tri(a, c, d); } // a-b-c-d CCW
}

// ── bitting: milled top-edge height h_top(L) in mm ───────────────────────────
export function topHeightFn(blank, code) {
  const s = blank.spec;
  const uncut = wardingFor(blank).height;                 // mm, blank top edge
  const run = Math.tan((s.cutAngle * Math.PI / 180) / 2); // wall run per depth
  const flatHalf = (s.cutFlat * IN_TO_MM) / 2;
  return (L) => {
    let h = uncut;
    for (let i = 0; i < s.positions; i++) {
      const c = cutCentre(s, i) * IN_TO_MM;
      const root = rootDepthForCode(s, code[i]) * IN_TO_MM;
      const dx = Math.abs(L - c);
      const edge = dx <= flatHalf ? root : root + (dx - flatHalf) / run;
      if (edge < h) h = edge;
    }
    return h;
  };
}

// Clip the warding profile so everything above `hTop` is removed, keeping a
// fixed vertex ordering: the two top corners (max h) become the two points where
// their side edges cross hTop. Assumes a single top span (true for these keyways
// while cuts stay above the grooves). Returns points ordered as a closed loop.
function clipProfileAtTop(profile, hTop) {
  const maxH = Math.max(...profile.map(p => p[1]));
  if (hTop >= maxH) return profile.slice();              // clip line at/above top: no-op
  // The top-corner vertices are the ones that rise ABOVE the clip line. Detect
  // them relative to hTop, not by exact-match to maxH: the two corners of the
  // top edge can differ by a few ×1e-4 (e.g. master 7.135900 vs 7.135700), and an
  // |h-maxH|<1e-6 test would flag only one — lowering a single corner and leaving
  // the other at full height, which blunts the tip. hTop is always kept above the
  // warding grooves, so the only vertices above it are that single top span.
  const isTop = profile.map(p => p[1] > hTop + 1e-9);
  const out = [];
  const n = profile.length;
  for (let i = 0; i < n; i++) {
    const cur = profile[i];
    if (!isTop[i]) { out.push(cur); continue; }
    // Replace this top corner with the intersection along the edge to its
    // nearest non-top neighbour (previous if it's below, else next).
    const prev = profile[(i - 1 + n) % n], next = profile[(i + 1) % n];
    const nb = !isTop[(i - 1 + n) % n] ? prev : next;
    const t = (hTop - nb[1]) / (cur[1] - nb[1]);          // nb → cur crosses hTop
    out.push([nb[0] + (cur[0] - nb[0]) * t, hTop]);
  }
  return out;
}

// Signed area of a (t,h) loop — to orient side-wall winding consistently.
function area2(loop) {
  let a = 0;
  for (let i = 0, n = loop.length; i < n; i++) {
    const p = loop[i], q = loop[(i + 1) % n];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}

// ── blade: loft the clipped cross-section along L ────────────────────────────
function addBlade(mesh, blank, code, weld = false, opts = {}) {
  const s = blank.spec;
  const w = wardingFor(blank);
  const hTopAt = topHeightFn(blank, code);
  const lastCut = cutCentre(s, s.positions - 1) * IN_TO_MM;
  // In flatTip mode (the CSG carve path) the blade runs full-height flat to the
  // very end and the nose is cut afterwards by two chamfer wedges; reserve enough
  // full-height length for the longer of the two tip ramps so the wedges have
  // solid material to carve. Otherwise keep the original weld-path rounded bevel.
  const flatTip = !!opts.flatTip;
  const ts = tipSpecFor(blank);
  const tipRamp = 3.5;                       // mm of tapered tip
  const tipFlat = 1.0;                       // mm of full-height blade past last cut
  const tipReserve = flatTip ? Math.max(ts.topRamp, ts.botRamp) + 0.8 : tipRamp;
  const tipL = lastCut + tipFlat + tipReserve;
  const rampStart = tipL - tipReserve;
  // Taper the tip by beveling the TOP edge down over the last few mm — NOT by
  // squeezing the whole cross-section toward the centreline (that compresses the
  // warding grooves into a section that won't enter the keyway). The warding
  // stays full-size; only the top comes down, like a real key tip. Use the same
  // top-clip path the bitting cuts use, so it stays watertight.
  const uncutH = w.height;
  // Don't bevel below the deepest legal cut depth — deeper than that dips into the
  // warding grooves (multi-span top) and the tip cap would leak. That depth is
  // designed to clear the wards, so it's exactly how far a real tip can ramp.
  const [clo, chi] = codeRange(s);
  let deepestRoot = uncutH;
  for (let c = clo; c <= chi; c++) deepestRoot = Math.min(deepestRoot, rootDepthForCode(s, c) * IN_TO_MM);
  const tipMinH = deepestRoot;
  // Round the nose: ease the top-edge bevel along a circular curve (not a straight
  // chamfer) so the tip reads like a factory key's rounded nose. Still a single
  // monotonic top span, so the cap stays watertight.
  const tipTop = flatTip
    ? () => Infinity                                        // flat top; wedges carve the nose
    : (L) => {
      if (L <= rampStart) return Infinity;
      const t = Math.min(1, (L - rampStart) / tipRamp);
      const ease = Math.sqrt(1 - (1 - t) * (1 - t));        // circular ease-out
      return uncutH - (uncutH - tipMinH) * ease;
    };

  // L breakpoints: cut centres, flat edges and wall feet, plus a fine grid, so
  // the milled V-cuts (and the tip ramp) are captured crisply.
  const bp = new Set([0, rampStart, tipL]);
  const flatHalf = (s.cutFlat * IN_TO_MM) / 2;
  const run = Math.tan((s.cutAngle * Math.PI / 180) / 2);
  const uncut = w.height;
  for (let i = 0; i < s.positions; i++) {
    const c = cutCentre(s, i) * IN_TO_MM;
    const root = rootDepthForCode(s, code[i]) * IN_TO_MM;
    const wall = (uncut - root) * run;                    // half-width of the V
    for (const L of [c - flatHalf - wall, c - flatHalf, c, c + flatHalf, c + flatHalf + wall]) {
      if (L > 0 && L < tipL) bp.add(L);
    }
  }
  for (let L = 0; L <= tipL; L += 0.4) bp.add(L);
  const stations = [...bp].sort((a, b) => a - b);

  // Clean the source cross-section once (drop rounding-duplicate closing points
  // that would otherwise leave a degenerate triangle in each end cap).
  // Mirror the thickness axis: keygen's 2D warding, extruded toward the tip in our
  // coordinate frame, comes out handed the opposite way from a real key (a
  // paracentric keyway is handed, so the mirror wouldn't enter). Flip t to match.
  const wprofile = dedupe(w.profile).map(([t, h]) => [-t, h]);
  // Clip the cross-section top at each station: the lower of the bitting height
  // and the tip bevel. Warding thickness/sides stay full so the tip fits.
  const ringLoops = stations.map(L => {
    const loop = clipProfileAtTop(wprofile, Math.min(hTopAt(L), tipTop(L)));
    return area2(loop) < 0 ? loop.slice().reverse() : loop; // CCW in t,h
  });
  // For welding, the bow is the SAME thickness as the blade (coplanar faces for
  // flat printing), so the blade's flat sides sit exactly on the bow neck
  // rectangle's edges — the weld cap would degenerate. Pull the shoulder ring's
  // flat sides in by a hair (grooves untouched) so it stays strictly inside the
  // neck; it tapers back to full thickness by the next station (a tiny shoulder
  // relief, hidden right where the bow meets the blade).
  if (weld && stations[0] === 0) {
    const lim = w.thickness / 2 - 0.15;
    ringLoops[0] = ringLoops[0].map(([t, h]) => [Math.sign(t) * Math.min(Math.abs(t), lim), h]);
  }
  const rings = stations.map((L, i) => ringLoops[i].map(([t, h]) => mesh.v(L, t, h)));

  const m = ringLoops[0].length;
  for (let r = 0; r < rings.length - 1; r++) {
    const A = rings[r], B = rings[r + 1];
    for (let k = 0; k < m; k++) {
      const k2 = (k + 1) % m;
      // wall quad between station r and r+1 (outward normal via CCW-in-t,h ring)
      mesh.quad(A[k], A[k2], B[k2], B[k]);
    }
  }

  // End caps (shoulder at L=0, tip at L=tipL), triangulated in (t,h).
  const capTris = (loop) => earcut(loop.flat(), null, 2);
  const cap = (ring, loop, atStart) => {
    const tris = capTris(loop);
    for (let i = 0; i < tris.length; i += 3) {
      // wind so the normal faces outward (−x at shoulder, +x at tip)
      if (atStart) mesh.tri(ring[tris[i]], ring[tris[i + 2]], ring[tris[i + 1]]);
      else mesh.tri(ring[tris[i]], ring[tris[i + 1]], ring[tris[i + 2]]);
    }
  };
  cap(rings[rings.length - 1], ringLoops[ringLoops.length - 1], false); // tip
  if (weld) return { ring: rings[0], loop: ringLoops[0] };               // shoulder open
  cap(rings[0], ringLoops[0], true);                                     // shoulder cap
  return null;
}

// Extrude a closed (x,h) outline (+ optional holes) along thickness y by ±t/2.
const DUP = 1e-3; // mm — past 4-decimal rounding noise in the source data
function dedupe(loop) {
  let out = [];
  for (const p of loop) {
    const q = out[out.length - 1];
    if (!q || Math.abs(p[0] - q[0]) > DUP || Math.abs(p[1] - q[1]) > DUP) out.push(p);
  }
  const f = out[0], l = out[out.length - 1];
  if (out.length > 1 && Math.abs(f[0] - l[0]) < DUP && Math.abs(f[1] - l[1]) < DUP) out.pop();
  // Drop collinear vertices (a straight run of ≥3 points) — redundant boundary
  // points make the earcut cap and the wall loop disagree and leak edges.
  const cross = (a, b, c) =>
    Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]));
  const keep = [];
  const n = out.length;
  for (let i = 0; i < n; i++) {
    const a = out[(i - 1 + n) % n], b = out[i], c = out[(i + 1) % n];
    if (cross(a, b, c) > 1e-6) keep.push(b);
  }
  return keep.length >= 3 ? keep : out;
}

function extrudePolyXH(mesh, outline, holes, thick) {
  outline = dedupe(outline);
  holes = holes.map(dedupe);
  const pts = outline.slice();
  const holeStarts = [];
  for (const h of holes) { holeStarts.push(pts.length); pts.push(...h); }
  const tris = earcut(pts.flat(), holeStarts.length ? holeStarts : null, 2);
  const y0 = -thick / 2, y1 = thick / 2;
  const front = pts.map(([x, h]) => mesh.v(x, y1, h));
  const back = pts.map(([x, h]) => mesh.v(x, y0, h));
  for (let i = 0; i < tris.length; i += 3) {
    mesh.tri(front[tris[i]], front[tris[i + 1]], front[tris[i + 2]]);
    mesh.tri(back[tris[i]], back[tris[i + 2]], back[tris[i + 1]]);
  }
  const wall = (n, off) => {
    for (let i = 0; i < n; i++) {
      const a = off + i, b = off + (i + 1) % n;
      mesh.quad(front[a], back[a], back[b], front[b]);
    }
  };
  wall(outline.length, 0);
  let off = outline.length;
  for (const h of holes) { wall(h.length, off); off += h.length; }
}

function bowKeyringHole(real, w) {
  // Keyring hole at the bow's area centroid (guaranteed inside the ornate shape),
  // nudged toward the far end. Returns a polygon in (x,h).
  let A = 0, cx = 0, ch = 0;
  for (let i = 0; i < real.length; i++) {
    const [x0, h0] = real[i], [x1, h1] = real[(i + 1) % real.length];
    const cr = x0 * h1 - x1 * h0; A += cr; cx += (x0 + x1) * cr; ch += (h0 + h1) * cr;
  }
  A *= 0.5; cx /= 6 * A; ch /= 6 * A;
  const minX = Math.min(...real.map(p => p[0]));
  const hx = cx * 0.5 + minX * 0.5, hr = Math.min(2.5, w.height / 3), hole = [];
  for (let deg = 0; deg < 360; deg += 18) { const r = deg * Math.PI / 180; hole.push([hx + hr * Math.cos(r), ch + hr * Math.sin(r)]); }
  return hole;
}

// ── parametric paddle bow (keyways without a keygen silhouette) ──────────────
// Tuned per family so BEST reads like a BEST bow, not the bare generic paddle.
// Fallback only — used when a blank has no keygen silhouette in bows.js. (BEST now
// has a real extracted bow, so it no longer lands here.)
const GENERIC_BOWS = {
  generic: { bowLen: 20, bowH: 22, neck: 5, flare: 3.0 },
};
function genericBowParams(blank, opts = {}) {
  return GENERIC_BOWS[opts.bowStyle || blank.bow] || GENERIC_BOWS.generic;
}

// Paddle-bow outline in (x,h): a rounded head on a slim neck, with concave "waist"
// fillets blending the neck into the paddle so the blade→bow transition is smooth
// (not a hard step), and fine arc segments so the curves read clean. `neckX` caps
// the open neck end — 0 for the welded build, +overlap for the CSG union. Order:
// shoulder-bottom → neck → bottom waist → far round end → top waist → shoulder-top.
function paddleBowOutline(w, p) {
  const H = w.height, midH = H / 2;
  const { bowLen, bowH, neck } = p, neckX = p.neckX ?? 0, seg = p.seg ?? 6;
  const flare = Math.min(p.flare ?? 3, neck - 0.5);
  const rEnd = bowH / 2, ry = bowH / 2 - H / 2;
  const xEndC = -neck - flare - (bowLen - rEnd);      // far-end arc centre
  const ell = (cx, cy, rx, rr, a0, a1) => {           // elliptical arc, a0→a1 in deg
    const n = Math.max(1, Math.round(Math.abs(a1 - a0) / seg)), o = [];
    for (let i = 0; i <= n; i++) { const a = (a0 + (a1 - a0) * i / n) * Math.PI / 180; o.push([cx + rx * Math.cos(a), cy + rr * Math.sin(a)]); }
    return o;
  };
  const pts = [[neckX, midH - H / 2], [-neck, midH - H / 2]];      // shoulder + neck bottom
  pts.push(...ell(-neck, midH - bowH / 2, flare, ry, 90, 180));    // bottom waist (concave)
  pts.push(...ell(xEndC, midH, rEnd, rEnd, -90, -270));            // far round end (far side)
  pts.push(...ell(-neck, midH + bowH / 2, flare, ry, 180, 270));   // top waist (concave)
  pts.push([-neck, midH + H / 2], [neckX, midH + H / 2]);          // neck + shoulder top
  return pts;
}

// ── bow (welded) ─────────────────────────────────────────────────────────────
// Weld the real manufacturer bow to the blade as ONE manifold — no overlapping
// shells (which slice as separate/voided parts under even-odd fill). The bow is a
// flat plate a touch thicker than the blade; its neck face at x=0 is the blade's
// warded cross-section punched out (the shoulder stop), and the blade's open
// shoulder ring plugs into that hole so the two share an edge loop.
function addBowWeld(mesh, blank, blade, opts = {}) {
  const bowId = opts.bowStyle || blank.bow;
  const src = getBow(bowId).map(([x, h]) => [x, h]);
  weldBowOutline(mesh, blank, blade, src, getBowHoles(bowId));
}

// Weld an open bow outline (points [x,h], neck endpoints first & last) to the
// blade's open shoulder ring, producing ONE manifold. Shared by the real
// manufacturer bows and the generic printable bow. `holeLoops` is an array of
// (x,h) loops (the real per-keyway keyring holes); null → a procedural circle.
function weldBowOutline(mesh, blank, blade, src, holeLoops = null) {
  const w = wardingFor(blank);
  const tb = w.thickness;                        // bow same thickness as blade →
                                                 // top/bottom faces coplanar so the
                                                 // whole key prints flat, no supports
  const real = [src[0]];                        // drop consecutive dups (open chain)
  for (let i = 1; i < src.length; i++) {
    const q = real[real.length - 1];
    if (Math.abs(src[i][0] - q[0]) > 1e-3 || Math.abs(src[i][1] - q[1]) > 1e-3) real.push(src[i]);
  }
  real[0][0] = 0; real[real.length - 1][0] = 0; // pull neck ends onto x=0
  // The neck weld face (rectangle R at x=0) must fully ENCLOSE the blade's
  // shoulder cross-section, or R\W is not a clean annulus and the cap leaks.
  // Some bows (Master) have a neck z-span narrower than the blade height, so
  // stretch the neck endpoints out to bracket the blade z-range with a margin.
  const bz0 = blade.loop.map(p => p[1]);
  const bladeZmin = Math.min(...bz0) - 0.5, bladeZmax = Math.max(...bz0) + 0.5;
  const nlast = real.length - 1;
  if (real[0][1] >= real[nlast][1]) {          // real[0] = neck top, real[last] = bottom
    real[0][1] = Math.max(real[0][1], bladeZmax);
    real[nlast][1] = Math.min(real[nlast][1], bladeZmin);
  } else {                                     // real[0] = neck bottom, real[last] = top
    real[0][1] = Math.min(real[0][1], bladeZmin);
    real[nlast][1] = Math.max(real[nlast][1], bladeZmax);
  }
  // Real per-keyway keyring hole(s) — Kwikset has three. Fall back to the
  // procedural circle if this bow has no extracted hole data. Orient each hole
  // OPPOSITE to the outer loop so earcut and the wall normals stay consistent.
  const realArea = area2(real);
  const holes = (holeLoops && holeLoops.length ? holeLoops : [bowKeyringHole(real, w)])
    .map(dedupe)
    .filter(h => h.length >= 3)
    .map(h => (area2(h) > 0) === (realArea > 0) ? h.slice().reverse() : h);
  const n = real.length, y0 = -tb / 2, y1 = tb / 2;
  const front = real.map(([x, h]) => mesh.v(x, y1, h));
  const back = real.map(([x, h]) => mesh.v(x, y0, h));
  const holeFB = holes.map(h => ({ f: h.map(([x, z]) => mesh.v(x, y1, z)), b: h.map(([x, z]) => mesh.v(x, y0, z)) }));

  // Front/back faces (bow outline with all keyring holes punched out).
  const capPts = real.slice(), starts = [];
  for (const h of holes) { starts.push(capPts.length); capPts.push(...h); }
  const fvAll = front.slice(), bvAll = back.slice();
  for (const hb of holeFB) { fvAll.push(...hb.f); bvAll.push(...hb.b); }
  const capT = earcut(capPts.flat(), starts, 2);
  for (let i = 0; i < capT.length; i += 3) {
    mesh.tri(fvAll[capT[i]], fvAll[capT[i + 1]], fvAll[capT[i + 2]]);
    mesh.tri(bvAll[capT[i]], bvAll[capT[i + 2]], bvAll[capT[i + 1]]);
  }
  // Perimeter walls — every edge EXCEPT the neck (last→first, the open x=0 side).
  for (let i = 0; i < n - 1; i++) mesh.quad(front[i], back[i], back[i + 1], front[i + 1]);
  // Keyring hole walls (one closed loop per hole).
  for (const hb of holeFB) {
    const hn = hb.f.length;
    for (let i = 0; i < hn; i++) { const j = (i + 1) % hn; mesh.quad(hb.f[i], hb.f[j], hb.b[j], hb.b[i]); }
  }

  // Neck weld face at x=0: rectangle R (bow thickness × neck height) minus the
  // blade cross-section W; its W hole shares the blade's shoulder ring.
  const az = real[0][1], bz = real[n - 1][1];               // neck top / bottom z
  const R = [[y1, bz], [y0, bz], [y0, az], [y1, az]];        // (y,z)
  const Rv = [front[n - 1], back[n - 1], back[0], front[0]];
  const weldT = earcut(R.concat(blade.loop).flat(), [4], 2);
  const wv = (k) => k < 4 ? Rv[k] : blade.ring[k - 4];
  for (let i = 0; i < weldT.length; i += 3) mesh.tri(wv(weldT[i]), wv(weldT[i + 1]), wv(weldT[i + 2]));
}

// ── bow (generic, fallback for keyways without a real bow, e.g. BEST) ─────────
// Built as an OPEN outline (shoulder → waisted neck → rounded far end → neck →
// shoulder) so it welds to the blade as one manifold, same as the real bows. The
// keyring hole is added by weldBowOutline from the outline centroid.
function addBow(mesh, blank, blade, opts = {}) {
  const w = wardingFor(blank);
  const outline = paddleBowOutline(w, { ...genericBowParams(blank, opts), neckX: 0 });
  weldBowOutline(mesh, blank, blade, outline);
}

// ── CSG parts: blade + bow as separate CLOSED solids (for the boolean union) ───
// The blade capped at both ends is already a closed solid.
export function bladeMesh(blank, code, opts = {}) {
  const mesh = new Mesh();
  addBlade(mesh, blank, code, false, opts);
  return { positions: new Float32Array(mesh.pos), indices: new Uint32Array(mesh.idx) };
}

// Concave shoulder fillet: build the (x,h) points that carry the bow-neck edge
// from its neck level (yNeck, at x=0) out to the blade edge level (yEdge) with a
// circular arc of radius R tangent to the blade edge. `sign` is +1 for the TOP
// edge (neck sits ABOVE the blade top; arc dips down to it) and -1 for the BACK
// edge (neck sits BELOW the blade back; arc rises up to it). Returns points from
// the neck end (x=0) to the tangent point (x=reach, h=yEdge); the caller adds the
// flat overlap run. Falls back to a straight chamfer if R can't span the step.
function shoulderFillet(yNeck, yEdge, R, sign, seg = 6) {
  const step = Math.abs(yNeck - yEdge);                 // shoulder step height
  if (step < 0.05) return [];                           // flush — no fillet
  const out = [];
  if (2 * R > step) {                                   // true circular arc
    const reach = Math.sqrt(step * (2 * R - step));     // x where arc meets the edge
    const cx = reach, cy = yEdge + sign * R;            // arc centre (tangent at edge)
    const aEdge = sign > 0 ? -90 : 90;                  // tangent-point angle (deg)
    // neck point (0,yNeck) relative to centre; take the MINOR arc to the edge
    // (bring aNeck within ±180° of aEdge so we sweep the short way, not around
    // the far side of the circle).
    let aNeck = Math.atan2(yNeck - cy, 0 - cx) * 180 / Math.PI;
    while (aNeck - aEdge > 180) aNeck -= 360;
    while (aEdge - aNeck > 180) aNeck += 360;
    const n = Math.max(2, Math.round(Math.abs(aEdge - aNeck) / seg));
    for (let i = 0; i <= n; i++) {
      const a = (aNeck + (aEdge - aNeck) * i / n) * Math.PI / 180;
      out.push([cx + R * Math.cos(a), cy + R * Math.sin(a)]);
    }
  } else {                                              // straight chamfer fallback
    const reach = Math.min(R, 2.4);
    out.push([0, yNeck], [reach, yEdge]);
  }
  return out;
}

// Bow outline in (x,h). Its neck reaches INTO the blade so the boolean union has
// overlapping material to fuse into one clean manifold; the overlap end is shaped
// with a concave shoulder fillet (per FILLET_SPECS) so the bow neck sweeps into
// the blade edge(s) instead of meeting them in a hard step.
export function bowOutline(blank, opts = {}) {
  const w = wardingFor(blank), H = w.height, midH = H / 2;
  const bowId = opts.bowStyle || blank.bow;
  const real = bowId ? getBow(bowId) : null;
  let outline;
  if (real) {
    const src = real.map(([x, h]) => [x, h]);          // drop consecutive dups
    const pts = [src[0]];
    for (let i = 1; i < src.length; i++) { const q = pts[pts.length - 1]; if (Math.abs(src[i][0] - q[0]) > 1e-3 || Math.abs(src[i][1] - q[1]) > 1e-3) pts.push(src[i]); }
    pts[0][0] = 0; pts[pts.length - 1][0] = 0;          // pin neck ends to x=0
    const bMax = pts[0][1], bMin = pts[pts.length - 1][1]; // neck top / bottom h
    const f = filletSpecFor(blank);
    const doTop = (f.edges === 'top' || f.edges === 'both');
    const doBot = (f.edges === 'back' || f.edges === 'both');
    const botF = doBot ? shoulderFillet(bMin, 0, f.R, -1) : [];
    const topF = doTop ? shoulderFillet(bMax, H, f.R, +1) : [];
    // Reach of each fillet (0 if none); overlap must clear the longer one.
    const reachB = botF.length ? botF[botF.length - 1][0] : 0;
    const reachT = topF.length ? topF[topF.length - 1][0] : 0;
    const overlap = Math.max(3, reachB + 0.6, reachT + 0.6);
    // Extension from neck bottom (pts[last]) around the +x side up to neck top
    // (pts[0]). Order: bottom fillet → blade-back → right edge → blade-top → top fillet.
    const ext = [];
    if (botF.length) for (let i = 1; i < botF.length; i++) ext.push(botF[i]); // (0,bMin)→(reachB,0), skip dup start
    ext.push([overlap, botF.length ? 0 : bMin]);
    ext.push([overlap, topF.length ? H : bMax]);
    if (topF.length) { const r = topF.slice().reverse(); for (let i = 0; i < r.length - 1; i++) ext.push(r[i]); } // (reachT,H)→(0,bMax), skip dup end
    outline = pts.concat(ext);
  } else {                                             // parametric paddle + waisted neck
    outline = paddleBowOutline(w, { ...genericBowParams(blank, opts), neckX: 3 });
  }
  return area2(outline) < 0 ? outline.reverse() : outline;   // CCW
}

// ── public API ───────────────────────────────────────────────────────────────
// Native hand-weld (synchronous fallback when the CSG engine can't load).
export function buildKeyMesh(blank, code, opts = {}) {
  const mesh = new Mesh();
  const wantBow = opts.bow !== false;
  const bowId = wantBow ? (opts.bowStyle || blank.bow) : null;
  const real = bowId ? getBow(bowId) : null;
  const blade = addBlade(mesh, blank, code, wantBow);
  if (real) addBowWeld(mesh, blank, blade, opts);
  else if (wantBow) addBow(mesh, blank, blade, opts);
  return { positions: new Float32Array(mesh.pos), indices: new Uint32Array(mesh.idx) };
}

// CSG assembly: union the blade (lofted triangle mesh) with the bow (Manifold's
// own robust extrude of the bow outline) into one clean manifold — keygen-style.
export async function buildKeyMeshCSG(blank, code, opts = {}) {
  const wasm = await initManifold(opts.wasmBinary);
  const { Manifold, Mesh: MMesh, CrossSection } = wasm;
  const w = wardingFor(blank);
  const tb = w.thickness;
  // Flat-topped blade: the nose is carved afterwards by two chamfer wedges.
  const bm = bladeMesh(blank, code, { flatTip: true });
  let key = new Manifold(new MMesh({ numProp: 3, vertProperties: bm.positions, triVerts: bm.indices }));

  // Extrude an (x,h) polygon(+holes) into the key frame (x=length, y=thickness,
  // z=height): extrude along Z by `thick`, centre, rotate Z→height / Y→thickness.
  const solidXH = (loops, thick) =>
    new CrossSection(loops, 'EvenOdd').extrude(thick).translate([0, 0, -thick / 2]).rotate([90, 0, 0]);

  if (opts.bow !== false) {
    const bowId = opts.bowStyle || blank.bow;
    const outline = bowOutline(blank, opts);
    // Real per-keyway keyring hole(s) (Kwikset has three); fall back to the
    // procedural circle only if this bow has no extracted hole data.
    const holes = getBowHoles(bowId) || [bowKeyringHole(outline, w)];
    const bow = solidXH([outline, ...holes], tb);
    key = key.add(bow);
  }

  // ── TIP nose: carve two chamfer wedges so the blade end is a rounded, keygen-
  // faithful asymmetric point (back edge rises + top edge falls to an apex at
  // apexFrac of the blade height). tipEndX = the flat blade's max x.
  const ts = tipSpecFor(blank);
  const bladeTop = w.height;
  const apexH = ts.apexFrac * bladeTop;
  let tipEndX = -Infinity;
  for (let i = 0; i < bm.positions.length; i += 3) if (bm.positions[i] > tipEndX) tipEndX = bm.positions[i];
  const wt = tb + 2;                                    // wedge spans full thickness
  const topWedge = [[tipEndX - ts.topRamp, bladeTop], [tipEndX, apexH], [tipEndX + 2, apexH], [tipEndX + 2, bladeTop + 3], [tipEndX - ts.topRamp, bladeTop + 3]];
  const backWedge = [[tipEndX - ts.botRamp, 0], [tipEndX, apexH], [tipEndX + 2, apexH], [tipEndX + 2, -3], [tipEndX - ts.botRamp, -3]];
  key = key.subtract(solidXH([topWedge], wt));
  key = key.subtract(solidXH([backWedge], wt));

  // ── DEBOSS: sink a shallow pocket into the UP face (+y) of the bow — a label or
  // the bitting code, engraved so it prints face-up (the blade cuts stay in the
  // bed plane). opts.debossLoops = array of (x,h) glyph loops already placed on
  // the bow (EvenOdd handles letter holes); opts.debossDepth mm (default 0.5).
  if (opts.debossLoops && opts.debossLoops.length) {
    const raised = opts.debossMode === 'raised';         // recessed (engrave) vs proud (raised)
    const d = Math.min((raised ? opts.embossHeight : opts.debossDepth) || (raised ? 0.4 : 0.5), tb * 0.6);
    const side = opts.debossSide || 'up';                // 'up' | 'down' | 'both'
    const stamp = (loops, zT) => new CrossSection(loops, 'EvenOdd').extrude(d).translate([0, 0, zT]).rotate([90, 0, 0]);
    // Engrave sinks a pocket into the face; raised stands a prism proud of it.
    // After rotate([90,0,0]) the extrude Z maps to −Y, so zT seats the slab on the
    // chosen face. UP = +y face, DOWN = −y face.
    const applyFace = (loops, up) => {
      const zT = up ? (raised ? -tb / 2 - d : -tb / 2) : (raised ? tb / 2 : tb / 2 - d);
      const s = stamp(loops, zT);
      key = raised ? key.add(s) : key.subtract(s);
    };
    const mirror = (loops) => {                           // flip x about the label centre
      let mn = Infinity, mx = -Infinity;
      for (const l of loops) for (const p of l) { if (p[0] < mn) mn = p[0]; if (p[0] > mx) mx = p[0]; }
      const c = (mn + mx) / 2;
      return loops.map(l => l.map(([x, h]) => [2 * c - x, h]));
    };
    // The glyphs are authored in the (x,h) plane; the UP (+y) face is VIEWED from
    // +y, which flips x (screen-right = −x), so mirror the up face to read right.
    // The DOWN (−y) face is viewed from −y and reads as-authored.
    if (side === 'up' || side === 'both') applyFace(mirror(opts.debossLoops), true);
    if (side === 'down' || side === 'both') applyFace(opts.debossLoops, false);
  }

  const out = key.getMesh();
  return { positions: out.vertProperties, indices: out.triVerts };
}

export function keyToSTL(blank, code, opts = {}) {
  const { positions, indices } = buildKeyMesh(blank, code, opts);
  return toBinarySTL(positions, indices, `${blank.id} ${code.join('-')}`);
}

export async function keyToSTLCSG(blank, code, opts = {}) {
  const { positions, indices } = await buildKeyMeshCSG(blank, code, opts);
  return toBinarySTL(positions, indices, `${blank.id} ${code.join('-')}`);
}
