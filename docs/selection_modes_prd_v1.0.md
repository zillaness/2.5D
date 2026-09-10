---
file: selection_modes_prd_v1.0.md
version: 1.0
author: Sam Cao
created: 2026-09-10
last_updated: 2026-09-10
description: PRD for lasso, radius-brush, and directional box selection of trace points in the 2.5D trace editor.
ai_update: Update last_updated and version. Rename file to match. Append changelog at bottom.
---

# PRD: Trace-editor selection modes

Status: **DRAFT, awaiting sign-off. Nothing here is built.** · 2026-09-10 ·
target branch `claude/2.5d-photo-stl-s3-y0oodn`

Decisions Sam already made in chat on 2026-09-09 and 2026-09-10, carried in
here as settled: lasso yes, brush with an adjustable radius yes (circle select
folds into it), directional box applies to fillet arcs and not to straight
segments.

## Problem

A traced tool outline is several hundred points, and the cleanup tools (Fit
arc, Fit line, Straighten, Densify, Reduce, group move, Delete) all act on a
selection. Getting the right selection is the slow part. The only gestures
today are Ctrl/Cmd+click one point at a time, or a Shift+drag box.

A box is the wrong shape for almost every tool. The handle of a screwdriver is
a rounded rectangle at an angle; the jaw of a wrench is a crescent; the blade of
a chisel sits next to the ferrule with a few millimetres between them. A box
drawn around the handle catches the near end of the blade, and a box drawn
small enough to miss the blade misses the far corners of the handle. The user
ends up Ctrl-clicking the strays out one by one, which is the workflow the box
was supposed to replace.

### Current workflow being replaced

`js/ui/traceEditor.js` holds one multi-selection, `this.selectedVerts`, a list
of `{loop, idx}` references into the outline, holes, and region loops. Three
things write it:

- `_toggleVert` on Ctrl/Cmd+click (`_down`, line 984).
- `_applyMarquee` on Shift+drag release (line 1258): an axis-aligned screen
  rectangle, every vertex whose screen position is inside it. The drag
  direction is ignored. A box under 3 px in both axes is treated as a stray
  click.
- The cleanup tools themselves re-seed it after they rewrite a run
  (`fitArcToSelection`, `straightenSelection`, `densifySelection`).

Everything downstream consumes the same list: group drag (line 993 and the
`_groupDrag` block in `_move`), `_deleteVertGroup`, `_dragAnchors` for the
constraint solver, `_selectionSpan(n)` which turns the list into a contiguous
run for the arc and line tools, `_selectedArc` and `_selectedLine` which match
that span against the first-class arc and line entities, and
`refreshSelectionTools` in `js/main.js` (line 1279) which enables buttons and
shows the count. Escape clears it (`main.js` line 2615).

The one thing this PRD changes is **how a gesture resolves to that list**. The
list, its consumers, the undo model (selection is not undoable, edits are), and
the save format are untouched.

### What already exists, and is not being rebuilt

- `pointInPolygon` is imported in `traceEditor.js` and used for hole-loop hit
  tests. Lasso is the same test with the lasso as the polygon.
- `_mmToScreen` and `_screenToMm` give both spaces; all three gestures operate
  in screen space so a fixed-pixel brush radius feels the same at every zoom.
- Fillet arcs are first-class: `this.arcs` entries own a run `[lo, lo+len)` on
  a loop. Selecting an arc already means selecting its run, which is exactly
  what a crossing box needs to expand to.
- The marquee draw code (line 2082) and the pointer-event plumbing (`_down`,
  `_move`, `_up`) are the pattern each new gesture follows.
- Touch works through pointer events already; nothing here is mouse-only.

## Success criteria

1. **One gesture per shape.** A user can select all points of a screwdriver
   handle, and nothing of the blade, in a single drag, on a trace where a box
   cannot do that.
2. **Brush follows the cursor.** Dragging with the brush selects every point
   within the radius of any position the cursor passed through, not just the
   positions where a pointermove event fired. A fast swipe across a dense run
   catches the run.
3. **Direction means something, only where it can.** A left-to-right box
   selects what is enclosed. A right-to-left box also selects the whole run of
   any fillet arc it touches. Plain edges and managed straight lines are never
   selected by touch, per Sam's call.
4. **Add and subtract.** Any gesture can add to or remove from the existing
   selection, so a lasso around the handle followed by a brush-subtract along
   the ferrule is a legal two-step.
5. **Nothing downstream notices.** Fit arc, Straighten, group move, Delete,
   constraints, and Escape behave identically whether the selection came from
   a box, lasso, brush, or Ctrl-clicks. `selectedVerts` stays the interface.
6. **Tested without a mouse.** Each resolver is a method that takes a screen
   path and returns a vertex list, so `test/e2e.mjs` can drive it through
   `window.__app.traceEditor` the way Group B already drives `_hitCircle` and
   `fitArcToSelection`.

## Scope

### In

- Lasso: freehand closed region, drawn as the pointer moves, closed back to
  the start on release. Selects vertices inside.
- Brush: a circle of radius `r` px around the pointer; every vertex within `r`
  of the swept path (the polyline of pointer positions, tested per segment, not
  per sample) is selected. Radius adjustable in the UI and shown as a ring
  under the cursor while the tool is active.
- Directional box: the existing box gains a crossing variant when dragged
  right-to-left, which expands to the full run of any fillet arc whose run has
  at least one vertex inside the box or whose polyline crosses the box edge.
- A Select tool in the trace toolbar with a sub-mode picker (Box, Lasso,
  Brush) and a brush radius control. Shift+drag in plain Edit mode keeps
  working and uses the current sub-mode, so the existing muscle memory
  survives and the new modes are one click away.
- Add and subtract modifiers, consistent across sub-modes.
- Visual feedback while dragging for all three, matching the current marquee
  styling, with the crossing box tinted differently so its meaning is visible
  before release (the CAD convention is a dashed outline for crossing).
- Tests in `test/e2e.mjs` for each resolver, plus the interaction with arc
  runs and the add/subtract modifiers.
- README section and the in-panel hint text updated.

### Out

- Crossing selection of plain edges or managed straight lines (`this.lines`).
  Sam's call: segments no. Recorded as an open question in case it reverses.
- Selecting circles (screw holes) or labels with any of these gestures. They
  have their own single-selection model and are not in `selectedVerts`.
- A separate circle-select mode. It is the brush with a radius and no drag.
- Persisting sub-mode or brush radius across sessions. In-memory for v1.0; a
  localStorage key is a one-liner later if it turns out to matter.
- Undoable selection. Selection has never been on the undo stack and adding it
  would make Ctrl+Z surprising during cleanup.
- Any change to the layout editor (`js/ui/layoutEditor.js`). That editor
  selects placements, not points, and has no multi-select today.

## Constraints

- Single-file, fully client-side. New code lives in `js/ui/` and is picked up
  by `build.mjs` like every other module.
- Screen-space geometry only. No mesh, no save-format change.
- `selectedVerts` remains `[{loop, idx}]` with no duplicates. Resolvers must
  dedupe, since a brush path can pass a vertex twice.
- Existing bindings keep their meaning: right-click or Alt+click deletes a
  vertex, Ctrl/Cmd+click toggles, Shift+drag on empty space box-selects,
  Escape clears, Delete removes the group. The Select tool adds; it does not
  rebind.
- Performance floor: a resolver over a 2,000-vertex trace must finish inside
  one pointermove frame. Per-segment brush testing is O(V) per move event,
  which is fine at that size; no spatial index in v1.0.

## Design

### Gesture resolvers as pure methods

Three methods on the editor, each taking screen-space input and returning
`[{loop, idx}]` without touching state:

- `_verticesInRect({x0,y0,x1,y1})`, extracted from today's `_applyMarquee`.
- `_verticesInPolygon(pathPx)`, `pointInPolygon` against every vertex's screen
  position. Paths with fewer than 3 points or an absolute area under ~9 px²
  resolve to nothing, the lasso equivalent of the 3 px stray-click guard.
- `_verticesNearPath(pathPx, rPx)`, distance from each vertex to each segment
  of the path, selected when ≤ r. A single-sample path (a click with no drag)
  degenerates to distance-to-point, which is the circle select.

One shared iterator walks `outer`, every `holes[h]`, and every
`sections[s].pts` with the same loop indexing `_applyMarquee` uses today
(`-1`, `h`, `REGION_LOOP_BASE + s`), so a new loop kind only has to be added
in one place.

A fourth helper, `_expandToArcRuns(list, rect)`, is the crossing rule: for
each arc in `this.arcs`, if any vertex of its run is in `list`, or any segment
of its run intersects a rect edge, add the whole run. It is applied only by the
crossing box. Lasso and brush do not expand: an organic gesture that clips one
end of a fillet and silently grabs the other end would be the box's failure
mode all over again.

### Applying a result

`_applySelection(list, mode)` with `mode` in `replace | add | subtract` is the
only writer. It dedupes by `loop:idx`, sets `this.selection = null` (a
multi-selection and a single selection are exclusive today and stay so), and
calls `_notifySelect` so `refreshSelectionTools` repaints.

Modifier mapping, identical for all three sub-modes while the Select tool is
active:

| gesture | result |
|---|---|
| drag | replace |
| Shift+drag | add |
| Alt+drag | subtract |

Alt on pointerdown currently deletes a vertex under the cursor in Edit mode.
In the Select tool that branch is skipped, since the tool's whole job is
selecting; deletion is still Delete on the group or a right-click in Edit
mode. In plain Edit mode, Shift+drag on empty space keeps its current meaning
(replace, using the current sub-mode) because that is what every existing hint
and README line says it does.

### Directional box

Direction is read from the sign of `x1 - x0` on release, not during the drag,
so a user who overshoots and comes back gets the direction they ended with.
Left-to-right is window (today's behaviour). Right-to-left is crossing:
`_verticesInRect` then `_expandToArcRuns`. Vertical direction is ignored.

The draw code tints the two differently so the meaning is legible before
release: window keeps the solid blue fill and dashed stroke it has now;
crossing uses a green stroke with a longer dash. Colours are the only
difference; the geometry drawn is the same rectangle.

### Brush

Radius lives on the editor as `this.brushRadiusPx`, default 12, range 4 to 60,
set from a slider in the Select panel and shown in the panel as a number. The
ring is drawn at the cursor whenever the Brush sub-mode is active, even before
a drag starts, because the user needs to size it against the trace. During a
drag the ring follows the pointer and the swept path is stroked at width `2r`
with the same translucent blue as the marquee fill, so the covered area reads
as a painted stripe.

Screen-space radius, not mm, because the trace is edited at whatever zoom
makes the detail visible and a mm brush would need re-sizing at every zoom.

Sample density: every pointermove position is appended to the path; the
resolver tests segments between consecutive samples, so a fast swipe still
covers the gap between events (success criterion 2).

### Lasso

The path is the list of pointermove positions. Drawn as a polyline with the
marquee's stroke style and a translucent fill of the polygon so far, with a
faint dashed closing segment back to the start. On release the polygon is
closed and resolved. Below 3 points or the area guard, nothing changes, which
also means a plain click in Lasso mode on empty space clears nothing and
starts a pan, same as Edit mode.

### Select tool in the toolbar

`traceEditor.mode` gains `'select'`. The toolbar button row in `index.html`
already switches modes through `data-tool` (`main.js` line 2044), so it is one
more button. The Selection panel that exists today (`#selCount`, the Fit/
Straighten/Densify rows) gains a sub-mode segmented control (Box, Lasso, Brush)
and the radius slider, shown only when Brush is active. Hint text becomes:

> Drag to select points. Box: left-to-right takes what is enclosed,
> right-to-left also takes any arc it touches. Lasso: draw around them.
> Brush: paint over them. Shift adds, Alt removes, Escape clears.

Cursor: `crosshair` for Box and Lasso, `none` for Brush since the ring is the
cursor.

### Interaction with the cleanup tools

`_selectionSpan(n)` requires a contiguous run on one loop and the arc/line
tools stay disabled otherwise, so a lasso that grabs two separate runs gets
group move and Delete but not Fit arc. That is the right behaviour and is
already what Ctrl-click produces; nothing new to build. Densify and Reduce
already handle multiple runs through `_selectionRuns`, and the brush is the
natural way to feed them.

## Plan

Each step is one commit, each ends with `node test/e2e.mjs` green and the
suite's own printed total in the message.

1. **Extract resolvers.** Move today's `_applyMarquee` body into
   `_verticesInRect` and the shared loop iterator; add `_applySelection` and
   route the existing Shift+drag through it. Zero behaviour change. Tests:
   the Group B cases still pass, plus one new check that `_verticesInRect` on
   the square fixture returns exactly the enclosed corners.
2. **Lasso.** `_verticesInPolygon`, the lasso gesture state (`_lasso` path),
   its draw, and its `_up` handling. Tests: a lasso drawn as a triangle around
   two of four square corners returns those two; a lasso under the area guard
   returns nothing; a concave lasso (a C shape) excludes the point in its
   mouth.
3. **Brush.** `_verticesNearPath`, `brushRadiusPx`, the ring and stripe draw,
   the gesture state (`_brush` path). Tests: a two-sample path along the top
   edge of the square at r = 3 px selects its two endpoints and not the bottom
   corners; the same path with samples 200 px apart still selects a vertex
   lying between them (the segment test, not the sample test); a zero-length
   path is a circle select.
4. **Directional box and arc expansion.** Direction read on release,
   `_expandToArcRuns`, the crossing tint. Tests: on the Group B arc fixture
   (five-point run fitted to an arc), a right-to-left box covering one vertex
   of the run selects all five; the same box left-to-right selects one; a
   right-to-left box touching only a plain edge selects nothing.
5. **Modifiers.** Shift add and Alt subtract through `_applySelection`,
   plus skipping the Alt-delete branch in Select mode. Tests: lasso replace
   then brush add is the union; then Alt-lasso is the difference; no
   duplicates after overlapping gestures.
6. **Select tool and panel.** The toolbar button, `mode = 'select'`, sub-mode
   control, radius slider, cursor handling, hint text. Shift+drag in Edit
   mode uses the current sub-mode. Test: `setMode('select')` plus a driven
   drag through the public pointer path resolves through the current
   sub-mode; `refreshSelectionTools` shows the count.
7. **Docs.** README trace-editing section and this PRD's status line.

Steps 2, 3, and 4 are independent of each other and only depend on step 1.
Step 5 depends on all three. That shape suits an ultracode run: one agent per
step 2 through 4 in worktrees off the step 1 commit, an adversarial verify
pass on each, then 5 through 7 in sequence.

## Open questions (recommendation first)

1. **Should a crossing box also expand managed straight lines** (the
   `this.lines` entities left by Straighten)? Recommendation: no, per Sam's
   "segments probably not", and because a straight line is two points that a
   window box already catches. Revisit only if it comes up in use.
2. **Should lasso and brush expand arc runs the way the crossing box does?**
   Recommendation: no. The point of an organic gesture is precision; silently
   grabbing the unseen end of a fillet defeats it. If half an arc is selected
   the arc tools stay disabled, which is a visible and honest outcome.
3. **Brush radius in px or mm?** Recommendation: px, argued above. If a user
   wants "everything within 2 mm of this edge" that is a different tool
   (offset select) and not in scope.
4. **Does the Select tool replace Shift+drag in Edit mode, or sit beside it?**
   Recommendation: beside. Removing Shift+drag would break the README and the
   panel hint and gain nothing.
5. **Shift for add versus Ctrl for add.** Most CAD uses Shift to add and
   Ctrl to toggle; the editor already uses Ctrl/Cmd+click to toggle a single
   vertex, so Shift+drag = add keeps the two consistent. Alt for subtract is
   the common third; the Alt-delete conflict is handled by mode.

## Decision needed

Sign-off on the scope and the seven-step plan, and answers to open questions 1
and 2, which are the only two that change what gets built rather than a
default. Once signed, this is the unit for the Opus + ultracode session.

## CHANGELOG
- v1.0 (2026-09-10): Initial draft from the 2026-09-09 chat decisions (lasso yes, radius brush yes, directional box for arcs not segments). Written without em dashes per Sam's style guide; the repo's older docs use them and that conflict is still open in BURNDOWN.md.
