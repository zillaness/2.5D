// Times nestLayout() on a 30-item fixture under both shipped profiles, so the
// nest-speed gap recorded in BURNDOWN.md and README "Known gaps" is a measured
// number rather than a remembered one. Not part of `npm test`: it reports, it
// does not assert, and its timings are machine-dependent.
//
//   node test/nest-bench.mjs [path-to-chromium]

import { createRequire } from 'module';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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

const exe = process.argv[2] || process.env.CHROMIUM_PATH || (() => {
  // Same search the suite does: a pinned playwright build sits in its own
  // versioned directory, so glob the parent rather than hard-coding a version.
  const base = '/opt/pw-browsers';
  if (fs.existsSync(base)) {
    for (const d of fs.readdirSync(base)) {
      for (const sub of ['chrome-linux/chrome', 'chrome-linux/headless_shell']) {
        const p = path.join(base, d, sub);
        if (fs.existsSync(p)) return p;
      }
    }
  }
  return undefined;
})();

const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
const page = await browser.newPage();
await page.goto(`http://127.0.0.1:${server.address().port}/index.html`);

const out = await page.evaluate(async () => {
  const { nestLayout, roundedRect, PACK_PROFILES, packProfileValues } =
    await import('/js/holders.js');
  const rect = (w, h) => [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }];
  const ell = (w, h, t) => [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: t },
    { x: t, y: t }, { x: t, y: h }, { x: 0, y: h }];
  // A finger notch on every tool, because the Access profile sets notchPolicy
  // 'require' and a drawer packed under it is exactly a drawer whose tools have
  // notches. Without them the disc tests in validAt never run and the profile
  // is measured doing less work than it does in use.
  const mk = (name, outer) => {
    let minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9;
    for (const q of outer) {
      minX = Math.min(minX, q.x); maxX = Math.max(maxX, q.x);
      minY = Math.min(minY, q.y); maxY = Math.max(maxY, q.y);
    }
    return { name, outer, holes: [], circles: [], x: 0, y: 0, rot: 0,
      depth: null, thickness: 6,
      notch: { dia: 20, x: (minX + maxX) / 2, y: (minY + maxY) / 2 } };
  };

  // Thirty tools: the twelve-tool mixed set of the suite's own fixture, in
  // two and a half copies, so shapes repeat the way a real drawer's do.
  const items = [];
  for (let k = 0; k < 30; k++) {
    const j = k % 12;
    items.push(j % 3 === 0 ? mk('L' + k, ell(50 + j, 30 + j, 12))
      : j % 3 === 1 ? mk('r' + k, rect(60 - j, 18 + j))
        : mk('s' + k, rect(24 + j, 24 + j)));
  }
  const drawer = roundedRect(300, 210, 600, 420, 12);

  const rectDrawer = [{ x: 0, y: 0 }, { x: 600, y: 0 }, { x: 600, y: 420 }, { x: 0, y: 420 }];
  const access = packProfileValues('Access');
  const runs = [];
  for (const prof of PACK_PROFILES) runs.push([prof.name, drawer, packProfileValues(prof.name)]);
  // One factor changed at a time against Access, to see which of the three
  // causes the README records is actually paying for the time.
  runs.push(['Acc -label', drawer, { ...access, labelSpace: 'none' }]);
  runs.push(['Acc -notch', drawer, { ...access, notchPolicy: 'warn' }]);
  runs.push(['Acc rect', rectDrawer, access]);
  runs.push(['Acc bare', rectDrawer, { ...access, labelSpace: 'none', notchPolicy: 'warn' }]);

  // Warm up before timing anything. The first pack through a fresh page pays
  // for JIT compilation of the whole geometry path, and on this fixture that
  // was worth more than every optimisation being measured: timed cold, a
  // config could read 2.7 s in the second row and 0.5 s in the seventh with
  // nothing at all changed between them. Every reported number is the MINIMUM
  // of several warm runs, which is the one least polluted by GC.
  const REPS = 5;
  for (let w = 0; w < 3; w++) for (const [, c, v] of runs) nestLayout(c, v === access ? v : v, items.slice(0, 12)) && 0;
  for (const [, c, v] of runs) nestLayout(c, items, v);

  const rows = [];
  for (const [label, cont, values] of runs) {
    let best = Infinity, res = null;
    for (let k = 0; k < REPS; k++) {
      const t0 = performance.now();
      res = nestLayout(cont, items, values);
      best = Math.min(best, performance.now() - t0);
    }
    rows.push({ profile: label, ms: Math.round(best),
      placed: res.placements.length, of: items.length,
      tests: res.stats && res.stats.tests });
  }
  return rows;
});

for (const r of out) {
  console.log(`${r.profile.padEnd(11)} ${String(r.ms).padStart(6)} ms   ` +
    `${r.placed}/${r.of} placed   ${r.tests} tests`);
}

await browser.close();
server.close();
