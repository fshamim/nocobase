/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { Migration } from '@nocobase/server';

const ECOBASE_WORKSPACE_ROUTE_UIDS = new Set(['ecobase', 'ecobase-supplier-management-link']);

export default class extends Migration {
  declare db: any;
  on = 'afterSync';
  appVersion = '<2.2.0';

  async up() {
    const operator = await this.db.getRepository('roles').findOne({ filterByTk: 'operator' });
    if (!operator) throw new Error('Cannot assign EcoBase workspace routes: operator role does not exist.');

    const assignments = this.db.getRepository('rolesDesktopRoutes');
    const routes = await this.db.getRepository('desktopRoutes').find({});
    for (const route of routes) {
      if (!ECOBASE_WORKSPACE_ROUTE_UIDS.has(route.schemaUid)) continue;
      const values = { desktopRouteId: route.id, roleName: 'operator' };
      if (!(await assignments.findOne({ filter: values }))) await assignments.create({ values });
    }
  }
}
