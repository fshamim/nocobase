# Ecobase BI plugin

This plugin is the source-controlled foundation for Ecofission BI. It owns the initial company/account/source/import schema, source-adapter registry, no-op import action, current Amazon operations CSV ingestion, normalized planning/snapshot tables, and import/source status UI source.

## Local source setup

From the `nocobase/` repository root:

```bash
yarn install
# For the repository docker-compose Postgres service, .env must point to the exposed host port:
# DB_HOST=localhost
# DB_PORT=10103
docker compose up -d postgres
# If this source checkout database is empty, initialize NocoBase before enabling plugins:
yarn nocobase install -f
yarn pm enable @nocobase/plugin-ecobase
yarn nocobase upgrade
yarn dev
```

This is the primary development loop. The plugin source of truth stays in `packages/plugins/@nocobase/plugin-ecobase`; do not develop by manually copying built plugin folders into a running app volume.

## Ecobase image build

Build the product image from this fork with:

```bash
packages/plugins/@nocobase/plugin-ecobase/scripts/build-image.sh ecobase/nocobase:local
```

The image build compiles and packages `@nocobase/plugin-ecobase` from this source tree, then places the packaged plugin in the NocoBase runtime image. Deployment still needs the target database to run upgrade/enable once:

```bash
yarn nocobase upgrade --skip-code-update
yarn pm enable @nocobase/plugin-ecobase
```

## Automated seam validation

The focused NocoBase seam test is:

```bash
yarn test packages/plugins/@nocobase/plugin-ecobase/src/server/__tests__/integration.test.ts --run --reporter=verbose
```

It boots the plugin through `createMockServer`, verifies plugin-owned collection repositories are synced, creates a source connection through the resource API, invokes `ecobaseImport:adapters` and `ecobaseImport:runNoop`, then reads back `ecobaseImport:status`. This test fails closed in normal review and CI runs; the repository includes the `sqlite3` test dependency used by the default `createMockServer` database configuration.

## Live Docker/browser QA gate

For final QA of plugin runtime or UI behavior, run the isolated Docker live gate from the `nocobase/` repository root:

```bash
packages/plugins/@nocobase/plugin-ecobase/scripts/start-live-gate.sh
```

The script builds the Ecobase image, starts an isolated Postgres + NocoBase Docker Compose project, enables `@nocobase/plugin-ecobase`, waits for `/admin/settings/ecobase`, and prints the URL plus local admin credentials. QA must open the printed URL in a browser, verify the Ecobase status page, capture evidence, then clean up:

```bash
packages/plugins/@nocobase/plugin-ecobase/scripts/stop-live-gate.sh
```

If Docker or browser automation is unavailable, QA must report the live gate as `BLOCKED`, not `PASS`.

## Current Amazon operations CSV import

Issue 005 adapters are registered through the same Issue 004 source-adapter seam:

| Adapter | Source connection `sourceType` | Purpose |
| --- | --- | --- |
| `amazon-operations-csv` | `seller_central_file` | SampleAM weekly CSV shapes and Sellerboard-like CSV exports when imported as files. |
| `sellerboard-csv` | `sellerboard` | Sellerboard stock/profit dashboard CSV exports. |
| `google-sheets-migration-csv` | `google_sheets` | Planning targets, supplier defaults/lead times, and order-management workbook exports. |
| `sellerboard-api` | `sellerboard` | Slim live-source check; records a credential blocker when API credentials are absent. |
| `amazon-sp-api-access-check` | `amazon_sp_api` | Slim Amazon SP-API access check; records an access blocker when approval/credentials are absent. |

Documented sample row counts for row-count verification:

| File shape | Sample file | Expected data rows |
| --- | --- | ---: |
| MasterStock | `data/SampleAM Weekly Report-July2025 - MasterStock.csv` | 1998 |
| Profit Planning | `data/SampleAM Weekly Report-July2025 - Profit Planning.csv` | 2057 |
| Profit Tracker | `data/SampleAM Weekly Report-July2025 - Profit Tracker.csv` | 258 |
| Top SKU'S | `data/SampleAM Weekly Report-July2025 - Top SKU'S.csv` | 1250 |
| Buybox | `data/SampleAM Weekly Report-July2025 - Buybox.csv` | 208 |
| Sellerboard dashboard goods | `data/Fissionem_DashboardGoods_30_04_2026-31_05_2026_(2026_06_01_02_08_33_779).csv` | 4350 |
| Sellerboard dashboard totals | `data/Fissionem_DashboardTotals_30_04_2026-31_05_2026_(2026_06_01_02_07_53_685).csv` | 32 |
| Sellerboard stock | `data/Fissionem_Stock_(2026_06_01_02_06_56_070).csv` | 434 |
| Supplier IDs | `data/order-managment-sheets/Copy of Ecofission-Order Management - Supplier IDs.csv` | 2052 |
| OrderDetails | `data/order-managment-sheets/Copy of Ecofission-Order Management - OrderDetails.csv` | 6129 |
| Pre-Order Sheet | `data/order-managment-sheets/Copy of Ecofission-Order Management - Pre-Order Sheet.csv` | 304 |
| Purchase Orders | `data/order-managment-sheets/Copy of Ecofission-Order Management - Purchase Orders.csv` | 4203 |

CSV adapters read inline uploaded or seeded CSV content from source connection `config.files`. Public server-side file path imports are intentionally not supported; sample-file loading must happen in trusted tests/dev helpers that pass file contents inline.

```json
{
  "files": [
    {
      "name": "SampleAM Weekly Report-July2025 - MasterStock.csv",
      "content": "Company,ASIN,SKU,...",
      "expectedRowCount": 1998,
      "snapshotDate": "2025-07-01"
    }
  ]
}
```

Run a configured adapter through the public action:

```http
POST /api/ecobaseImport:run
{
  "sourceConnectionId": "<source-connection-id>",
  "adapterName": "amazon-operations-csv",
  "sourceIdentifier": "master-stock-july-2025",
  "sourceVersion": "2025-07-01"
}
```

Daily/manual snapshot imports use the skip/no-newer-data path:

```http
POST /api/ecobaseImport:runDailySnapshot
{
  "sourceConnectionId": "<source-connection-id>",
  "adapterName": "amazon-operations-csv",
  "sourceIdentifier": "daily-master-stock",
  "sourceVersion": "2025-07-01"
}
```

If the same source/version already has a successful run, the daily action writes a distinct `skipped` import run with the no-newer-data message. Normal CSV re-imports always preserve a distinct import-run audit trail while upserting normalized records by source/date/key.

Normalized records are stored in plugin-owned collections:

- `ecobaseRawListings`
- `ecobaseListingDailyFacts`
- `ecobaseInventorySnapshots`
- `ecobaseTrafficSnapshots`
- `ecobasePlanningParameters`
- `ecobaseTargetRows`
- `ecobaseSourceAccessAudits`

## API smoke test

1. Create a company through the `ecobaseCompanies:create` collection API.
2. Create a source connection through `ecobaseSourceConnections:create` using `sourceType: "noop_test"`.
3. Run the no-op adapter:

```http
POST /api/ecobaseImport:runNoop
{
  "sourceConnectionId": "<source-connection-id>",
  "sourceIdentifier": "manual-noop",
  "sourceVersion": "v1"
}
```

4. Read import/source status:

```http
GET /api/ecobaseImport:status
```

## UI

The status page is registered through the standard NocoBase client plugin surface at `/admin/settings/ecobase` and reads `ecobaseImport:status`. This checkout's plugin loader and build tooling expect `client.js`, `dist/client/index.js`, and `src/client`, matching the existing bundled plugins.

The local pi NocoBase plugin skill currently recommends `src/client-v2`, but this repository's plugin build and server plugin URL endpoint still emit `dist/client/index.js` from `src/client`. Keep Ecobase on `src/client` until the fork has a tested v2 app entry, v2 plugin bundle build, and runtime loader path.
