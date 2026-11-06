// @ts-check
/**
 * Drawing an equation. The engine writes the MathML of an equation itself, from the equation Word held, out of a short list of
 * elements; this draws it by building each element from that list, one at a time, with text set as text. Nothing in the string
 * becomes part of the page except what is on the lists below, so a bank that was edited by hand, or damaged, cannot put a script or
 * a link on the screen by way of an equation. An equation that holds anything else is not drawn, and its LaTeX is shown in words.
 */

const NS = "http://www.w3.org/1998/Math/MathML";

/** The elements the engine writes, and the attributes each may keep, with the values those may have. */
const ELEMENTS = new Set([
  "math", "mrow", "mi", "mn", "mo", "mtext", "mfrac", "msqrt", "mroot", "msub", "msup", "msubsup", "munder", "mover", "munderover",
  "mmultiscripts", "mprescripts", "none", "mtable", "mtr", "mtd", "menclose", "mphantom",
]);

/** @type {Record<string, (value: string) => boolean>} */
const ATTRIBUTES = {
  mathvariant: (v) => ["normal", "bold", "bold-italic", "script", "fraktur", "double-struck", "sans-serif", "monospace"].includes(v),
  largeop: (v) => v === "true",
  fence: (v) => v === "true",
  separator: (v) => v === "true",
  accent: (v) => v === "true",
  linethickness: (v) => v === "0",
  notation: (v) => v === "box",
};

/** More elements than any equation has: a string with more is not drawn. */
const MAX_ELEMENTS = 5000;

/**
 * The equation as nodes to put on the page, or null when it cannot be drawn safely.
 * @param {string} mathml
 * @returns {Element | null}
 */
export function drawMath(mathml) {
  if (typeof mathml !== "string" || mathml === "" || mathml.length > 500_000) return null;
  let parsed;
  try {
    parsed = new DOMParser().parseFromString(mathml, "application/xml");
  } catch {
    return null;
  }
  const root = parsed.documentElement;
  if (!root || root.localName !== "math" || parsed.getElementsByTagName("parsererror").length > 0) return null;
  let count = 0;

  /**
   * @param {Element} from
   * @returns {Element | null}
   */
  function copy(from) {
    if (++count > MAX_ELEMENTS) return null;
    if (from.namespaceURI !== NS || !ELEMENTS.has(from.localName)) return null;
    const made = document.createElementNS(NS, from.localName);
    for (const attribute of Array.from(from.attributes)) {
      if (attribute.name === "xmlns") continue;
      const allowed = ATTRIBUTES[attribute.name];
      if (!allowed || !allowed(attribute.value)) return null;
      made.setAttribute(attribute.name, attribute.value);
    }
    for (const child of Array.from(from.childNodes)) {
      if (child.nodeType === 3) {
        made.appendChild(document.createTextNode(child.nodeValue ?? ""));
      } else if (child.nodeType === 1) {
        const inner = copy(/** @type {Element} */ (child));
        if (!inner) return null;
        made.appendChild(inner);
      } else if (child.nodeType !== 8) {
        return null;
      }
    }
    return made;
  }

  return copy(root);
}
