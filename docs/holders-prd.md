# PRD: Holders & Organizers — foam inserts, drawer layouts, Gridfinity, holsters

Status: **complete — all phases shipped (v1.11.0–v1.17.0)** · 2026-07-27 · target branch `claude/2.5d-photo-stl-s3-y0oodn`

> **Follow-on work shipped after this PRD closed (v1.18.0–v1.23.0).** These were
> separate requests, not phases of this document, and are recorded here so the
> PRD is not read as the current state of the feature area:
>
> - **v1.18.0** — placeable finger notches everywhere; Gridfinity gains notches.
> - **v1.19.x** — front + back photo fork: mirrored underside underlay, and
>   sections drawn in underside mode become bottom-face undercuts.
> - **v1.20.0–v1.21.0** — graph-paper, dot-grid and cutting-mat scale
>   references with auto-detected square counts and a scale-bar override.
> - **v1.22.0** — cut templates tile to the laser or printer bed, with seams
>   placed to cross the fewest pockets and then to maximise clearance.
> - **v1.23.0** — puzzle-tab interlocks on those seams, so two bed-sized foam
>   tiles lock into one drawer insert.
>
> Still open in this feature area: nesting / auto-sort for drawer layouts
> (see `docs/nesting_prd_v1.0.md`, awaiting sign-off) and STL tiling of
> *printed* inserts with registration features.

## Problem

2.5D turns one photo into one true-scale solid of the *object*. The natural
next ask is the *negative*: things that hold the object — foam-style drawer
inserts, multi-tool drawer layouts, Gridfinity bins and baseplates, and
wall-mount holsters. Today every one of those means exporting the outline to
CAD and rebuilding by hand, which throws away the app's whole premise
(photo → printable part with zero CAD).

Current workflow being replaced: trace tool → export SVG/DXF → import into
Fusion/OpenSCAD → offset, pocket, model bin/insert manually → export STL.
The manual steps are exactly the parts 2.5D already knows how to do
(offsets, pockets, prisms); nothing in the chain needs 3D CSG.

## What research changed

- **[tracefinity](https://github.com/tracefinity/tracefinity)** (MIT) is a
  photo→Gridfinity-bin generator with the same capture idea (tools on known
  paper). Its mesh path is Python + **manifold3d (CSG)** — not portable into
  our no-CSG, watertight-by-construction browser kernel. What *is* portable:
  its UX shape (persistent tool library → bin layout editor → export) and its
  feature list (pocket clearance, finger holes, interior supports for hollow
  tools, multi-part split for big bins, 3MF). MIT is GPL-compatible; if any
  constants/logic are ported verbatim we carry their notice in LICENSE-ASSETS.
- **Gridfinity spec** (gridfinity-unofficial / gridfinity-rebuilt): pitch
  42×42 mm, height unit 7 mm; bin footprint N·42−0.5 per side, corner r 3.75;
  base pad top 41.5² r3.75 → profile down 2.15 chamfer / 1.8 straight /
  0.8 chamfer → bottom 35.6² r≈0.8 (4.75 mm total); stacking lip 2.6 wide ×
  4.4 tall (0.7/1.8/1.9); magnets Ø6.5×2.4 at 26 mm centers (8 mm from cell
  edge); screws Ø3. All of it is prisms + lofts between offset rounded rects —
  buildable with our slice/zip machinery, **no CSG needed**.
- **In-repo seeds**: the outline library (`2p5d.library.v1`) already saves
  arc-aware container outlines; `buildSolid` already builds watertight prisms
  with holes, blind features, and shared-frame stacking; the deboss precedent
  blesses overlapping shells and 0.01 mm buried interfaces.

## Success criteria

1. From one or more traced tools, export a printable, watertight STL of:
   a foam-style insert, a multi-tool drawer insert, a Gridfinity bin (with
   pockets), a custom baseplate, or a holster — with zero external CAD.
2. Every export passes the e2e watertight check (every edge shared by exactly
   2 triangles) and lands within ±0.1 mm of spec dimensions in tests.
3. Format keys stay stable (`app:'2.5D'`, `LIB_KEY`, `-2p5d.stl`, STL header);
   all new save fields additive.
4. Single-file, client-side, no new runtime dependencies.

## Phases and recommended order

### Phase 0 — polish (approved, in progress): single-shell deboss
The two tabled "minor" items are one refactor. Deboss becomes glyph-shaped
blind recesses cut into **one** watertight prism (glyph walls from
`t−depth`→`t`, recess-floor annulus at `t−depth` with letter counters as
standing islands, top cap = footprint − glyphs ∪ counters) — the same idea as
blind screw holes, generalized to arbitrary rings. Consequence: screw-feature
machinery sees the full section thickness again, so **same-face recessed
screw features on a debossed face survive** instead of demoting to bores.
Falls back to today's two-layer split when a glyph sits too close to an edge
treatment's inset. Logo swap: waiting on the PNG. → v1.11.0

### Phase 1 — tool library + layout engine + foam/drawer inserts
The shared foundation everything else reuses.
- Library upgrade: entries gain a **kind** (tool | container) and stored
  **thickness**; save/load stays arc-aware. Additive fields only.
- **Layout mode**: place N saved tool outlines inside a container (plain
  rect W×D or a traced/saved drawer outline), drag + rotate (free, with snap),
  per-placement pocket depth override, collision/margin highlight. Manual
  packing only — no auto-nest in v1.
- **Insert generator**: slab (container footprint, own thickness) minus
  pockets (tool outline offset outward by clearance, cut to per-tool depth),
  optional finger notches (circle union per pocket, draggable). Two stacked
  prism layers per depth class — pure `buildSolid`.
- Single-tool foam insert ships first as an increment (container = auto
  rect with margin); true-scale **SVG cut template** (slab + pockets) rides
  along for people cutting real Kaizen foam.
→ v1.12.x, incremental: offset primitive + single-tool foam → library kinds
→ layout mode → multi-tool inserts.

### Phase 2 — Gridfinity bins
Loft machinery (rounded-rect ring lofts with fixed per-corner segment counts
so slices zip 1:1): base pads, optional stacking lip, optional magnet holes.
Bin body = footprint prism; pockets from Phase 1 pipeline (single tool or a
layout). Auto N×M from content + clearance, user can bump. Defaults borrowed
from tracefinity/gridfinity-rebuilt where sensible. → v1.13.x

### Phase 3 — hybrid + custom baseplates
- Hybrid foam-bin = Phase 2 bin with full-depth Kaizen-style pockets — mostly
  configuration, not new geometry.
- **Custom baseplates**: socket grid (inverse base profile lofts) clipped to a
  traced drawer outline; partial cells become solid margin. This is the
  "photograph your drawer, print a baseplate that fits it exactly" feature —
  nothing else on the market does the custom-outline part from a photo.
→ v1.14.x

### Phase 4 — holsters (last, per user)
Outward offset band (clearance + wall, user height), optional floor, flat
back (tangent-rect union in plan) for velcro, and a mounting plate as a
separate watertight prism extruded along the wall normal and rotated into
place (0.01 mm buried overlap — deboss precedent) carrying keyhole tab(s)
and/or screw wings with through-holes. No pegboard/multiboard (user doesn't
use them). → v1.15.x

### Why this order (vs Gridfinity first)
Tracefinity's useful knowledge (clearances, finger holes, pocket UX) applies
equally to foam and bins, so it doesn't force Gridfinity earlier. The layout
engine is the bigger shared foundation: foam-without-Gridfinity needs no
lofts, so Phase 1 proves the pocket pipeline on simple geometry, and Phase 2
only adds the base/lip lofts to an already-working system. Holster shares the
least (offset + plate) and is explicitly last.

## Constraints

- Locked scope: 2D footprint ops + extrusion/lofts only; no 3D CSG. Every
  part is independently watertight; overlapping shells union in the slicer.
- Format keys stable; save fields additive; library entries stay loadable by
  older versions (unknown fields ignored).
- Push only to `claude/2.5d-photo-stl-s3-y0oodn`; deploys touch
  `gh-pages/2.5d.html` + landing `?v=` bump only.
- GPLv3 + Commons Clause; ported MIT material keeps its notice.

## Open questions (recommendation first)

1. **Layout mode entry point** — recommend: a distinct stage reachable from
   step 3 ("Arrange a drawer…") and from the project modal, keeping the
   3-step wizard intact for the single-object flow. Alt: a 4th wizard step.
2. **Pocket depth source** — recommend: stored per tool at save time (from
   its section thickness), overridable per placement. No depth from photo.
3. **Multi-part split for big inserts** (drawer wider than bed) — recommend:
   defer to a later increment; warn when footprint exceeds a configurable
   bed size, ship split (straight seams + alignment pins?) only if asked.
4. **3MF export** (tracefinity ships it; single files, color/metadata) —
   recommend: defer; STL + SVG/DXF cover the printers we target.
5. **Interior ring supports** for hollow tools (pocket islands that would
   float, e.g. inside a tape roll) — recommend: include in Phase 1; the trace
   editor already keeps holes, and a pocket hole = standing pillar (free).
6. **Gridfinity magnet default** — recommend: off (most drawer users skip
   magnets; toggle stays one click).

## Decision needed

Sign off the phase order (0→1→2→3→4 above) or reorder; answer any open
questions you care about — silence on any of them means the recommendation
ships.
