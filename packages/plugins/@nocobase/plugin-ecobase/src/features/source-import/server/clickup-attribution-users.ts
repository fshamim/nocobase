/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

export type ClickupActorMatchMethod = 'exact_name' | 'exact_email' | 'reviewed_alias';

export type ApprovedClickupAttributionUser = {
  key: string;
  displayName: string;
  title?: string;
  emails?: string[];
  aliases?: string[];
};

export const APPROVED_CLICKUP_ATTRIBUTION_USERS: ApprovedClickupAttributionUser[] = [
  { key: 'ahmed-nauman', displayName: 'Ahmed Nauman', emails: ['nauman.ecofission@gmail.com'] },
  { key: 'shabi-ul-hassan', displayName: 'Shabi-ul-Hassan' },
  { key: 'kiran-mehtab', displayName: 'Kiran Mehtab', emails: ['kiranecofission@gmail.com'] },
  { key: 'behroz', displayName: 'Behroz', emails: ['behroz.ecofission@gmail.com'] },
  { key: 'abdur-rafay-khan', displayName: 'Abdur Rafay Khan', emails: ['rafay.ecofission@gmail.com'] },
  { key: 'syed-atif-hassan', displayName: 'Syed Atif Hassan' },
  {
    key: 'hassan-mehtab',
    displayName: 'Hassan Mehtab',
    title: 'Director',
    emails: ['director@eco-fission.com'],
    aliases: ['Hassan Mehtab (Director)'],
  },
  { key: 'kashif-purchase', displayName: 'Kashif (Purchase)' },
  { key: 'atif-purchase', displayName: 'Atif (Purchase)' },
  { key: 'kashif-amazon', displayName: 'Kashif (Amazon)' },
];

export function normalizeClickupActorIdentity(value: string | undefined) {
  return value?.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase('und') ?? '';
}

const identityIndexes = (() => {
  const names = new Map<string, string>();
  const emails = new Map<string, string>();
  const aliases = new Map<string, string>();
  const add = (index: Map<string, string>, value: string, userKey: string) => {
    const normalized = normalizeClickupActorIdentity(value);
    const existing = index.get(normalized);
    if (!normalized || (existing && existing !== userKey)) {
      throw new Error(`Ecobase ClickUp attribution policy has an ambiguous identity value: ${value}.`);
    }
    index.set(normalized, userKey);
  };
  for (const user of APPROVED_CLICKUP_ATTRIBUTION_USERS) {
    add(names, user.displayName, user.key);
    user.emails?.forEach((email) => add(emails, email, user.key));
    user.aliases?.forEach((alias) => add(aliases, alias, user.key));
  }
  return { names, emails, aliases };
})();

export function resolveClickupActor(actor: string | undefined): {
  normalizedActor: string;
  userKey?: string;
  matchMethod?: ClickupActorMatchMethod;
} {
  const normalizedActor = normalizeClickupActorIdentity(actor);
  const exactName = identityIndexes.names.get(normalizedActor);
  if (exactName) return { normalizedActor, userKey: exactName, matchMethod: 'exact_name' };
  const exactEmail = identityIndexes.emails.get(normalizedActor);
  if (exactEmail) return { normalizedActor, userKey: exactEmail, matchMethod: 'exact_email' };
  const reviewedAlias = identityIndexes.aliases.get(normalizedActor);
  if (reviewedAlias) return { normalizedActor, userKey: reviewedAlias, matchMethod: 'reviewed_alias' };
  return { normalizedActor };
}

export function approvedClickupAttributionUser(userKey: string) {
  return APPROVED_CLICKUP_ATTRIBUTION_USERS.find((user) => user.key === userKey);
}
