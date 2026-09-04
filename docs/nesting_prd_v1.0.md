---
file: nesting_prd_v1.0.md
version: 1.0
author: Sam Cao
created: 2026-09-04
last_updated: 2026-09-04
description: PRD for automatic nesting / auto-sort of tool outlines in 2.5D drawer and toolbox layouts.
ai_update: Update last_updated and version. Rename file to match. Append changelog at bottom.
---

# PRD: Nesting / auto-sort for drawer layouts

Status: **DRAFT — awaiting sign-off. Nothing here is built.** · 2026-09-04 ·
target branch `claude/2.5d-photo-stl-s3-y0oodn`

## Problem

The multi-tool drawer layout (v1.13.0) lets you drop traced tools into a
container and drag them around. Every placement is manual. For three tools
that is fine. For a socket set, a plier drawer, or a full toolbox tray it is
tedious, and the result is usually worse than it needs to be, because a human
dragging outlines by hand will not find the interleaved packing that makes a
foam insert worth cutting in the first place. A plier's handles nest into a
screwdriver's shaft; nobody arranges that by eye.

### Current workflow being replaced

1. Trace each tool, save it to the library.
2. Open the layout editor, drop each tool in.
3. Drag each one by hand, rotate with the round handle (Shift snaps to 15°).
4. Watch for red: `layoutConflicts` flags overlapping pockets and any pocket
   that crosses the border inset.
5. Nudge until nothing is red. Accept whatever density that produced.
6. If the drawer is wider than the laser bed, export the cut template and let
   `splitTiles` find seams through whatever gaps the hand layout left.

Steps 3 to 5 are the whole cost, and step 6 inherits their mistakes. A hand
layout that happens to leave no clear vertical band forces every candidate
seam to cut a pocket.

### Why not just use the cut-sheet-builder

The separate CutSheetCalculator project already nests, properly, with
`nest2D` (libnest2d, no-fit-polygon) and a bundled shapely greedy fallback.
It is the better nester and it should stay the serious one for flat sheet
goods. It is the wrong tool here for three reasons:

- It needs a Python runtime. 2.5D is a single self-contained HTML file with
  no server and no user-facing build step. Routing a layout through it means
  a file round-trip and breaks that constraint for this path.
- It nests *many parts onto as many sheets as needed*, minimising sheet
  count. A drawer insert is the opposite problem: one fixed container, a
  fixed set of tools, and the question is whether they fit and how reachable
  they are once they do.
- Density is not the objective here. A drawer packed to 95% is a drawer you
  cannot get your fingers into.

So: build a modest nester in 2.5D that is aware of the things that actually
matter in a drawer, and leave CutSheetCalculator as the density specialist.

## Success criteria

1. **Correct by construction.** A nested result must produce
   `collisions.size === 0 && escaped.size === 0` from the existing
   `layoutConflicts(containerOuter, pockets, border)`. Not "usually". The
   nester scores against the same predicate the editor validates with, so a
   nested layout can never come back red.
2. **Beats hand placement on a real set.** On a reference set of 12 traced
   hand tools in a 550 × 380 mm drawer, the nested arrangement fits at least
   as many tools as a careful manual arrangement, in no more than the same
   bounding area. Measured once by hand, then frozen as a test fixture.
3. **Reachable.** Every item's finger notch, where one is defined, still
   opens onto clear foam rather than being sealed against the container wall
   or an adjacent pocket. Concretely: the notch circle must retain at least
   `notchClear` mm (default 8) of free foam measured outward from its centre.
4. **Non-destructive.** Nesting is a single undoable action. The prior
   arrangement is restored exactly on undo, including rotations.
5. **Respects pins.** Any item the user has pinned keeps its exact `x`, `y`,
   `rot`, and the nester packs around it.
6. **Does not freeze the tab.** 30 items complete in under 2 s on a mid-range
   laptop, or the run yields to the event loop with a progress indication.
7. **Honest about failure.** If not everything fits, the nester places what it
   can, leaves the rest untouched and outside the container, and says exactly
   which items it could not place and why (too large in every allowed
   orientation vs. no room left).

## Scope

### In

- A **Nest** button in the layout editor toolbar, operating on the current
  container and item list.
- A greedy true-outline placer, ported in structure from
  `cut-sheet-builder/scripts/cutsheet/pack_poly.py::_nest_shapely`, running on
  ClipperLib, which 2.5D already vendors.
- Per-item **rotation policy**: free (stepped), locked to current, or locked
  to a specific angle.
- Per-item **pin** (excluded from nesting, treated as a fixed obstacle).
- **Minimum web** parameter: the least foam that may remain between two
  pockets, and between a pocket and the container border.
- **Finger-notch reach** as a placement constraint, not just a post-hoc check.
- Optional **seam corridors** when a bed size is set, so `splitTiles` has
  somewhere clean to put a seam.
- Deterministic output: same input, same result, every time.

### Out

- Any 3D CSG. This is footprint work, exactly like every other holder.
- Nesting across multiple containers or "spill into a second drawer".
- Importing placements from CutSheetCalculator. Considered and rejected above.
- Changing the pocket geometry itself. The nester moves and rotates items; it
  never reshapes a pocket, adds a notch, or alters clearance.
- Automatic depth assignment. Pocket depth stays per-item and manual.

## Constraints

Inherited, non-negotiable:

- Single-file, fully client-side, no server, no user-facing build step.
- No 3D CSG kernel. Footprint only.
- Save-format keys stay stable (`app:'2.5D'`, `LIB_KEY`, `-2p5d.stl`, STL
  header `"2.5D v"`). New fields are additive only. Nesting parameters and the
  per-item pin/rotation policy are new additive fields.
- Watertight by construction downstream. Nesting does not touch mesh
  generation; it only changes `x`, `y`, `rot` on items that
  `buildLayoutInsert` already consumes.

## Design

### Geometry the nester works on

Not the raw tool outline. The **pocket**, exactly as `layoutPockets` builds
it today:

```
pocket = offsetLoop(placeLoop(item.outer, item), clearance)   // + notch union
```

This matters. The clearance offset and the finger notch are already part of
the shape the foam has to accommodate, so nesting the pocket rather than the
outline means the packing is honest about the space actually consumed. It
also means a tool with a notch automatically reserves the notch's lobe.

For collision purposes each pocket is further inflated by `minWeb / 2`. Two
inflated pockets that do not overlap are guaranteed at least `minWeb` of foam
between them, by the same argument `pack_poly` uses for its kerf gap.

### The placement loop

Per item, in order:

1. **Rotation variants.** For a free-rotation item, angles
   `0, step, 2·step, …` up to 360°, `step` default 15° to match the editor's
   Shift-snap. Locked items contribute exactly one variant. Each variant is
   built once and cached by `(itemId, angle)`; the pocket is rebuilt per
   angle because `offsetLoop` of a rotated outline is not the rotation of the
   offset for non-convex shapes.
2. **Candidate anchors.** The container's inner bounding box corner, plus,
   for every already-placed pocket bbox `(x0,y0,x1,y1)`:
   `(x1+h, y0-h)`, `(x0-h, y1+h)`, `(x1+h, innerY0)`, `(innerX0, y1+h)`,
   where `h = minWeb/2`. This is `pack_poly`'s anchor set and it is what lets
   a part tuck into the notch of an earlier one.
3. **Cheap reject.** Bounding-box overlap test against placed bboxes. If the
   bboxes are disjoint the placement is valid without any Clipper work. This
   is the hot path and keeps the whole thing fast.
4. **True-outline test**, only when bboxes do overlap: Clipper
   `ctIntersection` between the candidate's inflated pocket and each
   overlapping placed pocket, rejecting on area `> 0.05 mm²`. Same threshold
   `layoutConflicts` uses, deliberately.
5. **Containment test.** Clipper `ctDifference` of the candidate pocket
   against the border-inset container, rejecting on area `> 0.05 mm²`. Again,
   `layoutConflicts`'s own test.
6. **Notch reach test.** If the item has a notch, require a disc of radius
   `notchClear` centred on the resolved notch point to be free of other
   pockets and inside the container. This is the one test with no analogue in
   `pack_poly` and it is the reason a generic nester is not enough.
7. **Score.** Minimise `(y + h_extent, x + w_extent, angle)`. Top-left
   gravity in the editor's y-down space. Ties broken toward the smaller
   rotation so the result looks deliberate rather than arbitrary.
8. **Settle.** Binary-search slide up, then left, alternating, up to 6 rounds,
   exactly as `_slide` does. This is what turns a coarse anchor grid into a
   tight pack.

### Item order, and getting more than greedy

Greedy is order-sensitive. Two cheap improvements, both in scope:

- **Sort by descending pocket area** before the first pass. Big awkward
  things placed first, small things filling gaps. This alone is most of the
  gain over input order.
- **Bounded random restarts.** Run the placer `K` times (default 20) with
  seeded shuffles of the equal-area groups, keep the arrangement with the best
  objective. Deterministic because the seed is fixed. 20 restarts on 20 items
  is well inside the 2 s budget, since the bbox reject means most candidate
  tests never reach Clipper.

Full annealing is explicitly not proposed. The marginal density is not worth
the complexity or the runtime in a browser tab, and density is not the
objective anyway.

### Objective: reachability over density

The score above is pure bottom-left packing, which maximises density. For a
drawer that is the wrong target on its own. The proposed objective adds a
**spread term**: among arrangements that fit, prefer the one that maximises
the minimum free-foam distance between pockets, up to a cap of `comfortWeb`
(default 12 mm), after which extra spacing stops earning anything.

In practice: pack tight enough to fit, then relax into whatever room is left
rather than leaving one large void at the far end. This is the concrete
meaning of "reachability beats density" and it is the main thing that
distinguishes this from a sheet nester.

### Interaction with `splitTiles`

`splitTiles` runs *after* the layout exists, and `planSeams` already picks
seams that cross the fewest pockets and then maximise clearance. A tightly
nested layout can defeat it: if pockets tile the drawer uniformly, every legal
seam position cuts something.

Proposed, and **default off**:

- When the layout modal has a bed size set and the container exceeds it,
  compute the seam count `n` and the legal window for each seam exactly as
  `planSeams` does.
- Reserve a **corridor** of width `minWeb` at the clearance-optimal position
  in each window, and pass those corridors to the nester as fixed obstacles.
- If the nest then fails to fit everything, drop the corridors and re-run,
  reporting that seams will cross pockets.

A pocket cut across a seam still works, so this is a preference, never a hard
constraint. Off by default because the bed is only known once the user has
chosen one, and because forcing corridors on a drawer that barely fits its
tools is the wrong trade.

## Plan

Each step ends green and committed.

1. **`nestLayout()` in `js/holders.js`**, pure geometry, no UI. Takes
   `(containerOuter, items, opts)`, returns `{ placements, unplaced, stats }`
   without mutating `items`. Unit-tested headlessly against fabricated
   outlines: two rectangles that must interleave, an L that must rotate to
   fit, a set that cannot fit at all.
2. **Conflict-freeness test.** Property-style: for several generated item
   sets, nest, apply, then assert `layoutConflicts` returns empty sets. This
   is success criterion 1 and it should be the test that gates the feature.
3. **Notch reach + minimum web tests.** Including the adversarial case: a
   notch that would be sealed by a later placement.
4. **Reference fixture.** The 12-tool drawer from success criterion 2.
5. **UI**: Nest button, parameters (`minWeb`, `comfortWeb`, rotation step,
   restarts), per-item pin and rotation-lock controls, progress for large
   sets, and undo.
6. **Persistence**: additive save fields for the new per-item and per-layout
   parameters.
7. **Seam corridors**, behind a checkbox, last, once everything above is
   green.

Steps 1 to 4 are the feature. Steps 5 to 7 are what makes it usable.

## Open questions (recommendation first)

1. **Rotation step: 15° or free?** Recommend **15°**, matching the editor's
   Shift-snap, because a foam insert with tools at 7° looks like a mistake
   and costs runtime for density nobody wants. Free rotation is a later
   toggle if it is ever missed.
2. **Should nesting run automatically when an item is added?** Recommend
   **no**. It is an explicit button. Auto-nesting on every add would relocate
   tools the user just positioned, which is exactly the frustration the
   feature is supposed to remove.
3. **What is the default `minWeb`?** Recommend **8 mm** for foam. Thin webs
   tear when a tool is pulled out. This wants a real cut to confirm, and
   should be listed as unvalidated until then.
4. **Does `comfortWeb` belong in the UI at all, or is one sensible default
   enough?** Recommend shipping it as a hidden constant first and only
   exposing it if the default proves wrong in practice.
5. **Toolbox layouts with multiple compartments.** Out of scope for v1, but
   the API should take a container *loop*, not a rectangle, so a compartmented
   tray is a later container change rather than a nester rewrite. Already
   reflected in the signature above.

## Decision needed

Sign-off to build steps 1 to 4, or a redirect. Nothing in this document has
been implemented.

## CHANGELOG
- v1.0 (2026-09-04): Initial draft for sign-off.
