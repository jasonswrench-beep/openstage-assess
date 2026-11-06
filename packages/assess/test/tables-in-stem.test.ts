/**
 * A data table inside a question's text.
 *
 * A table in a Word file that is none of the question layouts (a table of scores in a statistics question, a schedule, the results of
 * an experiment) used to be read cell by cell into lines of text, so its rows and columns were lost. When it is a grid, two or more
 * rows and a row of two or more cells, and it lies inside a question's text and is not the table the question stands in, it is now
 * kept as a table of the question. A table that is not a grid, or whose cells are read as something else (options laid out in a
 * grid), is read as it always was and the question says so. The documents here come from our own writer; real Word wrote tables for
 * `npm run check:word-authored`.
 */

import { describe, test } from "node:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

import { documentToBlocks } from "../src/import/docx/document.ts";
import { openDocx } from "../src/import/docx/package.ts";
import { standardTextImporter } from "../src/import/standard-text.ts";
import { wordImporter } from "../src/import/word.ts";
import { exportGift } from "../src/export/gift.ts";
import { exportMoodleXml } from "../src/export/moodle-xml.ts";
import { exportOpenStageSpreadsheet } from "../src/export/openstage-spreadsheet.ts";
import { layoutTest, printOptions } from "../src/print/index.ts";
import { FindingCode, verdictFrom } from "../src/model/findings.ts";
import type { Question } from "../src/model/question.ts";
import { collectRefs, richTextToPlain, type RichText } from "../src/model/richtext.ts";
import { readTableHtml, replaceTables, tablesIn } from "../src/model/table.ts";
import { docx, paragraph, run } from "./support/docx-writer.ts";
import { drawing, pictureParts, png } from "./support/images.ts";

const OPTIONS = { file: "t.docx", at: "2026-01-01T00:00:00.000Z", author: "test" };

interface Cell {
  text?: string;
  /** More than one paragraph in the cell. */
  lines?: string[];
  /** The XML of the paragraphs, for a cell that holds an equation or a picture. */
  xml?: string;
  span?: number;
}
interface Row {
  header?: boolean;
  cells: Array<string | Cell>;
}

/** A table the way Word writes one, with the rows and cells given. */
function grid(rows: Row[]): string {
  const columns = Math.max(...rows.map((r) => r.cells.length));
  const body = rows
    .map((r) => {
      const cells = r.cells
        .map((c) => {
          const cell: Cell = typeof c === "string" ? { text: c } : c;
          const span = cell.span ?? 1;
          const inner = cell.xml ?? (cell.lines ?? [cell.text ?? ""]).map((t) => paragraph(t === "" ? "" : run(t))).join("");
          return `<w:tc><w:tcPr><w:tcW w:w="${2400 * span}" w:type="dxa"/>${span > 1 ? `<w:gridSpan w:val="${span}"/>` : ""}</w:tcPr>${inner}</w:tc>`;
        })
        .join("");
      return `<w:tr>${r.header ? "<w:trPr><w:tblHeader/></w:trPr>" : ""}${cells}</w:tr>`;
    })
    .join("");
  return `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/></w:tblPr><w:tblGrid>${'<w:gridCol w:w="2400"/>'.repeat(columns)}</w:tblGrid>${body}</w:tbl>`;
}

const q = (text: string): string => paragraph(run(text));
const OPTIONS_AND_KEY = [q("a) 80"), q("b) 85"), q("c) 90"), q("Answer: b")];
const SCORES: Row[] = [{ cells: ["Student", "Score"] }, { cells: ["Ana", "80"] }, { cells: ["Ben", "90"] }];

function read(parts: string[], extra: Parameters<typeof pictureParts>[0] = []) {
  const bytes = docx({ body: parts.join(""), ...pictureParts(extra) });
  const pkg = openDocx(bytes);
  return { result: wordImporter.parseBytes(bytes, OPTIONS), read: documentToBlocks(pkg.xml(pkg.mainDocument)!) };
}
const questionOf = (parts: string[], extra?: Parameters<typeof pictureParts>[0]): Question => read(parts, extra).result.questions[0] as Question;
const flattened = (question: Question) => question.findings.filter((f) => f.code === FindingCode.TableFlattened);

describe("a data table in a stem", () => {
  const made = read([q("1. Use the table to find the mean of the scores."), grid(SCORES), ...OPTIONS_AND_KEY, q("2. Next question?"), q("a) Yes"), q("b) No"), q("Answer: a")]);
  const first = made.result.questions[0] as Question;

  test("is a table of the question, between the words round it, and the question reads as parsed", () => {
    assert.equal(
      first.stem.content,
      "<p>Use the table to find the mean of the scores.</p><table><tbody><tr><td>Student</td><td>Score</td></tr><tr><td>Ana</td><td>80</td></tr><tr><td>Ben</td><td>90</td></tr></tbody></table>",
    );
    assert.equal(flattened(first).length, 0);
    assert.equal(verdictFrom(first.findings), "parsed");
    assert.equal(made.result.questions.length, 2);
  });

  test("leaves the options and the key as they were read, with nothing guessed", () => {
    const body = first.body as { options: Array<{ correct?: boolean; content: RichText }> };
    assert.deepEqual(body.options.map((o) => richTextToPlain(o.content)), ["80", "85", "90"]);
    assert.deepEqual(body.options.map((o) => o.correct === true), [false, true, false]);
  });

  test("is counted as a table that was kept, once, in the file's own findings, and the words are not an orphan", () => {
    assert.deepEqual(made.result.orphans, []);
    const said = made.result.fileFindings.filter((f) => f.code === FindingCode.TableLayout && /kept as a table/.test(f.message));
    assert.equal(said.length, 1);
    assert.match(said[0]?.message ?? "", /^1 table inside the text of a question was kept as a table/);
    assert.equal(said[0]?.severity, "info");
  });

  test("reads as words with the cells apart, for search and for the title", () => {
    assert.equal(richTextToPlain(first.stem), "Use the table to find the mean of the scores.\nStudent Score\nAna 80\nBen 90");
    assert.equal(first.title, "Use the table to find the mean of the scores.");
  });

  test("the question after it is untouched", () => {
    assert.equal(richTextToPlain((made.result.questions[1] as Question).stem), "Next question?");
  });
});

describe("where the table stands in the stem", () => {
  test("words before and after it are paragraphs round it", () => {
    const question = questionOf([q("1. Use the table below"), grid(SCORES), q("to find the mean."), ...OPTIONS_AND_KEY]);
    assert.match(question.stem.content, /^<p>Use the table below<\/p><table>.*<\/table><p>to find the mean\.<\/p>$/);
  });

  test("two tables in one stem are two tables", () => {
    const question = questionOf([q("1. Compare the two tables."), grid(SCORES), grid([{ cells: ["Week", "Hours"] }, { cells: ["1", "4"] }]), ...OPTIONS_AND_KEY]);
    assert.equal((question.stem.content.match(/<table>/g) ?? []).length, 2);
    assert.equal(flattened(question).length, 0);
  });
});

describe("what the table's cells hold", () => {
  test("a row that Word marks as a header is the head of the table, and its cells are header cells", () => {
    const question = questionOf([q("1. Read the table."), grid([{ header: true, cells: ["Student", "Score"] }, { cells: ["Ana", "80"] }]), ...OPTIONS_AND_KEY]);
    assert.match(question.stem.content, /<table><thead><tr><th scope="col">Student<\/th><th scope="col">Score<\/th><\/tr><\/thead><tbody><tr><td>Ana<\/td><td>80<\/td><\/tr><\/tbody><\/table>/);
  });

  test("a first row that only looks like a header is not made one", () => {
    const question = questionOf([q("1. Read the table."), grid(SCORES), ...OPTIONS_AND_KEY]);
    assert.doesNotMatch(question.stem.content, /<th|<thead/);
  });

  test("a cell that spans columns keeps its span", () => {
    const question = questionOf([q("1. Read the table."), grid([{ cells: [{ text: "Results", span: 2 }] }, { cells: ["Ana", "80"] }]), ...OPTIONS_AND_KEY]);
    assert.match(question.stem.content, /<tr><td colspan="2">Results<\/td><\/tr><tr><td>Ana<\/td><td>80<\/td><\/tr>/);
  });

  test("a cell of several paragraphs has them one under another, and an empty cell is empty", () => {
    const question = questionOf([q("1. Read the table."), grid([{ cells: [{ lines: ["Ana", "(first)"] }, ""] }, { cells: ["Ben", "90"] }]), ...OPTIONS_AND_KEY]);
    assert.match(question.stem.content, /<tr><td>Ana<br>\(first\)<\/td><td><\/td><\/tr>/);
  });

  test("words that look like markup are words, and nothing in a cell can open a tag", () => {
    const question = questionOf([q("1. Read the table."), grid([{ cells: ["x < 5 & y > 2", "<script>alert(1)</script>"] }, { cells: ["a", "b"] }]), ...OPTIONS_AND_KEY]);
    assert.match(question.stem.content, /<td>x &lt; 5 &amp; y &gt; 2<\/td><td>&lt;script&gt;alert\(1\)&lt;\/script&gt;<\/td>/);
    assert.doesNotMatch(question.stem.content, /<script/);
  });

  test("an equation in a cell is an equation of the question, placed in the cell", () => {
    const equation = `<m:oMath><m:r><m:t>x</m:t></m:r></m:oMath>`;
    const question = questionOf([q("1. Read the table."), grid([{ cells: [{ xml: paragraph(equation) }, "1"] }, { cells: ["y", "2"] }]), ...OPTIONS_AND_KEY]);
    assert.equal(question.math.length, 1);
    assert.match(question.stem.content, /<td><oa-math ref="q1_e1"><\/oa-math><\/td>/);
    assert.deepEqual(collectRefs(question.stem).math, ["q1_e1"]);
  });

  test("a picture in a cell is a picture of the question, placed in the cell", () => {
    const blue = png(40, 30);
    const question = questionOf(
      [q("1. Read the table."), grid([{ cells: [{ xml: paragraph(`<w:r>${drawing("rId10", { alt: "A blue square" })}</w:r>`) }, "1"] }, { cells: ["y", "2"] }]), ...OPTIONS_AND_KEY],
      [{ rId: "rId10", part: "word/media/image1.png", bytes: blue }],
    );
    assert.equal(question.media.length, 1);
    assert.match(question.stem.content, /<td><oa-media ref="q1_m1"><\/oa-media><\/td>/);
  });
});

describe("a table that is not kept as a table", () => {
  const stays = (rows: Row[], expectCells: number) => {
    const question = questionOf([q("1. Read the table."), grid(rows), ...OPTIONS_AND_KEY]);
    assert.doesNotMatch(question.stem.content, /<table/);
    assert.equal(flattened(question).length, 1, "the question says its rows and columns were not kept");
    assert.match(flattened(question)[0]?.message ?? "", new RegExp(`as ${expectCells} lines of text`));
    assert.equal(verdictFrom(question.findings), "needsReview");
    return question;
  };

  test("a table of one column", () => {
    stays([{ cells: ["Scores"] }, { cells: ["Ana 80"] }, { cells: ["Ben 90"] }], 3);
  });

  test("a table of one row", () => {
    stays([{ cells: ["Ana", "80"] }], 2);
  });

  test("a table with a table inside a cell: the one inside is a grid and is kept, and the outer is read cell by cell and says so", () => {
    const inner = grid([{ cells: ["p", "q"] }, { cells: ["r", "s"] }]);
    const question = questionOf([q("1. Read the table."), grid([{ cells: [{ xml: inner + paragraph() }, "x"] }, { cells: ["y", "z"] }]), ...OPTIONS_AND_KEY]);
    assert.equal((question.stem.content.match(/<table>/g) ?? []).length, 1, "only the grid inside is a table of the question");
    assert.match(question.stem.content, /<td>p<\/td><td>q<\/td>/);
    assert.match(question.stem.content, /<p>x<br>y<br>z<\/p>$/, "the words of the outer table are there, one to a line");
    assert.equal(flattened(question).length, 1);
    assert.match(flattened(question)[0]?.message ?? "", /as 4 lines of text/);
  });

  test("a table laid out as options is read as the options it holds, as it always was", () => {
    const question = questionOf([q("1. What is the mean?"), grid([{ cells: ["a) 80", "b) 85"] }, { cells: ["c) 90", "d) 95"] }]), q("Answer: b")]);
    assert.doesNotMatch(question.stem.content, /<table/);
    assert.deepEqual((question.body as { options: Array<{ content: RichText }> }).options.map((o) => richTextToPlain(o.content)), ["80", "85", "90", "95"]);
  });

  test("a table whose cells hold a question's number is not a table inside a stem", () => {
    const question = questionOf([q("1. Read the table."), grid([{ cells: ["Student", "2. Score"] }, { cells: ["Ana", "80"] }]), ...OPTIONS_AND_KEY]);
    assert.doesNotMatch(question.stem.content, /<table/);
  });
});

describe("a question that stands in a table", () => {
  test("is not turned into a table: its words are the table's", () => {
    const standing = read([
      grid([{ cells: ["1. Which colour is the sky?", "Notes"] }, { cells: ["a) Blue", ""] }, { cells: ["b) Red", ""] }, { cells: ["Answer: a", ""] }]),
    ]);
    assert.equal(standing.read.stats.tablesPlain + Object.values(standing.read.stats.tableLayouts).reduce((a, b) => a + b, 0), 1);
    const question = standing.result.questions[0] as Question | undefined;
    assert.ok(question, "the question was read");
    assert.doesNotMatch((question as Question).stem.content, /<table/);
    assert.equal(richTextToPlain((question as Question).stem).startsWith("Which colour is the sky?"), true);
  });
});

describe("the reader's own account of a table", () => {
  test("a grid is kept beside the blocks by its number, and a table that is a layout or too big is not", () => {
    const { read: document } = read([q("1. Read the table."), grid(SCORES), ...OPTIONS_AND_KEY]);
    assert.deepEqual([...document.tables.keys()], [0]);
    const table = document.tables.get(0);
    assert.deepEqual(table?.rows.map((r) => r.cells.map((c) => c.text)), [["Student", "Score"], ["Ana", "80"], ["Ben", "90"]]);
    const wide = read([q("1. Read the table."), grid(Array.from({ length: 101 }, (_, i) => ({ cells: [`r${i}`, "x"] }))), ...OPTIONS_AND_KEY]);
    assert.equal(wide.read.tables.size, 0, "a table past a hundred rows is a document's data");
    assert.doesNotMatch((wide.result.questions[0] as Question).stem.content, /<table/);
  });
});

describe("the table markup helpers", () => {
  const html = "<p>a</p><table><tbody><tr><td>1</td><td>2</td></tr></tbody></table><p>b</p><table><tr><td>x</td></tr></table>";

  test("find each top-level table, replace it, and keep a table inside a table with its outer one", () => {
    assert.deepEqual(tablesIn(html).length, 2);
    assert.equal(replaceTables(html, (_t, i) => `[${i}]`), "<p>a</p>[0]<p>b</p>[1]");
    const nested = "<table><tr><td><table><tr><td>in</td></tr></table></td></tr></table>";
    assert.equal(tablesIn(nested).length, 1);
    assert.equal(replaceTables(`x${nested}y`, () => "#"), "x#y");
  });

  test("a table that is never closed runs to the end, and none is dropped", () => {
    assert.equal(replaceTables("a<table><tr><td>1", () => "#"), "a#");
    assert.equal(replaceTables("a</table>b", () => "#"), "a</table>b");
  });

  test("read into rows and cells, or into words only when it holds another table", () => {
    const view = readTableHtml(tablesIn(html)[0] as string);
    assert.deepEqual(view.rows.map((r) => r.map((c) => c.text)), [["1", "2"]]);
    assert.equal(view.text, "1 | 2");
    const nested = readTableHtml("<table><tr><td><table><tr><td>in</td></tr></table></td></tr></table>");
    assert.deepEqual(nested.rows, []);
    assert.match(nested.text, /in/);
    assert.deepEqual(readTableHtml('<table><tr><th colspan="2" scope="col">H</th></tr></table>').rows[0], [{ header: true, text: "H", colspan: 2, rowspan: 1 }]);
  });
});

// What real Word wrote (`npm run check:word-tables`, which also asks Word what each table is and found no disagreement), read on any
// machine. The fixtures are the documents Word saved.
describe("tables as real Word writes them", () => {
  const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "fixtures", "word-authored", "tables");
  const wordWrote = (name: string): Question[] => wordImporter.parseBytes(new Uint8Array(readFileSync(join(dir, `${name}.docx`))), OPTIONS).questions as Question[];
  const names = existsSync(dir) ? readdirSync(dir).filter((n) => n.endsWith(".docx")).map((n) => n.slice(0, -5)) : [];

  test("the fixtures are there", () => {
    assert.deepEqual(names.sort(), ["tables-cell-paragraphs", "tables-data", "tables-header", "tables-merged", "tables-one-column"]);
  });

  test("a table of scores is a table of the question, and the question after it is untouched", () => {
    const [first, second] = wordWrote("tables-data");
    assert.equal((first as Question).stem.content, "<p>Use the table to find the mean of the scores.</p><table><tbody><tr><td>Student</td><td>Score</td></tr><tr><td>Ana</td><td>80</td></tr><tr><td>Ben</td><td>90</td></tr></tbody></table>");
    assert.equal(verdictFrom((first as Question).findings), "parsed");
    assert.equal(richTextToPlain((second as Question).stem), "What is two plus two?");
  });

  test("a row Word marks as a header is the head of the table", () => {
    const [first] = wordWrote("tables-header");
    assert.match((first as Question).stem.content, /<thead><tr><th scope="col">Student<\/th><th scope="col">Score<\/th><\/tr><\/thead><tbody><tr><td>Ana<\/td>/);
  });

  test("two cells that Word joined are one cell that spans two columns", () => {
    const [first] = wordWrote("tables-merged");
    assert.match((first as Question).stem.content, /<tr><td colspan="2">Results<\/td><\/tr><tr><td>Ana<\/td><td>80<\/td><\/tr>/);
  });

  test("a cell of two paragraphs is one cell, one under the other", () => {
    const [first] = wordWrote("tables-cell-paragraphs");
    assert.match((first as Question).stem.content, /<td>Ana<br>\(first\)<\/td><td>80<\/td>/);
  });

  test("a table of one column is not a grid: it is read cell by cell, and the question says so", () => {
    const [first] = wordWrote("tables-one-column");
    assert.doesNotMatch((first as Question).stem.content, /<table/);
    assert.equal(flattened(first as Question).length, 1);
  });

  test("none of the questions lost its key", () => {
    for (const name of names) for (const question of wordWrote(name)) assert.ok(!question.findings.some((f) => f.code === FindingCode.NoAnswerKey), name);
  });
});

describe("a table of the question, printed and exported", () => {
  const made = (): Question => {
    const text = [q("1. Use the table to find the mean."), grid(SCORES), ...OPTIONS_AND_KEY];
    return read(text).result.questions[0] as Question;
  };

  test("is printed as lines, a row to a line with the cells between bars, and the question's report says so", () => {
    const layout = layoutTest([made()], printOptions({ title: "Quiz", kind: "student" }));
    const lines = layout.document.blocks.map((b) => (b.kind === "para" ? b.runs.map((r) => r.text).join("") : ""));
    assert.ok(lines.some((l) => l === "Student | Score"), lines.join(" / "));
    assert.ok(lines.some((l) => l === "Ana | 80"));
    assert.match(layout.report.items[0]?.notes.join("\n") ?? "", /1 table printed as lines of text/);
  });

  test("goes into Moodle XML and GIFT, which carry markup, as a table", () => {
    const question = made();
    assert.match(exportMoodleXml([question]).files[0]?.content as string, /<table><tbody><tr><td>Student<\/td><td>Score<\/td><\/tr>/);
    assert.match(exportGift([question]).files[0]?.content as string, /<table><tbody><tr><td>Student<\/td>/);
  });

  test("becomes words in a format with no table, and the export says tables became plain text", () => {
    const result = exportOpenStageSpreadsheet([made()]);
    assert.match(JSON.stringify(result.report), /tables? (in the text )?became plain text|lists or tables became plain text/);
  });
});

describe("a tag typed into a text file", () => {
  test("names no table, so it is only text and is left as written", () => {
    const typed = standardTextImporter.parse('1. See [ tbl: "3" ] below.\na) One\nb) Two\nAnswer: a\n', OPTIONS).questions[0] as Question;
    assert.equal(richTextToPlain(typed.stem), 'See [ tbl: "3" ] below.');
  });
});

describe("tables of every shape (seeded)", () => {
  // A table's cells are whatever a person typed, so a run of random tables with awkward words in them is held to what the table is
  // for: one table of the question, every cell's words in its place, nothing that can open a tag, and a key that is still there.
  const WORDS = ["x < 5", "a & b", "<b>bold</b>", "say \"hi\"", "it's", "ünï", "\u{1F600}", "50%", "", "  spaced  out  ", "line one", "H2O", "a > b", "&amp;", "tab\there"];
  const squash = (text: string): string => text.replace(/\s+/g, " ").trim();

  test("keeps every cell where it was, with no markup made of its words", () => {
    let seed = 20261107;
    const next = (n: number): number => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed % n;
    };
    for (let run = 0; run < 150; run++) {
      const rows = 2 + next(4);
      const columns = 2 + next(3);
      const made: Row[] = Array.from({ length: rows }, (_, r) => ({
        header: r === 0 && next(3) === 0,
        cells: Array.from({ length: r === 0 ? columns : 1 + next(columns) }, () => WORDS[next(WORDS.length)] as string),
      }));
      const parts = [q("1. Use the table below."), grid(made), ...OPTIONS_AND_KEY];
      const question = questionOf(parts);
      const html = question.stem.content;
      assert.equal((html.match(/<table>/g) ?? []).length, 1, `run ${run}: one table\n${html}`);
      assert.doesNotMatch(html, /<(script|img|b)\b/i, `run ${run}: no tag made of a cell's words`);
      const view = readTableHtml(tablesIn(html)[0] as string);
      assert.deepEqual(
        view.rows.map((row) => row.map((c) => squash(c.text))),
        made.map((row) => row.cells.map((c) => squash(typeof c === "string" ? c : (c.text ?? "")))),
        `run ${run}`,
      );
      assert.ok(!question.findings.some((f) => f.code === FindingCode.NoAnswerKey), `run ${run}: the key was lost`);
      assert.equal(flattened(question).length, 0, `run ${run}`);
    }
  });
});
