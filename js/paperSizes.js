// Paper size table (mm). All ISO 216 A/B sizes plus common North American sizes.
export const PAPER_SIZES = {
  A3:     { name: 'A3 (297 × 420 mm)',        w: 297,   h: 420 },
  A4:     { name: 'A4 (210 × 297 mm)',        w: 210,   h: 297 },
  A5:     { name: 'A5 (148 × 210 mm)',        w: 148,   h: 210 },
  B4:     { name: 'B4 (250 × 353 mm)',        w: 250,   h: 353 },
  B5:     { name: 'B5 (176 × 250 mm)',        w: 176,   h: 250 },
  letter: { name: 'US Letter (8.5 × 11 in)',  w: 215.9, h: 279.4 },
  legal:  { name: 'US Legal (8.5 × 14 in)',   w: 215.9, h: 355.6 },
  tabloid:{ name: 'US Tabloid (11 × 17 in)',  w: 279.4, h: 431.8 },
  custom: { name: 'Custom…',                  w: 210,   h: 297 },
};

export const DEFAULT_SIZE = 'letter';

// Returns { w, h } in mm honoring orientation ('portrait' | 'landscape').
// Table dimensions are portrait (w < h).
export function paperDims(sizeKey, orientation, customW, customH) {
  let { w, h } = PAPER_SIZES[sizeKey] || PAPER_SIZES.A4;
  if (sizeKey === 'custom') {
    w = customW > 0 ? customW : w;
    h = customH > 0 ? customH : h;
  }
  if (orientation === 'landscape') return { w: Math.max(w, h), h: Math.min(w, h) };
  return { w: Math.min(w, h), h: Math.max(w, h) };
}
