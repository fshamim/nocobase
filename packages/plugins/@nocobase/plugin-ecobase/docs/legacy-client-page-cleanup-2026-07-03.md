# Legacy client page cleanup — 2026-07-03

This cleanup removes unused client-only React pages that are no longer reachable from the current EcoBase workspace, plugin settings, or desktop route model.

## Deleted client pages

| File | Reason |
| --- | --- |
| `src/client/pages/AccuracyHarnessPage.tsx` | No client import, no workspace route, no settings entry, and `ecobaseAccuracy:*` is not registered/allowed. |
| `src/client/pages/AiEvidencePage.tsx` | No client import, no workspace route, no settings entry, and Issue 015 is obsolete/superseded. |
| `src/client/pages/AlertEvaluationPage.tsx` | No client import, no workspace route, no settings entry, and `ecobaseAlertEvaluation:*` is not registered/allowed. |
| `src/client/pages/CollectionsWorkspacePage.tsx` | No source references outside itself, no workspace route, no settings entry, and `ecobaseOperatorWorkspace:*` is not registered/allowed. |
| `src/client/pages/ManagementDashboardPage.tsx` | No client import, no workspace/settings entry, and the old management-dashboard desktop route is hidden by migration. |
| `src/client/pages/OrderManagementPage.tsx` | Superseded by `OrderPlanningPage.tsx`; Issue 044 explicitly marks the legacy route/page/API path obsolete. |
| `src/client/pages/ReportPreviewPage.tsx` | No client import, no workspace route, no settings entry, and Issue 012 is obsolete/superseded by Daily Operations Brief. |

## Intentionally retained

- Current reachable pages under `src/client/pages/`.
- Desktop route migrations that hide or repair legacy database route records for upgraded installs.
- Server services, collections, action factories, and tests tied to historical report, AI, accuracy, alert, dashboard, and operator-workspace work.
- `ecobaseReports:*` daily-brief actions used by `DailyOperationsBriefPage.tsx`.

Server-side cleanup should be a separate branch after this UI-only deletion passes live-gate testing.

## Live-gate checks before promotion

From the `nocobase/` repository root:

```bash
packages/plugins/@nocobase/plugin-ecobase/scripts/start-live-gate.sh
```

Verify:

1. `/admin/ecobase` loads the EcoBase workspace.
2. The EcoBase side menu shows the current pages only: Daily Operations Brief, Semantic Model, Inventory Planning, Order Planning, Supplier Management, Planning Settings, Import & Source Status.
3. Plugin settings pages still load: Ecobase BI, Ecobase data sources, Sellerboard sources, Daily brief AI settings, EcoBase planning settings.
4. No route attempts to load the deleted legacy page chunks.
5. No browser console or server log errors mention one of the deleted page component names.

Stop the gate afterwards:

```bash
packages/plugins/@nocobase/plugin-ecobase/scripts/stop-live-gate.sh
```
