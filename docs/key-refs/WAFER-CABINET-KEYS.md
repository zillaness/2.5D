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

Best-guess series mapping — **each needs confirmation from the physical key**
(the stamped code alone is ambiguous, and the same number means different cuts
across makers):

| Key | Goes to | Likely series | Confirm by |
|---|---|---|---|
| **T05** | Husky tool chest | toolbox wafer — CompX/National family (`compx_y000` / `national_ss`) | maker stamped on lock; is the key double-sided? |
| **ES202** | overhead cabinet | ESP-style cabinet cam lock — series TBD (ES prefix) | maker on lock face; photo of key |
| **318** | vertical cabinet | office-furniture wafer — `national_ss` or `illinois_ss` | **lock brand** (National/CompX? HON? Hudson?) |
| **476** | vertical cabinet | office-furniture wafer — as 318 | **lock brand** |
| **F36** | Yukon (Harbor Freight) tool bench | HF import wafer — generic; map to nearest series | photo of key + lock |

### What's needed to make each printable

- **Lock brand for 318 and 476** — a numeric code is meaningless without it.
  The maker is usually stamped on the lock face; a photo resolves it.
- **One reading per key** — because these are blind codes, decode each key once
  (run it through the app's photo flow, or read the cuts with calipers, or just
  state the cuts if known). That reading becomes the committed bitting.
- **Single- vs double-sided** — note whether each key has cuts on one edge or
  mirrored on both; that selects the mesh's double-bitted mode.

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
