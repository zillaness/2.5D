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
  // A ruler verification on record (plan step 12) is preferred over the
  // paper's edges for the SIZE, because it is under the paper's cut
  // tolerance: the frame's outside edges were measured with a steel rule,
  // which fixes the print scale on both axes. The paper's position and
  // rotation still come from the edges when they are visible, from the
  // print check otherwise, and are assumed centred when neither is known.
  if (record && record.ruler && record.ruler.scale) {
    const rs = record.ruler.scale;
    const named = measured ? stockFromAspect(rect.w, rect.h, o) : null;
    const stock = named ? named.stock : (record.stock || designStock);
    const p = PAPER_SIZES[stock];
    const sW = Math.min(p.w, p.h), sH = Math.max(p.w, p.h);
    const w = sW / rs.x, h = sH / rs.y;
    let x0, y0, rotDeg, from;
    if (measured && rect.x0 != null) {
      // The edges' rectangle, re-sized about its own centre.
      const rad = (rect.rotDeg || 0) * Math.PI / 180, c = Math.cos(rad), s = Math.sin(rad);
      const cx = rect.x0 + (rect.w * c - rect.h * s) / 2, cy = rect.y0 + (rect.w * s + rect.h * c) / 2;
      x0 = cx - (w * c - h * s) / 2; y0 = cy - (w * s + h * c) / 2; rotDeg = rect.rotDeg || 0; from = 'the paper\'s edges';
    } else if (record.rect) {
      const r = record.rect;
      const rad = (r.rotDeg || 0) * Math.PI / 180, c = Math.cos(rad), s = Math.sin(rad);
      const cx = r.x0 + (r.w * c - r.h * s) / 2, cy = r.y0 + (r.w * s + r.h * c) / 2;
      x0 = cx - (w * c - h * s) / 2; y0 = cy - (w * s + h * c) / 2; rotDeg = r.rotDeg || 0; from = 'your print check';
    } else {
      x0 = (dW - w) / 2; y0 = (dH - h) / 2; rotDeg = 0; from = 'a centred print, assumed';
    }
    const rad = rotDeg * Math.PI / 180, c = Math.cos(rad), s = Math.sin(rad);
    const back = (uu, vv) => ({ x: x0 + uu * c - vv * s, y: y0 + uu * s + vv * c });
    const corners = [back(0, 0), back(w, 0), back(w, h), back(0, h)];
    const oneToOne = Math.abs(rs.x - 1) <= o.oneToOneBand && Math.abs(rs.y - 1) <= o.oneToOneBand;
    return {
      source: 'ruler', stock, scale: { x: rs.x, y: rs.y }, oneToOne,
      rect: { x0, y0, w, h, rotDeg, corners },
      message: `Scale from your ruler: ${pct(rs.x)} across, ${pct(rs.y)} down (frame measured ${record.ruler.w} × ${record.ruler.h} mm); the sheet's position from ${from}.` +
        (named && picker && picker !== named.stock && PAPER_CODES[picker] !== undefined ? ` The paper picker said ${stockLabel(picker)}; the sheet's edges say ${stockLabel(named.stock)}, which is used.` : ''),
      overridePicker: named && picker && picker !== named.stock && PAPER_CODES[picker] !== undefined ? named.stock : null,
      // The edges, when measured, still refresh the print check beside the ruler.
      record: measured && named ? { job: identity.job, sheet: identity.sheet, layout: identity.version, design: designStock, stock: named.stock,
        scale: { x: Math.min(sW, sH) / Math.min(rect.w, rect.h) * (sW < sH ? 1 : 1), y: sH / rect.h }, rect: { x0: rect.x0, y0: rect.y0, w: rect.w, h: rect.h, rotDeg: rect.rotDeg } } : null,
    };
  }
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

// Photo-quality guidance (plan step 9, criterion 11). Recognition already
// measures what makes a photo good or bad, so the panel says it before
// anyone traces. Each signal past its threshold is one specific instruction.
export const GUIDANCE_THRESHOLDS = Object.freeze({
  minPxPerMm: 4,        // six pixels per 1.5 mm cell
  minCleanShare: 0.8,   // of the code words on the sides that were found
  maxFitMm: 0.2,
});

export function photoGuidance({ pxPerMm, cleanShare, fitMm }, thresholds = GUIDANCE_THRESHOLDS) {
  const out = [];
  if (Number.isFinite(pxPerMm) && pxPerMm < thresholds.minPxPerMm) {
    out.push({ signal: 'resolution', value: pxPerMm,
      text: `The sheet is small in the photo (${pxPerMm.toFixed(1)} px/mm). Move closer, or use the 2× lens.` });
  }
  if (Number.isFinite(cleanShare) && cleanShare < thresholds.minCleanShare) {
    out.push({ signal: 'code', value: cleanShare,
      text: `The code is blurred or glared (${Math.round(cleanShare * 100)} percent of its words read). Hold still, tap to focus, or move the light.` });
  }
  if (Number.isFinite(fitMm) && fitMm > thresholds.maxFitMm) {
    out.push({ signal: 'fit', value: fitMm,
      text: `The sheet may not be flat (fit ${fitMm.toFixed(2)} mm). Tape the corners down or use cardstock.` });
  }
  return out;
}

export function jobHex(job) {
  return (Number(job) & 0xff).toString(16).toUpperCase().padStart(2, '0');
}

// The frame's outside size at 100 percent, which is what a steel rule
// measures on the print: the layout's margin in from every paper edge.
export function frameOutsideMm(paperKey) {
  const p = PAPER_SIZES[paperKey];
  if (!p) return null;
  return { w: Math.min(p.w, p.h) - 2 * FRAME_MARGIN_MM, h: Math.max(p.w, p.h) - 2 * FRAME_MARGIN_MM };
}
const FRAME_MARGIN_MM = 10;

// A ruler reading to a scale per axis, or null when it is not a plausible
// reading (within 15 percent of the design).
export function rulerScale(paperKey, wMm, hMm) {
  const f = frameOutsideMm(paperKey);
  if (!f || !(wMm > 0) || !(hMm > 0)) return null;
  const sx = wMm / f.w, sy = hMm / f.h;
  if (sx < 0.85 || sx > 1.15 || sy < 0.85 || sy > 1.15) return null;
  return { x: sx, y: sy };
}

// Did a measured rectangle disagree with a record past the 1:1 band? Then
// the photo is believed and the record is offered for update.
export function recordDisagrees(record, verdict, opts = {}) {
  const o = { ...VERDICT_DEFAULTS, ...opts };
  if (!record || !verdict || verdict.source !== 'edges') return false;
  return Math.abs(record.scale.x - verdict.scale.x) > o.oneToOneBand || Math.abs(record.scale.y - verdict.scale.y) > o.oneToOneBand ||
    record.stock !== verdict.stock;
}
