// Geometric constraints on the trace, solved by sequential projection.
//
// Each constraint knows how to nudge its geometry toward satisfaction; the
// solver applies every constraint in turn (Gauss–Seidel style) until the
// largest correction of a pass falls under tolerance. That's far lighter
// than a Jacobian sketch solver and plenty for trace-sized problems, at the
// cost of no over/under-constraint diagnosis (conflicting constraints just
// settle on a compromise).
//
// Constraint objects are { type, refs:[...], value? } with refs from
// measure.js. Anchored points (type 'anchor', or extra anchors passed by the
// caller — e.g. the vertex being dragged) get weight 0 and never move; every
// correction is distributed by weight, so anchoring one side pushes the
// whole correction onto the other.
//
//   h / v        refs [edge]                     horizontal / vertical
//   len          refs [edge],           value mm fixed edge length
//   perp / para  refs [edgeA, edgeB]             90° / 0° between edges
//   angle        refs [edgeA, edgeB],   value °  fixed angle between edges
//   equal        refs [edgeA, edgeB]             equal lengths
//   collin       refs [edgeA, edgeB]             both on one line
//   dist         refs [pt|center, pt|center|edge], value mm  fixed distance
//   conc         refs [circle, circle]           concentric centres
//   anchor       refs [vert|center]              pin the point

const TAU = Math.PI * 2;

// Fold an angle difference to (-PI/2, PI/2] — edges act as undirected lines.
function foldLine(a) {
  while (a <= -Math.PI / 2) a += Math.PI;
  while (a > Math.PI / 2) a -= Math.PI;
  return a;
}

export function solveConstraints(geo, constraints, opts = {}) {
  const { iterations = 120, tol = 1e-4, extraAnchors = [] } = opts;

  // ---- anchored-point weights ----
  const anchored = new Set();
  const keyOf = ref => ref.kind === 'center' ? `c:${ref.idx}` : `${ref.loop}:${ref.idx}`;
  for (const c of constraints) {
    if (c.type === 'anchor') for (const r of c.refs) anchored.add(keyOf(r));
  }
  for (const r of extraAnchors) anchored.add(keyOf(r));

  // Live point handles: mutate {x,y} in place; track the pass's max move.
  let maxMove = 0;
  const vertPt = (loop, idx) => {
    const pts = geo.loop(loop);
    return pts ? pts[idx] : null;
  };
  const handle = ref => {
    // -> { p:{x,y}, w, apply(dx,dy) } or null
    if (ref.kind === 'vert') {
      const p = vertPt(ref.loop, ref.idx);
      if (!p) return null;
      const w = anchored.has(`${ref.loop}:${ref.idx}`) ? 0 : 1;
      return { p, w, apply(dx, dy) { p.x += dx; p.y += dy; maxMove = Math.max(maxMove, Math.hypot(dx, dy)); } };
    }
    if (ref.kind === 'center' || ref.kind === 'circle') {
      const c = geo.circle(ref.idx);
      if (!c) return null;
      const w = anchored.has(`c:${ref.idx}`) ? 0 : 1;
      return {
        p: { get x() { return c.cx; }, get y() { return c.cy; } }, w,
        apply(dx, dy) { c.cx += dx; c.cy += dy; maxMove = Math.max(maxMove, Math.hypot(dx, dy)); },
      };
    }
    return null;
  };
  const edgeHandles = ref => {
    if (ref.kind !== 'edge') return null;
    const pts = geo.loop(ref.loop);
    if (!pts || !pts[ref.idx]) return null;
    const j = (ref.idx + 1) % pts.length;
    const a = handle({ kind: 'vert', loop: ref.loop, idx: ref.idx });
    const b = handle({ kind: 'vert', loop: ref.loop, idx: j });
    return a && b ? { a, b } : null;
  };

  // Move two point handles toward/away along a direction so their scalar
  // separation changes by err, split by weight.
  const separate = (A, B, ux, uy, err) => {
    const wsum = A.w + B.w;
    if (wsum <= 0) return;
    A.apply(-ux * err * (A.w / wsum), -uy * err * (A.w / wsum));
    B.apply(ux * err * (B.w / wsum), uy * err * (B.w / wsum));
  };

  // Rotate an edge by phi. Pivot: the anchored endpoint if there is exactly
  // one, else the midpoint (splitting the rotation between both ends).
  const rotateEdge = (E, phi) => {
    const { a, b } = E;
    if (a.w <= 0 && b.w <= 0) return;
    let px, py;
    if (a.w <= 0) { px = a.p.x; py = a.p.y; }
    else if (b.w <= 0) { px = b.p.x; py = b.p.y; }
    else { px = (a.p.x + b.p.x) / 2; py = (a.p.y + b.p.y) / 2; }
    const cos = Math.cos(phi), sin = Math.sin(phi);
    for (const h of [a, b]) {
      if (h.w <= 0) continue;
      const rx = h.p.x - px, ry = h.p.y - py;
      h.apply(rx * cos - ry * sin - rx, rx * sin + ry * cos - ry);
    }
  };

  const edgeAngle = E => Math.atan2(E.b.p.y - E.a.p.y, E.b.p.x - E.a.p.x);
  const edgeLen = E => Math.hypot(E.b.p.x - E.a.p.x, E.b.p.y - E.a.p.y);
  // How much rotation weight an edge contributes (0 = fully anchored).
  const edgeW = E => (E.a.w + E.b.w) / 2;

  // Project one constraint. Unresolvable refs are skipped silently — the
  // editor prunes stale constraints, this is just belt-and-braces.
  const project = c => {
    switch (c.type) {
      case 'h': case 'v': {
        const E = edgeHandles(c.refs[0]);
        if (!E) return;
        const { a, b } = E;
        if (c.type === 'h') separate(a, b, 0, 1, -(b.p.y - a.p.y));
        else separate(a, b, 1, 0, -(b.p.x - a.p.x));
        return;
      }
      case 'len': {
        const E = edgeHandles(c.refs[0]);
        if (!E || !(c.value > 0)) return;
        const d = edgeLen(E);
        if (d < 1e-9) return;
        const ux = (E.b.p.x - E.a.p.x) / d, uy = (E.b.p.y - E.a.p.y) / d;
        separate(E.a, E.b, ux, uy, c.value - d);
        return;
      }
      case 'perp': case 'para': case 'angle': {
        const A = edgeHandles(c.refs[0]), B = edgeHandles(c.refs[1]);
        if (!A || !B) return;
        const target = c.type === 'perp' ? Math.PI / 2
          : c.type === 'para' ? 0
          : (c.value || 0) * Math.PI / 180;
        // Undirected line angles: fold everything mod PI.
        const err = foldLine(target - (edgeAngle(B) - edgeAngle(A)));
        const wA = edgeW(A), wB = edgeW(B), wsum = wA + wB;
        if (wsum <= 0) return;
        rotateEdge(A, -err * (wA / wsum));
        rotateEdge(B, err * (wB / wsum));
        return;
      }
      case 'equal': {
        const A = edgeHandles(c.refs[0]), B = edgeHandles(c.refs[1]);
        if (!A || !B) return;
        const la = edgeLen(A), lb = edgeLen(B);
        if (la < 1e-9 || lb < 1e-9) return;
        const wA = edgeW(A), wB = edgeW(B), wsum = wA + wB;
        if (wsum <= 0) return;
        const m = (la * wB + lb * wA) / wsum; // weighted: anchored edge wins
        for (const [E, l] of [[A, la], [B, lb]]) {
          const ux = (E.b.p.x - E.a.p.x) / l, uy = (E.b.p.y - E.a.p.y) / l;
          separate(E.a, E.b, ux, uy, m - l);
        }
        return;
      }
      case 'collin': {
        const A = edgeHandles(c.refs[0]), B = edgeHandles(c.refs[1]);
        if (!A || !B) return;
        // Common line: weighted centroid + averaged direction (B flipped to
        // align with A), then pull every movable point onto it (relaxed).
        let dax = A.b.p.x - A.a.p.x, day = A.b.p.y - A.a.p.y;
        let dbx = B.b.p.x - B.a.p.x, dby = B.b.p.y - B.a.p.y;
        if (dax * dbx + day * dby < 0) { dbx = -dbx; dby = -dby; }
        let dx = dax + dbx, dy = day + dby;
        const dl = Math.hypot(dx, dy);
        if (dl < 1e-9) return;
        dx /= dl; dy /= dl;
        const hs = [A.a, A.b, B.a, B.b];
        let cx = 0, cy = 0, wsum = 0;
        for (const h of hs) {
          const w = h.w > 0 ? 1 : 4; // anchored points dominate the line fit
          cx += h.p.x * w; cy += h.p.y * w; wsum += w;
        }
        cx /= wsum; cy /= wsum;
        const nx = -dy, ny = dx;
        for (const h of hs) {
          if (h.w <= 0) continue;
          const e = (h.p.x - cx) * nx + (h.p.y - cy) * ny;
          h.apply(-nx * e * 0.7, -ny * e * 0.7);
        }
        return;
      }
      case 'dist': {
        const [rA, rB] = c.refs;
        if (!(c.value >= 0)) return;
        if (rB.kind === 'edge') {
          // Point to edge line at fixed distance.
          const P = handle(rA), E = edgeHandles(rB);
          if (!P || !E) return;
          const ex = E.b.p.x - E.a.p.x, ey = E.b.p.y - E.a.p.y;
          const el = Math.hypot(ex, ey);
          if (el < 1e-9) return;
          let nx = -ey / el, ny = ex / el;
          let d = (P.p.x - E.a.p.x) * nx + (P.p.y - E.a.p.y) * ny;
          if (d < 0) { nx = -nx; ny = -ny; d = -d; }
          const err = c.value - d; // move P out (+) or in (−) along n
          const wE = edgeW(E), wsum = P.w + wE;
          if (wsum <= 0) return;
          P.apply(nx * err * (P.w / wsum), ny * err * (P.w / wsum));
          const sE = -err * (wE / wsum);
          for (const h of [E.a, E.b]) if (h.w > 0) h.apply(nx * sE, ny * sE);
          return;
        }
        const A = handle(rA), B = handle(rB);
        if (!A || !B) return;
        const d = Math.hypot(B.p.x - A.p.x, B.p.y - A.p.y);
        if (d < 1e-9) return;
        const ux = (B.p.x - A.p.x) / d, uy = (B.p.y - A.p.y) / d;
        separate(A, B, ux, uy, c.value - d);
        return;
      }
      case 'conc': {
        const A = handle(c.refs[0]), B = handle(c.refs[1]);
        if (!A || !B) return;
        separate(A, B, 1, 0, -(B.p.x - A.p.x));
        separate(A, B, 0, 1, -(B.p.y - A.p.y));
        return;
      }
      // 'anchor' acts through the weight table only.
    }
  };

  let iter = 0;
  for (; iter < iterations; iter++) {
    maxMove = 0;
    for (const c of constraints) project(c);
    if (maxMove < tol) break;
  }
  return { iterations: iter + 1, converged: maxMove < tol, maxMove };
}
