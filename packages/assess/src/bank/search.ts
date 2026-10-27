/**
 * Search.
 *
 * An in-memory inverted index, built after the bank is open rather than stored
 * in the file. That keeps the format plain JSON that a human can read and a
 * shared folder can merge, and it costs a few milliseconds at open time on a
 * bank of the size this tool is for.
 *
 * The index covers everything a person would search a bank by: the title, the
 * stem, every option, the tags, and the metadata values. the test-bank vendor lets you
 * choose whether answer choices and feedback are included; here they always
 * are, because excluding them only ever surprises people.
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

/**
 * Single letters are dropped, single digits are kept. People search a bank for
 * "chapter 5" and "question 3" all the time, and a tokenizer that throws away
 * one-character tokens wholesale makes both of those silently return nothing.
 */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => (t.length > 1 || /^[0-9]$/.test(t)) && !STOP_WORDS.has(t));
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
  /** Sorted token list, for prefix matching on the last word typed. */
  private sorted: string[] = [];
  private dirty = false;

  add(question: Question): void {
    this.remove(question.id);
    for (const token of new Set(tokenize(searchableText(question)))) {
      let bucket = this.tokens.get(token);
      if (!bucket) {
        bucket = new Set();
        this.tokens.set(token, bucket);
      }
      bucket.add(question.id);
    }
    this.dirty = true;
  }

  remove(id: string): void {
    for (const [token, bucket] of this.tokens) {
      if (bucket.delete(id) && bucket.size === 0) this.tokens.delete(token);
    }
    this.dirty = true;
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
    const words = tokenize(text);
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
