// Plants one fault at a time in a tracked file, runs the tests that should notice, and puts the file back byte for byte.
// Usage: node tools/release/mutate.mjs <mutations.json> [label substring]
// Each entry: { label, file, from, to, tests }. The text `from` must appear in `file`; a fault that is not found is reported as NOT APPLIED,
// because a planted fault that did not go in proves nothing. Do not run other tests while it runs: the file really is changed.
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const list = JSON.parse(readFileSync(process.argv[2], "utf8"));
const only = process.argv[3];
let survived = 0;
for (const m of list) {
  if (only && !m.label.includes(only)) continue;
  const path = join(repo, m.file);
  const original = readFileSync(path);
  const text = original.toString("utf8");
  const at = text.indexOf(m.from);
  if (at === -1) {
    console.log(`NOT APPLIED   ${m.label}`);
    continue;
  }
  try {
    writeFileSync(path, text.slice(0, at) + m.to + text.slice(at + m.from.length));
    const run = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", "--test", ...m.tests.map((t) => join(repo, t))], { encoding: "utf8", timeout: 400_000, cwd: repo });
    const failed = (run.stdout.match(/^ℹ fail (\d+)/m) ?? [])[1];
    const killed = run.status !== 0 || run.error !== undefined;
    if (!killed) survived++;
    console.log(`${killed ? "killed       " : "SURVIVED     "} ${m.label}  (fail ${failed ?? "?"})`);
  } finally {
    writeFileSync(path, original);
  }
}
console.log(survived === 0 ? "every planted fault was caught" : `${survived} planted fault(s) survived`);
