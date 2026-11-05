/**
 * The answer key of one version of a test, in the letters a student marks.
 *
 * It is worked out from the record's own frozen questions and never filled in: a question with no usable key has no letters and
 * says why, and a question a sheet cannot carry has none either. Whoever scores a sheet reads this, so a key change in the bank
 * after the test was given changes nothing here.
 */

import { isChoice, isMultipleResponse, isTrueFalse, type QuestionType } from "../model/question.ts";
import { placeLetter, versionQuestions, type TestRecord, type VersionLabel } from "../model/test.ts";
import { hasUsableKey } from "./answer-key.ts";

export interface VersionKeyEntry {
  /** The number the question has on this version's booklet. */
  number: number;
  questionId: string;
  type: QuestionType;
  /** The letters of the right answers as this version prints them, in order. Absent when there are none to give. */
  letters?: string[];
  /** Why there are no letters. */
  reason?: string;
}

export function versionKey(record: TestRecord, label: VersionLabel): VersionKeyEntry[] {
  return versionQuestions(record, label).map((q, i) => {
    const base = { number: i + 1, questionId: q.id, type: q.type };
    if (!isChoice(q) && !isMultipleResponse(q) && !isTrueFalse(q)) return { ...base, reason: "a bubble sheet cannot carry this kind of question" };
    if (!hasUsableKey(q)) return { ...base, reason: "it has no usable answer key, and nothing is guessed" };
    if (isTrueFalse(q)) return { ...base, letters: [q.body.correct ? "A" : "B"] };
    const letters: string[] = [];
    q.body.options.forEach((o, at) => {
      if (o.correct) letters.push(placeLetter(at));
    });
    return { ...base, letters };
  });
}
