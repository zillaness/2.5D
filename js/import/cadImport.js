// Copyright (C) 2026 Projects and Mods
// GPL-3.0-or-later WITH Commons Clause (non-commercial) - see LICENSE.

// Orchestrates vector CAD import: parse (DXF/SVG) → scale to mm → normalize
// orientation → assemble candidate views for the user to pick from.
//
// DXF uses a Y-up coordinate system (CAD convention); the app's trace space is
// Y-down (image convention, which the mesh later flips to Y-up model space), so
// DXF Y is negated on the way in to keep the part right-side-up and un-mirrored.
// SVG is already Y-down.

import { parseDXF } from './dxfImport.js';
import { parseSVG } from './svgImport.js';
import { assembleViews } from './loops.js';

export function detectFormat(name, text) {
  if (/\.dxf$/i.test(name)) return 'dxf';
  if (/\.svg$/i.test(name)) return 'svg';
  if (/\.dwg$/i.test(name)) return 'dwg';
  const head = text.slice(0, 512).toLowerCase();
  if (head.includes('<svg')) return 'svg';
  if (/^\s*0\s*[\r\n]+\s*section/i.test(text) || head.includes('autocad')) return 'dxf';
  return 'unknown';
}

// Layers/linetypes that are almost always annotation, off by default.
const ANNOTATION_LAYER = /dim|text|note|title|border|hatch|center|centre|hidden/i;
const ANNOTATION_LINETYPE = /dashed|hidden|center|centre|phantom|dot/i;

// Returns { format, views, unitScale, unitName, unitsKnown, layers, warnings }.
// `views` are in mm, Y-down, ready to hand to the trace model.
export function importCad(name, text, opts = {}) {
  const format = detectFormat(name, text);
  if (format === 'dwg') {
    return { format, views: [], warnings: ['DWG is a binary format this tool can’t read. Re-export it as DXF or SVG from your CAD app.'], layers: new Set() };
  }
  if (format === 'unknown') {
    return { format, views: [], warnings: ['Unrecognized file — expected DXF or SVG.'], layers: new Set() };
  }

  const parsed = format === 'dxf' ? parseDXF(text) : parseSVG(text);
  const { unitScale, unitName, unitsKnown, layers, warnings } = parsed;
  const flipY = format === 'dxf' ? -1 : 1;
  const s = (unitScale || 1) * (opts.unitOverride || 1);

  // Filter out annotation layers/linetypes unless explicitly kept.
  const keep = opts.keepLayers; // Set of layer names to include (optional)
  const usable = parsed.polylines.filter(pl => {
    if (keep) return keep.has(pl.layer);
    if (ANNOTATION_LAYER.test(pl.layer)) return false;
    if (ANNOTATION_LINETYPE.test(pl.linetype)) return false;
    return true;
  });

  const scaled = usable.map(pl => ({
    closed: pl.closed,
    pts: pl.pts.map(p => ({ x: p.x * s, y: p.y * s * flipY })),
  }));

  const views = assembleViews(scaled, 0.05);
  // Shift each view so its bounding box starts at a small margin ≥ 0.
  for (const v of views) {
    const b = v.bbox;
    const dx = -b.minX + 5, dy = -b.minY + 5;
    const off = pts => pts.map(p => ({ x: p.x + dx, y: p.y + dy }));
    v.outer = off(v.outer);
    v.holes = v.holes.map(off);
    v.bbox = { minX: 5, minY: 5, maxX: b.maxX - b.minX + 5, maxY: b.maxY - b.minY + 5 };
    v.w = b.maxX - b.minX; v.h = b.maxY - b.minY;
  }

  return { format, views, unitScale: s, unitName, unitsKnown, layers, warnings: warnings || [] };
}
