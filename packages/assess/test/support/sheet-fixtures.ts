/**
 * Tests, plans and drawn sheets for the sheet reader's tests: a test with a known mix of questions, and a picture of its sheet.
 */

import { createQuestion } from "../../src/model/create.ts";
import { plainToRich } from "../../src/model/richtext.ts";
import type { Question, QuestionBody, QuestionType } from "../../src/model/question.ts";
import { createTest, type TestRecord } from "../../src/model/test.ts";
import { planSheet, type SheetPlan } from "../../src/sheets/plan.ts";
import { SheetRaster, type SheetMarks } from "../../src/sheets/raster.ts";
import type { PaperName } from "../../src/sheets/geometry.ts";
import type { GreyImage } from "../../src/sheets/image.ts";

const AT = "2026-01-01T00:00:00.000Z";
let made = 0;

const opt = (id: string, text: string, correct = false) => ({ id, content: plainToRich(text), correct });
const make = (type: QuestionType, body: QuestionBody): Question => createQuestion({ type, stem: plainToRich("A question"), body, by: "t", at: AT, id: `q_${String(++made).padStart(26, "0")}` });

export const mcq = (n: number, right = 0): Question => make("multipleChoice", { shuffle: true, options: Array.from({ length: n }, (_x, i) => opt(`o${i + 1}`, `Answer ${i + 1}`, i === right)) });
export const mrq = (n: number): Question => make("multipleResponse", { shuffle: true, partialCredit: false, options: Array.from({ length: n }, (_x, i) => opt(`o${i + 1}`, `Answer ${i + 1}`, i < 2)) });
export const tfq = (): Question => make("trueFalse", { correct: true });
export const essayq = (): Question => make("essay", {});

let tests = 0;
/** A test with an id made from a count, so that its fingerprint, and the code strip printed from it, are the same on every run of the tests. */
export const testOf = (questions: Question[], more: Partial<Parameters<typeof createTest>[0]> = {}): TestRecord => createTest({ id: `t_${String(++tests).padStart(26, "0")}`, name: "Quiz", questions, versions: 1, seed: "reader", at: AT, ...more });

/** A test of a number of questions that rotate through choice, true or false and several answers, with one essay among them. */
export const mixed = (count: number, more: Partial<Parameters<typeof createTest>[0]> = {}): TestRecord =>
  testOf(Array.from({ length: count }, (_x, i) => (i === 3 ? essayq() : i % 7 === 0 ? tfq() : i % 11 === 5 ? mrq(5) : mcq(4 + (i % 2)))), more);

export interface Drawn {
  record: TestRecord;
  plan: SheetPlan;
  raster: SheetRaster;
  render: (marks?: SheetMarks) => GreyImage;
}

/** The sheet of a test, ready to be drawn at a resolution, with marks. */
export function drawn(record: TestRecord, options: { paper?: PaperName; large?: boolean; dpi?: number; page?: number; version?: number } = {}): Drawn {
  const planned = planSheet(record, { paper: options.paper ?? "letter", large: options.large ?? false });
  if (!planned.ok) throw new Error(planned.reason);
  const raster = new SheetRaster(planned.plan, { title: record.name, fingerprint: record.fingerprint, versions: record.versions.length, version: options.version }, options.page ?? 1, options.dpi ?? 150);
  return { record, plan: planned.plan, raster, render: (marks) => raster.render(marks) };
}

/** A solid mark in the place of each question, for the places given (a place for every question number from 1). */
export const solid = (places: number[]): SheetMarks => ({ answers: Object.fromEntries(places.map((place, i) => [i + 1, place < 0 ? [] : [{ place, mark: { kind: "solid" as const } }]])) });
