// App orchestration: three steps — (1) photo + paper corners, (2) trace +
// holes, (3) extrusion parameters + export.

import { PAPER_SIZES, DEFAULT_SIZE, paperDims } from './paperSizes.js';
import { rectify } from './homography.js';
import { detectPaperCorners } from './detectPaper.js';
import { computeDiffMap, otsuThreshold, segmentObject } from './segment.js';
import {
  traceBoundaries, signedArea, collapseCollinear, simplifyClosed,
  chaikinClosed, pointInPolygon,
} from './contour.js';
import { buildModel, circleToPolygon } from './mesh.js';
import { SCREW_STANDARDS, screwSpec, boreDiameter, recessDefaults } from './screws.js';
import { parseLength, formatLength, formatLengthLabelled } from './units.js';
import { toBinarySTL, toSVG, downloadBlob } from './exporters.js';
import { CornerEditor } from './ui/cornerEditor.js';
import { TraceEditor } from './ui/traceEditor.js';
import { Viewer3D } from './viewer3d.js';

const $ = id => document.getElementById(id);

const state = {
  image: null,
  fileName: 'object',
  corners: null,          // [{x,y} x4] source-image px, TL TR BR BL
  paper: { size: DEFAULT_SIZE, orientation: 'portrait', customW: 210, customH: 297 },
  rect: null,             // { canvas, pxPerMm }
  rectDirty: true,
  diffMap: null,
  mask: null,
  seg: {
    threshold: 60, autoThreshold: true, cleanup: 2, marginMm: 2,
    detectHoles: true, simplify: 0.4, smooth: 1, minHoleAreaMm2: 3,
  },
  model: { arcSegments: 8 },
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
  onChange: (throttled) => { updateTraceInfo(); if (!throttled) updateStepButtons(); },
  onSelect: () => {
    syncHolePanel();
    positionHoleTag();
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
  if (n === 2) traceEditor.draw();
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
    cornerEditor.setImage(img);
    autoDetect(false);
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

function doRectify() {
  if (!state.image) return false;
  const { w, h } = currentPaper();
  const res = rectify(state.image, state.corners, w, h);
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

function populateScrewSizes(std, selected) {
  const sel = $('screwSize');
  sel.innerHTML = '';
  sel.disabled = std === 'custom';
  if (std === 'custom') return;
  for (const key of Object.keys(SCREW_STANDARDS[std].sizes)) {
    const opt = document.createElement('option');
    opt.value = key;
    opt.textContent = key;
    sel.appendChild(opt);
  }
  if (selected && SCREW_STANDARDS[std].sizes[selected]) sel.value = selected;
}

function screwFitNote(screw, d) {
  if (!screw || screw.std === 'custom') return '';
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
  $('screwFitField').hidden = screw.std === 'custom';
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

// Apply the screw selection: derive bore ⌀ and recess defaults.
function applyScrewSelection() {
  const std = $('screwStd').value;
  if (std === 'custom') {
    applyHoleProps({ screw: { std: 'custom', size: '', fit: 'clearance' } });
    syncHolePanel();
    return;
  }
  let size = $('screwSize').value;
  if (!SCREW_STANDARDS[std].sizes[size]) size = Object.keys(SCREW_STANDARDS[std].sizes)[0];
  const fit = $('screwFit').value;
  const props = {
    screw: { std, size, fit },
    d: boreDiameter(std, size, fit),
    ...recessDefaults(std, size),
  };
  applyHoleProps(props);
  syncHolePanel();
}

// ---------- step 3: mesh ----------

let meshTimer = null;
function rebuildMesh(fit = false) {
  clearTimeout(meshTimer);
  meshTimer = setTimeout(() => {
    const { outer, holes, circles } = traceEditor.getTrace();
    if (!outer || outer.length < 3) return;

    let mesh = null;
    try {
      mesh = buildModel(outer, holes, circles, state.regions, state.model.arcSegments);
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
  });
}

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
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    traceEditor.undo();
  } else if (e.key === 'Delete' || e.key === 'Backspace') {
    e.preventDefault();
    traceEditor.deleteSelected();
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
$('exportSvgBtn').addEventListener('click', () => {
  const { outer, holes, circles } = traceEditor.getTrace();
  if (!outer || outer.length < 3) { toast('No trace to export yet.'); return; }
  const { w, h } = currentPaper();
  // SVG is a 2D profile: screw holes export at their bore diameter.
  const allHoles = [...holes, ...circles.map(c => circleToPolygon(c.cx, c.cy, c.d))];
  deliverExport(toSVG(outer, allHoles, w, h), `${state.fileName}-outline.svg`);
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
    paper: state.paper,
    corners: state.corners,
    seg: state.seg,
    model: state.model,
    regions: state.regions,
    trace: traceEditor.getTrace(),
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
  });
}

updateStepButtons();

// Test hook (used by the headless test-suite; harmless in normal use).
window.__app = {
  state, goStep, retrace, rebuildMesh, loadImageFromURL, autoDetect,
  cornerEditor, traceEditor, syncHolePanel,
  get viewer() { return viewer; },
};
