// Plants one fault at a time in a tracked file, runs the tests that should notice, and puts the file back byte for byte.
// Usage: node tools/release/mutate.mjs <mutations.json> [label substring] [--check] [--allow-overlap]
//   --check          plants nothing, runs no test and writes nothing: says for every entry of the list whether its fault would go in
//                    (NOT APPLIED, AMBIGUOUS, NO SUCH FILE and the rest). It takes a second or two, so run it after every edit of a list.
//   --allow-overlap  go on at once although another run in this checkout is going. The default is to wait for it (see below).
// Each entry: { label, file, from, to, tests }. The text `from` must appear in `file` exactly once.
//
// What it will not let pass (a first version said "every planted fault was caught" in each of these cases, found by a reader):
//  - a fault that did not go in (NOT APPLIED), or that could go in at more than one place (AMBIGUOUS: the first would be replaced and
//    nothing would say which), or whose `from` is empty (the new text would be put in front of the file), or that changes nothing;
//  - a fault that broke the tests from loading (fewer or more tests ran than in the baseline), because that is not a test noticing it;
//  - a fault that made the tests hang (TIMED OUT after 10 minutes);
//  - a test file that is not there, a file that is not there, and tests that fail before anything is planted (the baseline run), in which
//    case every fault that needed them is named (SKIPPED) and counted;
//  - a list with no fault in it, or a label filter that matches none: nothing was planted, and that is not "every fault was caught".
//
// What happens to the files:
//  - The original of every file is kept outside the repository before it is changed, in a folder for this repository and this process
//    (openassess-mutate-originals/<hash of the repository's path>-<process id>/).
//  - A signal (SIGINT, SIGBREAK, SIGHUP, SIGTERM) stops the test run in flight and everything it started, puts every changed file back,
//    removes the folder and exits with 130. It can do that because the runner is asynchronous: while the tests run, its event loop is
//    free. (A first version waited for the tests in a call that blocks, so the handlers could never run, and by being installed they
//    stopped the signal from ending the process at all.) Real Ctrl-C and Ctrl-Break were sent on Windows (check-ctrl-break.ps1); the
//    other two are handled by the same function and were not. A kill that gives it no chance (End Task) puts nothing back (on Windows its
//    test run ends with it; elsewhere it is left to end by itself), and the next run does: before it starts, it puts back whatever a run
//    that is gone left in its folder.
//  - Two runs in one checkout spoil each other (the second one's baseline would have the first one's fault in it). A run that finds an
//    older run of this checkout going waits for it, saying so once a minute, for up to three hours; --allow-overlap does not wait.
//    Runs of other checkouts (a worktree) do not meet, the folders are told apart by the repository's path.
//
// Exit code: 0 every planted fault was caught; 1 a problem (see the lines above); 2 nothing was planted (a mistake in the command or the
// list, an empty list or filter, a wait that was given up); 130 stopped by a signal.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

// --- Settings. The variables are for the runner's own test (packages/assess/test/mutate-runner.test.ts), which cannot wait three hours. ---
const fromEnvironment = (name, fallback) => {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
};
const TIME_LIMIT_MS = fromEnvironment("OA_MUTATE_TIME_LIMIT_MS", 600_000); // for one test run
const WAIT_LIMIT_MS = fromEnvironment("OA_MUTATE_WAIT_LIMIT_MS", 3 * 60 * 60 * 1000); // for an older run of this checkout
const POLL_MS = fromEnvironment("OA_MUTATE_POLL_MS", 2000);
const MESSAGE_MS = fromEnvironment("OA_MUTATE_MESSAGE_MS", 60_000);
const SETTLE_MS = 200; // after a test run ends and before its result is used: see runTests
// A signal cannot be sent to a process from Node on Windows (the call ends it), so the test of the signal path names a file: while a test
// run is in flight and the file exists, the runner takes the path a SIGINT takes. It is the same function that a real signal calls.
const TEST_SIGNAL = process.env["OA_MUTATE_TEST_SIGNAL"];

const USAGE = "Usage: node tools/release/mutate.mjs <mutations.json> [label substring] [--check] [--allow-overlap]";
const words = process.argv.slice(2);
const flags = words.filter((word) => word.startsWith("--"));
const [specFile, only, ...surplus] = words.filter((word) => !word.startsWith("--"));
const checkOnly = flags.includes("--check");
const allowOverlap = flags.includes("--allow-overlap");

// --- The originals are kept outside the repository, so that nothing a kill does can lose them. ---
// Each run keeps its own folder, named for this repository and for the run's process id. A single folder for the machine let a second
// run, started while the first was alive, take the first's saved originals for the leavings of a killed run and write them into the
// repository under it (a reader found this when two readers ran the tool in one afternoon). Now only a folder whose process is gone
// is put back, and only if it belongs to this repository.
const root = join(tmpdir(), "openassess-mutate-originals");
const tag = createHash("sha1").update(repo.toLowerCase()).digest("hex").slice(0, 12);
const keep = join(root, `${tag}-${process.pid}`);
const hex = (file) => Buffer.from(file).toString("hex");
const keepName = (file) => join(keep, `${hex(file)}.orig`);
const recorded = new Set(); // repo-relative files changed in this run and not yet put back
let inFlight = null; // the test run that is going
let problems = 0;

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const line = (word, text) => `${word.padEnd(13)} ${text}`;
const howLong = (ms) => {
  const [value, unit] = ms >= 3_600_000 ? [ms / 3_600_000, "hour"] : ms >= 60_000 ? [ms / 60_000, "minute"] : [ms / 1000, "second"];
  const shown = Math.round(value * 10) / 10;
  return `${shown} ${unit}${shown === 1 ? "" : "s"}`;
};

/** Whether a process with this id is running. A process that is not ours to signal is still running. */
function running(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

function putBack(file) {
  const saved = keepName(file);
  if (existsSync(saved)) {
    writeFileSync(join(repo, file), readFileSync(saved));
    rmSync(saved, { force: true });
  }
}
function restoreAll() {
  for (const file of recorded) putBack(file);
  recorded.clear();
}

/** The folders of other runs of THIS repository: where they keep the originals of what they have changed. */
function otherRuns() {
  if (!existsSync(root)) return [];
  const found = [];
  for (const folder of readdirSync(root)) {
    const named = /^([0-9a-f]{12})-(\d+)$/.exec(folder);
    if (named && named[1] === tag && Number(named[2]) !== process.pid) found.push({ folder, path: join(root, folder), pid: Number(named[2]) });
  }
  return found;
}

/** Puts back what a run that is gone left changed. Returns how many files it could not put back. */
function restoreLeftovers() {
  let failed = 0;
  for (const other of otherRuns()) {
    if (running(other.pid)) continue;
    let all = true;
    for (const name of readdirSync(other.path)) {
      if (!/^[0-9a-f]+\.orig$/.test(name)) continue;
      const file = Buffer.from(name.slice(0, -5), "hex").toString("utf8");
      try {
        writeFileSync(join(repo, file), readFileSync(join(other.path, name)));
        console.log(line("RESTORED", `${file} (left changed by a run that was killed)`));
      } catch (error) {
        console.log(line("NOT RESTORED", `${file}: ${error.message}`));
        all = false;
        failed++;
      }
    }
    if (all) rmSync(other.path, { recursive: true, force: true });
  }
  return failed;
}

/** When a folder was made. Runs are served in the order of their folders; a folder that has just gone is not older than anything. */
function birth(path) {
  try {
    const stat = statSync(path);
    return stat.birthtimeMs > 0 ? stat.birthtimeMs : stat.mtimeMs;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/**
 * Takes this run's place in the checkout. A run may plant when no OLDER run of this checkout is going, so that two runs that wait for a
 * third do not wait for each other (each made its folder first and each is going, as far as the other can see): the order is the age of
 * the folder, then the process id. Returns false when it gave up.
 */
async function claimTurn() {
  mkdirSync(keep, { recursive: true });
  const mine = birth(keep);
  installHandlers();
  const began = Date.now();
  let toldAt = -Infinity;
  for (;;) {
    problems += restoreLeftovers();
    const going = otherRuns().filter((other) => running(other.pid));
    if (going.length === 0) return true;
    if (allowOverlap) {
      for (const other of going) {
        console.log(line("LEFT ALONE", `${other.folder}: the run that made it is still going. Two runs that plant faults in one checkout at once can spoil each other's results.`));
      }
      return true;
    }
    const ahead = going
      .map((other) => ({ ...other, born: birth(other.path) }))
      .filter((other) => other.born < mine || (other.born === mine && other.pid < process.pid))
      .sort((a, b) => a.born - b.born || a.pid - b.pid);
    if (ahead.length === 0) return true;
    const waited = Date.now() - began;
    if (waited >= WAIT_LIMIT_MS) {
      console.log(
        line("GAVE UP", `waited ${howLong(waited)} for the run of process ${ahead[0].pid} (${ahead[0].folder}) and it is still going. Nothing was planted. If it is not really going (a process number can be taken by another program after a crash), run again with --allow-overlap.`),
      );
      return false;
    }
    if (Date.now() - toldAt >= MESSAGE_MS) {
      toldAt = Date.now();
      console.log(
        line("WAITING", `another run in this checkout is going (process ${ahead[0].pid}, started ${howLong(Date.now() - ahead[0].born)} ago): two runs at once spoil each other's results, so this one waits for it, for up to ${howLong(WAIT_LIMIT_MS - waited)} more. --allow-overlap goes on at once.`),
      );
    }
    await sleep(POLL_MS);
  }
}

// --- The test run, and the signal. ---
/**
 * Ends a test run and everything it started: node --test starts a process for each test file. On Windows that is taskkill with /T (the
 * tree). Node's own children end with their parent there anyway (libuv puts them in a job that ends with the process; shown by ending
 * the parent of a test file with and without /T, and by ending this runner with a test run going), so /T matters only for a process
 * a test started by other means. Elsewhere the run is a process group of its own (see `detached` below) and the group is ended.
 */
function killTree(child) {
  if (child.pid === undefined) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  } else {
    try {
      process.kill(-child.pid, "SIGKILL"); // a group of its own: see `detached` below
    } catch {
      child.kill("SIGKILL");
    }
  }
}

/** Written at once and not through the stream, which may not be flushed when the process ends. */
function say(text) {
  try {
    writeSync(1, `${text}\n`);
  } catch {
    console.log(text);
  }
}

let stopped = false;
function stop(signal) {
  if (stopped) return;
  stopped = true;
  if (inFlight) killTree(inFlight);
  const changed = [...recorded];
  restoreAll();
  rmSync(keep, { recursive: true, force: true });
  say(line("STOPPED", `${signal}: the test run was stopped${changed.length > 0 ? ` and ${changed.join(", ")} put back` : ""}.`));
  process.exit(130);
}
function installHandlers() {
  for (const signal of ["SIGINT", "SIGTERM", "SIGBREAK", "SIGHUP"]) process.on(signal, () => stop(signal));
  process.on("exit", () => {
    restoreAll();
    rmSync(keep, { recursive: true, force: true });
  });
}

/** Runs node's test runner on these files and counts what it printed. Never blocks: the signal handlers must be able to run. */
function runTests(tests) {
  return new Promise((done) => {
    // Inside a test run of the program's own the variable that makes a test process report to its parent is set, and this run would then print nothing to count.
    const env = { ...process.env };
    delete env["NODE_TEST_CONTEXT"];
    // A reporter named in NODE_OPTIONS and another on the command line make node refuse to start ("--test-reporter must match the number of
    // --test-reporter-destination"), so the one asked for below is the only one: any other is taken out of what the test run inherits.
    if (env["NODE_OPTIONS"]) env["NODE_OPTIONS"] = env["NODE_OPTIONS"].replace(/--test-reporter(?:-destination)?(?:=|\s+)\S+/g, " ").trim();
    // The reporter is asked for, never left to be chosen: with the output piped, Node 22 prints TAP ("# tests 3") and Node 24 prints the
    // spec form ("ℹ tests 3"), so a run that read only one of them counted nothing on the other, called every baseline failed, and planted
    // no fault (nine of this runner's own tests failed in GitHub's check, on Node 22, while they passed on the Node 24 they were written on).
    const child = spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", "--test", "--test-reporter=tap", ...tests.map((t) => join(repo, t))], {
      cwd: repo,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    let stdout = "";
    let timedOut = false;
    let spawnError;
    let finished = false;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.resume(); // read and thrown away: a pipe that is not read fills and stops the run
    inFlight = child;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
      setTimeout(() => finish(null), 10_000).unref(); // in case something that was started holds the pipe open
    }, TIME_LIMIT_MS);
    const watch = TEST_SIGNAL ? setInterval(() => existsSync(TEST_SIGNAL) && process.emit("SIGINT"), 50) : undefined;
    const finish = (status) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      clearInterval(watch);
      inFlight = null;
      const number = (word) => Number((stdout.match(new RegExp(`^# ${word} (\\d+)`, "m")) ?? [])[1] ?? Number.NaN);
      const result = { tests: number("tests"), fail: number("fail"), status, timedOut, spawnError };
      // A key pressed at the console reaches the test run as well as this process, and the run can end first: its failure would be
      // printed as a fault that was killed. Wait a moment, so that a signal on its way is looked at before the result is (a real
      // Ctrl-C printed "killed" for the fault it had interrupted, and then STOPPED).
      setTimeout(() => done(result), SETTLE_MS);
    };
    child.on("error", (error) => {
      spawnError = error;
      finish(null);
    });
    child.on("close", (status) => finish(status));
  });
}

// --- One entry of a list: does its fault go in, and in exactly one place? ---
function shapeProblem(m) {
  if (m === null || typeof m !== "object" || Array.isArray(m)) return "the entry is not an object";
  for (const field of ["label", "file", "from", "to"]) if (typeof m[field] !== "string") return `${field} is missing or is not text`;
  if (!Array.isArray(m.tests) || m.tests.length === 0 || m.tests.some((t) => typeof t !== "string" || t === "")) return "tests must be a list of test file names, at least one";
  return "";
}

/**
 * The bytes of a file as it was before any run changed it. A run that is going has the original of a file it has changed in its folder, and
 * --check, which writes nothing and waits for nobody, reads that and not the file as it stands (which has the other run's fault in it).
 */
function readOriginal(file, beforeAnyRun) {
  if (beforeAnyRun) {
    for (const other of otherRuns()) {
      const saved = join(other.path, `${hex(file)}.orig`);
      if (existsSync(saved)) return readFileSync(saved);
    }
  }
  return readFileSync(join(repo, file));
}

/** Either { lines } (what is wrong, to be printed) or what planting it needs. */
function inspect(m, index, beforeAnyRun) {
  const bad = shapeProblem(m);
  const label = typeof m?.label === "string" && m.label !== "" ? m.label : `entry ${index + 1}`;
  if (bad) return { lines: [line("BAD ENTRY", `${label}: ${bad}`)] };
  if (m.from === "") return { lines: [line("EMPTY FROM", `${label}: from is empty, which would put the new text in front of the file`)] };
  if (m.from === m.to) return { lines: [line("NO CHANGE", `${label}: from and to are the same, so nothing would be planted`)] };
  const lines = [];
  for (const t of m.tests) if (!existsSync(join(repo, t))) lines.push(line("NO TEST FILE", `${label}: ${t} is not there`));
  let original;
  try {
    original = readOriginal(m.file, beforeAnyRun);
  } catch (error) {
    lines.push(error.code === "ENOENT" ? line("NO SUCH FILE", `${label}: ${m.file} is not there`) : line("CANNOT READ", `${label}: ${m.file}: ${error.message}`));
  }
  if (lines.length > 0) return { lines };
  const text = original.toString("utf8");
  // Some files in a Windows checkout are CRLF and some LF (git converts on checkout): the text to find and the text to put are written
  // with the line ends the file has, so that a fault whose text spans lines is found in either.
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const fit = (t) => t.replace(/\r?\n/g, eol);
  const from = fit(m.from);
  const to = fit(m.to);
  const at = text.indexOf(from);
  if (at === -1) return { lines: [line("NOT APPLIED", `${label}: from is not in ${m.file}`)] };
  let count = 1;
  for (let next = text.indexOf(from, at + 1); next !== -1; next = text.indexOf(from, next + 1)) count++;
  if (count > 1) return { lines: [line("AMBIGUOUS", `${label}: from occurs ${count} times in ${m.file} and a fault must name one place: make from longer until it occurs once`)] };
  return { label, m, path: join(repo, m.file), original, text, at, from, to };
}

async function main() {
  if (!specFile || surplus.length > 0 || flags.some((flag) => flag !== "--check" && flag !== "--allow-overlap")) {
    console.error(USAGE);
    return 2;
  }
  // Whatever a run that is gone left changed is put back before anything else (--check writes nothing, and reads the originals where they are kept).
  if (!checkOnly) problems += restoreLeftovers();

  let parsed;
  try {
    parsed = JSON.parse(readFileSync(specFile, "utf8"));
  } catch (error) {
    console.log(line("CANNOT READ", `${specFile}: ${error.code === "ENOENT" ? "it is not there" : error.message}`));
    return 2;
  }
  if (!Array.isArray(parsed)) {
    console.log(line("CANNOT READ", `${specFile} is not a list of faults (it must be a JSON array of entries)`));
    return 2;
  }
  const did = checkOnly ? "checked" : "planted";
  if (parsed.length === 0) {
    console.log(`no fault was ${did}: the list is empty (${specFile} has no entries)`);
    return 2;
  }
  const entries = parsed.map((m, index) => ({ m, index })).filter(({ m }) => !only || (typeof m?.label === "string" && m.label.includes(only)));
  if (entries.length === 0) {
    console.log(`no fault was ${did}: nothing matches the filter "${only}" (the list has ${parsed.length} entries)`);
    return 2;
  }

  if (checkOnly) {
    let wrong = 0;
    for (const { m, index } of entries) {
      const seen = inspect(m, index, true);
      if (seen.lines) {
        for (const text of seen.lines) console.log(text);
        wrong++;
      }
    }
    console.log(wrong === 0 ? `every fault applies, each in one place (${entries.length} checked)` : `${wrong} problem(s): see the lines above (${entries.length} checked)`);
    return wrong === 0 ? 0 : 1;
  }

  if (!(await claimTurn())) return 2;

  // --- Every entry must be sound before anything is planted: a list that is wrong should say so at once and not an hour in. ---
  const usable = [];
  for (const { m, index } of entries) {
    const seen = inspect(m, index, false);
    if (seen.lines) {
      for (const text of seen.lines) console.log(text);
      problems++;
    } else {
      usable.push({ ...seen, index });
    }
  }

  // --- The tests must pass before anything is planted. ---
  const baselines = new Map();
  for (const seen of usable) {
    const key = seen.m.tests.join("\n");
    if (baselines.has(key)) continue;
    const base = await runTests(seen.m.tests);
    base.ok = !base.timedOut && base.status === 0 && base.tests > 0 && base.fail === 0;
    baselines.set(key, base);
    const names = seen.m.tests.join(", ");
    if (base.ok) console.log(line("baseline", `${names} (${base.tests} tests pass)`));
    else if (base.timedOut) console.log(line("BASELINE FAILS", `${names}: timed out after ${howLong(TIME_LIMIT_MS)} before anything was planted`));
    else if (Number.isNaN(base.tests)) console.log(line("BASELINE FAILS", `${names}: no count of tests was printed (exit code ${base.status}) before anything was planted`));
    else console.log(line("BASELINE FAILS", `${names}: ${base.tests} tests, ${base.fail} failed before anything was planted`));
  }

  let planted = 0;
  let killed = 0;
  for (const first of usable) {
    const base = baselines.get(first.m.tests.join("\n"));
    if (!base.ok) {
      console.log(line("SKIPPED", `${first.label}: its tests fail before anything is planted, so it was not planted`));
      problems++;
      continue;
    }
    const seen = inspect(first.m, first.index, false); // read again: the file is read at the moment it is planted
    if (seen.lines) {
      for (const text of seen.lines) console.log(text);
      problems++;
      continue;
    }
    writeFileSync(keepName(seen.m.file), seen.original); // outside the repository, before the file is touched
    recorded.add(seen.m.file);
    try {
      writeFileSync(seen.path, seen.text.slice(0, seen.at) + seen.to + seen.text.slice(seen.at + seen.from.length));
      planted++;
      const result = await runTests(seen.m.tests);
      if (result.timedOut) {
        console.log(line("TIMED OUT", `${seen.label}  (the tests did not finish in ${howLong(TIME_LIMIT_MS)} with the fault planted: not a test noticing it)`));
        problems++;
      } else if (result.tests !== base.tests) {
        // Also what a fault in the code that makes a test list gives: the number of tests changes by itself. See the README.
        const ran = Number.isNaN(result.tests) ? "no count of tests was printed" : `${result.tests} tests ran, ${base.tests} in the baseline`;
        console.log(line("BROKE LOADING", `${seen.label}  (${ran}: not a test noticing the fault)`));
        problems++;
      } else if (result.fail > 0) {
        console.log(line("killed", `${seen.label}  (fail ${result.fail})`));
        killed++;
      } else {
        console.log(line("SURVIVED", seen.label));
        problems++;
      }
    } finally {
      putBack(seen.m.file);
      recorded.delete(seen.m.file);
    }
  }
  console.log(problems === 0 ? `every planted fault was caught (${planted})` : `${problems} problem(s): see the lines above (${planted} planted, ${killed} killed)`);
  return problems === 0 ? 0 : 1;
}

try {
  process.exitCode = await main();
} catch (error) {
  if (inFlight) killTree(inFlight);
  console.log(line("FAILED", `the runner itself stopped: ${error?.stack ?? error}`));
  process.exitCode = 1;
}
