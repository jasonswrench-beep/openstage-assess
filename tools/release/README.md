# Cutting a pre-release

These are the checks that stand between a commit and a Windows installer other people download. They were kept in a scratch folder
for the first nineteen pre-releases; they are here so that the process does not depend on one computer's temporary files.

## Before the build

1. Pull, and have a clean tree with `HEAD` equal to the remote's main branch. The tag will point at that exact commit.
2. `npm test` passes (engine and app), and the type checks are clean in `packages/assess`, in `packages/app` and in `packages/app`
   with `-p tsconfig.ui.json`. There is no compiler in this repository's dependencies on purpose; borrow one.
3. The gates, from `packages/assess` (the CLI's relative paths are relative to there):
   - `node --experimental-strip-types --no-warnings src/cli/index.ts score` (the import gate, 95 percent or better)
   - `... score ../../fixtures/publisher` and `... score ../../fixtures/publisher/pdf` when those private folders are on the machine
   - `... sheets gate` (no answer read wrong without a flag) and `... perf` (the speed budget)
   - `OPENASSESS_FUZZ_ROUNDS=6000 node --experimental-strip-types --no-warnings --test test/fuzz-import.test.ts`, a long damaged-file
     run (no crash)
4. If the Word reader, the formatting or the tables changed: the `check:word-*` commands in `CLAUDE.md`, which need Word.

## Build and check the installer

1. `npm run build` in `packages/app/shell`. It takes a few minutes and ends with the installer under `src-tauri/target/release/bundle`.
2. `node tools/release/compare-installer-files.mjs`: every file the installer gathered (`resources/app`) must be identical to the
   committed one, and every committed file it is meant to carry must be there. If a code commit landed after the build, build again.
3. `node tools/release/smoke-installed.mjs`: starts the app with the Node and the files the installer carries and drives it as the
   window would. Every line must start with `ok`. Each release adds a block for what it changed; add yours. To try the script itself
   against the committed files before there is a build, run it with `OPENASSESS_SMOKE_SOURCE=1` (that says nothing about an installer).
4. Write the SHA-256 file as `<hash> *<installer file name>`.

## Publish

- Tag `vX.Y.Z-alpha.N` (the app's version, with the next N while nobody has run this installer by hand), a pre-release titled
  "OpenAssess X.Y.Z alpha N", created with the GitHub command-line tool against the full commit hash (`--target`). Never reuse or
  move a tag. Attach the setup `.exe` and its `.sha256.txt`, and nothing else.
- The notes are plain words: what was fixed, the two file names, the full SHA-256, the commit it was built from, that it is unsigned
  (Windows may say "unknown publisher"), what was checked (counts, not adjectives), and what has NOT been tried. Do not say nobody has
  run an installer if earlier ones were run; say this exact installer was not. No em dashes.

## Afterwards

Download the installer back and check its hash against the local file and against the `digest` GitHub shows for the asset, check that
the tag points at the commit the installer was built from, that the release is marked as a pre-release and not a draft, and that the
repository's visibility is what it should be. Say what was checked.

Then have someone who did not write the new code read it. Every round of that so far found a real fault in the previous round's fixes.
