/**
 * A ToUnicode map: what a font's character codes mean as text.
 *
 * A PDF font shows glyphs by code, and the codes are the font's own. A ToUnicode map is the file's statement of what each code
 * is, which is what makes the text of a PDF copyable. It is a small PostScript-like text with three kinds of line that matter
 * here: the ranges of codes the font uses, single codes with their text, and ranges of codes with their text.
 */

export interface ToUnicode {
  /** How many bytes a code is, from the code space ranges (1 for a simple font, 2 for most others). */
  codeBytes: number;
  lookup(code: number): string | undefined;
}

function utf16(hex: string): string {
  const clean = hex.length % 4 === 2 ? hex.padStart(hex.length + 2, "0") : hex;
  let out = "";
  for (let i = 0; i + 4 <= clean.length; i += 4) out += String.fromCharCode(parseInt(clean.slice(i, i + 4), 16));
  return out;
}

/**
 * The text between each `begin` and the `end` after it. It was a lazy pattern (`begin([\s\S]*?)end`), which from every `begin` that had
 * no `end` after it read to the end of the text: the same word repeated for 2 MB, in a file of 5955 bytes, took 58 seconds. A block that
 * is not closed has nothing after it that closes it, so the search stops there.
 */
function* blocks(text: string, begin: string, end: string): Generator<string> {
  let at = 0;
  for (;;) {
    const from = text.indexOf(begin, at);
    if (from === -1) return;
    const bodyAt = from + begin.length;
    const to = text.indexOf(end, bodyAt);
    if (to === -1) return;
    yield text.slice(bodyAt, to);
    at = to + end.length;
  }
}

export function parseToUnicode(data: Uint8Array): ToUnicode {
  const text = Buffer.from(data).toString("latin1");
  const singles = new Map<number, string>();
  const ranges: Array<{ lo: number; hi: number; to: string | string[] }> = [];
  let codeBytes = 0;

  for (const block of blocks(text, "begincodespacerange", "endcodespacerange")) {
    for (const m of block.matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g)) codeBytes = Math.max(codeBytes, Math.ceil((m[1] as string).length / 2));
  }
  for (const block of blocks(text, "beginbfchar", "endbfchar")) {
    for (const m of block.matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]*)>/g)) {
      singles.set(parseInt(m[1] as string, 16), utf16(m[2] as string));
      codeBytes = Math.max(codeBytes, codeBytes === 0 ? Math.ceil((m[1] as string).length / 2) : 0);
    }
  }
  for (const body of blocks(text, "beginbfrange", "endbfrange")) {
    const re = /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(?:<([0-9a-fA-F]*)>|\[((?:\s*<[0-9a-fA-F]*>)*)\s*\])/g;
    for (const m of body.matchAll(re)) {
      const lo = parseInt(m[1] as string, 16);
      const hi = parseInt(m[2] as string, 16);
      if (hi < lo || hi - lo > 0xffff) continue;
      if (m[3] !== undefined) ranges.push({ lo, hi, to: utf16(m[3]) });
      else ranges.push({ lo, hi, to: [...(m[4] as string).matchAll(/<([0-9a-fA-F]*)>/g)].map((x) => utf16(x[1] as string)) });
      if (codeBytes === 0) codeBytes = Math.ceil((m[1] as string).length / 2);
    }
  }

  return {
    codeBytes: codeBytes || 1,
    lookup(code: number): string | undefined {
      const s = singles.get(code);
      if (s !== undefined) return s;
      for (const r of ranges) {
        if (code < r.lo || code > r.hi) continue;
        if (Array.isArray(r.to)) return r.to[code - r.lo];
        // A range counts up in the last character of its text.
        const last = r.to.length > 0 ? r.to.charCodeAt(r.to.length - 1) + (code - r.lo) : code;
        return r.to.slice(0, -1) + String.fromCharCode(last);
      }
      return undefined;
    },
  };
}
