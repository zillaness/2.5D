// App orchestration: three steps — (1) photo + paper corners, (2) trace +
// holes, (3) extrusion parameters + export.

import { PAPER_SIZES, COIN_SIZES, DEFAULT_SIZE, DEFAULT_COIN, paperDims } from './paperSizes.js';
import { GRID_PITCHES, gridPitchMm, gridDims, analyzeGrid, autoCount } from './gridRef.js';
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
import { suggestRegions } from './regions.js';
import { toBinarySTL, toSVG, toDXF, toTiledSVG, downloadBlob } from './exporters.js';
import {
  buildFoamInsert, buildLayoutInsert, buildGridfinityBin, buildBaseplate,
  buildLayoutGridBin, gridContainerLoop, buildHolster, roundedRect, splitTiles,
  layoutPockets, layoutLabelGeometry, layoutLabelConflicts, labelMinHeight,
} from './holders.js';
import { silhouetteOf, registerBack, renderRegistered } from './backphoto.js';
import { LayoutEditor, bedLoop } from './ui/layoutEditor.js';
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
import { tracesFromFiles, thumbFromImage } from './import/traceFolder.js';
import {
  hasDirectoryPicker, pickFolder, walkFolder, ensurePermission,
  rememberFolder, recallFolder, writeProjectFile,
} from './import/folderAccess.js';

const $ = id => document.getElementById(id);

const state = {
  image: null,
  fileName: 'object',
  corners: null,          // [{x,y} x4] source-image px, TL TR BR BL
  // 'rect' (paper/card, perspective-corrected) | 'grid' (graph/dot paper,
  // perspective-corrected off counted squares) | 'coin' (scale only)
  reference: 'rect',
  grid: { pitch: 'mm5', customMm: 5, nx: 10, ny: 10, autoSig: null, lastAuto: null },
  bar: { lengthMm: 100 }, // scale-bar reference: two points this far apart
  paper: { size: DEFAULT_SIZE, orientation: 'portrait', customW: 210, customH: 297 },
  captureFrac: 0, // 0 = reference-only crop; >0 extends the rectified area beyond it (× longer paper side)
  labels: [],     // emboss/deboss text on a face
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
  // Holder generators (foam insert now; layouts/Gridfinity/holsters later).
  // `depth: null` = follow the base section's thickness.
  holder: {
    type: 'none',
    foam: { clearance: 0.5, margin: 10, cornerR: 4, depth: null, floor: 3, notch: 'bottom', notchDia: 25, notchFrac: 0.5 },
    grid: { clearance: 0.5, depth: null, unitsH: null, lip: true, magnets: false, notch: 'none', notchDia: 25, notchFrac: 0.5 },
    plate: { floorT: 1.2 },
    holster: { clearance: 1, wall: 2.4, height: 20, floor: 0, flat: 'none', mount: 'none' },
  },
  holderMesh: null,
  // Multi-tool drawer layout. Items embed their outline geometry (copied
  // from the library or the live trace at add time) so projects stay
  // self-contained. Container: a rectangle, or a saved container outline.
  layout: {
    // `scale` is what Known width / Known depth have done to a traced
    // container outline so far: additive, optional, and 1 : 1 until measured.
    container: { type: 'rect', w: 220, h: 140, r: 6, n: 3, m: 2, name: null, outer: null, scale: { x: 1, y: 1 } },
    items: [], clearance: 0.5, floor: 3, border: 5,
    bed: { // laser / printer bed for tiling, and puzzle tabs on the seams
      preset: 'none', w: 300, h: 200,
      // Build-plate extras, both additive and optional: `shape` is a saved
      // container outline for a round or cut-cornered plate, and `offset` is
      // where the layout's bounding box sits on the plate.
      shape: null, offset: { x: 0, y: 0 },
      tabs: { enabled: false, head: 12, neck: 7, depth: 12, spacing: 80, fit: 0 },
    },
    // Tool labels. Off by default: an unlabelled layout must export exactly
    // what it exports today. `process` drives the minimum legible cap height,
    // which is a property of the machine, not a style preference.
    labels: {
      enabled: false, height: 6, margin: 2, follow: false,
      process: 'laser', bitDia: 3.175, nozzle: 0.4,
      font: 'bold sans-serif', mode: 'deboss', depth: 0.6,
      extra: [],   // free-floating layout labels ("TOP DRAWER", "FRONT")
    },
  },
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
  // Back (underside) photo: rectified copy, alignment onto the front trace,
  // and the pre-rendered registered canvas used as an underlay.
  back: { rect: null, align: null, registered: null, showing: false },
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
    // Drawn while the underside view is open = an undercut: it becomes a
    // bottom-face recess (off-bed depth) rather than an extruded prism.
    const under = state.back.showing;
    const base = state.regions[0].thickness;
    state.regions.push({
      name: under ? `Under ${state.regions.length}` : `Section ${state.regions.length + 1}`,
      pts,
      thickness: under ? Math.round(Math.max(0.2, Math.min(base * 0.4, base - 0.5)) * 100) / 100 : base,
      zBase: 0,
      top: { mode: 'none', size: 1 },
      bottom: { mode: 'none', size: 1 },
      ...(under ? { underside: true } : {}),
    });
    state.selRegion = state.regions.length - 1;
    refreshModelFields();
    if (state.step === 3) rebuildMesh();
    toast(under
      ? 'Undercut added — set how far it sits off the bed (Off-bed depth) in step 3.'
      : 'Section added — set its thickness and floor offset in step 3 (Model & export).');
  },
  onSectionsChanged: () => {
    if (state.selRegion >= state.regions.length) state.selRegion = 0;
    refreshModelFields();
    if (state.step === 3) rebuildMesh();
  },
  formatLen: mm => fmtDimL(mm),
  onLabelPlace: (mm) => {
    // New labels inherit the last one's styling, so a row of tags is one setup.
    const prev = state.labels[state.labels.length - 1];
    state.labels.push({
      text: prev ? prev.text : 'TEXT',
      x: mm.x, y: mm.y,
      height: prev ? prev.height : 6,
      depth: prev ? prev.depth : 0.6,
      rot: prev ? prev.rot : 0,
      mirror: prev ? !!prev.mirror : false,
      face: prev ? prev.face : 'top',
      mode: prev ? prev.mode : 'emboss',
      font: prev ? prev.font : 'bold sans-serif',
    });
    traceEditor.setLabels(state.labels);
  },
  onLabelsChanged: () => { syncLabelPanel(); rebuildMesh(); },
  onAnnosChanged: () => { refreshMeasurePanel(); refreshConstraintList(); },
  onPicksChanged: () => refreshConstrainButtons(),
});
traceEditor.setSections(state.regions);
traceEditor.setLabels(state.labels);
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
  if (state.reference === 'grid') {
    const g = state.grid;
    return gridDims(gridPitchMm(g.pitch, g.customMm), g.nx, g.ny);
  }
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

// A failed 3D preview (e.g. WebGL unavailable) must never block mesh
// building or export, so every caller tolerates a null viewer.
function ensureViewer() {
  if (viewer) return;
  try {
    viewer = new Viewer3D($('stage3'));
  } catch (err) {
    console.error('3D preview unavailable', err);
    toast('3D preview unavailable in this browser — the STL export still works.');
  }
}

function goStep(n) {
  // Step 4 organises a drawer from the library or a folder, so it is the one
  // step past the first that needs no photo and no trace.
  if (n >= 2 && n !== 4 && !state.image && !state.rect) return; // rect alone = restored project
  if (n === 2 && state.rectDirty && state.image) {
    if (!doRectify()) return;
    retrace();
  }
  state.step = n;
  for (let i = 1; i <= 4; i++) {
    $('stage' + i).hidden = i !== n;
    $('panel' + i).hidden = i !== n;
    $('stepBtn' + i).classList.toggle('active', i === n);
  }
  // Step 4 puts the layout editor and the 3D preview side by side, so stage3
  // stays mounted and shares the stage with stage4.
  const split = n === 4;
  $('stage3').hidden = !(n === 3 || split);
  $('stage3').style.left = split ? '50%' : '';
  $('stage4').style.right = split ? '50%' : '';
  positionHoleTag();
  if (n === 2) {
    $('lensRow').hidden = state.reference !== 'rect';
    $('lensVal').textContent = state.lens.k1.toFixed(3);
    updateTraceInfo(); // also refreshes the optional underside entry point
    traceEditor.draw();
  }
  if (n === 3 || split) {
    ensureViewer();
    if (viewer) viewer.resize();
  }
  if (n === 3) rebuildMesh(true);
  if (split) openLayoutPanel(); else $('layoutModal').hidden = true;
  updateStepButtons();
}

function updateStepButtons() {
  // stepBtn4 is never disabled: organising needs no photo and no trace.
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
    if (state.reference === 'coin' || state.reference === 'bar') {
      cornerEditor.setRefMode(state.reference);
      if (state.reference === 'bar') syncBarFields();
    } else if (state.reference === 'grid') {
      // Nothing to auto-detect: the handles go on grid intersections you
      // pick, not on the sheet's edges.
      state.corners = defaultCorners();
      cornerEditor.setCorners(state.corners);
      syncGridFields();
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

// Grid reference auto-count: rectify at the provisional counts, read the
// true counts back from the periodicity, adopt them. Keyed on a signature
// of handles + pitch so it runs once per placement and never overrides a
// count the user typed by hand for that same placement.
function gridAutoSig() {
  return JSON.stringify([state.corners, state.grid.pitch, state.grid.customMm]);
}
function runGridAutoCount(force = false) {
  if (state.reference !== 'grid' || !state.image || !state.corners) return null;
  const sig = gridAutoSig();
  if (!force && state.grid.autoSig === sig) return state.grid.lastAuto;
  const pitch = gridPitchMm(state.grid.pitch, state.grid.customMm);
  // Provisional rectification sized from the handle quad's OWN pixel
  // extent, not from a guessed count: aspect-true and at source resolution,
  // so the rulings are not resampled into an aliased beat that reads as a
  // harmonic. (The millimetres here are placeholders; autoCount works on
  // pure pixel ratios.)
  const C = state.corners;
  const seg = (a, b) => Math.hypot(b.x - a.x, b.y - a.y);
  const qW = (seg(C[0], C[1]) + seg(C[3], C[2])) / 2;
  const qH = (seg(C[0], C[3]) + seg(C[1], C[2])) / 2;
  const P0 = 8; // rectify's px/mm cap → output px ≈ quad px
  const prov = rectify(state.image, state.corners, qW / P0, qH / P0,
    { k1: state.lens.k1, k2: state.lens.k2, marginMm: 0, maxLongSidePx: 3200 });
  let ac = null;
  if (prov) {
    try { ac = autoCount(prov.canvas, prov.pxPerMm, pitch, state.grid.nx, state.grid.ny); }
    catch (err) { console.error('autoCount failed', err); }
  }
  state.grid.autoSig = sig;
  state.grid.lastAuto = ac;
  if (ac) {
    state.grid.nx = ac.nx; state.grid.ny = ac.ny;
    state.rectDirty = true;
  }
  const el = $('gridAutoMsg');
  el.textContent = ac ? ac.message
    : 'Could not read a grid between the handles — type the square counts instead.';
  el.className = ac && ac.ok ? 'hint' : 'warn';
  syncGridFields();
  return ac;
}

function rectifyBar() {
  const img = state.image;
  const bar = cornerEditor.getBar();
  const lengthMm = state.bar.lengthMm;
  if (!bar || !(lengthMm > 0)) { toast('Place the scale bar and give its length first.'); return false; }
  const px = Math.hypot(bar.bx - bar.ax, bar.by - bar.ay);
  if (px < 10) { toast('Drag the scale bar\'s ends apart — it is too short to set a scale.'); return false; }
  const iw = img.naturalWidth, ih = img.naturalHeight;
  const scale = Math.min(1, 1600 / Math.max(iw, ih));
  const w = Math.round(iw * scale), h = Math.round(ih * scale);
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  c.getContext('2d').drawImage(img, 0, 0, w, h);
  const pxPerMm = (px * scale) / lengthMm;
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
  if (state.reference === 'bar') return rectifyBar();
  if (state.reference === 'grid') runGridAutoCount();
  const { w, h } = currentPaper();
  const marginMm = (state.captureFrac || 0) * Math.max(w, h);
  const res = rectify(state.image, state.corners, w, h,
    { k1: state.lens.k1, k2: state.lens.k2, marginMm });
  if (!res) {
    toast('Corner layout is degenerate — adjust the corners.');
    return false;
  }
  state.rect = res;
  state.rectDirty = false;
  // Beyond-paper: give the segmenter the paper rect so it treats both the paper
  // and the surrounding surface as background.
  state.diffMap = computeDiffMap(res.canvas, marginMm > 0 ? { paperRect: res.paperRect } : {});
  if (state.seg.autoThreshold) {
    state.seg.threshold = otsuThreshold(state.diffMap.diff);
    $('threshSlider').value = state.seg.threshold;
    $('threshVal').textContent = state.seg.threshold;
  }
  traceEditor.setRectified(res.canvas, res.pxPerMm);
  // Grid reference: the square count is hand-entered and sets the whole
  // scale, so measure the printed pitch back out and say whether it agrees.
  if (state.reference === 'grid') {
    let chk = null;
    try {
      chk = analyzeGrid(res.canvas, res.pxPerMm,
        gridPitchMm(state.grid.pitch, state.grid.customMm));
    } catch (err) { console.error('analyzeGrid failed', err); }
    const el = $('gridCheck');
    el.textContent = chk ? chk.message
      : 'Could not read the grid back from the photo — check the scale by hand (📏 Measure in step 2).';
    el.className = chk && chk.ok ? 'hint' : 'warn';
  }
  // A new front rectification invalidates the underside view (and possibly
  // its alignment — re-enter and hit Auto to re-register against the trace).
  if (state.back.showing) exitUnderside(); else backUISync();
  return true;
}

// ---------- step 2: segmentation + trace ----------

function retrace() {
  if (!state.rect || !state.diffMap) return;
  // The underside view is registered against the current outline — silently
  // re-deriving it there would invalidate the alignment.
  if (state.back.showing) {
    toast('Finish the underside view before re-detecting the outline (it is aligned to the current trace).');
    return;
  }
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
  updateUndersideAvailability();
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
// Labels as the mesh wants them: placed glyph loops + how to cut/raise them.
function labelsForMesh() {
  return state.labels
    .map((L, i) => ({
      loops: traceEditor.labelGeometry(i),
      mode: L.mode || 'emboss',
      face: L.face || 'top',
      size: L.depth,
    }))
    .filter(L => L.loops.length);
}

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
        labels: labelsForMesh(),
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
    if (state.holder.type !== 'none') {
      rebuildHolder(); // holder preview follows the trace/model live
    } else {
      renderMeshInfo();
      if (viewer) viewer.setMesh(mesh, fit);
    }
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

// ---------- back (underside) photo ----------

// The underside is an optional fork of the trace step, never part of the
// default flow: the entry point only appears once there's a trace to reuse,
// and nothing asks for a second photo. (A single top-down photo can't tell
// you whether an underside recess exists — both faces share one silhouette
// — so there is nothing honest to auto-detect and prompt on.)
function updateUndersideAvailability() {
  const { outer } = traceEditor.getTrace();
  const ready = !!state.rect && outer && outer.length >= 3;
  $('undersideForkRow').hidden = !ready || state.back.showing;
  $('undersideForkBtn').textContent = state.back.registered
    ? '▽ Underside view' : '⤵ Add underside view…';
}
// In underside mode the outline is reused, not re-traced: lock every tool
// that edits it, leaving section drawing and pan.
const UNDERSIDE_TOOLS = new Set(['region', 'pan']);
function applyUndersideLock(on) {
  for (const b of document.querySelectorAll('.tool-btn')) {
    b.disabled = on && !UNDERSIDE_TOOLS.has(b.dataset.tool);
  }
  traceEditor.lockOutline = on;
  $('panel2Title').textContent = on ? 'Trace & holes — underside' : 'Trace & holes';
}
function backUISync() {
  const has = !!state.back.registered;
  $('undersidePanel').hidden = !(has && state.back.showing);
  updateUndersideAvailability();
  if (has && state.back.align) {
    const mm = state.back.align.score / (state.rect ? state.rect.pxPerMm : 1);
    $('backScore').textContent = Number.isFinite(mm)
      ? (mm > 3 ? `Auto-align looks rough (≈${mm.toFixed(1)} mm off) — nudge or re-shoot.`
                : `Aligned (≈${mm.toFixed(1)} mm mean silhouette error).`)
      : '';
  } else {
    $('backScore').textContent = '';
  }
}
function backApplyView() {
  if (!state.rect) return;
  traceEditor.setBackdrop(state.back.showing && state.back.registered
    ? state.back.registered : state.rect.canvas);
}
// (Re)build the registered underlay from the stored rect + alignment.
function backRender() {
  if (!state.back.rect || !state.back.align || !state.rect) return;
  state.back.registered = renderRegistered(
    state.back.rect.canvas, state.rect.canvas.width, state.rect.canvas.height,
    state.back.align);
  backApplyView();
  backUISync();
}
function backAutoAlign() {
  if (!state.back.rect || !state.rect) return false;
  const { outer } = traceEditor.getTrace();
  if (!outer || outer.length < 3) { toast('Trace the object first — alignment matches silhouettes.'); return false; }
  const sil = silhouetteOf(state.back.rect.canvas, state.back.rect.paperRect || null);
  if (!sil) { toast('No object found in the back photo — check contrast / retake.'); return false; }
  const ppmF = state.rect.pxPerMm, ppmB = state.back.rect.pxPerMm;
  const frontPx = outer.map(p => ({ x: p.x * ppmF, y: p.y * ppmF }));
  const align = registerBack(frontPx, sil, state.back.rect.canvas.width, ppmF / ppmB);
  align.scale = ppmF / ppmB;
  state.back.align = align;
  return true;
}

function enterUnderside() {
  state.back.showing = true;
  applyUndersideLock(true);
  // Section drawing is the whole point of this mode.
  document.querySelectorAll('.tool-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.tool === 'region'));
  traceEditor.setMode('region');
  $('measurePanel').hidden = true;
  $('constrainPanel').hidden = true;
  $('labelPanel').hidden = true;
  backApplyView();
  backUISync();
}
function exitUnderside() {
  state.back.showing = false;
  applyUndersideLock(false);
  document.querySelectorAll('.tool-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.tool === 'edit'));
  traceEditor.setMode('edit');
  backApplyView();
  backUISync();
}
$('undersideForkBtn').addEventListener('click', () => {
  if (!state.rect) { toast('Rectify the front photo first (step 1).'); return; }
  const { outer } = traceEditor.getTrace();
  if (!outer || outer.length < 3) { toast('Finish the outline first — the underside reuses it.'); return; }
  if (state.back.registered) { enterUnderside(); return; }
  $('backFile').click();
});
$('undersideDoneBtn').addEventListener('click', exitUnderside);
$('backReshootBtn').addEventListener('click', () => $('backFile').click());
$('backFile').addEventListener('change', e => {
  const file = e.target.files && e.target.files[0];
  e.target.value = '';
  if (!file) return;
  const img = new Image();
  img.onload = () => {
    let corners = null;
    try { corners = detectPaperCorners(img); } catch (err) { console.error(err); }
    if (!corners) {
      toast('Could not find the paper corners in the back photo — retake with all four corners visible.', 6000);
      return;
    }
    const { w, h } = currentPaper();
    const marginMm = (state.captureFrac || 0) * Math.max(w, h);
    const res = rectify(img, corners, w, h, { k1: state.lens.k1, k2: state.lens.k2, marginMm });
    if (!res) { toast('Back photo rectification failed — retake.'); return; }
    state.back.rect = res;
    if (backAutoAlign()) {
      backRender();
      enterUnderside();
      toast('Aligned to your outline — this is the underside. Mark the areas that sit above the bed, then set their depth in step 3.', 6500);
    }
  };
  img.onerror = () => toast('Could not read that image.');
  img.src = URL.createObjectURL(file);
});
const backNudge = dRad => {
  if (!state.back.align) return;
  state.back.align.rot += dRad;
  state.back.align.score = NaN; // manual — score no longer meaningful
  backRender();
};
$('backRot180').addEventListener('click', () => backNudge(Math.PI));
$('backRotP').addEventListener('click', () => backNudge((2 * Math.PI) / 180));
$('backRotM').addEventListener('click', () => backNudge((-2 * Math.PI) / 180));
$('backReauto').addEventListener('click', () => { if (backAutoAlign()) backRender(); });
$('backClearBtn').addEventListener('click', () => {
  const unders = state.regions.filter(r => r.underside).length;
  if (unders && !confirm(
    `Discard the underside view and its ${unders} underside section${unders === 1 ? '' : 's'}?`)) return;
  // Splice in place (the array is shared with the editor) and drop each
  // region's loop refs, highest index first — same as Delete section.
  for (let i = state.regions.length - 1; i >= 1; i--) {
    if (!state.regions[i].underside) continue;
    traceEditor._refsOp({ op: 'deleteLoop', loop: REGION_LOOP_BASE + i });
    state.regions.splice(i, 1);
  }
  state.selRegion = 0;
  state.back = { rect: null, align: null, registered: null, showing: false };
  applyUndersideLock(false);
  document.querySelectorAll('.tool-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.tool === 'edit'));
  traceEditor.setMode('edit');
  traceEditor.setSections(state.regions);
  refreshModelFields();
  backApplyView();
  backUISync();
  rebuildMesh();
});
$('suggestUndersideBtn').addEventListener('click', () => {
  if (!state.back.registered) { toast('Add a back photo first.'); return; }
  const { outer, holes, circles } = traceEditor.getTrace();
  if (!outer || outer.length < 3) { toast('Trace the object first.'); return; }
  const circPoly = c => {
    const pts = [];
    for (let k = 0; k < 24; k++) { const a = k / 24 * Math.PI * 2; pts.push({ x: c.cx + c.d / 2 * Math.cos(a), y: c.cy + c.d / 2 * Math.sin(a) }); }
    return pts;
  };
  const cands = suggestRegions(state.back.registered, outer,
    [...holes, ...circles.map(circPoly)], state.rect.pxPerMm);
  if (!cands.length) {
    toast('No distinct underside areas found — draw sections by hand with the ▱ tool while showing the underside.');
    return;
  }
  traceEditor.pushUndo();
  const base = state.regions[0].thickness;
  for (const c of cands) {
    state.regions.push({
      name: `Under ${state.regions.length}`,
      pts: c.pts,
      // thickness = recess depth: how far this area sits off the bed.
      thickness: Math.round(Math.min(base * 0.4, base - 0.5) * 100) / 100,
      zBase: 0,
      top: { mode: 'none', size: 1 },
      bottom: { mode: 'none', size: 1 },
      suggested: true,
      underside: true,
    });
  }
  state.selRegion = state.regions.length - 1;
  traceEditor.setSections(state.regions);
  refreshModelFields();
  traceEditor.draw();
  rebuildMesh();
  toast(`${cands.length} underside region${cands.length > 1 ? 's' : ''} added as bottom recesses — set each depth (how far off the bed) in step 3.`, 6500);
});

// ---------- holders (foam insert; layouts/Gridfinity/holsters follow) ----------

let holderTimer = null;
function holderParams() {
  const f = state.holder.foam;
  return {
    clearance: f.clearance, margin: f.margin, cornerR: f.cornerR,
    depth: f.depth || state.regions[0].thickness,
    floor: f.floor, notch: f.notch, notchDia: f.notchDia, notchFrac: f.notchFrac,
  };
}
function gridParams() {
  const g = state.holder.grid;
  return {
    clearance: g.clearance, depth: g.depth || state.regions[0].thickness,
    unitsH: g.unitsH, lip: g.lip, magnets: g.magnets,
    notch: g.notch, notchDia: g.notchDia, notchFrac: g.notchFrac,
  };
}
function buildHolderNow() {
  const trace = traceEditor.getTrace();
  if (!trace.outer || trace.outer.length < 3) return null;
  try {
    if (state.holder.type === 'grid') return buildGridfinityBin(trace, gridParams());
    if (state.holder.type === 'plate') return buildBaseplate(trace, { floorT: state.holder.plate.floorT });
    if (state.holder.type === 'holster') return buildHolster(trace, state.holder.holster);
    return buildFoamInsert(trace, holderParams());
  } catch (err) { console.error('holder build failed', err); return null; }
}
const LAYOUT_REASONS = {
  empty: 'Add tools to the layout first (Multi-tool drawer → arrange).',
  collision: 'Fix the red overlapping pockets in the layout.',
  escaped: 'Fix the red tools crossing the layout border.',
  nocells: 'No full 42 mm cell fits inside the outline — trace a bigger area (beyond-paper capture helps).',
};
function rebuildHolder() {
  clearTimeout(holderTimer);
  holderTimer = setTimeout(() => {
    if (state.holder.type === 'none') return;
    const isLayout = state.holder.type === 'layout';
    const res = isLayout ? buildLayoutNow() : buildHolderNow();
    state.holderMesh = res && !res.reason ? res : null;
    if (!state.holderMesh) {
      $('meshInfo').textContent = '';
      $('meshWarn').hidden = false;
      $('meshWarn').textContent = (res && LAYOUT_REASONS[res.reason]) ||
        `Could not build the ${{ foam: 'foam insert', grid: 'Gridfinity bin', plate: 'baseplate', layout: 'drawer insert' }[state.holder.type] || 'holder'} — check the ${isLayout ? 'layout' : 'outline'}.`;
      if (viewer) viewer.setMesh(null);
      return;
    }
    const s = state.holderMesh.stats;
    const label = { foam: 'Foam insert', grid: 'Gridfinity bin', plate: 'Baseplate', holster: 'Holster', layout: 'Drawer insert' }[state.holder.type];
    const cellNote = !s.cells ? ''
      : s.cells.u ? ` (${s.cells.n}×${s.cells.m} grid, ${s.cells.u}u)`
      : ` (${s.cells.count} socket${s.cells.count === 1 ? '' : 's'})`;
    $('meshInfo').textContent =
      `${label}: ${fmtDim(s.slab.w)} × ${fmtDim(s.slab.h)} × ${fmtDimL(s.slab.thickness)}${cellNote}\n` +
      (['plate', 'holster'].includes(state.holder.type) ? '' : `Pocket depth: ${fmtDimL(s.slab.pocketDepth)}${isLayout ? ' (deepest)' : ''}\n`) +
      `Triangles: ${s.triangles}`;
    const warns = s.warnings || [];
    $('meshWarn').hidden = !warns.length;
    $('meshWarn').textContent = warns.join('\n');
    if (viewer) viewer.setMesh(state.holderMesh, true);
  }, 120);
}
function syncHolderPanel() {
  $('holderType').value = state.holder.type;
  $('foamParams').hidden = state.holder.type !== 'foam';
  $('gridParams').hidden = state.holder.type !== 'grid';
  const f = state.holder.foam;
  $('foamClearance').value = fmtDim(f.clearance);
  $('foamDepth').value = f.depth ? fmtDim(f.depth) : '';
  $('foamMargin').value = fmtDim(f.margin);
  $('foamFloor').value = fmtDim(f.floor);
  $('foamNotch').value = f.notch;
  $('foamNotchDia').value = fmtDim(f.notchDia);
  $('foamNotchPosRow').hidden = f.notch !== 'custom';
  $('foamNotchPos').value = Math.round((f.notchFrac ?? 0.5) * 100);
  $('foamNotchPosVal').textContent = `${Math.round((f.notchFrac ?? 0.5) * 100)}%`;
  const g = state.holder.grid;
  $('gridClearance').value = fmtDim(g.clearance);
  $('gridDepth').value = g.depth ? fmtDim(g.depth) : '';
  $('gridUnits').value = g.unitsH ? String(g.unitsH) : '';
  $('gridLip').checked = !!g.lip;
  $('gridMagnets').checked = !!g.magnets;
  $('gridNotch').value = g.notch || 'none';
  $('gridNotchDia').value = fmtDim(g.notchDia);
  $('gridNotchPosRow').hidden = g.notch !== 'custom';
  $('gridNotchPos').value = Math.round((g.notchFrac ?? 0.5) * 100);
  $('gridNotchPosVal').textContent = `${Math.round((g.notchFrac ?? 0.5) * 100)}%`;
  $('plateParams').hidden = state.holder.type !== 'plate';
  $('plateFloor').value = fmtDim(state.holder.plate.floorT);
  $('holsterParams').hidden = state.holder.type !== 'holster';
  const ho = state.holder.holster;
  $('holClearance').value = fmtDim(ho.clearance);
  $('holWall').value = fmtDim(ho.wall);
  $('holHeight').value = fmtDim(ho.height);
  $('holFloor').value = fmtDim(ho.floor);
  $('holFlat').value = ho.flat;
  $('holMount').value = ho.mount;
}
$('holderType').addEventListener('change', e => {
  state.holder.type = e.target.value;
  $('foamParams').hidden = state.holder.type !== 'foam';
  $('gridParams').hidden = state.holder.type !== 'grid';
  $('plateParams').hidden = state.holder.type !== 'plate';
  $('holsterParams').hidden = state.holder.type !== 'holster';
  if (state.holder.type === 'none') { state.holderMesh = null; rebuildMesh(true); }
  else if (state.holder.type === 'layout') { goStep(4); rebuildHolder(); }
  else rebuildHolder();
});
for (const [id, key, min] of [
  ['holClearance', 'clearance', 0], ['holWall', 'wall', 0.8],
  ['holHeight', 'height', 2], ['holFloor', 'floor', 0],
]) {
  $(id).addEventListener('change', e => {
    const mm = parseDim(e.target.value);
    if (mm !== null && mm >= min) state.holder.holster[key] = mm;
    syncHolderPanel();
    rebuildHolder();
  });
}
$('holFlat').addEventListener('change', e => { state.holder.holster.flat = e.target.value; rebuildHolder(); });
$('holMount').addEventListener('change', e => { state.holder.holster.mount = e.target.value; rebuildHolder(); });
$('exportHolsterBtn').addEventListener('click', () => {
  const trace = traceEditor.getTrace();
  if (!trace.outer || trace.outer.length < 3) { toast('No outline to build a holster from yet.'); return; }
  let res = null;
  try { res = buildHolster(trace, state.holder.holster); }
  catch (err) { console.error('buildHolster failed', err); }
  if (!res) { toast('Could not build the holster.'); return; }
  const blob = toBinarySTL(res.positions, res.indices, `${state.fileName} holster`);
  deliverExport(blob, `${state.fileName}-holster-2p5d.stl`);
});
// Numeric foam fields; floor may be 0 (through pocket), the rest must be > 0.
for (const [id, key, min] of [
  ['foamClearance', 'clearance', 0], ['foamMargin', 'margin', 0.01],
  ['foamFloor', 'floor', 0], ['foamNotchDia', 'notchDia', 0.01],
]) {
  $(id).addEventListener('change', e => {
    const mm = parseDim(e.target.value);
    if (mm !== null && mm >= min) state.holder.foam[key] = mm;
    syncHolderPanel();
    rebuildHolder();
  });
}
$('foamDepth').addEventListener('change', e => {
  const raw = e.target.value.trim();
  if (raw === '') state.holder.foam.depth = null; // auto: follow thickness
  else {
    const mm = parseDim(raw);
    if (mm > 0) state.holder.foam.depth = mm;
  }
  syncHolderPanel();
  rebuildHolder();
});
$('foamNotch').addEventListener('change', e => {
  state.holder.foam.notch = e.target.value;
  syncHolderPanel();
  rebuildHolder();
});
$('foamNotchPos').addEventListener('input', e => {
  state.holder.foam.notchFrac = (parseInt(e.target.value, 10) || 0) / 100;
  $('foamNotchPosVal').textContent = `${e.target.value}%`;
  rebuildHolder();
});
$('gridNotch').addEventListener('change', e => {
  state.holder.grid.notch = e.target.value;
  syncHolderPanel();
  rebuildHolder();
});
$('gridNotchDia').addEventListener('change', e => {
  const mm = parseDim(e.target.value);
  if (mm > 2) state.holder.grid.notchDia = mm;
  syncHolderPanel();
  rebuildHolder();
});
$('gridNotchPos').addEventListener('input', e => {
  state.holder.grid.notchFrac = (parseInt(e.target.value, 10) || 0) / 100;
  $('gridNotchPosVal').textContent = `${e.target.value}%`;
  rebuildHolder();
});
$('gridClearance').addEventListener('change', e => {
  const mm = parseDim(e.target.value);
  if (mm !== null && mm >= 0) state.holder.grid.clearance = mm;
  syncHolderPanel();
  rebuildHolder();
});
$('gridDepth').addEventListener('change', e => {
  const raw = e.target.value.trim();
  if (raw === '') state.holder.grid.depth = null;
  else {
    const mm = parseDim(raw);
    if (mm > 0) state.holder.grid.depth = mm;
  }
  syncHolderPanel();
  rebuildHolder();
});
$('gridUnits').addEventListener('change', e => {
  const raw = e.target.value.trim();
  const u = parseInt(raw, 10);
  state.holder.grid.unitsH = raw === '' || !(u >= 1) ? null : Math.min(20, u);
  syncHolderPanel();
  rebuildHolder();
});
$('gridLip').addEventListener('change', e => { state.holder.grid.lip = e.target.checked; rebuildHolder(); });
$('gridMagnets').addEventListener('change', e => { state.holder.grid.magnets = e.target.checked; rebuildHolder(); });
$('plateFloor').addEventListener('change', e => {
  const mm = parseDim(e.target.value);
  if (mm !== null && mm >= 0.6) state.holder.plate.floorT = mm;
  syncHolderPanel();
  rebuildHolder();
});
$('exportPlateBtn').addEventListener('click', () => {
  const trace = traceEditor.getTrace();
  if (!trace.outer || trace.outer.length < 3) { toast('No outline to build a baseplate from yet.'); return; }
  let res = null;
  try { res = buildBaseplate(trace, { floorT: state.holder.plate.floorT }); }
  catch (err) { console.error('buildBaseplate failed', err); }
  if (!res || res.reason) { toast((res && LAYOUT_REASONS[res.reason]) || 'Could not build the baseplate.'); return; }
  const blob = toBinarySTL(res.positions, res.indices, `${state.fileName} baseplate`);
  deliverExport(blob, `${state.fileName}-plate-2p5d.stl`);
});
$('exportGridBtn').addEventListener('click', () => {
  const trace = traceEditor.getTrace();
  if (!trace.outer || trace.outer.length < 3) { toast('No outline to build a bin from yet.'); return; }
  let res = null;
  try { res = buildGridfinityBin(trace, gridParams()); }
  catch (err) { console.error('buildGridfinityBin failed', err); }
  if (!res) { toast('Could not build the Gridfinity bin.'); return; }
  const blob = toBinarySTL(res.positions, res.indices, `${state.fileName} gridfinity`);
  deliverExport(blob, `${state.fileName}-bin-2p5d.stl`);
});
$('exportFoamBtn').addEventListener('click', () => {
  const res = buildHolderNow();
  if (!res) { toast('No outline to build a foam insert from yet.'); return; }
  const blob = toBinarySTL(res.positions, res.indices, `${state.fileName} foam`);
  deliverExport(blob, `${state.fileName}-foam-2p5d.stl`);
});
$('exportFoamSvgBtn').addEventListener('click', () => {
  const res = buildHolderNow();
  if (!res) { toast('No outline to build a cut template from yet.'); return; }
  const T = res.template;
  const shift = pts => pts.map(p => ({ x: p.x - T.origin.x, y: p.y - T.origin.y }));
  const blob = toSVG(shift(T.slab), [shift(T.pocket), ...T.pillars.map(shift)], T.w, T.h, {});
  deliverExport(blob, `${state.fileName}-foam-template.svg`);
});

// ---------- multi-tool drawer layout ----------

const layoutEditor = new LayoutEditor($('layoutCanvas'), {
  onSelect: i => syncLaySelPanel(i),
  onChange: final => { if (final) updateLayoutInfo(); },
});

// The container loop in layout mm space (origin margin 5, like the library).
function layContainerLoop() {
  const c = state.layout.container;
  if (c.type === 'outline' && c.outer && c.outer.length >= 3) return c.outer;
  if (c.type === 'grid') return gridContainerLoop(c.n || 3, c.m || 2);
  return roundedRect(5 + c.w / 2, 5 + c.h / 2, c.w, c.h, c.r);
}
// A gridfinity container enforces the bin's minimum wall as the border.
function layBorderEff() {
  return state.layout.container.type === 'grid'
    ? (state.holder.grid.lip ? 2.6 : 1.2)
    : state.layout.border;
}
function buildLayoutNow() {
  const L = state.layout;
  try {
    if (L.container.type === 'grid') {
      const g = state.holder.grid;
      return buildLayoutGridBin(
        { n: L.container.n || 3, m: L.container.m || 2, unitsH: g.unitsH, lip: g.lip, magnets: g.magnets },
        L.items, { clearance: L.clearance });
    }
    return buildLayoutInsert({ outer: layContainerLoop() }, L.items, {
      labels: layLabelsForMesh(),
      clearance: L.clearance, floor: L.floor, border: L.border,
      defaultDepth: state.regions[0].thickness,
    });
  } catch (err) { console.error('layout build failed', err); return null; }
}

function refreshLaySelects() {
  const list = libLoad();
  const toolSel = $('layToolSel');
  toolSel.innerHTML = '';
  const cur = document.createElement('option');
  cur.value = '__current';
  cur.textContent = '← current traced outline';
  toolSel.appendChild(cur);
  list.forEach((o, i) => {
    if (o.kind === 'container') return;
    const opt = document.createElement('option');
    opt.value = String(i);
    opt.textContent = o.name;
    toolSel.appendChild(opt);
  });
  const contSel = $('layContainerSel');
  const c = state.layout.container;
  const keep = c.type === 'outline' ? c.name : c.type === 'grid' ? '__grid' : 'rect';
  contSel.innerHTML = '<option value="rect">Rectangle</option>' +
    '<option value="__grid">Gridfinity bin (N×M cells)</option>';
  if (keep === '__grid') contSel.value = '__grid';
  list.forEach((o, i) => {
    if (o.kind !== 'container') return;
    const opt = document.createElement('option');
    opt.value = String(i);
    opt.textContent = `⬚ ${o.name}`;
    if (o.name === keep) opt.selected = true;
    contSel.appendChild(opt);
  });
  // The same container outlines double as build-plate shapes. Every name here
  // is written as text and never as markup: an outline name arrives from a
  // project file or a folder of traces, so it is not ours to trust.
  const shapeSel = $('layBedShape');
  const shape = state.layout.bed.shape;
  shapeSel.innerHTML = '<option value="rect">Rectangular plate</option>';
  syncBedShapeOption();
  list.forEach((o, i) => {
    if (o.kind !== 'container') return;
    const opt = document.createElement('option');
    opt.value = String(i);
    opt.textContent = `⬚ ${o.name}`;
    shapeSel.appendChild(opt);
  });
  shapeSel.value = shape ? '__shape' : 'rect';
  refreshLayPalette();
}
function syncLayoutFields() {
  const L = state.layout;
  const grid = L.container.type === 'grid';
  document.querySelector('label[for="layW"]').textContent = grid ? 'Cells wide (N)' : 'Width (mm)';
  document.querySelector('label[for="layH"]').textContent = grid ? 'Cells deep (M)' : 'Depth (mm)';
  $('layW').value = grid ? String(L.container.n || 3) : fmtDim(L.container.w);
  $('layH').value = grid ? String(L.container.m || 2) : fmtDim(L.container.h);
  $('layClearance').value = fmtDim(L.clearance);
  $('layFloor').value = fmtDim(L.floor);
  $('layBorder').value = fmtDim(layBorderEff());
  $('layFloor').disabled = grid;   // grid bins keep the spec base instead
  $('layBorder').disabled = grid;  // …and enforce the bin's minimum wall
  $('layRectFields').hidden = L.container.type === 'outline';
  // Known width / depth belong to a traced outline: a rectangle's own width
  // and depth fields are already the measured numbers.
  const outline = L.container.type === 'outline';
  $('layKnownFields').hidden = !outline;
  if (outline) {
    const box = layBox(layContainerLoop());
    $('layKnownW').value = fmtDim(box.w);
    $('layKnownD').value = fmtDim(box.h);
  }
  syncScaleInfo();
}
// What the measured numbers have done to the traced outline, and the warning
// when the two axes disagree by more than 2 percent — which is usually a
// mis-traced edge rather than the warp the per-axis scale is there to absorb.
const SCALE_DIVERGENCE = 0.02;
function syncScaleInfo() {
  const el = $('layScaleInfo');
  const c = state.layout.container;
  const sc = c.scale;
  if (c.type !== 'outline' || !sc || (sc.x === 1 && sc.y === 1)) {
    el.textContent = ''; el.className = 'hint'; return;
  }
  // Only a container measured on BOTH axes has two factors to compare. With
  // one field filled the other axis was never measured, and its 1 : 1 is an
  // absence rather than a disagreement.
  const both = sc.x !== 1 && sc.y !== 1;
  const d = Math.abs(sc.x - sc.y) / Math.max(sc.x, sc.y);
  const off = both && d > SCALE_DIVERGENCE;
  el.textContent = `Traced outline scaled ×${sc.x.toFixed(3)} across and ×${sc.y.toFixed(3)} down.` +
    (off
      ? ` The two axes differ by ${(d * 100).toFixed(1)} percent — that is more than warp usually` +
        ' explains, so check the traced edges before you cut. The original outline is still in the library.'
      : ' The original outline is still in the library.');
  el.className = off ? 'warn' : 'hint';
}
// Force a traced container to a measured dimension. The axis scales about the
// bounding-box centre, so the container stays where it is and the other axis
// is left alone; filling both absorbs the residual warp of a shot that was
// not quite square.
function layScaleContainer(axis, known) {
  const c = state.layout.container;
  if (c.type !== 'outline' || !c.outer || c.outer.length < 3) return false;
  const box = layBox(c.outer);
  const cur = axis === 'x' ? box.w : box.h;
  if (!(cur > 0) || !(known > 1)) return false;
  const f = known / cur;
  if (!Number.isFinite(f) || Math.abs(f - 1) < 1e-9) return false;
  const mid = axis === 'x' ? (box.minX + box.maxX) / 2 : (box.minY + box.maxY) / 2;
  c.outer = c.outer.map(p => (axis === 'x'
    ? { x: mid + (p.x - mid) * f, y: p.y }
    : { x: p.x, y: mid + (p.y - mid) * f }));
  if (!c.scale) c.scale = { x: 1, y: 1 };
  c.scale[axis] = Math.round(c.scale[axis] * f * 1e6) / 1e6;
  return true;
}
function refreshLayoutEditor() {
  layoutEditor.setBed(layBedView());
  layoutEditor.setLayout(layContainerLoop(), state.layout.items,
    state.layout.clearance, layBorderEff());
  updateLayoutInfo();
}
function updateLayoutInfo() {
  const L = state.layout;
  const n = L.items.length;
  const conf = layoutEditor.conflicts;
  const bad = conf.collisions.size + conf.escaped.size;
  const depths = L.items.map(it => it.depth || it.thickness || state.regions[0].thickness);
  const maxD = depths.length ? Math.max(...depths) : 0;
  const loop = layContainerLoop();
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of loop) {
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
  }
  $('layEmptyHint').hidden = n > 0;
  const grid = L.container.type === 'grid';
  $('layoutInfo').textContent = grid
    ? `Gridfinity ${L.container.n}×${L.container.m} (${fmtDim(maxX - minX)} × ${fmtDim(maxY - minY)} mm) · ${n} tool${n === 1 ? '' : 's'}`
    : `Container ${fmtDim(maxX - minX)} × ${fmtDim(maxY - minY)} mm · ${n} tool${n === 1 ? '' : 's'}` +
      (n ? ` · insert ${fmtDimL(Math.max(0.5, L.floor) + maxD)} thick` : '');
  $('layoutWarn').hidden = !bad;
  $('layoutWarn').textContent = bad
    ? `${bad} tool${bad === 1 ? '' : 's'} in red — overlapping another pocket or crossing the border. Drag to fix.`
    : '';
  // Bed / tiling readout.
  const bed = layBedDims();
  const bw = maxX - minX, bh = maxY - minY;
  const bedEl = $('layBedInfo');
  const off = layBedOffset();
  const negOff = off.x < -1e-6 || off.y < -1e-6;
  let tiled = false; // drives the explicit tiled-SVG button in the export row
  if (!bed) {
    bedEl.textContent = '';
    // Whether the cut template has to be tiled is a question about the size of
    // the layout, not about where the plate was dragged. A layout that fits
    // the bed but hangs off the plate edge is mis-placed, not too big, and
    // `layBedEscapes` below is what says so.
  } else if (bw <= bed.w + 1e-6 && bh <= bed.h + 1e-6) {
    // One plate load. A shaped plate is the only case where fitting the
    // bounding rectangle is not the whole story, so it is checked here.
    const escaped = layBedEscapes();
    const shape = state.layout.bed.shape;
    if (escaped && shape) {
      bedEl.textContent = `${escaped} point${escaped === 1 ? '' : 's'} of the layout sit outside the ` +
        `${shape.name} plate — auto-centre it, nudge the plate, or shrink the container.`;
      bedEl.className = 'warn';
    } else if (escaped) {
      bedEl.textContent = `Fits the ${fmtDim(bed.w)} × ${fmtDim(bed.h)} bed, but the offset pushes it ` +
        'off the plate — auto-centre it or nudge the plate back.';
      bedEl.className = 'warn';
    } else {
      bedEl.textContent = `Fits the ${fmtDim(bed.w)} × ${fmtDim(bed.h)} bed in one piece.` +
        (shape ? ` Shaped plate: ${shape.name}.` : '');
      bedEl.className = 'hint';
    }
  } else {
    const plan = laySplitWithOffset({
      slab: loop, pockets: layoutPocketsForPlan(), origin: { x: minX, y: minY }, w: bw, h: bh,
    }, bed.w, bed.h, layTileOpts());
    const tiles = plan ? plan.tiles.length : 0;
    tiled = !!plan;
    bedEl.textContent = plan
      ? `Larger than the bed — the cut template exports as ${tiles} tiles (${plan.nx} × ${plan.ny})` +
        (plan.crossings ? `, ${plan.crossings} seam${plan.crossings === 1 ? '' : 's'} through a pocket (no clear line available)` : ', seams clear of every pocket') +
        (plan.tabs ? `, ${plan.tabCount} puzzle tab${plan.tabCount === 1 ? '' : 's'}` +
          (plan.tabless ? ` (${plan.tabless} seam segment${plan.tabless === 1 ? '' : 's'} too crowded for one)` : '') : '') +
        (grid ? '. STL tiling isn\'t available yet — the bin exports whole.' : '.') +
        (state.layout.bed.shape
          ? ` The ${state.layout.bed.shape.name} plate shape is ignored while tiling — the tiles plan against its bounding rectangle.`
          : '') +
        // The window can only start at or before the layout, so a negative
        // offset is dropped by `laySplitWithOffset`. Say so, the way the
        // fits-on-one-bed branch says the offset pushed the layout off.
        (negOff
          ? ' The plate offset is negative, which would leave a strip of the layout on no tile at all, so the seams ignore it. Auto-centre the plate or nudge it back.'
          : '')
      : (state.layout.bed.tabs.enabled
          ? 'Larger than the bed, but the puzzle tabs\' reach leaves no room to tile it — shrink the reach or pick a bigger bed.'
          : '');
    bedEl.className = plan && negOff ? 'warn' : 'hint';
  }
  $('layExportTilesBtn').disabled = !tiled;
  syncBedOffsetInfo();
  updateLabelInfo();
  if (state.holder.type === 'layout') rebuildHolder();
}
// Placed label geometry for the current layout, in layout mm. Empty when
// labelling is off, so every downstream path no-ops for an unlabelled layout.
function layPlacedLabels(pockets) {
  const L = state.layout;
  if (!L.labels || !L.labels.enabled) return [];
  return layoutLabelGeometry(L.items, pockets || layoutPockets(L.items, L.clearance), L.labels);
}
// Flat list of glyph loops for the exporters.
function layLabelLoops() {
  return layPlacedLabels().flatMap(L => L.loops);
}
// Labels as buildSolid wants them, for a PRINTED insert.
function layLabelsForMesh() {
  const cfg = state.layout.labels || {};
  return layPlacedLabels().map(L => ({
    loops: L.loops, mode: cfg.mode || 'deboss', face: 'top',
    size: Math.max(0.05, cfg.depth || 0.6),
  }));
}
// Pocket geometry for the tiling plan (same clearance/pillars as the build).
function layoutPocketsForPlan() {
  return layoutPockets(state.layout.items, state.layout.clearance)
    .filter(p => p.pocket)
    .map(p => ({ pocket: p.pocket, pillars: p.pillars }));
}
function syncLaySelPanel(i) {
  const it = state.layout.items[i];
  $('laySelPanel').hidden = !it;
  if (!it) return;
  $('laySelName').textContent = `Selected: ${it.name}`;
  $('laySelLabel').value = it.label || '';
  $('laySelLabel').placeholder = `(uses “${it.name}”)`;
  $('laySelDepth').value = it.depth ? fmtDim(it.depth) : '';
  $('laySelDepth').placeholder = `auto (${fmtDim(it.thickness || state.regions[0].thickness)})`;
  $('laySelRot').value = (it.rot || 0).toFixed(0);
  $('laySelNotch').checked = !!it.notch;
  $('laySelNotchDia').value = fmtDim(it.notch ? it.notch.dia : 25);
}
// Sync every control in the Step 4 panel and redraw the layout editor.
// `#layoutModal` is the panel's controls container: its hidden flag now means
// "the layout editor is not the active step", which is what goStep drives.
function openLayoutPanel() {
  refreshLaySelects();
  syncLayoutFields();
  syncBedFields();
  syncLabelFields();
  syncLaySelPanel(layoutEditor.sel);
  $('layoutModal').hidden = false;
  refreshLayoutEditor();
}
$('layContainerSel').addEventListener('change', e => {
  const v = e.target.value;
  // A fresh pick is a fresh outline: whatever the last one was measured to
  // does not carry over.
  state.layout.container.scale = { x: 1, y: 1 };
  if (v === 'rect') {
    state.layout.container.type = 'rect';
    state.layout.container.name = null;
  } else if (v === '__grid') {
    state.layout.container.type = 'grid';
    state.layout.container.name = null;
  } else {
    const o = libLoad()[+v];
    if (o) {
      state.layout.container = {
        ...state.layout.container, type: 'outline', name: o.name,
        outer: structuredClone(o.outer), scale: { x: 1, y: 1 },
      };
    }
  }
  syncLayoutFields();
  refreshLayoutEditor();
});
for (const [id, key, cells] of [['layW', 'w', 'n'], ['layH', 'h', 'm']]) {
  $(id).addEventListener('change', e => {
    if (state.layout.container.type === 'grid') {
      const u = parseInt(e.target.value, 10);
      if (u >= 1 && u <= 12) state.layout.container[cells] = u;
    } else {
      const mm = parseDim(e.target.value);
      if (mm > 10) state.layout.container[key] = mm;
    }
    syncLayoutFields();
    refreshLayoutEditor();
  });
}
for (const [id, axis] of [['layKnownW', 'x'], ['layKnownD', 'y']]) {
  $(id).addEventListener('change', e => {
    const mm = parseDim(e.target.value);
    if (mm !== null && mm > 1) layScaleContainer(axis, mm);
    syncLayoutFields();
    refreshLayoutEditor();
  });
}
for (const [id, key, min] of [['layClearance', 'clearance', 0], ['layFloor', 'floor', 0.5], ['layBorder', 'border', 0.5]]) {
  $(id).addEventListener('change', e => {
    const mm = parseDim(e.target.value);
    if (mm !== null && mm >= min) state.layout[key] = mm;
    syncLayoutFields();
    refreshLayoutEditor();
  });
}
// Bed size for tiling; null when unlimited.
function layBedDims() {
  const b = state.layout.bed;
  if (!b || b.preset === 'none') return null;
  if (b.preset === 'custom') return b.w > 10 && b.h > 10 ? { w: b.w, h: b.h } : null;
  const m = /^(\d+)x(\d+)$/.exec(b.preset);
  return m ? { w: +m[1], h: +m[2] } : null;
}
// The bounding box of a loop in layout mm.
function layBox(loop) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of loop) {
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
  }
  return { minX, minY, maxX, maxY, w: maxX - minX, h: maxY - minY };
}
// Where the layout sits on the plate, as a plain pair of numbers.
function layBedOffset() {
  const o = (state.layout.bed && state.layout.bed.offset) || {};
  return { x: Number.isFinite(o.x) ? o.x : 0, y: Number.isFinite(o.y) ? o.y : 0 };
}
// The bed as the layout editor and the plate arithmetic want it, sharing the
// offset object so a drag on the outline writes straight back into the state.
function layBedView() {
  const bed = layBedDims();
  if (!bed) return null;
  if (!state.layout.bed.offset) state.layout.bed.offset = { x: 0, y: 0 };
  return { w: bed.w, h: bed.h, shape: state.layout.bed.shape, offset: state.layout.bed.offset };
}
// Centre the layout on the plate. A 200 x 100 layout on a 300 x 200 plate
// lands at 50, 50.
function layBedCentre() {
  const bed = layBedDims();
  if (!bed) return false;
  const box = layBox(layContainerLoop());
  // Never negative. The tiling window can only start at or before the layout,
  // so an axis where the layout is larger than the plate centres at zero: a
  // negative offset there is dropped by `laySplitWithOffset` and would leave
  // the readout warning about the button the user just pressed.
  state.layout.bed.offset = {
    x: Math.max(0, Math.round((bed.w - box.w) / 2 * 1000) / 1000),
    y: Math.max(0, Math.round((bed.h - box.h) / 2 * 1000) / 1000),
  };
  return true;
}
// How much of the layout is off the plate. A rectangular plate is compared
// box to box; a shaped one is tested point by point, which is what catches a
// square drawer overhanging a round plate at the corners.
function layBedEscapes() {
  const view = layBedView();
  if (!view) return 0;
  const loop = layContainerLoop();
  const plate = bedLoop(loop, view);
  if (view.shape && view.shape.outer && view.shape.outer.length >= 3) {
    let n = 0;
    for (const p of loop) if (!pointInPolygon(p, plate)) n++;
    return n;
  }
  const box = layBox(loop), pb = layBox(plate);
  return (box.minX < pb.minX - 1e-6 || box.minY < pb.minY - 1e-6 ||
    box.maxX > pb.maxX + 1e-6 || box.maxY > pb.maxY + 1e-6) ? 1 : 0;
}
// The tiling window. By default the grid of bed-sized cells starts at the
// layout's top-left corner; a plate offset slides the layout into the first
// cell, so every seam moves with it. `splitTiles` plans from zero, so the
// shift goes onto the template it is handed and comes back off the tiles.
function laySplitWithOffset(template, bedW, bedH, opts) {
  const off = layBedOffset();
  const ox = Math.max(0, off.x), oy = Math.max(0, off.y);
  // The window only moves a layout that has to be tiled at all. Padding a
  // template that already fits one bed load would split it because of where
  // the plate was dragged, and the seam would fall in the empty pad rather
  // than anywhere in the drawer.
  const fits = template.w <= bedW + 1e-6 && template.h <= bedH + 1e-6;
  if (fits || (!(ox > 0) && !(oy > 0))) return splitTiles(template, bedW, bedH, opts);
  const plan = splitTiles({
    ...template,
    origin: { x: template.origin.x - ox, y: template.origin.y - oy },
    w: template.w + ox, h: template.h + oy,
  }, bedW, bedH, opts);
  if (!plan) return null;
  for (const t of plan.tiles) { t.x0 -= ox; t.y0 -= oy; }
  plan.seamsX = plan.seamsX.map(v => v - ox);
  plan.seamsY = plan.seamsY.map(v => v - oy);
  return plan;
}
// Where the layout sits on the plate, and how to move it. Refreshed on every
// layout change, because dragging the plate outline never touches the fields.
function syncBedOffsetInfo() {
  const b = state.layout.bed;
  const plate = layBedDims();
  $('layBedCentreBtn').disabled = !plate;
  const off = layBedOffset();
  $('layBedOffsetInfo').textContent = !plate ? ''
    : `Layout sits ${fmtDimL(off.x)} across and ${fmtDimL(off.y)} down the plate` +
      `${b.shape ? ` (${b.shape.name})` : ''}. Drag the dashed outline, or select it and ` +
      'nudge with the arrow keys (Shift for 10 mm).';
}
// The '__shape' option stands for the plate shape in use. The rest of the list
// is built when the panel opens, so picking a shape has to add the option, and
// clearing one has to drop it, or the select is asked to show a value it does
// not carry and renders blank.
function syncBedShapeOption() {
  const sel = $('layBedShape');
  const shape = state.layout.bed.shape;
  let opt = sel.querySelector('option[value="__shape"]');
  if (!shape) { if (opt) opt.remove(); return; }
  if (!opt) {
    opt = document.createElement('option');
    opt.value = '__shape';
    sel.insertBefore(opt, sel.firstChild ? sel.firstChild.nextSibling : null);
  }
  opt.textContent = `⬚ ${shape.name}`;
}
function syncBedFields() {
  const b = state.layout.bed;
  $('layBed').value = b.preset;
  $('layBedCustom').hidden = b.preset !== 'custom';
  $('layBedW').value = fmtDim(b.w);
  $('layBedH').value = fmtDim(b.h);
  syncBedShapeOption();
  $('layBedShape').value = b.shape ? '__shape' : 'rect';
  syncBedOffsetInfo();
  const t = b.tabs;
  $('layTabs').checked = !!t.enabled;
  $('layTabFields').hidden = !t.enabled;
  $('layTabHead').value = fmtDim(t.head);
  $('layTabNeck').value = fmtDim(t.neck);
  $('layTabDepth').value = fmtDim(t.depth);
  $('layTabSpacing').value = fmtDim(t.spacing);
  $('layTabFit').value = fmtDim(t.fit);
}
// ---------- labels UI ----------
function syncLabelFields() {
  const L = state.layout.labels;
  if (!L) return;
  $('layLabels').checked = !!L.enabled;
  $('layLabelFields').hidden = !L.enabled;
  $('layLabelProcess').value = L.process;
  $('layLabelBitRow').hidden = L.process !== 'router';
  $('layLabelHeight').value = fmtDim(L.height);
  $('layLabelBit').value = fmtDim(L.bitDia);
  $('layLabelMargin').value = fmtDim(L.margin);
  $('layLabelDepth').value = fmtDim(L.depth);
  $('layLabelFollow').checked = !!L.follow;
}
// One line saying what will actually be engraved, and every reason a label
// cannot be. Never silently drops one (labelling PRD, Q5).
function updateLabelInfo() {
  const el = $('layLabelInfo');
  const L = state.layout.labels;
  if (!L || !L.enabled) { el.textContent = ''; el.className = 'hint'; return; }
  const pockets = layoutPockets(state.layout.items, state.layout.clearance);
  const placed = layPlacedLabels(pockets);
  const issues = layoutLabelConflicts(layContainerLoop(), pockets, placed,
    { ...L, border: layBorderEff() });
  if (!placed.length) {
    el.textContent = 'Nothing to label yet — add a tool.';
    el.className = 'hint'; return;
  }
  const min = labelMinHeight(L);
  if (!issues.length) {
    el.textContent = `${placed.length} label${placed.length === 1 ? '' : 's'} at ` +
      `${fmtDimL(L.height)} caps (${L.process} needs ${fmtDimL(min)}).`;
    el.className = 'hint'; return;
  }
  const by = k => issues.filter(x => x.kind === k);
  const parts = [];
  if (by('tooSmall').length) parts.push(`${by('tooSmall').length} too small for ${L.process} (needs ${fmtDimL(min)})`);
  if (by('pocket').length) parts.push(`${by('pocket').length} overlapping a pocket`);
  if (by('label').length) parts.push(`${by('label').length} overlapping another label`);
  if (by('border').length) parts.push(`${by('border').length} across the border`);
  el.textContent = `${placed.length} label${placed.length === 1 ? '' : 's'}, but ${parts.join(', ')}.`;
  el.className = 'warn';
}
$('layLabels').addEventListener('change', e => {
  state.layout.labels.enabled = e.target.checked;
  syncLabelFields();
  updateLayoutInfo();
});
$('layLabelProcess').addEventListener('change', e => {
  state.layout.labels.process = e.target.value;
  syncLabelFields();
  updateLayoutInfo();
});
$('layLabelFollow').addEventListener('change', e => {
  state.layout.labels.follow = e.target.checked;
  updateLayoutInfo();
});
for (const [id, key, min] of [
  ['layLabelHeight', 'height', 0.5], ['layLabelBit', 'bitDia', 0.1],
  ['layLabelMargin', 'margin', 0], ['layLabelDepth', 'depth', 0.05],
]) {
  $(id).addEventListener('change', e => {
    const v = parseDim(e.target.value);
    if (Number.isFinite(v) && v >= min) state.layout.labels[key] = v;
    syncLabelFields();
    updateLayoutInfo();
  });
}

function layTileOpts() {
  return { tabs: state.layout.bed.tabs, labels: layLabelLoops() };
}
// Tiling summary for the current layout (null = fits, or no bed set).
function layTilePlan(res) {
  const bed = layBedDims();
  if (!bed || !res || !res.template) return null;
  return laySplitWithOffset(res.template, bed.w, bed.h, layTileOpts());
}
$('layTabs').addEventListener('change', e => {
  state.layout.bed.tabs.enabled = e.target.checked;
  syncBedFields();
  updateLayoutInfo();
});
for (const [id, key, min] of [
  ['layTabHead', 'head', 3], ['layTabNeck', 'neck', 2], ['layTabDepth', 'depth', 3],
  ['layTabSpacing', 'spacing', 20], ['layTabFit', 'fit', -5],
]) {
  $(id).addEventListener('change', e => {
    const mm = parseDim(e.target.value);
    if (mm !== null && mm >= min) {
      const t = state.layout.bed.tabs;
      t[key] = mm;
      if (t.neck > t.head - 1) t.neck = Math.max(2, t.head - 1);   // a neck wider than the head is no knob
      if (t.depth < t.head / 2 + 2) t.depth = t.head / 2 + 2;      // the head must clear the seam
    }
    syncBedFields();
    updateLayoutInfo();
  });
}
$('layBed').addEventListener('change', e => {
  state.layout.bed.preset = e.target.value;
  syncBedFields();
  refreshLayoutEditor();
});
// A plate shape: a saved container outline standing in for a round or
// cut-cornered build plate. Choosing one sizes the bed to the shape, since a
// plate and its bounding rectangle must agree about how much room there is.
// The rectangle the bed had before a shape sized it to that shape's bounding
// box, so going back to Rectangular plate gives the user's own bed back rather
// than leaving the shape's square behind.
let layBedRect = null;
$('layBedShape').addEventListener('change', e => {
  const b = state.layout.bed;
  const o = e.target.value === 'rect' ? null : libLoad()[+e.target.value];
  if (!o || !o.outer || o.outer.length < 3) {
    const box = b.shape && b.shape.outer && b.shape.outer.length >= 3 ? layBox(b.shape.outer) : null;
    // Only restore a bed the shape itself sized: a bed the user retyped while
    // the shape was on is theirs, and stays.
    const untouched = box &&
      Math.abs(b.w - Math.round(box.w * 1000) / 1000) < 1e-6 &&
      Math.abs(b.h - Math.round(box.h * 1000) / 1000) < 1e-6;
    if (layBedRect && untouched) {
      b.preset = layBedRect.preset; b.w = layBedRect.w; b.h = layBedRect.h;
    }
    layBedRect = null;
    b.shape = null;
  } else {
    if (!b.shape) layBedRect = { preset: b.preset, w: b.w, h: b.h };
    b.shape = { name: o.name, outer: structuredClone(o.outer) };
    const box = layBox(b.shape.outer);
    b.preset = 'custom';
    b.w = Math.round(box.w * 1000) / 1000;
    b.h = Math.round(box.h * 1000) / 1000;
  }
  syncBedFields();
  refreshLayoutEditor();
});
$('layBedCentreBtn').addEventListener('click', () => {
  if (!layBedCentre()) return;
  syncBedFields();
  refreshLayoutEditor();
});
// Arrow keys nudge the plate once its outline is selected: 1 mm, or 10 mm
// with Shift. Nothing else on Step 4 uses the arrow keys.
document.addEventListener('keydown', e => {
  if (state.step !== 4 || !layoutEditor.bedSel) return;
  const t = e.target.tagName;
  if (t === 'INPUT' || t === 'SELECT' || t === 'TEXTAREA') return;
  const d = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
  if (!d) return;
  e.preventDefault();
  const mm = e.shiftKey ? 10 : 1;
  layoutEditor.nudgeBed(d[0] * mm, d[1] * mm);
  syncBedFields();
  refreshLayoutEditor();
});
for (const [id, key] of [['layBedW', 'w'], ['layBedH', 'h']]) {
  $(id).addEventListener('change', e => {
    const mm = parseDim(e.target.value);
    if (mm > 10) state.layout.bed[key] = mm;
    syncBedFields();
    refreshLayoutEditor();
  });
}
// Place one palette entry into the layout. Both the quick-add select and the
// palette rows go through here, so a tool lands in the same seeded grid slot
// however it was picked: offset by the item's index, never by chance.
// `source` is provenance only — a placed item is a self-contained copy.
function layPlaceTool(src) {
  const loop = layContainerLoop();
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of loop) {
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
  }
  const n = state.layout.items.length;
  const it = {
    name: src.name, outer: src.outer, holes: src.holes || [], circles: src.circles || [],
    thickness: src.thickness || state.regions[0].thickness, depth: null, rot: 0,
    x: (minX + maxX) / 2 + (n % 3) * 12 - 12,
    y: (minY + maxY) / 2 + Math.floor(n / 3) * 12,
  };
  if (src.source) it.source = structuredClone(src.source);
  // The photo rides along with the copy, so a saved project shows the tools
  // even on a machine that has never seen the folder they came from.
  if (src.thumb) it.thumb = structuredClone(src.thumb);
  state.layout.items.push(it);
  return state.layout.items.length - 1;
}

// ---------- the Step 4 palette: Library and Folder ----------

// What the last opened folder read. Replaced wholesale by the folder
// backends; empty until one of them runs.
let layFolder = { entries: [], skipped: [], label: '' };

const SKIP_WORDS = {
  'not-json': 'not a .json file',
  'parse-error': 'not readable JSON',
  'not-a-trace': 'JSON, but no trace in it',
  container: 'a container outline, not a tool',
};

function layPaletteRow(name, hint, buttons) {
  const row = document.createElement('div');
  row.className = 'pal-row';
  row.style.cssText = 'display:flex; align-items:center; gap:6px; padding:2px 0';
  const label = document.createElement('span');
  label.style.cssText = 'flex:1; min-width:0; display:flex; gap:6px; align-items:baseline';
  const nm = document.createElement('span');
  nm.className = 'pal-name';
  nm.style.cssText = 'overflow:hidden; text-overflow:ellipsis; white-space:nowrap';
  nm.textContent = name;
  label.appendChild(nm);
  if (hint) {
    const h = document.createElement('span');
    h.className = 'hint';
    h.style.cssText = 'margin:0; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; opacity:.7';
    h.textContent = hint;
    label.appendChild(h);
    row.title = hint;
  }
  row.appendChild(label);
  for (const [text, title, fn] of buttons) {
    const b = document.createElement('button');
    b.className = 'btn small';
    b.textContent = text;
    if (title) b.title = title;
    b.addEventListener('click', fn);
    row.appendChild(b);
  }
  return row;
}

// A folder entry saved into the library keeps its geometry and drops its
// provenance: the library is this browser's own copy, not a pointer at a file.
function layPaletteSaveToLibrary(entry) {
  const { source, ...rest } = entry;
  const o = structuredClone(rest);
  o.kind = 'tool';
  if (!o.thickness) o.thickness = state.regions[0].thickness;
  o.measurements = o.measurements || [];
  o.constraints = o.constraints || [];
  o.arcs = o.arcs || [];
  o.lines = o.lines || [];
  const list = libLoad();
  const at = list.findIndex(e => e.name === o.name);
  if (at >= 0) list[at] = o; else list.push(o);
  const fitted = libFitThumbs(list);
  if (libSave(fitted.list)) {
    toast(fitted.dropped
      ? `Saved \u201c${o.name}\u201d. The library is near the browser's 5 MB limit, so it was saved without photos.`
      : `Saved \u201c${o.name}\u201d to the outline library.`);
    refreshLibList();
  } else toast('Could not save \u2014 storage is unavailable here.');
}

function refreshLayPalette() {
  const lib = libLoad().filter(o => o.kind !== 'container');
  const libList = $('layPalLibList');
  libList.innerHTML = '';
  $('layPalLibCount').textContent = lib.length ? `${lib.length}` : '';
  if (!lib.length) {
    const p = document.createElement('p');
    p.className = 'hint';
    p.style.margin = '2px 0';
    p.textContent = 'Nothing saved yet.';
    libList.appendChild(p);
  }
  for (const o of lib) {
    libList.appendChild(layPaletteRow(o.name, '', [
      ['\uff0b Add', 'Place this tool in the drawer', () => {
        const i = layPlaceTool(structuredClone(o));
        layoutEditor.sel = i;
        syncLaySelPanel(i);
        refreshLayoutEditor();
      }],
    ]));
  }

  const group = $('layPalFolderGroup');
  const has = layFolder.entries.length > 0 || layFolder.skipped.length > 0;
  group.hidden = !has;
  $('layPalFolderName').textContent = layFolder.label || '';
  $('layPalAddAllBtn').disabled = layFolder.entries.length === 0;
  const skip = $('layPalSkipped');
  skip.hidden = layFolder.skipped.length === 0;
  skip.textContent = layFolder.skipped.length
    ? `${layFolder.skipped.length} file${layFolder.skipped.length === 1 ? '' : 's'} skipped`
    : '';
  skip.title = layFolder.skipped
    .map(s => `${s.name ? `${s.path} \u203a ${s.name}` : s.path}: ${SKIP_WORDS[s.reason] || s.reason}`)
    .join('\n');
  const folderList = $('layPalFolderList');
  folderList.innerHTML = '';
  // Two traces can share a name, so the path is what tells them apart.
  for (const e of layFolder.entries) {
    folderList.appendChild(layPaletteRow(e.name, e.source ? e.source.path : '', [
      ['\uff0b Add', 'Place this tool in the drawer', () => {
        const i = layPlaceTool(structuredClone(e));
        layoutEditor.sel = i;
        syncLaySelPanel(i);
        refreshLayoutEditor();
      }],
      ['\u2606 Library', 'Save this trace to the outline library', () => layPaletteSaveToLibrary(e)],
    ]));
  }
}

// Called by the folder backends once a folder has been read.
function laySetFolder(read, label) {
  layFolder = {
    entries: (read && read.entries) || [],
    skipped: (read && read.skipped) || [],
    label: label || '',
  };
  refreshLayPalette();
}

// ---------- the two folder backends ----------

// The File System Access handle for the open folder, when the browser has
// that API. Null on the directory-input path, which reads once and cannot
// write, so "Save here" stays hidden there.
let layFolderHandle = null;
// What the Reopen button offers: the folder picked this session, or the one
// IndexedDB remembers from a previous load. { label, handle }.
let layRemembered = null;

// A folder of hundreds of files is read one at a time, so the header counts
// up instead of sitting blank. laySetFolder overwrites this when it lands.
function layFolderProgress(done, total) {
  $('layPalFolderGroup').hidden = false;
  $('layPalFolderName').textContent = `reading ${done}/${total}\u2026`;
}

function syncFolderButtons() {
  const re = $('layReopenFolderBtn');
  const label = layRemembered && layRemembered.label;
  re.hidden = !label;
  re.textContent = label ? `\u21BB ${label}` : '';
  re.title = label ? `Re-read \u201c${label}\u201d from disk` : '';
  // Writing back needs a handle. The directory input has none.
  $('layPalSaveFolderBtn').hidden = !layFolderHandle;
}

// Walk a directory handle into the same { path, file } pairs the directory
// input hands over, read them, and show the result.
async function layUseHandle(handle, label) {
  if (!await ensurePermission(handle, 'read')) {
    toast('That folder was not shared with this page.');
    return false;
  }
  const name = label || handle.name || 'folder';
  layFolderHandle = handle;
  layRemembered = { label: name, handle };
  syncFolderButtons();
  const pairs = await walkFolder(handle);
  laySetFolder(await tracesFromFiles(pairs, { onProgress: layFolderProgress }), name);
  syncFolderButtons();
  await rememberFolder(handle, name);
  return true;
}

$('layOpenFolderBtn').addEventListener('click', async () => {
  if (hasDirectoryPicker()) {
    let handle = null;
    try {
      handle = await pickFolder();
    } catch {
      // The API is there but unusable here (an iframe, a policy). Fall back.
      $('layFolderInput').click();
      return;
    }
    if (!handle) return; // cancelled: do not pop the input open behind it
    await layUseHandle(handle);
    return;
  }
  $('layFolderInput').click();
});

$('layReopenFolderBtn').addEventListener('click', async () => {
  let handle = layRemembered && layRemembered.handle;
  let label = layRemembered && layRemembered.label;
  if (!handle) {
    const got = await recallFolder();
    if (got) { handle = got.handle; label = got.label; }
  }
  if (!handle) { toast('That folder is gone \u2014 open it again.'); return; }
  await layUseHandle(handle, label);
});

// The baseline backend: one shot, every file already read, no handle to keep.
$('layFolderInput').addEventListener('change', async e => {
  const files = Array.from(e.target.files || []);
  e.target.value = '';
  if (!files.length) return;
  layFolderHandle = null;
  const label = (files[0].webkitRelativePath || '').split('/')[0] || 'folder';
  syncFolderButtons();
  laySetFolder(await tracesFromFiles(files, { onProgress: layFolderProgress }), label);
});

// Project JSON is the only thing written into the folder; exports keep going
// through the browser's own download, which needs no collision policy.
$('layPalSaveFolderBtn').addEventListener('click', async () => {
  if (!layFolderHandle) { toast('Open a folder with the picker first.'); return; }
  if (!await ensurePermission(layFolderHandle, 'readwrite')) {
    toast('The folder is open for reading only.');
    return;
  }
  try {
    const written = await writeProjectFile(
      layFolderHandle, state.fileName || 'drawer', serializeProject(false));
    toast(`Saved \u201c${written}\u201d into the folder.`);
  } catch {
    toast('Could not write into the folder.');
  }
});

// A remembered handle survives the reload; the permission does not, so the
// button only offers the folder and the click re-requests it.
if (hasDirectoryPicker()) {
  recallFolder().then(got => {
    if (!got || layRemembered) return;
    layRemembered = { label: got.label, handle: got.handle };
    syncFolderButtons();
  });
}

$('layPalAddAllBtn').addEventListener('click', () => {
  if (!layFolder.entries.length) { toast('Open a folder of traces first.'); return; }
  // One redraw at the end, not one per tool.
  for (const e of layFolder.entries) layPlaceTool(structuredClone(e));
  layoutEditor.sel = state.layout.items.length - 1;
  syncLaySelPanel(layoutEditor.sel);
  refreshLayoutEditor();
  toast(`Added ${layFolder.entries.length} tool${layFolder.entries.length === 1 ? '' : 's'} from the folder.`);
});

$('layAddBtn').addEventListener('click', () => {
  const v = $('layToolSel').value;
  let src = null;
  if (v === '__current') {
    const { outer, holes, circles } = traceEditor.getTrace();
    if (!outer || outer.length < 3) { toast('No traced outline to add yet.'); return; }
    // Normalize like the library does so placement math matches.
    let minX = Infinity, minY = Infinity;
    for (const p of outer) { minX = Math.min(minX, p.x); minY = Math.min(minY, p.y); }
    const off = p => ({ x: p.x - minX + 5, y: p.y - minY + 5 });
    src = {
      name: state.fileName || 'current outline',
      outer: outer.map(off), holes: holes.map(h => h.map(off)),
      circles: circles.map(c => ({ ...c, cx: c.cx - minX + 5, cy: c.cy - minY + 5 })),
      thickness: state.regions[0].thickness,
    };
  } else {
    const o = libLoad()[+v];
    if (!o) { toast('Pick a tool outline first.'); return; }
    src = structuredClone(o);
    if (!src.thickness) src.thickness = state.regions[0].thickness;
  }
  const i = layPlaceTool(src);
  layoutEditor.sel = i;
  syncLaySelPanel(i);
  refreshLayoutEditor();
});
// Photos inside traces. On by default: the point of the thumbnails is that
// the drawer reads as the tools rather than as silhouettes.
layoutEditor.showPhotos = $('layShowPhotos').checked;
$('layShowPhotos').addEventListener('change', e => {
  layoutEditor.showPhotos = e.target.checked;
  layoutEditor.draw();
});

$('layRemoveBtn').addEventListener('click', () => {
  if (layoutEditor.sel < 0) return;
  state.layout.items.splice(layoutEditor.sel, 1);
  layoutEditor.sel = -1;
  syncLaySelPanel(-1);
  refreshLayoutEditor();
});
// A placement's label defaults to the library entry's name. It is stored
// separately (and only when it differs) so renaming the label in one drawer
// never renames that tool in every other layout that uses it.
function setItemLabel(text) {
  const it = state.layout.items[layoutEditor.sel];
  if (!it) return;
  const t = String(text || '').trim();
  if (!t || t === it.name) delete it.label; else it.label = t;
  syncLaySelPanel(layoutEditor.sel);
  refreshLayoutEditor();
}
$('laySelLabel').addEventListener('change', e => setItemLabel(e.target.value));
$('laySelLabelReset').addEventListener('click', () => setItemLabel(''));
$('laySelDepth').addEventListener('change', e => {
  const it = state.layout.items[layoutEditor.sel];
  if (!it) return;
  const raw = e.target.value.trim();
  if (raw === '') it.depth = null;
  else {
    const mm = parseDim(raw);
    if (mm > 0) it.depth = mm;
  }
  syncLaySelPanel(layoutEditor.sel);
  updateLayoutInfo();
});
$('laySelRot').addEventListener('change', e => {
  const it = state.layout.items[layoutEditor.sel];
  if (!it) return;
  const deg = parseFloat(e.target.value);
  if (Number.isFinite(deg)) it.rot = ((deg % 360) + 360) % 360;
  refreshLayoutEditor();
  syncLaySelPanel(layoutEditor.sel);
});
$('laySelNotch').addEventListener('change', e => {
  const it = state.layout.items[layoutEditor.sel];
  if (!it) return;
  if (e.target.checked) {
    // Seed at the outline's bottom mid-edge (local coords); drag to place.
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of it.outer) {
      minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
      minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
    }
    const dia = parseDim($('laySelNotchDia').value) || 25;
    it.notch = { x: (minX + maxX) / 2, y: maxY, dia };
  } else {
    it.notch = null;
  }
  syncLaySelPanel(layoutEditor.sel);
  refreshLayoutEditor();
});
$('laySelNotchDia').addEventListener('change', e => {
  const it = state.layout.items[layoutEditor.sel];
  if (!it || !it.notch) return;
  const mm = parseDim(e.target.value);
  if (mm > 2) it.notch.dia = mm;
  syncLaySelPanel(layoutEditor.sel);
  refreshLayoutEditor();
});
$('layPreviewBtn').addEventListener('click', () => {
  state.holder.type = 'layout';
  $('holderType').value = 'layout';
  $('foamParams').hidden = true;
  goStep(3);
  rebuildHolder();
});
// ---------- layout export, shared by every row that offers it ----------
// These are the bodies the layout export buttons used to carry inline. They
// build and name the file but do not deliver it, so any row can offer the
// same export and every row produces the same bytes.
function layoutStlExport() {
  const res = buildLayoutNow();
  if (!res || res.reason) { toast((res && LAYOUT_REASONS[res.reason]) || 'Could not build the insert.'); return null; }
  const grid = state.layout.container.type === 'grid';
  const bed = layBedDims();
  if (bed && res.stats && res.stats.slab && (res.stats.slab.w > bed.w + 1e-6 || res.stats.slab.h > bed.h + 1e-6)) {
    toast(`Heads up: this is ${fmtDim(res.stats.slab.w)} × ${fmtDim(res.stats.slab.h)}, larger than the ${fmtDim(bed.w)} × ${fmtDim(bed.h)} bed. The STL exports whole — STL tiling isn't available yet; the cut template splits into tiles.`, 7000);
  }
  return {
    blob: toBinarySTL(res.positions, res.indices, `${state.fileName} ${grid ? 'gridfinity' : 'drawer'}`),
    name: `${state.fileName}-${grid ? 'bin' : 'drawer'}-2p5d.stl`,
  };
}
// mode 'auto' tiles only when the layout is larger than the bed, which is what
// the single Template SVG button has always done. mode 'tiles' is the explicit
// tiled button and declines when there is nothing to tile.
function layoutSvgExport(mode = 'auto') {
  const res = buildLayoutNow();
  if (!res || res.reason) { toast((res && LAYOUT_REASONS[res.reason]) || 'Could not build the template.'); return null; }
  if (!res.template) { toast('Template SVG is for flat drawer inserts (foam cutting) — export the bin as STL.'); return null; }
  const plan = layTilePlan(res);
  if (plan) {
    const bed = layBedDims();
    toast(`Exported ${plan.tiles.length} tiles for the ${fmtDim(bed.w)} × ${fmtDim(bed.h)} bed — cut one per bed load (labels A1, A2… mark the drawer position).`, 6500);
    return {
      blob: toTiledSVG(plan.tiles, { name: state.fileName }),
      name: `${state.fileName}-drawer-tiles-${plan.nx}x${plan.ny}.svg`,
    };
  }
  if (mode === 'tiles') {
    toast('This layout already fits the bed in one piece — use Template SVG.');
    return null;
  }
  const T = res.template;
  const shift = pts => pts.map(p => ({ x: p.x - T.origin.x, y: p.y - T.origin.y }));
  const holes = T.pockets.flatMap(p => [shift(p.pocket), ...p.pillars.map(shift)]);
  const blob = toSVG(shift(T.slab), holes, T.w, T.h,
    { engrave: layLabelLoops().map(shift) });
  return { blob, name: `${state.fileName}-drawer-template.svg` };
}
function deliverLayoutExport(out) {
  if (out) deliverExport(out.blob, out.name);
}
$('layExportBtn').addEventListener('click', () => deliverLayoutExport(layoutStlExport()));
$('layExportSvgBtn').addEventListener('click', () => deliverLayoutExport(layoutSvgExport('auto')));
$('layExportTilesBtn').addEventListener('click', () => deliverLayoutExport(layoutSvgExport('tiles')));

// ---------- wiring: step 1 ----------

// Populate a reference <select>, bucketing entries with a `group` into
// <optgroup> submenus (first-seen order) and leaving ungrouped ones inline.
function populateRefSelect(sel, table) {
  const groups = new Map();
  for (const [key, val] of Object.entries(table)) {
    const opt = document.createElement('option');
    opt.value = key;
    opt.textContent = val.name;
    if (val.group) {
      let og = groups.get(val.group);
      if (!og) { og = document.createElement('optgroup'); og.label = val.group; groups.set(val.group, og); sel.appendChild(og); }
      og.appendChild(opt);
    } else {
      sel.appendChild(opt);
    }
  }
}

const sizeSel = $('paperSize');
populateRefSelect(sizeSel, PAPER_SIZES);
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
$('captureArea').addEventListener('change', e => {
  state.captureFrac = parseFloat(e.target.value) || 0;
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
populateRefSelect(coinSel, COIN_SIZES);
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

function syncRefControls() {
  const r = state.reference;
  $('rectRefControls').hidden = r !== 'rect';
  $('gridRefControls').hidden = r !== 'grid';
  $('coinRefControls').hidden = r !== 'coin';
  $('barRefControls').hidden = r !== 'bar';
  cornerEditor.setRefMode(r === 'coin' ? 'coin' : r === 'bar' ? 'bar' : 'corners');
  if (r === 'grid') syncGridFields();
  if (r === 'bar') syncBarFields();
}
$('refType').addEventListener('change', e => {
  state.reference = e.target.value;
  syncRefControls();
  $('gridCheck').textContent = '';
  if (state.image) {
    if (state.reference === 'coin' && !cornerEditor.getCoin()) cornerEditor.setRefMode('coin');
    if (state.reference === 'bar' && !cornerEditor.getBar()) cornerEditor.setRefMode('bar');
    // The grid reference is placed by hand on intersections — paper-edge
    // detection would drag the handles onto the sheet instead.
    if (state.reference === 'rect' && !state.corners) autoDetect(false);
    if (state.reference === 'grid' && !state.corners) {
      state.corners = defaultCorners();
      cornerEditor.setCorners(state.corners);
    }
  }
  state.rectDirty = true;
  updateStepButtons();
});

// ---------- graph / dot-grid reference ----------

(() => {
  const sel = $('gridPitch');
  const groups = new Map();
  for (const [key, val] of Object.entries(GRID_PITCHES)) {
    const opt = document.createElement('option');
    opt.value = key; opt.textContent = val.name;
    if (val.group) {
      let og = groups.get(val.group);
      if (!og) { og = document.createElement('optgroup'); og.label = val.group; groups.set(val.group, og); sel.appendChild(og); }
      og.appendChild(opt);
    } else sel.appendChild(opt);
  }
  sel.value = state.grid.pitch;
})();
function syncGridFields() {
  $('gridPitch').value = state.grid.pitch;
  $('gridCustomRow').hidden = state.grid.pitch !== 'custom';
  $('gridCustomMm').value = fmtDim(state.grid.customMm);
  $('gridNX').value = String(state.grid.nx);
  $('gridNY').value = String(state.grid.ny);
  $('gridCapture').value = String(state.captureFrac || 0);
  $('gridResetBtn').disabled = !state.image;
}
$('gridPitch').addEventListener('change', e => {
  state.grid.pitch = e.target.value;
  state.rectDirty = true;
  syncGridFields();
});
$('gridCustomMm').addEventListener('change', e => {
  const mm = parseDim(e.target.value);
  if (mm > 0.2) state.grid.customMm = mm;
  state.rectDirty = true;
  syncGridFields();
});
for (const [id, key] of [['gridNX', 'nx'], ['gridNY', 'ny']]) {
  $(id).addEventListener('change', e => {
    const n = parseInt(e.target.value, 10);
    if (n >= 1 && n <= 500) state.grid[key] = n;
    // A typed count is the manual override: pin it for this placement so
    // the next rectification doesn't auto-count over it.
    state.grid.autoSig = gridAutoSig();
    state.grid.lastAuto = null;
    $('gridAutoMsg').textContent = `Using your count: ${state.grid.nx} × ${state.grid.ny}.`;
    $('gridAutoMsg').className = 'hint';
    state.rectDirty = true;
    syncGridFields();
  });
}
$('gridAutoBtn').addEventListener('click', () => {
  if (!state.image) { toast('Load a photo first.'); return; }
  const ac = runGridAutoCount(true);
  if (ac && ac.ok) toast(`Auto-counted ${ac.nx} × ${ac.ny} squares.`);
});

// ---------- scale-bar reference ----------

function syncBarFields() {
  $('barLength').value = fmtDim(state.bar.lengthMm);
  cornerEditor.setBarLabel(fmtDimL(state.bar.lengthMm));
}
$('barLength').addEventListener('change', e => {
  const mm = parseDim(e.target.value);
  if (mm > 0) state.bar.lengthMm = mm;
  state.rectDirty = true;
  syncBarFields();
});
$('gridCapture').addEventListener('change', e => {
  state.captureFrac = parseFloat(e.target.value) || 0;
  $('captureArea').value = e.target.value;
  state.rectDirty = true;
});
$('gridResetBtn').addEventListener('click', () => {
  if (!state.image) return;
  state.corners = defaultCorners();
  cornerEditor.setCorners(state.corners);
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
  } else if (state.reference === 'bar') {
    const bar = cornerEditor.getBar();
    if (bar) {
      const a = map({ x: bar.ax, y: bar.ay }), b = map({ x: bar.bx, y: bar.by });
      cornerEditor.setBar({ ax: a.x, ay: a.y, bx: b.x, by: b.y });
    }
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
    $('labelPanel').hidden = btn.dataset.tool !== 'label';
    if (btn.dataset.tool === 'measure') refreshMeasurePanel();
    if (btn.dataset.tool === 'constrain') { refreshConstrainButtons(); refreshConstraintList(); }
    if (btn.dataset.tool === 'label') syncLabelPanel();
  });
}

// ---------- label (emboss / deboss) panel ----------

function activeLabel() {
  const i = traceEditor.selLabel;
  return i >= 0 && i < state.labels.length ? state.labels[i] : null;
}

function syncLabelPanel() {
  if ($('labelPanel').hidden) return;
  const L = activeLabel();
  const on = !!L;
  for (const id of ['labelText', 'labelMode', 'labelFace', 'labelHeight', 'labelDepth',
    'labelX', 'labelY', 'labelRot', 'labelFont', 'labelMirror', 'labelDeleteBtn']) {
    $(id).disabled = !on;
  }
  if (!on) {
    $('labelNote').textContent = state.labels.length
      ? 'Click a label to select it, or click empty space to add one.'
      : 'Click the part to place a label.';
    return;
  }
  $('labelText').value = L.text || '';
  $('labelMode').value = L.mode || 'emboss';
  $('labelFace').value = L.face || 'top';
  $('labelHeight').value = fmtDim(L.height);
  $('labelDepth').value = fmtDim(L.depth);
  $('labelX').value = fmtDim(L.x);
  $('labelY').value = fmtDim(L.y);
  $('labelRot').value = Math.round((L.rot || 0) * 10) / 10;
  $('labelFont').value = L.font || 'bold sans-serif';
  $('labelMirror').checked = !!L.mirror;
  $('labelNote').textContent = L.mode === 'deboss'
    ? `Engraved ${fmtDimL(L.depth)} into the ${L.face} face.`
    : `Raised ${fmtDimL(L.depth)} above the ${L.face} face.`;
}

// Edit the selected label, redraw, and rebuild the 3D preview.
function updateLabel(props) {
  const L = activeLabel();
  if (!L) return;
  Object.assign(L, props);
  traceEditor.draw();
  syncLabelPanel();
  rebuildMesh();
}

$('labelText').addEventListener('input', e => updateLabel({ text: e.target.value }));
$('labelMode').addEventListener('change', e => updateLabel({ mode: e.target.value }));
$('labelFace').addEventListener('change', e => {
  // A bottom-face label reads correctly from below only when mirrored, so
  // flip the default with the face (still overridable).
  updateLabel({ face: e.target.value, mirror: e.target.value === 'bottom' });
});
$('labelFont').addEventListener('change', e => updateLabel({ font: e.target.value }));
$('labelMirror').addEventListener('change', e => updateLabel({ mirror: e.target.checked }));
$('labelRot').addEventListener('change', e => {
  const v = parseFloat(e.target.value);
  if (isFinite(v)) updateLabel({ rot: v });
});
for (const [id, key, min] of [['labelHeight', 'height', 0.5], ['labelDepth', 'depth', 0.05],
  ['labelX', 'x', -1e6], ['labelY', 'y', -1e6]]) {
  $(id).addEventListener('change', e => {
    const mm = parseDim(e.target.value);
    if (mm !== null && isFinite(mm) && mm >= min) updateLabel({ [key]: mm });
    else syncLabelPanel();
  });
}
$('labelDeleteBtn').addEventListener('click', () => {
  if (traceEditor.deleteSelectedLabel()) { syncLabelPanel(); rebuildMesh(); }
});

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
$('suggestRegionsBtn').addEventListener('click', () => {
  if (!state.rect) { toast('Rectify a photo first — regions are read from the image.'); return; }
  const { outer, holes, circles } = traceEditor.getTrace();
  if (!outer || outer.length < 3) { toast('Trace the object first.'); return; }
  const circPoly = c => {
    const pts = [];
    for (let k = 0; k < 24; k++) { const a = k / 24 * Math.PI * 2; pts.push({ x: c.cx + c.d / 2 * Math.cos(a), y: c.cy + c.d / 2 * Math.sin(a) }); }
    return pts;
  };
  const holePolys = [...holes, ...circles.map(circPoly)];
  const cands = suggestRegions(state.rect.canvas, outer, holePolys, state.rect.pxPerMm);
  if (!cands.length) {
    toast('No distinct raised/recessed areas found — draw sections by hand with the ▱ tool.');
    return;
  }
  traceEditor.pushUndo();
  const base = state.regions[0].thickness;
  let raisedN = 0;
  for (const c of cands) {
    // Bright patches read as raised (catch light) → default a small boss above
    // the base; dark ones may be recesses the flat model can't cut, so leave
    // them at base and flag it in the name for the user to set (or deboss).
    const raised = c.kind === 'bright';
    if (raised) raisedN++;
    state.regions.push({
      name: `Region ${state.regions.length}${raised ? '' : ' (recess?)'}`,
      pts: c.pts,
      thickness: raised ? Math.round((base + 2) * 100) / 100 : base,
      zBase: 0,
      top: { mode: 'none', size: 1 },
      bottom: { mode: 'none', size: 1 },
      suggested: true,
    });
  }
  state.selRegion = state.regions.length - 1;
  traceEditor.setSections(state.regions);
  refreshModelFields();
  traceEditor.draw();
  toast(`${cands.length} region${cands.length > 1 ? 's' : ''} suggested (${raisedN} raised) — tweak the control points, then set each one's height / floor offset in step 3. A flat photo can't measure depth, so that part's on you.`, 6500);
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
    opt.textContent = (r.name || `Section ${i + 1}`) +
      (i === 0 ? ' (base)' : r.underside ? ' (underside)' : '');
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
  // Underside sections are bottom recesses: `thickness` is the recess depth
  // (how far off the bed) and the floor offset does not apply.
  const uz = !!r.underside;
  $('floorOffset').disabled = uz;
  document.querySelector('label[for="thickness"]').textContent =
    uz ? 'Off-bed depth (mm)' : 'Thickness (mm)';
  $('topMode').disabled = uz; $('topSize').disabled = uz;
  $('bottomMode').disabled = uz; $('bottomSize').disabled = uz;
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
    grid: { pitch: state.grid.pitch, customMm: state.grid.customMm, nx: state.grid.nx, ny: state.grid.ny },
    bar: { lengthMm: state.bar.lengthMm, geom: cornerEditor.getBar() },
    paper: state.paper,
    captureFrac: state.captureFrac,
    labels: state.labels,
    coin: state.coin,
    lens: state.lens,
    corners: state.corners,
    seg: state.seg,
    model: state.model,
    holder: state.holder,
    layout: state.layout,
    regions: state.regions,
    trace: traceEditor.getTrace(),
    measurements: traceEditor.measurements,
    constraints: traceEditor.constraints,
    arcs: traceEditor.arcs,
    lines: traceEditor.lines,
    holeTemplate: traceEditor.holeTemplate,
    pxPerMm: state.rect ? state.rect.pxPerMm : null,
    rectified: state.rect ? state.rect.canvas.toDataURL('image/jpeg', 0.85) : null,
    back: state.back.rect ? {
      rectified: state.back.rect.canvas.toDataURL('image/jpeg', 0.85),
      pxPerMm: state.back.rect.pxPerMm,
      align: state.back.align || null,
    } : null,
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
  if (Array.isArray(p.labels)) {
    state.labels.length = 0;
    for (const L of p.labels) state.labels.push(structuredClone(L));
    traceEditor.setLabels(state.labels);
  }
  if (typeof p.captureFrac === 'number') {
    state.captureFrac = p.captureFrac;
    $('captureArea').value = String(p.captureFrac);
  }
  if (p.coin) { state.coin = { ...state.coin, ...p.coin }; $('coinSize').value = state.coin.size; }
  if (p.lens) { state.lens = { k1: p.lens.k1 || 0, k2: p.lens.k2 || 0 }; }
  if (p.grid) state.grid = { ...state.grid, ...p.grid, autoSig: null, lastAuto: null };
  syncGridFields();
  if (p.bar) {
    if (p.bar.lengthMm > 0) state.bar.lengthMm = p.bar.lengthMm;
    if (p.bar.geom) cornerEditor.setBar(structuredClone(p.bar.geom));
  }
  if (['rect', 'coin', 'grid', 'bar'].includes(p.reference)) {
    state.reference = p.reference;
    $('refType').value = p.reference;
    syncRefControls();
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
  if (p.holder) {
    state.holder = {
      type: ['foam', 'grid', 'plate', 'holster', 'layout'].includes(p.holder.type) ? p.holder.type : 'none',
      foam: { ...state.holder.foam, ...(p.holder.foam || {}) },
      grid: { ...state.holder.grid, ...(p.holder.grid || {}) },
      plate: { ...state.holder.plate, ...(p.holder.plate || {}) },
      holster: { ...state.holder.holster, ...(p.holder.holster || {}) },
    };
  }
  if (p.layout && Array.isArray(p.layout.items)) {
    state.layout = {
      container: {
        ...state.layout.container, ...(p.layout.container || {}),
        // Defaulted, not inherited: a project saved before Known width existed
        // must land on 1 : 1 rather than on whatever was last measured here.
        scale: { x: 1, y: 1, ...((p.layout.container && p.layout.container.scale) || {}) },
      },
      items: structuredClone(p.layout.items),
      clearance: p.layout.clearance ?? state.layout.clearance,
      floor: p.layout.floor ?? state.layout.floor,
      border: p.layout.border ?? state.layout.border,
      bed: {
        ...state.layout.bed, ...(p.layout.bed || {}),
        tabs: { ...state.layout.bed.tabs, ...((p.layout.bed && p.layout.bed.tabs) || {}) },
        // Defaulted, not inherited: a project saved before the build plate
        // existed carries neither key, and must land on no plate shape and on
        // offset zero rather than on whatever plate the drawer before it left
        // on screen, which would retile it and change what it exports.
        shape: (p.layout.bed && p.layout.bed.shape) || null,
        offset: { x: 0, y: 0, ...((p.layout.bed && p.layout.bed.offset) || {}) },
      },
      // Merged onto the defaults, not taken from the file: a project saved
      // before labels existed has no `labels` key, and rebuilding state.layout
      // wholesale would otherwise leave it undefined.
      labels: {
        ...state.layout.labels, ...(p.layout.labels || {}),
        extra: structuredClone((p.layout.labels && p.layout.labels.extra) || []),
      },
    };
    // The bed remembered behind a plate shape belongs to the drawer that was
    // on screen, not to this one: clearing the loaded project's shape has to
    // give that project its own bed back, never the last drawer's.
    layBedRect = null;
  }
  syncHolderPanel();
  // Back (underside) photo: restore the rectified copy + alignment; the
  // registered underlay re-renders once the front rectification is back
  // (both restores are async, so retry briefly).
  state.back = { rect: null, align: null, registered: null, showing: false };
  backUISync();
  if (p.back && p.back.rectified && p.back.align) {
    const bim = new Image();
    bim.onload = () => {
      const c = document.createElement('canvas');
      c.width = bim.width; c.height = bim.height;
      c.getContext('2d').drawImage(bim, 0, 0);
      state.back.rect = { canvas: c, pxPerMm: p.back.pxPerMm || 4 };
      state.back.align = p.back.align;
      const tryRender = (n = 0) => {
        if (state.rect) { backRender(); }
        else if (n < 20) setTimeout(() => tryRender(n + 1), 250);
      };
      tryRender();
    };
    bim.src = p.back.rectified;
  }

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
// localStorage holds roughly 5 MB. A 256 px thumbnail is 10 to 25 KB, so a
// hundred tools stay under 3 MB, but a library closing on the ceiling would
// fail its next write outright. Past 4 MB the photos come out: the outlines
// are what the library is for, and a library without photos is exactly what
// existed before they did.
const LIB_WARN_BYTES = 4 * 1024 * 1024;
function libFitThumbs(list) {
  if (JSON.stringify(list).length <= LIB_WARN_BYTES) return { list, dropped: 0 };
  let dropped = 0;
  const trimmed = list.map(o => {
    if (!o || !o.thumb) return o;
    dropped++;
    const { thumb, ...rest } = o;
    return rest;
  });
  return { list: trimmed, dropped };
}
function refreshLibList() {
  const sel = $('libList');
  const cur = sel.value;
  const list = libLoad();
  sel.innerHTML = '<option value="">— saved outlines —</option>';
  list.forEach((o, i) => {
    const opt = document.createElement('option');
    opt.value = String(i);
    opt.textContent = `${o.name}${o.kind === 'container' ? ' ⬚' : ''}`;
    sel.appendChild(opt);
  });
  if (cur && +cur < list.length) sel.value = cur;
  const ok = libAvailable();
  $('libSaveBtn').disabled = !ok;
  $('libLoadBtn').disabled = !ok;
  $('libDeleteBtn').disabled = !ok;
  $('libNote').textContent = ok ? '' : 'Storage is unavailable here — the library needs the offline or hosted copy.';
  if (!$('layoutModal').hidden) refreshLaySelects();
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
    kind: $('libKind').value === 'container' ? 'container' : 'tool',
    thickness: state.regions[0].thickness, // pocket-depth default for layouts
    outer: outer.map(off),
    holes: holes.map(h => h.map(off)),
    circles: circles.map(c => ({ ...c, cx: c.cx - minX + M, cy: c.cy - minY + M })),
    // Refs are index-based, so they survive the origin shift unchanged.
    measurements: structuredClone(traceEditor.measurements),
    constraints: structuredClone(traceEditor.constraints),
    arcs: structuredClone(traceEditor.arcs),
    lines: structuredClone(traceEditor.lines),
  };
  // The rectified photo, cropped to this outline, so the layout editor can
  // draw the tool rather than its silhouette.
  if (state.rect) {
    const t = thumbFromImage(state.rect.canvas, state.rect.pxPerMm, outer);
    if (t) {
      entry.thumb = {
        dataUrl: t.dataUrl, mmPerPx: t.mmPerPx,
        origin: { x: t.origin.x - minX + M, y: t.origin.y - minY + M },
      };
    }
  }
  const list = libLoad();
  const existing = list.findIndex(o => o.name === name);
  if (existing >= 0) list[existing] = entry; else list.push(entry);
  const fitted = libFitThumbs(list);
  if (libSave(fitted.list)) {
    toast(fitted.dropped
      ? `Saved “${name}”. The library is near the browser's 5 MB limit, so it was saved without photos.`
      : `Saved “${name}” to the outline library.`);
    refreshLibList();
  } else toast('Could not save — storage is unavailable here.');
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

// ---------- theme: dark (default) → light → auto (follow system) ----------
const THEME_KEY = '2p5d.theme';
const sysLight = window.matchMedia ? window.matchMedia('(prefers-color-scheme: light)') : null;
let themeMode = 'dark'; // first visit defaults to dark, not the system
try {
  const saved = localStorage.getItem(THEME_KEY);
  if (saved === 'light' || saved === 'auto' || saved === 'dark') themeMode = saved;
} catch { /* storage blocked */ }
function applyTheme() {
  const light = themeMode === 'light' || (themeMode === 'auto' && sysLight && sysLight.matches);
  document.documentElement.classList.toggle('light', light);
  $('themeToggle').textContent = { dark: '🌙', light: '☀', auto: '🌗' }[themeMode];
  $('themeToggle').title = {
    dark: 'Theme: dark — click for light',
    light: 'Theme: light — click for auto (follow system)',
    auto: `Theme: auto (following system, currently ${light ? 'light' : 'dark'}) — click for dark`,
  }[themeMode];
}
applyTheme();
$('themeToggle').addEventListener('click', () => {
  themeMode = { dark: 'light', light: 'auto', auto: 'dark' }[themeMode];
  try { localStorage.setItem(THEME_KEY, themeMode); } catch { /* storage blocked */ }
  applyTheme();
});
if (sysLight && sysLight.addEventListener) {
  sysLight.addEventListener('change', () => { if (themeMode === 'auto') applyTheme(); });
}

updateStepButtons();

$('appVersion').textContent = `v${APP_VERSION}`;
document.title = `2.5D v${APP_VERSION} — photo to printable solid`;

// Test hook (used by the headless test-suite; harmless in normal use).
window.__app = {
  state, goStep, retrace, rebuildMesh, loadImageFromURL, autoDetect, doRectify,
  backRender, updateTraceInfo,
  cornerEditor, traceEditor, syncHolePanel, APP_VERSION,
  layoutEditor, syncLaySelPanel, refreshLayoutEditor,
  scaleContainer: layScaleContainer,
  bed: {
    centre: layBedCentre, offset: layBedOffset, escapes: layBedEscapes,
    loop: () => { const v = layBedView(); return v ? bedLoop(layContainerLoop(), v) : null; },
    plan: () => {
      const b = layBedDims();
      if (!b) return null;
      const loop = layContainerLoop(), box = layBox(loop);
      return laySplitWithOffset({
        slab: loop, pockets: layoutPocketsForPlan(),
        origin: { x: box.minX, y: box.minY }, w: box.w, h: box.h,
      }, b.w, b.h, layTileOpts());
    },
  },
  layoutExports: { stl: layoutStlExport, svg: layoutSvgExport },
  palette: { setFolder: laySetFolder, refresh: refreshLayPalette, get folder() { return layFolder; } },
  libFitThumbs,
  folderBackend: {
    use: layUseHandle, sync: syncFolderButtons,
    get handle() { return layFolderHandle; },
    get remembered() { return layRemembered; },
    forget() { layFolderHandle = null; layRemembered = null; syncFolderButtons(); },
  },
  serializeProject, loadProject,
  get viewer() { return viewer; },
};
