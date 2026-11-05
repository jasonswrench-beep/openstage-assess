/**
 * `Check OpenAssess.cmd` is the check a person runs by double-click on a machine with nothing but Node, and it names every test file
 * itself, so a test file that is not named there is not run by it, whatever `npm test` says. That has gone wrong twice: two names
 * with no space between them were read as one argument, and the zip name tests were left out without a word.
 *
 * So the file is read here, and held to three things: no two quoted names touch, every file it names is there, and every test file
 * in the engine and the app is named.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const cmd = readFileSync(join(root, "Check OpenAssess.cmd"), "utf8");
const testLines = cmd.split(/\r?\n/).filter((line) => line.startsWith("%RUN% --test"));

/** The files a line names, as paths from the root of the repository. */
const named = (line: string): string[] =>
  [...line.matchAll(/"([^"]+)"/g)].map((m) => (m[1] as string).replaceAll("%ENGINE%", "packages/assess").replaceAll("\\", "/"));

describe("Check OpenAssess.cmd", () => {
  test("has a line for the engine's tests and one for the app's", () => {
    assert.equal(testLines.length, 2);
  });

  test("never lets two quoted names touch, which the shell reads as one", () => {
    for (const line of testLines) assert.equal(line.includes('""'), false, 'a "" in the line joins two names');
    // Nothing is on the line but the command and quoted names.
    for (const line of testLines) assert.equal(line.replace(/^%RUN% --test/, "").replace(/"[^"]+"/g, "").trim(), "");
  });

  test("names only files that are there, and each once", () => {
    for (const line of testLines) {
      const files = named(line);
      assert.ok(files.length > 3);
      for (const file of files) assert.ok(existsSync(join(root, file)), `${file} is named and is not there`);
      assert.equal(new Set(files).size, files.length, "a file is named twice");
    }
  });

  test("names every test file of the engine", () => {
    const [engine] = testLines.map(named);
    const have = readdirSync(join(root, "packages", "assess", "test")).filter((f) => f.endsWith(".test.ts")).map((f) => `packages/assess/test/${f}`);
    assert.deepEqual(have.filter((f) => !(engine ?? []).includes(f)), [], "these test files are not run by the double-click check");
  });

  test("names every test file of the app", () => {
    const app = testLines.map(named)[1];
    const have = readdirSync(join(root, "packages", "app", "test")).filter((f) => f.endsWith(".test.ts")).map((f) => `packages/app/test/${f}`);
    assert.deepEqual(have.filter((f) => !(app ?? []).includes(f)), [], "these test files are not run by the double-click check");
  });
});
