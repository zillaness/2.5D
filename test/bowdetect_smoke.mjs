// Bow-detection test: draw a key silhouette with the BOW (paddle) at a known
// end and check detectBow() locates it. Case A: bow has a keyring hole → 'hole'
// cue, centroid on the bow side. Case B: no hole → 'pca' cue, wide end wins.
//   node test/bowdetect_smoke.mjs
import { createRequire } from 'module';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
const server = http.createServer((req, res) => {
  const fp = path.join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!fp.startsWith(root) || !fs.existsSync(fp) || fs.statSync(fp).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream' });
  fs.createReadStream(fp).pipe(res);
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

const execPath = ['/opt/pw-browsers/chromium', process.env.CHROMIUM_PATH].filter(Boolean)
  .flatMap(c => { try { const st = fs.statSync(c); if (st.isFile()) return [c]; return ['chrome-linux/chrome', 'chrome-linux/headless_shell', 'chrome'].map(s => path.join(c, s)); } catch { return []; } })
  .find(p => fs.existsSync(p));
const browser = await chromium.launch({ executablePath: execPath || undefined, args: ['--use-angle=swiftshader', '--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1400, height: 800 } });
const errors = [];
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', e => errors.push(String(e)));
let fails = 0;
const check = (n, ok, d = '') => { console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${n}${d ? ' — ' + d : ''}`); if (!ok) fails++; };

await page.goto(`http://127.0.0.1:${port}/keys.html`);
await page.waitForFunction(() => window.keyUI && document.getElementById('blankSel').options.length > 0);

// Draw a key: bow paddle at bowLeft ? left : right; blade to the other side.
// withHole punches a ring hole in the paddle.
const run = (bowLeft, withHole) => page.evaluate(async ({ bowLeft, withHole }) => {
  const W = 1000, H = 320, yc = H / 2;
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d'); g.fillStyle = '#111'; g.fillRect(0, 0, W, H);
  g.fillStyle = '#d9b45a';
  const bowCx = bowLeft ? 150 : W - 150, bladeFrom = bowLeft ? 260 : 100, bladeTo = bowLeft ? W - 80 : W - 260;
  // round bow paddle
  g.beginPath(); g.arc(bowCx, yc, 95, 0, Math.PI * 2); g.fill();
  // thin blade
  g.fillRect(Math.min(bladeFrom, bladeTo), yc - 22, Math.abs(bladeTo - bladeFrom), 44);
  if (withHole) { g.fillStyle = '#111'; g.beginPath(); g.arc(bowCx, yc, 34, 0, Math.PI * 2); g.fill(); }
  const url = c.toDataURL();
  await new Promise(res => { window.keyUI.loadImage(url); const t = setInterval(() => { if (window.keyUI.state.img) { clearInterval(t); res(); } }, 20); });
  const b = window.keyUI.detectBow();
  return { b, bowCx, W };
}, { bowLeft, withHole });

const A = await run(true, true);
check('A: hole cue fires', A.b && A.b.method === 'hole', A.b && A.b.method);
check('A: bow located on the left (paddle) side', A.b && A.b.x < A.W * 0.4, A.b && `x=${A.b.x.toFixed(0)}`);

const B = await run(false, false);
check('B: pca cue fires (no hole)', B.b && B.b.method === 'pca', B.b && B.b.method);
check('B: bow located on the right (paddle) side', B.b && B.b.x > B.W * 0.6, B.b && `x=${B.b.x.toFixed(0)}`);

check('no console errors', errors.length === 0, errors.join(' | '));

await browser.close(); server.close();
console.log(fails === 0 ? '\nBow-detection test passed ✔' : `\n${fails} FAILED ✘`);
process.exit(fails === 0 ? 0 : 1);
