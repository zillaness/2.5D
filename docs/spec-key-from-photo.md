<!--
SPEC + FORK HANDOFF — key-from-photo (working name TBD)
Session: S2c  (parent: S1)
Parent: 2.5D + Blueprint build session (S1)
Branch: claude/key-from-photo  (seeded from claude/object-thickness-photo-t8mw2k)
Date: 2026-07-21
-->

# Spec — Photograph a key → print a spare

**Working name:** TBD (candidates: *DupliKey*, *SpareKey*, *KeyCast*).
**Branch:** `claude/key-from-photo`, seeded from the 2.5D mainline
(`claude/object-thickness-photo-t8mw2k`) — the photo pipeline is what this needs,
not Blueprint's PDF path.

## The idea

Photograph a pin-tumbler house key laid flat on a known-size reference; identify
the **keyway blank** (Schlage SC1/SC4, Kwikset KW1/KW10/KW11, the "KW4" you
mentioned, etc.) — picked from a library or auto-suggested; **read the bitting**
(the cut depths along the blade) from the photographed edge; **snap** each cut to
the manufacturer's standard depth-and-spacing so you get a clean bitting code; and
**generate a printable 3D key** (STL) — a spare for a lock you own.

## Why it's a natural fork of 2.5D

2.5D already is "photograph a physical object on a known-size reference → true-
scale printable solid." A key is just a specific object with domain rules:

| 2.5D capability | Reused for keys |
|---|---|
| Homography + card/coin/paper calibration (`js/homography.js`) | True-scale rectified image of the key |
| Radial lens correction (`js/lens.js`) | Straight blade edges, accurate depths |
| Contour tracing + resample (`js/contour.js`) | Trace the blade's cut (top) edge |
| Extrude + Clipper offsets + earcut caps + watertight STL (`js/mesh.js`, `js/exporters.js`) | Build the 3D key and export |
| Hole-callout / trace confirm-list UX pattern | Confirm/edit the decoded bitting code |
| mm/inch (`js/units.js`) | Keys are spec'd in inches (US) |

The **new** part is small and self-contained: a blank/keyway library, a bitting
decoder, and a key-mesh builder.

## Pipeline

1. **Capture & rectify.** Reuse the existing corner/reference calibration + lens
   correction. Key flat, blade and bow coplanar, on a contrasting background with
   a scale reference (card/coin) in frame. Shoulder (the stop that seats against
   the lock face) must be clearly visible — it is the measurement datum.

2. **Keyway / blank selection.**
   - **v1:** user picks the blank from a bundled library. Each blank record =
     `{ brand, keyway, pins, sectionProfile, spec }` where `sectionProfile` is the
     warded **cross-section polygon** (blade width, thickness, and side grooves)
     and `spec` is the depth-and-spacing (below).
   - **v1.1:** auto-suggest from the bow silhouette + blade width + groove count.

3. **Bitting read.**
   - Establish the **shoulder datum** and blade axis from the rectified trace.
   - At each standard **cut center** (from `spec.firstCut` + k·`spec.spacing`),
     sample the blade-edge height → convert to a depth relative to the blank's
     uncut edge → **snap to the nearest standard depth increment**.
   - Emit the **bitting code** (e.g. Schlage 5-digit `1-0-3-4-5`). Enforce **MACS**
     (max adjacent cut spec) and flag violations.
   - Show the decoded code in a **confirm/edit panel** (same pattern as the trace
     hole-confirm) — the user can nudge any digit before generating.

4. **3D generation (`keyMesh`).** Extrude the blank cross-section along the blade
   length; at each cut center subtract a **V-groove** to the snapped depth at
   `spec.cutAngle`; add the tip chamfer and a bow (from the blank, or a generic
   printable bow with an optional embossed code). Verify watertight; export STL.

5. **Export & print guidance.** STL + notes: print the blade **on-edge** (layers
   across the blade, not along it) for shear strength; PLA/PETG are weak and may
   snap — PETG/nylon/resin recommended; expect fragility and treat as a temporary
   or emergency spare.

## Data — the blank/keyway library (the make-or-break asset)

`js/keys/blanks.js`: a table of common blanks. Each entry needs a **cross-section
polygon** (the hard-to-source data — the warding is what lets the key enter the
lock) and a **depth-and-spacing spec**:

```
spec = { unit:'in', firstCut, spacing, depthCount, depthStep,
         rootDepthAt0, cutAngle, macs }
```

Reference values to **verify against an authoritative depth-and-spacing chart
before cutting real geometry** (do not treat these as final):
- **Schlage** (SC1 5-pin / SC4 6-pin): spacing ≈ 0.156", first cut ≈ 0.231",
  10 depths (0–9), ≈ 0.015"/step, ≈ 90–100° cut, MACS ≈ 7.
- **Kwikset** (KW1 5-pin): spacing ≈ 0.150", first cut ≈ 0.247", 7 depths (1–7),
  ≈ 0.023"/step, MACS ≈ 4. ("KW4" is in the Kwikset family — confirm its exact
  keyway/pin count when sourcing.)

Start with Schlage + Kwikset (the vast majority of US residential locks), add more
blanks incrementally.

## Accuracy strategy

Pin tolerances are tight (~0.005"), but you **don't need sub-thou photo
precision** — you only need to pick the correct one of ~7–10 discrete depths, i.e.
resolve to about half a depth step (~0.007–0.011"). Snapping to the standard code
absorbs the rest. The dominant error source is the **shoulder datum**, so
registration matters more than raw pixel resolution; averaging the edge over each
cut's flat helps.

## New modules (small surface area)

- `js/keys/blanks.js` — blank/keyway library (section profiles + depth-and-spacing).
- `js/keys/bitting.js` — decode blade edge → depth code (datum, sample, snap, MACS).
- `js/keys/keyMesh.js` — build the key solid (extrude profile + V-cuts + tip + bow).
- UI: blank picker + bitting confirm/edit panel (reuse the confirm-list pattern).
- Tests: synthetic key photo (known code) → assert decoded code + watertight STL.

## Scope / staging

- **v1:** pick blank from library (Schlage + Kwikset); single-sided bitting; decode
  + confirm + STL. 
- **v1.1:** keyway auto-suggest; more blanks; embossed code on the bow.
- **Later / out of early scope:** double-sided & dimple keys, automotive/transponder
  keys, tubular keys.

## Constraints & responsible use

- **For keys you own or are authorized to duplicate** — a spare for your own lock,
  the same thing a hardware store does when it cuts you a copy.
- **Out of scope: restricted / patented / registered keyways** and anything marked
  "Do Not Duplicate" (e.g. Medeco, Abloy, Mul-T-Lock high-security) — those are
  legally controlled; the tool targets ordinary residential blanks only.
- **Client-side single-file app**, same architecture as 2.5D — no cloud, the photo
  never leaves the device.

## Risks

- **Sourcing accurate keyway cross-sections** — the profile must be right or the
  key won't enter; this is the main data risk.
- **Photo precision vs pin tolerances** — mitigated by snap-to-code + a good
  shoulder datum.
- **Printed-key strength** — inherent to 3D-printed keys; addressed with material +
  orientation guidance, not a code fix.

---

## Fork handoff — starter prompt (copy into a new chat)

```
[Picking up a thread from another conversation — fork-this handoff]

NAME THIS CHAT: Key-from-photo — spare-key printer — S2c (2026-07-21)

I was working on: a browser-only, single-file tool that photographs a pin-tumbler
house key on a known-size reference, identifies the keyway blank (Schlage SC1/SC4,
Kwikset KW1/KW4…), reads the bitting (cut depths), snaps to the manufacturer's
depth-and-spacing, and generates a printable 3D spare key (STL). Forked from 2.5D
(photo→solid), reusing its homography/calibration, lens correction, contour trace,
mesh, and STL export.

Background: forked from "2.5D + Blueprint build session," S1. Branch
claude/key-from-photo in repo zillaness/2.5D, seeded from the 2.5D mainline
(claude/object-thickness-photo-t8mw2k). Full spec: docs/spec-key-from-photo.md.

Skills to load at session start:
- fork-this (only if you need to fork again)

Project state:
- Branch claude/key-from-photo has the clean 2.5D v1.3.x photo core + this spec.
  No key-specific code written yet.
- Planned new modules: js/keys/blanks.js (library), js/keys/bitting.js (decoder),
  js/keys/keyMesh.js (key solid), + blank-picker & bitting-confirm UI.

Constraints:
- Single-file client-side app; photo stays on-device.
- For keys the user owns/is authorized to copy; NO restricted/patented/high-
  security or "Do Not Duplicate" keyways.
- Push only to claude/key-from-photo; commit with git -c core.hooksPath=/dev/null,
  co-author Claude Fable 5; never put the model id in anything pushed.

Decisions already made:
- Fork of 2.5D (reuse the photo pipeline), not of Blueprint.
- Bitting read by snap-to-standard-depth (don't chase sub-thou precision); shoulder
  is the datum.
- v1 = pick blank from a Schlage+Kwikset library, single-sided, decode+confirm+STL.

Open questions:
- Product name.
- Sourcing accurate keyway cross-section profiles + verified depth-and-spacing
  charts (the make-or-break data).
- Auto-detect keyway vs picker-only for v1.

Start here: Verify the Schlage/Kwikset depth-and-spacing numbers against an
authoritative chart, then stub js/keys/blanks.js with 2–3 verified blanks and
js/keys/bitting.js (edge → snapped code + MACS), with a synthetic-photo test that
round-trips a known bitting code. Interview me on the open questions before
building the mesh.
```
