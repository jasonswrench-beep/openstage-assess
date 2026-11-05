/**
 * What a bank covers: how many questions there are for each objective, chapter, tag, Bloom level, difficulty or kind, and the grid
 * of any two of them against each other (objectives down, Bloom levels across).
 *
 * It is a count of what is in the bank, and nothing is made up to fill it. A question with no objective is counted under "(none)",
 * not left out, so a grid never adds up to less than the bank and a person can see how much has not been tagged; a retired question
 * is left out, because it is not in use (the same way an export leaves it out), unless asked for. A question has one objective, one
 * chapter, one Bloom level and one difficulty, but may have several tags, so a grid with tags on an axis counts it once for each
 * tag, and `total` is still the number of different questions.
 */

import { BLOOM_LEVELS, DIFFICULTIES, QUESTION_TYPES, STATUSES, type Question } from "../model/question.ts";

export const COVERAGE_AXES = ["objective", "chapter", "section", "tag", "bloom", "difficulty", "type", "status"] as const;
export type CoverageAxis = (typeof COVERAGE_AXES)[number];

/** The label of the question that has no value on an axis. It is last in every list. */
export const NONE = "(none)";

/** The values a question has on an axis, as text. A question with none is `[NONE]`, and a tag axis may give several. */
export function valuesOn(question: Question, axis: CoverageAxis): string[] {
  const m = question.metadata;
  const one = (value: string | undefined): string[] => {
    const text = value?.trim() ?? "";
    return [text === "" ? NONE : text];
  };
  switch (axis) {
    case "objective":
      return one(m.objective);
    case "chapter":
      return one(m.chapter);
    case "section":
      return one(m.section);
    case "bloom":
      return one(m.bloom);
    case "difficulty":
      return one(m.difficulty);
    case "type":
      return [question.type];
    case "status":
      return [m.status];
    case "tag": {
      const tags = [...new Set(m.tags.map((t) => t.trim()).filter((t) => t !== ""))];
      return tags.length > 0 ? tags : [NONE];
    }
  }
}

/** Labels in the order a person expects: Bloom and difficulty from easy to hard, kinds and statuses as the model lists them, the rest by name with numbers in order. */
function ordered(axis: CoverageAxis, labels: Iterable<string>): string[] {
  const set = new Set(labels);
  const fixed: readonly string[] | undefined =
    axis === "bloom" ? BLOOM_LEVELS : axis === "difficulty" ? DIFFICULTIES : axis === "type" ? QUESTION_TYPES : axis === "status" ? STATUSES : undefined;
  const out = fixed ? fixed.filter((label) => set.has(label)) : [...set].filter((label) => label !== NONE).sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }));
  // A value the model does not list (a hand-edited file) is kept, after the ones it does.
  for (const label of [...set].filter((l) => l !== NONE && !out.includes(l)).sort()) out.push(label);
  if (set.has(NONE)) out.push(NONE);
  return out;
}

export interface CoverageOptions {
  /** Count retired questions too. Left out by default. */
  includeRetired?: boolean;
}

export interface CoverageGrid {
  rows: CoverageAxis;
  cols: CoverageAxis;
  rowLabels: string[];
  colLabels: string[];
  /** cells[r][c]: how many questions have row label r and column label c. */
  cells: number[][];
  rowTotals: number[];
  colTotals: number[];
  /** The number of different questions counted. With a tag axis the totals of the rows or columns can add up to more. */
  total: number;
}

function counted(questions: readonly Question[], options: CoverageOptions): Question[] {
  return questions.filter((q) => options.includeRetired === true || q.metadata.status !== "retired");
}

export function coverage(questions: readonly Question[], rows: CoverageAxis, cols: CoverageAxis, options: CoverageOptions = {}): CoverageGrid {
  const used = counted(questions, options);
  const rowLabels = ordered(rows, used.flatMap((q) => valuesOn(q, rows)));
  const colLabels = ordered(cols, used.flatMap((q) => valuesOn(q, cols)));
  const rowAt = new Map(rowLabels.map((l, i) => [l, i] as const));
  const colAt = new Map(colLabels.map((l, i) => [l, i] as const));
  const cells = rowLabels.map(() => colLabels.map(() => 0));
  const rowTotals = rowLabels.map(() => 0);
  const colTotals = colLabels.map(() => 0);

  for (const q of used) {
    const rs = valuesOn(q, rows);
    const cs = valuesOn(q, cols);
    for (const r of rs) {
      const row = rowAt.get(r) as number;
      rowTotals[row] = (rowTotals[row] as number) + 1;
      const rowCells = cells[row] as number[];
      for (const c of cs) {
        const col = colAt.get(c) as number;
        rowCells[col] = (rowCells[col] as number) + 1;
      }
    }
    for (const c of cs) {
      const col = colAt.get(c) as number;
      colTotals[col] = (colTotals[col] as number) + 1;
    }
  }
  return { rows, cols, rowLabels, colLabels, cells, rowTotals, colTotals, total: used.length };
}

/** One value an axis takes in a bank, and how many questions have it. */
export interface Facet {
  value: string;
  count: number;
}

/** Every axis with the values it takes and how many questions have each, to build the choices of a filter. */
export function facets(questions: readonly Question[], options: CoverageOptions = {}): Record<CoverageAxis, Facet[]> {
  const used = counted(questions, options);
  const out = {} as Record<CoverageAxis, Facet[]>;
  for (const axis of COVERAGE_AXES) {
    const counts = new Map<string, number>();
    for (const q of used) for (const v of valuesOn(q, axis)) counts.set(v, (counts.get(v) ?? 0) + 1);
    out[axis] = ordered(axis, counts.keys()).map((value) => ({ value, count: counts.get(value) as number }));
  }
  return out;
}

/** A question that has every value asked for. `NONE` asks for a question that has no value on that axis. */
export function matchesFacets(question: Question, filters: Partial<Record<CoverageAxis, string>>): boolean {
  for (const [axis, wanted] of Object.entries(filters) as Array<[CoverageAxis, string]>) {
    if (wanted === undefined || wanted === "") continue;
    if (!valuesOn(question, axis).includes(wanted)) return false;
  }
  return true;
}

export function isCoverageAxis(value: string): value is CoverageAxis {
  return (COVERAGE_AXES as readonly string[]).includes(value);
}
