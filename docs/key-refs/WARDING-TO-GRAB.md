# Warding / keyway reference to collect — "have and not need"

"Warding" here = the **keyway section**: the side-groove profile of the blade.
Schlage is a *sectional / multiplex* system — one depth-and-spacing shared across
a whole family of sections, where **SC1/SC4 = the C section**.

### Schlage Classic multiplex sections

- **Primary sections:** C, E, F, G, H, J, K, L, M (D and I are skipped).
- **Paired multiplex sections:** CE, EF, FG, GH, HJ, JK, KL, LM — a paired blank
  is warded to enter **both** of its neighbouring sections (e.g. CE enters C and
  E). This nesting is the basis of Schlage's multiplex master keying, with the
  higher pairs acting as master sections over the ones below.
- All of them share the same depth-and-spacing (verified for C as SC1/SC4); only
  the blade grooves differ. Confirm exact cross-operation against a Schlage
  sectional keyway chart when sourcing real blanks.
- Restricted overlays (Everest C123, Primus, Everest 29) are out of scope.

Kwikset is effectively a single section (**KW1**, with **KW10** the 6-pin).
Master/Weiser/Yale each have one common section.

## The flat-key simplification (why section usually doesn't matter for us)

The wards in a lock's keyway are ribs that the **blank** must clear. A **flat**
blade has **no ribs**, so it slides past any section's wards as long as the blade
**width** fits the keyway's narrowest point. **So one flat blade per manufacturer
enters C, E, F… alike** — we do NOT need per-section warding for flat printing.
Section profiles only matter if we ever cut *real warded blanks* (the "have and
not need" case). What a flat key actually needs per keyway: **max blade width +
height + thickness + bow** — from a keyway **cross-section** (blade end-on) or a
flat "key-maker" model.

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

Warding for SC / KW / M is now **sourced from ervanalb/keygen (CC0)** →
`js/keys/warding.js`. keygen does NOT cover Yale / Weiser / Sargent / Arrow /
Dexter, so those remain to source.

| Keyway | Brand | Notes | Status |
|---|---|---|---|
| **KW1** | Kwikset | 5-pin; newer Weiser + many big-box locks share it | ✅ keygen `kwikset:kw1` (+ flat STEP on hand) |
| **SC1/SC4** | Schlage | dominant residential; C section (paracentric) | ✅ keygen C-family (`schlage:c`…`:l`) + STL |
| **M1** | Master Lock | 4-pin padlocks (1K/1092 blank) | ✅ keygen `master:k1` |
| **WR5** | Weiser | 5-pin (older Weiser); newer Weiser = KW1 | 🟠 need (not in keygen) |
| **Y1** | Yale | 5-pin | 🟠 need (not in keygen) |

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
