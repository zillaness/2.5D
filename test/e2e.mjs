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
let checks = 0;
function check(name, ok, detail = '') {
  const mark = ok ? 'PASS' : 'FAIL';
  checks++;
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

// ---------- 10b. Part A: selection gesture resolvers ----------

// Every gesture resolver takes screen-space geometry and returns a plain
// [{loop, idx}] list, so each one is driven here without a mouse. The fixture
// is a 40 x 40 mm square whose corners are, in order:
//   0 (20,20)  1 (60,20)  2 (60,60)  3 (20,60)

const selA = await page.evaluate(() => {
  const app = window.__app;
  const te = app.traceEditor;
  const ppm = 4;
  const c = document.createElement('canvas');
  c.width = 400; c.height = 400; // 100 x 100 mm of trace space
  const g = c.getContext('2d');
  g.fillStyle = '#eee'; g.fillRect(0, 0, 400, 400);
  app.state.rect = { canvas: c, pxPerMm: ppm };
  app.state.diffMap = null;
  te.setRectified(c, ppm);
  te.setCircles([]);
  te.setTrace([{ x: 20, y: 20 }, { x: 60, y: 20 }, { x: 60, y: 60 }, { x: 20, y: 60 }], []);

  const S = (x, y) => te._mmToScreen({ x, y });
  const key = list => list.map(v => `${v.loop}:${v.idx}`).sort().join(',');

  // A box over the top half of the square: corners 0 and 1, nothing else.
  const a = S(15, 15), b = S(65, 40);
  const topHalf = key(te._verticesInRect({ x0: a.x, y0: a.y, x1: b.x, y1: b.y }));

  // The same rect drawn in the opposite corner order resolves the same way.
  const reversed = key(te._verticesInRect({ x0: b.x, y0: b.y, x1: a.x, y1: a.y }));

  // A box over the whole square takes all four.
  const w0 = S(10, 10), w1 = S(70, 70);
  const all = key(te._verticesInRect({ x0: w0.x, y0: w0.y, x1: w1.x, y1: w1.y }));

  // Stray-click guard: a sub-3 px box leaves the selection alone.
  te.selectedVerts = [{ loop: -1, idx: 2 }];
  te._applyMarquee({ x0: a.x, y0: a.y, x1: a.x + 2, y1: a.y + 2 });
  const strayKept = key(te.selectedVerts);

  // A real box release replaces through the single writer.
  te._applyMarquee({ x0: a.x, y0: a.y, x1: b.x, y1: b.y });
  const applied = key(te.selectedVerts);
  const clearedSingle = te.selection === null;

  te.selectedVerts = [];
  te.selection = null;
  return { topHalf, reversed, all, strayKept, applied, clearedSingle };
});

console.log('\nPart A step 1 — rect resolver + the single selection writer');
check('_verticesInRect returns exactly the enclosed corners',
  selA.topHalf === '-1:0,-1:1', selA.topHalf || '(none)');
check('_verticesInRect ignores the drag corner order', selA.reversed === '-1:0,-1:1', selA.reversed);
check('_verticesInRect over the whole square takes all four corners',
  selA.all === '-1:0,-1:1,-1:2,-1:3', selA.all);
check('a sub-3 px marquee is a stray click and leaves the selection alone',
  selA.strayKept === '-1:2', selA.strayKept || '(cleared)');
check('_applySelection replace sets the multi-selection and clears the single one',
  selA.applied === '-1:0,-1:1' && selA.clearedSingle, `${selA.applied}, single=${selA.clearedSingle}`);

const selLasso = await page.evaluate(() => {
  const te = window.__app.traceEditor;
  const S = (x, y) => te._mmToScreen({ x, y });
  const path = mm => mm.map(([x, y]) => S(x, y));
  const key = list => list.map(v => `${v.loop}:${v.idx}`).sort().join(',');

  te.setTrace([{ x: 20, y: 20 }, { x: 60, y: 20 }, { x: 60, y: 60 }, { x: 20, y: 60 }], []);

  // A triangle over the top of the square catches corners 0 and 1 only.
  const tri = path([[5, 5], [75, 5], [40, 45]]);
  const triSel = key(te._verticesInPolygon(tri));

  // Under the area guard: a 2.8 x 2.8 px square sitting right on corner 0.
  const c0 = S(20, 20);
  const tiny = [
    { x: c0.x - 1.4, y: c0.y - 1.4 }, { x: c0.x + 1.4, y: c0.y - 1.4 },
    { x: c0.x + 1.4, y: c0.y + 1.4 }, { x: c0.x - 1.4, y: c0.y + 1.4 },
  ];
  const tinySel = key(te._verticesInPolygon(tiny));
  const tinyArea = Math.abs(te._pathAreaPx(tiny));
  const twoPtSel = key(te._verticesInPolygon([S(5, 5), S(75, 5)]));

  // Driving the gesture: a stray lasso leaves the selection alone, a real one
  // replaces it.
  te.selectedVerts = [{ loop: -1, idx: 2 }];
  te._lasso = tiny.slice();
  te._up();
  const strayKept = key(te.selectedVerts);
  te._lasso = tri.slice();
  te._up();
  const gestureSel = key(te.selectedVerts);
  const lassoCleared = te._lasso === null && te.dragging === false;

  // Concave: a C opening to the right, with vertex 2 sitting in its mouth.
  te.setTrace([
    { x: 20, y: 20 }, { x: 60, y: 20 }, { x: 60, y: 40 },
    { x: 60, y: 60 }, { x: 20, y: 60 },
  ], []);
  const cShape = path([
    [10, 10], [70, 10], [70, 30], [40, 30], [40, 50], [70, 50], [70, 70], [10, 70],
  ]);
  const cSel = key(te._verticesInPolygon(cShape));

  te.setTrace([{ x: 20, y: 20 }, { x: 60, y: 20 }, { x: 60, y: 60 }, { x: 20, y: 60 }], []);
  te.selectedVerts = [];
  te.selection = null;
  return { triSel, tinySel, tinyArea, twoPtSel, strayKept, gestureSel, lassoCleared, cSel };
});

console.log('\nPart A step 2 — lasso');
check('a triangle lasso takes the two corners it encloses',
  selLasso.triSel === '-1:0,-1:1', selLasso.triSel || '(none)');
check('a lasso under the ~9 px2 area guard resolves to nothing',
  selLasso.tinySel === '' && selLasso.tinyArea < 9, `area ${selLasso.tinyArea.toFixed(2)} px2, got "${selLasso.tinySel}"`);
check('a lasso with fewer than 3 points resolves to nothing', selLasso.twoPtSel === '');
check('a stray lasso release changes nothing', selLasso.strayKept === '-1:2', selLasso.strayKept);
check('a lasso release replaces the selection and ends the gesture',
  selLasso.gestureSel === '-1:0,-1:1' && selLasso.lassoCleared, selLasso.gestureSel);
check('a concave C lasso excludes the vertex in its mouth',
  selLasso.cSel === '-1:0,-1:1,-1:3,-1:4', selLasso.cSel || '(none)');

const selBrush = await page.evaluate(() => {
  const te = window.__app.traceEditor;
  const S = (x, y) => te._mmToScreen({ x, y });
  const key = list => list.map(v => `${v.loop}:${v.idx}`).sort().join(',');

  te.setTrace([{ x: 20, y: 20 }, { x: 60, y: 20 }, { x: 60, y: 60 }, { x: 20, y: 60 }], []);
  const defaultR = te.brushRadiusPx;

  // Two samples on the top edge's endpoints, a 3 px brush: the two corners it
  // touches, and neither of the bottom pair 40 mm away.
  const topEdge = key(te._verticesNearPath([S(20, 20), S(60, 20)], 3));

  // One sample, no drag: the circle select.
  const dot = key(te._verticesNearPath([S(20, 20)], 3));
  const dotEmpty = key(te._verticesNearPath([S(40, 40)], 3));

  // The segment test, not the sample test: a vertex mid-edge with the two
  // samples 100 px away on either side of it.
  te.setTrace([
    { x: 20, y: 20 }, { x: 40, y: 20 }, { x: 60, y: 20 },
    { x: 60, y: 60 }, { x: 20, y: 60 },
  ], []);
  const mid = S(40, 20);
  const farPath = [{ x: mid.x - 100, y: mid.y }, { x: mid.x + 100, y: mid.y }];
  const farSel = te._verticesNearPath(farPath, 3);
  const farKeys = key(farSel);
  const minSampleDist = Math.min(...farPath.map(p => Math.hypot(p.x - mid.x, p.y - mid.y)));
  const bottom = S(20, 60);
  const bottomFar = Math.abs(bottom.y - mid.y);

  // Driving the gesture: the release resolves at the editor's own radius.
  te.setTrace([{ x: 20, y: 20 }, { x: 60, y: 20 }, { x: 60, y: 60 }, { x: 20, y: 60 }], []);
  te.setBrushRadius(3);
  te.selectedVerts = [{ loop: -1, idx: 2 }];
  te._brush = [S(20, 20), S(60, 20)];
  te._up();
  const gestureSel = key(te.selectedVerts);
  const brushCleared = te._brush === null && te.dragging === false;

  te.setBrushRadius(1);
  const clampLo = te.brushRadiusPx;
  te.setBrushRadius(500);
  const clampHi = te.brushRadiusPx;
  te.setBrushRadius(12);

  te.selectedVerts = [];
  te.selection = null;
  return {
    defaultR, topEdge, dot, dotEmpty, farKeys, minSampleDist, bottomFar,
    gestureSel, brushCleared, clampLo, clampHi,
  };
});

console.log('\nPart A step 3 — radius brush');
check('brush radius defaults to 12 px and clamps to 4..60',
  selBrush.defaultR === 12 && selBrush.clampLo === 4 && selBrush.clampHi === 60,
  `${selBrush.defaultR}, ${selBrush.clampLo}, ${selBrush.clampHi}`);
check('a 2-sample brush along the top edge takes its endpoints, not the far corners',
  selBrush.topEdge === '-1:0,-1:1', selBrush.topEdge || '(none)');
check('a single-sample brush path is the circle select',
  selBrush.dot === '-1:0' && selBrush.dotEmpty === '', `${selBrush.dot} / "${selBrush.dotEmpty}"`);
check('the brush tests the segment, not the samples: a vertex 100 px from either sample is caught',
  selBrush.farKeys.split(',').includes('-1:1') && selBrush.minSampleDist > 3,
  `${selBrush.farKeys}, nearest sample ${selBrush.minSampleDist.toFixed(0)} px`);
check('the swept segment does not reach vertices off the line',
  !selBrush.farKeys.split(',').includes('-1:4') && selBrush.bottomFar > 3,
  `${selBrush.farKeys}, bottom row ${selBrush.bottomFar.toFixed(0)} px off`);
check('a brush release replaces the selection and ends the gesture',
  selBrush.gestureSel === '-1:0,-1:1' && selBrush.brushCleared, selBrush.gestureSel);

const selBox = await page.evaluate(() => {
  const te = window.__app.traceEditor;
  const S = (x, y) => te._mmToScreen({ x, y });
  const key = list => list.map(v => `${v.loop}:${v.idx}`).sort().join(',');
  const square = () => [{ x: 20, y: 20 }, { x: 60, y: 20 }, { x: 60, y: 60 }, { x: 20, y: 60 }];
  const hole = (cx, cy, d) => ({ cx, cy, d, type: 'through', side: 'top',
    csAngle: 90, csDia: 9, cbDia: 9, cbDepth: 3,
    edgeTop: { mode: 'none', size: 0.5 }, edgeBottom: { mode: 'none', size: 0.5 },
    screw: { std: 'custom', size: '', fit: 'clearance' } });

  te.setTrace(square(), []);
  te.setCircles([]);

  // Direction is the sign of x1 - x0 at release; vertical direction is ignored.
  const a = S(15, 15), b = S(65, 40);
  const dirWindow = te._rectIsCrossing({ x0: a.x, y0: b.y, x1: b.x, y1: a.y });
  const dirCross = te._rectIsCrossing({ x0: b.x, y0: a.y, x1: a.x, y1: b.y });

  // A live first-class fillet arc, which is what a crossing box expands to:
  // an L-corner with a blunt 3-point run, rounded by makeTangentSelection.
  te.setTrace([
    { x: 10, y: 60 }, { x: 40, y: 60 },
    { x: 54, y: 60 }, { x: 60, y: 56 }, { x: 60, y: 50 },
    { x: 60, y: 30 }, { x: 60, y: 10 },
    { x: 10, y: 10 },
  ], []);
  te.selectedVerts = [2, 3, 4].map(idx => ({ loop: -1, idx }));
  const made = te.makeTangentSelection();
  const run = key(te.selectedVerts);          // the arc's whole run, re-seeded for us
  const runIdx = te.selectedVerts.map(v => v.idx);
  const runLen = runIdx.length;
  const arcCount = te.arcs.length;

  // A 5 px box over one vertex in the middle of the run.
  const mp = te._mmToScreen(te.outer[runIdx[Math.floor(runLen / 2)]]);
  te._applyMarquee({ x0: mp.x - 2.5, y0: mp.y - 2.5, x1: mp.x + 2.5, y1: mp.y + 2.5 });
  const boxWindow = key(te.selectedVerts);
  const boxWindowLen = te.selectedVerts.length;
  te._applyMarquee({ x0: mp.x + 2.5, y0: mp.y - 2.5, x1: mp.x - 2.5, y1: mp.y + 2.5 });
  const boxCross = key(te.selectedVerts);

  // The other half of the crossing rule, isolated by passing an empty vertex
  // list: a box that holds no vertex of the run, but that the run's polyline
  // passes through, still takes the whole run.
  let gapD = -1, gapMid = { x: 0, y: 0 };
  for (let k = 0; k + 1 < runLen; k++) {
    const p = te._mmToScreen(te.outer[runIdx[k]]);
    const q = te._mmToScreen(te.outer[runIdx[k + 1]]);
    const d = Math.hypot(q.x - p.x, q.y - p.y);
    if (d > gapD) { gapD = d; gapMid = { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 }; }
  }
  const hw = Math.min(3, gapD / 3);
  const crossedRun = key(te._expandToArcRuns([], {
    x0: gapMid.x - hw, y0: gapMid.y - hw, x1: gapMid.x + hw, y1: gapMid.y + hw }));
  const missedRun = key(te._expandToArcRuns([], {
    x0: S(5, 5).x, y0: S(5, 5).y, x1: S(8, 8).x, y1: S(8, 8).y }));

  // A crossing band over a plain edge of the square expands nothing.
  te.setTrace(square(), []);
  const top = S(0, 0).y - 500, bot = S(0, 100).y + 500;
  const edgeX = S(40, 0).x;
  te.selectedVerts = [{ loop: -1, idx: 2 }];
  te._applyMarquee({ x0: edgeX + 1, y0: top, x1: edgeX - 1, y1: bot });
  const plainEdge = key(te.selectedVerts);
  const plainArcs = te.arcs.length;

  // Holes. The bore rim of a 10 mm hole at (40, 40) sits 5 mm from its centre.
  te.setCircles([hole(40, 40, 10)]);
  const rimPx = te._circleScreen(te.circles[0]).r;
  const c0 = S(30, 30), c1 = S(40, 40);
  te._applyMarquee({ x0: c0.x, y0: c0.y, x1: c1.x, y1: c1.y });
  const clipWindow = te.selectedCircles.join(',');
  te._applyMarquee({ x0: c1.x, y0: c0.y, x1: c0.x, y1: c1.y });
  const clipCross = te.selectedCircles.join(',');
  const w0 = S(30, 30), w1 = S(50, 50);
  te._applyMarquee({ x0: w0.x, y0: w0.y, x1: w1.x, y1: w1.y });
  const wholeWindow = te.selectedCircles.join(',');

  // Lasso takes a hole by its centre; the brush takes one by its rim.
  const lassoIn = te._circlesInGesture('lasso', [S(30, 30), S(50, 30), S(50, 50), S(30, 50)]).join(',');
  const lassoOut = te._circlesInGesture('lasso', [S(5, 5), S(15, 5), S(15, 15), S(5, 15)]).join(',');
  const brushRim = te._circlesInGesture('brush', { path: [S(45, 40)], r: 3 }).join(',');
  const brushFar = te._circlesInGesture('brush', { path: [S(20, 20)], r: 3 }).join(',');

  // Group move carries a selected hole's centre along with the vertices.
  te._clearMulti();
  te.selectedVerts = [{ loop: -1, idx: 0 }, { loop: -1, idx: 1 }];
  te.selectedCircles = [0];
  te._beginGroupDrag({ x: 0, y: 0 });
  te._moveGroupTo({ x: 5, y: 5 });
  te._groupDrag = null;
  te.dragging = false;
  const movedVert = { ...te.outer[0] };
  const movedHole = { cx: te.circles[0].cx, cy: te.circles[0].cy };

  // Delete takes the selected holes too.
  te.setTrace(square(), []);
  te.setCircles([hole(40, 40, 10), hole(70, 70, 6)]);
  te._clearMulti();
  te.selectedCircles = [0];
  te.deleteSelected();
  const leftCount = te.circles.length;
  const leftCx = te.circles.length ? te.circles[0].cx : null;
  const clearedAfterDelete = te._multiCount();

  te.setTrace(square(), []);
  te.setCircles([]);
  te._clearMulti();
  te.selection = null;
  return {
    dirWindow, dirCross, madeOk: !!made.ok, run, runLen, arcCount,
    boxWindow, boxWindowLen, boxCross, crossedRun, missedRun, gapD,
    plainEdge, plainArcs, rimPx,
    clipWindow, clipCross, wholeWindow,
    lassoIn, lassoOut, brushRim, brushFar,
    movedVert, movedHole, leftCount, leftCx, clearedAfterDelete,
  };
});

console.log('\nPart A step 4 — directional box, arc runs, holes in the selection');
check('the box direction is the sign of x1 - x0, read on release',
  selBox.dirWindow === false && selBox.dirCross === true,
  `window=${selBox.dirWindow}, crossing=${selBox.dirCross}`);
check('a right-to-left box over one vertex of a fillet run takes the whole run',
  selBox.madeOk && selBox.arcCount === 1 && selBox.boxCross === selBox.run,
  `${selBox.runLen}-vertex run, got ${selBox.boxCross}`);
check('the same box left-to-right takes only what it encloses',
  selBox.boxWindowLen > 0 && selBox.boxWindowLen < selBox.runLen &&
  selBox.boxWindow !== selBox.run,
  `${selBox.boxWindowLen} of ${selBox.runLen}`);
check('a crossing box crossed only by the run polyline still takes the whole run',
  selBox.crossedRun === selBox.run && selBox.missedRun === '',
  `crossed ${selBox.crossedRun} (widest gap ${selBox.gapD.toFixed(1)} px), missed "${selBox.missedRun}"`);
check('a crossing box touching only a plain edge selects nothing',
  selBox.plainEdge === '' && selBox.plainArcs === 0, `got "${selBox.plainEdge}"`);
check('a window box clipping a hole rim skips it, a crossing box takes it',
  selBox.rimPx > 5 && selBox.clipWindow === '' && selBox.clipCross === '0' && selBox.wholeWindow === '0',
  `rim ${selBox.rimPx.toFixed(1)} px, window "${selBox.clipWindow}", crossing "${selBox.clipCross}", enclosed "${selBox.wholeWindow}"`);
check('lasso takes a hole by its centre, the brush by its rim',
  selBox.lassoIn === '0' && selBox.lassoOut === '' &&
  selBox.brushRim === '0' && selBox.brushFar === '',
  `lasso "${selBox.lassoIn}"/"${selBox.lassoOut}", brush "${selBox.brushRim}"/"${selBox.brushFar}"`);
check('group move shifts a selected hole centre with the vertices',
  Math.abs(selBox.movedVert.x - 25) < 1e-6 && Math.abs(selBox.movedVert.y - 25) < 1e-6 &&
  Math.abs(selBox.movedHole.cx - 45) < 1e-6 && Math.abs(selBox.movedHole.cy - 45) < 1e-6,
  `vertex ${selBox.movedVert.x},${selBox.movedVert.y}; hole ${selBox.movedHole.cx},${selBox.movedHole.cy}`);
check('Delete removes the selected holes and clears the multi-selection',
  selBox.leftCount === 1 && selBox.leftCx === 70 && selBox.clearedAfterDelete === 0,
  `${selBox.leftCount} left, first at ${selBox.leftCx}`);

const selMod = await page.evaluate(() => {
  const te = window.__app.traceEditor;
  const S = (x, y) => te._mmToScreen({ x, y });
  const key = list => list.map(v => `${v.loop}:${v.idx}`).sort().join(',');
  const square = () => [{ x: 20, y: 20 }, { x: 60, y: 20 }, { x: 60, y: 60 }, { x: 20, y: 60 }];
  const topTri = () => [S(5, 5), S(75, 5), S(40, 45)];   // encloses corners 0 and 1
  const wholeSheet = () => [S(5, 5), S(75, 5), S(75, 75), S(5, 75)];

  te.setTrace(square(), []);
  te.setCircles([]);
  te._clearMulti();

  // The modifier map, the same for every sub-mode.
  const modes = [
    te._gestureSelectMode({}),
    te._gestureSelectMode({ shiftKey: true }),
    te._gestureSelectMode({ altKey: true }),
    te._gestureSelectMode({ altKey: true, shiftKey: true }),
  ].join(',');

  // Lasso replace, then brush add: the union.
  te._lasso = topTri();
  te._up();
  const afterLasso = key(te.selectedVerts);
  te.setBrushRadius(4);
  te._selectGestureMode = 'add';
  te._brush = [S(20, 60)];
  te._up();
  const afterAdd = key(te.selectedVerts);

  // Then Alt-lasso over the same two corners: the difference.
  te._selectGestureMode = 'subtract';
  te._lasso = topTri();
  te._up();
  const afterSub = key(te.selectedVerts);

  // Overlapping gestures never duplicate.
  te._lasso = wholeSheet();
  te._up();
  const allCount = te.selectedVerts.length;
  te._selectGestureMode = 'add';
  te._lasso = wholeSheet();
  te._up();
  const dupCount = te.selectedVerts.length;

  // The modifier is consumed at release, so the next gesture is a plain
  // replace even though the one before it added.
  te._lasso = topTri();
  te._up();
  const afterConsumed = key(te.selectedVerts);

  // Subtract takes holes out of the selection too.
  te.setCircles([{ cx: 40, cy: 40, d: 10, type: 'through', side: 'top',
    csAngle: 90, csDia: 9, cbDia: 9, cbDepth: 3,
    edgeTop: { mode: 'none', size: 0.5 }, edgeBottom: { mode: 'none', size: 0.5 },
    screw: { std: 'custom', size: '', fit: 'clearance' } }]);
  te._clearMulti();
  te._lasso = [S(30, 30), S(50, 30), S(50, 50), S(30, 50)];
  te._up();
  const holeIn = te.selectedCircles.join(',');
  te._selectGestureMode = 'subtract';
  te._lasso = [S(30, 30), S(50, 30), S(50, 50), S(30, 50)];
  te._up();
  const holeOut = te.selectedCircles.join(',');

  // Alt+click deletes a vertex in Edit mode, and is skipped in Select mode.
  te.setCircles([]);
  te._clearMulti();
  const cv = te.canvas;
  const capture = cv.setPointerCapture;
  cv.setPointerCapture = () => {};
  const box = cv.getBoundingClientRect();
  const ev = (sp, o) => Object.assign({
    pointerId: 1, button: 0, clientX: box.left + sp.x, clientY: box.top + sp.y,
    altKey: false, shiftKey: false, ctrlKey: false, metaKey: false,
  }, o || {});

  te.setTrace(square(), []);
  te.mode = 'edit';
  te._down(ev(S(20, 20), { altKey: true }));
  te._up();
  const editDeleted = te.outer.length;

  te.setTrace(square(), []);
  te.mode = 'select';
  te._down(ev(S(20, 20), { altKey: true }));
  te._up();
  const selectKept = te.outer.length;

  te.mode = 'edit';
  cv.setPointerCapture = capture;
  te.setTrace(square(), []);
  te.setCircles([]);
  te.setBrushRadius(12);
  te._clearMulti();
  te.selection = null;
  te._selectGestureMode = 'replace';
  return {
    modes, afterLasso, afterAdd, afterSub, allCount, dupCount, afterConsumed,
    holeIn, holeOut, editDeleted, selectKept,
  };
});

console.log('\nPart A step 5 — add and subtract modifiers');
check('drag replaces, Shift adds, Alt subtracts (Alt wins when both are down)',
  selMod.modes === 'replace,add,subtract,subtract', selMod.modes);
check('a lasso replace followed by a brush add is the union',
  selMod.afterLasso === '-1:0,-1:1' && selMod.afterAdd === '-1:0,-1:1,-1:3',
  `${selMod.afterLasso} then ${selMod.afterAdd}`);
check('an Alt lasso over the same corners leaves the difference',
  selMod.afterSub === '-1:3', selMod.afterSub || '(empty)');
check('overlapping gestures never duplicate a vertex',
  selMod.allCount === 4 && selMod.dupCount === 4,
  `${selMod.allCount} then ${selMod.dupCount}`);
check('the modifier is consumed at release, so the next gesture replaces',
  selMod.afterConsumed === '-1:0,-1:1', selMod.afterConsumed);
check('subtract takes holes out of the selection too',
  selMod.holeIn === '0' && selMod.holeOut === '', `"${selMod.holeIn}" then "${selMod.holeOut}"`);
check('Alt+click deletes a vertex in Edit mode and is skipped in Select mode',
  selMod.editDeleted === 3 && selMod.selectKept === 4,
  `edit ${selMod.editDeleted} pts, select ${selMod.selectKept} pts`);

const selUI = await page.evaluate(() => {
  const te = window.__app.traceEditor;
  const S = (x, y) => te._mmToScreen({ x, y });
  const key = list => list.map(v => `${v.loop}:${v.idx}`).sort().join(',');
  const square = () => [{ x: 20, y: 20 }, { x: 60, y: 20 }, { x: 60, y: 60 }, { x: 20, y: 60 }];
  const sub = s => document.querySelector(`#selSubRow [data-selsub="${s}"]`);
  const $$ = id => document.getElementById(id);

  te.setTrace(square(), []);
  te.setCircles([]);
  te._clearMulti();
  te.selection = null;

  // Drive the real pointer path. Capture is a no-op here because the events
  // are hand-built and carry no live pointer.
  const cv = te.canvas;
  const capture = cv.setPointerCapture;
  cv.setPointerCapture = () => {};
  const box = cv.getBoundingClientRect();
  const ev = (sp, o) => Object.assign({
    pointerId: 1, button: 0, clientX: box.left + sp.x, clientY: box.top + sp.y,
    altKey: false, shiftKey: false, ctrlKey: false, metaKey: false,
  }, o || {});
  const drag = (pts, o) => {
    te._down(ev(pts[0], o));
    for (let i = 1; i < pts.length; i++) te._move(ev(pts[i], o));
    te._up();
  };
  // A triangle over the top of the square: corners 0 and 1 only.
  const topTri = [S(5, 5), S(75, 5), S(40, 45)];

  // The toolbar gains one button, and it is the only way into the mode.
  const btn = document.querySelector('.tool-btn[data-tool="select"]');
  btn.click();
  const selMode = te.mode;
  const selActive = btn.classList.contains('active');
  const boxCursor = cv.style.cursor;

  // Sub-mode control: Brush hides the cursor (the ring is the cursor) and is
  // the only sub-mode that shows the radius slider.
  sub('brush').click();
  const brushSub = te.selectSubMode;
  const brushCursor = cv.style.cursor;
  const brushMarked = sub('brush').classList.contains('primary') &&
    !sub('box').classList.contains('primary');
  const radiusShown = !$$('brushRadiusField').hidden;
  const slider = $$('brushRadius');
  slider.value = '30';
  slider.dispatchEvent(new Event('input', { bubbles: true }));
  const radiusSet = te.brushRadiusPx;
  const radiusLabel = $$('brushRadiusVal').textContent;

  sub('lasso').click();
  const lassoSub = te.selectSubMode;
  const lassoCursor = cv.style.cursor;
  const radiusHidden = $$('brushRadiusField').hidden;

  // A plain drag in the Select tool selects, through the current sub-mode.
  drag(topTri);
  const plainDrag = key(te.selectedVerts);
  const countText = $$('selCount').textContent;
  const notPanning = te.panning === false;

  // Shift still adds and Alt still subtracts once the tool is active.
  drag([S(15, 55), S(65, 55), S(65, 75), S(15, 75)], { shiftKey: true });
  const shiftAdded = key(te.selectedVerts);
  drag(topTri, { altKey: true });
  const altRemoved = key(te.selectedVerts);

  // Back in Edit mode: a plain drag on empty space still pans and clears,
  // and Shift+drag selects with whatever sub-mode is current.
  document.querySelector('.tool-btn[data-tool="edit"]').click();
  const editMode = te.mode;
  te._clearMulti();
  te._down(ev(S(5, 5)));
  const editPans = te.panning === true;
  const editPlainSel = te.selectedVerts.length;
  te._up();
  drag(topTri, { shiftKey: true });
  const editShiftSel = key(te.selectedVerts);

  const hint = $$('selHint').textContent.replace(/\s+/g, ' ');

  // Leave the page as the blocks after this one expect to find it.
  sub('box').click();
  slider.value = '12';
  slider.dispatchEvent(new Event('input', { bubbles: true }));
  cv.setPointerCapture = capture;
  te.setTrace(square(), []);
  te.setCircles([]);
  te._clearMulti();
  te.selection = null;
  te._selectGestureMode = 'replace';
  te._notifySelect();
  const restored = `${te.mode}/${te.selectSubMode}/${te.brushRadiusPx}/${$$('selCount').textContent}`;
  return {
    selMode, selActive, boxCursor, brushSub, brushCursor, brushMarked,
    radiusShown, radiusSet, radiusLabel, lassoSub, lassoCursor, radiusHidden,
    plainDrag, countText, notPanning, shiftAdded, altRemoved,
    editMode, editPans, editPlainSel, editShiftSel, hint, restored,
  };
});

console.log('\nPart A step 6 — the Select tool, its sub-modes and the panel');
check('the toolbar Select button puts the editor in select mode',
  selUI.selMode === 'select' && selUI.selActive, `${selUI.selMode}, active=${selUI.selActive}`);
check('Box and Lasso use a crosshair, Brush hides the cursor for its ring',
  selUI.boxCursor === 'crosshair' && selUI.brushCursor === 'none' && selUI.lassoCursor === 'crosshair',
  `box "${selUI.boxCursor}", brush "${selUI.brushCursor}", lasso "${selUI.lassoCursor}"`);
check('the sub-mode buttons switch the editor sub-mode and mark the active one',
  selUI.brushSub === 'brush' && selUI.lassoSub === 'lasso' && selUI.brushMarked,
  `${selUI.brushSub} then ${selUI.lassoSub}, marked=${selUI.brushMarked}`);
check('the radius slider is shown only for Brush and sets the brush radius',
  selUI.radiusShown && selUI.radiusHidden && selUI.radiusSet === 30 && selUI.radiusLabel === '30 px',
  `shown=${selUI.radiusShown}, hidden after=${selUI.radiusHidden}, r=${selUI.radiusSet}, label "${selUI.radiusLabel}"`);
check('a plain drag in the Select tool resolves through the current sub-mode',
  selUI.plainDrag === '-1:0,-1:1' && selUI.notPanning, `${selUI.plainDrag || '(none)'}, panning=${!selUI.notPanning}`);
check('the selection count reads out both points and holes',
  selUI.countText === '2 points', `"${selUI.countText}"`);
check('Shift adds and Alt subtracts through the Select tool pointer path',
  selUI.shiftAdded === '-1:0,-1:1,-1:2,-1:3' && selUI.altRemoved === '-1:2,-1:3',
  `${selUI.shiftAdded} then ${selUI.altRemoved}`);
check('a plain drag on empty space still pans in Edit mode',
  selUI.editMode === 'edit' && selUI.editPans && selUI.editPlainSel === 0,
  `mode ${selUI.editMode}, panning=${selUI.editPans}, ${selUI.editPlainSel} selected`);
check('Shift+drag in Edit mode selects with the current sub-mode',
  selUI.editShiftSel === '-1:0,-1:1', selUI.editShiftSel || '(none)');
check('the Selection panel hint names the three shapes and the modifiers',
  /Box:/.test(selUI.hint) && /Lasso:/.test(selUI.hint) && /Brush:/.test(selUI.hint) &&
  /Shift adds, Alt removes, Escape clears/.test(selUI.hint), selUI.hint);
check('the step 6 block leaves the editor back in Edit mode with an empty selection',
  selUI.restored === 'edit/box/12/', selUI.restored);

const selAnchor = await page.evaluate(() => {
  const te = window.__app.traceEditor;
  const S = (x, y) => te._mmToScreen({ x, y });
  const square = () => [{ x: 20, y: 20 }, { x: 60, y: 20 }, { x: 60, y: 60 }, { x: 20, y: 60 }];
  const hole = (cx, cy, d) => ({ cx, cy, d, type: 'through', side: 'top',
    csAngle: 90, csDia: 9, cbDia: 9, cbDepth: 3,
    edgeTop: { mode: 'none', size: 0.5 }, edgeBottom: { mode: 'none', size: 0.5 },
    screw: { std: 'custom', size: '', fit: 'clearance' } });
  // Two holes 20 mm apart, centre distance constrained: dragging either one
  // should pin it under the cursor and move the other.
  const fixture = () => {
    te.setTrace(square(), []);
    te.setCircles([hole(30, 30, 8), hole(50, 30, 8)]);
    te.measurements = []; te.arcs = []; te.lines = [];
    te.constraints = [{ type: 'dist',
      refs: [{ kind: 'center', idx: 0 }, { kind: 'center', idx: 1 }], value: 20 }];
    te._clearMulti();
    te.selection = null;
  };
  const cv = te.canvas;
  const capture = cv.setPointerCapture;
  cv.setPointerCapture = () => {};
  const box = cv.getBoundingClientRect();
  const ev = sp => ({ pointerId: 1, button: 0, clientX: box.left + sp.x, clientY: box.top + sp.y,
    altKey: false, shiftKey: false, ctrlKey: false, metaKey: false });
  const anchorKey = () => te._dragAnchors()
    .map(a => a.kind === 'vert' ? `vert ${a.loop}:${a.idx}` : `${a.kind} ${a.idx}`).join(',');
  const drag = (from, to) => { te._down(ev(from)); te._move(ev(to)); te._up(); };

  // A group drag pressed on the hole: one outline vertex and the left hole.
  fixture();
  te.selectedVerts = [{ loop: -1, idx: 0 }];
  te.selectedCircles = [0];
  te._down(ev(S(30, 30)));
  const groupAnchors = anchorKey();
  te._move(ev(S(35, 30)));
  te._up();
  const groupHeld = te.circles[0].cx, groupOther = te.circles[1].cx;
  const groupVert = te.outer[0].x;

  // The same hole, same constraint, dragged on its own.
  fixture();
  te._down(ev(S(30, 30)));
  const singleAnchors = anchorKey();
  te._move(ev(S(35, 30)));
  te._up();
  const singleHeld = te.circles[0].cx, singleOther = te.circles[1].cx;

  // Holes only in the selection: the one under the cursor is still an anchor.
  fixture();
  te.selectedCircles = [0, 1];
  te.constraints = [{ type: 'dist',
    refs: [{ kind: 'center', idx: 0 }, { kind: 'vert', loop: -1, idx: 1 }], value: 30 }];
  drag(S(30, 30), S(35, 30));
  const holesOnlyHeld = te.circles[0].cx;
  const holesOnlyDist = Math.hypot(te.outer[1].x - te.circles[0].cx, te.outer[1].y - te.circles[0].cy);
  const holesOnlyCornerMoved = Math.abs(te.outer[1].x - 60) > 1e-3;

  cv.setPointerCapture = capture;
  te.setTrace(square(), []);
  te.setCircles([]);
  te.constraints = [];
  te._clearMulti();
  te.selection = null;
  return {
    groupAnchors, groupHeld, groupOther, groupVert,
    singleAnchors, singleHeld, singleOther,
    holesOnlyHeld, holesOnlyDist, holesOnlyCornerMoved,
  };
});

console.log('\nPart A step 4 — a dragged hole anchors the constraint solver');
check('a group drag anchors every selected hole, not just the vertices',
  selAnchor.groupAnchors === 'vert -1:0,center 0' && selAnchor.singleAnchors === 'center 0',
  `group "${selAnchor.groupAnchors}", single "${selAnchor.singleAnchors}"`);
check('a constrained hole group-dragged lands under the cursor, like a single drag',
  Math.abs(selAnchor.groupHeld - 35) < 1e-3 && Math.abs(selAnchor.groupOther - 55) < 1e-3 &&
  Math.abs(selAnchor.groupVert - 25) < 1e-3 &&
  Math.abs(selAnchor.singleHeld - 35) < 1e-3 && Math.abs(selAnchor.singleOther - 55) < 1e-3,
  `group held ${selAnchor.groupHeld.toFixed(3)} other ${selAnchor.groupOther.toFixed(3)} vertex ${selAnchor.groupVert.toFixed(3)}; ` +
  `single held ${selAnchor.singleHeld.toFixed(3)} other ${selAnchor.singleOther.toFixed(3)}`);
check('a holes-only group drag still pins the hole under the cursor',
  Math.abs(selAnchor.holesOnlyHeld - 35) < 1e-3 && selAnchor.holesOnlyCornerMoved &&
  Math.abs(selAnchor.holesOnlyDist - 30) < 1e-3,
  `held ${selAnchor.holesOnlyHeld.toFixed(3)}, corner moved ${selAnchor.holesOnlyCornerMoved}, ` +
  `distance ${selAnchor.holesOnlyDist.toFixed(3)}`);

const selWrap = await page.evaluate(() => {
  const te = window.__app.traceEditor;
  const S = (x, y) => te._mmToScreen({ x, y });
  const key = list => list.map(v => `${v.loop}:${v.idx}`).sort((a, b) => a.localeCompare(b)).join(',');
  // A rounded end, the gesture the lasso exists for: 16 points round a circle
  // with vertex 0 at the rightmost point, so a lasso over the right cap wraps
  // the index origin.
  const ring = () => {
    const pts = [];
    for (let k = 0; k < 16; k++) {
      const a = k * Math.PI / 8;
      pts.push({ x: 40 + 20 * Math.cos(a), y: 40 + 20 * Math.sin(a) });
    }
    return pts;
  };
  const fixture = () => {
    te.setTrace(ring(), []);
    te.setCircles([]);
    te.measurements = []; te.arcs = []; te.lines = []; te.constraints = [];
    te._clearMulti();
    te.selection = null;
  };

  fixture();
  const nBefore = te.outer.length;
  // Lasso the right cap.
  te._lasso = [S(54, 16), S(74, 16), S(74, 64), S(54, 64)];
  te._up();
  const capSel = key(te.selectedVerts);
  const capIdx = te.selectedVerts.map(v => v.idx).sort((a, b) => a - b);
  const wraps = capIdx.includes(0) && capIdx.includes(nBefore - 1) && capIdx.length < nBefore;
  const capRun = te.hasMultiRun(3);
  const capSpan = te._selectionSpan(3);
  const capArc = te.fitArcToSelection();
  const nAfterArc = te.outer.length;
  const capLine = te.fitLineToSelection();
  const nAfterLine = te.outer.length;
  const capStraight = te.straightenSelection();
  const capStraightOk = !!(capStraight && capStraight.ok);
  const nAfterStraight = te.outer.length;

  // The same count of points as a plain run, away from the origin: the tools
  // are still available and still act on that run alone.
  fixture();
  te.selectedVerts = capIdx.map((_, i) => ({ loop: -1, idx: 4 + i }));
  const runRun = te.hasMultiRun(3);
  const runArc = te.fitArcToSelection();
  const runKeepsEnds = te.outer[0].x === ring()[0].x && te.outer[0].y === ring()[0].y;

  fixture();
  return {
    nBefore, capSel, wraps, capRun, capSpan, capArc, nAfterArc,
    capLine, nAfterLine, capStraight, capStraightOk, nAfterStraight,
    runRun, runArc, runKeepsEnds,
  };
});

console.log('\nPart A step 2 — a lasso that wraps the index origin is not a run');
check('a lasso round a rounded end takes the cap and wraps vertex 0',
  selWrap.wraps && selWrap.nBefore === 16, `${selWrap.capSel} of ${selWrap.nBefore}`);
check('a wrapping selection reports no span, so the run tools stay disabled',
  selWrap.capRun === false && selWrap.capSpan === null,
  `hasMultiRun=${selWrap.capRun}, span=${JSON.stringify(selWrap.capSpan)}`);
check('Fit arc, Fit line and Straighten refuse it instead of rewriting the whole outline',
  selWrap.capArc === null && selWrap.capLine === false && selWrap.capStraightOk === false &&
  selWrap.nAfterArc === 16 && selWrap.nAfterLine === 16 && selWrap.nAfterStraight === 16,
  `arc ${selWrap.capArc}, line ${selWrap.capLine}, straighten ${JSON.stringify(selWrap.capStraight)}, ` +
  `outline ${selWrap.nBefore} -> ${selWrap.nAfterArc}/${selWrap.nAfterLine}/${selWrap.nAfterStraight}`);
check('the same number of points as a run away from the origin still fits an arc',
  selWrap.runRun === true && typeof selWrap.runArc === 'number' && selWrap.runKeepsEnds,
  `hasMultiRun=${selWrap.runRun}, radius ${selWrap.runArc}, vertex 0 untouched=${selWrap.runKeepsEnds}`);

const selRim = await page.evaluate(() => {
  const te = window.__app.traceEditor;
  const S = (x, y) => te._mmToScreen({ x, y });
  const square = () => [{ x: 20, y: 20 }, { x: 60, y: 20 }, { x: 60, y: 60 }, { x: 20, y: 60 }];
  const hole = (cx, cy, d) => ({ cx, cy, d, type: 'through', side: 'top',
    csAngle: 90, csDia: 9, cbDia: 9, cbDepth: 3,
    edgeTop: { mode: 'none', size: 0.5 }, edgeBottom: { mode: 'none', size: 0.5 },
    screw: { std: 'custom', size: '', fit: 'clearance' } });
  const cv = te.canvas;
  const capture = cv.setPointerCapture;
  cv.setPointerCapture = () => {};
  const box = cv.getBoundingClientRect();
  const ev = sp => ({ pointerId: 1, button: 0, clientX: box.left + sp.x, clientY: box.top + sp.y,
    altKey: false, shiftKey: false, ctrlKey: false, metaKey: false });
  const drag = (from, to) => { te._down(ev(from)); te._move(ev(to)); te._up(); };
  const fixture = multi => {
    te.setMode('edit');
    te.setTrace(square(), []);
    te.setCircles([hole(40, 40, 10)]);
    te.measurements = []; te.arcs = []; te.lines = []; te.constraints = [];
    te._clearMulti();
    te.selection = null;
    if (multi) { te.selectedVerts = [{ loop: -1, idx: 0 }]; te.selectedCircles = [0]; }
  };

  // The rim of a 10 mm hole at (40, 40) sits 5 mm out from its centre.
  const rimRegion = (fixture(false), te._hitCircle(S(45, 40)).region);

  fixture(false);
  drag(S(45, 40), S(50, 40));
  const aloneD = te.circles[0].d, aloneCx = te.circles[0].cx;

  // The same press with the hole in a multi-selection still resizes, and
  // leaves the co-selected vertex where it was.
  fixture(true);
  const multiRegion = te._hitCircle(S(45, 40)).region;
  drag(S(45, 40), S(50, 40));
  const multiD = te.circles[0].d, multiCx = te.circles[0].cx;
  const multiVert = te.outer[0].x;

  // Pressing the interior of the same hole is still the group handle.
  fixture(true);
  drag(S(40, 40), S(45, 40));
  const moveD = te.circles[0].d, moveCx = te.circles[0].cx;
  const moveVert = te.outer[0].x;

  cv.setPointerCapture = capture;
  te.setTrace(square(), []);
  te.setCircles([]);
  te._clearMulti();
  te.selection = null;
  return { rimRegion, multiRegion, aloneD, aloneCx, multiD, multiCx, multiVert,
    moveD, moveCx, moveVert };
});

console.log('\nPart A step 4 — the rim of a selected hole still resizes it');
check('a rim drag resizes the hole whether or not it is in a multi-selection',
  selRim.rimRegion === 'resize' && selRim.multiRegion === 'resize' &&
  Math.abs(selRim.aloneD - 20) < 1e-6 && Math.abs(selRim.multiD - 20) < 1e-6 &&
  Math.abs(selRim.multiCx - 40) < 1e-6 && Math.abs(selRim.multiVert - 20) < 1e-6,
  `alone d ${selRim.aloneD}, in a selection d ${selRim.multiD} at cx ${selRim.multiCx}, vertex ${selRim.multiVert}`);
check('pressing the interior of a selected hole still drags the whole group',
  Math.abs(selRim.moveD - 10) < 1e-6 && Math.abs(selRim.moveCx - 45) < 1e-6 &&
  Math.abs(selRim.moveVert - 25) < 1e-6,
  `d ${selRim.moveD}, hole at ${selRim.moveCx}, vertex ${selRim.moveVert}`);

const selStale = await page.evaluate(() => {
  const te = window.__app.traceEditor;
  const S = (x, y) => te._mmToScreen({ x, y });
  const square = () => [{ x: 20, y: 20 }, { x: 60, y: 20 }, { x: 60, y: 60 }, { x: 20, y: 60 }];
  const hole = (cx, cy, d) => ({ cx, cy, d, type: 'through', side: 'top',
    csAngle: 90, csDia: 9, cbDia: 9, cbDepth: 3,
    edgeTop: { mode: 'none', size: 0.5 }, edgeBottom: { mode: 'none', size: 0.5 },
    screw: { std: 'custom', size: '', fit: 'clearance' } });
  const cv = te.canvas;
  const capture = cv.setPointerCapture;
  cv.setPointerCapture = () => {};
  const box = cv.getBoundingClientRect();
  const ev = (sp, o) => Object.assign({ pointerId: 1, button: 0,
    clientX: box.left + sp.x, clientY: box.top + sp.y,
    altKey: false, shiftKey: false, ctrlKey: false, metaKey: false }, o || {});
  const cxs = () => te.circles.map(c => c.cx).join(',');
  const fixture = () => {
    te.setMode('edit');
    te.setTrace(square(), []);
    te.setCircles([hole(25, 30, 8), hole(40, 30, 8), hole(55, 30, 8)]);
    te.measurements = []; te.arcs = []; te.lines = []; te.constraints = [];
    te._clearMulti();
    te.selection = null;
  };
  // A window box round the right hole alone, then a right-click delete of the
  // left one, which renumbers everything above it.
  const selectRight = () => {
    const a = S(48, 23), b = S(62, 37);
    te._applyMarquee({ x0: a.x, y0: a.y, x1: b.x, y1: b.y });
  };

  fixture();
  selectRight();
  const picked = te.selectedCircles.join(',');
  te._down(ev(S(25, 30), { button: 2 }));   // right-click delete of the left hole
  te._up();
  const afterDelete = cxs();
  const stillSelected = te.selectedCircles.join(',');
  const count = te._multiCount();
  const marked = te.circles.map((c, i) => te._circleInMulti(i) ? c.cx : null).join(',');
  te.deleteSelected();
  const afterGroupDelete = cxs();

  // Deleting the selected hole itself drops it from the selection.
  fixture();
  selectRight();
  te._down(ev(S(55, 30), { button: 2 }));
  te._up();
  const selfCount = te._multiCount();
  const selfLeft = cxs();

  cv.setPointerCapture = capture;
  te.setTrace(square(), []);
  te.setCircles([]);
  te._clearMulti();
  te.selection = null;
  return { picked, afterDelete, stillSelected, count, marked, afterGroupDelete,
    selfCount, selfLeft };
});

console.log('\nPart A step 4 — deleting a hole renumbers the hole selection');
check('a hole selection follows its hole when a lower-indexed hole is deleted',
  selStale.picked === '2' && selStale.afterDelete === '40,55' &&
  selStale.stillSelected === '1' && selStale.count === 1 && selStale.marked === ',55',
  `picked ${selStale.picked}, holes ${selStale.afterDelete}, selection ${selStale.stillSelected}, highlighted ${selStale.marked}`);
check('Delete then removes the hole that is actually selected',
  selStale.afterGroupDelete === '40', selStale.afterGroupDelete);
check('deleting the selected hole itself empties the selection',
  selStale.selfCount === 0 && selStale.selfLeft === '25,40',
  `${selStale.selfCount} selected, holes ${selStale.selfLeft}`);

const selDraw = await page.evaluate(() => {
  const te = window.__app.traceEditor;
  const square = () => [{ x: 20, y: 20 }, { x: 60, y: 20 }, { x: 60, y: 60 }, { x: 20, y: 60 }];
  const proto = CanvasRenderingContext2D.prototype;
  const realArc = proto.arc;
  let radii = [];
  proto.arc = function (x, y, r, a0, a1, ccw) { radii.push(r); return realArc.call(this, x, y, r, a0, a1, ccw); };
  // VERT_R is 4.5, so a selected handle is 6.5 and a plain one 4.5.
  const shot = () => {
    radii = [];
    te.draw();
    return `${radii.filter(r => Math.abs(r - 6.5) < 1e-6).length}/` +
           `${radii.filter(r => Math.abs(r - 4.5) < 1e-6).length}`;
  };

  te.setMode('edit');
  te.setTrace(square(), []);
  te.setCircles([]);
  te.measurements = []; te.arcs = []; te.lines = []; te.constraints = [];
  te._clearMulti();
  te.selection = null;
  te.showPoints = true;
  te.selectedVerts = [{ loop: -1, idx: 0 }, { loop: -1, idx: 1 }];

  const edit = shot();
  te.setMode('select');
  te.setSelectSubMode('box');
  const selBox = shot();
  te.setSelectSubMode('lasso');
  const selLasso = shot();
  te.setSelectSubMode('brush');
  const selBrush = shot();

  // Mid-gesture, while a lasso is being drawn, the points are still there to
  // aim at: the same handles are painted under the lasso overlay.
  te.setSelectSubMode('lasso');
  const S = (x, y) => te._mmToScreen({ x, y });
  te._beginSelectGesture(S(10, 10), 'replace');
  te._lasso.push({ x: S(70, 10).x, y: S(70, 10).y }, { x: S(70, 70).x, y: S(70, 70).y });
  const midGesture = shot();
  te._lasso = null;
  te.dragging = false;

  // Hiding the handles still hides them, and a mode that does not edit points
  // (region) still draws none.
  te.showPoints = false;
  const hidden = shot();
  te.showPoints = true;
  te.setMode('region');
  const region = shot();

  proto.arc = realArc;
  te.setMode('edit');
  te.setSelectSubMode('box');
  te._clearMulti();
  te.selection = null;
  te.setTrace(square(), []);
  return { edit, selBox, selLasso, selBrush, midGesture, hidden, region };
});

console.log('\nPart A step 6 — the Select tool draws the handles it selects');
check('the Select tool paints the vertex handles in every sub-mode',
  selDraw.selBox === '2/2' && selDraw.selLasso === '2/2' && selDraw.selBrush === '2/2',
  `box ${selDraw.selBox}, lasso ${selDraw.selLasso}, brush ${selDraw.selBrush} (selected/plain)`);
check('one selection renders the same in the Select tool as in Edit',
  selDraw.edit === selDraw.selBox, `edit ${selDraw.edit}, select ${selDraw.selBox}`);
check('the handles are on screen during the gesture, not only after release',
  selDraw.midGesture === '2/2', selDraw.midGesture);
check('hiding the points, and a mode that does not edit points, still draw none',
  selDraw.hidden === '0/0' && selDraw.region === '0/0',
  `hidden ${selDraw.hidden}, region ${selDraw.region}`);

const selCtrl = await page.evaluate(() => {
  const te = window.__app.traceEditor;
  const S = (x, y) => te._mmToScreen({ x, y });
  const square = () => [{ x: 20, y: 20 }, { x: 60, y: 20 }, { x: 60, y: 60 }, { x: 20, y: 60 }];
  const holeLoop = () => [{ x: 30, y: 30 }, { x: 45, y: 30 }, { x: 45, y: 45 }, { x: 30, y: 45 }];
  const hole = (cx, cy, d) => ({ cx, cy, d, type: 'through', side: 'top',
    csAngle: 90, csDia: 9, cbDia: 9, cbDepth: 3,
    edgeTop: { mode: 'none', size: 0.5 }, edgeBottom: { mode: 'none', size: 0.5 },
    screw: { std: 'custom', size: '', fit: 'clearance' } });
  const cv = te.canvas;
  const capture = cv.setPointerCapture;
  cv.setPointerCapture = () => {};
  const box = cv.getBoundingClientRect();
  const ev = (sp, mod) => ({ pointerId: 1, button: 0, clientX: box.left + sp.x, clientY: box.top + sp.y,
    altKey: false, shiftKey: false, ctrlKey: !!(mod && mod.ctrl), metaKey: !!(mod && mod.meta) });
  const key = list => list.map(v => `${v.loop}:${v.idx}`).sort().join(',');
  const fixture = (mode, holes, circles) => {
    te.setMode(mode);
    te.setSelectSubMode('box');
    te.setTrace(square(), holes || []);
    te.setCircles(circles || []);
    te.measurements = []; te.arcs = []; te.lines = []; te.constraints = [];
    te._clearMulti();
    te.selection = null;
  };
  const ctrlDrag = (from, to, mod) => { te._down(ev(from, mod)); te._move(ev(to, mod)); te._up(); };

  // The midpoint of the top edge: 20 mm from either corner, so no vertex is
  // within the 8 px hit radius but the edge is right under the cursor.
  fixture('select');
  ctrlDrag(S(40, 20), S(40, 32), { ctrl: true });
  const edgeCount = te.outer.length, edgeMoved = te.outer.some(p => Math.abs(p.y - 32) < 1e-6);

  // Cmd behaves like Ctrl, and a press with no drag at all must not insert.
  fixture('select');
  te._down(ev(S(40, 20), { meta: true }));
  const metaDragging = te.dragging;
  te._up();
  const metaCount = te.outer.length;

  // The documented binding still works: Ctrl on a vertex toggles it.
  fixture('select');
  te._down(ev(S(20, 20), { ctrl: true }));
  te._up();
  const toggled = key(te.selectedVerts), toggleCount = te.outer.length;

  // Inside a traced hole loop, and on a drilled hole's rim.
  fixture('select', [holeLoop()]);
  ctrlDrag(S(37, 37), S(47, 47), { ctrl: true });
  const holeX = te.holes[0][0].x;

  fixture('select', [], [hole(40, 40, 10)]);
  ctrlDrag(S(45, 40), S(52, 40), { ctrl: true });
  const rimD = te.circles[0].d;

  // Edit mode keeps its meaning: the same Ctrl+drag on the edge still inserts.
  fixture('edit');
  ctrlDrag(S(40, 20), S(40, 32), { ctrl: true });
  const editCount = te.outer.length;

  cv.setPointerCapture = capture;
  fixture('edit');
  return { edgeCount, edgeMoved, metaDragging, metaCount, toggled, toggleCount,
    holeX, rimD, editCount };
});

console.log('\nPart A step 6 — Ctrl/Cmd+click in the Select tool never edits geometry');
check('a Ctrl+drag that misses every vertex inserts nothing into the outline',
  selCtrl.edgeCount === 4 && selCtrl.edgeMoved === false,
  `${selCtrl.edgeCount} points, moved=${selCtrl.edgeMoved}`);
check('a Cmd press with no drag inserts nothing either',
  selCtrl.metaCount === 4 && selCtrl.metaDragging === false,
  `${selCtrl.metaCount} points, dragging=${selCtrl.metaDragging}`);
check('Ctrl+click on a vertex still toggles it in the Select tool',
  selCtrl.toggled === '-1:0' && selCtrl.toggleCount === 4,
  `${selCtrl.toggled || '(none)'}, ${selCtrl.toggleCount} points`);
check('a missed Ctrl+click neither drags a traced hole nor resizes a drilled one',
  Math.abs(selCtrl.holeX - 30) < 1e-6 && Math.abs(selCtrl.rimD - 10) < 1e-6,
  `hole at ${selCtrl.holeX}, bore ⌀${selCtrl.rimD}`);
check('Edit mode keeps the edge insert that Ctrl+drag has there today',
  selCtrl.editCount === 5, `${selCtrl.editCount} points`);

const selWhole = await page.evaluate(() => {
  const te = window.__app.traceEditor;
  const ring = (n, r) => Array.from({ length: n }, (_, i) => {
    const a = (i / n) * Math.PI * 2;
    return { x: 40 + r * Math.cos(a), y: 40 + r * Math.sin(a) };
  });
  const fixture = n => {
    te.setMode('edit');
    te.setTrace(ring(n, 20), []);
    te.setCircles([]);
    te.measurements = []; te.arcs = []; te.lines = []; te.constraints = [];
    te._clearMulti();
    te.selection = null;
  };
  const selectAll = () => {
    te.selectedVerts = te.outer.map((_, i) => ({ loop: -1, idx: i }));
  };

  // A box round the entire trace: every vertex of the one loop, no gap.
  fixture(16);
  selectAll();
  const allRun2 = te.hasMultiRun(2), allRun3 = te.hasMultiRun(3);
  const span = te._selectionSpan(2);
  const spanKey = span ? `${span.lo}..${span.hi}` : null;
  const densified = te.densifySelection();
  const afterDensify = te.outer.length;

  fixture(16);
  selectAll();
  const v0 = { ...te.outer[0] };
  const reduced = te.simplifySelection(2);
  const afterReduce = te.outer.length;
  const keptEnd = Math.abs(te.outer[0].x - v0.x) < 1e-9 && Math.abs(te.outer[0].y - v0.y) < 1e-9;

  // A selection that really does wrap the index origin still reports no run:
  // it holds vertex 0 and vertex n-1 but has a gap in the middle.
  fixture(16);
  te.selectedVerts = [0, 1, 14, 15].map(i => ({ loop: -1, idx: i }));
  const wrapRun = te.hasMultiRun(2);
  const wrapDensified = te.densifySelection();
  const afterWrap = te.outer.length;

  fixture(16);
  return { allRun2, allRun3, spanKey, densified, afterDensify,
    reduced, afterReduce, keptEnd, wrapRun, wrapDensified, afterWrap };
});

console.log('\nPart A step 2 — a selection of the whole loop is still one run');
check('every vertex of one loop reports a run, so Densify and Reduce stay live',
  selWhole.allRun2 === true && selWhole.allRun3 === true && selWhole.spanKey === '0..15',
  `run2=${selWhole.allRun2}, run3=${selWhole.allRun3}, span ${selWhole.spanKey}`);
check('Densify over a box round the whole outline adds a midpoint per edge',
  selWhole.densified === true && selWhole.afterDensify === 31,
  `${selWhole.densified}, 16 -> ${selWhole.afterDensify}`);
check('Reduce over the whole outline thins it and keeps the end points',
  selWhole.reduced === true && selWhole.afterReduce < 16 && selWhole.afterReduce >= 2 &&
  selWhole.keptEnd, `${selWhole.reduced}, 16 -> ${selWhole.afterReduce}, ends kept=${selWhole.keptEnd}`);
check('a selection with a gap round the index origin is still not a run',
  selWhole.wrapRun === false && selWhole.wrapDensified === false && selWhole.afterWrap === 16,
  `run=${selWhole.wrapRun}, densify=${selWhole.wrapDensified}, ${selWhole.afterWrap} points`);

const selRecess = await page.evaluate(() => {
  const te = window.__app.traceEditor;
  const S = (x, y) => te._mmToScreen({ x, y });
  const square = () => [{ x: 5, y: 5 }, { x: 75, y: 5 }, { x: 75, y: 75 }, { x: 5, y: 75 }];
  const hole = (cx, cy, d, extra) => Object.assign({ cx, cy, d, type: 'through', side: 'top',
    csAngle: 90, csDia: 9, cbDia: 9, cbDepth: 3,
    edgeTop: { mode: 'none', size: 0.5 }, edgeBottom: { mode: 'none', size: 0.5 },
    screw: { std: 'custom', size: '', fit: 'clearance' } }, extra || {});
  const fixture = c => {
    te.setMode('edit');
    te.setTrace(square(), []);
    te.setCircles([c]);
    te.measurements = []; te.arcs = []; te.lines = []; te.constraints = [];
    te._clearMulti();
    te.selection = null;
  };
  const box = (x0, y0, x1, y1) => {
    const a = S(x0, y0), b = S(x1, y1);
    te._applyMarquee({ x0: a.x, y0: a.y, x1: b.x, y1: b.y });
    return te.selectedCircles.join(',');
  };

  // A counterbored M3-style hole: a 5 mm bore inside a 20 mm counterbore, so
  // the hole is drawn 20 mm across and _hitCircle picks up that outer ring.
  fixture(hole(40, 40, 5, { type: 'cb', cbDia: 20 }));
  const maxDia = te._holeMaxDia(te.circles[0]);
  const scr = te._circleScreen(te.circles[0]);
  const outerRatio = scr.rOuter / scr.r;
  const ringRegion = te._hitCircle(S(50, 40)).region;

  // A window box that stays inside the counterbore and encloses only the bore
  // does not enclose the hole the user sees, so it must not take it.
  const boreWindow = box(36, 36, 44, 44);
  // Left to right round the whole 20 mm ring does enclose it.
  const wholeWindow = box(28, 28, 52, 52);
  // A right-to-left band across the visible ring at x = 50, well clear of the
  // bore, cuts a rim the user can see.
  const ringCross = box(52, 35, 48, 45);
  // The same band left to right encloses nothing, so it takes nothing.
  const ringWindow = box(48, 35, 52, 45);
  // The bore rim is still a rim: a crossing box over it keeps working.
  const boreCross = box(44, 36, 36, 44);
  // A brush stroke painted along the visible ring picks the hole up.
  const brushRing = te._circlesInGesture('brush',
    { path: [S(50, 35), S(50, 45)], r: 3 }).join(',');
  // A stroke in the empty annulus between bore and ring reaches neither rim.
  const brushGap = te._circlesInGesture('brush',
    { path: [S(45, 40)], r: 3 }).join(',');

  // A plain through hole with a 2 mm top chamfer is drawn 9 mm across.
  fixture(hole(40, 40, 5, { edgeTop: { mode: 'chamfer', size: 2 } }));
  const chamferMax = te._holeMaxDia(te.circles[0]);
  const chamferWindow = box(36, 36, 44, 44);
  const chamferWhole = box(33, 33, 47, 47);

  // A plain through hole is unchanged: bore and outer ring are the same circle.
  fixture(hole(40, 40, 10));
  const plainSame = te._circleScreen(te.circles[0]).rOuter === te._circleScreen(te.circles[0]).r;
  const plainWindow = box(33, 33, 47, 47);
  const plainClip = box(30, 30, 40, 40);

  te.setTrace(square(), []);
  te.setCircles([]);
  te._clearMulti();
  te.selection = null;
  return { maxDia, outerRatio, ringRegion, boreWindow, wholeWindow, ringCross,
    ringWindow, boreCross, brushRing, brushGap,
    chamferMax, chamferWindow, chamferWhole, plainSame, plainWindow, plainClip };
});

console.log('\nPart A step 4 — a gesture measures the hole that is drawn, not the bore alone');
check('a window box inside the counterbore does not take the hole it clips',
  selRecess.maxDia === 20 && Math.abs(selRecess.outerRatio - 4) < 1e-9 &&
  selRecess.ringRegion === 'resize' && selRecess.boreWindow === '' &&
  selRecess.wholeWindow === '0',
  `⌀${selRecess.maxDia} drawn, bore window "${selRecess.boreWindow}", whole "${selRecess.wholeWindow}"`);
check('a crossing box across the drawn recess ring takes the hole',
  selRecess.ringCross === '0' && selRecess.ringWindow === '' && selRecess.boreCross === '0',
  `ring crossing "${selRecess.ringCross}", ring window "${selRecess.ringWindow}", bore crossing "${selRecess.boreCross}"`);
check('the brush takes a hole by its drawn rim, not only by its bore',
  selRecess.brushRing === '0' && selRecess.brushGap === '',
  `on the ring "${selRecess.brushRing}", in the annulus "${selRecess.brushGap}"`);
check('a chamfered through hole is measured over its chamfer',
  selRecess.chamferMax === 9 && selRecess.chamferWindow === '' && selRecess.chamferWhole === '0',
  `⌀${selRecess.chamferMax} drawn, bore window "${selRecess.chamferWindow}", whole "${selRecess.chamferWhole}"`);
check('a plain through hole is unaffected: bore and drawn rim are one circle',
  selRecess.plainSame && selRecess.plainWindow === '0' && selRecess.plainClip === '',
  `same=${selRecess.plainSame}, enclosed "${selRecess.plainWindow}", clipped "${selRecess.plainClip}"`);

const selGroupMove = await page.evaluate(() => {
  const te = window.__app.traceEditor;
  const S = (x, y) => te._mmToScreen({ x, y });
  const square = () => [{ x: 20, y: 20 }, { x: 60, y: 20 }, { x: 60, y: 60 }, { x: 20, y: 60 }];
  const hole = (cx, cy, d) => ({ cx, cy, d, type: 'through', side: 'top',
    csAngle: 90, csDia: 9, cbDia: 9, cbDepth: 3,
    edgeTop: { mode: 'none', size: 0.5 }, edgeBottom: { mode: 'none', size: 0.5 },
    screw: { std: 'custom', size: '', fit: 'clearance' } });
  const cv = te.canvas;
  const capture = cv.setPointerCapture;
  cv.setPointerCapture = () => {};
  const box = cv.getBoundingClientRect();
  const ev = (sp, mod) => ({ pointerId: 1, button: 0,
    clientX: box.left + sp.x, clientY: box.top + sp.y,
    altKey: !!(mod && mod.alt), shiftKey: !!(mod && mod.shift),
    ctrlKey: false, metaKey: false });
  const drag = (from, to, mod) => { te._down(ev(from, mod)); te._move(ev(to, mod)); te._up(); };
  const fixture = sub => {
    te.setMode('select');
    te.setSelectSubMode(sub || 'box');
    te.setTrace(square(), []);
    te.setCircles([hole(40, 40, 10)]);
    te.measurements = []; te.arcs = []; te.lines = []; te.constraints = [];
    te.showPoints = true;
    te._clearMulti();
    te.selection = null;
    te.selectedVerts = [{ loop: -1, idx: 0 }, { loop: -1, idx: 1 }];
    te.selectedCircles = [0];
  };
  const shot = () => ({ v0: te.outer[0].x, v1: te.outer[1].x,
    cx: te.circles[0].cx, n: te._multiCount() });

  // The panel hint and the README both say a drag on a selected point moves
  // the group. That has to hold in the Select tool, not only in Edit mode.
  fixture('box');
  drag(S(20, 20), S(25, 25));
  const vertDrag = shot();

  // The interior of a selected hole is a group handle in the Select tool too.
  fixture('box');
  drag(S(40, 40), S(45, 45));
  const holeDrag = shot();
  te.undo();
  const undone = shot();

  // Brush is the sub-mode that would otherwise wipe the selection on a press
  // with no drag at all.
  fixture('brush');
  drag(S(20, 20), S(25, 25));
  const brushDrag = shot();

  // Empty space still starts a gesture, and a box round nothing replaces the
  // selection with nothing.
  fixture('box');
  drag(S(70, 70), S(75, 75));
  const emptyDrag = shot();

  // A press on a selected point that misses the multi-selection is a gesture:
  // Shift adds and Alt subtracts, and neither moves the geometry.
  fixture('box');
  drag(S(20, 20), S(25, 25), { shift: true });
  const shiftDrag = shot();
  fixture('box');
  drag(S(20, 20), S(25, 25), { alt: true });
  const altDrag = shot();

  // The hole's rim keeps meaning resize in Edit mode, and in the Select tool
  // a rim press is a gesture rather than a group move or a resize.
  fixture('box');
  drag(S(45, 40), S(50, 40));
  const rimDrag = { d: te.circles[0].d, cx: te.circles[0].cx };

  cv.setPointerCapture = capture;
  te.setMode('edit');
  te.setTrace(square(), []);
  te.setCircles([]);
  te._clearMulti();
  te.selection = null;
  return { vertDrag, holeDrag, undone, brushDrag, emptyDrag, shiftDrag, altDrag, rimDrag };
});

console.log('\nPart A step 6 — the Select tool keeps group move');
check('dragging a selected point in the Select tool moves the group, not the selection',
  Math.abs(selGroupMove.vertDrag.v0 - 25) < 1e-6 &&
  Math.abs(selGroupMove.vertDrag.v1 - 65) < 1e-6 &&
  Math.abs(selGroupMove.vertDrag.cx - 45) < 1e-6 && selGroupMove.vertDrag.n === 3,
  `v0 ${selGroupMove.vertDrag.v0}, v1 ${selGroupMove.vertDrag.v1}, hole ${selGroupMove.vertDrag.cx}, ${selGroupMove.vertDrag.n} selected`);
check('dragging a selected hole in the Select tool moves the group, and undo restores it',
  Math.abs(selGroupMove.holeDrag.cx - 45) < 1e-6 &&
  Math.abs(selGroupMove.holeDrag.v0 - 25) < 1e-6 && selGroupMove.holeDrag.n === 3 &&
  Math.abs(selGroupMove.undone.cx - 40) < 1e-6 && Math.abs(selGroupMove.undone.v0 - 20) < 1e-6,
  `moved to ${selGroupMove.holeDrag.cx}/${selGroupMove.holeDrag.v0}, undone ${selGroupMove.undone.cx}/${selGroupMove.undone.v0}`);
check('the Brush sub-mode moves the group too instead of painting over it',
  Math.abs(selGroupMove.brushDrag.v0 - 25) < 1e-6 &&
  Math.abs(selGroupMove.brushDrag.cx - 45) < 1e-6 && selGroupMove.brushDrag.n === 3,
  `v0 ${selGroupMove.brushDrag.v0}, hole ${selGroupMove.brushDrag.cx}, ${selGroupMove.brushDrag.n} selected`);
check('a drag that starts on empty space still selects and moves nothing',
  Math.abs(selGroupMove.emptyDrag.v0 - 20) < 1e-6 &&
  Math.abs(selGroupMove.emptyDrag.cx - 40) < 1e-6 && selGroupMove.emptyDrag.n === 0,
  `v0 ${selGroupMove.emptyDrag.v0}, hole ${selGroupMove.emptyDrag.cx}, ${selGroupMove.emptyDrag.n} selected`);
check('Shift and Alt on a selected point stay the add and subtract modifiers',
  Math.abs(selGroupMove.shiftDrag.v0 - 20) < 1e-6 && selGroupMove.shiftDrag.n === 3 &&
  Math.abs(selGroupMove.altDrag.v0 - 20) < 1e-6 && selGroupMove.altDrag.n === 2,
  `shift v0 ${selGroupMove.shiftDrag.v0} (${selGroupMove.shiftDrag.n} selected), alt v0 ${selGroupMove.altDrag.v0} (${selGroupMove.altDrag.n} selected)`);
check('a press on a selected hole rim in the Select tool neither resizes nor moves it',
  Math.abs(selGroupMove.rimDrag.d - 10) < 1e-6 && Math.abs(selGroupMove.rimDrag.cx - 40) < 1e-6,
  `⌀${selGroupMove.rimDrag.d} at ${selGroupMove.rimDrag.cx}`);

// ---------- 10c. Labelling step 6: drag and rotate a placed label ----------

const labelPlace = await page.evaluate(async () => {
  const app = window.__app, st = app.state, ed = app.layoutEditor;
  const $ = id => document.getElementById(id);
  const rect = (w, h) => [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }];
  // Everything this block borrows goes back at the end.
  const before = {
    step: st.step,
    items: st.layout.items,
    labels: structuredClone(st.layout.labels),
    sel: ed.sel,
  };
  app.goStep(4);
  await new Promise(r => setTimeout(r, 250));
  st.layout.items = [
    { name: '13 mm', outer: rect(50, 16), holes: [], circles: [], thickness: 5, depth: null, rot: 0, x: 60, y: 45 },
    { name: 'pliers', label: 'LINESMAN', outer: rect(40, 30), holes: [], circles: [], thickness: 5, depth: null, rot: 0, x: 150, y: 100 },
  ];
  Object.assign(st.layout.labels, {
    enabled: true, height: 6, margin: 2, follow: false, process: 'laser', extra: [],
  });
  ed.sel = -1; ed.selLabel = -1; ed.bedSel = false;
  app.refreshLayoutEditor();

  const cv = ed.canvas, r = cv.getBoundingClientRect();
  const client = mm => {
    const s = ed.mmToScreen(mm);
    return { x: r.left + s.x * (r.width / cv.width), y: r.top + s.y * (r.height / cv.height) };
  };
  const cap = cv.setPointerCapture, rel = cv.releasePointerCapture;
  cv.setPointerCapture = () => {}; cv.releasePointerCapture = () => {};
  const ev = (type, p, shift) => cv.dispatchEvent(new PointerEvent(type, {
    clientX: p.x, clientY: p.y, pointerId: 1, shiftKey: !!shift, bubbles: true,
  }));
  const drag = (from, to, shift) => {
    ev('pointerdown', client(from), shift);
    const kind = ed._drag && ed._drag.kind;
    ev('pointermove', client(to), shift);
    ev('pointerup', client(to), shift);
    return kind;
  };
  const at = i => {
    const L = ed.labels[i];
    return L ? { x: L.at.x, y: L.at.y, rot: L.rot, auto: L.auto, text: L.text, src: L.src,
      w: L.bounds.maxX - L.bounds.minX, h: L.bounds.maxY - L.bounds.minY } : null;
  };

  // Auto-placement is the starting point: centred under each pocket.
  const auto = { n: ed.labels.length, a: at(0), b: at(1) };

  // Drag the first label up and to the left, well clear of every pocket.
  const moveKind = drag({ x: auto.a.x, y: auto.a.y }, { x: 40, y: 20 });
  const moved = { a: at(0), labelAt: structuredClone(st.layout.items[0].labelAt),
    sel: ed.sel, selLabel: ed.selLabel, panel: !$('laySelPanel').hidden,
    // Read straight after the gesture, with no hand-run resync: the Auto
    // button is what undoes the drag, so it has to be live the moment there
    // is something to undo.
    autoLive: !$('laySelLabelAuto').disabled };

  // A rebuild recomputes every pocket from scratch: manual position wins.
  app.refreshLayoutEditor();
  const rebuilt = at(0);

  // A re-layout that moves and turns the tool carries the label with it by
  // the offset the user chose, instead of snapping back under the pocket.
  st.layout.items[0].x += 30;
  st.layout.items[0].rot = 25;
  st.layout.clearance = 1.5;
  app.refreshLayoutEditor();
  const relaid = at(0);
  st.layout.items[0].x -= 30;
  st.layout.items[0].rot = 0;
  st.layout.clearance = 0.5;
  app.refreshLayoutEditor();

  // The round handle below the label turns it. Dragging from straight below
  // the anchor round to due right of it is a quarter turn anticlockwise.
  const anchor = at(0);
  const hnd = { x: anchor.x, y: anchor.y + 6 * 0.75 + 3 };
  const rotKind = drag(hnd, { x: anchor.x + 12, y: anchor.y });
  const turned = { a: at(0), labelRot: st.layout.items[0].labelRot };

  // Shift snaps the turn to 15°, as it does in the trace editor.
  const h2 = ed._labelHandle(ed.labels[0]);
  drag(h2, { x: anchor.x + 11, y: anchor.y + 4 }, true);
  const snapped = st.layout.items[0].labelRot;

  // The follow flag still applies: the label rides round with its tool and
  // the hand-made turn rides on top of that.
  st.layout.items[0].labelRot = -90;
  st.layout.labels.follow = true;
  st.layout.items[0].rot = 40;
  app.refreshLayoutEditor();
  const followed = { rot: ed.labels[0].rot, autoRot: ed.labels[0].autoRot, manual: ed.labels[0].manualRot };
  st.layout.labels.follow = false;
  st.layout.items[0].rot = 0;
  app.refreshLayoutEditor();

  // A hand-placed label that lands on another tool's pocket is reported, not
  // moved: the same geometry the exporters read drives the readout.
  drag({ x: ed.labels[0].at.x, y: ed.labels[0].at.y }, { x: 150, y: 100 });
  const clash = { text: $('layLabelInfo').textContent, cls: $('layLabelInfo').className };

  // Auto-place puts it back, and the button is dead until there is something
  // to put back.
  app.syncLaySelPanel(0);
  const resetLive = !$('laySelLabelAuto').disabled;
  $('laySelLabelAuto').click();
  const reset = { a: at(0), labelAt: st.layout.items[0].labelAt,
    labelRot: st.layout.items[0].labelRot, dead: $('laySelLabelAuto').disabled };

  // A free-floating drawer label drags and turns the same way, writing into
  // the layout's own label array.
  st.layout.labels.extra = [{ text: 'TOP DRAWER', x: 60, y: 130, height: 8, rot: 0,
    font: 'bold sans-serif', mirror: false }];
  ed.sel = -1; ed.selLabel = -1;
  app.refreshLayoutEditor();
  const extraIdx = ed.labels.length - 1;
  const extraSrc = ed.labels[extraIdx].src;
  drag({ x: 60, y: 130 }, { x: 100, y: 132 });
  const extraMoved = structuredClone(st.layout.labels.extra[0]);
  const eh = ed._labelHandle(ed.labels[extraIdx]);
  drag(eh, { x: st.layout.labels.extra[0].x + 14, y: st.layout.labels.extra[0].y });
  const extraTurned = st.layout.labels.extra[0].rot;

  // A label's box is the box of the whole string, so it is routinely wider
  // than the pocket it names and, on a layered build, sits right on top of
  // it. The tool underneath still takes the press: dragging is the only way
  // to move a tool, so a label that wins it strands the tool for good.
  st.layout.labels.extra = [];
  const constrBefore = st.layout.construction;
  const contBefore = structuredClone(st.layout.container);
  // A Gridfinity container is a printed bin whatever the select says, so the
  // base-label case needs a plain rectangular drawer under it.
  st.layout.container = { ...st.layout.container, type: 'rect', w: 220, h: 140, r: 6 };
  st.layout.construction = 'layered';
  st.layout.labels.onBase = true;
  st.layout.items = [
    { name: 'TORX T25 DRIVER', outer: rect(20, 8), holes: [], circles: [], thickness: 5, depth: null, rot: 0, x: 60, y: 45 },
  ];
  ed.sel = -1; ed.selLabel = -1;
  app.refreshLayoutEditor();
  const cover = { inside: !!ed.labels[0].inside, box: { ...ed.labels[0].bounds } };
  // The label really is in the way: its box holds the point pressed below.
  cover.covers = ed._hitLabel({ x: 60, y: 45 }) === 0;
  cover.kind = drag({ x: 60, y: 45 }, { x: 100, y: 80 });
  cover.item = { x: st.layout.items[0].x, y: st.layout.items[0].y };
  cover.auto = ed.labels[0].auto;

  // ...and the label must still be reachable by its own glyphs. A base label is
  // auto-placed at its pocket centroid, so if the box test were the only way in
  // it could never be pressed at all and step 6 would be dead for the very
  // construction base labels exist for. A glyph is a sliver of the pocket, so
  // the tool keeps every other point of itself.
  st.layout.items = [
    { name: 'TORX T25 DRIVER', outer: rect(20, 8), holes: [], circles: [], thickness: 5, depth: null, rot: 0, x: 60, y: 45 },
  ];
  ed.sel = -1; ed.selLabel = -1;
  app.refreshLayoutEditor();
  const glyph = { pt: null };
  const gb = ed.labels[0].bounds;
  for (let gx = 0; gx <= 200 && !glyph.pt; gx++) {
    for (let gy = 0; gy <= 40; gy++) {
      const p = { x: gb.minX + (gb.maxX - gb.minX) * gx / 200, y: gb.minY + (gb.maxY - gb.minY) * gy / 40 };
      if (ed._hitLabelGlyphs(p) === 0) { glyph.pt = p; break; }
    }
  }
  glyph.found = !!glyph.pt;
  glyph.kind = glyph.pt ? drag(glyph.pt, { x: glyph.pt.x + 16, y: glyph.pt.y + 12 }) : 'none';
  glyph.labelAt = st.layout.items[0].labelAt ? { ...st.layout.items[0].labelAt } : null;
  glyph.toolAt = { x: st.layout.items[0].x, y: st.layout.items[0].y };

  // Same rule in a plain pocket build, where a long label lies across the NEXT
  // tool along: pressing that tool moves that tool, and does not quietly pin
  // its neighbour's label to a manual position behind the user's back.
  st.layout.construction = 'pocket';
  st.layout.items = [
    { name: 'ADJUSTABLE', outer: rect(40, 12), holes: [], circles: [], thickness: 5, depth: null, rot: 0, x: 80, y: 40 },
    { name: 'B', outer: rect(50, 20), holes: [], circles: [], thickness: 5, depth: null, rot: 0, x: 80, y: 58 },
  ];
  ed.sel = -1; ed.selLabel = -1;
  app.refreshLayoutEditor();
  const band = { ...ed.labels[0].bounds };
  const neighbour = { band, onB: band.minX < 80 && band.maxX > 80 && band.minY > 48 && band.maxY < 68 };
  neighbour.kind = drag({ x: 80, y: 52 }, { x: 110, y: 52 });
  neighbour.b = { x: st.layout.items[1].x, y: st.layout.items[1].y };
  neighbour.aLabelAt = st.layout.items[0].labelAt;
  neighbour.sel = ed.sel;

  // A tap on a label is not a drag. Pens and touchscreens emit a pointermove
  // on essentially every tap, and a label that recorded one would leave
  // auto-placement with nothing on screen moving to say so.
  st.layout.items = [
    { name: '13 mm', outer: rect(50, 16), holes: [], circles: [], thickness: 5, depth: null, rot: 0, x: 60, y: 45 },
  ];
  ed.sel = -1; ed.selLabel = -1;
  app.refreshLayoutEditor();
  const tapPt = client({ x: ed.labels[0].at.x, y: ed.labels[0].at.y });
  ev('pointerdown', tapPt); ev('pointermove', tapPt); ev('pointerup', tapPt);
  const tap = { labelAt: st.layout.items[0].labelAt, auto: ed.labels[0].auto,
    sel: ed.sel, selLabel: ed.selLabel, dead: $('laySelLabelAuto').disabled };

  // Labels ride along live while a tool is dragged, and that has to cost a
  // pointermove's worth of work: eight labelled tools, ten moves. Re-tracing
  // every glyph per move put this in the seconds per move.
  st.layout.items = Array.from({ length: 8 }, (_, i) => ({
    name: '13 mm', outer: rect(50, 16), holes: [], circles: [], thickness: 5,
    depth: null, rot: 0, x: 60 + (i % 2) * 80, y: 30 + Math.floor(i / 2) * 40,
  }));
  ed.sel = -1; ed.selLabel = -1;
  app.refreshLayoutEditor();
  ev('pointerdown', client({ x: 60, y: 30 }));
  const live = { kind: ed._drag && ed._drag.kind, n: ed.labels.length };
  const t0 = performance.now();
  for (let i = 1; i <= 10; i++) ev('pointermove', client({ x: 60 + i, y: 30 + i }));
  live.perMove = (performance.now() - t0) / 10;
  live.at = { x: ed.labels[0].at.x, y: ed.labels[0].at.y };
  ev('pointerup', client({ x: 70, y: 40 }));
  live.item = { x: st.layout.items[0].x, y: st.layout.items[0].y };

  // Put the page back: no items, no labels, nothing selected, same step.
  cv.setPointerCapture = cap; cv.releasePointerCapture = rel;
  st.layout.construction = constrBefore;
  st.layout.container = contBefore;
  st.layout.items = before.items;
  st.layout.labels = before.labels;
  ed.sel = -1; ed.selLabel = -1; ed.bedSel = false;
  app.syncLaySelPanel(-1);
  app.refreshLayoutEditor();
  const cleared = { labels: ed.labels.length, items: st.layout.items.length,
    enabled: st.layout.labels.enabled, readout: $('layLabelInfo').textContent };
  app.goStep(before.step);
  await new Promise(r => setTimeout(r, 150));
  return { glyph, auto, moveKind, moved, rebuilt, relaid, rotKind, turned, snapped, followed,
    clash, resetLive, reset, extraIdx, extraSrc, extraMoved, extraTurned, cleared,
    cover, neighbour, tap, live, step: st.step, stepBefore: before.step };
});

console.log('\nLabelling step 6 — drag and rotate a placed label');
check('auto-placement seeds one label per tool, centred under its pocket',
  labelPlace.auto.n === 2 && labelPlace.auto.a.auto === true && labelPlace.auto.b.auto === true &&
  labelPlace.auto.a.text === '13 mm' && labelPlace.auto.b.text === 'LINESMAN' &&
  near(labelPlace.auto.a.x, 60, 0.2) && near(labelPlace.auto.a.y, 58.5, 0.6) &&
  near(labelPlace.auto.b.x, 150, 0.2) && near(labelPlace.auto.b.y, 120.5, 0.6),
  `${labelPlace.auto.n} labels, a ${JSON.stringify(labelPlace.auto.a)}`);
check('dragging a label moves it, selects its tool, and stores a manual position',
  labelPlace.moveKind === 'labelMove' && near(labelPlace.moved.a.x, 40, 1.5) &&
  near(labelPlace.moved.a.y, 20, 1.5) && labelPlace.moved.a.auto === false &&
  near(labelPlace.moved.labelAt.dx, -20, 1.5) && near(labelPlace.moved.labelAt.dy, -25, 1.5) &&
  labelPlace.moved.sel === 0 && labelPlace.moved.selLabel === 0 && labelPlace.moved.panel,
  `kind ${labelPlace.moveKind}, at ${JSON.stringify(labelPlace.moved.a)}, ` +
  `offset ${JSON.stringify(labelPlace.moved.labelAt)}, tool ${labelPlace.moved.sel}`);
check('the moved label survives a rebuild of the layout',
  near(labelPlace.rebuilt.x, labelPlace.moved.a.x, 1e-6) &&
  near(labelPlace.rebuilt.y, labelPlace.moved.a.y, 1e-6) && labelPlace.rebuilt.auto === false,
  `${JSON.stringify(labelPlace.rebuilt)} vs ${JSON.stringify(labelPlace.moved.a)}`);
check('manual position survives a re-layout, riding with the tool it names',
  near(labelPlace.relaid.x, labelPlace.moved.a.x + 30, 1e-6) &&
  near(labelPlace.relaid.y, labelPlace.moved.a.y, 1e-6),
  `${JSON.stringify(labelPlace.relaid)} from ${JSON.stringify(labelPlace.moved.a)}`);
check('the round handle turns a placed label a quarter turn, glyphs and all',
  labelPlace.rotKind === 'labelRotate' && near(labelPlace.turned.labelRot, -90, 2) &&
  near(labelPlace.turned.a.rot, -90, 2) &&
  labelPlace.auto.a.w > labelPlace.auto.a.h && labelPlace.turned.a.h > labelPlace.turned.a.w,
  `kind ${labelPlace.rotKind}, ${labelPlace.turned.labelRot}°, ` +
  `box ${labelPlace.turned.a.w.toFixed(1)} × ${labelPlace.turned.a.h.toFixed(1)} mm`);
check('Shift snaps a label rotation to 15° steps',
  Number.isFinite(labelPlace.snapped) && labelPlace.snapped % 15 === 0 &&
  labelPlace.snapped !== labelPlace.turned.labelRot,
  `${labelPlace.snapped}°`);
check('with follow on, the hand-made turn rides on top of the tool’s rotation',
  labelPlace.followed.autoRot === 40 && labelPlace.followed.manual === -90 &&
  near(labelPlace.followed.rot, -50, 1e-6),
  JSON.stringify(labelPlace.followed));
check('a hand-placed label over another pocket is reported, not moved back',
  labelPlace.clash.cls === 'warn' && /overlapping a pocket/.test(labelPlace.clash.text),
  `"${labelPlace.clash.text}"`);
check('Auto-place drops the manual position and turn and goes live only when needed',
  labelPlace.resetLive && labelPlace.reset.dead && labelPlace.reset.labelAt === undefined &&
  labelPlace.reset.labelRot === undefined && labelPlace.reset.a.auto === true &&
  near(labelPlace.reset.a.x, 60, 0.2) && near(labelPlace.reset.a.y, 58.5, 0.6) &&
  labelPlace.reset.a.rot === 0,
  `live ${labelPlace.resetLive}, back to ${JSON.stringify(labelPlace.reset.a)}`);
check('a free-floating drawer label drags and turns into the layout’s own array',
  labelPlace.extraSrc === 'layout' && near(labelPlace.extraMoved.x, 100, 1.5) &&
  near(labelPlace.extraMoved.y, 132, 1.5) && near(labelPlace.extraTurned, -90, 2),
  `moved to ${labelPlace.extraMoved.x.toFixed(1)}, ${labelPlace.extraMoved.y.toFixed(1)}, ` +
  `turned ${labelPlace.extraTurned}°`);
check('a label covering its own tool on a layered build still leaves the tool draggable',
  labelPlace.cover.inside && labelPlace.cover.covers && labelPlace.cover.kind === 'move' &&
  near(labelPlace.cover.item.x, 100, 1.5) && near(labelPlace.cover.item.y, 80, 1.5) &&
  labelPlace.cover.auto === true,
  `kind ${labelPlace.cover.kind}, tool at ${labelPlace.cover.item.x.toFixed(1)}, ` +
  `${labelPlace.cover.item.y.toFixed(1)}, inside ${labelPlace.cover.inside}, ` +
  `covers ${labelPlace.cover.covers}, auto ${labelPlace.cover.auto}, box ` +
  `${labelPlace.cover.box.minX.toFixed(1)}..${labelPlace.cover.box.maxX.toFixed(1)} x ` +
  `${labelPlace.cover.box.minY.toFixed(1)}..${labelPlace.cover.box.maxY.toFixed(1)}`);
check('a base label inside its own pocket is still grabbable by its glyphs',
  labelPlace.glyph.found && labelPlace.glyph.kind === 'labelMove' && labelPlace.glyph.labelAt &&
  labelPlace.glyph.toolAt.x === 60 && labelPlace.glyph.toolAt.y === 45,
  `found ${labelPlace.glyph.found}, kind ${labelPlace.glyph.kind}, ` +
  `labelAt ${JSON.stringify(labelPlace.glyph.labelAt)}, ` +
  `tool still at ${labelPlace.glyph.toolAt.x}, ${labelPlace.glyph.toolAt.y}`);
check('a neighbour’s label lying across a tool does not steal that tool’s press',
  labelPlace.neighbour.onB && labelPlace.neighbour.kind === 'move' &&
  near(labelPlace.neighbour.b.x, 110, 1.5) && near(labelPlace.neighbour.b.y, 58, 1e-6) &&
  labelPlace.neighbour.aLabelAt === undefined && labelPlace.neighbour.sel === 1,
  `kind ${labelPlace.neighbour.kind}, B at ${labelPlace.neighbour.b.x.toFixed(1)}, ` +
  `A label ${JSON.stringify(labelPlace.neighbour.aLabelAt)}, sel ${labelPlace.neighbour.sel}`);
check('a tap on a label selects its tool without pinning the label off auto-placement',
  labelPlace.tap.labelAt === undefined && labelPlace.tap.auto === true &&
  labelPlace.tap.sel === 0 && labelPlace.tap.dead,
  `labelAt ${JSON.stringify(labelPlace.tap.labelAt)}, auto ${labelPlace.tap.auto}, ` +
  `sel ${labelPlace.tap.sel}, Auto dead ${labelPlace.tap.dead}`);
check('Auto goes live the moment a drag gives it something to undo',
  labelPlace.moved.autoLive, `live ${labelPlace.moved.autoLive}`);
check('dragging a tool with eight labels on keeps the labels live and the move cheap',
  labelPlace.live.kind === 'move' && labelPlace.live.n === 8 &&
  labelPlace.live.perMove < 150 && near(labelPlace.live.at.x, 70, 1.5) &&
  near(labelPlace.live.item.x, 70, 1.5) && near(labelPlace.live.item.y, 40, 1.5),
  `${labelPlace.live.n} labels, ${labelPlace.live.perMove.toFixed(1)} ms per pointermove, ` +
  `label at ${labelPlace.live.at.x.toFixed(1)}, tool at ${labelPlace.live.item.x.toFixed(1)}`);
check('the block leaves an unlabelled, empty layout behind',
  labelPlace.cleared.labels === 0 && labelPlace.cleared.items === 0 &&
  labelPlace.cleared.enabled === false && labelPlace.cleared.readout === '' &&
  labelPlace.step === labelPlace.stepBefore,
  `${labelPlace.cleared.labels} labels, ${labelPlace.cleared.items} items, ` +
  `step ${labelPlace.step} (was ${labelPlace.stepBefore})`);

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

// ---------------------------------------------------------------- measure + constraints
const mc = await page.evaluate(async () => {
  const M = await import('/js/measure.js');
  const C = await import('/js/constraints.js');
  const out = {};

  // -- measurement math --
  out.ang = M.angleBetweenDeg({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 5, y: 0 }, { x: 5, y: 8 });
  out.gap = M.lineGap({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 5 }, { x: 10, y: 5 });
  out.psd = M.pointSegDist({ x: 5, y: 3 }, { x: 0, y: 0 }, { x: 10, y: 0 }).d;
  const loopA = [{ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 40, y: 30 }, { x: 0, y: 30 }];
  out.stats = M.loopStats(loopA);

  // measureInfo end-to-end through refs
  const circles = [{ cx: 10, cy: 10, d: 6 }];
  const geo = { loop: l => l === -1 ? loopA : null, circle: i => circles[i] || null };
  out.p2p = M.measureInfo({ type: 'p2p', refs: [
    { kind: 'vert', loop: -1, idx: 0 }, { kind: 'vert', loop: -1, idx: 2 }] }, geo);
  out.rad = M.measureInfo({ type: 'rad', refs: [{ kind: 'circle', idx: 0 }] }, geo);
  out.e2e = M.measureInfo({ type: 'e2e', refs: [
    { kind: 'edge', loop: -1, idx: 0 }, { kind: 'edge', loop: -1, idx: 2 }] }, geo);

  // -- ref remapping --
  const items = [
    { type: 'p2p', refs: [{ kind: 'vert', loop: -1, idx: 1 }, { kind: 'vert', loop: -1, idx: 3 }] },
    { type: 'elen', refs: [{ kind: 'edge', loop: -1, idx: 2 }] },
    { type: 'rad', refs: [{ kind: 'circle', idx: 0 }] },
  ];
  // Insert a vertex at position 1: later indices shift up, circle untouched.
  const ins = M.remapRefs(items, { op: 'splice', loop: -1, lo: 1, removed: 0, added: 1 }, 4);
  out.insIdx = [ins[0].refs[0].idx, ins[0].refs[1].idx, ins[1].refs[0].idx];
  // Delete vertex 1: the p2p that used it drops, the edge behind it shifts.
  const del = M.remapRefs(items, { op: 'splice', loop: -1, lo: 1, removed: 1, added: 0 }, 4);
  out.delKept = del.map(i => i.type);
  out.delEdge = del.find(i => i.type === 'elen').refs[0].idx;
  // clearLoops keeps only circle-based items.
  out.cleared = M.remapRefs(items, { op: 'clearLoops' }).map(i => i.type);

  // -- solver: skewed quad + H/V/len + anchor -> exact rectangle --
  const quad = [{ x: 0, y: 0 }, { x: 10, y: 0.8 }, { x: 10.5, y: 6 }, { x: -0.4, y: 5.6 }];
  const geoQ = { loop: l => l === -1 ? quad : null, circle: () => null };
  const cons = [
    { type: 'anchor', refs: [{ kind: 'vert', loop: -1, idx: 0 }] },
    { type: 'h', refs: [{ kind: 'edge', loop: -1, idx: 0 }] },
    { type: 'v', refs: [{ kind: 'edge', loop: -1, idx: 1 }] },
    { type: 'h', refs: [{ kind: 'edge', loop: -1, idx: 2 }] },
    { type: 'v', refs: [{ kind: 'edge', loop: -1, idx: 3 }] },
    { type: 'len', refs: [{ kind: 'edge', loop: -1, idx: 0 }], value: 20 },
  ];
  const res = C.solveConstraints(geoQ, cons, {});
  out.solved = { converged: res.converged, quad: quad.map(p => ({ x: +p.x.toFixed(4), y: +p.y.toFixed(4) })) };

  // -- solver: perpendicular between two free edges --
  const quad2 = [{ x: 0, y: 0 }, { x: 10, y: 1 }, { x: 11, y: 8 }, { x: 1, y: 9 }];
  const geoP = { loop: l => l === -1 ? quad2 : null, circle: () => null };
  const resP = C.solveConstraints(geoP, [
    { type: 'perp', refs: [{ kind: 'edge', loop: -1, idx: 0 }, { kind: 'edge', loop: -1, idx: 1 }] },
  ], {});
  out.perpAngle = M.angleBetweenDeg(quad2[0], quad2[1], quad2[1], quad2[2]);
  out.perpConverged = resP.converged;

  // -- solver: concentric circles --
  const circs = [{ cx: 0, cy: 0, d: 5 }, { cx: 4, cy: 2, d: 9 }];
  const geoC = { loop: () => null, circle: i => circs[i] || null };
  C.solveConstraints(geoC, [
    { type: 'conc', refs: [{ kind: 'circle', idx: 0 }, { kind: 'circle', idx: 1 }] },
  ], {});
  out.conc = { dx: Math.abs(circs[0].cx - circs[1].cx), dy: Math.abs(circs[0].cy - circs[1].cy) };

  // -- solver: fixed distance hole-to-edge (locate a hole off a datum) --
  const base = [{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 50, y: 30 }, { x: 0, y: 30 }];
  const holeC = [{ cx: 10, cy: 7, d: 5 }];
  const geoD = { loop: l => l === -1 ? base : null, circle: i => holeC[i] || null };
  const resD = C.solveConstraints(geoD, [
    { type: 'anchor', refs: [{ kind: 'vert', loop: -1, idx: 0 }] },
    { type: 'anchor', refs: [{ kind: 'vert', loop: -1, idx: 1 }] },
    { type: 'dist', refs: [{ kind: 'center', idx: 0 }, { kind: 'edge', loop: -1, idx: 0 }], value: 12 },
  ], {});
  out.holeDist = Math.abs(holeC[0].cy - 12); // edge 0 is the y=0 line
  out.holeDistConverged = resD.converged;

  return out;
});

console.log('\nMeasurement math');
check('angle between perpendicular segments = 90°', near(mc.ang, 90, 1e-9), `${mc.ang}`);
check('face-to-face gap of parallel edges = 5 mm', near(mc.gap, 5, 1e-9), `${mc.gap}`);
check('point→segment distance = 3 mm', near(mc.psd, 3, 1e-9), `${mc.psd}`);
check('loop stats 40×30: bbox + perimeter + area',
  mc.stats && near(mc.stats.bbox.w, 40, 1e-9) && near(mc.stats.bbox.h, 30, 1e-9) &&
  near(mc.stats.perimeter, 140, 1e-9) && near(mc.stats.area, 1200, 1e-9),
  mc.stats ? `${mc.stats.bbox.w}×${mc.stats.bbox.h}, per ${mc.stats.perimeter}, area ${mc.stats.area}` : 'null');
check('p2p via refs: diagonal 50 mm with Δ40/Δ30',
  mc.p2p && near(mc.p2p.d, 50, 1e-9) && near(mc.p2p.dx, 40, 1e-9) && near(mc.p2p.dy, 30, 1e-9),
  mc.p2p ? `${mc.p2p.d}` : 'null');
check('radius via circle ref = 3 mm', mc.rad && near(mc.rad.r, 3, 1e-9), mc.rad ? `${mc.rad.r}` : 'null');
check('e2e on opposite rectangle edges: parallel + 30 mm gap',
  mc.e2e && mc.e2e.gap !== null && near(mc.e2e.gap, 30, 1e-9),
  mc.e2e ? `angle ${mc.e2e.angle}, gap ${mc.e2e.gap}` : 'null');

console.log('\nRef remapping');
check('insert shifts later vert/edge refs up', String(mc.insIdx) === '2,4,3', String(mc.insIdx));
check('delete drops the measurement using the vertex, keeps the rest',
  String(mc.delKept) === 'elen,rad' && mc.delEdge === 1, `kept ${mc.delKept}, edge -> ${mc.delEdge}`);
check('clearLoops keeps circle-based items only', String(mc.cleared) === 'rad', String(mc.cleared));

console.log('\nConstraint solver');
{
  const q = mc.solved.quad;
  const rectOk = near(q[0].x, 0, 1e-3) && near(q[0].y, 0, 1e-3) &&
    near(q[1].y, q[0].y, 1e-3) && near(q[2].x, q[1].x, 1e-3) &&
    near(q[3].y, q[2].y, 1e-3) && near(q[0].x, q[3].x, 1e-3) &&
    near(Math.hypot(q[1].x - q[0].x, q[1].y - q[0].y), 20, 1e-2);
  check('H/V/len/anchor squares a skewed quad into a 20-wide rectangle',
    mc.solved.converged && rectOk, JSON.stringify(q));
}
check('perpendicular constraint reaches 90°',
  mc.perpConverged && near(mc.perpAngle, 90, 0.05), `${mc.perpAngle.toFixed(3)}°`);
check('concentric merges circle centres',
  mc.conc.dx < 1e-3 && mc.conc.dy < 1e-3, `Δ ${mc.conc.dx}, ${mc.conc.dy}`);
check('hole located 12 mm off an anchored edge',
  mc.holeDistConverged && mc.holeDist < 1e-2, `err ${mc.holeDist}`);

// ---------------------------------------------------------------- measure/constrain UI pipeline
const ui = await page.evaluate(() => {
  const ed = window.__app.traceEditor;
  // Fresh synthetic session: 40×30 rectangle + one 5 mm hole on a blank backdrop.
  const c = document.createElement('canvas');
  c.width = 400; c.height = 300;
  ed.setRectified(c, 4);
  ed.setTrace([{ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 40, y: 30 }, { x: 0, y: 30 }], []);
  ed.setCircles([{
    cx: 10, cy: 10, d: 5, type: 'through', side: 'top', depth: 3,
    csAngle: 90, csDia: 9, cbDia: 9, cbDepth: 3,
    edgeTop: { mode: 'none', size: 0.5 }, edgeBottom: { mode: 'none', size: 0.5 },
    screw: { std: 'custom', size: '', fit: 'clearance' },
  }]);
  const sp = mm => ed._mmToScreen(mm);

  // Measure: two vertex picks -> p2p; a rim pick -> radius.
  ed.setMode('measure');
  ed._measureDown(sp({ x: 0, y: 0 }));
  ed._measureDown(sp({ x: 40, y: 30 }));
  ed._measureDown(sp({ x: 12.5, y: 10 })); // on the hole rim
  const measures = ed.measurements.map(m => m.type);

  // Constrain: skew the top edge, pick it, apply H — solver levels it.
  ed.setMode('constrain');
  ed.outer[1].y = 2;
  ed._constrainDown(sp({ x: 20, y: 1 })); // on edge 0
  const picks = ed.getPicks().map(r => r.kind);
  const added = ed.addConstraintFromPicks('h');
  const levelled = Math.abs(ed.outer[0].y - ed.outer[1].y);

  // The p2p measurement survives + live-updates after the solve.
  const geo = ed._geo();
  return { measures, picks, added, levelled, nCons: ed.constraints.length };
});

// ---------------------------------------------------------------- tangent fillet cleanup
const tan = await page.evaluate(async () => {
  const { fitCircle } = await import('/js/contour.js');
  const M = await import('/js/measure.js');
  const ed = window.__app.traceEditor;
  const c = document.createElement('canvas');
  c.width = 400; c.height = 400;
  ed.setRectified(c, 4);

  // An L-corner (two perpendicular straight edges) with a crude 3-point
  // chamfer standing in for a rough traced corner near the 90° vertex at (50,50).
  //   down the left edge → across the blunt corner → along the bottom edge
  const outer = [
    { x: 0, y: 50 }, { x: 30, y: 50 },        // straight edge 1 (approaching corner)
    { x: 44, y: 50 }, { x: 50, y: 46 }, { x: 50, y: 40 }, // blunt corner run (3 pts)
    { x: 50, y: 20 }, { x: 50, y: 0 },        // straight edge 2 (leaving corner)
    { x: 0, y: 0 },
  ];
  ed.setTrace(outer.map(p => ({ ...p })), []);
  ed.setCircles([]);

  // Select the blunt-corner run (indices 2,3,4).
  ed.selectedVerts = [2, 3, 4].map(i => ({ loop: -1, idx: i }));
  const res = ed.makeTangentSelection();

  // Refit a circle to the new arc run and check it's tangent to both edge
  // lines: the two lines are x=50 (right) and y=50 (top), so a tangent circle
  // of radius r has centre (50-r, 50-r).
  const start = 2, arcLen = ed._lastArc.len;
  const arcPts = ed.outer.slice(start, start + arcLen);
  const fit = fitCircle(arcPts);
  return {
    ok: res.ok, r: res.r,
    distToRight: Math.abs(50 - fit.cx), // should equal r (tangent to x=50)
    distToTop: Math.abs(50 - fit.cy),   // should equal r (tangent to y=50)
    rms: fit.rms,
  };
});

console.log('\nTangent fillet cleanup');
check('makeTangentSelection rounds an L-corner', tan.ok, `r ${tan.r}`);
check('resulting arc is tangent to both edges (centre r from each line)',
  tan.ok && near(tan.distToRight, tan.r, 0.05) && near(tan.distToTop, tan.r, 0.05),
  `dRight ${tan.distToRight?.toFixed(3)}, dTop ${tan.distToTop?.toFixed(3)}, r ${tan.r}`);
check('arc points sit cleanly on the fitted circle', tan.rms < 0.05, `rms ${tan.rms?.toFixed(4)}`);

// ---------------------------------------------------------------- first-class (live) arcs
const arcs = await page.evaluate(async () => {
  const { fitCircle } = await import('/js/contour.js');
  const ed = window.__app.traceEditor;
  const c = document.createElement('canvas');
  c.width = 400; c.height = 400;
  ed.setRectified(c, 4);
  const build = () => [
    { x: 0, y: 50 }, { x: 30, y: 50 },
    { x: 44, y: 50 }, { x: 50, y: 46 }, { x: 50, y: 40 },
    { x: 50, y: 20 }, { x: 50, y: 0 }, { x: 0, y: 0 },
  ];
  ed.setTrace(build().map(p => ({ ...p })), []);
  ed.setCircles([]);
  ed.measurements = []; ed.constraints = []; ed.arcs = [];
  ed.selectedVerts = [2, 3, 4].map(i => ({ loop: -1, idx: i }));
  const made = ed.makeTangentSelection();
  const registered = ed.arcs.length;
  const arc = ed.arcs[0];

  // The two edges are x=50 and y=50; a tangent circle has centre (50-r, 50-r).
  const centreErr = () => {
    const f = fitCircle(ed.outer.slice(arc.lo, arc.lo + arc.len));
    return { dRight: Math.abs(50 - f.cx), dTop: Math.abs(50 - f.cy), r: f.r };
  };
  const before = centreErr();

  // Move the vertical edge from x=50 to x=60. After the tangent splice its two
  // vertices sit just past the arc run (arc.lo+arc.len, +1); reproject and the
  // fillet must stay tangent to the NEW line x=60.
  ed.outer[arc.lo + arc.len].x = 60;
  ed.outer[arc.lo + arc.len + 1].x = 60;
  ed._reprojectArcsLive();
  const f2 = fitCircle(ed.outer.slice(arc.lo, arc.lo + arc.len));
  const stillTangent = { dRight: Math.abs(60 - f2.cx), dTop: Math.abs(50 - f2.cy), r: f2.r };

  // Change the radius via the entity path.
  ed.selectedVerts = [];
  for (let k = 0; k < arc.len; k++) ed.selectedVerts.push({ loop: -1, idx: arc.lo + k });
  const rOk = ed.setArcRadius(4);
  const f3 = fitCircle(ed.outer.slice(arc.lo, arc.lo + arc.len));
  const newR = f3.r;

  // Editing a vertex INSIDE the arc's guarded span drops the entity.
  const preDrop = ed.arcs.length;
  ed.selection = { type: 'vertex', loop: -1, idx: arc.lo };
  ed._deleteVertex(ed.selection);
  const postDrop = ed.arcs.length;

  // Serialize round-trip through a project blob.
  ed.setTrace(build().map(p => ({ ...p })), []);
  ed.selectedVerts = [2, 3, 4].map(i => ({ loop: -1, idx: i }));
  ed.makeTangentSelection();
  const proj = JSON.parse(window.__app.state ? JSON.stringify({ arcs: ed.arcs }) : '{}');
  const serialisedCount = proj.arcs.length;

  return { made: made.ok, registered, before, stillTangent, rOk, newR, preDrop, postDrop, serialisedCount };
});

console.log('\nFirst-class (live) arcs');
check('tangent fillet registers a persistent arc entity',
  arcs.made && arcs.registered === 1, `${arcs.registered} arc(s)`);
check('arc is tangent to both edges on creation',
  near(arcs.before.dRight, arcs.before.r, 0.05) && near(arcs.before.dTop, arcs.before.r, 0.05),
  `dRight ${arcs.before.dRight.toFixed(3)}, dTop ${arcs.before.dTop.toFixed(3)}`);
check('arc re-solves tangent after an adjacent edge moves (x=50→60)',
  near(arcs.stillTangent.dRight, arcs.stillTangent.r, 0.05) &&
  near(arcs.stillTangent.dTop, arcs.stillTangent.r, 0.05),
  `dRight ${arcs.stillTangent.dRight.toFixed(3)}, dTop ${arcs.stillTangent.dTop.toFixed(3)}, r ${arcs.stillTangent.r.toFixed(2)}`);
check('setArcRadius re-radiuses the live fillet', arcs.rOk && near(arcs.newR, 4, 0.05), `r → ${arcs.newR.toFixed(2)}`);
check('editing inside the arc span reverts it to plain points',
  arcs.preDrop === 1 && arcs.postDrop === 0, `${arcs.preDrop} → ${arcs.postDrop}`);
check('arc entity serialises for project/library save', arcs.serialisedCount === 1, `${arcs.serialisedCount}`);

// ---------------------------------------------------------------- straight lines + tangent-to-circle
const lines = await page.evaluate(async () => {
  const { fitCircle } = await import('/js/contour.js');
  const C = await import('/js/constraints.js');
  const M = await import('/js/measure.js');
  const ed = window.__app.traceEditor;
  const c = document.createElement('canvas');
  c.width = 400; c.height = 400;
  ed.setRectified(c, 4);

  // A wobbly top edge (indices 1..4) between two clean corners.
  const build = () => [
    { x: 0, y: 0 },
    { x: 20, y: 50 }, { x: 40, y: 46 }, { x: 60, y: 53 }, { x: 80, y: 48 },
    { x: 100, y: 0 },
  ];
  ed.setTrace(build().map(p => ({ ...p })), []);
  ed.setCircles([]); ed.measurements = []; ed.constraints = []; ed.arcs = []; ed.lines = [];

  // Straighten between the two endpoints of the wobble (indices 1 and 5).
  ed.selectedVerts = [{ loop: -1, idx: 1 }, { loop: -1, idx: 5 }];
  const before = ed.outer.length;
  const st = ed.straightenSelection();
  const afterLen = ed.outer.length;
  const nLines = ed.lines.length;
  // The three interior wobble points (2,3,4) are gone; 1→5 collapsed to 1→2.
  const collapsedOk = afterLen === before - 3;

  // Restore: the stashed points come back.
  ed.selectedVerts = [{ loop: -1, idx: 1 }, { loop: -1, idx: 2 }];
  const restored = ed.releaseSelectedLine();
  const restoredLen = ed.outer.length;
  const linesAfterRestore = ed.lines.length;

  // Tangent-to-circle: a horizontal edge above a circle, driven down to touch.
  const outer = [{ x: 0, y: 20 }, { x: 40, y: 20 }, { x: 40, y: -10 }, { x: 0, y: -10 }];
  const circ = [{ cx: 20, cy: 0, d: 16 }]; // r = 8, centre at y=0
  const geo = { loop: l => l === -1 ? outer : null, circle: i => circ[i] || null };
  const res = C.solveConstraints(geo, [
    { type: 'anchor', refs: [{ kind: 'center', idx: 0 }] }, // pin the circle
    { type: 'ltan', refs: [{ kind: 'edge', loop: -1, idx: 0 }, { kind: 'circle', idx: 0 }] },
  ], {});
  // Edge 0 is the top edge; after solving its distance to centre (0,0) should = 8.
  const edgeY = (outer[0].y + outer[1].y) / 2;
  const tangentDist = Math.abs(edgeY - 0);

  return {
    stOk: st.ok, removed: st.removed, collapsedOk, nLines,
    restored, restoredLen, linesAfterRestore,
    tangentDist, tanConverged: res.converged,
  };
});

console.log('\nStraight lines + tangent-to-circle');
check('straighten collapses the run and registers one line',
  lines.stOk && lines.removed === 3 && lines.collapsedOk && lines.nLines === 1,
  `removed ${lines.removed}, lines ${lines.nLines}`);
check('restore re-inserts the stashed points and clears the line',
  lines.restored && lines.restoredLen === 6 && lines.linesAfterRestore === 0,
  `len → ${lines.restoredLen}, lines ${lines.linesAfterRestore}`);
check('edge-tangent-to-circle drives the edge to touch (dist → r=8)',
  lines.tanConverged && near(lines.tangentDist, 8, 0.02), `dist ${lines.tangentDist.toFixed(3)}`);

// Edge tangent to a fillet ARC (corner radius), not just a full circle.
const ltanArc = await page.evaluate(async () => {
  const { fitCircle } = await import('/js/contour.js');
  const ed = window.__app.traceEditor;
  const c = document.createElement('canvas');
  c.width = 400; c.height = 400;
  ed.setRectified(c, 4);
  // L-corner with a blunt run → make it a fillet arc, then constrain a
  // separate straight edge tangent to that arc.
  ed.setTrace([
    { x: 0, y: 50 }, { x: 30, y: 50 },
    { x: 44, y: 50 }, { x: 50, y: 46 }, { x: 50, y: 40 },
    { x: 50, y: 20 }, { x: 50, y: 0 },
    // a loose edge starting far from the fillet, to be pulled tangent
    { x: 90, y: 0 }, { x: 90, y: 40 }, { x: 20, y: 40 },
  ].map(p => ({ ...p })), []);
  ed.setCircles([]); ed.measurements = []; ed.constraints = []; ed.arcs = []; ed.lines = [];
  ed.selectedVerts = [2, 3, 4].map(i => ({ loop: -1, idx: i }));
  const made = ed.makeTangentSelection();
  const arc = ed.arcs[0];
  const ac = fitCircle(ed.outer.slice(arc.lo, arc.lo + arc.len));

  // The near-horizontal edge y≈40 (now shifted by the splice) → find it: the
  // edge whose two vertices are ~(90,40) and (20,40).
  let eIdx = -1;
  for (let i = 0; i < ed.outer.length; i++) {
    const a = ed.outer[i], b = ed.outer[(i + 1) % ed.outer.length];
    if (Math.abs(a.y - 40) < 1 && Math.abs(b.y - 40) < 1 && Math.abs(a.x - b.x) > 30) { eIdx = i; break; }
  }
  ed.constraints.push({ type: 'ltan', refs: [
    { kind: 'edge', loop: -1, idx: eIdx }, { kind: 'arcent', id: arc.id }] });
  ed.solveNow();

  // Distance from the arc centre to the constrained edge's line should == arc r.
  const a = ed.outer[eIdx], b = ed.outer[(eIdx + 1) % ed.outer.length];
  const ex = b.x - a.x, ey = b.y - a.y, el = Math.hypot(ex, ey);
  const nx = -ey / el, ny = ex / el;
  const dist = Math.abs((ac.cx - a.x) * nx + (ac.cy - a.y) * ny);
  return { made: made.ok, eFound: eIdx >= 0, arcR: ac.r, dist };
});

console.log('\nEdge tangent to a fillet arc');
check('found the fillet arc and the loose edge', ltanArc.made && ltanArc.eFound, `edge idx ${ltanArc.eFound}`);
check('edge driven tangent to the arc (centre→line dist → arc radius)',
  near(ltanArc.dist, ltanArc.arcR, 0.05), `dist ${ltanArc.dist.toFixed(3)} vs r ${ltanArc.arcR.toFixed(3)}`);

// ---------------------------------------------------------------- arc-aware exports
const exp = await page.evaluate(async () => {
  const { toSVG, toDXF } = await import('./js/exporters.js');
  const ed = window.__app.traceEditor;
  const c = document.createElement('canvas');
  c.width = 400; c.height = 400;
  ed.setRectified(c, 4);
  // Fillet an L-corner (registers an arc) and add a manual circle hole.
  ed.setTrace([
    { x: 0, y: 50 }, { x: 30, y: 50 },
    { x: 44, y: 50 }, { x: 50, y: 46 }, { x: 50, y: 40 },
    { x: 50, y: 20 }, { x: 50, y: 0 }, { x: 0, y: 0 },
  ].map(p => ({ ...p })), []);
  ed.setCircles([{
    cx: 20, cy: 20, d: 6, type: 'through', side: 'top', depth: 3,
    csAngle: 90, csDia: 9, cbDia: 9, cbDepth: 3,
    edgeTop: { mode: 'none', size: 0.5 }, edgeBottom: { mode: 'none', size: 0.5 },
    screw: { std: 'custom', size: '', fit: 'clearance' },
  }]);
  ed.measurements = []; ed.constraints = []; ed.arcs = []; ed.lines = [];
  ed.selectedVerts = [2, 3, 4].map(i => ({ loop: -1, idx: i }));
  ed.makeTangentSelection();

  const spans = ed.arcExportSpans();
  const opts = { outerArcs: spans.outer, holeArcs: spans.holes, circles: [{ cx: 20, cy: 20, d: 6 }] };
  const svg = await toSVG(ed.outer, ed.holes, 100, 100, opts).text();
  const dxf = await toDXF(ed.outer, ed.holes, 100, opts).text();

  // Count arc segments in the outline path (excludes the two circle arcs).
  const outlinePath = svg.match(/d="([^"]*)"/)[1];
  return {
    nOuterArcs: spans.outer.length,
    svgHasArc: /A /.test(outlinePath),
    svgHasCircleArcs: (svg.match(/A /g) || []).length >= 3, // ≥1 fillet + 2 for the circle
    dxfHasBulge: /\b42\b/.test(dxf),
    dxfHasCircle: dxf.includes('CIRCLE'),
    dxfStillValid: dxf.includes('AC1009') && dxf.includes('EOF') && /POLYLINE/.test(dxf),
  };
});

// DXF bulge round-trip: a fillet exported as a bulge re-imports as an arc.
const rt = await page.evaluate(async () => {
  const { toDXF } = await import('./js/exporters.js');
  const { parseDXF } = await import('./js/import/dxfImport.js');
  const { fitCircle } = await import('./js/contour.js');
  const ed = window.__app.traceEditor;
  const c = document.createElement('canvas');
  c.width = 400; c.height = 400;
  ed.setRectified(c, 4);
  ed.setTrace([
    { x: 0, y: 50 }, { x: 30, y: 50 },
    { x: 44, y: 50 }, { x: 50, y: 46 }, { x: 50, y: 40 },
    { x: 50, y: 20 }, { x: 50, y: 0 }, { x: 0, y: 0 },
  ].map(p => ({ ...p })), []);
  ed.setCircles([]); ed.measurements = []; ed.constraints = []; ed.arcs = []; ed.lines = [];
  ed.selectedVerts = [2, 3, 4].map(i => ({ loop: -1, idx: i }));
  ed.makeTangentSelection();
  const arc = ed.arcs[0];
  const orig = fitCircle(ed.outer.slice(arc.lo, arc.lo + arc.len));

  const paperH = 200;
  const spans = ed.arcExportSpans();
  const dxf = await toDXF(ed.outer, ed.holes, paperH,
    { outerArcs: spans.outer, holeArcs: spans.holes, circles: [] }).text();
  const parsed = parseDXF(dxf);
  const loop = parsed.polylines.reduce((a, b) => (b.pts.length > (a ? a.pts.length : 0) ? b : a), null);
  // Flip DXF Y-up back to image space, then fit the fillet region to a circle.
  const back = loop.pts.map(p => ({ x: p.x, y: paperH - p.y }));
  const near = back.filter(p => p.x >= 42.9 && p.y >= 42.9);
  const rtFit = fitCircle(near);
  return {
    origR: orig.r, origCx: orig.cx, origCy: orig.cy,
    rtR: rtFit ? rtFit.r : null, rtCx: rtFit ? rtFit.cx : null, rtCy: rtFit ? rtFit.cy : null,
    nNear: near.length,
  };
});

console.log('\nArc-aware exports');
check('trace reports one outer arc span', exp.nOuterArcs === 1, `${exp.nOuterArcs}`);
check('SVG emits an A (arc) command for the fillet', exp.svgHasArc, '');
check('SVG renders the circle hole as true arcs', exp.svgHasCircleArcs, '');
check('DXF encodes the fillet as a polyline bulge (group 42)', exp.dxfHasBulge, '');
check('DXF emits a true CIRCLE entity for the hole', exp.dxfHasCircle, '');
check('DXF stays valid R12 (AC1009 + POLYLINE + EOF)', exp.dxfStillValid, '');

// Auto-detect fillets: dense arc runs → live fillet-arc entities.
const detect = await page.evaluate(async () => {
  const { fitCircle } = await import('/js/contour.js');
  const ed = window.__app.traceEditor;
  const c = document.createElement('canvas');
  c.width = 400; c.height = 400;
  ed.setRectified(c, 4);

  // Build a rectangle whose top-right corner is a dense 90° fillet arc of r=6
  // (as an imported/flattened arc would look), bracketed by straight edges.
  // Centre (44,44); tangent points (50,44) at angle 0 and (44,50) at 90°.
  const cx = 44, cy = 44, r = 6;
  const arcPts = [];
  for (let k = 0; k <= 12; k++) {
    const a = (Math.PI / 2) * (k / 12); // 0°→90°: (50,44)→(44,50)
    arcPts.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
  }
  const outline = [
    { x: 0, y: 0 }, { x: 50, y: 0 }, // bottom edge
    ...arcPts,                        // right edge tangent → rounded corner → top edge tangent
    { x: 0, y: 50 },                  // top edge back to start
  ];
  ed.setTrace(outline.map(p => ({ ...p })), []);
  ed.setCircles([]); ed.measurements = []; ed.constraints = []; ed.arcs = []; ed.lines = [];
  const nMade = ed.detectFillets();
  const arcR = ed.arcs.length ? ed.arcs[0].r : null;

  // A plain square must NOT be converted (no rounded corners).
  ed.setTrace([{ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 40, y: 40 }, { x: 0, y: 40 }].map(p => ({ ...p })), []);
  ed.arcs = [];
  const nSquare = ed.detectFillets();

  return { nMade, arcR, nSquare, arcsCount: ed.arcs.length };
});

// Section clipping: a bed-level section can't add body past the outline; a
// raised (overhang) section keeps its full footprint.
const clip = await page.evaluate(async () => {
  const { buildModel } = await import('/js/mesh.js');
  const outer = [{ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 40, y: 40 }, { x: 0, y: 40 }];
  const none = { mode: 'none', size: 0 };
  const spill = [{ x: 30, y: 10 }, { x: 60, y: 10 }, { x: 60, y: 30 }, { x: 30, y: 30 }]; // pokes out to x=60
  const maxX = mesh => {
    let m = -1e9;
    for (let i = 0; i < mesh.positions.length; i += 3) m = Math.max(m, mesh.positions[i]);
    return m + 20; // model is centred at the outline's centre (cx=20) → shift back
  };
  const bed = buildModel(outer, [], [], [
    { name: 'Base', pts: null, thickness: 4, zBase: 0, top: none, bottom: none },
    { name: 'Tab', pts: spill, thickness: 3, zBase: 0, top: none, bottom: none },
  ], 6);
  const over = buildModel(outer, [], [], [
    { name: 'Base', pts: null, thickness: 4, zBase: 0, top: none, bottom: none },
    { name: 'Wing', pts: spill, thickness: 3, zBase: 5, top: none, bottom: none },
  ], 6);
  return {
    bedMaxX: maxX(bed), overMaxX: maxX(over),
    bedWarned: bed.stats.warnings.some(w => /clipped to it/.test(w)),
  };
});

// Suggest regions: a bright raised patch inside a grey object is detected as a
// candidate section footprint, and a uniform object yields nothing.
const regionRes = await page.evaluate(async () => {
  const { suggestRegions } = await import('/js/regions.js');
  const make = withPatch => {
    const cv = document.createElement('canvas');
    cv.width = 200; cv.height = 200;
    const g = cv.getContext('2d');
    g.fillStyle = '#8a8a8a'; g.fillRect(0, 0, 200, 200);      // object body (grey)
    if (withPatch) { g.fillStyle = '#e8e8e8'; g.fillRect(120, 120, 60, 60); } // bright raised pad
    return cv;
  };
  const pxPerMm = 2;
  const outer = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }];
  const withP = suggestRegions(make(true), outer, [], pxPerMm);
  const plain = suggestRegions(make(false), outer, [], pxPerMm);
  let cx = 0, cy = 0;
  if (withP[0]) { for (const p of withP[0].pts) { cx += p.x; cy += p.y; } cx /= withP[0].pts.length; cy /= withP[0].pts.length; }

  // Overlap dedup: a bright pad with a dark spot inside it (overlapping bboxes)
  // should collapse to a single suggestion (the larger, bright, one).
  const dup = document.createElement('canvas'); dup.width = 200; dup.height = 200;
  const gd = dup.getContext('2d');
  gd.fillStyle = '#8a8a8a'; gd.fillRect(0, 0, 200, 200);
  gd.fillStyle = '#e8e8e8'; gd.fillRect(110, 110, 70, 70);   // bright pad
  gd.fillStyle = '#404040'; gd.fillRect(130, 130, 24, 24);   // dark spot inside it
  const deduped = suggestRegions(dup, outer, [], pxPerMm);

  return {
    nPatch: withP.length, nPlain: plain.length, cx, cy, kind: withP[0] && withP[0].kind,
    dedupN: deduped.length, dedupKind: deduped[0] && deduped[0].kind,
  };
});
console.log('\nSuggest section regions');
check('finds the bright pad as a candidate region', regionRes.nPatch >= 1, `${regionRes.nPatch} found`);
check('candidate sits over the pad (~75,75 mm)',
  regionRes.nPatch >= 1 && near(regionRes.cx, 75, 6) && near(regionRes.cy, 75, 6),
  `centroid (${regionRes.cx.toFixed(1)},${regionRes.cy.toFixed(1)})`);
check('a uniform object suggests nothing', regionRes.nPlain === 0, `${regionRes.nPlain} found`);
check('bright pad is labelled as a raised candidate', regionRes.kind === 'bright', `kind ${regionRes.kind}`);
check('overlapping bright/dark patches dedupe to one region',
  regionRes.dedupN === 1 && regionRes.dedupKind === 'bright', `${regionRes.dedupN} region(s), kind ${regionRes.dedupKind}`);

// Beyond-the-paper capture: an object overhanging the reference is kept (with
// margin) but cropped without it. Straight-on synthetic scene, so no perspective.
const beyond = await page.evaluate(async () => {
  const { rectify } = await import('/js/homography.js');
  const { computeDiffMap, segmentObject } = await import('/js/segment.js');
  // Source: grey table, white 200px paper at [100,100], dark object spanning
  // x[180,340] (overhangs the paper's right edge at x=300 onto the table).
  const cv = document.createElement('canvas'); cv.width = 400; cv.height = 400;
  const g = cv.getContext('2d');
  g.fillStyle = '#9a9a9a'; g.fillRect(0, 0, 400, 400);
  g.fillStyle = '#f3f1ea'; g.fillRect(100, 100, 200, 200);       // paper (100mm sq)
  g.fillStyle = '#2c2c2c'; g.fillRect(180, 150, 160, 80);       // object, overhanging
  const corners = [{ x: 100, y: 100 }, { x: 300, y: 100 }, { x: 300, y: 300 }, { x: 100, y: 300 }];

  // Fixed threshold: the synthetic diff is cleanly bimodal (bg 0, object 77),
  // which is degenerate for Otsu (flat between-class variance → t=0).
  const run = marginMm => {
    const r = rectify(cv, corners, 100, 100, { marginMm, maxLongSidePx: 400 });
    const dm = computeDiffMap(r.canvas, marginMm > 0 ? { paperRect: r.paperRect } : {});
    const mask = segmentObject(dm, { threshold: 40, cleanupRadius: 1, marginPx: 2 });
    let maxX = -1;
    if (mask) for (let i = 0; i < mask.length; i++) if (mask[i]) { const x = i % dm.w; if (x > maxX) maxX = x; }
    return { W: r.canvas.width, ppm: r.pxPerMm, paperW: r.paperRect.w, paperRight: r.paperRect.x + r.paperRect.w, maxX };
  };
  return { off: run(0), on: run(50) };
});

// Text → loops foundation for emboss/deboss labels.
const textRes = await page.evaluate(async () => {
  const { textToLoops, labelLoops } = await import('/js/text.js');
  const blank = textToLoops('   ');
  const o = textToLoops('O', { px: 120 });      // has a counter → ≥ 2 loops
  const ii = textToLoops('II', { px: 120 });    // two bars → no counters
  const lbl = labelLoops('A1', 50, 30, 10, {}); // placed loops (mm), 10 mm tall
  // Bounds of the placed label.
  let minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9;
  for (const l of lbl) for (const p of l) { minX = Math.min(minX, p.x); minY = Math.min(minY, p.y); maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y); }
  return {
    blankN: blank.loops.length, oN: o.loops.length, iiHasHole: ii.loops.length,
    lblN: lbl.length, h: maxY - minY, cx: (minX + maxX) / 2, cy: (minY + maxY) / 2,
  };
});

// Label UI pipeline: place via the editor, rotate, and round-trip a project.
const labelUI = await page.evaluate(async () => {
  const app = window.__app;
  const ed = app.traceEditor;
  const c = document.createElement('canvas'); c.width = 400; c.height = 300;
  ed.setRectified(c, 4);
  ed.setTrace([{ x: 0, y: 0 }, { x: 60, y: 0 }, { x: 60, y: 40 }, { x: 0, y: 40 }], []);
  ed.setCircles([]);
  app.state.labels.length = 0;
  ed.setLabels(app.state.labels);

  ed.setMode('label');
  ed._labelDown({}, ed._mmToScreen({ x: 30, y: 20 }));   // place via the canvas
  const placed = app.state.labels.length;
  const L = app.state.labels[0];
  L.text = 'AB'; L.height = 10;
  const geomN = ed.labelGeometry(0).length;

  const hit = ed._hitLabel(ed._mmToScreen({ x: 30, y: 20 }));
  L.rot = 45;                                            // any-angle rotation
  const rotGeom = ed.labelGeometry(0);
  let minY = 1e9, maxY = -1e9;
  for (const l of rotGeom) for (const p of l) { minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y); }
  const rotWidensY = (maxY - minY) > 10.5;

  // Project round-trip through the real save path (the modal's textarea).
  document.getElementById('projectBtn').click();
  const json = JSON.parse(document.getElementById('projText').value || '{}');
  document.getElementById('projCloseBtn').click();

  return {
    placed, geomN, hitPart: hit && hit.part, rotWidensY,
    serialised: Array.isArray(json.labels) ? json.labels.length : -1,
    selIdx: ed.selLabel,
  };
});

console.log('\nLabel UI pipeline');
check('clicking the part places a label and selects it',
  labelUI.placed === 1 && labelUI.selIdx === 0, `${labelUI.placed} placed, sel ${labelUI.selIdx}`);
check('placed label produces glyph geometry', labelUI.geomN >= 2, `${labelUI.geomN} loops`);
check('label is hit-testable for dragging', labelUI.hitPart === 'move', `part ${labelUI.hitPart}`);
check('any-angle (45°) rotation changes the placed geometry', labelUI.rotWidensY, 'y extent widened');
check('labels serialise with the project', labelUI.serialised === 1, `${labelUI.serialised}`);

// Emboss / deboss mesh: raised lettering and an engraved recess.
const label = await page.evaluate(async () => {
  const { buildModel, glyphIslands } = await import('/js/mesh.js');
  const { labelLoops } = await import('/js/text.js');
  const outer = [{ x: 0, y: 0 }, { x: 60, y: 0 }, { x: 60, y: 40 }, { x: 0, y: 40 }];
  const none = { mode: 'none', size: 0 };
  const regions = [{ name: 'Base', pts: null, thickness: 4, zBase: 0, top: none, bottom: none }];
  const loops = labelLoops('AB', 30, 20, 12, {});
  const isl = glyphIslands(loops);

  const zRange = m => {
    let lo = 1e9, hi = -1e9;
    for (let i = 2; i < m.positions.length; i += 3) { lo = Math.min(lo, m.positions[i]); hi = Math.max(hi, m.positions[i]); }
    return { lo, hi };
  };
  const badEdges = m => {
    const use = new Map();
    const k = i => `${m.positions[i*3].toFixed(4)},${m.positions[i*3+1].toFixed(4)},${m.positions[i*3+2].toFixed(4)}`;
    for (let t = 0; t < m.indices.length; t += 3) {
      const ks = [k(m.indices[t]), k(m.indices[t+1]), k(m.indices[t+2])];
      if (ks[0] === ks[1] || ks[1] === ks[2] || ks[0] === ks[2]) continue;
      for (let e = 0; e < 3; e++) {
        const a = ks[e], b = ks[(e+1)%3];
        const key = a < b ? a+'|'+b : b+'|'+a;
        use.set(key, (use.get(key) || 0) + 1);
      }
    }
    let bad = 0;
    for (const v of use.values()) if (v !== 2) bad++;
    return bad;
  };

  const plain = buildModel(outer, [], [], regions, { arcSegments: 6 });
  const emb = buildModel(outer, [], [], regions, { arcSegments: 6,
    labels: [{ loops, mode: 'emboss', face: 'top', size: 1 }] });
  const deb = buildModel(outer, [], [], regions, { arcSegments: 6,
    labels: [{ loops, mode: 'deboss', face: 'top', size: 0.8 }] });
  // Two same-face labels with different depths: the single-shell cut gives
  // each its exact floor (the old split forced both to the deepest).
  const deb2 = buildModel(outer, [], [], regions, { arcSegments: 6, labels: [
    { loops: labelLoops('A', 15, 20, 10, {}), mode: 'deboss', face: 'top', size: 0.5 },
    { loops: labelLoops('B', 45, 20, 10, {}), mode: 'deboss', face: 'top', size: 1.2 },
  ] });
  const hasZ = (m, z) => {
    for (let i = 2; i < m.positions.length; i += 3) {
      if (Math.abs(m.positions[i] - z) < 1e-6) return true;
    }
    return false;
  };

  return {
    twoDepthFloors: hasZ(deb2, 3.5) && hasZ(deb2, 2.8),
    twoDepthBad: badEdges(deb2),
    twoDepthParts: deb2.stats.sections,
    nIslands: isl.length,
    islandHasCounter: isl.some(s => s.holes.length > 0),   // "A" has a counter
    plainHi: zRange(plain).hi, embHi: zRange(emb).hi,
    embTris: emb.stats.triangles > plain.stats.triangles,
    embBad: badEdges(emb),
    debTris: deb.stats.triangles > plain.stats.triangles,
    debBad: badEdges(deb),
    debHi: zRange(deb).hi,
    // exact recess floor: with depth 0.8 on a 4 mm part the core's top face
    // (the visible floor) must sit at exactly 3.2 — the EPS overlap lives
    // inside the engraved slice, not in the depth.
    floorExact: (() => {
      for (let i = 2; i < deb.positions.length; i += 3) {
        if (Math.abs(deb.positions[i] - 3.2) < 1e-6) return true; // float32 storage
      }
      return false;
    })(),
  };
});

console.log("\nEmboss / deboss mesh");
check('glyph loops resolve to islands with counters kept open',
  label.nIslands === 2 && label.islandHasCounter, `${label.nIslands} islands, counter ${label.islandHasCounter}`);
check('emboss raises geometry above the face (4 → 5 mm)',
  near(label.plainHi, 4, 1e-6) && near(label.embHi, 5, 1e-6), `${label.plainHi} → ${label.embHi}`);
check('embossed model is watertight and adds geometry',
  label.embBad === 0 && label.embTris, `${label.embBad} bad edges`);
check('deboss keeps the outer height but adds the recess layers',
  near(label.debHi, 4, 1e-6) && label.debTris, `top ${label.debHi}`);
check('debossed model is watertight', label.debBad === 0, `${label.debBad} bad edges`);
check('recess depth is exact (floor at 4 − 0.8 = 3.2 mm)', label.floorExact, '');
check('two same-face labels carve exact per-label depths in one shell',
  label.twoDepthFloors && label.twoDepthBad === 0 && label.twoDepthParts === 1,
  `floors ${label.twoDepthFloors}, ${label.twoDepthBad} bad edges, ${label.twoDepthParts} parts`);

// Screw features on a debossed section: with the single-shell recess cut, a
// recessed feature now survives on the SAME face as the deboss (as long as it
// sits clear of the glyphs); blind holes are not punched through.
const debScrew = await page.evaluate(async () => {
  const { buildModel } = await import('/js/mesh.js');
  const { labelLoops } = await import('/js/text.js');
  const outer = [{ x: 0, y: 0 }, { x: 60, y: 0 }, { x: 60, y: 40 }, { x: 0, y: 40 }];
  const none = { mode: 'none', size: 0 };
  const regions = [{ name: 'Base', pts: null, thickness: 4, zBase: 0, top: none, bottom: none }];
  const loops = labelLoops('AB', 30, 20, 12, {});
  const rim = { mode: 'none', size: 0.5 };
  const holes = [
    // cs entering the UN-engraved bottom face -> keeps its countersink
    { cx: 10, cy: 20, d: 5, type: 'cs', side: 'bottom', csAngle: 90, csDia: 9, edgeTop: rim, edgeBottom: rim },
    // cs entering the debossed top face, clear of the glyphs -> now SURVIVES
    { cx: 50, cy: 20, d: 5, type: 'cs', side: 'top', csAngle: 90, csDia: 9, edgeTop: rim, edgeBottom: rim },
    // blind from the bottom -> preserved, and must NOT open the top face
    { cx: 30, cy: 33, d: 4, type: 'blind', side: 'bottom', depth: 2, edgeTop: rim, edgeBottom: rim },
  ];
  const m = buildModel(outer, [], holes, regions, { arcSegments: 8,
    labels: [{ loops, mode: 'deboss', face: 'top', size: 0.8 }] });

  // Ring finder: any vertex at z within tol whose distance to (mx,my) is ~r.
  const ring = (mx, my, z, r) => {
    for (let i = 0; i < m.positions.length; i += 3) {
      if (Math.abs(m.positions[i + 2] - z) > 1e-6) continue;
      const d = Math.hypot(m.positions[i] - mx, m.positions[i + 1] - my);
      if (Math.abs(d - r) < 0.2) return true;
    }
    return false;
  };
  const badEdges = () => {
    const use = new Map();
    const k = i => `${m.positions[i*3].toFixed(4)},${m.positions[i*3+1].toFixed(4)},${m.positions[i*3+2].toFixed(4)}`;
    for (let t = 0; t < m.indices.length; t += 3) {
      const ks = [k(m.indices[t]), k(m.indices[t+1]), k(m.indices[t+2])];
      if (ks[0] === ks[1] || ks[1] === ks[2] || ks[0] === ks[2]) continue;
      for (let e = 0; e < 3; e++) {
        const a = ks[e], b = ks[(e+1)%3], key = a < b ? a+'|'+b : b+'|'+a;
        use.set(key, (use.get(key) || 0) + 1);
      }
    }
    let bad = 0;
    for (const v of use.values()) if (v !== 2) bad++;
    return bad;
  };
  // A second model where the top-face countersink OVERLAPS the glyphs — the
  // single-shell cut must refuse it and fall back to the two-layer split
  // (feature demoted to a bore, with the warning).
  const clash = buildModel(outer, [],
    [{ cx: 30, cy: 20, d: 5, type: 'cs', side: 'top', csAngle: 90, csDia: 9, edgeTop: rim, edgeBottom: rim }],
    regions, { arcSegments: 8, labels: [{ loops, mode: 'deboss', face: 'top', size: 0.8 }] });
  // For this pathological overlap (bore through the middle of the glyphs)
  // the two-layer union can pinch (edges shared by 4 faces) — volume-closed
  // and printable. What must NEVER happen is an OPEN edge (used once).
  const clashLeaks = (() => {
    const use = new Map();
    const k = i => `${clash.positions[i*3].toFixed(4)},${clash.positions[i*3+1].toFixed(4)},${clash.positions[i*3+2].toFixed(4)}`;
    for (let t = 0; t < clash.indices.length; t += 3) {
      const ks = [k(clash.indices[t]), k(clash.indices[t+1]), k(clash.indices[t+2])];
      if (ks[0] === ks[1] || ks[1] === ks[2] || ks[0] === ks[2]) continue;
      for (let e = 0; e < 3; e++) {
        const a = ks[e], b = ks[(e+1)%3], key = a < b ? a+'|'+b : b+'|'+a;
        use.set(key, (use.get(key) || 0) + 1);
      }
    }
    let leaks = 0;
    for (const v of use.values()) if (v % 2 === 1) leaks++;
    return leaks;
  })();

  // Model coords: outline centre (30,20); model y = 20 - cy.
  return {
    csKeptMouth: ring(-20, 0, 0, 4.5),        // cs-from-bottom mouth at z=0, r=4.5
    csTopMouth: ring(20, 0, 4, 4.5),          // cs-from-top mouth now PRESENT
    blindFloor: ring(0, -13, 2, 2) || ring(0, -13, 2, 1.6), // floor ring at z=2
    blindTopOpen: ring(0, -13, 4, 2),         // top face must be closed
    warned: (m.stats.warnings || []).some(w => /entering through a debossed face/.test(w)),
    sections: m.stats.sections,               // single shell -> 1 part
    bad: badEdges(),
    clashWarned: (clash.stats.warnings || []).some(w => /entering through a debossed face/.test(w)),
    clashParts: clash.stats.sections,
    clashLeaks,
  };
});

console.log('\nDeboss × screw features (single-shell recess)');
check('countersink from the un-engraved face keeps its recess',
  debScrew.csKeptMouth, 'cs mouth ring at z=0');
check('countersink on the debossed face SURVIVES (single shell, no demotion)',
  debScrew.csTopMouth && !debScrew.warned, 'cs mouth ring at z=4');
check('single-shell deboss builds as one part', debScrew.sections === 1,
  `${debScrew.sections} parts`);
check('blind hole from the bottom keeps its floor and does not open the top',
  debScrew.blindFloor && !debScrew.blindTopOpen, '');
check('deboss + screw model stays watertight', debScrew.bad === 0, `${debScrew.bad} bad edges`);
check('glyph-overlapping feature falls back to the split (bore + warning), no open edges',
  debScrew.clashWarned && debScrew.clashParts === 2 && debScrew.clashLeaks === 0,
  `${debScrew.clashParts} parts, ${debScrew.clashLeaks} open edges`);

// ---------- Foam-style insert (holders.js) ----------

const foam = await page.evaluate(async () => {
  const { buildFoamInsert } = await import('/js/holders.js');
  const outer = [{ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 40, y: 30 }, { x: 0, y: 30 }];
  const hole = [{ x: 15, y: 10 }, { x: 25, y: 10 }, { x: 25, y: 20 }, { x: 15, y: 20 }];
  const badEdges = m => {
    const use = new Map();
    const k = i => `${m.positions[i*3].toFixed(4)},${m.positions[i*3+1].toFixed(4)},${m.positions[i*3+2].toFixed(4)}`;
    for (let t = 0; t < m.indices.length; t += 3) {
      const ks = [k(m.indices[t]), k(m.indices[t+1]), k(m.indices[t+2])];
      if (ks[0] === ks[1] || ks[1] === ks[2] || ks[0] === ks[2]) continue;
      for (let e = 0; e < 3; e++) {
        const a = ks[e], b = ks[(e+1)%3], key = a < b ? a+'|'+b : b+'|'+a;
        use.set(key, (use.get(key) || 0) + 1);
      }
    }
    let bad = 0;
    for (const v of use.values()) if (v !== 2) bad++;
    return bad;
  };
  const hasZ = (m, z) => {
    for (let i = 2; i < m.positions.length; i += 3) {
      if (Math.abs(m.positions[i] - z) < 1e-6) return true;
    }
    return false;
  };

  // 40×30 tool with a 10×10 hole; 0.5 clearance, 10 border, 5 deep on a
  // 3 mm floor, Ø20 finger notch on the bottom edge.
  const res = buildFoamInsert({ outer, holes: [hole], circles: [] }, {
    clearance: 0.5, margin: 10, cornerR: 4, depth: 5, floor: 3,
    notch: 'bottom', notchDia: 20,
  });
  // Same tool, pocket punched through (no floor) — pillars must drop.
  const thru = buildFoamInsert({ outer, holes: [hole], circles: [] }, {
    clearance: 0.5, margin: 10, cornerR: 4, depth: 8, floor: 0, notch: 'none',
  });

  // Pillar top cap: vertices at the slab top inside the pocket area can only
  // come from the standing pillar (hole 10×10 → pillar 9×9 centred on model
  // (0, 5); the slab's own top cap has no vertices inside the pocket).
  let pillarVerts = 0;
  if (res) {
    for (let i = 0; i < res.positions.length; i += 3) {
      if (Math.abs(res.positions[i + 2] - 8) < 1e-6 &&
          Math.abs(res.positions[i]) < 4.6 &&
          Math.abs(res.positions[i + 1] - 5) < 4.6) pillarVerts++;
    }
  }
  return {
    ok: !!res, thruOk: !!thru,
    bad: res ? badEdges(res) : -1,
    thruBad: thru ? badEdges(thru) : -1,
    slab: res ? res.stats.slab : null,
    sizeX: res ? res.stats.sizeX : 0, sizeY: res ? res.stats.sizeY : 0, sizeZ: res ? res.stats.sizeZ : 0,
    floorPlane: res ? hasZ(res, 3) : false,
    pillarVerts,
    thruWarned: thru ? (thru.stats.warnings || []).some(w => /pillars would float/.test(w)) : false,
    thruSizeZ: thru ? thru.stats.sizeZ : 0,
    tmplW: res ? res.template.w : 0, tmplH: res ? res.template.h : 0,
  };
});

console.log('\nFoam-style insert (holders.js)');
check('insert builds and is watertight', foam.ok && foam.bad === 0, `${foam.bad} bad edges`);
check('slab = pocket bbox + border (41+20 × 41+20, notch included)',
  near(foam.sizeX, 61, 0.2) && near(foam.sizeY, 61, 0.2) && near(foam.sizeZ, 8, 1e-6),
  `${foam.sizeX.toFixed(1)} × ${foam.sizeY.toFixed(1)} × ${foam.sizeZ}`);
check('pocket floor sits at exactly floor = 3 mm', foam.floorPlane, '');
check('tool hole stands as a support pillar (cap flush with the top)',
  foam.pillarVerts >= 4, `${foam.pillarVerts} verts`);
check('through pocket (floor 0) drops pillars with a warning, stays watertight',
  foam.thruOk && foam.thruBad === 0 && foam.thruWarned && near(foam.thruSizeZ, 8, 1e-6),
  `${foam.thruBad} bad edges`);
check('cut template carries true-scale slab dims', near(foam.tmplW, 61, 0.2) && near(foam.tmplH, 61, 0.2),
  `${foam.tmplW.toFixed(1)} × ${foam.tmplH.toFixed(1)}`);

// Foam UI: preview swap + export buttons deliver real downloads.
await page.evaluate(() => window.__app.goStep(3));
const foamUI = await page.evaluate(async () => {
  const sel = document.getElementById('holderType');
  sel.value = 'foam';
  sel.dispatchEvent(new Event('change'));
  await new Promise(r => setTimeout(r, 900)); // outlast any queued object rebuild

  return {
    previewActive: !!window.__app.state.holderMesh,
    info: document.getElementById('meshInfo').textContent,
    paramsShown: !document.getElementById('foamParams').hidden,
  };
});
check('foam preview builds from the live trace and takes over the viewer',
  foamUI.previewActive && foamUI.paramsShown && /Foam insert/.test(foamUI.info),
  foamUI.info.split('\n')[0]);
{
  const [dl] = await Promise.all([
    page.waitForEvent('download', { timeout: 10000 }).catch(() => null),
    page.click('#exportFoamBtn'),
  ]);
  check('foam STL export downloads with the right name',
    !!dl && /-foam-2p5d\.stl$/.test(dl.suggestedFilename()),
    dl ? dl.suggestedFilename() : 'no download event');
  const [svgDl] = await Promise.all([
    page.waitForEvent('download', { timeout: 10000 }).catch(() => null),
    page.click('#exportFoamSvgBtn'),
  ]);
  const svgPath = svgDl ? await svgDl.path().catch(() => null) : null;
  const svgTxt = svgPath ? fs.readFileSync(svgPath, 'utf8') : '';
  check('foam cut-template SVG downloads with real content',
    !!svgDl && /-foam-template\.svg$/.test(svgDl.suggestedFilename()) && svgTxt.includes('<svg'),
    svgDl ? svgDl.suggestedFilename() : 'no download event');
}
await page.evaluate(async () => {
  const sel = document.getElementById('holderType');
  sel.value = 'none';
  sel.dispatchEvent(new Event('change'));
  await new Promise(r => setTimeout(r, 300));
});

// ---------- Multi-tool drawer layout (holders.js) ----------

const layout = await page.evaluate(async () => {
  const { buildLayoutInsert, layoutPockets, layoutConflicts, roundedRect } =
    await import('/js/holders.js');
  const badEdges = m => {
    const use = new Map();
    const k = i => `${m.positions[i*3].toFixed(4)},${m.positions[i*3+1].toFixed(4)},${m.positions[i*3+2].toFixed(4)}`;
    for (let t = 0; t < m.indices.length; t += 3) {
      const ks = [k(m.indices[t]), k(m.indices[t+1]), k(m.indices[t+2])];
      if (ks[0] === ks[1] || ks[1] === ks[2] || ks[0] === ks[2]) continue;
      for (let e = 0; e < 3; e++) {
        const a = ks[e], b = ks[(e+1)%3], key = a < b ? a+'|'+b : b+'|'+a;
        use.set(key, (use.get(key) || 0) + 1);
      }
    }
    let bad = 0;
    for (const v of use.values()) if (v !== 2) bad++;
    return bad;
  };
  const hasZ = (m, z) => {
    for (let i = 2; i < m.positions.length; i += 3) {
      if (Math.abs(m.positions[i] - z) < 1e-6) return true;
    }
    return false;
  };
  const bbox = pts => {
    let minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9;
    for (const p of pts) {
      minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
      minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
    }
    return { w: maxX - minX, h: maxY - minY };
  };

  const toolOutline = [{ x: 5, y: 5 }, { x: 45, y: 5 }, { x: 45, y: 25 }, { x: 5, y: 25 }]; // 40×20
  const mk = (x, y, rot, depth, thickness) =>
    ({ name: 't', outer: toolOutline, holes: [], circles: [], x, y, rot, depth, thickness });
  const container = { outer: roundedRect(5 + 105, 5 + 40, 210, 80, 4) }; // 210×80

  // Two tools: A at default depth (thickness 6), B rotated 90° at 2.5 mm.
  const items = [mk(60, 45, 0, null, 6), mk(150, 45, 90, 2.5, 6)];
  const res = buildLayoutInsert(container, items, { clearance: 0.5, floor: 3, border: 5, defaultDepth: 6 });

  // B rotated 90°: its clearance pocket must be ~21 × 41.
  const pockets = layoutPockets(items, 0.5);
  const rotBB = bbox(pockets[1].pocket);

  // Collision + escape detection.
  const clash = layoutConflicts(container.outer,
    layoutPockets([mk(60, 45, 0, null, 6), mk(70, 50, 0, null, 6)], 0.5), 5);
  const escape = layoutConflicts(container.outer,
    layoutPockets([mk(205, 45, 0, null, 6)], 0.5), 5);
  const blocked = buildLayoutInsert(container,
    [mk(60, 45, 0, null, 6), mk(70, 50, 0, null, 6)],
    { clearance: 0.5, floor: 3, border: 5 });

  return {
    ok: !!res && !res.reason,
    bad: res && res.positions ? badEdges(res) : -1,
    sizeX: res?.stats?.sizeX || 0, sizeY: res?.stats?.sizeY || 0, sizeZ: res?.stats?.sizeZ || 0,
    floorA: res && res.positions ? hasZ(res, 3) : false,     // 9 − 6
    floorB: res && res.positions ? hasZ(res, 6.5) : false,   // 9 − 2.5
    rotW: rotBB.w, rotH: rotBB.h,
    clashN: clash.collisions.size, escapeN: escape.escaped.size,
    blockedReason: blocked ? blocked.reason : 'none',
  };
});

console.log('\nMulti-tool drawer layout (holders.js)');
check('two-tool insert builds watertight', layout.ok && layout.bad === 0, `${layout.bad} bad edges`);
check('slab follows the container (210 × 80), thickness = floor + deepest',
  near(layout.sizeX, 210, 0.2) && near(layout.sizeY, 80, 0.2) && near(layout.sizeZ, 9, 1e-6),
  `${layout.sizeX.toFixed(1)} × ${layout.sizeY.toFixed(1)} × ${layout.sizeZ}`);
check('per-tool pocket depths land at exact floors (3 and 6.5)',
  layout.floorA && layout.floorB, '');
check('90° rotation carries into the pocket (~21 × 41)',
  near(layout.rotW, 21, 0.5) && near(layout.rotH, 41, 0.5),
  `${layout.rotW.toFixed(1)} × ${layout.rotH.toFixed(1)}`);
check('overlapping pockets and border escapes are detected',
  layout.clashN === 2 && layout.escapeN === 1, `${layout.clashN} colliding, ${layout.escapeN} escaped`);
check('conflicted layout refuses to build with a reason', layout.blockedReason === 'collision',
  layout.blockedReason);

// Layout UI: modal flow with the live trace, preview and export.
await page.evaluate(() => window.__app.goStep(3));
const layoutUI = await page.evaluate(async () => {
  const sel = document.getElementById('holderType');
  sel.value = 'layout';
  sel.dispatchEvent(new Event('change'));
  await new Promise(r => setTimeout(r, 200));
  const modalOpen = !document.getElementById('layoutModal').hidden;
  document.getElementById('layToolSel').value = '__current';
  document.getElementById('layAddBtn').click();
  await new Promise(r => setTimeout(r, 100));
  const items = window.__app.state.layout.items.length;
  document.getElementById('layPreviewBtn').click();
  await new Promise(r => setTimeout(r, 500));
  return {
    modalOpen, items,
    modalClosed: document.getElementById('layoutModal').hidden,
    previewActive: !!window.__app.state.holderMesh,
    info: document.getElementById('meshInfo').textContent,
  };
});
check('layout modal opens, adds the live trace, previews in 3D',
  layoutUI.modalOpen && layoutUI.items === 1 && layoutUI.modalClosed &&
  layoutUI.previewActive && /Drawer insert/.test(layoutUI.info),
  layoutUI.info.split('\n')[0] || `modal ${layoutUI.modalOpen}, items ${layoutUI.items}`);

// Per-placement label text: defaults to the library name, editable without
// touching the name, resettable, and not stored when it matches the name.
const layLabel = await page.evaluate(async () => {
  const { itemLabelText } = await import('/js/holders.js');
  const st = window.__app.state;
  const it = st.layout.items[0];
  document.getElementById('layoutModal').hidden = false;
  window.__app.layoutEditor.sel = 0;
  window.__app.syncLaySelPanel(0);
  const input = document.getElementById('laySelLabel');
  const beforeVal = input.value, beforePh = input.placeholder;
  const seeded = itemLabelText(it);

  input.value = '13 mm';
  input.dispatchEvent(new Event('change'));
  const edited = { label: it.label, name: it.name, text: itemLabelText(it) };

  // Typing the name back drops the override rather than storing a duplicate.
  input.value = it.name;
  input.dispatchEvent(new Event('change'));
  const sameAsName = 'label' in it;

  input.value = 'Torque wrench';
  input.dispatchEvent(new Event('change'));
  document.getElementById('laySelLabelReset').click();
  const afterReset = { has: 'label' in it, text: itemLabelText(it) };

  document.getElementById('layoutModal').hidden = true;
  return { beforeVal, beforePh, seeded, edited, sameAsName, afterReset };
});
check('label seeds from the tool name with no typing',
  layLabel.seeded === layLabel.edited.name && layLabel.beforeVal === '' &&
  /uses/.test(layLabel.beforePh),
  `seeded "${layLabel.seeded}", placeholder "${layLabel.beforePh}"`);
check('editing the label leaves the tool name untouched',
  layLabel.edited.label === '13 mm' && layLabel.edited.text === '13 mm' &&
  layLabel.edited.name !== '13 mm',
  `label "${layLabel.edited.label}", name "${layLabel.edited.name}"`);
check('a label equal to the name is not stored as an override',
  layLabel.sameAsName === false, `stored ${layLabel.sameAsName}`);
check('reset drops the override and falls back to the name',
  layLabel.afterReset.has === false && layLabel.afterReset.text === layLabel.edited.name,
  `has ${layLabel.afterReset.has}, text "${layLabel.afterReset.text}"`);
{
  const [dl] = await Promise.all([
    page.waitForEvent('download', { timeout: 10000 }).catch(() => null),
    page.evaluate(() => {
      document.getElementById('holderType').dispatchEvent(new Event('change')); // keep state in sync
      document.getElementById('layoutModal').hidden = false;
    }).then(() => page.click('#layExportBtn')),
  ]);
  check('drawer insert STL export downloads',
    !!dl && /-drawer-2p5d\.stl$/.test(dl.suggestedFilename()),
    dl ? dl.suggestedFilename() : 'no download event');
}
await page.evaluate(async () => {
  document.getElementById('layoutModal').hidden = true;
  window.__app.state.layout.items.length = 0;
  const sel = document.getElementById('holderType');
  sel.value = 'none';
  sel.dispatchEvent(new Event('change'));
  await new Promise(r => setTimeout(r, 300));
});

// ---------- Laser-cut foam constructions (holders.js, PRD Part D) ----------
//
// Everything this block touches is restored at its end: the layout is left
// empty, the construction back at 'pocket', the holder type back at 'none'
// and the layout modal hidden, so the checks after it see the page they
// expect.

const constrState = await page.evaluate(async () => {
  const $ = id => document.getElementById(id);
  const st = window.__app.state;

  const holder = $('holderType');
  holder.value = 'layout';
  holder.dispatchEvent(new Event('change'));   // opens the panel, syncs fields
  await new Promise(r => setTimeout(r, 200));

  const sel = $('layConstruction');
  const options = [...sel.options].map(o => o.value);
  const dflt = { state: st.layout.construction, field: sel.value };

  sel.value = 'through';
  sel.dispatchEvent(new Event('change'));
  await new Promise(r => setTimeout(r, 200));
  const picked = { state: st.layout.construction, field: sel.value };

  // Round-trip: 'through' survives save and load…
  const saved = JSON.parse(window.__app.serializeProject(false));
  st.layout.construction = 'pocket';
  window.__app.loadProject(saved);
  const roundTrip = st.layout.construction;

  // …and a project written before laser constructions existed (no key at
  // all) loads as the pocket insert it was drawn as.
  const legacy = JSON.parse(window.__app.serializeProject(false));
  delete legacy.layout.construction;
  delete legacy.layout.sheet;
  window.__app.loadProject(legacy);
  const legacyLoad = { construction: st.layout.construction, sheet: st.layout.sheet };

  // A sheet thickness the panel field would refuse is not trusted: 0 or null
  // reads as "absent" to the builder and as the 0.5 mm clamp to the panel,
  // and the panel would then warn about a sheet the export never cut.
  const badSheet = JSON.parse(window.__app.serializeProject(false));
  badSheet.layout.construction = 'through';
  badSheet.layout.sheet = { top: 0, base: null };
  window.__app.loadProject(badSheet);
  const badSheetLoad = { ...st.layout.sheet };

  // Junk in the file is not trusted either.
  const junk = JSON.parse(window.__app.serializeProject(false));
  junk.layout.construction = 'moulded';
  window.__app.loadProject(junk);
  const junkLoad = st.layout.construction;

  $('layoutModal').hidden = true;
  holder.value = 'none';
  holder.dispatchEvent(new Event('change'));
  await new Promise(r => setTimeout(r, 300));
  return { options, dflt, picked, roundTrip, legacyLoad, junkLoad, badSheetLoad };
});

console.log('\nLaser-cut foam constructions (holders.js)');
check('layout construction defaults to pocket and offers all three',
  constrState.dflt.state === 'pocket' && constrState.dflt.field === 'pocket' &&
  constrState.options.join(',') === 'pocket,through,layered',
  `${constrState.dflt.state} / ${constrState.options.join(',')}`);
check('picking a construction in the panel writes it to state',
  constrState.picked.state === 'through' && constrState.picked.field === 'through',
  constrState.picked.state);
check('construction round-trips through save and load',
  constrState.roundTrip === 'through', constrState.roundTrip);
check('a project saved before laser constructions loads as pocket',
  constrState.legacyLoad.construction === 'pocket' &&
  !!constrState.legacyLoad.sheet && constrState.legacyLoad.sheet.top > 0,
  `${constrState.legacyLoad.construction}, sheet ${JSON.stringify(constrState.legacyLoad.sheet)}`);
check('an unknown construction in a project file falls back to pocket',
  constrState.junkLoad === 'pocket', constrState.junkLoad);
check('an unusable sheet thickness in a project file falls back to the default',
  constrState.badSheetLoad.top === 6 && constrState.badSheetLoad.base === 3,
  `top ${constrState.badSheetLoad.top}, base ${constrState.badSheetLoad.base}`);

// The through cut itself: pockets become holes, the sheet is the thickness.
// Volume is the real proof that a hole goes all the way through — a recess
// of the same footprint would leave the floor behind and weigh more.
const cutThrough = await page.evaluate(async () => {
  const { buildLayoutInsert, layoutPockets, roundedRect } = await import('/js/holders.js');
  const badEdges = m => {
    const use = new Map();
    const k = i => `${m.positions[i*3].toFixed(4)},${m.positions[i*3+1].toFixed(4)},${m.positions[i*3+2].toFixed(4)}`;
    for (let t = 0; t < m.indices.length; t += 3) {
      const ks = [k(m.indices[t]), k(m.indices[t+1]), k(m.indices[t+2])];
      if (ks[0] === ks[1] || ks[1] === ks[2] || ks[0] === ks[2]) continue;
      for (let e = 0; e < 3; e++) {
        const a = ks[e], b = ks[(e+1)%3], key = a < b ? a+'|'+b : b+'|'+a;
        use.set(key, (use.get(key) || 0) + 1);
      }
    }
    let bad = 0;
    for (const v of use.values()) if (v !== 2) bad++;
    return bad;
  };
  const volume = m => {
    let v = 0;
    const P = m.positions;
    for (let t = 0; t < m.indices.length; t += 3) {
      const a = m.indices[t] * 3, b = m.indices[t+1] * 3, c = m.indices[t+2] * 3;
      v += (P[a] * (P[b+1] * P[c+2] - P[c+1] * P[b+2])
          - P[a+1] * (P[b] * P[c+2] - P[c] * P[b+2])
          + P[a+2] * (P[b] * P[c+1] - P[c] * P[b+1])) / 6;
    }
    return Math.abs(v);
  };
  const area = pts => {
    let a = 0;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i], q = pts[(i + 1) % pts.length];
      a += p.x * q.y - q.x * p.y;
    }
    return Math.abs(a) / 2;
  };
  const zSet = m => {
    const zs = new Set();
    for (let i = 2; i < m.positions.length; i += 3) zs.add(m.positions[i].toFixed(3));
    return [...zs].sort();
  };

  const toolOutline = [{ x: 5, y: 5 }, { x: 45, y: 5 }, { x: 45, y: 25 }, { x: 5, y: 25 }]; // 40×20
  const mk = (x, y, rot, depth, holes) =>
    ({ name: 't', outer: toolOutline, holes: holes || [], circles: [], x, y, rot, depth, thickness: 6 });
  const container = { outer: roundedRect(5 + 105, 5 + 40, 210, 80, 4) }; // 210×80
  const base = { clearance: 0.5, floor: 3, border: 5, defaultDepth: 6 };
  const items = [mk(60, 45, 0, null), mk(150, 45, 90, 2.5)];

  const cut = buildLayoutInsert(container, items, { ...base, construction: 'through', sheet: 6 });
  const slab = buildLayoutInsert(container, items, base);
  const pk = layoutPockets(items, 0.5);
  const holeArea = pk.reduce((a, p) => a + area(p.pocket), 0);
  const wantCut = (area(container.outer) - holeArea) * 6;

  // Depth deeper than the sheet: built anyway, warned about.
  const deep = buildLayoutInsert(container, [mk(60, 45, 0, 12), mk(150, 45, 90, 2.5)],
    { ...base, construction: 'through', sheet: 6 });
  // A tool hole would leave a pillar standing in mid-air once the floor goes.
  const holed = mk(60, 45, 0, null, [[{ x: 15, y: 10 }, { x: 35, y: 10 }, { x: 35, y: 20 }, { x: 15, y: 20 }]]);
  const pillared = buildLayoutInsert(container, [holed], { ...base, construction: 'through', sheet: 6 });
  const pillarSlab = buildLayoutInsert(container, [holed], base);
  // Layered: the through result at top-sheet thickness, plus the container
  // outline as a plain slab at base thickness under it.
  const layered = buildLayoutInsert(container, items, { ...base, construction: 'layered', sheet: 6, baseSheet: 3 });
  const lTop = layered && layered.parts && layered.parts[0];
  const lBase = layered && layered.parts && layered.parts[1];
  const deepLayered = buildLayoutInsert(container, [mk(60, 45, 0, 12), mk(150, 45, 90, 2.5)],
    { ...base, construction: 'layered', sheet: 6, baseSheet: 3 });
  const pocket = buildLayoutInsert(container, items, base);
  // A sheet thickness of 0 is junk, and the panel reads junk as the 0.5 mm
  // clamp. The builder has to read it the same way: falling back to the 6 mm
  // default here would make the panel describe a sheet the export never cut.
  const zeroSheet = buildLayoutInsert(container, items, { ...base, construction: 'through', sheet: 0 });
  const noSheet = buildLayoutInsert(container, items, { ...base, construction: 'through' });

  return {
    zeroSheetT: zeroSheet?.stats?.slab?.top,
    noSheetT: noSheet?.stats?.slab?.top,
    ok: !!cut && !cut.reason,
    bad: cut && cut.positions ? badEdges(cut) : -1,
    zs: cut ? zSet(cut) : [],
    sizeX: cut?.stats?.sizeX || 0, sizeY: cut?.stats?.sizeY || 0, sizeZ: cut?.stats?.sizeZ || 0,
    vol: cut ? volume(cut) : 0, wantCut,
    slabVol: slab ? volume(slab) : 0,
    construction: cut?.stats?.construction,
    pocketDepth: cut?.stats?.slab?.pocketDepth,
    warns: (cut?.stats?.warnings || []).join(' | '),
    deepWarns: (deep?.stats?.warnings || []).join(' | '),
    pillarBad: pillared && pillared.positions ? badEdges(pillared) : -1,
    pillarWarns: (pillared?.stats?.warnings || []).join(' | '),
    pillarVol: pillared ? volume(pillared) : 0,
    pillarSlabTris: pillarSlab?.stats?.triangles || 0,
    pillarTemplate: pillared?.template?.pockets?.[0]?.pillars?.length,
    slabTemplate: pillarSlab?.template?.pockets?.[0]?.pillars?.length,
    layeredThick: layered?.stats?.slab?.thickness,
    layeredWarns: (layered?.stats?.warnings || []).join(' | '),
    layeredNames: (layered?.parts || []).map(p => p.name).join(','),
    layeredConstruction: layered?.stats?.construction,
    layeredTris: layered?.stats?.triangles,
    partTris: (lTop?.stats?.triangles || 0) + (lBase?.stats?.triangles || 0),
    layeredZs: layered ? zSet(layered) : [],
    layeredVol: layered ? volume(layered) : 0,
    topBad: lTop ? badEdges(lTop) : -1,
    baseBad: lBase ? badEdges(lBase) : -1,
    topVol: lTop ? volume(lTop) : 0,
    baseVol: lBase ? volume(lBase) : 0,
    wantBase: area(container.outer) * 3,
    topZs: lTop ? zSet(lTop) : [],
    baseZs: lBase ? zSet(lBase) : [],
    layeredTop: layered?.stats?.slab?.top,
    layeredBase: layered?.stats?.slab?.base,
    layeredPocketDepth: layered?.stats?.slab?.pocketDepth,
    deepLayeredWarns: (deepLayered?.stats?.warnings || []).join(' | '),
    deepLayeredThick: deepLayered?.stats?.slab?.thickness,
    cutNames: (cut?.parts || []).map(p => p.name).join(','),
    pocketNames: (pocket?.parts || []).map(p => p.name).join(','),
  };
});

check('through-cut insert builds watertight',
  cutThrough.ok && cutThrough.bad === 0, `${cutThrough.bad} open edges`);
check('the sheet is the thickness and the footprint is unchanged (210 × 80 × 6)',
  near(cutThrough.sizeX, 210, 0.2) && near(cutThrough.sizeY, 80, 0.2) &&
  near(cutThrough.sizeZ, 6, 1e-6),
  `${cutThrough.sizeX.toFixed(1)} × ${cutThrough.sizeY.toFixed(1)} × ${cutThrough.sizeZ}`);
check('every pocket is a hole clean through — volume matches the sheet minus the pockets',
  Math.abs(cutThrough.vol - cutThrough.wantCut) < cutThrough.wantCut * 0.002 &&
  cutThrough.slabVol > cutThrough.vol * 1.2,
  `${cutThrough.vol.toFixed(0)} mm³ vs ${cutThrough.wantCut.toFixed(0)} wanted; pocket slab ${cutThrough.slabVol.toFixed(0)}`);
check('a through cut has no intermediate floors — every vertex is on one face or the other',
  cutThrough.zs.join(',') === '0.000,6.000', cutThrough.zs.join(','));
check('per-item depths are ignored in a through cut, with a visible warning',
  cutThrough.pocketDepth === 6 && /depths are ignored/.test(cutThrough.warns) &&
  cutThrough.construction === 'through',
  cutThrough.warns);
check('a tool deeper than the sheet is warned about, not silently flattened',
  /stand proud/.test(cutThrough.deepWarns) && /depths are ignored/.test(cutThrough.deepWarns),
  cutThrough.deepWarns);
check('support pillars are dropped from a through cut, mesh and template alike',
  cutThrough.pillarBad === 0 && /pillars/.test(cutThrough.pillarWarns) &&
  cutThrough.pillarTemplate === 0 && cutThrough.slabTemplate === 1,
  `${cutThrough.pillarBad} open edges, template pillars ${cutThrough.pillarTemplate} vs ${cutThrough.slabTemplate}`);
check('layered returns two named parts, the cut top sheet and the contrast base',
  cutThrough.layeredNames === 'top,base' && cutThrough.layeredConstruction === 'layered',
  `${cutThrough.layeredNames} (${cutThrough.layeredConstruction})`);
check('each layered part is watertight on its own — one shell per cut sheet',
  cutThrough.topBad === 0 && cutThrough.baseBad === 0,
  `top ${cutThrough.topBad}, base ${cutThrough.baseBad} open edges`);
check('the assembled preview is the two parts stacked, nothing fused',
  cutThrough.layeredTris === cutThrough.partTris &&
  Math.abs(cutThrough.layeredVol - (cutThrough.topVol + cutThrough.baseVol)) < 1e-3 &&
  cutThrough.layeredZs.join(',') === '0.000,3.000,9.000',
  `${cutThrough.layeredTris} vs ${cutThrough.partTris} triangles, z ${cutThrough.layeredZs.join(',')}`);
check('the layered top sheet is the through cut, sitting on the base',
  Math.abs(cutThrough.topVol - cutThrough.wantCut) < cutThrough.wantCut * 0.002 &&
  cutThrough.topZs.join(',') === '3.000,9.000',
  `${cutThrough.topVol.toFixed(0)} mm³ vs ${cutThrough.wantCut.toFixed(0)}, z ${cutThrough.topZs.join(',')}`);
check('the layered base is a plain slab at base thickness — no pockets in it',
  Math.abs(cutThrough.baseVol - cutThrough.wantBase) < cutThrough.wantBase * 0.002 &&
  cutThrough.baseZs.join(',') === '0.000,3.000',
  `${cutThrough.baseVol.toFixed(0)} mm³ vs ${cutThrough.wantBase.toFixed(0)}, z ${cutThrough.baseZs.join(',')}`);
check('the layered stack reports top, base and glued thickness',
  cutThrough.layeredTop === 6 && cutThrough.layeredBase === 3 &&
  cutThrough.layeredThick === 9 && cutThrough.layeredPocketDepth === 6,
  `top ${cutThrough.layeredTop}, base ${cutThrough.layeredBase}, stack ${cutThrough.layeredThick}`);
check('a tool deeper than the one top sheet warns instead of stacking sheets',
  /stand proud/.test(cutThrough.deepLayeredWarns) &&
  /depths are ignored/.test(cutThrough.deepLayeredWarns) &&
  cutThrough.deepLayeredThick === 9,
  cutThrough.deepLayeredWarns);
check('a sheet thickness of 0 clamps as the panel clamps it, not to the default',
  cutThrough.zeroSheetT === 0.5 && cutThrough.noSheetT === 6,
  `sheet 0 builds ${cutThrough.zeroSheetT} mm, no sheet builds ${cutThrough.noSheetT} mm`);
check('pocket and through builds stay one part',
  cutThrough.cutNames === 'insert' && cutThrough.pocketNames === 'insert',
  `through "${cutThrough.cutNames}", pocket "${cutThrough.pocketNames}"`);

// Base-layer labels: engraved into the contrast sheet, inside the pocket
// footprint, which is legal there because the base has nothing else cut in it.
const baseLabels = await page.evaluate(async () => {
  const { buildLayoutInsert, layoutLabelGeometry, layoutLabelConflicts, layoutPockets, roundedRect } =
    await import('/js/holders.js');
  const badEdges = m => {
    const use = new Map();
    const k = i => `${m.positions[i*3].toFixed(4)},${m.positions[i*3+1].toFixed(4)},${m.positions[i*3+2].toFixed(4)}`;
    for (let t = 0; t < m.indices.length; t += 3) {
      const ks = [k(m.indices[t]), k(m.indices[t+1]), k(m.indices[t+2])];
      if (ks[0] === ks[1] || ks[1] === ks[2] || ks[0] === ks[2]) continue;
      for (let e = 0; e < 3; e++) {
        const a = ks[e], b = ks[(e+1)%3], key = a < b ? a+'|'+b : b+'|'+a;
        use.set(key, (use.get(key) || 0) + 1);
      }
    }
    let bad = 0;
    for (const v of use.values()) if (v !== 2) bad++;
    return bad;
  };
  const inPoly = (pt, poly) => {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const a = poly[i], b = poly[j];
      if ((a.y > pt.y) !== (b.y > pt.y) &&
          pt.x < (b.x - a.x) * (pt.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
    }
    return inside;
  };
  const bboxOf = pts => {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of pts) {
      minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
      minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
    }
    return { minX, minY, maxX, maxY };
  };

  const toolOutline = [{ x: 5, y: 5 }, { x: 45, y: 5 }, { x: 45, y: 25 }, { x: 5, y: 25 }];
  const mk = (name, x, y) =>
    ({ name, outer: toolOutline, holes: [], circles: [], x, y, rot: 0, depth: 4, thickness: 4 });
  const items = [mk('T1', 60, 45), mk('T2', 150, 45)];
  const container = { outer: roundedRect(5 + 105, 5 + 40, 210, 80, 4) };
  const pockets = layoutPockets(items, 0.5);
  const cfg = { enabled: true, height: 6, margin: 2, process: 'laser', border: 5 };
  const beside = layoutLabelGeometry(items, pockets, cfg);
  const inside = layoutLabelGeometry(items, pockets, { ...cfg, inside: true });
  const pb = bboxOf(pockets[0].pocket);

  const asMesh = (placed, layer) => placed.map(L =>
    ({ loops: L.loops, mode: 'deboss', face: 'top', layer, size: 0.6 }));
  const opt = { clearance: 0.5, floor: 3, border: 5, defaultDepth: 6,
    construction: 'layered', sheet: 6, baseSheet: 3 };
  const bare = buildLayoutInsert(container, items, opt);
  const onBase = buildLayoutInsert(container, items, { ...opt, labels: asMesh(inside, 'base') });
  const onTop = buildLayoutInsert(container, items, { ...opt, labels: asMesh(beside, 'top') });
  // A pocket insert has no base sheet, so a base label falls back to the top.
  const noBase = buildLayoutInsert(container, items,
    { clearance: 0.5, floor: 3, border: 5, defaultDepth: 6, labels: asMesh(inside, 'base') });

  const glyphs = inside[0].loops.flat();
  const huge = layoutLabelGeometry(items, pockets, { ...cfg, height: 30, inside: true });

  return {
    insideAt: inside[0].at, besideAt: beside[0].at,
    pocketMid: { x: (pb.minX + pb.maxX) / 2, y: (pb.minY + pb.maxY) / 2 }, pocketBottom: pb.maxY,
    insideFlag: inside.map(L => L.inside).join(','), besideFlag: beside.map(L => L.inside).join(','),
    glyphsInPocket: glyphs.every(p => inPoly(p, pockets[0].pocket)),
    glyphCount: glyphs.length,
    bareBaseLabels: bare.stats.baseLabels, onBaseLabels: onBase.stats.baseLabels,
    onTopLabels: onTop.stats.baseLabels, noBaseLabels: noBase.stats.baseLabels,
    bareTris: bare.parts.map(p => p.stats.triangles),
    onBaseTris: onBase.parts.map(p => p.stats.triangles),
    onTopTris: onTop.parts.map(p => p.stats.triangles),
    noBaseTris: noBase.stats.triangles,
    noBaseBare: buildLayoutInsert(container, items,
      { clearance: 0.5, floor: 3, border: 5, defaultDepth: 6 }).stats.triangles,
    topBad: badEdges(onBase.parts[0]), baseBad: badEdges(onBase.parts[1]),
    ownPocketIssues: layoutLabelConflicts(container.outer, pockets, inside, { ...cfg, inside: true })
      .map(x => x.kind).join(','),
    // Same glyphs, judged by the beside-the-pocket rules: now it IS a clash.
    besideOnPocket: layoutLabelConflicts(container.outer, pockets,
      inside.map(L => ({ ...L, inside: false })), cfg).map(x => x.kind).join(','),
    hugeIssues: layoutLabelConflicts(container.outer, pockets, huge, { ...cfg, inside: true })
      .map(x => x.kind).join(','),
  };
});

check('a base label defaults to its pocket centroid, not beside the pocket',
  Math.abs(baseLabels.insideAt.x - baseLabels.pocketMid.x) < 0.01 &&
  Math.abs(baseLabels.insideAt.y - baseLabels.pocketMid.y) < 0.01 &&
  baseLabels.besideAt.y > baseLabels.pocketBottom &&
  baseLabels.insideFlag === 'true,true' && baseLabels.besideFlag === 'false,false',
  `inside ${JSON.stringify(baseLabels.insideAt)} vs centroid ${JSON.stringify(baseLabels.pocketMid)}, beside y ${baseLabels.besideAt.y.toFixed(1)}`);
check('every glyph of a base label lands inside the pocket footprint',
  baseLabels.glyphsInPocket && baseLabels.glyphCount > 3,
  `${baseLabels.glyphCount} points, all inside ${baseLabels.glyphsInPocket}`);
check('base labels are engraved into the base part, leaving the top sheet alone',
  baseLabels.onBaseLabels === 2 && baseLabels.bareBaseLabels === 0 &&
  baseLabels.onBaseTris[1] > baseLabels.bareTris[1] &&
  baseLabels.onBaseTris[0] === baseLabels.bareTris[0],
  `base ${baseLabels.bareTris[1]} -> ${baseLabels.onBaseTris[1]} tris, top ${baseLabels.bareTris[0]} -> ${baseLabels.onBaseTris[0]}`);
check('labels kept on the top sheet cut the top sheet instead',
  baseLabels.onTopLabels === 0 && baseLabels.onTopTris[0] > baseLabels.bareTris[0] &&
  baseLabels.onTopTris[1] === baseLabels.bareTris[1],
  `top ${baseLabels.bareTris[0]} -> ${baseLabels.onTopTris[0]}, base ${baseLabels.onTopTris[1]}`);
check('a base label on a construction with no base sheet falls back to the top',
  baseLabels.noBaseLabels === 0 && baseLabels.noBaseTris > baseLabels.noBaseBare,
  `${baseLabels.noBaseBare} -> ${baseLabels.noBaseTris} triangles`);
check('a labelled layered build stays watertight in both parts',
  baseLabels.topBad === 0 && baseLabels.baseBad === 0,
  `top ${baseLabels.topBad}, base ${baseLabels.baseBad} open edges`);
check('a label inside its own pocket is intended, not a conflict',
  baseLabels.ownPocketIssues === '' && /pocket/.test(baseLabels.besideOnPocket),
  `inside "${baseLabels.ownPocketIssues}", beside-rules "${baseLabels.besideOnPocket}"`);
check('a base label spilling out of its silhouette is reported as covered',
  /covered/.test(baseLabels.hugeIssues), baseLabels.hugeIssues);

// The panel and the 3D preview: the select drives the build, the sheet field
// appears, the floor field goes dead, and the warning is on screen.
const cutUI = await page.evaluate(async () => {
  const $ = id => document.getElementById(id);
  const st = window.__app.state;
  st.layout.items = [{
    name: 'deep tool', outer: [{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 50, y: 16 }, { x: 0, y: 16 }],
    holes: [], circles: [], thickness: 5, depth: 12, rot: 0, x: 110, y: 55,
  }];
  const holder = $('holderType');
  holder.value = 'layout';
  holder.dispatchEvent(new Event('change'));
  await new Promise(r => setTimeout(r, 250));
  const asPocket = {
    sheetRow: !$('laySheetRow').hidden, floorOff: $('layFloor').disabled,
    warn: !$('layConstructionWarn').hidden, info: $('meshInfo').textContent,
  };

  $('layConstruction').value = 'through';
  $('layConstruction').dispatchEvent(new Event('change'));
  await new Promise(r => setTimeout(r, 400));
  const asThrough = {
    sheetRow: !$('laySheetRow').hidden, floorOff: $('layFloor').disabled,
    warn: $('layConstructionWarn').hidden ? '' : $('layConstructionWarn').textContent,
    panel: $('layoutInfo').textContent,
    info: $('meshInfo').textContent,
    meshWarn: $('meshWarn').hidden ? '' : $('meshWarn').textContent,
    thick: st.holderMesh ? st.holderMesh.stats.slab.thickness : 0,
    construction: st.holderMesh ? st.holderMesh.stats.construction : '',
  };

  // A thicker sheet flows straight into the build.
  $('laySheetTop').value = '15';
  $('laySheetTop').dispatchEvent(new Event('change'));
  await new Promise(r => setTimeout(r, 400));
  const thicker = {
    thick: st.holderMesh ? st.holderMesh.stats.slab.thickness : 0,
    warn: $('layConstructionWarn').hidden ? '' : $('layConstructionWarn').textContent,
  };

  // Restore: pocket, default sheet, no items, no holder.
  $('laySheetTop').value = '6';
  $('laySheetTop').dispatchEvent(new Event('change'));
  $('layConstruction').value = 'pocket';
  $('layConstruction').dispatchEvent(new Event('change'));
  await new Promise(r => setTimeout(r, 200));
  st.layout.items.length = 0;
  window.__app.refreshLayoutEditor();
  $('layoutModal').hidden = true;
  holder.value = 'none';
  holder.dispatchEvent(new Event('change'));
  await new Promise(r => setTimeout(r, 300));
  const restored = {
    construction: st.layout.construction, sheet: st.layout.sheet.top,
    items: st.layout.items.length, sheetRow: !$('laySheetRow').hidden,
    warn: !$('layConstructionWarn').hidden, floorOff: $('layFloor').disabled,
  };
  return { asPocket, asThrough, thicker, restored };
});

check('the sheet field and the depth warning are hidden for a pocket insert',
  !cutUI.asPocket.sheetRow && !cutUI.asPocket.floorOff && !cutUI.asPocket.warn,
  `sheet row ${cutUI.asPocket.sheetRow}, floor disabled ${cutUI.asPocket.floorOff}`);
check('choosing through shows the sheet field and retires the floor field',
  cutUI.asThrough.sheetRow && cutUI.asThrough.floorOff,
  `sheet row ${cutUI.asThrough.sheetRow}, floor disabled ${cutUI.asThrough.floorOff}`);
check('the panel warns in place that per-item depths are ignored',
  /depths are ignored/.test(cutUI.asThrough.warn) && /stand proud/.test(cutUI.asThrough.warn) &&
  /cut through/.test(cutUI.asThrough.panel),
  `${cutUI.asThrough.warn} — ${cutUI.asThrough.panel}`);
check('the 3D preview builds the through cut and reports the sheet, not a depth',
  cutUI.asThrough.construction === 'through' && cutUI.asThrough.thick === 6 &&
  /through cut/.test(cutUI.asThrough.info) && /cut through the full/.test(cutUI.asThrough.info) &&
  /depths are ignored/.test(cutUI.asThrough.meshWarn),
  cutUI.asThrough.info.split('\n')[0]);
check('a thicker sheet rebuilds thicker and clears the stands-proud warning',
  cutUI.thicker.thick === 15 && !/stand proud/.test(cutUI.thicker.warn),
  `${cutUI.thicker.thick} mm — ${cutUI.thicker.warn}`);
check('leaving the through cut restores the pocket panel',
  cutUI.restored.construction === 'pocket' && cutUI.restored.sheet === 6 &&
  cutUI.restored.items === 0 && !cutUI.restored.sheetRow && !cutUI.restored.warn &&
  !cutUI.restored.floorOff,
  JSON.stringify(cutUI.restored));

// The layered build end to end: the panel grows a base-sheet field, the
// preview shows the glued stack, and the export writes one STL per part.
const layUI = await page.evaluate(async () => {
  const $ = id => document.getElementById(id);
  const st = window.__app.state;
  st.layout.items = [{
    name: 'layered tool', outer: [{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 50, y: 16 }, { x: 0, y: 16 }],
    holes: [], circles: [], thickness: 5, depth: 4, rot: 0, x: 110, y: 55,
  }];
  const holder = $('holderType');
  holder.value = 'layout';
  holder.dispatchEvent(new Event('change'));
  await new Promise(r => setTimeout(r, 250));
  const baseFieldAsThrough = (() => {
    $('layConstruction').value = 'through';
    $('layConstruction').dispatchEvent(new Event('change'));
    return !$('laySheetBaseField').hidden;
  })();

  $('layConstruction').value = 'layered';
  $('layConstruction').dispatchEvent(new Event('change'));
  await new Promise(r => setTimeout(r, 400));
  const asLayered = {
    baseField: !$('laySheetBaseField').hidden, sheetRow: !$('laySheetRow').hidden,
    floorOff: $('layFloor').disabled,
    panel: $('layoutInfo').textContent,
    warn: $('layConstructionWarn').hidden ? '' : $('layConstructionWarn').textContent,
    info: $('meshInfo').textContent,
    construction: st.holderMesh ? st.holderMesh.stats.construction : '',
    thick: st.holderMesh ? st.holderMesh.stats.slab.thickness : 0,
    parts: st.holderMesh && st.holderMesh.parts ? st.holderMesh.parts.map(p => p.name).join(',') : '',
  };

  // A thicker base flows straight into the stack.
  $('laySheetBase').value = '5';
  $('laySheetBase').dispatchEvent(new Event('change'));
  await new Promise(r => setTimeout(r, 400));
  const thickerBase = {
    stored: st.layout.sheet.base,
    thick: st.holderMesh ? st.holderMesh.stats.slab.thickness : 0,
  };
  // Tool labels go on the contrast base by default here, and the toggle puts
  // them back beside the pockets on the top sheet.
  $('layLabels').checked = true;
  $('layLabels').dispatchEvent(new Event('change'));
  await new Promise(r => setTimeout(r, 400));
  const labelled = {
    row: !$('layLabelBaseRow').hidden, checked: $('layLabelBase').checked,
    onBase: st.holderMesh ? st.holderMesh.stats.baseLabels : -1,
  };
  $('layLabelBase').checked = false;
  $('layLabelBase').dispatchEvent(new Event('change'));
  await new Promise(r => setTimeout(r, 400));
  const movedUp = {
    stored: st.layout.labels.onBase,
    onBase: st.holderMesh ? st.holderMesh.stats.baseLabels : -1,
  };
  $('layLabelBase').checked = true;
  $('layLabelBase').dispatchEvent(new Event('change'));
  $('layLabels').checked = false;
  $('layLabels').dispatchEvent(new Event('change'));
  await new Promise(r => setTimeout(r, 300));
  const modal = $('layoutModal');
  if (modal) modal.hidden = false;
  return { baseFieldAsThrough, asLayered, thickerBase, labelled, movedUp };
});

check('the base-sheet field belongs to the layered build alone',
  !layUI.baseFieldAsThrough && layUI.asLayered.baseField && layUI.asLayered.sheetRow &&
  layUI.asLayered.floorOff,
  `through ${layUI.baseFieldAsThrough}, layered ${layUI.asLayered.baseField}`);
check('the layered preview builds both parts and reports the glued stack',
  layUI.asLayered.construction === 'layered' && layUI.asLayered.thick === 9 &&
  layUI.asLayered.parts === 'top,base' && /layered/.test(layUI.asLayered.info) &&
  /contrast base/.test(layUI.asLayered.info),
  `${layUI.asLayered.parts} — ${layUI.asLayered.info.split('\n')[0]}`);
check('the layout panel names both sheets and still warns about the depths',
  /top sheet on a/.test(layUI.asLayered.panel) && /depths are ignored/.test(layUI.asLayered.warn),
  `${layUI.asLayered.panel} — ${layUI.asLayered.warn}`);
check('a thicker base rebuilds the stack',
  layUI.thickerBase.stored === 5 && layUI.thickerBase.thick === 11,
  `${layUI.thickerBase.stored} mm base, ${layUI.thickerBase.thick} mm stack`);
check('turning labels on engraves them into the base of a layered build',
  layUI.labelled.row && layUI.labelled.checked && layUI.labelled.onBase === 1,
  `row ${layUI.labelled.row}, ${layUI.labelled.onBase} label(s) on the base`);
check('unticking the base-label option moves the labels back to the top sheet',
  layUI.movedUp.stored === false && layUI.movedUp.onBase === 0,
  `stored ${layUI.movedUp.stored}, ${layUI.movedUp.onBase} on the base`);
{
  const names = [];
  const onDownload = d => names.push(d.suggestedFilename());
  page.on('download', onDownload);
  await page.click('#layExportBtn');
  await new Promise(r => setTimeout(r, 2500));
  page.off('download', onDownload);
  check('a layered export writes one STL file per part',
    names.length === 2 && names.some(n => /-top-2p5d\.stl$/.test(n)) &&
    names.some(n => /-base-2p5d\.stl$/.test(n)),
    names.join(', ') || 'no download event');
  // The recovery links are the only way out of a view that blocks the
  // programmatic saves, so a two-part export has to leave both files
  // clickable — not just the last one written.
  const recover = await page.evaluate(async () => {
    const $ = id => document.getElementById(id);
    const links = [$('exportFallbackLink'), ...$('exportFallbackExtra').querySelectorAll('a')];
    const out = [];
    for (const a of links) {
      let size = -1;
      try { size = (await (await fetch(a.href)).blob()).size; } catch { size = -1; }
      out.push({ name: a.download, size });
    }
    return { shown: !$('exportFallback').hidden, named: $('exportFallbackName').textContent, links: out };
  });
  const liveTop = recover.links.find(l => /-top-2p5d\.stl$/.test(l.name));
  const liveBase = recover.links.find(l => /-base-2p5d\.stl$/.test(l.name));
  check('both parts of a layered export keep a live recovery link',
    recover.shown && recover.links.length === 2 &&
    !!liveTop && liveTop.size > 0 && !!liveBase && liveBase.size > 0 &&
    /-top-2p5d\.stl$/.test(recover.named),
    recover.links.map(l => `${l.name} ${l.size}b`).join(', ') || 'no links');
}
// The cut template for a layered build: two sheets, the through-cut top and
// the contrast base, and the label artwork split between them. Exercised on
// the exporters directly first (exact markup), then through the panel.
const svgLayers = await page.evaluate(async () => {
  const { toSVG, toTiledSVG } = await import('/js/exporters.js');
  const rect = (x, y, w, h) => [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];
  const outline = rect(0, 0, 100, 60);
  const hole = rect(20, 20, 30, 20);
  const glyph = rect(25, 25, 5, 5);
  const plain = await toSVG(outline, [hole], 100, 60, { engrave: [glyph] }).text();
  const layered = await toSVG(outline, [hole], 100, 60,
    { base: { outline, engrave: [glyph] } }).text();

  const tile = (col, holes, marks) => ({
    col, row: 0, w: 50, h: 60, slabs: [rect(0, 0, 50, 60)], holes, marks,
  });
  const top = [tile(0, [rect(10, 10, 20, 20)], []), tile(1, [], [])];
  const base = [tile(0, [], [glyph]), tile(1, [], [])];
  const tiledPlain = await toTiledSVG(top, { name: 'drawer' }).text();
  const tiledBase = await toTiledSVG(top, { name: 'drawer', base }).text();
  return { plain, layered, tiledPlain, tiledBase };
});

check('a single-sheet cut template still has no base layer',
  !svgLayers.plain.includes('id="base"') && !svgLayers.plain.includes('base-engrave') &&
  svgLayers.plain.includes('width="100mm"') && svgLayers.plain.includes('id="engrave"'),
  svgLayers.plain.split('\n')[2]);
check('a layered cut template puts the base sheet beside the top in its own layer',
  svgLayers.layered.includes('id="base"') &&
  svgLayers.layered.includes('width="210mm"') &&
  svgLayers.layered.includes('viewBox="0 0 210 60"') &&
  svgLayers.layered.includes('M 110.000,0.000'),
  svgLayers.layered.split('\n')[2]);
check('base label artwork engraves on the base layer, never into the top sheet',
  svgLayers.layered.includes('id="base-engrave"') &&
  svgLayers.layered.includes('135.000,25.000') &&
  !/id="engrave"/.test(svgLayers.layered),
  svgLayers.layered.includes('id="base-engrave"') ? 'base-engrave only' : 'missing');
check('a tiled template without a base is unchanged',
  !svgLayers.tiledPlain.includes('id="base"') &&
  svgLayers.tiledPlain.includes('height="60.000mm"') &&
  (svgLayers.tiledPlain.match(/<text /g) || []).length === 2,
  svgLayers.tiledPlain.split('\n')[2]);
check('a layered tiled template adds the base tile set below the top grid',
  svgLayers.tiledBase.includes('id="base"') && svgLayers.tiledBase.includes('id="base-marks"') &&
  svgLayers.tiledBase.includes('id="base-engrave"') &&
  svgLayers.tiledBase.includes('height="150.000mm"') &&
  svgLayers.tiledBase.includes('translate(0.000,90.000)') &&
  svgLayers.tiledBase.includes('>A1 base —'),
  svgLayers.tiledBase.split('\n')[3]);

// The base tiles are the top sheet's seams with no pockets and no tabs, so
// the two sheets glue up square (PRD Part D, open question 2).
const baseTiles = await page.evaluate(async () => {
  const { splitTiles } = await import('/js/holders.js');
  const rect = (x0, y0, x1, y1) => [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }];
  const template = {
    construction: 'layered', slab: rect(0, 0, 550, 380), origin: { x: 0, y: 0 }, w: 550, h: 380,
    pockets: [
      { pocket: rect(60, 40, 200, 120), pillars: [] },
      { pocket: rect(380, 260, 500, 340), pillars: [] },
    ],
  };
  const glyph = rect(100, 60, 140, 80); // a base label inside the first pocket
  const top = splitTiles(template, 300, 200, { tabs: { enabled: true } });
  const base = splitTiles({ ...template, pockets: [] }, 300, 200,
    { labels: [glyph], seams: { x: top.seamsX, y: top.seamsY } });
  const corners = t => t.slabs.reduce((n, l) => n + l.length, 0);
  return {
    topSeams: `${top.seamsX.join(',')} / ${top.seamsY.join(',')}`,
    baseSeams: `${base.seamsX.join(',')} / ${base.seamsY.join(',')}`,
    tiles: [top.tiles.length, base.tiles.length],
    aligned: top.tiles.every((t, i) => t.x0 === base.tiles[i].x0 && t.y0 === base.tiles[i].y0),
    tabs: [top.tabs, base.tabs, top.tabCount],
    holes: base.tiles.reduce((n, t) => n + t.holes.length, 0),
    marks: base.tiles.reduce((n, t) => n + t.marks.length, 0),
    topCorners: Math.max(...top.tiles.map(corners)),
    baseCorners: Math.max(...base.tiles.map(corners)),
  };
});
check('the base sheet tiles on exactly the top sheet\'s seams',
  baseTiles.topSeams === baseTiles.baseSeams && baseTiles.tiles[0] === baseTiles.tiles[1] &&
  baseTiles.tiles[0] === 4 && baseTiles.aligned,
  `${baseTiles.topSeams} vs ${baseTiles.baseSeams}, ${baseTiles.tiles.join('/')} tiles`);
check('the base sheet carries the base engraving, no pockets and no puzzle tabs',
  baseTiles.holes === 0 && baseTiles.marks === 1 &&
  baseTiles.tabs[0] === true && baseTiles.tabs[1] === false && baseTiles.tabs[2] > 0 &&
  baseTiles.baseCorners === 4 && baseTiles.topCorners > 4,
  `${baseTiles.holes} holes, ${baseTiles.marks} engraved, tabs ${baseTiles.tabs.join('/')}, ` +
  `corners ${baseTiles.baseCorners} vs ${baseTiles.topCorners}`);

// End to end: the panel exports one file holding both sheets, with the tool
// labels on the base where they read through the silhouette.
await page.evaluate(async () => {
  const $ = id => document.getElementById(id);
  $('layLabels').checked = true;
  $('layLabels').dispatchEvent(new Event('change'));
  await new Promise(r => setTimeout(r, 400));
});
{
  const [dl] = await Promise.all([
    page.waitForEvent('download', { timeout: 10000 }).catch(() => null),
    page.click('#layExportSvgBtn'),
  ]);
  const fp = dl ? await dl.path().catch(() => null) : null;
  const txt = fp ? fs.readFileSync(fp, 'utf8') : '';
  check('the layered cut template downloads both sheets in one file',
    !!dl && /-drawer-template\.svg$/.test(dl.suggestedFilename()) &&
    txt.includes('id="base"') && txt.includes('id="base-engrave"') &&
    !txt.includes('id="engrave"'),
    dl ? `${dl.suggestedFilename()}: base ${txt.includes('id="base"')}, ` +
      `base-engrave ${txt.includes('id="base-engrave"')}, top engrave ${txt.includes('id="engrave"')}`
      : 'no download event');
  // One file this time: the extra links from the two-part STL export before
  // it are gone, so the recovery paragraph never offers a stale download.
  const single = await page.evaluate(() => ({
    named: document.getElementById('exportFallbackName').textContent,
    extra: document.getElementById('exportFallbackExtra').querySelectorAll('a').length,
  }));
  check('a single-file export leaves only its own recovery link',
    single.extra === 0 && /-drawer-template\.svg$/.test(single.named),
    `${single.named}, ${single.extra} extra link(s)`);
}
await page.evaluate(async () => {
  const $ = id => document.getElementById(id);
  $('layLabels').checked = false;
  $('layLabels').dispatchEvent(new Event('change'));
  await new Promise(r => setTimeout(r, 300));
});
const layRestore = await page.evaluate(async () => {
  const $ = id => document.getElementById(id);
  const st = window.__app.state;
  $('laySheetBase').value = '3';
  $('laySheetBase').dispatchEvent(new Event('change'));
  $('layConstruction').value = 'pocket';
  $('layConstruction').dispatchEvent(new Event('change'));
  await new Promise(r => setTimeout(r, 200));
  st.layout.items.length = 0;
  window.__app.refreshLayoutEditor();
  const modal = $('layoutModal');
  if (modal) modal.hidden = true;
  const holder = $('holderType');
  holder.value = 'none';
  holder.dispatchEvent(new Event('change'));
  await new Promise(r => setTimeout(r, 300));
  return {
    construction: st.layout.construction, top: st.layout.sheet.top, base: st.layout.sheet.base,
    items: st.layout.items.length, sheetRow: !$('laySheetRow').hidden,
    baseField: !$('laySheetBaseField').hidden, warn: !$('layConstructionWarn').hidden,
    floorOff: $('layFloor').disabled, labelRow: !$('layLabelBaseRow').hidden,
    labels: st.layout.labels.enabled, onBase: st.layout.labels.onBase,
  };
});
check('leaving the layered build restores the pocket panel',
  layRestore.construction === 'pocket' && layRestore.top === 6 && layRestore.base === 3 &&
  layRestore.items === 0 && !layRestore.sheetRow && !layRestore.baseField &&
  !layRestore.warn && !layRestore.floorOff && !layRestore.labelRow &&
  layRestore.labels === false && layRestore.onBase === true,
  JSON.stringify(layRestore));

// ---------- nesting / auto-sort (holders.js, docs/nesting_prd_v1.1.md) ----------
//
// nestLayout() is pure geometry and deliberately has no UI yet: the Nest
// button, the profile panel and the custom-profile store are that PRD's later
// steps. So this block drives the module straight and touches no page state at
// all — there is nothing here to set up, and nothing for it to restore for the
// blocks that follow.

const nestFix = await page.evaluate(async () => {
  const { nestLayout, applyNest, layoutPockets, layoutConflicts, roundedRect } =
    await import('/js/holders.js');
  const rect = (w, h) => [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }];
  // An L with arm thickness t: a w × h bbox with a big bite out of the top
  // right, so two of them only both fit once one turns round and tucks in.
  const ell = (w, h, t) => [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: t },
    { x: t, y: t }, { x: t, y: h }, { x: 0, y: h }];
  const mk = (name, outer, extra = {}) => ({
    name, outer, holes: [], circles: [], x: 0, y: 0, rot: 0, depth: null,
    thickness: 6, ...extra,
  });
  const drawer = (w, h) => roundedRect(w / 2, h / 2, w, h, 4);
  const bbox = pts => {
    let minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9;
    for (const p of pts) {
      minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
      minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
    }
    return { minX, minY, maxX, maxY, w: maxX - minX, h: maxY - minY };
  };
  // The pockets for exactly what the nester says it placed, rebuilt the way
  // the editor would after applying the result.
  const boxesOf = (items, res) => {
    const moved = applyNest(items, res);
    return layoutPockets(res.placements.map(p => moved[p.i]), 0.5);
  };
  const clash = (outer, items, res, border = 5) => {
    const cf = layoutConflicts(outer, boxesOf(items, res), border);
    return [cf.collisions.size, cf.escaped.size];
  };
  // A mixed 12-tool set, fabricated rather than traced, so the fixtures do not
  // depend on the photo pipeline at all.
  const mixed = () => {
    const out = [];
    for (let k = 0; k < 12; k++) {
      out.push(k % 3 === 0 ? mk('L' + k, ell(50 + k, 30 + k, 12))
        : k % 3 === 1 ? mk('r' + k, rect(60 - k, 18 + k))
          : mk('s' + k, rect(24 + k, 24 + k)));
    }
    return out;
  };

  // 1. Two rectangles that cannot sit side by side have to take a second row,
  //    and the settle pass must leave exactly minWeb between the rows rather
  //    than whatever the coarse anchor grid handed it.
  const stackItems = [mk('a', rect(40, 20)), mk('b', rect(40, 20))];
  const stackC = drawer(60, 120);
  const stack = nestLayout(stackC, stackItems, { rotationStep: 90 });
  const sb = boxesOf(stackItems, stack).map(g => bbox(g.pocket))
    .sort((p, q) => p.minY - q.minY);
  const stackGap = sb.length === 2 ? sb[1].minY - sb[0].maxY : -1;

  // 2. Two Ls: the greedy true-outline test has to let the second one tuck
  //    into the first one's concavity, which bbox packing cannot do.
  const tuckItems = [mk('L1', ell(60, 40, 14)), mk('L2', ell(60, 40, 14))];
  const tuckC = drawer(200, 140);
  const before = JSON.stringify(tuckItems);
  const tuck = nestLayout(tuckC, tuckItems, {});
  const tb = boxesOf(tuckItems, tuck).map(g => bbox(g.pocket));
  const tuckOverlap = tb.length === 2 &&
    Math.min(tb[0].maxX, tb[1].maxX) - Math.max(tb[0].minX, tb[1].minX) > 1 &&
    Math.min(tb[0].maxY, tb[1].maxY) - Math.max(tb[0].minY, tb[1].minY) > 1;
  const tuckMoved = applyNest(tuckItems, tuck);

  // 3. An L that is too wide for the drawer flat has to turn to fit.
  const spinItems = [mk('L', ell(60, 40, 14))];
  const spin = nestLayout(drawer(62, 82), spinItems, { rotationStep: 90 });

  // 4 + 5. Honest failure: too large in every orientation vs. simply no room.
  const hugeItems = [mk('crowbar', rect(200, 200))];
  const huge = nestLayout(drawer(60, 60), hugeItems, { rotationStep: 90 });
  const fullItems = Array.from({ length: 8 }, (_, k) => mk('c' + k, rect(50, 30)));
  const fullC = drawer(150, 110);
  const full = nestLayout(fullC, fullItems, { rotationStep: 90 });

  // 6. Determinism, and 7. pins as fixed obstacles.
  const detItems = mixed();
  const detC = drawer(300, 200);
  const det1 = nestLayout(detC, detItems, {});
  const det2 = nestLayout(detC, detItems, {});
  const pinItems = mixed().map((it, i) =>
    i === 0 ? { ...it, pin: true, x: 200, y: 150, rot: 30 } : it);
  const pin = nestLayout(detC, pinItems, {});
  const pinned = pin.placements.find(p => p.i === 0);

  // 8. Per-item rotation policy: locked to current, locked to an angle, free.
  const lockItems = mixed().map((it, i) =>
    i < 3 ? { ...it, rotLock: 'current', rot: 90 }
      : i < 6 ? { ...it, rotLock: 45 } : it);
  const lock = nestLayout(detC, lockItems, {});
  const lockRots = new Map(lock.placements.map(p => [p.i, p.rot]));

  // 9. Bounded restarts: two shapes with the same pocket area but different
  //    outlines are one equal-area group, so the seeded shuffles really do
  //    produce different orders — and the answer is still reproducible.
  const eqItems = [mk('wide', rect(40, 20)), mk('tall', rect(20, 40)),
    mk('wide2', rect(40, 20)), mk('tall2', rect(20, 40))];
  const eqC = drawer(140, 120);
  const eq1 = nestLayout(eqC, eqItems, { rotationStep: 90, restarts: 20 });
  const eq2 = nestLayout(eqC, eqItems, { rotationStep: 90, restarts: 20 });

  // 10. Criterion 7 on a NON-CONVEX container. The API takes a container loop
  //     rather than a rectangle on purpose, so a traced tote or a compartmented
  //     tray is a legal drawer, and for those the reason half of the answer is
  //     easy to get wrong: the middle of a U-shaped loop is the divider, not
  //     foam, so a tool that fits the left leg perfectly well fails a probe
  //     parked at the bbox centre. It must still come back as 'noRoom'. Each of
  //     these items is checked to fit the empty tote on its own, which is
  //     exactly what 'tooLarge' claims is impossible.
  const uLoop = [{ x: 0, y: 0 }, { x: 200, y: 0 }, { x: 200, y: 160 }, { x: 130, y: 160 },
    { x: 130, y: 40 }, { x: 70, y: 40 }, { x: 70, y: 160 }, { x: 0, y: 160 }];
  const uOpts = { minWeb: 4, border: 5, clearance: 0.5, rotationStep: 90, notchClear: 0 };
  const uItems = [mk('leg tool 1', rect(50, 100)), mk('leg tool 2', rect(50, 100)),
    mk('long bar', rect(180, 20)), mk('spare', rect(40, 60))];
  const uRes = nestLayout(uLoop, uItems, uOpts);
  const uSolo = uItems.map(it => nestLayout(uLoop, [it], uOpts).placements.length);
  // The same tote turned round, so the bite is at the top rather than the
  // bottom and one lucky corner probe would not rescue it either.
  const uFlip = uLoop.map(p => ({ x: 200 - p.x, y: 160 - p.y })).reverse();
  const uFlipRes = nestLayout(uFlip, uItems, uOpts);
  // The control, so the reason is not simply always 'noRoom' now: a slab that
  // genuinely fits neither leg of an L-shaped tray is still tooLarge.
  const lLoop = [{ x: 0, y: 0 }, { x: 200, y: 0 }, { x: 200, y: 60 },
    { x: 60, y: 60 }, { x: 60, y: 200 }, { x: 0, y: 200 }];
  const lRes = nestLayout(lLoop, [mk('big slab', rect(150, 150))], uOpts);

  // 11. A container loop that does not reach its own bounding box corner.
  //     Every candidate anchor after the first is derived from an
  //     already-placed pocket, so the one seeded position has to be foam
  //     rather than thin air or nothing is ever placed at all. It is thin air
  //     for a tray traced a degree or two off the paper's axis, for a tray
  //     with large corner radii, for an oval tote, and for an L whose bite is
  //     at the top left. Seeded from the bounding box corner alone the FIRST
  //     tool fails there in every allowed rotation, no second anchor is ever
  //     derived, and a completely empty drawer comes back with every tool
  //     marked 'noRoom', which the module's own probes have just disproved.
  //     Each container here is empty and roomy, so each must take all three.
  const turn = (loop, deg, cx, cy) => {
    const a = deg * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
    return loop.map(p => ({ x: cx + (p.x - cx) * c - (p.y - cy) * s,
      y: cy + (p.x - cx) * s + (p.y - cy) * c }));
  };
  const ovalLoop = (cx, cy, w, h, n) => {
    const out = [];
    for (let k = 0; k < n; k++) {
      const t = 2 * Math.PI * k / n;
      out.push({ x: cx + w / 2 * Math.cos(t), y: cy + h / 2 * Math.sin(t) });
    }
    return out;
  };
  const offItems = [mk('a', rect(60, 30)), mk('b', rect(50, 25)), mk('c', rect(40, 40))];
  const offOpts = { minWeb: 4, border: 5, clearance: 0.5, rotationStep: 15, notchClear: 0 };
  const off = [
    ['traced 2 deg off axis', turn(roundedRect(275, 190, 550, 380, 6), 2, 275, 190)],
    ['90 mm corner radii', roundedRect(275, 190, 550, 380, 90)],
    ['oval tote', ovalLoop(150, 100, 300, 200, 128)],
    ['L with the bite at the top left', [{ x: 60, y: 0 }, { x: 200, y: 0 },
      { x: 200, y: 200 }, { x: 0, y: 200 }, { x: 0, y: 60 }, { x: 60, y: 60 }]],
  ].map(([label, loop]) => {
    const r = nestLayout(loop, offItems, offOpts);
    const cf = clash(loop, offItems, r, offOpts.border);
    return { label, n: r.placements.length, clash: cf[0] + cf[1] };
  });

  return {
    stack: { n: stack.placements.length, gap: stackGap, clash: clash(stackC, stackItems, stack) },
    tuck: {
      rots: tuck.placements.map(p => p.rot).sort((a, b) => a - b),
      overlap: tuckOverlap, w: tuck.stats.bbox ? tuck.stats.bbox.w : -1,
      clash: clash(tuckC, tuckItems, tuck),
      untouched: JSON.stringify(tuckItems) === before,
      fresh: tuckMoved[0] !== tuckItems[0] && tuckMoved[0].x === tuck.placements[0].x,
    },
    spin: { n: spin.placements.length, rot: spin.placements.length ? spin.placements[0].rot : -1 },
    huge: { n: huge.placements.length, reason: huge.unplaced.map(u => u.reason).join(','),
      name: huge.unplaced.map(u => u.name).join(',') },
    full: { n: full.placements.length, left: full.unplaced.length,
      reasons: Array.from(new Set(full.unplaced.map(u => u.reason))).join(','),
      clash: clash(fullC, fullItems, full) },
    det: { same: JSON.stringify(det1.placements) === JSON.stringify(det2.placements),
      n: det1.placements.length, clash: clash(detC, detItems, det1) },
    pin: { at: pinned || null, n: pin.placements.length,
      pinnedFlag: !!(pinned && pinned.pinned), clash: clash(detC, pinItems, pin),
      list: pin.stats.pinned.join(',') },
    lock: { cur: [0, 1, 2].map(i => lockRots.get(i)).join(','),
      at45: [3, 4, 5].map(i => lockRots.get(i)).join(','),
      freeStepped: [6, 7, 8, 9, 10, 11].every(i => {
        const r = lockRots.get(i);
        return r === undefined || Math.abs(r % 15) < 1e-9;
      }) },
    eq: { passes: eq1.stats.passes, n: eq1.placements.length,
      same: JSON.stringify(eq1.placements) === JSON.stringify(eq2.placements) },
    tote: {
      solo: uSolo.join(','), left: uRes.unplaced.length,
      reasons: uRes.unplaced.map(u => u.reason).join(','),
      flip: uFlipRes.unplaced.map(u => u.reason).join(','),
      flipLeft: uFlipRes.unplaced.length,
      clash: clash(uLoop, uItems, uRes),
      control: lRes.unplaced.map(u => u.reason).join(','),
      legs: uRes.placements.filter(p => p.x < 70).length +
        ',' + uRes.placements.filter(p => p.x > 130).length,
    },
    off: off.map(r => `${r.label} ${r.n}/${offItems.length} placed, ${r.clash} conflicts`),
    offOk: off.every(r => r.n === offItems.length && r.clash === 0),
  };
});

console.log('\nNesting / auto-sort (holders.js)');
check('two rectangles that cannot sit side by side take a second row, exactly minWeb apart',
  nestFix.stack.n === 2 && near(nestFix.stack.gap, 4, 0.35) &&
  nestFix.stack.clash[0] === 0 && nestFix.stack.clash[1] === 0,
  `${nestFix.stack.n} placed, ${nestFix.stack.gap.toFixed(2)} mm web`);
check('the second L turns round and tucks into the first one\'s concavity',
  nestFix.tuck.rots.join(',') === '0,180' && nestFix.tuck.overlap && nestFix.tuck.w < 100,
  `rots ${nestFix.tuck.rots.join(',')}, bbox ${nestFix.tuck.w.toFixed(1)} mm wide, overlap ${nestFix.tuck.overlap}`);
check('the interleaved pair is still conflict-free',
  nestFix.tuck.clash[0] === 0 && nestFix.tuck.clash[1] === 0,
  `${nestFix.tuck.clash[0]} colliding, ${nestFix.tuck.clash[1]} escaped`);
check('nestLayout leaves the items it was handed untouched, and applyNest copies',
  nestFix.tuck.untouched && nestFix.tuck.fresh, `untouched ${nestFix.tuck.untouched}`);
check('an L too wide for the drawer flat rotates 90° to fit',
  nestFix.spin.n === 1 && (nestFix.spin.rot === 90 || nestFix.spin.rot === 270),
  `${nestFix.spin.n} placed at ${nestFix.spin.rot}°`);
check('a tool too big in every orientation comes back named, as tooLarge',
  nestFix.huge.n === 0 && nestFix.huge.reason === 'tooLarge' && nestFix.huge.name === 'crowbar',
  `${nestFix.huge.n} placed, ${nestFix.huge.reason} for ${nestFix.huge.name}`);
check('a full drawer packs 2 × 2, names the leftovers as noRoom, stays conflict-free',
  nestFix.full.n === 4 && nestFix.full.left === 4 && nestFix.full.reasons === 'noRoom' &&
  nestFix.full.clash[0] === 0 && nestFix.full.clash[1] === 0,
  `${nestFix.full.n} placed, ${nestFix.full.left} left (${nestFix.full.reasons})`);
check('12 mixed tools nest identically twice over — no clock, no Math.random',
  nestFix.det.same && nestFix.det.n === 12 &&
  nestFix.det.clash[0] === 0 && nestFix.det.clash[1] === 0,
  `${nestFix.det.n} placed, identical ${nestFix.det.same}`);
check('a pinned tool keeps its exact x, y and rot and the pack routes around it',
  !!nestFix.pin.at && nestFix.pin.at.x === 200 && nestFix.pin.at.y === 150 &&
  nestFix.pin.at.rot === 30 && nestFix.pin.pinnedFlag && nestFix.pin.list === '0' &&
  nestFix.pin.n === 12 && nestFix.pin.clash[0] === 0 && nestFix.pin.clash[1] === 0,
  nestFix.pin.at ? `at ${nestFix.pin.at.x},${nestFix.pin.at.y} @ ${nestFix.pin.at.rot}°, ${nestFix.pin.n} placed` : 'pin dropped');
check('rotation policy: locked to current, locked to an angle, or free on the step',
  nestFix.lock.cur === '90,90,90' && nestFix.lock.at45 === '45,45,45' &&
  nestFix.lock.freeStepped,
  `current ${nestFix.lock.cur}, locked ${nestFix.lock.at45}, stepped ${nestFix.lock.freeStepped}`);
check('bounded restarts shuffle the equal-area group and still reproduce',
  nestFix.eq.passes > 1 && nestFix.eq.n === 4 && nestFix.eq.same,
  `${nestFix.eq.passes} distinct passes, identical ${nestFix.eq.same}`);
check('a tool that fits one leg of a U-shaped tote is noRoom, never tooLarge',
  nestFix.tote.solo === '1,1,1,1' && nestFix.tote.left === 2 &&
  nestFix.tote.reasons === 'noRoom,noRoom' &&
  nestFix.tote.flipLeft === 2 && nestFix.tote.flip === 'noRoom,noRoom' &&
  nestFix.tote.clash[0] === 0 && nestFix.tote.clash[1] === 0,
  `${nestFix.tote.left} left as [${nestFix.tote.reasons}], flipped [${nestFix.tote.flip}], each fits alone ${nestFix.tote.solo}`);
// And it fills BOTH legs, which is the placement half of the same story: the
// right leg is only reachable from an anchor the container loop supplies, so
// while the seed was the bounding box corner alone one leg of this tote was
// unreachable and the tool that belonged in it was reported as 'noRoom'.
check('and the tote is packed leg and leg, not one leg and a pile of noRoom',
  nestFix.tote.legs === '1,1', `left leg / right leg placements ${nestFix.tote.legs}`);
check('a container that never reaches its own bounding box corner still nests',
  nestFix.offOk, nestFix.off.join('; '));
check('and a slab that fits neither leg of an L-shaped tray is still tooLarge',
  nestFix.tote.control === 'tooLarge', nestFix.tote.control);

// Step 2 of the same PRD: the conflict-freeness property. Success criterion 1
// says a nested result must come back `collisions.size === 0 &&
// escaped.size === 0` from the SAME layoutConflicts() the editor validates
// with, not "usually", and that this is the test that gates the feature. So
// rather than a handful of hand-drawn cases, generate item sets and settings
// from a seeded generator, nest each one, apply the result the way the editor
// would, and hold every single one to that predicate. The generator is seeded,
// so a failure here is a case anybody can reproduce exactly.
const nestProp = await page.evaluate(async () => {
  const { nestLayout, applyNest, layoutPockets, layoutConflicts, roundedRect } =
    await import('/js/holders.js');
  const rnd = seed => {
    let a = seed >>> 0 || 1;
    return () => {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  };
  const pick = (R, arr) => arr[Math.floor(R() * arr.length)];

  // One generated drawer: 3 to 10 tools drawn from four outline families (a
  // plain rectangle, an L with a real concavity, a lopsided convex blob with a
  // hole in it, and a rectangle with a finger notch), a quarter of them with a
  // rotation lock, sometimes one pinned, and a settings bag that ranges over
  // every web, rotation step and notch policy the profiles can produce.
  // `tight` halves the drawer so the honest-failure path gets exercised too.
  function genSet(seed, tight) {
    const R = rnd(seed);
    const n = 3 + Math.floor(R() * 8);
    const items = [];
    for (let k = 0; k < n; k++) {
      const w = 16 + Math.round(R() * 54), h = 12 + Math.round(R() * 33);
      const kind = Math.floor(R() * 4);
      let outer, notch = null, holes = [];
      if (kind === 0) outer = [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }];
      else if (kind === 1) outer = [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h * 0.4 },
        { x: w * 0.35, y: h * 0.4 }, { x: w * 0.35, y: h }, { x: 0, y: h }];
      else if (kind === 2) {
        outer = [{ x: 0, y: h / 2 }, { x: w * 0.35, y: 0 }, { x: w, y: h * 0.2 },
          { x: w * 0.85, y: h }, { x: w * 0.2, y: h * 0.95 }];
        holes = [[{ x: w * 0.4, y: h * 0.4 }, { x: w * 0.6, y: h * 0.4 },
          { x: w * 0.6, y: h * 0.6 }, { x: w * 0.4, y: h * 0.6 }]];
      } else {
        outer = [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }];
        notch = { dia: 10, x: w / 2, y: 0 };
      }
      const it = { name: `s${seed}t${k}`, outer, holes, circles: [],
        x: 6 + k * 4, y: 6 + k * 3, rot: 0, depth: null, thickness: 6 };
      if (notch) it.notch = notch;
      if (R() < 0.25) it.rotLock = pick(R, ['current', 0, 90]);
      items.push(it);
    }
    const opts = {
      minWeb: pick(R, [2, 4, 6, 8]), rotationStep: pick(R, [15, 45, 90]),
      rotationFree: R() < 0.75, border: pick(R, [4, 5, 8]),
      clearance: pick(R, [0.3, 0.5, 1]), restarts: pick(R, [1, 5, 20]),
      notchPolicy: pick(R, ['warn', 'require']), notchClear: 8,
    };
    let cw = 200 + Math.round(R() * 140), ch = 140 + Math.round(R() * 90);
    if (tight) { cw = Math.round(cw * 0.5); ch = Math.round(ch * 0.5); }
    else if (R() < 0.5) items[0] = { ...items[0], pin: true, x: cw / 2, y: ch / 2, rot: 90 };
    return { items, opts, outer: roundedRect(cw / 2, ch / 2, cw, ch, 4), cw, ch };
  }

  const SETS = 16;
  const rows = [];
  for (let s = 1; s <= SETS; s++) {
    const g = genSet(s * 1009, s % 4 === 0);
    const res = nestLayout(g.outer, g.items, g.opts);
    // Apply it exactly as the editor would, then re-derive the pockets from
    // the moved items rather than trusting anything the nester kept.
    const moved = applyNest(g.items, res);
    const pockets = layoutPockets(res.placements.map(p => moved[p.i]), g.opts.clearance);
    const cf = layoutConflicts(g.outer, pockets, g.opts.border);
    const again = nestLayout(g.outer, g.items, g.opts);
    const pi = g.items.findIndex(it => it.pin);
    const pp = pi >= 0 ? res.placements.find(p => p.i === pi) : null;
    rows.push({
      s, n: g.items.length, placed: res.placements.length, left: res.unplaced.length,
      collisions: cf.collisions.size, escaped: cf.escaped.size,
      accounted: res.placements.length + res.unplaced.length === g.items.length &&
        new Set(res.placements.map(p => p.i).concat(res.unplaced.map(u => u.i))).size === g.items.length,
      finite: res.placements.every(p =>
        Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.rot)),
      named: res.unplaced.every(u => !!u.name && (u.reason === 'tooLarge' || u.reason === 'noRoom')),
      repeats: JSON.stringify(res.placements) === JSON.stringify(again.placements),
      pinOk: pi < 0 ? true : !!pp && pp.x === g.cw / 2 && pp.y === g.ch / 2 && pp.rot === 90,
      pins: pi >= 0 ? 1 : 0,
    });
  }
  const bad = k => rows.filter(r => (typeof r[k] === 'boolean' ? !r[k] : r[k] > 0)).map(r => r.s);
  return {
    sets: rows.length,
    items: rows.reduce((a, r) => a + r.n, 0),
    placed: rows.reduce((a, r) => a + r.placed, 0),
    left: rows.reduce((a, r) => a + r.left, 0),
    crowded: rows.filter(r => r.left > 0).length,
    pinnedSets: rows.reduce((a, r) => a + r.pins, 0),
    badCollisions: bad('collisions'), badEscaped: bad('escaped'),
    badAccounted: bad('accounted'), badFinite: bad('finite'), badNamed: bad('named'),
    badRepeats: bad('repeats'), badPins: bad('pinOk'),
  };
});

check(`no nested layout collides, across ${nestProp.sets} generated drawers`,
  nestProp.badCollisions.length === 0,
  nestProp.badCollisions.length ? `sets ${nestProp.badCollisions.join(',')}` : `${nestProp.placed} pockets`);
check('no nested pocket crosses the border inset, in any generated drawer',
  nestProp.badEscaped.length === 0,
  nestProp.badEscaped.length ? `sets ${nestProp.badEscaped.join(',')}` : `${nestProp.placed} pockets`);
check('every generated item comes back exactly once, placed or named as unplaced',
  nestProp.badAccounted.length === 0 && nestProp.badFinite.length === 0 &&
  nestProp.badNamed.length === 0 &&
  nestProp.placed + nestProp.left === nestProp.items,
  `${nestProp.placed} placed + ${nestProp.left} unplaced of ${nestProp.items}`);
check('the property is not vacuous: drawers that overflow are in the sample',
  nestProp.placed > 60 && nestProp.crowded >= 3 && nestProp.left > 0,
  `${nestProp.crowded} of ${nestProp.sets} drawers overflowed, ${nestProp.left} tools left over`);
check('generated pins all came back on their exact millimetre',
  nestProp.badPins.length === 0 && nestProp.pinnedSets >= 3,
  nestProp.badPins.length ? `sets ${nestProp.badPins.join(',')}` : `${nestProp.pinnedSets} pinned drawers`);
check('every generated drawer nests to the identical answer on a second run',
  nestProp.badRepeats.length === 0,
  nestProp.badRepeats.length ? `sets ${nestProp.badRepeats.join(',')}` : `${nestProp.sets} drawers`);

// Step 3 of the same PRD: minimum web and finger-notch reach. These are the
// two placement constraints layoutConflicts cannot see. It only knows whether
// two pockets overlap, so it says nothing about HOW MUCH foam is left between
// them and nothing at all about whether a finger notch still opens onto clear
// foam. So this block measures the geometry independently of the nester: the
// true distance between pocket outlines, segment by segment, and the distance
// from each resolved notch centre outward to every other pocket and to the
// border inset.
const nestWeb = await page.evaluate(async () => {
  const { nestLayout, applyNest, layoutPockets, layoutConflicts, offsetLoop, roundedRect } =
    await import('/js/holders.js');
  const P = (x, y) => ({ x, y });
  const rect = (w, h) => [P(0, 0), P(w, 0), P(w, h), P(0, h)];
  const ell = (w, h, t) => [P(0, 0), P(w, 0), P(w, t), P(t, t), P(t, h), P(0, h)];
  // A three-pronged blade. Sharp convex corners and a deep bite are the worst
  // case for a web enforced by offsetting, because the round joins there turn
  // into long arcs.
  const spike = (w, h) => [P(0, h / 2), P(w * 0.3, 0), P(w, h * 0.12),
    P(w * 0.45, h * 0.5), P(w, h * 0.88), P(w * 0.3, h)];
  const mk = (name, outer, extra = {}) => ({
    name, outer, holes: [], circles: [], x: 0, y: 0, rot: 0, depth: null,
    thickness: 6, ...extra,
  });
  const drawer = (w, h) => roundedRect(w / 2, h / 2, w, h, 4);
  // Point to segment, and loop to loop / point to loop on top of it. Nested
  // pockets are disjoint whenever the nester did its job, so the minimum over
  // the vertex-to-segment pairs is the exact distance between two outlines.
  const ptSeg = (p, a, b) => {
    const dx = b.x - a.x, dy = b.y - a.y, L = dx * dx + dy * dy;
    let t = L ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / L : 0;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
  };
  const ptLoop = (p, L) => {
    let m = Infinity;
    for (let i = 0; i < L.length; i++) m = Math.min(m, ptSeg(p, L[i], L[(i + 1) % L.length]));
    return m;
  };
  const loopDist = (A, B) => {
    let m = Infinity;
    for (let i = 0; i < A.length; i++) {
      const a = A[i], b = A[(i + 1) % A.length];
      for (let j = 0; j < B.length; j++) {
        const c = B[j], d = B[(j + 1) % B.length];
        m = Math.min(m, ptSeg(a, c, d), ptSeg(b, c, d), ptSeg(c, a, b), ptSeg(d, a, b));
      }
    }
    return m;
  };

  // ---- minimum web, measured rather than taken on trust ----
  const webItems = [mk('r1', rect(60, 34)), mk('r2', rect(54, 38)),
    mk('L1', ell(66, 44, 16)), mk('L2', ell(58, 40, 14)),
    mk('s1', spike(70, 40)), mk('s2', spike(56, 34)), mk('r3', rect(40, 40))];
  const webC = drawer(300, 220);
  const webInner = offsetLoop(webC, -5)[0];
  const webRow = (minWeb) => {
    const o = { minWeb, border: 5, clearance: 0.5, rotationStep: 15, notchClear: 0 };
    const res = nestLayout(webC, webItems, o);
    const moved = applyNest(webItems, res);
    const geo = layoutPockets(res.placements.map(p => moved[p.i]), 0.5);
    const cf = layoutConflicts(webC, geo, 5);
    let pair = Infinity, edge = Infinity;
    for (let i = 0; i < geo.length; i++) {
      edge = Math.min(edge, loopDist(geo[i].pocket, webInner));
      for (let j = i + 1; j < geo.length; j++) {
        pair = Math.min(pair, loopDist(geo[i].pocket, geo[j].pocket));
      }
    }
    return { minWeb, n: res.placements.length, pair, edge,
      clash: cf.collisions.size + cf.escaped.size };
  };
  const webs = [2, 4, 8, 12].map(webRow);

  // ---- finger-notch reach ----
  // A plate whose notch opens to the RIGHT, so the next tool down lands
  // straight across it under top-left gravity. That is the adversarial case
  // the PRD names: a notch sealed not by a wall but by a LATER placement.
  const plate = mk('notched plate', rect(80, 60), { notch: { dia: 10, x: 80, y: 30 } });
  const slab = mk('slab', rect(70, 50));
  // And one whose notch opens UPWARD, straight into the border inset the
  // moment top-left gravity pushes it against the back of the drawer.
  const wallPlate = mk('wall plate', rect(60, 40), { notch: { dia: 10, x: 30, y: 0 } });
  const NOTCH_CLEAR = 15;
  const reachRun = (items, w, h, notchPolicy) => {
    const C = drawer(w, h);
    const o = { minWeb: 4, border: 5, clearance: 0.5, rotationStep: 90,
      notchClear: NOTCH_CLEAR, notchPolicy };
    const res = nestLayout(C, items, o);
    const moved = applyNest(items, res);
    const geo = layoutPockets(res.placements.map(p => moved[p.i]), 0.5);
    const inner = offsetLoop(C, -5)[0];
    const cf = layoutConflicts(C, geo, 5);
    // Criterion 3, measured the way it is worded: clear foam outward from the
    // notch CENTRE, against the border inset and against every other pocket.
    let reach = Infinity;
    geo.forEach((g, k) => {
      if (!g.notchAt) return;
      let m = ptLoop(g.notchAt, inner);
      geo.forEach((q, j) => { if (j !== k) m = Math.min(m, ptLoop(g.notchAt, q.pocket)); });
      reach = Math.min(reach, m);
    });
    return {
      n: res.placements.length,
      rots: res.placements.map(p => p.rot).join(','),
      ys: res.placements.map(p => Math.round(p.y * 10) / 10).join(','),
      warnings: res.stats.notchWarnings.join(','),
      left: res.unplaced.map(u => `${u.name}/${u.reason}`).join(','),
      reach: Number.isFinite(reach) ? reach : -1,
      clash: cf.collisions.size + cf.escaped.size,
      pins: res.stats.pinned.join(','),
      pinAt: res.placements.filter(p => p.pinned)
        .map(p => `${p.x},${p.y},${p.rot}`).join(';'),
    };
  };
  const pair = [plate, slab];

  // A PINNED tool with a notch. Criterion 5 says a pinned item keeps its exact
  // x / y / rot, so the nester never gets to move it and 'require' never gets
  // to refuse it: validAt() only ever runs on free placements. That leaves the
  // one case where the stricter policy could say less about the geometry than
  // the looser one, and criterion 3 is worded "every item's finger notch", not
  // every free one. This plate is pinned with its notch 6 mm off the back wall
  // against a 15 mm reach, and the layout is otherwise entirely legal, so
  // stats.notchWarnings is the only channel that can report it.
  const pinPlate = mk('pinned plate', rect(60, 40),
    { notch: { dia: 10, x: 30, y: 0 }, pin: true, x: 60, y: 31.5 });
  const pinPair = [pinPlate, mk('small slab', rect(40, 30))];
  return {
    webs, notchClear: NOTCH_CLEAR,
    sealWarn: reachRun(pair, 200, 200, 'warn'),
    sealReq: reachRun(pair, 200, 200, 'require'),
    tightWarn: reachRun(pair, 100, 260, 'warn'),
    tightReq: reachRun(pair, 100, 260, 'require'),
    wallWarn: reachRun([wallPlate], 120, 160, 'warn'),
    wallReq: reachRun([wallPlate], 120, 160, 'require'),
    pinWarn: reachRun(pinPair, 120, 160, 'warn'),
    pinReq: reachRun(pinPair, 120, 160, 'require'),
  };
});

// Four round-join offsets stand between a stated web and a measured one: each
// pocket's own clearance offset, plus each pocket's half-web inflation.
// ClipperLib is configured with an arc tolerance of 0.05 mm per offset, so up
// to 0.2 mm of chord error is arithmetic rather than a web the nester lost.
const WEB_TOL = 0.2;
const webSpread = nestWeb.webs.map(r => r.pair);
check('every nested pocket keeps at least the minimum web from its neighbours',
  nestWeb.webs.every(r => r.n === 7 && r.pair >= r.minWeb - WEB_TOL),
  nestWeb.webs.map(r => `${r.minWeb} mm asked, ${r.pair.toFixed(2)} measured`).join('; '));
check('every nested pocket keeps at least the minimum web off the border inset',
  nestWeb.webs.every(r => r.edge >= r.minWeb - WEB_TOL && r.clash === 0),
  nestWeb.webs.map(r => `${r.minWeb} mm asked, ${r.edge.toFixed(2)} measured`).join('; '));
check('raising the minimum web widens every gap, so the setting has real teeth',
  webSpread.every((v, k) => k === 0 || v > webSpread[k - 1] + 1.5),
  webSpread.map(v => v.toFixed(2)).join(' < '));
check('warn: a notch sealed by a later placement is packed anyway and reported',
  nestWeb.sealWarn.n === 2 && nestWeb.sealWarn.warnings === '0' &&
  nestWeb.sealWarn.reach < nestWeb.notchClear && nestWeb.sealWarn.clash === 0,
  `${nestWeb.sealWarn.n} placed, ${nestWeb.sealWarn.reach.toFixed(2)} mm of reach left, warned on [${nestWeb.sealWarn.warnings}]`);
check('require: the same drawer moves the later tool below instead of sealing the notch',
  nestWeb.sealReq.n === 2 && nestWeb.sealReq.warnings === '' &&
  nestWeb.sealReq.reach >= nestWeb.notchClear - 1e-6 && nestWeb.sealReq.clash === 0,
  `${nestWeb.sealReq.n} placed, ${nestWeb.sealReq.reach.toFixed(2)} mm of reach (asked ${nestWeb.notchClear}), ys ${nestWeb.sealReq.ys}`);
check('require: a notch that would open onto the drawer wall turns 180° instead',
  nestWeb.wallWarn.rots === '0' && nestWeb.wallWarn.warnings === '0' &&
  nestWeb.wallWarn.reach < nestWeb.notchClear &&
  nestWeb.wallReq.rots === '180' && nestWeb.wallReq.warnings === '' &&
  nestWeb.wallReq.reach >= nestWeb.notchClear - 1e-6,
  `warn ${nestWeb.wallWarn.rots}° with ${nestWeb.wallWarn.reach.toFixed(2)} mm, require ${nestWeb.wallReq.rots}° with ${nestWeb.wallReq.reach.toFixed(2)} mm`);
check('require: with nowhere legal left the tool is refused rather than sealing the notch',
  nestWeb.tightWarn.n === 2 && nestWeb.tightWarn.warnings === '0' &&
  nestWeb.tightReq.n === 1 && nestWeb.tightReq.left === 'slab/noRoom' &&
  nestWeb.tightReq.reach >= nestWeb.notchClear - 1e-6 && nestWeb.tightReq.clash === 0,
  `warn placed ${nestWeb.tightWarn.n} and warned on [${nestWeb.tightWarn.warnings}], require placed ${nestWeb.tightReq.n} and reported ${nestWeb.tightReq.left}`);
check('a pinned tool keeps its millimetre and its sealed notch is reported under BOTH policies',
  nestWeb.pinWarn.pinAt === '60,31.5,0' && nestWeb.pinReq.pinAt === '60,31.5,0' &&
  nestWeb.pinWarn.n === 2 && nestWeb.pinReq.n === 2 &&
  nestWeb.pinReq.reach < nestWeb.notchClear && nestWeb.pinWarn.warnings === '0' &&
  nestWeb.pinReq.warnings === '0' && nestWeb.pinReq.clash === 0 &&
  nestWeb.pinReq.left === '',
  `warn [${nestWeb.pinWarn.warnings}], require [${nestWeb.pinReq.warnings}], ${nestWeb.pinReq.reach.toFixed(2)} mm of reach against ${nestWeb.notchClear}, pin at ${nestWeb.pinReq.pinAt}`);

// Step 4 of the same PRD: the reference fixture behind success criterion 2. A
// set of 12 hand tools in a 550 x 380 mm drawer, and the claim that the nester
// fits at least as many of them as a careful manual arrangement, in no more
// than the same bounding area.
//
// The outlines are fabricated rather than traced, on purpose: a fixture that
// needed twelve photographs through the whole ingest pipeline would be testing
// the pipeline, not the nester. What matters is that they are tool-shaped, with
// the fat ends, thin shafts and open handles that give a real nester something
// to interleave.
//
// The manual arrangement is the other half of the fixture, and it is the part
// that is frozen. It was laid out once by hand, the way a person actually does
// it: rows of long tools sorted by height, the tape measure filling the gap
// beside the hammer head, a small wrench slipped into the dead space under the
// hammer handle. Its numbers are written down below as constants, and the test
// re-derives them and checks they still hold, so the baseline cannot drift
// quietly and make the comparison easy.
const HAND_W = 486, HAND_H = 307, HAND_AREA = HAND_W * HAND_H;
const nestRef = await page.evaluate(async () => {
  const { nestLayout, applyNest, layoutPockets, layoutConflicts, roundedRect } =
    await import('/js/holders.js');
  const P = (x, y) => ({ x, y });
  // Combination wrench: fat ring and open ends, narrow shaft between them.
  const wrench = (L, j) => [P(0, j * 0.15), P(L * 0.11, 0), P(L * 0.2, 0), P(L * 0.28, j * 0.3),
    P(L * 0.72, j * 0.3), P(L * 0.8, 0), P(L * 0.9, 0), P(L, j * 0.18), P(L, j * 0.82),
    P(L * 0.9, j), P(L * 0.8, j), P(L * 0.72, j * 0.7), P(L * 0.28, j * 0.7), P(L * 0.2, j),
    P(L * 0.11, j), P(0, j * 0.85)];
  // Screwdriver: fat handle at the left, tapering into a thin blade.
  const driver = (L, h) => [P(0, h * 0.25), P(L * 0.06, 0), P(L * 0.34, 0), P(L * 0.4, h * 0.3),
    P(L, h * 0.42), P(L, h * 0.58), P(L * 0.4, h * 0.7), P(L * 0.34, h), P(L * 0.06, h),
    P(0, h * 0.75)];
  // Pliers: jaws at the right, two handles at the left with the gap between
  // them open, which is the concavity another tool can tuck into.
  const pliers = (L, h) => [P(L, h * 0.45), P(L * 0.62, h * 0.16), P(L * 0.26, h * 0.04),
    P(0, 0), P(0, h * 0.28), P(L * 0.32, h * 0.43), P(L * 0.32, h * 0.57), P(0, h * 0.72),
    P(0, h), P(L * 0.26, h * 0.96), P(L * 0.62, h * 0.84), P(L, h * 0.55)];
  // Hammer: a T, head at the left, thin handle running right.
  const hammer = (L, H, hw, th) => [P(0, 0), P(hw, 0), P(hw, (H - th) / 2), P(L, (H - th) / 2 + 3),
    P(L, (H + th) / 2 - 3), P(hw, (H + th) / 2), P(hw, H), P(0, H)];
  const knife = (L, h) => [P(0, h * 0.2), P(L * 0.1, 0), P(L * 0.62, 0), P(L, h * 0.34),
    P(L, h * 0.5), P(L * 0.62, h * 0.8), P(L * 0.1, h), P(0, h * 0.8)];
  const tape = s => [P(s * 0.18, 0), P(s * 0.82, 0), P(s, s * 0.18), P(s, s * 0.82),
    P(s * 0.82, s), P(s * 0.18, s), P(0, s * 0.82), P(0, s * 0.18)];
  const bbox = pts => {
    let minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9;
    for (const p of pts) {
      minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
      minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
    }
    return { minX, minY, maxX, maxY, w: maxX - minX, h: maxY - minY };
  };
  const unionBB = loops => loops.reduce((acc, l) => {
    const b = bbox(l);
    return acc ? {
      minX: Math.min(acc.minX, b.minX), minY: Math.min(acc.minY, b.minY),
      maxX: Math.max(acc.maxX, b.maxX), maxY: Math.max(acc.maxY, b.maxY),
    } : b;
  }, null);

  // name, outline, and the left / top corner it was hand-placed at. Every row
  // is 5 mm clear of the next, which is 4 mm of foam once the 0.5 mm clearance
  // offset on each pocket is counted, and 12 mm in from the drawer edge, which
  // clears the 5 mm border inset plus the same 4 mm web.
  const HAND = [
    ['ball-pein hammer', hammer(300, 112, 46, 26), 12, 12],
    ['tape measure', tape(72), 317, 12],
    ['combination wrench 10', wrench(150, 26), 63, 90],
    ['adjustable wrench', wrench(210, 52), 12, 129],
    ['needle-nose pliers', pliers(185, 46), 227, 129],
    ['side cutters', pliers(150, 58), 12, 186],
    ['combination pliers', pliers(165, 52), 167, 186],
    ['utility knife', knife(160, 34), 337, 186],
    ['flat screwdriver', driver(230, 30), 12, 249],
    ['combination wrench 17', wrench(190, 34), 247, 249],
    ['phillips screwdriver', driver(205, 28), 12, 288],
    ['combination wrench 13', wrench(170, 30), 222, 288],
  ];
  // x / y are the outline bbox CENTRE, which is what placeLoop moves.
  const items = HAND.map(([name, outer, left, top]) => {
    const b = bbox(outer);
    return { name, outer, holes: [], circles: [], depth: null, thickness: 8,
      rot: 0, x: left + b.w / 2, y: top + b.h / 2 };
  });

  const DW = 550, DH = 380;
  const drawer = roundedRect(DW / 2, DH / 2, DW, DH, 6);
  const opts = { minWeb: 4, border: 5, clearance: 0.5, rotationStep: 15, notchClear: 0 };

  const handGeo = layoutPockets(items, opts.clearance);
  const handCf = layoutConflicts(drawer, handGeo, opts.border);
  const hb = unionBB(handGeo.map(g => g.pocket));

  const res = nestLayout(drawer, items, opts);
  const moved = applyNest(items, res);
  const nestGeo = layoutPockets(res.placements.map(p => moved[p.i]), opts.clearance);
  const nestCf = layoutConflicts(drawer, nestGeo, opts.border);
  const nb = unionBB(nestGeo.map(g => g.pocket));

  // Criterion 2 on the same drawer and the same twelve tools, with the
  // container traced rather than typed in: a tray photographed on a sheet of
  // paper comes back a degree or two off axis, and that is the drawer the
  // library hands the nester. Nothing about the foam has changed, so nothing
  // about the answer may either. Two degrees of skew used to take this
  // fixture from 12 placed to none at all, every tool reported 'noRoom' in a
  // completely empty drawer, because the only seeded anchor was the inner
  // bounding box corner and a skewed tray does not reach it.
  const skewDeg = 2, sa = skewDeg * Math.PI / 180;
  const skewC = drawer.map(p => ({
    x: DW / 2 + (p.x - DW / 2) * Math.cos(sa) - (p.y - DH / 2) * Math.sin(sa),
    y: DH / 2 + (p.x - DW / 2) * Math.sin(sa) + (p.y - DH / 2) * Math.cos(sa),
  }));
  const skewRes = nestLayout(skewC, items, opts);
  const skewMoved = applyNest(items, skewRes);
  const skewCf = layoutConflicts(skewC,
    layoutPockets(skewRes.placements.map(p => skewMoved[p.i]), opts.clearance), opts.border);

  // Success criterion 6, kept deliberately loose. The PRD's budget is 2 s for
  // 30 items on a mid-range laptop; a headless browser in a container is not
  // that, so this only has to catch the difference between a nester that runs
  // and one that has gone quadratic. The measured figure is printed either way.
  const many = [];
  for (let k = 0; k < 30; k++) {
    many.push({ ...items[k % 12], name: `bulk ${k}`, x: 20 + k * 3, y: 20 + k * 2 });
  }
  const bulkC = roundedRect(450, 350, 900, 700, 6);
  const t0 = performance.now();
  const bulk = nestLayout(bulkC, many, opts);
  const bulkMs = performance.now() - t0;

  // That fixture alone is not criterion 6, and it took a while to notice why.
  // It is twelve distinct shapes repeated out to thirty, so every equal-area
  // group holds nothing but interchangeable copies, every seeded shuffle
  // re-serialises to the same shapeKey order, and the restart loop collapses
  // to a SINGLE pass however many restarts are configured. The number it
  // prints is therefore one twentieth of what the module's own defaults can
  // cost on thirty items, and a regression in the restart path cannot move it
  // at all. So here is the same thirty-item size built so the restarts really
  // run: each tool is paired with a rotation-locked twin, which shares its
  // pocket area (rotation does not change area, so they land in one group) but
  // not its allowed angles, so the shuffles survive de-duplication. Unbounded,
  // this ran for tens of seconds; testBudget is what makes the ceiling a
  // property of the module rather than of the input.
  const twins = [];
  for (let k = 0; k < 30; k++) {
    const src = { ...items[Math.floor(k / 2) % 12], name: `twin ${k}`,
      x: 20 + k * 3, y: 20 + k * 2 };
    twins.push(k % 2 ? { ...src, rotLock: 'current', rot: 90 } : src);
  }
  const t1 = performance.now();
  const twin = nestLayout(bulkC, twins, opts);
  const twinMs = performance.now() - t1;
  const twinMoved = applyNest(twins, twin);
  const twinCf = layoutConflicts(bulkC,
    layoutPockets(twin.placements.map(p => twinMoved[p.i]), opts.clearance), opts.border);
  // One pass of the same set, so the work the default 20 restarts would have
  // spent without a budget is a measured number rather than an assertion.
  const one = nestLayout(bulkC, twins, { ...opts, restarts: 1 });

  // What the budget is NOT allowed to spend. The loose fixture above is one
  // where every tool places on pass 0, so cancelling restarts there can only
  // cost bounding area. Here is the other case: a drawer tight enough that
  // the restarts are the only thing that finds room for the last two tools.
  // The budget is set far below what those passes cost, so a ceiling that
  // simply stopped at the counter would return the single-pass answer and
  // report two tools as 'noRoom' in a drawer the same module fills given its
  // own configured restarts. Best is kept by placed count first, so a
  // truncated run is a prefix and can only ever place fewer.
  const tightTwins = [];
  for (let k = 0; k < 12; k++) {
    const src = { ...items[Math.floor(k / 2) % 12], name: `tight ${k}`,
      x: 20 + k * 3, y: 20 + k * 2 };
    tightTwins.push(k % 2 ? { ...src, rotLock: 'current', rot: 90 } : src);
  }
  const tightC = roundedRect(230, 160, 460, 320, 6);
  const cutOpts = { ...opts, restarts: 8, testBudget: 2000 };
  const cut = nestLayout(tightC, tightTwins, cutOpts);
  const whole = nestLayout(tightC, tightTwins, { ...cutOpts, testBudget: 0 });
  const once = nestLayout(tightC, tightTwins, { ...cutOpts, restarts: 1 });

  return {
    hand: { clash: handCf.collisions.size + handCf.escaped.size,
      w: hb.maxX - hb.minX, h: hb.maxY - hb.minY,
      area: (hb.maxX - hb.minX) * (hb.maxY - hb.minY) },
    nest: { placed: res.placements.length, left: res.unplaced.length,
      clash: nestCf.collisions.size + nestCf.escaped.size,
      w: nb.maxX - nb.minX, h: nb.maxY - nb.minY,
      area: (nb.maxX - nb.minX) * (nb.maxY - nb.minY),
      names: res.unplaced.map(u => u.name).join(','),
      rots: Array.from(new Set(res.placements.map(p => p.rot))).sort((a, b) => a - b).join(',') },
    skew: { placed: skewRes.placements.length, left: skewRes.unplaced.length,
      clash: skewCf.collisions.size + skewCf.escaped.size,
      names: skewRes.unplaced.map(u => u.name).join(','),
      reasons: Array.from(new Set(skewRes.unplaced.map(u => u.reason))).join(','),
      deg: skewDeg },
    bulk: { placed: bulk.placements.length, ms: Math.round(bulkMs),
      passes: bulk.stats.passes },
    cut: { placed: cut.placements.length, whole: whole.placements.length,
      once: once.placements.length, tests: cut.stats.tests,
      budget: cutOpts.testBudget, hit: cut.stats.budgetHit,
      same: JSON.stringify(cut.placements) === JSON.stringify(whole.placements) },
    twin: { placed: twin.placements.length, left: twin.unplaced.length,
      ms: Math.round(twinMs), passes: twin.stats.passes, tests: twin.stats.tests,
      budget: twin.stats.testBudget, budgetHit: twin.stats.budgetHit,
      onePass: one.stats.tests, restarts: 20,
      clash: twinCf.collisions.size + twinCf.escaped.size },
  };
});

check('the hand-laid 12-tool reference drawer is legal, and measures the frozen 486 x 307 mm',
  nestRef.hand.clash === 0 && near(nestRef.hand.w, HAND_W, 0.01) &&
  near(nestRef.hand.h, HAND_H, 0.01) && near(nestRef.hand.area, HAND_AREA, 20),
  `${nestRef.hand.w.toFixed(1)} x ${nestRef.hand.h.toFixed(1)} mm, ${Math.round(nestRef.hand.area)} mm2, ${nestRef.hand.clash} conflicts`);
check('the nester fits all 12 reference tools in the 550 x 380 drawer, conflict-free',
  nestRef.nest.placed === 12 && nestRef.nest.left === 0 && nestRef.nest.clash === 0,
  `${nestRef.nest.placed} placed, ${nestRef.nest.left} left over (${nestRef.nest.names || 'none'}), angles used ${nestRef.nest.rots}`);
check('and uses no more bounding area than the careful hand arrangement',
  nestRef.nest.area <= HAND_AREA + 1e-6,
  `${Math.round(nestRef.nest.area)} mm2 nested (${nestRef.nest.w.toFixed(1)} x ${nestRef.nest.h.toFixed(1)}) vs ${HAND_AREA} by hand, ${(100 - 100 * nestRef.nest.area / HAND_AREA).toFixed(1)}% less`);
check('the same 12 tools still all place when the drawer is traced 2 degrees off axis',
  nestRef.skew.placed === 12 && nestRef.skew.left === 0 && nestRef.skew.clash === 0,
  `${nestRef.skew.placed} placed at ${nestRef.skew.deg} deg of skew, ${nestRef.skew.left} left over (${nestRef.skew.names || 'none'}${nestRef.skew.reasons ? ': ' + nestRef.skew.reasons : ''})`);
check('30 tools nest without the run running away (criterion 6, generous ceiling)',
  nestRef.bulk.placed === 30 && nestRef.bulk.ms < 8000,
  `${nestRef.bulk.placed} placed in ${nestRef.bulk.ms} ms`);
check('that 30-item fixture measures ONE pass, so criterion 6 needs a second one',
  nestRef.bulk.passes === 1 && nestRef.twin.passes > 1,
  `repeated shapes ran ${nestRef.bulk.passes} pass, live restarts ran ${nestRef.twin.passes}`);
check('30 tools whose restarts really fire still nest completely and conflict-free',
  nestRef.twin.placed === 30 && nestRef.twin.left === 0 && nestRef.twin.clash === 0,
  `${nestRef.twin.placed} placed, ${nestRef.twin.left} left, ${nestRef.twin.clash} conflicts`);
// The work counter is a pure count of candidate tests, so unlike the
// millisecond figures it means the same thing on every machine. It is the half
// of criterion 6 this suite can actually hold to a number.
check('the work budget bounds the restart loop instead of letting 20 passes run away',
  nestRef.twin.budgetHit && nestRef.twin.passes < nestRef.twin.restarts &&
  nestRef.twin.tests < 2 * nestRef.twin.budget &&
  nestRef.twin.onePass * nestRef.twin.restarts > 4 * nestRef.twin.tests,
  `${nestRef.twin.tests} tests over ${nestRef.twin.passes} passes against a ${nestRef.twin.budget} budget, vs ~${nestRef.twin.onePass * nestRef.twin.restarts} for the ${nestRef.twin.restarts} unbounded`);
// The other half of the same budget: it may cost density, and it may never
// cost a placement. This drawer is tight enough that the restarts are what
// place the last two tools, and the budget is set far below what they cost.
check('the work budget costs bounding area, never a placement',
  nestRef.cut.placed === nestRef.cut.whole && nestRef.cut.same &&
  nestRef.cut.whole > nestRef.cut.once && !nestRef.cut.hit &&
  nestRef.cut.tests > nestRef.cut.budget,
  `${nestRef.cut.placed} placed against a ${nestRef.cut.budget} budget and ${nestRef.cut.tests} tests spent, vs ${nestRef.cut.whole} unbudgeted and ${nestRef.cut.once} in one pass`);
check('30 tools with live restarts nest inside the ceiling too (criterion 6)',
  nestRef.twin.ms < 8000,
  `${nestRef.twin.ms} ms for ${nestRef.twin.passes} passes`);

// ---------- packing profiles + reserved label space (nesting steps 5 and 6) ----------
// Profiles are data before they are UI: two built-in presets, a normaliser that
// a hand-edited project cannot get past, and a match that says not just which
// profile a layout is on but whether it has been edited away from it.
const packFix = await page.evaluate(async () => {
  const {
    nestLayout, applyNest, layoutPockets, layoutConflicts, roundedRect,
    PACK_PROFILES, PACK_KEYS, packProfileValues, packNormalize, packProfileMatch,
  } = await import('/js/holders.js');
  const rect = (w, h) => [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }];
  const mk = (name, outer, extra = {}) => ({
    name, outer, holes: [], circles: [], x: 0, y: 0, rot: 0, depth: null,
    thickness: 6, ...extra,
  });
  const drawer = (w, h) => roundedRect(w / 2, h / 2, w, h, 4);
  const bbox = pts => {
    let minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9;
    for (const p of pts) {
      minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
      minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
    }
    return { minX, minY, maxX, maxY, w: maxX - minX, h: maxY - minY };
  };
  const clash = (outer, items, res, border = 5) => {
    const moved = applyNest(items, res);
    const cf = layoutConflicts(outer,
      layoutPockets(res.placements.map(p => moved[p.i]), 0.5), border);
    return [cf.collisions.size, cf.escaped.size];
  };

  const names = PACK_PROFILES.map(p => p.name);
  const dense = packProfileValues('Dense');
  const access = packProfileValues('Access');

  // Selecting a profile then nesting must be the same as setting its values by
  // hand then nesting. This is the whole claim of "presets, not modes": if the
  // two ever diverged, the panel would be describing a pack it did not produce.
  const profC = drawer(150, 110);
  const profItems = [
    mk('a', rect(40, 22)), mk('b', rect(36, 18)), mk('c', rect(28, 26)),
  ];
  const byName = nestLayout(profC, profItems, { ...packProfileValues('Access') });
  const byHand = nestLayout(profC, profItems, {
    minWeb: 8, comfortWeb: 12, rotationStep: 90, rotationFree: false,
    notchPolicy: 'require', labelSpace: 'reserve', restarts: 20,
  });
  const sameAsHand =
    JSON.stringify(byName.placements) === JSON.stringify(byHand.placements);

  // A hand-edited project is data. Nothing it can say gets past the normaliser
  // into the packer.
  const junk = packNormalize({
    minWeb: -3, comfortWeb: 'wide', rotationStep: 0, rotationFree: 'yes',
    notchPolicy: 'whatever', labelSpace: 7, restarts: 1e9,
  });
  const missing = packNormalize({});
  const unknown = packProfileValues('Nonexistent');

  // Provenance: on a profile, edited away from one, and on a custom profile.
  const onAccess = packProfileMatch(access);
  const edited = packProfileMatch({ ...access, minWeb: 9 }, [], 'Access');
  const orphan = packProfileMatch({ ...access, minWeb: 9 });
  const custom = [{ name: 'Mine', values: { ...dense, minWeb: 6 } }];
  const onCustom = packProfileMatch({ ...dense, minWeb: 6 }, custom);

  // --- comfortWeb: the spread term ---
  // Off by default, so the dense profile packs exactly as v1.25.0 did.
  const spreadC = drawer(200, 150);
  const spreadItems = [
    mk('p', rect(40, 24)), mk('q', rect(40, 24)), mk('r', rect(40, 24)),
  ];
  const tight = nestLayout(spreadC, spreadItems, { rotationStep: 90, comfortWeb: 0 });
  const tightAgain = nestLayout(spreadC, spreadItems, { rotationStep: 90 });
  const spread = nestLayout(spreadC, spreadItems, { rotationStep: 90, comfortWeb: 20 });
  // Nearest-neighbour centre distance, as a blunt read on how spread out the
  // three ended up. The spread pack must not be tighter than the dense one,
  // and must still be conflict-free, which is the criterion that gates all of
  // this: a roomier pack that overlaps is not a pack.
  const spacing = res => {
    const ps = res.placements;
    let worst = Infinity;
    for (let i = 0; i < ps.length; i++) {
      for (let j = i + 1; j < ps.length; j++) {
        const d = Math.hypot(ps[i].x - ps[j].x, ps[i].y - ps[j].y);
        if (d < worst) worst = d;
      }
    }
    return ps.length > 1 ? worst : 0;
  };

  // --- labelSpace: reserve ---
  // A label is foam that has to exist. Two tools that fit side by side with no
  // labels must be pushed apart once each one's name is packed with it.
  // Narrow on purpose. A label sits UNDER its tool, so the room it demands is
  // vertical, and in a square drawer the two tools would simply sit side by
  // side and never test it. At 60 mm wide only one 40 mm tool fits across, so
  // the second has to go below the first and the label is in the gap.
  const labC = drawer(60, 200);
  const labItems = [mk('WRENCH', rect(40, 20)), mk('PLIERS', rect(40, 20))];
  const labOff = nestLayout(labC, labItems,
    { rotationStep: 90, rotationFree: false, minWeb: 4, labelSpace: 'none' });
  const labOn = nestLayout(labC, labItems, {
    rotationStep: 90, rotationFree: false, minWeb: 4,
    labelSpace: 'reserve', labelHeight: 6, labelMargin: 2,
  });
  // The gap the reservation has to open: two pockets whose labels sit between
  // them need the label's own height plus its margins, not the bare 4 mm web.
  const vGap = res => {
    const moved = applyNest(labItems, res);
    const pk = layoutPockets(res.placements.map(p => moved[p.i]), 0.5);
    if (pk.length < 2) return null;
    const [a, b] = pk.map(g => bbox(g.pocket));
    const stacked = a.maxY <= b.minY || b.maxY <= a.minY;
    const lo = a.maxY <= b.minY ? a : b, hi = a.maxY <= b.minY ? b : a;
    return { gap: hi.minY - lo.maxY, stacked };
  };
  // A tool with no name reserves nothing, so labelSpace costs an unlabelled
  // drawer exactly zero.
  const anonItems = [mk('', rect(40, 20)), mk('', rect(40, 20))];
  const anonOn = nestLayout(labC, anonItems, {
    rotationStep: 90, rotationFree: false, minWeb: 4, labelSpace: 'reserve',
  });
  const anonOff = nestLayout(labC, anonItems,
    { rotationStep: 90, rotationFree: false, minWeb: 4, labelSpace: 'none' });

  return {
    names, dense, access, sameAsHand, junk, missing, unknown,
    onAccess, edited, orphan, onCustom,
    keys: PACK_KEYS.slice(),
    tight: { n: tight.placements.length, same: JSON.stringify(tight.placements) === JSON.stringify(tightAgain.placements), space: spacing(tight), clash: clash(spreadC, spreadItems, tight) },
    spread: { n: spread.placements.length, space: spacing(spread), clash: clash(spreadC, spreadItems, spread) },
    labOff: { n: labOff.placements.length, v: vGap(labOff), labelled: labOff.stats.labelled, clash: clash(labC, labItems, labOff) },
    labOn: { n: labOn.placements.length, v: vGap(labOn), labelled: labOn.stats.labelled, clash: clash(labC, labItems, labOn) },
    anonSame: JSON.stringify(anonOn.placements) === JSON.stringify(anonOff.placements),
    anonLabelled: anonOn.stats.labelled,
  };
});

check('two built-in profiles, each a complete set of the seven packing keys',
  JSON.stringify(packFix.names) === JSON.stringify(['Dense', 'Access']) &&
  packFix.keys.every(k => packFix.dense[k] !== undefined && packFix.access[k] !== undefined) &&
  packFix.dense.minWeb === 4 && packFix.access.minWeb === 8 &&
  packFix.dense.comfortWeb === 0 && packFix.access.comfortWeb === 12 &&
  packFix.dense.rotationStep === 15 && packFix.access.rotationStep === 90 &&
  packFix.dense.rotationFree === true && packFix.access.rotationFree === false &&
  packFix.dense.notchPolicy === 'warn' && packFix.access.notchPolicy === 'require' &&
  packFix.dense.labelSpace === 'none' && packFix.access.labelSpace === 'reserve',
  `${JSON.stringify(packFix.names)}; Dense ${JSON.stringify(packFix.dense)}`);

check('selecting a profile then nesting is identical to setting its values by hand',
  packFix.sameAsHand, `by name === by hand: ${packFix.sameAsHand}`);

check('a hand-edited project cannot get a bad packing value past the normaliser',
  packFix.junk.minWeb === 0 && packFix.junk.comfortWeb === 0 &&
  packFix.junk.rotationStep === 1 && packFix.junk.rotationFree === true &&
  packFix.junk.notchPolicy === 'warn' && packFix.junk.labelSpace === 'none' &&
  packFix.junk.restarts === 200 &&
  packFix.missing.minWeb === 4 && packFix.missing.rotationStep === 15 &&
  packFix.unknown === null,
  `${JSON.stringify(packFix.junk)}; unknown profile -> ${packFix.unknown}`);

check('a layout says which profile it is on, and whether it has been edited away from it',
  packFix.onAccess.name === 'Access' && packFix.onAccess.modified === false &&
  packFix.edited.name === 'Access' && packFix.edited.modified === true &&
  packFix.orphan.name === null && packFix.orphan.modified === true &&
  packFix.onCustom.name === 'Mine' && packFix.onCustom.modified === false,
  `on ${JSON.stringify(packFix.onAccess)}, edited ${JSON.stringify(packFix.edited)}, ` +
  `no selection ${JSON.stringify(packFix.orphan)}, custom ${JSON.stringify(packFix.onCustom)}`);

check('comfortWeb 0 is inert: the dense pack is the one that shipped, and repeatable',
  packFix.tight.same && packFix.tight.n === 3 &&
  JSON.stringify(packFix.tight.clash) === JSON.stringify([0, 0]),
  `explicit 0 matches the default: ${packFix.tight.same}, ` +
  `${packFix.tight.n} placed, conflicts ${JSON.stringify(packFix.tight.clash)}`);

check('comfortWeb spreads the pack out and the result is still conflict-free',
  packFix.spread.n === 3 &&
  packFix.spread.space >= packFix.tight.space - 1e-6 &&
  JSON.stringify(packFix.spread.clash) === JSON.stringify([0, 0]),
  `nearest pair ${packFix.tight.space.toFixed(1)} mm tight -> ` +
  `${packFix.spread.space.toFixed(1)} mm at comfortWeb 20, conflicts ` +
  `${JSON.stringify(packFix.spread.clash)}`);

check('reserving label space opens the gap to fit the label, not the bare web',
  packFix.labOn.n === 2 && packFix.labOff.n === 2 &&
  packFix.labOn.labelled === 2 && packFix.labOff.labelled === 0 &&
  packFix.labOn.v && packFix.labOff.v &&
  packFix.labOn.v.stacked && packFix.labOff.v.stacked &&
  packFix.labOn.v.gap >= 10 && packFix.labOn.v.gap > packFix.labOff.v.gap + 1 &&
  JSON.stringify(packFix.labOn.clash) === JSON.stringify([0, 0]),
  `gap ${packFix.labOff.v && packFix.labOff.v.gap.toFixed(1)} mm without labels -> ` +
  `${packFix.labOn.v && packFix.labOn.v.gap.toFixed(1)} mm with 6 mm labels at 2 mm margin ` +
  `(${packFix.labOn.labelled} reserved), conflicts ${JSON.stringify(packFix.labOn.clash)}`);

check('a tool with no name reserves nothing, so an unlabelled drawer pays nothing',
  packFix.anonSame && packFix.anonLabelled === 0,
  `same placements ${packFix.anonSame}, ${packFix.anonLabelled} reserved`);

// ---------- Gridfinity bin (holders.js) ----------

const grid = await page.evaluate(async () => {
  const { buildGridfinityBin } = await import('/js/holders.js');
  const outer = [{ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 40, y: 30 }, { x: 0, y: 30 }];
  const badEdges = m => {
    const use = new Map();
    const k = i => `${m.positions[i*3].toFixed(4)},${m.positions[i*3+1].toFixed(4)},${m.positions[i*3+2].toFixed(4)}`;
    for (let t = 0; t < m.indices.length; t += 3) {
      const ks = [k(m.indices[t]), k(m.indices[t+1]), k(m.indices[t+2])];
      if (ks[0] === ks[1] || ks[1] === ks[2] || ks[0] === ks[2]) continue;
      for (let e = 0; e < 3; e++) {
        const a = ks[e], b = ks[(e+1)%3], key = a < b ? a+'|'+b : b+'|'+a;
        use.set(key, (use.get(key) || 0) + 1);
      }
    }
    let bad = 0;
    for (const v of use.values()) if (v !== 2) bad++;
    return bad;
  };
  const zRange = m => {
    let lo = 1e9, hi = -1e9;
    for (let i = 2; i < m.positions.length; i += 3) {
      lo = Math.min(lo, m.positions[i]); hi = Math.max(hi, m.positions[i]);
    }
    return { lo, hi };
  };
  const hasZ = (m, z, tol = 1e-4) => {
    for (let i = 2; i < m.positions.length; i += 3) {
      if (Math.abs(m.positions[i] - z) < tol) return true;
    }
    return false;
  };
  const sliceBox = (m, z) => {
    let minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9;
    for (let i = 0; i < m.positions.length; i += 3) {
      if (Math.abs(m.positions[i + 2] - z) < 1e-4) {
        minX = Math.min(minX, m.positions[i]); maxX = Math.max(maxX, m.positions[i]);
        minY = Math.min(minY, m.positions[i + 1]); maxY = Math.max(maxY, m.positions[i + 1]);
      }
    }
    return { w: maxX - minX, h: maxY - minY };
  };

  const trace = { outer, holes: [], circles: [] };
  const bin = buildGridfinityBin(trace, { clearance: 0.5, depth: 5, lip: true, magnets: false });
  const plain = buildGridfinityBin(trace, { clearance: 0.5, depth: 5, lip: false, magnets: false });
  const mag = buildGridfinityBin(trace, { clearance: 0.5, depth: 5, lip: false, magnets: true });

  return {
    ok: !!bin && !!plain && !!mag,
    bad: bin ? badEdges(bin) : -1,
    plainBad: plain ? badEdges(plain) : -1,
    magBad: mag ? badEdges(mag) : -1,
    cells: bin ? bin.stats.cells : null,
    sizeX: bin ? bin.stats.sizeX : 0, sizeY: bin ? bin.stats.sizeY : 0,
    z: bin ? zRange(bin) : null,
    plainTop: plain ? zRange(plain).hi : 0,
    padBottom: bin ? sliceBox(bin, 0) : null,      // pad bottoms: 35.6 per cell
    baseTop: bin ? hasZ(bin, 4.75) : false,        // base profile tops out at 4.75
    pocketFloor: bin ? hasZ(bin, 14 - 5) : false,  // 2u bin, depth 5 → floor at 9
    magCeil: mag ? hasZ(mag, 2.4) : false,         // magnet ceilings
    magCeilOff: bin ? hasZ(bin, 2.4) : false,      // absent without magnets
  };
});

console.log('\nGridfinity bin (holders.js)');
check('bins build watertight (lip / plain / magnets)',
  grid.ok && grid.bad === 0 && grid.plainBad === 0 && grid.magBad === 0,
  `${grid.bad}/${grid.plainBad}/${grid.magBad} bad edges`);
check('auto grid size = 2×1 cells, footprint 83.5 × 41.5 (spec 42−0.5)',
  grid.cells && grid.cells.n === 2 && grid.cells.m === 1 &&
  near(grid.sizeX, 83.5, 0.01) && near(grid.sizeY, 41.5, 0.01),
  `${grid.cells?.n}×${grid.cells?.m}, ${grid.sizeX} × ${grid.sizeY}`);
check('height = 2u (14) + 4.4 lip; plain bin tops at 14',
  grid.z && near(grid.z.lo, 0, 1e-6) && near(grid.z.hi, 18.4, 0.1) && near(grid.plainTop, 14, 1e-6),
  `${grid.z?.lo}..${grid.z?.hi}, plain ${grid.plainTop}`);
check('base pads bottom out at 35.6 per cell and top at 4.75',
  grid.padBottom && near(grid.padBottom.h, 35.6, 0.05) && near(grid.padBottom.w, 35.6 + 42, 0.05) && grid.baseTop,
  `bottom span ${grid.padBottom?.w.toFixed(1)} × ${grid.padBottom?.h.toFixed(1)}`);
check('pocket floor lands at 14 − 5 = 9', grid.pocketFloor, '');
check('magnet holes appear only when enabled (ceilings at 2.4)',
  grid.magCeil && !grid.magCeilOff, '');

// ---------- Gridfinity baseplate (holders.js) ----------

const plate = await page.evaluate(async () => {
  const { buildBaseplate } = await import('/js/holders.js');
  const badEdges = m => {
    const use = new Map();
    const k = i => `${m.positions[i*3].toFixed(4)},${m.positions[i*3+1].toFixed(4)},${m.positions[i*3+2].toFixed(4)}`;
    for (let t = 0; t < m.indices.length; t += 3) {
      const ks = [k(m.indices[t]), k(m.indices[t+1]), k(m.indices[t+2])];
      if (ks[0] === ks[1] || ks[1] === ks[2] || ks[0] === ks[2]) continue;
      for (let e = 0; e < 3; e++) {
        const a = ks[e], b = ks[(e+1)%3], key = a < b ? a+'|'+b : b+'|'+a;
        use.set(key, (use.get(key) || 0) + 1);
      }
    }
    let bad = 0;
    for (const v of use.values()) if (v !== 2) bad++;
    return bad;
  };
  const hasZ = (m, z) => {
    for (let i = 2; i < m.positions.length; i += 3) {
      if (Math.abs(m.positions[i] - z) < 1e-4) return true;
    }
    return false;
  };
  // An L-shaped "drawer": 130×130 with one 44×44 corner cell bitten out.
  // Grid centring puts a 3×3 grid on the bbox (cells span 2..44..86..128);
  // exactly the bitten corner's cell must be skipped → 8 sockets.
  const L = [
    { x: 0, y: 0 }, { x: 130, y: 0 }, { x: 130, y: 86 },
    { x: 86, y: 86 }, { x: 86, y: 130 }, { x: 0, y: 130 },
  ];
  const res = buildBaseplate({ outer: L, holes: [], circles: [] }, { floorT: 1.2 });
  const tiny = buildBaseplate({ outer: [{ x: 0, y: 0 }, { x: 30, y: 0 }, { x: 30, y: 30 }, { x: 0, y: 30 }] }, {});
  return {
    ok: !!res && !res.reason,
    bad: res && res.positions ? badEdges(res) : -1,
    cellCount: res?.stats?.cells?.count ?? -1,
    sizeZ: res?.stats?.sizeZ || 0,
    socketFloor: res && res.positions ? hasZ(res, 1.2) : false, // T − 4.75
    tinyReason: tiny ? tiny.reason : 'none',
  };
});

// Multi-tool Gridfinity bin (layout pockets in a bin body — the hybrid).
const gridLayout = await page.evaluate(async () => {
  const { buildLayoutGridBin } = await import('/js/holders.js');
  const badEdges = m => {
    const use = new Map();
    const k = i => `${m.positions[i*3].toFixed(4)},${m.positions[i*3+1].toFixed(4)},${m.positions[i*3+2].toFixed(4)}`;
    for (let t = 0; t < m.indices.length; t += 3) {
      const ks = [k(m.indices[t]), k(m.indices[t+1]), k(m.indices[t+2])];
      if (ks[0] === ks[1] || ks[1] === ks[2] || ks[0] === ks[2]) continue;
      for (let e = 0; e < 3; e++) {
        const a = ks[e], b = ks[(e+1)%3], key = a < b ? a+'|'+b : b+'|'+a;
        use.set(key, (use.get(key) || 0) + 1);
      }
    }
    let bad = 0;
    for (const v of use.values()) if (v !== 2) bad++;
    return bad;
  };
  const toolOutline = [{ x: 5, y: 5 }, { x: 35, y: 5 }, { x: 35, y: 20 }, { x: 5, y: 20 }]; // 30×15
  const mk = (x, y, depth) =>
    ({ name: 't', outer: toolOutline, holes: [], circles: [], x, y, rot: 0, depth, thickness: 5 });
  // 3×1 bin (125.5 × 41.5): two tools side by side.
  const res = buildLayoutGridBin({ n: 3, m: 1, lip: true, magnets: false },
    [mk(35, 25, 4), mk(90, 25, 6)], { clearance: 0.5 });
  const clash = buildLayoutGridBin({ n: 3, m: 1, lip: true, magnets: false },
    [mk(35, 25, 4), mk(45, 25, 6)], { clearance: 0.5 });
  return {
    ok: !!res && !res.reason,
    bad: res && res.positions ? badEdges(res) : -1,
    sizeX: res?.stats?.sizeX || 0, sizeY: res?.stats?.sizeY || 0,
    u: res?.stats?.cells?.u || 0,
    clashReason: clash ? clash.reason : 'none',
  };
});
check('multi-tool Gridfinity bin builds watertight (two depths)',
  gridLayout.ok && gridLayout.bad === 0, `${gridLayout.bad} bad edges`);
check('bin footprint = 3×1 cells (125.5 × 41.5), auto 2u',
  near(gridLayout.sizeX, 125.5, 0.01) && near(gridLayout.sizeY, 41.5, 0.01) && gridLayout.u === 2,
  `${gridLayout.sizeX} × ${gridLayout.sizeY}, ${gridLayout.u}u`);
check('overlapping tools in a bin refuse with a reason', gridLayout.clashReason === 'collision',
  gridLayout.clashReason);

// Placeable finger notches + hole-pivot placement.
const notches = await page.evaluate(async () => {
  const { buildFoamInsert, buildGridfinityBin, layoutPockets, layoutConflicts, gridContainerLoop } =
    await import('/js/holders.js');
  const outer = [{ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 40, y: 30 }, { x: 0, y: 30 }];
  const trace = { outer, holes: [], circles: [] };
  const badEdges = m => {
    const use = new Map();
    const k = i => `${m.positions[i*3].toFixed(4)},${m.positions[i*3+1].toFixed(4)},${m.positions[i*3+2].toFixed(4)}`;
    for (let t = 0; t < m.indices.length; t += 3) {
      const ks = [k(m.indices[t]), k(m.indices[t+1]), k(m.indices[t+2])];
      if (ks[0] === ks[1] || ks[1] === ks[2] || ks[0] === ks[2]) continue;
      for (let e = 0; e < 3; e++) {
        const a = ks[e], b = ks[(e+1)%3], key = a < b ? a+'|'+b : b+'|'+a;
        use.set(key, (use.get(key) || 0) + 1);
      }
    }
    let bad = 0;
    for (const v of use.values()) if (v !== 2) bad++;
    return bad;
  };

  // Custom-position foam notches: two different fractions move the bulge.
  const fA = buildFoamInsert(trace, { clearance: 0.5, margin: 10, depth: 5, floor: 3, notch: 'custom', notchFrac: 0.1, notchDia: 20 });
  const fB = buildFoamInsert(trace, { clearance: 0.5, margin: 10, depth: 5, floor: 3, notch: 'custom', notchFrac: 0.35, notchDia: 20 });
  const bboxAt = (m, z) => {
    let minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9;
    for (let i = 0; i < m.positions.length; i += 3) {
      if (Math.abs(m.positions[i+2] - z) > 1e-4) continue;
      minX = Math.min(minX, m.positions[i]); maxX = Math.max(maxX, m.positions[i]);
      minY = Math.min(minY, m.positions[i+1]); maxY = Math.max(maxY, m.positions[i+1]);
    }
    return { minX, minY, maxX, maxY };
  };
  const moved = fA && fB &&
    JSON.stringify(bboxAt(fA, 3)) !== JSON.stringify(bboxAt(fB, 3));

  // Gridfinity notch: a Ø25 bottom notch pushes the 2×1 bin to 2×2.
  const gPlain = buildGridfinityBin(trace, { clearance: 0.5, depth: 5, lip: true });
  const gNotch = buildGridfinityBin(trace, { clearance: 0.5, depth: 5, lip: true, notch: 'bottom', notchDia: 25 });

  // Layout: notch stored item-local, snapped to the pocket boundary; and the
  // pillar pivot fix — an off-centre hole must place at its offset.
  const item = {
    name: 't', outer, holes: [[{ x: 30, y: 7 }, { x: 38, y: 7 }, { x: 38, y: 13 }, { x: 30, y: 13 }]].map(h => h),
    circles: [], x: 60, y: 45, rot: 0, depth: 4, thickness: 5,
    notch: { x: 20, y: 30, dia: 20 },
  };
  const pk = layoutPockets([item], 0.5)[0];
  // Outline centre (20,15); hole centre (34,10) → world (60+14, 45−5) = (74, 40).
  const pillarBB = pk.pillars.length ? (() => {
    let minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9;
    for (const p of pk.pillars[0]) {
      minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
      minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
    }
    return { cx: (minX + maxX) / 2, cy: (minY + maxY) / 2 };
  })() : null;
  // Border escape via notch: tool near the bin wall, notch pointing at it.
  const nearWall = { ...item, x: 30, y: 26, notch: { x: 20, y: 30, dia: 20 } };
  const esc = layoutConflicts(gridContainerLoop(2, 1),
    layoutPockets([nearWall], 0.5), 2.6);

  return {
    foamOK: !!fA && !!fB && badEdges(fA) === 0 && badEdges(fB) === 0, moved,
    gPlainM: gPlain?.stats?.cells?.m || 0,
    gNotchM: gNotch?.stats?.cells?.m || 0,
    gNotchBad: gNotch ? badEdges(gNotch) : -1,
    notchAtY: pk.notchAt ? pk.notchAt.y : 0,   // pocket bottom ≈ 45+15+0.5
    pillar: pillarBB,                            // expect ≈ (69, 40)
    escaped: esc.escaped.size,
  };
});

console.log('\nPlaceable finger notches');
check('custom-position foam notches build watertight and move with the slider',
  notches.foamOK && notches.moved, `moved ${notches.moved}`);
check('Gridfinity notch counts toward grid fit (2×1 → 2×2) and stays watertight',
  notches.gPlainM === 1 && notches.gNotchM === 2 && notches.gNotchBad === 0,
  `m ${notches.gPlainM}→${notches.gNotchM}, ${notches.gNotchBad} bad edges`);
check('layout notch snaps to the pocket boundary near its stored point',
  near(notches.notchAtY, 60.5, 0.6), `y ${notches.notchAtY.toFixed(2)}`);
check('off-centre tool hole pillars keep their offset (pivot fix)',
  notches.pillar && near(notches.pillar.cx, 74, 0.6) && near(notches.pillar.cy, 40, 0.6),
  notches.pillar ? `(${notches.pillar.cx.toFixed(1)}, ${notches.pillar.cy.toFixed(1)})` : 'no pillar');
check('a notch pointing at the bin wall flags the tool as escaped',
  notches.escaped === 1, `${notches.escaped} escaped`);

console.log('\nGridfinity baseplate (holders.js)');
check('L-shaped plate builds watertight', plate.ok && plate.bad === 0, `${plate.bad} bad edges`);
check('partial cells skipped (8 of 9 sockets in the L)', plate.cellCount === 8, `${plate.cellCount} sockets`);
check('plate = 4.75 socket + 1.2 floor; socket floors at z=1.2',
  near(plate.sizeZ, 5.95, 1e-6) && plate.socketFloor, `T ${plate.sizeZ}`);
check('outline too small for any cell reports nocells', plate.tinyReason === 'nocells', plate.tinyReason);

// ---------- Holster / wall holder (holders.js) ----------

const holster = await page.evaluate(async () => {
  const { buildHolster } = await import('/js/holders.js');
  const outer = [{ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 40, y: 30 }, { x: 0, y: 30 }];
  const trace = { outer, holes: [], circles: [] };
  // Per-shell watertightness: overlapping shells legitimately share pinch
  // planes only if coordinates collide — leaks (odd edge use) must be zero.
  const leaks = m => {
    const use = new Map();
    const k = i => `${m.positions[i*3].toFixed(4)},${m.positions[i*3+1].toFixed(4)},${m.positions[i*3+2].toFixed(4)}`;
    for (let t = 0; t < m.indices.length; t += 3) {
      const ks = [k(m.indices[t]), k(m.indices[t+1]), k(m.indices[t+2])];
      if (ks[0] === ks[1] || ks[1] === ks[2] || ks[0] === ks[2]) continue;
      for (let e = 0; e < 3; e++) {
        const a = ks[e], b = ks[(e+1)%3], key = a < b ? a+'|'+b : b+'|'+a;
        use.set(key, (use.get(key) || 0) + 1);
      }
    }
    let odd = 0, exact = 0;
    for (const v of use.values()) { if (v % 2 === 1) odd++; if (v !== 2) exact++; }
    return { odd, exact };
  };

  const band = buildHolster(trace, { clearance: 1, wall: 2.4, height: 20, floor: 0, flat: 'none', mount: 'none' });
  const full = buildHolster(trace, { clearance: 1, wall: 2.4, height: 20, floor: 2, flat: 'bottom', mount: 'both' });
  const bandT = band ? leaks(band) : { odd: -1, exact: -1 };
  const fullT = full ? leaks(full) : { odd: -1, exact: -1 };

  // Open band: nothing inside the tool area (through opening) — no vertex
  // strictly inside the inner ring except at no z at all.
  const zAt = (m, fx) => {
    let found = false;
    for (let i = 0; i < m.positions.length; i += 3) if (fx(m.positions[i], m.positions[i+1], m.positions[i+2])) { found = true; break; }
    return found;
  };
  return {
    bandOK: !!band, fullOK: !!full,
    bandLeaks: bandT, fullLeaks: fullT,
    // band: 40×30 tool + 1 clearance + 2.4 wall → outer ≈ 46.8 × 36.8
    bandW: band?.stats?.sizeX || 0, bandH: band?.stats?.sizeY || 0, bandZ: band?.stats?.sizeZ || 0,
    // full: flat bottom + plate (3 − 0.01 proud) + keyhole tab 22 above band
    fullZ: full?.stats?.sizeZ || 0,
    fullW: full?.stats?.sizeX || 0,
    // keyhole ring: verts near (x≈0, z≈height+6) on the plate
    keyhole: full ? zAt(full, (x, y, z) => Math.abs(x) < 5 && z > 22 && z < 30 && y < -17) : false,
    // wings: verts beyond the band width on both sides
    wingHole: full ? zAt(full, (x, y, z) => Math.abs(x) > 24 && y < -17 && z > 5 && z < 15) : false,
    // Any z=2 vertex is the plug's top cap — the band has verts only at 0/20.
    floorPlane: full ? zAt(full, (x, y, z) => Math.abs(z - 2) < 1e-4) : false,
  };
});

console.log('\nHolster / wall holder (holders.js)');
check('open band builds watertight', holster.bandOK && holster.bandLeaks.exact === 0,
  `${holster.bandLeaks.exact} bad edges`);
check('band size = outline + clearance + wall (≈46.8 × 36.8 × 20)',
  near(holster.bandW, 46.8, 0.3) && near(holster.bandH, 36.8, 0.3) && near(holster.bandZ, 20, 1e-6),
  `${holster.bandW.toFixed(1)} × ${holster.bandH.toFixed(1)} × ${holster.bandZ}`);
check('flat back + floor + keyhole + wings: no open edges across shells',
  holster.fullOK && holster.fullLeaks.odd === 0, `${holster.fullLeaks.odd} open edges`);
check('keyhole tab rises above the band with its slot',
  near(holster.fullZ, 42, 0.5) && holster.keyhole, `top ${holster.fullZ.toFixed(1)}, ring ${holster.keyhole}`);
check('screw wings extend past the band with holes', holster.wingHole && holster.fullW > 60,
  `width ${holster.fullW.toFixed(1)}`);
check('floor plug closes the bottom at 2 mm', holster.floorPlane, '');

console.log('\nText → loops (emboss/deboss foundation)');
check('blank text yields no loops', textRes.blankN === 0, `${textRes.blankN}`);
check('"O" produces a counter (outer + hole ≥ 2 loops)', textRes.oN >= 2, `${textRes.oN} loops`);
check('labelLoops places glyphs at the requested height + centre',
  textRes.lblN >= 1 && near(textRes.h, 10, 0.5) && near(textRes.cx, 50, 3) && near(textRes.cy, 30, 3),
  `h ${textRes.h?.toFixed(1)}, centre (${textRes.cx?.toFixed(1)},${textRes.cy?.toFixed(1)})`);

console.log('\nBeyond-the-paper capture');
check('margin insets the paper inside a larger canvas',
  beyond.on.paperRight < beyond.on.W && beyond.off.paperRight === beyond.off.W,
  `on paper-edge ${beyond.on.paperRight}/${beyond.on.W}, off ${beyond.off.paperRight}/${beyond.off.W}`);
check('scale is self-consistent (paperRect width = 100 mm × pxPerMm)',
  beyond.on.paperW === Math.round(100 * beyond.on.ppm) && beyond.off.paperW === Math.round(100 * beyond.off.ppm),
  `on ${beyond.on.paperW}@${beyond.on.ppm}, off ${beyond.off.paperW}@${beyond.off.ppm}`);
check('with margin, the object is captured past the paper edge, uncropped',
  beyond.on.maxX > beyond.on.paperRight && beyond.on.maxX < beyond.on.W,
  `object maxX ${beyond.on.maxX}, paper edge ${beyond.on.paperRight}, canvas ${beyond.on.W}`);
check('without margin, the object is cropped at the paper edge',
  beyond.off.maxX >= beyond.off.W - 3, `off maxX ${beyond.off.maxX} ≈ edge ${beyond.off.W}`);

console.log('\nSection clipping (bed vs overhang)');
check('bed-level section is clipped to the outline (no body past x=40)',
  clip.bedMaxX <= 40.5, `max x ${clip.bedMaxX.toFixed(2)}`);
check('bed-level clip is reported as a warning', clip.bedWarned, '');
check('raised overhang section keeps its full footprint (reaches x≈60)',
  clip.overMaxX > 55, `max x ${clip.overMaxX.toFixed(2)}`);

console.log('\nAuto-detect fillets');
check('detects the rounded corner and registers a fillet arc', detect.nMade === 1, `${detect.nMade}`);
check('recovers the fillet radius (~6 mm)', detect.arcR !== null && near(detect.arcR, 6, 0.3), `r ${detect.arcR}`);
check('leaves a plain square alone', detect.nSquare === 0 && detect.arcsCount === 0, `${detect.nSquare} converted`);

console.log('\nDXF bulge round-trip (arc-aware import)');
check('exported fillet re-imports as a flattened arc (many points)', rt.nNear > 5, `${rt.nNear} pts`);
check('round-tripped arc recovers the fillet radius',
  rt.rtR !== null && near(rt.rtR, rt.origR, 0.1), `r ${rt.rtR?.toFixed(3)} vs ${rt.origR.toFixed(3)}`);
check('round-tripped arc recovers the fillet centre',
  rt.rtCx !== null && near(rt.rtCx, rt.origCx, 0.1) && near(rt.rtCy, rt.origCy, 0.1),
  `(${rt.rtCx?.toFixed(2)},${rt.rtCy?.toFixed(2)}) vs (${rt.origCx.toFixed(2)},${rt.origCy.toFixed(2)})`);

console.log('\nMeasure/constrain UI pipeline');
check('vertex picks produce a p2p, rim pick a radius measurement',
  String(ui.measures) === 'p2p,rad', String(ui.measures));
check('edge pick + H constraint levels the edge via the solver',
  ui.picks.length === 1 && ui.picks[0] === 'edge' && ui.added &&
  ui.nCons === 1 && ui.levelled < 1e-3,
  `picks ${ui.picks}, Δy ${ui.levelled}`);

// ---------- back photo (underside) registration + underside sections ----------

const backReg = await page.evaluate(async () => {
  const { silhouetteOf, registerBack, renderRegistered } = await import('/js/backphoto.js');
  // Synthetic "front": paper-ish background with a dark L-shaped object.
  const W = 400, H = 300;
  const mk = () => {
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const ctx = c.getContext('2d');
    // Slight gradient: a perfectly flat synthetic background degenerates
    // Otsu's threshold (real photos always carry noise).
    const g = ctx.createLinearGradient(0, 0, W, H);
    g.addColorStop(0, '#f1efe8');
    g.addColorStop(1, '#f7f5ef');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
    return c;
  };
  const drawL = ctx => {
    ctx.fillStyle = '#333';
    ctx.beginPath();
    ctx.moveTo(120, 90); ctx.lineTo(280, 90); ctx.lineTo(280, 140);
    ctx.lineTo(170, 140); ctx.lineTo(170, 210); ctx.lineTo(120, 210);
    ctx.closePath(); ctx.fill();
  };
  const front = mk();
  drawL(front.getContext('2d'));
  // Synthetic "back photo": the same scene mirrored (flipped object) and
  // rotated 22° about the canvas centre.
  const back = mk();
  const bctx = back.getContext('2d');
  bctx.translate(W / 2, H / 2);
  bctx.rotate((22 * Math.PI) / 180);
  bctx.scale(-1, 1);
  bctx.translate(-W / 2, -H / 2);
  drawL(bctx);
  bctx.setTransform(1, 0, 0, 1, 0, 0);

  const frontSil = silhouetteOf(front);
  const backSil = silhouetteOf(back);
  if (!frontSil || !backSil) return { ok: false };
  const align = registerBack(frontSil, backSil, W, 1);
  align.scale = 1;
  const reg = renderRegistered(back, W, H, align);
  const rctx = reg.getContext('2d');
  const darkAt = (x, y) => rctx.getImageData(x, y, 1, 1).data[0] < 120;
  return {
    ok: true,
    score: align.score,
    // Interior probes of the L must be dark in the registered image; the
    // notch (removed quadrant) must be light.
    inA: darkAt(140, 110), inB: darkAt(260, 115), inC: darkAt(140, 190),
    outA: !darkAt(240, 190), outB: !darkAt(60, 40),
  };
});
console.log('\nBack photo (underside) registration');
check('mirrored + 22°-rotated back photo registers onto the front (probes match)',
  backReg.ok && backReg.inA && backReg.inB && backReg.inC && backReg.outA && backReg.outB,
  `score ${backReg.score?.toFixed(2)} px`);
// The score carries segmentation noise (antialiasing, morphology) on top of
// alignment error — it gates the UI hint, not geometry. Sane = well under
// the ~12 px (3 mm at 4 px/mm) "looks rough" warning threshold.
check('alignment score is sane (< 10 px incl. segmentation noise)',
  backReg.ok && backReg.score < 10, `${backReg.score?.toFixed(2)} px`);

const undersideMesh = await page.evaluate(async () => {
  const { buildModel } = await import('/js/mesh.js');
  const outer = [{ x: 0, y: 0 }, { x: 60, y: 0 }, { x: 60, y: 40 }, { x: 0, y: 40 }];
  const none = { mode: 'none', size: 0 };
  const regions = [
    { name: 'Base', pts: null, thickness: 6, zBase: 0, top: none, bottom: none },
    { name: 'Under', underside: true, thickness: 2.5, zBase: 0, top: none, bottom: none,
      pts: [{ x: 15, y: 12 }, { x: 35, y: 12 }, { x: 35, y: 28 }, { x: 15, y: 28 }] },
  ];
  const m = buildModel(outer, [], [], regions, { arcSegments: 6 });
  if (!m) return { ok: false };
  const use = new Map();
  const k = i => `${m.positions[i*3].toFixed(4)},${m.positions[i*3+1].toFixed(4)},${m.positions[i*3+2].toFixed(4)}`;
  for (let t = 0; t < m.indices.length; t += 3) {
    const ks = [k(m.indices[t]), k(m.indices[t+1]), k(m.indices[t+2])];
    if (ks[0] === ks[1] || ks[1] === ks[2] || ks[0] === ks[2]) continue;
    for (let e = 0; e < 3; e++) {
      const a = ks[e], b = ks[(e+1)%3], key = a < b ? a+'|'+b : b+'|'+a;
      use.set(key, (use.get(key) || 0) + 1);
    }
  }
  let bad = 0;
  for (const v of use.values()) if (v !== 2) bad++;
  const hasZ = z => {
    for (let i = 2; i < m.positions.length; i += 3) {
      if (Math.abs(m.positions[i] - z) < 1e-6) return true;
    }
    return false;
  };
  return {
    ok: true, bad,
    sizeZ: m.stats.sizeZ,
    parts: m.stats.sections,
    recessCeil: hasZ(2.5),  // bottom recess: ceiling at z = off-bed depth
  };
});
// The underside is opt-in: nothing in the default trace flow asks for a
// second photo, and the fork only appears once there's an outline to reuse.
const undersideUI = await page.evaluate(async () => {
  const app = window.__app;
  app.goStep(2);
  await new Promise(r => setTimeout(r, 200));
  // Earlier suites leave the trace cleared; give this one a plain outline
  // (goStep can re-run detection, so seed it after the step switch).
  app.traceEditor.setTrace(
    [{ x: 20, y: 20 }, { x: 80, y: 20 }, { x: 80, y: 60 }, { x: 20, y: 60 }], []);
  app.updateTraceInfo();
  const forkVisible = !document.getElementById('undersideForkRow').hidden;
  const panelVisible = !document.getElementById('undersidePanel').hidden;
  const toolsEnabled = [...document.querySelectorAll('.tool-btn')].every(b => !b.disabled);
  // Enter the fork with a back photo already registered (bypass the file
  // picker by seeding state the way the loader does).
  const front = app.state.rect.canvas;
  const c = document.createElement('canvas');
  c.width = front.width; c.height = front.height;
  const ctx = c.getContext('2d');
  ctx.drawImage(front, 0, 0);
  app.state.back.rect = { canvas: c, pxPerMm: app.state.rect.pxPerMm };
  app.state.back.align = { rot: 0, cB: { x: 0, y: 0 }, cF: { x: 0, y: 0 }, scale: 1, score: 1 };
  app.backRender();
  document.getElementById('undersideForkBtn').click();
  await new Promise(r => setTimeout(r, 150));
  const inMode = {
    panel: !document.getElementById('undersidePanel').hidden,
    forkHidden: document.getElementById('undersideForkRow').hidden,
    mode: app.traceEditor.mode,
    locked: app.traceEditor.lockOutline === true,
    editDisabled: document.querySelector('.tool-btn[data-tool="edit"]').disabled,
    regionEnabled: !document.querySelector('.tool-btn[data-tool="region"]').disabled,
    title: document.getElementById('panel2Title').textContent,
  };
  // Outline edits must be refused while locked.
  app.traceEditor.setMode('edit');
  const stillRegion = app.traceEditor.mode === 'region';
  const outlineBefore = app.traceEditor.getTrace().outer.length;

  // Drawing a section here must produce an UNDERCUT, not an extruded prism.
  const regionsBefore = app.state.regions.length;
  app.traceEditor._draftRegion = [
    { x: 35, y: 30 }, { x: 65, y: 30 }, { x: 65, y: 50 }, { x: 35, y: 50 }];
  app.traceEditor.commitDraftRegion();
  await new Promise(r => setTimeout(r, 100));
  const drawn = app.state.regions[app.state.regions.length - 1];
  const undercut = {
    added: app.state.regions.length === regionsBefore + 1,
    flagged: drawn.underside === true,
    named: /^Under /.test(drawn.name),
    depthUnderBase: drawn.thickness > 0 && drawn.thickness < app.state.regions[0].thickness,
    selected: app.state.selRegion === app.state.regions.length - 1,
    // Step-3 fields must switch to off-bed-depth semantics for it.
    label: document.querySelector('label[for="thickness"]').textContent,
    floorLocked: document.getElementById('floorOffset').disabled,
  };
  document.getElementById('undersideDoneBtn').click();
  await new Promise(r => setTimeout(r, 150));
  const after = {
    panelHidden: document.getElementById('undersidePanel').hidden,
    unlocked: !app.traceEditor.lockOutline,
    mode: app.traceEditor.mode,
    outlineSame: app.traceEditor.getTrace().outer.length === outlineBefore,
  };
  return { forkVisible, panelVisible, toolsEnabled, inMode, stillRegion, after, undercut };
});
check('default trace flow never asks for a back photo (fork offered, panel closed)',
  undersideUI.forkVisible && !undersideUI.panelVisible && undersideUI.toolsEnabled, '');
check('entering the fork opens underside mode with the outline locked',
  undersideUI.inMode.panel && undersideUI.inMode.forkHidden &&
  undersideUI.inMode.mode === 'region' && undersideUI.inMode.locked &&
  undersideUI.inMode.editDisabled && undersideUI.inMode.regionEnabled &&
  /underside/.test(undersideUI.inMode.title),
  undersideUI.inMode.title);
check('outline-editing modes are refused while in underside mode',
  undersideUI.stillRegion, `mode ${undersideUI.inMode.mode}`);
check('a section drawn in underside mode becomes an undercut (bottom recess)',
  undersideUI.undercut.added && undersideUI.undercut.flagged &&
  undersideUI.undercut.named && undersideUI.undercut.depthUnderBase &&
  undersideUI.undercut.selected,
  `${undersideUI.undercut.label}, flagged ${undersideUI.undercut.flagged}`);
check('step 3 switches that section to off-bed-depth semantics',
  /Off-bed depth/.test(undersideUI.undercut.label) && undersideUI.undercut.floorLocked,
  undersideUI.undercut.label);
check('Done returns to the top view with the same outline reused',
  undersideUI.after.panelHidden && undersideUI.after.unlocked &&
  undersideUI.after.mode === 'edit' && undersideUI.after.outlineSame, '');

check('underside section carves a bottom recess in one watertight shell',
  undersideMesh.ok && undersideMesh.bad === 0 && undersideMesh.parts === 1 &&
  near(undersideMesh.sizeZ, 6, 1e-6) && undersideMesh.recessCeil,
  `${undersideMesh.bad} bad edges, ${undersideMesh.parts} parts, ceiling ${undersideMesh.recessCeil}`);


// ---------- graph / dot-grid reference ----------

const gridRef = await page.evaluate(async () => {
  const { GRID_PITCHES, gridPitchMm, gridDims, analyzeGrid } = await import('/js/gridRef.js');
  // Synthetic rectified sheet: 5 mm grid at 8 px/mm = 40 px pitch.
  const ppm = 8, pitch = 5, W = 480, H = 360;
  const mkGrid = (pitchPx, dots) => {
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fbfbf7'; ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#9fb6d9';
    for (let x = 0; x <= W; x += pitchPx) {
      for (let y = 0; y <= H; y += pitchPx) {
        if (dots) ctx.fillRect(x - 1, y - 1, 2, 2);
      }
      if (!dots) ctx.fillRect(x, 0, 1, H);
    }
    if (!dots) for (let y = 0; y <= H; y += pitchPx) ctx.fillRect(0, y, W, 1);
    return c;
  };
  const lines = analyzeGrid(mkGrid(pitch * ppm, false), ppm, pitch);
  const dots = analyzeGrid(mkGrid(pitch * ppm, true), ppm, pitch);
  // A miscount: the user said 10 squares where there were really 9, so the
  // rectified pitch comes out 10/9 too large. Must be flagged, not accepted.
  const miscount = analyzeGrid(mkGrid(pitch * ppm * (10 / 9), false), ppm, pitch);
  const blank = (() => {
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fbfbf7'; ctx.fillRect(0, 0, W, H);
    return c;
  })();
  return {
    pitches: Object.keys(GRID_PITCHES).length,
    inch4: gridPitchMm('in4'), mm10: gridPitchMm('mm10'), custom: gridPitchMm('custom', 3.7),
    dims: gridDims(6.35, 8, 5),
    lines: lines && { mm: lines.detectedMm, ok: lines.ok },
    dots: dots && { mm: dots.detectedMm, ok: dots.ok },
    miscount: miscount && { mm: miscount.detectedMm, ok: miscount.ok, ratio: miscount.ratio },
    blank: analyzeGrid(blank, ppm, pitch),
  };
});

console.log('\nGraph / dot-grid reference');
check('pitch table covers metric + imperial (1/4 in = 6.35, 1 cm = 10, custom passthrough)',
  gridRef.pitches >= 12 && near(gridRef.inch4, 6.35, 1e-9) &&
  near(gridRef.mm10, 10, 1e-9) && near(gridRef.custom, 3.7, 1e-9),
  `${gridRef.pitches} entries`);
check('counted squares set the rectified size (8 × 5 at 1/4 in = 50.8 × 31.75 mm)',
  near(gridRef.dims.w, 50.8, 1e-9) && near(gridRef.dims.h, 31.75, 1e-9),
  `${gridRef.dims.w} × ${gridRef.dims.h}`);
check('printed pitch is measured back out of a line grid (5 mm)',
  gridRef.lines && gridRef.lines.ok && near(gridRef.lines.mm, 5, 0.25),
  gridRef.lines ? `${gridRef.lines.mm.toFixed(2)} mm` : 'not detected');
check('dot grids read the same as line grids',
  gridRef.dots && gridRef.dots.ok && near(gridRef.dots.mm, 5, 0.25),
  gridRef.dots ? `${gridRef.dots.mm.toFixed(2)} mm` : 'not detected');
check('a miscounted span is caught (9 squares called 10 → flagged, not accepted)',
  gridRef.miscount && !gridRef.miscount.ok && near(gridRef.miscount.ratio, 10 / 9, 0.05),
  gridRef.miscount ? `${gridRef.miscount.mm.toFixed(2)} mm, ratio ${gridRef.miscount.ratio.toFixed(3)}` : 'not detected');
check('blank paper reports no grid rather than inventing one',
  gridRef.blank === null, String(gridRef.blank));


// Full pipeline in grid mode: a synthetic photo of a 60 x 40 mm object on
// 5 mm graph paper, handles on intersections 20 x 14 squares apart.
const gridFlow = await page.evaluate(async () => {
  const app = window.__app;
  const ppm = 6, pitch = 5, nx = 20, ny = 14;      // 100 x 70 mm spanned
  const W = nx * pitch * ppm, H = ny * pitch * ppm; // exact, shot square-on
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fcfcf8'; ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = '#a8bcdb';
  for (let x = 0; x <= W; x += pitch * ppm) ctx.fillRect(x, 0, 1, H);
  for (let y = 0; y <= H; y += pitch * ppm) ctx.fillRect(0, y, W, 1);
  // 60 x 40 mm dark object, centred.
  ctx.fillStyle = '#2b2b2b';
  ctx.fillRect((W - 60 * ppm) / 2, (H - 40 * ppm) / 2, 60 * ppm, 40 * ppm);

  app.state.reference = 'grid';
  document.getElementById('refType').value = 'grid';
  document.getElementById('refType').dispatchEvent(new Event('change'));
  Object.assign(app.state.grid, { pitch: 'mm5', nx, ny });
  app.state.captureFrac = 0;
  await new Promise(res => app.loadImageFromURL(c.toDataURL('image/png'), res));
  // Handles exactly on the spanned intersections (the outer grid lines).
  app.state.corners = [
    { x: 0, y: 0 }, { x: W, y: 0 }, { x: W, y: H }, { x: 0, y: H }];
  app.cornerEditor.setCorners(app.state.corners);
  app.state.rectDirty = true;
  app.goStep(2);
  await new Promise(r => setTimeout(r, 700));
  const t = app.traceEditor.getTrace();
  let minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9;
  for (const p of t.outer || []) {
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
  }
  return {
    pxPerMm: app.state.rect ? app.state.rect.pxPerMm : 0,
    rectMm: app.state.rect
      ? { w: app.state.rect.canvas.width / app.state.rect.pxPerMm,
          h: app.state.rect.canvas.height / app.state.rect.pxPerMm } : null,
    traced: t.outer ? { w: maxX - minX, h: maxY - minY } : null,
    checkText: document.getElementById('gridCheck').textContent,
    controlsShown: !document.getElementById('gridRefControls').hidden &&
      document.getElementById('rectRefControls').hidden,
  };
});
check('grid mode shows its own controls and rectifies to counted squares (100 x 70 mm)',
  gridFlow.controlsShown && gridFlow.rectMm &&
  near(gridFlow.rectMm.w, 100, 0.6) && near(gridFlow.rectMm.h, 70, 0.6),
  gridFlow.rectMm ? `${gridFlow.rectMm.w.toFixed(1)} x ${gridFlow.rectMm.h.toFixed(1)} mm` : 'no rect');
check('object traces at true scale through a grid reference (60 x 40 mm)',
  gridFlow.traced && near(gridFlow.traced.w, 60, 1.5) && near(gridFlow.traced.h, 40, 1.5),
  gridFlow.traced ? `${gridFlow.traced.w.toFixed(1)} x ${gridFlow.traced.h.toFixed(1)} mm` : 'no trace');
check('the square count is verified against the printed pitch after rectifying',
  /checks out/.test(gridFlow.checkText), gridFlow.checkText.slice(0, 80));


// Cutting mats: dark surface, light rulings, two pitches at once.
const mat = await page.evaluate(async () => {
  const { analyzeGrid, gridPitchMm } = await import('/js/gridRef.js');
  const ppm = 4, W = 560, H = 400;
  // Imperial mat: 1 in bold majors (101.6 px) with 1/2 in minors (50.8 px).
  const mkMat = (minorMm, majorMm, minorAlpha) => {
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#2f5d3a'; ctx.fillRect(0, 0, W, H);            // green mat
    const line = (x, y, w, h, a) => { ctx.fillStyle = `rgba(225,232,220,${a})`; ctx.fillRect(x, y, w, h); };
    if (minorMm) {
      for (let x = 0; x <= W; x += minorMm * ppm) line(x, 0, 1, H, minorAlpha);
      for (let y = 0; y <= H; y += minorMm * ppm) line(0, y, W, 1, minorAlpha);
    }
    for (let x = 0; x <= W; x += majorMm * ppm) line(x - 1, 0, 2, H, 1);
    for (let y = 0; y <= H; y += majorMm * ppm) line(0, y - 1, W, 2, 1);
    return c;
  };
  const counted1in = analyzeGrid(mkMat(12.7, 25.4, 0.9), ppm, gridPitchMm('mat_in1'));   // reads minors
  const countedHalf = analyzeGrid(mkMat(null, 25.4, 0), ppm, gridPitchMm('mat_inh'));    // majors only visible
  const metric = analyzeGrid(mkMat(10, 50, 0.9), ppm, gridPitchMm('mat_cm1'));
  // A real miscount on a mat must still be caught: 9 majors called 10.
  const miscount = analyzeGrid(mkMat(12.7 * 10 / 9, 25.4 * 10 / 9, 0.9), ppm, 25.4);
  return {
    c1: counted1in && { ok: counted1in.ok, mm: counted1in.detectedMm, msg: counted1in.message },
    ch: countedHalf && { ok: countedHalf.ok, mm: countedHalf.detectedMm, msg: countedHalf.message },
    metric: metric && { ok: metric.ok, mm: metric.detectedMm },
    mis: miscount && { ok: miscount.ok, ratio: miscount.ratio },
  };
});
check('cutting mat: counting 1 in squares while the photo reads the 1/2 in minors is accepted',
  mat.c1 && mat.c1.ok && near(mat.c1.mm, 12.7, 0.6) && /finer/.test(mat.c1.msg),
  mat.c1 ? `${mat.c1.mm.toFixed(2)} mm — ${mat.c1.msg.slice(0, 60)}` : 'not detected');
check('cutting mat: counting 1/2 in squares while only 1 in majors read back is accepted',
  mat.ch && mat.ch.ok && near(mat.ch.mm, 25.4, 1.2) && /bolder/.test(mat.ch.msg),
  mat.ch ? `${mat.ch.mm.toFixed(2)} mm` : 'not detected');
check('metric mat (1 cm under bold 5 cm) reads 1 cm on a dark surface',
  mat.metric && mat.metric.ok && near(mat.metric.mm, 10, 0.5),
  mat.metric ? `${mat.metric.mm.toFixed(2)} mm` : 'not detected');
check('a genuine miscount on a mat is still flagged (not excused as a ruling family)',
  mat.mis && !mat.mis.ok, mat.mis ? `ratio ${mat.mis.ratio.toFixed(3)}` : 'not detected');

// Full pipeline on a dark mat with a LIGHT object (the case a mat is good for).
const matFlow = await page.evaluate(async () => {
  const app = window.__app;
  const ppm = 5, pitch = 25.4, nx = 6, ny = 4;
  const W = Math.round(nx * pitch * ppm), H = Math.round(ny * pitch * ppm);
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#2f5d3a'; ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = 'rgba(225,232,220,0.9)';
  for (let x = 0; x <= W; x += pitch * ppm / 2) ctx.fillRect(x, 0, 1, H);
  for (let y = 0; y <= H; y += pitch * ppm / 2) ctx.fillRect(0, y, W, 1);
  ctx.fillStyle = '#f2ece0';                                      // 60 x 40 mm light object
  ctx.fillRect((W - 60 * ppm) / 2, (H - 40 * ppm) / 2, 60 * ppm, 40 * ppm);
  app.state.reference = 'grid';
  document.getElementById('refType').value = 'grid';
  document.getElementById('refType').dispatchEvent(new Event('change'));
  Object.assign(app.state.grid, { pitch: 'mat_in1', nx, ny });
  app.state.captureFrac = 0;
  await new Promise(res => app.loadImageFromURL(c.toDataURL('image/png'), res));
  app.state.corners = [{ x: 0, y: 0 }, { x: W, y: 0 }, { x: W, y: H }, { x: 0, y: H }];
  app.cornerEditor.setCorners(app.state.corners);
  app.state.rectDirty = true;
  app.goStep(2);
  await new Promise(r => setTimeout(r, 700));
  const t = app.traceEditor.getTrace();
  let minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9;
  for (const p of t.outer || []) {
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
  }
  return {
    traced: t.outer && t.outer.length >= 3 ? { w: maxX - minX, h: maxY - minY } : null,
    checkText: document.getElementById('gridCheck').textContent,
  };
});
check('light object on a dark cutting mat traces at true scale (60 x 40 mm)',
  matFlow.traced && near(matFlow.traced.w, 60, 1.5) && near(matFlow.traced.h, 40, 1.5),
  matFlow.traced ? `${matFlow.traced.w.toFixed(1)} x ${matFlow.traced.h.toFixed(1)} mm` : 'no trace');
check('mat pitch check accepts the 1/2 in minors under counted 1 in squares end to end',
  /checks out/.test(matFlow.checkText), matFlow.checkText.slice(0, 90));


// ---------- grid auto-count + scale-bar reference ----------

const autoGrid = await page.evaluate(async () => {
  const { autoCount } = await import('/js/gridRef.js');
  // A "provisional rectification": 20 x 14 real squares of 40 px, but the
  // caller believed 10 x 10 — the count must come out 20 x 14 regardless.
  const mk = (W, H, pitchPx, opts = {}) => {
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const ctx = c.getContext('2d');
    ctx.fillStyle = opts.dark ? '#2f5d3a' : '#fbfbf7'; ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = opts.dark ? '#b9d8c0' : '#9fb6d9';
    for (let x = 0; x <= W; x += pitchPx) ctx.fillRect(x, 0, 1, H);
    for (let y = 0; y <= H; y += pitchPx) ctx.fillRect(0, y, W, 1);
    if (opts.boldEvery) { // bolder majors every k minors (cutting-mat style)
      for (let x = 0; x <= W; x += pitchPx * opts.boldEvery) ctx.fillRect(x - 1, 0, 3, H);
      for (let y = 0; y <= H; y += pitchPx * opts.boldEvery) ctx.fillRect(0, y - 1, W, 3);
    }
    return c;
  };
  const plain = autoCount(mk(800, 560, 40), 8, 5, 10, 10);
  // Cutting mat: 1/2 in minors (20 px) under bold 1 in majors (40 px); the
  // user named the 1 in pitch, handles span 20 x 14 majors.
  const mat = autoCount(mk(800, 560, 20, { dark: true, boldEvery: 2 }), 40 / 25.4, 25.4, 10, 10);
  // Handles NOT on intersections: 20.75 squares across -> not whole.
  const off = autoCount(mk(830, 560, 40), 8, 5, 10, 10);
  return {
    plain: plain && { nx: plain.nx, ny: plain.ny, ok: plain.ok, k: plain.k },
    mat: mat && { nx: mat.nx, ny: mat.ny, ok: mat.ok, k: mat.k },
    off: off && { rawX: off.rawX, ok: off.ok },
  };
});
console.log('\nGrid auto-count + scale bar');
check('auto-count reads 20 x 14 squares off the image regardless of the provisional guess',
  autoGrid.plain && autoGrid.plain.nx === 20 && autoGrid.plain.ny === 14 && autoGrid.plain.ok,
  autoGrid.plain ? `${autoGrid.plain.nx} x ${autoGrid.plain.ny}` : 'null');
// Either route is correct: bold majors read as the fundamental (k=1), or
// minors as fundamental with the majors recognised as a k=2 bold ruling.
check('cutting mat: bold 1 in majors over 1/2 in minors count in the named (major) pitch',
  autoGrid.mat && [1, 2].includes(autoGrid.mat.k) && autoGrid.mat.nx === 20 && autoGrid.mat.ny === 14 && autoGrid.mat.ok,
  autoGrid.mat ? `${autoGrid.mat.nx} x ${autoGrid.mat.ny}, k=${autoGrid.mat.k}` : 'null');
check('handles off the intersections give a non-integer count and are flagged',
  autoGrid.off && !autoGrid.off.ok && near(autoGrid.off.rawX, 20.75, 0.2),
  autoGrid.off ? `raw ${autoGrid.off.rawX.toFixed(2)}` : 'null');

// Full flow: counts left at the 10 x 10 default; continuing must auto-count
// to 20 x 14 and trace the 60 x 40 mm object at true scale.
const autoFlow = await page.evaluate(async () => {
  const app = window.__app;
  const ppm = 6, pitch = 5, nx = 20, ny = 14;
  const W = nx * pitch * ppm, H = ny * pitch * ppm;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fcfcf8'; ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = '#a8bcdb';
  for (let x = 0; x <= W; x += pitch * ppm) ctx.fillRect(x, 0, 1, H);
  for (let y = 0; y <= H; y += pitch * ppm) ctx.fillRect(0, y, W, 1);
  ctx.fillStyle = '#2b2b2b';
  ctx.fillRect((W - 60 * ppm) / 2, (H - 40 * ppm) / 2, 60 * ppm, 40 * ppm);
  app.state.reference = 'grid';
  document.getElementById('refType').value = 'grid';
  document.getElementById('refType').dispatchEvent(new Event('change'));
  Object.assign(app.state.grid, { pitch: 'mm5', nx: 10, ny: 10, autoSig: null });
  app.state.captureFrac = 0;
  await new Promise(res => app.loadImageFromURL(c.toDataURL('image/png'), res));
  app.state.corners = [{ x: 0, y: 0 }, { x: W, y: 0 }, { x: W, y: H }, { x: 0, y: H }];
  app.cornerEditor.setCorners(app.state.corners);
  app.state.rectDirty = true;
  app.goStep(2);
  await new Promise(r => setTimeout(r, 700));
  const autoMsg = document.getElementById('gridAutoMsg').textContent; // before the override rewrites it
  const t = app.traceEditor.getTrace();
  let minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9;
  for (const p of t.outer || []) {
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
  }
  // Manual override must survive the next rectification.
  app.goStep(1);
  document.getElementById('gridNX').value = '19';
  document.getElementById('gridNX').dispatchEvent(new Event('change'));
  app.state.rectDirty = true;
  app.goStep(2);
  await new Promise(r => setTimeout(r, 500));
  return {
    nx: app.state.grid.nx, ny: app.state.grid.ny,
    msg: autoMsg,
    traced: t.outer ? { w: maxX - minX, h: maxY - minY } : null,
    afterOverride: app.state.grid.nx,
  };
});
check('continuing auto-counts 20 x 14 and traces the object at true scale (60 x 40 mm)',
  autoFlow.traced && near(autoFlow.traced.w, 60, 1.5) && near(autoFlow.traced.h, 40, 1.5) &&
  /Counted 20 × 14/.test(autoFlow.msg),
  autoFlow.traced ? `${autoFlow.traced.w.toFixed(1)} x ${autoFlow.traced.h.toFixed(1)} mm; ${autoFlow.msg.slice(0, 40)}` : 'no trace');
check('a typed count is honoured as the override for that placement',
  autoFlow.afterOverride === 19, `nx ${autoFlow.afterOverride}`);

// Scale bar: two points 75 mm apart placed 300 px apart -> 4 px/mm.
const barFlow = await page.evaluate(async () => {
  const app = window.__app;
  const W = 640, H = 480;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d');
  const g = ctx.createLinearGradient(0, 0, W, H); // flat bg degenerates Otsu
  g.addColorStop(0, '#efece3'); g.addColorStop(1, '#f6f3ea');
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = '#222';
  ctx.fillRect(200, 140, 240, 160); // 60 x 40 mm at 4 px/mm
  app.state.reference = 'bar';
  document.getElementById('refType').value = 'bar';
  document.getElementById('refType').dispatchEvent(new Event('change'));
  await new Promise(res => app.loadImageFromURL(c.toDataURL('image/png'), res));
  app.cornerEditor.setBar({ ax: 100, ay: 420, bx: 400, by: 420 });
  document.getElementById('barLength').value = '75';
  document.getElementById('barLength').dispatchEvent(new Event('change'));
  app.state.rectDirty = true;
  app.goStep(2);
  await new Promise(r => setTimeout(r, 600));
  const t = app.traceEditor.getTrace();
  let minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9;
  for (const p of t.outer || []) {
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
  }
  return {
    controls: !document.getElementById('barRefControls').hidden,
    pxPerMm: app.state.rect ? app.state.rect.pxPerMm : 0,
    traced: t.outer ? { w: maxX - minX, h: maxY - minY } : null,
    label: app.cornerEditor.barLabel,
  };
});
check('scale bar sets scale from two points (300 px = 75 mm -> 4 px/mm) and traces true size',
  barFlow.controls && near(barFlow.pxPerMm, 4, 0.05) && barFlow.traced &&
  near(barFlow.traced.w, 60, 1.5) && near(barFlow.traced.h, 40, 1.5),
  `${barFlow.pxPerMm.toFixed(2)} px/mm, ${barFlow.traced ? barFlow.traced.w.toFixed(1) + ' x ' + barFlow.traced.h.toFixed(1) : 'no trace'}`);
check('the bar is captioned with its length in the picture', /75/.test(barFlow.label), barFlow.label);


// ---------- Step 4: Organize (shell) ----------

console.log('\nStep 4: Organize');

// A cold load: no photo, no trace, and Step 4 must still open. Uses its own
// page so "fresh" means fresh; console errors there count like any other.
const cold = await (async () => {
  const fresh = await browser.newPage({ viewport: { width: 1500, height: 950 } });
  fresh.on('console', m => { if (m.type() === 'error') consoleErrors.push('[step4 cold load] ' + m.text()); });
  fresh.on('pageerror', e => consoleErrors.push('[step4 cold load] ' + String(e)));
  await fresh.goto(`http://127.0.0.1:${port}/`);
  await fresh.waitForFunction(() => window.__app && window.ClipperLib);
  const out = await fresh.evaluate(async () => {
    const app = window.__app;
    const before = document.getElementById('stepBtn4').disabled;
    app.goStep(4);
    await new Promise(r => setTimeout(r, 250));
    const LAY_IDS = [
      'layoutCanvas', 'layoutInfo', 'layoutWarn', 'layContainerSel', 'layRectFields', 'layW', 'layH',
      'layToolSel', 'layAddBtn', 'laySelPanel', 'laySelName', 'laySelLabel', 'laySelLabelReset',
      'laySelDepth', 'laySelRot', 'laySelNotch', 'laySelNotchDia', 'layRemoveBtn', 'layClearance',
      'layFloor', 'layBorder', 'layBed', 'layBedCustom', 'layBedW', 'layBedH', 'layTabs',
      'layTabFields', 'layTabHead', 'layTabNeck', 'layTabDepth', 'layTabSpacing', 'layTabFit',
      'layBedInfo', 'layLabels', 'layLabelFields', 'layLabelProcess', 'layLabelHeight',
      'layLabelBitRow', 'layLabelBit', 'layLabelMargin', 'layLabelDepth', 'layLabelFollow',
      'layLabelInfo', 'layPreviewBtn', 'layExportBtn', 'layExportSvgBtn', 'layoutModal',
    ];
    return {
      wasDisabled: before,
      hasImage: !!app.state.image,
      hasRect: !!app.state.rect,
      step: app.state.step,
      panelShown: !document.getElementById('panel4').hidden,
      stageShown: !document.getElementById('stage4').hidden,
      preview3d: !document.getElementById('stage3').hidden,
      tabActive: document.getElementById('stepBtn4').classList.contains('active'),
      others: [1, 2, 3].filter(i => !document.getElementById('panel' + i).hidden),
      controlsShown: !document.getElementById('layoutModal').hidden,
      inPanel4: !!document.querySelector('#panel4 #layoutModal #layAddBtn'),
      inStage4: !!document.querySelector('#stage4 #layoutCanvas'),
      missing: LAY_IDS.filter(id => !document.getElementById(id)),
      overlays: document.querySelectorAll('.modal-overlay').length,
      overlayGone: !document.querySelector('#layoutModal.modal-overlay') && !document.getElementById('layoutCloseBtn'),
      hint: document.getElementById('layEmptyHint').textContent.trim(),
      hintShown: !document.getElementById('layEmptyHint').hidden,
      holderOptions: [...document.getElementById('holderType').options].map(o => o.value),
      addedFromLibrary: (() => {
        // The palette still adds: place a synthetic tool with no trace behind it.
        app.state.layout.items.push({
          name: 'cold tool', outer: [{ x: 5, y: 5 }, { x: 55, y: 5 }, { x: 55, y: 35 }, { x: 5, y: 35 }],
          holes: [], circles: [], thickness: 5, depth: null, rot: 0, x: 30, y: 30,
        });
        app.refreshLayoutEditor();
        return { n: app.state.layout.items.length, info: document.getElementById('layoutInfo').textContent };
      })(),
    };
  });
  await fresh.close();
  return out;
})();
check('Step 4 is enabled unconditionally and opens with no photo and no trace',
  cold.wasDisabled === false && !cold.hasImage && !cold.hasRect && cold.step === 4 &&
  cold.panelShown && cold.stageShown && cold.tabActive && cold.others.length === 0,
  `disabled ${cold.wasDisabled}, step ${cold.step}, panel ${cold.panelShown}, stage ${cold.stageShown}`);
check('the layout editor and the 3D preview share the stage on Step 4',
  cold.stageShown && cold.preview3d && cold.controlsShown && cold.inStage4,
  `layout ${cold.stageShown}, 3D ${cold.preview3d}`);
check('every layout control id survives the move out of the modal',
  cold.missing.length === 0 && cold.inPanel4 && cold.inStage4,
  cold.missing.length ? `missing ${cold.missing.join(', ')}` : 'all layout ids resolve');
check('the layout modal overlay and its close button are gone',
  cold.overlayGone && cold.overlays === 2,
  `${cold.overlays} overlays left (project + CAD), close button ${cold.overlayGone}`);
check('an empty Step 4 prompts for the library or a folder of traces',
  cold.hintShown && /Add tools from your library, or open a folder of traces\./.test(cold.hint),
  cold.hint);
check('the Step 3 holder select still offers the layout option for old projects',
  cold.holderOptions.includes('layout'), cold.holderOptions.join('/'));
check('a drawer can be laid out on Step 4 with nothing traced',
  cold.addedFromLibrary.n === 1 && /1 tool/.test(cold.addedFromLibrary.info),
  cold.addedFromLibrary.info);

// Step 3's "Drawer insert" holder type is now a shortcut to Step 4.
await page.evaluate(() => window.__app.goStep(3));
const jump = await page.evaluate(async () => {
  const sel = document.getElementById('holderType');
  sel.value = 'layout';
  sel.dispatchEvent(new Event('change'));
  await new Promise(r => setTimeout(r, 250));
  return {
    step: window.__app.state.step,
    type: window.__app.state.holder.type,
    panel3Hidden: document.getElementById('panel3').hidden,
    panel4Shown: !document.getElementById('panel4').hidden,
    controlsShown: !document.getElementById('layoutModal').hidden,
  };
});
check('the drawer-insert holder type on Step 3 jumps to Step 4 instead of opening a modal',
  jump.step === 4 && jump.type === 'layout' && jump.panel3Hidden && jump.panel4Shown && jump.controlsShown,
  `step ${jump.step}, holder ${jump.type}`);

// The Step 4 export row: the same shared functions, whichever row calls them.
await page.evaluate(async () => {
  const app = window.__app;
  app.state.layout.container = { ...app.state.layout.container, type: 'rect', w: 220, h: 140, name: null };
  app.state.layout.items.length = 0;
  const outline = [{ x: 5, y: 5 }, { x: 65, y: 5 }, { x: 65, y: 35 }, { x: 5, y: 35 }];
  app.state.layout.items.push(
    { name: 'spanner', outer: outline, holes: [], circles: [], x: 60, y: 40, rot: 0, depth: 4, thickness: 5 },
    { name: 'pliers', outer: outline, holes: [], circles: [], x: 60, y: 100, rot: 0, depth: 4, thickness: 5 });
  app.goStep(4);
  await new Promise(r => setTimeout(r, 300));
});
{
  const [dl] = await Promise.all([
    page.waitForEvent('download', { timeout: 10000 }).catch(() => null),
    page.click('#layExportBtn'),
  ]);
  check('Step 4 exports the insert STL from its own row',
    !!dl && /-drawer-2p5d\.stl$/.test(dl.suggestedFilename()),
    dl ? dl.suggestedFilename() : 'no download event');
}
const tilesGate = await page.evaluate(() => ({
  noBed: document.getElementById('layExportTilesBtn').disabled,
}));
let step4Svg = '';
{
  const [dl] = await Promise.all([
    page.waitForEvent('download', { timeout: 10000 }).catch(() => null),
    page.click('#layExportSvgBtn'),
  ]);
  const fp = dl ? await dl.path().catch(() => null) : null;
  step4Svg = fp ? fs.readFileSync(fp, 'utf8') : '';
  // One cut path, evenodd: the container slab plus a subpath per pocket.
  const subpaths = (step4Svg.match(/M /g) || []).length;
  check('Step 4 exports the cut template SVG from its own row',
    !!dl && /-drawer-template\.svg$/.test(dl.suggestedFilename()) &&
    /width="220mm" height="140mm"/.test(step4Svg) && subpaths === 3,
    dl ? `${dl.suggestedFilename()}, ${subpaths} subpaths` : 'no download event');
}
// The same state, exported through the shared function from Step 3, has to
// come out byte for byte the same — one code path, two rows.
const step3Svg = await page.evaluate(async () => {
  window.__app.goStep(3);
  await new Promise(r => setTimeout(r, 200));
  const out = window.__app.layoutExports.svg('auto');
  return out ? await out.blob.text() : '';
});
check('an SVG exported from Step 4 is byte-identical to the one Step 3 produces',
  step4Svg.length > 0 && step4Svg === step3Svg,
  step4Svg === step3Svg ? `${step4Svg.length} bytes both ways`
    : `${step4Svg.length} vs ${step3Svg.length} bytes`);

// Tiled SVG: off with no bed, on once the layout outgrows one.
const tilesUI = await page.evaluate(async () => {
  const app = window.__app;
  app.goStep(4);
  app.state.layout.container = { ...app.state.layout.container, type: 'rect', w: 550, h: 380, name: null };
  const bed = document.getElementById('layBed');
  bed.value = '300x200';
  bed.dispatchEvent(new Event('change'));
  await new Promise(r => setTimeout(r, 250));
  return { enabled: !document.getElementById('layExportTilesBtn').disabled };
});
{
  const [dl] = await Promise.all([
    page.waitForEvent('download', { timeout: 10000 }).catch(() => null),
    page.click('#layExportTilesBtn'),
  ]);
  check('the tiled SVG button is dead without a bed and live once the layout outgrows one',
    tilesGate.noBed && tilesUI.enabled && !!dl && /-drawer-tiles-2x2\.svg$/.test(dl.suggestedFilename()),
    `no bed disabled ${tilesGate.noBed}, over bed enabled ${tilesUI.enabled}, ${dl ? dl.suggestedFilename() : 'no download'}`);
}

// Leave the page as the blocks after this one expect it: no holder, no items,
// no bed, back on Step 3.
await page.evaluate(async () => {
  window.__app.state.layout.items.length = 0;
  const bed = document.getElementById('layBed');
  bed.value = 'none';
  bed.dispatchEvent(new Event('change'));
  const sel = document.getElementById('holderType');
  sel.value = 'none';
  sel.dispatchEvent(new Event('change'));
  window.__app.goStep(3);
  await new Promise(r => setTimeout(r, 300));
});

// --- the folder reader: js/import/traceFolder.js ---

const folder = await page.evaluate(async () => {
  const { tracesFromFiles } = await import('/js/import/traceFolder.js');
  const rect = (x, y, w, h) => [
    { x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h },
  ];
  const mk = (path, body) => ({
    path,
    file: new File([typeof body === 'string' ? body : JSON.stringify(body)],
      path.split('/').pop(), { type: 'application/json' }),
  });
  const project = {
    app: '2.5D', version: 1, fileName: 'chisel',
    regions: [{ thickness: 7.5 }],
    trace: {
      outer: rect(120, 240, 60, 30),
      holes: [rect(130, 250, 10, 10)],
      circles: [{ cx: 170, cy: 260, r: 4 }],
    },
    arcs: [{ i: 2, r: 6 }, { i: 3, r: 2.5 }],
    lines: [{ a: 0, b: 1 }],
  };
  const library = [
    { name: 'plane', kind: 'tool', thickness: 12, outer: rect(0, 0, 40, 20), holes: [], circles: [] },
    { name: 'drawer', kind: 'container', outer: rect(0, 0, 400, 300), holes: [], circles: [] },
    { name: 'square', outer: rect(50, 50, 30, 30) },
  ];
  const files = [
    mk('tools/chisel.json', project),
    mk('tools/library.json', library),
    mk('tools/notes.txt', 'plainly not json'),
    mk('tools/broken.json', '{ "app": "2.5D", '),
    mk('tools/settings.json', { app: 'something-else', hello: 1 }),
  ];
  const progress = [];
  const out = await tracesFromFiles(files, { onProgress: (d, t) => progress.push(d + '/' + t) });
  // A bare File must work too; its path falls back to the file's own name.
  const bare = await tracesFromFiles([new File([JSON.stringify(project)], 'copy.json')]);
  const box = pts => {
    let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
    for (const p of pts) { a = Math.min(a, p.x); b = Math.min(b, p.y); c = Math.max(c, p.x); d = Math.max(d, p.y); }
    return { x: a, y: b, w: c - a, h: d - b };
  };
  return {
    names: out.entries.map(e => e.name),
    kinds: out.entries.map(e => e.kind),
    paths: out.entries.map(e => e.source.path),
    thicknesses: out.entries.map(e => e.thickness),
    chisel: {
      box: box(out.entries[0].outer),
      hole: out.entries[0].holes[0] ? box(out.entries[0].holes[0]) : null,
      circle: out.entries[0].circles[0] || null,
      arcs: out.entries[0].arcs,
      lines: out.entries[0].lines,
    },
    squareBox: box(out.entries[2].outer),
    skipped: out.skipped,
    progress,
    barePath: bare.entries.length === 1 ? bare.entries[0].source.path : null,
  };
});

check('a folder of traces reads into one tool entry per trace, in file order',
  folder.names.join(',') === 'chisel,plane,square' &&
  folder.kinds.every(k => k === 'tool') &&
  folder.paths.join(',') === 'tools/chisel.json,tools/library.json,tools/library.json',
  `${folder.names.join(',')} / ${folder.paths.join(',')}`);

check('thickness comes from regions[0] of a project and thickness of a library row, else null',
  folder.thicknesses.length === 3 && folder.thicknesses[0] === 7.5 &&
  folder.thicknesses[1] === 12 && folder.thicknesses[2] === null,
  JSON.stringify(folder.thicknesses));

check('outlines are origin-normalised to a 5 mm margin, with holes and circles moved with them',
  folder.chisel.box.x === 5 && folder.chisel.box.y === 5 &&
  folder.chisel.box.w === 60 && folder.chisel.box.h === 30 &&
  folder.chisel.hole && folder.chisel.hole.x === 15 && folder.chisel.hole.y === 15 &&
  folder.chisel.circle && folder.chisel.circle.cx === 55 && folder.chisel.circle.cy === 25 &&
  folder.chisel.circle.r === 4 &&
  folder.squareBox.x === 5 && folder.squareBox.y === 5,
  JSON.stringify(folder.chisel.box) + ' hole ' + JSON.stringify(folder.chisel.hole) +
  ' circle ' + JSON.stringify(folder.chisel.circle));

check('arcs and lines are carried across with their indices intact',
  JSON.stringify(folder.chisel.arcs) === JSON.stringify([{ i: 2, r: 6 }, { i: 3, r: 2.5 }]) &&
  JSON.stringify(folder.chisel.lines) === JSON.stringify([{ a: 0, b: 1 }]),
  JSON.stringify(folder.chisel.arcs) + ' ' + JSON.stringify(folder.chisel.lines));

check('a container-kind library row is reported as skipped, not offered as a tool',
  folder.skipped.some(s => s.reason === 'container' && s.name === 'drawer' && s.path === 'tools/library.json') &&
  !folder.names.includes('drawer'),
  JSON.stringify(folder.skipped));

check('a .txt, a malformed .json and a JSON with no trace each get their own reason',
  folder.skipped.length === 4 &&
  folder.skipped.find(s => s.path === 'tools/notes.txt').reason === 'not-json' &&
  folder.skipped.find(s => s.path === 'tools/broken.json').reason === 'parse-error' &&
  folder.skipped.find(s => s.path === 'tools/settings.json').reason === 'not-a-trace',
  JSON.stringify(folder.skipped));

check('files are read one at a time, so a progress count can climb',
  folder.progress.join(' ') === '1/5 2/5 3/5 4/5 5/5',
  folder.progress.join(' '));

check('a bare File is accepted as well as a { path, file } pair',
  folder.barePath === 'copy.json', String(folder.barePath));

// --- the Step 4 palette: Library and Folder groups ---

const libBackup = await page.evaluate(() => localStorage.getItem('2p5d.library.v1'));

const palette = await page.evaluate(async () => {
  const app = window.__app;
  const { tracesFromFiles } = await import('/js/import/traceFolder.js');
  const rect = (x, y, w, h) => [
    { x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h },
  ];
  const mk = (path, body) => ({
    path,
    file: new File([typeof body === 'string' ? body : JSON.stringify(body)],
      path.split('/').pop(), { type: 'application/json' }),
  });
  const proj = (name, w, h, thickness) => ({
    app: '2.5D', version: 1, fileName: name,
    regions: [{ thickness }],
    trace: { outer: rect(30, 40, w, h), holes: [], circles: [] },
  });
  // One library seeded by hand, so the Library group has something to list.
  localStorage.setItem('2p5d.library.v1', JSON.stringify([
    { name: 'seeded mallet', kind: 'tool', thickness: 9, outer: rect(5, 5, 50, 25), holes: [], circles: [] },
    { name: 'seeded drawer', kind: 'container', outer: rect(5, 5, 400, 300), holes: [], circles: [] },
  ]));
  const read = await tracesFromFiles([
    mk('bench/chisel.json', proj('chisel', 60, 20, 7)),
    mk('bench/mallet.json', proj('mallet', 40, 40, 11)),
    mk('bench/sub/rasp.json', proj('rasp', 80, 15, 6)),
    mk('bench/readme.txt', 'ignore me'),
  ]);
  app.goStep(4);
  await new Promise(r => setTimeout(r, 200));
  app.palette.setFolder(read, 'bench');
  const rowsOf = id => Array.from(document.querySelectorAll(`#${id} .pal-name`))
    .map(r => r.textContent);
  return {
    readCount: read.entries.length,
    folderShown: !document.getElementById('layPalFolderGroup').hidden,
    folderRows: rowsOf('layPalFolderList'),
    folderHints: Array.from(document.querySelectorAll('#layPalFolderList .pal-row')).map(r => r.title),
    libRows: rowsOf('layPalLibList'),
    libCount: document.getElementById('layPalLibCount').textContent,
    skipText: document.getElementById('layPalSkipped').textContent,
    skipTitle: document.getElementById('layPalSkipped').title,
    skipShown: !document.getElementById('layPalSkipped').hidden,
  };
});

check('the palette lists the library and the folder side by side, containers left out',
  palette.readCount === 3 && palette.folderShown &&
  palette.folderRows.join(',') === 'chisel,mallet,rasp' &&
  palette.libRows.join(',') === 'seeded mallet' && palette.libCount === '1',
  `folder ${palette.folderRows.join(',')} / library ${palette.libRows.join(',')}`);

check('a folder row carries its relative path, so two traces of one name stay apart',
  palette.folderHints.join(',') === 'bench/chisel.json,bench/mallet.json,bench/sub/rasp.json',
  palette.folderHints.join(','));

check('the skipped count is shown, with the reasons in its tooltip',
  palette.skipShown && palette.skipText === '1 file skipped' &&
  palette.skipTitle === 'bench/readme.txt: not a .json file',
  `${palette.skipText} / ${palette.skipTitle}`);

const addAll = await page.evaluate(async () => {
  const app = window.__app;
  document.getElementById('layPalAddAllBtn').click();
  await new Promise(r => setTimeout(r, 250));
  const items = app.state.layout.items;
  return {
    n: items.length,
    names: items.map(i => i.name),
    sources: items.map(i => i.source && i.source.kind),
    paths: items.map(i => i.source && i.source.path),
    thicknesses: items.map(i => i.thickness),
    dx: items.map(i => i.x - items[0].x),
    sameY: items.every(i => i.y === items[0].y),
    hasOuter: items.every(i => Array.isArray(i.outer) && i.outer.length === 4),
  };
});

check('Add all places every folder trace, in order, on the same seeded grid',
  addAll.n === 3 && addAll.names.join(',') === 'chisel,mallet,rasp' &&
  addAll.dx.join(',') === '0,12,24' && addAll.sameY && addAll.hasOuter,
  `${addAll.n} items, dx ${addAll.dx.join(',')}, same row ${addAll.sameY}`);

check('a placed folder tool keeps its own thickness and records where it came from',
  addAll.sources.every(k => k === 'folder') &&
  addAll.paths.join(',') === 'bench/chisel.json,bench/mallet.json,bench/sub/rasp.json' &&
  addAll.thicknesses.join(',') === '7,11,6',
  `${addAll.sources.join(',')} / ${addAll.thicknesses.join(',')}`);

const libAdd = await page.evaluate(async () => {
  const app = window.__app;
  const before = app.state.layout.items.length;
  document.querySelector('#layPalLibList .pal-row button').click();
  await new Promise(r => setTimeout(r, 200));
  const last = app.state.layout.items[app.state.layout.items.length - 1];
  // "Save to library" is the second button on a folder row.
  document.querySelectorAll('#layPalFolderList .pal-row')[2].querySelectorAll('button')[1].click();
  await new Promise(r => setTimeout(r, 200));
  const lib = JSON.parse(localStorage.getItem('2p5d.library.v1'));
  const saved = lib.find(o => o.name === 'rasp');
  return {
    grew: app.state.layout.items.length === before + 1,
    name: last.name, noSource: !('source' in last),
    savedKind: saved && saved.kind,
    savedStripped: saved ? !('source' in saved) : false,
    savedThickness: saved && saved.thickness,
    savedOrigin: saved && saved.outer[0],
    libNames: lib.map(o => o.name).join(','),
  };
});

check('the Library group places a saved outline, with no folder provenance on it',
  libAdd.grew && libAdd.name === 'seeded mallet' && libAdd.noSource,
  `${libAdd.name} added ${libAdd.grew}, source-free ${libAdd.noSource}`);

check('Save to library writes a folder trace into the library with its provenance stripped',
  libAdd.savedKind === 'tool' && libAdd.savedStripped && libAdd.savedThickness === 6 &&
  libAdd.savedOrigin && libAdd.savedOrigin.x === 5 && libAdd.savedOrigin.y === 5 &&
  libAdd.libNames === 'seeded mallet,seeded drawer,rasp',
  `${libAdd.libNames} / stripped ${libAdd.savedStripped} / ${JSON.stringify(libAdd.savedOrigin)}`);

// Round-trip through the save format, on a page of its own so the load
// cannot leave residue in the suite's main page.
const roundTrip = await (async () => {
  const saved = await page.evaluate(() => {
    const p = JSON.parse(window.__app.serializeProject(false));
    // The rectified copy stays, so this is a normal photo-less save; only the
    // extra images go, to keep the payload small.
    p.photo = null; p.back = null;
    return JSON.stringify(p);
  });
  const fresh = await browser.newPage({ viewport: { width: 1500, height: 950 } });
  fresh.on('console', m => { if (m.type() === 'error') consoleErrors.push('[step4 round trip] ' + m.text()); });
  fresh.on('pageerror', e => consoleErrors.push('[step4 round trip] ' + String(e)));
  await fresh.goto(`http://127.0.0.1:${port}/`);
  await fresh.waitForFunction(() => window.__app && window.ClipperLib);
  const out = await fresh.evaluate(async json => {
    window.__app.loadProject(JSON.parse(json));
    await new Promise(r => setTimeout(r, 500));
    const items = window.__app.state.layout.items;
    return {
      n: items.length,
      names: items.map(i => i.name).join(','),
      paths: items.map(i => (i.source || {}).path).join(','),
      pts: items.map(i => i.outer.length).join(','),
    };
  }, saved);
  await fresh.close();
  return out;
})();

check('a saved project reopens its folder-sourced drawer, provenance and all',
  roundTrip.n === 4 && roundTrip.names === 'chisel,mallet,rasp,seeded mallet' &&
  roundTrip.paths === 'bench/chisel.json,bench/mallet.json,bench/sub/rasp.json,' &&
  roundTrip.pts === '4,4,4,4',
  `${roundTrip.n}: ${roundTrip.names} / ${roundTrip.paths}`);

// Put the page back the way the blocks after this one found it: no folder, no
// items, the library as it was, back on Step 3.
await page.evaluate(async backup => {
  window.__app.palette.setFolder({ entries: [], skipped: [] }, '');
  window.__app.state.layout.items.length = 0;
  window.__app.layoutEditor.sel = -1;
  window.__app.syncLaySelPanel(-1);
  if (backup === null) localStorage.removeItem('2p5d.library.v1');
  else localStorage.setItem('2p5d.library.v1', backup);
  // A trip back through Step 4 repopulates every list from the restored
  // library, so no seeded entry is left in a select.
  window.__app.goStep(4);
  await new Promise(r => setTimeout(r, 200));
  window.__app.refreshLayoutEditor();
  window.__app.goStep(3);
  await new Promise(r => setTimeout(r, 300));
}, libBackup);

check('closing the folder empties its group again, leaving the library alone',
  await page.evaluate(() => document.getElementById('layPalFolderGroup').hidden &&
    window.__app.state.layout.items.length === 0),
  'folder group hidden and the layout cleared');

// --- the File System Access folder backend: js/import/folderAccess.js ---

// One synthetic folder, "bench", built twice: as a handle tree for the File
// System Access walk, and as the flat FileList a directory input hands over
// for the same folder. Both must read into the very same palette.
const walkVsInput = await page.evaluate(async () => {
  const { walkFolder } = await import('/js/import/folderAccess.js');
  const { tracesFromFiles } = await import('/js/import/traceFolder.js');
  const rect = (x, y, w, h) => [
    { x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h },
  ];
  const proj = (name, w, h, thickness) => JSON.stringify({
    app: '2.5D', version: 1, fileName: name,
    regions: [{ thickness }],
    trace: { outer: rect(20, 30, w, h), holes: [], circles: [] },
  });
  const bodies = {
    'bench/anvil.json': proj('anvil', 70, 25, 8),
    'bench/notes.txt': 'not a trace',
    'bench/sub/rasp.json': proj('rasp', 30, 30, 4),
  };
  // The handle tree. Deliberately out of alphabetical order, so the walk's
  // own sort is what makes the two lists line up.
  const fileHandle = (name, body) => ({
    kind: 'file', name,
    getFile: async () => new File([body], name, { type: 'application/json' }),
  });
  const dirHandle = (name, children) => {
    const h = {
      kind: 'directory', name, children,
      values: async function* () { for (const c of h.children) yield c; },
      queryPermission: async () => 'granted',
      requestPermission: async () => 'granted',
      written: [],
      getFileHandle: async (n) => ({
        createWritable: async () => ({
          write: async text => { h.written.push({ name: n, text }); },
          close: async () => {},
        }),
      }),
    };
    return h;
  };
  const root = dirHandle('bench', [
    dirHandle('sub', [fileHandle('rasp.json', bodies['bench/sub/rasp.json'])]),
    fileHandle('notes.txt', bodies['bench/notes.txt']),
    fileHandle('anvil.json', bodies['bench/anvil.json']),
  ]);
  window.__fakeFolder = root;

  // The same folder through a directory input: flat, every file already read.
  const flat = Object.keys(bodies).map(path => {
    const f = new File([bodies[path]], path.split('/').pop(), { type: 'application/json' });
    Object.defineProperty(f, 'webkitRelativePath', { value: path });
    return f;
  });

  const pairs = await walkFolder(root);
  const fromWalk = await tracesFromFiles(pairs);
  const fromInput = await tracesFromFiles(flat);
  const shape = r => JSON.stringify({
    entries: r.entries.map(e => ({ name: e.name, path: e.source.path, t: e.thickness, outer: e.outer })),
    skipped: r.skipped,
  });
  return {
    walkPaths: pairs.map(p => p.path),
    inputPaths: flat.map(f => f.webkitRelativePath),
    same: shape(fromWalk) === shape(fromInput),
    names: fromWalk.entries.map(e => e.name),
    skipped: fromWalk.skipped.map(s => s.path + ':' + s.reason),
  };
});

check('the handle walk recurses into subfolders and yields the directory input’s own list',
  walkVsInput.walkPaths.join(',') === 'bench/anvil.json,bench/notes.txt,bench/sub/rasp.json' &&
  walkVsInput.walkPaths.join(',') === walkVsInput.inputPaths.join(',') && walkVsInput.same &&
  walkVsInput.names.join(',') === 'anvil,rasp' &&
  walkVsInput.skipped.join(',') === 'bench/notes.txt:not-json',
  `${walkVsInput.walkPaths.join(',')} / identical ${walkVsInput.same}`);

// With the API gone, one button still has to open a folder: the input.
const noApi = await page.evaluate(async () => {
  const app = window.__app;
  app.goStep(4);
  await new Promise(r => setTimeout(r, 200));
  const inp = document.getElementById('layFolderInput');
  let opened = 0;
  const realClick = inp.click;
  inp.click = () => { opened++; };
  // showDirectoryPicker lives on Window.prototype, so shadow it rather than
  // deleting it, and drop the shadow afterwards.
  Object.defineProperty(window, 'showDirectoryPicker', { value: undefined, configurable: true });
  document.getElementById('layOpenFolderBtn').click();
  await new Promise(r => setTimeout(r, 150));
  inp.click = realClick;
  delete window.showDirectoryPicker;
  return { opened, isDir: inp.hasAttribute('webkitdirectory'), multiple: inp.multiple };
});

check('without the File System Access API the same button falls back to the directory input',
  noApi.opened === 1 && noApi.isDir && noApi.multiple,
  `input opened ${noApi.opened}, webkitdirectory ${noApi.isDir}`);

// With the API present, the picker feeds the very same palette.
const picked = await page.evaluate(async () => {
  Object.defineProperty(window, 'showDirectoryPicker', {
    value: async () => window.__fakeFolder, configurable: true,
  });
  document.getElementById('layOpenFolderBtn').click();
  await new Promise(r => setTimeout(r, 400));
  const rows = () => Array.from(document.querySelectorAll('#layPalFolderList .pal-name'))
    .map(r => r.textContent);
  return {
    rows: rows(),
    label: document.getElementById('layPalFolderName').textContent,
    shown: !document.getElementById('layPalFolderGroup').hidden,
    reopen: document.getElementById('layReopenFolderBtn').textContent,
    reopenShown: !document.getElementById('layReopenFolderBtn').hidden,
    saveShown: !document.getElementById('layPalSaveFolderBtn').hidden,
    handled: window.__app.folderBackend.handle === window.__fakeFolder,
  };
});

check('the picker backend fills the folder palette and offers to reopen and write back',
  picked.rows.join(',') === 'anvil,rasp' && picked.label === 'bench' && picked.shown &&
  picked.handled && picked.reopenShown && picked.reopen === '↻ bench' && picked.saveShown,
  `${picked.rows.join(',')} / ${picked.label} / reopen "${picked.reopen}" / save ${picked.saveShown}`);

// Reopen re-walks the handle, so a file added since shows up without a pick.
const reopened = await page.evaluate(async () => {
  const root = window.__fakeFolder;
  const body = JSON.stringify({
    app: '2.5D', version: 1, fileName: 'zed',
    regions: [{ thickness: 3 }],
    trace: { outer: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }], holes: [], circles: [] },
  });
  root.children[0].children.push({
    kind: 'file', name: 'zed.json',
    getFile: async () => new File([body], 'zed.json', { type: 'application/json' }),
  });
  document.getElementById('layReopenFolderBtn').click();
  await new Promise(r => setTimeout(r, 400));
  return Array.from(document.querySelectorAll('#layPalFolderList .pal-name')).map(r => r.textContent);
});

check('Reopen re-reads the folder from disk, picking up a trace added since',
  reopened.join(',') === 'anvil,rasp,zed', reopened.join(','));

// Save project to folder writes project JSON, and nothing else, through the handle.
const wrote = await page.evaluate(async () => {
  const root = window.__fakeFolder;
  root.written.length = 0;
  window.__app.state.fileName = 'bench drawer';
  document.getElementById('layPalSaveFolderBtn').click();
  await new Promise(r => setTimeout(r, 400));
  const w = root.written[0] || null;
  let parsed = null;
  try { parsed = JSON.parse(w.text); } catch { /* reported below */ }
  return {
    n: root.written.length,
    name: w && w.name,
    app: parsed && parsed.app,
    hasLayout: !!(parsed && parsed.layout),
  };
});

check('Save project to folder writes one project JSON, named for the project, into the folder',
  wrote.n === 1 && wrote.name === 'bench drawer.json' && wrote.app === '2.5D' && wrote.hasLayout,
  `${wrote.n} written, "${wrote.name}", app ${wrote.app}`);

// The handle store: a real directory handle structured-clones into IndexedDB;
// anything that does not is simply not remembered, and says so.
const store = await page.evaluate(async () => {
  const fa = await import('/js/import/folderAccess.js');
  const okPlain = await fa.rememberFolder({ name: 'plain', kind: 'directory' }, 'plain');
  const back = await fa.recallFolder();
  const okUnclonable = await fa.rememberFolder({ name: 'fn', values() {} }, 'fn');
  const still = await fa.recallFolder();
  await fa.forgetFolder();
  const gone = await fa.recallFolder();
  const dbs = typeof indexedDB.databases === 'function'
    ? (await indexedDB.databases()).map(d => d.name) : ['2p5d.folder.v1'];
  return {
    okPlain, okUnclonable,
    label: back && back.label,
    handleName: back && back.handle && back.handle.name,
    stillThere: !!still,
    gone: gone === null,
    named: dbs.includes('2p5d.folder.v1'),
  };
});

check('the folder handle is remembered in IndexedDB under 2p5d.folder.v1, and forgotten on request',
  store.okPlain && store.label === 'plain' && store.handleName === 'plain' &&
  store.named && store.stillThere && store.gone && store.okUnclonable === false,
  `remembered ${store.okPlain} as "${store.label}", unclonable ${store.okUnclonable}, cleared ${store.gone}`);

// Put the page back: no folder, no handle, the real picker (if any) restored.
await page.evaluate(async () => {
  const fa = await import('/js/import/folderAccess.js');
  await fa.forgetFolder();
  window.__app.folderBackend.forget();
  window.__app.palette.setFolder({ entries: [], skipped: [] }, '');
  window.__app.state.layout.items.length = 0;
  window.__app.state.fileName = 'object';
  window.__app.layoutEditor.sel = -1;
  window.__app.syncLaySelPanel(-1);
  delete window.showDirectoryPicker;
  delete window.__fakeFolder;
  window.__app.goStep(3);
  await new Promise(r => setTimeout(r, 300));
});

// --- photos inside traces ---

const readerThumb = await page.evaluate(async () => {
  const { tracesFromFiles } = await import('/js/import/traceFolder.js');
  const rect = (x, y, w, h) => [
    { x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h },
  ];
  // A stand-in rectified photo: 400 x 300 px at 4 px/mm, so 100 x 75 mm.
  const c = document.createElement('canvas');
  c.width = 400; c.height = 300;
  const g = c.getContext('2d');
  g.fillStyle = '#1f3f7f'; g.fillRect(0, 0, 400, 300);
  g.fillStyle = '#e0c060'; g.fillRect(80, 120, 240, 120);
  g.fillStyle = '#ffffff'; g.fillRect(120, 150, 40, 40);
  const rectified = c.toDataURL('image/jpeg', 0.85);
  window.__photoCanvas = c;

  const mk = (path, body) => ({
    path,
    file: new File([JSON.stringify(body)], path.split('/').pop(), { type: 'application/json' }),
  });
  // The outline's box is 20,30 to 80,60 mm, which is 80,120 to 320,240 px:
  // 240 x 120, already inside the 256 px cap, so the crop is not downscaled.
  const withPhoto = {
    app: '2.5D', version: 1, fileName: 'photo tool',
    regions: [{ thickness: 6 }],
    trace: { outer: rect(20, 30, 60, 30), holes: [], circles: [] },
    rectified, pxPerMm: 4,
  };
  const noPhoto = {
    app: '2.5D', version: 1, fileName: 'bare tool',
    regions: [{ thickness: 6 }],
    trace: { outer: rect(20, 30, 60, 30), holes: [], circles: [] },
  };
  // A library row that already carries a thumb of its own, at an origin that
  // has to move with the outline when the row is re-normalised.
  const libRow = [{
    name: 'saved row', kind: 'tool', thickness: 4,
    outer: rect(100, 200, 20, 20), holes: [], circles: [],
    thumb: { dataUrl: 'data:image/jpeg;base64,/9j/', mmPerPx: 0.5, origin: { x: 100, y: 200 } },
  }];
  const out = await tracesFromFiles([
    mk('shed/photo.json', withPhoto),
    mk('shed/bare.json', noPhoto),
    mk('shed/rows.json', libRow),
  ]);
  const bare = await tracesFromFiles([mk('shed/photo.json', withPhoto)], { thumbs: false });
  const t = out.entries[0].thumb;
  window.__photoThumb = t;
  return {
    mmPerPx: t && t.mmPerPx,
    origin: t && t.origin,
    isJpeg: !!t && t.dataUrl.startsWith('data:image/jpeg'),
    bytes: t ? t.dataUrl.length : -1,
    noPhotoHasThumb: 'thumb' in out.entries[1],
    rowThumb: out.entries[2].thumb,
    optedOut: 'thumb' in bare.entries[0],
  };
});

check('a project photo becomes a thumb whose mm-per-pixel and origin line up with the outline',
  readerThumb.mmPerPx === 0.25 &&
  readerThumb.origin.x === 5 && readerThumb.origin.y === 5 &&
  readerThumb.isJpeg && readerThumb.bytes > 0 && readerThumb.bytes < 30 * 1024 &&
  !readerThumb.noPhotoHasThumb && !readerThumb.optedOut,
  `${readerThumb.mmPerPx} mm/px, origin ${JSON.stringify(readerThumb.origin)}, ${readerThumb.bytes} bytes`);

check('a library row’s own thumb survives the reader, shifted with its outline',
  readerThumb.rowThumb && readerThumb.rowThumb.mmPerPx === 0.5 &&
  readerThumb.rowThumb.origin.x === 5 && readerThumb.rowThumb.origin.y === 5,
  JSON.stringify(readerThumb.rowThumb && readerThumb.rowThumb.origin));

// The clipped, rotated draw. One item with a photo, one without: the second
// must not throw, and turning photos on must visibly change the canvas.
const drawPhotos = await page.evaluate(async () => {
  const app = window.__app;
  const rect = (x, y, w, h) => [
    { x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h },
  ];
  app.goStep(4);
  await new Promise(r => setTimeout(r, 200));
  const items = app.state.layout.items;
  items.length = 0;
  items.push({
    name: 'photo', outer: rect(5, 5, 60, 30), holes: [], circles: [],
    thickness: 6, depth: null, rot: 20, x: 60, y: 50, thumb: window.__photoThumb,
  });
  items.push({
    name: 'plain', outer: rect(5, 5, 30, 30), holes: [], circles: [],
    thickness: 6, depth: null, rot: 0, x: 150, y: 95,
  });
  const ed = app.layoutEditor;
  const canvas = document.getElementById('layoutCanvas');
  let threw = null;
  let off = '', on = '';
  try {
    ed.showPhotos = false;
    app.refreshLayoutEditor();
    off = canvas.toDataURL();
    ed.showPhotos = true;
    ed.draw();                                  // kicks off the decode
    await new Promise(r => setTimeout(r, 500));  // the load handler redraws
    ed.draw();
    on = canvas.toDataURL();
  } catch (err) { threw = String(err); }
  return { threw, painted: off !== '' && on !== off, cached: ed._thumbs.size };
});

check('photos draw clipped into their outlines, and an item with no photo draws anyway',
  drawPhotos.threw === null && drawPhotos.painted && drawPhotos.cached === 1,
  `threw ${drawPhotos.threw} / changed the canvas ${drawPhotos.painted} / ${drawPhotos.cached} decoded`);

const photoToggle = await page.evaluate(async () => {
  const cb = document.getElementById('layShowPhotos');
  const defaultOn = cb.checked && window.__app.layoutEditor.showPhotos === true;
  cb.checked = false; cb.dispatchEvent(new Event('change'));
  const offNow = window.__app.layoutEditor.showPhotos;
  cb.checked = true; cb.dispatchEvent(new Event('change'));
  const onNow = window.__app.layoutEditor.showPhotos;
  return { defaultOn, offNow, onNow };
});

check('Show photos defaults on and drives the editor both ways',
  photoToggle.defaultOn && photoToggle.offNow === false && photoToggle.onNow === true,
  `default ${photoToggle.defaultOn}, off ${photoToggle.offNow}, on ${photoToggle.onNow}`);

// Saving a trace to the outline library crops the photo the same way.
const libThumb = await page.evaluate(async () => {
  const app = window.__app;
  const rect = (x, y, w, h) => [
    { x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h },
  ];
  const libBefore = localStorage.getItem('2p5d.library.v1');
  const rectBefore = app.state.rect;
  const traceBefore = app.traceEditor.getTrace();
  localStorage.setItem('2p5d.library.v1', '[]');
  app.state.rect = { canvas: window.__photoCanvas, pxPerMm: 4 };
  app.traceEditor.setTrace(rect(20, 30, 60, 30), []);
  document.getElementById('libName').value = 'photo tool';
  document.getElementById('libKind').value = 'tool';
  document.getElementById('libSaveBtn').click();
  const saved = JSON.parse(localStorage.getItem('2p5d.library.v1') || '[]')
    .find(o => o.name === 'photo tool') || null;
  // Put every borrowed piece of state back before anything else runs.
  app.traceEditor.setTrace(traceBefore.outer, traceBefore.holes);
  app.traceEditor.setCircles(traceBefore.circles);
  app.state.rect = rectBefore;
  if (libBefore === null) localStorage.removeItem('2p5d.library.v1');
  else localStorage.setItem('2p5d.library.v1', libBefore);
  app.palette.refresh();
  return {
    had: !!saved,
    mmPerPx: saved && saved.thumb && saved.thumb.mmPerPx,
    origin: saved && saved.thumb && saved.thumb.origin,
    bytes: saved && saved.thumb ? saved.thumb.dataUrl.length : -1,
  };
});

check('saving to the outline library stores the photo cropped to the outline',
  libThumb.had && libThumb.mmPerPx === 0.25 &&
  libThumb.origin.x === 5 && libThumb.origin.y === 5 &&
  libThumb.bytes > 0 && libThumb.bytes < 30 * 1024,
  `${libThumb.mmPerPx} mm/px, origin ${JSON.stringify(libThumb.origin)}, ${libThumb.bytes} bytes`);

// Near the 5 MB localStorage ceiling the photos come out rather than the save
// failing outright; a library that is nowhere near it is left exactly alone.
const budget = await page.evaluate(() => {
  const app = window.__app;
  const big = 'data:image/jpeg;base64,' + 'A'.repeat(2 * 1024 * 1024);
  const thumb = { dataUrl: big, mmPerPx: 0.25, origin: { x: 5, y: 5 } };
  const heavy = app.libFitThumbs([
    { name: 'a', kind: 'tool', outer: [], thumb },
    { name: 'b', kind: 'tool', outer: [], thumb },
    { name: 'c', kind: 'tool', outer: [] },
  ]);
  const light = app.libFitThumbs([
    { name: 'a', kind: 'tool', outer: [], thumb: { dataUrl: 'data:image/jpeg;base64,/9j/', mmPerPx: 1, origin: { x: 5, y: 5 } } },
  ]);
  return {
    dropped: heavy.dropped,
    anyLeft: heavy.list.some(o => o.thumb),
    names: heavy.list.map(o => o.name).join(','),
    kept: light.dropped === 0 && !!light.list[0].thumb,
  };
});

check('past 4 MB the library is saved without photos, and a small library keeps them',
  budget.dropped === 2 && !budget.anyLeft && budget.names === 'a,b,c' && budget.kept,
  `${budget.dropped} photos dropped, rows ${budget.names}, small library kept ${budget.kept}`);

// Leave the page as the blocks after this one expect it.
await page.evaluate(async () => {
  window.__app.state.layout.items.length = 0;
  window.__app.layoutEditor.sel = -1;
  window.__app.layoutEditor.showPhotos = true;
  document.getElementById('layShowPhotos').checked = true;
  window.__app.syncLaySelPanel(-1);
  delete window.__photoThumb;
  delete window.__photoCanvas;
  // A trip through Step 4 repopulates every list from the restored library.
  window.__app.goStep(4);
  await new Promise(r => setTimeout(r, 200));
  window.__app.refreshLayoutEditor();
  window.__app.goStep(3);
  await new Promise(r => setTimeout(r, 300));
});

// --- the bed as a build plate ---

// A 200 x 100 layout on a 300 x 200 plate: Auto-centre puts it 50 mm in from
// every edge, and the dashed outline that gets drawn is that plate.
const plateCentre = await page.evaluate(async () => {
  const app = window.__app;
  app.goStep(4);
  app.state.layout.items.length = 0;
  app.state.layout.container = { ...app.state.layout.container, type: 'rect', w: 200, h: 100, r: 6, name: null };
  app.state.layout.bed.shape = null;
  app.state.layout.bed.offset = { x: 0, y: 0 };
  const bed = document.getElementById('layBed');
  bed.value = '300x200'; bed.dispatchEvent(new Event('change'));
  await new Promise(r => setTimeout(r, 200));
  const before = app.bed.loop();
  document.getElementById('layBedCentreBtn').click();
  await new Promise(r => setTimeout(r, 200));
  const off = app.bed.offset();
  const loop = app.bed.loop();
  const box = l => ({
    minX: Math.min(...l.map(p => p.x)), minY: Math.min(...l.map(p => p.y)),
    maxX: Math.max(...l.map(p => p.x)), maxY: Math.max(...l.map(p => p.y)),
  });
  return {
    off, n: loop.length, plate: box(loop), zero: box(before),
    info: document.getElementById('layBedInfo').textContent,
    drawn: !!app.layoutEditor.bedLoop(),
  };
});

check('Auto-centre puts a 200 × 100 layout in the middle of a 300 × 200 plate',
  plateCentre.off.x === 50 && plateCentre.off.y === 50 && plateCentre.n === 4 &&
  plateCentre.plate.minX === -45 && plateCentre.plate.minY === -45 &&
  plateCentre.plate.maxX === 255 && plateCentre.plate.maxY === 155 &&
  plateCentre.zero.minX === 5 && plateCentre.zero.minY === 5 && plateCentre.drawn,
  `offset ${JSON.stringify(plateCentre.off)}, plate ${JSON.stringify(plateCentre.plate)}`);

// Dragging the dashed outline moves the plate, not the layout: the offset
// runs the other way, and the drag selects the plate rather than a tool.
const plateDrag = await page.evaluate(async () => {
  const app = window.__app, ed = app.layoutEditor;
  const cv = ed.canvas;
  const r = cv.getBoundingClientRect();
  const client = mm => {
    const s = ed.mmToScreen(mm);
    return { x: r.left + s.x * (r.width / cv.width), y: r.top + s.y * (r.height / cv.height) };
  };
  // Left edge of the plate, halfway down: a point on the outline and on no tool.
  const grab = client({ x: -45, y: 55 });
  const drop = client({ x: -45 + 20, y: 55 + 8 });
  const cap = cv.setPointerCapture, rel = cv.releasePointerCapture;
  cv.setPointerCapture = () => {}; cv.releasePointerCapture = () => {};
  const ev = (type, p) => cv.dispatchEvent(new PointerEvent(type, {
    clientX: p.x, clientY: p.y, pointerId: 1, bubbles: true,
  }));
  ev('pointerdown', grab);
  const selected = ed.bedSel;
  ev('pointermove', drop);
  ev('pointerup', drop);
  cv.setPointerCapture = cap; cv.releasePointerCapture = rel;
  await new Promise(r2 => setTimeout(r2, 150));
  return { selected, off: app.bed.offset() };
});

check('dragging the dashed plate outline moves the plate under the layout',
  plateDrag.selected && Math.abs(plateDrag.off.x - 30) < 1.5 &&
  Math.abs(plateDrag.off.y - 42) < 1.5,
  `selected ${plateDrag.selected}, offset ${JSON.stringify(plateDrag.off)}`);

// Arrow keys nudge the selected plate: 1 mm, 10 mm with Shift.
const plateNudge = await page.evaluate(async () => {
  const app = window.__app;
  app.layoutEditor.bedSel = true;
  app.state.layout.bed.offset = { x: 50, y: 50 };
  app.refreshLayoutEditor();
  const key = (k, shift) => document.dispatchEvent(new KeyboardEvent('keydown', { key: k, shiftKey: !!shift, bubbles: true }));
  key('ArrowRight');
  const one = { ...app.bed.offset() };
  key('ArrowDown', true);
  const ten = { ...app.bed.offset() };
  // With nothing selected the arrow keys are somebody else's to use.
  app.layoutEditor.bedSel = false;
  key('ArrowRight');
  const idle = { ...app.bed.offset() };
  return { one, ten, idle, readout: document.getElementById('layBedOffsetInfo').textContent };
});

check('arrow keys nudge the plate 1 mm, and 10 mm with Shift, only while it is selected',
  plateNudge.one.x === 49 && plateNudge.one.y === 50 &&
  plateNudge.ten.x === 49 && plateNudge.ten.y === 40 &&
  plateNudge.idle.x === 49 && plateNudge.idle.y === 40 &&
  /across and/.test(plateNudge.readout) && /nudge with the arrow keys/.test(plateNudge.readout),
  `${JSON.stringify(plateNudge.one)} then ${JSON.stringify(plateNudge.ten)}, readout ${plateNudge.readout.slice(0, 60)}`);

// A layout wider than the bed tiles, and the plate offset is the tiling
// window: pushing the plate 10 mm takes 10 mm off the first tile and carries
// every seam with it.
const tileWindow = await page.evaluate(async () => {
  const app = window.__app;
  app.state.layout.bed.offset = { x: 0, y: 0 };
  app.state.layout.container = { ...app.state.layout.container, type: 'rect', w: 400, h: 140, r: 6, name: null };
  app.state.layout.items.length = 0;
  const rect = (w, h) => [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }];
  app.state.layout.items.push({
    name: 'wide', outer: rect(180, 60), holes: [], circles: [],
    x: 105, y: 75, rot: 0, depth: 4, thickness: 5,
  });
  app.refreshLayoutEditor();
  await new Promise(r => setTimeout(r, 200));
  const at = off => {
    app.state.layout.bed.offset = { x: off, y: 0 };
    const plan = app.bed.plan();
    return plan ? plan.tiles.map(t => t.x0) : null;
  };
  const zero = at(0), ten = at(10);
  app.state.layout.bed.offset = { x: 0, y: 0 };
  app.refreshLayoutEditor();
  return { zero, ten };
});

check('the tiling window follows the plate: a 10 mm nudge shifts every tile origin by 10 mm',
  tileWindow.zero && tileWindow.ten && tileWindow.zero.length === 2 &&
  tileWindow.ten.length === tileWindow.zero.length &&
  tileWindow.ten.every((x, i) => Math.abs(x - (tileWindow.zero[i] - 10)) < 1e-6),
  `${JSON.stringify(tileWindow.zero)} -> ${JSON.stringify(tileWindow.ten)}`);

// A round plate is honoured in the single-tile case: the layout fits its
// bounding square and still has four corners hanging off the circle.
const roundPlate = await page.evaluate(async () => {
  const app = window.__app;
  app.state.layout.items.length = 0;
  app.state.layout.container = { ...app.state.layout.container, type: 'rect', w: 200, h: 100, r: 6, name: null };
  const disc = d => {
    const out = [];
    for (let i = 0; i < 64; i++) {
      const a = (i / 64) * Math.PI * 2;
      out.push({ x: d / 2 + (d / 2) * Math.cos(a), y: d / 2 + (d / 2) * Math.sin(a) });
    }
    return out;
  };
  const on = d => {
    app.state.layout.bed.shape = { name: `${d} mm disc`, outer: disc(d) };
    app.state.layout.bed.preset = 'custom';
    app.state.layout.bed.w = d; app.state.layout.bed.h = d;
    app.bed.centre();
    app.refreshLayoutEditor();
    return {
      escapes: app.bed.escapes(),
      info: document.getElementById('layBedInfo').textContent,
      cls: document.getElementById('layBedInfo').className,
    };
  };
  const tight = on(200);
  const roomy = on(240);
  return { tight, roomy };
});

check('a round plate warns when the corners of the layout leave it, and stays quiet when they do not',
  roundPlate.tight.escapes >= 4 && roundPlate.tight.cls === 'warn' &&
  /outside the 200 mm disc plate/.test(roundPlate.tight.info) &&
  roundPlate.roomy.escapes === 0 && roundPlate.roomy.cls === 'hint' &&
  /Shaped plate: 240 mm disc/.test(roundPlate.roomy.info),
  `${roundPlate.tight.escapes} out on the small disc, ${roundPlate.roomy.escapes} on the large one`);

// The plate shape and offset are additive save-format fields: they survive a
// round trip, and a project saved before they existed still loads.
const plateSave = await page.evaluate(async () => {
  const app = window.__app;
  app.state.layout.bed.offset = { x: 12, y: 7 };
  const saved = JSON.parse(app.serializeProject(false));
  const legacy = JSON.parse(app.serializeProject(false));
  delete legacy.layout.bed.offset;
  delete legacy.layout.bed.shape;
  await app.loadProject(saved);
  const back = { off: app.bed.offset(), shape: app.state.layout.bed.shape && app.state.layout.bed.shape.name };
  // loadProject merges the file's bed onto the live one, so a pre-build-plate
  // project is only interesting against a state that has no plate either:
  // the merge must leave a usable offset rather than an undefined one.
  app.state.layout.bed.shape = null;
  delete app.state.layout.bed.offset;
  await app.loadProject(legacy);
  const old = {
    off: app.bed.offset(), shape: app.state.layout.bed.shape,
    defined: !!app.state.layout.bed.offset,
  };
  return { back, old, hadShape: !!saved.layout.bed.shape };
});

check('the plate shape and offset round-trip through a project, and an older project still loads',
  plateSave.hadShape && plateSave.back.off.x === 12 && plateSave.back.off.y === 7 &&
  plateSave.back.shape === '240 mm disc' &&
  plateSave.old.off.x === 0 && plateSave.old.off.y === 0 && !plateSave.old.shape &&
  plateSave.old.defined,
  `back ${JSON.stringify(plateSave.back)}, legacy ${JSON.stringify(plateSave.old)}`);

// A plate-shape name is text out of a project file, so it goes into the select
// as text. A name carrying markup must render as that markup's characters and
// run nothing.
const plateName = await page.evaluate(async () => {
  const app = window.__app;
  const square = [{ x: 0, y: 0 }, { x: 200, y: 0 }, { x: 200, y: 200 }, { x: 0, y: 200 }];
  const proj = JSON.parse(app.serializeProject(false));
  proj.layout.bed = {
    ...proj.layout.bed, preset: 'custom', w: 200, h: 200, offset: { x: 0, y: 0 },
    shape: { name: '</option><img src=x onerror="window.__plateInjected = 1">', outer: square },
  };
  await app.loadProject(proj);
  app.goStep(3);
  await new Promise(r => setTimeout(r, 250));
  app.goStep(4);
  await new Promise(r => setTimeout(r, 250));
  const sel = document.getElementById('layBedShape');
  const opt = sel.querySelector('option[value="__shape"]');
  return {
    ran: !!window.__plateInjected,
    imgs: document.querySelectorAll('img[src="x"]').length,
    inside: sel.querySelectorAll('*:not(option)').length,
    text: opt ? opt.textContent : null,
    value: sel.value,
  };
});

check('a plate-shape name out of a project file is written as text, never as markup',
  !plateName.ran && plateName.imgs === 0 && plateName.inside === 0 &&
  plateName.value === '__shape' &&
  /<img src=x onerror=/.test(plateName.text),
  `ran ${plateName.ran}, ${plateName.imgs} injected nodes, option ${JSON.stringify(plateName.text)}`);

// Picking a shape has to show in the select it was picked from, and backing
// out of it has to give the user's own bed rectangle back.
const plateSelect = await page.evaluate(async () => {
  const app = window.__app;
  const libBefore = localStorage.getItem('2p5d.library.v1');
  const disc = [];
  for (let i = 0; i < 32; i++) {
    const a = (i / 32) * Math.PI * 2;
    disc.push({ x: 90 + 90 * Math.cos(a), y: 90 + 90 * Math.sin(a) });
  }
  localStorage.setItem('2p5d.library.v1', JSON.stringify([
    { name: 'round plate', kind: 'container', outer: disc, holes: [], circles: [] },
  ]));
  app.state.layout.bed.shape = null;
  app.state.layout.bed.offset = { x: 0, y: 0 };
  app.state.layout.bed.preset = 'custom';
  app.state.layout.bed.w = 300; app.state.layout.bed.h = 200;
  app.goStep(3);
  await new Promise(r => setTimeout(r, 250));
  app.goStep(4);
  await new Promise(r => setTimeout(r, 250));
  const sel = document.getElementById('layBedShape');
  const listed = Array.from(sel.options).some(o => o.value === '0');
  sel.value = '0';
  sel.dispatchEvent(new Event('change'));
  await new Promise(r => setTimeout(r, 150));
  const picked = {
    value: sel.value, index: sel.selectedIndex,
    label: sel.selectedIndex >= 0 ? sel.options[sel.selectedIndex].textContent : null,
    name: app.state.layout.bed.shape && app.state.layout.bed.shape.name,
    w: app.state.layout.bed.w, h: app.state.layout.bed.h,
  };
  sel.value = 'rect';
  sel.dispatchEvent(new Event('change'));
  await new Promise(r => setTimeout(r, 150));
  const cleared = {
    value: sel.value, index: sel.selectedIndex,
    shape: app.state.layout.bed.shape,
    preset: app.state.layout.bed.preset,
    w: app.state.layout.bed.w, h: app.state.layout.bed.h,
  };
  if (libBefore === null) localStorage.removeItem('2p5d.library.v1');
  else localStorage.setItem('2p5d.library.v1', libBefore);
  return { listed, picked, cleared };
});

check('picking a plate shape shows it in the select, and a rectangle again gives the bed back',
  plateSelect.listed &&
  plateSelect.picked.value === '__shape' && plateSelect.picked.index === 1 &&
  /round plate/.test(plateSelect.picked.label || '') &&
  plateSelect.picked.name === 'round plate' &&
  plateSelect.picked.w === 180 && plateSelect.picked.h === 180 &&
  plateSelect.cleared.value === 'rect' && plateSelect.cleared.index === 0 &&
  !plateSelect.cleared.shape &&
  plateSelect.cleared.w === 300 && plateSelect.cleared.h === 200,
  `picked ${JSON.stringify(plateSelect.picked)}, cleared ${JSON.stringify(plateSelect.cleared)}`);

// A project saved before the build plate existed carries no shape and no
// offset, and must load with neither, whatever plate the drawer before it left
// on screen. Inheriting one retiles a drawer that fits its bed whole.
const plateLegacy = await page.evaluate(async () => {
  const app = window.__app;
  app.state.layout.items.length = 0;
  app.state.layout.container = { ...app.state.layout.container, type: 'rect', w: 280, h: 180, r: 6, name: null };
  app.state.layout.bed.shape = null;
  app.state.layout.bed.offset = { x: 0, y: 0 };
  app.state.layout.bed.preset = 'custom';
  app.state.layout.bed.w = 300; app.state.layout.bed.h = 200;
  const legacy = JSON.parse(app.serializeProject(false));
  delete legacy.layout.bed.shape;
  delete legacy.layout.bed.offset;
  // The drawer on screen before it: a plate shape picked and the plate dragged.
  app.state.layout.bed.shape = { name: 'someone else\'s plate', outer: [{ x: 0, y: 0 }, { x: 250, y: 0 }, { x: 250, y: 250 }, { x: 0, y: 250 }] };
  app.state.layout.bed.offset = { x: 37, y: 21 };
  await app.loadProject(legacy);
  app.refreshLayoutEditor();
  return {
    off: app.bed.offset(),
    shape: app.state.layout.bed.shape,
    info: document.getElementById('layBedInfo').textContent,
    tilesBtn: document.getElementById('layExportTilesBtn').disabled,
    plan: !!app.bed.plan(),
  };
});

check('a project saved before the build plate loads with no plate, not the last drawer\'s',
  plateLegacy.off.x === 0 && plateLegacy.off.y === 0 && !plateLegacy.shape &&
  /Fits the 300 × 200 bed in one piece/.test(plateLegacy.info) &&
  plateLegacy.tilesBtn === true,
  `offset ${JSON.stringify(plateLegacy.off)}, shape ${JSON.stringify(plateLegacy.shape)}, info ${plateLegacy.info}`);

// The tiling window can only start at or before the layout, so a plate nudged
// the other way changes no seam. Say that, rather than exporting the same
// tiles and letting the readout claim the plate moved.
const plateNeg = await page.evaluate(async () => {
  const app = window.__app;
  app.state.layout.items.length = 0;
  app.state.layout.bed.shape = null;
  app.state.layout.bed.preset = 'custom';
  app.state.layout.bed.w = 300; app.state.layout.bed.h = 200;
  app.state.layout.container = { ...app.state.layout.container, type: 'rect', w: 400, h: 140, r: 6, name: null };
  const at = off => {
    app.state.layout.bed.offset = { x: off, y: 0 };
    app.refreshLayoutEditor();
    const plan = app.bed.plan();
    const el = document.getElementById('layBedInfo');
    return { x0: plan ? plan.tiles.map(t => t.x0) : null, info: el.textContent, cls: el.className };
  };
  const zero = at(0), back = at(-40);
  app.state.layout.bed.offset = { x: 0, y: 0 };
  app.refreshLayoutEditor();
  return { zero, back };
});

check('a plate nudged where the seams cannot follow says so instead of tiling in silence',
  plateNeg.zero.cls === 'hint' && !/negative/.test(plateNeg.zero.info) &&
  plateNeg.zero.x0 && plateNeg.back.x0 &&
  plateNeg.back.x0.length === plateNeg.zero.x0.length &&
  plateNeg.back.x0.every((x, i) => x === plateNeg.zero.x0[i]) &&
  plateNeg.back.cls === 'warn' && /offset is negative/.test(plateNeg.back.info),
  `${JSON.stringify(plateNeg.zero.x0)} -> ${JSON.stringify(plateNeg.back.x0)}, ${plateNeg.back.cls}: ${plateNeg.back.info.slice(-90)}`);

// A drawer that fits the plate but has been dragged off its right edge is
// mis-placed, not too big: it says so the way the same drag the other way
// does, and it is not cut into tiles because of where the plate sits.
const plateOver = await page.evaluate(async () => {
  const app = window.__app;
  app.state.layout.items.length = 0;
  app.state.layout.bed.shape = null;
  app.state.layout.bed.preset = 'custom';
  app.state.layout.bed.w = 300; app.state.layout.bed.h = 200;
  app.state.layout.container = { ...app.state.layout.container, type: 'rect', w: 220, h: 140, r: 6, name: null };
  const outline = [{ x: 5, y: 5 }, { x: 65, y: 5 }, { x: 65, y: 35 }, { x: 5, y: 35 }];
  app.state.layout.items.push(
    { name: 'spanner', outer: outline, holes: [], circles: [], x: 60, y: 40, rot: 0, depth: 4, thickness: 5 },
    { name: 'pliers', outer: outline, holes: [], circles: [], x: 60, y: 100, rot: 0, depth: 4, thickness: 5 });
  const at = off => {
    app.state.layout.bed.offset = { x: off, y: 0 };
    app.refreshLayoutEditor();
    const el = document.getElementById('layBedInfo');
    const out = app.layoutExports.svg('auto');
    const tiles = app.layoutExports.svg('tiles');
    return {
      info: el.textContent, cls: el.className,
      btn: document.getElementById('layExportTilesBtn').disabled,
      plan: !!app.bed.plan(),
      name: out ? out.name : null, tiles: tiles ? tiles.name : null,
    };
  };
  const on = at(40), over = at(100), far = at(200);
  app.state.layout.bed.offset = { x: 0, y: 0 };
  app.state.layout.items.length = 0;
  app.refreshLayoutEditor();
  return { on, over, far };
});

check('a drawer that fits the plate but hangs off its edge is warned about, not tiled',
  plateOver.on.cls === 'hint' && /Fits the 300 × 200 bed in one piece/.test(plateOver.on.info) &&
  !plateOver.on.plan && plateOver.on.btn === true && /-drawer-template\.svg$/.test(plateOver.on.name || '') &&
  plateOver.over.cls === 'warn' && /pushes it off the plate/.test(plateOver.over.info) &&
  !/Larger than the bed/.test(plateOver.over.info) &&
  !plateOver.over.plan && plateOver.over.btn === true &&
  /-drawer-template\.svg$/.test(plateOver.over.name || '') && plateOver.over.tiles === null &&
  plateOver.far.cls === 'warn' && !plateOver.far.plan && plateOver.far.btn === true,
  `on ${plateOver.on.cls}/${plateOver.on.btn}, over ${plateOver.over.cls}/${plateOver.over.btn}/${plateOver.over.name}: ${plateOver.over.info}`);

// Auto-centre on a layout the plate cannot hold whole has only one honest
// answer on the oversized axis, which is zero: the seams cannot follow a
// negative offset, so the button must never write one and then be named as
// the cure for it.
const plateCentreBig = await page.evaluate(async () => {
  const app = window.__app;
  app.state.layout.items.length = 0;
  app.state.layout.bed.shape = null;
  app.state.layout.bed.preset = 'custom';
  app.state.layout.bed.w = 300; app.state.layout.bed.h = 200;
  app.state.layout.bed.offset = { x: 0, y: 0 };
  const centre = async (w, h) => {
    app.state.layout.container = { ...app.state.layout.container, type: 'rect', w, h, r: 6, name: null };
    app.refreshLayoutEditor();
    document.getElementById('layBedCentreBtn').click();
    await new Promise(r => setTimeout(r, 150));
    const el = document.getElementById('layBedInfo');
    const plan = app.bed.plan();
    return {
      off: app.bed.offset(), cls: el.className, info: el.textContent,
      x0: plan ? plan.tiles.map(t => t.x0) : null,
    };
  };
  const both = await centre(400, 300);
  const oneAxis = await centre(400, 100);
  app.state.layout.bed.offset = { x: 0, y: 0 };
  app.refreshLayoutEditor();
  return { both, oneAxis };
});

check('Auto-centre on a layout larger than the plate never writes an offset the seams ignore',
  plateCentreBig.both.off.x === 0 && plateCentreBig.both.off.y === 0 &&
  plateCentreBig.both.cls === 'hint' && !/offset is negative/.test(plateCentreBig.both.info) &&
  plateCentreBig.both.x0 && plateCentreBig.both.x0.length === 4 &&
  plateCentreBig.oneAxis.off.x === 0 && plateCentreBig.oneAxis.off.y === 50 &&
  plateCentreBig.oneAxis.cls === 'hint' && !/offset is negative/.test(plateCentreBig.oneAxis.info),
  `both ${JSON.stringify(plateCentreBig.both.off)} ${plateCentreBig.both.cls}, one axis ${JSON.stringify(plateCentreBig.oneAxis.off)} ${plateCentreBig.oneAxis.cls}`);

// The bed remembered behind a plate shape belongs to the drawer that was on
// screen when the shape was picked. Opening another project and backing out of
// its shape has to give that project its own bed back.
const plateStale = await page.evaluate(async () => {
  const app = window.__app;
  const libBefore = localStorage.getItem('2p5d.library.v1');
  const sq = s => [{ x: 0, y: 0 }, { x: s, y: 0 }, { x: s, y: s }, { x: 0, y: s }];
  localStorage.setItem('2p5d.library.v1', JSON.stringify([
    { name: 'small plate', kind: 'container', outer: sq(200), holes: [], circles: [] },
    { name: 'big plate', kind: 'container', outer: sq(400), holes: [], circles: [] },
  ]));
  // Drawer B, saved with its own 400 x 400 shaped plate.
  app.state.layout.items.length = 0;
  app.state.layout.container = { ...app.state.layout.container, type: 'rect', w: 350, h: 250, r: 6, name: null };
  app.state.layout.bed.preset = 'custom';
  app.state.layout.bed.w = 400; app.state.layout.bed.h = 400;
  app.state.layout.bed.offset = { x: 0, y: 0 };
  app.state.layout.bed.shape = { name: 'big plate', outer: sq(400) };
  const projB = JSON.parse(app.serializeProject(false));
  // Drawer A first: a 300 x 200 bed with a plate shape picked over it.
  app.state.layout.bed.shape = null;
  app.state.layout.bed.preset = '300x200';
  app.state.layout.bed.w = 300; app.state.layout.bed.h = 200;
  app.goStep(3);
  await new Promise(r => setTimeout(r, 250));
  app.goStep(4);
  await new Promise(r => setTimeout(r, 250));
  const sel = document.getElementById('layBedShape');
  sel.value = '0'; sel.dispatchEvent(new Event('change'));
  await new Promise(r => setTimeout(r, 150));
  const a = { w: app.state.layout.bed.w, h: app.state.layout.bed.h, name: app.state.layout.bed.shape && app.state.layout.bed.shape.name };
  // Now drawer B, and out of its shape.
  await app.loadProject(projB);
  app.goStep(4);
  await new Promise(r => setTimeout(r, 250));
  const loaded = {
    preset: app.state.layout.bed.preset, w: app.state.layout.bed.w, h: app.state.layout.bed.h,
    name: app.state.layout.bed.shape && app.state.layout.bed.shape.name,
  };
  const sel2 = document.getElementById('layBedShape');
  sel2.value = 'rect'; sel2.dispatchEvent(new Event('change'));
  await new Promise(r => setTimeout(r, 200));
  const cleared = {
    preset: app.state.layout.bed.preset, w: app.state.layout.bed.w, h: app.state.layout.bed.h,
    shape: !!app.state.layout.bed.shape,
    info: document.getElementById('layBedInfo').textContent,
  };
  if (libBefore === null) localStorage.removeItem('2p5d.library.v1');
  else localStorage.setItem('2p5d.library.v1', libBefore);
  return { a, loaded, cleared };
});

check('a loaded project clearing its plate shape gets its own bed back, not the last drawer\'s',
  plateStale.a.w === 200 && plateStale.a.h === 200 && plateStale.a.name === 'small plate' &&
  plateStale.loaded.w === 400 && plateStale.loaded.h === 400 && plateStale.loaded.name === 'big plate' &&
  plateStale.cleared.preset === 'custom' &&
  plateStale.cleared.w === 400 && plateStale.cleared.h === 400 && !plateStale.cleared.shape &&
  /Fits the 400 × 400 bed in one piece/.test(plateStale.cleared.info),
  `drawer A ${JSON.stringify(plateStale.a)}, loaded ${JSON.stringify(plateStale.loaded)}, cleared ${JSON.stringify(plateStale.cleared)}`);

// Leave the plate as the blocks after this one expect it: no bed, no shape,
// no offset, nothing placed, back on Step 3.
await page.evaluate(async () => {
  const app = window.__app;
  app.state.layout.bed.shape = null;
  app.state.layout.bed.offset = { x: 0, y: 0 };
  app.state.layout.bed.w = 300; app.state.layout.bed.h = 200;
  app.state.layout.items.length = 0;
  app.state.layout.container = { ...app.state.layout.container, type: 'rect', w: 220, h: 140, r: 6, name: null };
  app.layoutEditor.bedSel = false;
  app.layoutEditor.sel = -1;
  const bed = document.getElementById('layBed');
  bed.value = 'none'; bed.dispatchEvent(new Event('change'));
  app.syncLaySelPanel(-1);
  app.goStep(3);
  await new Promise(r => setTimeout(r, 300));
});

// --- Known width and Known depth on the container ---

// A traced 200 x 100 drawer, measured with a tape at 210 across: the outline
// scales about its own centre, and only across.
const knownOne = await page.evaluate(async () => {
  const app = window.__app;
  app.goStep(4);
  app.state.layout.items.length = 0;
  const traced = () => [{ x: 5, y: 5 }, { x: 205, y: 5 }, { x: 205, y: 105 }, { x: 5, y: 105 }];
  app.state.layout.container = {
    ...app.state.layout.container, type: 'outline', name: 'bench drawer',
    outer: traced(), scale: { x: 1, y: 1 },
  };
  // Back out and in, so the panel syncs from the container just set.
  app.goStep(3);
  await new Promise(r => setTimeout(r, 200));
  app.goStep(4);
  await new Promise(r => setTimeout(r, 200));
  const shown = !document.getElementById('layKnownFields').hidden;
  const set = (id, v) => {
    const el = document.getElementById(id);
    el.value = v; el.dispatchEvent(new Event('change'));
  };
  set('layKnownW', '210');
  await new Promise(r => setTimeout(r, 150));
  const box = l => ({
    w: Math.max(...l.map(p => p.x)) - Math.min(...l.map(p => p.x)),
    h: Math.max(...l.map(p => p.y)) - Math.min(...l.map(p => p.y)),
    cx: (Math.max(...l.map(p => p.x)) + Math.min(...l.map(p => p.x))) / 2,
    cy: (Math.max(...l.map(p => p.y)) + Math.min(...l.map(p => p.y))) / 2,
  });
  return {
    shown, b: box(app.state.layout.container.outer),
    scale: { ...app.state.layout.container.scale },
    field: document.getElementById('layKnownW').value,
    info: document.getElementById('layScaleInfo').textContent,
    cls: document.getElementById('layScaleInfo').className,
  };
});

check('a known width of 210 makes a traced 200 × 100 container 210 × 100 about its centre',
  knownOne.shown && Math.abs(knownOne.b.w - 210) < 1e-6 && Math.abs(knownOne.b.h - 100) < 1e-6 &&
  Math.abs(knownOne.b.cx - 105) < 1e-6 && Math.abs(knownOne.b.cy - 55) < 1e-6 &&
  knownOne.scale.x === 1.05 && knownOne.scale.y === 1 &&
  knownOne.field === '210' && knownOne.cls === 'hint' && /×1\.050 across/.test(knownOne.info),
  `${knownOne.b.w} × ${knownOne.b.h} at ${knownOne.b.cx},${knownOne.b.cy}, scale ${JSON.stringify(knownOne.scale)}`);

// Both fields: each axis is forced on its own, which is how a shot that was
// not quite square gets its residual warp taken out.
const knownBoth = await page.evaluate(async () => {
  const app = window.__app;
  app.state.layout.container = {
    ...app.state.layout.container, type: 'outline', name: 'bench drawer',
    outer: [{ x: 5, y: 5 }, { x: 205, y: 5 }, { x: 205, y: 105 }, { x: 5, y: 105 }],
    scale: { x: 1, y: 1 },
  };
  app.refreshLayoutEditor();
  const set = (id, v) => {
    const el = document.getElementById(id);
    el.value = v; el.dispatchEvent(new Event('change'));
  };
  set('layKnownW', '210');
  set('layKnownD', '105');
  await new Promise(r => setTimeout(r, 150));
  const l = app.state.layout.container.outer;
  return {
    w: Math.max(...l.map(p => p.x)) - Math.min(...l.map(p => p.x)),
    h: Math.max(...l.map(p => p.y)) - Math.min(...l.map(p => p.y)),
    scale: { ...app.state.layout.container.scale },
    info: document.getElementById('layScaleInfo').textContent,
    cls: document.getElementById('layScaleInfo').className,
  };
});

check('known width and depth together scale each axis on its own',
  Math.abs(knownBoth.w - 210) < 1e-6 && Math.abs(knownBoth.h - 105) < 1e-6 &&
  knownBoth.scale.x === 1.05 && knownBoth.scale.y === 1.05 &&
  knownBoth.cls === 'hint' && /×1\.050 across and ×1\.050 down/.test(knownBoth.info),
  `${knownBoth.w} × ${knownBoth.h}, scale ${JSON.stringify(knownBoth.scale)}`);

// 210 x 120 on the same trace is 5 percent one way and 20 the other: past the
// 2 percent the readout stops agreeing with you.
const knownWarn = await page.evaluate(async () => {
  const app = window.__app;
  app.state.layout.container = {
    ...app.state.layout.container, type: 'outline', name: 'bench drawer',
    outer: [{ x: 5, y: 5 }, { x: 205, y: 5 }, { x: 205, y: 105 }, { x: 5, y: 105 }],
    scale: { x: 1, y: 1 },
  };
  app.refreshLayoutEditor();
  const set = (id, v) => {
    const el = document.getElementById(id);
    el.value = v; el.dispatchEvent(new Event('change'));
  };
  set('layKnownW', '210');
  set('layKnownD', '120');
  await new Promise(r => setTimeout(r, 150));
  const l = app.state.layout.container.outer;
  const warned = {
    w: Math.max(...l.map(p => p.x)) - Math.min(...l.map(p => p.x)),
    h: Math.max(...l.map(p => p.y)) - Math.min(...l.map(p => p.y)),
    info: document.getElementById('layScaleInfo').textContent,
    cls: document.getElementById('layScaleInfo').className,
  };
  // Both axes measured and under two percent apart is warp, not a mistake:
  // 210 across and 107 down is x1.05 against x1.07, 1.9 percent.
  app.state.layout.container.outer = [{ x: 5, y: 5 }, { x: 205, y: 5 }, { x: 205, y: 105 }, { x: 5, y: 105 }];
  app.state.layout.container.scale = { x: 1, y: 1 };
  set('layKnownW', '210');
  set('layKnownD', '107');
  await new Promise(r => setTimeout(r, 150));
  return {
    warned,
    edge: document.getElementById('layScaleInfo').className,
    edgeScale: { ...app.state.layout.container.scale },
  };
});

check('a 5 percent by 20 percent correction is warned about, a 2 percent one is not',
  Math.abs(knownWarn.warned.w - 210) < 1e-6 && Math.abs(knownWarn.warned.h - 120) < 1e-6 &&
  knownWarn.warned.cls === 'warn' && /differ by 12\.5 percent/.test(knownWarn.warned.info) &&
  knownWarn.edge === 'hint' && knownWarn.edgeScale.x === 1.05 && knownWarn.edgeScale.y === 1.07,
  `${knownWarn.warned.cls}: ${knownWarn.warned.info.slice(0, 90)} / edge ${knownWarn.edge} at ${JSON.stringify(knownWarn.edgeScale)}`);

// The measured scale is an additive save-format field, and the fields belong
// to a traced outline: a rectangular container already is its measurements.
const knownSave = await page.evaluate(async () => {
  const app = window.__app;
  app.state.layout.container = {
    ...app.state.layout.container, type: 'outline', name: 'bench drawer',
    outer: [{ x: 5, y: 5 }, { x: 215, y: 5 }, { x: 215, y: 110 }, { x: 5, y: 110 }],
    scale: { x: 1.05, y: 1.05 },
  };
  const saved = JSON.parse(app.serializeProject(false));
  const legacy = JSON.parse(app.serializeProject(false));
  delete legacy.layout.container.scale;
  await app.loadProject(saved);
  const back = { ...app.state.layout.container.scale };
  await app.loadProject(legacy);
  const old = { ...app.state.layout.container.scale };
  // A rectangle measures itself; the two fields have nothing to add.
  const sel = document.getElementById('layContainerSel');
  sel.value = 'rect'; sel.dispatchEvent(new Event('change'));
  await new Promise(r => setTimeout(r, 150));
  return {
    back, old, hiddenForRect: document.getElementById('layKnownFields').hidden,
    cleared: { ...app.state.layout.container.scale },
    info: document.getElementById('layScaleInfo').textContent,
  };
});

check('the measured scale round-trips, defaults to 1 : 1 in an older project, and is hidden for a rectangle',
  knownSave.back.x === 1.05 && knownSave.back.y === 1.05 &&
  knownSave.old.x === 1 && knownSave.old.y === 1 &&
  knownSave.hiddenForRect && knownSave.cleared.x === 1 && knownSave.info === '',
  `back ${JSON.stringify(knownSave.back)}, legacy ${JSON.stringify(knownSave.old)}, hidden ${knownSave.hiddenForRect}`);

// A hand-edited or third-party-written project can carry a scale factor that
// is not a number. That is not a measurement, so it loads as 1 : 1 per axis
// rather than throwing Step 4 open half-built.
const scaleBad = await page.evaluate(async () => {
  const app = window.__app;
  app.state.layout.items.length = 0;
  app.state.layout.container = {
    ...app.state.layout.container, type: 'outline', name: 'bench drawer',
    outer: [{ x: 5, y: 5 }, { x: 205, y: 5 }, { x: 205, y: 105 }, { x: 5, y: 105 }],
    scale: { x: 1, y: 2 },
  };
  const clean = JSON.parse(app.serializeProject(false));
  const open4 = async () => {
    let threw = null;
    try {
      app.goStep(3);
      await new Promise(r => setTimeout(r, 200));
      app.goStep(4);
      await new Promise(r => setTimeout(r, 250));
    } catch (e) { threw = String(e); }
    return {
      threw, scale: { ...app.state.layout.container.scale },
      hidden: document.getElementById('layoutModal').hidden,
      info: document.getElementById('layoutInfo').textContent,
      scaleInfo: document.getElementById('layScaleInfo').textContent,
    };
  };
  const load = async scale => {
    const p = JSON.parse(JSON.stringify(clean));
    p.layout.container.scale = scale;
    await app.loadProject(p);
    return open4();
  };
  return {
    text: await load({ x: '2', y: 2 }),
    nul: await load({ x: null, y: 2 }),
    good: await load({ x: 1.05, y: 2 }),
  };
});

check('a project whose container scale is not a number loads as 1 : 1 and still opens Step 4',
  scaleBad.text.threw === null && scaleBad.text.scale.x === 1 && scaleBad.text.scale.y === 2 &&
  scaleBad.text.hidden === false && /Container/.test(scaleBad.text.info) &&
  /×1\.000 across and ×2\.000 down/.test(scaleBad.text.scaleInfo) &&
  scaleBad.nul.threw === null && scaleBad.nul.scale.x === 1 && scaleBad.nul.scale.y === 2 &&
  scaleBad.nul.hidden === false && /Container/.test(scaleBad.nul.info) &&
  scaleBad.good.scale.x === 1.05 && scaleBad.good.scale.y === 2 && scaleBad.good.hidden === false,
  `string ${JSON.stringify(scaleBad.text.scale)} threw ${scaleBad.text.threw}, null ${JSON.stringify(scaleBad.nul.scale)} threw ${scaleBad.nul.threw}, good ${JSON.stringify(scaleBad.good.scale)}`);

// A nudged plate pads the tiling window, and to the seam scorer that pad is
// ordinary material: a seam can land inside it, leaving a leading cell with no
// drawer in it at all. splitTiles drops that tile, so the grid the plan reports
// has to drop it too. It used to keep it, and a four-tile plan called itself
// 2 × 3, named its file -tiles-2x3.svg and lettered its pieces from B.
const tilePad = await page.evaluate(async () => {
  const app = window.__app;
  app.goStep(4);
  await new Promise(r => setTimeout(r, 200));
  const bedBefore = JSON.stringify(app.state.layout.bed);
  app.state.layout.bed.shape = null;
  app.state.layout.bed.preset = 'custom';
  app.state.layout.bed.w = 300; app.state.layout.bed.h = 200;
  const tool = (name, x, y) => ({
    name, outer: [{ x: 5, y: 5 }, { x: 205, y: 5 }, { x: 205, y: 35 }, { x: 5, y: 35 }],
    holes: [], circles: [], x, y, rot: 0, depth: 4, thickness: 5,
  });
  const at = async (w, h, off, tools) => {
    app.state.layout.container = { ...app.state.layout.container, type: 'rect', w, h, r: 6, name: null };
    app.state.layout.items.length = 0;
    for (const t of tools) app.state.layout.items.push(t);
    app.state.layout.bed.offset = { ...off };
    app.refreshLayoutEditor();
    const plan = app.bed.plan();
    const out = app.layoutExports.svg('auto');
    const svg = out ? await out.blob.text() : '';
    return {
      nx: plan.nx, ny: plan.ny, tiles: plan.tiles.length,
      cols: [...new Set(plan.tiles.map(t => t.col))].sort((a, b) => a - b).join(','),
      rows: [...new Set(plan.tiles.map(t => t.row))].sort((a, b) => a - b).join(','),
      seams: `${plan.seamsX.length}/${plan.seamsY.length}`,
      info: document.getElementById('layBedInfo').textContent,
      name: out ? out.name : null,
      ids: (svg.match(/>[A-Z]\d+ /g) || []).map(s => s.slice(1).trim()).join(','),
      cuts: (svg.match(/<path transform/g) || []).length,
    };
  };
  const deep = [tool('rasp', 150, 60), tool('file', 150, 140)];
  const down0 = await at(550, 380, { x: 0, y: 0 }, deep);
  const down30 = await at(550, 380, { x: 0, y: 30 }, deep);
  const across0 = await at(400, 100, { x: 0, y: 0 }, [tool('rule', 120, 50)]);
  const across250 = await at(400, 100, { x: 250, y: 0 }, [tool('rule', 120, 50)]);
  app.state.layout.bed = JSON.parse(bedBefore);
  app.state.layout.items.length = 0;
  app.refreshLayoutEditor();
  return { down0, down30, across0, across250 };
});

// Every consumer of the grid — the readout, the download name and the A1/B2
// tile ids the exporter letters from the row — has to describe the tiles the
// file actually carries.
const gridHolds = p => !!p && p.tiles > 0 &&
  p.cols.split(',').length === p.nx && p.rows.split(',').length === p.ny &&
  p.cols.split(',')[0] === '0' && p.rows.split(',')[0] === '0' &&
  p.tiles <= p.nx * p.ny && p.seams === `${p.nx - 1}/${p.ny - 1}` &&
  p.info.includes(`${p.tiles} tiles (${p.nx} × ${p.ny})`) &&
  p.name.endsWith(`-drawer-tiles-${p.nx}x${p.ny}.svg`) &&
  p.ids.split(',').length === p.tiles && p.ids.split(',').includes('A1') &&
  p.cuts === p.tiles;

check('a nudged plate never reports a tile row or column the exported file does not hold',
  gridHolds(tilePad.down0) && gridHolds(tilePad.down30) &&
  gridHolds(tilePad.across0) && gridHolds(tilePad.across250) &&
  tilePad.down0.tiles === 4 && tilePad.down30.tiles === 4 && tilePad.across250.tiles === 2,
  `y+0 ${tilePad.down0.tiles} tiles ${tilePad.down0.nx}x${tilePad.down0.ny} ids ${tilePad.down0.ids}, ` +
  `y+30 ${tilePad.down30.tiles} tiles ${tilePad.down30.nx}x${tilePad.down30.ny} ids ${tilePad.down30.ids} ${tilePad.down30.name}, ` +
  `x+250 ${tilePad.across250.tiles} tiles ${tilePad.across250.nx}x${tilePad.across250.ny} ids ${tilePad.across250.ids} ${tilePad.across250.name}`);

// The plate outline is grabbed anywhere along its edge, but once a layout has
// to be tiled that edge runs straight through the drawer. A tool on the seam
// has to stay selectable and draggable: the press used to go to the plate,
// which deselected the tool, closed its panel and wrote a plate offset the
// tiler discards.
const seamTool = await page.evaluate(async () => {
  const app = window.__app, ed = app.layoutEditor;
  const bedBefore = JSON.stringify(app.state.layout.bed);
  app.state.layout.bed.shape = null;
  app.state.layout.bed.preset = 'custom';
  app.state.layout.bed.w = 300; app.state.layout.bed.h = 200;
  app.state.layout.bed.offset = { x: 0, y: 0 };
  app.state.layout.container = { ...app.state.layout.container, type: 'rect', w: 400, h: 300, r: 6, name: null };
  app.state.layout.items.length = 0;
  ed.sel = -1; ed.bedSel = false;
  app.refreshLayoutEditor();
  await new Promise(r => setTimeout(r, 200));
  const plate = app.bed.loop();
  const edgeX = Math.max(...plate.map(p => p.x));
  // An 8 mm tool straddling the plate's right edge, which for a 400 × 300
  // drawer on a 300 × 200 plate is a seam down the middle of the drawer.
  app.state.layout.items.push({
    name: 'drill bit', outer: [{ x: 0, y: 0 }, { x: 8, y: 0 }, { x: 8, y: 8 }, { x: 0, y: 8 }],
    holes: [], circles: [], x: edgeX, y: 105, rot: 0, depth: 4, thickness: 5,
  });
  app.refreshLayoutEditor();
  const cv = ed.canvas, r = cv.getBoundingClientRect();
  const client = mm => {
    const s = ed.mmToScreen(mm);
    return { x: r.left + s.x * (r.width / cv.width), y: r.top + s.y * (r.height / cv.height) };
  };
  const cap = cv.setPointerCapture, rel = cv.releasePointerCapture;
  cv.setPointerCapture = () => {}; cv.releasePointerCapture = () => {};
  const ev = (type, p) => cv.dispatchEvent(new PointerEvent(type, {
    clientX: p.x, clientY: p.y, pointerId: 1, bubbles: true,
  }));
  ev('pointerdown', client({ x: edgeX, y: 105 }));
  const picked = { sel: ed.sel, bedSel: ed.bedSel, kind: ed._drag && ed._drag.kind };
  ev('pointermove', client({ x: edgeX + 20, y: 105 }));
  ev('pointerup', client({ x: edgeX + 20, y: 105 }));
  await new Promise(r2 => setTimeout(r2, 150));
  const after = {
    x: app.state.layout.items[0].x, off: app.bed.offset(),
    panel: !document.getElementById('laySelPanel').hidden,
  };
  // The same edge, clear of the tool, still belongs to the plate.
  ev('pointerdown', client({ x: edgeX, y: 20 }));
  const onPlate = { sel: ed.sel, bedSel: ed.bedSel, kind: ed._drag && ed._drag.kind };
  ev('pointerup', client({ x: edgeX, y: 20 }));
  cv.setPointerCapture = cap; cv.releasePointerCapture = rel;
  app.state.layout.items.length = 0;
  app.state.layout.bed = JSON.parse(bedBefore);
  ed.sel = -1; ed.bedSel = false;
  app.syncLaySelPanel(-1);
  app.refreshLayoutEditor();
  return { picked, after, onPlate, edgeX };
});

check('a tool sitting on a seam is picked and dragged, not the plate under it',
  seamTool.picked.sel === 0 && seamTool.picked.bedSel === false && seamTool.picked.kind === 'move' &&
  Math.abs(seamTool.after.x - (seamTool.edgeX + 20)) < 1.5 &&
  seamTool.after.off.x === 0 && seamTool.after.off.y === 0 && seamTool.after.panel &&
  seamTool.onPlate.bedSel === true && seamTool.onPlate.sel === -1 && seamTool.onPlate.kind === 'bed',
  `press ${JSON.stringify(seamTool.picked)}, tool x ${seamTool.after.x} offset ${JSON.stringify(seamTool.after.off)}, plate ${JSON.stringify(seamTool.onPlate)}`);

// Past 4 MB the photos come out of the WHOLE library, not just the entry being
// saved, and for a row saved from a live trace that was the only copy. So the
// save handler offers the trim and the user can decline: Cancel keeps every
// photo that is already stored.
const libConsent = await page.evaluate(async () => {
  const app = window.__app;
  const rect = (x, y, w, h) => [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];
  const libBefore = localStorage.getItem('2p5d.library.v1');
  const rectBefore = app.state.rect;
  const traceBefore = app.traceEditor.getTrace();
  // A library the app itself would have written: five photographed tools, each
  // save under the line until this one pushes the total over it.
  const thumb = () => ({
    dataUrl: 'data:image/jpeg;base64,' + 'A'.repeat(850 * 1024), mmPerPx: 0.25, origin: { x: 5, y: 5 },
  });
  const seed = () => localStorage.setItem('2p5d.library.v1', JSON.stringify(
    ['one', 'two', 'three', 'four', 'five'].map(n => ({
      name: n, kind: 'tool', thickness: 5, outer: rect(5, 5, 40, 20),
      holes: [], circles: [], thumb: thumb(),
    }))));
  // The new outline carries no photo of its own, so every byte it costs the
  // library is outline, and every photo it would destroy is somebody else's.
  app.state.rect = null;
  app.traceEditor.setTrace(rect(20, 30, 60, 30), []);
  document.getElementById('libName').value = 'one more';
  document.getElementById('libKind').value = 'tool';
  const realConfirm = window.confirm;
  const run = answer => {
    seed();
    let asked = 0, text = '';
    window.confirm = msg => { asked++; text = String(msg); return answer; };
    document.getElementById('libSaveBtn').click();
    const list = JSON.parse(localStorage.getItem('2p5d.library.v1') || '[]');
    return {
      asked, text, n: list.length,
      photos: list.filter(o => o.thumb).length,
      saved: list.some(o => o.name === 'one more'),
    };
  };
  const declined = run(false);
  const accepted = run(true);
  window.confirm = realConfirm;
  app.traceEditor.setTrace(traceBefore.outer, traceBefore.holes);
  app.traceEditor.setCircles(traceBefore.circles);
  app.state.rect = rectBefore;
  if (libBefore === null) localStorage.removeItem('2p5d.library.v1');
  else localStorage.setItem('2p5d.library.v1', libBefore);
  app.palette.refresh();
  return { declined, accepted };
});

check('a library past 4 MB is offered the trim, and declining keeps every photo it holds',
  libConsent.declined.asked === 1 && libConsent.declined.photos === 5 &&
  libConsent.declined.n === 6 && libConsent.declined.saved &&
  /all 5 entries/.test(libConsent.declined.text) && /cannot be undone/.test(libConsent.declined.text) &&
  libConsent.accepted.asked === 1 && libConsent.accepted.photos === 0 &&
  libConsent.accepted.n === 6 && libConsent.accepted.saved,
  `declined: asked ${libConsent.declined.asked}, ${libConsent.declined.photos} photos of 5 kept, ` +
  `${libConsent.declined.n} rows; accepted: ${libConsent.accepted.photos} photos, ${libConsent.accepted.n} rows`);

// A folder that reads as nothing still has to show that it opened: "Save here"
// lives inside the folder group, so hiding the group puts the folder
// write-back out of reach for exactly the fresh folder a new drawer belongs in.
const emptyFolder = await page.evaluate(async () => {
  const app = window.__app;
  app.goStep(4);
  await new Promise(r => setTimeout(r, 200));
  const dir = {
    kind: 'directory', name: 'new-project', children: [],
    values: async function* () {},
    queryPermission: async () => 'granted',
    requestPermission: async () => 'granted',
    getFileHandle: async () => ({
      createWritable: async () => ({ write: async () => {}, close: async () => {} }),
    }),
  };
  Object.defineProperty(window, 'showDirectoryPicker', { value: async () => dir, configurable: true });
  document.getElementById('layOpenFolderBtn').click();
  await new Promise(r => setTimeout(r, 400));
  const group = document.getElementById('layPalFolderGroup');
  const save = document.getElementById('layPalSaveFolderBtn');
  const out = {
    shown: !group.hidden,
    label: document.getElementById('layPalFolderName').textContent,
    says: document.getElementById('layPalFolderList').textContent,
    saveShown: !save.hidden && save.offsetParent !== null,
    handled: app.folderBackend.handle === dir,
  };
  // Closing the folder still empties the group.
  app.palette.setFolder({ entries: [], skipped: [] }, '');
  out.closed = group.hidden;
  app.folderBackend.forget();
  delete window.showDirectoryPicker;
  app.refreshLayoutEditor();
  return out;
});

check('an opened folder with nothing readable in it says so, and keeps “Save here” reachable',
  emptyFolder.shown && emptyFolder.label === 'new-project' && emptyFolder.handled &&
  /empty/.test(emptyFolder.says) && emptyFolder.saveShown && emptyFolder.closed,
  `shown ${emptyFolder.shown} as “${emptyFolder.label}”, save reachable ${emptyFolder.saveShown}, says “${emptyFolder.says}”, closed ${emptyFolder.closed}`);

// Leave the container as the blocks after this one expect it.
await page.evaluate(async () => {
  const app = window.__app;
  app.state.layout.container = {
    ...app.state.layout.container, type: 'rect', w: 220, h: 140, r: 6,
    name: null, outer: null, scale: { x: 1, y: 1 },
  };
  app.state.layout.items.length = 0;
  app.refreshLayoutEditor();
  app.goStep(3);
  await new Promise(r => setTimeout(r, 300));
});

// ---------- batch ingest: the photo queue (Part A) ----------
// Everything this lane adds lives in this one contiguous block, and it puts
// the page back the way it found it before the blocks below run.

const queueOne = await page.evaluate(async () => {
  const app = window.__app;
  // A photo that looks like the real thing: a white sheet on a dark ground with
  // an object on it, so the corner auto-detect on load behaves as it would for
  // a user rather than falling over on a flat colour.
  const photoFile = async (name, w, h) => {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const g = c.getContext('2d');
    g.fillStyle = '#2a2a2a'; g.fillRect(0, 0, w, h);
    g.fillStyle = '#f2f2f0'; g.fillRect(w * 0.08, h * 0.08, w * 0.84, h * 0.84);
    g.fillStyle = '#303030'; g.fillRect(w * 0.3, h * 0.3, w * 0.35, h * 0.3);
    const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.85));
    const f = new File([blob], String(name).split('/').pop(), { type: 'image/jpeg' });
    if (String(name).includes('/')) {
      Object.defineProperty(f, 'webkitRelativePath', { value: name });
    }
    return f;
  };
  const dims = dataUrl => new Promise(r => {
    if (!dataUrl) { r(null); return; }
    const im = new Image();
    im.onload = () => r({ w: im.naturalWidth, h: im.naturalHeight });
    im.onerror = () => r(null);
    im.src = dataUrl;
  });

  // Everything Step 1 owns, so the blocks after this one get it all back.
  const before = {
    image: app.state.image,
    rect: app.state.rect,
    rectDirty: app.state.rectDirty,
    corners: app.state.corners && app.state.corners.map(p => ({ x: p.x, y: p.y })),
    fileName: app.state.fileName,
    orient: app.state.paper.orientation,
    label: document.getElementById('fileLabelText').textContent,
    step: app.state.step,
  };

  app.queue.clear();
  const files = [
    await photoFile('hammer.jpg', 600, 450),
    await photoFile('round rasp.jpg', 450, 600),
    await photoFile('vise grips.jpg', 500, 500),
  ];
  const added = await app.queue.add(files);
  const items = app.state.queue;

  const strip = document.getElementById('queueStrip');
  const body = document.getElementById('queueBody');
  const tiles = () => Array.from(document.querySelectorAll('#queueList .queue-item'));

  const ingest = {
    addedN: added.length,
    n: items.length,
    names: items.map(q => q.name),
    paths: items.map(q => q.path),
    statuses: items.map(q => q.status),
    picked: items.filter(q => q.picked).length,
    ids: items.map(q => q.id),
    uniqueIds: new Set(items.map(q => q.id)).size,
    thumbs: items.filter(q => typeof q.thumb === 'string' && /^data:image\//.test(q.thumb)).length,
    holdsFile: items.every(q => q.file instanceof File),
    // Memory: a queue item never holds a decoded image, only a File handle and
    // a small data URL.
    noDecoded: items.every(q => !(q.thumb instanceof Image) && q.thumb !== app.state.image),
  };
  // 160 px thumbnails, per the PRD's memory constraint.
  const sizes = await Promise.all(items.map(q => dims(q.thumb)));
  ingest.thumbMax = Math.max(...sizes.map(d => (d ? Math.max(d.w, d.h) : 0)));
  ingest.thumbBytes = items.reduce((a, q) => a + (q.thumb ? q.thumb.length : 0), 0);

  // The strip: a tile per photo, each with a tick box and a status badge.
  const strip1 = {
    shown: !strip.hidden,
    tiles: tiles().length,
    boxes: document.querySelectorAll('#queueList .queue-pick').length,
    checked: tiles().filter(t => t.querySelector('.queue-pick').checked).length,
    badges: tiles().map(t => t.querySelector('.queue-badge').textContent),
    labels: tiles().map(t => t.querySelector('.queue-name').textContent),
    count: document.getElementById('queueCount').textContent,
  };

  // Re-adding the same three photos is a no-op: paths are the identity.
  const again = await app.queue.add(files);
  const dedupe = { added: again.length, n: app.state.queue.length };

  // HEIC joins the queue but cannot be traced: marked unsupported, unticked,
  // and its box disabled so Select all cannot arm it.
  const heic = new File(['not really an image'], 'clamp.heic', { type: '' });
  await app.queue.add([heic]);
  const heicItem = app.state.queue.find(q => q.name === 'clamp');
  const unsupported = {
    status: heicItem && heicItem.status,
    picked: heicItem && heicItem.picked,
    boxDisabled: !!document.querySelector('#queueList .queue-item[data-status="unsupported"] .queue-pick').disabled,
  };

  // Select all is a toggle, and it never arms the unsupported photo.
  const selBtn = document.getElementById('queueSelectAllBtn');
  const selectAll = { startLabel: selBtn.textContent };
  selBtn.click();                       // all three already ticked -> clear
  selectAll.afterClear = app.state.queue.filter(q => q.picked).length;
  selectAll.clearLabel = selBtn.textContent;
  selBtn.click();                       // -> tick every traceable photo
  selectAll.afterAll = app.state.queue.filter(q => q.picked).length;
  selectAll.heicStillOff = !app.state.queue.find(q => q.name === 'clamp').picked;

  // Untick one by hand through its own box, the way a user chooses.
  const hammer = tiles().find(t => t.dataset.name === 'hammer');
  const box = hammer.querySelector('.queue-pick');
  box.checked = false;
  box.dispatchEvent(new Event('change', { bubbles: true }));
  selectAll.afterHandUntick = app.state.queue.filter(q => q.picked).length;
  // The walk starts at the first ticked pending photo, so an unticked one is
  // passed over rather than traced.
  selectAll.nextSkipsUnticked = !!app.queue.next(null) &&
    app.queue.next(null).name === 'round rasp';

  // Clear done drops the traced and the skipped and keeps the rest.
  app.state.queue[0].status = 'traced';
  app.state.queue[1].status = 'skipped';
  app.queue.render();
  const doneBadges = tiles().map(t => t.dataset.status);
  document.getElementById('queueClearDoneBtn').click();
  const cleared = {
    badges: doneBadges,
    left: app.state.queue.map(q => q.name),
    tiles: tiles().length,
  };

  // Clicking a thumbnail loads that photo into Step 1.
  app.goStep(3);
  const vise = tiles().find(t => t.dataset.name === 'vise grips');
  vise.click();
  await new Promise(r => setTimeout(r, 600));
  const loaded = {
    step: app.state.step,
    fileName: app.state.fileName,
    label: document.getElementById('fileLabelText').textContent,
    currentId: app.state.queueCurrentId,
    marked: app.state.queueCurrentId ===
      app.state.queue.find(q => q.name === 'vise grips').id,
    swapped: app.state.image !== before.image,
    wide: app.state.image ? app.state.image.naturalWidth : 0,
  };

  // Visible on Steps 1 to 3, collapsed on Step 4.
  const visible = {};
  app.goStep(1); visible.s1 = { shown: !strip.hidden, open: !body.hidden };
  app.goStep(3); visible.s3 = { shown: !strip.hidden, open: !body.hidden };
  app.goStep(4);
  await new Promise(r => setTimeout(r, 200));
  visible.s4 = { shown: !strip.hidden, open: !body.hidden };
  document.getElementById('queueToggle').click();   // the toggle still wins
  visible.s4open = !body.hidden;
  app.goStep(3);
  visible.backTo3 = !body.hidden;

  // Drag and drop: several loose files, and a folder, both append. The folder
  // arrives as a FileSystemEntry tree, exactly as a real drop delivers it.
  app.queue.clear();
  const fileEntry = (name, file) => ({
    isFile: true, isDirectory: false, name,
    file: cb => cb(file),
  });
  const dirEntry = (name, kids) => ({
    isFile: false, isDirectory: true, name,
    createReader: () => {
      let sent = false;
      // readEntries signals the end of the directory with an empty batch.
      return { readEntries: cb => { const batch = sent ? [] : kids; sent = true; cb(batch); } };
    },
  });
  const loose = [await photoFile('awl.jpg', 300, 240), await photoFile('file.jpg', 240, 300)];
  await app.queue.drop([], loose);
  const dropLoose = app.state.queue.map(q => q.path);

  const tree = dirEntry('drawer', [
    fileEntry('spanner.jpg', await photoFile('spanner.jpg', 320, 240)),
    fileEntry('readme.txt', new File(['hi'], 'readme.txt', { type: 'text/plain' })),
    dirEntry('deep', [fileEntry('chisel.jpg', await photoFile('chisel.jpg', 260, 200))]),
  ]);
  const pairs = await app.queue.dropPairs([tree], []);
  await app.queue.drop([tree], []);
  const dropFolder = {
    pairs: pairs.map(p => p.path),
    queued: app.state.queue.map(q => q.path),
  };

  // Two different photos that happen to share a file name are two photos. A
  // plain multi-select and a drop of loose files carry no relative path, so
  // the bare name is all the queue gets; the file behind it is what tells
  // them apart, and the second tool must not vanish as a "duplicate".
  app.queue.clear();
  const twinA = await photoFile('wrench.jpg', 300, 240);
  const twinB = await photoFile('wrench.jpg', 460, 360);
  const twinFirst = await app.queue.add([twinA]);
  const twinSecond = await app.queue.add([twinB]);
  const twins = {
    first: twinFirst.length,
    second: twinSecond.length,
    n: app.state.queue.length,
    paths: app.state.queue.map(q => q.path),
    sizes: app.state.queue.map(q => q.file.size),
    distinct: twinA.size !== twinB.size,
    // Re-adding a photo already queued is still a no-op.
    again: (await app.queue.add([twinB])).length,
    nAfter: app.state.queue.length,
  };

  // One sibling project is one traced photo. With two same-named photos in the
  // queue it must retire the first and leave the second to be traced by hand.
  const twinProject = JSON.stringify({
    app: '2.5D', version: 1, fileName: 'wrench',
    regions: [{ thickness: 6 }],
    trace: { outer: [{ x: 5, y: 5 }, { x: 45, y: 5 }, { x: 45, y: 25 }, { x: 5, y: 25 }], holes: [], circles: [] },
  });
  const twinResumed = await app.queue.resume([{
    path: 'wrench.json',
    file: new File([twinProject], 'wrench.json', { type: 'application/json' }),
  }]);
  const twinResume = {
    resumed: twinResumed,
    statuses: app.state.queue.map(q => q.status),
    picked: app.state.queue.map(q => q.picked),
  };

  // Put Step 1 and the queue back for the blocks below.
  app.queue.clear();
  app.state.image = before.image;
  app.state.rect = before.rect;
  app.state.rectDirty = before.rectDirty;
  app.state.corners = before.corners;
  app.state.fileName = before.fileName;
  app.state.paper.orientation = before.orient;
  document.getElementById('paperOrient').value = before.orient;
  document.getElementById('fileLabelText').textContent = before.label;
  app.cornerEditor.setImage(before.image);
  if (before.corners) app.cornerEditor.setCorners(before.corners);
  app.goStep(before.step);
  await new Promise(r => setTimeout(r, 300));
  const restored = {
    step: app.state.step,
    image: app.state.image === before.image,
    stripHidden: strip.hidden,
    queue: app.state.queue.length,
  };

  return { ingest, strip1, dedupe, unsupported, selectAll, cleared, loaded, visible, dropLoose, dropFolder, twins, twinResume, restored };
});

check('three photos ingest as three pending queue items named from their files',
  queueOne.ingest.addedN === 3 && queueOne.ingest.n === 3 &&
  JSON.stringify(queueOne.ingest.names) === JSON.stringify(['hammer', 'round rasp', 'vise grips']) &&
  JSON.stringify(queueOne.ingest.paths) === JSON.stringify(['hammer.jpg', 'round rasp.jpg', 'vise grips.jpg']) &&
  queueOne.ingest.statuses.every(s => s === 'pending') && queueOne.ingest.picked === 3 &&
  queueOne.ingest.uniqueIds === 3 && queueOne.ingest.holdsFile,
  `${queueOne.ingest.n} items ${JSON.stringify(queueOne.ingest.names)} as ${JSON.stringify(queueOne.ingest.statuses)}, ids ${JSON.stringify(queueOne.ingest.ids)}`);

check('every queue item carries a 160 px thumbnail and no decoded photo',
  queueOne.ingest.thumbs === 3 && queueOne.ingest.thumbMax > 0 &&
  queueOne.ingest.thumbMax <= 160 && queueOne.ingest.noDecoded &&
  queueOne.ingest.thumbBytes < 3 * 40000,
  `${queueOne.ingest.thumbs} thumbs, longest side ${queueOne.ingest.thumbMax} px, ${queueOne.ingest.thumbBytes} data-URL bytes`);

check('the strip shows a ticked tile per photo with a status badge and a count',
  queueOne.strip1.shown && queueOne.strip1.tiles === 3 && queueOne.strip1.boxes === 3 &&
  queueOne.strip1.checked === 3 &&
  queueOne.strip1.badges.every(b => b === 'pending') &&
  JSON.stringify(queueOne.strip1.labels) === JSON.stringify(['hammer', 'round rasp', 'vise grips']) &&
  /3 photos/.test(queueOne.strip1.count) && /3 ticked/.test(queueOne.strip1.count),
  `${queueOne.strip1.tiles} tiles, ${queueOne.strip1.checked} ticked, count “${queueOne.strip1.count}”`);

check('the same photo added twice is one queue item',
  queueOne.dedupe.added === 0 && queueOne.dedupe.n === 3,
  `re-add appended ${queueOne.dedupe.added}, queue still ${queueOne.dedupe.n}`);

check('two different photos sharing one bare file name are two queue items',
  queueOne.twins.distinct && queueOne.twins.first === 1 && queueOne.twins.second === 1 &&
  queueOne.twins.n === 2 &&
  JSON.stringify(queueOne.twins.paths) === JSON.stringify(['wrench.jpg', 'wrench.jpg']) &&
  queueOne.twins.sizes[0] !== queueOne.twins.sizes[1] &&
  queueOne.twins.again === 0 && queueOne.twins.nAfter === 2,
  `added ${queueOne.twins.first} then ${queueOne.twins.second}, queue ${queueOne.twins.n} ` +
  `holding ${JSON.stringify(queueOne.twins.sizes)} bytes; re-add appended ${queueOne.twins.again}`);

check('one sibling project marks one photo traced, not every photo of that name',
  queueOne.twinResume.resumed === 1 &&
  JSON.stringify(queueOne.twinResume.statuses) === JSON.stringify(['traced', 'pending']) &&
  JSON.stringify(queueOne.twinResume.picked) === JSON.stringify([false, true]),
  `resumed ${queueOne.twinResume.resumed}, statuses ${JSON.stringify(queueOne.twinResume.statuses)}`);

check('a HEIC photo is queued as unsupported and cannot be ticked',
  queueOne.unsupported.status === 'unsupported' && queueOne.unsupported.picked === false &&
  queueOne.unsupported.boxDisabled,
  `status ${queueOne.unsupported.status}, picked ${queueOne.unsupported.picked}, box disabled ${queueOne.unsupported.boxDisabled}`);

check('Select all toggles every traceable photo and leaves the unsupported one alone',
  queueOne.selectAll.startLabel === 'Select none' && queueOne.selectAll.afterClear === 0 &&
  queueOne.selectAll.clearLabel === 'Select all' && queueOne.selectAll.afterAll === 3 &&
  queueOne.selectAll.heicStillOff && queueOne.selectAll.afterHandUntick === 2 &&
  queueOne.selectAll.nextSkipsUnticked,
  `“${queueOne.selectAll.startLabel}” → ${queueOne.selectAll.afterClear} ticked → ${queueOne.selectAll.afterAll} ticked, ` +
  `hand-untick leaves ${queueOne.selectAll.afterHandUntick}`);

check('Clear done drops the traced and skipped photos and keeps the rest',
  JSON.stringify(queueOne.cleared.badges) === JSON.stringify(['traced', 'skipped', 'pending', 'unsupported']) &&
  JSON.stringify(queueOne.cleared.left) === JSON.stringify(['vise grips', 'clamp']) &&
  queueOne.cleared.tiles === 2,
  `${JSON.stringify(queueOne.cleared.badges)} → ${JSON.stringify(queueOne.cleared.left)}`);

check('clicking a queue thumbnail loads that photo into Step 1',
  queueOne.loaded.step === 1 && queueOne.loaded.fileName === 'vise grips' &&
  queueOne.loaded.label === 'vise grips.jpg' && queueOne.loaded.swapped &&
  queueOne.loaded.wide === 500 && queueOne.loaded.marked &&
  typeof queueOne.loaded.currentId === 'string',
  `step ${queueOne.loaded.step}, fileName “${queueOne.loaded.fileName}”, ${queueOne.loaded.wide} px wide, current ${queueOne.loaded.currentId}`);

check('the queue strip rides Steps 1 to 3 and collapses on Step 4',
  queueOne.visible.s1.shown && queueOne.visible.s1.open &&
  queueOne.visible.s3.shown && queueOne.visible.s3.open &&
  queueOne.visible.s4.shown && !queueOne.visible.s4.open &&
  queueOne.visible.s4open && queueOne.visible.backTo3,
  `step 1 open ${queueOne.visible.s1.open}, step 3 open ${queueOne.visible.s3.open}, ` +
  `step 4 open ${queueOne.visible.s4.open}, re-openable ${queueOne.visible.s4open}`);

check('dropping several photos, or a folder of them, appends to the queue',
  JSON.stringify(queueOne.dropLoose) === JSON.stringify(['awl.jpg', 'file.jpg']) &&
  JSON.stringify(queueOne.dropFolder.pairs) ===
    JSON.stringify(['drawer/deep/chisel.jpg', 'drawer/readme.txt', 'drawer/spanner.jpg']) &&
  JSON.stringify(queueOne.dropFolder.queued) ===
    JSON.stringify(['awl.jpg', 'file.jpg', 'drawer/deep/chisel.jpg', 'drawer/spanner.jpg']),
  `loose ${JSON.stringify(queueOne.dropLoose)}, folder pairs ${JSON.stringify(queueOne.dropFolder.pairs)}, ` +
  `queued ${JSON.stringify(queueOne.dropFolder.queued)}`);

check('the queue block leaves Step 1 and the strip as it found them',
  queueOne.restored.image && queueOne.restored.queue === 0 &&
  queueOne.restored.stripHidden && queueOne.restored.step === 3,
  `step ${queueOne.restored.step}, photo restored ${queueOne.restored.image}, strip hidden ${queueOne.restored.stripHidden}`);

// Folder ingest: the photos go to the queue, the traces go to the palette, and
// a photo that already has its project JSON beside it resumes as traced.
const queueTwo = await page.evaluate(async () => {
  const app = window.__app;
  const photoFile = async (name, w, h) => {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const g = c.getContext('2d');
    g.fillStyle = '#2a2a2a'; g.fillRect(0, 0, w, h);
    g.fillStyle = '#f2f2f0'; g.fillRect(w * 0.08, h * 0.08, w * 0.84, h * 0.84);
    g.fillStyle = '#303030'; g.fillRect(w * 0.3, h * 0.3, w * 0.35, h * 0.3);
    const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.85));
    return new File([blob], String(name).split('/').pop(), { type: 'image/jpeg' });
  };
  const rect = (x, y, w, h) => [
    { x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h },
  ];
  // anvil.json is a 2.5D project, so anvil.jpg is already traced. rasp.json is
  // a library export, which is not a trace of rasp.jpg, so rasp.jpg is not.
  const anvilJson = JSON.stringify({
    app: '2.5D', version: 1, fileName: 'anvil',
    regions: [{ thickness: 8 }],
    trace: { outer: rect(20, 30, 70, 25), holes: [], circles: [] },
  });
  const raspJson = JSON.stringify([
    { name: 'rasp bench', kind: 'tool', thickness: 4, outer: rect(0, 0, 30, 30) },
  ]);

  const files = {
    'anvil.jpg': await photoFile('anvil.jpg', 400, 300),
    'anvil.json': new File([anvilJson], 'anvil.json', { type: 'application/json' }),
    'hammer.jpg': await photoFile('hammer.jpg', 360, 280),
    'notes.txt': new File(['bench notes'], 'notes.txt', { type: 'text/plain' }),
    'rasp.jpg': await photoFile('rasp.jpg', 300, 300),
    'rasp.json': new File([raspJson], 'rasp.json', { type: 'application/json' }),
    'chisel.jpg': await photoFile('chisel.jpg', 260, 200),
  };
  const fileHandle = name => ({ kind: 'file', name, getFile: async () => files[name] });
  const dirHandle = (name, children) => {
    const h = {
      kind: 'directory', name, children,
      values: async function* () { for (const c of h.children) yield c; },
      queryPermission: async () => 'granted',
      requestPermission: async () => 'granted',
      getFileHandle: async () => ({
        createWritable: async () => ({ write: async () => {}, close: async () => {} }),
      }),
    };
    return h;
  };
  // Deliberately unsorted: walkFolder's own sort is what makes the order fixed.
  const dir = dirHandle('drawer', [
    fileHandle('rasp.json'),
    dirHandle('sub', [fileHandle('chisel.jpg')]),
    fileHandle('hammer.jpg'),
    fileHandle('anvil.json'),
    fileHandle('notes.txt'),
    fileHandle('rasp.jpg'),
    fileHandle('anvil.jpg'),
  ]);

  app.queue.clear();
  // Through the real button, so the picker path is what is under test.
  Object.defineProperty(window, 'showDirectoryPicker', { value: async () => dir, configurable: true });
  document.getElementById('queueAddFolderBtn').click();
  for (let i = 0; i < 80 && app.state.queue.length < 4; i++) await new Promise(r => setTimeout(r, 50));
  await new Promise(r => setTimeout(r, 400));

  const picked = {
    paths: app.state.queue.map(q => q.path),
    names: app.state.queue.map(q => q.name),
    statuses: app.state.queue.map(q => q.status),
    picked: app.state.queue.map(q => q.picked),
    thumbs: app.state.queue.filter(q => typeof q.thumb === 'string').length,
    // The resumed photo's trace is in the palette, read out of its own JSON.
    palette: app.palette.folder.entries.map(e => e.name),
    paletteLabel: app.palette.folder.label,
    // The queue shares the Step 4 handle, so the per-photo project write and
    // "Save here" land in the same folder.
    handle: app.folderBackend.handle === dir,
    saveReachable: !document.getElementById('layPalSaveFolderBtn').hidden,
    tiles: Array.from(document.querySelectorAll('#queueList .queue-item')).map(t => t.dataset.status),
  };

  // Reopening the same folder rebuilds nothing twice: the photos are already
  // there, and the traced one stays traced.
  const again = await app.queue.ingestFolder(dir, 'drawer');
  const reopened = {
    added: again.added.length,
    n: app.state.queue.length,
    statuses: app.state.queue.map(q => q.status),
  };

  // The directory-input backend reads the very same folder flat, with no
  // handle, and must land on the same queue.
  app.queue.clear();
  app.folderBackend.forget();
  const flat = [
    'anvil.jpg', 'anvil.json', 'hammer.jpg', 'notes.txt', 'rasp.jpg', 'rasp.json',
  ].map(n => ({ path: `drawer/${n}`, file: files[n] }));
  flat.push({ path: 'drawer/sub/chisel.jpg', file: files['chisel.jpg'] });
  const gotFlat = await app.queue.ingestPairs(flat, 'drawer');
  const input = {
    paths: app.state.queue.map(q => q.path),
    statuses: app.state.queue.map(q => q.status),
    resumed: gotFlat.resumed,
    traces: gotFlat.traces,
    palette: app.palette.folder.entries.map(e => e.name),
    handle: app.folderBackend.handle,
    saveHidden: document.getElementById('layPalSaveFolderBtn').hidden,
    hasInput: !!document.getElementById('queueFolderInput').webkitdirectory,
  };

  // A folder with no JSON in it leaves the palette alone rather than blanking
  // whatever drawer is already loaded there.
  app.queue.clear();
  const kept = await app.queue.ingestPairs(
    [{ path: 'shed/awl.jpg', file: files['hammer.jpg'] }], 'shed');
  const untouched = {
    traces: kept.traces,
    palette: app.palette.folder.entries.map(e => e.name),
    label: app.palette.folder.label,
  };

  // Put the folder palette and the queue back.
  app.queue.clear();
  app.palette.setFolder({ entries: [], skipped: [] }, '');
  app.folderBackend.forget();
  delete window.showDirectoryPicker;
  app.refreshLayoutEditor();
  const restored = {
    queue: app.state.queue.length,
    palette: app.palette.folder.entries.length,
    group: document.getElementById('layPalFolderGroup').hidden,
    strip: document.getElementById('queueStrip').hidden,
    step: app.state.step,
  };
  return { picked, reopened, input, untouched, restored };
});

check('a picked folder queues every photo in it, deepest last, and skips the non-photos',
  JSON.stringify(queueTwo.picked.paths) === JSON.stringify(
    ['drawer/anvil.jpg', 'drawer/hammer.jpg', 'drawer/rasp.jpg', 'drawer/sub/chisel.jpg']) &&
  JSON.stringify(queueTwo.picked.names) === JSON.stringify(['anvil', 'hammer', 'rasp', 'chisel']) &&
  queueTwo.picked.thumbs === 4 && queueTwo.picked.tiles.length === 4,
  `${JSON.stringify(queueTwo.picked.paths)}, ${queueTwo.picked.thumbs} thumbs`);

check('a photo with a sibling 2.5D project resumes as traced, and its trace is in the palette',
  JSON.stringify(queueTwo.picked.statuses) === JSON.stringify(
    ['traced', 'pending', 'pending', 'pending']) &&
  JSON.stringify(queueTwo.picked.picked) === JSON.stringify([false, true, true, true]) &&
  JSON.stringify(queueTwo.picked.tiles) === JSON.stringify(
    ['traced', 'pending', 'pending', 'pending']) &&
  JSON.stringify(queueTwo.picked.palette) === JSON.stringify(['anvil', 'rasp bench']) &&
  queueTwo.picked.paletteLabel === 'drawer',
  `${JSON.stringify(queueTwo.picked.statuses)}, palette ${JSON.stringify(queueTwo.picked.palette)} from “${queueTwo.picked.paletteLabel}”`);

check('a sibling library export is not a trace of the photo, so that photo stays pending',
  queueTwo.picked.statuses[2] === 'pending' && queueTwo.picked.picked[2] === true,
  `rasp.jpg is ${queueTwo.picked.statuses[2]}, ticked ${queueTwo.picked.picked[2]}`);

check('the queue adopts the folder handle, so the project write and “Save here” share it',
  queueTwo.picked.handle && queueTwo.picked.saveReachable &&
  queueTwo.input.handle === null && queueTwo.input.saveHidden && queueTwo.input.hasInput,
  `picker handle ${queueTwo.picked.handle}, save reachable ${queueTwo.picked.saveReachable}; ` +
  `input handle ${queueTwo.input.handle}, save hidden ${queueTwo.input.saveHidden}`);

check('reopening the same folder adds nothing twice and keeps the traced photo traced',
  queueTwo.reopened.added === 0 && queueTwo.reopened.n === 4 &&
  JSON.stringify(queueTwo.reopened.statuses) === JSON.stringify(
    ['traced', 'pending', 'pending', 'pending']),
  `added ${queueTwo.reopened.added}, queue ${queueTwo.reopened.n}, ${JSON.stringify(queueTwo.reopened.statuses)}`);

check('the directory-input backend reads the same folder to the same queue, with no handle',
  JSON.stringify(queueTwo.input.paths) === JSON.stringify(
    ['drawer/anvil.jpg', 'drawer/hammer.jpg', 'drawer/rasp.jpg', 'drawer/sub/chisel.jpg']) &&
  JSON.stringify(queueTwo.input.statuses) === JSON.stringify(
    ['traced', 'pending', 'pending', 'pending']) &&
  queueTwo.input.resumed === 1 && queueTwo.input.traces === 2 &&
  JSON.stringify(queueTwo.input.palette) === JSON.stringify(['anvil', 'rasp bench']),
  `${JSON.stringify(queueTwo.input.statuses)}, ${queueTwo.input.resumed} resumed of ${queueTwo.input.traces} trace files`);

check('a folder of fresh photos leaves the loaded drawer palette alone',
  queueTwo.untouched.traces === 0 &&
  JSON.stringify(queueTwo.untouched.palette) === JSON.stringify(['anvil', 'rasp bench']) &&
  queueTwo.untouched.label === 'drawer',
  `${queueTwo.untouched.traces} trace files, palette still ${JSON.stringify(queueTwo.untouched.palette)}`);

check('the folder-ingest block hands the palette, the handle and the strip back empty',
  queueTwo.restored.queue === 0 && queueTwo.restored.palette === 0 &&
  queueTwo.restored.group && queueTwo.restored.strip && queueTwo.restored.step === 3,
  `queue ${queueTwo.restored.queue}, palette ${queueTwo.restored.palette}, group hidden ${queueTwo.restored.group}, step ${queueTwo.restored.step}`);

// The walk: Next saves under the photo's own name, writes the project beside
// the photo, and opens the next ticked one; Skip passes; Undo comes back.
const queueThree = await page.evaluate(async () => {
  const app = window.__app;
  const rect = (x, y, w, h) => [
    { x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h },
  ];
  const photoFile = async (name, w, h) => {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const g = c.getContext('2d');
    g.fillStyle = '#2a2a2a'; g.fillRect(0, 0, w, h);
    g.fillStyle = '#f2f2f0'; g.fillRect(w * 0.08, h * 0.08, w * 0.84, h * 0.84);
    g.fillStyle = '#303030'; g.fillRect(w * 0.3, h * 0.3, w * 0.35, h * 0.3);
    const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.85));
    return new File([blob], name, { type: 'image/jpeg' });
  };

  const before = {
    image: app.state.image,
    rect: app.state.rect,
    rectDirty: app.state.rectDirty,
    corners: app.state.corners && app.state.corners.map(p => ({ x: p.x, y: p.y })),
    fileName: app.state.fileName,
    orient: app.state.paper.orientation,
    label: document.getElementById('fileLabelText').textContent,
    step: app.state.step,
    trace: app.traceEditor.getTrace(),
    lib: localStorage.getItem('2p5d.library.v1'),
    ref: app.queue.snapshot(),
  };

  // A library that already holds a hammer, so the second photo's name collides.
  localStorage.setItem('2p5d.library.v1', JSON.stringify([
    { name: 'hammer', kind: 'tool', thickness: 5, outer: rect(5, 5, 40, 20), holes: [], circles: [] },
  ]));

  // A writable folder handle, the way the picker hands one over. Every write
  // records which directory it landed in, so "beside the photo" is checked and
  // not assumed.
  const files = {
    'awl.jpg': await photoFile('awl.jpg', 600, 450),
    'hammer.jpg': await photoFile('hammer.jpg', 400, 300),
    'rasp.jpg': await photoFile('rasp.jpg', 360, 280),
    'chisel.jpg': await photoFile('chisel.jpg', 320, 240),
  };
  const writes = [];
  const fileHandle = name => ({ kind: 'file', name, getFile: async () => files[name] });
  const mkDir = (name, children) => {
    const h = {
      kind: 'directory', name, children,
      values: async function* () { for (const c of h.children) yield c; },
      queryPermission: async () => 'granted',
      requestPermission: async () => 'granted',
      getDirectoryHandle: async n => {
        const kid = h.children.find(c => c.kind === 'directory' && c.name === n);
        if (!kid) throw new Error('no such folder');
        return kid;
      },
      getFileHandle: async n => ({
        createWritable: async () => ({
          write: async text => { writes.push({ dir: h.name, name: n, text: String(text) }); },
          close: async () => {},
        }),
      }),
    };
    return h;
  };
  const dir = mkDir('bench', [
    fileHandle('awl.jpg'), fileHandle('hammer.jpg'), fileHandle('rasp.jpg'),
    mkDir('sub', [fileHandle('chisel.jpg')]),
  ]);

  app.queue.clear();
  await app.queue.ingestFolder(dir, 'bench');
  const queued = app.state.queue.map(q => q.path);

  // Photo one, with reference settings a user would have set on it and a
  // fixture trace standing in for the Step 2 pass.
  app.queue.load(app.state.queue[0]);
  await new Promise(r => setTimeout(r, 700));
  app.state.reference = 'rect';
  app.state.captureFrac = 0.5;
  app.state.grid.nx = 7;
  app.state.bar.lengthMm = 123;
  document.getElementById('captureArea').value = '0.5';
  app.traceEditor.setTrace(rect(10, 10, 50, 25), []);
  const firstCorners = JSON.stringify(app.state.corners);
  const firstWide = app.state.image.naturalWidth;

  const nextOne = await app.queue.walk.next();
  await new Promise(r => setTimeout(r, 700));
  const afterOne = {
    saved: nextOne && nextOne.name,
    status: app.state.queue[0].status,
    picked: app.state.queue[0].picked,
    current: app.state.queueCurrentId === app.state.queue[1].id,
    nameField: document.getElementById('queueSaveName').value,
    fileName: app.state.fileName,
    wide: app.state.image.naturalWidth,
    // The carry-over: settings kept, corners re-detected on the new photo.
    reference: app.state.reference,
    captureFrac: app.state.captureFrac,
    captureField: document.getElementById('captureArea').value,
    nx: app.state.grid.nx,
    bar: app.state.bar.lengthMm,
    cornersMoved: JSON.stringify(app.state.corners) !== firstCorners,
    cornersInside: app.state.corners.every(p =>
      p.x <= app.state.image.naturalWidth && p.y <= app.state.image.naturalHeight),
    firstWide,
  };

  // The photo the walk just opened arrives untraced: the outline, the
  // rectified image and the diff map of the photo before it are gone, and
  // Next refuses until this photo has had its own Step 2 pass. A second click
  // on Next must never re-save the last photo's outline under this name.
  const stale = {
    outer: app.traceEditor.outer.length,
    circles: app.traceEditor.getTrace().circles.length,
    rect: app.state.rect,
    diffMap: app.state.diffMap,
    refused: await app.queue.walk.next(),
    libNames: JSON.parse(localStorage.getItem('2p5d.library.v1')).map(o => o.name),
    status: app.state.queue[1].status,
    stillCurrent: app.state.queueCurrentId === app.state.queue[1].id,
    writes: writes.length,
  };

  // Photo two is hammer.jpg, and the library already holds a "hammer".
  app.traceEditor.setTrace(rect(12, 12, 46, 24), []);
  const nextTwo = await app.queue.walk.next();
  await new Promise(r => setTimeout(r, 700));
  const collided = {
    saved: nextTwo && nextTwo.name,
    current: app.state.queueCurrentId === app.state.queue[2].id,
    libNames: JSON.parse(localStorage.getItem('2p5d.library.v1')).map(o => o.name),
  };

  // Photo three is skipped, so the walk lands on the one in the subfolder.
  const skipped = app.queue.walk.skip();
  await new Promise(r => setTimeout(r, 700));
  const afterSkip = {
    status: app.state.queue[2].status,
    picked: app.state.queue[2].picked,
    current: app.state.queueCurrentId === app.state.queue[3].id,
    fileName: app.state.fileName,
    libNames: JSON.parse(localStorage.getItem('2p5d.library.v1')).map(o => o.name),
    next: skipped && skipped.next === app.state.queue[3].id,
  };

  // The last ticked photo: its project goes into the subfolder it came from.
  app.traceEditor.setTrace(rect(8, 9, 44, 26), []);
  const nextFour = await app.queue.walk.next();
  await new Promise(r => setTimeout(r, 400));
  const written = writes.map(w => `${w.dir}/${w.name}`);
  const project = JSON.parse(writes[writes.length - 1].text);
  const lastOne = {
    saved: nextFour && nextFour.name,
    noNext: nextFour && nextFour.next === null,
    traced: app.queue.traced.map(t => t.name),
    projectApp: project.app,
    projectName: project.fileName,
    projectPhoto: project.photo,
    projectOuter: project.trace.outer.length,
    undoShown: !document.getElementById('queueUndoBtn').hidden,
  };

  // Undo comes back to the photo just finished, pending and ticked again.
  app.queue.walk.undo();
  await new Promise(r => setTimeout(r, 700));
  const undone = {
    status: app.state.queue[3].status,
    picked: app.state.queue[3].picked,
    current: app.state.queueCurrentId === app.state.queue[3].id,
    fileName: app.state.fileName,
    traced: app.queue.traced.map(t => t.name),
    undoHidden: document.getElementById('queueUndoBtn').hidden,
    // The library entry stays: the trace is saved work, not a draft.
    libNames: JSON.parse(localStorage.getItem('2p5d.library.v1')).map(o => o.name),
  };

  // The walk row rides Steps 1 to 3 and goes with the drawer on Step 4.
  const rows = {};
  app.goStep(3);
  rows.s3 = !document.getElementById('queueWalkRow').hidden;
  app.goStep(4);
  await new Promise(r => setTimeout(r, 200));
  rows.s4 = document.getElementById('queueWalkRow').hidden;
  app.goStep(3);

  // Put the library, the folder, the queue and Step 1 back.
  app.queue.clear();
  app.palette.setFolder({ entries: [], skipped: [] }, '');
  app.folderBackend.forget();
  if (before.lib === null) localStorage.removeItem('2p5d.library.v1');
  else localStorage.setItem('2p5d.library.v1', before.lib);
  app.palette.refresh();
  app.queue.applyRef(before.ref);
  app.traceEditor.setTrace(before.trace.outer, before.trace.holes);
  app.traceEditor.setCircles(before.trace.circles);
  app.state.image = before.image;
  app.state.rect = before.rect;
  app.state.rectDirty = before.rectDirty;
  app.state.corners = before.corners;
  app.state.fileName = before.fileName;
  app.state.paper.orientation = before.orient;
  document.getElementById('paperOrient').value = before.orient;
  document.getElementById('fileLabelText').textContent = before.label;
  app.cornerEditor.setImage(before.image);
  if (before.corners) app.cornerEditor.setCorners(before.corners);
  app.goStep(before.step);
  await new Promise(r => setTimeout(r, 300));
  const restored = {
    step: app.state.step,
    image: app.state.image === before.image,
    lib: localStorage.getItem('2p5d.library.v1') === before.lib,
    queue: app.state.queue.length,
    handle: app.folderBackend.handle,
    trace: app.traceEditor.outer.length === before.trace.outer.length,
    reference: app.state.reference === before.ref.reference,
    captureFrac: app.state.captureFrac === before.ref.captureFrac,
  };

  return { queued, afterOne, stale, collided, afterSkip, lastOne, undone, rows, restored, written };
});

check('Next saves the trace under the photo file name, marks it traced and opens the next ticked photo',
  JSON.stringify(queueThree.queued) === JSON.stringify(
    ['bench/awl.jpg', 'bench/hammer.jpg', 'bench/rasp.jpg', 'bench/sub/chisel.jpg']) &&
  queueThree.afterOne.saved === 'awl' && queueThree.afterOne.status === 'traced' &&
  queueThree.afterOne.picked === false && queueThree.afterOne.current &&
  queueThree.afterOne.nameField === 'hammer' && queueThree.afterOne.fileName === 'hammer' &&
  queueThree.afterOne.wide === 400 && queueThree.afterOne.firstWide === 600,
  `saved “${queueThree.afterOne.saved}”, now on “${queueThree.afterOne.fileName}” ` +
  `(${queueThree.afterOne.wide} px wide), name field “${queueThree.afterOne.nameField}”`);

check('the photo Next opens arrives untraced, so a second Next saves nothing',
  queueThree.stale.outer === 0 && queueThree.stale.circles === 0 &&
  queueThree.stale.rect === null && queueThree.stale.diffMap === null &&
  queueThree.stale.refused === null && queueThree.stale.status === 'pending' &&
  queueThree.stale.stillCurrent && queueThree.stale.writes === 1 &&
  JSON.stringify(queueThree.stale.libNames) === JSON.stringify(['hammer', 'awl']),
  `outer ${queueThree.stale.outer} points, rect ${queueThree.stale.rect}, ` +
  `second Next returned ${JSON.stringify(queueThree.stale.refused)}, ` +
  `library ${JSON.stringify(queueThree.stale.libNames)} after ${queueThree.stale.writes} write(s)`);

check('a library name already taken takes the photo’s folder as a suffix',
  queueThree.collided.saved === 'hammer (bench)' && queueThree.collided.current &&
  JSON.stringify(queueThree.collided.libNames) === JSON.stringify(
    ['hammer', 'awl', 'hammer (bench)']),
  `saved “${queueThree.collided.saved}”, library ${JSON.stringify(queueThree.collided.libNames)}`);

check('Next writes the project beside the photo, photo-free, so the folder resumes it',
  JSON.stringify(queueThree.written) === JSON.stringify(
    ['bench/awl.json', 'bench/hammer.json', 'sub/chisel.json']) &&
  queueThree.lastOne.projectApp === '2.5D' && queueThree.lastOne.projectName === 'chisel' &&
  queueThree.lastOne.projectPhoto === null && queueThree.lastOne.projectOuter === 4,
  `${JSON.stringify(queueThree.written)}, last project “${queueThree.lastOne.projectName}” ` +
  `photo ${queueThree.lastOne.projectPhoto}`);

check('the reference settings carry over to the next photo and the corners are re-detected',
  queueThree.afterOne.reference === 'rect' && queueThree.afterOne.captureFrac === 0.5 &&
  queueThree.afterOne.captureField === '0.5' && queueThree.afterOne.nx === 7 &&
  queueThree.afterOne.bar === 123 && queueThree.afterOne.cornersMoved &&
  queueThree.afterOne.cornersInside,
  `capture ${queueThree.afterOne.captureFrac} (field “${queueThree.afterOne.captureField}”), ` +
  `grid nx ${queueThree.afterOne.nx}, bar ${queueThree.afterOne.bar}, ` +
  `corners moved ${queueThree.afterOne.cornersMoved} and inside the new photo ${queueThree.afterOne.cornersInside}`);

check('Skip advances without saving and leaves the photo in the queue',
  queueThree.afterSkip.status === 'skipped' && queueThree.afterSkip.picked === false &&
  queueThree.afterSkip.current && queueThree.afterSkip.next &&
  queueThree.afterSkip.fileName === 'chisel' &&
  JSON.stringify(queueThree.afterSkip.libNames) === JSON.stringify(
    ['hammer', 'awl', 'hammer (bench)']),
  `rasp is ${queueThree.afterSkip.status}, now on “${queueThree.afterSkip.fileName}”, ` +
  `library still ${JSON.stringify(queueThree.afterSkip.libNames)}`);

check('Undo returns to the photo just finished, pending and ticked, with its library entry kept',
  queueThree.lastOne.saved === 'chisel' && queueThree.lastOne.noNext &&
  JSON.stringify(queueThree.lastOne.traced) === JSON.stringify(['awl', 'hammer (bench)', 'chisel']) &&
  queueThree.lastOne.undoShown &&
  queueThree.undone.status === 'pending' && queueThree.undone.picked === true &&
  queueThree.undone.current && queueThree.undone.fileName === 'chisel' &&
  queueThree.undone.undoHidden &&
  JSON.stringify(queueThree.undone.traced) === JSON.stringify(['awl', 'hammer (bench)']) &&
  JSON.stringify(queueThree.undone.libNames) === JSON.stringify(
    ['hammer', 'awl', 'hammer (bench)', 'chisel']),
  `traced ${JSON.stringify(queueThree.lastOne.traced)} → ${JSON.stringify(queueThree.undone.traced)}, ` +
  `chisel back to ${queueThree.undone.status}, library ${JSON.stringify(queueThree.undone.libNames)}`);

check('the walk row rides Steps 1 to 3 and the block hands the library and Step 1 back',
  queueThree.rows.s3 && queueThree.rows.s4 && queueThree.restored.image &&
  queueThree.restored.lib && queueThree.restored.queue === 0 &&
  queueThree.restored.handle === null && queueThree.restored.trace &&
  queueThree.restored.reference && queueThree.restored.captureFrac &&
  queueThree.restored.step === 3,
  `step ${queueThree.restored.step}, library restored ${queueThree.restored.lib}, ` +
  `photo restored ${queueThree.restored.image}, handle ${queueThree.restored.handle}`);


// "Organize what I have": Step 4 opens with this session's traced tools ticked
// in the palette, and Add all places exactly them.
const queueFour = await page.evaluate(async () => {
  const app = window.__app;
  const rect = (x, y, w, h) => [
    { x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h },
  ];
  const photoFile = async (name, w, h) => {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const g = c.getContext('2d');
    g.fillStyle = '#2a2a2a'; g.fillRect(0, 0, w, h);
    g.fillStyle = '#f2f2f0'; g.fillRect(w * 0.08, h * 0.08, w * 0.84, h * 0.84);
    g.fillStyle = '#303030'; g.fillRect(w * 0.3, h * 0.3, w * 0.35, h * 0.3);
    const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.85));
    return new File([blob], name, { type: 'image/jpeg' });
  };

  const before = {
    image: app.state.image,
    rect: app.state.rect,
    rectDirty: app.state.rectDirty,
    corners: app.state.corners && app.state.corners.map(p => ({ x: p.x, y: p.y })),
    fileName: app.state.fileName,
    orient: app.state.paper.orientation,
    label: document.getElementById('fileLabelText').textContent,
    step: app.state.step,
    trace: app.traceEditor.getTrace(),
    lib: localStorage.getItem('2p5d.library.v1'),
    ref: app.queue.snapshot(),
    items: app.state.layout.items.slice(),
    sel: app.layoutEditor.sel,
  };

  // A library that already holds last month's tools: the preselection must
  // leave them alone.
  localStorage.setItem('2p5d.library.v1', JSON.stringify([
    { name: 'old chisel', kind: 'tool', thickness: 6, outer: rect(5, 5, 60, 18), holes: [], circles: [] },
    { name: 'old rasp', kind: 'tool', thickness: 6, outer: rect(5, 5, 70, 16), holes: [], circles: [] },
  ]));

  const files = {
    'wrench.jpg': await photoFile('wrench.jpg', 480, 360),
    'pliers.jpg': await photoFile('pliers.jpg', 400, 300),
  };
  const dir = {
    kind: 'directory', name: 'bench',
    values: async function* () {
      for (const n of ['pliers.jpg', 'wrench.jpg']) {
        yield { kind: 'file', name: n, getFile: async () => files[n] };
      }
    },
    queryPermission: async () => 'granted',
    requestPermission: async () => 'granted',
    getFileHandle: async () => ({
      createWritable: async () => ({ write: async () => {}, close: async () => {} }),
    }),
  };

  // Trace two photos the way the walk does, so the traced list is the real one.
  app.queue.clear();
  await app.queue.ingestFolder(dir, 'bench');
  app.queue.load(app.state.queue[0]);
  await new Promise(r => setTimeout(r, 700));
  app.traceEditor.setTrace(rect(10, 10, 55, 22), []);
  await app.queue.walk.next();
  await new Promise(r => setTimeout(r, 700));
  app.traceEditor.setTrace(rect(10, 10, 55, 22), []);
  await app.queue.walk.next();
  await new Promise(r => setTimeout(r, 400));
  const traced = app.queue.traced.map(t => t.name);

  // The folder has since been re-read, so pliers is in the library only while
  // wrench is in both lists. Each tool must still be ticked once.
  const folderEntry = (name, path, w) => ({
    name, kind: 'tool', thickness: 6, outer: rect(5, 5, w, 20), holes: [], circles: [],
    arcs: [], lines: [], source: { kind: 'folder', path },
  });
  app.palette.setFolder({
    entries: [folderEntry('spare', 'bench/spare.json', 40), folderEntry('wrench', 'bench/wrench.json', 50)],
    skipped: [],
  }, 'bench');

  app.state.layout.items.length = 0;
  const got = app.queue.organize();
  await new Promise(r => setTimeout(r, 300));
  const boxes = () => Array.from(document.querySelectorAll('#layPalette .pal-row'))
    .map(r => ({ key: r.dataset.key, on: !!(r.querySelector('.pal-pick') || {}).checked }));
  const organized = {
    step: app.state.step,
    picked: got.picked,
    missing: got.missing,
    picks: app.palette.picks.slice().sort(),
    rowShown: !document.getElementById('layPalPickRow').hidden,
    count: document.getElementById('layPalPickCount').textContent,
    ticked: boxes().filter(b => b.on).map(b => b.key).sort(),
    untouched: boxes().filter(b => !b.on).map(b => b.key).sort(),
    addAllOn: !document.getElementById('layPalAddAllBtn').disabled,
  };

  // Add all places exactly the ticked tools.
  document.getElementById('layPalAddAllBtn').click();
  await new Promise(r => setTimeout(r, 250));
  const addAll = {
    n: app.state.layout.items.length,
    names: app.state.layout.items.map(i => i.name),
  };

  // A tick can be changed by hand, and Add ticked follows it.
  app.state.layout.items.length = 0;
  const wrenchRow = document.querySelector(
    '#layPalFolderList .pal-row[data-key="folder:bench/wrench.json|wrench"] .pal-pick');
  wrenchRow.checked = false;
  wrenchRow.dispatchEvent(new Event('change', { bubbles: true }));
  document.getElementById('layPalAddTickedBtn').click();
  await new Promise(r => setTimeout(r, 250));
  const byHand = {
    picks: app.palette.picks.slice(),
    n: app.state.layout.items.length,
    names: app.state.layout.items.map(i => i.name),
  };

  // With nothing ticked, Add all is the folder's Add all again.
  app.state.layout.items.length = 0;
  document.getElementById('layPalClearPicksBtn').click();
  await new Promise(r => setTimeout(r, 150));
  const cleared = {
    picks: app.palette.picks.length,
    rowHidden: document.getElementById('layPalPickRow').hidden,
  };
  document.getElementById('layPalAddAllBtn').click();
  await new Promise(r => setTimeout(r, 250));
  cleared.n = app.state.layout.items.length;
  cleared.names = app.state.layout.items.map(i => i.name);

  // Put the layout, the library, the folder, the queue and Step 1 back.
  app.state.layout.items.length = 0;
  app.state.layout.items.push(...before.items);
  app.layoutEditor.sel = before.sel;
  app.queue.clear();
  app.palette.setFolder({ entries: [], skipped: [] }, '');
  app.folderBackend.forget();
  if (before.lib === null) localStorage.removeItem('2p5d.library.v1');
  else localStorage.setItem('2p5d.library.v1', before.lib);
  app.queue.applyRef(before.ref);
  app.traceEditor.setTrace(before.trace.outer, before.trace.holes);
  app.traceEditor.setCircles(before.trace.circles);
  app.state.image = before.image;
  app.state.rect = before.rect;
  app.state.rectDirty = before.rectDirty;
  app.state.corners = before.corners;
  app.state.fileName = before.fileName;
  app.state.paper.orientation = before.orient;
  document.getElementById('paperOrient').value = before.orient;
  document.getElementById('fileLabelText').textContent = before.label;
  app.cornerEditor.setImage(before.image);
  if (before.corners) app.cornerEditor.setCorners(before.corners);
  app.goStep(before.step);
  await new Promise(r => setTimeout(r, 300));
  app.refreshLayoutEditor();
  const restored = {
    step: app.state.step,
    image: app.state.image === before.image,
    lib: localStorage.getItem('2p5d.library.v1') === before.lib,
    queue: app.state.queue.length,
    picks: app.palette.picks.length,
    pickRowHidden: document.getElementById('layPalPickRow').hidden,
    items: app.state.layout.items.length === before.items.length,
    palette: app.palette.folder.entries.length,
  };

  return { traced, organized, addAll, byHand, cleared, restored };
});

check('Organize what I have jumps to Step 4 with this session’s traced tools ticked',
  JSON.stringify(queueFour.traced) === JSON.stringify(['pliers', 'wrench']) &&
  queueFour.organized.step === 4 && queueFour.organized.picked === 2 &&
  queueFour.organized.missing === 0 && queueFour.organized.rowShown &&
  queueFour.organized.count === '2 tools ticked' && queueFour.organized.addAllOn &&
  JSON.stringify(queueFour.organized.ticked) === JSON.stringify(
    ['folder:bench/wrench.json|wrench', 'lib:pliers']) &&
  JSON.stringify(queueFour.organized.untouched) === JSON.stringify(
    ['folder:bench/spare.json|spare', 'lib:old chisel', 'lib:old rasp', 'lib:wrench']),
  `traced ${JSON.stringify(queueFour.traced)} → ticked ${JSON.stringify(queueFour.organized.ticked)}, ` +
  `left alone ${JSON.stringify(queueFour.organized.untouched)}, count “${queueFour.organized.count}”`);

check('Add all then places exactly those tools, once each',
  queueFour.addAll.n === 2 &&
  JSON.stringify(queueFour.addAll.names) === JSON.stringify(['pliers', 'wrench']),
  `${queueFour.addAll.n} placed: ${JSON.stringify(queueFour.addAll.names)}`);

check('unticking a row drops it from the placement, and with none ticked Add all is the folder again',
  JSON.stringify(queueFour.byHand.picks) === JSON.stringify(['lib:pliers']) &&
  queueFour.byHand.n === 1 && queueFour.byHand.names.join(',') === 'pliers' &&
  queueFour.cleared.picks === 0 && queueFour.cleared.rowHidden &&
  queueFour.cleared.n === 2 && queueFour.cleared.names.join(',') === 'spare,wrench',
  `by hand ${JSON.stringify(queueFour.byHand.names)}; cleared → Add all placed ${JSON.stringify(queueFour.cleared.names)}`);

check('the organize block hands the layout, the library and the palette back',
  queueFour.restored.step === 3 && queueFour.restored.image &&
  queueFour.restored.lib && queueFour.restored.queue === 0 &&
  queueFour.restored.picks === 0 && queueFour.restored.pickRowHidden &&
  queueFour.restored.items && queueFour.restored.palette === 0,
  `step ${queueFour.restored.step}, layout restored ${queueFour.restored.items}, ` +
  `ticks ${queueFour.restored.picks}, palette ${queueFour.restored.palette}`);


// The five tests Part A's Scope asks for, walked end to end in one page:
// ingest, Next, Skip, the resume rule, and the reference carry-over. The blocks
// above test the parts as they were built; this one is the acceptance pass over
// the whole flow, on a library that starts empty so every name it produces is
// the photo's own.
const queueFive = await page.evaluate(async () => {
  const app = window.__app;
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const rect = (x, y, w, h) => [
    { x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h },
  ];
  const photoFile = async (name, w, h) => {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const g = c.getContext('2d');
    g.fillStyle = '#2a2a2a'; g.fillRect(0, 0, w, h);
    g.fillStyle = '#f2f2f0'; g.fillRect(w * 0.08, h * 0.08, w * 0.84, h * 0.84);
    g.fillStyle = '#303030'; g.fillRect(w * 0.3, h * 0.3, w * 0.35, h * 0.3);
    const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.85));
    const f = new File([blob], String(name).split('/').pop(), { type: 'image/jpeg' });
    if (String(name).includes('/')) {
      Object.defineProperty(f, 'webkitRelativePath', { value: name });
    }
    return f;
  };

  const before = {
    image: app.state.image,
    rect: app.state.rect,
    rectDirty: app.state.rectDirty,
    corners: app.state.corners && app.state.corners.map(p => ({ x: p.x, y: p.y })),
    fileName: app.state.fileName,
    orient: app.state.paper.orientation,
    label: document.getElementById('fileLabelText').textContent,
    step: app.state.step,
    trace: app.traceEditor.getTrace(),
    lib: localStorage.getItem('2p5d.library.v1'),
    ref: app.queue.snapshot(),
  };

  // An empty library, so the name Next saves under is the photo's file name
  // and nothing else: no collision, no suffix.
  localStorage.setItem('2p5d.library.v1', '[]');
  const libNames = () => JSON.parse(localStorage.getItem('2p5d.library.v1')).map(o => o.name);

  // The resume rule goes first, because the writable folder it opens is also
  // where the walk below writes its projects. saw.json is a 2.5D project beside saw.jpg,
  // so that photo is already traced and the walk must pass over it.
  const sawJson = JSON.stringify({
    app: '2.5D', version: 1, fileName: 'saw',
    regions: [{ thickness: 6 }],
    trace: { outer: rect(15, 15, 80, 30), holes: [], circles: [] },
  });
  const kitFiles = {
    'saw.jpg': await photoFile('saw.jpg', 420, 320),
    'saw.json': new File([sawJson], 'saw.json', { type: 'application/json' }),
  };
  const writes = [];
  const dir = {
    kind: 'directory', name: 'kit',
    values: async function* () {
      for (const n of ['saw.jpg', 'saw.json']) {
        yield { kind: 'file', name: n, getFile: async () => kitFiles[n] };
      }
    },
    queryPermission: async () => 'granted',
    requestPermission: async () => 'granted',
    getFileHandle: async n => ({
      createWritable: async () => ({
        write: async text => { writes.push({ name: n, text: String(text) }); },
        close: async () => {},
      }),
    }),
  };

  app.queue.clear();
  await app.queue.ingestFolder(dir, 'kit');
  const resumed = {
    paths: app.state.queue.map(q => q.path),
    statuses: app.state.queue.map(q => q.status),
    picked: app.state.queue.map(q => q.picked),
    palette: app.palette.folder.entries.map(e => e.name),
    // Nothing to trace, so the walk has no next photo to offer.
    next: app.queue.next(null),
  };

  // One action, three photos, three pending items named from the files. These
  // three sit in the folder the picker opened, so the per-photo project goes in
  // beside them.
  app.queue.clear();
  const three = [
    await photoFile('kit/ratchet.jpg', 600, 450),
    await photoFile('kit/scriber.jpg', 460, 600),
    await photoFile('kit/tin snips.jpg', 520, 400),
  ];
  const added = await app.queue.add(three);
  const ingested = {
    added: added.length,
    n: app.state.queue.length,
    names: app.state.queue.map(q => q.name),
    statuses: app.state.queue.map(q => q.status),
    ticked: app.state.queue.filter(q => q.picked).length,
    tiles: document.querySelectorAll('#queueList .queue-item').length,
    lib: libNames().length,
  };

  // Photo one, with the reference settings a user would have dialled in on it
  // and a fixture trace standing in for the Step 2 pass.
  app.queue.load(app.state.queue[0]);
  await wait(700);
  app.state.reference = 'rect';
  app.state.captureFrac = 1;
  app.state.grid.ny = 9;
  app.state.bar.lengthMm = 150;
  app.state.coin.customD = 25.5;
  document.getElementById('captureArea').value = '1';
  app.traceEditor.setTrace(rect(12, 12, 60, 30), []);
  const firstCorners = JSON.stringify(app.state.corners);

  // Next: the entry is named from the file, the project is written beside the
  // photo, and the queue advances to the next ticked photo.
  const one = await app.queue.walk.next();
  await wait(700);
  const entry = JSON.parse(localStorage.getItem('2p5d.library.v1'))[0];
  const saved = {
    name: one && one.name,
    libNames: libNames(),
    kind: entry && entry.kind,
    outer: entry && entry.outer.length,
    wrote: one && one.wrote.kind,
    wroteName: one && one.wrote.name,
    written: writes.map(w => w.name),
    status: app.state.queue[0].status,
    ticked: app.state.queue[0].picked,
    advanced: app.state.queueCurrentId === app.state.queue[1].id,
    fileName: app.state.fileName,
    nameField: document.getElementById('queueSaveName').value,
    wide: app.state.image.naturalWidth,
  };

  // The carry-over: settings kept, corners re-detected, because the sheet moves
  // between shots.
  const carried = {
    reference: app.state.reference,
    captureFrac: app.state.captureFrac,
    captureField: document.getElementById('captureArea').value,
    refField: document.getElementById('refType').value,
    ny: app.state.grid.ny,
    bar: app.state.bar.lengthMm,
    coinD: app.state.coin.customD,
    cornersMoved: JSON.stringify(app.state.corners) !== firstCorners,
    cornersInside: app.state.corners.every(p =>
      p.x <= app.state.image.naturalWidth && p.y <= app.state.image.naturalHeight),
  };

  // Skip, with a perfectly good trace on screen, and the library does not grow.
  app.traceEditor.setTrace(rect(20, 20, 40, 40), []);
  const skip = app.queue.walk.skip();
  await wait(700);
  const skipped = {
    status: app.state.queue[1].status,
    ticked: app.state.queue[1].picked,
    advanced: app.state.queueCurrentId === app.state.queue[2].id,
    fileName: app.state.fileName,
    libNames: libNames(),
    written: writes.map(w => w.name),
    next: skip && skip.next === app.state.queue[2].id,
    stillQueued: app.state.queue.length,
  };

  // Put the library, the folder, the queue and Step 1 back.
  app.queue.clear();
  app.palette.setFolder({ entries: [], skipped: [] }, '');
  app.folderBackend.forget();
  if (before.lib === null) localStorage.removeItem('2p5d.library.v1');
  else localStorage.setItem('2p5d.library.v1', before.lib);
  app.palette.refresh();
  app.queue.applyRef(before.ref);
  app.traceEditor.setTrace(before.trace.outer, before.trace.holes);
  app.traceEditor.setCircles(before.trace.circles);
  app.state.image = before.image;
  app.state.rect = before.rect;
  app.state.rectDirty = before.rectDirty;
  app.state.corners = before.corners;
  app.state.fileName = before.fileName;
  app.state.paper.orientation = before.orient;
  document.getElementById('paperOrient').value = before.orient;
  document.getElementById('fileLabelText').textContent = before.label;
  app.cornerEditor.setImage(before.image);
  if (before.corners) app.cornerEditor.setCorners(before.corners);
  app.goStep(before.step);
  await wait(300);
  const restored = {
    step: app.state.step,
    image: app.state.image === before.image,
    lib: localStorage.getItem('2p5d.library.v1') === before.lib,
    queue: app.state.queue.length,
    handle: app.folderBackend.handle,
    palette: app.palette.folder.entries.length,
    trace: app.traceEditor.outer.length === before.trace.outer.length,
    reference: app.state.reference === before.ref.reference,
    captureFrac: app.state.captureFrac === before.ref.captureFrac,
    stripHidden: document.getElementById('queueStrip').hidden,
  };

  return { resumed, ingested, saved, carried, skipped, restored };
});

check('the batch flow: a three-file list ingests as three pending photos',
  queueFive.ingested.added === 3 && queueFive.ingested.n === 3 &&
  JSON.stringify(queueFive.ingested.names) === JSON.stringify(['ratchet', 'scriber', 'tin snips']) &&
  queueFive.ingested.statuses.every(s => s === 'pending') &&
  queueFive.ingested.ticked === 3 && queueFive.ingested.tiles === 3 &&
  queueFive.ingested.lib === 0,
  `${queueFive.ingested.n} items ${JSON.stringify(queueFive.ingested.names)} as ` +
  `${JSON.stringify(queueFive.ingested.statuses)}, ${queueFive.ingested.tiles} tiles`);

check('the batch flow: Next saves a library entry named from the photo file and advances',
  queueFive.saved.name === 'ratchet' &&
  JSON.stringify(queueFive.saved.libNames) === JSON.stringify(['ratchet']) &&
  queueFive.saved.kind === 'tool' && queueFive.saved.outer === 4 &&
  queueFive.saved.wrote === 'folder' && queueFive.saved.wroteName === 'ratchet.json' &&
  JSON.stringify(queueFive.saved.written) === JSON.stringify(['ratchet.json']) &&
  queueFive.saved.status === 'traced' && queueFive.saved.ticked === false &&
  queueFive.saved.advanced && queueFive.saved.fileName === 'scriber' &&
  queueFive.saved.nameField === 'scriber' && queueFive.saved.wide === 460,
  `saved “${queueFive.saved.name}” (library ${JSON.stringify(queueFive.saved.libNames)}, ` +
  `project ${JSON.stringify(queueFive.saved.written)}), now on “${queueFive.saved.fileName}”`);

check('the batch flow: Skip advances without saving and the photo stays in the queue',
  queueFive.skipped.status === 'skipped' && queueFive.skipped.ticked === false &&
  queueFive.skipped.advanced && queueFive.skipped.next &&
  queueFive.skipped.fileName === 'tin snips' && queueFive.skipped.stillQueued === 3 &&
  JSON.stringify(queueFive.skipped.libNames) === JSON.stringify(['ratchet']) &&
  JSON.stringify(queueFive.skipped.written) === JSON.stringify(['ratchet.json']),
  `scriber is ${queueFive.skipped.status}, now on “${queueFive.skipped.fileName}”, ` +
  `library still ${JSON.stringify(queueFive.skipped.libNames)}`);

check('the batch flow: a photo with its sibling project JSON resumes as traced',
  JSON.stringify(queueFive.resumed.paths) === JSON.stringify(['kit/saw.jpg']) &&
  JSON.stringify(queueFive.resumed.statuses) === JSON.stringify(['traced']) &&
  JSON.stringify(queueFive.resumed.picked) === JSON.stringify([false]) &&
  JSON.stringify(queueFive.resumed.palette) === JSON.stringify(['saw']) &&
  queueFive.resumed.next === null,
  `${JSON.stringify(queueFive.resumed.paths)} as ${JSON.stringify(queueFive.resumed.statuses)}, ` +
  `palette ${JSON.stringify(queueFive.resumed.palette)}, next ${queueFive.resumed.next}`);

check('the batch flow: the reference settings survive Next and the corners do not',
  queueFive.carried.reference === 'rect' && queueFive.carried.refField === 'rect' &&
  queueFive.carried.captureFrac === 1 && queueFive.carried.captureField === '1' &&
  queueFive.carried.ny === 9 && queueFive.carried.bar === 150 &&
  queueFive.carried.coinD === 25.5 && queueFive.carried.cornersMoved &&
  queueFive.carried.cornersInside,
  `capture ${queueFive.carried.captureFrac} (field “${queueFive.carried.captureField}”), ` +
  `grid ny ${queueFive.carried.ny}, bar ${queueFive.carried.bar}, coin ⌀ ${queueFive.carried.coinD}, ` +
  `corners re-detected ${queueFive.carried.cornersMoved}`);

check('the acceptance block hands the library, the folder and Step 1 back',
  queueFive.restored.step === 3 && queueFive.restored.image && queueFive.restored.lib &&
  queueFive.restored.queue === 0 && queueFive.restored.handle === null &&
  queueFive.restored.palette === 0 && queueFive.restored.trace &&
  queueFive.restored.reference && queueFive.restored.captureFrac &&
  queueFive.restored.stripHidden,
  `step ${queueFive.restored.step}, library restored ${queueFive.restored.lib}, ` +
  `queue ${queueFive.restored.queue}, palette ${queueFive.restored.palette}`);

// ---------- the per-photo project write stays with the photo ----------
//
// One writable folder is open and the queue holds a photo from somewhere else:
// a folder dropped onto Step 1, or a second folder picked. That photo has no
// folder here, so its project must not be written into the open folder's root,
// where it would sit beside the wrong photo and overwrite whatever already
// answers to its name. The download fallback takes it instead, and a photo
// that really is inside the open folder still writes beside itself.
const queueSix = await page.evaluate(async () => {
  const app = window.__app;
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const rect = (x, y, w, h) => [
    { x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h },
  ];
  const photoFile = async (name, w, h) => {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const g = c.getContext('2d');
    g.fillStyle = '#2a2a2a'; g.fillRect(0, 0, w, h);
    g.fillStyle = '#f2f2f0'; g.fillRect(w * 0.08, h * 0.08, w * 0.84, h * 0.84);
    g.fillStyle = '#303030'; g.fillRect(w * 0.3, h * 0.3, w * 0.35, h * 0.3);
    const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.85));
    return new File([blob], name, { type: 'image/jpeg' });
  };

  const before = {
    image: app.state.image,
    rect: app.state.rect,
    rectDirty: app.state.rectDirty,
    corners: app.state.corners && app.state.corners.map(p => ({ x: p.x, y: p.y })),
    fileName: app.state.fileName,
    label: document.getElementById('fileLabelText').textContent,
    step: app.state.step,
    trace: app.traceEditor.getTrace(),
    lib: localStorage.getItem('2p5d.library.v1'),
    ref: app.queue.snapshot(),
  };
  localStorage.setItem('2p5d.library.v1', '[]');

  // Every write records the directory it landed in, so "beside the photo" is
  // checked and not assumed.
  const writes = [];
  const fileHandle = (name, file) => ({ kind: 'file', name, getFile: async () => file });
  const mkDir = (name, children) => {
    const h = {
      kind: 'directory', name, children,
      values: async function* () { for (const c of h.children) yield c; },
      queryPermission: async () => 'granted',
      requestPermission: async () => 'granted',
      getDirectoryHandle: async n => {
        const kid = h.children.find(c => c.kind === 'directory' && c.name === n);
        if (!kid) throw new Error('no such folder');
        return kid;
      },
      getFileHandle: async n => ({
        createWritable: async () => ({
          write: async text => { writes.push({ dir: h.name, name: n, text: String(text) }); },
          close: async () => {},
        }),
      }),
    };
    return h;
  };

  // Drawer one, opened with the picker: an awl already traced last week, its
  // project sitting beside the photo.
  const benchProject = JSON.stringify({
    app: '2.5D', version: 1, fileName: 'awl',
    regions: [{ thickness: 6 }],
    trace: { outer: rect(3, 3, 30, 14), holes: [], circles: [] },
  });
  const bench = mkDir('bench', [
    fileHandle('awl.jpg', await photoFile('awl.jpg', 320, 240)),
    fileHandle('awl.json', new File([benchProject], 'awl.json', { type: 'application/json' })),
  ]);
  app.queue.clear();
  await app.queue.ingestFolder(bench, 'bench');
  const opened = {
    handle: app.folderBackend.handle && app.folderBackend.handle.name,
    paths: app.state.queue.map(q => q.path),
    statuses: app.state.queue.map(q => q.status),
  };

  // Drawer two dragged onto Step 1: fresh photos, no project beside them, and
  // the camera gave one of them the same name drawer one already uses.
  const fileEntry = (name, file) => ({
    isFile: true, isDirectory: false, name, file: cb => cb(file),
  });
  const dirEntry = (name, kids) => ({
    isFile: false, isDirectory: true, name,
    createReader: () => {
      let sent = false;
      return { readEntries: cb => { const batch = sent ? [] : kids; sent = true; cb(batch); } };
    },
  });
  await app.queue.drop([dirEntry('garage', [
    fileEntry('awl.jpg', await photoFile('awl.jpg', 300, 300)),
  ])], []);
  const dropped = { paths: app.state.queue.map(q => q.path) };

  app.queue.load(app.state.queue.find(q => q.path === 'garage/awl.jpg'));
  await wait(700);
  app.traceEditor.setTrace(rect(11, 12, 53, 27), []);
  const one = await app.queue.walk.next();
  await wait(400);
  const outside = {
    wrote: one && one.wrote.kind,
    name: one && one.wrote.name,
    writes: writes.map(w => `${w.dir}/${w.name}`),
    libNames: JSON.parse(localStorage.getItem('2p5d.library.v1')).map(o => o.name),
    status: app.state.queue.find(q => q.path === 'garage/awl.jpg').status,
    handleKept: app.folderBackend.handle === bench,
  };

  // Two folders picked in one session: the second is the open one, and the
  // first folder's photo must not write into it either.
  app.queue.clear();
  const shelfA = mkDir('shelfA', [
    fileHandle('wrench.jpg', await photoFile('wrench.jpg', 340, 260)),
  ]);
  const shelfB = mkDir('shelfB', [
    fileHandle('plier.jpg', await photoFile('plier.jpg', 280, 360)),
  ]);
  await app.queue.ingestFolder(shelfA, 'shelfA');
  await app.queue.ingestFolder(shelfB, 'shelfB');
  writes.length = 0;
  app.queue.load(app.state.queue.find(q => q.path === 'shelfA/wrench.jpg'));
  await wait(700);
  app.traceEditor.setTrace(rect(9, 9, 40, 22), []);
  const two = await app.queue.walk.next();
  await wait(700);
  const crossed = {
    wrote: two && two.wrote.kind,
    name: two && two.wrote.name,
    writes: writes.map(w => `${w.dir}/${w.name}`),
    onB: app.state.fileName,
  };

  // The control: a photo that really is inside the open folder still writes
  // beside itself, so the fallback has not simply switched folder writes off.
  app.traceEditor.setTrace(rect(7, 7, 38, 20), []);
  const three = await app.queue.walk.next();
  await wait(400);
  const inside = {
    wrote: three && three.wrote.kind,
    name: three && three.wrote.name,
    writes: writes.map(w => `${w.dir}/${w.name}`),
  };

  // Put the library, the folder, the queue and Step 1 back.
  app.queue.clear();
  app.palette.setFolder({ entries: [], skipped: [] }, '');
  app.folderBackend.forget();
  if (before.lib === null) localStorage.removeItem('2p5d.library.v1');
  else localStorage.setItem('2p5d.library.v1', before.lib);
  app.palette.refresh();
  app.queue.applyRef(before.ref);
  app.traceEditor.setTrace(before.trace.outer, before.trace.holes);
  app.traceEditor.setCircles(before.trace.circles);
  app.state.image = before.image;
  app.state.rect = before.rect;
  app.state.rectDirty = before.rectDirty;
  app.state.corners = before.corners;
  app.state.fileName = before.fileName;
  document.getElementById('fileLabelText').textContent = before.label;
  app.cornerEditor.setImage(before.image);
  if (before.corners) app.cornerEditor.setCorners(before.corners);
  app.goStep(before.step);
  await wait(300);
  const restored = {
    step: app.state.step,
    image: app.state.image === before.image,
    lib: localStorage.getItem('2p5d.library.v1') === before.lib,
    queue: app.state.queue.length,
    handle: app.folderBackend.handle,
    palette: app.palette.folder.entries.length,
    trace: app.traceEditor.outer.length === before.trace.outer.length,
  };

  return { opened, dropped, outside, crossed, inside, restored };
});

check('a dropped folder’s project is never written into the folder the picker opened',
  queueSix.opened.handle === 'bench' &&
  JSON.stringify(queueSix.opened.statuses) === JSON.stringify(['traced']) &&
  JSON.stringify(queueSix.dropped.paths) === JSON.stringify(['bench/awl.jpg', 'garage/awl.jpg']) &&
  queueSix.outside.handleKept && queueSix.outside.wrote === 'download' &&
  queueSix.outside.name === 'awl.json' &&
  JSON.stringify(queueSix.outside.writes) === JSON.stringify([]) &&
  queueSix.outside.status === 'traced' &&
  JSON.stringify(queueSix.outside.libNames) === JSON.stringify(['awl']),
  `queue ${JSON.stringify(queueSix.dropped.paths)} with “bench” open; the project went to ` +
  `${queueSix.outside.wrote} as “${queueSix.outside.name}”, folder writes ${JSON.stringify(queueSix.outside.writes)}`);

check('with a second folder picked, the first folder’s photo downloads instead of writing into it',
  queueSix.crossed.wrote === 'download' && queueSix.crossed.name === 'wrench.json' &&
  JSON.stringify(queueSix.crossed.writes) === JSON.stringify([]) &&
  queueSix.crossed.onB === 'plier',
  `wrote ${queueSix.crossed.wrote} “${queueSix.crossed.name}”, folder writes ${JSON.stringify(queueSix.crossed.writes)}`);

check('a photo that is inside the open folder still writes its project beside itself',
  queueSix.inside.wrote === 'folder' && queueSix.inside.name === 'plier.json' &&
  JSON.stringify(queueSix.inside.writes) === JSON.stringify(['shelfB/plier.json']),
  `wrote ${queueSix.inside.wrote} “${queueSix.inside.name}” into ${JSON.stringify(queueSix.inside.writes)}`);

check('the cross-folder write block leaves the library, the folder and Step 1 as it found them',
  queueSix.restored.step === 3 && queueSix.restored.image && queueSix.restored.lib &&
  queueSix.restored.queue === 0 && queueSix.restored.handle === null &&
  queueSix.restored.palette === 0 && queueSix.restored.trace,
  `step ${queueSix.restored.step}, library restored ${queueSix.restored.lib}, ` +
  `queue ${queueSix.restored.queue}, handle ${queueSix.restored.handle}`);

// ---------- the walk saves only the photo it is on ----------
//
// "Choose photo…" and a single dropped file load straight into Step 1 without
// passing through the queue. The walk has to let go of the queued photo when
// that happens: still bound, Next would save the outline of whatever is now on
// screen under the queued photo's name, write it as that photo's sibling
// project over anything already there, and retire that photo traced so the
// walk and the resume rule both pass over it for good.
const queueSeven = await page.evaluate(async () => {
  const app = window.__app;
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const rect = (x, y, w, h) => [
    { x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h },
  ];
  const photoFile = async (name, w, h) => {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const g = c.getContext('2d');
    g.fillStyle = '#2a2a2a'; g.fillRect(0, 0, w, h);
    g.fillStyle = '#f2f2f0'; g.fillRect(w * 0.08, h * 0.08, w * 0.84, h * 0.84);
    g.fillStyle = '#303030'; g.fillRect(w * 0.3, h * 0.3, w * 0.35, h * 0.3);
    const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.85));
    return new File([blob], name, { type: 'image/jpeg' });
  };
  const libNames = () => JSON.parse(localStorage.getItem('2p5d.library.v1') || '[]').map(o => o.name);

  const before = {
    image: app.state.image,
    rect: app.state.rect,
    rectDirty: app.state.rectDirty,
    corners: app.state.corners && app.state.corners.map(p => ({ x: p.x, y: p.y })),
    fileName: app.state.fileName,
    label: document.getElementById('fileLabelText').textContent,
    step: app.state.step,
    trace: app.traceEditor.getTrace(),
    lib: localStorage.getItem('2p5d.library.v1'),
    ref: app.queue.snapshot(),
  };
  localStorage.setItem('2p5d.library.v1', '[]');

  const writes = [];
  const fileHandle = (name, file) => ({ kind: 'file', name, getFile: async () => file });
  const mkDir = (name, children) => {
    const h = {
      kind: 'directory', name, children,
      values: async function* () { for (const c of h.children) yield c; },
      queryPermission: async () => 'granted',
      requestPermission: async () => 'granted',
      getDirectoryHandle: async n => {
        const kid = h.children.find(c => c.kind === 'directory' && c.name === n);
        if (!kid) throw new Error('no such folder');
        return kid;
      },
      getFileHandle: async n => ({
        createWritable: async () => ({
          write: async text => { writes.push({ dir: h.name, name: n, text: String(text) }); },
          close: async () => {},
        }),
      }),
    };
    return h;
  };

  // A bench folder of two photos, the first traced and the walk now on the
  // second, which is exactly where a user reaches for "Choose photo…".
  const bench = mkDir('bench', [
    fileHandle('awl.jpg', await photoFile('awl.jpg', 320, 240)),
    fileHandle('bevel.jpg', await photoFile('bevel.jpg', 360, 300)),
  ]);
  app.queue.clear();
  await app.queue.ingestFolder(bench, 'bench');
  app.queue.load(app.state.queue[0]);
  await wait(700);
  app.traceEditor.setTrace(rect(10, 10, 50, 25), []);
  await app.queue.walk.next();
  await wait(700);
  const walking = {
    onBevel: app.state.queueCurrentId === app.state.queue[1].id,
    nameField: document.getElementById('queueSaveName').value,
    writes: writes.map(w => `${w.dir}/${w.name}`),
  };

  // Mid-walk, an unrelated photo through the picker itself.
  const input = document.getElementById('fileInput');
  const dt = new DataTransfer();
  dt.items.add(await photoFile('chisel.jpg', 500, 380));
  input.files = dt.files;
  input.dispatchEvent(new Event('change'));
  await wait(800);
  const picked = {
    fileName: app.state.fileName,
    wide: app.state.image.naturalWidth,
    current: app.state.queueCurrentId,
    nameField: document.getElementById('queueSaveName').value,
    nextDisabled: document.getElementById('queueNextBtn').disabled,
  };

  // Next has nothing to save against now, and the queued photo is untouched.
  app.traceEditor.setTrace(rect(4, 4, 30, 30), []);
  const ret = await app.queue.walk.next();
  await wait(400);
  const guarded = {
    ret,
    writes: writes.map(w => `${w.dir}/${w.name}`),
    libNames: libNames(),
    bevelStatus: app.state.queue[1].status,
    bevelPicked: app.state.queue[1].picked,
  };

  // The same for one file dropped on Step 1, the other path that loads a photo
  // without the queue.
  app.queue.load(app.state.queue[1]);
  await wait(700);
  const reBound = app.state.queueCurrentId === app.state.queue[1].id;
  const dt2 = new DataTransfer();
  dt2.items.add(await photoFile('mallet.jpg', 400, 300));
  document.getElementById('stage1').dispatchEvent(
    new DragEvent('drop', { dataTransfer: dt2, bubbles: true, cancelable: true }));
  await wait(800);
  const droppedOne = {
    reBound,
    fileName: app.state.fileName,
    current: app.state.queueCurrentId,
    nextDisabled: document.getElementById('queueNextBtn').disabled,
    queued: app.state.queue.length,
    bevelStatus: app.state.queue[1].status,
  };

  // Put the library, the folder, the queue and Step 1 back.
  app.queue.clear();
  app.palette.setFolder({ entries: [], skipped: [] }, '');
  app.folderBackend.forget();
  if (before.lib === null) localStorage.removeItem('2p5d.library.v1');
  else localStorage.setItem('2p5d.library.v1', before.lib);
  app.palette.refresh();
  app.queue.applyRef(before.ref);
  app.traceEditor.setTrace(before.trace.outer, before.trace.holes);
  app.traceEditor.setCircles(before.trace.circles);
  app.state.image = before.image;
  app.state.rect = before.rect;
  app.state.rectDirty = before.rectDirty;
  app.state.corners = before.corners;
  app.state.fileName = before.fileName;
  document.getElementById('fileLabelText').textContent = before.label;
  app.cornerEditor.setImage(before.image);
  if (before.corners) app.cornerEditor.setCorners(before.corners);
  app.goStep(before.step);
  await wait(300);
  const restored = {
    step: app.state.step,
    image: app.state.image === before.image,
    lib: localStorage.getItem('2p5d.library.v1') === before.lib,
    queue: app.state.queue.length,
    handle: app.folderBackend.handle,
    palette: app.palette.folder.entries.length,
    trace: app.traceEditor.outer.length === before.trace.outer.length,
  };

  return { walking, picked, guarded, droppedOne, restored };
});

check('a photo chosen with the picker mid-walk takes the queue off the walk',
  queueSeven.walking.onBevel && queueSeven.walking.nameField === 'bevel' &&
  queueSeven.picked.fileName === 'chisel' && queueSeven.picked.wide === 500 &&
  queueSeven.picked.current === null && queueSeven.picked.nameField === '' &&
  queueSeven.picked.nextDisabled,
  `after the picker: on “${queueSeven.picked.fileName}”, current ${queueSeven.picked.current}, ` +
  `name field “${queueSeven.picked.nameField}”, Next disabled ${queueSeven.picked.nextDisabled}`);

check('Next after that picker load writes nothing and leaves the queued photo untraced',
  queueSeven.guarded.ret === null &&
  JSON.stringify(queueSeven.guarded.writes) === JSON.stringify(['bench/awl.json']) &&
  JSON.stringify(queueSeven.guarded.libNames) === JSON.stringify(['awl']) &&
  queueSeven.guarded.bevelStatus === 'pending' && queueSeven.guarded.bevelPicked === true,
  `Next returned ${queueSeven.guarded.ret}, folder writes ${JSON.stringify(queueSeven.guarded.writes)}, ` +
  `library ${JSON.stringify(queueSeven.guarded.libNames)}, bevel ${queueSeven.guarded.bevelStatus}`);

check('a single file dropped on Step 1 takes the queue off the walk as well',
  queueSeven.droppedOne.reBound && queueSeven.droppedOne.fileName === 'mallet' &&
  queueSeven.droppedOne.current === null && queueSeven.droppedOne.nextDisabled &&
  queueSeven.droppedOne.queued === 2 && queueSeven.droppedOne.bevelStatus === 'pending',
  `after the drop: on “${queueSeven.droppedOne.fileName}”, current ${queueSeven.droppedOne.current}, ` +
  `queue ${queueSeven.droppedOne.queued}, bevel ${queueSeven.droppedOne.bevelStatus}`);

check('the picker-mid-walk block leaves the library, the folder and Step 1 as it found them',
  queueSeven.restored.step === 3 && queueSeven.restored.image && queueSeven.restored.lib &&
  queueSeven.restored.queue === 0 && queueSeven.restored.handle === null &&
  queueSeven.restored.palette === 0 && queueSeven.restored.trace,
  `step ${queueSeven.restored.step}, library restored ${queueSeven.restored.lib}, ` +
  `queue ${queueSeven.restored.queue}, handle ${queueSeven.restored.handle}`);

// ---------- the walk files tools, whatever the Kind select says ----------
//
// Saving the drawer itself as a container outline is the documented way to get
// a container shape into the library, and it leaves the Save outline panel's
// Kind select on Container for the rest of the session. Every photo the walk
// saves after that must still be a tool: Step 4's palette drops containers, so
// a mis-kinded row is ticked nowhere and Add all places nothing.
const queueEight = await page.evaluate(async () => {
  const app = window.__app;
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const rect = (x, y, w, h) => [
    { x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h },
  ];
  const photoFile = async (name, w, h) => {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const g = c.getContext('2d');
    g.fillStyle = '#2a2a2a'; g.fillRect(0, 0, w, h);
    g.fillStyle = '#f2f2f0'; g.fillRect(w * 0.08, h * 0.08, w * 0.84, h * 0.84);
    g.fillStyle = '#303030'; g.fillRect(w * 0.3, h * 0.3, w * 0.35, h * 0.3);
    const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.85));
    return new File([blob], name, { type: 'image/jpeg' });
  };
  const lib = () => JSON.parse(localStorage.getItem('2p5d.library.v1') || '[]');

  const before = {
    image: app.state.image,
    rect: app.state.rect,
    rectDirty: app.state.rectDirty,
    corners: app.state.corners && app.state.corners.map(p => ({ x: p.x, y: p.y })),
    fileName: app.state.fileName,
    label: document.getElementById('fileLabelText').textContent,
    step: app.state.step,
    trace: app.traceEditor.getTrace(),
    libJson: localStorage.getItem('2p5d.library.v1'),
    ref: app.queue.snapshot(),
    kind: document.getElementById('libKind').value,
    items: app.state.layout.items.slice(),
    sel: app.layoutEditor.sel,
  };
  localStorage.setItem('2p5d.library.v1', '[]');
  app.state.layout.items.length = 0;

  // What a container save leaves behind on the panel.
  const kindSel = document.getElementById('libKind');
  kindSel.value = 'container';
  kindSel.dispatchEvent(new Event('change', { bubbles: true }));

  app.queue.clear();
  app.folderBackend.forget();
  await app.queue.add([
    await photoFile('mallet.jpg', 480, 360),
    await photoFile('punch.jpg', 360, 480),
  ]);
  app.queue.load(app.state.queue[0]);
  await wait(700);
  app.traceEditor.setTrace(rect(9, 9, 44, 20), []);
  await app.queue.walk.next();
  await wait(700);
  app.traceEditor.setTrace(rect(8, 8, 30, 46), []);
  await app.queue.walk.next();
  await wait(500);
  const filed = {
    names: lib().map(o => o.name),
    kinds: lib().map(o => o.kind),
    // The user's own choice on the panel is left where they put it.
    select: document.getElementById('libKind').value,
  };

  const got = app.queue.organize();
  await wait(300);
  const organized = {
    picked: got.picked,
    missing: got.missing,
    picks: app.palette.picks.slice().sort(),
    rows: document.querySelectorAll('#layPalLibList .pal-row').length,
  };
  document.getElementById('layPalAddAllBtn').click();
  await wait(250);
  const placed = {
    n: app.state.layout.items.length,
    names: app.state.layout.items.map(i => i.name),
  };

  // Put the layout, the library, the queue, the panel and Step 1 back.
  app.state.layout.items.length = 0;
  app.state.layout.items.push(...before.items);
  app.layoutEditor.sel = before.sel;
  kindSel.value = before.kind;
  kindSel.dispatchEvent(new Event('change', { bubbles: true }));
  app.queue.clear();
  app.palette.setFolder({ entries: [], skipped: [] }, '');
  app.folderBackend.forget();
  if (before.libJson === null) localStorage.removeItem('2p5d.library.v1');
  else localStorage.setItem('2p5d.library.v1', before.libJson);
  app.palette.refresh();
  app.queue.applyRef(before.ref);
  app.traceEditor.setTrace(before.trace.outer, before.trace.holes);
  app.traceEditor.setCircles(before.trace.circles);
  app.state.image = before.image;
  app.state.rect = before.rect;
  app.state.rectDirty = before.rectDirty;
  app.state.corners = before.corners;
  app.state.fileName = before.fileName;
  document.getElementById('fileLabelText').textContent = before.label;
  app.cornerEditor.setImage(before.image);
  if (before.corners) app.cornerEditor.setCorners(before.corners);
  app.goStep(before.step);
  await wait(300);
  app.refreshLayoutEditor();
  const restored = {
    step: app.state.step,
    image: app.state.image === before.image,
    lib: localStorage.getItem('2p5d.library.v1') === before.libJson,
    kind: document.getElementById('libKind').value === before.kind,
    queue: app.state.queue.length,
    picks: app.palette.picks.length,
    items: app.state.layout.items.length === before.items.length,
  };

  return { filed, organized, placed, restored };
});

check('Next files the photo as a tool even with the Kind select left on Container',
  JSON.stringify(queueEight.filed.names) === JSON.stringify(['mallet', 'punch']) &&
  JSON.stringify(queueEight.filed.kinds) === JSON.stringify(['tool', 'tool']) &&
  queueEight.filed.select === 'container',
  `library ${JSON.stringify(queueEight.filed.names)} as ${JSON.stringify(queueEight.filed.kinds)}, ` +
  `panel still on “${queueEight.filed.select}”`);

check('so Organize what I have still ticks them and Add all places exactly them',
  queueEight.organized.picked === 2 && queueEight.organized.missing === 0 &&
  JSON.stringify(queueEight.organized.picks) === JSON.stringify(['lib:mallet', 'lib:punch']) &&
  queueEight.organized.rows === 2 && queueEight.placed.n === 2 &&
  JSON.stringify(queueEight.placed.names) === JSON.stringify(['mallet', 'punch']),
  `picked ${queueEight.organized.picked}, missing ${queueEight.organized.missing}, ` +
  `${queueEight.organized.rows} palette rows, placed ${JSON.stringify(queueEight.placed.names)}`);

check('the Kind block leaves the library, the layout, the panel and Step 1 as it found them',
  queueEight.restored.step === 3 && queueEight.restored.image && queueEight.restored.lib &&
  queueEight.restored.kind && queueEight.restored.queue === 0 &&
  queueEight.restored.picks === 0 && queueEight.restored.items,
  `step ${queueEight.restored.step}, library restored ${queueEight.restored.lib}, ` +
  `kind restored ${queueEight.restored.kind}, queue ${queueEight.restored.queue}`);

// ---------- a photo with no folder of its own writes into none ----------
//
// "Add photos…" and a drop of loose files hand over bare file names, which say
// nothing about where the photo sits. Writing such a project into the folder
// the picker happens to have open puts it beside a photo it has nothing to do
// with, and truncates that photo's project when the names agree. The download
// takes it instead.
const queueNine = await page.evaluate(async () => {
  const app = window.__app;
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const rect = (x, y, w, h) => [
    { x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h },
  ];
  const photoFile = async (name, w, h) => {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const g = c.getContext('2d');
    g.fillStyle = '#2a2a2a'; g.fillRect(0, 0, w, h);
    g.fillStyle = '#f2f2f0'; g.fillRect(w * 0.08, h * 0.08, w * 0.84, h * 0.84);
    g.fillStyle = '#303030'; g.fillRect(w * 0.3, h * 0.3, w * 0.35, h * 0.3);
    const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.85));
    return new File([blob], name, { type: 'image/jpeg' });
  };

  const before = {
    image: app.state.image,
    rect: app.state.rect,
    rectDirty: app.state.rectDirty,
    corners: app.state.corners && app.state.corners.map(p => ({ x: p.x, y: p.y })),
    fileName: app.state.fileName,
    label: document.getElementById('fileLabelText').textContent,
    step: app.state.step,
    trace: app.traceEditor.getTrace(),
    lib: localStorage.getItem('2p5d.library.v1'),
    ref: app.queue.snapshot(),
  };
  localStorage.setItem('2p5d.library.v1', '[]');

  const writes = [];
  const fileHandle = (name, file) => ({ kind: 'file', name, getFile: async () => file });
  const bench = {
    kind: 'directory', name: 'bench',
    children: [],
    values: async function* () { for (const c of bench.children) yield c; },
    queryPermission: async () => 'granted',
    requestPermission: async () => 'granted',
    getDirectoryHandle: async () => { throw new Error('no such folder'); },
    getFileHandle: async n => ({
      createWritable: async () => ({
        write: async text => { writes.push({ dir: 'bench', name: n, text: String(text) }); },
        close: async () => {},
      }),
    }),
  };
  // Last week's awl, photo and project, sitting in the folder the picker opens.
  const benchProject = JSON.stringify({
    app: '2.5D', version: 1, fileName: 'awl',
    regions: [{ thickness: 6 }],
    trace: { outer: rect(3, 3, 30, 14), holes: [], circles: [] },
  });
  bench.children = [
    fileHandle('awl.jpg', await photoFile('awl.jpg', 320, 240)),
    fileHandle('awl.json', new File([benchProject], 'awl.json', { type: 'application/json' })),
  ];

  app.queue.clear();
  await app.queue.ingestFolder(bench, 'bench');
  // A different awl, multi-selected off the Desktop, so it arrives with no
  // path of its own and the same base name the folder already answers to.
  await app.queue.add([await photoFile('awl.jpg', 600, 450)]);
  const queued = {
    paths: app.state.queue.map(q => q.path),
    statuses: app.state.queue.map(q => q.status),
  };

  app.queue.load(app.state.queue[1]);
  await wait(700);
  app.traceEditor.setTrace(rect(5, 5, 20, 60), []);
  const one = await app.queue.walk.next();
  await wait(400);
  const loose = {
    wrote: one && one.wrote.kind,
    name: one && one.wrote.name,
    writes: writes.map(w => `${w.dir}/${w.name}`),
    libNames: JSON.parse(localStorage.getItem('2p5d.library.v1')).map(o => o.name),
    status: app.state.queue[1].status,
    benchStatus: app.state.queue[0].status,
  };

  // Put the library, the folder, the queue and Step 1 back.
  app.queue.clear();
  app.palette.setFolder({ entries: [], skipped: [] }, '');
  app.folderBackend.forget();
  if (before.lib === null) localStorage.removeItem('2p5d.library.v1');
  else localStorage.setItem('2p5d.library.v1', before.lib);
  app.palette.refresh();
  app.queue.applyRef(before.ref);
  app.traceEditor.setTrace(before.trace.outer, before.trace.holes);
  app.traceEditor.setCircles(before.trace.circles);
  app.state.image = before.image;
  app.state.rect = before.rect;
  app.state.rectDirty = before.rectDirty;
  app.state.corners = before.corners;
  app.state.fileName = before.fileName;
  document.getElementById('fileLabelText').textContent = before.label;
  app.cornerEditor.setImage(before.image);
  if (before.corners) app.cornerEditor.setCorners(before.corners);
  app.goStep(before.step);
  await wait(300);
  const restored = {
    step: app.state.step,
    image: app.state.image === before.image,
    lib: localStorage.getItem('2p5d.library.v1') === before.lib,
    queue: app.state.queue.length,
    handle: app.folderBackend.handle,
    palette: app.palette.folder.entries.length,
  };

  return { queued, loose, restored };
});

check('a photo with no folder of its own never writes over a project in the open one',
  JSON.stringify(queueNine.queued.paths) === JSON.stringify(['bench/awl.jpg', 'awl.jpg']) &&
  JSON.stringify(queueNine.queued.statuses) === JSON.stringify(['traced', 'pending']) &&
  queueNine.loose.wrote === 'download' && queueNine.loose.name === 'awl.json' &&
  JSON.stringify(queueNine.loose.writes) === JSON.stringify([]) &&
  JSON.stringify(queueNine.loose.libNames) === JSON.stringify(['awl']) &&
  queueNine.loose.status === 'traced' && queueNine.loose.benchStatus === 'traced',
  `queue ${JSON.stringify(queueNine.queued.paths)} with “bench” open; the loose photo went to ` +
  `${queueNine.loose.wrote} as “${queueNine.loose.name}”, folder writes ` +
  `${JSON.stringify(queueNine.loose.writes)}, library ${JSON.stringify(queueNine.loose.libNames)}`);

check('the loose-photo block leaves the library, the folder and Step 1 as it found them',
  queueNine.restored.step === 3 && queueNine.restored.image && queueNine.restored.lib &&
  queueNine.restored.queue === 0 && queueNine.restored.handle === null &&
  queueNine.restored.palette === 0,
  `step ${queueNine.restored.step}, library restored ${queueNine.restored.lib}, ` +
  `queue ${queueNine.restored.queue}, handle ${queueNine.restored.handle}`);

// ---------- a photo that will not decode never becomes the photo on screen ----------
//
// One corrupt file in a folder of phone shots. The walk advances onto it, the
// decode fails, and the photo before it is still on screen. Left alone, the
// user traces what they see and Next files that outline under the corrupt
// photo's name, writes it as its sibling project and marks it traced, which the
// resume rule then honours for good. The failed photo is retired instead, the
// way a HEIC is, and the walk lets go of it.
const queueTen = await page.evaluate(async () => {
  const app = window.__app;
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const rect = (x, y, w, h) => [
    { x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h },
  ];
  const photoFile = async (name, w, h) => {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const g = c.getContext('2d');
    g.fillStyle = '#2a2a2a'; g.fillRect(0, 0, w, h);
    g.fillStyle = '#f2f2f0'; g.fillRect(w * 0.08, h * 0.08, w * 0.84, h * 0.84);
    g.fillStyle = '#303030'; g.fillRect(w * 0.3, h * 0.3, w * 0.35, h * 0.3);
    const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.85));
    return new File([blob], name, { type: 'image/jpeg' });
  };

  const before = {
    image: app.state.image,
    rect: app.state.rect,
    rectDirty: app.state.rectDirty,
    corners: app.state.corners && app.state.corners.map(p => ({ x: p.x, y: p.y })),
    fileName: app.state.fileName,
    label: document.getElementById('fileLabelText').textContent,
    step: app.state.step,
    trace: app.traceEditor.getTrace(),
    lib: localStorage.getItem('2p5d.library.v1'),
    ref: app.queue.snapshot(),
  };
  localStorage.setItem('2p5d.library.v1', '[]');

  const writes = [];
  const fileHandle = (name, file) => ({ kind: 'file', name, getFile: async () => file });
  const bench = {
    kind: 'directory', name: 'bench', children: [],
    values: async function* () { for (const c of bench.children) yield c; },
    queryPermission: async () => 'granted',
    requestPermission: async () => 'granted',
    getDirectoryHandle: async () => { throw new Error('no such folder'); },
    getFileHandle: async n => ({
      createWritable: async () => ({
        write: async text => { writes.push({ dir: 'bench', name: n, text: String(text) }); },
        close: async () => {},
      }),
    }),
  };
  // A JPEG header and then nothing usable: the canvas will not open it, and it
  // is not HEIC, so nothing at ingest marks it out.
  const broken = new File(
    [new Uint8Array([0xFF, 0xD8, 0xFF, 0xE0, 1, 2, 3, 4, 5, 6, 7, 8])],
    'broken.jpg', { type: 'image/jpeg' });
  bench.children = [
    fileHandle('awl.jpg', await photoFile('awl.jpg', 320, 240)),
    fileHandle('broken.jpg', broken),
  ];

  app.queue.clear();
  await app.queue.ingestFolder(bench, 'bench');
  const ingested = {
    names: app.state.queue.map(q => q.name),
    statuses: app.state.queue.map(q => q.status),
  };

  app.queue.load(app.state.queue[0]);
  await wait(700);
  app.traceEditor.setTrace(rect(10, 10, 50, 25), []);
  await app.queue.walk.next();
  await wait(900);
  const failed = {
    // The awl is still the photo on screen, and Step 1 says so again.
    wide: app.state.image && app.state.image.naturalWidth,
    fileName: app.state.fileName,
    label: document.getElementById('fileLabelText').textContent,
    current: app.state.queueCurrentId,
    nameField: document.getElementById('queueSaveName').value,
    nextDisabled: document.getElementById('queueNextBtn').disabled,
    status: app.state.queue[1].status,
    picked: app.state.queue[1].picked,
    badge: document.querySelectorAll('#queueList .queue-item')[1]
      .querySelector('.queue-badge').textContent,
    writes: writes.map(w => `${w.dir}/${w.name}`),
  };

  // Trace what is on screen and press Next: nothing is saved under the failed
  // photo's name, nothing is written beside it, and it is not marked traced.
  app.traceEditor.setTrace(rect(6, 6, 40, 18), []);
  const ret = await app.queue.walk.next();
  await wait(400);
  const guarded = {
    ret,
    writes: writes.map(w => `${w.dir}/${w.name}`),
    libNames: JSON.parse(localStorage.getItem('2p5d.library.v1')).map(o => o.name),
    status: app.state.queue[1].status,
    // The walk has nothing ticked and pending left to offer.
    next: app.queue.next(null),
    // Clicking its thumbnail says why rather than loading it.
    reload: app.queue.load(app.state.queue[1]),
  };

  // Put the library, the folder, the queue and Step 1 back.
  app.queue.clear();
  app.palette.setFolder({ entries: [], skipped: [] }, '');
  app.folderBackend.forget();
  if (before.lib === null) localStorage.removeItem('2p5d.library.v1');
  else localStorage.setItem('2p5d.library.v1', before.lib);
  app.palette.refresh();
  app.queue.applyRef(before.ref);
  app.traceEditor.setTrace(before.trace.outer, before.trace.holes);
  app.traceEditor.setCircles(before.trace.circles);
  app.state.image = before.image;
  app.state.rect = before.rect;
  app.state.rectDirty = before.rectDirty;
  app.state.corners = before.corners;
  app.state.fileName = before.fileName;
  document.getElementById('fileLabelText').textContent = before.label;
  app.cornerEditor.setImage(before.image);
  if (before.corners) app.cornerEditor.setCorners(before.corners);
  app.goStep(before.step);
  await wait(300);
  const restored = {
    step: app.state.step,
    image: app.state.image === before.image,
    lib: localStorage.getItem('2p5d.library.v1') === before.lib,
    queue: app.state.queue.length,
    handle: app.folderBackend.handle,
    palette: app.palette.folder.entries.length,
  };

  return { ingested, failed, guarded, restored };
});

check('a photo that will not decode is retired and the walk lets go of it',
  JSON.stringify(queueTen.ingested.names) === JSON.stringify(['awl', 'broken']) &&
  JSON.stringify(queueTen.ingested.statuses) === JSON.stringify(['pending', 'pending']) &&
  queueTen.failed.wide === 320 && queueTen.failed.fileName === 'awl' &&
  queueTen.failed.label === 'awl.jpg' && queueTen.failed.current === null &&
  queueTen.failed.nameField === '' && queueTen.failed.nextDisabled &&
  queueTen.failed.status === 'unsupported' && queueTen.failed.picked === false &&
  queueTen.failed.badge === 'unsupported' &&
  JSON.stringify(queueTen.failed.writes) === JSON.stringify(['bench/awl.json']),
  `the photo on screen is still ${queueTen.failed.wide} px “${queueTen.failed.fileName}” ` +
  `(label “${queueTen.failed.label}”), broken is ${queueTen.failed.status}, ` +
  `current ${queueTen.failed.current}, Next disabled ${queueTen.failed.nextDisabled}`);

check('and the outline still on screen is never saved under the failed photo',
  queueTen.guarded.ret === null &&
  JSON.stringify(queueTen.guarded.writes) === JSON.stringify(['bench/awl.json']) &&
  JSON.stringify(queueTen.guarded.libNames) === JSON.stringify(['awl']) &&
  queueTen.guarded.status === 'unsupported' && queueTen.guarded.next === null &&
  queueTen.guarded.reload === false,
  `Next returned ${queueTen.guarded.ret}, folder writes ${JSON.stringify(queueTen.guarded.writes)}, ` +
  `library ${JSON.stringify(queueTen.guarded.libNames)}, broken ${queueTen.guarded.status}`);

check('the undecodable-photo block leaves the library, the folder and Step 1 as it found them',
  queueTen.restored.step === 3 && queueTen.restored.image && queueTen.restored.lib &&
  queueTen.restored.queue === 0 && queueTen.restored.handle === null &&
  queueTen.restored.palette === 0,
  `step ${queueTen.restored.step}, library restored ${queueTen.restored.lib}, ` +
  `queue ${queueTen.restored.queue}, handle ${queueTen.restored.handle}`);

// ---------- a tool is ticked by its own project, not by a shared name ----------
//
// A bench folder with a shelfA and a shelfB, each holding a wrench.jpg, and
// shelfA's was traced in an earlier session, so its wrench.json is already
// beside it. Tracing shelfB's writes a second wrench.json, and reading the
// folder again to pick up newly added photos puts both in the palette. The
// project file's name on its own is no identity there: matched on the name
// alone, this session's tool claims shelfA's row, which carries a different
// outline, and a second tool traced from another shelf would claim the same row
// again and Add all would place fewer tools than were traced.
const queueEleven = await page.evaluate(async () => {
  const app = window.__app;
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const rect = (x, y, w, h) => [
    { x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h },
  ];
  const photoFile = async (name, w, h) => {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const g = c.getContext('2d');
    g.fillStyle = '#2a2a2a'; g.fillRect(0, 0, w, h);
    g.fillStyle = '#f2f2f0'; g.fillRect(w * 0.08, h * 0.08, w * 0.84, h * 0.84);
    g.fillStyle = '#303030'; g.fillRect(w * 0.3, h * 0.3, w * 0.35, h * 0.3);
    const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.85));
    return new File([blob], name, { type: 'image/jpeg' });
  };

  const before = {
    image: app.state.image,
    rect: app.state.rect,
    rectDirty: app.state.rectDirty,
    corners: app.state.corners && app.state.corners.map(p => ({ x: p.x, y: p.y })),
    fileName: app.state.fileName,
    label: document.getElementById('fileLabelText').textContent,
    step: app.state.step,
    trace: app.traceEditor.getTrace(),
    lib: localStorage.getItem('2p5d.library.v1'),
    ref: app.queue.snapshot(),
    items: app.state.layout.items.slice(),
    sel: app.layoutEditor.sel,
  };
  localStorage.setItem('2p5d.library.v1', '[]');
  app.state.layout.items.length = 0;

  // A folder that keeps what is written into it, so reading it again really
  // does hand both projects to the palette.
  const writes = [];
  const fileHandle = (name, file) => ({ kind: 'file', name, getFile: async () => file });
  const mkDir = (name, children) => {
    const h = {
      kind: 'directory', name, children,
      values: async function* () { for (const c of h.children) yield c; },
      queryPermission: async () => 'granted',
      requestPermission: async () => 'granted',
      getDirectoryHandle: async n => {
        const kid = h.children.find(c => c.kind === 'directory' && c.name === n);
        if (!kid) throw new Error('no such folder');
        return kid;
      },
      getFileHandle: async n => ({
        createWritable: async () => ({
          write: async text => {
            writes.push(`${h.name}/${n}`);
            const f = new File([String(text)], n, { type: 'application/json' });
            const kid = { kind: 'file', name: n, getFile: async () => f };
            const at = h.children.findIndex(c => c.kind === 'file' && c.name === n);
            if (at >= 0) h.children[at] = kid; else h.children.push(kid);
          },
          close: async () => {},
        }),
      }),
    };
    return h;
  };

  // shelfA's wrench was traced last week: a long flat outline, nothing like the
  // one traced below, so a row ticked by mistake is visible in what is placed.
  const oldProject = JSON.stringify({
    app: '2.5D', version: 1, fileName: 'wrench',
    regions: [{ thickness: 6 }],
    trace: { outer: rect(5, 5, 90, 12), holes: [], circles: [] },
  });
  const shelfA = mkDir('shelfA', [
    fileHandle('wrench.jpg', await photoFile('wrench.jpg', 340, 260)),
    fileHandle('wrench.json', new File([oldProject], 'wrench.json', { type: 'application/json' })),
  ]);
  const shelfB = mkDir('shelfB', [
    fileHandle('wrench.jpg', await photoFile('wrench.jpg', 300, 380)),
  ]);
  const bench = mkDir('bench', [shelfA, shelfB]);

  app.queue.clear();
  await app.queue.ingestFolder(bench, 'bench');
  const queued = {
    paths: app.state.queue.map(q => q.path),
    statuses: app.state.queue.map(q => q.status),
    palette: app.palette.folder.entries.map(e => e.source.path),
  };

  // Trace shelfB's wrench, the only one this session touches.
  app.queue.load(app.state.queue[1]);
  await wait(700);
  app.traceEditor.setTrace(rect(8, 8, 24, 50), []);
  await app.queue.walk.next();
  await wait(500);
  // Add folder… on the same folder again, the way a user picks up photos added
  // since: both projects now read back into the palette.
  await app.queue.ingestFolder(bench, 'bench');
  await wait(300);
  const walked = {
    writes: writes.slice(),
    libNames: JSON.parse(localStorage.getItem('2p5d.library.v1')).map(o => o.name),
    traced: app.queue.traced.map(t => t.name),
    palette: app.palette.folder.entries.map(e => `${e.name}|${e.source.path}`),
  };

  const got = app.queue.organize();
  await wait(300);
  document.getElementById('layPalAddAllBtn').click();
  await wait(250);
  const mine = {
    picked: got.picked,
    missing: got.missing,
    picks: app.palette.picks.slice(),
    n: app.state.layout.items.length,
    // The outline that was placed: shelfB's upright wrench, not shelfA's.
    tall: app.state.layout.items.length === 1 &&
      app.state.layout.items[0].outer.every(p => p.x <= 40),
  };

  // The second shelf's wrench traced too: two tools, two rows, two placements.
  app.state.layout.items.length = 0;
  app.queue.load(app.state.queue[0]);
  await wait(700);
  app.traceEditor.setTrace(rect(10, 10, 55, 22), []);
  await app.queue.walk.next();
  await wait(500);
  await app.queue.ingestFolder(bench, 'bench');
  await wait(300);
  const gotBoth = app.queue.organize();
  await wait(300);
  document.getElementById('layPalAddAllBtn').click();
  await wait(250);
  const both = {
    traced: app.queue.traced.map(t => t.name),
    picked: gotBoth.picked,
    missing: gotBoth.missing,
    picks: app.palette.picks.slice().sort(),
    n: app.state.layout.items.length,
    writes: writes.slice(),
  };

  // Put the layout, the library, the folder, the queue and Step 1 back.
  app.state.layout.items.length = 0;
  app.state.layout.items.push(...before.items);
  app.layoutEditor.sel = before.sel;
  app.queue.clear();
  app.palette.setFolder({ entries: [], skipped: [] }, '');
  app.folderBackend.forget();
  if (before.lib === null) localStorage.removeItem('2p5d.library.v1');
  else localStorage.setItem('2p5d.library.v1', before.lib);
  app.palette.refresh();
  app.queue.applyRef(before.ref);
  app.traceEditor.setTrace(before.trace.outer, before.trace.holes);
  app.traceEditor.setCircles(before.trace.circles);
  app.state.image = before.image;
  app.state.rect = before.rect;
  app.state.rectDirty = before.rectDirty;
  app.state.corners = before.corners;
  app.state.fileName = before.fileName;
  document.getElementById('fileLabelText').textContent = before.label;
  app.cornerEditor.setImage(before.image);
  if (before.corners) app.cornerEditor.setCorners(before.corners);
  app.goStep(before.step);
  await wait(300);
  app.refreshLayoutEditor();
  const restored = {
    step: app.state.step,
    image: app.state.image === before.image,
    lib: localStorage.getItem('2p5d.library.v1') === before.lib,
    queue: app.state.queue.length,
    handle: app.folderBackend.handle,
    palette: app.palette.folder.entries.length,
    picks: app.palette.picks.length,
    items: app.state.layout.items.length === before.items.length,
  };

  return { queued, walked, mine, both, restored };
});

check('Organize ticks the project this session wrote, not the same-named one next door',
  JSON.stringify(queueEleven.queued.paths) === JSON.stringify(
    ['bench/shelfA/wrench.jpg', 'bench/shelfB/wrench.jpg']) &&
  JSON.stringify(queueEleven.queued.statuses) === JSON.stringify(['traced', 'pending']) &&
  JSON.stringify(queueEleven.queued.palette) === JSON.stringify(['bench/shelfA/wrench.json']) &&
  JSON.stringify(queueEleven.walked.writes) === JSON.stringify(['shelfB/wrench.json']) &&
  JSON.stringify(queueEleven.walked.palette) === JSON.stringify(
    ['wrench|bench/shelfA/wrench.json', 'wrench|bench/shelfB/wrench.json']) &&
  queueEleven.mine.picked === 1 && queueEleven.mine.missing === 0 &&
  JSON.stringify(queueEleven.mine.picks) === JSON.stringify(
    ['folder:bench/shelfB/wrench.json|wrench']) &&
  queueEleven.mine.n === 1 && queueEleven.mine.tall,
  `palette ${JSON.stringify(queueEleven.walked.palette)} → ticked ` +
  `${JSON.stringify(queueEleven.mine.picks)}, placed ${queueEleven.mine.n} (this session’s outline ` +
  `${queueEleven.mine.tall})`);

check('with both shelves traced, each tool keeps its own row and Add all places both',
  JSON.stringify(queueEleven.both.traced) === JSON.stringify(['wrench', 'wrench (shelfA)']) &&
  JSON.stringify(queueEleven.both.writes) === JSON.stringify(
    ['shelfB/wrench.json', 'shelfA/wrench.json']) &&
  queueEleven.both.picked === 2 && queueEleven.both.missing === 0 &&
  JSON.stringify(queueEleven.both.picks) === JSON.stringify([
    'folder:bench/shelfA/wrench.json|wrench', 'folder:bench/shelfB/wrench.json|wrench']) &&
  queueEleven.both.n === 2,
  `traced ${JSON.stringify(queueEleven.both.traced)} → ticks ${JSON.stringify(queueEleven.both.picks)}, ` +
  `placed ${queueEleven.both.n}`);

check('the two-subfolder block leaves the layout, the library, the folder and Step 1 as it found them',
  queueEleven.restored.step === 3 && queueEleven.restored.image && queueEleven.restored.lib &&
  queueEleven.restored.queue === 0 && queueEleven.restored.handle === null &&
  queueEleven.restored.palette === 0 && queueEleven.restored.picks === 0 &&
  queueEleven.restored.items,
  `step ${queueEleven.restored.step}, library restored ${queueEleven.restored.lib}, ` +
  `queue ${queueEleven.restored.queue}, palette ${queueEleven.restored.palette}`);

// ---------- re-editing a traced photo (resume editing, plan step 1) ----------
// Clicking a traced tile reopens the tool fully editable instead of clearing
// it, and Undo after Next comes back with the trace rather than the bare photo.
// Reopening never changes a photo's status: Next is the one thing that finishes
// a photo, on the first pass and on every pass after, so a stray click on a
// thumbnail cannot demote a finished tool back to pending.
const queueReedit = await page.evaluate(async () => {
  const app = window.__app;
  const $ = id => document.getElementById(id);
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const rect = (x, y, w, h) => [
    { x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h },
  ];
  const photoFile = async (name, w, h) => {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const g = c.getContext('2d');
    g.fillStyle = '#2a2a2a'; g.fillRect(0, 0, w, h);
    g.fillStyle = '#f2f2f0'; g.fillRect(w * 0.08, h * 0.08, w * 0.84, h * 0.84);
    g.fillStyle = '#303030'; g.fillRect(w * 0.3, h * 0.3, w * 0.35, h * 0.3);
    const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.85));
    return new File([blob], name, { type: 'image/jpeg' });
  };

  // Reopening is three async hops deep (decode the photo, read the project,
  // decode the rectified copy inside it), so the block waits on the outcome
  // rather than on a guessed number of milliseconds.
  const until = async (fn, ms = 6000) => {
    for (let t = 0; t < ms; t += 50) {
      if (fn()) return true;
      await wait(50);
    }
    return false;
  };
  const traced = () => app.traceEditor.getTrace().outer.length > 0;
  const toastNow = () => ($('toast') && $('toast').textContent) || '';

  const before = {
    image: app.state.image, step: app.state.step,
    trace: app.traceEditor.getTrace(),
    lib: localStorage.getItem('2p5d.library.v1'),
    regions: structuredClone(app.state.regions),
    selRegion: app.state.selRegion,
  };
  const regionsOk = rs => rs.length > 0 && rs.every(r => r && r.top && r.bottom);
  const regionsIn = { n: before.regions.length, ok: regionsOk(before.regions) };

  const files = {
    'awl.jpg': await photoFile('awl.jpg', 600, 450),
    'hammer.jpg': await photoFile('hammer.jpg', 400, 300),
  };
  // A folder that can be read back as well as written, which the earlier walk
  // fixtures never needed: reopening a traced photo in a LATER session has only
  // the folder to go on, so the project has to come off disk and not out of the
  // text this session happens to still be holding.
  const disk = new Map();
  const writes = [];
  const fileHandle = name => ({ kind: 'file', name, getFile: async () => files[name] });
  const mkDir = (name, children) => {
    const h = {
      kind: 'directory', name, children,
      values: async function* () { for (const c of h.children) yield c; },
      queryPermission: async () => 'granted',
      requestPermission: async () => 'granted',
      getDirectoryHandle: async n => {
        const kid = h.children.find(c => c.kind === 'directory' && c.name === n);
        if (!kid) throw new Error('no such folder');
        return kid;
      },
      getFileHandle: async n => {
        const key = `${h.name}/${n}`;
        return {
          createWritable: async () => ({
            write: async text => {
              disk.set(key, String(text));
              writes.push({ dir: h.name, name: n, text: String(text) });
            },
            close: async () => {},
          }),
          getFile: async () => {
            if (!disk.has(key)) throw new Error('no such file');
            return new File([disk.get(key)], n, { type: 'application/json' });
          },
        };
      },
    };
    return h;
  };
  const dir = mkDir('bench', [fileHandle('awl.jpg'), fileHandle('hammer.jpg')]);

  localStorage.setItem('2p5d.library.v1', '[]');
  // A known model state to trace under. Earlier blocks leave sections behind,
  // and the project this block writes is one it also has to load back, so it
  // starts from the same single base region a fresh page has.
  app.state.regions.length = 0;
  app.state.regions.push({
    name: 'Base', pts: null, thickness: 7, zBase: 0,
    top: { mode: 'none', size: 1 }, bottom: { mode: 'none', size: 1 },
  });
  app.state.selRegion = 0;
  app.queue.clear();
  await app.queue.ingestFolder(dir, 'bench');

  // Trace the awl, with the derived entities a trace accumulates around it, so
  // "the trace came back" means more than the outline alone.
  app.queue.load(app.state.queue[0]);
  await until(() => !!app.state.image);
  // Through Step 2 for real, not around it: rectifying is what gives the saved
  // project its rectified copy, and that copy is what makes the reopened tool
  // editable. A fixture trace stood in without it would be a project no walk
  // could ever write.
  app.goStep(2);
  await until(() => !!app.state.rect);
  app.traceEditor.setTrace(rect(10, 10, 50, 25), [rect(20, 15, 8, 8)]);
  app.traceEditor.setCircles([{ cx: 40, cy: 20, d: 4 }]);
  app.traceEditor.measurements = [{ type: 'p2p',
    refs: [{ kind: 'vert', loop: -1, idx: 0 }, { kind: 'vert', loop: -1, idx: 1 }] }];
  const firstNext = await app.queue.walk.next();
  await wait(700);
  const committed = {
    saved: firstNext && firstNext.name,
    status: app.state.queue[0].status,
    picked: app.state.queue[0].picked,
    onSecond: app.state.queueCurrentId === app.state.queue[1].id,
    // The walk cleared the trace with the photo, which is the behaviour the
    // reopen has to undo rather than the bug it works around.
    outerNow: app.traceEditor.getTrace().outer.length,
    written: writes.map(w => `${w.dir}/${w.name}`),
  };
  const firstProject = writes[0] && writes[0].text;

  // --- reopening by clicking the tile ---
  app.queue.load(app.state.queue[0]);
  await until(traced);
  const t = app.traceEditor.getTrace();
  const reopened = {
    outer: t.outer.length, holes: t.holes.length, circles: t.circles.length,
    measurements: app.traceEditor.measurements.length,
    thickness: app.state.regions[0].thickness,
    step: app.state.step,
    step2Enabled: !$('stepBtn2').disabled,
    rect: !!app.state.rect,
    // Sam's rule: reopening is not a commit and not an un-commit.
    status: app.state.queue[0].status,
    picked: app.state.queue[0].picked,
    reediting: app.queue.reediting === app.state.queue[0].id,
    nameField: $('queueSaveName').value,
    toast: toastNow(),
    hasText: !!app.state.queue[0].projText,
    readBack: !!(await app.queue.readProject(app.state.queue[0])),
    badge: (() => {
      const tile = $('queueList').querySelector(`[data-id="${app.state.queue[0].id}"]`);
      return tile ? tile.querySelector('.queue-badge').textContent : null;
    })(),
    pencil: !!$('queueList').querySelector(
      `[data-id="${app.state.queue[0].id}"] .queue-reedit`),
  };

  // --- nudge one vertex, commit again: a round trip, not a rebuild ---
  // A vertex drag moves the point in place. setTrace() is the RETRACE path and
  // drops measurement refs by design, because a fresh segmentation renumbers
  // every vertex; using it here would test a rebuild rather than a round trip.
  app.traceEditor.outer[0].x += 1;
  app.traceEditor.draw();
  await app.queue.walk.next();
  await wait(700);
  const secondProject = writes[writes.length - 1] && writes[writes.length - 1].text;
  const a = JSON.parse(firstProject || '{}'), b = JSON.parse(secondProject || '{}');
  // `rectified` is excluded on purpose and is the one field that cannot be
  // identical: the restore decodes that JPEG and the re-save re-encodes it, so
  // it is the same image through one more generation of lossy compression.
  const skip = new Set(['trace', 'rectified']);
  const keys = Array.from(new Set([...Object.keys(a), ...Object.keys(b)]));
  const roundTrip = {
    differing: keys.filter(k => !skip.has(k) &&
      JSON.stringify(a[k]) !== JSON.stringify(b[k])),
    traceMoved: JSON.stringify(a.trace) !== JSON.stringify(b.trace),
    msA: JSON.stringify(a.measurements), msB: JSON.stringify(b.measurements),
    stillRectified: typeof b.rectified === 'string' && b.rectified.length > 0,
    libNames: JSON.parse(localStorage.getItem('2p5d.library.v1') || '[]').map(e => e.name),
    tracedRows: app.queue.traced.filter(r => r.name === 'awl').length,
    writes: writes.map(w => `${w.dir}/${w.name}`),
  };

  // --- Undo after Next: the gap recorded against v1.25.0 ---
  app.queue.walk.undo();
  await until(traced);
  const undone = {
    outer: app.traceEditor.getTrace().outer.length,
    step2Enabled: !$('stepBtn2').disabled,
    status: app.state.queue[0].status,
    picked: app.state.queue[0].picked,
    fileName: app.state.fileName,
  };

  // --- the sibling project has gone missing ---
  disk.delete('bench/awl.json');
  app.state.queue[0].projText = null;
  app.state.queue[0].jsonFile = null;
  app.state.queue[0].status = 'traced';
  app.state.queue[0].picked = false;
  app.queue.load(app.state.queue[0]);
  await until(() => /not beside it any more/.test(toastNow()));
  const missing = {
    outer: app.traceEditor.getTrace().outer.length,
    reediting: app.queue.reediting,
    image: !!app.state.image,
    step: app.state.step,
    toast: ($('toast') && $('toast').textContent) || '',
  };

  // --- reading a project that only ever existed on disk ---
  // The second photo was never traced in this block, so its only route back is
  // the folder. Write one for it the way Next would, then drop every in-memory
  // trace of it and reopen.
  const hammer = app.state.queue[1];
  disk.set('bench/hammer.json', firstProject);
  hammer.status = 'traced';
  hammer.picked = false;
  hammer.projText = null;
  hammer.jsonFile = null;
  hammer.json = 'hammer.json';
  hammer.jsonPath = 'bench/hammer.json';
  app.queue.load(hammer);
  await until(traced);
  const fromDisk = {
    outer: app.traceEditor.getTrace().outer.length,
    reediting: app.queue.reediting === hammer.id,
    step2Enabled: !$('stepBtn2').disabled,
  };

  // Hand the page back.
  app.queue.clear();
  if (before.lib === null) localStorage.removeItem('2p5d.library.v1');
  else localStorage.setItem('2p5d.library.v1', before.lib);
  app.state.image = before.image;
  app.traceEditor.setTrace(before.trace.outer, before.trace.holes);
  app.traceEditor.setCircles(before.trace.circles || []);
  app.traceEditor.measurements = [];
  // Hand back a model state that can be serialised and loaded again. The
  // sections this block inherited were already missing their top/bottom caps,
  // which loadProject cannot read back, so putting exactly those back would
  // hand the next block a project it cannot open. A well-formed set goes back
  // as it found it; a malformed one is replaced by the single base region a
  // fresh page starts with.
  app.state.regions.length = 0;
  if (regionsOk(before.regions)) for (const r of before.regions) app.state.regions.push(r);
  else app.state.regions.push({
    name: 'Base', pts: null, thickness: 5, zBase: 0,
    top: { mode: 'none', size: 1 }, bottom: { mode: 'none', size: 1 },
  });
  app.state.selRegion = regionsOk(before.regions) ? before.selRegion : 0;
  app.goStep(before.step);
  const restored = {
    step: app.state.step, image: !!app.state.image,
    queue: app.state.queue.length, reediting: app.queue.reediting,
    regionsIn, regionsOut: { n: app.state.regions.length, ok: regionsOk(app.state.regions) },
    serOk: (() => {
      try { return regionsOk(JSON.parse(app.serializeProject(false)).regions || []); }
      catch (e) { return 'threw: ' + e.message; }
    })(),
  };

  return { committed, reopened, roundTrip, undone, missing, fromDisk, restored };
});

check('Next clears the trace with the photo and leaves the tool traced and unticked',
  queueReedit.committed.saved === 'awl' && queueReedit.committed.status === 'traced' &&
  queueReedit.committed.picked === false && queueReedit.committed.onSecond &&
  queueReedit.committed.outerNow === 0 &&
  JSON.stringify(queueReedit.committed.written) === JSON.stringify(['bench/awl.json']),
  `saved “${queueReedit.committed.saved}”, trace now ${queueReedit.committed.outerNow} points, ` +
  `wrote ${JSON.stringify(queueReedit.committed.written)}`);

check('clicking a traced tile reopens the tool editable, with every derived entity intact',
  queueReedit.reopened.outer === 4 && queueReedit.reopened.holes === 1 &&
  queueReedit.reopened.circles === 1 && queueReedit.reopened.measurements === 1 &&
  queueReedit.reopened.thickness === 7 &&
  queueReedit.reopened.step === 2 && queueReedit.reopened.step2Enabled &&
  queueReedit.reopened.rect,
  `outer ${queueReedit.reopened.outer}, holes ${queueReedit.reopened.holes}, ` +
  `circles ${queueReedit.reopened.circles}, measurements ${queueReedit.reopened.measurements}, ` +
  `thickness ${queueReedit.reopened.thickness}, step ${queueReedit.reopened.step} ` +
  `(Step 2 enabled ${queueReedit.reopened.step2Enabled})`);

check('reopening does not finish or unfinish the photo: only Next moves its status',
  queueReedit.reopened.status === 'traced' && queueReedit.reopened.picked === false &&
  queueReedit.reopened.reediting && queueReedit.reopened.nameField === 'awl' &&
  queueReedit.reopened.badge === 're-editing' && queueReedit.reopened.pencil,
  `status ${queueReedit.reopened.status}, ticked ${queueReedit.reopened.picked}, ` +
  `badge “${queueReedit.reopened.badge}”, pencil ${queueReedit.reopened.pencil}, ` +
  `name field “${queueReedit.reopened.nameField}”, kept text ` +
  `${queueReedit.reopened.hasText}, read back ${queueReedit.reopened.readBack}, ` +
  `toast “${queueReedit.reopened.toast}”`);

check('reopening, moving one vertex and pressing Next is a round trip, not a rebuild',
  queueReedit.roundTrip.differing.length === 0 && queueReedit.roundTrip.traceMoved &&
  queueReedit.roundTrip.stillRectified &&
  JSON.stringify(queueReedit.roundTrip.libNames) === JSON.stringify(['awl']) &&
  queueReedit.roundTrip.tracedRows === 1 &&
  JSON.stringify(queueReedit.roundTrip.writes) === JSON.stringify(
    ['bench/awl.json', 'bench/awl.json']),
  `fields that moved besides the trace: ${JSON.stringify(queueReedit.roundTrip.differing)}, ` +
  `library ${JSON.stringify(queueReedit.roundTrip.libNames)}, ` +
  `${queueReedit.roundTrip.tracedRows} row for awl; ` +
  `measurements ${queueReedit.roundTrip.msA} -> ${queueReedit.roundTrip.msB}`);

check('Undo after Next comes back with the trace, not just the photo',
  queueReedit.undone.outer === 4 && queueReedit.undone.step2Enabled &&
  queueReedit.undone.status === 'pending' && queueReedit.undone.picked === true &&
  queueReedit.undone.fileName === 'awl',
  `outer ${queueReedit.undone.outer} points, back to ${queueReedit.undone.status}/` +
  `ticked ${queueReedit.undone.picked} on “${queueReedit.undone.fileName}”`);

check('a traced photo whose project has gone reopens as a plain photo and says so',
  queueReedit.missing.outer === 0 && queueReedit.missing.reediting === null &&
  queueReedit.missing.image && queueReedit.missing.step === 1 &&
  /not beside it any more/.test(queueReedit.missing.toast),
  `outer ${queueReedit.missing.outer}, step ${queueReedit.missing.step}, ` +
  `toast “${queueReedit.missing.toast}”`);

check('a project this session never wrote is read back off the folder',
  queueReedit.fromDisk.outer === 4 && queueReedit.fromDisk.reediting &&
  queueReedit.fromDisk.step2Enabled,
  `outer ${queueReedit.fromDisk.outer}, re-editing ${queueReedit.fromDisk.reediting}`);

check('the re-edit block hands the queue and Step 1 back as it found them',
  queueReedit.restored.queue === 0 && queueReedit.restored.reediting === null &&
  queueReedit.restored.image,
  `queue ${queueReedit.restored.queue}, re-editing ${queueReedit.restored.reediting}, ` +
  `photo restored ${queueReedit.restored.image}, regions in ` +
  `${JSON.stringify(queueReedit.restored.regionsIn)} out ` +
  `${JSON.stringify(queueReedit.restored.regionsOut)}, serialisable ` +
  `${queueReedit.restored.serOk}`);

// ---------- snap to grid in the layout editor (Part B) ----------
// Snapping is a property of the gesture: a drag, an arrow-key nudge and a
// rotation-handle drag land on the grid, and nothing already placed moves when
// the toggle goes on.
const snapGrid = await page.evaluate(async () => {
  const app = window.__app, ed = app.layoutEditor;
  const $ = id => document.getElementById(id);
  const wait = ms => new Promise(r => setTimeout(r, ms));
  // The whole session as a project, so the block can hand the page back
  // whatever the container, the items and the snap grid are left as.
  const restorePoint = app.serializeProject(false);
  const before = { sel: ed.sel, bedSel: ed.bedSel, step: app.state.step };

  // A plain drawer with one tool in it, and no plate, so the press lands on
  // the tool rather than on a dashed outline through it.
  app.state.layout.container = {
    ...app.state.layout.container, type: 'rect', w: 220, h: 140, r: 6,
    name: null, outer: null,
  };
  app.state.layout.bed = { ...app.state.layout.bed, preset: 'none', shape: null, offset: { x: 0, y: 0 } };
  app.state.layout.items.length = 0;
  app.state.layout.items.push({
    name: 'scriber', outer: [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 10 }, { x: 0, y: 10 }],
    holes: [], circles: [], thickness: 5, depth: null, rot: 0, x: 40, y: 40,
  });
  app.state.layout.snap.on = false;
  app.state.layout.snap.pitch = 5;
  ed.bedSel = false;
  // Step 4, so the canvas is laid out and a pointer position means something.
  app.goStep(4);
  await wait(250);
  app.refreshLayoutEditor();
  await wait(150);

  const cv = ed.canvas;
  const cap = cv.setPointerCapture, rel = cv.releasePointerCapture;
  cv.setPointerCapture = () => {}; cv.releasePointerCapture = () => {};
  // Fractional client coordinates, so the pointer position converts back to
  // exactly the millimetre it was built from and 13.2 means 13.2.
  const client = mm => {
    const r = cv.getBoundingClientRect();
    const s = ed.mmToScreen(mm);
    return { x: r.left + s.x * (r.width / cv.width), y: r.top + s.y * (r.height / cv.height) };
  };
  const ev = (type, p) => cv.dispatchEvent(new PointerEvent(type, {
    clientX: p.x, clientY: p.y, pointerId: 1, bubbles: true,
  }));
  const it = () => app.state.layout.items[0];
  // Grab the tool at its own centre, so the drag carries no offset and where
  // the pointer stops is where the tool is asked to go.
  const dragTo = (x, y) => {
    ev('pointerdown', client({ x: it().x, y: it().y }));
    ev('pointermove', client({ x, y }));
    ev('pointerup', client({ x, y }));
    return { x: it().x, y: it().y };
  };
  // Drag the rotation handle round to a given angle.
  const rotateTo = deg => {
    ev('pointerdown', client(ed._rotHandle(it())));
    const a = ((deg - 90) * Math.PI) / 180;
    const to = { x: it().x + 30 * Math.cos(a), y: it().y + 30 * Math.sin(a) };
    ev('pointermove', client(to));
    ev('pointerup', client(to));
    return it().rot;
  };

  // Snap off: the tool stops where the pointer left it.
  const loose = dragTo(13.2, 21.4);
  const picked = { sel: ed.sel, kind: null };

  // Turning snap on must move nothing that is already placed, including an
  // angle that is nowhere near a quarter turn.
  it().rot = 37;
  $('laySnap').checked = true;
  $('laySnap').dispatchEvent(new Event('change', { bubbles: true }));
  const toggled = {
    x: it().x, y: it().y, rot: it().rot,
    on: app.state.layout.snap.on, edOn: ed.snap.on, pitch: ed.snap.pitch,
  };
  // A redraw is not a gesture either.
  app.refreshLayoutEditor();
  await wait(120);
  const redrawn = { x: it().x, y: it().y, rot: it().rot };

  // Snap on, 5 mm pitch: the same drag lands on the grid.
  const snapped = dragTo(13.2, 21.4);
  // And the rotation handle lands on a quarter turn.
  const rotOn = rotateTo(87);

  // Snap off again: both gestures go back to free.
  $('laySnap').checked = false;
  $('laySnap').dispatchEvent(new Event('change', { bubbles: true }));
  const rotOff = rotateTo(87);
  const looseAgain = dragTo(13.2, 21.4);

  // Arrow keys nudge the selected tool: one pitch onto the grid with snap on,
  // 1 mm with it off. The plate is not selected, so the keys are the tool's.
  ed.sel = 0; ed.bedSel = false;
  const key = k => document.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
  $('laySnap').checked = true;
  $('laySnap').dispatchEvent(new Event('change', { bubbles: true }));
  it().x = 13.2; it().y = 21.4;
  key('ArrowRight');
  key('ArrowUp');
  const nudgedOn = { x: it().x, y: it().y };
  $('laySnap').checked = false;
  $('laySnap').dispatchEvent(new Event('change', { bubbles: true }));
  it().x = 13.2; it().y = 21.4;
  key('ArrowRight');
  const nudgedOff = { x: it().x, y: it().y };

  // The 42 mm Gridfinity cell is offered only while the container is a bin.
  const pitchSel = $('laySnapPitch'), contSel = $('layContainerSel');
  const rectPitches = Array.from(pitchSel.options).map(o => o.value);
  contSel.value = '__grid';
  contSel.dispatchEvent(new Event('change', { bubbles: true }));
  await wait(200);
  const gridPitches = Array.from(pitchSel.options).map(o => o.value);
  pitchSel.value = '42';
  pitchSel.dispatchEvent(new Event('change', { bubbles: true }));
  const at42 = { state: app.state.layout.snap.pitch, ed: ed.snap.pitch };
  contSel.value = 'rect';
  contSel.dispatchEvent(new Event('change', { bubbles: true }));
  await wait(200);
  const backToRect = {
    pitches: Array.from(pitchSel.options).map(o => o.value),
    state: app.state.layout.snap.pitch,
    field: pitchSel.value,
  };

  // Additive save format: the grid rides along in the project, and a project
  // saved before snapping existed still loads, with it off at 5 mm.
  app.state.layout.snap.on = true;
  app.state.layout.snap.pitch = 10;
  const saved = JSON.parse(app.serializeProject(false));
  const legacy = JSON.parse(app.serializeProject(false));
  delete legacy.layout.snap;
  app.loadProject(saved);
  await wait(300);
  const roundTrip = { ...app.state.layout.snap, inFile: saved.layout.snap };
  app.loadProject(legacy);
  await wait(300);
  const older = { ...app.state.layout.snap, defined: !!app.state.layout.snap };

  // Hand the session back exactly as it was found.
  cv.setPointerCapture = cap; cv.releasePointerCapture = rel;
  app.loadProject(JSON.parse(restorePoint));
  await wait(500);
  ed.sel = before.sel; ed.bedSel = before.bedSel;
  app.syncLaySelPanel(before.sel);
  app.goStep(before.step);
  await wait(300);
  app.refreshLayoutEditor();
  const restored = {
    step: app.state.step,
    items: app.state.layout.items.length,
    snap: { ...app.state.layout.snap },
    sel: ed.sel,
    panelHidden: document.getElementById('laySelPanel').hidden,
  };

  return {
    loose, picked, toggled, redrawn, snapped, rotOn, rotOff, looseAgain,
    nudgedOn, nudgedOff, rectPitches, gridPitches, at42, backToRect,
    roundTrip, older, restored,
  };
});

check('a drag ending at 13.2 mm stores 15 with a 5 mm snap pitch',
  snapGrid.snapped.x === 15 && snapGrid.snapped.y === 20,
  `dragged to 13.2, 21.4 and stored ${snapGrid.snapped.x}, ${snapGrid.snapped.y}`);

check('with snap off the same drag stores 13.2 mm, untouched',
  Math.abs(snapGrid.loose.x - 13.2) < 1e-6 && Math.abs(snapGrid.loose.y - 21.4) < 1e-6 &&
  Math.abs(snapGrid.looseAgain.x - 13.2) < 1e-6 && Math.abs(snapGrid.looseAgain.y - 21.4) < 1e-6,
  `stored ${snapGrid.loose.x}, ${snapGrid.loose.y} (and ${snapGrid.looseAgain.x}, ${snapGrid.looseAgain.y} after snapping was turned off again)`);

check('a rotation drag to 87° stores 90 with snap on and 87 with it off',
  snapGrid.rotOn === 90 && Math.abs(snapGrid.rotOff - 87) < 1e-6,
  `snap on ${snapGrid.rotOn}°, snap off ${snapGrid.rotOff}°`);

check('turning snap on moves no item x, y or rot, and neither does a redraw',
  snapGrid.toggled.on && snapGrid.toggled.edOn && snapGrid.toggled.pitch === 5 &&
  Math.abs(snapGrid.toggled.x - 13.2) < 1e-6 && Math.abs(snapGrid.toggled.y - 21.4) < 1e-6 &&
  snapGrid.toggled.rot === 37 &&
  Math.abs(snapGrid.redrawn.x - 13.2) < 1e-6 && Math.abs(snapGrid.redrawn.y - 21.4) < 1e-6 &&
  snapGrid.redrawn.rot === 37,
  `after the toggle ${snapGrid.toggled.x}, ${snapGrid.toggled.y} at ${snapGrid.toggled.rot}°; ` +
  `after a redraw ${snapGrid.redrawn.x}, ${snapGrid.redrawn.y} at ${snapGrid.redrawn.rot}°`);

check('arrow keys nudge the selected tool one pitch onto the grid, or 1 mm with snap off',
  snapGrid.nudgedOn.x === 20 && snapGrid.nudgedOn.y === 15 &&
  Math.abs(snapGrid.nudgedOff.x - 14.2) < 1e-6 && Math.abs(snapGrid.nudgedOff.y - 21.4) < 1e-6,
  `from 13.2, 21.4: snapped to ${snapGrid.nudgedOn.x}, ${snapGrid.nudgedOn.y}; ` +
  `free to ${snapGrid.nudgedOff.x}, ${snapGrid.nudgedOff.y}`);

check('the 42 mm Gridfinity pitch is offered only while the container is a bin',
  !snapGrid.rectPitches.includes('42') && snapGrid.gridPitches.includes('42') &&
  snapGrid.at42.state === 42 && snapGrid.at42.ed === 42 &&
  !snapGrid.backToRect.pitches.includes('42') && snapGrid.backToRect.state === 5 &&
  snapGrid.backToRect.field === '5',
  `rectangle ${JSON.stringify(snapGrid.rectPitches)}, bin ${JSON.stringify(snapGrid.gridPitches)}, ` +
  `back to a rectangle at ${snapGrid.backToRect.state} mm`);

check('the snap grid rides in the project and an older project loads with it off',
  snapGrid.roundTrip.on === true && snapGrid.roundTrip.pitch === 10 &&
  snapGrid.roundTrip.inFile.on === true && snapGrid.roundTrip.inFile.pitch === 10 &&
  snapGrid.older.defined && snapGrid.older.on === false && snapGrid.older.pitch === 5 &&
  snapGrid.restored.step === 3 && snapGrid.restored.snap.on === false &&
  snapGrid.restored.snap.pitch === 5,
  `round trip ${JSON.stringify(snapGrid.roundTrip.inFile)}, older project ` +
  `${JSON.stringify(snapGrid.older)}, page handed back at step ${snapGrid.restored.step}`);

// ---------- the Nest button, its profiles and what a project keeps (steps 7-8) ----------
// nestLayout() shipped in v1.25.0 as reachable geometry with nothing calling
// it. This is the call, plus the rule that decides what reopening a project
// does: a project stores the resolved NUMBERS and the profile name as
// provenance only, so editing a profile can never change the geometry of a
// drawer that was already cut.
const nestUI = await page.evaluate(async () => {
  const app = window.__app, ed = app.layoutEditor;
  const $ = id => document.getElementById(id);
  const fire = (id, ev = 'change') =>
    $(id).dispatchEvent(new Event(ev, { bubbles: true }));
  const restorePoint = app.serializeProject(false);
  const beforeStep = app.state.step;
  const beforeStore = localStorage.getItem(app.nest.key);

  const rect = (w, h) => [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }];
  const tool = (name, w, h, extra = {}) => ({
    name, outer: rect(w, h), holes: [], circles: [], thickness: 5,
    depth: null, rot: 0, x: 10, y: 10, ...extra,
  });
  const setUp = items => {
    app.state.layout.container = {
      ...app.state.layout.container, type: 'rect', w: 200, h: 150, r: 6,
      name: null, outer: null,
    };
    app.state.layout.bed = {
      ...app.state.layout.bed, preset: 'none', shape: null, offset: { x: 0, y: 0 },
    };
    app.state.layout.labels = { ...app.state.layout.labels, enabled: false, extra: [] };
    app.state.layout.items.length = 0;
    for (const it of items) app.state.layout.items.push(it);
    app.goStep(4);
  };
  const poses = () => app.state.layout.items.map(it =>
    ({ x: +it.x.toFixed(4), y: +it.y.toFixed(4), rot: +(it.rot || 0).toFixed(4) }));
  const conflicts = () => ed.conflicts.collisions.size + ed.conflicts.escaped.size;

  localStorage.removeItem(app.nest.key);

  // --- the button ---
  // Four tools dropped on top of each other in one corner, which is what
  // "Add all" leaves behind and what a human would then spend ten minutes
  // dragging apart.
  setUp([tool('a', 60, 30), tool('b', 50, 40), tool('c', 40, 40), tool('d', 70, 25)]);
  app.state.layout.pack.values = app.nest.pack.values;
  app.nest.sync();
  const heaped = { poses: poses(), conflicts: conflicts() };
  $('layNestBtn').click();
  const nested = {
    poses: poses(), conflicts: conflicts(),
    info: $('layNestInfo').textContent,
    undoShown: !$('layNestUndoBtn').hidden,
  };
  // Undo is one action: the positions before it, put back.
  $('layNestUndoBtn').click();
  const undone = {
    poses: poses(), undoShown: !$('layNestUndoBtn').hidden,
    info: $('layNestInfo').textContent,
  };

  // --- pinning and the rotation lock ---
  setUp([
    tool('pinned', 50, 30, { x: 150, y: 120, pin: true }),
    tool('locked', 40, 20, { rot: 37, rotLock: 'current' }),
    tool('free', 60, 30),
  ]);
  const pinnedBefore = { ...poses()[0] };
  $('layNestBtn').click();
  const withPins = {
    poses: poses(), conflicts: conflicts(),
    pinnedMoved: JSON.stringify(poses()[0]) !== JSON.stringify(pinnedBefore),
    lockedRot: poses()[1].rot,
  };

  // The per-item controls round-trip through the panel rather than only
  // through the item.
  ed.sel = 0; app.syncLaySelPanel(0);
  const pinBox = { checked: $('laySelPin').checked, lock: $('laySelRotLock').checked };
  $('laySelPin').checked = false; fire('laySelPin');
  const unpinned = app.state.layout.items[0].pin === undefined;

  // --- profiles ---
  setUp([tool('a', 60, 30), tool('b', 50, 40)]);
  $('layNestProfile').value = 'Access'; fire('layNestProfile');
  const onAccess = {
    values: { ...app.nest.pack.values }, profile: app.nest.pack.profile,
    modified: app.nest.pack.modified,
    minWebField: $('layNestMinWeb').value, rotFree: $('layNestRotFree').checked,
    sel: $('layNestProfile').value,
  };
  // Editing any value keeps the name and adds "(modified)": never ambiguous
  // about whether Access is still in force.
  $('layNestMinWeb').value = '9'; fire('layNestMinWeb');
  const edited = {
    minWeb: app.nest.pack.values.minWeb, profile: app.nest.pack.profile,
    modified: app.nest.pack.modified,
    sel: $('layNestProfile').value,
    label: $('layNestProfile').selectedOptions[0].textContent,
  };
  // Saving names it; the built-in names are refused.
  const refused = app.nest.saveAs('Dense');
  const saved = app.nest.saveAs('Bench drawer');
  const afterSave = {
    profile: app.nest.pack.profile, modified: app.nest.pack.modified,
    custom: app.nest.custom().map(p => p.name),
    stored: JSON.parse(localStorage.getItem(app.nest.key) || '[]').length,
    delShown: !$('layNestDelProfile').hidden,
  };

  // --- what the project keeps ---
  // Resolved values, plus the name as provenance. Edit the profile afterward
  // and reopening the project must reproduce the drawer that was cut, not the
  // profile as it reads today.
  const savedProject = app.serializeProject(false);
  const geomBefore = poses();
  app.nest.saveAs('Bench drawer');  // re-save with the same name, then move it
  const bumped = app.nest.custom().map(p =>
    (p.name === 'Bench drawer' ? { ...p, values: { ...p.values, minWeb: 25 } } : p));
  localStorage.setItem(app.nest.key, JSON.stringify(bumped));
  app.loadProject(JSON.parse(savedProject));
  await new Promise(r => setTimeout(r, 400));
  const reopened = {
    minWeb: app.state.layout.pack.values.minWeb,
    profile: app.state.layout.pack.profile,
    modified: app.state.layout.pack.modified,
    poses: poses(), sameGeometry: JSON.stringify(poses()) === JSON.stringify(geomBefore),
  };

  // A project written before any of this existed has no `pack` key and must
  // open on the defaults rather than on whatever the last drawer used.
  const old = JSON.parse(savedProject);
  delete old.layout.pack;
  app.state.layout.pack.values = { ...app.state.layout.pack.values, minWeb: 17 };
  app.loadProject(old);
  await new Promise(r => setTimeout(r, 400));
  const legacy = {
    minWeb: app.state.layout.pack.values.minWeb,
    profile: app.state.layout.pack.profile,
  };

  // Deleting a custom profile leaves the settings where they are.
  const delWhy = app.nest.remove('Bench drawer');
  const afterDel = { custom: app.nest.custom().map(p => p.name) };

  // Hand the page back.
  if (beforeStore === null) localStorage.removeItem(app.nest.key);
  else localStorage.setItem(app.nest.key, beforeStore);
  app.loadProject(JSON.parse(restorePoint));
  await new Promise(r => setTimeout(r, 400));
  app.goStep(beforeStep);
  const restored = { step: app.state.step, items: app.state.layout.items.length };

  return {
    heaped, nested, undone, withPins, pinBox, unpinned,
    onAccess, edited, refused, saved, afterSave, reopened, legacy,
    delWhy, afterDel, restored,
  };
});

check('the Nest button sorts a heap of tools into a conflict-free drawer',
  nestUI.heaped.conflicts > 0 && nestUI.nested.conflicts === 0 &&
  JSON.stringify(nestUI.nested.poses) !== JSON.stringify(nestUI.heaped.poses) &&
  /Nested 4 tools/.test(nestUI.nested.info),
  `${nestUI.heaped.conflicts} conflicting before, ${nestUI.nested.conflicts} after — ` +
  `${nestUI.nested.info}`);

check('nesting is one undoable action and undo puts every tool back exactly',
  nestUI.nested.undoShown && !nestUI.undone.undoShown &&
  JSON.stringify(nestUI.undone.poses) === JSON.stringify(nestUI.heaped.poses),
  `undo offered ${nestUI.nested.undoShown}, back to the heap ` +
  `${JSON.stringify(nestUI.undone.poses) === JSON.stringify(nestUI.heaped.poses)}`);

check('a pinned tool keeps its exact place and a locked one keeps its angle',
  !nestUI.withPins.pinnedMoved && nestUI.withPins.lockedRot === 37 &&
  nestUI.withPins.conflicts === 0,
  `pinned moved ${nestUI.withPins.pinnedMoved}, locked tool still at ` +
  `${nestUI.withPins.lockedRot}°, conflicts ${nestUI.withPins.conflicts}`);

check('the per-item pin and angle lock read and write through the panel',
  nestUI.pinBox.checked === true && nestUI.pinBox.lock === false && nestUI.unpinned,
  `panel showed pinned ${nestUI.pinBox.checked}, unticking removed it ${nestUI.unpinned}`);

check('picking a profile seeds every value, and editing one says so without losing the name',
  nestUI.onAccess.profile === 'Access' && nestUI.onAccess.modified === false &&
  nestUI.onAccess.values.minWeb === 8 && nestUI.onAccess.values.comfortWeb === 12 &&
  nestUI.onAccess.rotFree === false && nestUI.onAccess.sel === 'Access' &&
  nestUI.edited.minWeb === 9 && nestUI.edited.profile === 'Access' &&
  nestUI.edited.modified === true && nestUI.edited.sel === '__modified__' &&
  nestUI.edited.label === 'Access (modified)',
  `Access seeded minWeb ${nestUI.onAccess.values.minWeb}; after an edit the picker reads ` +
  `“${nestUI.edited.label}”`);

check('a custom profile saves to its own key, and a built-in name is refused',
  /built-in/.test(nestUI.refused || '') && nestUI.saved === null &&
  nestUI.afterSave.profile === 'Bench drawer' && nestUI.afterSave.modified === false &&
  JSON.stringify(nestUI.afterSave.custom) === JSON.stringify(['Bench drawer']) &&
  nestUI.afterSave.stored === 1 && nestUI.afterSave.delShown,
  `refused “Dense”: ${nestUI.refused}; stored ${JSON.stringify(nestUI.afterSave.custom)}`);

// And the provenance stays honest in both directions. The numbers are the
// drawer's, so they do not move; but they no longer agree with the profile of
// that name, so the panel says "Bench drawer (modified)" rather than claiming
// a profile is in force that would now cut a different drawer.
check('a project keeps the resolved numbers, so editing a profile never moves a cut drawer',
  nestUI.reopened.minWeb === 9 && nestUI.reopened.profile === 'Bench drawer' &&
  nestUI.reopened.modified === true && nestUI.reopened.sameGeometry,
  `the profile was moved to minWeb 25 after saving; the project reopened on ` +
  `${nestUI.reopened.minWeb} and its geometry is unchanged ` +
  `(${nestUI.reopened.sameGeometry}), reading as “${nestUI.reopened.profile}` +
  `${nestUI.reopened.modified ? ' (modified)' : ''}”`);

check('a project written before packing settings existed opens on the defaults',
  nestUI.legacy.minWeb === 4 && nestUI.legacy.profile === 'Dense',
  `minWeb ${nestUI.legacy.minWeb}, profile ${nestUI.legacy.profile}`);

check('deleting a custom profile leaves the settings alone and hands the page back',
  nestUI.delWhy === null &&
  JSON.stringify(nestUI.afterDel.custom) === JSON.stringify([]) &&
  nestUI.restored.step === 3,
  `custom now ${JSON.stringify(nestUI.afterDel.custom)}, step ${nestUI.restored.step}`);

// ---------- bed tiling for the cut template ----------

const tiling = await page.evaluate(async () => {
  const { splitTiles, roundedRect } = await import('/js/holders.js');
  const { toTiledSVG } = await import('/js/exporters.js');
  // A 550 x 380 drawer on a 300 x 200 bed -> 2 x 2 tiles. A pocket sits
  // right across the naive midline (x 250..300) with clear foam either side
  // at 220..250 and 300..330, so the x seam must dodge it; nothing dodges
  // the y seam (a pocket spans y 150..230 across the whole window).
  const slab = roundedRect(275, 190, 550, 380, 6);
  const rect = (x0, y0, x1, y1) => [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }];
  const template = {
    slab, origin: { x: 0, y: 0 }, w: 550, h: 380,
    pockets: [
      { pocket: rect(250, 40, 300, 120), pillars: [] },   // across naive x seam at 275
      { pocket: rect(60, 150, 200, 230), pillars: [] },   // across every legal y seam (180..200)
      { pocket: rect(380, 260, 500, 340), pillars: [] },
    ],
  };
  const plan = splitTiles(template, 300, 200);
  const fits = splitTiles({ ...template, w: 280, h: 190 }, 300, 200);
  const svg = plan ? await toTiledSVG(plan.tiles, { name: 't' }).text() : '';
  const totalArea = plan ? plan.tiles.reduce((a, t) => a + t.slabs.reduce((b, l) => {
    let s = 0; for (let i = 0, n = l.length; i < n; i++) { const p = l[i], q = l[(i + 1) % n]; s += p.x * q.y - q.x * p.y; }
    return b + Math.abs(s) / 2; }, 0), 0) : 0;
  let slabArea = 0; for (let i = 0, n = slab.length; i < n; i++) { const p = slab[i], q = slab[(i + 1) % n]; slabArea += p.x * q.y - q.x * p.y; }
  return {
    plan: plan && { nx: plan.nx, ny: plan.ny, tiles: plan.tiles.length, seamsX: plan.seamsX, seamsY: plan.seamsY, crossings: plan.crossings },
    maxW: plan ? Math.max(...plan.tiles.map(t => t.w)) : 0,
    maxH: plan ? Math.max(...plan.tiles.map(t => t.h)) : 0,
    areaRatio: totalArea / (Math.abs(slabArea) / 2),
    fits,
    svgTiles: (svg.match(/<path /g) || []).length,
    svgLabels: (svg.match(/>A1 —|>A2 —|>B1 —|>B2 —/g) || []).length,
    svgLayers: /id="cut"/.test(svg) && /id="marks"/.test(svg),
  };
});
console.log('\nBed tiling (cut template)');
check('550 x 380 drawer on a 300 x 200 bed splits into 2 x 2 tiles that each fit',
  tiling.plan && tiling.plan.nx === 2 && tiling.plan.ny === 2 && tiling.plan.tiles === 4 &&
  tiling.maxW <= 300 + 1e-6 && tiling.maxH <= 200 + 1e-6,
  tiling.plan ? `${tiling.plan.nx} x ${tiling.plan.ny}, max tile ${tiling.maxW} x ${tiling.maxH}` : 'null');
check('x seam dodges the pocket straddling the midline (lands in the clear 250..300 gap edges)',
  tiling.plan && (tiling.plan.seamsX[0] <= 250 || tiling.plan.seamsX[0] >= 300),
  tiling.plan ? `seam x=${tiling.plan.seamsX[0]}` : 'null');
check('y seam has no clear line and reports exactly one pocket crossing',
  tiling.plan && tiling.plan.crossings === 1, tiling.plan ? `${tiling.plan.crossings} crossings` : 'null');
check('tiles cover the whole slab (area preserved)', near(tiling.areaRatio, 1, 0.01), `${tiling.areaRatio.toFixed(4)}`);
check('a layout that already fits the bed is not split', tiling.fits === null, String(tiling.fits));
check('tiled SVG carries one cut path per tile, A1..B2 labels, cut + marks layers',
  tiling.svgTiles === 4 && tiling.svgLabels === 4 && tiling.svgLayers,
  `${tiling.svgTiles} paths, ${tiling.svgLabels} labels`);

// UI: bed preset drives the readout and the tiled export.
await page.evaluate(() => window.__app.goStep(3));
const tilingUI = await page.evaluate(async () => {
  const app = window.__app;
  app.state.layout.container = { ...app.state.layout.container, type: 'rect', w: 550, h: 380, name: null };
  app.state.layout.items.length = 0;
  const outline = [{ x: 5, y: 5 }, { x: 85, y: 5 }, { x: 85, y: 55 }, { x: 5, y: 55 }];
  app.state.layout.items.push(
    { name: 'a', outer: outline, holes: [], circles: [], x: 120, y: 100, rot: 0, depth: 4, thickness: 5 },
    { name: 'b', outer: outline, holes: [], circles: [], x: 400, y: 280, rot: 0, depth: 4, thickness: 5 });
  const sel = document.getElementById('holderType');
  sel.value = 'layout'; sel.dispatchEvent(new Event('change'));
  await new Promise(r => setTimeout(r, 200));
  const bed = document.getElementById('layBed');
  bed.value = '300x200'; bed.dispatchEvent(new Event('change'));
  await new Promise(r => setTimeout(r, 200));
  return { info: document.getElementById('layBedInfo').textContent };
});
check('layout modal reports the tile count for the chosen bed',
  /4 tiles \(2 × 2\)/.test(tilingUI.info), tilingUI.info.slice(0, 90));
{
  const [dl] = await Promise.all([
    page.waitForEvent('download', { timeout: 10000 }).catch(() => null),
    page.click('#layExportSvgBtn'),
  ]);
  const p = dl ? await dl.path().catch(() => null) : null;
  const txt = p ? fs.readFileSync(p, 'utf8') : '';
  check('Template SVG downloads as a tiled file when the layout exceeds the bed',
    !!dl && /-drawer-tiles-2x2\.svg$/.test(dl.suggestedFilename()) && (txt.match(/<path /g) || []).length === 4,
    dl ? dl.suggestedFilename() : 'no download');
}
await page.evaluate(async () => {
  document.getElementById('layoutModal').hidden = true;
  const bed = document.getElementById('layBed'); bed.value = 'none'; bed.dispatchEvent(new Event('change'));
  window.__app.state.layout.items.length = 0;
  const sel = document.getElementById('holderType'); sel.value = 'none'; sel.dispatchEvent(new Event('change'));
  await new Promise(r => setTimeout(r, 300));
});


// ---------- labels UI: toggle, process, readout, and project round-trip ----------

const labUI = await page.evaluate(async () => {
  const st = window.__app.state;
  const $ = id => document.getElementById(id);
  document.getElementById('layoutModal').hidden = false;

  // A project saved before labels existed must not leave state.layout.labels
  // undefined — loadProject rebuilds state.layout wholesale.
  const legacy = JSON.parse(window.__app.serializeProject(false));
  delete legacy.layout.labels;
  window.__app.loadProject(legacy);
  const survivedLoad = !!st.layout.labels && st.layout.labels.enabled === false;

  // Needs something to label. Place one small tool well inside the container.
  st.layout.items = [{
    name: '13 mm', outer: [{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 50, y: 16 }, { x: 0, y: 16 }],
    holes: [], circles: [], thickness: 5, depth: null, rot: 0, x: 110, y: 55,
  }];
  window.__app.refreshLayoutEditor();

  $('layLabels').checked = true;
  $('layLabels').dispatchEvent(new Event('change'));
  const on = { enabled: st.layout.labels.enabled, fieldsShown: !$('layLabelFields').hidden };

  // Laser: 6 mm caps are fine, so the readout is informational.
  $('layLabelProcess').value = 'laser';
  $('layLabelProcess').dispatchEvent(new Event('change'));
  const laser = { cls: $('layLabelInfo').className, text: $('layLabelInfo').textContent, bitRow: !$('layLabelBitRow').hidden };

  // Router: the bit field appears and 6 mm is now too small.
  $('layLabelProcess').value = 'router';
  $('layLabelProcess').dispatchEvent(new Event('change'));
  const router = { cls: $('layLabelInfo').className, text: $('layLabelInfo').textContent, bitRow: !$('layLabelBitRow').hidden };

  // Raising the letters past 4x the bit clears it.
  $('layLabelHeight').value = '14';
  $('layLabelHeight').dispatchEvent(new Event('change'));
  const bigger = { cls: $('layLabelInfo').className, text: $('layLabelInfo').textContent };

  $('layLabels').checked = false;
  $('layLabels').dispatchEvent(new Event('change'));
  const off = { enabled: st.layout.labels.enabled, readout: $('layLabelInfo').textContent };
  st.layout.items.length = 0;
  window.__app.refreshLayoutEditor();
  document.getElementById('layoutModal').hidden = true;
  return { survivedLoad, on, laser, router, bigger, off };
});
check('a project saved before labels existed still loads with labelling off',
  labUI.survivedLoad, `${labUI.survivedLoad}`);
check('the labels checkbox turns labelling on and reveals its settings',
  labUI.on.enabled && labUI.on.fieldsShown, `enabled ${labUI.on.enabled}, fields ${labUI.on.fieldsShown}`);
check('the marking-bit field appears only for a router',
  labUI.laser.bitRow === false && labUI.router.bitRow === true,
  `laser ${labUI.laser.bitRow}, router ${labUI.router.bitRow}`);
check('6 mm caps read as fine on a laser and as a warning on a router',
  labUI.laser.cls === 'hint' && labUI.router.cls === 'warn' && /too small/.test(labUI.router.text),
  `laser "${labUI.laser.text}" / router "${labUI.router.text}"`);
check('raising the letters past 4x the bit clears the router warning',
  labUI.bigger.cls === 'hint', `"${labUI.bigger.text}"`);
check('turning labelling off clears the readout',
  labUI.off.enabled === false && labUI.off.readout === '', `"${labUI.off.readout}"`);

// ---------- layout label geometry (holders.js) ----------

const labGeom = await page.evaluate(async () => {
  const { layoutLabelGeometry, layoutPockets, itemLabelText } = await import('/js/holders.js');
  const rect = (w, h) => [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }];
  const items = [
    { name: '13 mm spanner', outer: rect(80, 20), holes: [], circles: [], x: 100, y: 60, rot: 0 },
    { name: 'pliers', label: 'LINESMAN', outer: rect(40, 30), holes: [], circles: [], x: 100, y: 160, rot: 0 },
  ];
  const pockets = layoutPockets(items, 0.5);
  const off = layoutLabelGeometry(items, pockets, { enabled: false });
  const on = layoutLabelGeometry(items, pockets, { enabled: true, height: 6, margin: 2 });

  // Auto placement sits clear of the pocket, centred on it.
  const p0 = pockets[0].pocket;
  let pMaxY = -Infinity, pMinX = Infinity, pMaxX = -Infinity;
  for (const p of p0) { pMaxY = Math.max(pMaxY, p.y); pMinX = Math.min(pMinX, p.x); pMaxX = Math.max(pMaxX, p.x); }
  const b0 = on[0].bounds;
  const clearsPocket = b0.minY > pMaxY;
  const centred = Math.abs((b0.minX + b0.maxX) / 2 - (pMinX + pMaxX) / 2) < 0.5;

  // An explicit offset wins and rides with the item.
  items[0].labelAt = { dx: 0, dy: -40 };
  const moved = layoutLabelGeometry(items, layoutPockets(items, 0.5), { enabled: true })[0];
  const atMoved = { x: moved.at.x, y: moved.at.y };
  items[0].x += 25;
  const shifted = layoutLabelGeometry(items, layoutPockets(items, 0.5), { enabled: true })[0];

  // follow:false keeps glyphs level even when the tool is turned.
  items[1].rot = 90;
  const pk = layoutPockets(items, 0.5);
  const level = layoutLabelGeometry(items, pk, { enabled: true }).find(L => L.i === 1);
  const turned = layoutLabelGeometry(items, pk, { enabled: true, follow: true }).find(L => L.i === 1);

  // Blank text is skipped rather than producing empty geometry.
  const blank = layoutLabelGeometry(
    [{ name: '   ', outer: rect(20, 20), holes: [], circles: [], x: 50, y: 50, rot: 0 }],
    layoutPockets([{ name: '   ', outer: rect(20, 20), holes: [], circles: [], x: 50, y: 50, rot: 0 }], 0.5),
    { enabled: true });

  return {
    offN: off.length, onN: on.length,
    texts: on.map(L => L.text), override: itemLabelText(items[1]),
    clearsPocket, centred,
    capH: b0.maxY - b0.minY,
    atMoved, shiftedX: shifted.at.x,
    levelRot: level.rot, turnedRot: turned.rot,
    blankN: blank.length,
  };
});
check('labelling off produces no geometry at all',
  labGeom.offN === 0 && labGeom.onN === 2, `${labGeom.offN} off, ${labGeom.onN} on`);
check('item label uses the override when set, the name otherwise',
  labGeom.texts[0] === '13 mm spanner' && labGeom.texts[1] === 'LINESMAN' &&
  labGeom.override === 'LINESMAN', labGeom.texts.join(' / '));
check('auto-placed label clears its pocket and centres on it',
  labGeom.clearsPocket && labGeom.centred, `clears ${labGeom.clearsPocket}, centred ${labGeom.centred}`);
check('glyphs are built to the requested cap height',
  near(labGeom.capH, 6, 0.35), `${labGeom.capH.toFixed(2)} mm`);
check('an explicit offset overrides auto and rides with the tool',
  near(labGeom.atMoved.y, 20, 0.01) && near(labGeom.shiftedX - labGeom.atMoved.x, 25, 0.01),
  `at ${labGeom.atMoved.x.toFixed(1)},${labGeom.atMoved.y.toFixed(1)} -> x ${labGeom.shiftedX.toFixed(1)}`);
check('follow:false keeps glyphs level on a rotated tool; follow:true turns them',
  labGeom.levelRot === 0 && labGeom.turnedRot === 90,
  `level ${labGeom.levelRot}, follow ${labGeom.turnedRot}`);
check('blank label text is skipped, not emitted as empty geometry',
  labGeom.blankN === 0, `${labGeom.blankN} emitted`);

// ---------- label conflicts + per-process legibility ----------

const labConf = await page.evaluate(async () => {
  const { layoutLabelGeometry, layoutLabelConflicts, layoutPockets, labelMinHeight } =
    await import('/js/holders.js');
  const rect = (w, h) => [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }];
  const container = [{ x: 0, y: 0 }, { x: 260, y: 0 }, { x: 260, y: 200 }, { x: 0, y: 200 }];
  const mk = (name, x, y, at) => ({ name, outer: rect(60, 20), holes: [], circles: [], x, y, rot: 0, ...(at ? { labelAt: at } : {}) });

  const kinds = (items, opts) => {
    const pk = layoutPockets(items, 0.5);
    const placed = layoutLabelGeometry(items, pk, { enabled: true, ...opts });
    return layoutLabelConflicts(container, pk, placed, { enabled: true, border: 5, ...opts })
      .map(x => x.kind);
  };

  // Clean: two well-separated tools, auto-placed labels.
  const clean = kinds([mk('AAA', 70, 50), mk('BBB', 70, 150)], {});
  // Label dragged straight onto its own pocket.
  const onPocket = kinds([mk('AAA', 70, 50, { dx: 0, dy: 0 })], {});
  // Label dragged off the edge of the container.
  const offEdge = kinds([mk('AAA', 70, 50, { dx: 0, dy: -60 })], {});
  // Two labels dragged onto the same spot.
  const collide = kinds([mk('AAA', 70, 40, { dx: 0, dy: 60 }), mk('BBB', 70, 160, { dx: 0, dy: -60 })], {});

  // Legibility: 6 mm caps are fine on a laser, illegible on a 1/8" router.
  const onLaser = kinds([mk('AAA', 70, 50)], { process: 'laser', height: 6 });
  const onRouter = kinds([mk('AAA', 70, 50)], { process: 'router', bitDia: 3.175, height: 6 });
  const bigOnRouter = kinds([mk('AAA', 70, 50)], { process: 'router', bitDia: 3.175, height: 14 });

  return {
    clean, onPocket, offEdge, collide, onLaser, onRouter, bigOnRouter,
    minLaser: labelMinHeight({ process: 'laser' }),
    minRouter: labelMinHeight({ process: 'router', bitDia: 3.175 }),
    minPrinted: labelMinHeight({ process: 'printed', nozzle: 0.4 }),
  };
});
check('well-placed labels report no issues',
  labConf.clean.length === 0, labConf.clean.join(',') || 'none');
check('a label dragged onto its own pocket is reported',
  labConf.onPocket.includes('pocket'), labConf.onPocket.join(',') || 'none');
check('a label pushed past the layout border is reported',
  labConf.offEdge.includes('border'), labConf.offEdge.join(',') || 'none');
check('two labels on the same spot are reported once, not twice',
  labConf.collide.filter(k => k === 'label').length === 1, labConf.collide.join(',') || 'none');
check('minimum cap height follows the process (laser 2, router 4x bit, printed 3x nozzle)',
  near(labConf.minLaser, 2, 0.01) && near(labConf.minRouter, 12.7, 0.01) &&
  near(labConf.minPrinted, 1.2, 0.01),
  `${labConf.minLaser} / ${labConf.minRouter} / ${labConf.minPrinted}`);
check('6 mm caps pass on a laser and fail on a 1/8 in router; 14 mm passes both',
  !labConf.onLaser.includes('tooSmall') && labConf.onRouter.includes('tooSmall') &&
  !labConf.bigOnRouter.includes('tooSmall'),
  `laser [${labConf.onLaser}] router [${labConf.onRouter}] big [${labConf.bigOnRouter}]`);

// ---------- labels carve into a PRINTED insert, watertight ----------

const labMesh = await page.evaluate(async () => {
  const { buildLayoutInsert, layoutLabelGeometry, layoutPockets, roundedRect } =
    await import('/js/holders.js');
  const rect = (w, h) => [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }];
  const container = { outer: roundedRect(110, 70, 220, 140, 6) };
  const items = [{ name: '13 mm', outer: rect(60, 20), holes: [], circles: [], x: 110, y: 50, rot: 0, depth: 5 }];
  const pockets = layoutPockets(items, 0.5);
  const placed = layoutLabelGeometry(items, pockets, { enabled: true, height: 6, margin: 2 });
  const labels = placed.map(L => ({ loops: L.loops, mode: 'deboss', face: 'top', size: 0.6 }));

  const openEdges = m => {
    const use = new Map();
    const k = i => `${m.positions[i*3].toFixed(4)},${m.positions[i*3+1].toFixed(4)},${m.positions[i*3+2].toFixed(4)}`;
    for (let t = 0; t < m.indices.length; t += 3) {
      const a = k(m.indices[t]), b = k(m.indices[t+1]), c = k(m.indices[t+2]);
      for (const [u, v] of [[a,b],[b,c],[c,a]]) {
        const key = u < v ? `${u}|${v}` : `${v}|${u}`;
        use.set(key, (use.get(key) || 0) + 1);
      }
    }
    let bad = 0;
    for (const n of use.values()) if (n !== 2) bad++;
    return bad;
  };

  const bare = buildLayoutInsert(container, items, { clearance: 0.5, floor: 3, border: 5 });
  const withL = buildLayoutInsert(container, items, { clearance: 0.5, floor: 3, border: 5, labels });
  return {
    placedN: placed.length,
    bareTris: bare.indices.length / 3, labTris: withL.indices.length / 3,
    bareBad: openEdges(bare), labBad: openEdges(withL),
    sameSlab: Math.abs(bare.stats.slab.w - withL.stats.slab.w) < 1e-6 &&
              Math.abs(bare.stats.slab.thickness - withL.stats.slab.thickness) < 1e-6,
    warns: (withL.stats.warnings || []).join(' | '),
  };
});
check('a labelled printed insert stays watertight',
  labMesh.labBad === 0 && labMesh.bareBad === 0,
  `${labMesh.labBad} open edges labelled, ${labMesh.bareBad} bare`);
check('the label actually adds geometry to the insert',
  labMesh.placedN === 1 && labMesh.labTris > labMesh.bareTris,
  `${labMesh.bareTris} -> ${labMesh.labTris} triangles`);
check('labelling does not change the insert\'s slab size or thickness',
  labMesh.sameSlab, `${labMesh.sameSlab}${labMesh.warns ? ' — ' + labMesh.warns : ''}`);

// ---------- labels reach the cut files on their own engrave layer ----------

const labSvg = await page.evaluate(async () => {
  const { splitTiles, layoutLabelGeometry, layoutPockets, roundedRect } = await import('/js/holders.js');
  const { toTiledSVG, toSVG } = await import('/js/exporters.js');
  const rect = (x0, y0, x1, y1) => [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }];
  const items = [
    { name: '13 mm', outer: rect(0, 0, 60, 20), holes: [], circles: [], x: 120, y: 90, rot: 0 },
    { name: '15 mm', outer: rect(0, 0, 60, 20), holes: [], circles: [], x: 400, y: 280, rot: 0 },
  ];
  const pockets = layoutPockets(items, 0.5);
  const template = {
    slab: roundedRect(275, 190, 550, 380, 6),
    pockets: pockets.map(p => ({ pocket: p.pocket, pillars: p.pillars })),
    origin: { x: 0, y: 0 }, w: 550, h: 380,
  };
  const shift = pts => pts;
  const loops = layoutLabelGeometry(items, pockets, { enabled: true, height: 8 }).flatMap(L => L.loops);

  const bare = splitTiles(template, 300, 200, {});
  const withL = splitTiles(template, 300, 200, { labels: loops });
  const bareSvg = await toTiledSVG(bare.tiles, { name: 't' }).text();
  const labSvgTxt = await toTiledSVG(withL.tiles, { name: 't' }).text();

  // Tiles must not grow because something was engraved on them.
  const sameExtents = bare.tiles.every((t, i) =>
    Math.abs(t.w - withL.tiles[i].w) < 1e-6 && Math.abs(t.h - withL.tiles[i].h) < 1e-6);

  // A label straddling a seam lands on both tiles.
  const wide = layoutLabelGeometry(
    [{ name: 'SPANS THE SEAM HERE', outer: rect(0, 0, 200, 20), holes: [], circles: [], x: 275, y: 250, rot: 0 }],
    layoutPockets([{ name: 'SPANS THE SEAM HERE', outer: rect(0, 0, 200, 20), holes: [], circles: [], x: 275, y: 250, rot: 0 }], 0.5),
    { enabled: true, height: 10 }).flatMap(L => L.loops);
  const split = splitTiles(template, 300, 200, { labels: wide });
  const tilesWithMarks = split.tiles.filter(t => t.marks.length).length;

  // Plain (non-tiled) template SVG.
  const plainBare = await toSVG(template.slab, [], 550, 380, {}).text();
  const plainLab = await toSVG(template.slab, [], 550, 380, { engrave: loops }).text();

  return {
    bareHasEngrave: /id="engrave"/.test(bareSvg),
    labHasEngrave: /id="engrave"/.test(labSvgTxt),
    labHasPathData: /id="engrave"[\s\S]*?<path [^>]*d="M [\d.]/.test(labSvgTxt),
    plainHasPathData: /id="engrave"[\s\S]*?<path [^>]*d="M [\d.]/.test(plainLab),
    usesText: /<text[^>]*>[^<]*13 mm/.test(labSvgTxt),
    sameExtents, tilesWithMarks,
    plainBareHasEngrave: /id="engrave"/.test(plainBare),
    plainLabHasEngrave: /id="engrave"/.test(plainLab),
    bareLen: bareSvg.length,
  };
});
check('an unlabelled cut template has no engrave layer at all',
  !labSvg.bareHasEngrave && !labSvg.plainBareHasEngrave,
  `tiled ${labSvg.bareHasEngrave}, plain ${labSvg.plainBareHasEngrave}`);
check('a labelled cut template gains an engrave layer in both export paths',
  labSvg.labHasEngrave && labSvg.plainLabHasEngrave,
  `tiled ${labSvg.labHasEngrave}, plain ${labSvg.plainLabHasEngrave}`);
check('labels are emitted as path outlines, not <text> (machine needs no font)',
  labSvg.labHasPathData && labSvg.plainHasPathData && !labSvg.usesText,
  `tiled paths ${labSvg.labHasPathData}, plain paths ${labSvg.plainHasPathData}, text ${labSvg.usesText}`);
check('engraving never changes a tile\'s extents',
  labSvg.sameExtents, `${labSvg.sameExtents}`);
check('a label straddling a seam is split across both tiles',
  labSvg.tilesWithMarks >= 2, `${labSvg.tilesWithMarks} tiles carry marks`);

// ---------- puzzle tabs on tile seams ----------

const puzzle = await page.evaluate(async () => {
  const { splitTiles, roundedRect } = await import('/js/holders.js');
  const slab = roundedRect(275, 190, 550, 380, 6);
  const rect = (x0, y0, x1, y1) => [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }];
  const template = {
    slab, origin: { x: 0, y: 0 }, w: 550, h: 380,
    pockets: [
      { pocket: rect(60, 40, 200, 120), pillars: [] },
      { pocket: rect(380, 260, 500, 340), pillars: [] },
    ],
  };
  const tabs = { enabled: true, head: 12, neck: 7, depth: 12, spacing: 80, fit: 0 };
  const plan = splitTiles(template, 300, 200, { tabs });
  if (!plan) return { plan: null };
  const area = loops => loops.reduce((acc, l) => {
    let s = 0; for (let i = 0, n = l.length; i < n; i++) { const p = l[i], q = l[(i + 1) % n]; s += p.x * q.y - q.x * p.y; }
    return acc + Math.abs(s) / 2; }, 0);
  const inside = (pt, loop) => {
    let ins = false;
    for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) {
      const a = loop[i], b = loop[j];
      if ((a.y > pt.y) !== (b.y > pt.y) && pt.x < (b.x - a.x) * (pt.y - a.y) / (b.y - a.y) + a.x) ins = !ins;
    }
    return ins;
  };
  const byCell = Object.fromEntries(plan.tiles.map(t => [`${t.col},${t.row}`, t]));
  const A1 = byCell['0,0'], A2 = byCell['1,0'];
  const sx = plan.seamsX[0];
  // A1 (giver) extends past the seam by the reach; A2's socket bites its
  // left edge. Probe the first knob: a point 6 mm past the seam at the
  // knob's centre must be inside A1's slab and outside A2's.
  let knobCentre = null;
  for (const l of A1.slabs) for (const p of l) {
    if (p.x > A1.w - 0.5 && p.x > sx - A1.x0 + 8) { knobCentre = knobCentre || p; }
  }
  const probeA1 = knobCentre ? { x: sx - A1.x0 + 6, y: knobCentre.y } : null;
  const probeA2 = knobCentre ? { x: sx - A2.x0 + 6, y: knobCentre.y + (A1.y0 - A2.y0) } : null;
  const inA1 = probeA1 && A1.slabs.some(l => inside(probeA1, l));
  const inA2 = probeA2 && A2.slabs.some(l => inside(probeA2, l));
  // Tight fit: socket shrinks, so the pair's total area goes UP by the
  // ring between knob and shrunken socket; fit 0 keeps it exactly even.
  const planTight = splitTiles(template, 300, 200, { tabs: { ...tabs, fit: -0.3 } });
  const slabArea = area([slab]);
  const total = plan.tiles.reduce((a, t) => a + area(t.slabs), 0);
  const totalTight = planTight.tiles.reduce((a, t) => a + area(t.slabs), 0);
  const noTabs = splitTiles(template, 300, 200);
  return {
    plan: { tabCount: plan.tabCount, tabless: plan.tabless, nx: plan.nx, ny: plan.ny },
    maxW: Math.max(...plan.tiles.map(t => t.w)), maxH: Math.max(...plan.tiles.map(t => t.h)),
    A1w: A1.w, cellW: sx - A1.x0,
    inA1, inA2,
    areaRatio: total / slabArea, tightRatio: totalTight / slabArea,
    noTabWidth: Math.max(...noTabs.tiles.map(t => t.w)),
    noTabSeams: [noTabs.seamsX[0], noTabs.seamsY[0]], noTabGrid: [noTabs.nx, noTabs.ny],
  };
});
console.log('\nPuzzle tabs on seams');
check('tabs are placed on every internal seam segment (2 x 2 tiles -> 4 seam segments)',
  puzzle.plan && puzzle.plan.tabCount >= 4 && puzzle.plan.tabless === 0,
  puzzle.plan ? `${puzzle.plan.tabCount} tabs, ${puzzle.plan.tabless} tabless` : 'null');
check('the giving tile grows by the knob reach and still fits the bed',
  puzzle.plan && near(puzzle.A1w, puzzle.cellW + 12, 0.05) && puzzle.maxW <= 300 + 1e-6 && puzzle.maxH <= 200 + 1e-6,
  `A1 ${puzzle.A1w?.toFixed(1)} = cell ${puzzle.cellW?.toFixed(1)} + 12; max ${puzzle.maxW?.toFixed(1)} x ${puzzle.maxH?.toFixed(1)}`);
check('knob is solid on the giver and a matching socket on the receiver',
  puzzle.inA1 === true && puzzle.inA2 === false, `A1 ${puzzle.inA1}, A2 ${puzzle.inA2}`);
check('fit 0 keeps total area exactly; a tight fit (−0.3) adds interference',
  near(puzzle.areaRatio, 1, 0.002) && puzzle.tightRatio > puzzle.areaRatio + 0.0002,
  `${puzzle.areaRatio?.toFixed(5)} vs tight ${puzzle.tightRatio?.toFixed(5)}`);
check('only the giving tiles shrink for tabs: both plans stay 2 x 2, the no-tab seams sit at the clearance optimum (290 x 190)',
  puzzle.plan && puzzle.plan.nx === 2 && puzzle.plan.ny === 2 &&
  puzzle.noTabGrid[0] === 2 && puzzle.noTabGrid[1] === 2 &&
  puzzle.noTabSeams[0] === 290 && puzzle.noTabSeams[1] === 190 && puzzle.noTabWidth <= 300 + 1e-6,
  `tabs ${puzzle.plan?.nx}x${puzzle.plan?.ny}, none ${puzzle.noTabGrid?.join('x')} seams ${puzzle.noTabSeams?.join(',')} max w ${puzzle.noTabWidth?.toFixed(1)}`);

// ---------- theme: dark → light → auto (follow system) ----------
console.log('\nTheme cycle');
const themeCycle = await page.evaluate(() => {
  const btn = document.getElementById('themeToggle');
  const light = () => document.documentElement.classList.contains('light');
  const s0 = { icon: btn.textContent, light: light() };          // default: dark
  btn.click();
  const s1 = { icon: btn.textContent, light: light() };          // light
  btn.click();
  const s2 = { icon: btn.textContent, light: light() };          // auto
  let saved = null;
  try { saved = localStorage.getItem('2p5d.theme'); } catch { /* blocked */ }
  return { s0, s1, s2, saved };
});
check('cycle: dark (default) → light → auto, choice persisted',
  themeCycle.s0.icon === '🌙' && !themeCycle.s0.light &&
  themeCycle.s1.icon === '☀' && themeCycle.s1.light &&
  themeCycle.s2.icon === '🌗' && themeCycle.saved === 'auto',
  `${themeCycle.s0.icon}→${themeCycle.s1.icon}→${themeCycle.s2.icon}, saved ${themeCycle.saved}`);
await page.emulateMedia({ colorScheme: 'light' });
await new Promise(r => setTimeout(r, 400));
const autoLight = await page.evaluate(() => ({
  cls: document.documentElement.classList.contains('light'),
  mq: window.matchMedia('(prefers-color-scheme: light)').matches,
}));
await page.emulateMedia({ colorScheme: 'dark' });
await new Promise(r => setTimeout(r, 400));
const autoDark = await page.evaluate(() => ({
  cls: document.documentElement.classList.contains('light'),
  mq: window.matchMedia('(prefers-color-scheme: light)').matches,
}));
check('auto mode follows live system changes', autoLight.cls && !autoDark.cls,
  `light cls/mq ${autoLight.cls}/${autoLight.mq}, dark cls/mq ${autoDark.cls}/${autoDark.mq}`);
await page.evaluate(() => document.getElementById('themeToggle').click()); // back to dark

console.log('\nConsole errors:', consoleErrors.length ? consoleErrors : 'none');
if (consoleErrors.length) failures++;

await browser.close();
server.close();

// Print the total so commit messages can quote it instead of hand-counting;
// two past commits stated a count that was one off the actual run.
console.log(`\n${checks} checks run.`);
console.log(failures === 0 ? `All ${checks} checks passed ✔` : `${failures} of ${checks} check(s) FAILED ✘`);
process.exit(failures === 0 ? 0 : 1);
