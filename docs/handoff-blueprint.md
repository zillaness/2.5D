<!--
FORK HANDOFF — fork-this v1.1
Thread: Blueprint (drawing → CAD)
Fork: 1 of 2
Session: S2a  (parent: S1)
Parent: 2.5D + Blueprint build session (S1)
New chat name: Blueprint — drawing→CAD — S2a (2026-07-21)
Date: 2026-07-21
-->

# FORK HANDOFF — Blueprint (drawing → CAD) — S2a

## Parent context

Parent conversation (S1) built the **2.5D** tool (photograph a physical object
on a known-size reference → traced, true-scale, printable STL) through v1.3.0,
then **forked "Blueprint"** — a different product for a different user: import a
CAD **drawing** (DXF/SVG/PDF), read its dimensions, and extrude it into a
printable solid. Blueprint was seeded on branch `claude/blueprint-seed` from
2.5D so it inherits the mature trace editor, hole/section model, mesh, exporters,
and single-file build. This thread continues Blueprint; the 2.5D mainline is fork
S2b.

## Thread summary

Blueprint = "drawing → printable solid." Steps 1–3 are shipped and pushed to
`claude/blueprint-seed`: (1) fork seed + rebrand, (2) inline pdf.js + PDF vector
geometry → view picker → trace, (3) read the drawing (title-block units/scale/
part-name, dimension-derived true scale, trust-label cross-check) + a mixed
inch/mm units picker. Step 4 (S2a) shipped hole-callout parsing (#23). 109 tests
pass, 0 fail; `file://` PDF-import smoke passes on the single-file build. The
eventual acceptance test is a Picatinny/STANAG rail (#27), and the long-term
endgame is 3D-from-multiple-views.

## Skills in play

- `fork-this` (/root/.claude/skills/fork-this/SKILL.md) — used to produce this handoff.
- No other custom skills were central; work was direct code + Playwright tests.

## Project state

**Repo:** `zillaness/2.5D` · **Branch:** `claude/blueprint-seed` (pushed, up to date).

Shipped (committed + pushed):
- **Rebranded shell:** `index.html` (title/h1 "Blueprint — drawing to printable
  solid"), `js/main.js`, `build.mjs` (outputs `dist/blueprint-local.html`),
  `js/version.js` (`APP_VERSION = '0.1.0'`), `README.md`, `package.json`
  (`name: "blueprint"`).
- **Shared core kept BYTE-IDENTICAL to 2.5D** (so cross-repo cherry-picks stay
  trivial): `js/mesh.js`, `js/contour.js`, `js/exporters.js`, `js/lens.js`,
  `js/units.js`, `js/screws.js`, `js/homography.js`, `js/viewer3d.js`,
  `js/ui/traceEditor.js`, `js/ui/viewport.js`,
  `js/import/{loops,dxfImport,svgImport,cadImport}.js`, `vendor/*`,
  `css/style.css`, and the `test/e2e.mjs` harness scaffolding.
- **pdf.js** vendored + inlined (`vendor/pdf.min.js`; worker runs from a Blob URL
  built from an inlined source string — works from `file://`, smoke-tested on the
  2.28 MB `dist/blueprint-local.html`).
- `js/import/pdfImport.js` — `parsePDF`/`importPDF`: walk `getOperatorList()`
  path ops (MOVE/LINE/CURVE*/CLOSE/RECT), apply content CTM + viewport transform,
  flatten cubics → polylines (points, y-down) + `texts:{str,x,y,page}`; scale
  pts→mm (`PT_TO_MM = 25.4/72`); `assembleViews` per page; `unitsKnown:false`.
- `js/import/pdfScale.js` — `parseNumberLoose` (strips leading `⌀ØΦϕR=`, reads
  decimal/fraction/mixed), `readTitleBlock` (units mm/in, `SCALE n:m`, part
  name), `suggestScale` (finds the dimension labeling the view's overall width,
  derives true scale, cross-checks the scale note, trusts the printed dimension
  on conflict).
- **Units picker** in the import modal (`#cadUnits` mm/in with `#cadUnitsHint`),
  defaulted to the detected unit; `recomputePdfScale()` re-derives on units/view
  change. Handles mixed inch/mm drawing sets.
- **Tests:** `test/e2e.mjs` — 94 pass / 0 fail. PDF fixtures hand-authored with
  correct xref offsets (`buildPDF`, `pdfCircle`, `rectMM`), plus `SCALED_PDF`
  (1:2, title block) and `INCH_PDF`.

Latest commits on the branch:
`b0fef29` units picker · `f8a7f95` read-the-drawing · `974532a` PDF vector import
· `3d998af` seed fork.

**Shipped — hole callouts (#23) [S2a]:** `js/import/holeCallouts.js` exports
`parseCallouts(texts)` (glyph + ASCII grammar: `⌀`/`Ø`, `THRU`, `CBORE`/`⌴`,
`CSK`/`⌵`, `DEEP`/`▼`, `nX`; values in drawing units), `matchCallouts(callouts,
holes, mmPerUnit)` (fits each loop with `fitCircle`, clusters concentric loops
into bore+rim groups, assigns by diameter + multiplicity + concentric-rim, folds
rims in, emits `holeTemplate`-shaped circles), and `reassembleRuns(texts)` (pdf.js
splits a leading `Ø` into its own item — this regroups items per line by y and
joins by x-gap so callouts read as whole strings). `pdfImport.js` now carries
`w/h/page` on each text item to support that. `useCadView` (`js/main.js`) runs
parse→match on the selected view's page for PDFs, and when circles match raises a
`#calloutModal` (Apply as holes / Keep as traced loops) via `openCalloutModal` →
`finishCadImport`. `.callout-list` styled in a scoped `<style>` in `index.html`
(keeps shared `css/style.css` byte-identical). Tests: `test/e2e.mjs` §17 — parse,
match, file-input Apply + Skip integration; **109 pass / 0 fail**; `file://` smoke
on `dist/blueprint-local.html` confirmed (callout modal + Apply, no page errors).

## The queue — Blueprint work items

| # | Item | Status | Notes |
|---|------|--------|-------|
| **23** | **Hole callout parsing** (⌀ / counterbore / countersink / depth / `nX`) → auto-apply with confirm | **SHIPPED (S2a)** | `js/import/holeCallouts.js` (`parseCallouts`+`matchCallouts`+`reassembleRuns`), `#calloutModal` confirm, wired into `useCadView`. PDF text layer only. Suite 109/0. |
| 27 | Picatinny / STANAG rail PDF acceptance test (mixed inch/mm) end-to-end | Pending | **Blocked: needs the actual vector PDF files** — only drawing images exist so far (images won't parse as geometry). Callout notation is known: `5X Ø.206 ▼ .374`, `⌴ Ø.448 ▼ .151`, `17x .21`; one sheet inches, one mm. |
| — | OCR for scanned PDFs (v1.1) | Deferred | Detect image-only pages, vectorize linework, read numbers with Tesseract.js (inline, ~+2–4 MB). Separate release once the vector path is proven. |
| — | 3D-from-views (endgame) | Long-term | Multi-view (plan + section) → solid; needs a CSG kernel, unrelated to the 2.5D extrude path. |
| — | Fork housekeeping | Ongoing | (a) rename the product — "Blueprint" is a working name; (b) lift into its own repo eventually; (c) decide when to rebrand **internal** format keys (currently unchanged on purpose — see Constraints). |

## Constraints

- **Client-side single-file app**, must run from `file://` (esbuild IIFE + inlined
  vendor libs). pdf.js worker must run from a Blob URL built from inlined source.
- **Keep shared-core files byte-identical to 2.5D** so fixes cherry-pick cheaply
  between the two. Diverge only in the rebranded shell (`index.html`, `main.js`,
  `build.mjs`, `version.js`, `README.md`, `package.json`) and new `js/import/*`.
- **Internal project-format keys intentionally left as 2.5D's** (`app:'2.5D'`,
  `LIB_KEY`, `-2p5d.stl` suffix, STL header `"2.5D v"`) so the inherited test
  suite stays green. Rebranding these is a deliberate future decision, not an
  accident.
- **Push only to `claude/blueprint-seed`.** Commit with
  `git -c core.hooksPath=/dev/null`, co-author `Claude Fable 5`.
- **Never put the model identifier in commits, PR bodies, code, or any pushed
  artifact** — chat replies only.

## Decisions + reasoning

- **Fork rather than bolt onto 2.5D** — drawing-import is a different product for
  a different user and drags in megabytes of deps (pdf.js, later Tesseract). Seed
  on a branch here for now; own repo later.
- **Packaging = A (inline everything into one self-contained file).**
- **Scale = cross-checked** — scale-note is the first guess, the dimension number
  verifies/corrects it; on disagreement **trust the label**, uniformly rescale,
  notify.
- **Dimension→edge matching = auto-pair, then user confirms.**
- **Title block reads units + scale-note + part name.**
- **Hole callouts = full parse + auto-apply with a manual confirm step.**
- **Multi-page = view/page picker** (reuses the existing `#cadModal` grid).
- **Geometry-vs-label conflict = trust the label.**
- **Mixed units = user-confirmable units picker** (prompted by the Picatinny note
  "you can ask units if you're unsure").
- **Hole-callout matching by diameter + multiplicity + concentric-rim**, not by
  text position — avoids reconciling the text (points, y-down, unshifted) vs
  geometry (mm, shifted, scaled) coordinate frames. Grammar accepts glyphs and
  ASCII synonyms (also lets fixtures round-trip through the minimal test font,
  where only `Ø`=`\330` survives).
- **DWG unsupported** → tell users to "export as DXF."
- **OCR staged to v1.1** — v1 is vector PDF + text layer only.

## Open questions

- Product name — is "Blueprint" the keeper, or a placeholder?
- When to lift Blueprint into its own repo, and when (if ever) to rebrand the
  internal format keys.
- Source the actual **vector** Picatinny/STANAG PDFs for #27 (the images alone
  can't drive the geometry path).
- Any callout notations beyond the planned set worth supporting up front?

---

## STARTER PROMPT — copy everything below this line

---

[Picking up a thread from another conversation — fork-this handoff]

NAME THIS CHAT: Blueprint — drawing→CAD — S2a (2026-07-21)

I was working on: **Blueprint** — a browser-only, single-file, client-side tool
that imports a CAD drawing (DXF/SVG/PDF), reads its dimensions, and extrudes it
into a printable solid. Forked from **2.5D** (photo→solid) so it inherits that
app's trace editor, hole/section model, mesh, exporters, and single-file build.

Background: forked from "2.5D + Blueprint build session," S1. Blueprint lives on
branch `claude/blueprint-seed` in repo `zillaness/2.5D`. Steps 1–3 shipped: fork
seed + rebrand, inline pdf.js + PDF vector geometry → view picker → trace, and
"read the drawing" (title-block units/scale/part-name + dimension-derived true
scale + mixed inch/mm units picker). 94 tests pass; the `file://` PDF smoke
passes on `dist/blueprint-local.html`.

Skills to load at session start:
- fork-this (only if you need to fork again)

Project state:
- Branch `claude/blueprint-seed`, pushed. Key files: `js/import/pdfImport.js`,
  `js/import/pdfScale.js`, rebranded `index.html`/`js/main.js`/`build.mjs`,
  `js/version.js` (0.1.0). Shared core is byte-identical to 2.5D.
- Next increment (hole callouts, #23) is fully planned in
  `/root/.claude/plans/tingly-baking-clarke.md`.
- Full work queue is in `docs/handoff-blueprint.md` on the branch.

Constraints:
- Single-file, runs from file://; pdf.js worker from an inlined Blob URL.
- Keep shared-core files byte-identical to 2.5D; diverge only in the shell + new
  `js/import/*`.
- Internal format keys stay 2.5D's on purpose (keeps the suite green).
- Push only to `claude/blueprint-seed`; commit with
  `git -c core.hooksPath=/dev/null`, co-author `Claude Fable 5`; never put the
  model id in anything pushed.

Decisions already made:
- Fork (not bolt-on); inline packaging; scale cross-checked with trust-label
  override; title block reads units/scale/name; hole callouts full-parse +
  confirm; multi-page picker; mixed-unit picker; OCR deferred to v1.1;
  hole-callout matching by diameter + multiplicity + concentric-rim.

Open questions:
- Product name; when to split into its own repo / rebrand internal keys; sourcing
  vector Picatinny PDFs for #27.

Start here: Build **task #23 (hole-callout parsing)** per the plan in
`/root/.claude/plans/tingly-baking-clarke.md` — create `js/import/holeCallouts.js`
(`parseCallouts` + `matchCallouts`), wire it into the end of `useCadView`
(`js/main.js`) for PDFs, add the `#calloutModal` confirm UI, extend `test/e2e.mjs`
with parse/match/integration fixtures, rebuild `dist/blueprint-local.html`, keep
the suite green, then commit + push to `claude/blueprint-seed`. First confirm the
plan still matches intent before writing code.
