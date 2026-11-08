/**
 * A small reader of source text that finds every place a whole list is passed to a call as its arguments.
 *
 * `f(...items)`, `new F(...items)`, `Math.max.apply(null, items)`, `Reflect.apply(Math.max, null, items)` and `String.fromCharCode.apply(
 * null, bytes)` all give a call one argument for every item, and a call takes about 125,000 of them before it throws "Maximum call stack
 * size exceeded" (fewer when the call is already deep, as it is in the server). `test/spread-guard.test.ts` holds the engine to it.
 *
 * It is not the syntax tree. The TypeScript compiler is a development dependency here and is not on the machine that runs this program's
 * checks (the engine has no runtime dependencies and `Check OpenAssess.cmd` runs with only Node installed), so a test may not import it.
 * The reader keeps track of the brackets, skips comments, strings, template text and patterns, and reads the code inside `${ }`. Where it
 * is unsure it says more, never less: an unannotated rest parameter (`function f(...args) {}` in a `.js` file) is reported as a spread,
 * and a method that happens to be called `apply` with two arguments is reported, because a false report costs a line in a list with a
 * reason, and a miss costs a crash with the words of a call stack.
 *
 * Array and object spreads (`[...a, ...b]`, `{ ...o }`) take no stack and are not looked at.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

interface Open {
  ch: "(" | "[" | "{" | "${";
  at: number;
  /** The positions of the commas that stand directly in this bracket. */
  commas: number[];
}

type Last = { kind: "start" | "word" | "number" | "text" | "punct"; text: string };

/** Words after which a slash begins a pattern and not a division. */
const BEFORE_PATTERN = new Set(["return", "typeof", "instanceof", "in", "of", "case", "delete", "void", "throw", "new", "else", "do", "yield", "await"]);

export interface Scanned {
  spreads: Array<{ at: number; top: Open | undefined }>;
  /** Where the bracket that opened at a position closes, for round brackets. */
  closeOf: Map<number, number>;
  /** The round brackets that follow `.apply` or `Reflect.apply`: where they open. */
  applies: Array<{ open: Open; callee: string }>;
  unclosed: number;
}

/** What stands in front of the round bracket at `at` as the name of what it calls: `a.b`, `.push` (after a call), `new Set`, `f`. */
export function calleeBefore(source: string, at: number): string {
  let k = at - 1;
  while (k >= 0 && /\s/.test(source.charAt(k))) k--;
  // A list of type arguments (`new Set<string>(`) is skipped, so that the name in front of it is the callee.
  if (source.charAt(k) === ">") {
    let depth = 0;
    let j = k;
    for (; j >= 0; j--) {
      const c = source.charAt(j);
      if (c === ">") depth++;
      else if (c === "<" && --depth === 0) break;
      else if (c === ";" || c === "(" || c === ")" || c === "{" || c === "}") return "";
    }
    k = j - 1;
  }
  const end = k + 1;
  while (k >= 0 && /[\w$.?]/.test(source.charAt(k))) k--;
  let name = source.slice(k + 1, end);
  // `?.` before a bracket: `f?.(...x)`
  if (name === "" && source.charAt(at - 1) === "." && source.charAt(at - 2) === "?") name = "?.";
  const before = source.slice(Math.max(0, k - 4), k + 1);
  if (/(^|[^\w$])new\s*$/.test(before + " ")) return `new ${name}`;
  return name;
}

/**
 * Every spread (`...`) in a source text with the bracket that holds it. Comments, strings, template text and patterns are skipped, so that
 * `"f(...a)"` and `// f(...a)` are not spreads; the code inside `${ }` of a template is read.
 */
export function spreadsOf(source: string): Scanned {
  const spreads: Scanned["spreads"] = [];
  const applies: Scanned["applies"] = [];
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
        stack.push({ ch: "${", at: k, commas: [] });
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
      const open: Open = { ch: c, at: i, commas: [] };
      if (c === "(") {
        const callee = calleeBefore(source, i);
        if (callee === "Reflect.apply" || callee.endsWith(".apply") || callee.endsWith(".apply.call")) applies.push({ open, callee });
      }
      stack.push(open);
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
    } else if (c === ",") {
      stack[stack.length - 1]?.commas.push(i);
      last = { kind: "punct", text: "," };
      i++;
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
  return { spreads, closeOf, applies, unclosed: stack.length };
}

export interface CallSpread {
  line: number;
  /** The line the call is on, trimmed. */
  text: string;
  /** "spread" for `f(...x)`, "apply" for `f.apply(this, x)` and `Reflect.apply(f, this, x)`. */
  kind: "spread" | "apply";
  /** What is called: `notes.push`, `Math.max`, `String.fromCharCode.apply`, `new Set`. */
  callee: string;
  /** The list that is passed: the text of the spread element (`lossNotes(losses, "Brightspace")`) or of the argument of an `apply`. */
  argument: string;
}

const squash = (text: string): string => text.replace(/\s+/g, " ").trim();

/** The calls in a source text that pass a list as their arguments, each with what is called and what is passed. */
export function callSpreads(source: string): CallSpread[] {
  const { spreads, closeOf, applies } = spreadsOf(source);
  const lines = source.split("\n");
  const lineOf = (at: number): number => source.slice(0, at).split("\n").length;
  const found: CallSpread[] = [];
  for (const { at, top } of spreads) {
    if (top?.ch !== "(") continue;
    // A rest parameter: `(...args) =>`, or `(a, ...rest: string[])`, which has a type, and a call never has one.
    const close = closeOf.get(top.at);
    const after = close === undefined ? "" : source.slice(close + 1).trimStart();
    if (after.startsWith("=>") || /^\.\.\.[A-Za-z_$][\w$]*\s*:/.test(source.slice(at, at + 80))) continue;
    const line = lineOf(at);
    // The element runs to the next comma that stands directly in the same bracket, or to the end of the bracket.
    const end = top.commas.find((c) => c > at) ?? close ?? source.length;
    found.push({ line, text: (lines[line - 1] as string).trim(), kind: "spread", callee: calleeBefore(source, top.at), argument: squash(source.slice(at + 3, end)) });
  }
  for (const { open, callee } of applies) {
    const close = closeOf.get(open.at);
    if (close === undefined) continue;
    // The commas that stand directly in the brackets cut the arguments; a comma that ends the list (a trailing one) does not start another.
    const cuts = open.commas.filter((c) => c < close);
    const parts: string[] = [];
    let from = open.at + 1;
    for (const c of [...cuts, close]) {
      parts.push(source.slice(from, c));
      from = c + 1;
    }
    const given = parts.map(squash).filter((p) => p !== "");
    // `f.apply(this, list)` and `Reflect.apply(f, this, list)` pass a list; `f.apply(this)` and `f.apply(this, undefined)` pass none.
    const wanted = callee === "Reflect.apply" || callee.endsWith(".apply.call") ? 3 : 2;
    if (given.length < wanted) continue;
    const list = given[wanted - 1] as string;
    if (list === "undefined" || list === "null") continue;
    const line = lineOf(open.at);
    found.push({ line, text: (lines[line - 1] as string).trim(), kind: "apply", callee, argument: list });
  }
  return found.sort((a, b) => a.line - b.line);
}

/** The extensions of the files that are looked at: TypeScript and JavaScript, in any of their module forms. */
export const SOURCE_EXTENSIONS = [".ts", ".mts", ".cts", ".js", ".mjs", ".cjs"];

/** Every source file under a folder, whatever its form. */
export function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      for (const inner of sourceFiles(path)) out.push(inner);
    } else if (SOURCE_EXTENSIONS.some((e) => name.endsWith(e))) {
      out.push(path);
    }
  }
  return out;
}

export interface FoundSpread extends CallSpread {
  /** The file, relative to the folder that was read, with forward slashes. */
  file: string;
}

/** Every call that passes a list as its arguments, under a folder. */
export function findCallSpreads(root: string): { files: string[]; found: FoundSpread[]; unbalanced: string[] } {
  const files = sourceFiles(root);
  const found: FoundSpread[] = [];
  const unbalanced: string[] = [];
  for (const path of files) {
    const source = readFileSync(path, "utf8");
    const file = relative(root, path).replaceAll("\\", "/");
    if (spreadsOf(source).unclosed !== 0) unbalanced.push(file);
    for (const spread of callSpreads(source)) found.push({ file, ...spread });
  }
  return { files: files.map((f) => relative(root, f).replaceAll("\\", "/")), found, unbalanced };
}
