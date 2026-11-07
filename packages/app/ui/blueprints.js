// @ts-check
/**
 * Blueprints on the Make a test screen: a recipe for a test that the bank keeps ("5 from chapter 1, 3 on this objective"), written
 * once and used for every test after.
 *
 * Using one chooses nothing for the person. It adds the questions it would take to the ones being chosen, where every one can be
 * seen and any taken out, and it says what it could not find and why. A rule that found too few is short by that many; it is never
 * made up from something else.
 */

import { get, post, put as putJson, del } from "./api.js";
import { confirmAction } from "./dialogs.js";
import { clear, h, plural, put, TYPE_NAMES } from "./dom.js";

/** What a rule can be by. The same list as Pick for me, in the same words. */
export const RULE_AXES = [
  ["objective", "objective"],
  ["chapter", "chapter"],
  ["section", "section"],
  ["tag", "tag"],
  ["bloom", "Bloom level"],
  ["difficulty", "difficulty"],
  ["type", "kind of question"],
];

const axisName = (/** @type {string} */ axis) => RULE_AXES.find(([a]) => a === axis)?.[1] ?? axis;

/** A value as a person reads it: a question with nothing set is "Not set", and a kind of question is named. */
function valueName(/** @type {string} */ axis, /** @type {string} */ value) {
  if (value === "(none)") return "Not set";
  return axis === "type" ? /** @type {any} */ (TYPE_NAMES)[value] ?? value : value;
}

/** @typedef {{ axis: string, value: string, count: number, and?: Array<{ axis: string, value: string }> }} Rule */

/** The most values one rule asks for in all, the first included. The same as the engine's. */
const MOST_VALUES = 5;

/** One rule in a line: "5 where chapter is Chapter 1", or "3 where chapter is Chapter 2 and Bloom level is apply". */
export function ruleText(/** @type {Rule} */ rule) {
  const all = [{ axis: rule.axis, value: rule.value }, ...(rule.and ?? [])];
  return `${rule.count} where ${all.map((c) => `${axisName(c.axis)} is ${valueName(c.axis, c.value)}`).join(" and ")}`;
}

/**
 * Why a set of values could never all be had by one question, in words, or an empty string. The engine refuses the same sets; saying
 * it here means the person is told before the request goes, in the rule's own words.
 * @param {Array<{ axis: string, value: string }>} conditions
 */
export function impossibleText(conditions) {
  /** @type {Map<string, string[]>} */
  const byAxis = new Map();
  for (const c of conditions) byAxis.set(c.axis, [...(byAxis.get(c.axis) ?? []), c.value]);
  for (const [axis, values] of byAxis) {
    if (values.length < 2) continue;
    if (new Set(values).size !== values.length) return `A rule asks for the same ${axisName(axis)} twice.`;
    if (axis !== "tag") return `A question has one ${axisName(axis)}, so a rule that asks for ${values.length} of them could never take a question.`;
    if (values.includes("(none)")) return "A rule cannot ask for a question with no tag and for a tag as well.";
  }
  return "";
}

/**
 * @param {{
 *   base: string,
 *   facets: () => Record<string, Array<{ value: string, count: number }>>,
 *   chosen: () => string[],
 *   add: (ids: string[]) => void,
 *   tell: (error: unknown) => void,
 *   notify: (message: string, kind?: "ok" | "error") => void,
 * }} options
 * @returns {HTMLElement}
 */
export function blueprintsPanel(options) {
  const base = `${options.base}/blueprints`;
  /** @type {Array<{ id: string, name: string, rules: Rule[] }>} */
  let blueprints = [];
  /** The id of the blueprint being changed, or null when a new one is being written. */
  let editing = /** @type {string | null} */ (null);

  const listHost = h("ul", { class: "blueprints", attrs: { "aria-label": "Saved blueprints" } });
  const drawNote = h("div", { class: "sub", attrs: { "aria-live": "polite" } });

  // The form ---------------------------------------------------------------------------------------------------------------
  const name = h("input", { type: "text", id: "bp-name", autocomplete: "off", spellcheck: true, attrs: { maxlength: "120" } });
  const rulesHost = h("div", { class: "rule-rows", attrs: { role: "group", "aria-label": "Rules" } });
  const formTitle = h("h3", { text: "Write a blueprint" });
  const save = h("button", { type: "submit", class: "primary", text: "Save the blueprint" });
  const cancel = h("button", { type: "button", text: "Cancel the change", hidden: true });
  const addRule = h("button", { type: "button", text: "Add a rule" });
  const details = h("details", { class: "blueprint-form" });

  /** @param {string} axis @param {string} [keep] a value to keep in the list even when no question has it now */
  function valueChoices(axis, keep) {
    const seen = new Set();
    /** @type {Array<{ value: string, text: string }>} */
    const choices = [];
    for (const f of options.facets()[axis] ?? []) {
      seen.add(f.value);
      choices.push({ value: f.value, text: `${valueName(axis, f.value)} (${f.count})` });
    }
    // A saved rule whose value no question has now is kept, and said so, so that changing the count does not change the value.
    if (keep !== undefined && keep !== "" && !seen.has(keep)) choices.push({ value: keep, text: `${valueName(axis, keep)} (no question has it now)` });
    return choices;
  }

  /**
   * The two choices that make one value a rule asks for: what it is by, and which value. The list of values is what the bank has on
   * that axis, so a person picks and never types one that matches nothing.
   * @param {{ axis: string, value: string }} [start]
   */
  function pairControls(start) {
    const axis = h("select", { attrs: { "aria-label": "Rule is by" } }, ...RULE_AXES.map(([a, label]) => h("option", { value: a, text: label, selected: (start?.axis ?? "chapter") === a })));
    const value = h("select", { attrs: { "aria-label": "Rule is for the value" } });
    function fillValue(/** @type {string} */ keep) {
      clear(value);
      const choices = valueChoices(axis.value, keep);
      if (choices.length === 0) put(value, h("option", { value: "", text: "No values" }));
      for (const c of choices) put(value, h("option", { value: c.value, text: c.text, selected: c.value === keep }));
    }
    fillValue(start?.value ?? "");
    axis.addEventListener("change", () => fillValue(""));
    return { axis, value, read: () => ({ axis: axis.value, value: value.value }) };
  }

  /** @param {Rule} [rule] */
  function ruleRow(rule) {
    const count = h("input", { type: "number", value: String(rule?.count ?? 5), attrs: { min: "1", max: "1000", inputmode: "numeric", "aria-label": "How many questions" } });
    const remove = h("button", { type: "button", class: "small-button", text: "Remove" });
    const first = pairControls(rule);
    const head = h("div", { class: "rule-line" }, h("span", { text: "Take" }), count, h("span", { text: "questions where" }), first.axis, h("span", { text: "is" }), first.value, remove);
    const othersHost = h("div", { class: "rule-others" });
    const addValue = h("button", { type: "button", class: "small-button", text: "Also ask for another value" });
    const row = h("div", { class: "rule-row" }, head, othersHost, addValue);
    /** The other values this rule asks for, as well as the first. */
    let others = /** @type {Array<{ el: HTMLElement, controls: ReturnType<typeof pairControls>, drop: HTMLButtonElement }>} */ ([]);

    /** Each extra value says which rule and which value it is to a screen reader, and the button hides when there is no room for another. */
    function label() {
      others.forEach((o, j) => {
        o.el.setAttribute("role", "group");
        o.el.setAttribute("aria-label", `Value ${j + 2} of this rule`);
        o.drop.setAttribute("aria-label", `Remove value ${j + 2} of this rule`);
      });
      addValue.hidden = others.length + 1 >= MOST_VALUES;
    }
    /** @param {{ axis: string, value: string }} [start] */
    function addOther(start) {
      const controls = pairControls(start);
      const drop = h("button", { type: "button", class: "small-button", text: "Remove this value" });
      const el = h("div", { class: "rule-line rule-and" }, h("span", { text: "and" }), controls.axis, h("span", { text: "is" }), controls.value, drop);
      const entry = { el, controls, drop };
      drop.addEventListener("click", () => {
        others = others.filter((o) => o !== entry);
        el.remove();
        label();
        // Focus stays in the rule: on the button that adds a value, which is there again if it was hidden.
        addValue.focus();
      });
      others.push(entry);
      put(othersHost, el);
      label();
    }
    for (const c of rule?.and ?? []) addOther(c);
    addValue.addEventListener("click", () => {
      addOther({ axis: "bloom", value: "" });
      others[others.length - 1]?.controls.axis.focus();
    });
    label();
    return {
      el: row,
      read: () => {
        /** @type {Rule} */
        const out = { ...first.read(), count: Number(count.value) };
        if (others.length > 0) out.and = others.map((o) => o.controls.read());
        return out;
      },
      remove,
    };
  }

  /** The rules being written, in order. */
  let rows = /** @type {Array<ReturnType<typeof ruleRow>>} */ ([]);

  /** Each row says which one it is to a screen reader, and the last one cannot be taken away. */
  function numberRows() {
    rows.forEach((row, i) => {
      row.el.setAttribute("role", "group");
      row.el.setAttribute("aria-label", `Rule ${i + 1}`);
      row.remove.setAttribute("aria-label", `Remove rule ${i + 1}`);
      row.remove.disabled = rows.length === 1;
    });
  }

  /** @param {Rule} [rule] */
  function addRow(rule) {
    const row = ruleRow(rule);
    row.remove.addEventListener("click", () => {
      rows = rows.filter((r) => r !== row);
      row.el.remove();
      numberRows();
      // Focus goes to the button that adds a rule, which is always there, so it does not fall off the page when a row goes.
      addRule.focus();
    });
    rows.push(row);
    put(rulesHost, row.el);
    numberRows();
  }

  /** @param {{ id: string, name: string, rules: Rule[] } | null} existing */
  function startForm(existing) {
    editing = existing?.id ?? null;
    name.value = existing?.name ?? "";
    clear(rulesHost);
    rows = [];
    if (existing) for (const rule of existing.rules) addRow(rule);
    else addRow();
    formTitle.textContent = existing ? `Change the blueprint "${existing.name}"` : "Write a blueprint";
    save.textContent = existing ? "Save the change" : "Save the blueprint";
    cancel.hidden = !existing;
  }

  addRule.addEventListener("click", () => {
    addRow();
    rows[rows.length - 1]?.el.querySelector("input")?.focus();
  });
  cancel.addEventListener("click", () => {
    startForm(null);
    name.focus();
  });

  const form = h(
    "form",
    { class: "blueprint-editor", attrs: { novalidate: "" } },
    formTitle,
    h("div", { class: "field" }, h("label", { for: "bp-name", class: "field-label", text: "Name of the blueprint" }), name),
    rulesHost,
    h("div", { class: "editor-actions" }, addRule, save, cancel),
  );
  form.addEventListener("submit", async (/** @type {Event} */ event) => {
    event.preventDefault();
    const rules = rows.map((row) => row.read());
    if (name.value.trim() === "") {
      options.notify("Give the blueprint a name.", "error");
      name.focus();
      return;
    }
    if (rules.some((r) => r.value === "" || (r.and ?? []).some((c) => c.value === ""))) {
      options.notify("A rule needs a value for each thing it asks for. If no question has one for that, there is nothing to take.", "error");
      return;
    }
    for (const [i, r] of rules.entries()) {
      const why = impossibleText([{ axis: r.axis, value: r.value }, ...(r.and ?? [])]);
      if (why !== "") {
        options.notify(`Rule ${i + 1}: ${why}`, "error");
        return;
      }
    }
    if (rules.some((r) => !Number.isInteger(r.count) || r.count < 1 || r.count > 1000)) {
      options.notify("How many to take is a whole number from 1 to 1000.", "error");
      return;
    }
    save.disabled = true;
    try {
      if (editing) await putJson(`${base}/${editing}`, { name: name.value, rules });
      else await post(base, { name: name.value, rules });
      options.notify(editing ? "The blueprint is changed." : "The blueprint is kept in the bank.", "ok");
      startForm(null);
      await load();
    } catch (error) {
      options.tell(error);
    } finally {
      save.disabled = false;
    }
  });
  details.append(h("summary", { text: "Write or change a blueprint" }), form);

  // The list ---------------------------------------------------------------------------------------------------------------
  function render() {
    clear(listHost);
    if (blueprints.length === 0) {
      put(listHost, h("li", { class: "empty", text: "No blueprint is kept in this bank yet." }));
      return;
    }
    for (const bp of blueprints) {
      const use = h("button", { type: "button", text: "Use", attrs: { "aria-label": `Use the blueprint ${bp.name}` } });
      const edit = h("button", { type: "button", class: "small-button", text: "Change", attrs: { "aria-label": `Change the blueprint ${bp.name}` } });
      const remove = h("button", { type: "button", class: "small-button danger", text: "Delete", attrs: { "aria-label": `Delete the blueprint ${bp.name}` } });
      use.addEventListener("click", () => draw(bp, use));
      edit.addEventListener("click", () => {
        startForm(bp);
        details.open = true;
        name.focus();
      });
      remove.addEventListener("click", async () => {
        if (!(await confirmAction("Delete this blueprint?", `"${bp.name}" is taken out of the bank. No test and no question is changed by it.`, { yes: "Delete it", danger: true }))) return;
        try {
          await del(`${base}/${bp.id}`);
          if (editing === bp.id) startForm(null);
          options.notify("The blueprint is deleted.", "ok");
          await load();
        } catch (error) {
          options.tell(error);
        }
      });
      put(
        listHost,
        h("li", { class: "blueprint-row" }, h("span", { class: "blueprint-name", text: bp.name }), h("span", { class: "blueprint-rules", text: bp.rules.map(ruleText).join("; ") }), h("span", { class: "blueprint-actions" }, use, edit, remove)),
      );
    }
  }

  /** @param {{ id: string, name: string }} bp @param {HTMLButtonElement} button */
  async function draw(bp, button) {
    button.disabled = true;
    try {
      const result = await post(`${base}/${bp.id}/draw`, { chosen: options.chosen() });
      options.add(result.ids);
      clear(drawNote);
      put(drawNote, h("p", { text: `Used "${bp.name}". ${result.ids.length === 0 ? "None chosen" : `Chose ${plural(result.ids.length, "question", "questions")}`}.` }));
      // The engine's own account of each rule that came out short: how many, and what was in the way.
      const shortOnes = /** @type {string[]} */ (result.notes).slice(1);
      if (shortOnes.length > 0) put(drawNote, h("ul", {}, ...shortOnes.map((line) => h("li", { text: line }))));
    } catch (error) {
      options.tell(error);
    } finally {
      button.disabled = false;
    }
  }

  async function load() {
    const reply = await get(base);
    blueprints = reply.blueprints;
    render();
  }

  startForm(null);
  load().catch((error) => options.tell(error));

  return h(
    "section",
    { class: "panel blueprints-panel", attrs: { "aria-labelledby": "bp-heading" } },
    h("h2", { id: "bp-heading", text: "Blueprints" }),
    h("p", { class: "sub", text: "A blueprint is a recipe for a test that this bank keeps, such as five questions from chapter 1 and three at the apply level. Using one adds the questions it takes to the ones chosen below, and you can take any out. It never fills up a rule from somewhere else when the bank has too few; it says how many it found." }),
    listHost,
    drawNote,
    details,
  );
}
