/**
 * The item statistics held to R through the shared item-analysis test set (C3), which lives in openstage-core and is not copied here.
 *
 * The set is a folder of scored classes with R's figures for each, and PrismStatistics runs the same set, so the two tools agree with R
 * and not merely with each other. Its own checker, `testsets/item-analysis/check/check_openassess.mjs`, loads `sheets/stats.ts` from
 * this repository and compares every figure within half a unit in the fourth place. This test runs that checker when the core is on the
 * machine (`OPENSTAGE_CORE`, or a folder `openstage-core` beside this repository) and says it was skipped when it is not, like the
 * publisher fixtures. It also runs the checker against a copy of R's figures with one changed, and needs it to fail, so a checker that
 * stopped looking would not pass for one that agrees.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { POINT_BISERIAL_LABEL, SD_LABEL } from "../src/sheets/stats.ts";

const repo = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
export const coreFolder = (): string | undefined => {
  const candidates = [process.env.OPENSTAGE_CORE, join(repo, "..", "openstage-core")].filter((c): c is string => !!c);
  return candidates.find((c) => existsSync(join(c, "testsets", "item-analysis", "reference.json")));
};
const core = coreFolder();
const checker = core ? join(core, "testsets", "item-analysis", "check", "check_openassess.mjs") : "";
const runChecker = (...more: string[]) => spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", checker, "--assess", repo, ...more], { encoding: "utf8", cwd: join(core ?? repo, "testsets", "item-analysis") });

describe("item statistics against the shared test set (C3)", () => {
  test("every figure matches R", { skip: core ? false : "openstage-core is not on this machine (set OPENSTAGE_CORE to its folder)" }, () => {
    const r = runChecker();
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    assert.match(r.stdout, /OpenAssess/);
    assert.doesNotMatch(r.stdout, /FAIL|differ/i);
  });

  test("the checker fails when one of R's figures is changed", { skip: core ? false : "openstage-core is not on this machine" }, () => {
    const ref = JSON.parse(readFileSync(join(core as string, "testsets", "item-analysis", "reference.json"), "utf8"));
    const first = Object.values(ref.cases)[0] as { test: { mean: number } };
    first.test.mean += 0.01;
    const dir = mkdtempSync(join(tmpdir(), "openassess-c3-"));
    try {
      writeFileSync(join(dir, "reference.json"), JSON.stringify(ref));
      const r = runChecker("--reference", join(dir, "reference.json"));
      assert.notEqual(r.status, 0, r.stdout);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the correlation and the standard deviation are named so they cannot be taken for PrismStatistics's figures", () => {
    // The labels the set's README asks each tool to show.
    assert.equal(POINT_BISERIAL_LABEL, "Point-biserial (total includes the question)");
    assert.match(SD_LABEL, /divided by the number of sheets/);
    const ui = readFileSync(join(repo, "packages", "app", "ui", "scoring.js"), "utf8");
    assert.ok(ui.includes(POINT_BISERIAL_LABEL), "the app's table names the correlation the same way");
    assert.ok(ui.includes("of this class, divided by the number of sheets"));
  });
});
