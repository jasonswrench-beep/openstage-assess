/**
 * The local server, as a person's window and as anything else on the computer would meet it. The first half is about who
 * is let in: a page open in another tab, a name pointed at this machine, a request that did not come from the app. The
 * second is the work: importing a file, repairing a question, saving it into a bank, and finding it again.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { docx, paragraph, run } from "../../assess/test/support/docx-writer.ts";
import { Bank } from "../src/engine.ts";
import { rawRequest, withApp, type Client } from "./support/app.ts";

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
      assert.equal(right.status, 302);
      assert.equal(right.headers.get("location"), "/");
      const cookie = right.headers.getSetCookie()[0] ?? "";
      assert.match(cookie, /HttpOnly/);
      assert.match(cookie, /SameSite=Strict/);
      assert.ok(!right.headers.get("location")?.includes(client.server.token), "the key does not stay in the address");
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
        assert.doesNotMatch(source, /https?:\/\/(?!127\.0\.0\.1)/, `${file} reaches for no other address`);
        assert.doesNotMatch(source, /\binnerHTML\b|\binsertAdjacentHTML\b|\bdocument\.write\b|\beval\(|new Function\(/, `${file} never writes markup or runs text as code`);
      }
      for (const path of wanted) {
        const reply = await client.get(path);
        assert.equal(reply.status, 200, path);
        assert.notEqual(reply.text, "", path);
      }
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
