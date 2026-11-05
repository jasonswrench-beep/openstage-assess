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

/** What each kind of note is about, in the words the screen uses. */
const NOTE_NAMES = {
  "quality.all-or-none-of-the-above": "An option that depends on the others (all of the above, none of the above)",
  "quality.longest-option-correct": "The right answer is much the longest",
  "quality.negative-stem-not-emphasised": "NOT, EXCEPT or LEAST not set apart",
  "quality.grammatical-cue": "The grammar gives the answer away",
  "quality.duplicate-option": "Two options read the same",
  "a11y.alt-text-gives-answer": "A picture's description gives the answer",
  "a11y.colour-only-meaning": "A picture and a colour",
  "a11y.long-matching-list": "A long matching list",
};

/** The label of a question that has no value for a thing, as the engine writes it. */
const NONE = "(none)";

/** What a list can be narrowed by, besides the kind and the checks: the name the engine uses, and the words the screen uses. */
const FILTER_AXES = [
  ["objective", "Objective"],
  ["chapter", "Chapter"],
  ["section", "Section"],
  ["tag", "Tag"],
  ["bloom", "Bloom level"],
  ["difficulty", "Difficulty"],
  ["status", "Status"],
];

/** What the coverage grid can put down the side and across the top. */
const COVERAGE_CHOICES = [...FILTER_AXES.slice(0, 6), ["type", "Kind of question"], ["status", "Status"]];

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
  /** The things the list is narrowed to besides the kind and the checks: an axis and the one value it must have. @type {Record<string, string>} */
  let filters = {};
  let coverageRows = "objective";
  let coverageCols = "bloom";
  /** @type {string | null} */
  let selected = null;
  /** @type {ReturnType<typeof createEditor> | null} */
  let editor = null;
  let searchTimer = 0;

  clear(host);
  const head = h("div", { class: "page-head" });
  const problemsHost = h("div", { attrs: { "aria-live": "polite" } });
  const tools = h("div", { class: "tools" });
  const facetBar = h("div", { class: "facets" });
  const clearButton = h("button", { type: "button", class: "small-button", text: "Clear filters", on: { click: () => void clearFilters() } });
  /** The choices the facet selects were built from, so that they are built again only when the bank's own values change (a select rebuilt under a person's hands loses their place). */
  let facetsKey = "";
  const list = h("ul", { class: "qlist", attrs: { "aria-label": "Questions" } });
  const detail = h("div", { class: "detail", attrs: { "aria-live": "polite" } });
  host.append(head, problemsHost, tools, h("div", { class: "panes" }, h("div", { class: "pane-list" }, list), detail));
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

  /** What could not be read when the bank was opened, said plainly, with the files left as they were. Nothing when all was read. */
  function renderProblems() {
    clear(problemsHost);
    const problems = bank.problems;
    if (!problems || (problems.unreadable.length === 0 && !problems.count)) return;
    const box = h("section", { class: "problem-box", attrs: { role: "note", "aria-label": "Problems reading this bank" } });
    if (problems.count) box.append(h("p", { text: problems.count }));
    if (problems.unreadable.length > 0) {
      box.append(
        h("p", { text: `${plural(problems.unreadable.length, "file in this bank could not be read, and is", "files in this bank could not be read, and are")} not in the list. ${problems.unreadable.length === 1 ? "It is" : "They are"} kept exactly as ${problems.unreadable.length === 1 ? "it was" : "they were"}, so nothing is lost; saving the bank does not change ${problems.unreadable.length === 1 ? "it" : "them"}.` }),
        h("details", null, h("summary", { text: "Which files" }), h("ul", null, ...problems.unreadable.map(/** @param {{ id: string, message: string }} entry */ (entry) => h("li", { text: `${entry.id}: ${entry.message}` })))),
      );
    }
    problemsHost.append(box);
  }

  function renderHead() {
    clear(head);
    const stats = bank.stats;
    renderProblems();
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
        h("button", { type: "button", text: "Answer sheets…", on: { click: () => shell.go(`#/sheets/${encodeURIComponent(params.name)}`) } }),
        h("button", { type: "button", text: "Coverage", on: { click: () => void showCoverage() } }),
        h("button", { type: "button", text: "Check quality", on: { click: () => void checkQuality() } }),
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
    const checks = h("select", { attrs: { "aria-label": "Checks" } }, ...[["", "Any checks"], ["problems", "Needs attention"], ["errors", "Failed"], ["clean", "Parsed cleanly"], ["notes", "Has notes"]].map(([v, text]) => h("option", { value: v, text, selected: v === check })));
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
    facetsKey = "";
    renderFacets();
    tools.append(search, kinds, facetBar, checks, clearButton, add);
  }

  /** The selects for narrowing the list to a chapter, an objective, a tag and so on: only those the bank has values for. */
  function renderFacets() {
    clearButton.hidden = !filtersActive();
    const key = JSON.stringify(bank.facets ?? {});
    if (key === facetsKey) return;
    facetsKey = key;
    clear(facetBar);
    for (const [axis, label] of FILTER_AXES) {
      /** @type {Array<{ value: string, count: number }>} */
      const choices = bank.facets?.[axis] ?? [];
      const worth = choices.some((c) => c.value !== NONE) && (axis !== "status" || choices.length > 1);
      if (!worth && !filters[axis]) continue;
      const select = h(
        "select",
        { attrs: { "aria-label": label } },
        h("option", { value: "", text: `Any ${label.toLowerCase()}` }),
        ...choices.map((c) => h("option", { value: c.value, text: `${c.value === NONE ? "Not set" : c.value} (${c.count})`, selected: filters[axis] === c.value })),
      );
      select.addEventListener("change", async () => {
        if (select.value) filters[axis] = select.value;
        else delete filters[axis];
        await reload();
      });
      facetBar.append(select);
    }
  }

  function filtersActive() {
    return Object.keys(filters).length > 0 || type !== "" || check !== "";
  }

  async function clearFilters() {
    filters = {};
    type = "";
    check = "";
    renderTools();
    await reload();
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
    for (const [axis, value] of Object.entries(filters)) params2.set(axis, value);
    const suffix = params2.toString();
    bank = await get(suffix ? `${base}?${suffix}` : base);
    renderHead();
    renderList();
    renderFacets();
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

  /**
   * Check the whole bank for notes about its writing and accessibility, and show what was found in the pane where a question
   * would be. The notes themselves are on the questions, in the editor, where they can be dismissed one at a time.
   */
  async function checkQuality() {
    if (!(await canLeave())) return;
    try {
      const result = await post(`${base}/quality`);
      selected = null;
      // The results are about the whole bank, and name questions by their place in it, so the list is the whole bank.
      query = "";
      type = "";
      check = "";
      filters = {};
      renderTools();
      await reload();
      showQuality(result);
    } catch (error) {
      shell.notify(/** @type {Error} */ (error).message, "error");
    }
  }

  /** @param {any} result */
  function showQuality(result) {
    hold();
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
      panel.append(
        list,
        h("div", { class: "card-actions" }, h("button", { type: "button", text: "Show the questions with notes", on: { click: () => void showNotes() } })),
      );
    }

    if (result.duplicates.length > 0) {
      panel.append(h("h3", { text: "The same question more than once" }));
      for (const group of result.duplicates) {
        // Copies have the same title, so each is named by its place in the list, which is the number on its row.
        const links = group.questionIds.map(
          /** @param {string} id @param {number} i */ (id, i) => {
            const place = bank.questions.findIndex(/** @param {any} q */ (q) => q.id === id);
            return h("button", { type: "button", class: "small-button", text: `${place >= 0 ? `Question ${place + 1}: ` : ""}${group.titles[i] || "Untitled question"}`, on: { click: () => void select(id) } });
          },
        );
        panel.append(h("p", { text: group.message }), h("div", { class: "card-actions" }, ...links));
      }
    }

    if (result.keyBalance.length > 0) {
      panel.append(h("h3", { text: "Where the right answers sit" }), h("ul", { class: "quality-kinds" }, ...result.keyBalance.map(/** @param {any} note */ (note) => h("li", { text: note.message }))));
    }

    panel.append(h("p", { class: "hint", text: "These are notes, not faults. Open a question to see its notes and dismiss any you meant. Checking changed nothing else about the questions." }));
    detail.append(panel);
    heading.focus();
  }

  async function showNotes() {
    check = "notes";
    renderTools();
    await reload();
  }

  /**
   * What the bank covers, as a grid of two things against each other (objectives down and Bloom levels across, to begin with), in
   * the pane where a question would be. Every count above nothing is a button that narrows the list to those questions.
   */
  async function showCoverage() {
    if (!(await canLeave())) return;
    selected = null;
    renderList();
    await drawCoverage();
  }

  /** @param {string} id @param {string} label @param {string} value @param {(value: string) => void} onChange */
  function axisChoice(id, label, value, onChange) {
    const select = h("select", { id }, ...COVERAGE_CHOICES.map(([axis, name]) => h("option", { value: axis, text: name, selected: axis === value })));
    select.addEventListener("change", () => onChange(select.value));
    return h("div", { class: "field inline" }, h("label", { for: id, text: label }), select);
  }

  async function drawCoverage() {
    /** @type {any} */
    let grid;
    try {
      grid = await get(`${base}/coverage?rows=${encodeURIComponent(coverageRows)}&cols=${encodeURIComponent(coverageCols)}`);
    } catch (error) {
      shell.notify(/** @type {Error} */ (error).message, "error");
      return;
    }
    hold();
    const nameOf = (/** @type {string} */ axis) => String(COVERAGE_CHOICES.find(([a]) => a === axis)?.[1] ?? axis);
    const heading = h("h2", { text: "Coverage", attrs: { tabindex: "-1" } });
    const panel = h("section", { class: "card coverage" }, heading);
    panel.append(
      h("p", { class: "sub", text: grid.total === 0 ? "There are no questions to count." : `${plural(grid.total, "question", "questions")} counted. Retired questions are left out, and a question with nothing set is counted under "Not set".` }),
      h(
        "div",
        { class: "coverage-choices" },
        axisChoice("coverage-rows", "Down", coverageRows, (value) => {
          coverageRows = value;
          void drawCoverage();
        }),
        axisChoice("coverage-cols", "Across", coverageCols, (value) => {
          coverageCols = value;
          void drawCoverage();
        }),
      ),
    );

    if (grid.total > 0) {
      const shown = (/** @type {string} */ label) => (label === NONE ? "Not set" : label);
      const table = h("table", null, h("caption", { text: `Questions by ${nameOf(coverageRows).toLowerCase()} (down) and ${nameOf(coverageCols).toLowerCase()} (across)` }));
      table.append(
        h("thead", null, h("tr", null, h("th", { attrs: { scope: "col" }, text: nameOf(coverageRows) }), ...grid.colLabels.map((/** @type {string} */ c) => h("th", { attrs: { scope: "col" }, text: shown(c) })), h("th", { attrs: { scope: "col" }, text: "Total" }))),
      );
      const body = h("tbody");
      grid.rowLabels.forEach((/** @type {string} */ r, /** @type {number} */ ri) => {
        const row = h("tr", null, h("th", { attrs: { scope: "row" }, text: shown(r) }));
        grid.colLabels.forEach((/** @type {string} */ c, /** @type {number} */ ci) => {
          const count = grid.cells[ri][ci];
          row.append(
            h(
              "td",
              null,
              count > 0
                ? h("button", { type: "button", class: "small-button cell-button", text: String(count), attrs: { "aria-label": `${count} ${count === 1 ? "question" : "questions"}: ${shown(r)}, ${shown(c)}. Show them.` }, on: { click: () => void showCell(r, c) } })
                : h("span", { class: "zero", text: "0" }),
            ),
          );
        });
        row.append(h("td", { class: "total", text: String(grid.rowTotals[ri]) }));
        body.append(row);
      });
      table.append(
        body,
        h("tfoot", null, h("tr", null, h("th", { attrs: { scope: "row" }, text: "Total" }), ...grid.colTotals.map((/** @type {number} */ n) => h("td", { class: "total", text: String(n) })), h("td", { class: "total", text: String(grid.total) }))),
      );
      panel.append(h("div", { class: "scroll" }, table));
      if (coverageRows === "tag" || coverageCols === "tag") panel.append(h("p", { class: "hint", text: "A question with several tags is counted under each, so the totals can be more than the number of questions." }));
    }
    detail.append(panel);
    heading.focus();
  }

  /** Narrow the list to the questions of one cell of the grid. */
  async function showCell(/** @type {string} */ rowLabel, /** @type {string} */ colLabel) {
    filters = {};
    type = "";
    check = "";
    query = "";
    for (const [axis, value] of [[coverageRows, rowLabel], [coverageCols, colLabel]]) {
      if (axis === "type") type = /** @type {string} */ (value);
      else filters[/** @type {string} */ (axis)] = /** @type {string} */ (value);
    }
    renderTools();
    await reload();
    shell.notify(`${plural(bank.questions.length, "question", "questions")} shown. Clear filters shows them all again.`, "ok");
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
