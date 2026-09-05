---
file: BURNDOWN.md
version: 1.0
author: Sam Cao
created: 2026-09-04
last_updated: 2026-09-04
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
- ▶ NEXT: labelling step 2, layoutLabelGeometry() in js/holders.js

## Queue
1. ~~e2e check-count self-reporting~~ done
2. ~~Doc sweep for v1.23.0~~ done. Scope was smaller than the handoff implied:
   the README *body* already documented puzzle tabs and bed tiling. Only the
   Roadmap block was stale (it never absorbed the holders arc at all).
3. ~~`docs/nesting_prd_v1.0.md`~~ drafted, awaiting sign-off. Not implemented.
4. ~~STL tiling of printed inserts~~ design note written, awaiting a decision on
   the registration scheme before a PRD is worth writing.

## Blocked (do not attempt unattended)
- Logo PNG swap — needs an asset from Sam.
- Real-photo validation of the mat/grid auto-count — needs real photographs.
- 3MF export — deferred, no decision.
- Nesting implementation — needs sign-off on the PRD in item 3.

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
- **Sign-off on `docs/labelling_prd_v1.0.md`**, plus answers to its open
  questions 1 (single-line fonts for routers, deferring is a real cost) and 4
  (a third `engrave` SVG layer, which changes the exported layer set). Those
  two change the shape of the work rather than a default.
- **Sign-off on `docs/nesting_prd_v1.1.md`.** Steps 1-4 of its plan are the
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
