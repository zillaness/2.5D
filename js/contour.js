// Copyright (C) 2026 Projects and Mods
// GPL-3.0-or-later WITH Commons Clause (non-commercial) - see LICENSE.

// Mask -> polygon conversion and polyline utilities.
//
// Boundary extraction walks directed pixel-edge segments (object kept on a
// consistent side), which yields exact closed loops for the outer outline and
// every hole in one pass, with no 8-connectivity ambiguity.

// Extract all closed boundary loops of a binary mask (1 = object).
// Returns arrays of {x, y} lattice points (pixel-corner coordinates).
export function traceBoundaries(mask, w, h) {
  // Directed edges around object pixels, object on the left of travel:
  //   background above    -> edge (x, y)     -> (x+1, y)
  //   background right    -> edge (x+1, y)   -> (x+1, y+1)
  //   background below    -> edge (x+1, y+1) -> (x, y+1)
  //   background left     -> edge (x, y+1)   -> (x, y)
  const at = (x, y) => (x < 0 || y < 0 || x >= w || y >= h) ? 0 : mask[y * w + x];
  const key = (x, y) => y * (w + 1) + x;
  const edgesByStart = new Map(); // startKey -> array of [endX, endY]

  const addEdge = (sx, sy, ex, ey) => {
    const k = key(sx, sy);
    let arr = edgesByStart.get(k);
    if (!arr) { arr = []; edgesByStart.set(k, arr); }
    arr.push([ex, ey]);
  };

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!mask[y * w + x]) continue;
      if (!at(x, y - 1)) addEdge(x, y, x + 1, y);
      if (!at(x + 1, y)) addEdge(x + 1, y, x + 1, y + 1);
      if (!at(x, y + 1)) addEdge(x + 1, y + 1, x, y + 1);
      if (!at(x - 1, y)) addEdge(x, y + 1, x, y);
    }
  }

  const loops = [];
  for (const [startKey, startEdges] of edgesByStart) {
    while (startEdges.length) {
      const sx = startKey % (w + 1), sy = (startKey / (w + 1)) | 0;
      let [cx, cy] = startEdges.pop();
      let px = sx, py = sy;
      const loop = [{ x: sx, y: sy }];
      while (cx !== sx || cy !== sy) {
        loop.push({ x: cx, y: cy });
        const outgoing = edgesByStart.get(key(cx, cy));
        if (!outgoing || !outgoing.length) { loop.length = 0; break; } // defensive
        let pick = 0;
        if (outgoing.length > 1) {
          // Checkerboard corner: prefer the sharpest left turn so separate
          // regions that touch diagonally stay separate loops.
          const inx = cx - px, iny = cy - py;
          let bestTurn = -Infinity;
          for (let i = 0; i < outgoing.length; i++) {
            const ox = outgoing[i][0] - cx, oy = outgoing[i][1] - cy;
            const turn = inx * oy - iny * ox; // cross product (y-down: >0 = right)
            if (-turn > bestTurn) { bestTurn = -turn; pick = i; }
          }
        }
        const [nx, ny] = outgoing.splice(pick, 1)[0];
        px = cx; py = cy;
        cx = nx; cy = ny;
      }
      if (loop.length >= 4) loops.push(loop);
    }
  }
  // Drop emptied entries so outer iteration stays clean.
  return loops;
}

export function signedArea(pts) {
  let a = 0;
  for (let i = 0, n = pts.length; i < n; i++) {
    const p = pts[i], q = pts[(i + 1) % n];
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}

// Remove collinear runs (staircase pixels) — cheap pre-pass before RDP.
export function collapseCollinear(pts) {
  const n = pts.length;
  if (n < 3) return pts;
  const out = [];
  for (let i = 0; i < n; i++) {
    const a = pts[(i + n - 1) % n], b = pts[i], c = pts[(i + 1) % n];
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (cross !== 0) out.push(b);
  }
  return out.length >= 3 ? out : pts;
}

// Ramer–Douglas–Peucker on a closed loop. eps in the same units as points.
export function simplifyClosed(pts, eps) {
  if (eps <= 0 || pts.length < 5) return pts;
  // Split at the two most distant points so RDP anchors are stable.
  let iA = 0, iB = 0, best = -1;
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const j = (i + (n >> 1)) % n;
    const d = (pts[i].x - pts[j].x) ** 2 + (pts[i].y - pts[j].y) ** 2;
    if (d > best) { best = d; iA = i; iB = j; }
  }
  if (iA > iB) [iA, iB] = [iB, iA];
  const seg1 = pts.slice(iA, iB + 1);
  const seg2 = pts.slice(iB).concat(pts.slice(0, iA + 1));
  const r1 = rdpOpen(seg1, eps);
  const r2 = rdpOpen(seg2, eps);
  const merged = r1.slice(0, -1).concat(r2.slice(0, -1));
  return merged.length >= 3 ? merged : pts;
}

function rdpOpen(points, eps) {
  if (points.length < 3) return points;
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [s, e] = stack.pop();
    const a = points[s], b = points[e];
    const dx = b.x - a.x, dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1e-9;
    let maxD = 0, maxI = -1;
    for (let i = s + 1; i < e; i++) {
      const p = points[i];
      const d = Math.abs(dx * (a.y - p.y) - (a.x - p.x) * dy) / len;
      if (d > maxD) { maxD = d; maxI = i; }
    }
    if (maxD > eps) {
      keep[maxI] = 1;
      stack.push([s, maxI], [maxI, e]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

// Chaikin corner cutting on a closed loop (each iteration doubles vertices).
export function chaikinClosed(pts, iterations) {
  let cur = pts;
  for (let it = 0; it < iterations; it++) {
    const next = [];
    const n = cur.length;
    for (let i = 0; i < n; i++) {
      const p = cur[i], q = cur[(i + 1) % n];
      next.push({ x: p.x * 0.75 + q.x * 0.25, y: p.y * 0.75 + q.y * 0.25 });
      next.push({ x: p.x * 0.25 + q.x * 0.75, y: p.y * 0.25 + q.y * 0.75 });
    }
    cur = next;
  }
  return cur;
}

export function polygonPerimeter(pts) {
  let len = 0;
  for (let i = 0, n = pts.length; i < n; i++) {
    const p = pts[i], q = pts[(i + 1) % n];
    len += Math.hypot(q.x - p.x, q.y - p.y);
  }
  return len;
}

// Resample a closed loop to exactly n points, uniformly by arc length,
// starting at the vertex nearest to `alignTo` (or vertex 0).
export function resampleClosed(pts, n, alignTo = null) {
  const m = pts.length;
  let start = 0;
  if (alignTo) {
    let best = Infinity;
    for (let i = 0; i < m; i++) {
      const d = (pts[i].x - alignTo.x) ** 2 + (pts[i].y - alignTo.y) ** 2;
      if (d < best) { best = d; start = i; }
    }
  }
  const ordered = pts.slice(start).concat(pts.slice(0, start));
  const per = polygonPerimeter(ordered);
  if (per <= 0) return ordered.slice(0, n);
  const out = [];
  const step = per / n;
  let target = 0, acc = 0, i = 0;
  let a = ordered[0], b = ordered[1 % m];
  let segLen = Math.hypot(b.x - a.x, b.y - a.y);
  for (let k = 0; k < n; k++) {
    target = k * step;
    while (acc + segLen < target && i < m) {
      acc += segLen;
      i++;
      a = ordered[i % m];
      b = ordered[(i + 1) % m];
      segLen = Math.hypot(b.x - a.x, b.y - a.y);
    }
    const t = segLen > 0 ? (target - acc) / segLen : 0;
    out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
  }
  return out;
}

// Least-squares circle fit (Kåsa method): x² + y² = Ax + By + C.
// Returns { cx, cy, r, rms } — rms is the radial fit error.
export function fitCircle(pts) {
  let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0, sxz = 0, syz = 0, sz = 0;
  const n = pts.length;
  if (n < 3) return null;
  for (const p of pts) {
    const z = p.x * p.x + p.y * p.y;
    sx += p.x; sy += p.y;
    sxx += p.x * p.x; syy += p.y * p.y; sxy += p.x * p.y;
    sxz += p.x * z; syz += p.y * z; sz += z;
  }
  // Normal equations: [sxx sxy sx; sxy syy sy; sx sy n] · [A B C]ᵀ = [sxz syz sz]
  const M = [
    [sxx, sxy, sx, sxz],
    [sxy, syy, sy, syz],
    [sx, sy, n, sz],
  ];
  for (let col = 0; col < 3; col++) {
    let piv = col;
    for (let r = col + 1; r < 3; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    if (Math.abs(M[piv][col]) < 1e-12) return null;
    if (piv !== col) [M[col], M[piv]] = [M[piv], M[col]];
    for (let r = 0; r < 3; r++) {
      if (r === col) continue;
      const f = M[r][col] / M[col][col];
      for (let c = col; c < 4; c++) M[r][c] -= f * M[col][c];
    }
  }
  const A = M[0][3] / M[0][0], B = M[1][3] / M[1][1], C = M[2][3] / M[2][2];
  const cx = A / 2, cy = B / 2;
  const r2 = C + cx * cx + cy * cy;
  if (r2 <= 0) return null;
  const r = Math.sqrt(r2);
  let err = 0;
  for (const p of pts) {
    const d = Math.hypot(p.x - cx, p.y - cy) - r;
    err += d * d;
  }
  return { cx, cy, r, rms: Math.sqrt(err / n) };
}

// Point-in-polygon (ray casting).
export function pointInPolygon(pt, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const pi = poly[i], pj = poly[j];
    if ((pi.y > pt.y) !== (pj.y > pt.y) &&
        pt.x < (pj.x - pi.x) * (pt.y - pi.y) / (pj.y - pi.y) + pi.x) {
      inside = !inside;
    }
  }
  return inside;
}
