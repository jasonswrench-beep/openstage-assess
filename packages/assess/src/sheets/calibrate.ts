/**
 * Setting the fill lines on real paper: a real-sheet corpus read against what the volunteers wrote down, the lines tried on one half
 * of it, and what they do reported on the other half, which they were not fitted to.
 *
 * The lines in decide.ts (0.5 for a filled bubble, 0.1 for an empty one, 0.06 for an empty one on a question with several answers) were
 * chosen on drawn sheets. Real graphite on a real scanner may read lighter, and only real sheets can say so. This module never changes
 * them: it proposes lines, and a person writes them into decide.ts in a commit that names the corpus, because a line moved by a program
 * is a line nobody chose (`CLAUDE.md`: changed only on numbers from the gate and real sheets).
 *
 * What a volunteer wrote down is the truth here, never what the reader saw. A question is judged at the version the volunteer wrote
 * down (or, where they did not, the one the sheet's own code gives), and the version bubble is judged as an answer of its own, so a
 * line that makes the version bubble unsure does not hide what the same line does to the questions.
 *
 * The first rule is the gate's: a line set that reads one answer wrong without a flag, or reads a marked answer as blank (which a
 * person who accepts blanks would not look at), is not a candidate, however few flags it raises.
 */

import { decideQuestion, decideVersion, LINES, type FillLines } from "./decide.ts";
import { layoutFor, placeName, VERSION_LABELS } from "./geometry.ts";
import type { SlotUse } from "./plan.ts";
import type { SheetReader, SheetResult } from "./read.ts";

/** What a volunteer wrote down for one question: the places marked ([] for left blank), or a mark meant to be neither. */
export type Expected = number[] | "unclear";

export type CorpusSource = "scan" | "photo";

/** One page of the corpus, with what the volunteer wrote down and what the reader made of the picture. */
export interface CorpusPage {
  /** Where the page came from, for the report: the file and the page in it. */
  where: string;
  /** The volunteer sheet the page belongs to, so the pages of one sheet fall in the same half. */
  sheet: string;
  source: CorpusSource;
  /** Free words for how the page was made ("copier 300 grey, #2 pencil firm"). The report is broken down by it. */
  condition: string;
  /** The version the volunteer filled in, from 1, when they wrote it down. */
  version?: number;
  answers: Map<number, Expected>;
  reading: SheetResult;
}

/** One row of the answer list, before its picture is read. */
export interface ListRow {
  line: number;
  file: string;
  page: number;
  sheet: string;
  source: CorpusSource;
  condition: string;
  version?: number;
  answers: Map<number, Expected>;
}

export interface ListProblem {
  line: number;
  message: string;
}

/** The lines tried, and the step between them. Kept within what a mark and clean paper could ever be. */
export const SEARCH: Readonly<{ filled: readonly [number, number]; blank: readonly [number, number]; blankMultiple: readonly [number, number]; step: number }> = Object.freeze({ filled: [0.3, 0.8] as const, blank: [0.03, 0.25] as const, blankMultiple: [0.02, 0.25] as const, step: 0.01 });

/** Fewer plain answers than this in the half the lines are tried on, and no lines are proposed: a handful of sheets says little. */
export const LEAST_TO_TUNE = 200;

/** The targets of docs/paper-tests-spec.md. */
export const TARGETS = Object.freeze({ scanFlagged: 0.01, photoFlagged: 0.05, refused: 0.02 });

const LIST_COLUMNS = ["file", "page", "sheet", "source", "condition", "version"] as const;

/** A cell of a CSV: quoted when it holds a comma, a quote or a line end, as a spreadsheet writes it. */
const csvCell = (text: string): string => (/[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text);

/**
 * The header of an answer list for a test of `questions` questions, to hand to the volunteers. With `pages` (the pictures already
 * read, as the app has them), a row for each with its file and page filled in and the rest left for the person: the source is left
 * empty on purpose, so a row nobody filled in is refused rather than read as a scan with every question blank.
 */
export function listTemplate(questions: number, pages?: ReadonlyArray<{ file: string; page: number }>): string {
  const head = [...LIST_COLUMNS, ...Array.from({ length: questions }, (_x, i) => String(i + 1))];
  const blanks = Array.from({ length: questions }, () => "");
  const rows = pages && pages.length > 0 ? pages.map((p) => [p.file, String(p.page), "", "", "", "", ...blanks]) : [["sheet-01.pdf", "1", "Ana 1", "scan", "copier 300 grey - #2 pencil", "A", ...blanks]];
  return `${[head, ...rows].map((r) => r.map(csvCell).join(",")).join("\n")}\n`;
}

/**
 * Reads an answer list (rows of cells, the first the names). A cell that cannot be read is a problem with its line, and the row is
 * not used: a guess at what a volunteer meant would make the truth the reader is judged on a guess.
 */
export function readList(rows: readonly (readonly string[])[]): { rows: ListRow[]; problems: ListProblem[] } {
  const problems: ListProblem[] = [];
  const out: ListRow[] = [];
  const [head, ...body] = rows;
  if (!head) return { rows: out, problems: [{ line: 1, message: "The answer list is empty. Its first row names the columns: file, page, sheet, source, condition, version, then 1, 2, 3 for each question." }] };
  const names = head.map((h) => h.trim().toLowerCase());
  const at = (name: string): number => names.indexOf(name);
  if (at("file") < 0) problems.push({ line: 1, message: "The answer list has no file column, so its rows cannot be matched to pictures." });
  if (at("source") < 0) problems.push({ line: 1, message: "The answer list has no source column (scan or photo), and the two have different targets." });
  const questionColumns: Array<{ column: number; number: number }> = [];
  names.forEach((name, column) => {
    if ((LIST_COLUMNS as readonly string[]).includes(name) || name === "") return;
    const number = /^[0-9]{1,4}$/.test(name) ? Number(name) : NaN;
    if (Number.isInteger(number) && number >= 1) questionColumns.push({ column, number });
    else problems.push({ line: 1, message: `The column "${head[column]}" is neither one of ${LIST_COLUMNS.join(", ")} nor a question number, so it is not read.` });
  });
  if (questionColumns.length === 0) problems.push({ line: 1, message: "The answer list names no question: after the first columns come 1, 2, 3 and on, one for each question." });
  if (problems.some((p) => p.line === 1 && /no file|no source|names no question/.test(p.message))) return { rows: out, problems };

  body.forEach((cells, i) => {
    const line = i + 2;
    const cell = (name: string): string => (at(name) >= 0 ? (cells[at(name)] ?? "").trim() : "");
    if (cells.every((c) => c.trim() === "")) return;
    const file = cell("file");
    if (!file) return void problems.push({ line, message: "This row names no file." });
    const pageText = cell("page") || "1";
    const page = /^[0-9]{1,4}$/.test(pageText) ? Number(pageText) : NaN;
    if (!Number.isInteger(page) || page < 1) return void problems.push({ line, message: `The page "${pageText}" is not a page number.` });
    const sourceText = cell("source").toLowerCase();
    if (sourceText !== "scan" && sourceText !== "photo") return void problems.push({ line, message: `The source "${cell("source")}" is neither scan nor photo.` });
    const versionText = cell("version").toUpperCase();
    let version: number | undefined;
    if (versionText) {
      const v = (VERSION_LABELS as readonly string[]).indexOf(versionText);
      if (v < 0) return void problems.push({ line, message: `The version "${cell("version")}" is not A, B, C or D.` });
      version = v + 1;
    }
    const answers = new Map<number, Expected>();
    for (const { column, number } of questionColumns) {
      const raw = (cells[column] ?? "").trim().toUpperCase().replace(/[\s,]+/g, "");
      if (raw === "?") {
        answers.set(number, "unclear");
        continue;
      }
      if (!/^[A-H]*$/.test(raw)) return void problems.push({ line, message: `Question ${number} says "${cells[column]}": write the letters marked (B, or AC for two), leave it empty for a question left blank, or ? for a mark meant to be unclear.` });
      const places = [...new Set([...raw].map((c) => c.charCodeAt(0) - 65))].sort((a, b) => a - b);
      answers.set(number, places);
    }
    // A row with no sheet named is the file's sheet, so the pages of one file stay together (by the page, they were dealt apart).
    out.push({ line, file, page, sheet: cell("sheet") || file, source: sourceText, condition: cell("condition") || "(no condition given)", version, answers });
  });
  return { rows: out, problems };
}

/** Everything a line set is judged on, worked out once from the corpus. */
interface Judged {
  page: number;
  where: string;
  number: number;
  fills: number[];
  use: SlotUse | undefined;
  registered: boolean;
  bilevel: boolean;
  expected: Expected;
  multiple: boolean;
}

interface VersionJudged {
  page: number;
  where: string;
  fills: number[];
  expected: number;
}

export interface Tally {
  pages: number;
  refused: number;
  refusals: Record<string, number>;
  /** Questions judged: every question with a column in the list, on a page that was read. */
  questions: number;
  /** Plain answers (one or more letters) the volunteers marked. */
  answers: number;
  right: number;
  /** Left blank, and read as blank: right, and confirmed by a person unless blanks are accepted. */
  blankRight: number;
  /** A plain answer flagged for a person. */
  answersFlagged: number;
  /** A left-blank question with something flagged on it (a smudge, a stray mark). */
  blanksFlagged: number;
  /** A mark meant to be unclear, flagged or read as blank: what should happen. */
  unclearFlagged: number;
  /** A plain answer read as blank. Not a wrong answer on its own, but a person who accepts blanks would not see it. */
  missed: number;
  /** Read as an answer that is not what the volunteer marked: the failure. */
  wrong: number;
  version: { right: number; flagged: number; wrong: number };
  cases: string[];
}

const emptyTally = (): Tally => ({ pages: 0, refused: 0, refusals: {}, questions: 0, answers: 0, right: 0, blankRight: 0, answersFlagged: 0, blanksFlagged: 0, unclearFlagged: 0, missed: 0, wrong: 0, version: { right: 0, flagged: 0, wrong: 0 }, cases: [] });

const letters = (places: readonly number[]): string => (places.length ? places.map(placeName).join("") : "blank");

/** The questions and version bubbles of the corpus, ready to be decided again under any lines. */
function prepare(pages: readonly CorpusPage[], reader: SheetReader): { judged: Judged[]; versions: VersionJudged[]; unjudged: string[] } {
  const judged: Judged[] = [];
  const versions: VersionJudged[] = [];
  const unjudged: string[] = [];
  pages.forEach((p, page) => {
    const r = p.reading;
    if (!r.ok) return;
    const planned = reader.plan(r.code.paper, r.code.large);
    if (!planned.ok) return void unjudged.push(`${p.where}: ${planned.reason}`);
    const plan = planned.plan;
    const layout = layoutFor(r.code.paper, plan.style);
    if (r.versionSource === "bubble" && p.version !== undefined && r.versionFills) versions.push({ page, where: p.where, fills: r.versionFills, expected: p.version });
    const version = p.version ?? (r.versionSource === "bubble" ? undefined : r.version);
    if (version === undefined) return void unjudged.push(`${p.where}: the list gives no version and the sheet leaves it to a bubble, so its questions are not judged`);
    if (r.versionSource !== "bubble" && r.version !== undefined && p.version !== undefined && r.version !== p.version) {
      return void unjudged.push(`${p.where}: the list says version ${VERSION_LABELS[p.version - 1]} and the sheet was printed for ${VERSION_LABELS[r.version - 1]}; check the list`);
    }
    const uses = plan.uses[VERSION_LABELS[version - 1] as (typeof VERSION_LABELS)[number]];
    const first = (r.code.page - 1) * layout.questionsPerPage;
    for (let slot = 0; slot < layout.questionsPerPage; slot++) {
      const index = first + slot;
      if (index >= plan.drawn.length) break;
      const number = index + 1;
      const expected = p.answers.get(number);
      if (expected === undefined) continue;
      const fills = r.fills[number] ?? [];
      const use = uses?.[index];
      if (fills.length === 0 || !use || use.places === 0) continue;
      judged.push({ page, where: p.where, number, fills, use, registered: !r.unregistered.includes(number), bilevel: r.quality.bilevel, expected, multiple: use.kind === "multiple" });
    }
  });
  return { judged, versions, unjudged };
}

function judgeQuestion(t: Tally, j: Judged, lines: Readonly<FillLines>, cases: boolean): void {
  const d = decideQuestion(j.fills, j.use, j.registered, j.bilevel, lines);
  t.questions++;
  const e = j.expected;
  const plain = e !== "unclear" && e.length > 0;
  if (plain) t.answers++;
  if (d.status === "answered") {
    if (plain && d.marked.length === e.length && d.marked.every((m, i) => m === e[i])) t.right++;
    else {
      t.wrong++;
      if (cases) t.cases.push(`${j.where}: question ${j.number} read as ${letters(d.marked)}, the volunteer's was ${e === "unclear" ? "an unclear mark" : letters(e)} (fills ${j.fills.map((f) => f.toFixed(2)).join(" ")})`);
    }
  } else if (d.status === "blank") {
    if (e === "unclear") t.unclearFlagged++;
    else if (plain) {
      t.missed++;
      if (cases) t.cases.push(`${j.where}: question ${j.number} read as blank, the volunteer marked ${letters(e)} (fills ${j.fills.map((f) => f.toFixed(2)).join(" ")})`);
    } else t.blankRight++;
  } else if (d.status === "flagged") {
    if (e === "unclear") t.unclearFlagged++;
    else if (plain) t.answersFlagged++;
    else t.blanksFlagged++;
  }
}

function judgeVersion(t: Tally, v: VersionJudged, lines: Readonly<FillLines>, cases: boolean): void {
  const d = decideVersion(v.fills, lines);
  if (d.version === undefined) t.version.flagged++;
  else if (d.version === v.expected) t.version.right++;
  else {
    t.version.wrong++;
    if (cases) t.cases.push(`${v.where}: version read as ${VERSION_LABELS[d.version - 1]}, the volunteer marked ${VERSION_LABELS[v.expected - 1]} (fills ${v.fills.map((f) => f.toFixed(2)).join(" ")})`);
  }
}

/** What a line set does to the pages listed (by their place in the corpus). */
function tallyOf(pages: readonly CorpusPage[], prepared: ReturnType<typeof prepare>, take: (page: number) => boolean, lines: Readonly<FillLines>): Tally {
  const t = emptyTally();
  pages.forEach((p, i) => {
    if (!take(i)) return;
    t.pages++;
    if (!p.reading.ok) {
      t.refused++;
      t.refusals[p.reading.cause] = (t.refusals[p.reading.cause] ?? 0) + 1;
    }
  });
  for (const j of prepared.judged) if (take(j.page)) judgeQuestion(t, j, lines, true);
  for (const v of prepared.versions) if (take(v.page)) judgeVersion(t, v, lines, true);
  return t;
}

/** Whether a line set may be proposed at all: nothing read wrong, no marked answer read as blank, no version read wrong. */
const safe = (t: Pick<Tally, "wrong" | "missed" | "version">): boolean => t.wrong === 0 && t.missed === 0 && t.version.wrong === 0;
/** What a line set costs a person: every flag on something plain. */
const cost = (t: Pick<Tally, "answersFlagged" | "blanksFlagged" | "version">): number => t.answersFlagged + t.blanksFlagged + t.version.flagged;

const range = (low: number, high: number, step: number): number[] => {
  const out: number[] = [];
  for (let k = 0; Math.round((low + k * step) * 1000) <= Math.round(high * 1000); k++) out.push(Math.round((low + k * step) * 1000) / 1000);
  return out;
};

/**
 * The safe lines that raise the fewest flags on the pages given, and among those the nearest to the lines in use. The search is split,
 * since the line for several answers is used only by questions with several answers: for each pair of the other two, the questions
 * with one answer and the version bubbles are decided once, and the questions with several answers once for each line of their own.
 */
function search(prepared: ReturnType<typeof prepare>, take: (page: number) => boolean): { lines: FillLines; cost: number } | undefined {
  const single = prepared.judged.filter((j) => !j.multiple && take(j.page));
  const several = prepared.judged.filter((j) => j.multiple && take(j.page));
  const versions = prepared.versions.filter((v) => take(v.page));
  const distance = (l: FillLines): number => Math.abs(l.filled - LINES.filled) + Math.abs(l.blank - LINES.blank) + Math.abs(l.blankMultiple - LINES.blankMultiple);
  let best: { lines: FillLines; cost: number; distance: number } | undefined;
  for (const filled of range(SEARCH.filled[0], SEARCH.filled[1], SEARCH.step)) {
    for (const blank of range(SEARCH.blank[0], SEARCH.blank[1], SEARCH.step)) {
      if (blank >= filled) continue;
      const base = emptyTally();
      for (const j of single) judgeQuestion(base, j, { filled, blank, blankMultiple: blank }, false);
      for (const v of versions) judgeVersion(base, v, { filled, blank, blankMultiple: blank }, false);
      if (!safe(base)) continue;
      for (const blankMultiple of range(SEARCH.blankMultiple[0], Math.min(SEARCH.blankMultiple[1], blank), SEARCH.step)) {
        const lines = { filled, blank, blankMultiple };
        const more = emptyTally();
        for (const j of several) judgeQuestion(more, j, lines, false);
        if (!safe(more)) continue;
        const c = cost(base) + cost(more);
        const d = distance(lines);
        if (!best || c < best.cost || (c === best.cost && d < best.distance - 1e-9)) best = { lines, cost: c, distance: d };
      }
    }
  }
  return best && { lines: best.lines, cost: best.cost };
}

export interface FillSpread {
  n: number;
  p5: number;
  p50: number;
  p95: number;
  least: number;
  most: number;
}

export interface ConditionReport {
  condition: string;
  source: CorpusSource;
  pages: number;
  refused: number;
  /** The fill of every bubble a volunteer marked as a plain answer. */
  marked: FillSpread;
  /** The fill of every bubble a volunteer left empty, on a question they answered plainly or left blank. */
  empty: FillSpread;
  /** Under the lines in use. */
  now: Tally;
}

export interface CalibrationReport {
  lines: FillLines;
  pages: number;
  /** Which half each page fell in: the lines are tried on the first and reported on the second. */
  halves: { tune: number; report: number };
  /** The lines in use, on each half and by source. */
  now: { tune: Tally; report: Tally; scan: Tally; photo: Tally };
  /** The lines proposed from the first half, and what they do on the second. Absent when there were too few answers or no safe lines. */
  proposed?: { lines: FillLines; tune: Tally; report: Tally; scan: Tally; photo: Tally };
  /** Why nothing is proposed, when it is not. */
  noProposal?: string;
  conditions: ConditionReport[];
  unjudged: string[];
  /** Plain sentences about the targets of the specification, under the lines in use and, where there are some, the proposed ones. */
  targets: string[];
}

const spread = (values: number[]): FillSpread => {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (p: number): number => (sorted.length ? (sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] as number) : 0);
  return { n: sorted.length, p5: at(0.05), p50: at(0.5), p95: at(0.95), least: sorted[0] ?? 0, most: sorted[sorted.length - 1] ?? 0 };
};

/**
 * The halves: the volunteer sheets are taken in the order the list first names them and dealt out in turn, so every page of one sheet,
 * under every condition it was scanned or photographed in, is in the same half. The same marks read on a copier and on a phone are
 * not two samples: dealt within each condition, one sheet's marks fell in both halves (and a missing photo shifted every sheet after
 * it), and the half the lines were judged on held marks they were fitted to.
 */
export function halvesOf(pages: readonly CorpusPage[]): boolean[] {
  const sheetHalf = new Map<string, boolean>();
  return pages.map((p) => {
    let half = sheetHalf.get(p.sheet);
    if (half === undefined) {
      half = sheetHalf.size % 2 === 0;
      sheetHalf.set(p.sheet, half);
    }
    return half;
  });
}

export function calibrate(pages: readonly CorpusPage[], reader: SheetReader): CalibrationReport {
  const prepared = prepare(pages, reader);
  const tuneHalf = halvesOf(pages);
  const inTune = (i: number): boolean => tuneHalf[i] === true;
  const inReport = (i: number): boolean => tuneHalf[i] === false;
  const ofSource = (s: CorpusSource) => (i: number): boolean => pages[i]?.source === s;
  const now = { tune: tallyOf(pages, prepared, inTune, LINES), report: tallyOf(pages, prepared, inReport, LINES), scan: tallyOf(pages, prepared, ofSource("scan"), LINES), photo: tallyOf(pages, prepared, ofSource("photo"), LINES) };

  let proposed: CalibrationReport["proposed"];
  let noProposal: string | undefined;
  if (now.tune.answers < LEAST_TO_TUNE) {
    noProposal = `The half the lines are tried on holds ${now.tune.answers} marked answer${now.tune.answers === 1 ? "" : "s"}, and at least ${LEAST_TO_TUNE} are needed before a line is moved.`;
  } else {
    const found = search(prepared, inTune);
    if (!found) noProposal = "No lines in the range tried read every answer of the first half right or flagged it. Look at the cases read wrong: a mark that reads darker than an empty bubble on the same page is a fault no line can fix.";
    else {
      const l = found.lines;
      const reportHalf = tallyOf(pages, prepared, inReport, l);
      proposed = { lines: l, tune: tallyOf(pages, prepared, inTune, l), report: reportHalf, scan: tallyOf(pages, prepared, ofSource("scan"), l), photo: tallyOf(pages, prepared, ofSource("photo"), l) };
      if (!safe(reportHalf)) noProposal = "The lines fitted to the first half read answers of the second half wrong or as blank, so they are not safe to use: the corpus is too small or too uneven. They are shown, and should not be written into decide.ts.";
    }
  }

  const conditions: ConditionReport[] = [];
  const names = [...new Set(pages.map((p) => `${p.source}\u0000${p.condition}`))];
  for (const key of names) {
    const [source, condition] = key.split("\u0000") as [CorpusSource, string];
    const take = (i: number): boolean => pages[i]?.source === source && pages[i]?.condition === condition;
    const marked: number[] = [];
    const empty: number[] = [];
    for (const j of prepared.judged) {
      if (!take(j.page) || j.expected === "unclear") continue;
      const e = j.expected;
      j.fills.slice(0, j.use?.places ?? 0).forEach((f, place) => (e.includes(place) ? marked : empty).push(f));
    }
    const t = tallyOf(pages, prepared, take, LINES);
    conditions.push({ condition, source, pages: t.pages, refused: t.refused, marked: spread(marked), empty: spread(empty), now: t });
  }

  const targets: string[] = [];
  const say = (label: string, lines: { scan: Tally; photo: Tally; report: Tally }): void => {
    const all = [lines.scan, lines.photo];
    const wrong = all.reduce((s, t) => s + t.wrong + t.version.wrong, 0);
    targets.push(`${label}: ${wrong === 0 ? "no answer read wrong without a flag (the gate's first line holds)" : `${wrong} answer${wrong === 1 ? "" : "s"} read wrong without a flag: the gate fails`}.`);
    const missed = all.reduce((s, t) => s + t.missed, 0);
    if (missed > 0) targets.push(`${label}: ${missed} marked answer${missed === 1 ? " was" : "s were"} read as blank, which a person who accepts blanks would not see.`);
    for (const [name, t, target] of [["scans", lines.scan, TARGETS.scanFlagged], ["photos", lines.photo, TARGETS.photoFlagged]] as const) {
      if (t.answers === 0) continue;
      const rate = (t.answersFlagged + t.missed) / t.answers;
      targets.push(`${label}, ${name}: ${(rate * 100).toFixed(1)} percent of marked answers flagged or read blank (the target is ${target * 100} percent or fewer): ${rate <= target ? "met" : "not met"}.`);
    }
  };
  say("The lines in use", now);
  if (proposed && !noProposal) say("The proposed lines", proposed);
  const pagesAll = pages.length;
  const scansRefused = pages.filter((p) => p.source === "scan" && !p.reading.ok).length;
  const scans = pages.filter((p) => p.source === "scan").length;
  if (scans > 0) targets.push(`Scans refused: ${scansRefused} of ${scans} (${((100 * scansRefused) / scans).toFixed(1)} percent; the target is ${TARGETS.refused * 100} percent or fewer): ${scansRefused / scans <= TARGETS.refused ? "met" : "not met"}.`);

  return { lines: { ...LINES }, pages: pagesAll, halves: { tune: tuneHalf.filter(Boolean).length, report: tuneHalf.filter((h) => !h).length }, now, proposed, noProposal, conditions, unjudged: prepared.unjudged, targets };
}

const linesText = (l: FillLines): string => `filled ${l.filled.toFixed(2)}, empty ${l.blank.toFixed(2)}, empty with several answers ${l.blankMultiple.toFixed(2)}`;
const tallyText = (t: Tally): string =>
  `${t.questions} questions (${t.answers} marked): right ${t.right + t.blankRight}, flagged ${t.answersFlagged + t.blanksFlagged + t.unclearFlagged} (${t.answersFlagged} on a marked answer), read blank ${t.missed}, WRONG AND NOT FLAGGED ${t.wrong}; version bubble right ${t.version.right}, flagged ${t.version.flagged}, WRONG ${t.version.wrong}`;
const spreadText = (s: FillSpread): string => (s.n === 0 ? "none" : `${s.n}: least ${s.least.toFixed(2)}, 5th ${s.p5.toFixed(2)}, median ${s.p50.toFixed(2)}, 95th ${s.p95.toFixed(2)}, most ${s.most.toFixed(2)}`);

export function formatCalibration(r: CalibrationReport): string {
  const lines: string[] = [];
  lines.push(`${r.pages} pages; the lines are tried on ${r.halves.tune} and reported on the other ${r.halves.report}.`);
  lines.push(`The lines in use: ${linesText(r.lines)}.`);
  lines.push(`  first half:  ${tallyText(r.now.tune)}`);
  lines.push(`  second half: ${tallyText(r.now.report)}`);
  if (r.proposed) {
    lines.push(`Proposed from the first half: ${linesText(r.proposed.lines)}.`);
    lines.push(`  first half:  ${tallyText(r.proposed.tune)}`);
    lines.push(`  second half: ${tallyText(r.proposed.report)}`);
  }
  if (r.noProposal) lines.push(`No lines are proposed: ${r.noProposal}`);
  else if (r.proposed) lines.push("These are a proposal. A person writes them into packages/assess/src/sheets/decide.ts, runs npm test and sheets gate, and says in the commit which corpus they came from.");
  lines.push("By condition, under the lines in use (fill of the bubbles volunteers marked, and of those they left empty):");
  for (const c of r.conditions) {
    lines.push(`  ${c.source}, ${c.condition}: ${c.pages} page${c.pages === 1 ? "" : "s"}, ${c.refused} refused`);
    lines.push(`    marked ${spreadText(c.marked)}`);
    lines.push(`    empty  ${spreadText(c.empty)}`);
    lines.push(`    ${tallyText(c.now)}`);
  }
  for (const t of r.targets) lines.push(t);
  for (const u of r.unjudged) lines.push(`Not judged: ${u}`);
  const cases = [...r.now.tune.cases, ...r.now.report.cases];
  for (const c of cases.slice(0, 20)) lines.push(`  ${c}`);
  if (cases.length > 20) lines.push(`  and ${cases.length - 20} more`);
  return lines.join("\n");
}
