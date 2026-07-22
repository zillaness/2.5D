// Rectangular reference table (mm). Any flat rectangle of known size
// calibrates perspective the same way — sheets of paper, or an everyday card
// or bill you always have on hand. `group` buckets entries into <optgroup>
// submenus in the picker so the currency options don't clutter the list.
export const PAPER_SIZES = {
  // Paper
  A3:     { group: 'Paper', name: 'A3 (297 × 420 mm)',        w: 297,   h: 420 },
  A4:     { group: 'Paper', name: 'A4 (210 × 297 mm)',        w: 210,   h: 297 },
  A5:     { group: 'Paper', name: 'A5 (148 × 210 mm)',        w: 148,   h: 210 },
  B4:     { group: 'Paper', name: 'B4 (250 × 353 mm)',        w: 250,   h: 353 },
  B5:     { group: 'Paper', name: 'B5 (176 × 250 mm)',        w: 176,   h: 250 },
  letter: { group: 'Paper', name: 'US Letter (8.5 × 11 in)',  w: 215.9, h: 279.4 },
  legal:  { group: 'Paper', name: 'US Legal (8.5 × 14 in)',   w: 215.9, h: 355.6 },
  tabloid:{ group: 'Paper', name: 'US Tabloid (11 × 17 in)',  w: 279.4, h: 431.8 },
  // Card
  card:   { group: 'Card', name: 'Credit/ID card (85.6 × 54 mm)', w: 53.98, h: 85.60 },
  // Bills — US & Canada
  usbill: { group: 'US & Canadian bills', name: 'US bill (156 × 66 mm)', w: 66.3,  h: 156.1 },
  cabill: { group: 'US & Canadian bills', name: 'Canadian bill (152.4 × 69.85 mm)', w: 69.85, h: 152.4 },
  // Bills — Euro
  eur5:   { group: 'Euro notes', name: '€5 note (120 × 62 mm)',   w: 62, h: 120 },
  eur10:  { group: 'Euro notes', name: '€10 note (127 × 67 mm)',  w: 67, h: 127 },
  eur20:  { group: 'Euro notes', name: '€20 note (133 × 72 mm)',  w: 72, h: 133 },
  eur50:  { group: 'Euro notes', name: '€50 note (140 × 77 mm)',  w: 77, h: 140 },
  eur100: { group: 'Euro notes', name: '€100 note (147 × 82 mm)', w: 82, h: 147 },
  // Bills — UK
  gbp5:   { group: 'UK notes', name: '£5 note (125 × 65 mm)',   w: 65, h: 125 },
  gbp10:  { group: 'UK notes', name: '£10 note (132 × 69 mm)',  w: 69, h: 132 },
  gbp20:  { group: 'UK notes', name: '£20 note (139 × 73 mm)',  w: 73, h: 139 },
  gbp50:  { group: 'UK notes', name: '£50 note (146 × 77 mm)',  w: 77, h: 146 },
  // Bills — Australia
  aud5:   { group: 'Australian notes', name: 'AUD $5 (130 × 65 mm)',   w: 65, h: 130 },
  aud10:  { group: 'Australian notes', name: 'AUD $10 (137 × 65 mm)',  w: 65, h: 137 },
  aud20:  { group: 'Australian notes', name: 'AUD $20 (144 × 65 mm)',  w: 65, h: 144 },
  aud50:  { group: 'Australian notes', name: 'AUD $50 (151 × 65 mm)',  w: 65, h: 151 },
  aud100: { group: 'Australian notes', name: 'AUD $100 (158 × 65 mm)', w: 65, h: 158 },
  // Custom (ungrouped, stays at the bottom)
  custom: { name: 'Custom…', w: 210, h: 297 },
};

// Round scale-only references: a coin sets scale (mm/px) but cannot correct
// perspective, so these are used in "coin" reference mode with a top-down shot.
// Only truly circular coins are listed (heptagonal / 12-sided coins like the UK
// 50p·£1 and AUD 50c would give a wrong "diameter").
export const COIN_SIZES = {
  // US
  us_quarter: { group: 'US coins', name: 'US Quarter (⌀24.26 mm)', d: 24.26 },
  us_nickel:  { group: 'US coins', name: 'US Nickel (⌀21.21 mm)',  d: 21.21 },
  us_penny:   { group: 'US coins', name: 'US Penny (⌀19.05 mm)',   d: 19.05 },
  us_dime:    { group: 'US coins', name: 'US Dime (⌀17.91 mm)',    d: 17.91 },
  // Euro
  euro_2:     { group: 'Euro coins', name: '€2 (⌀25.75 mm)',    d: 25.75 },
  euro_1:     { group: 'Euro coins', name: '€1 (⌀23.25 mm)',    d: 23.25 },
  euro_50c:   { group: 'Euro coins', name: '€0.50 (⌀24.25 mm)', d: 24.25 },
  euro_20c:   { group: 'Euro coins', name: '€0.20 (⌀22.25 mm)', d: 22.25 },
  euro_5c:    { group: 'Euro coins', name: '€0.05 (⌀21.25 mm)', d: 21.25 },
  euro_10c:   { group: 'Euro coins', name: '€0.10 (⌀19.75 mm)', d: 19.75 },
  // Canada
  ca_toonie:  { group: 'Canadian coins', name: 'Canadian $2 toonie (⌀28.00 mm)', d: 28.00 },
  ca_loonie:  { group: 'Canadian coins', name: 'Canadian $1 loonie (⌀26.50 mm)', d: 26.50 },
  ca_quarter: { group: 'Canadian coins', name: 'Canadian 25¢ (⌀23.88 mm)',       d: 23.88 },
  ca_nickel:  { group: 'Canadian coins', name: 'Canadian 5¢ (⌀21.20 mm)',        d: 21.20 },
  ca_dime:    { group: 'Canadian coins', name: 'Canadian 10¢ (⌀18.03 mm)',       d: 18.03 },
  // UK (round denominations only)
  gbp_2pound: { group: 'UK coins', name: 'UK £2 (⌀28.40 mm)',  d: 28.40 },
  gbp_2p:     { group: 'UK coins', name: 'UK 2p (⌀25.90 mm)',  d: 25.90 },
  gbp_10p:    { group: 'UK coins', name: 'UK 10p (⌀24.50 mm)', d: 24.50 },
  gbp_1p:     { group: 'UK coins', name: 'UK 1p (⌀20.30 mm)',  d: 20.30 },
  gbp_5p:     { group: 'UK coins', name: 'UK 5p (⌀18.00 mm)',  d: 18.00 },
  // Australia (round denominations only)
  aud_20c:    { group: 'Australian coins', name: 'AUD 20¢ (⌀28.65 mm)', d: 28.65 },
  aud_1:      { group: 'Australian coins', name: 'AUD $1 (⌀25.00 mm)',  d: 25.00 },
  aud_10c:    { group: 'Australian coins', name: 'AUD 10¢ (⌀23.60 mm)', d: 23.60 },
  aud_2:      { group: 'Australian coins', name: 'AUD $2 (⌀20.50 mm)',  d: 20.50 },
  aud_5c:     { group: 'Australian coins', name: 'AUD 5¢ (⌀19.41 mm)',  d: 19.41 },
  // Custom (ungrouped, stays at the bottom)
  coin_custom:{ name: 'Custom ⌀…', d: 24.26 },
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
