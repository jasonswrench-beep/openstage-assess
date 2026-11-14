/**
 * Check for updates (`src/updates.ts`, the route in `src/api.ts`, `ui/updates.js`): notify only, asked for by the person, one request
 * to GitHub's list of OpenAssess's releases, and only a page of those releases offered as a link. No test here reaches the network,
 * except the two at the end, which run only when OPENASSESS_NETWORK_TESTS=1 is set.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  answerFrom,
  checkForUpdates,
  compareVersions,
  fetchReleases,
  isReleasePage,
  RELEASES_API,
  RELEASES_PAGE,
  releasePage,
  spoken,
  versionKey,
} from "../src/updates.ts";
// @ts-expect-error the interface is plain JavaScript, checked as such, and has no declaration file
import { describeAnswer, releaseLink } from "../ui/updates.js";
import { withApp } from "./support/app.ts";

const list = (...tags: Array<string | { tag: string; draft?: boolean }>): string =>
  JSON.stringify(tags.map((t) => (typeof t === "string" ? { tag_name: t, draft: false, prerelease: true } : { tag_name: t.tag, draft: t.draft ?? false })));

describe("versions", () => {
  test("sort as releases do: alpha 9 before alpha 10, alphas before betas before candidates, and the release itself last", () => {
    const order = ["v0.1.0-alpha.9", "v0.1.0-alpha.10", "v0.1.0-beta.1", "v0.1.0-rc.2", "v0.1.0", "v0.1.1-alpha.1", "v0.2.0", "v1.0.0"];
    for (let i = 1; i < order.length; i++) {
      assert.equal(compareVersions(versionKey(order[i - 1] as string) as number[], versionKey(order[i] as string) as number[]), -1, `${order[i - 1]} < ${order[i]}`);
    }
    assert.equal(compareVersions(versionKey("v0.1.0-alpha.26") as number[], versionKey("0.1.0-alpha.26") as number[]), 0);
  });

  test("anything that is not a plain version is not one", () => {
    for (const tag of ["", "latest", "v0.1", "v0.1.0-gamma.1", "v0.1.0-alpha", "v0.1.0-alpha.1.2", "v0.1.0 ", "v0.1.0-alpha.1/../../x", "v1234567.0.0"]) {
      assert.equal(versionKey(tag.trimEnd() === tag ? tag : `${tag}x`), undefined, JSON.stringify(tag));
    }
  });

  test("are said in words", () => {
    assert.equal(spoken("v0.1.0-alpha.26"), "0.1.0 alpha 26");
    assert.equal(spoken("v1.0.0"), "1.0.0");
  });
});

describe("the release pages", () => {
  test("a release's page is on OpenAssess's own releases, and a tag that is not a version gives the list", () => {
    assert.equal(releasePage("v0.1.0-alpha.26"), `${RELEASES_PAGE}/tag/v0.1.0-alpha.26`);
    assert.equal(releasePage("../../evil"), RELEASES_PAGE);
    assert.equal(releasePage("0.1.0"), RELEASES_PAGE, "a tag without its v is not one this repository makes");
    assert.equal(RELEASES_PAGE, "https://github.com/jasonswrench-beep/openstage-assess/releases");
    assert.equal(RELEASES_API, "https://api.github.com/repos/jasonswrench-beep/openstage-assess/releases?per_page=30");
  });

  test("only those pages are release pages, on the server and in the page", () => {
    const yes = [RELEASES_PAGE, `${RELEASES_PAGE}/tag/v0.1.0-alpha.26`, `${RELEASES_PAGE}/tag/v1.0.0`];
    const no = [
      `${RELEASES_PAGE}/tag/latest`,
      `${RELEASES_PAGE}/tag/v0.1.0-alpha.26?x=1`,
      `${RELEASES_PAGE}/tag/v0.1.0-alpha.26#top`,
      `${RELEASES_PAGE}/download/v0.1.0-alpha.26/setup.exe`,
      "https://github.com/someone-else/openstage-assess/releases",
      "https://github.com.example/jasonswrench-beep/openstage-assess/releases",
      "http://github.com/jasonswrench-beep/openstage-assess/releases",
      "https://user@github.com/jasonswrench-beep/openstage-assess/releases",
      "https://github.com:8443/jasonswrench-beep/openstage-assess/releases",
      "javascript:alert(1)",
      "",
    ];
    for (const url of yes) {
      assert.equal(isReleasePage(url), true, url);
      assert.equal(releaseLink(url), url, url);
    }
    for (const url of no) {
      assert.equal(isReleasePage(url), false, url);
      assert.equal(releaseLink(url), null, url);
    }
    assert.equal(releaseLink(42), null);
  });
});

describe("the answer", () => {
  test("names the newest release that is not a draft, pre-releases included, and links to its page", () => {
    const answer = answerFrom(list("v0.1.0-alpha.24", { tag: "v0.1.0-alpha.99", draft: true }, "v0.1.0-alpha.26", "v0.1.0-alpha.25", "not-a-version"), "v0.1.0-alpha.25");
    assert.equal(answer.state, "newer");
    assert.equal(answer.state === "newer" && answer.latest, "0.1.0 alpha 26");
    assert.equal(answer.state === "newer" && answer.url, `${RELEASES_PAGE}/tag/v0.1.0-alpha.26`);
    assert.match(answer.message, /OpenAssess 0\.1\.0 alpha 26 is out\. This copy is 0\.1\.0 alpha 25\./);
  });

  test("says this copy is the newest when it is, or newer than any published", () => {
    assert.equal(answerFrom(list("v0.1.0-alpha.26"), "v0.1.0-alpha.26").state, "current");
    assert.equal(answerFrom(list("v0.1.0-alpha.25"), "v0.1.0-alpha.26").state, "current");
  });

  test("tells a copy that was not made by the setup which release is the newest", () => {
    const answer = answerFrom(list("v0.1.0-alpha.26"), undefined);
    assert.equal(answer.state, "unknown");
    assert.match(answer.message, /The newest release of OpenAssess is 0\.1\.0 alpha 26/);
  });

  test("says in words when the list cannot be read or holds no release, and offers the list of releases", () => {
    for (const text of ["", "{", "{}", "null", '"x"', list(), list({ tag: "v9.9.9", draft: true }), JSON.stringify([null, 1, "v1.0.0", { tag_name: 5 }])]) {
      const answer = answerFrom(text, "v0.1.0-alpha.26");
      assert.equal(answer.state, "error", text);
      assert.equal(answer.state === "error" && answer.url, RELEASES_PAGE);
    }
  });

  test("is off, and asks nothing of the network, when checking is turned off", async () => {
    let asked = 0;
    const answer = await checkForUpdates({ enabled: false, fetchReleases: async () => { asked++; return list("v9.0.0"); } });
    assert.equal(answer.state, "off");
    assert.equal(asked, 0);
  });

  test("says what to do when GitHub cannot be reached, and does not throw", async () => {
    const answer = await checkForUpdates({ enabled: true, current: "v0.1.0-alpha.26", fetchReleases: async () => { throw new Error("offline"); } });
    assert.equal(answer.state, "error");
    assert.match(answer.message, /could not reach GitHub/);
  });

  test("is shown in the page in words, with a link only to a release page and none when checking is off", () => {
    assert.deepEqual(describeAnswer({ state: "newer", latest: "0.1.0 alpha 27", message: "out", url: `${RELEASES_PAGE}/tag/v0.1.0-alpha.27` }), { words: "out", link: `${RELEASES_PAGE}/tag/v0.1.0-alpha.27`, linkLabel: "Open the page of OpenAssess 0.1.0 alpha 27" });
    assert.equal(describeAnswer({ state: "newer", latest: "x", message: "out", url: "https://example.invalid/" }).link, null);
    assert.equal(describeAnswer({ state: "off", message: "off", url: RELEASES_PAGE }).link, null);
    assert.match(describeAnswer(undefined).words, /could not be read/);
  });
});

describe("the route", () => {
  test("answers a POST with the answer, from the release the window gave and the list it fetched", async () => {
    let asked = 0;
    await withApp(
      async (client) => {
        const reply = await client.post("/api/updates/check", {});
        assert.equal(reply.status, 200);
        assert.equal(reply.json["state"], "newer");
        assert.equal(reply.json["url"], `${RELEASES_PAGE}/tag/v0.1.0-alpha.27`);
        assert.equal(asked, 1, "one request, when asked");
      },
      { updates: { current: "v0.1.0-alpha.26", fetchReleases: async () => { asked++; return list("v0.1.0-alpha.27", "v0.1.0-alpha.26"); } } },
    );
  });

  test("is not there for a GET, and asks nothing then", async () => {
    let asked = 0;
    await withApp(
      async (client) => {
        const reply = await client.get("/api/updates/check");
        assert.equal(reply.status, 404);
        assert.equal(asked, 0);
      },
      { updates: { fetchReleases: async () => { asked++; return list("v1.0.0"); } } },
    );
  });

  test("says checking is turned off when the server was started with it off", async () => {
    await withApp(
      async (client) => {
        const reply = await client.post("/api/updates/check", {});
        assert.equal(reply.json["state"], "off");
      },
      { updates: { enabled: false, fetchReleases: async () => { throw new Error("must not be asked"); } } },
    );
  });
});

describe("the request itself (only with OPENASSESS_NETWORK_TESTS=1)", { skip: process.env["OPENASSESS_NETWORK_TESTS"] !== "1" }, () => {
  test("GitHub's list of OpenAssess's releases is read, and holds this repository's tags", async () => {
    const answer = answerFrom(await fetchReleases(), "v0.1.0-alpha.1");
    assert.ok(answer.state === "newer" || answer.state === "current", answer.message);
  });

  test("a redirect is refused, not followed", async () => {
    // GitHub answers the page of the latest release with a redirect to that release's page.
    await assert.rejects(fetchReleases(`${RELEASES_PAGE}/latest`), /redirect, which is not followed/);
  });
});
