# Inbound Monitoring and Amazon Receipt Reconciliation Plan

Status: proposed for review  
Date: 2026-07-12  
Scope: EcoBase Inventory Planning, ClickUp order-status imports, Sellerboard inventory imports, Silver order evidence, and Gold command-center panes

## 1. Problem

EcoBase currently maps the exact ClickUp status `inbound-monitoring` to the canonical status `shipped_inbound`. Inventory Planning treats that canonical status as active purchased-pipeline coverage until ClickUp later reports a closed status.

That does not match this client's workflow:

- the supplier has already shipped the inventory to Amazon;
- the operations team uses `inbound-monitoring` to watch for Amazon to acknowledge the stock;
- the team commonly leaves the ClickUp task in `inbound-monitoring` after the stock is visible;
- Sellerboard, rather than ClickUp, is the authority for whether Amazon has acknowledged the inventory.

The result is that tiered families approaching OOS can remain hidden in Active Orders because old `inbound-monitoring` quantities continue to count as open order coverage.

The source-status audit found:

- `inbound-monitoring` precedes a later same-family order in 350/537 family-order occurrences (65.2%);
- explicit `complete` precedes a later same-family order in 425/601 occurrences (70.7%);
- the median time to the next order is 29 days for `inbound-monitoring` and 31 days for `complete`;
- the latest family-linked main order marked `complete` is dated 2026-04-20;
- 18 tiered families inside the 45-day target-cover window are currently routed to Active Orders, including 9 whose selected exact ClickUp status is `inbound-monitoring`;
- all 18 lack expected-arrival dates.

Source data is intact: the original ClickUp CSV, Bronze records, and Silver status evidence have zero status mismatches. This is a lifecycle interpretation problem, not an import problem.

## 2. Goals

1. Preserve the exact ClickUp status and its evidence without rewriting source truth.
2. Represent `inbound-monitoring` as its own operational stage.
3. Use preferred Sellerboard inventory snapshots as the authority that Amazon has acknowledged stock.
4. Reconcile receipt at company + Amazon account + product-family + order-line scope.
5. Stop Sellerboard-confirmed or superseded inbound orders from contributing open-order coverage.
6. Keep every tiered family approaching OOS visible with a relative OOS badge and a clear action.
7. Make future ClickUp and Sellerboard imports idempotently recompute only affected orders and families.
8. Preserve operator overrides and an auditable explanation for every derived transition.

## 3. Non-goals

- Do not update ClickUp tasks from EcoBase in this slice.
- Do not replace exact ClickUp labels with EcoBase labels.
- Do not infer receipt from a stock value that was already present before inbound monitoring.
- Do not classify `ordered`, `prep-in-progress`, `direct-ship-fba`, or `in transit to prep` as completed.
- Do not create a second inventory or order model outside the existing Silver and Gold layers.
- Do not run imports, reconciliation, or backfill implicitly during schema migration.

## 4. Domain model

### 4.1 Separate source status from receipt state

An order must expose three independent concepts:

```text
sourceOperationalStatus  = exact ClickUp label
canonicalLifecycleStatus = normalized EcoBase lifecycle
amazonReceiptStatus      = evidence that Amazon has acknowledged the ordered product
```

Example:

```text
sourceOperationalStatus  = inbound-monitoring
canonicalLifecycleStatus = shipped_inbound
amazonReceiptStatus      = awaiting_amazon_stock
```

After Sellerboard observes the stock:

```text
sourceOperationalStatus  = inbound-monitoring
canonicalLifecycleStatus = shipped_inbound
amazonReceiptStatus      = amazon_stock_observed
```

The ClickUp value remains unchanged. Inventory coverage uses `amazonReceiptStatus`, not the stale source label alone.

### 4.2 Receipt states

Use a small explicit state set:

| State | Meaning | Counts as open supplier-order coverage |
|---|---|---|
| `not_applicable` | Order has not reached inbound monitoring | Determined by existing pre-inbound lifecycle |
| `awaiting_amazon_stock` | Exact status is inbound monitoring; no receipt evidence yet | Yes, but only in the Inbound Monitoring pane |
| `partially_observed` | At least one order line/family has Amazon evidence | Only for unobserved lines |
| `amazon_stock_observed` | All mapped material lines have Amazon evidence | No |
| `completed_by_later_inbound` | A later same-family order reached inbound monitoring | No |
| `review_required` | Evidence is missing, contradictory, or unmapped | No silent coverage; show review state |

Receipt state must be monotonic. A later CSV containing `inbound-monitoring` must not reopen `amazon_stock_observed` or `completed_by_later_inbound`. Only an explicit operator action may reopen it.

### 4.3 Evidence precedence

For effective coverage, apply:

1. operator receipt override;
2. Sellerboard Amazon-stock evidence;
3. later same-family order reaching inbound monitoring;
4. exact ClickUp status mapping;
5. unresolved/review-required state.

The existing ClickUp operator-status override continues to control source lifecycle status. Receipt overrides remain separate because correcting a receipt does not mean rewriting the ClickUp task status.

## 5. Command-center panes

The command center should route one family action row to one primary pane while preserving secondary risk flags.

### 5.1 Supply Action — no reliable replenishment

Show a family when:

- it is a replenishment target;
- it is live and tier A/B/C;
- trusted velocity is positive;
- it is approaching OOS under the agreed threshold;
- it has no reliable pre-inbound order and no `awaiting_amazon_stock` inbound order;
- it is not routed to Stuck & Excess.

The primary visual signal is a relative badge such as `OOS in 3 days`, `OOS today`, or `OOS overdue`.

Missing supplier is a supply-action substate. It may remain a separate card for operator workflow, but it must share the same eligibility contract and relative OOS presentation.

### 5.2 Active Orders — before Amazon handoff

Show families whose reliable latest order is in a pre-inbound stage:

- `ordered`;
- `approved-to-order`;
- `in progress`;
- `prep-in-progress`;
- `direct-ship-fba`;
- `in transit to prep`;
- other configured placed/purchased statuses that have not reached inbound monitoring.

Show exact status, canonical status, status source, open quantity, ETA evidence, OOS gap, and status freshness.

### 5.3 Inbound Monitoring — awaiting Amazon evidence

Show one family row when at least one mapped line is `awaiting_amazon_stock` or `partially_observed`.

Required columns:

- family/ASIN and target SKU;
- company and Amazon account/marketplace;
- exact ClickUp status and order reference;
- ordered/open quantity;
- Amazon-visible baseline quantity;
- current Amazon-visible quantity;
- observed receipt quantity;
- days in inbound monitoring;
- latest ClickUp activity;
- expected arrival when present;
- relative OOS badge;
- recommended action: monitor, investigate, expedite, or place next order.

An inbound family approaching OOS remains in this pane with high-severity styling. The pane must not hide urgency merely because an inbound order exists.

### 5.4 Healthy / Active Selling

Show live target families that:

- have Sellerboard-visible stock;
- are not approaching OOS;
- have no immediate order, receipt, supplier, or stuck action.

This pane is collapsed by default, paginated, and searchable because it will contain most families.

### 5.5 Stuck & Excess

Preserve existing family-level Stuck & Excess classification. A stuck row may carry inbound-monitoring evidence as a secondary flag, but it remains in Stuck & Excess when that action is more important.

### 5.6 Primary routing order

```text
stuck/excess
→ inbound monitoring
→ active pre-inbound order
→ supply action
→ healthy/active selling
```

Secondary flags such as `oosSoon`, `missingSupplier`, `statusStale`, and `receiptEvidenceMissing` remain available in every pane.

## 6. Amazon-visible inventory evidence

### 6.1 Identity boundary

Receipt evidence must match:

```text
company
+ Amazon account
+ marketplace
+ canonical ASIN family
+ mapped order line
```

Never match solely by ASIN across companies or accounts. Use the existing company-product family and order-line foreign keys.

### 6.2 Amazon-visible stock

Use preferred Sellerboard snapshots and the existing source-precedence policy. For receipt reconciliation, define Amazon-visible stock from buckets controlled or acknowledged by Amazon:

```text
amazonVisibleStock = FBA sellable + reserved + inbound + AWD
```

Exclude supplier-side `ordered` and `prep` buckets from receipt evidence. Confirm the final AWD treatment against the current Sellerboard payload before implementation; if AWD is not part of the applicable fulfillment path, omit it.

### 6.3 Baseline capture

When a mapped line first enters exact `inbound-monitoring`:

1. select the latest trusted Sellerboard snapshot at or before the transition observation time;
2. persist the snapshot ID/date and family bucket values;
3. persist the order-line open quantity;
4. record the ClickUp task/import evidence that caused the transition.

If no baseline exists, set `review_required`; do not treat already-positive current stock as a new receipt.

### 6.4 Receipt calculation

For each later trusted snapshot:

```text
netAmazonIncrease = currentAmazonVisibleStock - baselineAmazonVisibleStock
trustedSalesSinceBaseline = trusted listing units sold after the baseline
observedAddition = max(0, netAmazonIncrease + trustedSalesSinceBaseline)
```

Adding trusted sales prevents stock sold after receipt from hiding an inventory increase. If trusted sales facts are unavailable, retain the raw bucket delta and mark evidence confidence as partial.

Any positive attributed addition acknowledges that line for this client's workflow. Persist the observed quantity and confidence; do not discard quantity evidence merely because the operational pane transition is complete.

### 6.5 Partial and multi-line orders

Reconcile at order-line/family level:

- one observed family does not complete unrelated lines in the same order;
- order receipt is `partially_observed` while any material mapped line remains unresolved;
- order receipt becomes `amazon_stock_observed` when all material mapped lines are acknowledged, rejected, cancelled, or explicitly waived;
- unmapped material lines keep the order in `review_required`.

### 6.6 Multiple inbound orders

Allocate observed additions FIFO by the order's business date, then source observation time. Do not apply one stock increase to every inbound order for a family.

Persist which snapshot quantity was allocated to which order line. Re-running reconciliation with the same snapshots must produce no additional allocation.

## 7. Consecutive-order fallback

The client-specific audit supports completing an older inbound cycle when a later same-family order reaches inbound monitoring.

For each company/account/family timeline:

1. order cycles chronologically using order date, then trusted source observation time;
2. when cycle N+1 reaches exact `inbound-monitoring`, mark unresolved cycle N as `completed_by_later_inbound`;
3. persist `supersededByOrderId`, order ref, transition time, and evidence;
4. stop cycle N from contributing open-order coverage;
5. do not mutate its exact ClickUp status.

A newly created or merely `ordered` later order is not sufficient for automatic completion. It may add a `laterOrderExists` warning for operator review.

## 8. Persistence changes

Prefer a deep reconciliation service with a small query surface. Avoid a parallel model.

### 8.1 Silver order-line receipt fields

Add queryable scalar fields to `silverOrderLines`:

- `amazonReceiptStatus`;
- `amazonReceiptObservedQty`;
- `amazonReceiptBaselineAt`;
- `amazonReceiptObservedAt`;
- `amazonReceiptCompletionReason`;
- `amazonReceiptEvidenceJson`.

The evidence JSON contains snapshot IDs, bucket baselines/deltas, trusted sales adjustment, ClickUp task/import IDs, allocation details, and confidence. Scalar state/date/quantity fields support filtering and indexes.

### 8.2 Silver order aggregate fields

Add to `silverOrders`:

- `amazonReceiptStatus`;
- `amazonReceiptObservedAt`;
- `amazonReceiptCompletionReason`;
- `amazonReceiptEvidenceJson`.

These are derived aggregates of order-line state and must only be written by the reconciler or explicit operator action.

### 8.3 Gold projections

Project the following into Gold inventory and order planning rows:

- exact ClickUp operational status;
- `amazonReceiptStatus`;
- receipt baseline/observed dates;
- receipt observed quantity;
- completion reason and compact evidence;
- days in inbound monitoring;
- inbound-monitoring stale flag;
- relative OOS days/badge contract;
- effective coverage quantity after receipt reconciliation.

Do not use receipt-completed quantities in `supplierOrderOpenQty` or open-order coverage.

### 8.4 Audit

Use the existing activity/audit approach to record:

- automatic baseline capture;
- Sellerboard receipt observation;
- later-inbound completion;
- operator confirm/reopen/waive actions;
- old and new receipt states;
- actor/import run/source snapshot evidence.

## 9. Reconciliation module

Create one server-side module owned by Inventory Planning, for example:

```text
features/inventory-planning/server/order-receipt-reconciliation-service.ts
```

Public operations:

- `reconcileAffectedOrders({ companyId, familyIds, orderIds, importRunId })`;
- `previewBackfill(...)`;
- `applyBackfill(...)`;
- operator `confirmReceipt`, `reopenReceipt`, and `waiveLine` actions.

The module owns:

- exact-status interpretation;
- baseline selection;
- Sellerboard snapshot comparison;
- sales-adjusted receipt evidence;
- FIFO allocation;
- later-inbound fallback;
- order aggregate state;
- affected-family Gold refresh.

Import adapters only normalize source data and call the module after their transaction succeeds. They must not duplicate receipt rules.

## 10. Import integration

### 10.1 ClickUp CSV

After a successful status upsert:

1. collect affected order IDs;
2. commit the import transaction;
3. invoke receipt reconciliation for those orders/families;
4. capture baselines for newly inbound lines;
5. apply later-inbound completion;
6. refresh only affected Gold rows;
7. add reconciliation counts/warnings to the import-run summary.

A repeated identical CSV must produce zero new transitions and zero duplicate audit events.

A future CSV still reporting `inbound-monitoring` must not reopen Sellerboard-confirmed receipt state.

### 10.2 Sellerboard API/CSV

After preferred inventory snapshots are normalized:

1. collect affected company/account/family IDs;
2. commit the import transaction;
3. reconcile awaiting inbound order lines against the new snapshots;
4. refresh affected Gold rows;
5. report observed, partial, completed, and review-required counts.

Sellerboard import failure must not change receipt state.

### 10.3 Manual action

Expose a permission-protected preview and apply action for operators and controlled staging backfills. Preview returns proposed transitions and evidence without writes.

## 11. Backfill

Do not set all existing inbound orders to complete.

### Phase A — dry-run reconstruction

For each current or historical exact `inbound-monitoring` order:

1. resolve mapped company/account/families;
2. select the nearest trusted snapshot at or before order date/task observation;
3. scan later snapshots for Amazon-visible additions;
4. apply trusted sales adjustment where available;
5. find later same-family inbound cycles;
6. classify proposed state and confidence;
7. emit a review artifact with before/after coverage and pane changes.

### Phase B — controlled apply

After review and database backup:

- apply high-confidence Sellerboard evidence;
- apply later-inbound completion;
- leave missing-baseline, unmapped, conflicting, or low-confidence rows in `review_required`;
- refresh Gold once after the batch;
- rerun semantic-link and family-rollup verification.

Backfill must be resumable and idempotent by order-line/evidence key.

## 12. UI behavior

### 12.1 Inbound Monitoring pane

Add a dedicated expandable card using existing command-center and FormulaHelp patterns. Do not add a one-off help system.

Default sort:

1. OOS overdue/today;
2. smallest `daysUntilOos`;
3. longest time in inbound monitoring;
4. largest money/profit risk.

Filters:

- company;
- tier;
- OOS window;
- receipt state;
- evidence confidence;
- stale activity;
- supplier/order reference.

### 12.2 Row drawer

Show:

- complete family order timeline;
- exact ClickUp and canonical statuses;
- source task and import run;
- baseline and observed Sellerboard snapshots;
- stock bucket changes;
- trusted sales adjustment;
- FIFO allocation;
- completion/supersession reason;
- operator audit history.

### 12.3 Relative OOS badge

Use the existing `daysUntilOos` field:

- negative: `OOS overdue by N days`;
- zero: `OOS today`;
- positive: `OOS in N days`;
- unavailable: `OOS date unavailable` with explicit data-quality reason.

Keep the absolute date as secondary text/tooltip.

### 12.4 Healthy pane

Keep collapsed by default with server-side pagination. This is a visibility/reference pane, not a new action queue.

## 13. Tests

### 13.1 Unit tests

Cover:

- exact status enters inbound and captures one baseline;
- repeated ClickUp import is idempotent;
- existing positive stock without post-baseline increase is not receipt evidence;
- Amazon-visible bucket increase produces receipt evidence;
- bucket transfer with unchanged Amazon-visible total does not double count;
- sales-adjusted addition detects receipt despite simultaneous sales;
- partial multi-line receipt leaves order partial;
- FIFO allocation does not complete multiple orders from one quantity;
- later inbound order completes the earlier same-family cycle;
- merely ordered later cycle does not complete the earlier cycle;
- operator override wins and is not overwritten;
- missing mapping/baseline becomes `review_required` with an explicit reason;
- completed receipt state never regresses on CSV re-import.

### 13.2 Integration tests

Cover:

- ClickUp import → baseline/reconciliation → affected Gold refresh;
- Sellerboard import → receipt observation → affected Gold refresh;
- source transaction failure produces no receipt writes;
- order containing multiple families reconciles lines independently;
- company/account boundary prevents cross-company ASIN matching;
- schema migration preserves existing order/status evidence;
- API permissions protect preview/apply/operator actions.

### 13.3 Command-center tests

Cover routing precedence and counts for:

- supply action without order;
- pre-inbound active order;
- awaiting inbound monitoring;
- Sellerboard-completed inbound order moving to healthy or supply action according to current stock risk;
- inbound OOS urgency remaining visible;
- stuck/excess retaining primary routing;
- missing supplier substate;
- relative OOS badge labels.

### 13.4 Regression fixtures

Include known client timelines:

- Retail Heaven `B0DJRRG8JS` repeated inbound-monitoring chain;
- Muxtex `B00CTU52K2` stale approval order superseded by later completed cycles;
- Ecofission `B01HXMCMZI` inbound order followed by a cancelled later cycle;
- family with partial/multiple order-line receipt;
- family with no historical baseline.

## 14. Verification and acceptance

### Data invariants

- exact ClickUp status remains unchanged by receipt reconciliation;
- one snapshot allocation cannot exceed its available observed addition;
- one order-line allocation belongs to the same company/account/family;
- receipt-completed quantities do not contribute to open-order coverage;
- no receipt state regresses without operator action;
- family stock and velocity rollups remain unchanged by status-only reconciliation;
- semantic-link errors remain zero.

### Live-gate acceptance

1. Original ClickUp CSV and Bronze remain identical.
2. Re-importing the same ClickUp CSV creates no duplicate transitions.
3. The nine currently selected `inbound-monitoring` OOS families route to Inbound Monitoring rather than generic Active Orders.
4. `B0DJRRG8JS` shows its repeated order timeline and `OOS in 3 days` urgency.
5. A controlled Sellerboard snapshot increase moves the mapped line out of awaiting state with stored evidence.
6. A later same-family order reaching inbound monitoring completes the previous inbound cycle.
7. Ordered/prep orders remain active.
8. Healthy families appear in the collapsed Healthy / Active Selling pane.
9. Focused tests, ESLint, plugin build, semantic verification, and browser QA pass.

### Staging acceptance

- take and verify a staging PostgreSQL backup first;
- deploy schema/code without reset or import;
- run backfill preview and compare counts to live-gate evidence;
- apply only after preview approval;
- import one unchanged ClickUp CSV and confirm idempotency;
- run one Sellerboard refresh and verify receipt transitions;
- verify Inventory Planning pane counts, relative OOS badges, drawers, and audit evidence;
- leave production untouched until staging results are approved.

## 15. Implementation sequence

1. Add receipt-state schema fields and migrations.
2. Implement the pure receipt-state transition/evidence functions with unit tests.
3. Implement the reconciliation service and order/family scoping.
4. Add Sellerboard baseline/delta and sales-adjusted evidence.
5. Add FIFO allocation and multi-line order aggregation.
6. Add later-inbound fallback.
7. Project receipt fields into Gold and remove completed receipt quantities from open coverage.
8. Add command-center pane routing and relative OOS contract.
9. Add Inbound Monitoring and Healthy / Active Selling UI cards using existing shared patterns.
10. Integrate post-success ClickUp and Sellerboard import hooks.
11. Add preview/apply and operator receipt actions with ACL/audit.
12. Build and review backfill dry-run artifacts.
13. Run live-gate acceptance.
14. Prepare staging backup, deploy, controlled backfill, import verification, and browser QA.

## 16. Review decisions before implementation

1. Confirm whether AWD belongs in Amazon-visible receipt stock for every fulfillment route.
2. Confirm that any positive attributed addition acknowledges a line, while quantity remains visible for partial-receipt review.
3. Confirm stale inbound escalation threshold; recommended default is the existing purchased-pipeline grace setting rather than another setting.
4. Confirm Stuck & Excess remains higher primary routing priority than Inbound Monitoring.
5. Confirm `direct-ship-fba` remains active until separate evidence supports terminal treatment.
