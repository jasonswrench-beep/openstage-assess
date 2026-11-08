/**
 * The folder where a person's banks and exports live, and the names inside it.
 *
 * Every file the app writes goes under one folder, and a name that comes from outside is checked before it is joined to a
 * path, so nothing a web page or a file asks for can reach anywhere else.
 */

import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, link, lstat, mkdir, readdir, rm, unlink, writeFile } from "node:fs/promises";
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
// The names Windows keeps for devices, with or without an extension: CON, PRN, AUX, NUL, COM0 to COM9 and LPT0 to LPT9 (the
// superscript digits too, which Windows treats as digits here), and the two console names. Spaces before the dot do not help: "con .txt"
// is the device as well, which is how Windows reads it and how the engine's `safeName` reads it.
const DEVICE = "(?:con|prn|aux|nul|conin\\$|conout\\$|com[0-9¹²³]|lpt[0-9¹²³])";
const RESERVED = new RegExp(`^${DEVICE}( *\\..*)?$`, "i");
/** A device's name at the start of a title, when a dot (or the end of the title) follows it, which is when Windows takes the whole for the device. */
const DEVICE_START = new RegExp(`^${DEVICE}(?= *(?:\\.|$))`, "i");
/** A title with a device's name and nothing else in it. */
const BARE_DEVICE = new RegExp(`^${DEVICE}$`, "i");

/** The longest name `checkName` takes, in the units `String.length` counts. */
const MAX_NAME = 80;

// `isWellFormed` and `toWellFormed` are in every Node this app runs on (22.6 and later), and not yet in the library files the type
// checker is set to, so they are reached through a type of their own.
interface WellFormed {
  isWellFormed(): boolean;
  toWellFormed(): string;
}
const isWellFormed = (text: string): boolean => (text as unknown as WellFormed).isWellFormed();
const wellFormed = (text: string): string => (text as unknown as WellFormed).toWellFormed();

const graphemes = typeof Intl.Segmenter === "function" ? new Intl.Segmenter(undefined, { granularity: "grapheme" }) : null;

/**
 * The first `n` units of `text` that end between two characters as a person sees them: an emoji is two units, a flag is four, a family
 * is eleven, and a letter with its accent may be two. A cut between the two halves of an emoji left a lone surrogate that made a name
 * `encodeURIComponent` refuse ("URI malformed" in place of a finished export), found by a reader who cut names at every length; a cut
 * inside a flag or a family is no error and still is not what the person wrote. Where the platform cannot tell (`segmenter` is null),
 * only a pair is kept whole. The segmenter is a parameter so that a test can take the platform's away.
 */
export function cutAt(text: string, n: number, segmenter: Intl.Segmenter | null = graphemes): string {
  if (text.length <= n) return text;
  const room = Math.max(0, n);
  if (segmenter) {
    let end = 0;
    for (const { segment } of segmenter.segment(text)) {
      if (end + segment.length > room) break;
      end += segment.length;
    }
    return text.slice(0, end);
  }
  const cut = text.slice(0, room);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

/** `text` without the dots and spaces at its end. */
function withoutTrailingDotsAndSpaces(text: string): string {
  let end = text.length;
  while (end > 0 && (text[end - 1] === "." || text[end - 1] === " ")) end--;
  return text.slice(0, end);
}

/**
 * A name made safe, for one that is derived from a title or a file: illegal characters become dashes, a lone half of an emoji becomes
 * the replacement character (a name with one is a name the screen cannot put in an address, and the file system would have changed it
 * to that character anyway, so the name told to the person was not the name of the file), and a title that begins with the name of a
 * Windows device keeps its words with an underscore after the device's name, as the engine's `safeName` does ("Aux. Verbs" is
 * "Aux_. Verbs"). A title that is nothing but a device's name, or has nothing in it, has no words to keep and is the fallback.
 */
export function cleanName(input: string, fallback = "Untitled"): string {
  // The dots and spaces at the start go together, in one pattern, after the white space is tidied: a space left behind by the dots
  // ("Intro" from ". Intro") made a name `checkName` refuses, and a cut made before the end is tidied can end in a dot or a space.
  const tidy = wellFormed(input)
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[. ]+/, "");
  // The dots and spaces at the end are taken off by a plain scan: a pattern for them starts again at every dot of a run, and a title may
  // be as long as a request can be.
  const whole = withoutTrailingDotsAndSpaces(tidy);
  if (whole === "" || BARE_DEVICE.test(whole)) return fallback;
  const cleaned = withoutTrailingDotsAndSpaces(cutAt(whole.replace(DEVICE_START, (word) => `${word}_`), MAX_NAME));
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
  const head = withoutTrailingDotsAndSpaces(cutAt(stem, room));
  return `${head}…${tail}${ext}`;
}

/** The names a check lists, as they will be written: the same cut as the file gets. */
export function fitNames<T extends { files: readonly string[] }>(report: T): T {
  return { ...report, files: report.files.map((file) => fitFileName(file)) };
}

/**
 * A name that came from outside, which is used as it is or refused. A name that needed changing is not the name asked for, and that
 * includes one with a lone half of an emoji in it: made well formed it would be another name, and left as it is it cannot be put in
 * an address.
 */
export function checkName(name: unknown): string {
  if (typeof name !== "string" || name === "") throw badRequest("A name is needed.");
  if (name.length > MAX_NAME || !isWellFormed(name) || ILLEGAL.test(name) || name !== name.trim() || /^\.|[. ]$/.test(name) || RESERVED.test(name)) {
    throw badRequest("That name cannot be used as a file name.");
  }
  return name;
}

export const bankFile = (library: Library, name: string): string => join(library.banks, `${checkName(name)}${BANK_EXTENSION}`);

export function insideLibrary(library: Library, path: string): boolean {
  const target = resolve(path);
  return target === library.home || target.startsWith(library.home + sep);
}

// ---------------------------------------------------------------------------------------------------------------------------
// Writing a new file under a name that is free
// ---------------------------------------------------------------------------------------------------------------------------

/**
 * The calls on the file system that finding a free name uses, together, so that a test can make any one of them fail and see what is
 * left. The real ones are `fileOps`.
 */
export interface FileOps {
  /** Makes the folder, and the folders above it, if they are not there: a library folder taken away while the app runs comes back. */
  mkdir(dir: string): Promise<void>;
  /** The names in a folder. */
  list(dir: string): Promise<string[]>;
  /** Writes a new file, and fails with EEXIST if the name is taken. */
  createFile(path: string, data: string | Uint8Array): Promise<void>;
  /** A second name for a file that exists, and fails with EEXIST if the name is taken. */
  link(existing: string, path: string): Promise<void>;
  /** A copy of a file that exists, and fails with EEXIST if the name is taken. */
  copyNew(existing: string, path: string): Promise<void>;
  /** Takes a name off a file, which is gone when it has no other. */
  unlink(path: string): Promise<void>;
  /** Takes away a file or folder if it is there, and says nothing if it is not. */
  remove(path: string): Promise<void>;
  /** Whether anything (a file, a folder) is under the name. */
  exists(path: string): Promise<boolean>;
}

/** Whether the system said a file is busy for the moment, which is often over a few milliseconds later. */
const busy = (error: unknown): boolean => ["EPERM", "EBUSY", "EACCES"].includes((error as { code?: string } | null)?.code ?? "");

/**
 * Takes a name off a file, trying again a few times when the system says the file is busy: a name taken off a file that a virus scanner
 * is looking at is refused on Windows for a moment, as a rename onto it is. Any other refusal (the file is not there) is the first
 * answer. It is the last step of moving a bank to Deleted: the bank has two names until it succeeds.
 */
export async function unlinkWhenFree(path: string, take: (path: string) => Promise<void> = unlink, tries = 4): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await take(path);
    } catch (error) {
      if (attempt >= tries || !busy(error)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 15 * attempt));
    }
  }
}

export const fileOps: FileOps = {
  mkdir: async (dir) => void (await mkdir(dir, { recursive: true })),
  list: (dir) => readdir(dir),
  createFile: (path, data) => writeFile(path, data, { flag: "wx" }),
  link: (existing, path) => link(existing, path),
  copyNew: (existing, path) => copyFile(existing, path, constants.COPYFILE_EXCL),
  unlink: (path) => unlinkWhenFree(path),
  remove: (path) => rm(path, { recursive: true, force: true }),
  exists: (path) => lstat(path).then(
    () => true,
    () => false,
  ),
};

/** Whether a file system call failed because the file is already there. */
const alreadyThere = (error: unknown): boolean => (error as { code?: string } | null)?.code === "EEXIST";

/** How many names are tried before the folder is called full: the name itself and then 2 to 9,999. */
const MOST_NAMES = 10_000;

/**
 * The `n`th name for a file: the name itself, then `name 2.ext`, `name 3.ext`. The number is counted in the length, and every name
 * is within the longest `checkName` takes, because the app downloads and opens files by name and checks it again then: a second
 * export of a title that fitted exactly was 82 long, was written, and could not be downloaded.
 */
function numberedFileName(name: string, n: number): string {
  if (n === 1) return fitFileName(name);
  const number = ` ${n}`;
  const fitted = fitFileName(name, MAX_NAME - number.length);
  const ext = extname(fitted);
  return `${fitted.slice(0, fitted.length - ext.length)}${number}${ext}`;
}

/** The `n`th name for a bank (before its extension): the name, then `name 2`, `name 3`, with the number counted in the length. */
function numberedBankName(base: string, n: number): string {
  if (n === 1) return base;
  const number = ` ${n}`;
  return `${withoutTrailingDotsAndSpaces(cutAt(base, MAX_NAME - number.length))}${number}`;
}

/**
 * Writes a new file under `name`, or under `name 2`, `name 3` if that is taken, and says which. A file is never written over: the
 * name is claimed by creating the file (`wx` fails if it is there), and not by looking first and writing after, because with a look
 * first six exports asked for at once were all given the same name and wrote over each other, and a second copy of the app on the
 * same folder could do the same. A write that fails for any other reason is not taken for a name that is taken (a folder that is
 * full would otherwise be asked 9,999 times), and what it had started is taken away.
 */
export async function writeNewFile(dir: string, name: string, data: string | Uint8Array, io: FileOps = fileOps): Promise<string> {
  await io.mkdir(dir);
  for (let n = 1; n < MOST_NAMES; n++) {
    const candidate = numberedFileName(name, n);
    const path = join(dir, candidate);
    try {
      await io.createFile(path, data);
      return candidate;
    } catch (error) {
      if (alreadyThere(error)) continue;
      await io.remove(path).catch(() => undefined); // a file that was started and not finished is not left behind
      throw error;
    }
  }
  throw badRequest("There are too many files with that name. Move some out of the folder.");
}

/**
 * Gives a file that is finished a name in `dir`, and says which: `name`, or `name 2`, `name 3` if that is taken. The name is claimed
 * by a hard link, which fails if the name is there and otherwise makes the file appear under it whole, so no one who looks in the
 * folder ever sees a file with the name that is empty or half written. (The first version claimed a name by creating an empty file
 * and having the save rename over it. On Windows a rename onto a file that something has open is refused, so a bank could not be made
 * while the home screen's list, a second window or a virus scanner had the empty file open: 94 to 99 of 100 were made under a
 * reader, and a crash left an empty file that could not be opened, renamed or removed. A link under the same readers: 900 of 900.)
 * The caller is left holding `source` and takes it away when it has no use for it.
 *
 * Where the volume cannot make links (a FAT or exFAT drive, some network shares, which say EPERM, ENOTSUP, EXDEV or UNKNOWN), the
 * file is copied instead, with a copy that fails if the name is taken. Then a reader can see the file half copied for a moment, and a
 * crash in that moment leaves it so; it is listed as a bank that cannot be read, and can be removed. That is the price of a volume
 * that gives no better.
 */
export async function placeFile(dir: string, base: string, extension: string, source: string, io: FileOps = fileOps): Promise<string> {
  await io.mkdir(dir);
  for (let n = 1; n < MOST_NAMES; n++) {
    const candidate = numberedBankName(base, n);
    if (await takeName(source, join(dir, `${candidate}${extension}`), io)) return candidate;
  }
  throw badRequest("There are too many files with that name. Move some out of the folder.");
}

/** Whether `path` is now a second name for `source`; false when the name was taken. Any other failure is the caller's. */
async function takeName(source: string, path: string, io: FileOps): Promise<boolean> {
  try {
    await io.link(source, path);
    return true;
  } catch (error) {
    if (alreadyThere(error)) return false;
    // Not a name that is taken: most likely a volume that makes no links. The copy is tried for this name, and its failure is the one told.
  }
  try {
    await io.copyNew(source, path);
    return true;
  } catch (error) {
    // Some systems say a folder in the way in other words than "already there", and a name with a folder under it is a name that is taken.
    if (alreadyThere(error) || (await io.exists(path))) return false;
    throw error;
  }
}

/**
 * Makes a file with `make` under a name that is never listed (it does not end in the bank extension), and gives it its name in `dir`
 * with `placeFile`; the private name is taken away afterwards, and also when anything fails, so that a failed save leaves no file at
 * all. A crash between the two leaves the finished file under its private name, which nothing lists or opens.
 */
export async function placeMade(dir: string, base: string, extension: string, make: (privatePath: string) => Promise<unknown>, io: FileOps = fileOps): Promise<string> {
  await io.mkdir(dir);
  const temp = join(dir, `.new-${randomBytes(8).toString("hex")}.tmp`);
  try {
    await make(temp);
    return await placeFile(dir, base, extension, temp, io);
  } finally {
    await io.remove(temp).catch(() => undefined);
  }
}

export async function bankNames(library: Library, io: FileOps = fileOps): Promise<string[]> {
  await io.mkdir(library.banks);
  const files = await io.list(library.banks);
  return files
    .filter((f) => f.toLowerCase().endsWith(BANK_EXTENSION))
    .map((f) => f.slice(0, -BANK_EXTENSION.length))
    .sort((a, b) => a.localeCompare(b));
}
