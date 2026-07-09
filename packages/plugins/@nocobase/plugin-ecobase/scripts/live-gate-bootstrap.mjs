#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(SCRIPT_DIR, '..');
const NOCOBASE_ROOT = path.resolve(PLUGIN_ROOT, '../../../..');
const PROJECT_ROOT = path.dirname(NOCOBASE_ROOT);
const ARTIFACT_DIR = process.env.ECOBASE_LIVE_GATE_BOOTSTRAP_DIR
  ? path.resolve(process.env.ECOBASE_LIVE_GATE_BOOTSTRAP_DIR)
  : path.join(NOCOBASE_ROOT, '.local', 'live-gate-bootstrap');
const PRIVATE_EXPORT_PATH = path.join(ARTIFACT_DIR, 'live-gate-sources.private.json');
const REDACTED_EXPORT_PATH = path.join(ARTIFACT_DIR, 'live-gate-sources.redacted.json');
const BASE_URL = (
  process.env.ECOBASE_LIVE_GATE_API_BASE ?? `http://127.0.0.1:${process.env.ECOBASE_LIVE_GATE_PORT ?? '13080'}/api`
).replace(/\/$/, '');
const APP_CONTAINER = process.env.ECOBASE_LIVE_GATE_APP_CONTAINER ?? 'ecobase-live-gate-app-1';
const PG_CONTAINER = process.env.ECOBASE_LIVE_GATE_POSTGRES_CONTAINER ?? 'ecobase-live-gate-postgres-1';
const ADMIN_EMAIL = process.env.ECOBASE_LIVE_GATE_ADMIN_EMAIL ?? 'admin@nocobase.com';
const ADMIN_PASSWORD = process.env.ECOBASE_LIVE_GATE_ADMIN_PASSWORD ?? 'admin123';
const BOOTSTRAP_SOURCE_VERSION = process.env.ECOBASE_BOOTSTRAP_SOURCE_VERSION ?? new Date().toISOString().slice(0, 10);
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
  switch (command) {
    case 'export-sources':
      await exportSources();
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
    case 'enable-schedules':
      restoreExportedSourceConfigs(loadPrivateExport());
      console.log('restored exported source schedules/configs');
      return;
    case 'all-after-export':
      await resetDb();
      await restoreSources();
      await importData();
      await verifyLinks();
      return;
    default:
      printUsage();
      process.exit(command ? 1 : 0);
  }
}

function printUsage() {
  console.log(`Usage: node scripts/live-gate-bootstrap.mjs <command> [--allow-non-clean]

Commands:
  export-sources     Save current live-gate source configs to ${PRIVATE_EXPORT_PATH}
  reset-db           Destroy/recreate only the local live-gate DB volume, using the existing start-live-gate.sh guard
  restore-sources    Restore exported source rows and company IDs into a clean live-gate DB
  import-data        Trigger Sellerboard API, history, COGS, order, and supplier CSV imports in order
  import-supplier-csvs  Import/retry only the supplier-management CSV files
  verify-links       Print/fail post-import medallion link checks
  enable-schedules   Restore exported source configs/schedules after verification passes
  all-after-export   reset-db -> restore-sources -> import-data -> verify-links

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

async function importData() {
  waitForCurrentSchema();
  assertBusinessClean('import data');
  const token = await signIn();
  const sources = currentSources();
  validateSourceExport({ exportedAt: new Date().toISOString(), apiBase: BASE_URL, companies: [], sources });
  const sellerboardByCompany = new Map(
    sources.filter(isSellerboardSource).map((source) => [source.companyName, source]),
  );
  const orderSource = requiredSource(sources, 'google_sheets', 'order_management');
  const supplierSource = requiredSource(sources, 'google_sheets', 'supplier_management');

  for (const company of REQUIRED_SELLERBOARD_COMPANIES) {
    const source = sellerboardByCompany.get(company);
    if (!source) throw new Error(`missing Sellerboard source for ${company}`);
    await runImport(token, `Sellerboard API ${company}`, 'ecobaseImport:run', {
      sourceConnectionId: source.id,
      adapterName: 'sellerboard-api',
      sourceIdentifier: `sellerboard-api-bootstrap-${companyKey(company)}`,
      sourceVersion: BOOTSTRAP_SOURCE_VERSION,
      idempotencyKey: `${source.id}:sellerboard-api-bootstrap:${BOOTSTRAP_SOURCE_VERSION}`,
    });
  }

  for (const filePath of listHistoryDashboardFiles()) {
    const company = companyFromHistoryFile(path.basename(filePath), 'Dashboard_by_product');
    const source = sellerboardByCompany.get(company);
    if (!source) throw new Error(`history file ${path.basename(filePath)} maps to ${company}, but no source exists`);
    await runImport(token, `Sellerboard history ${company} ${path.basename(filePath)}`, 'ecobaseImport:runCsvBundle', {
      sourceConnectionId: source.id,
      adapterName: 'sellerboard-history-csv',
      sourceIdentifier: 'sellerboard-history-backfill',
      sourceVersion: BOOTSTRAP_SOURCE_VERSION,
      defaultCompany: company,
      files: [csvFile(filePath)],
    });
  }

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

  for (const filePath of orderFiles()) {
    await runImport(token, `Order management ${path.basename(filePath)}`, 'ecobaseImport:runCsvBundle', {
      sourceConnectionId: orderSource.id,
      adapterName: 'google-sheets-migration-csv',
      sourceIdentifier: `order-management-${path.basename(filePath)}`,
      sourceVersion: BOOTSTRAP_SOURCE_VERSION,
      files: [csvFile(filePath)],
    });
  }

  for (const filePath of supplierFiles()) {
    await runImport(token, `Supplier management ${path.basename(filePath)}`, 'ecobaseImport:runCsvBundle', {
      sourceConnectionId: supplierSource.id,
      adapterName: 'google-sheets-migration-csv',
      sourceIdentifier: `supplier-management-${path.basename(filePath)}`,
      sourceVersion: BOOTSTRAP_SOURCE_VERSION,
      files: [csvFile(filePath)],
    });
  }

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

async function verifyLinks() {
  waitForCurrentSchema();
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
      `select count(*) from "silverOrderLines" l left join "silverCompanyProducts" cp on cp.id = l."companyProductId" where cp.id is null`,
      0,
    ),
    check(
      'orphan_order_line_supplier_product',
      `select count(*) from "silverOrderLines" l left join "silverSupplierProducts" sp on sp.id = l."supplierProductId" where sp.id is null`,
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
  const report = {
    generatedAt: new Date().toISOString(),
    counts,
    checks,
    actionStatus,
    importRuns,
    bronzeIssues,
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

async function runImport(token, label, action, body) {
  console.log(`import: ${label}`);
  const response = await apiPost(token, action, body);
  const run = await settleRun(unwrapActionData(response));
  printRun(label, run);
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

function listHistoryDashboardFiles() {
  return listDataFiles('history').filter((file) => path.basename(file).includes('_Dashboard_by_product_'));
}

function listCogsFiles() {
  return listDataFiles('history').filter((file) => path.basename(file).includes('_Cost_of_Goods_Sold_'));
}

function orderFiles() {
  return [
    path.join(PROJECT_ROOT, 'data', 'order-managment-sheets', 'Ecofission-Order Management - Purchase Orders.csv'),
    path.join(PROJECT_ROOT, 'data', 'order-managment-sheets', 'Ecofission-Order Management - OrderDetails.csv'),
  ].map(assertFileExists);
}

function supplierFiles() {
  return [
    path.join(PROJECT_ROOT, 'data', 'supplier-management-sheets', 'Supplier Analysis Tracker - Supplier 2026.csv'),
    path.join(
      PROJECT_ROOT,
      'data',
      'supplier-management-sheets',
      'Supplier Analysis Tracker - Supplier Analysis Tracker.csv',
    ),
  ].map(assertFileExists);
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
