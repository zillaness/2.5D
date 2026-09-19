---
file: drawer_scan_prd_v1.0.md
version: 1.1
author: Sam Cao
created: 2026-09-19
last_updated: 2026-09-19
description: PRD for scanning a whole drawer from one photo of its four corners, tracing every tool in it at once, and landing the silhouettes straight into the Step 4 layout as placed items.
ai_update: Update last_updated and version. Rename file to match. Append changelog at bottom.
---

# PRD: Scanning a drawer in one photo

Status: **Steps 1 to 6 and 8 SHIPPED in v1.27.0, 2026-09-19. Step 7 not built.**
· 2026-09-19 · target branch `claude/2.5d-photo-stl-s3-y0oodn`

Sam put this in the work queue on 2026-09-19, which granted the exception asked
for below and signed off the `layout.items` landing position with Send to Step 2
as the escape hatch. Every open question was built to its own recommendation.

**Shipped:** the capture mode and the resolution raise (1), `segmentObjects`
(2), `js/scan.js` (3), landing in `layout.items` (4), the review as a mode on
Step 2 (5), Edit in Step 2 (6), and the auto-name export guard (8).

**Not built:** step 7, the reference-object cross-check and the one-click
rescale of open question 6. The rim caution shipped as hint text, with the
numbers, so the sharpest accuracy risk is at least named at the moment the
corners are placed; what is missing is the independent measurement that would
catch a mis-measured drawer. Also not built, and both named in the README:
merging two candidates that were touching, and per-candidate thumbnails in the
review list.

**Three corrections this document needed, found by building it:**

1. **`paperDims` sorts custom width and height by orientation.** With the
   default portrait orientation a 560 wide by 400 deep drawer would have
   rectified as 400 by 560, transposed, on the very first photo. The scan takes
   its two numbers as given.
2. **`goStep(2)` would have destroyed the scan silently.** It re-rectifies and
   retraces whenever `state.rectDirty` is set, which any corner nudge does, and
   `retrace` ends in a single-tool segmentation of the whole drawer. A user who
   scanned, glanced at Step 1, moved a handle and came back would have lost
   everything. Guarded, and tested.
3. **"A mode on Step 2, no new capability" understated it by two TraceEditor
   edits**, both mandatory: `draw()` has to hand its context and viewport to
   `onDraw`, and `_down` needs a mode branch of its own or a left press falls
   through to `edit`, starts a pan, and swallows every tick.

Three shipped constants were deliberately not inherited, because each was tuned
for one object on a sheet at up to 8 px/mm and each fails silently on a drawer:
the region suggester's 0.25 bounding-box fill gate (a 200 by 20 mm tool at 45
degrees fills 0.165 and would vanish), `state.seg.minHoleAreaMm2` of 3, and
`state.seg.marginMm` of 2, which at scan resolution clears an eleven pixel strip
on every side and would clip any tool lying against a wall.

Sam, 2026-09-19: "is it possible to layout the tools in the drawer, and take a
picture of the 4 corners of the drawer and provide the measurement length and
width of the drawer. Then just trace out the individual tools in the drawer in
one go. The placement of the individual traces could be nudged, and adjusted if
needed. It would be a faster, but potentially less accurate way to create a
tool foam insert in one go for a drawer."

Three decisions are already made and this document does not re-open them. One
photo containing all four corners, not four corner close-ups. The user types the
drawer's measured length and width. A reference object (any coin or card the app
already knows) is an optional cross-check that warns on disagreement, never the
primary scale.

## Problem

Twelve tools is twelve photos, twelve reference setups, twelve traces and
twelve typed names, and at the end the drawer is still laid out from scratch by
dragging, because the photos were shot one tool at a time on a sheet of paper
and not in the drawer. The arrangement the user already has, sitting in front of
them, is thrown away and rebuilt. Sam is asking for the opposite: lay the tools
out in the drawer by hand the way you want them, take one photo, and get back a
drawer that is already laid out, because the photograph is the layout.

### What the code actually does today

Verified on this branch at v1.25.0 (`js/version.js:3`):

- `rectify(image, corners, paperWmm, paperHmm, opts)` (`js/homography.js:64`)
  takes physical millimetres directly and knows nothing about paper; scale is
  `pxPerMm = Math.min(maxLongSidePx / Math.max(totalW, totalH), 8)`
  (`js/homography.js:72`). `PAPER_SIZES.custom` exists (`js/paperSizes.js:38`),
  `paperDims` honours `customW` / `customH` (`js/paperSizes.js:85-93`), the
  fields are in the UI (`index.html:126-131`) with handlers at
  `js/main.js:3768-3778`, and `doRectify` passes their millimetres straight
  through (`js/main.js:504-507`). **Typing a drawer's width and depth and
  dragging four handles onto its inside corners is not a new capability. It is
  the Custom size, used honestly.**
- `traceBoundaries` (`js/contour.js:9`) already returns every closed loop of a
  mask in one pass with no 8-connectivity ambiguity, and `labelComponents`
  (`js/segment.js:138`) is already general 4-connected labelling returning every
  component with its size. `suggestRegions` (`js/regions.js:58-146`) is the
  closest thing in the codebase to the multi-object version, scoped to the
  interior of one already traced outline, which is the only reason it is not
  already the answer.
- The bottleneck is exactly two places. `segmentObject` (`js/segment.js:169-215`)
  labels everything, then throws all but the largest component away
  (`js/segment.js:209-213`). Its caller `retrace` (`js/main.js:1548`) takes
  `mmLoops[0]` as the one outer and treats every other loop as a hole of it
  (`js/main.js:1590-1604`).
- `state.layout` (`js/main.js:94-133`) is a drawer already: a `container` with
  user-entered `w` and `h`, `items[]`, clearance, floor, border, construction,
  bed, snap and labels. A placed item is what `layPlaceTool` builds
  (`js/main.js:3171-3191`): `{ name, outer, holes, circles, thickness, depth,
  rot, x, y }`, plus optional `source` and `thumb`, and `notch`, `label`,
  `labelAt`, `labelRot` added later. Everything downstream of it is mature:
  `layoutPockets` (`js/holders.js:236`), `layoutConflicts`
  (`js/holders.js:423`), `nestLayout` (`js/holders.js:602`),
  `buildLayoutInsert` (`js/holders.js:1018`), `splitTiles`
  (`js/holders.js:1860`), and drag, rotate, nudge and snap
  (`js/ui/layoutEditor.js:146-186`, `:457-463`).
- Typed dimensions correcting a photographed container is established
  precedent. Known width and Known depth (`layKnownW` / `layKnownD`, handlers
  `js/main.js:2769-2775`) call `layScaleContainer` (`js/main.js:2507`) to force
  a traced container outline to a tape-measure number, and `syncScaleInfo`
  (`js/main.js:2483-2502`) warns when the two axes disagree by more than
  `SCALE_DIVERGENCE = 0.02` (`js/main.js:2474`), per README line 759. Precedent
  both for Sam's typed-dimensions decision and for the optional cross-check.

So most of the pipeline exists. What does not: a segmenter that returns more
than one object, a way to review N candidates, and any place for N traces to
live at once.

### The tension with a shipped principle

`docs/batch_ingest_prd_v1.0.md` shipped in v1.25.0 and puts this in Out:

> Automatic tracing of the whole queue without the user. Each tool still gets
> the human pass in Step 2; that is the app's quality bar.

This proposal asks for an exception, and it should be granted or refused
deliberately rather than slipped past.

The exception is precise: N tools are segmented and traced in one automatic
pass, and the human pass moves from per-tool vertex editing to a per-tool accept
or reject, with an escape hatch back into Step 2 for any tool that traced badly.
The quality bar is not removed. It is relocated, and it is weaker, because
accepting a silhouette is a glance and editing one is a decision per vertex.

The argument for the exception is Sam's own framing: "faster, but potentially
less accurate." The batch PRD's rule is right for the path it governs, the one
that builds the careful library. This is a second path with a different promise,
and that promise has to be visible in the product, not only here:

- The drawer scan is never the default. The photo queue keeps that position in
  the README and in Step 1.
- A scanned item carries `source: { kind: 'scan' }` in the item's existing
  `source` field (provenance only, `js/main.js:3186-3187`) and is badged in the
  layout editor, so a tool that got the human pass can be told from one that got
  a glance. And the escape hatch is in scope, not deferred: without it the
  exception is not worth granting.

### The name collision

README line 771 already carries the heading "Tracing a whole drawer in one
pass", describing the photo queue: one photo per tool, walked in sequence. That
phrase cannot mean two things. Proposed resolution, one README line each: the
existing section becomes "The photo queue: a drawer one tool at a time", and
this feature takes "Scanning a drawer in one photo". No element id and no state
key changes.

## Success criteria

1. **N silhouettes from one mask.** `segmentObjects()` on a fixture mask holding
   seven separated blobs returns seven candidates, ordered deterministically,
   none below the minimum area, and `segmentObject` still returns exactly what
   it returns today on the existing fixture (`test/e2e.mjs:3424-3440`).
2. **Bounding boxes do not merge tools.** Two candidates whose bounding boxes
   overlap while their outlines do not come back as two, not one.
3. **The typed numbers are the scale, and nothing else is.** Changing the typed
   drawer width by 10 percent changes every candidate's measured width by
   10 percent, to within 0.1 percent.
4. **The reference object is a cross-check only.** Marking a coin or card in the
   drawer changes no geometry. It produces a stated agreement figure and a
   warning past `SCALE_DIVERGENCE`, reusing that constant rather than a new one.
5. **Everything lands placed.** After accept, N entries exist in
   `state.layout.items` at the positions the photograph put them, and
   `layoutConflicts`, `nestLayout`, `layoutPockets` and `buildLayoutInsert`
   accept them with no special case.
6. **Round trip.** A scanned layout saves and reloads with every item's `outer`,
   `holes`, `x`, `y` and `rot` identical. A project written by v1.25.0 still
   loads unchanged.
7. **Reject before it lands.** A candidate unticked in review never reaches
   `layout.items`, and two candidates merged in review land as one item.
8. **One bad trace is repairable without redoing the drawer.** Any single placed
   item can be sent into Step 2 over the drawer photo, edited, and applied back
   onto that item, with its `rot`, `x` and `y` preserved.
9. **Resolution is stated, not assumed, and the tab does not freeze.** The scan
   reports its px/mm and refuses to proceed silently below a floor; at 5 px/mm a
   2 mm feature round-trips to millimetres within 0.3 mm; a 560 by 400 mm drawer
   rectifies and segments inside a stated ceiling or yields with progress.

## Scope

### In

- A **drawer scan** entry on Step 1: type the drawer's inside width and depth,
  drag the four handles onto the inside corners of the drawer **bottom**, and
  rectify. Internally this is the existing Custom paper size plus a `state.scan`
  flag; no new reference mode and no new rectify path. A raised resolution
  ceiling on this path only, since 1600 px over a 560 mm drawer is 2.9 px/mm.
- `segmentObjects(diffMap, options)` in `js/segment.js`: every component above a
  minimum area, ordered deterministically. `segmentObject` is left alone.
- `js/scan.js`: per-component boundary tracing, simplify, smooth, sliver reject
  and outer-plus-holes classification within each component, producing N
  independent millimetre parts.
- A **review overlay** on the rectified drawer: every candidate drawn over the
  photo, tick to keep, merge two, rename, with area and a thumbnail each.
- **Landing in `state.layout.items`** at the photographed poses, through
  `layPlaceTool` with `x` and `y` set from the scan instead of the seeded grid,
  and **Send to Step 2**, the per-item escape hatch, writing back on Apply.
- The optional **reference-object cross-check**, reusing the coin and card
  reference types and the 2 percent divergence threshold, and the
  rim-versus-bottom caution stated where the corners are placed.
- **Default names** from reading order, editable in review, plus a pre-export
  warning listing items that still carry one.
- Tests for each success criterion, in one contiguous block.
- README: the new section, and the rename of the existing one.

### Out

- **Per-vertex editing of N tools at once.** `TraceEditor` holds exactly one
  tool by construction and this document does not change that. See the design
  section; the escape hatch is the answer instead.
- **Separating tools that touch in the photograph.** No watershed, no manual
  split line. A merged blob is rejected in review and the tools moved apart for
  a second photo, or accepted and repaired through Step 2. Watershed on
  overlapping hand tools is its own project and it is not a small one.
- **Multiple photos stitched into one drawer.** One photo, all four corners,
  per the settled decision. **Automatic naming from the image**: no classifier,
  names are typed or left as defaults. **Depth from the photograph**: a view
  from above cannot see depth, so scanned items take the default thickness and
  per-tool depth stays manual.
- **Replacing the photo queue.** The queue remains the default and the
  recommended path.
- **Changing `segmentObject`, `retrace`, or anything the single-tool path
  walks.** The shipped path does not move for this feature.

## Constraints

Inherited, non-negotiable:

- Single-file, fully client-side. No server, no user-facing build step.
- No CSG, no mesh work. Segmentation, geometry and UI only; mesh generation
  downstream is untouched and stays watertight by construction.
- Save-format keys stay stable. `state.scan` and the item's `source.kind` are
  new, additive and optional; a project with no `scan` key loads as it does
  today. Every `lay*`, `queue*`, `customW` and `customH` id keeps its name.
- No `Date.now()` or `Math.random()` in code the tests must be deterministic
  over. Candidate ordering is by position, not by label index, so it does not
  depend on the label pass's scan order.
- Memory is the binding constraint here and it is new. At `maxLongSidePx: 3200`
  a 560 by 400 mm drawer rectifies to roughly 3200 by 2290 px: one source
  `ImageData`, one output `ImageData` and one canvas, warped by a plain
  per-pixel JavaScript loop with no worker (`js/homography.js:106-136`). Hold
  one decoded photo at a time; release the source before segmenting.

## Design

### Capture and scale

The drawer is the reference rectangle, and that needs almost no new code: paper
size `custom`, the measured inside width in `customW` and inside depth in
`customH`, the four handles on the drawer's inside corners, and `doRectify`
(`js/main.js:500`) produces a top-down drawer plane with `pxPerMm` from the
typed numbers. Capture area stays 0; nothing of interest is outside the drawer.

`detectPaperCorners` (`js/detectPaper.js:112`) will not help: it scores
brightness minus a saturation penalty (`js/detectPaper.js:127-133`) and bails
when the winning component covers under 5 percent of the frame
(`js/detectPaper.js:161`). A tool-filled drawer is neither bright nor dominant.
Auto-detect is already advisory, so it does not fire and the user drags four
handles. Say that in the hint rather than letting it be discovered.

Resolution is the one number that decides whether this is usable. `rectify`
defaults to `maxLongSidePx = 1600` and caps px/mm at 8, so a 560 mm drawer
arrives at 2.9 px/mm and a 2 mm screwdriver tip is six pixels across. The grid
reference already passes `maxLongSidePx: 3200` (`js/main.js:454`), so raising it
here is one argument, but the cost is real and is the subject of plan step 1:
roughly 7.3 megapixels of output, warped in a non-worker loop, plus the
segmentation passes over the same buffer.

The reference-object cross-check runs after rectification, where millimetres
exist. The user marks the coin or card lying in the drawer, the app measures it
against its known size, and a disagreement past 2 percent is a warning with a
number in it, phrased the way `syncScaleInfo` phrases its own.

### Segmentation

`computeDiffMap` runs with no `paperRect`, so it samples the border band of the
rectified image (`js/segment.js:50-51`), which is the drawer liner near the
walls. That is the right background estimate when the liner is uniform and no
tool is pushed against a wall. When one is, the border sample is poisoned and
the whole scan degrades. That is a real failure mode and it belongs in the hint
text: leave a finger's width of clear liner around the edge.

`segmentObjects(diffMap, options)` is the new function and it is small: it is
`segmentObject` (`js/segment.js:169-215`) up to and including `morphClean` and
`labelComponents`, then keeping every component with `size >= minAreaPx` instead
of the single largest. `segmentObject` is not re-expressed in terms of it; it is
on the shipped single-tool path and criterion 1 says it does not move.

`js/scan.js` turns each component mask into a part: `traceBoundaries`, convert
to millimetres, then `collapseCollinear`, `simplifyClosed` and `chaikinClosed`
on the existing `state.seg` settings, exactly as `retrace` does at
`js/main.js:1582-1590`. The largest loop of that component is the outer and the
rest are its holes by `pointInPolygon`, `retrace`'s own rule at
`js/main.js:1594-1604` scoped to one component rather than the whole frame.
Slivers go on bounding-box fill fraction, borrowing `js/regions.js:117-118`.

`loopsToViews` (`js/import/loops.js:86-126`) looks like the right thing to reuse
and is not: it clusters loops by bounding-box overlap
(`js/import/loops.js:95-102`), which is correct for CAD views on a sheet and
wrong for a drawer, where two hand tools nested into each other have overlapping
bounding boxes and separate outlines as a matter of course. It would merge them,
and its own comment admits a related v1 limitation
(`js/import/loops.js:120-121`). Component labelling is the right grouping and is
already what `segmentObjects` produces, so no clustering step exists here.

### Where the N traces land, and what that costs

**Recommendation: the silhouettes land directly in `state.layout.items`. They do
not go through `TraceEditor`.**

`TraceEditor` is a singleton in structure, not merely in instantiation. Its
state is `this.outer`, `this.holes`, `this.circles`, `this.arcs`, `this.lines`,
`this.measurements` and `this.constraints` (`js/ui/traceEditor.js:51-96`), and
every reference into that geometry is addressed by `_loop(loopIdx)`: `-1` is the
outer outline, `n` is `holes[n]`, `REGION_LOOP_BASE + i` is a section footprint
(`js/ui/traceEditor.js:286-292`). One instance exists, at `js/main.js:158`.
Making it hold N tools means making all seven arrays per-tool and re-addressing
every ref in `js/measure.js`, `js/constraints.js` and the save format. That is
not a feature; it is a rewrite of Step 2, and it would put the shipped
single-tool path at risk for a path Sam himself calls potentially less accurate.

Landing in `layout.items` costs one function. `layPlaceTool`
(`js/main.js:3171-3191`) already builds the item from `{ name, outer, holes,
circles, thickness }` and only computes `x` and `y` from a seeded grid; the scan
supplies `x` and `y` from the photograph instead. Nothing else changes, and drag,
rotate, nudge, snap, notches, depth, labels, conflicts, nesting, pocket
generation, tiling and export all work on the first commit.

**What the user gives up, stated plainly.** In the layout editor a placed item
is a rigid body: no per-vertex editing, no fillet arcs, no measurements, no
constraints, no manually placed circular holes. A scanned tool whose silhouette
is wrong cannot be nudged vertex by vertex where it sits. Sam's own sentence is
the test: "The placement of the individual traces could be nudged, and adjusted
if needed." That is placement, and nudge and rotate are what the layout editor
does today. Reading "adjusted" as per-vertex editing is reading past the word
"placement".

**The escape hatch, and it is in scope.** Send to Step 2, one item at a time.
The scan keeps its rectified canvas and `pxPerMm`, so sending item `i` back is
`traceEditor.setRectified(scanCanvas, pxPerMm)` plus `setTrace(outer, holes)`
with the item's geometry translated into the canvas frame. The singleton then
holds exactly one tool, which is what it is built for. Apply writes `outer`,
`holes` and `circles` back onto that layout item through the existing `getTrace`
(`js/ui/traceEditor.js:195`) and returns to Step 4. Geometry is stored unrotated
and `rot` is a separate field, so the edit strips `rot`, runs in the scan frame,
and restores `rot`, `x` and `y` on the way back. No refactor: one load and one
write-back through methods that already exist.

### Review and adjust

The review is a mode on Step 2, not a modal, so it reuses the trace canvas, its
viewport and the rectified drawer image rather than growing a second pan and
zoom. Candidates are drawn over the photo; the panel is a list with a tick, a
name field, an area in square millimetres and a thumbnail per candidate.
Thumbnails are free, because `libEntryFromTrace` already crops the rectified
canvas to an outline with `thumbFromImage` (`js/main.js:5274-5282`), so the list
shows the tool rather than its silhouette, which is what makes naming a glance
instead of a guess.

Merge unions two ticked candidates' **masks** before tracing, not their
polygons. A polygon union needs Clipper and leaves a seam where two silhouettes
touch; a mask union traces as one loop for free. Place N tools pushes the
accepted candidates into `layout.items` and jumps to Step 4.

**Naming.** A one-shot scan produces N anonymous blobs, the one place the batch
queue is strictly better, since it gets names free from file names. Candidates
are named `Tool 1` through `Tool N` in reading order, banded by `y` then sorted
by `x`; ordering by position rather than label index also keeps the result
independent of the flood-fill scan order. Labels make this matter:
`state.layout.labels.enabled` engraves `it.name`, so an unnamed tool engraves
"Tool 4" into foam. Before an export that engraves labels, warn and list the
items still carrying a default name. Warn, not refuse, since someone cutting a
prototype insert may genuinely not care.

### Parallax, and the sharpest accuracy risk in this document

The drawer's rim rectangle is not the drawer's bottom rectangle, and the tools
lie on the bottom. Drag the handles onto the **rim** corners, type the drawer's
width, and the app sets its scale from the rim plane, which is one drawer depth
closer to the camera than the tools and therefore magnified relative to them.
With the camera at height H above the bottom and a drawer of depth d, a tool of
true length L comes back measuring `L · (H - d) / H`. For a 60 mm drawer shot
from 800 mm that is 0.925: a 300 mm wrench reads 277 mm, and a pocket cut
7.5 percent small does not accept the tool at all. Nor is it a pure scale. The
displacement is radial from the principal point, so unless the camera sits over
the drawer's centre a tool near the edge is shifted as well as shrunk.

This app has never had to model it, because a sheet of paper and the tool on it
are the same plane to within the tool's thickness. Three responses, in order of
how much they are worth:

1. **Mark the bottom corners, not the rim.** Primary, free, and usually
   possible: from directly above, a drawer's inside bottom corners are visible
   unless the drawer is deep and the camera close. It is one line of hint text
   beside the handles, and it removes the error rather than correcting it.
2. **The reference object catches what is left.** A coin lying on the drawer
   bottom is on the tool plane by definition, so the ratio between its measured
   and known diameter *is* the rim-versus-bottom factor. That is the strongest
   argument for Sam's optional cross-check and it belongs in the hint that
   offers it.
3. **Analytic correction from a typed drawer depth and camera height.**
   Rejected for v1: two more numbers, one of which nobody knows, to fix an
   error response 1 removes outright.

One residual cannot be removed and should be admitted: a tall tool's silhouette
from above is its top face, not its footprint, so a 40 mm socket rail reads
oversize by the same mechanism the rim does. The single-photo path has this in
miniature already; here it is larger, because tools are taller than the
paper-flat objects the app was built around.

## Plan

Each step is one commit, `node test/e2e.mjs` green, the suite's printed total
quoted in the message. Ordered so the thing most likely to kill the feature is
proven first.

1. **Resolution and timing.** The drawer-scan rectify path: Custom size wired
   as a Step 1 preset with the drawer hint, `maxLongSidePx` raised on this path
   only. Tests: a synthetic 560 by 400 mm drawer rectifies at or above 5 px/mm;
   the warp completes inside a stated ceiling; a 2 mm feature round-trips within
   0.3 mm. If the warp is too slow or the buffers too large, the feature stops in
   commit one, which is worth knowing then rather than at step 5.
2. **`segmentObjects()`** in `js/segment.js`, pure, no UI. Tests: seven
   separated blobs return seven candidates; a component under the minimum area
   is dropped; `segmentObject` is byte-identical on the existing fixture
   (`test/e2e.mjs:3424-3440`).
3. **`js/scan.js`: candidates to polygons.** Per-component trace, refine, holes,
   sliver reject, reading-order sort. Tests: two tools whose bounding boxes
   overlap while their outlines do not come back as two parts, the case
   `loopsToViews` would get wrong; a through-hole stays a hole of its tool.
4. **Landing in `layout.items`** at the photographed poses. Tests: positions
   preserved within tolerance; `layoutConflicts`, `nestLayout`, `layoutPockets`
   and `buildLayoutInsert` all accept scanned items; the project round-trips; a
   v1.25.0 project still loads.
5. **The review overlay.** Tick, untick, merge, rename, thumbnails, area
   readout, Place N tools.
6. **Send to Step 2**, with `rot`, `x` and `y` restored on Apply.
7. **Reference-object cross-check and the rim caution.** Test: it warns past
   2 percent and changes no geometry.
8. **Naming defaults and the label guard.**
9. **README and this PRD's status line**, including the heading rename.

Steps 1 to 4 are the feature; step 5 is what makes it usable. **Step 6 is not
droppable**: without the escape hatch the exception this document asks the batch
PRD for is not worth granting and criterion 8 fails. Steps 7 and 8 drop to a
follow-up if the session runs short, as does merge inside step 5, and step 9
shrinks to the heading rename alone.

## Open questions (recommendation first)

1. **A new reference mode, or the existing Custom size with a friendlier
   label?** Recommendation: Custom size plus a `state.scan` flag. A new mode
   means a new branch in `doRectify`, a new save key and a new path through
   corner handling, all to reach the same `rectify` call with the same two
   numbers.
2. **Review as a Step 2 mode, or a modal?** Recommendation: a Step 2 mode. It
   reuses the trace canvas and its viewport; a modal needs its own pan, zoom and
   fit for no gain.
3. **Should the scan also set the layout container?** Recommendation: yes,
   `container.type = 'rect'` with `w` and `h` from the typed numbers. Those are
   the measured inside dimensions, exactly what the rect container wants, and it
   saves re-entering numbers the user has already typed.
4. **Merge as masks or as polygons?** Recommendation: masks, before tracing.
   One loop, no Clipper, no seam.
5. **What is the minimum candidate area?** Recommendation: 0.05 percent of the
   rectified drawer area with a floor of 30 mm squared, exposed as a slider the
   way `minHoleAreaMm2` already is. A loose bolt is 20 mm squared and is not a
   tool that gets a pocket.
6. **May the reference object take over the scale when it disagrees?**
   Recommendation: yes, as a one-click offer that uniformly rescales all N
   polygons, never automatic. This does not reopen the settled decision: the
   typed numbers stay the default and the only automatic scale. It is the remedy
   when the cross-check proves they were measured at the rim.
7. **Touching tools.** Recommendation: out of v1, as scoped. The fix is to move
   two tools apart and take a second photo, or to accept the merge and repair
   through Step 2. Watershed on overlapping hand tools would be the largest
   single piece of work here and would still be wrong often enough to need the
   same review UI.
8. **Where does the scan sit relative to the photo queue?** Recommendation:
   after it, described as the fast rough path. The queue stays the recommended
   way to build a library you will cut from.
9. **Should a scanned item be badged in the layout editor?** Recommendation:
   yes, backed by `source.kind === 'scan'`. It is the only way to tell six weeks
   later which tools got the human pass, and it is what makes the exception in
   the Problem section honest rather than rhetorical.

## Decision needed

Two things, not one. First, the exception to the batch PRD's quality-bar rule:
is a path where tools are traced automatically and reviewed by glance acceptable
at all, given the mitigations above. If not, nothing else here matters.

Second, if yes: sign-off on the scope and the plan, and on the position that the
silhouettes land in `layout.items` rather than in `TraceEditor`, with Send to
Step 2 as the escape hatch. Open questions 3, 6 and 9 change what gets built;
the rest are defaults.

## CHANGELOG
- v1.1 (2026-09-19): Steps 1 to 6 and 8 shipped in v1.27.0. Records the three corrections building it forced (the paperDims transposition, the goStep(2) retrace that would have destroyed a scan, and the two TraceEditor edits the "no new capability" framing hid), the three paper-tuned constants the scan does not inherit, and what remains: step 7's cross-check, merge, and thumbnails.
- v1.0 (2026-09-19): Initial draft, from Sam's 2026-09-19 note on photographing a laid-out drawer and tracing every tool in one pass. Records the three settled decisions (one photo of all four corners, typed drawer width and depth with an optional reference-object cross-check), takes the position that scanned silhouettes land directly in `state.layout.items` with a per-item Send to Step 2 escape hatch rather than refactoring the `TraceEditor` singleton, states the tension with `batch_ingest_prd_v1.0.md`'s shipped quality-bar rule and what exception is being asked for, and proposes a resolution for the README heading collision at line 771.
