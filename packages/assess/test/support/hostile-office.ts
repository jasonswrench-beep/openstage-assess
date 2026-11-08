/**
 * Word and Excel files that are a few kilobytes and ask a great deal, and a way to read one in a process of its own under a time limit
 * and a memory limit. A reader who went looking for a count, a step or a repeated word in an office file that the reader trusts found a
 * style that is based on the next one 20,000 times, a list that starts at 1e12, a cell of 130,000 paragraphs, a shared string named by
 * every cell of a table and two sheets that are one part. A return of any of these faults fails a test here and does not hold every
 * test after it, and does not take this process's memory with it.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { textEntry, zipSync } from "../../src/container/zip.ts";
import { docx, level, abstractNum, num, numberingPart, paragraph, run, table, listProperties } from "./docx-writer.ts";

export interface ChildResult {
  /** The status the child ended with; null when it was killed for taking too long. */
  status: number | null;
  stdout: string;
  stderr: string;
  /** The child was stopped by the time limit. */
  timedOut: boolean;
  ms: number;
  /** The most memory the child held at once, in megabytes, when it ended by itself. */
  rssMb: number | undefined;
}

export interface ChildOptions {
  timeoutMs?: number;
  /** The most the child's heap may hold, in megabytes, so that a reader that fills memory ends the child and not the machine. */
  heapMb?: number;
}

/**
 * Runs `body` (module code that can use `bytes`, a Uint8Array of the file, and imports of the engine by `await engine("path")`) in a
 * node process of its own with a time limit, so that a reader that never returns is a failed test and not a frozen one.
 */
export function inChild(bytes: Uint8Array, body: string, options: ChildOptions = {}): ChildResult {
  const dir = mkdtempSync(join(tmpdir(), "openassess-hostile-office-"));
  try {
    const file = join(dir, "input.bin");
    writeFileSync(file, bytes);
    const src = new URL("../../src/", import.meta.url).href;
    const script =
      `import { readFileSync } from "node:fs"; const bytes = new Uint8Array(readFileSync(process.argv[1])); const engine = (p) => import(${JSON.stringify(src)} + p);\n` +
      `process.on("exit", () => process.stderr.write("\\nMAXRSS " + Math.round(process.resourceUsage().maxRSS / 1024) + "\\n"));\n${body}`;
    const flags = ["--experimental-strip-types", "--no-warnings", ...(options.heapMb ? [`--max-old-space-size=${options.heapMb}`] : []), "--input-type=module", "-e", script, file];
    const started = Date.now();
    const ran = spawnSync(process.execPath, flags, { encoding: "utf8", timeout: options.timeoutMs ?? 20_000, maxBuffer: 64 * 1024 * 1024 });
    const stderr = ran.stderr ?? "";
    const rss = /MAXRSS (\d+)/.exec(stderr);
    return { status: ran.status, stdout: ran.stdout ?? "", stderr, timedOut: ran.error !== undefined, ms: Date.now() - started, rssMb: rss ? Number(rss[1]) : undefined };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export interface WordRead {
  /** The reader ended in a message, or in a crash that is not one. */
  refused?: string;
  questions?: number;
  orphans?: number;
  /** The first orphan's length, to show a long run of text came through whole. */
  orphanLength?: number;
  findings?: string[];
  /** How many blocks the file made and which table layouts were read, by `docxToBlocks`. */
  blocks?: number;
  layouts?: Record<string, number>;
  unreadLists?: Record<string, number>;
  listItems?: number;
}

/**
 * A Word file read as the importer reads it, in a child. The result is what the child found; a crash or a time-out is in `child`.
 * With `importer: false` the file is read as far as its blocks and no further: a question of 130,000 lines is a stem the scanner
 * after the Word reader takes a long time over (it joins the stem for each line), which is a fault of another reader's.
 */
export function readWordInChild(bytes: Uint8Array, options: ChildOptions & { importer?: boolean } = {}): { child: ChildResult; read: WordRead | undefined } {
  const child = inChild(
    bytes,
    `const { wordImporter } = await engine("import/word.ts");
     const { openDocx } = await engine("import/docx/package.ts");
     const { documentToBlocks } = await engine("import/docx/document.ts");
     const { readNumbering } = await engine("import/docx/numbering.ts");
     const { readFormatting } = await engine("import/docx/formatting.ts");
     try {
       const r = ${options.importer ?? true} ? wordImporter.parseBytes(bytes, { file: "t.docx", at: "2026-01-01T00:00:00.000Z", author: "test" }) : undefined;
       // The same file again, for what the importer does not hand back: the layouts of its tables, the lists it could not number.
       const pkg = openDocx(bytes);
       const part = (kind, fallback) => { const name = pkg.related(kind) ?? fallback; return pkg.has(name) ? pkg.xml(name) : undefined; };
       const d = documentToBlocks(pkg.xml(pkg.mainDocument), readNumbering({ numbering: part("numbering", "word/numbering.xml"), styles: part("styles", "word/styles.xml") }), readFormatting(part("styles", "word/styles.xml")));
       console.log(JSON.stringify({ questions: r?.questions.length, orphans: r?.orphans.length, orphanLength: r?.orphans[0]?.text.length ?? 0, findings: r?.fileFindings.map((f) => f.message), blocks: d.blocks.length, layouts: d.stats.tableLayouts, unreadLists: d.stats.unreadLists, listItems: d.stats.listItems }));
     } catch (e) { console.log(JSON.stringify({ refused: String(e && e.message) })); }`,
    options,
  );
  return { child, read: child.status === 0 && !child.timedOut && child.stdout.trim() !== "" ? (JSON.parse(child.stdout.trim().split("\n").pop() as string) as WordRead) : undefined };
}

export interface TableRead {
  refused?: string;
  /** Per sheet: its rows, and the longest cell. */
  sheets?: Array<{ rows: number; longest: number; cells: number }>;
  notes?: string[];
  questions?: number;
  orphans?: number;
  findings?: string[];
}

/** A workbook read as a table (`readXlsx`) and then as questions (`spreadsheetImporter`), in a child. */
export function readTableInChild(bytes: Uint8Array, options: ChildOptions & { importer?: boolean } = {}): { child: ChildResult; read: TableRead | undefined } {
  const importer = options.importer ?? false;
  const child = inChild(
    bytes,
    `const { readXlsx } = await engine("import/table-xlsx.ts");
     const { spreadsheetImporter } = await engine("import/spreadsheet.ts");
     try {
       const t = readXlsx(bytes);
       const out = { sheets: t.sheets.map((s) => ({ rows: s.rows.length, longest: s.rows.reduce((m, r) => r.cells.reduce((n, c) => Math.max(n, c.length), m), 0), cells: s.rows.reduce((n, r) => n + r.cells.length, 0) })), notes: t.notes.map((n) => n.message) };
       if (${importer}) { const r = spreadsheetImporter.parseBytes(bytes, { file: "t.xlsx", at: "2026-01-01T00:00:00.000Z", author: "test" }); out.questions = r.questions.length; out.orphans = r.orphans.length; out.findings = r.fileFindings.map((f) => f.message); }
       console.log(JSON.stringify(out));
     } catch (e) { console.log(JSON.stringify({ refused: String(e && e.message) })); }`,
    options,
  );
  return { child, read: child.status === 0 && !child.timedOut && child.stdout.trim() !== "" ? (JSON.parse(child.stdout.trim().split("\n").pop() as string) as TableRead) : undefined };
}

// ---------------------------------------------------------------------------
// Word files
// ---------------------------------------------------------------------------

/** One run with `n` text elements in it, and no run properties: the text elements each used to look the run's properties up again. */
export const manyTextDocx = (n: number): Uint8Array => docx({ body: `<w:p><w:r>${"<w:t>a</w:t>".repeat(n)}</w:r></w:p>` });

/**
 * `styles` paragraph styles, each based on the next; the first is the default style, so every paragraph begins at the top of the chain.
 * With `each`, paragraph k is in style k instead, and the last style of the chain is bold: every paragraph's look is found at the far
 * end of a chain of a different length.
 */
export function styleChainDocx(styles: number, paragraphs: number, options: { numbered?: boolean; loop?: boolean; each?: boolean } = {}): Uint8Array {
  let xml = "";
  for (let i = 0; i < styles; i++) {
    const basedOn = i + 1 < styles ? `s${i + 1}` : options.loop ? "s0" : undefined;
    xml +=
      `<w:style w:type="paragraph"${i === 0 ? ' w:default="1"' : ""} w:styleId="s${i}"><w:name w:val="s${i}"/>` +
      (basedOn ? `<w:basedOn w:val="${basedOn}"/>` : "") +
      (options.numbered ? '<w:pPr><w:numPr><w:numId w:val="1"/></w:numPr></w:pPr>' : "") +
      (options.each && i + 1 === styles ? "<w:rPr><w:b/></w:rPr>" : "") +
      "</w:style>";
  }
  let body = "";
  for (let k = 0; k < paragraphs; k++) body += paragraph(run("What is the capital of France?"), options.each ? `<w:pStyle w:val="s${k % styles}"/>` : "");
  return docx({
    body,
    styles: xml,
    ...(options.numbered ? { numbering: numberingPart([abstractNum(1, [level(0)])], [num(1, 1)]) } : {}),
  });
}

/** A list of one level in `format`, starting at `start`, with `items` paragraphs in it. */
export function listDocx(options: { format?: string; start: number | string; items: number; text?: string; ilvl?: number }): Uint8Array {
  const ilvl = options.ilvl ?? 0;
  const lvl = level(ilvl, { format: options.format ?? "lowerLetter", start: options.start as number, text: options.text ?? `%${ilvl + 1})` });
  return docx({
    body: paragraph(run("What is the capital of France?"), listProperties({ numId: 1, level: ilvl })).repeat(options.items),
    numbering: numberingPart([abstractNum(1, [lvl])], [num(1, 1)]),
  });
}

const many = (text: string, n: number): string => paragraph(run(text)).repeat(n);

/** A table whose layout is one of the readers' and whose cell holds `n` paragraphs, where the reader used to spread them into a call. */
export function bigCellDocx(layout: "numbered extras" | "numbered content" | "grid stem" | "grid option" | "grid strays" | "labelled only" | "labelled rest" | "key", n: number): Uint8Array {
  const p = (text: string): string => paragraph(run(text));
  switch (layout) {
    case "numbered content":
      // Two cells: the number (with the page it is from under it, which the labelled-rows layout refuses), and everything else of the question.
      return docx({ body: table([[p("1.") + p("(p. 230)"), p("What is the capital of France?") + many("filler", n)]]) });
    case "numbered extras":
      // The number's own cell holds `n` lines under the number.
      return docx({ body: table([[p("1.") + many("note", n), p("What is the capital of France?")]]) });
    case "grid stem":
      return docx({ body: table([[p("No"), p("Question"), p("A"), p("B"), p("Answer")], [p("1"), p("What is the capital of France?") + many("filler", n), p("Paris"), p("Rome"), p("A")]]) });
    case "grid option":
      return docx({ body: table([[p("No"), p("Question"), p("A"), p("B"), p("Answer")], [p("1"), p("What is the capital of France?"), p("Paris") + many("filler", n), p("Rome"), p("A")]]) });
    case "grid strays": {
      // A column the profile does not know is not dropped: one stray line for each, and a row can have a hundred thousand.
      const head = [p("Question"), p("A"), p("B"), ...Array.from({ length: n }, () => p("Notes"))];
      const row = [p("What is the capital of France?"), p("Paris"), p("Rome"), ...Array.from({ length: n }, () => p("x"))];
      return docx({ body: table([head, row], false) });
    }
    case "labelled only":
      // A row with one cell that holds words: its lines are passed on, and the table has a labelled row below.
      return docx({ body: table([[p("1."), p("What is the capital of France?")], [p("a."), p("Paris")], [many("filler", n), p("")]]) });
    case "labelled rest":
      return docx({ body: table([[p("1."), p("What is the capital of France?") + many("filler", n)], [p("a."), p("Paris")]]) });
    case "key": {
      // Written out here and not with `table`, which hands all its rows to Math.max.
      let rows = "";
      for (let i = 0; i < n; i++) rows += `<w:tr><w:tc>${p(`${(i % 9999) + 1}.`)}</w:tc><w:tc>${p("A")}</w:tc></w:tr>`;
      return docx({ body: `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/></w:tblPr><w:tblGrid><w:gridCol w:w="2400"/><w:gridCol w:w="2400"/></w:tblGrid>${rows}</w:tbl>` });
    }
  }
}

/** A paragraph in the second cell of a numbered-cells table with `n` runs that alternate bold and plain, so none of them merges with the next. */
export function manyRunsInCellDocx(n: number): Uint8Array {
  let runs = "";
  for (let i = 0; i < n; i++) runs += i % 2 === 0 ? "<w:r><w:rPr><w:b/></w:rPr><w:t>x</w:t></w:r>" : "<w:r><w:t>y</w:t></w:r>";
  return docx({ body: table([[paragraph(run("1.")) + paragraph(run("(p. 230)")), `<w:p>${runs}</w:p>`]]) });
}

/** An equation whose one run holds `n` signs: each is a part, and they were handed to a call all at once. */
export const longEquationDocx = (n: number): Uint8Array =>
  docx({ body: paragraph(run("What is it? ") + `<m:oMath><m:r><m:t>${"+".repeat(n)}</m:t></m:r></m:oMath>`) });

/** `n` empty paragraphs: a node each, and a block each once read. */
export const emptyParagraphsDocx = (n: number): Uint8Array => docx({ body: "<w:p/>".repeat(n) });

// ---------------------------------------------------------------------------
// Excel files
// ---------------------------------------------------------------------------

const NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

export interface WorkbookSpec {
  /** The XML of each sheet part, `xl/worksheets/sheetN.xml`. */
  sheets: string[];
  /** The text of each shared string. */
  shared?: string[];
  /** Further `<sheet>` entries that name sheet part number N (counting from 1) again. */
  again?: number[];
  /** Further relationships of the workbook (id and target), which a `<sheet>` entry can name by `entries`. */
  relationships?: Array<{ id: string; target: string }>;
  /** Further `<sheet>` entries, by the relationship id each names. */
  entries?: string[];
}

/** A workbook with the parts a reader looks for and nothing else, with the sheets and strings given. */
export function workbook(spec: WorkbookSpec): Uint8Array {
  const entries: Array<{ name: string; id: string }> = [
    ...spec.sheets.map((_, i) => ({ name: `Sheet${i + 1}`, id: `rId${i + 1}` })),
    ...(spec.again ?? []).map((part, i) => ({ name: `Again${i + 1}`, id: `rId${part}` })),
    ...(spec.entries ?? []).map((id, i) => ({ name: `Entry${i + 1}`, id })),
  ];
  const relationships = (spec.relationships ?? []).map((r) => `<Relationship Id="${r.id}" Type="${REL}/worksheet" Target="${r.target}"/>`).join("");
  return zipSync([
    textEntry("_rels/.rels", `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`),
    textEntry("xl/workbook.xml", `<workbook xmlns="${NS}" xmlns:r="${REL}"><sheets>${entries.map((e, i) => `<sheet name="${e.name}" sheetId="${i + 1}" r:id="${e.id}"/>`).join("")}</sheets></workbook>`),
    textEntry(
      "xl/_rels/workbook.xml.rels",
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${spec.sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="${REL}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("")}${relationships}<Relationship Id="rIdS" Type="${REL}/sharedStrings" Target="sharedStrings.xml"/></Relationships>`,
    ),
    textEntry("xl/sharedStrings.xml", `<sst xmlns="${NS}">${(spec.shared ?? []).map((s) => `<si><t>${s}</t></si>`).join("")}</sst>`),
    ...spec.sheets.map((xml, i) => textEntry(`xl/worksheets/sheet${i + 1}.xml`, xml)),
  ]);
}

export const sheetXml = (rows: string): string => `<worksheet xmlns="${NS}"><sheetData>${rows}</sheetData></worksheet>`;

/** The name of a column: A, B, ... Z, AA. */
export function columnLetters(index: number): string {
  let n = index + 1;
  let out = "";
  while (n > 0) {
    out = String.fromCharCode(65 + ((n - 1) % 26)) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

const inline = (ref: string, text: string): string => `<c r="${ref}" t="inlineStr"><is><t>${text}</t></is></c>`;
const shared = (ref: string, index: number): string => `<c r="${ref}" t="s"><v>${index}</v></c>`;

/** A question table of `rows` rows where Question, A and B all name the one shared string (index 0), which is `chars` characters long. */
export function sharedStringTable(rows: number, chars: number): Uint8Array {
  let body = `<row r="1">${inline("A1", "Type")}${inline("B1", "Question")}${inline("C1", "A")}${inline("D1", "B")}${inline("E1", "Correct")}</row>`;
  for (let r = 2; r <= rows + 1; r++) body += `<row r="${r}">${inline(`A${r}`, "MC")}${shared(`B${r}`, 0)}${shared(`C${r}`, 0)}${shared(`D${r}`, 0)}${inline(`E${r}`, "A")}</row>`;
  return workbook({ sheets: [sheetXml(body)], shared: ["lorem ipsum ".repeat(Math.ceil(chars / 12)).slice(0, chars)] });
}

/** `rows` rows of `columns` cells each, every cell naming the shared string 0 (of `chars` characters), as the first rows of a sheet are the names of the columns. */
export function sharedStringHeaders(rows: number, columns: number, chars: number): Uint8Array {
  let body = "";
  for (let r = 1; r <= rows; r++) {
    let cells = "";
    for (let c = 0; c < columns; c++) cells += shared(`${columnLetters(c)}${r}`, 0);
    body += `<row r="${r}">${cells}</row>`;
  }
  // A cell that begins like a name with a description, and then goes on: a search for a name has to read the cell to find the end of it.
  const text = ("Answer - x - x - x - x - x - x - x - x - " + "word ".repeat(Math.ceil(chars / 5))).slice(0, chars);
  return workbook({ sheets: [sheetXml(body)], shared: [text] });
}

/** `rows` rows with a single cell each, in column `column` (counting from 0), so that each row is `column + 1` places wide. */
export function wideRows(rows: number, column: number): string {
  let body = "";
  const letters = columnLetters(column);
  for (let r = 1; r <= rows; r++) body += `<row r="${r}"><c r="${letters}${r}"><v>1</v></c></row>`;
  return sheetXml(body);
}
