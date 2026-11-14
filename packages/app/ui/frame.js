// @ts-check
/**
 * The OpenStage suite's frame round every screen: the navy bar along the top (the icon and the name, the bank that is open, the
 * command search and the screen's main buttons), the menus under it, and the two windows the suite shares, the command search
 * (Ctrl+K) and the list of keyboard keys (Ctrl+/). Every command the menus hold is in one list here, so a command has the same words,
 * icon and keys in a menu, in the command search and on a button.
 *
 * A screen says what it can do by returning `actions` (ids and the functions that do them) from its render function, and the frame
 * asks for them each time a menu opens: a command the screen showing now does not offer stays in its menu, dimmed. A command that
 * belongs to Home (New bank and the two ways to open a file) goes to Home first when it is chosen elsewhere, and is done there.
 */

import { post, get } from "./api.js";
import { openCommandSearch, searchEntries } from "./commandsearch.js";
import { EDITABLE_TYPES, TYPE_NAMES } from "./dom.js";
import { openKeys } from "./keys.js";
import { MenuBar, el, uiIcon } from "./menubar.js";
import { checkForUpdates } from "./updates.js";

/**
 * @typedef {import("./menubar.js").MenuCommand} MenuCommand
 * @typedef {import("./menubar.js").MenuDef} MenuDef
 * @typedef {import("./menubar.js").MenuEntry} MenuEntry
 * @typedef {{ run: () => void, enabled?: () => boolean }} Action
 * @typedef {{ actions?: Record<string, Action>, title?: () => string }} ScreenOffer
 */

/** The screens that are about one bank, and so have a bank to print, export or make answer sheets for. */
const BANK_ROUTES = /^#\/(bank|export|print|sheets)\/([^/]+)$/;

/**
 * Which screen an address is, and the bank it is about, if any.
 * @param {string} hash
 * @returns {{ screen: string, bank: string | null }}
 */
export function routeOf(hash) {
  const bank = BANK_ROUTES.exec(hash);
  if (bank) return { screen: /** @type {string} */ (bank[1]), bank: decodeURIComponent(/** @type {string} */ (bank[2])) };
  if (/^#\/?$/.test(hash)) return { screen: "home", bank: null };
  const other = /^#\/([a-z]+)\//.exec(hash);
  return { screen: other ? /** @type {string} */ (other[1]) : "other", bank: null };
}

/** The kinds of question that can be written, as the Question menu lists them: "New multiple choice question". */
export function newQuestionLabel(/** @type {string} */ type) {
  const name = /** @type {Record<string, string>} */ (TYPE_NAMES)[type] ?? type;
  return `New ${name.charAt(0).toLowerCase()}${name.slice(1)} question`;
}

/** @type {Record<string, import("./menubar.js").UiIconName>} */
const KIND_ICONS = {
  multipleChoice: "circle-dot",
  multipleResponse: "list-checks",
  trueFalse: "circle-check",
  fillInBlank: "pencil-line",
  shortAnswer: "text-cursor-input",
  matching: "link",
  ordering: "list-ordered",
  numeric: "hash",
  essay: "file-text",
};

/**
 * The menus, with the commands that do things through `ctx`. Kept apart from the page so it can be tested without one.
 * @param {{ go: (hash: string) => void, hash: () => string, offer: () => ScreenOffer, onHome: (id: string) => void, showFolder: () => void, search: () => void, keys: () => void, updates?: () => void }} ctx
 * @returns {{ menus: MenuDef[], quick: MenuCommand[] }}  the menus, and the commands of the navy bar on a bank's screen
 */
export function buildMenus(ctx) {
  const route = () => routeOf(ctx.hash());
  /** A command the screen showing now does, if it offers it. */
  const screenAction = (/** @type {string} */ id) => ctx.offer().actions?.[id];
  /**
   * @param {string} id
   * @param {string} label
   * @param {import("./menubar.js").UiIconName} icon
   * @param {string} [title]
   * @returns {MenuCommand}
   */
  const offered = (id, label, icon, title) => ({
    label,
    icon,
    ...(title ? { title } : {}),
    run: () => screenAction(id)?.run(),
    enabled: () => {
      const action = screenAction(id);
      return !!action && (action.enabled ? action.enabled() : true);
    },
  });
  /**
   * A screen about a bank, reached by its address.
   * @param {string} screen
   * @param {string} label
   * @param {import("./menubar.js").UiIconName} icon
   * @param {string} title
   * @returns {MenuCommand}
   */
  const bankScreen = (screen, label, icon, title) => ({
    label,
    icon,
    title,
    run: () => {
      const bank = route().bank;
      if (bank !== null) ctx.go(`#/${screen}/${encodeURIComponent(bank)}`);
    },
    enabled: () => route().bank !== null && route().screen !== screen,
  });
  /**
   * One of Home's commands: done on Home, which is gone to first.
   * @param {string} id
   * @param {string} label
   * @param {import("./menubar.js").UiIconName} icon
   * @param {string} title
   * @returns {MenuCommand}
   */
  const home = (id, label, icon, title) => ({ label, icon, title, run: () => ctx.onHome(id) });

  const print = bankScreen("print", "Print…", "printer", "A student copy and an answer key, as Word or PDF");
  const sheets = bankScreen("sheets", "Answer sheets…", "clipboard-list", "Make a test with answer sheets to print, and score them from scans");
  const exportTo = bankScreen("export", "Export…", "file-output", "Write the bank for an LMS: Moodle, Brightspace, Canvas, Blackboard, QTI, GIFT, or a question spreadsheet");

  const menus = /** @type {MenuDef[]} */ ([
    {
      id: "file",
      label: "File",
      items: [
        home("newBank", "New bank…", "file-plus", "Make an empty bank and give it a name"),
        home("openBankFile", "Open a bank file…", "folder-open", "Open a .openassess file someone sent you, or a copy you kept"),
        home("importFile", "Bring in questions from a file…", "file-input", "Import a Word, Excel, CSV, PDF, text, Aiken, GIFT, Moodle XML, QTI or Common Cartridge file"),
        "-",
        { label: "Your banks", icon: "library", title: "Go back to the list of banks", run: () => ctx.go("#/"), enabled: () => route().screen !== "home" },
        { label: "Show the OpenAssess folder", icon: "folder-search", title: "Open the folder where banks and exports are kept", run: ctx.showFolder },
      ],
    },
    {
      id: "bank",
      label: "Bank",
      items: [
        offered("rename", "Rename…", "pencil", "Give this bank another name"),
        offered("folders", "Folders", "folder-tree", "Folders to sort the questions into"),
        offered("coverage", "Coverage", "grid-3x3", "What the bank covers: questions by objective, chapter, tag, Bloom level"),
        offered("checkQuality", "Check quality", "clipboard-check", "Notes on the writing of each question, copies, and where the right answers sit"),
        "-",
        offered("remove", "Remove…", "trash", "Move this bank to the Deleted folder"),
      ],
    },
    {
      id: "question",
      label: "Question",
      items: [
        ...EDITABLE_TYPES.map((type) => offered(`new:${type}`, newQuestionLabel(type), KIND_ICONS[type] ?? "file-text", "Write a new question of this kind")),
        "-",
        offered("search", "Search the questions", "search", "Go to the box that searches this bank's questions"),
        offered("clearFilters", "Clear filters", "funnel-x", "Show every question again"),
      ],
    },
    {
      id: "test",
      label: "Test",
      items: [print, sheets, exportTo],
    },
    {
      id: "help",
      label: "Help",
      items: [
        { label: "Search for a command", icon: "search", keys: "Ctrl+K", title: "Find any command by its name", run: ctx.search },
        { label: "Keyboard keys", icon: "keyboard", keys: "Ctrl+/", title: "Every key OpenAssess has", run: ctx.keys },
        "-",
        { label: "Check for updates...", icon: "refresh-cw", title: "Whether a newer OpenAssess is published. It asks GitHub only when you choose this, and installs nothing", run: ctx.updates ?? (() => void checkForUpdates()) },
      ],
    },
  ]);
  return { menus, quick: [print, sheets, exportTo] };
}

/** The menu bar's commands of one menu, for a button that offers the same ones (the "..." beside a bank's name). */
export function menuEntries(/** @type {MenuDef[]} */ menus, /** @type {string} */ id) {
  return menus.find((m) => m.id === id)?.items ?? [];
}

/**
 * Build the frame into the page, once. `navigate` goes to an address as the router does.
 * @param {Document} doc
 * @param {{ go: (hash: string) => void, notify: (message: string, kind?: "ok" | "error") => void }} shell
 */
export function startFrame(doc, shell) {
  /** @type {ScreenOffer} */
  let offer = {};
  /** A command of Home's chosen on another screen: done when Home has been drawn. @type {string | null} */
  let pending = null;

  const contextHost = /** @type {HTMLElement} */ (doc.getElementById("bar-context"));
  const buttonsHost = /** @type {HTMLElement} */ (doc.getElementById("bar-buttons"));
  const searchHost = /** @type {HTMLElement} */ (doc.getElementById("bar-search"));
  const menuHost = /** @type {HTMLElement} */ (doc.getElementById("menu-row"));
  const main = /** @type {HTMLElement} */ (doc.getElementById("main"));

  const search = () => openCommandSearch(doc, searchEntries(menus), { fallback: () => main });
  const keys = () => openKeys(doc);
  const { menus, quick } = buildMenus({
    go: shell.go,
    hash: () => location.hash || "#/",
    offer: () => offer,
    onHome: (id) => {
      if (routeOf(location.hash || "#/").screen === "home" && offer.actions?.[id]) offer.actions[id]?.run();
      else {
        pending = id;
        shell.go("#/");
      }
    },
    showFolder: async () => {
      try {
        const state = await get("state");
        await post("reveal", { path: state.home });
      } catch (error) {
        shell.notify(/** @type {Error} */ (error).message, "error");
      }
    },
    search,
    keys,
  });
  const bar = new MenuBar(doc, menus);
  menuHost.append(bar.element);

  // The list of questions stays in sight under the navy bar and the menus, which are taller when the window is narrow and they wrap.
  const top = doc.querySelector(".top");
  if (top && typeof ResizeObserver === "function") {
    new ResizeObserver(() => doc.documentElement.style.setProperty("--top-height", `${Math.round(top.getBoundingClientRect().height)}px`)).observe(top);
  }

  const searchButton = el(doc, "button", { type: "button", class: "bar-button", id: "bar-search-button", "aria-keyshortcuts": "Control+K", "aria-haspopup": "dialog", title: "Search for a command (Ctrl+K)" }, uiIcon(doc, "search"), el(doc, "span", { text: "Search" }));
  searchButton.setAttribute("aria-label", "Search for a command");
  searchButton.addEventListener("click", search);
  searchHost.append(searchButton);

  // Ctrl+K and Ctrl+/ work anywhere, except over a dialog that is asking something (the search itself takes Ctrl+K back to its box).
  doc.addEventListener("keydown", (e) => {
    if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return;
    const asking = [...doc.querySelectorAll("dialog[open]")].some((d) => !d.classList.contains("command-search"));
    if (e.key.toLowerCase() === "k" && !asking) {
      e.preventDefault();
      search();
    } else if (e.key === "/" && !asking) {
      e.preventDefault();
      keys();
    }
  });

  /** Draw the navy bar for the screen showing now: the bank it is about, and its main buttons. */
  const drawBar = () => {
    const route = routeOf(location.hash || "#/");
    contextHost.replaceChildren();
    buttonsHost.replaceChildren();
    if (route.bank !== null) {
      const title = offer.title?.() ?? route.bank;
      contextHost.append(el(doc, "span", { class: "bar-context-label", text: "Bank" }), el(doc, "span", { class: "bar-context-name", text: title, title }));
    }
    // On a bank's own screen: Print, Answer sheets and Export (filled, the screen's main way out), as the Test menu has them.
    if (route.screen === "bank") {
      quick.forEach((cmd, i) => {
        const button = el(doc, "button", { type: "button", class: i === quick.length - 1 ? "bar-button primary" : "bar-button", title: cmd.title ?? cmd.label }, cmd.icon ? uiIcon(doc, cmd.icon) : "", el(doc, "span", { text: cmd.label }));
        button.addEventListener("click", () => cmd.run());
        buttonsHost.append(button);
      });
    }
  };

  return {
    menus,
    bar,
    /**
     * A screen has been drawn: what it offers, and a command of Home's that was waiting for it.
     * @param {ScreenOffer | null} shown
     */
    screenShown(shown) {
      offer = shown ?? {};
      drawBar();
      if (pending && routeOf(location.hash || "#/").screen === "home") {
        const id = pending;
        pending = null;
        offer.actions?.[id]?.run();
      }
    },
    /** The screen's title changed (a bank renamed): draw the bar again. */
    refresh: drawBar,
  };
}
