/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

/**
 * Issue 069 follow-up — one-time sweep for comment bodies the ClickUp import already stored.
 *
 * The importer now cleans the export's `undefined` block artifact at the parse boundary (see
 * `clickup-comment-text.ts`), but 100 Silver comment bodies were written before that guard existed:
 * 43 of them START with the token. This sweep applies the SAME cleanup to the stored rows, so the
 * two paths converge — re-importing the export after the sweep leaves the bodies byte-identical.
 *
 * Three properties make it safe to run against production data, mirroring `repairOrderStamps`:
 *
 * - **Dry by default.** A bare call previews; only `dryRun: false` writes.
 * - **ClickUp-sourced only.** The root cause is proven for the ClickUp comment writer alone, so a
 *   comment an operator typed is never rewritten — it is scanned, counted, and left alone.
 * - **Idempotent.** The cleanup removes only line-leading artifacts, and its own output has none,
 *   so a second run reports zero work.
 *
 * What it does NOT touch, and reports instead:
 *
 * - Bodies that are nothing BUT the artifact (5 in production). `body` is NOT NULL, and inventing
 *   replacement text would be fabrication, so they are counted as `bodiesFullyArtifactSkipped`.
 * - Mid-line tokens (1 in production: `Quote023567-EF61726A.pdfundefined`). The token is the same
 *   artifact but the correct separator is not provable from the export, so the occurrence is counted
 *   as `residualTokenCount` for a human to decide on.
 */

import { cleanClickupCommentText } from './clickup-comment-text';
import type { EcobaseDatabase } from './import-service';
import { ECOBASE_COLLECTIONS } from '../../../server/collections/names';

type Row = Record<string, unknown>;

/** Comfortably above the production Silver comment count (~6.5k) and bounded, like the sibling sweeps. */
export const CLICKUP_COMMENT_REPAIR_SCAN_LIMIT = 50000;

/** The `sourceCommentKey` segment every ClickUp comment import writes. */
export const CLICKUP_COMMENT_KEY_MARKER = ':clickup_comment:';

export interface ClickupCommentBodyRepairInput {
  /** Defaults to true, exactly like `repairOrderStamps`: a bare call previews, it never writes. */
  dryRun?: boolean;
}

export interface ClickupCommentBodyRepairResult {
  dryRun: boolean;
  /** Scan counts. These describe the sweep's reach and stay non-zero on a second run. */
  commentsScanned: number;
  clickupCommentsScanned: number;
  bodiesWithArtifact: number;
  nonClickupBodiesSkipped: number;
  /** Work counts. Every one of these is 0 on a second run — that is the idempotence proof. */
  commentsUpdated: number;
  artifactTokensRemoved: number;
  /** Counted, never rewritten: cleaning would empty a NOT NULL body. */
  bodiesFullyArtifactSkipped: number;
  /** Counted, never rewritten: the token sits mid-line, where the right separator is not provable. */
  bodiesWithResidualToken: number;
  residualTokenCount: number;
}

function record(value: unknown): Row {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Row) : {};
}

function text(value: unknown) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return normalized || undefined;
}

export interface ClickupCommentBodyRepairLogger {
  info?: (...args: unknown[]) => void;
}

export class EcobaseClickupCommentBodyRepairService {
  constructor(
    private readonly db: EcobaseDatabase,
    private readonly logger?: ClickupCommentBodyRepairLogger,
  ) {}

  async repairClickupCommentBodies(input: ClickupCommentBodyRepairInput = {}): Promise<ClickupCommentBodyRepairResult> {
    const dryRun = input.dryRun !== false;
    const repo = this.db.getRepository(ECOBASE_COLLECTIONS.silverActivityComments);
    const comments = (await repo.find({ limit: CLICKUP_COMMENT_REPAIR_SCAN_LIMIT })).map(record);
    const result: ClickupCommentBodyRepairResult = {
      dryRun,
      commentsScanned: 0,
      clickupCommentsScanned: 0,
      bodiesWithArtifact: 0,
      nonClickupBodiesSkipped: 0,
      commentsUpdated: 0,
      artifactTokensRemoved: 0,
      bodiesFullyArtifactSkipped: 0,
      bodiesWithResidualToken: 0,
      residualTokenCount: 0,
    };

    for (const comment of comments) {
      const id = text(comment.id);
      if (!id) continue;
      result.commentsScanned += 1;
      const body = typeof comment.body === 'string' ? comment.body : '';
      const clickupSourced = (text(comment.sourceCommentKey) ?? '').includes(CLICKUP_COMMENT_KEY_MARKER);
      if (clickupSourced) result.clickupCommentsScanned += 1;
      if (!body.includes('undefined')) continue;
      result.bodiesWithArtifact += 1;
      if (!clickupSourced) {
        // Some other writer owns this body. The root cause does not cover it, so neither does the sweep.
        result.nonClickupBodiesSkipped += 1;
        continue;
      }

      const cleanup = cleanClickupCommentText(body);
      if (cleanup.residualTokenCount > 0) {
        result.bodiesWithResidualToken += 1;
        result.residualTokenCount += cleanup.residualTokenCount;
      }
      // Nothing provable to remove — a mid-line token only. Counted above, left as it stands.
      if (cleanup.removedTokenCount === 0) continue;
      if (!cleanup.cleaned) {
        // The body was nothing but the artifact. `body` is NOT NULL and there is no text to recover.
        result.bodiesFullyArtifactSkipped += 1;
        continue;
      }

      result.commentsUpdated += 1;
      result.artifactTokensRemoved += cleanup.removedTokenCount;
      if (!dryRun) await repo.update({ filterByTk: id, values: { body: cleanup.cleaned } });
    }

    this.logger?.info?.('Ecobase ClickUp comment body repair completed.', { ...result });
    return result;
  }
}
