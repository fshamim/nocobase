# Ecobase staging replay and pre-live package

Frozen manifest: `pre-live-replay-manifest-20260717.json`

## Scope and hard boundaries

- Deploy and replay **staging only**.
- Production is forbidden until the user separately approves Phase 14.
- Do not push `ecobase/staging`; Dokploy auto-deploy is enabled. Transfer the reviewed Git bundle privately and deploy the exact verified commit.
- Do not drop the PostgreSQL schema or whole database. `canonical-rebuild` is the FK-safe supplier/order domain reset: it replaces canonical source-owned supplier/order rows transactionally while asserting that companies, Amazon accounts, products, company-products, families, and tiers are unchanged.
- Do not use legacy supplier/order endpoints, migration flags, direct SQL business imports, or compatibility shims.

## Staging readiness gates

All gates are fail-closed. Preserve evidence and stop on the first mismatch.

1. **Revision and runtime**
   - Verify the transferred bundle SHA-256 and `git bundle verify`.
   - Verify the deploy commit contains manifest `revision.acceptedCodeCommit` and descends from `revision.requiredAncestryBase`.
   - Verify the plugin diff SHA-256 and every frozen implementation-file SHA-256.
   - Confirm the target is Dokploy compose `Ecobase Staging` / app `ecobase-staging-2ndggj`.
   - Confirm production containers, database, volumes, and compose are distinct and remain untouched.

2. **Exact database and backup**
   - Require `DB_DATABASE=nocobase_rc_20260715t141025` before any staging mutation.
   - Disable staging Sellerboard/ClickUp schedules and prevent concurrent imports.
   - Take a full staging PostgreSQL backup and verify it with `pg_restore --list`.
   - Record the backup path/SHA-256, runtime image/commit, container IDs, database name, current published Gold run, counts, and protected-catalog fingerprint.

3. **Authoritative source bundle**
   - Require exactly the five manifest source files: Supplier IDs, Supplier Tracker, Purchase Orders, Order Details, and ClickUp.
   - Verify every source SHA-256 before preview.
   - Use source version `2026-07-16` and the canonical parser only.

4. **Canonical preview and apply**
   - Preview `supplier_ids`, `supplier_tracker`, `purchase_orders`, and `order_details` in `canonical-rebuild` mode against the live staging catalog.
   - Require `ready=true`, zero blockers, source-plan digest `a421a971946e3fb8ed42b086d8b12a888660be13e1efaf6c503071587af1e8af`, 1,272 orders, 3,557 lines, 2,236 exact-member lines, 1,043 family-only lines, 278 unresolved mapping exceptions, and zero blocked lines.
   - The remote catalog and preflight digests must be newly generated; never reuse the local confirmation token.
   - Apply only with `APPLY_SUPPLIER_ORDER_<first 12 chars of the new preflight digest>`.
   - Require the protected-catalog fingerprint to equal the pre-apply fingerprint.
   - Preview and apply the identical canonical bundle a second time. Require `noOp=true`, `totalWrites=0`, and no field updates.

5. **ClickUp and receipts**
   - Run ClickUp dry-run, apply with forced reconciliation, then post-apply dry-run.
   - Require zero blocking issues, zero missing main-task references, zero unapproved multi-order conflicts, and zero proposed workflow drafts after apply.
   - Require deterministic comments/actors with no duplicate identities.
   - Require every affected current-cycle order and line to have receipt state; unresolved evidence must be `review_required`, never null.

6. **Gold and acceptance**
   - Refresh candidate Gold only after canonical and ClickUp transactions pass.
   - Use the existing Gold refresh action, which verifies the candidate before publication; record the published run ID.
   - Keep schedules disabled until every acceptance command and browser check passes.

## Staging execution order

```text
1. verify bundle, ancestry, commit, and hashes
2. assert exact staging compose/app/database and production separation
3. disable staging schedules and concurrent imports
4. backup staging and validate the backup
5. capture protected-catalog fingerprint and baseline counts
6. deploy the exact corrected commit to staging
7. verify runtime commit and health without importing
8. verify the five source hashes
9. canonical preview with a newly generated staging digest
10. canonical-rebuild apply
11. protected-catalog and relationship verification
12. identical canonical preview/apply; require zero writes
13. ClickUp dry-run/apply/post-apply dry-run
14. receipt/current-cycle reconciliation gates
15. candidate Gold refresh, verification, and publication
16. full tests, semantic/relationship checks, API checks, and browser verification
17. re-enable staging schedules only after signoff
```

## Acceptance suite

Run from the verified deployment worktree:

```bash
git status --short
git merge-base --is-ancestor f195d03d7def4bccecb56b5292ad95d655ca16e3 HEAD

files=$(find packages/plugins/@nocobase/plugin-ecobase/src \
  -name '*.test.ts' -o -name '*.test.tsx' | sort)
yarn -s vitest run $files --pool=forks --poolOptions.forks.singleFork=true

yarn -s eslint packages/plugins/@nocobase/plugin-ecobase

NODE_OPTIONS=--max-old-space-size=8192 \
  yarn -s build @nocobase/plugin-ecobase --only
```

Data gates must prove:

- protected company/account/product/company-product/family/tier counts and fingerprint are unchanged;
- zero new/deleted families and zero replenishment-target changes caused by the import;
- all PO supplier IDs resolve to one canonical supplier identity;
- 1,272 canonical PO headers and 3,557 canonical lines are retained before ClickUp workflow drafts;
- accepted lines have order, supplier, ASIN, positive quantity, and family linkage;
- no accepted line uses `family_target` or crosses company/account/marketplace boundaries;
- canonical second apply has zero writes;
- ClickUp second dry-run proposes zero writes/drafts;
- receipt and pipeline conservation checks have zero blocking failures;
- strict semantic verification has zero errors and zero blocking errors;
- Import Status and Inventory Planning load without browser console errors;
- all ten inventory panes are reachable; `prep-in-progress` and `in transit to prep` appear only in In-Prep Monitoring; untiered active-order families appear only in Untiered Products; row drawers show source/target supplier and line-level order evidence.

## Evidence to retain

- Git bundle path and SHA-256;
- deployed commit, image ID, and runtime proof;
- staging backup path/SHA-256 and `pg_restore --list` result;
- source manifest and hashes;
- before/after protected-catalog fingerprints;
- canonical preview, confirmation digest, first apply, and zero-write second apply;
- ClickUp dry-run/apply/post-apply results and receipt coverage;
- Gold candidate/verification/publication result;
- test, lint, build, semantic, API, and browser artifacts.

## Staging rollback

Rollback is whole-database, not a partial compatibility path:

1. Stop the staging app and schedules immediately.
2. Preserve the failed run manifest and logs.
3. Restore the verified pre-replay backup into a new staging database.
4. Point staging only at the restored database and run read-only health/fingerprint checks.
5. Start staging only after the protected fingerprint and previously published Gold run match the pre-replay evidence.
6. Keep the failed database isolated; do not merge rows back manually.

## Phase 14 — production replay (not approved)

No production mutation is allowed under this package. After staging signoff and separate user approval, repeat the same backup, new production preview/digest, canonical rebuild, idempotency, ClickUp/receipt, candidate Gold, acceptance, publication, and evidence-retention sequence against production. Never reuse a staging digest or confirmation token in production.
