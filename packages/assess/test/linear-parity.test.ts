/**
 * The scanners that replaced patterns which read a long text again and again give what the patterns gave.
 *
 * `<[^>]*>` was fine on markup and quadratic on a text with many `<` and no `>`, and the same shape was in a dozen readers and writers
 * (`test/hostile-readers.test.ts` holds the speed). Replacing a pattern is a change that must not change what is found, and these tests hold
 * it: each keeps a copy of the pattern as it was, word for word, and gives it and its replacement the same few thousand generated texts,
 * made of the pieces that matter to the pattern (tags, a `<` or `>` alone, white space, line breaks, bars, quotation marks, entities).
 * A generated text is made of pieces and is not random characters, so that a tag is a tag more often than chance would make it. The seed
 * is fixed, and a failure names the text.
 *
 * Where a replacement is exact for any text (a tag is found by its first `>`, as it was) the texts include stray `<` and `>`. Where it is
 * exact for text the engine wrote (a tag of a placeholder never holds a `<` or `>` inside, since the sanitizer escapes both in a value)
 * the texts keep the inside of a tag clean and put the strays between tags.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { withoutBlockBreaks } from "../src/export/gift.ts";
import { OPTION as AIKEN_OPTION, ANSWER as AIKEN_ANSWER } from "../src/import/aiken.ts";
import { CATEGORY_LINE } from "../src/import/gift.ts";
import { tagAttributes } from "../src/import/html-pictures.ts";
import { LABELLED } from "../src/import/standard-text-relabel.ts";
import { isAnswerKeyHeading, NO_KEY, SECTION_HEADING, TF_CHOICES } from "../src/import/standard-text-scan.ts";
import { parseDelimited } from "../src/import/table-csv.ts";
import { findElements, findTags, hasTag, markupTokens, placeholderRefs, replaceBareElements, replaceDelimited, replaceElements, replacePlaceholders, replaceTags, stripTags } from "../src/model/markup-scan.ts";
import { createQuestion } from "../src/model/create.ts";
import { capFindings, finding, isCapSummary, MOST_FINDINGS_OF_A_KIND, verdictFrom, type Finding } from "../src/model/findings.ts";
import { largest, pushAll, smallest } from "../src/model/lists.ts";
import { collectRefs, decodeEntities, foldTypography, richTextToPlain } from "../src/model/richtext.ts";
import { readTableHtml, replaceTables } from "../src/model/table.ts";
import { textWithMath } from "../src/quality/bank.ts";
import { normalForm, wordTokens } from "../src/quality/items.ts";

// ---------------------------------------------------------------------------
// Generated texts
// ---------------------------------------------------------------------------

function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** `count` texts of up to `longest` pieces from `pieces`. */
function texts(seed: number, pieces: readonly string[], count: number, longest: number): string[] {
  const next = random(seed);
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    let text = "";
    const n = Math.floor(next() * (longest + 1));
    for (let k = 0; k < n; k++) text += pieces[Math.floor(next() * pieces.length)] as string;
    out.push(text);
  }
  return out;
}

/** Every text must give the same from the old and the new, and enough of them must give something, or the test proves nothing. */
function same<T>(inputs: readonly string[], old: (s: string) => T, now: (s: string) => T, label: string, atLeastDifferentFromInput = 0): void {
  let changed = 0;
  for (const input of inputs) {
    const expected = old(input);
    const got = now(input);
    if (JSON.stringify(got) !== JSON.stringify(expected)) assert.fail(`${label}: for ${JSON.stringify(input)} the pattern gave ${JSON.stringify(expected)} and the scanner gave ${JSON.stringify(got)}`);
    if (JSON.stringify(expected) !== JSON.stringify(input)) changed++;
  }
  assert.ok(changed >= atLeastDifferentFromInput, `${label}: only ${changed} of ${inputs.length} texts were changed by it, which is too few to prove anything`);
}

const ANGLES = ["<", ">", "a", " ", "/", '"', "=", "\n", "-", "<a>", "</a>", "&lt;", "<<", ">>", "<>", "b c"];

// ---------------------------------------------------------------------------
// Tags found by their first ">"
// ---------------------------------------------------------------------------

describe("tags are found by their first '>' as they were", () => {
  test("stripTags is text.replace(/<[^>]*>/g, '')", () => {
    same(texts(1, ANGLES, 20000, 14), (s) => s.replace(/<[^>]*>/g, ""), stripTags, "stripTags", 5000);
  });

  test("hasTag is /<[a-z][^>]*>/i.test", () => {
    same(texts(2, [...ANGLES, "<B", "<1", "<p ", "A>"], 20000, 10), (s) => /<[a-z][^>]*>/i.test(s), hasTag, "hasTag");
  });

  test("replaceTags is the replace of <img\\b[^>]*>, and findTags the matches of <(/?)table\\b[^>]*>", () => {
    const pieces = [...ANGLES, "<img ", "<IMG", "<img", "<imgx>", "<img src=\"a\">", "<table>", "</table >", "<TABLE border=1>", "<tablex>", "<table", "</table"];
    const inputs = texts(3, pieces, 20000, 10);
    same(inputs, (s) => s.replace(/<img\b[^>]*>/gi, (tag) => `[${tag}]`), (s) => replaceTags(s, /<img\b/gi, (tag) => `[${tag}]`), "replaceTags", 3000);
    same(inputs, (s) => [...s.matchAll(/<(\/?)table\b[^>]*>/gi)].map((m) => [m.index, m[0], m[1]]), (s) => findTags(s, /<\/?table\b/gi).map((t) => [t.index, t.text, t.text.startsWith("</") ? "/" : ""]), "findTags", 3000);
  });

  test("replaceDelimited is the replace of [HTML]...[/HTML]", () => {
    const pieces = ["[HTML]", "[html]", "[/HTML]", "[/html]", "[HTML", "x", " ", "\n", "[", "]", "<b>", "[/HTML ]"];
    same(texts(4, pieces, 20000, 10), (s) => s.replace(/\[HTML\]([\s\S]*?)\[\/HTML\]/gi, (_w, inner: string) => `{${inner}}`), (s) => replaceDelimited(s, /\[HTML\]/gi, /\[\/HTML\]/gi, (inner) => `{${inner}}`), "replaceDelimited", 3000);
  });

  test("replaceElements is the replace of <(strong|em|u)\\b[^>]*>[\\s\\S]*?</\\1>", () => {
    const pieces = ["<strong>", "</strong>", "<STRONG class=a>", "</Strong >", "<em>", "</em>", "<u>", "</u>", "<ul>", "</ul>", "<u", "x", " ", "\n", "<", ">", "<b>", "</STRONG>", "<emx>", "<strong", "</u >"];
    same(texts(5, pieces, 20000, 12), (s) => s.replace(/<(strong|em|u)\b[^>]*>[\s\S]*?<\/\1>/gi, " "), (s) => replaceElements(s, ["strong", "em", "u"], " "), "replaceElements", 3000);
  });

  test("withoutBlockBreaks (dropAfterTags) is the replace of (</?BLOCK\\b[^>]*>)[ \\t]*\\n", () => {
    const BLOCK = "(?:p|div|ul|ol|li|table|thead|tbody|tfoot|tr|td|th|pre|blockquote|h[1-6]|hr|br)";
    const after = new RegExp(`(</?${BLOCK}\\b[^>]*>)[ \\t]*\\n`, "gi");
    const before = new RegExp(`\\n[ \\t]*(?=</?${BLOCK}\\b)`, "gi");
    const pieces = ["<p", "<P>", "</p>", "<br>", "<br/>", "<BR", "<div class=x>", "</li>", "<h2>", "<span>", "<pre>", "\n", " ", "\t", "x", "<", ">", "\n\n", "<hr", "<px>", "</td", "<tr><td>"];
    same(texts(6, pieces, 20000, 14), (s) => s.replace(after, "$1").replace(before, ""), withoutBlockBreaks, "withoutBlockBreaks", 3000);
  });

  test("markupTokens is text.match(/<[^>]+>|[^<]+/g) ?? []", () => {
    same(texts(7, ANGLES, 20000, 14), (s) => s.match(/<[^>]+>|[^<]+/g) ?? [], markupTokens, "markupTokens");
  });
});

// ---------------------------------------------------------------------------
// Placeholders
// ---------------------------------------------------------------------------

/** Pieces of rich text as the engine writes it, and a few strays between the tags. A tag is whole: nothing inside one holds a `<` or `>`. */
const PLACEHOLDER_PIECES = [
  '<oa-media ref="m1"></oa-media>',
  '<oa-media ref="m2"> </oa-media>',
  '<oa-media ref="m3">\n</oa-media>',
  '<oa-media  data-x="1"   ref = "m4" ></oa-media>',
  '<OA-MEDIA REF="m5"></OA-MEDIA>',
  '<oa-media ref="m6" ref="m7"></oa-media>',
  '<oa-media xref="m8"></oa-media>',
  '<oa-media data-ref="m9"></oa-media>',
  '<oa-media-x ref="m10"></oa-media>',
  '<oa-mediaX ref="m11"></oa-media>',
  '<oa-media ref=\'m12\'></oa-media>',
  '<oa-media ref="m13">',
  '<oa-media>',
  '<oa-media ref="">',
  '<oa-math ref="e1"></oa-math>',
  '<oa-math ref="e2">  </oa-math>',
  '<OA-MATH ref="e3"></oa-math>',
  '<oa-math ref="e4">',
  '<oa-media\tref="t1"></oa-media>',
  "</oa-media>",
  " </oa-media>",
  "</oa-math>",
  "</oa-media >",
  "<p>",
  "</p>",
  "word",
  " ",
  "\n",
  "<",
  ">",
  "a < b",
  "x > y",
  "&amp;",
];

describe("placeholders are found as they were, in text the engine wrote", () => {
  for (const kind of ["media", "math"] as const) {
    test(`replacePlaceholders is the replace of the <oa-${kind}> pattern`, () => {
      const old = new RegExp(`<oa-${kind}\\b[^>]*\\bref\\s*=\\s*"([^"]*)"[^>]*>\\s*<\\/oa-${kind}>`, "gi");
      same(
        texts(8, PLACEHOLDER_PIECES, 20000, 8),
        (s) => s.replace(old, (whole, ref: string) => `[${ref}|${whole.length}]`),
        (s) => replacePlaceholders(s, kind, (ref, whole) => `[${ref}|${whole.length}]`),
        `replacePlaceholders ${kind}`,
        2000,
      );
    });
  }

  test("placeholderRefs, and so collectRefs, find the references the pattern found, in order", () => {
    const old = (text: string): { media: string[]; math: string[] } => {
      const media: string[] = [];
      const math: string[] = [];
      const pattern = /<oa-(media|math)\s[^>]*ref\s*=\s*"([^"]*)"/gi;
      let m: RegExpExecArray | null;
      while ((m = pattern.exec(text)) !== null) {
        if ((m[1] as string).toLowerCase() === "media") media.push(m[2] as string);
        else math.push(m[2] as string);
      }
      return { media, math };
    };
    const inputs = texts(9, PLACEHOLDER_PIECES, 20000, 8);
    let found = 0;
    for (const input of inputs) {
      const expected = old(input);
      assert.deepEqual(collectRefs(input), expected, `collectRefs for ${JSON.stringify(input)}`);
      assert.deepEqual(placeholderRefs(input).filter((r) => r.kind === "media").map((r) => r.ref), expected.media);
      found += expected.media.length + expected.math.length;
    }
    assert.ok(found > 3000, `only ${found} references were found`);
  });

  test("richTextToPlain is what it was, for rich text of every shape and for a plain text with strays in it", () => {
    const oldPlain = (content: string): string => {
      const withBreaks = content
        .replace(/<\s*br\s*\/?\s*>/gi, "\n")
        .replace(/<\s*\/\s*(p|li|tr|div|blockquote|h[1-6])\s*>/gi, "\n")
        .replace(/<\s*\/\s*(td|th)\s*>/gi, " ")
        .replace(/<oa-media[^>]*>\s*<\/oa-media>/gi, " ")
        .replace(/<oa-math[^>]*>\s*<\/oa-math>/gi, " ")
        .replace(/<[^>]*>/g, "");
      return decodeEntities(withBreaks)
        .replace(/[ \t]+/g, " ")
        .replace(/\s*\n\s*/g, "\n")
        .trim();
    };
    const pieces = [...PLACEHOLDER_PIECES, "<br>", "<br/>", "< br >", "<br />", "<BR/>", "</td>", "</TH >", "</tr>", "</li>", "<li>", "<table>", "<td>", "<h2>", "</h2>", "&lt;b&gt;", "&#65;", "\u00a0", "  \t", "<!-- c -->", "<br"];
    same(texts(10, pieces, 20000, 12), (s) => oldPlain(s), (s) => richTextToPlain(s), "richTextToPlain", 5000);
  });

  test("textWithMath, which the check for copies reads a question with, writes an equation in as the pattern it replaced did", () => {
    // Verbatim from quality/bank.ts before `replacePlaceholders` took its place (a stored stem of 40,000 `<oa-math ` took seven seconds).
    const oldTextWithMath = (latex: ReadonlyMap<string, string>, content: string): string =>
      richTextToPlain(content.replace(/<oa-math\s[^>]*ref\s*=\s*"([^"]*)"[^>]*>\s*<\/oa-math>/gi, (_whole, ref: string) => ` ${latex.get(ref) ?? ref} `));
    const latex = new Map([["e1", "x^2"], ["e2", "\\frac{a}{b}"], ["e3", "a < b"], ["e4", ""]]);
    // A placeholder as the engine writes it (a reference, in any case and spacing), the ones it does not know, and text round them. Like
    // the placeholder tests above, no piece is the start of a tag that is never closed: the sanitizer escapes a stray `<oa-math`, so text
    // the engine wrote has none, and for a stored text that was written by hand `replacePlaceholders` reads the stray start as text.
    const pieces = [
      '<oa-math ref="e1"></oa-math>', '<oa-math ref="e2"> </oa-math>', '<oa-math ref="e3">\n</oa-math>', '<oa-math ref="e4"></oa-math>', '<oa-math ref="zz"></oa-math>',
      '<oa-math  data-x="1"   ref = "e1" ></oa-math>', '<OA-MATH REF="e2"></OA-MATH>', '<oa-math ref="e1" ref="e2"></oa-math>', "<oa-math ref='e1'></oa-math>",
      '<oa-math ref="e1">', "</oa-math>", "<oa-math>", '<oa-media ref="m1"></oa-media>', "<p>", "</p>", "word ", " ", "\n", "<br>", "&lt;", "x ", "<b>", "</b>",
      "<table><tr><td>", "</td></tr></table>", "<oa-math ref=\"e1\"></oa-math >",
    ];
    same(texts(51, pieces, 30000, 10), (s) => oldTextWithMath(latex, s), (s) => textWithMath(latex, { format: "rich", content: s }), "textWithMath", 5000);
    // With an equation in it, and with the reference written in the place of one the question does not carry.
    assert.equal(textWithMath(latex, { format: "rich", content: '<p>Solve <oa-math ref="e1"></oa-math> and <oa-math ref="zz"></oa-math>.</p>' }), "Solve x^2 and zz .");
  });

  test("replaceBareElements is the replace of <oa-media[^>]*>\\s*</oa-media>", () => {
    same(
      texts(11, PLACEHOLDER_PIECES, 20000, 8),
      (s) => s.replace(/<oa-media[^>]*>\s*<\/oa-media>/gi, "#"),
      (s) => replaceBareElements(s, "oa-media", "#"),
      "replaceBareElements",
      2000,
    );
  });
});

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

describe("a table in the text is read as it was", () => {
  const TABLE_TAG = /<(\/?)table\b[^>]*>/gi;
  const oldReplaceTables = (html: string, replace: (table: string, index: number) => string): string => {
    let out = "";
    let from = 0;
    let depth = 0;
    let start = -1;
    let index = 0;
    for (const tag of html.matchAll(TABLE_TAG)) {
      const at = tag.index as number;
      if (tag[1] === "") {
        if (depth === 0) start = at;
        depth++;
      } else if (depth > 0 && --depth === 0) {
        out += html.slice(from, start) + replace(html.slice(start, at + tag[0].length), index++);
        from = at + tag[0].length;
      }
    }
    if (depth > 0) {
      out += html.slice(from, start) + replace(html.slice(start), index++);
      from = html.length;
    }
    return out + html.slice(from);
  };
  const attribute = (tag: string, name: string): number => {
    const value = Number(new RegExp(`\\b${name}\\s*=\\s*"?(\\d{1,3})"?`, "i").exec(tag)?.[1]);
    return Number.isInteger(value) && value >= 1 ? value : 1;
  };
  const oldReadTableHtml = (table: string): { rows: unknown[]; text: string } => {
    const text = richTextToPlain(table.replace(/<\/(td|th)\s*>/gi, " | ").replace(/<\/tr\s*>/gi, "\n").replace(/\s*\|\s*(?=\n|$)/g, ""));
    const tags = [...table.matchAll(TABLE_TAG)].filter((t) => t[1] === "").length;
    if (tags !== 1) return { rows: [], text };
    const rows: unknown[] = [];
    for (const row of table.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr\s*>/gi)) {
      const cells: unknown[] = [];
      for (const cell of (row[1] as string).matchAll(/<(td|th)\b([^>]*)>([\s\S]*?)<\/\1\s*>/gi)) {
        cells.push({ header: (cell[1] as string).toLowerCase() === "th", text: richTextToPlain(cell[3] as string), colspan: attribute(cell[2] as string, "colspan"), rowspan: attribute(cell[2] as string, "rowspan") });
      }
      if (cells.length > 0) rows.push(cells);
    }
    return { rows, text };
  };

  const pieces = [
    "<table>", "</table>", "<TABLE border=1>", "<table", "</table", "<thead>", "</thead>", "<tbody>", "</tbody>",
    "<tr>", "</tr>", "<TR class=a>", "</tr >", "<tr", "<td>", "</td>", "<TD colspan=\"2\">", "</TD >", "<td colspan=3 rowspan='2'>", "<td", "</td",
    "<th>", "</th>", "<th scope=\"col\">", "</TH>", "<TH>", "<Th rowspan=2>", "<p>", "</p>", "x", "y z", " ", "\n", "\t", " | ", "|", "||", "a | b", "&amp;", "<", ">", "<br>",
    '<oa-media ref="m1"></oa-media>', "\u00a0",
  ];
  // Texts that are mostly one table with rows and cells, closed or not, and texts of any pieces.
  const cellPieces = ["<tr>", "</tr>", "<td>", "</td>", "<th>", "<TH>", "</th>", "<TD colspan=\"2\">", "</td >", "x", "y z", " ", "\n", " | ", "|", "\t", "<td", "</tr", "<br>", "<p>a</p>", "&amp;"];
  const inputs = [...texts(12, pieces, 12000, 24), ...texts(21, cellPieces, 12000, 30).map((rows, i) => `<table>${rows}${i % 3 === 0 ? "" : "</table>"}`)];

  test("replaceTables replaces the same tables", () => {
    same(inputs, (s) => oldReplaceTables(s, (t, i) => `{${i}:${t.length}}`), (s) => replaceTables(s, (t, i) => `{${i}:${t.length}}`), "replaceTables", 3000);
  });

  test("readTableHtml reads the same rows, cells and words", () => {
    let withRows = 0;
    for (const input of inputs) {
      const expected = oldReadTableHtml(input);
      const got = readTableHtml(input);
      if (JSON.stringify(got) !== JSON.stringify(expected)) assert.fail(`readTableHtml for ${JSON.stringify(input)}: ${JSON.stringify(expected)} against ${JSON.stringify(got)}`);
      if (expected.rows.length > 0) withRows++;
    }
    assert.ok(withRows > 500, `only ${withRows} tables had rows`);
  });

  test("the bars that end a row come out as they did, for texts of bars, white space and line breaks", () => {
    const barPieces = ["|", " ", "\n", "\t", "a", "\u00a0", "  ", "\n\n", "| ", " |", "\u2028"];
    same(
      texts(13, barPieces, 30000, 12),
      (s) => oldReadTableHtml(s).text,
      (s) => readTableHtml(s).text,
      "row-end bars",
      2000,
    );
  });

  test("findElements finds the cells of a row as the pattern did, and 'dead' names are skipped without changing the result", () => {
    const old = (s: string): unknown[] => [...s.matchAll(/<(td|th)\b([^>]*)>([\s\S]*?)<\/\1\s*>/gi)].map((m) => [m.index, (m[1] as string), m[2], m[3]]);
    const now = (s: string): unknown[] => findElements(s, ["td", "th"]).map((e) => [e.index, e.name, e.open.slice(1 + e.name.length, -1), e.inner]);
    same(texts(14, pieces, 20000, 24), old, now, "findElements", 2000);
  });

  test("a closing tag with white space before its '>' counts for a cell and does not for an emphasis, as the two patterns had it", () => {
    assert.equal(findElements("<td>a</td >", ["td"]).length, 1);
    assert.equal(findElements("<u>a</u >", ["u"], true).length, 0);
    assert.equal(findElements("<u>a</u>", ["u"], true).length, 1);
  });
});

// ---------------------------------------------------------------------------
// Patterns that read the white space round a capture again, or the length of a name
// ---------------------------------------------------------------------------

describe("a pattern that begins with white space or ends in a run starts once for a run", () => {
  test("(?<!\\s)\\s*\\n\\s* gives what \\s*\\n\\s* gave", () => {
    const pieces = ["\n", " ", "\t", "a", "\u00a0", "\u2028", "\r", "b ", "  \n  "];
    same(texts(15, pieces, 20000, 14), (s) => s.replace(/\s*\n\s*/g, " "), (s) => s.replace(/(?<!\s)\s*\n\s*/g, " "), "newline runs", 5000);
  });

  test("normalForm and wordTokens are what they were", () => {
    const tidy = (text: string): string =>
      foldTypography(text)
        .normalize("NFC")
        .toLowerCase()
        .replace(/\s+/g, " ")
        .trim()
        .replace(/^["'“”‘’(\[]+/u, "")
        .replace(/["'“”‘’)\].!?;:,]+$/u, "")
        .trim();
    const oldTokens = (text: string): string[] =>
      foldTypography(text)
        .normalize("NFC")
        .toLowerCase()
        .split(/\s+/)
        .map((token) => token.replace(/^[^\p{L}\p{M}\p{N}\p{S}-]+/u, "").replace(/[^\p{L}\p{M}\p{N}\p{S}+#]+$/u, ""))
        .filter((token) => token !== "");
    const pieces = ["a", "B", " ", ".", ",", ";", ":", "!", "?", "\"", "'", "“", "”", ")", "(", "]", "[", "-", "+", "#", "é", "\u00a0", "😀", "2", "…", "\n", "x y"];
    const inputs = texts(16, pieces, 20000, 14);
    same(inputs, tidy, normalForm, "normalForm", 5000);
    same(inputs, oldTokens, wordTokens, "wordTokens", 5000);
  });

  test("the run-start form of a pattern that ends in a run gives what the plain form gave", () => {
    const pieces = ["a", " ", "_", ".", ":", "…", "-", "\n", "x", ",", ";", "😀", "\u00a0"];
    const inputs = texts(17, pieces, 20000, 14);
    same(inputs, (s) => s.replace(/[\s_.:…-]+$/u, ""), (s) => s.replace(/(?<![\s_.:…-])[\s_.:…-]+$/u, ""), "article cue", 5000);
    same(inputs, (s) => s.replace(/^[\s:]+|[\s:]+$/g, ""), (s) => s.replace(/^[\s:]+|(?<![\s:])[\s:]+$/g, ""), "title colons", 5000);
  });

  test("the Aiken option and answer patterns and the GIFT category pattern capture what the lazy ones did", () => {
    const oldOption = /^\s*([A-Za-z])\s*[.)]\s+(\S.*?)\s*$/;
    const oldAnswer = /^\s*ANSWER\s*:\s*(.*?)\s*$/i;
    const oldCategory = /^\s*\$CATEGORY:\s*(.*?)\s*$/i;
    const pieces = ["A", "b", ".", ")", " ", "\t", "x", "ANSWER", "answer", ":", "$CATEGORY", "\u2028", "\u2029", "\u00a0", "\v", "\f", "\ufeff", "yes", "\r", "\n", "  ", "a b", "(", "-", "A. ", "b) ", "ANSWER: ", "$CATEGORY: ", " Answer:", "ANSWER:", "$CATEGORY:", "ANSWER:  ", "$CATEGORY:\t"];
    // The two that have a capture that may be absent say undefined for it where the lazy ones said "": the same capture, nothing in it.
    const groups = (m: RegExpExecArray | null): Array<string | null> | null => (m === null ? null : [...m].map((g) => g ?? ""));
    const inputs = texts(18, pieces, 60000, 10);
    let matched = 0;
    let emptyCaptures = 0;
    for (const input of inputs) {
      for (const [old, now] of [[oldOption, AIKEN_OPTION], [oldAnswer, AIKEN_ANSWER], [oldCategory, CATEGORY_LINE]] as const) {
        const expected = old.exec(input);
        const got = now.exec(input);
        assert.deepEqual(groups(got), groups(expected), `${String(now)} for ${JSON.stringify(input)}`);
        if (expected !== null) matched++;
        if (expected !== null && expected[1] === "") emptyCaptures++;
      }
    }
    assert.ok(matched > 3000, `only ${matched} lines matched`);
    assert.ok(emptyCaptures > 200, `only ${emptyCaptures} lines had an empty capture, which is the case that changed`);
  });

  test("the patterns of the text scanner that shared a run of white space between several runs match the same lines", () => {
    const oldChoices = /^true\s*(?:\/|\||-|\bor\b|\s{2,}|\t)\s*false\.?$/i;
    const oldNoKey = /^\s*(?:[-–—]*|n\/?a|none)\s*$/i;
    const oldLabelled = /^\s*\*?\s*\(?[a-tA-T]\s*[.):]\s/;
    const choicePieces = ["true", "True", "FALSE", "false", ".", " ", "\t", "  ", "/", "|", "-", "or", "OR", "Or ", " ", "\n", "x", "false.", "truefalse", "true or ", " "];
    const keyPieces = ["-", "–", "—", "n/a", "N/A", "na", "none", "None", " ", "\t", "\n", "x", "--", " ", ""];
    const labelPieces = ["*", " ", "(", "a", "B", "t", "u", ".", ")", ":", "\t", "x", "(a)", "a)", "*b.", "\n", "  "];
    // Every way the two words and what stands between them can be written, and then chance.
    const structured: string[] = [];
    for (const first of ["true", "TRUE"]) for (const between of ["", " ", "  ", "\t", " \t ", "/", " / ", "|", "-", " - ", " or ", "or", " OR ", "  ", " ", "\n", "\n\n", " ", "  /  ", "x"]) for (const second of ["false", "False.", "false..", "fals"]) structured.push(first + between + second);
    for (const [seed, pieces, old, now, name, extra] of [
      [31, choicePieces, oldChoices, TF_CHOICES, "true or false", structured],
      [32, keyPieces, oldNoKey, NO_KEY, "no key", []],
      [33, labelPieces, oldLabelled, LABELLED, "labelled", []],
    ] as const) {
      let matched = 0;
      for (const input of [...extra, ...texts(seed, pieces, 20000, 8)]) {
        assert.equal(now.test(input), old.test(input), `${name}: ${JSON.stringify(input)}`);
        if (old.test(input)) matched++;
      }
      assert.ok(matched > (name === "true or false" ? 60 : 300), `${name}: only ${matched} matched`);
    }
  });

  test("the section heading and the answer key heading match the lines they matched, with every tail a person could type", () => {
    // Verbatim from the source before the optional colon was taken with the white space in front of it.
    const oldSection =
      /^\s*(?:chapter\s+\w+(?:-\w+)?\s+)?(?:in[\s-]*depth\s+)?(fill[\s-]+in[\s-]+(?:the[\s-]+)?blanks?|true\s*(?:\/|-|or|and)\s*false|multiple[\s-]+choice|multiple[\s-]+(?:response|answer)s?|short[\s-]+answers?(?:\s*\/\s*essays?)?|essays?|matching)(?:\s+(?:questions?|items?))?\s*:?\s*$/i;
    const oldKeyHeading = (text: string): boolean => /\banswer\s+key\s*[:.]?\s*$/i.test(text) && text.split(/\s+/).length <= 8 && !text.includes("?");

    const sectionHeads = ["Fill in the Blank", "fill-in-the-blanks", "Fill  In  Blank", "True/False", "True / False", "true or false", "TRUE-FALSE", "True and False", "True False", "Multiple Choice", "multiple-choice", "Multiple Response", "Multiple Answers", "Multiple answer", "Short Answer", "Short Answers/Essays", "short-answer / essay", "Essay", "ESSAYS", "Matching", "Chapter 7 Essay", "Chapter 3-2 Matching", "In-Depth Essay", "Chapter 1 In Depth Multiple Choice", "Indepth Matching", "Essay Questions"];
    const keyHeads = ["Answer Key", "answer key", "ANSWER  KEY", "Answer\tKey", "Answer\u00a0Key", "Chapter 7 Answer Key", "Chapter 7: Answer Key", "The Answer Key", "answer keys", "Answers Key", "Answer Key Answer Key", "A B C D E F G Answer Key", "Answer Key?"];
    const tails = ["", " ", "  ", "\t", "\u00a0", ":", " :", ": ", " : ", "  :  ", "\t:\t", "\u00a0:\u00a0", ".", " .", ". ", "..", ":.", ".:", "::", ": :", " ?", "?", "x", " x", ":x", " :x", "s", " questions", " Questions", " question:", " Questions :", " ITEMS ", " item  :  ", " questionss", "\n", "\u2028", "\u2028:"];
    const structured: string[] = [];
    for (const head of [...sectionHeads, ...keyHeads]) for (const lead of ["", " ", "\t"]) for (const tail of tails) structured.push(lead + head + tail);
    const pieces = ["Answer", " Key", "answer key", "Essay", "essays", "True/False", "True", " or ", "False", "Multiple", " Choice", "Multiple Choice", " Questions", " items", " ", "  ", "\t", "\u00a0", ":", " :", ".", "?", "x", "Chapter 3 ", "In-Depth ", "Fill in the Blank", "Short Answer", "/", "Matching", "-"];
    const inputs = [...structured, ...texts(41, pieces, 40000, 9)];

    let sectionMatched = 0;
    let keyMatched = 0;
    for (const input of inputs) {
      const expected = oldSection.exec(input);
      const got = SECTION_HEADING.exec(input);
      assert.deepEqual(got === null ? null : [...got], expected === null ? null : [...expected], `section heading for ${JSON.stringify(input)}`);
      if (expected !== null) sectionMatched++;
      assert.equal(isAnswerKeyHeading(input), oldKeyHeading(input), `answer key heading for ${JSON.stringify(input)}`);
      if (oldKeyHeading(input)) keyMatched++;
    }
    assert.ok(inputs.length > 40000);
    assert.ok(sectionMatched > 400, `only ${sectionMatched} section headings matched`);
    assert.ok(keyMatched > 100, `only ${keyMatched} answer key headings matched`);
  });

  test("the attributes of a tag are the same ones, by name and value", () => {
    const old = (tag: string): Array<[string, string]> => {
      const attrs = new Map<string, string>();
      for (const m of tag.matchAll(/([a-zA-Z][-a-zA-Z0-9:]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) attrs.set((m[1] as string).toLowerCase(), decodeEntities(m[2] ?? m[3] ?? ""));
      return [...attrs];
    };
    const pieces = ["<img", " ", "src", "alt", "=", '"', "'", "x", "-", ":", "1", "data-a", "&amp;", "\n", "role", "A", "9", "\t", "a b", "--", "::"];
    same(texts(19, pieces, 30000, 16), old, (s) => [...tagAttributes(s)], "tagAttributes", 3000);
  });
});

// ---------------------------------------------------------------------------
// The CSV reader
// ---------------------------------------------------------------------------

describe("the CSV reader", () => {
  test("a quotation mark opens a quoted part where the cell holds only white space so far, as it did", () => {
    // The reader as it was: the same loop, asking the cell itself whether it was blank at every quotation mark.
    const old = (raw: string, sep: string): Array<{ number: number; cells: string[] }> => {
      const text = raw.replace(/^﻿/, "");
      const rows: Array<{ number: number; cells: string[] }> = [];
      let row: string[] = [];
      let cell = "";
      let quoted = false;
      let number = 1;
      const endCell = (): void => {
        row.push(cell.trim());
        cell = "";
      };
      const endRow = (): void => {
        endCell();
        if (row.some((c) => c !== "")) rows.push({ number, cells: row.slice(0, 256) });
        row = [];
        number++;
      };
      for (let i = 0; i < text.length; i++) {
        const ch = text[i] as string;
        if (quoted) {
          if (ch === '"') {
            if (text[i + 1] === '"') {
              cell += '"';
              i++;
            } else quoted = false;
          } else cell += ch;
        } else if (ch === '"' && cell.trim() === "") quoted = true;
        else if (ch === sep) endCell();
        else if (ch === "\n") endRow();
        else if (ch === "\r") {
          if (text[i + 1] === "\n") i++;
          endRow();
        } else cell += ch;
      }
      if (cell !== "" || row.length > 0) endRow();
      return rows;
    };
    const pieces = ['"', '""', ",", "\n", "\r", "\r\n", " ", "\t", "a", "bc", "\u00a0", "\u2028", ";", "\ufeff", "x y"];
    const inputs = texts(20, pieces, 20000, 16);
    let multi = 0;
    for (const input of inputs) {
      const expected = old(input, ",");
      const got = parseDelimited(input, undefined, ",").rows;
      assert.deepEqual(got, expected, `csv for ${JSON.stringify(input)}`);
      if (expected.length > 1) multi++;
    }
    assert.ok(multi > 2000, `only ${multi} texts had more than one row`);
  });
});

// ---------------------------------------------------------------------------
// Lists and findings
// ---------------------------------------------------------------------------

describe("lists that can be as long as a file", () => {
  test("pushAll, largest and smallest do what a spread, Math.max and Math.min did, at any length", () => {
    const target = [1, 2];
    pushAll(target, [3, 4]);
    pushAll(target, new Set([5]));
    assert.deepEqual(target, [1, 2, 3, 4, 5]);
    assert.equal(largest([3, 9, 2]), 9);
    assert.equal(smallest([3, 9, 2]), 2);
    assert.equal(largest([]), 0, "no numbers: the one asked for, not -Infinity");
    assert.equal(smallest([], 7), 7);
    assert.equal(largest([-5, -2]), -2);
    assert.ok(Number.isNaN(largest([1, Number.NaN, 3])), "a NaN stays one, as it does in Math.max");
    assert.ok(Number.isNaN(smallest([1, Number.NaN, 3])));
    const big = Array.from({ length: 500000 }, (_, i) => i);
    const into: number[] = [];
    pushAll(into, big);
    assert.equal(into.length, 500000);
    assert.equal(largest(big), 499999);
    assert.equal(smallest(big), 0);
  });
});

describe("the findings of one kind that a question lists", () => {
  const f = (code: string, n: number, severity: Finding["severity"] = "error"): Finding => finding(code, severity, `finding ${n}`, { field: `body.options.${n}` });

  test("a list with no more than the limit of any kind is returned as it is, in a new list", () => {
    const list = [f("a", 1), f("b", 2), f("a", 3)];
    const capped = capFindings(list);
    assert.deepEqual(capped, list);
    assert.notEqual(capped, list);
  });

  test("the rest of a kind are counted in one finding of that kind, with the first of them and the highest severity, and no other kind is touched", () => {
    const list: Finding[] = [];
    for (let i = 0; i < 40; i++) list.push(f("many", i, i === 33 ? "error" : "warn"));
    list.push(f("one", 0));
    const capped = capFindings(list, 10);
    assert.equal(capped.filter((x) => x.code === "many").length, 11, "ten and the count");
    assert.equal(capped.filter((x) => x.code === "one").length, 1);
    assert.deepEqual(capped.slice(0, 10), list.slice(0, 10), "the first ten, in order");
    const more = capped.find((x) => x.message.includes("more findings of this kind")) as Finding;
    assert.match(more.message, /^30 more findings of this kind were not listed\. The first of them was: finding 10$/);
    assert.equal(more.code, "many");
    assert.equal(more.severity, "error", "the highest of those left out");
    assert.equal(more.field, "body.options.10");
  });

  test("the limit is a few dozen, and a list of 130,000 is cut to it", () => {
    assert.ok(MOST_FINDINGS_OF_A_KIND >= 10 && MOST_FINDINGS_OF_A_KIND <= 50);
    const list = Array.from({ length: 130000 }, (_, i) => f("many", i));
    const capped = capFindings(list);
    assert.equal(capped.length, MOST_FINDINGS_OF_A_KIND + 1);
  });

  test("the finding that counts the rest says where in the file the first of them was, and where in the question", () => {
    const list = Array.from({ length: 30 }, (_, i) => finding("many", "warn", `finding ${i}`, { field: `body.options.${i}.content`, source: { file: "q.txt", firstBlock: 100 + i, lastBlock: 100 + i } }));
    const more = capFindings(list, 10).find((x) => isCapSummary(x)) as Finding;
    assert.ok(more, "there is a finding that counts the rest");
    assert.equal(more.field, "body.options.10.content");
    assert.deepEqual(more.source, list[10]?.source, "the source of the first one left out");
    const plain = capFindings([finding("a", "info", "one"), finding("a", "info", "two")], 1).find((x) => isCapSummary(x)) as Finding;
    assert.equal("source" in plain, false, "and none where the first had none");
    assert.equal("field" in plain, false);
  });

  test("a list that has been cut is not cut again: the finding that counts the rest is not one of the findings it counts", () => {
    const list: Finding[] = [];
    for (let i = 0; i < 60; i++) list.push(f("many", i, i === 40 ? "error" : "warn"));
    for (let i = 0; i < 5; i++) list.push(f("few", i));
    const once = capFindings(list, 10);
    const twice = capFindings(once, 10);
    assert.deepEqual(twice, once);
    assert.equal(once.filter((x) => x.code === "many").length, 11);
    assert.equal(isCapSummary(once.find((x) => x.code === "few") as Finding), false, "a finding that happens to be a kind that was not cut");
    assert.equal(isCapSummary(f("many", 1)), false);
  });

  test("a question made from 100,000 findings of three kinds lists no more than the limit of each and one that counts the rest, and is as bad as it was", () => {
    const findings: Finding[] = [];
    for (let i = 0; i < 100000; i++) findings.push(finding(["import.unread-content", "import.type-inferred", "import.empty-option"][i % 3] as string, i === 99999 ? "error" : "warn", `finding ${i}`));
    const q = createQuestion({ type: "essay", stem: "Q?", body: {}, findings });
    assert.ok(q.findings.length <= 3 * (MOST_FINDINGS_OF_A_KIND + 1), `${q.findings.length} findings`);
    assert.equal(q.findings.filter(isCapSummary).length, 3, "one for each kind that was cut");
    assert.equal(verdictFrom(q.findings), "failed", "the one error among the findings left out still makes it failed");
    assert.equal(createQuestion({ type: "essay", stem: "Q?", body: {}, findings: q.findings }).findings.length, q.findings.length, "and making a question from a question's findings cuts nothing more");
  });
});
