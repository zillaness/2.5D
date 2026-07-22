// Copyright (C) 2026 Projects and Mods
// GPL-3.0-or-later WITH Commons Clause (non-commercial) - see LICENSE.

// Object segmentation on the rectified (top-down) paper image.
//
// The paper's colour is estimated robustly from the border band of the
// rectified image; every pixel is scored by its colour distance from paper.
// Thresholding that difference finds the object whether it is darker,
// lighter-but-tinted, or coloured. Morphological open/close cleans noise.

export function computeDiffMap(canvas, borderPct = 0.04) {
  const w = canvas.width, h = canvas.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const { data } = ctx.getImageData(0, 0, w, h);

  // Paper colour: per-channel median over a border band (robust to an object
  // that overhangs one edge and to shadows in a corner).
  const band = Math.max(2, Math.round(Math.min(w, h) * borderPct));
  const rs = [], gs = [], bs = [];
  const pushPx = (x, y) => {
    const p = (y * w + x) * 4;
    rs.push(data[p]); gs.push(data[p + 1]); bs.push(data[p + 2]);
  };
  const step = 2;
  for (let y = 0; y < h; y += step) {
    for (let x = 0; x < w; x += step) {
      if (x < band || x >= w - band || y < band || y >= h - band) pushPx(x, y);
    }
  }
  const median = arr => { arr.sort((a, b) => a - b); return arr[arr.length >> 1] || 255; };
  const pr = median(rs), pg = median(gs), pb = median(bs);

  // Difference from paper colour, weighted so brightness changes (shadows)
  // count less than chroma changes.
  const diff = new Uint8ClampedArray(w * h);
  for (let i = 0, p = 0; i < w * h; i++, p += 4) {
    const dr = data[p] - pr, dg = data[p + 1] - pg, db = data[p + 2] - pb;
    const dl = (dr + dg + db) / 3;                       // luma shift
    const dcr = dr - dl, dcg = dg - dl, dcb = db - dl;   // chroma shift
    const chroma = Math.sqrt(dcr * dcr + dcg * dcg + dcb * dcb);
    diff[i] = Math.min(255, Math.abs(dl) * 0.7 + chroma * 1.6);
  }
  return { diff, w, h, paperColor: [pr, pg, pb] };
}

export function otsuThreshold(diff) {
  const hist = new Uint32Array(256);
  for (let i = 0; i < diff.length; i++) hist[diff[i]]++;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0, wB = 0, best = 0, thresh = 60;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (wB === 0) continue;
    const wF = diff.length - wB;
    if (wF === 0) break;
    sumB += t * hist[t];
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best) { best = between; thresh = t; }
  }
  return thresh;
}

function dilate(mask, w, h, r) {
  if (r <= 0) return mask;
  // Two-pass (horizontal then vertical) box dilation.
  const tmp = new Uint8Array(w * h);
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let v = 0;
      for (let k = Math.max(0, x - r); k <= Math.min(w - 1, x + r); k++) {
        if (mask[row + k]) { v = 1; break; }
      }
      tmp[row + x] = v;
    }
  }
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      let v = 0;
      for (let k = Math.max(0, y - r); k <= Math.min(h - 1, y + r); k++) {
        if (tmp[k * w + x]) { v = 1; break; }
      }
      out[y * w + x] = v;
    }
  }
  return out;
}

function erode(mask, w, h, r) {
  if (r <= 0) return mask;
  const inv = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) inv[i] = mask[i] ? 0 : 1;
  const d = dilate(inv, w, h, r);
  const out = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) out[i] = d[i] ? 0 : 1;
  return out;
}

export function morphClean(mask, w, h, r) {
  if (r <= 0) return mask;
  // Closing (bridge small gaps) then opening (drop specks).
  let m = erode(dilate(mask, w, h, r), w, h, r);
  m = dilate(erode(m, w, h, r), w, h, r);
  return m;
}

// Label 4-connected components; returns { labels, sizes } where labels is
// Int32Array (-1 = background) and sizes[label] = pixel count.
export function labelComponents(mask, w, h) {
  const labels = new Int32Array(w * h).fill(-1);
  const sizes = [];
  const stack = [];
  let label = 0;
  for (let start = 0; start < w * h; start++) {
    if (!mask[start] || labels[start] !== -1) continue;
    let count = 0;
    stack.length = 0;
    stack.push(start);
    labels[start] = label;
    while (stack.length) {
      const idx = stack.pop();
      count++;
      const x = idx % w, y = (idx / w) | 0;
      if (x > 0 && mask[idx - 1] && labels[idx - 1] === -1) { labels[idx - 1] = label; stack.push(idx - 1); }
      if (x < w - 1 && mask[idx + 1] && labels[idx + 1] === -1) { labels[idx + 1] = label; stack.push(idx + 1); }
      if (y > 0 && mask[idx - w] && labels[idx - w] === -1) { labels[idx - w] = label; stack.push(idx - w); }
      if (y < h - 1 && mask[idx + w] && labels[idx + w] === -1) { labels[idx + w] = label; stack.push(idx + w); }
    }
    sizes.push(count);
    label++;
  }
  return { labels, sizes };
}

// Full segmentation: returns the mask of the largest object component
// (holes NOT filled — traceBoundaries finds them as inner loops).
//
// options: { threshold, cleanupRadius, marginPx }
// marginPx ignores a border strip (paper edge shadows / clipped corners).
export function segmentObject(diffMap, options) {
  const { diff, w, h } = diffMap;
  const { threshold, cleanupRadius = 2, marginPx = 6 } = options;

  let mask = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) mask[i] = diff[i] >= threshold ? 1 : 0;

  // Clear the margin band.
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x < marginPx || y < marginPx || x >= w - marginPx || y >= h - marginPx) {
        mask[y * w + x] = 0;
      }
    }
  }

  mask = morphClean(mask, w, h, cleanupRadius);

  const { labels, sizes } = labelComponents(mask, w, h);
  if (!sizes.length) return null;
  let best = 0;
  for (let i = 1; i < sizes.length; i++) if (sizes[i] > sizes[best]) best = i;
  if (sizes[best] < 25) return null;

  const objMask = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) objMask[i] = labels[i] === best ? 1 : 0;
  return objMask;
}
