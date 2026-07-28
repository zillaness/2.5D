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

const bboxOf = pts => {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pts) {
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
  }
  return { minX, minY, maxX, maxY, w: maxX - minX, h: maxY - minY };
};

// ---------- multi-tool layout (drawer / toolbox inserts) ----------

// Place a library outline: rotate about its bbox centre, then move that
// centre to (x, y). Layout space is mm, y down (same as trace space).
export function placeLoop(pts, item) {
  const bb = bboxOf(pts);
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
    const pocket = offsetLoop(placeLoop(item.outer, item), Math.max(0, clearance))[0] || null;
    const pillars = [];
    const sources = [
      ...(item.holes || []),
      ...(item.circles || []).map(c => circleToPolygon(c.cx, c.cy, c.d, 32)),
    ];
    for (const h of sources) {
      const inner = offsetLoop(placeLoop(h, item), -Math.max(0, clearance))[0];
      if (inner && Math.abs(signedArea(inner)) >= 4) pillars.push(inner);
    }
    return { pocket, pillars };
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
  const pocketC = centred(pocket);
  const pillarsC = pillarLoops.map(centred);
  const binLoop = roundedRect(0, 0, W, H2, GF.binR);
  const none = { mode: 'none', size: 0 };
  const body = buildSolid(binLoop, [], [], {
    thickness: H - GF.baseH, zBase: GF.baseH, top: none, bottom: none,
    center: { cx: 0, cy: 0 },
    recesses: [{ islands: [{ outer: pocketC, holes: pillarsC }], depth: d, face: 'top' }],
  });
  if (!body) return null;
  warnings.push(...(body.stats.warnings || []));

  const parts = [body];
  // Base pads per cell (model coords; y sign is symmetric so no flip issues).
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
  return {
    ...merged,
    stats: {
      triangles: merged.indices.length / 3,
      sizeX: W, sizeY: H2, sizeZ: zTopAll,
      slab: { w: W, h: H2, thickness: zTopAll, pocketDepth: d },
      cells: { n: N, m: M, u },
      warnings,
    },
  };
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

  // Finger notch: a circle centred where the pocket boundary crosses the
  // middle of the chosen side (screen directions, y down) — the extreme-most
  // crossing of the bbox-centre axis, so the notch lands mid-edge rather
  // than tie-breaking onto a corner. Unioned into the pocket.
  if (notch && notch !== 'none' && notchDia > 2) {
    const bb0 = bboxOf(pocket);
    const cx0 = (bb0.minX + bb0.maxX) / 2, cy0 = (bb0.minY + bb0.maxY) / 2;
    const vertical = notch === 'top' || notch === 'bottom';
    let best = null;
    for (let i = 0, n = pocket.length; i < n; i++) {
      const a = pocket[i], b = pocket[(i + 1) % n];
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
        (notch === 'bottom' && pt.y > best.y) || (notch === 'top' && pt.y < best.y) ||
        (notch === 'right' && pt.x > best.x) || (notch === 'left' && pt.x < best.x);
      if (better) best = pt;
    }
    if (best) {
      const merged = unionLoops([pocket, circleToPolygon(best.x, best.y, notchDia, 48)])[0];
      if (merged) pocket = merged;
    }
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
