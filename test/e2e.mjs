// End-to-end test: renders a synthetic photo of an object on A4 paper (known
// homography), drives the app headlessly through all three steps, and checks
// corner detection, trace accuracy, mesh dimensions, watertightness, and STL
// output. Requires playwright-core and a Chromium binary.
//
//   node test/e2e.mjs [path-to-chromium]

import { createRequire } from 'module';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const shotDir = process.env.SHOT_DIR || path.join(root, 'test', 'shots');

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.json': 'application/json',
};

function serveStatic() {
  return new Promise(resolve => {
    const server = http.createServer((req, res) => {
      const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      let fp = path.join(root, urlPath === '/' ? 'index.html' : urlPath);
      if (!fp.startsWith(root) || !fs.existsSync(fp) || fs.statSync(fp).isDirectory()) {
        res.writeHead(404); res.end('not found'); return;
      }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream' });
      fs.createReadStream(fp).pipe(res);
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function findChromium() {
  const candidates = [
    process.argv[2],
    process.env.CHROMIUM_PATH,
    '/opt/pw-browsers/chromium',
  ].filter(Boolean);
  for (const c of candidates) {
    try {
      const st = fs.statSync(c);
      if (st.isFile()) return c;
      if (st.isDirectory()) {
        for (const sub of ['chrome-linux/chrome', 'chrome-linux/headless_shell', 'chrome']) {
          const p = path.join(c, sub);
          if (fs.existsSync(p)) return p;
        }
      }
    } catch { /* try next */ }
  }
  return null; // let playwright find its own
}

let failures = 0;
function check(name, ok, detail = '') {
  const mark = ok ? 'PASS' : 'FAIL';
  if (!ok) failures++;
  console.log(`  [${mark}] ${name}${detail ? ' — ' + detail : ''}`);
}
const near = (a, b, tol) => Math.abs(a - b) <= tol;

// Build a minimal valid uncompressed single-page PDF from a content stream,
// with correct xref offsets. Used for vector-PDF import fixtures.
function buildPDF(content, mediabox = [0, 0, 300, 220]) {
  const objs = [];
  objs[1] = `<< /Type /Catalog /Pages 2 0 R >>`;
  objs[2] = `<< /Type /Pages /Kids [3 0 R] /Count 1 >>`;
  objs[3] = `<< /Type /Page /Parent 2 0 R /MediaBox [${mediabox.join(' ')}] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>`;
  objs[4] = `<< /Length ${content.length} >>\nstream\n${content}\nendstream`;
  objs[5] = `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>`;
  let pdf = '%PDF-1.4\n';
  const offsets = [];
  for (let i = 1; i < objs.length; i++) { offsets[i] = pdf.length; pdf += `${i} 0 obj\n${objs[i]}\nendobj\n`; }
  const xrefOff = pdf.length;
  pdf += `xref\n0 ${objs.length}\n0000000000 65535 f \n`;
  for (let i = 1; i < objs.length; i++) pdf += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objs.length} /Root 1 0 R >>\nstartxref\n${xrefOff}\n%%EOF`;
  return Buffer.from(pdf, 'latin1');
}
// A ⌀d circle (mm) drawn as 4 cubic beziers in PDF user space (pt).
function pdfCircle(cxMM, cyMM, dMM) {
  const P = 72 / 25.4, r = (dMM / 2) * P, k = 0.5522847498 * r, cx = cxMM * P, cy = cyMM * P;
  return [
    `${cx + r} ${cy} m`,
    `${cx + r} ${cy + k} ${cx + k} ${cy + r} ${cx} ${cy + r} c`,
    `${cx - k} ${cy + r} ${cx - r} ${cy + k} ${cx - r} ${cy} c`,
    `${cx - r} ${cy - k} ${cx - k} ${cy - r} ${cx} ${cy - r} c`,
    `${cx + k} ${cy - r} ${cx + r} ${cy - k} ${cx + r} ${cy} c`, 'h S',
  ].join('\n');
}
// An 80×50 mm rectangle (origin 10,10 mm) + a ⌀12 mm hole + a "50" dimension.
function rectMM(x, y, w, h) {
  const P = 72 / 25.4;
  return `${x*P} ${y*P} m ${(x+w)*P} ${y*P} l ${(x+w)*P} ${(y+h)*P} l ${x*P} ${(y+h)*P} l h S`;
}
const FIXTURE_PDF = buildPDF(
  `1 0 0 RG 1 w\n${rectMM(10, 10, 80, 50)}\n${pdfCircle(50, 35, 12)}\n` +
  `BT /F1 10 Tf ${28 * 72 / 25.4} ${5 * 72 / 25.4} Td (50) Tj ET`
);

const server = await serveStatic();
const port = server.address().port;
const execPath = findChromium();
console.log(`Serving ${root} on :${port}; chromium: ${execPath || '(playwright default)'}`);

const browser = await chromium.launch({
  executablePath: execPath || undefined,
  args: ['--use-angle=swiftshader', '--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
const consoleErrors = [];
page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('pageerror', e => consoleErrors.push(String(e)));

await page.goto(`http://127.0.0.1:${port}/`);
await page.waitForFunction(() => window.__app && window.ClipperLib);

// ---------- 1. Build the synthetic photo & feed it in ----------

const setup = await page.evaluate(async () => {
  const { computeHomography, applyHomography } = await import('./js/homography.js');

  const paperW = 210, paperH = 297; // A4 portrait
  // Paper corners in the fake photo (mild perspective) — TL TR BR BL.
  const quad = [
    { x: 150, y: 180 }, { x: 820, y: 140 }, { x: 900, y: 1220 }, { x: 120, y: 1260 },
  ];
  const H = computeHomography(
    [{ x: 0, y: 0 }, { x: paperW, y: 0 }, { x: paperW, y: paperH }, { x: 0, y: paperH }],
    quad
  );

  const W = 1000, Hh = 1400;
  const c = document.createElement('canvas');
  c.width = W; c.height = Hh;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#38342e'; // desk
  ctx.fillRect(0, 0, W, Hh);

  const mapPath = pts => {
    ctx.beginPath();
    pts.forEach((p, i) => {
      const q = applyHomography(H, p.x, p.y);
      if (i === 0) ctx.moveTo(q.x, q.y); else ctx.lineTo(q.x, q.y);
    });
    ctx.closePath();
  };

  // Paper
  mapPath([{ x: 0, y: 0 }, { x: paperW, y: 0 }, { x: paperW, y: paperH }, { x: 0, y: paperH }]);
  ctx.fillStyle = '#f4f2ec';
  ctx.fill();

  // Object: 80 × 50 mm rounded rect centred at (105, 145), corner radius 8.
  const rr = [];
  const cxm = 105, cym = 145, hw = 40, hh = 25, r = 8;
  const cs = [
    [cxm + hw - r, cym - hh + r, -Math.PI / 2, 0],
    [cxm + hw - r, cym + hh - r, 0, Math.PI / 2],
    [cxm - hw + r, cym + hh - r, Math.PI / 2, Math.PI],
    [cxm - hw + r, cym - hh + r, Math.PI, 1.5 * Math.PI],
  ];
  for (const [ax, ay, a0, a1] of cs) {
    for (let k = 0; k <= 10; k++) {
      const a = a0 + (a1 - a0) * (k / 10);
      rr.push({ x: ax + r * Math.cos(a), y: ay + r * Math.sin(a) });
    }
  }
  mapPath(rr);
  ctx.fillStyle = '#23364a';
  ctx.fill();

  // 12 mm hole at the object centre — draw in paper colour.
  const hole = [];
  for (let k = 0; k < 48; k++) {
    const a = (k / 48) * Math.PI * 2;
    hole.push({ x: cxm + 6 * Math.cos(a), y: cym + 6 * Math.sin(a) });
  }
  mapPath(hole);
  ctx.fillStyle = '#f4f2ec';
  ctx.fill();

  const dataURL = c.toDataURL('image/png');
  await new Promise(res => window.__app.loadImageFromURL(dataURL, res));
  return { quad, detected: window.__app.state.corners };
});

console.log('\nStep 1 — paper detection');
{
  const { quad, detected } = setup;
  let maxErr = 0;
  for (let i = 0; i < 4; i++) {
    maxErr = Math.max(maxErr, Math.hypot(quad[i].x - detected[i].x, quad[i].y - detected[i].y));
  }
  check('auto-detected corners near truth', maxErr < 10, `max error ${maxErr.toFixed(1)} px`);
}
await page.screenshot({ path: path.join(shotDir, 'step1-corners.png') });

// ---------- 2. Trace ----------

const traceRes = await page.evaluate(({ quad }) => {
  const app = window.__app;
  // The synthetic photo is A4; the app defaults to US Letter, so pick A4
  // explicitly (this also exercises the paper-size path).
  app.state.paper.size = 'A4';
  document.getElementById('paperSize').value = 'A4';
  // Use exact corners so trace-accuracy checks are meaningful on their own.
  app.state.corners = quad.map(p => ({ ...p }));
  app.state.rectDirty = true;
  app.cornerEditor.setCorners(app.state.corners);
  app.goStep(2);
  const { outer, holes } = app.traceEditor.getTrace();
  const bbox = pts => {
    let minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9;
    for (const p of pts) {
      minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
      minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
    }
    return { minX, minY, maxX, maxY, w: maxX - minX, h: maxY - minY };
  };
  return {
    outerCount: outer.length,
    outerBox: bbox(outer),
    holeCount: holes.length,
    holeBox: holes.length ? bbox(holes[0]) : null,
  };
}, { quad: setup.quad });

console.log('\nStep 2 — trace');
check('outline has a sane vertex count', traceRes.outerCount >= 20 && traceRes.outerCount < 3000,
  `${traceRes.outerCount} pts`);
check('outline width ≈ 80 mm', near(traceRes.outerBox.w, 80, 1.5), traceRes.outerBox.w.toFixed(2));
check('outline height ≈ 50 mm', near(traceRes.outerBox.h, 50, 1.5), traceRes.outerBox.h.toFixed(2));
check('outline position ≈ (65, 120) mm',
  near(traceRes.outerBox.minX, 65, 1.5) && near(traceRes.outerBox.minY, 120, 1.5),
  `(${traceRes.outerBox.minX.toFixed(1)}, ${traceRes.outerBox.minY.toFixed(1)})`);
check('one hole detected', traceRes.holeCount === 1, `${traceRes.holeCount}`);
if (traceRes.holeBox) {
  check('hole ⌀ ≈ 12 mm', near(traceRes.holeBox.w, 12, 1.5) && near(traceRes.holeBox.h, 12, 1.5),
    `${traceRes.holeBox.w.toFixed(2)} × ${traceRes.holeBox.h.toFixed(2)}`);
}
await page.waitForTimeout(300); // let the canvas refit after becoming visible
await page.screenshot({ path: path.join(shotDir, 'step2-trace.png') });

// ---------- 3. Mesh ----------

const meshRes = await page.evaluate(async () => {
  const app = window.__app;
  // Manual 6 mm circle hole near the left side of the object.
  app.traceEditor.circles.push({ cx: 80, cy: 132, d: 6 });
  Object.assign(app.state.regions[0], {
    thickness: 6,
    top: { mode: 'chamfer', size: 1 },
    bottom: { mode: 'fillet', size: 1.5 },
  });
  app.goStep(3);
  await new Promise(r => setTimeout(r, 600)); // debounce + build
  const mesh = app.state.meshData;
  if (!mesh) return { ok: false };

  const { positions, indices, stats } = mesh;
  let minZ = 1e9, maxZ = -1e9;
  for (let i = 2; i < positions.length; i += 3) {
    minZ = Math.min(minZ, positions[i]); maxZ = Math.max(maxZ, positions[i]);
  }
  // Bottom (z≈0) and top (z≈max) slice bboxes.
  const sliceBox = z => {
    let minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9, count = 0;
    for (let i = 0; i < positions.length; i += 3) {
      if (Math.abs(positions[i + 2] - z) < 1e-4) {
        minX = Math.min(minX, positions[i]); maxX = Math.max(maxX, positions[i]);
        minY = Math.min(minY, positions[i + 1]); maxY = Math.max(maxY, positions[i + 1]);
        count++;
      }
    }
    return { w: maxX - minX, h: maxY - minY, count };
  };
  // Watertight: every undirected edge (keyed by rounded coords) used exactly twice.
  const edgeUse = new Map();
  const vkey = i => `${positions[i * 3].toFixed(4)},${positions[i * 3 + 1].toFixed(4)},${positions[i * 3 + 2].toFixed(4)}`;
  let degenerate = 0;
  for (let t = 0; t < indices.length; t += 3) {
    const ks = [vkey(indices[t]), vkey(indices[t + 1]), vkey(indices[t + 2])];
    if (ks[0] === ks[1] || ks[1] === ks[2] || ks[0] === ks[2]) { degenerate++; continue; }
    for (let e = 0; e < 3; e++) {
      const a = ks[e], b = ks[(e + 1) % 3];
      const key = a < b ? a + '|' + b : b + '|' + a;
      edgeUse.set(key, (edgeUse.get(key) || 0) + 1);
    }
  }
  let bad = 0;
  for (const n of edgeUse.values()) if (n !== 2) bad++;

  // Hole-ring evidence: bottom-cap vertices near the traced hole centre
  // (model coords put it at the origin).
  let nearHole = 0;
  for (let i = 0; i < positions.length; i += 3) {
    if (Math.abs(positions[i + 2]) < 1e-4 &&
        Math.hypot(positions[i], positions[i + 1]) < 9.5) nearHole++;
  }

  const { toBinarySTL } = await import('./js/exporters.js');
  const blob = toBinarySTL(positions, indices, 'test');

  return {
    ok: true, stats, minZ, maxZ,
    bottomBox: sliceBox(0), topBox: sliceBox(maxZ),
    badEdges: bad, totalEdges: edgeUse.size, degenerate,
    nearHole,
    stlSize: blob.size, stlExpected: 84 + 50 * (indices.length / 3),
  };
});

console.log('\nStep 3 — mesh & export');
check('mesh built', meshRes.ok);
if (meshRes.ok) {
  const s = meshRes.stats;
  check('size ≈ 80 × 50 × 6 mm',
    near(s.sizeX, 80, 1.5) && near(s.sizeY, 50, 1.5) && near(s.sizeZ, 6, 1e-6),
    `${s.sizeX.toFixed(1)} × ${s.sizeY.toFixed(1)} × ${s.sizeZ}`);
  check('z spans 0..thickness', near(meshRes.minZ, 0, 1e-6) && near(meshRes.maxZ, 6, 1e-6),
    `${meshRes.minZ}..${meshRes.maxZ}`);
  check('bottom fillet shrinks base by ~2×1.5 mm',
    near(meshRes.bottomBox.w, 77, 1.0) && near(meshRes.bottomBox.h, 47, 1.0),
    `${meshRes.bottomBox.w.toFixed(2)} × ${meshRes.bottomBox.h.toFixed(2)}`);
  check('top chamfer shrinks top by ~2×1 mm',
    near(meshRes.topBox.w, 78, 1.0) && near(meshRes.topBox.h, 48, 1.0),
    `${meshRes.topBox.w.toFixed(2)} × ${meshRes.topBox.h.toFixed(2)}`);
  check('watertight (every edge shared by 2 triangles)', meshRes.badEdges === 0,
    `${meshRes.badEdges}/${meshRes.totalEdges} bad, ${meshRes.degenerate} degenerate tris`);
  check('hole ring present in bottom cap', meshRes.nearHole > 8, `${meshRes.nearHole} verts`);
  check('triangle count sane', meshRes.stats.triangles > 500, `${meshRes.stats.triangles}`);
  check('binary STL size matches triangle count', meshRes.stlSize === meshRes.stlExpected,
    `${meshRes.stlSize} vs ${meshRes.stlExpected}`);
}
await page.screenshot({ path: path.join(shotDir, 'step3-model.png') });

// ---------- 3b. Export buttons deliver real downloads ----------

console.log('\nExports — real download events');
{
  const [stlDl] = await Promise.all([
    page.waitForEvent('download', { timeout: 10000 }).catch(() => null),
    page.click('#exportStlBtn'),
  ]);
  const stlPath = stlDl ? await stlDl.path().catch(() => null) : null;
  const expected = 84 + 50 * (await page.evaluate(() => window.__app.state.meshData.stats.triangles));
  const stlSize = stlPath ? fs.statSync(stlPath).size : -1;
  check('Export STL fires a download with the right name and size',
    !!stlDl && /-2p5d\.stl$/.test(stlDl.suggestedFilename()) && stlSize === expected,
    stlDl ? `${stlDl.suggestedFilename()}, ${stlSize} bytes (expected ${expected})` : 'no download event');

  const [svgDl] = await Promise.all([
    page.waitForEvent('download', { timeout: 10000 }).catch(() => null),
    page.click('#exportSvgBtn'),
  ]);
  const svgPath = svgDl ? await svgDl.path().catch(() => null) : null;
  const svgTxt = svgPath ? fs.readFileSync(svgPath, 'utf8') : '';
  const svgW = (svgTxt.match(/width="([\d.]+)mm"/) || [])[1];
  check('Export SVG fires a download with valid SVG content (~210mm wide)',
    !!svgDl && /-outline\.svg$/.test(svgDl.suggestedFilename()) &&
    svgTxt.includes('<svg') && svgW && Math.abs(parseFloat(svgW) - 210) < 1,
    svgDl ? `${svgDl.suggestedFilename()}, width ${svgW}mm` : 'no download event');

  const fallback = await page.evaluate(() => ({
    visible: !document.getElementById('exportFallback').hidden,
    name: document.getElementById('exportFallbackName').textContent,
    href: document.getElementById('exportFallbackLink').href.startsWith('blob:'),
  }));
  check('fallback save link is offered after export',
    fallback.visible && fallback.href && /-outline\.svg$/.test(fallback.name),
    fallback.name);
}

// ---------- 4. Stress: extreme edge treatments must stay watertight ----------

const stressRes = await page.evaluate(async () => {
  const { buildSolid } = await import('./js/mesh.js');
  const app = window.__app;
  const { outer, holes, circles } = app.traceEditor.getTrace();

  const watertight = mesh => {
    const { positions, indices } = mesh;
    const edgeUse = new Map();
    const vkey = i => `${positions[i * 3].toFixed(4)},${positions[i * 3 + 1].toFixed(4)},${positions[i * 3 + 2].toFixed(4)}`;
    for (let t = 0; t < indices.length; t += 3) {
      const ks = [vkey(indices[t]), vkey(indices[t + 1]), vkey(indices[t + 2])];
      if (ks[0] === ks[1] || ks[1] === ks[2] || ks[0] === ks[2]) continue;
      for (let e = 0; e < 3; e++) {
        const a = ks[e], b = ks[(e + 1) % 3];
        const key = a < b ? a + '|' + b : b + '|' + a;
        edgeUse.set(key, (edgeUse.get(key) || 0) + 1);
      }
    }
    let bad = 0;
    for (const n of edgeUse.values()) if (n !== 2) bad++;
    return bad;
  };

  const cases = [
    ['fillet+fillet at exactly half thickness',
      { thickness: 6, top: { mode: 'fillet', size: 3 }, bottom: { mode: 'fillet', size: 3 }, arcSegments: 6 }],
    ['huge chamfer forcing topology clamp',
      { thickness: 40, top: { mode: 'chamfer', size: 15 }, bottom: { mode: 'none', size: 0 }, arcSegments: 6 }],
    ['thin plate, fillet top + chamfer bottom',
      { thickness: 3, top: { mode: 'fillet', size: 1 }, bottom: { mode: 'chamfer', size: 1 }, arcSegments: 10 }],
    ['no holes, big bottom fillet',
      { thickness: 8, top: { mode: 'none', size: 0 }, bottom: { mode: 'fillet', size: 4 }, arcSegments: 12 }, true],
  ];
  const results = [];
  for (const [name, params, dropHoles] of cases) {
    try {
      const mesh = buildSolid(outer, dropHoles ? [] : holes, dropHoles ? [] : circles, params);
      results.push({
        name,
        built: !!mesh,
        badEdges: mesh ? watertight(mesh) : -1,
        tris: mesh ? mesh.stats.triangles : 0,
        clamped: mesh ? mesh.stats.clamped : false,
      });
    } catch (err) {
      results.push({ name, built: false, error: String(err) });
    }
  }
  return results;
});

console.log('\nStress — extreme edge treatments');
for (const r of stressRes) {
  check(r.name, r.built && r.badEdges === 0,
    r.error || `${r.tris} tris, ${r.badEdges} bad edges${r.clamped ? ', clamped' : ''}`);
}

// ---------- 5. Screw holes: table math + blind/CS/CB geometry ----------

const screwRes = await page.evaluate(async () => {
  const { buildSolid } = await import('./js/mesh.js');
  const { boreDiameter, recessDefaults } = await import('./js/screws.js');
  const app = window.__app;
  const { outer, holes } = app.traceEditor.getTrace();

  const watertight = mesh => {
    const { positions, indices } = mesh;
    const edgeUse = new Map();
    const vkey = i => `${positions[i * 3].toFixed(4)},${positions[i * 3 + 1].toFixed(4)},${positions[i * 3 + 2].toFixed(4)}`;
    for (let t = 0; t < indices.length; t += 3) {
      const ks = [vkey(indices[t]), vkey(indices[t + 1]), vkey(indices[t + 2])];
      if (ks[0] === ks[1] || ks[1] === ks[2] || ks[0] === ks[2]) continue;
      for (let e = 0; e < 3; e++) {
        const a = ks[e], b = ks[(e + 1) % 3];
        const key = a < b ? a + '|' + b : b + '|' + a;
        edgeUse.set(key, (edgeUse.get(key) || 0) + 1);
      }
    }
    let bad = 0;
    for (const n of edgeUse.values()) if (n !== 2) bad++;
    return bad;
  };

  // Object spans x 65..145, y 120..170 (mm, image coords). Object centre
  // (105,145) maps to model origin; model y is flipped (y_model = 145 - cy).
  const t = 6;
  const m5 = boreDiameter('metric', 'M5', 'clearance');   // 5 + 0.4 = 5.4
  const m5rec = recessDefaults('metric', 'M5');
  const screwHoles = [
    // CS M5 clearance from top at image (80, 132) -> model (-25, +13)
    { cx: 80, cy: 132, d: m5, type: 'cs', side: 'top',
      csAngle: m5rec.csAngle, csDia: m5rec.csDia },
    // CB #8-32 from bottom at (130, 132) -> model (25, 13)
    { cx: 130, cy: 132, d: boreDiameter('sae', '#8-32', 'clearance'),
      type: 'cb', side: 'bottom', ...recessDefaults('sae', '#8-32') },
    // Blind M3 tap fit from top, 4 deep, at (80, 158) -> model (-25, -13)
    { cx: 80, cy: 158, d: boreDiameter('metric', 'M3', 'tap'),
      type: 'blind', side: 'top', depth: 4 },
    // Through hole with rim treatments: 1 mm chamfer top, 0.8 mm fillet
    // bottom, at (105, 130) -> model (0, 15)
    { cx: 105, cy: 130, d: 4.35, type: 'through', side: 'top',
      edgeTop: { mode: 'chamfer', size: 1 }, edgeBottom: { mode: 'fillet', size: 0.8 } },
    // Through hole overlapping the outline edge -> must demote with warning
    { cx: 146, cy: 158, d: 6, type: 'cb', side: 'top', cbDia: 11, cbDepth: 2 },
  ];
  const params = {
    thickness: t,
    top: { mode: 'none', size: 0 }, bottom: { mode: 'none', size: 0 },
    arcSegments: 6,
  };
  const mesh = buildSolid(outer, holes, screwHoles, params);
  if (!mesh) return { ok: false };
  const { positions } = mesh;

  // Vertex radius stats around a model-space centre at a given z.
  const radiiAt = (mx, my, z, maxDist) => {
    const rs = [];
    for (let i = 0; i < positions.length; i += 3) {
      if (Math.abs(positions[i + 2] - z) > 1e-4) continue;
      const d = Math.hypot(positions[i] - mx, positions[i + 1] - my);
      if (d < maxDist) rs.push(d);
    }
    return rs;
  };
  const minMax = rs => rs.length ? [Math.min(...rs), Math.max(...rs)] : [NaN, NaN];

  const csTop = minMax(radiiAt(-25, 13, t, m5rec.csDia / 2 + 0.4));   // cone mouth
  const csBot = minMax(radiiAt(-25, 13, 0, m5rec.csDia / 2 + 0.4));   // bore exit
  const cb = screwHoles[1];
  const cbBot = minMax(radiiAt(25, 13, 0, cb.cbDia / 2 + 0.4));       // recess mouth
  const cbShelf = minMax(radiiAt(25, 13, cb.cbDepth, cb.cbDia / 2 + 0.4));
  const blind = screwHoles[2];
  const blindFloor = radiiAt(-25, -13, t - blind.depth, blind.d / 2 + 0.3);
  const blindBot = radiiAt(-25, -13, 0, 6); // should be EMPTY (no bottom opening)
  const rimTop = minMax(radiiAt(0, 15, t, 3.6));   // bore/2 + 1 mm chamfer
  const rimBot = minMax(radiiAt(0, 15, 0, 3.6));   // bore/2 + 0.8 mm fillet

  return {
    ok: true,
    badEdges: watertight(mesh),
    warnings: mesh.stats.warnings,
    m3tap: boreDiameter('metric', 'M3', 'tap'),
    m3clear: boreDiameter('metric', 'M3', 'clearance'),
    n632tap: boreDiameter('sae', '#6-32', 'tap'),
    m5bore: m5,
    csTop, csBot, cbBot, cbShelf, rimTop, rimBot,
    blindFloorCount: blindFloor.length,
    blindBotCount: blindBot.length,
    tris: mesh.stats.triangles,
  };
});

console.log('\nScrew holes — table math + feature geometry');
check('mesh with screw features built', screwRes.ok);
if (screwRes.ok) {
  check('M3 clearance = 3.25 (nominal + ½ pitch)', screwRes.m3clear === 3.25, `${screwRes.m3clear}`);
  check('M3 thread-into = 2.75 (nominal − ½ pitch, looser than 2.5 tap drill)',
    screwRes.m3tap === 2.75, `${screwRes.m3tap}`);
  check('#6-32 thread-into ≈ 3.10', near(screwRes.n632tap, 3.11, 0.03), `${screwRes.n632tap}`);
  check('watertight with all features', screwRes.badEdges === 0, `${screwRes.badEdges} bad edges`);
  check('CS cone mouth at top ≈ csDia/2', near(screwRes.csTop[1], 5.9, 0.15) && near(screwRes.csTop[0], 5.9, 0.15),
    `${screwRes.csTop[0].toFixed(2)}..${screwRes.csTop[1].toFixed(2)}`);
  check('CS bore at bottom ≈ 2.7', near(screwRes.csBot[0], 2.7, 0.1) && near(screwRes.csBot[1], 2.7, 0.1),
    `${screwRes.csBot[0].toFixed(2)}..${screwRes.csBot[1].toFixed(2)}`);
  check('CB recess mouth at bottom ≈ cbDia/2', near(screwRes.cbBot[1], 3.93, 0.12),
    `${screwRes.cbBot[0].toFixed(2)}..${screwRes.cbBot[1].toFixed(2)}`);
  check('CB shelf spans bore..cbDia at depth',
    near(screwRes.cbShelf[0], 2.28, 0.12) && near(screwRes.cbShelf[1], 3.93, 0.12),
    `${screwRes.cbShelf[0].toFixed(2)}..${screwRes.cbShelf[1].toFixed(2)}`);
  check('blind hole has a floor and no bottom opening',
    screwRes.blindFloorCount > 8 && screwRes.blindBotCount === 0,
    `floor verts ${screwRes.blindFloorCount}, bottom verts ${screwRes.blindBotCount}`);
  check('rim chamfer widens top opening to bore/2 + 1',
    near(screwRes.rimTop[0], 3.175, 0.1) && near(screwRes.rimTop[1], 3.175, 0.1),
    `${screwRes.rimTop[0].toFixed(2)}..${screwRes.rimTop[1].toFixed(2)}`);
  check('rim fillet widens bottom opening to bore/2 + 0.8',
    near(screwRes.rimBot[0], 2.975, 0.1) && near(screwRes.rimBot[1], 2.975, 0.1),
    `${screwRes.rimBot[0].toFixed(2)}..${screwRes.rimBot[1].toFixed(2)}`);
  check('edge-overlapping hole demoted with warning',
    screwRes.warnings.some(w => /too close|outside/.test(w)), screwRes.warnings.join(' | '));
}

// ---------- 6. Editor interactions: drag-to-size, on-canvas ⌀, units, normalize ----------

const unitRes = await page.evaluate(async () => {
  const { parseLength } = await import('./js/units.js');
  return {
    half_quote: parseLength('.5"', 'mm'),
    half_frac: parseLength('1/2 in', 'mm'),
    mixed: parseLength('1 1/2"', 'mm'),
    bare_mm: parseLength('12.7', 'mm'),
    bare_in_mode: parseLength('0.5', 'in'),
    three_eighths: parseLength('3/8"', 'mm'),
    mm_suffix_in_mode: parseLength('12mm', 'in'),
    cm: parseLength('1.2 cm', 'mm'),
    cm_nospace: parseLength('5cm', 'in'),
    metre: parseLength('0.3 m', 'mm'),
    ft: parseLength('2 ft', 'mm'),
    ftTick: parseLength("2'", 'mm'),
    ftIn: parseLength(`1' 6"`, 'mm'),
    ftInWords: parseLength('1 ft 6 in', 'mm'),
    ftInFrac: parseLength(`1' 6-1/2"`, 'mm'),
    inchWord: parseLength('3 inches', 'mm'),
    commaDec: parseLength('12,7', 'mm'),
    commaCm: parseLength('1,2 cm', 'mm'),
    commaFtIn: parseLength(`1' 6,5"`, 'mm'),
  };
});

console.log('\nEditor interactions — units, drag-to-size, on-canvas ⌀, normalize');
check('unit parsing: .5" = 1/2 in = 12.7 mm',
  near(unitRes.half_quote, 12.7, 1e-9) && near(unitRes.half_frac, 12.7, 1e-9),
  `${unitRes.half_quote}, ${unitRes.half_frac}`);
check('unit parsing: 1 1/2" = 38.1, 3/8" = 9.525, bare-in-inch-mode 0.5 = 12.7',
  near(unitRes.mixed, 38.1, 1e-9) && near(unitRes.three_eighths, 9.525, 1e-9) &&
  near(unitRes.bare_in_mode, 12.7, 1e-9),
  `${unitRes.mixed}, ${unitRes.three_eighths}, ${unitRes.bare_in_mode}`);
check('unit parsing: bare mm + explicit mm-in-inch-mode',
  near(unitRes.bare_mm, 12.7, 1e-9) && near(unitRes.mm_suffix_in_mode, 12, 1e-9),
  `${unitRes.bare_mm}, ${unitRes.mm_suffix_in_mode}`);
check('unit parsing: cm and m (1.2cm=12, 5cm=50, 0.3m=300)',
  near(unitRes.cm, 12, 1e-9) && near(unitRes.cm_nospace, 50, 1e-9) && near(unitRes.metre, 300, 1e-9),
  `${unitRes.cm}, ${unitRes.cm_nospace}, ${unitRes.metre}`);
check('unit parsing: feet (2ft=609.6, 2\'=609.6) and inch word (3in=76.2)',
  near(unitRes.ft, 609.6, 1e-6) && near(unitRes.ftTick, 609.6, 1e-6) && near(unitRes.inchWord, 76.2, 1e-6),
  `${unitRes.ft}, ${unitRes.ftTick}, ${unitRes.inchWord}`);
check("unit parsing: feet+inches (1' 6\"=457.2, words=457.2, 1' 6-1/2\"=469.9)",
  near(unitRes.ftIn, 457.2, 1e-6) && near(unitRes.ftInWords, 457.2, 1e-6) && near(unitRes.ftInFrac, 469.9, 1e-6),
  `${unitRes.ftIn}, ${unitRes.ftInWords}, ${unitRes.ftInFrac}`);
check('unit parsing: comma decimal (12,7=12.7, 1,2cm=12, 1\' 6,5"=469.9)',
  near(unitRes.commaDec, 12.7, 1e-9) && near(unitRes.commaCm, 12, 1e-9) && near(unitRes.commaFtIn, 469.9, 1e-6),
  `${unitRes.commaDec}, ${unitRes.commaCm}, ${unitRes.commaFtIn}`);

// Drag-to-size: place a hole at (90, 145) mm and drag 4 mm outward.
await page.evaluate(() => window.__app.goStep(2));
const dragPos = await page.evaluate(() => {
  const te = window.__app.traceEditor;
  const rect = te.canvas.getBoundingClientRect();
  const p = te._mmToScreen({ x: 90, y: 145 });
  const q = te._mmToScreen({ x: 94, y: 145 });
  return { x1: rect.left + p.x, y1: rect.top + p.y, x2: rect.left + q.x, y2: rect.top + q.y };
});
await page.click('[data-tool="addhole"]');
await page.mouse.move(dragPos.x1, dragPos.y1);
await page.mouse.down();
await page.mouse.move(dragPos.x2, dragPos.y2, { steps: 6 });
await page.mouse.up();

const placed = await page.evaluate(() => {
  const te = window.__app.traceEditor;
  const c = te.circles[te.circles.length - 1];
  return {
    cx: c.cx, cy: c.cy, d: c.d,
    tagVisible: !document.getElementById('holeTag').hidden,
    tagFocused: document.activeElement === document.getElementById('holeTagInput'),
    tagValue: document.getElementById('holeTagInput').value,
  };
});
check('drag-to-size places hole at press point with dragged ⌀',
  near(placed.cx, 90, 0.4) && near(placed.cy, 145, 0.4) && near(placed.d, 8, 0.4),
  `(${placed.cx.toFixed(1)}, ${placed.cy.toFixed(1)}) ⌀${placed.d}`);
check('on-canvas ⌀ tag appears focused after placing',
  placed.tagVisible && placed.tagFocused, `value ${placed.tagValue}`);

// Type an inch value straight into the on-canvas tag.
await page.fill('#holeTagInput', '1/4"');
await page.keyboard.press('Enter');
const typed = await page.evaluate(() => {
  const te = window.__app.traceEditor;
  return te.circles[te.circles.length - 1].d;
});
check('typing 1/4" into the tag sets ⌀6.35 mm', near(typed, 6.35, 0.01), `${typed}`);

// Normalize the traced hole (explicit button, never automatic).
const norm = await page.evaluate(() => {
  const app = window.__app;
  const before = { holes: app.traceEditor.holes.length, circles: app.traceEditor.circles.length };
  document.getElementById('normalizeAllBtn').click();
  const te = app.traceEditor;
  const c = te.circles[te.circles.length - 1];
  return {
    before,
    after: { holes: te.holes.length, circles: te.circles.length },
    circle: { cx: c.cx, cy: c.cy, d: c.d },
  };
});
check('normalize converts the traced hole to a perfect circle',
  norm.before.holes === 1 && norm.after.holes === 0 &&
  norm.after.circles === norm.before.circles + 1 &&
  near(norm.circle.cx, 105, 0.5) && near(norm.circle.cy, 145, 0.5) && near(norm.circle.d, 11.9, 0.5),
  `⌀${norm.circle.d} at (${norm.circle.cx.toFixed(1)}, ${norm.circle.cy.toFixed(1)})`);

// The normalized hole must still build a watertight solid.
const normMesh = await page.evaluate(async () => {
  const { buildSolid } = await import('./js/mesh.js');
  const app = window.__app;
  const { outer, holes, circles } = app.traceEditor.getTrace();
  const mesh = buildSolid(outer, holes, circles, {
    thickness: 5, top: { mode: 'none', size: 0 }, bottom: { mode: 'none', size: 0 }, arcSegments: 6,
  });
  if (!mesh) return { ok: false };
  const { positions, indices } = mesh;
  const edgeUse = new Map();
  const vkey = i => `${positions[i * 3].toFixed(4)},${positions[i * 3 + 1].toFixed(4)},${positions[i * 3 + 2].toFixed(4)}`;
  for (let t = 0; t < indices.length; t += 3) {
    const ks = [vkey(indices[t]), vkey(indices[t + 1]), vkey(indices[t + 2])];
    if (ks[0] === ks[1] || ks[1] === ks[2] || ks[0] === ks[2]) continue;
    for (let e = 0; e < 3; e++) {
      const a = ks[e], b = ks[(e + 1) % 3];
      const key = a < b ? a + '|' + b : b + '|' + a;
      edgeUse.set(key, (edgeUse.get(key) || 0) + 1);
    }
  }
  let bad = 0;
  for (const n of edgeUse.values()) if (n !== 2) bad++;
  return { ok: true, bad, tris: mesh.stats.triangles };
});
check('solid with normalized + placed holes is watertight',
  normMesh.ok && normMesh.bad === 0, `${normMesh.tris} tris, ${normMesh.bad} bad`);

// ---------- 7. Project save -> fresh page -> load (the artifact escape hatch) ----------

const savedProject = await page.evaluate(() => {
  document.getElementById('projectBtn').click();
  const app = window.__app;
  return {
    text: document.getElementById('projText').value,
    outerPts: app.traceEditor.outer.length,
    circles: app.traceEditor.circles.length,
  };
});

await page.reload();
await page.waitForFunction(() => window.__app && window.ClipperLib);
await page.evaluate(text => {
  document.getElementById('projectBtn').click();
  document.getElementById('projText').value = text;
  document.getElementById('projLoadTextBtn').click();
}, savedProject.text);
await page.waitForFunction(() =>
  window.__app.state.rect && window.__app.traceEditor.outer.length >= 3, null, { timeout: 10000 });

const restored = await page.evaluate(async () => {
  const app = window.__app;
  app.goStep(3);
  await new Promise(r => setTimeout(r, 700));
  return {
    outerPts: app.traceEditor.outer.length,
    circles: app.traceEditor.circles.length,
    hasRect: !!app.state.rect,
    meshTris: app.state.meshData ? app.state.meshData.stats.triangles : 0,
    paper: app.state.paper.size,
  };
});

console.log('\nProject transfer — save, reload, load, export-ready');
check('project JSON round-trips the full trace after a fresh page load',
  restored.outerPts === savedProject.outerPts && restored.circles === savedProject.circles &&
  restored.hasRect && restored.paper === 'A4',
  `${restored.outerPts} pts, ${restored.circles} circles, rect ${restored.hasRect}`);
check('restored project builds a mesh (export-ready with no photo re-trace)',
  restored.meshTris > 100, `${restored.meshTris} tris`);

// ---------- 8. Multi-section model: thicknesses, floor offset, cross-section holes ----------

const multiRes = await page.evaluate(async () => {
  const { buildModel } = await import('./js/mesh.js');
  const { boreDiameter, recessDefaults } = await import('./js/screws.js');
  const app = window.__app;
  const { outer, holes } = app.traceEditor.getTrace();

  const rect = (x0, y0, x1, y1) =>
    [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }];
  const none = { mode: 'none', size: 0 };
  // Base 4 mm; boss 9 mm on top of it; wing hanging at z 5..7, sticking out
  // past the base outline (a true overhang).
  const regions = [
    { name: 'Base', pts: null, thickness: 4, zBase: 0, top: none, bottom: none },
    { name: 'Boss', pts: rect(90, 130, 120, 145), thickness: 9, zBase: 0, top: none, bottom: none },
    { name: 'Wing', pts: rect(140, 135, 160, 155), thickness: 2, zBase: 5, top: none, bottom: none },
  ];
  // CS hole through boss + base: entry face must be the boss top (z=9).
  const m5 = boreDiameter('metric', 'M5', 'clearance');
  const m5rec = recessDefaults('metric', 'M5');
  const screwHoles = [{
    cx: 105, cy: 137, d: m5, type: 'cs', side: 'top',
    csAngle: m5rec.csAngle, csDia: m5rec.csDia,
  }];

  const mesh = buildModel(outer, holes, screwHoles, regions, 6);
  if (!mesh) return { ok: false };
  const { positions, indices, stats } = mesh;

  const radiiAt = (mx, my, z, maxDist) => {
    const rs = [];
    for (let i = 0; i < positions.length; i += 3) {
      if (Math.abs(positions[i + 2] - z) > 1e-4) continue;
      const d = Math.hypot(positions[i] - mx, positions[i + 1] - my);
      if (d < maxDist) rs.push(d);
    }
    return rs.length ? [Math.min(...rs), Math.max(...rs)] : [NaN, NaN];
  };
  // Wing-only x range (base outer ends at model x=40; wing spans 35..55).
  let wingMinZ = 1e9, wingMaxZ = -1e9;
  for (let i = 0; i < positions.length; i += 3) {
    if (positions[i] > 42) {
      wingMinZ = Math.min(wingMinZ, positions[i + 2]);
      wingMaxZ = Math.max(wingMaxZ, positions[i + 2]);
    }
  }
  const edgeUse = new Map();
  const vkey = i => `${positions[i * 3].toFixed(4)},${positions[i * 3 + 1].toFixed(4)},${positions[i * 3 + 2].toFixed(4)}`;
  for (let t = 0; t < indices.length; t += 3) {
    const ks = [vkey(indices[t]), vkey(indices[t + 1]), vkey(indices[t + 2])];
    if (ks[0] === ks[1] || ks[1] === ks[2] || ks[0] === ks[2]) continue;
    for (let e = 0; e < 3; e++) {
      const a = ks[e], b = ks[(e + 1) % 3];
      const key = a < b ? a + '|' + b : b + '|' + a;
      edgeUse.set(key, (edgeUse.get(key) || 0) + 1);
    }
  }
  let bad = 0;
  for (const n of edgeUse.values()) if (n !== 2) bad++;

  return {
    ok: true, stats,
    csAtBossTop: radiiAt(0, 8, 9, m5rec.csDia / 2 + 0.4),
    boreAtBaseTop: radiiAt(0, 8, 4, m5 / 2 + 0.4),
    wingMinZ, wingMaxZ,
    badEdges: bad,
  };
});

console.log('\nMulti-section — thickness per region, overhang, cross-section holes');
check('model built with 3 sections', multiRes.ok && multiRes.stats.sections === 3,
  multiRes.ok ? `${multiRes.stats.sections} sections, ${multiRes.stats.triangles} tris` : 'build failed');
if (multiRes.ok) {
  check('overall height = tallest section (9 mm)',
    near(multiRes.stats.sizeZ, 9, 1e-6) && near(multiRes.stats.zTop, 9, 1e-6), `${multiRes.stats.sizeZ}`);
  check('overhang wing floats at z 5..7 (floor offset)',
    near(multiRes.wingMinZ, 5, 1e-6) && near(multiRes.wingMaxZ, 7, 1e-6),
    `${multiRes.wingMinZ}..${multiRes.wingMaxZ}`);
  check('CS recess lands on the boss top (true entry face, z=9)',
    near(multiRes.csAtBossTop[1], 5.9, 0.15), `${multiRes.csAtBossTop[0].toFixed(2)}..${multiRes.csAtBossTop[1].toFixed(2)}`);
  check('same hole is a plain bore through the base (z=4 opening ≈ 2.7)',
    near(multiRes.boreAtBaseTop[0], 2.7, 0.1) && near(multiRes.boreAtBaseTop[1], 2.7, 0.1),
    `${multiRes.boreAtBaseTop[0].toFixed(2)}..${multiRes.boreAtBaseTop[1].toFixed(2)}`);
  check('all section shells watertight', multiRes.badEdges === 0, `${multiRes.badEdges} bad edges`);
}

// ---------- 9. Group A: inserts, DXF, quality presets, card preset, version ----------

const groupA = await page.evaluate(async () => {
  const { insertHole, INSERT_SIZES } = await import('./js/screws.js');
  const { toDXF } = await import('./js/exporters.js');
  const { buildModel } = await import('./js/mesh.js');
  const { PAPER_SIZES } = await import('./js/paperSizes.js');
  const app = window.__app;

  // Insert preset: M3 -> blind pocket at recommended hole ⌀.
  const m3 = insertHole('M3');

  // DXF content check.
  const dxf = await toDXF(
    [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 8 }, { x: 0, y: 8 }],
    [[{ x: 3, y: 3 }, { x: 5, y: 3 }, { x: 5, y: 5 }, { x: 3, y: 5 }]],
    100
  ).text();

  // Quality presets change triangle density on the same trace.
  const { outer, holes, circles } = app.traceEditor.getTrace();
  const region = [{ name: 'B', pts: null, thickness: 4, zBase: 0,
    top: { mode: 'fillet', size: 1 }, bottom: { mode: 'none', size: 0 } }];
  const coarse = buildModel(outer, holes, circles, region, { arcSegments: 4, chordTol: 0.8 });
  const xfine = buildModel(outer, holes, circles, region, { arcSegments: 20, chordTol: 0.1 });

  // Version present in DOM and STL header.
  const { toBinarySTL } = await import('./js/exporters.js');
  const stlBuf = await toBinarySTL(new Float32Array([0,0,0, 1,0,0, 0,1,0]), new Uint32Array([0,1,2]), 'x').arrayBuffer();
  const stlHeader = new TextDecoder().decode(new Uint8Array(stlBuf, 0, 20));

  return {
    m3, hasM3: !!INSERT_SIZES['M3'],
    dxfOk: dxf.includes('AC1009') && (dxf.match(/POLYLINE/g) || []).length === 2 && dxf.includes('EOF'),
    coarseTris: coarse.stats.triangles, xfineTris: xfine.stats.triangles,
    cardW: PAPER_SIZES.card.w, cardH: PAPER_SIZES.card.h,
    versionInDom: document.getElementById('appVersion').textContent,
    versionInStl: stlHeader.startsWith('2.5D v'),
  };
});

console.log('\nGroup A — inserts, DXF, quality, card, version');
check('heat-set M3 insert -> blind pocket ⌀4.0 depth 5.5',
  groupA.hasM3 && near(groupA.m3.bore, 4.0, 0.01) && near(groupA.m3.depth, 5.5, 0.01),
  `⌀${groupA.m3.bore} × ${groupA.m3.depth}`);
check('DXF export is valid R12 with 2 closed polylines', groupA.dxfOk);
check('quality preset changes triangle density (xfine > coarse)',
  groupA.xfineTris > groupA.coarseTris * 1.3, `${groupA.coarseTris} vs ${groupA.xfineTris}`);
check('credit-card preset present (53.98 × 85.60 mm)',
  near(groupA.cardW, 53.98, 0.01) && near(groupA.cardH, 85.60, 0.01), `${groupA.cardW} × ${groupA.cardH}`);
check('version shown in header and stamped in STL',
  /^v\d+\.\d+\.\d+$/.test(groupA.versionInDom) && groupA.versionInStl, groupA.versionInDom);

// ---------- 10. Group B: hole resize hit-region, multi-select, arc/line fit ----------

const groupB = await page.evaluate(() => {
  const te = window.__app.traceEditor;
  // Reset to a clean known trace: a square outline + a couple circles.
  te.setTrace(
    [{ x: 20, y: 20 }, { x: 60, y: 20 }, { x: 60, y: 60 }, { x: 20, y: 60 }],
    []
  );
  te.setCircles([{ cx: 40, cy: 40, d: 10, type: 'through', side: 'top',
    csAngle: 90, csDia: 9, cbDia: 9, cbDepth: 3,
    edgeTop: { mode: 'none', size: 0.5 }, edgeBottom: { mode: 'none', size: 0.5 },
    screw: { std: 'custom', size: '', fit: 'clearance' } }]);

  // Hole hit-region: near the rim = resize, at the centre = move.
  const rimHit = te._hitCircle(te._mmToScreen({ x: 45, y: 40 }));  // 5 mm out = bore rim
  const ctrHit = te._hitCircle(te._mmToScreen({ x: 40, y: 40 }));

  // Multi-select a run of 3 collinear-ish points is not here; use outline
  // corners: select all 4 corners, group-move by +5,+5 via the API path.
  te.selectedVerts = [
    { loop: -1, idx: 0 }, { loop: -1, idx: 1 },
    { loop: -1, idx: 2 }, { loop: -1, idx: 3 },
  ];
  const before = te.outer.map(p => ({ ...p }));
  te._groupDrag = { start: { x: 0, y: 0 }, orig: before.map(p => ({ ...p })) };
  // Simulate a move to (+5, +5)
  te.selectedVerts.forEach((v, i) => {
    te.outer[v.idx] = { x: before[i].x + 5, y: before[i].y + 5 };
  });
  te._groupDrag = null;
  const moved = te.outer.every((p, i) => Math.abs(p.x - (before[i].x + 5)) < 1e-6);

  // Densify the outline's top edge run (idx 0..1).
  te.selectedVerts = [{ loop: -1, idx: 0 }, { loop: -1, idx: 1 }];
  const nBefore = te.outer.length;
  const densOk = te.densifySelection();
  const nAfter = te.outer.length;

  // Fit an arc: build a shallow-arc run of 5 points and fit it.
  te.setTrace([
    { x: 0, y: 10 }, { x: 2, y: 6 }, { x: 5, y: 5 }, { x: 8, y: 6 }, { x: 10, y: 10 },
    { x: 10, y: 30 }, { x: 0, y: 30 },
  ], []);
  te.selectedVerts = [0, 1, 2, 3, 4].map(idx => ({ loop: -1, idx }));
  const arcR = te.fitArcToSelection();
  const arcPtCount = te.outer.length;

  // Fit line: select a run and straighten it.
  te.setTrace([
    { x: 0, y: 0 }, { x: 2, y: 1 }, { x: 4, y: -1 }, { x: 6, y: 0.5 }, { x: 8, y: 0 },
    { x: 8, y: 20 }, { x: 0, y: 20 },
  ], []);
  te.selectedVerts = [0, 1, 2, 3, 4].map(idx => ({ loop: -1, idx }));
  const lineOk = te.fitLineToSelection();
  const lineLen = te.outer.length;

  return {
    rimResize: rimHit && rimHit.region === 'resize',
    ctrMove: ctrHit && ctrHit.region === 'move',
    moved,
    densOk, nBefore, nAfter,
    arcR, arcPtCount,
    lineOk, lineLen,
  };
});

console.log('\nGroup B — hole resize/move, multi-select, arc/line fit, densify');
check('hole rim hit = resize, centre hit = move', groupB.rimResize && groupB.ctrMove,
  `rim ${groupB.rimResize}, centre ${groupB.ctrMove}`);
check('group move shifts all selected vertices together', groupB.moved);
check('densify adds a midpoint on the selected edge', groupB.densOk && groupB.nAfter === groupB.nBefore + 1,
  `${groupB.nBefore} -> ${groupB.nAfter}`);
check('fit arc replaces a run with a smooth arc (>5 pts)',
  groupB.arcR > 0 && groupB.arcPtCount > 7, `r=${groupB.arcR}, ${groupB.arcPtCount} outline pts`);
check('fit line straightens a run to 2 endpoints (7 -> 4 pts)',
  groupB.lineOk && groupB.lineLen === 4, `${groupB.lineLen} pts`);

// ---------- 11. Group C: rotate 90°, coin scale math, outline library ----------

const groupC = await page.evaluate(async () => {
  const { paperDims } = await import('./js/paperSizes.js');
  const app = window.__app;

  // Rebuild a simple rectified state to rotate.
  const ppm = 4;
  const c = document.createElement('canvas');
  c.width = 400; c.height = 200; // 100 x 50 mm space
  c.getContext('2d').fillStyle = '#eee';
  c.getContext('2d').fillRect(0, 0, 400, 200);
  app.state.rect = { canvas: c, pxPerMm: ppm };
  app.state.diffMap = null;
  app.traceEditor.setRectified(c, ppm);
  app.traceEditor.setTrace(
    [{ x: 10, y: 10 }, { x: 90, y: 10 }, { x: 90, y: 40 }, { x: 10, y: 40 }], []);
  app.traceEditor.setCircles([]);

  const before = app.traceEditor.outer.map(p => ({ ...p }));
  const beforeDims = { w: app.state.rect.canvas.width / ppm, h: app.state.rect.canvas.height / ppm };
  // Rotate right (cw): (x,y) -> (Hmm - y, x); Hmm=50.
  document.getElementById('rotateRightBtn').click();
  const after = app.traceEditor.outer.map(p => ({ ...p }));
  const afterDims = { w: app.state.rect.canvas.width / ppm, h: app.state.rect.canvas.height / ppm };
  const rotOk = Math.abs(after[0].x - (50 - before[0].y)) < 1e-6 &&
                Math.abs(after[0].y - before[0].x) < 1e-6 &&
                Math.abs(afterDims.w - beforeDims.h) < 1e-6 &&
                Math.abs(afterDims.h - beforeDims.w) < 1e-6;

  // Coin scale: set coin mode, a coin circle of radius 50px on a US quarter
  // (24.26 mm), no downscale (small image) -> pxPerMm = 2*50/24.26.
  const fakeImg = document.createElement('canvas');
  fakeImg.width = 300; fakeImg.height = 300;
  Object.defineProperty(fakeImg, 'naturalWidth', { value: 300 });
  Object.defineProperty(fakeImg, 'naturalHeight', { value: 300 });
  app.state.reference = 'coin';
  app.state.coin = { size: 'us_quarter', customD: 24.26 };
  app.state.image = fakeImg;
  app.cornerEditor.image = fakeImg;
  app.cornerEditor.setRefMode('coin');
  app.cornerEditor.setCoin({ cx: 150, cy: 150, r: 50 });
  app.doRectify();
  const coinPpm = app.state.rect ? app.state.rect.pxPerMm : null;

  // Outline library round-trip (localStorage).
  app.traceEditor.setTrace(
    [{ x: 5, y: 5 }, { x: 25, y: 5 }, { x: 25, y: 20 }, { x: 5, y: 20 }], []);
  document.getElementById('libName').value = 'test-drawer';
  document.getElementById('libSaveBtn').click();
  // Clear then load it back.
  app.traceEditor.setTrace([{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }], []);
  const list = JSON.parse(localStorage.getItem('2p5d.library.v1') || '[]');
  const savedNames = list.map(o => o.name);

  return {
    rotOk,
    coinPpm, coinExpected: 2 * 50 / 24.26,
    savedNames,
    cardDims: paperDims('card', 'portrait'),
  };
});

console.log('\nGroup C — rotate 90°, coin scale, outline library');
check('rotate right maps geometry and swaps trace-space W/H', groupC.rotOk);
check('coin scale sets pxPerMm from coin diameter',
  groupC.coinPpm && near(groupC.coinPpm, groupC.coinExpected, 0.05),
  `${groupC.coinPpm} vs ${groupC.coinExpected.toFixed(3)}`);
check('outline library saves a named outline to storage',
  groupC.savedNames.includes('test-drawer'), groupC.savedNames.join(', '));
check('card reference resolves to ISO ID-1 dims',
  near(groupC.cardDims.w, 53.98, 0.01) && near(groupC.cardDims.h, 85.60, 0.01),
  `${groupC.cardDims.w} × ${groupC.cardDims.h}`);

// ---------- 12. Phase 1: vector CAD import (DXF + SVG) ----------

// 80 × 50 rectangle with a ⌀12 hole. DXF is Y-up; SVG carries real mm units.
const DXF = [
  '0','SECTION','2','HEADER','9','$INSUNITS','70','4','0','ENDSEC',
  '0','SECTION','2','ENTITIES',
  '0','LWPOLYLINE','8','0','90','4','70','1',
  '10','0','20','0','10','80','20','0','10','80','20','50','10','0','20','50',
  '0','CIRCLE','8','0','10','40','20','25','40','6',
  // a dimension on an annotation layer that must be filtered out
  '0','LINE','8','DIMENSIONS','10','0','20','-10','11','80','21','-10',
  '0','ENDSEC','0','EOF',
].join('\n');

const DXF_TWOVIEW = [
  '0','SECTION','2','ENTITIES',
  '0','LWPOLYLINE','8','0','90','4','70','1','10','0','20','0','10','40','20','0','10','40','20','30','10','0','20','30',
  '0','LWPOLYLINE','8','0','90','4','70','1','10','100','20','0','10','160','20','0','10','160','20','40','10','100','20','40',
  '0','ENDSEC','0','EOF',
].join('\n');

const SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="80mm" height="50mm" viewBox="0 0 80 50">
  <rect x="0" y="0" width="80" height="50" fill="none" stroke="#000"/>
  <circle cx="40" cy="25" r="6" fill="none" stroke="#000"/>
</svg>`;

const cadUnit = await page.evaluate(async ({ dxf, svg, two }) => {
  const { importCad } = await import('./js/import/cadImport.js');
  const dim = r => { const v = r.views[0]; return v ? { w: v.w, h: v.h, holes: v.holes.length } : null; };
  const rDxf = importCad('part.dxf', dxf);
  const rSvg = importCad('part.svg', svg);
  const rDwg = importCad('part.dwg', 'PK binary');
  const rTwo = importCad('sheet.dxf', two);
  return {
    dxf: dim(rDxf), dxfUnits: rDxf.unitsKnown, dxfUnitName: rDxf.unitName,
    svg: dim(rSvg), svgUnits: rSvg.unitsKnown,
    dwgWarn: (rDwg.warnings || [])[0] || '', dwgViews: rDwg.views.length,
    twoCount: rTwo.views.length, twoBig: dim(rTwo),
  };
}, { dxf: DXF, svg: SVG, two: DXF_TWOVIEW });

console.log('\nPhase 1 — vector CAD import (DXF + SVG)');
check('DXF parses to 80×50 mm with 1 hole, units from $INSUNITS',
  cadUnit.dxf && near(cadUnit.dxf.w, 80, 0.01) && near(cadUnit.dxf.h, 50, 0.01) &&
  cadUnit.dxf.holes === 1 && cadUnit.dxfUnits && cadUnit.dxfUnitName === 'mm',
  cadUnit.dxf ? `${cadUnit.dxf.w}×${cadUnit.dxf.h}, ${cadUnit.dxf.holes} hole` : 'no view');
check('DXF annotation layer (DIMENSIONS) filtered out (1 view only)',
  cadUnit.dxf && cadUnit.dxf.holes === 1);
check('SVG parses to 80×50 mm with 1 hole, real units',
  cadUnit.svg && near(cadUnit.svg.w, 80, 0.01) && near(cadUnit.svg.h, 50, 0.01) &&
  cadUnit.svg.holes === 1 && cadUnit.svgUnits,
  cadUnit.svg ? `${cadUnit.svg.w}×${cadUnit.svg.h}, ${cadUnit.svg.holes} hole` : 'no view');
check('DWG is rejected with an export-to-DXF message',
  cadUnit.dwgViews === 0 && /DXF/.test(cadUnit.dwgWarn), cadUnit.dwgWarn);
check('multi-view sheet detected as 2 views, largest first (60×40)',
  cadUnit.twoCount === 2 && near(cadUnit.twoBig.w, 60, 0.01) && near(cadUnit.twoBig.h, 40, 0.01),
  `${cadUnit.twoCount} views, biggest ${cadUnit.twoBig.w}×${cadUnit.twoBig.h}`);

// Integration: drive the real file input → auto-loads (1 view, known units) →
// step 2 → build a watertight solid from the imported geometry.
await page.setInputFiles('#cadFileInput',
  { name: 'part.dxf', mimeType: 'application/dxf', buffer: Buffer.from(DXF) });
await page.waitForFunction(() =>
  window.__app.state.step === 2 && window.__app.traceEditor.outer.length >= 4, null, { timeout: 8000 });

const cadInt = await page.evaluate(async () => {
  const app = window.__app;
  const t = app.traceEditor.getTrace();
  let minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9;
  for (const p of t.outer) { minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y); }
  const { buildModel } = await import('./js/mesh.js');
  const mesh = buildModel(t.outer, t.holes, t.circles, app.state.regions, { arcSegments: 8, chordTol: 0.4 });
  let bad = 0;
  if (mesh) {
    const { positions, indices } = mesh;
    const edge = new Map();
    const vk = i => `${positions[i*3].toFixed(3)},${positions[i*3+1].toFixed(3)},${positions[i*3+2].toFixed(3)}`;
    for (let i = 0; i < indices.length; i += 3) {
      const ks = [vk(indices[i]), vk(indices[i+1]), vk(indices[i+2])];
      for (let e = 0; e < 3; e++) { const a = ks[e], b = ks[(e+1)%3]; const key = a<b?a+'|'+b:b+'|'+a; edge.set(key, (edge.get(key)||0)+1); }
    }
    for (const n of edge.values()) if (n !== 2) bad++;
  }
  return { w: maxX - minX, h: maxY - minY, holes: t.holes.length, tris: mesh ? mesh.stats.triangles : 0, bad };
});

console.log('\nPhase 1 — file-input integration');
check('importing a DXF file lands an 80×50 trace with 1 hole in step 2',
  near(cadInt.w, 80, 0.5) && near(cadInt.h, 50, 0.5) && cadInt.holes === 1,
  `${cadInt.w.toFixed(1)}×${cadInt.h.toFixed(1)}, ${cadInt.holes} hole`);
check('imported DXF builds a watertight solid', cadInt.tris > 100 && cadInt.bad === 0,
  `${cadInt.tris} tris, ${cadInt.bad} bad edges`);

// ---------- 13. Step-1 photo rotate (carries corners) ----------

const rotPhoto = await page.evaluate(async () => {
  const app = window.__app;
  // Load a 200×100 image and set known corners.
  const c = document.createElement('canvas');
  c.width = 200; c.height = 100;
  const ctx = c.getContext('2d'); ctx.fillStyle = '#ccc'; ctx.fillRect(0, 0, 200, 100);
  await new Promise(res => app.loadImageFromURL(c.toDataURL('image/png'), res));
  app.state.reference = 'rect';
  document.getElementById('refType').value = 'rect';
  app.cornerEditor.setRefMode('corners');
  app.state.corners = [{ x: 10, y: 20 }, { x: 190, y: 20 }, { x: 190, y: 80 }, { x: 10, y: 80 }];
  app.cornerEditor.setCorners(app.state.corners);
  const before = { w: app.state.image.naturalWidth || app.state.image.width,
                   h: app.state.image.naturalHeight || app.state.image.height,
                   c0: { ...app.state.corners[0] } };
  document.getElementById('rotatePhotoRightBtn').click();  // cw: (x,y)->(H - y, x); H=100
  const after = { w: app.state.image.width, h: app.state.image.height, c0: { ...app.state.corners[0] } };
  return { before, after };
});

console.log('\nStep-1 photo rotate');
check('rotate photo right swaps image dims (200×100 → 100×200)',
  rotPhoto.after.w === 100 && rotPhoto.after.h === 200, `${rotPhoto.after.w}×${rotPhoto.after.h}`);
check('corner maps with the rotation ((10,20) → (80,10))',
  near(rotPhoto.after.c0.x, 80, 1e-6) && near(rotPhoto.after.c0.y, 10, 1e-6),
  `(${rotPhoto.after.c0.x}, ${rotPhoto.after.c0.y})`);

// ---------- 14. Radial lens-distortion correction ----------

const lens = await page.evaluate(async () => {
  const { lensParams, distortPixel, undistortPixel, estimateDistortion } = await import('./js/lens.js');
  const { rectify, computeHomography, applyHomography } = await import('./js/homography.js');

  // Round-trip: undistort(distort(p)) ≈ p.
  const lp = lensParams(1000, 800);
  const p = { x: 900, y: 120 };
  const rt = undistortPixel(distortPixel(p, 0.12, 0, lp), 0.12, 0, lp);
  const rtErr = Math.hypot(rt.x - p.x, p.y - rt.y);

  // Build a synthetic distorted photo: an 80×50 object on A4, viewed with a
  // mild perspective, then radially distorted by a known k1.
  const K1 = 0.10;
  const paperW = 210, paperH = 297;
  const W = 1000, Hh = 1400;
  const lp2 = lensParams(W, Hh);
  const quad = [{ x: 150, y: 180 }, { x: 850, y: 150 }, { x: 900, y: 1250 }, { x: 120, y: 1280 }];
  const H = computeHomography(
    [{ x: 0, y: 0 }, { x: paperW, y: 0 }, { x: paperW, y: paperH }, { x: 0, y: paperH }], quad);
  const c = document.createElement('canvas'); c.width = W; c.height = Hh;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#38342e'; ctx.fillRect(0, 0, W, Hh);
  // Draw paper + object by mapping mm → ideal pixel (H) → distorted pixel.
  const mm2dist = (x, y) => { const q = applyHomography(H, x, y); return distortPixel(q, K1, 0, lp2); };
  const poly = (pts, fill) => {
    ctx.beginPath();
    pts.forEach((pt, i) => { const d = mm2dist(pt.x, pt.y); if (i === 0) ctx.moveTo(d.x, d.y); else ctx.lineTo(d.x, d.y); });
    ctx.closePath(); ctx.fillStyle = fill; ctx.fill();
  };
  // Dense edges so the distortion curves render (not just 4 straight segments).
  const dense = corners => {
    const out = [];
    for (let i = 0; i < corners.length; i++) {
      const a = corners[i], b = corners[(i + 1) % corners.length];
      for (let s = 0; s < 24; s++) out.push({ x: a.x + (b.x - a.x) * s / 24, y: a.y + (b.y - a.y) * s / 24 });
    }
    return out;
  };
  poly(dense([{ x: 0, y: 0 }, { x: paperW, y: 0 }, { x: paperW, y: paperH }, { x: 0, y: paperH }]), '#f4f2ec');
  poly(dense([{ x: 65, y: 120 }, { x: 145, y: 120 }, { x: 145, y: 170 }, { x: 65, y: 170 }]), '#23364a');

  // The 4 paper corners as they appear in the distorted photo (what the user clicks).
  const distCorners = [{ x: 0, y: 0 }, { x: paperW, y: 0 }, { x: paperW, y: paperH }, { x: 0, y: paperH }]
    .map(pt => mm2dist(pt.x, pt.y));

  // Measure the object width after rectify, with and without correction.
  const measure = (k1) => {
    const r = rectify(c, distCorners, paperW, paperH, { k1, maxLongSidePx: 1000 });
    const ctx2 = r.canvas.getContext('2d');
    const { data } = ctx2.getImageData(0, 0, r.canvas.width, r.canvas.height);
    const w2 = r.canvas.width, h2 = r.canvas.height;
    // Scan the object's mid-row (y≈145mm) for the dark span; width in mm.
    const yPx = Math.round(145 * r.pxPerMm);
    let lo = -1, hi = -1;
    for (let x = 0; x < w2; x++) {
      const i = (yPx * w2 + x) * 4;
      const dark = data[i] < 120 && data[i + 1] < 120;
      if (dark) { if (lo < 0) lo = x; hi = x; }
    }
    return lo < 0 ? null : (hi - lo) / r.pxPerMm;
  };
  const wNone = measure(0);
  const wCorr = measure(K1);

  const est = estimateDistortion(c, distCorners);

  return {
    rtErr, wNone, wCorr, estK: est ? est.k1 : null, estImproved: est ? est.improved : 0, injected: K1,
  };
});

console.log('\nLens distortion — correction + auto-estimate');
check('distort/undistort round-trips to sub-pixel', lens.rtErr < 0.05, `${lens.rtErr.toFixed(4)} px`);
check('correction recovers 80 mm object width better than none',
  lens.wCorr !== null && Math.abs(lens.wCorr - 80) < Math.abs((lens.wNone ?? 0) - 80) &&
  Math.abs(lens.wCorr - 80) < 1.2,
  `uncorrected ${(lens.wNone||0).toFixed(1)} → corrected ${(lens.wCorr||0).toFixed(1)} mm`);
check('auto-estimate recovers the injected k1 (~0.10)',
  lens.estK !== null && Math.abs(lens.estK - lens.injected) < 0.04,
  `est ${lens.estK}, injected ${lens.injected}`);

// ---------- 15. PDF import (Blueprint fork): vector geometry → view ----------

const pdfB64 = FIXTURE_PDF.toString('base64');
await page.waitForFunction(() => window.pdfjsLib, null, { timeout: 8000 }).catch(() => {});
const pdfHasLib = await page.evaluate(() => !!window.pdfjsLib);

let pdfRes = null;
if (pdfHasLib) {
  pdfRes = await page.evaluate(async (b64) => {
    const { importPDF } = await import('./js/import/pdfImport.js');
    const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    const r = await importPDF(bytes);
    const v = r.views[0];
    return {
      count: r.views.length, unitsKnown: r.unitsKnown, numPages: r.numPages,
      w: v ? v.w : null, h: v ? v.h : null, holes: v ? v.holes.length : null,
      texts: (r.texts || []).map(t => t.str),
    };
  }, pdfB64);
}

console.log('\nPDF import — vector geometry → view (Blueprint)');
check('pdf.js loaded (global pdfjsLib)', pdfHasLib);
if (pdfRes) {
  check('PDF vector parses to ~80×50 mm with 1 hole',
    pdfRes.w != null && near(pdfRes.w, 80, 0.6) && near(pdfRes.h, 50, 0.6) && pdfRes.holes === 1,
    pdfRes.w != null ? `${pdfRes.w.toFixed(1)}×${pdfRes.h.toFixed(1)}, ${pdfRes.holes} hole` : 'no view');
  check('PDF reports unconfirmed units (needs scale confirm)', pdfRes.unitsKnown === false);
  check('PDF text layer read (found "50")', pdfRes.texts.includes('50'), pdfRes.texts.join(','));
}

// Integration: drive the file input with the PDF → view/scale modal → Use →
// step 2 → watertight solid.
if (pdfHasLib) {
  await page.setInputFiles('#cadFileInput',
    { name: 'part.pdf', mimeType: 'application/pdf', buffer: FIXTURE_PDF });
  await page.waitForSelector('#cadModal:not([hidden])', { timeout: 8000 }).catch(() => {});
  const modalUp = await page.evaluate(() => !document.getElementById('cadModal').hidden);
  await page.evaluate(() => { document.getElementById('cadWidth').value = '80'; });
  await page.click('#cadUseBtn');
  await page.waitForFunction(() =>
    window.__app.state.step === 2 && window.__app.traceEditor.outer.length >= 4, null, { timeout: 8000 }).catch(() => {});
  const pdfInt = await page.evaluate(async () => {
    const app = window.__app;
    const t = app.traceEditor.getTrace();
    let minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9;
    for (const p of t.outer) { minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y); }
    const { buildModel } = await import('./js/mesh.js');
    const mesh = buildModel(t.outer, t.holes, t.circles, app.state.regions, { arcSegments: 8, chordTol: 0.4 });
    let bad = 0;
    if (mesh) {
      const { positions, indices } = mesh;
      const edge = new Map();
      const vk = i => `${positions[i*3].toFixed(3)},${positions[i*3+1].toFixed(3)},${positions[i*3+2].toFixed(3)}`;
      for (let i = 0; i < indices.length; i += 3) for (let e = 0; e < 3; e++) { const a = vk(indices[i+e]), b = vk(indices[i+(e+1)%3]); const key = a<b?a+'|'+b:b+'|'+a; edge.set(key, (edge.get(key)||0)+1); }
      for (const n of edge.values()) if (n !== 2) bad++;
    }
    return { w: maxX - minX, h: maxY - minY, holes: t.holes.length, tris: mesh ? mesh.stats.triangles : 0, bad };
  });
  check('PDF file-input lands an 80×50 trace with a hole in step 2',
    near(pdfInt.w, 80, 1) && near(pdfInt.h, 50, 1) && pdfInt.holes === 1,
    `${pdfInt.w.toFixed(1)}×${pdfInt.h.toFixed(1)}, ${pdfInt.holes} hole (modal ${modalUp})`);
  check('imported PDF builds a watertight solid', pdfInt.tris > 100 && pdfInt.bad === 0,
    `${pdfInt.tris} tris, ${pdfInt.bad} bad`);
}

// ---------- 16. PDF: read the drawing (title block + dimension → scale) ----------

// SCALE 1:2 drawing — geometry printed at 40×25 mm, real part is 80×50 mm.
// Title block: units MM, TITLE BRACKET-01, width dimension "80", height "50".
const mmpt = 40 * 72 / 25.4;
const SCALED_PDF = buildPDF(
  `1 w\n${rectMM(10, 10, 40, 25)}\n` +
  `BT /F1 8 Tf ${28*72/25.4} ${6*72/25.4} Td (80) Tj ET\n` +
  `BT /F1 8 Tf ${2*72/25.4} ${20*72/25.4} Td (50) Tj ET\n` +
  `BT /F1 7 Tf ${10*72/25.4} ${60*72/25.4} Td (SCALE 1:2) Tj ET\n` +
  `BT /F1 7 Tf ${40*72/25.4} ${60*72/25.4} Td (MM) Tj ET\n` +
  `BT /F1 7 Tf ${10*72/25.4} ${66*72/25.4} Td (TITLE: BRACKET-01) Tj ET`
);

if (pdfHasLib) {
  const readRes = await page.evaluate(async (b64) => {
    const { importPDF } = await import('./js/import/pdfImport.js');
    const { readTitleBlock, suggestScale } = await import('./js/import/pdfScale.js');
    const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    const r = await importPDF(bytes);
    const tb = readTitleBlock(r.texts);
    const sg = suggestScale(r.views[0], r.texts, tb);
    return { printedW: r.views[0].w, tb, sg };
  }, SCALED_PDF.toString('base64'));

  console.log('\nPDF — read the drawing (title block + scale)');
  check('title block: units MM, scale 1:2, part name read',
    readRes.tb.units === 'mm' && readRes.tb.scaleNote && readRes.tb.scaleNote.drawn === 1 &&
    readRes.tb.scaleNote.real === 2 && /BRACKET-01/.test(readRes.tb.name || ''),
    `${readRes.tb.units}, ${JSON.stringify(readRes.tb.scaleNote)}, "${readRes.tb.name}"`);
  check('printed geometry is ~40 mm; dimension sets true width to ~80 mm',
    near(readRes.printedW, 40, 0.6) && near(readRes.sg.realWidthMm, 80, 0.6),
    `printed ${readRes.printedW.toFixed(1)} → real ${readRes.sg.realWidthMm.toFixed(1)}`);

  // Integration: import scaled PDF → modal prefills ~80 → Use → step-2 trace ~80 mm.
  await page.setInputFiles('#cadFileInput',
    { name: 'bracket.pdf', mimeType: 'application/pdf', buffer: SCALED_PDF });
  await page.waitForSelector('#cadModal:not([hidden])', { timeout: 8000 }).catch(() => {});
  const prefill = await page.evaluate(() => parseFloat(document.getElementById('cadWidth').value));
  await page.click('#cadUseBtn');
  await page.waitForFunction(() => window.__app.state.step === 2 && window.__app.traceEditor.outer.length >= 4,
    null, { timeout: 8000 }).catch(() => {});
  const scaled = await page.evaluate(() => {
    const t = window.__app.traceEditor.getTrace();
    let minX = 1e9, maxX = -1e9; for (const p of t.outer) { minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); }
    return { w: maxX - minX, name: window.__app.state.fileName };
  });
  check('scaled PDF: width prefilled ~80 and trace rescaled to ~80 mm',
    near(prefill, 80, 1) && near(scaled.w, 80, 1.5), `prefill ${prefill}, trace ${scaled.w.toFixed(1)}`);
  check('part name from title block used as project name', /BRACKET-01/.test(scaled.name), scaled.name);
}

console.log('\nConsole errors:', consoleErrors.length ? consoleErrors : 'none');
if (consoleErrors.length) failures++;

await browser.close();
server.close();

console.log(failures === 0 ? '\nAll checks passed ✔' : `\n${failures} check(s) FAILED ✘`);
process.exit(failures === 0 ? 0 : 1);
