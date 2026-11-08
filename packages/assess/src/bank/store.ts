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
  blueprintIdFromPath,
  blueprintPath,
  isAdministrationPath,
  isBlueprintPath,
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
  cleanFolderName,
  emptyFolderFile,
  folderIndex,
  folderNameKey,
  namesMovingUp,
  questionsUnder,
  walkFolders,
  type BankManifest,
  type FolderFile,
  type FolderListing,
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
import { tidyRule, validateBlueprint, type Blueprint, type BlueprintRule } from "./blueprint.ts";

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
  /** Stored recipes for a test (`bank/blueprint.ts`). They hold no question, so removing or changing one never touches a test. */
  readonly blueprints = new Map<string, Blueprint>();
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

      if (isBlueprintPath(name)) {
        // A recipe that cannot be read is kept as it was, reported and not used, like a test: it may be the only copy of a
        // set of rules somebody wrote out, and a field it holds that this program does not know would be lost by a rewrite.
        const id = blueprintIdFromPath(name);
        let raw: unknown;
        try {
          raw = JSON.parse(Buffer.from(data).toString("utf8"));
        } catch (err) {
          invalid.push({ id, issues: [{ path: name, message: `not valid JSON: ${(err as Error).message}` }] });
          bank.passthrough.set(name, data);
          continue;
        }
        const checked = validateBlueprint(raw);
        if (!checked.ok) {
          invalid.push({ id, issues: checked.issues.map((i) => ({ ...i, path: `${name}${i.path ? `: ${i.path}` : ""}` })) });
          bank.passthrough.set(name, data);
          continue;
        }
        if (bank.blueprints.has(checked.blueprint.id)) {
          invalid.push({ id: checked.blueprint.id, issues: [{ path: name, message: `another file in this bank already holds the blueprint ${checked.blueprint.id}, so this copy was not loaded` }] });
          bank.passthrough.set(name, data);
          continue;
        }
        bank.blueprints.set(checked.blueprint.id, checked.blueprint);
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
    for (const blueprint of this.listBlueprints()) {
      entries.push(jsonEntry(blueprintPath(blueprint.id), blueprint));
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

  // -------------------------------------------------------------------------
  // Blueprints: stored recipes for a test
  // -------------------------------------------------------------------------

  /** Keeps a recipe. One that does not hold together is refused, and so is a second with the same id or the same name. */
  addBlueprint(blueprint: Blueprint): Blueprint {
    const checked = validateBlueprint(blueprint);
    if (!checked.ok) {
      throw new Error(`Refusing to add a blueprint that does not hold together:\n` + checked.issues.map((i) => `  ${i.path || "<root>"}: ${i.message}`).join("\n"));
    }
    if (this.blueprints.has(blueprint.id)) throw new Error(`This bank already holds a blueprint with the id ${blueprint.id}.`);
    this.refuseBlueprintName(blueprint.name, blueprint.id);
    this.blueprints.set(blueprint.id, blueprint);
    return blueprint;
  }

  getBlueprint(id: string): Blueprint | undefined {
    return this.blueprints.get(id);
  }

  /** The blueprints, oldest first. */
  listBlueprints(): Blueprint[] {
    return [...this.blueprints.values()].sort((a, b) => (a.created === b.created ? (a.id < b.id ? -1 : 1) : a.created < b.created ? -1 : 1));
  }

  /** Changes a recipe's name or rules. The same checks as adding one; nothing is changed when any fails. */
  updateBlueprint(id: string, change: { name?: string; rules?: readonly BlueprintRule[] }, at: string = new Date().toISOString()): Blueprint {
    const current = this.blueprints.get(id);
    if (!current) throw new Error(`This bank holds no blueprint ${id}.`);
    const next: Blueprint = {
      ...current,
      ...(change.name !== undefined ? { name: change.name.trim() } : {}),
      ...(change.rules !== undefined ? { rules: change.rules.map(tidyRule) } : {}),
      modified: at,
    };
    const checked = validateBlueprint(next);
    if (!checked.ok) {
      throw new Error(`Refusing a blueprint that does not hold together:\n` + checked.issues.map((i) => `  ${i.path || "<root>"}: ${i.message}`).join("\n"));
    }
    // Only a new name is checked: a bank that was opened with two recipes of one name (a merge of two copies can do it) must still let
    // the rules of either be changed, and the name is the thing that tells them apart.
    if (next.name !== current.name) this.refuseBlueprintName(next.name, id);
    this.blueprints.set(id, next);
    return next;
  }

  removeBlueprint(id: string): boolean {
    return this.blueprints.delete(id);
  }

  /** Two recipes with one name could not be told apart in a list, so the name is the key a person finds one by. */
  private refuseBlueprintName(name: string, exceptId: string): void {
    const key = name.trim().toLocaleLowerCase();
    for (const other of this.blueprints.values()) {
      if (other.id !== exceptId && other.name.trim().toLocaleLowerCase() === key) throw new Error(`This bank already holds a blueprint called "${other.name}".`);
    }
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

  /**
   * Add a question. `media` is the bytes of pictures that came with it (an import's `media`, by path); the ones this question refers
   * to are written into the bank, and the rest are left behind, so a picture in a question nobody saved is not stored. A picture the
   * question names that the bank does not hold and `media` does not supply is allowed in and reported by `missingMedia`, since a
   * question has to be saveable and a lost file is the bank's to say.
   */
  add(question: Question, options: { folderId?: string; media?: ReadonlyMap<string, Uint8Array> } = {}): Question {
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
    // Nothing after this point can fail, so a picture is stored only for a question that is.
    for (const ref of stored.media) {
      const bytes = options.media?.get(ref.file);
      if (bytes !== undefined && isMediaPath(ref.file) && !this.media.has(ref.file)) this.media.set(ref.file, bytes);
    }
    this.note(`added ${stored.id}`, stored.history.at(-1)?.by ?? "unknown");
    return stored;
  }

  get(id: string): Question | undefined {
    return this.questions.get(id);
  }

  /**
   * Pictures that questions name and the bank does not hold, one entry for each question and file. A bank gets here when a question
   * was imported from a text that named a file it never had, when a sync lost a file, or when a picture was damaged beyond being kept.
   * The question is still there, its description is still there, and it is said so that the picture can be put back.
   */
  missingMedia(): Array<{ id: string; title: string; file: string }> {
    const missing: Array<{ id: string; title: string; file: string }> = [];
    for (const q of this.sortedQuestions()) {
      for (const ref of q.media) if (!this.media.has(ref.file)) missing.push({ id: q.id, title: q.title, file: ref.file });
    }
    return missing;
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
    const clean = cleanFolderName(name);
    const siblings = parentId ? this.folderNamed(parentId).children : this.folders.root;
    this.refuseSiblingNamed(siblings, clean);
    const node: FolderNode = { id: newFolderId(), name: clean, questionIds: [], children: [] };
    siblings.push(node);
    this.note(`added the folder ${clean}`, "unknown");
    return node;
  }

  /**
   * The folder of this name in that place, made if there is none. For filing what comes in (an import) under the name of where it came
   * from, so that a second file with the same name goes to the same folder and does not make a second one beside it.
   */
  ensureFolder(name: string, parentId?: string): FolderNode {
    const clean = cleanFolderName(name);
    const siblings = parentId ? this.folderNamed(parentId).children : this.folders.root;
    const key = folderNameKey(clean);
    return siblings.find((f) => folderNameKey(f.name) === key) ?? this.addFolder(clean, parentId);
  }

  /** A folder is found by its id or the person is told there is none; the first of two with one id (a damaged file) is the one meant. */
  private folderNamed(id: string): FolderNode {
    const found = this.allFolders().find((f) => f.id === id);
    if (!found) throw new Error(`No folder with the id ${id} is in this bank.`);
    return found;
  }

  /** Two folders side by side with one name cannot be told apart in a list, so the second is refused. */
  private refuseSiblingNamed(siblings: readonly FolderNode[], name: string, except?: string): void {
    const key = folderNameKey(name);
    if (siblings.some((f) => f.id !== except && folderNameKey(f.name) === key)) {
      throw new Error(`There is already a folder called "${name}" in that place. Choose another name.`);
    }
  }

  /** The list a folder is in (the top of the bank, or the folder it is inside), and where it is in that list. */
  private placeOf(id: string): { siblings: FolderNode[]; at: number; parent: FolderNode | undefined } {
    const find = (siblings: FolderNode[], parent: FolderNode | undefined): { siblings: FolderNode[]; at: number; parent: FolderNode | undefined } | undefined => {
      const at = siblings.findIndex((f) => f.id === id);
      if (at !== -1) return { siblings, at, parent };
      for (const f of siblings) {
        const inner = find(f.children, f);
        if (inner) return inner;
      }
      return undefined;
    };
    const place = find(this.folders.root, undefined);
    if (!place) throw new Error(`No folder with the id ${id} is in this bank.`);
    return place;
  }

  renameFolder(id: string, name: string): FolderNode {
    const clean = cleanFolderName(name);
    const folder = this.folderNamed(id);
    if (folder.name === clean) return folder;
    this.refuseSiblingNamed(this.placeOf(id).siblings, clean, id);
    const before = folder.name;
    folder.name = clean;
    this.note(`renamed the folder ${before} to ${clean}`, "unknown");
    return folder;
  }

  /**
   * Takes a folder away and nothing it holds. Its questions stay in the bank, in no folder, and the folders inside it move up to the
   * place it was in (so a person who deletes a folder to tidy up does not also lose the tidying inside it). Where one of those has the
   * name of a folder already there, it is kept under a name that says so, and nothing is merged or dropped.
   */
  removeFolder(id: string): { unfiled: number; movedUp: number } {
    const { siblings, at } = this.placeOf(id);
    const folder = siblings[at] as FolderNode;
    const unfiled = folder.questionIds.filter((q) => this.questions.has(q)).length;
    // A folder can name a question this bank does not hold (its file could not be read and is kept as it was). That name goes with the
    // folder, and the history says so, since the person may mend the file later and want to know where the question had been.
    const unknown = folder.questionIds.length - unfiled;
    for (const q of folder.questionIds) this.folderOf.delete(q);
    const others = siblings.filter((f) => f.id !== id);
    const names = namesMovingUp(others.map((f) => f.name), folder.children.map((c) => c.name));
    folder.children.forEach((child, i) => {
      child.name = names[i] as string;
    });
    // The children go where the folder was, in place and one at a time: a spread of a list into `splice` throws a RangeError from
    // about 125,000 elements, and a damaged bank can hold that many folders in one.
    const after = siblings.splice(at + 1);
    siblings.length = at;
    for (const child of folder.children) siblings.push(child);
    for (const next of after) siblings.push(next);
    this.note(`removed the folder ${folder.name}${unfiled > 0 ? `; ${unfiled} question${unfiled === 1 ? " is" : "s are"} in no folder now` : ""}${unknown > 0 ? `; it also named ${unknown} question${unknown === 1 ? "" : "s"} this bank could not read` : ""}`, "unknown");
    return { unfiled, movedUp: folder.children.length };
  }

  /** Puts a folder inside another, or at the top of the bank (no `parentId`). A folder cannot go inside itself or anything in it. */
  moveFolder(id: string, parentId?: string): FolderNode {
    const folder = this.folderNamed(id);
    const target = parentId ? this.folderNamed(parentId) : undefined;
    if (target && [...walkFolders([folder])].some((f) => f.id === target.id)) {
      throw new Error("A folder cannot be moved into itself or into a folder inside it.");
    }
    const here = this.placeOf(id);
    if ((here.parent?.id ?? undefined) === (target?.id ?? undefined)) return folder;
    const siblings = target ? target.children : this.folders.root;
    this.refuseSiblingNamed(siblings, folder.name);
    here.siblings.splice(here.at, 1);
    siblings.push(folder);
    this.note(`moved the folder ${folder.name}${target ? ` into ${target.name}` : " to the top"}`, "unknown");
    return folder;
  }

  moveToFolder(questionId: string, folderId: string): void {
    if (!this.questions.has(questionId)) {
      throw new Error(`No question with the id ${questionId} is in this bank.`);
    }
    const target = this.folderNamed(folderId);
    this.takeOutOfFolders([questionId]);
    target.questionIds.push(questionId);
    this.folderOf.set(questionId, folderId);
  }

  /** The question is in no folder. */
  unfile(questionId: string): void {
    if (!this.questions.has(questionId)) {
      throw new Error(`No question with the id ${questionId} is in this bank.`);
    }
    this.takeOutOfFolders([questionId]);
    this.folderOf.delete(questionId);
  }

  /**
   * File several questions in one folder, or in none (`folderId` undefined), at once. All or nothing: every question and the folder are
   * checked before any is moved, so an id that is not in the bank leaves every question where it was. Each ends up in one folder, as
   * ever, and one that is already there is counted and left alone. Like filing one, it is not an edit of any question: no version, no
   * history entry and no change of notes.
   */
  moveManyToFolder(questionIds: readonly string[], folderId: string | undefined): { filed: number; alreadyThere: number } {
    const ids = [...new Set(questionIds)];
    const missing = ids.filter((id) => !this.questions.has(id));
    if (missing.length > 0) {
      throw new Error(`No question with the id ${missing[0]} is in this bank.${missing.length > 1 ? ` (${missing.length - 1} more are not either.)` : ""}`);
    }
    const target = folderId === undefined ? undefined : this.folderNamed(folderId);
    const moving = ids.filter((id) => this.folderIdOf(id) !== folderId);
    // All of them leave every folder in one walk of the tree. Taking each out on its own walked every folder, and looked through every
    // list, for every question: 20,000 questions took 2.3 seconds, and the cost was the square of the bank.
    this.takeOutOfFolders(moving);
    for (const id of moving) {
      if (target && folderId !== undefined) {
        target.questionIds.push(id);
        this.folderOf.set(id, folderId);
      } else {
        this.folderOf.delete(id);
      }
    }
    return { filed: moving.length, alreadyThere: ids.length - moving.length };
  }

  /** Every place they are listed, not the first: a damaged file can list one question twice, and it would stay in the second. */
  private takeOutOfFolders(questionIds: readonly string[]): void {
    if (questionIds.length === 0) return;
    const going = new Set(questionIds);
    for (const node of this.allFolders()) {
      if (node.questionIds.some((q) => going.has(q))) node.questionIds = node.questionIds.filter((q) => !going.has(q));
    }
  }

  /**
   * The folders as a list in the order a person sees them (each folder, then what is inside it), with how many questions are in each
   * alone and under it. Only questions this bank holds are counted.
   */
  folderList(): FolderListing[] {
    const out: FolderListing[] = [];
    const walk = (nodes: readonly FolderNode[], depth: number, parentId: string | undefined) => {
      for (const node of nodes) {
        const own = node.questionIds.filter((q) => this.questions.has(q)).length;
        const at = out.length;
        out.push({ id: node.id, name: node.name, depth, parentId, own, total: own });
        walk(node.children, depth + 1, node.id);
        out[at]!.total = own + out.slice(at + 1).filter((f) => f.parentId === node.id).reduce((sum, f) => sum + f.total, 0);
      }
    };
    walk(this.folders.root, 0, undefined);
    return out;
  }

  /** The questions in a folder and in the folders inside it. */
  questionIdsUnder(folderId: string): Set<string> {
    const ids = new Set<string>();
    for (const q of questionsUnder(this.folderNamed(folderId))) if (this.questions.has(q)) ids.add(q);
    return ids;
  }

  /** The questions that are in no folder (or in one that is no longer there). */
  unfiledIds(): Set<string> {
    const filed = new Set<string>();
    for (const node of this.allFolders()) for (const q of node.questionIds) filed.add(q);
    return new Set([...this.questions.keys()].filter((q) => !filed.has(q)));
  }

  /** The folder a question is in, if it is in one. */
  folderIdOf(questionId: string): string | undefined {
    return this.folderOf.get(questionId);
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
