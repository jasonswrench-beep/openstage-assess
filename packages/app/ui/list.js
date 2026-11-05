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
 * @param {{ number: number, summary: Summary, selected: boolean, onSelect: () => void }} options
 */
export function questionRow(options) {
  const { summary } = options;
  const button = h(
    "button",
    {
      type: "button",
      class: `qrow v-${summary.verdict}${summary.skipped ? " skipped" : ""}`,
      attrs: { "aria-current": options.selected ? "true" : "false" },
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
