import { Plugin } from '@nocobase/client';
import { codexSubscriptionProviderOptions } from './llm-providers/codex-subscription';

export class PluginAICodexSubscriptionClient extends Plugin {
  async load() {
    this.aiPlugin.aiManager.registerLLMProvider('codex-subscription', codexSubscriptionProviderOptions);
  }

  private get aiPlugin(): any {
    return this.app.pm.get('ai');
  }
}

export default PluginAICodexSubscriptionClient;
