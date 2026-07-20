// Solid generation: extrude a traced outline (with holes) by a thickness,
// with optional chamfer/fillet on the bottom and top edges, plus screw-hole
// features (through / blind / countersunk / counterbored, from either face).
//
// The outline and traced holes are handled as horizontal slices: each edge
// treatment maps to a stack of z-levels with an inward inset; slice outlines
// come from robust Clipper polygon offsetting; side walls "zip" consecutive
// slices by arc length (original vertices kept — sharp corners stay sharp);
// end caps are triangulated with earcut.
//
// Screw holes are meshed analytically (exact cones, cylinders, shelves and
// floors) when they sit fully inside the shape with room to spare; a hole
// that overlaps the outline, a traced hole, or another screw hole falls back
// to a plain Clipper through-hole with a warning. Output is a triangle mesh
// in mm, z-up, centred on the XY origin.

import earcut from '../vendor/earcut.js';
import { signedArea, polygonPerimeter } from './contour.js';

const CL = () => window.ClipperLib;
const SCALE = 1000; // Clipper integer units per mm

function toClipperPath(pts) {
  return pts.map(p => ({ X: Math.round(p.x * SCALE), Y: Math.round(p.y * SCALE) }));
}
function fromClipperPath(path) {
  return path.map(p => ({ x: p.X / SCALE, y: p.Y / SCALE }));
}

// Combine outline + holes into clean islands: [{ outer, holes }] in mm.
// Runs through a Clipper difference so self-intersections, holes overlapping
// the outline, and overlapping holes all resolve to well-formed polygons.
export function buildIslands(outerPts, holePolys) {
  const ClipperLib = CL();
  const subj = [toClipperPath(outerPts)];
  const clips = holePolys.map(toClipperPath);

  const clipper = new ClipperLib.Clipper();
  clipper.AddPaths(subj, ClipperLib.PolyType.ptSubject, true);
  if (clips.length) clipper.AddPaths(clips, ClipperLib.PolyType.ptClip, true);
  const tree = new ClipperLib.PolyTree();
  clipper.Execute(
    ClipperLib.ClipType.ctDifference, tree,
    ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero
  );
  const ex = ClipperLib.JS.PolyTreeToExPolygons(tree);
  const islands = [];
  for (const e of ex) {
    const outer = fromClipperPath(e.outer);
    if (Math.abs(signedArea(outer)) < 1) continue; // < 1 mm² — noise
    islands.push({ outer, holes: e.holes.map(fromClipperPath) });
  }
  return islands;
}

// z-levels for the edge profile. Returns ascending [{ z, inset }].
export function buildProfile(thickness, bottom, top, arcSegments = 8) {
  const t = thickness;
  const levels = [];
  const sB = bottom.mode === 'none' ? 0 : Math.min(bottom.size, t);
  const sT = top.mode === 'none' ? 0 : Math.min(top.size, t);

  // Bottom treatment: inset sB at z=0 easing to 0 at z=sB.
  if (bottom.mode === 'chamfer' && sB > 0) {
    levels.push({ z: 0, inset: sB }, { z: sB, inset: 0 });
  } else if (bottom.mode === 'fillet' && sB > 0) {
    for (let k = 0; k <= arcSegments; k++) {
      const th = (k / arcSegments) * Math.PI / 2;
      levels.push({ z: sB * (1 - Math.cos(th)), inset: sB * (1 - Math.sin(th)) });
    }
  } else {
    levels.push({ z: 0, inset: 0 });
  }

  // Straight wall section.
  const wallTop = t - sT;
  if (wallTop > levels[levels.length - 1].z + 1e-9) {
    if (levels[levels.length - 1].inset !== 0) levels.push({ z: levels[levels.length - 1].z, inset: 0 });
    levels.push({ z: wallTop, inset: 0 });
  }

  // Top treatment: inset 0 at z=t-sT easing to sT at z=t.
  if (top.mode === 'chamfer' && sT > 0) {
    levels.push({ z: t, inset: sT });
  } else if (top.mode === 'fillet' && sT > 0) {
    for (let k = 1; k <= arcSegments; k++) {
      const th = (k / arcSegments) * Math.PI / 2;
      levels.push({ z: (t - sT) + sT * Math.sin(th), inset: sT * (1 - Math.cos(th)) });
    }
  } else if (levels[levels.length - 1].z < t - 1e-9) {
    levels.push({ z: t, inset: 0 });
  }

  // Deduplicate identical consecutive levels.
  const out = [];
  for (const lv of levels) {
    const prev = out[out.length - 1];
    if (prev && Math.abs(prev.z - lv.z) < 1e-9 && Math.abs(prev.inset - lv.inset) < 1e-9) continue;
    out.push({ z: lv.z, inset: lv.inset });
  }
  if (out[out.length - 1].z < t - 1e-9) out.push({ z: t, inset: out[out.length - 1].inset });
  return out;
}

// Inward offset of an island by `inset` mm. Returns { outer, holes } or null
// if the offset empties the island or changes its topology.
function offsetIsland(island, inset) {
  if (inset <= 1e-9) return island;
  const ClipperLib = CL();
  const paths = [toClipperPath(island.outer), ...island.holes.map(toClipperPath)];
  const co = new ClipperLib.ClipperOffset(2, 0.05 * SCALE);
  co.AddPaths(paths, ClipperLib.JoinType.jtRound, ClipperLib.EndType.etClosedPolygon);
  const tree = new ClipperLib.PolyTree();
  co.Execute(tree, -inset * SCALE);
  const ex = ClipperLib.JS.PolyTreeToExPolygons(tree);
  if (ex.length !== 1) return null;
  if (ex[0].holes.length !== island.holes.length) return null;
  const outer = fromClipperPath(ex[0].outer);
  let holes = ex[0].holes.map(fromClipperPath);
  if (holes.length > 1) {
    // Re-order offset holes to match the base hole order (nearest centroid).
    const centroid = pts => {
      let x = 0, y = 0;
      for (const p of pts) { x += p.x; y += p.y; }
      return { x: x / pts.length, y: y / pts.length };
    };
    const baseC = island.holes.map(centroid);
    const offC = holes.map(centroid);
    const used = new Set();
    const ordered = [];
    for (const bc of baseC) {
      let best = -1, bestD = Infinity;
      for (let i = 0; i < offC.length; i++) {
        if (used.has(i)) continue;
        const d = (offC[i].x - bc.x) ** 2 + (offC[i].y - bc.y) ** 2;
        if (d < bestD) { bestD = d; best = i; }
      }
      if (best < 0) return null;
      used.add(best);
      ordered.push(holes[best]);
    }
    holes = ordered;
  }
  return { outer, holes };
}

// Normalize ring winding: CCW (positive signed area) if ccw=true.
function ensureWinding(pts, ccw) {
  const a = signedArea(pts);
  if ((a > 0) !== ccw) return pts.slice().reverse();
  return pts;
}

// Rotate ring start to the vertex nearest `refPt`.
function alignStart(pts, refPt) {
  let best = 0, bestD = Infinity;
  for (let i = 0; i < pts.length; i++) {
    const d = (pts[i].x - refPt.x) ** 2 + (pts[i].y - refPt.y) ** 2;
    if (d < bestD) { bestD = d; best = i; }
  }
  return pts.slice(best).concat(pts.slice(0, best));
}

// Cumulative arc-length parameters in [0, 1) for each vertex of a ring.
function ringParams(pts) {
  const per = polygonPerimeter(pts) || 1;
  const t = new Array(pts.length);
  let acc = 0;
  for (let i = 0; i < pts.length; i++) {
    t[i] = acc / per;
    const q = pts[(i + 1) % pts.length];
    acc += Math.hypot(q.x - pts[i].x, q.y - pts[i].y);
  }
  return t;
}

class MeshBuilder {
  constructor() {
    this.positions = [];
    this.indices = [];
  }
  addVertex(x, y, z) {
    this.positions.push(x, y, z);
    return this.positions.length / 3 - 1;
  }
  addTri(a, b, c) {
    this.indices.push(a, b, c);
  }
}

// Stitch ring A (at zA) to ring B (at zB) with a triangle band that keeps
// every original vertex. Both rings must share winding and aligned starts.
function zipRings(mb, ringA, zA, ringB, zB) {
  const tA = ringParams(ringA), tB = ringParams(ringB);
  const idxA = ringA.map(p => mb.addVertex(p.x, p.y, zA));
  const idxB = ringB.map(p => mb.addVertex(p.x, p.y, zB));
  const m = ringA.length, n = ringB.length;
  let i = 0, j = 0;
  while (i < m || j < n) {
    const nextA = i < m ? (i + 1 === m ? 1 : tA[i + 1]) : Infinity;
    const nextB = j < n ? (j + 1 === n ? 1 : tB[j + 1]) : Infinity;
    const ai = idxA[i % m], bj = idxB[j % n];
    if (nextA <= nextB) {
      const ai1 = idxA[(i + 1) % m];
      mb.addTri(ai, ai1, bj);
      i++;
    } else {
      const bj1 = idxB[(j + 1) % n];
      mb.addTri(bj, ai, bj1);
      j++;
    }
  }
}

// Triangulate a slice (outer + holes) with earcut and append at height z.
// up=true -> normal +z (top cap), up=false -> normal -z (bottom cap).
function addCap(mb, rings, z, up) {
  const flat = [];
  const holeIndices = [];
  for (let r = 0; r < rings.length; r++) {
    if (r > 0) holeIndices.push(flat.length / 2);
    for (const p of rings[r]) flat.push(p.x, p.y);
  }
  const tris = earcut(flat, holeIndices.length ? holeIndices : null, 2);
  const base = [];
  for (let i = 0; i < flat.length; i += 2) base.push(mb.addVertex(flat[i], flat[i + 1], z));

  // Earcut's output winding follows the input; normalize via the summed
  // cross-product sign so the cap faces the requested direction.
  let cross = 0;
  for (let i = 0; i < tris.length; i += 3) {
    const [a, b, c] = [tris[i], tris[i + 1], tris[i + 2]];
    const ax = flat[a * 2], ay = flat[a * 2 + 1];
    const bx = flat[b * 2], by = flat[b * 2 + 1];
    const cx = flat[c * 2], cy = flat[c * 2 + 1];
    cross += (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  }
  const flip = up ? cross < 0 : cross > 0;
  for (let i = 0; i < tris.length; i += 3) {
    if (flip) mb.addTri(base[tris[i]], base[tris[i + 2]], base[tris[i + 1]]);
    else mb.addTri(base[tris[i]], base[tris[i + 1]], base[tris[i + 2]]);
  }
}

// ---------- screw-hole feature geometry ----------

// Ring of N points around centre c at radius r (deterministic start angle so
// walls, shelves and caps share exact vertex coordinates).
function circleRing(c, r, N) {
  const pts = [];
  for (let k = 0; k < N; k++) {
    const a = (k / N) * Math.PI * 2;
    pts.push({ x: c.x + r * Math.cos(a), y: c.y + r * Math.sin(a) });
  }
  return pts;
}

// Cylinder/cone wall between (z0, r0) and (z1, r1), z0 < z1, normals facing
// the hole axis (outward from the material).
function emitBand(mb, c, z0, r0, z1, r1, N) {
  const A = circleRing(c, r0, N).map(p => mb.addVertex(p.x, p.y, z0));
  const B = circleRing(c, r1, N).map(p => mb.addVertex(p.x, p.y, z1));
  for (let k = 0; k < N; k++) {
    const k1 = (k + 1) % N;
    mb.addTri(A[k], B[k], A[k1]);
    mb.addTri(A[k1], B[k], B[k1]);
  }
}

// Horizontal annulus at z between rIn and rOut (rIn < rOut).
// up=true -> normal +z (a shelf you look down onto), else -z.
function emitFlat(mb, c, z, rIn, rOut, up, N) {
  const S = circleRing(c, rIn, N).map(p => mb.addVertex(p.x, p.y, z));
  const B = circleRing(c, rOut, N).map(p => mb.addVertex(p.x, p.y, z));
  for (let k = 0; k < N; k++) {
    const k1 = (k + 1) % N;
    if (up) {
      mb.addTri(S[k], B[k], S[k1]);
      mb.addTri(S[k1], B[k], B[k1]);
    } else {
      mb.addTri(S[k], S[k1], B[k]);
      mb.addTri(S[k1], B[k1], B[k]);
    }
  }
}

// Filled disc at z (blind-hole floor/ceiling). up=true -> normal +z.
function emitDisk(mb, c, z, r, up, N) {
  const P = circleRing(c, r, N).map(p => mb.addVertex(p.x, p.y, z));
  const C = mb.addVertex(c.x, c.y, z);
  for (let k = 0; k < N; k++) {
    const k1 = (k + 1) % N;
    if (up) mb.addTri(C, P[k], P[k1]);
    else mb.addTri(C, P[k1], P[k]);
  }
}

const csDepthOf = (csDia, d, angleDeg) =>
  (csDia - d) / 2 / Math.tan((angleDeg / 2) * Math.PI / 180);

// Turn a screw-hole description into wall bands / flats / discs and the face
// openings. c is the (already transformed) centre. Returns null if the hole
// should be skipped entirely.
function holeFeatures(c, t, warnings) {
  const r = c.d / 2;
  const top = c.side !== 'bottom';
  let type = c.type || 'through';

  if (type === 'blind') {
    const depth = c.depth || 0;
    if (depth <= 0.1) { warnings.push('Blind hole with no depth skipped.'); return null; }
    if (depth >= t - 0.15) {
      warnings.push('Blind hole depth ≥ thickness — made it a through hole.');
      type = 'through';
    }
  }
  if (type === 'cs') {
    if (!(c.csDia > c.d + 0.05)) {
      warnings.push('Countersink ⌀ not larger than the bore — plain through hole used.');
      type = 'through';
    }
  }
  if (type === 'cb') {
    if (!(c.cbDia > c.d + 0.05)) {
      warnings.push('Counterbore ⌀ not larger than the bore — plain through hole used.');
      type = 'cb-degenerate';
    } else if (c.cbDepth >= t - 0.15) {
      warnings.push('Counterbore depth ≥ thickness — hole enlarged to the counterbore ⌀.');
      return {
        bands: [{ z0: 0, r0: c.cbDia / 2, z1: t, r1: c.cbDia / 2 }],
        flats: [], disks: [],
        rBottom: c.cbDia / 2, rTop: c.cbDia / 2, maxR: c.cbDia / 2,
      };
    } else if (c.cbDepth <= 0.1) {
      warnings.push('Counterbore with no depth — plain through hole used.');
      type = 'cb-degenerate';
    }
  }
  if (type === 'cb-degenerate') type = 'through';

  if (type === 'through') {
    return {
      bands: [{ z0: 0, r0: r, z1: t, r1: r }],
      flats: [], disks: [],
      rBottom: r, rTop: r, maxR: r,
    };
  }

  if (type === 'blind') {
    const depth = c.depth;
    if (t - depth < 0.8) {
      warnings.push(`Blind hole leaves a thin floor (${(t - depth).toFixed(2)} mm).`);
    }
    if (top) {
      return {
        bands: [{ z0: t - depth, r0: r, z1: t, r1: r }],
        flats: [], disks: [{ z: t - depth, r, up: true }],
        rBottom: null, rTop: r, maxR: r,
      };
    }
    return {
      bands: [{ z0: 0, r0: r, z1: depth, r1: r }],
      flats: [], disks: [{ z: depth, r, up: false }],
      rBottom: r, rTop: null, maxR: r,
    };
  }

  if (type === 'cs') {
    const angle = c.csAngle || 90;
    let csR = c.csDia / 2;
    let depth = csDepthOf(c.csDia, c.d, angle);
    if (depth > t - 0.2) {
      // Truncate the cone so it never pierces the far face.
      depth = t - 0.2;
      csR = r + depth * Math.tan((angle / 2) * Math.PI / 180);
      warnings.push('Countersink truncated — deeper than the thickness allows.');
    }
    if (top) {
      const zC = t - depth;
      return {
        bands: [{ z0: 0, r0: r, z1: zC, r1: r }, { z0: zC, r0: r, z1: t, r1: csR }],
        flats: [], disks: [],
        rBottom: r, rTop: csR, maxR: csR,
      };
    }
    return {
      bands: [{ z0: 0, r0: csR, z1: depth, r1: r }, { z0: depth, r0: r, z1: t, r1: r }],
      flats: [], disks: [],
      rBottom: csR, rTop: r, maxR: csR,
    };
  }

  // Counterbore
  const cbR = c.cbDia / 2;
  const depth = c.cbDepth;
  if (top) {
    const zS = t - depth;
    return {
      bands: [{ z0: 0, r0: r, z1: zS, r1: r }, { z0: zS, r0: cbR, z1: t, r1: cbR }],
      flats: [{ z: zS, rIn: r, rOut: cbR, up: true }], disks: [],
      rBottom: r, rTop: cbR, maxR: cbR,
    };
  }
  return {
    bands: [{ z0: 0, r0: cbR, z1: depth, r1: cbR }, { z0: depth, r0: r, z1: t, r1: r }],
    flats: [{ z: depth, rIn: r, rOut: cbR, up: false }], disks: [],
    rBottom: cbR, rTop: r, maxR: cbR,
  };
}

// Apply a rim treatment (chamfer or fillet) to a hole's opening at one face.
// A rim chamfer is a 45° cone widening toward the face; a rim fillet is a
// quarter-round arc. Modifies feat in place. Skipped (with a warning where
// meaningful) when the face has no opening or already carries a countersink.
function applyRim(feat, face, t, edge, arcSegments, warnings) {
  if (!edge || edge.mode === 'none' || !(edge.size > 0)) return;
  if (face === 'top' ? feat.rTop === null : feat.rBottom === null) return; // no opening
  const idx = feat.bands.findIndex(b =>
    face === 'top' ? Math.abs(b.z1 - t) < 1e-9 : Math.abs(b.z0) < 1e-9);
  if (idx < 0) return;
  const b = feat.bands[idx];
  if (Math.abs(b.r0 - b.r1) > 1e-9) {
    warnings.push('Hole edge treatment skipped on a countersink face (the cone already breaks that edge).');
    return;
  }
  let s = edge.size;
  const h = b.z1 - b.z0;
  if (s > h - 0.05) {
    s = h - 0.05;
    if (s <= 0.01) { warnings.push('No room for a hole edge treatment — skipped.'); return; }
    warnings.push('Hole edge treatment reduced to fit the wall height.');
  }
  const r = b.r0;
  const arcs = Math.max(2, arcSegments);
  const newBands = [];
  if (face === 'top') {
    b.z1 = t - s;
    if (edge.mode === 'chamfer') {
      newBands.push({ z0: t - s, r0: r, z1: t, r1: r + s });
    } else {
      let prev = { z: t - s, r };
      for (let k = 1; k <= arcs; k++) {
        const th = (k / arcs) * Math.PI / 2;
        const pt = { z: (t - s) + s * Math.sin(th), r: r + s - s * Math.cos(th) };
        newBands.push({ z0: prev.z, r0: prev.r, z1: pt.z, r1: pt.r });
        prev = pt;
      }
    }
    feat.bands.splice(idx + 1, 0, ...newBands);
    feat.rTop = r + s;
  } else {
    b.z0 = s;
    if (edge.mode === 'chamfer') {
      newBands.push({ z0: 0, r0: r + s, z1: s, r1: r });
    } else {
      const pts = [];
      for (let k = 0; k <= arcs; k++) {
        const th = (k / arcs) * Math.PI / 2;
        pts.push({ z: s - s * Math.sin(th), r: r + s - s * Math.cos(th) });
      }
      pts.reverse(); // ascending z: (0, r+s) ... (s, r)
      for (let k = 0; k + 1 < pts.length; k++) {
        newBands.push({ z0: pts[k].z, r0: pts[k].r, z1: pts[k + 1].z, r1: pts[k + 1].r });
      }
    }
    feat.bands.splice(idx, 0, ...newBands);
    feat.rBottom = r + s;
  }
  feat.maxR = Math.max(feat.maxR, r + s);
}

// Shortest distance from a point to any segment of a set of rings.
function distToRings(pt, rings) {
  let best = Infinity;
  for (const ring of rings) {
    for (let i = 0, n = ring.length; i < n; i++) {
      const a = ring[i], b = ring[(i + 1) % n];
      const dx = b.x - a.x, dy = b.y - a.y;
      const len2 = dx * dx + dy * dy;
      let t = len2 > 0 ? ((pt.x - a.x) * dx + (pt.y - a.y) * dy) / len2 : 0;
      t = Math.max(0, Math.min(1, t));
      const px = a.x + dx * t, py = a.y + dy * t;
      best = Math.min(best, Math.hypot(px - pt.x, py - pt.y));
    }
  }
  return best;
}

function pointInPoly(pt, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const pi = poly[i], pj = poly[j];
    if ((pi.y > pt.y) !== (pj.y > pt.y) &&
        pt.x < (pj.x - pi.x) * (pt.y - pi.y) / (pj.y - pi.y) + pi.x) {
      inside = !inside;
    }
  }
  return inside;
}

// Build one prismatic solid (a single section of the model).
//
// outline / tracedHoles: mm polygons in image coordinates (y down).
// screwHoles: [{ cx, cy, d, type, side, ... , asBore }] — asBore forces a
//   plain through-bore (used when a hole merely passes through this section
//   and its recess/rim features belong to another section's face).
// params: { thickness, zBase, bottom: {mode, size}, top: {mode, size},
//           arcSegments, center: {cx, cy} }
//   zBase lifts the whole solid off the floor plane (overhangs);
//   center overrides the model origin so multiple sections share one frame.
// Returns { positions, indices, stats } or null.
export function buildSolid(outline, tracedHoles, screwHoles, params) {
  if (!outline || outline.length < 3) return null;
  const { thickness: t } = params;
  if (!(t > 0)) return null;
  const zBase = params.zBase || 0;
  const warnings = [];

  // Image y-down -> model y-up (mirror), then centre on origin.
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of outline) {
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
  }
  const cx0 = params.center ? params.center.cx : (minX + maxX) / 2;
  const cy0 = params.center ? params.center.cy : (minY + maxY) / 2;
  const tx = pts => pts.map(p => ({ x: p.x - cx0, y: cy0 - p.y }));

  const txOutline = tx(outline);
  const txTraced = (tracedHoles || []).map(tx);
  const circles = (screwHoles || []).map(c => ({
    ...c,
    x: c.cx - cx0, y: cy0 - c.cy,
  }));

  const sT = params.top.mode === 'none' ? 0 : Math.min(params.top.size, t);
  const sB = params.bottom.mode === 'none' ? 0 : Math.min(params.bottom.size, t);
  const edgeInset = Math.max(sT, sB);

  // Feature geometry per screw hole (may demote types with warnings), then
  // per-hole rim chamfers/fillets on each open face.
  const arcSeg = params.arcSegments || 8;
  for (const c of circles) {
    c.feat = holeFeatures(c.asBore ? { ...c, type: 'through' } : c, t, warnings);
    if (c.feat && !c.asBore) {
      applyRim(c.feat, 'top', t, c.edgeTop, arcSeg, warnings);
      applyRim(c.feat, 'bottom', t, c.edgeBottom, arcSeg, warnings);
    }
  }
  let live = circles.filter(c => c.feat);

  // Pairwise clearance: overlapping screw holes fall back to plain
  // through-holes handled by Clipper.
  const demoted = new Set();
  for (let i = 0; i < live.length; i++) {
    for (let j = i + 1; j < live.length; j++) {
      const a = live[i], b = live[j];
      const need = a.feat.maxR + b.feat.maxR + 0.25;
      if (Math.hypot(a.x - b.x, a.y - b.y) < need) {
        demoted.add(a); demoted.add(b);
      }
    }
  }
  if (demoted.size) {
    warnings.push('Overlapping screw holes merged as plain through holes (recess features dropped).');
  }

  // Clearance from the outline / traced holes (including room for the edge
  // treatment's inward offsets).
  const islands0 = buildIslands(txOutline, txTraced);
  if (!islands0.length) return null;
  for (const c of live) {
    if (demoted.has(c)) continue;
    const island = islands0.find(is =>
      pointInPoly(c, is.outer) && !is.holes.some(h => pointInPoly(c, h)));
    if (!island) {
      warnings.push('A screw hole lies outside the shape — treated as a plain cutout.');
      demoted.add(c);
      continue;
    }
    const margin = c.feat.maxR + edgeInset + 0.25;
    if (distToRings(c, [island.outer, ...island.holes]) < margin) {
      warnings.push('A screw hole is too close to an edge for its recess — plain through hole used.');
      demoted.add(c);
    }
  }

  const demotedPolys = [...demoted].map(c =>
    circleRing(c, Math.max(c.d, c.type === 'cb' ? c.cbDia || 0 : 0) / 2, 48));
  live = live.filter(c => !demoted.has(c));

  const islands = demoted.size
    ? buildIslands(txOutline, [...txTraced, ...demotedPolys])
    : islands0;
  if (!islands.length) return null;

  // Assign analytic holes to their (possibly re-built) islands.
  const perIsland = islands.map(() => []);
  for (const c of live) {
    const idx = islands.findIndex(is =>
      pointInPoly(c, is.outer) && !is.holes.some(h => pointInPoly(c, h)));
    if (idx >= 0) perIsland[idx].push(c);
    else warnings.push('A screw hole vanished from the shape and was skipped.');
  }

  const profile = buildProfile(t, params.bottom, params.top, params.arcSegments || 8);
  const mb = new MeshBuilder();
  let clamped = false;

  islands.forEach((island, islandIdx) => {
    // Slice outlines per level, clamping to the previous slice when an offset
    // collapses or splits the island (keeps the mesh closed; the treatment
    // just flattens out where the shape is too small for it).
    const slices = [];
    let prev = null;
    for (const lv of profile) {
      let slice = offsetIsland(island, lv.inset);
      if (!slice) { slice = prev || island; clamped = clamped || lv.inset > 1e-9; }
      let outer = ensureWinding(slice.outer, true);
      let hs = slice.holes.map(hp => ensureWinding(hp, false));
      if (prev) {
        outer = alignStart(outer, prev.outer[0]);
        hs = hs.map((hp, i) => alignStart(hp, (prev.holes[i] || hp)[0]));
      }
      slice = { outer, holes: hs };
      slices.push({ z: lv.z, ...slice });
      prev = slice;
    }

    // Outline / traced-hole walls.
    for (let i = 0; i + 1 < slices.length; i++) {
      const a = slices[i], b = slices[i + 1];
      if (Math.abs(a.z - b.z) < 1e-9) continue;
      zipRings(mb, a.outer, a.z, b.outer, b.z);
      for (let hIdx = 0; hIdx < a.holes.length; hIdx++) {
        zipRings(mb, a.holes[hIdx], a.z, b.holes[hIdx] || a.holes[hIdx], b.z);
      }
    }

    // Screw-hole feature surfaces. Ring resolution follows a chord tolerance
    // (smaller = smoother, more triangles) set by the export quality preset.
    const chordTol = params.chordTol || 0.35;
    const holesHere = perIsland[islandIdx];
    for (const c of holesHere) {
      const N = c.ringN = Math.max(24, Math.min(256, Math.round(2 * Math.PI * c.feat.maxR / chordTol)));
      for (const b of c.feat.bands) emitBand(mb, c, b.z0, b.r0, b.z1, b.r1, N);
      for (const f of c.feat.flats) emitFlat(mb, c, f.z, f.rIn, f.rOut, f.up, N);
      for (const d of c.feat.disks) emitDisk(mb, c, d.z, d.r, d.up, N);
    }

    // Caps (screw-hole openings become extra earcut holes).
    const bot = slices[0], top = slices[slices.length - 1];
    const botCircle = holesHere
      .filter(c => c.feat.rBottom !== null)
      .map(c => circleRing(c, c.feat.rBottom, c.ringN));
    const topCircle = holesHere
      .filter(c => c.feat.rTop !== null)
      .map(c => circleRing(c, c.feat.rTop, c.ringN));
    addCap(mb, [bot.outer, ...bot.holes, ...botCircle], bot.z, false);
    addCap(mb, [top.outer, ...top.holes, ...topCircle], top.z, true);
  });

  const positions = new Float32Array(mb.positions);
  if (zBase !== 0) {
    for (let i = 2; i < positions.length; i += 3) positions[i] += zBase;
  }
  const indices = new Uint32Array(mb.indices);

  return {
    positions,
    indices,
    stats: {
      triangles: indices.length / 3,
      islands: islands.length,
      sizeX: maxX - minX,
      sizeY: maxY - minY,
      sizeZ: t,
      zBase,
      zTop: zBase + t,
      clamped,
      warnings,
    },
  };
}

// Build the whole model from sections ("regions"), each an independent
// watertight prism: footprint × [zBase, zBase + thickness]. Overlapping
// sections are exported as overlapping closed shells — slicers union them.
//
// regions: [{ name, pts (null -> use `outer`), thickness, zBase, top, bottom }]
// Screw holes cut every region whose footprint contains them; the recess /
// blind / rim features apply on the true entry face — the region with the
// highest top for side="top" holes, the lowest bottom for side="bottom" —
// and everywhere else the hole is a plain bore.
export function buildModel(outer, tracedHoles, screwHoles, regions, opts) {
  if (!outer || outer.length < 3 || !regions || !regions.length) return null;
  // opts may be a number (legacy arcSegments) or { arcSegments, chordTol }.
  const arcSegments = typeof opts === 'number' ? opts : (opts && opts.arcSegments) || 8;
  const chordTol = (opts && typeof opts === 'object' && opts.chordTol) || 0.35;
  const warnings = [];

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of outer) {
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
  }
  const center = { cx: (minX + maxX) / 2, cy: (minY + maxY) / 2 };

  const footprints = regions.map(r => (r.pts && r.pts.length >= 3 ? r.pts : outer));

  // Assign screw holes: which regions does each cut, and which face is entry?
  const perRegion = regions.map(() => []);
  for (const h of screwHoles || []) {
    const containing = [];
    for (let i = 0; i < regions.length; i++) {
      if (pointInPoly({ x: h.cx, y: h.cy }, footprints[i])) containing.push(i);
    }
    if (!containing.length) {
      warnings.push('A screw hole lies outside every section and was skipped.');
      continue;
    }
    let entry = containing[0];
    for (const i of containing) {
      const better = (h.side === 'bottom')
        ? (regions[i].zBase || 0) < (regions[entry].zBase || 0)
        : (regions[i].zBase || 0) + regions[i].thickness >
          (regions[entry].zBase || 0) + regions[entry].thickness;
      if (better) entry = i;
    }
    for (const i of containing) {
      perRegion[i].push(i === entry ? h : { ...h, asBore: true });
    }
  }

  const parts = [];
  let totalTris = 0, clamped = false;
  let zLo = Infinity, zHi = -Infinity;
  regions.forEach((r, i) => {
    let { thickness, zBase = 0, top, bottom } = r;
    if (!(thickness > 0)) { warnings.push(`Section "${r.name || i + 1}" has no thickness — skipped.`); return; }
    // Edge treatments cannot exceed the section's thickness.
    top = { ...(top || { mode: 'none', size: 0 }) };
    bottom = { ...(bottom || { mode: 'none', size: 0 }) };
    const sT = top.mode === 'none' ? 0 : top.size;
    const sB = bottom.mode === 'none' ? 0 : bottom.size;
    if (sT + sB > thickness) {
      const k = thickness / (sT + sB) * 0.999;
      top.size = sT * k; bottom.size = sB * k;
      warnings.push(`Section "${r.name || i + 1}": edge sizes exceeded the thickness — scaled to fit.`);
    }
    const mesh = buildSolid(footprints[i], tracedHoles, perRegion[i], {
      thickness, zBase, top, bottom, arcSegments, chordTol, center,
    });
    if (!mesh) {
      warnings.push(`Section "${r.name || i + 1}" produced no solid — check its outline.`);
      return;
    }
    parts.push(mesh);
    totalTris += mesh.stats.triangles;
    clamped = clamped || mesh.stats.clamped;
    warnings.push(...mesh.stats.warnings.map(w =>
      regions.length > 1 ? `Section "${r.name || i + 1}": ${w}` : w));
    zLo = Math.min(zLo, zBase);
    zHi = Math.max(zHi, zBase + thickness);
  });
  if (!parts.length) return null;

  const positions = new Float32Array(parts.reduce((n, p) => n + p.positions.length, 0));
  const indices = new Uint32Array(parts.reduce((n, p) => n + p.indices.length, 0));
  let vOff = 0, iOff = 0;
  for (const p of parts) {
    positions.set(p.positions, vOff * 3);
    for (let k = 0; k < p.indices.length; k++) indices[iOff + k] = p.indices[k] + vOff;
    vOff += p.positions.length / 3;
    iOff += p.indices.length;
  }

  return {
    positions,
    indices,
    stats: {
      triangles: totalTris,
      sections: parts.length,
      islands: parts.reduce((n, p) => n + p.stats.islands, 0),
      sizeX: maxX - minX,
      sizeY: maxY - minY,
      sizeZ: zHi - zLo,
      zBase: zLo,
      zTop: zHi,
      clamped,
      warnings,
    },
  };
}

// Circle -> polygon (used for SVG export and legacy paths), mm, image coords.
export function circleToPolygon(cx, cy, dia, segments = 64) {
  const r = dia / 2;
  const pts = [];
  for (let i = 0; i < segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    pts.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
  }
  return pts;
}
