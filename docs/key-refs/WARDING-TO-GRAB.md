# Warding / keyway reference to collect — "have and not need"

A prioritized list of common US residential keyways to eventually collect profiles
for. **For the flat-key path we don't cut side grooves**, so what actually matters
per keyway is the **max blade width + height + thickness that fits the keyway**
(plus the bow). A keyway **cross-section** (blade end-on) gives exactly that, and a
flat "key-maker" model gives the blade outline + bow. Either is worth having.

## Formats I can ingest (all fine)

- **SVG** — easiest for a flat outline or a keyway cross-section. The repo's
  `js/import/svgImport.js` flattens paths → polylines and reads a mm scale from
  width/height vs viewBox. **Include a real-world dimension or scale bar** so it
  lands at true size (SVG px are otherwise arbitrary).
- **STEP** — works; I parse solids/faces directly (see `derived/step_lib.py`).
- **STL** — works (triangle soup; I recover the outline).
- **PDF / photo of a cross-section** — works, with a scale reference in frame.

## Priority list

Tier 1 — covers the large majority of US homes/padlocks:

| Keyway | Brand | Notes | Status |
|---|---|---|---|
| **KW1** | Kwikset | 5-pin; newer Weiser + many big-box locks share it | ✅ flat model in hand (`KWIKSET-MODULAR-v2.step`) |
| **SC1** | Schlage | 5-pin, the other dominant residential keyway | need flat model / cross-section |
| **WR5** | Weiser | 5-pin (older Weiser); newer Weiser = KW1 | need |
| **Y1** | Yale | 5-pin | need |
| **M1** | Master Lock | 4-pin padlocks (the 1K/1092 blank) | need flat model / cross-section |

Tier 2 — common enough to be worth having:

| Keyway | Brand | Notes |
|---|---|---|
| **SC4** | Schlage | 6-pin (same keyway as SC1, longer) |
| **KW10** | Kwikset | 6-pin |
| **S1** | Sargent | LA keyway |
| **AR1** | Arrow | (this is the "A1" to confirm — Arrow AR1 vs American padlock) |
| **Y2 / Y11** | Yale | Yale variants |
| **DE6** | Dexter | big-box residential |

## Explicitly OUT (do not collect)

Restricted / patented / high-security / "Do Not Duplicate": Schlage Everest &
Primus, Medeco, Abloy, Mul-T-Lock, ASSA, BEST proprietary, Corbin-Russwin
high-security. Legally controlled — out of scope for this tool.

## Ideal single grab per keyway

If you want one thing per keyway: a **flat "key maker" model** (like the KW1 one)
from the same MakerWorld author, **or** a labeled **keyway cross-section** (Lishi
decoder card, Ilco/JMA blank cutaway) exported/traced as **SVG with a scale**.
