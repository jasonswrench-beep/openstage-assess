/**
 * Writes the sample files the app offers on its first screen, into ../samples.
 *
 *     node --experimental-strip-types --no-warnings packages/app/tools/make-samples.ts
 *
 * The questions are invented for this and are about the planets, which everyone knows, so that a person trying the app can
 * see at once whether it read a question right. Two of the files have mistakes in them on purpose: they are what the repair
 * screen is for. The files are kept in the repository so that the app needs no tool to offer them, and this is how they are
 * made again. A test reads every one of them back and says what it must find.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { writeXlsx, type XlsxCell } from "../../assess/src/container/xlsx.ts";
import { docxFromLines } from "../../assess/test/support/docx-writer.ts";

const out = join(dirname(fileURLToPath(import.meta.url)), "..", "samples");
mkdirSync(out, { recursive: true });

// ---------------------------------------------------------------------------
// Word: a test bank as an instructor writes one, with the answer under each question
// ---------------------------------------------------------------------------

const cleanBank: string[] = [
  "1. Which planet is closest to the Sun?",
  "a. Venus",
  "b. Mercury",
  "c. Earth",
  "d. Mars",
  "Answer: B",
  "",
  "2. Which planet is known for its large system of rings?",
  "a. Jupiter",
  "b. Mars",
  "c. Saturn",
  "d. Neptune",
  "Answer: C",
  "",
  "3. What force keeps the planets in orbit around the Sun?",
  "a. Magnetism",
  "b. Friction",
  "c. Gravity",
  "d. Static electricity",
  "Answer: C",
  "",
  "Type: MR",
  "4. Which of the following are gas giants? (Select all that apply.)",
  "a. Jupiter",
  "b. Earth",
  "c. Saturn",
  "d. Venus",
  "Answer: A, C",
  "",
  "5. About how long does it take Earth to travel once around the Sun?",
  "a. One day",
  "b. One month",
  "c. One year",
  "d. One decade",
  "Answer: C",
  "",
  "Type: TF",
  "6. The Sun is a planet.",
  "Answer: False",
  "",
  "Type: TF",
  "7. Mercury has no moons.",
  "Answer: True",
  "",
  "Type: S",
  "8. What is the name of the galaxy that contains our Solar System?",
  "Answer: The Milky Way",
  "",
  "Type: S",
  "9. What is the largest planet in the Solar System?",
  "Answer: Jupiter",
  "",
  "Type: E",
  "10. Explain why the planets farther from the Sun take longer to complete an orbit.",
];

// The same bank with the kinds of trouble real banks have: a question with no answer, an answer that names an option that is
// not there, two answers on a question that holds one, and a note to the author sitting between questions.
const troubledBank: string[] = [
  "Chapter 3: The Solar System",
  "Test Bank (draft)",
  "",
  "1. Which planet is closest to the Sun?",
  "a. Venus",
  "b. Mercury",
  "c. Earth",
  "d. Mars",
  "Answer: B",
  "",
  "2. Which planet is known for its large system of rings?",
  "a. Jupiter",
  "b. Mars",
  "c. Saturn",
  "d. Neptune",
  "",
  "3. What force keeps the planets in orbit around the Sun?",
  "a. Magnetism",
  "b. Friction",
  "c. Gravity",
  "d. Static electricity",
  "Answer: E",
  "",
  "4. Which of the following are gas giants?",
  "a. Jupiter",
  "b. Earth",
  "c. Saturn",
  "d. Venus",
  "Answer: A, C",
  "",
  "Note to self: reword question 5 before the exam, and check the moon count.",
  "",
  "5. About how long does it take Earth to travel once around the Sun?",
  "a. One day",
  "b. One month",
  "c. One year",
  "d. One decade",
  "Answer: C",
  "",
  "Type: TF",
  "6. The Sun is a planet.",
  "Answer: False",
  "",
  "Type: S",
  "7. What is the largest planet in the Solar System?",
  "Answer: Jupiter",
];

writeFileSync(join(out, "solar-system-test-bank.docx"), docxFromLines(cleanBank));
writeFileSync(join(out, "solar-system-test-bank-with-problems.docx"), docxFromLines(troubledBank));

// ---------------------------------------------------------------------------
// Excel: the question table, with the columns OpenStage Author reads
// ---------------------------------------------------------------------------

const COLUMNS = ["Type", "Question", "A", "B", "C", "D", "E", "Correct", "Points", "Feedback if right", "Feedback if wrong", "Category"];
const WIDTHS = [8, 54, 22, 22, 22, 22, 22, 10, 8, 36, 36, 16];

const table: XlsxCell[][] = [
  COLUMNS,
  ["MC", "Which planet is closest to the Sun?", "Venus", "Mercury", "Earth", "Mars", "", "B", 1, "Yes. Mercury orbits closest to the Sun.", "Not quite. Think about which orbit is smallest.", "Planets"],
  ["MC", "Which planet is known for its large system of rings?", "Jupiter", "Mars", "Saturn", "Neptune", "", "C", 1, "", "", "Planets"],
  ["MC", "What force keeps the planets in orbit around the Sun?", "Magnetism", "Friction", "Gravity", "Static electricity", "", "C", 2, "Gravity holds the planets in orbit.", "", "Forces"],
  ["MR", "Which of the following are gas giants? (Select all that apply.)", "Jupiter", "Earth", "Saturn", "Venus", "", "A, C", 2, "", "", "Planets"],
  ["MC", "About how long does it take Earth to travel once around the Sun?", "One day", "One month", "One year", "One decade", "", "C", 1, "", "", "Orbits"],
  ["TF", "The Sun is a planet.", "", "", "", "", "", "False", 1, "The Sun is a star.", "", "Planets"],
  ["TF", "Mercury has no moons.", "", "", "", "", "", "True", 1, "", "", "Planets"],
  ["SA", "What is the name of the galaxy that contains our Solar System?", "The Milky Way", "Milky Way", "", "", "", "", 1, "", "", "Space"],
  ["SA", "What is the largest planet in the Solar System?", "Jupiter", "", "", "", "", "", 1, "", "", "Planets"],
  ["ES", "Explain why the planets farther from the Sun take longer to complete an orbit.", "", "", "", "", "", "", 5, "", "", "Orbits"],
  // The last two rows are mistakes, on purpose: a question whose Correct cell is empty, and one that names an answer that is not there.
  ["MC", "Which planet has the shortest day?", "Jupiter", "Mars", "Earth", "", "", "", 1, "", "", "Planets"],
  ["MC", "Which planet is called the Red Planet?", "Venus", "Mars", "Saturn", "", "", "D", 1, "", "", "Planets"],
];

writeFileSync(join(out, "solar-system-question-table.xlsx"), writeXlsx([{ name: "Questions", rows: table, widths: WIDTHS, header: true, dropdown: { column: 0, values: ["MC", "MR", "TF", "SA", "ES"], lastRow: 200 } }]));

// The blank one: the columns, one example of each kind of question to copy the way of writing from, and a sheet that says how.
const blank: XlsxCell[][] = [
  COLUMNS,
  ["MC", "Which channel suits a quick yes or no between two colleagues?", "A short message", "A formal letter", "A staff meeting", "A printed memo", "", "A", 1, "Right: a short message is quick and easy to answer.", "Not quite. Think about how quickly the answer is needed.", ""],
  ["MR", "Which of these help a reader decide what to read first?", "A clear subject line", "A long first paragraph", "A short summary at the top", "Writing in capital letters", "", "A, C", 1, "", "", ""],
  ["TF", "A reply to everyone is always the right choice.", "", "", "", "", "", "False", 1, "", "", ""],
  ["SA", "What is the name of the movement of ideas from one person to another?", "Communication", "communicating", "", "", "", "", 1, "", "", ""],
  ["ES", "Describe a time when the channel you chose changed how a message was understood.", "", "", "", "", "", "", 5, "", "", ""],
];
const howTo: XlsxCell[][] = [
  ["How to fill in the Questions sheet"],
  ["Delete the example rows and write your own, one question to a row. Keep the first row as it is."],
  [""],
  ["Type", "MC is multiple choice with one right answer, MR has several right, TF is true or false, SA is a short answer and ES is an essay. If you leave it empty OpenAssess works it out from the row."],
  ["Question", "The words of the question."],
  ["A to E", "The answers to choose from. For SA, the answers that are accepted. You can add columns F, G and H for more answers."],
  ["Correct", "For MC and MR, the letters of the right answers: B, or A and C. For TF, True or False. For SA and ES, leave it empty."],
  ["Points", "How many points the question is worth. Empty means 1."],
  ["Feedback", "What a student reads after a right or a wrong answer. Optional."],
  ["Category", "A topic to sort the questions by. Optional."],
  [""],
  ["If a Correct cell is empty or names an answer that is not there, the question is still brought in, marked with no answer, so you can fix it on screen. OpenAssess never picks an answer for you."],
  ["Save as Excel Workbook (.xlsx) or as CSV UTF-8. OpenStage Author reads the same columns from a CSV."],
];
writeFileSync(
  join(out, "blank-question-table.xlsx"),
  writeXlsx([
    { name: "Questions", rows: blank, widths: WIDTHS, header: true, dropdown: { column: 0, values: ["MC", "MR", "TF", "SA", "ES"], lastRow: 200 } },
    { name: "How to fill it in", rows: howTo, widths: [14, 110] },
  ]),
);

console.log(`Wrote the samples into ${out}`);
