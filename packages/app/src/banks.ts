/**
 * The banks in the library: listing, opening, changing and saving them.
 *
 * A bank is held in memory once it is opened and written back after every change, through a temporary file and a rename
 * (the engine does that), so a change is on disk before the screen says it was made. Everything that changes or removes a
 * bank goes through one queue for that bank, so two changes never write the same file at once. A bank whose file changed
 * on disk since it was read is read again before it is used.
 */

import { rename, stat } from "node:fs/promises";
import { join } from "node:path";

import { Bank, BANK_EXTENSION, countMismatchMessage, type OpenReport } from "./engine.ts";
import { badRequest, HttpError, notFound } from "./errors.ts";
import { bankFile, bankNames, checkName, cleanName, uniqueName, type Library } from "./library.ts";

export interface BankInfo {
  name: string;
  title: string;
  questions: number;
  created: string;
  modified: string;
  bytes: number;
  /** Set when the file could not be read as a bank. It is listed, not hidden. */
  error?: string;
}

interface Held {
  bank: Bank;
  /** What was found when the file was read: files it could not read (kept as they were), and a count that did not match. */
  report: OpenReport;
  mtimeMs: number;
}

/** What is wrong with a bank as it was read, in words for the screen. Empty when nothing is. */
export interface BankProblems {
  /** Files in the bank that could not be read. They are kept exactly as they were, and are not lost. */
  unreadable: Array<{ id: string; message: string }>;
  /** Set when the bank opened with a different number of questions than it says it held. */
  count: string | null;
}

export class BankStore {
  readonly library: Library;
  private readonly held = new Map<string, Held>();
  /**
   * The end of the last piece of work queued for each bank. It is kept apart from `held` on purpose: a bank that is read
   * again because its file changed gets a new entry there, and a queue that went with it would split in two.
   */
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(library: Library) {
    this.library = library;
  }

  async list(): Promise<BankInfo[]> {
    const out: BankInfo[] = [];
    for (const name of await bankNames(this.library)) {
      const path = bankFile(this.library, name);
      try {
        const { bank } = await Bank.open(path);
        const info = await stat(path);
        out.push({
          name,
          title: bank.manifest.title,
          questions: bank.questions.size,
          created: bank.manifest.created,
          modified: bank.manifest.modified,
          bytes: info.size,
        });
      } catch (error) {
        out.push({ name, title: name, questions: 0, created: "", modified: "", bytes: 0, error: (error as Error).message });
      }
    }
    return out;
  }

  /** The bank, read from disk if it has not been read or its file has changed. */
  async open(name: string): Promise<Bank> {
    const path = bankFile(this.library, name);
    let info;
    try {
      info = await stat(path);
    } catch {
      this.held.delete(name);
      throw notFound(`There is no bank called "${name}".`);
    }
    const kept = this.held.get(name);
    if (kept && kept.mtimeMs === info.mtimeMs) return kept.bank;
    try {
      const { bank, report } = await Bank.open(path);
      this.held.set(name, { bank, report, mtimeMs: info.mtimeMs });
      return bank;
    } catch (error) {
      throw new HttpError(422, `The bank "${name}" could not be opened: ${(error as Error).message}`);
    }
  }

  /**
   * What was wrong with the bank when its file was read: questions and other files it could not read, which are kept as they were
   * and are not in the list, and a count that did not match. Without this a bank with an unreadable question looks complete.
   */
  async problems(name: string): Promise<BankProblems> {
    await this.open(name);
    const report = this.held.get(name)?.report;
    return {
      // Not the questions that were read and only had the wrong file name: they are in the list.
      unreadable: (report?.invalid ?? []).filter((entry) => !entry.loaded).map((entry) => ({ id: entry.id, message: entry.issues[0]?.message ?? "It could not be read." })),
      count: report?.countMismatch ? countMismatchMessage(report.countMismatch) : null,
    };
  }

  /** Runs `work` after everything already queued for this bank. A failure is passed on to the caller and does not stop the queue. */
  private exclusive<T>(name: string, work: () => Promise<T>): Promise<T> {
    const run = (this.queues.get(name) ?? Promise.resolve()).then(work);
    this.queues.set(
      name,
      run.catch(() => undefined),
    );
    return run;
  }

  /**
   * Change a bank and write it back. If anything fails, the bank in memory is dropped, so that what is shown next is what
   * is on disk and not a change that was never kept.
   */
  change<T>(name: string, fn: (bank: Bank) => T | Promise<T>): Promise<T> {
    checkName(name);
    return this.exclusive(name, async () => {
      const bank = await this.open(name);
      try {
        const result = await fn(bank);
        const path = bankFile(this.library, name);
        await bank.save(path);
        // What was found when the file was read stays true, except the count: the save has written the count it holds now.
        const { countMismatch: _written, ...stillSo } = this.held.get(name)?.report ?? { invalid: [], unknownFiles: [], migrationNotes: [], elapsedMs: 0 };
        this.held.set(name, { bank, report: stillSo, mtimeMs: (await stat(path)).mtimeMs });
        return result;
      } catch (error) {
        this.held.delete(name);
        throw error;
      }
    });
  }

  async create(title: string): Promise<string> {
    const clean = title.trim();
    if (clean === "") throw badRequest("A bank needs a title.");
    const name = await uniqueName(this.library.banks, clean, BANK_EXTENSION);
    const bank = Bank.createEmpty(clean);
    await bank.save(bankFile(this.library, name));
    return name;
  }

  /** A bank file from somewhere else, kept in the library under a new name. It is read first, and refused if it is not a bank. */
  async adopt(bytes: Uint8Array, fileName: string): Promise<{ name: string; skipped: number }> {
    let opened;
    try {
      opened = Bank.fromBytes(bytes);
    } catch (error) {
      throw badRequest(`That file is not an OpenAssess bank: ${(error as Error).message}`);
    }
    const wanted = cleanName(fileName.replace(/\.openassess$/i, "") || opened.bank.manifest.title);
    const name = await uniqueName(this.library.banks, wanted, BANK_EXTENSION);
    await opened.bank.save(bankFile(this.library, name));
    return { name, skipped: opened.report.invalid.filter((entry) => !entry.loaded).length };
  }

  async retitle(name: string, title: string): Promise<void> {
    const clean = title.trim();
    if (clean === "") throw badRequest("A bank needs a title.");
    await this.change(name, (bank) => {
      bank.manifest = { ...bank.manifest, title: clean };
    });
  }

  /** Moves the bank to the Deleted folder, after any change in progress. Nothing is erased. */
  remove(name: string): Promise<string> {
    checkName(name);
    return this.exclusive(name, async () => {
      await this.open(name);
      const kept = await uniqueName(this.library.deleted, name, BANK_EXTENSION);
      const target = join(this.library.deleted, `${kept}${BANK_EXTENSION}`);
      await rename(bankFile(this.library, name), target);
      this.held.delete(name);
      return target;
    });
  }
}
