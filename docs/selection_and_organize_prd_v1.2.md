---
file: selection_and_organize_prd_v1.2.md
version: 1.2
author: Sam Cao
created: 2026-09-10
last_updated: 2026-09-10
description: PRD for trace-editor selection modes, a new Step 4 Organize with folder access and container scaling, laser-cut foam constructions, and build instructions for an ultracode session.
ai_update: Update last_updated and version. Rename file to match. Append changelog at bottom.
---

# PRD: Selection modes and Step 4 Organize

Status: **DRAFT, awaiting sign-off. Nothing here is built.** · 2026-09-10 ·
target branch `claude/2.5d-photo-stl-s3-y0oodn`

This document is the unit for the next session, which Sam intends to run on
Opus with ultracode. It has four parts:

- **Part A, selection modes.** Lasso, radius brush, and a directional box in
  the trace editor. Decisions already made in chat: lasso yes, brush with an
  adjustable radius yes (circle select folds into it), directional box applies
  to fillet arcs and circles, not to straight segments.
- **Part B, Step 4 Organize.** A fourth top-level step after Model & export
  where a drawer or toolbox is laid out from the outline library or from a
  folder of trace files on disk. Today the drawer layout is a modal buried in
  Step 3's holder options and gated on having traced something first.
- **Part C, build instructions.** How the next session should run: session
  start, lanes, workflow scripts, verification, commit discipline, and the
  version bump and deploy at the end.
- **Part D, laser-cut foam constructions.** Through-cut single sheets and a
  two-layer build with a contrast base, since most of Sam's foam will be
  laser cut rather than routed.

Parts A, B, and D touch different files (`js/ui/traceEditor.js`; `js/main.js`
and `index.html` and a new import module; `js/holders.js` and the exporters)
and are independent. Part C depends on all three being signed off.

---

## Part A: Trace-editor selection modes

### Problem

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

#### Current workflow being replaced

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

#### What already exists, and is not being rebuilt

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

### Success criteria

1. **One gesture per shape.** A user can select all points of a screwdriver
   handle, and nothing of the blade, in a single drag, on a trace where a box
   cannot do that.
2. **Brush follows the cursor.** Dragging with the brush selects every point
   within the radius of any position the cursor passed through, not just the
   positions where a pointermove event fired. A fast swipe across a dense run
   catches the run.
3. **Direction means something, only where it can.** A left-to-right box
   selects what is enclosed. A right-to-left box also selects the whole run of
   any fillet arc it touches and any circle it touches. Plain edges and
   managed straight lines are never selected by touch, per Sam's call.
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

### Scope

#### In

- Lasso: freehand closed region, drawn as the pointer moves, closed back to
  the start on release. Selects vertices inside.
- Brush: a circle of radius `r` px around the pointer; every vertex within `r`
  of the swept path (the polyline of pointer positions, tested per segment, not
  per sample) is selected. Radius adjustable in the UI and shown as a ring
  under the cursor while the tool is active.
- Directional box: the existing box gains a crossing variant when dragged
  right-to-left, which expands to the full run of any fillet arc whose run has
  at least one vertex inside the box or whose polyline crosses the box edge,
  and takes any circle whose rim the box touches. A window box takes a circle
  only when its whole disc is enclosed.
- Circles in the multi-selection. A new `selectedCircles` list of circle
  indices beside `selectedVerts`. Group move, Delete, Escape, and the count
  readout cover both lists; the arc and line tools stay vertex-only. Lasso
  takes a circle whose centre is inside; brush takes one whose rim or centre
  is within the radius.
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

#### Out

- Crossing selection of plain edges or managed straight lines (`this.lines`).
  Sam's call: segments no. Recorded as an open question in case it reverses.
- Selecting labels with any of these gestures. They keep their own
  single-selection model in label mode.
- A separate circle-select mode. It is the brush with a radius and no drag.
- Persisting sub-mode or brush radius across sessions. In-memory for v1.0; a
  localStorage key is a one-liner later if it turns out to matter.
- Undoable selection. Selection has never been on the undo stack and adding it
  would make Ctrl+Z surprising during cleanup.
- Any change to the layout editor (`js/ui/layoutEditor.js`). That editor
  selects placements, not points, and has no multi-select today.

### Constraints

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

### Design

#### Gesture resolvers as pure methods

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
crossing box. A fifth, `_circlesInGesture(kind, geom)`, returns circle indices
for each gesture: window box requires the whole disc inside, crossing box
accepts a rim intersection, lasso tests the centre, brush tests distance to
the rim or centre. Lasso and brush do not expand: an organic gesture that clips one
end of a fillet and silently grabs the other end would be the box's failure
mode all over again.

#### Applying a result

`_applySelection({ verts, circles }, mode)` with `mode` in `replace | add |
subtract` is the only writer. It dedupes by `loop:idx`, sets `this.selection = null` (a
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

#### Directional box

Direction is read from the sign of `x1 - x0` on release, not during the drag,
so a user who overshoots and comes back gets the direction they ended with.
Left-to-right is window (today's behaviour). Right-to-left is crossing:
`_verticesInRect` then `_expandToArcRuns`. Vertical direction is ignored.

The draw code tints the two differently so the meaning is legible before
release: window keeps the solid blue fill and dashed stroke it has now;
crossing uses a green stroke with a longer dash. Colours are the only
difference; the geometry drawn is the same rectangle.

#### Brush

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

#### Lasso

The path is the list of pointermove positions. Drawn as a polyline with the
marquee's stroke style and a translucent fill of the polygon so far, with a
faint dashed closing segment back to the start. On release the polygon is
closed and resolved. Below 3 points or the area guard, nothing changes, which
also means a plain click in Lasso mode on empty space clears nothing and
starts a pan, same as Edit mode.

#### Select tool in the toolbar

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

#### Interaction with the cleanup tools

`_selectionSpan(n)` requires a contiguous run on one loop and the arc/line
tools stay disabled otherwise, so a lasso that grabs two separate runs gets
group move and Delete but not Fit arc. That is the right behaviour and is
already what Ctrl-click produces; nothing new to build. Densify and Reduce
already handle multiple runs through `_selectionRuns`, and the brush is the
natural way to feed them.

### Plan

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
4. **Directional box, arc expansion, and circles.** Direction read on
   release, `_expandToArcRuns`, `_circlesInGesture`, `selectedCircles` with
   group move and Delete, the crossing tint. Tests: on the Group B arc
   fixture (five-point run fitted to an arc), a right-to-left box covering
   one vertex of the run selects all five; the same box left-to-right selects
   one; a right-to-left box touching only a plain edge selects nothing; a
   window box clipping a circle's rim does not select it while a crossing box
   does; group move shifts a selected circle's centre with the vertices.
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

Steps 2, 3, and 4 are logically independent and only depend on step 1, but
all three edit the same pointer handlers and draw method in
`traceEditor.js`, so Part C runs them in sequence inside one lane rather than
as parallel agents. Step 5 depends on all three.

### Open questions (recommendation first)

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

---

## Part B: Step 4 Organize

### Problem

Laying out a drawer is a different job from tracing a tool, and the app
currently hides it inside the tool job. To organize a drawer today you must:

1. Have a traced outline in Step 2, because Step 3 is disabled until
   `traceEditor.outer` has three points (`js/main.js` line 271).
2. Go to Step 3, choose "Drawer insert" from the holder type select, which
   opens `#layoutModal` (`openLayoutModal`, `main.js` line 1419).
3. Add tools one at a time from the outline library select, which reads the
   `2p5d.library.v1` localStorage key.

Three things are wrong with that. A drawer of twelve tools that were traced
last month needs no new trace, yet the step gate demands one. The layout
editor is a modal over the model step, so the 3D preview, the export buttons,
and the layout are never on screen together. And the library lives in one
browser's localStorage: trace on the shop laptop and the drawer cannot be laid
out on the office machine, and a folder of trace files on disk, which is how
anyone would actually keep a tool collection, cannot be opened at all.

Sam's framing: after Step 3 export, Step 4 is the drawer or toolbox
organization, and on that step you can open a folder filled with traces, and
all the traces within the folder are what you are organizing.

To be clear about what exists: the organize functionality Sam asked for in
the holders roadmap is built and shipped (v1.11 to v1.23: the multi-tool
drawer insert, per-tool depths, tiling, puzzle tabs, labels). Part B changes
where it lives and where its tools come from, not what it does.

#### Current workflow being replaced

- Holder type `layout` under Step 3 opens the modal; closing the modal keeps
  the layout in `state.layout` and the holder mesh rebuilds from it
  (`rebuildHolder`, `main.js` line 1105).
- `state.layout.items[]` entries are self-contained copies: `{ name, outer,
  holes, circles, thickness, depth, rot, x, y }` plus the label fields added
  in v1.23 (`main.js` line 1638). Nothing references the library by index
  after placement, which is why editing a placed label never renames the
  library entry.
- Library entries (`libSaveBtn` handler, `main.js` line 3120 onward) carry
  `{ name, kind, thickness, outer, holes, circles, measurements, constraints,
  arcs, lines }`, origin-normalised to a 5 mm margin.
- Project files are JSON with `app: '2.5D', version: 1` and carry `trace`,
  `arcs`, `lines`, `regions` (so `regions[0].thickness`), `layout`, and
  `holder` (`serializeProject`, `main.js` line 2812).
- Export of the holder mesh and cut templates lives in Step 3 and calls the
  exporters with `state.holderMesh` and the layout's tiles.

#### What already exists, and is not being rebuilt

- The layout editor (`js/ui/layoutEditor.js`), conflicts readout, labels,
  bed tiling, puzzle tabs, and all of `js/holders.js`. Part B moves where
  they are reached, not what they do.
- The nesting PRD (`docs/nesting_prd_v1.1.md`) already asks for an explicit
  "Nest" button rather than auto-run. That button belongs on Step 4.
- The project file reader (`loadProject`) already validates `app: '2.5D'`
  and reads a trace. The folder reader reuses its field knowledge without
  loading anything into the editor.
- `js/import/` already holds the DXF and SVG importers, so a trace-file
  reader has a home.

### Success criteria

1. **No trace required.** Step 4 is reachable from a fresh page load with
   nothing photographed, and a drawer can be laid out entirely from the
   library or a folder.
2. **Folder in, drawer out.** Opening a folder of 2.5D project files puts
   every readable trace in the palette, and one action places them all in
   the layout. Files that are not traces are skipped and counted, never an
   error.
3. **Works everywhere, best on GitHub Pages.** Sam launches the hosted copy
   almost always, so on Chrome and Edge over https the folder is opened with
   the File System Access API: it is remembered across reloads and projects
   can be saved back into it. Firefox, Safari, and the offline `file://`
   build fall back to the directory input, which reads once and cannot
   write. Both paths feed the same reader.
4. **Self-contained projects.** A saved project of a folder-sourced drawer
   reopens on a machine without the folder. Provenance is recorded; nothing
   is referenced.
5. **Nothing moves under the user.** Step 3's "Drawer insert" holder type
   still works: it navigates to Step 4 instead of opening a modal. Every
   layout control keeps its id, so the labelling and nesting work land on
   the same elements.
6. **Export from where you are.** STL, SVG, and tiled SVG export of the
   layout are on Step 4, driven by the same functions Step 3 uses.

### Scope

#### In

- A fourth step button, `stepBtn4` "Organize", enabled unconditionally.
- Step 4 panel containing what `#layoutModal` holds today, inline instead
  of overlaid, with the 3D preview visible beside it. The modal element is
  removed once its children are reparented; ids are preserved.
- Holder type `layout` on Step 3 becomes a shortcut that switches to Step 4.
  The holder select keeps the option so existing projects load unchanged.
- An export row on Step 4: STL of the insert, cut template SVG, tiled SVG
  when a bed is set. Same code paths as Step 3.
- "Open folder…" with two backends behind one button. Where
  `window.showDirectoryPicker` exists (Chrome and Edge on https) it is used,
  the handle is stored in IndexedDB under `2p5d.folder.v1`, and on the next
  load the palette offers "Reopen <folder>" which re-requests permission.
  Elsewhere, `<input type="file" webkitdirectory multiple>`. A pure reader,
  `tracesFromFiles(files)` in `js/import/traceFolder.js`, takes a list of
  `{ path, file }` from either backend and returns `{ entries, skipped }`.
- "Save project to folder" when the folder came from the File System Access
  backend: writes the current project JSON into the folder through the
  handle, so the drawer lives next to its traces. Accepted inputs: a 2.5D project JSON
  (`app === '2.5D'` with `trace.outer` of at least 3 points) and a library
  export JSON (an array of library entries). Everything else is skipped.
- Palette entries from a folder carry `source: { kind: 'folder', path }`
  where `path` is the file's `webkitRelativePath`. Names come from the
  project's `fileName` if present, else the file name without extension.
  Duplicates by name are kept and disambiguated by path in the palette.
- Palette UI on Step 4 with two groups, Library and Folder. Per-entry Add,
  plus "Add all from folder" and "Save to library" for a folder entry.
- Thickness for a folder entry comes from `regions[0].thickness` of a
  project file or `thickness` of a library entry, falling back to the
  current default the way library adds do today.
- `state.layout.items[]` gains an optional `source` field, additive.
- **Photos inside traces.** Each palette entry that came from a project file
  carries a thumbnail: the rectified photo cropped to the outline's bounding
  box, downscaled to 256 px on the long side, stored as a JPEG data URL in
  `thumb` with its mm-per-pixel. The layout editor draws it clipped to the
  outline, rotated with the item, under the pocket stroke, so the drawer
  reads as the tools rather than as silhouettes. Library entries gain the
  same field when saved from a project that has a rectified image.
- **Bed as a build plate.** The bed gains a shape (rectangle, or a saved
  container-kind outline, for a round or cut-cornered plate), a visible
  outline in the layout editor, an Auto-centre button that centres the
  layout on the bed when it fits on one tile, and drag plus arrow-key
  nudge (1 mm, Shift 10 mm) of the bed window over the layout when it does
  not. Seam positions follow the window.
- README: the 3-step table becomes 4 steps; a Step 4 section describes the
  folder workflow. Screenshot placeholders for Sam to fill.

#### Out

- Persisting the folder across reloads on the directory-input backend.
  There is no handle to keep; open the folder again.
- Writing anything other than project JSON into the folder.
- Thumbnails in the 3D preview. The 2D layout editor is where placement
  happens; the 3D view stays geometry.
- Non-rectangular tiling. A shaped bed clips the single-tile case and warns
  when the layout does not fit its inscribed rectangle; multi-tile layouts
  still tile against the bed's bounding rectangle.
- Reading STL, DXF, or SVG from the folder. The folder reader accepts traces
  in the app's own formats; CAD import stays a Step 2 action per file.
- Nesting itself. It stays in its own PRD; Part B only gives it a home.
- Any change to `js/holders.js` or the exporters.

### Constraints

- Single-file, fully client-side. The directory input is the baseline
  because it works from a `file://` URL in every desktop browser; the File
  System Access backend is feature-detected and never required. On mobile
  the input degrades to a multi-file picker, which is acceptable.
- Save format: `state.layout.items[].source` is the only new field and is
  optional. Projects without it load as before.
- Element ids inside the layout panel do not change. `test/e2e.mjs` drives
  the layout through `window.__app.layoutEditor`, `refreshLayoutEditor`, and
  the `lay*` inputs, and the labelling and nesting PRDs name those ids.
- No module-level `Date.now()` or randomness in the reader, so tests are
  deterministic.

### Design

#### Step 4 as a peer of the other three

`setStep(n)` (`main.js` line 243) already toggles panels by number; adding a
fourth panel and button is mechanical. The one real change is gating:
`stepBtn4.disabled` is never set, unlike buttons 2 and 3. A visit to Step 4
with an empty layout shows the container controls, the palette, and a
prompt: "Add tools from your library, or open a folder of traces."

The holder type select on Step 3 keeps `layout` as an option for backwards
compatibility, and choosing it calls `setStep(4)`. The holder mesh still
rebuilds from `state.layout` so the 3D preview on both steps shows the
insert. Nothing about `state.holder.type` changes meaning.

#### The folder reader

```
tracesFromFiles(files: FileList | File[]) -> Promise<{
  entries: [{ name, kind:'tool', thickness, outer, holes, circles,
              arcs, lines, source:{ kind:'folder', path } }],
  skipped: [{ path, reason }]
}>
```

Per file: skip unless the extension is `.json`; read as text; `JSON.parse`
inside try; classify. A project is `p.app === '2.5D' && p.trace?.outer?.length
>= 3`. A library export is an array whose entries have `outer` and `name`.
Anything else is skipped with a one-word reason (`not-json`, `not-a-trace`,
`parse-error`, `container`). Container-kind library entries are skipped from
the tool palette but reported, so a saved drawer outline in the folder is
not silently lost; a follow-on can offer it as the container.

Entries are origin-normalised exactly like `libSaveBtn` does (5 mm margin),
with `arcs` and `lines` carried across since they are index-based and
survive the shift. Reading is sequential to keep memory flat on a folder of
hundreds of files; a progress count updates the palette header.

#### Two folder backends

| | Directory input | File System Access |
|---|---|---|
| Browsers | all desktop, `file://` included | Chrome, Edge, https only |
| What you get | a one-shot `FileList`, every file already read | a `FileSystemDirectoryHandle` |
| Re-scan | open the folder again | call `values()` on the stored handle |
| Across reloads | nothing kept | handle in IndexedDB, one permission prompt to reuse |
| Write back | impossible | `getFileHandle(name, { create: true })` then write |

The reader is written against `{ path, file }` pairs so it does not know
which backend produced them. The File System Access backend walks the
handle recursively to build the same list. Persistence is the handle only;
file contents are read fresh on every open.

#### Container from a photo, and scaling it

Photographing the drawer or toolbox and tracing its outline already works:
Step 1 with a paper, card, or grid reference corrects warp, Step 2 traces the
bottom, and saving the trace as kind `container` puts it in the layout's
container list. A drawer is usually bigger than a sheet of paper, so the
graph paper or cutting mat reference, whose edges need not be in frame, is
the right one; the scale bar sets scale only and cannot correct warp.

What is missing is Sam's "known x and y" correction: measure the drawer's
inside width and depth with a tape and force the traced container to those
numbers. Step 4 gets two fields, Known width and Known depth, on the
container panel. Filling either scales the container outline about its
bounding-box centre so that axis matches; filling both scales each axis
independently, which absorbs residual warp from a shot that was not quite
square. The readout shows the implied scale factors and warns when they
differ by more than 2 percent, since that usually means a mis-traced edge
rather than warp. The scaled outline is stored as the container's `outer`;
the original stays in the library entry.

#### The palette

Two groups under one heading. Library rows are what `layToolSel` lists
today, kept as a list rather than a select so both groups can show. Folder
rows show the name and, on hover or as a hint, the relative path. Each row
has Add. The Folder group header has "Add all" and the count of skipped
files with a tooltip listing them. A folder row also has "Save to library",
which writes it through `libSave` with `source` stripped.

"Add all" places entries in the same seeded grid `layAddBtn` uses today
(offset by index), so the result is deterministic and the nesting button, once
built, tidies it. Placing all does one `refreshLayoutEditor` at the end, not
one per item.

#### Provenance, not reference

A placed item copies the outline and records `source`. Saving the project
serialises the copy. Reopening the folder later does not touch placed items.
If Sam wants "refresh from folder" later it is a name-or-path match over
`source.path`, which is why `path` and not just `name` is stored.

#### Photos inside traces

A project file carries `rectified` (a JPEG data URL of the warp-corrected
photo) and `pxPerMm`. The folder reader crops the outline's bounding box out
of it on a canvas, downscales to 256 px on the long side, and stores
`thumb: { dataUrl, mmPerPx, origin }` on the entry, where `origin` is the
outline's bounding-box corner in the entry's normalised mm space. The
layout editor draws it with `clip()` on the outline path, transformed by the
item's `x`, `y`, and `rot`, at reduced alpha so pocket strokes and conflict
tints stay legible. A toggle, Show photos, defaults on.

Size matters twice. localStorage holds the library in roughly 5 MB, and a
256 px JPEG at quality 0.7 is 10 to 25 KB, so a library of a hundred tools
stays under 3 MB; the save handler warns at 4 MB and offers to save without
thumbnails. Project files embed the thumbnails of placed items, so a
twelve-tool drawer grows by about 200 KB; the Save dialog's existing
"include photo" checkbox gains a sibling for thumbnails.

#### Bed as a build plate

`state.layout.bed` today is `{ preset, w, h, tabs }` and tiling plans
against a rectangle. It gains `shape: null | { name, outer }` and `offset:
{ x, y }`, both additive. The layout editor draws the bed outline dashed
under the container when the layout fits on one bed, at `offset`, so the
user sees where the drawer sits on the plate. Auto-centre sets `offset` so
the layout's bounding box is centred in the bed's; drag on the bed outline
or arrow keys with the bed selected nudge it. When the layout is larger than
one bed, the same offset shifts the tiling window before `splitTiles` scores
seams, which gives manual control over where seams fall without touching the
scoring. A shaped bed is honoured in the single-tile case by warning when
any part of the layout leaves the shape; tiling against a shape is out of
scope.

Sam asked whether custom-sized and shaped plates already work. Custom width
and depth do, through the Custom preset, and tiling against them is covered
by synthetic tests. There is no shape, no visible bed in the editor, no
centring, and no nudge; all four are new here.

#### Export row

Three buttons that call the existing Step 3 handlers. If those handlers are
bound to Step 3 element ids, extract the bodies into functions the two rows
share; do not duplicate the export logic.

### Plan

Each step is one commit, `node test/e2e.mjs` green, printed total quoted.

1. **Step 4 shell.** Nav button, panel, `setStep(4)`, reparent the modal's
   children, delete the overlay, holder type `layout` jumps to Step 4.
   Tests: `setStep(4)` from a fresh load works with no image; every `lay*`
   id the suite already touches still resolves; the Step 3 holder select
   still accepts `layout`.
2. **Export row.** Shared export functions, three buttons on Step 4. Test:
   an SVG exported from Step 4 for a two-tool layout is byte-identical to
   the one Step 3 produces for the same state.
3. **Folder reader.** `js/import/traceFolder.js`, `tracesFromFiles`. Tests
   in `page.evaluate` with synthetic `File` objects: a project file yields
   one entry with the right thickness and origin-normalised outline; a
   library export yields N tool entries and skips containers with reason
   `container`; a `.txt`, a malformed `.json`, and a JSON with no trace are
   each skipped with the right reason; arcs survive with indices intact.
4. **Palette UI.** Library and Folder groups, Add, Add all, Save to library,
   skipped count. Test: after driving `tracesFromFiles` on a three-file
   fixture and clicking Add all, `state.layout.items.length === 3`, each
   with `source.kind === 'folder'`, and `serializeProject` round-trips them.
5. **File System Access backend.** Feature-detected picker, recursive walk
   into `{ path, file }`, IndexedDB handle store, Reopen, Save project to
   folder. Tests: the walk over a synthetic handle tree yields the same list
   the directory input yields; with the API absent the button still opens
   the input.
6. **Photos inside traces.** Thumbnail extraction in the reader and on
   library save, the `thumb` field, the clipped draw, the toggle, the size
   warning. Tests: a project fixture with a rectified image yields an entry
   whose thumb is under 30 KB and whose `mmPerPx` matches; the editor draw
   with photos on does not throw for an item without a thumb.
7. **Bed as a build plate.** `shape` and `offset`, the dashed bed outline,
   Auto-centre, drag and nudge, the shaped-bed warning, tiling window offset.
   Tests: Auto-centre on a 200×100 layout in a 300×200 bed gives offset
   50,50; a nudge of 10 mm shifts every tile's origin by 10 mm; a round bed
   warns when a corner of the layout leaves it.
8. **Known width and depth.** The two fields, per-axis scaling, the
   readout and the 2 percent warning. Tests: a 200×100 container with known
   width 210 becomes 210×100; both fields set to 210×105 scale each axis;
   210×120 warns.
9. **README and screenshots.** Four-step table, a Step 4 section including
   the two folder backends, photos in traces, the build plate, and container
   scaling, and placeholder image paths for Sam to replace.

Steps 1, 3, 7, and 8 are independent. Step 2 depends on 1; step 4 depends
on 1 and 3; step 5 and 6 depend on 3 and 4; step 9 last.

### Open questions (recommendation first)

1. **Should the reader also accept a folder-level `library.json` export as
   the whole palette?** Recommendation: yes, it already does by the library
   export rule; no extra work.
2. **Should the File System Access backend also save exported STL and SVG
   into the folder?** Recommendation: not in v1.0; the browser download is
   one click and the folder write needs a name-collision policy.
3. **Should a container-kind entry in the folder be offered as the drawer
   outline?** Recommendation: yes, but as a follow-on once the palette
   exists; for v1.0 it is reported as skipped with reason `container`.
4. **Should thumbnails be stored in the library at all**, given the 5 MB
   localStorage ceiling? Recommendation: yes with the warning; a library
   without photos is what exists today and the user can decline.
5. **Tiling against a shaped bed.** Recommendation: defer; a laser bed is a
   rectangle and a shaped plate is a printer case that rarely needs tiles.
6. **Does Step 4 belong before or after export?** Sam's framing is after,
   as Step 4. Recommendation: agree, because the common path is one tool
   through 1 to 3 and the drawer is a later, separate session over many
   tools.

---

## Part D: Laser-cut foam constructions

### Problem

`buildLayoutInsert` (`js/holders.js` line 423) always keeps a floor: the
insert is a slab with pockets recessed from the top, which is what a CNC
router or a 3D printer makes. That construction stays as it is, named
`pocket`, and remains the right one for routed foam. Sam's foam will mostly be laser cut, and a laser cuts
through. That gives two constructions the builder cannot express today:

- **Through-cut, one layer.** Every pocket is a hole through the sheet. The
  tool sits on whatever is under the foam.
- **Two layers with a contrast base.** A through-cut top sheet glued onto a
  plain sheet of a contrasting colour. The base shows through every pocket,
  so a missing tool is a bright silhouette. This is the shadow-board look.

The single-tool foam insert already supports `floor = 0` as a through pocket
(`holders.js` line 986 onward), so the mesh capability exists; the layout
path just never offers it.

#### What this changes about labels

The labelling PRD placed labels beside pockets because two recesses on one
face cannot nest. In the two-layer construction the base sheet has no
pockets, so a label recess anywhere on it is legal, including inside the
pocket footprint. A label engraved on the base inside the silhouette is the
classic shadow-board label and needs no new mesh work: it is a recess on a
flat slab. Part D makes that placement available for the base layer only.

### Success criteria

1. A layout can be built as `pocket` (today, for routing and printing),
   `through`, or `layered`, and the 3D preview shows the right thing for
   each, including open holes for the through cut.
2. `through` and `layered` STL exports are watertight by construction, using
   `buildSolid` with holes for the top sheet and a plain slab for the base.
3. The cut template SVG for `through` and `layered` puts pocket outlines on
   the cut layer for the top sheet and, for `layered`, emits the base sheet
   as a second sheet (or second page of tiles) carrying the container
   outline and any base-layer label engraving.
4. Per-item depths are honoured in `pocket`, ignored with a visible warning
   in `through` and `layered` (a laser cuts the whole sheet; depth is the
   sheet), and every existing project loads as `pocket`.

### Scope

#### In

- `state.layout.construction` in `'pocket' | 'through' | 'layered'`, default
  `pocket`, additive to the save format.
- `layered` options: top sheet thickness, base sheet thickness, and whether
  labels go on the top beside pockets (as now) or on the base inside the
  pocket footprint.
- `buildLayoutInsert` gains `opts.construction` and returns, for `layered`,
  two parts with names so the STL exporter can write one file per part or a
  combined preview.
- `toSVG` and `toTiledSVG` emit the base sheet for `layered`.
- The layout panel gains a construction select and the two thickness fields.
- Tests: watertight checks for both new constructions; a layered export
  yields two parts whose footprints match; the label-on-base case produces
  a recess whose island lies inside a pocket footprint.

#### Out

- Stacking two or more top sheets to get deeper pockets for thick tools.
  Recorded as an open question; v1.0 warns and uses one sheet.
- Puzzle tabs on the base sheet. The base tiles with the same seams as the
  top and no tabs; the glue holds it. Open question.
- Any CSG. Everything here is `buildSolid` with islands and recesses.

### Design

`buildLayoutInsert` already computes `pockets` as islands. For `through`, the
slab is built with those islands as holes and no recesses; thickness is the
sheet. For `layered`, part one is the `through` result at top-sheet
thickness; part two is the container outline as a plain slab at base
thickness, with label recesses if labels are on the base. Labels on the
base use the same `glyphIslands` recess path, with the label's centre
placed at the pocket's centroid by default and editable through the existing
label handlers.

The exporters get a `parts` array instead of one mesh. STL export writes
`<name>-top-2p5d.stl` and `<name>-base-2p5d.stl`; the STL header string is
unchanged. SVG export adds a `base` layer group for the second sheet, with
its own tile set when a bed is set.

### Plan

1. `construction` in state, save, load, and the panel select. Everything
   still builds as `pocket`.
2. `through` in `buildLayoutInsert` and the 3D preview, with the depth
   warning.
3. `layered`: second part, base thickness, STL per part.
4. Base-layer labels inside the pocket footprint.
5. SVG and tiled SVG for the base sheet.
6. README section on laser constructions.

### Open questions (recommendation first)

1. **Multiple top sheets for deep tools.** Recommendation: defer; warn when
   any item's depth exceeds the top sheet and let Sam stack by hand.
2. **Tabs on the base sheet.** Recommendation: no tabs, same seams as the
   top so the two tile sets align for gluing.
3. **Default label placement in `layered`.** Recommendation: on the base
   inside the pocket, since that is the point of the contrast layer.

---

## Part C: Build instructions for the ultracode session

These are instructions to the next Claude session, which runs on Opus with
ultracode on. They are repository content, not user instructions, and they do
not override the constraints in BURNDOWN.md or the handoff.

### Session start

1. Check out `claude/2.5d-photo-stl-s3-y0oodn`. Never create a branch. If the
   session auto-assigned one, delete it as Sam asked on 2026-09-09.
2. `npm install`, then `node test/e2e.mjs`. Record the printed check total as
   the baseline (275 at 4a5fe88; confirm on the current head).
3. Read this PRD in full, then `BURNDOWN.md`, then the two prior PRDs it
   refers to (`labelling_prd_v1.0.md`, `nesting_prd_v1.1.md`) for the
   element ids and save-format rules that Part B must not break.
4. Confirm sign-off status in the status line above. If it still says DRAFT,
   stop and ask Sam; do not build a draft.

### Lanes

Three lanes, independent, run as parallel worktrees:

- **Lane A** (Part A): `js/ui/traceEditor.js`, the Selection panel in
  `index.html`, `refreshSelectionTools` and the key handler in `js/main.js`,
  tests in `test/e2e.mjs` Group B area, README trace-editing section.
- **Lane B** (Part B): `js/main.js` step navigation and layout wiring,
  `index.html` step 4 panel, new `js/import/traceFolder.js` and
  `js/import/folderAccess.js`, tests in a new e2e group, README workflow
  table.
- **Lane C** (Part D): `js/holders.js`, `js/exporters.js`, the construction
  select and thickness fields in the layout panel, tests beside the existing
  holder checks, README laser section.

All lanes edit `index.html`, `js/main.js`, `test/e2e.mjs`, and `README.md`,
in different regions. Lane C's panel additions land in the same panel Lane B
moves, so the merge agent merges B before C. Merging is expected to be clean or to need trivial
resolution; the merge agent handles it. Do not split a lane's steps across
parallel agents: within Lane A, steps 2 to 4 all edit `_down`, `_move`,
`_up`, and `draw` in the same file, and three concurrent rewrites of those
methods would cost more in merge than they save. Sequential within a lane,
parallel across lanes.

### Workflow shape

Three workflows in sequence, each read and judged by the main loop before
the next starts.

**Workflow 1, build.** One pipeline over the two lanes. Each lane is one
agent in a worktree that works its plan steps in order, committing after
each step with the e2e total in the message, and returns structured output:
the worktree branch, the commit list, the final e2e total, and anything it
could not do. Effort high. Give each lane agent only its Part of this PRD
plus the shared constraints, not the whole file.

```js
export const meta = {
  name: 'build-selection-and-organize',
  description: 'Build Part A and Part B lanes in parallel worktrees',
  phases: [{ title: 'Build' }],
}
const LANE = {
  type: 'object',
  properties: {
    branch: { type: 'string' }, commits: { type: 'array', items: { type: 'string' } },
    e2eTotal: { type: 'number' }, e2eFailures: { type: 'number' },
    notDone: { type: 'array', items: { type: 'string' } },
  },
  required: ['branch', 'commits', 'e2eTotal', 'e2eFailures', 'notDone'],
}
const lanes = [
  { key: 'A', part: 'Part A: Trace-editor selection modes' },
  { key: 'B', part: 'Part B: Step 4 Organize' },
  { key: 'C', part: 'Part D: Laser-cut foam constructions' },
]
const built = await pipeline(lanes, l =>
  agent(`You are building ${l.part} of docs/selection_and_organize_prd_v1.2.md
in the 2.5D repo, on a worktree of branch claude/2.5d-photo-stl-s3-y0oodn.
Follow that Part's Plan steps in order. One commit per step, committed with
"git -c core.hooksPath=/dev/null commit", message ending with the e2e suite's
printed check total. Run "node test/e2e.mjs" before every commit; do not
commit red. Do not touch the other Part's files beyond what your Part names.
Do not bump js/version.js. Do not deploy. Never put a model identifier in
anything committed. Return the branch name, commit hashes with subjects, the
final e2e total and failure count, and a list of anything you could not do.`,
  { label: `lane:${l.key}`, phase: 'Build', schema: LANE, isolation: 'worktree', effort: 'high' }))
return built.filter(Boolean)
```

**Workflow 2, review.** For each lane branch, three verifiers with distinct
lenses, prompted to refute: (1) does every success criterion in the Part
hold, with a driven check, not a reading; (2) does anything violate the
constraints (save-format keys, element ids, single-file build, no model
identifier in commits); (3) adversarial: find an input that breaks a
resolver or the folder reader (a degenerate lasso, a brush path of one
sample, a project file with `trace` but no `regions`, a folder with two
files of the same name). Each returns findings with file and line. A finding
that two of three verifiers confirm goes back to a fix agent on that lane's
branch, then the verifiers run again on the new head. Loop until a round
returns nothing confirmed, capped at three rounds; log what remains.

**Workflow 3, merge.** One agent merges lane A, then B, then C into
`claude/2.5d-photo-stl-s3-y0oodn` with merge commits (no rebase, no
force-push), resolves conflicts, runs `node build.mjs` and `node test/e2e.mjs`,
and pushes with `git push -u origin claude/2.5d-photo-stl-s3-y0oodn`. It
returns the final head, the e2e total, and the dist size. If the total is
lower than the sum the lanes reported, that is a merge error, not a flake:
find it.

### After the workflows

- Update this PRD's status line to record what shipped, bump it to v1.2,
  and append the changelog line.
- Append the ledger lines to BURNDOWN.md.
- Bump `js/version.js` and deploy. Sam's call on 2026-09-10: these changes
  uprev the app. The version is the next minor above whatever gh-pages
  carries at that moment (1.24.0 if the S3 labelling work is still
  unreleased, since it ships in the same deploy; 1.25.0 if Sam deployed
  labelling as 1.24.0 in between). Deploy per the standing rule: rebase
  first so Sam's landing commits survive, touch only `gh-pages/2.5d.html`
  and the landing `?v=` bump.
- Produce the handoff block: decisions made, open threads, next actions.

### What not to do

- No new branches, no PR unless Sam asks.
- No skipping or weakening a test to get green.
- No deploy before the merge workflow's e2e run is green on the merged head.
- No CSG, no mesh changes; both Parts are 2D editor and UI work.
- No `Date.now()` or `Math.random()` inside a workflow script.
- Do not let a lane agent "improve" the other lane's files in passing.

## Decision needed

Sign-off on Parts A, B, and D and on the lane plan in Part C. Part A open
questions 1 and 2, Part B open question 3, and Part D open question 1 are the
ones that change what gets built; the rest are defaults.

## CHANGELOG
- v1.0 (2026-09-10): Initial draft of the selection-modes PRD (as `selection_modes_prd_v1.0.md`) from the 2026-09-09 chat decisions.
- v1.2 (2026-09-10): Sam's 2026-09-10 additions. Part A: crossing box and the other gestures also select circles. Part B: File System Access backend beside the directory input, container-from-photo path documented, known width and depth scaling, photos drawn inside traces, bed as a build plate with shape, auto-centre, and nudge. New Part D: through-cut and two-layer laser foam constructions with base-layer labels. Part C: third lane, and the session now uprevs and deploys.
- v1.1 (2026-09-10): Renamed and widened. Added Part B, Step 4 Organize with a folder-of-traces palette, and Part C, build instructions and workflow scripts for the Opus + ultracode session. Written without em dashes per Sam's style guide; the repo's older docs use them and that conflict is still open in BURNDOWN.md.
