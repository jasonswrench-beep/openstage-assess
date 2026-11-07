/**
 * The words people write for a question's difficulty and Bloom level, and the level each one means.
 *
 * The text reader (a "Difficulty: hard" line) and the table reader (a Difficulty column) both read them, so they are written once:
 * a word one of them knows and the other does not would be the same question read two ways. A word that is not here is not
 * guessed at; each reader keeps it as written and says so.
 */

import type { BloomLevel, Difficulty } from "../model/question.ts";

export const DIFFICULTY_WORDS: Record<string, Difficulty> = {
  easy: "easy",
  simple: "easy",
  low: "easy",
  "1": "easy",
  moderate: "medium",
  medium: "medium",
  average: "medium",
  "2": "medium",
  hard: "hard",
  difficult: "hard",
  challenging: "hard",
  high: "hard",
  "3": "hard",
};

export const BLOOM_WORDS: Record<string, BloomLevel> = {
  remember: "remember",
  remembering: "remember",
  knowledge: "remember",
  recall: "remember",
  understand: "understand",
  understanding: "understand",
  comprehension: "understand",
  apply: "apply",
  application: "apply",
  applying: "apply",
  analyze: "analyze",
  analyse: "analyze",
  analysis: "analyze",
  evaluate: "evaluate",
  evaluation: "evaluate",
  synthesis: "create",
  create: "create",
  creating: "create",
};

/** The level a word means, or undefined. Only the table's own entries count, so a word such as "constructor" is not a level. */
export const difficultyOf = (word: string): Difficulty | undefined => (Object.hasOwn(DIFFICULTY_WORDS, word) ? DIFFICULTY_WORDS[word] : undefined);
export const bloomOf = (word: string): BloomLevel | undefined => (Object.hasOwn(BLOOM_WORDS, word) ? BLOOM_WORDS[word] : undefined);
