# Pull list — reference material status

The build proxy 403s the authoritative locksmith/manufacturer PDFs, so they're
committed to this folder for me to read directly (poppler-utils extracts the
text). Status of each original ask below.

Legend: ✅ received & folded into `js/keys/blanks.js` · 🟠 still needed.

---

## ✅ 1. Master Lock M1 — DONE

`Masterl Lock 7000-0031_Technical_Manual.pdf` p.25 (1K blank row) +
`KeyBittingSpecifications-TylerJThomas.pdf` p.63 (Master .0155" family).
M1 now `verified: true`: 4-pin, TFC .187, BCC .125, 8 depths (0–7), step .0155,
root depths .2720→.1635, angle 90°, flat .044, MACS 5.

## ✅ 2. Schlage SC1 / SC4 — DONE

Thomas p.76. Confirmed exact per-code root depths (.335→.200), TFC .231,
BCC .156, step .015, angle 100°, flat .031, MACS 7.

## ✅ 3. Kwikset KW1 — DONE

Thomas p.57. Confirmed root depths (.329→.191), TFC .247, BCC .150, step .023,
angle 90°, flat **.084"** (corrected from the earlier .030 estimate), MACS 4.

## ✅ 4. Warded cross-section profiles — DONE (for SC / KW / M)

Sourced from **ervanalb/keygen** (github.com/ervanalb/keygen, **CC0 1.0 / public
domain**). Extracted every warding polygon → `derived/warding-profiles.json`
(full raw dump) and wired the in-scope ones into **`js/keys/warding.js`**:
- **Schlage** full C-family: C, CE, E, EF, F, FG, G, H, J, K, L (1.910mm × 8.712mm)
- **Kwikset** KW1 (2.0mm × 8.509mm)
- **Master** K1 = M1 (1.98mm × 7.136mm = .281")

These are true paracentric sections — SC1 needs the real **C** section (a flat
blade won't enter a paracentric Schlage keyway). keygen does NOT cover Yale,
Weiser, Sargent, Arrow, Dexter — those are still needed for the next wave
(see WARDING-TO-GRAB). Best/Medeco sections exist in keygen but are out of scope.

## ✅ 5. Next-wave blanks (WR5, Y1, S1, A1, KW10) — SOURCE IN HAND

The Thomas compendium covers these; no new pull needed. I'll extract each `spec`
from `KeyBittingSpecifications-TylerJThomas.pdf` when we expand the library past
the first four. (One caveat to confirm at that time: which "A1" — Arrow vs
American — you mean.)

---

### Bottom line
Depth-and-spacing for all four v1 blanks is **verified**. The only outstanding
data is **item 4, the warded cross-sections**, and it's only needed when the mesh
graduates from "prints a geometry proof" to "prints a key that enters the lock."
