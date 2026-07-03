export const ORDER_LIFECYCLE_STATUSES = [
  'IN-PROGRESS',
  'ORDER ANALYSING',
  'APPROVED TO ORDER',
  'ORDERED',
  'IN TRANSIT TO PREP',
  'DIRECT SHIP FBA',
  'AT PREP NOT STARTED',
  'PREP IN-PROGRESS',
  'SHIPPED TO FBA',
  'INBOUND MONITORING',
  'COMPLETE',
] as const;

export type OrderLifecycleStatus = (typeof ORDER_LIFECYCLE_STATUSES)[number];
export type OrderLifecycleStage = 'before_ordered' | 'after_ordered' | 'complete';
export type OrderLifecycleColorVariant = 'default' | 'supplier';

export interface OrderLifecycleStatusMetadata {
  label: OrderLifecycleStatus;
  color: string;
  supplierColor: string;
  stage: OrderLifecycleStage;
  complete: boolean;
  description: string;
}

export const ORDER_LIFECYCLE_STATUS_METADATA: Record<OrderLifecycleStatus, OrderLifecycleStatusMetadata> = {
  'IN-PROGRESS': {
    label: 'IN-PROGRESS',
    color: 'default',
    supplierColor: 'default',
    stage: 'before_ordered',
    complete: false,
    description: 'Order is being prepared or worked before final approval.',
  },
  'ORDER ANALYSING': {
    label: 'ORDER ANALYSING',
    color: 'purple',
    supplierColor: 'orange',
    stage: 'before_ordered',
    complete: false,
    description: 'Order still needs review before it should be approved or purchased.',
  },
  'APPROVED TO ORDER': {
    label: 'APPROVED TO ORDER',
    color: 'cyan',
    supplierColor: 'orange',
    stage: 'before_ordered',
    complete: false,
    description: 'Approved by operations; purchase/order execution should follow.',
  },
  ORDERED: {
    label: 'ORDERED',
    color: 'blue',
    supplierColor: 'blue',
    stage: 'after_ordered',
    complete: false,
    description: 'Order was placed with the supplier.',
  },
  'IN TRANSIT TO PREP': {
    label: 'IN TRANSIT TO PREP',
    color: 'geekblue',
    supplierColor: 'default',
    stage: 'after_ordered',
    complete: false,
    description: 'Supplier shipment is moving to prep center.',
  },
  'DIRECT SHIP FBA': {
    label: 'DIRECT SHIP FBA',
    color: 'volcano',
    supplierColor: 'default',
    stage: 'after_ordered',
    complete: false,
    description: 'Order is shipping directly to FBA instead of prep center.',
  },
  'AT PREP NOT STARTED': {
    label: 'AT PREP NOT STARTED',
    color: 'gold',
    supplierColor: 'default',
    stage: 'after_ordered',
    complete: false,
    description: 'Goods are at prep but prep work has not started.',
  },
  'PREP IN-PROGRESS': {
    label: 'PREP IN-PROGRESS',
    color: 'processing',
    supplierColor: 'default',
    stage: 'after_ordered',
    complete: false,
    description: 'Prep center work is in progress.',
  },
  'SHIPPED TO FBA': {
    label: 'SHIPPED TO FBA',
    color: 'lime',
    supplierColor: 'default',
    stage: 'after_ordered',
    complete: false,
    description: 'Prepared goods have shipped to FBA.',
  },
  'INBOUND MONITORING': {
    label: 'INBOUND MONITORING',
    color: 'green',
    supplierColor: 'blue',
    stage: 'after_ordered',
    complete: false,
    description: 'Shipment is inbound and should be monitored until received/sellable.',
  },
  COMPLETE: {
    label: 'COMPLETE',
    color: 'success',
    supplierColor: 'green',
    stage: 'complete',
    complete: true,
    description: 'Order no longer contributes active money at risk.',
  },
};

export const BEFORE_ORDERED_STATUSES = ORDER_LIFECYCLE_STATUSES.filter(
  (status) => ORDER_LIFECYCLE_STATUS_METADATA[status].stage === 'before_ordered',
);

export const AFTER_ORDERED_STATUSES = ORDER_LIFECYCLE_STATUSES.filter(
  (status) => ORDER_LIFECYCLE_STATUS_METADATA[status].stage === 'after_ordered',
);

export const COMPLETED_ORDER_LIFECYCLE_STATUSES = ORDER_LIFECYCLE_STATUSES.filter(
  (status) => ORDER_LIFECYCLE_STATUS_METADATA[status].complete,
);

export const ORDER_LIFECYCLE_STATUS_OPTIONS = ORDER_LIFECYCLE_STATUSES.map((status) => ({
  label: status,
  value: status,
}));

const NORMALIZED_CANONICAL_STATUSES = new Map(
  ORDER_LIFECYCLE_STATUSES.map((status) => [orderLifecycleStatusKey(status), status] as const),
);

export function canonicalOrderLifecycleStatus(value: unknown): OrderLifecycleStatus | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  return NORMALIZED_CANONICAL_STATUSES.get(orderLifecycleStatusKey(value));
}

export function requireOrderLifecycleStatus(value: unknown, context: string): OrderLifecycleStatus {
  const status = canonicalOrderLifecycleStatus(value);
  if (!status) {
    throw new Error(`${context}: status must be one of ${ORDER_LIFECYCLE_STATUSES.join(', ')}.`);
  }
  return status;
}

export function orderLifecycleStatusColor(value: unknown, variant: OrderLifecycleColorVariant = 'default') {
  const status = canonicalOrderLifecycleStatus(value);
  if (!status) return 'default';
  const metadata = ORDER_LIFECYCLE_STATUS_METADATA[status];
  return variant === 'supplier' ? metadata.supplierColor : metadata.color;
}

export function isBeforeOrderedLifecycleStatus(value: unknown) {
  const status = canonicalOrderLifecycleStatus(value);
  return Boolean(status && ORDER_LIFECYCLE_STATUS_METADATA[status].stage === 'before_ordered');
}

export function isAfterOrderedLifecycleStatus(value: unknown) {
  const status = canonicalOrderLifecycleStatus(value);
  return Boolean(status && ORDER_LIFECYCLE_STATUS_METADATA[status].stage === 'after_ordered');
}

export function isCompleteLifecycleStatus(value: unknown) {
  const status = canonicalOrderLifecycleStatus(value);
  return Boolean(status && ORDER_LIFECYCLE_STATUS_METADATA[status].complete);
}

function orderLifecycleStatusKey(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}
