/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { Migration } from '@nocobase/server';

export const ECOBASE_OPERATOR_ROLE = {
  name: 'operator',
  title: 'EcoBase Operator',
  description: 'May perform approved EcoBase operational mutations but not imports, repairs, settings, or refreshes.',
  strategy: { actions: ['view:own'] },
  default: false,
  hidden: false,
  allowConfigure: false,
  allowNewMenu: false,
} as const;

export default class extends Migration {
  declare db: any;
  on = 'afterSync';
  appVersion = '<2.2.0';

  async up() {
    const roles = this.db.getRepository('roles');
    if (await roles.findOne({ filterByTk: ECOBASE_OPERATOR_ROLE.name })) return;
    await roles.create({ values: ECOBASE_OPERATOR_ROLE });
  }
}
