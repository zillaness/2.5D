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
import { buildKeyMesh } from './keyMesh.js';
import { Viewer3D } from '../viewer3d.js';
import { toBinarySTL, downloadBlob } from '../exporters.js';
import { VERSION } from './version.js';

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
  state.cardQuad = null;
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
  if (!state.back || !state.cutPts || !state.pxPerMm) { state.decoded = null; showBitting(); return; }
  const [A, B] = state.back, dl = { x: B.x - A.x, y: B.y - A.y }, Ll = Math.hypot(dl.x, dl.y) || 1;
  const du = { x: dl.x / Ll, y: dl.y / Ll }, nb = { x: -du.y, y: du.x };
  const ordered = state.cutPts.slice().sort((a, b) =>
    ((a.x - A.x) * du.x + (a.y - A.y) * du.y) - ((b.x - A.x) * du.x + (b.y - A.y) * du.y));
  const cuts = ordered.map((P, i) => {
    const depthMm = Math.abs((P.x - A.x) * nb.x + (P.y - A.y) * nb.y) / state.pxPerMm;
    const snap = snapDepthMm(spec, depthMm);
    return { i, u: ((P.x - A.x) * du.x + (P.y - A.y) * du.y) / state.pxPerMm, depthMm, code: snap.code, residual: snap.residual, overridden: false, pt: P };
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
    label(c[0], 'card');
  }
  if (!state.shoulder || !state.tip) return;
  // Direction along the blade: prefer the (draggable) back edge — it's the
  // reliable straight reference — so the shoulder line stays square to the blade
  // even if the auto axis was tilted by the bow.
  let du;
  if (state.back) { const [A, B] = state.back, dl = { x: B.x - A.x, y: B.y - A.y }, Ll = Math.hypot(dl.x, dl.y) || 1; du = { x: dl.x / Ll, y: dl.y / Ll }; }
  else { const dx = state.tip.x - state.shoulder.x, dy = state.tip.y - state.shoulder.y, L = Math.hypot(dx, dy) || 1; du = { x: dx / L, y: dy / L }; }
  const nn = { x: -du.y, y: du.x };                 // perpendicular (across the blade)
  const co = toCanvas(state.shoulder);
  // shoulder line (blue) — perpendicular to the blade, where the cuts start
  const sh = state.blank.spec.bladeHeight * IN_TO_MM * (state.pxPerMm || 4) * 1.3 * state.view.s;
  line({ x: co.x + nn.x * sh, y: co.y + nn.y * sh }, { x: co.x - nn.x * sh, y: co.y - nn.y * sh }, '#37b6ff', 3);
  dot(co, '#37b6ff', 6); label(co, 'shoulder');
  // back-edge line (green) — the depth-zero datum
  if (state.back) {
    const a = toCanvas(state.back[0]), b = toCanvas(state.back[1]);
    line(a, b, '#4ec98a', 3);
    dot(a, '#4ec98a', 6); dot(b, '#4ec98a', 6); label(b, 'back');
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
  if (state.cardQuad) {                    // grab a card corner if one is near
    for (let i = 0; i < 4; i++) if (hit(p, state.cardQuad[i])) { state.drag = { kind: 'card', idx: i }; return; }
  }
  // cut dots first (they sit on top), then the back-line ends, then shoulder/tip
  if (state.cutPts) { for (let i = 0; i < state.cutPts.length; i++) if (hit(p, state.cutPts[i])) { state.drag = { kind: 'cut', idx: i }; return; } }
  if (state.back) { for (let i = 0; i < 2; i++) if (hit(p, state.back[i])) { state.drag = { kind: 'back', idx: i }; return; } }
  if (state.shoulder && hit(p, state.shoulder)) { state.drag = { kind: 'shoulder' }; return; }
  if (state.tip && hit(p, state.tip)) { state.drag = { kind: 'tip' }; return; }
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
const CARD_LONG = 85.60, CARD_SHORT = 53.98;
$('scaleBtn').onclick = () => {
  if (!state.img) { status('Load a photo first.'); return; }
  const auto = detectCardQuad();
  if (auto) {
    state.cardQuad = auto;
    status('Card detected — nudge any corner if it’s off, then it’s set.');
  } else {
    const { w, h } = state.sample;
    const cw = w * 0.6, ch = cw * (CARD_SHORT / CARD_LONG);
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
  const pick = (f) => card.reduce((a, b) => f(b) < f(a) ? b : a);
  const tl = pick(p => p.x + p.y), br = pick(p => -(p.x + p.y));
  const tr = pick(p => -(p.x - p.y)), bl = pick(p => p.x - p.y);
  const quad = [tl, tr, br, bl].map(p => ({ x: p.x, y: p.y }));
  // Sanity: the quad should cover a big, card-shaped chunk of the frame.
  const area = Math.abs((tr.x - tl.x) * (bl.y - tl.y) - (bl.x - tl.x) * (tr.y - tl.y));
  if (area < (w * h) * 0.08) return null;
  return quad;
}
function applyCardScale() {
  const q = state.cardQuad; if (!q) return;
  const d = (a, b) => Math.hypot(b.x - a.x, b.y - a.y);
  const hAvg = (d(q[0], q[1]) + d(q[3], q[2])) / 2;   // top & bottom edges
  const vAvg = (d(q[0], q[3]) + d(q[1], q[2])) / 2;   // left & right edges
  const [lng, srt] = hAvg >= vAvg ? [hAvg, vAvg] : [vAvg, hAvg];
  const pxPerMm = (lng / CARD_LONG + srt / CARD_SHORT) / 2;
  if (pxPerMm > 0) {
    state.manualScale = pxPerMm;
    $('scaleReadout').textContent = `${pxPerMm.toFixed(2)} px/mm (card)`;
    redecode(true);
  }
}

// ── buttons ──────────────────────────────────────────────────────────────────
$('fileInput').onchange = (e) => {
  const f = e.target.files[0];
  if (f) { state.manualScale = null; state.cardQuad = null; loadImage(URL.createObjectURL(f)); }
};
$('rotateBtn').onclick = () => transformImage('rot');
$('mirrorBtn').onclick = () => transformImage('mirror');
$('flipVBtn').onclick = () => transformImage('flip');
$('autoBtn').onclick = () => { autoPlace(); redecode(true); };
$('genBtn').onclick = () => generate();
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

function generate() {
  if (!state.decoded) return;
  const m = buildKeyMesh(state.blank, state.decoded.code, { wardingId: state.wardingId });
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
window.addEventListener('resize', () => { if (state.img) { fitCanvas(); draw(); } });

// Expose for headless testing.
window.keyUI = {
  state, loadImage, redecode, generate,
  setScale: (v) => { state.manualScale = v; },
  setHandles: (sh, tp) => { state.shoulder = sh; state.tip = tp; },
  reprofile,
};
