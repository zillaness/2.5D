// A folder of 2.5D trace files -> palette entries for the Step 4 layout.
//
// Two backends feed this reader: a directory <input>, which hands over a
// one-shot FileList, and the File System Access API, which hands over a
// handle tree that is walked into the same shape. So the reader is written
// against { path, file } pairs and knows nothing about where they came from.
// A bare File is accepted too, in which case the path is its
// webkitRelativePath.
//
// It is a pure reader. Nothing here touches app state, the DOM, the clock or
// randomness, so the same folder always yields the same entries in the same
// order. Placement, thickness defaults and library writes are the caller's
// job.
//
// Accepted:
//   * a 2.5D project JSON  (app === '2.5D', trace.outer of 3+ points)
//   * a library export JSON (an array of entries that each have name + outer)
// Everything else is skipped with a one-word reason: not-json, parse-error,
// not-a-trace, or container (a container-kind library entry, reported rather
// than silently dropped so a saved drawer outline in the folder is visible).
//
// A project file also carries its rectified photo. The reader crops the
// outline's bounding box out of it, downscales it, and hangs it on the entry
// as `thumb`, so a drawer reads as the tools rather than as silhouettes. That
// is the one part of the reader that needs a canvas and an image decode, so
// it lives in its own async helper and readTraceJson stays synchronous.

// Saved outlines sit at a small margin from the origin so placement math is
// the same wherever an outline came from. This matches the outline library's
// own save handler.
const MARGIN = 5;

// A thumbnail is 256 px on its long side at JPEG quality 0.7: 10 to 25 KB
// each, so a library of a hundred tools stays well under the browser's
// roughly 5 MB localStorage ceiling.
const THUMB_PX = 256;
const THUMB_QUALITY = 0.7;

function fileOf(item) {
  return item && typeof item === 'object' && item.file ? item.file : item;
}

function pathOf(item, file) {
  if (item && typeof item === 'object' && typeof item.path === 'string' && item.path) return item.path;
  return (file && (file.webkitRelativePath || file.name)) || '';
}

function baseName(path) {
  const last = String(path || '').split('/').pop() || '';
  const stem = last.replace(/\.[^.]+$/, '');
  return stem || last;
}

function isJsonPath(path) {
  return /\.json$/i.test(String(path || ''));
}

function isLoop(v, min) {
  return Array.isArray(v) && v.length >= min &&
    v.every(p => p && Number.isFinite(p.x) && Number.isFinite(p.y));
}

// Origin-normalise to a MARGIN margin. Arcs, lines, measurements and
// constraints are index-based refs, so they survive the shift untouched and
// are carried across as they are.
function normalize(src) {
  const outer = src.outer || [];
  let minX = Infinity, minY = Infinity;
  for (const p of outer) { minX = Math.min(minX, p.x); minY = Math.min(minY, p.y); }
  if (!Number.isFinite(minX)) { minX = 0; minY = 0; }
  const dx = MARGIN - minX, dy = MARGIN - minY;
  const off = p => ({ x: p.x + dx, y: p.y + dy });
  return {
    dx, dy,
    outer: outer.map(off),
    holes: (src.holes || []).map(h => (h || []).map(off)),
    circles: (src.circles || []).map(c => ({ ...c, cx: c.cx + dx, cy: c.cy + dy })),
  };
}

// A thumb is { dataUrl, mmPerPx, origin }, where origin is the crop's
// top-left corner in the same mm space as the outline it belongs to. So a
// thumb moves with its outline: shifting the outline shifts the origin.
function isThumb(t) {
  return !!t && typeof t.dataUrl === 'string' && t.dataUrl &&
    Number.isFinite(t.mmPerPx) && t.mmPerPx > 0;
}

function shiftThumb(t, dx, dy) {
  const o = (t.origin && Number.isFinite(t.origin.x)) ? t.origin : { x: 0, y: 0 };
  return { dataUrl: t.dataUrl, mmPerPx: t.mmPerPx, origin: { x: o.x + dx, y: o.y + dy } };
}

function entryFrom(src, name, thickness, path) {
  const geom = normalize(src);
  const entry = {
    name,
    kind: 'tool',
    thickness: Number.isFinite(thickness) && thickness > 0 ? thickness : null,
    outer: geom.outer,
    holes: geom.holes,
    circles: geom.circles,
    arcs: structuredClone(src.arcs || []),
    lines: structuredClone(src.lines || []),
    source: { kind: 'folder', path },
  };
  // A library row saved from a photographed trace already carries its thumb.
  if (isThumb(src.thumb)) entry.thumb = shiftThumb(src.thumb, geom.dx, geom.dy);
  return entry;
}

// Exported for the batch queue's resume rule, which marks a photo traced when
// the sibling <name>.json beside it parses as a 2.5D project. A library export
// beside a photo is not that, so it does not count as already traced.
export function isProject(p) {
  return !!p && !Array.isArray(p) && p.app === '2.5D' &&
    !!p.trace && isLoop(p.trace.outer, 3);
}

function isLibraryExport(p) {
  return Array.isArray(p) && p.length > 0 &&
    p.every(o => o && typeof o.name === 'string' && isLoop(o.outer, 3));
}

// ---------- thumbnails ----------

function decode(dataUrl) {
  return new Promise(resolve => {
    if (typeof Image === 'undefined') { resolve(null); return; }
    const im = new Image();
    im.onload = () => resolve(im);
    im.onerror = () => resolve(null);
    im.src = dataUrl;
  });
}

// Crop the outline's bounding box out of an already-decoded rectified photo
// (a canvas or an <img>), downscale it to maxPx on the long side, and return
// { dataUrl, mmPerPx, origin } with origin in the raw outline's own mm space.
// The crop is clamped to the photo, so origin is the crop corner and not
// always the bounding-box corner. Returns null wherever there is no photo, no
// canvas, or nothing left to crop.
//
// Synchronous on purpose: the app's own rectified photo is a canvas that is
// already in memory, and the library save handler must finish inside its
// click, not a microtask later.
export function thumbFromImage(img, pxPerMm, outer, maxPx = THUMB_PX) {
  if (!Number.isFinite(pxPerMm) || pxPerMm <= 0) return null;
  if (typeof document === 'undefined' || !isLoop(outer, 3)) return null;
  if (!img) return null;
  const iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height;
  if (!iw || !ih) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of outer) {
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
  }
  const sx = Math.max(0, Math.floor(minX * pxPerMm));
  const sy = Math.max(0, Math.floor(minY * pxPerMm));
  const sw = Math.min(iw, Math.ceil(maxX * pxPerMm)) - sx;
  const sh = Math.min(ih, Math.ceil(maxY * pxPerMm)) - sy;
  if (sw < 2 || sh < 2) return null;
  const scale = Math.min(1, maxPx / Math.max(sw, sh));
  const w = Math.max(1, Math.round(sw * scale));
  const h = Math.max(1, Math.round(sh * scale));
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  if (!ctx) return null;
  ctx.drawImage(img, sx, sy, sw, sh, 0, 0, w, h);
  return {
    dataUrl: c.toDataURL('image/jpeg', THUMB_QUALITY),
    mmPerPx: (sw / pxPerMm) / w,
    origin: { x: sx / pxPerMm, y: sy / pxPerMm },
  };
}

// The same crop from a JPEG data URL, which has to be decoded first.
export async function thumbFromRectified(source, pxPerMm, outer, maxPx = THUMB_PX) {
  const img = typeof source === 'string' ? await decode(source) : source;
  return thumbFromImage(img, pxPerMm, outer, maxPx);
}

// The thumb for a project file, already shifted into the entry's normalised
// mm space so it lines up with the entry's outline.
export async function thumbForProject(json, maxPx = THUMB_PX) {
  if (!isProject(json) || !json.rectified || !Number.isFinite(json.pxPerMm)) return null;
  const outer = json.trace.outer;
  const t = await thumbFromRectified(json.rectified, json.pxPerMm, outer, maxPx);
  if (!t) return null;
  let minX = Infinity, minY = Infinity;
  for (const p of outer) { minX = Math.min(minX, p.x); minY = Math.min(minY, p.y); }
  return shiftThumb(t, MARGIN - minX, MARGIN - minY);
}

// One parsed JSON -> { entries, skipped }. Exported so the caller can reuse
// the classification on JSON it already has (a drag-dropped file, say).
export function readTraceJson(json, path) {
  const entries = [], skipped = [];
  if (isProject(json)) {
    const t = json.trace;
    const thickness = json.regions && json.regions[0] ? json.regions[0].thickness : null;
    const name = (typeof json.fileName === 'string' && json.fileName.trim()) || baseName(path);
    entries.push(entryFrom(
      { outer: t.outer, holes: t.holes, circles: t.circles, arcs: json.arcs, lines: json.lines },
      name, thickness, path));
  } else if (isLibraryExport(json)) {
    for (const o of json) {
      if (o.kind === 'container') { skipped.push({ path, name: o.name, reason: 'container' }); continue; }
      entries.push(entryFrom(o, o.name, o.thickness, path));
    }
  } else {
    skipped.push({ path, reason: 'not-a-trace' });
  }
  return { entries, skipped };
}

// files: a FileList, an array of File, or an array of { path, file }.
// options.onProgress(done, total) is called after each file so the palette
// header can count up a folder of hundreds without waiting for the end.
// options.thumbs === false skips the photo crop, for a caller that only wants
// the geometry.
export async function tracesFromFiles(files, options = {}) {
  const list = Array.from(files || []);
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;
  const thumbs = options.thumbs !== false;
  const entries = [], skipped = [];
  let done = 0;
  // Sequential on purpose: a folder of hundreds of files should not hold
  // every one of them in memory at once.
  for (const item of list) {
    const file = fileOf(item);
    const path = pathOf(item, file);
    if (!isJsonPath(path)) {
      skipped.push({ path, reason: 'not-json' });
    } else {
      let json = null, bad = false;
      try { json = JSON.parse(await file.text()); }
      catch { bad = true; }
      if (bad) skipped.push({ path, reason: 'parse-error' });
      else {
        const got = readTraceJson(json, path);
        // A project file's photo becomes the entry's thumbnail. Library rows
        // bring their own through entryFrom, so only projects need this.
        if (thumbs && got.entries.length === 1 && isProject(json)) {
          const t = await thumbForProject(json);
          if (t) got.entries[0].thumb = t;
        }
        entries.push(...got.entries);
        skipped.push(...got.skipped);
      }
    }
    done++;
    if (onProgress) onProgress(done, list.length);
  }
  return { entries, skipped };
}
