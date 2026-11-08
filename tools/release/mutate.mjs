// Plants one fault at a time in a tracked file, runs the tests that should notice, and puts the file back byte for byte.
// Usage: node tools/release/mutate.mjs <mutations.json> [label substring]
// Each entry: { label, file, from, to, tests }. The text `from` must appear in `file`.
//
// What it will not let pass (a first version said "every planted fault was caught" in each of these cases, found by a reader):
//  - a fault that did not go in (NOT APPLIED), because a fault that is not there proves nothing;
//  - a fault that broke the tests from loading (fewer tests ran than in the baseline), because that is not a test noticing it;
//  - a test file that is not there, and tests that fail before anything is planted (the baseline run);
//  - a killed run: the original of every file is kept outside the repository before it is changed, a signal puts it back, and the next
//    run puts back anything a killed run left behind before it starts.
// The exit code is 0 only when every planted fault was caught.
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const specFile = process.argv[2];
const only = process.argv[3];
if (!specFile) {
  console.error("Usage: node tools/release/mutate.mjs <mutations.json> [label substring]");
  process.exit(2);
}

// --- The originals are kept outside the repository, so that nothing a kill does can lose them. ---
const keep = join(tmpdir(), "openassess-mutate-originals");
mkdirSync(keep, { recursive: true });
const keepName = (file) => join(keep, `${Buffer.from(file).toString("hex")}.orig`);
const recorded = new Map(); // repo-relative file -> original bytes, for the files changed in this run

function putBack(file) {
  const saved = keepName(file);
  if (existsSync(saved)) {
    writeFileSync(join(repo, file), readFileSync(saved));
    rmSync(saved, { force: true });
  }
}
for (const name of readdirSync(keep)) {
  // A run that was killed left these: put them back before anything else.
  const file = Buffer.from(name.replace(/\.orig$/, ""), "hex").toString("utf8");
  console.log(`RESTORED      ${file} (left changed by a run that was killed)`);
  writeFileSync(join(repo, file), readFileSync(join(keep, name)));
  rmSync(join(keep, name), { force: true });
}
function restoreAll() {
  for (const file of recorded.keys()) putBack(file);
}
for (const signal of ["SIGINT", "SIGTERM", "SIGBREAK"]) {
  process.on(signal, () => {
    restoreAll();
    process.exit(130);
  });
}
process.on("exit", restoreAll);

const run = (tests) => {
  const result = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", "--test", ...tests.map((t) => join(repo, t))], { encoding: "utf8", timeout: 600_000, cwd: repo });
  const number = (word) => Number((result.stdout.match(new RegExp(`^ℹ ${word} (\\d+)`, "m")) ?? [])[1] ?? Number.NaN);
  return { tests: number("tests"), fail: number("fail"), status: result.status, timedOut: result.error !== undefined };
};

const list = JSON.parse(readFileSync(specFile, "utf8")).filter((m) => !only || m.label.includes(only));
let problems = 0;

// --- Every test file must be there, and must pass before anything is planted. ---
const baselines = new Map();
for (const m of list) {
  for (const t of m.tests) {
    if (!existsSync(join(repo, t))) {
      console.log(`NO TEST FILE  ${m.label}: ${t} is not there`);
      problems++;
    }
  }
  const key = m.tests.join("\n");
  if (!baselines.has(key) && m.tests.every((t) => existsSync(join(repo, t)))) {
    const base = run(m.tests);
    baselines.set(key, base);
    if (base.status !== 0 || !(base.tests > 0) || base.fail !== 0) {
      console.log(`BASELINE FAILS ${m.tests.join(", ")}: ${base.tests} tests, ${base.fail} failed before anything was planted`);
      problems++;
    }
  }
}

for (const m of list) {
  const base = baselines.get(m.tests.join("\n"));
  if (!base || base.status !== 0) continue;
  const path = join(repo, m.file);
  const original = readFileSync(path);
  const text = original.toString("utf8");
  // Some files in a Windows checkout are CRLF and some LF (git converts on checkout): the text to find and the text to put are written
  // with the line ends the file has, so that a fault whose text spans lines is found in either.
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const fit = (t) => t.replace(/\r?\n/g, eol);
  const from = fit(m.from);
  const to = fit(m.to);
  const at = text.indexOf(from);
  if (at === -1) {
    console.log(`NOT APPLIED   ${m.label}`);
    problems++;
    continue;
  }
  writeFileSync(keepName(m.file), original); // outside the repository, before the file is touched
  recorded.set(m.file, original);
  try {
    writeFileSync(path, text.slice(0, at) + to + text.slice(at + from.length));
    const result = run(m.tests);
    if (result.timedOut || result.tests !== base.tests) {
      console.log(`BROKE LOADING ${m.label}  (${result.tests} tests ran, ${base.tests} in the baseline: not a test noticing the fault)`);
      problems++;
    } else if (result.fail > 0) {
      console.log(`killed        ${m.label}  (fail ${result.fail})`);
    } else {
      console.log(`SURVIVED      ${m.label}`);
      problems++;
    }
  } finally {
    putBack(m.file);
    recorded.delete(m.file);
  }
}
console.log(problems === 0 ? "every planted fault was caught" : `${problems} problem(s): see the lines above`);
process.exitCode = problems === 0 ? 0 : 1;
