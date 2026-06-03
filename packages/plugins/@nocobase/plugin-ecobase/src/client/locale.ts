import { useTranslation } from 'react-i18next';

import pkg from './../../package.json';

export const NAMESPACE = pkg.name;

export function useT() {
  const { t } = useTranslation([NAMESPACE, 'client'], { nsMode: 'fallback' });
  return t;
}
