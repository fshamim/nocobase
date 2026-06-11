import { Plugin, lazy } from '@nocobase/client';
import { ecobaseClientCollections } from './ecobase-collections';

const AccuracyHarnessPage = lazy(() => import('./pages/AccuracyHarnessPage'));
const AiEvidencePage = lazy(() => import('./pages/AiEvidencePage'));
const AlertEvaluationPage = lazy(() => import('./pages/AlertEvaluationPage'));
const CollectionsWorkspacePage = lazy(() => import('./pages/CollectionsWorkspacePage'));
const DailyOperationsBriefPage = lazy(() => import('./pages/DailyOperationsBriefPage'));
const ImportStatusPage = lazy(() => import('./pages/ImportStatusPage'));
const InventoryPlanningPage = lazy(() => import('./pages/InventoryPlanningPage'));
const ManagementDashboardPage = lazy(() => import('./pages/ManagementDashboardPage'));
const OrderManagementPage = lazy(() => import('./pages/OrderManagementPage'));
const ReportPreviewPage = lazy(() => import('./pages/ReportPreviewPage'));
const SellerboardSourcesPage = lazy(() => import('./pages/SellerboardSourcesPage'));

export class PluginEcobaseClient extends Plugin<Record<string, unknown>> {
  async load() {
    this.dataSourceManager.getDataSource('main')?.collectionManager.addCollections(ecobaseClientCollections);

    this.pluginSettingsManager.add('ecobase', {
      title: this.t('Ecobase BI'),
      icon: 'DatabaseOutlined',
      Component: ImportStatusPage,
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
    this.pluginSettingsManager.add('ecobase-order-management', {
      title: this.t('Ecobase order management'),
      icon: 'ShoppingCartOutlined',
      Component: OrderManagementPage,
      aclSnippet: 'pm.ecobase',
    });
    this.pluginSettingsManager.add('ecobase-daily-operations-brief', {
      title: this.t('Daily Operations Brief'),
      icon: 'MailOutlined',
      Component: DailyOperationsBriefPage,
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
