# Baseline known failures

## `integration.test.ts`

Exit code: 1

The existing integration seam fails before greenfield changes with:

```text
SequelizeValidationError: notNull Violation: silverCompanies.companyKey cannot be null
```

Vitest also reports a secondary `RangeError: Invalid string length` while formatting the failure.

## Focused domain tests

All six focused domain test files passed individually. The repository test wrapper accepts one positional test path, so the task-plan multi-file command only executed its first path; the baseline therefore ran each file sequentially and recorded each exit code in `baseline-domain-test-exits.txt`.
