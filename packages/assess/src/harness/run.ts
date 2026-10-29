/**
 * Running the harness over a folder of fixtures.
 *
 * A fixture is a source file plus a `.expected.json` beside it. A source file
 * with no expected file is reported rather than ignored, because a fixture
 * nobody scores is a fixture nobody maintains.
 *
 * Publisher chapters live in a local folder that is not committed, and the
 * harness reads it when it is there and skips it when it is not. That keeps
 * the repository clean without giving up the coverage.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

import { importerFor, IMPORTERS, runImporter } from "../import/registry.ts";
import { scoreFile, summarise, type ExpectedFile, type FileScore, type HarnessSummary } from "./score.ts";

export { IMPORTERS };

export interface HarnessRun extends HarnessSummary {
  /** Source files with no expected file beside them. */
  unscored: string[];
  missingSources: string[];
  directory: string;
  /** The directory could not be read at all. */
  directoryMissing: boolean;
}

export async function runHarness(directory: string): Promise<HarnessRun> {
  let names: string[];
  try {
    names = await readdir(directory);
  } catch {
    // A gate that cannot find its corpus has not passed; it has not run. The
    // caller is told so explicitly rather than being handed an empty summary
    // that scores zero out of zero and reads as success.
    return {
      ...summarise([]),
      unscored: [],
      missingSources: [],
      directory,
      directoryMissing: true,
    };
  }

  const expectedNames = names.filter((n) => n.endsWith(".expected.json"));
  const sourceNames = names.filter((n) => !n.endsWith(".expected.json") && !n.startsWith("."));

  const scores: FileScore[] = [];
  const unscored: string[] = [];
  const missingSources: string[] = [];

  for (const sourceName of sourceNames.sort()) {
    const fullPath = join(directory, sourceName);
    if ((await stat(fullPath)).isDirectory()) continue;

    const expectedName = `${sourceName}.expected.json`;
    if (!expectedNames.includes(expectedName)) {
      unscored.push(sourceName);
      continue;
    }

    const importer = importerFor(sourceName);
    if (!importer) {
      unscored.push(sourceName);
      continue;
    }

    // Bytes, not text: a .docx is not text, and the importer decides how to read its file.
    const bytes = await readFile(fullPath);
    const expected = JSON.parse(await readFile(join(directory, expectedName), "utf8")) as ExpectedFile;
    const result = runImporter(importer, bytes, { file: sourceName, at: "2026-01-01T00:00:00.000Z", author: "harness" });
    scores.push(scoreFile({ ...expected, file: sourceName }, result));
  }

  for (const expectedName of expectedNames) {
    const sourceName = expectedName.slice(0, -".expected.json".length);
    if (!sourceNames.includes(sourceName)) missingSources.push(sourceName);
  }

  return { ...summarise(scores), unscored, missingSources, directory, directoryMissing: false };
}

/**
 * The gate the first release has to pass. Called by the test suite so that a
 * drop in the score fails the build rather than being noticed later.
 */
export const TARGET_SCORE = 0.95;
