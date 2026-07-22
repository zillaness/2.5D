// Copyright (C) 2026 Projects and Mods
// GPL-3.0-or-later WITH Commons Clause (non-commercial) - see LICENSE.

// Radial lens-distortion (Brown–Conrady) model and estimation.
//
// A real lens bends straight world lines into curves, worst toward the frame
// edges. The paper's edges are known-straight, so their curvature measures the
// distortion; correcting it makes the perspective rectification (and therefore
// the trace) accurate all the way to the corners, not just near the centre.
//
// Convention: coordinates are normalized about the image centre by the image
// half-diagonal, so an image corner sits at radius ≈ 1 and k1/k2 are O(1).
//
//   forward  (undistorted → distorted):  s_d = s_u · (1 + k1·r² + k2·r⁴),  r=|s_u|
//   inverse  (distorted → undistorted):  fixed-point iteration
//
// Rectification samples the source (distorted) image, so it uses `distortPixel`
// to go from an ideal pixel to where it actually landed; corner placement uses
// `undistortPixel` to straighten the clicked corners before the homography.

export function lensParams(imgW, imgH) {
  return { cx: imgW / 2, cy: imgH / 2, normR: 0.5 * Math.hypot(imgW, imgH) || 1 };
}

// Undistorted pixel -> distorted pixel.
export function distortPixel(p, k1, k2, lp) {
  if (!k1 && !k2) return { x: p.x, y: p.y };
  const sx = (p.x - lp.cx) / lp.normR, sy = (p.y - lp.cy) / lp.normR;
  const r2 = sx * sx + sy * sy;
  const f = 1 + k1 * r2 + k2 * r2 * r2;
  return { x: lp.cx + sx * f * lp.normR, y: lp.cy + sy * f * lp.normR };
}

// Distorted pixel -> undistorted pixel (inverse of distortPixel).
export function undistortPixel(p, k1, k2, lp) {
  if (!k1 && !k2) return { x: p.x, y: p.y };
  const dx = (p.x - lp.cx) / lp.normR, dy = (p.y - lp.cy) / lp.normR;
  let sx = dx, sy = dy;
  for (let i = 0; i < 12; i++) {
    const r2 = sx * sx + sy * sy;
    const f = 1 + k1 * r2 + k2 * r2 * r2;
    sx = dx / f; sy = dy / f;
  }
  return { x: lp.cx + sx * lp.normR, y: lp.cy + sy * lp.normR };
}

// Perpendicular residual RMS of points fit to a line (collinearity error).
function lineResidual(pts) {
  const n = pts.length;
  if (n < 3) return 0;
  let mx = 0, my = 0;
  for (const p of pts) { mx += p.x; my += p.y; }
  mx /= n; my /= n;
  let sxx = 0, syy = 0, sxy = 0;
  for (const p of pts) {
    const ax = p.x - mx, ay = p.y - my;
    sxx += ax * ax; syy += ay * ay; sxy += ax * ay;
  }
  // Total-least-squares line direction = major eigenvector of covariance.
  const theta = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  const nx = -Math.sin(theta), ny = Math.cos(theta); // line normal
  let err = 0;
  for (const p of pts) {
    const d = (p.x - mx) * nx + (p.y - my) * ny;
    err += d * d;
  }
  return Math.sqrt(err / n);
}

// Detect points along the four paper edges in the image, by walking each
// corner-to-corner span and finding the strongest brightness transition on the
// perpendicular (paper is brighter than the surroundings). Returns 4 arrays of
// distorted pixel points (one per edge), or null on failure.
export function detectEdgePoints(image, corners, samples = 24) {
  const iw = image.naturalWidth || image.width, ih = image.naturalHeight || image.height;
  const scale = Math.min(1, 640 / Math.max(iw, ih));
  const w = Math.max(2, Math.round(iw * scale)), h = Math.max(2, Math.round(ih * scale));
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(image, 0, 0, w, h);
  const { data } = ctx.getImageData(0, 0, w, h);
  const lum = (x, y) => {
    x = Math.max(0, Math.min(w - 1, Math.round(x)));
    y = Math.max(0, Math.min(h - 1, Math.round(y)));
    const i = (y * w + x) * 4;
    return 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
  };
  const cen = { x: corners.reduce((s, c) => s + c.x, 0) / 4 * scale, y: corners.reduce((s, c) => s + c.y, 0) / 4 * scale };
  const sc = corners.map(c => ({ x: c.x * scale, y: c.y * scale }));
  const span = Math.max(6, Math.hypot(w, h) * 0.04); // perpendicular search range (px)

  const edges = [];
  for (let e = 0; e < 4; e++) {
    const a = sc[e], b = sc[(e + 1) % 4];
    const ex = b.x - a.x, ey = b.y - a.y;
    const len = Math.hypot(ex, ey) || 1;
    // Perpendicular pointing away from the paper centre (outward).
    let nx = -ey / len, ny = ex / len;
    const midx = (a.x + b.x) / 2, midy = (a.y + b.y) / 2;
    if ((midx - cen.x) * nx + (midy - cen.y) * ny < 0) { nx = -nx; ny = -ny; }
    const pts = [];
    for (let s = 1; s < samples; s++) {
      const t = s / samples;
      const px = a.x + ex * t, py = a.y + ey * t;
      // Steepest bright→dark transition along the outward normal.
      let bestGrad = 0, bestOff = 0;
      for (let o = -span; o <= span; o += 1) {
        const g = lum(px + nx * (o - 1), py + ny * (o - 1)) - lum(px + nx * (o + 1), py + ny * (o + 1));
        if (g > bestGrad) { bestGrad = g; bestOff = o; }
      }
      if (bestGrad > 25) pts.push({ x: (px + nx * bestOff) / scale, y: (py + ny * bestOff) / scale });
    }
    if (pts.length < Math.max(4, samples * 0.4)) return null; // edge not found clearly
    edges.push(pts);
  }
  return edges;
}

// Estimate k1 (single radial term) that best straightens the paper edges.
// Returns { k1, improved } — improved is the residual drop vs k1=0, or null.
export function estimateDistortion(image, corners) {
  let edges;
  try { edges = detectEdgePoints(image, corners); } catch { return null; }
  if (!edges) return null;
  const lp = lensParams(image.naturalWidth || image.width, image.naturalHeight || image.height);
  const cost = k1 => {
    let e = 0;
    for (const edge of edges) e += lineResidual(edge.map(p => undistortPixel(p, k1, 0, lp)));
    return e;
  };
  // Coarse scan then golden-section refine over a sane range.
  let best = 0, bestC = cost(0);
  for (let k = -0.35; k <= 0.35; k += 0.01) {
    const c = cost(k);
    if (c < bestC) { bestC = c; best = k; }
  }
  let lo = best - 0.02, hi = best + 0.02;
  const gr = (Math.sqrt(5) - 1) / 2;
  for (let i = 0; i < 30; i++) {
    const x1 = hi - gr * (hi - lo), x2 = lo + gr * (hi - lo);
    if (cost(x1) < cost(x2)) hi = x2; else lo = x1;
  }
  const k1 = (lo + hi) / 2;
  const base = cost(0);
  return { k1: Math.round(k1 * 1000) / 1000, improved: base > 0 ? (base - cost(k1)) / base : 0 };
}
