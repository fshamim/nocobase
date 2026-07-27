/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

/**
 * Issue 069 follow-up — the literal `undefined` inside imported ClickUp comment bodies.
 *
 * ClickUp's CSV export renders a comment as one line per comment BLOCK. A block that carries no
 * text of its own (attachment, embed, banner) is interpolated with its missing text value, so the
 * exporter writes the JS token `undefined` on that block's line. The raw export therefore already
 * contains rows like:
 *
 *     {"text":" \nundefined\n  This is the update of this order in inbound.\n", "by":"...", ...}
 *     {"text":"\nundefinedas per the tracking the order is delivered on Monday 22nd of Dec.", ...}
 *
 * The importer stored `text` verbatim (only trimmed), which is how 43 stored bodies came to START
 * with `undefined` and 100 to contain it. This module is the single place that strips the artifact,
 * and it is applied at the point the raw export text becomes our comment body — the parse boundary
 * — so nothing downstream ever sees the token.
 *
 * The rule is deliberately narrow and is backed by the export itself. Across the 175 occurrences in
 * the production export, 174 sit at the start of a line (or at the start of the text) and NOT ONE is
 * followed by a space and a word — the shape real prose would have ("undefined behaviour ..."). So:
 *
 * - Removed: one or more `undefined` tokens at the start of a line, when what follows is either
 *   nothing/whitespace or a non-space character. A line that held nothing else is dropped whole,
 *   which is what collapses `...proceed.\n\nundefined\n@Kiran` back to `...proceed.\n\n@Kiran`.
 * - Kept, and reported: anything else — notably the single production body ending
 *   `Quote023567-EF61726A.pdfundefined`, where the token is glued mid-line onto an attachment name.
 *   The token is the same artifact, but "which separator belongs there" is not provable from the
 *   export, so it is counted and left for a human rather than guessed at.
 */

const ARTIFACT_TOKEN = 'undefined';

/** One or more consecutive artifact tokens at the very start of a line. */
const LINE_LEADING_ARTIFACT = /^(?:undefined)+/;

/** ` foo` — a space (or tab) followed by real content, i.e. the shape of prose, not of the artifact. */
const PROSE_TAIL = /^\s+\S/;

export interface ClickupCommentTextCleanup {
  /** The body with every provable artifact removed, trimmed. May be empty when the text was ONLY artifact. */
  cleaned: string;
  /** Artifact tokens this cleanup removed. */
  removedTokenCount: number;
  /**
   * `undefined` occurrences still present in `cleaned`. These are mid-line, so they are reported
   * rather than removed. A legitimate prose use of the word counts here too — which is correct:
   * the count exists to be looked at, never to be acted on automatically.
   */
  residualTokenCount: number;
}

function countTokens(value: string) {
  let count = 0;
  let index = value.indexOf(ARTIFACT_TOKEN);
  while (index >= 0) {
    count += 1;
    index = value.indexOf(ARTIFACT_TOKEN, index + ARTIFACT_TOKEN.length);
  }
  return count;
}

/**
 * Strips the ClickUp export's `undefined` block artifact from one comment text.
 *
 * Idempotent: the output of a cleanup has no line-leading artifact left, so cleaning it again
 * removes nothing. That is what lets the importer and the repair sweep converge on the same body.
 */
export function cleanClickupCommentText(raw: string): ClickupCommentTextCleanup {
  const lines: string[] = [];
  let removedTokenCount = 0;
  for (const line of raw.split('\n')) {
    const match = LINE_LEADING_ARTIFACT.exec(line);
    if (!match) {
      lines.push(line);
      continue;
    }
    const rest = line.slice(match[0].length);
    if (PROSE_TAIL.test(rest)) {
      lines.push(line);
      continue;
    }
    removedTokenCount += match[0].length / ARTIFACT_TOKEN.length;
    // A line that was nothing but the artifact leaves no blank line behind.
    if (rest.trim()) lines.push(rest);
  }
  const cleaned = lines.join('\n').trim();
  return { cleaned, removedTokenCount, residualTokenCount: countTokens(cleaned) };
}

/** The importer's view of the cleanup: just the body. Empty means the comment carried no text at all. */
export function sanitizeClickupCommentText(raw: string) {
  return cleanClickupCommentText(raw).cleaned;
}
