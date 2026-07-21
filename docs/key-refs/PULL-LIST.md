# Pull list — things I can't fetch, ordered by payoff

The build proxy 403s all of these. Drop them in this folder (see `README.md`) and
I'll fold them into `js/keys/blanks.js`. Each item says **what to grab** and
**what I'll extract**.

Legend: 🔴 unblocks a provisional blank · 🟠 upgrades a verified blank's fidelity ·
🟢 next-wave expansion.

---

## 🔴 1. Master Lock M1 — full chart (highest payoff)

M1 is in the library but **provisional**: only pins (4), depth count (0–7), and
increment (0.0155″) are confirmed. Missing: **spacing, first cut, cut angle,
MACS, per-code root depths.**

- **Grab:** Master Lock Technical Manual 7000-0031, the **bitting specification**
  pages — pg 20–22 and pg 25 (`cdn.masterlock.com/.../7000-0031_Technical_Manual_pg_25.pdf`
  and `..._pg_20_22.pdf`). A photo of any M1 depth-and-spacing chart also works.
- **I'll extract:** spacing, TFC (first cut), cut angle + flat, MACS, root depths →
  fill the `UNVERIFIED` fields and flip M1 to `verified: true`.

## 🟠 2. Schlage SC1 / SC4 — per-code root depths + cut geometry

Spacing (.156), first cut (.231), 10 depths, step (.015), MACS 7, ~100° are
confirmed. What's still second-hand: the **exact per-code root depths** and the
**flat-root width**.

- **Grab:** `lsamichigan.org/Tech/SCHLAGE_KeySpecs.pdf`, or the Framon Depth &
  Space Manual (`framon.com/pdfs/manuals/Framon-Depth-and-Space-Manual.pdf`),
  Schlage section. A clear photo of the printed chart is fine.
- **I'll extract:** per-code root depth table + cutter flat → tighten
  `rootRemovalAtMin` / `cutFlat` and add a per-code depth table if it's non-linear.

## 🟠 3. Kwikset KW1 — per-code root depths

Spacing (.150), first cut (.247), 7 depths, step (.023), MACS 4 confirmed;
shallowest removal (.008) is from a modelling project, not the chart.

- **Grab:** `lsamichigan.org/Tech/Kwikset_KeySpecs.pdf` or the Framon manual's
  Kwikset section.
- **I'll extract:** per-code root depths to confirm/replace the .008 origin.

## 🟠 4. Warded cross-section profiles (the make-or-break data)

For KW1, SC1, M1, SC4 — the blade **cross-section** (width, thickness, side-groove
shape/positions). Without this the mesh is a geometry proof that won't enter a
lock.

- **Grab, any of:**
  - A **keygen STL** of a known code for each keyway (your feedback-loop idea) —
    I'll measure the section off the solid.
  - Keyway **cross-section diagrams** (Ilco/JMA blank catalog cutaways, Lishi
    tool decoding diagrams, or a scanned blank end-on).
  - A traced **SVG/DXF** of the profile if you have calipers + a blank.
- **I'll extract:** the `sectionProfile` polygon per blank → real warded blades.

## 🟢 5. Next-wave blanks — depth-and-spacing charts

For when we expand past the first four: **WR5** (Weiser), **Y1** (Yale), **S1**
(Sargent), **A1** (Arrow/American — confirm which "A1"), **KW10** (Kwikset 6-pin).

- **Grab:** the **Tyler J. Thomas, _Key Bitting Specifications_ (2025)** compendium
  — `lsamichigan.org/Tech/KeyBittingSpecifications-TylerJThomas.pdf` covers many
  keyways in one file; or the Framon manual (same). One file likely does all five.
- **I'll extract:** a `spec` block per keyway → new verified `BLANKS` entries.

---

### Fastest path if you only grab one thing
The **Tyler J. Thomas 2025 compendium** or the **Framon Depth & Space Manual** —
either one likely covers Schlage, Kwikset, Master, **and** the whole next wave in
a single PDF, knocking out items 2, 3, and 5 at once. Item 1 (Master's own manual)
and item 4 (cross-sections) are the two things those general charts won't fully
give.
