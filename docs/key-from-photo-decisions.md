# key-from-photo — decisions & state

Running log of decisions for the spare-key tool (fork of 2.5D). Parent spec:
[`spec-key-from-photo.md`](./spec-key-from-photo.md).

## Name

**Funny Looking Rock** — the hide-a-spare-in-a-fake-rock joke name, now the pick.
(Earlier alts: MockRock, SpareKey, DupliKey.)

## Product decisions

- **Warded, not flat (revised).** Schlage C and BEST A are **paracentric** — a
  flat blade won't reliably enter — so v1 extrudes the real warded cross-section
  (from keygen). Flat blades only work for open keyways like Kwikset; we default
  to the true section for correctness. Print orientation handled at mesh time.
- **Size reference: CR80 card** (credit/gift/ID card, ISO-7810 ID-1 =
  85.60 × 53.98 mm). Rigid, precise, rectangular → its 4 corners give a full
  homography that removes perspective skew/warp and sets true scale. Already
  supported by 2.5D's card calibration; NB cards have ~3.18 mm rounded corners,
  so derive each corner from the straight-edge intersection, not the rounded pixel.
- **Blank chosen from a library (picker), not auto-detected,** for v1.
- **Blank chosen from a library (picker), not auto-detected,** for v1.
- **Bow:** generic printable, code-embossable/labelable bow; standard shapes OK.
- **Bitting datum:** manufacturer **root depth** (height above the blade back). The
  blade back is never cut away → robust photo reference. Snap measured depth to the
  nearest standard code; enforce MACS.

## Data state

- **Depth-and-spacing: verified** for KW1, SC1, M1, SC4, **BEST A2 (7-pin)**
  against the charts in `key-refs/` (Thomas 2025 + Master 7000-0031). BEST A2:
  7 cuts, TFC .088", BCC .150", 10 depths .318→.2055 step .0125", MACS 9. See
  `js/keys/blanks.js`.
- **Warding cross-sections: sourced** from ervanalb/keygen (CC0) →
  `js/keys/warding.js` (Schlage C-family, Kwikset KW1, Master K1) + full raw
  dump `key-refs/derived/warding-profiles.json`. Each blank references a default
  `warding` + `wardingOptions`; `wardingFor(blank)` resolves the polygon.
- **First test target: SC1.** Schlage C is **paracentric** → a flat blade won't
  reliably enter, so SC1 uses the real C cross-section (not a flat blade). The
  earlier flat-key note still holds for open keyways (Kwikset), but Schlage needs
  its section. KW1 flat outline from the STEP is kept as reference.

## Ingest formats

SVG (easiest for flat outlines; needs a scale), STEP, STL, or a scaled
PDF/photo cross-section all work.

## Built so far

- `js/keys/blanks.js` — verified blank/keyway library + helpers.
- `js/keys/bitting.js` — edge→snapped code + MACS (+ inverse encode).
- `test/keys.mjs` — 32 checks (`npm run test:keys`), all passing.

## Key generation — interim path (works today)

Until `js/keys/keyMesh.js` exists, keys are rendered with **ervanalb/keygen +
OpenSCAD** (both installed/cloned in the dev env). This validated the whole data
chain end-to-end: our verified depth-and-spacing + the C warding produce a real
watertight key.

```
git clone https://github.com/ervanalb/keygen.git      # CC0
apt-get install -y --no-install-recommends openscad
cd keygen
SCAD=openscad python3 bin/keygen.py scad/schlage_classic.scad \
    -b <BITTING> -w C -o out.stl        # bitting bow-to-tip, 0–9
```

First test key: **SC1, bitting 1-2-3-4-5, C warding** → 1.91mm thick, 52.4mm long,
watertight (simple: yes) — saved at `docs/key-refs/derived/SC1_sample_12345.stl`.
This is a PIPELINE PROOF with a sample code; a working key needs the real bitting
(from the user's key, via the photo decode or a known code).

`keyMesh.js` will reimplement this natively in the browser app (extrude the
warded section, carve bitting, add bow) so no OpenSCAD/keygen dependency ships.

## Mesh assembly — CSG union (Manifold)

The bow↔blade connection is assembled with a real CSG **boolean union** (the
Manifold engine, WASM, bundled into the single file), the same technique keygen
uses via OpenSCAD — instead of the earlier hand-weld. Build the blade and bow as
two overlapping closed solids and `union` them; Manifold produces one clean
manifold. This is why the connection is robust.

## Conventions vs keygen

- **Bitting order is reversed.** We index the code **bow→tip** (position 1 nearest
  the bow/shoulder). keygen takes bitting **tip→bow**. So to feed one of our codes
  into keygen (or check against it), reverse the digits.
- **Warding handedness is mirrored** relative to keygen's raw 2D polygon (we flip
  the thickness axis so the printed blade matches a real key — a paracentric
  keyway is handed).

## Future direction — desktop version

A desktop build (Tauri or Electron wrapping this same web UI) could shell out to
**real keygen (OpenSCAD + Python)** for generation — either bundling OpenSCAD in
the installer (offline, big, per-OS builds) or detecting an installed OpenSCAD
(small app, setup step). Reuses all the photo→decode UI. Kept as a future
version; the browser app gets keygen-quality connections today via Manifold CSG,
so this is only needed to unlock keygen-exclusive features later.

## Deployment

- **GitHub Pages** serves the bundled apps from the `gh-pages` branch (root):
  - `/FunnyLookingRock/` → Funny Looking Rock (the branded URL)
  - `/` (root `index.html`) → Funny Looking Rock (mirror)
  - `/2.5d.html` → the 2.5D photo tool
  Rebuild (`node build.mjs`) then copy `dist/funny-looking-rock.html` onto both
  `gh-pages` `index.html` and `FunnyLookingRock/index.html` to update. (Enable
  once in repo Settings → Pages → Deploy from a branch → `gh-pages` / root.)
  Live path: `https://zillaness.github.io/2.5D/FunnyLookingRock/`.
- **TODO — dedicated repo later:** give Funny Looking Rock its own
  `zillaness/FunnyLookingRock` repo so the URL is `.../FunnyLookingRock/` at the
  top level (no `/2.5D/` prefix). Needs a copy/deploy step from this source repo.

## TODO — attribution / support links

Add footer links to **Projects and Mods** in three places: (1) on the app pages
themselves — both Funny Looking Rock and 2.5D — as a small footer, and (2) in the
repo README. Links:

- **YouTube** — Projects and Mods channel
- **Ko-fi** — support/tip link
- **Claude Code referral** — referral link (built with Claude Code)

(Exact URLs TBD — waiting on the channel / Ko-fi / referral URLs.)

## Key shape / mesh quality (partly DONE)

Making the generated key read more "real" (js/keys/keyMesh.js):

- **DONE — parametric paddle bow with a waisted neck.** `paddleBowOutline()`
  replaces the old sharp vertical flare with concave fillet arcs blending the slim
  neck into the head, and uses 6° arc segments (was 12°). Shared by the welded and
  CSG paths so they can't diverge.
- **DONE — BEST gets its own bow.** `blank.bow = 'best'` selects a fuller
  SFIC-style head (`GENERIC_BOWS.best`) instead of the bare generic paddle.
- **DONE — rounded tip nose.** The tip bevel now follows a circular ease
  (`sqrt(1-(1-t)²)`) so it reads like a factory nose, not a straight chamfer —
  still a single monotonic top span, so the cap stays watertight.
- Validated watertight on every blank in both the native weld and Manifold CSG
  paths (boundary/non-manifold edges = 0).
- **DONE — real BEST bow** (v4.1): BOW_CFG.best de-skews keygen's flipped
  tip-datum frame; all four bows are now real keygen polygons.
- **DONE — keygen-accurate tips, shoulder fillet, real holes** (v4.2, built by an
  adversarial workflow, verified per-manufacturer against keygen):
  - **Tips:** `TIP_SPECS` per keyway (apexFrac + top/back ramp) → the CSG path
    builds a flat-topped blade (`flatTip`) and carves the rounded ASYMMETRIC nose
    by subtracting two chamfer wedges (top falls, back rises to the apex). Apex
    fractions: Schlage .35, Kwikset .37, Master .50, BEST .50 (symmetric noses on
    Master/BEST, swept on Schlage/Kwikset). Within ±0.015 of keygen.
  - **Shoulder:** `FILLET_SPECS` + `shoulderFillet()` (true circular arc, minor-arc
    normalized, straight-chamfer fallback when 2R≤step) shapes the CSG bow-neck
    overlap so it sweeps into the blade edge(s) instead of a hard step.
  - **Holes:** `getBowHoles()` from bows.js — CSG uses `CrossSection([outline,
    ...holes],'EvenOdd')`; the weld path does a multi-hole earcut cap. Kwikset's
    three holes, one for the others.
  - Checker: `tools/keycheck.mjs` (Node CSG, no browser) gates watertightness +
    tip/neck geometry. Watertight on every blank × code, weld + CSG.
  - **Known limitation:** the tip nose + shoulder fillet live in the CSG path only
    (the production path — the dist inlines the Manifold wasm, so CSG always
    loads). The synchronous weld FALLBACK (`buildKeyMesh`, used only if CSG fails
    to load) keeps a simpler top-bevel tip and a hard shoulder, though it does
    carry the real holes and stays watertight. Upgrading the weld path to match is
    low-value (rarely hit) and deferred.
  - **Minor:** Master's CSG nose runs ~0.73 mm longer than keygen's (tip reserve);
    cosmetic, deferred.

## Read-direction safety

Bitting is directional, and the convention is **per-keyway, not per-tool.**
**This app numbers bow→tip** (position 1 nearest the bow). **keygen numbers
Schlage bow→tip too** — so Schlage codes transfer between us and keygen directly,
no reversal. **BEST/SFIC is the lone exception:** it's specified **tip→bow**, so
only BEST codes need reversing when moving to/from keygen or a BEST spec sheet. A
backwards green back-edge line reverses the whole reading and yields a wrong key
that still looks plausible, so:

- `reprofile()` auto-orients `state.back` using image evidence — it samples just
  past each blade end and puts `back[0]` (position 1) at the **bow** end (the big
  paddle leaves key material past the blade; the tip drops into background).
- The green line draws a **"tip →" arrow**; a **Flip bow↔tip** button is the
  manual override.
- The bitting field **warns** that direction is per-keyway: Schlage transfers
  directly to keygen; only BEST codes must be reversed.

## Shape-based bow auto-detection (DONE — classical CV, in scope)

`detectBow()` (js/keys/keyUI.js) finds the bow directly from the silhouette so
orientation sets itself, on a downsampled (~360px) pixel mask. All classical CV
on the canvas `ImageData`, no ML, no network — stays in the standalone file:

- **Primary — keyring-hole detection.** Flood-fill the background inward from the
  image border; any enclosed non-key region the fill can't reach is the ring
  hole, which only the bow has → that end is unambiguously the bow. Largest
  enclosed region wins, gated by a min-area test so specks/glare gaps don't fire.
- **Fallback — PCA width profile.** Principal axis from image moments (no user
  trace), walk it measuring perpendicular width; the wide blobby end is the bow.
- `reprofile()` orients `state.back` so `back[0]` is the end nearest the detected
  bow; the old "material past the blade end" scan is now just the last-resort
  fallback. The "tip →" arrow + Flip remain the manual override.
- Tests: `test/bowdetect_smoke.mjs` (hole + PCA cues), `test/orient_smoke.mjs`
  (end-to-end flip of a backwards axis).
- Not ML: neural-net recognition would mean inlining multi-MB weights or a cloud
  call (breaks offline/private) — unnecessary for a rigid shape with a hole in it.
- **Possible next:** extend to full auto-place (axis + bow end + back line) from
  `detectBow()` instead of `autoPlace()`'s coarser bbox pass.
