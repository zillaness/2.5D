// Freeze calibration layout v1: write the reference geometry the suite
// compares against on every run (docs/calibration_and_backlog_prd_v1.2.md,
// criterion 15). Run ONCE when a layout version ships, and never again for
// that version: printed sheets depend on it. A change to js/calibSheet.js
// that moves any rectangle or cell fails the suite until a v2 is added.
//
//   node test/freeze-layout.mjs            refuses if the fixture exists
//   node test/freeze-layout.mjs --force    rewrites it (a new layout version only)

import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { fileURLToPath } from 'url';
import { layoutGeometry, cellDigestText, LAYOUT_VERSION, PAPER_CODES } from '../js/calibSheet.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const FIXTURE = path.join(root, 'test', 'fixtures', `calib_layout_v${LAYOUT_VERSION}.json`);
export const FROZEN_MESSAGE = `Layout v${LAYOUT_VERSION} is frozen; printed sheets depend on it. Add a v2 instead.`;

// The stocks whose layout is locked. Others follow the same rules and are
// locked the day the print panel offers them.
export const FROZEN_STOCKS = ['letter', 'A4'];

export function referenceLayout() {
  const stocks = {};
  for (const paper of FROZEN_STOCKS) {
    const g = layoutGeometry(paper);
    stocks[paper] = {
      code: PAPER_CODES[paper], w: g.w, h: g.h,
      frame: g.frame, window: g.window, strip: g.strip, ticks: g.ticks, ruler: g.ruler, text: g.text,
      track: g.track, words: g.words,
      sides: g.sides.map(s => ({
        side: s.side, words: s.words, start: s.start,
        list: s.list.map(w => ({
          position: w.position, index: w.index, start: w.start,
          clock: w.cells.filter(c => c.row === 0).map(c => (c.clock ? 'B' : 'W')).join(''),
        })),
      })),
      cellDigest: createHash('sha256').update(cellDigestText(g)).digest('hex'),
      cells: g.sides.reduce((n, s) => n + s.list.reduce((m, w) => m + w.cells.length, 0), 0),
    };
  }
  return { layout: LAYOUT_VERSION, stocks };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const force = process.argv.includes('--force');
  if (fs.existsSync(FIXTURE) && !force) {
    console.error(`${path.relative(root, FIXTURE)} exists. ${FROZEN_MESSAGE}`);
    process.exit(1);
  }
  fs.writeFileSync(FIXTURE, JSON.stringify(referenceLayout(), null, 1) + '\n');
  console.log(`wrote ${path.relative(root, FIXTURE)}`);
}
