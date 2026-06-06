// @ts-ignore
import pkg from './../../package.json';
import { useApp } from '@nocobase/client';

export const namespace = pkg.name;

export function useT() {
  const app = useApp();
  return (str: string) => app.i18n.t(str, { ns: [pkg.name, 'client'] });
}
