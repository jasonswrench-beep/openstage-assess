// @ts-check
/**
 * Printing a bank as a test: a student copy and an answer key, as Word or PDF files.
 *
 * What is shown before is what is written after. The student copy shows no answer, and the key shows only what the bank
 * records, and says so for a question that has none. A question that cannot be printed is listed with the reason.
 */

import { get, post } from "./api.js";
import { checkRow, clear, h, plural, put } from "./dom.js";
import { fileButtons } from "./files.js";
import { PRINT_WORDS, reportNodes } from "./reportview.js";

/**
 * @param {HTMLElement} host
 * @param {{ name: string }} params
 * @param {{ notify: (message: string, kind?: "ok" | "error") => void, go: (hash: string) => void }} shell
 */
export async function renderPrint(host, params, shell) {
  const base = `banks/${encodeURIComponent(params.name)}`;
  const bank = await get(base);
  const byStatus = bank.stats.byStatus ?? {};

  const settings = {
    kinds: { student: true, key: true },
    formats: { docx: true, pdf: false },
    statuses: { draft: true, reviewed: true, approved: true, retired: false },
    title: bank.title,
    paper: "letter",
    instructions: "",
    nameLine: true,
    dateLine: true,
    showPoints: true,
    shortAnswerLines: 1,
    essayLines: 8,
    includeFeedback: false,
    fontSize: 11,
  };
  /** @type {any} */
  let reports = null;
  let working = false;
  let timer = 0;

  clear(host);
  const resultHost = h("div", { attrs: { "aria-live": "polite" } });
  const writtenHost = h("div", { attrs: { "aria-live": "polite" } });
  const writeButton = h("button", { type: "button", class: "primary", text: "Make the files", disabled: true, on: { click: () => void write() } });

  /**
   * @param {string} label
   * @param {boolean} checked
   * @param {(value: boolean) => void} set
   * @param {string} [hint]
   */
  const tick = (label, checked, set, hint) => {
    const id = `p-${label.replace(/\W/g, "")}`;
    const box = h("input", { type: "checkbox", id, checked });
    box.addEventListener("change", () => {
      set(box.checked);
      changed();
    });
    return checkRow(box, label, hint);
  };
  /**
   * @param {string} label
   * @param {string | number} value
   * @param {(value: string) => void} set
   * @param {{ type?: string, min?: number, max?: number, small?: boolean }} [more]
   */
  const field = (label, value, set, more = {}) => {
    const id = `p-${label.replace(/\W/g, "")}`;
    const input = h("input", { id, type: more.type ?? "text", value, min: more.min, max: more.max, autocomplete: "off", spellcheck: more.type === undefined });
    input.addEventListener("input", () => {
      set(input.value);
      changed();
    });
    return h("div", { class: more.small ? "field small" : "field" }, h("label", { for: id, class: "field-label", text: label }), input);
  };

  const whatPanel = h(
    "fieldset",
    { class: "panel" },
    h("legend", { text: "What to print" }),
    tick("A student copy", settings.kinds.student, (v) => (settings.kinds.student = v), "Questions only. No answer is shown anywhere."),
    tick("An answer key", settings.kinds.key, (v) => (settings.kinds.key = v), "The same questions with the right answers marked, and a note on any question that has none."),
    h("div", { class: "grid" },
      h("div", { class: "field" }, h("span", { class: "field-label", text: "As" }), tick("A Word file", settings.formats.docx, (v) => (settings.formats.docx = v), "Can be edited. Reads best with a screen reader."), tick("A PDF", settings.formats.pdf, (v) => (settings.formats.pdf = v), "Looks the same everywhere. Western European characters only.")),
    ),
  );

  const paper = h("select", { id: "p-paper" }, h("option", { value: "letter", text: "Letter (US)", selected: true }), h("option", { value: "a4", text: "A4" }));
  paper.addEventListener("change", () => {
    settings.paper = paper.value;
    changed();
  });
  const instructions = h("textarea", { id: "p-instructions", rows: 3, placeholder: "For example: Answer every question. Use a pen." });
  instructions.addEventListener("input", () => {
    settings.instructions = instructions.value;
    changed();
  });

  const pagePanel = h(
    "fieldset",
    { class: "panel" },
    h("legend", { text: "The page" }),
    field("Title", settings.title, (v) => (settings.title = v)),
    h("div", { class: "field" }, h("label", { for: "p-instructions", class: "field-label", text: "Instructions (optional)" }), instructions),
    h("div", { class: "grid" },
      h("div", { class: "field small" }, h("label", { for: "p-paper", class: "field-label", text: "Paper" }), paper),
      field("Size of the text", settings.fontSize, (v) => (settings.fontSize = Number(v) || 11), { type: "number", min: 9, max: 14, small: true }),
      field("Lines for a short answer", settings.shortAnswerLines, (v) => (settings.shortAnswerLines = Number(v) || 0), { type: "number", min: 0, max: 10, small: true }),
      field("Lines for an essay", settings.essayLines, (v) => (settings.essayLines = Number(v) || 0), { type: "number", min: 0, max: 40, small: true }),
    ),
    tick("A line for the student's name", settings.nameLine, (v) => (settings.nameLine = v)),
    tick("A line for the date", settings.dateLine, (v) => (settings.dateLine = v)),
    tick("The points of each question", settings.showPoints, (v) => (settings.showPoints = v)),
    tick("Feedback, on the answer key", settings.includeFeedback, (v) => (settings.includeFeedback = v), "Written under each answer on the key. Never on the student copy."),
  );

  const whichPanel = h(
    "fieldset",
    { class: "panel" },
    h("legend", { text: "Which questions?" }),
    ...[["draft", "Draft"], ["reviewed", "Reviewed"], ["approved", "Approved"], ["retired", "Retired"]].map(([key, label]) =>
      tick(`${label} (${byStatus[/** @type {string} */ (key)] ?? 0})`, /** @type {Record<string, boolean>} */ (settings.statuses)[/** @type {string} */ (key)] ?? false, (v) => (/** @type {Record<string, boolean>} */ (settings.statuses)[/** @type {string} */ (key)] = v)),
    ),
  );

  host.append(
    h(
      "div",
      { class: "export" },
      h("div", { class: "page-head" }, h("div", null, h("h1", { text: `Print ${bank.title}` }), h("p", { class: "sub", text: "A student copy and an answer key, made from the same questions in the same order. You see what each will hold before anything is written." })), h("div", { class: "head-actions" }, h("a", { class: "button", href: `#/bank/${encodeURIComponent(params.name)}`, text: "Back to the bank" }))),
      whatPanel,
      pagePanel,
      whichPanel,
      h("div", { class: "panel" }, h("h2", { text: "What will happen" }), resultHost),
      h("div", { class: "editor-actions" }, writeButton),
      writtenHost,
    ),
  );

  // -------------------------------------------------------------------------

  const request = () => ({
    kinds: Object.entries(settings.kinds).filter(([, on]) => on).map(([k]) => k),
    formats: Object.entries(settings.formats).filter(([, on]) => on).map(([k]) => k),
    statuses: Object.entries(settings.statuses).filter(([, on]) => on).map(([k]) => k),
    title: settings.title.trim() === "" ? undefined : settings.title.trim(),
    paper: settings.paper,
    instructions: settings.instructions,
    nameLine: settings.nameLine,
    dateLine: settings.dateLine,
    showPoints: settings.showPoints,
    shortAnswerLines: settings.shortAnswerLines,
    essayLines: settings.essayLines,
    includeFeedback: settings.includeFeedback,
    fontSize: settings.fontSize,
  });

  function changed() {
    clear(writtenHost);
    clearTimeout(timer);
    timer = window.setTimeout(() => void check(), 300);
  }

  async function check() {
    const asked = request();
    if (asked.kinds.length === 0 || asked.formats.length === 0 || asked.statuses.length === 0) {
      reports = null;
      clear(resultHost);
      put(resultHost, h("p", { class: "problem", text: "Choose something to print, a way to make it, and at least one status." }));
      writeButton.disabled = true;
      return;
    }
    clear(resultHost);
    put(resultHost, h("p", { class: "sub", text: "Checking…" }));
    writeButton.disabled = true;
    try {
      const result = await post(`${base}/print/check`, asked);
      reports = result.reports;
      renderReports();
      writeButton.disabled = working || Object.values(reports).every(/** @param {any} r */ (r) => r.items.every(/** @param {any} i */ (i) => i.outcome === "leftOut"));
    } catch (error) {
      clear(resultHost);
      put(resultHost, h("p", { class: "problem", text: /** @type {Error} */ (error).message }));
    }
  }

  function renderReports() {
    clear(resultHost);
    if (!reports) return;
    const names = /** @type {Record<string, string>} */ ({ student: "The student copy", key: "The answer key" });
    for (const [kind, report] of Object.entries(reports)) {
      put(resultHost, h("h3", { text: names[kind] ?? kind }), ...reportNodes(report, PRINT_WORDS));
    }
  }

  async function write() {
    if (working) return;
    working = true;
    writeButton.disabled = true;
    try {
      const result = await post(`${base}/print`, request());
      clear(writtenHost);
      put(
        writtenHost,
        h(
          "div",
          { class: "written" },
          h("h2", { text: result.written.length === 1 ? "The file is made" : "The files are made" }),
          h("p", { class: "sub", text: "They are in the Exports folder inside your OpenAssess folder. Nothing already there was written over." }),
          ...result.written.map(/** @param {any} file */ (file) =>
            h(
              "div",
              { class: "file-row" },
              h("span", { class: "file-name", text: file.name }),
              h("span", { class: "meta", text: file.pages ? plural(file.pages, "page", "pages") : file.format === "docx" ? "Word" : "PDF" }),
              ...fileButtons(file, shell),
            ),
          ),
        ),
      );
      shell.notify(`Made ${plural(result.written.length, "file", "files")}.`, "ok");
    } catch (error) {
      shell.notify(/** @type {Error} */ (error).message, "error");
    } finally {
      working = false;
      writeButton.disabled = false;
    }
  }

  await check();
  return {};
}
