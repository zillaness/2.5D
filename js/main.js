// App orchestration: three steps — (1) photo + paper corners, (2) trace +
// holes, (3) extrusion parameters + export.

import { PAPER_SIZES, COIN_SIZES, DEFAULT_SIZE, DEFAULT_COIN, paperDims } from './paperSizes.js';
import { rectify } from './homography.js';
import { estimateDistortion } from './lens.js';
import { detectPaperCorners } from './detectPaper.js';
import { computeDiffMap, otsuThreshold, segmentObject } from './segment.js';
import {
  traceBoundaries, signedArea, collapseCollinear, simplifyClosed,
  chaikinClosed, pointInPolygon,
} from './contour.js';
import { buildModel } from './mesh.js';
import {
  SCREW_STANDARDS, INSERT_SIZES, screwSpec, boreDiameter, recessDefaults, insertHole,
} from './screws.js';
import { parseLength, formatLength, formatLengthLabelled } from './units.js';
import { measureInfo, loopStats, REGION_LOOP_BASE } from './measure.js';
import { toBinarySTL, toSVG, toDXF, downloadBlob } from './exporters.js';
import { APP_VERSION } from './version.js';

// Export quality presets: chord tolerance (mm) for round features and the
// arc-segment count for chamfer/fillet curves. Smaller = smoother + more tris.
const QUALITY_PRESETS = {
  coarse: { label: 'Coarse (fast)',   chordTol: 0.8,  arcSegments: 4 },
  medium: { label: 'Medium',          chordTol: 0.4,  arcSegments: 8 },
  fine:   { label: 'Fine',            chordTol: 0.2,  arcSegments: 12 },
  xfine:  { label: 'Extra fine',      chordTol: 0.1,  arcSegments: 20 },
};
import { CornerEditor } from './ui/cornerEditor.js';
import { TraceEditor } from './ui/traceEditor.js';
import { Viewer3D } from './viewer3d.js';
import { importCad } from './import/cadImport.js';

const $ = id => document.getElementById(id);

const state = {
  image: null,
  fileName: 'object',
  corners: null,          // [{x,y} x4] source-image px, TL TR BR BL
  reference: 'rect', // 'rect' (paper/card, perspective-corrected) | 'coin' (scale only)
  paper: { size: DEFAULT_SIZE, orientation: 'portrait', customW: 210, customH: 297 },
  coin: { size: DEFAULT_COIN, customD: 24.26 },
  lens: { k1: 0, k2: 0 }, // radial lens-distortion correction (rectangle path)
  rect: null,             // { canvas, pxPerMm }
  rectDirty: true,
  diffMap: null,
  mask: null,
  seg: {
    threshold: 60, autoThreshold: true, cleanup: 2, marginMm: 2,
    detectHoles: true, simplify: 0.4, smooth: 1, minHoleAreaMm2: 3,
  },
  model: { arcSegments: 8, quality: 'medium' },
  // Sections: [0] is the base (footprint = traced outline); extra sections
  // carry their own drawn footprint, thickness and floor offset (overhangs).
  regions: [
    {
      name: 'Base', pts: null, thickness: 5, zBase: 0,
      top: { mode: 'none', size: 1 }, bottom: { mode: 'none', size: 1 },
    },
  ],
  selRegion: 0,
  meshData: null,
  step: 1,
  units: 'mm', // display unit; inputs accept both (12.7 / 1/2" / 0.5 in)
};

const fmtDim = mm => formatLength(mm, state.units);
const fmtDimL = mm => formatLengthLabelled(mm, state.units);
const parseDim = str => parseLength(str, state.units);

// ---------- widgets ----------

const cornerEditor = new CornerEditor($('cornerCanvas'), () => { state.rectDirty = true; });
const traceEditor = new TraceEditor($('traceCanvas'), {
  onChange: (throttled) => {
    updateTraceInfo();
    if (!throttled) { updateStepButtons(); refreshMeasurePanel(); }
  },
  onSelect: () => {
    syncHolePanel();
    positionHoleTag();
    refreshSelectionTools();
    const si = traceEditor.selectedSectionIndex();
    if (si >= 1) { state.selRegion = si; refreshModelFields(); }
  },
  onDraw: () => positionHoleTag(),
  onHolePlaced: () => {
    syncHolePanel();
    positionHoleTag();
    // Let the user type the diameter immediately, right at the hole.
    const input = $('holeTagInput');
    input.focus();
    input.select();
  },
  onRegionDrawn: (pts) => {
    state.regions.push({
      name: `Section ${state.regions.length + 1}`,
      pts,
      thickness: state.regions[0].thickness,
      zBase: 0,
      top: { mode: 'none', size: 1 },
      bottom: { mode: 'none', size: 1 },
    });
    state.selRegion = state.regions.length - 1;
    refreshModelFields();
    toast('Section added — set its thickness and floor offset in step 3 (Model & export).');
  },
  onSectionsChanged: () => {
    if (state.selRegion >= state.regions.length) state.selRegion = 0;
    refreshModelFields();
    if (state.step === 3) rebuildMesh();
  },
  formatLen: mm => fmtDimL(mm),
  onAnnosChanged: () => { refreshMeasurePanel(); refreshConstraintList(); },
  onPicksChanged: () => refreshConstrainButtons(),
});
traceEditor.setSections(state.regions);
let viewer = null; // created lazily on step 3

// ---------- helpers ----------

let toastTimer = null;
function toast(msg, ms = 3200) {
  const el = $('toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}

function currentPaper() {
  const { size, orientation, customW, customH } = state.paper;
  return paperDims(size, orientation, customW, customH);
}

function defaultCorners() {
  const iw = state.image.naturalWidth, ih = state.image.naturalHeight;
  const mx = iw * 0.15, my = ih * 0.15;
  return [
    { x: mx, y: my }, { x: iw - mx, y: my },
    { x: iw - mx, y: ih - my }, { x: mx, y: ih - my },
  ];
}

function guessOrientation(corners) {
  const d = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const horiz = d(corners[0], corners[1]) + d(corners[3], corners[2]);
  const vert = d(corners[0], corners[3]) + d(corners[1], corners[2]);
  return horiz > vert ? 'landscape' : 'portrait';
}

// ---------- step navigation ----------

function goStep(n) {
  if (n >= 2 && !state.image && !state.rect) return; // rect alone = restored project
  if (n === 2 && state.rectDirty && state.image) {
    if (!doRectify()) return;
    retrace();
  }
  state.step = n;
  for (let i = 1; i <= 3; i++) {
    $('stage' + i).hidden = i !== n;
    $('panel' + i).hidden = i !== n;
    $('stepBtn' + i).classList.toggle('active', i === n);
  }
  positionHoleTag();
  if (n === 2) {
    $('lensRow').hidden = state.reference !== 'rect';
    $('lensVal').textContent = state.lens.k1.toFixed(3);
    traceEditor.draw();
  }
  if (n === 3) {
    // A failed 3D preview (e.g. WebGL unavailable) must never block mesh
    // building or export.
    if (!viewer) {
      try {
        viewer = new Viewer3D($('stage3'));
      } catch (err) {
        console.error('3D preview unavailable', err);
        toast('3D preview unavailable in this browser — the STL export still works.');
      }
    }
    if (viewer) viewer.resize();
    rebuildMesh(true);
  }
  updateStepButtons();
}

function updateStepButtons() {
  $('stepBtn2').disabled = !state.image && !state.rect;
  $('stepBtn3').disabled = !(traceEditor.outer && traceEditor.outer.length >= 3);
  $('toTraceBtn').disabled = !state.image && !state.rect;
  $('detectBtn').disabled = !state.image;
  $('resetCornersBtn').disabled = !state.image;
  $('toModelBtn').disabled = !(traceEditor.outer && traceEditor.outer.length >= 3);
}

// ---------- step 1: image + corners ----------

function loadFile(file) {
  if (!file || !file.type.startsWith('image/')) {
    toast('Please choose an image file.');
    return;
  }
  state.fileName = (file.name || 'object').replace(/\.[^.]+$/, '');
  const url = URL.createObjectURL(file);
  loadImageFromURL(url, () => URL.revokeObjectURL(url));
  $('fileLabelText').textContent = file.name;
}

function loadImageFromURL(url, done) {
  const img = new Image();
  img.onload = () => {
    state.image = img;
    state.rectDirty = true;
    $('dropHint').hidden = true;
    $('rotatePhotoRow').hidden = false;
    cornerEditor.setImage(img);
    if (state.reference === 'coin') {
      cornerEditor.setRefMode('coin');
    } else {
      autoDetect(false);
    }
    updateStepButtons();
    if (done) done();
  };
  img.onerror = () => toast('Could not load that image.');
  img.src = url;
}

function autoDetect(announce = true) {
  let corners = null;
  try {
    corners = detectPaperCorners(state.image);
  } catch (err) {
    console.error('detectPaperCorners failed', err);
  }
  if (corners) {
    state.corners = corners;
    state.paper.orientation = guessOrientation(corners);
    $('paperOrient').value = state.paper.orientation;
    if (announce) toast('Paper detected — fine-tune the corners if needed.');
  } else {
    state.corners = defaultCorners();
    toast('Could not auto-detect the paper — drag the corners manually.');
  }
  state.rectDirty = true;
  cornerEditor.setCorners(state.corners);
}

function coinDiameterMm() {
  if (state.coin.size === 'coin_custom') return state.coin.customD > 0 ? state.coin.customD : 24.26;
  return (COIN_SIZES[state.coin.size] || COIN_SIZES[DEFAULT_COIN]).d;
}

// Scale-only rectify for coin mode: no perspective correction — the source
// image is used as-is (downscaled if large) with pxPerMm set from the coin.
function rectifyCoin() {
  const img = state.image;
  const coin = cornerEditor.getCoin();
  if (!coin || !(coin.r > 0)) { toast('Size the coin circle first.'); return false; }
  const iw = img.naturalWidth, ih = img.naturalHeight;
  const scale = Math.min(1, 1600 / Math.max(iw, ih));
  const w = Math.round(iw * scale), h = Math.round(ih * scale);
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  c.getContext('2d').drawImage(img, 0, 0, w, h);
  const pxPerMm = (2 * coin.r * scale) / coinDiameterMm();
  state.rect = { canvas: c, pxPerMm };
  state.rectDirty = false;
  state.diffMap = computeDiffMap(c);
  if (state.seg.autoThreshold) {
    state.seg.threshold = otsuThreshold(state.diffMap.diff);
    $('threshSlider').value = state.seg.threshold;
    $('threshVal').textContent = state.seg.threshold;
  }
  traceEditor.setRectified(c, pxPerMm);
  return true;
}

function doRectify() {
  if (!state.image) return false;
  if (state.reference === 'coin') return rectifyCoin();
  const { w, h } = currentPaper();
  const res = rectify(state.image, state.corners, w, h, { k1: state.lens.k1, k2: state.lens.k2 });
  if (!res) {
    toast('Corner layout is degenerate — adjust the corners.');
    return false;
  }
  state.rect = res;
  state.rectDirty = false;
  state.diffMap = computeDiffMap(res.canvas);
  if (state.seg.autoThreshold) {
    state.seg.threshold = otsuThreshold(state.diffMap.diff);
    $('threshSlider').value = state.seg.threshold;
    $('threshVal').textContent = state.seg.threshold;
  }
  traceEditor.setRectified(res.canvas, res.pxPerMm);
  return true;
}

// ---------- step 2: segmentation + trace ----------

function retrace() {
  if (!state.rect || !state.diffMap) return;
  const { pxPerMm } = state.rect;
  const { diff, w, h } = state.diffMap;

  const mask = segmentObject(state.diffMap, {
    threshold: state.seg.threshold,
    cleanupRadius: state.seg.cleanup,
    marginPx: Math.max(2, Math.round(state.seg.marginMm * pxPerMm)),
  });
  state.mask = mask;
  buildMaskOverlay(mask, w, h);

  if (!mask) {
    traceEditor.setTrace([], []);
    updateTraceInfo('No object found — lower the threshold or check the photo.');
    updateStepButtons();
    return;
  }

  const loops = traceBoundaries(mask, w, h);
  if (!loops.length) {
    traceEditor.setTrace([], []);
    updateTraceInfo('No outline found — adjust the threshold.');
    updateStepButtons();
    return;
  }

  const toMm = pts => pts.map(p => ({ x: p.x / pxPerMm, y: p.y / pxPerMm }));
  const refine = pts => {
    let out = collapseCollinear(pts);
    out = simplifyClosed(out, state.seg.simplify);
    if (state.seg.smooth > 0) out = chaikinClosed(out, state.seg.smooth);
    return out;
  };

  const mmLoops = loops.map(l => ({ pts: toMm(l), area: Math.abs(signedArea(l)) / (pxPerMm * pxPerMm) }));
  mmLoops.sort((a, b) => b.area - a.area);
  const outerRaw = mmLoops[0];
  const outer = refine(outerRaw.pts);

  const holes = [];
  if (state.seg.detectHoles) {
    for (let i = 1; i < mmLoops.length; i++) {
      const cand = mmLoops[i];
      if (cand.area < state.seg.minHoleAreaMm2) continue;
      if (!pointInPolygon(cand.pts[0], outerRaw.pts)) continue;
      const refined = refine(cand.pts);
      if (refined.length >= 3) holes.push(refined);
    }
  }

  traceEditor.setTrace(outer, holes);
  updateTraceInfo();
  updateStepButtons();
}

function buildMaskOverlay(mask, w, h) {
  if (!mask) { traceEditor.setMaskOverlay(null); return; }
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  const im = ctx.createImageData(w, h);
  for (let i = 0; i < w * h; i++) {
    if (mask[i]) {
      im.data[i * 4] = 255; im.data[i * 4 + 1] = 70; im.data[i * 4 + 2] = 70;
      im.data[i * 4 + 3] = 84;
    }
  }
  ctx.putImageData(im, 0, 0);
  traceEditor.setMaskOverlay(c);
}

function updateTraceInfo(msg) {
  const el = $('traceInfo');
  if (msg) { el.textContent = msg; return; }
  const { outer, holes, circles } = traceEditor.getTrace();
  if (!outer || outer.length < 3) { el.textContent = ''; return; }
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of outer) {
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
  }
  el.textContent =
    `Outline: ${outer.length} pts, ${fmtDim(maxX - minX)} × ${fmtDimL(maxY - minY)}\n` +
    `Holes: ${holes.length} traced + ${circles.length} circles`;
}

// ---------- on-canvas hole tag (type the ⌀ right next to the hole) ----------

function positionHoleTag() {
  const tag = $('holeTag');
  const sel = traceEditor.selection;
  if (state.step !== 2 || !sel || sel.type !== 'circle') { tag.hidden = true; return; }
  const pos = traceEditor.circleScreenPos(sel.idx);
  if (!pos) { tag.hidden = true; return; }
  const stage = $('stage2');
  tag.hidden = false;
  const x = Math.max(4, Math.min(stage.clientWidth - 130, pos.x + pos.r + 10));
  const y = Math.max(4, Math.min(stage.clientHeight - 34, pos.y - 14));
  tag.style.left = `${x}px`;
  tag.style.top = `${y}px`;
  const input = $('holeTagInput');
  if (document.activeElement !== input) {
    const c = traceEditor.circles[sel.idx];
    input.value = fmtDim(c.d);
  }
  $('holeTagUnit').textContent = state.units;
}

// ---------- hole properties panel ----------
// Edits the selected hole when one is selected; otherwise (in Add-hole mode)
// edits the template that new holes are stamped from.

function activeHole() {
  return traceEditor.selectedCircle() || traceEditor.holeTemplate;
}

function applyHoleProps(props) {
  if (traceEditor.selectedCircle()) {
    traceEditor.updateSelectedCircle(props);
  } else {
    Object.assign(traceEditor.holeTemplate, structuredClone(props));
  }
}

function screwSizeKeys(std) {
  if (std === 'insert') return Object.keys(INSERT_SIZES);
  if (SCREW_STANDARDS[std]) return Object.keys(SCREW_STANDARDS[std].sizes);
  return [];
}

function populateScrewSizes(std, selected) {
  const sel = $('screwSize');
  sel.innerHTML = '';
  sel.disabled = std === 'custom';
  if (std === 'custom') return;
  for (const key of screwSizeKeys(std)) {
    const opt = document.createElement('option');
    opt.value = key;
    opt.textContent = key;
    sel.appendChild(opt);
  }
  if (selected && screwSizeKeys(std).includes(selected)) sel.value = selected;
}

function screwFitNote(screw, d) {
  if (!screw || screw.std === 'custom') return '';
  if (screw.std === 'insert') {
    const s = INSERT_SIZES[screw.size];
    if (!s) return '';
    const dStr = state.units === 'in' ? `${formatLength(d, 'in')}" (${d} mm)` : `${d} mm`;
    return `${screw.size} heat-set insert: blind pocket ⌀${dStr}, ` +
      `recommended hole for a ⌀${s.hole} mm / ${s.length} mm insert. ` +
      `Sized to melt in — not the screw-bore rule; check your insert brand's spec.`;
  }
  const s = screwSpec(screw.std, screw.size);
  if (!s) return '';
  const dStr = state.units === 'in' ? `${formatLength(d, 'in')}" (${d} mm)` : `${d} mm`;
  const nom = s.d.toFixed(2), halfP = (s.p / 2).toFixed(2);
  if (screw.fit === 'tap') {
    const tapDrill = (s.d - s.p).toFixed(2);
    return `${screw.size} thread-into-print: ⌀${dStr} = ${nom} − ${halfP} mm (½ pitch). ` +
      `Looser on purpose than the ${tapDrill} tap drill — a screw self-threads ` +
      `into a print more easily than a tap cuts.`;
  }
  return `${screw.size} clearance: ⌀${dStr} = ${nom} + ${halfP} mm (½ pitch).`;
}

function syncHolePanel() {
  const selected = traceEditor.selectedCircle();
  const show = !!selected || traceEditor.mode === 'addhole';
  $('holeProps').hidden = !show;
  if (!show) return;
  const c = selected || traceEditor.holeTemplate;

  $('holePropsTitle').textContent = selected ? 'Selected hole' : 'New hole';
  $('holeXYRow').hidden = !selected;
  if (selected) {
    $('circleX').value = fmtDim(c.cx);
    $('circleY').value = fmtDim(c.cy);
  }

  const screw = c.screw || { std: 'custom', size: '', fit: 'clearance' };
  $('screwStd').value = screw.std;
  populateScrewSizes(screw.std, screw.size);
  $('screwFitField').hidden = screw.std === 'custom' || screw.std === 'insert';
  $('screwFit').value = screw.fit;
  $('circleD').value = fmtDim(c.d);

  $('holeType').value = c.type || 'through';
  $('holeSide').value = c.side || 'top';
  $('holeSideField').style.visibility = c.type === 'through' ? 'hidden' : 'visible';
  $('holeDepthField').hidden = c.type !== 'blind';
  $('csRow').hidden = c.type !== 'cs';
  $('cbRow').hidden = c.type !== 'cb';
  if (c.type === 'blind') $('holeDepth').value = fmtDim(c.depth);
  if (c.type === 'cs') { $('csDia').value = fmtDim(c.csDia); $('csAngle').value = c.csAngle; }
  if (c.type === 'cb') { $('cbDia').value = fmtDim(c.cbDia); $('cbDepth').value = fmtDim(c.cbDepth); }

  // Rim treatments only apply where the hole actually opens, and a
  // countersink already breaks its own face's edge.
  const onTop = (c.side || 'top') !== 'bottom';
  const openTop = !(c.type === 'blind' && !onTop) && !(c.type === 'cs' && onTop);
  const openBottom = !(c.type === 'blind' && onTop) && !(c.type === 'cs' && !onTop);
  $('holeEdgeTopRow').hidden = !openTop;
  $('holeEdgeBottomRow').hidden = !openBottom;
  const eT = c.edgeTop || { mode: 'none', size: 0.5 };
  const eB = c.edgeBottom || { mode: 'none', size: 0.5 };
  $('holeEdgeTopMode').value = eT.mode;
  $('holeEdgeTopSize').value = fmtDim(eT.size);
  $('holeEdgeBottomMode').value = eB.mode;
  $('holeEdgeBottomSize').value = fmtDim(eB.size);

  $('holeFitNote').textContent = screwFitNote(screw, c.d);
}

// Apply the screw selection: derive bore ⌀ and recess/insert defaults.
function applyScrewSelection() {
  const std = $('screwStd').value;
  if (std === 'custom') {
    applyHoleProps({ screw: { std: 'custom', size: '', fit: 'clearance' } });
    syncHolePanel();
    return;
  }
  let size = $('screwSize').value;
  const keys = screwSizeKeys(std);
  if (!keys.includes(size)) size = keys[0];

  if (std === 'insert') {
    const ins = insertHole(size);
    applyHoleProps({
      screw: { std, size, fit: 'clearance' },
      d: ins.bore, type: 'blind', depth: ins.depth,
    });
    syncHolePanel();
    return;
  }

  const fit = $('screwFit').value;
  applyHoleProps({
    screw: { std, size, fit },
    d: boreDiameter(std, size, fit),
    ...recessDefaults(std, size),
  });
  syncHolePanel();
}

// ---------- step 3: mesh ----------

let meshTimer = null;
function rebuildMesh(fit = false) {
  clearTimeout(meshTimer);
  meshTimer = setTimeout(() => {
    const { outer, holes, circles } = traceEditor.getTrace();
    if (!outer || outer.length < 3) return;

    const q = QUALITY_PRESETS[state.model.quality] || QUALITY_PRESETS.medium;
    let mesh = null;
    try {
      mesh = buildModel(outer, holes, circles, state.regions, {
        arcSegments: state.model.arcSegments, chordTol: q.chordTol,
      });
    } catch (err) {
      console.error('buildModel failed', err);
    }
    state.meshData = mesh;
    if (!mesh) {
      $('meshInfo').textContent = '';
      $('meshWarn').hidden = false;
      $('meshWarn').textContent = 'Could not build the solid — check the outline.';
      if (viewer) viewer.setMesh(null);
      return;
    }
    const warns = [];
    if (mesh.stats.clamped) {
      warns.push('Chamfer/fillet was too large for part of an outline — flattened there.');
    }
    warns.push(...(mesh.stats.warnings || []));
    $('meshWarn').hidden = !warns.length;
    $('meshWarn').textContent = warns.join('\n');
    renderMeshInfo();
    if (viewer) viewer.setMesh(mesh, fit);
  }, 120);
}

function renderMeshInfo() {
  const mesh = state.meshData;
  if (!mesh) { $('meshInfo').textContent = ''; return; }
  const s = mesh.stats;
  $('meshInfo').textContent =
    `Size: ${fmtDim(s.sizeX)} × ${fmtDim(s.sizeY)} × ${fmtDimL(s.sizeZ)}\n` +
    `Triangles: ${s.triangles}` +
    (s.sections > 1 ? `\nSections: ${s.sections}` : '') +
    (s.islands > s.sections ? `\nParts: ${s.islands}` : '');
}

// ---------- wiring: step 1 ----------

const sizeSel = $('paperSize');
for (const [key, val] of Object.entries(PAPER_SIZES)) {
  const opt = document.createElement('option');
  opt.value = key;
  opt.textContent = val.name;
  sizeSel.appendChild(opt);
}
sizeSel.value = state.paper.size;

sizeSel.addEventListener('change', () => {
  state.paper.size = sizeSel.value;
  $('customSizeRow').hidden = sizeSel.value !== 'custom';
  state.rectDirty = true;
});
$('paperOrient').addEventListener('change', e => {
  state.paper.orientation = e.target.value;
  state.rectDirty = true;
});
$('customW').addEventListener('change', e => {
  const mm = parseDim(e.target.value);
  if (mm > 10) state.paper.customW = mm;
  e.target.value = fmtDim(state.paper.customW);
  state.rectDirty = true;
});
$('customH').addEventListener('change', e => {
  const mm = parseDim(e.target.value);
  if (mm > 10) state.paper.customH = mm;
  e.target.value = fmtDim(state.paper.customH);
  state.rectDirty = true;
});

// Coin reference controls
const coinSel = $('coinSize');
for (const [key, val] of Object.entries(COIN_SIZES)) {
  const opt = document.createElement('option');
  opt.value = key; opt.textContent = val.name;
  coinSel.appendChild(opt);
}
coinSel.value = state.coin.size;
coinSel.addEventListener('change', () => {
  state.coin.size = coinSel.value;
  $('coinCustomRow').hidden = coinSel.value !== 'coin_custom';
  state.rectDirty = true;
});
$('coinCustomDia').addEventListener('change', e => {
  const mm = parseDim(e.target.value);
  if (mm > 1) state.coin.customD = mm;
  e.target.value = fmtDim(state.coin.customD);
  state.rectDirty = true;
});

$('refType').addEventListener('change', e => {
  state.reference = e.target.value;
  const coin = state.reference === 'coin';
  $('rectRefControls').hidden = coin;
  $('coinRefControls').hidden = !coin;
  $('panel1').querySelector('h2').textContent = coin ? 'Photo & reference' : 'Photo & reference';
  cornerEditor.setRefMode(coin ? 'coin' : 'corners');
  if (state.image) {
    if (coin && !cornerEditor.getCoin()) cornerEditor.setRefMode('coin');
    if (!coin && !state.corners) autoDetect(false);
  }
  state.rectDirty = true;
});

// Rotate the source photo 90° in step 1, carrying the corners (or coin) with
// it. 90° rotation of the bitmap is lossless. Lets a sideways photo be
// uprighted before/while placing corners.
function rotatePhoto(dir) {
  if (!state.image) { toast('Load a photo first.'); return; }
  const cur = state.image;
  const W = cur.naturalWidth || cur.width, H = cur.naturalHeight || cur.height;
  const cw = dir === 'cw';
  const out = document.createElement('canvas');
  out.width = H; out.height = W;
  const ctx = out.getContext('2d');
  if (cw) { ctx.translate(out.width, 0); ctx.rotate(Math.PI / 2); }
  else { ctx.translate(0, out.height); ctx.rotate(-Math.PI / 2); }
  ctx.drawImage(cur, 0, 0);
  const map = p => cw ? { x: H - p.y, y: p.x } : { x: p.y, y: W - p.x };

  state.image = out;
  cornerEditor.setImage(out);
  if (state.reference === 'coin') {
    const coin = cornerEditor.getCoin();
    if (coin) { const m = map({ x: coin.cx, y: coin.cy }); cornerEditor.setCoin({ cx: m.x, cy: m.y, r: coin.r }); }
  } else if (state.corners) {
    state.corners = state.corners.map(map);
    cornerEditor.setCorners(state.corners);
  }
  state.rectDirty = true;
}
$('rotatePhotoLeftBtn').addEventListener('click', () => rotatePhoto('ccw'));
$('rotatePhotoRightBtn').addEventListener('click', () => rotatePhoto('cw'));

$('fileInput').addEventListener('change', e => loadFile(e.target.files[0]));
$('detectBtn').addEventListener('click', () => autoDetect(true));
$('resetCornersBtn').addEventListener('click', () => {
  state.corners = defaultCorners();
  state.rectDirty = true;
  cornerEditor.setCorners(state.corners);
});
$('toTraceBtn').addEventListener('click', () => goStep(2));

// Drag & drop
const stage1 = $('stage1');
for (const ev of ['dragenter', 'dragover']) {
  stage1.addEventListener(ev, e => { e.preventDefault(); $('dropHint').classList.add('dragover'); });
}
for (const ev of ['dragleave', 'drop']) {
  stage1.addEventListener(ev, e => { e.preventDefault(); $('dropHint').classList.remove('dragover'); });
}
stage1.addEventListener('drop', e => {
  const file = e.dataTransfer.files && e.dataTransfer.files[0];
  if (file) loadFile(file);
});

// ---------- wiring: step 2 ----------

function bindSlider(id, valId, fmt, apply) {
  const el = $(id);
  const update = () => {
    $(valId).textContent = fmt(parseFloat(el.value));
    apply(parseFloat(el.value));
  };
  el.addEventListener('input', update);
  update();
}

let retraceTimer = null;
const debouncedRetrace = () => {
  clearTimeout(retraceTimer);
  retraceTimer = setTimeout(retrace, 140);
};

bindSlider('threshSlider', 'threshVal', v => v.toFixed(0), v => {
  if (state.seg.threshold !== v) {
    state.seg.threshold = v;
    state.seg.autoThreshold = false;
    if (state.rect) debouncedRetrace();
  }
});
bindSlider('cleanupSlider', 'cleanupVal', v => v.toFixed(0) + ' px', v => {
  if (state.seg.cleanup !== v) { state.seg.cleanup = v; if (state.rect) debouncedRetrace(); }
});
bindSlider('simplifySlider', 'simplifyVal', v => (v / 10).toFixed(1), v => {
  const mm = v / 10;
  if (state.seg.simplify !== mm) { state.seg.simplify = mm; if (state.rect) debouncedRetrace(); }
});
bindSlider('smoothSlider', 'smoothVal', v => v.toFixed(0) + '×', v => {
  if (state.seg.smooth !== v) { state.seg.smooth = v; if (state.rect) debouncedRetrace(); }
});

$('threshAutoBtn').addEventListener('click', () => {
  state.seg.autoThreshold = true;
  if (state.diffMap) {
    state.seg.threshold = otsuThreshold(state.diffMap.diff);
    $('threshSlider').value = state.seg.threshold;
    $('threshVal').textContent = state.seg.threshold;
    retrace();
  }
});
$('detectHoles').addEventListener('change', e => {
  state.seg.detectHoles = e.target.checked;
  if (state.rect) retrace();
});
$('showMask').addEventListener('change', e => {
  traceEditor.showMask = e.target.checked;
  traceEditor.draw();
});
$('retraceBtn').addEventListener('click', () => retrace());

for (const btn of document.querySelectorAll('.tool-btn')) {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tool-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    traceEditor.setMode(btn.dataset.tool);
    syncHolePanel();
    $('measurePanel').hidden = btn.dataset.tool !== 'measure';
    $('constrainPanel').hidden = btn.dataset.tool !== 'constrain';
    if (btn.dataset.tool === 'measure') refreshMeasurePanel();
    if (btn.dataset.tool === 'constrain') { refreshConstrainButtons(); refreshConstraintList(); }
  });
}

// ---------- measure + constrain panels ----------

function annoRow(text, onDelete) {
  const row = document.createElement('div');
  row.className = 'anno-row';
  const span = document.createElement('span');
  span.className = 'anno-text';
  span.textContent = text;
  const del = document.createElement('button');
  del.className = 'anno-del';
  del.textContent = '✕';
  del.title = 'Remove';
  del.addEventListener('click', onDelete);
  row.append(span, del);
  return row;
}

function refreshMeasurePanel() {
  if ($('measurePanel').hidden) return;
  // Part-level readout: overall size + outline perimeter/area.
  const { outer } = traceEditor.getTrace();
  const stats = loopStats(outer);
  const areaTxt = a => state.units === 'in'
    ? `${(a / (25.4 * 25.4)).toFixed(2)} in²` : `${a.toFixed(0)} mm²`;
  $('measurePartInfo').textContent = !stats ? '' :
    `Part: ${fmtDim(stats.bbox.w)} × ${fmtDimL(stats.bbox.h)}\n` +
    `Outline: ${fmtDimL(stats.perimeter)} · ${areaTxt(stats.area)}`;

  const list = $('measureList');
  list.innerHTML = '';
  const geo = traceEditor._geo();
  traceEditor.measurements.forEach((m, i) => {
    const info = measureInfo(m, geo);
    let text = '(stale)';
    if (info) {
      if (info.type === 'p2p') text = `↔ ${fmtDimL(info.d)}  (Δx ${fmtDim(info.dx)}, Δy ${fmtDim(info.dy)})`;
      else if (info.type === 'p2e') text = `⟂ ${fmtDimL(info.d)} to edge`;
      else if (info.type === 'elen') text = `— edge ${fmtDimL(info.d)}`;
      else if (info.type === 'e2e') {
        text = `∠ ${info.angle.toFixed(1)}°` + (info.gap !== null ? ` · gap ${fmtDimL(info.gap)}` : '');
      } else if (info.type === 'rad') text = `⌀ ${fmtDimL(info.r * 2)}  (r ${fmtDim(info.r)})`;
    }
    list.appendChild(annoRow(text, () => traceEditor.removeMeasurement(i)));
  });
}

$('measureClearBtn').addEventListener('click', () => traceEditor.clearMeasurements());

const CON_LABELS = {
  h: 'Horizontal', v: 'Vertical', perp: '⊥ Perpendicular', para: '∥ Parallel',
  equal: '= Equal length', collin: '⋯ Collinear', conc: '◎ Concentric',
  ltan: '◠ Edge tangent to ⌀', anchor: '⚓ Anchor',
  len: 'Length', angle: 'Angle', dist: 'Distance',
};

function refreshConstraintList() {
  if ($('constrainPanel').hidden) return;
  const list = $('constraintList');
  list.innerHTML = '';
  traceEditor.constraints.forEach((c, i) => {
    let text = CON_LABELS[c.type] || c.type;
    if (c.type === 'len' || c.type === 'dist') text += ` ${fmtDimL(c.value)}`;
    if (c.type === 'angle') text += ` ${c.value}°`;
    list.appendChild(annoRow(text, () => { traceEditor.removeConstraint(i); }));
  });
}

// Which constraint buttons make sense for the current picks.
function refreshConstrainButtons() {
  if ($('constrainPanel').hidden) return;
  const picks = traceEditor.getPicks();
  const isCirc = r => r.kind === 'circle' || r.kind === 'center';
  const edges = picks.filter(r => r.kind === 'edge').length;
  const pts = picks.filter(r => r.kind === 'vert' || isCirc(r)).length;
  const tangentTargets = picks.filter(r => isCirc(r) || r.kind === 'arcent').length;
  const n = picks.length;
  $('conH').disabled = $('conV').disabled = $('conLen').disabled = !(n === 1 && edges === 1);
  $('conAnchor').disabled = !(n === 1 && (picks[0].kind === 'vert' || isCirc(picks[0])));
  $('conPerp').disabled = $('conPara').disabled = $('conEqual').disabled =
    $('conCollin').disabled = $('conAngle').disabled = !(n === 2 && edges === 2);
  $('conConc').disabled = !(n === 2 && picks.every(isCirc));
  // Edge + (circle OR fillet arc) → tangent.
  $('conLtan').disabled = !(n === 2 && edges === 1 && tangentTargets === 1);
  $('conDist').disabled = !(n === 2 && edges <= 1 && pts >= 1 && pts + edges === 2);
  const label = r => r.kind === 'edge' ? 'edge' : r.kind === 'vert' ? 'point'
    : r.kind === 'arcent' ? 'arc' : 'hole';
  $('pickInfo').textContent = !n ? 'Nothing picked.'
    : picks.map(label).join(' + ') + ' picked';
  if (!n) $('conValueField').hidden = true;
}

for (const [id, type] of [
  ['conH', 'h'], ['conV', 'v'], ['conPerp', 'perp'], ['conPara', 'para'],
  ['conEqual', 'equal'], ['conCollin', 'collin'], ['conConc', 'conc'],
  ['conLtan', 'ltan'], ['conAnchor', 'anchor'],
]) {
  $(id).addEventListener('click', () => {
    if (!traceEditor.addConstraintFromPicks(type)) toast('That pick doesn’t fit this constraint.');
  });
}

// Dimension constraints prompt for a value, prefilled with the measured one.
let pendingDimType = null;
for (const [id, type, label] of [
  ['conLen', 'len', 'Length'], ['conAngle', 'angle', 'Angle (°)'], ['conDist', 'dist', 'Distance'],
]) {
  $(id).addEventListener('click', () => {
    const v = traceEditor.picksValue();
    if (!v) return;
    pendingDimType = type;
    $('conValueLabel').textContent = type === 'angle' ? label : `${label} (${state.units})`;
    $('conValueInput').value = type === 'angle'
      ? (Math.round(v.angle * 10) / 10) : fmtDim(v.len ?? v.dist);
    $('conValueField').hidden = false;
    $('conValueInput').focus();
    $('conValueInput').select();
  });
}

function applyDimConstraint() {
  if (!pendingDimType) return;
  const raw = $('conValueInput').value;
  const value = pendingDimType === 'angle' ? parseFloat(raw) : parseDim(raw);
  if (!isFinite(value) || value < 0) { toast('Enter a valid value.'); return; }
  if (traceEditor.addConstraintFromPicks(pendingDimType, value)) {
    pendingDimType = null;
    $('conValueField').hidden = true;
  } else {
    toast('That pick doesn’t fit this constraint.');
  }
}
$('conValueApply').addEventListener('click', applyDimConstraint);
$('conValueInput').addEventListener('keydown', e => {
  if (e.key === 'Enter') { e.preventDefault(); applyDimConstraint(); }
  e.stopPropagation();
});

$('conSolveBtn').addEventListener('click', () => {
  if (!traceEditor.constraints.length) { toast('No constraints yet.'); return; }
  traceEditor.pushUndo();
  const res = traceEditor.solveNow();
  traceEditor.draw();
  updateTraceInfo();
  if (res && !res.converged) toast('Solver did not fully converge — constraints may conflict.');
});
$('conClearBtn').addEventListener('click', () => traceEditor.clearConstraints());

$('undoBtn').addEventListener('click', () => {
  if (!traceEditor.undo()) toast('Nothing to undo.');
});
$('deleteSelBtn').addEventListener('click', () => traceEditor.deleteSelected());
$('deleteHoleBtn').addEventListener('click', () => traceEditor.deleteSelectedHole());

$('screwStd').addEventListener('change', applyScrewSelection);
$('screwSize').addEventListener('change', applyScrewSelection);
$('screwFit').addEventListener('change', applyScrewSelection);

for (const [id, prop] of [['circleX', 'cx'], ['circleY', 'cy']]) {
  $(id).addEventListener('change', e => {
    const mm = parseDim(e.target.value);
    if (mm !== null && isFinite(mm)) traceEditor.updateSelectedCircle({ [prop]: mm });
    syncHolePanel();
  });
}

// Typing a bore ⌀ — in the sidebar or in the on-canvas tag. A hand-typed
// value means the screw preset no longer applies.
function applyTypedBore(raw) {
  const mm = parseDim(raw);
  if (!(mm > 0.1)) { syncHolePanel(); positionHoleTag(); return; }
  applyHoleProps({ d: Math.round(mm * 20) / 20, screw: { std: 'custom', size: '', fit: 'clearance' } });
  syncHolePanel();
  positionHoleTag();
}
$('circleD').addEventListener('change', e => applyTypedBore(e.target.value));
$('holeTagInput').addEventListener('change', e => applyTypedBore(e.target.value));
$('holeTagInput').addEventListener('keydown', e => {
  if (e.key === 'Enter') { e.preventDefault(); applyTypedBore(e.target.value); e.target.blur(); }
  e.stopPropagation(); // keep Delete/Backspace from hitting canvas shortcuts
});

$('holeType').addEventListener('change', e => {
  const c = activeHole();
  const type = e.target.value;
  const props = { type };
  const rd = c.screw && c.screw.std !== 'custom'
    ? recessDefaults(c.screw.std, c.screw.size) : null;
  if (type === 'blind' && !(c.depth > 0)) props.depth = 3;
  if (type === 'cs' && !(c.csDia > c.d)) {
    props.csDia = rd ? rd.csDia : Math.round(c.d * 2 * 10) / 10;
    props.csAngle = rd ? rd.csAngle : 90;
  }
  if (type === 'cb' && !(c.cbDia > c.d)) {
    props.cbDia = rd ? rd.cbDia : Math.round(c.d * 1.8 * 10) / 10;
    props.cbDepth = rd ? rd.cbDepth : Math.max(1, Math.round(c.d * 0.6 * 10) / 10);
  }
  applyHoleProps(props);
  syncHolePanel();
});
$('holeSide').addEventListener('change', e => {
  applyHoleProps({ side: e.target.value });
  syncHolePanel();
});

for (const [face, modeId, sizeId] of [
  ['edgeTop', 'holeEdgeTopMode', 'holeEdgeTopSize'],
  ['edgeBottom', 'holeEdgeBottomMode', 'holeEdgeBottomSize'],
]) {
  const apply = () => {
    const size = parseDim($(sizeId).value);
    applyHoleProps({
      [face]: { mode: $(modeId).value, size: size > 0 ? size : 0.5 },
    });
    syncHolePanel();
  };
  $(modeId).addEventListener('change', apply);
  $(sizeId).addEventListener('change', apply);
}

$('showPoints').addEventListener('change', e => {
  traceEditor.showPoints = e.target.checked;
  traceEditor.draw();
});

// ---------- rotate the trace + rectified image 90° (step 2) ----------
// Rotates the backdrop and every geometry coordinate together so the trace
// stays aligned. pxPerMm is unchanged; the trace space just swaps W/H.
function rotateView(dir) {
  if (!state.rect) { toast('Load and rectify a photo first.'); return; }
  const { canvas, pxPerMm } = state.rect;
  const Wmm = canvas.width / pxPerMm, Hmm = canvas.height / pxPerMm;
  const cw = dir === 'cw';
  const map = p => cw ? { x: Hmm - p.y, y: p.x } : { x: p.y, y: Wmm - p.x };

  // Rotate the backdrop bitmap.
  const out = document.createElement('canvas');
  out.width = canvas.height; out.height = canvas.width;
  const octx = out.getContext('2d');
  if (cw) { octx.translate(out.width, 0); octx.rotate(Math.PI / 2); }
  else { octx.translate(0, out.height); octx.rotate(-Math.PI / 2); }
  octx.drawImage(canvas, 0, 0);

  // Rotate all geometry.
  const { outer, holes, circles } = traceEditor.getTrace();
  const rotOuter = outer.map(map);
  const rotHoles = holes.map(h => h.map(map));
  const rotCircles = circles.map(c => {
    const m = map({ x: c.cx, y: c.cy });
    return { ...c, cx: m.x, cy: m.y };
  });
  for (let s = 1; s < state.regions.length; s++) {
    if (state.regions[s].pts) state.regions[s].pts = state.regions[s].pts.map(map);
  }
  // Managed-line stashes hold outline-space points too — rotate them with it
  // so Restore lands them correctly. (Arcs store no coordinates.)
  for (const l of traceEditor.lines) if (l.stash) l.stash = l.stash.map(map);

  state.rect = { canvas: out, pxPerMm };
  state.diffMap = computeDiffMap(out);
  traceEditor.showMask = false;
  $('showMask').checked = false;
  traceEditor.setMaskOverlay(null);
  traceEditor.setRectified(out, pxPerMm);
  // Index-preserving replacement — measurements/constraints survive.
  traceEditor.setTrace(rotOuter, rotHoles, false, true);
  traceEditor.setCircles(rotCircles);
  traceEditor.setSections(state.regions);
  refreshModelFields();
  updateTraceInfo();
  traceEditor.draw();
}
$('rotateLeftBtn').addEventListener('click', () => rotateView('ccw'));
$('rotateRightBtn').addEventListener('click', () => rotateView('cw'));

// ---------- lens-distortion correction (rectangle path) ----------
let lensTimer = null;
function reRectifyLens() {
  clearTimeout(lensTimer);
  lensTimer = setTimeout(() => {
    // Re-rectify from the original photo with the new coefficient, then retrace.
    if (!state.image || state.reference !== 'rect') return;
    state.rectDirty = true;
    if (doRectify()) retrace();
  }, 160);
}
$('lensSlider').addEventListener('input', e => {
  state.lens.k1 = parseInt(e.target.value, 10) / 1000;
  $('lensVal').textContent = state.lens.k1.toFixed(3);
  reRectifyLens();
});
$('lensAutoBtn').addEventListener('click', () => {
  if (!state.image || state.reference !== 'rect') { toast('Auto-straighten needs a rectangle reference.'); return; }
  let est = null;
  try { est = estimateDistortion(state.image, state.corners); }
  catch (err) { console.error('estimateDistortion failed', err); }
  if (!est) { toast('Could not read the paper edges — adjust the slider by eye instead.'); return; }
  state.lens.k1 = est.k1;
  $('lensSlider').value = Math.round(est.k1 * 1000);
  $('lensVal').textContent = est.k1.toFixed(3);
  reRectifyLens();
  toast(est.improved > 0.05
    ? `Auto-straightened (k=${est.k1.toFixed(3)}, edges ${Math.round(est.improved * 100)}% straighter).`
    : `Little distortion detected (k=${est.k1.toFixed(3)}).`);
});

$('normalizeBtn').addEventListener('click', () => {
  const fit = traceEditor.convertSelectedToCircle();
  if (fit) {
    toast(`Hole normalized to ⌀${fmtDimL(fit.r * 2)} (fit ±${fit.rms.toFixed(2)} mm).`);
  } else {
    toast('Select a traced (photo-detected) hole first — click inside it or on one of its points.');
  }
});
$('normalizeAllBtn').addEventListener('click', () => {
  const n = traceEditor.convertAllRoundHoles();
  toast(n ? `${n} traced hole${n > 1 ? 's' : ''} normalized to perfect circles.`
          : 'No round-enough traced holes found.');
});
$('detectFilletsBtn').addEventListener('click', () => {
  const n = traceEditor.detectFillets();
  toast(n ? `${n} rounded corner${n > 1 ? 's' : ''} converted to live fillet arcs.`
          : 'No clean rounded corners found to convert.');
  refreshSelectionTools();
});

// Multi-select selection tools.
function refreshSelectionTools() {
  const count = traceEditor.selectedVerts.length;
  $('selCount').textContent = count ? `${count} points` : '';
  const run3 = traceEditor.hasMultiRun(3);
  const run2 = traceEditor.hasMultiRun(2);
  $('fitArcBtn').disabled = !run3;
  $('fitLineBtn').disabled = !run3;
  $('tangentBtn').disabled = !run3;
  $('simplifySelBtn').disabled = !run3;
  $('densifyBtn').disabled = !run2;
  $('straightenBtn').disabled = !run2;
  $('clearSelBtn').disabled = !count;
  if (!count) $('arcRadiusField').hidden = true;
  // Reflect whether the current selection is a live tangent fillet arc.
  const liveArc = !!traceEditor._selectedArc();
  $('releaseArcBtn').hidden = !liveArc;
  $('arcLiveNote').hidden = !liveArc;
  if (liveArc) {
    $('arcRadiusField').hidden = false;
    $('arcRadius').value = fmtDim(traceEditor._selectedArc().r);
  }
  // Managed straight line under the selection → offer Restore points.
  $('releaseLineBtn').hidden = !traceEditor._selectedLine();
}
$('fitArcBtn').addEventListener('click', () => {
  const r = traceEditor.fitArcToSelection();
  if (r) {
    $('arcRadiusField').hidden = false;
    $('arcRadius').value = fmtDim(r);
    toast(`Fitted arc, radius ${fmtDimL(r)}.`);
  } else {
    toast('Select a run of 3+ points on one outline first.');
  }
  refreshSelectionTools();
});
$('arcRadius').addEventListener('change', e => {
  const mm = parseDim(e.target.value);
  if (mm > 0 && traceEditor.setArcRadius(mm)) {
    $('arcRadius').value = fmtDim(mm);
  }
});
$('releaseArcBtn').addEventListener('click', () => {
  if (traceEditor.releaseSelectedArc()) {
    toast('Fillet released to editable points.');
    refreshSelectionTools();
  }
});
$('straightenBtn').addEventListener('click', () => {
  const res = traceEditor.straightenSelection();
  if (res.ok) toast(res.removed ? `Straightened — ${res.removed} point(s) stashed (Restore to undo).` : 'Segment marked straight.');
  else toast(res.reason);
  refreshSelectionTools();
});
$('releaseLineBtn').addEventListener('click', () => {
  if (traceEditor.releaseSelectedLine()) {
    toast('Points restored.');
    refreshSelectionTools();
  }
});
$('fitLineBtn').addEventListener('click', () => {
  if (!traceEditor.fitLineToSelection()) toast('Select a run of 3+ points on one outline first.');
  else $('arcRadiusField').hidden = true;
  refreshSelectionTools();
});
$('tangentBtn').addEventListener('click', () => {
  const res = traceEditor.makeTangentSelection();
  if (res.ok) {
    $('arcRadiusField').hidden = false;
    $('arcRadius').value = fmtDim(res.r);
    toast(`Tangent fillet, radius ${fmtDimL(res.r)}.`);
  } else {
    toast(res.reason);
  }
  refreshSelectionTools();
});
$('densifyBtn').addEventListener('click', () => {
  if (!traceEditor.densifySelection()) toast('Select 2+ points on one outline first.');
  refreshSelectionTools();
});
$('simplifySelBtn').addEventListener('click', () => {
  if (!traceEditor.simplifySelection(0.3)) toast('Nothing to reduce in the selected run.');
  refreshSelectionTools();
});
$('clearSelBtn').addEventListener('click', () => {
  traceEditor.clearMultiSelect();
  $('arcRadiusField').hidden = true;
  refreshSelectionTools();
});
for (const [id, prop, min] of [
  ['holeDepth', 'depth', 0.2], ['csDia', 'csDia', 0.5],
  ['cbDia', 'cbDia', 0.5], ['cbDepth', 'cbDepth', 0.2],
]) {
  $(id).addEventListener('change', e => {
    const mm = parseDim(e.target.value);
    if (mm !== null && mm >= min) applyHoleProps({ [prop]: mm });
    syncHolePanel();
  });
}
$('csAngle').addEventListener('change', e => {
  const v = parseFloat(e.target.value); // degrees, not a length
  if (isFinite(v) && v >= 30 && v <= 150) applyHoleProps({ csAngle: v });
  syncHolePanel();
});

$('toModelBtn').addEventListener('click', () => goStep(3));

document.addEventListener('keydown', e => {
  if (state.step !== 2) return;
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
  if (traceEditor.mode === 'region' && e.key === 'Enter') {
    e.preventDefault();
    traceEditor.commitDraftRegion();
    return;
  }
  if (traceEditor.mode === 'region' && e.key === 'Escape') {
    traceEditor.cancelDraftRegion();
    return;
  }
  if ((traceEditor.mode === 'measure' || traceEditor.mode === 'constrain') &&
      e.key === 'Escape') {
    traceEditor.cancelPendingPick();
    return;
  }
  if (e.key === 'Escape' && traceEditor.selectedVerts.length) {
    traceEditor.clearMultiSelect();
    $('arcRadiusField').hidden = true;
    refreshSelectionTools();
    return;
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    traceEditor.undo();
  } else if (e.key === 'Delete' || e.key === 'Backspace') {
    e.preventDefault();
    traceEditor.deleteSelected();
    refreshSelectionTools();
  }
});

// ---------- wiring: step 3 ----------

function currentRegion() {
  return state.regions[state.selRegion] || state.regions[0];
}

function refreshRegionSelect() {
  const sel = $('regionSel');
  sel.innerHTML = '';
  state.regions.forEach((r, i) => {
    const opt = document.createElement('option');
    opt.value = i;
    opt.textContent = (r.name || `Section ${i + 1}`) + (i === 0 ? ' (base)' : '');
    sel.appendChild(opt);
  });
  sel.value = state.selRegion;
}

function refreshModelFields() {
  if (state.selRegion >= state.regions.length) state.selRegion = 0;
  refreshRegionSelect();
  const r = currentRegion();
  $('regionName').value = r.name || '';
  $('thickness').value = fmtDim(r.thickness);
  $('floorOffset').value = fmtDim(r.zBase || 0);
  $('topMode').value = r.top.mode;
  $('topSize').value = fmtDim(r.top.size);
  $('bottomMode').value = r.bottom.mode;
  $('bottomSize').value = fmtDim(r.bottom.size);
  $('regionDeleteBtn').disabled = state.selRegion === 0;
}

$('regionSel').addEventListener('change', e => {
  state.selRegion = parseInt(e.target.value, 10) || 0;
  refreshModelFields();
  traceEditor.draw();
});
$('regionName').addEventListener('change', e => {
  currentRegion().name = e.target.value.trim() || `Section ${state.selRegion + 1}`;
  refreshModelFields();
  traceEditor.draw();
});
$('thickness').addEventListener('change', e => {
  const mm = parseDim(e.target.value);
  if (mm > 0) { currentRegion().thickness = mm; rebuildMesh(); }
  refreshModelFields();
  traceEditor.draw();
});
$('floorOffset').addEventListener('change', e => {
  const mm = parseDim(e.target.value);
  if (mm !== null && mm >= 0) { currentRegion().zBase = mm; rebuildMesh(); }
  refreshModelFields();
  traceEditor.draw();
});
$('topMode').addEventListener('change', e => { currentRegion().top.mode = e.target.value; rebuildMesh(); });
$('bottomMode').addEventListener('change', e => { currentRegion().bottom.mode = e.target.value; rebuildMesh(); });
$('topSize').addEventListener('change', e => {
  const mm = parseDim(e.target.value);
  if (mm > 0) { currentRegion().top.size = mm; rebuildMesh(); }
  refreshModelFields();
});
$('bottomSize').addEventListener('change', e => {
  const mm = parseDim(e.target.value);
  if (mm > 0) { currentRegion().bottom.size = mm; rebuildMesh(); }
  refreshModelFields();
});
$('regionDeleteBtn').addEventListener('click', () => {
  if (state.selRegion === 0) return;
  traceEditor._refsOp({ op: 'deleteLoop', loop: REGION_LOOP_BASE + state.selRegion });
  state.regions.splice(state.selRegion, 1);
  state.selRegion = 0;
  refreshModelFields();
  traceEditor.draw();
  rebuildMesh();
});
refreshModelFields();
bindSlider('arcSlider', 'arcVal', v => v.toFixed(0) + ' seg', v => {
  if (state.model.arcSegments !== v) { state.model.arcSegments = v; if (state.step === 3) rebuildMesh(); }
});

// Export quality preset — bundles the round-feature chord tolerance and the
// chamfer/fillet arc-segment count into one choice.
(() => {
  const sel = $('qualitySel');
  for (const [key, q] of Object.entries(QUALITY_PRESETS)) {
    const opt = document.createElement('option');
    opt.value = key; opt.textContent = q.label;
    sel.appendChild(opt);
  }
  sel.value = state.model.quality;
  sel.addEventListener('change', () => {
    state.model.quality = sel.value;
    const q = QUALITY_PRESETS[sel.value];
    state.model.arcSegments = q.arcSegments;
    $('arcSlider').value = q.arcSegments;
    $('arcVal').textContent = q.arcSegments + ' seg';
    if (state.step === 3) rebuildMesh();
  });
})();

// Trigger the download and keep a live fallback link the user can click
// directly — a plain user-gesture click on a real anchor is the most widely
// permitted download path, and if even that does nothing the surrounding
// message explains the environment is blocking downloads.
let fallbackURL = null;
function deliverExport(blob, filename) {
  downloadBlob(blob, filename);
  if (fallbackURL) URL.revokeObjectURL(fallbackURL);
  fallbackURL = URL.createObjectURL(blob);
  const link = $('exportFallbackLink');
  link.href = fallbackURL;
  link.download = filename;
  $('exportFallbackName').textContent = filename;
  $('exportFallback').hidden = false;
}

$('exportStlBtn').addEventListener('click', () => {
  if (!state.meshData) { toast('No model to export yet.'); return; }
  const blob = toBinarySTL(state.meshData.positions, state.meshData.indices, state.fileName);
  deliverExport(blob, `${state.fileName}-2p5d.stl`);
});
// Arc-aware 2D export inputs: traced holes stay polylines (with any fillet
// arcs), while manual screw holes become true circles. Screw bores flatten to
// their nominal bore diameter (recesses/depth are 3D-only).
function traceProfile() {
  const { outer, holes, circles } = traceEditor.getTrace();
  if (!outer || outer.length < 3) return null;
  const spans = traceEditor.arcExportSpans();
  return {
    outer, holes,
    opts: {
      outerArcs: spans.outer,
      holeArcs: spans.holes,
      circles: circles.map(c => ({ cx: c.cx, cy: c.cy, d: c.d })),
    },
  };
}
// Trace-space extent in mm: the rectified canvas size (correct after a 90°
// rotation), falling back to the nominal paper size.
function traceSpaceDims() {
  if (state.rect) {
    return { w: state.rect.canvas.width / state.rect.pxPerMm, h: state.rect.canvas.height / state.rect.pxPerMm };
  }
  return currentPaper();
}
$('exportSvgBtn').addEventListener('click', () => {
  const p = traceProfile();
  if (!p) { toast('No trace to export yet.'); return; }
  const { w, h } = traceSpaceDims();
  deliverExport(toSVG(p.outer, p.holes, w, h, p.opts), `${state.fileName}-outline.svg`);
});
$('exportDxfBtn').addEventListener('click', () => {
  const p = traceProfile();
  if (!p) { toast('No trace to export yet.'); return; }
  const { h } = traceSpaceDims();
  deliverExport(toDXF(p.outer, p.holes, h, p.opts), `${state.fileName}-outline.dxf`);
});

// ---------- project save / move / load ----------
// The whole working state as JSON: paper + corners, trace, holes, model
// settings, and the rectified image (so editing continues without the photo).
// This is also the escape hatch for environments that block downloads (the
// Claude artifact): copy the JSON out, paste it into a local copy, export.

function imageToDataURL(img, type = 'image/jpeg', q = 0.9) {
  const c = document.createElement('canvas');
  c.width = img.naturalWidth || img.width;
  c.height = img.naturalHeight || img.height;
  c.getContext('2d').drawImage(img, 0, 0);
  return c.toDataURL(type, q);
}

function serializeProject(includePhoto) {
  return JSON.stringify({
    app: '2.5D', version: 1,
    fileName: state.fileName,
    units: state.units,
    reference: state.reference,
    paper: state.paper,
    coin: state.coin,
    lens: state.lens,
    corners: state.corners,
    seg: state.seg,
    model: state.model,
    regions: state.regions,
    trace: traceEditor.getTrace(),
    measurements: traceEditor.measurements,
    constraints: traceEditor.constraints,
    arcs: traceEditor.arcs,
    lines: traceEditor.lines,
    holeTemplate: traceEditor.holeTemplate,
    pxPerMm: state.rect ? state.rect.pxPerMm : null,
    rectified: state.rect ? state.rect.canvas.toDataURL('image/jpeg', 0.85) : null,
    photo: includePhoto && state.image ? imageToDataURL(state.image) : null,
  });
}

function loadProject(p) {
  if (!p || (p.app && p.app !== '2.5D')) { toast('Not a 2.5D project.'); return; }
  if (!p.trace && !p.corners) { toast('Project has no trace or corners to load.'); return; }

  if (p.fileName) state.fileName = p.fileName;
  if (p.units === 'mm' || p.units === 'in') {
    state.units = p.units;
    document.querySelectorAll('#unitToggle button')
      .forEach(b => b.classList.toggle('active', b.dataset.unit === state.units));
    relabelUnits();
  }
  if (p.paper) {
    state.paper = { ...state.paper, ...p.paper };
    sizeSel.value = state.paper.size;
    $('paperOrient').value = state.paper.orientation;
    $('customSizeRow').hidden = state.paper.size !== 'custom';
    $('customW').value = fmtDim(state.paper.customW);
    $('customH').value = fmtDim(state.paper.customH);
  }
  if (p.coin) { state.coin = { ...state.coin, ...p.coin }; $('coinSize').value = state.coin.size; }
  if (p.lens) { state.lens = { k1: p.lens.k1 || 0, k2: p.lens.k2 || 0 }; }
  if (p.reference === 'rect' || p.reference === 'coin') {
    state.reference = p.reference;
    $('refType').value = p.reference;
    $('rectRefControls').hidden = p.reference === 'coin';
    $('coinRefControls').hidden = p.reference !== 'coin';
    cornerEditor.setRefMode(p.reference === 'coin' ? 'coin' : 'corners');
  }
  if (p.seg) {
    state.seg = { ...state.seg, ...p.seg };
    $('threshSlider').value = state.seg.threshold;
    $('threshVal').textContent = state.seg.threshold;
    $('cleanupSlider').value = state.seg.cleanup;
    $('simplifySlider').value = Math.round(state.seg.simplify * 10);
    $('smoothSlider').value = state.seg.smooth;
    $('detectHoles').checked = state.seg.detectHoles;
  }
  if (p.model && p.model.arcSegments) {
    state.model.arcSegments = p.model.arcSegments;
    $('arcSlider').value = state.model.arcSegments;
  }
  if (p.model && QUALITY_PRESETS[p.model.quality]) {
    state.model.quality = p.model.quality;
    $('qualitySel').value = p.model.quality;
  }
  if (Array.isArray(p.regions) && p.regions.length) {
    // Restore sections in place (the array is shared with the editor).
    state.regions.length = 0;
    for (const r of p.regions) state.regions.push(structuredClone(r));
    state.regions[0].pts = null; // base always follows the traced outline
  } else if (p.model && p.model.thickness) {
    // Legacy single-thickness project.
    state.regions[0].thickness = p.model.thickness;
    if (p.model.top) state.regions[0].top = structuredClone(p.model.top);
    if (p.model.bottom) state.regions[0].bottom = structuredClone(p.model.bottom);
  }
  state.selRegion = 0;
  refreshModelFields();

  const applyTrace = () => {
    if (p.trace) {
      traceEditor.setTrace(p.trace.outer || [], p.trace.holes || []);
      traceEditor.setCircles(p.trace.circles || []);
      traceEditor.measurements = Array.isArray(p.measurements) ? structuredClone(p.measurements) : [];
      traceEditor.constraints = Array.isArray(p.constraints) ? structuredClone(p.constraints) : [];
      traceEditor.arcs = Array.isArray(p.arcs) ? structuredClone(p.arcs) : [];
      traceEditor.lines = Array.isArray(p.lines) ? structuredClone(p.lines) : [];
      traceEditor._ensureArcIds();
      traceEditor.draw();
    }
    if (p.holeTemplate) traceEditor.holeTemplate = structuredClone(p.holeTemplate);
    updateStepButtons();
    updateTraceInfo();
    $('projModal').hidden = true;
    toast('Project loaded.');
    const hasTrace = p.trace && p.trace.outer && p.trace.outer.length >= 3;
    goStep(hasTrace ? (state.rect ? 2 : 3) : 1);
  };

  const restoreRect = () => {
    if (p.rectified && p.pxPerMm) {
      const im = new Image();
      im.onload = () => {
        const c = document.createElement('canvas');
        c.width = im.width; c.height = im.height;
        c.getContext('2d').drawImage(im, 0, 0);
        state.rect = { canvas: c, pxPerMm: p.pxPerMm };
        state.rectDirty = false;
        state.diffMap = computeDiffMap(c);
        traceEditor.setRectified(c, p.pxPerMm);
        applyTrace();
      };
      im.onerror = applyTrace;
      im.src = p.rectified;
    } else {
      applyTrace();
    }
  };

  if (p.photo) {
    const img = new Image();
    img.onload = () => {
      state.image = img;
      $('dropHint').hidden = true;
      cornerEditor.setImage(img);
      if (p.corners) { state.corners = p.corners; cornerEditor.setCorners(p.corners); }
      state.rectDirty = !p.rectified;
      restoreRect();
    };
    img.onerror = restoreRect;
    img.src = p.photo;
  } else {
    if (p.corners) { state.corners = p.corners; cornerEditor.setCorners(p.corners); }
    restoreRect();
  }
}

function refreshProjectText() {
  $('projText').value = serializeProject($('projIncludePhoto').checked);
}

$('projectBtn').addEventListener('click', () => {
  refreshProjectText();
  refreshLibList();
  $('projModal').hidden = false;
});
$('projCloseBtn').addEventListener('click', () => { $('projModal').hidden = true; });
$('projModal').addEventListener('pointerdown', e => {
  if (e.target === $('projModal')) $('projModal').hidden = true;
});
$('projIncludePhoto').addEventListener('change', refreshProjectText);

$('projDownloadBtn').addEventListener('click', () => {
  const blob = new Blob([$('projText').value || serializeProject($('projIncludePhoto').checked)],
    { type: 'application/json' });
  downloadBlob(blob, `${state.fileName}-project.json`);
  toast('Project file download started — check your downloads folder.');
});
$('projCopyBtn').addEventListener('click', async () => {
  refreshProjectText();
  const text = $('projText').value;
  let ok = false;
  try { await navigator.clipboard.writeText(text); ok = true; } catch { /* fall through */ }
  if (!ok) {
    $('projText').focus();
    $('projText').select();
    try { ok = document.execCommand('copy'); } catch { ok = false; }
  }
  toast(ok ? 'Project copied to clipboard.'
           : 'Copy blocked — select the text above and copy manually (Ctrl+A, Ctrl+C).');
});
$('projLoadTextBtn').addEventListener('click', () => {
  try {
    loadProject(JSON.parse($('projText').value));
  } catch {
    toast('That is not valid project JSON — paste the whole text, then Load.');
  }
});
$('projFileInput').addEventListener('change', e => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try { loadProject(JSON.parse(reader.result)); }
    catch { toast('That file is not a valid 2.5D project.'); }
  };
  reader.readAsText(file);
  e.target.value = '';
});

// ---------- container outline library (localStorage) ----------

const LIB_KEY = '2p5d.library.v1';

function libAvailable() {
  try {
    const k = '__2p5d_probe__';
    localStorage.setItem(k, '1'); localStorage.removeItem(k);
    return true;
  } catch { return false; }
}
function libLoad() {
  try { return JSON.parse(localStorage.getItem(LIB_KEY) || '[]'); } catch { return []; }
}
function libSave(list) {
  try { localStorage.setItem(LIB_KEY, JSON.stringify(list)); return true; } catch { return false; }
}
function refreshLibList() {
  const sel = $('libList');
  const cur = sel.value;
  const list = libLoad();
  sel.innerHTML = '<option value="">— saved outlines —</option>';
  list.forEach((o, i) => {
    const opt = document.createElement('option');
    opt.value = String(i);
    opt.textContent = o.name;
    sel.appendChild(opt);
  });
  if (cur && +cur < list.length) sel.value = cur;
  const ok = libAvailable();
  $('libSaveBtn').disabled = !ok;
  $('libLoadBtn').disabled = !ok;
  $('libDeleteBtn').disabled = !ok;
  $('libNote').textContent = ok ? '' : 'Storage is unavailable here — the library needs the offline or hosted copy.';
}

$('libSaveBtn').addEventListener('click', () => {
  const { outer, holes, circles } = traceEditor.getTrace();
  if (!outer || outer.length < 3) { toast('No outline to save yet.'); return; }
  const name = ($('libName').value || '').trim() || `Outline ${new Date().toISOString().slice(0, 10)}`;
  // Normalize to a small-margin origin so saved outlines stay compact.
  let minX = Infinity, minY = Infinity;
  for (const p of outer) { minX = Math.min(minX, p.x); minY = Math.min(minY, p.y); }
  const M = 5, off = p => ({ x: p.x - minX + M, y: p.y - minY + M });
  const entry = {
    name,
    outer: outer.map(off),
    holes: holes.map(h => h.map(off)),
    circles: circles.map(c => ({ ...c, cx: c.cx - minX + M, cy: c.cy - minY + M })),
    // Refs are index-based, so they survive the origin shift unchanged.
    measurements: structuredClone(traceEditor.measurements),
    constraints: structuredClone(traceEditor.constraints),
    arcs: structuredClone(traceEditor.arcs),
    lines: structuredClone(traceEditor.lines),
  };
  const list = libLoad();
  const existing = list.findIndex(o => o.name === name);
  if (existing >= 0) list[existing] = entry; else list.push(entry);
  if (libSave(list)) { toast(`Saved “${name}” to the outline library.`); refreshLibList(); }
  else toast('Could not save — storage is unavailable here.');
});

$('libDeleteBtn').addEventListener('click', () => {
  const i = $('libList').value;
  if (i === '') { toast('Pick a saved outline first.'); return; }
  const list = libLoad();
  const removed = list.splice(+i, 1)[0];
  libSave(list);
  refreshLibList();
  if (removed) toast(`Deleted “${removed.name}”.`);
});

$('libLoadBtn').addEventListener('click', () => {
  const i = $('libList').value;
  if (i === '') { toast('Pick a saved outline first.'); return; }
  const o = libLoad()[+i];
  if (!o) return;
  loadOutlineIntoSession(o);
  $('projModal').hidden = true;
});

// Load a bare outline (no photo) into an editable session by synthesizing a
// blank backdrop, so it can be edited in step 2 and modeled in step 3.
function loadOutlineIntoSession(o) {
  const ppm = 4;
  let maxX = 0, maxY = 0;
  for (const p of o.outer) { maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y); }
  const c = document.createElement('canvas');
  c.width = Math.max(40, Math.ceil((maxX + 5) * ppm));
  c.height = Math.max(40, Math.ceil((maxY + 5) * ppm));
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#f4f2ec';
  ctx.fillRect(0, 0, c.width, c.height);
  state.image = null;
  state.rect = { canvas: c, pxPerMm: ppm };
  state.rectDirty = false;
  state.diffMap = computeDiffMap(c);
  state.fileName = o.name.replace(/[^\w.-]+/g, '_') || 'outline';
  // Reset to a single base section that follows this outline.
  state.regions.length = 0;
  state.regions.push({
    name: 'Base', pts: null, thickness: state.regions[0] ? state.regions[0].thickness : 5, zBase: 0,
    top: { mode: 'none', size: 1 }, bottom: { mode: 'none', size: 1 },
  });
  state.selRegion = 0;
  traceEditor.setRectified(c, ppm);
  traceEditor.setMaskOverlay(null);
  traceEditor.setTrace(o.outer.map(p => ({ ...p })), (o.holes || []).map(h => h.map(p => ({ ...p }))));
  traceEditor.setCircles((o.circles || []).map(c2 => structuredClone(c2)));
  traceEditor.measurements = Array.isArray(o.measurements) ? structuredClone(o.measurements) : [];
  traceEditor.constraints = Array.isArray(o.constraints) ? structuredClone(o.constraints) : [];
  traceEditor.arcs = Array.isArray(o.arcs) ? structuredClone(o.arcs) : [];
  traceEditor.lines = Array.isArray(o.lines) ? structuredClone(o.lines) : [];
  traceEditor._ensureArcIds();
  traceEditor.draw();
  traceEditor.setSections(state.regions);
  refreshModelFields();
  updateStepButtons();
  updateTraceInfo();
  goStep(2);
  toast(`Loaded outline “${o.name}”.`);
}

refreshLibList();

// ---------- vector CAD import (DXF / SVG) ----------

let cadImportState = null; // { views, unitsKnown, unitName, name }
let cadSelected = -1;

function drawViewThumb(canvas, view) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || 120, h = 90;
  canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, w, h);
  const pad = 8;
  const sc = Math.min((w - pad * 2) / (view.w || 1), (h - pad * 2) / (view.h || 1));
  const ox = (w - view.w * sc) / 2, oy = (h - view.h * sc) / 2;
  const b = view.bbox;
  const tx = p => ({ x: ox + (p.x - b.minX) * sc, y: oy + (p.y - b.minY) * sc });
  const drawLoop = (pts, stroke, fill) => {
    if (pts.length < 2) return;
    ctx.beginPath();
    const p0 = tx(pts[0]); ctx.moveTo(p0.x, p0.y);
    for (let i = 1; i < pts.length; i++) { const p = tx(pts[i]); ctx.lineTo(p.x, p.y); }
    ctx.closePath();
    if (fill) { ctx.fillStyle = fill; ctx.fill('evenodd'); }
    ctx.strokeStyle = stroke; ctx.lineWidth = 1.5; ctx.stroke();
  };
  drawLoop(view.outer, '#37d67a', 'rgba(55,214,122,0.12)');
  for (const hole of view.holes) drawLoop(hole, '#ff7d5c', 'rgba(20,24,30,0.6)');
}

function openCadModal(result, name) {
  cadImportState = { ...result, name };
  cadSelected = result.views.length ? 0 : -1;
  const grid = $('cadViews');
  grid.innerHTML = '';
  result.views.forEach((v, i) => {
    const cell = document.createElement('div');
    cell.className = 'cad-view' + (i === cadSelected ? ' sel' : '');
    const cv = document.createElement('canvas');
    cell.appendChild(cv);
    const cap = document.createElement('div');
    cap.className = 'cap';
    cap.textContent = `${fmtDim(v.w)} × ${fmtDim(v.h)} ${state.units}`;
    cell.appendChild(cap);
    cell.addEventListener('click', () => {
      cadSelected = i;
      for (const el of grid.children) el.classList.remove('sel');
      cell.classList.add('sel');
      $('cadUseBtn').disabled = false;
    });
    grid.appendChild(cell);
    requestAnimationFrame(() => drawViewThumb(cv, v));
  });
  const unitsNote = result.unitsKnown
    ? `Units from file: ${result.unitName}. ${result.views.length} view(s) found.`
    : `The file has no real units — set the overall width below. ${result.views.length} view(s) found.`;
  $('cadUnitsNote').textContent = unitsNote;
  $('cadWidthRow').hidden = result.unitsKnown;
  if (!result.unitsKnown && result.views[0]) $('cadWidth').value = fmtDim(result.views[0].w);
  $('cadWarn').hidden = !(result.warnings && result.warnings.length);
  $('cadWarn').textContent = (result.warnings || []).join('\n');
  $('cadUseBtn').disabled = cadSelected < 0;
  $('cadModal').hidden = false;
}

function useCadView() {
  if (!cadImportState || cadSelected < 0) return;
  const v = cadImportState.views[cadSelected];
  let scale = 1;
  if (!cadImportState.unitsKnown) {
    const wMm = parseDim($('cadWidth').value);
    if (wMm > 0 && v.w > 0) scale = wMm / v.w;
  }
  const sc = pts => pts.map(p => ({ x: p.x * scale, y: p.y * scale }));
  const name = (cadImportState.name || 'drawing').replace(/\.[^.]+$/, '');
  loadOutlineIntoSession({ name, outer: sc(v.outer), holes: v.holes.map(sc), circles: [] });
  $('cadModal').hidden = true;
  toast(`Imported “${name}” from ${cadImportState.format.toUpperCase()}.`);
}

$('cadFileInput').addEventListener('change', e => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    let result;
    try {
      result = importCad(file.name, String(reader.result));
    } catch (err) {
      console.error('CAD import failed', err);
      toast('Could not read that file.');
      return;
    }
    if (!result.views.length) {
      toast((result.warnings && result.warnings[0]) ||
        'No closed shapes found — the drawing may be open lines only.');
      return;
    }
    // Single view with known units → load straight away; else pick/confirm.
    if (result.views.length === 1 && result.unitsKnown) {
      cadImportState = { ...result, name: file.name };
      cadSelected = 0;
      useCadView();
    } else {
      openCadModal(result, file.name);
    }
  };
  reader.readAsText(file);
  e.target.value = '';
});
$('cadCloseBtn').addEventListener('click', () => { $('cadModal').hidden = true; });
$('cadModal').addEventListener('pointerdown', e => { if (e.target === $('cadModal')) $('cadModal').hidden = true; });
$('cadUseBtn').addEventListener('click', useCadView);

// Step tab buttons
for (const btn of document.querySelectorAll('.step-btn')) {
  btn.addEventListener('click', () => goStep(parseInt(btn.dataset.step, 10)));
}

// ---------- unit toggle (mm / inch) ----------
// Relabel "(mm)"/"(in)" on labels attached to dimension fields only.
function relabelUnits() {
  const u = state.units;
  for (const input of document.querySelectorAll('input[inputmode="decimal"]')) {
    const field = input.closest('.field');
    const label = field && field.querySelector('label');
    if (!label) continue;
    for (const node of label.childNodes) {
      if (node.nodeType === Node.TEXT_NODE && /\((mm|in)\)/.test(node.nodeValue)) {
        node.nodeValue = node.nodeValue.replace(/\((mm|in)\)/, `(${u})`);
      }
    }
  }
}

for (const btn of document.querySelectorAll('#unitToggle button')) {
  btn.addEventListener('click', () => {
    state.units = btn.dataset.unit;
    document.querySelectorAll('#unitToggle button')
      .forEach(b => b.classList.toggle('active', b === btn));
    relabelUnits();
    $('customW').value = fmtDim(state.paper.customW);
    $('customH').value = fmtDim(state.paper.customH);
    refreshModelFields();
    updateTraceInfo();
    renderMeshInfo();
    syncHolePanel();
    positionHoleTag();
    refreshMeasurePanel();
    refreshConstraintList();
    traceEditor.draw(); // measurement labels carry units
  });
}

updateStepButtons();

$('appVersion').textContent = `v${APP_VERSION}`;
document.title = `2.5D v${APP_VERSION} — photo to printable solid`;

// Test hook (used by the headless test-suite; harmless in normal use).
window.__app = {
  state, goStep, retrace, rebuildMesh, loadImageFromURL, autoDetect, doRectify,
  cornerEditor, traceEditor, syncHolePanel, APP_VERSION,
  get viewer() { return viewer; },
};
