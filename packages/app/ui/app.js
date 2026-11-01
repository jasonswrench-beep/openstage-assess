// @ts-check
/**
 * The shell: which screen is showing, a message line that is read out as it changes, and a guard so that a change that
 * was not saved is not lost by going somewhere else.
 */

import { clear, h } from "./dom.js";

const main = /** @type {HTMLElement} */ (document.getElementById("main"));
const status = /** @type {HTMLElement} */ (document.getElementById("status"));

/** @type {{ canLeave?: () => Promise<boolean>, dirty?: () => boolean } | null} */
let current = null;
let lastHash = location.hash || "#/";
let asking = false;
let toastTimer = 0;

/**
 * @param {string} message
 * @param {"ok" | "error"} [kind]
 */
export function notify(message, kind = "ok") {
  status.textContent = message;
  status.className = kind === "error" ? "toast error" : "toast";
  status.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    status.hidden = true;
    status.textContent = "";
  }, kind === "error" ? 15000 : 6000);
}

/** @param {string} hash */
export function go(hash) {
  if (location.hash === hash) void show();
  else location.hash = hash;
}

const shell = { notify, go };

/** @type {Array<[RegExp, string, string]>} */
const ROUTES = [
  [/^#\/?$/, "./home.js", "renderHome"],
  [/^#\/import\/([^/]+)$/, "./review.js", "renderReview"],
  [/^#\/bank\/([^/]+)$/, "./bank.js", "renderBank"],
  [/^#\/export\/([^/]+)$/, "./export.js", "renderExport"],
];

async function show() {
  const hash = location.hash || "#/";
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
    main.focus({ preventScroll: true });
    return;
  }
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
