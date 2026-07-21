// PDF → flattened polylines + positioned text, via pdf.js (global `pdfjsLib`,
// loaded as a plain script like clipper). Geometry comes from each page's
// operator list (path-construction ops with the current transform applied);
// text comes from getTextContent. Both are returned in device coordinates
// (points, y-down, origin top-left) via the page viewport transform, so
// geometry and dimension text share one coordinate space.
//
// Vector PDFs only here (a page's operator list). Scanned/image PDFs have no
// vector paths and are handled later by the OCR path.

import { assembleViews } from './loops.js';

const PT_TO_MM = 25.4 / 72;
const CURVE_STEPS = 16;

// pdf.js path-construction sub-op codes (probed from OPS; stable in v3).
const MOVE = 13, LINE = 14, CURVE = 15, CURVE2 = 16, CURVE3 = 17, CLOSE = 18, RECT = 19;

function mat(a, b) { // compose 6-vector affine a∘b (apply b then a)
  return [
    a[0]*b[0]+a[2]*b[1], a[1]*b[0]+a[3]*b[1],
    a[0]*b[2]+a[2]*b[3], a[1]*b[2]+a[3]*b[3],
    a[0]*b[4]+a[2]*b[5]+a[4], a[1]*b[4]+a[3]*b[5]+a[5],
  ];
}
function apply(m, x, y) { return { x: m[0]*x + m[2]*y + m[4], y: m[1]*x + m[3]*y + m[5] }; }

function cubic(p0, c1, c2, p1, out) {
  for (let i = 1; i <= CURVE_STEPS; i++) {
    const t = i / CURVE_STEPS, u = 1 - t;
    out.push({
      x: u*u*u*p0.x + 3*u*u*t*c1.x + 3*u*t*t*c2.x + t*t*t*p1.x,
      y: u*u*u*p0.y + 3*u*u*t*c1.y + 3*u*t*t*c2.y + t*t*t*p1.y,
    });
  }
}

// Make sure pdf.js has a worker. Inlined build injects window.__PDF_WORKER_SRC__
// (worker source text) → blob URL; served build points at the vendored file.
export function ensurePdfWorker() {
  const lib = window.pdfjsLib;
  if (!lib) throw new Error('pdf.js not loaded');
  if (lib.GlobalWorkerOptions.workerSrc) return;
  if (window.__PDF_WORKER_SRC__) {
    const blob = new Blob([window.__PDF_WORKER_SRC__], { type: 'application/javascript' });
    lib.GlobalWorkerOptions.workerSrc = URL.createObjectURL(blob);
  } else {
    lib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';
  }
}

// Walk one page's operator list → polylines in device (viewport) points, y-down.
function pageGeometry(opList, viewportT) {
  const lib = window.pdfjsLib;
  const OPS = lib.OPS;
  const stack = [];
  let ctm = [1, 0, 0, 1, 0, 0]; // content transform (composed onto viewport)
  const polylines = [];

  // Content transform then viewport transform → device (y-down) points.
  const toDev = (x, y) => { const u = apply(ctm, x, y); return apply(viewportT, u.x, u.y); };

  for (let i = 0; i < opList.fnArray.length; i++) {
    const fn = opList.fnArray[i], args = opList.argsArray[i];
    if (fn === OPS.save) { stack.push(ctm); }
    else if (fn === OPS.restore) { ctm = stack.pop() || [1,0,0,1,0,0]; }
    else if (fn === OPS.transform) { ctm = mat(ctm, args); }
    else if (fn === OPS.constructPath) {
      const ops = args[0], co = args[1];
      let k = 0;
      let cur = null, sub = null;
      const startSub = p => { sub = [p]; polylines.push({ pts: sub, closed: false }); cur = p; };
      for (const op of ops) {
        if (op === MOVE) { const p = toDev(co[k], co[k+1]); k += 2; startSub(p); }
        else if (op === LINE) { const p = toDev(co[k], co[k+1]); k += 2; if (sub) { sub.push(p); cur = p; } }
        else if (op === CURVE) {
          const c1 = toDev(co[k], co[k+1]), c2 = toDev(co[k+2], co[k+3]), p = toDev(co[k+4], co[k+5]); k += 6;
          if (sub && cur) { cubic(cur, c1, c2, p, sub); cur = p; }
        }
        else if (op === CURVE2) {
          const c2 = toDev(co[k], co[k+1]), p = toDev(co[k+2], co[k+3]); k += 4;
          if (sub && cur) { cubic(cur, cur, c2, p, sub); cur = p; }
        }
        else if (op === CURVE3) {
          const c1 = toDev(co[k], co[k+1]), p = toDev(co[k+2], co[k+3]); k += 4;
          if (sub && cur) { cubic(cur, c1, p, p, sub); cur = p; }
        }
        else if (op === CLOSE) { if (sub) sub.closed = polylines[polylines.length-1].closed = true; }
        else if (op === RECT) {
          const x = co[k], y = co[k+1], w = co[k+2], h = co[k+3]; k += 4;
          const r = [toDev(x, y), toDev(x+w, y), toDev(x+w, y+h), toDev(x, y+h)];
          polylines.push({ pts: r, closed: true });
          sub = null; cur = null;
        }
      }
    }
  }
  return polylines;
}

// Parse a PDF (Uint8Array). Returns { numPages, pages: [{ polylines, texts, w, h }] }
// with coordinates in points (y-down). texts: [{ str, x, y }].
export async function parsePDF(bytes) {
  ensurePdfWorker();
  const lib = window.pdfjsLib;
  const doc = await lib.getDocument({ data: bytes, disableFontFace: true }).promise;
  const pages = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const vp = page.getViewport({ scale: 1 });
    const opList = await page.getOperatorList();
    const polylines = pageGeometry(opList, vp.transform);
    const tc = await page.getTextContent();
    const texts = tc.items
      .filter(it => it.str && it.str.trim())
      .map(it => {
        const d = apply(vp.transform, it.transform[4], it.transform[5]);
        // w/h (points) let downstream reassemble split runs into lines.
        return { str: it.str, x: d.x, y: d.y, w: it.width || 0, h: it.height || 0 };
      });
    pages.push({ polylines, texts, w: vp.width, h: vp.height });
  }
  return { numPages: doc.numPages, pages };
}

// High-level import: parse, scale points→mm, assemble views across all pages
// (tagged with page + point-scale). Returns { views, unitScale, unitsKnown,
// texts, warnings } shaped like cadImport for the existing view picker.
export async function importPDF(bytes) {
  let parsed;
  try { parsed = await parsePDF(bytes); }
  catch (err) { return { views: [], warnings: ['Could not read the PDF: ' + (err && err.message || err)] }; }

  const allViews = [];
  const texts = [];
  parsed.pages.forEach((pg, pi) => {
    for (const t of pg.texts) texts.push({ ...t, page: pi });
    const mm = pg.polylines.map(pl => ({ closed: pl.closed, pts: pl.pts.map(p => ({ x: p.x * PT_TO_MM, y: p.y * PT_TO_MM })) }));
    const views = assembleViews(mm, 0.05);
    for (const v of views) {
      const b = v.bbox;
      const dx = -b.minX + 5, dy = -b.minY + 5;
      const off = pts => pts.map(p => ({ x: p.x + dx, y: p.y + dy }));
      v.outer = off(v.outer); v.holes = v.holes.map(off);
      v.w = b.maxX - b.minX; v.h = b.maxY - b.minY;
      v.bbox = { minX: 5, minY: 5, maxX: v.w + 5, maxY: v.h + 5 };
      v.page = pi;
      allViews.push(v);
    }
  });
  allViews.sort((a, b) => b.area - a.area);
  // PDF points are a real unit, but the drawing's scale (1:2 etc.) is unknown
  // until dimensions are read — so units are "unconfirmed": the picker offers a
  // width override, prefilled with the printed (points→mm) size.
  return {
    format: 'pdf', views: allViews, unitScale: PT_TO_MM, unitName: 'mm (printed)',
    unitsKnown: false, texts, numPages: parsed.numPages,
    warnings: allViews.length ? [] : ['No vector outlines found — this may be a scanned PDF (OCR support is coming).'],
  };
}
