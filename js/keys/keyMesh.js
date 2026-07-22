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
import { getBow } from './bows.js';
import { initManifold } from './manifold-loader.js';

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
  // indices of the top-corner vertices (at maxH)
  const isTop = profile.map(p => Math.abs(p[1] - maxH) < 1e-6);
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
function addBlade(mesh, blank, code, weld = false) {
  const s = blank.spec;
  const w = wardingFor(blank);
  const hTopAt = topHeightFn(blank, code);
  const lastCut = cutCentre(s, s.positions - 1) * IN_TO_MM;
  const tipRamp = 3.5;                       // mm of tapered tip
  const tipFlat = 1.0;                       // mm of full-height blade past last cut
  const tipL = lastCut + tipFlat + tipRamp;
  const rampStart = tipL - tipRamp;
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
  const tipTop = (L) => {
    if (L <= rampStart) return Infinity;
    const t = Math.min(1, (L - rampStart) / tipRamp);
    const ease = Math.sqrt(1 - (1 - t) * (1 - t));         // circular ease-out
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
const GENERIC_BOWS = {
  generic: { bowLen: 20, bowH: 22,   neck: 5,   flare: 3.0 },
  best:    { bowLen: 23, bowH: 25.5, neck: 4.5, flare: 3.6 },  // fuller SFIC-style head
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
  const src = getBow(opts.bowStyle || blank.bow).map(([x, h]) => [x, h]);
  weldBowOutline(mesh, blank, blade, src);
}

// Weld an open bow outline (points [x,h], neck endpoints first & last) to the
// blade's open shoulder ring, producing ONE manifold. Shared by the real
// manufacturer bows and the generic printable bow.
function weldBowOutline(mesh, blank, blade, src) {
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
  const hole = bowKeyringHole(real, w);
  const n = real.length, y0 = -tb / 2, y1 = tb / 2;
  const front = real.map(([x, h]) => mesh.v(x, y1, h));
  const back = real.map(([x, h]) => mesh.v(x, y0, h));
  const hf = hole.map(([x, h]) => mesh.v(x, y1, h));
  const hb = hole.map(([x, h]) => mesh.v(x, y0, h));

  // Front/back faces (bow outline with the keyring hole).
  const capT = earcut(real.concat(hole).flat(), [n], 2);
  const fv = (k) => k < n ? front[k] : hf[k - n], bv = (k) => k < n ? back[k] : hb[k - n];
  for (let i = 0; i < capT.length; i += 3) {
    mesh.tri(fv(capT[i]), fv(capT[i + 1]), fv(capT[i + 2]));
    mesh.tri(bv(capT[i]), bv(capT[i + 2]), bv(capT[i + 1]));
  }
  // Perimeter walls — every edge EXCEPT the neck (last→first, the open x=0 side).
  for (let i = 0; i < n - 1; i++) mesh.quad(front[i], back[i], back[i + 1], front[i + 1]);
  // Keyring hole walls.
  const hn = hole.length;
  for (let i = 0; i < hn; i++) { const j = (i + 1) % hn; mesh.quad(hf[i], hf[j], hb[j], hb[i]); }

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
export function bladeMesh(blank, code) {
  const mesh = new Mesh();
  addBlade(mesh, blank, code, false);
  return { positions: new Float32Array(mesh.pos), indices: new Uint32Array(mesh.idx) };
}

// Bow outline in (x,h). Its neck reaches `overlap` mm INTO the blade so the
// boolean union has overlapping material to fuse into one clean manifold.
export function bowOutline(blank, opts = {}) {
  const w = wardingFor(blank), H = w.height, midH = H / 2, overlap = 3;
  const bowId = opts.bowStyle || blank.bow;
  const real = bowId ? getBow(bowId) : null;
  let outline;
  if (real) {
    const src = real.map(([x, h]) => [x, h]);          // drop consecutive dups
    const pts = [src[0]];
    for (let i = 1; i < src.length; i++) { const q = pts[pts.length - 1]; if (Math.abs(src[i][0] - q[0]) > 1e-3 || Math.abs(src[i][1] - q[1]) > 1e-3) pts.push(src[i]); }
    pts[0][0] = 0; pts[pts.length - 1][0] = 0;          // pin neck ends to x=0
    outline = pts.concat([[overlap, pts[pts.length - 1][1]], [overlap, pts[0][1]]]);
  } else {                                             // parametric paddle + waisted neck
    outline = paddleBowOutline(w, { ...genericBowParams(blank, opts), neckX: overlap });
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
  const bm = bladeMesh(blank, code);
  let key = new Manifold(new MMesh({ numProp: 3, vertProperties: bm.positions, triVerts: bm.indices }));
  if (opts.bow !== false) {
    const tb = wardingFor(blank).thickness;
    const cs = new CrossSection([bowOutline(blank, opts), bowKeyringHole(bowOutline(blank, opts), wardingFor(blank))], 'EvenOdd');
    // Extrude along Z by the thickness, centre it, then rotate so Z→height, Y→thickness.
    const bow = cs.extrude(tb).translate([0, 0, -tb / 2]).rotate([90, 0, 0]);
    key = key.add(bow);
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
