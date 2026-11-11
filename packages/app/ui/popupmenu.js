// @ts-check
// Copied from OpenStage Author (editor/src/popupmenu.ts, Apache-2.0, the same owner) for the OpenStage suite's look, by way of
// OpenExplainer's copy, and written as plain JavaScript here (see NOTICE). Keep them alike: a fix in one belongs in the others.
//
// A menu that opens from a button (the "..." beside a bank's name). It follows the menu button pattern of the WAI-ARIA Authoring
// Practices and behaves like the menus under the navy bar (menubar.js):
//  - Enter, Space or Down on the button opens the menu on its first item; Up opens it on its last.
//  - In the menu, Up and Down move (round from the end to the start), Home and End go to the first and last item, a letter goes to the
//    next item that starts with it, Enter or Space chooses, Escape or Tab closes the menu and goes back to the button.
//  - An item that cannot be used now stays in the menu, dimmed, so people learn where things are.
//  - Choosing an item first puts focus back on the button, then runs the command, so a dialog the command opens gives focus back to
//    the button when it closes.
// The pure parts (where the menu goes on the screen, tidying the lines between groups) are at the top, so they can be tested without
// a page.

import { drawItem, el, letterIndex, newItem, stepIndex, uiIcon } from "./menubar.js";

/**
 * @typedef {import("./menubar.js").MenuCommand} MenuCommand
 * @typedef {import("./menubar.js").MenuEntry} MenuEntry
 * @typedef {import("./menubar.js").UiIconName} UiIconName
 * @typedef {{ left: number, top: number, right: number, bottom: number }} Box
 */

/**
 * Where a menu of this size goes: under the box (or over it, if there is no room under but there is over), lined up with the box's
 * left edge (or its right edge, if there is no room to the right), and always at least `margin` from the edges of the window.
 * @param {Box} anchor
 * @param {{ width: number, height: number }} size
 * @param {{ width: number, height: number }} view
 * @param {number} [margin]
 * @returns {{ left: number, top: number }}
 */
export function placeMenu(anchor, size, view, margin = 8) {
  let left = anchor.left;
  if (left + size.width > view.width - margin) left = anchor.right - size.width;
  left = Math.max(margin, Math.min(left, view.width - margin - size.width));
  let top = anchor.bottom + 2;
  if (top + size.height > view.height - margin && anchor.top - 2 - size.height >= margin) top = anchor.top - 2 - size.height;
  top = Math.max(margin, Math.min(top, view.height - margin - size.height));
  return { left, top };
}

/**
 * Lines between groups only between items: none at the start or the end, and never two together.
 * @param {readonly MenuEntry[]} entries
 * @returns {MenuEntry[]}
 */
export function tidyEntries(entries) {
  /** @type {MenuEntry[]} */
  const out = [];
  for (const e of entries) {
    if (e === "-" && (out.length === 0 || out[out.length - 1] === "-")) continue;
    out.push(e);
  }
  while (out[out.length - 1] === "-") out.pop();
  return out;
}

// ---- the page

/** Only one of these menus is open at a time. @type {PopupMenu | null} */
let openNow = null;

export class PopupMenu {
  /**
   * @param {Document} doc
   * @param {string} id
   * @param {string} label
   */
  constructor(doc, id, label) {
    this.doc = doc;
    this.label = label;
    /** @type {{ button: HTMLElement, cmd: MenuCommand }[]} */
    this.items = [];
    /** @type {HTMLElement | null} */
    this.trigger = null;
    /** Takes away the listeners on the page when the screen that made the menu goes (`destroy`). */
    this.ending = new AbortController();
    const signal = this.ending.signal;
    /** @type {HTMLElement} */
    this.element = el(doc, "div", { class: "menu popup-menu", id, role: "menu", "aria-label": label, hidden: true });
    doc.body.append(this.element);
    this.element.addEventListener("keydown", (/** @type {KeyboardEvent} */ e) => this.onKey(e));
    // Focus going somewhere else (F10 to the menus, say) closes it. Not the button that opened it: pressing that closes it itself.
    this.element.addEventListener("focusout", (/** @type {FocusEvent} */ e) => {
      const to = /** @type {Node | null} */ (e.relatedTarget);
      if (to && !this.element.contains(to) && !this.trigger?.contains(to)) this.close(false);
    });
    // So does a click anywhere else, scrolling under it, the window changing size, and leaving the program.
    doc.addEventListener(
      "pointerdown",
      (e) => {
        const on = /** @type {Node} */ (e.target);
        if (this.isOpen && !this.element.contains(on) && !this.trigger?.contains(on)) this.close(false);
      },
      { capture: true, signal },
    );
    doc.addEventListener(
      "scroll",
      (e) => {
        if (this.isOpen && !this.element.contains(/** @type {Node} */ (e.target))) this.close(false);
      },
      { capture: true, signal },
    );
    doc.defaultView?.addEventListener("resize", () => this.close(false), { signal });
    doc.defaultView?.addEventListener("blur", () => this.close(false), { signal });
  }

  /** Take the menu out of the page with its listeners, when the screen that made it goes. */
  destroy() {
    this.close(false);
    this.ending.abort();
    this.element.remove();
    if (openNow === this) openNow = null;
  }

  get isOpen() {
    return !this.element.hidden;
  }

  /**
   * Show these commands beside the button, with focus on the first item (or the last).
   * @param {readonly MenuEntry[]} entries
   * @param {HTMLElement} trigger
   * @param {"first" | "last"} [where]
   */
  open(entries, trigger, where = "first") {
    if (openNow && openNow !== this) openNow.close(false);
    this.close(false);
    const doc = this.doc;
    this.items = [];
    /** @type {HTMLElement[]} */
    const kids = [];
    for (const entry of tidyEntries(entries)) {
      if (entry === "-") {
        kids.push(el(doc, "div", { class: "menu-separator", role: "separator" }));
        continue;
      }
      const button = newItem(doc, entry);
      drawItem(doc, button, entry);
      button.addEventListener("click", () => this.choose(button));
      button.addEventListener("pointermove", () => {
        if (doc.activeElement !== button) button.focus();
      });
      this.items.push({ button, cmd: entry });
      kids.push(button);
    }
    this.element.replaceChildren(...kids);
    this.trigger = trigger;
    trigger.setAttribute("aria-expanded", "true");
    // Measured where it cannot push anything about, then put in its place.
    this.element.style.left = "0px";
    this.element.style.top = "0px";
    this.element.hidden = false;
    const box = trigger.getBoundingClientRect();
    const size = this.element.getBoundingClientRect();
    const view = { width: doc.documentElement.clientWidth, height: doc.documentElement.clientHeight };
    const p = placeMenu(box, { width: size.width, height: size.height }, view);
    this.element.style.left = `${Math.round(p.left)}px`;
    this.element.style.top = `${Math.round(p.top)}px`;
    openNow = this;
    this.items[where === "first" ? 0 : this.items.length - 1]?.button.focus();
  }

  /**
   * Close it; with `giveBack`, focus goes back to the button that opened it.
   * @param {boolean} [giveBack]
   */
  close(giveBack = true) {
    if (!this.isOpen) return;
    this.element.hidden = true;
    this.trigger?.setAttribute("aria-expanded", "false");
    if (openNow === this) openNow = null;
    if (giveBack && this.trigger?.isConnected) this.trigger.focus();
  }

  /** @param {HTMLElement} button */
  choose(button) {
    const item = this.items.find((x) => x.button === button);
    if (!item || button.getAttribute("aria-disabled") === "true") return;
    this.close(true);
    item.cmd.run();
  }

  /** @param {KeyboardEvent} e */
  onKey(e) {
    const now = this.items.findIndex((x) => x.button === this.doc.activeElement);
    const go = (/** @type {number} */ i) => this.items[i]?.button.focus();
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        go(stepIndex(now, this.items.length, 1));
        break;
      case "ArrowUp":
        e.preventDefault();
        go(stepIndex(now, this.items.length, -1));
        break;
      case "Home":
        e.preventDefault();
        go(0);
        break;
      case "End":
        e.preventDefault();
        go(this.items.length - 1);
        break;
      case "Escape":
        e.preventDefault();
        e.stopPropagation();
        this.close(true);
        break;
      case "Tab":
        e.preventDefault();
        this.close(true);
        break;
      case "Enter":
      case " ":
        e.preventDefault();
        if (now !== -1) this.choose(/** @type {{ button: HTMLElement }} */ (this.items[now]).button);
        break;
      default:
        if (e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) {
          const labels = this.items.map((x) => x.button.querySelector(".menu-label")?.textContent ?? x.cmd.label);
          const to = letterIndex(labels, now, e.key);
          if (to !== -1) {
            e.preventDefault();
            go(to);
          }
        }
    }
  }
}

/**
 * A button that opens a menu under it: "..." with only its icon (and its name for a screen reader and the tooltip), or an icon and a
 * word. What is in the menu is asked each time it opens.
 * @param {Document} doc
 * @param {{ id: string, text?: string, name: string, icon: UiIconName, entries: () => readonly MenuEntry[] }} opts
 * @returns {{ button: HTMLButtonElement, menu: PopupMenu }}
 */
export function menuButton(doc, opts) {
  const menuId = `${opts.id}-menu`;
  const menu = new PopupMenu(doc, menuId, opts.name);
  /** @type {HTMLButtonElement} */
  const button = el(
    doc,
    "button",
    { type: "button", class: `panel-menu-button${opts.text ? "" : " icon-only"}`, id: opts.id, "aria-haspopup": "menu", "aria-expanded": "false", "aria-controls": menuId, title: opts.name },
    uiIcon(doc, opts.icon),
  );
  if (opts.text) button.append(el(doc, "span", { text: opts.text }));
  if (opts.name !== opts.text) button.setAttribute("aria-label", opts.name);
  const show = (/** @type {"first" | "last"} */ where) => menu.open(opts.entries(), button, where);
  button.addEventListener("click", () => {
    if (menu.isOpen) menu.close(true);
    else show("first");
  });
  button.addEventListener("keydown", (/** @type {KeyboardEvent} */ e) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      show("first");
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      show("last");
    }
  });
  return { button, menu };
}
