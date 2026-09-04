// Holders & organizers: generators that build printable *negatives* of the
// traced object — a foam-style insert now; drawer layouts, Gridfinity bins
// and holsters follow (see docs/holders-prd.md). Everything stays 2D
// footprint work: Clipper offsets + the buildSolid prism/recess machinery —
// no 3D CSG kernel (locked scope rule).
//
// The foam pocket reuses the single-shell deboss construction: the pocket is
// a blind recess whose "glyph" is the tool outline offset outward by the
// clearance, and the tool's traced holes become standing support pillars
// exactly the way letter counters stay standing in a debossed label.

import {
  buildSolid, circleToPolygon,
  MeshBuilder, zipRings, addCap, circleRing, emitBand, emitDisk,
} from './mesh.js';
import { signedArea } from './contour.js';

const CL = () => window.ClipperLib;
const SCALE = 1000; // Clipper integer units per mm

const toClipperPath = pts =>
  pts.map(p => ({ X: Math.round(p.x * SCALE), Y: Math.round(p.y * SCALE) }));
const fromClipperPath = path =>
  path.map(p => ({ x: p.X / SCALE, y: p.Y / SCALE }));

// Ensure a Clipper path is positively oriented (so +delta always inflates).
function positivePath(path) {
  return CL().Clipper.Orientation(path) ? path : path.slice().reverse();
}

// Offset a closed loop by `delta` mm (+ = outward, − = inward), round joins.
// Returns loops sorted largest-first (an inward offset can split or vanish).
export function offsetLoop(pts, delta) {
  const ClipperLib = CL();
  if (!pts || pts.length < 3) return [];
  const co = new ClipperLib.ClipperOffset(2, 0.05 * SCALE);
  co.AddPath(positivePath(toClipperPath(pts)), ClipperLib.JoinType.jtRound,
    ClipperLib.EndType.etClosedPolygon);
  const sol = new ClipperLib.Paths();
  co.Execute(sol, delta * SCALE);
  return sol.map(fromClipperPath)
    .sort((a, b) => Math.abs(signedArea(b)) - Math.abs(signedArea(a)));
}

// Union of simple loops (any winding) -> outer loops, largest first.
export function unionLoops(loops) {
  const ClipperLib = CL();
  const clipper = new ClipperLib.Clipper();
  clipper.AddPaths(loops.map(l => positivePath(toClipperPath(l))),
    ClipperLib.PolyType.ptSubject, true);
  const sol = new ClipperLib.Paths();
  clipper.Execute(
    ClipperLib.ClipType.ctUnion, sol,
    ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero
  );
  return sol.filter(p => ClipperLib.Clipper.Orientation(p))
    .map(fromClipperPath)
    .sort((a, b) => Math.abs(signedArea(b)) - Math.abs(signedArea(a)));
}

// Rounded rectangle loop centred at (cx, cy), fixed segments per corner so
// two rounded rects of any size zip 1:1 (the Gridfinity lofts rely on this).
export function roundedRect(cx, cy, w, h, r, segs = 10) {
  const rr = Math.max(0, Math.min(r, w / 2 - 0.01, h / 2 - 0.01));
  const x0 = cx - w / 2, x1 = cx + w / 2, y0 = cy - h / 2, y1 = cy + h / 2;
  const pts = [];
  const corner = (ccx, ccy, a0) => {
    for (let k = 0; k <= segs; k++) {
      const a = a0 + (k / segs) * Math.PI / 2;
      pts.push({ x: ccx + rr * Math.cos(a), y: ccy + rr * Math.sin(a) });
    }
  };
  // y-down trace space; order gives a consistent closed ring.
  corner(x1 - rr, y1 - rr, 0);            // bottom-right
  corner(x0 + rr, y1 - rr, Math.PI / 2);  // bottom-left
  corner(x0 + rr, y0 + rr, Math.PI);      // top-left
  corner(x1 - rr, y0 + rr, 3 * Math.PI / 2); // top-right
  return pts;
}

// Closest point on a closed loop's boundary to pt.
export function closestOnLoop(loop, pt) {
  let best = null, bestD = Infinity;
  for (let i = 0, n = loop.length; i < n; i++) {
    const a = loop[i], b = loop[(i + 1) % n];
    const dx = b.x - a.x, dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    let t = len2 > 0 ? ((pt.x - a.x) * dx + (pt.y - a.y) * dy) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    const q = { x: a.x + dx * t, y: a.y + dy * t };
    const d = (q.x - pt.x) ** 2 + (q.y - pt.y) ** 2;
    if (d < bestD) { bestD = d; best = q; }
  }
  return best;
}

// Point at an arc-length fraction (0..1) along a closed loop.
export function pointAtFrac(loop, frac) {
  let per = 0;
  for (let i = 0, n = loop.length; i < n; i++) {
    const a = loop[i], b = loop[(i + 1) % n];
    per += Math.hypot(b.x - a.x, b.y - a.y);
  }
  if (!(per > 0)) return loop[0];
  let target = ((frac % 1) + 1) % 1 * per;
  for (let i = 0, n = loop.length; i < n; i++) {
    const a = loop[i], b = loop[(i + 1) % n];
    const seg = Math.hypot(b.x - a.x, b.y - a.y);
    if (target <= seg) {
      const t = seg > 0 ? target / seg : 0;
      return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
    }
    target -= seg;
  }
  return loop[0];
}

// Where the boundary crosses the middle of a screen side (legacy notch
// anchor): the extreme-most crossing of the bbox-centre axis.
function sideCrossing(loop, side) {
  const bb0 = bboxOf(loop);
  const cx0 = (bb0.minX + bb0.maxX) / 2, cy0 = (bb0.minY + bb0.maxY) / 2;
  const vertical = side === 'top' || side === 'bottom';
  let best = null;
  for (let i = 0, n = loop.length; i < n; i++) {
    const a = loop[i], b = loop[(i + 1) % n];
    let pt = null;
    if (vertical) {
      if ((a.x - cx0) * (b.x - cx0) > 0 || a.x === b.x) continue;
      const t = (cx0 - a.x) / (b.x - a.x);
      pt = { x: cx0, y: a.y + t * (b.y - a.y) };
    } else {
      if ((a.y - cy0) * (b.y - cy0) > 0 || a.y === b.y) continue;
      const t = (cy0 - a.y) / (b.y - a.y);
      pt = { x: a.x + t * (b.x - a.x), y: cy0 };
    }
    const better = best === null ||
      (side === 'bottom' && pt.y > best.y) || (side === 'top' && pt.y < best.y) ||
      (side === 'right' && pt.x > best.x) || (side === 'left' && pt.x < best.x);
    if (better) best = pt;
  }
  return best;
}

// Union a finger-notch circle into a pocket. spec: { dia } plus one of
// { frac } (perimeter fraction), { x, y } (snapped to the boundary), or
// { side } ('top'|'bottom'|'left'|'right'). Returns the (new) pocket, and
// the resolved centre via spec._at for callers that draw a marker.
export function applyNotch(pocket, spec) {
  if (!pocket || !spec || !(spec.dia > 2)) return pocket;
  let c = null;
  if (typeof spec.frac === 'number') c = pointAtFrac(pocket, spec.frac);
  else if (Number.isFinite(spec.x) && Number.isFinite(spec.y)) c = closestOnLoop(pocket, spec);
  else if (spec.side) c = sideCrossing(pocket, spec.side);
  if (!c) return pocket;
  spec._at = c;
  return unionLoops([pocket, circleToPolygon(c.x, c.y, spec.dia, 48)])[0] || pocket;
}

// Transform a point with an item's placement (same math as placeLoop).
export function placePoint(item, pt) {
  const bb = bboxOf(item.outer);
  const c = { x: (bb.minX + bb.maxX) / 2, y: (bb.minY + bb.maxY) / 2 };
  const a = ((item.rot || 0) * Math.PI) / 180;
  const cos = Math.cos(a), sin = Math.sin(a);
  const dx = pt.x - c.x, dy = pt.y - c.y;
  return { x: item.x + dx * cos - dy * sin, y: item.y + dx * sin + dy * cos };
}
// Inverse: a world/layout point back into the item's local outline frame.
export function worldToItemLocal(item, pt) {
  const bb = bboxOf(item.outer);
  const c = { x: (bb.minX + bb.maxX) / 2, y: (bb.minY + bb.maxY) / 2 };
  const a = -(((item.rot || 0) * Math.PI) / 180);
  const cos = Math.cos(a), sin = Math.sin(a);
  const dx = pt.x - item.x, dy = pt.y - item.y;
  return { x: c.x + dx * cos - dy * sin, y: c.y + dx * sin + dy * cos };
}

const bboxOf = pts => {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pts) {
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
  }
  return { minX, minY, maxX, maxY, w: maxX - minX, h: maxY - minY };
};

// ---------- multi-tool layout (drawer / toolbox inserts) ----------

// Place a library loop: rotate about the reference loop's bbox centre (the
// tool OUTLINE — pass it explicitly when placing the tool's holes, so they
// keep their offset within the tool), then move that centre to (x, y).
// Layout space is mm, y down (same as trace space).
export function placeLoop(pts, item, ref = pts) {
  const bb = bboxOf(ref);
  const c = { x: (bb.minX + bb.maxX) / 2, y: (bb.minY + bb.maxY) / 2 };
  const a = ((item.rot || 0) * Math.PI) / 180;
  const cos = Math.cos(a), sin = Math.sin(a);
  return pts.map(p => {
    const dx = p.x - c.x, dy = p.y - c.y;
    return { x: item.x + dx * cos - dy * sin, y: item.y + dx * sin + dy * cos };
  });
}

// Per-item pocket geometry in layout space: clearance-offset outline plus
// standing pillars from the tool's holes/circles. Shared by the editor
// (collision display), the mesh builder and the cut-template export.
export function layoutPockets(items, clearance) {
  return items.map(item => {
    let pocket = offsetLoop(placeLoop(item.outer, item), Math.max(0, clearance))[0] || null;
    let notchAt = null;
    if (pocket && item.notch && item.notch.dia > 2) {
      // Notch centre stored in item-local coords; place it with the item,
      // snap to the pocket boundary, union.
      const w = placePoint(item, item.notch);
      const spec = { dia: item.notch.dia, x: w.x, y: w.y };
      pocket = applyNotch(pocket, spec);
      notchAt = spec._at || null;
    }
    const pillars = [];
    const sources = [
      ...(item.holes || []),
      ...(item.circles || []).map(c => circleToPolygon(c.cx, c.cy, c.d, 32)),
    ];
    for (const h of sources) {
      const inner = offsetLoop(placeLoop(h, item, item.outer), -Math.max(0, clearance))[0];
      if (inner && Math.abs(signedArea(inner)) >= 4) pillars.push(inner);
    }
    return { pocket, pillars, notchAt };
  });
}

// Validity: pockets must stay `border` mm inside the container and must not
// overlap each other. Returns { collisions: Set(index), escaped: Set(index) }.
export function layoutConflicts(containerOuter, pockets, border) {
  const ClipperLib = CL();
  const collisions = new Set(), escaped = new Set();
  const inner = offsetLoop(containerOuter, -Math.max(0.5, border))[0];
  for (let i = 0; i < pockets.length; i++) {
    const p = pockets[i].pocket;
    if (!p) { escaped.add(i); continue; }
    if (!inner) { escaped.add(i); continue; }
    const clipper = new ClipperLib.Clipper();
    clipper.AddPath(positivePath(toClipperPath(p)), ClipperLib.PolyType.ptSubject, true);
    clipper.AddPath(positivePath(toClipperPath(inner)), ClipperLib.PolyType.ptClip, true);
    const sol = new ClipperLib.Paths();
    clipper.Execute(ClipperLib.ClipType.ctDifference, sol,
      ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero);
    let area = 0;
    for (const path of sol) area += Math.abs(ClipperLib.Clipper.Area(path));
    if (area > 0.05 * SCALE * SCALE) escaped.add(i);
  }
  for (let i = 0; i < pockets.length; i++) {
    for (let j = i + 1; j < pockets.length; j++) {
      const a = pockets[i].pocket, b = pockets[j].pocket;
      if (!a || !b) continue;
      const clipper = new ClipperLib.Clipper();
      clipper.AddPath(positivePath(toClipperPath(a)), ClipperLib.PolyType.ptSubject, true);
      clipper.AddPath(positivePath(toClipperPath(b)), ClipperLib.PolyType.ptClip, true);
      const sol = new ClipperLib.Paths();
      clipper.Execute(ClipperLib.ClipType.ctIntersection, sol,
        ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero);
      let area = 0;
      for (const path of sol) area += Math.abs(ClipperLib.Clipper.Area(path));
      if (area > 0.05 * SCALE * SCALE) { collisions.add(i); collisions.add(j); }
    }
  }
  return { collisions, escaped };
}

// Drawer / toolbox insert: the container outline extruded as a slab with one
// pocket recess per placed tool, each at its own depth.
//
// container: { outer } in layout mm; items: [{ outer, holes, circles, x, y,
// rot, depth }]; opts: { clearance, floor, border, defaultDepth }.
// Returns { positions, indices, stats, template } or null. The layout must
// be conflict-free (run layoutConflicts first) — conflicts return null with
// a reason in `reason`.
export function buildLayoutInsert(container, items, opts = {}) {
  const { clearance = 0.5, floor = 3, border = 5, defaultDepth = 5 } = opts;
  if (!container || !container.outer || container.outer.length < 3) return null;
  if (!items || !items.length) return { reason: 'empty' };
  const warnings = [];

  const pockets = layoutPockets(items, clearance);
  const { collisions, escaped } = layoutConflicts(container.outer, pockets, border);
  if (collisions.size || escaped.size) {
    return { reason: collisions.size ? 'collision' : 'escaped', collisions, escaped };
  }

  const depths = items.map(it => Math.max(0.3, it.depth || it.thickness || defaultDepth));
  const maxDepth = Math.max(...depths);
  const thickness = Math.max(0.5, floor) + maxDepth; // layouts always keep a floor
  if (floor < 1) warnings.push(`Thin insert floor (${Math.max(0.5, floor).toFixed(1)} mm).`);

  const none = { mode: 'none', size: 0 };
  const recesses = pockets.map((p, i) => ({
    islands: [{ outer: p.pocket, holes: p.pillars }],
    depth: depths[i], face: 'top',
  }));
  const mesh = buildSolid(container.outer, [], [], {
    thickness, zBase: 0, top: none, bottom: none, recesses,
  });
  if (!mesh) return null;
  mesh.stats.warnings = [...warnings, ...(mesh.stats.warnings || [])];
  const bb = bboxOf(container.outer);
  mesh.stats.slab = { w: bb.w, h: bb.h, thickness, pocketDepth: maxDepth };
  return {
    ...mesh,
    template: {
      slab: container.outer,
      pockets: pockets.map(p => ({ pocket: p.pocket, pillars: p.pillars })),
      origin: { x: bb.minX, y: bb.minY }, w: bb.w, h: bb.h,
    },
  };
}

// ---------- Gridfinity bin ----------
//
// Spec (gridfinity-unofficial / gridfinity-rebuilt): 42 mm grid, 7 mm height
// unit. Bin footprint N·42−0.5 per side, corner r 3.75. Per-cell base pad,
// bottom-up: 35.6² r0.8 → 0.8 mm 45° chamfer → 37.2² r1.6 → 1.8 mm straight
// → 2.15 mm 45° chamfer → 41.5² r3.75 at z 4.75. Stacking lip: 4.4 mm tall ×
// 2.6 deep (0.7 chamfer / 1.8 straight / 1.9 chamfer, ending near the outer
// edge). Magnets: Ø6.5 × 2.4 at ±13 mm from each cell centre.
//
// Built as overlapping watertight parts (slicers union them, the deboss
// precedent): per-cell base-pad lofts (+0.01 mm buried overlap into the
// body), the body prism with the tool pocket as a single-shell recess, and
// the lip as a ring loft. No CSG.

const GF = {
  grid: 42, gap: 0.5, baseH: 4.75, unitH: 7,
  pad: [ // z, size, corner r — lofted per cell. Top is 41.5 per spec, held
    // 0.02 under so the pad tucks INSIDE the bin wall instead of exactly
    // flush with it (two shells sharing identical edge coordinates) — the
    // 10 µm/side shortfall on the chamfer tip is far below print resolution.
    { z: 0, s: 35.6, r: 0.8 },
    { z: 0.8, s: 37.2, r: 1.6 },
    { z: 2.6, s: 37.2, r: 1.6 },
    { z: 4.75, s: 41.48, r: 3.74 },
  ],
  binR: 3.75,
  lip: { h1: 0.7, h2: 1.8, h3: 1.9, inset: 2.6, tip: 0.05 }, // 4.4 total
  magnet: { r: 3.25, depth: 2.4, off: 13 },
  wall: 1.2, wallLip: 2.6,
};

const ensureCCW = loop => (signedArea(loop) > 0 ? loop : loop.slice().reverse());
const ensureCW = loop => (signedArea(loop) < 0 ? loop : loop.slice().reverse());

// Merge independently-watertight parts into one mesh (buildModel's scheme).
function mergeParts(parts) {
  const positions = new Float32Array(parts.reduce((n, p) => n + p.positions.length, 0));
  const indices = new Uint32Array(parts.reduce((n, p) => n + p.indices.length, 0));
  let vOff = 0, iOff = 0;
  for (const p of parts) {
    positions.set(p.positions, vOff * 3);
    for (let k = 0; k < p.indices.length; k++) indices[iOff + k] = p.indices[k] + vOff;
    vOff += p.positions.length / 3;
    iOff += p.indices.length;
  }
  return { positions, indices };
}

// A gridfinity base pad for one cell, lofted in model coords (z up), with
// optional magnet holes. cx/cy = cell centre in model mm.
function padMesh(cx, cy, magnets) {
  const mb = new MeshBuilder();
  const EPS = 0.01;
  const slices = GF.pad.map(p => ({
    z: p.z, loop: ensureCCW(roundedRect(cx, cy, p.s, p.s, p.r)),
  }));
  // Overrun into the body slab so no faces are exactly coincident.
  slices.push({ z: GF.baseH + EPS, loop: slices[slices.length - 1].loop });
  for (let i = 0; i + 1 < slices.length; i++) {
    if (slices[i + 1].z - slices[i].z < 1e-9) continue;
    zipRings(mb, slices[i].loop, slices[i].z, slices[i + 1].loop, slices[i + 1].z);
  }
  const holes = [];
  if (magnets) {
    for (const sx of [-1, 1]) {
      for (const sy of [-1, 1]) {
        holes.push({ x: cx + sx * GF.magnet.off, y: cy + sy * GF.magnet.off });
      }
    }
    for (const h of holes) {
      emitBand(mb, h, 0, GF.magnet.r, GF.magnet.depth, GF.magnet.r, 48);
      emitDisk(mb, h, GF.magnet.depth, GF.magnet.r, false, 48); // hole ceiling
    }
  }
  addCap(mb, [slices[0].loop, ...holes.map(h => circleRing(h, GF.magnet.r, 48))], 0, false);
  addCap(mb, [slices[slices.length - 1].loop], GF.baseH + EPS, true);
  return { positions: new Float32Array(mb.positions), indices: new Uint32Array(mb.indices) };
}

// The stacking lip: a ring loft on top of the body (outer wall constant, the
// inner surface steps out per the spec profile), overlapping the body top by
// 0.01 mm. w/h = bin footprint, zTop = body top, model coords centred.
function lipMesh(w, h, zTop) {
  const mb = new MeshBuilder();
  const EPS = 0.01;
  const L = GF.lip;
  const outer = ensureCCW(roundedRect(0, 0, w, h, GF.binR));
  const innerAt = inset => ensureCW(roundedRect(0, 0, w - 2 * inset, h - 2 * inset,
    Math.max(0.2, GF.binR - inset)));
  const slices = [
    { z: zTop - EPS, inset: L.inset },
    { z: zTop + L.h1, inset: L.inset - L.h1 },          // 45° chamfer out
    { z: zTop + L.h1 + L.h2, inset: L.inset - L.h1 },   // straight
    { z: zTop + L.h1 + L.h2 + L.h3, inset: L.tip },     // 45° chamfer to near-edge
  ].map(s => ({ z: s.z, inner: innerAt(s.inset) }));
  for (let i = 0; i + 1 < slices.length; i++) {
    zipRings(mb, outer, slices[i].z, outer, slices[i + 1].z);
    zipRings(mb, slices[i].inner, slices[i].z, slices[i + 1].inner, slices[i + 1].z);
  }
  addCap(mb, [outer, slices[0].inner], slices[0].z, false);
  addCap(mb, [outer, slices[slices.length - 1].inner], slices[slices.length - 1].z, true);
  return { positions: new Float32Array(mb.positions), indices: new Uint32Array(mb.indices) };
}

// Assemble an N×M×u bin around ready-made pocket recesses (model coords,
// centred on the origin). Shared by the single-tool and layout paths.
function assembleGridBin({ N, M, H, lip, magnets, recesses, warnings }) {
  const W = N * GF.grid - GF.gap, H2 = M * GF.grid - GF.gap;
  const binLoop = roundedRect(0, 0, W, H2, GF.binR);
  const none = { mode: 'none', size: 0 };
  const body = buildSolid(binLoop, [], [], {
    thickness: H - GF.baseH, zBase: GF.baseH, top: none, bottom: none,
    center: { cx: 0, cy: 0 }, recesses,
  });
  if (!body) return null;
  warnings.push(...(body.stats.warnings || []));
  const parts = [body];
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < M; j++) {
      const cx = (i + 0.5) * GF.grid - (N * GF.grid) / 2;
      const cy = (j + 0.5) * GF.grid - (M * GF.grid) / 2;
      parts.push(padMesh(cx, cy, magnets));
    }
  }
  if (lip) parts.push(lipMesh(W, H2, H));
  const merged = mergeParts(parts);
  const zTopAll = lip ? H + GF.lip.h1 + GF.lip.h2 + GF.lip.h3 : H;
  const maxDepth = Math.max(...recesses.map(r => r.depth));
  return {
    ...merged,
    stats: {
      triangles: merged.indices.length / 3,
      sizeX: W, sizeY: H2, sizeZ: zTopAll,
      slab: { w: W, h: H2, thickness: zTopAll, pocketDepth: maxDepth },
      cells: { n: N, m: M, u: H / GF.unitH },
      warnings,
    },
  };
}

// Multi-tool Gridfinity bin: the layout's pockets carved into an N×M bin
// (the foam-with-gridfinity-base hybrid). cfg: { n, m, unitsH, lip,
// magnets }; items/opts as in buildLayoutInsert. The container loop for the
// editor is the bin footprint at origin margin 5 (layout space).
export function gridContainerLoop(n, m) {
  const W = n * GF.grid - GF.gap, H2 = m * GF.grid - GF.gap;
  return roundedRect(5 + W / 2, 5 + H2 / 2, W, H2, GF.binR);
}
export function buildLayoutGridBin(cfg, items, opts = {}) {
  const { clearance = 0.5 } = opts;
  const { n = 3, m = 2, unitsH = null, lip = true, magnets = false } = cfg;
  if (!items || !items.length) return { reason: 'empty' };
  const warnings = [];
  const loop = gridContainerLoop(n, m);
  const minWall = lip ? GF.wallLip : GF.wall;
  const pockets = layoutPockets(items, clearance);
  const { collisions, escaped } = layoutConflicts(loop, pockets, minWall);
  if (collisions.size || escaped.size) {
    return { reason: collisions.size ? 'collision' : 'escaped', collisions, escaped };
  }
  const depths = items.map(it => Math.max(0.3, it.depth || it.thickness || 5));
  const u = unitsH || Math.max(2, Math.ceil((GF.baseH + 1 + Math.max(...depths)) / GF.unitH));
  const H = u * GF.unitH;
  const budget = H - GF.baseH - 1;
  const recesses = pockets.map((p, i) => {
    let d = depths[i];
    if (d > budget) {
      d = budget;
      warnings.push(`"${items[i].name || `Tool ${i + 1}`}" pocket reduced to ${d.toFixed(1)} mm to clear the base (${u}u bin).`);
    }
    return { islands: [{ outer: p.pocket, holes: p.pillars }], depth: d, face: 'top' };
  });
  // Layout space → model space: centre on the bin footprint.
  const bb = bboxOf(loop);
  const cx = (bb.minX + bb.maxX) / 2, cy = (bb.minY + bb.maxY) / 2;
  const centred = pts => pts.map(p => ({ x: p.x - cx, y: p.y - cy }));
  for (const r of recesses) {
    r.islands = r.islands.map(isl => ({ outer: centred(isl.outer), holes: isl.holes.map(centred) }));
  }
  return assembleGridBin({ N: n, M: m, H, lip, magnets, recesses, warnings });
}

// Gridfinity bin with the tool pocketed into the top. trace as in
// buildFoamInsert; opts: { clearance, depth, unitsH (null = auto), lip,
// magnets, pillars }. Returns { positions, indices, stats, cells } or null.
export function buildGridfinityBin(trace, opts = {}) {
  const {
    clearance = 0.5, depth = 5, unitsH = null,
    lip = true, magnets = false, pillars = true,
  } = opts;
  if (!trace || !trace.outer || trace.outer.length < 3) return null;
  if (!(depth > 0.2)) return null;
  const warnings = [];

  let pocket = offsetLoop(trace.outer, Math.max(0, clearance))[0];
  if (!pocket || pocket.length < 3) return null;
  // Finger notch, before grid sizing so the bulge counts toward the fit.
  const { notch = 'none', notchDia = 25, notchFrac = 0.5 } = opts;
  if (notch && notch !== 'none') {
    pocket = applyNotch(pocket, notch === 'custom'
      ? { dia: notchDia, frac: notchFrac }
      : { dia: notchDia, side: notch });
  }
  const pillarLoops = [];
  if (pillars) {
    const sources = [
      ...(trace.holes || []),
      ...(trace.circles || []).map(c => circleToPolygon(c.cx, c.cy, c.d, 32)),
    ];
    for (const h of sources) {
      const inner = offsetLoop(h, -Math.max(0, clearance))[0];
      if (inner && Math.abs(signedArea(inner)) >= 4) pillarLoops.push(inner);
    }
  }

  // Grid size: pocket bbox + minimum wall must fit N·42−0.5, verified
  // exactly against the rounded bin corners (bump N/M when the pocket's
  // corners poke into them).
  const minWall = lip ? GF.wallLip : GF.wall;
  const bb = bboxOf(pocket);
  let N = Math.max(1, Math.ceil((bb.w + 2 * minWall + GF.gap) / GF.grid));
  let M = Math.max(1, Math.ceil((bb.h + 2 * minWall + GF.gap) / GF.grid));
  const pcx = (bb.minX + bb.maxX) / 2, pcy = (bb.minY + bb.maxY) / 2;
  const centred = loop => loop.map(p => ({ x: p.x - pcx, y: p.y - pcy }));
  const fits = (n, m) => {
    const w = n * GF.grid - GF.gap, h = m * GF.grid - GF.gap;
    const inner = offsetLoop(roundedRect(0, 0, w, h, GF.binR), -minWall)[0];
    if (!inner) return false;
    const grown = offsetLoop(centred(pocket), 0.01)[0] || centred(pocket);
    return unionLoops([inner, grown]).length === 1 &&
      Math.abs(Math.abs(signedArea(unionLoops([inner, grown])[0])) - Math.abs(signedArea(inner))) < 0.5;
  };
  let guard = 0;
  while (!fits(N, M) && guard++ < 3) {
    if ((N * GF.grid) / (bb.w + 1) < (M * GF.grid) / (bb.h + 1)) N++; else M++;
  }
  const W = N * GF.grid - GF.gap, H2 = M * GF.grid - GF.gap;

  // Height: units of 7 mm; the pocket floor must clear the base + 1 mm.
  const minH = GF.baseH + 1 + depth;
  const u = unitsH || Math.max(2, Math.ceil(minH / GF.unitH));
  const H = u * GF.unitH;
  let d = depth;
  if (H - GF.baseH - 1 < d) {
    d = H - GF.baseH - 1;
    warnings.push(`Pocket depth reduced to ${d.toFixed(1)} mm to clear the base (${u}u bin).`);
  }

  // Model coords: bin centred on the origin. Pocket recentred to match, and
  // handed to buildSolid in trace-space convention (y down) — the bin is
  // symmetric so only the pocket needs the flip-consistency care.
  const recesses = [{
    islands: [{ outer: centred(pocket), holes: pillarLoops.map(centred) }],
    depth: d, face: 'top',
  }];
  return assembleGridBin({ N, M, H, lip, magnets, recesses, warnings });
}

// ---------- Gridfinity baseplate (custom outline) ----------
//
// Photograph the drawer, trace it, print a baseplate that fits it exactly:
// a plate the shape of the traced outline with spec sockets (the inverse of
// the bin base pad, +0.25 mm/side clearance) for every 42 mm cell that fits
// fully inside. Socket opening is 41.9 (a 0.1 mm ridge between cells) so
// adjacent openings never touch; profile top-down: 2.15 chamfer → 1.8
// straight → 0.8 chamfer → floor, 4.75 deep.

const GF_SOCKET = [ // depth below plate top, opening size, corner r
  { d: 0, s: 41.9, r: 3.95 },
  { d: 2.15, s: 37.6, r: 1.8 },
  { d: 3.95, s: 37.6, r: 1.8 },
  { d: 4.75, s: 36.0, r: 0.9 },
];

export function buildBaseplate(trace, opts = {}) {
  const { floorT = 1.2 } = opts;
  if (!trace || !trace.outer || trace.outer.length < 3) return null;
  const warnings = [];
  const outline = trace.outer;
  const bb = bboxOf(outline);
  const T = GF.baseH + Math.max(0.6, floorT);

  // Centre the 42 mm grid on the outline's bbox and keep every cell whose
  // square sits fully inside the outline (Clipper-exact).
  const ClipperLib = CL();
  const N = Math.max(1, Math.floor(bb.w / GF.grid));
  const M = Math.max(1, Math.floor(bb.h / GF.grid));
  const gx = (bb.minX + bb.maxX) / 2 - (N * GF.grid) / 2;
  const gy = (bb.minY + bb.maxY) / 2 - (M * GF.grid) / 2;
  const cellInside = (cx, cy) => {
    const cell = roundedRect(cx, cy, GF.grid, GF.grid, 0.5, 2);
    const clipper = new ClipperLib.Clipper();
    clipper.AddPath(positivePath(toClipperPath(cell)), ClipperLib.PolyType.ptSubject, true);
    clipper.AddPath(positivePath(toClipperPath(outline)), ClipperLib.PolyType.ptClip, true);
    const sol = new ClipperLib.Paths();
    clipper.Execute(ClipperLib.ClipType.ctDifference, sol,
      ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero);
    let area = 0;
    for (const p of sol) area += Math.abs(ClipperLib.Clipper.Area(p));
    return area < 0.05 * SCALE * SCALE;
  };
  const cells = [];
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < M; j++) {
      const cx = gx + (i + 0.5) * GF.grid, cy = gy + (j + 0.5) * GF.grid;
      if (cellInside(cx, cy)) cells.push({ cx, cy });
    }
  }
  if (!cells.length) return { reason: 'nocells' };

  // Model coords: mirror y (image convention) and centre on the bbox.
  const mcx = (bb.minX + bb.maxX) / 2, mcy = (bb.minY + bb.maxY) / 2;
  const tx = pts => pts.map(p => ({ x: p.x - mcx, y: mcy - p.y }));

  const mb = new MeshBuilder();
  const outerM = ensureCCW(tx(outline));
  zipRings(mb, outerM, 0, outerM, T);

  const topOpenings = [];
  for (const c of cells) {
    const cM = { x: c.cx - mcx, y: mcy - c.cy };
    const ringAt = s => ensureCW(roundedRect(cM.x, cM.y, s.s, s.s, s.r));
    const slices = GF_SOCKET.map(s => ({ z: T - s.d, ring: ringAt(s) }));
    for (let k = 0; k + 1 < slices.length; k++) {
      // Descending z: zip lower slice to upper for consistent winding.
      zipRings(mb, slices[k + 1].ring, slices[k + 1].z, slices[k].ring, slices[k].z);
    }
    addCap(mb, [slices[slices.length - 1].ring], T - GF.baseH, true); // socket floor
    topOpenings.push(slices[0].ring);
  }
  addCap(mb, [outerM], 0, false);
  addCap(mb, [outerM, ...topOpenings], T, true);

  const positions = new Float32Array(mb.positions);
  const indices = new Uint32Array(mb.indices);
  return {
    positions, indices,
    stats: {
      triangles: indices.length / 3,
      sizeX: bb.w, sizeY: bb.h, sizeZ: T,
      slab: { w: bb.w, h: bb.h, thickness: T, pocketDepth: GF.baseH },
      cells: { count: cells.length, n: N, m: M },
      warnings,
    },
  };
}

// ---------- Holster / wall holder ----------
//
// A band around the outline: inner = outline + clearance, outer = + wall,
// extruded to a height. Options: a floor (0 = open-through), a flattened
// side (plan union with a tangent full-width rectangle — a flat face for
// velcro), and a mounting plate: a SEPARATE watertight prism extruded along
// the wall normal and rotated into place (0.01 mm buried overlap into the
// band — the deboss precedent), carrying a keyhole hanging tab above the
// band and/or screw wings beside it. Screen-direction sides, like the foam
// notch. No pegboard/multiboard. Everything is still a 2D footprint per
// prism — no CSG.

const HOLSTER_SIDES = {
  // Model-space face normal n and tangent t = z × n per screen side
  // (image y-down mirrors to model y, so screen bottom = model −y).
  bottom: { n: [0, -1, 0], t: [1, 0, 0] },
  top:    { n: [0, 1, 0],  t: [-1, 0, 0] },
  left:   { n: [-1, 0, 0], t: [0, -1, 0] },
  right:  { n: [1, 0, 0],  t: [0, 1, 0] },
};

export function buildHolster(trace, opts = {}) {
  const {
    clearance = 1.0, wall = 2.4, height = 20, floor = 0,
    flat = 'none', mount = 'none', plateT = 3,
  } = opts;
  if (!trace || !trace.outer || trace.outer.length < 3) return null;
  if (!(height > 1) || !(wall > 0.6)) return null;
  const warnings = [];
  const flatSide = (mount !== 'none' && flat === 'none') ? 'bottom' : flat;
  if (mount !== 'none' && flat === 'none') {
    warnings.push('Mounting needs a flat side — flattened the bottom edge.');
  }

  const inner = offsetLoop(trace.outer, Math.max(0, clearance))[0];
  let outer = offsetLoop(trace.outer, Math.max(0, clearance) + wall)[0];
  if (!inner || !outer) return null;

  // Flatten one side: union with a full-width rectangle tangent to the
  // band's extreme on that side (trace space, y down).
  if (flatSide !== 'none' && HOLSTER_SIDES[flatSide]) {
    const bb = bboxOf(outer);
    const D = wall * 2 + 4; // deep enough to always fuse with the band
    let rect;
    if (flatSide === 'bottom') rect = [{ x: bb.minX, y: bb.maxY - D }, { x: bb.maxX, y: bb.maxY - D }, { x: bb.maxX, y: bb.maxY }, { x: bb.minX, y: bb.maxY }];
    else if (flatSide === 'top') rect = [{ x: bb.minX, y: bb.minY }, { x: bb.maxX, y: bb.minY }, { x: bb.maxX, y: bb.minY + D }, { x: bb.minX, y: bb.minY + D }];
    else if (flatSide === 'left') rect = [{ x: bb.minX, y: bb.minY }, { x: bb.minX + D, y: bb.minY }, { x: bb.minX + D, y: bb.maxY }, { x: bb.minX, y: bb.maxY }];
    else rect = [{ x: bb.maxX - D, y: bb.minY }, { x: bb.maxX, y: bb.minY }, { x: bb.maxX, y: bb.maxY }, { x: bb.maxX - D, y: bb.maxY }];
    const merged = unionLoops([outer, rect])[0];
    if (merged) outer = merged;
  }

  const none = { mode: 'none', size: 0 };
  const bb = bboxOf(outer);
  const center = { cx: (bb.minX + bb.maxX) / 2, cy: (bb.minY + bb.maxY) / 2 };
  const parts = [];
  const band = buildSolid(outer, [inner], [], {
    thickness: height, zBase: 0, top: none, bottom: none, center,
  });
  if (!band) return null;
  parts.push(band);

  if (floor > 0) {
    // A plug under the opening, buried into the band's wall by ~half the
    // wall so its side face is interior (bottom faces share the bed plane —
    // unambiguous, both exterior).
    const plug = offsetLoop(trace.outer, Math.max(0, clearance) + Math.min(wall * 0.6, wall - 0.2))[0];
    const floorMesh = plug && buildSolid(plug, [], [], {
      thickness: floor, zBase: 0, top: none, bottom: none, center,
    });
    if (floorMesh) parts.push(floorMesh);
    else warnings.push('Floor could not be built — left open.');
  }

  // Mounting plate: local footprint in (u, v) = (along the wall, up).
  if (mount !== 'none') {
    const S = HOLSTER_SIDES[flatSide];
    const modelBB = { // model-space band bbox (mirror of the trace bbox)
      xMin: bb.minX - center.cx, xMax: bb.maxX - center.cx,
      yMin: center.cy - bb.maxY, yMax: center.cy - bb.minY,
    };
    const along = (flatSide === 'left' || flatSide === 'right')
      ? modelBB.yMax - modelBB.yMin : modelBB.xMax - modelBB.xMin;

    const wingW = 12, tabW = 18, tabH = 22, holeD = 4.4;
    const keyhole = mount === 'keyhole' || mount === 'both';
    const wings = mount === 'wings' || mount === 'both';
    const w2 = along / 2;
    const rects = [[-w2, 0, w2, height]]; // base plate over the flat face
    if (wings) rects.push([-w2 - wingW, 0, w2 + wingW, height]);
    if (keyhole) rects.push([-tabW / 2, 0, tabW / 2, height + tabH]);
    const rectLoop = ([x0, y0, x1, y1]) =>
      [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }];
    const plateOutline = unionLoops(rects.map(rectLoop))[0];
    const holes = [];
    if (keyhole) {
      // Big hole the nail head passes through, slot upward — the holster
      // slides down so the nail ends at the slot top.
      const cyK = height + 6;
      const kh = unionLoops([
        circleToPolygon(0, cyK, 8.5, 48),
        rectLoop([-2.25, cyK, 2.25, cyK + 9]),
        circleToPolygon(0, cyK + 9, 4.5, 32),
      ])[0];
      if (kh) holes.push(kh);
    }
    const circles = wings ? [
      { cx: w2 + wingW / 2, cy: -(height / 2), d: holeD },
      { cx: -w2 - wingW / 2, cy: -(height / 2), d: holeD },
    ] : [];
    // buildSolid mirrors y, so pre-flip v; extrude thickness = plateT.
    const flipV = pts => pts.map(p => ({ x: p.x, y: -p.y }));
    const plateLocal = buildSolid(flipV(plateOutline), holes.map(flipV),
      circles.map(c => ({ ...c, type: 'through' })), {
        thickness: plateT, zBase: 0, top: none, bottom: none, center: { cx: 0, cy: 0 },
      });
    if (plateLocal) {
      // Local (X=u, Y=v, Z=w∈[0,plateT]) → world t·u + zAxis·v + n·nn where
      // nn runs outward from 0.01 inside the flat face. The basis [t, z, n]
      // has det +1 for every side, so triangle winding survives.
      const faceN = {
        bottom: -modelBB.yMin, top: modelBB.yMax,
        left: -modelBB.xMin, right: modelBB.xMax,
      }[flatSide];
      const p = plateLocal.positions;
      for (let i = 0; i < p.length; i += 3) {
        const u = p[i], v = p[i + 1], w = p[i + 2];
        const nn = faceN - 0.01 + w;
        p[i] = S.t[0] * u + S.n[0] * nn;
        p[i + 1] = S.t[1] * u + S.n[1] * nn;
        p[i + 2] = v;
      }
      parts.push(plateLocal);
    } else {
      warnings.push('Mounting plate could not be built.');
    }
  }

  const merged = mergeParts(parts);
  const stats = {
    triangles: merged.indices.length / 3,
    sizeX: 0, sizeY: 0, sizeZ: 0,
    slab: { w: bb.maxX - bb.minX, h: bb.maxY - bb.minY, thickness: height, pocketDepth: height },
    warnings,
  };
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < merged.positions.length; i += 3) {
    minX = Math.min(minX, merged.positions[i]); maxX = Math.max(maxX, merged.positions[i]);
    minY = Math.min(minY, merged.positions[i + 1]); maxY = Math.max(maxY, merged.positions[i + 1]);
    minZ = Math.min(minZ, merged.positions[i + 2]); maxZ = Math.max(maxZ, merged.positions[i + 2]);
  }
  stats.sizeX = maxX - minX; stats.sizeY = maxY - minY; stats.sizeZ = maxZ - minZ;
  return { ...merged, stats };
}

// Foam-style insert: a rounded-rect slab with the tool pocketed into the top.
//
// trace: { outer, holes, circles } in trace mm (image coords, y down).
// opts: {
//   clearance (mm around the tool so it drops in), margin (slab border
//   around the pocket), cornerR (slab corner radius), depth (pocket depth),
//   floor (slab below the pocket floor; 0 = pocket punches through),
//   notch ('none'|'top'|'bottom'|'left'|'right' — finger cutout, screen
//   directions), notchDia, pillars (traced holes stand as supports)
// }
// Returns { positions, indices, stats, template } or null; template carries
// the slab + pocket loops (trace space) for the 2D cut-template export.
export function buildFoamInsert(trace, opts = {}) {
  const {
    clearance = 0.5, margin = 10, cornerR = 4,
    depth = 5, floor = 3,
    notch = 'bottom', notchDia = 25, pillars = true,
  } = opts;
  if (!trace || !trace.outer || trace.outer.length < 3) return null;
  if (!(depth > 0.2)) return null;
  const warnings = [];
  const mar = Math.max(2, margin);

  // Pocket = tool outline + clearance (largest loop if the offset splits).
  let pocket = offsetLoop(trace.outer, Math.max(0, clearance))[0];
  if (!pocket || pocket.length < 3) return null;

  // Finger notch: side anchor, or 'custom' + notchFrac (perimeter fraction,
  // driven by the position slider). Bulges outward only.
  if (notch && notch !== 'none') {
    pocket = applyNotch(pocket, notch === 'custom'
      ? { dia: notchDia, frac: opts.notchFrac ?? 0.5 }
      : { dia: notchDia, side: notch });
  }

  // Support pillars: traced holes (and manual circles) deflated by the
  // clearance keep standing inside the pocket — they poke into the tool's
  // own holes (a tape-roll core, a wrench's hang hole) and support it.
  const pillarLoops = [];
  if (pillars && floor > 0) {
    const sources = [
      ...(trace.holes || []),
      ...(trace.circles || []).map(c => circleToPolygon(c.cx, c.cy, c.d, 32)),
    ];
    for (const h of sources) {
      const inner = offsetLoop(h, -Math.max(0, clearance))[0];
      if (inner && Math.abs(signedArea(inner)) >= 4) pillarLoops.push(inner);
      else if (h.length >= 3) warnings.push('A tool hole is too small to keep a support pillar after clearance.');
    }
  } else if (pillars && floor <= 0) {
    if ((trace.holes || []).length || (trace.circles || []).length) {
      warnings.push('Through pocket (no floor): support pillars would float and were dropped.');
    }
  }

  // Slab around the pocket.
  const bb = bboxOf(pocket);
  const w = bb.w + 2 * mar, h = bb.h + 2 * mar;
  const cx = (bb.minX + bb.maxX) / 2, cy = (bb.minY + bb.maxY) / 2;
  const slab = roundedRect(cx, cy, w, h, cornerR);
  const none = { mode: 'none', size: 0 };
  const thickness = floor > 0 ? floor + depth : depth;
  if (floor > 0 && floor < 1) warnings.push(`Thin foam floor (${floor.toFixed(1)} mm).`);

  const mesh = floor > 0
    ? buildSolid(slab, [], [], {
        thickness, zBase: 0, top: none, bottom: none,
        recesses: [{ islands: [{ outer: pocket, holes: pillarLoops }], depth, face: 'top' }],
      })
    : buildSolid(slab, [pocket], [], { thickness, zBase: 0, top: none, bottom: none });
  if (!mesh) return null;
  mesh.stats.warnings = [...warnings, ...(mesh.stats.warnings || [])];
  mesh.stats.slab = { w, h, thickness, pocketDepth: depth };
  return {
    ...mesh,
    template: {
      // Trace-space loops for the SVG cut template (shifted by the caller).
      slab, pocket, pillars: pillarLoops,
      origin: { x: cx - w / 2, y: cy - h / 2 }, w, h,
    },
  };
}

// ---------- tiling: split a layout template to a laser / print bed ----------
//
// A bench drawer is wider than any laser bed, so the cut template is split
// into tiles that each fit bedW × bedH. Seams are straight (foam butts
// together in the drawer) and placed, within the window that keeps every
// tile on the bed, where they cross the fewest pockets — a pocket cut in
// two across a seam still works, but a seam through clear foam is cleaner.

function clipLoopsToRect(loops, x0, y0, x1, y1) {
  const ClipperLib = CL();
  const rect = [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }];
  const out = [];
  for (const loop of loops) {
    if (!loop || loop.length < 3) continue;
    const clipper = new ClipperLib.Clipper();
    clipper.AddPath(positivePath(toClipperPath(loop)), ClipperLib.PolyType.ptSubject, true);
    clipper.AddPath(positivePath(toClipperPath(rect)), ClipperLib.PolyType.ptClip, true);
    const sol = new ClipperLib.Paths();
    clipper.Execute(ClipperLib.ClipType.ctIntersection, sol,
      ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero);
    for (const p of sol) {
      const ring = fromClipperPath(p);
      if (ring.length >= 3 && Math.abs(signedArea(ring)) > 0.5) out.push(ring);
    }
  }
  return out;
}

// subjects − clips → outer loops (a seam socket is a bite at a tile's
// edge, so it never makes a hole; any that appear are returned separately).
function differenceLoops(subjects, clips) {
  const ClipperLib = CL();
  const clipper = new ClipperLib.Clipper();
  clipper.AddPaths(subjects.map(l => positivePath(toClipperPath(l))), ClipperLib.PolyType.ptSubject, true);
  clipper.AddPaths(clips.map(l => positivePath(toClipperPath(l))), ClipperLib.PolyType.ptClip, true);
  const tree = new ClipperLib.PolyTree();
  clipper.Execute(ClipperLib.ClipType.ctDifference, tree,
    ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero);
  const outers = [], holes = [];
  for (const e of ClipperLib.JS.PolyTreeToExPolygons(tree)) {
    const o = fromClipperPath(e.outer);
    if (o.length >= 3 && Math.abs(signedArea(o)) > 0.5) outers.push(o);
    for (const h of e.holes) { const hl = fromClipperPath(h); if (hl.length >= 3) holes.push(hl); }
  }
  return { outers, holes };
}

// Jigsaw knob protruding from a seam: a neck rectangle rooted 0.5 mm inside
// the giving tile plus a round head, unioned. `s` = seam coordinate, `t` =
// centre along the seam, axis 'x' (knob protrudes +x) or 'y' (+y).
function knobLoop(axis, s, t, tabs) {
  const { head, neck, depth } = tabs;
  const r = head / 2, cx = s + depth - r;
  const rect = axis === 'x'
    ? [{ x: s - 0.5, y: t - neck / 2 }, { x: cx, y: t - neck / 2 }, { x: cx, y: t + neck / 2 }, { x: s - 0.5, y: t + neck / 2 }]
    : [{ x: t - neck / 2, y: s - 0.5 }, { x: t + neck / 2, y: s - 0.5 }, { x: t + neck / 2, y: cx }, { x: t - neck / 2, y: cx }];
  const circle = axis === 'x' ? circleToPolygon(cx, t, head, 48) : circleToPolygon(t, cx, head, 48);
  return unionLoops([rect, circle])[0] || rect;
}

// Tab centres along one seam segment [a, b], kept clear of the segment's
// ends (where seams cross or meet the edge) and of pockets that come within
// the tab's reach of the seam. `near` = [lo, hi] along-seam spans of such
// pockets. Returns centres (possibly empty).
function planTabs(a, b, tabs, near) {
  const L = b - a;
  const m = tabs.head / 2 + 3;
  if (L - 2 * m < tabs.head) return [];
  const n = Math.max(1, Math.floor(L / tabs.spacing));
  const half = tabs.head / 2 + 2;
  const clear = t => t >= a + m && t <= b - m && !near.some(([lo, hi]) => t + half > lo && t - half < hi);
  const out = [];
  for (let i = 0; i < n; i++) {
    const t0 = a + (L / (n + 1)) * (i + 1);
    let pick = null;
    for (let d = 0; d <= tabs.spacing / 2 && pick === null; d += 2) {
      if (clear(t0 + d)) pick = t0 + d;
      else if (d > 0 && clear(t0 - d)) pick = t0 - d;
    }
    if (pick !== null && !out.some(t => Math.abs(t - pick) < tabs.head + 4)) out.push(pick);
  }
  return out;
}

// Seam positions along one axis. L = extent, B = bed size for every tile
// but the last, lastB = bed size for the last tile (with puzzle tabs the
// giving tiles carry a knob, so they get B − depth while the final tile,
// which only receives, keeps the full bed), spans = pocket [min,max]
// intervals on this axis. Within those limits prefer seams crossing the
// fewest pockets, then the most clearance; cells thinner than minCell are
// avoided so a knob can never reach across a whole tile.
function planSeams(L, B, spans, lastB = B, minCell = 1) {
  let n = 1;
  while ((n - 1) * B + lastB < L - 1e-6) n++;
  const seams = [];
  let prev = 0;
  for (let k = 1; k < n; k++) {
    const lo = Math.max(L - (n - 1 - k) * B - lastB, prev + 1);
    const hi = Math.min(k * B, prev + B);
    let best = null;
    for (let s = Math.ceil(lo); s <= Math.floor(hi); s++) {
      let crossings = 0, clearance = Infinity;
      for (const [a, b] of spans) {
        if (s > a + 0.5 && s < b - 0.5) crossings++;
        clearance = Math.min(clearance, Math.abs(s - a), Math.abs(s - b));
      }
      const thin = (s - prev < minCell || L - s < minCell) ? 1 : 0;
      if (!best || thin < best.thin ||
          (thin === best.thin && (crossings < best.crossings ||
          (crossings === best.crossings && clearance > best.clearance)))) {
        best = { s, thin, crossings, clearance };
      }
    }
    const s = best ? best.s : Math.min(hi, lo);
    seams.push(s);
    prev = s;
  }
  return { n, seams };
}

// template: as returned by buildLayoutInsert / buildFoamInsert (slab loop,
// pockets [{pocket, pillars}] or a single pocket, origin, w, h).
// Returns { tiles: [{ col, row, x0, y0, w, h, slabs, holes }], nx, ny,
// seamsX, seamsY, crossings } with tile loops in TILE-LOCAL mm (origin at
// the tile's top-left), or null when the layout already fits the bed.
export function splitTiles(template, bedW, bedH, opts = {}) {
  if (!template || !(bedW > 10) || !(bedH > 10)) return null;
  const { origin, w, h } = template;
  if (w <= bedW + 1e-6 && h <= bedH + 1e-6) return null;
  // Puzzle tabs: { head, neck, depth, spacing, fit } — a knob on the
  // lower-index tile, the matching socket on its neighbour. The planning
  // bed shrinks by the protrusion so a tile WITH its knobs still fits.
  const tabs = opts.tabs && opts.tabs.enabled
    ? { head: 12, neck: 7, depth: 12, spacing: 80, fit: 0, ...opts.tabs } : null;
  // Giving tiles (every tile but the last along an axis) carry a knob, so
  // they plan against bed − depth; the last tile only receives sockets and
  // keeps the full bed.
  const giverW = tabs ? bedW - tabs.depth : bedW;
  const giverH = tabs ? bedH - tabs.depth : bedH;
  if (!(giverW > 10) || !(giverH > 10)) return null;
  const minCell = tabs ? tabs.depth + tabs.head + 6 : 1;
  const shift = pts => pts.map(p => ({ x: p.x - origin.x, y: p.y - origin.y }));
  const slab = shift(template.slab);
  const pockets = template.pockets
    ? template.pockets.map(p => ({ pocket: shift(p.pocket), pillars: p.pillars.map(shift) }))
    : [{ pocket: shift(template.pocket), pillars: (template.pillars || []).map(shift) }];

  const spanOf = (loop, axis) => {
    let lo = Infinity, hi = -Infinity;
    for (const p of loop) { lo = Math.min(lo, p[axis]); hi = Math.max(hi, p[axis]); }
    return [lo, hi];
  };
  const px = planSeams(w, giverW, pockets.map(p => spanOf(p.pocket, 'x')), bedW, minCell);
  const py = planSeams(h, giverH, pockets.map(p => spanOf(p.pocket, 'y')), bedH, minCell);
  const xs = [0, ...px.seams, w], ys = [0, ...py.seams, h];

  const tiles = [];
  let crossings = 0;
  for (const s of px.seams) for (const p of pockets) { const [a, b] = spanOf(p.pocket, 'x'); if (s > a + 0.5 && s < b - 0.5) crossings++; }
  for (const s of py.seams) for (const p of pockets) { const [a, b] = spanOf(p.pocket, 'y'); if (s > a + 0.5 && s < b - 0.5) crossings++; }
  // Tiles in template-global coords first (tabs are applied across cells),
  // localised at the end.
  const byCell = new Map();
  for (let row = 0; row < py.n; row++) {
    for (let col = 0; col < px.n; col++) {
      const x0 = xs[col], x1 = xs[col + 1], y0 = ys[row], y1 = ys[row + 1];
      const slabs = clipLoopsToRect([slab], x0, y0, x1, y1);
      if (!slabs.length) continue; // an irregular drawer can leave an empty tile
      const holes = [];
      for (const p of pockets) {
        holes.push(...clipLoopsToRect([p.pocket], x0, y0, x1, y1));
        holes.push(...clipLoopsToRect(p.pillars, x0, y0, x1, y1));
      }
      const t = { col, row, x0, y0, x1, y1, slabs, holes };
      tiles.push(t);
      byCell.set(`${col},${row}`, t);
    }
  }

  // Puzzle tabs along every internal seam segment.
  let tabCount = 0, tabless = 0;
  if (tabs) {
    const reach = tabs.depth + tabs.head / 2 + 2;
    const addTabs = (axis, s, a, b, A, B) => {
      if (!A || !B) return;
      // Pockets that come within reach of this seam on either side.
      const near = [];
      for (const p of pockets) {
        const perp = spanOf(p.pocket, axis), along = spanOf(p.pocket, axis === 'x' ? 'y' : 'x');
        if (perp[0] < s + reach && perp[1] > s - reach) near.push(along);
      }
      const centres = planTabs(a, b, tabs, near);
      if (!centres.length) { tabless++; return; }
      for (const t of centres) {
        const knob = knobLoop(axis, s, t, tabs);
        const socket = tabs.fit !== 0 ? (offsetLoop(knob, tabs.fit)[0] || knob) : knob;
        A.slabs = unionLoops([...A.slabs, knob]);
        const d = differenceLoops(B.slabs, [socket]);
        B.slabs = d.outers;
        B.holes.push(...d.holes);
        tabCount++;
      }
    };
    for (let k = 0; k < px.seams.length; k++) {
      for (let row = 0; row < py.n; row++) {
        addTabs('x', px.seams[k], ys[row], ys[row + 1], byCell.get(`${k},${row}`), byCell.get(`${k + 1},${row}`));
      }
    }
    for (let k = 0; k < py.seams.length; k++) {
      for (let col = 0; col < px.n; col++) {
        addTabs('y', py.seams[k], xs[col], xs[col + 1], byCell.get(`${col},${k}`), byCell.get(`${col},${k + 1}`));
      }
    }
  }

  for (const t of tiles) {
    const local = pts => pts.map(p => ({ x: p.x - t.x0, y: p.y - t.y0 }));
    t.slabs = t.slabs.map(local);
    t.holes = t.holes.map(local);
    // Extent including any knobs (what has to fit the bed).
    let mx = 0, my = 0;
    for (const l of t.slabs) for (const p of l) { mx = Math.max(mx, p.x); my = Math.max(my, p.y); }
    t.w = mx; t.h = my;
    delete t.x1; delete t.y1;
  }
  return { tiles, nx: px.n, ny: py.n, seamsX: px.seams, seamsY: py.seams, crossings, tabs: !!tabs, tabCount, tabless };
}
