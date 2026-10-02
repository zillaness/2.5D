---
file: BURNDOWN.md
version: 1.35
author: Sam Cao
created: 2026-09-04
last_updated: 2026-10-02
description: Ledger for the 2026-09-04 token burndown on the 2.5D holders branch.
ai_update: Update last_updated and version. Filename is fixed (the burndown skill expects BURNDOWN.md), so do not rename. Append a ledger line after every committed unit and keep the NEXT line current.
---

# Burndown — 2026-09-04 (5h window reset 05:10 PDT, weekly reset 08:00 PDT)

Branch `claude/2.5d-photo-stl-s3-y0oodn`, starting from v1.23.0 (`44cbe75`).
Units are committed and pushed one at a time so a mid-unit stop costs at most
one unit.

## Budget notes
Calibrated against Sam's `/usage` readings earlier tonight: roughly **$1.33 of
notional spend per percentage point** of the 5-hour bucket, so a full window is
about **$133**. Self-stop at ~$110 (85%), checkpoint, and re-arm rather than
dying at the wall. The dollars are notional API-list pricing, not a bill;
`isUsingOverage` is false.

## Ledger
- 05:26 ✅ e2e suite self-reports its check total — committed c44ba94
- 05:34 ✅ doc sweep: README roadmap rebuilt for v1.23.0, Tests section notes the
  count line, holders-prd records the v1.18–v1.23 follow-on work — committed below
- 05:47 ✅ docs/nesting_prd_v1.0.md drafted (288 lines, DRAFT — not implemented) — committed below
- 05:56 ✅ docs/printed_tile_registration_v1.0.md design note (130 lines) — committed below
- 05:56 ⏸ queue exhausted; resumed on Sam's direction
- (later) ✅ nesting PRD v1.1: packing profiles, custom profiles, label-aware webs — f719de3
- (later) ✅ labelling PRD v1.0 drafted — committed below
- ✅ Sam signed off on both PRDs; implementation started
- ✅ labelling step 1: item.label plumbing (field, UI, reset, persistence) — committed below
- ✅ labelling step 2: layoutLabelGeometry() — placed glyph loops in layout mm
- ✅ labelling step 3: layoutLabelConflicts() + per-process minimum cap height
- ✅ labelling step 4: engrave layer in both SVG export paths — committed below
- ✅ labelling step 5: labels carve into printed inserts as recesses — committed below
- ✅ labelling step 7: UI toggle, process settings, legibility readout — committed below
- ✅ Sam signed off docs/selection_and_organize_prd_v1.2.md; status flipped in the repo — d7b2771
- ✅ Part A selection modes: 7 plan steps in a worktree lane, 319 checks
- ✅ Part B Step 4 Organize: 9 plan steps in a worktree lane, 338 checks
- ✅ Part D laser constructions: 6 plan steps in a worktree lane, 325 checks
- ✅ Three-lens adversarial review loop over all three lanes: 43 findings raised,
  6 refuted away, 26 fixed in place. Caught an innerHTML injection from a
  project file's plate-shape name and a pre-release project inheriting the live
  session's plate offset.
- ✅ Merged A, then B, then C. One real conflict in js/main.js, where Part B had
  extracted the export handlers into shared functions and Part D had rewritten
  them inline for a two-part layered build. Resolved by keeping the shared
  functions and folding the layered and base-sheet paths into them.
- ✅ Merged suite: 472 checks, all passing, which is the 275 baseline plus 44,
  63 and 50 from the three lanes, so nothing was lost in the merge — 47ba7c3
- ✅ Deployed v1.24.0 to gh-pages, carrying the unreleased labelling work — 3cae543
- ✅ Sam signed off docs/batch_ingest_prd_v1.0.md; status flipped in the repo — ce5e8ca
- ✅ Lane B2, batch ingest + snap to grid: 7 plan steps, 537 checks after review
- ✅ Lane D, nesting steps 1-4: nestLayout() as pure geometry, 511 checks after review
- ✅ Lane E, labelling step 6: label drag and rotate, 489 checks after review
- ✅ Leaner review loop: severity-scaled refuters, settled questions filtered at the
  lens stage, 2 rounds by default. B2 and D both converged clean.
- ⚠ The monthly spend limit was hit mid-review. 18 of 124 agents died, including
  lane E's round-2 fix agent. Three lenses had independently found that a base
  label auto-placed inside its own pocket could never be grabbed, which made
  label drag dead for the layered construction; their refuters never voted, so it
  showed as dropped at 0 votes rather than refuted. Fixed by hand in the main
  loop instead: glyph-level hit test before the tool — 411fccf
- ✅ Merged B2, then D, then E. Four additive conflicts in js/main.js and
  js/ui/layoutEditor.js, all snap-versus-label state; both sides kept.
- ✅ Merged suite: 593 checks, all passing, which is 472 plus 65, 39 and 17, so
  nothing was lost in the merge — 931657c
- ✅ Deployed v1.25.0 to gh-pages — 90717c3
- ✅ docs/resume_editing_prd_v1.0.md drafted (getting back to a traced tool:
  queue re-edit, honest naming of the two project saves, autosave last)

## 2026-09-19
- ✅ README: the Snap to grid subsection lane B2 never wrote. Part A had taken
  the lane's single README anchor, so the feature shipped in v1.25.0 reachable
  and undocumented — ec6fe67
- ✅ README: frontmatter added, per Sam's ruling below. Points at Roadmap,
  Shipped as the document's changelog rather than adding a second one — 2e35459
- ✅ Resume editing step 1: queue re-edit, and with it Undo after Next.
  601 checks, all passing, no console errors (593 before) — 6322758, v1.25.1
- ⚠ **`docs/resume_editing_prd_v1.0.md` was wrong about the fact it argued
  from,** found while building step 1 and corrected in place as v1.1.
  `serializeProject(includePhoto)` gates only `photo`, the original camera
  frame; `rectified` is written by both saves whenever one exists, and one
  always exists once anything is traced, because tracing happens in Step 2 and
  Step 2 rectifies. So the small save is not a few KB, Step 2 is not disabled
  under it, and it does not cost the ability to edit the trace. It costs the
  corners. The suite knew: test/e2e.mjs:6922 has said "the rectified copy
  stays" since before the PRD was written. Steps 1 and 2 stand; **steps 3 and 4
  were scoped against the wrong difference and need Sam's call.**
- ✅ docs/drawer_scan_prd_v1.0.md drafted: one photo of a laid-out drawer with
  all four corners in frame, typed width and depth for scale, every tool traced
  in one pass. Takes the position that the silhouettes land in
  `state.layout.items` rather than refactoring the `TraceEditor` singleton, and
  states plainly that it asks for an exception to the batch PRD's quality-bar
  rule — cca8870
- ✅ Nesting steps 5 and 6: profiles as data with their normaliser and the
  "modified" comparison, comfortWeb as a real scoring term, and label
  footprints the packer reserves for. 609 checks — 48eed42, v1.26.0
  - ⚠ comfortWeb did not exist in the scorer at all. The profile table has
    listed it since the PRD's v1.0, but steps 1-4 shipped no spread term, so a
    profile carrying comfortWeb 12 would have exposed a dead knob. Built so
    that at 0 it is identically zero and no pack that predates it moves.
  - ⚠ A reserved label is carried as its own loop, not unioned into the pocket
    as the PRD says: the label sits clear of the pocket by its margin, so the
    union is two disjoint paths and every test in nestLayout takes one loop.
    Carried beside the pocket the way the notch disc already is.
- ✅ Nesting steps 7 and 8: the Nest button, the profile picker with all seven
  values exposed, per-item pin and angle lock, undo over the whole nest, the
  2p5d.packprofiles.v1 store, and the resolved-values persistence rule.
  618 checks — 48ab6cd
- ✅ README: the auto-sort section said "None of this has a button yet", which
  stopped being true. Rewritten to describe the panel, and the nesting PRD's
  status and plan updated to match what shipped.
- ✅ Nesting step 9: seam corridors, reserved through a new `obstacles` option
  on nestLayout so a corridor behaves exactly as a pinned pocket without being
  an item. Dropped automatically, and reported, when keeping the band clear
  costs a tool its place. 624 checks — v1.26.0
  - ⚠ Planned against the bare bed, not the tab-shrunk one, so puzzle tabs
    move the real seams a few mm off the reserved band. Documented in the
    README rather than left as a surprise; the preference-not-constraint rule
    already tolerates it.
- ✅ **docs/nesting_prd_v1.1.md is complete**, steps 1-9, bar the progress
  reporting step 7 listed.
- ~~▶ NEXT: resume-editing step 2 (library re-edit, now with the load-time
  prompt Sam chose for open question 3), then autosave, step 5 and independent
  of everything. Steps 3 and 4 need Sam's call first, see below.~~
  **STALE, corrected 2026-09-21.** Steps 2 to 6 all shipped later the same day,
  across v1.25.1 to v1.26.3, and steps 3 and 4 were rebuilt against the
  corrected fact rather than waiting on a call. This NEXT line was never
  updated, and it was the only place the resume-editing arc was tracked, so the
  ledger went on reporting shipped work as pending. Verified in code on
  2026-09-21: `js/main.js:6949` is the library re-edit, `js/main.js:6252` and
  `js/import/folderAccess.js:166` are the autosave slot, `js/main.js:6697` is
  the honest save wording, and `js/main.js:408` is the reason on a disabled
  Step 2. The PRD's own status line had it right all along.

## 2026-09-19, later: the drawer scan
Sam put task 4 in the work queue, which granted the exception the PRD asks of
batch_ingest_prd_v1.0.md's quality-bar rule and signed off the `layout.items`
landing position. Steps 1 to 6 and 8 shipped as v1.27.0; step 7 did not.

- ✅ Step 1, the resolution the feature stands on: 5.71 px/mm on a 560 mm drawer
  against 2.86 at the default, warp 606 ms, segmentation 899 ms, a 2 mm bar
  measuring 2.1 mm — b862f94
  - ⚠ Found: **paperDims SORTS custom width and height by orientation**, so a
    560 by 400 drawer would have rectified transposed on the first photo.
- ✅ Step 2, segmentObjects, bbox-cropped per component: 26 KB of masks against
  1641 KB full-frame on the fixture
- ✅ Step 3, js/scan.js, retrace's pipeline in retrace's order, scoped per
  component. Three paper-tuned constants deliberately not inherited.
- ✅ Step 4, landing: seven tools at a worst position error of 0.0 mm, pinned,
  badged — b4888d7
- ✅ Step 5, the review as a mode on Step 2 — 8ab4555
  - ⚠ Found: **goStep(2) would have destroyed a scan silently** on any corner
    nudge, by re-rectifying and retracing the drawer as one tool. Guarded and
    tested. This was the single most dangerous line for the feature.
  - ⚠ "A mode on Step 2, no new capability" understated it by two mandatory
    TraceEditor edits.
- ✅ Step 6, Edit in Step 2, with the pose round trip exact to 1e-6 mm — ecd724a
- ✅ Step 8, the auto-name export guard, plus a Name field in the drawer panel,
  because the review had been the only chance a scanned tool ever got at a name
- ▶ NEXT: **step 7**, the reference-object cross-check and the one-click
  rescale of the PRD's open question 6. The rim caution shipped as hint text
  with the numbers, so the sharpest accuracy risk is named where the corners
  are placed; what is missing is the independent measurement that would catch a
  mis-measured drawer. Also outstanding and named in the README: merging two
  candidates that were touching, and thumbnails in the review list.

## 2026-09-21: doc reconciliation
Three places where the record had drifted from what shipped, all fixed in one
commit. No code changed.

- ✅ README Roadmap: nesting and tool labels were still listed under **Next up,
  Awaiting sign-off**. Both shipped, nesting across v1.25.0 and v1.26.0 and
  labelling steps 1-7 in v1.25.0. The README *body* documented both correctly
  (the auto-sort section and the labels section), so this was the Roadmap block
  alone, which is the same failure mode as the Snap to grid miss on 2026-09-19:
  a lane updates the prose and nobody updates the map. Moved into Shipped as a
  third paragraph covering the v1.24 to v1.27 arc, and Next up rewritten to the
  two things that are actually next, resume-editing steps 2 and 5 and drawer
  scan step 7.
- ✅ README Known gaps: the three measured defects from the v1.26 and v1.27 work
  were recorded here and nowhere a user would look. Added the nest timings as
  measured (3.5 s Dense, 12.8 s Access on 30 items), the unbounded overfull
  drawer, and the re-encode-per-re-edit JPEG loss.
- ✅ This ledger: the Blocked list still said nesting needed sign-off, the still
  open list still asked whether the drawer-scan quality-bar exception was
  granted when a section further up records it being granted, and the lower
  sign-off list was a version behind on both nesting and batch ingest. All
  struck with what actually happened.
- ✅ Step 4 palette name truncation fixed, the first of the "noticed in passing"
  items to be cleared. 694 checks, all passing, no console errors, dist rebuilt
  and smoke-tested — v1.27.4.
- ✅ Nest cheap-reject in `validAt`, plus `test/nest-bench.mjs` — v1.27.5. An
  axis-aligned rectangle that Clipper confirms lies inside the container, so a
  candidate whose bbox is inside it skips the containment call outright; the
  same for the finger disc against `inner`. Exact rather than approximate, so
  `tests` does not move and the pack is identical. About 1.7x on Access-like
  configs and nothing at all on the rectangular no-label no-notch control,
  which is the right shape for a change that only skips work it can prove is
  unnecessary. 694 checks, all passing.
  - ⚠ Three wrong attributions were made and discarded on the way here, all
    from timing an unwarmed page. See the corrected gap note above; the lesson
    is in the bench's own comments so the next person does not repeat it.
- ▶ NEXT: Dense's candidate count, which is now the only nest cost worth
  attacking, and drawer scan step 7 once open question 6 has Sam's call.

## 2026-09-27: the calibration sheet
- ✅ docs/calibration_sheet_prd_v1.0.md drafted (DRAFT, not implemented), from
  Sam's question about a printable fiducial that works whether or not the print
  scale can be trusted. One sheet: a printed frame gives the shape, the paper's
  physical edges give the absolute scale, and the ratio between the two is the
  print scale, measured rather than assumed. Current workflow mapped in code
  first, per Sam's rule.
  - ⚠ The first sketch in chat put a chessboard across the middle of the sheet.
    Wrong: `computeDiffMap` marks everything that is not paper-coloured as
    object, so ink under the object is traced as part of it. The PRD is a
    frame, not a fill, and a frame turned out to need no coded markers at all,
    which removed the decoder question.
  - ⚠ Found while mapping: nothing checks the selected paper size against the
    photo. Letter selected, A4 photographed, and every trace is 2.8 percent wide
    and 5.9 percent short with no warning. The sheet fixes it; plan step 1 of the
    PRD does not, on plain paper.
- ✅ PRD revised to docs/calibration_sheet_prd_v1.1.md from Sam's notes on v1.0:
  an encoded frame (layout version, paper size, sheet number, position,
  checksum), the paper edge double check as a verdict table, printing from the
  app as its own step, phase 2 for several sheets fitted on one plane around a
  large part, and phase 3 for parallax from EXIF focal length or a raised sheet.
  - ⚠ Recorded in the PRD because it will be asked again: no flat pattern can
    measure the camera's height from a straight-down photo. A near camera with a
    wide lens and a far one with a narrow lens take the same picture of a plane,
    so parallax needs one fact from off the plane, a focal length or a surface
    of known height.
  - ⚠ Also recorded: centring the part under the camera, which the README
    advises, does not reduce the size error from parallax, only the sideways
    shift. The README line should gain that when phase 3 lands.
- ✅ Sam approved all twelve suggestions against v1.1, 2026-09-29, and asked for
  one PRD covering the sheets and the outstanding work. Written as
  docs/calibration_and_backlog_prd_v1.2.md (renamed from the calibration sheet
  PRD to fit the wider scope): Part A is the sheets with the twelve folded in,
  including a print-job ID in the payload; Part B is the backlog, drawer scale
  first.
  - ⚠ Found writing it: the README's Next up had drawer scan merge backwards,
    as joining tools "the segmenter split because the tools were touching".
    Touching tools arrive as one candidate and would need splitting, which the
    drawer scan PRD keeps out on purpose; merge is for one tool split in two.
    Written by this session on 2026-09-21, corrected in the same commit.
  - ⚠ Also stale in the README: the nest bullet still called the work a
    cheap-reject pass in `validAt`, which shipped in v1.27.5.
  - ⚠ Found reading `nestAngles`: the Rotation step control stays live when Free
    rotation is off, where it does nothing unless a tool is set free. Part B.4.
- ▶ NEXT: superseded by the 2026-10-02 section below.

## 2026-10-02: building the calibration and backlog PRD
Sam approved docs/calibration_and_backlog_prd_v1.2.md: Part A phase 1 with the
payload as listed, Part B items B.1 to B.4, every open question on its
recommendation. Phases 2 and 3 wait for their own sign-off after phase 1's
real-photo checkpoint. Building in the PRD's suggested order.

- ✅ Sign-off recorded; PRD status flipped.
- ✅ Part A step 1a, edge-fitted corners (`js/edgeFit.js`), wired into
  `autoDetect` and the underside photo. On the suite's photo the corners land
  0.034 px from truth against 2.88 px for the coarse detector; 0.02 to 0.1 px at
  3000 x 4000, turned 30 degrees, under k1 0.10, and with a tool across an
  edge. An edge with no contrast makes it decline and return the coarse
  corners untouched. 699 checks, all passing, no console errors; dist rebuilt
  and smoke-tested — v1.28.0.
  - ⚠ The suite's own corner truth was half a pixel off the convention
    `rectify` reads in. A canvas path vertex at x is the boundary of pixel x,
    whose centre is x + 0.5, while `rectify` samples pixel k at coordinate k. The
    old check compared against the drawn corner, so a perfect fit would have
    read 0.71 px out. The new check compares in `rectify`'s convention and says
    why in a comment.
- ✅ Part A step 1b, the wrong-paper check (`js/paperAspect.js`, `js/exif.js`,
  a warning with a one-click switch under Step 1's paper size). 708 checks,
  all passing, no console errors; dist rebuilt and smoke-tested — v1.28.1.
  - ⚠ **Criterion 14 as written was not achievable, and was revised.** Tip the
    phone about one axis, the commonest tilt, and one pair of the sheet's edges
    stays parallel in the photo; the vanishing-point construction then cannot
    find the focal length, and without it the true proportions are
    undetermined. Measured over 144 poses: with the focal length known, zero
    false flags and zero misses to 25 degrees; without it, zero false flags
    over 216 poses including off-centre crops, every straight-down A4 caught,
    and fewer caught as tilt grows.
  - ⚠ So EXIF reading came forward from phase 3. `js/exif.js` reads the two
    focal-length tags and the pixel dimensions, nothing else, and the focal
    length is trusted only when the photo is still the size the camera wrote:
    a crop moves the principal point, a resize changes the diagonal.
  - ⚠ The suite's own step-1 photo, drawn as A4, is geometrically a
    Legal-proportioned sheet under an ordinary centred camera: its corners were
    placed by hand, not by a camera. Step 1 now shows "looks like Legal" on it.
    Harmless, nothing switches, and the trace tests use exact corners; the UI
    test renders a camera-made photo instead.
- ✅ Part A step 2, the real-photo harness: `test/realPhotos.mjs` (the
  measuring module, shared), `test/real-photos.mjs` (`npm run real`, with
  `--record`), `test/fixtures/real/` (README, sidecar format, baselines) and
  `test/mark-photo.html` with `test/mark-photo.js` (downscale to 2400 px, a
  fresh EXIF carrying only the focal length and the new pixel size, a loupe,
  optional corners for a pale desk). Each photo loads through the app's own
  file input, so detection, edge fit, EXIF and the wrong-paper check all run
  as they do for a person; the two rule marks go through rectify's own
  homography construction. A camera-rendered A4 with a graduated rule drawn
  on it is the self-test, through the marking page's encoder and the same
  path: 150 mm measures 150.004 mm. 717 checks, all passing, no
  console errors; dist rebuilt and smoke-tested — v1.28.2.
  - ⚠ **The auto lens estimate is too coarse to apply blind.** On the
    distortion-free self-test, `estimateDistortion` picks k1 = -0.011, which
    turns the 0.004 mm error into 0.360 mm over 150 mm. The harness reports
    the lens-fit figure without asserting it, so this is visible on every run.
    Open question 3 (apply the lens fit automatically in sheet mode) stands,
    but step 7 must show its printed-line fit beats this floor by an order
    of magnitude before it is switched on, and plain-paper mode should keep
    the slider as the only way in.
  - ⚠ A photo at 2400 px of an A4 from 420 mm is about 4.3 px/mm, not the
    8 px/mm the rectifier caps at. The fixture budget (open question 15) was
    chosen for size; it also means the real set measures the app at the
    resolution a phone held back for a large part gives, which is the
    harder case and the right one to pin.
- ✅ Part B.1, the coin drawer check. `js/scan.js` gains `fitCircle`,
  `findCoinCandidate`, `coinScaleCheck` and `rescaleParts`, all pure; the
  review panel gains a coin block (`index.html`), the trace editor a handle
  drag in scan mode (`onScanPress` / `onScanDrag` / `onScanDragEnd`), and
  `js/main.js` the find, the verdict, the one-click rescale with undo, and
  `source.scale` on every placed tool. Tested on a camera-rendered drawer,
  60 mm deep from 800 mm with rim corners: the coin reports 8.1 percent small
  against a true 7.5, one click brings a 120 mm bar to 120.9 mm at (39, 39)
  from (40, 40), undo is exact, the factor round-trips a project, and floor
  corners read 0.5 percent with no offer. 726 checks, all passing, no
  console errors; dist rebuilt and smoke-tested — v1.29.0.
  - ⚠ **The refine pass shrinks round shapes.** Simplify then Chaikin keeps a
    rectangle's bounding box but cuts inside a convex curve: the refined
    outline of a 24 mm disc measured 0.3 mm under, which would have put the
    coin check 1.3 points off on its own. The check fits the raw boundary
    trace instead (`part.disc`). Round tools in a scan, sockets say, carry
    the same bias in their pockets; worth a measured look when B.3's quality
    gate is built, since the same pass runs under retrace.
- ✅ Part B.2, thumbnails: every review row shows a crop of the rectified
  drawer around its candidate, the same `thumb` a library entry carries
  (`thumbFromImage`, 256 px JPEG), attached in `scanRun`, scaled with the
  outline by `rescaleParts`, and carried onto the placed item so Step 4 draws
  it in the pocket. 728 checks, all passing, no console errors; dist
  rebuilt and smoke-tested — v1.29.1.
- ✅ Part B.2, merge: `mergeParts` in `js/scan.js` joins the chosen
  candidates' masks (each part now carries its component as `src`) and traces
  once, so the pocket is one loop with no seam; a gap is bridged by the
  smallest closing that joins them, up to 12 mm, and the width bridged is
  reported. Shift-click chooses, in the list or on the photo (the pick now
  receives its event); Merge replaces the chosen with one, named for the
  first, rescaled if a coin rescale is applied, with a fresh thumbnail; Undo
  merge restores. 735 checks, all passing, no console errors; dist
  rebuilt and smoke-tested — v1.29.2.
  - ⚠ A closing fills every concavity narrower than the gap it bridges, so a
    merge across a 10 mm gap also fills a 6 mm notch elsewhere on the tool.
    Said in the README and the hint; Edit in Step 2 is the repair.
- ✅ Part B.4, the two small fixes. The nest panel's Rotation step select is
  dimmed with a note (`laySyncRotStep`) unless Free rotation is on or a tool
  carries `rotLock: 'free'`, re-checked on every panel sync and lock change.
  A loaded project's rectified JPEG is kept on `state.rect.jpeg` (and
  `state.back.rect.jpeg`) and written back byte-identical; doRectify and the
  90 degree turn make a new rect object with no jpeg, so a changed
  rectification is encoded fresh. 738 checks, all passing, no console
  errors; dist rebuilt and smoke-tested — v1.29.3.
  - ⚠ A hand-written minimal project (app, version, trace, rectified, pxPerMm
    and a one-region list, nothing else) is refused by Load from text: the
    paste handler catches whatever loadProject throws on the missing fields
    and says the JSON is invalid. Every project the app writes loads, and the
    library import path reads the same minimal shape without complaint, so
    this is a hand-edited-file edge; recorded, not fixed.
- ✅ Part A step 3, the layout and the code. `js/calibSheet.js`, pure: layout
  v1 as insets from the paper edge (`layoutGeometry` for any stock in the
  paper table with a code; Letter 28 words, A4 30, A3 46, exactly the PRD's
  table), the 34-bit word with its CRC-8 (`encodeWord` / `decodeWord`), the
  clock pattern with its missing tooth, `sheetCells` and `sheetSVG` in real
  millimetres with the ruler and the label. `test/freeze-layout.mjs` wrote
  `test/fixtures/calib_layout_v1.json` once and refuses to run again; the
  suite regenerates both stocks and compares, failing with the PRD's message.
  31,680 words round-trip, 73,440 single-cell flips are all caught, an A4
  sheet's cells read back as its 30 words. 747 checks, all passing, no
  console errors; dist rebuilt and smoke-tested — v1.30.0.
  - ⚠ **Layout v1 is now frozen.** From this commit any change to
    `js/calibSheet.js` that moves a rectangle or a cell fails the suite until
    a v2 layout is added beside it. Sam has not printed a sheet yet, so if the
    first real print shows a flaw in the layout, the freeze can be lifted
    with `--force` before anything is in the field; after that it cannot.
- ✅ Part A step 4, printing from the app. A "Print calibration sheets"
  button under Step 1's paper size opens a panel: paper (Letter or A4,
  defaulting to the picker's), 1 to 8 sheets, Print, Download SVG, the
  Actual-size, cardstock and matte-paper advice, and the sets printed from
  this browser. `printPageHTML` (pure, in `js/calibSheet.js`) is one
  document with a sheet per page and `@page` at the stock's size with no
  margin; it prints from a hidden iframe, which works where a popup would be
  blocked. The job is `drawJob(clock, taken)`, Knuth's hash of the injected
  clock stepped past jobs on record, so two of one person's sets never share
  a code while the record lasts; each print and download is recorded
  (`2p5d.calibprints.v1`: job, date, paper, count, layout). 754
  checks, all passing, no console errors; dist rebuilt and smoke-tested —
  v1.30.1.
  - ⚠ The first draft of the job hash multiplied a millisecond clock by
    2654435761 in doubles, which overflows 2^53 and zeroes the low byte:
    every job was 00. Caught by the test; now `Math.imul` and the high byte,
    256 distinct jobs over 2000 consecutive seconds.
  - ⚠ Inserting a test block with `String.replace` duplicated the suite's
    first 15,000 lines: the block contained a `$\`` sequence, which a string
    replacement reads as "the text before the match". Restored from git;
    every splice now passes a function as the replacement.
- ✅ Part A step 5, SVG-rendered synthetic photos: `test/sheetPhoto.js`, a
  browser module the suite imports. The sheet's SVG is taken from the print
  page's own HTML, rasterised flat at 8 px/mm onto the real stock through a
  print affine (scale per axis, anchor at the centre or the top-left corner,
  registration offset, feed skew, ink past a printer margin dropped), with
  objects laid on it; then a centred pinhole camera or a given quad, the lens
  (k1), blur, deterministic noise, and JPEG. Every stage returns its truth:
  `designToPhoto`, the corners in rectify's convention, the cells, the print
  affine. Checked by sampling the photo where the truth says ink and paper
  are, for 1:1, 96 percent about the centre, a Letter layout on A4 at 94
  percent from the corner with offset and skew, a swallowed bottom side, the
  lens, blur and noise. 760 checks, all passing, no console errors;
  dist rebuilt and smoke-tested — v1.30.2.
- ✅ Part A step 6, recognition: `js/calibDetect.js`, `recogniseSheet(image,
  roughCorners, paperMm, {k1})`. Pass 1 walks a profile every millimetre
  along each rough side from 8 mm outside the paper edge to 40 mm inside,
  finds the paper edge as the first bright step and the frame as the first
  dark dip of frame width; a side is a frame line only if its dips form an
  unbroken run of 15 mm. Pass 2 samples the clock row and the two data rows
  every quarter millimetre behind the dip centre interpolated between
  profiles, placed by the dip's own width (2 mm of ink at the local print
  scale), so a bowed or scaled frame still has its track found. Black clock
  runs give the cell pitch and the word boundaries; data cells are read at
  the positions the clock implies, both directions, and only words passing
  the CRC and agreeing on identity and rotation survive. Output: identity,
  rotation, every clock cell as a design-to-photo point, every frame dip as a
  point on a design line, the paper-edge points. On the renderer at 5.5 px/mm:
  all 28 words and 224 points at 0.18 px RMS for 1:1, blur and noise, a lens
  known or unknown, corners 5 mm off, a 96 percent print and a sheet upside
  down (rotation 2); 20 words with the left side covered, 22 with the bottom
  swallowed, 9 with 40 percent out of frame; a plain sheet says "no frame".
  120 to 330 ms on a 4 MP photo. 770 checks, all passing, no console
  errors; dist rebuilt and smoke-tested — v1.30.3.
  - ⚠ **The ruler's digits can pass for a frame line.** They are 2.2 mm tall,
    all one height, within 40 mm of the bottom edge, and a profile through a
    "1" is a frame-width dip; with the bottom frame swallowed by a printer
    margin the first draft fitted a clean line through them and handed step 7
    a bogus side. A frame line is continuous and glyphs are dots, so the 15 mm
    run gate was added; a layout v2 should still keep digits out of that band.
  - ⚠ The first two-pass draft lost words at every chunk boundary: a track
    sample just past a chunk's last profile fell outside that chunk's region.
    Every bracketing region is now tried. Worth remembering for anything else
    that reads a photo in chunks.
- ✅ Part A step 7, the fit: `js/calibFit.js`, `fitSheet(rec, w, h, {k1})`.
  The homography is fitted photo-to-design (G), where a frame dip's "lies on
  design line y = 11" and a clock cell's position are both linear in G's
  entries, by the 8 x 8 normal equations after Hartley normalisation of both
  sides; H is G's inverse. The lens term is a golden section over k1 with the
  homography re-fitted at every trial, so the figure minimised is the figure
  reported. Trimming drops gross misreads only, points and lines against
  their own spread and never more than a tenth of either, and the fit figure
  is the RMS over everything recognised, trimmed or not. On the renderer: the
  window maps to 0.003 mm RMS at 1:1 with k1 0.0003; one side covered is
  0.033 mm from the full fit and the bottom swallowed 0.029 (criterion 6,
  0.1); rough corners 5 mm off are 0.0025 mm from it (criterion 7, 0.05); k1
  0.1 is recovered as 0.1005 and withholding it takes the figure from 0.014
  to 0.56 mm (criterion 8); a 1.2 mm bend takes it several times over with
  every cell kept; a 96 percent print fits to 0.0035 mm; two sides fit the
  visible window to 0.076 mm; blur and noise to 0.025 mm. 36 ms. 779
  checks, all passing, no console errors; dist rebuilt and smoke-tested —
  v1.30.4.
  - ⚠ **A trimmed fit hid a bent sheet.** The first draft trimmed points and
    dips against one shared spread; 891 precise dips made the spread tiny,
    every clock cell that disagreed was dropped (151 of 224 on the bent
    sheet, 212 on the noisy one), and the figure read 0.03 mm for a sheet
    that was not flat. Now per class, capped, and reported untrimmed. The
    renderer gained a `bend` option for this.
  - ⚠ The lens term absorbs part of a bend (k1 read -0.024 on a flat lens
    with a 1.2 mm hump). The guidance in step 9 should say "flatten the
    sheet" before "the lens is wrong" when the figure is high and the frame
    lines disagree with each other.
- ✅ Part A step 8, the sheet in Step 1. `js/calibVerdict.js`: the paper
  edges through the fit into design millimetres, a five-parameter rectangle
  (scale across and down, rotation, two offsets) whose aspect names the stock
  whatever the scale, and the verdict table as the PRD wrote it. `js/main.js`
  gains `sheetRecognise` after every corner placement, by the detector or a
  drag (debounced, re-fit and snap, open question 4), with a checkbox that
  lets a person's corners rule; the corners become the paper's own edges
  through the fit, or the design taken as true when they cannot be seen; the
  lens term is applied with the slider as override (open question 3); the
  picker is overridden by the edges with a message; the panel names the
  sheet, the verdict and the fit figure; the corner editor draws the fitted
  frame and the measured paper. The print check records itself whenever a
  sheet is read with its edges visible, keyed by job and sheet, and a white
  desk photo of the same sheet uses it and says so. Through the app's own
  load path: 100.00, 96.00 and 94.00 percent prints read to 0.01 percent per
  axis with corners within 0.1 px, the 0.5 degree feed skew is read, a Letter
  layout on A4 is named as such and measured against A4, a wrong picker is
  overridden, the white desk uses the record and lands within 0.1 px, no
  record gives "unverified", the switch holds, and an 80 x 50 object traces
  to 79.98 x 49.94 on the 96 percent sheet, identical to the 1:1 sheet.
  788 checks, all passing, no console errors; dist rebuilt and
  smoke-tested — v1.30.5.
  - ⚠ **The detector finds the frame, not the paper.** The frame line is the
    strongest boundary in a sheet photo, so `detectPaperCorners` takes the
    window for the sheet and the edge fit snaps to the frame's inner edge.
    Recognition's profiles started 8 mm outside that edge, on paper, and
    took the frame's own inner edge for the paper edge. A paper edge now
    needs 3 mm of desk before it, and the reach outward is 40 mm, which also
    covers the far side of a 94 percent corner-anchored print.
  - ⚠ On a white desk the 80 mm profile is paper but for 5 mm of ink, so a
    fifth-percentile "ink level" was paper and every profile failed its
    contrast test. The darkest percent now.
  - ⚠ The renderer treated the sheet's outer half pixel as desk and shaved
    0.06 mm off every edge: scales read 100.07 and corners sat 0.6 px off
    until it was found. Fixed in `test/sheetPhoto.js`; the earlier figures
    in this ledger for steps 5 to 7 were measured with the shave in place
    and are slightly pessimistic.
  - ⚠ Criterion 4 is bounded by rectify's 1600 px cap, 5.7 px/mm on Letter,
    not by the sheet: before the renderer fix the object read 80.11 on both
    sheets, after it 79.98 on both. The sheet owes equality with 1:1, which
    it delivers exactly; absolute accuracy under 0.1 mm needs the cap raised,
    which the drawer scan already does for its own path.
- ✅ Part A step 9, photo-quality guidance: `photoGuidance` in
  `js/calibVerdict.js`, pure, three signals from what recognition already
  measures (pixels per millimetre on the sheet from the fitted corners, the
  share of code words read on the sides that were found, the fit figure),
  one specific instruction each past its threshold, shown under the sheet
  panel. Through the load path: a good photo says nothing; a sheet at 3.5
  px/mm says move closer or use the 2x lens; blur 2.8 px with noise reads 16
  of 28 words and says hold still, tap to focus or move the light; a 3 mm
  bend gives a 0.40 mm fit and says tape the corners down or use cardstock.
  793 checks, all passing, no console errors; dist rebuilt and
  smoke-tested — v1.30.6.
  - ⚠ **The line-only fallback is not built.** A code track too blurred to
    read at all (3.2 px of blur at 5.5 px/mm) yields no words, recognition
    returns `lineOnly`, and Step 1 treats the photo as plain paper: no
    verdict, no guidance. The PRD's fallback names the layout by the frame's
    aspect ratio, but four frame lines alone fix a homography for any aspect;
    naming Letter (0.753) against A4 (0.684) needs the camera assumption
    `js/paperAspect.js` already makes, sharp with EXIF and ambiguous when
    tilted without it. Worth building on that module in step 10 or later; the
    blur that defeats the code is well past where the guidance fires.
- ✅ Part A step 10, segmentation and integration. The sheet's clean window
  is carried into the rectified image through the construction rectify used
  (`sheetWindowPx`), and `computeDiffMap` takes it as a polygon rasterised
  to one x-range per row: the paper colour is sampled just inside it and
  everything outside, the printed band and the desk, is background outright.
  `retrace` measures the outline's distance to the window and the trace
  info says when it runs within 1 mm of the band. A project gains an
  additive `sheet` block (identity, verdict, fit figure, lens term) and a
  loaded project's corners are never re-fitted; the panel names the sheet
  it was saved with. Coin, scan and the queue path checked. On the renderer:
  the diff map reads 0 on the track and the frame, an object 0.5 mm from the
  window's edge traces as itself at 39.99 x 29.90 mm with the warning, the
  same object mid-window traces 40.12 x 29.86 with none, saved corners
  reload with zero drift, a project without the block loads as before, and
  a sheet photo through the file input is read on load. 801 checks,
  all passing, no console errors; dist rebuilt and smoke-tested — v1.30.7.
  - ⚠ Recognition took the paper picker's size as its rough geometry, and a
    picker left on a drawer's custom 120 x 100 mm, as the scan tests leave
    it, made a Letter sheet unreadable in the full run while the block alone
    passed. A plain paper stock is used as picked; anything else reads as
    Letter, since the rough size only scales the profile spacing.
  - ▶ **Checkpoint for Sam:** phase 1's real-photo checkpoint. Print a set
    (Step 1, "Print calibration sheets", Actual size), photograph one sheet
    at 1:1 and one printed with Fit to page on, one under a lamp, each with a
    steel rule on it, and add them with `test/mark-photo.html`. The suite
    records their baselines; the ledger's figures for the sheet so far are
    all synthetic, and the PRD's constraints say exactly why that is not
    enough: a rendered paper edge has no curl, shadow or pale desk.
- ✅ Part A step 11, the lighting model. `computeDiffMap` with a window now
  fits a quadratic surface per channel to the clean ring inside it, one
  trimming pass against the fit, and scores each pixel against the paper
  predicted at that spot (`lighting: false` keeps the single median). The
  renderer gained a `light` option, a brightness gradient across the sheet.
  Under 30 percent the part traces at 80.11 x 49.94 mm. 803 checks,
  all passing, no console errors; dist rebuilt and smoke-tested — v1.30.8.
  - ⚠ **Criterion 12's premise did not hold.** It expected the single-colour
    model to mark the dark side as object under a 30 percent gradient. It
    does not: the diff score weights brightness at 0.7 against chroma at 1.6,
    which was the point of that weighting, and tolerates 30 percent with
    room; it breaks only past about 80. What the surface model delivers is
    margin, bare paper at the dark end reading 0 instead of 26, so the Otsu
    threshold has room on a lamp-lit sheet. The test asserts that and says
    so. A sharp shadow across the sheet, which a quadratic cannot follow, is
    the lighting case the real photos should include.
- ✅ Part A step 12, ruler verification. A row under the sheet panel takes
  the frame's outside width and height as a steel rule reads them on the
  print (placeholders are the design's 195.9 x 259.4 for Letter), refuses a
  reading more than 15 percent off, and stores the reading with the print
  check by job and sheet; `sheetVerdict` then takes its scale from the ruler,
  under the paper's cut tolerance, the sheet's position from the edges when
  visible and from the print check otherwise, and Forget returns to the
  edges. On the renderer: a reading of the 96 percent print gives 96.02 /
  95.99 with corners 0.15 px; a reading a quarter percent off moves the scale
  with it, not with the edges; on a white desk the ruler still gives the
  scale with the position from the print check. 808 checks, all
  passing, no console errors; dist rebuilt and smoke-tested — v1.30.9.
- ✅ Part A step 13, README and the PRD's status line. The README gains a
  "Calibration sheets" section under the workflow (printing, what the code
  carries, what happens on a photo, when the edges cannot be seen, before
  tracing, not yet), a line in the reference list, a tests paragraph on the
  SVG-rendered photos and the frozen layout, and its roadmap bullet moves to
  phases 2 and 3. The PRD's status line says phase 1 is built with the
  checkpoint pending and names the two criteria revised while building.
  808 checks, all passing, no console errors; dist rebuilt and
  smoke-tested — v1.30.10.
- ✅ Part B.3, the measurement. `stats.screenTests` and `stats.settleTests`
  split the nest's test count into the candidates tried until keepTop pass
  and the binary-search slides of the kept ones; the bench prints the split,
  the passes and the packed area, and gains `--record` and `--gate`:
  `test/fixtures/nest_baseline.json` holds today's placed count and area per
  config, and the gate fails any change that places fewer tools or packs more
  than 1 percent larger (open question 14's quality gate). Measured warm and
  quiet on this machine: Dense 3546 ms, 42,280 tests, of which 39,853 are
  SCREENING and 2,427 settling, in ONE pass; Access 595 ms, 6,949 tests
  (4,381 screening). 809 checks, all passing, no console errors; dist
  rebuilt and smoke-tested — v1.30.11.
  - ⚠ **The diagnosis in the PRD was wrong in two ways.** Dense does not
    "run all 20 restarts to completion": on the bench's thirty tools of
    twelve shapes every reshuffle within an equal-area group dedupes to the
    same shape key, so one pass runs and the 42,280 tests are that one
    pass. And settling is not where the time goes: 94 percent of Dense's
    tests are screening, candidates tried in top-left order until three
    pass, most of them overlapping something already placed and paying for
    a Clipper intersection to find out. An early stop on restarts cannot
    touch the bench; the exact change to make is a cheap exact reject in
    screening, before Clipper. The overfull drawer with distinct shapes is
    where restarts still matter.
- ✅ Part B.3, the exact reject. An occupancy grid of the placed inflated
  loops at 1 mm, a cell marked only when wholly inside a loop (the loop
  eroded by 0.85 mm, half a cell's diagonal plus a margin for Clipper's arc
  approximation, and the cell centre inside that), and per-variant probe
  points at least 0.85 mm inside the candidate's own inflated loop: a probe
  on a marked cell proves at least a quarter disc of overlap, 0.57 mm²
  against validAt's 0.05 mm² tolerance, so validAt says no before Clipper.
  It never says yes. Measured warm and quiet, the gate passing with every
  test count and area identical: Dense 3546 to 477 ms, Access 595 to 211,
  the rest in proportion. Criterion "Dense places 30 tools in under 2 s"
  met by a change that alters nothing. `occupancyGrid: false` exists only
  so the suite can prove that: with and without, same placements, same
  tests, same area. 811 checks, all passing, no console errors;
  dist rebuilt and smoke-tested — v1.31.0.
- ✅ Part B.3, the overfull drawer and the stalled restart. Measured: forty
  distinct tools in a drawer that holds about thirty run ONE pass, because
  the restarts only permute tools of equal area and distinct tools dedupe to
  the same key; 0.5 s under Dense (budget hit after pass 0) and 4.3 s under
  Access, twelve named 'noRoom'. So the unbounded case was only ever tools
  of equal area and different shape, and `stallRestarts: 6` now stops the
  restarts after six distinct passes that bettered neither count nor area:
  on ten such tools with forty restarts, 7 passes instead of 23, the same
  pack, 15,981 tests instead of 52,509. Both behind the gate, which passes.
  Coarse-to-fine rotation was not needed and is not built. 814
  checks, all passing, no console errors; dist rebuilt and smoke-tested —
  v1.31.1.
  - ⚠ A second exact change, grids for the notch rule's disc tests, passed
    the gate and bought nothing (Access 222 to 248 ms, noise), so it was
    taken out again rather than left as clutter. Access's 0.3 ms per test
    on the overfull drawer is not the notch: it is the partial overlaps of
    a full drawer, which the grid cannot prove and Clipper must.
- ✅ Sign-off for Part A phases 2 and 3, 2026-10-02. Sam's words: "Continue
  I'm signing off of the next build work". The PRD had staged this sign-off
  after phase 1's real-photo checkpoint; Sam gave it before, and was told
  once that anything phase 1 gets wrong on real paper will be built on. By
  Sam's decision, build proceeds in the plan's order: steps 14 to 18, then
  19 to 22. PRD at v1.2.16.
- ✅ Part A step 14, finding several sheets. `detectPaperRegions` in
  `js/detectPaper.js` (the single-paper detector refactored over the same
  code, its path unchanged) returns every bright sheet-sized component and
  every dark ring that could be a frame line, at a 960 px downscale so a
  2 mm frame at 3 px/mm survives, a seed of about a sheet's size swallowing
  the seeds inside it (a paper its window and its ring). `js/calibFind.js`
  recognises each seed with phase 1's recogniser and fit, keeps the better
  of two reads of one physical sheet (frames overlapping), flags two sheets
  of one identity as duplicates (criterion 22), holds a read to three words
  on two sides, and for a seed touching the photo's edge grows the visible
  part across the border in its own orientation (the longest hull edge not
  along the border; the border's normal in the sheet's frame says which
  axis was cut) to the stock's aspect both ways round, reading each guess.
  Step 1 runs it once per photo after the load paints; the panel lists the
  set, the overlay numbers each frame, the corners still follow the one
  sheet under them until step 15. `renderTablePhoto` in `test/sheetPhoto.js`
  composes several flat sheets on one plane and photographs it with the
  single-sheet camera (the single-sheet renderer refactored into the same
  flat-then-photograph pair; its tests' numbers unchanged). Measured on
  12 MP photos at 2.8 px/mm: one, four and eight sheets at random rotations
  all found, frames within 0.1 px, 0.4 / 1.2 / 1.4 s; a set printed twice
  reads as sheets 1, 2 and 2 with the note; sheets cut by the photo's edge
  at 25° and 100° read from 13 words each with their in-photo frame corners
  within 0.02 px; three sheets on a white desk found from their rings. 821
  checks, all passing, no console errors; dist rebuilt and smoke-tested —
  v1.32.0.
  - ⚠ The "whole-photo line search" is built as a search for closed dark
    rings, not straight segments: a frame line is a closed loop and comes
    out of the component labelling whole, and the recogniser is the "code
    reads beside it" filter the PRD asked for. A ring broken by a part
    lying across the frame is still one component unless the part covers
    the whole width of the line twice.
  - ⚠ A cut sheet's single-sheet fit extrapolates its off-photo corners by
    a few pixels (up to 5.6 px at 40°); the joint fit is what should place
    them, since the shared plane constrains what one sheet's two or three
    sides cannot.
  - ⚠ Finding costs 0.1 to 0.2 s per seed at 12 MP, so a photo of eight
    sheets adds 1.4 s after the load; it runs after the paint, not before.
- ✅ Part A step 15, the joint fit. `js/calibJoint.js`: Levenberg-Marquardt
  with a numerical Jacobian over the table-to-photo homography (8), one lens
  term, a pose per non-anchor sheet (3) and a print scale per non-anchor
  job (2), initialised from the single-sheet fits (each sheet's design
  corners through its own fit into the photo and back through the anchor's,
  a similarity from there). The anchor is the complete sheet with the lowest
  job and number; its job's scale is fixed from that job's best verdict
  (ruler, then edges, then a print check), because the frames alone cannot
  tell a print scale from a camera distance; another job's scale is
  observable against the anchor's frames and is fitted, then compared with
  that job's own edges (0.5 percent band). Residuals in table millimetres:
  every clock cell against its predicted place, every frame dip against its
  design line. Step 1 runs it after the finder, keeps each sheet's verdict,
  and the panel says how the set was fitted and where each set's scale came
  from. Measured on 12 MP photos with lens 0.08 and noise 3: four sheets,
  18 unknowns against 896 cells and 3458 dips, 4 iterations, 0.19 s, frames
  within 0.02 px, places within 0.02 mm, lens 0.0801; a second job fitted
  at 96.010 percent against a true 96, its own edges agreeing; a 500 mm
  part's true photo points measure 500.06 mm through the joint mapping and
  499.89 from one sheet at one end; duplicates each get their own pose. 827
  checks, all passing, no console errors; dist rebuilt and smoke-tested —
  v1.32.1.
  - ⚠ Criterion 20's "one sheet comes out worse" is a narrow margin on a
    synthetic photo: the single sheet's own lens fit extrapolates well
    (0.11 mm off over 500 mm against the joint's 0.06). The large single-
    sheet failure is the sheet whose edges are not visible, which assumes
    1:1 and reads 520.6 for 500. The traced form of criterion 20 comes with
    step 16.
  - ⚠ The job code is printed in upper-case hex everywhere now (`jobHex`);
    the finder's first draft printed it lower-case and the test said 5a.
- ✅ Part A step 16, rectification and segmentation for a set. Step 2
  rectifies the rectangle on the table that holds every sheet's paper plus
  5 mm (`tableExtent`), axis-aligned to the PHOTO rather than to the anchor
  sheet (`tableAxisAngle`: the anchor was laid by hand at 92° in the test,
  and the first cut came out transposed and tilted), at the drawer scan's
  3200 px ceiling with the joint fit's lens term. `computeDiffMap` takes a
  list of sheets, each a paper polygon and a window polygon in rectified
  px, labels every pixel desk, band or window, samples the paper on a ring
  inside every window (one lighting surface over the table), the desk on a
  ring round every paper, and masks every band outright. The band warning
  checks every sheet's paper and window; the trace info names the set; the
  project records the set. Measured: a 500 × 40 mm part between four
  sheets on a 1.1 m table traces at 500.07 × 40.10 at 2.92 px/mm; a part
  0.9 mm from a sheet reads 41.45 wide and is warned about; unticking the
  sheet fit returns to the one sheet. 832 checks, all passing, no console
  errors; dist rebuilt and smoke-tested — v1.32.2.
  - ⚠ Criterion 20's traced form is bounded by the rectified pixel: 0.35 mm
    at the 3200 px ceiling on a 1.1 m table, the same bound criterion 4
    carries from rectify's 1600 px cap. The test lays the part along the
    pixel grid (camera square to the table) and measures to one pixel; the
    calibration's own figure is step 15's 0.06 mm through the mapping. An
    earlier draft measured the part with an oriented box over a 2° tilt and
    read a pixel large from the staircase, which is the box, not the fit.
  - ⚠ A part under a millimetre from a sheet at 2.9 px/mm reads up to 1.5 mm
    larger toward the sheet (the gap and the paper's edge pixel are
    neither), which is what the band warning is for.
  - ⚠ The lens slider is not an override in set mode: the joint fit's term
    is used and the slider shows it.
- ✅ Part A step 17, drawer scale from a sheet. The finder now runs on a
  drawer photo too (the single-sheet corner path still does not), and Step 1
  says the sheet is there for the drawer's scale. `scanSheetCheck` takes the
  best-read sheet's frame corners through its own fit into the photo and
  through rectify's own construction (the rim corners, undistorted, to the
  drawer rect) into the rectified drawer, measures the frame there against
  its outside size times the print scale from the sheet's own verdict, and
  reports the factor and the percent; `scanRun` masks the sheet's paper
  (grown 2 mm) out of the diff map before segmenting, so it never arrives
  as a tool; the apply rescales every shape about the drawer's centre into
  the same `state.scan.rescale` the coin uses, and either button's undo
  returns the scan as found. The test is the coin test's drawer rendered
  through `renderTablePhoto` (the floor as the table, the rim as the floor's
  corners raised one drawer depth through the camera's `project`): 600 × 450
  mm, 60 mm deep, 800 mm up on a 40 mm equivalent. Measured: the bar reads
  110.95 for 120 at the rim; the sheet reports −7.49 percent against a true
  −7.50; the click gives 119.94 × 20.02; three shapes, the sheet not among
  them. 836 checks, all passing, no console errors; dist rebuilt and
  smoke-tested — v1.32.3.
  - ⚠ The recogniser's paper edge was found against the paper-to-ink
    midpoint, so a mid-grey liner (176 against paper 246) read as paper and
    the sheet's edges went unmeasured, leaving the print scale "assumed
    1:1". The edge is now sought against the desk's own level, read over
    the profile's first 3 mm; a desk as bright as the paper still has no
    edge, and phase 1's tests are unchanged.
  - ⚠ The coin's apply returned early without a coin, so its undo could not
    reach a sheet's rescale; the undo now comes first and is shared.
- ✅ Part A step 18, README. The calibration sheet section's "Several
  sheets" paragraph split into finding, fitting and Step 2, with the drawer
  cross-reference; the reference list says several sheets are fitted
  together; the tests paragraph describes the table renderer; the drawer
  scan section's sheet check and the roadmap were written at steps 16 and
  17. Phase 2 is complete, its checkpoint (a real large part with four
  sheets, a real drawer with a sheet on its floor) waiting on Sam's prints
  with phase 1's. 836 checks, all passing, no console errors; dist rebuilt
  and smoke-tested — v1.32.4.
- ✅ Part A step 19, EXIF and the camera position. `js/parallax.js`:
  `cameraFromHomography` takes K⁻¹H apart (the two rotation columns scaled
  by their mean length and orthogonalised symmetrically, the sign chosen so
  the plane is in front of the camera, the centre −Rᵀt), giving the height
  above the plane, the tilt of the optical axis from the normal and the
  point below the camera; `parallaxFactor`, `raisePoint`/`lowerPoint`,
  `heightFromRaised` and the readout text sit beside it for step 20 and 21.
  In the app, `parallaxUpdate` runs after the sheet, after the set and when
  the EXIF read lands: the homography is the sheet's own through its print
  scale (`state.sheet.H`, now kept) or the set's table, the focal length
  `focalPixels` from EXIF (refused when the photo was resized or cropped),
  plain paper's corners never used. Step 1's panel carries the camera line
  and what the base thickness shows; Step 2's trace info carries the
  readout, corrected or not, with the stand-back advice when not. Measured:
  height within 0.02 percent, tilt within 0.01°, the point below within
  0.3 mm, straight down, at 6° and 15°, through lens 0.06 and a 96 percent
  print, one sheet at 400 mm and a set a metre up; the EXIF path proven
  through the file input with a spliced focal length. 843 checks, all
  passing, no console errors; dist rebuilt and smoke-tested — v1.33.0.
  - ⚠ `state.sheet.fit` is the fit's figures, not the fit; the first draft
    read `fit.H` off it, threw inside the load's callback chain, and the
    scratch run hung on a load that never called back. The sheet now keeps
    its `H`, and the scratch runner races every load against a timeout.
- ✅ Part A step 20, the correction. With the camera placed and a sheet
  under the corners, `doRectify` rectifies at the base section's top plane:
  the paper's corners (or the set's table rectangle) go to where they would
  lie at that height, raised about the point below the camera by
  D / (D − t), and the window, bands and paper regions come through the
  same construction, lowered; the rectification records the plane, the
  factor and the point below the camera in rectified millimetres
  (`state.rect.parallax`). A thickness typed after the trace scales the
  outline, holes, circles and sections about that point by
  (D − t_new) / (D − t_old) (`parallaxRetarget`) rather than re-rectifying,
  which would lose the trace; a section whose top is at another height is
  scaled for the mesh by its own factor (`parallaxRegions`, in
  `rebuildMesh`). The readout says corrected, with the camera's height and
  tilt. Measured: a 100 × 40 × 10 mm part from 400 mm reads 102.46 × 40.99
  uncorrected and 99.89 × 39.99 corrected (criterion 24); a 500 × 40 × 10
  part on a table a metre down 500.07 × 40.02; the retarget and the section
  factors exact. 849 checks, all passing, no console errors; dist rebuilt
  and smoke-tested — v1.33.1.
  - ⚠ Two tests failed only in the full run: step 19's expected "not yet
    corrected" (true until step 20 existed) and step 20's uncorrected case,
    which found a focal length left over from the previous block's JPEG.
    The second is a real gap: `loadImageFromURL` never cleared
    `state.photoFocal`, so a project's or the queue's photo could carry an
    earlier JPEG's focal length. It clears it now, unless a `loadFile` read
    is in flight for the same photo.
  - ⚠ The raster is made at the thickness typed when Step 2 opens (5 mm by
    default); a thickness typed later moves the trace, not the picture, so
    the picture is then out of scale with the trace by a percent or so until
    Step 2 is re-rectified. The readout and the trace are right either way.
- ✅ Part A step 21, the raised sheet. `fitSheets` now reports each sheet's
  apparent scale against the anchor's plane from its initial similarity
  (`initScale`), before the joint fit spreads a raised sheet's disagreement
  over the whole plane (the first draft looked for it in the per-sheet
  residual after the fit and found nothing: the plane had bent to it and
  EXIF then read the camera 14 percent high). A sheet more than 0.5 percent
  over the median whose own edges still agree with its job's print scale
  is raised, is taken out, and the rest are refitted; its magnification m
  against the refit and the typed height h give D = h·m/(m − 1), and
  `focalFromHeight` bisects the focal length that puts the camera at D, so
  the tilt and the point below follow with no EXIF at all. EXIF, when
  present, is only checked and flagged past 3 percent, in the panel and in
  the readout. The panel asks for the height in the set's row; the raised
  sheet is masked where it appears, through its own fit and the joint's
  inverse; the renderer draws a sheet with a height as a layer above the
  table through the camera. Measured: magnification 1.02566 against a true
  1.02564 for 25 mm a metre down, camera 999.4 mm, an EXIF 15.5 percent off
  flagged and not used, the 10 mm part corrected to 500.06 × 40.01. 853
  checks, all passing, no console errors; dist rebuilt and smoke-tested —
  v1.33.2.
  - ⚠ A set of two sheets with one raised leaves one sheet on the plane,
    which the joint fit refuses; the raised sheet is then not detected and
    the camera, if any, comes from EXIF. Three or more sheets, or the plain
    EXIF route.
  - ⚠ The typed height is held in `state.sheets.raisedH` for the photo and
    not saved in the project; a reload re-asks.
- ✅ Part A step 22, README. The calibration sheet section now carries the
  camera's position, the correction, the raised sheet and what centring
  does not do; the roadmap bullet says phases 2 and 3 shipped and what the
  checkpoints are; Known gaps lists what the synthetic photos cannot show,
  the unbuilt line-only fallback, the trace's pixel at the ceiling, the
  picture left out of scale after a later thickness, and the two-sheet set.
  The PRD's status line says every phase is built and every checkpoint
  waits on Sam. 853 checks, all passing, no console errors; dist rebuilt
  and smoke-tested — v1.33.3.
- ✅ Deployed v1.33.3 to gh-pages on Sam's "deploy" — ca8f524. The site is
  the landing page plus `2.5d.html`, which is `dist/2.5d-local.html` copied
  over with the landing page's cache-buster link bumped from `?v=1.25.0` to
  `?v=1.33.3`; nothing else on that branch changed.
- ▶ NEXT: nothing queued. The calibration PRD is built end to end; its three
  checkpoints (steps 10, 17 and 21) and Part B.5's housekeeping wait on Sam.
  See the handoff below.

### Handoff to a fresh session, 2026-10-02 (third)

**State.** Branch `claude/2.5d-photo-stl-s3-y0oodn`, v1.33.3, every unit
of `docs/calibration_and_backlog_prd_v1.2.md` built and pushed: Part A
phases 1, 2 and 3 (steps 1 to 22) and Part B items B.1 to B.4. Sam signed
off phases 2 and 3 before phase 1's real-photo checkpoint; all three
checkpoints are open, and everything about the sheet is synthetic until
they are done.

**What exists now, for orientation.** Phase 1 as in the second handoff.
Phase 2: `detectPaperRegions` in `js/detectPaper.js` (seeds), `js/calibFind.js`
(the finder, duplicates, cut sheets), `js/calibJoint.js` (the joint fit,
`tableExtent`, `tableAxisAngle`, `describeJoint`), the set model in
`js/segment.js` (`computeDiffMap` with `sheets`), `doRectifySet`,
`sheetJointFit`, `sheetFindAll` and the drawer's `scanSheetCheck` in
`js/main.js`. Phase 3: `js/parallax.js` (`cameraFromHomography`,
`focalFromHeight`, `raisePoint`/`lowerPoint`, the readout) and
`parallaxUpdate`, `parallaxRaisedCorners`, `parallaxRectified`,
`parallaxRetarget`, `parallaxRegions`, `sheetRaisedHeight` in `js/main.js`.
The renderer `test/sheetPhoto.js` has `renderTablePhoto` (sheets at any
pose on one plane, raised sheets as layers, raised objects through the
camera). Test hooks: `app.sheet.{findAll, all, joint, setActive}`,
`app.parallax.{state, setFocal, focal, rect, retarget, regions, raised,
raisedHeight}`, `app.scan.{sheetCheck, sheetApply, sheet}`.

**Waiting on Sam, in order of what unblocks most:**
1. **The checkpoints.** Print a set (Step 1, "Print calibration sheets",
   Actual size), then: (a) phase 1, one sheet at 1:1 and one printed with
   Fit to page, one under a lamp, each with a steel rule, through
   `test/mark-photo.html` into `test/fixtures/real/`; (b) phase 2, a real
   large part with four sheets around it, and a real drawer with a sheet on
   its floor; (c) phase 3, a photo straight from the phone (no messaging
   app, which strips EXIF) of a thick part on a sheet, and the same with one
   sheet on a book of measured height. Things to look at first on real
   photos: the frame found by `detectPaperCorners` rather than the paper;
   the lens term the fits choose against the slider; whether the phone's
   focal length survives the browser's file input (`app.parallax.focal`);
   how far the EXIF camera and the raised-sheet camera agree.
2. Repointing GitHub's default branch, so the two stale branches can be
   deleted (blocked in sessions).
3. ~~The go-ahead to deploy~~ Done: gh-pages serves v1.33.3 since ca8f524.
4. Part B.5's housekeeping, which this PRD left outside the build.

**Known gaps recorded this session, none blocking:** the second handoff's
list, plus: the line-only fallback is still not built; a cut sheet's
off-photo corners come from its single fit until the joint fit places
them; a set at the 3200 px ceiling is traced to that pixel (0.35 mm on a
1.1 m table); a thickness typed after the trace moves the trace, not the
picture; a set of two with one raised is not a set; the raised sheet's
height is not saved in the project; the lens slider is not an override in
set mode; `loadImageFromURL` cleared no stale focal length before v1.33.1.

**Conventions kept, plus three new ones:**
- A scratch runner races every `loadImageFromURL` against a timeout: a
  throw inside the load's callback chain otherwise hangs the run silently.
- Measure a traced part laid along the pixel grid, by its axis box; an
  oriented box over a tilted staircase reads a pixel large.
- Chain a background suite with `( ... ) &` on its own line: `a && b & c`
  backgrounds the whole list, and this session once committed and pushed
  from the background without meaning to (it went fine).
- The rest as before.

### Handoff to a fresh session, 2026-10-02 (second)

**State.** Branch `claude/2.5d-photo-stl-s3-y0oodn`, v1.31.1, every unit of
the signed-off scope built and pushed: Part A phase 1, all thirteen steps
including the two droppable ones, and Part B items B.1 to B.4. Nothing is
queued from the PRD; the next build work needs a sign-off.

**What exists now, for orientation.** `js/calibSheet.js` (layout v1, the
code, the SVG, the print page; frozen in `test/fixtures/calib_layout_v1.json`),
`js/calibDetect.js` (recognition), `js/calibFit.js` (lens and homography),
`js/calibVerdict.js` (the paper rectangle, the verdict, the ruler, the
guidance), and the `sheet` block in `js/main.js` (Step 1 integration, the
print panel, the print-check and ruler records in localStorage). The
renderer the tests use is `test/sheetPhoto.js`; the real-photo harness is
`test/realPhotos.mjs` with `test/mark-photo.html`. The nest's exact reject is
`occGrid` in `js/holders.js`; its gate is `node test/nest-bench.mjs --gate`.

**Waiting on Sam, in order of what unblocks most:**
1. **Phase 1's real-photo checkpoint.** Print a set from Step 1 ("Print
   calibration sheets", Actual size), photograph one sheet at 1:1 and one
   printed with Fit to page on, one under a lamp, each with a steel rule on
   it, and add them with `test/mark-photo.html` into `test/fixtures/real/`.
   Also plain sheets with a rule, for step 2's own checkpoint. Everything in
   this ledger about the sheet is synthetic until then, and the PRD's own
   constraint says why that is not enough: a rendered paper edge has no curl,
   shadow or pale desk. The first run of `npm test` records the baselines.
2. **Sign-off for phases 2 and 3** after the checkpoint, and a decision on
   what the checkpoint showed. Two things to look at first on real photos:
   the frame found by `detectPaperCorners` rather than the paper (handled,
   but worth seeing), and the lens term the fit chooses against the slider.
3. Repointing GitHub's default branch, so `claude/object-thickness-photo-t8mw2k`
   and `claude/readme-screenshots` can be deleted (blocked in sessions).
4. The go-ahead to deploy: gh-pages still serves v1.25.0.

**Known gaps recorded this session, none blocking:**
- The line-only fallback (a sheet whose code cannot be read at all) is not
  built; such a photo is treated as plain paper. Four frame lines fix a
  homography for any aspect, so naming the layout needs the camera
  assumption `js/paperAspect.js` makes.
- Criterion 4's absolute accuracy is bounded by rectify's 1600 px cap, not
  by the sheet; the sheet delivers equality with 1:1 exactly.
- The auto lens estimate on plain paper (`estimateDistortion`, a 640 px
  downscale) is too coarse to apply blind: k1 -0.011 on a flat synthetic
  costs 0.36 mm over 150 mm. The sheet's own fit is a different, precise
  path.
- The refine pass shrinks round shapes by about 0.3 mm on a 24 mm disc
  (simplify then Chaikin); the coin check fits the raw boundary instead.
  Round tools in a scan carry the bias.
- A hand-written minimal project is refused by Load from text.

**Conventions kept, plus two new ones:**
- Splice test blocks into `test/e2e.mjs` with a FUNCTION as the replacement
  (`s.replace(anchor, () => block + anchor)`): a block containing `$\``
  once duplicated the suite's first 15,000 lines.
- A chunked read of a photo must try every region that brackets a sample,
  not the first; the recogniser lost a word at every chunk boundary before.
- The rest as before: rectify's pixel convention, camera-rendered photos for
  anything that reasons about the camera, warm timing only, one commit per
  unit with the printed total, version bumped and `dist/` smoke-tested.

### Handoff to a fresh session, 2026-10-02

**State.** Branch `claude/2.5d-photo-stl-s3-y0oodn`, v1.28.1, 708 checks green.
The plan is `docs/calibration_and_backlog_prd_v1.2.md`, signed off for Part A
phase 1 and Part B items B.1 to B.4. Steps 1a and 1b are done.

**Next, in order** (the PRD's suggested order):
1. Part A step 2: the real-photo harness. `test/fixtures/real/`, a sidecar per
   photo naming two hand-marked points on a steel rule and their distance, a
   measuring test with a synthetic self-test, recorded baselines that may not
   regress, and a marking page so Sam can add photos (downscale to about
   2400 px, strip location, keep the focal-length tags). Then the checkpoint:
   Sam's first photos.
2. B.1: the coin drawer check with a one-click rescale (PRD Part B.1).
3. B.2 thumbnails and merge; B.4 the rotation-step control and the rectified
   JPEG round trip.
4. Part A steps 3 to 13: the calibration sheet itself.
5. B.3: nest speed, measuring first.

**Conventions this session established, so they are not rediscovered:**
- Corners are in `rectify`'s pixel convention: pixel k's value sits at
  coordinate k. A canvas path vertex at x is half a pixel off that, so
  synthetic truth drawn with paths is compared at x - 0.5.
- Synthetic photos for anything that reasons about the camera (aspect,
  parallax, pose) must come from a centred pinhole camera with a plausible
  focal length. The suite's step-1 photo was placed by hand and reads as a
  Legal-proportioned sheet.
- Time things warm: `test/nest-bench.mjs` takes the minimum of five runs after
  a warm-up. Cold first runs read up to five times slow.
- Commit per unit with the suite's printed total in the message; bump
  `js/version.js` and rebuild `dist/` with `npm run smoke` on every version.

**Waiting on Sam:** real photos for the step 2 checkpoint; repointing GitHub's
default branch so the two stale branches can be deleted (deletion is blocked in
these sessions); the go-ahead to deploy, since gh-pages still serves v1.25.0.
- ⚠ The frontmatter said version 1.15 while the CHANGELOG stopped at v1.7. The
  entries for v1.8 through v1.15 were never written and cannot be reconstructed
  from the file, so they are recorded as a gap rather than invented. The bumps
  were real; the notes for them are gone.

- ⚠ **The ledger was reporting shipped work as pending**, and had been since
  2026-09-19. Both the resume-editing NEXT line and the steps 3 and 4 entry
  described a state the code had already left. The cause is structural rather
  than careless: a `▶ NEXT` line is written when the work is queued and is only
  correct until someone does the work, and nothing in the loop rewrites it at
  the other end. The PRD status lines stayed accurate throughout, because a
  status line is edited by the person shipping the step. Treat the PRD status
  lines as authoritative over this file's NEXT lines, and verify either against
  the code before planning off it.

## The adversarial review, 2026-09-19
An 87-agent review of this session's work: six lenses over the diff, then three
independent skeptics per finding, each prompted to refute. 27 candidates, 9
confirmed, 18 refuted, and **that split does not mean two thirds were wrong.**

Two things inflate the refuted count, and the raw numbers are worthless without
them. The six lenses overlapped heavily, so the same defect arrived up to four
times in different words. And the fixes were being written while the skeptics
were still running, so a skeptic that opened the file after the fix landed
refuted a finding that had been correct when it was made. "Edit in Step 2 keeps
a stale item index" is in the dismissed list; the same bug is in the confirmed
list under another lens's wording, and it was real.

Deduplicated, roughly ten distinct defects were found and all ten are fixed,
each with the reviewer's own reproduction as its test. The lesson is not that
the finders were noisy. It is that running the review concurrently with the
fixing makes the verdict column unreadable, and that a review worth trusting
has to be read for its findings rather than its arithmetic.

The nine, and what they had in common: three were constants or comparisons
chosen against one example rather than the worst case, five were the review and
the single-tool edit borrowing Step 2 without thinking about being walked away
from, and one was the generator rewrite's shallow snapshot.

The sharpest was an artifact nobody would have traced to its cause: drag a
corner half a millimetre wide, which the README's own instruction makes routine,
and a band of WALL along one edge segments as an object. Being a strip it fills
its own bounding box completely, so the sliver gate could not see it. It
arrived as "Tool 1", ticked, renumbering every real tool beneath it, and placed
as a full-width pocket hard against the wall that the build then refused.

## Noticed in passing, not fixed
- **No parallax correction, and for thick objects it is the largest error in
  the app.** Found while scoping the calibration sheet, 2026-09-27. The
  homography is exact for the paper's plane; an object of thickness t shot from
  height D shows its top outline magnified by D / (D - t) about the point below
  the camera. A 10 mm tool from 400 mm reads 2.6 percent large, 2.6 mm on
  100 mm, roughly eight times the paper-tolerance floor. `js/` has no parallax,
  focal-length or EXIF handling. The calibration sheet does not fix it and says
  so; EXIF focal length is the likely route for its own PRD.
- ~~**The Step 4 folder palette truncates tool names to two or three characters.**~~
  **FIXED 2026-09-21 in v1.27.4.** The cause was flex-shrink: both spans took the
  default of 1, and flex distributes overflow in proportion to content width, so
  the longer path kept more of its own width for exactly the reason that made it
  the less useful of the two. The path now shrinks a thousand times faster and
  collapses to its ellipsis before the name loses a pixel. The Library group
  passes an empty hint, so it had nothing competing with the name and needed no
  change, which answers the "check whether it needs the same change" below.
  Original note kept for the record:
  A folder of "claw hammer", "combination pliers", "screwdriver PH2" renders as
  `cl...`, `com...`, `scr...` while the folder path beside it gets comparable
  width. The name is the primary key and the path only disambiguates the
  uncommon same-name case, so the split is backwards. Visible in
  docs/step4-folder.png. Row builder is in js/main.js near the palette
  rendering; ids are load-bearing (two PRDs and the suite name them), so widen
  without renaming. The Library group shares the row builder, so check whether
  it needs the same change.

## Known gaps opened here
- ~~**Progress reporting for a large nest.**~~ CLOSED 2026-09-19, and the note
  that said "chunking it wants a worker" was **wrong twice over**, both
  corrected by measurement rather than argument:
  - A classic Blob Worker **does** construct and round-trip from a `file://`
    page in this repo's own Chromium against the real dist bundle
    (`location.origin` is `file://`, the URL is `blob:null/...`, and it
    answered). The "opaque origin blocks blob workers" folklore is false. What
    does fail there is `{type:'module'}` and `importScripts` of a sibling blob,
    so a worker payload would have to be one pre-concatenated build-time
    string.
  - The deeper error: chunking wants a **yield point**, not a worker, and
    `nestLayout`'s per-item loop already was one. A worker was the larger
    change (a second esbuild entry, a second minified Clipper, a
    `globalThis.ClipperLib` change, a `self.document` shim for the label
    glyphs, a hand-written item projection whose omissions fail silently) and,
    decisively, the suite never loads `dist/` at all, so the worker branch
    users ran could never be the branch CI exercised.
- **The nest is slower than criterion 6 claims** — still true, but **the
  diagnosis under it was wrong and is corrected here, 2026-09-21.** A
  repeatable bench now exists at `test/nest-bench.mjs`, and a cheap-reject pass
  went into `validAt` in v1.27.5 worth about 1.7x on Access. Criterion 6's
  first branch (30 items under 2 s) is still not met by Dense.

  What the old note got wrong, and why it is worth reading before measuring
  anything in here again:
  - **"Access is ~13x slower per candidate"**: it is not. Warm, the two
    profiles cost the **same** 0.06 ms per validAt test on a 30-tool bench.
    Dense is the slower profile overall, at 2.6 s against Access's 0.4 s, and
    entirely because `rotationStep: 15` with free rotation hands it 42280
    candidates to test where Access's 90 degrees hands it 6949. The gap is
    candidate count, not candidate cost.
  - **"notchPolicy 'require' adds disc booleans"** that cost real time: it does
    not. Turning the policy off moves the number by less than the noise, and
    direct timers around every disc built and every disc boolean run accounted
    for 1.5 ms of a 2.7 s pack.
  - **The old figures were almost certainly cold.** The first pack through a
    fresh page pays for JIT compilation of the geometry path and can read five
    times slow. Timed cold and in sequence, one unchanged config read 2.7 s in
    the second row of the bench and 0.5 s in the seventh, which is how the
    original attribution went wrong and how this session's first three
    attributions went wrong in turn before the warm-up was added. Every number
    above is the minimum of five warm runs.

  What is left: Dense's candidate count. `rotationFree` with a 15 degree step
  is the whole of it, so the win is in generating fewer candidates or rejecting
  them earlier, not in making a test cheaper.
- **The overfull drawer is still unbounded.** The budget gate disarms itself
  while anything is unplaced, which is exactly the case a user most wants to
  escape. It is now watchable and cancellable; it is not shorter.
- **The rectified copy is re-encoded on every re-edit.** Restoring a project
  decodes its rectified JPEG and re-saving re-encodes it at quality 0.85, so
  each round through the queue re-edit path costs one generation of lossy
  compression. Noted against criterion 2 of the resume-editing PRD.

## Queue
1. ~~e2e check-count self-reporting~~ done
2. ~~Doc sweep for v1.23.0~~ done. Scope was smaller than the handoff implied:
   the README *body* already documented puzzle tabs and bed tiling. Only the
   Roadmap block was stale (it never absorbed the holders arc at all).
3. ~~`docs/nesting_prd_v1.0.md`~~ drafted, signed off, and implemented in full
   as v1.1 steps 1-9 across v1.25.0 and v1.26.0.
4. ~~STL tiling of printed inserts~~ design note written, awaiting a decision on
   the registration scheme before a PRD is worth writing.

## Blocked (do not attempt unattended)
- Logo PNG swap — needs an asset from Sam.
- Real-photo validation of the mat/grid auto-count — needs real photographs.
- 3MF export — deferred, no decision.
- ~~Nesting implementation — needs sign-off on the PRD in item 3.~~ **CLOSED 2026-09-21.**
  Signed off, and steps 1-9 shipped across v1.25.0 and v1.26.0. What is left
  is performance, not permission: see the nest-speed gap above.

## Needs Sam's call, still open
Two items as of 2026-09-27.

- ~~**Sign-off on `docs/calibration_and_backlog_prd_v1.2.md`.**~~ **Signed off
  2026-10-02** for Part A phase 1 and Part B items B.1 to B.4. Still owed:
  phases 2 and 3, after phase 1's real-photo checkpoint, which needs Sam's
  photos. Plan steps 1 and 4 each end in a checkpoint that needs real
  photos from Sam, because a rendered paper edge is perfect and cannot show the
  frame beating it.

- ~~**`docs/resume_editing_prd_v1.1.md` steps 3 and 4.**~~ **CLOSED 2026-09-21.**
  Both were built, small, against the corrected fact rather than the false one,
  and shipped by v1.26.3. Nothing is owed here. The narrow true statement is
  what went into the UI: the small save keeps the trace editable and costs the
  corners.
- **`docs/drawer_scan_prd_v1.0.md` open questions 3, 6 and 9.** The two
  decisions this entry used to lead with are settled: Sam granted the exception
  to the batch PRD's quality-bar rule and signed off the `layout.items` landing
  position when he put the drawer scan in the work queue on 2026-09-19, and
  steps 1-6 and 8 shipped as v1.27.0. Question 6 is the live one, because step 7
  is the only unbuilt step and question 6 is what it turns on.

## Sam's calls, closed
- **Em dashes in repo docs.** CLOSED 2026-09-19 after three flags: new docs are
  written clean, existing ones are left alone. Not to be raised again.
- **Frontmatter on README.md.** CLOSED 2026-09-19 after two flags: it goes on,
  and the table GitHub renders from it is acceptable unless Sam asks for it
  back out. Not to be raised again.
- **Resume editing open questions 1 to 3.** CLOSED 2026-09-19. Click the tile,
  with a pencil affordance. Reopening changes neither status nor tick, because
  Next is the one thing that finishes a photo. When the sibling project and the
  library entry disagree, ask at load time rather than letting either win.

## Notes
- The handoff's "two e2e commit-message count assertions off by one" was
  mis-scoped. There are no such assertions in the suite. The `167/166` and
  `224/223` errors were check counts hand-written into commit **message bodies**
  that did not match the run. Those commits are pushed; correcting them means
  rewriting history on a shared branch, which was not done. Instead the suite
  now prints its own total so the number can be quoted rather than counted.

## Needs Sam's call
- ~~Registration scheme for printed tiles~~ **deprioritized 2026-09-05.**
  Joining big pieces is a laser/router concern; Gridfinity covers the printed
  case. The fit-sign flip finding (laser removes material, printer adds it)
  still matters if it is ever revived.
- ~~Sign-off on `docs/labelling_prd_v1.0.md`~~ **signed off and shipped; steps 1-7 are in v1.25.0.** Original ask kept for the record:, plus answers to its open
  questions 1 (single-line fonts for routers, deferring is a real cost) and 4
  (a third `engrave` SVG layer, which changes the exported layer set). Those
  two change the shape of the work rather than a default.
- ~~Sign-off on `docs/nesting_prd_v1.1.md`~~ **signed off; steps 1-9 all shipped. Steps 1-4 landed in v1.25.0 as unreachable geometry, steps 5-9 in v1.26.0, and progress reporting closed 2026-09-19.** Original ask: Steps 1-4 of its plan are the
  feature; nothing was built. Open questions carry recommendations: rotation
  step per profile, explicit button rather than auto-run, default webs (8 mm
  Access / 4 mm Dense, both unvalidated against a real cut), localStorage-only
  custom profiles, and what to show when a saved project matches no profile.
- **Em dashes in repo docs.** Sam's style guide bans them; every existing doc
  in this repo uses them heavily. The new PRD matches the repo, not the style
  guide. Say if that is backwards.
- **Frontmatter on README.md.** Sam's revision-control convention says every
  markdown file carries YAML frontmatter, and his CutSheetCalculator README
  does. This repo never has, and GitHub renders frontmatter as a table at the
  top of the repo's front page. Conflict flagged, not resolved: no frontmatter
  was added to README.md or docs/holders-prd.md.

- ~~Sign-off on `docs/batch_ingest_prd_v1.0.md`~~ **signed off 2026-09-13 and
  shipped in v1.25.0** (batch ingest queue, snap to grid, nesting as a lane,
  labelling step 6). Original ask kept for the record: drafted 2026-09-12 from
  user feedback, to be built in a second session after the Step 4 PRD merges.
- ~~Sign-off on `docs/selection_and_organize_prd_v1.2.md`~~ **signed off
  2026-09-10, build in progress in its own session.** (drafted 2026-09-10
  from the 2026-09-09 chat; Part A selection modes, Part B a new Step 4
  Organize with a folder-of-traces palette, Part C build instructions and
  workflow scripts for the planned Opus + ultracode session). Settled in chat: lasso yes, brush with adjustable
  radius yes (circle select folds into it), directional box expands fillet
  arcs on a right-to-left crossing drag but never plain segments. Step 4 is
  Sam's framing: after export, organize the drawer or toolbox, optionally
  from a folder of trace files. Build-changing open questions: Part A 1 and
  2 (crossing on managed lines; lasso/brush expanding arc runs), Part B 3
  (offer a container-kind folder entry as the drawer outline).

## Handoff

**Done and pushed this run** (branch `claude/2.5d-photo-stl-s3-y0oodn`, from
`44cbe75` v1.23.0):

| commit | unit |
|---|---|
| `c44ba94` | e2e suite reports its own check total; this ledger created |
| `29fff41` | README roadmap + Tests section and holders-prd brought to v1.23.0 |
| `8ed1fb0` | `docs/nesting_prd_v1.0.md` drafted for sign-off |
| (below)   | `docs/printed_tile_registration_v1.0.md` design note |

No version bump, no deploy, no PR, nothing outward-facing. `js/` is untouched
apart from the test harness counter. 244 checks pass, no console errors.

**In flight:** nothing. Every unit is committed and pushed.

**Next session starts by** getting answers to the "Needs Sam's call" list
above. The nesting PRD's steps 1-4 are the largest ready-to-build item and
are blocked only on sign-off.

**Burn:** this session spent about \$0.64 of notional quota across all four
units, working solo rather than through the Workflow tool. Calibration data
for the 5-hour bucket is in the scratchpad, not committed, since burndown
telemetry does not belong in a photo-to-STL repo. It is worth writing up as
`reports/usage_mechanics_report_v1.0.md` somewhere more appropriate.

## CHANGELOG
- v1.0 (2026-09-04): Initial ledger for the 2026-09-04 burndown.
- v1.1 (2026-09-10): Tabled trace-editor selection modes (lasso and radius brush yes, directional box open).
- v1.2 (2026-09-10): Selection modes PRD drafted at docs/selection_modes_prd_v1.0.md; ledger entry now points at it.
- v1.5 (2026-09-12): batch_ingest_prd_v1.0.md drafted; Step 4 PRD marked signed off.
- v1.4 (2026-09-10): PRD at v1.2: circles in crossing select, File System Access backend, container scaling, Part D laser constructions, session uprevs.
- v1.3 (2026-09-10): PRD widened to docs/selection_and_organize_prd_v1.2.md (Step 4 Organize, ultracode build plan).
- v1.5 (2026-09-13): S5 shipped. Parts A, B and D built in parallel lanes, reviewed, merged and deployed as v1.24.0.
- v1.6 (2026-09-13): S6 shipped as v1.25.0. Records the spend-limit outage mid-review and the finding it nearly lost.
- v1.7 (2026-09-14): Resume-editing PRD drafted. Retired the three sign-off asks that have since shipped.
- v1.8 to v1.15: not recorded. The version was bumped through this span without changelog entries, and they could not be reconstructed on 2026-09-21. The ledger body above is the record for that period.
- v1.35 (2026-10-02): v1.33.3 deployed to gh-pages.
- v1.34 (2026-10-02): Part A step 22 shipped as v1.33.3; the calibration PRD built end to end; third handoff written.
- v1.33 (2026-10-02): Part A step 21 shipped as v1.33.2.
- v1.32 (2026-10-02): Part A step 20 shipped as v1.33.1.
- v1.31 (2026-10-02): Part A step 19 shipped as v1.33.0.
- v1.30 (2026-10-02): Part A step 18 shipped as v1.32.4; phase 2 complete.
- v1.29 (2026-10-02): Part A step 17 shipped as v1.32.3.
- v1.28 (2026-10-02): Part A step 16 shipped as v1.32.2.
- v1.27 (2026-10-02): Part A step 15 shipped as v1.32.1.
- v1.26 (2026-10-02): Part A step 14 shipped as v1.32.0.
- v1.25 (2026-10-02): Phases 2 and 3 of the calibration PRD signed off by Sam before the real-photo checkpoint; build resumes at step 14.
- v1.24 (2026-10-02): Steps 1a and 1b shipped as v1.28.0 and v1.28.1; criterion 14 revised; handoff to a fresh session written.
- v1.23 (2026-10-02): Calibration and backlog PRD signed off for Part A phase 1 and Part B items B.1 to B.4; build started.
- v1.22 (2026-09-29): Calibration PRD widened to docs/calibration_and_backlog_prd_v1.2.md with the twelve approved suggestions and the backlog; README Next up corrected.
- v1.21 (2026-09-28): Calibration sheet PRD revised to v1.1 with encoding, multi-sheet and parallax phases.
- v1.20 (2026-09-27): Calibration sheet PRD drafted; the unchecked paper size and the missing parallax correction recorded.
- v1.19 (2026-09-21): Nest cheap-reject shipped in v1.27.5 with a bench; the recorded nest-speed diagnosis corrected after measurement disproved it.
- v1.18 (2026-09-21): Step 4 palette truncation fixed in v1.27.4 and struck from the noticed-in-passing list.
- v1.17 (2026-09-21): Corrects v1.16, which took this file's stale NEXT line at face value and reported the resume-editing arc as pending. Steps 2 to 6 shipped on 2026-09-19; verified in code.
- v1.16 (2026-09-21): Doc reconciliation. README Roadmap and Known gaps brought to what shipped; the stale Blocked, still-open and sign-off entries in this file struck with their real outcomes.
