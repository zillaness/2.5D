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

// Carry the favicon / apple-touch-icon links from index.html's <head> into the
// standalone file's head (the body slice below drops everything above <body>).
const indexHtml = read('index.html');
const iconLinks = (indexHtml.match(/<link rel="(?:icon|apple-touch-icon)"[^>]*>/g) || []).join('\n');

// Body markup from index.html, minus the external script/style references
// that the bundle replaces.
let body = indexHtml
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
  (iconLinks ? iconLinks + '\n' : '') +
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
