/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Team.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { bronzePayloadHash } from '../../../features/source-import/server/bronze-import-service';
import { ECOBASE_COLLECTIONS } from '../../collections/names';

export const FROZEN_COVERAGE_IMPORT_PLAN_DIGEST = '42c8420c9f1acda61ead39b6bbc9994b829759142924396bad6f3a2b54ee4642';

const SOURCE_AS_OF_DATE = '2026-07-16';
const BASELINE_MONTHS = ['2026-01-01', '2026-02-01', '2026-03-01', '2026-04-01', '2026-05-01', '2026-06-01'];

type PlainRecord = Record<string, unknown>;
type HistoryStatus = 'complete' | 'incomplete' | 'absent';
type DateFormat = 'day-first' | 'month-first';

type AccountSpec = {
  id: string;
  companyId: string;
  companyLabel: string;
  sourceConnectionId: string;
  historyRunId: string;
  currentRunId: string;
  marketplace: string;
  productCount: number;
  history: HistoryStatus[];
  currentContinuous: boolean;
  dateFormat: DateFormat;
};

type ProductRef = {
  account: AccountSpec;
  companyProductId: string;
  productId: string;
  asin: string;
  sku: string;
};

const COMPLETE_HISTORY = BASELINE_MONTHS.map(() => 'complete' as const);
const accountSpecs: AccountSpec[] = [
  {
    id: 'account-eco-ca',
    companyId: 'company-eco',
    companyLabel: 'Fissionem',
    sourceConnectionId: '44c89767-07e1-44ea-aafc-8954c8dc9543',
    historyRunId: '9217b21f-d233-4c13-98c1-464b40aa48cc',
    currentRunId: '8631a0a9-3669-4c5c-be18-fc5c24f74821',
    marketplace: 'Amazon.ca',
    productCount: 85,
    history: [...COMPLETE_HISTORY],
    currentContinuous: true,
    dateFormat: 'day-first',
  },
  {
    id: 'account-eco-us',
    companyId: 'company-eco',
    companyLabel: 'Fissionem',
    sourceConnectionId: '44c89767-07e1-44ea-aafc-8954c8dc9543',
    historyRunId: '9217b21f-d233-4c13-98c1-464b40aa48cc',
    currentRunId: '8631a0a9-3669-4c5c-be18-fc5c24f74821',
    marketplace: 'Amazon.com',
    productCount: 459,
    history: [...COMPLETE_HISTORY],
    currentContinuous: true,
    dateFormat: 'day-first',
  },
  {
    id: 'account-eco-br',
    companyId: 'company-eco',
    companyLabel: 'Fissionem',
    sourceConnectionId: '44c89767-07e1-44ea-aafc-8954c8dc9543',
    historyRunId: '9217b21f-d233-4c13-98c1-464b40aa48cc',
    currentRunId: '8631a0a9-3669-4c5c-be18-fc5c24f74821',
    marketplace: 'Amazon.com.br',
    productCount: 7,
    history: BASELINE_MONTHS.map(() => 'incomplete' as const),
    currentContinuous: false,
    dateFormat: 'day-first',
  },
  {
    id: 'account-eco-mx',
    companyId: 'company-eco',
    companyLabel: 'Fissionem',
    sourceConnectionId: '44c89767-07e1-44ea-aafc-8954c8dc9543',
    historyRunId: '9217b21f-d233-4c13-98c1-464b40aa48cc',
    currentRunId: '8631a0a9-3669-4c5c-be18-fc5c24f74821',
    marketplace: 'Amazon.com.mx',
    productCount: 88,
    history: [...COMPLETE_HISTORY],
    currentContinuous: false,
    dateFormat: 'day-first',
  },
  {
    id: 'account-mux-us',
    companyId: 'company-mux',
    companyLabel: 'Muxtex',
    sourceConnectionId: '81cdcbee-8ea0-4d98-9eb3-d7a538249146',
    historyRunId: '1dda0f7a-4f90-403f-80b1-3846884ceca9',
    currentRunId: '371558ee-a449-416b-8f01-cd5f33ec8860',
    marketplace: 'Amazon.com',
    productCount: 803,
    history: [...COMPLETE_HISTORY],
    currentContinuous: true,
    dateFormat: 'day-first',
  },
  {
    id: 'account-retail-us',
    companyId: 'company-retail',
    companyLabel: 'Retail_Heaven_Inc',
    sourceConnectionId: '5ac716e9-e270-4f13-b079-d39887d64947',
    historyRunId: '79c454a4-5771-4eb1-86be-08467cc1c3b5',
    currentRunId: '30c6cbb0-c41a-44b7-8f8b-b65c32cb9ec7',
    marketplace: 'Amazon.com',
    productCount: 340,
    history: [...COMPLETE_HISTORY],
    currentContinuous: true,
    dateFormat: 'month-first',
  },
  {
    id: 'account-retail-mx',
    companyId: 'company-retail',
    companyLabel: 'Retail_Heaven_Inc',
    sourceConnectionId: '5ac716e9-e270-4f13-b079-d39887d64947',
    historyRunId: '79c454a4-5771-4eb1-86be-08467cc1c3b5',
    currentRunId: '30c6cbb0-c41a-44b7-8f8b-b65c32cb9ec7',
    marketplace: 'Amazon.com.mx',
    productCount: 8,
    history: ['incomplete', 'incomplete', 'incomplete', 'complete', 'incomplete', 'incomplete'],
    currentContinuous: false,
    dateFormat: 'month-first',
  },
  {
    id: 'account-stop-ca',
    companyId: 'company-stop',
    companyLabel: 'Stop_Shop_Llc',
    sourceConnectionId: 'ee4320ac-c459-4169-b043-a1f881c5a48a',
    historyRunId: 'ae8e31ab-d546-429e-9f84-af9695eecbe1',
    currentRunId: 'bc605c58-4a0f-4a44-8b23-77d93dfdb15f',
    marketplace: 'Amazon.ca',
    productCount: 7,
    history: BASELINE_MONTHS.map(() => 'absent' as const),
    currentContinuous: false,
    dateFormat: 'day-first',
  },
  {
    id: 'account-stop-us',
    companyId: 'company-stop',
    companyLabel: 'Stop_Shop_Llc',
    sourceConnectionId: 'ee4320ac-c459-4169-b043-a1f881c5a48a',
    historyRunId: 'ae8e31ab-d546-429e-9f84-af9695eecbe1',
    currentRunId: 'bc605c58-4a0f-4a44-8b23-77d93dfdb15f',
    marketplace: 'Amazon.com',
    productCount: 548,
    history: [...COMPLETE_HISTORY],
    currentContinuous: true,
    dateFormat: 'day-first',
  },
  {
    id: 'account-stop-mx',
    companyId: 'company-stop',
    companyLabel: 'Stop_Shop_Llc',
    sourceConnectionId: 'ee4320ac-c459-4169-b043-a1f881c5a48a',
    historyRunId: 'ae8e31ab-d546-429e-9f84-af9695eecbe1',
    currentRunId: 'bc605c58-4a0f-4a44-8b23-77d93dfdb15f',
    marketplace: 'Amazon.com.mx',
    productCount: 18,
    history: ['complete', 'complete', 'complete', 'complete', 'complete', 'incomplete'],
    currentContinuous: false,
    dateFormat: 'day-first',
  },
];

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Frozen coverage import fixture is invalid: ${message}.`);
}

function datesInMonth(monthStart: string) {
  const [year, month] = monthStart.split('-').map(Number);
  const dayCount = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return Array.from(
    { length: dayCount },
    (_, index) => `${monthStart.slice(0, 8)}${String(index + 1).padStart(2, '0')}`,
  );
}

function rawDate(value: string, format: DateFormat) {
  const [year, month, day] = value.split('-').map(Number);
  return format === 'day-first' ? `${day}/${month}/${year}` : `${month}/${day}/${year}`;
}

function target(map: Map<string, Set<string>>, key: string) {
  const selected = map.get(key) ?? new Set<string>();
  map.set(key, selected);
  return selected;
}

function targetCount(map: Map<string, Set<string>>) {
  return [...map.values()].reduce((total, values) => total + values.size, 0);
}

export function frozenCoverageImportProjectionFixture(): {
  importRunIds: string[];
  seeds: Record<string, PlainRecord[]>;
} {
  const accounts = accountSpecs.map((account) => ({
    id: account.id,
    companyId: account.companyId,
    marketplace: account.marketplace,
  }));
  const products: PlainRecord[] = [];
  const companyProducts: PlainRecord[] = [];
  const productRefs: ProductRef[] = [];
  const productsByAccount = new Map<string, ProductRef[]>();
  let productSequence = 0;
  for (const account of accountSpecs) {
    const accountProducts: ProductRef[] = [];
    for (let index = 0; index < account.productCount; index += 1) {
      productSequence += 1;
      const ref = {
        account,
        companyProductId: `company-product-${String(productSequence).padStart(4, '0')}`,
        productId: `product-${String(productSequence).padStart(4, '0')}`,
        asin: `B${String(productSequence).padStart(9, '0')}`,
        sku: `SKU-${String(productSequence).padStart(4, '0')}`,
      };
      accountProducts.push(ref);
      productRefs.push(ref);
      products.push({ id: ref.productId, asin: ref.asin, sku: ref.sku });
      companyProducts.push({
        id: ref.companyProductId,
        companyId: account.companyId,
        amazonAccountId: account.id,
        productId: ref.productId,
      });
    }
    productsByAccount.set(account.id, accountProducts);
  }
  invariant(productRefs.length === 2363, `expected 2363 products, received ${productRefs.length}`);

  const completeAccountPools = accountSpecs
    .filter((account) => account.history.every((status) => status === 'complete'))
    .map((account) => [...(productsByAccount.get(account.id) ?? [])]);
  const eligibleProducts: ProductRef[] = [];
  while (eligibleProducts.length < 1073) {
    let added = false;
    for (const pool of completeAccountPools) {
      const next = pool.shift();
      if (!next) continue;
      eligibleProducts.push(next);
      added = true;
      if (eligibleProducts.length === 1073) break;
    }
    invariant(added, 'complete-account product pools cannot satisfy the baseline confidence partition');
  }

  const historyTargets = new Map<string, Set<string>>();
  eligibleProducts.forEach((product, index) => {
    const eligibleMonthCount = index < 264 ? 6 : index < 660 ? 4 : index < 762 ? 2 : 1;
    BASELINE_MONTHS.slice(0, eligibleMonthCount).forEach((monthStart) => {
      target(historyTargets, `${product.account.id}\u0000${monthStart}`).add(product.companyProductId);
    });
  });
  const mixedCompleteScopes = accountSpecs.flatMap((account) =>
    account.history.flatMap((status, index) =>
      status === 'complete' && !account.history.every((item) => item === 'complete')
        ? [{ account, monthStart: BASELINE_MONTHS[index] }]
        : [],
    ),
  );
  invariant(
    mixedCompleteScopes.length === 6,
    `expected six mixed complete scopes, received ${mixedCompleteScopes.length}`,
  );
  mixedCompleteScopes.forEach((scope, index) => {
    const donor = eligibleProducts[eligibleProducts.length - 1 - index];
    const donorTargets = target(historyTargets, `${donor.account.id}\u00002026-01-01`);
    invariant(donorTargets.delete(donor.companyProductId), `missing one-month donor ${donor.companyProductId}`);
    const recipient = (productsByAccount.get(scope.account.id) ?? [])[index];
    invariant(recipient, `missing mixed-scope product for ${scope.account.id}`);
    target(historyTargets, `${scope.account.id}\u0000${scope.monthStart}`).add(recipient.companyProductId);
  });
  const discontinuousScopes = accountSpecs.flatMap((account) =>
    account.history.flatMap((status, index) =>
      status === 'incomplete' ? [{ account, monthStart: BASELINE_MONTHS[index] }] : [],
    ),
  );
  invariant(
    discontinuousScopes.length === 12,
    `expected 12 discontinuous scopes, received ${discontinuousScopes.length}`,
  );
  for (let index = 0; index < 46; index += 1) {
    const scope = discontinuousScopes[index % discontinuousScopes.length];
    const candidates = productsByAccount.get(scope.account.id) ?? [];
    const product = candidates[Math.floor(index / discontinuousScopes.length) % candidates.length];
    invariant(product, `missing discontinuous product for ${scope.account.id}`);
    target(historyTargets, `${scope.account.id}\u0000${scope.monthStart}`).add(product.companyProductId);
  }
  invariant(
    targetCount(historyTargets) === 3729,
    `expected 3729 history memberships, received ${targetCount(historyTargets)}`,
  );

  const continuousCurrentProducts = accountSpecs
    .filter((account) => account.currentContinuous)
    .flatMap((account) => productsByAccount.get(account.id) ?? []);
  const incompleteCurrentExclusionPool = productsByAccount.get('account-eco-mx') ?? [];
  const currentExcluded = new Set([
    ...continuousCurrentProducts.slice(-24).map((product) => product.companyProductId),
    ...incompleteCurrentExclusionPool.slice(-22).map((product) => product.companyProductId),
  ]);
  const currentProducts = productRefs.filter((product) => !currentExcluded.has(product.companyProductId));
  invariant(currentProducts.length === 2317, `expected 2317 current memberships, received ${currentProducts.length}`);
  const currentTargets = new Map<string, Set<string>>();
  currentProducts.forEach((product) => target(currentTargets, product.account.id).add(product.companyProductId));

  const retailUsProducts = productsByAccount.get('account-retail-us') ?? [];
  const retailMxProducts = productsByAccount.get('account-retail-mx') ?? [];
  const currentMismatchIds = new Set([
    ...retailUsProducts.slice(0, 52).map((product) => product.companyProductId),
    ...retailMxProducts.slice(0, 5).map((product) => product.companyProductId),
  ]);
  invariant(currentMismatchIds.size === 57, `expected 57 current mismatches, received ${currentMismatchIds.size}`);
  invariant(
    [...currentMismatchIds].every((id) => !currentExcluded.has(id)),
    'current mismatch products must remain in source scope',
  );

  const productByCompanyProductId = new Map(productRefs.map((product) => [product.companyProductId, product]));
  const bronzeRows: PlainRecord[] = [];
  const facts: PlainRecord[] = [];
  const links: PlainRecord[] = [];
  let rowSequence = 0;

  const addMetricRow = (params: {
    account: AccountSpec;
    product: ProductRef;
    runId: string;
    sourceDate: string;
    factDate?: string;
    history: boolean;
  }) => {
    rowSequence += 1;
    const rowId = `bronze-metric-${String(rowSequence).padStart(6, '0')}`;
    const factId = `fact-${String(rowSequence).padStart(6, '0')}`;
    const linkId = `link-${String(rowSequence).padStart(6, '0')}`;
    const rowHash = bronzePayloadHash({ rowId, runId: params.runId, sourceDate: params.sourceDate });
    const sourceRecordKey = params.history
      ? `${params.account.companyLabel}_Dashboard_by_product_01_01_2026-03_07_2026.csv:${params.product.asin}:${
          params.product.sku
        }:${rowSequence + 1}`
      : `profit_by_product_daily-Profit by Product Dashboard Daily Data.csv:${params.product.asin}:${
          params.product.sku
        }:${rowSequence + 1}`;
    bronzeRows.push({
      id: rowId,
      sourceConnectionId: params.account.sourceConnectionId,
      importRunId: params.runId,
      sourceType: 'sellerboard',
      sourceDataset: 'sellerboard_daily_facts',
      sourceRecordKey,
      observedAt: SOURCE_AS_OF_DATE,
      rowHash,
      payload: {
        period: rawDate(params.sourceDate, params.account.dateFormat),
        marketplace: params.account.marketplace,
        asin: params.product.asin,
        listingSku: params.product.sku,
        units: 1,
        netProfit: 2,
      },
    });
    facts.push({
      id: factId,
      companyProductId: params.product.companyProductId,
      snapshotDate: params.factDate ?? params.sourceDate,
      units: 1,
      profit: 2,
    });
    links.push({
      id: linkId,
      importRunId: params.runId,
      bronzeRecordId: rowId,
      silverEntityType: 'silverListingDailyFact',
      silverEntityId: factId,
      sourceRowHash: rowHash,
    });
  };

  const addStockRow = (account: AccountSpec, product: ProductRef) => {
    rowSequence += 1;
    const rowId = `bronze-stock-${String(rowSequence).padStart(6, '0')}`;
    bronzeRows.push({
      id: rowId,
      sourceConnectionId: account.sourceConnectionId,
      importRunId: account.currentRunId,
      sourceType: 'sellerboard',
      sourceDataset: 'amazon_listing_inventory',
      sourceRecordKey: `stock_daily-Stock Daily Data.csv:${product.asin}:${product.sku}`,
      observedAt: SOURCE_AS_OF_DATE,
      rowHash: bronzePayloadHash({ rowId, runId: account.currentRunId, sourceDate: SOURCE_AS_OF_DATE }),
      payload: {
        marketplace: account.marketplace,
        asin: product.asin,
        listingSku: product.sku,
      },
    });
  };

  for (const account of accountSpecs) {
    account.history.forEach((status, monthIndex) => {
      if (status === 'absent') return;
      const monthStart = BASELINE_MONTHS[monthIndex];
      const selectedIds = historyTargets.get(`${account.id}\u0000${monthStart}`) ?? new Set<string>();
      const selectedProducts = [...selectedIds]
        .map((id) => productByCompanyProductId.get(id))
        .filter(Boolean) as ProductRef[];
      invariant(selectedProducts.length > 0, `history scope ${account.id}/${monthStart} has no selected product`);
      const anchor = selectedProducts[0];
      const dates = datesInMonth(monthStart);
      const observedDates = status === 'complete' ? dates : dates.slice(0, -1);
      observedDates.forEach((sourceDate) =>
        addMetricRow({ account, product: anchor, runId: account.historyRunId, sourceDate, history: true }),
      );
      selectedProducts
        .slice(1)
        .forEach((product) =>
          addMetricRow({ account, product, runId: account.historyRunId, sourceDate: observedDates[0], history: true }),
        );
    });
  }

  const mismatchFactDates = ['2026-01-07', '2026-02-07', '2026-03-07', '2026-04-07', '2026-05-07', '2026-06-07'];
  for (const account of accountSpecs) {
    const selectedIds = currentTargets.get(account.id) ?? new Set<string>();
    const selectedProducts = [...selectedIds]
      .map((id) => productByCompanyProductId.get(id))
      .filter(Boolean) as ProductRef[];
    invariant(selectedProducts.length > 0, `current scope ${account.id} has no selected product`);
    const anchor = selectedProducts.find((product) => !currentMismatchIds.has(product.companyProductId));
    invariant(anchor, `current scope ${account.id} has no reconciled anchor product`);
    const currentDates = Array.from({ length: 16 }, (_, index) => `2026-07-${String(index + 1).padStart(2, '0')}`);
    const observedDates = account.currentContinuous
      ? currentDates
      : currentDates.filter((date) => date !== '2026-07-08');
    observedDates.forEach((sourceDate) =>
      addMetricRow({ account, product: anchor, runId: account.currentRunId, sourceDate, history: false }),
    );
    selectedProducts
      .filter((product) => product.companyProductId !== anchor.companyProductId)
      .forEach((product, index) => {
        const mismatch = currentMismatchIds.has(product.companyProductId);
        addMetricRow({
          account,
          product,
          runId: account.currentRunId,
          sourceDate: mismatch ? `2026-07-${String((index % 6) + 1).padStart(2, '0')}` : SOURCE_AS_OF_DATE,
          factDate: mismatch ? mismatchFactDates[index % mismatchFactDates.length] : undefined,
          history: false,
        });
      });
    addStockRow(account, anchor);
  }

  const historyIntervalCount = accountSpecs.reduce(
    (total, account) => total + account.history.filter((status) => status !== 'absent').length,
    0,
  );
  invariant(historyIntervalCount === 54, `expected 54 history intervals, received ${historyIntervalCount}`);
  invariant(
    accountSpecs.filter((account) => account.currentContinuous).length === 5,
    'expected five continuous current scopes',
  );

  const sourceConnections = [
    ['44c89767-07e1-44ea-aafc-8954c8dc9543', 'company-eco'],
    ['81cdcbee-8ea0-4d98-9eb3-d7a538249146', 'company-mux'],
    ['5ac716e9-e270-4f13-b079-d39887d64947', 'company-retail'],
    ['ee4320ac-c459-4169-b043-a1f881c5a48a', 'company-stop'],
  ].map(([id, companyId]) => ({ id, companyId }));
  const runPairs = [
    [
      '9217b21f-d233-4c13-98c1-464b40aa48cc',
      '8631a0a9-3669-4c5c-be18-fc5c24f74821',
      '44c89767-07e1-44ea-aafc-8954c8dc9543',
    ],
    [
      '1dda0f7a-4f90-403f-80b1-3846884ceca9',
      '371558ee-a449-416b-8f01-cd5f33ec8860',
      '81cdcbee-8ea0-4d98-9eb3-d7a538249146',
    ],
    [
      '79c454a4-5771-4eb1-86be-08467cc1c3b5',
      '30c6cbb0-c41a-44b7-8f8b-b65c32cb9ec7',
      '5ac716e9-e270-4f13-b079-d39887d64947',
    ],
    [
      'ae8e31ab-d546-429e-9f84-af9695eecbe1',
      'bc605c58-4a0f-4a44-8b23-77d93dfdb15f',
      'ee4320ac-c459-4169-b043-a1f881c5a48a',
    ],
  ];
  const importRuns = runPairs.flatMap(([historyRunId, currentRunId, sourceConnectionId]) => [
    {
      id: historyRunId,
      status: 'success',
      adapterName: 'sellerboard-history-csv',
      sourceConnectionId,
      sourceVersion: SOURCE_AS_OF_DATE,
    },
    {
      id: currentRunId,
      status: 'success',
      adapterName: 'sellerboard-api',
      sourceConnectionId,
      sourceVersion: SOURCE_AS_OF_DATE,
    },
  ]);
  const importRunIds = importRuns.map((run) => run.id).sort();
  invariant(importRunIds.length === 8, `expected eight import runs, received ${importRunIds.length}`);

  return {
    importRunIds,
    seeds: {
      [ECOBASE_COLLECTIONS.sourceConnections]: sourceConnections,
      [ECOBASE_COLLECTIONS.importRuns]: importRuns,
      [ECOBASE_COLLECTIONS.silverAmazonAccounts]: accounts,
      [ECOBASE_COLLECTIONS.silverProducts]: products,
      [ECOBASE_COLLECTIONS.silverCompanyProducts]: companyProducts,
      [ECOBASE_COLLECTIONS.bronzeSourceRecords]: bronzeRows,
      [ECOBASE_COLLECTIONS.silverListingDailyFacts]: facts,
      [ECOBASE_COLLECTIONS.silverNormalizationLinks]: links,
    },
  };
}
