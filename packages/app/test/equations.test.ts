/**
 * Equations in the app: a Word file's equations come in with the questions, are shown from the import and from the bank as the
 * MathML and LaTeX the engine wrote, stand in the text by a token the person moves or removes like words, and are kept in the bank
 * with Word's own copy. What the engine reads from a Word file is the engine's test (`equations.test.ts` there); this is the requests
 * and the rule of the editor: text the person leaves alone is kept exactly as stored.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";

import { docx, paragraph, run } from "../../assess/test/support/docx-writer.ts";
import { Bank, createQuestion, mathPlaceholder, plainToRich, type Question } from "../src/engine.ts";
import { editFromInput, toEditor } from "../src/editor.ts";
import { withApp, type Client } from "./support/app.ts";

type Json = Record<string, any>;

const r = (text: string): string => `<m:r><m:t>${text}</m:t></m:r>`;
const oMath = (inner: string): string => `<m:oMath>${inner}</m:oMath>`;
const frac = (num: string, den: string): string => `<m:f><m:fPr><m:ctrlPr/></m:fPr><m:num>${r(num)}</m:num><m:den>${r(den)}</m:den></m:f>`;
const root = (inner: string): string => `<m:rad><m:radPr><m:degHide m:val="1"/></m:radPr><m:deg/><m:e>${r(inner)}</m:e></m:rad>`;

/** Three questions: an equation in the stem, one in an option, and one with none. */
function sheet(): Uint8Array {
  return docx({
    body: [
      paragraph(run("1. Solve ") + oMath(frac("x", "2") + r("=3")) + run(" for x.")),
      paragraph(run("a) 6")),
      paragraph(run("b) 5")),
      paragraph(run("Answer: a")),
      paragraph(run("2. Which is the square root of sixteen?")),
      paragraph(run("a) ") + oMath(root("16"))),
      paragraph(run("b) ") + oMath(r("4"))),
      paragraph(run("Answer: b")),
      paragraph(run("3. What is two plus two?")),
      paragraph(run("a) Three")),
      paragraph(run("b) Four")),
      paragraph(run("Answer: b")),
    ].join(""),
  });
}

const importSheet = async (client: Client): Promise<Json> => {
  const reply = await client.send<Json>("POST", "/api/import?name=equations.docx", Buffer.from(sheet()));
  assert.equal(reply.status, 200, reply.text);
  return reply.json;
};

const question = async (client: Client, sessionId: string, at: number): Promise<Json> => (await client.get<Json>(`/api/sessions/${sessionId}/questions/${at}`)).json["question"];

describe("a Word file's equations in the import", () => {
  test("are shown with their LaTeX and their MathML, and stand in the text by a token", async () => {
    await withApp(async (client) => {
      const view = await importSheet(client);
      assert.deepEqual(view["questions"].map((x: Json) => x.verdict), ["parsed", "parsed", "parsed"]);
      const q = await question(client, view["id"], 0);
      assert.equal(q.math, 1);
      assert.equal(q.equations.length, 1);
      const e = q.equations[0];
      assert.deepEqual([e.number, e.latex, e.placed], [1, "\\frac{x}{2}=3", true]);
      assert.ok(e.mathml.startsWith("<math "), e.mathml);
      assert.match(q.stem, /^Solve \[equation 1\] for x\.$/);
      assert.deepEqual(q.locked, [], "and no text is shut to editing for holding one");
    });
  });

  test("one in an option is the option's own, numbered after the stem's", async () => {
    await withApp(async (client) => {
      const view = await importSheet(client);
      const q = await question(client, view["id"], 1);
      assert.deepEqual(q.equations.map((e: Json) => [e.number, e.latex]), [[1, "\\sqrt{16}"], [2, "4"]]);
      assert.deepEqual(q.body.options.map((o: Json) => o.text), ["[equation 1]", "[equation 2]"]);
      assert.deepEqual(q.body.options.map((o: Json) => o.correct), [false, true]);
      assert.deepEqual(q.locked, []);
    });
  });

  test("a question with none has none", async () => {
    await withApp(async (client) => {
      const view = await importSheet(client);
      const q = await question(client, view["id"], 2);
      assert.deepEqual([q.math, q.equations], [0, []]);
    });
  });
});

describe("editing a question that has an equation", () => {
  const edit = async (client: Client, sessionId: string, at: number, change: (input: Json) => void): Promise<{ status: number; json: Json }> => {
    const q = await question(client, sessionId, at);
    const input: Json = { type: q.type, title: q.title, stem: q.stem, points: q.points, feedback: q.feedback, metadata: q.metadata, body: q.body };
    change(input);
    const reply = await client.put<Json>(`/api/sessions/${sessionId}/questions/${at}`, { input, expectVersion: q.version });
    return { status: reply.status, json: reply.json };
  };

  test("changing the words keeps the equation where the token stays", async () => {
    await withApp(async (client) => {
      const view = await importSheet(client);
      const reply = await edit(client, view["id"], 0, (i) => (i["stem"] = i["stem"].replace("for x.", "for the unknown.")));
      assert.equal(reply.status, 200, JSON.stringify(reply.json));
      const q = reply.json["question"];
      assert.equal(q.stem, "Solve [equation 1] for the unknown.");
      assert.deepEqual([q.equations.length, q.equations[0].placed, q.version], [1, true, 2]);
    });
  });

  test("moving a token moves the equation, and taking it out leaves the equation kept and not shown", async () => {
    await withApp(async (client) => {
      const view = await importSheet(client);
      const moved = await edit(client, view["id"], 0, (i) => (i["stem"] = "[equation 1] Solve this for x."));
      assert.equal(moved.status, 200);
      assert.equal(moved.json["question"].stem, "[equation 1] Solve this for x.");
      const removed = await edit(client, view["id"], 0, (i) => (i["stem"] = "Solve for x."));
      assert.equal(removed.status, 200);
      assert.equal(removed.json["question"].equations.length, 1, "the equation is still the question's");
      assert.equal(removed.json["question"].equations[0].placed, false, "and it says it is not in the text");
    });
  });

  test("a token for an equation the question does not have is refused in words, and nothing is changed", async () => {
    await withApp(async (client) => {
      const view = await importSheet(client);
      const reply = await edit(client, view["id"], 0, (i) => (i["stem"] = "Solve [equation 2] for x."));
      assert.equal(reply.status, 400);
      assert.match(reply.json["error"], /has \[equation 2\], and this question has one equation/);
      assert.equal((await question(client, view["id"], 0)).version, 1);
    });
  });

  test("a question without equations keeps the words [equation 1] as words", async () => {
    await withApp(async (client) => {
      const view = await importSheet(client);
      const reply = await edit(client, view["id"], 2, (i) => (i["stem"] = "What is two plus two? (see [equation 1] in your book)"));
      assert.equal(reply.status, 200, JSON.stringify(reply.json));
      assert.match(reply.json["question"].stem, /\[equation 1\] in your book/);
      assert.deepEqual(reply.json["question"].equations, []);
    });
  });

  test("an option that is an equation can be moved to another option, and the equations stay the question's", async () => {
    await withApp(async (client) => {
      const view = await importSheet(client);
      const reply = await edit(client, view["id"], 1, (i) => {
        i["body"].options[0].text = "[equation 2]";
        i["body"].options[1].text = "[equation 1]";
      });
      assert.equal(reply.status, 200, JSON.stringify(reply.json));
      assert.deepEqual(reply.json["question"].body.options.map((o: Json) => o.text), ["[equation 2]", "[equation 1]"]);
      assert.equal(reply.json["question"].equations.length, 2);
    });
  });

  test("an edit that leaves the text alone keeps the stored text exactly, with the equation in it", async () => {
    await withApp(async (client) => {
      const view = await importSheet(client);
      const reply = await edit(client, view["id"], 0, (i) => (i["points"] = 3));
      assert.equal(reply.status, 200);
      assert.equal(reply.json["question"].stem, "Solve [equation 1] for x.");
      assert.equal(reply.json["question"].equations[0].latex, "\\frac{x}{2}=3");
    });
  });
});

describe("a question with equations in a bank", () => {
  test("keeps the equations with Word's own copy, and shows them again when the bank is opened", async () => {
    await withApp(async (client, home) => {
      const view = await importSheet(client);
      const saved = await client.post<Json>(`/api/sessions/${view["id"]}/save`, { title: "Maths" });
      assert.equal(saved.status, 200, saved.text);
      const name = encodeURIComponent(saved.json["bank"]);
      const { bank } = await Bank.open(join(home, "Banks", `${saved.json["bank"]}.openassess`));
      const stored = bank.list();
      const first = stored.find((q) => q.math.length > 0 && q.math[0]!.latex.includes("frac"))!;
      assert.ok(first, "the question with the fraction is in the bank");
      assert.equal(first.math[0]!.source, "omml");
      assert.ok(first.math[0]!.omml?.startsWith("<m:oMath "), "Word's own copy is in the bank");
      const listed = await client.get<Json>(`/api/banks/${name}`);
      assert.ok((listed.json["questions"] as Json[]).some((x) => x.id === first.id), "the question is listed");
      const again = await client.get<Json>(`/api/banks/${name}/questions/${first.id}`);
      assert.equal(again.json["question"].equations[0].latex, "\\frac{x}{2}=3");
      assert.equal(again.json["question"].stem, "Solve [equation 1] for x.");
    });
  });
});

describe("the editor, on a question whose text refers to an equation it does not carry", () => {
  const dangling = (): Question =>
    createQuestion({
      type: "essay",
      stem: { format: "rich", content: `<p>Explain ${mathPlaceholder("gone")}.</p>` },
      body: {},
      points: 1,
      by: "test",
      at: "2026-01-01T00:00:00.000Z",
    });

  test("shuts that text to editing, as before, and says so in words if it is changed", () => {
    const q = dangling();
    const e = toEditor(q);
    assert.deepEqual(e.locked, ["stem"]);
    const input = { type: q.type, title: q.title, stem: "Something else entirely.", points: 1, feedback: { general: "", correct: "", incorrect: "" }, metadata: toEditor(q).metadata, body: toEditor(q).body };
    assert.throws(() => editFromInput(q, input as any), /refers to a picture or an equation that this question does not carry/);
  });

  test("keeps it exactly when it is left alone", () => {
    const q = dangling();
    const e = toEditor(q);
    const input = { type: q.type, title: q.title, stem: e.stem, points: 2, feedback: { general: "", correct: "", incorrect: "" }, metadata: e.metadata, body: e.body };
    assert.deepEqual(editFromInput(q, input as any).edit.stem, q.stem);
  });
});

describe("a question made by hand", () => {
  test("has no equations, and the words [equation 1] are only words", () => {
    const q = createQuestion({ type: "essay", stem: plainToRich("Discuss [equation 1]."), body: {}, points: 1, by: "test", at: "2026-01-01T00:00:00.000Z" });
    const e = toEditor(q);
    assert.deepEqual([e.math, e.equations, e.locked], [0, [], []]);
    assert.equal(e.stem, "Discuss [equation 1].");
  });
});
