/**
 * The bank: reading, writing and changing a .openassess file.
 *
 * Everything here is synchronous in memory and touches the filesystem only in
 * `open` and `save`, so the same class serves the desktop application, the
 * command-line tool, the MCP server and the read contract, and so the whole
 * thing is testable without a disk.
 */

import { open, readFile, rename, rm } from "node:fs/promises";
import { basename } from "node:path";

import { BANK_FORMAT, BANK_FORMAT_VERSION, GENERATOR } from "../naming.ts";
import { jsonEntry, readJson, unzipSync, zipSync, type ZipEntry } from "../container/zip.ts";
import {
  FOLDERS_PATH,
  HISTORY_PATH,
  MANIFEST_PATH,
  administrationIdFromPath,
  administrationPath,
  isAdministrationPath,
  isMediaPath,
  isQuestionPath,
  isTestPath,
  questionIdFromPath,
  questionPath,
  shouldStore,
  testIdFromPath,
  testPath,
} from "../container/layout.ts";
import {
  emptyFolderFile,
  folderIndex,
  type BankManifest,
  type FolderFile,
  type FolderNode,
  type Query,
  type SavedFilter,
} from "../model/bank.ts";
import { newBankId, newFolderId } from "../model/ids.ts";
import { migrateManifest, migrateQuestion, needsMigration } from "../model/migrate.ts";
import { validateQuestion, type Issue } from "../model/schema.ts";
import { editQuestion, type EditOptions, type QuestionEdit } from "../model/create.ts";
import type { HistoryEntry, Question } from "../model/question.ts";
import { validateTest, type TestRecord } from "../model/test.ts";
import { validateAdministration, type Administration, type AdministrationItem } from "../model/statistics.ts";
import { checkBankQuality, type BankQualityReport } from "../quality/bank.ts";
import { QUALITY_CODES, withFreshQuality } from "../quality/items.ts";
import { SearchIndex, matchesQuery } from "./search.ts";

export interface OpenReport {
  /** Questions that failed validation, with their issues. Never silently dropped. */
  invalid: Array<{
    id: string;
    issues: Issue[];
    /** True when the thing was read and is in the bank, and only something about its file was wrong (its name). */
    loaded?: boolean;
  }>;
  /** Files inside the container the engine did not recognise. */
  unknownFiles: string[];
  migrationNotes: string[];
  /** Present when the bank says it held a different number of questions than were read: what it says, and what was found. */
  countMismatch?: { says: number; found: number };
  migratedFrom?: number;
  elapsedMs: number;
}

export interface BankStats {
  questions: number;
  byType: Record<string, number>;
  byStatus: Record<string, number>;
  withErrors: number;
  withWarnings: number;
  mediaFiles: number;
  totalPoints: number;
}

/** What to tell a person when a bank opens with a different number of questions than it says it held. */
export function countMismatchMessage(m: { says: number; found: number }): string {
  const noun = (n: number) => `${n} ${n === 1 ? "question" : "questions"}`;
  return m.found < m.says
    ? `This bank says it held ${noun(m.says)} when it was last saved, and ${m.found} could be read. If files were lost when it was synced or merged, the missing ${m.says - m.found === 1 ? "question is" : "questions are"} in an earlier copy.`
    : `This bank says it held ${noun(m.says)} when it was last saved, and ${m.found} were read. It has more than it says, which a merge with another copy can do. Nothing is lost.`;
}

/** What checking a bank for quality found. */
export interface QualityRun {
  checked: number;
  /** Questions whose notes are not what they were. Nothing else about them changed. */
  changed: number;
  /** Notes now live (not dismissed), by finding code. */
  notes: Record<string, number>;
  /** Each question that has a live note, with the codes. */
  questions: Array<{ id: string; title: string; codes: string[] }>;
  /** What looks at more than one question: copies, and how the right answers are spread. Worked out now, not stored. */
  report: BankQualityReport;
}

/**
 * Enough of a shape check that the folder walk cannot throw.
 *
 * It deliberately does not validate the whole tree: a folder tree with one odd
 * node is still worth keeping, while a file with no root at all is not a
 * folder file and would take the bank down with it.
 */
function isUsableFolderFile(value: unknown): value is FolderFile {
  if (value === null || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record["root"]) || !Array.isArray(record["filters"])) return false;
  // Every folder has to be a folder all the way down. A tree whose root was a list but whose folders were not (no list of
  // questions, a child that was not a list) passed the check above and then threw out of the walk that builds the index, so a bank
  // with a folder file damaged in the middle would not open at all. The depth is bounded so that a file nested for no reason is
  // not followed forever.
  const folder = (node: unknown, depth: number): boolean => {
    if (depth > 100 || node === null || typeof node !== "object") return false;
    const n = node as Record<string, unknown>;
    return (
      typeof n["id"] === "string" &&
      typeof n["name"] === "string" &&
      Array.isArray(n["questionIds"]) &&
      n["questionIds"].every((id) => typeof id === "string") &&
      Array.isArray(n["children"]) &&
      n["children"].every((child) => folder(child, depth + 1))
    );
  };
  const filter = (f: unknown): boolean => f !== null && typeof f === "object" && typeof (f as Record<string, unknown>)["id"] === "string" && typeof (f as Record<string, unknown>)["name"] === "string";
  return record["root"].every((node) => folder(node, 0)) && record["filters"].every(filter);
}

export class Bank {
  manifest: BankManifest;
  readonly questions = new Map<string, Question>();
  readonly media = new Map<string, Uint8Array>();
  /** Assembled tests, each holding a copy of its questions as they were used. */
  readonly tests = new Map<string, TestRecord>();
  /** The class-level figures of tests given to classes. Never a response: see model/statistics.ts. */
  readonly administrations = new Map<string, Administration>();
  folders: FolderFile;
  history: HistoryEntry[] = [];
  /** Files the engine did not write and does not understand, carried through untouched. */
  private readonly passthrough = new Map<string, Uint8Array>();
  private readonly index = new SearchIndex();
  private folderOf = new Map<string, string>();
  /** Where this bank came from, when it was opened from disk. */
  path?: string;

  private constructor(manifest: BankManifest, folders: FolderFile) {
    this.manifest = manifest;
    this.folders = folders;
  }

  // -------------------------------------------------------------------------
  // Opening and creating
  // -------------------------------------------------------------------------

  static createEmpty(title: string, options: { description?: string; subject?: string; at?: string } = {}): Bank {
    const now = options.at ?? new Date().toISOString();
    const manifest: BankManifest = {
      format: BANK_FORMAT,
      formatVersion: BANK_FORMAT_VERSION,
      bankId: newBankId(),
      title,
      created: now,
      modified: now,
      questionCount: 0,
      generator: GENERATOR,
      ...(options.description ? { description: options.description } : {}),
      ...(options.subject ? { subject: options.subject } : {}),
    };
    return new Bank(manifest, emptyFolderFile());
  }

  static fromBytes(bytes: Uint8Array): { bank: Bank; report: OpenReport } {
    const started = performance.now();
    const files = unzipSync(bytes);

    const rawManifest = readJson<Record<string, unknown>>(files, MANIFEST_PATH);
    if (!rawManifest) {
      throw new Error("This file has no manifest.json, so it is not an OpenAssess bank.");
    }
    if (rawManifest["format"] !== BANK_FORMAT) {
      throw new Error(
        typeof rawManifest["format"] === "string"
          ? `This file says it is "${rawManifest["format"]}", not an OpenAssess bank.`
          : "This file's manifest does not say what kind of file it is, so it is not an OpenAssess bank, or it is damaged.",
      );
    }

    const fileVersion = Number(rawManifest["formatVersion"] ?? 0);
    const migrated = migrateManifest(rawManifest);
    const manifest = migrated.value as unknown as BankManifest;

    // Never trusted as read. The format is meant to be merged in a shared
    // folder, which is exactly where a malformed folder tree comes from, and a
    // missing root used to throw out of the folder walk with nothing naming
    // the file. A bank with a broken folder tree still has its questions.
    //
    // It is also never thrown away. A folder file that was not JSON stopped the whole bank from opening, which is the opposite of
    // the sentence above, and one with the wrong shape was replaced by an empty tree without a word and written back that way by
    // the next save, so the author's folders were gone. Now the bank opens with no folders, the file is reported, and the damaged
    // file is kept as it was under another name (folders.damaged.json) for someone to mend.
    const invalid: OpenReport["invalid"] = [];
    let rawFolders: unknown;
    let foldersProblem: string | undefined;
    try {
      rawFolders = readJson<FolderFile>(files, FOLDERS_PATH);
    } catch (error) {
      foldersProblem = (error as Error).message;
    }
    const damagedFolders = files.get(FOLDERS_PATH);
    let folders = emptyFolderFile();
    let keptFoldersAs: string | undefined;
    if (isUsableFolderFile(rawFolders)) {
      folders = rawFolders;
    } else if (damagedFolders !== undefined) {
      let n = 1;
      keptFoldersAs = "folders.damaged.json";
      while (files.has(keptFoldersAs)) keptFoldersAs = `folders.damaged-${++n}.json`;
      invalid.push({
        id: FOLDERS_PATH,
        issues: [{ path: FOLDERS_PATH, message: `${foldersProblem ?? "the folders are not in the shape a bank keeps them"}. The bank was opened with no folders, and this file is kept as ${keptFoldersAs}.` }],
      });
    }
    const bank = new Bank(manifest, folders);
    if (keptFoldersAs !== undefined && damagedFolders !== undefined) bank.passthrough.set(keptFoldersAs, damagedFolders);

    const unknownFiles: string[] = [];

    for (const [name, data] of files) {
      if (name === MANIFEST_PATH || name === FOLDERS_PATH) continue;

      if (name === HISTORY_PATH) {
        // An append-only log is the file most likely to be left half-written
        // by a crash, and one bad line used to make the whole bank unopenable.
        // The questions matter more than the log, so a line that will not
        // parse is skipped and reported.
        const text = Buffer.from(data).toString("utf8");
        const entries: HistoryEntry[] = [];
        const damagedLines: string[] = [];
        for (const line of text.split("\n")) {
          if (line.trim().length === 0) continue;
          try {
            entries.push(JSON.parse(line) as HistoryEntry);
          } catch {
            damagedLines.push(line);
          }
        }
        bank.history = entries;
        if (damagedLines.length > 0) {
          // Kept as they were, in a file of their own: the log is written back from the lines that could be read, so a line left
          // out here was deleted by the next save.
          let n = 1;
          let keptAs = "history.damaged.jsonl";
          while (files.has(keptAs) || bank.passthrough.has(keptAs)) keptAs = `history.damaged-${++n}.jsonl`;
          bank.passthrough.set(keptAs, new Uint8Array(Buffer.from(damagedLines.join("\n") + "\n", "utf8")));
          invalid.push({
            id: HISTORY_PATH,
            issues: [
              {
                path: HISTORY_PATH,
                message: `${damagedLines.length} history line(s) were unreadable. They are kept as ${keptAs}. The questions are unaffected.`,
              },
            ],
          });
        }
        continue;
      }

      if (isQuestionPath(name)) {
        const id = questionIdFromPath(name);
        let raw: Record<string, unknown>;
        try {
          raw = JSON.parse(Buffer.from(data).toString("utf8")) as Record<string, unknown>;
        } catch (err) {
          invalid.push({ id, issues: [{ path: "", message: `not valid JSON: ${(err as Error).message}` }] });
          // Kept as it was, like every other file that cannot be read. This one was reported and then left out of the passthrough,
          // so the next save of the bank deleted it: a question file damaged by a sync that did not finish, which is the author's
          // work and may be mended by hand, was destroyed by the first change made to the bank.
          bank.passthrough.set(name, data);
          continue;
        }
        const moved = needsMigration(fileVersion) ? migrateQuestion(raw, fileVersion).value : raw;
        const result = validateQuestion(moved);
        if (!result.ok) {
          // Kept in the bank and reported, never dropped: a question the
          // engine cannot read is still the author's work.
          invalid.push({ id, issues: result.issues });
          bank.passthrough.set(name, data);
          continue;
        }
        const question = moved as unknown as Question;

        // Two files claiming one id used to mean one of them vanished without
        // a word, and it vanished for good on the next save. Whichever arrives
        // second is kept as it was and reported, so nothing is lost silently.
        if (bank.questions.has(question.id)) {
          invalid.push({
            id: question.id,
            issues: [
              {
                path: name,
                message: `another file in this bank already uses the id ${question.id}, so this copy was not loaded`,
              },
            ],
          });
          bank.passthrough.set(name, data);
          continue;
        }
        if (question.id !== id) {
          // The question was read and is in the bank; only its file name was wrong, and a save writes it under its own id. It is
          // in the report so that it is said, and marked `loaded` so that it is not counted with the files that could not be read.
          invalid.push({
            id: question.id,
            loaded: true,
            issues: [
              {
                path: name,
                message: `the file is named for ${id} but the question inside says ${question.id}`,
              },
            ],
          });
        }

        bank.questions.set(question.id, question);
        continue;
      }

      if (isTestPath(name)) {
        // A test that cannot be read is kept exactly as it was and reported, like a question: it may be the only copy of
        // what was given to a class.
        const id = testIdFromPath(name);
        let raw: unknown;
        try {
          raw = JSON.parse(Buffer.from(data).toString("utf8"));
        } catch (err) {
          invalid.push({ id, issues: [{ path: name, message: `not valid JSON: ${(err as Error).message}` }] });
          bank.passthrough.set(name, data);
          continue;
        }
        const checked = validateTest(raw);
        if (!checked.ok) {
          invalid.push({ id, issues: checked.issues.map((i) => ({ ...i, path: `${name}${i.path ? `: ${i.path}` : ""}` })) });
          bank.passthrough.set(name, data);
          continue;
        }
        if (bank.tests.has(checked.test.id)) {
          invalid.push({ id: checked.test.id, issues: [{ path: name, message: `another file in this bank already holds the test ${checked.test.id}, so this copy was not loaded` }] });
          bank.passthrough.set(name, data);
          continue;
        }
        bank.tests.set(checked.test.id, checked.test);
        continue;
      }

      if (isAdministrationPath(name)) {
        // Figures that cannot be read, or that hold a field a bank may not (anything that could be a response), are kept exactly as they were,
        // reported, and not used: the file may be someone else's, and what is in it is not this program's to rewrite.
        const id = administrationIdFromPath(name);
        let raw: unknown;
        try {
          raw = JSON.parse(Buffer.from(data).toString("utf8"));
        } catch (err) {
          invalid.push({ id, issues: [{ path: name, message: `not valid JSON: ${(err as Error).message}` }] });
          bank.passthrough.set(name, data);
          continue;
        }
        const checked = validateAdministration(raw);
        if (!checked.ok) {
          invalid.push({ id, issues: checked.issues.map((i) => ({ ...i, path: `${name}${i.path ? `: ${i.path}` : ""}` })) });
          bank.passthrough.set(name, data);
          continue;
        }
        if (bank.administrations.has(checked.administration.id)) {
          invalid.push({ id: checked.administration.id, issues: [{ path: name, message: `another file in this bank already holds the figures ${checked.administration.id}, so this copy was not loaded` }] });
          bank.passthrough.set(name, data);
          continue;
        }
        bank.administrations.set(checked.administration.id, checked.administration);
        continue;
      }

      if (isMediaPath(name)) {
        bank.media.set(name, data);
        continue;
      }

      unknownFiles.push(name);
      bank.passthrough.set(name, data);
    }

    bank.rebuildIndex();

    // The manifest says how many questions the bank held when it was last saved. A shared folder is where files go missing (a sync
    // that did not finish, a merge that took one side), and a bank that opens with fewer questions than it says it has is exactly
    // that. The count is of questions that could be read, which is what a save writes, so a bank that keeps an unreadable question
    // beside the others does not disagree with itself.
    const says = (manifest as { questionCount?: unknown }).questionCount;
    const countMismatch = typeof says === "number" && says !== bank.questions.size ? { says, found: bank.questions.size } : undefined;

    return {
      bank,
      report: {
        invalid,
        unknownFiles,
        migrationNotes: migrated.notes,
        ...(countMismatch ? { countMismatch } : {}),
        ...(needsMigration(fileVersion) ? { migratedFrom: fileVersion } : {}),
        elapsedMs: performance.now() - started,
      },
    };
  }

  static async open(path: string): Promise<{ bank: Bank; report: OpenReport }> {
    const bytes = new Uint8Array(await readFile(path));
    const opened = Bank.fromBytes(bytes);
    opened.bank.path = path;
    if (!opened.bank.manifest.title) opened.bank.manifest.title = basename(path);
    return opened;
  }

  // -------------------------------------------------------------------------
  // Writing
  // -------------------------------------------------------------------------

  toBytes(options: { at?: string } = {}): Uint8Array {
    this.manifest = {
      ...this.manifest,
      modified: options.at ?? new Date().toISOString(),
      questionCount: this.questions.size,
      generator: GENERATOR,
      formatVersion: BANK_FORMAT_VERSION,
    };

    const entries: ZipEntry[] = [jsonEntry(MANIFEST_PATH, this.manifest), jsonEntry(FOLDERS_PATH, this.folders)];

    for (const question of this.sortedQuestions()) {
      entries.push(jsonEntry(questionPath(question.id), question));
    }
    for (const test of this.listTests()) {
      entries.push(jsonEntry(testPath(test.id), test));
    }
    for (const administration of this.listAdministrations()) {
      entries.push(jsonEntry(administrationPath(administration.id), administration));
    }
    for (const [name, data] of this.media) {
      entries.push({ name, data, store: shouldStore(name) });
    }
    if (this.history.length > 0) {
      const lines = this.history.map((h) => JSON.stringify(h)).join("\n") + "\n";
      entries.push({ name: HISTORY_PATH, data: new Uint8Array(Buffer.from(lines, "utf8")) });
    }
    // Passthrough goes last. A kept file whose path a live file already claimed cannot be written there: both together made a zip
    // with two entries of one name, and on the next open the passthrough copy won, so a kept-but-unreadable file quietly replaced
    // the author's real question (the reader now refuses duplicate names outright). It used to be dropped here instead, which lost
    // it: a "conflicted copy" of a question that carried the same id as another was reported as kept and then deleted by the next
    // save, and so was a damaged file whose name was the path of a question that loaded from another file. It is written under a
    // free name beside where it was (`.kept`, then `.kept-2`), which is not a path anything reads as a question, so it stays as it
    // is the next time the bank is opened.
    const taken = new Set(entries.map((e) => e.name));
    for (const [name, data] of this.passthrough) {
      let keep = name;
      if (taken.has(keep)) {
        let n = 1;
        keep = `${name}.kept`;
        while (taken.has(keep) || this.passthrough.has(keep)) keep = `${name}.kept-${++n}`;
      }
      taken.add(keep);
      entries.push({ name: keep, data, store: shouldStore(keep) });
    }

    // Given a time to save at, every file in the zip is stamped with it. Left alone they are stamped with the clock, and two saves
    // of one bank with the same `at` came out different whenever the clock ticked between them (a test that saves twice and
    // compares failed now and then).
    const stamp = options.at === undefined ? undefined : new Date(options.at);
    return zipSync(stamp && !Number.isNaN(stamp.getTime()) ? entries.map((entry) => ({ ...entry, date: stamp })) : entries);
  }

  /**
   * Write through a temporary file and rename, so an interrupted save cannot
   * leave a half-written bank where the original was.
   */
  async save(path?: string): Promise<string> {
    const target = path ?? this.path;
    if (!target) throw new Error("This bank has no path yet. Pass one to save().");
    const bytes = this.toBytes();
    const temp = `${target}.writing`;
    try {
      // Written, then flushed to the disk, before the rename: a rename of a file whose contents are still in the system's memory can
      // survive a power cut that the contents do not, and leave an empty bank where the old one was.
      const file = await open(temp, "w");
      try {
        await file.writeFile(bytes);
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temp, target);
    } catch (error) {
      // A failed save leaves the bank that was there, and no half-written file beside it.
      await rm(temp, { force: true });
      throw error;
    }
    this.path = target;
    return target;
  }

  // -------------------------------------------------------------------------
  // Tests
  // -------------------------------------------------------------------------

  /** Keeps an assembled test in this bank. A record that does not hold together is refused, and so is a second one with the same id. */
  addTest(record: TestRecord): TestRecord {
    const checked = validateTest(record);
    if (!checked.ok) {
      throw new Error(`Refusing to add a test that does not hold together:\n` + checked.issues.map((i) => `  ${i.path || "<root>"}: ${i.message}`).join("\n"));
    }
    if (this.tests.has(record.id)) throw new Error(`This bank already holds a test with the id ${record.id}.`);
    this.tests.set(record.id, record);
    return record;
  }

  getTest(id: string): TestRecord | undefined {
    return this.tests.get(id);
  }

  /** The tests, oldest first. */
  listTests(): TestRecord[] {
    return [...this.tests.values()].sort((a, b) => (a.created === b.created ? (a.id < b.id ? -1 : 1) : a.created < b.created ? -1 : 1));
  }

  removeTest(id: string): boolean {
    return this.tests.delete(id);
  }

  // -------------------------------------------------------------------------
  // The figures of tests given to classes
  // -------------------------------------------------------------------------

  /** Keeps the class-level figures of a test given to a class. Figures with a field a bank may not hold, or that do not add up, are refused. */
  addAdministration(administration: Administration): Administration {
    const checked = validateAdministration(administration);
    if (!checked.ok) {
      throw new Error(`Refusing to add figures that a bank may not hold:\n` + checked.issues.map((i) => `  ${i.path || "<root>"}: ${i.message}`).join("\n"));
    }
    if (this.administrations.has(administration.id)) throw new Error(`This bank already holds the figures ${administration.id}.`);
    this.administrations.set(administration.id, administration);
    return administration;
  }

  /** The administrations, oldest first by the day they were given. */
  listAdministrations(): Administration[] {
    return [...this.administrations.values()].sort((a, b) => (a.date === b.date ? (a.id < b.id ? -1 : 1) : a.date < b.date ? -1 : 1));
  }

  removeAdministration(id: string): boolean {
    return this.administrations.delete(id);
  }

  /** What each time a question was given says of it, oldest first: the test, the day, how many sheets, and its figures. */
  statisticsFor(questionId: string): Array<{ administration: Omit<Administration, "items">; item: AdministrationItem }> {
    const out: Array<{ administration: Omit<Administration, "items">; item: AdministrationItem }> = [];
    for (const a of this.listAdministrations()) {
      const item = a.items.find((i) => i.questionId === questionId);
      if (item) {
        const { items: _items, ...meta } = a;
        out.push({ administration: meta, item });
      }
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // Questions
  // -------------------------------------------------------------------------

  add(question: Question, options: { folderId?: string } = {}): Question {
    const result = validateQuestion(question);
    if (!result.ok) {
      throw new Error(
        `Refusing to add a question that does not satisfy the model:\n` +
          result.issues.map((i) => `  ${i.path || "<root>"}: ${i.message}`).join("\n"),
      );
    }
    if (this.questions.has(question.id)) {
      throw new Error(`This bank already holds a question with the id ${question.id}.`);
    }
    // The folder is checked before anything is changed. Checked afterwards (by moveToFolder), a wrong id left the question in the
    // bank, in the index and in no folder, with an error saying it had not been added.
    if (options.folderId && !this.allFolders().some((f) => f.id === options.folderId)) {
      throw new Error(`No folder with the id ${options.folderId} is in this bank.`);
    }
    // A question written here has its notes about writing made fresh as it goes in, as one that is edited does, so that Has notes
    // does not miss a question that was added and not yet touched. One brought in by an import does not: an import's findings are
    // about what the importer had to guess, and notes about style are not mixed in with them until the bank is checked.
    const stored = question.origin?.kind === "import" ? question : withFreshQuality(question);
    this.questions.set(stored.id, stored);
    this.index.add(stored);
    if (options.folderId) this.moveToFolder(stored.id, options.folderId);
    this.note(`added ${stored.id}`, stored.history.at(-1)?.by ?? "unknown");
    return stored;
  }

  get(id: string): Question | undefined {
    return this.questions.get(id);
  }

  update(id: string, edit: QuestionEdit, opts: EditOptions = {}): Question {
    const current = this.questions.get(id);
    if (!current) throw new Error(`No question with the id ${id} is in this bank.`);
    // A question that is saved into a bank has its notes about writing made fresh, so they describe what was saved.
    const next = withFreshQuality(editQuestion(current, edit, opts));
    const result = validateQuestion(next);
    if (!result.ok) {
      throw new Error(
        `That edit would leave the question invalid, so nothing was changed:\n` +
          result.issues.map((i) => `  ${i.path || "<root>"}: ${i.message}`).join("\n"),
      );
    }
    this.questions.set(id, next);
    this.index.add(next);
    this.note(`updated ${id} to version ${next.version}`, opts.by ?? "unknown", opts.at);
    return next;
  }

  /**
   * Check every question for the item quality and accessibility notes, and look across the bank for copies and for answers that sit
   * in one place too often. The notes are written to the questions (the version, the history and the status are not touched,
   * since this is looking, not editing); the rest is returned and not stored, because it goes stale when a question changes.
   */
  checkQuality(by = "unknown", at?: string): QualityRun {
    let changed = 0;
    for (const [id, question] of this.questions) {
      const next = withFreshQuality(question);
      if (next === question) continue;
      this.questions.set(id, next);
      changed++;
    }
    if (changed > 0) this.note(`checked the questions for quality; the notes of ${changed} changed`, by, at);

    const notes: Record<string, number> = {};
    const questions: QualityRun["questions"] = [];
    for (const question of [...this.questions.values()].sort((a, b) => a.id.localeCompare(b.id))) {
      const live = question.findings.filter((f) => !f.dismissed && QUALITY_CODES.has(f.code));
      if (live.length === 0) continue;
      for (const f of live) notes[f.code] = (notes[f.code] ?? 0) + 1;
      questions.push({ id: question.id, title: question.title, codes: live.map((f) => f.code) });
    }
    return { checked: this.questions.size, changed, notes, questions, report: checkBankQuality([...this.questions.values()], this.listTests()) };
  }

  remove(id: string): boolean {
    const existed = this.questions.delete(id);
    if (!existed) return false;
    this.index.remove(id);
    for (const node of this.allFolders()) {
      const at = node.questionIds.indexOf(id);
      if (at !== -1) node.questionIds.splice(at, 1);
    }
    this.folderOf.delete(id);
    this.note(`removed ${id}`, "unknown");
    return true;
  }

  sortedQuestions(): Question[] {
    return [...this.questions.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  // -------------------------------------------------------------------------
  // Finding things
  // -------------------------------------------------------------------------

  search(text: string): Question[] {
    const ids = this.index.search(text);
    return [...ids].map((id) => this.questions.get(id)).filter((q): q is Question => q !== undefined);
  }

  list(query: Query = {}): Question[] {
    let candidates: Iterable<Question>;
    if (query.text && query.text.trim().length > 0) {
      candidates = this.search(query.text);
    } else {
      candidates = this.questions.values();
    }
    const out: Question[] = [];
    for (const question of candidates) {
      if (matchesQuery(question, query, this.folderOf)) out.push(question);
    }
    return out.sort((a, b) => a.id.localeCompare(b.id));
  }

  stats(): BankStats {
    const stats: BankStats = {
      questions: this.questions.size,
      byType: {},
      byStatus: {},
      withErrors: 0,
      withWarnings: 0,
      mediaFiles: this.media.size,
      totalPoints: 0,
    };
    for (const q of this.questions.values()) {
      stats.byType[q.type] = (stats.byType[q.type] ?? 0) + 1;
      stats.byStatus[q.metadata.status] = (stats.byStatus[q.metadata.status] ?? 0) + 1;
      stats.totalPoints += q.points;
      const live = q.findings.filter((f) => !f.dismissed);
      if (live.some((f) => f.severity === "error")) stats.withErrors++;
      else if (live.some((f) => f.severity === "warn")) stats.withWarnings++;
    }
    return stats;
  }

  // -------------------------------------------------------------------------
  // Folders and saved filters
  // -------------------------------------------------------------------------

  addFolder(name: string, parentId?: string): FolderNode {
    const node: FolderNode = { id: newFolderId(), name, questionIds: [], children: [] };
    if (!parentId) {
      this.folders.root.push(node);
    } else {
      const parent = this.allFolders().find((f) => f.id === parentId);
      if (!parent) throw new Error(`No folder with the id ${parentId} is in this bank.`);
      parent.children.push(node);
    }
    return node;
  }

  moveToFolder(questionId: string, folderId: string): void {
    if (!this.questions.has(questionId)) {
      throw new Error(`No question with the id ${questionId} is in this bank.`);
    }
    const target = this.allFolders().find((f) => f.id === folderId);
    if (!target) throw new Error(`No folder with the id ${folderId} is in this bank.`);
    for (const node of this.allFolders()) {
      const at = node.questionIds.indexOf(questionId);
      if (at !== -1) node.questionIds.splice(at, 1);
    }
    target.questionIds.push(questionId);
    this.folderOf.set(questionId, folderId);
  }

  saveFilter(filter: SavedFilter): void {
    const at = this.folders.filters.findIndex((f) => f.id === filter.id);
    if (at === -1) this.folders.filters.push(filter);
    else this.folders.filters[at] = filter;
  }

  allFolders(): FolderNode[] {
    const out: FolderNode[] = [];
    const walk = (nodes: FolderNode[]) => {
      for (const node of nodes) {
        out.push(node);
        walk(node.children);
      }
    };
    walk(this.folders.root);
    return out;
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  rebuildIndex(): void {
    // Cleared first: a question taken out of the map by hand would otherwise stay findable.
    this.index.clear();
    for (const question of this.questions.values()) this.index.add(question);
    this.folderOf = folderIndex(this.folders.root);
  }

  private note(change: string, by: string, at?: string): void {
    this.history.push({ at: at ?? new Date().toISOString(), by, change });
  }
}
