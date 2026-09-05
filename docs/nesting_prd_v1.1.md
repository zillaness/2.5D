---
file: nesting_prd_v1.1.md
version: 1.1
author: Sam Cao
created: 2026-09-04
last_updated: 2026-09-05
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
3. **Reachable, when the profile asks for it.** Under an access-oriented
   profile, every item's finger notch still opens onto clear foam rather than
   being sealed against the container wall or an adjacent pocket. Concretely:
   the notch circle must retain at least `notchClear` mm of free foam measured
   outward from its centre. Under a density profile this is a warning, not a
   rejection, because a travel toolbox legitimately trades access away.
4. **Non-destructive.** Nesting is a single undoable action. The prior
   arrangement is restored exactly on undo, including rotations.
5. **Respects pins.** Any item the user has pinned keeps its exact `x`, `y`,
   `rot`, and the nester packs around it.
5b. **Profiles are honest.** Switching profile changes only the values it
   seeds. Every value stays visible and editable afterward, and the UI shows
   when the current settings no longer match the profile they came from.
5c. **Labels never silently shrink the web.** If a label needs more room than
   the current minimum web allows, the effective web is raised and the change
   is surfaced, or the label is refused. It is never clipped or overlapped.
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
- **Packing profiles**: two built-in presets, every value individually
  exposed, and user-saved custom profiles persisted to localStorage.
- **Label-aware packing**: reserving label footprints and raising the
  effective web from text size, per the section above.
- Deterministic output: same input, same result, every time.

### Out

- Any 3D CSG. This is footprint work, exactly like every other holder.
- Nesting across multiple containers or "spill into a second drawer".
- Importing placements from CutSheetCalculator. Considered and rejected above.
- Changing the pocket geometry itself. The nester moves and rotates items; it
  never reshapes a pocket, adds a notch, or alters clearance.
- Automatic depth assignment. Pocket depth stays per-item and manual.
- The label *rendering* itself. Turning a name into glyph loops and carving or
  engraving it is the existing `js/text.js` plus `buildSolid` label path, and
  is specified in `docs/labelling_prd_v1.0.md`. This document only covers the
  space a label occupies during packing. The dependency runs one way:
  labelling can ship without nesting, nesting cannot reserve label space
  without labelling.
- Syncing profiles between devices. localStorage is per-browser, same as the
  container library, and that is accepted.

## Constraints

Inherited, non-negotiable:

- Single-file, fully client-side, no server, no user-facing build step.
- No 3D CSG kernel. Footprint only.
- Save-format keys stay stable (`app:'2.5D'`, `LIB_KEY`, `-2p5d.stl`, STL
  header `"2.5D v"`). New fields are additive only. Nesting parameters, the
  per-item pin/rotation policy and the per-item label settings are new
  additive fields. The custom-profile store is a **new** key
  (`2p5d.packprofiles.v1`), not a change to an existing one.
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

### Packing profiles

Density is not one objective with a knob on it. A travelling toolbox and a
shop drawer want different things in more than one parameter at once, and a
single slider cannot express that:

- A **travelling toolbox** wants maximum density. Tight webs, rotation free,
  no space reserved for labels. Everything must fit in a box that gets
  carried, and the tools are held in place by the lid anyway.
- A **tool chest or drawer** wants access. Wide webs so fingers fit, rotation
  restricted so labels stay readable from the front of the drawer, and label
  space reserved as part of each item's footprint rather than borrowed from
  the web afterward.

So the objective is selected by a **packing profile**, which is a named bundle
of the individual settings:

| Setting | Dense | Access | Meaning |
|---|---|---|---|
| `minWeb` | 4 mm | 8 mm | Least foam permitted between two pockets, and between a pocket and the border inset |
| `comfortWeb` | 0 | 12 mm | Spacing past which extra room stops earning score. 0 disables the spread term entirely |
| `rotationStep` | 15° | 90° | Candidate angles. 90° keeps tools square to the drawer so labels read |
| `rotationFree` | yes | no | Whether items may take any step angle or only 0/180 |
| `notchPolicy` | warn | require | Whether a sealed finger notch rejects a placement or merely warns |
| `labelSpace` | none | reserve | Whether a label's footprint is packed as part of the item |
| `restarts` | 20 | 20 | Bounded random restarts |

Both are **presets, not modes**. Selecting one seeds every value; all of them
stay exposed and individually editable afterward. Editing any value marks the
layout as using a **modified** profile, shown as `Access (modified)`, so it is
never ambiguous whether the named profile is still in force.

**Custom profiles** can be saved by name. Storage follows the container
library's existing pattern exactly: a versioned localStorage key
(`2p5d.packprofiles.v1`) holding a JSON array, behind the same write probe and
try/catch, so a browser with storage blocked still works for the session and
simply cannot persist. Built-in profiles are not editable or deletable; a
custom profile that shadows a built-in name is refused.

**A project stores resolved values, never a profile reference.** This matters.
If a project pointed at a profile by name, editing that profile would silently
change the geometry of every saved insert that used it, and a drawer cut six
months ago would come back with different webs. So the project save carries
the actual numbers, plus the profile name as provenance only, plus whether it
was modified. Reopening a project never re-resolves anything.

### Labels, and how they consume packing space

Labelling is optional and off by default. When it is on, a label is not
decoration applied afterward; it is space that has to exist in the layout, so
the nester has to know about it before it places anything.

- A label's footprint is its glyph bounding box from `labelBounds`, grown by a
  margin, positioned relative to its pocket (beside it, or above it, per a
  per-item setting).
- Under `labelSpace: reserve`, that footprint is unioned into the item's
  packed shape. Under `labelSpace: none`, labels are not packed and may be
  refused later if there is no room.
- **Text size drives the minimum web.** A label placed in a web needs
  `textHeight + 2·textMargin` of clear foam. The effective web is therefore
  `max(minWeb, textHeight + 2·textMargin)` wherever a label sits, computed per
  gap rather than globally, so one large label does not inflate the whole
  layout. The UI shows the raised value and why it was raised.
- Rotation interacts: under a profile that allows free rotation, a label
  either rotates with its tool and becomes unreadable, or stays horizontal and
  needs a different amount of room depending on the tool's angle. The access
  profile sidesteps this by restricting rotation to 90° steps; the dense
  profile sidesteps it by not reserving label space at all.

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
5. **Profiles as data**, before any UI: the two built-in presets as plain
   objects, the resolution rules, and the "modified" comparison. Tested by
   asserting that selecting a profile then nesting is identical to setting
   its values by hand then nesting.
6. **Label footprints in the packer**: `labelSpace: reserve` unions the label
   box into the packed shape, plus the per-gap effective-web rule. Tested
   with a label large enough to force the web open, asserting the gap
   actually widens rather than the label overlapping.
7. **UI**: Nest button, a profile picker with every value exposed and
   editable beneath it, per-item pin / rotation-lock / label controls,
   progress for large sets, and undo.
8. **Persistence**: additive project fields for the resolved values plus
   profile provenance, and the `2p5d.packprofiles.v1` custom-profile store
   with the container library's write-probe and try/catch treatment.
9. **Seam corridors**, behind a checkbox, last, once everything above is
   green.

Steps 1 to 4 are the feature. Steps 5 to 9 are what makes it usable.

## Open questions (recommendation first)

1. **Rotation step per profile.** Recommend **15°** for dense, matching the
   editor's Shift-snap, and **90°** for access so labels stay readable from
   the front of the drawer. Free continuous rotation is not proposed: a foam
   insert with tools at 7° looks like a mistake and costs runtime for density
   nobody wants.
2. **Should nesting run automatically when an item is added?** Recommend
   **no**. It is an explicit button. Auto-nesting on every add would relocate
   tools the user just positioned, which is exactly the frustration the
   feature is supposed to remove.
3. **What are the default webs?** Recommend **8 mm** for Access and **4 mm**
   for Dense. Thin webs tear when a tool is pulled out and 4 mm is near the
   floor for most foam. Both numbers want a real cut to confirm and are
   unvalidated until then. Both are exposed and editable regardless, so a
   wrong default costs a field edit rather than a rebuild.
4. **Should a custom profile be exportable as a file, or is localStorage
   enough?** Recommend **localStorage only** for v1, matching the container
   library. A profile is half a dozen numbers; retyping it on a second
   machine is cheaper than building an import/export path and versioning it.
5. **What happens when a saved project's values match no known profile?**
   Recommend showing it as `Custom` with the values intact, and offering a
   one-click "save these as a profile". Never silently snap it to the nearest
   built-in.
6. **Toolbox layouts with multiple compartments.** Out of scope for v1, but
   the API should take a container *loop*, not a rectangle, so a compartmented
   tray is a later container change rather than a nester rewrite. Already
   reflected in the signature above.

## Decision needed

Sign-off to build steps 1 to 4, or a redirect. Nothing in this document has
been implemented.

## CHANGELOG
- v1.0 (2026-09-04): Initial draft for sign-off.
- v1.1 (2026-09-05): Replaced the single density-versus-spread objective with
  named packing profiles (Dense / Access), every value individually exposed
  and editable, plus user-saved custom profiles in a new
  `2p5d.packprofiles.v1` store. Established that a project saves resolved
  values with the profile name as provenance only, so editing a profile can
  never retroactively change a saved insert. Added label-aware packing:
  optional label footprints reserved during placement, and a per-gap
  effective web of `max(minWeb, textHeight + 2*textMargin)` so text size
  raises the web instead of being clipped. Notch reachability became
  profile-dependent, required under Access and a warning under Dense.
