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

  // How much of its own bounding box a component has to fill to count as a
  // tool rather than a smear. js/regions.js uses 0.25, which is an orientation
  // lottery on a drawer: a 200 by 20 mm tool laid at 45 degrees fills 0.165 of
  // its bounding box and would be rejected outright, silently, for the crime of
  // not being square to the drawer. Tools get laid at angles on purpose.
  minFill: 0.07,

  // Least area worth calling a part, in square millimetres. A loose bolt is
  // about 20 and is not a tool that gets a pocket.
  minAreaMm2: 30,
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

  return { outer, holes, area: outerRaw.area, bbox: bboxOfPts(outer) };
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
