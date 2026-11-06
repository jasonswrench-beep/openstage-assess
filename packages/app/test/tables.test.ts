/**
 * Tables in the app: a data table inside a question's text comes in from a Word file as a table of the question, is shown as the
 * rows and cells the engine wrote, stands in the text by a token the person moves or removes like words, and is kept in the bank. What
 * the engine reads from a Word file is the engine's test (`tables-in-stem.test.ts` there); this is the requests and the rule of the
 * editor: text the person leaves alone is kept exactly as stored, and changing the words round a table does not lose the table.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";

import { docx, paragraph, run, table } from "../../assess/test/support/docx-writer.ts";
import { Bank, createQuestion, plainToRich, rich, type Question } from "../src/engine.ts";
import { editFromInput, toEditor } from "../src/editor.ts";
import { withApp, type Client } from "./support/app.ts";

type Json = Record<string, any>;

const q = (text: string): string => paragraph(run(text));
const cells = (rows: string[][]): string => table(rows.map((row) => row.map((c) => paragraph(run(c)))));

/** Two questions: a table of scores in the stem of the first, and none in the second. */
function sheet(): Uint8Array {
  return docx({
    body: [
      q("1. Use the table to find the mean of the scores."),
      cells([["Student", "Score"], ["Ana", "80"], ["Ben", "90"]]),
      q("a) 80"),
      q("b) 85"),
      q("c) 90"),
      q("Answer: b"),
      q("2. What is two plus two?"),
      q("a) Three"),
      q("b) Four"),
      q("Answer: b"),
    ].join(""),
  });
}

const importSheet = async (client: Client): Promise<Json> => {
  const reply = await client.send<Json>("POST", "/api/import?name=tables.docx", Buffer.from(sheet()));
  assert.equal(reply.status, 200, reply.text);
  return reply.json;
};

const question = async (client: Client, sessionId: string, at: number): Promise<Json> => (await client.get<Json>(`/api/sessions/${sessionId}/questions/${at}`)).json["question"];

const edit = async (client: Client, sessionId: string, at: number, change: (input: Json) => void): Promise<{ status: number; json: Json }> => {
  const found = await question(client, sessionId, at);
  const input: Json = { type: found.type, title: found.title, stem: found.stem, points: found.points, feedback: found.feedback, metadata: found.metadata, body: found.body };
  change(input);
  const reply = await client.put<Json>(`/api/sessions/${sessionId}/questions/${at}`, { input, expectVersion: found.version });
  return { status: reply.status, json: reply.json };
};

describe("a Word file's data table in the import", () => {
  test("comes in as a table of the question, shown as rows and cells, with a token in the text", async () => {
    await withApp(async (client) => {
      const view = await importSheet(client);
      assert.deepEqual(view["questions"].map((x: Json) => x.verdict), ["parsed", "parsed"]);
      const found = await question(client, view["id"], 0);
      assert.equal(found.tables.length, 1);
      assert.equal(found.tables[0].number, 1);
      assert.deepEqual(found.tables[0].rows.map((row: Json[]) => row.map((c) => c.text)), [["Student", "Score"], ["Ana", "80"], ["Ben", "90"]]);
      assert.ok(found.tables[0].rows.flat().every((c: Json) => c.header === false && c.colspan === 1 && c.rowspan === 1));
      assert.equal(found.tables[0].text, "Student | Score\nAna | 80\nBen | 90");
      assert.equal(found.stem, "Use the table to find the mean of the scores.\n[table 1]");
      assert.deepEqual([found.locked, found.formatted], [[], []], "a table shuts no text to editing and is not formatting that editing would flatten");
    });
  });

  test("a question with none has none", async () => {
    await withApp(async (client) => {
      const view = await importSheet(client);
      assert.deepEqual((await question(client, view["id"], 1)).tables, []);
    });
  });
});

describe("editing a question that has a table", () => {
  test("changing the words keeps the table where its token stays, and says nothing was flattened", async () => {
    await withApp(async (client) => {
      const view = await importSheet(client);
      const reply = await edit(client, view["id"], 0, (i) => (i["stem"] = "Use the table to find the average score.\n[table 1]"));
      assert.equal(reply.status, 200, JSON.stringify(reply.json));
      const found = reply.json["question"];
      assert.equal(found.stem, "Use the table to find the average score.\n[table 1]");
      assert.equal(found.tables.length, 1);
      assert.deepEqual(reply.json["flattened"], []);
      assert.equal(found.version, 2);
    });
  });

  test("words after the token are kept after it, in a paragraph of their own", async () => {
    await withApp(async (client) => {
      const view = await importSheet(client);
      const reply = await edit(client, view["id"], 0, (i) => (i["stem"] = "Use the table.\n[table 1]\nThen find the mean."));
      assert.equal(reply.status, 200, JSON.stringify(reply.json));
      assert.equal(reply.json["question"].stem, "Use the table.\n[table 1]\nThen find the mean.");
      assert.equal(reply.json["question"].tables.length, 1);
    });
  });

  test("moving the token moves the table, and taking it out takes the table out of the question", async () => {
    await withApp(async (client) => {
      const view = await importSheet(client);
      const moved = await edit(client, view["id"], 0, (i) => (i["stem"] = "[table 1]\nUse the table to find the mean of the scores."));
      assert.equal(moved.status, 200);
      assert.equal(moved.json["question"].stem, "[table 1]\nUse the table to find the mean of the scores.");
      const removed = await edit(client, view["id"], 0, (i) => (i["stem"] = "Find the mean of 80 and 90."));
      assert.equal(removed.status, 200);
      assert.deepEqual(removed.json["question"].tables, []);
      assert.equal(removed.json["question"].stem, "Find the mean of 80 and 90.");
    });
  });

  test("a token for a table the question does not have is refused in words, and nothing is changed", async () => {
    await withApp(async (client) => {
      const view = await importSheet(client);
      const reply = await edit(client, view["id"], 0, (i) => (i["stem"] = "Use the table.\n[table 2]"));
      assert.equal(reply.status, 400);
      assert.match(reply.json["error"], /has \[table 2\], and this question has one table/);
      assert.equal((await question(client, view["id"], 0)).version, 1);
    });
  });

  test("a question without a table keeps the words [table 1] as words", async () => {
    await withApp(async (client) => {
      const view = await importSheet(client);
      const reply = await edit(client, view["id"], 1, (i) => (i["stem"] = "What is two plus two? (see [table 1] in your book)"));
      assert.equal(reply.status, 200, JSON.stringify(reply.json));
      assert.match(reply.json["question"].stem, /\[table 1\] in your book/);
      assert.deepEqual(reply.json["question"].tables, []);
    });
  });

  test("an edit that leaves the text alone keeps the stored text exactly, table markup and all", async () => {
    await withApp(async (client) => {
      const view = await importSheet(client);
      const reply = await edit(client, view["id"], 0, (i) => (i["points"] = 3));
      assert.equal(reply.status, 200);
      assert.equal(reply.json["question"].stem, "Use the table to find the mean of the scores.\n[table 1]");
      assert.equal(reply.json["question"].tables[0].rows.length, 3);
    });
  });

  test("the title follows the words and not the first row of the table", async () => {
    await withApp(async (client) => {
      const view = await importSheet(client);
      const reply = await edit(client, view["id"], 0, (i) => (i["stem"] = "Read the scores in the table.\n[table 1]"));
      assert.equal(reply.status, 200);
      assert.equal(reply.json["question"].title, "Read the scores in the table.");
    });
  });
});

describe("a question with a table in a bank", () => {
  test("keeps the table, and shows it again when the bank is opened", async () => {
    await withApp(async (client, home) => {
      const view = await importSheet(client);
      const saved = await client.post<Json>(`/api/sessions/${view["id"]}/save`, { title: "Stats" });
      assert.equal(saved.status, 200, saved.text);
      const name = encodeURIComponent(saved.json["bank"]);
      const { bank } = await Bank.open(join(home, "Banks", `${saved.json["bank"]}.openassess`));
      const first = bank.list().find((x) => x.stem.content.includes("<table>"))!;
      assert.ok(first, "the question with the table is in the bank");
      assert.match(first.stem.content, /<table><tbody><tr><td>Student<\/td><td>Score<\/td><\/tr>/);
      const again = await client.get<Json>(`/api/banks/${name}/questions/${first.id}`);
      assert.equal(again.json["question"].tables.length, 1);
      assert.equal(again.json["question"].stem, "Use the table to find the mean of the scores.\n[table 1]");
    });
  });
});

describe("the editor on a table it did not make", () => {
  const withTable = (html: string, extra: Partial<Parameters<typeof createQuestion>[0]> = {}): Question =>
    createQuestion({ type: "essay", stem: rich(html), body: {}, points: 1, by: "test", at: "2026-01-01T00:00:00.000Z", ...extra });

  test("two tables that are alike are one table with two tokens, and both stay when the words change", () => {
    const same = "<table><tbody><tr><td>1</td><td>2</td></tr></tbody></table>";
    const found = withTable(`<p>First</p>${same}<p>Second</p>${same}`);
    const shown = toEditor(found);
    assert.equal(shown.tables.length, 1);
    assert.equal(shown.stem, "First\n[table 1]\nSecond\n[table 1]");
    const edited = editFromInput(found, { ...shown, stem: "First one\n[table 1]\nSecond\n[table 1]" });
    assert.equal((edited.edit.stem as { content: string }).content.match(/<table>/g)?.length, 2);
  });

  test("a table inside a table is shown by its words, and is still a token in the text", () => {
    const nested = "<table><tbody><tr><td><table><tbody><tr><td>in</td></tr></tbody></table></td></tr></tbody></table>";
    const shown = toEditor(withTable(`<p>See</p>${nested}`));
    assert.equal(shown.tables.length, 1);
    assert.deepEqual(shown.tables[0]?.rows, []);
    assert.match(shown.tables[0]?.text ?? "", /in/);
    assert.equal(shown.stem, "See\n[table 1]");
  });

  test("a table with a header row has its header cells shown as headers", () => {
    const shown = toEditor(withTable('<table><thead><tr><th scope="col">Name</th><th scope="col">Score</th></tr></thead><tbody><tr><td>Ana</td><td>80</td></tr></tbody></table>'));
    assert.deepEqual(shown.tables[0]?.rows.map((row) => row.map((c) => c.header)), [[true, true], [false, false]]);
  });

  test("a plain text that says <table> is words and is not a table", () => {
    const found = createQuestion({ type: "essay", stem: plainToRich("Write <table> in HTML."), body: {}, points: 1, by: "test", at: "2026-01-01T00:00:00.000Z" });
    assert.deepEqual(toEditor(found).tables, []);
  });
});
