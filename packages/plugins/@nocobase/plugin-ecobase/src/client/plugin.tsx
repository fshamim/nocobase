import { Plugin } from '@nocobase/client';
import { ecobaseClientCollections } from './ecobase-collections';
import { ecobasePluginSettings, ecobaseWorkspaceRoutes } from './client-routes';

export class PluginEcobaseClient extends Plugin<Record<string, unknown>> {
  async load() {
    this.dataSourceManager.getDataSource('main')?.collectionManager.addCollections(ecobaseClientCollections);

    for (const route of ecobaseWorkspaceRoutes) {
      this.app.router.add(route.name, {
        path: route.path,
        Component: route.Component,
      });
    }

    for (const setting of ecobasePluginSettings) {
      this.pluginSettingsManager.add(setting.key, {
        title: this.t(setting.title),
        icon: setting.icon,
        Component: setting.Component,
        aclSnippet: setting.aclSnippet,
      });
    }
  }
}

export default PluginEcobaseClient;
