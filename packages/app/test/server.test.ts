/**
 * The local server, as a person's window and as anything else on the computer would meet it. The first half is about who
 * is let in: a page open in another tab, a name pointed at this machine, a request that did not come from the app. The
 * second is the work: importing a file, repairing a question, saving it into a bank, and finding it again.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { docx, paragraph, run } from "../../assess/test/support/docx-writer.ts";
import { Bank, unzipSync } from "../src/engine.ts";
import { checkName, cleanName, fitFileName, placeFile, writeNewFile } from "../src/library.ts";
import { revealCommand } from "../src/server.ts";
import { chunkedPost, liarPost, liarPostReply, rawRequest, withApp, type Client } from "./support/app.ts";

const FIXTURES = fileURLToPath(new URL("../../../fixtures/standard-format/", import.meta.url));

const BANK_TEXT = [
  "1. What is the capital of France?",
  "a. Berlin",
  "*b. Paris",
  "c. Rome",
  "",
  "2. What is the capital of Spain?",
  "a. Lisbon",
  "b. Madrid",
  "c. Paris",
  "",
].join("\n");

const text = (value: string): Buffer => Buffer.from(value, "utf8");

interface SessionView {
  id: string;
  file: string;
  counts: { parsed: number; needsReview: number; failed: number; orphans: number; skipped: number; total: number };
  questions: Array<{ index: number; id: string; verdict: string; title: string; type: string; skipped: boolean }>;
  orphans: Array<{ index: number; text: string; made: boolean }>;
  source: string[];
  fileFindings: Array<{ message: string }>;
}

async function importText(client: Client, name = "bank.txt", body: string = BANK_TEXT): Promise<SessionView> {
  const reply = await client.send<SessionView>("POST", `/api/import?name=${encodeURIComponent(name)}`, text(body));
  assert.equal(reply.status, 200, reply.text);
  return reply.json;
}

describe("who is let in", () => {
  test("a request with no key is turned away, for the page and for the API", async () => {
    await withApp(async (client) => {
      client.cookie = "";
      assert.equal((await client.get("/")).status, 401);
      const api = await client.get("/api/state");
      assert.equal(api.status, 401);
      assert.match(String(api.json["error"]), /Open OpenAssess from its own window/);
    });
  });

  test("a wrong key is refused, and the right one is turned into a cookie that other sites are not sent", async () => {
    await withApp(async (client) => {
      const wrong = await fetch(new URL("/?k=nope", client.server.url), { redirect: "manual" });
      assert.equal(wrong.status, 403);

      const right = await fetch(client.server.entry, { redirect: "manual" });
      // A page that moves on by itself, not a redirect: a redirect that began on another site is sent without a Strict cookie.
      assert.equal(right.status, 200);
      assert.equal(right.headers.get("location"), null, "not a redirect");
      const cookie = right.headers.getSetCookie()[0] ?? "";
      assert.match(cookie, /HttpOnly/);
      assert.match(cookie, /SameSite=Strict/);
      const page = await right.text();
      assert.match(page, /<meta http-equiv="refresh" content="0;url=\/">/);
      assert.ok(!page.includes(client.server.token), "the key does not stay in the page, or in the address it moves on to");
      assert.doesNotMatch(page, /<script/);
    });
  });

  // Found by reading the cookie's name: one name for every copy, and a cookie belongs to a host and not to a port, so opening a second
  // copy of OpenAssess (the shortcut clicked twice, or a window and a browser tab) replaced the first copy's key and turned its
  // next request away.
  test("two copies running at once each keep their own key, though a browser holds one cookie jar for both", async () => {
    await withApp(async (first) => {
      await withApp(async (second) => {
        assert.notEqual(first.server.port, second.server.port);
        assert.notEqual(first.cookie.split("=")[0], second.cookie.split("=")[0], "the two cookies have different names");
        // What the browser sends to each: every cookie it holds for 127.0.0.1, the first copy's and the second's.
        const jar = `${first.cookie}; ${second.cookie}`;
        for (const [copy, other] of [[first, second], [second, first]] as const) {
          const own = await rawRequest(copy.server.port, "/api/state", { host: `127.0.0.1:${copy.server.port}`, cookie: jar });
          assert.equal(own.status, 200, "a copy finds its own key among both");
          const foreign = await rawRequest(copy.server.port, "/api/state", { host: `127.0.0.1:${copy.server.port}`, cookie: other.cookie });
          assert.equal(foreign.status, 401, "and does not accept the other copy's key");
        }
        // The name is matched whole: the same key under a name that merely starts or ends like it, or a different port, is not a key.
        const [name, token] = first.cookie.split("=") as [string, string];
        for (const cookie of [`${name}x=${token}`, `x${name}=${token}`, `${name.slice(0, -1)}=${token}`, `${name}0=${token}`, `${name.toUpperCase()}=${token}`]) {
          const reply = await rawRequest(first.server.port, "/api/state", { host: `127.0.0.1:${first.server.port}`, cookie });
          assert.equal(reply.status, 401, cookie.replace(token, "<key>"));
        }
      });
    });
  });

  test("a request that names some other host is refused, which is what a name pointed at this machine looks like", async () => {
    await withApp(async (client) => {
      const reply = await rawRequest(client.server.port, "/api/state", { host: "evil.example", cookie: client.cookie });
      assert.equal(reply.status, 421);
      const localhost = await rawRequest(client.server.port, "/api/state", { host: `localhost:${client.server.port}`, cookie: client.cookie });
      assert.equal(localhost.status, 200, "the name localhost is this machine, and is let in");
    });
  });

  test("a request that changes something must say it is the app's, and must not come from another page", async () => {
    await withApp(async (client) => {
      const bare = await rawRequest(client.server.port, "/api/banks", { host: `127.0.0.1:${client.server.port}`, cookie: client.cookie, "content-type": "application/json" }, "POST");
      assert.equal(bare.status, 403);
      const foreign = await rawRequest(
        client.server.port,
        "/api/banks",
        { host: `127.0.0.1:${client.server.port}`, cookie: client.cookie, "x-openassess": "1", origin: "https://evil.example" },
        "POST",
      );
      assert.equal(foreign.status, 403);
      const own = await rawRequest(
        client.server.port,
        "/api/banks",
        { host: `127.0.0.1:${client.server.port}`, cookie: client.cookie, "x-openassess": "1", origin: `http://127.0.0.1:${client.server.port}`, "content-length": "0" },
        "POST",
      );
      assert.equal(own.status, 400, "it got as far as being asked for a title");
    });
  });

  test("every answer carries a policy that allows only this server's own scripts and styles", async () => {
    await withApp(async (client) => {
      for (const path of ["/api/state", "/"]) {
        const reply = await client.get(path);
        const policy = reply.headers.get("content-security-policy") ?? "";
        assert.match(policy, /default-src 'none'/);
        assert.match(policy, /script-src 'self'/);
        assert.match(policy, /frame-ancestors 'none'/);
        assert.equal(reply.headers.get("x-content-type-options"), "nosniff");
      }
    });
  });

  test("names that try to climb out of a folder are refused everywhere a name is taken", async () => {
    await withApp(async (client) => {
      const port = client.server.port;
      const asked = (path: string): Promise<{ status: number; text: string }> => rawRequest(port, path, { host: `127.0.0.1:${port}`, cookie: client.cookie });
      assert.equal((await asked("/..%2fpackage.json")).status, 404);
      assert.equal((await asked("/%2e%2e/%2e%2e/package.json")).status, 404);
      assert.equal((await asked("/ui/../src/server.ts")).status, 404);
      assert.equal((await asked("/api/banks/..%2f..")).status, 400);
      assert.equal((await asked("/api/banks/a%5Cb")).status, 400);
      assert.equal((await asked("/api/banks/CON")).status, 400);
      assert.equal((await asked("/files/..%2fBanks%2fx.openassess")).status, 400);
      assert.equal((await asked("/files/absent.csv")).status, 404);
    });
  });

  test("a request that is too large for what it is is refused before it is read", async () => {
    await withApp(async (client) => {
      const reply = await client.send("POST", "/api/banks", Buffer.alloc(5 * 1024 * 1024, 120), { "content-type": "application/json" });
      assert.equal(reply.status, 413);
    });
  });

  // It used to say "That file is too large.", which says neither how large nor what to do.
  test("a request that is too large says how large it is, what the most is, and what to do about a file", async () => {
    await withApp(async (client) => {
      const small = await client.send("POST", "/api/banks", Buffer.alloc(5 * 1024 * 1024, 120), { "content-type": "application/json" });
      assert.equal((small.json as { error: string }).error, "That is 5.0 MB, and the most this takes at once is 4.0 MB.");
      const headers = { host: `127.0.0.1:${client.server.port}`, cookie: client.cookie, "x-openassess": "1", "content-type": "application/octet-stream" };
      const file = await liarPostReply(client.server.port, "/api/import?name=bank.docx", headers);
      assert.equal(file.status, 413);
      const said = (JSON.parse(file.text) as { error: string }).error;
      assert.match(said, /^That is 954 MB, and the most this takes at once is 80 MB\. A file of questions is far smaller than that, so check it is the one you meant; if it holds large pictures, save a copy with smaller ones\.$/);
    });
  });

  test("a request that does not say how large it is is stopped by counting what arrives", async () => {
    await withApp(async (client) => {
      const headers = { host: `127.0.0.1:${client.server.port}`, cookie: client.cookie, "x-openassess": "1", "content-type": "application/json" };
      assert.equal(await chunkedPost(client.server.port, "/api/banks", headers, 6), 413);
    });
  });

  test("a request that says it is enormous is refused at once, without waiting for the rest", async () => {
    await withApp(async (client) => {
      const headers = { host: `127.0.0.1:${client.server.port}`, cookie: client.cookie, "x-openassess": "1", "content-type": "application/json" };
      assert.equal(await liarPost(client.server.port, "/api/banks", headers), 413);
    });
  });

  test("answers on this computer only: a connection by any other address of the machine is refused", async () => {
    const { networkInterfaces } = await import("node:os");
    const outside = Object.values(networkInterfaces())
      .flat()
      .find((i) => i && i.family === "IPv4" && !i.internal);
    if (!outside) return; // a machine with no other address has nothing to try
    await withApp(async (client) => {
      await assert.rejects(fetch(`http://${outside.address}:${client.server.port}/`, { signal: AbortSignal.timeout(3000) }), "the server is not listening there");
    });
  });

  test("something that is not a request the app makes is not allowed", async () => {
    await withApp(async (client) => {
      assert.equal((await client.send("PATCH", "/anything", {})).status, 405);
      assert.equal((await client.get("/api/nothing")).status, 404);
      assert.equal((await client.send("POST", "/api/banks", "not json" as never)).status, 400);
    });
  });
});

describe("the page", () => {
  const UI = fileURLToPath(new URL("../ui/", import.meta.url));

  test("is served with everything it loads, and loads nothing from anywhere else", async () => {
    await withApp(async (client) => {
      const page = await client.get("/");
      assert.equal(page.status, 200);
      assert.match(page.headers.get("content-type") ?? "", /^text\/html/);
      assert.match(page.text, /<script type="module" src="\/app\.js"><\/script>/);
      assert.doesNotMatch(page.text, /<script(?![^>]*\bsrc=)/, "no script written into the page");
      assert.doesNotMatch(page.text, /\bstyle=|<style/, "no styling written into the page");
      assert.doesNotMatch(page.text, /(?:src|href)="https?:\/\//, "nothing is fetched from another address");

      const wanted = new Set<string>(["/style.css", "/icon.svg", "/app.js"]);
      for (const file of readdirSync(UI).filter((f) => f.endsWith(".js"))) {
        const source = (await import("node:fs")).readFileSync(join(UI, file), "utf8");
        for (const match of source.matchAll(/(?:from\s+|import\()\s*["']\.\/([A-Za-z0-9_-]+\.js)["']/g)) wanted.add(`/${match[1]}`);
        // The two addresses a script may name are the MathML namespace, which math.js needs to build an equation's elements, and the
        // SVG namespace, which ui-icons.js needs to build an icon's (the suite's look, 2026-11-11). Each is a name that identifies the
        // kind of element and is never asked for, so it is not an address the page reaches.
        assert.doesNotMatch(source, /https?:\/\/(?!127\.0\.0\.1|www\.w3\.org\/1998\/Math\/MathML"|www\.w3\.org\/2000\/svg")/, `${file} reaches for no other address`);
        assert.doesNotMatch(source, /\binnerHTML\b|\binsertAdjacentHTML\b|\bdocument\.write\b|\beval\(|new Function\(/, `${file} never writes markup or runs text as code`);
        // A panel that is not there is null, and the browser's own append writes the word "null" for it: the editor showed "nullnull"
        // above the model answer of every essay from the day it got panels for equations and tables. They go in with put.
        assert.doesNotMatch(source, /\.append\([^;]*\b[A-Za-z]+Panel\(\)/, `${file} adds a panel that may be missing with put, not append`);
      }
      for (const path of wanted) {
        const reply = await client.get(path);
        assert.equal(reply.status, 200, path);
        assert.notEqual(reply.text, "", path);
      }
    });
  });

  test("a dialog is named by its own heading, so a screen reader says what is being asked and not only 'dialog'", async () => {
    await withApp(async (client) => {
      const source = (await client.get("/dialogs.js")).text;
      // The heading has an id, and the dialog is labelled by that id before it is shown. (Checked in a real browser on 7 November 2026: the
      // name is "Rename this bank", Escape closes the dialog, and focus goes back to the button that opened it.)
      const heading = /h\("h2",\s*\{[^}]*\bid:\s*"([^"]+)"/.exec(source);
      assert.ok(heading, "the dialog's heading has an id");
      assert.match(source, new RegExp(`setAttribute\\("aria-labelledby",\\s*"${heading?.[1]}"\\)`), "the dialog is labelled by the heading");
      assert.ok(source.indexOf("aria-labelledby") < source.indexOf("showModal()"), "it is named before it is shown");
    });
  });

  test("serves the screens the router can open", async () => {
    await withApp(async (client) => {
      const router = (await import("node:fs")).readFileSync(join(UI, "app.js"), "utf8");
      const screens = [...router.matchAll(/"\.\/([a-z-]+\.js)"/g)].map((m) => m[1] as string);
      assert.ok(screens.length >= 3);
      for (const file of screens) {
        const reply = await client.get(`/${file}`);
        assert.equal(reply.status, 200, `${file} is a screen the router opens, so it must be there`);
      }
    });
  });

  test("does not serve what is not the page's, and not a file from the folder above", async () => {
    await withApp(async (client) => {
      assert.equal((await client.get("/server.ts")).status, 404);
      assert.equal((await client.get("/package.json")).status, 404);
      assert.equal((await client.get("/index.html")).status, 200);
      assert.equal((await client.get("/missing.js")).status, 404);
      assert.equal((await client.get("/a/b/c.js")).status, 404);
    });
  });
});

describe("the library", () => {
  // Found by an independent reader: the name was cut to 80 characters AFTER its trailing dots and spaces were taken off, so a title
  // whose 80th character was a full stop gave a name that checkName refuses, and the bank could be neither made nor opened.
  test("a name made from a long title ends in neither a dot nor a space, wherever the cut falls, and is a name that is accepted", () => {
    const wherever = [78, 79, 80, 81, 90].flatMap((n) => [".", " ", "-"].map((c) => `${"a".repeat(n - 1)}${c}tail`));
    for (const title of wherever) {
      const name = cleanName(title);
      assert.ok(name.length <= 80, `${JSON.stringify(title)} gave ${name.length} characters`);
      assert.doesNotMatch(name, /[. ]$/, `${JSON.stringify(title)} gave ${JSON.stringify(name)}`);
      assert.equal(checkName(name), name, "the name that is made is one that is taken");
    }
    assert.equal(cleanName(`${"a".repeat(79)}.b`), "a".repeat(79), "the full stop that the cut left at the end is taken off");
    assert.equal(cleanName("  ...  "), "Untitled");
  });

  // Found by a reader of the first fix: dropping the final trim left the space that follows leading dots, and a name that is not its own
  // trim is one checkName refuses. These titles made a bank before the fix and did not after it.
  test("a title that begins with dots and a space still makes a name that is accepted, as it did before", () => {
    for (const [title, expected] of [[". Intro to Psych", "Intro to Psych"], [".. Chapter 3", "Chapter 3"], ["... and then", "and then"], [" . a", "a"], [". . .x", "x"]] as const) {
      const name = cleanName(title);
      assert.equal(name, expected, JSON.stringify(title));
      assert.equal(checkName(name), name);
    }
  });

  // Found by a reader who cut names at every length: a cut between the two halves of an emoji left half of one, which the file system
  // keeps as a replacement character and `encodeURIComponent` refuses, so a finished export or a new bank ended in "URI malformed".
  test("a name is never cut in the middle of an emoji, by either cut", () => {
    const whole = (name: string): void => {
      assert.doesNotThrow(() => encodeURIComponent(name), JSON.stringify(name));
      assert.ok(name.length <= 80);
    };
    for (let n = 70; n <= 82; n++) whole(cleanName(`${"a".repeat(n)}${"😀".repeat(5)}`));
    for (let n = 30; n <= 60; n++) whole(fitFileName(`${"😀".repeat(n)} - Brightspace.csv`));
    for (let n = 30; n <= 70; n++) whole(fitFileName(`${"b".repeat(n)}${"😀".repeat(20)}.txt`));
    // Found by a reader: a flag is four units, a family eight or more, a letter with its accent two; a cut inside one is no error and
    // is not what the person wrote either, so the cut falls between characters as they are seen.
    const flag = String.fromCodePoint(0x1f1fa, 0x1f1f8);
    const family = String.fromCodePoint(0x1f468, 0x200d, 0x1f469, 0x200d, 0x1f467);
    const accented = "é";
    for (let n = 70; n <= 82; n++) {
      for (const unit of [flag, family, accented]) {
        const name = cleanName(`${"a".repeat(n)}${unit.repeat(4)}`);
        whole(name);
        const kept = name.slice(n > 80 ? 80 : n);
        assert.ok(kept === "" || kept.length % unit.length === 0, `${JSON.stringify(name.slice(-8))}: a ${unit.length}-unit character was cut`);
      }
    }
  });

  // Found by a reader: COM0 and LPT0 and the superscript digits are reserved too, and a name that Windows would take for a device is
  // refused when it comes from outside and is not made by the program.
  test("the names Windows keeps for devices are refused, with or without an extension and in any case", () => {
    for (const reserved of ["CON", "prn", "Aux", "NUL", "COM0", "com9", "LPT0", "lpt3", "COM¹", "LPT².txt", "con.txt", "Aux. Verbs", "CONIN$", "conout$"]) {
      assert.throws(() => checkName(reserved), /cannot be used as a file name/, reserved);
    }
    for (const fine of ["Console", "Auxiliary", "COM10", "LPT", "Con-Ed", "Null"]) assert.equal(checkName(fine), fine);
  });

  test("a name of exactly the longest length is left alone, and one more is cut", () => {
    assert.equal(checkName("a".repeat(80)), "a".repeat(80), "80 is the longest name taken");
    assert.throws(() => checkName("a".repeat(81)), /cannot be used as a file name/, "and 81 is not");
    assert.equal(fitFileName("a".repeat(80)), "a".repeat(80));
    assert.equal(fitFileName(`${"a".repeat(76)}.csv`), `${"a".repeat(76)}.csv`);
    const cut = fitFileName("a".repeat(81));
    assert.ok(cut.length <= 80 && cut.endsWith("…"), cut);
    assert.ok(fitFileName(`${"a".repeat(77)}.csv`).length <= 80);
  });

  // Found by a reader: " 2" was added after the check, so the second file of a name that fitted exactly was 82 long. It was written
  // and listed and then could not be downloaded, because the download checks the name again.
  test("the number that keeps a new file from replacing an old one is counted in the length, for a file and for a bank", async () => {
    const dir = mkdtempSync(join(tmpdir(), "openassess-names-"));
    try {
      for (const wanted of [`${"x".repeat(60)} - Brightspace.csv`, `${"y".repeat(100)}.txt`, `${"😀".repeat(45)} - Common Cartridge.imscc`, `${"z".repeat(80)}`, "short.csv"]) {
        const seen = new Set<string>();
        for (let i = 0; i < 14; i++) {
          const name = await writeNewFile(dir, wanted, "x"); // writing the file is what claims the name
          assert.ok(name.length <= 80, `${name.length} characters: ${name}`);
          assert.equal(checkName(name), name, "and it is a name that can be downloaded");
          assert.doesNotThrow(() => encodeURIComponent(name));
          assert.ok(!seen.has(name), `${name} came twice, so a file would have been written over`);
          seen.add(name);
        }
        if (wanted === "short.csv") assert.ok(seen.has("short 2.csv") && seen.has("short 3.csv"), "a short name is numbered as it always was");
      }
      // A bank is given its name by a link to a finished file, and a name that is taken is the next one.
      const finished = join(dir, "finished.tmp");
      writeFileSync(finished, "a finished bank");
      for (const title of ["a".repeat(79), "b".repeat(90), `${"c".repeat(78)} d`]) {
        const seen = new Set<string>();
        for (let i = 0; i < 12; i++) {
          const name = await placeFile(dir, cleanName(title), ".openassess", finished);
          assert.ok(name.length <= 80 && checkName(name) === name, name);
          assert.ok(!seen.has(name), `${name} came twice`);
          seen.add(name);
          assert.ok(existsSync(join(dir, `${name}.openassess`)), "and the name is held from then on");
        }
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a name the program makes itself is cut to fit, with the start of the title and the end of the name kept, and a short one is left alone", () => {
    const title = "Introduction to Psychology Chapter Three Test Bank Fall Section 002 more words";
    assert.equal(fitFileName("Quiz - Brightspace.csv"), "Quiz - Brightspace.csv");
    const fitted = fitFileName(`${title} - Brightspace.csv`);
    assert.equal(fitted.length, 80);
    assert.ok(fitted.startsWith("Introduction to Psychology Chapter"), fitted);
    assert.match(fitted, /… - Brightspace\.csv$/, "the cut is marked, and the kind of file stays");
    const printed = fitFileName(`${title} - Version B - Answer key.docx`);
    assert.match(printed, /… - Version B - Answer key\.docx$/, "a version and the kind of copy are what tell two files apart, and they stay");
    assert.ok(printed.length <= 80);
    for (const name of [fitted, printed, fitFileName(`${"x".repeat(120)}.txt`), fitFileName("y".repeat(120))]) assert.equal(checkName(name), name);
  });

  test("starts empty, makes a bank, and lists it", async () => {
    await withApp(async (client, home) => {
      const empty = await client.get("/api/state");
      assert.deepEqual(empty.json["banks"], []);
      assert.equal(empty.json["home"], home);

      const made = await client.post("/api/banks", { title: "Biology 101" });
      assert.equal(made.json["name"], "Biology 101");
      assert.ok(existsSync(join(home, "Banks", "Biology 101.openassess")));
      const again = await client.post("/api/banks", { title: "Biology 101" });
      assert.equal(again.json["name"], "Biology 101 2", "a second bank with the same title does not overwrite the first");

      const listed = (await client.get("/api/state")).json["banks"] as Array<{ name: string; questions: number }>;
      assert.deepEqual(listed.map((b) => b.name), ["Biology 101", "Biology 101 2"]);
      assert.equal((await client.post("/api/banks", { title: "   " })).status, 400);
    });
  });

  test("keeps a bank that was removed in a folder of its own, and does not erase it", async () => {
    await withApp(async (client, home) => {
      await client.post("/api/banks", { title: "Old" });
      const gone = await client.del("/api/banks/Old");
      assert.equal(gone.status, 200);
      assert.ok(!existsSync(join(home, "Banks", "Old.openassess")));
      assert.deepEqual(readdirSync(join(home, "Deleted")), ["Old.openassess"]);
      assert.equal((await client.get("/api/banks/Old")).status, 404);
    });
  });

  // Found by a reader: the name was looked for and then used, so requests at the same moment all found the same name free. Six exports
  // asked for at once were given one name and wrote over each other, and six banks made at once gave three errors. The name is claimed
  // by creating the file, which fails if it is there.
  test("banks made at the same time under one title each get a name of their own, and a bank removed twice keeps both copies", async () => {
    await withApp(async (client, home) => {
      const made = await Promise.all(Array.from({ length: 6 }, () => client.post("/api/banks", { title: "Biology" })));
      assert.deepEqual(made.map((r) => r.status), [200, 200, 200, 200, 200, 200], made.map((r) => r.text).join(" "));
      const names = made.map((r) => r.json["name"] as string);
      assert.equal(new Set(names).size, 6, "six different names");
      assert.equal(readdirSync(join(home, "Banks")).length, 6);
      for (const name of names) assert.equal((await client.get(`/api/banks/${encodeURIComponent(name)}`)).status, 200, `${name} opens`);

      // A bank removed, made again under the same name and removed again: the first copy in Deleted is not written over.
      await client.post("/api/banks", { title: "Old" });
      assert.equal((await client.put("/api/banks/Old", { title: "First copy" })).status, 200);
      assert.equal((await client.del("/api/banks/Old")).status, 200);
      await client.post("/api/banks", { title: "Old" });
      assert.equal((await client.del("/api/banks/Old")).status, 200);
      assert.deepEqual(readdirSync(join(home, "Deleted")).sort(), ["Old 2.openassess", "Old.openassess"]);
      const first = Bank.fromBytes(new Uint8Array(readFileSync(join(home, "Deleted", "Old.openassess")))).bank;
      assert.equal(first.manifest.title, "First copy", "the first copy is still the first copy");
    });
  });

  test("keeps a bank file from somewhere else under a new name, and refuses a file that is not a bank", async () => {
    await withApp(async (client) => {
      const bank = Bank.createEmpty("Brought in");
      const bytes = Buffer.from(bank.toBytes());
      const adopted = await client.send("POST", "/api/banks/open?name=Brought%20in.openassess", bytes);
      assert.equal(adopted.json["name"], "Brought in");
      const twice = await client.send("POST", "/api/banks/open?name=Brought%20in.openassess", bytes);
      assert.equal(twice.json["name"], "Brought in 2");
      const rubbish = await client.send("POST", "/api/banks/open?name=x.openassess", text("this is not a zip"));
      assert.equal(rubbish.status, 400);
      assert.match(String(rubbish.json["error"]), /not an OpenAssess bank/);
    });
  });

  test("shows a file in its folder only when the file is in the library", async () => {
    await withApp(async (client, home, revealed) => {
      assert.equal((await client.post("/api/reveal", { path: join(home, "Exports", "x.csv") })).status, 200);
      assert.deepEqual(revealed, [join(home, "Exports", "x.csv")]);
      assert.equal((await client.post("/api/reveal", { path: "C:\\Windows\\System32\\cmd.exe" })).status, 400);
      assert.equal((await client.post("/api/reveal", { path: join(home, "..", "elsewhere.txt") })).status, 400);
      assert.equal((await client.post("/api/reveal", {})).status, 400);
      assert.equal(revealed.length, 1);
    });
  });

  // A space is nearly always in the path (a title with two words, a " - Brightspace" suffix), and Node quotes a whole argument that holds one, which Explorer cannot
  // read: it opened the Documents folder and showed nothing. This was found in a recording of the window, not by a test.
  test("gives Explorer its argument as it wants it, with the quotes around the path and not around the whole", () => {
    const path = "C:\\Users\\you\\Documents\\OpenAssess\\Exports\\PDF TB 2 - Brightspace.csv";
    assert.deepEqual(revealCommand(path, "win32"), { command: "explorer.exe", args: [`/select,"${path}"`], verbatim: true });
    assert.throws(() => revealCommand('C:\\Exports\\a" /root,"C:\\.csv', "win32"), /cannot be shown/, "a quote mark would end the argument early");
    assert.deepEqual(revealCommand("/home/a b/Exports/x.csv", "darwin"), { command: "open", args: ["-R", "/home/a b/Exports/x.csv"], verbatim: false });
    assert.equal(revealCommand("/home/a b/Exports/x.csv", "linux").command, "xdg-open");
  });
});

describe("importing and repairing", () => {
  test("reads a text file into a session that shows each question, its verdict and its lines", async () => {
    await withApp(async (client) => {
      const view = await importText(client);
      assert.equal(view.file, "bank.txt");
      assert.equal(view.counts.total, 2);
      assert.deepEqual(view.questions.map((q) => q.verdict), ["parsed", "failed"]);
      assert.equal(view.source[2], "*b. Paris");
      const one = await client.get(`/api/sessions/${view.id}/questions/1`);
      const question = one.json["question"] as { stem: string; body: { options: Array<{ text: string; correct: boolean }> }; verdict: string; findings: Array<{ severity: string; code: string }> };
      assert.equal(question.stem, "What is the capital of Spain?");
      assert.deepEqual(question.body.options.map((o) => o.correct), [false, false, false], "no option was marked, and none is shown as marked");
      assert.ok(question.findings.some((f) => f.severity === "error"));
    });
  });

  test("reads a Word file, with Word's own numbering shown as part of each line", async () => {
    await withApp(async (client) => {
      const lines = BANK_TEXT.split("\n");
      const bytes = docx({ body: lines.map((l) => (l === "" ? paragraph("") : paragraph(run(l)))).join("") });
      const reply = await client.send<SessionView>("POST", "/api/import?name=bank.docx", Buffer.from(bytes));
      assert.equal(reply.status, 200, reply.text);
      assert.equal(reply.json.counts.total, 2);
      assert.equal(reply.json.source[1], "a. Berlin");
    });
  });

  test("refuses what it cannot read, with a way forward", async () => {
    await withApp(async (client) => {
      const old = await client.send("POST", "/api/import?name=old.doc", text("x"));
      assert.equal(old.status, 400);
      assert.match(String(old.json["error"]), /Save As/);
      // A file of another kind is said to be one, with what to do, and is not read as text (it used to come out as orphan blocks of junk).
      for (const [name, words] of [["exam.odt", /OpenDocument text.*Save As/], ["exam.gdoc", /shortcut.*Download.*\.docx/], ["exam.html", /web page/], ["exam.pages", /Export To.*Word/]] as const) {
        const other = await client.send("POST", `/api/import?name=${name}`, text("x"));
        assert.equal(other.status, 400, name);
        assert.match(String(other.json["error"]), words, name);
      }
      const bank = await client.send("POST", "/api/import?name=thing.openassess", text("x"));
      assert.match(String(bank.json["error"]), /Use Open a bank/);
      const empty = await client.send("POST", "/api/import?name=a.txt", Buffer.alloc(0));
      assert.equal(empty.status, 400);
      const broken = await client.send("POST", "/api/import?name=broken.docx", text("this is not a zip file at all"));
      assert.equal(broken.status, 422);
      assert.match(String(broken.json["error"]), /could not be read/);
    });
  });

  test("lets a person mark the right answer, and the question stops being a failure", async () => {
    await withApp(async (client) => {
      const view = await importText(client);
      const base = `/api/sessions/${view.id}/questions/1`;
      const { question } = (await client.get(base)).json as { question: { version: number; body: { options: Array<{ correct: boolean }> } } };
      const input = JSON.parse(JSON.stringify(question));
      input.body.options[1].correct = true;
      const saved = await client.put(base, { input, expectVersion: question.version });
      assert.equal(saved.status, 200, saved.text);
      const after = saved.json as { summary: { verdict: string; version: number }; counts: SessionView["counts"] };
      assert.equal(after.summary.verdict, "parsed");
      assert.equal(after.summary.version, question.version + 1);
      assert.equal(after.counts.failed, 0);
      assert.equal(after.counts.parsed, 2);
    });
  });

  // Seen in a recording of the repair screen: the Answer line said "b. Verbally bullying" over an option that reads "Verbal
  // bullying", so no answer was marked and the question was an error. A person marked B right and saved, and the question stayed
  // Failed under the same error, which the screen says goes when the question is fixed. So both questions were left out.
  const DISAGREES = "1. What type of bullying is easily observed?\na. Indirect bullying\nb. Verbal bullying\nc. Cyberbullying\nAnswer: b. Verbally bullying.\n\n2. What is two plus two?\na. Three\nb. Four\n*c. Five\n\n";

  test("an answer chosen by hand replaces the error about the file's key, says so, and keeps what the file said", async () => {
    await withApp(async (client) => {
      const view = await importText(client, "bully.txt", DISAGREES);
      assert.equal(view.counts.failed, 1);
      const base = `/api/sessions/${view.id}/questions/0`;
      const { question } = (await client.get(base)).json as { question: { version: number; body: { options: Array<{ correct: boolean }> }; findings: Array<{ code: string; severity: string; dismissed?: boolean; message: string }> } };
      const said = question.findings.find((f) => f.code === "import.keys-disagree");
      assert.ok(said && !said.dismissed, "the file's key is an error to begin with");

      const input = JSON.parse(JSON.stringify(question));
      input.body.options[1].correct = true;
      const saved = await client.put(base, { input, expectVersion: question.version });
      assert.equal(saved.status, 200, saved.text);
      const after = saved.json as { summary: { verdict: string }; counts: SessionView["counts"]; replaced: Array<{ code: string; message: string }>; question: { findings: Array<{ code: string; severity: string; dismissed?: boolean; message: string }> } };
      assert.equal(after.summary.verdict, "parsed", "the question stops being a failure");
      assert.equal(after.counts.failed, 0);
      assert.deepEqual(after.replaced, [{ code: "import.keys-disagree", message: said.message }], "and the person is told what their answer replaced");
      const kept = after.question.findings.find((f) => f.code === "import.keys-disagree");
      assert.equal(kept?.dismissed, true, "what the file said is kept in the list, dismissed");
      assert.equal(kept?.severity, "error");
      assert.equal(kept?.message, said.message);

      // Saved with a title or a stem changed and nothing else, a question keeps what the file said.
      const second = await client.put(`/api/sessions/${view.id}/questions/1`, { input: { ...JSON.parse(JSON.stringify((await client.get(`/api/sessions/${view.id}/questions/1`)).json["question"])), stem: "What is 2 + 2?" } });
      assert.equal(second.status, 200, second.text);
      assert.deepEqual((second.json as { replaced: string[] }).replaced, [], "nothing was replaced by a change of wording");
    });
  });

  // The same for words: an option with a letter and no text is kept as "(missing)" beside an error, and writing the words in
  // left the error where it was, so the question stayed Failed after it was repaired.
  test("words written where a placeholder was replace the error about it, say so, and keep what it said", async () => {
    await withApp(async (client) => {
      const view = await importText(client, "blank.txt", "1) Which of these is a chair?\n*a. Chair\nb.  \nc. Desk\n\n2) Which is a fruit?\na. Chair\n*b. Apple\n\n");
      assert.equal(view.counts.failed, 1);
      const base = `/api/sessions/${view.id}/questions/0`;
      const { question } = (await client.get(base)).json as { question: { version: number; body: { options: Array<{ text: string }> }; findings: Array<{ code: string; message: string; dismissed?: boolean }> } };
      assert.equal(question.body.options[1]?.text, "(missing)");
      const said = question.findings.find((f) => f.code === "import.empty-option");
      assert.ok(said && !said.dismissed);

      // Typing the placeholder in again is not writing the words.
      const same = JSON.parse(JSON.stringify(question));
      same.body.options[2].text = "Stool";
      const stillMissing = await client.put(base, { input: same, expectVersion: question.version });
      assert.deepEqual(stillMissing.json["replaced"], []);
      assert.equal((stillMissing.json["summary"] as { verdict: string }).verdict, "failed", "a placeholder is still there");

      const input = JSON.parse(JSON.stringify(stillMissing.json["question"]));
      input.body.options[1].text = "Table";
      const saved = await client.put(base, { input, expectVersion: (stillMissing.json["summary"] as { version: number }).version });
      assert.equal(saved.status, 200, saved.text);
      assert.equal((saved.json["summary"] as { verdict: string }).verdict, "parsed", "the question stops being a failure");
      assert.deepEqual(saved.json["replaced"], [{ code: "import.empty-option", message: said.message }]);
      const kept = (saved.json["question"] as { findings: Array<{ code: string; dismissed?: boolean }> }).findings.find((f) => f.code === "import.empty-option");
      assert.equal(kept?.dismissed, true, "what the importer said is kept in the list, dismissed");
    });
  });

  test("an edit that does not choose an answer leaves the error about the file's key, and the question still fails", async () => {
    await withApp(async (client) => {
      const view = await importText(client, "bully.txt", DISAGREES);
      const base = `/api/sessions/${view.id}/questions/0`;
      const { question } = (await client.get(base)).json as { question: { version: number; stem: string } };
      const saved = await client.put(base, { input: { ...JSON.parse(JSON.stringify(question)), stem: "What type of bullying is easily seen?" }, expectVersion: question.version });
      assert.equal(saved.status, 200, saved.text);
      assert.equal((saved.json["summary"] as { verdict: string }).verdict, "failed");
      assert.deepEqual(saved.json["replaced"], []);
    });
  });

  test("in a bank as well: the answer chosen replaces the error that was stored with the question", async () => {
    await withApp(async (client) => {
      const view = await importText(client, "bully.txt", DISAGREES);
      assert.equal((await client.post(`/api/sessions/${view.id}/save`, { title: "Bully" })).status, 200);
      const list = (await client.get("/api/banks/Bully")).json as { questions: Array<{ id: string; verdict: string }> };
      const failed = list.questions.find((q) => q.verdict === "failed") as { id: string };
      assert.ok(failed, "a failed question was kept, flagged, as it has to be");
      const url = `/api/banks/Bully/questions/${failed.id}`;
      const { question } = (await client.get(url)).json as { question: { version: number; body: { options: Array<{ correct: boolean }> } } };
      const input = JSON.parse(JSON.stringify(question));
      input.body.options[1].correct = true;
      const saved = await client.put(url, { input, expectVersion: question.version });
      assert.equal(saved.status, 200, saved.text);
      assert.equal((saved.json["summary"] as { verdict: string }).verdict, "parsed");
      assert.equal((saved.json["replaced"] as unknown[]).length, 1);
      // And it is what the bank now holds.
      assert.equal(((await client.get(url)).json["question"] as { findings: Array<{ code: string; dismissed?: boolean }> }).findings.find((f) => f.code === "import.keys-disagree")?.dismissed, true);
    });
  });

  test("still fails a question whose answer is missing after its text was edited, and never wipes the checks", async () => {
    await withApp(async (client) => {
      const view = await importText(client);
      const base = `/api/sessions/${view.id}/questions/1`;
      const { question } = (await client.get(base)).json as { question: { version: number; stem: string } };
      const input = { ...JSON.parse(JSON.stringify(question)), stem: "What is the capital city of Spain?" };
      const saved = await client.put(base, { input, expectVersion: question.version });
      assert.equal(saved.status, 200, saved.text);
      assert.equal((saved.json["summary"] as { verdict: string }).verdict, "failed", "no answer was marked, so it is still a failure");
      assert.ok(((saved.json["question"] as { findings: Array<{ severity: string }> }).findings).some((f) => f.severity === "error"));
    });
  });

  test("lets go of the oldest import when a dozen more are open", async () => {
    await withApp(async (client) => {
      const first = await importText(client, "first.txt");
      for (let n = 0; n < 12; n++) await importText(client, `later-${n}.txt`);
      assert.equal((await client.get(`/api/sessions/${first.id}`)).status, 404, "the first is gone");
    });
  });

  test("changes nothing, and adds no version, when a question is saved as it was", async () => {
    await withApp(async (client) => {
      const view = await importText(client);
      const base = `/api/sessions/${view.id}/questions/0`;
      const { question } = (await client.get(base)).json as { question: { version: number } };
      const saved = await client.put(base, { input: JSON.parse(JSON.stringify(question)), expectVersion: question.version });
      assert.equal((saved.json as { summary: { version: number } }).summary.version, question.version);
    });
  });

  test("refuses a change to a question that moved on since it was opened", async () => {
    await withApp(async (client) => {
      const view = await importText(client);
      const base = `/api/sessions/${view.id}/questions/0`;
      const { question } = (await client.get(base)).json as { question: { version: number } };
      const input = { ...JSON.parse(JSON.stringify(question)), points: 5 };
      assert.equal((await client.put(base, { input, expectVersion: question.version })).status, 200);
      const stale = await client.put(base, { input: { ...input, points: 6 }, expectVersion: question.version });
      assert.equal(stale.status, 409);
      assert.match(String(stale.json["error"]), /changed since you opened it/);
    });
  });

  test("refuses a question the screen sent wrongly, with words, and changes nothing", async () => {
    await withApp(async (client) => {
      const view = await importText(client);
      const base = `/api/sessions/${view.id}/questions/0`;
      const bad = await client.put(base, { input: { type: "multipleChoice", stem: 7 } });
      assert.equal(bad.status, 400);
      assert.match(String(bad.json["error"]), /question text must be text/);
      assert.equal(((await client.get(base)).json["question"] as { version: number }).version, 1);
    });
  });

  test("dismisses a check that is only a note, and does not dismiss an error", async () => {
    await withApp(async (client) => {
      const view = await importText(client);
      const base = `/api/sessions/${view.id}/questions/1/dismiss`;
      const { question } = (await client.get(`/api/sessions/${view.id}/questions/1`)).json as { question: { findings: Array<{ code: string; severity: string }> } };
      const error = question.findings.find((f) => f.severity === "error");
      assert.ok(error);
      const refused = await client.post(base, { code: error.code });
      assert.equal(refused.status, 400);
      assert.match(String(refused.json["error"]), /cannot be dismissed/);
      assert.equal((await client.post(base, { all: true })).status, 200, "all notes at once leaves the error where it is");
      const still = (await client.get(`/api/sessions/${view.id}/questions/1`)).json["question"] as { verdict: string };
      assert.equal(still.verdict, "failed");
      assert.equal((await client.post(base, {})).status, 400);
      assert.equal((await client.post(base, { code: "import.nothing" })).status, 400);
    });
  });

  test("leaves a question out of the save without losing it, and brings it back", async () => {
    await withApp(async (client) => {
      const view = await importText(client);
      const skip = await client.post(`/api/sessions/${view.id}/questions/1/skip`, { skipped: true });
      assert.equal((skip.json["counts"] as SessionView["counts"]).skipped, 1);
      const reread = (await client.get(`/api/sessions/${view.id}`)).json as unknown as SessionView;
      assert.equal(reread.questions[1]?.skipped, true);
      assert.equal(reread.counts.total, 2, "it is still in the list");
      const back = await client.post(`/api/sessions/${view.id}/questions/1/skip`, { skipped: false });
      assert.equal((back.json["counts"] as SessionView["counts"]).skipped, 0);
    });
  });

  test("makes a draft question from text no question used, once", async () => {
    await withApp(async (client) => {
      const view = await importText(client, "orphan.txt", `Midterm review sheet\n\n${BANK_TEXT}`);
      assert.ok(view.orphans.length >= 1);
      const first = view.orphans[0] as { index: number; text: string };
      const made = await client.post(`/api/sessions/${view.id}/orphans/${first.index}/question`);
      assert.equal(made.status, 200, made.text);
      const after = made.json["view"] as SessionView;
      assert.equal(after.counts.total, view.counts.total + 1);
      assert.equal(after.orphans[first.index]?.made, true);
      const newest = after.questions.at(-1) as { index: number; verdict: string; title: string };
      assert.equal(newest.verdict, "needsReview", "it is flagged, since its type was not given");
      assert.equal((await client.post(`/api/sessions/${view.id}/orphans/${first.index}/question`)).status, 400);
    });
  });

  test("saves a session into a new bank, once, with what was left out left out", async () => {
    await withApp(async (client) => {
      const view = await importText(client);
      await client.post(`/api/sessions/${view.id}/questions/1/skip`, { skipped: true });
      const saved = await client.post(`/api/sessions/${view.id}/save`, { title: "Capitals" });
      assert.equal(saved.status, 200, saved.text);
      assert.equal(saved.json["bank"], "Capitals");
      assert.equal(saved.json["added"], 1);
      assert.equal(saved.json["skipped"], 1);
      const bank = (await client.get("/api/banks/Capitals")).json as { questions: unknown[]; total: number };
      assert.equal(bank.total, 1);
      const again = await client.post(`/api/sessions/${view.id}/save`, { title: "Capitals" });
      assert.equal(again.status, 409);
      assert.match(String(again.json["error"]), /already saved/);
    });
  });

  test("saves a question with no answer, flagged, because a half-made question has to be kept", async () => {
    await withApp(async (client) => {
      const view = await importText(client);
      await client.post(`/api/sessions/${view.id}/save`, { title: "Both" });
      const listed = (await client.get("/api/banks/Both")).json as { questions: Array<{ verdict: string }> };
      assert.deepEqual(listed.questions.map((q) => q.verdict).sort(), ["failed", "parsed"]);
    });
  });

  test("saves into a bank that is already there, and asks which bank when it is not told", async () => {
    await withApp(async (client) => {
      await client.post("/api/banks", { title: "Existing" });
      const view = await importText(client);
      assert.equal((await client.post(`/api/sessions/${view.id}/save`, {})).status, 400);
      assert.equal((await client.post(`/api/sessions/${view.id}/save`, { bank: "Nowhere" })).status, 404);
      const saved = await client.post(`/api/sessions/${view.id}/save`, { bank: "Existing" });
      assert.equal(saved.json["added"], 2);
    });
  });

  test("says that an import is no longer open when it is asked for one that is not", async () => {
    await withApp(async (client) => {
      const reply = await client.get("/api/sessions/nothing-here");
      assert.equal(reply.status, 404);
      assert.match(String(reply.json["error"]), /no longer open/);
    });
  });

  test("reads the fixtures the harness holds, and shows every question and every orphan", async () => {
    await withApp(async (client) => {
      for (const name of readdirSync(FIXTURES).filter((n) => n.endsWith(".txt"))) {
        const view = await importText(client, name, (await import("node:fs")).readFileSync(join(FIXTURES, name), "utf8"));
        assert.equal(view.questions.length, view.counts.total, name);
        for (const q of view.questions) assert.equal((await client.get(`/api/sessions/${view.id}/questions/${q.index}`)).status, 200, `${name} #${q.index}`);
      }
    });
  });
});

describe("a bank", () => {
  async function bankWith(client: Client): Promise<string> {
    await client.post("/api/banks", { title: "Work" });
    return "/api/banks/Work";
  }
  const blank = async (client: Client, type: string): Promise<Record<string, unknown>> => (await client.get(`/api/blank?type=${type}`)).json["input"] as Record<string, unknown>;

  test("takes a new question from the screen, and a question that is only half written", async () => {
    await withApp(async (client) => {
      const base = await bankWith(client);
      const input = await blank(client, "multipleChoice");

      // Nothing written yet: the model cannot hold a question or an option with no text, and the person is told in plain words.
      const empty = await client.post(`${base}/questions`, { input });
      assert.equal(empty.status, 400);
      assert.match(String(empty.json["error"]), /The question needs some text\. Option 1 has no text\. Write something, or remove it\./);

      // Written, but no right answer marked: kept, and said to have no answer from the first moment.
      const unmarked = {
        ...input,
        stem: "What is two plus two?",
        body: { shuffle: true, options: [{ text: "Three", correct: false, feedback: "" }, { text: "Four", correct: false, feedback: "" }] },
      };
      const half = await client.post(`${base}/questions`, { input: unmarked });
      assert.equal(half.status, 200, half.text);
      assert.equal((half.json["question"] as { verdict: string }).verdict, "failed", "no answer, so it says so; and it was kept");
      const keyed = (half.json["question"] as { findings: Array<{ severity: string }> }).findings;
      assert.ok(keyed.some((f) => f.severity === "error"));

      const whole = {
        ...input,
        stem: "What is two plus two?",
        body: { shuffle: true, options: [{ text: "Three", correct: false, feedback: "" }, { text: "Four", correct: true, feedback: "" }, { text: "Five", correct: false, feedback: "" }] },
      };
      const made = await client.post(`${base}/questions`, { input: whole });
      assert.equal((made.json["question"] as { verdict: string }).verdict, "parsed");
      assert.equal(((await client.get(base)).json as { total: number }).total, 2);
    });
  });

  test("changes a question and keeps the change on disk", async () => {
    await withApp(async (client, home) => {
      const base = await bankWith(client);
      const input = { ...(await blank(client, "shortAnswer")), stem: "Name the capital of France.", body: { accepted: ["Paris"], caseSensitive: false } };
      const created = await client.post(`${base}/questions`, { input });
      const { id, version } = created.json["question"] as { id: string; version: number };
      const edited = await client.put(`${base}/questions/${id}`, { input: { ...input, stem: "Name the capital city of France.", body: { accepted: ["Paris", "paris"], caseSensitive: false } }, expectVersion: version });
      assert.equal(edited.status, 200, edited.text);
      assert.equal((edited.json["question"] as { version: number }).version, version + 1);

      // What is on disk is what the screen was told.
      const { bank } = await Bank.open(join(home, "Banks", "Work.openassess"));
      const stored = bank.get(id);
      assert.equal(stored?.version, version + 1);
      assert.deepEqual((stored?.body as { accepted: string[] }).accepted, ["Paris", "paris"]);
    });
  });

  test("refuses a change to a question that moved on, in a bank as well as in an import", async () => {
    await withApp(async (client) => {
      const base = await bankWith(client);
      const input = { ...(await blank(client, "shortAnswer")), stem: "Name the capital of France.", body: { accepted: ["Paris"], caseSensitive: false } };
      const { id, version } = (await client.post(`${base}/questions`, { input })).json["question"] as { id: string; version: number };
      assert.equal((await client.put(`${base}/questions/${id}`, { input: { ...input, points: 2 }, expectVersion: version })).status, 200);
      const stale = await client.put(`${base}/questions/${id}`, { input: { ...input, points: 3 }, expectVersion: version });
      assert.equal(stale.status, 409);
      assert.equal(((await client.get(`${base}/questions/${id}`)).json["question"] as { points: number }).points, 2, "the stale change did not land");
    });
  });

  test("lists, searches and filters", async () => {
    await withApp(async (client) => {
      const base = await bankWith(client);
      const make = async (type: string, stem: string, body: unknown): Promise<void> => {
        await client.post(`${base}/questions`, { input: { ...(await blank(client, type)), stem, body } });
      };
      await make("shortAnswer", "Name the capital of France.", { accepted: ["Paris"], caseSensitive: false });
      await make("shortAnswer", "Name the longest river in Egypt.", { accepted: ["Nile"], caseSensitive: false });
      await make("trueFalse", "The Sun is a star.", { correct: true });
      await make("trueFalse", "The Moon is a star.", { correct: null });

      const all = (await client.get(base)).json as { total: number; questions: Array<{ title: string }> };
      assert.equal(all.total, 4);
      const found = (await client.get(`${base}?q=capital`)).json as { questions: Array<{ title: string }> };
      assert.deepEqual(found.questions.map((q) => q.title), ["Name the capital of France."]);
      const tf = (await client.get(`${base}?type=trueFalse`)).json as { questions: unknown[] };
      assert.equal(tf.questions.length, 2);
      const errors = (await client.get(`${base}?check=errors`)).json as { questions: Array<{ title: string }> };
      assert.deepEqual(errors.questions.map((q) => q.title), ["The Moon is a star."]);
      const clean = (await client.get(`${base}?check=clean`)).json as { questions: unknown[] };
      assert.equal(clean.questions.length, 3);
    });
  });

  test("duplicates a question as a draft with its own id, and removes one when asked", async () => {
    await withApp(async (client) => {
      const base = await bankWith(client);
      const input = { ...(await blank(client, "trueFalse")), stem: "Water is wet.", body: { correct: true }, metadata: { status: "approved", difficulty: "", bloom: "", objective: "", chapter: "", section: "", page: "", tags: ["water"] } };
      const created = (await client.post(`${base}/questions`, { input })).json["question"] as { id: string };
      const copy = (await client.post(`${base}/questions/${created.id}/duplicate`)).json["question"] as { id: string; title: string; metadata: { status: string; tags: string[] } };
      assert.notEqual(copy.id, created.id);
      assert.match(copy.title, /\(copy\)$/);
      assert.equal(copy.metadata.status, "draft");
      assert.deepEqual(copy.metadata.tags, ["water"]);
      assert.equal(((await client.get(base)).json as { total: number }).total, 2);
      assert.equal((await client.del(`${base}/questions/${created.id}`)).status, 200);
      assert.equal(((await client.get(base)).json as { total: number }).total, 1);
      assert.equal((await client.get(`${base}/questions/${created.id}`)).status, 404);
    });
  });

  test("keeps a dismissal through later edits, and never lets an error be dismissed", async () => {
    await withApp(async (client) => {
      const view = await importText(client, "keys.txt", "1. First?\na. One\nb. Two\n**c. Three\n\n");
      await client.post(`/api/sessions/${view.id}/save`, { title: "Kept" });
      const list = (await client.get("/api/banks/Kept")).json as { questions: Array<{ id: string }> };
      const id = list.questions[0]?.id as string;
      const q = (await client.get(`/api/banks/Kept/questions/${id}`)).json["question"] as { findings: Array<{ code: string; severity: string; dismissed?: boolean }> };
      const note = q.findings.find((f) => f.severity !== "error");
      if (note) {
        const dismissed = await client.post(`/api/banks/Kept/questions/${id}/dismiss`, { code: note.code });
        assert.equal(dismissed.status, 200);
        const after = (await client.get(`/api/banks/Kept/questions/${id}`)).json["question"] as { findings: Array<{ code: string; dismissed?: boolean }> };
        assert.equal(after.findings.find((f) => f.code === note.code)?.dismissed, true);
      }
    });
  });

  test("refuses a question the model cannot hold, and a question that is not there", async () => {
    await withApp(async (client) => {
      const base = await bankWith(client);
      assert.equal((await client.get(`${base}/questions/nothing`)).status, 404);
      assert.equal((await client.put(`${base}/questions/nothing`, { input: await blank(client, "essay") })).status, 404);
      assert.equal((await client.get("/api/banks/Nowhere")).status, 404);
      assert.equal((await client.get("/api/blank?type=hotspot")).status, 400);
      assert.equal((await client.get("/api/blank?type=nonsense")).status, 400);
    });
  });

  test("serves a file it wrote into the exports folder for download, and nothing else", async () => {
    await withApp(async (client, home) => {
      writeFileSync(join(home, "Exports", "Quiz one.csv"), "a,b\r\n");
      const reply = await client.get("/files/Quiz%20one.csv");
      assert.equal(reply.status, 200);
      assert.equal(reply.text, "a,b\r\n");
      assert.match(reply.headers.get("content-disposition") ?? "", /^attachment; filename\*=UTF-8''Quiz%20one\.csv$/);
      assert.match(reply.headers.get("content-type") ?? "", /^text\/csv/);
    });
  });
});

describe("exporting", () => {
  interface Report {
    total: number;
    exported: number;
    exportedWithLosses: number;
    leftOut: number;
    files: string[];
    items: Array<{ outcome: string; notes: string[] }>;
  }
  const blank = async (client: Client, type: string): Promise<Record<string, unknown>> => (await client.get(`/api/blank?type=${type}`)).json["input"] as Record<string, unknown>;

  /** A bank with a question that can go anywhere, one with no answer, and one that only some formats hold. */
  async function seeded(client: Client, title = "Quiz"): Promise<string> {
    await client.post("/api/banks", { title });
    const base = `/api/banks/${encodeURIComponent(title)}/questions`;
    const add = async (type: string, stem: string, b: unknown, extra: Record<string, unknown> = {}): Promise<Record<string, unknown>> => {
      const reply = await client.post(base, { input: { ...(await blank(client, type)), stem, body: b, ...extra } });
      assert.equal(reply.status, 200, reply.text);
      return reply.json["question"] as Record<string, unknown>;
    };
    await add("multipleChoice", "What is two plus two?", { shuffle: true, options: [{ text: "Three", correct: false, feedback: "" }, { text: "Four", correct: true, feedback: "" }] });
    await add("trueFalse", "The Moon is made of cheese.", { correct: null });
    await add("ordering", "Put these in order.", { items: [{ text: "First" }, { text: "Second" }] });
    return `/api/banks/${encodeURIComponent(title)}`;
  }

  // Found by an independent reader and shown by exporting a bank with a long title: the file's name is the bank's title (up to 80
  // characters) with the kind of file after it, and the name was then checked as though a stranger had sent it, so a title of 62
  // characters failed Common Cartridge and 75 failed all but three destinations, each with "That name cannot be used as a file name".
  test("a bank with a long title exports to every destination, under a name cut to fit, and the check and the write agree", async () => {
    for (const length of [62, 75, 80]) {
      await withApp(async (client, home) => {
        const title = "Psychology Chapter Three Test Bank Fall Section 002 ".repeat(3).slice(0, length).replace(/ $/, "x");
        assert.equal(title.length, length);
        const bank = await seeded(client, title);
        for (const destination of ["openstage-spreadsheet", "moodle-xml", "gift", "d2l-csv", "qti-1.2", "qti-2.1", "common-cartridge", "blackboard-upload"]) {
          const checked = await client.post<{ report: { files: string[] } }>(`${bank}/export/check`, { destination });
          assert.equal(checked.status, 200, `${destination} check, title of ${length}: ${checked.text}`);
          // Writing three times: the second and third files are numbered, and every one must be a name that can be downloaded again.
          const everyName: string[] = [];
          for (let round = 1; round <= 3; round++) {
            const written = await client.post(`${bank}/export`, { destination });
            assert.equal(written.status, 200, `${destination}, title of ${length}, write ${round}: ${written.text}`);
            const names = (written.json["written"] as Array<{ name: string }>).map((f) => f.name);
            if (round === 1) {
              assert.deepEqual([...names].sort(), [...checked.json.report.files].sort(), `${destination}: what the check lists is what is written`);
              assert.deepEqual([...(written.json["report"] as { files: string[] }).files].sort(), [...names].sort(), `${destination}: and so is what the write itself reports`);
            }
            for (const name of names) {
              assert.ok(name.length <= 80, `${destination}: ${name}`);
              assert.ok(readdirSync(join(home, "Exports")).includes(name), `${name} is in the folder`);
              assert.match(name, /\.[a-z0-9]+$/, "and keeps its extension, so the computer knows what it is");
              const download = await client.get(`/files/${encodeURIComponent(name)}`);
              assert.equal(download.status, 200, `${destination}, write ${round}: ${name} (${name.length}) cannot be downloaded: ${download.text}`);
              everyName.push(name);
            }
          }
          assert.equal(new Set(everyName).size, everyName.length, `${destination}: three writes make three different files`);
        }
      });
    }
  });

  test("exports asked for at the same moment are each given a name of their own, and none is written over another", async () => {
    await withApp(async (client, home) => {
      const bank = await seeded(client);
      const replies = await Promise.all(Array.from({ length: 8 }, () => client.post(`${bank}/export`, { destination: "gift" })));
      assert.ok(replies.every((r) => r.status === 200), replies.map((r) => r.text.slice(0, 80)).join(" | "));
      const names = replies.flatMap((r) => (r.json["written"] as Array<{ name: string }>).map((f) => f.name));
      assert.equal(new Set(names).size, 8, "eight names");
      assert.equal(readdirSync(join(home, "Exports")).length, 8, "and eight files, not fewer");
      for (const name of names) assert.ok(readFileSync(join(home, "Exports", name), "utf8").includes("What is two plus two?"), `${name} holds the questions whole`);
    });
  });

  test("a folder in the exports folder is not a file that can be downloaded", async () => {
    await withApp(async (client, home) => {
      mkdirSync(join(home, "Exports", "somefolder"));
      assert.equal((await client.get("/files/somefolder")).status, 404);
      writeFileSync(join(home, "Exports", "real.txt"), "x");
      assert.equal((await client.get("/files/real.txt")).status, 200);
    });
  });

  test("lists the places a bank can be exported to", async () => {
    await withApp(async (client) => {
      const reply = await client.get("/api/destinations");
      const ids = (reply.json["destinations"] as Array<{ id: string; label: string; blurb: string }>).map((d) => d.id);
      assert.deepEqual(ids, ["openstage-spreadsheet", "moodle-xml", "gift", "d2l-csv", "qti-1.2", "qti-2.1", "common-cartridge", "blackboard-upload"]);
    });
  });

  test("exports a bank as a QTI 2.1 package: a real zip, a file for each question, written and served as the bytes it is", async () => {
    await withApp(async (client, home) => {
      const bank = await seeded(client);
      const checked = (await client.post(`${bank}/export/check`, { destination: "qti-2.1" })).json["report"] as Report;
      assert.equal(checked.total, 3);
      assert.equal(checked.exported, 1, "the multiple choice");
      assert.equal(checked.leftOut, 2, "the true or false with no answer, and the ordering a QTI file does not carry");
      assert.deepEqual(readdirSync(join(home, "Exports")), []);

      const written = await client.post(`${bank}/export`, { destination: "qti-2.1" });
      assert.equal(written.status, 200, written.text);
      const files = written.json["written"] as Array<{ name: string; questions: number }>;
      assert.equal(files[0]?.name, "Quiz - QTI 2.1.zip");
      assert.equal(files[0]?.questions, 1);
      const onDisk = readFileSync(join(home, "Exports", "Quiz - QTI 2.1.zip"));
      assert.equal(onDisk.subarray(0, 2).toString("latin1"), "PK", "bytes, not text: written as UTF-8 text a zip would be damaged");
      const inside = unzipSync(new Uint8Array(onDisk));
      assert.deepEqual([...inside.keys()].sort(), ["assessmentTest.xml", "imsmanifest.xml", "q1.xml"]);
      const xml = Buffer.from(inside.get("q1.xml") as Uint8Array).toString("utf8");
      assert.match(xml, /What is two plus two\?/);
      assert.doesNotMatch(xml, /cheese/);
      const downloaded = await client.get("/files/Quiz%20-%20QTI%202.1.zip");
      assert.equal(downloaded.status, 200);
      assert.ok(Buffer.compare(downloaded.bytes, onDisk) === 0, "the download is the file, byte for byte");
    });
  });

  test("exports a bank as a QTI 1.2 package: a real zip, written and served as the bytes it is", async () => {
    await withApp(async (client, home) => {
      const bank = await seeded(client);
      const checked = (await client.post(`${bank}/export/check`, { destination: "qti-1.2" })).json["report"] as Report;
      assert.equal(checked.total, 3);
      assert.equal(checked.exported, 1, "the multiple choice");
      assert.equal(checked.leftOut, 2, "the true or false with no answer, and the ordering a QTI file does not carry");
      assert.deepEqual(readdirSync(join(home, "Exports")), []);

      const written = await client.post(`${bank}/export`, { destination: "qti-1.2" });
      assert.equal(written.status, 200, written.text);
      const files = written.json["written"] as Array<{ name: string; questions: number }>;
      assert.equal(files[0]?.name, "Quiz - QTI 1.2.zip");
      assert.equal(files[0]?.questions, 1);
      const onDisk = readFileSync(join(home, "Exports", "Quiz - QTI 1.2.zip"));
      assert.equal(onDisk.subarray(0, 2).toString("latin1"), "PK", "bytes, not text: written as UTF-8 text a zip would be damaged");
      const inside = unzipSync(new Uint8Array(onDisk));
      assert.deepEqual([...inside.keys()].sort(), ["assessment.xml", "imsmanifest.xml"]);
      const xml = Buffer.from(inside.get("assessment.xml") as Uint8Array).toString("utf8");
      assert.match(xml, /What is two plus two\?/);
      assert.doesNotMatch(xml, /cheese/);
      const downloaded = await client.get("/files/Quiz%20-%20QTI%201.2.zip");
      assert.equal(downloaded.status, 200);
      assert.ok(Buffer.compare(downloaded.bytes, onDisk) === 0, "the download is the file, byte for byte");
    });
  });

  test("exports a bank as a Common Cartridge package: a real zip, written and served as the bytes it is", async () => {
    await withApp(async (client, home) => {
      const bank = await seeded(client);
      const checked = (await client.post(`${bank}/export/check`, { destination: "common-cartridge" })).json["report"] as Report;
      assert.equal(checked.exported, 1, "the multiple choice");
      assert.equal(checked.leftOut, 2, "the true or false with no answer, and the ordering Common Cartridge's profile does not hold");
      assert.deepEqual(readdirSync(join(home, "Exports")), []);

      const written = await client.post(`${bank}/export`, { destination: "common-cartridge" });
      assert.equal(written.status, 200, written.text);
      assert.equal((written.json["written"] as Array<{ name: string }>)[0]?.name, "Quiz - Common Cartridge.imscc");
      const onDisk = readFileSync(join(home, "Exports", "Quiz - Common Cartridge.imscc"));
      assert.equal(onDisk.subarray(0, 2).toString("latin1"), "PK");
      const inside = unzipSync(new Uint8Array(onDisk));
      assert.deepEqual([...inside.keys()].sort(), ["imsmanifest.xml", "quiz/qti-assessment.xml"]);
      assert.match(Buffer.from(inside.get("quiz/qti-assessment.xml") as Uint8Array).toString("utf8"), /What is two plus two\?/);
      const downloaded = await client.get("/files/Quiz%20-%20Common%20Cartridge.imscc");
      assert.equal(downloaded.status, 200);
      assert.ok(Buffer.compare(downloaded.bytes, onDisk) === 0, "the download is the file, byte for byte");
    });
  });

  test("exports a bank as Blackboard's upload file: tab-delimited rows, one for each question it can hold", async () => {
    await withApp(async (client, home) => {
      const bank = await seeded(client);
      const checked = (await client.post(`${bank}/export/check`, { destination: "blackboard-upload" })).json["report"] as Report;
      assert.equal(checked.exported, 1, "the multiple choice");
      assert.equal(checked.exportedWithLosses, 1, "the ordering, which Blackboard's help lists for the Original view and not for Ultra");
      assert.equal(checked.leftOut, 1, "the true or false with no answer is not written with a guessed one");
      const written = await client.post(`${bank}/export`, { destination: "blackboard-upload" });
      assert.equal(written.status, 200, written.text);
      assert.equal((written.json["written"] as Array<{ name: string }>)[0]?.name, "Quiz - Blackboard.txt");
      const onDisk = readFileSync(join(home, "Exports", "Quiz - Blackboard.txt"), "utf8");
      assert.equal(onDisk, "MC\tWhat is two plus two?\tThree\tincorrect\tFour\tcorrect\r\nORD\tPut these in order.\tFirst\tSecond\r\n");
    });
  });

  test("exports a bank to Brightspace's question library: what the check said is what the file holds", async () => {
    await withApp(async (client, home) => {
      const bank = await seeded(client);
      const checked = (await client.post(`${bank}/export/check`, { destination: "d2l-csv" })).json["report"] as Report;
      assert.equal(checked.total, 3);
      assert.equal(checked.exported, 2, "the multiple choice, and the ordering that Brightspace can hold");
      assert.equal(checked.leftOut, 1, "the true or false with no answer is not written with a guessed one");
      assert.deepEqual(readdirSync(join(home, "Exports")), []);

      const written = await client.post(`${bank}/export`, { destination: "d2l-csv" });
      assert.equal(written.status, 200, written.text);
      const files = written.json["written"] as Array<{ name: string; questions: number }>;
      assert.equal(files[0]?.name, "Quiz - Brightspace.csv");
      assert.equal(files[0]?.questions, 2);
      const onDisk = readFileSync(join(home, "Exports", "Quiz - Brightspace.csv"), "utf8");
      assert.ok(onDisk.startsWith("// Written by OpenAssess"), "no byte order mark in front of the first keyword");
      // Every row is three cells wide, as Brightspace's own template is, so a row with nothing to say in the third ends in a comma.
      assert.match(onDisk, /NewQuestion,MC,\r\n/);
      assert.match(onDisk, /Option,100,Four\r\n/);
      assert.match(onDisk, /NewQuestion,O,\r\n/);
      assert.match(onDisk, /Item,First,\r\nItem,Second,\r\n/);
      assert.doesNotMatch(onDisk, /cheese/);
    });
  });

  test("checks what would happen to each question and writes nothing", async () => {
    await withApp(async (client, home) => {
      const bank = await seeded(client);
      const checked = await client.post(`${bank}/export/check`, { destination: "gift" });
      assert.equal(checked.status, 200, checked.text);
      const report = checked.json["report"] as Report;
      assert.equal(report.total, 3);
      assert.equal(report.exported, 1);
      assert.equal(report.leftOut, 2, "the one with no answer, and the ordering GIFT cannot hold");
      assert.deepEqual(readdirSync(join(home, "Exports")), []);
    });
  });

  test("writes the file the check described, into the exports folder, and serves it for download", async () => {
    await withApp(async (client, home) => {
      const bank = await seeded(client);
      const written = await client.post(`${bank}/export`, { destination: "openstage-spreadsheet" });
      assert.equal(written.status, 200, written.text);
      const files = written.json["written"] as Array<{ name: string; path: string; questions: number }>;
      assert.equal(files.length, 1);
      assert.equal(files[0]?.name, "Quiz.csv");
      assert.equal(files[0]?.path, join(home, "Exports", "Quiz.csv"));
      assert.equal(files[0]?.questions, 1);
      const onDisk = readFileSync(join(home, "Exports", "Quiz.csv"), "utf8");
      assert.ok(onDisk.startsWith("﻿Type,Question"), "with the byte order mark Excel needs");
      assert.match(onDisk, /What is two plus two\?/);
      assert.doesNotMatch(onDisk, /cheese/, "the question with no answer was not written");
      const downloaded = await client.get("/files/Quiz.csv");
      assert.equal(downloaded.status, 200);
      assert.equal(downloaded.text, onDisk);
      assert.equal((await client.post("/api/reveal", { path: files[0]?.path })).status, 200, "and it can be shown in its folder");
    });
  });

  test("never writes over an earlier export", async () => {
    await withApp(async (client, home) => {
      const bank = await seeded(client);
      await client.post(`${bank}/export`, { destination: "moodle-xml" });
      writeFileSync(join(home, "Exports", "Quiz.xml"), "an earlier one that was changed by hand");
      const second = await client.post(`${bank}/export`, { destination: "moodle-xml" });
      assert.equal((second.json["written"] as Array<{ name: string }>)[0]?.name, "Quiz 2.xml");
      assert.equal(readFileSync(join(home, "Exports", "Quiz.xml"), "utf8"), "an earlier one that was changed by hand");
      const third = await client.post(`${bank}/export`, { destination: "moodle-xml" });
      assert.equal((third.json["written"] as Array<{ name: string }>)[0]?.name, "Quiz 3.xml");
    });
  });

  test("leaves out retired questions unless they are asked for", async () => {
    await withApp(async (client) => {
      const bank = await seeded(client);
      const list = (await client.get(bank)).json as { questions: Array<{ id: string; title: string }> };
      const keyed = list.questions.find((q) => /two plus two/.test(q.title)) as { id: string };
      const { question } = (await client.get(`${bank}/questions/${keyed.id}`)).json as { question: { version: number; metadata: Record<string, unknown> } };
      const input = JSON.parse(JSON.stringify(question));
      input.metadata.status = "retired";
      assert.equal((await client.put(`${bank}/questions/${keyed.id}`, { input, expectVersion: question.version })).status, 200);

      const byDefault = (await client.post(`${bank}/export/check`, { destination: "gift" })).json["report"] as Report;
      assert.equal(byDefault.total, 2, "the retired question is not counted");
      const asked = (await client.post(`${bank}/export/check`, { destination: "gift", statuses: ["draft", "retired"] })).json["report"] as Report;
      assert.equal(asked.total, 3);
      const only = (await client.post(`${bank}/export/check`, { destination: "gift", statuses: ["retired"] })).json["report"] as Report;
      assert.equal(only.total, 1);
      assert.equal(only.exported, 1);
    });
  });

  test("says so when nothing can be exported, and writes no file", async () => {
    await withApp(async (client, home) => {
      await client.post("/api/banks", { title: "Empty" });
      const checked = (await client.post("/api/banks/Empty/export/check", { destination: "gift" })).json["report"] as Report;
      assert.equal(checked.total, 0);
      assert.deepEqual(checked.files, []);
      const written = await client.post("/api/banks/Empty/export", { destination: "gift" });
      assert.deepEqual(written.json["written"], []);
      assert.deepEqual(readdirSync(join(home, "Exports")), []);
    });
  });

  test("refuses a destination or a status it does not know, and a bank that is not there", async () => {
    await withApp(async (client) => {
      const bank = await seeded(client);
      assert.equal((await client.post(`${bank}/export/check`, { destination: "word-document" })).status, 400);
      assert.equal((await client.post(`${bank}/export/check`, {})).status, 400);
      assert.equal((await client.post(`${bank}/export/check`, { destination: "gift", statuses: ["published"] })).status, 400);
      assert.equal((await client.post(`${bank}/export/check`, { destination: "gift", statuses: "draft" })).status, 400);
      assert.equal((await client.post("/api/banks/Nowhere/export/check", { destination: "gift" })).status, 404);
      assert.equal((await client.get(`${bank}/export`)).status, 404, "an export is asked for, not fetched");
    });
  });

  test("names the file for a bank whose title is not a name Windows allows", async () => {
    await withApp(async (client, home) => {
      const bank = await seeded(client, "Quiz");
      await client.put(bank, { title: "CON" });
      const written = await client.post(`${bank}/export`, { destination: "gift" });
      assert.equal(written.status, 200, written.text);
      assert.deepEqual(readdirSync(join(home, "Exports")), ["Questions.txt"]);
      assert.equal((written.json["written"] as Array<{ name: string }>)[0]?.name, "Questions.txt");
    });
  });
});

describe("printing", () => {
  interface Report {
    total: number;
    exported: number;
    exportedWithLosses: number;
    leftOut: number;
    general: string[];
    items: Array<{ outcome: string; notes: string[] }>;
  }
  const blank = async (client: Client, type: string): Promise<Record<string, unknown>> => (await client.get(`/api/blank?type=${type}`)).json["input"] as Record<string, unknown>;

  async function seeded(client: Client, title = "Test bank"): Promise<string> {
    await client.post("/api/banks", { title });
    const base = `/api/banks/${encodeURIComponent(title)}`;
    const add = async (type: string, stem: string, b: unknown): Promise<void> => {
      const reply = await client.post(`${base}/questions`, { input: { ...(await blank(client, type)), stem, body: b } });
      assert.equal(reply.status, 200, reply.text);
    };
    await add("multipleChoice", "What is two plus two?", { shuffle: true, options: [{ text: "Three", correct: false, feedback: "" }, { text: "Four", correct: true, feedback: "" }] });
    await add("trueFalse", "The Moon is made of cheese.", { correct: null });
    await add("essay", "Explain why the sky is blue.", { modelAnswer: "Scattering." });
    return base;
  }
  const both = { kinds: ["student", "key"], formats: ["docx", "pdf"] };

  test("a bank with a long title, or a long title and version on the test, prints under names cut to fit, keeping the kind of copy", async () => {
    for (const length of [62, 80]) {
      await withApp(async (client, home) => {
        const title = "Psychology Chapter Three Test Bank Fall Section 002 ".repeat(3).slice(0, length).replace(/ $/, "x");
        const base = await seeded(client, title);
        const request = { ...both, title, versionLabel: "Version B" };
        const checked = await client.post<{ reports: Record<string, { files: string[] }> }>(`${base}/print/check`, request);
        assert.equal(checked.status, 200, checked.text);
        const listed = Object.values(checked.json.reports).flatMap((r) => r.files);
        for (let round = 1; round <= 2; round++) {
          const written = await client.post(`${base}/print`, request);
          assert.equal(written.status, 200, `title of ${length}, write ${round}: ${written.text}`);
          const names = (written.json["written"] as Array<{ name: string }>).map((f) => f.name);
          assert.equal(names.length, 4);
          if (round === 1) assert.deepEqual([...names].sort(), [...listed].sort(), "what the check lists is what is written");
          for (const name of names) {
            assert.ok(name.length <= 80, name);
            assert.match(name, / - (Student copy|Answer key)( 2)?\.(docx|pdf)$/, "the kind of copy and the format stay");
            assert.ok(readdirSync(join(home, "Exports")).includes(name));
            assert.equal((await client.get(`/files/${encodeURIComponent(name)}`)).status, 200, `${name} (${name.length}) can be downloaded, write ${round}`);
          }
        }
      });
    }
  });

  test("checks what each copy would hold, and writes nothing", async () => {
    await withApp(async (client, home) => {
      const base = await seeded(client);
      const checked = await client.post(`${base}/print/check`, both);
      assert.equal(checked.status, 200, checked.text);
      const reports = checked.json["reports"] as Record<string, Report>;
      assert.deepEqual(Object.keys(reports).sort(), ["key", "student"]);
      assert.equal(reports["student"]?.total, 3);
      assert.deepEqual((reports["student"] as unknown as { files: string[] }).files, ["Test bank - Student copy.docx", "Test bank - Student copy.pdf"], "the files of every format");
      assert.ok(reports["student"]?.general.some((g) => /not tagged for screen readers/.test(g)), "and the notes that are true of the PDF");
      assert.equal(reports["student"]?.exportedWithLosses, 0, "the student copy has nothing to say about a missing answer");
      assert.equal(reports["key"]?.exportedWithLosses, 1, "the key says that one question has no answer");
      assert.ok(reports["key"]?.items.some((i) => i.notes.some((n) => /Nothing was guessed/.test(n))));
      assert.deepEqual(readdirSync(join(home, "Exports")), []);
    });
  });

  test("writes a Word file and a PDF of each copy, named for the title, and serves them", async () => {
    await withApp(async (client, home) => {
      const base = await seeded(client);
      const written = await client.post(`${base}/print`, both);
      assert.equal(written.status, 200, written.text);
      const files = written.json["written"] as Array<{ name: string; path: string; kind: string; format: string; pages?: number }>;
      assert.deepEqual(files.map((f) => f.name).sort(), ["Test bank - Answer key.docx", "Test bank - Answer key.pdf", "Test bank - Student copy.docx", "Test bank - Student copy.pdf"]);
      assert.deepEqual(readdirSync(join(home, "Exports")).sort(), files.map((f) => f.name).sort());
      for (const f of files.filter((x) => x.format === "pdf")) assert.ok((f.pages ?? 0) >= 1);

      const pdf = await client.get(`/files/${encodeURIComponent("Test bank - Student copy.pdf")}`);
      assert.equal(pdf.status, 200);
      assert.match(pdf.headers.get("content-type") ?? "", /^application\/pdf/);
      assert.equal(pdf.bytes.subarray(0, 5).toString("latin1"), "%PDF-");
      const docx = await client.get(`/files/${encodeURIComponent("Test bank - Answer key.docx")}`);
      assert.match(docx.headers.get("content-type") ?? "", /wordprocessingml\.document/);
      assert.equal(docx.bytes.subarray(0, 2).toString("latin1"), "PK");
    });
  });

  test("puts no answer on the student copy and marks the right one on the key", async () => {
    await withApp(async (client, home) => {
      const base = await seeded(client);
      await client.post(`${base}/print`, { kinds: ["student", "key"], formats: ["docx"] });
      const textOf = (name: string): string => Buffer.from(unzipSync(new Uint8Array(readFileSync(join(home, "Exports", name)))).get("word/document.xml") ?? new Uint8Array()).toString("utf8");
      const student = textOf("Test bank - Student copy.docx");
      const key = textOf("Test bank - Answer key.docx");
      assert.match(student, /What is two plus two\?/);
      assert.doesNotMatch(student, /\(correct\)|Scattering|No answer is recorded/);
      assert.match(key, /Four<\/w:t><\/w:r><w:r>.*?\(correct\)/);
      assert.match(key, /Model answer:/);
      assert.match(key, /No answer is recorded for this question\./);
    });
  });

  test("never writes over an earlier file", async () => {
    await withApp(async (client, home) => {
      const base = await seeded(client);
      await client.post(`${base}/print`, { kinds: ["student"], formats: ["pdf"] });
      writeFileSync(join(home, "Exports", "Test bank - Student copy.pdf"), "changed by hand");
      const again = await client.post(`${base}/print`, { kinds: ["student"], formats: ["pdf"] });
      assert.equal((again.json["written"] as Array<{ name: string }>)[0]?.name, "Test bank - Student copy 2.pdf");
      assert.equal(readFileSync(join(home, "Exports", "Test bank - Student copy.pdf"), "utf8"), "changed by hand");
    });
  });

  test("uses the title and the options it is given, and leaves out retired questions by default", async () => {
    await withApp(async (client, home) => {
      const base = await seeded(client);
      const written = await client.post(`${base}/print`, { kinds: ["student"], formats: ["docx"], title: "Unit 3 quiz", paper: "a4", nameLine: false, dateLine: false, showPoints: false, instructions: "Use a pen." });
      assert.equal((written.json["written"] as Array<{ name: string }>)[0]?.name, "Unit 3 quiz - Student copy.docx");
      const xml = Buffer.from(unzipSync(new Uint8Array(readFileSync(join(home, "Exports", "Unit 3 quiz - Student copy.docx")))).get("word/document.xml") ?? new Uint8Array()).toString("utf8");
      assert.match(xml, /w:w="11906"/, "A4");
      assert.match(xml, /Use a pen\./);
      assert.doesNotMatch(xml, /Name:|Date:|\(1 point\)/);

      const checked = await client.post(`${base}/print/check`, { kinds: ["student"], formats: ["docx"], statuses: ["retired"] });
      assert.equal((checked.json["reports"] as Record<string, Report>)["student"]?.total, 0);
      assert.equal(((await client.post(`${base}/print/check`, { kinds: ["student"], formats: ["docx"] })).json["questions"]), 3);
    });
  });

  test("leaves a retired question off the page unless it is asked for", async () => {
    await withApp(async (client) => {
      const base = await seeded(client);
      const list = (await client.get(base)).json as { questions: Array<{ id: string; title: string }> };
      const keyed = list.questions.find((q) => /two plus two/.test(q.title)) as { id: string };
      const { question } = (await client.get(`${base}/questions/${keyed.id}`)).json as { question: { version: number } };
      const input = JSON.parse(JSON.stringify(question));
      input.metadata.status = "retired";
      assert.equal((await client.put(`${base}/questions/${keyed.id}`, { input, expectVersion: question.version })).status, 200);
      const total = async (extra: Record<string, unknown> = {}): Promise<number> => ((await client.post(`${base}/print/check`, { kinds: ["student"], formats: ["docx"], ...extra })).json["reports"] as Record<string, Report>)["student"]?.total ?? -1;
      assert.equal(await total(), 2, "the retired one is not printed by default");
      assert.equal(await total({ statuses: ["draft", "retired"] }), 3, "and is when it is asked for");
    });
  });

  test("says so when nothing can be printed, and writes no file", async () => {
    await withApp(async (client, home) => {
      await client.post("/api/banks", { title: "Empty" });
      const written = await client.post("/api/banks/Empty/print", both);
      assert.deepEqual(written.json["written"], []);
      assert.deepEqual(readdirSync(join(home, "Exports")), []);
    });
  });

  test("refuses what it does not understand, with words", async () => {
    await withApp(async (client) => {
      const base = await seeded(client);
      const refuse = async (input: Record<string, unknown>, pattern: RegExp): Promise<void> => {
        const reply = await client.post(`${base}/print/check`, input);
        assert.equal(reply.status, 400, JSON.stringify(input));
        assert.match(String(reply.json["error"]), pattern);
      };
      await refuse({ formats: ["pdf"] }, /Say what to print/);
      await refuse({ kinds: [], formats: ["pdf"] }, /Say what to print/);
      await refuse({ kinds: ["student", "answers"], formats: ["pdf"] }, /Say what to print/);
      await refuse({ kinds: ["student"], formats: ["rtf"] }, /Say what to print it as/);
      await refuse({ kinds: ["student"], formats: ["pdf"], paper: "legal" }, /letter or a4/);
      await refuse({ kinds: ["student"], formats: ["pdf"], statuses: ["published"] }, /Say which statuses/);
      await refuse({ kinds: ["student"], formats: ["pdf"], title: "x".repeat(201) }, /title must be text/);
      await refuse({ kinds: ["student"], formats: ["pdf"], essayLines: "many" }, /must be a number/);
      await refuse({ kinds: ["student"], formats: ["pdf"], nameLine: "yes" }, /must be true or false/);
      assert.equal((await client.post("/api/banks/Nowhere/print/check", both)).status, 404);
    });
  });

  test("brings a page size that cannot be inside what a page holds", async () => {
    await withApp(async (client, home) => {
      const base = await seeded(client);
      const written = await client.post(`${base}/print`, { kinds: ["student"], formats: ["pdf"], fontSize: 400, essayLines: 9999, shortAnswerLines: -5 });
      assert.equal(written.status, 200, written.text);
      assert.equal(readdirSync(join(home, "Exports")).length, 1);
    });
  });
});

describe("two changes at once", () => {
  test("to one bank are made one after the other, and both are kept", async () => {
    await withApp(async (client, home) => {
      await client.post("/api/banks", { title: "Busy" });
      const input = (await client.get("/api/blank?type=trueFalse")).json["input"] as Record<string, unknown>;
      const make = (n: number): Promise<unknown> => client.post("/api/banks/Busy/questions", { input: { ...input, stem: `Statement ${n} is true.`, body: { correct: true } } });
      await Promise.all(Array.from({ length: 12 }, (_, n) => make(n)));
      const { bank } = await Bank.open(join(home, "Banks", "Busy.openassess"));
      assert.equal(bank.questions.size, 12);
    });
  });
});
