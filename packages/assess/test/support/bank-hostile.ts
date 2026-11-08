/**
 * Banks, and the questions in them, built to cost as much as they can to look at, and a way to look at one in a process of its own
 * under a time limit and a memory limit. A fault that makes a folder, a question or a check cost the square or the cube of what a
 * bank holds fails a test here (a child that runs out of time or memory, or that reports a time over the margin) and does not hold
 * every test after it.
 */

import { spawnSync } from "node:child_process";

export interface Child {
  status: number | null;
  stdout: string;
  stderr: string;
  /** The child was killed for taking longer than its limit. */
  timedOut: boolean;
  /** The whole run, the start of the process and the loading of the engine included. */
  ms: number;
}

export interface Reported<T> extends Child {
  /** What the body printed with `report(...)`, or undefined when it printed nothing (it crashed or was killed). */
  value: T | undefined;
}

/** The address of a file under `src/`, as the body of a child reaches it. */
const srcUrl = (path: string): string => new URL(`../../src/${path}`, import.meta.url).href;

/**
 * Runs `body` (module code that can `await engine("bank/store.ts")` and call `report(value)` once) in a node process of its own. The
 * body is timed by the caller where the time matters, inside the child, so that the start of a process is not counted against it;
 * `heapMb` is the most memory the child may use before it is stopped, and is what makes a hostile bank that is not slow but large fail.
 */
export function inEngine<T = unknown>(body: string, options: { timeoutMs?: number; heapMb?: number } = {}): Reported<T> {
  const script = [
    `const engine = (p) => import(${JSON.stringify(srcUrl(""))} + p);`,
    `const report = (value) => console.log("REPORT " + JSON.stringify(value));`,
    `const peakMb = () => Math.round(process.resourceUsage().maxRSS / 1024);`,
    body,
  ].join("\n");
  const args = ["--experimental-strip-types", "--no-warnings", ...(options.heapMb ? [`--max-old-space-size=${options.heapMb}`] : []), "--input-type=module", "-e", script];
  const started = Date.now();
  const run = spawnSync(process.execPath, args, { encoding: "utf8", timeout: options.timeoutMs ?? 20_000, maxBuffer: 64 * 1024 * 1024 });
  const stdout = run.stdout ?? "";
  const line = stdout.split("\n").find((l) => l.startsWith("REPORT "));
  return { status: run.status, stdout, stderr: run.stderr ?? "", timedOut: run.error !== undefined, ms: Date.now() - started, value: line === undefined ? undefined : (JSON.parse(line.slice("REPORT ".length)) as T) };
}

/** What a child that did not finish says, for an assertion message. */
export function why(run: Child): string {
  return run.timedOut ? "it was stopped for taking too long" : `it exited with ${run.status}: ${run.stderr.split("\n").slice(0, 6).join(" | ")}`;
}

/** Module code for a child: makes a plain multiple choice question from a stem and the text of its options (the first is right). */
export const MAKE_CHOICE = `
const { createQuestion } = await engine("model/create.ts");
const choice = (stem, options) => createQuestion({ type: "multipleChoice", stem, body: { shuffle: true, options: options.map((t, i) => ({ id: "o" + i, content: { format: "rich", content: "<p>" + t + "</p>" }, correct: i === 0 })) } });
`;

/** Module code for a child: `perm(k)` is the k-th ordering of eight words (k below 40,320), so that stems share every word and differ only in its order. */
export const MAKE_PERMUTATIONS = `
const EIGHT = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta", "theta"];
const perm = (k) => { const pool = [...EIGHT]; const out = []; let f = 40320; for (let i = 8; i > 0; i--) { f /= i; const j = Math.floor(k / f) % i; k = k % f; out.push(pool.splice(j, 1)[0]); } return out; };
`;

/** A small seeded generator (the same sequence for the same seed), for building banks that are the same on every machine. */
export function seeded(seed: number): (n: number) => number {
  let state = seed >>> 0;
  return (n) => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return Math.floor((state / 0x100000000) * n);
  };
}
