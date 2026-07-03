# Ecobase server resource registration

Current server resources are registered by feature-owned `server/resource-registration.ts` modules and assembled in `src/server/plugin.ts`.

## Active resources

- `ecobaseImport`
- `ecobaseInventoryPlanning`
- `ecobasePlanningSettings`
- `ecobaseOrderPlanning`
- `ecobaseSupplierOrders`
- `ecobaseSupplierManagement`
- `ecobaseMedallionWorkflow`
- `ecobaseSilverData`
- `ecobaseReports`

Each feature module owns its resource/action factory pairing and logged-in ACL grant list. `src/server/__tests__/resource-registration.test.ts` verifies the active resource names and action/ACL alignment.

## Historical resources not registered

The following legacy resources are intentionally not registered or ACL-allowed:

- `ecobaseAccuracy`
- `ecobaseAI`
- `ecobaseDashboard`
- `ecobaseOperatorWorkspace`
- `ecobaseComparison`
- `ecobasePlanning`
- `ecobaseAlert`
- `ecobaseAccountability`

Some legacy action factories remain in `src/server/resource-actions.ts` for existing service-level tests only. They are not exposed through `PluginEcobaseServer.load()`.
