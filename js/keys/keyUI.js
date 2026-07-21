// MockRock — key-decode UI. Ties the photo to js/keys/decode.js (read the
// bitting, with draggable datum + per-cut depth handles) and js/keys/keyMesh.js
// (build the printable key), previewing in Viewer3D and exporting an STL.
//
// Coordinates: handles live in IMAGE pixels; a fit transform maps image↔canvas.
// The decode works in mm (pxPerMm from the card-scale step).

import { BLANKS, getBlank, wardingFor, IN_TO_MM } from './blanks.js';
import { cutCentre, rootDepthForCode, codeRange } from './blanks.js';
import { decode, rootDepthMm, snapDepthMm, spacingMm } from './decode.js';
import { buildKeyMesh } from './keyMesh.js';
import { Viewer3D } from '../viewer3d.js';
import { toBinarySTL, downloadBlob } from '../exporters.js';

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
  drag: null, scaleClicks: null,
};

let viewer = null;

// ── setup ────────────────────────────────────────────────────────────────────
function initBlanks() {
  const sel = $('blankSel');
  sel.innerHTML = BLANKS.map(b => `<option value="${b.id}">${b.name}</option>`).join('');
  sel.value = 'SC1';
  sel.onchange = () => { state.blank = getBlank(sel.value); state.overrides = {}; initWarding(); redecode(); };
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
    draw();
    status('Set scale, then adjust the shoulder/tip and cuts.');
  };
  img.src = src;
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
  const shX = minx + (shb / bins) * (maxx - minx);
  state.shoulder = horizontal ? { x: shX, y: cy } : { x: cx, y: miny + (shb / bins) * (maxy - miny) };
  state.tip = bowAtMax ? { x: minx + 2 * step, y: cy } : { x: maxx - 2 * step, y: cy };
}
const median = (a) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };

// ── build the height profile along the current axis, then decode ─────────────
function buildProfile() {
  if (!state.shoulder || !state.tip || !state.pxPerMm) return null;
  const o = state.shoulder, t = state.tip;
  const dx = t.x - o.x, dy = t.y - o.y, L = Math.hypot(dx, dy) || 1;
  const d = { x: dx / L, y: dy / L }, n = { x: -dy / L, y: dx / L };
  const spanPx = state.blank.spec.bladeHeight * IN_TO_MM * state.pxPerMm * 1.6;
  const prof = [];
  for (let up = 0; up <= L; up += 1) {
    const px = o.x + up * d.x, py = o.y + up * d.y;
    let lo = null, hi = null;
    for (let k = -spanPx; k <= spanPx; k += 1) {
      if (bright(px + k * n.x, py + k * n.y)) { if (lo === null) lo = k; hi = k; }
    }
    if (lo !== null) prof.push({ u: up / state.pxPerMm, h: (hi - lo) / state.pxPerMm });
  }
  return prof;
}

function redecode() {
  const prof = buildProfile();
  if (!prof || !prof.length) { state.decoded = null; showBitting(); draw(); return; }
  state.decoded = decode(state.blank.spec, prof, { overrides: state.overrides });
  showBitting();
  $('genBtn').disabled = false;
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
  if (state.scaleClicks) {
    ctx.fillStyle = '#37b6ff';
    for (const p of state.scaleClicks) { const c = toCanvas(p); ctx.beginPath(); ctx.arc(c.x, c.y, 5, 0, 7); ctx.fill(); }
  }
  if (!state.shoulder || !state.tip) return;
  const o = state.shoulder, t = state.tip;
  const dx = t.x - o.x, dy = t.y - o.y, L = Math.hypot(dx, dy) || 1;
  const d = { x: dx / L, y: dy / L }, n = { x: -dy / L, y: dx / L };
  const co = toCanvas(o), ctp = toCanvas(t);
  // axis
  line(co, ctp, '#3a6', 1.5);
  // shoulder line
  const sh = state.blank.spec.bladeHeight * IN_TO_MM * (state.pxPerMm || 4) * 1.5 * state.view.s;
  line({ x: co.x + n.x * sh, y: co.y + n.y * sh }, { x: co.x - n.x * sh, y: co.y - n.y * sh }, '#37b6ff', 3);
  dot(ctp, '#ffcc33', 6);            // tip handle
  dot(co, '#37b6ff', 6);             // shoulder handle
  // cut markers + depth ticks
  if (state.decoded && state.pxPerMm) {
    const spec = state.blank.spec, [lo, hi] = codeRange(spec);
    for (const cut of state.decoded.cuts) {
      const uPx = cut.u * state.pxPerMm;
      const base = { x: o.x + uPx * d.x, y: o.y + uPx * d.y };
      // ticks for each depth level (perp offset = rootDepth mm)
      for (let c = lo; c <= hi; c++) {
        const off = rootDepthMm(spec, c) * state.pxPerMm;
        const p = toCanvas({ x: base.x + n.x * off, y: base.y + n.y * off });
        tick(p, n, 6, c === cut.code ? '#8fd' : '#456');
      }
      // measured marker
      const moff = cut.depthMm * state.pxPerMm;
      const mp = toCanvas({ x: base.x + n.x * moff, y: base.y + n.y * moff });
      dot(mp, cut.overridden ? '#ffcc33' : (state.decoded.ambiguous.includes(cut.i) ? '#e5705a' : '#ff5050'), 7);
      label(mp, String(cut.code));
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
  if (state.scaleClicks) {
    state.scaleClicks.push(toImage(p));
    if (state.scaleClicks.length === 2) finishScale();
    draw(); return;
  }
  if (state.shoulder && hit(p, state.shoulder)) state.drag = { kind: 'shoulder' };
  else if (state.tip && hit(p, state.tip)) state.drag = { kind: 'tip' };
  else if (state.decoded) {
    for (const cut of state.decoded.cuts) {
      const o = state.shoulder, t = state.tip, L = Math.hypot(t.x - o.x, t.y - o.y) || 1;
      const d = { x: (t.x - o.x) / L, y: (t.y - o.y) / L }, n = { x: -(t.y - o.y) / L, y: (t.x - o.x) / L };
      const uPx = cut.u * state.pxPerMm, moff = cut.depthMm * state.pxPerMm;
      const mp = { x: o.x + uPx * d.x + n.x * moff, y: o.y + uPx * d.y + n.y * moff };
      if (hit(p, mp)) { state.drag = { kind: 'depth', cut, n, base: { x: o.x + uPx * d.x, y: o.y + uPx * d.y } }; break; }
    }
  }
});
canvas.addEventListener('pointermove', (e) => {
  if (!state.drag) return;
  const p = toImage({ x: e.offsetX, y: e.offsetY });
  if (state.drag.kind === 'shoulder') state.shoulder = p;
  else if (state.drag.kind === 'tip') state.tip = p;
  else if (state.drag.kind === 'depth') {
    const { cut, n, base } = state.drag;
    const offPx = (p.x - base.x) * n.x + (p.y - base.y) * n.y;
    const depthMm = offPx / state.pxPerMm;
    state.overrides[cut.i] = snapDepthMm(state.blank.spec, depthMm).code;
  }
  if (state.drag.kind === 'depth') redecode(); else draw();
});
window.addEventListener('pointerup', () => {
  if (state.drag && state.drag.kind !== 'depth') redecode();
  state.drag = null;
});

// ── scale ────────────────────────────────────────────────────────────────────
$('scaleBtn').onclick = () => { state.scaleClicks = []; status('Click two points a known distance apart…'); draw(); };
function finishScale() {
  const [a, b] = state.scaleClicks;
  const px = Math.hypot(b.x - a.x, b.y - a.y);
  const mm = parseFloat(prompt('Distance between the two points (mm)?', '85.6'));
  state.scaleClicks = null;
  if (mm > 0) {
    state.pxPerMm = px / mm;
    $('scaleReadout').textContent = `${state.pxPerMm.toFixed(2)} px/mm`;
    status('Scale set. Adjust the shoulder/tip and cut depths.');
    redecode();
  } else draw();
}

// ── buttons ──────────────────────────────────────────────────────────────────
$('fileInput').onchange = (e) => { const f = e.target.files[0]; if (f) loadImage(URL.createObjectURL(f)); };
$('autoBtn').onclick = () => { autoPlace(); redecode(); };
$('genBtn').onclick = () => generate();
$('exportBtn').onclick = () => {
  if (!state.mesh) return;
  const name = `${state.blank.id}_${state.decoded.code.join('')}`;
  downloadBlob(toBinarySTL(state.mesh.positions, state.mesh.indices, name), `${name}.stl`);
};

function generate() {
  if (!state.decoded) return;
  const m = buildKeyMesh(state.blank, state.decoded.code, { wardingId: state.wardingId });
  const st = meshStats(m.positions);
  state.mesh = { ...m, stats: st };
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
window.addEventListener('resize', () => { if (state.img) { fitCanvas(); draw(); } });

// Expose for headless testing.
window.keyUI = {
  state, loadImage, redecode, generate, buildProfile,
  setScale: (v) => { state.pxPerMm = v; },
  setHandles: (sh, tp) => { state.shoulder = sh; state.tip = tp; },
};
