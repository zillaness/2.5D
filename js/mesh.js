// Solid generation: extrude a traced outline (with holes) by a thickness,
// with optional chamfer/fillet on the bottom and top edges.
//
// Approach: build horizontal slices. Each edge treatment maps to a stack of
// z-levels with an inward inset; slice outlines come from robust Clipper
// polygon offsetting. Side walls "zip" consecutive slices together by arc
// length (original vertices are kept exactly — sharp corners stay sharp), and
// the end caps are triangulated with earcut. Output is a triangle mesh in mm,
// z-up, centred on the XY origin.

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

  // Deduplicate / enforce strictly ascending z (allow the two-point vertical
  // jumps only where inset changes at same z — those get filtered).
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

// Build the full solid.
//
// outline/holes: mm in image coordinates (y down); manual hole circles are
// already converted to polygons by the caller.
// params: { thickness, bottom: {mode, size}, top: {mode, size}, arcSegments }
// Returns { positions: Float32Array, indices: Uint32Array, stats } or null.
export function buildSolid(outline, holes, params) {
  if (!outline || outline.length < 3) return null;
  const { thickness } = params;
  if (!(thickness > 0)) return null;

  // Image y-down -> model y-up (mirror), then centre on origin.
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of outline) {
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
  }
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  const tx = pts => pts.map(p => ({ x: p.x - cx, y: cy - p.y }));

  const islands = buildIslands(tx(outline), holes.map(tx));
  if (!islands.length) return null;

  const profile = buildProfile(thickness, params.bottom, params.top, params.arcSegments || 8);
  const mb = new MeshBuilder();
  let clamped = false;

  for (const island of islands) {
    // Slice outlines per level, clamping to the previous slice when an offset
    // collapses or splits the island (keeps the mesh closed; the treatment
    // just flattens out where the shape is too small for it).
    const slices = [];
    let prev = null;
    for (const lv of profile) {
      let slice = offsetIsland(island, lv.inset);
      if (!slice) { slice = prev || island; clamped = clamped || lv.inset > 1e-9; }
      // Normalize winding: outer CCW, holes CW; align starts to previous slice.
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

    // Walls.
    for (let i = 0; i + 1 < slices.length; i++) {
      const a = slices[i], b = slices[i + 1];
      if (Math.abs(a.z - b.z) < 1e-9) continue;
      zipRings(mb, a.outer, a.z, b.outer, b.z);
      for (let hIdx = 0; hIdx < a.holes.length; hIdx++) {
        zipRings(mb, a.holes[hIdx], a.z, b.holes[hIdx] || a.holes[hIdx], b.z);
      }
    }

    // Caps.
    const bot = slices[0], top = slices[slices.length - 1];
    addCap(mb, [bot.outer, ...bot.holes], bot.z, false);
    addCap(mb, [top.outer, ...top.holes], top.z, true);
  }

  const positions = new Float32Array(mb.positions);
  const indices = new Uint32Array(mb.indices);

  return {
    positions,
    indices,
    stats: {
      triangles: indices.length / 3,
      islands: islands.length,
      sizeX: maxX - minX,
      sizeY: maxY - minY,
      sizeZ: thickness,
      clamped,
    },
  };
}

// Circle -> polygon (for manual holes), mm, image coords.
export function circleToPolygon(cx, cy, dia, segments = 64) {
  const r = dia / 2;
  const pts = [];
  for (let i = 0; i < segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    pts.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
  }
  return pts;
}
