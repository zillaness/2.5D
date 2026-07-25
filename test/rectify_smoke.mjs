// Skew-correction end-to-end: build a SKEWED photo of an SC1 key lying on a CR80
// card (a known projective warp of a flat mm-space render), aim the card quad at
// the four skewed card corners, then advance to step 2. The app must WARP THE
// PHOTO FLAT and decode the true bitting 4-2-1-4-5 from the straightened image.
//   node test/rectify_smoke.mjs
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
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const errors = [];
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', e => errors.push(String(e)));
let fails = 0;
const check = (n, ok, d = '') => { console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${n}${d ? ' — ' + d : ''}`); if (!ok) fails++; };

await page.goto(`http://127.0.0.1:${port}/keys.html`);
await page.waitForFunction(() => window.keyUI && document.getElementById('blankSel').options.length > 0);

const result = await page.evaluate(async () => {
  const mod = await import('./js/keys/blanks.js');
  const spec = mod.getBlank('SC1').spec, IN = 25.4;
  const code = [4, 2, 1, 4, 5];
  const CW = 85.60, CH = 53.98;                     // CR80 mm
  const S0 = 8;                                     // px per mm in the flat render
  // ── flat (mm-space) render: card + key, blade back at yBack, cuts upward ──
  const fw = Math.round(CW * S0), fh = Math.round(CH * S0);
  const flat = document.createElement('canvas'); flat.width = fw; flat.height = fh;
  const g = flat.getContext('2d');
  g.fillStyle = '#8a8a92'; g.fillRect(0, 0, fw, fh);          // card: mid-grey, NOT 'bright'
  const shMM = 62, yBackMM = 34;                              // shoulder x, blade back y (mm)
  const run = Math.tan((spec.cutAngle * Math.PI / 180) / 2), flatHalf = spec.cutFlat * IN / 2;
  const uncut = spec.bladeHeight * IN;
  const hAt = (u) => { let h = uncut; for (let i = 0; i < 5; i++) { const root = spec.rootDepths[code[i] - spec.codeMin] * IN; const cc = (spec.firstCut + i * spec.spacing) * IN; const dx = Math.abs(u - cc); const e = dx <= flatHalf ? root : root + (dx - flatHalf) / run; if (e < h) h = e; } return h; };
  g.fillStyle = '#c8a13c';
  for (let px = 0; px < shMM * S0; px++) {                     // blade left of shoulder
    const uMM = (shMM * S0 - px) / S0;
    const hpx = hAt(uMM) * S0;
    g.fillRect(px, yBackMM * S0 - hpx, 1, hpx);
  }
  g.fillRect(shMM * S0, (yBackMM - uncut * 1.5) * S0, 18 * S0, uncut * 1.5 * S0);   // stub bow
  const flatData = g.getImageData(0, 0, fw, fh).data;

  // ── skew it: map flat → a trapezoid in a bigger "photo" canvas ──
  const P = [{ x: 120, y: 90 }, { x: 760, y: 40 }, { x: 830, y: 470 }, { x: 60, y: 400 }];  // card corners in the photo
  const pw = 900, ph = 560;
  // homography photo→flat (so we can inverse-sample), src = photo pts, dst = flat px
  const solve = (A, b) => {                                   // gaussian elim, 8x8
    const n = b.length, M = A.map((r, i) => [...r, b[i]]);
    for (let c = 0; c < n; c++) {
      let p = c; for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
      [M[c], M[p]] = [M[p], M[c]];
      if (!M[c][c]) return null;
      for (let r = 0; r < n; r++) { if (r === c) continue; const f = M[r][c] / M[c][c]; for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k]; }
    }
    return M.map((r, i) => r[n] / r[i]);
  };
  const homog = (src, dst) => {
    const A = [], b = [];
    for (let i = 0; i < 4; i++) { const { x, y } = src[i], [X, Y] = dst[i];
      A.push([x, y, 1, 0, 0, 0, -X * x, -X * y]); b.push(X);
      A.push([0, 0, 0, x, y, 1, -Y * x, -Y * y]); b.push(Y); }
    return solve(A, b);
  };
  const ap = (h, p) => { const d = h[6] * p.x + h[7] * p.y + 1; return { x: (h[0] * p.x + h[1] * p.y + h[2]) / d, y: (h[3] * p.x + h[4] * p.y + h[5]) / d }; };
  const Hp2f = homog(P, [[0, 0], [fw, 0], [fw, fh], [0, fh]]);
  const photo = document.createElement('canvas'); photo.width = pw; photo.height = ph;
  const pctx = photo.getContext('2d', { willReadFrequently: true });
  const pd = pctx.createImageData(pw, ph), PD = pd.data;
  for (let y = 0; y < ph; y++) for (let x = 0; x < pw; x++) {
    const s = ap(Hp2f, { x, y }); const sx = s.x | 0, sy = s.y | 0, o = (y * pw + x) * 4;
    if (sx < 0 || sy < 0 || sx >= fw || sy >= fh) { PD[o] = 34; PD[o + 1] = 38; PD[o + 2] = 45; PD[o + 3] = 255; continue; }
    const si = (sy * fw + sx) * 4;
    PD[o] = flatData[si]; PD[o + 1] = flatData[si + 1]; PD[o + 2] = flatData[si + 2]; PD[o + 3] = 255;
  }
  pctx.putImageData(pd, 0, 0);

  // ── load the SKEWED photo, aim the card at its corners, advance to step 2 ──
  const ui = window.keyUI;
  await new Promise(res => { ui.loadImage(photo.toDataURL()); const t = setInterval(() => { if (ui.state.img) { clearInterval(t); res(); } }, 20); });
  const before = { w: ui.state.sample.w, h: ui.state.sample.h };
  ui.setCard(P.map(p => ({ x: p.x, y: p.y })));
  await ui.setStep(2);
  const after = { w: ui.state.sample.w, h: ui.state.sample.h };
  const rectified = !!ui.state.rawImg;                       // raw kept ⇒ we warped

  // On the straightened image the geometry is known: S px/mm, mm origin at the
  // clamped bbox corner. Place the handles from the known mm layout and decode.
  const S = ui.state.pxPerMm, O = ui.state.rectOrigin || { x: 0, y: 0 };
  const PX = (mx, my) => ({ x: (mx - O.x) * S, y: (my - O.y) * S });
  const yMid = yBackMM - uncut / 2;
  ui.setHandles(PX(shMM, yMid), PX(4, yMid));
  ui.redecode(true);
  const decoded = ui.state.decoded && ui.state.decoded.code;
  return { before, after, rectified, S, O, decoded: decoded ? decoded.join('-') : null, step: ui.state.step };
});

check('advancing to step 2 straightened the photo', result.rectified,
  `${result.before.w}×${result.before.h} → ${result.after.w}×${result.after.h} @ ${result.S?.toFixed(2)} px/mm`);
check('landed on step 2', result.step === 2, String(result.step));
check('skewed photo decodes to 4-2-1-4-5', result.decoded === '4-2-1-4-5', String(result.decoded));
check('no console errors', errors.length === 0, errors.join(' | '));

await browser.close(); server.close();
console.log(fails === 0 ? '\nRectify (skew) test passed ✔' : `\n${fails} FAILED ✘`);
process.exit(fails === 0 ? 0 : 1);
