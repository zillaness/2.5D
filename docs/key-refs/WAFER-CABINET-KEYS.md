# Cabinet, office & toolbox keys — plan and data

Support for wafer / disc-tumbler keys: tool chests, tool benches, office
furniture, and cabinet locks. This is **Item A** of the cabinet-key effort
(build order: get the owner's five keys printable first, then the keyway
draw/import/lookup tool).

These are a different class from the residential pin-tumbler blanks already in
`js/keys/blanks.js` (KW1, SC1, M1, BEST). Understanding the difference is the
whole plan.

## How they differ from residential keys

| | Residential (KW1, SC1…) | Cabinet / wafer (this doc) |
|---|---|---|
| Lock | pin tumbler | wafer / disc tumbler |
| Positions | 5–7 | usually 4–6 |
| Depths | 7–10 | 4–5 (often only 2–3 used) |
| Blade section | **paracentric** (must match the keyway) | ~flat; a flat blade enters most wafer locks |
| How you get the bitting | **measure the cuts** from a photo | usually **look up the stamped code** |
| Handedness | single-sided | often **double-sided / reversible** (mirror cuts both edges) |

Three consequences drive the implementation:

1. **Code-driven, not measurement-driven.** The reliable input is the code
   stamped on the lock face or key bow, because wafer cuts are shallow and few,
   so photo-measurement is best used to *verify*. (The owner chose "code-lookup
   first, photo verifies.")
2. **Double-bitted / reversible.** Many of these mill *both* edges (mirror
   image), so the key is non-handed. The current mesh only mills the top edge
   (`js/keys/keyMesh.js`), so it needs a double-bitted mode.
3. **Flat section is fine.** Per `WARDING-TO-GRAB.md`'s flat-key simplification,
   a flat blade slides past a wafer lock's wards. So these do **not** need a
   keygen paracentric cross-section — synthesize a flat rectangle from blade
   width/height/thickness. This decouples cabinet keys from the keygen source.

## Blind codes vs cut codes — the honest gap

A stamped number comes in two kinds:

- **Cut code (direct):** the digits *are* the cut depths. Rare on cabinet keys.
- **Blind code (catalog):** an arbitrary index (T05, 318, ES202, F36…) that a
  **manufacturer code book** converts to a bitting. This is the common case.

`wafer-cabinet-specs.json` (transcribed from the Thomas compendium already in
this repo) gives the **depth & space** for each series — but *not* the blind-code
→ bitting conversion, which is separate data and often restricted.

**So "code-lookup first" is served in two layers:**

1. **Depth & space** — in the repo now (`wafer-cabinet-specs.json`). Tells us the
   cut geometry once we know the bitting.
2. **Code → bitting** — for a key the owner physically has, the clean, legal,
   repo-friendly path is to **decode it once** (app photo or calipers), then
   commit the resulting bitting under its stamped code. That becomes our own
   small lookup table (`cabinet-codes.json`, to be added) for the owner's keys —
   no proprietary code book required, and it's authorized because they own the
   keys. If a legitimate code book is sourced later, series can be filled in
   wholesale.

## The five keys to support

Owner-confirmed identities (2026-07). Four single-sided; **F36 is
double-sided** — see the sidedness note below.

| Key | Goes to | Blank / system | Sided | Series for decode | Still needed |
|---|---|---|---|---|---|
| **T05** | Husky tool chest (Home Depot) | cut on **N54G** blank; T01–T50 series | single | single-sided wafer — toolbox family (`compx_y000` / `national_ss` nearest) | cut count + one reading |
| **318** | vertical cabinet | **Cyber Lock CC-CL** mechanical blank, office furniture; blind series CC0001–CC1000 / CL0001–CL1000 | single | single-sided wafer — office family (`national_ss` nearest) | cut count + one reading |
| **476** | vertical cabinet | same as 318 (Cyber Lock CC-CL) | single | as 318 | cut count + one reading |
| **F36** | Yukon tool bench (Harbor Freight) | HF import wafer; "F" series | **double** | double-sided wafer — spec still to source/measure | own depth&space; are the two edges identical? |
| **ES202** | overhead cabinet | **Y11** blank — brass, stamped "Y11 USA"; common furniture / cam-lock key | single | single-sided wafer — office family | cut count + one reading |

Owner-confirmed via photos (2026-07): T05 stamped on the Husky key; "Y11 USA"
stamped on the ES202 key (so ES202 = Y11). 476 not separately provided — same
Cyber Lock CC-CL style as 318.

Note: "Cyber Lock CC-CL" here is an ordinary **mechanical** cut key, not Videx's
electronic *CyberLock* system (same-sounding name, unrelated) — so it decodes
like any other wafer key.

### Sidedness — four single, one double

The four single-sided keys (T05, 318, 476, ES202-if-single) use the app's
existing single-edge decode + loft path as-is: Item A for them is just a
cabinet-wafer blank + flat section + simple bow.

**F36 is double-sided, so it does need double-bitting** — the mesh must mill
BOTH edges (`js/keys/keyMesh.js` currently mills only the top). Two sub-cases,
and the F36 photo decides which:

- **Reversible / symmetric** (the common toolbox case): both edges carry the
  *same* cuts mirrored, so the key works either way up. This is the easy case —
  decode one edge, mirror the milling function to the other. Small mesh change.
- **Independent double bitting**: the two edges differ, needing both edges
  traced and milled separately. Larger change (decode + mesh + UI).

So double-bitting is back on Item A's list, but scoped to F36 and most likely
the easy symmetric case. It does not block the other four.

### Double-sided keys have no back-edge datum (the F36 measurement problem)

The single-sided decode measures tooth height from the blade **BACK** — the one
straight, uncut edge — as its datum (`js/keys/blanks.js` "Datum: the blade
back"; `js/keys/decode.js` `profileFromEdges`, `h = |top − back|`). A
double-sided key has cuts on **both** long edges, so there is no straight back
edge and that datum does not exist. Decode must switch to a **width /
centreline** datum:

- Trace **both** cut edges of the rectified silhouette (same rectify + trace as
  today; the blade axis / shoulder still register normally).
- Read the uncut full width **W₀** at an uncut station (just past the shoulder).
- **Symmetric / reversible** (expected for F36): at each position measure the
  full edge-to-edge width `w(x)`; per-edge cut depth `d(x) = (W₀ − w(x)) / 2`.
  Snap `d(x)` to the spec's depth ladder exactly as today — only the datum
  changed (uncut edge instead of back edge). One reading covers both edges; the
  mesh mills both mirrored.
- **Independent** (only if the two edges differ): derive the centreline from the
  two edges' midpoints along the axis, decode each edge from its own uncut-edge
  line, and mill the two edges separately.

Pipeline impact: rectify, trace, axis, snapping and the spec ladder are all
reused; the new parts are a `doubleSided` datum mode in decode and both-edge
milling in `keyMesh.js`. F36's own depth & space still needs sourcing or direct
measurement — the committed wafer specs are all single-sided.

### What's needed to make each printable

- **One real reading per key** — because these are blind codes, decode each key
  once (run it through the app's photo flow, or read the cuts with calipers, or
  state the cuts if known). That reading becomes the committed bitting, AND its
  cut count / spacing tells us which committed spec (or a new one) actually fits
  — so the blank is built against real geometry, not a guessed position count.
- **Start with one key** — build and prove the cabinet-blank path end-to-end on
  a single key (per the project handoff's "try the wizard on a real photo"
  priority), then replicate for the rest.
- **ES202** — identify the maker/blank before it can be mapped.

None of the owner's key photos or resulting STLs get committed (same rule as the
residential flow) — only the abstract bitting under its code.

## Build steps (Item A)

1. **Data** — `wafer-cabinet-specs.json` (done, this commit). Add
   `cabinet-codes.json` (code → bitting) as keys are decoded.
2. **Model** (`blanks.js`) — cabinet blank entries drawing on the JSON: small
   `positions`, `doubleBitted` flag, flat synthesized section, code-series hook.
3. **Section** (`warding.js`) — flat-rectangle synthesizer from width/height/
   thickness (no keygen polygon).
4. **Bow** (`bows.js`) — a parametric round/D toolbox bow with a keyring hole.
5. **Mesh** (`keyMesh.js`) — double-bitted lofting (mirror the milled edge).
6. **UI** (`keyUI.js`) — "enter stamped code" entry alongside the photo flow;
   photo verifies.
7. **Tests** — decode + keymesh + keycheck coverage, matching the existing suite.

## Source note

The two `framon-*.pdf` files in this folder are the Framon **code-machine
operation manuals**, not the depth-and-space data book (that's a separate volume,
F2MS350, not committed). The wafer depth & space used here comes from the Thomas
compendium's section 7 (`KeyBittingSpecifications-TylerJThomas.pdf`, printed
pp. 90–100), the same source as the residential specs.
