// Automatic paper-corner detection.
//
// Strategy: the paper is the dominant bright, low-saturation region. Downscale,
// score each pixel by "paperness", threshold with Otsu, take the largest
// connected bright component, then collapse its convex hull to a quadrilateral.
// Returns 4 full-resolution corner points ordered TL, TR, BR, BL, or null.

function otsu(hist, total) {
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0, wB = 0, best = 0, thresh = 127;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += t * hist[t];
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best) { best = between; thresh = t; }
  }
  return thresh;
}

// Andrew's monotone chain convex hull; points as [x, y] pairs.
function convexHull(pts) {
  pts = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (pts.length <= 3) return pts;
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  lower.pop(); upper.pop();
  return lower.concat(upper);
}

// Pick the 4 hull vertices that maximize quadrilateral area. Hulls here are
// small (post-simplification), so the O(n^4) scan is fine for n <= ~40.
function bestQuad(hull) {
  const n = hull.length;
  if (n < 4) return null;
  if (n === 4) return hull.slice();
  const area = (a, b, c) => Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1])) / 2;
  let best = 0, quad = null;
  for (let i = 0; i < n; i++)
    for (let j = i + 1; j < n; j++)
      for (let k = j + 1; k < n; k++)
        for (let l = k + 1; l < n; l++) {
          const a = area(hull[i], hull[j], hull[k]) + area(hull[i], hull[k], hull[l]);
          if (a > best) { best = a; quad = [hull[i], hull[j], hull[k], hull[l]]; }
        }
  return quad;
}

// Simplify a closed polyline with RDP so bestQuad stays cheap.
function rdp(points, eps) {
  if (points.length < 3) return points;
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [s, e] = stack.pop();
    const [x1, y1] = points[s], [x2, y2] = points[e];
    const dx = x2 - x1, dy = y2 - y1;
    const len = Math.hypot(dx, dy) || 1e-9;
    let maxD = 0, maxI = -1;
    for (let i = s + 1; i < e; i++) {
      const d = Math.abs(dx * (y1 - points[i][1]) - (x1 - points[i][0]) * dy) / len;
      if (d > maxD) { maxD = d; maxI = i; }
    }
    if (maxD > eps) {
      keep[maxI] = 1;
      stack.push([s, maxI], [maxI, e]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

export function orderCorners(quad) {
  // Order TL, TR, BR, BL by angle around the centroid (image coords, y down).
  const cx = quad.reduce((s, p) => s + p[0], 0) / 4;
  const cy = quad.reduce((s, p) => s + p[1], 0) / 4;
  const sorted = quad.slice().sort(
    (a, b) => Math.atan2(a[1] - cy, a[0] - cx) - Math.atan2(b[1] - cy, b[0] - cx)
  );
  // sorted is CCW-in-screen starting from angle -pi; rotate so TL
  // (most negative x+y relative to centroid) comes first, then ensure
  // screen order TL -> TR -> BR -> BL (clockwise on screen).
  let tlIdx = 0, bestScore = Infinity;
  for (let i = 0; i < 4; i++) {
    const s = (sorted[i][0] - cx) + (sorted[i][1] - cy);
    if (s < bestScore) { bestScore = s; tlIdx = i; }
  }
  const rot = [];
  for (let i = 0; i < 4; i++) rot.push(sorted[(tlIdx + i) % 4]);
  // atan2 ordering with y-down produces TL -> BL -> BR -> TR when the shape is
  // roughly axis aligned; detect and flip so the result is TL, TR, BR, BL.
  if (rot[1][1] - rot[0][1] > Math.abs(rot[1][0] - rot[0][0])) {
    return [rot[0], rot[3], rot[2], rot[1]].map(([x, y]) => ({ x, y }));
  }
  return rot.map(([x, y]) => ({ x, y }));
}

// The downscaled paperness map: brightness minus a saturation penalty, and
// Otsu's threshold on it. Shared by the single-paper detector and the
// several-sheet finder; the two differ only in the downscale and in what they
// keep.
function paperness(image, maxSide) {
  const iw = image.naturalWidth || image.width;
  const ih = image.naturalHeight || image.height;
  const scale = Math.min(1, maxSide / Math.max(iw, ih));
  const w = Math.max(2, Math.round(iw * scale));
  const h = Math.max(2, Math.round(ih * scale));

  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(image, 0, 0, w, h);
  const { data } = ctx.getImageData(0, 0, w, h);

  // Paperness: brightness minus saturation penalty.
  const score = new Uint8ClampedArray(w * h);
  const hist = new Uint32Array(256);
  for (let i = 0, p = 0; i < w * h; i++, p += 4) {
    const r = data[p], g = data[p + 1], b = data[p + 2];
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    const s = Math.max(0, mx - (mx - mn) * 1.5);
    score[i] = s;
    hist[Math.round(s)]++;
  }
  const t = otsu(hist, w * h);
  return { w, h, scale, score, t };
}

// Connected components of a mask (4-connected scanline flood fill). Returns
// the label map and, per label, its pixel count and bounding box.
function components(mask, w, h) {
  const labels = new Int32Array(w * h).fill(-1);
  const comps = [];
  const stack = [];
  for (let start = 0; start < w * h; start++) {
    if (mask[start] === 0 || labels[start] !== -1) continue;
    const label = comps.length;
    let count = 0, x0 = w, y0 = h, x1 = -1, y1 = -1;
    stack.length = 0;
    stack.push(start);
    labels[start] = label;
    while (stack.length) {
      const idx = stack.pop();
      count++;
      const x = idx % w, y = (idx / w) | 0;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      if (x > 0 && mask[idx - 1] && labels[idx - 1] === -1) { labels[idx - 1] = label; stack.push(idx - 1); }
      if (x < w - 1 && mask[idx + 1] && labels[idx + 1] === -1) { labels[idx + 1] = label; stack.push(idx + 1); }
      if (y > 0 && mask[idx - w] && labels[idx - w] === -1) { labels[idx - w] = label; stack.push(idx - w); }
      if (y < h - 1 && mask[idx + w] && labels[idx + w] === -1) { labels[idx + w] = label; stack.push(idx + w); }
    }
    comps.push({ label, count, x0, y0, x1, y1 });
  }
  return { labels, comps };
}

// A component's boundary pixels, its convex hull and the best quadrilateral
// of the hull, in downscaled pixels. Null when the hull is degenerate.
function componentQuad(labels, w, h, label) {
  const boundary = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (labels[i] !== label) continue;
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1 ||
          labels[i - 1] !== label || labels[i + 1] !== label ||
          labels[i - w] !== label || labels[i + w] !== label) {
        boundary.push([x, y]);
      }
    }
  }
  if (boundary.length < 4) return null;
  let hull = convexHull(boundary);
  if (hull.length > 40) hull = rdp([...hull, hull[0]], 1.5).slice(0, -1);
  const quad = bestQuad(hull);
  if (!quad) return null;
  let hullArea = 0;
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i], b = hull[(i + 1) % hull.length];
    hullArea += a[0] * b[1] - b[0] * a[1];
  }
  return { quad, hull, hullArea: Math.abs(hullArea) / 2 };
}

export function detectPaperCorners(image) {
  const { w, h, scale, score, t } = paperness(image, 480);
  const mask = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) mask[i] = score[i] > t ? 1 : 0;

  // Largest connected bright component.
  const { labels, comps } = components(mask, w, h);
  let best = null;
  for (const c of comps) if (!best || c.count > best.count) best = c;
  if (!best || best.count < w * h * 0.05) return null; // paper should dominate

  const cq = componentQuad(labels, w, h, best.label);
  if (!cq) return null;
  const inv = 1 / scale;
  return orderCorners(cq.quad.map(([x, y]) => [(x + 0.5) * inv, (y + 0.5) * inv]));
}

export const REGION_DEFAULTS = {
  maxSide: 960,       // the downscale: a 2 mm frame line at 3 px/mm in the photo is still a pixel here
  minArea: 0.004,     // a sheet is at least this share of the photo (eight Letter sheets in a 1.5 x 1 m view are 0.04 each)
  maxArea: 0.95,      // and not the whole photo
  ringFill: 0.5,      // a dark component is a frame ring, not a shadow or a part, when it fills at most this much of its hull
  maxBorders: 2,      // a component touching more photo borders than this is the desk, not a sheet
  maxRegions: 24,
};

// Every bright, sheet-sized component, and every dark ring that could be a
// frame line around one (calibration_and_backlog_prd_v1.2, phase 2, plan
// step 14), as rough corner quads in full-resolution pixels, largest first.
// A sheet on a dark desk yields its paper, its window and its frame ring,
// three seeds for one sheet; the window and the ring are dropped when a
// bright seed of about a sheet's size contains them. A sheet on a white
// desk, where the paper merges with the desk, yields its ring and its
// window only, which is the fallback. Nothing here decides what is a sheet:
// the recogniser does, seed by seed, and gives up quietly on the rest.
export function detectPaperRegions(image, opts = {}) {
  const o = { ...REGION_DEFAULTS, ...opts };
  const { w, h, scale, score, t } = paperness(image, o.maxSide);
  const total = w * h;
  const bright = new Uint8Array(total), dark = new Uint8Array(total);
  for (let i = 0; i < total; i++) { bright[i] = score[i] > t ? 1 : 0; dark[i] = score[i] <= t ? 1 : 0; }
  const inv = 1 / scale;
  const out = [];
  const borders = c => (c.x0 === 0) + (c.y0 === 0) + (c.x1 === w - 1) + (c.y1 === h - 1);
  const consider = (mask, kind) => {
    const { labels, comps } = components(mask, w, h);
    for (const c of comps) {
      const box = (c.x1 - c.x0 + 1) * (c.y1 - c.y0 + 1);
      if (box < total * o.minArea || box > total * o.maxArea) continue;
      if (borders(c) > o.maxBorders) continue;
      const cq = componentQuad(labels, w, h, c.label);
      if (!cq || cq.hullArea < total * o.minArea) continue;
      const fill = c.count / cq.hullArea;
      if (kind === 'ring' && fill > o.ringFill) continue;
      const corners = orderCorners(cq.quad.map(([x, y]) => [(x + 0.5) * inv, (y + 0.5) * inv]));
      out.push({ kind, corners, hull: cq.hull.map(([x, y]) => ({ x: (x + 0.5) * inv, y: (y + 0.5) * inv })), area: cq.hullArea / total, fill, borders: borders(c),
        touch: { left: c.x0 === 0, top: c.y0 === 0, right: c.x1 === w - 1, bottom: c.y1 === h - 1 },
        centre: { x: (c.x0 + c.x1 + 1) / 2 * inv, y: (c.y0 + c.y1 + 1) / 2 * inv } });
    }
  };
  consider(bright, 'bright');
  consider(dark, 'ring');
  out.sort((a, b) => b.area - a.area);
  // A seed of about a sheet's size swallows the seeds inside it: a paper
  // swallows its window and its frame ring, a ring on a white desk swallows
  // its window. A seed many times larger, the desk and everything on it,
  // swallows nothing. On a dark desk the paper itself is a bright ring (the
  // margin outside the frame), which is why bright seeds are not held to a
  // fill either.
  const inside = (p, q) => {
    let c = false;
    for (let i = 0, j = 3; i < 4; j = i++) {
      const a = q[i], b = q[j];
      if ((a.y > p.y) !== (b.y > p.y) && p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x) c = !c;
    }
    return c;
  };
  const kept = [];
  for (const r of out) {
    const owner = kept.find(k => k.area <= r.area * 2.5 && inside(r.centre, k.corners));
    if (owner) continue;
    kept.push(r);
    if (kept.length >= o.maxRegions) break;
  }
  return kept;
}
