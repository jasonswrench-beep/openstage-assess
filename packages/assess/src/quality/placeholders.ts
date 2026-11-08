/**
 * Placeholders. A choice question needs two options with words, and a file does not always have them: an option with a letter
 * and no text, a question with one option, a question with none. The importer keeps the question, puts the words `(missing)` in
 * the place of each option it lacks, and says so with an error, so that the question can be shown beside its source text and
 * repaired. This is the other half: when the person writes the words in, the error that said they were missing is no longer
 * true, and goes. Without it the question stayed Failed, and unusable, after it was repaired.
 */

import { FindingCode, isCapSummary, type Finding } from "../model/findings.ts";
import { optionsOf, type Option, type Question } from "../model/question.ts";
import { collectRefs, richTextToPlain, type RichText } from "../model/richtext.ts";

/** What an importer writes into an option it does not have the words for. */
export const PLACEHOLDER_TEXT = "(missing)";

/** True for text that says nothing: the importer's placeholder, or no words and no picture or equation. */
export function isPlaceholderText(content: RichText | undefined): boolean {
  if (content === undefined) return true;
  const refs = collectRefs(content);
  if (refs.media.length > 0 || refs.math.length > 0) return false;
  const text = richTextToPlain(content).trim();
  return text === "" || text === PLACEHOLDER_TEXT;
}

/** True for an option that says nothing: the importer's placeholder, or no words and no picture or equation. */
export function isPlaceholderOption(option: Option): boolean {
  return isPlaceholderText(option.content);
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
 *
 * A question with more empty options than a list of findings holds (`capFindings`) has errors for the first of them and one finding
 * that counts the rest, whose place is only that of the first it counts. That one stands for several options, so it is not settled by
 * the option it names being written: it goes when every option that still says nothing has an error of its own that is still live, or
 * when there are none left. (It once went with the option it named, and the three options after it said "(missing)" with no error.)
 */
export function replacePlaceholderProblems(before: Question, after: Question, by: string, at: string): { question: Question; replaced: Finding[] } {
  const none = { question: after, replaced: [] as Finding[] };
  const options = optionsOf(after);
  if (options.length === 0) return none;
  const live = after.findings.filter((f) => !f.dismissed && PLACEHOLDER_PROBLEMS.has(f.code));
  if (live.length === 0) return none;

  const allWritten = options.length >= 2 && options.every((o) => !isPlaceholderOption(o));
  const earlier = optionsOf(before);
  /** The option an error names, by the place it had before this edit. */
  const optionNamedBy = (f: Finding): Option | undefined => {
    const place = /^body\.options\.(\d+)\.content$/.exec(f.field ?? "")?.[1];
    return place === undefined ? undefined : earlier[Number(place)];
  };
  const counts = (f: Finding): boolean => f.code === FindingCode.EmptyOption && isCapSummary(f);
  const settled = (f: Finding): boolean => {
    if (allWritten) return true;
    if (f.code !== FindingCode.EmptyOption) return false;
    const was = optionNamedBy(f);
    if (!was || !isPlaceholderOption(was)) return false;
    const now = options.find((o) => o.id === was.id);
    return now === undefined || !isPlaceholderOption(now);
  };

  const replaced = live.filter((f) => !counts(f) && settled(f));
  if (live.some(counts)) {
    // The options that still say nothing and that an error of their own still names.
    const named = new Set<string>();
    for (const f of live) {
      const was = counts(f) || replaced.includes(f) ? undefined : optionNamedBy(f);
      if (f.code === FindingCode.EmptyOption && was) named.add(was.id);
    }
    const unsaid = options.some((o) => isPlaceholderOption(o) && !named.has(o.id));
    if (allWritten || !unsaid) for (const f of live) if (counts(f)) replaced.push(f);
  }
  if (replaced.length === 0) return none;
  const dismissed = new Set(replaced);
  return {
    question: { ...after, findings: after.findings.map((f) => (dismissed.has(f) ? { ...f, dismissed: true, dismissedBy: by, dismissedAt: at } : f)) },
    replaced,
  };
}
