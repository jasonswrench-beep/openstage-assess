/**
 * The runner that plants faults (tools/release/mutate.mjs) and the script that runs every list (tools/release/mutate-all.mjs) are held
 * to what they promise, on a small repository of their own.
 *
 * Readers of the release tooling proved, one after another, that the tool which says "every planted fault was caught" could say it
 * falsely or could spoil a result:
 *  - it kept the originals of every run in one folder for the machine, so a run started while another was alive took the other's saved
 *    files for the leavings of a killed run and wrote them into the repository;
 *  - its signal handlers could never run (the whole script was one synchronous run), and by being installed they stopped Ctrl-C and
 *    Ctrl-Break from ending it, so it went on planting the rest of the list;
 *  - an empty list, or a filter that matched nothing, was "every planted fault was caught" with exit code 0;
 *  - a failed baseline skipped its faults without a line, a hang was reported as "NaN tests ran", an empty `from` put the new text in
 *    front of the file, a `from` found twice replaced the first and said nothing, and a file that was not there was a stack trace;
 *  - two runs in one checkout saw each other's planted fault in their baseline.
 * Each of those is a test here, and each was shown to fail on the runner as it was.
 *
 * A signal cannot be sent to another process from Node on Windows, so the runner has a hook for its own test (OA_MUTATE_TEST_SIGNAL, a
 * file name: while a test run is in flight and the file exists, the runner takes the path a SIGINT takes). The path a real Ctrl-Break
 * takes was tried by hand with tools/release/README.md's driver and is not something this file can do.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const releaseDir = resolve(here, "../../../tools/release");
const runner = join(releaseDir, "mutate.mjs");
const runAll = join(releaseDir, "mutate-all.mjs");
const originalsRoot = join(tmpdir(), "openassess-mutate-originals");

/** A test that passes while a.txt has no FAULT in it, and says when it ran. */
const quickTest = `import test from "node:test";
import { appendFileSync, readFileSync } from "node:fs";
appendFileSync(new URL("./ran.txt", import.meta.url), "x");
test("a.txt is not faulty", () => {
  if (readFileSync(new URL("./a.txt", import.meta.url), "utf8").includes("FAULT")) throw new Error("faulty");
});
`;

/** As quickTest, but with the fault in it holds on for a minute and says which process it is, as a long test run does. */
const slowTest = `import test from "node:test";
import { readFileSync, writeFileSync } from "node:fs";
test("a.txt is not faulty", async () => {
  if (readFileSync(new URL("./a.txt", import.meta.url), "utf8").includes("FAULT")) {
    writeFileSync(new URL("./pid.txt", import.meta.url), String(process.pid));
    await new Promise((resolve) => setTimeout(resolve, 60_000));
  }
});
`;

/** A test that is not there at all when the fault is in (a data-driven list that comes out shorter). */
const countTest = `import test from "node:test";
import { readFileSync } from "node:fs";
const faulty = readFileSync(new URL("./a.txt", import.meta.url), "utf8").includes("FAULT");
if (!faulty) test("only while nothing is wrong", () => {});
test("always", () => {
  if (faulty) throw new Error("faulty");
});
`;

/** A test that fails before anything is planted. */
const brokenTest = `import test from "node:test";
test("broken before anything is planted", () => {
  throw new Error("broken");
});
`;

const oneFault = { label: "a fault", file: "a.txt", from: "original", to: "FAULT", tests: ["t.test.mjs"] };

interface Finished {
  out: string;
  status: number | null;
  timedOut: boolean;
}
interface Started {
  child: ChildProcess;
  output: () => string;
  finished: (ms: number) => Promise<Finished>;
}
interface Made {
  repo: string;
  tag: string;
  /** Runs the runner to the end and waits (for the runs that finish by themselves quickly). */
  run: (...args: string[]) => { out: string; status: number | null };
  /** Starts the runner and does not wait. */
  start: (args?: string[], extraEnv?: Record<string, string>) => Started;
  /** Runs any script of the small repository's tools/release folder. */
  script: (name: string, ...args: string[]) => { out: string; status: number | null };
}

/** Inside this test run the variable that makes a test process report to its parent is set, and the runner's own test run would then print nothing it can count. */
function cleanEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra };
  delete env["NODE_TEST_CONTEXT"];
  return env;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Ends a process and what it started (the runner starts node --test, which starts a process for each test file). */
function killTree(pid: number | undefined): void {
  if (pid === undefined) return;
  if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
  else {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
}

async function until(check: () => boolean, ms: number, step = 50): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, step));
  }
  return check();
}

/** A repository of one file and one test, with the runner copied in where it will look for its repository. */
function smallRepo(options: { spec?: unknown; testFile?: string; files?: Record<string, string> } = {}): Made {
  const repo = resolve(mkdtempSync(join(tmpdir(), "oa-mutate-test-")));
  mkdirSync(join(repo, "tools", "release"), { recursive: true });
  copyFileSync(runner, join(repo, "tools", "release", "mutate.mjs"));
  copyFileSync(runAll, join(repo, "tools", "release", "mutate-all.mjs"));
  writeFileSync(join(repo, "a.txt"), "original\n");
  writeFileSync(join(repo, "t.test.mjs"), options.testFile ?? quickTest);
  writeFileSync(join(repo, "spec.json"), JSON.stringify(options.spec ?? [oneFault]));
  for (const [name, text] of Object.entries(options.files ?? {})) {
    mkdirSync(dirname(join(repo, name)), { recursive: true });
    writeFileSync(join(repo, name), text);
  }
  const tag = createHash("sha1").update(repo.toLowerCase()).digest("hex").slice(0, 12);
  const start = (args: string[] = [], extraEnv: Record<string, string> = {}): Started => {
    const child = spawn(process.execPath, [join(repo, "tools", "release", "mutate.mjs"), join(repo, "spec.json"), ...args], {
      cwd: repo,
      env: cleanEnv(extraEnv),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout?.setEncoding("utf8").on("data", (chunk: string) => (out += chunk));
    child.stderr?.setEncoding("utf8").on("data", (chunk: string) => (out += chunk));
    const closed = new Promise<number | null>((done) => child.on("close", (status) => done(status)));
    const finished = async (ms: number): Promise<Finished> => {
      let timer: NodeJS.Timeout | undefined;
      const late = new Promise<"late">((done) => (timer = setTimeout(() => done("late"), ms)));
      const first = await Promise.race([closed, late]);
      clearTimeout(timer);
      if (first === "late") {
        killTree(child.pid);
        await Promise.race([closed, new Promise((done) => setTimeout(done, 10_000))]);
        return { out, status: null, timedOut: true };
      }
      return { out, status: first, timedOut: false };
    };
    return { child, output: () => out, finished };
  };
  const script = (name: string, ...args: string[]) => {
    const result = spawnSync(process.execPath, [join(repo, "tools", "release", name), ...args], { encoding: "utf8", cwd: repo, timeout: 240_000, env: cleanEnv() });
    return { out: `${result.stdout}${result.stderr}`, status: result.status };
  };
  const run = (...args: string[]) => script("mutate.mjs", join(repo, "spec.json"), ...args);
  return { repo, tag, run, start, script };
}

/** The folder a live run keeps its originals in (this process is alive, so a folder named for it is the folder of a run that is going). */
function liveRunFolder(tag: string, files: Record<string, string> = {}): string {
  const folder = join(originalsRoot, `${tag}-${process.pid}`);
  mkdirSync(folder, { recursive: true });
  for (const [file, text] of Object.entries(files)) writeFileSync(join(folder, `${Buffer.from(file).toString("hex")}.orig`), text);
  return folder;
}

describe("the runner that plants faults", () => {
  test("a fault the tests notice is killed, and the file is as it was", () => {
    const { repo, run } = smallRepo();
    try {
      const { out, status } = run();
      assert.match(out, /killed\s+a fault/);
      assert.equal(status, 0);
      assert.equal(readFileSync(join(repo, "a.txt"), "utf8"), "original\n");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("the originals of a run that is still alive are left alone when overlap is allowed, and not written into the repository", () => {
    const { repo, run, tag } = smallRepo();
    const folder = liveRunFolder(tag, { "a.txt": "SAVED BY ANOTHER RUN\n" });
    try {
      const { out } = run("--allow-overlap");
      assert.match(out, /LEFT ALONE/);
      assert.doesNotMatch(out, /RESTORED/);
      assert.equal(readFileSync(join(repo, "a.txt"), "utf8"), "original\n", "the file of this repository was not replaced by another run's copy");
      assert.ok(existsSync(folder), "and the other run's folder is still there for it");
    } finally {
      rmSync(folder, { recursive: true, force: true });
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("the originals of a run that was killed are put back, and its folder goes", () => {
    const { repo, run, tag } = smallRepo();
    // A process that has finished: its id is not running, so its folder is what a killed run leaves.
    const gone = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" });
    const folder = join(originalsRoot, `${tag}-${gone.stdout.trim()}`);
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, `${Buffer.from("a.txt").toString("hex")}.orig`), "left behind\n");
    writeFileSync(join(repo, "a.txt"), "FAULT left in the file by the killed run\n");
    try {
      const { out } = run("no such fault");
      assert.match(out, /RESTORED\s+a\.txt/);
      assert.equal(readFileSync(join(repo, "a.txt"), "utf8"), "left behind\n");
      assert.ok(!existsSync(folder), "and its folder is removed");
    } finally {
      rmSync(folder, { recursive: true, force: true });
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("a run started from inside a test run still counts the tests of its own test runs", () => {
    // Inside a test run the variable NODE_TEST_CONTEXT is set, and a test process that has it reports to its parent and prints nothing a
    // person (or this runner) can count. The runner does not pass it on, so that it can be started from a test, as this one starts it.
    const { repo } = smallRepo();
    try {
      const result = spawnSync(process.execPath, [join(repo, "tools", "release", "mutate.mjs"), join(repo, "spec.json")], {
        encoding: "utf8",
        cwd: repo,
        timeout: 120_000,
        env: { ...process.env, NODE_TEST_CONTEXT: "child-v8" },
      });
      assert.match(result.stdout, /killed\s+a fault/);
      assert.equal(result.status, 0);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("a run that ends leaves no folder of its own behind", () => {
    const { repo, run, tag } = smallRepo();
    try {
      run();
      const mine = existsSync(originalsRoot) ? readdirSync(originalsRoot).filter((name) => name.startsWith(`${tag}-`)) : [];
      assert.deepEqual(mine, []);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe("a signal ends the run", () => {
  test("the test run is stopped with everything it started, the file is back, the folder is gone, and the exit code is 130", async () => {
    const { repo, start, tag } = smallRepo({ testFile: slowTest });
    const trigger = join(repo, "signal.now");
    const running = start([], { OA_MUTATE_TEST_SIGNAL: trigger });
    let testPid = 0;
    try {
      assert.ok(await until(() => existsSync(join(repo, "pid.txt")), 90_000), "the test run with the fault in it started");
      testPid = Number(readFileSync(join(repo, "pid.txt"), "utf8"));
      assert.equal(readFileSync(join(repo, "a.txt"), "utf8"), "FAULT\n", "the fault is in the file while the tests run");
      writeFileSync(trigger, "");
      const { out, status, timedOut } = await running.finished(30_000);
      assert.equal(timedOut, false, `the runner ended when the signal came, and not 30 seconds later:\n${out}`);
      assert.equal(status, 130, out);
      assert.match(out, /STOPPED/);
      assert.equal(readFileSync(join(repo, "a.txt"), "utf8"), "original\n", "the file is as it was, byte for byte");
      assert.ok(await until(() => !alive(testPid), 10_000), "the process of the test file (a grandchild of the runner) is gone");
      assert.deepEqual(existsSync(originalsRoot) ? readdirSync(originalsRoot).filter((name) => name.startsWith(`${tag}-`)) : [], [], "and the run's folder is removed");
    } finally {
      killTree(running.child.pid);
      if (testPid) killTree(testPid);
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe("a run that plants nothing says so", () => {
  test("an empty list is not 'every planted fault was caught'", () => {
    const { repo, run } = smallRepo({ spec: [] });
    try {
      const { out, status } = run();
      assert.match(out, /no fault was planted: the list is empty/);
      assert.doesNotMatch(out, /every planted fault was caught/);
      assert.equal(status, 2);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("a filter that matches nothing is not 'every planted fault was caught' either", () => {
    const { repo, run } = smallRepo();
    try {
      const { out, status } = run("a label that is not there");
      assert.match(out, /no fault was planted: nothing matches the filter/);
      assert.doesNotMatch(out, /every planted fault was caught/);
      assert.equal(status, 2);
      assert.equal(readFileSync(join(repo, "a.txt"), "utf8"), "original\n");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("a spec that is not a list of faults is refused in words", () => {
    const { repo, run } = smallRepo({ spec: { label: "not a list" } });
    try {
      const { out, status } = run();
      assert.match(out, /not a list/);
      assert.doesNotMatch(out, /every planted fault was caught/);
      assert.doesNotMatch(out, /\n\s+at /, "no stack trace");
      assert.equal(status, 2);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe("what is wrong with a list is said for each fault", () => {
  const twice = { label: "found twice", file: "two.txt", from: "x", to: "y", tests: ["t.test.mjs"] };
  const spec = [
    { label: "empty from", file: "a.txt", from: "", to: "FAULT", tests: ["t.test.mjs"] },
    twice,
    { label: "no such file", file: "nope.txt", from: "x", to: "y", tests: ["t.test.mjs"] },
    { label: "not there", file: "a.txt", from: "text that is not in the file", to: "y", tests: ["t.test.mjs"] },
    { label: "no change", file: "a.txt", from: "original", to: "original", tests: ["t.test.mjs"] },
    { label: "malformed", file: "a.txt", from: "original" },
    { label: "no test file", file: "a.txt", from: "original", to: "FAULT", tests: ["missing.test.mjs"] },
    { ...oneFault, label: "fine" },
  ];

  test("an empty from, a from found twice, a missing file and the rest are problems, not a prefix, a guess or a stack trace", () => {
    const { repo, run } = smallRepo({ spec, files: { "two.txt": "x and x\n" } });
    try {
      const { out, status } = run();
      assert.match(out, /EMPTY FROM\s+empty from/);
      assert.match(out, /AMBIGUOUS\s+found twice.*2 times/);
      assert.match(out, /NO SUCH FILE\s+no such file/);
      assert.match(out, /NOT APPLIED\s+not there/);
      assert.match(out, /NO CHANGE\s+no change/);
      assert.match(out, /BAD ENTRY\s+malformed/);
      assert.match(out, /NO TEST FILE\s+no test file.*missing\.test\.mjs/);
      assert.match(out, /killed\s+fine/);
      assert.doesNotMatch(out, /ENOENT|\n\s+at /, "no raw error and no stack trace");
      assert.match(out, /7 problem\(s\)/);
      assert.equal(status, 1);
      assert.equal(readFileSync(join(repo, "a.txt"), "utf8"), "original\n");
      assert.equal(readFileSync(join(repo, "two.txt"), "utf8"), "x and x\n", "the first of two places was not replaced");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("--check says the same, plants nothing and runs no test", () => {
    const { repo, run } = smallRepo({ spec, files: { "two.txt": "x and x\n" } });
    try {
      const { out, status } = run("--check");
      assert.match(out, /EMPTY FROM\s+empty from/);
      assert.match(out, /AMBIGUOUS\s+found twice.*2 times/);
      assert.match(out, /NO SUCH FILE\s+no such file/);
      assert.match(out, /NOT APPLIED\s+not there/);
      assert.match(out, /7 problem\(s\)/);
      assert.doesNotMatch(out, /killed|SURVIVED|every fault applies/);
      assert.equal(status, 1);
      assert.ok(!existsSync(join(repo, "ran.txt")), "the tests were not run");
      assert.equal(readFileSync(join(repo, "a.txt"), "utf8"), "original\n");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("--check on a list that applies says so, and exits 0", () => {
    const { repo, run } = smallRepo();
    try {
      const { out, status } = run("--check");
      assert.match(out, /every fault applies, each in one place \(1 checked\)/);
      assert.equal(status, 0);
      assert.ok(!existsSync(join(repo, "ran.txt")), "the tests were not run");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("--check reads a file that a run has planted a fault in as that run first found it, and writes nothing", () => {
    // The run is going (this process is alive) or it was killed (a process that is gone): in both, a.txt has the fault in it. Read as it
    // stands, the file has no `original` in it and the fault would be NOT APPLIED; and --check does not put back what a killed run left.
    const gone = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" }).stdout.trim();
    for (const pid of [String(process.pid), gone]) {
      const { repo, run, tag } = smallRepo();
      writeFileSync(join(repo, "a.txt"), "FAULT\n");
      const folder = join(originalsRoot, `${tag}-${pid}`);
      mkdirSync(folder, { recursive: true });
      writeFileSync(join(folder, `${Buffer.from("a.txt").toString("hex")}.orig`), "original\n");
      try {
        const { out, status } = run("--check");
        assert.match(out, /every fault applies/, `a run with process id ${pid}`);
        assert.doesNotMatch(out, /RESTORED/);
        assert.equal(status, 0);
        assert.equal(readFileSync(join(repo, "a.txt"), "utf8"), "FAULT\n", "--check writes nothing, not even what a run left behind");
        assert.ok(existsSync(folder), "and removes nothing");
      } finally {
        rmSync(folder, { recursive: true, force: true });
        rmSync(repo, { recursive: true, force: true });
      }
    }
  });

  test("a fault whose tests are broken before anything is planted is named, and counted, and not planted", () => {
    const second = { ...oneFault, label: "a second fault", from: "original" };
    const { repo, run } = smallRepo({ spec: [oneFault, second], testFile: brokenTest });
    try {
      const { out, status } = run();
      assert.match(out, /BASELINE FAILS\s+t\.test\.mjs/);
      assert.match(out, /SKIPPED\s+a fault/);
      assert.match(out, /SKIPPED\s+a second fault/);
      assert.match(out, /2 problem\(s\)/);
      assert.doesNotMatch(out, /every planted fault was caught/);
      assert.equal(status, 1);
      assert.equal(readFileSync(join(repo, "a.txt"), "utf8"), "original\n");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("a fault that changes how many tests there are is BROKE LOADING, a problem, and not killed", () => {
    const { repo, run } = smallRepo({ testFile: countTest });
    try {
      const { out, status } = run();
      assert.match(out, /BROKE LOADING\s+a fault\s+\(1 tests ran, 2 in the baseline/);
      assert.doesNotMatch(out, /^killed /m, "a test that failed is not counted as a test that noticed it");
      assert.equal(status, 1);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("a fault that makes the tests hang is TIMED OUT, with the time said, and what the run started is stopped", async () => {
    const { repo, start } = smallRepo({ testFile: slowTest });
    const running = start([], { OA_MUTATE_TIME_LIMIT_MS: "12000" });
    let testPid = 0;
    try {
      const { out, status, timedOut } = await running.finished(90_000);
      assert.equal(timedOut, false, out);
      assert.match(out, /TIMED OUT\s+a fault.*12 seconds/);
      assert.doesNotMatch(out, /BROKE LOADING|NaN/);
      assert.equal(status, 1);
      assert.equal(readFileSync(join(repo, "a.txt"), "utf8"), "original\n");
      testPid = Number(readFileSync(join(repo, "pid.txt"), "utf8"));
      assert.ok(await until(() => !alive(testPid), 10_000), "the process of the hung test file is gone");
    } finally {
      killTree(running.child.pid);
      if (testPid) killTree(testPid);
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe("two runs in one checkout", () => {
  test("a run waits for one that is going, says so, and goes on when it has finished", async () => {
    const { repo, start, tag } = smallRepo();
    const folder = liveRunFolder(tag, { "a.txt": "original\n" });
    // The first message at once and one again every OA_MUTATE_MESSAGE_MS; the real wait is a minute between messages and three hours at most.
    const second = start([], { OA_MUTATE_POLL_MS: "100", OA_MUTATE_MESSAGE_MS: "400" });
    try {
      assert.ok(await until(() => (second.output().match(/WAITING/g) ?? []).length >= 2, 60_000), `it said it was waiting, more than once:\n${second.output()}`);
      assert.doesNotMatch(second.output(), /killed|LEFT ALONE/, "and it planted nothing while the other run was going");
      assert.equal(readFileSync(join(repo, "a.txt"), "utf8"), "original\n");
      rmSync(folder, { recursive: true, force: true }); // the other run has finished
      const { out, status, timedOut } = await second.finished(60_000);
      assert.equal(timedOut, false, out);
      assert.match(out, /killed\s+a fault/);
      assert.equal(status, 0);
    } finally {
      killTree(second.child.pid);
      rmSync(folder, { recursive: true, force: true });
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("it gives up after the longest wait, in words, and touches nothing", async () => {
    const { repo, start, tag } = smallRepo();
    const folder = liveRunFolder(tag, { "a.txt": "original\n" });
    const second = start([], { OA_MUTATE_POLL_MS: "100", OA_MUTATE_WAIT_LIMIT_MS: "1500" });
    try {
      const { out, status, timedOut } = await second.finished(60_000);
      assert.equal(timedOut, false, out);
      assert.match(out, /GAVE UP/);
      assert.match(out, /--allow-overlap/);
      assert.equal(status, 2);
      assert.doesNotMatch(out, /killed/);
      assert.equal(readFileSync(join(repo, "a.txt"), "utf8"), "original\n");
      assert.ok(existsSync(folder), "the other run's folder is not touched");
      assert.deepEqual(readdirSync(originalsRoot).filter((name) => name.startsWith(`${tag}-`) && !name.endsWith(`-${process.pid}`)), [], "and the waiting run's own folder is gone");
    } finally {
      killTree(second.child.pid);
      rmSync(folder, { recursive: true, force: true });
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("two runs that wait for a third do not wait for each other", async () => {
    const { repo, start, tag } = smallRepo();
    const folder = liveRunFolder(tag, { "a.txt": "original\n" });
    const timing = { OA_MUTATE_POLL_MS: "100", OA_MUTATE_MESSAGE_MS: "400", OA_MUTATE_WAIT_LIMIT_MS: "50000" };
    const first = start([], timing);
    const second = start([], timing);
    try {
      assert.ok(
        await until(() => /WAITING/.test(first.output()) && /WAITING/.test(second.output()), 60_000),
        `both said they were waiting:\n${first.output()}\n${second.output()}`,
      );
      rmSync(folder, { recursive: true, force: true });
      const [a, b] = await Promise.all([first.finished(90_000), second.finished(90_000)]);
      for (const one of [a, b]) {
        assert.equal(one.timedOut, false, one.out);
        assert.doesNotMatch(one.out, /GAVE UP/, "neither waited for the other until it gave up");
        assert.match(one.out, /killed\s+a fault/);
        assert.equal(one.status, 0, one.out);
      }
      assert.equal(readFileSync(join(repo, "a.txt"), "utf8"), "original\n");
    } finally {
      killTree(first.child.pid);
      killTree(second.child.pid);
      rmSync(folder, { recursive: true, force: true });
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe("the script that runs every list", () => {
  const killed = { ...oneFault };
  const survives = { label: "a fault nothing notices", file: "a.txt", from: "original", to: "ORIGINAL", tests: ["t.test.mjs"] };
  const lists = { "tools/release/mutations-a.json": JSON.stringify([killed]), "tools/release/mutations-b.json": JSON.stringify([survives, killed]) };

  test("--list names every list with its number of faults and runs nothing", () => {
    const { repo, script } = smallRepo({ files: lists });
    try {
      const { out, status } = script("mutate-all.mjs", "--list");
      assert.match(out, /mutations-a\.json\s+1 fault\b/);
      assert.match(out, /mutations-b\.json\s+2 faults\b/);
      assert.match(out, /would run 2 lists, 3 faults/);
      assert.doesNotMatch(out, /killed|SURVIVED/);
      assert.equal(status, 0);
      assert.ok(!existsSync(join(repo, "ran.txt")), "no test was run");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("it runs each list through the runner, one after another, and prints a total", () => {
    const { repo, script } = smallRepo({ files: lists });
    try {
      const { out, status } = script("mutate-all.mjs");
      assert.match(out, /killed\s+a fault\b/);
      assert.match(out, /SURVIVED\s+a fault nothing notices/);
      assert.match(out, /mutations-a\.json\s+1 of 1 killed\s+ok/);
      assert.match(out, /mutations-b\.json\s+1 of 2 killed\s+1 problem/);
      assert.match(out, /total: 3 faults in 2 lists, 2 killed, 1 list with problems/);
      assert.equal(status, 1, "a list with a problem is a failure of the whole");
      assert.equal(readFileSync(join(repo, "a.txt"), "utf8"), "original\n");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("--check goes through to each list", () => {
    const { repo, script } = smallRepo({ files: lists });
    try {
      const { out, status } = script("mutate-all.mjs", "--check");
      assert.match(out, /every fault applies/);
      assert.match(out, /total: 3 faults in 2 lists checked, 0 lists with problems/);
      assert.equal(status, 0);
      assert.ok(!existsSync(join(repo, "ran.txt")), "no test was run");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe("the lists of this repository", () => {
  test("every fault of every list applies, in one place, with its tests there (mutate.mjs --check)", () => {
    const names = readdirSync(releaseDir).filter((name) => /^mutations-.+\.json$/.test(name));
    assert.ok(names.length > 0, "there are lists");
    for (const name of names) {
      const result = spawnSync(process.execPath, [runner, join(releaseDir, name), "--check"], { encoding: "utf8", env: cleanEnv(), timeout: 120_000 });
      assert.equal(result.status, 0, `${name}:\n${result.stdout}${result.stderr}`);
    }
  });
});
