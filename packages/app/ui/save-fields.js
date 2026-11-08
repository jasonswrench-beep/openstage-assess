// @ts-check
/**
 * The two pieces of the import review's Save that need care to say what they are: the fields of the "Save into a bank" dialog, and
 * what is said when some of the questions could not be saved. They are built here, away from the screen, so that they can be looked at
 * with the stand-in page the tests use.
 */

import { h, plural } from "./dom.js";

/**
 * The fields of the "Save into a bank" dialog. Each text box and the list of banks sits beside a round button or a tick box with its
 * words, and is named by those words: the words belong to the control beside it, and the box next to them had no name at all, which
 * is what a screen reader heard in the dialog every import ends in ("edit text", "combo box", with nothing to say what for).
 * @param {{ file: string, banks: Array<{ name: string, title: string, questions: number }> }} options
 */
export function saveFields({ file, banks }) {
  const stem = file.replace(/\.[^.]+$/, "");
  const modeNew = h("input", { type: "radio", name: "save-mode", id: "mode-new", checked: true });
  const modeOld = h("input", { type: "radio", name: "save-mode", id: "mode-old", disabled: banks.length === 0 });
  const folderOn = h("input", { type: "checkbox", id: "save-in-folder" });
  // Each box is named with the same words as the label beside it (one place for each, so they cannot drift apart). aria-labelledby
  // would say the same to a browser, but the listing of the page that was used to look at this dialog did not follow it for a text
  // box and showed the box's contents in its place, so a plain aria-label, which this project uses wherever a control needs a name
  // the page does not give it, is what every reader of the page is sure to follow.
  const NEW = "A new bank, called";
  const OLD = "Add to a bank you already have";
  const FOLDER = "Put the questions in a folder called";
  const newWords = h("label", { for: "mode-new", id: "mode-new-words", text: NEW });
  const oldWords = h("label", { for: "mode-old", id: "mode-old-words", text: OLD });
  const folderWords = h("label", { for: "save-in-folder", id: "save-in-folder-words", text: FOLDER });
  const titleInput = h("input", { type: "text", id: "save-title", value: stem, autocomplete: "off", attrs: { "aria-label": NEW } });
  const bankSelect = h(
    "select",
    { id: "save-bank", disabled: banks.length === 0, attrs: { "aria-label": OLD } },
    ...banks.map((b) => h("option", { value: b.name, text: `${b.title} (${plural(b.questions, "question", "questions")})` })),
  );
  // Optional: the questions go into a folder of this name (the file's name to begin with), made if the bank has none, so that a
  // chapter brought in is one folder and not a hundred questions among the others.
  const folderInput = h("input", { type: "text", id: "save-folder", value: stem, autocomplete: "off", attrs: { maxlength: "80", "aria-label": FOLDER } });
  const body = [
    h("div", { class: "check" }, modeNew, newWords),
    titleInput,
    h("div", { class: "check" }, modeOld, oldWords),
    bankSelect,
    h("div", { class: "check" }, folderOn, folderWords),
    folderInput,
  ];
  return { body, modeNew, modeOld, folderOn, titleInput, bankSelect, folderInput };
}

/**
 * What the person is told when a save put some of the questions into the bank and could not put others. A green line that fades in
 * six seconds, with the screen already moving on, was all they were told, and it left out which questions, so the ones that were not
 * saved were found, if at all, by counting.
 * @param {{ bank: string, added: number, notSaved: Array<{ index: number, title: string, reason: string }> }} result
 * @returns {Array<Node | string>}
 */
export function notSavedBody(result) {
  const failed = result.notSaved;
  return [
    `${plural(result.added, "question was", "questions were")} saved into "${result.bank}". ${plural(failed.length, "question was", "questions were")} not:`,
    h("ul", null, ...failed.map((n) => h("li", { text: `${n.title.trim() === "" ? `Question ${n.index + 1}` : n.title}: ${n.reason}` }))),
  ];
}
