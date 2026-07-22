// Copyright (C) 2026 Projects and Mods
// GPL-3.0-or-later WITH Commons Clause (non-commercial) - see LICENSE.

// Geometry checker for the generated key mesh — used to validate the bow↔blade
// connection and the blade tip against keygen. Runs the real Manifold CSG build
// in Node (no browser) and reports watertightness plus tip-nose and neck-fillet
// geometry so a change can be judged, not eyeballed.
//
//   node tools/keycheck.mjs <BLANK_ID> [code]     e.g. node tools/keycheck.mjs SC1 12345
//   node tools/keycheck.mjs all                    every blank, default code
//
// keygen reference numbers (blade-height fractions) for the TIP nose apex:
//   schlage 0.35  kwikset 0.37  master 0.50  best 0.50   (apex h / blade height)
// A real key tip is a rounded nose: the back edge rises and the top falls to an
// apex near mid-height — NOT a flat full-height end face. The neck has a concave
// fillet where the back edge sweeps up into the bow.

import { BLANKS, getBlank, wardingFor } from '../js/keys/blanks.js';
import { buildKeyMesh, buildKeyMeshCSG } from '../js/keys/keyMesh.js';

export function watertight(indices) {
  const e = new Map(), k = (a, b) => a < b ? `${a},${b}` : `${b},${a}`;
  for (let i = 0; i < indices.length; i += 3) {
    const [a, b, c] = [indices[i], indices[i + 1], indices[i + 2]];
    for (const [u, v] of [[a, b], [b, c], [c, a]]) e.set(k(u, v), (e.get(k(u, v)) || 0) + 1);
  }
  let boundary = 0, nonmanifold = 0;
  for (const c of e.values()) { if (c === 1) boundary++; else if (c > 2) nonmanifold++; }
  return { boundary, nonmanifold, ok: boundary === 0 && nonmanifold === 0 };
}

// Vertices as [x,y,z] triples (x=length 0=shoulder→+tip, y=thickness, z=height).
function verts(positions) {
  const v = []; for (let i = 0; i < positions.length; i += 3) v.push([positions[i], positions[i + 1], positions[i + 2]]);
  return v;
}

// Tip-nose measurement: near the max-x end, the z (height) extent. A nose narrows
// to a small apex near mid-height; a blunt end spans ~0..bladeTop.
function tipGeom(positions, bladeTop) {
  const v = verts(positions);
  const maxX = Math.max(...v.map(p => p[0]));
  const at = (loX) => { const zs = v.filter(p => p[0] >= maxX - loX).map(p => p[2]); return zs.length ? [Math.min(...zs), Math.max(...zs)] : [0, 0]; };
  const [z0, z1] = at(0.4);                 // the very end face
  const mid = v.filter(p => p[0] > 3 && p[0] < maxX - 8).map(p => p[2]);       // blade body
  const bodyZ = mid.length ? [Math.min(...mid), Math.max(...mid)] : [0, bladeTop];
  return {
    maxX: +maxX.toFixed(3),
    tipEndZ: [+z0.toFixed(3), +z1.toFixed(3)], tipEndHeight: +(z1 - z0).toFixed(3),
    tipApexFrac: +(((z0 + z1) / 2) / bladeTop).toFixed(3),
    backRisesAtTip: z0 > 0.6,               // did the back edge lift off h=0?
    bodyZ: bodyZ.map(z => +z.toFixed(2)),
  };
}

// Neck-fillet measurement: min z (back edge) in x-bins just past the shoulder.
// A fillet makes the back edge rise from 0 as it approaches the bow (x→0).
function neckGeom(positions) {
  const v = verts(positions);
  const bin = (lo, hi) => { const zs = v.filter(p => p[0] >= lo && p[0] < hi && p[1] > -0.2 && p[1] < 0.2).map(p => p[2]); return zs.length ? +Math.min(...zs).toFixed(3) : null; };
  return { backZ_x0to1: bin(0, 1), backZ_x1to2: bin(1, 2), backZ_x2to3: bin(2, 3), backZ_x3to5: bin(3, 5) };
}

export async function checkBlank(id, code) {
  const blank = getBlank(id);
  const spec = blank.spec;
  if (!code) { const lo = spec.codeMin; code = Array.from({ length: spec.positions }, (_, i) => lo + ((i * 3) % spec.depthCount)); }
  const bladeTop = wardingFor(blank).height;
  const weld = buildKeyMesh(blank, code);
  let csg = null, csgErr = null;
  try { csg = await buildKeyMeshCSG(blank, code); } catch (e) { csgErr = String(e.message || e); }
  return {
    id, code: code.join('-'), bladeTop: +bladeTop.toFixed(3),
    weld: { tris: weld.indices.length / 3, watertight: watertight(weld.indices), tip: tipGeom(weld.positions, bladeTop), neck: neckGeom(weld.positions) },
    csg: csg ? { tris: csg.indices.length / 3, watertight: watertight(csg.indices), tip: tipGeom(csg.positions, bladeTop), neck: neckGeom(csg.positions) } : { error: csgErr },
  };
}

// CLI
if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = process.argv[2] || 'all';
  const codeArg = process.argv[3];
  const ids = arg === 'all' ? BLANKS.map(b => b.id) : [arg];
  for (const id of ids) {
    const code = codeArg ? codeArg.split(/\D+/).filter(Boolean).map(Number) : null;
    const r = await checkBlank(id, code);
    console.log(JSON.stringify(r, null, 1));
  }
}
