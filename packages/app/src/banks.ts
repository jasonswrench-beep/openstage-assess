/**
 * The banks in the library: listing, opening, changing and saving them.
 *
 * A bank is held in memory once it is opened and written back after every change, through a temporary file and a rename
 * (the engine does that), so a change is on disk before the screen says it was made. Everything that changes or removes a
 * bank goes through one queue for that bank, so two changes never write the same file at once. A bank whose file changed
 * on disk since it was read is read again before it is used.
 */

import { stat } from "node:fs/promises";
import { join } from "node:path";

import { Bank, BANK_EXTENSION, cleanedMessage, countMismatchMessage, type OpenReport } from "./engine.ts";
import { badRequest, HttpError, notFound } from "./errors.ts";
import { bankFile, bankNames, checkName, cleanName, fileOps, placeFile, placeMade, type FileOps, type Library } from "./library.ts";

export interface BankInfo {
  name: string;
  title: string;
  questions: number;
  created: string;
  modified: string;
  bytes: number;
  /** Set when the file could not be read as a bank. It is listed, not hidden. */
  error?: string;
  /** Set with `error` when the file's name is one that OpenAssess cannot use, so the file cannot be opened or removed here: it is renamed in the Banks folder. */
  unusableName?: true;
}

/**
 * What a `BankStore` does to the disk that a test may want to fail: the file system calls that find a free name, and the save of a
 * bank. Nothing outside a test gives these.
 */
export interface BankStoreIo {
  files?: FileOps;
  save?: (bank: Bank, path: string) => Promise<unknown>;
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
  /** Set when questions name pictures that the bank file does not hold. */
  pictures: string | null;
  /** Set when formatting or an equation OpenAssess does not allow was taken out of some questions as the bank was read. */
  formatting: string | null;
}

export class BankStore {
  readonly library: Library;
  private readonly held = new Map<string, Held>();
  /**
   * The end of the last piece of work queued for each bank. It is kept apart from `held` on purpose: a bank that is read
   * again because its file changed gets a new entry there, and a queue that went with it would split in two.
   */
  private readonly queues = new Map<string, Promise<unknown>>();

  private readonly files: FileOps;
  private readonly saveBank: (bank: Bank, path: string) => Promise<unknown>;

  constructor(library: Library, io: BankStoreIo = {}) {
    this.library = library;
    this.files = io.files ?? fileOps;
    this.saveBank = io.save ?? ((bank, path) => bank.save(path));
  }

  /**
   * The banks in the folder, each read to say what it holds. One that cannot be listed in the ordinary way is listed in words and not
   * left out, and never stops the rest: this is the answer the first screen is made from, and one file in the folder (a copy cut
   * short, a name this program would not have made) must not leave a person with a screen that shows nothing.
   */
  async list(): Promise<BankInfo[]> {
    const out: BankInfo[] = [];
    for (const name of await bankNames(this.library, this.files)) {
      let path: string;
      try {
        path = bankFile(this.library, name);
      } catch {
        // A file put in the Banks folder by hand, or synced from another computer, under a name that is too long, begins with a dot, ends
        // in a dot or a space, or is a Windows device's: it cannot be opened by name here, so it is said what to do.
        out.push({
          name,
          title: name,
          questions: 0,
          created: "",
          modified: "",
          bytes: 0,
          error: "its name cannot be used by OpenAssess (a name can be at most 80 characters, cannot begin with a dot, end in a dot or a space, or be the name of a device such as CON or COM1). Rename the file in the Banks folder, and it will be listed here.",
          unusableName: true,
        });
        continue;
      }
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
    const bank = await this.open(name);
    const report = this.held.get(name)?.report;
    const missing = bank.missingMedia();
    const files = new Set(missing.map((m) => m.file)).size;
    return {
      // Not the questions that were read and only had the wrong file name: they are in the list.
      unreadable: (report?.invalid ?? []).filter((entry) => !entry.loaded).map((entry) => ({ id: entry.id, message: entry.issues[0]?.message ?? "It could not be read." })),
      count: report?.countMismatch ? countMismatchMessage(report.countMismatch) : null,
      formatting: report?.cleaned ? cleanedMessage(report.cleaned) : null,
      pictures:
        missing.length === 0
          ? null
          : `${files === 1 ? "One picture" : `${files} pictures`} that ${missing.length === 1 ? "a question refers" : "questions refer"} to ${files === 1 ? "is" : "are"} not in this bank file, for instance because a copy of the file was cut short or was synced without ${files === 1 ? "it" : "them"}. ${missing.length === 1 ? "The question is" : "The questions are"} still here with ${missing.length === 1 ? "its" : "their"} description${missing.length === 1 ? "" : "s"}, and nothing else is lost.`,
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

  /**
   * A new empty bank, under its title as a name, or with 2, 3 after it if that is taken. The finished file is made under a private
   * name and given its own by a link (`placeMade`), so that no one looking in the folder sees an empty or half-written bank, and a bank
   * that cannot be saved leaves nothing behind.
   */
  async create(title: string): Promise<string> {
    const clean = title.trim();
    if (clean === "") throw badRequest("A bank needs a title.");
    return placeMade(this.library.banks, cleanName(clean), BANK_EXTENSION, (temp) => this.saveBank(Bank.createEmpty(clean), temp), this.files);
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
    const name = await placeMade(this.library.banks, wanted, BANK_EXTENSION, (temp) => this.saveBank(opened.bank, temp), this.files);
    return { name, skipped: opened.report.invalid.filter((entry) => !entry.loaded).length };
  }

  async retitle(name: string, title: string): Promise<void> {
    const clean = title.trim();
    if (clean === "") throw badRequest("A bank needs a title.");
    await this.change(name, (bank) => {
      bank.manifest = { ...bank.manifest, title: clean };
    });
  }

  /**
   * Moves the bank to the Deleted folder, after any change in progress. Nothing is erased. The bank is given its name in Deleted by a
   * link and then taken off its name in Banks, so that at no moment is it in neither place, and a bank removed twice under one name
   * keeps both. If the first name cannot be taken off, the second is given up, and the bank is where it was and not in both. A bank
   * that cannot be read is removed as well as one that can: it is not opened first, only looked for, because the one thing a person can
   * do about a file that is no bank is to put it out of the way.
   */
  remove(name: string): Promise<string> {
    checkName(name);
    return this.exclusive(name, async () => {
      const source = bankFile(this.library, name);
      try {
        await stat(source);
      } catch {
        this.held.delete(name);
        throw notFound(`There is no bank called "${name}".`);
      }
      const kept = await placeFile(this.library.deleted, name, BANK_EXTENSION, source, this.files);
      const target = join(this.library.deleted, `${kept}${BANK_EXTENSION}`);
      try {
        await this.files.unlink(source);
      } catch (error) {
        await this.files.remove(target).catch(() => undefined);
        // A name that was taken off by someone else in the meantime (a second copy of the app) is a bank that is not there now.
        if ((error as { code?: string } | null)?.code === "ENOENT") {
          this.held.delete(name);
          throw notFound(`There is no bank called "${name}".`);
        }
        throw error;
      }
      this.held.delete(name);
      return target;
    });
  }
}
