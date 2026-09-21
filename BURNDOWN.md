---
file: BURNDOWN.md
version: 1.18
author: Sam Cao
created: 2026-09-04
last_updated: 2026-09-21
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
- ▶ NEXT: the nest's `validAt`, where the two notch loops call Clipper once per
  placed item with no bounding-box reject while the overlap loop beside them has
  had one all along. That is the measured cost behind Access being ~13x slower
  per candidate than Dense.
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
- **The nest is slower than criterion 6 claims, by a lot.** Measured on the
  30-item twin fixture in the shipped profiles: **3.5 s under Dense and 12.8 s
  under Access**, not the 1.3-1.5 s the nesting PRD records. Criterion 6's
  first branch (30 items under 2 s) is not met and is not met by this change
  either; what shipped is its second branch, yielding to the event loop. The
  cost driver is `validAt`: Access is ~13x slower per candidate test because
  `labelSpace: 'reserve'` adds a second loop to every Clipper call,
  `notchPolicy: 'require'` adds disc booleans, and a rounded-rect container
  makes `limitIsRect` false so every containment test runs Clipper. A caching
  or cheap-reject pass inside `validAt` is the real win and is still owed.
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
One item, after the 2026-09-21 sweep.

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
- v1.18 (2026-09-21): Step 4 palette truncation fixed in v1.27.4 and struck from the noticed-in-passing list.
- v1.17 (2026-09-21): Corrects v1.16, which took this file's stale NEXT line at face value and reported the resume-editing arc as pending. Steps 2 to 6 shipped on 2026-09-19; verified in code.
- v1.16 (2026-09-21): Doc reconciliation. README Roadmap and Known gaps brought to what shipped; the stale Blocked, still-open and sign-off entries in this file struck with their real outcomes.
