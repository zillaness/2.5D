# key-from-photo — decisions & state

Running log of decisions for the spare-key tool (fork of 2.5D). Parent spec:
[`spec-key-from-photo.md`](./spec-key-from-photo.md).

## Name

**MockRock** (front-runner) — rhymes, means "fake rock", nods to the hide-a-spare
trope. Alternates: SpareKey, DupliKey. Not final; used informally until locked.

## Product decisions

- **Flat key, not warded.** v1 generates a *flat* key (a flat plate blade of the
  correct width/height/thickness + bow), the way printable-key models work. Prints
  with a clean flat face down; KW1/SC1 keyways are open enough for a correct-width
  flat blade. True warded side-grooves are out of scope (hard to print, marginal
  benefit).
- **Blank chosen from a library (picker), not auto-detected,** for v1.
- **Bow:** generic printable, code-embossable/labelable bow; standard shapes OK.
- **Bitting datum:** manufacturer **root depth** (height above the blade back). The
  blade back is never cut away → robust photo reference. Snap measured depth to the
  nearest standard code; enforce MACS.

## Data state

- **Depth-and-spacing: verified** for KW1, SC1, M1, SC4 against the charts in
  `key-refs/` (Thomas 2025 + Master 7000-0031). See `js/keys/blanks.js`.
- **Flat geometry:** KW1 flat outline + bow extracted from `KWIKSET-MODULAR-v2.step`
  → `key-refs/derived/KW1-flat-outline.json` (thickness 2.0 mm; raw, arcs need a
  cleanup pass at mesh time). Need equivalent flat models/cross-sections for SC1,
  M1 (see `key-refs/WARDING-TO-GRAB.md`).

## Ingest formats

SVG (easiest for flat outlines; needs a scale), STEP, STL, or a scaled
PDF/photo cross-section all work.

## Built so far

- `js/keys/blanks.js` — verified blank/keyway library + helpers.
- `js/keys/bitting.js` — edge→snapped code + MACS (+ inverse encode).
- `test/keys.mjs` — 32 checks (`npm run test:keys`), all passing.

## Next

- Clean up the KW1 flat outline (polygonise bow arcs properly), separate
  blade-blank vs bow, establish shoulder datum in the profile.
- Build `js/keys/keyMesh.js`: extrude the flat blade + bow, carve the decoded
  V-cuts along the top edge, emboss the code on the bow, export STL.
- Collect Tier-1 flat models / cross-sections (SC1, M1, WR5, Y1).
