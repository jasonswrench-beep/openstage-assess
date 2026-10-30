/**
 * A minimal Word writer, for tests.
 *
 * It makes .docx files so that the Word importer can be measured without a
 * person typing documents. It is deliberately not Word: it writes only what the
 * tests need, in the plainest valid form, and it is NOT evidence that real Word
 * files read correctly. That evidence is the dialect pack and the real chapters
 * (see docs/word-import-plan.md). What this does give is any number of documents
 * whose right answer is known, because they are made from text fixtures that
 * already have expected files.
 *
 * The print export will need to write .docx too, and this is where that code will
 * come from.
 */

import { textEntry, zipSync, type ZipEntry } from "../../src/container/zip.ts";

const NAMESPACES = [
  'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"',
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"',
  'xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"',
  'xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"',
  'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"',
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"',
].join(" ");

const XML_DECLARATION = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';

export function esc(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// ---------------------------------------------------------------------------
// Building blocks
// ---------------------------------------------------------------------------

/** The text of one run. A tab in the text becomes a tab element, as Word writes it. */
export function runContent(text: string): string {
  return text
    .split("\t")
    .map((piece) => (piece === "" ? "" : `<w:t xml:space="preserve">${esc(piece)}</w:t>`))
    .reduce((out, piece, i) => out + (i > 0 ? "<w:tab/>" : "") + piece, "");
}

export function run(text: string, properties = ""): string {
  return `<w:r>${properties ? `<w:rPr>${properties}</w:rPr>` : ""}${runContent(text)}</w:r>`;
}

export function paragraph(inner = "", properties = "", attributes = ""): string {
  return `<w:p${attributes ? ` ${attributes}` : ""}>${properties ? `<w:pPr>${properties}</w:pPr>` : ""}${inner}</w:p>`;
}

/** A table whose cells are given as the XML of the paragraphs in them. */
export function table(rows: string[][]): string {
  const body = rows
    .map((cells) => `<w:tr>${cells.map((cell) => `<w:tc><w:tcPr><w:tcW w:w="2400" w:type="dxa"/></w:tcPr>${cell}</w:tc>`).join("")}</w:tr>`)
    .join("");
  return `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/></w:tblPr><w:tblGrid/>${body}</w:tbl>`;
}

// ---------------------------------------------------------------------------
// Lists and styles
// ---------------------------------------------------------------------------

export interface LevelSpec {
  /** The w:numFmt value. Defaults to decimal. */
  format?: string;
  /** The w:lvlText value, for example "%1." Defaults to "%n." for the level. */
  text?: string;
  start?: number;
  /** The w:lvlRestart value. */
  restart?: number;
  legal?: boolean;
  /** The paragraph style this level is tied to. */
  style?: string;
}

/** One level of a list definition, with its children in the order the schema requires. */
export function level(at: number, spec: LevelSpec = {}): string {
  return (
    `<w:lvl w:ilvl="${at}"><w:start w:val="${spec.start ?? 1}"/><w:numFmt w:val="${spec.format ?? "decimal"}"/>` +
    (spec.restart !== undefined ? `<w:lvlRestart w:val="${spec.restart}"/>` : "") +
    (spec.style ? `<w:pStyle w:val="${spec.style}"/>` : "") +
    (spec.legal ? "<w:isLgl/>" : "") +
    `<w:suff w:val="space"/><w:lvlText w:val="${esc(spec.text ?? `%${at + 1}.`)}"/><w:lvlJc w:val="left"/></w:lvl>`
  );
}

/** A list definition. `extra` goes before the levels (a style link, for instance). */
export function abstractNum(id: number, levels: readonly string[], extra = ""): string {
  const kind = levels.length > 1 ? "multilevel" : "singleLevel";
  return `<w:abstractNum w:abstractNumId="${id}"><w:multiLevelType w:val="${kind}"/>${extra}${levels.join("")}</w:abstractNum>`;
}

export interface NumOverride {
  level: number;
  start?: number;
  /** A whole replacement for the level, from level(). */
  replacement?: string;
}

/** A list instance: a pointer at a definition, with the overrides that restart or reshape it. */
export function num(id: number, definition: number, overrides: readonly NumOverride[] = []): string {
  const inner = overrides
    .map(
      (o) =>
        `<w:lvlOverride w:ilvl="${o.level}">${o.start !== undefined ? `<w:startOverride w:val="${o.start}"/>` : ""}${o.replacement ?? ""}</w:lvlOverride>`,
    )
    .join("");
  return `<w:num w:numId="${id}"><w:abstractNumId w:val="${definition}"/>${inner}</w:num>`;
}

/** The numbering part's content: every definition has to come before every instance. */
export function numberingPart(definitions: readonly string[], instances: readonly string[]): string {
  return definitions.join("") + instances.join("");
}

export interface StyleSpec {
  id: string;
  /** "paragraph" unless it is a numbering style. */
  type?: "paragraph" | "numbering";
  basedOn?: string;
  /** The list and level the style carries. */
  numId?: number;
  level?: number;
  isDefault?: boolean;
}

export function style(spec: StyleSpec): string {
  const numPr =
    spec.numId !== undefined || spec.level !== undefined
      ? `<w:pPr><w:numPr>${spec.level !== undefined ? `<w:ilvl w:val="${spec.level}"/>` : ""}${spec.numId !== undefined ? `<w:numId w:val="${spec.numId}"/>` : ""}</w:numPr></w:pPr>`
      : "";
  return (
    `<w:style w:type="${spec.type ?? "paragraph"}"${spec.isDefault ? ' w:default="1"' : ""} w:styleId="${spec.id}"><w:name w:val="${spec.id}"/>` +
    (spec.basedOn ? `<w:basedOn w:val="${spec.basedOn}"/>` : "") +
    `<w:qFormat/>${numPr}</w:style>`
  );
}

/** The properties of a paragraph in a list, or in a style. The order is the schema's. */
export function listProperties(spec: { style?: string; numId?: number; level?: number }): string {
  return (
    (spec.style ? `<w:pStyle w:val="${spec.style}"/>` : "") +
    (spec.numId !== undefined || spec.level !== undefined
      ? `<w:numPr>${spec.level !== undefined ? `<w:ilvl w:val="${spec.level}"/>` : ""}${spec.numId !== undefined ? `<w:numId w:val="${spec.numId}"/>` : ""}</w:numPr>`
      : "")
  );
}

// ---------------------------------------------------------------------------
// The package
// ---------------------------------------------------------------------------

export interface DocxParts {
  /** The XML of the body, without the section properties. */
  body: string;
  /** The content of word/numbering.xml, from numberingPart(). */
  numbering?: string;
  /** How the document's relationships spell the numbering part's address. Defaults to "numbering.xml". */
  numberingTarget?: string;
  /** Where the numbering part is stored in the package. Defaults to "word/numbering.xml". */
  numberingPath?: string;
  /** The content of word/styles.xml, from style(). */
  styles?: string;
  /** The text of each header and footer, to check that they are never read as content. */
  headers?: string[];
  footers?: string[];
  /** Further parts, such as media, written as they are. */
  extra?: ZipEntry[];
  /** Part names and bytes to leave out, for tests of damaged packages. */
  omit?: string[];
}

export function docx(parts: DocxParts): Uint8Array {
  const headers = parts.headers ?? [];
  const footers = parts.footers ?? [];

  const overrides = [
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>',
    ...(parts.numbering !== undefined
      ? [`<Override PartName="/${parts.numberingPath ?? "word/numbering.xml"}" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>`]
      : []),
    ...(parts.styles !== undefined
      ? ['<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>']
      : []),
    ...headers.map((_, i) => `<Override PartName="/word/header${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/>`),
    ...footers.map((_, i) => `<Override PartName="/word/footer${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>`),
  ].join("");

  const relationships = [
    ...(parts.numbering !== undefined
      ? [`<Relationship Id="rIdN1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="${parts.numberingTarget ?? "numbering.xml"}"/>`]
      : []),
    ...(parts.styles !== undefined
      ? ['<Relationship Id="rIdS1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>']
      : []),
    ...headers.map((_, i) => `<Relationship Id="rIdH${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header${i + 1}.xml"/>`),
    ...footers.map((_, i) => `<Relationship Id="rIdF${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer${i + 1}.xml"/>`),
  ].join("");

  const references = [
    ...headers.map((_, i) => `<w:headerReference w:type="default" r:id="rIdH${i + 1}"/>`),
    ...footers.map((_, i) => `<w:footerReference w:type="default" r:id="rIdF${i + 1}"/>`),
  ].join("");

  const section = `<w:sectPr>${references}<w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr>`;

  const entries: ZipEntry[] = [
    textEntry(
      "[Content_Types].xml",
      `${XML_DECLARATION}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${overrides}</Types>`,
    ),
    textEntry(
      "_rels/.rels",
      `${XML_DECLARATION}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
    ),
    textEntry("word/document.xml", `${XML_DECLARATION}<w:document ${NAMESPACES}><w:body>${parts.body}${section}</w:body></w:document>`),
    textEntry(
      "word/_rels/document.xml.rels",
      `${XML_DECLARATION}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${relationships}</Relationships>`,
    ),
    ...(parts.numbering !== undefined
      ? [textEntry(parts.numberingPath ?? "word/numbering.xml", `${XML_DECLARATION}<w:numbering ${NAMESPACES}>${parts.numbering}</w:numbering>`)]
      : []),
    ...(parts.styles !== undefined ? [textEntry("word/styles.xml", `${XML_DECLARATION}<w:styles ${NAMESPACES}>${parts.styles}</w:styles>`)] : []),
    ...headers.map((text, i) => textEntry(`word/header${i + 1}.xml`, `${XML_DECLARATION}<w:hdr ${NAMESPACES}>${paragraph(run(text))}</w:hdr>`)),
    ...footers.map((text, i) => textEntry(`word/footer${i + 1}.xml`, `${XML_DECLARATION}<w:ftr ${NAMESPACES}>${paragraph(run(text))}</w:ftr>`)),
    ...(parts.extra ?? []),
  ].filter((entry) => !(parts.omit ?? []).includes(entry.name));

  return zipSync(entries);
}

// ---------------------------------------------------------------------------
// From lines of text
// ---------------------------------------------------------------------------

/** A small deterministic generator, so a failure can be reproduced from its seed. */
function random(seed: number) {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    chance: (p: number) => next() < p,
    below: (n: number) => Math.floor(next() * n),
    hex: () => Math.floor(next() * 0xffffffff).toString(16).toUpperCase().padStart(8, "0"),
  };
}

export interface LinesOptions {
  /**
   * Scatter what real Word leaves in a file: each line split into several runs at
   * arbitrary points (even inside "1."), spelling and bookmark marks, empty runs,
   * revision ids, paragraph properties, a hyperlink or a field around some text,
   * deleted text that must never appear, an inserted run that must, and a header
   * and a footer whose text must never be read as content.
   */
  noise?: boolean;
  seed?: number;
  /**
   * Let Word number the question numbers and option letters instead of typing
   * them. The text of every line is the fixture's, less the label Word now shows,
   * so the document must read back as the fixture does.
   */
  numbering?: NumberingOptions;
}

export interface NumberingOptions {
  /**
   * `lists`: a separate one-level list for each kind of label, restarted with a
   * start override wherever the numbers do not simply carry on.
   * `multilevel`: one list with the questions at level 1 and the options at levels
   * 2 and 3, which restart by themselves.
   * `style`: the same list, but the level and the list come from paragraph styles,
   * and only a paragraph that has to leave the list says so itself.
   * A fixture whose labels a multilevel list cannot reproduce (two kinds of
   * bracket for the options, say) is written as `lists` instead.
   */
  mode: "lists" | "multilevel" | "style";
  /** Leave the question numbers typed and number only the options. */
  optionsOnly?: boolean;
  /** In `lists`, start a new instance of the list partway, with no override, to show that the count carries on. */
  split?: boolean;
}

/** One line as it will be written: the text after the label, and the list it is in. */
interface Planned {
  text: string;
  numId?: number;
  level?: number;
  style?: string;
}

export interface NumberedLines {
  lines: Planned[];
  numbering: string;
  styles?: string;
  /** What Word should show before each line: the label, or empty for a line that is not in a list. */
  labels: string[];
  /** Whether the fixture could be written in the mode asked for. */
  mode: NumberingOptions["mode"];
}

type Kind = "question" | "lower" | "upper";
interface Item {
  kind: Kind;
  delimiter: string;
  value: number;
  text: string;
  label: string;
}

const LABELLED = /^(\*?)(\d{1,4}|[a-tA-T])([.)])\s+(.*)$/;

function classify(line: string, optionsOnly: boolean): Item | undefined {
  const m = LABELLED.exec(line);
  if (!m) return undefined;
  const [, star = "", label = "", delimiter = ".", rest = ""] = m;
  if (/\d/.test(label)) {
    // A star before a number is not a key mark, so the line is left as it was typed.
    if (star || optionsOnly) return undefined;
    return { kind: "question", delimiter, value: Number(label), text: rest, label: `${label}${delimiter}` };
  }
  const upper = label === label.toUpperCase();
  return {
    kind: upper ? "upper" : "lower",
    delimiter,
    value: label.toLowerCase().charCodeAt(0) - 96,
    // The star can only follow the letter once Word makes the letter.
    text: `${star}${rest}`,
    label: `${label}${delimiter}`,
  };
}

const FORMAT: Record<Kind, string> = { question: "decimal", lower: "lowerLetter", upper: "upperLetter" };
const LEVEL: Record<Kind, number> = { question: 0, lower: 1, upper: 2 };
const STYLE: Record<Kind, string> = { question: "QNum", lower: "ONum", upper: "OUpper" };

/** Decide, for each line, whether Word numbers it and in which list, and write the numbering part. */
export function numberLines(lines: readonly string[], options: NumberingOptions): NumberedLines {
  const optionsOnly = options.optionsOnly ?? false;
  const items = lines.map((line) => classify(line, optionsOnly));
  const labels = items.map((item) => item?.label ?? "");

  // A multilevel list has one bracket per level, so it can only reproduce a
  // fixture that uses one bracket for each kind of label.
  const delimiters = new Map<Kind, Set<string>>();
  for (const item of items) if (item) delimiters.set(item.kind, (delimiters.get(item.kind) ?? new Set<string>()).add(item.delimiter));
  const uniform = [...delimiters.values()].every((set) => set.size === 1);
  const mode = options.mode !== "lists" && !uniform ? "lists" : options.mode;

  if (mode === "lists") {
    const definitions: Array<{ kind: Kind; delimiter: string }> = [];
    const instances: Array<{ id: number; definition: number; start?: number }> = [];
    const state = new Map<string, { numId: number; last: number }>();
    let carried = 0;
    const planned = items.map((item, i): Planned => {
      if (!item) return { text: lines[i] as string };
      let definition = definitions.findIndex((d) => d.kind === item.kind && d.delimiter === item.delimiter) + 1;
      if (definition === 0) definition = definitions.push({ kind: item.kind, delimiter: item.delimiter });
      const key = `${item.kind}${item.delimiter}`;
      const before = state.get(key);
      const carries = before !== undefined && item.value === before.last + 1;
      let numId = before?.numId ?? 0;
      if (!carries || (options.split && ++carried % 3 === 0)) {
        numId = instances.length + 1;
        // The first use of a definition at its own start needs no override; anything else does.
        const needsStart = !carries && !(before === undefined && item.value === 1);
        instances.push({ id: numId, definition, ...(needsStart ? { start: item.value } : {}) });
      }
      state.set(key, { numId, last: item.value });
      return { text: item.text, numId, level: 0 };
    });
    return {
      lines: planned,
      mode,
      labels,
      numbering: numberingPart(
        definitions.map((d, k) => abstractNum(k + 1, [level(0, { format: FORMAT[d.kind], text: `%1${d.delimiter}` })])),
        instances.map((n) => num(n.id, n.definition, n.start !== undefined ? [{ level: 0, start: n.start }] : [])),
      ),
    };
  }

  // One list for the whole document. Question numbers are level 1, lower case
  // letters level 2 and upper case letters level 3.
  const bracket = (kind: Kind): string => [...(delimiters.get(kind) ?? [])][0] ?? ".";
  const useStyles = mode === "style";
  const instances: Array<{ id: number; start: number; at: number }> = [];
  const last: Array<number | undefined> = [undefined, undefined, undefined];
  let current = 1;
  const planned = items.map((item, i): Planned => {
    if (!item) return { text: lines[i] as string };
    const at = LEVEL[item.kind];
    const expected = (last[at] ?? 0) + 1;
    let numId = current;
    if (item.value !== expected) {
      // The numbers do not carry on, so a new instance restarts this level.
      numId = 2 + instances.length;
      instances.push({ id: numId, start: item.value, at });
      // Styles bring a paragraph back to the first instance; a plain list stays on the new one.
      if (!useStyles) current = numId;
    }
    last[at] = item.value;
    for (let deeper = at + 1; deeper < last.length; deeper++) last[deeper] = undefined;
    const viaStyle = useStyles && numId === 1;
    return {
      text: item.text,
      ...(viaStyle ? {} : { numId, level: at }),
      ...(useStyles ? { style: STYLE[item.kind] } : {}),
    };
  });

  const levels = (["question", "lower", "upper"] as const).map((kind) =>
    level(LEVEL[kind], { format: FORMAT[kind], text: `%${LEVEL[kind] + 1}${bracket(kind)}`, ...(useStyles ? { style: STYLE[kind] } : {}) }),
  );
  return {
    lines: planned,
    mode,
    labels,
    numbering: numberingPart(
      [abstractNum(1, levels)],
      [num(1, 1), ...instances.map((n) => num(n.id, 1, [{ level: n.at, start: n.start }]))],
    ),
    ...(useStyles
      ? {
          styles:
            style({ id: "Normal", isDefault: true }) +
            // Word's own form: each level is tied to a style, and each style names its list and level.
            // (A style that names only the list, for a level other than the first, is not numbered by Word.)
            style({ id: "QNum", basedOn: "Normal", numId: 1 }) +
            style({ id: "ONum", basedOn: "Normal", numId: 1, level: 1 }) +
            style({ id: "OUpper", basedOn: "Normal", numId: 1, level: 2 }),
        }
      : {}),
  };
}

export const HEADER_TEXT = "RUNNING HEADER MUST NOT BE READ";
export const FOOTER_TEXT = "RUNNING FOOTER MUST NOT BE READ";
export const DELETED_TEXT = "DELETED WORDS MUST NOT BE READ";

/**
 * One paragraph for each line, so that line n of the text is block n of the
 * document. An empty line is an empty paragraph, which is what makes a blank line
 * mean the same in both.
 */
export function docxFromLines(lines: readonly string[], options: LinesOptions = {}): Uint8Array {
  const numbered = options.numbering ? numberLines(lines, options.numbering) : undefined;
  const planned: Planned[] = numbered?.lines ?? lines.map((text) => ({ text }));
  const lists = numbered ? { numbering: numbered.numbering, ...(numbered.styles !== undefined ? { styles: numbered.styles } : {}) } : {};
  const listProps = (p: Planned): string => listProperties({ ...(p.style ? { style: p.style } : {}), ...(p.numId !== undefined ? { numId: p.numId } : {}), ...(p.level !== undefined ? { level: p.level } : {}) });

  if (!options.noise) {
    return docx({ body: planned.map((p) => paragraph(p.text === "" ? "" : run(p.text), listProps(p))).join(""), ...lists });
  }

  const rng = random(options.seed ?? 1);
  let mark = 0;

  const wrap = (chunk: string): string => {
    const text = run(chunk, rng.chance(0.3) ? '<w:lang w:val="en-US"/>' : rng.chance(0.2) ? "<w:noProof/>" : "");
    const roll = rng.below(14);
    switch (roll) {
      case 0:
        return `<w:hyperlink w:anchor="_Ref${++mark}">${text}</w:hyperlink>`;
      case 1:
        return `<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> REF _Ref${++mark} </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r>${text}<w:r><w:fldChar w:fldCharType="end"/></w:r>`;
      case 2:
        return `<w:ins w:id="${++mark}" w:author="A Reviewer" w:date="2026-01-01T00:00:00Z">${text}</w:ins>`;
      case 3:
        return `<w:proofErr w:type="spellStart"/>${text}<w:proofErr w:type="spellEnd"/>`;
      case 4:
        return `<w:bookmarkStart w:id="${++mark}" w:name="_Toc${mark}"/>${text}<w:bookmarkEnd w:id="${mark}"/>`;
      default:
        return text;
    }
  };

  const noisyLine = (planning: Planned): string => {
    const line = planning.text;
    const attributes = `w:rsidR="${rng.hex()}" w:rsidRDefault="${rng.hex()}"`;
    // The list comes first in the properties: that is where the schema puts it.
    const properties = listProps(planning) + (rng.chance(0.5) ? '<w:spacing w:after="0" w:line="240" w:lineRule="auto"/><w:jc w:val="left"/>' : "");
    if (line === "") {
      return paragraph(rng.chance(0.5) ? '<w:r><w:rPr><w:noProof/></w:rPr></w:r>' : "", properties, attributes);
    }
    // Cut the line at up to three arbitrary points. A cut inside "1." or inside a
    // word is what real Word does when someone edits partway through.
    const cuts = new Set<number>();
    for (let k = rng.below(4); k > 0 && line.length > 1; k--) cuts.add(1 + rng.below(line.length - 1));
    const edges = [0, ...[...cuts].sort((a, b) => a - b), line.length];
    let inner = "";
    for (let k = 0; k + 1 < edges.length; k++) {
      inner += wrap(line.slice(edges[k] as number, edges[k + 1] as number));
      if (rng.chance(0.2)) inner += '<w:r><w:lastRenderedPageBreak/></w:r>';
      if (rng.chance(0.15)) inner += "<w:r/>";
      if (rng.chance(0.1)) {
        inner += `<w:del w:id="${++mark}" w:author="A Reviewer" w:date="2026-01-01T00:00:00Z"><w:r><w:delText xml:space="preserve">${DELETED_TEXT}</w:delText></w:r></w:del>`;
      }
    }
    return paragraph(inner, properties, attributes);
  };

  return docx({ body: planned.map(noisyLine).join(""), headers: [HEADER_TEXT], footers: [FOOTER_TEXT], ...lists });
}
