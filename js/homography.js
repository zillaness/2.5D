// Planar homography from 4 point correspondences (DLT) and image rectification.
//
// The paper defines a world plane with known physical size. Mapping the four
// photographed corners onto the paper rectangle removes perspective and skew,
// and gives every rectified pixel a real size in millimetres. Optional radial
// lens-distortion correction straightens lens-bowed edges (see lens.js).

import { lensParams, distortPixel, undistortPixel } from './lens.js';

// Solve A x = b for an 8x8 system with partial-pivot Gaussian elimination.
function solve8(A, b) {
  const n = 8;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    }
    if (Math.abs(M[piv][col]) < 1e-12) return null; // degenerate corner layout
    if (piv !== col) [M[col], M[piv]] = [M[piv], M[col]];
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = M[r][col] / M[col][col];
      if (f === 0) continue;
      for (let c = col; c <= n; c++) M[r][c] -= f * M[col][c];
    }
  }
  const x = new Array(n);
  for (let i = 0; i < n; i++) x[i] = M[i][n] / M[i][i];
  return x;
}

// Homography H (3x3, row-major, h22 = 1) with dst = H * src for 4 point pairs.
export function computeHomography(src, dst) {
  const A = [];
  const b = [];
  for (let i = 0; i < 4; i++) {
    const { x, y } = src[i];
    const { x: u, y: v } = dst[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v);
  }
  const h = solve8(A, b);
  if (!h) return null;
  return [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
}

export function applyHomography(H, x, y) {
  const w = H[6] * x + H[7] * y + H[8];
  return {
    x: (H[0] * x + H[1] * y + H[2]) / w,
    y: (H[3] * x + H[4] * y + H[5]) / w,
  };
}

// Render the perspective-corrected paper into a new canvas.
//
// corners: 4 source-image pixel positions ordered TL, TR, BR, BL matching the
// paper's (0,0), (W,0), (W,H), (0,H) in millimetres.
// opts.k1/opts.k2: radial lens-distortion coefficients (Brown model). When set,
// the clicked corners are undistorted before building the homography and each
// output pixel is re-distorted before sampling, so lens-bowed edges come out
// straight. Returns { canvas, pxPerMm }.
export function rectify(image, corners, paperWmm, paperHmm, opts = {}) {
  const { maxLongSidePx = 1600, k1 = 0, k2 = 0 } = opts;
  const pxPerMm = Math.min(maxLongSidePx / Math.max(paperWmm, paperHmm), 8);
  const outW = Math.round(paperWmm * pxPerMm);
  const outH = Math.round(paperHmm * pxPerMm);

  const iw = image.naturalWidth || image.width, ih = image.naturalHeight || image.height;
  const lp = lensParams(iw, ih);
  const distort = (k1 || k2);
  // Straighten the clicked corners so the homography maps to undistorted space.
  const corr = distort ? corners.map(c => undistortPixel(c, k1, k2, lp)) : corners;

  // Map rectified pixels -> (undistorted) source pixels.
  const dstQuad = [
    { x: 0, y: 0 }, { x: outW, y: 0 }, { x: outW, y: outH }, { x: 0, y: outH },
  ];
  const H = computeHomography(dstQuad, corr);
  if (!H) return null;

  const srcCanvas = document.createElement('canvas');
  srcCanvas.width = image.naturalWidth || image.width;
  srcCanvas.height = image.naturalHeight || image.height;
  const sctx = srcCanvas.getContext('2d', { willReadFrequently: true });
  sctx.drawImage(image, 0, 0);
  const srcData = sctx.getImageData(0, 0, srcCanvas.width, srcCanvas.height);
  const sw = srcData.width, sh = srcData.height, sp = srcData.data;

  const outCanvas = document.createElement('canvas');
  outCanvas.width = outW;
  outCanvas.height = outH;
  const octx = outCanvas.getContext('2d');
  const outData = octx.createImageData(outW, outH);
  const op = outData.data;

  for (let v = 0; v < outH; v++) {
    for (let u = 0; u < outW; u++) {
      const d = H[6] * u + H[7] * v + H[8];
      let sx = (H[0] * u + H[1] * v + H[2]) / d;
      let sy = (H[3] * u + H[4] * v + H[5]) / d;
      if (distort) { const p = distortPixel({ x: sx, y: sy }, k1, k2, lp); sx = p.x; sy = p.y; }
      const o = (v * outW + u) * 4;
      if (sx < 0 || sy < 0 || sx > sw - 1 || sy > sh - 1) {
        op[o] = op[o + 1] = op[o + 2] = 0; op[o + 3] = 255;
        continue;
      }
      // Bilinear sample
      const x0 = Math.floor(sx), y0 = Math.floor(sy);
      const x1 = Math.min(x0 + 1, sw - 1), y1 = Math.min(y0 + 1, sh - 1);
      const fx = sx - x0, fy = sy - y0;
      const i00 = (y0 * sw + x0) * 4, i10 = (y0 * sw + x1) * 4;
      const i01 = (y1 * sw + x0) * 4, i11 = (y1 * sw + x1) * 4;
      for (let c = 0; c < 3; c++) {
        const top = sp[i00 + c] * (1 - fx) + sp[i10 + c] * fx;
        const bot = sp[i01 + c] * (1 - fx) + sp[i11 + c] * fx;
        op[o + c] = top * (1 - fy) + bot * fy;
      }
      op[o + 3] = 255;
    }
  }
  octx.putImageData(outData, 0, 0);
  return { canvas: outCanvas, pxPerMm };
}
