// Graph-paper / dot-grid reference.
//
// Instead of the four corners of a known-size sheet, you place the four
// handles on four grid intersections (or dots) that span a counted number of
// squares. The rectified size is then countX × pitch by countY × pitch, so
// the rest of the pipeline (homography, segmentation, trace) is unchanged.
//
// Why it earns its place: the sheet's own edges never have to be in frame,
// so an object larger than the paper — or lying across two taped-together
// sheets — still calibrates exactly. The trade is that YOU count the
// squares, so `analyzeGrid` measures the printed pitch back out of the
// rectified image and flags a miscount.

// Pitch table (mm). `group` buckets these into <optgroup> submenus the same
// way the paper/coin pickers do.
export const GRID_PITCHES = {
  mm1:   { group: 'Metric', name: '1 mm', mm: 1 },
  mm2:   { group: 'Metric', name: '2 mm', mm: 2 },
  mm2_5: { group: 'Metric', name: '2.5 mm', mm: 2.5 },
  mm4:   { group: 'Metric', name: '4 mm', mm: 4 },
  mm5:   { group: 'Metric', name: '5 mm (common dot grid)', mm: 5 },
  mm10:  { group: 'Metric', name: '10 mm / 1 cm', mm: 10 },
  in10:  { group: 'Imperial', name: '1/10 in (engineering)', mm: 2.54 },
  in8:   { group: 'Imperial', name: '1/8 in', mm: 3.175 },
  in5:   { group: 'Imperial', name: '1/5 in (engineering)', mm: 5.08 },
  in4:   { group: 'Imperial', name: '1/4 in (quad rule / dot grid)', mm: 6.35 },
  in2:   { group: 'Imperial', name: '1/2 in', mm: 12.7 },
  in1:   { group: 'Imperial', name: '1 in', mm: 25.4 },
  // Self-healing cutting mats: dark with light rulings, and usually TWO
  // pitches at once (1 in majors with ½ or ⅛ in minors; 1 cm with bold 5 cm).
  // Count whichever squares you can see clearly — the check below accepts a
  // reading on the other ruling as consistent.
  mat_in1:  { group: 'Cutting mat', name: 'Imperial mat — 1 in squares', mm: 25.4 },
  mat_inh:  { group: 'Cutting mat', name: 'Imperial mat — ½ in squares', mm: 12.7 },
  mat_cm1:  { group: 'Cutting mat', name: 'Metric mat — 1 cm squares', mm: 10 },
  mat_cm5:  { group: 'Cutting mat', name: 'Metric mat — 5 cm bold squares', mm: 50 },
  custom:{ name: 'Custom pitch…', mm: 5 },
};

export function gridPitchMm(key, customMm) {
  if (key === 'custom') return customMm > 0 ? customMm : GRID_PITCHES.custom.mm;
  return (GRID_PITCHES[key] || GRID_PITCHES.mm5).mm;
}

// Rectified target size for a span of nx × ny squares at `pitch` mm.
export function gridDims(pitchMm, nx, ny) {
  const w = Math.max(1, nx) * pitchMm;
  const h = Math.max(1, ny) * pitchMm;
  return { w, h };
}

// 1-D grid-line profiles of a canvas.
//
// Gradient magnitude, not raw darkness: the traced object is a large dark
// blob covering much of the sheet, and its interior would swamp a darkness
// profile and drown the grid. Differentiating leaves thin printed lines (and
// dot edges) standing while the object contributes only its own two edges
// per axis, which carry no periodicity.
function profiles(canvas) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const { width: w, height: h } = canvas;
  const d = ctx.getImageData(0, 0, w, h).data;
  const lum = new Float32Array(w * h);
  for (let i = 0, p = 0; p < w * h; p++, i += 4) {
    lum[p] = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
  }
  const cols = new Float64Array(w), rows = new Float64Array(h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const p = y * w + x;
      cols[x] += Math.abs(lum[p + 1] - lum[p - 1]);   // vertical rulings
      rows[y] += Math.abs(lum[p + w] - lum[p - w]);   // horizontal rulings
    }
  }
  return { cols, rows };
}

// Dominant period (px) of a 1-D signal by autocorrelation, searched in
// [minLag, maxLag]. Returns { lag, strength } with strength in 0..1
// (normalised peak height), or null when nothing periodic stands out.
function dominantPeriod(sig, minLag, maxLag) {
  const n = sig.length;
  if (n < 8 || minLag < 2 || maxLag <= minLag) return null;
  // Mean-centre so a bright background doesn't dominate the correlation.
  let mean = 0;
  for (let i = 0; i < n; i++) mean += sig[i];
  mean /= n;
  const s = new Float64Array(n);
  for (let i = 0; i < n; i++) s[i] = sig[i] - mean;
  let energy = 0;
  for (let i = 0; i < n; i++) energy += s[i] * s[i];
  if (energy <= 1e-9) return null;

  const hi = Math.min(maxLag, Math.floor(n / 2));
  let best = { lag: 0, val: -Infinity };
  const corr = new Float64Array(hi + 1);
  for (let lag = minLag; lag <= hi; lag++) {
    let acc = 0;
    for (let i = 0; i + lag < n; i++) acc += s[i] * s[i + lag];
    // Normalise by overlap so long lags aren't penalised.
    corr[lag] = acc / (n - lag);
    if (corr[lag] > best.val) best = { lag, val: corr[lag] };
  }
  if (best.lag === 0) return null;
  // Autocorrelation peaks just as hard at 2×, 3× the true period, and the
  // overlap normalisation can even favour them — so walk up from the
  // shortest lag and take the FIRST local peak that is nearly as strong as
  // the global one. That is the fundamental: the printed pitch.
  const isPeak = l => corr[l] >= (corr[l - 1] ?? -Infinity) && corr[l] >= (corr[l + 1] ?? -Infinity);
  let fund = best.lag;
  for (let l = minLag + 1; l < best.lag; l++) {
    if (corr[l] >= 0.8 * best.val && isPeak(l)) { fund = l; break; }
  }
  // Parabolic refinement around the chosen peak for a sub-pixel period.
  const a = corr[fund - 1] ?? corr[fund], b = corr[fund], c = corr[fund + 1] ?? corr[fund];
  const denom = a - 2 * b + c;
  const shift = denom !== 0 ? (0.5 * (a - c)) / denom : 0;
  const lag = fund + (Math.abs(shift) < 1 ? shift : 0);
  const strength = corr[fund] / (energy / n);
  // Also hand back the strongest peak: on a cutting mat the bold majors
  // correlate harder than the fine minors, and autoCount needs to know
  // which ruling the user's chosen pitch refers to.
  return { lag, strength, peakLag: best.lag, peakStrength: best.val / (energy / n) };
}

// Per-axis grid measurement of a canvas: fundamental period (px), and the
// bold coarser ruling if one stands out as a clean small-integer multiple.
export function measureGrid(canvas, minLag, maxLag) {
  const { cols, rows } = profiles(canvas);
  const axis = sig => {
    const r = dominantPeriod(sig, minLag, maxLag);
    if (!r || r.strength <= 0.08) return null;
    let bold = null;
    const ratio = r.peakLag / r.lag;
    for (const k of [2, 4, 5, 8, 10]) {
      if (Math.abs(ratio - k) <= 0.08 * k && r.peakStrength > r.strength * 1.05) { bold = { k, lag: r.peakLag }; break; }
    }
    return { lag: r.lag, strength: r.strength, bold };
  };
  return { x: axis(cols), y: axis(rows) };
}

// Measure the printed grid pitch back out of a rectified canvas and compare
// it with what the user said. Miscounting the squares is the one failure
// mode this reference has that a known-size sheet doesn't, and it scales
// everything — so it is worth checking rather than trusting.
//
// Returns { detectedMm, ratio, ok, strength, message } or null when no
// periodic grid is visible (plain paper, too-fine grid, heavy shadow).
export function analyzeGrid(canvas, pxPerMm, expectedPitchMm) {
  if (!canvas || !(pxPerMm > 0) || !(expectedPitchMm > 0)) return null;
  const expPx = expectedPitchMm * pxPerMm;
  // Search a wide band around the expected pitch: half to double covers the
  // realistic miscounts (off by one on a 5-20 square span).
  const minLag = Math.max(3, Math.floor(expPx * 0.45));
  const maxLag = Math.max(minLag + 2, Math.ceil(expPx * 2.2));
  const { cols, rows } = profiles(canvas);
  const cx = dominantPeriod(cols, minLag, maxLag);
  const cy = dominantPeriod(rows, minLag, maxLag);
  const found = [cx, cy].filter(r => r && r.strength > 0.08);
  if (!found.length) return null;
  // Graph paper is square, so both axes carry the same pitch. Take the
  // SMALLER reading rather than the average: if one axis still latched onto
  // a harmonic, the other is the honest one, and harmonics are only ever
  // larger than the fundamental.
  const lag = Math.min(...found.map(r => r.lag));
  const strength = Math.max(...found.map(r => r.strength));
  const detectedMm = lag / pxPerMm;
  const ratio = detectedMm / expectedPitchMm;
  const tol = 0.06;
  const near1 = Math.abs(ratio - 1) <= tol;
  // Rulings come in families: a cutting mat prints ½ in or ⅛ in minors under
  // 1 in majors, a metric mat 1 cm under bold 5 cm. If the photo reads back a
  // clean small-integer multiple or fraction of what was counted, that is
  // the OTHER ruling of the same grid, not a miscount — a miscount by one
  // square lands on ratios like 1.11 or 0.91 that no ruling family produces.
  const family = [2, 4, 5, 8, 10];
  const sub = family.find(k => Math.abs(ratio * k - 1) <= tol * k);   // finer ruling read
  const sup = family.find(k => Math.abs(ratio / k - 1) <= tol);       // coarser ruling read
  const ok = near1 || !!sub || !!sup;
  let message;
  if (near1) {
    message = `Grid checks out — printed pitch reads ${detectedMm.toFixed(2)} mm.`;
  } else if (sub) {
    message = `Grid checks out — the photo reads the finer ${detectedMm.toFixed(2)} mm ruling, ` +
      `${sub} per ${expectedPitchMm} mm square you counted.`;
  } else if (sup) {
    message = `Grid checks out — the photo reads the bolder ${detectedMm.toFixed(1)} mm ruling, ` +
      `one per ${sup} of the ${expectedPitchMm} mm squares you counted.`;
  } else {
    // A miscount shows up as a clean ratio: n counted vs n·ratio actual.
    message = `Grid pitch reads ${detectedMm.toFixed(2)} mm, not ${expectedPitchMm} mm ` +
      `(${(ratio * 100).toFixed(0)}%) — recount the squares between the handles, ` +
      `or pick a different pitch. Everything scales with this.`;
  }
  return { detectedMm, ratio, ok, strength, message };
}

// Auto-count: how many squares do the four handles span? The user only
// names the pitch; the counts come from the image.
//
// The canvas is a rectification at PROVISIONAL counts (nxA × nyA). Its
// width is nxA·pitch·ppm px, and the true squares across is simply
// width / measured-period — a pure ratio, so the provisional guess drops
// out. If a bold coarser ruling is present (mat majors over minors, bold
// 5 cm over 1 cm) the chosen pitch is taken to be THAT ruling, since that
// is the one people name; otherwise the finest one. Handles on real
// intersections give near-integer counts — the residual is the confidence.
export function autoCount(canvas, pxPerMm, pitchMm, nxA, nyA) {
  if (!canvas || !(pitchMm > 0)) return null;
  // The provisional canvas's millimetres are placeholders, so the search
  // band is geometric: a ruling is at least a few px, and the handles must
  // span at least three squares along the shorter side for a grid reference
  // to be worth anything.
  const minLag = 4;
  const maxLag = Math.max(minLag + 2, Math.floor(Math.min(canvas.width, canvas.height) / 3));
  const m = measureGrid(canvas, minLag, maxLag);
  if (!m.x && !m.y) return null;
  const ax = m.x || m.y, ay = m.y || m.x;
  // One grid, one finest period: share the finer reading across both axes
  // when only one axis resolved, and agree on the bold factor.
  const k = (ax.bold && ax.bold.k) || (ay.bold && ay.bold.k) || 1;
  const fineX = canvas.width / ax.lag, fineY = canvas.height / ay.lag;
  const rawX = fineX / k, rawY = fineY / k;
  const nx = Math.max(1, Math.round(rawX)), ny = Math.max(1, Math.round(rawY));
  const residual = Math.max(Math.abs(rawX - nx), Math.abs(rawY - ny));
  const ok = residual <= 0.15;
  const fineMm = pitchMm / k;
  let message;
  if (ok) {
    message = k > 1
      ? `Counted ${nx} × ${ny} squares of ${pitchMm} mm (the bold ruling; ${k} finer ${fineMm.toFixed(2)} mm rulings each).`
      : `Counted ${nx} × ${ny} squares of ${pitchMm} mm.`;
  } else {
    message = `Read ≈${rawX.toFixed(1)} × ${rawY.toFixed(1)} squares — not whole numbers, so the handles ` +
      `probably aren't on intersections (or the pitch is wrong). Using ${nx} × ${ny}; nudge the handles and re-run, or type the counts.`;
  }
  return { nx, ny, rawX, rawY, k, fineMm, residual, ok, message, provisional: { nxA, nyA } };
}
