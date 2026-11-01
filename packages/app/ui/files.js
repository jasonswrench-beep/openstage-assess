// @ts-check
/**
 * The buttons beside a file the app has just written: Save a copy, which asks where to put it, and Show in folder.
 *
 * What was here before was a link with the download attribute. In the window it saved the file into the Downloads folder at
 * once, with no dialog and no word that anything had happened, so it looked as if the button did nothing, and a person pressed
 * it again (three copies in one recording). The file is already in the Exports folder, so what a copy adds is a place the
 * person chooses, and the way to offer one is the system's own Save dialog. A page that cannot open one (Firefox and Safari
 * have no such dialog for a web page) falls back to an ordinary download, and says that it did.
 */

import { post } from "./api.js";
import { h } from "./dom.js";

/** The types the Save dialog is told about, so that it offers the right extension. Anything else is saved without a type. */
const KINDS = /** @type {Record<string, [string, string]>} */ ({
  csv: ["text/csv", "CSV file"],
  docx: ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", "Word file"],
  pdf: ["application/pdf", "PDF"],
  xml: ["application/xml", "XML file"],
  gift: ["text/plain", "GIFT file"],
  txt: ["text/plain", "Text file"],
});

/** @typedef {{ notify: (message: string, kind?: "ok" | "error") => void }} Shell */

/**
 * @param {{ name: string }} file
 * @param {Shell} shell
 */
async function saveCopy(file, shell) {
  const url = `/files/${encodeURIComponent(file.name)}`;
  const picker = /** @type {any} */ (window).showSaveFilePicker;
  if (typeof picker !== "function") {
    const link = h("a", { href: url, attrs: { download: file.name } });
    document.body.append(link);
    link.click();
    link.remove();
    shell.notify("Your browser is saving it, usually into the Downloads folder.", "ok");
    return;
  }

  const kind = KINDS[file.name.split(".").pop()?.toLowerCase() ?? ""];
  /** @type {any} */
  let handle;
  try {
    handle = await picker.call(window, {
      suggestedName: file.name,
      ...(kind ? { types: [{ description: kind[1], accept: { [kind[0]]: [`.${file.name.split(".").pop()?.toLowerCase()}`] } }] } : {}),
    });
  } catch (error) {
    // Closing the dialog is a choice, not a failure.
    if (error && /** @type {any} */ (error).name === "AbortError") return;
    throw error;
  }

  const reply = await fetch(url);
  if (!reply.ok) throw new Error("That file is no longer in the Exports folder.");
  const out = await handle.createWritable();
  try {
    await out.write(await reply.blob());
    await out.close();
  } catch (error) {
    await out.abort().catch(() => undefined);
    throw error;
  }
  shell.notify(`Saved ${handle.name}.`, "ok");
}

/**
 * @param {{ name: string, path: string }} file
 * @param {Shell} shell
 * @returns {HTMLElement[]}
 */
export function fileButtons(file, shell) {
  const tell = (/** @type {unknown} */ error) => shell.notify(error instanceof Error ? error.message : "That did not work.", "error");
  return [
    h("button", { type: "button", class: "button", text: "Save a copy…", on: { click: () => void saveCopy(file, shell).catch(tell) } }),
    h("button", { type: "button", text: "Show in folder", on: { click: () => void post("reveal", { path: file.path }).catch(tell) } }),
  ];
}
