/**
 * The bank: reading, writing and changing a .openassess file.
 *
 * Everything here is synchronous in memory and touches the filesystem only in
 * `open` and `save`, so the same class serves the desktop application, the
 * command-line tool, the MCP server and the read contract, and so the whole
 * thing is testable without a disk.
 */

import { readFile, writeFile, rename } from "node:fs/promises";
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
import { SearchIndex, matchesQuery } from "./search.ts";

export interface OpenReport {
  /** Questions that failed validation, with their issues. Never silently dropped. */
  invalid: Array<{ id: string; issues: Issue[] }>;
  /** Files inside the container the engine did not recognise. */
  unknownFiles: string[];
  migrationNotes: string[];
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
  return Array.isArray(record["root"]) && Array.isArray(record["filters"]);
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
        `This file says it is "${String(rawManifest["format"])}", not an OpenAssess bank.`,
      );
    }

    const fileVersion = Number(rawManifest["formatVersion"] ?? 0);
    const migrated = migrateManifest(rawManifest);
    const manifest = migrated.value as unknown as BankManifest;

    // Never trusted as read. The format is meant to be merged in a shared
    // folder, which is exactly where a malformed folder tree comes from, and a
    // missing root used to throw out of the folder walk with nothing naming
    // the file. A bank with a broken folder tree still has its questions.
    const rawFolders = readJson<FolderFile>(files, FOLDERS_PATH);
    const folders = isUsableFolderFile(rawFolders) ? rawFolders : emptyFolderFile();
    const bank = new Bank(manifest, folders);

    const invalid: OpenReport["invalid"] = [];
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
        let damaged = 0;
        for (const line of text.split("\n")) {
          if (line.trim().length === 0) continue;
          try {
            entries.push(JSON.parse(line) as HistoryEntry);
          } catch {
            damaged++;
          }
        }
        bank.history = entries;
        if (damaged > 0) {
          invalid.push({
            id: HISTORY_PATH,
            issues: [
              {
                path: HISTORY_PATH,
                message: `${damaged} history line(s) were unreadable and were skipped. The questions are unaffected.`,
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
          invalid.push({
            id: question.id,
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

    return {
      bank,
      report: {
        invalid,
        unknownFiles,
        migrationNotes: migrated.notes,
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
    // Passthrough goes last, and anything whose path a live question already
    // claimed is dropped here rather than written. Writing both produced a zip
    // with two entries of one name, and on the next open the passthrough copy
    // won, so a kept-but-unreadable file quietly replaced the author's real
    // question. The reader now refuses duplicate names outright.
    const taken = new Set(entries.map((e) => e.name));
    for (const [name, data] of this.passthrough) {
      if (taken.has(name)) continue;
      taken.add(name);
      entries.push({ name, data, store: shouldStore(name) });
    }

    return zipSync(entries);
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
    await writeFile(temp, bytes);
    await rename(temp, target);
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
    this.questions.set(question.id, question);
    this.index.add(question);
    if (options.folderId) this.moveToFolder(question.id, options.folderId);
    this.note(`added ${question.id}`, question.history.at(-1)?.by ?? "unknown");
    return question;
  }

  get(id: string): Question | undefined {
    return this.questions.get(id);
  }

  update(id: string, edit: QuestionEdit, opts: EditOptions = {}): Question {
    const current = this.questions.get(id);
    if (!current) throw new Error(`No question with the id ${id} is in this bank.`);
    const next = editQuestion(current, edit, opts);
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
    for (const question of this.questions.values()) this.index.add(question);
    this.folderOf = folderIndex(this.folders.root);
  }

  private note(change: string, by: string, at?: string): void {
    this.history.push({ at: at ?? new Date().toISOString(), by, change });
  }
}
