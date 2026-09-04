---
file: printed_tile_registration_v1.0.md
version: 1.0
author: Sam Cao
created: 2026-09-04
last_updated: 2026-09-04
description: Design note on splitting printed STL inserts across a print bed with registration features that keep the tiles aligned.
ai_update: Update last_updated and version. Rename file to match. Append changelog at bottom.
---

# Design note: STL tiling of printed inserts

Status: **DESIGN NOTE — pre-decision, nothing built.** · 2026-09-04 ·
target branch `claude/2.5d-photo-stl-s3-y0oodn`

Not a PRD. This exists to surface the one real decision before anyone writes
a PRD, because that decision determines whether the feature is footprint work
or needs new mesh capability.

## The gap

Cut templates already tile. `splitTiles` splits the 2D template across a
laser bed, places seams where they cross the fewest pockets, and since
v1.23.0 can add puzzle-tab interlocks so the pieces lock together.

The **STL** does none of that. `buildLayoutInsert` extrudes the whole
container as one slab and, when it overruns the print bed, only warns. A
bench drawer insert is routinely wider than a 256 mm print bed, so the
common case for a *printed* insert is currently "export, discover it does not
fit, split it yourself in a slicer".

## What already carries over for free

The footprint half is solved. `splitTiles` returns tile loops in tile-local
mm, with clipped pocket and pillar loops per tile. Feeding each tile's
`slabs` and `holes` into `buildSolid` with the same thickness and per-pocket
depths produces one watertight solid per tile with no new geometry code.

So the mechanical work is: run the existing splitter, build N solids instead
of one, and export them. That part is small.

## The actual decision: how the tiles register

Printed tiles need to locate against each other and stay located. Four
candidates, and they are not equivalent in cost.

### A. Puzzle tabs in plan (reuse `knobLoop`)

The v1.23.0 interlock, unchanged in principle. Footprint-only, no new mesh
work, and it already handles the giving-tile bed deduction correctly.

**One thing flips, and it matters.** On a laser, kerf *removes* material, so
the socket is drawn undersize (`fit ≈ −0.2`) and the parts end up an
interference fit. A printer *adds* material: elephant foot on the first
layer, over-extrusion on external perimeters. The socket must be drawn
**oversize**, roughly `fit = +0.2` to `+0.4` depending on printer and
material. Shipping the laser default into a printed tile produces two parts
that will not go together at all.

Weakness: a printed tab is a thin vertical web loaded in bending across the
layer lines, which is the weakest direction in FDM. On a 5 mm floor with a
7 mm neck it will snap if the insert is picked up by one tile.

### B. Dowel pins in the mating faces

Strongest and most conventional. Also **out of reach without new mesh work**:
`buildSolid` cuts features on `face: 'top'` or `face: 'bottom'` only. A dowel
hole in a seam wall is a side-face feature, and nothing in the pipeline can
express one. This would need either genuine 3D boolean capability, which is
locked out of scope, or a new vertical-face feature path in `mesh.js`.

Recommend not pursuing this. It is the one option that breaks the no-CSG
constraint's spirit.

### C. Stepped half-lap seam

Tile A's lower half runs under tile B's upper half. The seam becomes a step
rather than a butt joint, so the tiles cannot lift relative to each other and
the glue area roughly doubles.

This is expressible without CSG: the slab is two stacked prisms with
different footprints, the same construction the Gridfinity base pads already
use. Tile A's lower layer extends past the seam by the lap length; its upper
layer stops at the seam. Tile B is the mirror. Each tile stays a single
watertight solid.

Stronger than A, and it prints flat with no thin vertical webs. Costs a
little more work than A because the split has to happen per z-layer rather
than once.

### D. Dovetail in plan

Same class as A, same weakness, marginally better against pull-apart and
worse against printing tolerance. No reason to prefer it over A.

## Recommendation

**C, with A as a fallback for thin inserts.** The half-lap is the right
default because it puts the joint in shear across a printed area instead of
bending across a thin web, and because it costs no new mesh capability. Below
roughly 6 mm total thickness a half-lap leaves each layer too thin to print
reliably, and puzzle tabs are the better answer there.

Either way the printed `fit` sign must be opposite the laser default, and
that should be a separate stored parameter rather than a reused one, so a
project that exports both a cut template and a printed insert does not have
to choose.

## Also unresolved

- **Z overrun.** The bed is three-dimensional. A tall holster or a deep
  toolbox insert can exceed bed height even when the footprint fits.
  Splitting in z is a genuinely different feature and should stay out.
  Minimum viable behaviour: keep warning, do not attempt it.
- **Export shape.** One STL per tile with `A1`/`B2` names matching the SVG
  convention, or one STL with separated bodies. Separate files are easier to
  slice and harder to lose track of. No strong opinion yet.
- **Seam placement objective changes.** For a cut template a seam through
  clear foam is merely cleaner. For a printed insert a seam through a pocket
  wall is a structural defect, so `planSeams` should probably weight pocket
  crossings much harder in printed mode. Same function, different weights.

## Decision needed

Which registration scheme, before a PRD gets written. Nothing here has been
implemented, and the recommendation above is a recommendation, not a default
I intend to act on.

## CHANGELOG
- v1.0 (2026-09-04): Initial design note.
