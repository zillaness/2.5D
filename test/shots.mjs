// Capture the README's Step 4 screenshots by driving the real app, so they can
// be regenerated from a command rather than recreated by hand every time the UI
// moves. The v1.2.0 shots in docs/ went eight minor versions stale because the
// last capture left no script behind.
//
//   node test/shots.mjs [path-to-chromium]
//
// Writes docs/step4-organize.png, docs/step4-folder.png and docs/step4-plate.png.

import { createRequire } from 'module';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'docs');

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.json': 'application/json',
};

const server = await new Promise(resolve => {
  const s = http.createServer((req, res) => {
    const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const fp = path.join(root, urlPath === '/' ? 'index.html' : urlPath);
    if (!fp.startsWith(root) || !fs.existsSync(fp) || fs.statSync(fp).isDirectory()) {
      res.writeHead(404); res.end('not found'); return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream' });
    fs.createReadStream(fp).pipe(res);
  });
  s.listen(0, '127.0.0.1', () => resolve(s));
});
const port = server.address().port;

const browser = await chromium.launch({
  executablePath: process.argv[2] || '/opt/pw-browsers/chromium',
});
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 });
const errors = [];
page.on('pageerror', e => errors.push(String(e)));
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
await page.goto(`http://127.0.0.1:${port}/`);
await page.waitForFunction(() => window.__app && window.ClipperLib);

// A plausible drawer of hand tools. Fabricated outlines rather than traced
// ones, so the shot does not depend on a photo fixture, but shaped and named
// like the real thing because the point of the picture is to look like the job.
const TOOLS = await page.evaluate(() => {
  const P = (...xy) => xy.map(([x, y]) => ({ x, y }));
  const bar = (w, h) => P([0, 0], [w, 0], [w, h], [0, h]);
  // A claw hammer: head across the top, handle down the middle.
  const hammer = P([0, 0], [34, 0], [34, 22], [22, 22], [22, 168], [12, 168], [12, 22], [0, 22]);
  // A combination spanner: boxed ring one end, open jaw the other.
  const spanner = (L, w) => P(
    [0, 8], [10, 0], [20, 8], [20, 16], [13, 22], [13, L - 26], [22, L - 26],
    [22, L - 8], [14, L], [6, L], [0, L - 8], [0, L - 26], [7, L - 26], [7, 22],
  );
  // Pliers: two handles meeting at a pivot, jaws above it.
  const pliers = P(
    [14, 0], [24, 10], [24, 44], [34, 58], [30, 150], [22, 150], [20, 62],
    [16, 62], [14, 150], [6, 150], [2, 58], [12, 44], [12, 10],
  );
  // A screwdriver: fat handle, thin shaft, flat tip.
  const driver = (L, hw) => P(
    [0, 0], [hw, 0], [hw, 62], [hw / 2 + 4, 70], [hw / 2 + 4, L - 8],
    [hw / 2 + 6, L], [hw / 2 - 6, L], [hw / 2 - 4, L - 8], [hw / 2 - 4, 70], [0, 62],
  );
  return {
    hammer, spanner: spanner(150, 20), spannerS: spanner(118, 16),
    pliers, driver: driver(190, 26), driverS: driver(140, 22),
    tape: [
      { x: 0, y: 0 }, { x: 72, y: 0 }, { x: 72, y: 66 }, { x: 0, y: 66 },
    ],
    chisel: bar(22, 132), rule: bar(16, 160), knife: bar(20, 150),
  };
});

// Scroll the Step 4 panel so the controls a shot is captioned about are the
// ones visible in it. The panel is taller than the viewport, so without this
// every shot shows whatever the last interaction left on screen.
async function scrollPanelTo(id) {
  await page.evaluate(sel => {
    const el = document.getElementById(sel);
    if (el) el.scrollIntoView({ block: 'center' });
  }, id);
}

async function shoot(name, note) {
  await page.waitForTimeout(450);
  // Toasts are transient and a screenshot that catches one mid-fade reads as a
  // glitch six months later, so they are cleared rather than waited out.
  await page.evaluate(() => {
    const t = document.getElementById('toast');
    if (t) { t.hidden = true; t.textContent = ''; }
  });
  await page.screenshot({ path: path.join(outDir, name) });
  const st = fs.statSync(path.join(outDir, name));
  console.log(`  ${name}  ${(st.size / 1024).toFixed(0)} KB  ${note}`);
}

// ---------- 1. Step 4, a drawer organised ----------
await page.evaluate(t => {
  const app = window.__app, S = app.state;
  const mk = (name, outer, thickness) => ({
    name, outer, holes: [], circles: [], thickness, depth: null, rot: 0, x: 20, y: 20,
  });
  S.layout.container = { ...S.layout.container, type: 'rect', w: 420, h: 300, r: 8, name: null, outer: null };
  S.layout.bed = { ...S.layout.bed, preset: 'none', shape: null, offset: { x: 0, y: 0 } };
  S.layout.labels = { ...S.layout.labels, enabled: false, extra: [] };
  S.layout.items.length = 0;
  for (const it of [
    mk('claw hammer', t.hammer, 32), mk('spanner 17', t.spanner, 8),
    mk('spanner 13', t.spannerS, 7), mk('combination pliers', t.pliers, 18),
    mk('screwdriver PH2', t.driver, 26), mk('screwdriver flat', t.driverS, 22),
    mk('tape measure', t.tape, 30), mk('cold chisel', t.chisel, 16),
    mk('steel rule', t.rule, 3), mk('utility knife', t.knife, 18),
  ]) S.layout.items.push(it);
  app.goStep(4);
  app.nest.sync();
  return app.nest.run();
}, TOOLS);
// The 3D preview, so the shot shows what the README says Step 4 puts on screen
// together: the 2D layout, the solid and the export row.
await page.click('#layPreviewBtn');
await page.waitForTimeout(1800);
await scrollPanelTo('layNestRow');
await shoot('step4-organize.png', 'ten tools nested into a 420 x 300 drawer, previewed');

// ---------- 2. The folder palette ----------
await page.evaluate(async () => {
  const app = window.__app;
  const P = (w, h) => [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }];
  const proj = (name, w, h) => JSON.stringify({
    app: '2.5D', version: 1, fileName: name,
    trace: { outer: P(w, h), holes: [], circles: [] },
    regions: [{ name: 'Base', pts: null, thickness: 6, zBase: 0,
      top: { mode: 'none', size: 1 }, bottom: { mode: 'none', size: 1 } }],
  });
  const files = {
    'claw-hammer.json': proj('claw hammer', 34, 168),
    'spanner-17.json': proj('spanner 17', 20, 150),
    'spanner-13.json': proj('spanner 13', 16, 118),
    'pliers.json': proj('combination pliers', 34, 150),
    'screwdriver-ph2.json': proj('screwdriver PH2', 26, 190),
    'tape-measure.json': proj('tape measure', 72, 66),
  };
  const fileHandle = name => ({
    kind: 'file', name,
    getFile: async () => new File([files[name]], name, { type: 'application/json' }),
  });
  const dir = {
    kind: 'directory', name: 'bench drawer',
    children: Object.keys(files).map(fileHandle),
    queryPermission: async () => 'granted',
    requestPermission: async () => 'granted',
    getDirectoryHandle: async () => { throw new Error('no folders'); },
    getFileHandle: async n => ({
      createWritable: async () => ({ write: async () => {}, close: async () => {} }),
    }),
  };
  dir.values = async function* () { for (const c of dir.children) yield c; };
  await app.folderBackend.use(dir, 'bench drawer');
});
await scrollPanelTo('layPalFolderGroup');
await shoot('step4-folder.png', 'a folder of six traces in the palette');

// ---------- 3. The bed as a build plate ----------
await page.evaluate(() => {
  const app = window.__app, S = app.state;
  S.layout.bed = { ...S.layout.bed, preset: 'custom', w: 300, h: 300, shape: null, offset: { x: 0, y: 0 } };
  app.goStep(4);
  app.bed.centre();
  app.refreshLayoutEditor();
});
await scrollPanelTo('layBedShape');
await shoot('step4-plate.png', 'a 300 x 300 plate under a wider drawer, so it tiles');

await browser.close();
server.close();
if (errors.length) {
  console.error('\nPage errors during capture:');
  for (const e of errors.slice(0, 10)) console.error('  ' + e);
  process.exit(1);
}
console.log('\nAll three shots captured clean.');
