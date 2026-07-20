/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { createHash } from 'node:crypto';
import type {
  CoverageEvidencePlan,
  CoverageIntervalEvidence,
  CoverageMembershipEvidence,
} from '../../../features/source-import/server/source-coverage-service';

const months = ['2026-01-01', '2026-02-01', '2026-03-01', '2026-04-01', '2026-05-01', '2026-06-01'];

function sha256(value: string) {
  return createHash('sha256').update(value).digest('hex');
}

function monthEnd(monthStart: string) {
  const date = new Date(`${monthStart}T00:00:00.000Z`);
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
}

function interval(params: {
  accountId: string;
  monthStart: string;
  adapterName: 'sellerboard-history-csv' | 'sellerboard-api';
  continuous: boolean;
}): CoverageIntervalEvidence {
  const current = params.adapterName === 'sellerboard-api';
  const sourceVersion = current ? '2026-07-16' : '2026-07-04';
  return {
    naturalKey: `coverage:source-1:${params.accountId}:${params.monthStart}:${sourceVersion}`,
    sourceConnectionId: 'source-1',
    companyId: 'company-1',
    amazonAccountId: params.accountId,
    marketplace: `marketplace-${params.accountId}`,
    coveredStartDate: params.monthStart,
    coveredEndDate: current ? '2026-07-16' : monthEnd(params.monthStart),
    continuousCoverage: params.continuous,
    sourceAsOfDate: sourceVersion,
    sourceVersion,
    importRunId: current ? 'current-run' : 'history-run',
    inputDigest: sha256(`input:${params.accountId}:${params.monthStart}:${sourceVersion}`),
    scopeDigest: sha256(`scope:${params.accountId}:${params.monthStart}:${sourceVersion}`),
    evidenceJson: { adapterName: params.adapterName },
  };
}

function membership(
  intervalEvidence: CoverageIntervalEvidence,
  companyProductId: string,
  complete = true,
): CoverageMembershipEvidence {
  return {
    intervalNaturalKey: intervalEvidence.naturalKey,
    companyProductId,
    monthStart: intervalEvidence.coveredStartDate,
    scopeEvidenceKinds: ['profit_by_product_daily'],
    scopeEvidenceDigest: sha256(`scope:${intervalEvidence.naturalKey}:${companyProductId}`),
    sourceMetricRowCount: 1,
    normalizedFactLinkCount: complete ? 1 : 0,
    metricReconciliationStatus: complete ? 'complete' : 'incomplete',
    metricEvidenceDigest: sha256(`metric:${intervalEvidence.naturalKey}:${companyProductId}:${complete}`),
  };
}

export function frozenCoverageBootstrapFixture(): {
  plan: CoverageEvidencePlan;
  companyProducts: Array<Record<string, unknown>>;
} {
  const companyProducts = Array.from({ length: 2363 }, (_, index) => ({
    id: `cp-${String(index).padStart(4, '0')}`,
    companyId: 'company-1',
    amazonAccountId: index < 2221 ? 'account-main' : 'account-sparse',
  }));
  const historyIntervals = [
    ...months.map((monthStart) =>
      interval({ accountId: 'account-main', monthStart, adapterName: 'sellerboard-history-csv', continuous: true }),
    ),
    ...months.map((monthStart, index) =>
      interval({
        accountId: 'account-sparse',
        monthStart,
        adapterName: 'sellerboard-history-csv',
        continuous: index !== 0,
      }),
    ),
    ...Array.from({ length: 42 }, (_, index) =>
      interval({
        accountId: `account-history-only-${index}`,
        monthStart: months[index % months.length],
        adapterName: 'sellerboard-history-csv',
        continuous: index < 31,
      }),
    ),
  ];
  const historyByAccountMonth = new Map(
    historyIntervals.map((item) => [`${item.amazonAccountId}\u0000${item.coveredStartDate}`, item]),
  );
  const eligibleMonthCount = (index: number) => {
    if (index < 260) return 6;
    if (index < 427) return 3;
    if (index < 564) return 4;
    if (index < 660) return 5;
    if (index < 904) return 1;
    if (index < 1071) return 2;
    return 0;
  };
  const historyMemberships: CoverageMembershipEvidence[] = [];
  companyProducts.forEach((companyProduct, index) => {
    months.slice(0, eligibleMonthCount(index)).forEach((monthStart) => {
      const intervalEvidence = historyByAccountMonth.get(`${companyProduct.amazonAccountId}\u0000${monthStart}`);
      if (!intervalEvidence) throw new Error('Frozen coverage fixture is missing a history interval.');
      historyMemberships.push(membership(intervalEvidence, String(companyProduct.id)));
    });
  });
  companyProducts.slice(1071, 1076).forEach((companyProduct) => {
    const intervalEvidence = historyByAccountMonth.get('account-main\u00002026-01-01');
    if (!intervalEvidence) throw new Error('Frozen coverage fixture is missing its metric-mismatch interval.');
    historyMemberships.push(membership(intervalEvidence, String(companyProduct.id), false));
  });
  companyProducts.slice(2221, 2267).forEach((companyProduct) => {
    const intervalEvidence = historyByAccountMonth.get('account-sparse\u00002026-01-01');
    if (!intervalEvidence) throw new Error('Frozen coverage fixture is missing its discontinuous interval.');
    historyMemberships.push(membership(intervalEvidence, String(companyProduct.id)));
  });

  const currentIntervals = [
    interval({ accountId: 'account-main', monthStart: '2026-07-01', adapterName: 'sellerboard-api', continuous: true }),
    interval({
      accountId: 'account-sparse',
      monthStart: '2026-07-01',
      adapterName: 'sellerboard-api',
      continuous: false,
    }),
    ...Array.from({ length: 8 }, (_, index) =>
      interval({
        accountId: `account-current-only-${index}`,
        monthStart: '2026-07-01',
        adapterName: 'sellerboard-api',
        continuous: index < 4,
      }),
    ),
  ];
  const currentByAccount = new Map(currentIntervals.map((item) => [item.amazonAccountId, item]));
  const currentMemberships = companyProducts.slice(0, 2319).map((companyProduct, index) => {
    const intervalEvidence = currentByAccount.get(String(companyProduct.amazonAccountId));
    if (!intervalEvidence) throw new Error('Frozen coverage fixture is missing a current interval.');
    const metricMismatch = index < 88 || index >= 2307;
    return membership(intervalEvidence, String(companyProduct.id), !metricMismatch);
  });

  return {
    companyProducts,
    plan: {
      intervals: [...historyIntervals, ...currentIntervals],
      memberships: [...historyMemberships, ...currentMemberships],
    },
  };
}
