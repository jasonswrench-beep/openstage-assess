/**
 * A list as long as a file is never spread into a call.
 *
 * `target.push(...items)`, `Math.max(...items)`, `String.fromCharCode(...bytes)`, `Math.max.apply(null, items)` and `splice(at, 0, ...items)`
 * pass every item as an argument, and a call takes about 125,000 of them before it throws "Maximum call stack size exceeded" (fewer when
 * the call is already deep, as it is in the server). A question with 130,000 line breaks, options, conditions or key words is a file of 130
 * to 650 KB, and each of these was a crash with that message in place of a question. The manifest reader had it and was fixed; an
 * independent reader then found it in sixteen more places, in a dozen more that nothing had asked yet, and in eight in `quality/bank.ts`
 * that the first sweep did not reach.
 *
 * So this test reads every source file of the engine (TypeScript and JavaScript, in any module form), finds every spread inside the
 * arguments of a call (`f(...x)`, `new F(...x)`) and every `apply` that passes a list (`f.apply(this, x)`, `Reflect.apply(f, this, x)`),
 * and fails on any that is not in the list below with a reason. A reason says why the list is short: at most four corner marks, at most
 * twenty-six versions, a sentence or two of notes. A spread of anything that comes from a file, a bank or a question is a loop (`pushAll`,
 * `largest` and `smallest` are in `model/lists.ts`). Array and object spreads (`[...a, ...b]`, `{ ...o }`) take no stack and are not
 * looked at.
 *
 * An entry in the list excuses a call by what is called and what is passed (`notes.push` and `lossNotes(losses, "Brightspace")`), and
 * by how many times, and not by a piece of the line: a second spread on an excused line is not excused, and an entry that no longer
 * matches anything, `pending` or not, fails until it is taken out. Nothing is read but text, so a new source file is covered without
 * anyone remembering to add it here, and the planted forms at the end show that each way round is seen.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { callSpreads, findCallSpreads, spreadsOf, type FoundSpread } from "./support/call-spreads.ts";

const SRC = fileURLToPath(new URL("../src/", import.meta.url));

// ---------------------------------------------------------------------------
// The reader reads
// ---------------------------------------------------------------------------

describe("the reader of source text that finds the spreads", () => {
  const calls = (source: string): number => callSpreads(source).length;

  test("a spread in the arguments of a call or a new is found", () => {
    assert.equal(calls("f(...a);"), 1);
    assert.equal(calls("Math.max(0, ...list);"), 1);
    assert.equal(calls("out.splice(0, out.length, ...next);"), 1);
    assert.equal(calls("new Set(...parts);"), 1);
    assert.equal(calls("x ? f(...a) : b;"), 1, "a ternary's colon after the bracket does not make it a parameter list");
    assert.equal(calls("a / b; f(...c);"), 1, "a division is not the start of a pattern");
    assert.equal(calls("f(g(...a), ...b);"), 2);
    assert.equal(calls("t?.push(...x);"), 1);
    assert.equal(calls("f?.(...x);"), 1);
    assert.equal(calls("new Set<string>(...parts);"), 1);
    assert.equal(calls("super(...args);"), 1);
    assert.equal(calls("const alias = Math.max; alias(...xs);"), 1);
    assert.equal(calls("out.push(\n  ...a,\n  ...b,\n);"), 2, "over several lines");
  });

  test("a list passed to apply is found, whatever it is applied to", () => {
    assert.equal(calls("Math.max.apply(null, xs);"), 1);
    assert.equal(calls("String.fromCharCode.apply(null, xs);"), 1);
    assert.equal(calls("Array.prototype.push.apply(target, items);"), 1);
    assert.equal(calls("Reflect.apply(Math.max, null, xs);"), 1);
    assert.equal(calls("Function.prototype.apply.call(Math.max, null, xs);"), 1);
    assert.equal(calls("Math.max.apply(\n  null,\n  xs,\n);"), 1, "over several lines, with a comma at the end");
    assert.equal(calls("Math.max.apply(null, f(a, b));"), 1, "the commas inside the list's own brackets do not count");
    assert.equal(calls("Math.max.apply(null)"), 0, "no list");
    assert.equal(calls("Math.max.apply(null, undefined)"), 0, "no list");
    assert.equal(calls("Reflect.apply(Math.max, null)"), 0, "no list");
    assert.equal(calls("applyRule(null, xs)"), 0, "a name that only starts with apply");
    assert.equal(calls('const s = "Math.max.apply(null, xs)";'), 0, "text");
    assert.equal(calls("// Math.max.apply(null, xs)\n"), 0, "a comment");
  });

  test("an array, an object, a rest parameter and text are not", () => {
    assert.equal(calls("const x = [...a, ...b];"), 0);
    assert.equal(calls("const y = { ...o, k: 1 };"), 0);
    assert.equal(calls("f([...a]);"), 0);
    assert.equal(calls("f({ ...o });"), 0);
    assert.equal(calls("function f(...args: string[]) {}"), 0);
    assert.equal(calls("const g = (...args) => args;"), 0);
    assert.equal(calls('const s = "f(...a)";'), 0);
    assert.equal(calls("const t = 'f(...a)';"), 0);
    assert.equal(calls("// f(...a)\nconst u = 1;"), 0);
    assert.equal(calls("/* f(...a) */ const v = 1;"), 0);
    assert.equal(calls("const w = /\\(\\.\\.\\.x\\)/;"), 0);
    assert.equal(calls("const z = `f(...a)`;"), 0);
  });

  test("code inside a template's ${ } is read, and the brackets of a file balance", () => {
    assert.equal(calls("const t = `${f(...a)} and ${[...b]}`;"), 1);
    assert.equal(spreadsOf("const t = `${`${f(...a)}`}`;").unclosed, 0);
    assert.equal(calls("const t = `${`${f(...a)}`}`;"), 1);
    assert.equal(spreadsOf("f(a, [b, { c: `${d}` }]);").unclosed, 0);
  });

  test("what is called and what is passed are told apart, so that a second spread on a line is its own", () => {
    const [one, two] = callSpreads('notes.push(...lossNotes(losses, "Brightspace"), ...items.map(String));');
    assert.deepEqual([one?.callee, one?.argument], ["notes.push", 'lossNotes(losses, "Brightspace")']);
    assert.deepEqual([two?.callee, two?.argument], ["notes.push", "items.map(String)"]);
    assert.deepEqual(callSpreads("Math.max(1, ...record.versions.map(() => n));").map((s) => [s.callee, s.argument]), [["Math.max", "record.versions.map(() => n)"]]);
    assert.deepEqual(callSpreads("a.b(c).push(...d);").map((s) => s.callee), [".push"]);
    assert.deepEqual(callSpreads("new Set<string>(...parts);").map((s) => s.callee), ["new Set"]);
    assert.deepEqual(callSpreads("Math.max.apply(null, [a, b].concat(c));").map((s) => [s.kind, s.callee, s.argument]), [["apply", "Math.max.apply", "[a, b].concat(c)"]]);
  });
});

// ---------------------------------------------------------------------------
// The engine
// ---------------------------------------------------------------------------

interface Allowed {
  /** The file, under `src`, with forward slashes. */
  file: string;
  /** What is called, as the reader writes it: `notes.push`, `Math.max`. */
  callee: string;
  /** What is passed, as the reader writes it (white space squashed). */
  argument: string;
  /** How many calls in the file pass it. A call more than this is not excused. */
  times?: number;
  reason: string;
  /** Not this implementer's file to change: the spread is a fault that is fixed where it lives, and the entry goes with the fix. */
  pending?: string;
}

const LOSS_NOTES = "lossNotes gives at most two sentences, one for pictures and one for equations";

const ALLOWED: Allowed[] = [
  { file: "bank/blueprint.ts", callee: "ids.push", argument: "pick.ids", reason: "the ids one rule took, at most MOST_PICKED (1,000)" },
  { file: "export/blackboard-upload.ts", callee: "notes.push", argument: 'lossNotes(losses, "Blackboard")', reason: LOSS_NOTES },
  { file: "export/common-cartridge.ts", callee: "notes.push", argument: 'lossNotes(losses, "the learning system")', reason: LOSS_NOTES },
  { file: "export/d2l-csv.ts", callee: "notes.push", argument: 'lossNotes(losses, "Brightspace")', reason: LOSS_NOTES },
  { file: "export/gift.ts", callee: "notes.push", argument: 'lossNotes(losses, "Moodle")', reason: LOSS_NOTES },
  { file: "export/moodle-xml.ts", callee: "notes.push", argument: 'lossNotes(losses, "Moodle")', reason: LOSS_NOTES },
  { file: "export/qti12.ts", callee: "notes.push", argument: 'lossNotes(losses, "the learning system")', reason: LOSS_NOTES },
  { file: "sheets/check-print.ts", callee: "Math.max", argument: "bubbles", reason: "the bubbles of one scanned sheet, which has a fixed number of places on it" },
  { file: "sheets/gate.ts", callee: "crop", argument: "cut", reason: "the four numbers of a rectangle" },
  { file: "sheets/gate.ts", callee: "described.push", argument: "applied", reason: "the damages put on one drawn sheet, at most a handful" },
  { file: "sheets/homography.ts", callee: "Math.max", argument: "destination.map((p) => Math.hypot(p.x, p.y))", reason: "the four corner marks of a sheet" },
  { file: "sheets/image.ts", callee: "String.fromCharCode", argument: "bytes.subarray(at + 4, at + 8)", reason: "four bytes, the name of a PNG part" },
  { file: "sheets/locate.ts", callee: "Math.min", argument: "sides", reason: "the four sides of a square of corner marks" },
  { file: "sheets/locate.ts", callee: "Math.max", argument: "sizes", times: 2, reason: "the four sizes of the corner marks" },
  { file: "sheets/locate.ts", callee: "Math.min", argument: "sizes", times: 2, reason: "the four sizes of the corner marks" },
  { file: "sheets/measure.ts", callee: "Math.max", argument: "shifts", reason: "one shift for each row of questions on one page of a sheet, and a page holds a fixed number" },
  { file: "sheets/paper.ts", callee: "notes.push", argument: "planned.plan.notes", reason: "the few sentences a sheet plan says about itself" },
  { file: "sheets/plan.ts", callee: "Math.max", argument: "here.map((u) => u.places)", reason: "one entry for each version of a test, at most MAX_VERSIONS (26)" },
  { file: "sheets/results-export.ts", callee: "Math.max", argument: "record.versions.map(() => record.questions.length)", reason: "one entry for each version of a test, at most 26" },
  { file: "sheets/results-export.ts", callee: "Math.max", argument: "item.options.map((o) => o.chosen)", reason: "the answers to one question on a sheet, at most eight places" },

  // Faults in files another part of the work owns. They are fixed where they are, and the entry is removed with the fix (the test below
  // fails on an entry that matches nothing, a pending one included, so a fix that leaves its entry behind is caught).
  { file: "import/docx/document.ts", callee: "Math.max", argument: "cells.map((row) => row.length)", reason: "the rows of a grid in a Word file, behind MAX_GRID_ROWS (100)", pending: "the Word reader" },
];

const same = (a: Allowed, f: FoundSpread): boolean => a.file === f.file && a.callee === f.callee && a.argument === f.argument;

/** The calls that are not excused: by their file, what they call, what they pass, and how many of them an entry allows. */
export function unlisted(found: readonly FoundSpread[], allowed: readonly Allowed[] = ALLOWED): FoundSpread[] {
  const used = new Map<Allowed, number>();
  const out: FoundSpread[] = [];
  for (const f of found) {
    const entry = allowed.find((a) => same(a, f) && (used.get(a) ?? 0) < (a.times ?? 1));
    if (entry === undefined) out.push(f);
    else used.set(entry, (used.get(entry) ?? 0) + 1);
  }
  return out;
}

/** The entries that do not excuse exactly the calls they say they do: out of date, whether they wait for another part of the work or not. */
export function stale(found: readonly FoundSpread[], allowed: readonly Allowed[] = ALLOWED): Allowed[] {
  return allowed.filter((a) => found.filter((f) => same(a, f)).length !== (a.times ?? 1));
}

const describeCall = (f: FoundSpread): string => `${f.file}:${f.line}: ${f.callee}(${f.kind === "spread" ? "..." : "apply "}${f.argument})`;
const ADVICE =
  "a spread (or an apply) into a call passes every item as an argument and throws at about 125,000 of them. Use a loop (pushAll, largest, smallest in model/lists.ts), or list it in test/spread-guard.test.ts with the reason that its list is short.";

describe("the engine", () => {
  const { files, found, unbalanced } = findCallSpreads(SRC);

  test("the files were read, and every one has its brackets balanced (so the reader did not lose its place)", () => {
    assert.ok(files.length > 100, `only ${files.length} files`);
    assert.deepEqual(unbalanced, [], "these end with a bracket open");
    assert.ok(found.length > 20, "the engine has call spreads that are listed below, and the reader found only " + found.length);
  });

  test("no spread into a call is anywhere but in the list, with its reason", () => {
    assert.deepEqual(unlisted(found).map(describeCall), [], ADVICE);
  });

  test("every entry of the list excuses exactly what it says, so that the list does not outlive what it excuses", () => {
    assert.deepEqual(stale(found).map((a) => `${a.file}: ${a.callee}(...${a.argument}) x ${a.times ?? 1}`), [], "these no longer match what they excuse; take them out of the list");
  });

  test("the list is short, and each entry gives a reason", () => {
    assert.ok(ALLOWED.length <= 40, `${ALLOWED.length} entries`);
    for (const a of ALLOWED) assert.ok(a.reason.length >= 20, `${a.file}: ${a.callee}(...${a.argument}) has no reason`);
  });

  test("the entries that wait for another part of the work are named", () => {
    const waiting = ALLOWED.filter((a) => a.pending !== undefined);
    if (waiting.length > 0) console.log(`spread-guard: ${waiting.length} entries wait for ${[...new Set(waiting.map((a) => a.pending))].join(", ")}`);
    for (const a of waiting) assert.ok(!(a.pending as string).includes("TODO"));
  });
});

// ---------------------------------------------------------------------------
// Each way round is seen: a form is planted in a copy of the source, and the guard has to fail on it
// ---------------------------------------------------------------------------

describe("a spread planted in a copy of the source is seen", () => {
  // The files that are copied: ones the list excuses a call in, ones it used to, a plain one and a pending one.
  const COPIED = ["export/d2l-csv.ts", "quality/bank.ts", "model/ids.ts", "import/docx/tables.ts", "import/docx/document.ts", "import/pdf/reader.ts"];

  /** A folder with a copy of each file in `COPIED`, changed by `plant`, and what the guard says is not excused in it. */
  function guard(plant: (copy: (file: string, change: (text: string) => string) => void, add: (file: string, text: string) => void) => void): string[] {
    const dir = mkdtempSync(join(tmpdir(), "openassess-guard-"));
    try {
      for (const file of COPIED) {
        mkdirSync(dirname(join(dir, file)), { recursive: true });
        cpSync(join(SRC, file), join(dir, file));
      }
      plant(
        (file, change) => {
          const path = join(dir, file);
          const before = readFileSync(path, "utf8");
          const after = change(before);
          assert.notEqual(after, before, `${file} was not changed: the text to plant over is not there`);
          writeFileSync(path, after);
        },
        (file, text) => {
          mkdirSync(dirname(join(dir, file)), { recursive: true });
          writeFileSync(join(dir, file), text);
        },
      );
      return unlisted(findCallSpreads(dir).found).map(describeCall);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  const append = (text: string) => (before: string) => `${before}\n${text}\n`;

  test("the copies, as they are, hold nothing that is not excused (so what fails below fails for what was planted)", () => {
    assert.deepEqual(guard(() => undefined), []);
  });

  for (const [name, text, callee] of [
    ["Math.max.apply", "export const planted = Math.max.apply(null, xs);", "Math.max.apply"],
    ["Reflect.apply", "export const planted = Reflect.apply(Math.max, null, xs);", "Reflect.apply"],
    ["String.fromCharCode.apply", "export const planted = String.fromCharCode.apply(null, xs);", "String.fromCharCode.apply"],
    ["Array.prototype.push.apply", "Array.prototype.push.apply(target, xs);", "Array.prototype.push.apply"],
    ["a spread into push", "t.push(...xs);", "t.push"],
    ["a spread into Math.max", "export const planted = Math.max(0, ...xs);", "Math.max"],
    ["a spread into a new", "export const planted = new Set(...xs);", "new Set"],
    ["a spread in a template", "export const planted = `${f(...xs)}`;", "f"],
  ] as const) {
    test(`${name} is seen in a plain source file`, () => {
      const failures = guard((copy) => copy("model/ids.ts", append(text)));
      assert.equal(failures.length, 1, failures.join("\n"));
      assert.match(failures[0] as string, new RegExp(`^model/ids\\.ts:\\d+: ${callee.replaceAll(".", "\\.")}\\(`));
    });
  }

  for (const [file, text] of [
    ["model/planted.mts", "export const planted = f(...xs);\n"],
    ["model/planted.cts", "export const planted = f(...xs);\n"],
    ["model/planted.js", "export const planted = f(...xs);\n"],
    ["model/planted.mjs", "export const planted = f(...xs);\n"],
    ["model/planted.cjs", "module.exports = f(...xs);\n"],
    ["model/planted-apply.js", "export const planted = Math.max.apply(null, xs);\n"],
  ] as const) {
    test(`a spread in ${file} is seen`, () => {
      const failures = guard((_copy, add) => add(file, text));
      assert.equal(failures.length, 1, failures.join("\n"));
      assert.ok((failures[0] as string).startsWith(`${file}:`), failures[0]);
    });
  }

  test("a second spread on a line that the list excuses is not excused with it", () => {
    const failures = guard((copy) => copy("export/d2l-csv.ts", (text) => text.replace('notes.push(...lossNotes(losses, "Brightspace"));', 'notes.push(...lossNotes(losses, "Brightspace"), ...items.map(String));')));
    assert.equal(failures.length, 1, failures.join("\n"));
    assert.match(failures[0] as string, /^export\/d2l-csv\.ts:\d+: notes\.push\(\.\.\.items\.map\(String\)\)$/);
  });

  test("the excused call, passed another list, is not excused", () => {
    const failures = guard((copy) => copy("export/d2l-csv.ts", (text) => text.replace('notes.push(...lossNotes(losses, "Brightspace"));', "notes.push(...everyQuestion);")));
    assert.deepEqual(failures.map((f) => f.replace(/^export\/d2l-csv\.ts:\d+: /, "")), ["notes.push(...everyQuestion)"]);
  });

  test("an excused call twice is not excused twice", () => {
    const failures = guard((copy) => copy("export/d2l-csv.ts", (text) => text.replace('notes.push(...lossNotes(losses, "Brightspace"));', 'notes.push(...lossNotes(losses, "Brightspace"));\n  notes.push(...lossNotes(losses, "Brightspace"));')));
    assert.equal(failures.length, 1, failures.join("\n"));
  });

  test("an old entry's text does not excuse another call (these were `push(` and `push(...` once)", () => {
    for (const file of ["import/docx/tables.ts", "quality/bank.ts"]) {
      const failures = guard((copy) => copy(file, append("t.push(...xs);")));
      assert.equal(failures.length, 1, `${file}: ${failures.join("\n")}`);
      assert.ok((failures[0] as string).startsWith(`${file}:`));
    }
  });

  test("the list is read for what is stale, and a pending entry is no exception", () => {
    const found = findCallSpreads(SRC).found;
    const dead: Allowed = { file: "bank/store.ts", callee: "siblings.splice", argument: "folder.children", reason: "an entry for a spread that was taken out of the file", pending: "the bank" };
    assert.deepEqual(stale(found, [...ALLOWED, dead]), [dead]);
    // And one that excuses more calls than there are, or fewer.
    const twice: Allowed = { file: "bank/blueprint.ts", callee: "ids.push", argument: "pick.ids", times: 2, reason: "an entry that says there are two where there is one" };
    assert.deepEqual(stale(found, [twice]), [twice]);
    assert.deepEqual(unlisted(found, [{ ...twice, times: 1 }]).length, found.length - 1);
  });
});
