// The joint fit: several sheets on one plane
// (docs/calibration_and_backlog_prd_v1.2.md, Part A phase 2, plan step 15).
//
// Every sheet found lies on the table, so there is one mapping from the
// table to the photo, a homography and one lens term, shared by all of them.
// Each sheet adds only where it lies on the table (a rotation and a
// position) and, per print job, a print scale. The table's coordinates are
// real millimetres in the anchor sheet's design axes: the anchor is fixed at
// the origin with no rotation, and its job's print scale is fixed too, from
// that job's verdict (its edges, a ruler, a print check on record, or a 1:1
// print assumed), because the frames alone cannot tell a print scale from a
// camera distance. Another job's scale is observable against the anchor's
// frames and is fitted, then compared with that job's own edges.
//
// The unknowns are solved by Levenberg-Marquardt with a numerical Jacobian,
// initialised from each sheet's single-sheet fit. The residuals are in
// table millimetres: a clock cell against where its design position lands,
// a frame dip against its design line. With eight sheets that is about
// thirty-five unknowns against several thousand residuals.

import { lensParams, undistortPixel, distortPixel } from './lens.js';
import { invert3, apply, frameLine } from './calibFit.js';
import { PAPER_SIZES } from './paperSizes.js';
import { jobHex } from './calibSheet.js';

export const JOINT_DEFAULTS = {
  iterations: 30,
  lambda: 1e-3,
  tolerance: 1e-7,      // relative cost change that ends the iterations
  lineWeight: 1,
  dipStep: 1,           // every nth frame dip is a residual (1: all of them)
  fitLens: true,
};

function solve(A, b) {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    if (Math.abs(M[piv][col]) < 1e-18) return null;
    if (piv !== col) [M[col], M[piv]] = [M[piv], M[col]];
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = M[r][col] / M[col][col];
      if (f === 0) continue;
      for (let c = col; c <= n; c++) M[r][c] -= f * M[col][c];
    }
  }
  return M.map((row, i) => row[n] / row[i]);
}

// A similarity (scale s, rotation th, translation t) taking points p to
// points q, least squares (Umeyama without the reflection case).
export function similarity(p, q) {
  const n = p.length;
  let px = 0, py = 0, qx = 0, qy = 0;
  for (let i = 0; i < n; i++) { px += p[i].x; py += p[i].y; qx += q[i].x; qy += q[i].y; }
  px /= n; py /= n; qx /= n; qy /= n;
  let sxx = 0, sxy = 0, syx = 0, syy = 0, pp = 0;
  for (let i = 0; i < n; i++) {
    const ax = p[i].x - px, ay = p[i].y - py, bx = q[i].x - qx, by = q[i].y - qy;
    sxx += ax * bx; sxy += ax * by; syx += ay * bx; syy += ay * by; pp += ax * ax + ay * ay;
  }
  const th = Math.atan2(sxy - syx, sxx + syy);
  const c = Math.cos(th), s = Math.sin(th);
  const scale = ((sxx + syy) * c + (sxy - syx) * s) / pp;
  return { s: scale, th, tx: qx - scale * (c * px - s * py), ty: qy - scale * (s * px + c * py) };
}

// Which sheet anchors the table: a complete one (four sides) with the
// lowest job and number, so the same photo always gets the same frame.
export function chooseAnchor(sheets) {
  const order = (a, b) => (a.identity.job - b.identity.job) || (a.identity.sheet - b.identity.sheet);
  const full = sheets.filter(s => s.sidesFound === 4).sort(order);
  if (full.length) return sheets.indexOf(full[0]);
  const any = sheets.slice().sort((a, b) => (b.words - a.words) || order(a, b));
  return sheets.indexOf(any[0]);
}

// Fit the set. sheets: the finder's sheets (each with rec, fit, identity);
// scales: {job: {x, y}} the verdict scale of each job that has one, the
// anchor's taken as fixed. Returns null when there is nothing to fit
// together (fewer than two sheets).
export function fitSheets(sheets, imgW, imgH, scales = {}, opts = {}) {
  const o = { ...JOINT_DEFAULTS, ...opts };
  if (!sheets || sheets.length < 2) return null;
  const lp = lensParams(imgW, imgH);
  const anchor = chooseAnchor(sheets);
  const A = sheets[anchor];
  const anchorJob = A.identity.job;
  const jobs = [...new Set(sheets.map(s => s.identity.job))];
  const fixedScale = scales[anchorJob] && Number.isFinite(scales[anchorJob].x) ? { x: scales[anchorJob].x, y: scales[anchorJob].y } : { x: 1, y: 1 };
  const freeJobs = jobs.filter(j => j !== anchorJob);

  // ---- parameters: H (8, table -> photo), k1, per non-anchor sheet (th, tx, ty), per free job (sx, sy)
  const sheetIdx = sheets.map((s, i) => i).filter(i => i !== anchor);
  const nParams = 8 + 1 + 3 * sheetIdx.length + 2 * freeJobs.length;
  const pos = { H: 0, k1: 8, sheet: i => 9 + 3 * sheetIdx.indexOf(i), job: j => 9 + 3 * sheetIdx.length + 2 * freeJobs.indexOf(j) };

  // ---- initial values from the single-sheet fits
  const p0 = new Float64Array(nParams);
  // Table -> photo: the anchor's design -> photo through design -> table, which is the fixed scale.
  const HA = A.fit.H;
  const H0 = [HA[0] / fixedScale.x, HA[1] / fixedScale.y, HA[2], HA[3] / fixedScale.x, HA[4] / fixedScale.y, HA[5], HA[6] / fixedScale.x, HA[7] / fixedScale.y, HA[8]];
  for (let i = 0; i < 8; i++) p0[i] = H0[i] / H0[8];
  // One lens term: the median of the sheets' own.
  const k1s = sheets.map(s => s.fit.k1).sort((a, b) => a - b);
  p0[pos.k1] = o.fitLens === false ? (Number(o.k1) || 0) : k1s[k1s.length >> 1];
  const G0 = invert3(H0);
  if (!G0) return null;
  const jobScale0 = {};
  for (const i of sheetIdx) {
    const s = sheets[i];
    // The sheet's design corners through its own fit into the photo, then
    // into the table through the anchor's: a similarity from the sheet's
    // paper millimetres (design times its job's scale, or the anchor's
    // for want of one) to the table.
    const sc = scales[s.identity.job] && Number.isFinite(scales[s.identity.job].x) ? scales[s.identity.job] : fixedScale;
    const g = s.fit.geom.frame.outer;
    const dc = [[g.x, g.y], [g.x + g.w, g.y], [g.x + g.w, g.y + g.h], [g.x, g.y + g.h]].map(([x, y]) => ({ x, y }));
    const paper = dc.map(p => ({ x: p.x * sc.x, y: p.y * sc.y }));
    const table = dc.map(p => { const q = s.fit.H ? apply(s.fit.H, p.x, p.y) : null; return apply(G0, q.x, q.y); });
    const sim = similarity(paper, table);
    p0[pos.sheet(i)] = sim.th; p0[pos.sheet(i) + 1] = sim.tx; p0[pos.sheet(i) + 2] = sim.ty;
    if (s.identity.job !== anchorJob) {
      const j = s.identity.job;
      jobScale0[j] = jobScale0[j] || [];
      jobScale0[j].push({ x: sc.x * sim.s, y: sc.y * sim.s });
    }
  }
  for (const j of freeJobs) {
    const list = jobScale0[j] || [{ x: 1, y: 1 }];
    p0[pos.job(j)] = list.reduce((a, v) => a + v.x, 0) / list.length;
    p0[pos.job(j) + 1] = list.reduce((a, v) => a + v.y, 0) / list.length;
  }

  // ---- residual terms
  const terms = [];
  for (let i = 0; i < sheets.length; i++) {
    const s = sheets[i];
    for (const p of s.rec.points || []) if (p.raw) terms.push({ kind: 'point', sheet: i, raw: p.raw, design: p.design });
    let n = 0;
    for (const l of s.rec.lines || []) {
      const line = frameLine(s.fit.geom, l.side);
      if (!line) continue;
      for (const r of l.raw || []) { if ((n++ % o.dipStep) !== 0) continue; terms.push({ kind: 'line', sheet: i, raw: r, a: line.a, b: line.b, c: line.c, norm: Math.hypot(line.a, line.b) }); }
    }
  }
  const nRes = terms.reduce((n, t) => n + (t.kind === 'point' ? 2 : 1), 0);
  if (nRes < nParams + 8) return null;

  const unpack = p => {
    const H = [p[0], p[1], p[2], p[3], p[4], p[5], p[6], p[7], 1];
    const G = invert3(H);
    const k1 = p[pos.k1];
    const poseOf = i => (i === anchor ? { th: 0, tx: 0, ty: 0 } : { th: p[pos.sheet(i)], tx: p[pos.sheet(i) + 1], ty: p[pos.sheet(i) + 2] });
    const scaleOf = j => (j === anchorJob ? fixedScale : { x: p[pos.job(j)], y: p[pos.job(j) + 1] });
    return { H, G, k1, poseOf, scaleOf };
  };
  // Residuals in table millimetres. A photo point is undistorted and taken
  // to the table; a clock cell's design position is taken to the table
  // through its sheet's scale and pose; a dip's table point is taken back
  // into its sheet's design frame and measured against its line.
  const residuals = (p, out) => {
    const { G, k1, poseOf, scaleOf } = unpack(p);
    if (!G) { out.fill(1e3); return; }
    const poses = sheets.map((s, i) => { const q = poseOf(i); return { c: Math.cos(q.th), s: Math.sin(q.th), tx: q.tx, ty: q.ty, sc: scaleOf(s.identity.job) }; });
    let r = 0;
    for (const t of terms) {
      const u = k1 ? undistortPixel(t.raw, k1, 0, lp) : t.raw;
      const w = G[6] * u.x + G[7] * u.y + G[8];
      const X = (G[0] * u.x + G[1] * u.y + G[2]) / w, Y = (G[3] * u.x + G[4] * u.y + G[5]) / w;
      const q = poses[t.sheet];
      if (t.kind === 'point') {
        const px = t.design.x * q.sc.x, py = t.design.y * q.sc.y;
        out[r++] = X - (q.tx + px * q.c - py * q.s);
        out[r++] = Y - (q.ty + px * q.s + py * q.c);
      } else {
        // table -> sheet paper -> design
        const dx = X - q.tx, dy = Y - q.ty;
        const px = dx * q.c + dy * q.s, py = -dx * q.s + dy * q.c;
        const ddx = px / q.sc.x, ddy = py / q.sc.y;
        out[r++] = (t.a * ddx + t.b * ddy - t.c) / t.norm * o.lineWeight;
      }
    }
  };

  // ---- Levenberg-Marquardt
  let p = Float64Array.from(p0);
  const res = new Float64Array(nRes), res2 = new Float64Array(nRes);
  residuals(p, res);
  let cost = 0;
  for (let i = 0; i < nRes; i++) cost += res[i] * res[i];
  let lambda = o.lambda, iterations = 0;
  const J = Array.from({ length: nParams }, () => new Float64Array(nRes));
  const steps = new Float64Array(nParams);
  for (let i = 0; i < 8; i++) steps[i] = 1e-6 * Math.max(1, Math.abs(p[i]));
  steps[pos.k1] = 1e-5;
  for (const i of sheetIdx) { steps[pos.sheet(i)] = 1e-6; steps[pos.sheet(i) + 1] = 1e-4; steps[pos.sheet(i) + 2] = 1e-4; }
  for (const j of freeJobs) { steps[pos.job(j)] = 1e-6; steps[pos.job(j) + 1] = 1e-6; }
  const free = [];
  for (let i = 0; i < nParams; i++) if (!(i === pos.k1 && o.fitLens === false)) free.push(i);
  for (let it = 0; it < o.iterations; it++) {
    iterations = it + 1;
    // Numerical Jacobian, forward differences.
    for (const k of free) {
      const saved = p[k];
      p[k] = saved + steps[k];
      residuals(p, res2);
      p[k] = saved;
      const col = J[k];
      for (let i = 0; i < nRes; i++) col[i] = (res2[i] - res[i]) / steps[k];
    }
    // Normal equations over the free parameters.
    const n = free.length;
    const JtJ = Array.from({ length: n }, () => new Array(n).fill(0));
    const Jtr = new Array(n).fill(0);
    for (let a = 0; a < n; a++) {
      const ca = J[free[a]];
      let s = 0;
      for (let i = 0; i < nRes; i++) s += ca[i] * res[i];
      Jtr[a] = -s;
      for (let b = a; b < n; b++) {
        const cb = J[free[b]];
        let t = 0;
        for (let i = 0; i < nRes; i++) t += ca[i] * cb[i];
        JtJ[a][b] = t; JtJ[b][a] = t;
      }
    }
    let improved = false;
    for (let tries = 0; tries < 8; tries++) {
      const M = JtJ.map((row, a) => row.map((v, b) => (a === b ? v * (1 + lambda) + 1e-12 : v)));
      const d = solve(M, Jtr);
      if (!d) { lambda *= 10; continue; }
      const q = Float64Array.from(p);
      for (let a = 0; a < n; a++) q[free[a]] += d[a];
      residuals(q, res2);
      let c2 = 0;
      for (let i = 0; i < nRes; i++) c2 += res2[i] * res2[i];
      if (c2 < cost) {
        const rel = (cost - c2) / cost;
        p = q; res.set(res2); cost = c2; lambda = Math.max(1e-9, lambda / 3); improved = true;
        if (rel < o.tolerance) it = o.iterations;
        break;
      }
      lambda *= 10;
    }
    if (!improved) break;
  }

  // ---- the result
  const { H, G, k1, poseOf, scaleOf } = unpack(p);
  if (!G) return null;
  const pointRes = [], lineRes = [];
  let r = 0;
  for (const t of terms) {
    if (t.kind === 'point') { pointRes.push(Math.hypot(res[r], res[r + 1])); r += 2; } else { lineRes.push(Math.abs(res[r]) / o.lineWeight); r += 1; }
  }
  const rms = arr => (arr.length ? Math.sqrt(arr.reduce((s, v) => s + v * v, 0) / arr.length) : 0);
  const tableToPhoto = pt => { const q = apply(H, pt.x, pt.y); return k1 ? distortPixel(q, k1, 0, lp) : q; };
  const photoToTable = pt => { const u = k1 ? undistortPixel(pt, k1, 0, lp) : pt; return apply(G, u.x, u.y); };
  const sheetOut = sheets.map((s, i) => {
    const q = poseOf(i), sc = scaleOf(s.identity.job);
    const c = Math.cos(q.th), sn = Math.sin(q.th);
    const designToTable = d => { const px = d.x * sc.x, py = d.y * sc.y; return { x: q.tx + px * c - py * sn, y: q.ty + px * sn + py * c }; };
    const tableToDesign = t => { const dx = t.x - q.tx, dy = t.y - q.ty; return { x: (dx * c + dy * sn) / sc.x, y: (-dx * sn + dy * c) / sc.y }; };
    const perSheet = [];
    let k = 0;
    for (const t of terms) { const v = t.kind === 'point' ? pointRes[k] : null; if (t.kind === 'point') { if (t.sheet === i) perSheet.push(v); k++; } }
    return {
      index: i, identity: s.identity, anchor: i === anchor, pose: { thetaDeg: q.th * 180 / Math.PI, tx: q.tx, ty: q.ty }, scale: sc,
      designToTable, tableToDesign, designToPhoto: d => tableToPhoto(designToTable(d)),
      rmsMm: rms(perSheet), points: perSheet.length,
    };
  });
  const jobOut = {};
  for (const j of jobs) jobOut[j] = { scale: scaleOf(j), fixed: j === anchorJob, from: j === anchorJob ? (scales[j] && scales[j].source) || 'assumed 1:1' : 'fitted against the anchor set' };
  return {
    ok: true, H, G, k1: Math.round(k1 * 1e4) / 1e4, anchor, anchorJob, fixedScale,
    sheets: sheetOut, jobs: jobOut,
    fit: { rmsMm: rms(pointRes.concat(lineRes)), pointsMm: rms(pointRes), linesMm: rms(lineRes), points: pointRes.length, lines: lineRes.length, iterations, params: nParams },
    tableToPhoto, photoToTable,
  };
}

// The angle of the photo's x axis on the table, at the photo's centre: the
// rectified table keeps the photo's orientation rather than the anchor
// sheet's, which was laid by hand at any angle.
export function tableAxisAngle(joint, imgW, imgH) {
  const p0 = joint.photoToTable({ x: imgW / 2, y: imgH / 2 });
  const p1 = joint.photoToTable({ x: imgW / 2 + 100, y: imgH / 2 });
  return Math.atan2(p1.y - p0.y, p1.x - p0.x);
}

// The rectangle on the table that holds every sheet's paper, from each
// sheet's verdict rectangle (design mm) through its pose, with a margin,
// axis-aligned in a frame rotated by `phi` (tableAxisAngle). Returns
// { x0, y0, w, h, phi, corners (table mm, TL TR BR BL), toLocal } where
// toLocal takes a table point to millimetres from the rectangle's top-left
// corner along its own axes, which is what the rectified image is.
export function tableExtent(joint, rects, marginMm = 0, phi = 0) {
  const c = Math.cos(phi), s = Math.sin(phi);
  const rot = t => ({ x: t.x * c + t.y * s, y: -t.x * s + t.y * c });
  const unrot = r => ({ x: r.x * c - r.y * s, y: r.x * s + r.y * c });
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  joint.sheets.forEach((sh, i) => {
    const rc = rects && rects[i] && rects[i].corners;
    const stock = PAPER_SIZES[sh.identity.paper];
    const dW = Math.min(stock.w, stock.h), dH = Math.max(stock.w, stock.h);
    const corners = rc || [{ x: 0, y: 0 }, { x: dW, y: 0 }, { x: dW, y: dH }, { x: 0, y: dH }];
    for (const q of corners) {
      const r = rot(sh.designToTable(q));
      x0 = Math.min(x0, r.x); y0 = Math.min(y0, r.y); x1 = Math.max(x1, r.x); y1 = Math.max(y1, r.y);
    }
  });
  x0 -= marginMm; y0 -= marginMm; x1 += marginMm; y1 += marginMm;
  const corners = [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }].map(unrot);
  const toLocal = t => { const r = rot(t); return { x: r.x - x0, y: r.y - y0 }; };
  const fromLocal = l => unrot({ x: l.x + x0, y: l.y + y0 });
  return { x0, y0, w: x1 - x0, h: y1 - y0, phi, corners, toLocal, fromLocal };
}

// One paragraph for the panel: the plane, the lens, and each job's scale
// with where it came from. jobs[j].own is the job's own verdict scale when
// a sheet of it had one, and jobs[j].disagrees says the fitted scale and
// the job's own edges differ by more than the band.
export function describeJoint(joint, jobHexFn) {
  if (!joint || !joint.ok) return '';
  const hex = jobHexFn || jobHex;
  const pct = v => `${(v * 100).toFixed(1)} percent`;
  const n = joint.sheets.length;
  let text = `Fitted together: ${n} sheets on one plane, ${joint.fit.rmsMm.toFixed(3)} mm over ${joint.fit.points} cells and ${joint.fit.lines} frame points` +
    `${joint.k1 ? `, lens ${joint.k1.toFixed(3)}` : ''}.`;
  for (const [j, info] of Object.entries(joint.jobs)) {
    const sc = info.scale;
    const same = Math.abs(sc.x - sc.y) < 0.0005;
    const scaleText = same ? pct(sc.x) : `${pct(sc.x)} across and ${pct(sc.y)} down`;
    if (info.fixed) {
      const from = info.own ? `from sheet ${info.own.sheet}'s ${info.own.source === 'edges' ? 'edges' : info.own.source === 'ruler' ? 'ruler' : 'print check'}` : 'assumed, no edges or print check';
      text += ` Set ${hex(+j)}: printed at ${scaleText}, ${from}.`;
    } else {
      text += ` Set ${hex(+j)}: ${scaleText}, fitted against set ${hex(joint.anchorJob)}`;
      if (info.own) text += info.disagrees ? `; its own ${info.own.source === 'ruler' ? 'ruler' : 'edges'} say ${pct(info.own.x)}, which disagrees: check that sheet.` : `, and its own ${info.own.source === 'ruler' ? 'ruler' : 'edges'} agree (${pct(info.own.x)}).`;
      else text += '.';
    }
  }
  return text;
}
