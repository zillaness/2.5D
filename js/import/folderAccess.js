// The File System Access backend for the Step 4 folder palette.
//
// Two backends feed js/import/traceFolder.js. The baseline is a directory
// <input>, which works from a file:// URL in every desktop browser and hands
// over a one-shot FileList. This module is the other one: where
// window.showDirectoryPicker exists (Chrome and Edge over https, and over
// http on localhost) the user picks a real directory handle, which can be
// re-scanned, remembered across reloads, and written back into.
//
// Everything here is feature-detected and tolerant. A browser without the
// API, a browser without IndexedDB, and a private window that refuses to
// store anything all take the same path: the caller falls back to the input
// and nothing throws.
//
// The walk turns a handle tree into the very same { path, file } pairs the
// directory input produces, so the reader never learns which backend it got.

// One IndexedDB database, one store, one key. The PRD names this key, and
// the labelling and nesting work reads nothing else out of it.
const DB_NAME = '2p5d.folder.v1';
const STORE = 'handles';
const KEY = 'folder';

// A folder of traces should not be a filesystem crawl. These caps keep a
// mis-picked home directory from hanging the tab.
const MAX_DEPTH = 12;
const MAX_FILES = 5000;

export function hasDirectoryPicker() {
  return typeof window !== 'undefined' && typeof window.showDirectoryPicker === 'function';
}

// Show the picker. A cancel returns null, which means "do nothing"; anything
// else throws, which means "this backend is not usable here, fall back to the
// directory input". The two outcomes must stay apart, or a cancelled pick
// would pop the input open behind it.
export async function pickFolder(options = {}) {
  if (!hasDirectoryPicker()) return null;
  try {
    const handle = await window.showDirectoryPicker({
      id: '2p5d-traces',
      mode: options.mode || 'readwrite',
      startIn: 'documents',
    });
    return handle || null;
  } catch (err) {
    const name = err && err.name;
    if (name === 'AbortError' || name === 'NotAllowedError') return null;
    throw err;
  }
}

// Children of a directory handle, sorted by name so the same folder always
// walks in the same order. values() is the standard iterator; entries() is
// accepted as well so a synthetic handle can implement either.
async function childrenOf(dir) {
  const out = [];
  if (typeof dir.values === 'function') {
    for await (const h of dir.values()) out.push(h);
  } else if (typeof dir.entries === 'function') {
    for await (const pair of dir.entries()) out.push(Array.isArray(pair) ? pair[1] : pair);
  }
  out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return out;
}

// Recursive walk into the reader's input shape. `prefix` is the relative path
// so far; the top level is named after the folder itself, exactly the way a
// directory input's webkitRelativePath is.
export async function walkFolder(dir, prefix, depth = 0, out = []) {
  if (!dir || out.length >= MAX_FILES) return out;
  const base = prefix === undefined || prefix === null ? (dir.name || '') : prefix;
  for (const child of await childrenOf(dir)) {
    if (out.length >= MAX_FILES) break;
    const path = base ? `${base}/${child.name}` : child.name;
    if (child.kind === 'directory') {
      if (depth < MAX_DEPTH) await walkFolder(child, path, depth + 1, out);
    } else {
      let file = null;
      try { file = await child.getFile(); } catch { file = null; }
      if (file) out.push({ path, file });
    }
  }
  return out;
}

// Ask for permission on a remembered handle. A handle that predates this
// page load always needs the prompt; one just picked answers 'granted'
// straight away. A handle without the permission methods is taken as usable.
export async function ensurePermission(handle, mode = 'read') {
  if (!handle) return false;
  if (typeof handle.queryPermission !== 'function') return true;
  try {
    if (await handle.queryPermission({ mode }) === 'granted') return true;
    if (typeof handle.requestPermission !== 'function') return false;
    return await handle.requestPermission({ mode }) === 'granted';
  } catch {
    return false;
  }
}

function openDb() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') { reject(new Error('no indexedDB')); return; }
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('indexedDB open failed'));
  });
}

function runTx(db, mode, fn) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const req = fn(tx.objectStore(STORE));
    tx.oncomplete = () => resolve(req ? req.result : undefined);
    tx.onerror = () => reject(tx.error || new Error('indexedDB transaction failed'));
    tx.onabort = () => reject(tx.error || new Error('indexedDB transaction aborted'));
  });
}

// Remember the picked folder. A directory handle structured-clones into
// IndexedDB; anything that does not (a stand-in, a stub) simply is not
// remembered, and false says so rather than throwing.
export async function rememberFolder(handle, label) {
  if (!handle) return false;
  let db = null;
  try {
    db = await openDb();
    await runTx(db, 'readwrite', s => s.put({ handle, label: label || handle.name || '' }, KEY));
    return true;
  } catch {
    return false;
  } finally {
    if (db) try { db.close(); } catch { /* already gone */ }
  }
}

// The remembered folder, as { handle, label }, or null. Reading it does not
// ask for permission; ensurePermission does that when the user asks to reopen.
export async function recallFolder() {
  let db = null;
  try {
    db = await openDb();
    const got = await runTx(db, 'readonly', s => s.get(KEY));
    if (!got || !got.handle) return null;
    return { handle: got.handle, label: got.label || got.handle.name || '' };
  } catch {
    return null;
  } finally {
    if (db) try { db.close(); } catch { /* already gone */ }
  }
}

export async function forgetFolder() {
  let db = null;
  try {
    db = await openDb();
    await runTx(db, 'readwrite', s => s.delete(KEY));
    return true;
  } catch {
    return false;
  } finally {
    if (db) try { db.close(); } catch { /* already gone */ }
  }
}

// Write one project JSON into the folder, creating or overwriting the file.
// Project JSON is the only thing this writes: exports keep going through the
// browser's own download, which needs no name-collision policy.
export async function writeProjectFile(dir, name, text) {
  if (!dir || typeof dir.getFileHandle !== 'function') throw new Error('no folder open');
  const safe = String(name || 'drawer').replace(/[\\/:*?"<>|]+/g, '_').replace(/\.json$/i, '') + '.json';
  const fh = await dir.getFileHandle(safe, { create: true });
  const w = await fh.createWritable();
  await w.write(text);
  await w.close();
  return safe;
}
