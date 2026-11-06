/**
 * What a result says about its questions, with everything that depends on how the
 * text arrived taken out. Two results that should be the same are compared through
 * this: a text file and the same text as a Word file, say.
 */

import { FindingCode, verdictFrom } from "../../src/model/findings.ts";
import type { ImportResult } from "../../src/import/types.ts";

/**
 * Notes on a question that only a Word file can earn, because the file had a table that the same text does not: a question with a
 * table inside its text says its rows and columns were not kept, and typed text has no table to say it of. They are left out of the
 * comparison, and out of the count of questions that need a look, which is worked out again without them.
 */
const WORD_ONLY_ON_A_QUESTION = new Set<string>([FindingCode.TableFlattened]);

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

/** The counts of the result, as they would be without the notes only a Word file can earn. */
function recount(result: ImportResult): ImportResult["counts"] {
  const counts = { ...result.counts, parsed: 0, needsReview: 0, failed: 0 };
  for (const q of result.questions) {
    const verdict = verdictFrom(q.findings.filter((f) => !WORD_ONLY_ON_A_QUESTION.has(f.code)));
    if (verdict === "parsed") counts.parsed++;
    else if (verdict === "needsReview") counts.needsReview++;
    else counts.failed++;
  }
  return counts;
}

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
        .filter((f) => f.code !== FindingCode.FormattingKeyBroken && !WORD_ONLY_ON_A_QUESTION.has(f.code))
        .map((f) => [f.code, f.severity, f.field ?? "", f.message])
        .sort(),
      source: q.origin?.source ? [q.origin.source.firstBlock, q.origin.source.lastBlock] : null,
    })),
    orphans: result.orphans.map((o) => [o.text, o.reason, o.source.firstBlock, o.source.lastBlock]),
    fileFindings: result.fileFindings.filter((f) => !FRONT_END.has(f.code)).map((f) => [f.code, f.severity, f.message]),
    counts: recount(result),
  };
}

