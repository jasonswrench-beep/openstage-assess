/**
 * The item quality and accessibility checks (`quality/items.ts`).
 *
 * Two things are held here besides what each rule finds. A note is only ever a note: it never changes a verdict, which is what the
 * import gate counts and what an export holds back. And a rule that depends on which option is right says nothing about a
 * question with no usable key, so none of these can make a guess about the answer. The boundaries are tested on both sides
 * (exactly at a line, and one step short of it) because a rule whose line moved by one would still pass every example in the middle.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { Bank } from "../src/bank/store.ts";
import { createQuestion } from "../src/model/create.ts";
import { FindingCode, finding, verdictFrom } from "../src/model/findings.ts";
import type { MediaRef, MathRef, Question } from "../src/model/question.ts";
import { plainToRich, rich, type RichText } from "../src/model/richtext.ts";
import { checkItemQuality, LONG_MATCHING_LIST, QUALITY_CODES, withFreshQuality } from "../src/quality/items.ts";

/** A choice question. An option written with a * on the end is the right one. */
function mc(stem: string | RichText, options: string[], extra: { type?: "multipleChoice" | "multipleResponse"; shuffle?: boolean; media?: MediaRef[]; math?: MathRef[] } = {}): Question {
  return createQuestion({
    type: extra.type ?? "multipleChoice",
    stem: typeof stem === "string" ? plainToRich(stem) : stem,
    body: {
      shuffle: extra.shuffle ?? true,
      ...(extra.type === "multipleResponse" ? { partialCredit: false } : {}),
      options: options.map((text, i) => ({ id: `o${i}`, content: plainToRich(text.replace(/\*$/, "")), correct: text.endsWith("*") })),
    } as never,
    ...(extra.media ? { media: extra.media } : {}),
    ...(extra.math ? { math: extra.math } : {}),
  });
}

const codes = (q: Question): string[] => checkItemQuality(q).map((f) => f.code);
const flagged = (q: Question, code: string): boolean => codes(q).includes(code);
const picture = (id: string, alt: string): MediaRef => ({ id, file: `media/${id}.png`, mime: "image/png", alt });
const withPicture = (id: string, text: string) => rich(`<p>${text}</p><oa-media ref="${id}"></oa-media>`);

describe("every note is a note, and nothing else", () => {
  test("a question with notes is still parsed", () => {
    const q = withFreshQuality(mc("Which is not a fruit?", ["Apple", "Carrot*", "All of the above"]));
    assert.ok(q.findings.length >= 2, "it has notes");
    assert.ok(q.findings.every((f) => f.severity === "info"));
    assert.equal(verdictFrom(q.findings), "parsed");
  });

  test("the codes the checks can raise are the ones that are replaced", () => {
    const raised = new Set<string>();
    const all: Question[] = [
      mc("Which is not a fruit?", ["Apple", "Carrot*", "All of the above", "Apple"]),
      mc("A cell makes a", ["Protein*", "Orange"]),
      mc(withPicture("m1", "Which bar is red?"), ["Paris*", "B", "C"], { media: [picture("m1", "A red bar in Paris")] }),
      mc("Which is it?", ["Short", "Brief", "A very long and well worded answer that is the right one*"]),
    ];
    for (const q of all) for (const f of checkItemQuality(q)) raised.add(f.code);
    for (const code of raised) assert.ok(QUALITY_CODES.has(code), `${code} is raised but would never be refreshed`);
    assert.ok(raised.size >= 6);
  });
});

describe("options that only make sense beside the others", () => {
  test("All of the above, None of the above and Both A and B are noted, with the letter", () => {
    for (const [text, letter] of [["All of the above", "C"], ["None of the above", "C"], ["Both A and B", "C"], ["Neither of these", "C"]] as const) {
      const found = checkItemQuality(mc("Pick.", ["Red", "Blue", text + "*"])).find((f) => f.code === FindingCode.AllOrNoneOfTheAbove);
      assert.ok(found, text);
      assert.match(found.message, new RegExp(`Option ${letter}, "${text}"`));
      assert.equal(found.severity, "info");
      assert.equal(found.field, "body.options");
    }
  });

  test("an ordinary option that has the words in it is not noted", () => {
    assert.equal(flagged(mc("Pick.", ["Above average", "All mammals", "Both parents*", "None"]), FindingCode.AllOrNoneOfTheAbove), false);
  });

  test("a placeholder is not read as an option", () => {
    assert.equal(flagged(mc("Pick.", ["Red*", "Blue", "(missing)"]), FindingCode.AllOrNoneOfTheAbove), false);
  });

  test("it says the printed test keeps these options in order", () => {
    const found = checkItemQuality(mc("Pick.", ["Red*", "Blue", "All of the above"])).find((f) => f.code === FindingCode.AllOrNoneOfTheAbove);
    assert.match(found?.message ?? "", /printed test keeps this question's options in order/);
  });
});

describe("the right answer that is the longest", () => {
  const wrong = "x".repeat(40);

  test("is noted when it is 1.5 times as long and 20 characters longer, and not one step short of either", () => {
    const atLine = mc("Pick.", [wrong, wrong.replace(/x/, "y"), "z".repeat(60) + "*"]);
    assert.ok(flagged(atLine, FindingCode.LongestOptionCorrect), "60 against 40 is on the line");
    const ratioShort = mc("Pick.", [wrong, wrong.replace(/x/, "y"), "z".repeat(59) + "*"]);
    assert.equal(flagged(ratioShort, FindingCode.LongestOptionCorrect), false, "59 against 40 is under 1.5 times");
    // 1.5 times is 15, but only 12 longer: the margin is what holds this one back.
    const marginShort = mc("Pick.", ["x".repeat(10), "y".repeat(10), "z".repeat(15) + "*"]);
    assert.equal(flagged(marginShort, FindingCode.LongestOptionCorrect), false, "15 against 10 is 1.5 times but only 5 longer");
    const marginUnder = mc("Pick.", ["x".repeat(38), "y".repeat(38), "z".repeat(58) + "*"]);
    assert.ok(flagged(marginUnder, FindingCode.LongestOptionCorrect), "58 against 38 is 20 longer and 1.53 times");
    const marginOne = mc("Pick.", ["x".repeat(38), "y".repeat(38), "z".repeat(57) + "*"]);
    assert.equal(flagged(marginOne, FindingCode.LongestOptionCorrect), false, "57 against 38 is 1.5 times and 19 longer");
  });

  test("the ratio holds on its own, when the margin is easily met", () => {
    // 100 against 149 is 49 longer, so only the ratio (1.49 against 1.5) holds this one back.
    const options = (right: number) => ["x".repeat(100), "y".repeat(100), "z".repeat(right) + "*"];
    assert.equal(flagged(mc("Pick.", options(149)), FindingCode.LongestOptionCorrect), false);
    assert.ok(flagged(mc("Pick.", options(150)), FindingCode.LongestOptionCorrect));
  });

  test("a right answer that has no words does not stop the check, and is not noted", () => {
    // The right option is a placeholder, so there is no right answer to measure. This is not a question with a usable key, but
    // the check must not depend on that being noticed first.
    assert.doesNotThrow(() => checkItemQuality(mc("Pick.", ["x".repeat(40), "y".repeat(40), "z".repeat(80), "(missing)*"])));
    assert.equal(flagged(mc("Pick.", ["x".repeat(40), "y".repeat(40), "z".repeat(80), "(missing)*"]), FindingCode.LongestOptionCorrect), false);
  });

  test("names the option and the lengths", () => {
    const found = checkItemQuality(mc("Pick.", [wrong, "y".repeat(30), "z".repeat(80) + "*"])).find((f) => f.code === FindingCode.LongestOptionCorrect);
    assert.match(found?.message ?? "", /option C, 80 characters.*longest wrong one \(40\)/);
  });

  test("is not noted when the right answer is not the longest, or the question has two right answers", () => {
    assert.equal(flagged(mc("Pick.", ["x".repeat(90), "y", "z".repeat(60) + "*"]), FindingCode.LongestOptionCorrect), false);
    assert.equal(flagged(mc("Pick.", [wrong, "y".repeat(10), "z".repeat(80) + "*"], { type: "multipleResponse" }), FindingCode.LongestOptionCorrect), false);
  });

  test("says nothing when there is no usable key: it will not read a key that is not there", () => {
    assert.equal(flagged(mc("Pick.", [wrong, "y".repeat(10), "z".repeat(80)]), FindingCode.LongestOptionCorrect), false);
    // The importer's own error about the key counts too, even though the body looks keyed.
    const q = mc("Pick.", [wrong, "y".repeat(10), "z".repeat(80) + "*"]);
    const failed = { ...q, findings: [finding(FindingCode.KeyLetterMissing, "error", "The key names an option the question does not have.")] };
    assert.equal(flagged(failed, FindingCode.LongestOptionCorrect), false);
  });

  test("needs three options with words and ignores a question whose options are pictures", () => {
    assert.equal(flagged(mc("Pick.", ["y", "z".repeat(80) + "*"]), FindingCode.LongestOptionCorrect), false);
    assert.equal(flagged(mc("Pick.", ["y", "z", "w".repeat(80) + "*", "(missing)"]), FindingCode.LongestOptionCorrect), true, "a placeholder is left out, and three remain");
    assert.equal(flagged(mc("Pick.", ["y", "(missing)", "w".repeat(80) + "*"]), FindingCode.LongestOptionCorrect), false, "only two remain");
    const withMedia = createQuestion({
      type: "multipleChoice",
      stem: plainToRich("Pick."),
      body: { shuffle: true, options: [{ id: "a", content: plainToRich("y"), correct: false }, { id: "b", content: plainToRich("z"), correct: false }, { id: "c", content: rich(`${"w".repeat(80)}<oa-media ref="m1"></oa-media>`), correct: true }] } as never,
      media: [picture("m1", "x")],
    });
    assert.equal(flagged(withMedia, FindingCode.LongestOptionCorrect), false);
  });
});

describe("a negative stem that is not set apart", () => {
  const stemNoted = (stem: string | RichText): boolean => flagged(mc(stem, ["Red*", "Blue"]), FindingCode.NegativeStemNotEmphasised);

  test("is noted for not, cannot, except, least, incorrect and n't", () => {
    for (const stem of ["Which is not a fruit?", "Which cannot fly?", "All are fruit except one:", "Which is the least likely?", "Which is incorrect?", "Which is incorrectly stated?", "Which isn't a fruit?", "Which doesn’t belong?"]) {
      assert.ok(stemNoted(stem), stem);
    }
  });

  test("names the word", () => {
    const found = checkItemQuality(mc("Which is not a fruit?", ["Red*", "Blue"])).find((f) => f.code === FindingCode.NegativeStemNotEmphasised);
    assert.match(found?.message ?? "", /\("not"\)/);
    assert.equal(found?.field, "stem");
  });

  test("is not noted when the word is in capitals or set in bold, italics or underline", () => {
    assert.equal(stemNoted("Which is NOT a fruit?"), false);
    assert.equal(stemNoted("All are fruit EXCEPT one:"), false);
    for (const tag of ["strong", "em", "u"]) {
      assert.equal(stemNoted(rich(`<p>Which is <${tag}>not</${tag}> a fruit?</p>`)), false, tag);
    }
  });

  test("is still noted when only another word is set apart", () => {
    assert.ok(stemNoted(rich("<p>Which of the <strong>following</strong> is not a fruit?</p>")));
  });

  test("leaves phrases that use the words without turning the question round", () => {
    for (const stem of ["Which of these has at least two sides?", "Decide whether or not it is a fruit.", "Which is not only red but also sweet?", "Find the least common multiple of 4 and 6.", "Find the least squares line.", "Is it right if not stated?"]) {
      assert.equal(stemNoted(stem), false, stem);
    }
  });

  // What real banks showed (1421 questions of real Word banks, 79 notes, a third of them wrong): the question is positive and the word
  // is in the story before it, in an example it quotes, in a why question about a negative fact, or in a condition.
  test("is not noted when the story before the question says not and the question itself does not", () => {
    assert.equal(stemNoted("Darlene is concerned that she will not appear honest because her speech is about a product her company sells.  What aspect of credibility is Darlene concerned about?"), false);
    assert.equal(stemNoted("Jim notices that the speaker may not be accurate. Gerald does not agree. What is this called?"), false);
    // The question can be the first sentence, with the story after it, or the story can lead to a question that does say it.
    assert.ok(stemNoted("Which description is not correct? You are planning to build a speech processor. Compared to AF clipping, RF clipping:"));
    assert.ok(stemNoted("Sara is concerned about the artistic standard.  Which of the following speech components would Sara not be concerned about?"));
    // The last sentence is the question even when it has no question mark.
    assert.ok(stemNoted("Read the passage above carefully.  All of the following are true except"));
    // A stem of one sentence is looked at whole, and an abbreviation does not cut it in two.
    assert.ok(stemNoted("Which of these is not a method, e.g. a technique for sorting?"));
  });

  test("is not noted for a word inside quotation marks", () => {
    assert.equal(stemNoted("“If you do not use suntan lotion, you will get skin cancer and die!” is an example of which aspect of style?"), false);
    assert.equal(stemNoted('"It does not seem to flow right" is an example of which kind of criticism?'), false);
    assert.ok(stemNoted("In “Hamlet”, which of these characters does not die?"), "the word is outside the quotation");
  });

  test("is not noted for a why question, and is for a which question that has the same words", () => {
    assert.equal(stemNoted("Why can't sound waves propagate through a vacuum?"), false);
    assert.equal(stemNoted("Why is carbon-14 dating not suitable for dating rocks?"), false);
    assert.ok(stemNoted("Which reason is not suitable for dating rocks?"));
  });

  test("is not noted for a word in a condition, and is for one in the question after it", () => {
    assert.equal(stemNoted("If you do not understand what a critic is saying, you should"), false);
    assert.equal(stemNoted("What type of image is formed by a converging lens when the object is not near the focal point?"), false);
    assert.equal(stemNoted("What should you do if a balanced equation is not in its simplest form?"), false);
    assert.equal(stemNoted("When the transmitter is not modulated, or the signal is zero, the frequency is called its:"), false);
    assert.ok(stemNoted("When receiving criticism, which of the following is something you should not do?"), "the condition ends at the comma");
    assert.ok(stemNoted("Which of the following is not true when the temperature does not change?"), "the first word is in the question");
    assert.equal(stemNoted("What do people who may or may not be interested in a topic want to hear?"), false);
  });

  test("is only for questions with options to choose from", () => {
    const essay = createQuestion({ type: "essay", stem: plainToRich("Why is it not a fruit?"), body: {} });
    assert.equal(codes(essay).includes(FindingCode.NegativeStemNotEmphasised), false);
    const tf = createQuestion({ type: "trueFalse", stem: plainToRich("A tomato is not a fruit."), body: { correct: false } });
    assert.equal(codes(tf).includes(FindingCode.NegativeStemNotEmphasised), false);
  });
});

describe("a stem that ends in a or an", () => {
  const cue = (stem: string, options: string[]): boolean => flagged(mc(stem, options), FindingCode.GrammaticalCue);

  test("rules out the options that do not fit it", () => {
    const found = checkItemQuality(mc("A cell wall is found in a", ["Plant*", "Dog", "Orange"])).find((f) => f.code === FindingCode.GrammaticalCue);
    assert.ok(found);
    assert.match(found.message, /ends in "a".*start with a consonant.*rules out option C\./);
    const an = checkItemQuality(mc("The part is an", ["Axon*", "Dendrite", "Bone", "Egg"])).find((f) => f.code === FindingCode.GrammaticalCue);
    assert.match(an?.message ?? "", /ends in "an".*start with a vowel.*rules out options B, C\./);
  });

  test("sees past a blank and the marks at the end of a stem", () => {
    assert.ok(cue("A plant cell has a ____", ["Wall*", "Apple"]));
    assert.ok(cue("A plant cell has a ...", ["Wall*", "Apple"]));
    assert.ok(cue("A plant cell has a:", ["Wall*", "Apple"]));
  });

  test("is silent when the options all fit, or none does", () => {
    assert.equal(cue("It is a", ["Dog*", "Cat", "Fish"]), false);
    assert.equal(cue("It is a", ["Apple*", "Egg"]), false);
    assert.equal(cue("It is an", ["Apple*", "Egg"]), false);
  });

  test("is silent when the stem does not end in an article, or the A is a capital", () => {
    assert.equal(cue("It is a dog or", ["Apple*", "Dog"]), false);
    assert.equal(cue("Which food has vitamin A", ["Apple*", "Dog"]), false);
    assert.equal(cue("Banana is a ?", ["Apple*", "Dog"]), false);
    assert.equal(cue("Banana a", ["Apple*", "Dog"]), true);
  });

  test("is silent when an option starts with a letter whose sound the letter does not settle", () => {
    for (const odd of ["Hour", "Honest man", "University", "Umbrella", "8 apples", "Éclair", "One", "Once only", "European", "Ewe"]) {
      assert.equal(cue("It is a", [odd, "Dog*", "Apple"]), false, odd);
    }
    assert.equal(cue("It is a", ["Hippo*", "Dog", "Apple"]), false, "Hippo starts with h, so no verdict on any");
  });

  test("is silent for an acronym, a letter on its own, and a letter joined to a word, which are read by name", () => {
    for (const odd of ["MRI", "RNA", "DNA test", "X-ray", "x-ray", "A", "b", "a"]) assert.equal(cue("It is an", [odd, "Dog*", "Apple"]), false, odd);
    assert.equal(cue("The slope is a", ["a*", "b", "c", "x"]), false, "a variable named a");
    assert.equal(cue("The slope is a", ["MRI*", "Dog", "Cat"]), false);
    // A word that is only capitalised is still a word.
    assert.ok(cue("It is a", ["Orange*", "Dog", "Cat"]));
    assert.ok(cue("It is an", ["Apple*", "Dog", "Egg"]));
  });

  test("a single option, or only placeholders, says nothing", () => {
    assert.equal(cue("It is a", ["Apple*", "(missing)"]), false);
  });
});

describe("options that read the same", () => {
  test("are noted, whatever the case, spacing or punctuation", () => {
    const found = checkItemQuality(mc("Pick.", ["Paris*", "Rome", "paris.", "  PARIS "])).find((f) => f.code === FindingCode.DuplicateOption);
    assert.ok(found);
    assert.match(found.message, /option A and option C and option D/);
    assert.equal(found.field, "body.options");
  });

  test("two groups are both named", () => {
    const found = checkItemQuality(mc("Pick.", ["Paris*", "Rome", "Paris", "Rome"])).find((f) => f.code === FindingCode.DuplicateOption);
    assert.match(found?.message ?? "", /option A and option C; option B and option D/);
  });

  test("options that differ in a sign, an operator, a currency or a vowel mark are not copies", () => {
    const sets = [["+2*", "-2", "+1", "-1"], ["x > 3*", "x < 3", "x >= 3", "x <= 3"], ["<*", ">", "="], ["$5*", "€5", "£5"], ["किताब*", "कुताब", "कीताब", "केताब"], ["2*", "-2", "+2"]];
    for (const options of sets) assert.equal(flagged(mc("Pick.", options), FindingCode.DuplicateOption), false, options.join(" | "));
  });

  test("the same text in two Unicode forms, or with only the stop at the end different, is a copy", () => {
    assert.ok(flagged(mc("Pick.", ["café*", "café"]), FindingCode.DuplicateOption), "composed and decomposed");
    assert.ok(flagged(mc("Pick.", ["Paris*", "Paris."]), FindingCode.DuplicateOption));
    assert.ok(flagged(mc("Pick.", ["\"Paris\"*", "Paris"]), FindingCode.DuplicateOption), "with quotes");
    assert.ok(flagged(mc("Pick.", ["x > 3*", "X  >  3"]), FindingCode.DuplicateOption), "with spacing and case");
  });

  test("two placeholders are not a pair of copies", () => {
    assert.equal(flagged(mc("Pick.", ["Paris*", "(missing)", "(missing)"]), FindingCode.DuplicateOption), false);
  });

  test("two options with no words and different pictures are not a pair of copies", () => {
    const q = createQuestion({
      type: "multipleChoice",
      stem: plainToRich("Which?"),
      body: { shuffle: true, options: [{ id: "a", content: rich('<oa-media ref="m1"></oa-media>'), correct: true }, { id: "b", content: rich('<oa-media ref="m2"></oa-media>'), correct: false }] } as never,
      media: [picture("m1", "one"), picture("m2", "two")],
    });
    assert.equal(flagged(q, FindingCode.DuplicateOption), false);
    const same = createQuestion({
      type: "multipleChoice",
      stem: plainToRich("Which?"),
      body: { shuffle: true, options: [{ id: "a", content: rich('<oa-media ref="m1"></oa-media>'), correct: true }, { id: "b", content: rich('<oa-media ref="m1"></oa-media>'), correct: false }] } as never,
      media: [picture("m1", "one")],
    });
    assert.ok(flagged(same, FindingCode.DuplicateOption), "the same picture twice is a copy");
  });

  test("two equations with the same words around them are not copies", () => {
    const q = createQuestion({
      type: "multipleChoice",
      stem: plainToRich("Which?"),
      body: { shuffle: true, options: [{ id: "a", content: rich('<oa-math ref="e1"></oa-math>'), correct: true }, { id: "b", content: rich('<oa-math ref="e2"></oa-math>'), correct: false }] } as never,
      math: [{ id: "e1", latex: "x^2", mathml: "<math/>" }, { id: "e2", latex: "x^3", mathml: "<math/>" }],
    });
    assert.equal(flagged(q, FindingCode.DuplicateOption), false);
  });

  test("a matching question may repeat a right-hand entry on purpose, but an extra that repeats one is noted", () => {
    const pairs = (rights: string[], distractors: string[]) =>
      createQuestion({
        type: "matching",
        stem: plainToRich("Match."),
        body: { shuffle: true, distractors, pairs: rights.map((right, i) => ({ id: `p${i}`, left: plainToRich(`Left ${i}`), right })) } as never,
      });
    assert.equal(flagged(pairs(["Mammal", "Mammal", "Bird"], []), FindingCode.DuplicateOption), false, "a category two things share");
    const extraCopy = checkItemQuality(pairs(["Mammal", "Bird"], ["bird"])).find((f) => f.code === FindingCode.DuplicateOption);
    assert.match(extraCopy?.message ?? "", /right-hand entry 2 and extra entry 1/);
    assert.equal(extraCopy?.field, "body.pairs");
    assert.ok(flagged(pairs(["Mammal", "Bird"], ["Fish", "fish"]), FindingCode.DuplicateOption), "two extras that read the same");
  });

  test("an ordering question with two items that read the same is noted", () => {
    const items = (words: string[]) =>
      createQuestion({ type: "ordering", stem: plainToRich("Order."), body: { items: words.map((w, i) => ({ id: `i${i}`, content: plainToRich(w), position: i + 1 })) } as never });
    const found = checkItemQuality(items(["First", "Second", "first"])).find((f) => f.code === FindingCode.DuplicateOption);
    assert.match(found?.message ?? "", /item 1 and item 3/);
    assert.equal(found?.field, "body.items");
    assert.equal(flagged(items(["First", "Second"]), FindingCode.DuplicateOption), false);
  });
});

describe("a picture whose description gives the answer", () => {
  const pic = (alt: string, id = "m1") => [picture(id, alt)];

  test("is noted when the description holds the right answer as a whole phrase", () => {
    const q = mc(withPicture("m1", "Which city is shown?"), ["Paris*", "Rome"], { media: pic("The Eiffel Tower, in Paris, at dusk") });
    const found = checkItemQuality(q).find((f) => f.code === FindingCode.AltTextGivesAnswer);
    assert.ok(found);
    assert.match(found.message, /\("paris"\)/);
    assert.equal(found.field, "media");
  });

  test("is not noted for a wrong answer, a part of a word, an answer under four letters, or an empty description", () => {
    assert.equal(flagged(mc(withPicture("m1", "Which?"), ["Rome*", "Paris"], { media: pic("In Paris") }), FindingCode.AltTextGivesAnswer), false, "the wrong one");
    assert.equal(flagged(mc(withPicture("m1", "Which?"), ["Paris*", "Rome"], { media: pic("A Parisian cafe") }), FindingCode.AltTextGivesAnswer), false, "part of a word");
    assert.equal(flagged(mc(withPicture("m1", "Which?"), ["Oslo*", "Rome"], { media: pic("A harbour in Os") }), FindingCode.AltTextGivesAnswer), false);
    assert.equal(flagged(mc(withPicture("m1", "Which?"), ["Rio*", "Rome"], { media: pic("A beach in Rio") }), FindingCode.AltTextGivesAnswer), false, "three letters");
    assert.equal(flagged(mc(withPicture("m1", "Which?"), ["Oslo*", "Rome"], { media: pic("A harbour in Oslo") }), FindingCode.AltTextGivesAnswer), true, "four letters is enough");
    assert.equal(flagged(mc(withPicture("m1", "Which?"), ["Paris*", "Rome"], { media: pic("   ") }), FindingCode.AltTextGivesAnswer), false);
  });

  test("is not noted for a picture the stem does not use", () => {
    assert.equal(flagged(mc("Which?", ["Paris*", "Rome"], { media: pic("In Paris") }), FindingCode.AltTextGivesAnswer), false);
  });

  test("is not noted when the question has no usable key", () => {
    assert.equal(flagged(mc(withPicture("m1", "Which?"), ["Paris", "Rome"], { media: pic("In Paris") }), FindingCode.AltTextGivesAnswer), false);
    // An option is marked, but the importer said the key it was given was not all applied: the marked option may not be the answer.
    const marked = mc(withPicture("m1", "Which?"), ["Paris*", "Rome"], { media: pic("In Paris") });
    assert.ok(flagged(marked, FindingCode.AltTextGivesAnswer));
    const doubtful = { ...marked, findings: [finding(FindingCode.KeyLetterMissing, "error", "The key names an option the question does not have.")] };
    assert.equal(flagged(doubtful, FindingCode.AltTextGivesAnswer), false);
  });

  test("only the right answers are looked for, and only the right ones", () => {
    assert.equal(flagged(mc(withPicture("m1", "Which?"), ["Rome*", "Paris", "Oslo"], { media: pic("In Paris") }), FindingCode.AltTextGivesAnswer), false);
    assert.ok(flagged(mc(withPicture("m1", "Which?"), ["Rome*", "Paris*", "Oslo"], { type: "multipleResponse", media: pic("In Paris") }), FindingCode.AltTextGivesAnswer));
  });

  test("also looks at the accepted answers of a short answer and a fill in the blank", () => {
    const short = createQuestion({ type: "shortAnswer", stem: withPicture("m1", "Which city?"), body: { caseSensitive: false, accepted: ["Paris"] }, media: pic("A street in Paris") });
    assert.ok(flagged(short, FindingCode.AltTextGivesAnswer));
    const blank = createQuestion({ type: "fillInBlank", stem: withPicture("m1", "The city is ____."), body: { caseSensitive: false, blanks: [{ id: "b1", accepted: ["Paris", "paris"] }] }, media: pic("A street in Paris") });
    assert.ok(flagged(blank, FindingCode.AltTextGivesAnswer));
  });
});

describe("a picture and a colour", () => {
  test("is noted when the stem or an option names a colour", () => {
    const m = [picture("m1", "A bar chart")];
    const found = checkItemQuality(mc(withPicture("m1", "Which bar is red?"), ["Left*", "Right"], { media: m })).find((f) => f.code === FindingCode.ColourOnlyMeaning);
    assert.ok(found);
    assert.match(found.message, /\("red"\)/);
    assert.equal(found.field, "stem");
    assert.ok(flagged(mc(withPicture("m1", "Which bar?"), ["The BLUE one*", "Right"], { media: m }), FindingCode.ColourOnlyMeaning), "in an option, in capitals");
  });

  test("is not noted without a picture, or when the word is part of another", () => {
    assert.equal(flagged(mc("What colour is the red sky?", ["Red*", "Blue"]), FindingCode.ColourOnlyMeaning), false);
    assert.equal(flagged(mc(withPicture("m1", "Which is Fred?"), ["Left*", "Bored"], { media: [picture("m1", "x")] }), FindingCode.ColourOnlyMeaning), false);
  });
});

describe("a long matching list", () => {
  const matching = (count: number) =>
    createQuestion({ type: "matching", stem: plainToRich("Match."), body: { shuffle: true, distractors: [], pairs: Array.from({ length: count }, (_, i) => ({ id: `p${i}`, left: plainToRich(`Left ${i}`), right: `Right ${i}` })) } as never });

  test("is noted above the line and not at it", () => {
    assert.equal(LONG_MATCHING_LIST, 8);
    assert.equal(flagged(matching(8), FindingCode.LongMatchingList), false);
    const found = checkItemQuality(matching(9)).find((f) => f.code === FindingCode.LongMatchingList);
    assert.match(found?.message ?? "", /has 9 pairs.*8 or fewer/);
    assert.equal(found?.field, "body.pairs");
  });
});

describe("a typed answer with typography in it", () => {
  const short = (accepted: string[], caseSensitive = false) =>
    createQuestion({ type: "shortAnswer", stem: plainToRich("Name it."), body: { caseSensitive, accepted } as never });
  const blanks = (lists: string[][]) =>
    createQuestion({ type: "fillInBlank", stem: plainToRich("A ____ and a ____."), body: { caseSensitive: false, blanks: lists.map((accepted, i) => ({ id: `b${i + 1}`, accepted })) } as never });
  const noted = (q: Question) => checkItemQuality(q).find((f) => f.code === FindingCode.TypedAnswerTypography);

  test("is noted for a curly apostrophe, a dash and an ellipsis, with the plain form to add", () => {
    const found = noted(short(["Earth’s moon"]));
    assert.equal(found?.severity, "info", "a note, never a warning");
    assert.equal(found?.field, "body.accepted");
    assert.match(found?.message ?? "", /"Earth's moon" would be marked wrong/);
    assert.match(found?.message ?? "", /Add "Earth's moon" as another accepted answer/);
    assert.ok(noted(short(["1914–1918"])), "an en dash");
    assert.ok(noted(short(["Wait…"])), "an ellipsis");
    assert.ok(noted(short(["the “best” one"])), "curly double quotes");
  });

  test("says nothing when the plain form is accepted too, in either order, or the answer is already plain", () => {
    assert.equal(noted(short(["Earth’s moon", "Earth's moon"])), undefined);
    assert.equal(noted(short(["Earth's moon", "Earth’s moon"])), undefined);
    assert.equal(noted(short(["Earth's moon"])), undefined);
    assert.equal(noted(short([""])), undefined, "an empty answer is the missing key's business, not this note's");
  });

  test("lets the case of the plain form differ only when the question is not case sensitive", () => {
    assert.equal(noted(short(["Earth’s Moon", "earth's moon"], false)), undefined);
    assert.ok(noted(short(["Earth’s Moon", "earth's moon"], true)));
  });

  test("reads each blank of a fill in the blank by itself, and names the one it found", () => {
    assert.equal(noted(blanks([["fine"], ["fine"]])), undefined);
    assert.equal(noted(blanks([["it’s", "it's"], ["fine"]])), undefined, "the first blank has both forms");
    assert.equal(noted(blanks([["fine"], ["it’s"]]))?.field, "body.blanks.1.accepted");
  });

  test("is not raised for an answer that is chosen and not typed", () => {
    assert.equal(noted(mc("Which is it?", ["Earth’s moon*", "Venus"])), undefined);
  });

  test("changes no answer: the accepted answers are what the author wrote", () => {
    const q = short(["Earth’s moon"]);
    const after = withFreshQuality(q);
    assert.deepEqual((after.body as { accepted: string[] }).accepted, ["Earth’s moon"]);
  });
});

describe("making the notes fresh", () => {
  const noted = () => mc("Which is not a fruit?", ["Apple", "Carrot*", "All of the above"]);

  test("returns the same question when nothing would change", () => {
    const clean = mc("Which is a fruit?", ["Apple*", "Carrot"]);
    assert.equal(withFreshQuality(clean), clean);
    const once = withFreshQuality(noted());
    assert.equal(withFreshQuality(once), once);
  });

  test("changes only the notes: not the version, the history, the status or the other findings", () => {
    const base = { ...noted(), findings: [finding(FindingCode.TypeInferred, "warn", "guessed the type")] };
    const after = withFreshQuality(base);
    assert.notEqual(after, base);
    assert.equal(after.version, base.version);
    assert.deepEqual(after.history, base.history);
    assert.deepEqual(after.metadata, base.metadata);
    assert.equal(after.findings[0]?.code, FindingCode.TypeInferred);
    assert.equal(after.findings.filter((f) => QUALITY_CODES.has(f.code)).length, 2);
  });

  test("drops a note that no longer applies and leaves a stale one of another kind alone", () => {
    const stale = { ...mc("Which is a fruit?", ["Apple*", "Carrot"]), findings: [finding(FindingCode.AllOrNoneOfTheAbove, "info", "old"), finding(FindingCode.MarkupRemoved, "info", "kept")] };
    const after = withFreshQuality(stale);
    assert.deepEqual(after.findings.map((f) => f.code), [FindingCode.MarkupRemoved]);
  });

  test("a dismissed note stays dismissed when the same check speaks again, and not for another part of the question", () => {
    const first = withFreshQuality(noted());
    const dismissed = { ...first, findings: first.findings.map((f) => (f.code === FindingCode.AllOrNoneOfTheAbove ? { ...f, dismissed: true, dismissedBy: "jason", dismissedAt: "2026-11-05T00:00:00.000Z" } : f)) };
    const edited = withFreshQuality({ ...dismissed, stem: plainToRich("Which one is not a fruit?") });
    const kept = edited.findings.find((f) => f.code === FindingCode.AllOrNoneOfTheAbove);
    assert.equal(kept?.dismissed, true);
    assert.equal(kept?.dismissedBy, "jason");
    assert.equal(kept?.dismissedAt, "2026-11-05T00:00:00.000Z");
    assert.equal(edited.findings.find((f) => f.code === FindingCode.NegativeStemNotEmphasised)?.dismissed, undefined, "the other note was not dismissed");
  });
});

describe("in a bank", () => {
  test("a question saved in a bank has its notes made fresh, and an edit that fixes one removes it", () => {
    const bank = Bank.createEmpty("Quality");
    const q = bank.add(mc("Which is a fruit?", ["Apple*", "Carrot"]));
    assert.deepEqual(q.findings, []);
    const worse = bank.update(q.id, { stem: plainToRich("Which is not a fruit?") }, { by: "t" });
    assert.deepEqual(worse.findings.map((f) => f.code), [FindingCode.NegativeStemNotEmphasised]);
    const fixed = bank.update(q.id, { stem: plainToRich("Which is NOT a fruit?") }, { by: "t" });
    assert.deepEqual(fixed.findings, []);
  });

  test("a question written in a bank has its notes as it goes in, and one brought in by an import has none until the bank is checked", () => {
    const bank = Bank.createEmpty("Quality");
    const written = bank.add(mc("Which is not a fruit?", ["Apple", "Carrot*", "All of the above"]));
    assert.deepEqual(written.findings.map((f) => f.code).sort(), [FindingCode.AllOrNoneOfTheAbove, FindingCode.NegativeStemNotEmphasised]);
    assert.equal(bank.get(written.id)?.findings.length, 2);
    const imported = bank.add({ ...mc("Which is not a vegetable?", ["Apple*", "Carrot", "All of the above"]), origin: { kind: "import" } });
    assert.deepEqual(imported.findings, [], "an import's findings are about what the importer guessed, and notes are not mixed in");
    assert.equal(bank.checkQuality().changed, 1, "the check makes the notes of the imported one, and the written one is as it was");
    assert.equal(bank.get(imported.id)?.findings.length, 2);
  });

  test("a note dismissed on a question that was written in the bank stays dismissed through a check", () => {
    const bank = Bank.createEmpty("Quality");
    const first = bank.add(mc("Which is not a fruit?", ["Apple", "Carrot*", "All of the above"]));
    const dismissed = { ...first, findings: first.findings.map((f) => ({ ...f, dismissed: true, dismissedBy: "jason" })) };
    bank.questions.set(first.id, dismissed);
    assert.equal(bank.checkQuality().changed, 0);
    assert.ok(bank.get(first.id)?.findings.every((f) => f.dismissed === true));
  });

  test("checking a bank writes the notes without editing: the version, the history and the status stay", () => {
    const bank = Bank.createEmpty("Quality");
    const added = bank.add({ ...mc("Which is not a fruit?", ["Apple", "Carrot*", "All of the above"]), origin: { kind: "import" } });
    const run = bank.checkQuality("jason");
    assert.equal(run.checked, 1);
    assert.equal(run.changed, 1);
    assert.deepEqual(run.notes, { [FindingCode.AllOrNoneOfTheAbove]: 1, [FindingCode.NegativeStemNotEmphasised]: 1 });
    assert.deepEqual(run.questions.map((q) => q.id), [added.id]);
    const stored = bank.get(added.id) as Question;
    assert.equal(stored.version, added.version);
    assert.deepEqual(stored.history, added.history);
    assert.equal(stored.metadata.status, added.metadata.status);
    assert.equal(stored.findings.length, 2);
    assert.match(bank.history.at(-1)?.change ?? "", /checked the questions for quality; the notes of 1 changed/);
    assert.equal(bank.history.at(-1)?.by, "jason");
  });

  test("checking again changes nothing and adds no history", () => {
    const bank = Bank.createEmpty("Quality");
    bank.add(mc("Which is not a fruit?", ["Apple", "Carrot*"]));
    bank.checkQuality();
    const lines = bank.history.length;
    const again = bank.checkQuality();
    assert.equal(again.changed, 0);
    assert.equal(bank.history.length, lines);
  });

  test("a dismissed note is kept and is not counted as live", () => {
    const bank = Bank.createEmpty("Quality");
    const q = bank.add(mc("Which is not a fruit?", ["Apple", "Carrot*"]));
    bank.checkQuality();
    const noted = bank.get(q.id) as Question;
    bank.questions.set(q.id, { ...noted, findings: noted.findings.map((f) => ({ ...f, dismissed: true, dismissedBy: "jason" })) });
    const run = bank.checkQuality();
    assert.equal(run.changed, 0);
    assert.deepEqual(run.notes, {});
    assert.deepEqual(run.questions, []);
    assert.equal(bank.get(q.id)?.findings[0]?.dismissed, true);
  });

  test("a note on a retired question is still kept up to date", () => {
    const bank = Bank.createEmpty("Quality");
    const q = bank.add({ ...mc("Which is not a fruit?", ["Apple", "Carrot*"]), metadata: { tags: [], status: "retired" }, origin: { kind: "import" } });
    assert.equal(bank.checkQuality().changed, 1);
    assert.equal(bank.get(q.id)?.findings.length, 1);
  });
});
