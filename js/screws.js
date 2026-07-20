// Screw reference table (metric ISO coarse + SAE/inch) and hole sizing for
// 3D-printed parts.
//
// Bore sizing uses the print-friendly ±half-pitch rule rather than machinist
// tap-drill tables: a tap cuts clean full-depth threads, but a screw driven
// straight into a printed hole needs more room —
//   clearance (through) bore  = nominal + pitch / 2
//   thread-into-print bore    = nominal - pitch / 2
// (For comparison, a metric tap drill is nominal - pitch, i.e. tighter.)
//
// Head dimensions are typical catalog values in mm used to seed countersink /
// counterbore defaults (editable in the UI):
//   shcsDia / shcsH — socket head cap screw head diameter & height (counterbore)
//   fhDia           — flat/countersunk head diameter (countersink)

export const SCREW_STANDARDS = {
  metric: {
    name: 'Metric (ISO)',
    csAngle: 90,
    sizes: {
      'M2':   { d: 2.0,   p: 0.4,   shcsDia: 3.8,  shcsH: 2.0,   fhDia: 4.4 },
      'M2.5': { d: 2.5,   p: 0.45,  shcsDia: 4.5,  shcsH: 2.5,   fhDia: 5.5 },
      'M3':   { d: 3.0,   p: 0.5,   shcsDia: 5.5,  shcsH: 3.0,   fhDia: 6.7 },
      'M4':   { d: 4.0,   p: 0.7,   shcsDia: 7.0,  shcsH: 4.0,   fhDia: 9.0 },
      'M5':   { d: 5.0,   p: 0.8,   shcsDia: 8.5,  shcsH: 5.0,   fhDia: 11.2 },
      'M6':   { d: 6.0,   p: 1.0,   shcsDia: 10.0, shcsH: 6.0,   fhDia: 13.4 },
      'M8':   { d: 8.0,   p: 1.25,  shcsDia: 13.0, shcsH: 8.0,   fhDia: 17.9 },
      'M10':  { d: 10.0,  p: 1.5,   shcsDia: 16.0, shcsH: 10.0,  fhDia: 22.4 },
    },
  },
  sae: {
    name: 'SAE (inch)',
    csAngle: 82,
    sizes: {
      '#2-56':   { d: 2.184, p: 25.4 / 56, shcsDia: 3.56,  shcsH: 2.18, fhDia: 4.4 },
      '#4-40':   { d: 2.845, p: 25.4 / 40, shcsDia: 4.65,  shcsH: 2.85, fhDia: 5.7 },
      '#6-32':   { d: 3.505, p: 25.4 / 32, shcsDia: 5.74,  shcsH: 3.51, fhDia: 7.1 },
      '#8-32':   { d: 4.166, p: 25.4 / 32, shcsDia: 6.86,  shcsH: 4.17, fhDia: 8.4 },
      '#10-24':  { d: 4.826, p: 25.4 / 24, shcsDia: 7.92,  shcsH: 4.83, fhDia: 9.8 },
      '#10-32':  { d: 4.826, p: 25.4 / 32, shcsDia: 7.92,  shcsH: 4.83, fhDia: 9.8 },
      '1/4-20':  { d: 6.35,  p: 25.4 / 20, shcsDia: 9.53,  shcsH: 6.35, fhDia: 12.9 },
      '5/16-18': { d: 7.938, p: 25.4 / 18, shcsDia: 11.91, shcsH: 7.94, fhDia: 16.1 },
      '3/8-16':  { d: 9.525, p: 25.4 / 16, shcsDia: 14.29, shcsH: 9.53, fhDia: 19.4 },
    },
  },
};

// Brass heat-set threaded inserts (melt into a printed hole with a soldering
// iron). `hole` is the recommended printed hole diameter (already sized so
// molten plastic flows into the knurls — do NOT use the screw-bore rule);
// `length` is the insert length. Values are typical for common tapered
// inserts (CNC-Kitchen / McMaster style) and vary by brand — all editable.
export const INSERT_SIZES = {
  'M2':   { hole: 3.2,  length: 4.0 },
  'M2.5': { hole: 3.5,  length: 4.0 },
  'M3':   { hole: 4.0,  length: 5.0 },
  'M4':   { hole: 5.6,  length: 6.0 },
  'M5':   { hole: 6.4,  length: 7.0 },
  'M6':   { hole: 8.1,  length: 8.0 },
  'M8':   { hole: 10.0, length: 10.0 },
};

const round05 = v => Math.round(v * 20) / 20; // nearest 0.05 mm

// Insert hole preset: a blind pocket sized to the recommended hole diameter,
// deep enough for the insert plus a little debris room.
export function insertHole(sizeKey) {
  const s = INSERT_SIZES[sizeKey];
  if (!s) return null;
  return { bore: round05(s.hole), depth: round05(s.length + 0.5) };
}

export function screwSpec(std, sizeKey) {
  const standard = SCREW_STANDARDS[std];
  if (!standard) return null;
  const s = standard.sizes[sizeKey];
  if (!s) return null;
  return { ...s, csAngle: standard.csAngle };
}

// Bore diameter (mm) for a screw and fit ('clearance' | 'tap').
export function boreDiameter(std, sizeKey, fit) {
  const s = screwSpec(std, sizeKey);
  if (!s) return null;
  return round05(fit === 'tap' ? s.d - s.p / 2 : s.d + s.p / 2);
}

// Seed values for the recess features (mm), with printing clearance baked in.
export function recessDefaults(std, sizeKey) {
  const s = screwSpec(std, sizeKey);
  if (!s) return null;
  return {
    csAngle: s.csAngle,
    csDia: round05(s.fhDia + 0.6),
    cbDia: round05(s.shcsDia + 1.0),
    cbDepth: round05(s.shcsH + 0.5),
  };
}
