/**
 * What a run of text looks like in a Word document: bold, italic, underlined,
 * highlighted, coloured.
 *
 * Publisher test banks very often mark the right answer by formatting it, and the
 * importer reads that (see ../standard-text-format.ts). What it needs from here is
 * only whether a stretch of text is bold, italic, underlined, highlighted or in a
 * colour, as Word would show it. That is not just the run's own properties. A run
 * takes its look from the document's defaults, its paragraph's style, its own
 * character style, and its direct formatting, and a person who pressed Ctrl+B has
 * written only the last of those, while one who used the "Strong" style has
 * written only the third.
 *
 * The rules, as Word applies them (the ones below that are not obvious were
 * checked against Word; see test/tools/word-formatting-check.ts):
 *
 *  - Direct formatting wins over everything.
 *  - Bold and italic are "toggle properties". A style that turns one on while
 *    another style level has already turned it on turns it back off, so a bold
 *    paragraph style with a bold character style on top is not bold. Within one
 *    chain of styles that are based on each other, the nearest wins as usual.
 *  - Hidden text is a toggle property too, and is asked for apart (`hidden`), since text that
 *    Word does not show is not read.
 *  - Underline, highlight and colour have no toggle: the nearest level wins. The
 *    one exception is a highlight in a character style, which Word ignores.
 *  - "none" for an underline or a highlight, and "auto" for a colour, mean there
 *    is none.
 */

import type { SourceRun } from "../types.ts";
import { styleChains, type Near } from "./style-chains.ts";
import { elements, first, type XmlElement } from "./xml.ts";

/** What a run looks like. A property that is absent is off. */
export type RunFormat = Omit<SourceRun, "text">;

/** One style's own say on each property, before it is combined with anything. */
interface Said {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  /** A highlight name, or null when the style says there is none. */
  highlight?: string | null;
  /** A colour, or null when the style says automatic. */
  color?: string | null;
  /** Hidden text. Not part of a run's look: asked for apart, by `Formatting.hidden`. */
  hidden?: boolean;
}

interface StyleFormatting {
  type: string | undefined;
  basedOn: string | undefined;
  said: Said;
}

export interface Formatting {
  /**
   * The format of a run, given its w:rPr (if any) and the id of the style of the
   * paragraph it is in (if the paragraph names one).
   */
  run(runProperties: XmlElement | undefined, paragraphStyle: string | undefined): RunFormat;
  /**
   * Whether Word hides the text of a run, or a paragraph mark, as it would with "show hidden text" off. Hidden is
   * a toggle property like bold, so a hidden paragraph style under a hidden character style shows the text again.
   * Apart from `run` because a hidden run is not read at all, and so has no look to keep.
   */
  hidden(runProperties: XmlElement | undefined, paragraphStyle: string | undefined): boolean;
}

/** A toggle property: present means on, unless its value says otherwise. */
function toggle(properties: XmlElement, name: string): boolean | undefined {
  const element = first(properties, name);
  if (!element) return undefined;
  const value = element.attrs["w:val"]?.toLowerCase();
  return !(value === "0" || value === "false" || value === "off");
}

/** What a w:rPr says, and nothing it leaves to something else. */
function said(properties: XmlElement | undefined): Said {
  if (!properties) return {};
  const out: Said = {};
  const bold = toggle(properties, "w:b");
  if (bold !== undefined) out.bold = bold;
  const italic = toggle(properties, "w:i");
  if (italic !== undefined) out.italic = italic;
  const hidden = toggle(properties, "w:vanish");
  if (hidden !== undefined) out.hidden = hidden;

  const underline = first(properties, "w:u");
  if (underline) out.underline = (underline.attrs["w:val"] ?? "single").toLowerCase() !== "none";

  const highlight = first(properties, "w:highlight");
  if (highlight) {
    const name = (highlight.attrs["w:val"] ?? "").toLowerCase();
    out.highlight = name === "" || name === "none" ? null : name;
  }

  const color = first(properties, "w:color");
  if (color) {
    const value = (color.attrs["w:val"] ?? "").toUpperCase();
    // Black spelled out is the same to a reader as automatic, and an author who
    // typed it did not mean to mark anything.
    out.color = value === "" || value === "AUTO" || value === "000000" ? null : value;
  }
  return out;
}

export function readFormatting(styles: XmlElement | undefined): Formatting {
  const byId = new Map<string, StyleFormatting>();
  let defaults: Said = {};
  let defaultParagraphStyle: string | undefined;

  if (styles) {
    const docDefaults = first(styles, "w:docDefaults");
    const runDefaults = docDefaults ? first(docDefaults, "w:rPrDefault") : undefined;
    defaults = said(runDefaults ? first(runDefaults, "w:rPr") : undefined);

    for (const style of elements(styles, "w:style")) {
      const id = style.attrs["w:styleId"];
      if (id === undefined) continue;
      byId.set(id, {
        type: style.attrs["w:type"],
        basedOn: first(style, "w:basedOn")?.attrs["w:val"],
        said: said(first(style, "w:rPr")),
      });
      if (style.attrs["w:type"] === "paragraph" && /^(1|true|on)$/i.test(style.attrs["w:default"] ?? "")) defaultParagraphStyle = id;
    }
  }

  // A style and the styles it is based on, nearest first, make its chain; a loop in it ends it where it would repeat. The nearest say
  // on a property along a chain is worked out once for all the styles (see style-chains.ts), because asked of one chain at a time it
  // cost the length of the chain for each pair of styles a paragraph and a run used, and 20,000 paragraphs in 20,000 styles of one
  // chain took half a minute.
  const chains = styleChains(byId);
  const nears = new Map<keyof Said, Map<string, Near>>();
  /** The nearest say on a property along the chain of a style (itself first), or undefined if no style on it says. */
  function nearest<K extends keyof Said>(styleId: string | undefined, key: K): Said[K] | undefined {
    let near = nears.get(key);
    if (!near) {
      near = chains.nearest((style) => style.said[key] !== undefined);
      nears.set(key, near);
    }
    const found = styleId === undefined ? undefined : near.get(styleId);
    return found === undefined ? undefined : (byId.get(found.style) as StyleFormatting).said[key];
  }

  // What the styles alone give, for a paragraph style and a character style. The
  // same pair comes up again and again, so it is worked out once.
  const fromStyles = new Map<string, Said>();
  const stylesGive = (paragraphStyle: string | undefined, characterStyle: string | undefined): Said => {
    const key = `${paragraphStyle ?? ""}\u0000${characterStyle ?? ""}`;
    const known = fromStyles.get(key);
    if (known) return known;

    const paragraph = paragraphStyle ?? defaultParagraphStyle;
    const character = characterStyle;
    // The character style's chain, then the paragraph style's: the first to say anything is the nearest. (Not `??`: null is an answer.)
    const nearestOfBoth = <K extends keyof Said>(name: K): Said[K] | undefined => {
      const atCharacter = nearest(character, name);
      return atCharacter !== undefined ? atCharacter : nearest(paragraph, name);
    };

    // A toggle: the paragraph level (with the document's defaults beneath it)
    // and the character level each give a value, and they are combined by XOR.
    const toggled = (name: "bold" | "italic" | "hidden"): boolean => {
      const atParagraph = nearest(paragraph, name) ?? defaults[name] ?? false;
      const atCharacter = nearest(character, name) ?? false;
      return atParagraph !== atCharacter;
    };

    // null is an answer ("none"), so only undefined passes the question down.
    const settle = <T>(atStyles: T | undefined, atDefaults: T | undefined, otherwise: T): T =>
      atStyles !== undefined ? atStyles : atDefaults !== undefined ? atDefaults : otherwise;

    const result: Said = {
      bold: toggled("bold"),
      italic: toggled("italic"),
      hidden: toggled("hidden"),
      underline: settle(nearestOfBoth("underline"), defaults.underline, false),
      // Word takes a highlight from a paragraph style or from the run itself, and
      // ignores one in a character style, whatever it says. Checked against Word.
      highlight: settle(nearest(paragraph, "highlight"), defaults.highlight, null),
      color: settle(nearestOfBoth("color"), defaults.color, null),
    };
    fromStyles.set(key, result);
    return result;
  };

  return {
    run(runProperties, paragraphStyle) {
      const characterStyle = runProperties ? first(runProperties, "w:rStyle")?.attrs["w:val"] : undefined;
      const base = stylesGive(paragraphStyle, characterStyle);
      const direct = said(runProperties);

      const bold = direct.bold ?? base.bold;
      const italic = direct.italic ?? base.italic;
      const underline = direct.underline ?? base.underline;
      const highlight = direct.highlight !== undefined ? direct.highlight : base.highlight;
      const color = direct.color !== undefined ? direct.color : base.color;

      const format: RunFormat = {};
      if (bold) format.bold = true;
      if (italic) format.italic = true;
      if (underline) format.underline = true;
      if (highlight) format.highlight = highlight;
      if (color) format.color = color;
      return format;
    },

    hidden(runProperties, paragraphStyle) {
      const characterStyle = runProperties ? first(runProperties, "w:rStyle")?.attrs["w:val"] : undefined;
      return said(runProperties).hidden ?? stylesGive(paragraphStyle, characterStyle).hidden ?? false;
    },
  };
}
