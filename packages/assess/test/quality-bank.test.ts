/**
 * The checks that look across questions (`quality/bank.ts`): the same question written twice, and right answers that sit in one
 * place too often.
 *
 * These are worked out each time and not stored, so what is held here is what they say, and that they say nothing when unsure: a
 * numeric difference makes two questions different, a short question is only the same as another when it is the same, a question
 * with a picture is not compared, and a spread of letters is judged only when there are enough of them and only when chance would
 * be a surprising explanation. The lines are tested on both sides.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { Bank } from "../src/bank/store.ts";
import { createQuestion } from "../src/model/create.ts";
import { FindingCode, finding } from "../src/model/findings.ts";
import type { MediaRef, Question } from "../src/model/question.ts";
import { plainToRich, rich } from "../src/model/richtext.ts";
import { createTest } from "../src/model/test.ts";
import { ALIKE_MIN_WORDS, BALANCE_MIN_ANSWERS, binomialTail, checkBankQuality, findDuplicates, keyBalance, overusedLetter } from "../src/quality/bank.ts";

function mc(stem: string, options: string[], extra: { shuffle?: boolean; status?: "retired"; media?: MediaRef[]; title?: string } = {}): Question {
  return createQuestion({
    type: "multipleChoice",
    stem: plainToRich(stem),
    body: { shuffle: extra.shuffle ?? true, options: options.map((text, i) => ({ id: `o${i}`, content: plainToRich(text.replace(/\*$/, "")), correct: text.endsWith("*") })) } as never,
    ...(extra.status ? { metadata: { tags: [], status: extra.status } } : {}),
    ...(extra.media ? { media: extra.media } : {}),
    ...(extra.title ? { title: extra.title } : {}),
  });
}

/** An essay: only its wording is compared, so the words of a test can be chosen exactly. */
const essay = (stem: string, title?: string): Question => createQuestion({ type: "essay", stem: plainToRich(stem), body: {}, ...(title ? { title } : {}) });

/** n different words with no digit in them: a token with a digit counts as a number, and two questions with different numbers are different. */
const words = (n: number, prefix = "w"): string[] => Array.from({ length: n }, (_, i) => `${prefix}${String.fromCharCode(97 + i)}`);

describe("the same question written twice", () => {
  test("is found whatever the case, punctuation or order of the options", () => {
    const a = mc("What is the capital of France?", ["Paris*", "Rome", "Madrid"], { title: "France" });
    const b = mc("what is the CAPITAL of France", ["Madrid", "Rome.", "paris*"], { title: "France again" });
    const groups = findDuplicates([a, b]);
    assert.equal(groups.length, 1);
    const [group] = groups;
    assert.equal(group?.kind, "same");
    assert.equal(group?.code, "quality.duplicate-question");
    assert.deepEqual([...(group?.questionIds ?? [])].sort(), [a.id, b.id].sort());
    assert.match(group?.message ?? "", /^Two questions are the same, with the same wording and the same answers: /);
    assert.match(group?.message ?? "", /"France"/);
  });

  test("three copies are one group, and the message says how many", () => {
    const copies = [1, 2, 3].map(() => mc("What is the capital of France?", ["Paris*", "Rome", "Madrid"]));
    const [group, ...rest] = findDuplicates(copies);
    assert.equal(rest.length, 0);
    assert.equal(group?.questionIds.length, 3);
    assert.match(group?.message ?? "", /^3 questions are the same/);
  });

  test("a different set of wrong options is a different question", () => {
    const a = mc("What is the capital of France today?", ["Paris*", "Rome", "Madrid"]);
    const b = mc("What is the capital of France today?", ["Paris*", "Lyon", "Nice"]);
    assert.deepEqual(findDuplicates([a, b]), []);
  });

  test("the same options with a different one marked right are not the same, but are alike", () => {
    const a = mc("What is the capital of France today?", ["Paris*", "Rome", "Madrid"]);
    const b = mc("What is the capital of France today?", ["Paris", "Rome*", "Madrid"]);
    const [group, ...rest] = findDuplicates([a, b]);
    assert.equal(rest.length, 0);
    assert.equal(group?.kind, "alike", "a conflict between two copies is worth saying");
  });

  test("a retired question and a question with a picture are left out", () => {
    const live = mc("What is the capital of France?", ["Paris*", "Rome"]);
    const retired = mc("What is the capital of France?", ["Paris*", "Rome"], { status: "retired" });
    assert.deepEqual(findDuplicates([live, retired]), []);
    const media = [{ id: "m1", file: "media/m1.png", mime: "image/png", alt: "map" }];
    const withPicture = mc("What is the capital of France?", ["Paris*", "Rome"], { media });
    assert.deepEqual(findDuplicates([live, withPicture]), [], "the pictures are not read, so the questions are not known to be the same");
  });

  test("true or false questions with the same words and opposite answers are alike, with the same words and answers are the same", () => {
    const tf = (correct: boolean) => createQuestion({ type: "trueFalse", stem: plainToRich("The mitochondria is the powerhouse of the cell."), body: { correct } });
    assert.equal(findDuplicates([tf(true), tf(true)])[0]?.kind, "same");
    assert.equal(findDuplicates([tf(true), tf(false)])[0]?.kind, "alike");
  });

  test("equations are compared by what they say, not by their ids", () => {
    const withEquation = (latex: string) =>
      createQuestion({ type: "essay", stem: rich('<p>Solve <oa-math ref="e1"></oa-math> for the unknown value please.</p>'), body: {}, math: [{ id: "e1", latex, mathml: "<math/>" }] });
    assert.equal(findDuplicates([withEquation("x^2 + 1 = 5"), withEquation("x^2 + 1 = 5")])[0]?.kind, "same");
    assert.deepEqual(findDuplicates([withEquation("x^2 + 1 = 5"), withEquation("x^3 + 1 = 9")]), []);
  });

  test("other types are compared by their own answers", () => {
    const blank = (accepted: string[]) => createQuestion({ type: "fillInBlank", stem: plainToRich("The capital of France is ____."), body: { caseSensitive: false, blanks: [{ id: "b1", accepted }] } as never });
    assert.equal(findDuplicates([blank(["Paris", "paris"]), blank(["PARIS", "Paris"])])[0]?.kind, "same");
    assert.deepEqual(findDuplicates([blank(["Paris"]), blank(["Lyon"])]), []);
    const short = (accepted: string[]) => createQuestion({ type: "shortAnswer", stem: plainToRich("Name the capital of France."), body: { caseSensitive: false, accepted } });
    assert.equal(findDuplicates([short(["Paris"]), short(["Paris"])])[0]?.kind, "same");
    const match = (right: string) => createQuestion({ type: "matching", stem: plainToRich("Match."), body: { shuffle: true, distractors: [], pairs: [{ id: "p1", left: plainToRich("France"), right }, { id: "p2", left: plainToRich("Italy"), right: "Rome" }] } as never });
    assert.equal(findDuplicates([match("Paris"), match("paris")])[0]?.kind, "same");
    assert.deepEqual(findDuplicates([match("Paris"), match("Lyon")]), []);
    const order = (positions: number[]) => createQuestion({ type: "ordering", stem: plainToRich("Order these steps."), body: { items: ["First", "Second", "Third"].map((w, i) => ({ id: `i${i}`, content: plainToRich(w), position: positions[i] })) } as never });
    assert.equal(findDuplicates([order([1, 2, 3]), order([1, 2, 3])])[0]?.kind, "same");
    assert.equal(findDuplicates([order([1, 2, 3]), order([3, 2, 1])])[0]?.kind, "alike", "the same items to put in the other order");
    const numeric = (value: number) => createQuestion({ type: "numeric", stem: plainToRich("What is six times seven?"), body: { mode: "exact", value } });
    assert.equal(findDuplicates([numeric(42), numeric(42)])[0]?.kind, "same");
    assert.deepEqual(findDuplicates([numeric(42), numeric(43)]), []);
  });

  test("an ordering question's own order is not changed by looking at it", () => {
    const q = createQuestion({ type: "ordering", stem: plainToRich("Order these steps."), body: { items: [{ id: "a", content: plainToRich("Third"), position: 3 }, { id: "b", content: plainToRich("First"), position: 1 }] } as never });
    const before = JSON.stringify(q);
    findDuplicates([q, q]);
    assert.equal(JSON.stringify(q), before);
  });
});

describe("questions that are alike", () => {
  test("a stem with one word changed is alike at 0.85 and not below it", () => {
    // 13 words with one changed: 12 shared of 14, which is 0.857.
    const base = words(13);
    const change = [...base.slice(0, 12), "different"];
    const near = findDuplicates([essay(base.join(" ")), essay(change.join(" "))]);
    assert.equal(near.length, 1);
    assert.equal(near[0]?.kind, "alike");
    assert.equal(near[0]?.code, "quality.near-duplicate-question");
    assert.match(near[0]?.message ?? "", /^2 questions are very much alike/);
    // 11 words with one changed: 10 shared of 12, which is 0.833.
    const short = words(11);
    assert.deepEqual(findDuplicates([essay(short.join(" ")), essay([...short.slice(0, 10), "different"].join(" "))]), []);
  });

  test("two questions that share their options and nearly all their stem, and have a different right answer, are parallel questions and not copies", () => {
    // A real bank (an exam's 549 multiple choice questions) had 22 groups of this kind and no copy among them: the same four options, one
    // word of the stem changed, and a different one of the options right.
    const ripple = (kind: string, right: string) => mc(`The ripple frequency produced by a ${kind} power supply connected to a normal household circuit is:`, ["120 Hz", "60 Hz", "90 Hz", "30 Hz"].map((o) => (o === right ? `${o}*` : o)));
    const full = ripple("full-wave", "120 Hz");
    const half = ripple("half-wave", "60 Hz");
    assert.deepEqual(findDuplicates([full, half]), [], "different stems, different right answers");
    // The same two with the same right answer are alike: the words say they are one question, and the key does not say otherwise.
    assert.equal(findDuplicates([full, ripple("half-wave", "120 Hz")])[0]?.kind, "alike");
    // And a stem that reads the same with another answer marked is still a conflict worth saying (the test above this group holds that).
    assert.equal(findDuplicates([full, ripple("full-wave", "60 Hz")])[0]?.kind, "alike");
    // What is compared is the right answer, not the whole set of options: the same right answer with one wrong option reworded is still
    // an agreement.
    const reworded = mc("The ripple frequency produced by a half-wave power supply connected to a normal household circuit is:", ["120 Hz*", "60 Hz", "90 Hz", "30 Hz approximately"]);
    assert.equal(findDuplicates([full, reworded])[0]?.kind, "alike");
  });

  test("the right answers of a multiple response question are compared as a set, and of the other types by their whole key", () => {
    const pick = (right: string[]) => mc("Which of these are the factors of twelve that are smaller than the number itself here:", ["1", "2", "3", "5"].map((o) => (right.includes(o) ? `${o}*` : o)));
    // Same stem, a different set right: a conflict, still said.
    assert.equal(findDuplicates([pick(["1", "2"]), pick(["1", "3"])])[0]?.kind, "alike");
    const blank = (stem: string, accepted: string[]) => createQuestion({ type: "fillInBlank", stem: plainToRich(stem), body: { caseSensitive: false, blanks: [{ id: "b1", accepted }] } as never });
    const long = "The capital of the country that lies directly to the south of Canada and is a federation of states is ____ at present";
    // Different stems and different accepted answers: parallel. The same accepted answer under another stem: alike.
    assert.deepEqual(findDuplicates([blank(long, ["Washington"]), blank(long.replace("south", "north"), ["Ottawa"])]), []);
    assert.equal(findDuplicates([blank(long, ["Washington"]), blank(long.replace("south", "north"), ["Washington"])])[0]?.kind, "alike");
  });

  test("a different sign makes two questions different, as a different number does", () => {
    const question = (sign: string, right: string, wrong: string) => mc(`Which value of x satisfies the inequality 2x + 1 ${sign} 7 for every real number in the set?`, [`${right}*`, wrong, "x = 3"], {});
    const greater = question(">", "x > 3", "x < 3");
    const less = question("<", "x < 3", "x > 3");
    assert.deepEqual(findDuplicates([greater, less]), [], "not the same question, and not alike either");
    // And the same two with the same sign are a copy.
    assert.equal(findDuplicates([question(">", "x > 3", "x < 3"), question(">", "x > 3", "x < 3")])[0]?.kind, "same");
  });

  test("punctuation between the words does not make questions different, and the vowel marks of a word do", () => {
    const stem = "Which of the following describes the role of the nucleus in a eukaryotic cell";
    assert.equal(findDuplicates([essay(`${stem}?`), essay(stem)])[0]?.kind, "same", "a question mark");
    assert.equal(findDuplicates([essay(stem), essay(stem.replace("of the following", "of, the following"))])[0]?.kind, "alike", "a comma, the same words");
    const hindi = (word: string) => mc(`इस शब्द का अर्थ क्या है कृपया तीन बार पढ़ें`, [`${word}*`, "काला", "लाल"]);
    assert.deepEqual(findDuplicates([hindi("किताब"), hindi("कुताब")]).filter((g) => g.kind === "same"), [], "two different words are not the same word");
  });

  test("a different number makes two questions different however alike the words are", () => {
    const stem = (n: number) => `What is the product of 12 and ${n} when they are multiplied together in the usual way`;
    assert.deepEqual(findDuplicates([essay(stem(7)), essay(stem(8))]), []);
    assert.equal(findDuplicates([essay(stem(7)), essay(stem(7) + " now")])[0]?.kind, "alike", "the same numbers and one more word");
  });

  test("a short question is alike only when it is the same", () => {
    assert.equal(ALIKE_MIN_WORDS, 6);
    // The same words in another order: every word is shared, so nothing but the length keeps these apart.
    assert.deepEqual(findDuplicates([essay("water cycle the describe now"), essay("describe the water cycle now")]), []);
    assert.equal(findDuplicates([essay("water cycle the describe now please"), essay("describe the water cycle now please")])[0]?.kind, "alike");
    assert.equal(findDuplicates([essay("describe the water cycle now"), essay("describe the water cycle now")])[0]?.kind, "same", "the same is still the same");
  });

  test("a chain of alike questions is one group", () => {
    const a = words(14);
    const b = [...a.slice(0, 13), "b"];
    const c = [...b.slice(0, 12), "c", "b"];
    const [group, ...rest] = findDuplicates([essay(a.join(" ")), essay(b.join(" ")), essay(c.join(" "))]);
    assert.equal(rest.length, 0);
    assert.equal(group?.questionIds.length, 3);
    assert.match(group?.message ?? "", /^3 questions are very much alike/);
  });

  test("exact copies that are also alike to another question are named once, with it", () => {
    const base = words(13);
    const copy = () => essay(base.join(" "));
    const other = essay([...base.slice(0, 12), "different"].join(" "));
    const [group, ...rest] = findDuplicates([copy(), copy(), other]);
    assert.equal(rest.length, 0, "no second group for the two copies");
    assert.equal(group?.kind, "alike");
    assert.equal(group?.questionIds.length, 3);
  });

  test("the message names three titles and counts the rest", () => {
    const base = words(13);
    const five = [0, 1, 2, 3, 4].map((i) => essay([...base.slice(0, 12), `x${String.fromCharCode(97 + i)}`].join(" "), `Title ${i}`));
    const [group] = findDuplicates(five);
    assert.equal(group?.questionIds.length, 5);
    // Three are named, whichever three, and the other two are counted.
    assert.match(group?.message ?? "", /^5 questions are very much alike, with only a few words changed: "Title \d", "Title \d", "Title \d" and 2 more\./);
  });

  test("a bank of 1,000 different questions is searched in well under a second, and one planted pair is found", () => {
    // Words are drawn from a small fixed set with a simple generator, so that the stems overlap a lot and none repeats.
    const vocabulary = Array.from({ length: 60 }, (_, i) => `word${String.fromCharCode(97 + (i % 26))}${String.fromCharCode(97 + Math.floor(i / 26))}`);
    let state = 12345;
    const next = () => (state = (state * 1103515245 + 12345) % 2147483648);
    const questions = Array.from({ length: 1000 }, (_, i) => essay(`${Array.from({ length: 12 }, () => vocabulary[next() % vocabulary.length]).join(" ")} ${i}`, `Q${i}`));
    const planted = [...questions, essay(`${(questions[10]?.stem.content ?? "").replace(/<[^>]*>/g, "")} extra`, "planted")];
    const start = performance.now();
    const groups = findDuplicates(planted);
    const took = performance.now() - start;
    assert.ok(took < 1500, `took ${took.toFixed(0)} ms`);
    assert.ok(groups.some((g) => g.titles.includes("planted") && g.titles.includes("Q10")), "the planted pair is found");
  });
});

describe("how likely a spread is by chance", () => {
  test("binomialTail agrees with working it out by hand", () => {
    assert.ok(Math.abs(binomialTail(10, 10, 0.5) - 1 / 1024) < 1e-12);
    assert.ok(Math.abs(binomialTail(10, 0, 0.5) - 1) < 1e-12);
    assert.ok(Math.abs(binomialTail(8, 6, 0.5) - 37 / 256) < 1e-12);
    assert.ok(Math.abs(binomialTail(4, 2, 0.25) - (6 * 0.25 ** 2 * 0.75 ** 2 + 4 * 0.25 ** 3 * 0.75 + 0.25 ** 4)) < 1e-12);
  });

  test("a very long test does not underflow", () => {
    const tail = binomialTail(5000, 2000, 0.25);
    assert.ok(tail >= 0 && tail < 1e-100, `tail ${tail}`);
    assert.ok(Number.isFinite(tail));
  });

  /** The same, worked out another way, by adding up whole terms. Small numbers only. */
  const exact = (n: number, c: number, p: number): number => {
    let total = 0;
    for (let i = c; i <= n; i++) {
      let ways = 1;
      for (let j = 0; j < i; j++) ways = (ways * (n - j)) / (j + 1);
      total += ways * p ** i * (1 - p) ** (n - i);
    }
    return total;
  };

  test("a letter is said when its chance is under 0.01 divided by the number of letters, and not at the next one down", () => {
    const lowest = Array.from({ length: 21 }, (_, c) => c).find((c) => exact(20, c, 0.25) < 0.01 / 4) as number;
    assert.ok(lowest > 5 && lowest < 20);
    const spread = (c: number) => [...Array(c).fill("C"), ...Array.from({ length: 20 - c }, (_, i) => "ABD"[i % 3] as string)];
    assert.deepEqual(overusedLetter(spread(lowest), 4), { letter: "C", count: lowest });
    assert.equal(overusedLetter(spread(lowest - 1), 4), undefined, "one fewer is within what chance does");
    // Without dividing by the four letters tried, the one below would have been enough.
    assert.ok(exact(20, lowest - 1, 0.25) < 0.01, "so the division is what holds it back");
  });

  test("fewer answers than the minimum are never judged", () => {
    assert.equal(BALANCE_MIN_ANSWERS, 20);
    assert.equal(overusedLetter(Array(19).fill("C"), 4), undefined);
    assert.deepEqual(overusedLetter(Array(20).fill("C"), 4), { letter: "C", count: 20 });
    assert.equal(overusedLetter(Array(30).fill("C"), 1), undefined, "one option is not a choice");
  });

  test("a spread that is even says nothing", () => {
    const even = Array.from({ length: 40 }, (_, i) => "ABCD"[i % 4] as string);
    assert.equal(overusedLetter(even, 4), undefined);
  });

  test("with five options a letter is expected a fifth of the time, not a quarter", () => {
    // The first count of 40 that is surprising among five options (a fifth expected), and is not among four (a quarter expected).
    const five = Array.from({ length: 41 }, (_, c) => c).find((c) => exact(40, c, 0.2) < 0.01 / 5) as number;
    assert.ok(exact(40, five, 0.25) >= 0.01 / 4, "so four options would not have said it");
    const spread = [...Array(five).fill("C"), ...Array.from({ length: 40 - five }, (_, i) => "ABDE"[i % 4] as string)];
    assert.deepEqual(overusedLetter(spread, 5), { letter: "C", count: five });
    assert.equal(overusedLetter(spread, 4), undefined);
  });
});

describe("where the right answers sit in a bank", () => {
  const keyed = (at: number, extra: Parameters<typeof mc>[2] = { shuffle: false }) => mc(`Question about ${Math.random()}`, ["a", "b", "c", "d"].map((t, i) => (i === at ? `${t}*` : t)), extra);

  test("the questions that keep their order are counted, and a letter that fills most of them is said", () => {
    const questions = [...Array.from({ length: 20 }, () => keyed(2)), ...Array.from({ length: 4 }, (_, i) => keyed(i))];
    const [note, ...rest] = keyBalance(questions);
    assert.equal(rest.length, 0);
    assert.equal(note?.scope, "bank");
    assert.equal(note?.letter, "C");
    assert.equal(note?.count, 21);
    assert.equal(note?.of, 24);
    assert.equal(note?.message, "In the questions that keep their option order: 21 of 24 right answers are C. A student who marks C for every question would get about 88 percent without reading any of them.");
  });

  test("questions that shuffle, are retired, have two right answers, have no key or are not single choice are not counted", () => {
    const shuffled = Array.from({ length: 30 }, () => keyed(2, { shuffle: true }));
    assert.deepEqual(keyBalance(shuffled), [], "no place to sit");
    const retired = Array.from({ length: 30 }, () => keyed(2, { shuffle: false, status: "retired" }));
    assert.deepEqual(keyBalance(retired), []);
    const unkeyed = Array.from({ length: 30 }, () => mc(`Q ${Math.random()}`, ["a", "b", "c"], { shuffle: false }));
    assert.deepEqual(keyBalance(unkeyed), []);
    const two = Array.from({ length: 30 }, () => mc(`Q ${Math.random()}`, ["a*", "b", "c*"], { shuffle: false }));
    assert.deepEqual(keyBalance(two), []);
    const placeholder = Array.from({ length: 30 }, () => mc(`Q ${Math.random()}`, ["a", "(missing)", "c*"], { shuffle: false }));
    assert.deepEqual(keyBalance(placeholder), []);
  });

  test("below the minimum nothing is said", () => {
    assert.deepEqual(keyBalance(Array.from({ length: 19 }, () => keyed(2))), []);
    assert.equal(keyBalance(Array.from({ length: 20 }, () => keyed(2))).length, 1);
  });

  test("a question whose key the importer said was not all applied is not counted, though one option is marked", () => {
    const doubtful = Array.from({ length: 30 }, () => ({ ...keyed(2), findings: [finding(FindingCode.KeyLetterMissing, "error", "The key names an option the question does not have.")] }));
    assert.deepEqual(keyBalance(doubtful), []);
  });

  test("a few questions with more options do not change what is expected", () => {
    const questions = [...Array.from({ length: 18 }, () => keyed(2)), ...Array.from({ length: 6 }, () => mc(`Q ${Math.random()}`, ["a", "b", "c", "d", "e*"], { shuffle: false }))];
    const [note] = keyBalance(questions);
    assert.equal(note?.letter, "C");
    assert.equal(note?.of, 24);
  });

  test("the usual number of options is what is expected, not the most", () => {
    // Of 24 answers, the count of one letter that is surprising among five options and is not among four. Twenty of the questions
    // have four options and four have five, so four is the usual number, and this is not said.
    const exactTail = (n: number, c: number, p: number): number => {
      let total = 0;
      for (let i = c; i <= n; i++) {
        let ways = 1;
        for (let j = 0; j < i; j++) ways = (ways * (n - j)) / (j + 1);
        total += ways * p ** i * (1 - p) ** (n - i);
      }
      return total;
    };
    const count = Array.from({ length: 25 }, (_, c) => c).find((c) => exactTail(24, c, 0.2) < 0.01 / 5 && exactTail(24, c, 0.25) >= 0.01 / 4) as number;
    assert.ok(count > 0, "there is such a count");
    const others = [0, 1, 3];
    const at = (i: number): number => (i < count ? 2 : (others[(i - count) % 3] as number));
    const questions = Array.from({ length: 24 }, (_, i) => {
      const options = i >= 20 ? ["a", "b", "c", "d", "e"] : ["a", "b", "c", "d"];
      return mc(`Q ${i} ${Math.random()}`, options.map((t, k) => (k === at(i) ? `${t}*` : t)), { shuffle: false });
    });
    assert.deepEqual(keyBalance(questions), []);
  });
});

describe("where the right answers sit in a test", () => {
  const questions = (count: number, at: number, shuffle: boolean) => Array.from({ length: count }, (_, i) => mc(`Question ${i} ${Math.random()}`, ["a", "b", "c", "d"].map((t, k) => (k === at ? `${t}*` : t)), { shuffle }));

  test("each version is judged by the letters the student marks", () => {
    const record = createTest({ name: "Midterm", questions: questions(24, 2, false), versions: 2, seed: "fixed" });
    const notes = keyBalance([], [record]);
    const a = notes.find((n) => n.label === 'Version A of "Midterm"');
    assert.ok(a);
    assert.equal(a.scope, "test");
    assert.equal(a.letter, "C");
    assert.equal(a.count, 24);
    assert.match(a.message, /^Version A of "Midterm": 24 of 24 right answers are C\./);
    // Kept in order in every version, so version B is the same.
    assert.ok(notes.find((n) => n.label === 'Version B of "Midterm"'));
  });

  test("a test whose versions shuffle is judged on each version as it will be printed", () => {
    const record = createTest({ name: "Quiz", questions: questions(24, 2, true), versions: 2, seed: "fixed" });
    const notes = keyBalance([], [record]);
    const a = notes.find((n) => n.label === 'Version A of "Quiz"');
    assert.equal(a?.letter, "C", "version A is the test as assembled");
    for (const n of notes) assert.match(n.label, /^Version [AB] of "Quiz"$/);
  });

  test("a test with fewer than the minimum is not judged, and true or false and multiple response are not counted", () => {
    assert.deepEqual(keyBalance([], [createTest({ name: "Short", questions: questions(19, 2, false) })]), []);
    const tf = Array.from({ length: 30 }, (_, i) => createQuestion({ type: "trueFalse", stem: plainToRich(`Statement ${i}`), body: { correct: true } }));
    assert.deepEqual(keyBalance([], [createTest({ name: "TF", questions: tf })]), []);
    // A multiple response question with one right answer has one letter, and still is not a single choice question.
    const response = Array.from({ length: 30 }, (_, i) =>
      createQuestion({
        type: "multipleResponse",
        stem: plainToRich(`Which is right in ${i}?`),
        body: { shuffle: false, partialCredit: false, options: ["a", "b", "c", "d"].map((t, k) => ({ id: `o${k}`, content: plainToRich(t), correct: k === 2 })) } as never,
      }),
    );
    assert.deepEqual(keyBalance([], [createTest({ name: "MR", questions: response })]), []);
  });
});

describe("in a bank", () => {
  test("checking a bank reports copies and the spread of answers, and stores neither", () => {
    const bank = Bank.createEmpty("Both");
    const first = bank.add(mc("What is the capital of France?", ["Paris*", "Rome"]));
    const second = bank.add(mc("What is the capital of France?", ["Paris*", "Rome"]));
    const run = bank.checkQuality();
    assert.equal(run.report.duplicates.length, 1);
    assert.deepEqual([...(run.report.duplicates[0]?.questionIds ?? [])].sort(), [first.id, second.id].sort());
    assert.deepEqual(bank.get(first.id)?.findings, []);
    // Taking one out and asking again: the report follows, because nothing was stored.
    bank.remove(second.id);
    assert.deepEqual(bank.checkQuality().report.duplicates, []);
  });

  test("the tests of a bank are in the report", () => {
    const bank = Bank.createEmpty("With a test");
    const qs = Array.from({ length: 24 }, (_, i) => bank.add(mc(`Question ${i} ${Math.random()}`, ["a", "b*", "c", "d"], { shuffle: false })));
    bank.addTest(createTest({ name: "Midterm", questions: qs }));
    const labels = bank.checkQuality().report.keyBalance.map((n) => n.label);
    assert.ok(labels.includes('Version A of "Midterm"'));
    assert.ok(labels.includes("In the questions that keep their option order"));
  });

  test("checkBankQuality is the two together", () => {
    const report = checkBankQuality([mc("What is the capital of France?", ["Paris*", "Rome"]), mc("What is the capital of France?", ["Paris*", "Rome"])]);
    assert.equal(report.duplicates.length, 1);
    assert.deepEqual(report.keyBalance, []);
  });
});
