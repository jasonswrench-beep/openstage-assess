/**
 * Files from other learning systems, brought in through the app: a Moodle XML file, a QTI package and a bare QTI file. What the
 * engine does with each is the engine's test (`import-moodle-xml.test.ts`, `import-qti.test.ts`); this is the requests: the file is
 * told by what it holds, its questions and pictures are shown, its lines are beside each question, a file that cannot be read is
 * refused in words, and what is saved into a bank is what was read.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { Bank, exportBlackboardUpload, exportCommonCartridge, exportQti12, exportQti21, createQuestion, plainToRich } from "../src/engine.ts";
import { withApp, type Client } from "./support/app.ts";

type Json = Record<string, any>;
const SAMPLE = fileURLToPath(new URL("../../../fixtures/moodle-xml/moodle-sample.xml", import.meta.url));

const send = (client: Client, name: string, bytes: Uint8Array | Buffer) => client.send<Json>("POST", `/api/import?name=${encodeURIComponent(name)}`, Buffer.from(bytes));

/** A bank with one question of each kind these formats hold, to be exported as a package and brought back. */
function questions() {
  const opt = (id: string, text: string, correct: boolean) => ({ id, content: plainToRich(text), correct });
  const at = "2026-01-01T00:00:00.000Z";
  return [
    createQuestion({ type: "multipleChoice", stem: plainToRich("What is the capital of France?"), body: { shuffle: true, options: [opt("o1", "Berlin", false), opt("o2", "Paris", true), opt("o3", "Rome", false)] }, by: "t", at }),
    createQuestion({ type: "trueFalse", stem: plainToRich("A light-year is a measure of time."), body: { correct: false }, by: "t", at }),
    createQuestion({ type: "shortAnswer", stem: plainToRich("Name the hardest common mineral."), body: { caseSensitive: false, accepted: ["Diamond"] }, by: "t", at }),
  ];
}

describe("a Moodle XML file", () => {
  test("is told by what it holds, read into questions, and shown with its own lines beside each one", async () => {
    await withApp(async (client) => {
      const reply = await send(client, "moodle-sample.xml", readFileSync(SAMPLE));
      assert.equal(reply.status, 200, reply.text);
      assert.deepEqual(reply.json["counts"], { parsed: 8, needsReview: 0, failed: 1, orphans: 1, skipped: 0, total: 9 });
      assert.equal(reply.json["profile"], "moodle-xml");
      const first = (await client.get<Json>(`/api/sessions/${reply.json["id"]}/questions/0`)).json["question"].origin.source;
      const lines = reply.json["source"].slice(first.firstBlock, first.lastBlock + 1).join("\n");
      assert.match(lines, /<question type="multichoice">/);
      assert.match(lines, /Capital of France|What is the capital of/);
      assert.match(reply.json["fileFindings"].map((f: Json) => f.message).join("\n"), /Moodle's standard sentence/);
    });
  });

  test("keeps the picture, serves it by its bytes, and writes it into a bank when the question is saved", async () => {
    await withApp(async (client, home) => {
      const view = (await send(client, "moodle-sample.xml", readFileSync(SAMPLE))).json;
      const at = view["questions"].findIndex((q: Json) => q.title === "Look at the figure");
      assert.ok(at >= 0);
      const q = (await client.get<Json>(`/api/sessions/${view["id"]}/questions/${at}`)).json["question"];
      assert.equal(q.pictures.length, 1);
      assert.equal(q.pictures[0].alt, "A blue box");
      const picture = await client.get(`/api/sessions/${view["id"]}/media/${q.pictures[0].file}`);
      assert.equal(picture.status, 200);
      assert.equal(picture.headers.get("content-type"), "image/png");
      assert.equal(picture.headers.get("x-content-type-options"), "nosniff");

      const saved = await client.post<Json>(`/api/sessions/${view["id"]}/save`, { title: "From Moodle" });
      assert.equal(saved.status, 200, saved.text);
      const { bank } = await Bank.open(join(home, "Banks", `${saved.json["bank"]}.openassess`));
      assert.equal(bank.questions.size, 9, "the eight that were read and the cloze, kept as text that fails");
      assert.equal(bank.media.size, 1);
      assert.deepEqual(bank.missingMedia(), []);
    });
  });

  test("an XML file that is not a quiz, and one that is broken, are read as nothing and say why", async () => {
    await withApp(async (client) => {
      const other = await send(client, "other.xml", Buffer.from('<?xml version="1.0"?><html><body>hi</body></html>'));
      assert.equal(other.status, 200, other.text);
      assert.equal(other.json["counts"].total, 0);
      assert.match(other.json["fileFindings"].map((f: Json) => f.message).join("\n"), /begins with <quiz>/);
      const broken = await send(client, "broken.xml", Buffer.from("<quiz><question"));
      assert.equal(broken.json["counts"].total, 0);
      assert.match(broken.json["fileFindings"].map((f: Json) => f.message).join("\n"), /not well formed XML/);
    });
  });
});

describe("a QTI package or file", () => {
  for (const [label, run] of [
    ["1.2", exportQti12],
    ["2.1", exportQti21],
  ] as const) {
    test(`a ${label} package is read, shown with its XML beside each question, and saved into a bank`, async () => {
      await withApp(async (client, home) => {
        const out = run(questions(), { name: "Quiz" });
        const reply = await send(client, out.files[0]?.name ?? "quiz.zip", out.files[0]?.bytes as Uint8Array);
        assert.equal(reply.status, 200, reply.text);
        assert.equal(reply.json["profile"], "qti");
        assert.deepEqual(reply.json["counts"], { parsed: 3, needsReview: 0, failed: 0, orphans: 0, skipped: 0, total: 3 });
        assert.deepEqual(reply.json["questions"].map((q: Json) => q.type), ["multipleChoice", "trueFalse", "shortAnswer"]);
        const second = (await client.get<Json>(`/api/sessions/${reply.json["id"]}/questions/1`)).json["question"].origin.source;
        assert.match(reply.json["source"].slice(second.firstBlock, second.lastBlock + 1).join("\n"), /light-year/);

        const saved = await client.post<Json>(`/api/sessions/${reply.json["id"]}/save`, { title: `QTI ${label}` });
        assert.equal(saved.status, 200, saved.text);
        const { bank } = await Bank.open(join(home, "Banks", `${saved.json["bank"]}.openassess`));
        assert.equal(bank.questions.size, 3);
        const keyed = [...bank.questions.values()].map((q) => q.findings.filter((f) => f.severity === "error").length);
        assert.deepEqual(keyed, [0, 0, 0], "every key came across");
      });
    });
  }

  test("a bare QTI file with a .txt name is told by what it holds", async () => {
    await withApp(async (client) => {
      const xml = `<?xml version="1.0"?><questestinterop><assessment ident="a" title="T"><section ident="s"><item ident="i1" title="One"><presentation><material><mattext texttype="text/plain">Pick one.</mattext></material><response_lid ident="response1" rcardinality="Single"><render_choice><response_label ident="a"><material><mattext>A</mattext></material></response_label><response_label ident="b"><material><mattext>B</mattext></material></response_label></render_choice></response_lid></presentation><resprocessing><outcomes><decvar maxvalue="100" minvalue="0" varname="SCORE" vartype="Decimal"/></outcomes><respcondition continue="No"><conditionvar><varequal respident="response1">b</varequal></conditionvar><setvar varname="SCORE" action="Set">100</setvar></respcondition></resprocessing></item></section></assessment></questestinterop>`;
      const reply = await send(client, "export.txt", Buffer.from(xml));
      assert.equal(reply.status, 200, reply.text);
      assert.equal(reply.json["profile"], "qti");
      assert.equal(reply.json["counts"].parsed, 1);
    });
  });

  test("a Common Cartridge file (.imscc), such as this program writes for Brightspace, is read as a package with every key", async () => {
    await withApp(async (client) => {
      const out = exportCommonCartridge(questions(), { name: "Cartridge" });
      const file = out.files[0];
      assert.match(file?.name ?? "", /\.imscc$/);
      const reply = await send(client, file?.name ?? "", file?.bytes as Uint8Array);
      assert.equal(reply.status, 200, reply.text);
      assert.equal(reply.json["profile"], "qti");
      assert.equal(reply.json["counts"].total, 3, JSON.stringify(reply.json["counts"]));
      assert.equal(reply.json["counts"].failed, 0);
    });
  });

  test("a zip that is not a package, or is cut short, is read as nothing and says why", async () => {
    await withApp(async (client) => {
      const cut = (exportQti21(questions(), { name: "Quiz" }).files[0]?.bytes as Uint8Array).slice(0, 60);
      const reply = await send(client, "cut.zip", cut);
      assert.equal(reply.status, 200, reply.text);
      assert.equal(reply.json["counts"].total, 0);
      assert.ok(reply.json["fileFindings"].some((f: Json) => f.severity === "error" && /zip/i.test(f.message)));
    });
  });
});

describe("a Blackboard upload file", () => {
  // The file this program writes for Blackboard used to come back as "No questions were found" and a page of text no question used.
  test("this program's own file is told by what it holds, read with every key, and what is saved is what was read", async () => {
    await withApp(async (client) => {
      const file = exportBlackboardUpload(questions(), { name: "Bank" }).files[0] as { content: string };
      const reply = await send(client, "Bank - Blackboard.txt", Buffer.from(file.content, "utf8"));
      assert.equal(reply.status, 200, reply.text);
      assert.equal(reply.json["profile"], "blackboard-upload");
      assert.equal(reply.json["counts"].total, 3);
      assert.equal(reply.json["counts"].failed, 0, JSON.stringify(reply.json["counts"]));
      assert.equal(reply.json["counts"].orphans, 0);
      const types = [];
      for (let n = 0; n < 3; n++) types.push((await client.get<Json>(`/api/sessions/${reply.json["id"]}/questions/${n}`)).json["question"].type);
      assert.deepEqual(types, ["multipleChoice", "trueFalse", "shortAnswer"]);
      const paris = (await client.get<Json>(`/api/sessions/${reply.json["id"]}/questions/0`)).json["question"];
      assert.deepEqual(paris.body.options.filter((o: Json) => o.correct).map((o: Json) => o.text), ["Paris"]);
      assert.match(reply.json["fileFindings"].map((f: Json) => f.message).join("\n"), /no points/);
      const saved = await client.post<Json>(`/api/sessions/${reply.json["id"]}/save`, { title: "From Blackboard" });
      assert.equal(saved.status, 200, saved.text);
      assert.equal(saved.json["added"], 3);
    });
  });

  test("a row whose key cannot be read is refused in words and kept, not guessed", async () => {
    await withApp(async (client) => {
      const text = ["MC\tWhich?\ta\tcorrect\tb\tmaybe", "TF\tIce is cold.\ttrue"].join("\r\n") + "\r\n";
      const reply = await send(client, "upload.txt", Buffer.from(text, "utf8"));
      assert.equal(reply.json["profile"], "blackboard-upload");
      assert.deepEqual([reply.json["counts"].parsed, reply.json["counts"].failed], [1, 1]);
      const bad = (await client.get<Json>(`/api/sessions/${reply.json["id"]}/questions/0`)).json["question"];
      assert.equal(bad.type, "essay");
      assert.match(JSON.stringify(bad.findings), /neither correct nor incorrect/);
    });
  });
});
