// Native key mesh generator — the on-device replacement for keygen+OpenSCAD.
//
// Builds a printable 3D key from a blank + bitting code, entirely in JS:
//   1. take the warded cross-section (blade end-on, t×h) for the keyway,
//   2. loft it along the blade length L, milling the top edge down to each cut's
//      root depth (the bitting), and
//   3. add a generic bow.
//
// Coordinates (mm): x = L along the blade (0 = shoulder datum, +x → tip),
// y = t (thickness, warding is centred on 0), z = h (height above blade back).
//
// The bitting only lowers the blade's TOP edge, and for these keyways the profile
// above the grooves is a single top span between two top corners. So we can loft
// with fixed topology — clip the two top corners down to the milled height at each
// L — instead of doing full 3-D CSG. Validated against keygen's SC1 output.

import earcut from '../../vendor/earcut.js';
import {
  wardingFor, cutCentre, rootDepthForCode, IN_TO_MM,
} from './blanks.js';
import { toBinarySTL } from '../exporters.js';

// ── small mesh builder ───────────────────────────────────────────────────────
class Mesh {
  constructor() { this.pos = []; this.idx = []; }
  v(x, y, z) { this.pos.push(x, y, z); return this.pos.length / 3 - 1; }
  tri(a, b, c) { this.idx.push(a, b, c); }
  quad(a, b, c, d) { this.tri(a, b, c); this.tri(a, c, d); } // a-b-c-d CCW
}

// ── bitting: milled top-edge height h_top(L) in mm ───────────────────────────
export function topHeightFn(blank, code) {
  const s = blank.spec;
  const uncut = wardingFor(blank).height;                 // mm, blank top edge
  const run = Math.tan((s.cutAngle * Math.PI / 180) / 2); // wall run per depth
  const flatHalf = (s.cutFlat * IN_TO_MM) / 2;
  return (L) => {
    let h = uncut;
    for (let i = 0; i < s.positions; i++) {
      const c = cutCentre(s, i) * IN_TO_MM;
      const root = rootDepthForCode(s, code[i]) * IN_TO_MM;
      const dx = Math.abs(L - c);
      const edge = dx <= flatHalf ? root : root + (dx - flatHalf) / run;
      if (edge < h) h = edge;
    }
    return h;
  };
}

// Clip the warding profile so everything above `hTop` is removed, keeping a
// fixed vertex ordering: the two top corners (max h) become the two points where
// their side edges cross hTop. Assumes a single top span (true for these keyways
// while cuts stay above the grooves). Returns points ordered as a closed loop.
function clipProfileAtTop(profile, hTop) {
  const maxH = Math.max(...profile.map(p => p[1]));
  // indices of the top-corner vertices (at maxH)
  const isTop = profile.map(p => Math.abs(p[1] - maxH) < 1e-6);
  const out = [];
  const n = profile.length;
  for (let i = 0; i < n; i++) {
    const cur = profile[i];
    if (!isTop[i]) { out.push(cur); continue; }
    // Replace this top corner with the intersection along the edge to its
    // nearest non-top neighbour (previous if it's below, else next).
    const prev = profile[(i - 1 + n) % n], next = profile[(i + 1) % n];
    const nb = !isTop[(i - 1 + n) % n] ? prev : next;
    const t = (hTop - nb[1]) / (cur[1] - nb[1]);          // nb → cur crosses hTop
    out.push([nb[0] + (cur[0] - nb[0]) * t, hTop]);
  }
  return out;
}

// Signed area of a (t,h) loop — to orient side-wall winding consistently.
function area2(loop) {
  let a = 0;
  for (let i = 0, n = loop.length; i < n; i++) {
    const p = loop[i], q = loop[(i + 1) % n];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}

// ── blade: loft the clipped cross-section along L ────────────────────────────
function addBlade(mesh, blank, code) {
  const s = blank.spec;
  const w = wardingFor(blank);
  const hTopAt = topHeightFn(blank, code);
  const tipL = cutCentre(s, s.positions - 1) * IN_TO_MM + 2.5; // small tip margin

  // L breakpoints: cut centres, flat edges and wall feet, plus a fine grid, so
  // the milled V-cuts are captured crisply.
  const bp = new Set([0, tipL]);
  const flatHalf = (s.cutFlat * IN_TO_MM) / 2;
  const run = Math.tan((s.cutAngle * Math.PI / 180) / 2);
  const uncut = w.height;
  for (let i = 0; i < s.positions; i++) {
    const c = cutCentre(s, i) * IN_TO_MM;
    const root = rootDepthForCode(s, code[i]) * IN_TO_MM;
    const wall = (uncut - root) * run;                    // half-width of the V
    for (const L of [c - flatHalf - wall, c - flatHalf, c, c + flatHalf, c + flatHalf + wall]) {
      if (L > 0 && L < tipL) bp.add(L);
    }
  }
  for (let L = 0; L <= tipL; L += 0.4) bp.add(L);
  const stations = [...bp].sort((a, b) => a - b);

  // Loft rings (each a clipped profile at its L), connected by quad walls.
  const rings = stations.map(L => {
    const loop = clipProfileAtTop(w.profile, hTopAt(L));
    const flip = area2(loop) < 0 ? loop.slice().reverse() : loop; // CCW in t,h
    return flip.map(([t, h]) => mesh.v(L, t, h));
  });
  const ringLoops = stations.map(L => {
    const loop = clipProfileAtTop(w.profile, hTopAt(L));
    return area2(loop) < 0 ? loop.slice().reverse() : loop;
  });

  const m = ringLoops[0].length;
  for (let r = 0; r < rings.length - 1; r++) {
    const A = rings[r], B = rings[r + 1];
    for (let k = 0; k < m; k++) {
      const k2 = (k + 1) % m;
      // wall quad between station r and r+1 (outward normal via CCW-in-t,h ring)
      mesh.quad(A[k], A[k2], B[k2], B[k]);
    }
  }

  // End caps (shoulder at L=0, tip at L=tipL), triangulated in (t,h).
  const capTris = (loop) => earcut(loop.flat(), null, 2);
  const cap = (ring, loop, atStart) => {
    const tris = capTris(loop);
    for (let i = 0; i < tris.length; i += 3) {
      // wind so the normal faces outward (−x at shoulder, +x at tip)
      if (atStart) mesh.tri(ring[tris[i]], ring[tris[i + 2]], ring[tris[i + 1]]);
      else mesh.tri(ring[tris[i]], ring[tris[i + 1]], ring[tris[i + 2]]);
    }
  };
  cap(rings[0], ringLoops[0], true);
  cap(rings[rings.length - 1], ringLoops[ringLoops.length - 1], false);
}

// ── bow: a generic rounded paddle, code-embossable later ─────────────────────
function addBow(mesh, blank, opts = {}) {
  const w = wardingFor(blank);
  const thick = w.thickness;                 // flush with the blade for a flat key
  const midH = w.height / 2;
  const bowLen = opts.bowLen ?? 22;          // mm, behind the shoulder
  const bowH = opts.bowH ?? 22;
  const rEnd = bowH / 2;
  const holeDia = opts.holeDia ?? 6;

  // Outline in (L,h): a stadium (rounded-left rectangle) from L=x0 (slight blade
  // overlap) back to a left semicircle centred at (xc, midH). Simple polygon,
  // ordered CW; no duplicate vertices at the arc joins.
  const outline = [];
  const x0 = 0.5, top = midH + bowH / 2, bot = midH - bowH / 2;
  const xc = -(bowLen - rEnd);
  outline.push([x0, bot]);                   // bottom-right
  // left semicircle, bottom → top, bulging in −L (endpoints ARE the corners)
  for (let a = -90; a <= 90; a += 12) {
    const r = a * Math.PI / 180;
    outline.push([xc - rEnd * Math.cos(r), midH + rEnd * Math.sin(r)]);
  }
  outline.push([x0, top]);                    // top-right

  // Keychain hole.
  const hole = [];
  const hx = xc, hy = midH, hr = holeDia / 2;
  for (let a = 0; a < 360; a += 20) {
    const r = a * Math.PI / 180;
    hole.push([hx + hr * Math.cos(r), hy + hr * Math.sin(r)]);
  }

  // Extrude the (L,h) outline (with hole) along t by ±thick/2.
  const flat = outline.flat();
  const holeStart = outline.length;
  flat.push(...hole.flat());
  const tris = earcut(flat, [holeStart], 2);
  const pts = outline.concat(hole);
  const y0 = -thick / 2, y1 = thick / 2;
  const front = pts.map(([L, h]) => mesh.v(L, y1, h));
  const back = pts.map(([L, h]) => mesh.v(L, y0, h));
  for (let i = 0; i < tris.length; i += 3) {
    mesh.tri(front[tris[i]], front[tris[i + 1]], front[tris[i + 2]]);
    mesh.tri(back[tris[i]], back[tris[i + 2]], back[tris[i + 1]]);
  }
  // Side walls around outer loop and hole.
  const wall = (ring, n, off) => {
    for (let i = 0; i < n; i++) {
      const a = off + i, b = off + (i + 1) % n;
      mesh.quad(front[a], back[a], back[b], front[b]);
    }
  };
  wall(front, outline.length, 0);
  wall(front, hole.length, outline.length);
}

// ── public API ───────────────────────────────────────────────────────────────
export function buildKeyMesh(blank, code, opts = {}) {
  const mesh = new Mesh();
  addBlade(mesh, blank, code);
  if (opts.bow !== false) addBow(mesh, blank, opts);
  return { positions: new Float32Array(mesh.pos), indices: new Uint32Array(mesh.idx) };
}

export function keyToSTL(blank, code, opts = {}) {
  const { positions, indices } = buildKeyMesh(blank, code, opts);
  const name = `${blank.id} ${code.join('-')}`;
  return toBinarySTL(positions, indices, name);
}
