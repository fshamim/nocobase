import React, { useMemo } from 'react';
import { Plugin, lazy } from '@nocobase/client';
import { Layout, Menu, Typography } from 'antd';
import { useLocation, useNavigate } from 'react-router-dom';
import { ecobaseClientCollections } from './ecobase-collections';

const AccuracyHarnessPage = lazy(() => import('./pages/AccuracyHarnessPage'));
const AiEvidencePage = lazy(() => import('./pages/AiEvidencePage'));
const AlertEvaluationPage = lazy(() => import('./pages/AlertEvaluationPage'));
const CollectionsWorkspacePage = lazy(() => import('./pages/CollectionsWorkspacePage'));
const DailyOperationsBriefPage = lazy(() => import('./pages/DailyOperationsBriefPage'));
const DailyBriefPromptSettingsPage = lazy(() => import('./pages/DailyBriefPromptSettingsPage'));
const DataSourcesPage = lazy(() => import('./pages/DataSourcesPage'));
const ImportStatusPage = lazy(() => import('./pages/ImportStatusPage'));
const InventoryPlanningPage = lazy(() => import('./pages/InventoryPlanningPage'));
const ManagementDashboardPage = lazy(() => import('./pages/ManagementDashboardPage'));
const OrderPlanningPage = lazy(() => import('./pages/OrderPlanningPage'));
const ReportPreviewPage = lazy(() => import('./pages/ReportPreviewPage'));
const SellerboardSourcesPage = lazy(() => import('./pages/SellerboardSourcesPage'));
const SilverDataPage = lazy(() => import('./pages/SilverDataPage'));
const SupplierManagementPage = lazy(() => import('./pages/SupplierManagementPage'));

const ECOBASE_WORKSPACE_ROOT = '/admin/ecobase';

const ecobaseWorkspacePages = [
  {
    key: 'daily-operations-brief',
    label: 'Daily Operations Brief',
    path: `${ECOBASE_WORKSPACE_ROOT}/daily-operations-brief`,
    Component: DailyOperationsBriefPage,
  },
  {
    key: 'silver-data',
    label: 'Silver Data',
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
    key: 'management-dashboard',
    label: 'BI Dashboard',
    path: `${ECOBASE_WORKSPACE_ROOT}/management-dashboard`,
    Component: ManagementDashboardPage,
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
  const activePage =
    ecobaseWorkspacePages.find(
      (page) => location.pathname === page.path || location.pathname.startsWith(`${page.path}/`),
    ) ?? defaultEcobaseWorkspacePage;
  const ActivePageComponent = activePage.Component;
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
          selectedKeys={[activePage.key]}
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
        <ActivePageComponent />
      </Layout.Content>
    </Layout>
  );
};

const ecobaseWorkspaceRoutes = [
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

export class PluginEcobaseClient extends Plugin<Record<string, unknown>> {
  async load() {
    this.dataSourceManager.getDataSource('main')?.collectionManager.addCollections(ecobaseClientCollections);

    for (const route of ecobaseWorkspaceRoutes) {
      this.app.router.add(route.name, {
        path: route.path,
        Component: route.Component,
      });
    }

    this.pluginSettingsManager.add('ecobase', {
      title: this.t('Ecobase BI'),
      icon: 'DatabaseOutlined',
      Component: ImportStatusPage,
      aclSnippet: 'pm.ecobase',
    });
    this.pluginSettingsManager.add('ecobase-data-sources', {
      title: this.t('Ecobase data sources'),
      icon: 'CloudUploadOutlined',
      Component: DataSourcesPage,
      aclSnippet: 'pm.ecobase',
    });
    this.pluginSettingsManager.add('ecobase-sellerboard-sources', {
      title: this.t('Sellerboard sources'),
      icon: 'CloudDownloadOutlined',
      Component: SellerboardSourcesPage,
      aclSnippet: 'pm.ecobase',
    });
    this.pluginSettingsManager.add('ecobase-inventory-planning', {
      title: this.t('Inventory planning'),
      icon: 'OrderedListOutlined',
      Component: InventoryPlanningPage,
      aclSnippet: 'pm.ecobase',
    });
    this.pluginSettingsManager.add('ecobase-order-planning', {
      title: this.t('Order planning'),
      icon: 'ShoppingCartOutlined',
      Component: OrderPlanningPage,
      aclSnippet: 'pm.ecobase',
    });
    this.pluginSettingsManager.add('ecobase-daily-operations-brief', {
      title: this.t('Daily brief AI settings'),
      icon: 'MailOutlined',
      Component: DailyBriefPromptSettingsPage,
      aclSnippet: 'pm.ecobase',
    });
    this.pluginSettingsManager.add('debug', {
      title: this.t('Debug'),
      icon: 'BugOutlined',
      aclSnippet: 'pm.ecobase',
    });
    this.pluginSettingsManager.add('debug.ecobase-alerts', {
      title: this.t('Ecobase alerts'),
      icon: 'AlertOutlined',
      Component: AlertEvaluationPage,
      aclSnippet: 'pm.ecobase',
    });
    this.pluginSettingsManager.add('debug.ecobase-collections-workspace', {
      title: this.t('Ecobase collections workspace'),
      icon: 'TableOutlined',
      Component: CollectionsWorkspacePage,
      aclSnippet: 'pm.ecobase',
    });
    this.pluginSettingsManager.add('debug.ecobase-management-dashboard', {
      title: this.t('Ecobase management dashboard'),
      icon: 'DashboardOutlined',
      Component: ManagementDashboardPage,
      aclSnippet: 'pm.ecobase',
    });
    this.pluginSettingsManager.add('debug.ecobase-report-preview', {
      title: this.t('Ecobase report preview'),
      icon: 'MailOutlined',
      Component: ReportPreviewPage,
      aclSnippet: 'pm.ecobase',
    });
    this.pluginSettingsManager.add('debug.ecobase-ai-evidence', {
      title: this.t('Ecobase AI evidence'),
      icon: 'RobotOutlined',
      Component: AiEvidencePage,
      aclSnippet: 'pm.ecobase',
    });
    this.pluginSettingsManager.add('debug.ecobase-accuracy-harness', {
      title: this.t('Ecobase accuracy harness'),
      icon: 'AuditOutlined',
      Component: AccuracyHarnessPage,
      aclSnippet: 'pm.ecobase',
    });
  }
}

export default PluginEcobaseClient;
