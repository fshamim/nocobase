# FS02 Order-state contract

Forward-recovery baseline: `236bb2becc4acbf7fcb5beaa859e9030332205b0`

## Authority precedence

1. An explicit operator override is authoritative until explicitly cleared.
2. Explicit canonical `COMPLETE` or source cancellation/rejection is terminal.
3. Aggregate terminal Amazon receipt evidence is terminal:
   - `amazon_stock_observed` -> `COMPLETE` from `amazon_receipt`
   - `completed_by_later_inbound` -> `COMPLETE` from `successor_receipt_evidence`
4. Current ClickUp workflow status is preserved as imported evidence after higher-authority facts.
5. Fulfillment, prep, shipping, payment, and other source evidence provide lower-authority fallbacks.
6. Age-based classification runs only with an explicit `calculationDate`; there is no runtime-clock fallback.

## Current-cycle outcomes

- Only purchased or placed-not-purchased lines with open quantity are current-cycle candidates.
- `amazon_stock_observed` and `completed_by_later_inbound` exclude a cycle from open coverage.
- `not_applicable` means receipt monitoring is not applicable; it does not close or exclude ordered/prep coverage.
- The current cycle is selected deterministically at family scope; only its line IDs and open quantity contribute coverage.
- An older cycle becomes `completed_by_later_inbound` only when the selected later cycle has trusted arrival evidence or the older cycle has aged beyond the configured grace period.
- Otherwise the older cycle is excluded from current coverage with `review_required`; later-order existence alone never completes an order.
- An order-level terminal receipt state is produced only after every material line is terminal. Mixed terminal/open evidence remains `partially_observed` or `review_required`.

## Preserved source evidence

ClickUp status, source order status, receipt status, dates, and other evidence remain in `statusEvidence`; deriving a canonical status does not overwrite their source meaning.
