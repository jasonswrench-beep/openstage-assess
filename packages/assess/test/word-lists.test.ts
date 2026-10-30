/**
 * Word's list numbering, read as the page shows it.
 *
 * Two kinds of test. The first group gives the reader a numbering part written by
 * hand and checks the label of each paragraph against what the counting rules say
 * it must be; the expected labels are written out, not computed. The second reads
 * whole documents, and the differential tests in word-import.test.ts check that the
 * text fixtures, numbered by Word instead of typed, come back as they were.
 *
 * The documents come from the writer in test/support, not from Word. The rules are
 * also checked against Word itself by the script described in docs/word-import-plan.md.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { documentToBlocks } from "../src/import/docx/document.ts";
import { readNumbering } from "../src/import/docx/numbering.ts";
import { parseXml, type XmlElement } from "../src/import/docx/xml.ts";
import { textEntry } from "../src/container/zip.ts";
import { docxToBlocks, wordImporter } from "../src/import/word.ts";
import { FindingCode } from "../src/model/findings.ts";
import { standardTextImporter } from "../src/import/standard-text.ts";
import type { SourceBlock } from "../src/import/types.ts";
import { abstractNum, docx, level, listProperties, num, numberingPart, paragraph, run, style, table } from "./support/docx-writer.ts";

const OPTIONS = { file: "t.docx", at: "2026-01-01T00:00:00.000Z", author: "test" };
const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';

const part = (name: string, inner: string): XmlElement => parseXml(`<w:${name} ${W}>${inner}</w:${name}>`);

interface P {
  numId?: number;
  level?: number;
  style?: string;
}

/** The properties of a paragraph, read from XML the way the walker meets them. */
const properties = (p: P): XmlElement => parseXml(`<w:pPr ${W}>${listProperties(p)}</w:pPr>`);

/**
 * What each paragraph shows, one string each: its label; "-" for a paragraph not in
 * a list; "(none)" for a list item that shows nothing (a bullet); "! reason" for one
 * whose number could not be worked out.
 */
function labels(parts: { numbering?: string; styles?: string; damaged?: string }, paragraphs: readonly P[]): string[] {
  const numbering = readNumbering({
    numbering: parts.numbering === undefined ? undefined : part("numbering", parts.numbering),
    styles: parts.styles === undefined ? undefined : part("styles", parts.styles),
    numberingDamaged: parts.damaged,
  });
  return paragraphs.map((p) => {
    const got = numbering.label(properties(p));
    if (got === undefined) return "-";
    if (got.unread !== undefined) return `! ${got.unread}`;
    return got.label ?? "(none)";
  });
}

const items = (numId: number, count: number, at = 0): P[] => Array.from({ length: count }, () => ({ numId, level: at }));

describe("number formats", () => {
  const counted = (format: string, count: number, text = "%1.") =>
    labels({ numbering: numberingPart([abstractNum(1, [level(0, { format, text })])], [num(1, 1)]) }, items(1, count));

  test("decimal, with the level's own start", () => {
    assert.deepEqual(counted("decimal", 3), ["1.", "2.", "3."]);
    assert.deepEqual(
      labels({ numbering: numberingPart([abstractNum(1, [level(0, { start: 5 })])], [num(1, 1)]) }, items(1, 2)),
      ["5.", "6."],
    );
  });

  test("a level with no start counts from zero, as the specification says", () => {
    const bare = `<w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0"><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/></w:lvl></w:abstractNum>${num(1, 1)}`;
    assert.deepEqual(labels({ numbering: bare }, items(1, 2)), ["0.", "1."]);
  });

  test("decimal with a leading zero", () => {
    assert.deepEqual(counted("decimalZero", 10).slice(7), ["08.", "09.", "10."]);
  });

  test("letters run a to z and then repeat the letter, as Word does: aa, bb, cc", () => {
    const lower = counted("lowerLetter", 55);
    assert.deepEqual(lower.slice(0, 3), ["a.", "b.", "c."]);
    assert.deepEqual([lower[25], lower[26], lower[27], lower[51], lower[52]], ["z.", "aa.", "bb.", "zz.", "aaa."]);
    assert.deepEqual(counted("upperLetter", 28).slice(25), ["Z.", "AA.", "BB."]);
  });

  test("roman numerals, lower and upper", () => {
    assert.deepEqual(counted("lowerRoman", 10), ["i.", "ii.", "iii.", "iv.", "v.", "vi.", "vii.", "viii.", "ix.", "x."]);
    assert.deepEqual(counted("upperRoman", 4), ["I.", "II.", "III.", "IV."]);
    assert.equal(counted("lowerRoman", 40)[39], "xl.");
    assert.equal(counted("upperRoman", 1994)[1993], "MCMXCIV.");
  });

  test("ordinals: 1st, 2nd, 3rd, 4th, and the teens are all th", () => {
    const shown = counted("ordinal", 23, "%1");
    assert.deepEqual([shown[0], shown[1], shown[2], shown[3], shown[10], shown[11], shown[12], shown[20], shown[21]], ["1st", "2nd", "3rd", "4th", "11th", "12th", "13th", "21st", "22nd"]);
  });

  test("brackets and words in the text are kept as written", () => {
    assert.deepEqual(counted("lowerLetter", 2, "(%1)"), ["(a)", "(b)"]);
    assert.deepEqual(counted("decimal", 2, "%1)"), ["1)", "2)"]);
    assert.deepEqual(counted("decimal", 2, "Question %1."), ["Question 1.", "Question 2."]);
  });

  test("a bullet shows no label and is not an error", () => {
    assert.deepEqual(counted("bullet", 2, ""), ["(none)", "(none)"]);
  });

  test("a level that shows nothing is a list item with no label", () => {
    assert.deepEqual(counted("none", 1, ""), ["(none)"]);
  });

  test("a format this reader does not know is reported, and no number is guessed", () => {
    assert.deepEqual(counted("cardinalText", 2), ["! its numbering format (cardinalText) is not one this reader knows", "! its numbering format (cardinalText) is not one this reader knows"]);
  });

  test("a format that is not used in the text is not a problem", () => {
    assert.deepEqual(counted("cardinalText", 1, "Question"), ["Question"]);
  });
});

describe("counting", () => {
  const simple = numberingPart([abstractNum(1, [level(0), level(1, { format: "lowerLetter", text: "%2)" })])], [num(1, 1)]);

  test("a paragraph that is not in a list does not break the count", () => {
    const shown = labels({ numbering: simple }, [{ numId: 1, level: 0 }, {}, {}, { numId: 1, level: 0 }]);
    assert.deepEqual(shown, ["1.", "-", "-", "2."]);
  });

  test("a deeper level starts over after each item of the level above", () => {
    const shown = labels({ numbering: simple }, [
      { numId: 1, level: 0 },
      { numId: 1, level: 1 },
      { numId: 1, level: 1 },
      { numId: 1, level: 0 },
      { numId: 1, level: 1 },
    ]);
    assert.deepEqual(shown, ["1.", "a)", "b)", "2.", "a)"]);
  });

  test("a level above is not restarted by one below", () => {
    const shown = labels({ numbering: simple }, [
      { numId: 1, level: 0 },
      { numId: 1, level: 1 },
      { numId: 1, level: 0 },
      { numId: 1, level: 1 },
      { numId: 1, level: 1 },
      { numId: 1, level: 0 },
    ]);
    assert.deepEqual(shown, ["1.", "a)", "2.", "a)", "b)", "3."]);
  });

  test("a level used before the levels above it counts them as used once, as Word does", () => {
    const nested = numberingPart([abstractNum(1, [level(0), level(1, { text: "%1.%2" }), level(2, { text: "%1.%2.%3" })])], [num(1, 1)]);
    assert.deepEqual(labels({ numbering: nested }, [{ numId: 1, level: 1 }, { numId: 1, level: 1 }]), ["1.1", "1.2"]);
    // checked against Word: the first item of the level above is the second
    const sequence = [1, 1, 0, 2, 1].map((at) => ({ numId: 1, level: at }));
    assert.deepEqual(labels({ numbering: nested }, sequence), ["1.1", "1.2", "2.", "2.1.1", "2.2"]);
  });

  test("multi-level text shows the count at each level it names", () => {
    const outline = numberingPart([abstractNum(1, [level(0), level(1, { text: "%1.%2" }), level(2, { text: "%1.%2.%3" })])], [num(1, 1)]);
    const shown = labels({ numbering: outline }, [
      { numId: 1, level: 0 },
      { numId: 1, level: 1 },
      { numId: 1, level: 2 },
      { numId: 1, level: 2 },
      { numId: 1, level: 1 },
      { numId: 1, level: 0 },
      { numId: 1, level: 1 },
    ]);
    assert.deepEqual(shown, ["1.", "1.1", "1.1.1", "1.1.2", "1.2", "2.", "2.1"]);
  });

  test("legal style shows the numbers as plain numbers, the level's own included", () => {
    const outline = (legal: boolean) =>
      numberingPart(
        [
          abstractNum(1, [
            level(0, { format: "upperRoman" }),
            level(1, { text: "%1.%2", legal }),
            level(2, { format: "lowerLetter", text: "%1.%2.%3", legal }),
          ]),
        ],
        [num(1, 1)],
      );
    const sequence = [0, 1, 2, 2, 1, 0].map((at) => ({ numId: 1, level: at }));
    // both checked against Word
    assert.deepEqual(labels({ numbering: outline(false) }, sequence), ["I.", "I.1", "I.1.a", "I.1.b", "I.2", "II."]);
    assert.deepEqual(labels({ numbering: outline(true) }, sequence), ["I.", "1.1", "1.1.1", "1.1.2", "1.2", "II."]);
  });

  test("a level can be told to restart only after a certain level, or never", () => {
    const sequence = [0, 1, 2, 2, 1, 2, 0, 1, 2].map((at) => ({ numId: 1, level: at }));
    const three = (restart?: number) =>
      numberingPart(
        [abstractNum(1, [level(0), level(1), level(2, restart === undefined ? {} : { restart })])],
        [num(1, 1)],
      );
    const ofThird = (shown: string[]) => shown.filter((_, k) => sequence[k]?.level === 2);
    // by default every item of a higher level starts it over
    assert.deepEqual(ofThird(labels({ numbering: three() }, sequence)), ["1.", "2.", "1.", "1."]);
    // 0: never
    assert.deepEqual(ofThird(labels({ numbering: three(0) }, sequence)), ["1.", "2.", "3.", "4."]);
    // 1: only the first level starts it over, the second does not
    assert.deepEqual(ofThird(labels({ numbering: three(1) }, sequence)), ["1.", "2.", "3.", "1."]);
  });

  test("a restart after a level that is not above it is one Word shows nothing for, so no number is given", () => {
    // Word shows an empty label for these. Giving a number where Word gives none would be a guess.
    const sequence = [0, 1, 2].map((at) => ({ numId: 1, level: at }));
    for (const restart of [2, 3]) {
      const numbering = numberingPart([abstractNum(1, [level(0), level(1), level(2, { restart })])], [num(1, 1)]);
      assert.match(labels({ numbering }, sequence)[2] ?? "", /^! its level \(3\) says it restarts after level \d, which Word does not accept$/);
    }
    const second = numberingPart([abstractNum(1, [level(0), level(1, { restart: 1 })])], [num(1, 1)]);
    assert.match(labels({ numbering: second }, [{ numId: 1, level: 1 }])[0] ?? "", /^! /);
  });
});

describe("restarts and the list instances", () => {
  const one = (instances: string[]) => numberingPart([abstractNum(1, [level(0)])], instances);

  test("a new instance of the same list carries on from the last, unless it restarts", () => {
    const shown = labels({ numbering: one([num(1, 1), num(2, 1)]) }, [...items(1, 2), ...items(2, 2)]);
    assert.deepEqual(shown, ["1.", "2.", "3.", "4."]);
  });

  test("a start override restarts at its value, once, and the instance then carries on", () => {
    const numbering = one([num(1, 1), num(2, 1), num(3, 1, [{ level: 0, start: 1 }]), num(4, 1, [{ level: 0, start: 10 }])]);
    const order = [1, 1, 2, 2, 3, 3, 1, 4, 4];
    const shown = labels({ numbering }, order.map((numId) => ({ numId, level: 0 })));
    assert.deepEqual(shown, ["1.", "2.", "3.", "4.", "1.", "2.", "3.", "10.", "11."]);
  });

  test("an override on a level an instance first meets further up starts that level when it is reached", () => {
    // checked against Word
    const numbering = numberingPart(
      [abstractNum(1, [level(0), level(1, { format: "lowerLetter", text: "%2)" })])],
      [num(1, 1), num(5, 1, [{ level: 1, start: 5 }])],
    );
    const used: P[] = [{ numId: 1, level: 0 }, { numId: 5, level: 0 }, { numId: 5, level: 1 }, { numId: 5, level: 1 }, { numId: 1, level: 0 }, { numId: 1, level: 1 }, { numId: 5, level: 1 }];
    assert.deepEqual(labels({ numbering }, used), ["1.", "2.", "e)", "f)", "3.", "a)", "b)"]);
  });

  test("lists with their own definitions do not affect each other", () => {
    const numbering = numberingPart([abstractNum(1, [level(0)]), abstractNum(2, [level(0, { format: "lowerLetter", text: "%1)" })])], [num(1, 1), num(2, 2)]);
    const shown = labels({ numbering }, [{ numId: 1, level: 0 }, { numId: 2, level: 0 }, { numId: 1, level: 0 }, { numId: 2, level: 0 }]);
    assert.deepEqual(shown, ["1.", "a)", "2.", "b)"]);
  });

  test("an override that replaces the level changes how it is shown", () => {
    const numbering = one([num(1, 1), num(2, 1, [{ level: 0, start: 1, replacement: level(0, { format: "upperLetter", text: "%1." }) }])]);
    assert.deepEqual(labels({ numbering }, [...items(1, 1), ...items(2, 2)]), ["1.", "A.", "B."]);
  });

  test("list 0 means no list, even where a style says otherwise", () => {
    const numbering = one([num(1, 1)]);
    const styles = style({ id: "Numbered", numId: 1 });
    assert.deepEqual(labels({ numbering, styles }, [{ style: "Numbered" }, { style: "Numbered", numId: 0 }, { style: "Numbered" }]), ["1.", "-", "2."]);
  });
});

describe("numbering that comes from a paragraph style", () => {
  // Everything here was checked against Word with documents built for the purpose.
  const NORMAL = style({ id: "Normal", isDefault: true });

  /** Word's own form: each level is tied to a style, and each style names its list and level. */
  const tied = numberingPart(
    [abstractNum(1, [level(0, { style: "Q" }), level(1, { format: "lowerLetter", text: "%2)", style: "Opt" })])],
    [num(1, 1)],
  );
  const wordsOwn =
    NORMAL +
    style({ id: "Q", basedOn: "Normal", numId: 1 }) +
    style({ id: "Opt", basedOn: "Normal", numId: 1, level: 1 }) +
    style({ id: "OptTwo", basedOn: "Opt" }) +
    style({ id: "Deep", basedOn: "OptTwo" }) +
    style({ id: "Plain", basedOn: "Normal" });

  /** The same list with no level tied to a style. */
  const untied = numberingPart([abstractNum(1, [level(0), level(1, { format: "lowerLetter", text: "%2)" })])], [num(1, 1)]);

  test("a paragraph with only a style is numbered by it, and each style says its level", () => {
    assert.deepEqual(labels({ numbering: tied, styles: wordsOwn }, [{ style: "Q" }, { style: "Plain" }, { style: "Q" }]), ["1.", "-", "2."]);
    assert.deepEqual(
      labels({ numbering: tied, styles: wordsOwn }, [{ style: "Q" }, { style: "Opt" }, { style: "Opt" }, { style: "Q" }, { style: "Opt" }]),
      ["1.", "a)", "b)", "2.", "a)"],
    );
  });

  test("the same without the levels being tied to the styles", () => {
    assert.deepEqual(
      labels({ numbering: untied, styles: wordsOwn }, [{ style: "Q" }, { style: "Opt" }, { style: "Opt" }, { style: "Q" }, { style: "Opt" }]),
      ["1.", "a)", "b)", "2.", "a)"],
    );
  });

  test("a style based on a numbered style is numbered too, however far down", () => {
    assert.deepEqual(labels({ numbering: tied, styles: wordsOwn }, [{ style: "Q" }, { style: "OptTwo" }, { style: "Deep" }]), ["1.", "a)", "b)"]);
  });

  test("a style based on one that names the list, and names it again, is numbered", () => {
    const again = NORMAL + style({ id: "Base", basedOn: "Normal", numId: 1 }) + style({ id: "Again", basedOn: "Base", numId: 1 });
    assert.deepEqual(labels({ numbering: untied, styles: again }, [{ style: "Base" }, { style: "Again" }, { style: "Base" }]), ["1.", "2.", "3."]);
  });

  test("a style that names a list and not its level is the first level, even where another level is tied to it", () => {
    const styles = NORMAL + style({ id: "S1", basedOn: "Normal", numId: 1 });
    const tiedToLevelTwo = numberingPart([abstractNum(1, [level(0), level(1, { format: "lowerLetter", text: "%2)", style: "S1" })])], [num(1, 1)]);
    assert.deepEqual(labels({ numbering: tiedToLevelTwo, styles }, [{ style: "S1" }, { style: "S1" }]), ["1.", "2."]);
  });

  test("a style that names a level which another style holds is not numbered, and shows nothing", () => {
    // S1 names only the list, so it asks for the first level, which Q holds.
    const styles = NORMAL + style({ id: "Q", basedOn: "Normal", numId: 1 }) + style({ id: "S1", basedOn: "Normal", numId: 1 });
    assert.deepEqual(labels({ numbering: tied, styles }, [{ style: "Q" }, { style: "S1" }, { style: "S1" }, { style: "Q" }]), ["1.", "-", "-", "2."]);
    // even with a level on the paragraph itself: without a list there is no level to use
    assert.deepEqual(labels({ numbering: tied, styles }, [{ style: "Q" }, { style: "S1", level: 1 }]), ["1.", "-"]);
  });

  test("where no level is tied, the first style to ask for it holds it", () => {
    const styles = NORMAL + style({ id: "Late", basedOn: "Normal", numId: 1, level: 1 }) + style({ id: "Early", basedOn: "Normal", numId: 1, level: 1 });
    assert.deepEqual(labels({ numbering: untied, styles }, [{ style: "Early" }, { style: "Late" }, { style: "Late" }, { style: "Early" }]), ["-", "a)", "b)", "-"]);
  });

  test("a style asks for the first level when it does not say, even where it is tied to another level", () => {
    // Level 2 is tied to S1, but S1 names only the list, so it asks for level 1, as Q does. Whichever is
    // declared first holds it. Both orders checked against Word.
    const tiedElsewhere = numberingPart([abstractNum(1, [level(0), level(1, { format: "lowerLetter", text: "%2)", style: "S1" })])], [num(1, 1)]);
    const qFirst = NORMAL + style({ id: "Q", basedOn: "Normal", numId: 1 }) + style({ id: "S1", basedOn: "Normal", numId: 1 });
    const s1First = NORMAL + style({ id: "S1", basedOn: "Normal", numId: 1 }) + style({ id: "Q", basedOn: "Normal", numId: 1 });
    assert.deepEqual(labels({ numbering: tiedElsewhere, styles: qFirst }, [{ style: "Q" }, { style: "S1" }, { style: "S1" }, { style: "Q" }]), ["1.", "-", "-", "2."]);
    assert.deepEqual(labels({ numbering: tiedElsewhere, styles: s1First }, [{ style: "S1" }, { style: "Q" }, { style: "Q" }, { style: "S1" }]), ["1.", "-", "-", "2."]);
  });

  test("the tie decides who holds a level, whatever the order", () => {
    const styles = NORMAL + style({ id: "Squatter", basedOn: "Normal", numId: 1 }) + style({ id: "Q", basedOn: "Normal", numId: 1 });
    assert.deepEqual(labels({ numbering: tied, styles }, [{ style: "Squatter" }, { style: "Q" }, { style: "Q" }]), ["-", "1.", "2."]);
  });

  test("a different instance of the same list does not get round it", () => {
    const two = numberingPart([abstractNum(1, [level(0)])], [num(1, 1), num(2, 1)]);
    const styles = NORMAL + style({ id: "A", basedOn: "Normal", numId: 1 }) + style({ id: "B", basedOn: "Normal", numId: 2 });
    assert.deepEqual(labels({ numbering: two, styles }, [{ style: "A" }, { style: "B" }, { style: "A" }, { style: "B" }]), ["1.", "-", "2.", "-"]);
  });

  test("a numbering the paragraph names itself is always honoured, whatever its style is", () => {
    const styles = wordsOwn + style({ id: "Other", basedOn: "Normal", numId: 1 });
    const shown = labels({ numbering: tied, styles }, [
      { style: "Q" },
      { style: "Plain", numId: 1, level: 1 }, // a style with no list
      { style: "Opt", numId: 1, level: 0 }, // its own level, not the style's
      { numId: 1, level: 1 },
      { style: "Other", numId: 1, level: 1 }, // a style that does not hold its level
    ]);
    assert.deepEqual(shown, ["1.", "a)", "2.", "a)", "b)"]);
  });

  test("a paragraph's level alone, on a style that names the list, is its level", () => {
    const styles = NORMAL + style({ id: "A", basedOn: "Normal", numId: 1 });
    assert.deepEqual(labels({ numbering: untied, styles }, [{ style: "A" }, { style: "A", level: 1 }, { style: "A", level: 1 }, { style: "A" }]), ["1.", "a)", "b)", "2."]);
  });

  test("a style's level is used when the paragraph names a different list", () => {
    const two = numberingPart(
      [abstractNum(1, [level(0), level(1, { format: "lowerLetter", text: "%2)" })]), abstractNum(2, [level(0, { format: "upperRoman" }), level(1, { format: "upperLetter", text: "%2." })])],
      [num(1, 1), num(2, 2)],
    );
    const styles = NORMAL + style({ id: "B", basedOn: "Normal", numId: 1, level: 1 });
    assert.deepEqual(labels({ numbering: two, styles }, [{ style: "B", numId: 2 }, { style: "B", numId: 2 }, { style: "B" }]), ["A.", "B.", "a)"]);
  });

  test("list 0 on a style means no list, and the paragraph can still name one", () => {
    const styles = NORMAL + style({ id: "C", basedOn: "Normal", numId: 0 });
    assert.deepEqual(labels({ numbering: untied, styles }, [{ style: "C" }, { style: "C", numId: 1 }]), ["-", "1."]);
  });

  test("a loop of styles that are based on each other ends", () => {
    const loop = style({ id: "A", basedOn: "B" }) + style({ id: "B", basedOn: "A" });
    assert.deepEqual(labels({ numbering: untied, styles: loop }, [{ style: "A" }]), ["-"]);
  });

  test("a paragraph with no style takes the document's default paragraph style", () => {
    const numbered = style({ id: "Normal", isDefault: true, numId: 1 });
    assert.deepEqual(labels({ numbering: untied, styles: numbered }, [{}, {}, { numId: 0 }]), ["1.", "2.", "-"]);
  });

  test("a list defined as a link to a numbering style takes that style's levels, and counts on its own", () => {
    const linked = numberingPart(
      [abstractNum(1, [level(0)], '<w:styleLink w:val="Outline"/>'), abstractNum(2, [], '<w:numStyleLink w:val="Outline"/>')],
      [num(1, 1), num(2, 2)],
    );
    const outline = style({ id: "Outline", type: "numbering", numId: 1 });
    // checked against Word: the two lists do not share a count
    const order = [1, 2, 1, 2].map((numId) => ({ numId, level: 0 }));
    assert.deepEqual(labels({ numbering: linked, styles: outline }, order), ["1.", "1.", "2.", "2."]);
  });

  test("a change to the paragraph's properties that is being tracked is not the paragraph's numbering", () => {
    const changed = parseXml(
      `<w:pPr ${W}><w:pPrChange w:id="1" w:author="a"><w:pPr><w:numPr><w:numId w:val="1"/></w:numPr></w:pPr></w:pPrChange></w:pPr>`,
    );
    const reader = readNumbering({ numbering: part("numbering", untied) });
    assert.equal(reader.label(changed), undefined);
  });
});

describe("a list that cannot be worked out is reported, not guessed", () => {
  const numbering = numberingPart([abstractNum(1, [level(0)])], [num(1, 1)]);

  test("a list the file does not define", () => {
    assert.deepEqual(labels({ numbering }, [{ numId: 9, level: 0 }]), ["! the list it belongs to is not defined in the file"]);
  });

  test("an instance whose definition is missing", () => {
    assert.deepEqual(labels({ numbering: num(1, 7) }, [{ numId: 1, level: 0 }]), ["! the list it belongs to is not defined in the file"]);
  });

  test("a level the list does not define", () => {
    assert.deepEqual(labels({ numbering }, [{ numId: 1, level: 3 }]), ["! its level (4) is not defined in the list"]);
  });

  test("a document with no numbering part at all", () => {
    assert.deepEqual(labels({}, [{ numId: 1, level: 0 }]), ["! the list it belongs to is not defined in the file"]);
  });

  test("a numbering part that is damaged says why", () => {
    assert.deepEqual(labels({ damaged: "not valid XML" }, [{ numId: 1, level: 0 }, {}]), ["! the numbering part of the file could not be read: not valid XML", "-"]);
  });

  test("a label that names a level in a format this reader does not know is not guessed either", () => {
    const odd = numberingPart([abstractNum(1, [level(0, { format: "cardinalText" }), level(1, { text: "%1.%2" })])], [num(1, 1)]);
    const shown = labels({ numbering: odd }, [{ numId: 1, level: 0 }, { numId: 1, level: 1 }]);
    assert.match(shown[1] ?? "", /^! its numbering format \(cardinalText\)/);
  });
});

// ---------------------------------------------------------------------------
// Whole documents
// ---------------------------------------------------------------------------

const QUESTIONS = numberingPart([abstractNum(1, [level(0), level(1, { format: "lowerLetter", text: "%2." })])], [num(1, 1)]);
const item = (text: string, at: number) => paragraph(run(text), listProperties({ numId: 1, level: at }));

describe("a numbered paragraph in a document", () => {
  test("keeps its label apart from its text, on the first line only", () => {
    const body = paragraph(run("Which is a planet?") + "<w:r><w:br/></w:r>" + run("Choose one."), listProperties({ numId: 1, level: 0 })) + item("Mars", 1);
    const { blocks } = docxToBlocks(docx({ body, numbering: QUESTIONS }));
    assert.deepEqual(blocks.map((b) => [b.listLabel ?? null, b.text, b.kind ?? null]), [
      ["1.", "Which is a planet?", "listItem"],
      [null, "Choose one.", null],
      ["a.", "Mars", "listItem"],
    ]);
  });

  test("shows an empty item's label, as the page does", () => {
    const { blocks } = docxToBlocks(docx({ body: item("Q", 0) + paragraph("", listProperties({ numId: 1, level: 1 })), numbering: QUESTIONS }));
    assert.deepEqual(blocks.map((b) => [b.listLabel, b.text]), [["1.", "Q"], ["a.", ""]]);
  });

  test("counts through a table, which has its own cells but the document's lists", () => {
    const body = item("First", 0) + table([[item("Second", 0), item("Third", 0)]]) + item("Fourth", 0);
    const { blocks } = docxToBlocks(docx({ body, numbering: QUESTIONS }));
    assert.deepEqual(blocks.map((b) => b.listLabel), ["1.", "2.", "3.", "4."]);
    assert.deepEqual(blocks.map((b) => b.table?.cell ?? null), [null, 0, 1, null]);
  });

  test("a paragraph deleted with its mark is gone, and its number with it", () => {
    const gone = paragraph(
      '<w:del w:id="1" w:author="a"><w:r><w:delText>Removed question</w:delText></w:r></w:del>',
      listProperties({ numId: 1, level: 0 }) + '<w:rPr><w:del w:id="2" w:author="a"/></w:rPr>',
    );
    const { blocks } = docxToBlocks(docx({ body: item("One", 0) + gone + item("Two", 0), numbering: QUESTIONS }));
    assert.deepEqual(blocks.map((b) => [b.listLabel, b.text]), [["1.", "One"], ["2.", "Two"]]);
  });

  test("a paragraph whose mark is deleted but whose text is not is kept", () => {
    const kept = paragraph(run("Still here"), listProperties({ numId: 1, level: 0 }) + '<w:rPr><w:del w:id="2" w:author="a"/></w:rPr>');
    const { blocks } = docxToBlocks(docx({ body: item("One", 0) + kept, numbering: QUESTIONS }));
    assert.deepEqual(blocks.map((b) => b.listLabel), ["1.", "2."]);
  });

  test("an unnumbered document is read exactly as before", () => {
    const { blocks, findings } = docxToBlocks(docx({ body: paragraph(run("1. Typed")) }));
    assert.deepEqual(blocks.map((b) => [b.listLabel ?? null, b.text]), [[null, "1. Typed"]]);
    assert.deepEqual(findings, []);
  });
});

describe("finding the numbering and the styles", () => {
  const body = item("Q", 0) + item("A", 1);
  const labelsOf = (bytes: Uint8Array) => docxToBlocks(bytes).blocks.map((b) => b.listLabel);

  test("by the document's relationships, whatever the part is called or how the target is written", () => {
    // The part is not stored under its usual name, so only the relationship can find it.
    const numberingPath = "word/lists/custom-numbering.xml";
    for (const target of ["lists/custom-numbering.xml", "/word/lists/custom-numbering.xml", "../word/lists/custom-numbering.xml", "./lists/custom-numbering.xml"]) {
      assert.deepEqual(labelsOf(docx({ body, numbering: QUESTIONS, numberingPath, numberingTarget: target })), ["1.", "a."], target);
    }
  });

  test("by its usual name when the relationships do not say", () => {
    assert.deepEqual(labelsOf(docx({ body, numbering: QUESTIONS, omit: ["word/_rels/document.xml.rels"] })), ["1.", "a."]);
  });

  test("a target that climbs out of the package is not followed, even if something is there", () => {
    const decoy = textEntry("numbering.xml", `<w:numbering ${W}>${QUESTIONS}</w:numbering>`);
    const bytes = docx({ body, numbering: QUESTIONS, numberingTarget: "../../numbering.xml", omit: ["word/numbering.xml"], extra: [decoy] });
    assert.deepEqual(labelsOf(bytes), [undefined, undefined]);
  });

  test("a numbering part that is not valid XML is a warning and the body is still read", () => {
    const broken = docx({ body, numbering: "<w:abstractNum>" });
    const { blocks, findings } = docxToBlocks(broken);
    assert.deepEqual(blocks.map((b) => b.text), ["Q", "A"]);
    assert.equal(findings.length, 1);
    assert.equal(findings[0]?.code, FindingCode.UnreadContent);
    assert.equal(findings[0]?.severity, "warn");
    assert.match(findings[0]?.message ?? "", /2 paragraphs are in a numbered list whose number could not be worked out, because the numbering part of the file could not be read: .*not valid XML/);
    assert.match(findings[0]?.message ?? "", /nothing was guessed/);
  });

  test("a styles part that is not valid XML is a warning too", () => {
    const { findings } = docxToBlocks(docx({ body, numbering: QUESTIONS, styles: "<w:style>" }));
    assert.equal(findings.length, 1);
    assert.match(findings[0]?.message ?? "", /styles of this file could not be read, so a number that comes from a paragraph style may be missing/);
  });

  test("a list that is not defined is one finding for the file with a count, not one per paragraph", () => {
    const orphaned = paragraph(run("Q"), listProperties({ numId: 4, level: 0 })).repeat(3);
    const { findings } = docxToBlocks(docx({ body: orphaned, numbering: QUESTIONS }));
    assert.equal(findings.length, 1);
    assert.match(findings[0]?.message ?? "", /3 paragraphs are in a numbered list whose number could not be worked out, because the list it belongs to is not defined in the file/);
  });

  test("a bullet is not a finding", () => {
    const bullets = numberingPart([abstractNum(1, [level(0, { format: "bullet", text: "•" })])], [num(1, 1)]);
    assert.deepEqual(docxToBlocks(docx({ body: item("Mars", 0), numbering: bullets })).findings, []);
  });

  test("documentToBlocks without a numbering reader reads a numbered paragraph as the text it holds", () => {
    const root = parseXml(`<w:document ${W}><w:body>${item("Mars", 0)}</w:body></w:document>`);
    const { blocks } = documentToBlocks(root);
    assert.deepEqual(blocks.map((b) => [b.listLabel ?? null, b.text]), [[null, "Mars"]]);
  });
});

describe("a label is joined to its text the way the page shows it", () => {
  const parse = (blocks: SourceBlock[]) => standardTextImporter.parse(blocks, OPTIONS);
  const block = (index: number, text: string, listLabel?: string): SourceBlock => ({ index, text, ...(listLabel ? { listLabel } : {}) });

  test("a label in brackets reads as the same label without the opening bracket", () => {
    const result = parse([block(0, "Which is a planet?", "1)"), block(1, "Sirius", "(a)"), block(2, "*Mars", "(b)"), block(3, "The Sun", "(c)")]);
    const [q] = result.questions;
    assert.equal(q?.type, "multipleChoice");
    assert.deepEqual(result.counts, { parsed: 1, needsReview: 0, failed: 0, orphans: 0 });
  });

  test("an asterisk at the start of a lettered item is the key mark, moved to where the format has it", () => {
    const viaLabel = parse([block(0, "Which is a planet?", "1."), block(1, "Sirius", "a."), block(2, "*Mars", "b."), block(3, "The Sun", "c.")]);
    const typed = standardTextImporter.parse("1. Which is a planet?\na. Sirius\n*b. Mars\nc. The Sun\n", OPTIONS);
    assert.deepEqual(viaLabel.questions[0]?.body, typed.questions[0]?.body);
    assert.equal(viaLabel.counts.parsed, 1);
  });

  test("a space after the asterisk is allowed, as it is in the format", () => {
    const [q] = parse([block(0, "Pick one.", "1."), block(1, "Sirius", "a."), block(2, "* Mars", "b.")]).questions;
    assert.ok(q?.findings.every((f) => f.code !== FindingCode.NoAnswerKey), "the mark was seen");
  });

  test("a lone asterisk in a typed line is not moved: it takes a habit of the whole file (test/star-after-letter.test.ts)", () => {
    const typed = standardTextImporter.parse("1. Pick one.\na. Sirius\nb. *Mars\n", OPTIONS);
    assert.ok(typed.questions[0]?.findings.some((f) => f.code === FindingCode.NoAnswerKey), "one star after a typed letter is not enough to be a key mark");
  });

  test("an asterisk at the start of a numbered item is part of the question, not a mark", () => {
    const [q] = parse([block(0, "*Starred question text", "1."), block(1, "Sirius", "a."), block(2, "Mars", "b.")]).questions;
    assert.ok(JSON.stringify(q?.stem).includes("Starred question text"));
  });
});

describe("through the importer", () => {
  test("a bank numbered by Word's lists imports like the same bank typed, with the answers in a list", () => {
    const typed = standardTextImporter.parse("1. Which is a planet?\na. Sirius\nb. Mars\n\n2. Which is a star?\na. Sirius\nb. Mars\n\nAnswers:\n1. B\n2. A\n", OPTIONS);
    const numbered =
      item("Which is a planet?", 0) + item("Sirius", 1) + item("Mars", 1) + paragraph() +
      item("Which is a star?", 0) + item("Sirius", 1) + item("Mars", 1) + paragraph() +
      paragraph(run("Answers:")) + paragraph(run("1. B")) + paragraph(run("2. A"));
    const restarted = numberingPart([abstractNum(1, [level(0), level(1, { format: "lowerLetter", text: "%2." })])], [num(1, 1)]);
    const via = wordImporter.parseBytes(docx({ body: numbered, numbering: restarted }), OPTIONS);
    assert.deepEqual(via.questions.map((q) => q.body), typed.questions.map((q) => q.body));
    assert.deepEqual(via.counts, typed.counts);
  });

  test("a question whose number could not be worked out is not given a number, and is not lost", () => {
    const numbered = paragraph(run("Which is a planet?"), listProperties({ numId: 9, level: 0 })) + paragraph(run("a. Sirius")) + paragraph(run("*b. Mars"));
    const result = wordImporter.parseBytes(docx({ body: numbered, numbering: QUESTIONS }), OPTIONS);
    assert.equal(result.questions.length, 0, "no question is invented from a number that is not known");
    assert.ok(JSON.stringify(result.orphans).includes("Which is a planet?"), "the text is kept as an orphan");
    assert.ok(result.fileFindings.some((f) => f.code === FindingCode.UnreadContent && /could not be worked out/.test(f.message)));
  });
});
