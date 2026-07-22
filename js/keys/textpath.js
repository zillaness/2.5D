// Copyright (C) 2026 Projects and Mods
// GPL-3.0-or-later WITH Commons Clause (non-commercial) - see LICENSE.

// Turn a short label into 2D polygon loops for debossing on the bow — entirely in
// the browser, no external fonts (uses the platform's own font via Canvas). We
// rasterise the text, then trace the black/white boundary with marching squares
// into closed loops. Letter holes (O, A, 8 …) come out as separate loops; the
// caller fills them with an EvenOdd rule so the holes stay open. Returns loops in
// a y-DOWN pixel box plus its size, for the caller to scale/place/flip.

// Marching-squares isocontour of a binary grid → array of closed loops (px).
// EvenOdd downstream, so loop winding/orientation does not matter here.
function marchingSquares(grid, w, h) {
  const val = (x, y) => (x < 0 || y < 0 || x >= w || y >= h) ? 0 : grid[y * w + x];
  const key = (p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`;
  const segs = [];
  for (let y = -1; y < h; y++) {
    for (let x = -1; x < w; x++) {
      const tl = val(x, y), tr = val(x + 1, y), br = val(x + 1, y + 1), bl = val(x, y + 1);
      const c = (tl ? 1 : 0) | (tr ? 2 : 0) | (br ? 4 : 0) | (bl ? 8 : 0);
      if (c === 0 || c === 15) continue;
      const T = [x + 0.5, y], R = [x + 1, y + 0.5], B = [x + 0.5, y + 1], L = [x, y + 0.5];
      const add = (a, b) => segs.push([a, b]);
      switch (c) {
        case 1: add(L, T); break; case 2: add(T, R); break; case 3: add(L, R); break;
        case 4: add(R, B); break; case 5: add(L, T); add(R, B); break; case 6: add(T, B); break;
        case 7: add(L, B); break; case 8: add(B, L); break; case 9: add(B, T); break;
        case 10: add(T, R); add(B, L); break; case 11: add(B, R); break; case 12: add(R, L); break;
        case 13: add(R, T); break; case 14: add(T, L); break;
      }
    }
  }
  // Link segments into closed loops by matching endpoints.
  const starts = new Map();
  for (const s of segs) { const k = key(s[0]); (starts.get(k) || starts.set(k, []).get(k)).push(s); }
  const used = new Set();
  const loops = [];
  for (let i = 0; i < segs.length; i++) {
    if (used.has(i)) continue;
    const loop = [segs[i][0]]; let cur = segs[i][1]; used.add(i);
    let guard = 0;
    while (guard++ < segs.length + 2) {
      loop.push(cur);
      const cand = starts.get(key(cur)) || [];
      let nextSeg = null, nextIdx = -1;
      for (let j = 0; j < segs.length; j++) { if (!used.has(j) && key(segs[j][0]) === key(cur)) { nextSeg = segs[j]; nextIdx = j; break; } }
      if (!nextSeg) break;
      used.add(nextIdx); cur = nextSeg[1];
      if (key(cur) === key(loop[0])) break;              // closed
    }
    if (loop.length >= 4) loops.push(loop);
  }
  return loops;
}

// Drop points that are (near-)collinear with their neighbours, then decimate.
function simplify(loop, tol = 0.6) {
  const cross = (a, b, c) => Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]));
  const keep = [];
  const n = loop.length;
  for (let i = 0; i < n; i++) {
    const a = keep.length ? keep[keep.length - 1] : loop[(i - 1 + n) % n];
    const b = loop[i], c = loop[(i + 1) % n];
    if (cross(a, b, c) > tol) keep.push(b);
  }
  return keep.length >= 3 ? keep : loop;
}

// Rasterise `text` and return { loops, w, h } — loops in a y-DOWN px box of size
// (w,h). font is the CSS font family; the caller scales the box onto the bow.
export function textToLoops(text, opts = {}) {
  const s = String(text || '').trim();
  if (!s) return { loops: [], w: 0, h: 0 };
  const px = opts.px || 96;                              // raster cap height (resolution)
  const family = opts.font || 'bold sans-serif';
  const pad = Math.ceil(px * 0.25);
  const c = document.createElement('canvas');
  const g = c.getContext('2d', { willReadFrequently: true });
  g.font = `${px}px ${family}`;
  const m = g.measureText(s);
  const tw = Math.ceil(m.width);
  const asc = Math.ceil(m.actualBoundingBoxAscent || px * 0.72);
  const desc = Math.ceil(m.actualBoundingBoxDescent || px * 0.2);
  const W = tw + pad * 2, H = asc + desc + pad * 2;
  c.width = W; c.height = H;
  g.fillStyle = '#000'; g.fillRect(0, 0, W, H);
  g.font = `${px}px ${family}`;
  g.fillStyle = '#fff'; g.textBaseline = 'alphabetic';
  g.fillText(s, pad, pad + asc);
  const data = g.getImageData(0, 0, W, H).data;
  const grid = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) grid[i] = data[i * 4] > 128 ? 1 : 0;   // white = ink
  let loops = marchingSquares(grid, W, H).map(l => simplify(l));
  // Trim to the ink bounding box so placement uses the glyphs, not the padding.
  let minx = W, miny = H, maxx = 0, maxy = 0;
  for (const l of loops) for (const p of l) { if (p[0] < minx) minx = p[0]; if (p[0] > maxx) maxx = p[0]; if (p[1] < miny) miny = p[1]; if (p[1] > maxy) maxy = p[1]; }
  if (!loops.length) return { loops: [], w: 0, h: 0 };
  loops = loops.map(l => l.map(([x, y]) => [x - minx, y - miny]));
  return { loops, w: maxx - minx, h: maxy - miny };
}

// Place text loops (y-DOWN px box) onto the bow's (x,h) plane, fit inside the
// target box {x0,x1,z0,z1} (mm) preserving aspect, centred, with a y-flip so text
// reads upright. opts.rot ∈ {0,90,180,270} rotates the label (90/270 run it along
// the blade axis — tip-up / tip-down). Returns (x,h) loops for opts.debossLoops.
export function placeLoopsInBox(text, box, opts = {}) {
  const t = textToLoops(text, opts);
  if (!t.loops.length) return [];
  // Rotate the glyphs in px space, then re-normalise to origin.
  const rot = (((opts.rot || 0) % 360) + 360) % 360;
  const rp = ([x, y]) => rot === 90 ? [y, -x] : rot === 180 ? [-x, -y] : rot === 270 ? [-y, x] : [x, y];
  let loops = t.loops.map(l => l.map(rp));
  let mnx = Infinity, mny = Infinity, mxx = -Infinity, mxy = -Infinity;
  for (const l of loops) for (const p of l) { if (p[0] < mnx) mnx = p[0]; if (p[0] > mxx) mxx = p[0]; if (p[1] < mny) mny = p[1]; if (p[1] > mxy) mxy = p[1]; }
  const tw = mxx - mnx, th = mxy - mny;
  const bw = box.x1 - box.x0, bh = box.z1 - box.z0;
  let sc = Math.min(bw / tw, bh / th) * (opts.fill || 0.9);
  // Cap the character height (t.h is the unrotated ink height) so a short label —
  // a single letter especially — engraves at a sane size instead of ballooning to
  // fill the whole head.
  if (opts.maxMm && t.h > 0) sc = Math.min(sc, opts.maxMm / t.h);
  const ox = box.x0 + (bw - tw * sc) / 2, oz = box.z0 + (bh - th * sc) / 2;
  // px→mm with a y-flip (canvas y-down → h up).
  return loops.map(l => l.map(([px, py]) => [ox + (px - mnx) * sc, oz + (th - (py - mny)) * sc]));
}
