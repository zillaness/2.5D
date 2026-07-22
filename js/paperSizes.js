// Rectangular reference table (mm). Any flat rectangle of known size
// calibrates perspective the same way — sheets of paper, or an everyday card
// or bill you always have on hand.
export const PAPER_SIZES = {
  A3:     { name: 'A3 (297 × 420 mm)',        w: 297,   h: 420 },
  A4:     { name: 'A4 (210 × 297 mm)',        w: 210,   h: 297 },
  A5:     { name: 'A5 (148 × 210 mm)',        w: 148,   h: 210 },
  B4:     { name: 'B4 (250 × 353 mm)',        w: 250,   h: 353 },
  B5:     { name: 'B5 (176 × 250 mm)',        w: 176,   h: 250 },
  letter: { name: 'US Letter (8.5 × 11 in)',  w: 215.9, h: 279.4 },
  legal:  { name: 'US Legal (8.5 × 14 in)',   w: 215.9, h: 355.6 },
  tabloid:{ name: 'US Tabloid (11 × 17 in)',  w: 279.4, h: 431.8 },
  card:   { name: 'Credit/ID card (85.6 × 54 mm)', w: 53.98, h: 85.60 },
  usbill: { name: 'US bill (156 × 66 mm)',    w: 66.3,  h: 156.1 },
  cabill: { name: 'Canadian bill (152.4 × 69.85 mm)', w: 69.85, h: 152.4 }, // all denominations
  eur5:   { name: '€5 note (120 × 62 mm)',    w: 62,    h: 120 },
  eur10:  { name: '€10 note (127 × 67 mm)',   w: 67,    h: 127 },
  eur20:  { name: '€20 note (133 × 72 mm)',   w: 72,    h: 133 },
  eur50:  { name: '€50 note (140 × 77 mm)',   w: 77,    h: 140 },
  eur100: { name: '€100 note (147 × 82 mm)',  w: 82,    h: 147 },
  custom: { name: 'Custom…',                  w: 210,   h: 297 },
};

// Round scale-only references: a coin sets scale (mm/px) but cannot correct
// perspective, so these are used in "coin" reference mode with a top-down shot.
export const COIN_SIZES = {
  us_quarter: { name: 'US Quarter (⌀24.26 mm)', d: 24.26 },
  us_dime:    { name: 'US Dime (⌀17.91 mm)',    d: 17.91 },
  us_nickel:  { name: 'US Nickel (⌀21.21 mm)',  d: 21.21 },
  us_penny:   { name: 'US Penny (⌀19.05 mm)',   d: 19.05 },
  euro_2:     { name: '€2 coin (⌀25.75 mm)',    d: 25.75 },
  euro_1:     { name: '€1 coin (⌀23.25 mm)',    d: 23.25 },
  ca_toonie:  { name: 'Canadian $2 toonie (⌀28.00 mm)', d: 28.00 },
  ca_loonie:  { name: 'Canadian $1 loonie (⌀26.50 mm)', d: 26.50 },
  ca_quarter: { name: 'Canadian 25¢ (⌀23.88 mm)',       d: 23.88 },
  ca_nickel:  { name: 'Canadian 5¢ (⌀21.20 mm)',        d: 21.20 },
  ca_dime:    { name: 'Canadian 10¢ (⌀18.03 mm)',       d: 18.03 },
  coin_custom:{ name: 'Custom ⌀…',              d: 24.26 },
};

export const DEFAULT_SIZE = 'letter';
export const DEFAULT_COIN = 'us_quarter';

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
