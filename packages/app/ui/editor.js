// @ts-check
/**
 * The question editor: one question, in plain text, with what needs attention shown beside the part that needs it.
 *
 * It works on a copy. Nothing is sent until Save, and Save sends the whole question; the server keeps every field the
 * person did not change exactly as it was stored. A key is never filled in here either: a new answer row is not marked
 * right, and a true or false question starts with neither chosen.
 */

import { api, get } from "./api.js";
import { badge, clear, EDITABLE_TYPES, grow, h, put, SEVERITY_NAMES, TYPE_NAMES } from "./dom.js";
import { drawMath } from "./math.js";

/** The importer's errors about options it had to make up, which words written in the place of the placeholder replace. */
const WORDS_WRITTEN = new Set(["import.empty-option", "import.too-few-options", "import.no-options"]);

let counter = 0;

/**
 * @typedef {{ id: string, version: number, type: string, title: string, stem: string, points: number,
 *   feedback: { general: string, correct: string, incorrect: string },
 *   metadata: { status: string, difficulty: string, bloom: string, objective: string, chapter: string, section: string, page: string, tags: string[] },
 *   body: any, verdict: "parsed" | "needsReview" | "failed",
 *   findings: Array<{ index: number, code: string, severity: "error" | "warn" | "info", message: string, dismissed?: boolean, field?: string }>,
 *   formatted: string[], locked: string[], media: number, math: number, readOnly?: string, origin?: any,
 *   pictures: Array<{ id: string, number: number, file: string, alt: string, decorative: boolean, placed: boolean, width?: number, height?: number }>,
 *   equations?: Array<{ id: string, number: number, latex: string, mathml: string, placed: boolean }>,
 *   tables?: Array<{ number: number, text: string, rows: Array<Array<{ header: boolean, text: string, colspan: number, rowspan: number }>> }> }} EditorQuestion
 */

/**
 * The part of a question the server reads back.
 * @param {EditorQuestion} q
 */
function inputOf(q) {
  return structuredClone({
    type: q.type,
    title: q.title,
    stem: q.stem,
    points: q.points,
    feedback: q.feedback,
    metadata: q.metadata,
    body: q.body,
    // The descriptions of the pictures, sent back with the rest. A question with no pictures sends none.
    ...((q.pictures ?? []).length > 0 ? { pictures: q.pictures.map((p) => ({ id: p.id, alt: p.alt, decorative: p.decorative })) } : {}),
  });
}

/**
 * @param {{
 *   question: EditorQuestion,
 *   save: (input: any, version: number) => Promise<{ question: EditorQuestion, flattened?: string[], replaced?: Array<{ code: string, message: string }> }>,
 *   dismiss: (payload: { code?: string, all?: boolean }) => Promise<{ question: EditorQuestion }>,
 *   saveLabel?: string,
 *   onChange?: (dirty: boolean) => void,
 *   onSaved?: (question: EditorQuestion, flattened: string[]) => void,
 *   notify: (message: string, kind?: "ok" | "error") => void,
 *   actions?: Node[],
 *   mediaBase?: string,
 *   picturesBase?: string,
 *   onPictureChanged?: (result: any) => void,
 * }} options  `mediaBase` is the address (after /api/) that a picture's name is added to, to show it: banks/<name>/media or sessions/<id>/media. `picturesBase` is the question's own address for adding, replacing and removing a picture (.../questions/<id>/pictures), absent when the question is not saved yet.
 */
export function createEditor(options) {
  const id = `ed${++counter}`;
  const element = h("div", { class: "editor" });
  /** @type {EditorQuestion} */
  let question = options.question;
  let original = inputOf(question);
  let draft = inputOf(question);
  let saving = false;

  const isDirty = () => JSON.stringify(draft) !== JSON.stringify(original);

  /** @type {HTMLButtonElement} */
  let saveButton;
  /** @type {HTMLElement} */
  let dirtyNote;
  /** @type {HTMLElement} */
  let bodyHost;
  /** @type {HTMLElement} */
  let checksHost;

  function touch() {
    const dirty = isDirty();
    if (saveButton) saveButton.disabled = !dirty || saving || Boolean(question.readOnly);
    if (dirtyNote) dirtyNote.textContent = dirty ? "You have changes that are not saved." : "";
    options.onChange?.(dirty);
  }

  /** @param {string} where */
  const isLocked = (where) => question.locked.includes(where);

  // -------------------------------------------------------------------------
  // Small pieces
  // -------------------------------------------------------------------------

  /**
   * @param {string} label
   * @param {string} value
   * @param {(value: string) => void} onInput
   * @param {{ rows?: number, locked?: boolean, hint?: string, placeholder?: string }} [more]
   */
  function textArea(label, value, onInput, more = {}) {
    const fieldId = `${id}-${++counter}`;
    const area = h("textarea", { id: fieldId, value, rows: more.rows ?? 2, readOnly: Boolean(more.locked), placeholder: more.placeholder ?? "", spellcheck: true });
    area.addEventListener("input", () => {
      onInput(area.value);
      grow(area);
      touch();
    });
    requestAnimationFrame(() => grow(area));
    return h(
      "div",
      { class: "field" },
      h("label", { for: fieldId, class: "field-label", text: label }),
      area,
      more.locked ? h("p", { class: "hint", text: "This text refers to a picture or an equation that this question does not have, so it cannot be edited here. It is kept as it is." }) : null,
      more.hint ? h("p", { class: "hint", text: more.hint }) : null,
    );
  }

  /**
   * @param {string} label
   * @param {string} value
   * @param {(value: string) => void} onInput
   * @param {{ type?: string, small?: boolean, locked?: boolean, min?: number, max?: number, step?: number | string }} [more]
   */
  function textInput(label, value, onInput, more = {}) {
    const fieldId = `${id}-${++counter}`;
    const input = h("input", { id: fieldId, type: more.type ?? "text", value, readOnly: Boolean(more.locked), autocomplete: "off", spellcheck: more.type === undefined, min: more.min, max: more.max, step: more.step });
    input.addEventListener("input", () => {
      onInput(input.value);
      touch();
    });
    return h("div", { class: more.small ? "field small" : "field" }, h("label", { for: fieldId, class: "field-label", text: label }), input);
  }

  /**
   * @param {string} label
   * @param {boolean} checked
   * @param {(checked: boolean) => void} onChange
   */
  function checkbox(label, checked, onChange) {
    const fieldId = `${id}-${++counter}`;
    const box = h("input", { id: fieldId, type: "checkbox", checked });
    box.addEventListener("change", () => {
      onChange(box.checked);
      touch();
    });
    return h("div", { class: "check" }, box, h("label", { for: fieldId, text: label }));
  }

  /**
   * @param {string} label
   * @param {Array<[string, string]>} choices
   * @param {string} value
   * @param {(value: string) => void} onChange
   * @param {{ small?: boolean }} [more]
   */
  function select(label, choices, value, onChange, more = {}) {
    const fieldId = `${id}-${++counter}`;
    const control = h("select", { id: fieldId }, ...choices.map(([v, text]) => h("option", { value: v, text, selected: v === value })));
    control.addEventListener("change", () => onChange(control.value));
    return h("div", { class: more.small ? "field small" : "field" }, h("label", { for: fieldId, class: "field-label", text: label }), control);
  }

  /**
   * The buttons at the end of a row in a list: up, down, remove.
   * @param {any[]} list
   * @param {number} at
   * @param {string} what
   * @param {() => void} rerender
   * @param {{ minimum?: number, move?: boolean }} [more]
   */
  function rowButtons(list, at, what, rerender, more = {}) {
    /** @param {number} to */
    const move = (to) => {
      const [item] = list.splice(at, 1);
      list.splice(to, 0, item);
      rerender();
      touch();
    };
    return h(
      "div",
      { class: "row-buttons" },
      more.move === false
        ? null
        : h("button", { type: "button", class: "icon", title: `Move ${what} up`, "attrs": { "aria-label": `Move ${what} up` }, text: "↑", disabled: at === 0, on: { click: () => move(at - 1) } }),
      more.move === false
        ? null
        : h("button", { type: "button", class: "icon", title: `Move ${what} down`, "attrs": { "aria-label": `Move ${what} down` }, text: "↓", disabled: at === list.length - 1, on: { click: () => move(at + 1) } }),
      h("button", {
        type: "button",
        class: "icon",
        title: `Remove ${what}`,
        attrs: { "aria-label": `Remove ${what}` },
        text: "✕",
        disabled: list.length <= (more.minimum ?? 0),
        on: {
          click: () => {
            list.splice(at, 1);
            rerender();
            touch();
          },
        },
      }),
    );
  }

  /** @param {string[]} lines */
  const joinLines = (lines) => lines.join("\n");
  /** @param {string} text */
  const splitLines = (text) => text.split(/\r?\n/);

  // -------------------------------------------------------------------------
  // The part of the question that depends on its type
  // -------------------------------------------------------------------------

  function renderChoice() {
    const multiple = draft.type === "multipleResponse";
    const options = draft.body.options;
    const marked = options.filter(/** @param {any} o */ (o) => o.correct).length;
    const list = h("ol", { class: "rows", attrs: { "aria-label": "Answers" } });
    options.forEach(/** @param {any} option @param {number} i */ (option, i) => {
      const textId = `${id}-o${i}-${++counter}`;
      const input = h("textarea", { id: textId, value: option.text, rows: 1, readOnly: isLocked(`options.${i}`), spellcheck: true, attrs: { "aria-label": `Answer ${i + 1}` } });
      input.addEventListener("input", () => {
        option.text = input.value;
        grow(input);
        touch();
      });
      requestAnimationFrame(() => grow(input));
      const right = h("input", { type: "checkbox", checked: option.correct, id: `${textId}-right`, attrs: { "aria-label": `Answer ${i + 1} is right` } });
      right.addEventListener("change", () => {
        option.correct = right.checked;
        // A single-answer question has one right answer: marking one clears the others, which is the person's choice, not a guess.
        if (!multiple && right.checked) for (const other of options) if (other !== option) other.correct = false;
        renderBody();
        touch();
      });
      list.append(
        h(
          "li",
          { class: option.correct ? "row right" : "row" },
          h("span", { class: "letter", text: String.fromCharCode(65 + (i % 26)) }),
          h("label", { class: "tick", for: `${textId}-right` }, right, h("span", { text: "Right" })),
          input,
          rowButtons(options, i, `answer ${i + 1}`, renderBody),
        ),
      );
    });
    const notes = [];
    if (marked === 0) notes.push("No answer is marked right, so this question cannot be scored until one is.");
    if (!multiple && marked > 1) notes.push(`${marked} answers are marked right on a single-answer question. Keep one, or change the type to Multiple response.`);
    put(
      bodyHost,
      h("div", { class: "field" }, h("span", { class: "field-label", text: multiple ? "Answers (tick every right one)" : "Answers (tick the right one)" }), list),
      notes.length > 0 ? h("p", { class: "problem", role: "status" }, ...notes.map((n) => h("span", { text: n }))) : null,
      h("button", { type: "button", class: "small-button", text: "Add an answer", on: { click: () => { options.push({ text: "", correct: false, feedback: "" }); renderBody(); touch(); } } }),
      checkbox("Mix the answers up when the question is shown", draft.body.shuffle !== false, (v) => (draft.body.shuffle = v)),
      multiple ? checkbox("Give part of the points for part of the answer", draft.body.partialCredit !== false, (v) => (draft.body.partialCredit = v)) : null,
    );
  }

  function renderTrueFalse() {
    const name = `${id}-tf`;
    const current = draft.body.correct;
    /** @param {string} label @param {boolean} value */
    const radio = (label, value) => {
      const radioId = `${name}-${label}`;
      const input = h("input", { type: "radio", name, id: radioId, checked: current === value });
      input.addEventListener("change", () => {
        draft.body.correct = value;
        renderBody();
        touch();
      });
      return h("div", { class: "check" }, input, h("label", { for: radioId, text: label }));
    };
    bodyHost.append(
      h("div", { class: "field" }, h("span", { class: "field-label", text: "The answer" }), radio("True", true), radio("False", false)),
      current === null || current === undefined
        ? h("p", { class: "problem", role: "status", text: "Neither is chosen, so this question cannot be scored until one is." })
        : h("button", { type: "button", class: "link", text: "Clear the answer", on: { click: () => { draft.body.correct = null; renderBody(); touch(); } } }),
    );
  }

  function renderBlanks() {
    const blanks = draft.body.blanks;
    const list = h("ol", { class: "rows" });
    blanks.forEach(/** @param {any} blank @param {number} i */ (blank, i) => {
      const labelId = `${id}-bl${i}-${++counter}`;
      const answers = h("textarea", { id: labelId, value: joinLines(blank.accepted), rows: 2, spellcheck: false, attrs: { "aria-label": `Answers accepted for blank ${i + 1}, one to a line` } });
      answers.addEventListener("input", () => {
        blank.accepted = splitLines(answers.value);
        grow(answers);
        touch();
      });
      requestAnimationFrame(() => grow(answers));
      const label = h("input", { type: "text", value: blank.label, autocomplete: "off", attrs: { "aria-label": `Name for blank ${i + 1}` }, placeholder: "Name (optional)" });
      label.addEventListener("input", () => {
        blank.label = label.value;
        touch();
      });
      list.append(h("li", { class: "row" }, h("span", { class: "letter", text: String(i + 1) }), h("div", { class: "grow-cell" }, label, answers), rowButtons(blanks, i, `blank ${i + 1}`, renderBody, { minimum: 1 })));
    });
    bodyHost.append(
      h("div", { class: "field" }, h("span", { class: "field-label", text: "What each blank accepts (one answer to a line)" }), list),
      h("button", { type: "button", class: "small-button", text: "Add a blank", on: { click: () => { blanks.push({ label: "", accepted: [] }); renderBody(); touch(); } } }),
      checkbox("Capital and small letters must match", draft.body.caseSensitive === true, (v) => (draft.body.caseSensitive = v)),
    );
  }

  function renderShort() {
    bodyHost.append(
      textArea("Answers that are accepted (one to a line)", joinLines(draft.body.accepted), (v) => (draft.body.accepted = splitLines(v)), { rows: 3 }),
      checkbox("Capital and small letters must match", draft.body.caseSensitive === true, (v) => (draft.body.caseSensitive = v)),
    );
  }

  function renderMatching() {
    const pairs = draft.body.pairs;
    const list = h("ol", { class: "rows" });
    pairs.forEach(/** @param {any} pair @param {number} i */ (pair, i) => {
      const left = h("input", { type: "text", value: pair.left, readOnly: isLocked(`pairs.${i}.left`), autocomplete: "off", attrs: { "aria-label": `Item ${i + 1}` } });
      left.addEventListener("input", () => {
        pair.left = left.value;
        touch();
      });
      const right = h("input", { type: "text", value: pair.right, autocomplete: "off", attrs: { "aria-label": `Match for item ${i + 1}` } });
      right.addEventListener("input", () => {
        pair.right = right.value;
        touch();
      });
      list.append(h("li", { class: "row pair" }, h("span", { class: "letter", text: String(i + 1) }), left, h("span", { class: "arrow", text: "matches" }), right, rowButtons(pairs, i, `pair ${i + 1}`, renderBody, { minimum: 1 })));
    });
    bodyHost.append(
      h("div", { class: "field" }, h("span", { class: "field-label", text: "Each item and what it matches" }), list),
      h("button", { type: "button", class: "small-button", text: "Add a pair", on: { click: () => { pairs.push({ left: "", right: "" }); renderBody(); touch(); } } }),
      textArea("Spare answers that match nothing (one to a line)", joinLines(draft.body.distractors), (v) => (draft.body.distractors = splitLines(v).filter((s) => s.trim() !== "")), { rows: 2 }),
    );
  }

  function renderOrdering() {
    const items = draft.body.items;
    const list = h("ol", { class: "rows" });
    items.forEach(/** @param {any} item @param {number} i */ (item, i) => {
      const input = h("input", { type: "text", value: item.text, readOnly: isLocked(`items.${i}`), autocomplete: "off", attrs: { "aria-label": `Item ${i + 1} in the right order` } });
      input.addEventListener("input", () => {
        item.text = input.value;
        touch();
      });
      list.append(h("li", { class: "row" }, h("span", { class: "letter", text: String(i + 1) }), input, rowButtons(items, i, `item ${i + 1}`, renderBody, { minimum: 1 })));
    });
    bodyHost.append(
      h("div", { class: "field" }, h("span", { class: "field-label", text: "The items, in the right order" }), list),
      h("button", { type: "button", class: "small-button", text: "Add an item", on: { click: () => { items.push({ text: "" }); renderBody(); touch(); } } }),
    );
  }

  function renderNumeric() {
    const body = draft.body;
    /** @param {string} v */
    const num = (v) => (v.trim() === "" ? null : Number(v));
    const fields = h("div", { class: "grid" });
    const show = () => {
      clear(fields);
      if (body.mode === "range") {
        fields.append(textInput("Lowest accepted", body.min ?? "", (v) => (body.min = num(v)), { type: "number", step: "any", small: true }), textInput("Highest accepted", body.max ?? "", (v) => (body.max = num(v)), { type: "number", step: "any", small: true }));
      } else {
        fields.append(textInput("The right value", body.value ?? "", (v) => (body.value = num(v)), { type: "number", step: "any", small: true }));
        if (body.mode === "tolerance") fields.append(textInput("Give or take", body.tolerance ?? "", (v) => (body.tolerance = num(v)), { type: "number", step: "any", small: true }));
      }
      fields.append(textInput("Units (optional)", body.units ?? "", (v) => (body.units = v), { small: true }));
    };
    show();
    bodyHost.append(
      select("What is accepted", [["exact", "One exact value"], ["tolerance", "A value, give or take"], ["range", "Anything between two values"]], body.mode ?? "exact", (v) => { body.mode = v; show(); touch(); }),
      fields,
    );
  }

  function renderEssay() {
    bodyHost.append(textArea("A model answer (optional; an essay is marked by a person)", draft.body.modelAnswer ?? "", (v) => (draft.body.modelAnswer = v), { rows: 4, locked: isLocked("modelAnswer") }));
  }

  function renderBody() {
    clear(bodyHost);
    if (question.readOnly) {
      bodyHost.append(h("p", { class: "problem", text: question.readOnly }));
      return;
    }
    switch (draft.type) {
      case "multipleChoice":
      case "multipleResponse":
        renderChoice();
        break;
      case "trueFalse":
        renderTrueFalse();
        break;
      case "fillInBlank":
        renderBlanks();
        break;
      case "shortAnswer":
        renderShort();
        break;
      case "matching":
        renderMatching();
        break;
      case "ordering":
        renderOrdering();
        break;
      case "numeric":
        renderNumeric();
        break;
      case "essay":
        renderEssay();
        break;
      default:
        break;
    }
  }

  // -------------------------------------------------------------------------
  // The checks the engine raised
  // -------------------------------------------------------------------------

  function renderChecks() {
    clear(checksHost);
    const live = question.findings.filter((f) => !f.dismissed);
    const dismissed = question.findings.filter((f) => f.dismissed);
    const notes = live.filter((f) => f.severity !== "error");
    if (live.length === 0 && dismissed.length === 0) return;
    checksHost.append(h("h2", { class: "checks-title", text: "Checks" }));
    const list = h("ul", { class: "findings" });
    for (const f of live) {
      list.append(
        h(
          "li",
          { class: `sev-${f.severity}` },
          h("span", { class: "sev", text: SEVERITY_NAMES[f.severity] }),
          h("span", { class: "msg", text: f.message }),
          f.severity === "error"
            ? null
            : h("button", { type: "button", class: "small-button", text: "Dismiss", on: { click: () => dismiss({ code: f.code }) } }),
        ),
      );
    }
    for (const f of dismissed) {
      // An error cannot be dismissed from here, so one that is dismissed is one that the person's own change replaced: either the
      // answer they chose (what the file's key said) or the words they wrote (where a placeholder was). It is kept in the list,
      // with its words, and says that it no longer applies.
      const label = f.severity !== "error" ? "Dismissed" : WORDS_WRITTEN.has(f.code) ? "Fixed by your words" : "Replaced by your answer";
      list.append(h("li", { class: "dismissed" }, h("span", { class: "sev", text: label }), h("span", { class: "msg", text: f.message })));
    }
    checksHost.append(list);
    if (notes.length > 1) checksHost.append(h("button", { type: "button", class: "small-button", text: "Mark all checks as checked", on: { click: () => dismiss({ all: true }) } }));
    if (live.some((f) => f.severity === "error")) {
      checksHost.append(h("p", { class: "hint", text: "An error goes when the question is fixed. It cannot be dismissed." }));
    }
  }

  /** @param {{ code?: string, all?: boolean }} payload */
  async function dismiss(payload) {
    try {
      const { question: next } = await options.dismiss(payload);
      // Only the checks change; what the person has typed stays where it is.
      question.findings = next.findings;
      question.verdict = next.verdict;
      renderChecks();
      renderHeader();
      options.onSaved?.(question, []);
    } catch (error) {
      options.notify(/** @type {Error} */ (error).message, "error");
    }
  }

  // -------------------------------------------------------------------------
  // The whole editor
  // -------------------------------------------------------------------------

  /** @type {HTMLElement} */
  let headerHost;

  function renderHeader() {
    clear(headerHost);
    put(
      headerHost,
      badge(question.verdict),
      h("span", { class: "meta", text: `Version ${question.version}` }),
      // A row of a spreadsheet is found by the number the spreadsheet shows, which the bank does not keep (only the import screen
      // has the rows in front of it), so a number here would be a line of nothing.
      question.origin?.source && question.origin.profile === "spreadsheet" ? h("span", { class: "meta", text: "From your spreadsheet" }) : question.origin?.source && question.origin.profile === "pdf" ? h("span", { class: "meta", text: "From your PDF" }) : question.origin?.source ? h("span", { class: "meta", text: `From your file, line${question.origin.source.firstBlock === question.origin.source.lastBlock ? "" : "s"} ${question.origin.source.firstBlock + 1}${question.origin.source.firstBlock === question.origin.source.lastBlock ? "" : ` to ${question.origin.source.lastBlock + 1}`}` }) : null,
      question.media > 0 ? h("span", { class: "meta", text: question.media === 1 ? "1 picture" : `${question.media} pictures` }) : null,
      question.math > 0 ? h("span", { class: "meta", text: question.math === 1 ? "1 equation" : `${question.math} equations` }) : null,
      (question.tables ?? []).length > 0 ? h("span", { class: "meta", text: question.tables?.length === 1 ? "1 table" : `${question.tables?.length} tables` }) : null,
    );
  }

  /**
   * The pictures of the question: each shown, with the words a screen reader says for it. A picture stands in the text where its
   * token, [picture 2], is written, and the token is moved or removed like any words.
   */
  /** The most a picture may be, as the server holds it. */
  const MAX_PICTURE_BYTES = 25 * 1024 * 1024;

  /**
   * A change to the question's pictures, made on the server at once. It is the whole saved question that changes, so unsaved changes in
   * the editor are asked to be saved first and are never carried across.
   * @param {string} method
   * @param {string} suffix  what follows /pictures
   * @param {Blob | undefined} file
   * @param {string} done  what to say when it worked
   */
  async function changePictures(method, suffix, file, done) {
    if (isDirty()) {
      options.notify("Save your changes to the question first, and then change its pictures.", "error");
      return;
    }
    try {
      const result = await api(method, `${options.picturesBase}${suffix}`, file);
      question = result.question;
      original = inputOf(question);
      draft = inputOf(question);
      render();
      options.onPictureChanged?.(result);
      options.notify(done, "ok");
    } catch (error) {
      options.notify(/** @type {Error} */ (error).message, "error");
    }
  }

  /** Asks for a picture from the computer, and gives it to `then` when one is chosen. @param {(file: File) => void} then */
  function choosePicture(then) {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/png,image/jpeg,image/gif";
    input.addEventListener("change", () => {
      const file = input.files?.[0];
      if (!file) return;
      if (file.size > MAX_PICTURE_BYTES) {
        options.notify("That picture is larger than 25 MB. Save it smaller, as a PNG, JPEG or GIF, and try again.", "error");
        return;
      }
      then(file);
    });
    input.click();
  }

  function picturesPanel() {
    const shown = question.pictures ?? [];
    const editable = Boolean(options.picturesBase) && !question.readOnly;
    if (shown.length === 0 && !editable) return null;
    const entries = draft.pictures ?? [];
    return h(
      "section",
      { class: "pictures", attrs: { "aria-label": "Pictures in this question" } },
      h("h3", { text: shown.length === 1 ? "Picture" : "Pictures" }),
      shown.length > 0 ? h("p", { class: "hint", text: "A picture stands where its number is written in the text, like [picture 1]. Move the words in brackets to move the picture; take them out and the picture is kept but not shown." }) : null,
      ...shown.map((p, i) => {
        const entry = entries[i];
        if (!entry) return null;
        const src = options.mediaBase ? `/api/${options.mediaBase}/${encodeURIComponent(p.file)}` : "";
        const image = h("img", { class: "picture-image", attrs: { alt: entry.decorative ? "" : entry.alt, ...(src ? { src } : {}), loading: "lazy" } });
        image.addEventListener("error", () => {
          image.replaceWith(h("p", { class: "problem", text: "This picture is not in the bank, so it cannot be shown. The description is kept." }));
        });
        const description = textInput(`Description of picture ${p.number}, read aloud by a screen reader`, entry.alt, (v) => (entry.alt = v));
        const field = /** @type {HTMLInputElement} */ (description.querySelector("input"));
        field.disabled = entry.decorative;
        if (!entry.decorative && entry.alt.trim() === "") field.setAttribute("aria-describedby", `${id}-needs-${p.number}`);
        return h(
          "div",
          { class: "picture" },
          h("div", { class: "picture-frame" }, image),
          h(
            "div",
            { class: "picture-fields" },
            h("strong", { text: `Picture ${p.number}` }),
            description,
            !entry.decorative && entry.alt.trim() === "" ? h("p", { class: "hint", id: `${id}-needs-${p.number}`, text: "This picture has no description. Say what it shows without giving away the answer, or mark it as decoration." }) : null,
            checkbox("This picture is decoration, so it needs no description", entry.decorative, (v) => {
              entry.decorative = v;
              if (v) entry.alt = "";
              render();
            }),
            p.placed ? null : h("p", { class: "hint", text: `Not in the text yet. Write [picture ${p.number}] where it should stand.` }),
            editable
              ? h(
                  "div",
                  { class: "picture-actions" },
                  h("button", { type: "button", text: `Replace picture ${p.number}…`, on: { click: () => choosePicture((file) => void changePictures("POST", `/${encodeURIComponent(p.id)}/replace`, file, `Picture ${p.number} was replaced. Its place in the text and its description are as they were.`)) } }),
                  h("button", { type: "button", text: `Remove picture ${p.number}`, disabled: p.placed, attrs: p.placed ? { "aria-describedby": `${id}-remove-${p.number}` } : {}, on: { click: () => void changePictures("DELETE", `/${encodeURIComponent(p.id)}`, undefined, `Picture ${p.number} was removed.`) } }),
                  p.placed ? h("span", { class: "hint", id: `${id}-remove-${p.number}`, text: "To remove it, take its [picture] words out of the text and save." }) : null,
                )
              : null,
          ),
        );
      }),
      editable
        ? h("div", { class: "picture-actions" }, h("button", { type: "button", text: "Add a picture…", on: { click: () => choosePicture((file) => void changePictures("POST", "", file, "The picture was added at the end of the question. Write what it shows in its description.")) } }))
        : null,
    );
  }

  /**
   * The equations of the question: each drawn, and its LaTeX written under it. An equation stands in the text where its token,
   * [equation 2], is written, and the token is moved or removed like any words. An equation is not edited here: the person who needs
   * a different one writes it in the question's words, or in the Word file and imports again.
   */
  function equationsPanel() {
    const equations = question.equations ?? [];
    if (equations.length === 0) return null;
    return h(
      "section",
      { class: "equations", attrs: { "aria-label": "Equations in this question" } },
      h("h3", { text: equations.length === 1 ? "Equation" : "Equations" }),
      h("p", { class: "hint", text: "An equation stands where its number is written in the text, like [equation 1]. Move the words in brackets to move the equation; take them out and the equation is kept but not shown. An equation cannot be changed here yet." }),
      ...equations.map((e) => {
        const drawn = drawMath(e.mathml);
        return h(
          "div",
          { class: "equation" },
          h("strong", { text: `Equation ${e.number}` }),
          drawn
            ? h("div", { class: "equation-drawn" }, drawn)
            : h("p", { class: "problem", text: "This equation cannot be drawn here. Its LaTeX is shown below." }),
          h("code", { class: "equation-latex", text: e.latex }),
          e.placed ? null : h("p", { class: "hint", text: `Not in the text yet. Write [equation ${e.number}] where it should stand.` }),
        );
      }),
    );
  }

  /**
   * The tables of the question: each drawn from its rows and cells, as a table of the screen's own making (every cell is set as
   * text, never as markup). A table stands in the text where its token, like [table 1], is, and is moved or removed with its words.
   * It is shown and not edited.
   */
  function tablesPanel() {
    const tables = question.tables ?? [];
    if (tables.length === 0) return null;
    return h(
      "section",
      { class: "tables", attrs: { "aria-label": "Tables in this question" } },
      h("h3", { text: tables.length === 1 ? "Table" : "Tables" }),
      h("p", { class: "hint", text: "A table stands where its number is written in the text, like [table 1]. Move the words in brackets to move the table; take them out and the table is taken out of the question. A table cannot be changed here: change it in your Word file and import again, or write its words into the text." }),
      ...tables.map((t) => {
        const rows = t.rows ?? [];
        return h(
          "div",
          { class: "data-table" },
          h("strong", { text: `Table ${t.number}` }),
          rows.length > 0
            ? h(
                "div",
                { class: "data-table-scroll" },
                h(
                  "table",
                  { attrs: { "aria-label": `Table ${t.number}` } },
                  h(
                    "tbody",
                    null,
                    ...rows.map((row) =>
                      h(
                        "tr",
                        null,
                        ...row.map((cell) =>
                          h(cell.header ? "th" : "td", { ...(cell.header ? { scope: "col" } : {}), attrs: { ...(cell.colspan > 1 ? { colspan: String(cell.colspan) } : {}), ...(cell.rowspan > 1 ? { rowspan: String(cell.rowspan) } : {}) }, text: cell.text }),
                        ),
                      ),
                    ),
                  ),
                ),
              )
            : h("pre", { class: "data-table-words", text: t.text }),
        );
      }),
    );
  }

  async function changeType(/** @type {string} */ type) {
    if (type === draft.type) return;
    const keepOptions = (draft.type === "multipleChoice" || draft.type === "multipleResponse") && (type === "multipleChoice" || type === "multipleResponse");
    if (!keepOptions) {
      try {
        const blank = (await get(`blank?type=${type}`)).input;
        draft.body = blank.body;
      } catch (error) {
        options.notify(/** @type {Error} */ (error).message, "error");
        render();
        return;
      }
    } else if (type === "multipleResponse") {
      draft.body.partialCredit = draft.body.partialCredit !== false;
    }
    draft.type = type;
    options.notify(keepOptions ? "The answers were kept. Check which are right." : "The answer parts were cleared for the new type. Nothing was filled in for you.", "ok");
    render();
    touch();
  }

  async function doSave() {
    if (!isDirty() || saving) return;
    saving = true;
    touch();
    try {
      const result = await options.save(draft, question.version);
      question = result.question;
      original = inputOf(question);
      draft = inputOf(question);
      render();
      options.onSaved?.(question, result.flattened ?? []);
      const said = [];
      if (result.flattened && result.flattened.length > 0) said.push(`The formatting in ${result.flattened.join(", ")} became plain text.`);
      const replaced = result.replaced ?? [];
      if (replaced.some((r) => !WORDS_WRITTEN.has(r.code))) said.push("Your answer replaces what the file's key said (listed under Checks).");
      if (replaced.some((r) => WORDS_WRITTEN.has(r.code))) said.push("The words you wrote replace the placeholder (listed under Checks).");
      options.notify(said.length > 0 ? `Saved. ${said.join(" ")}` : "Saved.", "ok");
    } catch (error) {
      options.notify(/** @type {Error} */ (error).message, "error");
    } finally {
      saving = false;
      touch();
    }
  }

  function render() {
    clear(element);
    headerHost = h("div", { class: "editor-head" });
    bodyHost = h("div", { class: "body-host" });
    checksHost = h("div", { class: "checks" });
    renderHeader();

    const typeChoices = /** @type {Array<[string, string]>} */ (
      (EDITABLE_TYPES.includes(/** @type {any} */ (draft.type)) ? EDITABLE_TYPES : [draft.type, ...EDITABLE_TYPES]).map((t) => [t, /** @type {any} */ (TYPE_NAMES)[t] ?? t])
    );
    const top = h(
      "div",
      { class: "grid" },
      select("Kind of question", typeChoices, draft.type, (v) => void changeType(v), { small: true }),
      textInput("Points", String(draft.points), (v) => (draft.points = Number(v) || 0), { type: "number", min: 0, max: 1000, step: "any", small: true }),
    );
    if (question.readOnly) top.querySelectorAll("select, input").forEach((c) => /** @type {HTMLInputElement} */ (c).setAttribute("disabled", ""));

    const formatted = question.formatted.filter((f) => f === "stem" || f.startsWith("options") || f.startsWith("feedback"));
    const stem = textArea("The question", draft.stem, (v) => (draft.stem = v), {
      rows: 3,
      locked: isLocked("stem") || Boolean(question.readOnly),
      ...(formatted.length > 0 ? { hint: "Some of this question has formatting, such as bold. If you change the text of a part that has it, that part becomes plain text." } : {}),
    });

    const feedback = h(
      "details",
      { class: "more", open: Boolean(draft.feedback.general || draft.feedback.correct || draft.feedback.incorrect) },
      h("summary", { text: "Feedback" }),
      textArea("Shown after any answer", draft.feedback.general, (v) => (draft.feedback.general = v), { rows: 2, locked: isLocked("feedback.general") }),
      textArea("Shown after a right answer", draft.feedback.correct, (v) => (draft.feedback.correct = v), { rows: 2, locked: isLocked("feedback.correct") }),
      textArea("Shown after a wrong answer", draft.feedback.incorrect, (v) => (draft.feedback.incorrect = v), { rows: 2, locked: isLocked("feedback.incorrect") }),
    );

    const m = draft.metadata;
    const details = h(
      "details",
      { class: "more" },
      h("summary", { text: "Details" }),
      textInput("Title (shown in lists)", draft.title, (v) => (draft.title = v)),
      h(
        "div",
        { class: "grid" },
        select("Status", [["draft", "Draft"], ["reviewed", "Reviewed"], ["approved", "Approved"], ["retired", "Retired"]], m.status, (v) => { m.status = v; touch(); }, { small: true }),
        select("Difficulty", [["", "Not set"], ["easy", "Easy"], ["medium", "Medium"], ["hard", "Hard"]], m.difficulty, (v) => { m.difficulty = v; touch(); }, { small: true }),
        select("Thinking level", [["", "Not set"], ["remember", "Remember"], ["understand", "Understand"], ["apply", "Apply"], ["analyze", "Analyze"], ["evaluate", "Evaluate"], ["create", "Create"]], m.bloom, (v) => { m.bloom = v; touch(); }, { small: true }),
      ),
      textInput("Learning objective", m.objective, (v) => (m.objective = v)),
      h("div", { class: "grid" }, textInput("Chapter", m.chapter, (v) => (m.chapter = v), { small: true }), textInput("Section", m.section, (v) => (m.section = v), { small: true }), textInput("Page", m.page, (v) => (m.page = v), { small: true })),
      textInput("Tags (separate with commas)", m.tags.join(", "), (v) => (m.tags = v.split(",").map((t) => t.trim()).filter(Boolean))),
    );

    saveButton = h("button", { type: "button", class: "primary", text: options.saveLabel ?? "Save", disabled: true, on: { click: () => void doSave() } });
    dirtyNote = h("span", { class: "dirty", role: "status" });

    element.append(
      headerHost,
      top,
      stem,
      picturesPanel(),
      equationsPanel(),
      tablesPanel(),
      bodyHost,
      feedback,
      details,
      checksHost,
      h("div", { class: "editor-actions" }, saveButton, ...(options.actions ?? []), dirtyNote),
    );
    renderBody();
    renderChecks();
    touch();
  }

  element.addEventListener("keydown", (/** @type {KeyboardEvent} */ e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
      e.preventDefault();
      void doSave();
    }
  });

  render();

  return {
    element,
    isDirty,
    save: doSave,
    /** Starts again from a question the server sent, dropping what is in the editor. */
    replace(/** @type {EditorQuestion} */ next) {
      question = next;
      original = inputOf(next);
      draft = inputOf(next);
      render();
    },
    get question() {
      return question;
    },
  };
}
