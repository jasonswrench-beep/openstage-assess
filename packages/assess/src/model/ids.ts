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

/**
 * The random part, as digits. A second id made in the same millisecond as the last is that one plus one, not a fresh
 * random value. An import makes dozens of questions in one millisecond, and ids that sort by time were sorting them in
 * random order within it: a bank came out with its questions shuffled, and a test printed from it with them out of order.
 * Counting up keeps ids in the order they were made, and two of them cannot be equal.
 */
let lastTime = -1;
let lastDigits: number[] = [];

function nextDigits(time: number): number[] {
  if (time === lastTime && lastDigits.length === RANDOM_LEN) {
    const next = [...lastDigits];
    for (let i = RANDOM_LEN - 1; i >= 0; i--) {
      if ((next[i] as number) < 31) {
        next[i] = (next[i] as number) + 1;
        lastDigits = next;
        return next;
      }
      next[i] = 0;
    }
    // Every digit was at its largest: more than 2^80 ids in one millisecond. Start again rather than wrap to a smaller one.
  }
  const bytes = randomBytes(RANDOM_LEN);
  // The first digit is kept below the top, so that a run of ids made in one millisecond has room to count up.
  const fresh = Array.from(bytes, (b, i) => (i === 0 ? (b % 16) : b % 32));
  lastTime = time;
  lastDigits = fresh;
  return fresh;
}

/** The raw 26-character value, without a prefix. */
export function newUlid(now: number = Date.now()): string {
  return encodeTime(now) + nextDigits(now).map((d) => ALPHABET[d]).join("");
}

export type IdPrefix = "q" | "bank" | "m" | "e" | "o" | "f" | "t" | "flt" | "adm";

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
/** An administration: one test given to one class, whose figures a bank keeps. */
export const newAdministrationId = (now?: number) => newId("adm", now);

/**
 * Option, blank, pair and item ids are local to one question, so they are
 * short and readable rather than globally unique. They never leave the
 * question that owns them.
 */
export function localId(prefix: string, index: number): string {
  return `${prefix}${index + 1}`;
}

const ID_PATTERN = /^(q|bank|m|e|o|f|t|flt|adm)_[0-9ABCDEFGHJKMNPQRSTVWXYZ]{26}$/;

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
