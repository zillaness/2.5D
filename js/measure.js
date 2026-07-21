// Measurement + geometry-reference utilities.
//
// Both the measure tool and the constraint system reference trace geometry
// through small serializable "refs" instead of copying coordinates, so
// annotations live-update as the trace is edited:
//
//   { kind:'vert',   loop, idx }      a polygon vertex
//   { kind:'mid',    loop, idx }      midpoint of edge idx (verts idx→idx+1)
//   { kind:'onedge', loop, idx, t }   point at parameter t along edge idx
//   { kind:'edge',   loop, idx }      the edge itself
//   { kind:'center', idx }            a manual circle's centre point
//   { kind:'circle', idx }            a manual circle (as an entity)
//   { kind:'holeloop', loop }         a traced hole, circle-fitted on demand
//
// loop addressing matches the trace editor: -1 = outer outline, 0..n-1 =
// traced holes, REGION_LOOP_BASE+i = section footprints.
//
// A "geo" adapter resolves refs against live geometry:
//   { loop(loopIdx) -> [{x,y}] | null,  circle(idx) -> {cx,cy,d} | null }

import { fitCircle, resampleClosed, signedArea, polygonPerimeter } from './contour.js';

export const REGION_LOOP_BASE = 1000;
const TAU = Math.PI * 2;

// ---- primitive geometry ----

export const dist = (a, b) => Math.hypot(b.x - a.x, b.y - a.y);

// Perpendicular distance from p to segment ab, with the foot point (clamped
// to the segment).
export function pointSegDist(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  let t = len2 > 1e-12 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const foot = { x: a.x + dx * t, y: a.y + dy * t };
  return { d: dist(p, foot), foot, t };
}

// Distance from p to the infinite line through ab (unclamped).
export function pointLineDist(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1e-12;
  return Math.abs(dx * (a.y - p.y) - (a.x - p.x) * dy) / len;
}

// Angle between two segments as vectors, in degrees [0, 180].
export function angleBetweenDeg(a1, a2, b1, b2) {
  const ux = a2.x - a1.x, uy = a2.y - a1.y;
  const vx = b2.x - b1.x, vy = b2.y - b1.y;
  const lu = Math.hypot(ux, uy), lv = Math.hypot(vx, vy);
  if (lu < 1e-12 || lv < 1e-12) return 0;
  const cos = Math.max(-1, Math.min(1, (ux * vx + uy * vy) / (lu * lv)));
  return Math.acos(cos) * 180 / Math.PI;
}

// Face-to-face gap between two (near-)parallel segments: the average of each
// midpoint's distance to the other's infinite line.
export function lineGap(a1, a2, b1, b2) {
  const mA = { x: (a1.x + a2.x) / 2, y: (a1.y + a2.y) / 2 };
  const mB = { x: (b1.x + b2.x) / 2, y: (b1.y + b2.y) / 2 };
  return (pointLineDist(mA, b1, b2) + pointLineDist(mB, a1, a2)) / 2;
}

export function bbox(pts) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pts) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return minX > maxX ? null : { minX, minY, maxX, maxY, w: maxX - minX, h: maxY - minY };
}

// ---- ref resolution ----

export function resolvePoint(ref, geo) {
  switch (ref.kind) {
    case 'vert': {
      const pts = geo.loop(ref.loop);
      return pts && pts[ref.idx] ? { x: pts[ref.idx].x, y: pts[ref.idx].y } : null;
    }
    case 'mid':
    case 'onedge': {
      const e = resolveEdge({ kind: 'edge', loop: ref.loop, idx: ref.idx }, geo);
      if (!e) return null;
      const t = ref.kind === 'mid' ? 0.5 : ref.t;
      return { x: e.a.x + (e.b.x - e.a.x) * t, y: e.a.y + (e.b.y - e.a.y) * t };
    }
    case 'center': {
      const c = geo.circle(ref.idx);
      return c ? { x: c.cx, y: c.cy } : null;
    }
    default:
      return null;
  }
}

export function resolveEdge(ref, geo) {
  if (ref.kind !== 'edge') return null;
  const pts = geo.loop(ref.loop);
  if (!pts || !pts[ref.idx]) return null;
  const b = pts[(ref.idx + 1) % pts.length];
  return b ? { a: { x: pts[ref.idx].x, y: pts[ref.idx].y }, b: { x: b.x, y: b.y } } : null;
}

// Circle-like ref -> {cx, cy, r} (manual circle directly, traced hole via fit).
export function resolveCircle(ref, geo) {
  if (ref.kind === 'circle') {
    const c = geo.circle(ref.idx);
    return c ? { cx: c.cx, cy: c.cy, r: c.d / 2 } : null;
  }
  if (ref.kind === 'holeloop') {
    const pts = geo.loop(ref.loop);
    if (!pts || pts.length < 3) return null;
    const fit = fitCircle(resampleClosed(pts, 64));
    return fit ? { cx: fit.cx, cy: fit.cy, r: fit.r, rms: fit.rms } : null;
  }
  return null;
}

// ---- measurements ----
// A measurement is { type, refs: [...] }:
//   p2p  refs [pointA, pointB]        straight distance + Δx/Δy
//   p2e  refs [point, edge]           perpendicular distance to the edge
//   elen refs [edge]                  edge length
//   e2e  refs [edgeA, edgeB]          angle between; face gap when ~parallel
//   rad  refs [circle | holeloop]     radius / diameter

export const PARALLEL_TOL_DEG = 5;

// Compute a measurement's current geometry + values, or null if any ref is
// stale. The caller formats/draws from the returned fields.
export function measureInfo(m, geo) {
  switch (m.type) {
    case 'p2p': {
      const a = resolvePoint(m.refs[0], geo), b = resolvePoint(m.refs[1], geo);
      if (!a || !b) return null;
      return { type: 'p2p', a, b, d: dist(a, b), dx: Math.abs(b.x - a.x), dy: Math.abs(b.y - a.y) };
    }
    case 'p2e': {
      const p = resolvePoint(m.refs[0], geo);
      const e = resolveEdge(m.refs[1], geo);
      if (!p || !e) return null;
      const { d, foot } = pointSegDist(p, e.a, e.b);
      return { type: 'p2e', p, foot, edge: e, d };
    }
    case 'elen': {
      const e = resolveEdge(m.refs[0], geo);
      if (!e) return null;
      return { type: 'elen', a: e.a, b: e.b, d: dist(e.a, e.b) };
    }
    case 'e2e': {
      const A = resolveEdge(m.refs[0], geo), B = resolveEdge(m.refs[1], geo);
      if (!A || !B) return null;
      const angle = angleBetweenDeg(A.a, A.b, B.a, B.b);
      // Fold to the line angle (0..90 from parallel) to decide "parallel-ish".
      const fromPar = Math.min(angle, 180 - angle);
      const gap = fromPar <= PARALLEL_TOL_DEG ? lineGap(A.a, A.b, B.a, B.b) : null;
      return { type: 'e2e', A, B, angle, gap };
    }
    case 'rad': {
      const c = resolveCircle(m.refs[0], geo);
      if (!c) return null;
      return { type: 'rad', cx: c.cx, cy: c.cy, r: c.r };
    }
    default:
      return null;
  }
}

// ---- tangent fillet arcs ----
// A fillet arc of radius r tangent to the two straight edges P1b→P1 and
// P2b→P2 that bracket a corner. Returns { C, r, T1, T2, mid } (r may be
// shrunk to keep the tangent points between the corner and P1/P2), or null
// when the edges are parallel / the corner is too shallow. The `mid` point is
// the arc's closest point to the corner (a stable sweep selector).
export function filletArc(P1b, P1, P2, P2b, r) {
  const d1 = { x: P1.x - P1b.x, y: P1.y - P1b.y };
  const d2 = { x: P2.x - P2b.x, y: P2.y - P2b.y };
  const den = d1.x * d2.y - d1.y * d2.x;
  if (Math.abs(den) < 1e-9) return null;
  const t = ((P2b.x - P1b.x) * d2.y - (P2b.y - P1b.y) * d2.x) / den;
  const V = { x: P1b.x + d1.x * t, y: P1b.y + d1.y * t };
  const nrm = v => { const l = Math.hypot(v.x, v.y) || 1e-9; return { x: v.x / l, y: v.y / l }; };
  const e1 = nrm({ x: P1.x - V.x, y: P1.y - V.y });
  const e2 = nrm({ x: P2.x - V.x, y: P2.y - V.y });
  const dot = Math.max(-1, Math.min(1, e1.x * e2.x + e1.y * e2.y));
  const phi = Math.acos(dot), alpha = phi / 2;
  if (alpha < 1e-3 || Math.PI - phi < 1e-3) return null;
  let rr = r, tanDist = rr / Math.tan(alpha);
  const maxTan = Math.min(Math.hypot(P1.x - V.x, P1.y - V.y),
    Math.hypot(P2.x - V.x, P2.y - V.y)) * 0.98;
  if (tanDist > maxTan) { tanDist = maxTan; rr = tanDist * Math.tan(alpha); }
  const cenDist = rr / Math.sin(alpha);
  const bis = nrm({ x: e1.x + e2.x, y: e1.y + e2.y });
  return {
    C: { x: V.x + bis.x * cenDist, y: V.y + bis.y * cenDist },
    r: rr,
    T1: { x: V.x + e1.x * tanDist, y: V.y + e1.y * tanDist },
    T2: { x: V.x + e2.x * tanDist, y: V.y + e2.y * tanDist },
    mid: { x: V.x + bis.x * (cenDist - rr), y: V.y + bis.y * (cenDist - rr) },
  };
}

// Exactly n points (n >= 2) along the arc of circle (cx,cy,r) from A to B,
// picking the sweep whose midpoint is nearest `nearMid`.
export function arcPointsN(cx, cy, r, A, B, nearMid, n) {
  const a0 = Math.atan2(A.y - cy, A.x - cx);
  const a1 = Math.atan2(B.y - cy, B.x - cx);
  const norm = a => { while (a <= -Math.PI) a += TAU; while (a > Math.PI) a -= TAU; return a; };
  let sweep = norm(a1 - a0);
  const mAng = a0 + sweep / 2;
  const mPt = { x: cx + r * Math.cos(mAng), y: cy + r * Math.sin(mAng) };
  const mAlt = { x: cx + r * Math.cos(mAng + Math.PI), y: cy + r * Math.sin(mAng + Math.PI) };
  if (nearMid && Math.hypot(mAlt.x - nearMid.x, mAlt.y - nearMid.y) <
      Math.hypot(mPt.x - nearMid.x, mPt.y - nearMid.y)) {
    sweep = sweep > 0 ? sweep - TAU : sweep + TAU;
  }
  const m = Math.max(2, n | 0);
  const out = [];
  for (let k = 0; k < m; k++) {
    const a = a0 + sweep * (k / (m - 1));
    out.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
  }
  return out;
}

// Loop stats for the info readout.
export function loopStats(pts) {
  if (!pts || pts.length < 3) return null;
  return {
    bbox: bbox(pts),
    perimeter: polygonPerimeter(pts),
    area: Math.abs(signedArea(pts)),
  };
}

// ---- ref remapping under edits ----
// Keeps measurements/constraints valid across trace edits. An item whose
// refs cannot be remapped is dropped. Ops:
//   { op:'splice', loop, lo, removed, added }  vertex splice on one loop:
//       removed=0            -> pure insert at lo
//       added=0              -> pure delete of [lo, lo+removed)
//       both > 0             -> endpoint-preserving run replacement
//                               (old lo -> lo, old lo+removed-1 -> lo+added-1)
//   { op:'deleteLoop', loop }   a hole/section loop removed (later shift down)
//   { op:'deleteCircle', idx }  a manual circle removed (later shift down)
//   { op:'clearLoops' }         all polygon loops replaced (retrace/import) —
//                               drop loop refs, keep circle-only items

const hasLoop = r => r.kind === 'vert' || r.kind === 'mid' || r.kind === 'onedge' ||
  r.kind === 'edge' || r.kind === 'holeloop';

// Same loop "space": traced holes (0..BASE-1) shift together, sections
// (BASE+) shift together; the outer outline (-1) never shifts.
const sameSpace = (a, b) =>
  (a >= 0 && a < REGION_LOOP_BASE && b >= 0 && b < REGION_LOOP_BASE) ||
  (a >= REGION_LOOP_BASE && b >= REGION_LOOP_BASE);

// Remap a single ref. Returns the (possibly rewritten) ref, or null to drop.
function remapRef(ref, op, loopLen) {
  if (op.op === 'clearLoops') return hasLoop(ref) ? null : ref;

  if (op.op === 'deleteCircle') {
    if (ref.kind !== 'center' && ref.kind !== 'circle') return ref;
    if (ref.idx === op.idx) return null;
    return ref.idx > op.idx ? { ...ref, idx: ref.idx - 1 } : ref;
  }

  if (op.op === 'deleteLoop') {
    if (!hasLoop(ref)) return ref;
    if (ref.loop === op.loop) return null;
    if (sameSpace(ref.loop, op.loop) && ref.loop > op.loop) return { ...ref, loop: ref.loop - 1 };
    return ref;
  }

  // splice
  if (!hasLoop(ref) || ref.kind === 'holeloop' || ref.loop !== op.loop) return ref;
  const { lo, removed: R, added: A } = op;
  const delta = A - R;

  if (ref.kind === 'vert') {
    const i = ref.idx;
    if (i < lo) return ref;
    if (i >= lo + R) return { ...ref, idx: i + delta };
    // Inside the spliced span: endpoint-preserving replacements keep the ends.
    if (A > 0 && R > 0 && i === lo) return ref;
    if (A > 0 && R > 0 && i === lo + R - 1) return { ...ref, idx: lo + A - 1 };
    if (R === 0) return { ...ref, idx: i + A }; // pure insert shifts i >= lo
    return null;
  }

  // edge-based refs (edge e spans verts e -> e+1)
  const e = ref.idx;
  if (R === 0) {
    // Pure insert at lo: the split edge lo-1 keeps its index (first half).
    return e < lo ? ref : { ...ref, idx: e + A };
  }
  if (A === 0) {
    // Pure delete of verts [lo, lo+R): drop edges touching a deleted vertex.
    const n = loopLen; // length BEFORE the splice
    const v2 = (e + 1) % n;
    const gone = i => i >= lo && i < lo + R;
    if (gone(e) || gone(v2)) return null;
    return e >= lo + R ? { ...ref, idx: e - R } : ref;
  }
  // Replacement: interior edges are new geometry — drop refs to them.
  if (e + 1 <= lo) return ref;
  if (e >= lo + R - 1) return { ...ref, idx: e + delta };
  return null;
}

// Remap every item's refs; drop items with any unmappable ref. `loopLen` is
// the pre-splice vertex count of the touched loop (needed for edge wrap).
export function remapRefs(items, op, loopLen = 0) {
  const out = [];
  for (const item of items) {
    const refs = [];
    let ok = true;
    for (const r of item.refs) {
      const nr = remapRef(r, op, loopLen);
      if (!nr) { ok = false; break; }
      refs.push(nr);
    }
    if (ok) out.push(refs.every((r, i) => r === item.refs[i]) ? item : { ...item, refs });
  }
  return out;
}
