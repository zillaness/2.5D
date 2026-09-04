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
- 05:26 ✅ e2e suite self-reports its check total — committed (see below)
- 05:26 ▶ NEXT: doc sweep for v1.23.0 (README + docs/holders-prd.md behind the shipped feature set)

## Queue
1. ~~e2e check-count self-reporting~~ done
2. Doc sweep for v1.23.0: README and `docs/holders-prd.md` predate puzzle tabs,
   bed tiling, grid/mat references and the back-photo fork.
3. `docs/nesting_prd_v1.0.md` — DRAFT FOR SIGN-OFF only. Sam has not approved
   building nesting.
4. STL tiling of printed inserts with registration features — design only, stop
   before implementing.

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

## Handoff
(filled at soft-stop or limit)

## CHANGELOG
- v1.0 (2026-09-04): Initial ledger for the 2026-09-04 burndown.
