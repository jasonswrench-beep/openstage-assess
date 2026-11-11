// @ts-check
// Copied from OpenStage Author (editor/src/commandsearch.ts, Apache-2.0, the same owner) for the OpenStage suite's look, by way of
// OpenExplainer's copy, and written as plain JavaScript here (see NOTICE). Keep them alike: a fix in one belongs in the others.
//
// The command search (Ctrl+K, or the Search button in the navy bar): a box to type a few letters of what you want to do, and the
// commands whose names fit, so nobody has to remember which menu holds one. It lists the same commands as the menus, with the same
// words, icons, shortcuts and dimming (they all come from one list, commands.js).
//
// It follows the combobox pattern of the WAI-ARIA Authoring Practices: focus stays in the box while Up and Down move through what is
// found (aria-activedescendant), Enter does the one that is chosen, and Escape closes the window. Like a menu, it first gives focus
// back to where the person was and then runs the command, so a dialog the command opens gives focus back to that place too.
// The pure parts (which commands fit what was typed, and in what order) are at the top, so they can be tested without a page.

import { ariaKeys, el, uiIcon } from "./menubar.js";

/**
 * @typedef {import("./menubar.js").MenuCommand} MenuCommand
 * @typedef {import("./menubar.js").MenuDef} MenuDef
 * @typedef {{ cmd: MenuCommand, menus: string[] }} SearchEntry  One command, and the menus it is in.
 * @typedef {{ entry: SearchEntry, label: string, score: number }} Found
 */

/**
 * Every command in the menus, once each, in the order of the menus. A command in two menus is listed once, with both.
 * @param {readonly MenuDef[]} menus
 * @returns {SearchEntry[]}
 */
export function searchEntries(menus) {
  /** @type {SearchEntry[]} */
  const out = [];
  /** @type {Map<() => void, SearchEntry>} */
  const byRun = new Map();
  for (const menu of menus) {
    for (const item of menu.items) {
      if (item === "-") continue;
      const known = byRun.get(item.run);
      if (known) {
        if (!known.menus.includes(menu.label)) known.menus.push(menu.label);
        continue;
      }
      const entry = { cmd: item, menus: [menu.label] };
      byRun.set(item.run, entry);
      out.push(entry);
    }
  }
  return out;
}

/**
 * Where it is, in words: "File menu", "Bank and Test menus".
 * @param {readonly string[]} menus
 */
export function menusText(menus) {
  if (menus.length === 0) return "";
  if (menus.length === 1) return `${menus[0]} menu`;
  return `${menus.slice(0, -1).join(", ")} and ${menus[menus.length - 1]} menus`;
}

/**
 * Words as they are compared: lower case, without the dots after a name that opens a window, with marks between words made into
 * spaces, and with British spellings made American, so "color" finds "colours" and "colour" finds "color".
 * @param {string} text
 */
export function plain(text) {
  return text
    .toLocaleLowerCase()
    .replace(/\.\.\.|…/g, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/colour/g, "color")
    .replace(/behaviour/g, "behavior")
    .replace(/centre/g, "center")
    .replace(/organis/g, "organiz")
    .trim();
}

/** @param {string} text */
function words(text) {
  const p = plain(text);
  return p === "" ? [] : p.split(" ");
}

/**
 * How well a command fits what was typed; 0 is not at all. Best is its name exactly, then its name starting with it, then every word
 * typed starting a word of its name, then its name holding it anywhere, then the words of its menu, and last the words of its
 * description. In a description a short word has to be a whole word; a word of five letters or more may be the start of one.
 * @param {string} query
 * @param {string} label
 * @param {readonly string[]} [menus]
 * @param {string} [title]
 */
export function scoreCommand(query, label, menus = [], title = "") {
  const q = plain(query);
  if (q === "") return 1;
  const name = plain(label);
  if (name === q) return 100;
  if (name.startsWith(q)) return 90;
  const typed = q.split(" ");
  const nameWords = name.split(" ");
  const starts = (/** @type {readonly string[]} */ pool) => (/** @type {string} */ w) => pool.some((x) => x.startsWith(w));
  if (typed.every(starts(nameWords))) {
    return 70 + (typed.every((w) => nameWords.includes(w)) ? 3 : 0) + ((nameWords[0] ?? "").startsWith(typed[0] ?? "") ? 5 : 0);
  }
  if (name.includes(q)) return 50;
  const menuWords = [...nameWords, ...menus.flatMap(words)];
  if (typed.every(starts(menuWords))) return 30;
  const titleWords = words(title);
  if (typed.every((w) => starts(menuWords)(w) || (w.length >= 5 ? starts(titleWords)(w) : titleWords.includes(w)))) return 10;
  return 0;
}

/**
 * The commands that fit what was typed, best first; with nothing typed, all of them in the order of the menus.
 * @param {readonly SearchEntry[]} entries
 * @param {string} query
 * @returns {Found[]}
 */
export function rankCommands(entries, query) {
  const scored = entries.map((entry, i) => {
    const cmd = entry.cmd;
    const label = cmd.labelNow?.() ?? cmd.label;
    let score = scoreCommand(query, label, entry.menus, cmd.title ?? "");
    if (label !== cmd.label) score = Math.max(score, scoreCommand(query, cmd.label, entry.menus, cmd.title ?? "") - 1);
    return { found: { entry, label, score }, i };
  });
  return scored
    .filter((s) => s.found.score > 0)
    .sort((a, b) => b.found.score - a.found.score || a.i - b.i)
    .map((s) => s.found);
}

/**
 * What the line under the box says about what was found.
 * @param {number} count
 * @param {string} query
 */
export function foundText(count, query) {
  if (plain(query) === "") return `${count} commands, in the order of the menus. Type to find one.`;
  if (count === 0) return "No command has those words. Try another word, or look in the menus.";
  return count === 1 ? "1 command found." : `${count} commands found.`;
}

// ---- the page

/** Only one at a time: Ctrl+K again while it is open puts focus back in its box. @type {HTMLDialogElement | null} */
let openNow = null;

/**
 * @param {Document} doc
 * @param {readonly SearchEntry[]} entries
 * @param {{ fallback: () => HTMLElement | null }} opts  where focus goes when the window closes, if the place it came from has gone
 */
export function openCommandSearch(doc, entries, opts) {
  if (openNow) {
    openNow.querySelector("input")?.focus();
    return;
  }
  const from = /** @type {HTMLElement | null} */ (doc.activeElement);
  /** @type {HTMLDialogElement} */
  const dialog = el(doc, "dialog", { class: "command-search", "aria-labelledby": "cs-title", "aria-describedby": "cs-intro" });
  const closeBtn = el(doc, "button", { type: "button", class: "cs-close icon-only", "aria-label": "Close", title: "Close (Escape)" }, uiIcon(doc, "x"));
  /** @type {HTMLInputElement} */
  const input = el(doc, "input", {
    type: "text",
    id: "cs-input",
    class: "cs-input",
    role: "combobox",
    "aria-autocomplete": "list",
    "aria-expanded": "true",
    "aria-controls": "cs-list",
    "aria-labelledby": "cs-title",
    autocomplete: "off",
    spellcheck: "false",
    placeholder: "For example: new bank, print, check quality",
  });
  const list = el(doc, "ul", { id: "cs-list", class: "cs-list", role: "listbox", "aria-label": "Commands found" });
  // What was found, in words: shown under the box, and said by a screen reader (once typing pauses) from a line of its own that
  // stays in the window and is written to afterwards.
  const status = el(doc, "p", { class: "cs-status" });
  const live = el(doc, "p", { class: "visually-hidden", role: "status" });
  dialog.append(
    el(doc, "div", { class: "cs-head" }, el(doc, "h2", { id: "cs-title", text: "Search for a command" }), closeBtn),
    el(doc, "p", { id: "cs-intro", class: "hint", text: "Type a few letters of what you want to do. Up and Down move through what is found, Enter does it, Escape closes." }),
    el(doc, "div", { class: "cs-box" }, uiIcon(doc, "search"), input),
    status,
    list,
    live,
  );

  /** @type {Found[]} */
  let found = [];
  let active = -1;
  let sayTimer = 0;

  const showActive = (/** @type {boolean} */ scroll) => {
    list.querySelectorAll("[role=option]").forEach((/** @type {Element} */ o, /** @type {number} */ i) => o.setAttribute("aria-selected", String(i === active)));
    const now = active >= 0 ? doc.getElementById(`cs-opt-${active}`) : null;
    if (now) {
      input.setAttribute("aria-activedescendant", now.id);
      if (scroll) now.scrollIntoView({ block: "nearest" });
    } else input.removeAttribute("aria-activedescendant");
  };

  /**
   * @param {Found} f
   * @param {number} i
   * @returns {HTMLElement}
   */
  const option = (f, i) => {
    const cmd = f.entry.cmd;
    const on = cmd.enabled ? cmd.enabled() : true;
    const li = el(doc, "li", { id: `cs-opt-${i}`, class: "cs-option", role: "option", "aria-selected": "false" });
    if (!on) li.setAttribute("aria-disabled", "true");
    if (cmd.keys) li.setAttribute("aria-keyshortcuts", ariaKeys(cmd.keys));
    if (cmd.title) li.title = cmd.title;
    const keys = el(doc, "span", { class: "menu-keys", text: cmd.keys ?? "", "aria-hidden": "true" });
    const text = el(doc, "span", { class: "cs-text" }, el(doc, "span", { class: "cs-label", text: f.label }), " ", el(doc, "span", { class: "cs-where", text: menusText(f.entry.menus) }));
    if (cmd.checked?.()) {
      keys.replaceChildren(uiIcon(doc, "check"));
      text.append(el(doc, "span", { class: "visually-hidden", text: ", on" }));
    }
    li.append(cmd.icon ? uiIcon(doc, cmd.icon) : el(doc, "span", { class: "ui-icon-space", "aria-hidden": "true" }), text, keys);
    li.addEventListener("click", () => run(i));
    li.addEventListener("pointermove", () => {
      if (active !== i) {
        active = i;
        showActive(false);
      }
    });
    return li;
  };

  const draw = () => {
    found = rankCommands(entries, input.value);
    list.replaceChildren(...found.map((f, i) => option(f, i)));
    active = found.length > 0 ? 0 : -1;
    input.setAttribute("aria-expanded", String(found.length > 0));
    showActive(true);
    list.scrollTop = 0;
    status.textContent = foundText(found.length, input.value);
  };

  const close = (/** @type {boolean} */ giveBack) => {
    window.clearTimeout(sayTimer);
    dialog.close();
    dialog.remove();
    openNow = null;
    if (!giveBack) return;
    const there = from && from !== doc.body && from.isConnected && !from.closest("[hidden]") ? from : opts.fallback();
    there?.focus();
  };

  const run = (/** @type {number} */ i) => {
    const f = found[i];
    if (!f) return;
    const cmd = f.entry.cmd;
    if (cmd.enabled && !cmd.enabled()) {
      active = i;
      showActive(true);
      const why = `${f.label.replace(/(\.\.\.|…)$/, "")} cannot be used now.`;
      status.textContent = why;
      window.clearTimeout(sayTimer);
      live.textContent = "";
      sayTimer = window.setTimeout(() => (live.textContent = why), 30);
      return;
    }
    close(true);
    cmd.run();
  };

  input.addEventListener("input", () => {
    draw();
    // Said once typing pauses, not after every letter.
    window.clearTimeout(sayTimer);
    live.textContent = "";
    const text = status.textContent ?? "";
    sayTimer = window.setTimeout(() => (live.textContent = text), 400);
  });
  input.addEventListener("keydown", (/** @type {KeyboardEvent} */ e) => {
    const n = found.length;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (n === 0) return;
      active = e.key === "ArrowDown" ? (active + 1) % n : (active - 1 + n) % n;
      showActive(true);
    } else if (e.key === "PageDown" || e.key === "PageUp") {
      e.preventDefault();
      if (n === 0) return;
      active = Math.max(0, Math.min(n - 1, active + (e.key === "PageDown" ? 8 : -8)));
      showActive(true);
    } else if (e.key === "Enter") {
      e.preventDefault();
      run(active);
    }
  });
  closeBtn.addEventListener("click", () => close(true));
  dialog.addEventListener("cancel", (e) => {
    e.preventDefault();
    close(true);
  });
  // A click outside the window (on the dimmed page) closes it, as a click outside a menu does. It is the whole click, not the press,
  // so the window is still there when the button is let go and the click does nothing to what is under it.
  const outside = (/** @type {MouseEvent} */ e) => {
    if (e.target !== dialog) return false;
    const r = dialog.getBoundingClientRect();
    return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
  };
  dialog.addEventListener("mousedown", (/** @type {MouseEvent} */ e) => {
    if (outside(e)) e.preventDefault();
  });
  dialog.addEventListener("click", (/** @type {MouseEvent} */ e) => {
    if (outside(e)) close(true);
  });

  doc.body.append(dialog);
  openNow = dialog;
  dialog.showModal();
  draw();
  input.focus();
}
