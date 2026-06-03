import { Plugin, lazy } from '@nocobase/client';

const ImportStatusPage = lazy(() => import('./pages/ImportStatusPage'));

export class PluginEcobaseClient extends Plugin<Record<string, unknown>> {
  async load() {
    this.pluginSettingsManager.add('ecobase', {
      title: this.t('Ecobase BI'),
      icon: 'DatabaseOutlined',
      Component: ImportStatusPage,
      aclSnippet: 'pm.ecobase',
    });
  }
}

export default PluginEcobaseClient;
