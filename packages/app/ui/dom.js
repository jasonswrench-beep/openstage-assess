// @ts-check
/**
 * Building the page. Text is always set as text, never as markup, so nothing a document says can become part of the page.
 */

/**
 * @typedef {{
 *   class?: string, id?: string, text?: string, title?: string, type?: string, value?: string | number,
 *   checked?: boolean, disabled?: boolean, hidden?: boolean, href?: string, name?: string, rows?: number,
 *   placeholder?: string, for?: string, role?: string, min?: number | string, max?: number | string, step?: number | string,
 *   on?: Record<string, (event: any) => void>, attrs?: Record<string, string>, open?: boolean, selected?: boolean,
 *   accept?: string, multiple?: boolean, autocomplete?: string, spellcheck?: boolean, readOnly?: boolean, tabIndex?: number,
 * }} Props
 */

/**
 * @param {string} tag
 * @param {Props | null} [props]
 * @param {...(Node | string | null | undefined | false)} children
 * @returns {any}
 */
export function h(tag, props, ...children) {
  const node = /** @type {any} */ (document.createElement(tag));
  if (props) {
    for (const [key, value] of Object.entries(props)) {
      if (value === undefined || value === null) continue;
      if (key === "class") node.className = value;
      else if (key === "text") node.textContent = value;
      else if (key === "on") for (const [type, handler] of Object.entries(value)) node.addEventListener(type, handler);
      else if (key === "attrs") for (const [name, v] of Object.entries(value)) node.setAttribute(name, v);
      else if (key === "for") node.htmlFor = value;
      else if (key === "readOnly") node.readOnly = value;
      else if (key === "tabIndex") node.tabIndex = value;
      else node[key] = value;
    }
  }
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    node.append(typeof child === "string" ? document.createTextNode(child) : child);
  }
  return node;
}

/**
 * Adds children to a node, leaving out the ones that are not there. The browser's own `append` would turn a missing child
 * into the word "null".
 * @param {Node} parent
 * @param {...(Node | string | null | undefined | false)} children
 */
export function put(parent, ...children) {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    parent.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
  }
  return parent;
}

/** @param {Node} node */
export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

/**
 * @param {string} iso
 * @returns {string}
 */
export function when(iso) {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

/**
 * @param {number} n
 * @param {string} one
 * @param {string} many
 */
export function plural(n, one, many) {
  return `${n} ${n === 1 ? one : many}`;
}

/** Plain names for the kinds of question, as they are shown to a person. */
export const TYPE_NAMES = {
  multipleChoice: "Multiple choice",
  multipleResponse: "Multiple response",
  trueFalse: "True or false",
  fillInBlank: "Fill in the blank",
  shortAnswer: "Short answer",
  matching: "Matching",
  ordering: "Ordering",
  numeric: "Numeric",
  essay: "Essay",
  hotspot: "Hotspot",
  calculated: "Calculated",
};

export const EDITABLE_TYPES = ["multipleChoice", "multipleResponse", "trueFalse", "fillInBlank", "shortAnswer", "matching", "ordering", "numeric", "essay"];

export const VERDICT_NAMES = { parsed: "Parsed", needsReview: "Needs review", failed: "Failed" };
export const SEVERITY_NAMES = { error: "Error", warn: "Check", info: "Note" };

/**
 * A badge for a verdict, with the word as well as the colour.
 * @param {"parsed" | "needsReview" | "failed"} verdict
 */
export function badge(verdict) {
  return h("span", { class: `badge b-${verdict}`, text: VERDICT_NAMES[verdict] });
}

/**
 * Makes a textarea as tall as its text.
 * @param {HTMLTextAreaElement} area
 */
export function grow(area) {
  area.style.height = "auto";
  area.style.height = `${Math.min(area.scrollHeight + 2, 480)}px`;
}
