/**
 * The path in the reply of everything that writes a file into the library. The Files screen's "Show in folder" sends that path to the
 * server, which shows it in Explorer, so it has to be the file that was written: when a name is taken the file is written under the
 * next number ("Quiz 2.csv"), and a reply that gave the name that was asked for pointed at the first file. A reader changed each of
 * these four to give the name asked for and no test failed, because no test compared a path with the files on disk.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

import { withApp, type Client } from "./support/app.ts";
import { sitting } from "./support/sitting.ts";

type Json = Record<string, any>;
interface Written {
  name: string;
  path: string;
}

const blank = async (client: Client, type: string): Promise<Record<string, unknown>> => (await client.get(`/api/blank?type=${type}`)).json["input"] as Record<string, unknown>;

async function bankWithQuestions(client: Client, title: string): Promise<string> {
  await client.post("/api/banks", { title });
  const base = `/api/banks/${encodeURIComponent(title)}`;
  const body = { shuffle: true, options: [{ text: "Three", correct: false, feedback: "" }, { text: "Four", correct: true, feedback: "" }] };
  const reply = await client.post(`${base}/questions`, { input: { ...(await blank(client, "multipleChoice")), stem: "What is two plus two?", body } });
  assert.equal(reply.status, 200, reply.text);
  return base;
}

/**
 * What a reply says it wrote, held to the disk: each path is in the folder, is the name beside it, is a file that is there, and is not one
 * that an earlier reply named. Returns the paths, for the next call to be held against.
 */
function heldToDisk(written: Written[], folder: string, earlier: string[]): string[] {
  assert.ok(written.length > 0, "the reply names the files it wrote");
  const onDisk = readdirSync(folder);
  for (const file of written) {
    assert.equal(file.path, join(folder, file.name), "the path is the name in the folder");
    assert.equal(basename(file.path), file.name);
    assert.ok(onDisk.includes(file.name), `${file.name} is in ${folder}`);
    assert.ok(existsSync(file.path), `${file.path} is a file that is there`);
    assert.ok(readFileSync(file.path).length > 0, `${file.path} is not empty`);
    assert.ok(!earlier.includes(file.path), `${file.path} was the path of an earlier file, so this file was written over it or the path is wrong`);
  }
  return written.map((f) => f.path);
}

describe("the path of a file that was written is the file that was written", () => {
  test("an export, asked for twice", async () => {
    await withApp(async (client, home) => {
      const base = await bankWithQuestions(client, "Quiz");
      const first = (await client.post<Json>(`${base}/export`, { destination: "gift" })).json["written"] as Written[];
      const second = (await client.post<Json>(`${base}/export`, { destination: "gift" })).json["written"] as Written[];
      const paths = heldToDisk(first, join(home, "Exports"), []);
      heldToDisk(second, join(home, "Exports"), paths);
      assert.deepEqual(first.map((f) => f.name), ["Quiz.txt"]);
      assert.deepEqual(second.map((f) => f.name), ["Quiz 2.txt"], "the second is under the next number, and its path says so");
    });
  });

  test("a printed test, asked for twice", async () => {
    await withApp(async (client, home) => {
      const base = await bankWithQuestions(client, "Test bank");
      const ask = async (): Promise<Written[]> => (await client.post<Json>(`${base}/print`, { kinds: ["student", "key"], formats: ["pdf"] })).json["written"] as Written[];
      const first = await ask();
      const paths = heldToDisk(first, join(home, "Exports"), []);
      const second = await ask();
      heldToDisk(second, join(home, "Exports"), paths);
      assert.deepEqual(second.map((f) => f.name).sort(), ["Test bank - Answer key 2.pdf", "Test bank - Student copy 2.pdf"]);
    });
  });

  test("the paper for a test (the answer sheet, booklets and keys), asked for twice", async () => {
    await withApp(async (client, home) => {
      const { bank, testId } = await sitting(client);
      const url = `/api/sheets/${encodeURIComponent(bank)}/tests/${testId}/print`;
      const ask = async (): Promise<Written[]> => (await client.post<Json>(url, { sheet: "shared", booklets: false, keys: false, formats: ["pdf"] })).json["written"] as Written[];
      const first = await ask();
      const paths = heldToDisk(first, join(home, "Exports"), []);
      const second = await ask();
      heldToDisk(second, join(home, "Exports"), paths);
      assert.deepEqual(second.map((f) => f.name), ["Midterm - Answer sheet 2.pdf"]);
    });
  });

  test("the results of a class, asked for twice, and a scores file that is saved", async () => {
    await withApp(async (client, home) => {
      const { sid } = await sitting(client);
      const ask = async (): Promise<Written[]> => {
        const reply = await client.post<Json>(`/api/scoring/${sid}/export`, {});
        assert.equal(reply.status, 200, reply.text);
        return reply.json["written"] as Written[];
      };
      const first = await ask();
      const paths = heldToDisk(first, join(home, "Exports"), []);
      assert.equal(first.length, 3, "a workbook, a CSV and an item analysis");
      const second = await ask();
      heldToDisk(second, join(home, "Exports"), paths);
      assert.ok(second.every((f) => / 2\.[a-z]+$/.test(f.name)), second.map((f) => f.name).join(", "));

      const saved = await client.post<Json>(`/api/scoring/${sid}/save`);
      assert.equal(saved.status, 200, saved.text);
      heldToDisk([{ name: saved.json["name"], path: saved.json["path"] }], join(home, "Scores"), []);
    });
  });
});
