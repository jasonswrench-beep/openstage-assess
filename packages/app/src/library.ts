/**
 * The folder where a person's banks and exports live, and the names inside it.
 *
 * Every file the app writes goes under one folder, and a name that comes from outside is checked before it is joined to a
 * path, so nothing a web page or a file asks for can reach anywhere else.
 */

import { mkdir, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";

import { BANK_EXTENSION } from "./engine.ts";
import { badRequest } from "./errors.ts";

export interface Library {
  home: string;
  banks: string;
  exports: string;
  /** A bank that was removed is moved here, not deleted, so that it can be got back. */
  deleted: string;
}

export function defaultHome(): string {
  return process.env["OPENASSESS_HOME"] ?? join(homedir(), "Documents", "OpenAssess");
}

export async function openLibrary(home: string = defaultHome()): Promise<Library> {
  const root = resolve(home);
  const library: Library = { home: root, banks: join(root, "Banks"), exports: join(root, "Exports"), deleted: join(root, "Deleted") };
  for (const dir of [library.banks, library.exports, library.deleted]) await mkdir(dir, { recursive: true });
  return library;
}

const ILLEGAL = /[\\/:*?"<>|\u0000-\u001f]/;
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/** A name made safe, for one that is derived from a title or a file: illegal characters become dashes. */
export function cleanName(input: string, fallback = "Untitled"): string {
  const cleaned = input
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "")
    .replace(/[. ]+$/, "")
    .slice(0, 80)
    .trim();
  return cleaned === "" || RESERVED.test(cleaned) ? fallback : cleaned;
}

/** A name that came from outside, which is used as it is or refused. A name that needed changing is not the name asked for. */
export function checkName(name: unknown): string {
  if (typeof name !== "string" || name === "") throw badRequest("A name is needed.");
  if (name.length > 80 || ILLEGAL.test(name) || name !== name.trim() || /^\.|[. ]$/.test(name) || RESERVED.test(name)) {
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
    const candidate = n === 1 ? base : `${base} ${n}`;
    if (!(await exists(join(dir, `${candidate}${extension}`)))) return candidate;
  }
  throw badRequest("There are too many files with that name.");
}

export async function bankNames(library: Library): Promise<string[]> {
  const files = await readdir(library.banks);
  return files
    .filter((f) => f.toLowerCase().endsWith(BANK_EXTENSION))
    .map((f) => f.slice(0, -BANK_EXTENSION.length))
    .sort((a, b) => a.localeCompare(b));
}
