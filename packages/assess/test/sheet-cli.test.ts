/**
 * The sheets commands of the command line, run as a person would run them: a bank with a test in it, a picture of a sheet as a PNG file,
 * and what the command prints.
 */

import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { Bank } from "../src/bank/store.ts";
import { writePng } from "../src/sheets/image.ts";
import { drawn, mixed, solid } from "./support/sheet-fixtures.ts";

const cli = fileURLToPath(new URL("../src/cli/index.ts", import.meta.url));
const run = (...args: string[]) => {
  const r = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", cli, "sheets", ...args], { encoding: "utf8" });
  return { code: r.status, out: r.stdout, err: r.stderr };
};

describe("openassess sheets", () => {
  let dir = "";
  const record = mixed(24, { versions: 1 });
  const d = drawn(record, { dpi: 200 });
  before(() => {
    dir = mkdtempSync(join(tmpdir(), "openassess-sheets-"));
    const bank = Bank.createEmpty("Planets", { at: "2026-01-01T00:00:00.000Z" });
    bank.addTest(record);
    return bank.save(join(dir, "planets.openassess"));
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  test("reads a page of a scanned sheet against the test in the bank, with its answers and what needs a person", () => {
    const picture = join(dir, "page.png");
    writeFileSync(picture, writePng(d.render({ ...solid([1, 0, 2, 3, 0, -1, 1]), answers: { ...solid([1, 0, 2, 3, 0, -1, 1]).answers, 10: [{ place: 0, mark: { kind: "light", darkness: 0.4 } }] } }), { dpi: 200 }));
    const r = run("read", join(dir, "planets.openassess"), picture);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /^Test [0-9A-F]{5}, sheet 1 of 1\. Version: A\./);
    assert.match(r.out, /Read at about 200 dots to the inch\. 5 answered, 17 blank, 1 flagged, 1 not on the sheet\./);
    assert.doesNotMatch(r.out, /^ {2} {2}4\./m, "the essay has no answer on the sheet");
    assert.match(r.out, /^ {2} {2}1\. B$/m);
    assert.match(r.out, /^ {2} {2}2\. A$/m);
    assert.match(r.out, /Question 10 \(faint\): Bubble A is marked lightly or in part/);
  });

  test("prints the whole reading as JSON when asked", () => {
    const picture = join(dir, "page.png");
    const r = run("read", join(dir, "planets.openassess"), picture, "--json");
    assert.equal(r.code, 0, r.err);
    const reading = JSON.parse(r.out);
    assert.equal(reading.ok, true);
    assert.equal(reading.version, 1);
    assert.ok(Array.isArray(reading.questions) && reading.fills["1"].length > 0);
  });

  test("checks the printing of a blank copy, and says so when it is fine", () => {
    const blank = join(dir, "blank.png");
    writeFileSync(blank, writePng(d.render(), { dpi: 200 }));
    const r = run("check", join(dir, "planets.openassess"), blank);
    assert.equal(r.code, 0, r.err + r.out);
    assert.match(r.out, /Found the four corner marks and the code strip/);
    assert.match(r.out, /The printing is fine/);
  });

  test("says what is wrong with a copy that was printed at another size, and with one that has marks on it", () => {
    const small = join(dir, "small.png");
    writeFileSync(small, writePng(d.render(), { dpi: 210 }));
    const a = run("check", join(dir, "planets.openassess"), small);
    assert.equal(a.code, 1);
    assert.match(a.out, /Problem: The sheet was printed at about 95 percent of its size/);
    const dirty = join(dir, "dirty.png");
    writeFileSync(dirty, writePng(d.render(solid([1, 0, 2])), { dpi: 200 }));
    const b = run("check", join(dir, "planets.openassess"), dirty);
    assert.equal(b.code, 1);
    assert.match(b.out, /3 questions \(1, 2, 3\) read as marked on a copy that should be blank/);
  });

  test("says when a page cannot be read, with the reason, and exits with 1", () => {
    const flat = join(dir, "flat.png");
    writeFileSync(flat, writePng({ width: 800, height: 1000, data: new Uint8Array(800 * 1000).fill(255) }));
    const r = run("read", join(dir, "planets.openassess"), flat);
    assert.equal(r.code, 1);
    assert.match(r.out, /This page was not read \(corners\): Four corner marks could not be found/);
  });

  test("says what to do with a JPEG or a PDF, which the app opens, and with something that is not a picture", () => {
    const jpeg = join(dir, "x.jpg");
    writeFileSync(jpeg, new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0]));
    assert.match(run("read", join(dir, "planets.openassess"), jpeg).err, /This is a JPEG\. The app opens JPEG pictures/);
    const pdf = join(dir, "x.pdf");
    writeFileSync(pdf, "%PDF-1.4\n");
    assert.match(run("check", join(dir, "planets.openassess"), pdf).err, /This is a PDF/);
    const junk = join(dir, "x.png");
    writeFileSync(junk, "not a picture at all, just some words");
    assert.match(run("read", join(dir, "planets.openassess"), junk).err, /This is not a PNG file/);
  });

  test("asks for the test when a bank has several, and says when it has none", () => {
    const several = join(dir, "several.openassess");
    const bank = Bank.createEmpty("Two", { at: "2026-01-01T00:00:00.000Z" });
    bank.addTest(mixed(10, { name: "First quiz", seed: "a" }));
    bank.addTest(mixed(10, { name: "Second quiz", seed: "b" }));
    return bank.save(several).then(() => {
      const picture = join(dir, "page.png");
      const r = run("read", several, picture);
      assert.equal(r.code, 2);
      assert.match(r.err, /This bank has 2 tests\. Name one with --test: First quiz \(.+\), Second quiz \(.+\)\./);
      assert.match(run("read", several, picture, "--test", "Nothing").err, /This bank has no test "Nothing"\. Its tests are: First quiz/);
      const empty = join(dir, "empty.openassess");
      return Bank.createEmpty("Empty", { at: "2026-01-01T00:00:00.000Z" }).save(empty).then(() => {
        assert.match(run("read", empty, picture).err, /This bank has no assembled test/);
      });
    });
  });

  test("runs the gate, and refuses what it does not understand", () => {
    const r = run("gate", "--sheets", "2", "--only", "synthetic", "--seed", "cli-test");
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /PASSED \(seed cli-test\)/);
    assert.match(run("gate", "--only", "nowhere").err, /Unknown corpus "nowhere"/);
    assert.match(run("gate", "--sheets", "0").err, /whole number of sheets/);
    assert.match(run("wiggle").err, /Unknown sheets command "wiggle"/);
    assert.match(run().err, /Say which sheets command/);
    assert.match(run("read").err, /Name a bank file and a picture/);
  });
});
