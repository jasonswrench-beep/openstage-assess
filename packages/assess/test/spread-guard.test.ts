/**
 * A list as long as a file is never spread into a call.
 *
 * `target.push(...items)`, `Math.max(...items)`, `String.fromCharCode(...bytes)` and `splice(at, 0, ...items)` pass every item as an argument,
 * and a call takes about 125,000 of them before it throws "Maximum call stack size exceeded" (fewer when the call is already deep, as it is
 * in the server). A question with 130,000 line breaks, options, conditions or key words is a file of 130 to 650 KB, and each of these was a
 * crash with that message in place of a question. The manifest reader had it and was fixed; an independent reader then found it in sixteen
 * more places, and in a dozen more that nothing had asked yet.
 *
 * So this test reads every source file of the engine, finds every spread inside the arguments of a call (`f(...x)`, `new F(...x)`), and
 * fails on any that is not in the list below with a reason. A reason says why the list spread is short: at most four corner marks, at most
 * twenty-six versions, a sentence or two of notes. A spread of anything that comes from a file, a bank or a question is a loop (`pushAll`,
 * `largest` and `smallest` are in `model/lists.ts`). Array and object spreads (`[...a, ...b]`, `{ ...o }`) take no stack and are not looked at.
 *
 * Nothing is read but text, so a new source file is covered without anyone remembering to add it here.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = fileURLToPath(new URL("../src/", import.meta.url));

// ---------------------------------------------------------------------------
// A small reader of TypeScript, enough to tell where a spread stands
// ---------------------------------------------------------------------------

interface Open {
  ch: "(" | "[" | "{" | "${";
  at: number;
}

type Last = { kind: "start" | "word" | "number" | "text" | "punct"; text: string };

/** Words after which a slash begins a pattern and not a division. */
const BEFORE_PATTERN = new Set(["return", "typeof", "instanceof", "in", "of", "case", "delete", "void", "throw", "new", "else", "do", "yield", "await"]);

/**
 * Every spread (`...`) in a source text with the bracket that holds it. Comments, strings, template text and patterns are skipped, so that
 * `"f(...a)"` and `// f(...a)` are not spreads; the code inside `${ }` of a template is read.
 */
export function spreadsOf(source: string): { spreads: Array<{ at: number; top: Open | undefined }>; closeOf: Map<number, number>; unclosed: number } {
  const spreads: Array<{ at: number; top: Open | undefined }> = [];
  const closeOf = new Map<number, number>();
  const stack: Open[] = [];
  const n = source.length;
  let i = 0;
  let last: Last = { kind: "start", text: "" };

  /** Reads template text from `from`, up to the closing backtick or the `${` of an expression. Returns where to go on. */
  const template = (from: number): number => {
    let k = from;
    while (k < n) {
      const c = source.charAt(k);
      if (c === "\\") {
        k += 2;
        continue;
      }
      if (c === "`") {
        last = { kind: "text", text: "" };
        return k + 1;
      }
      if (c === "$" && source.charAt(k + 1) === "{") {
        stack.push({ ch: "${", at: k });
        last = { kind: "punct", text: "{" };
        return k + 2;
      }
      k++;
    }
    return n;
  };

  while (i < n) {
    const c = source.charAt(i);
    if (c === " " || c === "\t" || c === "\r" || c === "\n") {
      i++;
    } else if (c === "/" && source.charAt(i + 1) === "/") {
      const end = source.indexOf("\n", i);
      i = end === -1 ? n : end;
    } else if (c === "/" && source.charAt(i + 1) === "*") {
      const end = source.indexOf("*/", i + 2);
      i = end === -1 ? n : end + 2;
    } else if (c === '"' || c === "'") {
      let k = i + 1;
      while (k < n && source.charAt(k) !== c) k += source.charAt(k) === "\\" ? 2 : 1;
      i = k + 1;
      last = { kind: "text", text: "" };
    } else if (c === "`") {
      i = template(i + 1);
    } else if (c === "/") {
      const pattern = last.kind === "start" || (last.kind === "punct" && last.text !== ")" && last.text !== "]") || (last.kind === "word" && BEFORE_PATTERN.has(last.text));
      if (!pattern) {
        i++;
        last = { kind: "punct", text: "/" };
        continue;
      }
      let k = i + 1;
      let inClass = false;
      while (k < n) {
        const d = source.charAt(k);
        if (d === "\\") k += 2;
        else if (d === "\n") break;
        else {
          if (d === "[") inClass = true;
          else if (d === "]") inClass = false;
          else if (d === "/" && !inClass) break;
          k++;
        }
      }
      k++;
      while (/[a-z]/.test(source.charAt(k))) k++;
      i = k;
      last = { kind: "text", text: "" };
    } else if (c === "(" || c === "[" || c === "{") {
      stack.push({ ch: c, at: i });
      last = { kind: "punct", text: c };
      i++;
    } else if (c === ")" || c === "]") {
      const open = stack.pop();
      if (open !== undefined && c === ")") closeOf.set(open.at, i);
      last = { kind: "punct", text: c };
      i++;
    } else if (c === "}") {
      const open = stack[stack.length - 1];
      stack.pop();
      if (open?.ch === "${") {
        i = template(i + 1);
      } else {
        last = { kind: "punct", text: "}" };
        i++;
      }
    } else if (c === "." && source.startsWith("...", i)) {
      spreads.push({ at: i, top: stack[stack.length - 1] });
      last = { kind: "punct", text: "." };
      i += 3;
    } else if (/[A-Za-z_$]/.test(c)) {
      let k = i + 1;
      while (k < n && /[\w$]/.test(source.charAt(k))) k++;
      last = { kind: "word", text: source.slice(i, k) };
      i = k;
    } else if (/[0-9]/.test(c)) {
      let k = i + 1;
      while (k < n && /[\w.]/.test(source.charAt(k)) && !source.startsWith("...", k)) k++;
      last = { kind: "number", text: "" };
      i = k;
    } else {
      last = { kind: "punct", text: c };
      i++;
    }
  }
  return { spreads, closeOf, unclosed: stack.length };
}

/** The spreads that stand in the arguments of a call or a `new`: not in an array or an object, and not a rest parameter. */
export function callSpreads(source: string): Array<{ line: number; text: string }> {
  const { spreads, closeOf } = spreadsOf(source);
  const lines = source.split("\n");
  const found: Array<{ line: number; text: string }> = [];
  for (const { at, top } of spreads) {
    if (top?.ch !== "(") continue;
    // A rest parameter: `(...args) =>`, or `(a, ...rest: string[])`, which has a type, and a call never has one.
    const close = closeOf.get(top.at);
    const after = close === undefined ? "" : source.slice(close + 1).trimStart();
    if (after.startsWith("=>") || /^\.\.\.[A-Za-z_$][\w$]*\s*:/.test(source.slice(at, at + 80))) continue;
    const line = source.slice(0, at).split("\n").length;
    found.push({ line, text: (lines[line - 1] as string).trim() });
  }
  return found;
}

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
});

// ---------------------------------------------------------------------------
// The engine
// ---------------------------------------------------------------------------

interface Allowed {
  /** The file, under `src`, with forward slashes. */
  file: string;
  /** Part of the line the spread is on. */
  text: string;
  reason: string;
  /** Not this implementer's file to change: the spread is a fault that is fixed where it lives, and the entry goes with the fix. */
  pending?: string;
}

const LOSS_NOTES = "lossNotes gives at most two sentences, one for pictures and one for equations";

const ALLOWED: Allowed[] = [
  { file: "bank/blueprint.ts", text: "ids.push(...pick.ids)", reason: "the ids one rule took, at most MOST_PICKED (1,000)" },
  { file: "export/blackboard-upload.ts", text: "notes.push(...lossNotes(", reason: LOSS_NOTES },
  { file: "export/common-cartridge.ts", text: "notes.push(...lossNotes(", reason: LOSS_NOTES },
  { file: "export/d2l-csv.ts", text: "notes.push(...lossNotes(", reason: LOSS_NOTES },
  { file: "export/gift.ts", text: "notes.push(...lossNotes(", reason: LOSS_NOTES },
  { file: "export/moodle-xml.ts", text: "notes.push(...lossNotes(", reason: LOSS_NOTES },
  { file: "export/qti12.ts", text: "notes.push(...lossNotes(", reason: LOSS_NOTES },
  { file: "sheets/check-print.ts", text: "Math.max(...bubbles)", reason: "the bubbles of one scanned sheet, which has a fixed number of places on it" },
  { file: "sheets/gate.ts", text: "crop(image, ...cut)", reason: "the four numbers of a rectangle" },
  { file: "sheets/gate.ts", text: "described.push(...applied)", reason: "the damages put on one drawn sheet, at most a handful" },
  { file: "sheets/homography.ts", text: "Math.max(...destination.map(", reason: "the four corner marks of a sheet" },
  { file: "sheets/image.ts", text: "String.fromCharCode(...bytes.subarray(at + 4, at + 8))", reason: "four bytes, the name of a PNG part" },
  { file: "sheets/locate.ts", text: "Math.min(...sides) < 20", reason: "the four sides of a square of corner marks" },
  { file: "sheets/locate.ts", text: "Math.max(...sizes) / Math.min(...sizes) > 1.8", reason: "the four sizes of the corner marks" },
  { file: "sheets/locate.ts", text: "area / (1 + (Math.max(...sizes)", reason: "the four sizes of the corner marks" },
  { file: "sheets/measure.ts", text: "Math.max(...shifts)", reason: "one shift for each row of questions on one page of a sheet, and a page holds a fixed number" },
  { file: "sheets/paper.ts", text: "notes.push(...planned.plan.notes)", reason: "the few sentences a sheet plan says about itself" },
  { file: "sheets/plan.ts", text: "Math.max(...here.map(", reason: "one entry for each version of a test, at most MAX_VERSIONS (26)" },
  { file: "sheets/results-export.ts", text: "Math.max(1, ...record.versions.map(", reason: "one entry for each version of a test, at most 26" },
  { file: "sheets/results-export.ts", text: "Math.max(1, ...item.options.map(", reason: "the answers to one question on a sheet, at most eight places" },

  // Faults in files another part of the work owns. They are fixed where they are, and the entry is removed with the fix.
  { file: "bank/store.ts", text: "siblings.splice(at, 1, ...folder.children)", reason: "the folders inside a removed folder, as many as a bank file has", pending: "the bank (removeFolder)" },
  { file: "import/docx/document.ts", text: "Math.max(...cells.map(", reason: "the rows of a grid in a Word file", pending: "the Word reader" },
  { file: "import/docx/omml.ts", text: "out.push(...this.run(", reason: "the parts of an equation, which are counted", pending: "the Word reader" },
  { file: "import/docx/tables.ts", text: "push(", reason: "the lines of a table cell, as many as a cell has paragraphs", pending: "the Word reader" },
  { file: "import/pdf/document.ts", text: "out.push(...bytes.slice(", reason: "the bytes of a string in a PDF", pending: "the PDF reader" },
  { file: "import/pdf/reader.ts", text: "notes.push(...removeFurniture(pages))", reason: "one note for each line of furniture taken off", pending: "the PDF reader" },
  { file: "quality/bank.ts", text: "push(...", reason: "the options, blanks and pairs of one question, as many as a bank file gives it", pending: "the bank (findDuplicates)" },
];

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
    else if (name.endsWith(".ts")) out.push(path);
  }
  return out;
}

describe("the engine", () => {
  const files = sourceFiles(SRC);
  const found: Array<{ file: string; line: number; text: string }> = [];
  for (const path of files) {
    const source = readFileSync(path, "utf8");
    const file = relative(SRC, path).replaceAll("\\", "/");
    for (const spread of callSpreads(source)) found.push({ file, line: spread.line, text: spread.text });
  }

  test("the files were read, and every one has its brackets balanced (so the reader did not lose its place)", () => {
    assert.ok(files.length > 100, `only ${files.length} files`);
    for (const path of files) assert.equal(spreadsOf(readFileSync(path, "utf8")).unclosed, 0, `${relative(SRC, path)} ends with a bracket open`);
    assert.ok(found.length > 20, "the engine has call spreads that are listed below, and the reader found only " + found.length);
  });

  test("no spread into a call is anywhere but in the list, with its reason", () => {
    const unlisted = found.filter((f) => !ALLOWED.some((a) => a.file === f.file && f.text.includes(a.text)));
    assert.deepEqual(
      unlisted.map((f) => `${f.file}:${f.line}: ${f.text}`),
      [],
      "a spread into a call passes every item as an argument and throws at about 125,000 of them. Use a loop (pushAll, largest, smallest in model/lists.ts), or list it in test/spread-guard.test.ts with the reason that its list is short.",
    );
  });

  test("every entry of the list is still there, so that the list does not outlive what it excuses", () => {
    const stale = ALLOWED.filter((a) => a.pending === undefined && !found.some((f) => f.file === a.file && f.text.includes(a.text)));
    assert.deepEqual(stale.map((a) => `${a.file}: ${a.text}`), [], "these no longer exist; take them out of the list");
  });

  test("the list is short, and each entry gives a reason", () => {
    assert.ok(ALLOWED.length <= 40, `${ALLOWED.length} entries`);
    for (const a of ALLOWED) assert.ok(a.reason.length >= 20, `${a.file}: ${a.text} has no reason`);
  });

  test("the entries that wait for another part of the work are named", () => {
    const waiting = ALLOWED.filter((a) => a.pending !== undefined);
    if (waiting.length > 0) console.log(`spread-guard: ${waiting.length} entries wait for ${[...new Set(waiting.map((a) => a.pending))].join(", ")}`);
    for (const a of waiting) assert.ok(!(a.pending as string).includes("TODO"));
  });
});
