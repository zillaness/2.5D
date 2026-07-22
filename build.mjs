// Bundle the app into a single self-contained HTML file that works from
// file:// — just double-click it. No hosting, no build tools needed by the
// person you send it to.
//
//   node build.mjs                      -> dist/2.5d-local.html
//   node build.mjs --fragment out.html  -> also writes a body-only fragment
//                                          (used for publishing as an artifact)

import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const esbuild = require('esbuild');

const root = path.dirname(fileURLToPath(import.meta.url));
const read = f => fs.readFileSync(path.join(root, f), 'utf8');

const appBundle = (await esbuild.build({
  entryPoints: [path.join(root, 'js/main.js')],
  bundle: true,
  minify: true,
  format: 'iife',
  alias: { three: path.join(root, 'vendor/three.module.min.js') },
  write: false,
  logLevel: 'silent',
})).outputFiles[0].text;

const clipperMin = (await esbuild.transform(read('vendor/clipper.js'), {
  minify: true, logLevel: 'silent',
})).code;

const css = read('css/style.css');

// Body markup from index.html, minus the external script/style references
// that the bundle replaces.
let body = read('index.html')
  .replace(/^[\s\S]*?<body>/, '')
  .replace(/<\/body>[\s\S]*$/, '')
  .replace(/<script src="vendor\/clipper\.js"><\/script>\s*/g, '')
  .replace(/<script type="importmap">[\s\S]*?<\/script>\s*/g, '')
  .replace(/<script type="module" src="js\/main\.js"><\/script>\s*/g, '');
// (the <link>/<script> tags in <head> are already outside the body slice)

const inner =
  `<style>\n${css}\n</style>\n` +
  body.trim() + '\n' +
  `<script>${clipperMin}</script>\n` +
  `<script>${appBundle}</script>\n`;

const full =
  `<!DOCTYPE html>\n<html lang="en">\n<head>\n` +
  `<meta charset="UTF-8">\n` +
  `<meta name="viewport" content="width=device-width, initial-scale=1.0">\n` +
  `<title>2.5D — photo to printable solid</title>\n` +
  `</head>\n<body>\n${inner}</body>\n</html>\n`;

fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
const outFile = path.join(root, 'dist', '2.5d-local.html');
fs.writeFileSync(outFile, full);
console.log(`${outFile}: ${(full.length / 1024).toFixed(0)} KB`);

const fragIdx = process.argv.indexOf('--fragment');
if (fragIdx !== -1 && process.argv[fragIdx + 1]) {
  const fragOut = path.resolve(process.argv[fragIdx + 1]);
  fs.writeFileSync(fragOut, `<title>2.5D — photo to printable solid</title>\n${inner}`);
  console.log(`${fragOut}: ${(inner.length / 1024).toFixed(0)} KB`);
}

// ── Funny Looking Rock (the key-decode app) as one self-contained file ───────
// The Manifold CSG engine (WASM) does the bow↔blade boolean union. Its Emscripten
// glue references node: builtins on a Node-only branch (stub them for the
// browser) and derives a script dir from import.meta.url (define a valid URL).
const stubNode = {
  name: 'stub-node',
  setup(b) {
    b.onResolve({ filter: /^node:/ }, (a) => ({ path: a.path, namespace: 'node-stub' }));
    b.onLoad({ filter: /.*/, namespace: 'node-stub' },
      () => ({ contents: 'export default {}; export const createRequire = () => (() => ({}));', loader: 'js' }));
  },
};
const keyBundle = (await esbuild.build({
  entryPoints: [path.join(root, 'js/keys/keyUI.js')],
  bundle: true, minify: true, format: 'iife',
  alias: { three: path.join(root, 'vendor/three.module.min.js') },
  plugins: [stubNode],
  define: { 'import.meta.url': JSON.stringify('file:///funny-looking-rock.html') },
  write: false, logLevel: 'silent',
})).outputFiles[0].text;

// Inline the Manifold wasm as base64 so the app stays a single file that runs
// from file:// (nothing to fetch). keyUI reads window.__FLR_MANIFOLD_WASM.
const wasmB64 = fs.readFileSync(path.join(root, 'node_modules/manifold-3d/manifold.wasm')).toString('base64');
const wasmScript = `<script>window.__FLR_MANIFOLD_WASM=${JSON.stringify(wasmB64)};</script>\n`;

let keyBody = read('keys.html')
  .replace(/^[\s\S]*?<body>/, '')
  .replace(/<\/body>[\s\S]*$/, '')
  .replace(/<script type="importmap">[\s\S]*?<\/script>\s*/g, '')
  .replace(/<script type="module" src="js\/keys\/keyUI\.js"><\/script>\s*/g, '');

const keyFull =
  `<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="UTF-8">\n` +
  `<meta name="viewport" content="width=device-width, initial-scale=1.0">\n` +
  `<title>Funny Looking Rock — photograph a key → print a spare</title>\n` +
  `<style>\n${css}\n${read('css/keys.css')}\n</style>\n</head>\n<body>\n` +
  keyBody.trim() + '\n' +
  wasmScript +
  `<script>${keyBundle}</script>\n</body>\n</html>\n`;

const keyOut = path.join(root, 'dist', 'funny-looking-rock.html');
fs.writeFileSync(keyOut, keyFull);
console.log(`${keyOut}: ${(keyFull.length / 1024).toFixed(0)} KB`);

// Body-only fragment (no <html>/<head>/<body>) for publishing as an artifact.
const keyInner =
  `<style>\n${css}\n${read('css/keys.css')}\n</style>\n` +
  keyBody.trim() + '\n' +
  wasmScript +
  `<script>${keyBundle}</script>\n`;
const keyFrag = path.join(root, 'dist', 'funny-looking-rock.fragment.html');
fs.writeFileSync(keyFrag, keyInner);
console.log(`${keyFrag}: ${(keyInner.length / 1024).toFixed(0)} KB`);
