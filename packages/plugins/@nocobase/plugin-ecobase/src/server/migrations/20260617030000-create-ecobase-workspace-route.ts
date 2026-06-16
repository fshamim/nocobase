import { Migration } from '@nocobase/server';

type DesktopRouteRecord = {
  id?: string | number;
  title?: string;
  parentId?: string | number | null;
  schemaUid?: string;
  options?: Record<string, unknown> | null;
  get?: (key: string) => unknown;
};

const ECOBASE_WORKSPACE_ROUTE = {
  title: 'EcoBase',
  icon: 'DatabaseOutlined',
  schemaUid: 'ecobase',
  sort: -900,
};

const LEGACY_ROUTE_TITLES = ['Ecobase Operations', 'Ecobase BI'];

const LEGACY_WORKSPACE_CHILD_SCHEMA_UIDS = [
  'ecobase-daily-operations-brief-link',
  'ecobase-inventory-planning-link',
  'ecobase-order-management-link',
  'ecobase-management-dashboard-link',
  'ecobase-import-status-link',
  'ecobase/daily-operations-brief',
  'ecobase/inventory-planning',
  'ecobase/order-management',
  'ecobase/management-dashboard',
  'ecobase/import-status',
];

const getValue = (record: DesktopRouteRecord, key: keyof DesktopRouteRecord) => record.get?.(key) ?? record[key];

const routeId = (record: DesktopRouteRecord) => getValue(record, 'id');

const routeTitle = (record: DesktopRouteRecord) => String(getValue(record, 'title') ?? '');

const routeSchemaUid = (record: DesktopRouteRecord) => String(getValue(record, 'schemaUid') ?? '');

const routeParentId = (record: DesktopRouteRecord) => getValue(record, 'parentId') ?? null;

const routeOptions = (record: DesktopRouteRecord) =>
  (getValue(record, 'options') as Record<string, unknown> | null) ?? null;

const isTopLevel = (record: DesktopRouteRecord) => routeParentId(record) === null;

const isLegacyWorkspaceChild = (record: DesktopRouteRecord) =>
  LEGACY_WORKSPACE_CHILD_SCHEMA_UIDS.includes(routeSchemaUid(record)) ||
  String(routeOptions(record)?.href ?? '').startsWith('/admin/ecobase/');

export default class extends Migration {
  on = 'afterSync';
  appVersion = '<2.2.0';

  async up() {
    const desktopRoutesRepo = this.db.getRepository('desktopRoutes');
    const routes = (await desktopRoutesRepo.find({})) as DesktopRouteRecord[];
    const existingEcoBaseRoutes = routes.filter((route) => routeTitle(route) === ECOBASE_WORKSPACE_ROUTE.title);
    const workspaceRoute = existingEcoBaseRoutes.find(isTopLevel) ?? existingEcoBaseRoutes[0] ?? null;
    const workspaceRouteValues = {
      type: 'page',
      title: ECOBASE_WORKSPACE_ROUTE.title,
      icon: ECOBASE_WORKSPACE_ROUTE.icon,
      parentId: null,
      schemaUid: ECOBASE_WORKSPACE_ROUTE.schemaUid,
      sort: ECOBASE_WORKSPACE_ROUTE.sort,
      hideInMenu: false,
      hidden: false,
      options: null,
    };

    let workspaceRouteId = workspaceRoute ? routeId(workspaceRoute) : null;
    if (workspaceRouteId === undefined) {
      workspaceRouteId = null;
    }

    if (workspaceRouteId === null) {
      const createdRoute = (await desktopRoutesRepo.create({ values: workspaceRouteValues })) as DesktopRouteRecord;
      workspaceRouteId = routeId(createdRoute) ?? null;
    } else {
      await desktopRoutesRepo.update({
        filterByTk: workspaceRouteId,
        values: workspaceRouteValues,
      });
    }

    const routesAfterWorkspaceUpdate = (await desktopRoutesRepo.find({})) as DesktopRouteRecord[];
    for (const route of routesAfterWorkspaceUpdate) {
      const currentRouteId = routeId(route);
      if (
        currentRouteId === undefined ||
        currentRouteId === null ||
        String(currentRouteId) === String(workspaceRouteId)
      ) {
        continue;
      }

      if (LEGACY_ROUTE_TITLES.includes(routeTitle(route)) || isLegacyWorkspaceChild(route)) {
        await desktopRoutesRepo.update({
          filterByTk: currentRouteId,
          values: {
            hideInMenu: true,
            hidden: true,
          },
        });
      }
    }
  }
}
