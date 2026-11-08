/**
 * A question table that puts the right answer in a column of its own and the wrong answers in the columns after it.
 *
 * The first real table of this kind was an amateur radio question bank (`question_id;question_english;correct_answer_english;
 * incorrect_answer_1_english;...` with the same columns again for French), which the importer read as 550 lines of unclaimed
 * text. The key in such a table is the column the words stand in, so it is read from the names in the first row and from nothing
 * else; but the right answer is first in every row, so left as it stands the key of the whole bank would be A, and so would
 * version A of every printed test. The answers are mixed at import, the same way each time, with the right answer kept with its
 * own words, and the file says so. The text here is invented. The real file is held to an independent reading when it is on the
 * machine (`fixtures/publisher/tables`, git-ignored).
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { importerForContent, runImporter } from "../src/import/registry.ts";
import { spreadsheetImporter } from "../src/import/spreadsheet.ts";
import type { ImportResult } from "../src/import/types.ts";
import { FindingCode, liveFindings, verdictFrom } from "../src/model/findings.ts";
import type { Question } from "../src/model/question.ts";
import { richTextToPlain } from "../src/model/richtext.ts";

const AT = "2026-11-07T00:00:00.000Z";
const bytes = (text: string): Uint8Array => new Uint8Array(Buffer.from(text, "utf8"));
const csv = (text: string, file = "questions.csv"): ImportResult => spreadsheetImporter.parseBytes?.(bytes(text), { file, at: AT, author: "test" }) as ImportResult;
const plain = (v: unknown): string => richTextToPlain(v as never).replace(/\s+/g, " ").trim();
const options = (q: Question): Array<[string, boolean]> => (q.body as unknown as { options: Array<{ content: unknown; correct: boolean }> }).options.map((o) => [plain(o.content), o.correct]);
const right = (q: Question): string[] => options(q).filter(([, c]) => c).map(([t]) => t);
const codes = (q: Question): string[] => liveFindings(q.findings).map((f) => f.code);
const notes = (r: ImportResult): string[] => r.fileFindings.map((f) => `${f.severity}: ${f.message}`);

const HEAD = "Question,Correct answer,Incorrect answer 1,Incorrect answer 2,Incorrect answer 3";

describe("a table with a column for the right answer and columns for the wrong ones", () => {
  test("reads the right answer from its column, and keeps it with its own words", () => {
    const r = csv(`${HEAD}\nWhich planet is nearest the Sun?,Mercury,Venus,Mars,Jupiter\nWhich gas do plants take in?,Carbon dioxide,Oxygen,Helium,Neon`);
    assert.equal(r.questions.length, 2);
    assert.equal(r.orphans.length, 0);
    const [first, second] = r.questions as [Question, Question];
    assert.deepEqual(right(first), ["Mercury"]);
    assert.deepEqual(right(second), ["Carbon dioxide"]);
    assert.deepEqual(options(first).map(([t]) => t).sort(), ["Jupiter", "Mars", "Mercury", "Venus"]);
    assert.equal(verdictFrom(first.findings), "parsed");
  });

  test("mixes the answers so the key is not A throughout, the same way every time", () => {
    const rows = Array.from({ length: 24 }, (_, i) => `Question number ${i + 1}?,Right ${i},Wrong a${i},Wrong b${i},Wrong c${i}`).join("\n");
    const a = csv(`${HEAD}\n${rows}`);
    const b = csv(`${HEAD}\n${rows}`);
    const place = (r: ImportResult): number[] => r.questions.map((q) => options(q).findIndex(([, c]) => c));
    assert.deepEqual(place(a), place(b), "reading the file again gives the same order");
    // A shuffle may put one question's right answer back in the first place; what must not happen is the key being A throughout.
    assert.ok(place(a).filter((p) => p === 0).length <= 12, `the right answer is not first in most rows: ${place(a).join("")}`);
    assert.ok(new Set(place(a)).size >= 3, "spread over more than one place");
    for (const q of a.questions) assert.equal(right(q).length, 1);
    a.questions.forEach((q, i) => assert.deepEqual(right(q), [`Right ${i}`]));
  });

  test("says that it mixed them, and how many", () => {
    const r = csv(`${HEAD}\nOne?,R1,W1,W2,W3\nTwo?,R2,W4,W5,W6`);
    const said = notes(r).find((n) => /right answer is in a column of its own/.test(n));
    assert.ok(said, notes(r).join("\n"));
    assert.match(said as string, /info: /);
    assert.match(said as string, /answers of 2 questions were mixed/);
    assert.match(said as string, /"Correct answer"/);
  });

  test("keeps the file's order for a question whose answers depend on their place", () => {
    const r = csv(`${HEAD}\nWhich is true?,Only the first,Only the second,Neither,None of the above\nAnother?,Yes,No,Maybe,Perhaps`);
    const [first, second] = r.questions as [Question, Question];
    assert.deepEqual(options(first).map(([t]) => t), ["Only the first", "Only the second", "Neither", "None of the above"]);
    assert.deepEqual(right(first), ["Only the first"]);
    assert.deepEqual(right(second), ["Yes"]);
    const said = notes(r).find((n) => /right answer is in a column of its own/.test(n)) as string;
    assert.match(said, /answers of 1 question were mixed/);
    assert.match(said, /1 question keeps the order of the file/);
  });

  test("an empty cell for the right answer leaves no answer marked and says so, and nothing is made up", () => {
    const r = csv(`${HEAD}\nWhich is it?,,Venus,Mars,Jupiter`);
    const q = r.questions[0] as Question;
    assert.deepEqual(right(q), []);
    assert.deepEqual(options(q).map(([t]) => t), ["Venus", "Mars", "Jupiter"], "kept in the file's order, since there is no key to follow");
    assert.notEqual(verdictFrom(q.findings), "parsed");
    assert.ok(codes(q).includes(FindingCode.KeyLetterMissing) || verdictFrom(q.findings) === "failed", codes(q).join(","));
  });

  test("a gap among the wrong answers does not leave a gap among the options", () => {
    const r = csv(`${HEAD}\nWhich?,Right,,Wrong two,\nOther?,Yes,No,,`);
    const [a, b] = r.questions as [Question, Question];
    assert.deepEqual(options(a).map(([t]) => t).sort(), ["Right", "Wrong two"]);
    assert.deepEqual(right(a), ["Right"]);
    assert.deepEqual(right(b), ["Yes"]);
    assert.equal(options(b).length, 2);
    assert.ok(!codes(a).includes(FindingCode.OptionLetterGap), "there are no letters in this layout to leave a gap in");
  });

  test("a question with only one answer is kept with a placeholder and an error, and its right answer is not lost", () => {
    const r = csv(`${HEAD}\nOne answer only?,The right one,,,`);
    const q = r.questions[0] as Question;
    assert.ok(r.questions.length === 1 && q);
    assert.ok(JSON.stringify(q).includes("The right one"), "the words are kept somewhere in the question");
  });

  test("the question's own number in the file is kept where the bank can find it", () => {
    const r = csv(`Question ID,${HEAD}\nA-001-002-003,Which?,Right,Wrong 1,Wrong 2,Wrong 3`);
    const q = r.questions[0] as Question;
    assert.equal(q.metadata.custom?.["Question ID"], "A-001-002-003");
    assert.ok(!notes(r).some((n) => /not used/.test(n) && /Question ID/.test(n)), notes(r).join("\n"));
  });
});

describe("a table made for two languages", () => {
  const TWO = "question_id;question_english;correct_answer_english;incorrect_answer_1_english;incorrect_answer_2_english;question_french;correct_answer_french;incorrect_answer_1_french;incorrect_answer_2_french";

  test("reads the first language, and says the second was left out", () => {
    const r = csv(`${TWO}\nQ-1;Which is cold?;Ice;Fire;Lava;Lequel est froid?;La glace;Le feu;La lave`, "bank.csv");
    assert.equal(r.questions.length, 1);
    const q = r.questions[0] as Question;
    assert.equal(plain(q.stem), "Which is cold?");
    assert.deepEqual(right(q), ["Ice"]);
    assert.ok(!JSON.stringify(q).includes("glace"), "none of the French is in the English question");
    const left = notes(r).find((n) => /repeat one already read/.test(n)) as string;
    assert.ok(left, notes(r).join("\n"));
    assert.match(left, /question_french/);
    assert.match(left, /correct_answer_french/);
  });

  test("reads the other language when it comes first", () => {
    const r = csv("question_french;correct_answer_french;incorrect_answer_1_french;question_english;correct_answer_english;incorrect_answer_1_english\nLequel est froid?;La glace;Le feu;Which is cold?;Ice;Fire", "bank.csv");
    const q = r.questions[0] as Question;
    assert.equal(plain(q.stem), "Lequel est froid?");
    assert.deepEqual(right(q), ["La glace"]);
  });

  test("a semicolon table saved as .txt is chosen for its first row, not mistaken for the standard format", () => {
    const text = `${TWO}\nQ-1;Which is cold?;Ice;Fire;Lava;Lequel est froid?;La glace;Le feu;La lave`;
    assert.equal(importerForContent("bank.txt", bytes(text)), spreadsheetImporter);
    const r = runImporter(importerForContent("bank.txt", bytes(text)), bytes(text), { file: "bank.txt", at: AT, author: "test" });
    assert.equal(r.questions.length, 1);
    assert.equal(r.orphans.length, 0);
  });

  test("a word that is not a language, or a language that is the whole name, is left alone", () => {
    // "Question Penguin" is not a column this reader knows; "Chinese" on its own is not either.
    const r = csv("Question,Correct answer,Incorrect answer 1,Chinese,Question Penguin\nWhich?,Right,Wrong,x,y");
    assert.equal(r.questions.length, 1);
    const unused = notes(r).find((n) => /were not used/.test(n)) as string;
    assert.match(unused, /Chinese/);
    assert.match(unused, /Question Penguin/);
  });
});

describe("what does not mix", () => {
  test("wrong answer columns beside answer columns A, B, C are not used, and the letters stay the key", () => {
    const r = csv("Question,A,B,C,Correct,Incorrect answer 1\nWhich?,One,Two,Three,B,Four");
    const q = r.questions[0] as Question;
    assert.deepEqual(options(q), [["One", false], ["Two", true], ["Three", false]]);
    const said = notes(r).find((n) => /wrong answers/.test(n)) as string;
    assert.ok(said, notes(r).join("\n"));
    assert.match(said, /Incorrect answer 1/);
    assert.match(said, /not used/);
  });

  test("wrong answer columns with no column for the right answer give no key, and are said", () => {
    const r = csv("Question,Incorrect answer 1,Incorrect answer 2\nWhich?,Venus,Mars");
    const q = r.questions[0] as Question;
    assert.ok(q);
    assert.notEqual(q.type, "multipleChoice", "no answers were read, so nothing to mark");
    assert.ok(notes(r).some((n) => /wrong answers/.test(n) && /not used/.test(n)), notes(r).join("\n"));
  });

  test("a text file whose first row names wrong answer columns is read as a table, so the reason is said and not 500 orphan lines", () => {
    const text = "Question;Incorrect answer 1;Incorrect answer 2\nWhich?;Venus;Mars";
    assert.equal(importerForContent("bank.txt", bytes(text)), spreadsheetImporter);
  });

  test("a wrong answer number past the last answer column is reported as not used", () => {
    const r = csv(`${HEAD},Incorrect answer 9\nWhich?,Right,A,B,C,Nine`);
    const q = r.questions[0] as Question;
    assert.ok(!JSON.stringify(q).includes("Nine"));
    assert.match(notes(r).join("\n"), /Incorrect answer 9/);
  });

  test("two columns for the same wrong answer: the first is read and the second is said to repeat it", () => {
    const r = csv("Question,Correct,Wrong 1,Wrong 1\nWhich?,Right,First,Second");
    const q = r.questions[0] as Question;
    assert.deepEqual(options(q).map(([t]) => t).sort(), ["First", "Right"]);
    assert.match(notes(r).join("\n"), /repeat/);
  });
});

describe("the other kinds of question in such a table", () => {
  test("a Type column is believed: true or false is read from the right answer column", () => {
    const r = csv("Type,Question,Correct answer,Incorrect answer 1\nTF,The sky is blue.,True,False\nTF,Fish can fly.,False,True");
    const [a, b] = r.questions as [Question, Question];
    assert.equal(a.type, "trueFalse");
    assert.equal((a.body as unknown as { correct: boolean }).correct, true);
    assert.equal((b.body as unknown as { correct: boolean }).correct, false);
  });

  test("a short answer takes the right answer column as what is accepted, and the wrong answers are said", () => {
    const r = csv("Type,Question,Correct answer,Incorrect answer 1\nSA,Name the planet nearest the Sun.,Mercury | mercury,Venus");
    const q = r.questions[0] as Question;
    assert.equal(q.type, "shortAnswer");
    assert.deepEqual((q.body as unknown as { accepted: string[] }).accepted, ["Mercury", "mercury"]);
    assert.ok(q.findings.some((f) => /wrong answers were not used/.test(f.message)));
  });

  test("a multiple response type marks only the one right answer there is, and says so", () => {
    const r = csv(`Type,${HEAD}\nMR,Which are prime?,Two,Four,Six,Eight`);
    const q = r.questions[0] as Question;
    assert.equal(q.type, "multipleResponse");
    assert.deepEqual(right(q), ["Two"]);
    assert.ok(q.findings.some((f) => /only that answer is marked/.test(f.message)));
  });
});

describe("the real radio bank, when it is on this machine", () => {
  const path = join(fileURLToPath(new URL("../../../fixtures/publisher/tables/amat_adv_quest_delim.txt", import.meta.url)));
  test("each of its questions agrees with a plain split of the file's own lines", { skip: !existsSync(path) && "the file is not in fixtures/publisher/tables" }, () => {
    const raw = readFileSync(path);
    const result = runImporter(importerForContent("amat_adv_quest_delim.txt", new Uint8Array(raw)), new Uint8Array(raw), { file: "amat_adv_quest_delim.txt", at: AT, author: "test" });
    const lines = raw.toString("utf8").split(/\r?\n/).filter((l) => l.trim() !== "").slice(1);
    const rows = lines.map((l) => l.split(";").map((c) => c.trim().replace(/\s+/g, " ")));
    assert.equal(result.questions.length, rows.length);
    assert.equal(result.orphans.length, 0);
    const places = [0, 0, 0, 0];
    result.questions.forEach((q, i) => {
      const cells = rows[i] as string[];
      assert.equal(plain(q.stem), cells[1]);
      assert.equal(q.metadata.custom?.["Question ID"], cells[0]);
      assert.deepEqual(right(q), [cells[2]]);
      assert.deepEqual(options(q).map(([t]) => t).sort(), [cells[2], cells[3], cells[4], cells[5]].sort());
      const at = options(q).findIndex(([, c]) => c);
      places[at] = (places[at] ?? 0) + 1;
    });
    assert.ok(places.every((n) => n > rows.length / 8), `the right answer sits in every place: ${places.join(", ")}`);
  });
});
