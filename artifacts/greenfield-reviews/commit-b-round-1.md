# Commit B review — round 1

Reviewer fallback: bundled `reviewer` was used because the configured project `code-reviewer` could be discovered but the subagent runtime returned `Unknown agent: code-reviewer` on execution. The review child completed its analysis, but its acceptance wrapper failed on the token `unsatisfied`; findings below are the substantive output.

## Findings

1. **Blocker — boundary silently discards valid existing importer datasets.** `projectionDataset()` recognizes selected CSV shapes but is applied to every non-status adapter item. Unsupported items are counted and skipped, and focused Gate1 commands concealed full-file regressions. Fix either by scoping migration mode or handling every supported adapter dataset and issue type explicitly.
2. **Blocker — 30-day retention has no production cleanup caller.** `deleteExpiredSourceRecords()` exists but only the unit test calls it. Register a daily scheduler or invoke it from guaranteed recurring import/maintenance lifecycle with an integration test.
3. **Blocker — ClickUp evidence is not reliably exact-order scoped.** Multi-ref tasks copy comments to each ref; projection compares `task.ref` to itself; unmatched safe evidence needed for later reconciliation is dropped. Treat multi-ref tasks as review or independently select one retained ref, and retain safe unmatched evidence for late reconciliation.
4. **High — ClickUp status evidence keys changed without consumers.** Evidence emits `status` / `statusUpdatedAt`, while `reconcileAuthority()` still reads `taskOccurredAt`, and consumers expect `clickupStatus`. Preserve old semantic keys or update all consumers atomically.
5. **Gate note — run complete test files with zero unexpected skips.** Focused tests are not a regression gate.

Status: **not approved**.
