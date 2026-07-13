# Commit B round 1 fixes

- Added safe handling for source issues and source access audits; unsupported source records now fail explicitly instead of succeeding with zero rows.
- Added expired-Bronze cleanup to recurring adapter and ClickUp import lifecycles, with an import integration assertion that expired rows are deleted and current rows retained.
- Reject multi-order-ref ClickUp tasks as blocking ambiguity; retain safe single-ref evidence even before an order exists; restored `clickupStatus` and `taskOccurredAt` semantic evidence keys.
- Updated assertions for canonical projection datasets and 30-day retention.
- Full API file: 51/51 passed.
- Full CSV file regression delta: parent 17/47 passed with 30 known failures; current 18/48 passed with the exact same 30 failures, zero new failures.
- Plugin build: passed.
