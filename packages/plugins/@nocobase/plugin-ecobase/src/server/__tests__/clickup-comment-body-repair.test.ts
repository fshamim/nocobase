/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

/**
 * Issue 069 follow-up — the literal `undefined` in imported ClickUp comment bodies.
 *
 * ClickUp's CSV export writes the JS token `undefined` on the line of every textless comment block,
 * and the importer stored `text` verbatim, so 43 production bodies START with it and 100 contain it.
 * The guard now lives at the parse boundary; this file pins both halves:
 *
 * - the importer never produces a body carrying the token, and an attachment-only comment is
 *   reported as textless rather than stored as the word "undefined";
 * - the sweep applies the SAME cleanup to rows written before the guard, touching only what the
 *   export proves, previewing by default, and doing no work on a second run.
 *
 * Every raw comment payload below is copied from the production export
 * (`data/dataforimport/Order Management Clickup Data 06-07-2026.csv`).
 */

import { describe, expect, it } from 'vitest';
import { ECOBASE_COLLECTIONS } from '../collections/names';
import { createSourceAdapterRegistry, noopTestAdapter } from '../../features/source-import/server/adapters';
import { EcobaseClickupCommentBodyRepairService } from '../../features/source-import/server/clickup-comment-body-repair';
import { cleanClickupCommentText } from '../../features/source-import/server/clickup-comment-text';
import { parseClickupOrderStatusFiles } from '../../features/source-import/server/clickup-order-status-service';
import { createSourceImportResourceRegistration } from '../../features/source-import/server/resource-registration';
import type { EcobaseDatabase, EcobaseRepository } from '../../features/source-import/server/import-service';
import { createEcobaseImportActions } from '../resource-actions';
import { ADMIN, LOGGED_IN } from '../resource-registration';

type Row = Record<string, unknown> & { id: string };

class Repo implements EcobaseRepository {
  constructor(public rows: Row[] = []) {}
  async find(params?: { limit?: number }) {
    return typeof params?.limit === 'number' ? this.rows.slice(0, params.limit) : this.rows;
  }
  async findOne(params?: { filterByTk?: string | number }) {
    return this.rows.find((row) => row.id === params?.filterByTk) ?? null;
  }
  async create({ values }: { values: Record<string, unknown> }) {
    const row = values as Row;
    this.rows.push(row);
    return row;
  }
  async update({ filterByTk, values }: { filterByTk?: string | number | null; values: Record<string, unknown> }) {
    const target = this.rows.find((row) => row.id === filterByTk);
    if (target) Object.assign(target, values);
    return target ?? null;
  }
}

class Db implements EcobaseDatabase {
  repositories = new Map<string, Repo>();
  getRepository(name: string) {
    if (!this.repositories.has(name)) this.repositories.set(name, new Repo());
    const repository = this.repositories.get(name);
    if (!repository) throw new Error(`Comment repair fixture repository ${name} was not registered.`);
    return repository;
  }
  seed(name: string, rows: Row[]) {
    this.repositories.set(name, new Repo(rows));
  }
  rows(name: string) {
    return this.getRepository(name).rows;
  }
}

const CLICKUP_KEY = 'conn-1:clickup_comment:order-1:2026-01-17T14:16:01.000Z:fac145ec95e1fd3d';

/**
 * Six stored bodies covering every branch: the leading-prefix case (43 rows in production), the
 * interior line case, consecutive tokens, a body that is nothing but the artifact (5 in production),
 * the one mid-line body the export cannot explain, plus an operator comment the sweep must not own.
 */
function fixture() {
  const db = new Db();
  db.seed(ECOBASE_COLLECTIONS.silverActivityComments, [
    {
      id: 'leading',
      sourceCommentKey: `${CLICKUP_KEY}-a`,
      body: 'undefined\n  This is the update of this order in inbound.',
    },
    {
      id: 'leading-glued',
      sourceCommentKey: `${CLICKUP_KEY}-b`,
      body: 'undefinedas per the tracking the order is delivered on Monday 22nd of Dec.',
    },
    {
      id: 'interior',
      sourceCommentKey: `${CLICKUP_KEY}-c`,
      body: 'shipment done @Behroz Siddique\n\nundefined\nHi there,\nHere is a quick update.',
    },
    {
      id: 'consecutive',
      sourceCommentKey: `${CLICKUP_KEY}-d`,
      body: 'Order confirmed.\n\nundefinedundefinedundefined\n\nThanks.',
    },
    {
      // Attachment-only comment: cleaning empties a NOT NULL column, so it is counted, never written.
      id: 'artifact-only',
      sourceCommentKey: `${CLICKUP_KEY}-e`,
      body: 'undefined',
    },
    {
      // The single production body where the token is glued mid-line onto an attachment name.
      id: 'mid-line',
      sourceCommentKey: `${CLICKUP_KEY}-f`,
      body: 'Note: give me a call when you see this email.\n\nQuote023567-EF61726A.pdfundefined',
    },
    {
      // An operator typed this. The root cause does not cover it, so neither does the sweep.
      id: 'operator-authored',
      sourceCommentKey: null,
      body: 'Supplier says the tracking field is undefined on their portal.',
    },
  ]);
  return db;
}

function commentById(db: Db, id: string) {
  const comment = db.rows(ECOBASE_COLLECTIONS.silverActivityComments).find((row) => row.id === id);
  if (!comment) throw new Error(`Fixture comment ${id} is missing.`);
  return comment;
}

function actionContext(values: Record<string, unknown> = {}, currentRoles: string[] = ['admin'], authenticated = true) {
  return {
    action: { params: { values } },
    db: fixture(),
    state: {
      currentUser: authenticated ? { id: 1 } : undefined,
      currentRoles,
    },
    body: undefined as unknown,
    throw(status: number, message: string): never {
      throw Object.assign(new Error(message), { status });
    },
  };
}

function clickupCsv(comments: Array<Record<string, unknown>>) {
  return [
    'Task ID,Task Name,Status,Date Created,List Name,Comments',
    `task-1,"New Order – MX12425B – Muxtex INC",ordered,1000,Order Management (ORM),"${JSON.stringify(comments).replace(
      /"/g,
      '""',
    )}"`,
  ].join('\n');
}

function parsedComments(comments: Array<Record<string, unknown>>) {
  const parsed = parseClickupOrderStatusFiles([{ name: 'clickup.csv', content: clickupCsv(comments) }]);
  const tasks = parsed.tasksByRef.get('MX12425B') ?? [];
  return tasks[0];
}

const EXPORT_DATE = '1/17/2026, 2:16:01 PM GMT+5';

describe('cleanClickupCommentText (069 follow-up)', () => {
  it('drops the leading artifact, with or without a separator after it', () => {
    expect(cleanClickupCommentText(' \nundefined\n  This is the update of this order in inbound.\n')).toEqual({
      cleaned: 'This is the update of this order in inbound.',
      removedTokenCount: 1,
      residualTokenCount: 0,
    });
    expect(cleanClickupCommentText('\nundefinedas per the tracking the order is delivered.')).toMatchObject({
      cleaned: 'as per the tracking the order is delivered.',
      removedTokenCount: 1,
    });
    expect(cleanClickupCommentText('undefined@Shabi Haasan yeh 3 asins enroll nhi hy')).toMatchObject({
      cleaned: '@Shabi Haasan yeh 3 asins enroll nhi hy',
      removedTokenCount: 1,
    });
  });

  it('removes an interior artifact line without leaving a blank line behind', () => {
    expect(cleanClickupCommentText('shipment done @Behroz\n\nundefined\nHi there,')).toEqual({
      cleaned: 'shipment done @Behroz\n\nHi there,',
      removedTokenCount: 1,
      residualTokenCount: 0,
    });
    // The export repeats the token once per textless block, with no separator between them.
    // The blank lines around it are the author's own spacing and stay exactly as written.
    expect(cleanClickupCommentText('Order confirmed.\n\nundefinedundefinedundefined\n\nThanks.')).toEqual({
      cleaned: 'Order confirmed.\n\n\nThanks.',
      removedTokenCount: 3,
      residualTokenCount: 0,
    });
  });

  it('leaves prose alone: the artifact is never followed by a space and a word', () => {
    const prose = 'undefined behaviour in the portal, and the field is undefined there too.';
    expect(cleanClickupCommentText(prose)).toEqual({
      cleaned: prose,
      removedTokenCount: 0,
      residualTokenCount: 2,
    });
  });

  it('reports a mid-line token instead of guessing which separator belongs there', () => {
    const glued = 'Note: give me a call.\n\nQuote023567-EF61726A.pdfundefined';
    expect(cleanClickupCommentText(glued)).toEqual({
      cleaned: glued,
      removedTokenCount: 0,
      residualTokenCount: 1,
    });
  });

  it('is idempotent: cleaning its own output removes nothing', () => {
    for (const raw of [
      ' \nundefined\n  This is the update.\n',
      'Order confirmed.\n\nundefinedundefinedundefined\n\nThanks.',
      'undefined',
      'Quote023567.pdfundefined',
    ]) {
      const once = cleanClickupCommentText(raw);
      const twice = cleanClickupCommentText(once.cleaned);
      expect(twice.cleaned).toBe(once.cleaned);
      expect(twice.removedTokenCount).toBe(0);
    }
  });
});

describe('ClickUp comment import (069 follow-up)', () => {
  /**
   * RED-PROOF TEST. Revert the `sanitizeClickupCommentText` call in `parseClickupComments` and this
   * fails with `body` = "undefined\n  This is the update of this order in inbound." — the exact
   * shape of the 43 damaged production rows.
   */
  it('never carries the export artifact into a parsed comment body', () => {
    const task = parsedComments([
      {
        text: ' \nundefined\n  This is the update of this order in inbound.\n',
        by: 'kiran@example.com',
        date: EXPORT_DATE,
      },
      { text: '\nundefinedas per the tracking the order is delivered.', by: 'kiran@example.com', date: EXPORT_DATE },
      { text: 'shipment done\n\nundefined\nHi there,', by: 'kiran@example.com', date: EXPORT_DATE },
    ]);

    expect(task.comments.map((comment) => comment.text)).toEqual([
      'This is the update of this order in inbound.',
      'as per the tracking the order is delivered.',
      'shipment done\n\nHi there,',
    ]);
    expect(task.comments.every((comment) => !comment.text.includes('undefined'))).toBe(true);
    expect(task.invalidCommentCount).toBe(0);
    expect(task.textlessCommentCount).toBe(0);
  });

  it('reports an attachment-only comment as textless, not as malformed, and stores nothing', () => {
    const task = parsedComments([
      { text: '\nundefined\n', by: 'kiran@example.com', date: EXPORT_DATE },
      { text: 'Order has been dispatched', by: 'kiran@example.com', date: EXPORT_DATE },
      { text: 'missing author', date: EXPORT_DATE },
    ]);

    expect(task.comments.map((comment) => comment.text)).toEqual(['Order has been dispatched']);
    // Textless is not a warning: nothing is malformed, there is simply nothing to store.
    expect(task.textlessCommentCount).toBe(1);
    expect(task.invalidCommentCount).toBe(1);
  });
});

describe('EcobaseClickupCommentBodyRepairService (069 follow-up)', () => {
  it('cleans only the ClickUp bodies the export explains, and reports the rest', async () => {
    const db = fixture();
    const midLine = structuredClone(commentById(db, 'mid-line'));
    const artifactOnly = structuredClone(commentById(db, 'artifact-only'));
    const operatorAuthored = structuredClone(commentById(db, 'operator-authored'));

    const result = await new EcobaseClickupCommentBodyRepairService(db).repairClickupCommentBodies({ dryRun: false });

    expect(commentById(db, 'leading').body).toBe('This is the update of this order in inbound.');
    expect(commentById(db, 'leading-glued').body).toBe(
      'as per the tracking the order is delivered on Monday 22nd of Dec.',
    );
    expect(commentById(db, 'interior').body).toBe(
      'shipment done @Behroz Siddique\n\nHi there,\nHere is a quick update.',
    );
    expect(commentById(db, 'consecutive').body).toBe('Order confirmed.\n\n\nThanks.');
    expect(commentById(db, 'artifact-only')).toEqual(artifactOnly);
    expect(commentById(db, 'mid-line')).toEqual(midLine);
    expect(commentById(db, 'operator-authored')).toEqual(operatorAuthored);

    expect(result).toEqual({
      dryRun: false,
      commentsScanned: 7,
      clickupCommentsScanned: 6,
      bodiesWithArtifact: 7,
      nonClickupBodiesSkipped: 1,
      commentsUpdated: 4,
      artifactTokensRemoved: 6,
      bodiesFullyArtifactSkipped: 1,
      bodiesWithResidualToken: 1,
      residualTokenCount: 1,
    });
  });

  it('dry-runs by default: writes nothing, reports exactly what the real run does', async () => {
    const previewDb = fixture();
    const before = structuredClone(previewDb.rows(ECOBASE_COLLECTIONS.silverActivityComments));

    const defaulted = await new EcobaseClickupCommentBodyRepairService(previewDb).repairClickupCommentBodies();
    const explicit = await new EcobaseClickupCommentBodyRepairService(previewDb).repairClickupCommentBodies({
      dryRun: true,
    });

    expect(defaulted.dryRun).toBe(true);
    expect(defaulted).toEqual(explicit);
    expect(previewDb.rows(ECOBASE_COLLECTIONS.silverActivityComments)).toEqual(before);

    const applied = await new EcobaseClickupCommentBodyRepairService(fixture()).repairClickupCommentBodies({
      dryRun: false,
    });
    expect({ ...defaulted, dryRun: false }).toEqual(applied);
  });

  it('is idempotent: the second real run does no work', async () => {
    const db = fixture();
    const first = await new EcobaseClickupCommentBodyRepairService(db).repairClickupCommentBodies({ dryRun: false });
    const afterFirst = structuredClone(db.rows(ECOBASE_COLLECTIONS.silverActivityComments));

    const second = await new EcobaseClickupCommentBodyRepairService(db).repairClickupCommentBodies({ dryRun: false });

    expect(first.commentsUpdated).toBe(4);
    expect(second).toEqual({
      dryRun: false,
      commentsScanned: 7,
      clickupCommentsScanned: 6,
      // Scan counts still see the three bodies nothing can be done about; work counts are zero.
      bodiesWithArtifact: 3,
      nonClickupBodiesSkipped: 1,
      commentsUpdated: 0,
      artifactTokensRemoved: 0,
      bodiesFullyArtifactSkipped: 1,
      bodiesWithResidualToken: 1,
      residualTokenCount: 1,
    });
    expect(db.rows(ECOBASE_COLLECTIONS.silverActivityComments)).toEqual(afterFirst);
  });

  it('agrees with the importer: a re-import of the cleaned export leaves the body unchanged', async () => {
    const db = fixture();
    await new EcobaseClickupCommentBodyRepairService(db).repairClickupCommentBodies({ dryRun: false });
    const task = parsedComments([
      {
        text: ' \nundefined\n  This is the update of this order in inbound.\n',
        by: 'kiran@example.com',
        date: EXPORT_DATE,
      },
    ]);

    expect(task.comments[0].text).toBe(commentById(db, 'leading').body);
  });

  it('logs the run with the same counts it returns', async () => {
    const entries: unknown[][] = [];
    const result = await new EcobaseClickupCommentBodyRepairService(fixture(), {
      info: (...args: unknown[]) => entries.push(args),
    }).repairClickupCommentBodies({ dryRun: false });

    expect(entries).toHaveLength(1);
    expect(entries[0][0]).toBe('Ecobase ClickUp comment body repair completed.');
    expect(entries[0][1]).toEqual(result);
  });
});

describe('repairClickupCommentBodies admin action (069 follow-up)', () => {
  it('rejects operators and unauthenticated callers, and admins get a dry run by default', async () => {
    const actions = createEcobaseImportActions(createSourceAdapterRegistry([noopTestAdapter]));
    const next = async () => {};

    await expect(actions.repairClickupCommentBodies(actionContext({}, ['operator']), next)).rejects.toThrow(
      'Ecobase repairClickupCommentBodies requires the admin or root role.',
    );
    await expect(actions.repairClickupCommentBodies(actionContext({}, ['admin'], false), next)).rejects.toThrow(
      'Ecobase repairClickupCommentBodies requires an authenticated user.',
    );

    const preview = actionContext({});
    await actions.repairClickupCommentBodies(preview, next);
    expect(preview.body).toMatchObject({ data: { dryRun: true, commentsScanned: 7, commentsUpdated: 4 } });
    expect(commentById(preview.db, 'leading').body).toBe('undefined\n  This is the update of this order in inbound.');

    // Only a real boolean `false` opts into writing; a stray string still previews.
    const stringy = actionContext({ dryRun: 'false' });
    await actions.repairClickupCommentBodies(stringy, next);
    expect(stringy.body).toMatchObject({ data: { dryRun: true } });

    const applied = actionContext({ dryRun: false });
    await actions.repairClickupCommentBodies(applied, next);
    expect(applied.body).toMatchObject({ data: { dryRun: false, commentsUpdated: 4 } });
    expect(commentById(applied.db, 'leading').body).toBe('This is the update of this order in inbound.');
  });

  it('is granted to the admin role only', () => {
    const grants = createSourceImportResourceRegistration(createSourceAdapterRegistry([noopTestAdapter])).acl.filter(
      (grant) => grant.resource === 'ecobaseImport',
    );
    const actionsFor = (role: unknown) =>
      grants.filter((grant) => grant.role === role).flatMap((grant) => grant.actions);

    expect(actionsFor(ADMIN)).toContain('repairClickupCommentBodies');
    expect(actionsFor(LOGGED_IN)).not.toContain('repairClickupCommentBodies');
  });
});
