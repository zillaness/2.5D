---
file: labelling_prd_v1.0.md
version: 1.0
author: Sam Cao
created: 2026-09-05
last_updated: 2026-09-05
description: PRD for labelling tools in 2.5D drawer and toolbox layouts, seeded from trace names and engraved or embossed per cutting process.
ai_update: Update last_updated and version. Rename file to match. Append changelog at bottom.
---

# PRD: Tool labelling on layouts

Status: **DRAFT — awaiting sign-off. Nothing here is built.** · 2026-09-05 ·
target branch `claude/2.5d-photo-stl-s3-y0oodn`

## Problem

An unlabelled foam insert tells you a tool is missing but not which tool. For
a set of eight combination wrenches that is the entire problem: eight similar
pockets, no way to know whether the 13 mm or the 14 mm is the one in someone
else's pocket. Labelling the sizes is what turns a foam insert into a shadow
board.

### Current workflow being replaced

There is no workflow. Layouts have no labels at all. To get a labelled insert
today you export the cut template SVG, open it in Inkscape, and add text by
hand on a layer your laser will treat as engrave, re-doing it every time the
layout changes.

### What already exists, and is not being rebuilt

The part-labelling feature (v1.10.0) is complete and good. All of it is
reusable:

- `js/text.js` rasterises a string through a platform font and returns glyph
  loops via marching squares, counters included. `labelLoops(text, cx, cy,
  heightMm, opts)` returns mm polygon loops centred at a point at an exact cap
  height, with `opts.rot` accepting any angle and `opts.mirror` for stamps or
  bottom-face reads. `labelBounds(loops)` gives the box.
- `state.labels` entries are `{ text, x, y, height, rot, mirror, face, mode,
  depth, font }`. New labels inherit the previous one's styling
  (`js/main.js:163`), so a row of tags is one setup rather than ten.
- The trace editor has a full `label` mode: click empty space to add, drag to
  move, a round handle to rotate (`js/ui/traceEditor.js:592` onward).
- `labelsForMesh()` (`js/main.js:732`) adapts state into the `labels` array
  that `buildSolid` already consumes, and labels persist in projects
  (`:2704` save, `:2749` load).

So this document is about **wiring an existing feature into the layout path**,
not building a new one.

## Success criteria

1. **Seeded, not retyped.** Every placed item's label defaults to its library
   trace name, with no typing required to get a usable labelled insert.
2. **Editable without side effects.** Editing a placed item's label changes
   that placement only. It never renames the library entry, and never changes
   another placement of the same tool.
3. **Correct per process.** A laser or router cut template carries labels as
   vector outlines on the ENGRAVE-equivalent layer, requiring no font on the
   machine. A printed insert carries them as `buildSolid` labels.
4. **Never illegible by accident.** A label below the minimum legible height
   for the selected process warns, with the reason and the governing number,
   rather than silently emitting mush.
5. **Never overlapping.** A label collides with no pocket, no other label, and
   no container border, or it is refused with a stated reason.
6. **Optional.** Labelling is off by default. An unlabelled layout produces
   byte-identical output to today's.
7. **Persisted additively.** Existing projects load unchanged, and a project
   saved with labels loads correctly in a build that has this feature.

## Scope

### In

- A per-item `label` field, defaulting to the item's `name`, editable in the
  layout editor's selection panel.
- Free-floating layout labels as well, for things that belong to the drawer
  rather than a tool: "TOP DRAWER", "FRONT", a date.
- Auto-placement beside each pocket, with manual drag and rotate, reusing the
  trace editor's label interaction model.
- **Process-aware sizing.** A `markingProcess` setting (laser, router,
  printed) and, for router, a marking-tool diameter, deriving a minimum
  legible cap height.
- Cut-template export: label outlines on the `marks` layer.
- Printed insert export: labels through `buildSolid`'s existing `labels` path.
- The footprint hooks the nesting PRD needs (`labelBounds` per item).

### Out

- **Pocket-floor engraving on printed inserts.** `buildSolid` resolves a
  label to a *region* and carves from that region's top or bottom face
  (`js/mesh.js:984-1005`). A pocket recess is not a region, so a label over a
  pocket would try to carve from the slab top where the pocket already is.
  Shadow-board labels inside the pocket need new mesh capability and are a
  separate piece of work. Labels beside pockets work today.
- Single-line / stick fonts. Outline fonts only for v1. See open questions.
- Automatic abbreviation of long names. A name that does not fit is reported,
  not silently truncated.
- Any change to the existing part-label feature.

## Constraints

- Single-file, fully client-side, no server, no user-facing build step.
- No 3D CSG. Labels are footprint work plus the existing recess machinery.
- Save-format keys stay stable. `item.label`, the layout label array and the
  process settings are new additive fields. Absent fields fall back to
  today's behaviour.
- `js/text.js` uses a canvas and `measureText`, so glyph shapes depend on the
  viewer's platform fonts. A label generated on one machine may differ
  slightly on another. This is already true of part labels and is accepted;
  the exported outlines are what matters and they are baked at export time.

## Design

### Label ownership

Two kinds, deliberately:

- **Item labels** belong to a placement. They move and rotate with the tool,
  so nesting or dragging a tool takes its label along. `item.label` is a
  string defaulting to `item.name`; the rest of the styling lives on the
  layout so a drawer's labels stay consistent.
- **Layout labels** are free-floating and belong to the container. Same object
  shape as `state.labels`, placed in layout space.

Item labels are the answer to "which wrench is missing". Layout labels are the
answer to "which drawer is this".

### Why `item.label` is separate from `item.name`

`item.name` comes from the library entry. If editing the label wrote back to
the library, renaming a wrench in one drawer would rename it in every drawer
that used it. So the label is its own field that merely *defaults* to the
name. The UI should show when they have diverged, and offer a one-click reset
back to the name.

### Placement

Auto-place at the pocket's bounding-box centre, offset outward to the widest
adjacent gap, at the layout's default cap height. Then:

- Drag and rotate exactly as the trace editor does today.
- A per-label `follow` flag: rotate with the tool, or stay horizontal. Default
  horizontal, because a drawer is read from one side. Under the nesting PRD's
  Access profile rotation is restricted to 90° steps and both behave sanely;
  under Dense, horizontal is the only readable option.
- Auto-placement is a starting point, never a lock. Manual position wins and
  survives re-nesting.

### Process awareness

The minimum legible cap height is not a style preference, it is a physical
property of the machine:

| Process | Minimum cap height | Notes |
|---|---|---|
| Laser | ~2 mm | Kerf is fine enough that outline fonts read at small sizes |
| Router | ~4x the marking tool diameter | A 3.175 mm bit cannot render a 4 mm letter. Outline fonts must be *filled*, which is slow and coarse |
| Printed | ~3x nozzle, and >= 2 layers deep | Deboss depth from the existing label `depth` field |

The router case is the one that bites. A 1/8" bit tracing an outline font
produces letters whose strokes are wider than the counters, so an `8` becomes
a blob. v1 warns and reports the governing number rather than pretending
otherwise. Single-line fonts are the real fix and are an open question below.

### Export paths

**Laser and router (`toTiledSVG`).** `js/exporters.js:189` already builds a
`cut` layer and a `marks` layer, and the file's own header says the marks
layer is "labels + seam edges (engrave or ignore)". Tool labels go there, as
**path outlines from `labelLoops`, not `<text>` elements**, so the machine
needs no font. The existing `<text>` tile IDs (`A1`, `B2`) stay as text, since
those are for the human breaking down the sheet, not the machine. Worth a
third layer, or at minimum a distinct group id, so engrave and reference marks
can be separated in the machine's software.

**Printed (`buildLayoutInsert`).** Build a `labels` array in the same shape
`labelsForMesh()` produces and pass it through to `buildSolid`, which already
handles resolution, single-shell carving and per-label depth. This is close to
a one-line change on the call site plus an adapter.

### Interaction with nesting

Specified from the other side already in `docs/nesting_prd_v1.1.md`: under
`labelSpace: reserve`, a label's `labelBounds` box grown by a margin is unioned
into the item's packed shape, and the effective web becomes
`max(minWeb, textHeight + 2*textMargin)` computed per gap. This document owns
producing the box; that one owns packing it.

The ordering dependency runs one way. Labelling can ship without nesting, with
auto-placement finding whatever gap exists. Nesting cannot reserve label space
without this.

## Plan

1. **`item.label` plumbing**: field, default-from-name, an input replacing the
   static `<p id="laySelName">` (`index.html:884`), reset-to-name, persistence.
   No geometry yet.
2. **`layoutLabelGeometry()`** in `js/holders.js`: item labels plus layout
   labels resolved to placed mm loops. Pure, testable, no UI.
3. **Collision + legibility checks**: label against pocket, label against
   label, label against border, and the per-process minimum height. Returns
   reasons, does not throw.
4. **Cut template export**: outlines on the marks layer, with a test asserting
   a labelled export contains path data and an unlabelled one is unchanged.
5. **Printed export**: adapter into `buildSolid`'s labels, with a
   watertightness test on a labelled insert.
6. **Auto-placement + drag/rotate UI**, reusing the trace editor's model.
7. **Process settings** and the warnings surface.

Steps 1 to 5 are the feature. 6 and 7 make it pleasant.

## Open questions (recommendation first)

1. **Single-line fonts for routers.** Recommend **deferring to v1.1** but
   designing `labelLoops`' call site so a stroke-path source can be swapped in
   without touching callers. Outline fonts genuinely do not work on a router
   below about 12 mm caps, so this is the difference between "labelling works
   on the CNC" and "labelling is a laser feature". Deferring is a real cost,
   not a free one.
2. **Default cap height.** Recommend **6 mm**. Legible across a drawer, small
   enough to sit in an 8 mm web under the Access profile, and above the laser
   minimum with margin.
3. **Should labels be on by default once a name exists?** Recommend **no**,
   off by default, one checkbox to turn on for the whole layout. Criterion 6
   depends on it: an unlabelled layout must produce identical output to today.
4. **Engrave layer separation in the SVG.** Recommend a **third layer**
   (`engrave`) distinct from `marks`, so tool labels can be sent to the
   machine while tile IDs and seam lines are ignored. This changes the
   exported file's layer set, which is a visible change to anyone with an
   existing workflow, so it wants a yes rather than an assumption.
5. **What happens to a label whose text does not fit anywhere?** Recommend
   reporting it in the layout warnings and drawing it in the editor in the
   warning colour, leaving it placed but flagged. Never auto-shrink below the
   process minimum and never truncate.

## Decision needed

Sign-off to build steps 1 to 5, and answers to open questions 1 and 4, which
are the two that change the shape of the work rather than a default.

## CHANGELOG
- v1.0 (2026-09-05): Initial draft for sign-off.
