/**
 * Assembled tests and their versions. The rules under test: a record holds a copy of every question as it was used, so editing the
 * bank later changes nothing; versions come from one stored seed, so printing again gives the same versions; true or false is never
 * reordered; a question whose answers depend on their place keeps them in order, and the record says why; a letter on any version
 * maps back to the bank's own answer and the other way; a record that does not hold together is never accepted, and a damaged one in
 * a bank is kept as it was and reported, never dropped; and every version prints a booklet and a key that agree.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { inflateSync } from "node:zlib";

import { Bank } from "../src/bank/store.ts";
import { jsonEntry, textEntry, unzipSync, zipSync } from "../src/container/zip.ts";
import { createQuestion } from "../src/model/create.ts";
import { shuffledFor } from "../src/model/random.ts";
import { plainToRich, richTextToPlain } from "../src/model/richtext.ts";
import type { Question, QuestionBody, QuestionType } from "../src/model/question.ts";
import {
  MAX_VERSIONS,
  VERSION_LABELS,
  answerAt,
  createTest,
  keepsOrder,
  letterFor,
  testFingerprint,
  validateTest,
  versionOf,
  versionQuestions,
  type TestRecord,
} from "../src/model/test.ts";
import { versionKey } from "../src/quality/test-key.ts";
import { layoutTest, printOptions, printVersions, type Block } from "../src/print/index.ts";

const AT = "2026-01-01T00:00:00.000Z";
let made = 0;
const opt = (id: string, text: string, correct = false, extra: Record<string, unknown> = {}) => ({ id, content: plainToRich(text), correct, ...extra });
const make = (type: QuestionType, body: QuestionBody, stem: string, extra: Partial<Parameters<typeof createQuestion>[0]> = {}): Question =>
  createQuestion({ type, stem: plainToRich(stem), body, by: "t", at: AT, id: `q_${String(++made).padStart(26, "0")}`, ...extra });

const choices = (n: number, right: number[], shuffle = true) => ({ shuffle, options: Array.from({ length: n }, (_x, i) => opt(`o${i + 1}`, `Answer ${i + 1}`, right.includes(i))) });

/** A bank of questions of every kind a sheet carries and a few it does not. */
function bank(): Question[] {
  return [
    make("multipleChoice", choices(4, [1]), "Which planet is closest to the Sun?"),
    make("multipleChoice", { shuffle: true, options: [opt("o1", "Mercury", true), opt("o2", "Venus"), opt("o3", "None of the above")] }, "Which is a moon?"),
    make("multipleResponse", { shuffle: true, partialCredit: false, options: [opt("o1", "Red", true), opt("o2", "Green"), opt("o3", "Blue", true), opt("o4", "Pink"), opt("o5", "Grey")] }, "Which are primary colours?"),
    make("trueFalse", { correct: true }, "The Moon orbits the Earth."),
    make("multipleChoice", choices(4, [2], false), "Which keeps its order?"),
    make("multipleChoice", { shuffle: true, options: [opt("o1", "Alpha", true), opt("o2", "Beta"), opt("o3", "Gamma", false, { fixedPosition: true })] }, "Which has a fixed answer?"),
    make("multipleChoice", { shuffle: true, options: [opt("o1", "Both A and B"), opt("o2", "Mercury", true), opt("o3", "Venus"), opt("o4", "Neither")] }, "Which depends on a letter?"),
    make("essay", {}, "Discuss."),
    make("multipleChoice", choices(5, [4]), "Which one is last?"),
    make("trueFalse", { correct: false }, "The Sun is a planet."),
    make("multipleChoice", choices(3, []), "A question with no answer marked?"),
    make("multipleChoice", choices(6, [0]), "A six-way question?"),
  ];
}

const testOf = (more: Partial<Parameters<typeof createTest>[0]> = {}): TestRecord => createTest({ name: "Quiz 1", questions: bank(), versions: 4, seed: "seed-one", at: AT, ...more });
const ids = (list: readonly Question[]): string[] => list.map((q) => q.id);

describe("making a test", () => {
  test("needs a name, one to four versions, and a question", () => {
    assert.throws(() => createTest({ name: "  ", questions: bank() }), /needs a name/);
    assert.throws(() => createTest({ name: "x", questions: [] }), /at least one question/);
    for (const versions of [0, 5, 1.5, -1, Number.NaN]) assert.throws(() => createTest({ name: "x", questions: bank(), versions }), /1 to 4 versions/, String(versions));
    assert.equal(MAX_VERSIONS, 4);
    for (let n = 1; n <= 4; n++) assert.equal(createTest({ name: "x", questions: bank(), versions: n }).versions.length, n);
  });

  test("refuses a question twice, and sections that do not hold each question once", () => {
    const questions = bank();
    assert.throws(() => createTest({ name: "x", questions: [...questions, questions[0] as Question] }), /twice/);
    const a = questions.slice(0, 6).map((q) => q.id);
    const b = questions.slice(6).map((q) => q.id);
    assert.throws(() => createTest({ name: "x", questions, sections: [{ title: "One", questionIds: a }] }), /Every question has to be in a section/);
    assert.throws(() => createTest({ name: "x", questions, sections: [{ title: "One", questionIds: [...a, a[0] as string] }, { title: "Two", questionIds: b }] }), /two sections/);
    assert.throws(() => createTest({ name: "x", questions, sections: [{ title: "One", questionIds: [...a, "q_00000000000000000000000000"] }, { title: "Two", questionIds: b }] }), /not in this test/);
  });

  test("holds a copy of each question as it was used, so editing the bank changes nothing in the record", () => {
    const questions = bank();
    const record = createTest({ name: "x", questions, versions: 2, seed: "s", at: AT });
    const before = JSON.stringify(record);
    (questions[0] as Question).stem = plainToRich("Changed afterwards");
    ((questions[0] as Question).body as { options: Array<{ correct: boolean }> }).options[0]!.correct = true;
    assert.equal(JSON.stringify(record), before);
    assert.notEqual(richTextToPlain(record.questions[0]!.stem), "Changed afterwards");
    record.questions.forEach((q, i) => assert.notEqual(q, bank()[i]));
  });

  test("takes its order from the sections when there are some, and puts each question in one", () => {
    const questions = bank();
    const record = createTest({
      name: "x",
      questions,
      versions: 3,
      seed: "s",
      sections: [
        { title: "Second half", questionIds: questions.slice(6).map((q) => q.id) },
        { title: "First half", questionIds: questions.slice(0, 6).map((q) => q.id) },
      ],
    });
    assert.deepEqual(record.questions.map((q) => q.id), [...ids(questions.slice(6)), ...ids(questions.slice(0, 6))]);
    assert.deepEqual(record.versions[0]?.order, record.questions.map((q) => q.id));
  });
});

describe("versions", () => {
  test("version A is the test as assembled: the questions and answers in their own order", () => {
    const record = testOf();
    const a = versionOf(record, "A")!;
    assert.deepEqual(a.order, record.questions.map((q) => q.id));
    for (const q of record.questions) {
      const options = (q.body as { options?: Array<{ id: string }> }).options;
      if (options) assert.deepEqual(a.options[q.id], options.map((o) => o.id), q.stem.content);
    }
  });

  test("the same seed gives the same versions, and another seed gives other ones", () => {
    const questions = bank();
    const one = testOf({ questions });
    const again = createTest({ name: "Quiz 1", questions, versions: 4, seed: "seed-one", at: AT, id: one.id });
    assert.deepEqual(again.versions, one.versions);
    assert.equal(again.fingerprint, one.fingerprint);
    const other = createTest({ name: "Quiz 1", questions, versions: 4, seed: "seed-two", at: AT, id: one.id });
    assert.notDeepEqual(other.versions, one.versions);
    assert.notEqual(other.fingerprint, one.fingerprint);
  });

  test("a seed is made when none is given, and two tests do not share one", () => {
    const a = createTest({ name: "x", questions: bank(), versions: 2 });
    const b = createTest({ name: "x", questions: bank(), versions: 2 });
    assert.match(a.seed, /^[0-9a-f]{12}$/);
    assert.notEqual(a.seed, b.seed);
    assert.notEqual(a.id, b.id);
  });

  test("versions B to D put the answers of a question in another order than version A, as permutations of the same answers", () => {
    const record = testOf();
    const a = versionOf(record, "A")!;
    for (const label of ["B", "C", "D"] as const) {
      const v = versionOf(record, label)!;
      for (const [id, order] of Object.entries(v.options)) {
        assert.deepEqual([...order].sort(), [...(a.options[id] as string[])].sort(), `${label} ${id}`);
        if (record.keptInOrder[id] === undefined) assert.notDeepEqual(order, a.options[id], `${label} ${id} is shuffled`);
        else assert.deepEqual(order, a.options[id], `${label} ${id} keeps its order`);
      }
    }
  });

  test("true or false and every other question with no choices have no answer order to change", () => {
    const record = testOf();
    for (const v of record.versions) {
      for (const q of record.questions) {
        if (q.type === "multipleChoice" || q.type === "multipleResponse") assert.ok(v.options[q.id], q.stem.content);
        else assert.equal(v.options[q.id], undefined, `${q.type} has no answer order`);
      }
    }
  });

  test("a question whose answers depend on their place keeps them in order, with the reason", () => {
    const record = testOf();
    const reasonFor = (stem: string): string | undefined => record.keptInOrder[record.questions.find((q) => richTextToPlain(q.stem) === stem)!.id];
    assert.match(reasonFor("Which keeps its order?") ?? "", /marked to keep its answers in order/);
    assert.match(reasonFor("Which has a fixed answer?") ?? "", /fixed in place/);
    assert.match(reasonFor("Which is a moon?") ?? "", /depends on its place/);
    assert.match(reasonFor("Which depends on a letter?") ?? "", /depends on its place/);
    assert.equal(reasonFor("Which planet is closest to the Sun?"), undefined);
    assert.equal(reasonFor("Which one is last?"), undefined);
  });

  test("the phrases that depend on a place, and the ones that only look like them", () => {
    const withAnswer = (text: string): Question => make("multipleChoice", { shuffle: true, options: [opt("o1", text, true), opt("o2", "Something else")] }, "Which?");
    for (const depends of ["All of the above", "None of the above", "Both A and B", "A and C", "both B and D", "Neither of these", "Options A and B", "All of them"]) {
      assert.ok(keepsOrder(withAnswer(depends)), depends);
    }
    for (const plain of ["Vitamin A", "Mercury and Venus", "The above-ground part", "Albert Einstein"]) {
      assert.equal(keepsOrder(withAnswer(plain)), undefined, plain);
    }
    assert.equal(keepsOrder(make("trueFalse", { correct: true }, "A statement.")), undefined, "true or false has no answers to keep");
    assert.equal(keepsOrder(make("essay", {}, "Discuss.")), undefined);
  });

  test("questions keep their order in every version unless the test says to shuffle them, and then only within their sections", () => {
    const kept = testOf();
    for (const v of kept.versions) assert.deepEqual(v.order, kept.versions[0]?.order);

    const questions = bank();
    const first = questions.slice(0, 6).map((q) => q.id);
    const second = questions.slice(6).map((q) => q.id);
    const shuffled = createTest({
      name: "x",
      questions,
      versions: 4,
      seed: "order",
      questionOrder: "shuffled",
      sections: [{ title: "One", questionIds: first }, { title: "Two", questionIds: second }],
      at: AT,
    });
    assert.deepEqual(versionOf(shuffled, "A")?.order, [...first, ...second]);
    for (const label of ["B", "C", "D"] as const) {
      const order = versionOf(shuffled, label)!.order;
      assert.deepEqual(order.slice(0, first.length).sort(), [...first].sort(), `${label}: the first section stays first`);
      assert.deepEqual(order.slice(first.length).sort(), [...second].sort(), `${label}: the second stays second`);
      assert.notDeepEqual(order, [...first, ...second], `${label} is another order`);
    }
  });

  test("one version has no other order to make, and a single question cannot be reordered", () => {
    const one = testOf({ versions: 1 });
    assert.equal(one.versions.length, 1);
    const lone = createTest({ name: "x", questions: [make("trueFalse", { correct: true }, "A statement.")], versions: 4, seed: "s" });
    for (const v of lone.versions) assert.deepEqual(v.order, [lone.questions[0]!.id]);
  });
});

describe("what a letter means in a version", () => {
  test("every answer of every question maps to a letter and back, in every version", () => {
    for (const seed of ["a", "b", "c", "seed-one", "x1", "y2"]) {
      const record = testOf({ seed, questionOrder: "shuffled" });
      for (const v of record.versions) {
        for (const q of record.questions) {
          const options = (q.body as { options?: Array<{ id: string }> }).options;
          if (!options) continue;
          options.forEach((o) => {
            const letter = letterFor(record, v.label, q.id, o.id);
            assert.ok(letter && /^[A-Z]$/.test(letter), `${seed} ${v.label} ${q.id} ${o.id}`);
            assert.equal(answerAt(record, v.label, q.id, letter as string), o.id);
          });
          // the letters are the places, in order
          assert.deepEqual((v.options[q.id] as string[]).map((oid) => letterFor(record, v.label, q.id, oid)), options.map((_o, i) => String.fromCharCode(65 + i)));
          // a letter past the last answer names nothing
          assert.equal(answerAt(record, v.label, q.id, String.fromCharCode(65 + options.length)), undefined);
        }
      }
    }
  });

  test("true or false is always True in the first place and False in the second, whatever the version", () => {
    const record = testOf();
    const tf = record.questions.filter((q) => q.type === "trueFalse");
    assert.equal(tf.length, 2);
    for (const v of record.versions) {
      for (const q of tf) {
        assert.equal(answerAt(record, v.label, q.id, "A"), "true");
        assert.equal(answerAt(record, v.label, q.id, "B"), "false");
        assert.equal(answerAt(record, v.label, q.id, "C"), undefined);
        assert.equal(letterFor(record, v.label, q.id, "true"), "A");
        assert.equal(letterFor(record, v.label, q.id, "false"), "B");
        assert.equal(letterFor(record, v.label, q.id, "maybe"), undefined);
      }
    }
  });

  test("a letter that is not a capital, a question that is not there and a version that is not made name nothing", () => {
    const record = testOf({ versions: 2 });
    const q = record.questions[0]!;
    for (const bad of ["a", "", "AB", "1", "?", " "]) assert.equal(answerAt(record, "A", q.id, bad), undefined, JSON.stringify(bad));
    assert.equal(answerAt(record, "A", "q_nope", "A"), undefined);
    assert.equal(answerAt(record, "D", q.id, "A"), undefined, "version D was not made");
    assert.equal(letterFor(record, "D", q.id, "o1"), undefined);
    assert.equal(letterFor(record, "A", q.id, "o99"), undefined);
    assert.throws(() => versionQuestions(record, "D"), /no version D/);
  });

  test("the version's questions are copies in its order with its answers in its order, and the record's own are not touched", () => {
    const record = testOf();
    const own = JSON.stringify(record.questions);
    for (const v of record.versions) {
      const printed = versionQuestions(record, v.label);
      assert.deepEqual(ids(printed), v.order);
      for (const q of printed) {
        const options = (q.body as { options?: Array<{ id: string }> }).options;
        if (options) assert.deepEqual(options.map((o) => o.id), v.options[q.id]);
      }
    }
    assert.equal(JSON.stringify(record.questions), own);
  });

  test("the right answer is the same bank answer in every version, found by its own id", () => {
    const record = testOf();
    for (const q of record.questions) {
      const options = (q.body as { options?: Array<{ id: string; correct: boolean }> }).options;
      if (!options) continue;
      const right = options.filter((o) => o.correct).map((o) => o.id);
      for (const v of record.versions) {
        const printedRight = versionQuestions(record, v.label).find((p) => p.id === q.id)!;
        const ids2 = (printedRight.body as { options: Array<{ id: string; correct: boolean }> }).options.filter((o) => o.correct).map((o) => o.id);
        assert.deepEqual([...ids2].sort(), [...right].sort());
      }
    }
  });
});

describe("the key of a version", () => {
  test("is the letters of the right answers as that version prints them, and agrees with the mapping", () => {
    const record = testOf();
    for (const v of record.versions) {
      const key = versionKey(record, v.label);
      assert.deepEqual(key.map((e) => e.number), key.map((_e, i) => i + 1));
      assert.deepEqual(key.map((e) => e.questionId), v.order);
      for (const entry of key) {
        const q = record.questions.find((x) => x.id === entry.questionId)!;
        if (!entry.letters) continue;
        if (q.type === "trueFalse") assert.deepEqual(entry.letters, [(q.body as { correct: boolean }).correct ? "A" : "B"]);
        else {
          const right = (q.body as { options: Array<{ id: string; correct: boolean }> }).options.filter((o) => o.correct).map((o) => letterFor(record, v.label, q.id, o.id) as string).sort();
          assert.deepEqual([...entry.letters].sort(), right);
          assert.deepEqual(entry.letters, [...entry.letters].sort(), "in alphabetical order");
        }
      }
    }
  });

  test("gives no letters, and says why, for a question with no usable key and for one a sheet cannot carry", () => {
    const record = testOf({ versions: 1 });
    const key = versionKey(record, "A");
    const of = (stem: string) => key.find((e) => richTextToPlain(record.questions.find((q) => q.id === e.questionId)!.stem) === stem)!;
    assert.equal(of("A question with no answer marked?").letters, undefined);
    assert.match(of("A question with no answer marked?").reason ?? "", /no usable answer key, and nothing is guessed/);
    assert.equal(of("Discuss.").letters, undefined);
    assert.match(of("Discuss.").reason ?? "", /cannot carry/);
    assert.deepEqual(of("Which are primary colours?").letters, ["A", "C"]);
    assert.deepEqual(of("The Sun is a planet.").letters, ["B"]);
  });
});

describe("the fingerprint", () => {
  test("is 20 bits, is worked out from the record, and changes with the seed, the id, the versions and the questions", () => {
    const questions = bank();
    const record = testOf({ questions });
    assert.ok(Number.isInteger(record.fingerprint) && record.fingerprint >= 0 && record.fingerprint < 2 ** 20);
    assert.equal(testFingerprint(record), record.fingerprint);
    const make2 = (more: Partial<Parameters<typeof createTest>[0]>): number => createTest({ name: "x", questions, versions: 4, seed: "seed-one", id: record.id, ...more }).fingerprint;
    assert.equal(make2({}), record.fingerprint, "the same things give the same fingerprint");
    const seeds = new Set<number>();
    for (let i = 0; i < 40; i++) seeds.add(make2({ seed: `s${i}` }));
    assert.ok(seeds.size >= 38, `only ${seeds.size} different fingerprints from 40 seeds`);
    assert.notEqual(make2({ versions: 3 }), record.fingerprint, "the number of versions counts");
    assert.notEqual(make2({ questions: questions.slice(1) }), record.fingerprint, "the questions count");
    assert.notEqual(make2({ id: "t_00000000000000000000000009" }), record.fingerprint, "the id counts");
  });
});

describe("checking a record that was read from a file", () => {
  const good = (): TestRecord => JSON.parse(JSON.stringify(testOf())) as TestRecord;
  const reasons = (value: unknown): string => {
    const checked = validateTest(value);
    return checked.ok ? "" : checked.issues.map((i) => `${i.path}: ${i.message}`).join("\n");
  };

  test("accepts what was made, and what comes back from JSON", () => {
    assert.equal(validateTest(testOf()).ok, true);
    assert.equal(validateTest(good()).ok, true);
    for (let n = 1; n <= 4; n++) assert.equal(validateTest(testOf({ versions: n })).ok, true);
  });

  test("refuses a record that does not hold together, naming the part", () => {
    const edit = (change: (r: TestRecord) => void): string => {
      const r = good();
      change(r);
      return reasons(r);
    };
    assert.match(edit((r) => (r.fingerprint = (r.fingerprint + 1) % 2 ** 20)), /fingerprint is not the one/);
    assert.match(edit((r) => (r.fingerprint = 2 ** 20)), /whole number of 20 bits/);
    assert.match(edit((r) => (r.seed = "changed")), /fingerprint is not the one/);
    assert.match(edit((r) => ((r as { recordVersion: number }).recordVersion = 2)), /recordVersion/);
    assert.match(edit((r) => (r.name = " ")), /needs a name/);
    assert.match(edit((r) => (r.id = "t_nope")), /not a test id/);
    assert.match(edit((r) => r.versions.pop()), /fingerprint is not the one/, "a version taken away changes what the record is");
    assert.match(edit((r) => (r.versions[1]!.label = "C")), /Version 2 is B/);
    assert.match(edit((r) => r.versions[1]!.order.pop()), /prints every question once/);
    assert.match(edit((r) => (r.versions[2]!.order[0] = r.versions[2]!.order[1] as string)), /prints every question once/);
    const firstChoice = (r: TestRecord): string => r.questions.find((q) => q.type === "multipleChoice")!.id;
    assert.match(edit((r) => ((r.versions[1]!.options[firstChoice(r)] as string[])[0] = "o99")), /prints each answer of a question once/);
    assert.match(edit((r) => delete r.versions[1]!.options[firstChoice(r)]), /prints each answer of a question once/);
    assert.match(edit((r) => r.questions.reverse()), /not in the order of the sections|do not hold/);
    assert.match(edit((r) => r.sections[0]!.questionIds.pop()), /do not hold each question once/);
    assert.match(edit((r) => ((r.questions[0] as { body: unknown }).body = { nonsense: true })), /questions\.0/);
    assert.match(edit((r) => (r.questions[1] = r.questions[0] as Question)), /twice/);
    assert.match(edit((r) => (r.questions = [])), /at least one question/);
  });

  test("refuses five versions, and anything that is not a record, without throwing", () => {
    const five = good();
    five.versions.push({ ...five.versions[0]!, label: "D" });
    five.versions.push({ ...five.versions[0]!, label: "D" });
    assert.equal(validateTest(five).ok, false);
    for (const junk of [null, undefined, 5, "text", [], [1, 2], {}, { recordVersion: 1 }, { ...good(), versions: "none" }, { ...good(), sections: [null] }, { ...good(), questions: [null] }]) {
      assert.equal(validateTest(junk).ok, false, JSON.stringify(junk)?.slice(0, 40));
    }
  });
});

describe("a bank holds tests", () => {
  const withBank = (): { bank: Bank; record: TestRecord } => {
    const b = Bank.createEmpty("Planets", { at: AT });
    const questions = bank();
    for (const q of questions) b.add(q);
    const record = createTest({ name: "Quiz 1", questions, versions: 3, seed: "bank", at: AT });
    b.addTest(record);
    return { bank: b, record };
  };
  const entries = (bytes: Uint8Array): string[] => [...unzipSync(bytes).keys()];

  test("saves a test under tests/ and opens it again the same", () => {
    const { bank: b, record } = withBank();
    const bytes = b.toBytes({ at: AT });
    assert.ok(entries(bytes).includes(`tests/${record.id}.json`));
    const reopened = Bank.fromBytes(bytes);
    assert.deepEqual(reopened.report.invalid, []);
    assert.deepEqual(reopened.report.unknownFiles, []);
    assert.deepEqual(reopened.bank.getTest(record.id), record);
    assert.equal(reopened.bank.listTests().length, 1);
    assert.deepEqual(Buffer.from(reopened.bank.toBytes({ at: AT })), Buffer.from(bytes), "saving it again changes nothing");
  });

  test("a bank with no tests has no tests folder, and opens as it did", () => {
    const b = Bank.createEmpty("Plain", { at: AT });
    for (const q of bank().slice(0, 3)) b.add(q);
    assert.ok(!entries(b.toBytes({ at: AT })).some((n) => n.startsWith("tests/")));
    const reopened = Bank.fromBytes(b.toBytes({ at: AT }));
    assert.equal(reopened.bank.tests.size, 0);
    assert.deepEqual(reopened.report.invalid, []);
  });

  test("keeps a record whose questions are not touched when the bank's questions change", () => {
    const { bank: b, record } = withBank();
    const first = [...b.questions.values()][0] as Question;
    b.questions.set(first.id, { ...first, stem: plainToRich("Edited in the bank") });
    assert.equal(richTextToPlain(b.getTest(record.id)!.questions.find((q) => q.id === first.id)!.stem), richTextToPlain(first.stem));
  });

  test("refuses a test that does not hold together, and one with an id the bank has", () => {
    const { bank: b, record } = withBank();
    assert.throws(() => b.addTest(record), /already holds a test/);
    assert.throws(() => b.addTest({ ...createTest({ name: "x", questions: bank() }), fingerprint: 1 }), /does not hold together/);
    assert.equal(b.tests.size, 1);
  });

  test("lists tests oldest first, and removes one", () => {
    const { bank: b } = withBank();
    const later = createTest({ name: "Later", questions: bank(), at: "2026-02-01T00:00:00.000Z" });
    const earlier = createTest({ name: "Earlier", questions: bank(), at: "2025-12-01T00:00:00.000Z" });
    b.addTest(later);
    b.addTest(earlier);
    assert.deepEqual(b.listTests().map((t) => t.name), ["Earlier", "Quiz 1", "Later"]);
    assert.equal(b.removeTest(later.id), true);
    assert.equal(b.removeTest(later.id), false);
    assert.equal(b.tests.size, 2);
  });

  test("a damaged test is reported and kept exactly as it was, and is written back the same", () => {
    const { bank: b, record } = withBank();
    const files = unzipSync(b.toBytes({ at: AT }));
    const notJson = new Uint8Array(Buffer.from("{ this is not json", "utf8"));
    const wrongRecord = new Uint8Array(Buffer.from(JSON.stringify({ ...record, id: "t_00000000000000000000000001", fingerprint: 7 }), "utf8"));
    const damaged = zipSync([
      ...[...files].map(([name, data]) => ({ name, data })),
      { name: "tests/t_00000000000000000000000002.json", data: notJson },
      { name: "tests/t_00000000000000000000000001.json", data: wrongRecord },
    ]);
    const opened = Bank.fromBytes(damaged);
    assert.equal(opened.bank.tests.size, 1, "the good test is still there");
    assert.equal(opened.report.invalid.length, 2);
    assert.ok(opened.report.invalid.some((i) => /not valid JSON/.test(i.issues[0]?.message ?? "")));
    assert.ok(opened.report.invalid.some((i) => i.issues.some((x) => /fingerprint/.test(x.message))));
    const again = unzipSync(opened.bank.toBytes({ at: AT }));
    assert.deepEqual(Buffer.from(again.get("tests/t_00000000000000000000000002.json") as Uint8Array), Buffer.from(notJson));
    assert.deepEqual(Buffer.from(again.get("tests/t_00000000000000000000000001.json") as Uint8Array), Buffer.from(wrongRecord));
  });

  test("two files with one test id are reported, and neither is lost", () => {
    const { bank: b, record } = withBank();
    const files = unzipSync(b.toBytes({ at: AT }));
    const copy = Buffer.from(JSON.stringify(record), "utf8");
    const doubled = zipSync([...[...files].map(([name, data]) => ({ name, data })), { name: "tests/copy-of-it.json", data: new Uint8Array(copy) }]);
    const opened = Bank.fromBytes(doubled);
    assert.equal(opened.bank.tests.size, 1);
    assert.ok(opened.report.invalid.some((i) => /already holds the test/.test(i.issues[0]?.message ?? "")));
    assert.ok(unzipSync(opened.bank.toBytes({ at: AT })).has("tests/copy-of-it.json"));
  });

  test("software that does not know tests would carry the folder through untouched: its files are ordinary unknown files", () => {
    // The container reports a file it does not recognise and writes it back. A tests/ file that this version cannot read is
    // handled the same way, which is what an older version does with a newer one's tests.
    const { bank: b } = withBank();
    const files = unzipSync(b.toBytes({ at: AT }));
    const extra = zipSync([...[...files].map(([name, data]) => ({ name, data })), textEntry("tests/readme.txt", "kept"), jsonEntry("something-else.json", { a: 1 })]);
    const opened = Bank.fromBytes(extra);
    assert.ok(opened.report.unknownFiles.includes("something-else.json"));
    assert.ok(unzipSync(opened.bank.toBytes({ at: AT })).has("something-else.json"));
  });
});

describe("printing every version", () => {
  const textOf = (blocks: Block[]): string[] => blocks.map((b) => (b.kind === "para" ? `${b.marker ?? ""} ${b.runs.map((r) => r.text).join("")}`.trim() : ""));
  const streams = (bytes: Uint8Array): string => {
    const text = Buffer.from(bytes).toString("latin1");
    const out: string[] = [];
    for (const m of text.matchAll(/stream\r?\n/g)) {
      const start = (m.index as number) + m[0].length;
      const raw = Buffer.from(text.slice(start, text.indexOf("endstream", start)), "latin1");
      try {
        out.push(inflateSync(raw).toString("latin1"));
      } catch {
        out.push(raw.toString("latin1"));
      }
    }
    return out.join("\n");
  };

  test("gives a student booklet and a key for each version, named for it", () => {
    const record = testOf({ versions: 3 });
    const files = printVersions(record, "pdf", {}, ["student", "key"], new Date(AT));
    assert.deepEqual(files.map((f) => f.result.file.name), [
      "Quiz 1 - Version A - Student copy.pdf",
      "Quiz 1 - Version A - Answer key.pdf",
      "Quiz 1 - Version B - Student copy.pdf",
      "Quiz 1 - Version B - Answer key.pdf",
      "Quiz 1 - Version C - Student copy.pdf",
      "Quiz 1 - Version C - Answer key.pdf",
    ]);
    for (const f of files) assert.ok(f.result.file.bytes.length > 500, f.result.file.name);
    assert.deepEqual(printVersions(record, "docx", {}, ["key"], new Date(AT)).map((f) => f.result.file.name), ["Quiz 1 - Version A - Answer key.docx", "Quiz 1 - Version B - Answer key.docx", "Quiz 1 - Version C - Answer key.docx"]);
  });

  test("says the version in the title, in the header of every page of a PDF, and in a Word header", () => {
    const record = testOf({ versions: 2 });
    const b = printVersions(record, "pdf", {}, ["student"], new Date(AT)).find((f) => f.label === "B")!;
    const pages = b.result.file.pages as number;
    const content = streams(b.result.file.bytes);
    assert.equal(content.split("(Version B) Tj").length - 1, pages, "one header for every page");
    assert.ok(!content.includes("(Version A) Tj"));
    const docx = printVersions(record, "docx", {}, ["student"], new Date(AT)).find((f) => f.label === "B")!;
    const parts = unzipSync(docx.result.file.bytes);
    assert.match(Buffer.from(parts.get("word/header1.xml") as Uint8Array).toString("utf8"), />Version B</);
    assert.match(Buffer.from(parts.get("word/document.xml") as Uint8Array).toString("utf8"), /headerReference/);
    assert.match(Buffer.from(parts.get("[Content_Types].xml") as Uint8Array).toString("utf8"), /header1\.xml/);
    const heading = layoutTest(versionQuestions(record, "B"), printOptions({ title: "Quiz 1", versionLabel: "B" })).document;
    assert.equal(heading.header, "Version B");
    assert.match(textOf(heading.blocks)[0] as string, /^Quiz 1 {2}·  Version B$/);
  });

  test("a test of one version is printed without a version, since there is nothing to tell apart", () => {
    const record = testOf({ versions: 1 });
    const [student, key] = printVersions(record, "pdf", {}, ["student", "key"], new Date(AT));
    assert.equal(student!.result.file.name, "Quiz 1 - Student copy.pdf");
    assert.equal(key!.result.file.name, "Quiz 1 - Answer key.pdf");
    assert.ok(!streams(student!.result.file.bytes).includes("Version"));
    const doc = layoutTest(versionQuestions(record, "A"), printOptions({ title: "Quiz 1", answerOnSheet: true })).document;
    assert.equal(doc.header, undefined);
    assert.ok(textOf(doc.blocks).some((l) => /Mark your answers on your answer sheet/.test(l)));
    assert.ok(!textOf(doc.blocks).some((l) => /Fill in bubble/.test(l)));
    const docx = printVersions(record, "docx", {}, ["student"], new Date(AT))[0]!;
    assert.ok(!unzipSync(docx.result.file.bytes).has("word/header1.xml"), "no header part when there is no version");
  });

  test("the booklet tells the student which bubble to fill, and the key does not", () => {
    const record = testOf({ versions: 4 });
    for (const v of record.versions) {
      const student = layoutTest(versionQuestions(record, v.label), printOptions({ title: "Quiz 1", versionLabel: v.label, answerOnSheet: true }));
      assert.ok(textOf(student.document.blocks).some((l) => l.includes(`Fill in bubble ${v.label} for your version`)), v.label);
      const key = layoutTest(versionQuestions(record, v.label), printOptions({ title: "Quiz 1", kind: "key", versionLabel: v.label, answerOnSheet: true }));
      assert.ok(!textOf(key.document.blocks).some((l) => l.includes("Fill in bubble")));
      assert.match(student.report.general[0] as string, new RegExp(`This is Version ${v.label}`));
    }
  });

  test("numbers each booklet from 1 in the version's own order, and prints that version's answers in its order", () => {
    const record = testOf({ versions: 3, questionOrder: "shuffled" });
    for (const v of record.versions) {
      const printed = versionQuestions(record, v.label);
      const lines = textOf(layoutTest(printed, printOptions({ title: "Quiz 1", versionLabel: v.label })).document.blocks);
      const numbered = lines.filter((l) => /^\d+\. /.test(l));
      assert.equal(numbered.length, printed.length - 0 - (printed.filter((q) => q.type === "hotspot" || q.type === "calculated").length));
      numbered.forEach((l, i) => assert.ok(l.startsWith(`${i + 1}. `), `${v.label}: ${l.slice(0, 30)}`));
      printed.forEach((q, i) => assert.ok(numbered[i]!.includes(richTextToPlain(q.stem)), `${v.label} question ${i + 1}`));
    }
  });

  test("the key's strip agrees with the key's own letters in every version, and the booklet shows no answer", () => {
    const record = testOf({ versions: 4, questionOrder: "shuffled" });
    for (const v of record.versions) {
      const printed = versionQuestions(record, v.label);
      const key = layoutTest(printed, printOptions({ title: "Quiz 1", kind: "key", versionLabel: v.label, keyStrip: true })).document;
      const stripLines = key.blocks.filter((b) => b.kind === "para" && b.runs[0]?.mono === true).map((b) => (b as { runs: Array<{ text: string }> }).runs[0]!.text);
      const entries = stripLines.join("   ").split(/\s{3}/).filter((e) => e !== "");
      const expected = versionKey(record, v.label).map((e) => `${e.number}-${e.letters ? e.letters.join("") : e.reason?.startsWith("it has no usable") ? "?" : "-"}`);
      assert.deepEqual(entries, expected, v.label);
      assert.ok(stripLines.every((l) => l.split(/\s{3}/).length <= 10), "ten to a line");
      const booklet = layoutTest(printed, printOptions({ title: "Quiz 1", versionLabel: v.label, keyStrip: true })).document;
      assert.ok(!textOf(booklet.blocks).some((l) => l.includes("(correct)")), "no answer in the student copy");
      assert.ok(!booklet.blocks.some((b) => b.kind === "para" && b.runs[0]?.mono), "no strip in the student copy");
    }
  });

  test("the question marked correct on each version's key is the one at the letter the strip gives", () => {
    const record = testOf({ versions: 4 });
    for (const v of record.versions) {
      const key = layoutTest(versionQuestions(record, v.label), printOptions({ title: "Quiz 1", kind: "key", versionLabel: v.label })).document;
      const lines = textOf(key.blocks);
      const right = lines.filter((l) => l.endsWith("(correct)")).map((l) => l.split(" ")[0]);
      const fromKey = versionKey(record, v.label).flatMap((e) => (e.letters && e.type !== "trueFalse" ? e.letters.map((x) => `${x}.`) : []));
      assert.deepEqual(right, fromKey, v.label);
    }
  });

  test("a question with no usable key is printed in each booklet, and the key says no answer is recorded and puts a question mark in the strip", () => {
    const record = testOf({ versions: 2 });
    const keyDoc = layoutTest(versionQuestions(record, "B"), printOptions({ title: "Quiz 1", kind: "key", versionLabel: "B", keyStrip: true })).document;
    assert.ok(textOf(keyDoc.blocks).some((l) => /No answer is recorded for this question/.test(l)));
    assert.ok(textOf(keyDoc.blocks).some((l) => /-\?(\s|$)/.test(l)), "a question mark for the question with no key");
  });

  test("printing from the record twice gives the same files", () => {
    const record = testOf({ versions: 3 });
    const one = printVersions(record, "pdf", {}, ["student", "key"], new Date(AT));
    const two = printVersions(record, "pdf", {}, ["student", "key"], new Date(AT));
    one.forEach((f, i) => assert.deepEqual(Buffer.from(f.result.file.bytes), Buffer.from(two[i]!.result.file.bytes), f.result.file.name));
  });

  test("the Word file relates its header part, so Word can find it", () => {
    const record = testOf({ versions: 2 });
    const parts = unzipSync(printVersions(record, "docx", {}, ["student"], new Date(AT))[0]!.result.file.bytes);
    const rels = Buffer.from(parts.get("word/_rels/document.xml.rels") as Uint8Array).toString("utf8");
    assert.match(rels, /Id="rId3"[^>]*relationships\/header"[^>]*Target="header1\.xml"/);
    assert.match(Buffer.from(parts.get("word/document.xml") as Uint8Array).toString("utf8"), /<w:headerReference w:type="default" r:id="rId3"\/>/);
  });

  test("the booklet has the line about the answer sheet unless it is asked not to", () => {
    const record = testOf({ versions: 2 });
    const body = (more: Parameters<typeof printVersions>[2]): string =>
      Buffer.from(unzipSync(printVersions(record, "docx", more, ["student"], new Date(AT))[1]!.result.file.bytes).get("word/document.xml") as Uint8Array).toString("utf8");
    assert.match(body({}), /Fill in bubble B for your version/);
    assert.doesNotMatch(body({ answerOnSheet: false }), /Fill in bubble/);
  });

  test("a test of one question per version still prints", () => {
    const record = createTest({ name: "Tiny", questions: [make("trueFalse", { correct: true }, "A statement.")], versions: 4, seed: "s" });
    assert.equal(printVersions(record, "pdf", {}, ["student", "key"]).length, 8);
  });
});

describe("the shuffle printing and versions share", () => {
  test("gives the same order for the same id as it always has, so a printed test does not change when the software does", () => {
    // Pinned from the implementation that printing used before the shuffle moved into the model.
    assert.deepEqual(shuffledFor([1, 2, 3, 4, 5, 6], "q_0001:matching"), [4, 1, 6, 3, 5, 2]);
    assert.deepEqual(shuffledFor(["a", "b", "c"], "x"), ["b", "c", "a"]);
    assert.deepEqual(shuffledFor([1, 2], "anything"), [2, 1], "never the order they came in");
    assert.deepEqual(shuffledFor([1], "anything"), [1]);
    assert.deepEqual(shuffledFor([], "anything"), []);
    assert.equal(VERSION_LABELS.join(""), "ABCD");
  });
});
