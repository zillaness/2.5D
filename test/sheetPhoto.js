// Synthetic photos of a calibration sheet, rendered from the SVG the print
// page itself produces (docs/calibration_and_backlog_prd_v1.2.md, Part A,
// plan step 5; criterion 15). Browser-side: test/e2e.mjs imports it into the
// page. Nothing here is used by the app.
//
// The chain is the real one in miniature. The print page's SVG is rasterised
// flat at high resolution onto a sheet of the real stock, through the print
// scale, anchor, registration offset and feed skew a printer would apply,
// with ink past a printer margin dropped. Objects are laid on the sheet.
// That flat sheet is then photographed: a centred pinhole camera (or a quad
// given outright) places it in the frame, the lens bows it, the optics blur
// it, the sensor adds noise, and the file may go through JPEG. Every step
// returns its truth, so a test can say exactly where any cell should be.
//
// Conventions match the suite's: photo pixel (u, v) samples the continuous
// point (u + 0.5, v + 0.5), so a corner the camera puts at continuous (x, y)
// is at (x - 0.5, y - 0.5) in rectify's convention, where pixel k's value
// sits at coordinate k.

import { printPageHTML, layoutGeometry, sheetCells, PAPER_CODES } from '../js/calibSheet.js';
import { PAPER_SIZES } from '../js/paperSizes.js';
import { computeHomography, applyHomography } from '../js/homography.js';
import { lensParams, undistortPixel, distortPixel } from '../js/lens.js';

// The sheet's SVG as the print page carries it: the HTML is parsed and the
// nth <svg> taken, so what is rendered is what would be printed.
export function sheetSVGFromPrintPage(paper, sheet, count, job) {
  const html = printPageHTML(paper, count, job);
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const svgs = doc.querySelectorAll('svg');
  const el = svgs[sheet - 1];
  if (!el) throw new Error(`sheet ${sheet} not on the print page`);
  return new XMLSerializer().serializeToString(el);
}

function decodeSVG(svg) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('svg decode')); };
    img.src = url;
  });
}

export function stockDims(key) {
  const p = PAPER_SIZES[key];
  return { w: Math.min(p.w, p.h), h: Math.max(p.w, p.h) };
}

// Where the ink lands on the real paper, in paper millimetres, for a design
// point in layout millimetres. scale {x, y}; anchor 'centre' (Fit to page
// scales about the page centre) or 'topleft' (a driver that scales from the
// corner); offset in mm (registration); skew in degrees (feed skew, about the
// anchor).
export function printAffine({ design, stock, scale = { x: 1, y: 1 }, anchor = 'centre', offset = { x: 0, y: 0 }, skewDeg = 0 }) {
  const s = typeof scale === 'number' ? { x: scale, y: scale } : scale;
  const t = skewDeg * Math.PI / 180, c = Math.cos(t), sn = Math.sin(t);
  const ad = anchor === 'centre' ? { x: design.w / 2, y: design.h / 2 } : { x: 0, y: 0 };
  const ap = anchor === 'centre' ? { x: stock.w / 2, y: stock.h / 2 } : { x: 0, y: 0 };
  const map = p => {
    const x = (p.x - ad.x) * s.x, y = (p.y - ad.y) * s.y;
    return { x: ap.x + x * c - y * sn + offset.x, y: ap.y + x * sn + y * c + offset.y };
  };
  // Canvas transform for drawing the design at R px/mm onto the paper canvas:
  // paper = ap + R(skew) S (design - ad) + offset.
  const matrix = R => ({
    a: s.x * c, b: s.x * sn, c: -s.y * sn, d: s.y * c,
    e: (ap.x + offset.x) * R - (ad.x * s.x * c - ad.y * s.y * sn) * R,
    f: (ap.y + offset.y) * R - (ad.x * s.x * sn + ad.y * s.y * c) * R,
  });
  return { map, matrix, scale: s, anchor, offset, skewDeg };
}

// A centred pinhole camera over the sheet. pose: height mm above the sheet's
// centre, tilt degrees about an in-plane axis at `axis` degrees, spin degrees
// in the plane, f in px (or f35 mm), ppx/ppy the principal point (image
// centre unless cropped). Returns the sheet's four corners in continuous
// photo coordinates, TL TR BR BL, and the projector.
export function cameraQuad(stock, pose, W, H) {
  const o = { height: 450, tilt: 0, axis: 0, spin: 0, f35: 26, ppx: W / 2, ppy: H / 2, ...pose };
  const f = o.f || (o.f35 / Math.hypot(36, 24)) * Math.hypot(W, H);
  const t = o.tilt * Math.PI / 180, a = o.axis * Math.PI / 180, sp = o.spin * Math.PI / 180;
  const rA = [Math.cos(a), Math.sin(a), 0];
  const rP = [-Math.sin(a) * Math.cos(t), Math.cos(a) * Math.cos(t), Math.sin(t)];
  const project = (xmm, ymm, zmm = 0) => {
    const u0 = xmm - stock.w / 2, v0 = ymm - stock.h / 2;
    const u = u0 * Math.cos(sp) - v0 * Math.sin(sp), v = u0 * Math.sin(sp) + v0 * Math.cos(sp);
    const cu = u * Math.cos(a) + v * Math.sin(a), cv = -u * Math.sin(a) + v * Math.cos(a);
    // The plane's normal, for a point raised zmm above the sheet.
    const n = [rA[1] * rP[2] - rA[2] * rP[1], rA[2] * rP[0] - rA[0] * rP[2], rA[0] * rP[1] - rA[1] * rP[0]];
    const X = cu * rA[0] + cv * rP[0] - zmm * n[0];
    const Y = cu * rA[1] + cv * rP[1] - zmm * n[1];
    const Z = o.height + cu * rA[2] + cv * rP[2] - zmm * n[2];
    return { x: o.ppx + f * X / Z, y: o.ppy + f * Y / Z };
  };
  const quad = [[0, 0], [stock.w, 0], [stock.w, stock.h], [0, stock.h]].map(([x, y]) => project(x, y));
  return { quad, project, f };
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SHEET_DEFAULTS = {
  paper: 'letter', sheet: 1, count: 1, job: 0x7f, stock: null,
  scale: 1, anchor: 'centre', offset: { x: 0, y: 0 }, skewDeg: 0, bottomMargin: 0,
  paperTint: '#f6f4ee', objects: [], flatPxPerMm: 8,
};
const PHOTO_DEFAULTS = {
  W: 2400, H: 1800, pose: null, quad: null, k1: 0, blur: 0, noise: 0, seed: 1,
  desk: '#3a352f', deskGradient: null, supersample: 2, jpeg: null, bend: 0, light: 0,
};

// The flat sheet: paper, then the ink through the print affine, then the
// objects on it, at R px/mm. Returns the canvas and the print affine.
async function flatSheet(o) {
  const design = stockDims(o.paper);
  const stock = stockDims(o.stock || o.paper);
  const R = o.flatPxPerMm;
  const svg = sheetSVGFromPrintPage(o.paper, o.sheet, o.count, o.job);
  const img = await decodeSVG(svg);
  const flat = document.createElement('canvas');
  flat.width = Math.round(stock.w * R); flat.height = Math.round(stock.h * R);
  const fc = flat.getContext('2d');
  fc.fillStyle = o.paperTint; fc.fillRect(0, 0, flat.width, flat.height);
  const aff = printAffine({ design, stock, scale: o.scale, anchor: o.anchor, offset: o.offset, skewDeg: o.skewDeg });
  fc.save();
  if (o.bottomMargin > 0) {
    // Ink the printer could not lay down past its bottom margin is simply
    // not there, and the paper stays white.
    fc.beginPath(); fc.rect(0, 0, flat.width, Math.round((stock.h - o.bottomMargin) * R)); fc.clip();
  }
  const m = aff.matrix(R);
  fc.setTransform(m.a, m.b, m.c, m.d, m.e, m.f);
  fc.imageSmoothingEnabled = true; fc.imageSmoothingQuality = 'high';
  fc.drawImage(img, 0, 0, design.w * R, design.h * R);
  fc.restore();
  drawObjects(fc, o.objects, R);
  return { canvas: flat, aff, stock, design, R };
}

function drawObjects(fc, objects, R) {
  for (const ob of objects || []) {
    fc.fillStyle = ob.color || '#23364a';
    const r = ob.r || 0;
    fc.beginPath();
    if (ob.pts) ob.pts.forEach((p, i) => (i ? fc.lineTo(p.x * R, p.y * R) : fc.moveTo(p.x * R, p.y * R)));
    else fc.roundRect(ob.x * R, ob.y * R, ob.w * R, ob.h * R, r * R);
    fc.closePath(); fc.fill();
  }
}

// Photograph a flat canvas of dims {w, h} mm at R px/mm: the camera, the
// lens, the optics, the sensor and the file. Returns the photo canvas and
// the geometry: the quad, the plane-to-photo homography and its inverse,
// the lens parameters and the camera.
async function photograph(flat, dims, R, o) {
  const fc = flat.getContext('2d');
  const cam = o.quad ? null : cameraQuad(dims, o.pose || {}, o.W, o.H);
  const quad = o.quad || cam.quad;
  const planeQuad = [{ x: 0, y: 0 }, { x: dims.w, y: 0 }, { x: dims.w, y: dims.h }, { x: 0, y: dims.h }];
  const Hp = computeHomography(planeQuad, quad);      // plane mm -> continuous photo (undistorted)
  const Hinv = computeHomography(quad, planeQuad);    // back
  const lp = lensParams(o.W, o.H);
  if (o.light) {
    // Uneven light: brightness falls by `light` (a fraction) from the
    // plane's left edge to its right, over paper, ink and objects alike.
    const d = fc.getImageData(0, 0, flat.width, flat.height);
    const p = d.data, fw0 = flat.width;
    for (let i = 0; i < p.length; i += 4) {
      const g = 1 - o.light * ((i / 4) % fw0) / (fw0 - 1);
      p[i] *= g; p[i + 1] *= g; p[i + 2] *= g;
    }
    fc.putImageData(d, 0, 0);
  }
  const flatData = fc.getImageData(0, 0, flat.width, flat.height).data;
  const fw = flat.width, fh = flat.height;
  const deskRGB = hexRGB(o.desk);
  const gradTo = o.deskGradient ? hexRGB(o.deskGradient) : null;

  const out = document.createElement('canvas');
  out.width = o.W; out.height = o.H;
  const oc = out.getContext('2d');
  const od = oc.createImageData(o.W, o.H);
  const px = od.data;
  const ss = Math.max(1, o.supersample | 0);
  const sub = [];
  for (let i = 0; i < ss; i++) for (let j = 0; j < ss; j++) sub.push([(i + 0.5) / ss, (j + 0.5) / ss]);
  const sample = (mx, my, acc) => {
    // mm on the plane -> flat pixel (pixel j covers [j, j+1) mm*R). Clamped,
    // not refused: the outer half pixel of the sheet is still paper, and
    // treating it as desk shaved 0.06 mm off every edge.
    const fx = Math.max(0, Math.min(fw - 1, mx * R - 0.5)), fy = Math.max(0, Math.min(fh - 1, my * R - 0.5));
    const x0 = Math.floor(fx), y0 = Math.floor(fy), x1 = Math.min(x0 + 1, fw - 1), y1 = Math.min(y0 + 1, fh - 1);
    const ax = fx - x0, ay = fy - y0;
    for (let c = 0; c < 3; c++) {
      const a = flatData[(y0 * fw + x0) * 4 + c], b = flatData[(y0 * fw + x1) * 4 + c];
      const d = flatData[(y1 * fw + x0) * 4 + c], e = flatData[(y1 * fw + x1) * 4 + c];
      acc[c] += (a * (1 - ax) + b * ax) * (1 - ay) + (d * (1 - ax) + e * ax) * ay;
    }
    return true;
  };
  const acc = [0, 0, 0];
  for (let v = 0; v < o.H; v++) {
    for (let u = 0; u < o.W; u++) {
      acc[0] = acc[1] = acc[2] = 0;
      let inside = 0;
      for (const [dx, dy] of sub) {
        let X = u + dx, Y = v + dy;
        if (o.k1) { const p = undistortPixel({ x: X, y: Y }, o.k1, 0, lp); X = p.x; Y = p.y; }
        const w = Hinv[6] * X + Hinv[7] * Y + Hinv[8];
        let mx = (Hinv[0] * X + Hinv[1] * Y + Hinv[2]) / w, my = (Hinv[3] * X + Hinv[4] * Y + Hinv[5]) / w;
        if (o.bend) {
          // A sheet that is not flat: a smooth in-plane displacement of up
          // to `bend` mm, one hump across and one down, which no homography
          // can absorb. Not a true curl, but what one looks like to a fit.
          mx += o.bend * Math.sin(Math.PI * my / dims.h) * Math.cos(Math.PI * mx / dims.w);
          my += o.bend * Math.sin(Math.PI * mx / dims.w) * Math.cos(Math.PI * my / dims.h);
        }
        if (mx >= 0 && my >= 0 && mx <= dims.w && my <= dims.h && sample(mx, my, acc)) inside++;
        else {
          const g = gradTo ? u / (o.W - 1) : 0;
          for (let c = 0; c < 3; c++) acc[c] += gradTo ? deskRGB[c] * (1 - g) + gradTo[c] * g : deskRGB[c];
        }
      }
      const i = (v * o.W + u) * 4;
      px[i] = acc[0] / sub.length; px[i + 1] = acc[1] / sub.length; px[i + 2] = acc[2] / sub.length; px[i + 3] = 255;
    }
  }
  oc.putImageData(od, 0, 0);

  let canvas = out;
  if (o.blur > 0) {
    const b = document.createElement('canvas');
    b.width = o.W; b.height = o.H;
    const bc = b.getContext('2d');
    bc.filter = `blur(${o.blur}px)`;
    bc.drawImage(out, 0, 0);
    bc.filter = 'none';
    canvas = b;
  }
  if (o.noise > 0) {
    const nc = canvas.getContext('2d');
    const d = nc.getImageData(0, 0, o.W, o.H);
    const rnd = mulberry32(o.seed);
    const p = d.data;
    for (let i = 0; i < p.length; i += 4) {
      // Box-Muller, one draw per pixel, the same on all three channels.
      const g = Math.sqrt(-2 * Math.log(1 - rnd())) * Math.cos(2 * Math.PI * rnd()) * o.noise;
      p[i] = Math.max(0, Math.min(255, p[i] + g));
      p[i + 1] = Math.max(0, Math.min(255, p[i + 1] + g));
      p[i + 2] = Math.max(0, Math.min(255, p[i + 2] + g));
    }
    nc.putImageData(d, 0, 0);
  }
  if (o.jpeg) {
    const blob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', o.jpeg));
    const im = await decodeSVG(blob.slice ? blob : canvas.toDataURL());
    const j = document.createElement('canvas');
    j.width = o.W; j.height = o.H;
    j.getContext('2d').drawImage(im, 0, 0);
    canvas = j;
  }
  const planeToPhoto = p => {
    const q = applyHomography(Hp, p.x, p.y);
    return o.k1 ? distortPixel(q, o.k1, 0, lp) : q;
  };
  return { canvas, quad, Hp, Hinv, lp, cam, planeToPhoto };
}

// Render one photo. Returns { canvas, truth }; see the file comment.
export async function renderSheetPhoto(opts = {}) {
  const o = { ...SHEET_DEFAULTS, ...PHOTO_DEFAULTS, ...opts };
  const { canvas: flat, aff, stock, design, R } = await flatSheet(o);
  const ph = await photograph(flat, stock, R, o);
  const { canvas, quad, Hp, Hinv, lp, cam } = ph;

  // Truth. designToPhoto takes a layout point through the print affine, the
  // homography and the lens, to continuous photo coordinates.
  const paperToPhoto = ph.planeToPhoto;
  const designToPhoto = p => paperToPhoto(aff.map(p));
  const geom = layoutGeometry(o.paper);
  return {
    canvas,
    truth: {
      paper: o.paper, stock: o.stock || o.paper, stockDims: stock, designDims: design,
      code: PAPER_CODES[o.paper], sheet: o.sheet, count: o.count, job: o.job,
      quad, corners: quad.map(q => ({ x: q.x - 0.5, y: q.y - 0.5 })),
      Hp, Hinv, k1: o.k1, lensParams: lp, print: aff, geom,
      cells: sheetCells(o.paper, o.sheet, o.job),
      paperToPhoto, designToPhoto, project: cam ? cam.project : null, f: cam ? cam.f : null,
      pxPerMm: Math.hypot(quad[2].x - quad[0].x, quad[2].y - quad[0].y) / Math.hypot(stock.w, stock.h),
    },
  };
}

// Several sheets on one table (phase 2). `table` is {w, h} mm, the plane the
// camera sees; each entry of `sheets` takes the sheet options above plus
// `x`, `y` (the sheet's centre on the table, mm) and `rot` (degrees,
// clockwise on the table). Objects in table millimetres lie on the table.
// The photo options are as above, with the camera over the table's centre.
// Returns { canvas, truth } where truth.sheets[i] carries each sheet's own
// corners, paperToPhoto, designToPhoto and cells, and truth.table the plane.
export async function renderTablePhoto(opts = {}) {
  const o = { table: { w: 900, h: 600 }, sheets: [], objects: [], flatPxPerMm: 8, paperTint: '#f6f4ee', ...PHOTO_DEFAULTS, ...opts };
  const R = o.flatPxPerMm;
  const table = o.table;
  const flat = document.createElement('canvas');
  flat.width = Math.round(table.w * R); flat.height = Math.round(table.h * R);
  const fc = flat.getContext('2d');
  fc.fillStyle = o.desk; fc.fillRect(0, 0, flat.width, flat.height);
  const placed = [];
  for (const sh of o.sheets) {
    const so = { ...SHEET_DEFAULTS, flatPxPerMm: R, paperTint: o.paperTint, ...sh };
    const fs = await flatSheet(so);
    const t = (so.rot || 0) * Math.PI / 180, c = Math.cos(t), sn = Math.sin(t);
    const cx = so.x, cy = so.y;
    fc.save();
    fc.setTransform(c, sn, -sn, c, cx * R, cy * R);
    fc.imageSmoothingEnabled = true; fc.imageSmoothingQuality = 'high';
    fc.drawImage(fs.canvas, -fs.stock.w * R / 2, -fs.stock.h * R / 2);
    fc.restore();
    // paper mm -> table mm
    const paperToTable = p => {
      const x = p.x - fs.stock.w / 2, y = p.y - fs.stock.h / 2;
      return { x: cx + x * c - y * sn, y: cy + x * sn + y * c };
    };
    placed.push({ so, fs, paperToTable });
  }
  drawObjects(fc, o.objects, R);
  const ph = await photograph(flat, table, R, o);
  const { canvas, quad, Hp, Hinv, lp, cam } = ph;
  const sheets = placed.map(({ so, fs, paperToTable }) => {
    const paperToPhoto = p => ph.planeToPhoto(paperToTable(p));
    const designToPhoto = p => paperToPhoto(fs.aff.map(p));
    const st = fs.stock;
    const pq = [[0, 0], [st.w, 0], [st.w, st.h], [0, st.h]].map(([x, y]) => paperToPhoto({ x, y }));
    const geom = layoutGeometry(so.paper);
    const fo = geom.frame.outer;
    const frameQuad = [[fo.x, fo.y], [fo.x + fo.w, fo.y], [fo.x + fo.w, fo.y + fo.h], [fo.x, fo.y + fo.h]].map(([x, y]) => designToPhoto({ x, y }));
    return {
      paper: so.paper, stock: so.stock || so.paper, stockDims: st, designDims: fs.design,
      code: PAPER_CODES[so.paper], sheet: so.sheet, count: so.count, job: so.job, x: so.x, y: so.y, rot: so.rot || 0,
      quad: pq, corners: pq.map(q => ({ x: q.x - 0.5, y: q.y - 0.5 })),
      frameQuad, frame: frameQuad.map(q => ({ x: q.x - 0.5, y: q.y - 0.5 })),   // the frame's outer corners, rectify's convention
      centre: paperToPhoto({ x: st.w / 2, y: st.h / 2 }),
      print: fs.aff, geom, cells: sheetCells(so.paper, so.sheet, so.job),
      paperToTable, paperToPhoto, designToPhoto,
      pxPerMm: Math.hypot(pq[2].x - pq[0].x, pq[2].y - pq[0].y) / Math.hypot(st.w, st.h),
    };
  });
  return {
    canvas,
    truth: {
      table, quad, corners: quad.map(q => ({ x: q.x - 0.5, y: q.y - 0.5 })), Hp, Hinv, k1: o.k1, lensParams: lp,
      tableToPhoto: ph.planeToPhoto, project: cam ? cam.project : null, f: cam ? cam.f : null,
      sheets,
    },
  };
}

function hexRGB(hex) {
  const h = String(hex).replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map(c => c + c).join('') : h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

// Luminance at a continuous photo point, bilinear, from a canvas.
export function photoSampler(canvas) {
  const w = canvas.width, h = canvas.height;
  const d = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, w, h).data;
  const lum = i => 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
  return (x, y) => {
    // Continuous (x, y) -> pixel centre convention: pixel k is at k + 0.5.
    const fx = x - 0.5, fy = y - 0.5;
    if (fx < 0 || fy < 0 || fx > w - 1 || fy > h - 1) return NaN;
    const x0 = Math.floor(fx), y0 = Math.floor(fy), x1 = Math.min(x0 + 1, w - 1), y1 = Math.min(y0 + 1, h - 1);
    const ax = fx - x0, ay = fy - y0;
    const a = lum((y0 * w + x0) * 4), b = lum((y0 * w + x1) * 4), c = lum((y1 * w + x0) * 4), e = lum((y1 * w + x1) * 4);
    return (a * (1 - ax) + b * ax) * (1 - ay) + (c * (1 - ax) + e * ax) * ay;
  };
}
