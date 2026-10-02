// Measure the real-photo test set on its own, with a line per photo, and
// record baselines. The suite (test/e2e.mjs) runs the same measurement and
// fails on a regression; this is for looking at the numbers and for
// re-recording them after a change that made them better.
//
//   node test/real-photos.mjs [--record] [--dir test/fixtures/real] [path-to-chromium]
//
// --record writes every photo's current figure to baselines.json; without it
// only photos that have no baseline yet are recorded, which is also what the
// suite does the first time it sees a new photo.

import { createRequire } from 'module';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  listRealPhotos, loadBaselines, saveBaselines, measureRealPhoto, compareToBaseline,
  baselineEntry, formatResult,
} from './realPhotos.mjs';
import { APP_VERSION } from '../js/version.js';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const args = process.argv.slice(2);
const record = args.includes('--record');
const dirIdx = args.indexOf('--dir');
const dir = path.resolve(root, dirIdx >= 0 ? args[dirIdx + 1] : 'test/fixtures/real');
const exeArg = args.filter((a, i) => !a.startsWith('--') && (dirIdx < 0 || i !== dirIdx + 1))[0];

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json' };

const server = await new Promise(res => {
  const s = http.createServer((req, rq) => {
    const u = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const fp = path.join(root, u === '/' ? 'index.html' : u);
    if (!fp.startsWith(root) || !fs.existsSync(fp) || fs.statSync(fp).isDirectory()) {
      rq.writeHead(404); rq.end('no'); return;
    }
    rq.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream' });
    fs.createReadStream(fp).pipe(rq);
  });
  s.listen(0, '127.0.0.1', () => res(s));
});

const exe = exeArg || process.env.CHROMIUM_PATH || (() => {
  const base = '/opt/pw-browsers';
  if (fs.existsSync(base)) {
    if (fs.statSync(base).isFile()) return base;
    for (const d of fs.readdirSync(base)) {
      for (const sub of ['chrome-linux/chrome', 'chrome-linux/headless_shell']) {
        const p = path.join(base, d, sub);
        if (fs.existsSync(p)) return p;
      }
    }
  }
  return undefined;
})();

const browser = await chromium.launch({ executablePath: exe, args: ['--use-angle=swiftshader', '--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
page.on('pageerror', e => console.error('page error:', String(e)));
await page.goto(`http://127.0.0.1:${server.address().port}/`);
await page.waitForFunction(() => window.__app && window.ClipperLib);

const photos = listRealPhotos(dir);
const baselines = loadBaselines(dir);
let worse = 0, failed = 0, changed = false;
console.log(`${photos.length} real photo(s) in ${path.relative(root, dir)}${record ? ', recording' : ''}`);
for (const name of photos) {
  const r = await measureRealPhoto(page, dir, name);
  console.log('  ' + formatResult(r));
  if (!r.ok) { failed++; continue; }
  const cmp = compareToBaseline(r, baselines[name]);
  if (cmp.status === 'worse') worse++;
  if (record || cmp.status === 'recorded') {
    baselines[name] = baselineEntry(r, APP_VERSION);
    changed = true;
    console.log(`    baseline ${cmp.status === 'recorded' ? 'recorded' : 're-recorded'}: ${r.errorMm.toFixed(3)} mm`);
  } else {
    console.log(`    ${cmp.status}: ${cmp.detail}`);
  }
}
if (changed) saveBaselines(dir, baselines);

await browser.close();
server.close();
if (failed || worse) {
  console.log(`\n${failed} photo(s) could not be measured, ${worse} regressed.`);
  process.exit(1);
}
console.log('\nNo regressions.');
