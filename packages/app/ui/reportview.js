// @ts-check
/**
 * A destination check as a page: how many questions go as they are, how many with something lost, how many cannot go, what is
 * true of all of them, and every note said once with the questions it applies to listed under it. Export and print use the
 * same, since both answer the same question before they write anything.
 */

import { h, plural } from "./dom.js";

/** How many questions are named under one note before the rest are only numbered. */
const MAX_LISTED = 8;

/**
 * @typedef {{ ok: string, lost: string, out: string, noFile: string, lostHeading: string, outHeading: string }} Words
 */

/** @type {Words} */
export const EXPORT_WORDS = {
  ok: "go as they are",
  lost: "go with something lost",
  out: "cannot go",
  noFile: "No question can be exported to this format, so no file would be written.",
  lostHeading: "Goes with something lost",
  outHeading: "Cannot go",
};

/** @type {Words} */
export const PRINT_WORDS = {
  ok: "print as written",
  lost: "print with a note",
  out: "cannot be printed",
  noFile: "No question can be printed, so no file would be written.",
  lostHeading: "Prints with a note",
  outHeading: "Cannot be printed",
};

/**
 * @param {any} report
 * @param {string} outcome
 * @param {string} heading
 * @param {boolean} open
 */
function section(report, outcome, heading, open) {
  /** @type {any[]} */
  const items = report.items.filter(/** @param {any} item */ (item) => item.outcome === outcome);
  if (items.length === 0) return null;
  /** @type {Map<string, any[]>} */
  const groups = new Map();
  for (const item of items) for (const note of item.notes) groups.set(note, [...(groups.get(note) ?? []), item]);
  return h(
    "details",
    { class: "more", open },
    h("summary", { text: `${heading} (${items.length})` }),
    ...[...groups].map(([note, members]) =>
      h(
        "div",
        { class: "note-group" },
        h("p", { text: note }),
        h(
          "ul",
          null,
          ...members.slice(0, MAX_LISTED).map((m) => h("li", { text: `#${m.position} ${m.title.length > 60 ? `${m.title.slice(0, 57)}...` : m.title}` })),
          members.length > MAX_LISTED ? h("li", { text: `and ${members.length - MAX_LISTED} more: ${members.slice(MAX_LISTED).map((m) => `#${m.position}`).join(", ")}` }) : null,
        ),
      ),
    ),
  );
}

/**
 * @param {any} report
 * @param {Words} words
 * @returns {Array<Node | null>}
 */
export function reportNodes(report, words) {
  if (report.total === 0) return [h("p", { class: "problem", text: "No question matches those statuses, so there is nothing to do." })];
  return [
    h(
      "ul",
      { class: "counts" },
      h("li", null, h("b", { text: String(report.exported) }), h("span", { text: words.ok })),
      h("li", null, h("b", { text: String(report.exportedWithLosses) }), h("span", { text: words.lost })),
      h("li", null, h("b", { text: String(report.leftOut) }), h("span", { text: words.out })),
    ),
    report.files.length === 0
      ? h("p", { class: "problem", text: words.noFile })
      : h("p", { class: "sub", text: `This writes ${plural(report.files.length, "file", "files")}: ${report.files.join(", ")}.` }),
    report.general.length > 0 ? h("ul", { class: "general" }, ...report.general.map(/** @param {string} g */ (g) => h("li", { text: g }))) : null,
    section(report, "leftOut", words.outHeading, true),
    section(report, "exportedWithLosses", words.lostHeading, report.leftOut === 0),
  ];
}
