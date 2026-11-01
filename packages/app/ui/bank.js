// @ts-check
/**
 * A bank: its questions in a list, one open beside it, ready to read, search, change, add to and take out.
 *
 * Every change is written to the bank's file before the screen says it was saved, so there is no Save for the bank itself,
 * only for the question being edited.
 */

import { del, get, post, put } from "./api.js";
import { ask, askText, confirmAction } from "./dialogs.js";
import { clear, EDITABLE_TYPES, h, plural, TYPE_NAMES, when } from "./dom.js";
import { createEditor } from "./editor.js";
import { arrowKeys, questionRow } from "./list.js";

/**
 * @param {HTMLElement} host
 * @param {{ name: string }} params
 * @param {{ notify: (message: string, kind?: "ok" | "error") => void, go: (hash: string) => void }} shell
 */
export async function renderBank(host, params, shell) {
  const base = `banks/${encodeURIComponent(params.name)}`;
  /** @type {any} */
  let bank = await get(base);
  let query = "";
  let type = "";
  let check = "";
  /** @type {string | null} */
  let selected = null;
  /** @type {ReturnType<typeof createEditor> | null} */
  let editor = null;
  let searchTimer = 0;

  clear(host);
  const head = h("div", { class: "page-head" });
  const tools = h("div", { class: "tools" });
  const list = h("ul", { class: "qlist", attrs: { "aria-label": "Questions" } });
  const detail = h("div", { class: "detail", attrs: { "aria-live": "polite" } });
  host.append(head, tools, h("div", { class: "panes" }, h("div", { class: "pane-list" }, list), detail));
  arrowKeys(list);

  async function canLeave() {
    if (!editor || !editor.isDirty()) return true;
    const answer = await ask({
      title: "Save your changes?",
      body: ["You changed this question and have not saved it."],
      actions: [
        { label: "Keep editing", value: "stay" },
        { label: "Discard", value: "discard", danger: true },
        { label: "Save", value: "save", primary: true },
      ],
    });
    if (!answer || answer.value === "stay") return false;
    if (answer.value === "save") {
      await editor.save();
      return !editor.isDirty();
    }
    return true;
  }

  function renderHead() {
    clear(head);
    const stats = bank.stats;
    head.append(
      h(
        "div",
        null,
        h("h1", { text: bank.title }),
        h("p", { class: "sub", text: `${plural(bank.total, "question", "questions")}${stats.withErrors + stats.withWarnings > 0 ? `, ${stats.withErrors} failed and ${stats.withWarnings} to check` : ""}. Changed ${when(bank.modified)}.` }),
      ),
      h(
        "div",
        { class: "head-actions" },
        h("button", { type: "button", text: "Rename", on: { click: () => void rename() } }),
        h("button", { type: "button", text: "Print…", on: { click: () => shell.go(`#/print/${encodeURIComponent(params.name)}`) } }),
        h("button", { type: "button", text: "Export…", on: { click: () => shell.go(`#/export/${encodeURIComponent(params.name)}`) } }),
        h("button", { type: "button", class: "danger", text: "Remove…", on: { click: () => void remove() } }),
      ),
    );
  }

  function renderTools() {
    clear(tools);
    const search = h("input", { type: "search", id: "bank-search", value: query, placeholder: "Search the questions", autocomplete: "off", attrs: { "aria-label": "Search the questions" } });
    search.addEventListener("input", () => {
      clearTimeout(searchTimer);
      searchTimer = window.setTimeout(async () => {
        query = search.value;
        await reload();
      }, 250);
    });
    const kinds = h("select", { attrs: { "aria-label": "Kind of question" } }, h("option", { value: "", text: "All kinds" }), ...EDITABLE_TYPES.map((t) => h("option", { value: t, text: /** @type {any} */ (TYPE_NAMES)[t], selected: t === type })));
    kinds.addEventListener("change", async () => {
      type = kinds.value;
      await reload();
    });
    const checks = h("select", { attrs: { "aria-label": "Checks" } }, ...[["", "Any checks"], ["problems", "Needs attention"], ["errors", "Failed"], ["clean", "Parsed cleanly"]].map(([v, text]) => h("option", { value: v, text, selected: v === check })));
    checks.addEventListener("change", async () => {
      check = checks.value;
      await reload();
    });
    const add = h("select", { attrs: { "aria-label": "Write a new question" } }, h("option", { value: "", text: "Write a new question…" }), ...EDITABLE_TYPES.map((t) => h("option", { value: t, text: /** @type {any} */ (TYPE_NAMES)[t] })));
    add.addEventListener("change", async () => {
      const chosen = add.value;
      add.value = "";
      if (chosen && (await canLeave())) await startNew(chosen);
    });
    tools.append(search, kinds, checks, add);
  }

  function renderList() {
    clear(list);
    if (bank.questions.length === 0) {
      list.append(h("li", { class: "empty", text: bank.total === 0 ? "This bank has no questions yet. Write one, or import a file." : "No question matches." }));
    }
    bank.questions.forEach(/** @param {any} summary @param {number} i */ (summary, i) => {
      list.append(questionRow({ number: i + 1, summary, selected: selected === summary.id, onSelect: () => void select(summary.id) }));
    });
  }

  async function reload() {
    const params2 = new URLSearchParams();
    if (query.trim()) params2.set("q", query.trim());
    if (type) params2.set("type", type);
    if (check) params2.set("check", check);
    const suffix = params2.toString();
    bank = await get(suffix ? `${base}?${suffix}` : base);
    renderHead();
    renderList();
  }

  /** @param {string} id */
  async function select(id) {
    if (selected === id) return;
    if (!(await canLeave())) return;
    selected = id;
    renderList();
    await renderDetail();
  }

  function hold() {
    clear(detail);
    editor = null;
  }

  async function renderDetail() {
    hold();
    if (selected === null) {
      detail.append(h("p", { class: "placeholder", text: bank.total > 0 ? "Choose a question to read or change it." : "" }));
      return;
    }
    const id = selected;
    let loaded;
    try {
      loaded = await get(`${base}/questions/${encodeURIComponent(id)}`);
    } catch (error) {
      detail.append(h("p", { class: "problem", text: /** @type {Error} */ (error).message }));
      return;
    }
    if (selected !== id) return;
    editor = createEditor({
      question: loaded.question,
      notify: shell.notify,
      save: async (input, version) => {
        const result = await put(`${base}/questions/${encodeURIComponent(id)}`, { input, expectVersion: version });
        return result;
      },
      dismiss: (payload) => post(`${base}/questions/${encodeURIComponent(id)}/dismiss`, payload),
      onSaved: () => void reload(),
      actions: [
        h("button", { type: "button", text: "Duplicate", on: { click: () => void duplicate(id) } }),
        h("button", { type: "button", class: "danger", text: "Delete…", on: { click: () => void removeQuestion(id) } }),
      ],
    });
    detail.append(editor.element);
  }

  /** @param {string} kind */
  async function startNew(kind) {
    try {
      const blank = (await get(`blank?type=${kind}`)).input;
      selected = null;
      renderList();
      hold();
      editor = createEditor({
        question: { id: "", version: 0, ...blank, verdict: "parsed", findings: [], formatted: [], locked: [], media: 0, math: 0 },
        saveLabel: "Add to the bank",
        notify: shell.notify,
        save: async (input) => {
          const result = await post(`${base}/questions`, { input });
          selected = result.question.id;
          return result;
        },
        dismiss: async () => {
          throw new Error("Add the question to the bank first.");
        },
        onSaved: async () => {
          await reload();
          await renderDetail();
        },
      });
      detail.append(h("p", { class: "sub", text: `A new ${/** @type {any} */ (TYPE_NAMES)[kind].toLowerCase()} question. Nothing is kept until you add it.` }), editor.element);
      // The first thing to write is the question itself.
      /** @type {HTMLElement | null} */ (detail.querySelector("textarea"))?.focus();
    } catch (error) {
      shell.notify(/** @type {Error} */ (error).message, "error");
    }
  }

  /** @param {string} id */
  async function duplicate(id) {
    if (!(await canLeave())) return;
    try {
      const result = await post(`${base}/questions/${encodeURIComponent(id)}/duplicate`);
      selected = result.question.id;
      await reload();
      await renderDetail();
      shell.notify("Duplicated. The copy is a draft.", "ok");
    } catch (error) {
      shell.notify(/** @type {Error} */ (error).message, "error");
    }
  }

  /** @param {string} id */
  async function removeQuestion(id) {
    if (!(await confirmAction("Delete this question?", "It is taken out of the bank and cannot be got back from here.", { yes: "Delete", no: "Keep it", danger: true }))) return;
    try {
      await del(`${base}/questions/${encodeURIComponent(id)}`);
      selected = null;
      await reload();
      await renderDetail();
      shell.notify("Deleted.", "ok");
    } catch (error) {
      shell.notify(/** @type {Error} */ (error).message, "error");
    }
  }

  async function rename() {
    const title = await askText("Rename this bank", "Title", bank.title, "Rename");
    if (!title) return;
    try {
      await put(base, { title });
      await reload();
      shell.notify("Renamed.", "ok");
    } catch (error) {
      shell.notify(/** @type {Error} */ (error).message, "error");
    }
  }

  async function remove() {
    if (!(await canLeave())) return;
    if (!(await confirmAction(`Remove "${bank.title}"?`, "The bank is moved to the Deleted folder inside your OpenAssess folder. Nothing is erased, and you can move it back.", { yes: "Remove it", no: "Keep it", danger: true }))) return;
    try {
      await del(base);
      shell.notify("The bank was moved to the Deleted folder.", "ok");
      shell.go("#/");
    } catch (error) {
      shell.notify(/** @type {Error} */ (error).message, "error");
    }
  }

  renderHead();
  renderTools();
  renderList();
  await renderDetail();
  return { canLeave, dirty: () => Boolean(editor?.isDirty()) };
}
