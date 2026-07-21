// Unit test for the app-side decode module (js/keys/decode.js).
// Builds a synthetic blade height profile (mm) for a known code, decodes it,
// and checks manual overrides, depth snapping, ambiguity flagging, and the
// edge-projection path (arbitrary axis).  node test/decode.mjs

import { getBlank } from '../js/keys/blanks.js';
import {
  decode, snapDepthMm, rootDepthMm, cutCentreMm, spacingMm,
  profileFromEdges, axisFrom,
} from '../js/keys/decode.js';

let failures = 0;
const check = (name, ok, d = '') => {
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${d ? ' — ' + d : ''}`);
  if (!ok) failures++;
};
const eq = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
const near = (a, b, t) => Math.abs(a - b) <= t;

// Synthetic h(u) profile (mm) for a code: V-cuts to each root depth, else uncut.
function synth(blank, code, step = 0.2) {
  const s = blank.spec, IN = 25.4;
  const uncut = s.bladeHeight * IN;
  const run = Math.tan((s.cutAngle * Math.PI / 180) / 2);
  const flatHalf = s.cutFlat * IN / 2;
  const end = cutCentreMm(s, s.positions - 1) + 5;
  const prof = [];
  for (let u = 0; u <= end; u += step) {
    let h = uncut;
    for (let i = 0; i < s.positions; i++) {
      const root = rootDepthMm(s, code[i]);
      const dx = Math.abs(u - cutCentreMm(s, i));
      const edge = dx <= flatHalf ? root : root + (dx - flatHalf) / run;
      if (edge < h) h = edge;
    }
    prof.push({ u, h });
  }
  return prof;
}

console.log('Synthetic round-trip (profile → decode)');
const CASES = [
  { id: 'SC1', code: [4, 2, 1, 4, 5] },
  { id: 'KW1', code: [1, 3, 5, 4, 2] },
  { id: 'M1', code: [0, 3, 5, 2] },
  { id: 'BEST-A', code: [2, 5, 3, 6, 3, 2, 6] },
];
for (const { id, code } of CASES) {
  const blank = getBlank(id);
  const res = decode(blank.spec, synth(blank, code));
  check(`${id} ${code.join('-')} decodes exactly`, eq(res.code, code), `got ${res.code.join('-')}`);
  check(`${id} clean read flags no ambiguity`, res.ambiguous.length === 0);
}

console.log('\nManual overrides (the depth handle)');
{
  const blank = getBlank('SC1');
  const res = decode(blank.spec, synth(blank, [4, 2, 1, 4, 5]), { overrides: { 2: 5 } });
  check('override sets pos3 to 5, marks it overridden',
    res.code[2] === 5 && res.cuts[2].overridden && !res.cuts[0].overridden,
    res.code.join('-'));
}

console.log('\nShoulder-datum handle');
{
  const blank = getBlank('SC1');
  // Build the profile shifted 3mm downstream, then correct with shoulderU.
  const p = synth(blank, [4, 2, 1, 4, 5]).map(s => ({ u: s.u + 3, h: s.h }));
  const bad = decode(blank.spec, p);
  const good = decode(blank.spec, p, { shoulderU: 3 });
  check('wrong datum misreads; shoulderU handle fixes it',
    !eq(bad.code, [4, 2, 1, 4, 5]) && eq(good.code, [4, 2, 1, 4, 5]),
    `bad ${bad.code.join('-')} → good ${good.code.join('-')}`);
}

console.log('\nDepth snapping + ambiguity');
{
  const spec = getBlank('SC1').spec;
  check('exact root depth snaps clean', snapDepthMm(spec, rootDepthMm(spec, 5)).code === 5
    && snapDepthMm(spec, rootDepthMm(spec, 5)).residual < 1e-9);
  // A depth exactly between code 1 and 2 must be flagged ambiguous (the SC1 case).
  const between = (rootDepthMm(spec, 1) + rootDepthMm(spec, 2)) / 2;
  const prof = synth(getBlank('SC1'), [4, 2, 1, 4, 5]).map((s, i) => i === 0 ? s : s);
  // craft a flat profile whose pos1 sits at the boundary
  const flat = [];
  for (let u = 0; u <= cutCentreMm(spec, 4) + 5; u += 0.2) {
    let h = spec.bladeHeight * 25.4;
    const dx = Math.abs(u - cutCentreMm(spec, 0));
    if (dx < spacingMm(spec) * 0.3) h = between;
    flat.push({ u, h });
  }
  const r = decode(spec, flat);
  check('a between-levels cut is flagged ambiguous', r.ambiguous.includes(0), `ambiguous ${r.ambiguous}`);
}

console.log('\nEdge projection (arbitrary axis → profile → decode)');
{
  const blank = getBlank('SC1'); const code = [4, 2, 1, 4, 5];
  const p = synth(blank, code, 0.2);
  // place edges in a rotated/translated frame: axis at 20°, origin (10,-5)
  const th = 20 * Math.PI / 180, c = Math.cos(th), sn = Math.sin(th);
  const o = { x: 10, y: -5 };
  const map = (u, v) => ({ x: o.x + u * c - v * sn, y: o.y + u * sn + v * c });
  const backEdge = p.map(s => map(s.u, 0));           // blade back at v=0
  const topEdge = p.map(s => map(s.u, s.h));          // cut edge at v=h
  const axis = axisFrom(o, map(p[p.length - 1].u, 0), map(0, 5)); // back point above
  const prof = profileFromEdges(topEdge, backEdge, axis, 0.25);
  const res = decode(blank.spec, prof);
  check('rotated/translated edges project + decode correctly', eq(res.code, code), `got ${res.code.join('-')}`);
}

console.log(failures === 0 ? '\nAll decode checks passed ✔' : `\n${failures} FAILED ✘`);
process.exit(failures === 0 ? 0 : 1);
