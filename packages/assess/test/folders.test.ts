/**
 * Folders in a bank: making them, naming them, moving them, taking them away, and filing questions in them.
 *
 * The rule under all of it: a folder is a way of finding questions, never a place a question can be lost. Taking a folder away leaves
 * its questions in the bank, in no folder; a damaged folder file can list a question twice or name one that is not there, and none of
 * that may make a question appear in two places, vanish from the bank, or put a folder inside itself.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Bank } from "../src/bank/store.ts";
import { FOLDER_NAME_MAX, cleanFolderName, walkFolders } from "../src/model/bank.ts";
import { createQuestion } from "../src/model/create.ts";
import { plainToRich } from "../src/model/richtext.ts";
import type { Question } from "../src/model/question.ts";

const essay = (stem: string): Question => createQuestion({ type: "essay", stem: plainToRich(stem), body: {}, at: "2026-01-01T00:00:00.000Z", by: "test" });

function bankOf(...stems: string[]): { bank: Bank; ids: string[] } {
  const bank = Bank.createEmpty("Folders", { at: "2026-01-01T00:00:00.000Z" });
  const ids = stems.map((s) => bank.add(essay(s)).id);
  return { bank, ids };
}

/** Every rule a bank's folders keep, read from the tree itself and not from what the methods return. */
function holds(bank: Bank): void {
  const seen = new Set<string>();
  const folderIds = new Set<string>();
  for (const node of walkFolders(bank.folders.root)) {
    assert.ok(!folderIds.has(node.id), `folder id ${node.id} is used twice`);
    folderIds.add(node.id);
    for (const q of node.questionIds) {
      assert.ok(!seen.has(q), `question ${q} is in two places`);
      seen.add(q);
      assert.equal(bank.folderIdOf(q), node.id, `the index says ${q} is in ${bank.folderIdOf(q)} and the tree says ${node.id}`);
    }
  }
  for (const [id] of bank.questions) {
    if (!seen.has(id)) assert.equal(bank.folderIdOf(id), undefined, `${id} is in no folder, and the index says it is in one`);
  }
  const listed = bank.folderList();
  assert.equal(listed.length, folderIds.size);
  for (const f of listed) assert.ok(f.total >= f.own);
}

describe("folder names", () => {
  test("are cleaned: spaces made one, the ends trimmed, the characters a file format forbids taken out", () => {
    assert.equal(cleanFolderName("  Chapter   1 \t"), "Chapter 1");
    assert.equal(cleanFolderName("Unit\u000b2\u0000"), "Unit 2", "a vertical tab is a space and not nothing, so two words stay two");
    assert.equal(cleanFolderName("Café ☕ 第一章"), "Café ☕ 第一章");
  });

  test("with nothing in them, or too long, are refused in words", () => {
    for (const bad of ["", "   ", "\u0000\u0001", "\t\n"]) assert.throws(() => cleanFolderName(bad), /A folder needs a name\./);
    assert.equal(cleanFolderName("x".repeat(FOLDER_NAME_MAX)).length, FOLDER_NAME_MAX);
    assert.throws(() => cleanFolderName("x".repeat(FOLDER_NAME_MAX + 1)), /at most 80 characters/);
    // Counted as a person counts them: one emoji is one.
    assert.equal([...cleanFolderName("😀".repeat(FOLDER_NAME_MAX))].length, FOLDER_NAME_MAX);
  });
});

describe("making and renaming folders", () => {
  test("a folder can be made at the top or inside another, and two side by side cannot share a name", () => {
    const { bank } = bankOf("One");
    const a = bank.addFolder("Chapter 1");
    const inner = bank.addFolder("Quizzes", a.id);
    assert.deepEqual(bank.folderList().map((f) => [f.name, f.depth]), [["Chapter 1", 0], ["Quizzes", 1]]);
    assert.throws(() => bank.addFolder("chapter 1"), /already a folder called "chapter 1" in that place/, "the case does not make a different name");
    assert.throws(() => bank.addFolder("Quizzes", a.id), /already a folder called/);
    const b = bank.addFolder("Chapter 2");
    assert.doesNotThrow(() => bank.addFolder("Quizzes", b.id), "the same name in another place is another folder");
    assert.throws(() => bank.addFolder("Nowhere", "no-such-folder"), /No folder with the id no-such-folder/);
    assert.equal(bank.folderList().length, 4, "a refused folder was not made");
    assert.ok(inner.id !== a.id);
    holds(bank);
  });

  test("an accent written two ways is one name", () => {
    const { bank } = bankOf("One");
    bank.addFolder("Café");
    assert.throws(() => bank.addFolder("Café"), /already a folder/);
  });

  test("a folder can be renamed, and not to the name of one beside it", () => {
    const { bank } = bankOf("One");
    const a = bank.addFolder("Draft");
    const b = bank.addFolder("Final");
    assert.equal(bank.renameFolder(a.id, "  Drafts  ").name, "Drafts");
    assert.throws(() => bank.renameFolder(b.id, "drafts"), /already a folder called/);
    assert.equal(bank.renameFolder(b.id, "Final").name, "Final", "the same name is not a clash with itself");
    assert.equal(bank.renameFolder(b.id, "FINAL").name, "FINAL", "and a change of case only is a rename");
    assert.throws(() => bank.renameFolder("nothing", "X"), /No folder with the id nothing/);
    assert.throws(() => bank.renameFolder(a.id, ""), /needs a name/);
    assert.equal(bank.folderList()[0]?.name, "Drafts");
    assert.ok(bank.history.some((h) => h.change === "renamed the folder Draft to Drafts"));
  });
});

describe("filing questions", () => {
  test("a question is in one folder at a time, and can be taken out of it", () => {
    const { bank, ids } = bankOf("One", "Two", "Three");
    const a = bank.addFolder("A");
    const b = bank.addFolder("B");
    bank.moveToFolder(ids[0] as string, a.id);
    bank.moveToFolder(ids[1] as string, a.id);
    bank.moveToFolder(ids[0] as string, b.id);
    assert.deepEqual(bank.folderList().map((f) => [f.name, f.own]), [["A", 1], ["B", 1]]);
    assert.equal(bank.folderIdOf(ids[0] as string), b.id);
    bank.unfile(ids[0] as string);
    assert.equal(bank.folderIdOf(ids[0] as string), undefined);
    assert.deepEqual([...bank.unfiledIds()].sort(), [ids[0], ids[2]].sort());
    assert.throws(() => bank.moveToFolder("nothing", a.id), /No question with the id nothing/);
    assert.throws(() => bank.moveToFolder(ids[2] as string, "nothing"), /No folder with the id nothing/);
    assert.throws(() => bank.unfile("nothing"), /No question with the id nothing/);
    holds(bank);
  });

  test("a question added into a folder is in it, and a wrong folder adds nothing", () => {
    const { bank } = bankOf("One");
    const a = bank.addFolder("A");
    const q = bank.add(essay("Two"), { folderId: a.id });
    assert.equal(bank.folderIdOf(q.id), a.id);
    assert.throws(() => bank.add(essay("Three"), { folderId: "nothing" }), /No folder with the id nothing/);
    assert.equal(bank.questions.size, 2);
  });

  test("a damaged file that lists one question twice does not keep it in the second place", () => {
    const { bank, ids } = bankOf("One", "Two");
    const a = bank.addFolder("A");
    const b = bank.addFolder("B");
    // What a merge of two copies of the file can leave: the question in both folders, and twice in one.
    a.questionIds.push(ids[0] as string, ids[0] as string);
    b.questionIds.push(ids[0] as string);
    bank.rebuildIndex();
    bank.moveToFolder(ids[0] as string, b.id);
    // Length, not deepEqual: the assertion would narrow the list to a list of nothing, and the next push would not type.
    assert.equal(a.questionIds.length, 0);
    assert.deepEqual(b.questionIds, [ids[0]]);
    a.questionIds.push(ids[1] as string, ids[1] as string);
    bank.unfile(ids[1] as string);
    assert.equal(a.questionIds.length, 0, "not left in the second place it was listed");
    holds(bank);
  });

  test("removing a question from the bank takes it out of its folder", () => {
    const { bank, ids } = bankOf("One", "Two");
    const a = bank.addFolder("A");
    bank.moveToFolder(ids[0] as string, a.id);
    bank.remove(ids[0] as string);
    assert.deepEqual(a.questionIds, []);
    holds(bank);
  });
});

describe("counts", () => {
  test("say how many are in a folder alone and under it, and count only questions the bank holds", () => {
    const { bank, ids } = bankOf("One", "Two", "Three", "Four");
    const a = bank.addFolder("A");
    const b = bank.addFolder("B", a.id);
    const c = bank.addFolder("C", b.id);
    bank.moveToFolder(ids[0] as string, a.id);
    bank.moveToFolder(ids[1] as string, b.id);
    bank.moveToFolder(ids[2] as string, c.id);
    // A question this bank could not read is named in the folder file and is not counted.
    c.questionIds.push("q_unreadable");
    bank.rebuildIndex();
    assert.deepEqual(bank.folderList().map((f) => [f.name, f.own, f.total]), [["A", 1, 3], ["B", 1, 2], ["C", 1, 1]]);
    assert.deepEqual([...bank.questionIdsUnder(a.id)].sort(), [ids[0], ids[1], ids[2]].sort());
    assert.deepEqual([...bank.questionIdsUnder(c.id)], [ids[2]]);
    assert.deepEqual([...bank.unfiledIds()], [ids[3]]);
    assert.throws(() => bank.questionIdsUnder("nothing"), /No folder with the id nothing/);
  });
});

describe("taking a folder away", () => {
  test("keeps its questions, in no folder, and moves the folders inside it up", () => {
    const { bank, ids } = bankOf("One", "Two", "Three");
    const a = bank.addFolder("A");
    const b = bank.addFolder("B", a.id);
    bank.addFolder("C", b.id);
    bank.moveToFolder(ids[0] as string, a.id);
    bank.moveToFolder(ids[1] as string, b.id);
    const done = bank.removeFolder(b.id);
    assert.deepEqual(done, { unfiled: 1, movedUp: 1 });
    assert.deepEqual(bank.folderList().map((f) => [f.name, f.depth]), [["A", 0], ["C", 1]], "C is now inside A");
    assert.equal(bank.questions.size, 3, "no question was lost");
    assert.equal(bank.folderIdOf(ids[1] as string), undefined);
    assert.equal(bank.folderIdOf(ids[0] as string), a.id);
    assert.ok(bank.history.some((h) => h.change === "removed the folder B; 1 question is in no folder now"));
    holds(bank);
  });

  test("moves a folder at the top up to the top, and keeps a name that would clash by numbering it", () => {
    const { bank } = bankOf("One");
    const a = bank.addFolder("A");
    bank.addFolder("Notes", a.id);
    bank.addFolder("Notes");
    bank.removeFolder(a.id);
    // The one that moved up takes the place of the folder that went, and is the one numbered, since the other was there first.
    assert.deepEqual(bank.folderList().map((f) => f.name), ["Notes (2)", "Notes"], "neither was merged or lost");
    holds(bank);
  });

  test("says when it names a question the bank could not read", () => {
    const { bank } = bankOf("One");
    const a = bank.addFolder("A");
    a.questionIds.push("q_unreadable");
    bank.rebuildIndex();
    assert.deepEqual(bank.removeFolder(a.id), { unfiled: 0, movedUp: 0 });
    assert.ok(bank.history.some((h) => /it also named 1 question this bank could not read/.test(h.change)));
  });

  test("a folder that is not there is not found", () => {
    const { bank } = bankOf("One");
    assert.throws(() => bank.removeFolder("nothing"), /No folder with the id nothing/);
  });
});

describe("moving a folder", () => {
  test("goes inside another, or back to the top, and never inside itself or what it holds", () => {
    const { bank } = bankOf("One");
    const a = bank.addFolder("A");
    const b = bank.addFolder("B", a.id);
    const c = bank.addFolder("C", b.id);
    const d = bank.addFolder("D");
    assert.throws(() => bank.moveFolder(a.id, a.id), /cannot be moved into itself/);
    assert.throws(() => bank.moveFolder(a.id, c.id), /cannot be moved into itself or into a folder inside it/);
    bank.moveFolder(c.id, d.id);
    assert.deepEqual(bank.folderList().map((f) => [f.name, f.depth]), [["A", 0], ["B", 1], ["D", 0], ["C", 1]]);
    bank.moveFolder(c.id);
    assert.deepEqual(bank.folderList().map((f) => [f.name, f.depth]), [["A", 0], ["B", 1], ["D", 0], ["C", 0]]);
    assert.equal(bank.moveFolder(c.id).id, c.id, "already there is not an error");
    holds(bank);
  });

  test("not to a place that has a folder of that name", () => {
    const { bank } = bankOf("One");
    const a = bank.addFolder("A");
    bank.addFolder("Notes", a.id);
    const notes = bank.addFolder("Notes");
    assert.throws(() => bank.moveFolder(notes.id, a.id), /already a folder called "Notes"/);
    assert.deepEqual(bank.folderList().map((f) => f.name), ["A", "Notes", "Notes"], "and it stayed where it was");
  });

  test("takes its questions with it", () => {
    const { bank, ids } = bankOf("One");
    const a = bank.addFolder("A");
    const b = bank.addFolder("B");
    bank.moveToFolder(ids[0] as string, a.id);
    bank.moveFolder(a.id, b.id);
    assert.equal(bank.folderIdOf(ids[0] as string), a.id);
    assert.deepEqual([...bank.questionIdsUnder(b.id)], [ids[0]]);
  });
});

describe("saving", () => {
  test("keeps the folders, what is in them and their order, through a save and an open", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openassess-folders-"));
    try {
      const { bank, ids } = bankOf("One", "Two", "Three");
      const a = bank.addFolder("Chapter 1");
      const b = bank.addFolder("Quizzes", a.id);
      bank.addFolder("Chapter 2");
      bank.moveToFolder(ids[0] as string, a.id);
      bank.moveToFolder(ids[1] as string, b.id);
      const path = join(dir, "f.openassess");
      await bank.save(path);
      const { bank: again, report } = await Bank.open(path);
      assert.deepEqual(report.invalid, []);
      assert.deepEqual(again.folderList().map((f) => [f.name, f.depth, f.own, f.total]), [["Chapter 1", 0, 1, 2], ["Quizzes", 1, 1, 1], ["Chapter 2", 0, 0, 0]]);
      assert.equal(again.folderIdOf(ids[1] as string), b.id);
      assert.deepEqual([...again.unfiledIds()], [ids[2]]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("any run of changes", () => {
  test("keeps every rule, and loses no question, from a fixed seed", () => {
    let seed = 20261105;
    const next = (n: number): number => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed % n;
    };
    for (let run = 0; run < 60; run++) {
      const { bank, ids } = bankOf("a", "b", "c", "d", "e", "f");
      const names = ["A", "B", "C", "a", "Notes", "Café"];
      for (let step = 0; step < 80; step++) {
        const folders = bank.allFolders();
        const folder = () => folders[next(Math.max(folders.length, 1))]?.id ?? "nothing";
        const question = () => ids[next(ids.length)] as string;
        const parent = () => (next(3) === 0 || folders.length === 0 ? undefined : folder());
        try {
          switch (next(7)) {
            case 0:
              bank.addFolder(names[next(names.length)] as string, parent());
              break;
            case 1:
              bank.renameFolder(folder(), names[next(names.length)] as string);
              break;
            case 2:
              bank.removeFolder(folder());
              break;
            case 3:
              bank.moveFolder(folder(), parent());
              break;
            case 4:
              bank.moveToFolder(question(), folder());
              break;
            case 5:
              bank.unfile(question());
              break;
            default:
              bank.moveToFolder(question(), folder());
          }
        } catch (error) {
          // A refusal is a sentence, never a TypeError.
          assert.ok(/folder|question|name/i.test((error as Error).message), (error as Error).message);
          assert.ok(!(error instanceof TypeError), (error as Error).message);
        }
        holds(bank);
        assert.equal(bank.questions.size, ids.length, "no question was lost");
      }
    }
  });
});
