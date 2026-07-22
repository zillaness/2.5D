// Auto-orientation test: draw an SC1 key with the BOW PADDLE at the left (small
// x) end, then feed reprofile() a BACKWARDS axis (shoulder at the tip end, tip
// at the bow end). reprofile() must detect the bow from image evidence and flip
// state.back so back[0] (position 1) lands at the bow end.  node test/orient_smoke.mjs
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

const r = await page.evaluate(async () => {
  const mod = await import('./js/keys/blanks.js');
  const spec = mod.getBlank('SC1').spec, IN = 25.4;
  const pxPerMm = 8, code = [4, 2, 1, 4, 5];
  const W = 1000, H = 320, y0 = 210, pad = 60;       // blade back at y0, cuts go up
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d'); g.fillStyle = '#111'; g.fillRect(0, 0, W, H);
  // Bow paddle at the LEFT; shoulder just to its right; blade runs rightward to tip.
  const shPx = pad + 150;                             // shoulder x (bow to its left)
  const run = Math.tan((spec.cutAngle * Math.PI / 180) / 2), flatHalf = spec.cutFlat * IN / 2;
  const uncut = spec.bladeHeight * IN;
  const hAt = (uMm) => { let h = uncut; for (let i = 0; i < 5; i++) { const root = (spec.rootDepths[code[i] - spec.codeMin]) * IN; const cc = (spec.firstCut + i * spec.spacing) * IN; const dx = Math.abs(uMm - cc); const e = dx <= flatHalf ? root : root + (dx - flatHalf) / run; if (e < h) h = e; } return h; };
  g.fillStyle = '#d9b45a';
  const tipPx = W - pad;
  for (let x = shPx; x < tipPx; x++) {                // blade to the RIGHT of shoulder
    const uMm = (x - shPx) / pxPerMm;
    const hpx = hAt(uMm) * pxPerMm;
    g.fillRect(x, y0 - hpx, 1, hpx);
  }
  // big bow paddle to the LEFT of the shoulder
  g.fillRect(pad, y0 - uncut * pxPerMm * 1.6, shPx - pad, uncut * pxPerMm * 1.9);
  const url = c.toDataURL();
  await new Promise(res => { window.keyUI.loadImage(url); const t = setInterval(() => { if (window.keyUI.state.img) { clearInterval(t); res(); } }, 20); });
  const ui = window.keyUI;
  ui.setScale(pxPerMm);
  const yMid = y0 - uncut * pxPerMm / 2;
  // BACKWARDS axis: shoulder at the TIP (right) end, tip at the BOW (left) end.
  ui.setHandles({ x: tipPx, y: yMid }, { x: shPx, y: yMid });
  ui.redecode(true);                                  // runs reprofile()
  const b = ui.state.back;
  return { back0x: b[0].x, back1x: b[1].x, shPx, tipPx, code: ui.state.decoded && String(ui.state.decoded.code) };
});

// back[0] (position 1 = bow) must be at the LEFT (small x, near the paddle),
// i.e. reprofile flipped the backwards axis.
check('back[0] oriented to the bow (left) end', r.back0x < r.back1x, `back0.x=${r.back0x?.toFixed(0)} back1.x=${r.back1x?.toFixed(0)}`);
check('decode still yields 5 cuts', r.code && r.code.split(',').length === 5, r.code);
check('no console errors', errors.length === 0, errors.join(' | '));

await browser.close(); server.close();
console.log(fails === 0 ? '\nOrientation test passed ✔' : `\n${fails} FAILED ✘`);
process.exit(fails === 0 ? 0 : 1);
