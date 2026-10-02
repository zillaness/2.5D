// The fit: shape from the frame, scale from the paper
// (docs/calibration_and_backlog_prd_v1.2.md, Part A, plan step 7).
//
// Recognition (js/calibDetect.js) hands over every black clock cell as a
// point with known design coordinates and every frame dip as a point on a
// known design line, all in raw photo pixels. This turns them into one
// mapping from the sheet's design plane to the photo: a radial lens term,
// then a homography fitted by least squares over every point with the
// frame lines as extra constraints, Hartley-normalised first because pixel
// and millimetre coordinates in one system are badly conditioned without it.
//
// The homography is fitted in the photo-to-design direction, G, because a
// line constraint ("this dip lies on the design line y = 11") is linear in
// G's entries, and the point equations are linear in them too. G's last
// entry is fixed at 1, which the normalisation makes safe, so the system is
// the eight-by-eight normal equations. H, design to photo, is G's inverse.
//
// The fit figure is the RMS distance, in design millimetres, between where
// the clock cells were read and where the fitted mapping puts them, with the
// frame dips' residuals from their lines folded in. A bent sheet and an
// uncorrected lens both raise it.

import { lensParams, undistortPixel, distortPixel } from './lens.js';
import { LAYOUT_V1 } from './calibSheet.js';

export const FIT_DEFAULTS = {
  k1Range: [-0.35, 0.35],
  lensIterations: 40,
  trimSigma: 3,
  lineWeight: 1,
  minPoints: 4,
};

// ---------- linear algebra ----------

function solve(A, b) {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    if (Math.abs(M[piv][col]) < 1e-14) return null;
    if (piv !== col) [M[col], M[piv]] = [M[piv], M[col]];
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = M[r][col] / M[col][col];
      if (f === 0) continue;
      for (let c = col; c <= n; c++) M[r][c] -= f * M[col][c];
    }
  }
  return M.map((row, i) => row[n] / row[i]);
}

export function invert3(H) {
  const [a, b, c, d, e, f, g, h, i] = H;
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-18) return null;
  const inv = [
    A, -(b * i - c * h), b * f - c * e,
    B, a * i - c * g, -(a * f - c * d),
    C, -(a * h - b * g), a * e - b * d,
  ].map(v => v / det);
  return inv;
}

export function apply(H, x, y) {
  const w = H[6] * x + H[7] * y + H[8];
  return { x: (H[0] * x + H[1] * y + H[2]) / w, y: (H[3] * x + H[4] * y + H[5]) / w };
}

function mul3(A, B) {
  const out = new Array(9).fill(0);
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) for (let k = 0; k < 3; k++) out[r * 3 + c] += A[r * 3 + k] * B[k * 3 + c];
  return out;
}

// Hartley normalisation: a similarity taking the points' centroid to the
// origin and their RMS distance to sqrt(2). Returns the 3x3 matrix.
function normaliser(pts) {
  let mx = 0, my = 0;
  for (const p of pts) { mx += p.x; my += p.y; }
  mx /= pts.length; my /= pts.length;
  let d = 0;
  for (const p of pts) d += Math.hypot(p.x - mx, p.y - my);
  const s = pts.length ? Math.SQRT2 / (d / pts.length || 1) : 1;
  return [s, 0, -s * mx, 0, s, -s * my, 0, 0, 1];
}

// The design lines a frame side's dips lie on, as a x + b y = c in design
// millimetres, from the layout's frame centreline.
export function frameLine(geom, side) {
  const fc = geom.frame.centre;
  switch (side) {
    case 'top': return { a: 0, b: 1, c: fc.y };
    case 'bottom': return { a: 0, b: 1, c: fc.y + fc.h };
    case 'left': return { a: 1, b: 0, c: fc.x };
    case 'right': return { a: 1, b: 0, c: fc.x + fc.w };
    default: return null;
  }
}

// Least-squares G (photo -> design) from points and line constraints, with
// per-equation weights. Returns G or null.
function fitG(points, lineCons, w) {
  if (!points.length && lineCons.length < 4) return null;
  const photoPts = points.map(p => p.photo).concat(lineCons.map(l => l.photo));
  const designPts = points.map(p => p.design);
  if (!photoPts.length) return null;
  const Tp = normaliser(photoPts);
  const Td = designPts.length ? normaliser(designPts) : [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const np = p => apply(Tp, p.x, p.y);
  const nd = p => apply(Td, p.x, p.y);
  // Normal equations for g0..g7 with g8 = 1.
  const AtA = Array.from({ length: 8 }, () => new Array(8).fill(0));
  const Atb = new Array(8).fill(0);
  const add = (row, rhs, weight) => {
    for (let i = 0; i < 8; i++) {
      if (!row[i]) continue;
      Atb[i] += weight * row[i] * rhs;
      for (let j = 0; j < 8; j++) if (row[j]) AtA[i][j] += weight * row[i] * row[j];
    }
  };
  for (const p of points) {
    const q = np(p.photo), d = nd(p.design);
    // (g0 x + g1 y + g2) - X (g6 x + g7 y + 1) = 0  ->  row . g = X
    add([q.x, q.y, 1, 0, 0, 0, -d.x * q.x, -d.x * q.y], d.x, p.w || 1);
    add([0, 0, 0, q.x, q.y, 1, -d.y * q.x, -d.y * q.y], d.y, p.w || 1);
  }
  for (const l of lineCons) {
    // The design line a x + b y = c, in normalised design coordinates: the
    // normaliser is a similarity, so the line maps to a' x' + b' y' = c'.
    const s = Td[0], tx = Td[2], ty = Td[5];
    const a = l.a / s, b = l.b / s, c = l.c + a * tx + b * ty;
    const q = np(l.photo);
    // a (g0 x + g1 y + g2) + b (g3 x + g4 y + g5) - c (g6 x + g7 y + 1) = 0
    add([a * q.x, a * q.y, a, b * q.x, b * q.y, b, -c * q.x, -c * q.y], c, (l.w || 1) * w.lineWeight);
  }
  const g = solve(AtA, Atb);
  if (!g) return null;
  const Gn = [...g, 1];
  // Denormalise: G = Td^-1 Gn Tp.
  const TdInv = invert3(Td);
  if (!TdInv) return null;
  return mul3(TdInv, mul3(Gn, Tp));
}

// Residuals of a fit in design millimetres: points against their design
// position, line dips against their design line.
function residuals(G, points, lineCons) {
  const pr = points.map(p => { const d = apply(G, p.photo.x, p.photo.y); return Math.hypot(d.x - p.design.x, d.y - p.design.y); });
  const lr = lineCons.map(l => { const d = apply(G, l.photo.x, l.photo.y); return Math.abs(l.a * d.x + l.b * d.y - l.c) / Math.hypot(l.a, l.b); });
  return { points: pr, lines: lr };
}
const rms = arr => (arr.length ? Math.sqrt(arr.reduce((s, r) => s + r * r, 0) / arr.length) : 0);

// Fit the sheet. rec is recogniseSheet's result (ok). opts.k1: a fixed lens
// coefficient (null fits one); opts.fitLens: false keeps opts.k1 or 0.
// Returns { ok, G, H, k1, fit: { rmsMm, maxMm, pointsMm, linesMm, points, lines, trimmed }, map }.
export function fitSheet(rec, imgW, imgH, opts = {}) {
  const o = { ...FIT_DEFAULTS, ...opts };
  if (!rec || !rec.ok || !rec.geom) return { ok: false, reason: 'nothing recognised' };
  const geom = rec.geom;
  const lp = lensParams(imgW, imgH);
  const rawPoints = (rec.points || []).filter(p => p.raw).map(p => ({ raw: p.raw, design: p.design }));
  const rawLines = [];
  for (const l of rec.lines || []) {
    const line = frameLine(geom, l.side);
    if (!line) continue;
    for (const r of l.raw || []) rawLines.push({ raw: r, ...line, side: l.side });
  }
  if (rawPoints.length < o.minPoints && rawLines.length < 40) return { ok: false, reason: 'too few points and lines to fit' };

  // Everything for one k1: undistort, fit G with a trimming pass, residuals.
  const evaluate = (k1, trim = true) => {
    const und = p => (k1 ? undistortPixel(p, k1, 0, lp) : { x: p.x, y: p.y });
    let pts = rawPoints.map(p => ({ photo: und(p.raw), design: p.design, w: 1 }));
    let lns = rawLines.map(l => ({ photo: und(l.raw), a: l.a, b: l.b, c: l.c, w: 1, side: l.side }));
    let G = fitG(pts, lns, o);
    if (!G) return null;
    const allPts = pts, allLns = lns;
    let trimmed = 0;
    if (trim) {
      // Gross misreads only: a clock cell or a dip far from its fellows.
      // Points and lines are trimmed against their own spread, since a
      // clock cell is read less precisely than a dip centre and the dips
      // outnumber the cells; and never more than a tenth of either, so a
      // sheet that is not flat keeps the cells that say so and the figure
      // below reports it rather than hiding it.
      const r = residuals(G, pts, lns);
      const thrFor = arr => {
        if (!arr.length) return Infinity;
        const sorted = arr.slice().sort((a, b) => a - b);
        const med = sorted[sorted.length >> 1] || 0;
        const p90 = sorted[Math.floor(0.9 * (sorted.length - 1))];
        return Math.max(0.05, o.trimSigma * 1.4826 * med, p90);
      };
      const tp = thrFor(r.points), tl = thrFor(r.lines);
      const keepP = pts.filter((_, i) => r.points[i] <= tp);
      const keepL = lns.filter((_, i) => r.lines[i] <= tl);
      trimmed = pts.length + lns.length - keepP.length - keepL.length;
      if ((keepP.length >= o.minPoints || keepL.length >= 40) && trimmed > 0) {
        const G2 = fitG(keepP, keepL, o);
        if (G2) { G = G2; pts = keepP; lns = keepL; }
      }
    }
    const r = residuals(G, pts, lns);
    // The figure reported is over everything recognised, trimmed or not:
    // a figure that does not respond to real error is decoration.
    const rAll = residuals(G, allPts, allLns);
    return { G, k1, pts, lns, r, rAll, trimmed, cost: rms(rAll.points.concat(rAll.lines)) };
  };

  let best;
  if (o.fitLens === false || Number.isFinite(o.k1)) {
    best = evaluate(Number(o.k1) || 0);
  } else {
    // Golden-section over k1 on the whole fit's residual: the homography is
    // re-fitted at every trial, so the figure minimised is the one reported.
    const gr = (Math.sqrt(5) - 1) / 2;
    let lo = o.k1Range[0], hi = o.k1Range[1];
    const cache = new Map();
    const cost = k => {
      const key = Math.round(k * 1e6);
      if (!cache.has(key)) { const e = evaluate(k, false); cache.set(key, e ? e.cost : Infinity); }
      return cache.get(key);
    };
    // A coarse scan first, so a local dip near the edge of the range cannot
    // capture the search.
    let bestK = 0, bestC = cost(0);
    for (let k = lo; k <= hi + 1e-9; k += 0.05) { const c = cost(k); if (c < bestC) { bestC = c; bestK = k; } }
    lo = Math.max(o.k1Range[0], bestK - 0.05); hi = Math.min(o.k1Range[1], bestK + 0.05);
    for (let i = 0; i < o.lensIterations; i++) {
      const x1 = hi - gr * (hi - lo), x2 = lo + gr * (hi - lo);
      if (cost(x1) < cost(x2)) hi = x2; else lo = x1;
    }
    best = evaluate((lo + hi) / 2);
  }
  if (!best) return { ok: false, reason: 'the fit is degenerate' };
  const H = invert3(best.G);
  if (!H) return { ok: false, reason: 'the fit is degenerate' };
  const k1 = best.k1;
  const designToPhoto = p => { const q = apply(H, p.x, p.y); return k1 ? distortPixel(q, k1, 0, lp) : q; };
  const photoToDesign = p => { const u = k1 ? undistortPixel(p, k1, 0, lp) : p; return apply(best.G, u.x, u.y); };
  return {
    ok: true, G: best.G, H, k1: Math.round(k1 * 1e4) / 1e4,
    fit: {
      rmsMm: best.cost, pointsMm: rms(best.rAll.points), linesMm: rms(best.rAll.lines),
      maxMm: Math.max(0, ...best.rAll.points, ...best.rAll.lines),
      keptRmsMm: rms(best.r.points.concat(best.r.lines)),
      points: best.pts.length, lines: best.lns.length, trimmed: best.trimmed,
    },
    designToPhoto, photoToDesign, geom,
  };
}

// The paper's corners in the photo for a sheet whose paper edges are not
// measured: design coordinates taken as true (a 1:1 print on the layout's
// stock), re-distorted. Step 8 replaces this with the fitted rectangle.
export function designCorners(fit, stockW, stockH) {
  return [[0, 0], [stockW, 0], [stockW, stockH], [0, stockH]].map(([x, y]) => fit.designToPhoto({ x, y }));
}

export const SHEET_WINDOW_INSET = LAYOUT_V1.windowInset;
