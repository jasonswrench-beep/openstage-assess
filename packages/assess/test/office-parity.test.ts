/**
 * The Word and Excel readers that were made to stop trusting a count in the file (hostile-office.test.ts) read every file they were
 * meant for exactly as they did. Each is held against a verbatim copy of itself from before (test/support/*-before.ts) on files made
 * at random, and the limits that are new are held to the numbers they were given, at the edge and one past it.
 *
 * A number off by one in a list is a key pointed at the wrong question without a word, so the list labels are compared for every
 * paragraph of thousands of random documents, with chains of styles that loop, that end in a style the file does not define, and
 * that name a list or a level at any place along them.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { readNumbering as readNumberingNow } from "../src/import/docx/numbering.ts";
import { readNumbering as readNumberingBefore } from "./support/numbering-before.ts";
import { readFormatting as readFormattingNow } from "../src/import/docx/formatting.ts";
import { readFormatting as readFormattingBefore } from "./support/formatting-before.ts";
import { readTable as readTableNow, type Cell } from "../src/import/docx/tables.ts";
import { readTable as readTableBefore } from "./support/tables-before.ts";
import { readXlsx as readXlsxNow } from "../src/import/table-xlsx.ts";
import { readXlsx as readXlsxBefore } from "./support/xlsx-before.ts";
import { parseXml, type XmlElement } from "../src/import/docx/xml.ts";
import { readEquation } from "../src/import/docx/omml.ts";
import { spreadsheetImporter } from "../src/import/spreadsheet.ts";
import { sheetXml, workbook } from "./support/hostile-office.ts";

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const M = 'xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math" xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';

/** A small seeded generator, so that a failure can be reproduced from its seed. */
function generator(seed: number) {
  let state = seed >>> 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    chance: (p: number): boolean => next() < p,
    below: (n: number): number => Math.floor(next() * n),
    between: (low: number, high: number): number => low + Math.floor(next() * (high - low + 1)),
    pick: <T>(list: readonly T[]): T => list[Math.floor(next() * list.length)] as T,
  };
}
type Random = ReturnType<typeof generator>;

// ---------------------------------------------------------------------------
// List labels
// ---------------------------------------------------------------------------

const FORMATS = ["decimal", "decimal", "decimalZero", "lowerLetter", "upperLetter", "lowerRoman", "upperRoman", "ordinal", "none", "bullet", "cardinalText"];
const TEXTS = ["%1.", "%1)", "(%1)", "%1.%2", "%1.%2.%3", "(%2)", "%2.", "Question %1:", "Q%1", "%3", "%1 - %2", "", "•", "%9"];

interface Doc {
  numbering: string;
  styles: string;
  paragraphs: Array<{ style?: string; numId?: string; ilvl?: string } | undefined>;
  damaged: boolean;
}

function randomDoc(random: Random, chains: boolean): Doc {
  const styleCount = chains ? random.between(10, 60) : random.between(0, 12);
  const styleIds = Array.from({ length: styleCount }, (_, i) => `s${i}`);
  const anyStyle = (): string => (random.chance(0.1) ? "missing" : random.pick(styleIds.length > 0 ? styleIds : ["missing"]));

  const definitionCount = random.between(1, 4);
  const abstracts: string[] = [];
  for (let id = 1; id <= definitionCount; id++) {
    let levels = "";
    const at = new Set<number>();
    for (let k = random.between(1, 9); k > 0; k--) at.add(random.chance(0.15) ? random.between(0, 8) : at.size);
    for (const ilvl of [...at].sort((a, b) => a - b)) {
      levels +=
        `<w:lvl w:ilvl="${ilvl}">` +
        (random.chance(0.8) ? `<w:start w:val="${random.between(0, 12)}"/>` : "") +
        (random.chance(0.97) ? `<w:numFmt w:val="${random.pick(FORMATS)}"/>` : "") +
        (random.chance(0.2) ? `<w:lvlRestart w:val="${random.between(0, 3)}"/>` : "") +
        (random.chance(0.2) && styleIds.length > 0 ? `<w:pStyle w:val="${anyStyle()}"/>` : "") +
        (random.chance(0.15) ? "<w:isLgl/>" : "") +
        (random.chance(0.97) ? `<w:lvlText w:val="${random.pick(TEXTS)}"/>` : "") +
        "</w:lvl>";
    }
    const link = random.chance(0.25) && styleIds.length > 0 ? `<w:numStyleLink w:val="${anyStyle()}"/>` : "";
    abstracts.push(`<w:abstractNum w:abstractNumId="${id}">${link}${levels}</w:abstractNum>`);
  }
  const instances: string[] = [];
  for (let id = 1; id <= random.between(1, 5); id++) {
    let overrides = "";
    for (let k = random.between(0, 3); k > 0; k--) {
      const ilvl = random.between(0, 8);
      overrides +=
        `<w:lvlOverride w:ilvl="${ilvl}">` +
        (random.chance(0.6) ? `<w:startOverride w:val="${random.between(0, 9)}"/>` : "") +
        (random.chance(0.3) ? `<w:lvl w:ilvl="${ilvl}"><w:start w:val="${random.between(0, 5)}"/><w:numFmt w:val="${random.pick(FORMATS)}"/><w:lvlText w:val="${random.pick(TEXTS)}"/></w:lvl>` : "") +
        "</w:lvlOverride>";
    }
    instances.push(`<w:num w:numId="${id}">${random.chance(0.92) ? `<w:abstractNumId w:val="${random.between(1, definitionCount + (random.chance(0.1) ? 1 : 0))}"/>` : ""}${overrides}</w:num>`);
  }

  const second = chains ? 0.1 : 0.4;
  let styles = "";
  styleIds.forEach((id, i) => {
    const basedOn = chains ? (random.chance(0.85) ? `s${(i + 1) % (random.chance(0.05) ? 3 : styleCount)}` : random.chance(0.5) ? "missing" : random.pick(styleIds)) : random.chance(0.5) ? anyStyle() : undefined;
    const numPr = random.chance(second) || random.chance(second / 3);
    const withList = random.chance(chains ? 0.1 : 0.7);
    const withLevel = random.chance(chains ? 0.1 : 0.5);
    styles +=
      `<w:style w:type="${random.chance(0.9) ? "paragraph" : "numbering"}"${random.chance(0.12) ? ' w:default="1"' : ""} w:styleId="${id}">` +
      (basedOn !== undefined ? `<w:basedOn w:val="${basedOn}"/>` : "") +
      (numPr ? `<w:pPr><w:numPr>${withLevel ? `<w:ilvl w:val="${random.between(0, 8)}"/>` : ""}${withList ? `<w:numId w:val="${random.between(0, 6)}"/>` : ""}</w:numPr></w:pPr>` : "") +
      "</w:style>";
  });

  const paragraphs: Doc["paragraphs"] = [];
  for (let k = random.between(1, 30); k > 0; k--) {
    if (random.chance(0.1)) {
      paragraphs.push(undefined);
      continue;
    }
    paragraphs.push({
      ...(random.chance(0.5) ? { style: anyStyle() } : {}),
      ...(random.chance(0.6) ? { ...(random.chance(0.8) ? { numId: String(random.between(0, 6)) } : {}), ...(random.chance(0.6) ? { ilvl: String(random.between(0, 8)) } : {}) } : {}),
    });
  }
  return { numbering: abstracts.join("") + instances.join(""), styles, paragraphs, damaged: random.chance(0.03) };
}

const part = (name: string, inner: string): XmlElement => parseXml(`<w:${name} ${W}>${inner}</w:${name}>`);

function labelsOf(read: typeof readNumberingNow, doc: Doc, stylesPresent: boolean): unknown[] {
  const numbering = read({
    numbering: part("numbering", doc.numbering),
    styles: stylesPresent ? part("styles", doc.styles) : undefined,
    numberingDamaged: doc.damaged ? "damaged" : undefined,
  });
  return doc.paragraphs.map((p) => {
    const properties = p ? parseXml(`<w:pPr ${W}>${p.style ? `<w:pStyle w:val="${p.style}"/>` : ""}${p.numId !== undefined || p.ilvl !== undefined ? `<w:numPr>${p.ilvl !== undefined ? `<w:ilvl w:val="${p.ilvl}"/>` : ""}${p.numId !== undefined ? `<w:numId w:val="${p.numId}"/>` : ""}</w:numPr>` : ""}</w:pPr>`) : undefined;
    return numbering.label(properties) ?? null;
  });
}

describe("list labels are what they were, on documents made at random", () => {
  for (const [what, chains, count] of [
    ["a few styles, many of them naming a list or a level", false, 4000],
    ["long chains of styles that loop, end in styles the file does not define, and name a list or a level here and there", true, 1500],
  ] as const) {
    test(`${what}: ${count} documents, every paragraph`, () => {
      let compared = 0;
      let numbered = 0;
      for (let seed = 1; seed <= count; seed++) {
        const random = generator(seed * (chains ? 7919 : 104729));
        const doc = randomDoc(random, chains);
        const before = labelsOf(readNumberingBefore, doc, true);
        const now = labelsOf(readNumberingNow, doc, true);
        assert.deepEqual(now, before, `seed ${seed} (chains ${chains})`);
        compared += before.length;
        numbered += before.filter((l) => l !== null && (l as { label?: string }).label !== undefined).length;
      }
      // The documents are not all lists that say nothing: thousands of the paragraphs got a label, so the comparison was of labels.
      assert.ok(numbered > 500, `${numbered} of ${compared} paragraphs were numbered`);
    });
  }

  // A style that names a list some other style holds the level of names nothing, and the nearest level on the chain counts only if it is
  // nearer than that style. The random documents rarely have the two in one chain, so it is made here, by hand, in a tree and in a loop.
  for (const [what, loop] of [
    ["in a chain that ends", false],
    ["in a chain that is a loop", true],
  ] as const) {
    test(`a level named nearer than a list that the style does not hold is the level of the paragraph, ${what}`, () => {
      // The first style to name a level of list 1 holds it (H, and H2 for the third level in the loop); B names the same level and is not
      // based on that style, so B does not hold it. A is based on B and says level 3 (in the loop B is based on A as well). A paragraph
      // in A that names list 1 itself is at level 3, since A says so nearer than B names the list, and not at level 1.
      const numbering =
        `<w:abstractNum w:abstractNumId="1">${lvl(0, 1, "decimal", "%1.")}${lvl(1, 1, "decimal", "(%2)")}${lvl(2, 1, "decimal", "[%3]")}</w:abstractNum>` +
        '<w:num w:numId="1"><w:abstractNumId w:val="1"/></w:num>';
      const style = (id: string, inner: string): string => `<w:style w:type="paragraph" w:styleId="${id}">${inner}</w:style>`;
      const names = (level = ""): string => `<w:pPr><w:numPr>${level}<w:numId w:val="1"/></w:numPr></w:pPr>`;
      const styles =
        style("H", names()) +
        (loop ? style("H2", names('<w:ilvl w:val="2"/>')) : "") +
        style("B", `${loop ? '<w:basedOn w:val="A"/>' : ""}${names()}`) +
        style("A", '<w:basedOn w:val="B"/><w:pPr><w:numPr><w:ilvl w:val="2"/></w:numPr></w:pPr>');
      const doc: Doc = { numbering, styles, paragraphs: [{ style: "A", numId: "1" }, { style: "A", numId: "1" }, { style: "B", numId: "1" }], damaged: false };
      const now = labelsOf(readNumberingNow, doc, true);
      assert.deepEqual(now, labelsOf(readNumberingBefore, doc, true));
      // The third paragraph is in B, which names no level: it is at level 1, the second item of it, since the first level counts as
      // used once for the paragraphs at level 3 before it.
      assert.deepEqual(now, [{ label: "[1]" }, { label: "[2]" }, { label: "2." }]);
    });
  }

  test("a document with no styles part is read the same", () => {
    for (let seed = 1; seed <= 500; seed++) {
      const doc = randomDoc(generator(seed * 31), false);
      assert.deepEqual(labelsOf(readNumberingNow, doc, false), labelsOf(readNumberingBefore, doc, false), `seed ${seed}`);
    }
  });
});

// ---------------------------------------------------------------------------
// How text looks
// ---------------------------------------------------------------------------

const PROPERTIES = ["<w:b/>", '<w:b w:val="0"/>', "<w:i/>", '<w:i w:val="false"/>', "<w:vanish/>", '<w:vanish w:val="0"/>', '<w:u w:val="single"/>', '<w:u w:val="none"/>', '<w:highlight w:val="yellow"/>', '<w:highlight w:val="none"/>', '<w:color w:val="FF0000"/>', '<w:color w:val="auto"/>', '<w:color w:val="000000"/>', '<w:color w:val="0000FF"/>'];

describe("how text looks is what it was, on styles made at random", () => {
  test("2000 style sheets, with chains that loop and end in styles the file does not define, and 20 paragraphs and runs each", () => {
    let looks = 0;
    for (let seed = 1; seed <= 2000; seed++) {
      const random = generator(seed * 2654435761);
      const count = random.between(0, 14);
      const ids = Array.from({ length: count }, (_, i) => `f${i}`);
      const anyStyle = (): string => (random.chance(0.1) ? "gone" : random.pick(ids.length > 0 ? ids : ["gone"]));
      let styles = random.chance(0.5) ? `<w:docDefaults><w:rPrDefault><w:rPr>${random.chance(0.5) ? random.pick(PROPERTIES) : ""}${random.chance(0.3) ? random.pick(PROPERTIES) : ""}</w:rPr></w:rPrDefault></w:docDefaults>` : "";
      ids.forEach((id) => {
        const rPr = Array.from({ length: random.between(0, 3) }, () => random.pick(PROPERTIES)).join("");
        styles +=
          `<w:style w:type="${random.chance(0.6) ? "paragraph" : "character"}"${random.chance(0.15) ? ' w:default="1"' : ""} w:styleId="${id}">` +
          (random.chance(0.7) ? `<w:basedOn w:val="${anyStyle()}"/>` : "") +
          (rPr !== "" ? `<w:rPr>${rPr}</w:rPr>` : "") +
          "</w:style>";
      });
      const sheet = random.chance(0.97) ? part("styles", styles) : undefined;
      const before = readFormattingBefore(sheet);
      const now = readFormattingNow(sheet);
      for (let k = 0; k < 20; k++) {
        const direct = Array.from({ length: random.between(0, 2) }, () => random.pick(PROPERTIES)).join("");
        const runProperties = random.chance(0.1) ? undefined : parseXml(`<w:rPr ${W}>${random.chance(0.5) ? `<w:rStyle w:val="${anyStyle()}"/>` : ""}${direct}</w:rPr>`);
        const paragraphStyle = random.chance(0.7) ? anyStyle() : undefined;
        assert.deepEqual(now.run(runProperties, paragraphStyle), before.run(runProperties, paragraphStyle), `seed ${seed}, run ${k}`);
        assert.equal(now.hidden(runProperties, paragraphStyle), before.hidden(runProperties, paragraphStyle), `seed ${seed}, hidden ${k}`);
        if (Object.keys(before.run(runProperties, paragraphStyle)).length > 0) looks++;
      }
    }
    // Many of the runs were bold, italic, underlined, highlighted or coloured, so the comparison was of looks.
    assert.ok(looks > 5000, `${looks} runs had a look`);
  });
});

// ---------------------------------------------------------------------------
// The limits that are new, at the edge and one past it
// ---------------------------------------------------------------------------

function labelsFor(levels: string, paragraphs: Array<{ numId?: number; ilvl?: number | string }>, extra = ""): string[] {
  const numbering = readNumberingNow({ numbering: part("numbering", `<w:abstractNum w:abstractNumId="1">${levels}</w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="1"/>${extra}</w:num>`) });
  return paragraphs.map((p) => {
    const properties = parseXml(`<w:pPr ${W}><w:numPr>${p.ilvl !== undefined ? `<w:ilvl w:val="${p.ilvl}"/>` : ""}<w:numId w:val="${p.numId ?? 1}"/></w:numPr></w:pPr>`);
    const got = numbering.label(properties);
    return got?.unread !== undefined ? `! ${got.unread}` : got?.bullet ? "(bullet)" : (got?.label ?? "-");
  });
}
const lvl = (ilvl: number, start: number | string, format = "decimal", text = `%${ilvl + 1}.`): string =>
  `<w:lvl w:ilvl="${ilvl}"><w:start w:val="${start}"/><w:numFmt w:val="${format}"/><w:lvlText w:val="${text}"/></w:lvl>`;

describe("a level is one of the nine Word has", () => {
  test("level 9 (8 as the file counts it) is read, with the levels above it counted once as always", () => {
    const levels = Array.from({ length: 8 }, (_, i) => lvl(i, 1)).join("") + lvl(8, 1, "decimal", "%1.%2.%3.%4.%5.%6.%7.%8.%9");
    assert.deepEqual(labelsFor(levels, [{ ilvl: 8 }, { ilvl: 8 }]), ["1.1.1.1.1.1.1.1.1", "1.1.1.1.1.1.1.1.2"]);
  });

  for (const ilvl of [9, 20_000_000, -1]) {
    test(`level ${ilvl + 1} is unread, in words, and nothing is counted`, () => {
      const levels = lvl(0, 1) + lvl(ilvl, 1);
      const [a, b] = labelsFor(levels, [{ ilvl }, { ilvl: 0 }]);
      assert.match(a as string, /^! its level \(-?\d+\) is not one of the nine levels \(1 to 9\)/);
      assert.equal(b, "1.", "the list's own paragraphs go on from 1");
    });
  }

  test("a level of a number too large for one is unread as well", () => {
    const [a] = labelsFor(lvl(0, 1), [{ ilvl: "9".repeat(400) }]);
    assert.match(a as string, /^! its level \(Infinity\)/);
  });
});

describe("a start is at most the 32,767 Word lets a list start at", () => {
  test("32,767 is read, one more is not", () => {
    assert.deepEqual(labelsFor(lvl(0, 32_767), [{}, {}]), ["32767.", "32768."]);
    const [a, b] = labelsFor(lvl(0, 32_768), [{}, {}]);
    assert.match(a as string, /^! its start \(32768\) is more than the 32,767 that Word lets a list start at$/);
    assert.equal(b, a, "and it stays unread for every paragraph of the list");
  });

  test("an override that restarts the list past it is not read either, and 32,767 is", () => {
    const start = (n: number): string => `<w:lvlOverride w:ilvl="0"><w:startOverride w:val="${n}"/></w:lvlOverride>`;
    assert.deepEqual(labelsFor(lvl(0, 1), [{}, {}], start(32_767)), ["32767.", "32768."]);
    assert.match(labelsFor(lvl(0, 1), [{}], start(32_768))[0] as string, /^! its start \(32768\)/);
    assert.match(labelsFor(lvl(0, 1), [{}], start(1e12))[0] as string, /^! its start \(1000000000000\)/);
  });

  test("the start of a level above the paragraph's counts, since it shows in the label", () => {
    const levels = lvl(0, 40_000) + lvl(1, 1, "decimal", "%1.%2");
    assert.match(labelsFor(levels, [{ ilvl: 1 }])[0] as string, /^! its start \(40000\)/);
    assert.deepEqual(labelsFor(lvl(0, 1) + lvl(1, 1, "decimal", "%1.%2"), [{ ilvl: 1 }]), ["1.1"]);
  });

  test("the start of a level below the paragraph's, named in its text and not yet counted, counts too", () => {
    const levels = lvl(0, 1, "decimal", "%1.%2") + lvl(1, 40_000);
    assert.match(labelsFor(levels, [{ ilvl: 0 }])[0] as string, /^! its start \(40000\)/);
  });

  test("a paragraph that is unread for its start is still counted, so the numbers after it are those they always were", () => {
    // Level 2 starts past the limit. The paragraph at it is unread, and it uses level 1 once, as any paragraph below a level does, so
    // the next paragraph at level 1 is the second. A reader that left it out of the count numbered those after it one lower.
    const levels = lvl(0, 1) + lvl(1, 40_000);
    const [a, b, c] = labelsFor(levels, [{ ilvl: 1 }, { ilvl: 0 }, { ilvl: 0 }]);
    assert.match(a as string, /^! its start \(40000\)/);
    assert.deepEqual([b, c], ["2.", "3."]);
  });

  test("a bullet shows no number, so its start is nothing to look at", () => {
    assert.deepEqual(labelsFor(lvl(0, 1e12, "bullet", "•"), [{}, {}]), ["(bullet)", "(bullet)"]);
  });
});

describe("a label is at most 300 characters", () => {
  test("a count in letters that is 300 letters long is read, one more is not", () => {
    // 300 letters is the 7,800th: a to z is 26, and each time round the letter is written once more.
    const [a, b] = labelsFor(lvl(0, 7_800, "lowerLetter", "%1"), [{}, {}]);
    assert.equal(a, "z".repeat(300));
    assert.match(b as string, /^! the number it would show is more than 300 characters long, which is not a label$/);
  });

  test("a level text of 300 characters is read, one of 301 is not", () => {
    assert.equal(labelsFor(lvl(0, 1, "decimal", "x".repeat(300)), [{}])[0], "x".repeat(300));
    assert.match(labelsFor(lvl(0, 1, "decimal", "x".repeat(301)), [{}])[0] as string, /^! the text of its level is more than 300 characters long, which is not a label$/);
  });

  test("a text that names the count a few times and stays under is read as it was", () => {
    assert.deepEqual(labelsFor(lvl(0, 12_345, "lowerLetter", "%1"), [{}]).length, 1);
    assert.deepEqual(labelsFor(lvl(0, 12, "decimal", "%1%1%1"), [{}, {}]), ["121212", "131313"]);
  });

  test("a bullet's text is not looked at", () => {
    assert.deepEqual(labelsFor(lvl(0, 1, "bullet", "x".repeat(1000)), [{}]), ["(bullet)"]);
  });

  test("what a text names is counted together: two counts of 300 letters are 600, and are not a label", () => {
    assert.match(labelsFor(lvl(0, 7_800, "lowerLetter", "%1%1"), [{}])[0] as string, /^! the number it would show is more than 300 characters long/);
    assert.equal(labelsFor(lvl(0, 7_800, "lowerLetter", "%1"), [{}])[0], "z".repeat(300), "one of them is");
  });

  test("a label is cut at 300 characters in all, the words of the text as well as the numbers", () => {
    // 3,888 in capital Roman numerals is MMMDCCCLXXXVIII, fifteen characters; the text is 292 characters and the label 305.
    const text = `${"x".repeat(290)}%1`;
    assert.match(labelsFor(lvl(0, 3_888, "upperRoman", text), [{}])[0] as string, /^! the number it would show is more than 300 characters long/);
    assert.equal(labelsFor(lvl(0, 3_888, "upperRoman", `${"x".repeat(284)}%1`), [{}])[0], `${"x".repeat(284)}MMMDCCCLXXXVIII`, "and 299 characters is a label");
  });
});

// ---------------------------------------------------------------------------
// Equations
// ---------------------------------------------------------------------------

const equation = (inner: string): ReturnType<typeof readEquation> => readEquation(parseXml(`<m:oMath ${M}>${inner}</m:oMath>`));

describe("the parts of a run of an equation are counted", () => {
  test("a run of a few hundred signs is read", () => {
    const read = equation(`<m:r><m:t>${"a+".repeat(200)}</m:t></m:r>`);
    assert.equal(read.ok, true);
  });

  test("a run of 4,999 signs is read, and one of 5,000 is not (the run itself is a part, and an equation has 5,000 parts at most)", () => {
    assert.equal(equation(`<m:r><m:t>${"+".repeat(4_999)}</m:t></m:r>`).ok, true);
    const over = equation(`<m:r><m:t>${"+".repeat(5_000)}</m:t></m:r>`);
    assert.equal(over.ok, false);
    assert.match(over.ok ? "" : over.reason, /more parts than an equation has/);
  });

  test("the parts of the runs add up: two runs of 3,000 signs are 6,000 parts", () => {
    const read = equation(`<m:r><m:t>${"+".repeat(3_000)}</m:t></m:r><m:r><m:t>${"+".repeat(3_000)}</m:t></m:r>`);
    assert.equal(read.ok, false);
  });

  test("a run of digits that is one part however long is read up to the text a run may have, and not past it", () => {
    assert.equal(equation(`<m:r><m:t>${"7".repeat(19_000)}</m:t></m:r>`).ok, true);
    const over = equation(`<m:r><m:t>${"7".repeat(20_001)}</m:t></m:r>`);
    assert.equal(over.ok, false);
    assert.match(over.ok ? "" : over.reason, /run of text longer than any equation has/);
  });

  test("plain text in an equation is one part, whatever its length", () => {
    assert.equal(equation(`<m:r><m:rPr><m:nor/></m:rPr><m:t>${"word ".repeat(10_000)}</m:t></m:r>`).ok, true);
  });
});

// ---------------------------------------------------------------------------
// Table layouts
// ---------------------------------------------------------------------------

const CELL_TEXTS = ["", " ", "1.", "2.", "7.", "(p. 12)", "pp. 3-4", "a.", "b.", "b. text", "c)", "Question", "A", "B", "C", "D", "Answer", "No", "x", "MC", "True", "✓", "Paris = capital", "What is it?", "Type", "Points", "5", "Difficulty", "Notes", "Feedback correct"];
const HEADERS = ["No", "Question", "A", "B", "C", "Answer", "Type", "Points", "Difficulty", "Notes", "Title", "Feedback correct"];

function randomCell(random: Random, runs: boolean, pool: readonly string[] = CELL_TEXTS): Cell {
  const lines: Cell["lines"] = [];
  for (let k = random.between(0, 5); k > 0; k--) {
    const text = random.pick(pool);
    lines.push({
      text,
      ...(runs ? { runs: text === "" ? [] : random.chance(0.3) ? [{ text: text.slice(0, 1) }, { text: text.slice(1), bold: true }] : [{ text }] } : {}),
      ...(random.chance(0.15) ? { kind: "listItem" as const, listLabel: random.pick(["1.", "a.", "(i)"]) } : {}),
      ...(random.chance(0.2) ? { table: { table: 0, row: random.below(4), cell: random.below(4) } } : {}),
    });
  }
  return { lines, ...(random.chance(0.05) ? { merged: true } : {}), ...(random.chance(0.03) ? { nested: true } : {}) };
}

function randomTable(random: Random, runs: boolean): Cell[][] {
  const shape = random.pick(["grid", "grid", "labelled", "key", "numbered", "numbered", "matching", "junk"]);
  const cellOf = (text: string): Cell => ({ lines: [{ text, ...(runs ? { runs: text === "" ? [] : [{ text }] } : {}) }] });
  const rows: Cell[][] = [];
  if (shape === "grid") {
    const columns = random.between(3, 7);
    const names = Array.from({ length: columns }, (_, i) => (i === 0 ? "Question" : i < 3 ? ["A", "B"][i - 1] : random.pick(HEADERS)) as string);
    rows.push(names.map(cellOf));
    for (let r = random.between(1, 4); r > 0; r--) rows.push(Array.from({ length: columns }, () => randomCell(random, runs)));
  } else if (shape === "labelled") {
    for (let r = random.between(1, 6); r > 0; r--) {
      const cells = [cellOf(random.pick(["1.", "a.", "b.", "c)", "*d."])), randomCell(random, runs)];
      if (random.chance(0.4)) cells.push(randomCell(random, runs));
      if (random.chance(0.3)) cells.push(cellOf(random.pick(["✓", "correct", "x"])));
      rows.push(cells);
    }
  } else if (shape === "key") {
    if (random.chance(0.5)) rows.push([cellOf("Q"), cellOf("Answer")]);
    for (let r = random.between(1, 8); r > 0; r--) rows.push([cellOf(`${r}.`), cellOf(random.pick(["A", "B", "C", "True", "x", ""]))]);
  } else if (shape === "numbered") {
    for (let r = random.between(1, 4); r > 0; r--) {
      const first = randomCell(random, runs, ["1.", "(p. 230)", "note", "", "2."]);
      first.lines.unshift({ text: `${r}.`, ...(runs ? { runs: [{ text: `${r}.` }] } : {}) });
      rows.push([first, randomCell(random, runs)]);
    }
  } else if (shape === "matching") {
    const start = random.between(1, 3);
    for (let r = 0; r < random.between(3, 6); r++) rows.push([cellOf(`${start + r}.`), cellOf(`term ${r}`), cellOf(random.chance(0.3) ? "def (p. 4)" : `def ${r}`), cellOf("")]);
  } else {
    for (let r = random.between(1, 4); r > 0; r--) rows.push(Array.from({ length: random.between(1, 4) }, () => randomCell(random, runs)));
  }
  return rows;
}

describe("table layouts read the lines they read, on tables made at random", () => {
  test("3000 tables of every layout, with and without runs", () => {
    const layouts = new Set<string>();
    for (let seed = 1; seed <= 3000; seed++) {
      const random = generator(seed * 15485863);
      const runs = random.chance(0.5);
      const rows = randomTable(random, runs);
      const context = { runs, previous: random.chance(0.2) ? "Answers:" : "" };
      const before = readTableBefore(structuredClone(rows), context);
      const now = readTableNow(structuredClone(rows), context);
      assert.deepEqual(now, before, `seed ${seed}`);
      if (before.layout) layouts.add(before.layout);
    }
    // Every layout was met, so the comparison was not of tables that none of them read.
    assert.deepEqual([...layouts].sort(), ["answer key", "grid", "labelled rows", "matching rows", "numbered cells"]);
  });
});

// ---------------------------------------------------------------------------
// Workbooks
// ---------------------------------------------------------------------------

const cellText = (random: Random): string =>
  random.pick(["MC", "TF", "What is 2+2?", "  spaced  ", "line\r\nbreak", "line\rbreak", "A", "B", "Correct", "Question", "0.1", "5", "", "x".repeat(random.between(1, 3000)), "tab\there", "ünïcödé ✓"]);

function randomSheet(random: Random, sharedCount: number): string {
  let rows = "";
  let row = 0;
  for (let r = random.between(0, 25); r > 0; r--) {
    row += random.chance(0.9) ? 1 : random.between(2, 5);
    let cells = "";
    let column = 0;
    for (let c = random.between(0, 14); c > 0; c--) {
      column += random.chance(0.85) ? 1 : random.between(2, 6);
      if (random.chance(0.01)) column = 255 + random.between(0, 3);
      const letters = (() => {
        let n = column + 1;
        let out = "";
        while (n > 0) {
          out = String.fromCharCode(65 + ((n - 1) % 26)) + out;
          n = Math.floor((n - 1) / 26);
        }
        return out;
      })();
      const ref = random.chance(0.95) ? ` r="${letters}${row}"` : "";
      const text = cellText(random).replace(/&/g, "&amp;").replace(/</g, "&lt;");
      const kind = random.below(9);
      if (kind === 0) cells += `<c${ref} t="inlineStr"><is><t>${text}</t></is></c>`;
      else if (kind === 1) cells += `<c${ref} t="s"><v>${random.between(0, sharedCount)}</v></c>`;
      else if (kind === 2) cells += `<c${ref}><v>${random.pick(["1", "0.30000000000000004", "-7", "1e3", "12.50", "abc", ""])}</v></c>`;
      else if (kind === 3) cells += `<c${ref} t="b"><v>${random.pick(["1", "0", "true", "TRUE", "2"])}</v></c>`;
      else if (kind === 4) cells += `<c${ref} t="e"><v>#N/A</v></c>`;
      else if (kind === 5) cells += `<c${ref}><f>A1+1</f><v>${random.pick(["", "3"])}</v></c>`;
      else if (kind === 6) cells += `<c${ref} t="str"><f>"a"</f><v>${text}</v></c>`;
      else if (kind === 7) cells += `<c${ref} t="d"><v>2026-01-01</v></c>`;
      else cells += `<c${ref}/>`;
    }
    rows += `<row${random.chance(0.95) ? ` r="${row}"` : ""}${random.chance(0.1) ? ' hidden="1"' : ""}>${cells}</row>`;
  }
  return sheetXml(rows);
}

describe("workbooks are read cell for cell as they were", () => {
  test("1000 workbooks of one to three sheets, shared strings, inline strings, numbers, booleans, errors and formulas", () => {
    let cells = 0;
    for (let seed = 1; seed <= 1000; seed++) {
      const random = generator(seed * 7777);
      const shared = Array.from({ length: random.between(0, 6) }, () => cellText(random).replace(/&/g, "&amp;").replace(/</g, "&lt;"));
      const sheets = Array.from({ length: random.between(1, 3) }, () => randomSheet(random, shared.length));
      const bytes = workbook({ sheets, shared });
      const read = (f: typeof readXlsxNow): unknown => {
        try {
          return f(bytes);
        } catch (error) {
          return { refused: (error as Error).message };
        }
      };
      const before = read(readXlsxBefore);
      assert.deepEqual(read(readXlsxNow), before, `seed ${seed}`);
      if (typeof before === "object" && before !== null && "sheets" in before) cells += (before as { sheets: Array<{ rows: Array<{ cells: string[] }> }> }).sheets.reduce((n, s) => n + s.rows.reduce((m, r) => m + r.cells.length, 0), 0);
    }
    assert.ok(cells > 2000, `${cells} cells were compared`);
  });

  test("a cell of exactly 32,767 characters is kept whole and one of 32,768 is cut to 32,767 and said", () => {
    const text = (n: number): string => "w".repeat(n);
    const read = (n: number) => readXlsxNow(workbook({ sheets: [sheetXml(`<row r="1"><c r="A1" t="inlineStr"><is><t>${text(n)}</t></is></c></row>`)] }));
    assert.equal(read(32_767).sheets[0]?.rows[0]?.cells[0], text(32_767));
    assert.deepEqual(read(32_767).notes, []);
    const cut = read(32_768);
    assert.equal(cut.sheets[0]?.rows[0]?.cells[0], text(32_767));
    assert.equal(cut.notes.length, 1);
    assert.match(cut.notes[0]?.message ?? "", /^A cell holds more than the 32,767 characters that Excel keeps in a cell, and was cut to that: Sheet1!A1\./);
  });

  test("Excel writes a line break in a cell as CR LF, which is one character in the cell: a cell of exactly 32,767 is kept whole", () => {
    // 885 lines of 36 letters and a break, then 22 letters: 32,767 characters as Excel counts them, 33,652 as the file spells them.
    const text = ("w".repeat(36) + "\n").repeat(885) + "w".repeat(22);
    assert.equal(text.length, 32_767);
    const written = text.replace(/\n/g, "\r\n");
    const both = `<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>0</v></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>${written}</t></is></c></row>`;
    const read = readXlsxNow(workbook({ sheets: [sheetXml(both)], shared: [written] }));
    assert.deepEqual(read.sheets[0]?.rows.map((r) => r.cells), [[text, text], [text]]);
    assert.deepEqual(read.notes, []);
  });

  test("one more character than Excel keeps, written with CR LF, is cut and said; so is a cell of more than twice that, and half of a pair is not left", () => {
    const text = ("w".repeat(36) + "\n").repeat(885) + "w".repeat(23);
    const written = text.replace(/\n/g, "\r\n");
    const one = readXlsxNow(workbook({ sheets: [sheetXml(`<row r="1"><c r="A1" t="s"><v>0</v></c></row>`)], shared: [written] }));
    assert.equal(one.sheets[0]?.rows[0]?.cells[0], text.slice(0, 32_767));
    assert.match(one.notes[0]?.message ?? "", /^A cell holds more than the 32,767 characters that Excel keeps in a cell, and was cut to that: Sheet1!A1\./);

    const huge = readXlsxNow(workbook({ sheets: [sheetXml(`<row r="1"><c r="A1" t="s"><v>0</v></c></row>`)], shared: ["q".repeat(70_000)] }));
    assert.equal(huge.sheets[0]?.rows[0]?.cells[0], "q".repeat(32_767));
    assert.equal(huge.notes.length, 1);

    const emoji = readXlsxNow(workbook({ sheets: [sheetXml(`<row r="1"><c r="A1" t="s"><v>0</v></c></row>`)], shared: ["w".repeat(32_766) + "\u{1F600}"] }));
    const kept = emoji.sheets[0]?.rows[0]?.cells[0] ?? "";
    assert.equal(kept, "w".repeat(32_766), "the first half of an emoji is not kept");
    assert.equal(emoji.notes.length, 1, "and what was taken off is said");
  });

  test("white space after the cut is not a loss, whether the cut is at the limit or at twice it", () => {
    const read = readXlsxNow(workbook({ sheets: [sheetXml(`<row r="1"><c r="A1" t="s"><v>0</v></c></row>`)], shared: ["words" + " ".repeat(70_000)] }));
    assert.equal(read.sheets[0]?.rows[0]?.cells[0], "words");
    assert.deepEqual(read.notes, []);
  });

  test("white space after the cut is not a loss, and a cell of 40,000 spaces after its words is the words", () => {
    const read = readXlsxNow(workbook({ sheets: [sheetXml(`<row r="1"><c r="A1" t="inlineStr"><is><t xml:space="preserve">words${" ".repeat(40_000)}</t></is></c></row>`)] }));
    assert.equal(read.sheets[0]?.rows[0]?.cells[0], "words");
    assert.deepEqual(read.notes, []);
  });

  test("the cells that were cut are named, five of them, and the rest counted", () => {
    const big = "q".repeat(33_000);
    let rows = "";
    for (let r = 1; r <= 7; r++) rows += `<row r="${r}"><c r="A${r}" t="inlineStr"><is><t>${big}</t></is></c></row>`;
    const notes = readXlsxNow(workbook({ sheets: [sheetXml(rows)] })).notes;
    assert.match(notes[0]?.message ?? "", /^7 cells hold more than the 32,767 characters that Excel keeps in a cell, and were cut to that: Sheet1!A1, Sheet1!A2, Sheet1!A3, Sheet1!A4, Sheet1!A5 and others\./);
  });

  test("the text of a workbook is counted a cell at a time: 2,048 cells of 32,767 characters (64 MB) are read and one more is not", () => {
    const shared = ["w".repeat(32_767)];
    const rows = (n: number): string => {
      let out = "";
      for (let r = 1; r <= n; r++) out += `<row r="${r}">${Array.from({ length: 4 }, (_, c) => `<c r="${"ABCD"[c]}${r}" t="s"><v>0</v></c>`).join("")}</row>`;
      return out;
    };
    // 512 rows of 4 cells is 2,048 cells: 67,106,816 characters, which is 64 MiB less 1,024.
    const within = readXlsxNow(workbook({ sheets: [sheetXml(rows(512))], shared }));
    assert.equal(within.sheets[0]?.rows.length, 512);
    assert.throws(() => readXlsxNow(workbook({ sheets: [sheetXml(rows(513))], shared })), /more text in its cells than a table of questions has: over 64 million characters/);
  });

  test("the places of a workbook are counted: 16 million are read and one more is not", () => {
    // Rows of 1,000 cells cannot be (a row is cut at 256 columns), so the sheet is rows of one cell in column IV: 256 places each.
    const rows = (n: number): string => {
      let out = "";
      for (let r = 1; r <= n; r++) out += `<row r="${r}"><c r="IV${r}"><v>1</v></c></row>`;
      return out;
    };
    assert.equal(readXlsxNow(workbook({ sheets: [sheetXml(rows(62_500))] })).sheets[0]?.rows.length, 62_500);
    assert.throws(() => readXlsxNow(workbook({ sheets: [sheetXml(rows(62_501))] })), /over 16 million places in its rows/);
  });

  test("the places are counted over all the sheets of a workbook, and not for each", () => {
    const rows = (n: number): string => {
      let out = "";
      for (let r = 1; r <= n; r++) out += `<row r="${r}"><c r="IV${r}"><v>1</v></c></row>`;
      return out;
    };
    assert.throws(() => readXlsxNow(workbook({ sheets: [sheetXml(rows(40_000)), sheetXml(rows(40_000))] })), /places/);
  });

  test("two sheets that are two parts are two sheets", () => {
    const two = workbook({ sheets: [sheetXml('<row r="1"><c r="A1"><v>1</v></c></row>'), sheetXml('<row r="1"><c r="A1"><v>2</v></c></row>')] });
    assert.equal(readXlsxNow(two).sheets.length, 2);
  });

  test("the one part named in two spellings that differ only in case is one part twice", () => {
    // The format compares part names without regard to case, so xl/worksheets/SHEET1.xml is xl/worksheets/sheet1.xml.
    const bytes = workbook({ sheets: [sheetXml('<row r="1"><c r="A1"><v>1</v></c></row>')], relationships: [{ id: "rIdX", target: "worksheets/SHEET1.xml" }], entries: ["rIdX"] });
    assert.throws(() => readXlsxNow(bytes), /lists the sheets "Sheet1" and "Entry1", and both are the one part/);
  });

  test("two entries that name a part the file does not hold are not a part read twice", () => {
    const bytes = workbook({
      sheets: [sheetXml('<row r="1"><c r="A1"><v>1</v></c></row>')],
      relationships: [
        { id: "rIdA", target: "worksheets/missing.xml" },
        { id: "rIdB", target: "worksheets/missing.xml" },
      ],
      entries: ["rIdA", "rIdB"],
    });
    assert.equal(readXlsxNow(bytes).sheets.length, 1);
  });
});

// ---------------------------------------------------------------------------
// The row of names
// ---------------------------------------------------------------------------

function importCsv(text: string) {
  return (spreadsheetImporter.parseBytes as NonNullable<typeof spreadsheetImporter.parseBytes>)(Buffer.from(text, "utf8"), { file: "t.csv", at: "2026-01-01T00:00:00.000Z", author: "test" });
}

describe("the row of names of a table", () => {
  test("a name with a description, as a template writes it, is a name", () => {
    const r = importCsv("Type,Question - max 95 characters,Answer 1 - max 60 characters,Answer 2 - max 60 characters,Correct answer(s) - choose at least one\nMC,What is 2+2?,3,4,2\n");
    assert.equal(r.questions.length, 1);
    assert.equal(r.fileFindings.filter((f) => /not used/.test(f.message)).length, 0);
  });

  test("a name of 300 characters is looked at, and one of 301 is only text", () => {
    const pad = (n: number): string => `Question${" ".repeat(n - 8 - 1)}x`;
    assert.equal(pad(300).length, 300);
    // A column "Question" followed by spaces and a letter is not the name, whatever its length: the point is the line.
    const long = (name: string): string => `Type,${name},A,B,Correct\nMC,What is 2+2?,3,4,B\n`;
    assert.equal(importCsv(long("Question")).questions.length, 1);
    // "Question - max 99...9" is a name with a description that is an instruction, a limit of as many digits as the cell needs.
    const withNote = (length: number): string => `Question - max ${"9".repeat(length - "Question - max ".length)}`;
    const names = (text: string): boolean => !importCsv(text).fileFindings.some((f) => /No row names the columns/.test(f.message));
    assert.equal(withNote(300).length, 300);
    assert.equal(names(long(withNote(300))), true);
    assert.equal(names(long(withNote(301))), false, "a cell of more than 300 characters names no column");
  });

  test("a sheet that is not read is quoted by the first words of its first cells, and not by all of them", () => {
    const inline = (ref: string, text: string): string => `<c r="${ref}" t="inlineStr"><is><t>${text}</t></is></c>`;
    const names = `<row r="1">${["Type", "Question", "A", "B", "Correct"].map((t, i) => inline(`${"ABCDE"[i]}1`, t)).join("")}</row><row r="2">${["MC", "What is 2+2?", "3", "4", "B"].map((t, i) => inline(`${"ABCDE"[i]}2`, t)).join("")}</row>`;
    let prose = "";
    for (let r = 1; r <= 3; r++) prose += `<row r="${r}">${["A", "B", "C"].map((c) => inline(`${c}${r}`, "w".repeat(5_000))).join("")}</row>`;
    const read = (spreadsheetImporter.parseBytes as NonNullable<typeof spreadsheetImporter.parseBytes>)(workbook({ sheets: [sheetXml(names), sheetXml(prose)] }), { file: "t.xlsx", at: "2026-01-01T00:00:00.000Z", author: "test" });
    const said = read.fileFindings.map((f) => f.message).find((m) => /was not read/.test(m)) ?? "";
    assert.match(said, /^The sheet "Sheet2" was not read: it has 3 rows, and none of its first rows names a Question column\. It starts: w{77}\.\.\. \| w{77}\.\.\. \| w{77}\.\.\.$/);
  });

  test("a header cell that is a paragraph is quoted by its first words in the message about the columns not used", () => {
    const paragraph = `Notes ${"blah ".repeat(200)}`;
    const r = importCsv(`Type,Question,A,B,Correct,"${paragraph}"\nMC,What is 2+2?,3,4,B,x\n`);
    const said = r.fileFindings.map((f) => f.message).find((m) => /were not used|was not used|not used/.test(m)) ?? "";
    assert.match(said, /Notes blah blah/);
    assert.ok(said.length < 400, `${said.length} characters`);
    assert.match(said, /\.\.\./);
  });
});
