---
file: resume_editing_prd_v1.1.md
version: 1.1
author: Sam Cao
created: 2026-09-14
last_updated: 2026-09-19
description: PRD for getting back to a tool you have already traced, covering the queue re-edit path, honest naming of the two project saves, and autosave as the backend of last resort. v1.1 corrects what the two saves actually differ in.
ai_update: Update last_updated and version. Rename file to match. Append changelog at bottom.
---

# PRD: Getting back to a tool you already traced

Status: **Step 1 SHIPPED in v1.25.1, 2026-09-19. Steps 2 to 6 not built, and
steps 3 and 4 need re-deciding.** · 2026-09-14 ·
target branch `claude/2.5d-photo-stl-s3-y0oodn`

**v1.1 correction.** v1.0 of this document was wrong about the central fact it
argued from, and the error is corrected in place below rather than left to
mislead. `serializeProject(includePhoto)` gates **only** the original camera
photo. The rectified image is written whenever one exists, on both saves. So
the "photoless" form is not a few KB, it is not Step-2-disabled, and it does
**not** cost you the ability to edit the trace. Steps 1 and 2 of the plan stand
as written. Steps 3 and 4 were scoped against the wrong difference and are
marked for re-decision.

Sam, 2026-09-13: after you hit Next you may want to go back and edit the trace.
Then: you should be able to export just the trace, or the trace and the file,
to re-edit later.

This document is the answer to both, and it is smaller than it sounds, because
most of the machinery already ships. The export half exists. The way back in
does not.

## Problem

A traced tool is easy to lose and hard to return to.

Press Next in the batch queue and the trace is gone from the screen. Undo
brings the photo back but not the trace. Click the traced thumbnail and
`queueLoad` calls `queueClearTrace` and reloads the photo alone, even though a
complete project for that tool is sitting on disk beside it. The work is not
lost. There is simply no door back to it.

Outside the queue the picture is better but unlabelled. Project, Save writes a
project file, and the `#projIncludePhoto` checkbox decides whether the
rectified image rides along. That one checkbox is the difference between a
file you can resume editing and a file you cannot, and nothing says so.

### What the code actually does today

Verified in `js/main.js` at v1.25.0:

- `serializeProject(includePhoto)` at line 4856 writes the whole project:
  trace, arcs, lines, regions, labels, measurements, constraints, reference
  settings. **`includePhoto` gates exactly one field, `photo`, the original
  camera image.** `rectified`, the JPEG data URL of the warp-corrected image,
  is written by both forms whenever `state.rect` exists, and `state.rect`
  always exists by the time anything has been traced, because tracing happens
  in Step 2 and Step 2 rectifies. The suite already knew this: `test/e2e.mjs`
  line 6922 calls `serializeProject(false)` "a normal photo-less save" and
  notes that "the rectified copy stays".
- `loadProject` restores all of it and accepts a project with no `rectified`.
- `setStep` gates the trace editor: `stepBtn2.disabled = !state.image &&
  !state.rect` (line 322). A project with no photo and no rectified image
  leaves Step 2 **disabled**.
- `stepBtn3.disabled = !(traceEditor.outer && traceEditor.outer.length >= 3)`
  (line 323), so a photoless project still reaches Model and export.
- `queueWriteProject` (line 1259) writes `serializeProject(false)` beside each
  photo as the queue advances. That file therefore carries the rectified
  image, which is why it reopens editable on its own.
- `queueLoad` (line 736) calls `queueClearTrace()` and then `loadFile`, and
  never reads the sibling project, whatever the item's status.

### The consequence nobody has written down

The two saves do differ, but not in the way v1.0 of this document claimed:

| Save | Roughly | Step 2 | What you can do |
|---|---|---|---|
| With photo | the rectified copy plus the full-resolution original | live | Everything below, **and** redo the corners: re-mark the sheet, re-rectify, re-detect. |
| Without photo | the rectified copy alone | **live** | Resume editing. Re-trace, move vertices against the rectified image, model, export, place it in a drawer. |

So unticking the box does not cost you the trace editor. It costs you the
corners: without the original frame there is nothing to re-mark, so the
rectification you have is the one you keep. That is a real loss and it is
still not what the label says, but it is a much narrower one, and the sentence
v1.0 wanted to put under the checkbox would have been false.

The queue's own persistence therefore **does** support re-editing on its own.
Loading the photo as well is still right, because it is what gives the
reopened tool its corners back, and the queue already holds both files.

## Success criteria

1. **Back into a traced tool in one click.** Clicking a traced item in the
   queue reopens it fully editable: the photo under the trace, arcs, lines,
   regions and labels as they were left, Step 2 live.
2. **Round trip, not a rebuild.** Reopening, changing one vertex and pressing
   Next again leaves every other field of the saved project byte-identical.
3. **Honest names.** The save dialog says what each option costs in capability,
   not in bytes. A user who picks the small one is told, once, that the trace
   will not be editable.
4. **A project that cannot reach Step 2 says so.** This is now a narrow case,
   not the common one: it needs a project saved with neither a photo nor a
   rectified copy, which means one saved before anything was ever rectified.
   Loading one explains why Step 2 is disabled rather than showing a dead
   button. Shipped in part already: the queue re-edit path reports it and
   lands such a project at Step 3 with its outline intact.
5. **Nothing is lost when no folder is writable.** On the directory-input
   backend, Firefox, Safari or `file://`, where the queue writes nothing, the
   trace still survives a reload of the tab.
6. **Nothing moves under existing users.** Projects saved by v1.25.0 and
   earlier load unchanged. The save format gains only additive fields.

## Scope

### In

- **Queue re-edit.** Clicking a `traced` queue item loads its sibling project
  on top of its photo instead of clearing the trace. `queueLoad` learns to
  restore rather than wipe when the item is traced and its project is
  readable. Undo after Next routes through the same path, which is what makes
  Undo actually return the trace.
- **Re-edit without the queue.** A traced item's project can also be reopened
  from the outline library when that entry came from a project with a photo
  beside it.
- **Renaming the two saves.** `#projIncludePhoto` keeps its id, because
  test/e2e.mjs and two PRDs name it, and gains an honest label plus a one-line
  consequence under it. The Save dialog states the capability, and the size, in
  that order.
- **A reason on the disabled Step 2.** When a project loads with no image, the
  step button carries a title and the panel a line saying the project was saved
  without its photo, so the outline can be modelled and placed but not edited,
  and that opening the original photo restores editing.
- **Autosave as the backend of last resort.** A single slot in IndexedDB, beside
  the folder handle store that `js/import/folderAccess.js` already opens, holding
  the current project through `serializeProject(true)` so a tab crash mid-trace
  is recoverable. Written on a debounce after an edit settles, never mid-gesture.
  On load, an explicit "restore what you were tracing?" prompt. Never silent.
- Tests for each success criterion, in one contiguous block.
- README: a short section on getting back to a tool.

### Out

- **Version history.** One autosave slot, overwritten. Keeping N revisions is a
  different feature and localStorage is not where it would live.
- **Syncing between machines.** The folder is the transport, as Part B decided.
- **Autosaving the queue itself.** Session-only by design, per the batch PRD.
- **Making a photoless project editable by inventing an image.** If the photo is
  gone, editing is gone. Say so; do not fake a backdrop.
- **Changing what `serializeProject` writes.** Both forms already exist and are
  correct. This document changes who calls them and what the UI says.

## Constraints

- Single-file, fully client-side. No server, no user-facing build step.
- No CSG, no mesh work. This is state plumbing and UI.
- Save-format keys stay stable; anything new is additive and optional.
- `#projIncludePhoto` and every `lay*` and `queue*` id keep their names.
- IndexedDB only for the autosave blob. localStorage holds roughly 5 MB and the
  outline library already fights that ceiling at `LIB_WARN_BYTES`.
- No `Date.now()` or `Math.random()` in code the tests must be deterministic
  over. The autosave timestamp is the one exception and is injected, not read
  from the module.
- Memory: reopening a tool decodes one photo. Release the current one first.

## Design

### The queue re-edit path

`queueLoad(item)` gains one branch. When `item.status === 'traced'` and a
sibling project is readable, it loads the photo as it does now and then applies
the project on top, rather than calling `queueClearTrace()`. The project supplies
the trace and every derived entity; the photo supplies the rectified image that
makes Step 2 live. Neither alone is enough, which is why this needs no new
storage: the queue already has both files.

Undo after Next becomes the same call. That is the whole fix for the gap
recorded against v1.25.0.

The order matters. The photo decodes first and the project is applied after,
because `loadFile` runs corner detection and would otherwise overwrite the
restored trace. The reference settings come from the project, not from the
carry-over snapshot, since this tool was traced under its own settings.

### Naming the two saves

The checkbox becomes a two-option choice with the consequence stated:

> **Save for editing** (larger). Keeps the corrected photo inside the file, so
> you can reopen it and change the trace.
>
> **Save the outline only** (small). Enough to model, export and lay out this
> tool. The trace cannot be edited without its photo.

`#projIncludePhoto` stays as the underlying control so nothing that names it
breaks.

### The reason on a disabled Step 2

`setStep`'s gate is already correct and does not change. What changes is that a
disabled Step 2 can say why. When a project loaded with `trace` but no image,
the panel carries one line explaining it and pointing at the fix.

### Autosave, deliberately last

Autosave is the fallback for the case where neither sibling file exists: no
writable folder, or a tab that died before Next. One slot, `2p5d.autosave.v1`,
in the IndexedDB store `folderAccess.js` already opens. Written on a debounce
after an edit settles. Restored only through an explicit prompt naming the tool
and when it was saved.

It is last because it is the only part that needs new storage, and because the
two paths above cover the common case, which is a folder that is open anyway.

## Plan

Each step is one commit, `node test/e2e.mjs` green, the suite's printed total
quoted in the message.

1. **Queue re-edit.** SHIPPED in v1.25.1. The `queueLoad` branch, photo then
   project, and Undo after Next routed through it. Two things the build turned
   up that this plan had not anticipated: Step 2 may only be forced when the
   project carries a rectified copy, because otherwise `goStep(2)` finds
   `rectDirty` still true from the photo that just decoded and retraces over
   the restored outline; and the `loadProject` call has to be wrapped, because
   nothing awaits the restore, so a project it cannot read would fail silently.
   One caveat on criterion 2: every field round-trips identically except
   `rectified`, which cannot, because the restore decodes that JPEG and the
   re-save re-encodes it. Each re-edit costs one generation of lossy
   compression at quality 0.85.
2. **Re-edit from the library**, where the entry came from a project with a
   photo beside it. Test: a library entry with a known source reopens editable.
3. **Naming the two saves.** **Re-decide before building.** The wording v1.0
   proposed ("The trace cannot be edited without its photo") is false. What is
   true and still worth saying is narrower: the small save keeps the corrected
   image and the trace stays editable, but the original frame is gone, so the
   corners cannot be re-marked. Whether that earns a rewritten checkbox, a
   one-line hint, or nothing at all is Sam's call, and it is a much weaker case
   than v1.0 made.
4. **The reason on a disabled Step 2.** **Re-decide before building.** Scoped
   against a case that turns out to be rare, and the queue path now covers the
   part of it that came up in practice. What is left is the Project, Load path
   for a project saved before any rectification.
5. **Autosave.** The IndexedDB slot, the debounce, the restore prompt. Tests: a
   simulated reload offers the restore; declining leaves state untouched; the
   slot survives a reload and is cleared once its tool is saved properly.
6. **README** and this PRD's status line.

Steps 1 and 3 are independent. Step 2 depends on 1. Step 5 is independent of
all of them and is the one to drop first if the session runs short.

## Open questions (recommendation first)

1. **Should the queue re-edit be a click, or an explicit Re-edit button on the
   tile?** DECIDED 2026-09-19: the click, with a pencil affordance on a traced
   tile. Shipped in v1.25.1.
2. **Should reopening a traced tool untick it, so Next does not immediately
   skip past it again?** DECIDED 2026-09-19, and the question dissolved rather
   than went one way. Reopening changes neither status nor tick. Next is the
   one thing that finishes a photo, on the first pass and every pass after, so
   a stray click cannot demote a finished tool, and "Next lands on it" is free
   because Next always commits the photo currently loaded. Undo stays the
   exception, since it reverses the commit rather than revisiting it. Shipped
   in v1.25.1.
3. **What if the sibling project and the library entry disagree**, because the
   library copy was edited after the fact? DECIDED 2026-09-19: **ask at load
   time**, naming both timestamps, rather than letting either win silently.
   This overrides v1.0's recommendation and it is a change to plan step 2,
   which is where it lands: the library re-edit path has to detect the
   disagreement and prompt. Not yet built.
4. **Should autosave write while a gesture is in flight?** Recommendation: no.
   Debounce until an edit settles. A snapshot of a half-dragged vertex is worse
   than no snapshot.
5. **Should "Save the outline only" warn every time, or once?** Recommendation:
   once per session, with the consequence permanently visible under the option.
   A dialog that nags gets clicked through.

## Decision needed

Sign-off on the scope and the plan. Open questions 1 and 2 change the
interaction; 3 changes which file is authoritative. The rest are defaults.

## CHANGELOG
- v1.0 (2026-09-14): Initial draft, from Sam's 2026-09-13 and 2026-09-14 notes on Undo after Next and on exporting a trace with or without its file.
- v1.1 (2026-09-19): Corrects the central factual claim. `serializeProject(includePhoto)` gates only the original camera photo; `rectified` is written by both forms, so the small save is neither a few KB nor Step-2-disabled and does not cost the ability to edit the trace. Rewrites the two-saves table and the consequence argument, narrows success criterion 4, and marks plan steps 3 and 4 for re-decision since both were scoped against the wrong difference. Records Sam's answers to open questions 1, 2 and 3 (click; reopening changes neither status nor tick; ask at load time when the sibling and the library disagree) and marks step 1 shipped in v1.25.1, with the two build findings and the `rectified` re-encode caveat.
