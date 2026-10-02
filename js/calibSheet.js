// The calibration sheet: layout v1, its code, and the SVG that prints it
// (docs/calibration_and_backlog_prd_v1.2.md, Part A, plan step 3).
//
// Everything printed goes around the edge, because ink under the object is
// object to the segmenter. From the paper edge inward, in millimetres: 10 of
// clean paper, a 2 mm frame line, a 1 mm gap, a 1.5 mm clock row, two 1.5 mm
// data rows, a 1 mm quiet gap, and the window. The bottom carries a label
// strip with a ruler. Every rule is an inset from the paper edge, so a stock
// added to the paper table later needs no new layout version.
//
// LAYOUT v1 IS FROZEN. Printed sheets outlive the code: a sheet printed today
// must still be read by the app in years. test/fixtures/calib_layout_v1.json
// holds the geometry this module produced the day it shipped, and the suite
// regenerates and compares. Any change here fails it with "Layout v1 is
// frozen; printed sheets depend on it. Add a v2 instead."
//
// Pure: no DOM, no Date, no Math.random. The print job is passed in by the
// caller, which draws it from an injected clock, so tests can fix it.

import { PAPER_SIZES } from './paperSizes.js';

export const LAYOUT_VERSION = 1;

// Distances from the paper edge, in mm.
export const LAYOUT_V1 = Object.freeze({
  margin: 10,          // clean paper, and most printers' hardware margin
  frameInner: 12,      // the frame line's ink runs from margin to frameInner
  frameWidth: 2,
  trackStart: 13,      // clock row starts here, after a 1 mm gap
  cell: 1.5,           // every cell, clock and data
  rows: 3,             // clock row, then two data rows
  quiet: 1,            // the quiet gap after the track
  windowInset: 18.5,   // trackStart + 3 cells + quiet
  stripHeight: 16,     // the label and ruler strip, bottom only
  wordCells: 18,       // one missing tooth plus 17 data cells
  dataCells: 17,
  bitsPerWord: 34,
  rulerMm: 150,
});

// The paper codes the four-bit field carries. 0 is reserved; the others are
// frozen with the layout, so new stocks append and never renumber.
export const PAPER_CODES = Object.freeze({ letter: 1, A4: 2, legal: 3, A3: 4, tabloid: 5, A5: 6 });
export const PAPER_BY_CODE = Object.freeze(Object.fromEntries(
  Object.entries(PAPER_CODES).map(([k, v]) => [v, k])));

// Field widths, MSB first, in the order they are written.
export const WORD_FIELDS = Object.freeze([
  ['version', 4], ['paper', 4], ['sheet', 4], ['job', 8], ['position', 6],
]);
const PAYLOAD_BITS = 26;
const CRC_BITS = 8;

// ---------- the code ----------

// CRC-8, polynomial x^8 + x^2 + x + 1 (0x07), init 0, no reflection, run
// over the 26 payload bits MSB first. Any single-bit error, and any burst up
// to eight bits, fails it.
export function crc8Bits(bits) {
  let crc = 0;
  for (const b of bits) {
    const top = ((crc >> 7) & 1) ^ (b & 1);
    crc = ((crc << 1) & 0xff) ^ (top ? 0x07 : 0);
  }
  return crc;
}

const toBits = (value, n) => {
  const out = [];
  for (let i = n - 1; i >= 0; i--) out.push((value >> i) & 1);
  return out;
};
const fromBits = bits => bits.reduce((v, b) => (v << 1) | (b & 1), 0);

// The 34 bits of one code word, MSB first: five fields then the CRC.
export function encodeWord(fields) {
  const bits = [];
  for (const [name, width] of WORD_FIELDS) {
    const v = Number(fields[name]);
    if (!Number.isInteger(v) || v < 0 || v >= (1 << width)) throw new Error(`${name} out of range: ${fields[name]}`);
    bits.push(...toBits(v, width));
  }
  bits.push(...toBits(crc8Bits(bits), CRC_BITS));
  return bits;
}

// The fields of a 34-bit word, or null when the checksum fails, when the
// layout version is not one this reader knows, or when the paper code is
// unassigned. Never a guess: a word with one bad cell is dropped.
export function decodeWord(bits) {
  if (!Array.isArray(bits) || bits.length !== PAYLOAD_BITS + CRC_BITS) return null;
  const payload = bits.slice(0, PAYLOAD_BITS);
  if (crc8Bits(payload) !== fromBits(bits.slice(PAYLOAD_BITS))) return null;
  const out = {};
  let at = 0;
  for (const [name, width] of WORD_FIELDS) {
    out[name] = fromBits(payload.slice(at, at + width));
    at += width;
  }
  if (out.version !== LAYOUT_VERSION) return null;
  if (!PAPER_BY_CODE[out.paper]) return null;
  return out;
}

// Where bit b of a word sits: data row 0 or 1 (nearer the frame first), cell
// 1 to 17 (cell 0 is the missing tooth, white in every row).
export function bitCell(b) {
  return { row: Math.floor(b / LAYOUT_V1.dataCells), k: 1 + (b % LAYOUT_V1.dataCells) };
}

// The clock row's pattern within a word: cell k is black for even k from 2.
// Cells 17, 0 and 1 are white, so three white clock cells in a row mark a
// word boundary and happen nowhere else.
export const clockBlack = k => k >= 2 && k % 2 === 0;

// ---------- the geometry ----------

export const SIDES = Object.freeze(['top', 'right', 'bottom', 'left']);

// A stock's layout: every zone, every word and every cell, in portrait
// millimetres from the paper's top-left corner, y down. Words run clockwise
// from the top-left corner and are centred along each side.
export function layoutGeometry(paperKey) {
  const L = LAYOUT_V1;
  const p = PAPER_SIZES[paperKey];
  if (!p || !PAPER_CODES[paperKey]) throw new Error(`no layout for paper ${paperKey}`);
  const W = Math.min(p.w, p.h), H = Math.max(p.w, p.h);
  const wordMm = L.wordCells * L.cell;
  const r = x => Math.round(x * 1e6) / 1e6;
  const rect = (x, y, w, h) => ({ x: r(x), y: r(y), w: r(w), h: r(h) });

  const frameCentre = L.margin + L.frameWidth / 2;
  const frame = {
    outer: rect(L.margin, L.margin, W - 2 * L.margin, H - 2 * L.margin),
    inner: rect(L.frameInner, L.frameInner, W - 2 * L.frameInner, H - 2 * L.frameInner),
    centre: rect(frameCentre, frameCentre, W - 2 * frameCentre, H - 2 * frameCentre),
    width: L.frameWidth,
  };
  const win = rect(L.windowInset, L.windowInset, W - 2 * L.windowInset, H - L.windowInset - L.stripHeight - L.windowInset);
  const strip = rect(L.windowInset, H - L.windowInset - L.stripHeight, W - 2 * L.windowInset, L.stripHeight);

  // Row bands: distance from the paper edge for row 0 (clock), 1 and 2.
  const rowInset = row => L.trackStart + row * L.cell;
  const sides = [];
  let position = 0;
  for (const side of SIDES) {
    const along = side === 'top' || side === 'bottom' ? W : H;
    const run = along - 2 * (L.trackStart + L.rows * L.cell + L.quiet);
    const n = Math.floor(run / wordMm);
    const start = (along - n * wordMm) / 2;
    const words = [];
    for (let j = 0; j < n; j++) {
      const s = start + j * wordMm;
      const cells = [];
      for (let k = 0; k < L.wordCells; k++) {
        for (let row = 0; row < L.rows; row++) {
          const a = s + k * L.cell, inset = rowInset(row);
          let c;
          if (side === 'top') c = rect(a, inset, L.cell, L.cell);
          else if (side === 'right') c = rect(W - inset - L.cell, a, L.cell, L.cell);
          else if (side === 'bottom') c = rect(W - a - L.cell, H - inset - L.cell, L.cell, L.cell);
          else c = rect(inset, H - a - L.cell, L.cell, L.cell);
          cells.push({ k, row, ...c, clock: row === 0 ? clockBlack(k) : null });
        }
      }
      words.push({ position, side, index: j, start: r(s), cells });
      position++;
    }
    sides.push({ side, words: n, start: r(start), list: words });
  }

  // L-shaped ticks in the quiet gap at the window's corners, so a person can
  // see where the part has to stay. Arms 3 mm, 0.3 mm stroke.
  const q = L.windowInset - L.quiet / 2;         // the quiet gap's centreline
  const arm = 3, tw = 0.3;
  const ticks = [
    { x1: win.x, y1: q, x2: win.x + arm, y2: q }, { x1: q, y1: win.y, x2: q, y2: win.y + arm },
    { x1: win.x + win.w, y1: q, x2: win.x + win.w - arm, y2: q }, { x1: W - q, y1: win.y, x2: W - q, y2: win.y + arm },
    { x1: win.x, y1: win.y + win.h + 0.5, x2: win.x + arm, y2: win.y + win.h + 0.5 },
    { x1: q, y1: win.y + win.h, x2: q, y2: win.y + win.h + arm },
    { x1: win.x + win.w, y1: win.y + win.h + 0.5, x2: win.x + win.w - arm, y2: win.y + win.h + 0.5 },
    { x1: W - q, y1: win.y + win.h, x2: W - q, y2: win.y + win.h + arm },
  ].map(t => ({ x1: r(t.x1), y1: r(t.y1), x2: r(t.x2), y2: r(t.y2), w: tw }));

  // The ruler in the strip: 150 mm from 2 mm inside the strip's left edge,
  // ticks up from a baseline 3 mm above the strip's bottom.
  const ruler = {
    x0: r(strip.x + 2), y: r(strip.y + strip.h - 3), mm: L.rulerMm,
    tick: { minor: 1, mid: 2, major: 3 }, stroke: { minor: 0.15, mid: 0.2, major: 0.3 },
  };
  const text = { x: r(strip.x + 2), y: r(strip.y + 5), size: 3.2 };

  return {
    version: LAYOUT_VERSION, paper: paperKey, code: PAPER_CODES[paperKey], w: W, h: H,
    frame, window: win, strip, ticks, ruler, text,
    track: { rowInset: [rowInset(0), rowInset(1), rowInset(2)], cell: L.cell, wordMm },
    sides, words: position,
  };
}

// A canonical string of every cell of a layout, for the frozen fixture's
// digest: side, word index, k, row, rect, clock state.
export function cellDigestText(geom) {
  const out = [];
  for (const s of geom.sides) {
    for (const w of s.list) {
      for (const c of w.cells) out.push(`${s.side}:${w.index}:${c.k}:${c.row}:${c.x}:${c.y}:${c.w}:${c.h}:${c.clock}`);
    }
  }
  return out.join('\n');
}

// ---------- the sheet ----------

// Every cell that is black on one sheet, with its design rect and what it is
// (a clock cell or bit b of word p), plus the words' fields. This is what the
// SVG draws and what a synthetic photo is rendered from.
export function sheetCells(paperKey, sheet, job) {
  const geom = layoutGeometry(paperKey);
  const black = [];
  const words = [];
  for (const s of geom.sides) {
    for (const w of s.list) {
      const fields = { version: LAYOUT_VERSION, paper: geom.code, sheet, job, position: w.position };
      const bits = encodeWord(fields);
      words.push({ ...fields, side: s.side, index: w.index, bits });
      const at = new Map();
      for (const c of w.cells) at.set(`${c.row}:${c.k}`, c);
      for (let k = 0; k < LAYOUT_V1.wordCells; k++) {
        if (clockBlack(k)) black.push({ ...at.get(`0:${k}`), kind: 'clock', position: w.position });
      }
      bits.forEach((b, i) => {
        if (!b) return;
        const { row, k } = bitCell(i);
        black.push({ ...at.get(`${row + 1}:${k}`), kind: 'bit', bit: i, position: w.position });
      });
    }
  }
  return { geom, black, words };
}

const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const f = x => (Math.round(x * 1000) / 1000).toString();

export function paperLabel(paperKey) {
  const p = PAPER_SIZES[paperKey];
  return p ? p.name : paperKey;
}

// One sheet as SVG in real millimetres: the width and height are the stock's
// size in mm and the viewBox is in mm, so a browser prints it 1:1 at
// "Actual size". sheet is 1 to 15 within the set, count the set's size, job
// the two-hex-digit print job shared by the set.
export function sheetSVG(paperKey, sheet, count, job) {
  const { geom, black } = sheetCells(paperKey, sheet, job);
  const W = geom.w, H = geom.h;
  const out = [];
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${f(W)}mm" height="${f(H)}mm" viewBox="0 0 ${f(W)} ${f(H)}" data-layout="${LAYOUT_VERSION}" data-paper="${esc(paperKey)}" data-sheet="${sheet}" data-count="${count}" data-job="${job}">`);
  out.push(`<rect x="0" y="0" width="${f(W)}" height="${f(H)}" fill="#fff"/>`);
  const fc = geom.frame.centre;
  out.push(`<rect class="frame" x="${f(fc.x)}" y="${f(fc.y)}" width="${f(fc.w)}" height="${f(fc.h)}" fill="none" stroke="#000" stroke-width="${f(geom.frame.width)}"/>`);
  out.push('<g class="cells" fill="#000">');
  for (const c of black) out.push(`<rect x="${f(c.x)}" y="${f(c.y)}" width="${f(c.w)}" height="${f(c.h)}"/>`);
  out.push('</g>');
  out.push('<g class="ticks" stroke="#000" stroke-linecap="butt">');
  for (const t of geom.ticks) out.push(`<line x1="${f(t.x1)}" y1="${f(t.y1)}" x2="${f(t.x2)}" y2="${f(t.y2)}" stroke-width="${f(t.w)}"/>`);
  out.push('</g>');
  // The ruler.
  const R = geom.ruler;
  out.push('<g class="ruler" stroke="#000">');
  out.push(`<line x1="${f(R.x0)}" y1="${f(R.y)}" x2="${f(R.x0 + R.mm)}" y2="${f(R.y)}" stroke-width="0.3"/>`);
  for (let mm = 0; mm <= R.mm; mm++) {
    const kind = mm % 10 === 0 ? 'major' : mm % 5 === 0 ? 'mid' : 'minor';
    out.push(`<line x1="${f(R.x0 + mm)}" y1="${f(R.y)}" x2="${f(R.x0 + mm)}" y2="${f(R.y - R.tick[kind])}" stroke-width="${f(R.stroke[kind])}"/>`);
  }
  out.push('</g>');
  out.push('<g class="numbers" font-family="Helvetica, Arial, sans-serif" font-size="2.2" text-anchor="middle" fill="#000">');
  for (let mm = 0; mm <= R.mm; mm += 10) {
    out.push(`<text x="${f(R.x0 + mm)}" y="${f(R.y - 4)}">${mm}</text>`);
  }
  out.push('</g>');
  const T = geom.text;
  const jobHex = job.toString(16).toUpperCase().padStart(2, '0');
  const label = `2.5D calibration sheet · ${paperLabel(paperKey)} · layout v${LAYOUT_VERSION} · sheet ${sheet} of ${count} · set ${jobHex} · Print at Actual size. The app checks the scale either way.`;
  out.push(`<text class="label" x="${f(T.x)}" y="${f(T.y)}" font-family="Helvetica, Arial, sans-serif" font-size="${f(T.size)}" fill="#000">${esc(label)}</text>`);
  out.push('</svg>');
  return out.join('\n');
}

// Every sheet of one set, numbered 1 to count.
export function sheetSetSVG(paperKey, count, job) {
  const n = Math.max(1, Math.min(15, Math.round(count)));
  const out = [];
  for (let s = 1; s <= n; s++) out.push(sheetSVG(paperKey, s, n, job));
  return out;
}
