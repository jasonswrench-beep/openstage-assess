/**
 * Search finds words however they are spelled with or without accents, in any script, and builds in time that grows with the
 * bank and not with its square.
 *
 * The index used to split on anything that was not a to z. "núcleo" came out as two words, "für" as two single letters that were
 * both dropped, and a bank in Spanish, French or German could not be searched by the words it was about. Every case here was
 * once wrong.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { SearchIndex, fold, tokenize } from "../src/bank/search.ts";
import { Bank } from "../src/bank/store.ts";
import { createQuestion } from "../src/model/create.ts";
import { plainToRich } from "../src/model/richtext.ts";
import type { Question } from "../src/model/question.ts";

const essay = (stem: string): Question => createQuestion({ type: "essay", stem: plainToRich(stem), body: {} });

describe("folding a text to what is searched", () => {
  test("takes the accents off Latin, Greek and Cyrillic letters, and lower-cases", () => {
    assert.equal(fold("Núcleo"), "nucleo");
    assert.equal(fold("FÜR Élise, naïve café, São Paulo, Dvořák, Łódź"), "fur elise, naive cafe, sao paulo, dvorak, lodz");
    assert.equal(fold("έτος Ὀδυσσεύς"), "ετος οδυσσευς");
    assert.equal(fold("ёж"), "еж");
  });

  test("writes the letters that do not come apart the way a person types them", () => {
    assert.equal(fold("Straße"), "strasse");
    assert.equal(fold("Æsop Œuvre Øre Đ Ł ð þ ı"), "aesop oeuvre ore d l d th i");
    assert.equal(fold("İstanbul"), "istanbul");
  });

  test("leaves the marks of other scripts, which are part of the word, and keeps Korean whole", () => {
    assert.equal(fold("हिन्दी"), "हिन्दी".normalize("NFC"));
    assert.equal(fold("한국어"), "한국어");
    assert.equal(fold("水是生命之源"), "水是生命之源");
  });

  test("an accent typed as a letter and a mark is the same as the letter with it on", () => {
    assert.equal(fold("núcleo"), fold("nú" + "cleo"));
  });
});

describe("the words of a text", () => {
  test("an accented word is one word, and the same word as without the accent", () => {
    assert.deepEqual(tokenize("núcleo"), ["nucleo"]);
    assert.deepEqual(tokenize("für"), ["fur"]);
    assert.deepEqual(tokenize("El núcleo de la célula"), ["el", "nucleo", "de", "la", "celula"]);
  });

  test("words in other scripts are words", () => {
    assert.deepEqual(tokenize("ο πυρήνας του κυττάρου"), ["πυρηνας", "του", "κυτταρου"], "the single letter ο is dropped like any other");
    assert.deepEqual(tokenize("ядро клетки"), ["ядро", "клетки"]);
    assert.deepEqual(tokenize("हिन्दी भाषा"), ["हिन्दी", "भाषा"].map((w) => w.normalize("NFC")), "the vowel signs are part of the word");
    assert.deepEqual(tokenize("细胞核 是 什么"), ["细胞核", "是", "什么"]);
  });

  test("a single letter is dropped, a single digit is kept, and so is a single character of Chinese, Japanese or Korean", () => {
    assert.deepEqual(tokenize("x y 5 z"), ["5"]);
    assert.deepEqual(tokenize("水 の 한"), ["水", "の", "한"]);
    assert.deepEqual(tokenize("chapter 5 question 3"), ["chapter", "5", "question", "3"]);
  });

  test("stop words go, and punctuation and hyphens split", () => {
    assert.deepEqual(tokenize("the unit-1 of a cell"), ["unit", "1", "cell"]);
    assert.deepEqual(tokenize("¿Dónde está el núcleo?"), ["donde", "esta", "el", "nucleo"]);
  });
});

describe("searching a bank", () => {
  const bank = (): Bank => {
    const b = Bank.createEmpty("Búsqueda");
    b.add(essay("El núcleo de la célula contiene el ADN."));
    b.add(essay("Wofür steht die Abkürzung DNA? Für Desoxyribonukleinsäure, auf Straße und Weg."));
    b.add(essay("The nucleus holds the DNA of a cell."));
    b.add(essay("Où est le café? Au coin, près de l’église."));
    return b;
  };

  test("finds a word with or without its accent, whichever way it is written in the question", () => {
    const b = bank();
    assert.equal(b.search("nucleo").length, 1);
    assert.equal(b.search("núcleo").length, 1);
    assert.equal(b.search("NÚCLEO").length, 1);
    assert.equal(b.search("celula").length, 1);
    assert.equal(b.search("cafe").length, 1);
    assert.equal(b.search("café").length, 1);
    assert.equal(b.search("eglise").length, 1);
  });

  test("finds the words that were once two single letters", () => {
    const b = bank();
    assert.equal(b.search("für").length, 1);
    assert.equal(b.search("fur").length, 1);
    assert.equal(b.search("wofür").length, 1);
    assert.equal(b.search("strasse").length, 1);
    assert.equal(b.search("Straße").length, 1);
    assert.equal(b.search("abkürzung dna").length, 1);
  });

  test("the last word is still a prefix, accents or not", () => {
    const b = bank();
    assert.equal(b.search("nucl").length, 2, "núcleo and nucleus");
    assert.equal(b.search("nuc").length, 2);
    assert.equal(b.search("núcl").length, 2);
    assert.equal(b.search("desoxy").length, 1);
  });

  test("the word being typed is found by what it begins, even when it is a stop word or one letter, so results do not vanish between keystrokes", () => {
    const b = Bank.createEmpty("Typing");
    b.add(essay("An atom is the smallest unit of an element."));
    b.add(essay("Insulin is made in the pancreas."));
    b.add(essay("The capital of France is Paris, and its office is old."));
    b.add(essay("Cells divide by mitosis."));
    assert.equal(b.search("ato").length, 1);
    assert.equal(b.search("at").length, 1, "at is a stop word, and begins atom");
    assert.equal(b.search("a").length >= 1, true, "a single letter begins words");
    assert.equal(b.search("in").length, 1, "in begins insulin");
    assert.equal(b.search("ins").length, 1);
    assert.equal(b.search("the").length, 0, "no word here begins with it, and the is not in the index");
    assert.equal(b.search("cells at").length, 1, "after another word a stop word narrows nothing, so it is the cells that are found");
  });

  test("a stop word that ends a search that has other words narrows nothing, until the next word is begun", () => {
    const b = Bank.createEmpty("Ends");
    b.add(essay("The capital of France is Paris and its office is old."));
    b.add(essay("The capital of Spain is Madrid."));
    assert.equal(b.search("capital").length, 2);
    assert.equal(b.search("capital of").length, 2, "of is a stop word, and office begins with it: the results do not drop to the one that has it");
    assert.equal(b.search("capital in").length, 2);
    assert.equal(b.search("capital of fr").length, 1, "and when the next word is begun they narrow");
    assert.equal(b.search("capital offi").length, 1);
  });

  test("a stop word or a letter before the last word is still left out", () => {
    const b = Bank.createEmpty("Middle");
    b.add(essay("The capital of France is Paris."));
    assert.equal(b.search("capital of france").length, 1);
    assert.equal(b.search("the capital of fra").length, 1);
  });

  test("an English search still means what it did", () => {
    const b = bank();
    assert.equal(b.search("nucleus").length, 1);
    assert.equal(b.search("nucleus dna").length, 1);
    assert.equal(b.search("dna").length, 2, "the Spanish question says ADN");
    assert.equal(b.search("nothinghere").length, 0);
  });
});

describe("the index", () => {
  test("taking a question out leaves none of its words, and putting it back leaves one copy", () => {
    const index = new SearchIndex();
    const a = essay("Mitochondria make energy");
    const b = essay("Ribosomes make protein");
    index.add(a);
    index.add(b);
    assert.deepEqual([...index.search("make")].sort(), [a.id, b.id].sort());
    index.remove(a.id);
    assert.deepEqual([...index.search("make")], [b.id]);
    assert.equal(index.search("mitochondria").size, 0);
    index.add({ ...b, title: "Ribosomes only", stem: plainToRich("Ribosomes only") });
    assert.equal(index.search("make").size, 0, "the words the question no longer has are not kept");
    assert.deepEqual([...index.search("only")], [b.id]);
    index.remove("not an id in it");
    assert.equal(index.search("only").size, 1);
  });

  test("every word of the question is gone when it is, so the index does not grow", () => {
    const index = new SearchIndex();
    const q = essay("Alpha beta gamma delta");
    index.add(q);
    const grown = index.size;
    assert.ok(grown >= 4);
    index.remove(q.id);
    assert.equal(index.size, 0);
  });

  test("clear forgets everything", () => {
    const index = new SearchIndex();
    index.add(essay("Alpha beta gamma delta"));
    index.clear();
    assert.equal(index.size, 0);
    assert.equal(index.search("alpha").size, 0);
  });

  test("a bank's index is built again from its questions, and holds only them", () => {
    const b = Bank.createEmpty("Rebuilt");
    const kept = b.add(essay("The kept question about osmosis"));
    const taken = b.add(essay("The other question about diffusion"));
    const index = (b as unknown as { index: SearchIndex }).index;
    const both = index.size;
    b.questions.delete(taken.id);
    assert.equal(index.size, both, "taken out by hand, its words are still in the index");
    b.rebuildIndex();
    assert.ok(index.size < both, "built again, they are not");
    assert.equal(index.search("diffusion").size, 0);
    assert.deepEqual(b.search("osmosis").map((q) => q.id), [kept.id]);
  });

  test("building the index for 16,000 questions takes time in step with the number, not its square", () => {
    // Every question has its own words as well as common ones, so the index holds thousands of different words. Taking a question
    // out used to walk every one of them, once for each question added: 8,000 took 1.6 seconds and 16,000 about 6, where this takes
    // a fifth of a second.
    const questions = Array.from({ length: 16000 }, (_, i) => essay(`Question ${i} about topic${i} and subject${i % 3000} with detail${(i * 7) % 5000} and common words`));
    const index = new SearchIndex();
    const start = performance.now();
    for (const q of questions) index.add(q);
    const took = performance.now() - start;
    assert.ok(took < 1500, `took ${took.toFixed(0)} ms`);
    assert.equal(index.search("topic4000").size, 1);
    assert.ok(index.size > 10000);
  });
});
