// @ts-check
/**
 * Answer sheets for a bank: tests assembled from its questions, the paper that goes with a test (the answer sheet, a booklet and an
 * answer key for each version), a check that a printed sheet is true to size, and the way into scoring a class.
 *
 * A test keeps a copy of its questions as they were used, so editing the bank afterwards never changes a test already given.
 */

import { get, post, del } from "./api.js";
import { confirmAction } from "./dialogs.js";
import { clear, h, plural, put, TYPE_NAMES, when } from "./dom.js";
import { fileButtons } from "./files.js";
import { sendForCheck } from "./scan.js";

/** The kinds of question a bubble can carry. */
const ON_SHEET = new Set(["multipleChoice", "multipleResponse", "trueFalse"]);

/**
 * @param {HTMLElement} host
 * @param {{ name: string }} params
 * @param {{ notify: (message: string, kind?: "ok" | "error") => void, go: (hash: string) => void }} shell
 */
export async function renderSheets(host, params, shell) {
  const bankName = params.name;
  const base = `sheets/${encodeURIComponent(bankName)}`;
  const tell = (/** @type {unknown} */ error) => shell.notify(error instanceof Error ? error.message : "That did not work.", "error");

  /** @type {any} */
  let listing = await get(`${base}/tests`);
  /** @type {any} */
  let bank = await get(`banks/${encodeURIComponent(bankName)}`);
  /** @type {any} */
  let saved = await get("scores");

  clear(host);
  const testsHost = h("div", { attrs: { "aria-live": "polite" } });
  const printHost = h("div", { attrs: { "aria-live": "polite" } });
  const checkHost = h("div", { attrs: { "aria-live": "polite" } });
  const savedHost = h("div", { attrs: { "aria-live": "polite" } });
  const makeHost = h("div");

  host.append(
    h(
      "div",
      { class: "export" },
      h(
        "div",
        { class: "page-head" },
        h("div", null, h("h1", { text: `Answer sheets for ${bank.title}` }), h("p", { class: "sub", text: "Make a test from this bank, print its answer sheet and booklets, and score a class of sheets from scans or photographs." })),
        h("div", { class: "head-actions" }, h("a", { class: "button", href: `#/bank/${encodeURIComponent(bankName)}`, text: "Back to the bank" })),
      ),
      testsHost,
      printHost,
      checkHost,
      savedHost,
      makeHost,
    ),
  );

  // -------------------------------------------------------------------------------------------------------------------------
  // The tests in this bank

  function renderTests() {
    clear(testsHost);
    const tests = listing.tests;
    put(
      testsHost,
      h(
        "section",
        { class: "panel" },
        h("h2", { text: "Tests in this bank" }),
        tests.length === 0 ? h("p", { class: "sub", text: "There is no test yet. Make one below from the questions in this bank." }) : null,
        ...tests.map(/** @param {any} t */ (t) =>
          h(
            "div",
            { class: "test-row" },
            h(
              "div",
              { class: "test-main" },
              h("h3", { text: t.name }),
              h("p", { class: "sub", text: `${plural(t.questions, "question", "questions")}, ${t.points} ${t.points === 1 ? "point" : "points"}, ${t.versions.length === 1 ? "one version" : `versions ${t.versions.join(", ")}`}. Made ${when(t.created)}. Sheet code ${t.fingerprint}.` }),
            ),
            h(
              "div",
              { class: "card-actions" },
              h("button", { type: "button", class: "primary", text: "Score a class…", on: { click: () => void score(t) } }),
              h("button", { type: "button", text: "Print…", on: { click: () => showPrint(t) } }),
              h("button", { type: "button", text: "Check my printing…", on: { click: () => showCheck(t) } }),
              h("button", { type: "button", class: "danger", text: "Remove…", on: { click: () => void remove(t) } }),
            ),
          ),
        ),
        listing.figures.length > 0
          ? h(
              "details",
              { class: "more" },
              h("summary", { text: `Class figures kept in this bank (${listing.figures.length})` }),
              h("p", { class: "sub", text: "Each is a test given to a class: its day, how many sheets, and for each question how hard it was and how well it told the strong from the weak. No sheet, name or answer of any student is in them." }),
              h("ul", null, ...listing.figures.map(/** @param {any} f */ (f) => h("li", { text: `${f.test}, ${f.date}: ${plural(f.sheets, "sheet", "sheets")}` }))),
            )
          : null,
      ),
    );
  }

  /** @param {any} t */
  async function score(t) {
    try {
      const view = await post(`${base}/tests/${t.id}/score`);
      shell.go(`#/score/${view.id}`);
    } catch (error) {
      tell(error);
    }
  }

  /** @param {any} t */
  async function remove(t) {
    const yes = await confirmAction("Remove this test?", `"${t.name}" is taken out of the bank. Its questions stay in the bank. Scores you saved for it are kept, but cannot be opened again until a test with the same record is back.`, { yes: "Remove", danger: true });
    if (!yes) return;
    try {
      await del(`${base}/tests/${t.id}`);
      listing = await get(`${base}/tests`);
      clear(printHost);
      clear(checkHost);
      renderTests();
      shell.notify("The test is removed.", "ok");
    } catch (error) {
      tell(error);
    }
  }

  // -------------------------------------------------------------------------------------------------------------------------
  // Printing the paper for a test

  /** @param {any} t */
  function showPrint(t) {
    clear(printHost);
    clear(checkHost);
    const several = t.versions.length > 1;
    const s = { paper: "letter", large: false, sheet: "shared", booklets: true, keys: true, pdf: true, docx: false, nameBox: true };
    const writtenHost = h("div", { attrs: { "aria-live": "polite" } });
    const make = h("button", { type: "button", class: "primary", text: "Make the files" });

    /**
     * @param {string} name
     * @param {string} value
     * @param {string} label
     * @param {string} hint
     */
    const radio = (name, value, label, hint) => {
      const id = `sheet-${value}`;
      const input = h("input", { type: "radio", name, id, value, checked: s.sheet === value });
      input.addEventListener("change", () => (s.sheet = value));
      return h("div", { class: "choice" }, input, h("label", { for: id }, h("span", { text: label }), h("span", { class: "hint", text: hint })));
    };
    /**
     * @param {string} id
     * @param {string} label
     * @param {boolean} on
     * @param {(v: boolean) => void} set
     * @param {string} [hint]
     */
    const tick = (id, label, on, set, hint) => {
      const box = h("input", { type: "checkbox", id, checked: on });
      box.addEventListener("change", () => set(box.checked));
      return h("div", { class: "check" }, box, h("label", { for: id }, h("span", { text: label }), hint ? h("span", { class: "hint", text: hint }) : null));
    };
    const paper = h("select", { id: "sheet-paper" }, h("option", { value: "letter", text: "Letter (US)", selected: true }), h("option", { value: "a4", text: "A4" }));
    paper.addEventListener("change", () => (s.paper = paper.value));

    make.addEventListener("click", async () => {
      if (!s.pdf && !s.docx && (s.booklets || s.keys)) {
        shell.notify("Choose PDF or Word for the booklets and keys.", "error");
        return;
      }
      make.disabled = true;
      try {
        const result = await post(`${base}/tests/${t.id}/print`, {
          paper: s.paper,
          large: s.large,
          sheet: s.sheet,
          booklets: s.booklets,
          keys: s.keys,
          nameBox: s.nameBox,
          formats: [...(s.pdf ? ["pdf"] : []), ...(s.docx ? ["docx"] : [])].length > 0 ? [...(s.pdf ? ["pdf"] : []), ...(s.docx ? ["docx"] : [])] : ["pdf"],
        });
        clear(writtenHost);
        put(
          writtenHost,
          h(
            "div",
            { class: "written" },
            h("h3", { text: result.written.length === 1 ? "The file is made" : "The files are made" }),
            h("p", { class: "sub", text: "They are in the Exports folder inside your OpenAssess folder. Nothing already there was written over. Print the answer sheet at 100 percent (actual size), not fit to page." }),
            ...result.written.map(/** @param {any} file */ (file) =>
              h(
                "div",
                { class: "file-row" },
                h("span", { class: "file-name", text: file.name }),
                h("span", { class: "meta", text: `${file.kind === "sheet" ? "Answer sheet" : file.kind === "key" ? "Answer key" : "Student booklet"}${file.pages ? `, ${plural(file.pages, "page", "pages")}` : ""}` }),
                ...fileButtons(file, shell),
              ),
            ),
          ),
          result.notes.length > 0 ? h("div", { class: "note-group" }, h("h3", { text: "To know" }), h("ul", { class: "general" }, ...result.notes.map(/** @param {string} n */ (n) => h("li", { text: n })))) : null,
          result.unprinted.length > 0 ? h("div", { class: "note-group" }, h("h3", { text: "Not printed" }), h("ul", { class: "general" }, ...result.unprinted.map(/** @param {string} n */ (n) => h("li", { text: n })))) : null,
        );
        shell.notify(`Made ${plural(result.written.length, "file", "files")}.`, "ok");
      } catch (error) {
        tell(error);
      } finally {
        make.disabled = false;
      }
    });

    const heading = h("h2", { text: `Print ${t.name}`, tabIndex: -1 });
    put(
      printHost,
      h(
        "section",
        { class: "panel" },
        heading,
        h("p", { class: "sub", text: "The answer sheet is what students mark. The booklet holds the questions, with no answers on it. The key shows the right answer in the order each version prints." }),
        h("fieldset", { class: "panel" }, h("legend", { text: "The answer sheet" }),
          radio("sheet", "shared", several ? "One sheet for every version" : "An answer sheet", several ? "Each student fills in the bubble for their version." : "Bubbles for the questions that can be answered with a bubble."),
          several ? radio("sheet", "each", "A sheet for each version", "The version is printed on it, and a student has nothing to fill in.") : null,
          radio("sheet", "none", "No answer sheet", "Only the booklets and keys; students answer in the booklet."),
          h("div", { class: "grid" }, h("div", { class: "field small" }, h("label", { for: "sheet-paper", class: "field-label", text: "Paper" }), paper)),
          tick("sheet-large", "Large print", false, (v) => (s.large = v), "Bigger bubbles and writing, five answers to a question at most."),
          tick("sheet-name", "A box for the student's name", true, (v) => (s.nameBox = v)),
        ),
        h("fieldset", { class: "panel" }, h("legend", { text: "Booklets and keys" }),
          tick("sheet-booklets", "A student booklet for each version", true, (v) => (s.booklets = v), "Questions only. No answer is shown anywhere."),
          tick("sheet-keys", "An answer key for each version", true, (v) => (s.keys = v), "With the right letters in a line, for marking by hand."),
          tick("sheet-pdf", "As PDF", true, (v) => (s.pdf = v)),
          tick("sheet-docx", "As Word", false, (v) => (s.docx = v), "Can be edited before it is printed."),
        ),
        h("div", { class: "editor-actions" }, make),
        writtenHost,
      ),
    );
    heading.scrollIntoView({ block: "start" });
    heading.focus({ preventScroll: true });
  }

  // -------------------------------------------------------------------------------------------------------------------------
  // Check my printing

  /** @param {any} t */
  function showCheck(t) {
    clear(checkHost);
    clear(printHost);
    const result = h("div", { attrs: { "aria-live": "polite" } });
    const input = h("input", { type: "file", id: "check-file", accept: ".png,.jpg,.jpeg,.pdf,image/*,application/pdf" });
    input.addEventListener("change", async () => {
      const file = input.files?.[0];
      if (!file) return;
      clear(result);
      put(result, h("p", { class: "sub", text: "Checking…" }));
      try {
        const outcome = await sendForCheck(`${base}/tests/${t.id}/printing-check`, file);
        clear(result);
        put(
          result,
          h("p", { class: outcome.ok ? "written" : "problem", text: outcome.ok ? "The printing is fine: a blank copy reads as blank, and the sheet is the size it was made." : "There is something to put right before this sheet is used for a class." }),
          h("ul", { class: "general" }, ...outcome.found.map(/** @param {string} line */ (line) => h("li", { text: line }))),
          outcome.problems.length > 0 ? h("div", { class: "note-group" }, h("h3", { text: "To put right" }), h("ul", null, ...outcome.problems.map(/** @param {string} p */ (p) => h("li", { text: p })))) : null,
        );
      } catch (error) {
        clear(result);
        put(result, h("p", { class: "problem", text: error instanceof Error ? error.message : "That could not be checked." }));
      }
      input.value = "";
    });
    const heading = h("h2", { text: `Check the printing of ${t.name}`, tabIndex: -1 });
    put(
      checkHost,
      h(
        "section",
        { class: "panel" },
        heading,
        h("p", { class: "sub", text: "Print the answer sheet, scan one blank copy on the scanner you will use for the class, and choose the scan here. This tells you whether the sheet printed at its true size and whether the reader can use what your printer and scanner make, before a class of sheets depends on it." }),
        h("div", { class: "field" }, h("label", { for: "check-file", class: "field-label", text: "A scan of one blank printed copy (PNG, JPG or PDF)" }), input),
        result,
      ),
    );
    heading.scrollIntoView({ block: "start" });
    heading.focus({ preventScroll: true });
  }

  // -------------------------------------------------------------------------------------------------------------------------
  // Saved scores

  function renderSaved() {
    clear(savedHost);
    const files = saved.files;
    const upload = h("input", { type: "file", id: "scores-file", accept: ".openassess-scores" });
    upload.addEventListener("change", async () => {
      const file = upload.files?.[0];
      if (!file) return;
      try {
        const view = await post(`scoring/open?upload=1`, new Uint8Array(await file.arrayBuffer()));
        shell.go(`#/score/${view.id}`);
      } catch (error) {
        tell(error);
      }
      upload.value = "";
    });
    put(
      savedHost,
      h(
        "section",
        { class: "panel" },
        h("h2", { text: "Saved scores" }),
        h("p", { class: "sub", text: "Scores you saved, in the Scores folder inside your OpenAssess folder. A scores file holds each sheet's readings and what you decided, and no name, no file name and no picture. Opening one brings the scores back, and a new answer key or an adjustment needs no new scan." }),
        files.length === 0 ? h("p", { class: "sub", text: "Nothing is saved yet." }) : null,
        ...files.map(/** @param {any} f */ (f) =>
          h(
            "div",
            { class: "file-row" },
            h("span", { class: "file-name", text: f.name }),
            h("span", { class: "meta", text: f.problem ? "Cannot be read" : `${f.test}, ${plural(f.sheets, "sheet", "sheets")}, saved ${when(f.modified)}` }),
            f.problem
              ? h("span", { class: "problem", text: f.problem })
              : h("button", { type: "button", text: "Open", on: { click: () => void open(f.name) } }),
          ),
        ),
        h("div", { class: "field" }, h("label", { for: "scores-file", class: "field-label", text: "Open a scores file from somewhere else" }), upload),
      ),
    );
  }

  /** @param {string} name */
  async function open(name) {
    try {
      const view = await post("scoring/open", { name, bank: bankName });
      shell.go(`#/score/${view.id}`);
    } catch (error) {
      // The scores may belong to a test in another bank; the server looks in every bank when this one does not hold it.
      try {
        const view = await post("scoring/open", { name });
        shell.go(`#/score/${view.id}`);
      } catch {
        tell(error);
      }
    }
  }

  // -------------------------------------------------------------------------------------------------------------------------
  // Making a test

  const questions = /** @type {any[]} */ (bank.questions);
  const chosen = new Set();
  let filter = "";
  let withRetired = false;

  function renderMake() {
    clear(makeHost);
    // The search box is made new each time, empty; the word it held last time must not go on narrowing a list nobody can see it for.
    filter = "";
    const name = h("input", { type: "text", id: "make-name", value: bank.title, autocomplete: "off", spellcheck: true });
    const versions = h("select", { id: "make-versions" }, ...[1, 2, 3, 4].map((n) => h("option", { value: String(n), text: n === 1 ? "One version" : `${n} versions` })));
    const order = h("select", { id: "make-order" }, h("option", { value: "kept", text: "Keep the questions where they are; reorder the answers" }), h("option", { value: "shuffled", text: "Shuffle the questions as well as the answers" }));
    const orderField = h("div", { class: "field", hidden: true }, h("label", { for: "make-order", class: "field-label", text: "Versions B to D" }), order);
    versions.addEventListener("change", () => {
      orderField.hidden = versions.value === "1";
    });
    const summary = h("p", { class: "sub", attrs: { "aria-live": "polite" } });
    const list = h("ul", { class: "pick", attrs: { "aria-label": "Questions to put in the test" } });
    const search = h("input", { type: "search", id: "make-search", placeholder: "Find a question", autocomplete: "off", attrs: { "aria-label": "Find a question" } });
    search.addEventListener("input", () => {
      filter = search.value.trim().toLowerCase();
      fill();
    });
    const retired = h("input", { type: "checkbox", id: "make-retired", checked: withRetired });
    retired.addEventListener("change", () => {
      withRetired = retired.checked;
      fill();
    });

    const visible = () => questions.filter((q) => (withRetired || q.status !== "retired") && (filter === "" || `${q.snippet} ${q.title}`.toLowerCase().includes(filter)));

    function count() {
      const picked = questions.filter((q) => chosen.has(q.id));
      const bubbles = picked.filter((q) => ON_SHEET.has(q.type)).length;
      summary.textContent = picked.length === 0 ? "No question chosen yet." : `${plural(picked.length, "question", "questions")} chosen; ${bubbles} can be answered with a bubble${picked.length - bubbles > 0 ? `, and ${picked.length - bubbles} are answered in the booklet` : ""}.`;
      go.disabled = picked.length === 0;
    }

    function fill() {
      clear(list);
      const shown = visible();
      if (shown.length === 0) put(list, h("li", { class: "empty", text: questions.length === 0 ? "This bank has no questions yet." : "No question matches." }));
      for (const q of shown) {
        const id = `pick-${q.id}`;
        const box = h("input", { type: "checkbox", id, checked: chosen.has(q.id) });
        box.addEventListener("change", () => {
          if (box.checked) chosen.add(q.id);
          else chosen.delete(q.id);
          count();
        });
        put(
          list,
          h(
            "li",
            { class: "pick-row" },
            box,
            h("label", { for: id }, h("span", { class: "qtop" }, h("span", { class: "type", text: /** @type {any} */ (TYPE_NAMES)[q.type] ?? q.type }), ON_SHEET.has(q.type) ? null : h("span", { class: "tag", text: "Booklet only" }), q.status !== "draft" ? h("span", { class: "tag", text: q.status }) : null), h("span", { class: "peek", text: q.snippet || q.title })),
          ),
        );
      }
      count();
    }

    // Pick for me: some number of the questions that have a chapter, an objective and so on, chosen at random and added to the ones
    // chosen. Pressed again with another value, it builds a test chapter by chapter. The person still sees every question and can
    // take any out.
    const PICK_AXES = [["objective", "objective"], ["chapter", "chapter"], ["section", "section"], ["tag", "tag"], ["bloom", "Bloom level"], ["difficulty", "difficulty"], ["type", "kind of question"]];
    const pickCount = h("input", { type: "number", id: "pick-count", value: "5", attrs: { min: "1", max: "1000", inputmode: "numeric" } });
    const pickAxis = h("select", { id: "pick-axis" }, ...PICK_AXES.map(([axis, name]) => h("option", { value: axis, text: name })));
    const pickValue = h("select", { id: "pick-value" });
    const pickNote = h("p", { class: "sub", attrs: { "aria-live": "polite" } });
    const valuesOf = (/** @type {string} */ axis) => /** @type {Array<{ value: string, count: number }>} */ (bank.facets?.[axis] ?? []);
    function fillValues() {
      clear(pickValue);
      const choices = valuesOf(pickAxis.value);
      if (choices.length === 0) put(pickValue, h("option", { value: "", text: "No values" }));
      for (const c of choices) put(pickValue, h("option", { value: c.value, text: c.value === "(none)" ? "Not set" : pickAxis.value === "type" ? /** @type {any} */ (TYPE_NAMES)[c.value] ?? c.value : c.value }));
    }
    pickAxis.addEventListener("change", fillValues);
    fillValues();
    const pickGo = h("button", { type: "button", text: "Choose them" });
    pickGo.addEventListener("click", async () => {
      if (pickValue.value === "") {
        pickNote.textContent = "There is nothing to pick from: no question has a value for that.";
        return;
      }
      pickGo.disabled = true;
      try {
        const result = await post(`${base}/pick`, { axis: pickAxis.value, value: pickValue.value, count: Number(pickCount.value), chosen: [...chosen] });
        for (const id of result.ids) chosen.add(id);
        fill();
        const left = result.left;
        const why = [
          left.noKey > 0 ? `${plural(left.noKey, "had no usable answer key", "had no usable answer key")}` : "",
          left.alike > 0 ? `${plural(left.alike, "was a copy of a question already chosen", "were copies of questions already chosen")}` : "",
          left.chosen > 0 ? `${left.chosen} ${left.chosen === 1 ? "was" : "were"} already chosen` : "",
          left.retired > 0 ? `${left.retired} ${left.retired === 1 ? "was" : "were"} retired` : "",
        ].filter(Boolean);
        pickNote.textContent = `${result.ids.length === 0 ? "None chosen" : `Chose ${plural(result.ids.length, "question", "questions")}`}${result.ids.length < result.wanted ? ` of the ${result.wanted} asked for (${plural(result.candidates, "question was", "questions were")} free to pick)` : ""}.${why.length > 0 ? ` Left out: ${why.join("; ")}.` : ""}`;
      } catch (error) {
        tell(error);
      } finally {
        pickGo.disabled = false;
      }
    });
    const pickRow = h(
      "div",
      { class: "pick-for-me", attrs: { role: "group", "aria-label": "Pick questions for me" } },
      h("label", { for: "pick-count", text: "Pick" }),
      pickCount,
      h("label", { for: "pick-axis", text: "questions at random, by" }),
      pickAxis,
      h("label", { for: "pick-value", text: "being" }),
      pickValue,
      pickGo,
    );

    const all = h("button", { type: "button", text: "Choose all shown", on: { click: () => { for (const q of visible()) chosen.add(q.id); fill(); } } });
    const none = h("button", { type: "button", text: "Choose none", on: { click: () => { chosen.clear(); fill(); } } });
    const go = h("button", { type: "button", class: "primary", text: "Make the test", disabled: true });
    go.addEventListener("click", async () => {
      go.disabled = true;
      try {
        // The questions go in the order the bank lists them, which is the order they were written.
        const ids = questions.filter((q) => chosen.has(q.id)).map((q) => q.id);
        await post(`${base}/tests`, { name: name.value, questionIds: ids, versions: Number(versions.value), questionOrder: order.value });
        listing = await get(`${base}/tests`);
        chosen.clear();
        renderTests();
        renderMake();
        shell.notify("The test is made and kept in the bank.", "ok");
      } catch (error) {
        tell(error);
        go.disabled = false;
      }
    });

    put(
      makeHost,
      h(
        "section",
        { class: "panel" },
        h("h2", { text: "Make a test" }),
        h("p", { class: "sub", text: "Choose the questions. The test keeps a copy of each as it is now, so changing the bank later never changes a test already given. A question a bubble cannot carry (an essay, a short answer) keeps its number and is answered in the booklet." }),
        h("div", { class: "grid" }, h("div", { class: "field" }, h("label", { for: "make-name", class: "field-label", text: "Name of the test" }), name), h("div", { class: "field small" }, h("label", { for: "make-versions", class: "field-label", text: "Versions" }), versions)),
        orderField,
        pickRow,
        pickNote,
        h("div", { class: "pick-tools" }, search, all, none, h("div", { class: "check" }, retired, h("label", { for: "make-retired", text: "Include retired questions" }))),
        list,
        summary,
        h("div", { class: "editor-actions" }, go),
      ),
    );
    fill();
  }

  renderTests();
  renderSaved();
  renderMake();
  return {};
}
