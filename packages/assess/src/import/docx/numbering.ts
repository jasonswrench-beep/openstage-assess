/**
 * Word's own list numbering, worked out as the page shows it.
 *
 * A paragraph in a numbered list carries no number in its text. The number is made
 * at display time from three places: the paragraph's list (and level), the
 * definition of that list in numbering.xml, and how many paragraphs of the list
 * came before it. A test bank written with Word's list buttons is a document whose
 * question numbers and option letters live only there, and the format's own guides
 * tell authors to give an Answers list for that reason. Reading them is
 * what lets a Word bank import without retyping, and getting one wrong is worse than
 * failing to read it: an Answers list matches a key to a question by its number, so
 * a number that is off by one points a key at the wrong question without a word.
 * That is why a list this reader is not sure of is reported and left unnumbered,
 * never numbered by a guess.
 *
 * The rules, as Word applies them:
 *
 *  - A paragraph names a list (numId) and a level (ilvl), directly or through its
 *    paragraph style. A numId of 0 means "no list" and beats the style.
 *  - A list instance (w:num) points at an abstract definition (w:abstractNum). The
 *    counters belong to the definition, not the instance, so two instances of one
 *    definition carry on from each other. A restart is therefore a new instance with
 *    a start override, which is how Word writes "Restart at 1".
 *  - Counting a paragraph at level L adds one to level L and, by default, starts
 *    every deeper level over. A level can be told to restart only after a certain
 *    higher level, or never.
 *  - A level has a format (1, a, A, i, I, 01...) and a text such as "%1." or "(%2)"
 *    or "%1.%2", in which %n stands for the count at level n.
 *
 * The counting is state, and it runs in document order. That is why this is an
 * object that is asked about each paragraph once, in order, and not a function.
 */

import { styleChains } from "./style-chains.ts";
import { elements, first, type XmlElement } from "./xml.ts";

interface Level {
  start: number;
  format: string;
  text: string;
  /** One-based level after which this one starts over. 0 is never, and undefined is after any higher level. */
  restart: number | undefined;
  /** Legal style: the higher levels in the text are shown as ordinary numbers. */
  legal: boolean;
  /** The paragraph style this level is tied to, if any. */
  style: string | undefined;
}

interface Definition {
  levels: Map<number, Level>;
  /** Set when this definition is only a pointer to a numbering style that holds the real one. */
  numStyleLink: string | undefined;
}

interface Instance {
  definition: string;
  overrides: Map<number, { start: number | undefined; level: Level | undefined }>;
}

interface StyleNumbering {
  basedOn: string | undefined;
  numId: string | undefined;
  ilvl: number | undefined;
}

/** What a paragraph shows in front of its text. */
export interface ListLabel {
  /** The label, such as "3." or "b)". Absent for a bullet, or when the list shows nothing. */
  label?: string;
  /** The paragraph is a bullet: a list item that shows a mark and no number or letter. */
  bullet?: true;
  /** Why the label could not be worked out. When set, the paragraph is in a list whose number is not known. */
  unread?: string;
}

export interface Numbering {
  /**
   * The label of a paragraph, given its w:pPr. Undefined when the paragraph is not
   * in a list. Call it once per paragraph, in document order, because it counts.
   */
  label(paragraphProperties: XmlElement | undefined): ListLabel | undefined;
}

export interface NumberingParts {
  /** The numbering part, if the document has one. */
  numbering?: XmlElement | undefined;
  /** The styles part, if the document has one. */
  styles?: XmlElement | undefined;
  /** Set when the numbering part is there and could not be read. Every list paragraph is then reported. */
  numberingDamaged?: string | undefined;
}

const valueOf = (parent: XmlElement, name: string): string | undefined => first(parent, name)?.attrs["w:val"];

function integer(text: string | undefined): number | undefined {
  if (text === undefined || !/^-?\d+$/.test(text.trim())) return undefined;
  return Number(text.trim());
}

/** A toggle property: present means on, unless it says otherwise. */
function isOn(parent: XmlElement, name: string): boolean {
  const element = first(parent, name);
  if (!element) return false;
  const value = element.attrs["w:val"]?.toLowerCase();
  return !(value === "0" || value === "false" || value === "off");
}

function readLevel(lvl: XmlElement): Level {
  return {
    // The specification gives a level with no start the value 0. Word always writes one.
    start: integer(valueOf(lvl, "w:start")) ?? 0,
    format: valueOf(lvl, "w:numFmt") ?? "decimal",
    text: valueOf(lvl, "w:lvlText") ?? "",
    restart: integer(valueOf(lvl, "w:lvlRestart")),
    legal: isOn(lvl, "w:isLgl"),
    style: valueOf(lvl, "w:pStyle"),
  };
}

// ---------------------------------------------------------------------------
// Number formats
// ---------------------------------------------------------------------------

/**
 * Word has nine list levels, 1 to 9, which a file counts from 0. A level outside them is a file Word did not write, and reading it
 * once filled a table of twenty million places (860 MB, then "Map maximum size exceeded").
 */
const MAX_LEVEL = 8;
/** The most Word lets a list start at ("Start at" in its list dialog). A start past it is a number nobody typed. */
const MAX_START = 32_767;
/**
 * The most characters a label may have. A label is what stands in front of a question, "12." or "Question 12:"; one of this length
 * is not one, and a start of 1e9 in letters, which Word repeats (aa, bb, cc), was a label of 38 million letters kept for each
 * paragraph. The same goes for a level text that names the count a hundred thousand times.
 */
const MAX_LABEL = 300;

/** a to z, then aa, bb, cc: Word repeats the letter, it does not count in base 26. */
function letters(n: number, upper: boolean): string {
  const index = (n - 1) % 26;
  const times = Math.floor((n - 1) / 26) + 1;
  const letter = String.fromCharCode((upper ? 65 : 97) + index);
  return letter.repeat(times);
}

const ROMAN: Array<[number, string]> = [
  [1000, "M"],
  [900, "CM"],
  [500, "D"],
  [400, "CD"],
  [100, "C"],
  [90, "XC"],
  [50, "L"],
  [40, "XL"],
  [10, "X"],
  [9, "IX"],
  [5, "V"],
  [4, "IV"],
  [1, "I"],
];

function roman(n: number, upper: boolean): string {
  let rest = n;
  let out = "";
  for (const [value, symbol] of ROMAN) {
    while (rest >= value) {
      out += symbol;
      rest -= value;
    }
  }
  return upper ? out : out.toLowerCase();
}

function ordinal(n: number): string {
  const lastTwo = n % 100;
  const suffix = lastTwo >= 11 && lastTwo <= 13 ? "th" : (["th", "st", "nd", "rd"][n % 10] ?? "th");
  return `${n}${suffix}`;
}

/**
 * A count in a format; undefined for a format this reader does not know; null for a count that would be written in more characters
 * than a label may have (only letters, which repeat, are ever so long).
 */
function formatCount(n: number, format: string): string | undefined | null {
  switch (format) {
    case "decimal":
      return String(n);
    case "decimalZero":
      return n >= 0 && n < 10 ? `0${n}` : String(n);
    case "lowerLetter":
    case "upperLetter":
      if (n >= 1 && Math.floor((n - 1) / 26) + 1 > MAX_LABEL) return null;
      return n >= 1 ? letters(n, format === "upperLetter") : String(n);
    case "lowerRoman":
    case "upperRoman":
      return n >= 1 && n < 4000 ? roman(n, format === "upperRoman") : String(n);
    case "ordinal":
      return ordinal(n);
    case "none":
      return "";
    default:
      return undefined;
  }
}

// ---------------------------------------------------------------------------
// Reading the definitions
// ---------------------------------------------------------------------------

export function readNumbering(parts: NumberingParts): Numbering {
  const definitions = new Map<string, Definition>();
  const instances = new Map<string, Instance>();
  const styles = new Map<string, StyleNumbering>();
  let defaultStyle: string | undefined;

  if (parts.numbering) {
    for (const abstract of elements(parts.numbering, "w:abstractNum")) {
      const id = abstract.attrs["w:abstractNumId"];
      if (id === undefined) continue;
      const levels = new Map<number, Level>();
      for (const lvl of elements(abstract, "w:lvl")) {
        const at = integer(lvl.attrs["w:ilvl"]);
        if (at !== undefined) levels.set(at, readLevel(lvl));
      }
      definitions.set(id, { levels, numStyleLink: valueOf(abstract, "w:numStyleLink") });
    }
    for (const num of elements(parts.numbering, "w:num")) {
      const id = num.attrs["w:numId"];
      const definition = valueOf(num, "w:abstractNumId");
      if (id === undefined || definition === undefined) continue;
      const overrides = new Map<number, { start: number | undefined; level: Level | undefined }>();
      for (const override of elements(num, "w:lvlOverride")) {
        const at = integer(override.attrs["w:ilvl"]);
        if (at === undefined) continue;
        const lvl = first(override, "w:lvl");
        overrides.set(at, {
          start: integer(valueOf(override, "w:startOverride")),
          level: lvl ? readLevel(lvl) : undefined,
        });
      }
      instances.set(id, { definition, overrides });
    }
  }

  if (parts.styles) {
    for (const style of elements(parts.styles, "w:style")) {
      const id = style.attrs["w:styleId"];
      if (id === undefined) continue;
      const properties = first(style, "w:pPr");
      const numPr = properties ? first(properties, "w:numPr") : undefined;
      styles.set(id, {
        basedOn: valueOf(style, "w:basedOn"),
        numId: numPr ? valueOf(numPr, "w:numId") : undefined,
        ilvl: numPr ? integer(valueOf(numPr, "w:ilvl")) : undefined,
      });
      if (style.attrs["w:type"] === "paragraph" && /^(1|true|on)$/i.test(style.attrs["w:default"] ?? "")) defaultStyle = id;
    }
  }

  // A style, and the styles it is based on, nearest first, make its chain; a loop in it ends it where it would repeat, and a style the
  // file does not define ends it too. Asked of a chain one style at a time it cost the length of the chain for each style and for each
  // paragraph, and a chain of 20,000 styles (168 KB of file) took 28 seconds to read, so the chains are worked out once for all the
  // styles together (`styleChains`) and each question about one is a lookup.
  const chains = styleChains(styles);
  const withLevel = chains.nearest((s) => s.ilvl !== undefined);
  const withList = chains.nearest((s) => s.numId !== undefined);

  /**
   * The definition a list instance takes its levels from, following a link to a
   * numbering style. The counting is not shared with the list that is linked to:
   * Word counts each definition on its own, linked or not.
   */
  const definitionOf = (instance: Instance): Definition | undefined => {
    let id = instance.definition;
    for (let hops = 0; hops < 8; hops++) {
      const definition = definitions.get(id);
      if (!definition) return undefined;
      if (definition.numStyleLink === undefined) return definition;
      const linked = styles.get(definition.numStyleLink)?.numId;
      const next = linked === undefined ? undefined : instances.get(linked)?.definition;
      if (next === undefined) return undefined;
      id = next;
    }
    return undefined;
  };

  /**
   * What a style asks for when it names a list: the level of a definition. Word
   * lets only one style hold each level. The holder is the style the level is tied
   * to (w:pStyle in the definition), and failing that the first style in the styles
   * part to ask for it. Another style that asks for the same level is not numbered
   * at all, however the paragraph is otherwise set, and Word shows nothing for it.
   * (Checked against Word with documents built for the purpose.)
   */
  const claimOf = (styleId: string): { level: string; tiedTo: string | undefined } | undefined => {
    const style = styles.get(styleId);
    if (style?.numId === undefined || style.numId === "0") return undefined;
    const instance = instances.get(style.numId);
    if (!instance) return undefined;
    // The style's own level, or the nearest one down its chain that has one.
    const near = withLevel.get(styleId);
    const ilvl = (near ? styles.get(near.style)?.ilvl : undefined) ?? 0;
    return { level: `${instance.definition}/${ilvl}`, tiedTo: definitions.get(instance.definition)?.levels.get(ilvl)?.style };
  };

  const claims = new Map<string, ReturnType<typeof claimOf>>();
  const holders = new Map<string, string>();
  for (const id of styles.keys()) {
    const claim = claimOf(id);
    claims.set(id, claim);
    if (!claim) continue;
    if (claim.tiedTo !== undefined) holders.set(claim.level, claim.tiedTo);
    else if (!holders.has(claim.level)) holders.set(claim.level, id);
  }

  /** Whether the list a style names is really the style's: it holds the level, or is based on the style that does. */
  const holdsItsLevel = (styleId: string): boolean => {
    const claim = claims.get(styleId);
    if (!claim) return true;
    const holder = holders.get(claim.level);
    return holder === undefined || holder === styleId || chains.reaches(styleId, holder);
  };

  /**
   * What a paragraph style gives a paragraph that names no list or level of its own: the list of the nearest style on its chain that
   * names one (and holds the level it names), and the nearest level. A style that names a level some other style holds names
   * nothing, and the search ends there: a level it names is not looked at either. The answer belongs to the style and not to the
   * paragraph, so it is worked out once for each style the paragraphs use.
   */
  const fromStyle = new Map<string, { list: string | undefined; level: number | undefined }>();
  const styleGives = (styleId: string | undefined): { list: string | undefined; level: number | undefined } => {
    if (styleId === undefined || !styles.has(styleId)) return { list: undefined, level: undefined };
    const known = fromStyle.get(styleId);
    if (known) return known;
    const listAt = withList.get(styleId);
    const levelAt = withLevel.get(styleId);
    let given: { list: string | undefined; level: number | undefined };
    if (listAt && !holdsItsLevel(listAt.style)) {
      given = { list: undefined, level: levelAt && levelAt.steps < listAt.steps ? styles.get(levelAt.style)?.ilvl : undefined };
    } else {
      given = { list: listAt ? styles.get(listAt.style)?.numId : undefined, level: levelAt ? styles.get(levelAt.style)?.ilvl : undefined };
    }
    fromStyle.set(styleId, given);
    return given;
  };

  const counters = new Map<string, Map<number, number>>();
  const started = new Set<string>();

  return {
    label(properties: XmlElement | undefined): ListLabel | undefined {
      const direct = properties ? first(properties, "w:numPr") : undefined;
      const directId = direct ? valueOf(direct, "w:numId") : undefined;
      const directLevel = direct ? integer(valueOf(direct, "w:ilvl")) : undefined;
      const styleId = (properties ? valueOf(properties, "w:pStyle") : undefined) ?? defaultStyle;

      // The nearest style in the chain that names a list, and the nearest that names a
      // level. A style that names a level some other style holds names nothing.
      const { list: styleList, level: styleLevel } = styleGives(styleId);

      const numId = directId ?? styleList;
      if (numId === undefined || numId === "0") return undefined;

      if (parts.numberingDamaged !== undefined) return { unread: `the numbering part of the file could not be read: ${parts.numberingDamaged}` };

      const instance = instances.get(numId);
      if (!instance) return { unread: "the list it belongs to is not defined in the file" };
      const definition = definitionOf(instance);
      if (!definition) return { unread: "the list it belongs to is not defined in the file" };

      // The level is the paragraph's own, or its style's even when the paragraph
      // chose a different list, or the first. A level that a definition ties to a
      // style does not pull the style's paragraphs to that level: the style has to say it.
      const ilvl = directLevel ?? styleLevel ?? 0;
      // The counting below keeps a count for every level above this one, so a level of twenty million was twenty million counts.
      if (ilvl < 0 || ilvl > MAX_LEVEL) return { unread: `its level (${ilvl + 1}) is not one of the nine levels (1 to 9) that a Word list has` };

      const levelOf = (at: number): Level | undefined => instance.overrides.get(at)?.level ?? definition.levels.get(at);
      const level = levelOf(ilvl);
      if (!level) return { unread: `its level (${ilvl + 1}) is not defined in the list` };

      // Word shows nothing for a level that restarts after a level that is not above
      // it, so a number for it would be a guess.
      if (level.restart !== undefined && !(level.restart >= 0 && level.restart <= Math.max(ilvl - 1, 0))) {
        return { unread: `its level (${ilvl + 1}) says it restarts after level ${level.restart}, which Word does not accept` };
      }

      // Counting from a number that Word's own list dialog would not take is a guess at what was meant, and in letters it is a label of
      // millions of them. The starts that can show in this label are those of this level (and its override) and of the levels above,
      // which are counted once if they have not been used. A bullet shows no number.
      // The paragraph is still counted when its start is one of those, and is given back as unread after the counting: a paragraph
      // that left the count out would make every number after it in the list one lower than the same file read before, and a number
      // that moves is how a key lands on the wrong question.
      let startUnread: string | undefined;
      if (level.format !== "bullet") {
        let biggest = Math.max(level.start, instance.overrides.get(ilvl)?.start ?? 0);
        for (let above = 0; above < ilvl; above++) biggest = Math.max(biggest, levelOf(above)?.start ?? 0);
        if (biggest > MAX_START) startUnread = `its start (${biggest}) is more than the 32,767 that Word lets a list start at`;
      }

      // Count it. The first paragraph of an instance at a level starts that level
      // at the instance's start override, if it has one. The counts belong to the
      // definition, so a second instance of it carries on from the first.
      let count = counters.get(instance.definition);
      if (!count) {
        count = new Map();
        counters.set(instance.definition, count);
      }
      const begun = `${numId}/${ilvl}`;
      if (!started.has(begun)) {
        started.add(begun);
        const override = instance.overrides.get(ilvl)?.start;
        if (override !== undefined) count.set(ilvl, override - 1);
      }
      const value = (count.get(ilvl) ?? level.start - 1) + 1;
      count.set(ilvl, value);
      // A level above that has not been used is counted as if it had been, once,
      // so the next item of that level is the second.
      for (let above = 0; above < ilvl; above++) {
        if (!count.has(above)) count.set(above, levelOf(above)?.start ?? 1);
      }
      for (const deeper of [...count.keys()]) {
        if (deeper <= ilvl) continue;
        const limit = levelOf(deeper)?.restart ?? deeper;
        if (limit !== 0 && ilvl < limit) count.delete(deeper);
      }

      if (startUnread !== undefined) return { unread: startUnread };
      if (level.format === "bullet") return { bullet: true };

      // A text longer than a label may be is not read, before it is: a text that names the count a hundred thousand times was a
      // label of that many numbers for each paragraph.
      if (level.text.length > MAX_LABEL) return { unread: `the text of its level is more than ${MAX_LABEL} characters long, which is not a label` };

      let unknown: string | undefined;
      let tooLong = false;
      let startTooBig: number | undefined;
      let made = 0;
      const text = level.text.replace(/%([1-9])/g, (_, digit: string) => {
        if (tooLong) return "";
        const at = Number(digit) - 1;
        const there = levelOf(at);
        const shownBefore = count.get(at);
        const n = at === ilvl ? value : (shownBefore ?? there?.start ?? 1);
        // A level below this one that has not been counted shows its start, which the check above did not look at.
        if (at > ilvl && shownBefore === undefined && n > MAX_START) startTooBig = n;
        const own = there?.format ?? "decimal";
        // Legal style turns letters, numerals and ordinals into plain numbers, the
        // level's own included.
        const format = level.legal && /^(lower|upper)(Letter|Roman)$|^ordinal$/.test(own) ? "decimal" : own;
        const shown = formatCount(n, format);
        if (shown === null) {
          tooLong = true;
          return "";
        }
        if (shown === undefined) {
          unknown = format;
          return "";
        }
        made += shown.length;
        if (made > MAX_LABEL) tooLong = true;
        return tooLong ? "" : shown;
      });
      if (unknown !== undefined) return { unread: `its numbering format (${unknown}) is not one this reader knows` };
      if (tooLong || text.length > MAX_LABEL) return { unread: `the number it would show is more than ${MAX_LABEL} characters long, which is not a label` };
      if (startTooBig !== undefined) return { unread: `its start (${startTooBig}) is more than the 32,767 that Word lets a list start at` };

      const label = text.trim();
      return label === "" ? {} : { label };
    },
  };
}
