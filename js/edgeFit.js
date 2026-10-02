// Edge-fitted corners: refine a coarse paper quad to sub-pixel precision
// (docs/calibration_and_backlog_prd_v1.2.md, Part A step 1).
//
// detectPaperCorners finds the sheet on a 480 px downscale and collapses its
// convex hull to four points. On a 12 MP photo one of its pixels is about
// eight source pixels, and the corners it returns sit exactly where paper
// curls, dog-ears and catches shadows. Every millimetre downstream inherits
// that error.
//
// So this walks the middle of each edge at full resolution instead, finds the
// paper's brightness step to a fraction of a pixel on each of a few dozen
// profiles, fits one robust line per edge, and takes the corners where those
// lines cross. The corners themselves are never sampled. A card with rounded
// corners comes out right for the same reason: the lines meet where the
// card's nominal rectangle has its corner, which is what its size refers to.
//
// It is a refinement, not a detector. It starts from the coarse quad, and it
// hands the coarse quad back untouched whenever any edge fails to fit cleanly,
// so it can only make a detection better or leave it alone.

import { lensParams, distortPixel, undistortPixel } from './lens.js';

export const EDGE_FIT_DEFAULTS = {
  endFrac: 0.08,          // each end of an edge left unsampled, as a fraction of its length
  profiles: 96,           // profiles per edge
  halfWindowFrac: 0.012,  // search half-width, as a fraction of the image diagonal
  minHalfWindow: 8,       // px
  step: 0.5,              // px between samples along a profile
  minContrast: 18,        // luminance drop (0-255) across the edge for a profile to count
  minInlierFrac: 0.4,     // of an edge's profiles
  maxRmsPx: 1.0,          // inlier RMS ceiling, px, raised for large photos by maxRmsFrac
  maxRmsFrac: 0.0006,     // of the image diagonal
  maxMoveFrac: 0.02,      // a refined corner may move this fraction of the diagonal at most
};

const lum = (d, i) => 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];

// Read one rectangle of the source image. Drawing only the source rectangle
// into a canvas its own size keeps every read small, so refining a 12 MP photo
// never holds a full-size copy of it.
function readRegion(image, iw, ih, x0, y0, x1, y1) {
  const rx = Math.max(0, Math.floor(x0)), ry = Math.max(0, Math.floor(y0));
  const rw = Math.min(iw, Math.ceil(x1) + 1) - rx, rh = Math.min(ih, Math.ceil(y1) + 1) - ry;
  if (rw < 2 || rh < 2) return null;
  const c = document.createElement('canvas');
  c.width = rw; c.height = rh;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(image, rx, ry, rw, rh, 0, 0, rw, rh);
  return { x: rx, y: ry, w: rw, h: rh, data: ctx.getImageData(0, 0, rw, rh).data };
}

// Bilinear luminance at an image point, from a region read above. NaN when the
// point falls outside the region or the image.
function sampler(reg) {
  return (x, y) => {
    const fx = x - reg.x, fy = y - reg.y;
    if (fx < 0 || fy < 0 || fx > reg.w - 1 || fy > reg.h - 1) return NaN;
    const x0 = Math.floor(fx), y0 = Math.floor(fy);
    const x1 = Math.min(x0 + 1, reg.w - 1), y1 = Math.min(y0 + 1, reg.h - 1);
    const ax = fx - x0, ay = fy - y0, d = reg.data;
    const a = lum(d, (y0 * reg.w + x0) * 4), b = lum(d, (y0 * reg.w + x1) * 4);
    const c = lum(d, (y1 * reg.w + x0) * 4), e = lum(d, (y1 * reg.w + x1) * 4);
    return (a * (1 - ax) + b * ax) * (1 - ay) + (c * (1 - ax) + e * ax) * ay;
  };
}

const median = arr => {
  if (!arr.length) return NaN;
  const s = arr.slice().sort((p, q) => p - q);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

// Where a profile crosses the paper's edge, as a signed offset along the
// outward normal, or null. Paper is the bright side (detectPaperCorners found
// it as the dominant bright region), so the edge is the steepest bright-to-dark
// step going outward. Its position is the gradient peak, refined by a parabola
// through its neighbours: under symmetric blur that peak is the 50 percent
// crossing, which is where the edge actually is.
function crossing(lumAt, px, py, nx, ny, W, o) {
  const n = Math.floor((2 * W) / o.step) + 1;
  const L = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const s = -W + i * o.step;
    const v = lumAt(px + nx * s, py + ny * s);
    if (Number.isNaN(v)) return null;
    L[i] = v;
  }
  const k = Math.max(1, Math.round(1 / o.step));  // +/- 1 px central difference
  let best = -1, bestG = 0;
  const g = new Float64Array(n);
  for (let i = k; i < n - k; i++) {
    g[i] = (L[i - k] - L[i + k]) / 2;
    if (g[i] > bestG) { bestG = g[i]; best = i; }
  }
  if (best < k + 1 || best > n - k - 2) return null;
  // The step has to be a real one: median brightness a couple of pixels either
  // side of it must differ by minContrast, which a blurred edge passes and
  // paper texture or JPEG noise does not.
  const span = Math.round(4 / o.step), gap = Math.round(2 / o.step);
  const inside = [], outside = [];
  for (let j = best - gap - span; j <= best - gap; j++) if (j >= 0) inside.push(L[j]);
  for (let j = best + gap; j <= best + gap + span; j++) if (j < n) outside.push(L[j]);
  if (!(median(inside) - median(outside) >= o.minContrast)) return null;
  const den = g[best - 1] - 2 * g[best] + g[best + 1];
  const off = den !== 0 ? 0.5 * (g[best - 1] - g[best + 1]) / den : 0;
  return -W + (best + Math.max(-0.5, Math.min(0.5, off))) * o.step;
}

// Theil-Sen line s = a + b t: the median of pairwise slopes, then the median
// intercept. It shrugs off up to roughly a third of outliers, which is what a
// tool lying near an edge or a strip of shadow produces, and it seeds the
// least-squares fit below with the right inliers.
function theilSen(ts, ss) {
  const slopes = [];
  for (let i = 0; i < ts.length; i++) {
    for (let j = i + 1; j < ts.length; j++) {
      const dt = ts[j] - ts[i];
      if (Math.abs(dt) > 1e-9) slopes.push((ss[j] - ss[i]) / dt);
    }
  }
  const b = slopes.length ? median(slopes) : 0;
  return { a: median(ss.map((s, i) => s - b * ts[i])), b };
}

// Total-least-squares line through points: centroid and direction.
function tlsLine(pts) {
  let mx = 0, my = 0;
  for (const p of pts) { mx += p.x; my += p.y; }
  mx /= pts.length; my /= pts.length;
  let sxx = 0, syy = 0, sxy = 0;
  for (const p of pts) {
    const ax = p.x - mx, ay = p.y - my;
    sxx += ax * ax; syy += ay * ay; sxy += ax * ay;
  }
  const th = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  const dx = Math.cos(th), dy = Math.sin(th);
  let ss = 0;
  for (const p of pts) { const d = (p.x - mx) * -dy + (p.y - my) * dx; ss += d * d; }
  return { mx, my, dx, dy, rms: Math.sqrt(ss / pts.length) };
}

function intersect(l1, l2) {
  const den = l1.dx * l2.dy - l1.dy * l2.dx;
  if (Math.abs(den) < 1e-9) return null;
  const t = ((l2.mx - l1.mx) * l2.dy - (l2.my - l1.my) * l2.dx) / den;
  return { x: l1.mx + l1.dx * t, y: l1.my + l1.dy * t };
}

function convex(q) {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const a = q[i], b = q[(i + 1) % 4], c = q[(i + 2) % 4];
    const z = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (Math.abs(z) < 1e-9) return false;
    if (!sign) sign = Math.sign(z); else if (Math.sign(z) !== sign) return false;
  }
  return true;
}

// Refine corners ordered TL, TR, BR, BL (photo pixels). opts.k1 / opts.k2 are
// the current lens coefficients: edges are only straight once undistorted, so
// lines are fitted in undistorted space and the corners distorted back.
// Returns { ok, corners, edges, moved, reason }. When ok is false, corners is
// the input, untouched.
export function refineCorners(image, corners, opts = {}) {
  const o = { ...EDGE_FIT_DEFAULTS, ...opts };
  const fail = (reason, edges) => ({ ok: false, corners, edges: edges || [], moved: 0, reason });
  if (!image || !corners || corners.length !== 4) return fail('no corners');
  const iw = image.naturalWidth || image.width, ih = image.naturalHeight || image.height;
  const diag = Math.hypot(iw, ih);
  const W = Math.max(o.minHalfWindow, o.halfWindowFrac * diag);
  const k1 = Number(o.k1) || 0, k2 = Number(o.k2) || 0;
  const lp = lensParams(iw, ih);
  const und = p => (k1 || k2 ? undistortPixel(p, k1, k2, lp) : { x: p.x, y: p.y });
  const dis = p => (k1 || k2 ? distortPixel(p, k1, k2, lp) : { x: p.x, y: p.y });
  const cx = corners.reduce((s, p) => s + p.x, 0) / 4;
  const cy = corners.reduce((s, p) => s + p.y, 0) / 4;
  const uc = corners.map(und);
  const maxRms = Math.max(o.maxRmsPx, o.maxRmsFrac * diag);

  const lines = [], edges = [];
  for (let e = 0; e < 4; e++) {
    const a = corners[e], b = corners[(e + 1) % 4];
    const ex = b.x - a.x, ey = b.y - a.y, len = Math.hypot(ex, ey);
    if (len < 8 * W) return fail(`edge ${e} too short to fit`, edges);
    let nx = -ey / len, ny = ex / len;
    if (((a.x + b.x) / 2 - cx) * nx + ((a.y + b.y) / 2 - cy) * ny < 0) { nx = -nx; ny = -ny; }

    // Profiles in chunks, each read as its own small region.
    const pts = [];
    const ts = [];
    const CHUNK = 16;
    for (let c0 = 0; c0 < o.profiles; c0 += CHUNK) {
      const c1 = Math.min(o.profiles, c0 + CHUNK);
      const tAt = i => o.endFrac + (1 - 2 * o.endFrac) * (i + 0.5) / o.profiles;
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (let i = c0; i < c1; i++) {
        const t = tAt(i), px = a.x + ex * t, py = a.y + ey * t;
        for (const s of [-W - 2, W + 2]) {
          x0 = Math.min(x0, px + nx * s); x1 = Math.max(x1, px + nx * s);
          y0 = Math.min(y0, py + ny * s); y1 = Math.max(y1, py + ny * s);
        }
      }
      const reg = readRegion(image, iw, ih, x0, y0, x1, y1);
      if (!reg) continue;
      const lumAt = sampler(reg);
      for (let i = c0; i < c1; i++) {
        const t = tAt(i), px = a.x + ex * t, py = a.y + ey * t;
        const s = crossing(lumAt, px, py, nx, ny, W, o);
        if (s === null) continue;
        pts.push(und({ x: px + nx * s, y: py + ny * s }));
        ts.push(t);
      }
    }
    const need = Math.max(12, Math.ceil(o.minInlierFrac * o.profiles));
    if (pts.length < need) {
      edges.push({ total: o.profiles, found: pts.length, inliers: 0, rms: null });
      return fail(`edge ${e}: the paper's edge was found on only ${pts.length} of ${o.profiles} profiles`, edges);
    }

    // Offsets from the undistorted coarse edge, so the robust seed works in a
    // frame where the true edge is a straight, nearly flat line.
    const ua = uc[e], ub = uc[(e + 1) % 4];
    const ul = Math.hypot(ub.x - ua.x, ub.y - ua.y) || 1;
    const ux = (ub.x - ua.x) / ul, uy = (ub.y - ua.y) / ul;
    const along = pts.map(p => (p.x - ua.x) * ux + (p.y - ua.y) * uy);
    const off = pts.map(p => (p.x - ua.x) * -uy + (p.y - ua.y) * ux);
    const seed = theilSen(along, off);
    const res = off.map((s, i) => s - (seed.a + seed.b * along[i]));
    const sigma = 1.4826 * median(res.map(Math.abs));
    const thr = Math.max(1, 3 * sigma);
    let inl = pts.filter((_, i) => Math.abs(res[i]) <= thr);
    let line = tlsLine(inl);
    // Two passes of trimming against the fitted line itself.
    for (let pass = 0; pass < 2; pass++) {
      const d = pts.map(p => Math.abs((p.x - line.mx) * -line.dy + (p.y - line.my) * line.dx));
      const s2 = 1.4826 * median(d);
      const t2 = Math.max(1, 3 * s2);
      const next = pts.filter((_, i) => d[i] <= t2);
      if (next.length < need) break;
      inl = next;
      line = tlsLine(inl);
    }
    edges.push({ total: o.profiles, found: pts.length, inliers: inl.length, rms: line.rms });
    if (inl.length < need) return fail(`edge ${e}: only ${inl.length} profiles agree on a line`, edges);
    if (line.rms > maxRms) return fail(`edge ${e}: too ragged to trust (${line.rms.toFixed(2)} px RMS)`, edges);
    lines.push(line);
  }

  // Corner i is where the edge ending at it meets the edge starting at it.
  const out = [];
  for (let i = 0; i < 4; i++) {
    const p = intersect(lines[(i + 3) % 4], lines[i]);
    if (!p) return fail('two edges are parallel', edges);
    out.push(dis(p));
  }
  if (!convex(out)) return fail('the fitted corners do not form a convex quad', edges);
  let moved = 0;
  for (let i = 0; i < 4; i++) moved = Math.max(moved, Math.hypot(out[i].x - corners[i].x, out[i].y - corners[i].y));
  if (moved > o.maxMoveFrac * diag) {
    return fail(`a fitted corner moved ${moved.toFixed(1)} px, too far from the detection to trust`, edges);
  }
  return { ok: true, corners: out, edges, moved, reason: null };
}
