// Recognising a calibration sheet in a photo
// (docs/calibration_and_backlog_prd_v1.2.md, Part A, plan step 6).
//
// Starts from rough corners, detectPaperCorners' or a person's drag, and
// gives up quietly when there is no frame. Along each rough side it walks
// profiles inward, from outside the rough paper edge to well inside it: on
// each one the paper edge is the first bright step and the frame is the first
// dark dip of about the right width. The dip's own width says the local print
// scale, which places the clock row and the two data rows behind it without
// trusting the rough corners for more than a direction. The clock row's black
// cells, read along the side, give the cell pitch and the word boundaries
// (three white cells in a row); the data cells are read at the positions the
// clock implies, in both directions, and only words that pass the checksum
// and agree with each other survive. Every black clock cell read is then a
// point with known design coordinates, and every frame dip a point on a known
// design line, which is what the fit (step 7) consumes.
//
// Nothing here moves a corner or writes state. It reads source pixels along
// its profiles in chunks and never holds a full-size copy of the photo.

import { layoutGeometry, decodeWord, clockBlack, LAYOUT_V1, PAPER_BY_CODE, LAYOUT_VERSION } from './calibSheet.js';
import { computeHomography, applyHomography } from './homography.js';
import { lensParams, undistortPixel } from './lens.js';

export const DETECT_DEFAULTS = {
  // Profiles start this far outside the rough edge. The rough corners are
  // often the FRAME's inner edge rather than the paper's: the frame is the
  // strongest boundary in the photo, so detectPaperCorners takes the window
  // for the sheet and the edge fit snaps to the frame. The paper edge is then
  // 11.5 mm out, up to 28 mm for the far side of a 94 percent print anchored
  // at a corner, and the reach has to cover it or there is no double check.
  outsideMm: 40,
  minDeskMm: 3,          // a paper edge needs this much dark desk before it; the frame's inner edge has 2 mm
  insideMm: 40,          // and run this far inside it
  profileStepMm: 1,      // frame profiles along a side, in rough millimetres
  alongStepMm: 0.25,     // track samples along a side, between the profiles
  endMm: 6,              // left unsampled at each end of a side
  sampleStepPx: 1,       // along a profile; the crossings are interpolated
  dipWidthMm: [1.1, 3.0],   // a frame dip is 2 mm times a print scale within 40 percent, plus blur
  minContrast: 40,       // paper minus ink, 0 to 255, for a profile to count
  cellWidthMm: [0.7, 2.6],  // a black clock cell run is 1.5 mm times the print scale, plus blur
  minWords: 1,
  minRunMm: 15,          // a frame line is continuous: the longest unbroken run of dips must reach this
  chunks: 8,
};

const lum = (d, i) => 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];

function readRegion(image, iw, ih, x0, y0, x1, y1) {
  const rx = Math.max(0, Math.floor(x0)), ry = Math.max(0, Math.floor(y0));
  const rw = Math.min(iw, Math.ceil(x1) + 1) - rx, rh = Math.min(ih, Math.ceil(y1) + 1) - ry;
  if (rw < 2 || rh < 2) return null;
  const c = document.createElement('canvas');
  c.width = rw; c.height = rh;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(image, rx, ry, rw, rh, 0, 0, rw, rh);
  return { x: rx, y: ry, w: rw, h: rh, data: ctx.getImageData(0, 0, rw, rh).data };
}

function sampler(reg) {
  return (x, y) => {
    const fx = x - reg.x, fy = y - reg.y;
    if (fx < 0 || fy < 0 || fx > reg.w - 1 || fy > reg.h - 1) return NaN;
    const x0 = Math.floor(fx), y0 = Math.floor(fy);
    const x1 = Math.min(x0 + 1, reg.w - 1), y1 = Math.min(y0 + 1, reg.h - 1);
    const ax = fx - x0, ay = fy - y0, d = reg.data;
    const a = lum(d, (y0 * reg.w + x0) * 4), b = lum(d, (y0 * reg.w + x1) * 4);
    const c = lum(d, (y1 * reg.w + x0) * 4), e = lum(d, (y1 * reg.w + x1) * 4);
    return (a * (1 - ax) + b * ax) * (1 - ay) + (c * (1 - ax) + e * ax) * ay;
  };
}

const median = arr => {
  if (!arr.length) return NaN;
  const s = arr.slice().sort((p, q) => p - q);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const percentile = (arr, p) => {
  if (!arr.length) return NaN;
  const s = arr.slice().sort((a, b) => a - b);
  return s[Math.max(0, Math.min(s.length - 1, Math.round(p * (s.length - 1))))];
};

// Where a sampled signal crosses `thr`, linearly interpolated between
// samples i and i + 1 (i may be fractional-safe: integers only).
const crossAt = (L, i, thr) => {
  const a = L[i], b = L[i + 1];
  return b === a ? i : i + (thr - a) / (b - a);
};

// One profile: the luminance along the inward normal from -outside to
// +inside, in steps of `step` px, starting at `d0` px. Returns the paper
// edge (desk-to-paper step) and the frame dip, both as offsets in px along
// the normal, or null when the profile shows no frame.
function analyseProfile(L, d0, step, pxPerMm, o) {
  const n = L.length;
  const vals = [];
  for (let i = 0; i < n; i++) if (!Number.isNaN(L[i])) vals.push(L[i]);
  if (vals.length < n * 0.6) return null;
  // The ink level from the darkest percent: on a white desk the profile is
  // 80 mm of paper with 5 mm of ink, and a fifth percentile lands on paper.
  const hi = percentile(vals, 0.9), lo = percentile(vals, 0.01);
  if (hi - lo < o.minContrast) return null;
  const thr = (hi + lo) / 2;
  // The paper edge: the first upward crossing that holds for 1 mm and
  // follows at least minDeskMm of desk. The frame's own inner edge is an
  // upward crossing too, but only 2 mm of ink precede it; the desk runs
  // from the profile's start. The crossing is taken halfway between the
  // desk's own level, read over the profile's first millimetres, and the
  // paper's, so a mid-grey liner, brighter than the paper-to-ink midpoint
  // but well below the paper, still has an edge; a desk as bright as the
  // paper has none, as before.
  const holdN = Math.max(2, Math.round(pxPerMm / step));
  const deskN = Math.max(2, Math.round(o.minDeskMm * pxPerMm / step));
  const lead = [];
  for (let i = 0; i < Math.min(n, deskN); i++) if (!Number.isNaN(L[i])) lead.push(L[i]);
  const deskLevel = lead.length ? median(lead) : NaN;
  const edgeThr = Number.isFinite(deskLevel) && deskLevel < hi - o.minContrast / 2 ? Math.max(thr, (deskLevel + hi) / 2) : thr;
  let edgeI = -1, dark = 0;
  for (let i = 0; i < n - holdN - 1; i++) {
    if (Number.isNaN(L[i]) || Number.isNaN(L[i + 1])) { dark = 0; continue; }
    if (L[i] < edgeThr) dark++;
    if (L[i] < edgeThr && L[i + 1] >= edgeThr) {
      let holds = dark >= deskN;
      for (let j = i + 1; holds && j <= i + holdN; j++) if (!(L[j] >= edgeThr)) holds = false;
      if (holds) { edgeI = i; break; }
      dark = 0;
    } else if (!(L[i] < edgeThr)) {
      dark = 0;
    }
  }
  // Had there been no desk (a white desk), the profile starts on paper: the
  // edge is then simply absent and the search for the dip begins at the top.
  const startI = edgeI >= 0 ? edgeI + holdN : 0;
  if (edgeI < 0 && !(L[0] >= thr)) return null;   // starts dark and never steps up: not paper
  // The first dip below thr after the edge, of about a frame line's width.
  const [wLo, wHi] = o.dipWidthMm.map(m => m * pxPerMm);
  let i = startI;
  while (i < n - 1) {
    while (i < n - 1 && !(L[i] < thr)) i++;
    if (i >= n - 1) break;
    let j = i;
    while (j < n - 1 && L[j + 1] < thr) j++;
    // Run i..j below thr. Crossings on either side, sub-sample.
    const a = i > 0 ? crossAt(L, i - 1, thr) : i, b = j < n - 1 ? crossAt(L, j, thr) : j;
    const widthPx = (b - a) * step;
    if (widthPx >= wLo && widthPx <= wHi) {
      // Ink must be dark, not a shadow's half tone.
      let mn = Infinity;
      for (let k = i; k <= j; k++) mn = Math.min(mn, L[k]);
      if (hi - mn >= o.minContrast) {
        // The paper edge at the gradient peak, refined by a parabola through
        // its neighbours: under symmetric blur that is the 50 percent crossing
        // of the desk-to-paper step, where the threshold crossing is biased
        // toward whichever of desk and ink is darker.
        let edge = null;
        if (edgeI >= 0) {
          // The crossing halfway between the desk just before the edge and
          // the paper just after it, each a median over 1 to 3 mm, so the
          // edge is the 50 percent point of its own step whatever the desk's
          // shade, and not of the paper-to-ink threshold.
          const mm = Math.max(1, Math.round(pxPerMm / step));
          const desk = [], paper = [];
          for (let j = edgeI - 3 * mm; j <= edgeI - mm; j++) if (j >= 0 && !Number.isNaN(L[j])) desk.push(L[j]);
          for (let j = edgeI + 1 + mm; j <= edgeI + 1 + 3 * mm; j++) if (j < n && !Number.isNaN(L[j])) paper.push(L[j]);
          const half = desk.length && paper.length ? (median(desk) + median(paper)) / 2 : thr;
          let at = edgeI;
          for (let j = Math.max(0, edgeI - mm); j < Math.min(n - 1, edgeI + mm); j++) {
            if (L[j] < half && L[j + 1] >= half) { at = j; break; }
          }
          edge = d0 + crossAt(L, at, half) * step;
        }
        return {
          edge,
          dip: d0 + ((a + b) / 2) * step, width: widthPx, thr, paper: hi, ink: mn,
        };
      }
    }
    if (widthPx > wHi) return null;   // something wide and dark first: an object over the frame
    i = j + 1;
  }
  return null;
}

// Theil-Sen seed, then total-least-squares with trimming, over points
// expressed as (along, offset) from a reference line. Returns the inlier
// mask and the line in those coordinates.
function robustLine(along, off) {
  const n = along.length;
  const slopes = [];
  const stride = Math.max(1, Math.floor(n / 60));
  for (let i = 0; i < n; i += stride) {
    for (let j = i + stride; j < n; j += stride) {
      const dt = along[j] - along[i];
      if (Math.abs(dt) > 1e-9) slopes.push((off[j] - off[i]) / dt);
    }
  }
  const b = slopes.length ? median(slopes) : 0;
  const a = median(off.map((s, i) => s - b * along[i]));
  const res = off.map((s, i) => s - (a + b * along[i]));
  const sigma = 1.4826 * median(res.map(Math.abs));
  const thr = Math.max(0.75, 3 * sigma);
  return { a, b, inlier: res.map(r => Math.abs(r) <= thr), rms: Math.sqrt(res.reduce((s, r) => s + r * r, 0) / n) };
}

// Runs of black (below the local threshold) along a 1-D signal sampled at
// `stepMm`, with sub-sample centres and widths in mm. NaN breaks a run.
function blackRuns(v, thr, stepMm) {
  const runs = [];
  const n = v.length;
  let i = 0;
  while (i < n) {
    if (Number.isNaN(v[i]) || !(v[i] < thr[i])) { i++; continue; }
    let j = i;
    while (j < n - 1 && !Number.isNaN(v[j + 1]) && v[j + 1] < thr[j + 1]) j++;
    const a = i > 0 && !Number.isNaN(v[i - 1]) ? crossAt(v, i - 1, thr[i]) : i;
    const b = j < n - 1 && !Number.isNaN(v[j + 1]) ? crossAt(v, j, thr[j]) : j;
    runs.push({ centre: (a + b) / 2 * stepMm, width: (b - a) * stepMm, i, j });
    i = j + 1;
  }
  return runs;
}

const lerpAt = (arr, x) => {
  const i = Math.floor(x);
  if (i < 0 || i >= arr.length - 1) return arr[Math.max(0, Math.min(arr.length - 1, i))];
  const f = x - i;
  return arr[i] * (1 - f) + arr[i + 1] * f;
};

// Recognise a sheet. image: the photo; corners: rough TL TR BR BL in photo
// px (rectify's convention); paperMm: the picker's { w, h } in portrait or
// as laid, matching the corners; opts.k1: the lens coefficient in use.
export function recogniseSheet(image, corners, paperMm, opts = {}) {
  const o = { ...DETECT_DEFAULTS, ...opts };
  const fail = (reason, partial) => ({ ok: false, reason, ...(partial || {}) });
  if (!image || !corners || corners.length !== 4 || !paperMm) return fail('no corners');
  const iw = image.naturalWidth || image.width, ih = image.naturalHeight || image.height;
  const k1 = Number(o.k1) || 0;
  const lp = lensParams(iw, ih);
  const und = p => (k1 ? undistortPixel(p, k1, 0, lp) : { x: p.x, y: p.y });
  const Hr = computeHomography(
    [{ x: 0, y: 0 }, { x: paperMm.w, y: 0 }, { x: paperMm.w, y: paperMm.h }, { x: 0, y: paperMm.h }], corners);
  if (!Hr) return fail('degenerate corners');
  const P = (x, y) => applyHomography(Hr, x, y);
  const sideDefs = [
    { side: 'top', len: paperMm.w, at: (a, d) => P(a, d) },
    { side: 'right', len: paperMm.h, at: (a, d) => P(paperMm.w - d, a) },
    { side: 'bottom', len: paperMm.w, at: (a, d) => P(paperMm.w - a, paperMm.h - d) },
    { side: 'left', len: paperMm.h, at: (a, d) => P(d, paperMm.h - a) },
  ];
  const rowMm = LAYOUT_V1.trackStart - (LAYOUT_V1.margin + LAYOUT_V1.frameWidth / 2) + LAYOUT_V1.cell / 2;  // 2.75: frame centre to clock row centre
  const rowOffsets = [rowMm, rowMm + LAYOUT_V1.cell, rowMm + 2 * LAYOUT_V1.cell];

  // Pass 1: the frame. Profiles every profileStepMm along each rough side,
  // read in chunks whose regions are kept for pass 2.
  const sides = [];
  for (const def of sideDefs) {
    const profiles = [];
    const regs = [];
    const a0 = o.endMm, a1 = def.len - o.endMm;
    const count = Math.floor((a1 - a0) / o.profileStepMm) + 1;
    const chunk = Math.ceil(count / o.chunks);
    for (let c0 = 0; c0 < count; c0 += chunk) {
      const c1 = Math.min(count, c0 + chunk);
      // The chunk's region: the band from -outside to +inside over its span.
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const i of [c0, c1 - 1]) {
        const a = a0 + i * o.profileStepMm;
        for (const d of [-o.outsideMm, o.insideMm]) {
          const q = def.at(a, d);
          x0 = Math.min(x0, q.x - 2); x1 = Math.max(x1, q.x + 2);
          y0 = Math.min(y0, q.y - 2); y1 = Math.max(y1, q.y + 2);
        }
      }
      const reg = (x1 < 0 || y1 < 0 || x0 > iw || y0 > ih) ? null : readRegion(image, iw, ih, x0, y0, x1, y1);
      regs.push({ aFrom: a0 + c0 * o.profileStepMm, aTo: a0 + (c1 - 1) * o.profileStepMm, reg, lumAt: reg ? sampler(reg) : null });
      if (!reg) { for (let i = c0; i < c1; i++) profiles.push({ a: a0 + i * o.profileStepMm, hit: null }); continue; }
      const lumAt = regs[regs.length - 1].lumAt;
      for (let i = c0; i < c1; i++) {
        const a = a0 + i * o.profileStepMm;
        const base = def.at(a, 0), inner = def.at(a, 1);
        const nx0 = inner.x - base.x, ny0 = inner.y - base.y;
        const pxPerMm = Math.hypot(nx0, ny0);
        if (!(pxPerMm > 0.5)) { profiles.push({ a, hit: null }); continue; }
        const nx = nx0 / pxPerMm, ny = ny0 / pxPerMm;
        const dStart = -o.outsideMm * pxPerMm, dEnd = o.insideMm * pxPerMm;
        const n = Math.floor((dEnd - dStart) / o.sampleStepPx) + 1;
        const L = new Float64Array(n);
        for (let s = 0; s < n; s++) {
          const d = dStart + s * o.sampleStepPx;
          L[s] = lumAt(base.x + nx * d, base.y + ny * d);
        }
        const hit = analyseProfile(L, dStart, o.sampleStepPx, pxPerMm, o);
        if (!hit) { profiles.push({ a, hit: null }); continue; }
        profiles.push({
          a, hit, pxPerMm,
          dipPhoto: { x: base.x + nx * hit.dip, y: base.y + ny * hit.dip },
          edgePhoto: hit.edge == null ? null : { x: base.x + nx * hit.edge, y: base.y + ny * hit.edge },
        });
      }
    }
    sides.push({ side: def.side, len: def.len, def, profiles, regs });
  }

  // Per side: the frame line through the dip centres (undistorted), the
  // clock signal along the side, and the words.
  let anyFrame = false;
  const words = [];
  for (const s of sides) {
    const hits = s.profiles.filter(p => p.hit);
    s.found = hits.length;
    s.line = null; s.words = [];
    s.frame = []; s.edge = [];
    // A frame line is continuous; the label strip's text and the ruler's
    // digits, which sit within reach of the bottom edge and are the right
    // width to pass for a frame dip, are dots. The longest unbroken run of
    // profiles with a dip has to be a real length of line.
    let run = 0, longest = 0;
    for (const p of s.profiles) { run = p.hit ? run + 1 : 0; if (run > longest) longest = run; }
    s.longestRunMm = longest * o.profileStepMm;
    if (hits.length < 20 || s.longestRunMm < o.minRunMm) continue;
    anyFrame = true;
    // A line in undistorted photo space, as (along, offset) from the chord
    // between the first and last dip.
    const up = hits.map(p => und(p.dipPhoto));
    const A = up[0], B = up[up.length - 1];
    const len = Math.hypot(B.x - A.x, B.y - A.y) || 1;
    const ux = (B.x - A.x) / len, uy = (B.y - A.y) / len;
    const along = up.map(p => (p.x - A.x) * ux + (p.y - A.y) * uy);
    const off = up.map(p => (p.x - A.x) * -uy + (p.y - A.y) * ux);
    const fit = robustLine(along, off);
    const inl = hits.filter((p, i) => fit.inlier[i]);
    s.line = { origin: A, dir: { x: ux, y: uy }, a: fit.a, b: fit.b, rms: fit.rms, inliers: inl.length };
    s.frame = inl.map(p => ({ photo: und(p.dipPhoto), raw: p.dipPhoto }));
    s.edge = hits.filter(p => p.edgePhoto).map(p => ({ photo: und(p.edgePhoto), raw: p.edgePhoto }));

    // Pass 2: the track, every alongStepMm along the side, each sample
    // placed from the two nearest inlier profiles: the dip centre, and the
    // dip's own width as the local printed millimetre (2 mm of ink at the
    // print scale), so the clock row and the two data rows are found behind
    // the frame wherever it actually is, bow and all, without trusting the
    // rough corners for more than a direction. Three samples per step.
    const inlierProfiles = inl;
    const n = Math.floor((s.len - 2 * o.endMm) / o.alongStepMm) + 1;
    const clock = new Float64Array(n), d1 = new Float64Array(n), d2 = new Float64Array(n), thr = new Float64Array(n);
    const clockPts = new Array(n).fill(null);
    let pi = 0;
    for (let i = 0; i < n; i++) {
      const a = o.endMm + i * o.alongStepMm;
      clock[i] = d1[i] = d2[i] = thr[i] = NaN;
      while (pi < inlierProfiles.length - 2 && inlierProfiles[pi + 1].a < a) pi++;
      const p0 = inlierProfiles[pi], p1 = inlierProfiles[Math.min(pi + 1, inlierProfiles.length - 1)];
      if (!p0 || !p1) continue;
      // Both neighbours have to be close: across a gap in the frame (a tool
      // over it) nothing is read.
      if (a < p0.a - 1.5 * o.profileStepMm || a > p1.a + 1.5 * o.profileStepMm) continue;
      const span = p1.a - p0.a;
      const f = span > 1e-9 ? Math.max(0, Math.min(1, (a - p0.a) / span)) : 0;
      const dip = p0.hit.dip * (1 - f) + p1.hit.dip * f;
      const mmPx = (p0.hit.width * (1 - f) + p1.hit.width * f) / 2;
      const t = p0.hit.thr * (1 - f) + p1.hit.thr * f;
      const base = s.def.at(a, 0), inner = s.def.at(a, 1);
      const nx0 = inner.x - base.x, ny0 = inner.y - base.y, pxPerMm = Math.hypot(nx0, ny0);
      if (!(pxPerMm > 0.5)) continue;
      const nx = nx0 / pxPerMm, ny = ny0 / pxPerMm;
      // A chunk's region was sized for its own profiles; a sample between two
      // chunks can fall just outside the first one's bounds, so every region
      // that brackets the sample is tried and the first that reads cleanly
      // is used. Without this the clock signal broke at every chunk boundary
      // and a word straddling one was lost.
      let c = null, r1 = null, r2 = null;
      for (const rg of s.regs) {
        if (!rg.reg || a < rg.aFrom - o.profileStepMm || a > rg.aTo + o.profileStepMm) continue;
        const at = m => { const d = dip + m * mmPx; return { v: rg.lumAt(base.x + nx * d, base.y + ny * d), p: { x: base.x + nx * d, y: base.y + ny * d } }; };
        const cc = at(rowOffsets[0]), rr1 = at(rowOffsets[1]), rr2 = at(rowOffsets[2]);
        if (Number.isNaN(cc.v) || Number.isNaN(rr1.v) || Number.isNaN(rr2.v)) continue;
        c = cc; r1 = rr1; r2 = rr2;
        break;
      }
      if (!c) continue;
      clock[i] = c.v; d1[i] = r1.v; d2[i] = r2.v; thr[i] = t;
      clockPts[i] = c.p;
    }
    const runs = blackRuns(clock, thr, o.alongStepMm)
      .map(r => ({ ...r, centre: r.centre + o.endMm }))
      .filter(r => r.width >= o.cellWidthMm[0] && r.width <= o.cellWidthMm[1]);
    if (runs.length < 8) continue;
    // Cell pitch from the spacing of neighbouring black clock cells, which is
    // two cells within a word; word boundaries are the four-cell gaps.
    const gaps = [];
    for (let i = 1; i < runs.length; i++) gaps.push(runs[i].centre - runs[i - 1].centre);
    const two = median(gaps);
    if (!(two > 0)) continue;
    const groups = [[runs[0]]];
    for (let i = 1; i < runs.length; i++) {
      if (gaps[i - 1] > 1.5 * two) groups.push([runs[i]]); else groups[groups.length - 1].push(runs[i]);
    }
    for (const g of groups) {
      if (g.length !== 8) continue;
      // Spacing must be even: a group of eight with a missing cell in the
      // middle and one too many at the end is not a word.
      let even = true;
      for (let i = 1; i < 8; i++) if (Math.abs(g[i].centre - g[i - 1].centre - two) > 0.35 * two) { even = false; break; }
      if (!even) continue;
      const cellAt = k => {
        // k even 2..16 are the black cells g[0..7]; odd cells sit between.
        if (k % 2 === 0) return g[k / 2 - 1].centre;
        if (k === 1) return g[0].centre - (g[1].centre - g[0].centre) / 2;
        if (k === 17) return g[7].centre + (g[7].centre - g[6].centre) / 2;
        return (g[(k - 1) / 2 - 1].centre + g[(k + 1) / 2 - 1].centre) / 2;
      };
      const readBits = reversed => {
        const bits = [];
        for (let b = 0; b < LAYOUT_V1.bitsPerWord; b++) {
          const row = Math.floor(b / LAYOUT_V1.dataCells), k0 = 1 + (b % LAYOUT_V1.dataCells);
          const k = reversed ? LAYOUT_V1.wordCells - k0 : k0;
          const x = (cellAt(k) - o.endMm) / o.alongStepMm;
          const v = lerpAt(row === 0 ? d1 : d2, x), t = lerpAt(thr, x);
          if (Number.isNaN(v) || Number.isNaN(t)) return null;
          bits.push(v < t ? 1 : 0);
        }
        return bits;
      };
      let fields = null, reversed = false, bits = null;
      for (const rev of [false, true]) {
        const bb = readBits(rev);
        const d = bb && decodeWord(bb);
        if (d) { fields = d; reversed = rev; bits = bb; break; }
      }
      if (!fields) continue;
      // The eight clock cells as photo points (the clock row's sample point
      // at each run's centre, interpolated between profiles), undistorted.
      const cells = g.map((run, i) => {
        const x = (run.centre - o.endMm) / o.alongStepMm, i0 = Math.max(0, Math.min(n - 2, Math.floor(x))), f = x - i0;
        const q0 = clockPts[i0], q1 = clockPts[i0 + 1];
        const q = q0 && q1 ? { x: q0.x * (1 - f) + q1.x * f, y: q0.y * (1 - f) + q1.y * f } : (q0 || q1);
        const k = reversed ? LAYOUT_V1.wordCells - (2 * i + 2) : 2 * i + 2;
        return { k, raw: q, photo: q ? und(q) : null, along: run.centre };
      });
      const w = { side: s.side, fields, reversed, bits, cells: cells.filter(c => c.photo), along: g[0].centre, pitchMm: two / 2 };
      s.words.push(w);
      words.push(w);
    }
  }
  if (!anyFrame) return fail('no frame found on any side', { sides: summarise(sides) });
  if (!words.length) return fail('frame found but no code word read', { sides: summarise(sides), frame: frameOut(sides), lineOnly: true });

  // Identity: the words must agree. The largest agreeing group wins and the
  // rest are dropped as misreads that beat the checksum by chance.
  const key = f => `${f.version}:${f.paper}:${f.sheet}:${f.job}`;
  const tally = new Map();
  for (const w of words) tally.set(key(w.fields), (tally.get(key(w.fields)) || 0) + 1);
  const bestKey = [...tally.entries()].sort((a, b) => b[1] - a[1])[0][0];
  const agreed = words.filter(w => key(w.fields) === bestKey);
  if (agreed.length < o.minWords) return fail('no agreeing code words', { sides: summarise(sides) });
  const f0 = agreed[0].fields;
  const paperKey = PAPER_BY_CODE[f0.paper];
  const geom = layoutGeometry(paperKey);
  // Positions must be distinct and consistent with their sides: the design
  // side a word's position belongs to, against the rough side it was read
  // on, is the sheet's rotation in the rough frame, and must be the same for
  // every word.
  const wordAt = new Map();
  for (const sd of geom.sides) for (const w of sd.list) wordAt.set(w.position, { side: sd.side, word: w });
  const sideIdx = { top: 0, right: 1, bottom: 2, left: 3 };
  const rotTally = new Map();
  for (const w of agreed) {
    const at = wordAt.get(w.fields.position);
    if (!at) { w.bad = 'position off the sheet'; continue; }
    w.design = at;
    w.rotation = (sideIdx[at.side] - sideIdx[w.side] + 4) % 4;
    rotTally.set(w.rotation, (rotTally.get(w.rotation) || 0) + 1);
  }
  const rotation = [...rotTally.entries()].sort((a, b) => b[1] - a[1])[0];
  if (!rotation) return fail('code words name positions off the sheet', { sides: summarise(sides) });
  const good = agreed.filter(w => w.design && w.rotation === rotation[0] && !w.bad);
  const seen = new Set();
  const kept = [];
  for (const w of good) {
    if (seen.has(w.fields.position)) continue;
    seen.add(w.fields.position);
    kept.push(w);
  }
  // Correspondences: every clock cell of every kept word.
  const points = [];
  for (const w of kept) {
    const cellsByK = new Map();
    for (const c of w.design.word.cells) if (c.row === 0) cellsByK.set(c.k, c);
    for (const c of w.cells) {
      const dc = cellsByK.get(c.k);
      if (!dc || !clockBlack(c.k)) continue;
      points.push({ design: { x: dc.x + dc.w / 2, y: dc.y + dc.h / 2 }, photo: c.photo, raw: c.raw, side: w.design.side, position: w.fields.position, k: c.k });
    }
  }
  // Frame lines, named by their design side after rotation.
  const designSideOf = roughSide => ['top', 'right', 'bottom', 'left'][(sideIdx[roughSide] + rotation[0]) % 4];
  const lines = sides.filter(s => s.line).map(s => ({
    roughSide: s.side, side: designSideOf(s.side), points: s.frame.map(p => p.photo), raw: s.frame.map(p => p.raw),
    rms: s.line.rms, inliers: s.line.inliers,
  }));
  const edges = sides.map(s => ({ roughSide: s.side, side: designSideOf(s.side), points: (s.edge || []).map(p => p.photo), raw: (s.edge || []).map(p => p.raw) }));
  const clockSeen = sides.reduce((n, s) => n + s.profiles.filter(p => p.hit).length, 0);
  for (const s of sides) { delete s.regs; delete s.def; }
  return {
    ok: true,
    identity: { version: f0.version, paper: paperKey, code: f0.paper, sheet: f0.sheet, job: f0.job, layout: LAYOUT_VERSION },
    rotation: rotation[0], words: kept, wordsRead: words.length, wordsAgreed: agreed.length,
    points, lines, edges, geom, k1,
    sides: summarise(sides),
    quality: { profiles: sides.reduce((n, s) => n + s.profiles.length, 0), hits: clockSeen },
  };
}

function summarise(sides) {
  return sides.map(s => ({ side: s.side, profiles: s.profiles.length, found: s.found || 0, words: (s.words || []).length,
    rms: s.line ? s.line.rms : null, longestRunMm: s.longestRunMm || 0 }));
}
function frameOut(sides) {
  return sides.filter(s => s.line).map(s => ({ side: s.side, points: s.frame.map(p => p.photo), rms: s.line.rms }));
}
