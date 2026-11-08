/**
 * The runner that plants faults (tools/release/mutate.mjs) is held to what it promises, on a small repository of its own.
 *
 * Two readers who ran it in one afternoon found that it kept the originals of every run in one folder for the machine, so that a run
 * started while another was alive took the other's saved files for the leavings of a killed run and wrote them into the repository.
 * The tool that says "every planted fault was caught" is not allowed to be the thing that spoils a result, so its own behaviour is
 * tested here: the originals of a run that is alive are left alone, those of a run that is gone are put back, and a fault that the
 * tests notice is reported as killed with the file as it was.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const runner = resolve(here, "../../../tools/release/mutate.mjs");
const originalsRoot = join(tmpdir(), "openassess-mutate-originals");

/** A repository of one file and one test, with the runner copied in where it will look for its repository. */
function smallRepo(): { repo: string; run: (...args: string[]) => { out: string; status: number | null }; tag: string } {
  const repo = resolve(mkdtempSync(join(tmpdir(), "oa-mutate-test-")));
  mkdirSync(join(repo, "tools", "release"), { recursive: true });
  copyFileSync(runner, join(repo, "tools", "release", "mutate.mjs"));
  writeFileSync(join(repo, "a.txt"), "original\n");
  writeFileSync(
    join(repo, "t.test.mjs"),
    `import test from "node:test";\nimport { readFileSync } from "node:fs";\ntest("a.txt is not faulty", () => {\n  if (readFileSync(new URL("./a.txt", import.meta.url), "utf8").includes("FAULT")) throw new Error("faulty");\n});\n`,
  );
  writeFileSync(join(repo, "spec.json"), JSON.stringify([{ label: "a fault", file: "a.txt", from: "original", to: "FAULT", tests: ["t.test.mjs"] }]));
  // Inside this test run the variable that makes a test process report to its parent is set, and the runner's own test run would then
  // print nothing it can count.
  const env = { ...process.env };
  delete env["NODE_TEST_CONTEXT"];
  const run = (...args: string[]) => {
    const result = spawnSync(process.execPath, [join(repo, "tools", "release", "mutate.mjs"), join(repo, "spec.json"), ...args], { encoding: "utf8", cwd: repo, timeout: 120_000, env });
    return { out: `${result.stdout}${result.stderr}`, status: result.status };
  };
  const tag = createHash("sha1").update(repo.toLowerCase()).digest("hex").slice(0, 12);
  return { repo, run, tag };
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

  test("the originals of a run that is still alive are left alone, and not written into the repository", () => {
    const { repo, run, tag } = smallRepo();
    // This process is alive, so a folder named for it is the folder of a run that is going.
    const folder = join(originalsRoot, `${tag}-${process.pid}`);
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, `${Buffer.from("a.txt").toString("hex")}.orig`), "SAVED BY ANOTHER RUN\n");
    try {
      const { out } = run();
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
