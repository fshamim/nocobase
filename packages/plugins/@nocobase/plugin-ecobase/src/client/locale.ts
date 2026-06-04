import { useTranslation } from 'react-i18next';

export const NAMESPACE = '@nocobase/plugin-ecobase';

export function useT() {
  const { t } = useTranslation([NAMESPACE, 'client'], { nsMode: 'fallback' });
  return t;
}
