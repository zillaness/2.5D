// Lazy loader for the Manifold CSG engine (WASM). The bow↔blade connection is a
// real boolean union (keygen's technique) instead of a hand-weld.
//
// Browser: the single-file build inlines manifold.wasm as base64 and hands the
// decoded bytes in via initManifold(bytes). Node/dev: Module() finds the .wasm
// on disk itself, so initManifold() with no argument works.
let _promise = null;

export function initManifold(wasmBinary) {
  if (!_promise) {
    // Dynamic import so an unbundled/dev page still loads keyUI (the bare
    // specifier only needs to resolve inside the esbuild bundle); if it can't
    // load, callers fall back to the native weld.
    _promise = import('manifold-3d').then(({ default: Module }) => {
      // locateFile:'' stops Emscripten trying to fetch the wasm when we've
      // supplied the bytes (needed for file:// where there's nothing to fetch).
      const opts = wasmBinary ? { wasmBinary, locateFile: () => '' } : undefined;
      return Module(opts);
    }).then((w) => { w.setup(); return w; });
  }
  return _promise;
}

// Base64 → Uint8Array (for the inlined wasm).
export function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
