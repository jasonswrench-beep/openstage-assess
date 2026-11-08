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
 *   accept?: string, multiple?: boolean, src?: string, scope?: string, autocomplete?: string, spellcheck?: boolean, readOnly?: boolean, tabIndex?: number,
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
 * A tick box with its words and, when there is one, a line of explanation under them. The words name the box and the explanation
 * describes it. A label that held both made the box's name a whole paragraph, which a screen reader reads out in full each time
 * the box takes focus, before it says what the box is for.
 * It does the same for a round button of a group, which is laid out as a "choice" and not a "check", and may have its words in bold.
 * @param {HTMLInputElement} box  with an id, which the label and the two parts are named from
 * @param {string} label
 * @param {string} [hint]
 * @param {{ wrapper?: "check" | "choice", bold?: boolean }} [look]
 */
export function checkRow(box, label, hint, look = {}) {
  const words = h(look.bold ? "b" : "span", { id: `${box.id}-words`, text: label });
  box.setAttribute("aria-labelledby", words.id);
  /** @type {any} */
  let note = null;
  if (hint) {
    note = h("span", { class: "hint", id: `${box.id}-hint`, text: hint });
    box.setAttribute("aria-describedby", note.id);
  }
  return h("div", { class: look.wrapper ?? "check" }, box, h("label", { for: box.id }, words, note));
}

/**
 * Makes the "Skip to the content" link move focus and nothing else. It was a plain `href="#main"`, and the address is the router's:
 * "#main" is no screen, so following the link showed "There is nothing here" in place of the page and, with a change open, asked
 * whether to save it (and Discard lost it). Found by reading the router against the link, and seen in the browser.
 * @param {HTMLElement} link
 * @param {HTMLElement} target  with tabindex -1, so that it can take focus
 */
export function skipTo(link, target) {
  link.addEventListener("click", (/** @type {Event} */ event) => {
    event.preventDefault();
    target.focus();
  });
}

/**
 * Where focus goes when a screen has been shown. After the first screen it goes to the main area, so that a person who moved to a new
 * screen starts at its top; after the very first it does not, because with focus already inside the page the first Tab went past the
 * skip link to the first button. Call it once for each thing shown, with the element to focus or null when there is none; the first
 * call, whichever it is, is the first screen.
 * @returns {(target: HTMLElement | null) => void}
 */
export function screenFocus() {
  let first = true;
  return (target) => {
    const wasFirst = first;
    first = false;
    if (!wasFirst && target) target.focus({ preventScroll: true });
  };
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
