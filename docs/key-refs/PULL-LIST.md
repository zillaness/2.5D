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

## 🟠 4. Warded cross-section profiles — STILL NEEDED (the make-or-break data)

For KW1, SC1, M1, SC4: the blade **cross-section** (width, thickness, side-groove
shape/positions). Without it the mesh is a geometry proof that won't enter a lock.
The charts we now have give depth-and-spacing but **not** the warding.

- **Best single source:** the MakerWorld model *"Kwikset KW1 Key Maker — Make
  real working keys"* (`makerworld.com/en/models/1569331`). Drop its **STL** here
  and I'll measure the KW1 warded section off the solid.
- Or: keyway cross-section diagrams (Ilco/JMA blank catalog cutaways, Lishi
  decoding diagrams), or a traced SVG/DXF from calipers on a blank.
- Or: the self-bootstrapping loop — once decode works, generate a known code on a
  keygen, export its STL, drop it here.

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
