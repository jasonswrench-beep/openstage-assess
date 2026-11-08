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

// A verbatim copy of src/import/docx/numbering.ts as it was before the chains of styles were worked out once, the level and the start
// were bounded and a label was given a length (alpha 22). Only this import line differs. It is here so that a test can show the
// reader gives the label it always gave on every file it was meant for (numbering-parity.test.ts); do not change it.
import { elements, first, type XmlElement } from "../../src/import/docx/xml.ts";

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

/** A count in a format, or undefined for a format this reader does not know. */
function formatCount(n: number, format: string): string | undefined {
  switch (format) {
    case "decimal":
      return String(n);
    case "decimalZero":
      return n >= 0 && n < 10 ? `0${n}` : String(n);
    case "lowerLetter":
    case "upperLetter":
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

  /** A style and the styles it is based on, nearest first. A loop in the chain ends it. */
  const chainOf = (styleId: string | undefined): string[] => {
    const chain: string[] = [];
    let at = styleId;
    while (at !== undefined && !chain.includes(at) && styles.has(at)) {
      chain.push(at);
      at = styles.get(at)?.basedOn;
    }
    return chain;
  };

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
    let ilvl = style.ilvl;
    for (const above of chainOf(style.basedOn)) {
      if (ilvl !== undefined) break;
      ilvl = styles.get(above)?.ilvl;
    }
    ilvl ??= 0;
    return { level: `${instance.definition}/${ilvl}`, tiedTo: definitions.get(instance.definition)?.levels.get(ilvl)?.style };
  };

  const holders = new Map<string, string>();
  for (const id of styles.keys()) {
    const claim = claimOf(id);
    if (!claim) continue;
    if (claim.tiedTo !== undefined) holders.set(claim.level, claim.tiedTo);
    else if (!holders.has(claim.level)) holders.set(claim.level, id);
  }

  /** Whether the list a style names is really the style's: it holds the level, or is based on the style that does. */
  const holdsItsLevel = (styleId: string): boolean => {
    const claim = claimOf(styleId);
    if (!claim) return true;
    const holder = holders.get(claim.level);
    return holder === undefined || holder === styleId || chainOf(styleId).includes(holder);
  };

  const counters = new Map<string, Map<number, number>>();
  const started = new Set<string>();

  return {
    label(properties: XmlElement | undefined): ListLabel | undefined {
      const direct = properties ? first(properties, "w:numPr") : undefined;
      const directId = direct ? valueOf(direct, "w:numId") : undefined;
      const directLevel = direct ? integer(valueOf(direct, "w:ilvl")) : undefined;
      const styleId = (properties ? valueOf(properties, "w:pStyle") : undefined) ?? defaultStyle;
      const chain = chainOf(styleId);

      // The nearest style in the chain that names a list, and the nearest that names a
      // level. A style that names a level some other style holds names nothing.
      let styleList: string | undefined;
      let styleLevel: number | undefined;
      for (const id of chain) {
        const style = styles.get(id);
        if (styleList === undefined && style?.numId !== undefined) {
          if (holdsItsLevel(id)) styleList = style.numId;
          else break;
        }
        if (styleLevel === undefined && style?.ilvl !== undefined) styleLevel = style.ilvl;
      }

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

      const levelOf = (at: number): Level | undefined => instance.overrides.get(at)?.level ?? definition.levels.get(at);
      const level = levelOf(ilvl);
      if (!level) return { unread: `its level (${ilvl + 1}) is not defined in the list` };

      // Word shows nothing for a level that restarts after a level that is not above
      // it, so a number for it would be a guess.
      if (level.restart !== undefined && !(level.restart >= 0 && level.restart <= Math.max(ilvl - 1, 0))) {
        return { unread: `its level (${ilvl + 1}) says it restarts after level ${level.restart}, which Word does not accept` };
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

      if (level.format === "bullet") return { bullet: true };

      let unknown: string | undefined;
      const text = level.text.replace(/%([1-9])/g, (_, digit: string) => {
        const at = Number(digit) - 1;
        const there = levelOf(at);
        const n = at === ilvl ? value : (count.get(at) ?? there?.start ?? 1);
        const own = there?.format ?? "decimal";
        // Legal style turns letters, numerals and ordinals into plain numbers, the
        // level's own included.
        const format = level.legal && /^(lower|upper)(Letter|Roman)$|^ordinal$/.test(own) ? "decimal" : own;
        const shown = formatCount(n, format);
        if (shown === undefined) {
          unknown = format;
          return "";
        }
        return shown;
      });
      if (unknown !== undefined) return { unread: `its numbering format (${unknown}) is not one this reader knows` };

      const label = text.trim();
      return label === "" ? {} : { label };
    },
  };
}
