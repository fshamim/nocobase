/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import React, { useMemo, useState } from 'react';
import { Icon, lazy } from '@nocobase/client';
import { Button, Layout, Menu, Space, Typography } from 'antd';
import { useLocation, useNavigate } from 'react-router-dom';

const DailyOperationsBriefPage = lazy(
  () => import('../features/daily-operations-brief/client/DailyOperationsBriefPage'),
);
const DailyBriefPromptSettingsPage = lazy(
  () => import('../features/daily-operations-brief/client/DailyBriefPromptSettingsPage'),
);
const DataSourcesPage = lazy(() => import('../features/source-import/client/DataSourcesPage'));
const ImportStatusPage = lazy(() => import('../features/source-import/client/ImportStatusPage'));
const InventoryPlanningPage = lazy(() => import('../features/inventory-planning/client/InventoryPlanningPage'));
const OrderPlanningPage = lazy(() => import('../features/order-planning/client/OrderPlanningPage'));
const PlanningSettingsPage = lazy(() => import('./pages/PlanningSettingsPage'));
const GoldMaintenancePage = lazy(() => import('./pages/GoldMaintenancePage'));
const SellerboardSourcesPage = lazy(() => import('../features/source-import/client/SellerboardSourcesPage'));
const SilverDataPage = lazy(() => import('../features/semantic-model/client/SilverDataPage'));
const SupplierManagementPage = lazy(() => import('../features/supplier-management/client/SupplierManagementPage'));

export const ECOBASE_WORKSPACE_ROOT = '/admin/ecobase';

const ecobaseWorkspacePages = [
  {
    key: 'daily-operations-brief',
    label: 'Daily Operations Brief',
    icon: 'DashboardOutlined',
    path: `${ECOBASE_WORKSPACE_ROOT}/daily-operations-brief`,
    Component: DailyOperationsBriefPage,
  },
  {
    key: 'silver-data',
    label: 'Semantic Model',
    icon: 'DatabaseOutlined',
    path: `${ECOBASE_WORKSPACE_ROOT}/silver-data`,
    Component: SilverDataPage,
  },
  {
    key: 'inventory-planning',
    label: 'Inventory Planning',
    icon: 'InboxOutlined',
    path: `${ECOBASE_WORKSPACE_ROOT}/inventory-planning`,
    Component: InventoryPlanningPage,
  },
  {
    key: 'order-planning',
    label: 'Order Planning',
    icon: 'ShoppingCartOutlined',
    path: `${ECOBASE_WORKSPACE_ROOT}/order-planning`,
    Component: OrderPlanningPage,
  },
  {
    key: 'supplier-management',
    label: 'Supplier Management',
    icon: 'TeamOutlined',
    path: `${ECOBASE_WORKSPACE_ROOT}/supplier-management`,
    Component: SupplierManagementPage,
  },
  {
    key: 'planning-settings',
    label: 'Planning Settings',
    icon: 'ControlOutlined',
    path: `${ECOBASE_WORKSPACE_ROOT}/planning-settings`,
    Component: PlanningSettingsPage,
  },
  {
    key: 'import-status',
    label: 'Import & Source Status',
    icon: 'CloudUploadOutlined',
    path: `${ECOBASE_WORKSPACE_ROOT}/import-status`,
    Component: ImportStatusPage,
  },
];

const defaultEcobaseWorkspacePage = ecobaseWorkspacePages[0];

const EcobaseWorkspacePage = () => {
  const location = useLocation();
  const navigate = useNavigate();
  const matchedPage = ecobaseWorkspacePages.find(
    (page) => location.pathname === page.path || location.pathname.startsWith(`${page.path}/`),
  );
  const activePage =
    matchedPage ??
    ([ECOBASE_WORKSPACE_ROOT, `${ECOBASE_WORKSPACE_ROOT}/`].includes(location.pathname)
      ? defaultEcobaseWorkspacePage
      : undefined);
  const ActivePageComponent = activePage?.Component;
  const [navCollapsed, setNavCollapsed] = useState(false);
  const menuItems = useMemo(
    () =>
      ecobaseWorkspacePages.map((page) => ({
        key: page.key,
        label: page.label,
        title: page.label,
        icon: <Icon type={page.icon} />,
      })),
    [],
  );

  return (
    <Layout style={{ minHeight: 'calc(100vh - 64px)', background: 'transparent' }}>
      <Layout.Sider
        theme="light"
        width={260}
        collapsedWidth={72}
        collapsed={navCollapsed}
        trigger={null}
        style={{ borderRight: '1px solid #f0f0f0' }}
      >
        <div style={{ padding: navCollapsed ? '16px 12px 8px' : '16px 20px 8px' }}>
          <Space align="center" style={{ width: '100%', justifyContent: navCollapsed ? 'center' : 'space-between' }}>
            {navCollapsed ? (
              <Icon type="AppstoreOutlined" />
            ) : (
              <div>
                <Typography.Title level={4} style={{ margin: 0 }}>
                  EcoBase
                </Typography.Title>
                <Typography.Text type="secondary">Operations workspace</Typography.Text>
              </div>
            )}
            <Button
              size="small"
              type="text"
              aria-label={navCollapsed ? 'Expand EcoBase navigation' : 'Collapse EcoBase navigation'}
              title={navCollapsed ? 'Expand navigation' : 'Collapse navigation'}
              icon={<Icon type={navCollapsed ? 'MenuUnfoldOutlined' : 'MenuFoldOutlined'} />}
              onClick={() => setNavCollapsed((value) => !value)}
            />
          </Space>
        </div>
        <Menu
          mode="inline"
          selectedKeys={activePage ? [activePage.key] : []}
          inlineCollapsed={navCollapsed}
          items={menuItems}
          onClick={({ key }) => {
            const targetPage = ecobaseWorkspacePages.find((page) => page.key === key);
            if (!targetPage) {
              throw new Error(`Unknown EcoBase workspace page key: ${String(key)}`);
            }
            navigate(targetPage.path);
          }}
        />
      </Layout.Sider>
      <Layout.Content style={{ padding: 24, minWidth: 0 }}>
        {ActivePageComponent ? (
          <ActivePageComponent />
        ) : (
          <Typography.Text type="secondary">Unknown Ecobase page.</Typography.Text>
        )}
      </Layout.Content>
    </Layout>
  );
};

export const ecobaseWorkspaceRoutes = [
  {
    name: 'admin.ecobase.workspace',
    path: `${ECOBASE_WORKSPACE_ROOT}/*`,
    Component: EcobaseWorkspacePage,
  },
  ...ecobaseWorkspacePages.map((page) => ({
    name: `admin.ecobase.${page.key}`,
    path: page.path,
    Component: EcobaseWorkspacePage,
  })),
];

export const ecobasePluginSettings = [
  {
    key: 'ecobase-data-sources',
    title: 'Ecobase data sources',
    icon: 'CloudUploadOutlined',
    Component: DataSourcesPage,
    aclSnippet: 'pm.ecobase',
  },
  {
    key: 'ecobase-sellerboard-sources',
    title: 'Sellerboard sources',
    icon: 'CloudDownloadOutlined',
    Component: SellerboardSourcesPage,
    aclSnippet: 'pm.ecobase',
  },
  {
    key: 'ecobase-daily-operations-brief',
    title: 'Daily brief AI settings',
    icon: 'MailOutlined',
    Component: DailyBriefPromptSettingsPage,
    aclSnippet: 'pm.ecobase',
  },
  {
    key: 'ecobase-planning-settings',
    title: 'EcoBase planning settings',
    icon: 'ControlOutlined',
    Component: PlanningSettingsPage,
    aclSnippet: 'pm.ecobase',
  },
  {
    key: 'ecobase-gold-maintenance',
    title: 'EcoBase Gold maintenance',
    icon: 'DatabaseOutlined',
    Component: GoldMaintenancePage,
    aclSnippet: 'pm.ecobase',
  },
];
