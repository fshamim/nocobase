import { Migration } from '@nocobase/server';

const ADMIN_LAYOUT_UID = 'admin-layout-model';
const ECOBASE_WORKSPACE_TITLE = 'EcoBase';
const ECOBASE_ROUTE_SCHEMA_UIDS = ['ecobase', 'ecobase-supplier-management-link'];

type DesktopRouteRecord = {
  id?: string | number;
  title?: string;
  parentId?: string | number | null;
  schemaUid?: string;
  get?: (key: string) => unknown;
};

type DesktopRouteLayoutRecord = {
  desktopRouteId?: string | number;
  uiLayoutUid?: string;
};

const getValue = (record: DesktopRouteRecord, key: keyof DesktopRouteRecord) => record.get?.(key) ?? record[key];
const routeId = (record: DesktopRouteRecord) => getValue(record, 'id');
const routeTitle = (record: DesktopRouteRecord) => String(getValue(record, 'title') ?? '');
const routeSchemaUid = (record: DesktopRouteRecord) => String(getValue(record, 'schemaUid') ?? '');
const routeParentId = (record: DesktopRouteRecord) => getValue(record, 'parentId') ?? null;

const isEcobaseRoute = (record: DesktopRouteRecord) =>
  ECOBASE_ROUTE_SCHEMA_UIDS.includes(routeSchemaUid(record)) ||
  (routeTitle(record) === ECOBASE_WORKSPACE_TITLE && routeParentId(record) === null);

const tableName = (table: unknown) => {
  if (typeof table === 'string') return table;
  if (typeof table !== 'object' || table === null) return '';
  return String(
    (table as { tableName?: unknown; name?: unknown }).tableName ?? (table as { name?: unknown }).name ?? '',
  );
};

export default class extends Migration {
  on = 'afterSync';
  appVersion = '<2.2.0';

  async up() {
    const tables = await this.db.sequelize.getQueryInterface().showAllTables();
    if (!tables.map(tableName).includes('desktopRoutesUiLayouts')) return;

    const routes = ((await this.db.getRepository('desktopRoutes').find({})) as DesktopRouteRecord[]).filter(
      isEcobaseRoute,
    );
    if (!routes.length) {
      throw new Error('Ecobase desktop-layout migration failed: missing EcoBase desktop route.');
    }

    await this.db.sequelize.transaction(async (transaction) => {
      const [existingRows] = await this.db.sequelize.query(
        'select "desktopRouteId", "uiLayoutUid" from "desktopRoutesUiLayouts" where "uiLayoutUid" = :uiLayoutUid',
        { replacements: { uiLayoutUid: ADMIN_LAYOUT_UID }, transaction },
      );
      const existingRouteIds = new Set(
        (existingRows as DesktopRouteLayoutRecord[]).map((row) => String(row.desktopRouteId)),
      );
      const now = new Date();
      const rows = routes
        .map((route) => routeId(route))
        .filter((id): id is string | number => id !== null && id !== undefined && !existingRouteIds.has(String(id)))
        .map((id) => ({
          createdAt: now,
          updatedAt: now,
          desktopRouteId: id,
          uiLayoutUid: ADMIN_LAYOUT_UID,
        }));

      if (rows.length) {
        await this.db.sequelize.getQueryInterface().bulkInsert('desktopRoutesUiLayouts', rows, { transaction });
      }
    });
  }
}
