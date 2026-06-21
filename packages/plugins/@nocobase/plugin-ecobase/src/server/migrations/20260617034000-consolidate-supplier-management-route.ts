import { Migration } from '@nocobase/server';

type DesktopRouteRecord = {
  id?: string | number;
  title?: string;
  parentId?: string | number | null;
  schemaUid?: string;
  get?: (key: string) => unknown;
};

const ECOBASE_WORKSPACE_TITLE = 'EcoBase';
const SUPPLIER_MANAGEMENT_TITLE = 'Supplier Management';
const SUPPLIER_MANAGEMENT_SCHEMA_UID = 'ecobase-supplier-management-link';
const OBSOLETE_MODERN_GROUP_TITLE = 'EcoBase Modern Pages';

const getValue = (record: DesktopRouteRecord, key: keyof DesktopRouteRecord) => record.get?.(key) ?? record[key];
const routeId = (record: DesktopRouteRecord) => getValue(record, 'id');
const routeTitle = (record: DesktopRouteRecord) => String(getValue(record, 'title') ?? '');
const routeParentId = (record: DesktopRouteRecord) => getValue(record, 'parentId') ?? null;
const routeSchemaUid = (record: DesktopRouteRecord) => String(getValue(record, 'schemaUid') ?? '');

export default class extends Migration {
  on = 'afterSync';
  appVersion = '<2.2.0';

  async up() {
    const desktopRoutesRepo = this.db.getRepository('desktopRoutes');
    const routes = (await desktopRoutesRepo.find({})) as DesktopRouteRecord[];
    const workspaceRoute = routes.find(
      (route) => routeTitle(route) === ECOBASE_WORKSPACE_TITLE && routeParentId(route) === null,
    );
    const workspaceRouteId = workspaceRoute ? routeId(workspaceRoute) : null;
    if (workspaceRouteId === undefined || workspaceRouteId === null) {
      throw new Error('Ecobase supplier management route consolidation failed: EcoBase workspace route was not found.');
    }

    const obsoleteGroupIds = new Set(
      routes
        .filter((route) => routeTitle(route) === OBSOLETE_MODERN_GROUP_TITLE && routeParentId(route) === null)
        .map((route) => routeId(route))
        .filter((id) => id !== undefined && id !== null)
        .map(String),
    );

    for (const route of routes) {
      const currentRouteId = routeId(route);
      if (currentRouteId === undefined || currentRouteId === null) {
        continue;
      }
      const belongsToObsoleteGroup =
        obsoleteGroupIds.has(String(currentRouteId)) || obsoleteGroupIds.has(String(routeParentId(route)));
      const isObsoleteSupplierPage =
        routeTitle(route) === SUPPLIER_MANAGEMENT_TITLE && routeSchemaUid(route) === '8cpq826s8w4';
      if (belongsToObsoleteGroup || isObsoleteSupplierPage) {
        await desktopRoutesRepo.update({
          filterByTk: currentRouteId,
          values: { hideInMenu: true, hidden: true },
        });
      }
    }

    const updatedRoutes = (await desktopRoutesRepo.find({})) as DesktopRouteRecord[];
    const supplierRoute = updatedRoutes.find(
      (route) => routeTitle(route) === SUPPLIER_MANAGEMENT_TITLE && routeParentId(route) === workspaceRouteId,
    );
    const supplierRouteValues = {
      type: 'page',
      title: SUPPLIER_MANAGEMENT_TITLE,
      parentId: workspaceRouteId,
      schemaUid: SUPPLIER_MANAGEMENT_SCHEMA_UID,
      sort: 35,
      hideInMenu: true,
      hidden: true,
      options: null,
    };

    if (supplierRoute) {
      await desktopRoutesRepo.update({ filterByTk: routeId(supplierRoute), values: supplierRouteValues });
      return;
    }

    await desktopRoutesRepo.create({ values: supplierRouteValues });
  }
}
