/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { describe, expect, it } from 'vitest';
import {
  APPROVED_CLICKUP_ATTRIBUTION_USERS,
  normalizeClickupActorIdentity,
  resolveClickupActor,
} from '../../features/source-import/server/clickup-attribution-users';

describe('ClickUp attribution users', () => {
  it('defines exactly the ten approved non-login identities', () => {
    expect(APPROVED_CLICKUP_ATTRIBUTION_USERS.map((user) => [user.key, user.displayName, user.title])).toEqual([
      ['ahmed-nauman', 'Ahmed Nauman', undefined],
      ['shabi-ul-hassan', 'Shabi-ul-Hassan', undefined],
      ['kiran-mehtab', 'Kiran Mehtab', undefined],
      ['behroz', 'Behroz', undefined],
      ['abdur-rafay-khan', 'Abdur Rafay Khan', undefined],
      ['syed-atif-hassan', 'Syed Atif Hassan', undefined],
      ['hassan-mehtab', 'Hassan Mehtab', 'Director'],
      ['kashif-purchase', 'Kashif (Purchase)', undefined],
      ['atif-purchase', 'Atif (Purchase)', undefined],
      ['kashif-amazon', 'Kashif (Amazon)', undefined],
    ]);
    expect(APPROVED_CLICKUP_ATTRIBUTION_USERS).toHaveLength(10);
  });

  it('normalizes only NFKC, surrounding/internal whitespace, and case', () => {
    expect(normalizeClickupActorIdentity('  ＫＩＲＡＮ\t Mehtab  ')).toBe('kiran mehtab');
  });

  it('matches exact canonical names, approved source emails, and explicit aliases only', () => {
    expect(resolveClickupActor(' KIRAN   MEHTAB ')).toMatchObject({
      userKey: 'kiran-mehtab',
      matchMethod: 'exact_name',
    });
    expect(resolveClickupActor('nauman.ecofission@gmail.com')).toMatchObject({
      userKey: 'ahmed-nauman',
      matchMethod: 'exact_email',
    });
    expect(resolveClickupActor('Hassan Mehtab (Director)')).toMatchObject({
      userKey: 'hassan-mehtab',
      matchMethod: 'reviewed_alias',
    });
  });

  it.each(['Hasan', 'Hassan', 'Mehtab', 'Hassan Mehtab Director Extra', 'unknown@example.com'])(
    'leaves ambiguous or unapproved actor %s unresolved',
    (actor) => {
      expect(resolveClickupActor(actor)).toEqual({ normalizedActor: normalizeClickupActorIdentity(actor) });
    },
  );
});
