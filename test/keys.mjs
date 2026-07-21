// Unit test for the key blank library + bitting decoder.
//
// Round-trips known bitting codes through a synthetic blade-edge profile:
//   code → encodeToProfile → decodeBitting → assert the same code comes back.
// Also checks the library numbers against the authoritative charts in
// docs/key-refs/, that depth snapping absorbs sub-half-step measurement noise,
// and that MACS violations are flagged.
//
// Pure Node — no browser needed:  node test/keys.mjs

import {
  getBlank, cutCentre, rootDepthForCode, codeForRootDepth, removalForCode,
  codeRange, verifiedBlanks, wardingFor,
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
    // Perturb only where there's actually a cut (below the uncut top edge).
    height: s.height < spec.bladeHeight - 1e-6
      ? s.height + amp * Math.sin(i * 12.9898)
      : s.height,
  }));
}

console.log('Blank library — verified against docs/key-refs/ charts');
{
  const sc1 = getBlank('SC1'), kw1 = getBlank('KW1'), sc4 = getBlank('SC4'), m1 = getBlank('M1');
  check('KW1/SC1/M1/SC4 all present and verified',
    [sc1, kw1, sc4, m1].every(b => b && b.verified));
  check('verifiedBlanks() returns all five (incl. BEST-A)', verifiedBlanks().length === 5,
    verifiedBlanks().map(b => b.id).join(','));

  // Schlage Classic (Thomas 2025, p.76)
  check('SC1 TFC 0.231", BCC 0.156", step 0.015", MACS 7, angle 100°',
    near(sc1.spec.firstCut, 0.231, 1e-9) && near(sc1.spec.spacing, 0.156, 1e-9) &&
    near(sc1.spec.depthStep, 0.015, 1e-9) && sc1.spec.macs === 7 && sc1.spec.cutAngle === 100);
  check('SC1 depths 0–9, root depths .335→.200',
    eq(codeRange(sc1.spec), [0, 9]) &&
    near(rootDepthForCode(sc1.spec, 0), 0.335, 1e-9) &&
    near(rootDepthForCode(sc1.spec, 9), 0.200, 1e-9));
  check('SC4 shares the spec at 6 positions', sc4.spec.positions === 6);

  // Kwikset .023" (Thomas 2025, p.57)
  check('KW1 TFC 0.247", BCC 0.150", step 0.023", MACS 4, flat 0.084"',
    near(kw1.spec.firstCut, 0.247, 1e-9) && near(kw1.spec.spacing, 0.150, 1e-9) &&
    near(kw1.spec.depthStep, 0.023, 1e-9) && kw1.spec.macs === 4 &&
    near(kw1.spec.cutFlat, 0.084, 1e-9));
  check('KW1 depths 1–7, root depths .329→.191',
    eq(codeRange(kw1.spec), [1, 7]) &&
    near(rootDepthForCode(kw1.spec, 1), 0.329, 1e-9) &&
    near(rootDepthForCode(kw1.spec, 7), 0.191, 1e-9));

  // Master Lock M1 = 1K blank (Master 7000-0031 p.25 + Thomas p.63)
  check('M1 4 positions, TFC 0.187", BCC 0.125", step 0.0155", MACS 5',
    m1.spec.positions === 4 && near(m1.spec.firstCut, 0.187, 1e-9) &&
    near(m1.spec.spacing, 0.125, 1e-9) && near(m1.spec.depthStep, 0.0155, 1e-9) &&
    m1.spec.macs === 5);
  check('M1 depths 0–7, root depths .2720→.1635',
    eq(codeRange(m1.spec), [0, 7]) &&
    near(rootDepthForCode(m1.spec, 0), 0.2720, 1e-9) &&
    near(rootDepthForCode(m1.spec, 7), 0.1635, 1e-9));

  // Geometry cross-checks.
  check('SC1 position 3 centre = 0.231 + 2·0.156',
    near(cutCentre(sc1.spec, 2), 0.231 + 2 * 0.156, 1e-9));
  check('SC1 removal(9) = bladeHeight − rootDepth(9) = 0.135"',
    near(removalForCode(sc1.spec, 9), 0.335 - 0.200, 1e-9));

  // Warded cross-sections (from ervanalb/keygen, CC0) resolve for each blank.
  const wc = wardingFor(sc1);
  check('SC1 default warding is the C section (~1.91mm thick, ~8.7mm tall)',
    sc1.warding === 'schlage:c' && wc && wc.profile.length >= 3 &&
    near(wc.thickness, 1.91, 0.02) && near(wc.height, 8.71, 0.02));
  check('SC1 exposes the full C-family as warding options',
    sc1.wardingOptions.length === 11 && sc1.wardingOptions.includes('schlage:e'));
  check('SC1 can switch to the E section', wardingFor(sc1, 'schlage:e') != null);
  check('KW1 warding kw1 (~2.0mm), M1 warding k1 (~7.14mm tall = .281")',
    near(wardingFor(kw1).thickness, 2.0, 0.02) &&
    near(wardingFor(m1).height, 7.14, 0.03));

  // BEST A2 SFIC (Thomas 2025, p.41) — 7-pin, A keyway.
  const best = getBlank('BEST-A');
  check('BEST-A 7 positions, TFC .088", BCC .150", step .0125", MACS 9',
    best.spec.positions === 7 && near(best.spec.firstCut, 0.088, 1e-9) &&
    near(best.spec.spacing, 0.150, 1e-9) && near(best.spec.depthStep, 0.0125, 1e-9) &&
    best.spec.macs === 9);
  check('BEST-A depths 0–9, root depths .318→.2055',
    eq(codeRange(best.spec), [0, 9]) &&
    near(rootDepthForCode(best.spec, 0), 0.318, 1e-9) &&
    near(rootDepthForCode(best.spec, 9), 0.2055, 1e-9));
  check('BEST-A default warding is the A section (~2.235mm × ~8.382mm)',
    best.warding === 'best:a' && near(wardingFor(best).thickness, 2.235, 0.02) &&
    near(wardingFor(best).height, 8.382, 0.02));
}

console.log('\nClean round-trip: code → profile → decode');
const CASES = [
  { id: 'KW1', code: [1, 3, 5, 4, 2] },   // diffs 2,2,1,2            ≤ MACS 4
  { id: 'SC1', code: [1, 0, 3, 4, 5] },   // diffs 1,3,1,1            ≤ MACS 7
  { id: 'M1',  code: [0, 3, 5, 2] },      // diffs 3,2,3             ≤ MACS 5
  { id: 'SC4', code: [3, 2, 5, 4, 1, 6] },// diffs 1,3,1,3,5          ≤ MACS 7
  { id: 'BEST-A', code: [2, 5, 3, 6, 3, 2, 6] }, // 7-pin; diffs ≤6   ≤ MACS 9
];
for (const { id, code } of CASES) {
  const { spec } = getBlank(id);
  const dec = decodeBitting(spec, encodeToProfile(spec, code));
  check(`${id} ${code.join('-')} decodes back exactly`, eq(dec.code, code),
    `got ${dec.code.join('-')}`);
  check(`${id} ${code.join('-')} passes MACS`, dec.macs.ok);
}

console.log('\nSnapping absorbs sub-half-step noise');
for (const { id, code } of CASES) {
  const { spec } = getBlank(id);
  const amp = spec.depthStep * 0.45; // just under half a depth step
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
  check('SC1 4-5-6-5-4 passes MACS', checkMACS(spec, [4, 5, 6, 5, 4]).ok);
  // Kwikset's tighter MACS 4 rejects a jump the Schlage MACS 7 would allow.
  check('KW1 MACS 4 flags a 5-step adjacent jump',
    !checkMACS(getBlank('KW1').spec, [1, 6, 3, 4, 2]).ok);
}

console.log('\nDepth snapping + range');
{
  const { spec } = getBlank('SC1');
  const target = rootDepthForCode(spec, 5);
  check('exact root depth snaps to its code', codeForRootDepth(spec, target) === 5);
  check('root depth +0.4·step snaps to same code',
    codeForRootDepth(spec, target + 0.4 * spec.depthStep) === 5);
  check('root depth -0.4·step snaps to same code',
    codeForRootDepth(spec, target - 0.4 * spec.depthStep) === 5);
  check('cut deeper than the deepest clamps to code 9',
    codeForRootDepth(spec, 0.0) === 9);
  check('codeInRange rejects an out-of-range digit',
    codeInRange(spec, [0, 5, 9]) === true && codeInRange(spec, [0, 5, 10]) === false);
}

console.log(failures === 0 ? '\nAll key checks passed ✔' : `\n${failures} check(s) FAILED ✘`);
process.exit(failures === 0 ? 0 : 1);
