/**
 * Placeholders. A choice question needs two options with words, and a file does not always have them: an option with a letter
 * and no text, a question with one option, a question with none. The importer keeps the question, puts the words `(missing)` in
 * the place of each option it lacks, and says so with an error, so that the question can be shown beside its source text and
 * repaired. This is the other half: when the person writes the words in, the error that said they were missing is no longer
 * true, and goes. Without it the question stayed Failed, and unusable, after it was repaired.
 */

import { FindingCode, type Finding } from "../model/findings.ts";
import { optionsOf, type Option, type Question } from "../model/question.ts";
import { collectRefs, richTextToPlain } from "../model/richtext.ts";

/** What an importer writes into an option it does not have the words for. */
export const PLACEHOLDER_TEXT = "(missing)";

/** True for an option that says nothing: the importer's placeholder, or no words and no picture or equation. */
export function isPlaceholderOption(option: Option): boolean {
  const refs = collectRefs(option.content);
  if (refs.media.length > 0 || refs.math.length > 0) return false;
  const text = richTextToPlain(option.content).trim();
  return text === "" || text === PLACEHOLDER_TEXT;
}

/** What an importer says about the options it had to make up. */
const PLACEHOLDER_PROBLEMS: ReadonlySet<string> = new Set<string>([FindingCode.EmptyOption, FindingCode.TooFewOptions, FindingCode.NoOptions]);

/**
 * When an edit has written real words where the placeholders were, the errors about the placeholders are replaced. They are not
 * deleted: they are dismissed by whoever wrote the words and stay listed, with what they said. A finding is replaced when what it
 * describes is no longer so:
 *
 * - "Option C has no text" goes when that option, which is found by the place it had, now has words (or is gone);
 * - "only one option" and "no options" go when there are two or more options and none of them is a placeholder.
 *
 * So a question with two placeholders and one of them written over keeps the other's error, and a placeholder typed in again,
 * or left as it was, keeps all of them. It reads the question as it is, not what the edit did, so an error that went stale
 * before this rule existed goes at the next edit too. Nothing else is touched.
 */
export function replacePlaceholderProblems(before: Question, after: Question, by: string, at: string): { question: Question; replaced: Finding[] } {
  const none = { question: after, replaced: [] as Finding[] };
  const options = optionsOf(after);
  if (options.length === 0) return none;
  const live = after.findings.filter((f) => !f.dismissed && PLACEHOLDER_PROBLEMS.has(f.code));
  if (live.length === 0) return none;

  const allWritten = options.length >= 2 && options.every((o) => !isPlaceholderOption(o));
  const earlier = optionsOf(before);
  const settled = (f: Finding): boolean => {
    if (allWritten) return true;
    if (f.code !== FindingCode.EmptyOption) return false;
    const place = /^body\.options\.(\d+)\.content$/.exec(f.field ?? "")?.[1];
    const was = place === undefined ? undefined : earlier[Number(place)];
    if (!was || !isPlaceholderOption(was)) return false;
    const now = options.find((o) => o.id === was.id);
    return now === undefined || !isPlaceholderOption(now);
  };

  const replaced = live.filter(settled);
  if (replaced.length === 0) return none;
  const dismissed = new Set(replaced);
  return {
    question: { ...after, findings: after.findings.map((f) => (dismissed.has(f) ? { ...f, dismissed: true, dismissedBy: by, dismissedAt: at } : f)) },
    replaced,
  };
}
