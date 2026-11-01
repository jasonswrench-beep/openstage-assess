// @ts-check
/**
 * Questions put to the person: one dialog, reused. Every one can be answered with the keyboard, closes with Escape, and
 * hands back what was chosen, or null when it was closed without a choice.
 */

import { clear, h } from "./dom.js";

/** @returns {HTMLDialogElement} */
function dialog() {
  return /** @type {HTMLDialogElement} */ (document.getElementById("dialog"));
}

/**
 * @template T
 * @param {{ title: string, body?: (Node | string)[], actions: Array<{ label: string, value: T, primary?: boolean, danger?: boolean }>, onOpen?: (root: HTMLElement) => void, collect?: () => any }} options
 * @returns {Promise<{ value: T, collected: any } | null>}
 */
export function ask(options) {
  const box = dialog();
  clear(box);
  return new Promise((resolve) => {
    /** @type {{ value: T, collected: any } | null} */
    let answer = null;
    let settled = false;
    // A button settles the answer itself, and does not wait for the dialog to say it closed. Escape closes the dialog
    // without a button, and the close event is what settles that one, with no answer.
    const settle = () => {
      if (settled) return;
      settled = true;
      resolve(answer);
    };
    const finish = (/** @type {T} */ value) => {
      answer = { value, collected: options.collect ? options.collect() : undefined };
      settle();
      if (box.open) box.close();
    };
    const form = h(
      "form",
      { class: "dialog-body", on: { submit: (/** @type {Event} */ e) => e.preventDefault() } },
      h("h2", { text: options.title }),
      ...(options.body ?? []).map((part) => (typeof part === "string" ? h("p", { text: part }) : part)),
      h(
        "div",
        { class: "dialog-actions" },
        ...options.actions.map((action) =>
          h("button", {
            type: "button",
            class: action.primary ? "primary" : action.danger ? "danger" : "",
            text: action.label,
            on: { click: () => finish(action.value) },
          }),
        ),
      ),
    );
    box.append(form);
    box.addEventListener("close", settle, { once: true });
    box.showModal();
    options.onOpen?.(form);
    const first = /** @type {HTMLElement | null} */ (form.querySelector("input, textarea, select, button.primary, button"));
    first?.focus();
  });
}

/**
 * A yes or no. Returns true for yes.
 * @param {string} title
 * @param {string} message
 * @param {{ yes?: string, no?: string, danger?: boolean }} [labels]
 */
export async function confirmAction(title, message, labels = {}) {
  const answer = await ask({
    title,
    body: [message],
    actions: [
      { label: labels.no ?? "Cancel", value: false },
      { label: labels.yes ?? "OK", value: true, primary: !labels.danger, danger: labels.danger === true },
    ],
  });
  return answer?.value === true;
}

/**
 * One line of text. Returns the text, or null if the dialog was closed.
 * @param {string} title
 * @param {string} label
 * @param {string} [value]
 * @param {string} [ok]
 */
export async function askText(title, label, value = "", ok = "OK") {
  const input = h("input", { type: "text", value, id: "ask-text", autocomplete: "off", spellcheck: true });
  input.addEventListener("keydown", (/** @type {KeyboardEvent} */ e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      /** @type {HTMLButtonElement | null} */ (dialog().querySelector("button.primary"))?.click();
    }
  });
  const answer = await ask({
    title,
    body: [h("label", { for: "ask-text", text: label, class: "field-label" }), input],
    actions: [
      { label: "Cancel", value: false },
      { label: ok, value: true, primary: true },
    ],
    collect: () => input.value,
    onOpen: () => input.select(),
  });
  return answer?.value === true ? String(answer.collected).trim() : null;
}
