<!--
FORK HANDOFF — fork-this v1.1
Thread: 2.5D mainline (photo → printable solid)
Fork: 2 of 2
Session: S2b  (parent: S1)
Parent: 2.5D + Blueprint build session (S1)
New chat name: 2.5D — photo→solid mainline — S2b (2026-07-21)
Date: 2026-07-21
-->

# FORK HANDOFF — 2.5D mainline (photo → printable solid) — S2b

## Parent context

Parent conversation (S1) built **2.5D** — photograph a physical object on a
known-size reference (paper / card / coin), trace it at true scale, and extrude
it into a printable STL — through **v1.3.0**. Late in S1 the project pivoted to
CAD-drawing import, which was **forked out into "Blueprint"** (fork S2a) to keep
2.5D lean. This thread (S2b) is the **2.5D mainline**: the photo→solid product,
which stays focused and unchanged by the drawing-import work.

## Thread summary

2.5D's identity is "photograph a real object → printable solid." It is feature-
complete through v1.3.0 (radial lens-distortion correction was the last ship).
The mainline queue is three new capabilities the user asked to add — multi-tool
scanning with a drawer/toolbox layout, geometric constraints on traces, and
in-app measurement tools — plus one tabled item (photo/scan line-art vectorize).
No mainline code was written in S1 after v1.3.0; these are fresh increments.

## Skills in play

- `fork-this` (/root/.claude/skills/fork-this/SKILL.md) — used to produce this handoff.
- No other custom skills were central; work was direct code + Playwright tests.

## Project state

**Repo:** `zillaness/2.5D` · **Mainline branch:** `claude/object-thickness-photo-t8mw2k`
(the designated 2.5D dev branch) · shipped through **v1.3.0**.

Shipped capabilities (all on the mainline):
- Image pipeline: DLT homography + bilinear rectification; paper/card/coin
  detection; Otsu segmentation, morphology, connected components; directed-edge
  boundary tracing; RDP/Chaikin; least-squares circle fit.
- **Radial lens-distortion correction** (Brown model in rectify + manual slider +
  auto-straighten) — v1.3.0.
- Calibration presets: card / bill / coin (coin = scale-only).
- Hole model: through / blind / countersink / counterbore, metric + SAE screw
  table with ±½-pitch fits, heat-set inserts, per-hole rim chamfers/fillets
  (top/bottom).
- Multi-section model: per-region thickness, floor offset (overhangs), region
  drawing/editing.
- Trace editor: drag-to-size holes, on-canvas ⌀ input, multi-select, arc/line
  normalize, densify/decimate, rotate view 90°, container outline library, mm/inch.
- Mesh: extrude + chamfer/fillet via Clipper offsets + earcut caps; watertight
  verification (every edge shared by exactly two triangles).
- Export: binary STL, SVG, DXF; STL quality presets.
- **Vector CAD import (DXF + SVG) → trace with view selection** — this shipped on
  the mainline too, and is the seed the Blueprint fork extended with PDF.
- Single-file local build + published Claude artifact + GitHub Pages docs.

Note: the Blueprint fork (PDF import, read-the-drawing, hole callouts) lives on a
separate branch (`claude/blueprint-seed`) and does **not** belong here — 2.5D
stays lean.

## The queue — 2.5D mainline work items

| # | Item | Status | Notes |
|---|------|--------|-------|
| **24** | **Multi-tool scan → edit/save traces → drawer/toolbox layout** | Pending | Scan several tools in one session, edit each trace, save them, then auto-arrange into a drawer or toolbox insert layout. Open scope: nesting/packing algorithm, per-tool pockets, save/library format. |
| **25** | **Geometric constraints on the trace** (perpendicular / parallel / etc.) | Pending | Let the user constrain trace edges — perpendicular, parallel, and likely equal-length / horizontal / vertical — to clean up hand traces. |
| **26** | **In-app measurement tools** (point/line/face distance, angle, radius) | Pending | Capture rough estimated measurements from the photo in-app. Motivation: today you'd export the STL and measure point-to-point / face-to-face / line-to-line in Bambu Studio; do it in-app instead. Angles and radii are the hard cases a caliper can't easily catch. |
| 17 | Photo/scan line-art vectorize + two-point scale | **TABLED** | Vectorize line-art from a photo/scan and set scale from two points. Deferred. |
| — | README roadmap upkeep | Housekeeping | Add #24 / #25 / #26 to the 2.5D README roadmap when next working on this branch. |

## Constraints

- **Client-side single-file app** (same architecture as the shipped 2.5D).
- **Internal project-format keys must stay stable** (`app:'2.5D'`, `LIB_KEY`,
  `-2p5d.stl`, STL header `"2.5D v"`) — the Blueprint fork shares these files
  byte-for-byte for cheap cherry-picks, so gratuitous churn there breaks the fork
  relationship.
- **Designated 2.5D branch:** `claude/object-thickness-photo-t8mw2k`. Do not push
  to another branch without explicit permission. Commit with
  `git -c core.hooksPath=/dev/null`, co-author `Claude Fable 5`.
- **Never put the model identifier in commits, PRs, code, or any pushed
  artifact** — chat replies only.

## Decisions + reasoning

- **2.5D stays lean; CAD-drawing import went to the Blueprint fork** — different
  product, different user, heavy deps. Keep the photo→solid tool focused.
- **Photography guidance (established in S1):** a phone's **2x lens from farther**
  gives less radial distortion and less parallax than 1x up close — better for the
  measure-from-photo use case. Caveat: 2x may be a sensor crop on some phones.

## Open questions

- **#26 measurement:** which measurement types to build first — point-to-point
  distance vs face-to-face vs line-to-line vs angle vs radius? (Angle/radius are
  the ones the user specifically can't easily get with a caliper.)
- **#24 drawer/toolbox layout:** how automatic should packing be — freeform
  drag-place, grid, or a nesting/packing solver? What's the save/library format
  for a multi-tool project?
- **#25 constraints:** which constraint set for v1 (perp / parallel / equal /
  H-V), and does it re-solve live as the user drags?

---

## STARTER PROMPT — copy everything below this line

---

[Picking up a thread from another conversation — fork-this handoff]

NAME THIS CHAT: 2.5D — photo→solid mainline — S2b (2026-07-21)

I was working on: **2.5D** — a browser-only, single-file, client-side tool that
turns a photo of a physical object on a known-size reference into a true-scale,
printable STL (with holes, chamfers/fillets, multi-section thickness, and
STL/SVG/DXF export). It's feature-complete through v1.3.0; this thread adds new
mainline capabilities.

Background: forked from "2.5D + Blueprint build session," S1. The CAD-drawing-
import direction was split off into a separate product ("Blueprint," fork S2a on
branch `claude/blueprint-seed`); this thread keeps 2.5D lean and focused on
photo→solid. Repo `zillaness/2.5D`, mainline branch
`claude/object-thickness-photo-t8mw2k`.

Skills to load at session start:
- fork-this (only if you need to fork again)

Project state:
- 2.5D shipped through v1.3.0 (last ship: radial lens-distortion correction).
  Core files: `js/main.js`, `js/ui/traceEditor.js`, `js/mesh.js`, `js/contour.js`,
  `js/homography.js`, `js/lens.js`, `js/screws.js`, `js/exporters.js`,
  `js/import/{loops,dxfImport,svgImport,cadImport}.js`, `test/e2e.mjs`.
- No mainline code written after v1.3.0 — the queue below is all fresh.
- Full work queue is in `docs/handoff-2.5d.md`.

Constraints:
- Single-file client-side app.
- Keep internal format keys stable (`app:'2.5D'`, `LIB_KEY`, `-2p5d.stl`, STL
  header `"2.5D v"`) — the Blueprint fork shares these files byte-for-byte.
- Push only to `claude/object-thickness-photo-t8mw2k`; commit with
  `git -c core.hooksPath=/dev/null`, co-author `Claude Fable 5`; never put the
  model id in anything pushed.

Decisions already made:
- 2.5D stays lean (drawing import lives in the Blueprint fork).
- Photography: 2x lens from farther = less distortion + parallax (2x may be a
  sensor crop).

Open questions:
- #26: which measurement types first (point/line/face/angle/radius)?
- #24: how automatic is the drawer/toolbox packing, and what's the save format?
- #25: which constraint set for v1, and live re-solve on drag?

Start here: Pick one of the three mainline items and spec it before building —
recommended order is **#26 in-app measurement** (point/line/face distance, angle,
radius) since it compounds with the photo-measurement use case, then **#25
constraints**, then **#24 multi-tool drawer/toolbox layout**. Interview me on the
open questions for whichever you start, then plan it. Also add #24/#25/#26 to the
2.5D README roadmap.
