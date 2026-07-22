// Copyright (C) 2026 Projects and Mods
// GPL-3.0-or-later WITH Commons Clause (non-commercial) - see LICENSE.

// Geometry assembly for vector CAD import.
//
// CAD files describe a drawing as loose primitives — line segments, polylines,
// arcs, circles — not as filled regions. To feed the app's trace model we must
// (1) stitch open segments into closed loops, (2) group loops into candidate
// "views" (a multi-view sheet has several), and (3) within a view pick the
// outer boundary and its holes. Arcs/circles are already flattened to polylines
// by the format parsers before they reach here.

import { signedArea, pointInPolygon } from '../contour.js';

const near = (a, b, tol) => Math.abs(a.x - b.x) <= tol && Math.abs(a.y - b.y) <= tol;

function dedupe(pts, tol) {
  const out = [];
  for (const p of pts) {
    if (!out.length || !near(out[out.length - 1], p, tol)) out.push({ x: p.x, y: p.y });
  }
  // Drop a duplicated closing point.
  if (out.length > 1 && near(out[0], out[out.length - 1], tol)) out.pop();
  return out;
}

export function bboxOf(pts) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pts) {
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
  }
  return { minX, minY, maxX, maxY };
}

// Stitch a list of polylines {pts, closed} into closed loops within tolerance.
// Already-closed polylines pass straight through; open chains are greedily
// joined end-to-end (either orientation) until nothing more connects, then any
// chain whose ends meet becomes a loop.
export function joinIntoLoops(polylines, tol) {
  const loops = [];
  const open = [];
  for (const pl of polylines) {
    const pts = pl.pts;
    if (!pts || pts.length < 2) continue;
    if (pl.closed || near(pts[0], pts[pts.length - 1], tol)) {
      const d = dedupe(pts, tol);
      if (d.length >= 3) loops.push(d);
    } else {
      open.push(pts.slice());
    }
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < open.length && !changed; i++) {
      for (let j = 0; j < open.length; j++) {
        if (i === j) continue;
        const a = open[i], b = open[j];
        const aEnd = a[a.length - 1], aStart = a[0];
        const bEnd = b[b.length - 1], bStart = b[0];
        let joined = null;
        if (near(aEnd, bStart, tol)) joined = a.concat(b.slice(1));
        else if (near(aEnd, bEnd, tol)) joined = a.concat(b.slice(0, -1).reverse());
        else if (near(aStart, bEnd, tol)) joined = b.concat(a.slice(1));
        else if (near(aStart, bStart, tol)) joined = b.slice().reverse().concat(a.slice(1));
        if (joined) {
          open[i] = joined;
          open.splice(j, 1);
          changed = true;
          break;
        }
      }
    }
  }

  for (const ch of open) {
    if (ch.length >= 4 && near(ch[0], ch[ch.length - 1], tol)) {
      const d = dedupe(ch, tol);
      if (d.length >= 3) loops.push(d);
    }
  }
  return loops;
}

// Group loops into views (bounding-box clusters) and classify each view's
// outer + holes. Returns [{ outer, holes, area, bbox }], largest view first.
export function loopsToViews(loops, tol) {
  const items = loops
    .map(pts => ({ pts, area: Math.abs(signedArea(pts)), bbox: bboxOf(pts) }))
    .filter(it => it.area > tol * tol * 4); // drop slivers
  if (!items.length) return [];

  // Union-find clustering: loops whose bounding boxes overlap (or nest) are the
  // same view. Slight padding tolerates dimension gaps.
  const parent = items.map((_, i) => i);
  const find = x => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  const union = (a, b) => { parent[find(a)] = find(b); };
  const overlap = (A, B) => !(A.maxX < B.minX - tol || B.maxX < A.minX - tol ||
                              A.maxY < B.minY - tol || B.maxY < A.minY - tol);
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      if (overlap(items[i].bbox, items[j].bbox)) union(i, j);
    }
  }

  const groups = new Map();
  items.forEach((it, i) => {
    const r = find(i);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(it);
  });

  const views = [];
  for (const g of groups.values()) {
    g.sort((a, b) => b.area - a.area);
    const outer = g[0];
    const holes = [];
    for (let k = 1; k < g.length; k++) {
      // A loop is a hole if a vertex lies inside the outer boundary.
      if (pointInPolygon(g[k].pts[0], outer.pts)) holes.push(g[k].pts);
      // (loops outside the outer are separate parts within the same cluster —
      // rare; folded in as holes only when contained, else ignored for v1)
    }
    views.push({ outer: outer.pts, holes, area: outer.area, bbox: outer.bbox });
  }
  views.sort((a, b) => b.area - a.area);
  return views;
}

// Full pipeline: flattened polylines (in mm) -> candidate views.
export function assembleViews(polylines, tol = 0.05) {
  return loopsToViews(joinIntoLoops(polylines, tol), tol);
}
