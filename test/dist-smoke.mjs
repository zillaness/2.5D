// Smoke-test the SHIPPED bundle, from a file:// URL, which is how it is meant
// to be used and is the one thing test/e2e.mjs never does: it serves the source
// tree over http and has no reference to dist/ anywhere in its 12,000 lines.
// So a bug that only exists in the bundle, an export tree-shaken out for having
// no path from js/main.js, or anything that needs an origin, would pass the
// whole suite and fail for every user who downloaded the file.
//
//   npm run smoke      (rebuilds, then runs this)
//
// Deliberately shallow. It drives one path through each thing the bundle has to
// carry and fails on any page error; e2e.mjs is where behaviour is pinned down.

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const errs = [];
page.on('pageerror', e => errs.push(String(e)));
page.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
await page.goto('file:///home/user/2.5D/dist/2.5d-local.html');
await page.waitForFunction(() => window.__app && window.ClipperLib, { timeout: 20000 });
const out = await page.evaluate(async () => {
  const app = window.__app;
  const has = o => Object.keys(o || {});
  // Drive the real scan pipeline end to end inside the SHIPPED bundle.
  const PPM = 4, DW = 120, DH = 100;
  const c = document.createElement('canvas');
  c.width = DW * PPM; c.height = DH * PPM;
  const g = c.getContext('2d');
  g.fillStyle = '#b0b0b0'; g.fillRect(0, 0, c.width, c.height);
  g.fillStyle = '#2c2c2c';
  for (const [x, y, w, h] of [[12, 10, 30, 12], [50, 10, 24, 14], [84, 10, 22, 22]]) {
    g.fillRect(x * PPM, y * PPM, w * PPM, h * PPM);
  }
  app.state.rect = { canvas: c, pxPerMm: PPM };
  app.state.diffMap = null;
  app.state.reference = 'rect';
  app.state.paper = { ...app.state.paper, size: 'custom', customW: DW, customH: DH };
  app.state.scan = { on: true, active: false, parts: [] };
  app.traceEditor.setRectified(c, PPM);
  const parts = app.scan.run();
  const entered = app.scan.review(parts);
  const placed = app.scan.accept();
  // And the async nester, in the same bundle.
  const before = app.state.layout.items.map(i => ({ x: i.x, y: i.y }));
  for (const it of app.state.layout.items) delete it.pin;
  const nested = await app.nest.run();
  // And the autosave slot.
  const wrote = await app.autosave.write({ text: '{"app":"2.5D"}', name: 'smoke', at: 1 });
  const read = await app.autosave.read();
  await app.autosave.done();
  return {
    surfaces: ['scan', 'nest', 'autosave', 'lib', 'queue'].filter(k => app[k]),
    parts: parts.length, entered, placed: placed && placed.placed,
    nested: nested && nested.placed, autosave: !!(wrote && read && read.name === 'smoke'),
    version: app.APP_VERSION,
  };
});
await browser.close();
console.log(JSON.stringify(out, null, 1));
if (errs.length) { console.error('PAGE ERRORS:'); errs.slice(0, 8).forEach(e => console.error(' ', e)); process.exit(1); }
console.log('dist bundle: clean');
