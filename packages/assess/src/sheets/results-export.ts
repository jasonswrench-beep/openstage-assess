/**
 * The results, as a spreadsheet the instructor takes to their own gradebook, and the item analysis as a page to print.
 *
 * The workbook has a sheet of scores (one row to a sheet of paper: its number, its version, an empty Name column for the instructor to fill
 * in, each answer as the letters marked, the score, the possible and the percentage), the key of each version, the adjustments with how many
 * sheets each changed, and the item statistics. A CSV of the scores alone is written beside it for a gradebook that wants a plain file. The
 * Name column is empty on purpose: names are never read, and are not kept (see scores-file.ts).
 *
 * The item analysis is one page with a block for each question, as it was printed, and its figures. The page is plain HTML with its own
 * print style, so it can be opened in any browser and printed or saved as a PDF; everything shown is escaped, since the question's own
 * words go into it.
 */

import { writeXlsx, type XlsxCell, type XlsxSheet } from "../container/xlsx.ts";
import { safeName } from "../export/text.ts";
import { richTextToPlain } from "../model/richtext.ts";
import { isChoice, isMultipleResponse, isTrueFalse, type Question } from "../model/question.ts";
import { placeLetter, VERSION_LABELS, versionQuestions, type TestRecord, type VersionLabel } from "../model/test.ts";
import { versionKey } from "../quality/test-key.ts";
import { adjustmentEffect, adjustmentWords, scoreSheets, type Adjustment, type SettledSheet, type SheetScore } from "./score.ts";
import type { TestStatistics } from "./stats.ts";

export interface ResultsExport {
  xlsx: Uint8Array;
  /** The scores sheet as a CSV, UTF-8 with a byte order mark and CRLF line ends, as Excel opens it. */
  csv: string;
  /** A name for the files, with no extension. */
  base: string;
}

const letters = (places: readonly number[]): string => places.map(placeLetter).join("");
const clip = (text: string, n: number): string => (text.length > n ? `${text.slice(0, n - 1).trimEnd()}...` : text);
const stemOf = (q: Question): string => clip(richTextToPlain(q.stem).replace(/\s+/g, " ").trim(), 90);

function scoreRows(record: TestRecord, scores: readonly SheetScore[], settled: readonly SettledSheet[]): XlsxCell[][] {
  const most = Math.max(1, ...record.versions.map(() => record.questions.length));
  const header: XlsxCell[] = ["Sheet", "Version", "Name", ...Array.from({ length: most }, (_x, i) => `${i + 1}`), "Earned", "Possible", "Percent", "Settled"];
  const rows: XlsxCell[][] = [header];
  scores.forEach((s, i) => {
    const sheet = settled[i] as SettledSheet;
    const cells: XlsxCell[] = [];
    for (let q = 1; q <= most; q++) {
      const a = sheet.answers[q];
      const outcome = s.questions[q - 1]?.outcome;
      cells.push(outcome === "notOnSheet" ? "-" : !a ? "" : a.kind === "marked" ? letters(a.places) : a.kind === "unsettled" ? "?" : "");
    }
    rows.push([s.number, s.version !== undefined ? (VERSION_LABELS[s.version - 1] as string) : "?", "", ...cells, s.earned, s.possible, s.percent !== undefined ? Math.round(s.percent * 10) / 10 : "", s.complete ? "Yes" : `No: ${s.unsettled} question${s.unsettled === 1 ? "" : "s"} not settled${s.problems.length ? `; ${s.problems.join(" ")}` : ""}`]);
  });
  return rows;
}

const csvCell = (v: XlsxCell): string => {
  const text = v === null || v === undefined ? "" : String(v);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

export function exportResults(record: TestRecord, settled: readonly SettledSheet[], adjustments: readonly Adjustment[], stats: TestStatistics, date: string): ResultsExport {
  const scores = scoreSheets(record, settled, adjustments);
  const rows = scoreRows(record, scores, settled);

  const keyRows: XlsxCell[][] = [["Question", "Points", ...record.versions.map((v) => `Version ${v.label}`)]];
  const keys = record.versions.map((v) => versionKey(record, v.label));
  const first = versionQuestions(record, "A");
  first.forEach((q, i) => {
    keyRows.push([i + 1, q.points, ...keys.map((k) => {
      const e = k[i];
      return e?.letters ? e.letters.join("") : `(${e?.reason ?? "none"})`;
    })]);
  });

  const adjustmentRows: XlsxCell[][] = [["Question", "Adjustment", "Versions", "Sheets changed", "Note", "Date"]];
  if (adjustments.length === 0) adjustmentRows.push(["", "No adjustments", "", "", "", ""]);
  for (const a of adjustments) {
    // How many sheets it changes, with every other adjustment in force: the scores without it against the scores with it.
    const others = adjustments.filter((x) => x !== a);
    const effect = adjustmentEffect(record, settled, others, a);
    const q = record.questions.find((x) => x.id === a.questionId);
    adjustmentRows.push([q ? `${first.findIndex((x) => x.id === q.id) + 1}. ${stemOf(q)}` : a.questionId, adjustmentWords(a, record), a.versions ? a.versions.map((v) => VERSION_LABELS[v - 1]).join(", ") : "All", effect.changed.length, a.note ?? "", a.at ?? ""]);
  }

  const statRows: XlsxCell[][] = [["Question", "Question text", "Sheets", "Difficulty", "Point-biserial", "Top 27% less bottom 27%", "Blanks", "Answers marked", "Notes"]];
  for (const item of stats.items) {
    const q = record.questions.find((x) => x.id === item.questionId) as Question;
    const labelFor = (answer: string, i: number): string => (answer === "true" ? "True" : answer === "false" ? "False" : placeLetter(i));
    const marked = item.options.map((o, i) => `${labelFor(o.answer, i)} ${o.chosen}${o.correct ? " (right)" : ""}`).join(", ");
    statRows.push([first.findIndex((x) => x.id === q.id) + 1, stemOf(q), item.sheets, item.difficulty ?? "", item.discrimination.pointBiserial ?? "", item.discrimination.upperLower ?? "", item.blanks, marked, item.notes.join(" ")]);
  }
  statRows.push([]);
  statRows.push(["Test", "", "", "", "", "", "", "", ""]);
  statRows.push(["Sheets used", "", stats.sheets]);
  if (stats.leftOut > 0) statRows.push(["Sheets left out", "", stats.leftOut]);
  if (stats.mean !== undefined) statRows.push(["Mean score", "", stats.mean, "", "", "", "", `of ${stats.possible ?? ""}`]);
  if (stats.sd !== undefined) statRows.push(["Standard deviation", "", stats.sd]);
  if (stats.reliability) statRows.push([stats.reliability.kind, "", stats.reliability.value, "", "", "", "", `${stats.reliability.items} questions`]);
  for (const n of stats.notes) statRows.push(["Note", n]);

  const sheets: XlsxSheet[] = [
    { name: "Scores", rows, header: true, widths: [8, 9, 24, ...Array.from({ length: rows[0]!.length - 7 }, () => 5), 8, 9, 9, 40] },
    { name: "Key", rows: keyRows, header: true, widths: [10, 8, ...record.versions.map(() => 14)] },
    { name: "Adjustments", rows: adjustmentRows, header: true, widths: [50, 34, 12, 14, 40, 26] },
    { name: "Item statistics", rows: statRows, header: true, widths: [10, 60, 8, 11, 14, 22, 8, 44, 50] },
  ];
  return {
    xlsx: writeXlsx(sheets),
    csv: `﻿${rows.map((r) => r.map(csvCell).join(",")).join("\r\n")}\r\n`,
    base: `${safeName(record.name, "Test")} - Scores ${date}`,
  };
}

// ---------------------------------------------------------------------------------------------------------------------------
// The item analysis report

const esc = (text: string): string => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const fmt = (v: number | undefined, digits = 2): string => (v === undefined ? "not worked out" : v.toFixed(digits));

/** One page, for printing: a block for each question, as it was printed in version A, with its figures. */
export function itemAnalysisHtml(record: TestRecord, stats: TestStatistics, date: string): string {
  const first = versionQuestions(record, "A" as VersionLabel);
  const blocks = stats.items
    .map((item) => {
      const q = first.find((x) => x.id === item.questionId) as Question;
      const number = first.findIndex((x) => x.id === q.id) + 1;
      const most = Math.max(1, ...item.options.map((o) => o.chosen));
      const answers = isTrueFalse(q)
        ? item.options.map((o) => ({ label: o.answer === "true" ? "True" : "False", text: "", correct: o.correct, chosen: o.chosen }))
        : isChoice(q) || isMultipleResponse(q)
          ? q.body.options.map((o, i) => ({ label: placeLetter(i), text: richTextToPlain(o.content), correct: o.correct, chosen: item.options.find((x) => x.answer === o.id)?.chosen ?? 0 }))
          : [];
      const rows = answers
        .map((a) => `<tr class="${a.correct ? "right" : ""}"><td class="l">${esc(a.label)}${a.correct ? " &#10003;" : ""}</td><td>${esc(a.text)}</td><td class="n">${a.chosen}</td><td class="bar"><span style="width:${Math.round((100 * a.chosen) / most)}%"></span></td></tr>`)
        .join("");
      return `<section class="item"><h2>${number}. ${esc(richTextToPlain(q.stem))}</h2><table class="options">${rows}</table>
<p class="figures">${item.sheets} sheet${item.sheets === 1 ? "" : "s"}. Difficulty ${fmt(item.difficulty)}. Point-biserial ${fmt(item.discrimination.pointBiserial)}. Top 27% less bottom 27% ${fmt(item.discrimination.upperLower)}${item.discrimination.groupSize ? ` (${item.discrimination.groupSize} sheets each)` : ""}. Left blank ${item.blanks}.</p>${item.notes.map((n) => `<p class="note">${esc(n)}</p>`).join("")}</section>`;
    })
    .join("\n");
  const reliability = stats.reliability ? `${esc(stats.reliability.kind)} ${stats.reliability.value.toFixed(2)} (${stats.reliability.items} questions)` : "not worked out";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${esc(record.name)}: item analysis</title>
<style>
body{font:11pt/1.4 Georgia,serif;max-width:46em;margin:2em auto;padding:0 1em;color:#111}
h1{font-size:1.5em;margin:0 0 .2em}h2{font-size:1.05em;margin:0 0 .4em}
.summary{margin:0 0 1.5em;color:#333}
.item{break-inside:avoid;margin:0 0 1.4em;padding-bottom:.8em;border-bottom:1px solid #ccc}
table.options{border-collapse:collapse;width:100%;margin:.2em 0}
td{padding:.15em .5em;vertical-align:top}td.l{width:3.5em;font-weight:bold}td.n{width:2.5em;text-align:right}td.bar{width:30%}
td.bar span{display:block;height:.7em;background:#777}tr.right td.bar span{background:#1a6b2f}
.figures{margin:.4em 0 0;font-size:.95em}.note{margin:.2em 0 0;font-style:italic}
@media print{body{margin:0;max-width:none}}
</style></head><body>
<h1>${esc(record.name)}: item analysis</h1>
<p class="summary">${esc(date)}. ${stats.sheets} sheet${stats.sheets === 1 ? "" : "s"}${stats.mean !== undefined ? `; mean ${stats.mean} of ${stats.possible ?? ""}, standard deviation ${stats.sd}` : ""}. Reliability: ${reliability}.${stats.notes.map((n) => ` ${esc(n)}`).join("")}</p>
${blocks}
</body></html>
`;
}
