// The real-photo test set (Part A step 2 of
// docs/calibration_and_backlog_prd_v1.2.md), shared by test/e2e.mjs and the
// standalone runner test/real-photos.mjs.
//
// Each photo in test/fixtures/real/ has a steel rule lying on the sheet and a
// sidecar JSON naming two graduations on it, marked once by hand with
// test/mark-photo.html, and their true distance. The suite loads the photo
// through the app's own file input, so corner detection, edge fitting, the
// EXIF focal length and the wrong-paper check all run exactly as they do for
// a person, then maps the two points through the same homography rectify
// uses and measures the distance in millimetres. The error against the true
// distance is the photo's figure. test/fixtures/real/baselines.json records
// it when the photo is added, and no later change may make it worse.
//
// What the figure contains: the app's geometric error plus the error of the
// two hand marks, which is fixed once marked. At 8 px/mm a mark a pixel off
// is 0.12 mm, so the figures are a ceiling on the app's own error, not a
// measurement of it; what matters is that they never rise.

import fs from 'fs';
import path from 'path';
import { PAPER_SIZES } from '../js/paperSizes.js';

export const REGRESSION_TOLERANCE_MM = 0.02;

export function listRealPhotos(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(f => /\.jpe?g$/i.test(f) && fs.existsSync(path.join(dir, f.replace(/\.jpe?g$/i, '.json'))))
    .sort();
}

export function sidecarPath(dir, name) {
  return path.join(dir, name.replace(/\.jpe?g$/i, '.json'));
}

export function readSidecar(dir, name) {
  return JSON.parse(fs.readFileSync(sidecarPath(dir, name), 'utf8'));
}

// Everything that must hold before a sidecar can be measured. Returns the
// problems found, so an empty array means it is valid.
export function validateSidecar(sc) {
  const bad = [];
  if (!sc || typeof sc !== 'object') return ['not an object'];
  if (!sc.paper || !PAPER_SIZES[sc.paper]) bad.push(`paper must be a key of PAPER_SIZES, got ${JSON.stringify(sc.paper)}`);
  if (sc.paper === 'custom' && !(sc.customW > 0 && sc.customH > 0)) bad.push('a custom paper needs customW and customH in mm');
  const isPt = p => p && Number.isFinite(p.x) && Number.isFinite(p.y);
  if (!sc.rule || !isPt(sc.rule.a) || !isPt(sc.rule.b)) bad.push('rule.a and rule.b must be {x, y} in photo pixels');
  else if (Math.hypot(sc.rule.a.x - sc.rule.b.x, sc.rule.a.y - sc.rule.b.y) < 1) bad.push('rule.a and rule.b are the same point');
  if (!sc.rule || !(sc.rule.mm > 0)) bad.push('rule.mm must be the true distance between the two marks, in mm');
  if (sc.corners != null) {
    if (!Array.isArray(sc.corners) || sc.corners.length !== 4 || !sc.corners.every(isPt)) {
      bad.push('corners must be null or four {x, y} points, TL TR BR BL');
    }
  }
  return bad;
}

export function baselinesPath(dir) {
  return path.join(dir, 'baselines.json');
}

export function loadBaselines(dir) {
  const p = baselinesPath(dir);
  if (!fs.existsSync(p)) return {};
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

export function saveBaselines(dir, baselines) {
  const sorted = {};
  for (const k of Object.keys(baselines).sort()) sorted[k] = baselines[k];
  fs.writeFileSync(baselinesPath(dir), JSON.stringify(sorted, null, 2) + '\n');
}

// How a fresh measurement stands against the recorded one. 'recorded' means
// there was none yet; 'worse' is the only status that fails the suite, and
// only past the tolerance, which covers the last digit of a JPEG decoder
// rather than any real change.
export function compareToBaseline(result, baseline, tol = REGRESSION_TOLERANCE_MM) {
  if (!result || !result.ok) return { status: 'failed', detail: result ? result.reason : 'no result' };
  if (!baseline || !Number.isFinite(baseline.errorMm)) return { status: 'recorded', detail: `recorded ${result.errorMm.toFixed(3)} mm` };
  const delta = result.errorMm - baseline.errorMm;
  if (delta > tol) return { status: 'worse', detail: `${result.errorMm.toFixed(3)} mm against ${baseline.errorMm.toFixed(3)} mm recorded, ${delta.toFixed(3)} mm worse` };
  if (delta < -tol) return { status: 'better', detail: `${result.errorMm.toFixed(3)} mm against ${baseline.errorMm.toFixed(3)} mm recorded, ${(-delta).toFixed(3)} mm better; re-record to keep it` };
  return { status: 'ok', detail: `${result.errorMm.toFixed(3)} mm, recorded ${baseline.errorMm.toFixed(3)} mm` };
}

export function baselineEntry(result, version) {
  return {
    errorMm: round3(result.errorMm),
    measuredMm: round3(result.measuredMm),
    trueMm: result.trueMm,
    pxPerMm: round3(result.pxPerMm),
    corners: result.cornersFrom,
    recorded: new Date().toISOString().slice(0, 10),
    version: version || null,
  };
}

const round3 = x => Math.round(x * 1000) / 1000;

// Load one fixture through the app in `page` (a Playwright page on the app)
// and measure it. Returns { name, ok, reason, ... } and never throws for a
// bad photo: a photo the app cannot find the paper on is a result too.
export async function measureRealPhoto(page, dir, name) {
  const sidecar = readSidecar(dir, name);
  const problems = validateSidecar(sidecar);
  if (problems.length) return { name, ok: false, reason: `sidecar: ${problems.join('; ')}` };
  const bytes = fs.readFileSync(path.join(dir, name));

  // The state a person has when they pick a photo: plain-paper reference,
  // the sidecar's paper size selected, no lens correction. cornerFit is
  // cleared so a detection that falls back to the default inset can be told
  // from one that ran (autoDetect only sets it when the detector found a quad).
  const prevSrc = await page.evaluate(sc => {
    const app = window.__app, st = app.state;
    const sel = document.getElementById('paperSize');
    sel.value = sc.paper; sel.dispatchEvent(new Event('change'));
    if (sc.paper === 'custom') {
      st.paper.customW = sc.customW; st.paper.customH = sc.customH;
    }
    st.reference = 'rect';
    st.scan.on = false;
    st.lens.k1 = 0; st.lens.k2 = 0;
    st.cornerFit = null;
    app.syncRefControls();
    app.goStep(1);
    return st.image ? st.image.src : null;
  }, sidecar);

  await page.setInputFiles('#fileInput', { name, mimeType: 'image/jpeg', buffer: bytes });
  try {
    await page.waitForFunction(prev => {
      const st = window.__app.state;
      return st.image && st.image.src !== prev && st.image.naturalWidth > 0 && st.corners;
    }, prevSrc, { timeout: 20000 });
  } catch {
    return { name, ok: false, reason: 'the app did not load the photo' };
  }
  // The focal length arrives from a separate read of the file's first bytes;
  // a photo without EXIF leaves it null, so wait briefly and move on.
  await page.waitForFunction(() => window.__app.state.photoFocal, null, { timeout: 1500 }).catch(() => {});

  return page.evaluate(async sc => {
    const app = window.__app, st = app.state;
    const { computeHomography, applyHomography } = await import('./js/homography.js');
    const { lensParams, undistortPixel, estimateDistortion } = await import('./js/lens.js');
    const { paperDims } = await import('./js/paperSizes.js');
    const img = st.image, iw = img.naturalWidth, ih = img.naturalHeight;
    const inside = p => p.x >= 0 && p.y >= 0 && p.x <= iw - 1 && p.y <= ih - 1;
    if (!inside(sc.rule.a) || !inside(sc.rule.b)) {
      return { name: sc.__name, ok: false, reason: `a rule mark is outside the ${iw} x ${ih} photo` };
    }
    const guess = cs => {
      const d = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
      return d(cs[0], cs[1]) + d(cs[3], cs[2]) > d(cs[0], cs[3]) + d(cs[1], cs[2]) ? 'landscape' : 'portrait';
    };
    let corners, cornersFrom, fit = st.cornerFit;
    if (sc.corners) {
      // Hand-marked corners are used as a person's drag is: as they are.
      corners = sc.corners; cornersFrom = 'sidecar'; fit = null;
    } else if (!fit) {
      return { name: sc.__name, ok: false, reason: 'the app could not find the paper; mark its corners in the sidecar' };
    } else {
      corners = st.corners; cornersFrom = fit.fitted ? 'auto, edge-fitted' : 'auto, coarse';
    }
    const orientation = guess(corners);
    const mm = paperDims(sc.paper, orientation, sc.customW, sc.customH);
    const paperQuad = [{ x: 0, y: 0 }, { x: mm.w, y: 0 }, { x: mm.w, y: mm.h }, { x: 0, y: mm.h }];
    const lp = lensParams(iw, ih);
    // The same construction rectify uses: corners straightened by the lens
    // model, a homography from them to the sheet in millimetres.
    const measure = k1 => {
      const und = p => (k1 ? undistortPixel(p, k1, 0, lp) : p);
      const H = computeHomography(corners.map(und), paperQuad);
      if (!H) return null;
      const A = applyHomography(H, und(sc.rule.a).x, und(sc.rule.a).y);
      const B = applyHomography(H, und(sc.rule.b).x, und(sc.rule.b).y);
      return Math.hypot(A.x - B.x, A.y - B.y);
    };
    const measuredMm = measure(0);
    if (!(measuredMm > 0)) return { name: sc.__name, ok: false, reason: 'degenerate corners' };
    const diagPx = Math.hypot(corners[2].x - corners[0].x, corners[2].y - corners[0].y);
    const pxPerMm = diagPx / Math.hypot(mm.w, mm.h);
    // What the lens fit would add, reported and not asserted: it is a slider
    // a person chooses to use.
    let lens = null;
    try {
      const est = estimateDistortion(img, corners);
      if (est && Number.isFinite(est.k1)) {
        const m = measure(est.k1);
        lens = { k1: est.k1, measuredMm: m, errorMm: m == null ? null : Math.abs(m - sc.rule.mm) };
      }
    } catch { /* reported as unavailable */ }
    const pc = document.getElementById('paperCheck');
    return {
      name: sc.__name, ok: true,
      width: iw, height: ih, paper: sc.paper, orientation,
      cornersFrom, fitMoved: fit ? fit.moved : null,
      focal: st.photoFocal ? { f35: st.photoFocal.f35, focalMm: st.photoFocal.focalMm } : null,
      paperCheck: pc && !pc.hidden ? pc.textContent : null,
      pxPerMm, trueMm: sc.rule.mm, measuredMm, errorMm: Math.abs(measuredMm - sc.rule.mm),
      lens,
    };
  }, { ...sidecar, __name: name });
}

export function formatResult(r) {
  if (!r.ok) return `${r.name}: FAILED, ${r.reason}`;
  const lens = r.lens ? `; with the lens fit (k1 ${r.lens.k1}) ${r.lens.errorMm.toFixed(3)} mm` : '';
  const focal = r.focal && r.focal.f35 ? `, f35 ${r.focal.f35} mm` : ', no focal length';
  const warn = r.paperCheck ? `; paper check: "${r.paperCheck}"` : '';
  return `${r.name}: ${r.measuredMm.toFixed(3)} mm for ${r.trueMm} mm, error ${r.errorMm.toFixed(3)} mm` +
    ` (${r.cornersFrom}, ${r.pxPerMm.toFixed(1)} px/mm${focal}${lens}${warn})`;
}
