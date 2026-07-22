// Turn a short label into 2D polygon loops for embossing/debossing — entirely
// in the browser, no bundled fonts (uses the platform's own font via Canvas).
// The text is rasterised, then its ink boundary is traced with marching squares
// into closed loops; letter counters (O, A, 8 …) come out as separate loops, so
// the caller resolves them with an even-odd / union rule. Ported from the
// key-from-photo project (same GPL-3.0-or-later WITH Commons Clause licence).

// Marching-squares isocontour of a binary grid → array of closed loops (px).
function marchingSquares(grid, w, h) {
  const val = (x, y) => (x < 0 || y < 0 || x >= w || y >= h) ? 0 : grid[y * w + x];
  const key = p => `${p[0].toFixed(1)},${p[1].toFixed(1)}`;
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
  const used = new Set();
  const loops = [];
  for (let i = 0; i < segs.length; i++) {
    if (used.has(i)) continue;
    const loop = [segs[i][0]]; let cur = segs[i][1]; used.add(i);
    let guard = 0;
    while (guard++ < segs.length + 2) {
      loop.push(cur);
      let nextIdx = -1;
      for (let j = 0; j < segs.length; j++) { if (!used.has(j) && key(segs[j][0]) === key(cur)) { nextIdx = j; break; } }
      if (nextIdx < 0) break;
      used.add(nextIdx); cur = segs[nextIdx][1];
      if (key(cur) === key(loop[0])) break;
    }
    if (loop.length >= 4) loops.push(loop);
  }
  return loops;
}

// Drop near-collinear points to thin the blocky marching-squares boundary.
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
// (w,h). opts.px = raster cap height (resolution); opts.font = CSS font family.
export function textToLoops(text, opts = {}) {
  const s = String(text || '').trim();
  if (!s) return { loops: [], w: 0, h: 0 };
  const px = opts.px || 120;
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
  for (let i = 0; i < W * H; i++) grid[i] = data[i * 4] > 128 ? 1 : 0;
  let loops = marchingSquares(grid, W, H).map(l => simplify(l));
  if (!loops.length) return { loops: [], w: 0, h: 0 };
  let minx = W, miny = H, maxx = 0, maxy = 0;
  for (const l of loops) for (const p of l) { if (p[0] < minx) minx = p[0]; if (p[0] > maxx) maxx = p[0]; if (p[1] < miny) miny = p[1]; if (p[1] > maxy) maxy = p[1]; }
  loops = loops.map(l => l.map(([x, y]) => [x - minx, y - miny]));
  return { loops, w: maxx - minx, h: maxy - miny };
}

// Place a label as mm polygon loops [{x,y}] centred at (cx,cy), fit to a target
// cap height `heightMm` (width follows the text), optionally rotated in 90°
// steps. The px box is y-DOWN; we flip Y so the text reads upright in the trace
// plane (which is also y-DOWN, image space — so no flip needed there; we keep the
// glyphs' own orientation). Returns [] for empty/blank text.
export function labelLoops(text, cx, cy, heightMm, opts = {}) {
  const t = textToLoops(text, opts);
  if (!t.loops.length) return [];
  const rot = (((opts.rot || 0) % 360) + 360) % 360;
  const rp = ([x, y]) => rot === 90 ? [y, -x] : rot === 180 ? [-x, -y] : rot === 270 ? [-y, x] : [x, y];
  let loops = t.loops.map(l => l.map(rp));
  let mnx = Infinity, mny = Infinity, mxx = -Infinity, mxy = -Infinity;
  for (const l of loops) for (const p of l) { if (p[0] < mnx) mnx = p[0]; if (p[0] > mxx) mxx = p[0]; if (p[1] < mny) mny = p[1]; if (p[1] > mxy) mxy = p[1]; }
  const bw = mxx - mnx, bh = mxy - mny || 1;
  const sc = heightMm / bh;                 // scale so the cap height == heightMm
  const wMm = bw * sc;
  const ox = cx - wMm / 2, oy = cy - heightMm / 2;
  const mirror = opts.mirror ? -1 : 1;
  return loops.map(l => l.map(([x, y]) => ({
    x: ox + (mirror < 0 ? (wMm - (x - mnx) * sc) : (x - mnx) * sc),
    y: oy + (y - mny) * sc,
  })));
}
