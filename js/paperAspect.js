// Is the sheet in the photo the size the person picked?
// (docs/calibration_and_backlog_prd_v1.2.md, Part A step 1.)
//
// Nothing used to check. Pick US Letter, photograph A4, and every trace came
// back 2.8 percent wide and 5.9 percent short with no warning, because the
// paper size is the whole of the scale. Absolute size cannot be read from one
// photo, but proportions can, and Letter (0.773) and A4 (0.707) are 9 percent
// apart.
//
// From straight above, a rectangle's image keeps its proportions. Tilted, it
// foreshortens. Zhang and He's whiteboard-scanning construction recovers the
// true proportions from the four corners given the camera's focal length. The
// same construction can also estimate the focal length, but not always: tip
// the phone about one axis only, the commonest tilt there is, and one pair of
// the sheet's edges stays parallel in the photo, which leaves the focal length
// undetermined. So this does not guess one. It computes the proportions over
// every plausible focal length and, in case the photo was cropped, every
// plausible principal point, narrowed to the phone's own lens when EXIF records
// it on an uncropped photo, and warns only when the selected paper fits none of
// them. The guarantee that matters is the one that holds without EXIF: a sheet
// of the right size is never flagged.

import { lensParams, undistortPixel } from './lens.js';

const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const dist = (p, q) => Math.hypot(p.x - q.x, p.y - q.y);
const short = r => (r > 1 ? 1 / r : r);

// Plausible focal lengths without EXIF, as multiples of the image diagonal: a
// phone's wide lens is about 0.6, its 3x about 1.8. An ultrawide on a sheet of
// paper is not a real case.
export const FOCAL_RANGE = [0.4, 2.2];
// Without trusted EXIF the photo may also have been cropped, which moves the
// principal point off the image centre. It is allowed anywhere in the middle
// 40 percent of the frame in each direction.
export const PP_SPAN = 0.2;
const FOCAL_EXIF_SLACK = 0.08;   // EXIF rounds to whole millimetres and crops vary
const CORNER_SLACK = 0.02;       // proportions error from corner placement

// Short side over long side of a rectangle seen at four photo corners, for one
// assumed camera: principal point (u0, v0), focal lengths f0 to f1. Zhang and
// He's construction; w/h at focal length f is a ratio of two linear functions
// of f^2, so it is monotonic in f and its extremes sit at the range's ends.
function foldedRange(c, u0, v0, f0, f1) {
  const h = p => [p.x - u0, p.y - v0, 1];
  // Zhang and He name the rectangle's corners (0,0), (w,0), (0,h), (w,h).
  const m1 = h(c[0]), m2 = h(c[1]), m3 = h(c[3]), m4 = h(c[2]);
  const c14 = cross(m1, m4);
  const d2 = dot(cross(m2, m4), m3), d3 = dot(cross(m3, m4), m2);
  if (Math.abs(d2) < 1e-12 || Math.abs(d3) < 1e-12) return null;
  const k2r = dot(c14, m3) / d2, k3r = dot(c14, m2) / d3;
  const n2 = [k2r * m2[0] - m1[0], k2r * m2[1] - m1[1], k2r * m2[2] - m1[2]];
  const n3 = [k3r * m3[0] - m1[0], k3r * m3[1] - m1[1], k3r * m3[2] - m1[2]];
  const at = f => Math.sqrt((n2[0] * n2[0] + n2[1] * n2[1] + f * f * n2[2] * n2[2]) /
    (n3[0] * n3[0] + n3[1] * n3[1] + f * f * n3[2] * n3[2]));
  const a = at(f0), b = at(f1);
  if (!(a > 0 && b > 0)) return null;
  const lo = Math.min(a, b), hi = Math.max(a, b);
  // Folded to short over long. Straddling 1 makes the fold non-monotonic, and
  // then the folded set runs up to 1 itself.
  if (hi <= 1) return [lo, hi];
  if (lo >= 1) return [1 / hi, 1 / lo];
  return [Math.min(lo, 1 / hi), 1];
}

// The rectangle's short-over-long proportions, as an interval over every
// camera the photo could have come from. opts.f is a trusted focal length in
// pixels (EXIF, on an uncropped photo): then the principal point is the image
// centre and the focal length is pinned to within EXIF's rounding. Without it,
// both range over their plausible sets. opts.k1 / opts.k2 undistort first.
// Returns { lo, hi, mid, known } or null for a degenerate quad.
export function rectAspectRange(corners, imgW, imgH, opts = {}) {
  if (!corners || corners.length !== 4) return null;
  const k1 = Number(opts.k1) || 0, k2 = Number(opts.k2) || 0;
  const lp = lensParams(imgW, imgH);
  const c = (k1 || k2) ? corners.map(p => undistortPixel(p, k1, k2, lp)) : corners;
  const diag = Math.hypot(imgW, imgH);
  const known = opts.f > 0;
  const fm = known ? opts.f : 0.6 * diag;
  const mid = foldedRange(c, imgW / 2, imgH / 2, fm, fm);
  let lo = Infinity, hi = -Infinity;
  const take = r => { if (r) { lo = Math.min(lo, r[0]); hi = Math.max(hi, r[1]); } };
  if (known) {
    take(foldedRange(c, imgW / 2, imgH / 2, opts.f * (1 - FOCAL_EXIF_SLACK), opts.f * (1 + FOCAL_EXIF_SLACK)));
  } else {
    const N = 5;
    for (let i = 0; i < N; i++) {
      for (let j = 0; j < N; j++) {
        const u0 = imgW * (0.5 + PP_SPAN * (2 * i / (N - 1) - 1));
        const v0 = imgH * (0.5 + PP_SPAN * (2 * j / (N - 1) - 1));
        take(foldedRange(c, u0, v0, FOCAL_RANGE[0] * diag, FOCAL_RANGE[1] * diag));
      }
    }
  }
  if (!(lo <= hi) || !mid) {
    const affine = (dist(c[0], c[1]) + dist(c[3], c[2])) / (dist(c[0], c[3]) + dist(c[1], c[2]));
    const s = short(affine);
    return { lo: s, hi: s, mid: s, known };
  }
  return { lo, hi, mid: mid[0], known };
}

// Where to look for a better match, most common first, so A-series sheets of
// near-identical proportions resolve to the one people actually own.
const PREFER = ['letter', 'A4', 'legal', 'A5', 'A3', 'tabloid', 'B5', 'B4'];

// Compare the photographed proportions with the selected stock. sizes is the
// PAPER_SIZES table. opts as rectAspectRange. Returns
// { measured, expected, range, mismatch, suggestion, known } or null.
export function checkPaperAspect(corners, imgW, imgH, sizeKey, sizes, opts = {}) {
  const sel = sizes[sizeKey];
  if (!sel || sizeKey === 'custom') return null;
  const r = rectAspectRange(corners, imgW, imgH, opts);
  if (!r) return null;
  const lo = r.lo * (1 - CORNER_SLACK), hi = Math.min(1, r.hi * (1 + CORNER_SLACK));
  const fits = ratio => ratio >= lo && ratio <= hi;
  const expected = short(sel.w / sel.h);
  const out = { measured: r.mid, expected, range: [lo, hi], known: r.known };
  if (fits(expected)) return { ...out, mismatch: false, suggestion: null };
  // Suggest only within the same group, so a Letter mismatch names a paper
  // size and never a banknote, and take the first fit in order of how common
  // the size is: A3, A4 and A5 differ in proportion only by millimetre
  // rounding, and the closest would let noise name A3 for an A4 sheet.
  const keys = Object.keys(sizes).sort((p, q) => {
    const ip = PREFER.indexOf(p), iq = PREFER.indexOf(q);
    return (ip < 0 ? 99 : ip) - (iq < 0 ? 99 : iq);
  });
  let suggestion = null;
  for (const k of keys) {
    const s = sizes[k];
    if (k === sizeKey || k === 'custom' || s.group !== sel.group) continue;
    if (fits(short(s.w / s.h))) { suggestion = k; break; }
  }
  return { ...out, mismatch: true, suggestion };
}
