/**
 * A test bank laid out the way a real publisher's Word file is, with invented words.
 *
 * Every question is a table of two cells: its number in the first (and in the copy with
 * the answers, the page it comes from), and in the second the question and, for a
 * multiple choice, one small table for each option. The same questions are given twice:
 * first as a copy to print, with no answers, and then after an "Answer Key" heading, with
 * them. A fill in the blank or true or false answer is the bold underlined word under its
 * question, an essay's answer is the plain paragraph under it, and a multiple choice
 * marks its right option by a bold underlined letter while the other letters are grey.
 *
 * The real file this is modelled on is a publisher's and is not in the repository. This
 * has none of its words, and every part of the layout that mattered is varied by an
 * option, so that a test can take one piece away and see what happens.
 */

import { docx, paragraph, run, table } from "./docx-writer.ts";

export const BOLD = "<w:b/>";
export const UNDERLINE = '<w:u w:val="single"/>';
export const GREY = '<w:color w:val="808080"/>';
export const ITALIC = "<w:i/>";
const BREAK = "<w:r><w:br/></w:r>";

export type Kind = "fill" | "truefalse" | "choice" | "short";

export interface Item {
  kind: Kind;
  stem: string;
  /** The word for a fill in the blank or true or false, the paragraph for a short answer. */
  answer?: string;
  options?: string[];
  /** The index of the right option of a choice question. */
  correct?: number;
  page?: string;
}

export const ITEMS: Item[] = [
  { kind: "fill", stem: "The ______ layer of a garden bed holds most of its nutrients.", answer: "top", page: "12" },
  { kind: "fill", stem: "Soil is made of ______ and ______ particles.", answer: "mineral; organic", page: "12" },
  { kind: "truefalse", stem: "Sandy soil drains faster than clay soil.", answer: "TRUE", page: "13" },
  { kind: "truefalse", stem: "Compost makes soil more compact.", answer: "FALSE", page: "14" },
  { kind: "choice", stem: "Which material improves the water a bed can hold?", options: ["gravel", "peat moss", "bare sand", "crushed brick"], correct: 1, page: "15" },
  { kind: "choice", stem: "A soil test is best done", options: ["in the middle of a drought.", "after heavy snow.", "just before planting.", "in the dark."], correct: 2, page: "16" },
  { kind: "choice", stem: "Mulch is mainly used to", options: ["keep the soil moist.", "attract bees.", "raise the soil's acidity.", "make the bed look larger.", "None of the above."], correct: 0, page: "17" },
  { kind: "choice", stem: "Which of these is a root vegetable?", options: ["lettuce", "spinach", "carrot", "basil"], correct: 2, page: "17" },
  { kind: "short", stem: "Explain why gardeners rotate crops.", answer: "Rotation keeps pests from settling and spreads the demands on the soil.", page: "18" },
  { kind: "short", stem: "Define topsoil.", answer: "The upper layer of soil, richest in organic matter.", page: "12" },
];

export interface LookalikeOptions {
  /** Which copies the file holds. Both by default. */
  halves?: "both" | "student" | "key";
  /** How the right option is marked in the copy with the answers. */
  mark?: "letter, others grey" | "letter only" | "words bold" | "none";
  /** The heading above the copy with the answers. */
  keyHeading?: string;
  /** The words of each section's heading. */
  headings?: Partial<Record<Kind, string>>;
  /** Whether the copy with the answers says what page each question is from. */
  pages?: boolean;
  items?: Item[];
  /** A change to a question as the copy for students has it, to make the copies differ. */
  student?: (item: Item, index: number) => Item;
  /** What stands above the first section. */
  title?: string[];
}

const SECTIONS: Kind[] = ["fill", "truefalse", "choice", "short"];
const HEADINGS: Record<Kind, string> = {
  fill: "Fill in the Blank Questions",
  truefalse: "True / False Questions",
  choice: "Multiple Choice Questions",
  short: "Short Answer Questions",
};
const LETTERS = "ABCDEFGHIJ";

const blank = (): string => paragraph(run(" "));
const heading = (text: string): string => paragraph(run(text, BOLD));

/** An option's own small table: its letter in one cell, its words in the other. */
function optionTable(letter: string, words: string, properties: string): string {
  return table([[paragraph(run(`${letter}. `, properties)), paragraph(run(words))]]) + paragraph();
}

function options(item: Item, marked: boolean, mark: NonNullable<LookalikeOptions["mark"]>): string {
  return (item.options ?? [])
    .map((words, i) => {
      const right = i === item.correct;
      if (!marked || mark === "none") return optionTable(LETTERS[i] as string, words, "");
      if (mark === "words bold") {
        return table([[paragraph(run(`${LETTERS[i]}. `)), paragraph(run(words, right ? BOLD : ""))]]) + paragraph();
      }
      const properties = right ? BOLD + UNDERLINE : mark === "letter, others grey" ? GREY : "";
      return optionTable(LETTERS[i] as string, words, properties);
    })
    .join("");
}

/** One question as the copy for students has it: no answer, and a line to write on. */
function studentCopy(item: Item, n: number, mark: NonNullable<LookalikeOptions["mark"]>): string {
  switch (item.kind) {
    case "fill":
      return paragraph(run(`${n}. ${item.stem} `)) + paragraph(run("_".repeat(40))) + blank();
    case "truefalse":
      return paragraph(run(`${n}. ${item.stem} `)) + paragraph(run("True    False")) + blank();
    case "choice":
      return table([[paragraph(run(`${n}.`)), paragraph(run(item.stem + " ")) + blank() + options(item, false, mark)]]) + blank();
    case "short":
      return paragraph(run(`${n}. ${item.stem} `)) + blank();
  }
}

/** One question as the copy with the answers has it. */
function keyCopy(item: Item, n: number, pages: boolean, mark: NonNullable<LookalikeOptions["mark"]>): string {
  const number = paragraph(run(`${n}.`)) + (pages && item.page ? paragraph(run(`(p. ${item.page})`, ITALIC)) : "");
  const stem = run(item.stem + " ") + BREAK + run(" ") + BREAK;
  let content: string;
  switch (item.kind) {
    case "fill":
    case "truefalse":
      content = paragraph(stem + run(item.answer ?? "", BOLD + UNDERLINE));
      break;
    case "short":
      content = paragraph(stem + run(item.answer ?? ""));
      break;
    case "choice":
      content = paragraph(stem) + options(item, true, mark);
      break;
  }
  return table([[number, content]]) + blank();
}

export function lookalike(settings: LookalikeOptions = {}): Uint8Array {
  const items = settings.items ?? ITEMS;
  const halves = settings.halves ?? "both";
  const mark = settings.mark ?? "letter, others grey";
  const headings = { ...HEADINGS, ...settings.headings };
  const pages = settings.pages ?? true;

  const half = (render: (item: Item, n: number, index: number) => string): string => {
    let n = 0;
    return SECTIONS.map((kind) => {
      const inSection = items.filter((i) => i.kind === kind);
      if (inSection.length === 0) return "";
      return heading(headings[kind]) + blank() + inSection.map((item) => render(item, ++n, items.indexOf(item))).join("");
    }).join("");
  };

  const titles = (settings.title ?? ["Chapter 3", "Soil and Gardens"]).map((t) => paragraph(run(t))).join("");
  const student = half((item, n, index) => studentCopy(settings.student ? settings.student(item, index) : item, n, mark));
  const key = half((item, n) => keyCopy(item, n, pages, mark));
  const keyHeading = paragraph(run(settings.keyHeading ?? "Chapter 3 Soil and Gardens Answer Key")) + blank();

  const body =
    halves === "student" ? titles + student : halves === "key" ? titles + keyHeading + key : titles + student + keyHeading + key;
  return docx({ body });
}

/** What each question of the items should come out as, in order, after the sections are numbered. */
export function sectioned(items: readonly Item[] = ITEMS): Item[] {
  return SECTIONS.flatMap((kind) => items.filter((i) => i.kind === kind));
}
