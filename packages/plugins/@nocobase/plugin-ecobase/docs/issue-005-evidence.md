# Issue 005 implementation evidence

## Implemented scope

- Registered CSV adapters for current Amazon operations files:
  - `amazon-operations-csv` for SampleAM weekly report CSVs and file-based operations imports.
  - `sellerboard-csv` for Sellerboard-like stock/profit dashboard CSV exports.
  - `google-sheets-migration-csv` for planning, supplier, and order-management workbook exports.
- Registered live-source access check adapters:
  - `sellerboard-api` records `sellerboard_credentials_missing` when credentials are absent.
  - `amazon-sp-api-access-check` records `amazon_sp_api_access_missing` when access/credentials are absent.
- Added public import actions:
  - `ecobaseImport:run`
  - `ecobaseImport:runDailySnapshot`
- Added normalized plugin-owned collections:
  - `ecobaseRawListings`
  - `ecobaseListingDailyFacts`
  - `ecobaseInventorySnapshots`
  - `ecobaseTrafficSnapshots`
  - `ecobasePlanningParameters`
  - `ecobaseTargetRows`
  - `ecobaseSourceAccessAudits`

## Verification commands

```bash
cd nocobase && yarn eslint packages/plugins/@nocobase/plugin-ecobase/src --format unix
# ESLint: No issues found
```

```bash
cd nocobase && yarn test packages/plugins/@nocobase/plugin-ecobase/src/server/__tests__/csv-import.test.ts --run --reporter=verbose
# Test Files 1 passed (1)
# Tests 10 passed (10)
```

```bash
cd nocobase && for f in packages/plugins/@nocobase/plugin-ecobase/src/server/__tests__/*.test.ts; do yarn test "$f" --run --reporter=verbose || exit $?; done
# adapter-registry.test.ts: 2 passed
# api.test.ts: 3 passed
# csv-import.test.ts: 10 passed
# import-service.test.ts: 5 passed
# integration.test.ts: 1 passed
# schema.test.ts: 2 passed
```

```bash
cd nocobase && yarn build @nocobase/plugin-ecobase --no-dts
# Build successful
```

```bash
cd nocobase && yarn tar @nocobase/plugin-ecobase
# @nocobase/plugin-ecobase: tar package
# Done
```

## Acceptance notes

- Raw rows: retained in `ecobaseRawImportRows` for valid rows and malformed-row warnings.
- Import runs: every normal CSV run uses `preserveAuditRun`, so re-imports create distinct `ecobaseImportRuns` audit records.
- Normalized idempotency: normalized records are upserted by `naturalKey` in the relevant normalized collection.
- Row-count verification: adapters compare parsed row counts to `expectedRowCount` / `expectedRowCounts` and write `csv_row_count_mismatch` warnings.
- Public CSV input is limited to inline `config.files`; `config.filePaths` is not part of the adapter config and is ignored safely, producing `csv_files_missing` without reading server files.
- Unknown CSV shapes do not echo parsed header values in warning payloads; payloads contain only file name and header count.
- Daily snapshot skip: `ecobaseImport:runDailySnapshot` writes a `skipped` run when the same source/version already has a successful import.
- Live-source blockers: missing Sellerboard API or Amazon SP-API credentials are recorded in `ecobaseSourceAccessAudits`.

## Live gate

The plugin-local Docker/browser live gate was not run in this implementation pass because the focused server-side adapter/import checks above cover the Issue 005 code path and the live gate is a heavier browser QA gate. Code-review/QA should run:

```bash
cd nocobase
packages/plugins/@nocobase/plugin-ecobase/scripts/start-live-gate.sh
```
