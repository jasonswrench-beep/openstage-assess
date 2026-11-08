// @ts-check
/**
 * One bank on the first screen, as a card. It is built here, apart from the screen, so that a test can build it on a page of its own: a
 * bank that cannot be read is listed with what is wrong and not hidden, and what can be done about it depends on why.
 */

import { h, plural, when } from "./dom.js";

/**
 * @param {any} b  an entry of the list the server gave (`BankInfo`)
 * @param {{ remove: (bank: any) => void }} actions
 * @returns {HTMLElement}
 */
export function bankCard(b, actions) {
  return h(
    "article",
    { class: "card" },
    // An h2, under the page's h1: a card title that was an h3 skipped a level, which a screen reader's list of headings shows.
    h("h2", { class: "card-title" }, b.error ? h("span", { text: b.name }) : h("a", { href: `#/bank/${encodeURIComponent(b.name)}`, text: b.title })),
    b.error
      ? h("p", { class: "problem", text: `This file could not be read: ${b.error}` })
      : h("p", { class: "sub", text: `${plural(b.questions, "question", "questions")} · changed ${when(b.modified)}` }),
    b.error
      ? // A file that is no bank can be put out of the way, into the Deleted folder, where nothing is erased. One whose name cannot be used has
        // no such button: the name is what the server would look it up by, and the file is renamed in the Banks folder first (the message says so).
        b.unusableName
        ? null
        : h(
            "div",
            { class: "card-actions" },
            h("button", { type: "button", class: "button danger", text: "Remove", attrs: { "aria-label": `Remove ${b.name}` }, on: { click: () => actions.remove(b) } }),
          )
      : h(
          "div",
          { class: "card-actions" },
          // Each says which bank it is for: a list of the page's links read out "Open, Export, Print" once for every bank.
          h("a", { class: "button", href: `#/bank/${encodeURIComponent(b.name)}`, text: "Open", attrs: { "aria-label": `Open ${b.title}` } }),
          h("a", { class: "button", href: `#/export/${encodeURIComponent(b.name)}`, text: "Export", attrs: { "aria-label": `Export ${b.title}` } }),
          h("a", { class: "button", href: `#/print/${encodeURIComponent(b.name)}`, text: "Print", attrs: { "aria-label": `Print ${b.title}` } }),
        ),
  );
}
