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
import { arrowKeys, fillRows, markSelected, questionRow, ROWS_AT_FIRST } from "./list.js";

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
  /** Left out of the list: the retired. Set when the list is opened from a cell of the coverage grid, which does not count them. */
  let hideRetired = false;
  /** The folder the list is narrowed to: "" for any, NONE for the questions in no folder, or a folder's id (and what is inside it). */
  let folder = "";
  let coverageRows = "objective";
  let coverageCols = "bloom";
  /** @type {string | null} */
  let selected = null;
  let rowLimit = ROWS_AT_FIRST;
  /** The search and filters the list was last asked for, so that the same ones drawn again keep how many rows were shown. */
  let listedFor = "";
  /** @type {ReturnType<typeof createEditor> | null} */
  let editor = null;
  let searchTimer = 0;

  clear(host);
  const head = h("div", { class: "page-head" });
  const problemsHost = h("div", { attrs: { "aria-live": "polite" } });
  const tools = h("div", { class: "tools" });
  const facetBar = h("div", { class: "facets" });
  const clearButton = h("button", { type: "button", class: "small-button", text: "Clear filters", on: { click: () => void clearFilters() } });
  /** The control that files every question the list shows in one folder, or in none. It is rebuilt each time the list is. */
  const filingHost = h("div", { class: "facets" });
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
    if (!problems || (problems.unreadable.length === 0 && !problems.count && !problems.pictures)) return;
    const box = h("section", { class: "problem-box", attrs: { role: "note", "aria-label": "Problems reading this bank" } });
    if (problems.count) box.append(h("p", { text: problems.count }));
    if (problems.pictures) box.append(h("p", { text: problems.pictures }));
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
        h("button", { type: "button", text: "Folders", on: { click: () => void showFolders() } }),
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
    // The kinds that can be written here, and the kind the list is narrowed to if it is another (a cell of the coverage grid can be a
    // hotspot question, which the select would otherwise not show, with the list narrowed to it and the select saying All kinds).
    const kindChoices = type !== "" && !EDITABLE_TYPES.includes(type) ? [...EDITABLE_TYPES, type] : EDITABLE_TYPES;
    const kinds = h("select", { attrs: { "aria-label": "Kind of question" } }, h("option", { value: "", text: "All kinds" }), ...kindChoices.map((t) => h("option", { value: t, text: /** @type {any} */ (TYPE_NAMES)[t] ?? t, selected: t === type })));
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
    tools.append(search, kinds, facetBar, checks, clearButton, filingHost, add);
    renderFiling();
  }

  /** The selects for narrowing the list to a chapter, an objective, a tag and so on: only those the bank has values for. */
  function renderFacets() {
    clearButton.hidden = !filtersActive();
    // Not the folder chosen: the select already shows it, and one rebuilt under a person's hands loses their place.
    const key = JSON.stringify([bank.facets ?? {}, bank.folders ?? [], bank.unfiled ?? 0]);
    if (key === facetsKey) return;
    facetsKey = key;
    clear(facetBar);
    // Folders first: a bank with none has no select for them, so a person who does not use folders never sees one.
    if ((bank.folders ?? []).length > 0 || folder !== "") {
      const select = h(
        "select",
        { attrs: { "aria-label": "Folder" } },
        h("option", { value: "", text: "Any folder" }),
        h("option", { value: NONE, text: `Not in a folder (${bank.unfiled ?? 0})`, selected: folder === NONE }),
        ...folderChoices(folder),
      );
      select.addEventListener("change", async () => {
        folder = select.value;
        await reload();
      });
      facetBar.append(select);
    }
    for (const [axis, label] of FILTER_AXES) {
      /** @type {Array<{ value: string, count: number }>} */
      const choices = bank.facets?.[axis] ?? [];
      const worth = choices.some((c) => c.value !== NONE) && (axis !== "status" || choices.length > 1);
      if (!worth && !filters[axis]) continue;
      // A value the list is narrowed to that no question has any more (the last of them was changed) is still a choice, with none:
      // left out, the select said Any and the list stayed narrowed to something it did not show.
      const shown = filters[axis] && !choices.some((c) => c.value === filters[axis]) ? [...choices, { value: /** @type {string} */ (filters[axis]), count: 0 }] : choices;
      const select = h(
        "select",
        { attrs: { "aria-label": label } },
        h("option", { value: "", text: `Any ${label.toLowerCase()}` }),
        ...shown.map((c) => h("option", { value: c.value, text: `${c.value === NONE ? "Not set" : c.value} (${c.count})`, selected: filters[axis] === c.value })),
      );
      select.addEventListener("change", async () => {
        if (select.value) filters[axis] = select.value;
        else delete filters[axis];
        await reload();
      });
      facetBar.append(select);
    }
  }

  /**
   * The folders as the options of a select, each set in by how deep it is. `leave` is folders not to offer (a folder cannot be put
   * inside itself); `counts` adds how many questions are under each.
   * @param {string} chosen
   * @param {Set<string>} [leave]
   * @param {boolean} [counts]
   */
  function folderChoices(chosen, leave = new Set(), counts = true) {
    return (bank.folders ?? [])
      .filter(/** @param {any} f */ (f) => !leave.has(f.id))
      .map(/** @param {any} f */ (f) => h("option", { value: f.id, text: `${"  ".repeat(f.depth)}${f.name}${counts ? ` (${f.total})` : ""}`, selected: f.id === chosen }));
  }

  /** A folder and every folder inside it. The list is in the order it is shown, each folder followed by what is inside it. @param {string} id */
  function folderAndInside(id) {
    /** @type {any[]} */
    const list = bank.folders ?? [];
    const at = list.findIndex((f) => f.id === id);
    const out = new Set([id]);
    if (at === -1) return out;
    for (let i = at + 1; i < list.length && list[i].depth > list[at].depth; i++) out.add(list[i].id);
    return out;
  }

  /** @param {string} id */
  function folderName(id) {
    return /** @type {any} */ ((bank.folders ?? []).find(/** @param {any} f */ (f) => f.id === id))?.name ?? "the folder";
  }

  function filtersActive() {
    return Object.keys(filters).length > 0 || type !== "" || check !== "" || hideRetired || folder !== "";
  }

  async function clearFilters() {
    filters = {};
    hideRetired = false;
    folder = "";
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
    fillRows(list, bank.questions, (/** @type {any} */ summary, /** @type {number} */ i) => questionRow({ number: i + 1, key: summary.id, summary, selected: selected === summary.id, onSelect: () => void select(summary.id) }), {
      limit: rowLimit,
      chosenAt: bank.questions.findIndex(/** @param {any} q */ (q) => q.id === selected),
      more: (limit, firstNew) => {
        rowLimit = limit;
        renderList();
        /** @type {HTMLElement | undefined} */ (list.querySelectorAll("button.qrow")[firstNew])?.focus();
      },
    });
  }

  async function reload() {
    const params2 = new URLSearchParams();
    if (query.trim()) params2.set("q", query.trim());
    if (type) params2.set("type", type);
    if (check) params2.set("check", check);
    if (folder) params2.set("folder", folder);
    for (const [axis, value] of Object.entries(filters)) params2.set(axis, value);
    if (hideRetired) params2.set("hideRetired", "1");
    const suffix = params2.toString();
    // A different search or filter is a different list, which starts from its first thousand again; the same list drawn again (after
    // an edit) keeps how far it was shown.
    if (suffix !== listedFor) {
      listedFor = suffix;
      rowLimit = ROWS_AT_FIRST;
    }
    bank = await get(suffix ? `${base}?${suffix}` : base);
    // A folder taken away in another window is not one to stay narrowed to: the list would be empty and the choice would say nothing.
    if (folder && folder !== NONE && !(bank.folders ?? []).some(/** @param {any} f */ (f) => f.id === folder)) {
      folder = "";
      facetsKey = "";
      shell.notify("That folder is not in the bank any more, so the list shows every folder.", "ok");
      await reload();
      return;
    }
    renderHead();
    renderList();
    renderFacets();
    renderFiling();
  }

  /**
   * Filing the questions the list shows, all at once, in a folder or in none. The list is whatever was searched or narrowed to, so a
   * chapter is filed by choosing the chapter and then the folder. Filing is not an edit of any question.
   */
  function renderFiling() {
    clear(filingHost);
    const shown = bank.questions.length;
    if (shown === 0 || (bank.folders ?? []).length === 0) return;
    const select = h(
      "select",
      { attrs: { "aria-label": `File the ${shown === 1 ? "question" : `${shown} questions`} shown in a folder` } },
      h("option", { value: "", text: shown === 1 ? "File this question in…" : `File these ${shown} in…` }),
      h("option", { value: NONE, text: "Not in a folder" }),
      ...folderChoices("", new Set(), false),
    );
    select.addEventListener("change", () => {
      const wanted = select.value;
      select.value = "";
      if (wanted) void fileShown(wanted === NONE ? "" : wanted);
    });
    filingHost.append(select);
  }

  /** @param {string} wanted  a folder's id, or "" for none */
  async function fileShown(wanted) {
    const ids = bank.questions.map(/** @param {any} q */ (q) => q.id);
    const where = wanted ? `the folder "${folderName(wanted)}"` : "no folder";
    // Every question of the bank is a lot to move by one choice in a list, so it is asked first. A list that was narrowed is what the person chose.
    if (!filtersActive() && query.trim() === "" && ids.length > 1) {
      const sure = await confirmAction(`File all ${ids.length} questions?`, `Every question in the bank would be put in ${where}, out of the folder each is in now. Nothing is deleted, and each can be filed again.`, { yes: "File them all", no: "Cancel" });
      if (!sure) return;
    }
    try {
      const result = await post(`${base}/filing`, { folderId: wanted || null, questionIds: ids });
      await reload();
      const said = [result.filed === 1 ? "1 question was" : `${result.filed} questions were`, wanted ? `put in ${where}` : "taken out of their folders"].join(" ");
      shell.notify(`${said}.${result.alreadyThere > 0 ? ` ${result.alreadyThere} ${result.alreadyThere === 1 ? "was" : "were"} already there.` : ""}`, "ok");
    } catch (error) {
      shell.notify(/** @type {Error} */ (error).message, "error");
    }
  }

  /** @param {string} id */
  async function select(id) {
    if (selected === id) return;
    if (!(await canLeave())) return;
    selected = id;
    markSelected(list, id);
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
      mediaBase: `${base}/media`,
      picturesBase: `${base}/questions/${encodeURIComponent(id)}/pictures`,
      onPictureChanged: () => void reload(),
      notify: shell.notify,
      save: async (input, version) => {
        const result = await put(`${base}/questions/${encodeURIComponent(id)}`, { input, expectVersion: version });
        return result;
      },
      dismiss: (payload) => post(`${base}/questions/${encodeURIComponent(id)}/dismiss`, payload),
      onSaved: () => void reload(),
      actions: [
        ...((bank.folders ?? []).length > 0 ? [folderPicker(id, loaded.folderId ?? "")] : []),
        h("button", { type: "button", text: "Duplicate", on: { click: () => void duplicate(id) } }),
        h("button", { type: "button", class: "danger", text: "Delete…", on: { click: () => void removeQuestion(id) } }),
      ],
    });
    detail.append(editor.element);
  }

  /**
   * Where the question is filed. Filing is not an edit of the question, so it is done as soon as it is chosen and is not held for Save.
   * @param {string} id
   * @param {string} current
   */
  function folderPicker(id, current) {
    const select = h("select", { id: "question-folder" }, h("option", { value: "", text: "Not in a folder", selected: current === "" }), ...folderChoices(current, new Set(), false));
    let was = current;
    select.addEventListener("change", async () => {
      const wanted = select.value;
      try {
        await post(`${base}/questions/${encodeURIComponent(id)}/folder`, { folderId: wanted || null });
        was = wanted;
        await reload();
        shell.notify(wanted ? `Put in the folder "${folderName(wanted)}".` : "Taken out of its folder.", "ok");
      } catch (error) {
        select.value = was;
        shell.notify(/** @type {Error} */ (error).message, "error");
      }
    });
    return h("div", { class: "field inline" }, h("label", { for: "question-folder", text: "Folder" }), select);
  }

  /**
   * Check the whole bank for notes about its writing and accessibility, and show what was found in the pane where a question
   * would be. The notes themselves are on the questions, in the editor, where they can be dismissed one at a time.
   */
  async function checkQuality() {
    if (!(await canLeave())) return;
    try {
      const result = await post(`${base}/quality`);
      // A person may have started changing a question while the check ran. The notes are written to the questions either way, but
      // the results would replace the pane the change is in, so they wait for the person to ask again.
      if (editor?.isDirty()) {
        shell.notify("The check is done and its notes are on the questions. Your unsaved change was left alone: save it or discard it, then press Check quality to see the results.", "ok");
        await reload();
        return;
      }
      selected = null;
      // The results are about the whole bank, and name questions by their place in it, so the list is the whole bank.
      query = "";
      type = "";
      check = "";
      filters = {};
      hideRetired = false;
      folder = "";
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
   * The folders of the bank, in the pane where a question would be: make one, rename one, put one inside another, show its questions,
   * take one away. A folder is a way of finding questions and never holds one: taking a folder away keeps its questions.
   */
  async function showFolders() {
    if (!(await canLeave())) return;
    selected = null;
    renderList();
    drawFolders();
  }

  /** @param {string} [focusKey] the control to put the focus on when the panel is drawn again ("name", or a control's data-key); the heading when none */
  function drawFolders(focusKey) {
    // Drawn after a request: a person may have started changing a question while it ran, and the panel would replace the change.
    if (editor?.isDirty()) return;
    hold();
    /** @type {any[]} */
    const list = bank.folders ?? [];
    const heading = h("h2", { text: "Folders", attrs: { tabindex: "-1" } });
    const panel = h("section", { class: "card folders" }, heading);
    panel.append(h("p", { class: "sub", text: "A folder is a way of finding questions. A question is in one folder at a time, and taking a folder away keeps its questions in the bank, in no folder." }));

    const nameInput = h("input", { type: "text", id: "folder-name", autocomplete: "off", spellcheck: true, attrs: { maxlength: "80" } });
    const inside = h("select", { id: "folder-inside" }, h("option", { value: "", text: "At the top of the bank" }), ...folderChoices(""));
    const form = h(
      "form",
      { class: "folder-form" },
      h("div", { class: "field" }, h("label", { for: "folder-name", class: "field-label", text: "New folder" }), nameInput),
      h("div", { class: "field" }, h("label", { for: "folder-inside", class: "field-label", text: "Inside" }), inside),
      h("button", { type: "submit", class: "primary", text: "Add folder" }),
    );
    form.addEventListener("submit", (/** @type {Event} */ event) => {
      event.preventDefault();
      void addFolder(nameInput.value, inside.value);
    });
    panel.append(form);

    if (list.length === 0) {
      panel.append(h("p", { class: "hint", text: "This bank has no folders yet." }));
    } else {
      const tree = h("ul", { class: "folder-tree", attrs: { "aria-label": "Folders" } });
      for (const f of list) {
        const move = h(
          "select",
          { attrs: { "aria-label": `Put the folder ${f.name} inside`, "data-key": `move-${f.id}` } },
          h("option", { value: "", text: "At the top of the bank", selected: !f.parentId }),
          ...folderChoices(f.parentId ?? "", folderAndInside(f.id)),
        );
        move.addEventListener("change", () => void moveFolder(f, move.value));
        tree.append(
          h(
            "li",
            { class: `depth-${Math.min(f.depth, 6)}` },
            h("span", { class: "folder-name", text: f.name }),
            h("span", { class: "folder-count", text: `${plural(f.own, "question", "questions")}${f.total !== f.own ? `, ${f.total} with the folders inside` : ""}` }),
            h(
              "span",
              { class: "folder-actions" },
              h("button", { type: "button", class: "small-button", text: "Show", attrs: { "aria-label": `Show the questions in ${f.name}` }, on: { click: () => void showFolder(f.id) } }),
              h("button", { type: "button", class: "small-button", text: "Rename…", attrs: { "aria-label": `Rename the folder ${f.name}`, "data-key": `rename-${f.id}` }, on: { click: () => void renameFolder(f) } }),
              h("label", { class: "inline-select" }, "Inside ", move),
              h("button", { type: "button", class: "small-button danger", text: "Delete…", attrs: { "aria-label": `Delete the folder ${f.name}` }, on: { click: () => void deleteFolder(f) } }),
            ),
          ),
        );
      }
      panel.append(tree);
    }
    detail.append(panel);
    const target = focusKey === "name" ? nameInput : focusKey ? panel.querySelector(`[data-key="${CSS.escape(focusKey)}"]`) : null;
    /** @type {HTMLElement} */ (target ?? heading).focus();
  }

  /** @param {string} nameValue @param {string} parentId */
  async function addFolder(nameValue, parentId) {
    const wanted = nameValue.trim();
    if (wanted === "") {
      shell.notify("Give the folder a name.", "error");
      document.getElementById("folder-name")?.focus();
      return;
    }
    try {
      await post(`${base}/folders`, parentId ? { name: wanted, parentId } : { name: wanted });
      await reload();
      drawFolders("name");
      shell.notify(`Added the folder "${wanted}".`, "ok");
    } catch (error) {
      shell.notify(/** @type {Error} */ (error).message, "error");
      document.getElementById("folder-name")?.focus();
    }
  }

  /** @param {any} f */
  async function renameFolder(f) {
    const next = await askText("Rename this folder", "Name", f.name, "Rename");
    if (!next || next === f.name) return;
    try {
      await put(`${base}/folders/${encodeURIComponent(f.id)}`, { name: next });
      await reload();
      drawFolders(`rename-${f.id}`);
      shell.notify("Renamed.", "ok");
    } catch (error) {
      shell.notify(/** @type {Error} */ (error).message, "error");
    }
  }

  /** @param {any} f @param {string} parentId */
  async function moveFolder(f, parentId) {
    try {
      await put(`${base}/folders/${encodeURIComponent(f.id)}`, { parentId: parentId || null });
      await reload();
      shell.notify(parentId ? `Put "${f.name}" inside "${folderName(parentId)}".` : `Put "${f.name}" at the top of the bank.`, "ok");
    } catch (error) {
      shell.notify(/** @type {Error} */ (error).message, "error");
    }
    drawFolders(`move-${f.id}`);
  }

  /** @param {any} f */
  async function deleteFolder(f) {
    const holds = f.total > 0 ? ` ${plural(f.total, "question is", "questions are")} in it or in the folders inside it.` : "";
    const ok = await confirmAction(`Delete the folder "${f.name}"?`, `Its questions stay in the bank, in no folder, and the folders inside it move up one level.${holds}`, { yes: "Delete the folder", no: "Keep it", danger: true });
    if (!ok) return;
    try {
      const result = await del(`${base}/folders/${encodeURIComponent(f.id)}`);
      if (folder === f.id) folder = "";
      facetsKey = "";
      await reload();
      drawFolders();
      shell.notify(result.unfiled > 0 ? `Deleted the folder. ${plural(result.unfiled, "question is", "questions are")} in no folder now.` : "Deleted the folder.", "ok");
    } catch (error) {
      shell.notify(/** @type {Error} */ (error).message, "error");
    }
  }

  /** Narrows the list to a folder, and leaves the panel where it is. @param {string} id */
  async function showFolder(id) {
    folder = id;
    facetsKey = "";
    renderTools();
    await reload();
    shell.notify(`${plural(bank.questions.length, "question", "questions")} shown. Clear filters shows them all again.`, "ok");
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
    // The grid was asked for before a change could have been started in the pane it is drawn in.
    if (editor?.isDirty()) {
      shell.notify("Your unsaved change was left alone. Save it or discard it, then ask for the coverage again.", "ok");
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
    // The grid does not count a retired question, so the list a cell opens must not show one: the cell said 3 and the list said 4.
    hideRetired = true;
    folder = "";
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
        question: { id: "", version: 0, ...blank, verdict: "parsed", findings: [], formatted: [], locked: [], media: 0, math: 0, pictures: [], equations: [], tables: [] },
        saveLabel: "Add to the bank",
        notify: shell.notify,
        save: async (input) => {
          // Written while a folder is open, a question goes into it (and is not lost to the top of the bank, out of the list shown).
          const result = await post(`${base}/questions`, { input, folderId: folder && folder !== NONE ? folder : undefined });
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
