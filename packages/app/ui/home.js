// @ts-check
/**
 * The first screen: the banks a person has, and the way in for a file.
 */

import { api, get, post } from "./api.js";
import { askText } from "./dialogs.js";
import { clear, h, plural, when } from "./dom.js";

/**
 * @param {HTMLElement} host
 * @param {unknown} _params
 * @param {{ notify: (message: string, kind?: "ok" | "error") => void, go: (hash: string) => void }} shell
 */
export async function renderHome(host, _params, shell) {
  const [state, offered] = await Promise.all([get("state"), get("samples")]);
  clear(host);

  /** @param {string} id */
  async function trySample(id) {
    try {
      const session = await post(`samples/${encodeURIComponent(id)}/import`);
      shell.notify(`Found ${plural(session.counts.total, "question", "questions")} in the sample.`, "ok");
      shell.go(`#/import/${encodeURIComponent(session.id)}`);
    } catch (error) {
      shell.notify(/** @type {Error} */ (error).message, "error");
    }
  }

  /** @param {File | undefined} file */
  async function bringIn(file) {
    if (!file) return;
    shell.notify(`Reading ${file.name}…`, "ok");
    try {
      const session = await api("POST", `import?name=${encodeURIComponent(file.name)}`, file);
      shell.notify(`Found ${plural(session.counts.total, "question", "questions")} in ${file.name}.`, "ok");
      shell.go(`#/import/${encodeURIComponent(session.id)}`);
    } catch (error) {
      shell.notify(/** @type {Error} */ (error).message, "error");
    }
  }

  /** @param {File | undefined} file */
  async function openBankFile(file) {
    if (!file) return;
    try {
      const adopted = await api("POST", `banks/open?name=${encodeURIComponent(file.name)}`, file);
      shell.notify(`Opened as "${adopted.name}".`, "ok");
      shell.go(`#/bank/${encodeURIComponent(adopted.name)}`);
    } catch (error) {
      shell.notify(/** @type {Error} */ (error).message, "error");
    }
  }

  const fileInput = h("input", { type: "file", id: "import-file", accept: ".docx,.xlsx,.xlsm,.csv,.tsv,.txt,.text,.aiken,.gift,.xml,.zip,.doc,.xls,.pdf", class: "visually-hidden", on: { change: (/** @type {Event} */ e) => void bringIn(/** @type {HTMLInputElement} */ (e.target).files?.[0]) } });
  const bankInput = h("input", { type: "file", id: "bank-file", accept: ".openassess", class: "visually-hidden", on: { change: (/** @type {Event} */ e) => void openBankFile(/** @type {HTMLInputElement} */ (e.target).files?.[0]) } });

  const zone = h(
    "div",
    { class: "dropzone" },
    h("h2", { text: "Bring in questions from a file" }),
    h("p", { text: "Drop a Word, Excel, CSV, PDF, text, Aiken, GIFT, Moodle XML or QTI file here, or choose one. Your file is read and never changed. You see what was found, fix anything that needs it, and then save it into a bank." }),
    h("label", { class: "button primary", for: "import-file", text: "Choose a file" }),
    h("p", { class: "hint", text: "An older Word (.doc) or Excel (.xls) file has to be saved in the newer form first. A PDF is read from its text alone, so check its answers; a scan, which is a picture of a page, cannot be read." }),
  );

  const samples = /** @type {any[]} */ (offered.samples);
  const sampleCards = samples.map((s) =>
    h(
      "article",
      { class: "card" },
      h("h3", { text: s.title }),
      h("p", { class: "sub", text: s.description }),
      h(
        "div",
        { class: "card-actions" },
        s.template ? null : h("button", { type: "button", class: "primary", text: "Try it", on: { click: () => void trySample(s.id) } }),
        // A link to the sample's own file, so that the window asks where to put the copy like it does for an export.
        h("a", { class: "button", href: `/files/samples/${encodeURIComponent(s.id)}`, text: s.template ? "Save a copy to fill in…" : "Save a copy…", attrs: { download: "" } }),
      ),
    ),
  );
  zone.addEventListener("dragover", (e) => {
    e.preventDefault();
    zone.classList.add("over");
  });
  zone.addEventListener("dragleave", () => zone.classList.remove("over"));
  zone.addEventListener("drop", (/** @type {DragEvent} */ e) => {
    e.preventDefault();
    zone.classList.remove("over");
    void bringIn(e.dataTransfer?.files?.[0]);
  });

  const banks = /** @type {any[]} */ (state.banks);
  const cards = banks.map((b) =>
    h(
      "article",
      { class: "card" },
      // An h2, under the page's h1: a card title that was an h3 skipped a level, which a screen reader's list of headings shows.
      h("h2", { class: "card-title" }, b.error ? h("span", { text: b.name }) : h("a", { href: `#/bank/${encodeURIComponent(b.name)}`, text: b.title })),
      b.error
        ? h("p", { class: "problem", text: `This file could not be read: ${b.error}` })
        : h("p", { class: "sub", text: `${plural(b.questions, "question", "questions")} · changed ${when(b.modified)}` }),
      b.error
        ? null
        : h(
            "div",
            { class: "card-actions" },
            h("a", { class: "button", href: `#/bank/${encodeURIComponent(b.name)}`, text: "Open" }),
            h("a", { class: "button", href: `#/export/${encodeURIComponent(b.name)}`, text: "Export" }),
            h("a", { class: "button", href: `#/print/${encodeURIComponent(b.name)}`, text: "Print" }),
          ),
    ),
  );

  host.append(
    h("div", { class: "page-head" }, h("div", null, h("h1", { text: "Your question banks" }), h("p", { class: "sub", text: "A bank is a file of questions you can search, change, print and export." })), h("div", { class: "head-actions" },
      h("button", { type: "button", class: "primary", text: "New bank", on: { click: async () => {
        const title = await askText("New bank", "What is it called?", "", "Create");
        if (!title) return;
        try {
          const made = await post("banks", { title });
          shell.go(`#/bank/${encodeURIComponent(made.name)}`);
        } catch (error) {
          shell.notify(/** @type {Error} */ (error).message, "error");
        }
      } } }),
      h("label", { class: "button", for: "bank-file", text: "Open a bank file…" }),
    )),
    fileInput,
    bankInput,
    banks.length === 0 ? h("p", { class: "placeholder", text: "You have no banks yet. Make one, or bring in a file." }) : h("div", { class: "cards" }, ...cards),
    zone,
    h("section", { class: "samples", attrs: { "aria-labelledby": "samples-heading" } }, h("h2", { id: "samples-heading", text: "No file to try? Use a sample" }), h("p", { class: "sub", text: "These are made up, about the planets. Trying one shows you what a bring-in looks like, and nothing is kept unless you save it into a bank." }), h("div", { class: "cards" }, ...sampleCards)),
    h(
      "p",
      { class: "library" },
      h("span", { text: "Your banks and exports are kept in " }),
      h("code", { text: state.home }),
      h("button", { type: "button", class: "link", text: "Show this folder", on: { click: async () => {
        try {
          await post("reveal", { path: state.home });
        } catch (error) {
          shell.notify(/** @type {Error} */ (error).message, "error");
        }
      } } }),
    ),
  );
  return {};
}
