/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Team.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

export const TD02A_STRICT_REFERENCE_MANIFEST = {
  version: 'td02a_strict_source_row_rebaseline_v2',
  evidenceDigest: '8a8115d136c8b887a06f460ffcad1c546da103c6fd552ddfa17fae7e341cabf8',
  planDigest: '362134b7a631794b7cd91db0e1b300ae0583d2dbc47dcf1cf2d13f34de36fe01',
  canonicalProjection: {
    byteCount: 3473833,
    sha256: '25ac3f89d23581ff875c7f90b98ea62a50d88c352fede93ca61ba7b46cdcfedf',
  },
  coverage: {
    history: {
      intervalCount: 54,
      continuousIntervalCount: 42,
      discontinuousIntervalCount: 12,
      membershipCount: 3718,
    },
    baseline: {
      listingCount: 2363,
      productMonthCount: 14178,
      eligibleCompleteCount: 3667,
      productScopeUnknownCount: 10364,
      coverageDiscontinuousCount: 142,
      metricNormalizationMismatchCount: 5,
      confidenceCounts: { full: 260, moderate: 400, low: 411, none: 1292 },
    },
    current: {
      intervalCount: 10,
      continuousIntervalCount: 5,
      incompleteIntervalCount: 5,
      membershipCount: 2319,
      metricNormalizationMismatchCount: 100,
      completeScopeMetricNormalizationMismatchCount: 88,
    },
    predictedLedgerWriteCount: 6101,
    predictedProtectedDomainMutationCount: 0,
  },
  dependentAcceptance: {
    baselineResults: { A: 21, B: 53, C: 440, D: 141, no_movement: 416, unclassified: 1292 },
    currentProjectionConfidence: {
      trusted: 2125,
      coverage_incomplete: 128,
      product_scope_unknown: 22,
      metric_normalization_mismatch: 88,
    },
    listingCount: 2363,
    familyActionCount: 1919,
    currentProjectionGateMode: 'informational',
    candidateDigest: null,
    candidateDigestReason: 'TD-20 candidate inputs and materialized rows do not exist yet.',
  },
  artifacts: {
    independentReferenceImplementation: '78d2c36c4f3c3f290f64f304afb2301fde533efba50d58042116ab71e9aaaa0c',
    independentReferenceResult: '9673927a295b7e42f50e17a94a00c47ffff01b4807cb9e0765d15fb706ffd26d',
    canonicalProjectionFile: 'b69788aeba35ef5f67edf1a2054cadddb82ed893f13f3ea8d7f08be3804e9e7a',
    causalityReport: '6fb2c1eb0f3f8976fb54d0d009750c32444fb76060e22a8c0141e7f3313dfe03',
    dependentReference: '59f41f4d6f08c7cdc2a02217911e37e64787cecfb8e4f8160715ba90343e3359',
    dependentCalculatorEvidence: '9d2d8642dee226a9ab558b32c0f515eb41054f80fa5a7b3681ac65eaffced379',
  },
} as const;
