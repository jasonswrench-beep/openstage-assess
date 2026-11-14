// @ts-check
/**
 * Help > Check for updates: asks this program's own server, once, whether a newer OpenAssess is published, and says the answer in
 * words. Notify only: nothing is downloaded or installed. The server asks GitHub (`src/updates.ts`); the page itself reaches for no
 * other address, and offers a link only to a page of OpenAssess's releases, which the window opens in the person's own browser.
 */

import { post } from "./api.js";
import { ask } from "./dialogs.js";
import { h } from "./dom.js";

/** The path of OpenAssess's releases on GitHub. The server gives the whole address; this is only what it must be. */
const RELEASES_PATH = "/jasonswrench-beep/openstage-assess/releases";

/**
 * The address to offer, when it is a page of OpenAssess's releases (the list, or one release by its tag), or null.
 * @param {unknown} url
 * @returns {string | null}
 */
export function releaseLink(url) {
  if (typeof url !== "string") return null;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" || parsed.hostname !== "github.com" || parsed.port !== "" || parsed.username !== "" || parsed.password !== "" || parsed.search !== "" || parsed.hash !== "") return null;
  const path = parsed.pathname;
  const tag = path.startsWith(`${RELEASES_PATH}/tag/`) ? path.slice(`${RELEASES_PATH}/tag/`.length) : null;
  if (path === RELEASES_PATH || (tag !== null && /^v\d{1,6}\.\d{1,6}\.\d{1,6}(?:-(?:alpha|beta|rc)\.\d{1,6})?$/.test(tag))) return parsed.href;
  return null;
}

/**
 * What the dialog says, from the server's answer.
 * @param {any} answer
 * @returns {{ words: string, link: string | null, linkLabel: string }}
 */
export function describeAnswer(answer) {
  const words = typeof answer?.message === "string" && answer.message !== "" ? answer.message : "The answer could not be read. Try again later.";
  const link = answer?.state === "off" ? null : releaseLink(answer?.url);
  const linkLabel = answer?.state === "newer" ? `Open the page of OpenAssess ${answer.latest}` : "Open the releases page";
  return { words, link, linkLabel };
}

/** Asks, and shows the answer. */
export async function checkForUpdates() {
  /** @type {any} */
  let answer;
  try {
    answer = await post("updates/check", {});
  } catch (error) {
    answer = { state: "error", message: /** @type {Error} */ (error).message };
  }
  const { words, link, linkLabel } = describeAnswer(answer);
  /** @type {(Node | string)[]} */
  const body = [h("p", { text: words, attrs: { role: "status" } })];
  if (link) {
    // A new window is never opened for it: the window opens the page in the person's own browser, and a browser opens a tab.
    body.push(h("p", null, h("a", { href: link, text: linkLabel, attrs: { target: "_blank", rel: "noopener noreferrer" } })));
  }
  body.push(h("p", { class: "hint", text: "OpenAssess asks GitHub only when you choose this, sends nothing about you or your banks, and installs nothing." }));
  await ask({ title: "Check for updates", body, actions: [{ label: "Close", value: null, primary: true }] });
}
