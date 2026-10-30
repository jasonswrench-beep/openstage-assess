/**
 * Checks the formatting reader against Word itself.
 *
 * Whether a run is bold, italic, underlined, highlighted or coloured is not always
 * in the run: it can come from the paragraph's style, the run's character style,
 * the styles they are based on and the document's defaults, and bold and italic
 * toggle between style levels. The importer reads a mark made with formatting as
 * the answer key, so a run it reads as bold that Word shows as plain is a wrong key.
 *
 * This builds documents in which every paragraph is one run of one look, reached
 * by different routes, asks Word what the paragraph looks like, and compares. It
 * needs Windows with Microsoft Word installed and is not part of `npm test`. Run it
 * with `npm run check:word-formatting --workspace packages/assess`.
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { SourceRun } from "../../src/import/types.ts";
import { docxToBlocks } from "../../src/import/word.ts";
import { docx, docxFromLines, paragraph, run, type MarkOptions } from "../support/docx-writer.ts";
import { askWord, wordIsAvailable } from "./ask-word.ts";

interface Case {
  name: string;
  bytes: Uint8Array;
}
const cases: Case[] = [];

const NORMAL = '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>';
const paragraphStyle = (id: string, props = "", basedOn = ""): string =>
  `<w:style w:type="paragraph" w:customStyle="1" w:styleId="${id}"><w:name w:val="${id}"/>${basedOn ? `<w:basedOn w:val="${basedOn}"/>` : '<w:basedOn w:val="Normal"/>'}${props ? `<w:rPr>${props}</w:rPr>` : ""}</w:style>`;
const characterStyle = (id: string, props = "", basedOn = ""): string =>
  `<w:style w:type="character" w:customStyle="1" w:styleId="${id}"><w:name w:val="${id}"/>${basedOn ? `<w:basedOn w:val="${basedOn}"/>` : ""}${props ? `<w:rPr>${props}</w:rPr>` : ""}</w:style>`;

/** One paragraph of one run: in the paragraph style, the character style, and with direct formatting. */
const line = (inStyle?: string, inCharacterStyle?: string, direct = ""): string =>
  paragraph(run("Some text", (inCharacterStyle ? `<w:rStyle w:val="${inCharacterStyle}"/>` : "") + direct), inStyle ? `<w:pStyle w:val="${inStyle}"/>` : "");

const add = (name: string, body: string, styles = NORMAL, defaults = ""): void =>
  void cases.push({
    name,
    bytes: docx({ body, styles: (defaults ? `<w:docDefaults><w:rPrDefault><w:rPr>${defaults}</w:rPr></w:rPrDefault></w:docDefaults>` : "") + styles }),
  });

// direct formatting
add(
  "direct",
  [
    line(),
    line(undefined, undefined, "<w:b/>"),
    line(undefined, undefined, "<w:i/>"),
    line(undefined, undefined, '<w:u w:val="single"/>'),
    line(undefined, undefined, '<w:u w:val="double"/>'),
    line(undefined, undefined, '<w:color w:val="C00000"/>'),
    line(undefined, undefined, '<w:color w:val="000000"/>'),
    line(undefined, undefined, '<w:highlight w:val="yellow"/>'),
    line(undefined, undefined, '<w:highlight w:val="green"/>'),
    line(undefined, undefined, '<w:b w:val="0"/><w:i w:val="0"/>'),
    line(undefined, undefined, "<w:b/><w:i/>" + '<w:color w:val="0070C0"/>' + '<w:highlight w:val="yellow"/>' + '<w:u w:val="single"/>'),
  ].join(""),
);

// character styles
add(
  "character-styles",
  [line(undefined, "Strong"), line(undefined, "Emph"), line(undefined, "Marked"), line(undefined, "Red"), line(undefined, "Under"), line(undefined, "StrongBig"), line(undefined, "Strong", '<w:b w:val="0"/>')].join(""),
  NORMAL +
    characterStyle("Strong", "<w:b/>") +
    characterStyle("Emph", "<w:i/>") +
    characterStyle("Marked", '<w:highlight w:val="yellow"/>') +
    characterStyle("Red", '<w:color w:val="FF0000"/>') +
    characterStyle("Under", '<w:u w:val="single"/>') +
    characterStyle("StrongBig", "<w:b/>", "Strong"),
);

// paragraph styles
add(
  "paragraph-styles",
  [line("PBold"), line("PItalic"), line("PUnder"), line("PRed"), line("PHigh"), line("PBoldChild"), line("PBoldOff"), line("PBoldOffChild"), line("PBoldAgain")].join(""),
  NORMAL +
    paragraphStyle("PBold", "<w:b/>") +
    paragraphStyle("PItalic", "<w:i/>") +
    paragraphStyle("PUnder", '<w:u w:val="single"/>') +
    paragraphStyle("PRed", '<w:color w:val="FF0000"/>') +
    paragraphStyle("PHigh", '<w:highlight w:val="yellow"/>') +
    paragraphStyle("PBoldChild", "", "PBold") +
    paragraphStyle("PBoldOff", '<w:b w:val="0"/>', "PBold") +
    paragraphStyle("PBoldOffChild", "", "PBoldOff") +
    paragraphStyle("PBoldAgain", "<w:b/>", "PBold"),
);

// toggle properties meeting between a paragraph style and a character style
add(
  "toggles",
  [
    line("PBold", "Strong"),
    line("PBold", "Strong", "<w:b/>"),
    line("PBold", undefined, '<w:b w:val="0"/>'),
    line("PBold", "NotBold"),
    line("PItalic", "Emph"),
    line("PItalic", "Strong"),
    line("PBold", "StrongBig"),
    line("PBoldChild", "Strong"),
    line("PBoldOff", "Strong"),
    line("PBoldAgain", "Strong"),
    line(undefined, "Strong"),
  ].join(""),
  NORMAL +
    paragraphStyle("PBold", "<w:b/>") +
    paragraphStyle("PItalic", "<w:i/>") +
    paragraphStyle("PBoldChild", "", "PBold") +
    paragraphStyle("PBoldOff", '<w:b w:val="0"/>', "PBold") +
    paragraphStyle("PBoldAgain", "<w:b/>", "PBold") +
    characterStyle("Strong", "<w:b/>") +
    characterStyle("StrongBig", "<w:b/>", "Strong") +
    characterStyle("Emph", "<w:i/>") +
    characterStyle("NotBold", '<w:b w:val="0"/>'),
);

// the properties that do not toggle meeting between levels
add(
  "non-toggles",
  [
    line("PUnder", "NoUnder"),
    line("PUnder", "Under"),
    line("PRed", "Blue"),
    line("PRed", "Plain"),
    line("PHigh", "NoHigh"),
    line("PHigh", undefined, '<w:highlight w:val="none"/>'),
    line("PRed", undefined, '<w:color w:val="auto"/>'),
  ].join(""),
  NORMAL +
    paragraphStyle("PUnder", '<w:u w:val="single"/>') +
    paragraphStyle("PRed", '<w:color w:val="FF0000"/>') +
    paragraphStyle("PHigh", '<w:highlight w:val="yellow"/>') +
    characterStyle("NoUnder", '<w:u w:val="none"/>') +
    characterStyle("Under", '<w:u w:val="single"/>') +
    characterStyle("Blue", '<w:color w:val="0000FF"/>') +
    characterStyle("Plain", "") +
    characterStyle("NoHigh", '<w:highlight w:val="none"/>'),
);

// the document's defaults, and the default paragraph style
add(
  "defaults",
  [line(), line("Own"), line("Own", undefined, '<w:i w:val="0"/>')].join(""),
  '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:rPr><w:b/></w:rPr></w:style>' + paragraphStyle("Own", '<w:color w:val="FF0000"/>', "Normal"),
  '<w:color w:val="404040"/><w:i/>',
);

// The text fixtures, with the correct options marked each way. Every marked paragraph is one look
// all through, so Word's answer for it can be compared with the reader's.
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "fixtures", "standard-format");
const MARKS: MarkOptions["property"][] = ["bold", "italic", "underline", "highlight", "color", "style"];
for (const file of readdirSync(FIXTURES).filter((n) => n.endsWith(".txt"))) {
  const lines = readFileSync(join(FIXTURES, file), "utf8").replace(/\r\n?/g, "\n").split("\n");
  for (const property of MARKS) {
    cases.push({ name: `fixture-${file.slice(0, 2)}-${property}`, bytes: docxFromLines(lines, { marks: { property } }) });
  }
  cases.push({ name: `fixture-${file.slice(0, 2)}-bold-numbered`, bytes: docxFromLines(lines, { marks: { property: "bold" }, numbering: { mode: "lists" } }) });
}

// ---------------------------------------------------------------------------

/** Word's colour is blue, green, red as a number; the reader's is RRGGBB. */
function wordColor(hex: string): number {
  const red = parseInt(hex.slice(0, 2), 16);
  const green = parseInt(hex.slice(2, 4), 16);
  const blue = parseInt(hex.slice(4, 6), 16);
  return red + green * 256 + blue * 65536;
}

/** Word's highlight colours by index; any other name just has to be some highlight. */
const HIGHLIGHT: Record<string, number> = { yellow: 7, green: 4, darkgreen: 11, red: 6, blue: 2, magenta: 5 };

function main(): void {
  if (!wordIsAvailable()) {
    console.log("This check needs Windows with Microsoft Word installed. Nothing was run.");
    return;
  }
  const word = askWord(new Map(cases.map((c) => [c.name, c.bytes])), "format");

  let paragraphs = 0;
  let disagreements = 0;
  for (const c of cases) {
    const theirs = word[c.name] ?? [];
    if (theirs[0]?.startsWith("ERROR")) {
      console.log(`${c.name}: Word could not open it. ${theirs[0]}`);
      disagreements++;
      continue;
    }
    const blocks = docxToBlocks(c.bytes).blocks;
    if (blocks.length !== theirs.length) {
      console.log(`${c.name}: Word reads ${theirs.length} paragraphs, the reader ${blocks.length}`);
      disagreements++;
      continue;
    }
    blocks.forEach((block, i) => {
      paragraphs++;
      const runs = block.runs ?? [];
      const ours: Partial<SourceRun> = runs[0] ?? {};
      if (runs.length > 1) {
        console.log(`${c.name}[${i}]: the reader found ${runs.length} looks in a paragraph that has one`);
        disagreements++;
        return;
      }
      const [bold, italic, underline, color, highlight] = (theirs[i] ?? "").split("|").map(Number);
      const problems: string[] = [];
      if ((bold === -1) !== !!ours.bold) problems.push(`bold: reader ${!!ours.bold}, Word ${bold === -1}`);
      if ((italic === -1) !== !!ours.italic) problems.push(`italic: reader ${!!ours.italic}, Word ${italic === -1}`);
      if ((underline !== 0) !== !!ours.underline) problems.push(`underline: reader ${!!ours.underline}, Word ${underline !== 0}`);
      // Automatic and a spelled-out black are both "no colour" to a reader.
      const wordHasColor = color !== -16777216 && color !== 0;
      if (wordHasColor !== !!ours.color || (ours.color && color !== wordColor(ours.color))) problems.push(`colour: reader ${ours.color ?? "none"}, Word ${color}`);
      const wantsHighlight = ours.highlight ? (HIGHLIGHT[ours.highlight.toLowerCase()] ?? -1) : 0;
      if ((highlight !== 0) !== !!ours.highlight || (wantsHighlight > 0 && highlight !== wantsHighlight)) problems.push(`highlight: reader ${ours.highlight ?? "none"}, Word index ${highlight}`);
      if (problems.length > 0) {
        console.log(`${c.name}[${i}]: ${problems.join("; ")}`);
        disagreements++;
      }
    });
  }
  console.log(`${cases.length} documents, ${paragraphs} paragraphs, ${disagreements} disagreements with Word.`);
  if (disagreements > 0) process.exitCode = 1;
}

main();
