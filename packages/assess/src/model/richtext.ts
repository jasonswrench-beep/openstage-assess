/**
 * The restricted rich-text subset.
 *
 * Every piece of authored text in a question is stored as HTML drawn from one
 * fixed, documented list of tags and attributes. The list is closed: anything
 * a Word file, a paste, or an LMS export brings in that is not on it is
 * removed on the way in. A closed subset is what lets the exporters promise
 * what they emit, and what lets the accessibility checks be meaningful.
 *
 * Media and equations are never embedded in the text. They are referenced by
 * placeholder elements that point at the question's media and math sidecars:
 *
 *   <oa-media ref="m_01J..."></oa-media>
 *   <oa-math ref="e_01J..."></oa-math>
 *
 * A block becomes a short token in the editing field. It keeps a stem
 * readable, and it means alt text and MathML can be checked without parsing
 * the surrounding HTML.
 */

export interface RichText {
  format: "rich" | "plain";
  content: string;
}

export const ALLOWED_TAGS: Record<string, readonly string[]> = {
  p: [],
  br: [],
  strong: [],
  em: [],
  u: [],
  s: [],
  sub: [],
  sup: [],
  code: [],
  pre: [],
  ul: [],
  ol: ["start"],
  li: [],
  blockquote: [],
  table: [],
  thead: [],
  tbody: [],
  tr: [],
  th: ["colspan", "rowspan", "scope"],
  td: ["colspan", "rowspan"],
  "oa-media": ["ref"],
  "oa-math": ["ref"],
};

const VOID_TAGS = new Set(["br"]);

/** Content inside these is dropped entirely, not just unwrapped. */
const DROP_CONTENT_TAGS = new Set(["script", "style", "head", "title", "iframe", "object", "embed"]);

export function rich(content: string): RichText {
  return { format: "rich", content };
}

export function plain(content: string): RichText {
  return { format: "plain", content };
}

/** Wrap plain text as a single paragraph of rich text, escaping it. */
export function plainToRich(text: string): RichText {
  const paragraphs = text
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
    .map((p) => `<p>${escapeHtml(p).replace(/\n/g, "<br>")}</p>`);
  return rich(paragraphs.join(""));
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

/** A code point String.fromCodePoint will accept. Anything else throws. */
function isCodePoint(code: number): boolean {
  return Number.isInteger(code) && code >= 0 && code <= 0x10ffff;
}

export function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body: string) => {
    // Number.isFinite alone only rejects NaN, so an out-of-range reference such
    // as &#x110000; threw a RangeError out of here. That was enough to make a
    // whole bank unopenable, because the index build runs over every stem.
    if (body.startsWith("#x") || body.startsWith("#X")) {
      const code = Number.parseInt(body.slice(2), 16);
      return isCodePoint(code) ? String.fromCodePoint(code) : whole;
    }
    if (body.startsWith("#")) {
      const code = Number.parseInt(body.slice(1), 10);
      return isCodePoint(code) ? String.fromCodePoint(code) : whole;
    }
    const named = Object.hasOwn(ENTITIES, body.toLowerCase()) ? ENTITIES[body.toLowerCase()] : undefined;
    return named ?? whole;
  });
}

/**
 * Characters that have no place in the text of a question and that a file format may refuse: the control characters other than a
 * tab and a line break, a lone half of a surrogate pair, and the two code points that are not characters (U+FFFE and U+FFFF). A
 * vertical tab and a form feed are how Word and a PDF write a manual line break and a page break, so they become a space and not
 * nothing, which would join two words. XML 1.0, which Moodle, QTI and Common Cartridge are written in, does not allow any of the
 * rest, so one such character in one question made an LMS refuse the whole file as not well formed.
 */
export function stripInvalidCharacters(text: string): string {
  return text
    .replace(/[\u000b\u000c]/g, " ")
    .replace(/[\u0000-\u0008\u000e-\u001f\u007f￾￿]/g, "")
    .replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, "");
}

/**
 * Character noise that arrives from Word and has no place in the text of a question: what XML forbids, a no-break space (a space),
 * a soft hyphen and a zero-width space (nothing), and the three ways of ending a line. Cleaned once, on the way in.
 *
 * It does NOT touch typography. Curly quotes, the en dash, the em dash and the ellipsis are what the author wrote. They were once
 * flattened here ("--" for a dash) on the grounds that they break exact-match grading, search and QTI, and the cost was that an
 * instructor's em dash came out as "--" on the printed test and in every export, which nobody asked for. Where a comparison needs
 * the flat form it asks for it with `foldTypography`, on both sides, and what is stored stays as written.
 */
export function normalizeCharacters(text: string): string {
  return stripInvalidCharacters(text)
    .replace(/ /g, " ")
    .replace(/­/g, "")
    .replace(/​/g, "")
    .replace(/\r\n?/g, "\n");
}

/**
 * Whether text shows nothing: once what `normalizeCharacters` removes is gone, only white space and characters that draw nothing are
 * left (a zero width joiner, a direction mark, a word joiner, a byte order mark, any other format or control character). A stem, an
 * option or an item that is only these is empty to the person who reads it, and was stored as an empty paragraph and read as parsed
 * because the importers compared the raw cell with "" before the cleaning took the characters away. Only for deciding; nothing is
 * rewritten, and text with a single visible character in it is never blank.
 */
export function isBlankText(text: string): boolean {
  // Nearly every text has a visible ASCII character, and this is asked of every cell of a large file.
  if (/[!-~]/.test(text)) return false;
  return normalizeCharacters(text).replace(/[\p{White_Space}\p{Cf}\p{Cc}\p{Zs}\p{Zl}\p{Zp}]/gu, "") === "";
}

/**
 * The flat form of typography, for comparing and never for storing: curly quotes to straight, the en dash to a hyphen, the em dash
 * to two, the ellipsis to three dots. Two texts that differ only in how a quotation mark is drawn are the same text to a search, to
 * the check for copies and to the accuracy gate, and are not the same to the person who wrote them.
 */
export function foldTypography(text: string): string {
  return text
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .replace(/–/g, "-")
    .replace(/—/g, "--")
    .replace(/…/g, "...");
}

export interface SanitizeResult {
  html: string;
  removedTags: string[];
  removedAttributes: string[];
}

export interface Token {
  kind: "text" | "open" | "close" | "selfclose" | "comment";
  name?: string;
  attrs?: Record<string, string>;
  text?: string;
}

export function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const lt = input.indexOf("<", i);
    if (lt === -1) {
      tokens.push({ kind: "text", text: input.slice(i) });
      break;
    }
    if (lt > i) tokens.push({ kind: "text", text: input.slice(i, lt) });

    if (input.startsWith("<!--", lt)) {
      const end = input.indexOf("-->", lt + 4);
      const stop = end === -1 ? input.length : end + 3;
      tokens.push({ kind: "comment" });
      i = stop;
      continue;
    }
    if (input.startsWith("<!", lt)) {
      const end = input.indexOf(">", lt);
      i = end === -1 ? input.length : end + 1;
      continue;
    }

    const end = input.indexOf(">", lt);
    if (end === -1) {
      tokens.push({ kind: "text", text: input.slice(lt) });
      break;
    }
    const raw = input.slice(lt + 1, end).trim();
    i = end + 1;
    if (raw.length === 0) continue;

    if (raw.startsWith("/")) {
      tokens.push({ kind: "close", name: raw.slice(1).trim().toLowerCase() });
      continue;
    }
    const selfClosing = raw.endsWith("/");
    const body = selfClosing ? raw.slice(0, -1).trim() : raw;
    const spaceAt = body.search(/\s/);
    const name = (spaceAt === -1 ? body : body.slice(0, spaceAt)).toLowerCase();
    const attrs: Record<string, string> = {};
    if (spaceAt !== -1) {
      const attrText = body.slice(spaceAt);
      const attrPattern = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*(?:=\s*("([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
      let m: RegExpExecArray | null;
      while ((m = attrPattern.exec(attrText)) !== null) {
        const key = (m[1] as string).toLowerCase();
        const value = m[3] ?? m[4] ?? m[5] ?? "";
        attrs[key] = decodeEntities(value);
      }
    }
    tokens.push({ kind: selfClosing ? "selfclose" : "open", name, attrs });
  }
  return tokens;
}

/**
 * Reduce arbitrary HTML to the subset above.
 *
 * Disallowed tags are unwrapped, so their text survives: nothing authored is
 * dropped silently. The few tags in DROP_CONTENT_TAGS are the exception, since
 * their content is never prose.
 */
export function sanitizeRichText(input: string): SanitizeResult {
  const removedTags = new Set<string>();
  const removedAttributes = new Set<string>();
  const out: string[] = [];
  const open: string[] = [];
  let skipDepth = 0;
  let skipTag = "";

  for (const token of tokenize(normalizeCharacters(input))) {
    if (skipDepth > 0) {
      if (token.kind === "open" && token.name === skipTag) skipDepth++;
      else if (token.kind === "close" && token.name === skipTag) skipDepth--;
      continue;
    }

    switch (token.kind) {
      case "comment":
        break;
      case "text": {
        const text = token.text ?? "";
        if (text.length > 0) out.push(escapeHtml(decodeEntities(text)));
        break;
      }
      case "open":
      case "selfclose": {
        const name = token.name as string;
        if (DROP_CONTENT_TAGS.has(name)) {
          removedTags.add(name);
          if (token.kind === "open") {
            skipDepth = 1;
            skipTag = name;
          }
          break;
        }
        // Object.hasOwn, not a bare lookup: ALLOWED_TAGS is a plain object, so
        // <constructor> and <__proto__> used to pass the allow-list test by
        // inheriting from Object.prototype, which both escaped the closed
        // subset and crashed the attribute check below.
        const allowedAttrs = Object.hasOwn(ALLOWED_TAGS, name) ? ALLOWED_TAGS[name] : undefined;
        if (!Array.isArray(allowedAttrs)) {
          removedTags.add(name);
          break; // unwrap: the tag goes, the text stays
        }
        const kept: string[] = [];
        for (const [key, value] of Object.entries(token.attrs ?? {})) {
          if (allowedAttrs.includes(key)) kept.push(`${key}="${escapeHtml(value)}"`);
          else removedAttributes.add(`${name}@${key}`);
        }
        const attrText = kept.length > 0 ? " " + kept.join(" ") : "";
        if (VOID_TAGS.has(name)) {
          out.push(`<${name}${attrText}>`);
        } else if (token.kind === "selfclose") {
          out.push(`<${name}${attrText}></${name}>`);
        } else {
          out.push(`<${name}${attrText}>`);
          open.push(name);
        }
        break;
      }
      case "close": {
        const name = token.name as string;
        if (!Object.hasOwn(ALLOWED_TAGS, name) || VOID_TAGS.has(name)) break;
        const at = open.lastIndexOf(name);
        if (at === -1) break; // stray close tag
        while (open.length > at) {
          out.push(`</${open.pop()}>`);
        }
        break;
      }
    }
  }
  while (open.length > 0) out.push(`</${open.pop()}>`);

  return {
    html: out.join(""),
    removedTags: [...removedTags].sort(),
    removedAttributes: [...removedAttributes].sort(),
  };
}

/** Plain text for search, previews, reading level and duplicate detection. */
export function richTextToPlain(value: RichText | string): string {
  const content = typeof value === "string" ? value : value.content;
  const withBreaks = content
    .replace(/<\s*br\s*\/?\s*>/gi, "\n")
    .replace(/<\s*\/\s*(p|li|tr|div|blockquote|h[1-6])\s*>/gi, "\n")
    // The cells of a row are words apart, or a table of two columns reads as one word to a row.
    .replace(/<\s*\/\s*(td|th)\s*>/gi, " ")
    .replace(/<oa-media[^>]*>\s*<\/oa-media>/gi, " ")
    .replace(/<oa-math[^>]*>\s*<\/oa-math>/gi, " ")
    .replace(/<[^>]*>/g, "");
  return decodeEntities(withBreaks)
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .trim();
}

export interface Refs {
  media: string[];
  math: string[];
}

/** Which media and math sidecars a piece of rich text points at. */
export function collectRefs(value: RichText | string): Refs {
  const content = typeof value === "string" ? value : value.content;
  const media: string[] = [];
  const math: string[] = [];
  const pattern = /<oa-(media|math)\s[^>]*ref\s*=\s*"([^"]*)"/gi;
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(content)) !== null) {
    const kind = (m[1] as string).toLowerCase();
    const ref = m[2] as string;
    if (kind === "media") media.push(ref);
    else math.push(ref);
  }
  return { media, math };
}

export function mediaPlaceholder(ref: string): string {
  return `<oa-media ref="${escapeHtml(ref)}"></oa-media>`;
}

export function mathPlaceholder(ref: string): string {
  return `<oa-math ref="${escapeHtml(ref)}"></oa-math>`;
}

/**
 * Run the sanitizer over every rich-text value anywhere inside a structure.
 *
 * The subset was documented as something enforced "on the way in", and the
 * exporters' guarantee about what they emit rests on that, but nothing on any
 * write path ever called the sanitizer: a stem carrying a script tag validated
 * cleanly, round-tripped through the bank byte for byte, and was handed
 * straight to a player. This is the call that makes the promise true.
 *
 * The walk is structural rather than a list of known fields, so a body shape
 * added later is covered without anyone remembering to add it here. Values
 * marked "plain" are left alone: that content is literal text, not markup, and
 * whoever renders it is responsible for escaping it.
 */
export function sanitizeDeep<T>(value: T): { value: T; removedTags: string[]; removedAttributes: string[] } {
  const removedTags = new Set<string>();
  const removedAttributes = new Set<string>();

  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (node === null || typeof node !== "object") return node;

    const record = node as Record<string, unknown>;
    if (record["format"] === "rich" && typeof record["content"] === "string") {
      const result = sanitizeRichText(record["content"]);
      for (const tag of result.removedTags) removedTags.add(tag);
      for (const attribute of result.removedAttributes) removedAttributes.add(attribute);
      return { ...record, content: result.html };
    }

    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(record)) out[key] = walk(child);
    return out;
  };

  return {
    value: walk(value) as T,
    removedTags: [...removedTags],
    removedAttributes: [...removedAttributes],
  };
}

export function isEmptyRichText(value: RichText | undefined): boolean {
  if (!value) return true;
  // A picture or an equation is not words but is not nothing: a stem that is only an equation is not empty.
  const refs = collectRefs(value);
  return richTextToPlain(value).length === 0 && refs.media.length === 0 && refs.math.length === 0;
}

/**
 * Every rich text value anywhere inside a structure, with its dotted path ("body.pairs.0.left"). The walk is structural, like
 * `sanitizeDeep`, so a field added to a body later is covered without anyone remembering to list it.
 */
export function richTextFields(root: unknown, path = ""): Array<[string, RichText]> {
  if (Array.isArray(root)) return root.flatMap((child, i) => richTextFields(child, path === "" ? String(i) : `${path}.${i}`));
  if (root === null || typeof root !== "object") return [];
  const record = root as Record<string, unknown>;
  if ((record["format"] === "rich" || record["format"] === "plain") && typeof record["content"] === "string") return [[path, record as unknown as RichText]];
  return Object.entries(record).flatMap(([key, child]) => richTextFields(child, path === "" ? key : `${path}.${key}`));
}
