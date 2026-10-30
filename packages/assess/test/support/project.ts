/**
 * What a result says about its questions, with everything that depends on how the
 * text arrived taken out. Two results that should be the same are compared through
 * this: a text file and the same text as a Word file, say.
 */

import { FindingCode } from "../../src/model/findings.ts";
import type { ImportResult } from "../../src/import/types.ts";

/** Codes only a Word file can raise, so they are not expected on the text version. */
export const FRONT_END = new Set<string>([
  FindingCode.TrackedChangesPresent,
  FindingCode.UnreadContent,
  FindingCode.TableLayout,
  FindingCode.FormattingKeyUsed,
  FindingCode.FormattingKeyUnclear,
  // Only said of a question that has no key in words, and such a question fails for that anyway.
  FindingCode.FormattingKeyBroken,
]);

/** Everything about a result that should not depend on how the text arrived. */
export function project(result: ImportResult) {
  return {
    questions: result.questions.map((q) => ({
      type: q.type,
      title: q.title,
      points: q.points,
      stem: q.stem,
      body: q.body,
      feedback: q.feedback,
      metadata: q.metadata,
      media: q.media,
      findings: q.findings
        .filter((f) => f.code !== FindingCode.FormattingKeyBroken)
        .map((f) => [f.code, f.severity, f.field ?? "", f.message])
        .sort(),
      source: q.origin?.source ? [q.origin.source.firstBlock, q.origin.source.lastBlock] : null,
    })),
    orphans: result.orphans.map((o) => [o.text, o.reason, o.source.firstBlock, o.source.lastBlock]),
    fileFindings: result.fileFindings.filter((f) => !FRONT_END.has(f.code)).map((f) => [f.code, f.severity, f.message]),
    counts: result.counts,
  };
}

