/**
 * The sample files the first screen offers, so that a person with nothing to import can see what the app does.
 *
 * They are files in `../samples`, made by `../tools/make-samples.ts`, and they are asked for by an id of this list and never
 * by a name that came from the request, so there is no path for a request to reach for. Importing one is the same as
 * importing a file the person chose: it makes an import to look at and repair, and writes nothing until it is saved.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const SAMPLES_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "samples");

export interface Sample {
  id: string;
  title: string;
  /** What it shows, in a sentence for the screen. */
  description: string;
  file: string;
  kind: "Word" | "Excel";
  /** A file to fill in, not one to look at: it can be saved, and there is nothing in it to import but its examples. */
  template?: true;
}

export const SAMPLES: readonly Sample[] = [
  {
    id: "word-bank",
    title: "A Word test bank",
    description: "Ten questions about the planets, numbered, with answers under each: multiple choice, several right, true or false, short answer and an essay. Everything reads cleanly.",
    file: "solar-system-test-bank.docx",
    kind: "Word",
  },
  {
    id: "word-bank-with-problems",
    title: "A Word test bank with problems to repair",
    description: "The same kind of file with trouble in it: a question with no answer, an answer that names an option that is not there, two answers on one question, and a note left between questions.",
    file: "solar-system-test-bank-with-problems.docx",
    kind: "Word",
  },
  {
    id: "excel-table",
    title: "An Excel table of questions",
    description: "The same questions in rows, with the columns OpenStage Author reads. The last two rows are mistakes on purpose: a missing answer and an answer that is not there.",
    file: "solar-system-question-table.xlsx",
    kind: "Excel",
  },
  {
    id: "blank-table",
    title: "A blank Excel table to fill in",
    description: "The columns, one example of each kind of question, and a sheet that says how to fill it in. Save a copy, write your questions in it, and bring it back.",
    file: "blank-question-table.xlsx",
    kind: "Excel",
    template: true,
  },
];

export function sampleById(id: string | undefined): Sample | undefined {
  return SAMPLES.find((s) => s.id === id);
}

export const samplePath = (sample: Sample): string => join(SAMPLES_DIR, sample.file);
