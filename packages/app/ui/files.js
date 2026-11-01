// @ts-check
/**
 * The buttons beside a file the app has just written: Save a copy, which asks where to put it, and Show in folder.
 *
 * The first version of this was a link with the download attribute, and in the window it saved the file into the Downloads
 * folder at once, with no dialog and no word that anything had happened, so it looked as if the button did nothing, and a person
 * pressed it again (three copies in one recording). The second asked the page's own save dialog, `showSaveFilePicker`, which
 * the window offers and then never opens: the call is made and never answers. So this is the plain link again, and the window's
 * shell (`shell/src-tauri/src/main.rs`) shows the system's Save dialog when it starts a download. In a browser the link does what
 * the browser does with any download, which is its own business.
 */

import { post } from "./api.js";
import { h } from "./dom.js";

/**
 * @param {{ name: string, path: string }} file
 * @param {{ notify: (message: string, kind?: "ok" | "error") => void }} shell
 * @returns {HTMLElement[]}
 */
export function fileButtons(file, shell) {
  const tell = (/** @type {unknown} */ error) => shell.notify(error instanceof Error ? error.message : "That did not work.", "error");
  return [
    h("a", { class: "button", href: `/files/${encodeURIComponent(file.name)}`, text: "Save a copy…", attrs: { download: file.name } }),
    h("button", { type: "button", text: "Show in folder", on: { click: () => void post("reveal", { path: file.path }).catch(tell) } }),
  ];
}
