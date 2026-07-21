/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

/**
 * Design tokens for the Inventory Dashboard (AD-8 / REQ-X6). All colors on the
 * page come from here — no scattered inline hex values. Tag colors use antd v5
 * preset names so they track the active theme.
 */

export const DASHBOARD_TAG_COLORS = {
  danger: 'red',
  warning: 'orange',
  ok: 'green',
  info: 'blue',
  neutral: 'default',
  accent: 'purple',
} as const;

export type DashboardTagColor = (typeof DASHBOARD_TAG_COLORS)[keyof typeof DASHBOARD_TAG_COLORS];

export const DASHBOARD_TOKENS = {
  sectionGap: 24,
  paneMinHeight: 320,
  paneHeaderGap: 8,
  tileMinWidth: 180,
  moneyColor: '#00000073', // antd secondary text
  headingColor: '#000000d9',
} as const;

export const TIER_TAG_COLOR: Record<string, DashboardTagColor> = {
  a: DASHBOARD_TAG_COLORS.ok,
  b: DASHBOARD_TAG_COLORS.info,
  c: DASHBOARD_TAG_COLORS.warning,
};

export const BUFFER_TAG_COLOR = {
  sufficient: DASHBOARD_TAG_COLORS.ok,
  at_risk: DASHBOARD_TAG_COLORS.warning,
  late: DASHBOARD_TAG_COLORS.danger,
  unknown: DASHBOARD_TAG_COLORS.neutral,
} as const;

export const BAND_TAG_COLOR = {
  above_band: DASHBOARD_TAG_COLORS.ok,
  within_band: DASHBOARD_TAG_COLORS.info,
  below_band: DASHBOARD_TAG_COLORS.danger,
  insufficient_evidence: DASHBOARD_TAG_COLORS.neutral,
} as const;

export const TREND_TAG_COLOR = {
  up: DASHBOARD_TAG_COLORS.ok,
  flat: DASHBOARD_TAG_COLORS.info,
  down: DASHBOARD_TAG_COLORS.danger,
  unknown: DASHBOARD_TAG_COLORS.neutral,
} as const;
