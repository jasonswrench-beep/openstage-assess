// @ts-check
/**
 * Exporting a bank: choose where to, see exactly what will happen to each question, then write the file.
 *
 * What is shown before is what is written after: the check and the export are the same pass over the same questions on the
 * server. A question that cannot go is listed with the reason, and nothing is exported as something it is not.
 */

import { get, post } from "./api.js";
import { checkRow, clear, h, plural, put } from "./dom.js";
import { fileButtons } from "./files.js";
import { EXPORT_WORDS, reportNodes } from "./reportview.js";

/**
 * @param {HTMLElement} host
 * @param {{ name: string }} params
 * @param {{ notify: (message: string, kind?: "ok" | "error") => void, go: (hash: string) => void }} shell
 */
export async function renderExport(host, params, shell) {
  const base = `banks/${encodeURIComponent(params.name)}`;
  const [bank, destinations] = await Promise.all([get(base), get("destinations")]);
  /** @type {any[]} */
  const choices = destinations.destinations;
  let destination = choices[0].id;
  /** @type {Record<string, boolean>} */
  const statuses = { draft: true, reviewed: true, approved: true, retired: false };
  /** @type {any} */
  let report = null;
  let working = false;

  clear(host);
  const resultHost = h("div", { attrs: { "aria-live": "polite" } });
  const writtenHost = h("div", { attrs: { "aria-live": "polite" } });
  const exportButton = h("button", { type: "button", class: "primary", text: "Write the file", disabled: true, on: { click: () => void write() } });

  const wherePanel = h(
    "fieldset",
    { class: "panel" },
    h("legend", { text: "Where is it going?" }),
    ...choices.map((d, i) => {
      const id = `dest-${i}`;
      const radio = h("input", { type: "radio", name: "destination", id, checked: d.id === destination });
      radio.addEventListener("change", () => {
        destination = d.id;
        writtenHost && clear(writtenHost);
        void check();
      });
      return checkRow(radio, d.label, d.blurb, { wrapper: "choice", bold: true });
    }),
  );

  const byStatus = bank.stats.byStatus ?? {};
  const whichPanel = h(
    "fieldset",
    { class: "panel" },
    h("legend", { text: "Which questions?" }),
    ...[["draft", "Draft"], ["reviewed", "Reviewed"], ["approved", "Approved"], ["retired", "Retired"]].map(([key, label]) => {
      const id = `status-${key}`;
      const box = h("input", { type: "checkbox", id, checked: statuses[/** @type {string} */ (key)] });
      box.addEventListener("change", () => {
        statuses[/** @type {string} */ (key)] = box.checked;
        clear(writtenHost);
        void check();
      });
      return h("div", { class: "check" }, box, h("label", { for: id, text: `${label} (${byStatus[/** @type {string} */ (key)] ?? 0})` }));
    }),
  );

  host.append(
    h(
      "div",
      { class: "export" },
      h("div", { class: "page-head" }, h("div", null, h("h1", { text: `Export ${bank.title}` }), h("p", { class: "sub", text: "Choose where it is going. You see what will happen to every question before anything is written." })), h("div", { class: "head-actions" }, h("a", { class: "button", href: `#/bank/${encodeURIComponent(params.name)}`, text: "Back to the bank" }))),
      wherePanel,
      whichPanel,
      h("div", { class: "panel" }, h("h2", { text: "What will happen" }), resultHost),
      h("div", { class: "editor-actions" }, exportButton),
      writtenHost,
    ),
  );

  // -------------------------------------------------------------------------

  const selected = () => Object.keys(statuses).filter((s) => statuses[s]);

  async function check() {
    if (selected().length === 0) {
      report = null;
      clear(resultHost);
      resultHost.append(h("p", { class: "problem", text: "Choose at least one status, or there is nothing to export." }));
      exportButton.disabled = true;
      return;
    }
    clear(resultHost);
    resultHost.append(h("p", { class: "sub", text: "Checking…" }));
    exportButton.disabled = true;
    try {
      const mine = destination;
      const result = await post(`${base}/export/check`, { destination, statuses: selected() });
      if (mine !== destination) return;
      report = result.report;
      renderReport();
      exportButton.disabled = working || report.files.length === 0;
    } catch (error) {
      clear(resultHost);
      resultHost.append(h("p", { class: "problem", text: /** @type {Error} */ (error).message }));
    }
  }

  function renderReport() {
    clear(resultHost);
    if (!report) return;
    put(resultHost, ...reportNodes(report, EXPORT_WORDS));
  }

  async function write() {
    if (working) return;
    working = true;
    exportButton.disabled = true;
    try {
      const result = await post(`${base}/export`, { destination, statuses: selected() });
      clear(writtenHost);
      writtenHost.append(
        h(
          "div",
          { class: "written" },
          h("h2", { text: result.written.length === 1 ? "The file is written" : "The files are written" }),
          h("p", { class: "sub", text: "They are in the Exports folder inside your OpenAssess folder. Nothing already there was written over." }),
          ...result.written.map(/** @param {any} file */ (file) =>
            h(
              "div",
              { class: "file-row" },
              h("span", { class: "file-name", text: file.name }),
              h("span", { class: "meta", text: plural(file.questions, "question", "questions") }),
              ...fileButtons(file, shell),
            ),
          ),
        ),
      );
      shell.notify(`Wrote ${plural(result.written.length, "file", "files")}.`, "ok");
    } catch (error) {
      shell.notify(/** @type {Error} */ (error).message, "error");
    } finally {
      working = false;
      exportButton.disabled = !report || report.files.length === 0;
    }
  }

  await check();
  return {};
}
