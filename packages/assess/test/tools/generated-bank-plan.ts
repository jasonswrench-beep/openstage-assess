/**
 * What each file of a generated test bank is to look like. A batch written by another model, left to choose, came
 * back as five documents under 24 names in one layout, so the layout is assigned here, a few files at a time, and
 * generated-bank-check.ts holds each file to its assignment by reading the document's XML.
 *
 * A layout is three choices: how a question begins (B), how its options are labelled (O) and how the right one is
 * marked (K). The rest of what is asked for is the other question types (E), one hard case (T), and a subject, so
 * that no two files can be about the same thing.
 *
 * Pieces 1 to 4 are the blind set and pieces 5 and 6 may be fitted to. See docs/synthetic-bank-spec.md.
 */

export type Begin = "B1" | "B2" | "B3" | "B4" | "B5" | "B6" | "B7" | "B8";
export type Options = "O1" | "O2" | "O3" | "O4" | "O5" | "O6" | "O7" | "O8";
export type Mark = "K1" | "K2" | "K3" | "K4" | "K5" | "K6" | "K7" | "K8" | "K9" | "K10" | "K11";
export type Extra = "TFo" | "TFp" | "TFa" | "FIB" | "SA" | "ESS" | "MR" | "MTt" | "MTl";
export type Trap = "T0" | "T1" | "T2" | "T3" | "T4" | "T5" | "T6" | "T7";

export interface PlanEntry {
  name: string;
  piece: number;
  begin: Begin;
  options: Options;
  mark: Mark;
  /** The word that introduces the answer line (K8) or the answer at the end of the options (K11). */
  word?: "Answer" | "ANS" | "Correct";
  extras: Extra[];
  trap: Trap;
  /** How many questions to write. The checker accepts 12 to 30. */
  questions: number;
  lapses: number;
  subject: string;
}

export const BEGIN: Record<Begin, string> = {
  B1: "Each question begins with a typed number and a full stop: 1. 2. 3.",
  B2: "Each question begins with a typed number and a closing bracket: 1) 2) 3)",
  B3: "Each question begins with a typed number in brackets: (1) (2) (3)",
  B4: "Each question begins with Q and a typed number and a full stop: Q1. Q2. Q3.",
  B5: "Each question begins with the word Question, a typed number and a colon: Question 1: Question 2:",
  B6: "Each question is numbered by Word's own automatic numbering: use a real numbered list in Word. The numbers must not be typed into the text.",
  B7: "Each question begins with a typed chapter number, a full stop and a question number: 4.1 4.2 4.3 (use any one chapter number).",
  B8: "Questions have no number of any kind. One blank paragraph separates one question from the next.",
};

export const OPTIONS: Record<Options, string> = {
  O1: "Options are labelled with a capital letter and a full stop: A. B. C. D. One option to a paragraph.",
  O2: "Options are labelled with a capital letter and a closing bracket: A) B) C) D) One option to a paragraph.",
  O3: "Options are labelled with a capital letter in brackets: (A) (B) (C) (D) One option to a paragraph.",
  O4: "Options are labelled with a lower-case letter and a full stop: a. b. c. d. One option to a paragraph.",
  O5: "Options are labelled with a capital letter and a colon: A: B: C: D: One option to a paragraph.",
  O6: "Options have no label at all: each option is a paragraph of its own under the question.",
  O7: "Several options share a paragraph, labelled A. B. C. D., with at least two spaces between one option and the next: A. red   B. blue   C. green   D. grey. Use one or two paragraphs for the options of a question.",
  O8: "Options are bullets: a real bulleted list in Word, one option to a bullet, with no letters.",
};

export const MARK: Record<Mark, string> = {
  K1: "The right option has an asterisk in front of its words (after its label, if it has one). No other mark.",
  K2: "The right option has an asterisk at the end of its line. No other mark.",
  K3: "The right option's words are bold, using Word's own bold on the text. No other option is bold. No other mark.",
  K4: "The right option's words are underlined, using Word's own underline on the text. No other option is underlined. No other mark.",
  K5: "The right option's words are highlighted, using Word's own text highlight (yellow). No other option is highlighted. No other mark.",
  K6: "The right option's words are in a red font colour, using Word's own font colour. No other option is coloured. No other mark.",
  K7: "The right option ends with (Correct). No other mark.",
  K8: "A line of its own under the options gives the answer, for example 'WORD: C'. No other mark.",
  K9: "The questions carry no mark. At the end of the file, a heading Answer Key and then lines such as '1. B   2. D   3. A   4. C', several to a line, in order.",
  K10: "The questions carry no mark. At the end of the file, a heading Answer Key and then a real Word table with two columns: the question number and the correct letter.",
  K11: "The answer is given at the end of the paragraph that holds the last option, for example 'A. red   B. blue   C. green   D. grey   WORD: C'. No other mark.",
};

export const EXTRA: Record<Extra, string> = {
  TFo: "True or false questions with two options, True and False, labelled and marked like the other questions in the file.",
  TFp: "True or false questions written as a statement with (T) or (F) at the end of the statement's paragraph, which is the answer. No options. In the answer file the stem is the statement alone: leave the (T) or (F) out of it.",
  TFa: "True or false questions written as a statement with a line of its own under it: Answer: True (or Answer: False). No options.",
  FIB: "Fill in the blank questions: the blank is four underscores ____ and the question has no options. A line of its own under it gives the answer: Answer: word. Give exactly one answer, of one or two words, with no comma in it.",
  SA: "Short answer questions: no options, and a line of its own under the question gives the expected answer: Answer: words. Give exactly one answer, with no comma in it.",
  ESS: "Essay questions: a prompt with no options and no answer given.",
  MR: "Multiple response questions: two or three of the options are right, and each is marked in the way the file marks its right options. In the expected file the type is multipleResponse.",
  MTt: "A matching question as a real Word table of two columns, the left item and its match, with a sentence above it that says to match them. Four or five rows.",
  MTl: "A matching question as lines of 'term = definition', one to a paragraph, with a space each side of the equals sign, under a sentence that says to match them. Four or five lines.",
};

export const TRAP: Record<Trap, string> = {
  T0: "This is a clean, conventional file: no lapses and nothing hard. Every question is marked, and marked once.",
  T1: "Include a multiple choice question whose own stem contains a numbered list of steps inside the question text (1. 2. 3.).",
  T2: "Include a multiple choice question with an option whose words begin with a letter and a full stop, or with a number, as part of the words (for example 'B. subtracted' or '3 apples').",
  T3: "Include a question whose stem or an option contains the exact text 'Answer:' or an asterisk * as part of its words.",
  T4: "Include a question whose stem runs over two paragraphs, with the options after the second.",
  T5: "Include a paragraph with a line break inside it (Shift+Enter in Word): for example a question and its first option in one paragraph with a break between them.",
  T6: "Include a multiple choice question with no answer marked at all: leave the mark off it. In the expected file it has \"verdict\": \"failed\" and no \"correct\".",
  T7: "Include a single-answer multiple choice question with two options marked as right. In the expected file it has \"verdict\": \"failed\" and no \"correct\".",
};

// 24 files, six pieces of four. Every value of B, O, K and T is used at least twice, and the combinations that
// make no sense (an Answer line with no labels to point at, a key by number with no numbers) are left out.
const p = (
  name: string,
  piece: number,
  begin: Begin,
  options: Options,
  mark: Mark,
  extras: Extra[],
  trap: Trap,
  questions: number,
  lapses: number,
  subject: string,
  word?: PlanEntry["word"],
): PlanEntry => ({ name, piece, begin, options, mark, extras, trap, questions, lapses, subject, ...(word ? { word } : {}) });

export const PLAN: PlanEntry[] = [
  p("c-01", 1, "B1", "O4", "K8", ["TFo", "FIB"], "T0", 14, 0, "introductory statistics", "Answer"),
  p("c-02", 1, "B2", "O1", "K3", ["TFp", "SA"], "T1", 14, 3, "world geography"),
  p("c-03", 1, "B4", "O5", "K4", ["MR", "ESS"], "T3", 16, 3, "music theory"),
  p("c-04", 1, "B8", "O6", "K5", ["TFa", "SA"], "T6", 12, 2, "nutrition"),
  p("c-05", 2, "B5", "O3", "K3", ["MTl", "ESS"], "T2", 16, 4, "microeconomics"),
  p("c-06", 2, "B6", "O1", "K8", ["TFo", "SA"], "T4", 14, 3, "human anatomy", "ANS"),
  p("c-07", 2, "B7", "O1", "K10", ["FIB", "MR"], "T7", 18, 3, "organic chemistry"),
  p("c-08", 2, "B3", "O2", "K1", ["TFo", "MTt"], "T5", 14, 4, "United States history"),
  p("c-09", 3, "B1", "O7", "K11", ["TFa", "SA"], "T2", 12, 2, "Spanish vocabulary", "ANS"),
  p("c-10", 3, "B2", "O4", "K6", ["FIB", "ESS"], "T3", 16, 3, "introductory psychology"),
  p("c-11", 3, "B6", "O8", "K7", ["TFo", "MR"], "T0", 14, 0, "computer networks"),
  p("c-12", 3, "B4", "O3", "K2", ["TFp", "SA"], "T1", 12, 3, "astronomy"),
  p("c-13", 4, "B5", "O5", "K9", ["TFp", "FIB"], "T6", 16, 3, "financial accounting"),
  p("c-14", 4, "B8", "O6", "K3", ["MR", "SA"], "T0", 14, 0, "poetry and literary terms"),
  p("c-15", 4, "B7", "O2", "K8", ["TFo", "MTl"], "T4", 14, 4, "civil engineering", "Correct"),
  p("c-16", 4, "B3", "O1", "K5", ["FIB", "ESS"], "T7", 16, 3, "environmental science"),
  p("c-17", 5, "B1", "O2", "K10", ["SA", "TFo"], "T5", 16, 3, "pharmacology"),
  p("c-18", 5, "B2", "O7", "K11", ["FIB", "MR"], "T3", 14, 4, "marketing", "Answer"),
  p("c-19", 5, "B6", "O4", "K1", ["MTt", "ESS"], "T6", 12, 2, "physics of motion"),
  p("c-20", 5, "B4", "O5", "K6", ["TFa", "SA"], "T2", 14, 3, "business law"),
  p("c-21", 6, "B5", "O8", "K4", ["TFo", "FIB"], "T4", 14, 3, "health and wellness"),
  p("c-22", 6, "B3", "O3", "K9", ["MR", "ESS"], "T7", 16, 4, "cell biology"),
  p("c-23", 6, "B8", "O6", "K2", ["TFp", "SA"], "T0", 12, 0, "world religions"),
  p("c-24", 6, "B7", "O1", "K7", ["FIB", "MTt"], "T1", 18, 3, "linear algebra"),
];

export const PIECES = [...new Set(PLAN.map((e) => e.piece))].sort((a, b) => a - b);
export const BLIND_PIECES = [1, 2, 3, 4];

const phrase = (text: string, word?: string): string => text.replace("WORD", word ?? "Answer");

/** The hard case, with what it means for the way this file marks its answers, which is where it is easy to misread. */
function trapFor(entry: PlanEntry): string {
  const text = TRAP[entry.trap];
  const inKey = entry.mark === "K9" || entry.mark === "K10";
  const onLine = entry.mark === "K8" || entry.mark === "K11";
  if (entry.trap === "T4") return `${text} The second paragraph carries no number and no label.`;
  if (entry.trap === "T6") return inKey ? `${text} Here that means leaving the question out of the key.` : onLine ? `${text} Here that means leaving its answer off.` : text;
  if (entry.trap === "T7") return inKey ? `${text} Here that means two letters for it in the key.` : onLine ? `${text} Here that means two letters in its answer.` : text;
  return text;
}

/** The assignment for one file, in words, as it is given to the model that writes the file. */
export function assignmentFor(entry: PlanEntry): string {
  const lines = [
    `${entry.name}.docx, with ${entry.name}.docx.expected.json beside it. Subject: ${entry.subject}. Write ${entry.questions} questions, at least 8 of them single-answer multiple choice, with 3 to 5 options each.`,
    `  How a question begins: ${BEGIN[entry.begin]}`,
    `  How options are labelled: ${OPTIONS[entry.options]}`,
    `  How the right option is marked: ${phrase(MARK[entry.mark], entry.word)}`,
    `  Also include, at least once each:`,
    ...entry.extras.map((e) => `    - ${EXTRA[e]}`),
    `  ${trapFor(entry)}`,
    entry.lapses === 0
      ? `  No lapses.`
      : `  Lapses: put in exactly ${entry.lapses} small lapses that a tired person would make: ${
          entry.mark === "K9" || entry.mark === "K10"
            ? "a missing blank line, a space before a full stop, an extra blank line, a trailing space (do not skip or repeat a question number in this file, because the key at the end goes by them)"
            : "a skipped or repeated number, a missing blank line, a space before a full stop, an extra blank line, a trailing space"
        }, a stray note to self (leave the note out of the expected file). A lapse must never change which option is right or what any text says, and never touches the marks. A lapse inside a question's words or an option's words, such as a space before a question mark, goes into the answer file exactly as it is in the document.`,
  ];
  return lines.join("\n");
}

export function pieceText(piece: number): string {
  const entries = PLAN.filter((e) => e.piece === piece);
  return [`Your assignment is piece ${piece}: ${entries.length} files.`, "", ...entries.map(assignmentFor)].join("\n\n");
}
