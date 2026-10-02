// The paper edge double check and the verdict
// (docs/calibration_and_backlog_prd_v1.2.md, Part A, plan step 8).
//
// Three independent statements about the paper meet here: the stock the
// code says the sheet was made for, the stock the paper picker says, and the
// shape the paper's edges actually have. The edges win, because they are the
// only one measured from the physical sheet in this photo. Through the fit,
// the paper-edge points land in design millimetres, where a 1:1 print on the
// right stock puts them exactly on the stock's rectangle. A rectangle fitted
// to them with five parameters, scale across, scale down, rotation and two
// offsets, is the print scale, the feed skew and the registration offset,
// and its aspect ratio names the stock whatever the scale was.
//
// Pure: no DOM, no state. The print check's record is a plain object the
// caller stores.

import { PAPER_SIZES } from './paperSizes.js';
import { PAPER_CODES } from './calibSheet.js';

export const VERDICT_DEFAULTS = {
  oneToOneBand: 0.005,     // +/- 0.5 percent reads "1:1": paper is cut to about 0.3 percent
  minEdgePoints: 30,       // per side, to measure the paper at all
  aspectTol: 0.025,        // a stock is named when the measured aspect is within this
  maxResidualMm: 1.0,      // edge points this far from the fitted rectangle are not paper edge
};

// Total-least-squares line through points: { mx, my, dx, dy, rms }.
function tlsLine(pts) {
  let mx = 0, my = 0;
  for (const p of pts) { mx += p.x; my += p.y; }
  mx /= pts.length; my /= pts.length;
  let sxx = 0, syy = 0, sxy = 0;
  for (const p of pts) { const ax = p.x - mx, ay = p.y - my; sxx += ax * ax; syy += ay * ay; sxy += ax * ay; }
  const th = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  const dx = Math.cos(th), dy = Math.sin(th);
  let ss = 0;
  for (const p of pts) { const d = (p.x - mx) * -dy + (p.y - my) * dx; ss += d * d; }
  return { mx, my, dx, dy, rms: Math.sqrt(ss / pts.length) };
}
const median = arr => { const s = arr.slice().sort((a, b) => a - b); const m = s.length >> 1; return s.length ? (s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2) : NaN; };

// Fit the paper rectangle to edge points in design millimetres, given per
// design side: { top: [pts], right: [...], bottom: [...], left: [...] }.
// Returns null when fewer than two opposite sides are measured, else
// { w, h, rotDeg, x0, y0, sides: {...}, residualMm, corners } where w and h
// are the paper's size in design mm (so a 96 percent print of Letter reads
// 224.9 wide), rotDeg the feed skew, (x0, y0) the top-left corner in design
// mm, and corners the four corners in design mm, TL TR BR BL.
export function fitPaperRect(edges, opts = {}) {
  const o = { ...VERDICT_DEFAULTS, ...opts };
  const lines = {};
  for (const side of ['top', 'right', 'bottom', 'left']) {
    let pts = (edges && edges[side]) || [];
    if (pts.length < o.minEdgePoints) continue;
    // One trimming pass against the line itself.
    let line = tlsLine(pts);
    const d = pts.map(p => Math.abs((p.x - line.mx) * -line.dy + (p.y - line.my) * line.dx));
    const thr = Math.max(0.1, 3 * 1.4826 * median(d), 0);
    const keep = pts.filter((_, i) => d[i] <= Math.min(thr, o.maxResidualMm));
    if (keep.length < o.minEdgePoints) continue;
    line = tlsLine(keep);
    lines[side] = { ...line, n: keep.length };
  }
  const haveW = lines.left && lines.right, haveH = lines.top && lines.bottom;
  if (!haveW && !haveH) return null;
  // The sheet's rotation in design space: the mean of the sides' angles,
  // each taken relative to its nominal direction.
  const angles = [];
  for (const side of ['top', 'bottom']) if (lines[side]) angles.push(Math.atan2(lines[side].dy, lines[side].dx));
  for (const side of ['left', 'right']) if (lines[side]) {
    let a = Math.atan2(lines[side].dy, lines[side].dx) - Math.PI / 2;
    while (a > Math.PI / 2) a -= Math.PI; while (a < -Math.PI / 2) a += Math.PI;
    angles.push(a);
  }
  const norm = a => { while (a > Math.PI / 2) a -= Math.PI; while (a < -Math.PI / 2) a += Math.PI; return a; };
  const rot = angles.map(norm).reduce((s, a) => s + a, 0) / angles.length;
  const c = Math.cos(rot), s = Math.sin(rot);
  // Each side's position along its own normal, in the rotated frame: a
  // horizontal side's offset is its centroid's v = -x sin + y cos; a
  // vertical side's is u = x cos + y sin.
  const u = l => l.mx * c + l.my * s, v = l => -l.mx * s + l.my * c;
  const w = haveW ? u(lines.right) - u(lines.left) : null;
  const h = haveH ? v(lines.bottom) - v(lines.top) : null;
  const uL = lines.left ? u(lines.left) : (lines.right ? u(lines.right) - (w ?? 0) : null);
  const vT = lines.top ? v(lines.top) : (lines.bottom ? v(lines.bottom) - (h ?? 0) : null);
  let residual = 0, n = 0;
  for (const side of Object.keys(lines)) { residual += lines[side].rms * lines[side].rms * lines[side].n; n += lines[side].n; }
  const back = (uu, vv) => ({ x: uu * c - vv * s, y: uu * s + vv * c });
  const corners = (w != null && h != null && uL != null && vT != null)
    ? [back(uL, vT), back(uL + w, vT), back(uL + w, vT + h), back(uL, vT + h)] : null;
  const tl = (uL != null && vT != null) ? back(uL, vT) : null;
  return {
    w, h, rotDeg: rot * 180 / Math.PI, x0: tl ? tl.x : null, y0: tl ? tl.y : null,
    corners, sides: Object.fromEntries(Object.entries(lines).map(([k, l]) => [k, { n: l.n, rms: l.rms }])),
    residualMm: n ? Math.sqrt(residual / n) : null, measuredSides: Object.keys(lines).length,
  };
}

// The stock whose portrait aspect matches w / h, or null.
export function stockFromAspect(w, h, opts = {}) {
  const o = { ...VERDICT_DEFAULTS, ...opts };
  if (!(w > 0) || !(h > 0)) return null;
  const aspect = Math.min(w, h) / Math.max(w, h);
  let best = null;
  for (const key of Object.keys(PAPER_CODES)) {
    const p = PAPER_SIZES[key];
    if (!p) continue;
    const a = Math.min(p.w, p.h) / Math.max(p.w, p.h);
    const d = Math.abs(a - aspect);
    if (d <= o.aspectTol && (!best || d < best.d)) best = { key, d, aspect: a };
  }
  return best ? { stock: best.key, aspect, expected: best.aspect } : null;
}

export function stockLabel(key) {
  const p = PAPER_SIZES[key];
  return p ? p.name.replace(/ \(.*\)$/, '') : key;
}

const pct = x => `${(x * 100).toFixed(1)} percent`;

// The verdict. identity: the sheet's { paper, sheet, job }; rect: fitPaperRect's
// result or null; picker: the paper picker's key; record: a print-check
// record for this job and sheet, or null. Returns { source, stock, scale,
// oneToOne, rect, message, overridePicker, record }:
//   source   'edges' | 'record' | 'design'
//   stock    the paper the sheet was printed on, as the edges say, or the
//            layout's stock when assumed
//   scale    { x, y }: the print scale, 1 when assumed
//   rect     the paper rectangle in design mm used for the corners
export function sheetVerdict({ identity, rect, picker, record }, opts = {}) {
  const o = { ...VERDICT_DEFAULTS, ...opts };
  const designStock = identity.paper;
  const d = PAPER_SIZES[designStock];
  const dW = Math.min(d.w, d.h), dH = Math.max(d.w, d.h);
  const measured = rect && rect.w != null && rect.h != null;
  if (measured) {
    const named = stockFromAspect(rect.w, rect.h, o);
    if (!named) {
      // Edges that match no stock: measured, but not a size the app knows.
      // The design is taken as true rather than guess a scale from an
      // unknown sheet.
      return {
        source: 'design', stock: designStock, scale: { x: 1, y: 1 }, oneToOne: null,
        rect: { x0: 0, y0: 0, w: dW, h: dH, rotDeg: 0, corners: [{ x: 0, y: 0 }, { x: dW, y: 0 }, { x: dW, y: dH }, { x: 0, y: dH }] },
        message: `Print scale unverified: the paper's edges (${rect.w.toFixed(1)} × ${rect.h.toFixed(1)} mm at the print's scale) match no paper size the app knows.`,
        overridePicker: null, record: null,
      };
    }
    const p = PAPER_SIZES[named.stock];
    const sW = Math.min(p.w, p.h), sH = Math.max(p.w, p.h);
    const scale = { x: sW / rect.w, y: sH / rect.h };
    const oneToOne = Math.abs(scale.x - 1) <= o.oneToOneBand && Math.abs(scale.y - 1) <= o.oneToOneBand;
    let message;
    if (named.stock !== designStock) {
      message = `This ${stockLabel(designStock)} sheet was printed on ${stockLabel(named.stock)} paper, at ${pct(scale.x)} across and ${pct(scale.y)} down; corrected for.`;
    } else if (oneToOne) {
      message = `Printed at 1:1 on ${stockLabel(named.stock)}.`;
    } else {
      message = `Printed at ${pct(scale.x)} across and ${pct(scale.y)} down, corrected for. Fit to page was probably on; nothing needs reprinting.`;
    }
    const overridePicker = picker && picker !== named.stock && PAPER_CODES[picker] !== undefined ? named.stock : null;
    if (overridePicker) message += ` The paper picker said ${stockLabel(picker)}; the sheet's edges say ${stockLabel(named.stock)}, which is used.`;
    return {
      source: 'edges', stock: named.stock, scale, oneToOne, rect, message, overridePicker,
      record: { job: identity.job, sheet: identity.sheet, layout: identity.version, design: designStock, stock: named.stock,
        scale, rect: { x0: rect.x0, y0: rect.y0, w: rect.w, h: rect.h, rotDeg: rect.rotDeg } },
    };
  }
  if (record && record.rect && record.stock) {
    const r = record.rect;
    const rad = (r.rotDeg || 0) * Math.PI / 180, c = Math.cos(rad), s = Math.sin(rad);
    const back = (uu, vv) => ({ x: r.x0 + uu * c - vv * s, y: r.y0 + uu * s + vv * c });
    const corners = [back(0, 0), back(r.w, 0), back(r.w, r.h), back(0, r.h)];
    const when = record.at ? new Date(record.at).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : '';
    return {
      source: 'record', stock: record.stock, scale: record.scale, oneToOne: null,
      rect: { ...r, corners },
      message: `Paper edges not visible. Scale from your print check of set ${jobHex(identity.job)}, sheet ${identity.sheet}${when ? ` on ${when}` : ''}: ${pct(record.scale.x)} across, ${pct(record.scale.y)} down.`,
      overridePicker: picker && picker !== record.stock && PAPER_CODES[picker] !== undefined ? record.stock : null, record: null,
    };
  }
  return {
    source: 'design', stock: designStock, scale: { x: 1, y: 1 }, oneToOne: null,
    rect: { x0: 0, y0: 0, w: dW, h: dH, rotDeg: 0, corners: [{ x: 0, y: 0 }, { x: dW, y: 0 }, { x: dW, y: dH }, { x: 0, y: dH }] },
    message: 'Print scale unverified: the paper\'s edges are not visible against this surface, and no print check is on record for this set. A 1:1 print is assumed.',
    overridePicker: null, record: null,
  };
}

export function jobHex(job) {
  return (Number(job) & 0xff).toString(16).toUpperCase().padStart(2, '0');
}

// Did a measured rectangle disagree with a record past the 1:1 band? Then
// the photo is believed and the record is offered for update.
export function recordDisagrees(record, verdict, opts = {}) {
  const o = { ...VERDICT_DEFAULTS, ...opts };
  if (!record || !verdict || verdict.source !== 'edges') return false;
  return Math.abs(record.scale.x - verdict.scale.x) > o.oneToOneBand || Math.abs(record.scale.y - verdict.scale.y) > o.oneToOneBand ||
    record.stock !== verdict.stock;
}
