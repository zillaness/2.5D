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

// Saved outlines sit at a small margin from the origin so placement math is
// the same wherever an outline came from. This matches the outline library's
// own save handler.
const MARGIN = 5;

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
  const off = p => ({ x: p.x - minX + MARGIN, y: p.y - minY + MARGIN });
  return {
    outer: outer.map(off),
    holes: (src.holes || []).map(h => (h || []).map(off)),
    circles: (src.circles || []).map(c => ({ ...c, cx: c.cx - minX + MARGIN, cy: c.cy - minY + MARGIN })),
  };
}

function entryFrom(src, name, thickness, path) {
  const geom = normalize(src);
  return {
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
}

function isProject(p) {
  return !!p && !Array.isArray(p) && p.app === '2.5D' &&
    !!p.trace && isLoop(p.trace.outer, 3);
}

function isLibraryExport(p) {
  return Array.isArray(p) && p.length > 0 &&
    p.every(o => o && typeof o.name === 'string' && isLoop(o.outer, 3));
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
export async function tracesFromFiles(files, options = {}) {
  const list = Array.from(files || []);
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;
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
        entries.push(...got.entries);
        skipped.push(...got.skipped);
      }
    }
    done++;
    if (onProgress) onProgress(done, list.length);
  }
  return { entries, skipped };
}
