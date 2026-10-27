/**
 * Identifiers.
 *
 * A question id is minted once and never rewritten: not on import, not on
 * copy, not on merge, and not when a question moves into OpenStage Author or
 * OpenStage Scroll. Everything that links to a question links to this string.
 *
 * The format is a prefix plus a 26-character Crockford base32 value whose
 * first 10 characters encode the creation time in milliseconds. That makes ids
 * sortable by creation order without carrying a separate timestamp, and makes
 * a collision between two authors working offline effectively impossible.
 */

import { randomBytes } from "node:crypto";

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // Crockford base32, no I L O U
const TIME_LEN = 10;
const RANDOM_LEN = 16;

function encodeTime(ms: number): string {
  let out = "";
  let value = ms;
  for (let i = TIME_LEN - 1; i >= 0; i--) {
    out = ALPHABET[value % 32] + out;
    value = Math.floor(value / 32);
  }
  return out;
}

function encodeRandom(): string {
  const bytes = randomBytes(RANDOM_LEN);
  let out = "";
  for (let i = 0; i < RANDOM_LEN; i++) {
    out += ALPHABET[(bytes[i] as number) % 32];
  }
  return out;
}

/** The raw 26-character value, without a prefix. */
export function newUlid(now: number = Date.now()): string {
  return encodeTime(now) + encodeRandom();
}

export type IdPrefix = "q" | "bank" | "m" | "e" | "o" | "f" | "t" | "flt";

export function newId(prefix: IdPrefix, now?: number): string {
  return `${prefix}_${newUlid(now)}`;
}

export const newQuestionId = (now?: number) => newId("q", now);
export const newBankId = (now?: number) => newId("bank", now);
export const newMediaId = (now?: number) => newId("m", now);
export const newMathId = (now?: number) => newId("e", now);
export const newFolderId = (now?: number) => newId("f", now);
export const newTestId = (now?: number) => newId("t", now);
export const newFilterId = (now?: number) => newId("flt", now);

/**
 * Option, blank, pair and item ids are local to one question, so they are
 * short and readable rather than globally unique. They never leave the
 * question that owns them.
 */
export function localId(prefix: string, index: number): string {
  return `${prefix}${index + 1}`;
}

const ID_PATTERN = /^(q|bank|m|e|o|f|t|flt)_[0-9ABCDEFGHJKMNPQRSTVWXYZ]{26}$/;

export function isId(value: unknown, prefix?: IdPrefix): value is string {
  if (typeof value !== "string" || !ID_PATTERN.test(value)) return false;
  if (prefix && !value.startsWith(`${prefix}_`)) return false;
  return true;
}

/** Milliseconds encoded in an id, for sorting or display. */
export function idTime(id: string): number | undefined {
  const value = id.includes("_") ? id.slice(id.indexOf("_") + 1) : id;
  if (value.length !== TIME_LEN + RANDOM_LEN) return undefined;
  let ms = 0;
  for (let i = 0; i < TIME_LEN; i++) {
    const digit = ALPHABET.indexOf(value[i] as string);
    if (digit < 0) return undefined;
    ms = ms * 32 + digit;
  }
  return ms;
}
