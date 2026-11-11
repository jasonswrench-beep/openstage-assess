// @ts-check
/**
 * Every key OpenAssess has, in groups, for the Keyboard keys window (Help > Keyboard keys, Ctrl+/), and the window itself. The look
 * follows OpenStage Author's window of the same name (see NOTICE): a table for each group, each named by its heading.
 */

import { el } from "./menubar.js";

/** @typedef {{ keys: string, does: string }} KeyRow */
/** @typedef {{ id: string, title: string, rows: KeyRow[] }} KeyGroup */

/** @type {KeyGroup[]} */
export const KEY_GROUPS = [
  {
    id: "anywhere",
    title: "Anywhere",
    rows: [
      { keys: "Ctrl+K", does: "Search for a command by its name" },
      { keys: "Ctrl+/", does: "This list of keys" },
      { keys: "F10, or Alt pressed and let go on its own", does: "Go to the menus, and pressed again, back to where you were" },
      { keys: "Tab, Shift+Tab", does: "The next or the last control; the first Tab stop on a screen is the link that skips to its content" },
    ],
  },
  {
    id: "menus",
    title: "Menus, and the ... button beside a bank's name",
    rows: [
      { keys: "Down, Enter or Space", does: "Open the menu on its first item" },
      { keys: "Up", does: "Open the menu on its last item" },
      { keys: "Up, Down, Home, End", does: "Move in a menu" },
      { keys: "A letter", does: "The next item that starts with it" },
      { keys: "Left, Right", does: "In the menus under the navy bar: the menu beside it" },
      { keys: "Escape, Tab", does: "Close the menu and go back to where it was opened from" },
    ],
  },
  {
    id: "questions",
    title: "The list of questions",
    rows: [
      { keys: "Up, Down", does: "The question above or below" },
      { keys: "Enter or Space", does: "Open the question to read or change it" },
      { keys: "Ctrl+S", does: "Save the question being changed" },
    ],
  },
  {
    id: "review",
    title: "Checking scanned answer sheets",
    rows: [
      { keys: "A letter or a digit", does: "Record that bubble (with several right, tick it)" },
      { keys: "Enter", does: "Record the bubbles ticked, when several can be right" },
      { keys: "0", does: "The row is blank" },
      { keys: "Left, Right", does: "The question before or after" },
      { keys: "Z", does: "Take back the last one recorded" },
    ],
  },
  {
    id: "search",
    title: "Search for a command (Ctrl+K)",
    rows: [
      { keys: "Type", does: "Find the commands whose names have those words" },
      { keys: "Up, Down, Page Up, Page Down", does: "Move through what is found" },
      { keys: "Enter", does: "Do the command" },
      { keys: "Escape", does: "Close the search" },
    ],
  },
  {
    id: "dialogs",
    title: "Dialogs",
    rows: [
      { keys: "Tab, Shift+Tab", does: "Move through the dialog" },
      { keys: "Escape", does: "Close the dialog without changing anything" },
    ],
  },
];

/** Only one at a time. @type {HTMLDialogElement | null} */
let openNow = null;

/**
 * The Keyboard keys window. Focus goes back to where it was when it closes.
 * @param {Document} doc
 */
export function openKeys(doc) {
  if (openNow) {
    openNow.querySelector("button")?.focus();
    return;
  }
  const from = /** @type {HTMLElement | null} */ (doc.activeElement);
  /** @type {HTMLDialogElement} */
  const dialog = el(doc, "dialog", { class: "keys-dialog", "aria-labelledby": "ky-title", "aria-describedby": "ky-intro" });
  const close = el(doc, "button", { type: "button", class: "primary", text: "Close" });
  close.addEventListener("click", () => dialog.close());
  dialog.append(
    el(
      doc,
      "div",
      { class: "dialog-body" },
      el(doc, "h2", { id: "ky-title", text: "Keyboard keys" }),
      el(doc, "p", { id: "ky-intro", class: "hint", text: "Every key OpenAssess has. The menus show each command's keys beside it, and Ctrl+K finds a command by its name." }),
      ...KEY_GROUPS.map((g) =>
        el(
          doc,
          "section",
          { class: "keys-group", "aria-labelledby": `ky-${g.id}` },
          el(doc, "h3", { id: `ky-${g.id}`, text: g.title }),
          el(
            doc,
            "table",
            { class: "keys-table", "aria-labelledby": `ky-${g.id}` },
            el(doc, "thead", {}, el(doc, "tr", {}, el(doc, "th", { scope: "col", text: "Keys" }), el(doc, "th", { scope: "col", text: "What they do" }))),
            el(doc, "tbody", {}, ...g.rows.map((r) => el(doc, "tr", {}, el(doc, "th", { scope: "row", text: r.keys }), el(doc, "td", { text: r.does })))),
          ),
        ),
      ),
      el(doc, "div", { class: "dialog-actions" }, close),
    ),
  );
  dialog.addEventListener("close", () => {
    dialog.remove();
    openNow = null;
    if (from && from !== doc.body && from.isConnected && !from.closest("[hidden]")) from.focus();
  });
  doc.body.append(dialog);
  openNow = dialog;
  dialog.showModal();
  close.focus();
}
