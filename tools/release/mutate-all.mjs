// Runs every list in this folder (mutations-*.json), one after another, each through mutate.mjs, and prints a total.
// Usage: node tools/release/mutate-all.mjs [--list] [--check] [--allow-overlap]
//   --list           says which lists it would run and how many faults each holds, and runs nothing
//   --check          each list is only checked (mutate.mjs --check): does every fault go in, in one place; no test is run, nothing is written
//   --allow-overlap  passed to each run: do not wait for another run in this checkout (see mutate.mjs)
// The lists are the faults planted in the fixes of each release; they are run after a merge, because a merge can quietly undo a test's bite.
// One after another they take about two hours on a quiet machine (tools/release/README.md has the time of each); the runs are never
// started side by side, because two runs in one checkout spoil each other's results.
// Exit code: 0 only when every list ended with 0; 1 when a list had a problem; 2 for a mistake in the command or when there is no list;
// 130 when stopped by a signal (the run in progress puts its files back, and no later list is started).
import { spawn } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const runner = join(here, "mutate.mjs");
const KNOWN = ["--list", "--check", "--allow-overlap"];
const flags = process.argv.slice(2);

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const howLong = (ms) => {
  const seconds = Math.round(ms / 1000);
  return seconds >= 120 ? plural(Math.round(seconds / 60), "minute") : plural(seconds, "second");
};

function faultsIn(name) {
  try {
    const parsed = JSON.parse(readFileSync(join(here, name), "utf8"));
    return Array.isArray(parsed) ? parsed.length : 0;
  } catch {
    return 0; // mutate.mjs says in words what is wrong with the file
  }
}

let current = null;
let stopping = false;

/** Runs one list and passes what the runner prints on, counting the faults it killed. */
function runList(name) {
  return new Promise((done) => {
    const began = Date.now();
    const passed = flags.filter((flag) => flag === "--check" || flag === "--allow-overlap");
    const child = spawn(process.execPath, [runner, join(here, name), ...passed], { stdio: ["ignore", "pipe", "inherit"] });
    current = child;
    let killed = 0;
    let problems = null;
    let rest = "";
    const count = (text) => {
      if (/^killed /.test(text)) killed++;
      const said = /^(\d+) problem\(s\)/.exec(text);
      if (said) problems = Number(said[1]);
    };
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      process.stdout.write(chunk);
      const lines = (rest + chunk).split("\n");
      rest = lines.pop();
      for (const text of lines) count(text);
    });
    child.on("close", (status) => {
      count(rest);
      current = null;
      done({ name, status, killed, problems, ms: Date.now() - began });
    });
  });
}

async function main() {
  const unknown = flags.filter((flag) => !KNOWN.includes(flag));
  if (unknown.length > 0) {
    console.error(`${unknown.join(" ")}: not an option. Usage: node tools/release/mutate-all.mjs [--list] [--check] [--allow-overlap]`);
    return 2;
  }
  const names = readdirSync(here)
    .filter((name) => /^mutations-.+\.json$/.test(name))
    .sort();
  if (names.length === 0) {
    console.log(`no list to run: there is no mutations-*.json in ${here}`);
    return 2;
  }
  const counts = new Map(names.map((name) => [name, faultsIn(name)]));
  const faults = [...counts.values()].reduce((sum, n) => sum + n, 0);
  const width = Math.max(...names.map((name) => name.length));

  if (flags.includes("--list")) {
    for (const name of names) console.log(`${name.padEnd(width)}  ${plural(counts.get(name), "fault")}`);
    console.log(`would run ${plural(names.length, "list")}, ${plural(faults, "fault")}, one after another`);
    return 0;
  }

  const checking = flags.includes("--check");
  for (const signal of ["SIGINT", "SIGTERM", "SIGBREAK", "SIGHUP"]) {
    process.on(signal, () => {
      stopping = true;
      // On Windows the console sends Ctrl-C and Ctrl-Break to the run as well. Elsewhere only a signal to the group does, so pass it on.
      if (current && process.platform !== "win32") current.kill(signal);
    });
  }
  const began = Date.now();
  const results = [];
  for (const name of names) {
    if (stopping) break;
    console.log(`\n=== ${name} (${plural(counts.get(name), "fault")}) ===`);
    const result = await runList(name);
    results.push(result);
    // The run puts its files back and ends with 130 when a signal reaches it alone (a signal to its group reaches this script as well).
    if (result.status === 130) stopping = true;
  }

  console.log("\n=== summary ===");
  for (const result of results) {
    const faultsHere = counts.get(result.name);
    const verdict = result.status === 0 ? "ok" : result.problems !== null ? `${result.problems} problem(s)` : `exit code ${result.status}`;
    const said = checking ? plural(faultsHere, "fault") : `${result.killed} of ${faultsHere} killed`;
    console.log(`${result.name.padEnd(width)}  ${said.padEnd(16)} ${verdict}  (${howLong(result.ms)})`);
  }
  if (stopping) {
    console.log(`stopped by a signal after ${plural(results.length, "list")} of ${names.length}; the files are as they were`);
    return 130;
  }
  const wrong = results.filter((result) => result.status !== 0).length;
  const killed = results.reduce((sum, result) => sum + result.killed, 0);
  console.log(
    `total: ${plural(faults, "fault")} in ${plural(names.length, "list")}${checking ? " checked" : `, ${killed} killed`}, ${wrong} ${wrong === 1 ? "list" : "lists"} with problems, took ${howLong(Date.now() - began)}`,
  );
  return wrong === 0 ? 0 : 1;
}

process.exitCode = await main();
