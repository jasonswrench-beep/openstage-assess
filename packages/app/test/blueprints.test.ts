/**
 * Blueprints in the app, through the server as the Make a test screen uses it. The drawing is the engine's and is tested there
 * (`blueprint.test.ts`); what is held here is the requests: what is read and refused, what a draw answers, that a blueprint is kept on
 * disk, and that a draw and a refused change leave the bank as it was.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { join } from "node:path";

import { Bank } from "../src/engine.ts";
import { rawRequest, withApp, type Client } from "./support/app.ts";

type Json = Record<string, any>;

const blank = async (client: Client, type: string): Promise<Record<string, any>> => (await client.get(`/api/blank?type=${type}`)).json["input"] as Record<string, any>;

/** A bank of essays in two chapters, with a Bloom level on some, and one unkeyed multiple choice question in the first chapter. */
async function seeded(client: Client, title = "Recipes"): Promise<{ bp: string; base: string; ids: Record<string, string[]> }> {
  await client.post("/api/banks", { title });
  const base = `/api/banks/${encodeURIComponent(title)}`;
  const ids: Record<string, string[]> = { "1": [], "2": [], unkeyed: [] };
  const add = async (input: Record<string, any>, into: string): Promise<void> => {
    const reply = await client.post<Json>(`${base}/questions`, { input });
    assert.equal(reply.status, 200, reply.text);
    (ids[into] as string[]).push(reply.json["question"].id);
  };
  const essay = await blank(client, "essay");
  for (let i = 0; i < 8; i++) await add({ ...essay, stem: `Discuss topic number ${i + 1} of chapter one at some length.`, metadata: { ...essay["metadata"], chapter: "1", bloom: i < 3 ? "apply" : "remember" } }, "1");
  for (let i = 0; i < 4; i++) await add({ ...essay, stem: `Explain subject number ${i + 1} of chapter two in detail.`, metadata: { ...essay["metadata"], chapter: "2" } }, "2");
  const mc = await blank(client, "multipleChoice");
  await add({ ...mc, stem: "Which one is right, with no answer marked at all?", body: { shuffle: true, options: [{ text: "One", correct: false, feedback: "" }, { text: "Two", correct: false, feedback: "" }] }, metadata: { ...mc["metadata"], chapter: "1" } }, "unkeyed");
  return { bp: `/api/sheets/${encodeURIComponent(title)}/blueprints`, base, ids };
}

const rules = (...r: Array<[string, string, number]>) => r.map(([axis, value, count]) => ({ axis, value, count }));

describe("keeping a blueprint", () => {
  test("is made, listed, read, changed and taken away", async () => {
    await withApp(async (client) => {
      const { bp } = await seeded(client);
      assert.deepEqual((await client.get<Json>(bp)).json["blueprints"], [], "a bank starts with none");

      const made = await client.post<Json>(bp, { name: " Midterm ", rules: rules(["chapter", " 1 ", 5], ["chapter", "2", 2]) });
      assert.equal(made.status, 200, made.text);
      const one = made.json["blueprint"];
      assert.equal(one.name, "Midterm", "the name is tidied");
      assert.deepEqual(one.rules, rules(["chapter", "1", 5], ["chapter", "2", 2]), "and so are the values");
      assert.match(one.id, /^bp_[0-9A-Z]{26}$/);

      assert.equal((await client.get<Json>(bp)).json["blueprints"].length, 1);
      assert.equal((await client.get<Json>(`${bp}/${one.id}`)).json["blueprint"].name, "Midterm");

      const changed = await client.put<Json>(`${bp}/${one.id}`, { name: "Midterm 1", rules: rules(["chapter", "1", 6]) });
      assert.equal(changed.status, 200, changed.text);
      assert.equal(changed.json["blueprint"].name, "Midterm 1");
      assert.deepEqual(changed.json["blueprint"].rules, rules(["chapter", "1", 6]));
      assert.equal(changed.json["blueprint"].created, one.created);

      const renamed = await client.put<Json>(`${bp}/${one.id}`, { name: "Final" });
      assert.deepEqual(renamed.json["blueprint"].rules, rules(["chapter", "1", 6]), "a change to the name leaves the rules");

      assert.equal((await client.del<Json>(`${bp}/${one.id}`)).json["removed"], one.id);
      assert.equal((await client.get(`${bp}/${one.id}`)).status, 404);
      assert.deepEqual((await client.get<Json>(bp)).json["blueprints"], []);
    });
  });

  test("is kept on disk, read afresh and not through the server", async () => {
    await withApp(async (client) => {
      const { bp } = await seeded(client, "Disk");
      const made = await client.post<Json>(bp, { name: "Kept", rules: rules(["bloom", "apply", 2]) });
      const folder = client.server.context.library.banks;
      const file = readdirSync(folder).find((name) => name.endsWith(".openassess")) as string;
      const { bank, report } = await Bank.open(join(folder, file));
      assert.deepEqual(report.invalid, []);
      assert.deepEqual(bank.listBlueprints().map((b) => [b.name, b.rules]), [["Kept", rules(["bloom", "apply", 2])]]);
      assert.equal(bank.listBlueprints()[0]?.id, made.json["blueprint"].id);
    });
  });

  test("a name already used, in any case, is refused, and so is a blueprint that says nothing of what to take", async () => {
    await withApp(async (client) => {
      const { bp } = await seeded(client);
      const first = await client.post<Json>(bp, { name: "Quiz", rules: rules(["chapter", "1", 1]) });
      const second = await client.post<Json>(bp, { name: "Other", rules: rules(["chapter", "2", 1]) });
      const clash = await client.post<Json>(bp, { name: "QUIZ", rules: rules(["chapter", "2", 1]) });
      assert.equal(clash.status, 400);
      assert.match(clash.json["error"], /already holds a blueprint called "Quiz"/);
      const rename = await client.put<Json>(`${bp}/${second.json["blueprint"].id}`, { name: "quiz" });
      assert.equal(rename.status, 400);
      const twice = await client.post<Json>(bp, { name: "Twice", rules: rules(["chapter", "1", 1], ["chapter", "1", 2]) });
      assert.equal(twice.status, 400);
      assert.match(twice.json["error"], /same thing/);
      assert.equal((await client.get<Json>(bp)).json["blueprints"].length, 2, "the refused ones were not kept");
      assert.equal((await client.get<Json>(`${bp}/${first.json["blueprint"].id}`)).json["blueprint"].name, "Quiz");
    });
  });
});

describe("drawing from a blueprint", () => {
  test("takes what each rule asks for and says what it did not find", async () => {
    await withApp(async (client) => {
      const { bp, ids } = await seeded(client);
      const made = (await client.post<Json>(bp, { name: "Mixed", rules: rules(["chapter", "1", 5], ["chapter", "2", 6]) })).json["blueprint"];
      const reply = await client.post<Json>(`${bp}/${made.id}/draw`, {});
      assert.equal(reply.status, 200, reply.text);
      const got: string[] = reply.json["ids"];
      assert.equal(got.length, 9, "five from chapter one and the four there are in chapter two");
      assert.equal(new Set(got).size, 9);
      assert.equal(reply.json["wanted"], 11);
      assert.equal(reply.json["short"], 2);
      assert.equal(got.filter((id) => (ids["1"] as string[]).includes(id)).length, 5);
      assert.equal(got.filter((id) => (ids["2"] as string[]).includes(id)).length, 4);
      assert.ok(!got.includes((ids["unkeyed"] as string[])[0] as string), "a question with no usable key is never drawn");
      assert.deepEqual(reply.json["rules"].map((r: Json) => [r.axis, r.value, r.count, r.taken, r.short]), [["chapter", "1", 5, 5, 0], ["chapter", "2", 6, 4, 2]]);
      assert.match(reply.json["notes"].join("\n"), /9 of 11 questions taken, 2 short/);
      assert.match(reply.json["notes"].join("\n"), /chapter 2: wanted 6, took 4; the bank has no more/);
      assert.match(reply.json["seed"], /^[0-9a-f]{12}$/);
    });
  });

  test("does not take what is already chosen, and another press takes others", async () => {
    await withApp(async (client) => {
      const { bp, ids } = await seeded(client);
      const made = (await client.post<Json>(bp, { name: "One", rules: rules(["chapter", "1", 4]) })).json["blueprint"];
      const taken = (ids["1"] as string[]).slice(0, 5);
      const reply = await client.post<Json>(`${bp}/${made.id}/draw`, { chosen: taken });
      assert.equal(reply.json["ids"].length, 3, "eight keyed in chapter one, five already chosen");
      for (const id of reply.json["ids"]) assert.ok(!taken.includes(id));
      assert.equal(reply.json["rules"][0].left.chosen, 5);
      const seen = new Set<string>();
      for (let i = 0; i < 6; i++) for (const id of (await client.post<Json>(`${bp}/${made.id}/draw`, {})).json["ids"]) seen.add(id);
      assert.ok(seen.size > 4, "six presses reach more than four questions");
    });
  });

  test("changes nothing: the bank is as it was", async () => {
    await withApp(async (client) => {
      const { bp, base } = await seeded(client);
      const made = (await client.post<Json>(bp, { name: "One", rules: rules(["chapter", "1", 4]) })).json["blueprint"];
      const before = JSON.stringify((await client.get<Json>(base)).json) + JSON.stringify((await client.get<Json>(bp)).json);
      await client.post(`${bp}/${made.id}/draw`, {});
      await client.put(`${bp}/${made.id}`, { rules: rules(["chapter", "", 1]) });
      assert.equal(JSON.stringify((await client.get<Json>(base)).json) + JSON.stringify((await client.get<Json>(bp)).json), before);
    });
  });

  test("a blueprint that is not there is not found", async () => {
    await withApp(async (client) => {
      const { bp } = await seeded(client);
      const missing = "bp_00000000000000000000000000";
      assert.equal((await client.post(`${bp}/${missing}/draw`, {})).status, 404);
      assert.equal((await client.put(`${bp}/${missing}`, { name: "x" })).status, 404);
      assert.equal((await client.del(`${bp}/${missing}`)).status, 404);
    });
  });
});

describe("what a request may say", () => {
  test("is refused when it is not what it should be", async () => {
    await withApp(async (client) => {
      const { bp } = await seeded(client);
      const good = rules(["chapter", "1", 2]);
      const bad: Array<[string, unknown, RegExp]> = [
        ["no name", { rules: good }, /name is needed/],
        ["a blank name", { name: "   ", rules: good }, /name is needed/],
        ["a name that is not text", { name: 3, rules: good }, /must be text/],
        ["a name that is too long", { name: "x".repeat(121), rules: good }, /at most 120 characters/],
        ["no rules", { name: "A" }, /list of 1 to 50/],
        ["rules that are not a list", { name: "A", rules: "all" }, /list of 1 to 50/],
        ["an empty list of rules", { name: "A", rules: [] }, /list of 1 to 50/],
        ["too many rules", { name: "A", rules: Array.from({ length: 51 }, (_, i) => ({ axis: "chapter", value: String(i), count: 1 })) }, /list of 1 to 50/],
        ["a rule that is not an object", { name: "A", rules: [3] }, /Rule 1 must be an object/],
        ["an axis it does not know", { name: "A", rules: rules(["points", "1", 1]) }, /Say what rule 1 is by, from objective, chapter/],
        ["a blank value, which would match every question", { name: "A", rules: rules(["chapter", "", 1]) }, /value in rule 1 is needed/],
        ["a value of spaces", { name: "A", rules: rules(["chapter", "   ", 1]) }, /Rule 1 needs a value/],
        ["a value that is too long", { name: "A", rules: rules(["chapter", "x".repeat(201), 1]) }, /at most 200 characters/],
        ["a count of nothing", { name: "A", rules: rules(["chapter", "1", 0]) }, /whole number from 1 to 1000/],
        ["a count of too many", { name: "A", rules: rules(["chapter", "1", 1001]) }, /whole number from 1 to 1000/],
        ["a count that is text", { name: "A", rules: [{ axis: "chapter", value: "1", count: "3" }] }, /whole number/],
        ["a field of a rule it does not know", { name: "A", rules: [{ axis: "chapter", value: "1", count: 3, weight: 2 }] }, /field, weight, that is not part of it/],
        ["a field it does not know", { name: "A", rules: good, seed: "mine" }, /field, seed, that is not part of it/],
      ];
      for (const [what, body, message] of bad) {
        const reply = await client.post<Json>(bp, body);
        assert.equal(reply.status, 400, `${what}: ${reply.text}`);
        assert.match(reply.json["error"], message, what);
      }
      assert.deepEqual((await client.get<Json>(bp)).json["blueprints"], [], "none was kept");
    });
  });

  test("a change must say what to change, and a draw takes only the questions already chosen", async () => {
    await withApp(async (client) => {
      const { bp } = await seeded(client);
      const made = (await client.post<Json>(bp, { name: "One", rules: rules(["chapter", "1", 2]) })).json["blueprint"];
      assert.match((await client.put<Json>(`${bp}/${made.id}`, {})).json["error"], /Say what to change/);
      assert.equal((await client.put<Json>(`${bp}/${made.id}`, { seed: "x" })).status, 400);
      const draw = `${bp}/${made.id}/draw`;
      const bad: Array<[string, unknown, RegExp]> = [
        ["a field it does not know", { seed: "mine" }, /field, seed, that is not part of it/],
        ["chosen that is not a list", { chosen: "abc" }, /list of question ids/],
        ["chosen with an id that is not text", { chosen: [1] }, /list of question ids/],
        ["chosen with an id that is too long", { chosen: ["x".repeat(81)] }, /list of question ids/],
        ["chosen with too many", { chosen: Array(1001).fill("a") }, /list of question ids/],
      ];
      for (const [what, body, message] of bad) {
        const reply = await client.post<Json>(draw, body);
        assert.equal(reply.status, 400, what);
        assert.match(reply.json["error"], message, what);
      }
    });
  });

  test("a bank that is not there is not found, and a name is checked before it is used", async () => {
    await withApp(async (client) => {
      assert.equal((await client.get("/api/sheets/Nothing/blueprints")).status, 404);
      assert.equal((await client.post("/api/sheets/Nothing/blueprints", { name: "A", rules: rules(["chapter", "1", 1]) })).status, 404);
      const sneaky = await client.get("/api/sheets/..%2f..%2fx/blueprints");
      assert.ok(sneaky.status === 400 || sneaky.status === 404, `status ${sneaky.status}`);
    });
  });

  test("a change has to say it is the app's own, and a draw is not a page to read", async () => {
    await withApp(async (client) => {
      const { bp } = await seeded(client);
      const made = (await client.post<Json>(bp, { name: "One", rules: rules(["chapter", "1", 2]) })).json["blueprint"];
      const headers = { host: `127.0.0.1:${client.server.port}`, cookie: client.cookie, "content-type": "application/json" };
      for (const [method, path] of [["POST", bp], ["PUT", `${bp}/${made.id}`], ["DELETE", `${bp}/${made.id}`], ["POST", `${bp}/${made.id}/draw`]] as const) {
        assert.equal((await rawRequest(client.server.port, path, headers, method)).status, 403, `${method} ${path}`);
      }
      assert.equal((await client.get(`${bp}/${made.id}/draw`)).status, 404);
      assert.equal((await client.get<Json>(bp)).json["blueprints"].length, 1, "and none of those changed anything");
    });
  });
});

describe("a rule for several values together", () => {
  /** Chapter one's eight essays: the first three at the apply level and the rest at remember; chapter two's four have none. */
  const cell = (chapter: string, bloom: string, count: number) => ({ axis: "chapter", value: chapter, count, and: [{ axis: "bloom", value: bloom }] });

  test("is made, read, changed, drawn and kept on disk, with its other values", async () => {
    await withApp(async (client) => {
      const { bp, ids } = await seeded(client, "Cells");
      const made = await client.post<Json>(bp, { name: "Grid", rules: [cell("1", "apply", 5), { axis: "chapter", value: "2", count: 2 }] });
      assert.equal(made.status, 200, made.text);
      const one = made.json["blueprint"];
      assert.deepEqual(one.rules, [cell("1", "apply", 5), { axis: "chapter", value: "2", count: 2 }], "a rule of one value carries no list of others");
      assert.equal("and" in one.rules[1], false);

      // The draw takes only the cell, says which cell came out short, and names the other value in what it answers.
      const reply = await client.post<Json>(`${bp}/${one.id}/draw`, {});
      assert.equal(reply.status, 200, reply.text);
      const got: string[] = reply.json["ids"];
      const apply = (ids["1"] as string[]).slice(0, 3);
      assert.deepEqual(got.filter((id) => (ids["1"] as string[]).includes(id)).sort(), [...apply].sort(), "the three at the apply level, and none at remember");
      assert.equal(got.filter((id) => (ids["2"] as string[]).includes(id)).length, 2);
      assert.equal(reply.json["short"], 2);
      assert.deepEqual(reply.json["rules"].map((r: Json) => [r.axis, r.value, r.and ?? null, r.count, r.taken, r.short]), [["chapter", "1", [{ axis: "bloom", value: "apply" }], 5, 3, 2], ["chapter", "2", null, 2, 2, 0]]);
      assert.match(reply.json["notes"].join("\n"), /chapter 1 and bloom apply: wanted 5, took 3; the bank has no more/);

      // A change to the name leaves the rules, other values included; a change to the rules replaces them.
      const renamed = await client.put<Json>(`${bp}/${one.id}`, { name: "Grid 1" });
      assert.deepEqual(renamed.json["blueprint"].rules, one.rules);
      const changed = await client.put<Json>(`${bp}/${one.id}`, { rules: [{ axis: " chapter ".trim(), value: " 1 ", count: 2, and: [{ axis: "bloom", value: " remember " }] }] });
      assert.equal(changed.status, 200, changed.text);
      assert.deepEqual(changed.json["blueprint"].rules, [cell("1", "remember", 2)], "its values are tidied");

      // Read from the file afresh, not through the server.
      const folder = client.server.context.library.banks;
      const file = readdirSync(folder).find((name) => name.endsWith(".openassess")) as string;
      const { bank, report } = await Bank.open(join(folder, file));
      assert.deepEqual(report.invalid, []);
      assert.deepEqual(bank.listBlueprints()[0]?.rules, [cell("1", "remember", 2)]);
    });
  });

  test("a set that could never be met, a blank, a field it does not know and a list that is not one are refused, and nothing is kept", async () => {
    await withApp(async (client) => {
      const { bp } = await seeded(client, "Refused");
      const refused: Array<[string, unknown, RegExp]> = [
        ["two chapters", [{ axis: "chapter", value: "1", count: 1, and: [{ axis: "chapter", value: "2" }] }], /one chapter.*could never take a question/],
        ["a blank", [{ axis: "chapter", value: "1", count: 1, and: [{ axis: "bloom", value: "   " }] }], /Value 2 of rule 1 needs a value/],
        ["an axis it does not know", [{ axis: "chapter", value: "1", count: 1, and: [{ axis: "colour", value: "red" }] }], /colour|what value 2 of rule 1 is by/i],
        ["a field of a value it does not know", [{ axis: "chapter", value: "1", count: 1, and: [{ axis: "bloom", value: "apply", weight: 2 }] }], /weight/],
        ["a list that is not one", [{ axis: "chapter", value: "1", count: 1, and: "bloom" }], /other values of rule 1/],
        ["too many", [{ axis: "tag", value: "a", count: 1, and: ["b", "c", "d", "e", "f"].map((value) => ({ axis: "tag", value })) }], /other values of rule 1/],
        ["a value that is not an object", [{ axis: "chapter", value: "1", count: 1, and: ["apply"] }], /Value 2 of rule 1 must be an object/],
        ["the same cell twice, the other way round", [cell("1", "apply", 1), { axis: "bloom", value: "apply", count: 1, and: [{ axis: "chapter", value: "1" }] }], /same thing/],
      ];
      for (const [what, rules, message] of refused) {
        const reply = await client.post<Json>(bp, { name: `Refused ${what}`, rules });
        assert.equal(reply.status, 400, `${what}: ${reply.text}`);
        assert.match(reply.json["error"], message, what);
      }
      assert.deepEqual((await client.get<Json>(bp)).json["blueprints"], [], "none of them was kept");
    });
  });

  test("a rule of another axis and the same value is another rule, and a rule can be a tag and another tag", async () => {
    await withApp(async (client) => {
      const { bp } = await seeded(client, "Others");
      const made = await client.post<Json>(bp, { name: "Several", rules: [{ axis: "tag", value: "lab", count: 1, and: [{ axis: "tag", value: "exam" }] }, cell("1", "apply", 1), { axis: "chapter", value: "1", count: 1 }] });
      assert.equal(made.status, 200, made.text);
      assert.equal(made.json["blueprint"].rules.length, 3);
    });
  });
});
