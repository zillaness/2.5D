// Copyright (C) 2026 Projects and Mods
// GPL-3.0-or-later WITH Commons Clause (non-commercial) - see LICENSE.

// Funny Looking Rock — key-decode UI. Ties the photo to js/keys/decode.js (read the
// bitting, with draggable datum + per-cut depth handles) and js/keys/keyMesh.js
// (build the printable key), previewing in Viewer3D and exporting an STL.
//
// Coordinates: handles live in IMAGE pixels; a fit transform maps image↔canvas.
// The decode works in mm (pxPerMm from the card-scale step).

import { BLANKS, getBlank, wardingFor, IN_TO_MM } from './blanks.js';
import { cutCentre, rootDepthForCode, codeRange } from './blanks.js';
import { decode, rootDepthMm, snapDepthMm, spacingMm } from './decode.js';
import { checkMACS } from './bitting.js';
import { buildKeyMesh, buildKeyMeshCSG, bowOutline } from './keyMesh.js';
import { getBowHoles } from './bows.js';
import { placeLoopsInBox } from './textpath.js';
import { initManifold, b64ToBytes } from './manifold-loader.js';
import { Viewer3D } from '../viewer3d.js';
import { toBinarySTL, downloadBlob } from '../exporters.js';
import { VERSION } from './version.js';

// Warm up the CSG engine as soon as the page loads (the single-file build inlines
// the wasm as a global). Falls back to the native weld if it can't load.
if (typeof window !== 'undefined' && window.__FLR_MANIFOLD_WASM) {
  try { initManifold(b64ToBytes(window.__FLR_MANIFOLD_WASM)); } catch { /* fall back */ }
}

const $ = (id) => document.getElementById(id);
const canvas = $('photo');
const ctx = canvas.getContext('2d');

const state = {
  img: null, sample: null,      // sample: {data,w,h} brightness source
  pxPerMm: null,
  shoulder: null, tip: null,     // image px
  blank: getBlank('SC1'), wardingId: null,
  overrides: {},                 // {position: code}
  decoded: null, mesh: null,
  drag: null, cardQuad: null,
  back: null, cutPts: null,       // green back-edge line [A,B] + red cut dots (image px)
  cardH: null,                    // image→mm homography from the card (skew correction)
  cardSize: 'cr80',               // which reference rectangle (see CARD_SIZES)
};

let viewer = null;

// ── setup ────────────────────────────────────────────────────────────────────
function initBlanks() {
  const sel = $('blankSel');
  sel.innerHTML = BLANKS.map(b => `<option value="${b.id}">${b.name}</option>`).join('');
  sel.value = 'SC1';
  sel.onchange = () => { state.blank = getBlank(sel.value); state.overrides = {}; state.manualScale = null; initWarding(); redecode(true); };
  initWarding();
}
function initWarding() {
  const f = $('wardingField'), sel = $('wardingSel');
  const opts = state.blank.wardingOptions || [];
  if (opts.length > 1) {
    f.hidden = false;
    sel.innerHTML = opts.map(w => `<option value="${w}">${w.split(':')[1].toUpperCase()}</option>`).join('');
    sel.value = state.blank.warding;
    sel.onchange = () => { state.wardingId = sel.value; };
    state.wardingId = state.blank.warding;
  } else { f.hidden = true; state.wardingId = null; }
}

function status(msg) { $('status').textContent = msg || ''; }

// ── image + fit transform ────────────────────────────────────────────────────
function loadImage(src) {
  const img = new Image();
  img.onload = () => {
    state.img = img;
    const off = document.createElement('canvas');
    off.width = img.naturalWidth; off.height = img.naturalHeight;
    const octx = off.getContext('2d', { willReadFrequently: true });
    octx.drawImage(img, 0, 0);
    const id = octx.getImageData(0, 0, off.width, off.height);
    state.sample = { data: id.data, w: off.width, h: off.height };
    fitCanvas();
    autoPlace();
    redecode(true);
    const pt = $('photoTools'); if (pt) pt.hidden = false;
    status('Adjust the shoulder/tip if needed, then confirm/drag the cut depths.');
  };
  img.src = src;
}

// Rotate 90° CW / mirror (left–right) / flip (top–bottom) the working image.
// Re-renders the pixels so the whole pipeline (auto-place, sampling, decode)
// just works in the new orientation. Orientation change resets the card box; the
// mm scale is orientation-invariant, so a set scale is kept.
function transformImage(kind) {
  if (!state.img) return;
  const iw = state.img.naturalWidth, ih = state.img.naturalHeight;
  const c = document.createElement('canvas'), g = c.getContext('2d');
  if (kind === 'rot') { c.width = ih; c.height = iw; g.translate(ih, 0); g.rotate(Math.PI / 2); }
  else if (kind === 'mirror') { c.width = iw; c.height = ih; g.translate(iw, 0); g.scale(-1, 1); }
  else { c.width = iw; c.height = ih; g.translate(0, ih); g.scale(1, -1); } // flip
  g.drawImage(state.img, 0, 0);
  state.cardQuad = null; state.cardH = null;
  loadImage(c.toDataURL('image/png'));
}

function fitCanvas() {
  const r = canvas.parentElement.getBoundingClientRect();
  canvas.width = Math.max(2, Math.floor(r.width));
  canvas.height = Math.max(2, Math.floor(r.height));
  const img = state.img;
  const s = Math.min(canvas.width / img.naturalWidth, canvas.height / img.naturalHeight);
  state.view = { s, ox: (canvas.width - img.naturalWidth * s) / 2, oy: (canvas.height - img.naturalHeight * s) / 2 };
}
const toCanvas = (p) => ({ x: state.view.ox + p.x * state.view.s, y: state.view.oy + p.y * state.view.s });
const toImage = (p) => ({ x: (p.x - state.view.ox) / state.view.s, y: (p.y - state.view.oy) / state.view.s });

// ── brightness sampling (brass/nickel key on a dark card) ────────────────────
function bright(x, y) {
  const { data, w, h } = state.sample;
  x |= 0; y |= 0;
  if (x < 0 || y < 0 || x >= w || y >= h) return false;
  const i = (y * w + x) * 4;
  const R = data[i], G = data[i + 1], B = data[i + 2];
  const v = Math.max(R, G, B);
  return v > 105 && ((R + G) / 2 - B > 18 || v > 150); // gold, or generally bright
}

// ── auto-place shoulder/tip from the silhouette ──────────────────────────────
function autoPlace() {
  const { w, h } = state.sample;
  // bright bbox + centroid (coarse; user refines)
  let minx = w, maxx = 0, miny = h, maxy = 0, n = 0, cx = 0, cy = 0;
  const step = Math.max(1, Math.floor(Math.max(w, h) / 600));
  for (let y = 0; y < h; y += step) for (let x = 0; x < w; x += step)
    if (bright(x, y)) { minx = Math.min(minx, x); maxx = Math.max(maxx, x); miny = Math.min(miny, y); maxy = Math.max(maxy, y); cx += x; cy += y; n++; }
  if (!n) { state.shoulder = { x: w * 0.6, y: h / 2 }; state.tip = { x: w * 0.2, y: h / 2 }; return; }
  cx /= n; cy /= n;
  const horizontal = (maxx - minx) >= (maxy - miny);
  // height profile along the long axis to find bow (wide) vs blade, shoulder = transition
  const along = horizontal ? maxx - minx : maxy - miny;
  const bins = 60, prof = new Array(bins).fill(0);
  for (let b = 0; b < bins; b++) {
    const t = minx + (horizontal ? (b / bins) * (maxx - minx) : 0);
    let lo = 1e9, hi = -1e9;
    for (let k = 0; k < (horizontal ? (maxy - miny) : (maxx - minx)); k += step) {
      const x = horizontal ? Math.round(minx + (b / bins) * (maxx - minx)) : Math.round(minx + k);
      const y = horizontal ? Math.round(miny + k) : Math.round(miny + (b / bins) * (maxy - miny));
      if (bright(x, y)) { lo = Math.min(lo, horizontal ? y : x); hi = Math.max(hi, horizontal ? y : x); }
    }
    prof[b] = hi > lo ? hi - lo : 0;
  }
  const hmax = Math.max(...prof);
  // blade = contiguous low-height run from one end; the wide end is the bow
  const leftWide = prof.slice(0, 8).reduce((a, b) => a + b, 0) > prof.slice(-8).reduce((a, b) => a + b, 0);
  const bowAtMax = leftWide;  // bow at the min-coordinate end?
  const p0 = { x: minx, y: cy }, p1 = { x: maxx, y: cy };
  // shoulder ~ where height first exceeds 1.4× blade level from the blade end
  const bladeLvl = median(prof.filter(v => v > 0 && v < 0.6 * hmax));
  let shb = bowAtMax ? bins - 1 : 0; const dirb = bowAtMax ? -1 : 1;
  for (let b = bowAtMax ? bins - 1 : 0; b >= 0 && b < bins; b += dirb)
    if (prof[b] > 1.4 * bladeLvl) { shb = b; break; }
  // Tip is the end OPPOSITE the bow. bowAtMax means the bow sits at the min
  // coordinate, so the tip is at the max end (and vice-versa).
  if (horizontal) {
    state.shoulder = { x: minx + (shb / bins) * (maxx - minx), y: cy };
    state.tip = { y: cy, x: bowAtMax ? maxx - 2 * step : minx + 2 * step };
  } else {
    state.shoulder = { x: cx, y: miny + (shb / bins) * (maxy - miny) };
    state.tip = { x: cx, y: bowAtMax ? maxy - 2 * step : miny + 2 * step };
  }
}
const median = (a) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };

// ── shape-based bow detection (classical CV, no ML) ──────────────────────────
// Find the BOW (the head you grip) straight from the silhouette, so orientation
// sets itself. Two cues, strongest first, both on a downsampled pixel mask:
//   1. Keyring hole — the bow is the one part of a key with an enclosed hole.
//      Flood-fill the background inward from the image border; any non-key region
//      the fill can't reach is enclosed → the ring hole. Whichever end holds it
//      is unambiguously the bow. (A hole is bow-specific, so this beats "is there
//      bright stuff past the end", which glare or a finger can fake.)
//   2. Principal-axis width — if no hole is visible, take the key's long axis from
//      image moments (no user trace needed) and walk it: the wide blobby end is
//      the bow, the thin notched end is the blade.
// Returns the bow centroid in IMAGE px (+ which cue fired), or null if unsure.
// Everything is pixel arithmetic on state.sample — offline, in the standalone file.
function detectBow() {
  const S = state.sample; if (!S) return null;
  const { w, h } = S;
  const step = Math.max(1, Math.ceil(Math.max(w, h) / 360));   // work on a ~360px grid
  const half = step >> 1;
  const gw = Math.ceil(w / step), gh = Math.ceil(h / step), N = gw * gh;
  const toImg = (gx, gy) => ({ x: gx * step + half, y: gy * step + half });
  const mask = new Uint8Array(N);                              // 1 = key material
  let keyN = 0;
  for (let gy = 0; gy < gh; gy++) for (let gx = 0; gx < gw; gx++)
    if (bright(gx * step + half, gy * step + half)) { mask[gy * gw + gx] = 1; keyN++; }
  if (keyN < 20) return null;

  // 1 · keyring hole = background NOT reachable from the border.
  const bg = new Uint8Array(N), stack = [];
  for (let gx = 0; gx < gw; gx++) { stack.push(gx, (gh - 1) * gw + gx); }
  for (let gy = 0; gy < gh; gy++) { stack.push(gy * gw, gy * gw + gw - 1); }
  while (stack.length) {
    const i = stack.pop(); if (bg[i] || mask[i]) continue; bg[i] = 1;
    const x = i % gw, y = (i / gw) | 0;
    if (x > 0) stack.push(i - 1); if (x < gw - 1) stack.push(i + 1);
    if (y > 0) stack.push(i - gw); if (y < gh - 1) stack.push(i + gw);
  }
  const seen = new Uint8Array(N); let bestHole = null;         // largest enclosed region
  for (let i0 = 0; i0 < N; i0++) {
    if (mask[i0] || bg[i0] || seen[i0]) continue;
    let cx = 0, cy = 0, cnt = 0; const q = [i0]; seen[i0] = 1;
    while (q.length) {
      const j = q.pop(), x = j % gw, y = (j / gw) | 0; cx += x; cy += y; cnt++;
      const nb = [x > 0 ? j - 1 : -1, x < gw - 1 ? j + 1 : -1, y > 0 ? j - gw : -1, y < gh - 1 ? j + gw : -1];
      for (const k of nb) if (k >= 0 && !mask[k] && !bg[k] && !seen[k]) { seen[k] = 1; q.push(k); }
    }
    if (!bestHole || cnt > bestHole.cnt) bestHole = { gx: cx / cnt, gy: cy / cnt, cnt };
  }
  if (bestHole && bestHole.cnt >= Math.max(4, keyN * 0.004))   // real ring hole, not a speck/glare gap
    return { ...toImg(bestHole.gx, bestHole.gy), method: 'hole' };

  // 2 · principal-axis width: the wide end is the bow.
  let mx = 0, my = 0;
  for (let i = 0; i < N; i++) if (mask[i]) { mx += i % gw; my += (i / gw) | 0; }
  mx /= keyN; my /= keyN;
  let sxx = 0, sxy = 0, syy = 0;
  for (let i = 0; i < N; i++) if (mask[i]) { const dx = (i % gw) - mx, dy = ((i / gw) | 0) - my; sxx += dx * dx; sxy += dx * dy; syy += dy * dy; }
  const tr = sxx + syy, l1 = tr / 2 + Math.sqrt(Math.max(0, tr * tr / 4 - (sxx * syy - sxy * sxy)));
  let ax, ay;                                                  // major-axis unit vector
  if (Math.abs(sxy) > 1e-6) { ax = l1 - syy; ay = sxy; } else { ax = sxx >= syy ? 1 : 0; ay = sxx >= syy ? 0 : 1; }
  const al = Math.hypot(ax, ay) || 1; ax /= al; ay /= al;
  const pts = []; let tmin = Infinity, tmax = -Infinity;
  for (let i = 0; i < N; i++) if (mask[i]) {
    const dx = (i % gw) - mx, dy = ((i / gw) | 0) - my, t = dx * ax + dy * ay, p = -dx * ay + dy * ax;
    pts.push({ i, t, p }); if (t < tmin) tmin = t; if (t > tmax) tmax = t;
  }
  const span = (tmax - tmin) || 1, BIN = 24;
  const lo = new Array(BIN).fill(Infinity), hi = new Array(BIN).fill(-Infinity);
  for (const q of pts) { const b = Math.min(BIN - 1, Math.floor((q.t - tmin) / span * BIN)); if (q.p < lo[b]) lo[b] = q.p; if (q.p > hi[b]) hi[b] = q.p; }
  const wAt = (b) => (hi[b] > lo[b] ? hi[b] - lo[b] : 0);
  let wLow = 0, wHigh = 0, K = 4;
  for (let b = 0; b < K; b++) wLow += wAt(b);
  for (let b = BIN - K; b < BIN; b++) wHigh += wAt(b);
  const bowAtLow = wLow > wHigh, cut = bowAtLow ? tmin + 0.2 * span : tmax - 0.2 * span;
  let bx = 0, by = 0, bn = 0;
  for (const q of pts) if (bowAtLow ? q.t <= cut : q.t >= cut) { bx += q.i % gw; by += (q.i / gw) | 0; bn++; }
  if (!bn) return null;
  return { ...toImg(bx / bn, by / bn), method: 'pca' };
}

// ── build the blade profile along the current axis ───────────────────────────
// Scan perpendicular to the shoulder→tip axis; the bright extent at each step is
// the blade height there. Self-calibrate the mm scale from the uncut blade height
// (a known blank dimension), so depths don't depend on a perfect card scale, and
// register the cuts to the ACTUAL valleys (robust to perspective drift).
function reprofile() {
  state.profile = null; state.cutUs = null;
  if (!state.shoulder || !state.tip || !state.sample) return false;
  const spec = state.blank.spec, o = state.shoulder, t = state.tip;
  const dx = t.x - o.x, dy = t.y - o.y, L = Math.hypot(dx, dy) || 1;
  const d = { x: dx / L, y: dy / L }, n = { x: -dy / L, y: dx / L };
  const at = (up) => ({ px: o.x + up * d.x, py: o.y + up * d.y });
  const centre = (px, py) => { const on = (k) => bright(px + k * n.x, py + k * n.y); if (on(0)) return 0; for (let s = 1; s <= 60; s++) { if (on(s)) return s; if (on(-s)) return -s; } return null; };
  // Two passes. Pass 1: bright run through the axis centre (gap-bridged) → a rough
  // scale. Pass 2: min/max within a TIGHT span (~1.2× the blade height) — wide
  // enough to span the warding groove, tight enough to exclude the far card
  // scratches and the wood.
  const uncutOf = (raw) => {
    const mid = raw.filter(r => r.up > 0.12 * L && r.up < 0.95 * L).map(r => r.ext).sort((a, b) => a - b);
    const src = mid.length > 5 ? mid : raw.map(r => r.ext).sort((a, b) => a - b);
    return src[Math.floor(src.length * 0.85)] || 1;
  };
  const rough = [];
  for (let up = 0; up <= L; up++) {
    const { px, py } = at(up), on = (k) => bright(px + k * n.x, py + k * n.y);
    const cen = centre(px, py); if (cen === null) continue;
    let hi = cen, lo = cen;
    for (let k = cen + 1, g = 0; k <= L * 0.4; k++) { if (on(k)) { hi = k; g = 0; } else if (++g > 40) break; }
    for (let k = cen - 1, g = 0; k >= -L * 0.4; k--) { if (on(k)) { lo = k; g = 0; } else if (++g > 40) break; }
    rough.push({ up, ext: hi - lo });
  }
  if (rough.length < 5) return false;
  state.axis = { o, d, n };
  const px0 = (state.manualScale || uncutOf(rough) / (spec.bladeHeight * IN_TO_MM));
  const tight = spec.bladeHeight * IN_TO_MM * px0 * 0.62; // half-height × 1.24
  const raw = [];
  for (let up = 0; up <= L; up++) {
    const { px, py } = at(up), on = (k) => bright(px + k * n.x, py + k * n.y);
    const cen = centre(px, py); if (cen === null) continue;
    let lo = null, hi = null;
    for (let k = cen - tight; k <= cen + tight; k++) if (on(k)) { if (lo === null) lo = k; hi = k; }
    if (lo !== null) raw.push({ up, lo, hi, ext: hi - lo });
  }
  if (raw.length < 5) return false;
  const uncutPx = uncutOf(raw);
  const pxPerMm = state.manualScale || uncutPx / (spec.bladeHeight * IN_TO_MM);
  state.pxPerMm = pxPerMm;
  $('scaleReadout').textContent = `${pxPerMm.toFixed(2)} px/mm` + (state.manualScale ? '' : ' (auto)');
  state.profile = raw.map(r => ({ u: r.up / pxPerMm, h: r.ext / pxPerMm }));

  // Initialise the draggable handles (the user then adjusts):
  //  · back-edge line = the STRAIGHT side of the blade (smaller spread) → depth 0
  //  · one cut dot per position, dropped on the milled edge at the nearest valley
  const his = raw.map(r => r.hi), los = raw.map(r => r.lo);
  const backIsHi = spread(his) < spread(los);
  // Fit the back line to the ACTUAL detected back-edge points (not parallel to the
  // bow-tilted axis) so it — and the shoulder line square to it — line up.
  const bpts = raw.map(r => {
    const off = backIsHi ? r.hi : r.lo;
    return { x: o.x + d.x * r.up + n.x * off, y: o.y + d.y * r.up + n.y * off };
  });
  const avg = (arr) => ({ x: arr.reduce((s, p) => s + p.x, 0) / arr.length, y: arr.reduce((s, p) => s + p.y, 0) / arr.length });
  const kk = Math.max(3, Math.floor(bpts.length * 0.15));
  state.back = [avg(bpts.slice(0, kk)), avg(bpts.slice(-kk))];
  // Orient the back line so back[0] is the BOW end (position 1). A backwards
  // green line silently reverses the whole bitting → a wrong key that still
  // looks plausible, so anchor the default on real evidence. Primary: shape-based
  // bow detection (keyring hole, else the silhouette's wide end) — put back[0] at
  // whichever end is nearest the detected bow. Fallback: sample past each blade
  // end for key material. (The Flip button stays as the manual override.)
  const d2 = (p, b) => (p.x - b.x) ** 2 + (p.y - b.y) ** 2;
  const bow = detectBow();
  if (bow) {
    if (d2(state.back[1], bow) < d2(state.back[0], bow)) state.back.reverse();
  } else {
    const bowScore = (dir) => {                      // dir +1 past back[1], -1 past back[0]
      const baseUp = dir > 0 ? L : 0; let hits = 0, tot = 0;
      for (let s = 5; s <= 45; s += 2) {
        const p = at(baseUp + dir * s);
        for (let k = -tight * 1.6; k <= tight * 1.6; k += 2) { tot++; if (bright(p.px + k * n.x, p.py + k * n.y)) hits++; }
      }
      return tot ? hits / tot : 0;
    };
    if (bowScore(1) > bowScore(-1) + 0.15) state.back.reverse();
  }
  const edgeAtPx = (upPx) => {                       // milled-edge offset near up
    let best = null, bd = Infinity;
    for (const r of raw) { const dd = Math.abs(r.up - upPx); if (dd < bd) { bd = dd; best = r; } }
    return best ? (backIsHi ? best.lo : best.hi) : 0;
  };
  state.cutPts = [];
  for (let i = 0; i < spec.positions; i++) {
    const u0 = cutCentre(spec, i) * IN_TO_MM;
    const uPx = nearestValleyU(state.profile, u0, spacingMm(spec) * 0.45) * pxPerMm;
    const e = edgeAtPx(uPx);
    state.cutPts.push({ x: o.x + d.x * uPx + n.x * e, y: o.y + d.y * uPx + n.y * e });
  }
  // If the detected blade is implausibly short (faint/garbage detection), the
  // cuts would pile up — bail to the spaced fallback instead.
  const spanPx = cutCentre(spec, spec.positions - 1) * IN_TO_MM * pxPerMm;
  if (spanPx < 40) return false;
  return true;
}

// Fallback layout when the key can't be seen (worn/gray keys don't register as
// "bright"): lay the handles out at the blank's REAL cut spacing (using the card
// scale) centred in the card, so the user just nudges each line onto its cut
// instead of un-stacking a pile of dots.
function placeDefaultHandles() {
  const spec = state.blank.spec;
  const px = state.manualScale || (state.sample ? state.sample.w / 110 : 8);
  state.pxPerMm = px;
  let cx, cy;
  if (state.cardQuad) {
    const q = state.cardQuad;
    cx = (q[0].x + q[1].x + q[2].x + q[3].x) / 4;
    cy = (q[0].y + q[1].y + q[2].y + q[3].y) / 4;
  } else { cx = (state.sample ? state.sample.w : 1000) / 2; cy = (state.sample ? state.sample.h : 600) / 2; }
  const firstU = cutCentre(spec, 0) * IN_TO_MM, lastU = cutCentre(spec, spec.positions - 1) * IN_TO_MM;
  const shoulderX = cx - ((firstU + lastU) / 2) * px;          // centre the cut span on the card
  const tipX = shoulderX + (lastU + spacingMm(spec) * 2) * px;
  state.shoulder = { x: shoulderX, y: cy };
  state.tip = { x: tipX, y: cy };
  const backY = cy + spec.bladeHeight * IN_TO_MM * 0.5 * px;    // cuts up, back below
  state.back = [{ x: shoulderX, y: backY }, { x: tipX, y: backY }];
  const [lo, hi] = codeRange(spec);
  const depthPx = rootDepthMm(spec, Math.round((lo + hi) / 2)) * px;
  state.cutPts = [];
  for (let i = 0; i < spec.positions; i++)
    state.cutPts.push({ x: shoulderX + cutCentre(spec, i) * IN_TO_MM * px, y: backY - depthPx });
  status('Couldn’t auto-see the key — lines laid out at the blank spacing. Set the card scale, then drag each onto its cut.');
}
function spread(a) { const m = a.reduce((s, v) => s + v, 0) / a.length; return Math.sqrt(a.reduce((s, v) => s + (v - m) * (v - m), 0) / a.length); }
// u of the deepest profile sample within ±win of u0 (falls back to u0 if empty).
function nearestValleyU(profile, u0, win) {
  let best = null, bh = Infinity;
  for (const p of profile) {
    if (p.u < u0 - win || p.u > u0 + win) continue;
    if (p.h < bh) { bh = p.h; best = p.u; }
  }
  return best == null ? u0 : best;
}

// Decode straight from the on-screen handles (the manual tracer): each cut dot's
// perpendicular distance to the green back line IS its depth; order along the
// back line gives bow→tip. No dependence on the fragile auto valley search.
function decodeFromHandles() {
  const spec = state.blank.spec;
  if (!state.back || !state.cutPts) { state.decoded = null; showBitting(); return; }
  // If the card is set, map every handle through the homography into true mm
  // (perspective skew removed) and measure there — distances are already mm, so
  // pxPerMm = 1. Otherwise stay in image px and self-calibrate from the cuts.
  const H = state.cardH;
  const tf = H ? (p) => applyH(H, p) : (p) => ({ x: p.x, y: p.y });
  const A = tf(state.back[0]), B = tf(state.back[1]);
  const dl = { x: B.x - A.x, y: B.y - A.y }, Ll = Math.hypot(dl.x, dl.y) || 1;
  const du = { x: dl.x / Ll, y: dl.y / Ll }, nb = { x: -du.y, y: du.x };
  const along = (P) => (P.x - A.x) * du.x + (P.y - A.y) * du.y;
  // keep each cut's original image point (for drawing) alongside its mapped point
  const ordered = state.cutPts.map((orig) => ({ orig, P: tf(orig) })).sort((a, b) => along(a.P) - along(b.P));

  let pxPerMm = 1, scaleSrc = 'card (skew-corrected)';
  if (!H) {
    pxPerMm = state.manualScale; scaleSrc = 'card';
    if (!pxPerMm) {                                    // self-calibrate from the cut spacing
      const xs = ordered.map(o => along(o.P));
      const ms = ordered.map((_, i) => cutCentre(spec, i) * IN_TO_MM);
      const n = xs.length, mx = xs.reduce((s, v) => s + v, 0) / n, mm = ms.reduce((s, v) => s + v, 0) / n;
      let cov = 0, varm = 0;
      for (let i = 0; i < n; i++) { cov += (xs[i] - mx) * (ms[i] - mm); varm += (ms[i] - mm) ** 2; }
      pxPerMm = varm > 0 ? Math.abs(cov / varm) : state.pxPerMm;
      scaleSrc = 'from cuts';
    }
  }
  if (!pxPerMm || pxPerMm <= 0) { state.decoded = null; showBitting(); return; }
  state.pxPerMm = pxPerMm;
  const el = $('scaleReadout'); if (el) el.textContent = H ? `card (skew-corrected)` : `${pxPerMm.toFixed(2)} px/mm (${scaleSrc})`;
  const cuts = ordered.map(({ orig, P }, i) => {
    const depthMm = Math.abs((P.x - A.x) * nb.x + (P.y - A.y) * nb.y) / pxPerMm;
    const snap = snapDepthMm(spec, depthMm);
    return { i, u: along(P) / pxPerMm, depthMm, code: snap.code, residual: snap.residual, overridden: false, pt: orig };
  });
  const code = cuts.map(c => c.code);
  const halfStep = 0.5 * spec.depthStep * IN_TO_MM;
  state.decoded = {
    code, cuts, macs: checkMACS(spec, code),
    ambiguous: cuts.filter(c => c.residual > 0.7 * halfStep).map(c => c.i), fromHandles: true,
  };
  showBitting();
}

function redecode(reprof = false) {
  if (reprof) { if (!reprofile()) placeDefaultHandles(); }
  decodeFromHandles();
  $('genBtn').disabled = !state.decoded;
  draw();
}

function showBitting() {
  const d = state.decoded;
  $('bittingOut').textContent = d ? d.code.join('-') : '—';
  const m = $('macsOut');
  if (d) { m.textContent = d.macs.ok ? 'MACS ok' : `MACS violation (${d.macs.violations.length})`; m.className = 'macs ' + (d.macs.ok ? 'ok' : 'bad'); }
  else m.textContent = '';
  $('ambigOut').textContent = d && d.ambiguous.length
    ? `Uncertain: position ${d.ambiguous.map(i => i + 1).join(', ')} — drag its depth to confirm` : '';
}

// ── overlay drawing ──────────────────────────────────────────────────────────
function draw() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (!state.img) return;
  ctx.drawImage(state.img, state.view.ox, state.view.oy, state.img.naturalWidth * state.view.s, state.img.naturalHeight * state.view.s);
  if (state.cardQuad) {
    const c = state.cardQuad.map(toCanvas);
    ctx.strokeStyle = '#37b6ff'; ctx.lineWidth = 2; ctx.setLineDash([6, 4]);
    ctx.beginPath(); ctx.moveTo(c[0].x, c[0].y);
    for (let i = 1; i < 4; i++) ctx.lineTo(c[i].x, c[i].y);
    ctx.closePath(); ctx.stroke(); ctx.setLineDash([]);
    for (const p of c) dot(p, '#37b6ff', 7);
    // edge-midpoint handles: drag an edge to slide it onto the card's straight side
    for (let i = 0; i < 4; i++) {
      const a = c[i], b = c[(i + 1) % 4], m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      ctx.fillStyle = '#7fc0ff'; ctx.fillRect(m.x - 4, m.y - 4, 8, 8);
    }
    label(c[0], 'card · line up the edges');
  }
  if (!state.back) return;
  // Direction along the blade comes from the (draggable) back edge — the reliable
  // straight reference. (The shoulder is no longer a datum; the decode measures
  // from the back edge + cut spacing.)
  const [bA, bB] = state.back, bdl = { x: bB.x - bA.x, y: bB.y - bA.y }, bLl = Math.hypot(bdl.x, bdl.y) || 1;
  const du = { x: bdl.x / bLl, y: bdl.y / bLl };
  // back-edge line (green) — the depth-zero datum
  {
    const a = toCanvas(state.back[0]), b = toCanvas(state.back[1]);
    line(a, b, '#4ec98a', 3);
    dot(a, '#4ec98a', 6); dot(b, '#4ec98a', 6);
    // arrowhead at back[1] — the TIP end. The bitting is read from the bow end
    // (back[0]) toward the tip (arrow). If it's pointing the wrong way, Flip.
    const ang = Math.atan2(b.y - a.y, b.x - a.x), ah = 13;
    line(b, { x: b.x - ah * Math.cos(ang - 0.5), y: b.y - ah * Math.sin(ang - 0.5) }, '#4ec98a', 3);
    line(b, { x: b.x - ah * Math.cos(ang + 0.5), y: b.y - ah * Math.sin(ang + 0.5) }, '#4ec98a', 3);
    label(a, 'back edge');
    label(b, 'tip →');
  }
  // cut handles: a thin height line (parallel to the blade) at each valley, with
  // a faint drop line to the back edge — so the key stays visible underneath.
  if (state.decoded && state.decoded.fromHandles && state.back) {
    const [A] = state.back;
    for (const cut of state.decoded.cuts) {
      const cp = toCanvas(cut.pt);
      const tp = (cut.pt.x - A.x) * du.x + (cut.pt.y - A.y) * du.y;   // foot on back line
      const cf = toCanvas({ x: A.x + du.x * tp, y: A.y + du.y * tp });
      const col = state.decoded.ambiguous.includes(cut.i) ? '#ffcc33' : '#ff5b5b';
      line(cf, cp, 'rgba(255,120,120,0.35)', 1);                     // faint depth drop
      const hw = 14;                                                 // half-length px
      line({ x: cp.x - du.x * hw, y: cp.y - du.y * hw }, { x: cp.x + du.x * hw, y: cp.y + du.y * hw }, col, 2.5);
      label({ x: cp.x + hw - 2, y: cp.y - 4 }, String(cut.code));
    }
  }
}
function line(a, b, col, w) { ctx.strokeStyle = col; ctx.lineWidth = w; ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke(); }
function dot(p, col, r) { ctx.fillStyle = col; ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, 7); ctx.fill(); }
function tick(p, n, len, col) { ctx.strokeStyle = col; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(p.x - n.y * len, p.y + n.x * len); ctx.lineTo(p.x + n.y * len, p.y - n.x * len); ctx.stroke(); }
function label(p, s) { ctx.fillStyle = '#fff'; ctx.font = 'bold 14px monospace'; ctx.fillText(s, p.x + 8, p.y - 8); }

// ── interaction ──────────────────────────────────────────────────────────────
function hit(p, target) { const c = toCanvas(target); return Math.hypot(c.x - p.x, c.y - p.y) < 14; }
canvas.addEventListener('pointerdown', (e) => {
  const p = { x: e.offsetX, y: e.offsetY };
  if (state.cardQuad) {                    // card corner, then card edge-midpoint
    for (let i = 0; i < 4; i++) if (hit(p, state.cardQuad[i])) { state.drag = { kind: 'card', idx: i }; return; }
    for (let i = 0; i < 4; i++) {
      const a = state.cardQuad[i], b = state.cardQuad[(i + 1) % 4];
      if (hit(p, { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 })) { state.drag = { kind: 'cardEdge', idx: i, last: toImage(p) }; return; }
    }
  }
  // cut dots first (they sit on top), then the back-line ends, then shoulder/tip
  if (state.cutPts) { for (let i = 0; i < state.cutPts.length; i++) if (hit(p, state.cutPts[i])) { state.drag = { kind: 'cut', idx: i }; return; } }
  if (state.back) { for (let i = 0; i < 2; i++) if (hit(p, state.back[i])) { state.drag = { kind: 'back', idx: i }; return; } }
  // empty space → pan the view
  if (state.img) state.drag = { kind: 'pan', sx: e.offsetX, sy: e.offsetY, ox: state.view.ox, oy: state.view.oy };
});
canvas.addEventListener('pointermove', (e) => {
  if (!state.drag) return;
  if (state.drag.kind === 'pan') {
    state.view.ox = state.drag.ox + (e.offsetX - state.drag.sx);
    state.view.oy = state.drag.oy + (e.offsetY - state.drag.sy);
    draw(); return;
  }
  const p = toImage({ x: e.offsetX, y: e.offsetY });
  if (state.drag.kind === 'cardEdge') {          // translate the whole edge (both corners)
    const d = { x: p.x - state.drag.last.x, y: p.y - state.drag.last.y }, i = state.drag.idx, j = (i + 1) % 4;
    state.cardQuad[i] = { x: state.cardQuad[i].x + d.x, y: state.cardQuad[i].y + d.y };
    state.cardQuad[j] = { x: state.cardQuad[j].x + d.x, y: state.cardQuad[j].y + d.y };
    state.drag.last = p; applyCardScale(); draw(); return;
  }
  if (state.drag.kind === 'card') { state.cardQuad[state.drag.idx] = p; applyCardScale(); draw(); return; }
  if (state.drag.kind === 'cut') { state.cutPts[state.drag.idx] = p; decodeFromHandles(); draw(); return; }
  if (state.drag.kind === 'back') { state.back[state.drag.idx] = p; decodeFromHandles(); draw(); return; }
  if (state.drag.kind === 'shoulder') state.shoulder = p;
  else if (state.drag.kind === 'tip') state.tip = p;
  draw();
});
window.addEventListener('pointerup', () => { state.drag = null; });
// Scroll to zoom, centred on the cursor.
canvas.addEventListener('wheel', (e) => {
  if (!state.img) return;
  e.preventDefault();
  const f = e.deltaY < 0 ? 1.12 : 1 / 1.12;
  const ns = Math.max(0.05, Math.min(40, state.view.s * f));
  const wx = (e.offsetX - state.view.ox) / state.view.s, wy = (e.offsetY - state.view.oy) / state.view.s;
  state.view.s = ns;
  state.view.ox = e.offsetX - wx * ns;
  state.view.oy = e.offsetY - wy * ns;
  draw();
}, { passive: false });

// ── scale (align the card's four corners) ─────────────────────────────────────
// A CR80 card is 85.60 × 53.98 mm. Drag its four corners onto the card in the
// photo; the known edge lengths set px/mm. All in-page (no prompt(), which is
// blocked in the sandboxed artifact iframe).
// Standard ID-card-family reference rectangles (mm). The known real dimensions
// are what let the 4 corners correct scale AND perspective skew (homography).
const CARD_SIZES = {
  cr80:  { long: 85.60, short: 53.98 },   // credit / ID card (ISO ID-1)
  cr79:  { long: 83.90, short: 51.00 },   // insert card
  cr100: { long: 98.50, short: 67.00 },   // oversized badge
  poker: { long: 88.90, short: 63.50 },   // 3.5×2.5 in playing / trading card
  half:  { long: 53.98, short: 42.80 },   // ½ CR80 key tag
  third: { long: 53.98, short: 28.53 },   // ⅓ CR80 key tag
};
const cardDims = () => CARD_SIZES[state.cardSize || 'cr80'];
$('scaleBtn').onclick = () => {
  if (!state.img) { status('Load a photo first.'); return; }
  const auto = detectCardQuad();
  if (auto) {
    state.cardQuad = auto;
    status('Card detected — line up the box edges with the card’s straight sides (drag an edge or corner).');
  } else {
    const { w, h } = state.sample, cd = cardDims();
    const cw = w * 0.6, ch = cw * (cd.short / cd.long);
    const x0 = (w - cw) / 2, y0 = (h - ch) / 2;
    state.cardQuad = [{ x: x0, y: y0 }, { x: x0 + cw, y: y0 }, { x: x0 + cw, y: y0 + ch }, { x: x0, y: y0 + ch }];
    status('Drag the 4 corners onto the card’s corners. Scale updates as you drag.');
  }
  applyCardScale();
  draw();
};

// Auto-find the card: the card is a large rectangle of one tone on a background
// of another (dark card on lighter wood, or vice-versa). Otsu-threshold the
// luminance, take the class that is NOT the border (background) tone, and read
// the convex quad's four extreme corners (works for a rotated/skewed card too).
function detectCardQuad() {
  const { data, w, h } = state.sample;
  const step = Math.max(1, Math.floor(Math.max(w, h) / 320));
  const pts = [], hist = new Array(256).fill(0);
  for (let y = 0; y < h; y += step) for (let x = 0; x < w; x += step) {
    const i = (y * w + x) * 4;
    const L = (data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114) | 0;
    pts.push({ x, y, L }); hist[L]++;
  }
  const total = pts.length;
  // Otsu threshold
  let sum = 0; for (let t = 0; t < 256; t++) sum += t * hist[t];
  let sumB = 0, wB = 0, maxVar = -1, thr = 127;
  for (let t = 0; t < 256; t++) {
    wB += hist[t]; if (!wB) continue; const wF = total - wB; if (!wF) break;
    sumB += t * hist[t];
    const v = wB * wF * (sumB / wB - (sum - sumB) / wF) ** 2;
    if (v > maxVar) { maxVar = v; thr = t; }
  }
  // Which tone is the background? Sample the image border.
  let bDark = 0, bN = 0;
  for (const p of pts) if (p.x < w * 0.03 || p.x > w * 0.97 || p.y < h * 0.03 || p.y > h * 0.97) { bN++; if (p.L <= thr) bDark++; }
  const bgIsDark = bDark > bN / 2;
  const card = pts.filter(p => (p.L <= thr) !== bgIsDark);   // card = the non-background tone
  if (card.length < total * 0.12 || card.length > total * 0.95) return null;  // implausible → manual
  // Rough corners from the extreme points (good enough to label the 4 sides).
  const pick = (f) => card.reduce((a, b) => f(b) < f(a) ? b : a);
  const tl = pick(p => p.x + p.y), br = pick(p => -(p.x + p.y));
  const tr = pick(p => -(p.x - p.y)), bl = pick(p => p.x - p.y);
  const rough = [tl, tr, br, bl].map(p => ({ x: p.x, y: p.y }));
  const area = Math.abs((tr.x - tl.x) * (bl.y - tl.y) - (bl.x - tl.x) * (tr.y - tl.y));
  if (area < (w * h) * 0.08) return null;
  // Refine: the corners are ROUNDED, so instead of trusting the extreme points,
  // fit a straight LINE to each of the 4 edges (using the middle of each side,
  // away from the rounded ends) and intersect adjacent lines for sharp corners.
  // This also tracks perspective (each edge is its own line).
  const hull = convexHull(card);
  const sidePts = [[], [], [], []];
  for (const p of hull) {
    let best = 0, bd = Infinity, bt = 0;
    for (let i = 0; i < 4; i++) {
      const a = rough[i], b = rough[(i + 1) % 4], dx = b.x - a.x, dy = b.y - a.y, L2 = dx * dx + dy * dy || 1;
      let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / L2; t = Math.max(0, Math.min(1, t));
      const d = (p.x - (a.x + t * dx)) ** 2 + (p.y - (a.y + t * dy)) ** 2;
      if (d < bd) { bd = d; best = i; bt = t; }
    }
    if (bt > 0.12 && bt < 0.88) sidePts[best].push(p);   // drop the rounded corner zones
  }
  const lines = sidePts.map(ps => {
    if (ps.length < 3) return null;
    let L = fitLine(ps);
    // One robust pass: drop points far from the line (the rounded-corner arcs) and
    // refit, so the line locks onto the straight part of the edge.
    const dist = (p) => Math.abs((p.x - L.c.x) * (-L.d.y) + (p.y - L.c.y) * L.d.x);
    const res = ps.map(dist).sort((a, b) => a - b), med = res[res.length >> 1] || 1;
    const kept = ps.filter(p => dist(p) < Math.max(3, 2 * med));
    return kept.length >= 3 ? fitLine(kept) : L;
  });
  if (lines.some(l => !l)) return rough;                  // not enough edge points → rough corners
  const refined = [];
  for (let i = 0; i < 4; i++) refined.push(lineIntersect(lines[(i + 3) % 4], lines[i]) || rough[i]);
  return refined;
}
// Convex hull (Andrew's monotone chain).
function convexHull(pts) {
  const p = pts.map(q => ({ x: q.x, y: q.y })).sort((a, b) => a.x - b.x || a.y - b.y);
  if (p.length < 3) return p;
  const cr = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lo = []; for (const q of p) { while (lo.length >= 2 && cr(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q); }
  const up = []; for (let i = p.length - 1; i >= 0; i--) { const q = p[i]; while (up.length >= 2 && cr(up[up.length - 2], up[up.length - 1], q) <= 0) up.pop(); up.push(q); }
  lo.pop(); up.pop(); return lo.concat(up);
}
// Total-least-squares line fit → { c: centroid, d: unit direction }.
function fitLine(ps) {
  let cx = 0, cy = 0; for (const p of ps) { cx += p.x; cy += p.y; } cx /= ps.length; cy /= ps.length;
  let sxx = 0, sxy = 0, syy = 0;
  for (const p of ps) { const dx = p.x - cx, dy = p.y - cy; sxx += dx * dx; sxy += dx * dy; syy += dy * dy; }
  const th = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  return { c: { x: cx, y: cy }, d: { x: Math.cos(th), y: Math.sin(th) } };
}
function lineIntersect(L1, L2) {
  const det = L1.d.x * (-L2.d.y) - L1.d.y * (-L2.d.x);
  if (Math.abs(det) < 1e-9) return null;
  const rx = L2.c.x - L1.c.x, ry = L2.c.y - L1.c.y;
  const t = (rx * (-L2.d.y) - ry * (-L2.d.x)) / det;
  return { x: L1.c.x + t * L1.d.x, y: L1.c.y + t * L1.d.y };
}
// Solve an n×n linear system by Gaussian elimination with partial pivoting.
function solveLinear(A, b) {
  const n = b.length;
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(A[r][col]) > Math.abs(A[piv][col])) piv = r;
    [A[col], A[piv]] = [A[piv], A[col]]; [b[col], b[piv]] = [b[piv], b[col]];
    if (Math.abs(A[col][col]) < 1e-12) return null;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = A[r][col] / A[col][col];
      for (let c = col; c < n; c++) A[r][c] -= f * A[col][c];
      b[r] -= f * b[col];
    }
  }
  return b.map((v, i) => v / A[i][i]);
}
// Homography h[0..7] mapping image px (src {x,y}) → plane mm (dst [X,Y]), from 4
// corner correspondences. h33 is fixed to 1.
function computeHomography(src, dst) {
  const A = [], b = [];
  for (let i = 0; i < 4; i++) {
    const { x, y } = src[i], [X, Y] = dst[i];
    A.push([x, y, 1, 0, 0, 0, -X * x, -X * y]); b.push(X);
    A.push([0, 0, 0, x, y, 1, -Y * x, -Y * y]); b.push(Y);
  }
  return solveLinear(A, b);
}
function applyH(h, p) {
  const d = h[6] * p.x + h[7] * p.y + 1;
  return { x: (h[0] * p.x + h[1] * p.y + h[2]) / d, y: (h[3] * p.x + h[4] * p.y + h[5]) / d };
}

function applyCardScale() {
  const q = state.cardQuad; if (!q) return;
  const d = (a, b) => Math.hypot(b.x - a.x, b.y - a.y);
  const hAvg = (d(q[0], q[1]) + d(q[3], q[2])) / 2;   // top & bottom edges
  const vAvg = (d(q[0], q[3]) + d(q[1], q[2])) / 2;   // left & right edges
  // Map the 4 card corners to a true rectangle in mm — this homography removes
  // perspective skew; everything measured through it is in real millimetres.
  const cd = cardDims();
  const [W, Hh] = hAvg >= vAvg ? [cd.long, cd.short] : [cd.short, cd.long];
  const H = computeHomography(q, [[0, 0], [W, 0], [W, Hh], [0, Hh]]);
  const pxPerMm = (hAvg / W + vAvg / Hh) / 2;         // just for the readout
  if (H && pxPerMm > 0) {
    state.cardH = H;
    state.manualScale = pxPerMm;
    $('scaleReadout').textContent = `card (skew-corrected) · ~${pxPerMm.toFixed(1)} px/mm`;
    redecode(true);
  }
}

// ── buttons ──────────────────────────────────────────────────────────────────
$('fileInput').onchange = (e) => {
  const f = e.target.files[0];
  if (f) { state.manualScale = null; state.cardQuad = null; state.cardH = null; loadImage(URL.createObjectURL(f)); }
};
$('rotateBtn').onclick = () => transformImage('rot');
$('mirrorBtn').onclick = () => transformImage('mirror');
$('flipVBtn').onclick = () => transformImage('flip');
$('autoBtn').onclick = () => { autoPlace(); redecode(true); };
// Flip the reading direction (bow↔tip) — swaps the back-edge ends, reversing the
// order the cuts are read in (for a key photographed the other way round).
$('flipBtn').onclick = () => { if (state.back) { state.back.reverse(); decodeFromHandles(); draw(); } };
$('genBtn').onclick = () => generate();
{ const b = $('debossCodeBtn'); if (b) b.onclick = () => { if (state.decoded) $('debossInput').value = state.decoded.code.join('-'); }; }
$('exportBtn').onclick = () => {
  if (!state.mesh) return;
  const name = `${state.blank.id}_${state.decoded.code.join('')}`;
  downloadBlob(toBinarySTL(state.mesh.positions, state.mesh.indices, name), `${name}.stl`);
};

// Direct code entry — type a known bitting, with or without a photo.
$('bittingInput').oninput = (e) => {
  const spec = state.blank.spec, [lo, hi] = codeRange(spec);
  const digits = (e.target.value.match(/\d/g) || []).map(Number);
  if (digits.length !== spec.positions || !digits.every(d => d >= lo && d <= hi)) return;
  state.decoded = {
    code: digits, ambiguous: [], macs: checkMACS(spec, digits),
    cuts: digits.map((c, i) => ({ i, code: c, overridden: true, depthMm: rootDepthMm(spec, c), u: cutCentre(spec, i) * IN_TO_MM })),
  };
  state.overrides = Object.fromEntries(digits.map((c, i) => [i, c]));
  showBitting(); $('genBtn').disabled = false; draw();
};

// Point in polygon (ray cast) — for keeping the label inside the bow / out of holes.
function ptInPoly(poly, x, y) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0], yi = poly[i][1], xj = poly[j][0], yj = poly[j][1];
    if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
}
// Vertical metal span [loH, hiH] of a bow outline at a given x (null if none).
function vSpanAt(poly, x) {
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    if ((a[0] <= x) !== (b[0] <= x)) { const h = a[1] + (b[1] - a[1]) * (x - a[0]) / (b[0] - a[0]); if (h < lo) lo = h; if (h > hi) hi = h; }
  }
  return hi > lo ? [lo, hi] : null;
}

// Compute the deboss glyph loops placed on the bow head (+ side / mode / a warn
// flag), or null when the label is empty. The text goes in the metal between the
// keyring hole's neck-side edge and the neck, centre-justified, and is SHRUNK to
// stay inside the real bow silhouette (and out of the holes). If it still can't
// fit at a legible size, `warn` is set so the UI can flag it.
function debossLoopsFor() {
  const raw = ($('debossInput')?.value || '').trim().slice(0, 14);
  if (!raw) return null;
  try {
    const rot = +($('debossRotSel')?.value ?? 270);
    const side = $('debossSideSel')?.value || 'up';
    const mode = $('debossModeSel')?.value || 'engrave';
    const bow = bowOutline(state.blank);                    // (x,h) bow outline
    const xs = bow.map(p => p[0]), hs = bow.map(p => p[1]);
    const minX = Math.min(...xs), hMin = Math.min(...hs), hMax = Math.max(...hs);
    // Keyring hole(s): place text on the NECK side of the hole (its right/+x edge).
    const holes = getBowHoles(state.blank.bow) || [];
    let holeMaxX = minX;
    for (const l of holes) for (const p of l) if (p[0] > holeMaxX) holeMaxX = p[0];
    let x0 = Math.max(minX + 1.2, holeMaxX + 1.0), x1 = -1.2;
    if (x1 - x0 < 4) { x0 = minX + 1.5; x1 = -1.0; }        // clear band too small → whole head
    // Box height from the ACTUAL metal span at the band's centre, inset by a margin
    // (not a fixed fraction — that overran the narrowing head).
    const margin = 0.9, span = vSpanAt(bow, (x0 + x1) / 2) || [hMin, hMax];
    const box = { x0, x1, z0: span[0] + margin, z1: span[1] - margin };
    const maxMm = Math.min(4.5, (span[1] - span[0]) * 0.55);
    // Place, then shrink until every glyph point sits inside the bow and outside
    // the holes — so the label can never spill past the border.
    const fits = (loops) => loops.every(l => l.every(p =>
      ptInPoly(bow, p[0], p[1]) && !holes.some(h => ptInPoly(h, p[0], p[1]))));
    let f = 1, loops = [];
    for (let it = 0; it < 7; it++) {
      loops = placeLoopsInBox(raw, box, { fill: 0.9 * f, rot, maxMm: maxMm * f });
      if (!loops.length || fits(loops)) break;
      f *= 0.82;
    }
    if (!loops.length) return null;
    // Warn if it only fit by shrinking below a legible size, or still doesn't fit.
    let hlo = Infinity, hhi = -Infinity;
    for (const l of loops) for (const p of l) { if (p[1] < hlo) hlo = p[1]; if (p[1] > hhi) hhi = p[1]; }
    const warn = (!fits(loops) || (rot % 180 === 90 ? (hhi - hlo) : (hhi - hlo)) < 1.4)
      ? 'Label is large for this bow — it was shrunk to fit. Shorten it or try a different orientation for a bolder engrave.' : '';
    return { loops, side, mode, warn };
  } catch { return null; }
}

async function generate() {
  if (!state.decoded) return;
  status('Generating…');
  const deb = debossLoopsFor();
  const opts = { wardingId: state.wardingId, debossLoops: deb?.loops || null, debossSide: deb?.side || 'up', debossMode: deb?.mode || 'engrave', debossDepth: 0.5, embossHeight: 0.4 };
  { const wEl = $('debossWarn'); if (wEl) { wEl.textContent = deb?.warn || ''; wEl.hidden = !deb?.warn; } }
  let m;
  try { m = await buildKeyMeshCSG(state.blank, state.decoded.code, opts); }   // keygen-style CSG union
  catch (e) { m = buildKeyMesh(state.blank, state.decoded.code, opts); }       // native weld fallback
  const st = meshStats(m.positions);
  state.mesh = { ...m, stats: st };
  // Reveal the 3D panel now (hidden until the first key is generated so the photo
  // gets the full width for tracing).
  const stage = $('stage3d'); if (stage) stage.hidden = false;
  const layout = document.querySelector('.keys-layout'); if (layout) layout.classList.remove('no3d');
  if (!viewer) viewer = new Viewer3D($('view3d'));
  viewer.setMesh(state.mesh, true);
  $('exportBtn').disabled = false;
  status(`Generated ${state.blank.id} ${state.decoded.code.join('-')} — ${st.sizeX.toFixed(1)}×${st.sizeZ.toFixed(1)} mm.`);
}
function meshStats(pos) {
  let mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < pos.length; i += 3) for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], pos[i + k]); mx[k] = Math.max(mx[k], pos[i + k]); }
  return { sizeX: mx[0] - mn[0], sizeY: mx[1] - mn[1], sizeZ: mx[2] - mn[2] };
}

initBlanks();
{ const el = $('appVersion'); if (el) el.textContent = VERSION; }
// Light / dark theme toggle (top-right) — for contrast against the photo. Persists.
{
  const tb = $('themeBtn'), KEY = 'flr-theme';
  const apply = (t) => { document.documentElement.dataset.theme = t; if (tb) tb.textContent = t === 'light' ? '☀ Light' : '☾ Dark'; };
  let saved = null; try { saved = localStorage.getItem(KEY); } catch { /* private mode */ }
  apply(saved === 'light' ? 'light' : 'dark');
  if (tb) tb.onclick = () => { const t = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light'; apply(t); try { localStorage.setItem(KEY, t); } catch { /* ignore */ } };
}
// Minimize the controls panel — hand the photo the full window width while tracing.
{
  const pb = $('panelBtn'), lay = document.querySelector('.keys-layout');
  if (pb && lay) pb.onclick = () => {
    const hid = lay.classList.toggle('panel-hidden');
    pb.textContent = hid ? '⇥ Show panel' : '⇤ Hide panel';
    if (state.img) fitCanvas();
    if (viewer && viewer.resize) viewer.resize();
    window.dispatchEvent(new Event('resize'));
    draw();
  };
}
// Reference-rectangle size picker
{
  const sel = $('cardSizeSel');
  if (sel) sel.onchange = () => { state.cardSize = sel.value; if (state.cardQuad) applyCardScale(); };
}
// Diagram modal
{
  const modal = $('diagramModal'), openB = $('diagramBtn'), closeB = $('diagramClose');
  const close = () => { if (modal) modal.hidden = true; };
  if (openB) openB.onclick = () => { if (modal) modal.hidden = false; };
  if (closeB) closeB.onclick = close;
  if (modal) modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
}
window.addEventListener('resize', () => { if (state.img) { fitCanvas(); draw(); } });

// Expose for headless testing.
window.keyUI = {
  state, loadImage, redecode, generate,
  setScale: (v) => { state.manualScale = v; },
  setHandles: (sh, tp) => { state.shoulder = sh; state.tip = tp; },
  setCard: (quad) => { state.cardQuad = quad; applyCardScale(); },
  reprofile, detectBow,
};
