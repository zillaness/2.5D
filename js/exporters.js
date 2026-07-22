// Copyright (C) 2026 Projects and Mods
// GPL-3.0-or-later WITH Commons Clause (non-commercial) - see LICENSE.

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

// SVG of the trace (outline + holes) in real millimetres — handy for laser
// cutting or importing the profile into CAD.
export function toSVG(outline, holes, paperW, paperH) {
  const path = pts =>
    'M ' + pts.map(p => `${p.x.toFixed(3)},${p.y.toFixed(3)}`).join(' L ') + ' Z';
  const d = [path(outline), ...holes.map(path)].join(' ');
  return new Blob([
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<!-- 2.5D v${APP_VERSION} -->\n` +
    `<svg xmlns="http://www.w3.org/2000/svg" width="${paperW}mm" height="${paperH}mm" ` +
    `viewBox="0 0 ${paperW} ${paperH}">\n` +
    `  <path d="${d}" fill="#dfe6ee" fill-rule="evenodd" stroke="#111" stroke-width="0.2"/>\n` +
    `</svg>\n`,
  ], { type: 'image/svg+xml' });
}

// DXF (AutoCAD R12 / AC1009) of the trace as closed polylines — better CAD
// interop than SVG. Coordinates are in millimetres, Y-up (DXF convention), so
// image Y is flipped about paperH.
export function toDXF(outline, holes, paperH) {
  const lines = [];
  const g = (code, val) => { lines.push(String(code), String(val)); };
  g(999, `2.5D v${APP_VERSION}`);
  g(0, 'SECTION'); g(2, 'HEADER');
  g(9, '$ACADVER'); g(1, 'AC1009');
  g(9, '$INSUNITS'); g(70, 4); // millimetres
  g(0, 'ENDSEC');
  g(0, 'SECTION'); g(2, 'ENTITIES');
  const emitLoop = pts => {
    g(0, 'POLYLINE'); g(8, 'trace'); g(66, 1); g(70, 1); // 70=1: closed
    for (const p of pts) {
      g(0, 'VERTEX'); g(8, 'trace');
      g(10, p.x.toFixed(4));
      g(20, (paperH - p.y).toFixed(4)); // flip to Y-up
      g(30, '0.0');
    }
    g(0, 'SEQEND');
  };
  emitLoop(outline);
  for (const h of holes) emitLoop(h);
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
