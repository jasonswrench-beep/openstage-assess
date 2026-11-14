/**
 * The MathML an equation may hold, and the rebuild of one that holds anything else.
 *
 * The engine writes the MathML of an equation itself, from a short list of elements and attributes, and the window draws it from the
 * same list (`packages/app/ui/math.js`; `packages/app/test/math-draw.test.ts` holds the two lists equal, and holds this to keeping what
 * the engine writes byte for byte). A bank can come from someone else, so what it
 * holds is not trusted as it is (the security review of 2026-11-13): an equation whose MathML is on the list is kept byte for byte, and
 * one that is not is rebuilt from what is on the list. An element that is not on it goes with what is inside it, except `semantics`,
 * which keeps its first child (the equation as drawn; the rest are other forms of it, such as an `annotation-xml` holding XHTML), and an
 * attribute that is not on it goes. MathML that cannot be read at all, or whose first element does not declare the MathML namespace, is
 * left as it was: nothing draws it or writes it as MathML (the window looks for the namespace and shows the LaTeX, and the QTI 2.1
 * exporter writes such an equation as words), so there is nothing to clean and nothing to lose.
 */

import { parseXml, type XmlElement, type XmlNode } from "../import/docx/xml.ts";

export const MATHML_NS = "http://www.w3.org/1998/Math/MathML";

/** The elements the engine writes and the window draws. */
export const MATH_ELEMENTS: ReadonlySet<string> = new Set([
  "math", "mrow", "mi", "mn", "mo", "mtext", "mfrac", "msqrt", "mroot", "msub", "msup", "msubsup", "munder", "mover", "munderover",
  "mmultiscripts", "mprescripts", "none", "mtable", "mtr", "mtd", "menclose", "mphantom",
]);

/** The attributes the engine writes, and the values each may have. */
export const MATH_ATTRIBUTES: Readonly<Record<string, (value: string) => boolean>> = {
  mathvariant: (v) => ["normal", "bold", "bold-italic", "script", "fraktur", "double-struck", "sans-serif", "monospace"].includes(v),
  largeop: (v) => v === "true",
  fence: (v) => v === "true",
  separator: (v) => v === "true",
  accent: (v) => v === "true",
  linethickness: (v) => v === "0",
  notation: (v) => v === "box",
};

/** More elements than any equation has, and more characters: MathML with more is not kept. */
const MAX_ELEMENTS = 5000;
const MAX_CHARS = 500_000;

const allowedAttribute = (name: string, value: string): boolean =>
  Object.hasOwn(MATH_ATTRIBUTES, name) && (MATH_ATTRIBUTES[name] as (v: string) => boolean)(value);

const localName = (name: string): string => name.slice(name.indexOf(":") + 1);

/** Whether the first element of the text is `math`, with or without a prefix, and declares the MathML namespace (by default or for a prefix). */
const declaresMathml = (source: string): boolean =>
  /^<(?:[A-Za-z_][\w.-]*:)?math(?=[\s/>])[^>]*\bxmlns(?::[A-Za-z_][\w.-]*)?\s*=\s*(["'])http:\/\/www\.w3\.org\/1998\/Math\/MathML\1/.test(source);

const escapeText = (text: string): string => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escapeAttribute = (text: string): string => escapeText(text).replace(/"/g, "&quot;");

/** Whether MathML is exactly what the engine writes: unprefixed names on the list, attributes on the list, and the namespace declared. */
function isClean(source: string, root: XmlElement): boolean {
  if (root.name !== "math" || !/^<math\s[^>]*\bxmlns\s*=\s*"http:\/\/www\.w3\.org\/1998\/Math\/MathML"/.test(source.trim())) return false;
  let count = 0;
  const walk = (element: XmlElement): boolean => {
    if (++count > MAX_ELEMENTS || !MATH_ELEMENTS.has(element.name)) return false;
    for (const [name, value] of Object.entries(element.attrs)) if (!allowedAttribute(name, value)) return false;
    return element.children.every((child) => typeof child === "string" || walk(child));
  };
  return walk(root);
}

/** The element written again from the lists, or null when nothing of it is on them. */
function rebuild(element: XmlElement, budget: { left: number }): string | null {
  if (--budget.left < 0) return null;
  const name = localName(element.name);
  if (name === "semantics") {
    const shown = element.children.find((child): child is XmlElement => typeof child !== "string");
    return shown ? rebuild(shown, budget) : null;
  }
  if (!MATH_ELEMENTS.has(name)) return null;
  const attributes = Object.entries(element.attrs)
    .filter(([key, value]) => allowedAttribute(localName(key), value))
    .map(([key, value]) => ` ${localName(key)}="${escapeAttribute(value)}"`)
    .join("");
  const inside = element.children
    .map((child: XmlNode) => (typeof child === "string" ? escapeText(child) : rebuild(child, budget) ?? ""))
    .join("");
  return `<${name}${name === "math" ? ` xmlns="${MATHML_NS}"` : ""}${attributes}>${inside}</${name}>`;
}

/**
 * An equation's MathML made safe: as it was when it is on the lists, rebuilt from the lists when it is not (`changed` is then true),
 * and empty when it was MathML but nothing of it is on them. MathML that cannot be read is left as it was (see the top of this file).
 */
export function cleanMathml(source: string): { mathml: string; changed: boolean } {
  if (typeof source !== "string" || source.trim() === "") return { mathml: source, changed: false };
  if (source.length > MAX_CHARS) return { mathml: "", changed: true };
  let root: XmlElement;
  try {
    root = parseXml(source.trim(), { maxChars: MAX_CHARS, maxNodes: MAX_ELEMENTS * 4 });
  } catch {
    return { mathml: source, changed: false };
  }
  if (isClean(source, root)) return { mathml: source, changed: false };
  if (localName(root.name) !== "math" || !declaresMathml(source.trim())) return { mathml: source, changed: false };
  const made = rebuild(root, { left: MAX_ELEMENTS }) ?? "";
  return { mathml: made, changed: true };
}

/** A question's list of equations with each one's MathML made safe, and how many were changed. The list is the same object when none was. */
export function cleanMathList<T extends { mathml: string }>(list: T[]): { list: T[]; changed: number } {
  let changed = 0;
  const out = list.map((entry) => {
    if (!entry || typeof entry.mathml !== "string") return entry;
    const cleaned = cleanMathml(entry.mathml);
    if (!cleaned.changed) return entry;
    changed++;
    return { ...entry, mathml: cleaned.mathml };
  });
  return { list: changed > 0 ? out : list, changed };
}
