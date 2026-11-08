// @ts-check
/**
 * The pane that shows what Check quality found in a bank: how many notes, of what kind, the questions that are the same more than
 * once, where the right answers sit, and what the check could not do in full. It is built here, apart from the bank screen, so that
 * a test can build it on a page of its own and read what it says: a test that read the screen's source for a heading did not notice a
 * panel that showed the check's code in place of its words.
 */

import { h, plural } from "./dom.js";

/** What each kind of note is about, in the words the screen uses. */
export const NOTE_NAMES = {
  "quality.all-or-none-of-the-above": "An option that depends on the others (all of the above, none of the above)",
  "quality.longest-option-correct": "The right answer is much the longest",
  "quality.negative-stem-not-emphasised": "NOT, EXCEPT or LEAST not set apart",
  "quality.grammatical-cue": "The grammar gives the answer away",
  "quality.duplicate-option": "Two options read the same",
  "a11y.alt-text-gives-answer": "A picture's description gives the answer",
  "a11y.colour-only-meaning": "A picture and a colour",
  "a11y.long-matching-list": "A long matching list",
};

/**
 * @param {any} result  what the check answered (`qualityView` in the server)
 * @param {{ questions: Array<{ id: string }> }} bank  the questions of the bank, in the order they are listed, for naming one by its place
 * @param {{ showNotes: () => void, select: (id: string) => void }} actions
 * @returns {{ panel: HTMLElement, heading: HTMLElement }}
 */
export function qualityPanel(result, bank, actions) {
  const kinds = Object.entries(result.notes).sort((a, b) => /** @type {number} */ (b[1]) - /** @type {number} */ (a[1]));
  const total = kinds.reduce((sum, [, n]) => sum + /** @type {number} */ (n), 0);
  const heading = h("h2", { text: "Quality notes", attrs: { tabindex: "-1" } });
  const panel = h("section", { class: "card quality" }, heading);
  panel.append(
    h("p", { class: "sub", text: `Checked ${plural(result.checked, "question", "questions")}. ${total === 0 ? "No question has a note." : `${plural(total, "note", "notes")} on ${plural(result.questions.length, "question", "questions")}.`}` }),
  );

  if (kinds.length > 0) {
    const list = h("ul", { class: "quality-kinds" });
    for (const [code, count] of kinds) list.append(h("li", { text: `${NOTE_NAMES[/** @type {keyof typeof NOTE_NAMES} */ (code)] ?? code}: ${count}` }));
    panel.append(list, h("div", { class: "card-actions" }, h("button", { type: "button", text: "Show the questions with notes", on: { click: () => actions.showNotes() } })));
  }

  if (result.duplicates.length > 0) {
    panel.append(h("h3", { text: "The same question more than once" }));
    for (const group of result.duplicates) {
      // Copies have the same title, so each is named by its place in the list, which is the number on its row.
      const links = group.questionIds.map(
        /** @param {string} id @param {number} i */ (id, i) => {
          const place = bank.questions.findIndex(/** @param {any} q */ (q) => q.id === id);
          return h("button", { type: "button", class: "small-button", text: `${place >= 0 ? `Question ${place + 1}: ` : ""}${group.titles[i] || "Untitled question"}`, on: { click: () => actions.select(id) } });
        },
      );
      panel.append(h("p", { text: group.message }), h("div", { class: "card-actions" }, ...links));
    }
  }

  if (result.keyBalance.length > 0) {
    panel.append(h("h3", { text: "Where the right answers sit" }), h("ul", { class: "quality-kinds" }, ...result.keyBalance.map(/** @param {any} note */ (note) => h("li", { text: note.message }))));
  }

  // The check's own words, as the engine wrote them. A reply from a server that is older than the screen has no `limits` at all.
  if (result.limits && result.limits.length > 0) {
    panel.append(h("h3", { text: "What this check could not do in full" }), h("ul", { class: "quality-kinds" }, ...result.limits.map(/** @param {any} note */ (note) => h("li", { text: note.message }))));
  }

  panel.append(h("p", { class: "hint", text: "These are notes, not faults. Open a question to see its notes and dismiss any you meant. Checking changed nothing else about the questions." }));
  return { panel, heading };
}
