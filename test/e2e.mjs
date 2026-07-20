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
  check('Export SVG fires a download with valid SVG content',
    !!svgDl && /-outline\.svg$/.test(svgDl.suggestedFilename()) &&
    svgTxt.includes('<svg') && svgTxt.includes('width="210mm"'),
    svgDl ? `${svgDl.suggestedFilename()}, ${svgTxt.length} chars` : 'no download event');

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

console.log('\nConsole errors:', consoleErrors.length ? consoleErrors : 'none');
if (consoleErrors.length) failures++;

await browser.close();
server.close();

console.log(failures === 0 ? '\nAll checks passed ✔' : `\n${failures} check(s) FAILED ✘`);
process.exit(failures === 0 ? 0 : 1);
