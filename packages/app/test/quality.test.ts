/**
 * Check quality in the app: the notes about writing and accessibility, written to the questions of a bank by one request, and shown
 * with the question they are about. What is held here is the app's part, through the server as the window uses it: that the
 * notes are written without editing the questions, that a dismissed note stays dismissed, that what looks across the bank is
 * worked out each time and kept nowhere, and that an edit saved in the bank has its notes made fresh.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { join } from "node:path";

import { Bank, type Question } from "../src/engine.ts";
import { rawRequest, withApp, type Client } from "./support/app.ts";

type Json = Record<string, any>;

const blank = async (client: Client, type: string): Promise<Record<string, unknown>> => (await client.get(`/api/blank?type=${type}`)).json["input"] as Record<string, unknown>;

async function bankWith(client: Client, title: string, questions: Array<{ stem: string; options: string[] }>): Promise<{ base: string; ids: string[] }> {
  await client.post("/api/banks", { title });
  const base = `/api/banks/${encodeURIComponent(title)}`;
  const ids: string[] = [];
  for (const { stem, options } of questions) {
    const body = { shuffle: true, options: options.map((text) => ({ text: text.replace(/\*$/, ""), correct: text.endsWith("*"), feedback: "" })) };
    const reply = await client.post<Json>(`${base}/questions`, { input: { ...(await blank(client, "multipleChoice")), stem, body } });
    assert.equal(reply.status, 200, reply.text);
    ids.push(reply.json["question"].id);
  }
  return { base, ids };
}

const NOTED = { stem: "Which is not a fruit?", options: ["Apple", "Carrot*", "All of the above"] };
const FINE = { stem: "Which is a fruit?", options: ["Apple*", "Carrot"] };

describe("Check quality", () => {
  test("writes the notes to the questions, and says which question has which", async () => {
    await withApp(async (client) => {
      const { base, ids } = await bankWith(client, "Notes", [NOTED, FINE]);
      const run = await client.post<Json>(`${base}/quality`);
      assert.equal(run.status, 200, run.text);
      assert.equal(run.json["checked"], 2);
      assert.equal(run.json["changed"], 0, "a question written in the app had its notes as it was added, so there is nothing new to write");
      assert.deepEqual(run.json["notes"], { "quality.all-or-none-of-the-above": 1, "quality.negative-stem-not-emphasised": 1 });
      assert.equal(run.json["questions"].length, 1);
      assert.equal(run.json["questions"][0].id, ids[0]);
      const messages: string[] = run.json["questions"][0].notes.map((n: Json) => n["message"]);
      assert.ok(messages.some((m) => m.startsWith('Option C, "All of the above"')), messages.join("\n"));
      assert.ok(messages.some((m) => m.includes('("not")')));
    });
  });

  test("is not an edit: the version stays, the other question is not touched, and the notes are kept in the file", async () => {
    await withApp(async (client) => {
      const { base, ids } = await bankWith(client, "Notes", [NOTED, FINE]);
      const before = (await client.get<Json>(`${base}/questions/${ids[0]}`)).json["question"];
      await client.post(`${base}/quality`);
      const after = (await client.get<Json>(`${base}/questions/${ids[0]}`)).json["question"];
      assert.equal(after.version, before.version);
      assert.equal(after.verdict, "parsed", "a note is not a warning: the question is still parsed");
      assert.deepEqual(after.findings.map((f: Json) => [f["code"], f["severity"]]).sort(), [["quality.all-or-none-of-the-above", "info"], ["quality.negative-stem-not-emphasised", "info"]]);
      const untouched = (await client.get<Json>(`${base}/questions/${ids[1]}`)).json["question"];
      assert.deepEqual(untouched.findings, []);
      // The file on disk, read afresh and not through the server, holds them.
      const folder = client.server.context.library.banks;
      const file = readdirSync(folder).find((name) => name.endsWith(".openassess")) as string;
      const { bank } = await Bank.open(join(folder, file));
      const stored = bank.get(ids[0] as string) as Question;
      assert.equal(stored.version, before.version);
      assert.deepEqual(stored.findings.map((f) => f.code).sort(), ["quality.all-or-none-of-the-above", "quality.negative-stem-not-emphasised"]);
      assert.deepEqual(stored.history.length, 1, "the history of the question has only its creation");
    });
  });

  test("a second check changes nothing", async () => {
    await withApp(async (client) => {
      const { base } = await bankWith(client, "Notes", [NOTED, FINE]);
      await client.post(`${base}/quality`);
      const again = await client.post<Json>(`${base}/quality`);
      assert.equal(again.json["changed"], 0);
      assert.equal(again.json["questions"].length, 1);
    });
  });

  test("the list can be narrowed to the questions with notes, and each row says how many", async () => {
    await withApp(async (client) => {
      const { base, ids } = await bankWith(client, "Notes", [NOTED, FINE]);
      const all = await client.get<Json>(base);
      assert.deepEqual(all.json["questions"].map((q: Json) => q["notes"]), [2, 0], "a question written here has its notes from the start");
      await client.post(`${base}/quality`);
      const everything = await client.get<Json>(base);
      assert.deepEqual(everything.json["questions"].map((q: Json) => [q["id"], q["notes"]]).sort(), [[ids[0], 2], [ids[1], 0]].sort());
      const narrowed = await client.get<Json>(`${base}?check=notes`);
      assert.deepEqual(narrowed.json["questions"].map((q: Json) => q["id"]), [ids[0]]);
      const clean = await client.get<Json>(`${base}?check=clean`);
      assert.equal(clean.json["questions"].length, 2, "notes do not make a question need attention");
    });
  });

  test("a note can be dismissed in the editor, and stays dismissed through the next check", async () => {
    await withApp(async (client) => {
      const { base, ids } = await bankWith(client, "Notes", [NOTED]);
      await client.post(`${base}/quality`);
      const dismissed = await client.post<Json>(`${base}/questions/${ids[0]}/dismiss`, { code: "quality.all-or-none-of-the-above" });
      assert.equal(dismissed.status, 200, dismissed.text);
      const again = await client.post<Json>(`${base}/quality`);
      assert.equal(again.json["changed"], 0);
      assert.deepEqual(again.json["notes"], { "quality.negative-stem-not-emphasised": 1 }, "the dismissed one is not counted");
      assert.deepEqual(again.json["questions"][0].notes.map((n: Json) => n["code"]), ["quality.negative-stem-not-emphasised"], "nor is it listed");
      const listed = await client.get<Json>(`${base}?check=notes`);
      assert.deepEqual(listed.json["questions"].map((q: Json) => q["notes"]), [1], "nor counted in the list");
      const q = (await client.get<Json>(`${base}/questions/${ids[0]}`)).json["question"];
      const kept = q.findings.find((f: Json) => f["code"] === "quality.all-or-none-of-the-above");
      assert.equal(kept.dismissed, true);
      assert.equal(kept.dismissedBy, "you");
    });
  });

  test("an edit saved in the bank has its notes made fresh", async () => {
    await withApp(async (client) => {
      const { base, ids } = await bankWith(client, "Notes", [FINE]);
      const q = (await client.get<Json>(`${base}/questions/${ids[0]}`)).json["question"];
      const worse = await client.put<Json>(`${base}/questions/${ids[0]}`, { input: { ...q, stem: "Which is not a fruit?" }, expectVersion: q.version });
      assert.equal(worse.status, 200, worse.text);
      assert.deepEqual(worse.json["question"].findings.map((f: Json) => f["code"]), ["quality.negative-stem-not-emphasised"]);
      const fixed = await client.put<Json>(`${base}/questions/${ids[0]}`, { input: { ...worse.json["question"], stem: "Which is NOT a fruit?" }, expectVersion: worse.json["question"].version });
      assert.deepEqual(fixed.json["question"].findings, []);
    });
  });

  test("copies and the spread of right answers are worked out each time and kept nowhere", async () => {
    await withApp(async (client) => {
      const { base, ids } = await bankWith(client, "Copies", [FINE, FINE, { stem: "Another question entirely?", options: ["Yes*", "No"] }]);
      const run = await client.post<Json>(`${base}/quality`);
      assert.equal(run.json["duplicates"].length, 1);
      assert.deepEqual([...run.json["duplicates"][0].questionIds].sort(), [ids[0], ids[1]].sort());
      assert.equal(run.json["duplicates"][0].kind, "same");
      assert.match(run.json["duplicates"][0].message, /^Two questions are the same/);
      assert.deepEqual(run.json["keyBalance"], []);
      // Nothing about the copies is on the questions.
      for (const id of ids) assert.deepEqual((await client.get<Json>(`${base}/questions/${id}`)).json["question"].findings, []);
      // Take one away and ask again.
      await client.del(`${base}/questions/${ids[1]}`);
      assert.deepEqual((await client.post<Json>(`${base}/quality`)).json["duplicates"], []);
    });
  });

  test("an empty bank has nothing to note, and a bank that is not there is not found", async () => {
    await withApp(async (client) => {
      await client.post("/api/banks", { title: "Empty" });
      const run = await client.post<Json>("/api/banks/Empty/quality");
      assert.deepEqual([run.json["checked"], run.json["changed"], run.json["notes"], run.json["questions"], run.json["duplicates"], run.json["keyBalance"], run.json["limits"]], [0, 0, {}, [], [], [], []]);
      assert.equal((await client.post("/api/banks/Nothing/quality")).status, 404);
    });
  });

  test("it is a change, so it has to say it is the app's own, and a name is checked before it is used", async () => {
    await withApp(async (client) => {
      await client.post("/api/banks", { title: "Guarded" });
      const bare = await rawRequest(client.server.port, "/api/banks/Guarded/quality", { host: `127.0.0.1:${client.server.port}`, cookie: client.cookie, "content-type": "application/json" }, "POST");
      assert.equal(bare.status, 403);
      const sneaky = await client.post("/api/banks/..%2f..%2fGuarded/quality");
      assert.ok(sneaky.status === 400 || sneaky.status === 404, `status ${sneaky.status}`);
    });
  });
});

describe("a bank whose title is a word the server uses", () => {
  test("a bank titled open can be written to and checked, and a file can still be brought in", async () => {
    await withApp(async (client) => {
      const { base, ids } = await bankWith(client, "open", [NOTED, FINE]);
      assert.equal(base, "/api/banks/open");
      const run = await client.post<Json>(`${base}/quality`);
      assert.equal(run.status, 200, run.text);
      assert.equal(run.json["checked"], 2);
      const added = await client.post<Json>(`${base}/questions`, { input: { ...(await blank(client, "essay")), stem: "Written into a bank titled open?" } });
      assert.equal(added.status, 200, added.text);
      assert.equal((await client.get<Json>(base)).json["total"], 3);
      assert.equal((await client.del(`${base}/questions/${ids[1]}`)).status, 200);
      // The name is also what a brought-in file is posted to, and that must not have stopped working.
      const bytes = await Bank.createEmpty("Brought").toBytes();
      const brought = await client.send<Json>("POST", "/api/banks/open?name=Brought.openassess", new Uint8Array(bytes));
      assert.equal(brought.status, 200, brought.text);
    });
  });
});

// Found by the implementer who limited the search for questions that are very much alike: the note that says so was in the report and
// on the command line, and not in the app, where the person reads the result.
describe("what a check could not do in full", () => {
  test("is in the reply, with its severity and its words, and the panel shows it under a heading of its own", async () => {
    const { qualityView } = await import("../src/api.ts");
    const bank = Bank.createEmpty("Limits");
    const note = { severity: "info" as const, check: "alike" as const, message: "The search was cut short for 3 questions." };
    const view = qualityView(bank, { checked: 0, changed: 0, notes: {}, questions: [], report: { duplicates: [], keyBalance: [], limits: [note] } } as never);
    assert.deepEqual(view.limits, [note]);
  });

  // The panel is run on a page of its own and read, as a person reads it. A test that matched the screen's source for the heading did not
  // notice a panel that showed the check's code ("alike") in place of the check's words.
  test("the panel built from that reply says the check's words under the heading, and builds without a list of them", async () => {
    const { installFakeDocument } = await import("./support/fake-dom.ts");
    installFakeDocument();
    // @ts-expect-error the interface is plain JavaScript, checked as such, and has no declaration file
    const { qualityPanel } = await import("../ui/quality-panel.js");
    const note = { severity: "info", check: "alike", message: "The search for near copies was cut short for 3 questions." };
    const none = { checked: 2, changed: 0, notes: {}, questions: [], duplicates: [], keyBalance: [] };
    const { panel, heading } = qualityPanel({ ...none, limits: [note] }, { questions: [] }, { showNotes: () => undefined, select: () => undefined });
    assert.equal(heading.words, "Quality notes");
    const text = (panel as unknown as { words: string }).words;
    assert.ok(text.includes("What this check could not do in full"), text);
    assert.ok(text.includes(note.message), "the words of the check are shown");
    assert.ok(!text.includes(note.check), "and its code is not");
    const items = (panel as unknown as { querySelectorAll(s: string): Array<{ words: string }> }).querySelectorAll("li");
    assert.deepEqual(items.map((li) => li.words), [note.message], "one line for the one note, with nothing added to it");

    // A reply without the list (a server older than the screen) and one with an empty list show no heading for it.
    for (const reply of [none, { ...none, limits: [] }]) {
      const quiet = qualityPanel(reply, { questions: [] }, { showNotes: () => undefined, select: () => undefined });
      assert.ok(!(quiet.panel as unknown as { words: string }).words.includes("could not do in full"));
    }
  });

  test("the panel names the kinds of note in the screen's words, and a question that is the same twice by its place in the list", async () => {
    const { installFakeDocument } = await import("./support/fake-dom.ts");
    installFakeDocument();
    // @ts-expect-error the interface is plain JavaScript, checked as such, and has no declaration file
    const { qualityPanel } = await import("../ui/quality-panel.js");
    const result = {
      checked: 3,
      changed: 0,
      notes: { "quality.all-or-none-of-the-above": 2, "not.a.known.code": 1 },
      questions: [{ id: "q1" }, { id: "q2" }],
      duplicates: [{ questionIds: ["q1", "q3"], titles: ["First", ""], message: "These two read the same." }],
      keyBalance: [{ message: "Most right answers are C." }],
      limits: [],
    };
    const chosen: string[] = [];
    const { panel } = qualityPanel(result, { questions: [{ id: "q1" }, { id: "q2" }, { id: "q3" }] }, { showNotes: () => undefined, select: (id: string) => void chosen.push(id) });
    const node = panel as unknown as { words: string; querySelectorAll(s: string): Array<{ words: string; click(): unknown }> };
    assert.ok(node.words.includes("3 notes on 2 questions"), node.words);
    assert.ok(node.words.includes("An option that depends on the others (all of the above, none of the above): 2"), "a known kind in the screen's words");
    assert.ok(node.words.includes("not.a.known.code: 1"), "and one it has no words for by its code, not dropped");
    assert.ok(node.words.includes("Most right answers are C."));
    const buttons = node.querySelectorAll("button");
    assert.deepEqual(buttons.map((b) => b.words), ["Show the questions with notes", "Question 1: First", "Question 3: Untitled question"]);
    buttons[2]?.click();
    assert.deepEqual(chosen, ["q3"], "a question is opened by its button");
  });
});
