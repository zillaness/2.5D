// Suggest raised/recessed section regions from the rectified photo.
//
// A single top-down photo carries no true depth, so this can only propose the
// *footprint* of a visually-distinct area (a boss catching light, a shadowed
// pocket, a differently-coloured pad) — never its height. Candidates come back
// as ordinary polygons in mm, to be added as editable sections whose thickness
// / floor offset the user sets. Deliberately conservative: only reasonably
// large, reasonably compact patches that stand out from the object's median
// brightness are returned, so it suggests rather than guesses wildly.

import { morphClean, labelComponents } from './segment.js';
import { traceBoundaries, simplifyClosed, signedArea } from './contour.js';

// Scanline-fill a polygon (pixel coords) into `mask` with `value`.
function fillPolygon(pts, w, h, mask, value) {
  let minY = h, maxY = 0;
  for (const p of pts) { minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y); }
  minY = Math.max(0, Math.floor(minY)); maxY = Math.min(h - 1, Math.ceil(maxY));
  for (let y = minY; y <= maxY; y++) {
    const xs = [];
    for (let i = 0, n = pts.length; i < n; i++) {
      const a = pts[i], b = pts[(i + 1) % n];
      if ((a.y <= y && b.y > y) || (b.y <= y && a.y > y)) {
        xs.push(a.x + (y - a.y) / (b.y - a.y) * (b.x - a.x));
      }
    }
    xs.sort((p, q) => p - q);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const x0 = Math.max(0, Math.ceil(xs[k])), x1 = Math.min(w - 1, Math.floor(xs[k + 1]));
      for (let x = x0; x <= x1; x++) mask[y * w + x] = value;
    }
  }
}

// Boundary polygon (mm) of a component mask's largest outer loop, simplified.
function maskToPolygon(mask, w, h, pxPerMm, simplifyMm) {
  const loops = traceBoundaries(mask, w, h);
  if (!loops.length) return null;
  let best = null, bestA = 0;
  for (const lp of loops) {
    const a = Math.abs(signedArea(lp));
    if (a > bestA) { bestA = a; best = lp; }
  }
  if (!best) return null;
  const simp = simplifyClosed(best, simplifyMm * pxPerMm);
  if (simp.length < 3) return null;
  return simp.map(p => ({ x: p.x / pxPerMm, y: p.y / pxPerMm }));
}

// Detect candidate section footprints inside the object.
//   canvas    : rectified image
//   outerPts  : object outline (mm)
//   holePolys : hole polygons (mm) to exclude
//   pxPerMm   : scale
//   opts: { minAreaFrac=0.02, maxAreaFrac=0.75, maxRegions=6,
//           sensitivity=1.6, simplifyMm=0.6, insetPx=3 }
// Returns [{ pts (mm), kind: 'bright'|'dark', areaMm2 }], largest first.
export function suggestRegions(canvas, outerPts, holePolys, pxPerMm, opts = {}) {
  const {
    minAreaFrac = 0.02, maxAreaFrac = 0.75, maxRegions = 6,
    sensitivity = 1.6, simplifyMm = 0.6, insetPx = 3,
  } = opts;
  const w = canvas.width, h = canvas.height;
  if (!outerPts || outerPts.length < 3 || w < 8 || h < 8) return [];
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const { data } = ctx.getImageData(0, 0, w, h);

  // Interior mask: inside the outline, minus holes, eroded a little so the
  // outline's own shadowed edge isn't mistaken for a dark region.
  const interior = new Uint8Array(w * h);
  const toPx = p => ({ x: p.x * pxPerMm, y: p.y * pxPerMm });
  fillPolygon(outerPts.map(toPx), w, h, interior, 1);
  for (const hole of holePolys || []) fillPolygon(hole.map(toPx), w, h, interior, 0);
  const interiorClean = eroded(interior, w, h, insetPx);

  // Object luma + robust centre/spread over the interior.
  const luma = new Float32Array(w * h);
  const vals = [];
  for (let i = 0, p = 0; i < w * h; i++, p += 4) {
    luma[i] = 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2];
    if (interiorClean[i]) vals.push(luma[i]);
  }
  if (vals.length < 100) return [];
  vals.sort((a, b) => a - b);
  const median = vals[vals.length >> 1];
  const madArr = vals.map(v => Math.abs(v - median)).sort((a, b) => a - b);
  const mad = madArr[madArr.length >> 1] || 1;
  const spread = Math.max(6, mad * 1.4826); // ≈ robust σ, floored
  const band = sensitivity * spread;

  const objArea = vals.length;
  const minA = objArea * minAreaFrac, maxA = objArea * maxAreaFrac;
  const out = [];

  for (const kind of ['bright', 'dark']) {
    const m = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) {
      if (!interiorClean[i]) continue;
      const d = luma[i] - median;
      if (kind === 'bright' ? d > band : d < -band) m[i] = 1;
    }
    const cleaned = morphClean(m, w, h, 2);
    const { labels, sizes } = labelComponents(cleaned, w, h);
    for (let lbl = 0; lbl < sizes.length; lbl++) {
      const size = sizes[lbl];
      if (size < minA || size > maxA) continue;
      const comp = new Uint8Array(w * h);
      let minX = w, minY = h, maxX = 0, maxY = 0;
      for (let i = 0; i < w * h; i++) {
        if (labels[i] !== lbl) continue;
        comp[i] = 1;
        const x = i % w, y = (i / w) | 0;
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
      }
      // Reject slivers: filled fraction of the bounding box must be decent.
      const bboxA = Math.max(1, (maxX - minX + 1) * (maxY - minY + 1));
      if (size / bboxA < 0.25) continue;
      const pts = maskToPolygon(comp, w, h, pxPerMm, simplifyMm);
      if (!pts) continue;
      out.push({ pts, kind, areaMm2: size / (pxPerMm * pxPerMm) });
    }
  }
  out.sort((a, b) => b.areaMm2 - a.areaMm2);
  return out.slice(0, maxRegions);
}

// Small erosion via morphClean's building block would over-clean; do a direct
// min-filter of radius r on a binary mask.
function eroded(mask, w, h, r) {
  if (r <= 0) return mask;
  const tmp = new Uint8Array(w * h), out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let v = 1;
      for (let k = Math.max(0, x - r); k <= Math.min(w - 1, x + r); k++) {
        if (!mask[row + k]) { v = 0; break; }
      }
      tmp[row + x] = v;
    }
  }
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      let v = 1;
      for (let k = Math.max(0, y - r); k <= Math.min(h - 1, y + r); k++) {
        if (!tmp[k * w + x]) { v = 0; break; }
      }
      out[y * w + x] = v;
    }
  }
  return out;
}
