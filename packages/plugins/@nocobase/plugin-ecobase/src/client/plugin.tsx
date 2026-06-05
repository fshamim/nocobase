import { Plugin, lazy } from '@nocobase/client';

const ImportStatusPage = lazy(() => import('./pages/ImportStatusPage'));
const OrderManagementPage = lazy(() => import('./pages/OrderManagementPage'));

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
  }
}

export default PluginEcobaseClient;
