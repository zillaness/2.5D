// Headless smoke test for keys.html: draw a synthetic SC1 key, load it, set
// scale + handles, and check the UI decodes the right bitting, builds a mesh,
// and exports an STL — all in a real browser.  node test/keyui_smoke.mjs
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
check('page + modules load, blanks populated', true);
check('no console errors on load', errors.length === 0, errors.join(' | '));

// Draw a synthetic SC1 key for code 4-2-1-4-5 at a known scale, load it, decode.
const result = await page.evaluate(async () => {
  const mod = await import('./js/keys/blanks.js');
  const spec = mod.getBlank('SC1').spec, IN = 25.4;
  const pxPerMm = 8, code = [4, 2, 1, 4, 5];
  const W = 900, H = 300, y0 = 200;                 // blade back at y0, cuts go up
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d');
  g.fillStyle = '#111'; g.fillRect(0, 0, W, H);
  const shPx = 720;                                  // shoulder x
  const run = Math.tan((spec.cutAngle * Math.PI / 180) / 2), flatHalf = spec.cutFlat * IN / 2;
  const uncut = spec.bladeHeight * IN;
  const hAt = (uMm) => { let h = uncut; for (let i = 0; i < 5; i++) { const root = mod.rootDepthForCode ? (spec.rootDepths[code[i] - spec.codeMin]) * IN : 0; const cc = (spec.firstCut + i * spec.spacing) * IN; const dx = Math.abs(uMm - cc); const e = dx <= flatHalf ? root : root + (dx - flatHalf) / run; if (e < h) h = e; } return h; };
  g.fillStyle = '#d9b45a';
  for (let x = 0; x < shPx; x++) {                   // blade left of shoulder
    const uMm = (shPx - x) / pxPerMm;
    if (uMm < 0) continue;
    const hpx = hAt(uMm) * pxPerMm;
    g.fillRect(x, y0 - hpx, 1, hpx);
  }
  g.fillRect(shPx, y0 - uncut * pxPerMm * 1.4, 120, uncut * pxPerMm * 1.4); // stub bow
  const url = c.toDataURL();
  await new Promise(res => { window.keyUI.loadImage(url); const t = setInterval(() => { if (window.keyUI.state.img) { clearInterval(t); res(); } }, 20); });
  const ui = window.keyUI;
  ui.setScale(pxPerMm);
  const yMid = y0 - uncut * pxPerMm / 2;
  ui.setHandles({ x: shPx, y: yMid }, { x: 40, y: yMid });   // shoulder→tip (bow→tip)
  ui.redecode(true);
  const dec = ui.state.decoded;
  await ui.generate();
  return { code: dec && dec.code, tris: ui.state.mesh && ui.state.mesh.indices.length / 3, size: ui.state.mesh && ui.state.mesh.stats };
});

check('synthetic photo decodes to 4-2-1-4-5', String(result.code) === '4,2,1,4,5', String(result.code));
check('generate builds a mesh', result.tris > 100, `${result.tris} tris`);
check('mesh is ~SC1-sized', result.size && result.size.sizeY > 1 && result.size.sizeY < 3, `thick ${result.size?.sizeY?.toFixed(2)}mm`);

// Export produces a real STL blob.
const stlLen = await page.evaluate(async () => {
  const { toBinarySTL } = await import('./js/exporters.js');
  const m = window.keyUI.state.mesh;
  const blob = toBinarySTL(m.positions, m.indices, 'test');
  return blob.size;
});
check('STL export produces bytes', stlLen > 1000, `${stlLen} bytes`);
check('still no console errors', errors.length === 0, errors.join(' | '));

await browser.close(); server.close();
console.log(fails === 0 ? '\nUI smoke test passed ✔' : `\n${fails} FAILED ✘`);
process.exit(fails === 0 ? 0 : 1);
