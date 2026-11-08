/**
 * Inputs that cost a reader or a writer far more than they are long, and a way to run each in a process of its own under a time limit.
 *
 * Every one is a text, a bank or a small file that a person can make by repeating a few characters: `<` two hundred thousand times is a
 * bank of 1.3 KB that took ten seconds to open and forty-six to check, and a question with 130,000 line breaks is a file of 130 KB that
 * ended in "Maximum call stack size exceeded". They were found by independent readers, who ran each against the real code. A fault that
 * comes back fails a test here (by the time it took, or by a refusal in words that turned into a thrown RangeError) and does not hold up
 * the tests after it, because each runs in a child and a child is stopped when its time is up.
 *
 * The child is given the engine's `src` folder as `engine(path)` and the bytes it was handed as `bytes`, and ends by writing one line of
 * JSON. The time it reports is taken round the work alone, so that a slow start-up does not count.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface ChildRun {
  status: number | null;
  stdout: string;
  stderr: string;
  /** The child was stopped because its time was up. */
  timedOut: boolean;
  /** The whole run, start-up included. */
  wall: number;
}

/** What the child wrote on its last line, parsed. `undefined` when it wrote nothing that parses. */
export function reported<T = Record<string, unknown>>(run: ChildRun): T | undefined {
  const last = run.stdout.trim().split("\n").pop() ?? "";
  try {
    return JSON.parse(last) as T;
  } catch {
    return undefined;
  }
}

/**
 * Code that every child starts with: a way to time a piece of work, to say what it did, and to make the kinds of question the tests are
 * about. `done(extra)` writes the line the parent reads, with the time since `start()` and the child's peak memory in megabytes.
 */
export const PRELUDE = `
import { readFileSync } from "node:fs";
const engine = (p) => import(__SRC__ + p);
let __t0 = 0;
const start = () => { __t0 = performance.now(); };
const done = (extra = {}) => console.log(JSON.stringify({ ms: Math.round(performance.now() - __t0), rssMb: Math.round(process.resourceUsage().maxRSS / 1024), ...extra }));
const attempt = (fn) => { try { return { value: fn() }; } catch (e) { return { threw: (e && e.name) + ": " + String(e && e.message).slice(0, 120) }; } };
const choiceBody = (n = 2) => ({ shuffle: true, options: Array.from({ length: n }, (_, i) => ({ id: "o" + i, content: { format: "rich", content: "<p>" + (i === 0 ? "right" : "wrong " + i) + "</p>" }, correct: i === 0 })) });
const makeQuestion = async (stem = "What is it?", n = 2) => { const { createQuestion } = await engine("model/create.ts"); return createQuestion({ type: "multipleChoice", stem, body: choiceBody(n) }); };
// A bank whose one question holds this stem as stored, the way a bank somebody else made would hold it: nothing has sanitized it.
const bankWithStem = async (content, format = "rich") => {
  const { Bank } = await engine("bank/store.ts");
  const { unzipSync, zipSync } = await engine("container/zip.ts");
  const bank = Bank.createEmpty("t");
  const q = await makeQuestion();
  bank.add(q);
  const files = unzipSync(bank.toBytes());
  const name = [...files.keys()].find((k) => k.includes(q.id));
  const stored = JSON.parse(Buffer.from(files.get(name)).toString("utf8"));
  stored.stem = { format, content };
  files.set(name, new Uint8Array(Buffer.from(JSON.stringify(stored))));
  return zipSync([...files.entries()].map(([n, data]) => ({ name: n, data })));
};
`;

/**
 * Runs `body` (module code, with `await` allowed) in a child process, after the prelude, and stops it after `timeoutMs`. `input` is
 * written to a file and read as `bytes`. `heapMb` limits the child's memory so that a run that wastes it ends in an error and not in a
 * machine that swaps.
 */
export function inChild(body: string, input?: Uint8Array | string, timeoutMs = 20_000, heapMb = 1536): ChildRun {
  const dir = mkdtempSync(join(tmpdir(), "openassess-readers-"));
  try {
    const file = join(dir, "input.bin");
    writeFileSync(file, input ?? new Uint8Array(0));
    const src = new URL("../../src/", import.meta.url).href;
    const script = `${PRELUDE.replace("__SRC__", () => JSON.stringify(src))}\nconst bytes = new Uint8Array(readFileSync(process.argv[1]));\n${body}`;
    const started = Date.now();
    const run = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", `--max-old-space-size=${heapMb}`, "--input-type=module", "-e", script, file], { encoding: "utf8", timeout: timeoutMs, maxBuffer: 64 * 1048576 });
    return { status: run.status, stdout: run.stdout ?? "", stderr: run.stderr ?? "", timedOut: run.error !== undefined && (run.error as NodeJS.ErrnoException).code === "ETIMEDOUT", wall: Date.now() - started };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** A PNG of this size, every pixel zero, written the way a scanner writes one (no interlace, one IDAT). Made in a child, since it needs room. */
export function zeroPng(width: number, height: number, colorType: number, depth: number): Uint8Array {
  const channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[colorType] as number;
  const stride = Math.ceil((width * channels * depth) / 8);
  const run = inChild(
    `import { deflateSync } from "node:zlib";
     const [w, h, ct, d, stride] = ${JSON.stringify([width, height, colorType, depth, stride])};
     const crcTable = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
     const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
     const chunk = (name, body) => { const out = Buffer.alloc(12 + body.length); out.writeUInt32BE(body.length, 0); out.write(name, 4, "latin1"); out.set(body, 8); out.writeUInt32BE(crc(out.subarray(4, 8 + body.length)), 8 + body.length); return out; };
     const header = Buffer.alloc(13); header.writeUInt32BE(w, 0); header.writeUInt32BE(h, 4); header[8] = d; header[9] = ct;
     // The rows are made and packed a block at a time, so that the zeros are never all in memory at once.
     const zeros = Buffer.alloc((stride + 1) * h);
     const packed = deflateSync(zeros, { level: 1 });
     process.stdout.write(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header), chunk("IDAT", packed), chunk("IEND", Buffer.alloc(0))]).toString("base64"));`,
    undefined,
    60_000,
    2048,
  );
  if (run.status !== 0) throw new Error(`could not make the picture: ${run.stderr.slice(0, 200)}`);
  return new Uint8Array(Buffer.from(run.stdout, "base64"));
}
