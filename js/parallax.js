// Parallax: the camera's position from a calibration sheet's homography,
// and the correction a thick part needs
// (docs/calibration_and_backlog_prd_v1.2.md, Part A phase 3).
//
// A flat pattern photographed from straight above cannot say how far the
// camera was: a near camera with a wide lens and a far one with a narrow
// lens take the same picture of a plane. One fact from outside the plane
// settles it: the lens's focal length, which phones write into the file, or
// a sheet raised to a known height. With the focal length, the exact
// homography from the sheet's plane to the photo decomposes into the
// camera's rotation and position: its height above the plane, its tilt,
// and the point on the plane directly below it. A part of thickness t then
// shows its top face magnified by D / (D - t) about that point, whatever
// the tilt, and rectifying at the top plane undoes exactly that.

// Decompose H (plane mm -> undistorted photo px, pixel k at coordinate k)
// with focal length f px and principal point pp. Returns { ok, height,
// tiltDeg, below: {x, y} plane mm, camera: {x, y, z}, R, scaleSpread }
// where scaleSpread is how far the two rotation columns' lengths disagree,
// a measure of how well H is a camera at all.
export function cameraFromHomography(H, f, pp) {
  if (!H || !(f > 0) || !pp) return { ok: false, reason: 'no homography or focal length' };
  // K^-1 H: K = [f 0 cx; 0 f cy; 0 0 1].
  const h = H.map(v => v / H[8]);
  const a = [
    (h[0] - pp.x * h[6]) / f, (h[1] - pp.x * h[7]) / f, (h[2] - pp.x * h[8]) / f,
    (h[3] - pp.y * h[6]) / f, (h[4] - pp.y * h[7]) / f, (h[5] - pp.y * h[8]) / f,
    h[6], h[7], h[8],
  ];
  const c1 = [a[0], a[3], a[6]], c2 = [a[1], a[4], a[7]], c3 = [a[2], a[5], a[8]];
  const n1 = Math.hypot(...c1), n2 = Math.hypot(...c2);
  if (!(n1 > 0) || !(n2 > 0)) return { ok: false, reason: 'degenerate' };
  const lambda = 2 / (n1 + n2);
  let r1 = c1.map(v => v * lambda), r2 = c2.map(v => v * lambda), t = c3.map(v => v * lambda);
  // The plane must be in front of the camera: t_z > 0, else flip the sign.
  if (t[2] < 0) { r1 = r1.map(v => -v); r2 = r2.map(v => -v); t = t.map(v => -v); }
  // Orthogonalise r1, r2 symmetrically, then r3 = r1 x r2.
  const dot = (p, q) => p[0] * q[0] + p[1] * q[1] + p[2] * q[2];
  const norm = v => { const n = Math.hypot(...v); return v.map(x => x / n); };
  const sum = (p, q) => p.map((v, i) => v + q[i]), diff = (p, q) => p.map((v, i) => v - q[i]);
  const u = norm(sum(r1, r2)), w = norm(diff(r1, r2));
  const s2 = Math.SQRT1_2;
  r1 = [(u[0] + w[0]) * s2, (u[1] + w[1]) * s2, (u[2] + w[2]) * s2];
  r2 = [(u[0] - w[0]) * s2, (u[1] - w[1]) * s2, (u[2] - w[2]) * s2];
  const r3 = [r1[1] * r2[2] - r1[2] * r2[1], r1[2] * r2[0] - r1[0] * r2[2], r1[0] * r2[1] - r1[1] * r2[0]];
  // Camera centre in plane coordinates: C = -R^T t, with R = [r1 r2 r3] as columns.
  const C = [-(r1[0] * t[0] + r1[1] * t[1] + r1[2] * t[2]), -(r2[0] * t[0] + r2[1] * t[1] + r2[2] * t[2]), -(r3[0] * t[0] + r3[1] * t[1] + r3[2] * t[2])];
  // The optical axis (camera z) in plane coordinates is the third row of R
  // transposed: r3's components are its direction... the plane's normal is
  // (0,0,1); the axis is R^T [0 0 1] = (r1[2], r2[2], r3[2]).
  const axis = [r1[2], r2[2], r3[2]];
  const height = Math.abs(C[2]);
  const tiltDeg = Math.acos(Math.min(1, Math.abs(axis[2]))) * 180 / Math.PI;
  return {
    ok: true, height, tiltDeg, below: { x: C[0], y: C[1] }, camera: { x: C[0], y: C[1], z: C[2] },
    R: [r1, r2, r3], t, scaleSpread: Math.abs(n1 - n2) / ((n1 + n2) / 2), f,
    dotR12: dot(c1, c2) / (n1 * n2),
  };
}

// A plane at height t above the camera's reference plane appears magnified
// by this about the point below the camera.
export function parallaxFactor(height, t) {
  if (!(height > 0) || !(t > 0) || t >= height) return 1;
  return height / (height - t);
}

// Where a point P on the reference plane appears to be when seen at height
// t, in plane millimetres: raised about the point below the camera.
export function raisePoint(P, below, height, t) {
  const k = parallaxFactor(height, t);
  return { x: below.x + (P.x - below.x) * k, y: below.y + (P.y - below.y) * k };
}
// And the reverse: a reference-plane point's apparent position in a raster
// of the plane at height t.
export function lowerPoint(P, below, height, t) {
  const k = 1 / parallaxFactor(height, t);
  return { x: below.x + (P.x - below.x) * k, y: below.y + (P.y - below.y) * k };
}

// The camera height from a sheet raised by h that appears magnified by m.
export function heightFromRaised(m, h) {
  if (!(m > 1) || !(h > 0)) return null;
  return h * m / (m - 1);
}

// The focal length that puts the camera at a known height above the plane:
// the decomposition's height rises with f, so a bisection over f finds it.
// Returns { f, camera } or null.
export function focalFromHeight(H, height, pp, range = [0.3, 4]) {
  if (!H || !(height > 0) || !pp) return null;
  const diag = Math.hypot(pp.x * 2, pp.y * 2) || 1;
  const at = k => cameraFromHomography(H, k * diag, pp);
  let lo = range[0], hi = range[1];
  const clo = at(lo), chi = at(hi);
  if (!clo.ok || !chi.ok || !(clo.height < height && chi.height > height)) return null;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    const c = at(mid);
    if (!c.ok) return null;
    if (c.height < height) lo = mid; else hi = mid;
  }
  const k = (lo + hi) / 2;
  return { f: k * diag, camera: at(k) };
}

export const STAND_BACK = 'Parallax scales with thickness over camera height, so shooting from farther away with the 2x lens halves it.';

// The readout (criterion 26 and 27).
export function describeParallax(p) {
  if (!p || !p.camera) {
    return `Parallax uncorrected: ${p && p.reason ? p.reason : 'no focal length in the photo and no raised sheet'}. ${STAND_BACK}`;
  }
  const c = p.camera;
  const pct = ((p.factor - 1) * 100).toFixed(1);
  const cam = `camera ${c.height.toFixed(0)} mm above the ${p.plane || 'sheet'}, tilted ${c.tiltDeg.toFixed(1)}°` +
    (c.source === 'sheet' ? ', from the raised sheet' : c.source === 'exif' ? ', from the photo\'s focal length' : '') +
    (c.exifDisagrees ? `; the photo's focal length puts it at ${c.exifHeight.toFixed(0)} mm, ${c.exifDisagrees.toFixed(0)} percent off, and is not used` : '');
  if (!(p.t > 0)) return `Parallax: none at zero thickness (${cam}).`;
  return `Parallax: ${pct} percent at ${p.t} mm, ${p.corrected ? 'corrected' : 'not yet corrected'} (${cam}).`;
}
