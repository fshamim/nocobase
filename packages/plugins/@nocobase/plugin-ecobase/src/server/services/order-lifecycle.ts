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

export interface OrderLifecycleResolution {
  canonicalStatus: OrderLifecycleStatus;
  statusSource: string;
  statusCheckRequired: boolean;
  statusEvidence: Record<string, unknown>;
}

export interface ResolveOrderLifecycleParams {
  canonicalStatus?: string;
  lifecycleStatus?: string;
  lifecyclePhase?: string;
  statusSource?: string;
  operatorStatusOverrideAt?: string;
  existingStatusCheckRequired?: boolean;
  sourceOrderStatus?: string;
  paymentStatus?: string;
  invoiceStatus?: string;
  poApproval?: string;
  prepStatus?: string;
  orStatus?: string;
  remarks?: string;
  dateOfPayment?: string;
  orderDate?: string;
  trackingId?: string;
  shippingCarrier?: string;
  hasLaterSameProductOrder?: boolean;
  inboundStock?: number;
  reservedStock?: number;
  sellableStock?: number;
  receivedQty?: number;
}

const NORMALIZED_CANONICAL_STATUSES = new Map(
  ORDER_LIFECYCLE_STATUSES.map((status) => [statusKey(status), status] as const),
);

export function canonicalOrderLifecycleStatus(value: unknown): OrderLifecycleStatus | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  return NORMALIZED_CANONICAL_STATUSES.get(statusKey(value));
}

export function requireOrderLifecycleStatus(value: unknown, context: string): OrderLifecycleStatus {
  const status = canonicalOrderLifecycleStatus(value);
  if (!status) {
    throw new Error(`${context}: status must be one of ${ORDER_LIFECYCLE_STATUSES.join(', ')}.`);
  }
  return status;
}

export function resolveOrderLifecycle(params: ResolveOrderLifecycleParams): OrderLifecycleResolution {
  const operatorStatus = operatorOverrideStatus(params);
  const importedCanonical = canonicalOrderLifecycleStatus(params.canonicalStatus);
  const sourceStatus = params.sourceOrderStatus ?? params.lifecycleStatus ?? params.lifecyclePhase;
  const sourceCompleted = hasAny(sourceStatus, ['complete', 'completed']);
  const historical = isOlderThanDays(params.orderDate, 90);
  const evidence = evidenceFor(params, sourceStatus);

  if (operatorStatus) {
    return resolved(operatorStatus, 'operator', false, evidence);
  }

  if (
    params.hasLaterSameProductOrder &&
    (sourceCompleted || hasPaidEvidence(params) || hasClearInvoiceEvidence(params))
  ) {
    return resolved('COMPLETE', 'source_history', false, evidence);
  }

  if (historical && (hasPaidEvidence(params) || hasClearInvoiceEvidence(params))) {
    return resolved('COMPLETE', 'historical_invoice_evidence', false, evidence);
  }

  if (hasClosedSourceEvidence(sourceStatus)) {
    return resolved('COMPLETE', historical ? 'historical_source_closed' : 'source_closed', false, evidence);
  }

  if (params.hasLaterSameProductOrder) {
    return resolved(
      'COMPLETE',
      historical ? 'historical_successor_evidence' : 'successor_order_evidence',
      false,
      evidence,
    );
  }

  if (historical && hasHistoricalAgingStatus(sourceStatus)) {
    return resolved('COMPLETE', 'historical_age_evidence', false, evidence);
  }

  if (hasCompleteEvidence(params)) {
    return resolved('COMPLETE', 'fulfillment_evidence', false, evidence);
  }

  if (hasInboundEvidence(params)) {
    return resolved('INBOUND MONITORING', 'fulfillment_evidence', false, evidence);
  }

  if (hasAny(params.prepStatus, ['not started', 'not-started'])) {
    return resolved('AT PREP NOT STARTED', 'prep_evidence', false, evidence);
  }

  if (hasAny(params.prepStatus, ['prep in progress', 'prep-in-progress', 'in progress'])) {
    return resolved('PREP IN-PROGRESS', 'prep_evidence', false, evidence);
  }

  if (hasAny(sourceText(params), ['shipped to fba', 'sent to fba'])) {
    return resolved('SHIPPED TO FBA', 'shipping_evidence', false, evidence);
  }

  if (hasAny(sourceText(params), ['direct ship fba', 'direct ship to fba', 'direct fba'])) {
    return resolved('DIRECT SHIP FBA', 'shipping_evidence', false, evidence);
  }

  if (hasAny(sourceText(params), ['in transit to prep', 'transit to prep'])) {
    return resolved('IN TRANSIT TO PREP', 'shipping_evidence', false, evidence);
  }

  if (hasAny(sourceText(params), ['ship', 'tracking', 'carrier']) || params.trackingId || params.shippingCarrier) {
    return resolved('SHIPPED TO FBA', 'shipping_evidence', false, evidence);
  }

  if (hasPaidEvidence(params)) {
    return resolved(
      'ORDERED',
      'payment_evidence',
      sourceCompleted || Boolean(params.existingStatusCheckRequired),
      evidence,
    );
  }

  if (sourceCompleted) {
    return resolved('ORDERED', 'source_status_review', true, evidence);
  }

  if (importedCanonical && importedCanonical !== 'COMPLETE') {
    return resolved(
      importedCanonical,
      params.statusSource ?? 'stored',
      Boolean(params.existingStatusCheckRequired),
      evidence,
    );
  }

  if (hasAny(params.poApproval, ['approved']) || hasAny(sourceStatus, ['approved'])) {
    return resolved('APPROVED TO ORDER', 'approval_evidence', false, evidence);
  }

  if (hasAny(sourceStatus, ['analysing', 'analyzing', 'analysis', 'cleared'])) {
    return resolved('ORDER ANALYSING', 'analysis_evidence', false, evidence);
  }

  return resolved('IN-PROGRESS', 'fallback', true, evidence);
}

function operatorOverrideStatus(params: ResolveOrderLifecycleParams) {
  if (params.statusSource !== 'operator' && !params.operatorStatusOverrideAt) return undefined;
  return requireOrderLifecycleStatus(
    params.canonicalStatus ?? params.lifecycleStatus,
    'Ecobase order lifecycle operator override failed',
  );
}

function resolved(
  canonicalStatus: OrderLifecycleStatus,
  statusSource: string,
  statusCheckRequired: boolean,
  statusEvidence: Record<string, unknown>,
): OrderLifecycleResolution {
  return { canonicalStatus, statusSource, statusCheckRequired, statusEvidence };
}

function evidenceFor(params: ResolveOrderLifecycleParams, sourceOrderStatus?: string) {
  return {
    sourceOrderStatus,
    paymentStatus: params.paymentStatus,
    invoiceStatus: params.invoiceStatus,
    poApproval: params.poApproval,
    prepStatus: params.prepStatus,
    orStatus: params.orStatus,
    remarks: params.remarks,
    dateOfPayment: params.dateOfPayment,
    orderDate: params.orderDate,
    trackingId: params.trackingId,
    shippingCarrier: params.shippingCarrier,
    hasLaterSameProductOrder: params.hasLaterSameProductOrder,
    inboundStock: params.inboundStock,
    reservedStock: params.reservedStock,
    sellableStock: params.sellableStock,
    receivedQty: params.receivedQty,
  };
}

function hasPaidEvidence(params: ResolveOrderLifecycleParams) {
  return Boolean(params.dateOfPayment) || hasAny(params.paymentStatus, ['completed', 'complete', 'paid']);
}

function hasClearInvoiceEvidence(params: ResolveOrderLifecycleParams) {
  return hasAny(params.invoiceStatus, ['uploaded', 'completed', 'complete', 'cleared', 'clear', 'paid']);
}

function hasClosedSourceEvidence(value: unknown) {
  return hasAny(value, ['cancelled', 'canceled', 'rejected', 'not added to po']);
}

function hasHistoricalAgingStatus(value: unknown) {
  return hasAny(value, ['in progress', 'oos', 'added to po', 'imported']);
}

function hasInboundEvidence(params: ResolveOrderLifecycleParams) {
  return (
    positive(params.inboundStock) > 0 ||
    positive(params.reservedStock) > 0 ||
    hasAny(sourceText(params), ['inbound monitoring', 'inbound', 'reserved', 'reached fba', 'reached amazon'])
  );
}

function hasCompleteEvidence(params: ResolveOrderLifecycleParams) {
  return (
    positive(params.sellableStock) > 0 ||
    positive(params.receivedQty) > 0 ||
    hasAny(sourceText(params), ['sellable', 'received into inventory', 'available in inventory', 'fba complete'])
  );
}

function sourceText(params: ResolveOrderLifecycleParams) {
  return [
    params.sourceOrderStatus,
    params.lifecycleStatus,
    params.lifecyclePhase,
    params.paymentStatus,
    params.invoiceStatus,
    params.poApproval,
    params.prepStatus,
    params.orStatus,
    params.remarks,
  ]
    .filter(Boolean)
    .join(' ');
}

function hasAny(value: unknown, terms: string[]) {
  if (typeof value !== 'string') return false;
  const normalized = value.toLowerCase();
  return terms.some((term) => normalized.includes(term));
}

function positive(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

function isOlderThanDays(value: unknown, days: number) {
  if (typeof value !== 'string' || !value.trim()) return false;
  const time = new Date(`${value.slice(0, 10)}T00:00:00.000Z`).getTime();
  if (!Number.isFinite(time)) return false;
  return Date.now() - time >= days * 86_400_000;
}

function statusKey(value: string) {
  return value
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim();
}
