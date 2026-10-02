// Finding several calibration sheets in one photo
// (docs/calibration_and_backlog_prd_v1.2.md, Part A phase 2, plan step 14).
//
// Seeds come from detectPaperRegions: every bright, sheet-sized component
// and every dark ring that could be a frame line, which is the whole-photo
// search that covers a white desk. Each seed is handed to the single-sheet
// recogniser, which gives up quietly on anything that is not a sheet, and
// each recognised sheet gets its own single-sheet fit so its frame can be
// placed in the photo. Two results whose frames overlap are one physical
// sheet read from two seeds (its paper and its window, say), and the better
// read is kept. Two results with the same identity whose frames do not
// overlap are two physical sheets from one print job, printed twice: both
// are kept, flagged, and the caller says to print a fresh set (criterion
// 22). Nothing here moves a corner or writes state.

import { detectPaperRegions } from './detectPaper.js';
import { recogniseSheet } from './calibDetect.js';
import { fitSheet } from './calibFit.js';
import { PAPER_SIZES } from './paperSizes.js';

export const FIND_DEFAULTS = {
  maxSeeds: 16,
  roughPaper: 'letter',   // the recogniser scales its profile geometry from this; a sheet's own identity replaces it
  minWords: 3,            // a sheet is found when this many words agree
  minSides: 2,            // on at least this many sides with a frame line
};

function quadArea(q) {
  let a = 0;
  for (let i = 0; i < 4; i++) { const p = q[i], r = q[(i + 1) % 4]; a += p.x * r.y - r.x * p.y; }
  return Math.abs(a) / 2;
}
function centroid(q) {
  return { x: (q[0].x + q[1].x + q[2].x + q[3].x) / 4, y: (q[0].y + q[1].y + q[2].y + q[3].y) / 4 };
}
export function pointInQuad(p, q) {
  let c = false;
  for (let i = 0, j = 3; i < 4; j = i++) {
    const a = q[i], b = q[j];
    if ((a.y > p.y) !== (b.y > p.y) && p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x) c = !c;
  }
  return c;
}

// The frame's outer rectangle in the photo, from a fit.
function frameQuad(fit) {
  const f = fit.geom.frame.outer;
  return [[f.x, f.y], [f.x + f.w, f.y], [f.x + f.w, f.y + f.h], [f.x, f.y + f.h]].map(([x, y]) => fit.designToPhoto({ x, y }));
}

// A seed cut by the photo's edge is only the visible part of its sheet, so
// its rough corners say the sheet is smaller than it is, and the recogniser,
// which takes the corners for the whole sheet, misplaces its rows. The
// visible part's own edges give the sheet's orientation (the longest hull
// edge that is not along the border), and across that orientation the
// visible extent is taken as a full side of the stock; along it the sheet
// is grown out across the border to the stock's aspect, both ways round
// since the scale is not known. Each guess is a seed of its own.
function cutSeeds(seed, iw, ih, stock) {
  const t = seed.touch || {};
  const hull = seed.hull || seed.corners;
  if (hull.length < 3) return [];
  const edge = 3;
  const onBorder = p => (t.left && p.x < edge) || (t.right && p.x > iw - edge) || (t.top && p.y < edge) || (t.bottom && p.y > ih - edge);
  let best = null;
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i], b = hull[(i + 1) % hull.length];
    if (onBorder(a) && onBorder(b)) continue;
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (!best || len > best.len) best = { len, th: Math.atan2(b.y - a.y, b.x - a.x) };
  }
  if (!best) return [];
  const c = Math.cos(best.th), sn = Math.sin(best.th);
  const rot = p => ({ a: p.x * c + p.y * sn, b: -p.x * sn + p.y * c });
  const unrot = q => ({ x: q.a * c - q.b * sn, y: q.a * sn + q.b * c });
  const pts = hull.map(rot);
  const a0 = Math.min(...pts.map(p => p.a)), a1 = Math.max(...pts.map(p => p.a));
  const b0 = Math.min(...pts.map(p => p.b)), b1 = Math.max(...pts.map(p => p.b));
  // The border's normal in the sheet's frame says which axis the cut
  // shortened; the border points say at which end.
  const nx = (t.right ? 1 : 0) - (t.left ? 1 : 0), ny = (t.bottom ? 1 : 0) - (t.top ? 1 : 0);
  const n = rot({ x: nx, y: ny });
  const cutAlong = Math.abs(n.a) >= Math.abs(n.b);
  const bp = hull.filter(onBorder).map(rot);
  if (!bp.length) return [];
  const mean = k => bp.reduce((x, p) => x + p[k], 0) / bp.length;
  const aspect = Math.max(stock.w, stock.h) / Math.min(stock.w, stock.h);
  const out = [];
  const full = cutAlong ? b1 - b0 : a1 - a0;          // the axis the cut left whole
  const shortExt = cutAlong ? a1 - a0 : b1 - b0;      // the visible extent of the cut axis
  for (const grown of [full * aspect, full / aspect]) {
    if (grown < shortExt * 0.95) continue;
    let na0 = a0, na1 = a1, nb0 = b0, nb1 = b1;
    if (cutAlong) {
      const atMax = Math.abs(mean('a') - a1) < Math.abs(mean('a') - a0);
      if (atMax) na1 = a0 + grown; else na0 = a1 - grown;
    } else {
      const atMax = Math.abs(mean('b') - b1) < Math.abs(mean('b') - b0);
      if (atMax) nb1 = b0 + grown; else nb0 = b1 - grown;
    }
    const q = [{ a: na0, b: nb0 }, { a: na1, b: nb0 }, { a: na1, b: nb1 }, { a: na0, b: nb1 }].map(unrot);
    out.push({ ...seed, corners: orderQuad(q), extended: true });
  }
  return out;
}

// TL, TR, BR, BL in the photo for four points in any order round a quad.
function orderQuad(q) {
  const cx = (q[0].x + q[1].x + q[2].x + q[3].x) / 4, cy = (q[0].y + q[1].y + q[2].y + q[3].y) / 4;
  const sorted = q.slice().sort((p, r) => Math.atan2(p.y - cy, p.x - cx) - Math.atan2(r.y - cy, r.x - cx));
  let tl = 0, bestS = Infinity;
  for (let i = 0; i < 4; i++) { const sc = (sorted[i].x - cx) + (sorted[i].y - cy); if (sc < bestS) { bestS = sc; tl = i; } }
  return [0, 1, 2, 3].map(i => sorted[(tl + i) % 4]);
}

// Recognise one seed. The rough paper is the picked stock in the seed's
// orientation: wider than tall in the photo reads as landscape.
function readSeed(image, seed, paperKey, k1, detectOpts) {
  const p = PAPER_SIZES[paperKey] || PAPER_SIZES.letter;
  const c = seed.corners;
  const wPx = (Math.hypot(c[1].x - c[0].x, c[1].y - c[0].y) + Math.hypot(c[2].x - c[3].x, c[2].y - c[3].y)) / 2;
  const hPx = (Math.hypot(c[3].x - c[0].x, c[3].y - c[0].y) + Math.hypot(c[2].x - c[1].x, c[2].y - c[1].y)) / 2;
  const portrait = { w: Math.min(p.w, p.h), h: Math.max(p.w, p.h) };
  const rough = wPx > hPx ? { w: portrait.h, h: portrait.w } : portrait;
  const iw = image.naturalWidth || image.width, ih = image.naturalHeight || image.height;
  let rec = null, fit = null;
  try {
    rec = recogniseSheet(image, c, rough, { k1, ...(detectOpts || {}) });
    if (rec && rec.ok) fit = fitSheet(rec, iw, ih);
  } catch (err) {
    return { ok: false, reason: String(err) };
  }
  if (!rec || !rec.ok) return { ok: false, reason: rec ? rec.reason : 'no result', sides: rec && rec.sides };
  if (!fit || !fit.ok) return { ok: false, reason: fit ? fit.reason : 'no fit', identity: rec.identity };
  const frame = frameQuad(fit);
  const sidesFound = (rec.lines || []).length;
  return {
    ok: true,
    identity: rec.identity, rotation: rec.rotation, words: rec.words.length, wordsRead: rec.wordsRead,
    rmsMm: fit.fit.rmsMm, k1: fit.k1, points: fit.fit.points, lines: fit.fit.lines,
    frame, centre: centroid(frame), area: quadArea(frame),
    sidesFound, partial: sidesFound < 4,
    rec, fit, seed: { kind: seed.kind, area: seed.area, extended: !!seed.extended },
  };
}

// Every sheet in the photo. opts.seeds replaces the region search (a test,
// or a person's own corners added to it); opts.extraSeeds are tried as well.
export function findSheets(image, opts = {}) {
  const o = { ...FIND_DEFAULTS, ...opts };
  const t0 = (typeof performance !== 'undefined' ? performance : Date).now();
  const k1 = Number(o.k1) || 0;
  let seeds = o.seeds || detectPaperRegions(image, o.regions || {});
  if (o.extraSeeds) seeds = [...o.extraSeeds.map(c => ({ kind: 'given', corners: c, area: 0 })), ...seeds];
  seeds = seeds.slice(0, o.maxSeeds);
  const iw = image.naturalWidth || image.width, ih = image.naturalHeight || image.height;
  // A read is a sheet when enough of it was read: one word on one side is
  // a glimpse, not a sheet, and its fit would place the frame anywhere.
  const strong = r => r.ok && r.words >= o.minWords && r.sidesFound >= o.minSides;
  const weaken = r => (r.ok && !strong(r) ? { ...r, ok: false, reason: `too little read: ${r.words} words on ${r.sidesFound} sides`, glimpse: r } : r);
  const reads = seeds.map(s => {
    const r = readSeed(image, s, o.roughPaper, k1);
    if (!s.touch || !(s.touch.left || s.touch.right || s.touch.top || s.touch.bottom)) return weaken(r);
    // Cut by the photo's edge: again from the visible part grown across the
    // border to the stock's shape, and the read with the most words wins.
    const p = PAPER_SIZES[o.roughPaper] || PAPER_SIZES.letter;
    let bestRead = r;
    for (const cs of cutSeeds(s, iw, ih, p)) {
      const r2 = readSeed(image, cs, o.roughPaper, k1, { dipWidthMm: [0.8, 4.5], cellWidthMm: [0.5, 3.5] });
      if (r2.ok && (!bestRead.ok || r2.words > bestRead.words)) bestRead = r2;
    }
    return weaken(bestRead);
  });
  const found = reads.filter(r => r.ok);
  // One physical sheet, read from two seeds: keep the better read.
  found.sort((a, b) => b.words - a.words || a.rmsMm - b.rmsMm);
  const sheets = [];
  for (const r of found) {
    const same = sheets.find(s => pointInQuad(r.centre, s.frame) || pointInQuad(s.centre, r.frame));
    if (same) { same.alsoFrom = (same.alsoFrom || 0) + 1; continue; }
    sheets.push(r);
  }
  // Two sheets with one identity: a set printed twice.
  const byId = new Map();
  for (const s of sheets) {
    const key = `${s.identity.job}:${s.identity.sheet}`;
    if (!byId.has(key)) byId.set(key, []);
    byId.get(key).push(s);
  }
  const duplicates = [];
  for (const [, list] of byId) {
    if (list.length < 2) continue;
    for (const s of list) s.duplicate = true;
    duplicates.push({ job: list[0].identity.job, sheet: list[0].identity.sheet, count: list.length });
  }
  // Left to right, top to bottom in the photo, for a stable listing.
  sheets.sort((a, b) => (a.centre.y - b.centre.y) || (a.centre.x - b.centre.x));
  const t1 = (typeof performance !== 'undefined' ? performance : Date).now();
  return {
    sheets, duplicates,
    seeds: { tried: seeds.length, kinds: seeds.map(s => s.kind), recognised: found.length },
    misses: reads.filter(r => !r.ok).map(r => r.reason),
    ms: t1 - t0,
  };
}

// One line for the panel: which sheets were found and what to do about
// duplicates.
export function describeFound(res) {
  if (!res || !res.sheets.length) return '';
  const jobs = new Map();
  for (const s of res.sheets) {
    const j = s.identity.job;
    if (!jobs.has(j)) jobs.set(j, []);
    jobs.get(j).push(s.identity.sheet);
  }
  const hex = j => j.toString(16).padStart(2, '0');
  const list = n => n.length === 1 ? String(n[0]) : n.slice(0, -1).join(', ') + ' and ' + n[n.length - 1];
  const parts = [...jobs.entries()].map(([j, nums]) => `sheet${nums.length > 1 ? 's' : ''} ${list(nums.slice().sort((a, b) => a - b))} of set ${hex(j)}`);
  let text = `${res.sheets.length} calibration sheet${res.sheets.length > 1 ? 's' : ''} in this photo: ${parts.join('; ')}.`;
  if (res.duplicates.length) {
    const d = res.duplicates.map(x => `sheet ${x.sheet} of set ${hex(x.job)} ${x.count} times`);
    text += ` ${list(d)}: a set printed twice is still two sheets, but print a fresh set so each has its own number.`;
  }
  const partial = res.sheets.filter(s => s.partial).length;
  if (partial) text += ` ${partial} ${partial > 1 ? 'are' : 'is'} partly out of the photo.`;
  return text;
}
