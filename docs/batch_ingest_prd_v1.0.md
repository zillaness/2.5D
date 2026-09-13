---
file: batch_ingest_prd_v1.0.md
version: 1.0
author: Sam Cao
created: 2026-09-12
last_updated: 2026-09-12
description: Follow-on PRD to selection_and_organize_prd_v1.2.md, from 2026-09-12 user feedback. Batch ingest queue, snap to grid, and the nesting lane, for a second ultracode build session.
ai_update: Update last_updated and version. Rename file to match. Append changelog at bottom.
---

# PRD: Batch ingest, snap to grid, and the nesting lane

Status: **SIGNED OFF by Sam, 2026-09-13. Build in progress.** · 2026-09-12 ·
target branch `claude/2.5d-photo-stl-s3-y0oodn`

Sam signed off Parts A and B and the Part C lane plan as written, with no
overrides. Every open question takes its stated recommendation, including Part
A open question 1 (auto-advance after save), the only one that changes what
gets built.

Prerequisite met on 2026-09-13: the first session merged Parts A, B and D of
selection_and_organize_prd_v1.2.md and deployed them as v1.24.0, so Step 4
Organize and the folder backends are on this branch.

This is the second half of the work that `docs/selection_and_organize_prd_v1.2.md`
started. That document was signed off on 2026-09-10 and is being built by
its own session; nothing here changes it. Everything in this document
depends on its Part B (Step 4 Organize and the folder backends) having
merged, so this is a **second build session**, run the same way per that
PRD's Part C.

User feedback on 2026-09-12 asked for four things:

1. Bring all the tool photos in first, choose which to trace, trace them in
   sequence, then stop and organize the drawer. **Part A** here.
2. Auto-sort helpers with a minimum offset between tools, a density setting,
   limited or free rotation, and labels. **Already specified** in
   `docs/nesting_prd_v1.1.md` (signed off, unbuilt): `minWeb` is the minimum
   offset, the Dense and Access packing profiles are the density setting,
   `rotationStep` and `rotationFree` give 15°, 90°, free, or locked, and
   label space is reserved per item. That PRD also evaluated
   CutSheetCalculator's nester (libnest2d no-fit-polygon with a shapely
   greedy fallback) and kept its anchor-set idea while rejecting its Python
   runtime and its sheet-minimising objective, which is the wrong objective
   for a drawer. Nothing to re-spec; it becomes **Lane D** in Part C here.
3. Snap to a grid while placing by hand. **Part B** here.
4. Labelling. Built in S3 (`docs/labelling_prd_v1.0.md`, steps 1 to 5 and 7)
   and still undeployed; step 6 (drag and rotate a label) is listed in
   Part C as a small extra for this session.

## Part A: Batch ingest and the tool queue

### Problem

Feedback from users on 2026-09-12: they want to bring in all the tools
first. Attach a folder, or several, of photographs; pick which ones to
trace; trace them one after another; and when enough tools for a drawer are
done, stop, organize the drawer, and export it. Today the app is one photo
at a time from Step 1, and the only way to "bring in the drawer's tools" is
to run the whole three-step flow per tool and save each to the library by
hand before starting over.

#### Current workflow being replaced

Per tool: load a photo in Step 1, set the reference, correct corners, trace
in Step 2, type a library name, Save outline, then load the next photo,
which resets the reference settings. Twelve tools is twelve reference
setups and twelve typed names.

#### What already exists

- Step 1 accepts one photo by picker or drag and drop, and the reference
  settings live in `state.reference`, `state.paper`, and `state.grid`.
- Corner auto-detection runs on load, so a second photo shot on the same
  sheet needs no dragging in the common case.
- The library save handler builds a complete entry from the trace. Part B's
  folder backends (`js/import/folderAccess.js`) give a list of
  `{ path, file }` for any folder.

### Success criteria

1. **All the tools first.** One action ingests every photo in one or more
   folders, or a multi-select of files, into a queue with thumbnails.
2. **Choose, then go.** The user ticks which photos to trace, then Next
   walks the queue: photo into Step 1 with the previous reference settings
   kept, trace in Step 2, save, next. A skipped photo stays in the queue.
3. **Stop whenever.** "Organize what I have" at any point jumps to Step 4
   with every tool traced this session already in the palette and
   selected, so Add all places exactly them.
4. **Nothing retyped.** The library name defaults to the photo's file name
   without extension; the project JSON, if a File System Access folder is
   open, is written next to the photo so the folder becomes the tool
   collection Part B reads.
5. **Resumable.** Reopening the same folder later rebuilds the queue and
   marks as traced every photo that has a project JSON beside it.

### Scope

#### In

- `state.queue`: `[{ id, name, path, file, status, thumb }]` with status
  `pending | traced | skipped`. Session-only; not part of the project save.
  Files are held as `File` references and thumbnails as small data URLs, so
  a queue of a hundred phone photos stays in the tens of megabytes.
- Step 1 gains "Add photos…" (multi-select input, `accept="image/*"`) and
  "Add folder…" through Part B's backends, both appending to the queue.
  Drag and drop of several files or a folder appends too.
- A queue strip above the Step 1 panel: thumbnails with a tick box, status
  badge, Select all, Clear done, and the count. Clicking a thumbnail loads
  it. Visible on Steps 1 to 3; collapsed on Step 4.
- Next and Skip on Steps 1 to 3. Next saves the current trace to the
  library (name from file name, editable), writes the project JSON beside
  the photo when the folder is writable, marks the item traced, and loads
  the next ticked pending photo with the reference settings carried over.
- "Organize what I have" on the strip: jumps to Step 4 with this session's
  traced tools preselected in the palette.
- Resume: when a folder is ingested, a photo with a sibling `<name>.json`
  that parses as a 2.5D project is marked traced and its trace goes to the
  palette without re-tracing.
- Tests: ingest of a synthetic three-file list yields three pending items;
  Next with a fixture trace saves a library entry named from the file and
  advances; Skip advances without saving; a folder with a photo and its
  sibling project JSON resumes as traced; reference settings survive Next.

#### Out

- Automatic tracing of the whole queue without the user. Each tool still
  gets the human pass in Step 2; that is the app's quality bar.
- HEIC decoding. Still the open question from S3; a HEIC in the queue is
  marked `unsupported` with the S3 Tier 1 message.
- Persisting the queue without a folder. Session-only by design.

### Constraints

- No project-file change. The queue is not saved; the folder is the
  persistence.
- The reference carry-over copies settings only. Corners are re-detected
  per photo and never copied, since the sheet moves between shots.
- Memory: never hold more than the current photo decoded at full size.
  Thumbnails are 160 px.

### Design

The queue is a list beside the existing single-photo state, not a
replacement for it. Loading a queue item calls the same path the file
picker calls today, so nothing downstream knows about the queue. Next is
the library save handler plus a folder write plus "load the next ticked
pending item". The carry-over is a snapshot of `state.reference`,
`state.paper`, `state.grid`, `state.bar`, `state.coin`, and `captureFrac`
taken before the load and restored after it, followed by the normal corner
auto-detect.

Writing the project beside the photo uses `serializeProject(false)` (no
embedded photo, since the photo is the sibling file) through the folder
handle; with the directory-input backend the project is offered as a
download instead, once, with a note that a writable folder skips this.

"Organize what I have" records the ids of tools traced this session and
passes them to Step 4, which preselects those palette rows. Add all then
places exactly those.

### Plan

1. Queue state, multi-file input, drag and drop of several files, the
   strip with thumbnails, tick boxes, and Select all.
2. Folder ingest through Part B's backends, including the resume rule for
   sibling project JSON.
3. Next and Skip with reference carry-over, library save with the file
   name, and the folder write or download fallback.
4. "Organize what I have" into Step 4 with preselection.
5. Tests for the five success criteria.
6. README: the batch workflow as the recommended way to do a drawer.

Step 2 depends on `folderAccess.js`; steps 1, 3, and 4 depend on the Step 4
shell. Both come from the Step 4 PRD, so this Part builds only after that
PRD's merge has landed on the branch.

### Open questions (recommendation first)

1. **Should Next auto-advance after the library save, or stop on the saved
   trace?** Recommendation: advance, with Undo returning to it; the point is
   throughput.
2. **Name collisions in the library from identically named photos in
   different folders.** Recommendation: suffix with the parent folder name,
   as Part B does in the palette.
3. **Where does the queue strip live on narrow screens?** Recommendation:
   a collapsible drawer at the top; it is a phone-width app and the strip
   must not push Step 1's photo below the fold.


---

## Part B: Snap to grid in the layout editor

A toggle and pitch (default 5 mm; a 42 mm option when the container is a
Gridfinity bin) on the Step 4 panel. With snap on, item drag positions and
arrow-key nudges quantise to the pitch and rotation-handle drags snap to
90°. Snapping applies to the gesture only, never to stored values
retroactively, so turning it on moves nothing. Stored as
`state.layout.snap: { on, pitch }`, additive.

Tests: a drag ending at 13.2 mm with pitch 5 stores 15; with snap off it
stores 13.2; a rotation drag to 87° stores 90; toggling snap on does not
change any item's `x`, `y`, or `rot`.

One plan step, in the Step 4 panel, after the Step 4 PRD has merged.

---

## Part C: Build instructions for the second session

Follow `selection_and_organize_prd_v1.2.md` Part C exactly (session start,
worktree lanes, the three workflows, the review loop, commit discipline,
version bump and deploy), with these lanes instead:

- **Lane B2** (Part A here, then Part B here): `js/main.js` Step 1 and the
  queue strip in `index.html`, the Next/Skip flow, the Step 4 preselection,
  snap to grid. Sequential inside the lane.
- **Lane D** (`docs/nesting_prd_v1.1.md` steps 1 to 4): `nestLayout()` in
  `js/holders.js` as pure geometry, the conflict-freeness property test,
  notch-reach and minimum-web tests, the 12-tool fixture. Its Nest button,
  profile panel, and the `2p5d.packprofiles.v1` store are that PRD's step 5
  and are wired by the merge agent after Lane B2, since they live in the
  Step 4 panel.
- **Lane E** (labelling step 6, optional): drag and rotate a placed label
  in the layout editor, per `docs/labelling_prd_v1.0.md`. Small; include it
  if the session has room.

Merge order: B2, then D, then E. The version bump is the next minor above
whatever gh-pages carries when this session deploys.

### Prerequisite check at session start

`git log --oneline` must show the first session's merge commits and
`js/version.js` must be above 1.23.0. If not, the first session has not
landed; stop and tell Sam rather than building on the wrong base.

## Decision needed

Sign-off on Parts A and B and the lane plan. Part A open question 1 (auto-
advance after save) is the only one that changes the build.

## CHANGELOG
- v1.0 (2026-09-12): Initial draft from the 2026-09-12 user feedback, split out of selection_and_organize_prd so the running build session is not disturbed.
