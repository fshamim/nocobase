# Ecobase refactor verification gate — 2026-07-03

Run this gate after every architecture-refactor slice. Keep the gate small; add focused checks only when the slice touches that feature.

## Always run from `nocobase/`

```bash
yarn build @nocobase/plugin-ecobase

python3 - <<'PY'
from pathlib import Path
removed = [
  'AccuracyHarnessPage',
  'AiEvidencePage',
  'AlertEvaluationPage',
  'CollectionsWorkspacePage',
  'ManagementDashboardPage',
  'OrderManagementPage',
  'ReportPreviewPage',
]
text = '\n'.join(p.read_text(errors='ignore') for p in Path('packages/plugins/@nocobase/plugin-ecobase/src').rglob('*') if p.is_file())
for name in removed:
    assert name not in text, f'legacy page reference returned: {name}'
print('legacy page reference scan passed')
PY
```

## Slice-specific checks

- Route/resource slice: scan `src/client/plugin.tsx`, `src/server/plugin.ts`, and any feature registration module for unchanged live route/resource names.
- Move-only feature-folder slice: build, run a source import scan for stale old paths, and run the feature's focused server tests.
- Behavior-deepening slice: add or update one focused test at the module interface before changing behavior.
- UI slice: run the live Docker/browser QA gate if the visible page, route, or menu changed.

## Known unrelated failure

Do not claim the full integration seam test passes until task #24 is fixed. Current known failure:

```text
/ecobasePlanning:listDuplicateMappings -> ecobasePlanning resource does not exist
```

This failure predates the architecture refactor and is not caused by client-page cleanup or feature-folder moves.
