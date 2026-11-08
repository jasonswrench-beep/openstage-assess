/**
 * The names the program makes and the names it is given, as the app meets them: a title with a lone half of an emoji, a bank copied
 * into the Banks folder by hand under a name the app would not have made, a title that begins with the name of a Windows device, the
 * header that names a download, and a library folder that is not there. Each was found by an independent reader who built the file
 * that did it.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import { cleanName } from "../src/library.ts";
import { withApp, type Client } from "./support/app.ts";

type Json = Record<string, any>;

const blank = async (client: Client, type: string): Promise<Record<string, unknown>> => (await client.get(`/api/blank?type=${type}`)).json["input"] as Record<string, unknown>;

async function withQuestion(client: Client, title: string): Promise<string> {
  const made = await client.post<Json>("/api/banks", { title });
  assert.equal(made.status, 200, made.text);
  const name = made.json["name"] as string;
  const body = { shuffle: true, options: [0, 1, 2].map((k) => ({ text: `Option ${k + 1}`, correct: k === 1, feedback: "" })) };
  const added = await client.post<Json>(`/api/banks/${encodeURIComponent(name)}/questions`, { input: { ...(await blank(client, "multipleChoice")), stem: "Which one?", body } });
  assert.equal(added.status, 200, added.text);
  return name;
}

describe("a title with a lone half of an emoji", () => {
  test("makes a bank under a name that can be put in an address, and the name it is told is the name on disk", async () => {
    await withApp(async (client, home) => {
      const made = await client.post<Json>("/api/banks", { title: "A\ud83dB" });
      assert.equal(made.status, 200, made.text);
      const name = made.json["name"] as string;
      assert.doesNotThrow(() => encodeURIComponent(name), "the screen puts the name in an address");
      assert.deepEqual(readdirSync(join(home, "Banks")), [`${name}.openassess`], "the file is under the name the person was told");
      const listed = ((await client.get<Json>("/api/state")).json["banks"] as Array<{ name: string }>).map((b) => b.name);
      assert.deepEqual(listed, [name]);
      assert.equal((await client.get(`/api/banks/${encodeURIComponent(name)}`)).status, 200, "and it opens");
    });
  });

  test("is made well formed by the name that is made, and refused by the check of a name that came from outside", async () => {
    const { checkName } = await import("../src/library.ts");
    assert.equal(cleanName("A\ud83dB"), "A�B");
    assert.equal(cleanName("\udc00 low half"), "� low half");
    assert.equal(cleanName("A😀B"), "A\u{1f600}B", "a whole emoji is left alone");
    assert.throws(() => checkName("A\ud83dB"), /cannot be used as a file name/);
    assert.throws(() => checkName("\udc00"), /cannot be used as a file name/);
    assert.equal(checkName("A\u{1f600}B"), "A\u{1f600}B");
  });
});

describe("a bank put into the Banks folder by hand", () => {
  test("whose name the app would not have made is listed with a message, and does not stop the list", async () => {
    await withApp(async (client, home) => {
      await client.post("/api/banks", { title: "Good one" });
      const source = join(home, "Banks", "Good one.openassess");
      for (const bad of ["x".repeat(100), "con", "Report ", ".hidden", "a.", "COM0", "LPT²"]) {
        const place = join(home, "Banks", `${bad}.openassess`);
        try {
          copyFileSync(source, place);
        } catch {
          continue; // this computer will not hold a file under that name, which is the answer to it
        }
        try {
          const reply = await client.get<Json>("/api/state");
          assert.equal(reply.status, 200, `${JSON.stringify(bad)}: ${reply.text}`);
          const banks = reply.json["banks"] as Array<{ name: string; error?: string }>;
          assert.ok(banks.some((b) => b.name === "Good one" && b.error === undefined), `${JSON.stringify(bad)}: the good bank is still listed`);
          const entry = banks.find((b) => b.name !== "Good one");
          assert.ok(entry, `${JSON.stringify(bad)} is listed`);
          assert.match(String(entry.error), /its name cannot be used.*Rename the file in the Banks folder/, `${JSON.stringify(bad)}: ${entry.error}`);
          assert.equal((entry as { unusableName?: boolean }).unusableName, true, "and the screen is told, so it offers nothing that would need the name");
          assert.equal(banks.length, 2);
        } finally {
          rmSync(place, { force: true });
        }
      }
    });
  });

  test("is told, when it is asked for, that its name cannot be used, and not that it is missing", async () => {
    await withApp(async (client, home) => {
      await client.post("/api/banks", { title: "Good one" });
      const long = "y".repeat(100);
      copyFileSync(join(home, "Banks", "Good one.openassess"), join(home, "Banks", `${long}.openassess`));
      for (const reply of [await client.get(`/api/banks/${long}`), await client.del(`/api/banks/${long}`)]) {
        assert.equal(reply.status, 400);
        assert.match(String(reply.json["error"]), /cannot be used as a file name/);
      }
      assert.equal(readdirSync(join(home, "Banks")).length, 2, "nothing was moved");
    });
  });
});

describe("a title that begins with the name of a Windows device", () => {
  test("keeps its words in the name, as the engine does", async () => {
    const { safeName } = await import("../../assess/src/export/text.ts");
    for (const title of ["Aux. Verbs", "Con. Ed. 101", "Prn. Service Manual", "COM1. notes", "Nul .x"]) {
      assert.equal(cleanName(title), safeName(title), `${JSON.stringify(title)}: the app and the engine name it alike`);
      assert.notEqual(cleanName(title), "Untitled", title);
    }
    assert.equal(cleanName("Aux. Verbs"), "Aux_. Verbs");
    assert.equal(cleanName("Con. Ed. 101"), "Con_. Ed. 101");
    // A title that is only the device's name has nothing else to keep, and is still Untitled.
    for (const title of ["CON", "nul.", "COM1", "Aux .", "  prn  ", "LPT²"]) assert.equal(cleanName(title), "Untitled", title);
  });

  test("makes banks that are not all called Untitled, and exports that are not all called Questions", async () => {
    await withApp(async (client, home) => {
      const first = await client.post<Json>("/api/banks", { title: "Aux. Verbs" });
      const second = await client.post<Json>("/api/banks", { title: "Con. Ed. 101" });
      assert.equal(first.json["name"], "Aux_. Verbs");
      assert.equal(second.json["name"], "Con_. Ed. 101");
      assert.deepEqual(readdirSync(join(home, "Banks")).sort(), ["Aux_. Verbs.openassess", "Con_. Ed. 101.openassess"]);
      const bank = await withQuestion(client, "Prn. Service Manual");
      const written = await client.post<Json>(`/api/banks/${encodeURIComponent(bank)}/export`, { destination: "gift" });
      assert.equal(written.status, 200, written.text);
      assert.equal((written.json["written"] as Array<{ name: string }>)[0]?.name, "Prn_. Service Manual.txt");
    });
  });
});

describe("the header that names a download", () => {
  test("holds only the characters RFC 8187 allows, and decodes to the name of the file", async () => {
    await withApp(async (client) => {
      const bank = await withQuestion(client, "Bob's quiz (v2) final! 100%; yes");
      const written = await client.post<Json>(`/api/banks/${encodeURIComponent(bank)}/export`, { destination: "gift" });
      assert.equal(written.status, 200, written.text);
      const name = (written.json["written"] as Array<{ name: string }>)[0]?.name as string;
      assert.match(name, /['()!%;]/, "the name has the characters that encodeURIComponent leaves alone");
      const reply = await client.get(`/files/${encodeURIComponent(name)}`);
      assert.equal(reply.status, 200);
      const header = reply.headers.get("content-disposition") ?? "";
      const named = /^attachment; filename\*=UTF-8''([A-Za-z0-9._~%-]+)$/.exec(header);
      assert.ok(named, `a header with a character that is not allowed: ${header}`);
      assert.equal(decodeURIComponent(named[1] as string), name);
    });
  });
});

describe("a library folder that is taken away while the app runs", () => {
  test("is made again by what needs it, and the list does not fail", async () => {
    await withApp(async (client, home) => {
      const bank = await withQuestion(client, "Quiz");
      rmSync(join(home, "Exports"), { recursive: true });
      const exported = await client.post<Json>(`/api/banks/${encodeURIComponent(bank)}/export`, { destination: "gift" });
      assert.equal(exported.status, 200, exported.text);
      assert.deepEqual(readdirSync(join(home, "Exports")), ["Quiz.txt"]);
      rmSync(join(home, "Banks"), { recursive: true });
      const listed = await client.get<Json>("/api/state");
      assert.equal(listed.status, 200, listed.text);
      assert.deepEqual(listed.json["banks"], []);
      const made = await client.post<Json>("/api/banks", { title: "New" });
      assert.equal(made.status, 200, made.text);
      rmSync(join(home, "Banks"), { recursive: true });
      assert.equal((await client.post<Json>("/api/banks", { title: "Newer" })).status, 200, "a bank can be made in a folder that is gone");
      rmSync(join(home, "Scores"), { recursive: true });
      const scores = await client.get<Json>("/api/scores");
      assert.equal(scores.status, 200, scores.text);
      assert.deepEqual(scores.json["files"], []);
    });
  });
});
