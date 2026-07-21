// Unit test for the key blank library + bitting decoder.
//
// Round-trips known bitting codes through a synthetic blade-edge profile:
//   code → encodeToProfile → decodeBitting → assert the same code comes back.
// Also checks depth snapping absorbs sub-half-step measurement noise, that MACS
// violations are flagged, and that a couple of spec numbers match the chart.
//
// Pure Node — no browser needed:  node test/keys.mjs

import {
  getBlank, cutCentre, removalForCode, codeForRemoval, codeRange,
  verifiedBlanks, BLANKS,
} from '../js/keys/blanks.js';
import {
  encodeToProfile, decodeBitting, checkMACS, codeInRange,
} from '../js/keys/bitting.js';

let failures = 0;
function check(name, ok, detail = '') {
  const mark = ok ? 'PASS' : 'FAIL';
  if (!ok) failures++;
  console.log(`  [${mark}] ${name}${detail ? ' — ' + detail : ''}`);
}
const eq = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
const near = (a, b, tol) => Math.abs(a - b) <= tol;

// Deterministic sub-half-step noise so the test is reproducible run to run.
function noisyProfile(spec, code, amp) {
  const p = encodeToProfile(spec, code);
  return p.map((s, i) => ({
    x: s.x,
    // Only perturb where there's actually a cut, and never push below 0.
    removal: s.removal > 1e-6 ? Math.max(0, s.removal + amp * Math.sin(i * 12.9898)) : s.removal,
  }));
}

console.log('Blank library sanity');
{
  const sc1 = getBlank('SC1'), kw1 = getBlank('KW1'), sc4 = getBlank('SC4');
  check('SC1/SC4/KW1 all present', !!(sc1 && kw1 && sc4));
  check('SC1 first cut 0.231", spacing 0.156"',
    near(sc1.spec.firstCut, 0.231, 1e-9) && near(sc1.spec.spacing, 0.156, 1e-9));
  check('SC1 has 10 depths (0–9), MACS 7',
    sc1.spec.depthCount === 10 && eq(codeRange(sc1.spec), [0, 9]) && sc1.spec.macs === 7);
  check('KW1 first cut 0.247", spacing 0.150", step 0.023"',
    near(kw1.spec.firstCut, 0.247, 1e-9) && near(kw1.spec.spacing, 0.150, 1e-9) &&
    near(kw1.spec.depthStep, 0.023, 1e-9));
  check('KW1 has 7 depths (1–7), MACS 4',
    kw1.spec.depthCount === 7 && eq(codeRange(kw1.spec), [1, 7]) && kw1.spec.macs === 4);
  check('SC4 is 6 positions', sc4.spec.positions === 6);
  // Master Lock M1 is present but provisional — confirmed fields only.
  const m1 = getBlank('M1');
  check('M1 present, 4 positions, 8 depths (0–7), step 0.0155"',
    !!m1 && m1.spec.positions === 4 && m1.spec.depthCount === 8 &&
    near(m1.spec.depthStep, 0.0155, 1e-9));
  check('M1 flagged provisional (verified === false)', m1.verified === false);
  check('SC1/SC4/KW1 flagged verified', sc1.verified && sc4.verified && kw1.verified);
  check('verifiedBlanks() excludes the provisional M1',
    verifiedBlanks().every(b => b.id !== 'M1') && verifiedBlanks().length === 3,
    verifiedBlanks().map(b => b.id).join(','));
  // A KW1 code-1 cut removes the published shallowest-cut amount.
  check('KW1 code 1 removes 0.008", code 7 removes 0.146"',
    near(removalForCode(kw1.spec, 1), 0.008, 1e-9) &&
    near(removalForCode(kw1.spec, 7), 0.008 + 6 * 0.023, 1e-9));
  // Position 3 centre = firstCut + 2*spacing.
  check('SC1 position 3 centre = 0.231 + 2·0.156',
    near(cutCentre(sc1.spec, 2), 0.231 + 2 * 0.156, 1e-9));
}

console.log('\nClean round-trip: code → profile → decode');
const CASES = [
  { id: 'SC1', code: [1, 0, 3, 4, 5] },   // adjacent diffs 1,3,1,1  ≤ MACS 7
  { id: 'SC4', code: [3, 2, 5, 4, 1, 6] },// diffs 1,3,1,3,5         ≤ 7
  { id: 'KW1', code: [1, 3, 5, 4, 2] },   // diffs 2,2,1,2           ≤ MACS 4
  // M1 exercises the 4-pin path. NB: a passing round-trip validates the
  // encode/decode pipeline, not M1's (provisional) absolute spec numbers.
  { id: 'M1', code: [0, 3, 5, 2] },       // diffs 3,2,3             ≤ 7
];
for (const { id, code } of CASES) {
  const { spec } = getBlank(id);
  const prof = encodeToProfile(spec, code);
  const dec = decodeBitting(spec, prof);
  check(`${id} ${code.join('-')} decodes back exactly`, eq(dec.code, code),
    `got ${dec.code.join('-')}`);
  check(`${id} ${code.join('-')} passes MACS`, dec.macs.ok);
}

console.log('\nSnapping absorbs sub-half-step noise');
for (const { id, code } of CASES) {
  const { spec } = getBlank(id);
  // Noise amplitude just under half a depth step — snapping must recover the code.
  const amp = spec.depthStep * 0.45;
  const dec = decodeBitting(spec, noisyProfile(spec, code, amp));
  check(`${id} ${code.join('-')} survives ±0.45·step noise`, eq(dec.code, code),
    `got ${dec.code.join('-')} (amp ${amp.toFixed(4)}")`);
}

console.log('\nMACS violation detection');
{
  const { spec } = getBlank('SC1');
  const bad = [0, 9, 0, 9, 0];             // adjacent diff 9 > MACS 7
  const m = checkMACS(spec, bad);
  check('SC1 0-9-0-9-0 flagged as MACS violation', !m.ok && m.violations.length === 4,
    `${m.violations.length} violations`);
  const good = [4, 5, 6, 5, 4];
  check('SC1 4-5-6-5-4 passes MACS', checkMACS(spec, good).ok);
}

console.log('\nDepth snapping + range');
{
  const { spec } = getBlank('SC1');
  const target = removalForCode(spec, 5);
  check('exact removal snaps to its code', codeForRemoval(spec, target) === 5);
  check('removal +0.4·step snaps to same code',
    codeForRemoval(spec, target + 0.4 * spec.depthStep) === 5);
  check('removal -0.4·step snaps to same code',
    codeForRemoval(spec, target - 0.4 * spec.depthStep) === 5);
  check('over-deep removal clamps to deepest code (9)',
    codeForRemoval(spec, 99) === 9);
  check('codeInRange rejects an out-of-range digit',
    codeInRange(spec, [0, 5, 9]) === true && codeInRange(spec, [0, 5, 10]) === false);
}

console.log(failures === 0 ? '\nAll key checks passed ✔' : `\n${failures} check(s) FAILED ✘`);
process.exit(failures === 0 ? 0 : 1);
