import React, { useMemo } from 'react';
import { lazy } from '@nocobase/client';
import { Layout, Menu, Typography } from 'antd';
import { useLocation, useNavigate } from 'react-router-dom';

const DailyOperationsBriefPage = lazy(() => import('../features/daily-operations-brief/client/DailyOperationsBriefPage'));
const DailyBriefPromptSettingsPage = lazy(
  () => import('../features/daily-operations-brief/client/DailyBriefPromptSettingsPage'),
);
const DataSourcesPage = lazy(() => import('../features/source-import/client/DataSourcesPage'));
const ImportStatusPage = lazy(() => import('../features/source-import/client/ImportStatusPage'));
const InventoryPlanningPage = lazy(() => import('../features/inventory-planning/client/InventoryPlanningPage'));
const OrderPlanningPage = lazy(() => import('../features/order-planning/client/OrderPlanningPage'));
const PlanningSettingsPage = lazy(() => import('./pages/PlanningSettingsPage'));
const SellerboardSourcesPage = lazy(() => import('../features/source-import/client/SellerboardSourcesPage'));
const SilverDataPage = lazy(() => import('./pages/SilverDataPage'));
const SupplierManagementPage = lazy(() => import('../features/supplier-management/client/SupplierManagementPage'));

export const ECOBASE_WORKSPACE_ROOT = '/admin/ecobase';

const ecobaseWorkspacePages = [
  {
    key: 'daily-operations-brief',
    label: 'Daily Operations Brief',
    path: `${ECOBASE_WORKSPACE_ROOT}/daily-operations-brief`,
    Component: DailyOperationsBriefPage,
  },
  {
    key: 'silver-data',
    label: 'Semantic Model',
    path: `${ECOBASE_WORKSPACE_ROOT}/silver-data`,
    Component: SilverDataPage,
  },
  {
    key: 'inventory-planning',
    label: 'Inventory Planning',
    path: `${ECOBASE_WORKSPACE_ROOT}/inventory-planning`,
    Component: InventoryPlanningPage,
  },
  {
    key: 'order-planning',
    label: 'Order Planning',
    path: `${ECOBASE_WORKSPACE_ROOT}/order-planning`,
    Component: OrderPlanningPage,
  },
  {
    key: 'supplier-management',
    label: 'Supplier Management',
    path: `${ECOBASE_WORKSPACE_ROOT}/supplier-management`,
    Component: SupplierManagementPage,
  },
  {
    key: 'planning-settings',
    label: 'Planning Settings',
    path: `${ECOBASE_WORKSPACE_ROOT}/planning-settings`,
    Component: PlanningSettingsPage,
  },
  {
    key: 'import-status',
    label: 'Import & Source Status',
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
  const menuItems = useMemo(() => ecobaseWorkspacePages.map((page) => ({ key: page.key, label: page.label })), []);

  return (
    <Layout style={{ minHeight: 'calc(100vh - 64px)', background: 'transparent' }}>
      <Layout.Sider theme="light" width={260} style={{ borderRight: '1px solid #f0f0f0' }}>
        <div style={{ padding: '16px 20px 8px' }}>
          <Typography.Title level={4} style={{ margin: 0 }}>
            EcoBase
          </Typography.Title>
          <Typography.Text type="secondary">Operations workspace</Typography.Text>
        </div>
        <Menu
          mode="inline"
          selectedKeys={activePage ? [activePage.key] : []}
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
];
