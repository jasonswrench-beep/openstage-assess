// @ts-check
/**
 * The list of questions down the left of a screen, shared by the import review and the bank.
 */

import { badge, h, TYPE_NAMES } from "./dom.js";

/**
 * @typedef {{ index?: number, id: string, title: string, type: string, snippet: string, verdict: "parsed" | "needsReview" | "failed",
 *   status?: string, skipped?: boolean, errors?: number, warnings?: number, notes?: number }} Summary
 */

/**
 * One row. A row is a button, so that it can be reached and chosen with the keyboard.
 * @param {{ number: number, key: string | number, summary: Summary, selected: boolean, onSelect: () => void }} options  `key` names the row for `markSelected`
 */
export function questionRow(options) {
  const { summary } = options;
  const button = h(
    "button",
    {
      type: "button",
      class: `qrow v-${summary.verdict}${summary.skipped ? " skipped" : ""}`,
      attrs: { "aria-current": options.selected ? "true" : "false", "data-key": String(options.key) },
      on: { click: options.onSelect },
    },
    h("span", { class: "n", text: String(options.number) }),
    h(
      "span",
      { class: "qmain" },
      h("span", { class: "qtop" }, badge(summary.verdict), h("span", { class: "type", text: /** @type {any} */ (TYPE_NAMES)[summary.type] ?? summary.type }), summary.skipped ? h("span", { class: "tag", text: "Left out" }) : null, summary.status && summary.status !== "draft" ? h("span", { class: "tag", text: summary.status }) : null, summary.notes ? h("span", { class: "tag", text: summary.notes === 1 ? "1 note" : `${summary.notes} notes` }) : null),
      h("span", { class: "peek", text: summary.snippet || summary.title }),
    ),
  );
  return h("li", null, button);
}

/** How many rows a list draws before it asks for more. */
export const ROWS_AT_FIRST = 1000;

/**
 * Draws the rows of a list, the first `limit` of them and always as far as the chosen one, and then a line that says how many are not
 * drawn and offers the next thousand or all of them. Drawing is not what is slow: laying out the rows is. Measured in the built-in
 * browser, 5000 rows took about a second to appear and 20,000 took 8.6 seconds, every time the list was drawn again (a search, a filter),
 * with the window unresponsive. A person with that many questions narrows the list by what they search for, so the first thousand are
 * enough to start from, and nothing is hidden without saying so.
 * @template T
 * @param {HTMLElement} list
 * @param {T[]} items
 * @param {(item: T, at: number) => HTMLElement} row  makes the row of an item
 * @param {{ limit: number, chosenAt?: number, more: (limit: number, firstNew: number) => void }} options
 * @returns {number} how many rows were drawn
 */
export function fillRows(list, items, row, options) {
  const drawn = Math.min(items.length, Math.max(options.limit, (options.chosenAt ?? -1) + 1));
  for (let i = 0; i < drawn; i++) list.append(row(/** @type {T} */ (items[i]), i));
  if (drawn < items.length) {
    const left = items.length - drawn;
    const next = Math.min(items.length, drawn + ROWS_AT_FIRST);
    list.append(
      h(
        "li",
        { class: "more-rows" },
        h("p", { class: "hint", text: `Showing the first ${drawn.toLocaleString("en-US")} of ${items.length.toLocaleString("en-US")} questions. Search or narrow the list to find the others, or show more.` }),
        h("div", { class: "card-actions" },
          h("button", { type: "button", text: `Show ${Math.min(ROWS_AT_FIRST, left).toLocaleString("en-US")} more`, on: { click: () => options.more(next, drawn) } }),
          left > ROWS_AT_FIRST ? h("button", { type: "button", text: `Show all ${items.length.toLocaleString("en-US")} (slow)`, on: { click: () => options.more(items.length, drawn) } }) : null,
        ),
      ),
    );
  }
  return drawn;
}

/**
 * Shows which row is chosen, by changing the rows that are there. Choosing a question used to draw the whole list again, which for
 * 5000 questions (40,000 elements) took half a second to nearly a second, once for each question looked at, and left a keyboard user's
 * focus on a row that had been thrown away.
 * @param {HTMLElement} list
 * @param {string | number | null} key  the `key` of the chosen row, or null for none
 */
export function markSelected(list, key) {
  const want = key === null ? null : String(key);
  for (const row of /** @type {NodeListOf<HTMLElement>} */ (list.querySelectorAll("button.qrow"))) {
    const on = row.dataset["key"] === want;
    if ((row.getAttribute("aria-current") === "true") !== on) row.setAttribute("aria-current", String(on));
  }
}

/**
 * Moves the choice up and down a list with the arrow keys, when focus is on one of its rows.
 * @param {HTMLElement} list
 */
export function arrowKeys(list) {
  list.addEventListener("keydown", (/** @type {KeyboardEvent} */ e) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const rows = /** @type {HTMLElement[]} */ ([...list.querySelectorAll("button.qrow")]);
    const at = rows.indexOf(/** @type {HTMLElement} */ (document.activeElement));
    if (at === -1) return;
    e.preventDefault();
    rows[Math.max(0, Math.min(rows.length - 1, at + (e.key === "ArrowDown" ? 1 : -1)))]?.focus();
  });
}
