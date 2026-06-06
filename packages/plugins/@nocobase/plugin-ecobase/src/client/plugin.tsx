import { Plugin, lazy } from '@nocobase/client';

const AccuracyHarnessPage = lazy(() => import('./pages/AccuracyHarnessPage'));
const AiEvidencePage = lazy(() => import('./pages/AiEvidencePage'));
const AlertEvaluationPage = lazy(() => import('./pages/AlertEvaluationPage'));
const CollectionsWorkspacePage = lazy(() => import('./pages/CollectionsWorkspacePage'));
const ImportStatusPage = lazy(() => import('./pages/ImportStatusPage'));
const ManagementDashboardPage = lazy(() => import('./pages/ManagementDashboardPage'));
const OrderManagementPage = lazy(() => import('./pages/OrderManagementPage'));
const ReportPreviewPage = lazy(() => import('./pages/ReportPreviewPage'));

export class PluginEcobaseClient extends Plugin<Record<string, unknown>> {
  async load() {
    this.pluginSettingsManager.add('ecobase', {
      title: this.t('Ecobase BI'),
      icon: 'DatabaseOutlined',
      Component: ImportStatusPage,
      aclSnippet: 'pm.ecobase',
    });
    this.pluginSettingsManager.add('ecobase-order-management', {
      title: this.t('Ecobase order management'),
      icon: 'ShoppingCartOutlined',
      Component: OrderManagementPage,
      aclSnippet: 'pm.ecobase',
    });
    this.pluginSettingsManager.add('ecobase-alerts', {
      title: this.t('Ecobase alerts'),
      icon: 'AlertOutlined',
      Component: AlertEvaluationPage,
      aclSnippet: 'pm.ecobase',
    });
    this.pluginSettingsManager.add('ecobase-collections-workspace', {
      title: this.t('Ecobase collections workspace'),
      icon: 'TableOutlined',
      Component: CollectionsWorkspacePage,
      aclSnippet: 'pm.ecobase',
    });
    this.pluginSettingsManager.add('ecobase-management-dashboard', {
      title: this.t('Ecobase management dashboard'),
      icon: 'DashboardOutlined',
      Component: ManagementDashboardPage,
      aclSnippet: 'pm.ecobase',
    });
    this.pluginSettingsManager.add('ecobase-report-preview', {
      title: this.t('Ecobase report preview'),
      icon: 'MailOutlined',
      Component: ReportPreviewPage,
      aclSnippet: 'pm.ecobase',
    });
    this.pluginSettingsManager.add('ecobase-ai-evidence', {
      title: this.t('Ecobase AI evidence'),
      icon: 'RobotOutlined',
      Component: AiEvidencePage,
      aclSnippet: 'pm.ecobase',
    });
    this.pluginSettingsManager.add('ecobase-accuracy-harness', {
      title: this.t('Ecobase accuracy harness'),
      icon: 'AuditOutlined',
      Component: AccuracyHarnessPage,
      aclSnippet: 'pm.ecobase',
    });
  }
}

export default PluginEcobaseClient;
