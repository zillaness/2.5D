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
  `index.html` = Funny Looking Rock, `2.5d.html` = the 2.5D photo tool. Rebuild
  (`node build.mjs`) then copy `dist/funny-looking-rock.html` → `gh-pages`
  `index.html` to update. (Enable once in repo Settings → Pages → Deploy from a
  branch → `gh-pages` / root.)

## TODO — attribution / support links

Add footer links to **Projects and Mods** in three places: (1) on the app pages
themselves — both Funny Looking Rock and 2.5D — as a small footer, and (2) in the
repo README. Links:

- **YouTube** — Projects and Mods channel
- **Ko-fi** — support/tip link
- **Claude Code referral** — referral link (built with Claude Code)

(Exact URLs TBD — waiting on the channel / Ko-fi / referral URLs.)

## Next

- Clean up the KW1 flat outline (polygonise bow arcs properly), separate
  blade-blank vs bow, establish shoulder datum in the profile.
- Build `js/keys/keyMesh.js`: extrude the flat blade + bow, carve the decoded
  V-cuts along the top edge, emboss the code on the bow, export STL.
- Collect Tier-1 flat models / cross-sections (SC1, M1, WR5, Y1).
