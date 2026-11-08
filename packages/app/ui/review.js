// @ts-check
/**
 * The import review: what was found in a file, each question beside the lines it came from, ready to be repaired and
 * saved into a bank. Nothing is written until Save, and a question can be left out without being lost.
 */

import { get, post, put } from "./api.js";
import { ask } from "./dialogs.js";
import { clear, h, plural, SEVERITY_NAMES } from "./dom.js";
import { createEditor } from "./editor.js";
import { arrowKeys, fillRows, markSelected, questionRow, ROWS_AT_FIRST } from "./list.js";
import { notSavedBody, saveChoice, saveFields } from "./save-fields.js";

/**
 * @param {HTMLElement} host
 * @param {{ id: string }} params
 * @param {{ notify: (message: string, kind?: "ok" | "error") => void, go: (hash: string) => void }} shell
 */
export async function renderReview(host, params, shell) {
  const base = `sessions/${params.id}`;
  /** @type {any} */
  let session = await get(base);
  /** @type {"all" | "failed" | "needsReview" | "parsed" | "skipped"} */
  let filter = session.counts.failed > 0 ? "failed" : session.counts.needsReview > 0 ? "needsReview" : "all";
  /** @type {"questions" | "text"} */
  let tab = "questions";
  /** @type {number | null} */
  let selected = null;
  let rowLimit = ROWS_AT_FIRST;
  /** @type {ReturnType<typeof createEditor> | null} */
  let editor = null;
  let saved = Boolean(session.savedTo);

  clear(host);
  const head = h("div", { class: "page-head" });
  const chips = h("div", { class: "chips", role: "group", attrs: { "aria-label": "Show" } });
  const fileNotes = h("div", { class: "file-notes" });
  const list = h("ul", { class: "qlist", attrs: { "aria-label": "Questions" } });
  const detail = h("div", { class: "detail", attrs: { "aria-live": "polite" } });
  const textPane = h("div", { class: "text-pane" });
  const panes = h("div", { class: "panes" }, h("div", { class: "pane-list" }, list), detail);
  host.append(head, chips, fileNotes, panes, textPane);
  arrowKeys(list);

  // -------------------------------------------------------------------------

  /** Asks what to do with a change that is not saved. Returns whether it is fine to go on. */
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

  const shown = () =>
    /** @type {any[]} */ (session.questions).filter((q) => {
      if (filter === "all") return true;
      if (filter === "skipped") return q.skipped;
      return !q.skipped && q.verdict === filter;
    });

  function renderChips() {
    clear(chips);
    const c = session.counts;
    /** @param {typeof filter} key @param {string} label @param {number} n */
    const chip = (key, label, n) =>
      h("button", { type: "button", class: filter === key && tab === "questions" ? "chip on" : "chip", attrs: { "aria-pressed": String(filter === key && tab === "questions") }, on: { click: async () => { if (await canLeave()) { tab = "questions"; filter = key; rowLimit = ROWS_AT_FIRST; renderAll(); } } } }, h("b", { text: String(n) }), h("span", { text: label }));
    chips.append(
      chip("all", "All", c.total),
      chip("failed", "Failed", c.failed),
      chip("needsReview", "Need review", c.needsReview),
      chip("parsed", "Parsed", c.parsed),
      chip("skipped", "Left out", c.skipped),
      h("button", { type: "button", class: tab === "text" ? "chip on" : "chip", attrs: { "aria-pressed": String(tab === "text") }, on: { click: async () => { if (await canLeave()) { tab = "text"; renderAll(); } } } }, h("b", { text: String(session.orphans.length) }), h("span", { text: "Text no question used" })),
    );
  }

  function renderHead() {
    clear(head);
    head.append(
      h("div", null, h("h1", { text: "Check what was found" }), h("p", { class: "sub", text: session.file })),
      h("div", { class: "head-actions" }, h("button", { type: "button", class: "primary", text: saved ? `Saved to ${session.savedTo.bank}` : "Save into a bank…", disabled: saved, on: { click: () => void saveDialog() } })),
    );
  }

  function renderFileNotes() {
    clear(fileNotes);
    const notes = session.fileFindings;
    if (notes.length === 0) return;
    fileNotes.append(
      h(
        "details",
        { class: "more" },
        h("summary", { text: `About the file (${plural(notes.length, "note", "notes")})` }),
        h("ul", { class: "findings" }, ...notes.map(/** @param {any} f */ (f) => h("li", { class: `sev-${f.severity}` }, h("span", { class: "sev", text: SEVERITY_NAMES[/** @type {"error"} */ (f.severity)] ?? f.severity }), h("span", { class: "msg", text: f.message })))),
      ),
    );
  }

  function renderList() {
    clear(list);
    const items = shown();
    if (items.length === 0) list.append(h("li", { class: "empty", text: session.questions.length === 0 ? "No question was found in this file. Look at the text no question used." : "Nothing here." }));
    fillRows(list, items, (/** @type {any} */ summary) => questionRow({ number: summary.index + 1, key: summary.index, summary, selected: selected === summary.index, onSelect: () => void select(summary.index) }), {
      limit: rowLimit,
      chosenAt: items.findIndex((/** @type {any} */ s) => s.index === selected),
      more: (limit, firstNew) => {
        rowLimit = limit;
        renderList();
        /** @type {HTMLElement | undefined} */ (list.querySelectorAll("button.qrow")[firstNew])?.focus();
      },
    });
  }

  /** @param {number} index */
  async function select(index) {
    if (selected === index) return;
    if (!(await canLeave())) return;
    selected = index;
    markSelected(list, index);
    await renderDetail();
  }

  /** @param {any} summary */
  function replaceSummary(summary) {
    session.questions[summary.index] = { ...session.questions[summary.index], ...summary };
  }

  async function renderDetail() {
    clear(detail);
    editor = null;
    if (selected === null) {
      detail.append(h("p", { class: "placeholder", text: session.questions.length > 0 ? "Choose a question to see it beside the lines it came from." : "" }));
      return;
    }
    const index = selected;
    let loaded;
    try {
      loaded = await get(`${base}/questions/${index}`);
    } catch (error) {
      detail.append(h("p", { class: "problem", text: /** @type {Error} */ (error).message }));
      return;
    }
    if (selected !== index) return;
    const summary = session.questions[index];

    detail.append(sourcePanel(loaded.question));

    editor = createEditor({
      question: loaded.question,
      mediaBase: `${base}/media`,
      picturesBase: `${base}/questions/${index}/pictures`,
      onPictureChanged: (result) => {
        replaceSummary(result.summary);
        session.counts = result.counts;
        refresh();
      },
      saveLabel: "Apply changes",
      notify: shell.notify,
      save: async (input, version) => {
        const result = await put(`${base}/questions/${index}`, { input, expectVersion: version });
        replaceSummary(result.summary);
        session.counts = result.counts;
        refresh();
        return result;
      },
      dismiss: async (payload) => {
        const result = await post(`${base}/questions/${index}/dismiss`, payload);
        replaceSummary(result.summary);
        session.counts = result.counts;
        refresh();
        return result;
      },
      onSaved: () => refresh(),
      actions: [
        h("button", {
          type: "button",
          text: summary.skipped ? "Put back in the save" : "Leave out of the save",
          on: {
            click: async () => {
              const result = await post(`${base}/questions/${index}/skip`, { skipped: !summary.skipped });
              replaceSummary(result.summary);
              session.counts = result.counts;
              refresh();
              await renderDetail();
            },
          },
        }),
      ],
    });
    detail.append(editor.element);
  }

  /** The lines of the file a question was read from, with a little around them, and the lines it used marked. */
  /**
   * What the number beside a source line is. A file is read in lines and says so. A spreadsheet is read in rows, and each line
   * of it begins with the number of its row as the spreadsheet shows it, which is the number to give, and not the line's place
   * in what is listed here (a blank row or a sheet's name takes a place and no number).
   */
  const isTable = () => session.profile === "spreadsheet";
  const isPdf = () => session.profile === "pdf";
  /** @param {number} i */
  function numberOf(i) {
    if (!isTable()) return String(i + 1);
    const row = /^Row (\d+):/.exec(session.source[i] ?? "");
    return row ? row[1] : "";
  }

  function sourcePanel(/** @type {any} */ question) {
    const at = question.origin?.source;
    if (!at || !session.source.length) return h("div");
    const from = Math.max(0, at.firstBlock - 2);
    const to = Math.min(session.source.length - 1, at.lastBlock + 2);
    const rows = [];
    for (let i = from; i <= to; i++) {
      const inside = i >= at.firstBlock && i <= at.lastBlock;
      rows.push(h("div", { class: inside ? "src used" : "src" }, h("span", { class: "no", text: numberOf(i) }), h("span", { class: "tx", text: session.source[i] === "" ? " " : session.source[i] })));
    }
    const word = isTable() ? "row" : "line";
    const first = numberOf(at.firstBlock) || String(at.firstBlock + 1);
    const last = numberOf(at.lastBlock) || String(at.lastBlock + 1);
    // A PDF's lines each say their page, and a page is what a person finds in the PDF.
    const page = isPdf() ? /^\[p(\d+)\]/.exec(session.source[at.firstBlock] ?? "")?.[1] : undefined;
    const where = page ? `page ${page}, ${word}${at.firstBlock === at.lastBlock ? "" : "s"} ${first}${at.firstBlock === at.lastBlock ? "" : ` to ${last}`}` : `${word}${at.firstBlock === at.lastBlock ? "" : "s"} ${first}${at.firstBlock === at.lastBlock ? "" : ` to ${last}`}`;
    return h("details", { class: "source-panel", open: question.verdict !== "parsed" }, h("summary", { text: `From your ${isTable() ? "spreadsheet" : isPdf() ? "PDF" : "file"}, ${where}` }), h("div", { class: "src-lines" }, ...rows));
  }

  function renderText() {
    clear(textPane);
    if (tab !== "text") return;
    if (session.orphans.length === 0) {
      textPane.append(h("p", { class: "placeholder", text: "Every line of the file was used by a question or set aside as a heading." }));
      return;
    }
    textPane.append(h("p", { class: "sub", text: "This text was in the file, and no question claimed it. It is not saved into the bank. If it is a question, make one from it and set its type and answer." }));
    for (const orphan of session.orphans) {
      textPane.append(
        h(
          "div",
          { class: "orphan" },
          h("p", { class: "orphan-text", text: orphan.text }),
          h("p", { class: "why", text: `${isTable() ? (orphan.firstBlock === orphan.lastBlock ? `Row ${numberOf(orphan.firstBlock)}` : `Rows ${numberOf(orphan.firstBlock)} to ${numberOf(orphan.lastBlock)}`) : orphan.firstBlock === orphan.lastBlock ? `Line ${orphan.firstBlock + 1}` : `Lines ${orphan.firstBlock + 1} to ${orphan.lastBlock + 1}`}. ${orphan.reason}` }),
          h("button", {
            type: "button",
            text: orphan.made ? "A question was made from this" : "Make a question from this text",
            disabled: orphan.made,
            on: {
              click: async () => {
                try {
                  const result = await post(`${base}/orphans/${orphan.index}/question`);
                  session = result.view;
                  tab = "questions";
                  filter = "needsReview";
                  selected = null;
                  renderAll();
                  await select(result.summary.index);
                  shell.notify("A draft question was made. Set its type and its answer.", "ok");
                } catch (error) {
                  shell.notify(/** @type {Error} */ (error).message, "error");
                }
              },
            },
          }),
        ),
      );
    }
  }

  function refresh() {
    renderChips();
    renderList();
  }

  function renderAll() {
    renderHead();
    renderChips();
    renderFileNotes();
    panes.hidden = tab !== "questions";
    renderList();
    renderText();
    if (tab === "questions") void renderDetail();
  }

  // -------------------------------------------------------------------------

  async function saveDialog() {
    if (!(await canLeave())) return;
    const c = session.counts;
    const kept = c.total - c.skipped;
    if (kept === 0) {
      shell.notify("Every question is left out, so there is nothing to save.", "error");
      return;
    }
    /** @type {any} */
    let state;
    try {
      state = await get("state");
    } catch (error) {
      shell.notify(/** @type {Error} */ (error).message, "error");
      return;
    }
    const banks = /** @type {any[]} */ (state.banks).filter((b) => !b.error);
    const fields = saveFields({ file: session.file, banks });
    const notes = [`${plural(kept, "question", "questions")} will be saved.`];
    if (c.skipped > 0) notes.push(`${plural(c.skipped, "question", "questions")} you left out will not be.`);
    if (c.failed > 0) notes.push(`${plural(c.failed, "question has", "questions have")} no usable answer yet. They are saved, marked as failed, so you can fix them in the bank.`);
    if (session.orphans.filter(/** @param {any} o */ (o) => !o.made).length > 0) notes.push(`${plural(session.orphans.filter(/** @param {any} o */ (o) => !o.made).length, "piece", "pieces")} of text that no question used will not be saved.`);
    const answer = await ask({
      title: "Save into a bank",
      body: [
        ...notes,
        ...fields.body,
      ],
      actions: [
        { label: "Cancel", value: false },
        { label: "Save", value: true, primary: true },
      ],
      collect: () => saveChoice(fields),
    });
    if (!answer || answer.value !== true) return;
    const choice = answer.collected;
    try {
      const where = choice.isNew ? { title: choice.title } : { bank: choice.bank };
      const result = await post(`${base}/save`, choice.folder ? { ...where, folder: choice.folder } : where);
      saved = true;
      session.savedTo = { bank: result.bank, added: result.added };
      const failed = result.notSaved.length > 0;
      shell.notify(`Saved ${plural(result.added, "question", "questions")} into "${result.bank}"${result.folder ? `, in the folder "${result.folder}"` : ""}.${failed ? ` ${plural(result.notSaved.length, "question", "questions")} could not be saved.` : ""}`, failed ? "error" : "ok");
      // Which ones, and why, are said in a dialog that stays until it is answered: the line above fades, and the screen moves on.
      if (failed) await ask({ title: "Some questions were not saved", body: notSavedBody(result), actions: [{ label: "OK", value: true, primary: true }] });
      shell.go(`#/bank/${encodeURIComponent(result.bank)}`);
    } catch (error) {
      shell.notify(/** @type {Error} */ (error).message, "error");
    }
  }

  renderAll();
  if (session.savedTo) shell.notify(`This import was already saved into "${session.savedTo.bank}".`, "ok");
  // Open the first question that needs a look, so that the screen starts with the thing to do.
  const first = shown()[0];
  if (first) await select(first.index);

  return { canLeave, dirty: () => Boolean(editor?.isDirty()) };
}
