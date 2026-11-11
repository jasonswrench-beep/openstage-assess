// @ts-check
/**
 * The shell: which screen is showing, a message line that is read out as it changes, and a guard so that a change that
 * was not saved is not lost by going somewhere else. The navy bar and the menus round every screen are frame.js's.
 */

import { clear, h, screenFocus, skipTo } from "./dom.js";
import { menuEntries, startFrame } from "./frame.js";

const main = /** @type {HTMLElement} */ (document.getElementById("main"));
const status = /** @type {HTMLElement} */ (document.getElementById("status"));
const skip = document.querySelector(".skip");
if (skip) skipTo(/** @type {HTMLElement} */ (skip), main);
// The first screen is not given focus: with focus already in the main area, the first Tab went past the skip link to the first
// button, so the link was reached only backwards. A screen that is moved to afterwards is (the rule is in dom.js, where it is tested).
const focusAfterScreen = screenFocus();

/** @type {{ canLeave?: () => Promise<boolean>, dirty?: () => boolean, leave?: () => void, actions?: Record<string, { run: () => void, enabled?: () => boolean }>, title?: () => string } | null} */
let current = null;
let lastHash = location.hash || "#/";
let asking = false;
let toastTimer = 0;
let speakTimer = 0;

/**
 * The message line stays in the page all the time and is empty when there is nothing to say (an empty one is not drawn: `.toast:empty`).
 * It used to be hidden until a message arrived, and a region that appears at the same moment as its words is often not read out; it
 * was also cleared and set in one go, so the same message twice in a row, such as two saves, was not read the second time.
 * @param {string} message
 * @param {"ok" | "error"} [kind]
 */
export function notify(message, kind = "ok") {
  status.textContent = "";
  status.className = kind === "error" ? "toast error" : "toast";
  clearTimeout(speakTimer);
  clearTimeout(toastTimer);
  speakTimer = window.setTimeout(() => (status.textContent = message), 50);
  toastTimer = window.setTimeout(() => (status.textContent = ""), kind === "error" ? 15000 : 6000);
}

/** @param {string} hash */
export function go(hash) {
  if (location.hash === hash) void show();
  else location.hash = hash;
}

const frame = startFrame(document, { notify, go });

const shell = {
  notify,
  go,
  /** The commands of one of the menus, for a button on a screen that offers the same ones. */
  menuEntries: (/** @type {string} */ id) => menuEntries(frame.menus, id),
  /** Draw the navy bar again, when what it shows has changed (a bank renamed). */
  refreshFrame: () => frame.refresh(),
};

/** @type {Array<[RegExp, string, string]>} */
const ROUTES = [
  [/^#\/?$/, "./home.js", "renderHome"],
  [/^#\/import\/([^/]+)$/, "./review.js", "renderReview"],
  [/^#\/bank\/([^/]+)$/, "./bank.js", "renderBank"],
  [/^#\/export\/([^/]+)$/, "./export.js", "renderExport"],
  [/^#\/print\/([^/]+)$/, "./print.js", "renderPrint"],
  [/^#\/sheets\/([^/]+)$/, "./sheets.js", "renderSheets"],
  [/^#\/score\/([^/]+)$/, "./scoring.js", "renderScoring"],
];

async function show() {
  const hash = location.hash || "#/";
  current?.leave?.();
  clear(main);
  current = null;
  for (const [pattern, file, name] of ROUTES) {
    const match = pattern.exec(hash);
    if (!match) continue;
    const value = match[1] === undefined ? undefined : decodeURIComponent(match[1]);
    main.append(h("p", { class: "placeholder", text: "Opening…" }));
    try {
      const module = await import(file);
      const body = h("div", { class: "screen" });
      clear(main);
      main.append(body);
      current = (await module[name](body, { id: value, name: value }, shell)) ?? null;
    } catch (error) {
      clear(main);
      main.append(
        h(
          "div",
          { class: "screen" },
          h("h1", { text: "That could not be opened" }),
          h("p", { class: "problem", text: /** @type {Error} */ (error).message || "Something went wrong." }),
          h("a", { class: "button", href: "#/", text: "Back to your banks" }),
        ),
      );
    }
    document.title = "OpenAssess";
    frame.screenShown(current);
    focusAfterScreen(main);
    return;
  }
  frame.screenShown(null);
  focusAfterScreen(null); // a page that is not a screen is still the first thing shown
  clear(main);
  main.append(h("div", { class: "screen" }, h("h1", { text: "There is nothing here" }), h("a", { class: "button", href: "#/", text: "Back to your banks" })));
}

// Going somewhere else asks first if there is a change that is not saved. If the person says to stay, the address is put
// back, and the event that causes is recognised by its address being the one already shown: no flag is kept, because a
// flag that is set and never used (the address was already right) would swallow the next real move.
window.addEventListener("hashchange", async () => {
  const target = location.hash || "#/";
  if (target === lastHash || asking) return;
  if (current?.canLeave) {
    asking = true;
    const fine = await current.canLeave();
    asking = false;
    if (!fine) {
      if ((location.hash || "#/") !== lastHash) location.hash = lastHash;
      return;
    }
  }
  lastHash = location.hash || "#/";
  await show();
});

window.addEventListener("beforeunload", (event) => {
  if (current?.dirty?.()) {
    event.preventDefault();
  }
});

void show();
