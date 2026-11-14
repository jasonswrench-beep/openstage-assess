/**
 * Check for updates: whether a newer OpenAssess is published. Notify only.
 *
 * It runs only when the person asks (Help > Check for updates); nothing is checked at start-up, on a timer or in the background. It
 * says whether a newer release is published and, if so, gives that release's page on GitHub, where the notes, the checksum and the
 * signed setup are. It downloads and installs nothing; the person runs the new setup, which updates the copy in place and keeps the
 * banks.
 *
 * One HTTPS request, from this server, to GitHub's list of OpenAssess's releases (`RELEASES_API`): the certificate is checked (Node's
 * own), no redirect is followed, at most 2 MB is read, and it gives up after 15 seconds. Pre-releases count, because every release so
 * far is one; drafts never do. The request carries only a plain user agent; nothing about the person, their banks or their computer is
 * sent.
 *
 * The release this copy is comes from the window, which the installer's build gives it (`--release`, from `OPENASSESS_RELEASE`). A copy
 * run from the source has none, and is told which release is the newest. `OPENSTAGE_UPDATE_CHECK=off`, `--no-update-check`, or an
 * `update-check.txt` saying `off` beside the window's program turns the check off on a computer: the answer then says so and nothing
 * is asked of the network. (The security review of 2026-11-13 asked every tool of the suite for this button.)
 */

import { request } from "node:https";

/** The repository whose releases are OpenAssess's. */
export const REPOSITORY = "jasonswrench-beep/openstage-assess";
export const RELEASES_PAGE = `https://github.com/${REPOSITORY}/releases`;
export const RELEASES_API = `https://api.github.com/repos/${REPOSITORY}/releases?per_page=30`;

/** The most of the answer that is read, and how long it is waited for. */
export const MAX_ANSWER_BYTES = 2 * 1024 * 1024;
export const TIMEOUT_MS = 15_000;

export type UpdateAnswer =
  | { state: "off"; message: string }
  | { state: "current"; message: string; latest: string; url: string }
  | { state: "newer"; message: string; latest: string; url: string }
  | { state: "unknown"; message: string; latest: string; url: string }
  | { state: "error"; message: string; url: string };

export interface UpdateSettings {
  /** The release this copy is (a tag such as v0.1.0-alpha.26), when the installer's build recorded one. */
  current?: string;
  /** False when checking is turned off on this computer. */
  enabled: boolean;
  /** The text of GitHub's list of releases. Replaced in tests, which never reach the network. */
  fetchReleases: () => Promise<string>;
}

const STAGES: Record<string, number> = { alpha: 0, beta: 1, rc: 2 };
const VERSION = /^v?(\d{1,6})\.(\d{1,6})\.(\d{1,6})(?:-(alpha|beta|rc)\.(\d{1,6}))?$/;

/**
 * A version as numbers that sort as releases do: 0.1.0-alpha.9 before 0.1.0-alpha.10, the betas after the alphas, and a release
 * with no stage after all of its pre-releases. Anything that is not a plain version is undefined.
 */
export function versionKey(tag: string): [number, number, number, number, number] | undefined {
  const m = VERSION.exec(tag.trim());
  if (!m) return undefined;
  const stage = m[4] === undefined ? 3 : (STAGES[m[4]] as number);
  return [Number(m[1]), Number(m[2]), Number(m[3]), stage, m[5] === undefined ? 0 : Number(m[5])];
}

export function compareVersions(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return Math.sign(d);
  }
  return 0;
}

/** "0.1.0 alpha 26" for v0.1.0-alpha.26. */
export function spoken(tag: string): string {
  const v = tag.trim().replace(/^v/, "");
  const at = v.indexOf("-");
  return at === -1 ? v : `${v.slice(0, at)} ${v.slice(at + 1).replace(/\./g, " ")}`;
}

/** The page of one release of OpenAssess, and only of OpenAssess: a tag that is not a plain version gives the list of releases. */
export function releasePage(tag: string): string {
  return tag.startsWith("v") && versionKey(tag) ? `${RELEASES_PAGE}/tag/${tag}` : RELEASES_PAGE;
}

/** Whether an address is a page of OpenAssess's releases (the list, or one release by its tag). The window opens no other. */
export function isReleasePage(url: string): boolean {
  if (url === RELEASES_PAGE) return true;
  const tag = url.startsWith(`${RELEASES_PAGE}/tag/`) ? url.slice(`${RELEASES_PAGE}/tag/`.length) : undefined;
  return tag !== undefined && tag.startsWith("v") && versionKey(tag) !== undefined;
}

/** The answer for the page, from the text of GitHub's list of releases and the release this copy is. */
export function answerFrom(text: string, current: string | undefined): UpdateAnswer {
  let list: unknown;
  try {
    list = JSON.parse(text);
  } catch {
    list = undefined;
  }
  if (!Array.isArray(list)) {
    return { state: "error", message: "The list of releases could not be read. Try again later, or look at the releases page.", url: RELEASES_PAGE };
  }
  let newest: { key: number[]; tag: string } | undefined;
  for (const release of list) {
    if (release === null || typeof release !== "object") continue;
    const r = release as Record<string, unknown>;
    if (r["draft"] === true || typeof r["tag_name"] !== "string") continue;
    const tag = r["tag_name"];
    const key = tag.startsWith("v") ? versionKey(tag) : undefined;
    if (key && (!newest || compareVersions(key, newest.key) > 0)) newest = { key, tag };
  }
  if (!newest) return { state: "error", message: "No release of OpenAssess was found. Look at the releases page.", url: RELEASES_PAGE };
  const latest = spoken(newest.tag);
  const url = releasePage(newest.tag);
  const mine = current ? versionKey(current) : undefined;
  if (!current || !mine) {
    return { state: "unknown", latest, url, message: `The newest release of OpenAssess is ${latest}. This copy was not made by the setup, so it cannot say which release it is.` };
  }
  if (compareVersions(newest.key, mine) > 0) {
    return { state: "newer", latest, url, message: `OpenAssess ${latest} is out. This copy is ${spoken(current)}. Its page has what changed and the setup to download; running the setup updates this copy and keeps your banks.` };
  }
  return { state: "current", latest, url, message: `This copy is the newest release, ${spoken(current)}.` };
}

/**
 * GitHub's list of OpenAssess's releases, as text: one GET, the certificate checked, no redirect followed, at most 2 MB, 15 seconds.
 * The address is a parameter only for the network test that checks a redirect is refused; the program always asks `RELEASES_API`.
 */
export function fetchReleases(url: string = RELEASES_API): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = request(
      url,
      {
        method: "GET",
        headers: { "User-Agent": "OpenAssess-update-check", Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
        timeout: TIMEOUT_MS,
      },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(res.statusCode !== undefined && res.statusCode >= 300 && res.statusCode < 400 ? "GitHub answered with a redirect, which is not followed." : `GitHub answered ${res.statusCode ?? "nothing"}.`));
          return;
        }
        const parts: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_ANSWER_BYTES) {
            req.destroy(new Error("The list of releases was larger than it should be."));
            return;
          }
          parts.push(chunk);
        });
        res.on("end", () => resolve(Buffer.concat(parts).toString("utf8")));
        res.on("error", reject);
      },
    );
    req.on("timeout", () => req.destroy(new Error("GitHub did not answer in time.")));
    req.on("error", reject);
    req.end();
  });
}

/** The answer to Check for updates, with these settings. Never throws: a failure is an answer that says what to do. */
export async function checkForUpdates(settings: UpdateSettings): Promise<UpdateAnswer> {
  if (!settings.enabled) return { state: "off", message: "Checking for updates is turned off on this computer." };
  let text: string;
  try {
    text = await settings.fetchReleases();
  } catch {
    return { state: "error", message: "OpenAssess could not reach GitHub to check. Check the internet connection and try again, or look at the releases page.", url: RELEASES_PAGE };
  }
  return answerFrom(text, settings.current);
}
