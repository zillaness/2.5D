// Drawer scan: segmented mask components to clean millimetre polygons
// (docs/drawer_scan_prd_v1.0.md, plan step 3).
//
// segmentObjects hands back one cropped mask per object in the rectified
// drawer. This turns each of those into the part the layout editor places: an
// outer outline and its holes, in drawer millimetres, ready to become a
// state.layout.items entry.
//
// The pipeline is retrace()'s, deliberately and in its order, because a scanned
// tool and a photographed one have to come out the same shape for the same
// silhouette. That order is: pixels to millimetres FIRST, then collapse
// collinear, then simplify, then smooth. It matters. Converting first means
// simplifyClosed's epsilon is in millimetres rather than pixels, and simplify
// runs before smooth rather than after. js/regions.js's maskToPolygon does both
// the other way round, so anything built by copying THAT would quietly produce
// different polygons from the rest of the app.
//
// Nothing here reads state. Every setting arrives as an argument, because the
// shipped defaults were tuned for one object on a sheet of paper at up to
// 8 px/mm and several of them misbehave on a drawer at 5.7; see SCAN_DEFAULTS.
import {
  traceBoundaries, signedArea, collapseCollinear, simplifyClosed,
  chaikinClosed, pointInPolygon,
} from './contour.js';

export const SCAN_DEFAULTS = {
  // retrace's own refine settings. Simplify is in MILLIMETRES here, which is
  // only true because the conversion happens first.
  simplify: 0.4,
  smooth: 1,
  detectHoles: true,

  // A drawer's hole floor is not a sheet's. state.seg.minHoleAreaMm2 is 3,
  // tuned at 8 px/mm; at 5.7 that is 97 px, so noise survives as bogus holes
  // while a real 2 mm through-hole is 3.1 mm squared and sits right on the
  // line. The scan floors lower and leans on the sliver gate instead.
  minHoleAreaMm2: 1.5,

  // How much of its own AXIS-ALIGNED bounding box a component has to fill to
  // count as a tool rather than a smear.
  //
  // This is a heuristic and the number has to be chosen against the worst tool
  // it must admit, not against what looks reasonable. The measure is not
  // orientation-invariant: a long thin tool laid at 45 degrees fills far less
  // of its bounding box than the same tool laid square, and tools get laid at
  // angles on purpose. js/regions.js uses 0.25, which rejects a 200 by 20 mm
  // tool at 45 degrees (0.165) outright and silently. But 0.07 is not enough
  // either: a 180 by 6 mm rule, 30 to 1, fills 0.062 at 45 degrees and would
  // have gone the same way.
  //
  // 0.03 sits below that with room, and the load-bearing filter for actual
  // smears is minAreaMm2 together with morphClean, not this. Anything thinner
  // than 60 to 1 at 45 degrees is not a hand tool.
  minFill: 0.03,

  // Least area worth calling a part, in square millimetres. A loose bolt is
  // about 20 and is not a tool that gets a pocket.
  minAreaMm2: 30,

  // The narrowest a component may be across its short side and still be a tool,
  // WHEN IT TOUCHES THE EDGE of the rectified drawer.
  //
  // This is not a general minimum width: a 2 mm bar in the middle of the drawer
  // is a real thing and is kept. It is aimed at one artifact. The corners are
  // dragged by hand onto where the drawer's floor meets its walls, and missing
  // by half a millimetre is routine, which leaves a band of wall or rim colour
  // along one edge of the rectified image. That band is genuinely darker than
  // the liner, so it segments as an object, and being a strip it fills its own
  // bounding box completely, so the sliver gate waves it through. It then
  // arrives as "Tool 1", ticked, renumbering every real tool beneath it, and
  // places as a 400 mm pocket hard against the wall that the build then
  // refuses.
  //
  // A real tool pushed against a wall is still millimetres thick. A geometric
  // artifact of a mis-dragged corner is a fraction of one.
  minEdgeWidthMm: 3,

  // How close to the frame edge counts as touching it, in mm.
  edgeTolMm: 0.6,
};

// A part's bounding box in mm.
function bboxOfPts(pts) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pts) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY, w: maxX - minX, h: maxY - minY };
}

// Fresh point objects, always. collapseCollinear and the RDP inside
// simplifyClosed both preserve the caller's {x, y} objects, and each can return
// the input ARRAY itself when it would otherwise shorten below three points;
// only chaikinClosed allocates. So with smooth at 0 a refined outline can be
// the very same array of the very same objects the mask trace produced, shared
// between a candidate, its thumbnail and the layout item made from it. That is
// harmless inside retrace, which has one trace and discards it; it is a real
// hazard once N parts are meant to be independent of each other.
const detach = pts => pts.map(p => ({ x: p.x, y: p.y }));

// One cropped component mask to one part, or null when it is not a tool.
//
// The mask is a component's bounding-box crop, so its pixel coordinates are
// local and (x0, y0) puts them back in the frame. traceBoundaries reads 0
// outside its own bounds, so a component touching a crop edge still closes and
// no padding ring is needed.
function partFromMask(part, pxPerMm, o) {
  const { mask, w, h, x0, y0 } = part;
  const loops = traceBoundaries(mask, w, h);
  if (!loops.length) return null;

  // Pixels to millimetres, offset back into the drawer. The rectified canvas's
  // top-left corner IS the drawer's inside top-left corner, so these are
  // already drawer coordinates with no flip and no second origin.
  const toMm = pts => pts.map(p => ({
    x: (p.x + x0) / pxPerMm, y: (p.y + y0) / pxPerMm,
  }));
  const refine = pts => {
    let out = collapseCollinear(pts);
    out = simplifyClosed(out, o.simplify);
    if (o.smooth > 0) out = chaikinClosed(out, o.smooth);
    return out;
  };

  const mmLoops = loops.map(l => ({
    pts: toMm(l), area: Math.abs(signedArea(l)) / (pxPerMm * pxPerMm),
  }));
  mmLoops.sort((a, b) => b.area - a.area);
  const outerRaw = mmLoops[0];
  if (!outerRaw || outerRaw.area < o.minAreaMm2) return null;

  // The sliver gate, on the outline rather than on the pixel count, so a
  // component that is mostly bounding box but barely any tool is refused.
  const bb = bboxOfPts(outerRaw.pts);
  const boxArea = Math.max(1e-6, bb.w * bb.h);
  if (outerRaw.area / boxArea < o.minFill) return null;

  // The edge artifact. A strip of wall along a mis-dragged edge fills its own
  // bounding box completely, so the gate above cannot see it; what gives it
  // away is that it hugs the frame and is a fraction of a millimetre across.
  if (o.frame && o.frame.w > 0 && o.frame.h > 0) {
    const t = o.edgeTolMm;
    const onEdge = bb.minX <= t || bb.minY <= t ||
      bb.maxX >= o.frame.w - t || bb.maxY >= o.frame.h - t;
    if (onEdge && Math.min(bb.w, bb.h) < o.minEdgeWidthMm) return null;
  }

  const outer = detach(refine(outerRaw.pts));
  if (outer.length < 3) return null;

  // Holes, by retrace's rule exactly: the area gate first, then a single
  // point-in-polygon of the candidate's FIRST vertex against the UNREFINED
  // outer, then refine. Scoped to this component, so a hole can only ever
  // belong to the tool it was found inside, which is the whole reason the
  // grouping is component labelling and not bounding-box clustering.
  const holes = [];
  if (o.detectHoles) {
    for (let i = 1; i < mmLoops.length; i++) {
      const cand = mmLoops[i];
      if (cand.area < o.minHoleAreaMm2) continue;
      if (!pointInPolygon(cand.pts[0], outerRaw.pts)) continue;
      const refined = detach(refine(cand.pts));
      if (refined.length >= 3) holes.push(refined);
    }
  }

  // A circle through the RAW boundary, before refinement, for the coin check.
  // Simplify then Chaikin keeps a rectangle's box but cuts inside a convex
  // curve: a 24 mm disc comes out of refine about 0.3 mm under, and a scale
  // check cannot carry that bias. Cheap enough to do for every part.
  const disc = fitCircle(outerRaw.pts);
  return { outer, holes, area: outerRaw.area, bbox: bboxOfPts(outer), disc };
}

// Reading order: down the drawer in bands, left to right within each band.
//
// Ordering by position rather than by the order the flood fill happened to
// reach them keeps the names stable: Tool 1 is the top-left tool whatever the
// segmenter's raster seed order was. Bands are found by vertical overlap rather
// than by a fixed height, so a long tool lying across two rows of small ones
// does not split the drawer into bands that no tool actually occupies.
function readingOrder(parts) {
  const byTop = parts.slice().sort((a, b) =>
    (a.bbox.minY - b.bbox.minY) || (a.bbox.minX - b.bbox.minX));
  const out = [];
  let band = [], bandBottom = -Infinity;
  for (const p of byTop) {
    if (band.length && p.bbox.minY >= bandBottom) {
      band.sort((a, b) => a.bbox.minX - b.bbox.minX);
      out.push(...band);
      band = [];
      bandBottom = -Infinity;
    }
    band.push(p);
    bandBottom = Math.max(bandBottom, p.bbox.maxY);
  }
  if (band.length) {
    band.sort((a, b) => a.bbox.minX - b.bbox.minX);
    out.push(...band);
  }
  return out;
}

// masks: segmentObjects' output. pxPerMm: the rectified drawer's scale.
// Returns [{ outer, holes, area, bbox, name }] in reading order, named Tool 1
// through Tool N. A component that is not a tool is dropped, not returned as a
// null, so the numbering has no gaps in it.
export function scanParts(masks, pxPerMm, opts = {}) {
  const o = { ...SCAN_DEFAULTS, ...opts };
  if (!Array.isArray(masks) || !(pxPerMm > 0)) return [];
  const parts = [];
  for (const m of masks) {
    if (!m || !m.mask || !(m.w > 0) || !(m.h > 0)) continue;
    const part = partFromMask(m, pxPerMm, o);
    if (part) parts.push(part);
  }
  return readingOrder(parts).map((p, i) => ({ ...p, name: `Tool ${i + 1}` }));
}

// ---------- the coin check (calibration_and_backlog_prd_v1.2, Part B.1) ----------
//
// A drawer scan takes its scale from the drawer's corners and the typed width
// and depth. Corners marked at the rim, where they are easiest to see, put the
// scale on a plane one drawer-depth nearer the camera than the tools, so every
// tool reads small by (H - d) / H: 7.5 percent for a 60 mm drawer from 800 mm.
// A coin on the floor is on the tools' plane by definition, so its measured
// diameter against its true one IS that factor. Nothing here reads state and
// nothing moves until the person asks for the rescale.

// Least-squares circle through outline points (Kasa's algebraic fit): the
// (cx, cy, r) minimising the residual of x² + y² + a x + b y + c. Returns
// { cx, cy, r, rms } or null for fewer than three points or a degenerate set.
export function fitCircle(pts) {
  if (!Array.isArray(pts) || pts.length < 3) return null;
  // Centred coordinates keep the normal equations well conditioned.
  let mx = 0, my = 0;
  for (const p of pts) { mx += p.x; my += p.y; }
  mx /= pts.length; my /= pts.length;
  let sxx = 0, sxy = 0, syy = 0, sxz = 0, syz = 0, sz = 0, sx = 0, sy = 0;
  for (const p of pts) {
    const x = p.x - mx, y = p.y - my, z = x * x + y * y;
    sxx += x * x; sxy += x * y; syy += y * y; sxz += x * z; syz += y * z; sz += z; sx += x; sy += y;
  }
  const n = pts.length;
  // Solve [sxx sxy sx; sxy syy sy; sx sy n] [a b c]' = -[sxz syz sz]'.
  const M = [[sxx, sxy, sx], [sxy, syy, sy], [sx, sy, n]];
  const v = [-sxz, -syz, -sz];
  const sol = solve3(M, v);
  if (!sol) return null;
  const [a, b, c] = sol;
  const cx = -a / 2, cy = -b / 2;
  const r2 = cx * cx + cy * cy - c;
  if (!(r2 > 0)) return null;
  const r = Math.sqrt(r2);
  let ss = 0;
  for (const p of pts) { const d = Math.hypot(p.x - mx - cx, p.y - my - cy) - r; ss += d * d; }
  return { cx: cx + mx, cy: cy + my, r, rms: Math.sqrt(ss / n) };
}

function solve3(M, v) {
  const A = M.map((row, i) => [...row, v[i]]);
  for (let col = 0; col < 3; col++) {
    let piv = col;
    for (let r = col + 1; r < 3; r++) if (Math.abs(A[r][col]) > Math.abs(A[piv][col])) piv = r;
    if (Math.abs(A[piv][col]) < 1e-12) return null;
    [A[col], A[piv]] = [A[piv], A[col]];
    for (let r = 0; r < 3; r++) {
      if (r === col) continue;
      const f = A[r][col] / A[col][col];
      for (let k = col; k < 4; k++) A[r][k] -= f * A[col][k];
    }
  }
  return [A[0][3] / A[0][0], A[1][3] / A[1][1], A[2][3] / A[2][2]];
}

// The candidate that is a coin: round, and about the coin's size. A rim-
// cornered drawer shrinks the coin along with the tools, so the size window
// is wide (a quarter either way covers a drawer 200 mm deep from 800 mm), and
// roundness decides between two candidates in it. Returns { index, circle }
// or null when nothing in the drawer looks like the coin.
export function findCoinCandidate(parts, nominalD, opts = {}) {
  const o = { sizeTol: 0.25, maxRmsFrac: 0.06, minFill: 0.7, ...opts };
  if (!Array.isArray(parts) || !(nominalD > 0)) return null;
  let best = null;
  parts.forEach((part, index) => {
    if (!part || !part.outer || part.outer.length < 8 || !part.bbox) return;
    const bb = part.bbox;
    const D = (bb.w + bb.h) / 2;
    if (Math.abs(D - nominalD) > o.sizeTol * nominalD) return;
    if (Math.abs(bb.w - bb.h) > 0.15 * D) return;
    // How much of the circle's disc the outline fills, and how far its
    // vertices sit from the fitted circle: a square bolt head passes the box
    // test and fails both of these. The raw-boundary fit when the part has
    // one (see partFromMask); the refined outline otherwise.
    const circle = part.disc || fitCircle(part.outer);
    if (!circle || !(circle.r > 0)) return;
    const fill = part.area / (Math.PI * circle.r * circle.r);
    if (fill < o.minFill || fill > 1.15) return;
    const rmsFrac = circle.rms / circle.r;
    if (rmsFrac > o.maxRmsFrac) return;
    const score = rmsFrac + Math.abs(1 - fill);
    if (!best || score < best.score) best = { index, circle, score };
  });
  return best ? { index: best.index, circle: best.circle } : null;
}

// The verdict. factor is what every scanned outline must be multiplied by for
// the coin to measure true; percent is how far the tools are reading from
// true, negative when small. warn is set past warnPercent either way.
export function coinScaleCheck(measuredD, nominalD, warnPercent = 2) {
  if (!(measuredD > 0) || !(nominalD > 0)) return null;
  const factor = nominalD / measuredD;
  const percent = (measuredD / nominalD - 1) * 100;
  return {
    measuredMm: measuredD, nominalMm: nominalD, factor, percent,
    warn: Math.abs(percent) > warnPercent,
  };
}

// Every part scaled by factor about a centre, fresh arrays throughout, with
// bbox and area recomputed. The centre is the drawer's own: the rim-versus-
// floor magnification is radial from the camera's foot, which is the drawer's
// centre when it was shot from above the middle, so sizes AND positions scale
// about it and a tool near a wall comes back to the wall.
export function rescaleParts(parts, factor, centre) {
  const k = Number(factor);
  if (!Array.isArray(parts) || !(k > 0)) return parts;
  const c = centre || { x: 0, y: 0 };
  const sc = pts => pts.map(p => ({ x: c.x + (p.x - c.x) * k, y: c.y + (p.y - c.y) * k }));
  return parts.map(part => {
    const outer = sc(part.outer);
    const disc = part.disc ? {
      cx: c.x + (part.disc.cx - c.x) * k, cy: c.y + (part.disc.cy - c.y) * k,
      r: part.disc.r * k, rms: part.disc.rms * k,
    } : part.disc;
    // The thumbnail is a crop in the same millimetres: its corner moves with
    // the outline and each of its pixels covers k times as much.
    const thumb = part.thumb && part.thumb.origin ? {
      ...part.thumb, origin: sc([part.thumb.origin])[0], mmPerPx: part.thumb.mmPerPx * k,
    } : part.thumb;
    return {
      ...part, outer, holes: (part.holes || []).map(sc),
      area: part.area * k * k, bbox: bboxOfPts(outer), disc, thumb,
    };
  });
}
