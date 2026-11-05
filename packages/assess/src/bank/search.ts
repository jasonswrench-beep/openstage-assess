/**
 * Search.
 *
 * An in-memory inverted index, built after the bank is open rather than stored
 * in the file. That keeps the format plain JSON that a human can read and a
 * shared folder can merge, and it costs a few milliseconds at open time on a
 * bank of the size this tool is for.
 *
 * The index covers everything a person would search a bank by: the title, the
 * stem, every option, the tags, and the metadata values. Answer choices and
 * feedback are always included, because excluding them only ever surprises
 * people.
 */

import { richTextToPlain } from "../model/richtext.ts";
import { liveFindings } from "../model/findings.ts";
import type { Query } from "../model/bank.ts";
import type { Question } from "../model/question.ts";

const STOP_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "but", "by", "for", "if", "in",
  "into", "is", "it", "no", "not", "of", "on", "or", "such", "that", "the",
  "their", "then", "there", "these", "they", "this", "to", "was", "will", "with",
]);

/** Letters that do not come apart into a letter and a mark, folded by hand to what a person types without them. */
const FOLDED: Record<string, string> = { "ß": "ss", "æ": "ae", "œ": "oe", "ø": "o", "đ": "d", "ł": "l", "ð": "d", "þ": "th", "ı": "i" };

/**
 * The text as it is searched: lower case, with accents taken off. A person searching for "nucleo" means "núcleo", and one
 * searching for "für" means "für", and the index used to hold neither, because it split on anything that was not a to z, so
 * "für" came out as two single letters that were both dropped and "núcleo" as two words. Both sides, the question and the search,
 * are folded the same way, so either spelling finds either.
 */
export function fold(text: string): string {
  return (
    text
      .normalize("NFD")
      // Only the combining marks that sit on Latin, Greek and Cyrillic letters (U+0300 to U+036F). The marks of other scripts, such
      // as the vowel signs of Hindi, are part of the word and stay; and the text goes back to NFC so that Korean is whole again.
      .replace(/[̀-ͯ]+/g, "")
      .normalize("NFC")
      .toLowerCase()
      .replace(/[ßæœøđłðþı]/g, (c) => FOLDED[c] ?? c)
  );
}

/** A letter that is a whole word on its own in the scripts that are written without spaces. */
const ONE_CHARACTER_WORD = /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]$/u;

/**
 * Single letters are dropped, single digits are kept. People search a bank for
 * "chapter 5" and "question 3" all the time, and a tokenizer that throws away
 * one-character tokens wholesale makes both of those silently return nothing.
 * A single character of Chinese, Japanese or Korean is a word, so it is kept.
 */
export function tokenize(text: string): string[] {
  return words(text).filter(isIndexed);
}

/** Every word of a text, folded, with nothing left out: the stop words and the single letters too. */
function words(text: string): string[] {
  return fold(text)
    .split(/[^\p{L}\p{M}\p{N}]+/u)
    .filter((t) => t !== "");
}

/** What goes in the index: not a stop word, not a single letter (but a single digit, or a single character of Chinese, Japanese or Korean). */
function isIndexed(t: string): boolean {
  return (t.length > 1 || /^\p{N}$/u.test(t) || ONE_CHARACTER_WORD.test(t)) && !STOP_WORDS.has(t);
}

/** Everything about a question that free text should match. */
export function searchableText(question: Question): string {
  const parts: string[] = [question.title, richTextToPlain(question.stem)];

  const body = question.body as Record<string, unknown>;
  const pushRich = (value: unknown) => {
    if (value && typeof value === "object" && "content" in (value as object)) {
      parts.push(richTextToPlain(value as { format: "rich" | "plain"; content: string }));
    }
  };

  for (const key of ["options", "items", "pairs"]) {
    const list = body[key];
    if (Array.isArray(list)) {
      for (const entry of list as Array<Record<string, unknown>>) {
        pushRich(entry["content"]);
        pushRich(entry["left"]);
        pushRich(entry["feedback"]);
        if (typeof entry["right"] === "string") parts.push(entry["right"] as string);
      }
    }
  }
  if (Array.isArray(body["blanks"])) {
    for (const blank of body["blanks"] as Array<{ accepted?: string[]; label?: string }>) {
      if (blank.label) parts.push(blank.label);
      if (blank.accepted) parts.push(blank.accepted.join(" "));
    }
  }
  if (Array.isArray(body["accepted"])) parts.push((body["accepted"] as string[]).join(" "));
  if (Array.isArray(body["distractors"])) parts.push((body["distractors"] as string[]).join(" "));
  pushRich(body["modelAnswer"]);
  pushRich(body["alternative"]);

  pushRich(question.feedback.general);
  pushRich(question.feedback.correct);
  pushRich(question.feedback.incorrect);

  const m = question.metadata;
  parts.push(m.tags.join(" "));
  for (const value of [m.objective, m.chapter, m.section, m.page, m.author, m.bloom, m.difficulty]) {
    if (value) parts.push(value);
  }
  if (m.custom) parts.push(Object.values(m.custom).join(" "));
  for (const media of question.media) parts.push(media.alt);

  return parts.filter(Boolean).join(" \n ");
}

export class SearchIndex {
  /** token -> question ids */
  private readonly tokens = new Map<string, Set<string>>();
  /**
   * question id -> its tokens. Taking a question out used to walk every token in the index, so building one was quadratic: 4,000
   * questions took 4.7 seconds. With this it takes only the question's own tokens.
   */
  private readonly byQuestion = new Map<string, string[]>();
  /** Sorted token list, for prefix matching on the last word typed. */
  private sorted: string[] = [];
  private dirty = false;

  add(question: Question): void {
    this.remove(question.id);
    const own = [...new Set(tokenize(searchableText(question)))];
    for (const token of own) {
      let bucket = this.tokens.get(token);
      if (!bucket) {
        bucket = new Set();
        this.tokens.set(token, bucket);
      }
      bucket.add(question.id);
    }
    this.byQuestion.set(question.id, own);
    this.dirty = true;
  }

  remove(id: string): void {
    for (const token of this.byQuestion.get(id) ?? []) {
      const bucket = this.tokens.get(token);
      if (bucket?.delete(id) && bucket.size === 0) this.tokens.delete(token);
    }
    this.byQuestion.delete(id);
    this.dirty = true;
  }

  /** Forget everything, so that an index built again holds only what is added to it. */
  clear(): void {
    this.tokens.clear();
    this.byQuestion.clear();
    this.sorted = [];
    this.dirty = false;
  }

  private ensureSorted(): void {
    if (!this.dirty) return;
    this.sorted = [...this.tokens.keys()].sort();
    this.dirty = false;
  }

  private prefixMatches(prefix: string): Set<string> {
    this.ensureSorted();
    const out = new Set<string>();
    // Binary search for the first token >= prefix, then walk while it matches.
    let lo = 0;
    let hi = this.sorted.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((this.sorted[mid] as string) < prefix) lo = mid + 1;
      else hi = mid;
    }
    for (let i = lo; i < this.sorted.length; i++) {
      const token = this.sorted[i] as string;
      if (!token.startsWith(prefix)) break;
      for (const id of this.tokens.get(token) ?? []) out.add(id);
    }
    return out;
  }

  /**
   * All words must match. The last word is treated as a prefix, so results
   * narrow as a person types rather than vanishing between keystrokes.
   */
  search(text: string): Set<string> {
    // The word being typed is kept whatever it is. A stop word or a single letter is not in the index, so it would be dropped from
    // the search, and "at" found nothing while "ato" found "atom" (and "in" found nothing while "ins" found "insulin"): the results
    // vanished and came back between two keystrokes. As the last word it is only a prefix, which is what it is while it is typed.
    // A stop word or a short one before the last is still left out, since a word that is not in the index can match nothing.
    const typed = words(text);
    const last = typed.length - 1;
    const before = typed.slice(0, last).filter(isIndexed);
    const end = typed[last];
    if (end === undefined) return new Set();
    if (isIndexed(end) || before.length === 0) return this.find([...before, end]);
    // A stop word that ends a search that has other words ("capital of"): it narrows nothing, which is what a stop word means, and
    // the results stay as they were for "capital" until the next word is begun. Alone ("at"), it is all there is to go on, so it is
    // searched for by what it begins.
    return this.find(before);
  }

  private find(words: string[]): Set<string> {
    if (words.length === 0) return new Set();
    let result: Set<string> | undefined;
    words.forEach((word, i) => {
      const isLast = i === words.length - 1;
      const matches = isLast ? this.prefixMatches(word) : (this.tokens.get(word) ?? new Set<string>());
      if (result === undefined) {
        result = new Set(matches);
      } else {
        for (const id of [...result]) if (!matches.has(id)) result.delete(id);
      }
    });
    return result ?? new Set();
  }

  get size(): number {
    return this.tokens.size;
  }
}

function inList<T>(value: T | undefined, list: T[] | undefined): boolean {
  if (!list || list.length === 0) return true;
  return value !== undefined && list.includes(value);
}

/** The structured half of a query. Free text is applied by the index. */
export function matchesQuery(question: Question, query: Query, folderOf?: Map<string, string>): boolean {
  if (!inList(question.type, query.types)) return false;
  if (!inList(question.metadata.status, query.statuses)) return false;
  if (!inList(question.metadata.bloom, query.bloom)) return false;
  if (!inList(question.metadata.difficulty, query.difficulty)) return false;
  if (!inList(question.metadata.chapter, query.chapter)) return false;
  if (!inList(question.metadata.objective, query.objective)) return false;

  if (query.tags && query.tags.length > 0) {
    const tags = new Set(question.metadata.tags);
    if (!query.tags.some((t) => tags.has(t))) return false;
  }
  if (query.folderId !== undefined) {
    if (folderOf?.get(question.id) !== query.folderId) return false;
  }
  if (query.minPoints !== undefined && question.points < query.minPoints) return false;
  if (query.maxPoints !== undefined && question.points > query.maxPoints) return false;

  if (query.hasFindings) {
    const live = liveFindings(question.findings);
    if (query.hasFindings === "any" && live.length === 0) return false;
    if (query.hasFindings === "error" && !live.some((f) => f.severity === "error")) return false;
    if (query.hasFindings === "warn" && !live.some((f) => f.severity === "warn")) return false;
  }
  return true;
}
