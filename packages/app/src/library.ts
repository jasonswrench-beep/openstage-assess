/**
 * The folder where a person's banks and exports live, and the names inside it.
 *
 * Every file the app writes goes under one folder, and a name that comes from outside is checked before it is joined to a
 * path, so nothing a web page or a file asks for can reach anywhere else.
 */

import { mkdir, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { extname, join, resolve, sep } from "node:path";

import { BANK_EXTENSION } from "./engine.ts";
import { badRequest } from "./errors.ts";

export interface Library {
  home: string;
  banks: string;
  exports: string;
  /** Scores files: the readings, decisions and adjustments of a class of answer sheets. Never a name, a file name or a picture. */
  scores: string;
  /** A bank that was removed is moved here, not deleted, so that it can be got back. */
  deleted: string;
}

export function defaultHome(): string {
  return process.env["OPENASSESS_HOME"] ?? join(homedir(), "Documents", "OpenAssess");
}

export async function openLibrary(home: string = defaultHome()): Promise<Library> {
  const root = resolve(home);
  const library: Library = { home: root, banks: join(root, "Banks"), exports: join(root, "Exports"), scores: join(root, "Scores"), deleted: join(root, "Deleted") };
  for (const dir of [library.banks, library.exports, library.scores, library.deleted]) await mkdir(dir, { recursive: true });
  return library;
}

const ILLEGAL = /[\\/:*?"<>|\u0000-\u001f]/;
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/** The longest name `checkName` takes, in the units `String.length` counts. */
const MAX_NAME = 80;

/**
 * The first `n` units of `text`, without half of a character: an emoji is two units, and a cut between them left a lone surrogate that
 * made a name `encodeURIComponent` refuses ("URI malformed" in place of a finished export), found by a reader who cut names at every
 * length. The unit at the end is dropped when it is the first half of a pair.
 */
function cutAt(text: string, n: number): string {
  const cut = text.slice(0, Math.max(0, n));
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff && cut.length < text.length ? cut.slice(0, -1) : cut;
}

/** A name made safe, for one that is derived from a title or a file: illegal characters become dashes. */
export function cleanName(input: string, fallback = "Untitled"): string {
  // The dots and spaces at the start go together, in one pattern, after the white space is tidied: a space left behind by the dots
  // ("Intro" from ". Intro") made a name `checkName` refuses, and a cut made before the end is tidied can end in a dot or a space.
  const cleaned = cutAt(
    input
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "-")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/^[. ]+/, ""),
    MAX_NAME,
  ).replace(/[. ]+$/, "");
  return cleaned === "" || RESERVED.test(cleaned) ? fallback : cleaned;
}

/**
 * A name the program made itself (a bank's title with the kind of file after it, then its extension), fitted to the longest name
 * `checkName` takes. It is cut and not refused: `checkName` is for names that come from outside, where a name that needs changing is
 * not the name asked for, and these did not come from anyone. A title of 62 characters already made a Common Cartridge export and a
 * printed test fail with "That name cannot be used as a file name", after the check had passed; at 80 every destination did.
 * The start of the title and the end of the name (the kind of file, and a version) are what tell two files apart, so the cut goes
 * between them and is marked.
 */
export function fitFileName(name: string, limit = MAX_NAME): string {
  if (name.length <= limit) return name;
  const ext = extname(name);
  const stem = name.slice(0, name.length - ext.length);
  // The end worth keeping starts at the first " - " that leaves it no longer than 40 characters ("Version B - Answer key").
  let tailAt = stem.indexOf(" - ", Math.max(0, stem.length - 40));
  if (tailAt === -1) tailAt = stem.length;
  const tail = stem.slice(tailAt);
  const room = Math.max(1, limit - ext.length - tail.length - 1);
  const head = cutAt(stem, room).replace(/[. ]+$/, "");
  return `${head}…${tail}${ext}`;
}

/** The names a check lists, as they will be written: the same cut as the file gets. */
export function fitNames<T extends { files: readonly string[] }>(report: T): T {
  return { ...report, files: report.files.map((file) => fitFileName(file)) };
}

/** A name that came from outside, which is used as it is or refused. A name that needed changing is not the name asked for. */
export function checkName(name: unknown): string {
  if (typeof name !== "string" || name === "") throw badRequest("A name is needed.");
  if (name.length > MAX_NAME || ILLEGAL.test(name) || name !== name.trim() || /^\.|[. ]$/.test(name) || RESERVED.test(name)) {
    throw badRequest("That name cannot be used as a file name.");
  }
  return name;
}

export const bankFile = (library: Library, name: string): string => join(library.banks, `${checkName(name)}${BANK_EXTENSION}`);

export function insideLibrary(library: Library, path: string): boolean {
  const target = resolve(path);
  return target === library.home || target.startsWith(library.home + sep);
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** `wanted`, or `wanted 2`, `wanted 3` and so on, so that nothing is ever overwritten by a new file of the same name. */
export async function uniqueName(dir: string, wanted: string, extension: string): Promise<string> {
  const base = cleanName(wanted);
  for (let n = 1; n < 10_000; n++) {
    // The number is counted in the length: a name of 80 with " 2" after it was 82, and `checkName` refused the second bank of a
    // title that long, and a second import of the same long-named file.
    const number = ` ${n}`;
    const candidate = n === 1 ? base : `${cutAt(base, MAX_NAME - number.length).replace(/[. ]+$/, "")}${number}`;
    if (!(await exists(join(dir, `${candidate}${extension}`)))) return candidate;
  }
  throw badRequest("There are too many files with that name.");
}

/**
 * `name`, or `name 2.ext`, `name 3.ext`: a file that is already there is never written over. Every name it gives is within the
 * longest `checkName` takes, the number included, because the app downloads and opens files by name and checks it again then: a second
 * export of a title that fitted exactly was 82 long, was written, and could not be downloaded.
 */
export async function freeFileName(dir: string, name: string): Promise<string> {
  for (let n = 1; n < 10_000; n++) {
    let candidate: string;
    if (n === 1) candidate = fitFileName(name);
    else {
      const number = ` ${n}`;
      const fitted = fitFileName(name, MAX_NAME - number.length);
      const ext = extname(fitted);
      candidate = `${fitted.slice(0, fitted.length - ext.length)}${number}${ext}`;
    }
    if (!(await exists(join(dir, candidate)))) return candidate;
  }
  throw badRequest("There are too many files with that name. Move some out of the folder.");
}

export async function bankNames(library: Library): Promise<string[]> {
  const files = await readdir(library.banks);
  return files
    .filter((f) => f.toLowerCase().endsWith(BANK_EXTENSION))
    .map((f) => f.slice(0, -BANK_EXTENSION.length))
    .sort((a, b) => a.localeCompare(b));
}
