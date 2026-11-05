/**
 * A bank that opened with something wrong says so, in the app.
 *
 * A file in a bank that cannot be read (a question damaged by a sync that did not finish) is kept as it was, and is not in the
 * list, so a bank that has one looks complete, and a bank that lost a file looks like a smaller bank. The engine reported both when
 * a bank was opened, and the app threw the report away. What is held here is that the screen is told, in words, and that the file is
 * still there after the bank is changed.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { Bank, createQuestion, plainToRich, unzipSync, zipSync } from "../src/engine.ts";
import { withApp, type Client } from "./support/app.ts";

type Json = Record<string, any>;

const essay = (stem: string) => createQuestion({ type: "essay", stem: plainToRich(stem), body: {} });

/** Writes a bank of three questions into the library, with the files mended or damaged by `tamper`. */
function writeBank(client: Client, name: string, tamper: (files: Map<string, Uint8Array>, questionFiles: string[]) => void): string[] {
  const bank = Bank.createEmpty(name);
  const ids = ["First question here", "Second question here", "Third question here"].map((stem) => bank.add(essay(stem)).id);
  const files = unzipSync(bank.toBytes());
  tamper(files, [...files.keys()].filter((f) => f.startsWith("questions/")).sort());
  writeFileSync(join(client.server.context.library.banks, `${name}.openassess`), zipSync([...files].map(([n, data]) => ({ name: n, data }))));
  return ids;
}

describe("a bank that was read with nothing wrong", () => {
  test("has no problems", async () => {
    await withApp(async (client) => {
      await client.post("/api/banks", { title: "Fine" });
      const reply = await client.get<Json>("/api/banks/Fine");
      assert.deepEqual(reply.json["problems"], { unreadable: [], count: null });
    });
  });
});

describe("a bank with a file that cannot be read", () => {
  test("says how many, which, and why, and that they are kept", async () => {
    await withApp(async (client) => {
      writeBank(client, "Damaged", (files, qs) => {
        files.set(qs[0] as string, new Uint8Array(Buffer.from("{ half a file")));
      });
      const reply = await client.get<Json>("/api/banks/Damaged");
      assert.equal(reply.status, 200, reply.text);
      assert.equal(reply.json["questions"].length, 2, "it is not in the list");
      const problems = reply.json["problems"];
      assert.equal(problems.unreadable.length, 1);
      assert.match(problems.unreadable[0].message, /not valid JSON/);
      assert.match(problems.unreadable[0].id, /^[0-9A-Za-z_-]+$/);
      assert.match(problems.count, /says it held 3 questions when it was last saved, and 2 could be read/);
    });
  });

  test("keeps the file through a change to the bank, and no longer says the count is wrong", async () => {
    await withApp(async (client) => {
      writeBank(client, "Kept", (files, qs) => {
        files.set(qs[0] as string, new Uint8Array(Buffer.from("{ half a file")));
      });
      const blank = (await client.get<Json>("/api/blank?type=essay")).json["input"];
      const added = await client.post<Json>("/api/banks/Kept/questions", { input: { ...blank, stem: "A fourth question written afterwards" } });
      assert.equal(added.status, 200, added.text);
      const after = (await client.get<Json>("/api/banks/Kept")).json;
      assert.equal(after["questions"].length, 3);
      assert.equal(after["problems"].count, null, "the save wrote the count it holds");
      assert.equal(after["problems"].unreadable.length, 1, "and the file is still there, unread");
      // On disk, read afresh and not through the server: the damaged file is there, byte for byte.
      const { bank, report } = await Bank.open(join(client.server.context.library.banks, readdirSync(client.server.context.library.banks).find((f) => f.endsWith(".openassess")) as string));
      assert.equal(bank.questions.size, 3);
      assert.equal(report.invalid.length, 1);
      assert.equal(report.countMismatch, undefined);
    });
  });

  test("a bank brought in with an unreadable question says how many were set aside", async () => {
    await withApp(async (client) => {
      const bank = Bank.createEmpty("Brought");
      for (const stem of ["One question to bring", "Two questions to bring"]) bank.add(essay(stem));
      const files = unzipSync(bank.toBytes());
      files.set([...files.keys()].filter((f) => f.startsWith("questions/"))[0] as string, new Uint8Array(Buffer.from("not json")));
      const reply = await client.send<Json>("POST", "/api/banks/open?name=Brought.openassess", new Uint8Array(zipSync([...files].map(([name, data]) => ({ name, data })))));
      assert.equal(reply.status, 200, reply.text);
      assert.equal(reply.json["skipped"], 1);
      const opened = await client.get<Json>(`/api/banks/${encodeURIComponent(reply.json["name"])}`);
      assert.equal(opened.json["problems"].unreadable.length, 1, "and the screen says so when it is opened");
    });
  });
});

describe("a bank whose folder file is damaged", () => {
  test("opens, lists its questions, and says which file was set aside and where it is kept", async () => {
    await withApp(async (client) => {
      writeBank(client, "Folders", (files) => void files.set("folders.json", new Uint8Array(Buffer.from("{ not json"))));
      const reply = await client.get<Json>("/api/banks/Folders");
      assert.equal(reply.status, 200, reply.text);
      assert.equal(reply.json["questions"].length, 3, "the bank opens with all its questions");
      const unreadable = reply.json["problems"].unreadable;
      assert.equal(unreadable.length, 1);
      assert.equal(unreadable[0].id, "folders.json");
      assert.match(unreadable[0].message, /kept as folders\.damaged\.json/);
      assert.equal(reply.json["problems"].count, null, "and the count is right");
    });
  });
});

describe("a bank that lost a question file", () => {
  test("says how many it said and how many it found", async () => {
    await withApp(async (client) => {
      writeBank(client, "Lost", (files, qs) => void files.delete(qs[1] as string));
      const problems = (await client.get<Json>("/api/banks/Lost")).json["problems"];
      assert.deepEqual(problems.unreadable, []);
      assert.match(problems.count, /held 3 questions.*2 could be read.*the missing question is in an earlier copy/);
    });
  });

  test("says nothing of a bank that has more than it said, except that nothing is lost", async () => {
    await withApp(async (client) => {
      const extra = createQuestion({ type: "essay", stem: plainToRich("A question from another copy"), body: {} });
      writeBank(client, "More", (files) => void files.set(`questions/${extra.id}.json`, new Uint8Array(Buffer.from(JSON.stringify(extra)))));
      const problems = (await client.get<Json>("/api/banks/More")).json["problems"];
      assert.match(problems.count, /It has more than it says.*Nothing is lost\./);
    });
  });
});

describe("a bank whose question file is named for another question", () => {
  test("loads the question, and does not count it with the files that could not be read", async () => {
    await withApp(async (client) => {
      writeBank(client, "Renamed", (files, qs) => {
        const first = qs[0] as string;
        files.set("questions/not-its-own-name.json", files.get(first) as Uint8Array);
        files.delete(first);
      });
      const reply = await client.get<Json>("/api/banks/Renamed");
      assert.equal(reply.status, 200, reply.text);
      assert.equal(reply.json["questions"].length, 3, "the question was read, so it is in the list");
      assert.deepEqual(reply.json["problems"], { unreadable: [], count: null }, "and the screen does not say a file could not be read");
    });
  });
});
