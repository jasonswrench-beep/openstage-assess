/**
 * A small XML reader for the parts of a .docx.
 *
 * The engine has no runtime dependencies, so this is ours. It reads what Word,
 * Google Docs and LibreOffice write: elements, attributes, text, character
 * references, CDATA, comments and the XML declaration. It is deliberately not a
 * general XML parser.
 *
 * What it refuses, on purpose, because a .docx is untrusted input:
 *
 *   - A document type declaration. Word files do not have one, and it is the door
 *     to entity expansion ("billion laughs") and external entities. With none
 *     read there is nothing to expand, so the attack has no way in.
 *   - More than a set depth, size, or number of nodes, so a file built to exhaust
 *     memory or the stack ends in a readable error.
 *   - Malformed markup of any kind: a mismatched end tag, an undeclared prefix, a
 *     repeated attribute, a bare ampersand, an unknown named reference. Each error
 *     says where.
 *
 * Names are canonical. Word always writes `w:` for the main namespace, but the
 * standard lets any prefix stand for it, and the "strict" flavour of Open XML uses
 * different namespace addresses for the same elements. So a name is resolved
 * through its declared namespace and written with a fixed prefix: `w:p` is a
 * paragraph however the file spelled it. A namespace this reader does not know is
 * left as written.
 */

export interface XmlElement {
  /** Canonical name, for example "w:p". */
  name: string;
  /** Canonical attribute names, for example "w:val" and "xml:space". */
  attrs: Record<string, string>;
  /** Elements, and text as plain strings, in document order. */
  children: XmlNode[];
}

export type XmlNode = XmlElement | string;

export interface XmlLimits {
  /** Characters of source text. */
  maxChars?: number;
  maxDepth?: number;
  /** Elements and text nodes together. */
  maxNodes?: number;
}

/**
 * A node costs 180 to 500 bytes once it is in the tree and has been read (an empty cell of a sheet 183, an empty Word paragraph 500),
 * so the 10 million nodes this once allowed were 2 to 5 GB, from a file of 17 to 30 KB: `<w:p/>` three million times took 1.5 GB.
 * Three million is above any real part. The parts Word wrote in this repository's fixtures spend 29.7 characters or more on each node
 * (the densest is the document of equations, measured with parseXml on every part of fixtures/word-authored), so a part of that
 * density at the 64 million character limit has at most 2.2 million of them, and a test bank of a thousand questions has a few
 * hundred thousand. An Excel sheet is denser (about 11 characters a node and three nodes a cell), and three million nodes is a
 * million cells, which is 90,000 rows of the eleven columns of the template. The large private corpora were not at hand to measure.
 */
export const DEFAULT_XML_LIMITS: Required<XmlLimits> = {
  maxChars: 64 * 1024 * 1024,
  maxDepth: 256,
  maxNodes: 3_000_000,
};

export class XmlError extends Error {
  /**
   * True when the XML may well be valid and is simply more than this reader takes (too long, too many parts, nested too deep), so that
   * a message to a person does not call a good file damaged and can say what to do about its size.
   */
  readonly tooLarge: boolean;
  constructor(message: string, tooLarge = false) {
    super(message);
    this.name = "XmlError";
    this.tooLarge = tooLarge;
  }
}

const XML_NAMESPACE = "http://www.w3.org/XML/1998/namespace";

/** Namespace addresses mapped to the prefix this code uses for them. An empty prefix means none. */
const CANONICAL: Record<string, string> = {
  "http://schemas.openxmlformats.org/wordprocessingml/2006/main": "w",
  "http://purl.oclc.org/ooxml/wordprocessingml/main": "w",
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships": "r",
  "http://purl.oclc.org/ooxml/officeDocument/relationships": "r",
  "http://schemas.openxmlformats.org/drawingml/2006/main": "a",
  "http://purl.oclc.org/ooxml/drawingml/main": "a",
  "http://schemas.openxmlformats.org/drawingml/2006/picture": "pic",
  "http://purl.oclc.org/ooxml/drawingml/picture": "pic",
  "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing": "wp",
  "http://purl.oclc.org/ooxml/drawingml/wordprocessingDrawing": "wp",
  "http://schemas.openxmlformats.org/officeDocument/2006/math": "m",
  "http://purl.oclc.org/ooxml/officeDocument/math": "m",
  "http://schemas.openxmlformats.org/markup-compatibility/2006": "mc",
  "http://schemas.microsoft.com/office/word/2010/wordml": "w14",
  "http://schemas.microsoft.com/office/word/2010/wordprocessingShape": "wps",
  "http://schemas.microsoft.com/office/word/2010/wordprocessingGroup": "wpg",
  "urn:schemas-microsoft-com:vml": "v",
  "urn:schemas-microsoft-com:office:word": "w10",
  "http://schemas.openxmlformats.org/package/2006/relationships": "",
  "http://schemas.openxmlformats.org/package/2006/content-types": "",
  [XML_NAMESPACE]: "xml",
};

/**
 * The namespace prefixes in force: what an element declares itself, and the scope of the element it is inside. An element that declares
 * nothing shares its parent's scope. It was once a copy of the whole map for every element that declared anything, which was N squared for
 * a root that declares N prefixes and N children that each declare one (a manifest of 1.2 MB took 23 seconds).
 */
interface Scope {
  declared: ReadonlyMap<string, string>;
  parent: Scope | undefined;
}

function lookupPrefix(scope: Scope, prefix: string): string | undefined {
  for (let s: Scope | undefined = scope; s !== undefined; s = s.parent) {
    const found = s.declared.get(prefix);
    if (found !== undefined) return found;
  }
  return undefined;
}

const NAMED_REFERENCES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

const START_NAME = /[^\s\/>=]+/y;
const ATTRIBUTE = /\s+([^\s=\/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/y;
const REFERENCE = /&(#[xX][0-9a-fA-F]+|#[0-9]+|[A-Za-z][A-Za-z0-9]*);|&/g;

interface Open {
  element: XmlElement;
  /** The name as the file wrote it, which the end tag has to repeat. */
  rawName: string;
  scope: Scope;
}

export function parseXml(source: string, limits: XmlLimits = {}): XmlElement {
  const maxChars = limits.maxChars ?? DEFAULT_XML_LIMITS.maxChars;
  const maxDepth = limits.maxDepth ?? DEFAULT_XML_LIMITS.maxDepth;
  const maxNodes = limits.maxNodes ?? DEFAULT_XML_LIMITS.maxNodes;

  if (source.length > maxChars) {
    throw new XmlError(`This XML is ${source.length} characters long, more than the ${maxChars} this reader accepts.`, true);
  }

  function fail(message: string, at: number, tooLarge = false): never {
    let line = 1;
    let column = 1;
    for (let k = 0; k < at && k < source.length; k++) {
      if (source.charCodeAt(k) === 10) {
        line++;
        column = 1;
      } else column++;
    }
    throw new XmlError(`${message} (line ${line}, column ${column})`, tooLarge);
  }

  /** Character and named references decoded. Anything else starting with "&" is an error. */
  function decode(raw: string, at: number): string {
    if (!raw.includes("&")) return raw;
    return raw.replace(REFERENCE, (whole, body: string | undefined, index: number) => {
      if (body === undefined) return fail(`A "&" that does not start a character reference`, at + index);
      if (body.startsWith("#")) {
        const hex = body[1] === "x" || body[1] === "X";
        const code = Number.parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);
        const allowed =
          code === 9 ||
          code === 10 ||
          code === 13 ||
          (code >= 0x20 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) && code !== 0xfffe && code !== 0xffff);
        if (!allowed) return fail(`The character reference "${whole}" is not a character XML allows`, at + index);
        return String.fromCodePoint(code);
      }
      const named = Object.hasOwn(NAMED_REFERENCES, body) ? NAMED_REFERENCES[body] : undefined;
      if (named === undefined) {
        return fail(`The reference "${whole}" is not one this reader knows; Word files use only &amp; &lt; &gt; &quot; and &apos;`, at + index);
      }
      return named;
    });
  }

  function resolve(raw: string, scope: Scope, isAttribute: boolean, at: number): string {
    const colon = raw.indexOf(":");
    if (colon === -1 && isAttribute) return raw; // an attribute with no prefix has no namespace
    const prefix = colon === -1 ? "" : raw.slice(0, colon);
    const local = colon === -1 ? raw : raw.slice(colon + 1);
    if (local.length === 0) return fail(`"${raw}" is not a valid name`, at);

    const uri = prefix === "xml" ? XML_NAMESPACE : lookupPrefix(scope, prefix);
    if (uri === undefined && colon !== -1) return fail(`The prefix "${prefix}" in "${raw}" is not declared`, at);
    if (uri !== undefined && Object.hasOwn(CANONICAL, uri)) {
      const canonical = CANONICAL[uri] as string;
      return canonical === "" ? local : `${canonical}:${local}`;
    }
    return raw;
  }

  let root: XmlElement | undefined;
  const stack: Open[] = [];
  const base: Scope = { declared: new Map<string, string>(), parent: undefined };
  let nodes = 0;
  let i = source.charCodeAt(0) === 0xfeff ? 1 : 0;
  let pending = "";
  let pendingAt = i;

  function countNode(at: number): void {
    if (++nodes > maxNodes) fail(`This XML has more than ${maxNodes} parts, more than this reader accepts`, at, true);
  }

  function addText(text: string, at: number): void {
    if (pending === "") pendingAt = at;
    pending += text;
  }

  function flushText(): void {
    if (pending === "") return;
    const parent = stack[stack.length - 1];
    if (parent) {
      countNode(pendingAt);
      parent.element.children.push(pending);
    } else if (pending.trim() !== "") {
      fail("There is text outside the root element", pendingAt);
    }
    pending = "";
  }

  while (i < source.length) {
    const lt = source.indexOf("<", i);
    if (lt === -1) {
      addText(decode(source.slice(i), i), i);
      i = source.length;
      break;
    }
    if (lt > i) addText(decode(source.slice(i, lt), i), i);
    i = lt;

    if (source.startsWith("<!--", i)) {
      const end = source.indexOf("-->", i + 4);
      if (end === -1) fail("A comment is never closed", i);
      i = end + 3;
    } else if (source.startsWith("<![CDATA[", i)) {
      const end = source.indexOf("]]>", i + 9);
      if (end === -1) fail("A CDATA section is never closed", i);
      if (stack.length === 0) fail("There is text outside the root element", i);
      addText(source.slice(i + 9, end), i);
      i = end + 3;
    } else if (source.startsWith("<?", i)) {
      const end = source.indexOf("?>", i + 2);
      if (end === -1) fail("A processing instruction is never closed", i);
      i = end + 2;
    } else if (source.startsWith("<!", i)) {
      fail("This XML declares a document type. Word files do not, and it is not read, because it is how a file asks for entities to be expanded", i);
    } else if (source.startsWith("</", i)) {
      flushText();
      const close = source.indexOf(">", i);
      if (close === -1) fail("An end tag is never closed", i);
      const rawName = source.slice(i + 2, close).trim();
      const open = stack.pop();
      if (!open) fail(`The end tag </${rawName}> has nothing to close`, i);
      else if (open.rawName !== rawName) fail(`The end tag </${rawName}> does not match the start tag <${open.rawName}>`, i);
      i = close + 1;
    } else {
      flushText();
      START_NAME.lastIndex = i + 1;
      const nameMatch = START_NAME.exec(source);
      if (!nameMatch) fail("A tag has no name", i);
      const rawName = (nameMatch as RegExpExecArray)[0];
      let at = START_NAME.lastIndex;

      const raw: Array<{ name: string; value: string; at: number }> = [];
      for (;;) {
        ATTRIBUTE.lastIndex = at;
        const attr = ATTRIBUTE.exec(source);
        if (!attr) break;
        raw.push({ name: attr[1] as string, value: attr[2] ?? attr[3] ?? "", at });
        at = ATTRIBUTE.lastIndex;
      }
      while (at < source.length && /\s/.test(source[at] as string)) at++;
      let selfClosing = false;
      if (source.startsWith("/>", at)) {
        selfClosing = true;
        at += 2;
      } else if (source[at] === ">") {
        at += 1;
      } else {
        fail(`The tag <${rawName}> is not well formed`, at);
      }

      // Namespace declarations first, because they apply to this element's own name.
      let scope: Scope = stack.length > 0 ? (stack[stack.length - 1] as Open).scope : base;
      const declared = raw.filter((a) => a.name === "xmlns" || a.name.startsWith("xmlns:"));
      if (declared.length > 0) {
        const own = new Map<string, string>();
        for (const a of declared) own.set(a.name === "xmlns" ? "" : a.name.slice(6), a.value);
        scope = { declared: own, parent: scope };
      }

      const attrs: Record<string, string> = {};
      for (const a of raw) {
        if (a.name === "xmlns" || a.name.startsWith("xmlns:")) continue;
        if (a.value.includes("<")) fail(`The value of the attribute "${a.name}" contains a "<"`, a.at);
        const resolved = resolve(a.name, scope, true, a.at);
        if (Object.hasOwn(attrs, resolved)) fail(`The attribute "${a.name}" appears twice on <${rawName}>`, a.at);
        attrs[resolved] = decode(a.value, a.at);
      }

      const element: XmlElement = { name: resolve(rawName, scope, false, i), attrs, children: [] };
      countNode(i);
      const parent = stack[stack.length - 1];
      if (parent) parent.element.children.push(element);
      else if (root) fail("There is more than one root element", i);
      else root = element;

      if (!selfClosing) {
        if (stack.length >= maxDepth) fail(`Elements are nested more than ${maxDepth} deep, more than this reader accepts`, i, true);
        stack.push({ element, rawName, scope });
      }
      i = at;
    }
  }

  flushText();
  const unclosed = stack[stack.length - 1];
  if (unclosed) fail(`The XML ends inside <${unclosed.rawName}>, which is never closed`, source.length);
  if (!root) throw new XmlError("There is no element in this XML.");
  return root;
}

// ---------------------------------------------------------------------------
// Reading the tree
// ---------------------------------------------------------------------------

/** Child elements, optionally only those with this name. */
export function elements(parent: XmlElement, name?: string): XmlElement[] {
  const found: XmlElement[] = [];
  for (const child of parent.children) {
    if (typeof child !== "string" && (name === undefined || child.name === name)) found.push(child);
  }
  return found;
}

export function first(parent: XmlElement, name: string): XmlElement | undefined {
  for (const child of parent.children) {
    if (typeof child !== "string" && child.name === name) return child;
  }
  return undefined;
}

/** All the text inside an element and everything beneath it. */
export function allText(element: XmlElement): string {
  let text = "";
  for (const child of element.children) text += typeof child === "string" ? child : allText(child);
  return text;
}

/** Whether an element, or anything beneath it, holds any text that is not white space. */
export function hasText(element: XmlElement): boolean {
  for (const child of element.children) {
    if (typeof child === "string") {
      if (child.trim() !== "") return true;
    } else if (hasText(child)) return true;
  }
  return false;
}

/** The elements that hold words a person reads: a Word run's text, a drawing's text, and an equation's. Everything else in a drawing is numbers and names. */
const WORD_ELEMENTS = new Set(["w:t", "a:t", "m:t"]);

/**
 * The words inside an element, and nothing else. A drawing's XML is full of text that is not words (the offset of a floating
 * picture from the margin, the name of a shape, an alignment), so asking whether it "has text" took every floating picture for a
 * text box. Only the elements that hold what a person reads are counted.
 */
export function wordsIn(element: XmlElement): string {
  let text = "";
  for (const child of element.children) {
    if (typeof child === "string") continue;
    text += WORD_ELEMENTS.has(child.name) ? allText(child) : wordsIn(child);
  }
  return text;
}

/** Whether an element holds any words, as `wordsIn` counts them, other than white space. */
export function holdsWords(element: XmlElement): boolean {
  for (const child of element.children) {
    if (typeof child === "string") continue;
    if (WORD_ELEMENTS.has(child.name) ? hasText(child) : holdsWords(child)) return true;
  }
  return false;
}
