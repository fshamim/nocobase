# Inventory Planning final staging stabilization

## Verdict

**INCOMPLETE — not a staging go-live sign-off.** Production was not touched. No source import or staging reset was run.

- Production: `https://ecobase.178-104-193-132.sslip.io/` — not accessed.
- Staging: `https://ecobase-staging.178-104-193-132.sslip.io/` — validation target.

This run contains valid baseline and repair evidence, but it does not complete the authoritative FS00–FS23 task plan. Only FS00 and FS01 have sufficient evidence to retain `PASS`; FS02–FS08 are partial, and FS09–FS23 are not completed by this run.

## Deployment identity

- Branch: `ecobase/staging`
- Stabilization code: `7a0e216ec24e12e42f3775922ca5afeb898c61d5`
- Final deployment head: `14b92faea20eb15f84354108dcc108561683b3c4`
- Executable UI/evidence code: `5fc937d09d`
- Deployment run: `29376124462` — success
- Container start: `2026-07-14T23:35:06.669766688Z`
- Runtime errors after readiness: 0

## Changes applied

- Reconciled all 17 exact ClickUp inbound/direct-ship orders covering 74 lines.
- All 74 lines are explicitly `review_required`: 72 lack a Sellerboard baseline and 2 have Sellerboard evidence that remains non-terminal. No line silently fell through and no inventory event was fabricated.
- Enabled current-order-cycle selection and default expected-arrival derivation with a 30-day default lead time plus 3 receiving-buffer days.
- Materialized one current order cycle per family. Older cycles remain visible as evidence but no longer contribute to active coverage.
- Recorded 44 excluded older-cycle decisions across 32 families: 33 `completed_by_later_inbound` decisions and 11 `review_required` decisions. Silver lifecycle history was preserved; these are bounded Gold selection decisions, not destructive source rewrites.
- Updated Inventory Planning labels and drawer evidence to expose current order reference, current-cycle quantity, older-cycle exclusions, receipt review state, and expected-arrival source/freshness.

## Before → after

| Measure | Before | After |
|---|---:|---:|
| Distinct active order references | 74 | 42 |
| Target-family open-order coverage | 3,123 | 1,323 |
| Reference open quantity | 9,393 | 2,833 |
| Active rows with unknown expected arrival | 119 | 0 |
| Active rows with derived expected arrival | 0 | 121 |
| Receipt-review lines | 0 | 74 |
| Receipt-review orders | 0 | 17 |
| Families with cycle evidence | 0 | 110 |
| Family rows requiring cycle review | 0 | 10 |
| Supply Action pane | 119 | 142 |
| Active Orders pane | 80 | 109 |
| Missing Supplier pane | 18 | 11 |
| Stuck Inventory pane | 112 | 109 |

## Preservation and integrity

- Products: 1,857
- Company products: 2,136
- Product families: 1,780
- Inventory snapshots: 2,136
- Silver orders / lines: 44 / 156
- Sellerboard daily facts: 51,099
- Gold inventory rows: 2,136
- Rows with unit cost: 1,336
- Rows with preferred supplier: 1,264
- Duplicate Gold natural keys: 0
- Duplicate family targets: 0
- Orphan order lines: 0
- Source import runs during stabilization: 0
- Enabled Sellerboard schedules: 0
- Gold scheduler: manual

## Verification

- Receipt apply: 17 orders, 74 lines; repeat apply found 0 candidates.
- Gold rebuild: exactly once; 2,136 rows updated.
- Semantic verifier: `ok=true`, 0 technical blockers, 2 approved business ambiguities (`boundary_ambiguous`, `product_not_found`).
- Focused regression suite: 164 tests passed; post-UI 39-test rerun passed.
- ESLint: clean.
- Plugin build: passed.
- Anonymous command-center and Gold reads: HTTP 401 / 401.
- Agent-browser: Supply Action, Active Orders, Stuck Inventory, current-order drawer, cycle labels, receipt review, and expected-arrival evidence rendered without blank/error pages.

## Rollback

Pre-write backup: `/root/backups/ecobase-inventory-stabilization-20260714T224015Z.dump`

SHA-256: `ea3cf3dfd8d83603150672447573836ba7582e94e92fdde1b8a9b7d08f5fae1d`
