// Back-photo ("underside") support: rectify the photo of the flipped
// object, mirror it, and register it onto the front trace so it can serve
// as a workspace underlay and a Suggest-regions source for underside
// recesses. Two flat silhouettes carry no depth — registration answers
// WHERE the underside features sit, never how deep (that stays manual).

import { computeDiffMap, otsuThreshold, segmentObject } from './segment.js';
import {
  traceBoundaries, signedArea, collapseCollinear, resampleClosed,
} from './contour.js';

// Largest silhouette loop of a rectified canvas, in canvas px.
export function silhouetteOf(canvas, paperRect) {
  const diffMap = computeDiffMap(canvas, paperRect ? { paperRect } : {});
  const thr = otsuThreshold(diffMap.diff);
  const mask = segmentObject(diffMap, { threshold: thr, cleanupRadius: 2, marginPx: 4 });
  if (!mask) return null;
  const loops = traceBoundaries(mask, diffMap.w, diffMap.h);
  if (!loops.length) return null;
  loops.sort((a, b) => Math.abs(signedArea(b)) - Math.abs(signedArea(a)));
  const loop = collapseCollinear(loops[0]);
  return loop.length >= 3 ? loop : null;
}

const centroidOf = pts => {
  let x = 0, y = 0;
  for (const p of pts) { x += p.x; y += p.y; }
  return { x: x / pts.length, y: y / pts.length };
};

// Mean nearest-vertex distance from `pts` to ring `ref` (both dense).
function meanDist(pts, ref) {
  let sum = 0;
  for (const p of pts) {
    let best = Infinity;
    for (const q of ref) {
      const d = (p.x - q.x) ** 2 + (p.y - q.y) ** 2;
      if (d < best) best = d;
    }
    sum += Math.sqrt(best);
  }
  return sum / pts.length;
}

// Register the back silhouette onto the front outline. Both in the same
// px scale (caller matches pxPerMm via `scale`). The back photo shows the
// flipped object, so a mirror is always applied (x → backW − x), then a
// rotation about the mirrored silhouette's centroid and a translation onto
// the front centroid. Returns { rot (rad), cB, cF, score (px) }.
export function registerBack(frontOutline, backSilhouette, backW, scale = 1) {
  const mirrored = backSilhouette.map(p => ({ x: (backW - p.x) * scale, y: p.y * scale }));
  const cB = centroidOf(mirrored);
  const cF = centroidOf(frontOutline);
  const B = resampleClosed(mirrored, 160).map(p => ({ x: p.x - cB.x, y: p.y - cB.y }));
  const F = resampleClosed(frontOutline, 320).map(p => ({ x: p.x - cF.x, y: p.y - cF.y }));

  const scoreAt = rot => {
    const cos = Math.cos(rot), sin = Math.sin(rot);
    return meanDist(B.map(p => ({ x: p.x * cos - p.y * sin, y: p.x * sin + p.y * cos })), F);
  };
  let best = { rot: 0, score: Infinity };
  for (let deg = 0; deg < 360; deg += 4) {
    const s = scoreAt((deg * Math.PI) / 180);
    if (s < best.score) best = { rot: (deg * Math.PI) / 180, score: s };
  }
  for (let d = -4; d <= 4; d += 0.5) {
    const rot = best.rot + (d * Math.PI) / 180;
    const s = scoreAt(rot);
    if (s < best.score) best = { rot, score: s };
  }
  return { rot: best.rot, cB, cF, score: best.score };
}

// Render the back canvas into front-rect space with the registration
// applied: world = T(cF) · R(rot) · T(−cB) · S(scale) · MirrorX(backW).
export function renderRegistered(backCanvas, frontW, frontH, align) {
  const { rot, cB, cF, scale = 1 } = align;
  const c = document.createElement('canvas');
  c.width = frontW; c.height = frontH;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#888';
  ctx.fillRect(0, 0, frontW, frontH);
  const cos = Math.cos(rot), sin = Math.sin(rot);
  // Compose: p_px(back) → mirror+scale → m = (s·(W−x), s·y) → rotate about
  // cB → translate to cF. As a single affine (column-vector convention):
  //   x' = cos·(m.x − cB.x) − sin·(m.y − cB.y) + cF.x
  //   y' = sin·(m.x − cB.x) + cos·(m.y − cB.y) + cF.y
  // with m.x = −s·x + s·W, m.y = s·y:
  const a = -cos * scale;            // ∂x'/∂x
  const b = -sin * scale;            // ∂y'/∂x
  const cc = -sin * scale;           // ∂x'/∂y
  const dd = cos * scale;            // ∂y'/∂y
  const W = backCanvas.width;
  const e = cos * (scale * W - cB.x) + sin * cB.y + cF.x;
  const f = sin * (scale * W - cB.x) - cos * cB.y + cF.y;
  ctx.setTransform(a, b, cc, dd, e, f);
  ctx.drawImage(backCanvas, 0, 0);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  return c;
}
