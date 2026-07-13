#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { businessFingerprint, validateBundleManifest } from './greenfield-seed-lib.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(SCRIPT_DIR, '..');
const NOCOBASE_ROOT = path.resolve(PLUGIN_ROOT, '../../../..');
const PROJECT_ROOT = path.dirname(NOCOBASE_ROOT);
const GREENFIELD_PROJECT_ROOT = path.resolve(process.env.ECOBASE_GREENFIELD_PROJECT_ROOT ?? PROJECT_ROOT);
const GREENFIELD_BUNDLE_PATH = process.env.ECOBASE_GREENFIELD_BUNDLE_PATH
  ? path.resolve(process.env.ECOBASE_GREENFIELD_BUNDLE_PATH)
  : undefined;
const ARTIFACT_DIR = process.env.ECOBASE_LIVE_GATE_BOOTSTRAP_DIR
  ? path.resolve(process.env.ECOBASE_LIVE_GATE_BOOTSTRAP_DIR)
  : path.join(NOCOBASE_ROOT, '.local', 'live-gate-bootstrap');
const PRIVATE_EXPORT_PATH = path.join(ARTIFACT_DIR, 'live-gate-sources.private.json');
const REDACTED_EXPORT_PATH = path.join(ARTIFACT_DIR, 'live-gate-sources.redacted.json');
const IMPORT_STAGE_LOG_PATH = path.join(ARTIFACT_DIR, 'import-stages.json');
const PREFLIGHT_REPORT_PATH = path.join(ARTIFACT_DIR, 'import-preflight.json');
const importStageLog = [];
const importMetrics = { inputRows: 0, acceptedRows: 0, discardedRows: 0 };
const STAGE_BUDGET_MS = new Map([
  [1, 300_000],
  [2, 1_200_000],
  [3, 3_600_000],
  [4, 1_200_000],
  [5, 1_200_000],
  [6, 300_000],
  [7, 600_000],
  [8, 600_000],
  [9, 1_200_000],
  [10, 300_000],
  [11, 900_000],
  [12, 300_000],
]);
const BASE_URL = (
  process.env.ECOBASE_LIVE_GATE_API_BASE ?? `http://127.0.0.1:${process.env.ECOBASE_LIVE_GATE_PORT ?? '13080'}/api`
).replace(/\/$/, '');
const APP_CONTAINER = process.env.ECOBASE_LIVE_GATE_APP_CONTAINER ?? 'ecobase-live-gate-app-1';
const PG_CONTAINER = process.env.ECOBASE_LIVE_GATE_POSTGRES_CONTAINER ?? 'ecobase-live-gate-postgres-1';
const ADMIN_EMAIL = process.env.ECOBASE_LIVE_GATE_ADMIN_EMAIL ?? 'admin@nocobase.com';
const ADMIN_PASSWORD = process.env.ECOBASE_LIVE_GATE_ADMIN_PASSWORD ?? 'admin123';
const BOOTSTRAP_SOURCE_VERSION = process.env.ECOBASE_BOOTSTRAP_SOURCE_VERSION ?? new Date().toISOString().slice(0, 10);
const SEED_PHASES = ['sellerboard', 'suppliers', 'orders', 'clickup', 'gold'];
const SEED_START_AT = process.env.ECOBASE_SEED_START_AT ?? 'sellerboard';
const SEED_STOP_AFTER = process.env.ECOBASE_SEED_STOP_AFTER ?? 'gold';
const SEED_SKIP_GOLD = process.env.ECOBASE_SEED_SKIP_GOLD === '1';
const SEED_PROFILE = process.env.ECOBASE_SEED_PROFILE ?? 'complete';
const DEPLOYMENT_TARGET = process.env.ECOBASE_DEPLOYMENT_TARGET ?? 'local';
const STAGING_FAST_FILES_BY_GROUP = new Map([
  ['clickup-order-status', ['data/clickup/Order Management Clickup Data 06-07-2026.csv']],
  [
    'order-management',
    [
      'data/order-managment-sheets/Ecofission-Order Management - Purchase Orders.csv',
      'data/order-managment-sheets/Ecofission-Order Management - OrderDetails.csv',
    ],
  ],
  [
    'supplier-management',
    [
      'data/supplier-management-sheets/Supplier Analysis Tracker - Supplier Analysis Tracker.csv',
      'data/supplier-management-sheets/Supplier Analysis Tracker - Supplier 2026.csv',
    ],
  ],
]);
const STAGING_FAST_GROUPS = new Set(STAGING_FAST_FILES_BY_GROUP.keys());
const SEED_HEARTBEAT_MS = Number(process.env.ECOBASE_SEED_HEARTBEAT_MS ?? 30_000);
const REQUIRED_SELLERBOARD_COMPANIES = ['Ecofission LLC', 'Muxtex INC', 'Retail Heaven Inc', 'Stop Shop LLC'];
const DEFAULT_CSV_SOURCES = [
  { name: 'Supplier Management CSV upload', sourceType: 'google_sheets', domain: 'supplier_management' },
  { name: 'Order Management CSV upload', sourceType: 'google_sheets', domain: 'order_management' },
  { name: 'ClickUp order status CSV upload', sourceType: 'clickup', domain: 'order_management' },
  { name: 'Buybox / Amazon Operations CSV upload', sourceType: 'seller_central_file', domain: 'amazon_operations' },
];
const HISTORY_COMPANY_BY_PREFIX = {
  Fissionem: 'Ecofission LLC',
  Muxtex: 'Muxtex INC',
  Retail_Heaven_Inc: 'Retail Heaven Inc',
  Stop_Shop_Llc: 'Stop Shop LLC',
};
if (!SEED_PHASES.includes(SEED_START_AT) || !SEED_PHASES.includes(SEED_STOP_AFTER)) {
  throw new Error(`invalid seed phase range: ${SEED_START_AT}..${SEED_STOP_AFTER}`);
}
if (SEED_PHASES.indexOf(SEED_START_AT) > SEED_PHASES.indexOf(SEED_STOP_AFTER)) {
  throw new Error(`seed start phase ${SEED_START_AT} is later than stop phase ${SEED_STOP_AFTER}`);
}
if (!Number.isFinite(SEED_HEARTBEAT_MS) || SEED_HEARTBEAT_MS <= 0) {
  throw new Error('ECOBASE_SEED_HEARTBEAT_MS must be a positive number');
}

const BUSINESS_TABLES = [
  'ecobaseImportRuns',
  'bronzeSourceRecords',
  'bronzeSourceFiles',
  'silverProducts',
  'silverAmazonAccounts',
  'silverCompanyProducts',
  'silverSuppliers',
  'silverSupplierExternalRefs',
  'silverSupplierAccounts',
  'silverSupplierProducts',
  'silverCompanyProductSuppliers',
  'silverOrders',
  'silverOrderLines',
  'silverInvoices',
  'silverActivityComments',
  'silverInventorySnapshots',
  'silverListingDailyFacts',
  'silverTrafficSnapshots',
  'ecobaseSellerboardProductCosts',
  'goldInventoryPlanningRows',
  'goldOrderPlanningRows',
  'goldSupplierAttentionRows',
  'goldManagementKpiDailyFacts',
];

const command = process.argv[2];
const args = new Set(process.argv.slice(3));

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

async function main() {
  await assertDeploymentBoundary();
  switch (command) {
    case 'export-sources':
      await exportSources();
      return;
    case 'preflight-data':
      preflightData();
      return;
    case 'reset-db':
      await resetDb();
      return;
    case 'restore-sources':
      await restoreSources();
      return;
    case 'import-data':
      await importData();
      return;
    case 'import-supplier-csvs':
      await importSupplierCsvs();
      return;
    case 'verify-links':
      await verifyLinks();
      return;
    case 'business-fingerprint':
      writeBusinessFingerprint();
      return;
    case 'deactivate-migration-sources':
      await deactivateMigrationSources();
      return;
    case 'purge-expired-bronze':
      await purgeExpiredBronze();
      return;
    case 'enable-schedules':
      restoreExportedSourceConfigs(loadPrivateExport());
      console.log('restored exported source schedules/configs');
      return;
    case 'all-after-export':
      preflightData();
      await resetDb();
      await restoreSources();
      await importData();
      return;
    default:
      printUsage();
      process.exit(command ? 1 : 0);
  }
}

function preflightData() {
  const script = path.join(PLUGIN_ROOT, 'scripts', 'preflight-import-data.ts');
  assertSeedProfileBundle();
  validateSourceExport(loadPrivateExport());
  const result = spawnSync('yarn', ['-s', 'tsx', script, '--output', PREFLIGHT_REPORT_PATH], {
    cwd: NOCOBASE_ROOT,
    env: {
      ...process.env,
      ECOBASE_PREFLIGHT_AS_OF_DATE: BOOTSTRAP_SOURCE_VERSION,
      ECOBASE_PREFLIGHT_SOURCE_EXPORT: PRIVATE_EXPORT_PATH,
      ECOBASE_SEED_PROFILE: SEED_PROFILE,
      ECOBASE_GREENFIELD_BUNDLE_PATH: GREENFIELD_BUNDLE_PATH,
      ECOBASE_GREENFIELD_PROJECT_ROOT: GREENFIELD_PROJECT_ROOT,
    },
    stdio: 'inherit',
  });
  if (result.status !== 0) {
    throw new Error(`Ecobase import preflight failed with exit code ${result.status ?? 'unknown'}.`);
  }
}

function requireSavedPreflight() {
  if (!existsSync(PREFLIGHT_REPORT_PATH)) {
    throw new Error(`staging-fast-clickup requires a successful pre-reset preflight at ${PREFLIGHT_REPORT_PATH}`);
  }
  const report = JSON.parse(readFileSync(PREFLIGHT_REPORT_PATH, 'utf8'));
  if (report.ok !== true || report.sellerboardCompleteness?.ok !== true) {
    throw new Error('staging-fast-clickup rejected an unsuccessful saved pre-reset preflight');
  }
  progressEvent('pre_reset_preflight_reused', {
    reportPath: PREFLIGHT_REPORT_PATH,
    sellerboardSourceCount: report.sellerboardCompleteness.sourceCount,
  });
  return report;
}

function printUsage() {
  console.log(`Usage: node scripts/live-gate-bootstrap.mjs <command> [--allow-non-clean]

Commands:
  export-sources     Save current live-gate source configs to ${PRIVATE_EXPORT_PATH}
  preflight-data     Validate configured import files without writing to the database
  reset-db           Destroy/recreate only the local live-gate DB volume, using the existing start-live-gate.sh guard
  restore-sources    Restore exported source rows and company IDs into a clean live-gate DB
  import-data        Require saved preflight for staging-fast-clickup, then run imports, Gold, and verification
  import-supplier-csvs  Import/retry only the supplier-management CSV files
  verify-links       Print/fail post-import medallion link checks
  business-fingerprint  Write the deterministic business fingerprint
  deactivate-migration-sources  Deactivate Google Sheets and ClickUp migration sources
  purge-expired-bronze  Delete Bronze records older than ECOBASE_BRONZE_PURGE_BEFORE
  enable-schedules   Restore exported source configs/schedules after verification passes
  all-after-export   preflight-data -> reset-db -> restore-sources -> import-data -> verify-links

Environment:
  ECOBASE_LIVE_GATE_PORT=13080
  ECOBASE_LIVE_GATE_ADMIN_EMAIL=admin@nocobase.com
  ECOBASE_LIVE_GATE_ADMIN_PASSWORD=admin123
  ECOBASE_BOOTSTRAP_SOURCE_VERSION=YYYY-MM-DD
`);
}

async function exportSources() {
  ensureArtifactDir();
  const exportData = {
    exportedAt: new Date().toISOString(),
    apiBase: BASE_URL,
    companies: psqlJson(`
      select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name, 'companyKey', c."companyKey") order by c.name), '[]'::jsonb)
      from "silverCompanies" c
      where c.id in (select distinct "companyId" from "ecobaseSourceConnections" where "companyId" is not null)
    `),
    sources: psqlJson(`
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', sc.id,
        'name', sc.name,
        'companyId', sc."companyId",
        'companyName', c.name,
        'companyKey', c."companyKey",
        'sourceType', sc."sourceType",
        'domain', sc.domain,
        'config', coalesce(sc.config, '{}'::jsonb),
        'secretRef', sc."secretRef",
        'freshnessSlaMinutes', sc."freshnessSlaMinutes",
        'active', sc.active
      ) order by sc."sourceType", sc.domain, c.name nulls first, sc.name), '[]'::jsonb)
      from "ecobaseSourceConnections" sc
      left join "silverCompanies" c on c.id = sc."companyId"
    `),
  };
  validateSourceExport(exportData);
  writeJsonPrivate(PRIVATE_EXPORT_PATH, exportData);
  writeJson(REDACTED_EXPORT_PATH, redactExport(exportData));
  const sellerboard = exportData.sources.filter(isSellerboardSource);
  console.log(
    `exported ${exportData.sources.length} source connections (${sellerboard.length} Sellerboard) to ${PRIVATE_EXPORT_PATH}`,
  );
  console.log(`redacted manifest written to ${REDACTED_EXPORT_PATH}`);
}

async function resetDb() {
  const exportData = loadPrivateExport();
  validateSourceExport(exportData);
  console.log('validated private source export before destructive reset');
  if (SEED_PROFILE === 'staging-fast-clickup') {
    run('docker', ['stop', APP_CONTAINER]);
    try {
      run('docker', [
        'exec',
        PG_CONTAINER,
        'sh',
        '-lc',
        'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "drop schema public cascade; create schema public;"',
      ]);
    } finally {
      run('docker', ['start', APP_CONTAINER]);
    }
    waitForCurrentSchema();
    console.log('reset staging PostgreSQL public schema and restarted the staging app');
    return;
  }
  const result = run('bash', [path.join(SCRIPT_DIR, 'start-live-gate.sh')], {
    env: {
      ...process.env,
      ECOBASE_LIVE_GATE_DESTROY_DATA: '1',
      ECOBASE_LIVE_GATE_CONFIRM_DESTROY: 'destroy-live-sellerboard-data',
    },
    redact: true,
  });
  process.stdout.write(result.stdout.replace(/(Admin password: ).*/g, '$1<redacted>'));
  process.stderr.write(result.stderr.replace(/(Admin password: ).*/g, '$1<redacted>'));
  waitForCurrentSchema();
  const counts = businessCounts();
  const dirty = Object.entries(counts).filter(([, count]) => count > 0);
  if (dirty.length > 0) {
    throw new Error(
      `live-gate reset did not produce a clean business DB: ${dirty
        .map(([name, count]) => `${name}=${count}`)
        .join(', ')}`,
    );
  }
  console.log('live-gate DB reset is clean and schema is current');
}

async function restoreSources() {
  const exportData = loadPrivateExport();
  validateSourceExport(exportData);
  waitForCurrentSchema();
  assertBusinessClean('restore sources');
  const companies = exportData.companies.filter((company) => requiredCompanyNames(exportData).has(company.name));
  const sources = sourcesForRestore(exportData.sources);
  const sql = `
    begin;
    delete from "ecobaseSourceConnections";
    delete from "silverCompanies";

    with payload(data) as (values (${sqlJson(companies)}::jsonb))
    insert into "silverCompanies" (id, name, "companyKey", "createdAt", "updatedAt")
    select (company->>'id')::uuid, company->>'name', company->>'companyKey', now(), now()
    from payload, jsonb_array_elements(data) company;

    with payload(data) as (values (${sqlJson(sources)}::jsonb))
    insert into "ecobaseSourceConnections" (
      id, name, "companyId", "sourceType", domain, config, "secretRef", "freshnessSlaMinutes", active, "createdAt", "updatedAt"
    )
    select
      (source->>'id')::uuid,
      source->>'name',
      nullif(source->>'companyId', '')::uuid,
      source->>'sourceType',
      source->>'domain',
      coalesce(source->'config', '{}'::jsonb),
      nullif(source->>'secretRef', ''),
      coalesce(nullif(source->>'freshnessSlaMinutes', '')::integer, 1440),
      coalesce((source->>'active')::boolean, true),
      now(),
      now()
    from payload, jsonb_array_elements(data) source;
    commit;
  `;
  psqlExec(sql);
  const restored = currentSources();
  const expectedIds = new Set(sources.map((source) => source.id));
  const restoredIds = new Set(restored.map((source) => source.id));
  const missing = [...expectedIds].filter((id) => !restoredIds.has(id));
  const extra = [...restoredIds].filter((id) => !expectedIds.has(id));
  if (missing.length || extra.length) {
    throw new Error(
      `source restore mismatch: missing=${missing.join(',') || 'none'} extra=${extra.join(',') || 'none'}`,
    );
  }
  validateSourceExport({ ...exportData, sources: restored, companies });
  assertBusinessClean('post-restore source check');
  writeJson(
    path.join(ARTIFACT_DIR, 'live-gate-sources.restored.redacted.json'),
    redactExport({ ...exportData, sources: restored, companies }),
  );
  console.log(`restored ${restored.length} live-gate source connections with exported UUIDs`);
  if (!args.has('--keep-schedules-enabled')) {
    console.log('Sellerboard schedules are disabled until import-data completes successfully');
  }
}

function seedPhaseEnabled(phase) {
  const index = SEED_PHASES.indexOf(phase);
  return index >= SEED_PHASES.indexOf(SEED_START_AT) && index <= SEED_PHASES.indexOf(SEED_STOP_AFTER);
}

async function assertDeploymentBoundary() {
  if (SEED_PROFILE !== 'staging-fast-clickup') return;
  const hostname = new URL(BASE_URL).hostname.toLowerCase();
  if (
    DEPLOYMENT_TARGET !== 'staging' ||
    !hostname.includes('staging') ||
    !APP_CONTAINER.includes('ecobase-staging-') ||
    !PG_CONTAINER.includes('ecobase-staging-')
  ) {
    throw new Error(
      `staging-fast-clickup refused target=${DEPLOYMENT_TARGET} host=${hostname} app=${APP_CONTAINER} postgres=${PG_CONTAINER}`,
    );
  }
  assertSeedProfileBundle();
  await validateBundleManifest({
    manifestPath: GREENFIELD_BUNDLE_PATH,
    projectRoot: GREENFIELD_PROJECT_ROOT,
    profile: SEED_PROFILE,
  });
}

function assertSeedProfileBundle() {
  if (SEED_PROFILE !== 'staging-fast-clickup') return;
  if (!GREENFIELD_BUNDLE_PATH) {
    throw new Error('staging-fast-clickup requires ECOBASE_GREENFIELD_BUNDLE_PATH');
  }
  greenfieldBundleManifest ??= JSON.parse(readFileSync(GREENFIELD_BUNDLE_PATH, 'utf8'));
  if (greenfieldBundleManifest.profile !== 'staging-fast-clickup') {
    throw new Error('staging-fast-clickup rejected a bundle with the wrong profile');
  }
  const groups = greenfieldBundleManifest.groups ?? [];
  if (
    groups.length !== STAGING_FAST_GROUPS.size ||
    groups.some((group) => !STAGING_FAST_GROUPS.has(group.id))
  ) {
    throw new Error('staging-fast-clickup rejected unexpected bundle groups');
  }
  for (const group of groups) {
    const expectedPaths = [...(STAGING_FAST_FILES_BY_GROUP.get(group.id) ?? [])].sort();
    const actualPaths = (group.files ?? []).map((file) => String(file.path ?? '')).sort();
    if (JSON.stringify(actualPaths) !== JSON.stringify(expectedPaths)) {
      throw new Error(`staging-fast-clickup rejected unapproved source paths for group ${group.id}`);
    }
  }
}

function assertNoSellerboardHistoryRuns() {
  if (SEED_PROFILE !== 'staging-fast-clickup') return;
  const count = Number(
    psqlScalar(`select count(*) from "ecobaseImportRuns" where "adapterName" = 'sellerboard-history-csv'`),
  );
  if (count !== 0) throw new Error(`staging-fast-clickup found ${count} forbidden Sellerboard history import runs`);
}

function assertHistoryDependentGoldUnknown() {
  if (SEED_PROFILE !== 'staging-fast-clickup') return;
  const falseInventoryHistoryValues = Number(
    psqlScalar(`select count(*) from "goldInventoryPlanningRows" where
      "profitPerUnit" is not null or "sixMonthMargin" is not null or "lastMonthQty" is not null or
      "sixMonthAverageQty" is not null or "sixMonthWorstQty" is not null or "sixMonthBestQty" is not null or
      "recentUnits30" is not null or "tier" is not null or "tierScore" is not null or
      "estimatedProfitRisk" is not null`),
  );
  const falseOrderRiskValues = Number(
    psqlScalar(`select count(*) from "goldOrderPlanningRows" where "riskSource" = 'missing'
      and coalesce("canonicalStatus", '') <> 'COMPLETE' and "moneyAtRisk" is not null`),
  );
  const falseSupplierRiskValues = Number(
    psqlScalar(`select count(*) from "goldSupplierAttentionRows" where "inventoryMoneyAtRisk" is not null
      or "orderMoneyAtRisk" is not null or "moneyAtRisk" is not null`),
  );
  if (falseInventoryHistoryValues + falseOrderRiskValues + falseSupplierRiskValues > 0) {
    throw new Error(
      `staging-fast-clickup produced false historical Gold values: inventory=${falseInventoryHistoryValues} orders=${falseOrderRiskValues} suppliers=${falseSupplierRiskValues}`,
    );
  }
  progressEvent('history_deferred_gold_verified', {
    falseInventoryHistoryValues,
    falseOrderRiskValues,
    falseSupplierRiskValues,
  });
}

function progressEvent(event, values = {}) {
  console.log(JSON.stringify({ event, at: new Date().toISOString(), ...values }));
}

async function importData() {
  if (seedPhaseEnabled('sellerboard')) {
    await runStage(1, 'read-only source preflight', () =>
      SEED_PROFILE === 'staging-fast-clickup' ? requireSavedPreflight() : preflightData(),
    );
  }
  waitForCurrentSchema();
  assertNoSellerboardHistoryRuns();
  if (SEED_START_AT === 'sellerboard') assertBusinessClean('import data');
  const token = await signIn();
  const sources = currentSources();
  validateSourceExport({ exportedAt: new Date().toISOString(), apiBase: BASE_URL, companies: [], sources });
  const sellerboardByCompany = seedPhaseEnabled('sellerboard')
    ? new Map(sources.filter(isSellerboardSource).map((source) => [source.companyName, source]))
    : new Map();
  const supplierSource = seedPhaseEnabled('suppliers')
    ? requiredSource(sources, 'google_sheets', 'supplier_management')
    : undefined;
  const orderSource = seedPhaseEnabled('orders') || seedPhaseEnabled('clickup')
    ? requiredSource(sources, 'google_sheets', 'order_management')
    : undefined;
  const clickupSource = seedPhaseEnabled('clickup')
    ? requiredSource(sources, 'clickup', 'order_management')
    : undefined;

  if (SEED_PROFILE === 'staging-fast-clickup' && seedPhaseEnabled('sellerboard')) {
    await runStage(2, 'Upsert approved non-login ClickUp attribution users', async () => {
      const result = await runImport(token, 'Approved ClickUp attribution users', 'ecobaseImport:ensureClickupAttributionUsers', {});
      if (Number(result.approvedUserCount ?? 0) !== 10) {
        throw new Error(`approved ClickUp attribution user count is ${result.approvedUserCount ?? 0}, expected 10`);
      }
    });
  }

  if (seedPhaseEnabled('sellerboard')) await runStage(SEED_PROFILE === 'staging-fast-clickup' ? 3 : 2, 'Sellerboard API snapshots', async () => {
    for (const company of REQUIRED_SELLERBOARD_COMPANIES) {
      const source = sellerboardByCompany.get(company);
      if (!source) throw new Error(`missing Sellerboard source for ${company}`);
      await runImport(token, `Sellerboard API ${company}`, 'ecobaseImport:run', {
        sourceConnectionId: source.id,
        adapterName: 'sellerboard-api',
        sourceIdentifier: `sellerboard-api-bootstrap-${companyKey(company)}`,
        sourceVersion: BOOTSTRAP_SOURCE_VERSION,
        idempotencyKey: `${source.id}:sellerboard-api-bootstrap:${BOOTSTRAP_SOURCE_VERSION}`,
        skipGoldRefresh: true,
      });
    }
  });

  if (SEED_PROFILE !== 'staging-fast-clickup' && seedPhaseEnabled('sellerboard')) await runStage(3, 'Sellerboard history CSVs', async () => {
    for (const filePath of listHistoryDashboardFiles()) {
      const company = companyFromHistoryFile(path.basename(filePath), 'Dashboard_by_product');
      const source = sellerboardByCompany.get(company);
      if (!source) throw new Error(`history file ${path.basename(filePath)} maps to ${company}, but no source exists`);
      await runImport(
        token,
        `Sellerboard history ${company} ${path.basename(filePath)}`,
        'ecobaseImport:runCsvBundle',
        {
          sourceConnectionId: source.id,
          adapterName: 'sellerboard-history-csv',
          sourceIdentifier: 'sellerboard-history-backfill',
          sourceVersion: BOOTSTRAP_SOURCE_VERSION,
          defaultCompany: company,
          files: [csvFile(filePath)],
          skipGoldRefresh: true,
        },
      );
    }
  });

  if (SEED_PROFILE !== 'staging-fast-clickup' && seedPhaseEnabled('sellerboard')) await runStage(4, 'Sellerboard COGS CSVs', async () => {
    for (const filePath of listCogsFiles()) {
      const company = companyFromHistoryFile(path.basename(filePath), 'Cost_of_Goods_Sold');
      await runImport(
        token,
        `Sellerboard COGS ${company} ${path.basename(filePath)}`,
        'ecobaseImport:importSellerboardCogs',
        {
          defaultCompany: company,
          importedAt: `${BOOTSTRAP_SOURCE_VERSION}T00:00:00.000Z`,
          files: [csvFile(filePath)],
        },
      );
    }
  });

  const [historicalSupplierFile, currentSupplierFile] = seedPhaseEnabled('suppliers') ? supplierFiles() : [];
  if (seedPhaseEnabled('suppliers')) await runStage(5, 'Supplier Management historical tracker', () =>
    runImport(token, `Supplier management ${path.basename(historicalSupplierFile)}`, 'ecobaseImport:runCsvBundle', {
      sourceConnectionId: supplierSource.id,
      adapterName: 'google-sheets-migration-csv',
      sourceIdentifier: `supplier-management-${path.basename(historicalSupplierFile)}`,
      sourceVersion: BOOTSTRAP_SOURCE_VERSION,
      files: [csvFile(historicalSupplierFile)],
      skipGoldRefresh: true,
    }),
  );
  if (seedPhaseEnabled('suppliers')) await runStage(6, 'Supplier Management current 2026 tracker', () =>
    runImport(token, `Supplier management ${path.basename(currentSupplierFile)}`, 'ecobaseImport:runCsvBundle', {
      sourceConnectionId: supplierSource.id,
      adapterName: 'google-sheets-migration-csv',
      sourceIdentifier: `supplier-management-${path.basename(currentSupplierFile)}`,
      sourceVersion: BOOTSTRAP_SOURCE_VERSION,
      files: [csvFile(currentSupplierFile)],
      skipGoldRefresh: true,
    }),
  );

  if (seedPhaseEnabled('orders')) await runStage(7, 'Order Management Purchase Orders then OrderDetails', async () => {
    await runImport(token, 'Order management ordered bundle', 'ecobaseImport:runCsvBundle', {
      sourceConnectionId: orderSource.id,
      adapterName: 'google-sheets-migration-csv',
      sourceIdentifier: 'order-management-bundle',
      sourceVersion: BOOTSTRAP_SOURCE_VERSION,
      files: orderFiles().map(csvFile),
      skipGoldRefresh: true,
    });
  });

  if (seedPhaseEnabled('orders')) await runStage(8, 'Reconcile order lines against imported product data', async () => {
    await runImport(token, 'Order management product reconciliation', 'ecobaseImport:runCsvBundle', {
      sourceConnectionId: orderSource.id,
      adapterName: 'google-sheets-migration-csv',
      sourceIdentifier: 'order-management-product-reconciliation-v3',
      sourceVersion: BOOTSTRAP_SOURCE_VERSION,
      files: orderFiles().map(csvFile),
      skipGoldRefresh: true,
    });
    await verifyOrderDetailsRelationships(token, 'after-product-reconciliation', { strict: false });
  });

  if (seedPhaseEnabled('clickup')) await runStage(9, 'Reconcile ClickUp status/comments', async () => {
    const run = await runImport(token, 'ClickUp order status', 'ecobaseImport:importClickupOrderStatuses', {
      sourceConnectionId: clickupSource.id,
      sourceIdentifier: 'clickup-order-status-bootstrap',
      importedAt: `${BOOTSTRAP_SOURCE_VERSION}T00:00:00.000Z`,
      snapshotDate: BOOTSTRAP_SOURCE_VERSION,
      dryRun: false,
      skipGoldRefresh: true,
      files: clickupFiles().map(csvFile),
    });
    const clickup = run?.summary?.clickup ?? {};
    progressEvent('clickup_actor_mapping', {
      mappedActorCount: Number(clickup.linkedActorCount ?? 0),
      unresolvedActorCount: (clickup.unresolvedActors ?? []).length,
      actorMappings: clickup.actorMappings ?? [],
    });
    if (
      Number(clickup.matchedOrderCount ?? 0) === 0 ||
      Number(clickup.importedCommentCount ?? 0) + Number(clickup.duplicateCommentCount ?? 0) === 0
    ) {
      throw new Error('ClickUp reconciliation matched no orders or retained no comments after the ordered order bundle');
    }
    const unlinkedMappedCommentCount = Number(
      psqlScalar(
        `select count(*) from "silverActivityComments" where "contextSnapshotJson"->>'source' = 'clickup_csv' and "contextSnapshotJson"->>'actorResolution' = 'mapped' and "actorUserId" is null`,
      ),
    );
    if (unlinkedMappedCommentCount > 0) {
      throw new Error(`ClickUp reconciliation left ${unlinkedMappedCommentCount} mapped comments without NocoBase users`);
    }
    const clickupTaskCount = Number(
      psqlScalar(`select count(*) from "silverTasks" where "workspaceName" = 'ClickUp export'`),
    );
    if (clickupTaskCount > 0) {
      throw new Error(`ClickUp reconciliation created ${clickupTaskCount} forbidden task records`);
    }
  });

  if (seedPhaseEnabled('gold')) {
    await runStage(10, 'validate Phase A Silver blockers', () => validateSilverPhase());
  }

  if (seedPhaseEnabled('gold') && !SEED_SKIP_GOLD) await runStage(11, 'Phase B final gold read-model refresh', () =>
    runImport(token, 'Gold read models', 'ecobaseImport:refreshGoldReadModels', {
      calculationDate: BOOTSTRAP_SOURCE_VERSION,
    }),
  );
  if (seedPhaseEnabled('gold') && !SEED_SKIP_GOLD) {
    await runStage(12, 'strict semantic verification', async () => {
      assertHistoryDependentGoldUnknown();
      return verifyLinks();
    });
  }
  if (seedPhaseEnabled('gold') && SEED_SKIP_GOLD) {
    progressEvent('gold_refresh_skipped', { startAt: SEED_START_AT, stopAfter: SEED_STOP_AFTER });
  }

  assertNoSellerboardHistoryRuns();
  progressEvent('import_bootstrap_completed', {
    startAt: SEED_START_AT,
    stopAfter: SEED_STOP_AFTER,
    skipGold: SEED_SKIP_GOLD,
    metrics: importMetrics,
  });
  console.log('import bootstrap completed; Sellerboard schedules remain disabled until enable-schedules is run');
}

async function importSupplierCsvs() {
  waitForCurrentSchema();
  const token = await signIn();
  const supplierSource = requiredSource(currentSources(), 'google_sheets', 'supplier_management');
  for (const filePath of supplierFiles()) {
    await runImport(token, `Supplier management ${path.basename(filePath)}`, 'ecobaseImport:runCsvBundle', {
      sourceConnectionId: supplierSource.id,
      adapterName: 'google-sheets-migration-csv',
      sourceIdentifier: `supplier-management-${path.basename(filePath)}`,
      sourceVersion: BOOTSTRAP_SOURCE_VERSION,
      files: [csvFile(filePath)],
    });
  }
  console.log('supplier CSV import completed');
}

function validateSilverPhase() {
  const checks = [
    check(
      'phase_a_failed_import_runs',
      `select count(*) from "ecobaseImportRuns" where status not in ('success', 'skipped', 'stale')`,
      0,
    ),
    check(
      'phase_a_failed_or_pending_bronze',
      `select count(*) from "bronzeSourceRecords" where "normalizationStatus" in ('failed', 'pending')`,
      0,
    ),
    check(
      'phase_a_duplicate_company_product_identity',
      `select count(*) from (select "companyId", "amazonAccountId", "productId" from "silverCompanyProducts" group by "companyId", "amazonAccountId", "productId" having count(*) > 1) x`,
      0,
    ),
    check(
      'phase_a_unknown_companies',
      `select count(*) from "silverCompanies" where name not in ('Ecofission LLC','Muxtex INC','Retail Heaven Inc','Stop Shop LLC')`,
      0,
    ),
    check(
      'phase_a_sellerboard_current_snapshot_missing',
      `select count(*) from "ecobaseSourceConnections" sc where sc."sourceType"='sellerboard' and sc.domain='amazon_operations' and not exists (select 1 from "silverInventorySnapshots" i where i."sourceConnectionId"=sc.id)`,
      0,
    ),
    check(
      'phase_a_sellerboard_current_snapshot_stale',
      `select count(*) from (select sc.id, max(i."snapshotDate")::date as snapshot_date from "ecobaseSourceConnections" sc join "silverInventorySnapshots" i on i."sourceConnectionId"=sc.id where sc."sourceType"='sellerboard' and sc.domain='amazon_operations' group by sc.id) x where x.snapshot_date < ${sqlString(BOOTSTRAP_SOURCE_VERSION)}::date - interval '2 days' or x.snapshot_date > ${sqlString(BOOTSTRAP_SOURCE_VERSION)}::date`,
      0,
    ),
    check(
      'phase_a_sellerboard_history_incomplete',
      `select count(*) from "ecobaseSourceConnections" sc left join (select cp."companyId", min(f."snapshotDate")::date as first_date, max(f."snapshotDate")::date as last_date from "silverListingDailyFacts" f join "silverCompanyProducts" cp on cp.id=f."companyProductId" group by cp."companyId") h on h."companyId"=sc."companyId" where sc."sourceType"='sellerboard' and sc.domain='amazon_operations' and (h.first_date is null or h.first_date > date_trunc('month', ${sqlString(BOOTSTRAP_SOURCE_VERSION)}::date) - interval '6 months' or h.last_date < ${sqlString(BOOTSTRAP_SOURCE_VERSION)}::date - interval '2 days')`,
      0,
    ),
    check(
      'phase_a_sellerboard_snapshot_skew',
      `select case when max(snapshot_date)-min(snapshot_date) > 1 then 1 else 0 end from (select max(i."snapshotDate")::date as snapshot_date from "ecobaseSourceConnections" sc join "silverInventorySnapshots" i on i."sourceConnectionId"=sc.id where sc."sourceType"='sellerboard' and sc.domain='amazon_operations' group by sc.id) x`,
      0,
    ),
    check(
      'phase_a_orphan_orders',
      `select count(*) from "silverOrders" o left join "silverCompanies" c on c.id = o."companyId" where c.id is null`,
      0,
    ),
    check(
      'phase_a_orphan_order_lines',
      `select count(*) from "silverOrderLines" l left join "silverOrders" o on o.id = l."orderId" where o.id is null`,
      0,
    ),
    check(
      'phase_a_products_without_approved_sellerboard_authority',
      `select count(*) from "silverProducts" p where not exists (select 1 from "silverNormalizationLinks" l join "ecobaseImportRuns" r on r.id=l."importRunId" where l."silverEntityType"='silverProduct' and l."silverEntityId"=p.id and r."adapterName" in ('sellerboard-api','sellerboard-history-csv'))`,
      0,
    ),
    check(
      'phase_a_company_products_without_approved_sellerboard_authority',
      `select count(*) from "silverCompanyProducts" cp where not exists (select 1 from "silverNormalizationLinks" l join "ecobaseImportRuns" r on r.id=l."importRunId" where l."silverEntityType"='silverCompanyProduct' and l."silverEntityId"=cp.id and r."adapterName" in ('sellerboard-api','sellerboard-history-csv'))`,
      0,
    ),
    check('phase_a_gold_inventory_rows_before_rebuild', `select count(*) from "goldInventoryPlanningRows"`, 0),
    check('phase_a_gold_order_rows_before_rebuild', `select count(*) from "goldOrderPlanningRows"`, 0),
    check('phase_a_gold_supplier_rows_before_rebuild', `select count(*) from "goldSupplierAttentionRows"`, 0),
    check('phase_a_gold_kpi_rows_before_rebuild', `select count(*) from "goldManagementKpiDailyFacts"`, 0),
  ];
  const unresolvedOrderLines = Number(
    psqlScalar(`select count(*) from "silverOrderLines" where "productMappingStatus"='unresolved'`),
  );
  const result = {
    sourceVersion: BOOTSTRAP_SOURCE_VERSION,
    checks,
    unresolvedOrderLines,
    status: checks.every((item) => item.actual === item.expected) ? 'pass' : 'fail',
  };
  ensureArtifactDir();
  writeJson(path.join(ARTIFACT_DIR, 'phase-a-silver-validation.json'), result);
  console.log(`Phase A Silver validation: status=${result.status} unresolvedOrderLines=${unresolvedOrderLines}`);
  const failed = checks.filter((item) => item.actual !== item.expected);
  if (failed.length) {
    throw new Error(`Phase A Silver validation failed: ${failed.map((item) => `${item.name}=${item.actual}`).join(', ')}`);
  }
  return result;
}

async function verifyLinks() {
  waitForCurrentSchema();
  const token = await signIn();
  const orderDetailsVerification = await verifyOrderDetailsRelationships(token, 'final', { strict: false });
  const semanticVerification = await verifySemanticLinks(token);
  const counts = businessCounts();
  const checks = [
    check('source_connection_count', `select count(*) from "ecobaseSourceConnections"`, 8),
    check(
      'sellerboard_source_count',
      `select count(*) from "ecobaseSourceConnections" where "sourceType"='sellerboard' and domain='amazon_operations'`,
      4,
    ),
    check(
      'failed_import_runs',
      `select count(*) from "ecobaseImportRuns" where status not in ('success', 'skipped', 'stale')`,
      0,
    ),
    check(
      'pending_bronze_records',
      `select count(*) from "bronzeSourceRecords" where "normalizationStatus"='pending'`,
      0,
    ),
    check(
      'orphan_import_run_source',
      `select count(*) from "ecobaseImportRuns" r left join "ecobaseSourceConnections" s on s.id = r."sourceConnectionId" where s.id is null`,
      0,
    ),
    check(
      'orphan_bronze_source',
      `select count(*) from "bronzeSourceRecords" b left join "ecobaseSourceConnections" s on s.id = b."sourceConnectionId" where s.id is null`,
      0,
    ),
    check(
      'orphan_bronze_import_run',
      `select count(*) from "bronzeSourceRecords" b left join "ecobaseImportRuns" r on r.id = b."importRunId" where b."importRunId" is not null and r.id is null`,
      0,
    ),
    check(
      'duplicate_company_keys',
      `select count(*) from (select "companyKey" from "silverCompanies" group by "companyKey" having count(*) > 1) x`,
      0,
    ),
    check(
      'duplicate_supplier_external_refs',
      `select count(*) from (select "sourceSystem", "normalizedExternalSupplierCode" from "silverSupplierExternalRefs" group by "sourceSystem", "normalizedExternalSupplierCode" having count(*) > 1) x`,
      0,
    ),
    check(
      'orphan_supplier_external_ref_supplier',
      `select count(*) from "silverSupplierExternalRefs" r left join "silverSuppliers" s on s.id = r."supplierId" where s.id is null`,
      0,
    ),
    check(
      'orphan_supplier_external_ref_source',
      `select count(*) from "silverSupplierExternalRefs" r left join "ecobaseSourceConnections" s on s.id = r."sourceConnectionId" where r."sourceConnectionId" is not null and s.id is null`,
      0,
    ),
    check(
      'orphan_company_product_company',
      `select count(*) from "silverCompanyProducts" cp left join "silverCompanies" c on c.id = cp."companyId" where c.id is null`,
      0,
    ),
    check(
      'orphan_company_product_product',
      `select count(*) from "silverCompanyProducts" cp left join "silverProducts" p on p.id = cp."productId" where p.id is null`,
      0,
    ),
    check(
      'orphan_supplier_product_supplier',
      `select count(*) from "silverSupplierProducts" sp left join "silverSuppliers" s on s.id = sp."supplierId" where s.id is null`,
      0,
    ),
    check(
      'orphan_supplier_product_product',
      `select count(*) from "silverSupplierProducts" sp left join "silverProducts" p on p.id = sp."productId" where p.id is null`,
      0,
    ),
    check(
      'orphan_company_product_supplier_company_product',
      `select count(*) from "silverCompanyProductSuppliers" cps left join "silverCompanyProducts" cp on cp.id = cps."companyProductId" where cp.id is null`,
      0,
    ),
    check(
      'orphan_company_product_supplier_supplier_product',
      `select count(*) from "silverCompanyProductSuppliers" cps left join "silverSupplierProducts" sp on sp.id = cps."supplierProductId" where sp.id is null`,
      0,
    ),
    check(
      'orphan_order_company',
      `select count(*) from "silverOrders" o left join "silverCompanies" c on c.id = o."companyId" where c.id is null`,
      0,
    ),
    check(
      'orphan_order_supplier',
      `select count(*) from "silverOrders" o left join "silverSuppliers" s on s.id = o."supplierId" where o."supplierId" is not null and s.id is null`,
      0,
    ),
    check(
      'orphan_order_line_order',
      `select count(*) from "silverOrderLines" l left join "silverOrders" o on o.id = l."orderId" where o.id is null`,
      0,
    ),
    check(
      'orphan_order_line_company_product',
      `select count(*) from "silverOrderLines" l left join "silverCompanyProducts" cp on cp.id = l."companyProductId" where l."companyProductId" is not null and cp.id is null`,
      0,
    ),
    check(
      'orphan_order_line_supplier_product',
      `select count(*) from "silverOrderLines" l left join "silverSupplierProducts" sp on sp.id = l."supplierProductId" where l."supplierProductId" is not null and sp.id is null`,
      0,
    ),
    check(
      'orphan_inventory_snapshot_company_product',
      `select count(*) from "silverInventorySnapshots" i left join "silverCompanyProducts" cp on cp.id = i."companyProductId" where cp.id is null`,
      0,
    ),
    check(
      'orphan_listing_daily_fact_company_product',
      `select count(*) from "silverListingDailyFacts" f left join "silverCompanyProducts" cp on cp.id = f."companyProductId" where cp.id is null`,
      0,
    ),
    check(
      'orphan_gold_inventory_company_product',
      `select count(*) from "goldInventoryPlanningRows" g left join "silverCompanyProducts" cp on cp.id = g."companyProductId" where g."companyProductId" is not null and cp.id is null`,
      0,
    ),
    check(
      'fake_supplier_sku_equals_asin',
      `select count(*) from "silverSupplierProducts" sp join "silverProducts" p on p.id = sp."productId" where sp."supplierSku" is not null and upper(sp."supplierSku") = upper(p.asin)`,
      0,
      false,
    ),
    check(
      'missing_lead_time_supplier_products',
      `select count(*) from "silverSupplierProducts" where "leadTimeDays" is null`,
      0,
      false,
    ),
    check(
      'lead_time_unparsed_warnings',
      `select count(*) from "bronzeSourceRecords" where "issueCode"='lead_time_unparsed'`,
      0,
    ),
    check(
      'gold_supplier_rows_missing_lead_time',
      `select count(*) from "goldInventoryPlanningRows" where "supplierId" is not null and "leadTimeDays" is null`,
      0,
    ),
    check(
      'gold_unknown_supplier_order_status',
      `select count(*) from "goldInventoryPlanningRows" where "supplierOrderStatus" is not null and "supplierOrderStatus" not in ('draft','supplier_contacted','supplier_confirmed','approval_pending','payment_pending','paid','supplier_preparing','shipped_inbound','reached_fba','completed','blocked','rejected','cancelled')`,
      0,
    ),
    check(
      'gold_open_order_qty_closed_history',
      `select count(*) from "goldInventoryPlanningRows" where coalesce("supplierOrderOpenQty", 0) > 0 and "supplierOrderState"='closed_history'`,
      0,
    ),
    check(
      'rejected_supplier_refs_absent',
      `select count(*) from "silverSupplierExternalRefs" where "normalizedExternalSupplierCode" in ('SRO-1293','SRO-1257')`,
      0,
    ),
    check(
      'accepted_supplier_refs_present',
      `select count(*) from (values ('SRO-12939','Delko Tools'),('SRO-12572','Franklin Machine Products')) expected(code, name) where not exists (select 1 from "silverSupplierExternalRefs" r join "silverSuppliers" s on s.id=r."supplierId" where r."normalizedExternalSupplierCode"=expected.code and s."displayName"=expected.name)`,
      0,
    ),
    check(
      'etc_listing_alias_not_duplicated',
      `select count(*) from "silverProducts" where asin='B0177E9JPS' and sku='ETC120A'`,
      0,
    ),
    check(
      'etc_listing_and_supplier_alias_present',
      `select case when exists (select 1 from "silverProducts" p where p.asin='B0177E9JPS' and p.sku='ETC-120A') and exists (select 1 from "silverSupplierProducts" sp join "silverProducts" p on p.id=sp."productId" where p.asin='B0177E9JPS' and p.sku='ETC-120A' and sp."supplierSku"='ETC120A') then 0 else 1 end`,
      0,
    ),
    check(
      'gold_active_order_rows_present',
      `select case when count(*) > 0 then 0 else 1 end from "goldInventoryPlanningRows" where "supplierOrderState" in ('purchased_pipeline','placed_not_purchased')`,
      0,
    ),
  ];
  const actionStatus = psqlJson(
    `select coalesce(jsonb_object_agg("actionStatus", count), '{}'::jsonb) from (select "actionStatus", count(*)::int as count from "goldInventoryPlanningRows" group by "actionStatus" order by "actionStatus") x`,
  );
  const importRuns = psqlJson(
    `select coalesce(jsonb_agg(jsonb_build_object('adapterName', "adapterName", 'sourceIdentifier', "sourceIdentifier", 'status', status, 'rowCount', "rowCount", 'normalizedCount', "normalizedCount", 'warningCount', "warningCount", 'errorCount', "errorCount", 'errorMessage', "errorMessage") order by "startedAt"), '[]'::jsonb) from "ecobaseImportRuns"`,
  );
  const bronzeIssues = psqlJson(
    `select coalesce(jsonb_agg(jsonb_build_object('sourceType', "sourceType", 'sourceDataset', "sourceDataset", 'normalizationStatus', "normalizationStatus", 'issueSeverity', coalesce("issueSeverity", ''), 'issueCode', coalesce("issueCode", ''), 'count', count) order by count desc), '[]'::jsonb) from (select "sourceType", "sourceDataset", "normalizationStatus", coalesce("issueSeverity", '') as "issueSeverity", coalesce("issueCode", '') as "issueCode", count(*)::int as count from "bronzeSourceRecords" where "normalizationStatus" <> 'normalized' or "issueCode" is not null group by 1,2,3,4,5) x`,
  );
  const fingerprint = writeBusinessFingerprint();
  const report = {
    generatedAt: new Date().toISOString(),
    counts,
    fingerprint,
    checks,
    actionStatus,
    importRuns,
    bronzeIssues,
    orderDetailsVerification: {
      ok: orderDetailsVerification.ok,
      totals: orderDetailsVerification.totals,
      invalidReasons: orderDetailsVerification.invalidReasons,
      jsonArtifact: 'order-details-relationship-verification-final.json',
      csvArtifact: 'order-details-relationship-discrepancies-final.csv',
    },
    semanticVerification,
  };
  ensureArtifactDir();
  const reportPath = path.join(ARTIFACT_DIR, 'live-gate-link-verification.json');
  writeJson(reportPath, report);
  console.log(JSON.stringify({ counts, checks, actionStatus, bronzeIssues }, null, 2));
  console.log(`verification report written to ${reportPath}`);
  const failed = checks.filter((item) => item.critical && item.actual !== item.expected);
  if (failed.length > 0) {
    throw new Error(`critical link checks failed: ${failed.map((item) => `${item.name}=${item.actual}`).join(', ')}`);
  }
}

function check(name, sql, expected, critical = true) {
  return { name, expected, actual: Number(psqlScalar(sql)), critical };
}

function writeBusinessFingerprint() {
  waitForCurrentSchema();
  const payload = {
    sourceVersion: BOOTSTRAP_SOURCE_VERSION,
    counts: businessCounts(),
    companies: psqlJson(
      `select coalesce(jsonb_agg(jsonb_build_object('companyKey', "companyKey", 'name', name) order by "companyKey"), '[]'::jsonb) from "silverCompanies"`,
    ),
    products: psqlJson(
      `select coalesce(jsonb_agg(jsonb_build_object('asin', asin, 'sku', sku, 'title', title) order by asin, sku), '[]'::jsonb) from "silverProducts"`,
    ),
    companyProducts: psqlJson(
      `select coalesce(jsonb_agg(jsonb_build_object('company', c.name, 'account', a.name, 'marketplace', a.marketplace, 'asin', p.asin, 'sku', p.sku, 'lifecycleStatus', cp."lifecycleStatus", 'listingStatus', cp."listingStatus") order by c.name, a.name, p.asin, p.sku), '[]'::jsonb) from "silverCompanyProducts" cp join "silverCompanies" c on c.id=cp."companyId" join "silverAmazonAccounts" a on a.id=cp."amazonAccountId" join "silverProducts" p on p.id=cp."productId"`,
    ),
    supplierRefs: psqlJson(
      `select coalesce(jsonb_agg(jsonb_build_object('sourceSystem', r."sourceSystem", 'externalSupplierCode', r."normalizedExternalSupplierCode", 'supplierName', s."displayName") order by r."sourceSystem", r."normalizedExternalSupplierCode"), '[]'::jsonb) from "silverSupplierExternalRefs" r join "silverSuppliers" s on s.id=r."supplierId"`,
    ),
    supplierProducts: psqlJson(
      `select coalesce(jsonb_agg(jsonb_build_object('supplier', s."displayName", 'asin', p.asin, 'sku', p.sku, 'supplierSku', sp."supplierSku", 'unitCost', sp."unitCost", 'moq', sp.moq, 'leadTimeDays', sp."leadTimeDays", 'analysisStatus', sp."analysisStatus") order by s."displayName", p.asin, p.sku), '[]'::jsonb) from "silverSupplierProducts" sp join "silverSuppliers" s on s.id=sp."supplierId" join "silverProducts" p on p.id=sp."productId"`,
    ),
    orders: psqlJson(
      `select coalesce(jsonb_agg(jsonb_build_object('company', c.name, 'orderRef', o."orderRef", 'supplier', s."displayName", 'canonicalStatus', o."canonicalStatus", 'lifecycleStatus', o."lifecycleStatus", 'statusSource', o."statusSource") order by c.name, o."orderRef"), '[]'::jsonb) from "silverOrders" o join "silverCompanies" c on c.id=o."companyId" left join "silverSuppliers" s on s.id=o."supplierId"`,
    ),
    orderLines: psqlJson(
      `select coalesce(jsonb_agg(jsonb_build_object('orderRef', o."orderRef", 'sourceLineKey', l."sourceLineKey", 'sourceAsin', l."sourceAsin", 'sourceSupplierSku', l."sourceSupplierSku", 'productMappingStatus', l."productMappingStatus", 'orderedQty', l."orderedQty", 'confirmedQty', l."confirmedQty") order by o."orderRef", l."sourceLineKey"), '[]'::jsonb) from "silverOrderLines" l join "silverOrders" o on o.id=l."orderId"`,
    ),
    inventoryGold: psqlJson(
      `select coalesce(jsonb_agg(jsonb_build_object('company', company, 'asin', asin, 'sku', sku, 'actionStatus', "actionStatus", 'tier', tier, 'currentPlanningStock', "currentPlanningStock", 'suggestedReorderQty', "suggestedReorderQty", 'supplierOrderRef', "supplierOrderRef", 'supplierOrderStatus', "supplierOrderStatus") order by company, asin, sku), '[]'::jsonb) from "goldInventoryPlanningRows"`,
    ),
    orderGold: psqlJson(
      `select coalesce(jsonb_agg(jsonb_build_object('company', "companyName", 'orderRef', "orderRef", 'supplier', "supplierName", 'canonicalStatus', "canonicalStatus", 'operationalStatus', "operationalStatus", 'lineCount', "lineCount", 'moneyAtRisk', "moneyAtRisk") order by "companyName", "orderRef"), '[]'::jsonb) from "goldOrderPlanningRows"`,
    ),
    supplierGold: psqlJson(
      `select coalesce(jsonb_agg(jsonb_build_object('company', "companyName", 'supplier', "supplierName", 'priority', priority, 'lifecycleStatus', "lifecycleStatus", 'followUpState', "followUpState", 'moneyAtRisk', "moneyAtRisk", 'recommendedAction', "recommendedAction") order by "companyName", "supplierName", "naturalKey"), '[]'::jsonb) from "goldSupplierAttentionRows"`,
    ),
    managementKpis: psqlJson(
      `select coalesce(jsonb_agg(jsonb_build_object('metricDate', "metricDate", 'companyScope', "companyScope", 'metricKey', "metricKey", 'value', value, 'sourceRowCount', "sourceRowCount", 'metricVersion', "metricVersion") order by "metricDate", "companyScope", "metricKey"), '[]'::jsonb) from "goldManagementKpiDailyFacts"`,
    ),
  };
  const fingerprint = businessFingerprint(payload);
  const report = { generatedAt: new Date().toISOString(), ...fingerprint };
  const reportPath = path.join(ARTIFACT_DIR, 'business-fingerprint.json');
  writeJson(reportPath, report);
  console.log(JSON.stringify({ fingerprint: fingerprint.value, reportPath }));
  return { algorithm: fingerprint.algorithm, value: fingerprint.value, artifact: path.basename(reportPath) };
}

async function deactivateMigrationSources() {
  waitForCurrentSchema();
  const token = await signIn();
  const result = unwrapActionData(await apiPost(token, 'ecobaseImport:deactivateMigrationSources', {}));
  console.log(JSON.stringify({ operation: 'deactivate-migration-sources', result }));
}

async function purgeExpiredBronze() {
  const before = process.env.ECOBASE_BRONZE_PURGE_BEFORE;
  if (!before || Number.isNaN(new Date(before).getTime())) {
    throw new Error('ECOBASE_BRONZE_PURGE_BEFORE must be a valid ISO instant');
  }
  waitForCurrentSchema();
  const token = await signIn();
  const result = unwrapActionData(
    await apiPost(token, 'ecobaseImport:purgeExpiredBronze', { before: new Date(before).toISOString() }),
  );
  console.log(JSON.stringify({ operation: 'purge-expired-bronze', result }));
}

async function verifySemanticLinks(token) {
  const result = unwrapActionData(await apiPost(token, 'ecobaseImport:verifySemanticLinks', {}));
  ensureArtifactDir();
  writeJson(path.join(ARTIFACT_DIR, 'semantic-link-verification.json'), result);
  console.log(`semantic link verification: errors=${result.errorCount} warnings=${result.warningCount}`);
  if (!result.ok) {
    throw new Error(
      `semantic link verification failed: ${result.issues
        .filter((issue) => issue.severity === 'error')
        .map((issue) => issue.code)
        .join(', ')}`,
    );
  }
  return result;
}

async function verifyOrderDetailsRelationships(token, suffix, { strict = true } = {}) {
  const orderDetailsPath = orderFiles()[1];
  const result = unwrapActionData(
    await apiPost(token, 'ecobaseImport:verifyOrderDetailsRelationships', {
      files: [csvFile(orderDetailsPath)],
    }),
  );
  ensureArtifactDir();
  writeJson(path.join(ARTIFACT_DIR, `order-details-relationship-verification-${suffix}.json`), result);
  const discrepancyRows = result.discrepancies ?? [];
  const csvRows = [
    ['sourceRow', 'classification', 'reason', 'expectedIdentity', 'actualIds'].join(','),
    ...discrepancyRows.map((item) =>
      [item.sourceRow, item.classification, item.reason, item.expectedIdentity, item.actualIds]
        .map(csvArtifactCell)
        .join(','),
    ),
  ];
  writeFileSync(
    path.join(ARTIFACT_DIR, `order-details-relationship-discrepancies-${suffix}.csv`),
    `${csvRows.join('\n')}\n`,
    { mode: 0o600 },
  );
  console.log(
    `OrderDetails verification ${suffix}: accepted=${result.totals.acceptedRows} verified=${result.totals.verifiedRows} relationshipGaps=${result.totals.relationshipGaps} inventoryHistoryGaps=${result.totals.inventoryHistoryGaps}`,
  );
  if (!result.ok && strict) {
    throw new Error(
      `OrderDetails verification failed: relationshipGaps=${result.totals.relationshipGaps} inventoryHistoryGaps=${result.totals.inventoryHistoryGaps}`,
    );
  }
  return result;
}

function csvArtifactCell(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  return `"${text.replace(/"/g, '""')}"`;
}

async function runStage(number, label, operation) {
  const startedAt = new Date();
  const metricsBefore = { ...importMetrics };
  const budgetMs = STAGE_BUDGET_MS.get(number);
  progressEvent('seed_stage_started', { number, label, budgetMs: budgetMs ?? null });
  console.log(`stage ${number} start: ${label}`);
  const heartbeat = setInterval(
    () =>
      progressEvent('seed_stage_heartbeat', {
        number,
        label,
        elapsedMs: Date.now() - startedAt.getTime(),
        inputRows: importMetrics.inputRows - metricsBefore.inputRows,
        acceptedRows: importMetrics.acceptedRows - metricsBefore.acceptedRows,
        discardedRows: importMetrics.discardedRows - metricsBefore.discardedRows,
      }),
    SEED_HEARTBEAT_MS,
  );
  heartbeat.unref();
  try {
    const result = await operation();
    const durationMs = Date.now() - startedAt.getTime();
    if (budgetMs !== undefined && durationMs > budgetMs) {
      throw new Error(`Stage ${number} exceeded its ${budgetMs}ms budget: ${durationMs}ms (${label}).`);
    }
    const stage = recordImportStage(number, label, startedAt, metricsBefore, 'success');
    progressEvent('seed_stage_completed', stage);
    console.log(`stage ${number} end: ${label} durationMs=${durationMs} budgetMs=${budgetMs ?? 'none'}`);
    return result;
  } catch (error) {
    const stage = recordImportStage(number, label, startedAt, metricsBefore, 'failed', error);
    progressEvent('seed_stage_failed', stage);
    console.error(`stage ${number} failed: ${label} durationMs=${Date.now() - startedAt.getTime()}`);
    throw error;
  } finally {
    clearInterval(heartbeat);
  }
}

function recordImportStage(number, label, startedAt, metricsBefore, status, error) {
  const finishedAt = new Date();
  const stage = {
    number,
    label,
    status,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    inputRows: importMetrics.inputRows - metricsBefore.inputRows,
    acceptedRows: importMetrics.acceptedRows - metricsBefore.acceptedRows,
    discardedRows: importMetrics.discardedRows - metricsBefore.discardedRows,
    ...(error ? { error: error instanceof Error ? error.message : String(error) } : {}),
  };
  importStageLog.push(stage);
  ensureArtifactDir();
  writeJson(IMPORT_STAGE_LOG_PATH, { sourceVersion: BOOTSTRAP_SOURCE_VERSION, stages: importStageLog });
  return stage;
}

async function runImport(token, label, action, body) {
  console.log(`import: ${label}`);
  const response = await apiPost(token, action, body);
  const run = await settleRun(unwrapActionData(response));
  printRun(label, run);
  const migration = run?.summary?.migration ?? {};
  importMetrics.inputRows += Number(run?.rowCount ?? 0);
  importMetrics.acceptedRows += Number(migration.acceptedCount ?? run?.normalizedCount ?? run?.rowCount ?? 0);
  importMetrics.discardedRows += Number(migration.discardedCount ?? 0);
  if (run.status && !['success', 'skipped', 'stale'].includes(run.status)) {
    throw new Error(`import failed for ${label}: ${run.status}${run.errorMessage ? ` - ${run.errorMessage}` : ''}`);
  }
  const errorCount = Number(run.errorCount ?? 0);
  if (errorCount > 0) {
    throw new Error(
      `import failed for ${label}: errorCount=${errorCount}${run.errorMessage ? ` - ${run.errorMessage}` : ''}`,
    );
  }
  return run;
}

function unwrapActionData(value) {
  let current = value;
  while (
    current &&
    typeof current === 'object' &&
    Object.keys(current).length === 1 &&
    Object.prototype.hasOwnProperty.call(current, 'data')
  ) {
    current = current.data;
  }
  return current;
}

async function settleRun(data) {
  if (!data || typeof data !== 'object') return data;
  if (data.id && data.status === 'pending') {
    const deadline = Date.now() + Number(process.env.ECOBASE_BOOTSTRAP_IMPORT_TIMEOUT_MS ?? 20 * 60 * 1000);
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5000));
      const run = importRunById(data.id);
      if (run && run.status !== 'pending') return run;
    }
    throw new Error(`import run ${data.id} did not finish before timeout`);
  }
  return data;
}

function printRun(label, run) {
  if (!run || typeof run !== 'object') {
    console.log(`  ${label}: ${String(run)}`);
    return;
  }
  const fields = [
    'id',
    'status',
    'rowCount',
    'normalizedCount',
    'warningCount',
    'errorCount',
    'importedCount',
    'skippedCount',
    'updatedOrderCount',
  ];
  const summary = fields
    .filter((field) => run[field] !== undefined)
    .map((field) => `${field}=${run[field]}`)
    .join(' ');
  console.log(`  ${summary || 'completed'}`);
  if (run.errorMessage) console.log(`  errorMessage=${run.errorMessage}`);
}

async function apiPost(token, action, body) {
  const response = await fetch(`${BASE_URL}/${action}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body ?? {}),
  });
  const text = await response.text();
  let parsed;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = { raw: text };
  }
  if (!response.ok) {
    throw new Error(
      `API ${action} failed with HTTP ${response.status}: ${redactText(JSON.stringify(parsed)).slice(0, 800)}`,
    );
  }
  return parsed;
}

async function signIn() {
  const timeoutMs = Number(process.env.ECOBASE_BOOTSTRAP_API_TIMEOUT_MS ?? 5 * 60 * 1000);
  const deadline = Date.now() + timeoutMs;
  let lastError = 'unknown sign-in error';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${BASE_URL}/auth:signIn`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
      });
      const text = await response.text();
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        lastError = `live-gate sign-in returned non-JSON HTTP ${response.status}`;
        sleep(5000);
        continue;
      }
      if (response.ok && parsed?.data?.token) return parsed.data.token;
      lastError = `live-gate sign-in failed with HTTP ${response.status}: ${redactText(text).slice(0, 500)}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    sleep(5000);
  }
  throw new Error(lastError);
}

function currentSources() {
  return psqlJson(`
    select coalesce(jsonb_agg(jsonb_build_object(
      'id', sc.id,
      'name', sc.name,
      'companyId', sc."companyId",
      'companyName', c.name,
      'companyKey', c."companyKey",
      'sourceType', sc."sourceType",
      'domain', sc.domain,
      'config', coalesce(sc.config, '{}'::jsonb),
      'secretRef', sc."secretRef",
      'freshnessSlaMinutes', sc."freshnessSlaMinutes",
      'active', sc.active
    ) order by sc."sourceType", sc.domain, c.name nulls first, sc.name), '[]'::jsonb)
    from "ecobaseSourceConnections" sc
    left join "silverCompanies" c on c.id = sc."companyId"
  `);
}

function importRunById(id) {
  const rows = psqlJson(`
    select coalesce(jsonb_agg(jsonb_build_object(
      'id', id,
      'status', status,
      'rowCount', "rowCount",
      'normalizedCount', "normalizedCount",
      'warningCount', "warningCount",
      'errorCount', "errorCount",
      'errorMessage', "errorMessage"
    )), '[]'::jsonb)
    from "ecobaseImportRuns"
    where id = ${sqlString(id)}
  `);
  return rows[0];
}

function businessCounts() {
  const selects = BUSINESS_TABLES.map(
    (table) => `select '${table}' as name, count(*)::int as count from "${table}"`,
  ).join('\nunion all\n');
  const rows = psqlJson(`select jsonb_object_agg(name, count order by name) from (${selects}) counts`);
  return rows ?? {};
}

function assertBusinessClean(phase) {
  if (args.has('--allow-non-clean')) return;
  const counts = businessCounts();
  const dirty = Object.entries(counts).filter(([, count]) => Number(count) > 0);
  if (dirty.length > 0) {
    throw new Error(
      `refusing to ${phase} because live-gate is not clean: ${dirty
        .map(([name, count]) => `${name}=${count}`)
        .join(', ')}. Reset first or pass --allow-non-clean deliberately.`,
    );
  }
}

function waitForCurrentSchema() {
  const timeoutMs = Number(process.env.ECOBASE_BOOTSTRAP_SCHEMA_TIMEOUT_MS ?? 5 * 60 * 1000);
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      assertCurrentSchema();
      return;
    } catch (error) {
      lastError = error;
      sleep(5000);
    }
  }
  throw lastError ?? new Error('live-gate schema did not become ready before timeout');
}

function assertCurrentSchema() {
  const missing = [
    'ecobaseSourceConnections',
    'silverCompanies',
    'silverSupplierExternalRefs',
    'ecobaseImportRuns',
  ].filter(
    (table) =>
      Number(
        psqlScalar(
          `select count(*) from information_schema.tables where table_schema='public' and table_name=${sqlString(
            table,
          )}`,
        ),
      ) !== 1,
  );
  if (missing.length > 0) {
    throw new Error(`live-gate schema is not current; missing tables: ${missing.join(', ')}`);
  }
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function sourcesForRestore(sources) {
  if (args.has('--keep-schedules-enabled')) return sources;
  return sources.map((source) => {
    if (!isSellerboardSource(source)) return source;
    return {
      ...source,
      config: {
        ...(source.config ?? {}),
        schedule: {
          ...(source.config?.schedule ?? {}),
          enabled: false,
        },
      },
    };
  });
}

function restoreExportedSourceConfigs(exportData) {
  validateSourceExport(exportData);
  psqlExec(`
    with payload(data) as (values (${sqlJson(exportData.sources)}::jsonb))
    update "ecobaseSourceConnections" target
    set
      config = coalesce(source->'config', '{}'::jsonb),
      active = coalesce((source->>'active')::boolean, true),
      "updatedAt" = now()
    from payload, jsonb_array_elements(data) source
    where target.id = (source->>'id')::uuid;
  `);
}

function validateSourceExport(exportData) {
  if (!Array.isArray(exportData.sources)) throw new Error('source export is missing sources array');
  const ids = new Set();
  for (const source of exportData.sources) {
    requiredString(source.id, `source ${source.name ?? '<unknown>'} id`);
    if (ids.has(source.id)) throw new Error(`duplicate source id in export: ${source.id}`);
    ids.add(source.id);
    requiredString(source.name, `source ${source.id} name`);
    requiredString(source.sourceType, `source ${source.name} sourceType`);
    requiredString(source.domain, `source ${source.name} domain`);
  }
  const sellerboard = exportData.sources.filter(isSellerboardSource);
  if (sellerboard.length !== REQUIRED_SELLERBOARD_COMPANIES.length) {
    throw new Error(
      `expected ${REQUIRED_SELLERBOARD_COMPANIES.length} Sellerboard sources, found ${sellerboard.length}`,
    );
  }
  const byCompany = new Map();
  for (const source of sellerboard) {
    const company = requiredString(source.companyName, `Sellerboard source ${source.name} companyName`);
    if (!REQUIRED_SELLERBOARD_COMPANIES.includes(company))
      throw new Error(`unexpected Sellerboard company: ${company}`);
    if (byCompany.has(company)) throw new Error(`duplicate Sellerboard source for ${company}`);
    byCompany.set(company, source);
    if (source.active !== true) throw new Error(`Sellerboard source ${source.name} is not active`);
    const reportUrls = source.config?.reportUrls;
    if (!Array.isArray(reportUrls) || reportUrls.length === 0)
      throw new Error(`Sellerboard source ${source.name} has no reportUrls`);
    for (const report of reportUrls) {
      requiredString(report?.name, `Sellerboard source ${source.name} report name`);
      requiredString(report?.category, `Sellerboard source ${source.name} report category`);
      requiredString(report?.url, `Sellerboard source ${source.name} report URL`);
    }
  }
  for (const company of REQUIRED_SELLERBOARD_COMPANIES) {
    if (!byCompany.has(company)) throw new Error(`missing Sellerboard source for ${company}`);
  }
  for (const expected of DEFAULT_CSV_SOURCES) {
    const match = exportData.sources.find(
      (source) => source.sourceType === expected.sourceType && source.domain === expected.domain && !source.companyId,
    );
    if (!match) throw new Error(`missing default source ${expected.sourceType}/${expected.domain}`);
  }
}

function isSellerboardSource(source) {
  return source?.sourceType === 'sellerboard' && source?.domain === 'amazon_operations';
}

function requiredSource(sources, sourceType, domain) {
  const matches = sources.filter(
    (source) => source.sourceType === sourceType && source.domain === domain && !source.companyId,
  );
  if (matches.length !== 1) throw new Error(`expected one source for ${sourceType}/${domain}, found ${matches.length}`);
  return matches[0];
}

function requiredCompanyNames(exportData) {
  return new Set(exportData.sources.filter(isSellerboardSource).map((source) => source.companyName));
}

function requiredString(value, label) {
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error(`${label} is required`);
  return value.trim();
}

let greenfieldBundleManifest;

function bundleFilePaths(groupIds) {
  if (!GREENFIELD_BUNDLE_PATH) return undefined;
  greenfieldBundleManifest ??= JSON.parse(readFileSync(GREENFIELD_BUNDLE_PATH, 'utf8'));
  const groups = new Map((greenfieldBundleManifest.groups ?? []).map((group) => [group.id, group]));
  return groupIds.flatMap((id) => {
    const group = groups.get(id);
    if (!group || !Array.isArray(group.files) || group.files.length === 0) {
      throw new Error(`greenfield bundle group is missing files: ${id}`);
    }
    return group.files.map((file) => assertFileExists(path.resolve(GREENFIELD_PROJECT_ROOT, file.path)));
  });
}

function listHistoryDashboardFiles() {
  return (
    bundleFilePaths([
      'sellerboard-history-ecofission',
      'sellerboard-history-muxtex',
      'sellerboard-history-retail-heaven',
      'sellerboard-history-stop-shop',
    ]) ?? listDataFiles('history').filter((file) => path.basename(file).includes('_Dashboard_by_product_'))
  );
}

function listCogsFiles() {
  return (
    bundleFilePaths([
      'sellerboard-cogs-ecofission',
      'sellerboard-cogs-muxtex',
      'sellerboard-cogs-retail-heaven',
      'sellerboard-cogs-stop-shop',
    ]) ?? listDataFiles('history').filter((file) => path.basename(file).includes('_Cost_of_Goods_Sold_'))
  );
}

function orderFiles() {
  return (
    bundleFilePaths(['order-management']) ?? [
      path.join(PROJECT_ROOT, 'data', 'order-managment-sheets', 'Ecofission-Order Management - Purchase Orders.csv'),
      path.join(PROJECT_ROOT, 'data', 'order-managment-sheets', 'Ecofission-Order Management - OrderDetails.csv'),
    ].map(assertFileExists)
  );
}

function supplierFiles() {
  const files =
    bundleFilePaths(['supplier-management']) ??
    [
      path.join(
        PROJECT_ROOT,
        'data',
        'supplier-management-sheets',
        'Supplier Analysis Tracker - Supplier Analysis Tracker.csv',
      ),
      path.join(PROJECT_ROOT, 'data', 'supplier-management-sheets', 'Supplier Analysis Tracker - Supplier 2026.csv'),
    ].map(assertFileExists);
  const byName = new Map(files.map((file) => [path.basename(file), file]));
  return [
    'Supplier Analysis Tracker - Supplier Analysis Tracker.csv',
    'Supplier Analysis Tracker - Supplier 2026.csv',
  ].map((name) => {
    const file = byName.get(name);
    if (!file) throw new Error(`greenfield supplier bundle is missing ${name}`);
    return file;
  });
}

function clickupFiles() {
  return (
    bundleFilePaths(['clickup-order-status']) ??
    [path.join(PROJECT_ROOT, 'data', 'clickup', 'Order Management Clickup Data 06-07-2026.csv')].map(assertFileExists)
  );
}

function listDataFiles(subdir) {
  const dir = path.join(PROJECT_ROOT, 'data', subdir);
  if (!existsSync(dir)) throw new Error(`data directory is missing: ${dir}`);
  return readdirSync(dir)
    .filter((name) => name.endsWith('.csv'))
    .sort()
    .map((name) => assertFileExists(path.join(dir, name)));
}

function companyFromHistoryFile(fileName, marker) {
  const [prefix] = fileName.split(`_${marker}`);
  const company = HISTORY_COMPANY_BY_PREFIX[prefix];
  if (!company) throw new Error(`could not infer company from history file ${fileName}`);
  return company;
}

function csvFile(filePath) {
  return { name: path.basename(filePath), content: readFileSync(filePath, 'utf8') };
}

function assertFileExists(filePath) {
  if (!existsSync(filePath)) throw new Error(`required CSV file is missing: ${filePath}`);
  return filePath;
}

function companyKey(company) {
  return company
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function psqlJson(sql) {
  const output = psqlScalar(`select coalesce(jsonb_pretty((${sql})::jsonb), 'null')`);
  return JSON.parse(output || 'null');
}

function psqlScalar(sql) {
  return psqlExec(sql, ['-tA']).trim();
}

function psqlExec(sql, extraArgs = []) {
  const script = `psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" ${extraArgs.join(' ')}`;
  return dockerExec(PG_CONTAINER, script, `${sql.trim()}\n`);
}

function dockerExec(container, command, input) {
  return run('docker', ['exec', '-i', container, 'sh', '-lc', command], { input, redact: true }).stdout;
}

function run(commandName, commandArgs, options = {}) {
  const result = spawnSync(commandName, commandArgs, {
    input: options.input,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 200,
    env: options.env ?? process.env,
  });
  if (result.status !== 0) {
    const stderr = options.redact ? redactText(result.stderr) : result.stderr;
    const stdout = options.redact ? redactText(result.stdout) : result.stdout;
    throw new Error(`${commandName} ${commandArgs.join(' ')} failed with exit ${result.status}\n${stderr || stdout}`);
  }
  return {
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function ensureArtifactDir() {
  mkdirSync(ARTIFACT_DIR, { recursive: true });
}

function loadPrivateExport() {
  if (!existsSync(PRIVATE_EXPORT_PATH)) {
    throw new Error(`private source export is missing: ${PRIVATE_EXPORT_PATH}. Run export-sources first.`);
  }
  return JSON.parse(readFileSync(PRIVATE_EXPORT_PATH, 'utf8'));
}

function writeJsonPrivate(filePath, value) {
  writeJson(filePath, value);
  chmodSync(filePath, 0o600);
}

function writeJson(filePath, value) {
  ensureArtifactDir();
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function redactExport(exportData) {
  return {
    ...exportData,
    sources: exportData.sources.map((source) => ({
      id: source.id,
      name: source.name,
      companyId: source.companyId,
      companyName: source.companyName,
      companyKey: source.companyKey,
      sourceType: source.sourceType,
      domain: source.domain,
      configKeys: Object.keys(source.config ?? {}).sort(),
      reportUrlCount: Array.isArray(source.config?.reportUrls) ? source.config.reportUrls.length : 0,
      secretRef: source.secretRef ? '<redacted>' : null,
      freshnessSlaMinutes: source.freshnessSlaMinutes,
      active: source.active,
    })),
  };
}

function redactText(value) {
  return String(value)
    .replace(/https?:\/\/[^\s"']+/g, '<redacted-url>')
    .replace(/("?(?:token|password|secret|apiKey|url)"?\s*[:=]\s*)"?[^,"'\s}]+"?/gi, '$1<redacted>');
}

function sqlJson(value) {
  return sqlString(JSON.stringify(value));
}

function sqlString(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}
