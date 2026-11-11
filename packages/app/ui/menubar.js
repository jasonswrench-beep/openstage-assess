// @ts-check
// Copied from OpenStage Author (editor/src/menubar.ts, Apache-2.0, the same owner) for the OpenStage suite's look, by way of
// OpenExplainer's copy, and written as plain JavaScript here because this interface has no build step (see NOTICE). Keep them alike:
// a fix in one belongs in the others.
//
// The row of dropdown menus under the navy bar (File, Bank, Question...): every command the app has, in one place, each with its
// icon and its keyboard shortcut. It follows the menu bar pattern of the WAI-ARIA Authoring Practices, the way desktop programs on
// Windows behave:
//  - F10 (or Alt pressed and let go on its own) moves to the menu bar; Left and Right move along it; Down, Enter or Space opens a
//    menu; Up opens it at its last item.
//  - In a menu, Up and Down move (round from the end to the start), Home and End go to the first and last item, a letter goes to the
//    next item that starts with it, Left and Right open the menu beside it, Enter or Space chooses, Escape closes the menu and goes
//    back to its name in the bar, Tab closes it and moves on.
//  - Escape on the bar itself goes back to wherever the person was before coming to the menus.
//  - An item that cannot be used now stays in its menu, dimmed (aria-disabled), so people learn where things are.
//  - Choosing an item first puts focus back where the person was, then runs the command, so a dialog the command opens gives focus
//    back to that place when it closes.
// The pure parts (moving through a list, finding by letter) are at the top, so they can be tested without a page.

import { uiIcon } from "./ui-icons.js";

export { uiIcon };

/**
 * @typedef {import("./ui-icons.js").UiIconName} UiIconName
 *
 * @typedef {object} MenuCommand
 * @property {string} label  What the item says, for example "New bank...".
 * @property {UiIconName} [icon]
 * @property {string} [keys]  The shortcut, written the way it is shown, for example "Ctrl+K".
 * @property {string} [title]  A longer description, shown when the pointer rests on the item (and looked in by the command search).
 * @property {() => void} run
 * @property {() => boolean} [enabled]  Whether it can be used now; asked each time its menu opens.
 * @property {() => boolean} [checked]  For an item that is on or off: asked each time its menu opens.
 * @property {() => string} [labelNow]  A label that changes: asked each time its menu opens.
 *
 * @typedef {MenuCommand | "-"} MenuEntry
 *
 * @typedef {object} MenuDef
 * @property {string} id  A short id, used to open the menu from elsewhere (for example "bank").
 * @property {string} label
 * @property {MenuEntry[]} items
 */

// ---- pure parts

/**
 * The next place in a list of `count` items, going round at the ends.
 * @param {number} current
 * @param {number} count
 * @param {1 | -1} dir
 */
export function stepIndex(current, count, dir) {
  if (count <= 0) return -1;
  if (current < 0) return dir === 1 ? 0 : count - 1;
  return (current + dir + count) % count;
}

/**
 * The first item after `current` (going round) whose label starts with `letter`, or -1.
 * @param {readonly string[]} labels
 * @param {number} current
 * @param {string} letter
 */
export function letterIndex(labels, current, letter) {
  const l = letter.toLocaleLowerCase();
  if (l.length !== 1 || l.trim() === "") return -1;
  for (let i = 1; i <= labels.length; i++) {
    const at = (current + i + labels.length) % labels.length;
    if ((labels[at] ?? "").trim().toLocaleLowerCase().startsWith(l)) return at;
  }
  return -1;
}

/**
 * The way aria-keyshortcuts writes a shortcut shown as "Ctrl+K" or "Alt+Up".
 * @param {string} keys
 */
export function ariaKeys(keys) {
  return keys.replace(/Ctrl/g, "Control").replace(/\bUp\b/, "ArrowUp").replace(/\bDown\b/, "ArrowDown");
}

// ---- the page

/**
 * An element with its attributes and children. Text is set as text, never as markup.
 * @param {Document} doc
 * @param {string} tag
 * @param {Record<string, string | boolean>} [attrs]
 * @param {...(Node | string)} kids
 * @returns {any}
 */
export function el(doc, tag, attrs = {}, ...kids) {
  const e = doc.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === false) continue;
    if (k === "class") e.className = String(v);
    else if (k === "text") e.textContent = String(v);
    else e.setAttribute(k, v === true ? "" : String(v));
  }
  e.append(...kids);
  return e;
}

/**
 * Draw (or draw again) one item of a menu as it is now: its icon, its words, its shortcut or tick, and whether it can be used.
 * @param {Document} doc
 * @param {HTMLElement} button
 * @param {MenuCommand} cmd
 */
export function drawItem(doc, button, cmd) {
  const label = cmd.labelNow?.() ?? cmd.label;
  // An item that is on shows a tick where a shortcut would go (a screen reader hears "checked" from aria-checked).
  const keys = el(doc, "span", { class: "menu-keys", text: cmd.keys ?? "", "aria-hidden": "true" });
  if (cmd.checked?.()) keys.replaceChildren(uiIcon(doc, "check"));
  button.replaceChildren(
    cmd.icon ? uiIcon(doc, cmd.icon) : el(doc, "span", { class: "ui-icon-space", "aria-hidden": "true" }),
    el(doc, "span", { class: "menu-label", text: label }),
    keys,
  );
  const on = cmd.enabled ? cmd.enabled() : true;
  if (on) button.removeAttribute("aria-disabled");
  else button.setAttribute("aria-disabled", "true");
  if (cmd.checked) button.setAttribute("aria-checked", String(cmd.checked()));
}

/**
 * A new, empty item for a menu: drawItem fills it in when the menu opens.
 * @param {Document} doc
 * @param {MenuCommand} cmd
 * @returns {HTMLElement}
 */
export function newItem(doc, cmd) {
  const role = cmd.checked ? "menuitemcheckbox" : "menuitem";
  const button = el(doc, "div", { class: "menu-item", role, tabindex: "-1", ...(cmd.title ? { title: cmd.title } : {}) });
  if (cmd.keys) button.setAttribute("aria-keyshortcuts", ariaKeys(cmd.keys));
  return button;
}

/** @typedef {{ def: MenuDef, trigger: HTMLButtonElement, menu: HTMLElement, items: { button: HTMLElement, cmd: MenuCommand }[] }} Built */

export class MenuBar {
  /**
   * @param {Document} doc
   * @param {MenuDef[]} menus
   * @param {string} [label]
   */
  constructor(doc, menus, label = "Menus") {
    this.doc = doc;
    /** @type {Built[]} */
    this.built = [];
    this.openAt = -1;
    /** Where the person was before coming to the menus: where focus goes back to. @type {HTMLElement | null} */
    this.returnTo = null;
    /** The menu the last chosen command came from, for giving focus somewhere sensible when the place it came from has gone. */
    this.lastMenu = -1;
    this.altAlone = false;
    /** @type {HTMLElement} */
    this.element = el(doc, "div", { class: "menubar", role: "menubar", "aria-label": label });
    menus.forEach((def, i) => this.element.append(this.buildMenu(def, i)));
    this.built[0]?.trigger.setAttribute("tabindex", "0");

    // Remember where the person came from when they arrive at the bar from somewhere else.
    this.element.addEventListener("focusin", (/** @type {FocusEvent} */ e) => {
      const from = /** @type {HTMLElement | null} */ (e.relatedTarget);
      if (from && !this.element.contains(from)) this.returnTo = from;
    });
    // Leaving the bar (Tab, or a click elsewhere) closes any open menu.
    this.element.addEventListener("focusout", (/** @type {FocusEvent} */ e) => {
      const to = /** @type {Node | null} */ (e.relatedTarget);
      if (!to || !this.element.contains(to)) this.close(false);
    });
    doc.addEventListener(
      "pointerdown",
      (e) => {
        if (this.openAt !== -1 && !this.element.contains(/** @type {Node} */ (e.target))) this.close(false);
      },
      true,
    );
    // F10, or Alt pressed and let go with nothing else, goes to the bar (and back again).
    doc.addEventListener(
      "keydown",
      (e) => {
        this.altAlone = e.key === "Alt" && !e.ctrlKey && !e.shiftKey && !e.metaKey && !e.repeat;
        if (e.key === "F10" && !e.shiftKey && !e.ctrlKey && !e.altKey && !doc.querySelector("dialog[open]")) {
          e.preventDefault();
          this.toggleFocus();
        }
      },
      true,
    );
    doc.addEventListener(
      "keyup",
      (e) => {
        if (e.key === "Alt" && this.altAlone && !doc.querySelector("dialog[open]")) {
          e.preventDefault();
          this.toggleFocus();
        }
        this.altAlone = false;
      },
      true,
    );
    doc.addEventListener("pointerdown", () => (this.altAlone = false), true);
    doc.defaultView?.addEventListener("blur", () => (this.altAlone = false));
  }

  /**
   * Go to the menu bar (on the menu with this id, or the first), as if the person had pressed F10.
   * @param {string} [id]
   */
  focusMenu(id) {
    const at = Math.max(0, this.built.findIndex((b) => b.def.id === id));
    if (!this.element.contains(this.doc.activeElement)) this.returnTo = /** @type {HTMLElement | null} */ (this.doc.activeElement);
    this.focusTrigger(at);
  }

  /**
   * Put focus back where the person was before coming to the menus, after a command chosen from them has finished (a dialog it
   * opened has closed, say). If that place has gone, focus goes to the name of the menu the command was in.
   */
  focusBack() {
    const back = this.returnTo;
    if (back && back.isConnected && back.getClientRects().length > 0 && !back.closest("[hidden]")) back.focus();
    else this.focusTrigger(Math.max(0, this.lastMenu));
  }

  /** Whether a menu is open. */
  get isOpen() {
    return this.openAt !== -1;
  }

  /** @param {boolean} [focusTrigger] */
  close(focusTrigger = true) {
    const at = this.openAt;
    if (at === -1) return;
    const b = /** @type {Built} */ (this.built[at]);
    b.menu.hidden = true;
    b.trigger.setAttribute("aria-expanded", "false");
    this.openAt = -1;
    if (focusTrigger) b.trigger.focus();
  }

  // ---- inside

  toggleFocus() {
    if (this.element.contains(this.doc.activeElement)) {
      this.close(false);
      this.leave();
    } else {
      this.returnTo = /** @type {HTMLElement | null} */ (this.doc.activeElement);
      this.focusTrigger(0);
    }
  }

  /** Leave the bar for where the person was before. */
  leave() {
    const back = this.returnTo;
    if (back && back.isConnected && back.getClientRects().length > 0) back.focus();
    else /** @type {HTMLElement | null} */ (this.doc.activeElement)?.blur();
  }

  /** @param {number} at */
  focusTrigger(at) {
    const b = this.built[at];
    if (!b) return;
    for (const x of this.built) x.trigger.setAttribute("tabindex", x === b ? "0" : "-1");
    b.trigger.focus();
  }

  /**
   * @param {MenuDef} def
   * @param {number} at
   * @returns {HTMLElement}
   */
  buildMenu(def, at) {
    const doc = this.doc;
    const id = `menu-${def.id}`;
    /** @type {HTMLButtonElement} */
    const trigger = el(
      doc,
      "button",
      { type: "button", class: "menubar-item", id: `${id}-button`, role: "menuitem", "aria-haspopup": "menu", "aria-expanded": "false", "aria-controls": id, tabindex: "-1" },
      el(doc, "span", { text: def.label }),
      uiIcon(doc, "chevron-down"),
    );
    /** @type {HTMLElement} */
    const menu = el(doc, "div", { class: "menu", id, role: "menu", "aria-labelledby": `${id}-button`, hidden: true });
    /** @type {Built} */
    const built = { def, trigger, menu, items: [] };
    for (const entry of def.items) {
      if (entry === "-") {
        menu.append(el(doc, "div", { class: "menu-separator", role: "separator" }));
        continue;
      }
      const button = newItem(doc, entry);
      button.addEventListener("click", () => this.choose(at, built.items.findIndex((x) => x.button === button)));
      button.addEventListener("pointermove", () => {
        if (this.doc.activeElement !== button) button.focus();
      });
      built.items.push({ button, cmd: entry });
      menu.append(button);
    }
    this.built.push(built);

    trigger.addEventListener("click", () => {
      if (this.openAt === at) this.close();
      else this.open(at, "first");
    });
    // With a menu open, moving the pointer onto another menu's name opens that one instead, as on the desktop.
    trigger.addEventListener("pointerenter", () => {
      if (this.openAt !== -1 && this.openAt !== at) this.open(at, "none");
    });
    trigger.addEventListener("keydown", (/** @type {KeyboardEvent} */ e) => this.onTriggerKey(e, at));
    menu.addEventListener("keydown", (/** @type {KeyboardEvent} */ e) => this.onMenuKey(e, at));
    return el(doc, "div", { class: "menubar-slot", role: "none" }, trigger, menu);
  }

  /**
   * Fill in what can change (enabled, ticked, the words), then show the menu and put focus on its first or last item.
   * @param {number} at
   * @param {"first" | "last" | "none"} where
   */
  open(at, where) {
    if (this.openAt !== -1 && this.openAt !== at) this.close(false);
    const b = /** @type {Built} */ (this.built[at]);
    for (const { button, cmd } of b.items) drawItem(this.doc, button, cmd);
    b.menu.hidden = false;
    b.trigger.setAttribute("aria-expanded", "true");
    this.openAt = at;
    for (const x of this.built) x.trigger.setAttribute("tabindex", x === b ? "0" : "-1");
    if (where === "none") b.trigger.focus();
    else b.items[where === "first" ? 0 : b.items.length - 1]?.button.focus();
  }

  /**
   * @param {number} at
   * @param {number} index
   */
  choose(at, index) {
    const item = this.built[at]?.items[index];
    if (!item || item.button.getAttribute("aria-disabled") === "true") return;
    this.close(false);
    this.lastMenu = at;
    this.leave();
    item.cmd.run();
  }

  /**
   * @param {KeyboardEvent} e
   * @param {number} at
   */
  onTriggerKey(e, at) {
    const n = this.built.length;
    const go = (/** @type {number} */ to) => {
      e.preventDefault();
      if (this.openAt !== -1) this.open(to, "first");
      else this.focusTrigger(to);
    };
    switch (e.key) {
      case "ArrowRight":
        go(stepIndex(at, n, 1));
        break;
      case "ArrowLeft":
        go(stepIndex(at, n, -1));
        break;
      case "Home":
        go(0);
        break;
      case "End":
        go(n - 1);
        break;
      case "ArrowDown":
      case "Enter":
      case " ":
        e.preventDefault();
        this.open(at, "first");
        break;
      case "ArrowUp":
        e.preventDefault();
        this.open(at, "last");
        break;
      case "Escape":
        e.preventDefault();
        if (this.openAt !== -1) this.close();
        else this.leave();
        break;
      default:
        if (e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) {
          const to = letterIndex(
            this.built.map((b) => b.def.label),
            at,
            e.key,
          );
          if (to !== -1) {
            e.preventDefault();
            this.focusTrigger(to);
          }
        }
    }
  }

  /**
   * @param {KeyboardEvent} e
   * @param {number} at
   */
  onMenuKey(e, at) {
    const b = /** @type {Built} */ (this.built[at]);
    const now = b.items.findIndex((x) => x.button === this.doc.activeElement);
    const focusItem = (/** @type {number} */ i) => b.items[i]?.button.focus();
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        focusItem(stepIndex(now, b.items.length, 1));
        break;
      case "ArrowUp":
        e.preventDefault();
        focusItem(stepIndex(now, b.items.length, -1));
        break;
      case "Home":
        e.preventDefault();
        focusItem(0);
        break;
      case "End":
        e.preventDefault();
        focusItem(b.items.length - 1);
        break;
      case "ArrowRight":
        e.preventDefault();
        this.open(stepIndex(at, this.built.length, 1), "first");
        break;
      case "ArrowLeft":
        e.preventDefault();
        this.open(stepIndex(at, this.built.length, -1), "first");
        break;
      case "Escape":
        e.preventDefault();
        e.stopPropagation();
        this.close();
        break;
      case "Tab":
        this.close(false);
        break;
      case "Enter":
      case " ":
        e.preventDefault();
        this.choose(at, now);
        break;
      default:
        if (e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) {
          const labels = b.items.map((x) => x.button.querySelector(".menu-label")?.textContent ?? x.cmd.label);
          const to = letterIndex(labels, now, e.key);
          if (to !== -1) {
            e.preventDefault();
            focusItem(to);
          }
        }
    }
  }
}
