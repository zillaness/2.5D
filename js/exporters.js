// Binary STL, SVG and DXF exporters.

import { APP_VERSION } from './version.js';

// Binary STL (millimetres, z-up) from an indexed triangle mesh.
export function toBinarySTL(positions, indices, name = '2.5D') {
  const triCount = indices.length / 3;
  const buffer = new ArrayBuffer(84 + triCount * 50);
  const view = new DataView(buffer);
  const header = `2.5D v${APP_VERSION} | ${name}`.slice(0, 79);
  for (let i = 0; i < Math.min(80, header.length); i++) {
    view.setUint8(i, header.charCodeAt(i));
  }
  view.setUint32(80, triCount, true);
  let off = 84;
  for (let t = 0; t < triCount; t++) {
    const a = indices[t * 3] * 3, b = indices[t * 3 + 1] * 3, c = indices[t * 3 + 2] * 3;
    const ax = positions[a], ay = positions[a + 1], az = positions[a + 2];
    const bx = positions[b], by = positions[b + 1], bz = positions[b + 2];
    const cx = positions[c], cy = positions[c + 1], cz = positions[c + 2];
    // Face normal
    const ux = bx - ax, uy = by - ay, uz = bz - az;
    const vx = cx - ax, vy = cy - ay, vz = cz - az;
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len; ny /= len; nz /= len;
    view.setFloat32(off, nx, true); view.setFloat32(off + 4, ny, true); view.setFloat32(off + 8, nz, true);
    view.setFloat32(off + 12, ax, true); view.setFloat32(off + 16, ay, true); view.setFloat32(off + 20, az, true);
    view.setFloat32(off + 24, bx, true); view.setFloat32(off + 28, by, true); view.setFloat32(off + 32, bz, true);
    view.setFloat32(off + 36, cx, true); view.setFloat32(off + 40, cy, true); view.setFloat32(off + 44, cz, true);
    view.setUint16(off + 48, 0, true);
    off += 50;
  }
  return new Blob([buffer], { type: 'model/stl' });
}

// Arc spans (from the trace editor) describe a run of a loop that is really a
// circular arc: { lo, len, cx, cy, r, sweep } with `sweep` the signed swept
// angle in image space. When present, exporters emit a true arc for that run
// instead of the dense line segments — cleaner CAD/laser output.
//
// Common walk: the interior points of each arc span are dropped, leaving the
// two endpoints, and the arc is expressed as one primitive between them.
function retainedIndices(n, arcs) {
  const skip = new Set();
  const startAt = new Map();
  for (const a of arcs || []) {
    if (a.lo + a.len - 1 >= n) continue; // never spans the loop seam
    for (let k = a.lo + 1; k < a.lo + a.len - 1; k++) skip.add(k);
    startAt.set(a.lo, a);
  }
  const kept = [];
  for (let i = 0; i < n; i++) if (!skip.has(i)) kept.push(i);
  return { kept, startAt };
}

// SVG path data for a closed loop, using A (arc) commands for arc spans.
function svgLoopPath(pts, arcs) {
  const n = pts.length;
  if (n < 2) return '';
  const { kept, startAt } = retainedIndices(n, arcs);
  const X = i => `${pts[i].x.toFixed(3)},${pts[i].y.toFixed(3)}`;
  let d = `M ${X(kept[0])}`;
  for (let k = 0; k < kept.length; k++) {
    const from = kept[k], to = kept[(k + 1) % kept.length];
    const a = startAt.get(from);
    if (a && a.lo + a.len - 1 === to) {
      const large = Math.abs(a.sweep) > Math.PI ? 1 : 0;
      const sweepFlag = a.sweep > 0 ? 1 : 0; // SVG y-down: +angle = sweep-flag 1
      d += ` A ${a.r.toFixed(3)} ${a.r.toFixed(3)} 0 ${large} ${sweepFlag} ${X(to)}`;
    } else if (k < kept.length - 1) {
      d += ` L ${X(to)}`; // closing edge is implied by Z
    }
  }
  return d + ' Z';
}

// A full circle as a two-arc subpath (true arcs, and a proper even-odd hole).
function svgCirclePath(c) {
  const r = c.d / 2;
  const L = (c.cx - r).toFixed(3), R = (c.cx + r).toFixed(3), y = c.cy.toFixed(3);
  const rr = r.toFixed(3);
  return `M ${L},${y} A ${rr} ${rr} 0 1 0 ${R},${y} A ${rr} ${rr} 0 1 0 ${L},${y} Z`;
}

// SVG of the trace (outline + holes) in real millimetres — handy for laser
// cutting or importing the profile into CAD. opts: { outerArcs, holeArcs,
// circles } enables true arc/circle output (see above).
export function toSVG(outline, holes, paperW, paperH, opts = {}) {
  const { outerArcs = null, holeArcs = null, circles = [] } = opts;
  const parts = [svgLoopPath(outline, outerArcs)];
  holes.forEach((h, i) => parts.push(svgLoopPath(h, holeArcs && holeArcs[i])));
  for (const c of circles) parts.push(svgCirclePath(c));
  const d = parts.join(' ');
  return new Blob([
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<!-- 2.5D v${APP_VERSION} -->\n` +
    `<svg xmlns="http://www.w3.org/2000/svg" width="${paperW}mm" height="${paperH}mm" ` +
    `viewBox="0 0 ${paperW} ${paperH}">\n` +
    `  <path d="${d}" fill="#dfe6ee" fill-rule="evenodd" stroke="#111" stroke-width="0.2"/>\n` +
    `</svg>\n`,
  ], { type: 'image/svg+xml' });
}

// DXF (AutoCAD R12 / AC1009) of the trace. Loops are closed polylines (arc
// spans encoded as vertex bulges); manual circles become true CIRCLE entities.
// Coordinates are in millimetres, Y-up (DXF convention), so image Y is flipped
// about paperH. opts: { outerArcs, holeArcs, circles }.
export function toDXF(outline, holes, paperH, opts = {}) {
  const { outerArcs = null, holeArcs = null, circles = [] } = opts;
  const lines = [];
  const g = (code, val) => { lines.push(String(code), String(val)); };
  g(999, `2.5D v${APP_VERSION}`);
  g(0, 'SECTION'); g(2, 'HEADER');
  g(9, '$ACADVER'); g(1, 'AC1009');
  g(9, '$INSUNITS'); g(70, 4); // millimetres
  g(0, 'ENDSEC');
  g(0, 'SECTION'); g(2, 'ENTITIES');
  const emitLoop = (pts, arcs) => {
    const n = pts.length;
    const { startAt } = retainedIndices(n, arcs);
    const skip = new Set();
    const bulgeAt = new Map();
    for (const [lo, a] of startAt) {
      for (let k = a.lo + 1; k < a.lo + a.len - 1; k++) skip.add(k);
      // Bulge = tan(sweep/4); Y is flipped on output, so the sweep sign flips.
      bulgeAt.set(lo, Math.tan(-a.sweep / 4));
    }
    g(0, 'POLYLINE'); g(8, 'trace'); g(66, 1); g(70, 1); // 70=1: closed
    for (let i = 0; i < n; i++) {
      if (skip.has(i)) continue;
      g(0, 'VERTEX'); g(8, 'trace');
      g(10, pts[i].x.toFixed(4));
      g(20, (paperH - pts[i].y).toFixed(4)); // flip to Y-up
      g(30, '0.0');
      if (bulgeAt.has(i)) g(42, bulgeAt.get(i).toFixed(6));
    }
    g(0, 'SEQEND');
  };
  emitLoop(outline, outerArcs);
  holes.forEach((h, i) => emitLoop(h, holeArcs && holeArcs[i]));
  for (const c of circles) {
    g(0, 'CIRCLE'); g(8, 'trace');
    g(10, c.cx.toFixed(4)); g(20, (paperH - c.cy).toFixed(4)); g(30, '0.0');
    g(40, (c.d / 2).toFixed(4));
  }
  g(0, 'ENDSEC');
  g(0, 'EOF');
  return new Blob([lines.join('\n') + '\n'], { type: 'application/dxf' });
}

export function downloadBlob(blob, filename) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  // Revoke late: some browsers abort the save if the URL disappears too soon.
  setTimeout(() => {
    URL.revokeObjectURL(a.href);
    a.remove();
  }, 10_000);
}

// Tiled cut template: every tile of a bed-split layout in one SVG, laid out
// in the same grid as the drawer with a gap, each labelled (row letter +
// column number) and marked with its seam edges, so it reads as a map of
// the drawer. Cut one tile per bed load by selecting it in the laser app.
// Tiles are true scale; the label/seam marks sit on their own layer group.
export function toTiledSVG(tiles, opts = {}) {
  const { gap = 10, name = 'layout' } = opts;
  const cols = Math.max(...tiles.map(t => t.col)) + 1;
  const rows = Math.max(...tiles.map(t => t.row)) + 1;
  const colW = new Array(cols).fill(0), rowH = new Array(rows).fill(0);
  for (const t of tiles) {
    colW[t.col] = Math.max(colW[t.col], t.w);
    rowH[t.row] = Math.max(rowH[t.row], t.h);
  }
  const colX = [], rowY = [];
  let acc = 0;
  for (let c = 0; c < cols; c++) { colX[c] = acc; acc += colW[c] + gap; }
  const totalW = acc - gap;
  acc = 0;
  for (let r = 0; r < rows; r++) { rowY[r] = acc; acc += rowH[r] + gap; }
  const totalH = acc - gap;

  const loopD = pts => pts.length < 2 ? '' :
    'M ' + pts.map(p => `${p.x.toFixed(3)},${p.y.toFixed(3)}`).join(' L ') + ' Z';
  const cut = [], marks = [];
  for (const t of tiles) {
    const ox = colX[t.col], oy = rowY[t.row];
    const d = [...t.slabs, ...t.holes].map(loopD).join(' ');
    cut.push(`  <path transform="translate(${ox.toFixed(3)},${oy.toFixed(3)})" d="${d}" ` +
      `fill="#dfe6ee" fill-rule="evenodd" stroke="#111" stroke-width="0.2"/>`);
    const label = `${String.fromCharCode(65 + t.row)}${t.col + 1}`;
    marks.push(`  <text x="${(ox + 4).toFixed(3)}" y="${(oy + 8).toFixed(3)}" ` +
      `font-family="system-ui, sans-serif" font-size="6" fill="#c33">${label} — ${t.w.toFixed(0)}×${t.h.toFixed(0)} mm</text>`);
    // Dashed seam edges: which sides of this tile butt against a neighbour.
    const seam = (x1, y1, x2, y2) => marks.push(
      `  <line x1="${(ox + x1).toFixed(3)}" y1="${(oy + y1).toFixed(3)}" x2="${(ox + x2).toFixed(3)}" y2="${(oy + y2).toFixed(3)}" ` +
      `stroke="#c33" stroke-width="0.3" stroke-dasharray="2 2"/>`);
    if (t.col > 0) seam(0, 0, 0, t.h);
    if (t.col < cols - 1) seam(t.w, 0, t.w, t.h);
    if (t.row > 0) seam(0, 0, t.w, 0);
    if (t.row < rows - 1) seam(0, t.h, t.w, t.h);
  }
  return new Blob([
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<!-- 2.5D v${APP_VERSION} — ${name}: ${tiles.length} tiles (${cols} × ${rows}), true scale mm. ` +
    `Layer "cut" = outlines; layer "marks" = labels + seam edges (engrave or ignore). -->\n` +
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" ` +
    `width="${totalW.toFixed(3)}mm" height="${totalH.toFixed(3)}mm" viewBox="0 0 ${totalW.toFixed(3)} ${totalH.toFixed(3)}">\n` +
    `<g id="cut" inkscape:groupmode="layer" inkscape:label="cut">\n${cut.join('\n')}\n</g>\n` +
    `<g id="marks" inkscape:groupmode="layer" inkscape:label="marks">\n${marks.join('\n')}\n</g>\n` +
    `</svg>\n`,
  ], { type: 'image/svg+xml' });
}
