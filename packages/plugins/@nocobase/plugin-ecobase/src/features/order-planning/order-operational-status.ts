import type { OrderLifecycleStatus } from './order-lifecycle-status';

export const CLICKUP_ORDER_OPERATIONAL_STATUSES = [
  'complete',
  'to do',
  'inbound-monitoring',
  'hold/cancelled',
  'direct-ship-fba',
  'prep-in-progress',
  'ordered',
  'in progress',
  'approved-to-order',
  'order analysing',
  'in transit to prep',
  'hold',
] as const;

export type ClickupOrderOperationalStatus = (typeof CLICKUP_ORDER_OPERATIONAL_STATUSES)[number];

type OperationalStatusMetadata = {
  canonicalStatus: string;
  lifecycleStatus: OrderLifecycleStatus;
};

const OPERATIONAL_STATUS_METADATA: Record<ClickupOrderOperationalStatus, OperationalStatusMetadata> = {
  complete: { canonicalStatus: 'completed', lifecycleStatus: 'COMPLETE' },
  'to do': { canonicalStatus: 'draft', lifecycleStatus: 'ORDER ANALYSING' },
  'inbound-monitoring': { canonicalStatus: 'shipped_inbound', lifecycleStatus: 'INBOUND MONITORING' },
  'hold/cancelled': { canonicalStatus: 'cancelled', lifecycleStatus: 'COMPLETE' },
  'direct-ship-fba': { canonicalStatus: 'shipped_inbound', lifecycleStatus: 'DIRECT SHIP FBA' },
  'prep-in-progress': { canonicalStatus: 'shipped_inbound', lifecycleStatus: 'PREP IN-PROGRESS' },
  ordered: { canonicalStatus: 'paid', lifecycleStatus: 'ORDERED' },
  'in progress': { canonicalStatus: 'supplier_contacted', lifecycleStatus: 'IN-PROGRESS' },
  'approved-to-order': { canonicalStatus: 'payment_pending', lifecycleStatus: 'APPROVED TO ORDER' },
  'order analysing': { canonicalStatus: 'draft', lifecycleStatus: 'ORDER ANALYSING' },
  'in transit to prep': { canonicalStatus: 'shipped_inbound', lifecycleStatus: 'IN TRANSIT TO PREP' },
  hold: { canonicalStatus: 'blocked', lifecycleStatus: 'IN-PROGRESS' },
};

export const CLICKUP_ORDER_OPERATIONAL_STATUS_OPTIONS = CLICKUP_ORDER_OPERATIONAL_STATUSES.map((status) => ({
  label: status,
  value: status,
}));

export function normalizeOrderOperationalStatus(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim().toLowerCase() : undefined;
}

export function clickupOrderOperationalStatus(value: unknown): ClickupOrderOperationalStatus | undefined {
  const normalized = normalizeOrderOperationalStatus(value);
  return CLICKUP_ORDER_OPERATIONAL_STATUSES.find((status) => status === normalized);
}

export function canonicalOrderStatusForOperationalStatus(value: unknown) {
  const status = clickupOrderOperationalStatus(value);
  return status ? OPERATIONAL_STATUS_METADATA[status].canonicalStatus : undefined;
}

export function lifecycleStatusForOperationalStatus(value: unknown) {
  const status = clickupOrderOperationalStatus(value);
  return status ? OPERATIONAL_STATUS_METADATA[status].lifecycleStatus : undefined;
}
