// Validate keyMesh against keygen: build SC1 12-3-4-5, check watertightness and
// compare the bounding box to the keygen reference.  node test/keymesh_check.mjs
import fs from 'fs';
import { getBlank } from '../js/keys/blanks.js';
import { buildKeyMesh } from '../js/keys/keyMesh.js';

const blank = getBlank('SC1');
const code = [1, 2, 3, 4, 5];
const { positions, indices } = buildKeyMesh(blank, code);

const nTri = indices.length / 3;
// Watertight: every undirected edge shared by exactly 2 triangles.
const edges = new Map();
const key = (a, b) => a < b ? `${a},${b}` : `${b},${a}`;
for (let i = 0; i < indices.length; i += 3) {
  const [a, b, c] = [indices[i], indices[i + 1], indices[i + 2]];
  for (const [u, v] of [[a, b], [b, c], [c, a]]) edges.set(key(u, v), (edges.get(key(u, v)) || 0) + 1);
}
let boundary = 0, nonmanifold = 0;
for (const cnt of edges.values()) { if (cnt === 1) boundary++; else if (cnt > 2) nonmanifold++; }

// Bounding box.
let mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
for (let i = 0; i < positions.length; i += 3)
  for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], positions[i + k]); mx[k] = Math.max(mx[k], positions[i + k]); }
const span = mn.map((v, k) => +(mx[k] - v).toFixed(3));

const pass = boundary === 0 && nonmanifold === 0;
console.log(`SC1 ${code.join('-')}: ${nTri} triangles`);
console.log(`  span (x=len, y=thick, z=height) mm: ${span}`);
console.log(`  watertight: ${pass ? 'YES' : 'NO'}  (boundary edges ${boundary}, non-manifold ${nonmanifold})`);
console.log(`  keygen SC1 reference thickness ≈ 1.91mm (warding C); ours y = ${span[1]}`);

// Write an ASCII STL for eyeballing / printing.
let stl = 'solid SC1\n';
const p = (i) => `${positions[i * 3]} ${positions[i * 3 + 1]} ${positions[i * 3 + 2]}`;
for (let i = 0; i < indices.length; i += 3) {
  stl += 'facet normal 0 0 0\n outer loop\n';
  stl += `  vertex ${p(indices[i])}\n  vertex ${p(indices[i + 1])}\n  vertex ${p(indices[i + 2])}\n`;
  stl += ' endloop\nendfacet\n';
}
stl += 'endsolid SC1\n';
fs.writeFileSync(process.env.OUT || '/tmp/keymesh_SC1.stl', stl);
console.log(`  wrote ${process.env.OUT || '/tmp/keymesh_SC1.stl'}`);
process.exit(pass ? 0 : 1);
