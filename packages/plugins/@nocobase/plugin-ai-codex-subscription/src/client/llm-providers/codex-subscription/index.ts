import { ComponentType } from 'react';
import { ProviderSettingsForm } from './ProviderSettings';
import { ModelSettingsForm } from './ModelSettings';

type LLMProviderOptions = {
  components: {
    ProviderSettingsForm?: ComponentType;
    ModelSettingsForm?: ComponentType;
  };
};

export const codexSubscriptionProviderOptions: LLMProviderOptions = {
  components: {
    ProviderSettingsForm,
    ModelSettingsForm,
  },
};
