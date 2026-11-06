/**
 * Characters typed from Word's Symbol font, read as the characters they show.
 *
 * Greek letters, plus and minus, degrees, arrows and the signs of mathematics are often not Unicode in an older Word file: they are
 * a code in the Symbol font. Word writes one of two ways, and both were lost or wrong here. Insert Symbol writes
 * `<w:sym w:font="Symbol" w:char="F061"/>`, which was skipped (counted, and left no mark where it stood). Text typed while the font
 * is Symbol is written as ordinary letters in a run whose font is Symbol: `<w:t>abc</w:t>` shows as the three Greek letters, and was
 * read as "abc", which is wrong without a word. The table is Symbol's own encoding to Unicode, and holds only the codes that are
 * certain: a code in the Symbol font that is not here (the pieces of a large bracket, say) is not guessed, and is marked and counted
 * like any other symbol that cannot be read.
 */

/** Symbol's code to the character it shows, for the codes 0x20 to 0xF2 that are sure. */
const SYMBOL: Record<number, string> = {
  0x20: " ", 0x21: "!", 0x22: "∀", 0x23: "#", 0x24: "∃", 0x25: "%", 0x26: "&", 0x27: "∋", 0x28: "(", 0x29: ")",
  0x2a: "∗", 0x2b: "+", 0x2c: ",", 0x2d: "−", 0x2e: ".", 0x2f: "/",
  0x30: "0", 0x31: "1", 0x32: "2", 0x33: "3", 0x34: "4", 0x35: "5", 0x36: "6", 0x37: "7", 0x38: "8", 0x39: "9",
  0x3a: ":", 0x3b: ";", 0x3c: "<", 0x3d: "=", 0x3e: ">", 0x3f: "?", 0x40: "≅",
  0x41: "Α", 0x42: "Β", 0x43: "Χ", 0x44: "Δ", 0x45: "Ε", 0x46: "Φ", 0x47: "Γ", 0x48: "Η",
  0x49: "Ι", 0x4a: "ϑ", 0x4b: "Κ", 0x4c: "Λ", 0x4d: "Μ", 0x4e: "Ν", 0x4f: "Ο", 0x50: "Π",
  0x51: "Θ", 0x52: "Ρ", 0x53: "Σ", 0x54: "Τ", 0x55: "Υ", 0x56: "ς", 0x57: "Ω", 0x58: "Ξ",
  0x59: "Ψ", 0x5a: "Ζ", 0x5b: "[", 0x5c: "∴", 0x5d: "]", 0x5e: "⊥", 0x5f: "_",
  0x61: "α", 0x62: "β", 0x63: "χ", 0x64: "δ", 0x65: "ε", 0x66: "φ", 0x67: "γ", 0x68: "η",
  0x69: "ι", 0x6a: "ϕ", 0x6b: "κ", 0x6c: "λ", 0x6d: "μ", 0x6e: "ν", 0x6f: "ο", 0x70: "π",
  0x71: "θ", 0x72: "ρ", 0x73: "σ", 0x74: "τ", 0x75: "υ", 0x76: "ϖ", 0x77: "ω", 0x78: "ξ",
  0x79: "ψ", 0x7a: "ζ", 0x7b: "{", 0x7c: "|", 0x7d: "}", 0x7e: "∼",
  0xa1: "ϒ", 0xa2: "′", 0xa3: "≤", 0xa4: "⁄", 0xa5: "∞", 0xa6: "ƒ", 0xa7: "♣", 0xa8: "♦",
  0xa9: "♥", 0xaa: "♠", 0xab: "↔", 0xac: "←", 0xad: "↑", 0xae: "→", 0xaf: "↓",
  0xb0: "°", 0xb1: "±", 0xb2: "″", 0xb3: "≥", 0xb4: "×", 0xb5: "∝", 0xb6: "∂", 0xb7: "•",
  0xb8: "÷", 0xb9: "≠", 0xba: "≡", 0xbb: "≈", 0xbc: "…",
  0xc0: "ℵ", 0xc1: "ℑ", 0xc2: "ℜ", 0xc3: "℘", 0xc4: "⊗", 0xc5: "⊕", 0xc6: "∅", 0xc7: "∩",
  0xc8: "∪", 0xc9: "⊃", 0xca: "⊇", 0xcb: "⊄", 0xcc: "⊂", 0xcd: "⊆", 0xce: "∈", 0xcf: "∉",
  0xd0: "∠", 0xd1: "∇", 0xd5: "∏", 0xd6: "√", 0xd7: "⋅", 0xd8: "¬", 0xd9: "∧", 0xda: "∨",
  0xdb: "⇔", 0xdc: "⇐", 0xdd: "⇑", 0xde: "⇒", 0xdf: "⇓", 0xe0: "◊", 0xe5: "∑", 0xf2: "∫",
};

/** Whether a font name is the Symbol font. Word writes the name as the person's machine knew it, so the case is not trusted. */
export const isSymbolFont = (name: string | undefined): boolean => name !== undefined && name.trim().toLowerCase() === "symbol";

/** The character a Symbol-font code shows, or `undefined` when the code is not one this table is sure of. */
export function symbolChar(code: number): string | undefined {
  // Word keeps a Symbol code in the private use area, 0xF000 above the code, as well as at the code itself.
  const low = code >= 0xf020 && code <= 0xf0ff ? code - 0xf000 : code;
  return Object.hasOwn(SYMBOL, low) ? SYMBOL[low] : undefined;
}

/**
 * Text written in a run whose font is Symbol, as what it shows. `fonts` are the run's own `w:rFonts` names: the one for the
 * characters of ordinary text (`ascii`) and the one for the rest (`hAnsi`), which are the two a run of Latin text and signs is shown
 * in. A character in a Symbol-font range that the table is not sure of is left in the text and counted in `unsure`, never changed.
 */
export function inSymbolFont(text: string, fonts: { ascii?: string; hAnsi?: string }): { text: string; changed: number; unsure: number } {
  let out = "";
  let changed = 0;
  let unsure = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) as number;
    const font = code >= 0x20 && code <= 0x7e ? fonts.ascii : fonts.hAnsi;
    if (!isSymbolFont(font) || code < 0x20) {
      out += ch;
      continue;
    }
    const shown = symbolChar(code);
    if (shown === undefined) {
      out += ch;
      unsure++;
    } else {
      out += shown;
      if (shown !== ch) changed++;
    }
  }
  return { text: out, changed, unsure };
}
