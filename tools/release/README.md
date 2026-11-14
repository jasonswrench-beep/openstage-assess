# Cutting a pre-release

These are the checks that stand between a commit and a Windows installer other people download. They were kept in a scratch folder
for the first nineteen pre-releases; they are here so that the process does not depend on one computer's temporary files.

Every command is run from the root of the repository unless the step says where, on a Windows computer with Node 22.6 or later (the
commands are written for Git Bash; PowerShell is named where it differs).

## Before the build

1. `git pull`, and have a clean tree (`git status` shows nothing) with `HEAD` equal to the remote's main branch (`git fetch`, then
   `git rev-parse HEAD origin/main` shows one hash twice). The tag will point at that exact commit.
2. `npm test` passes (it runs the engine's tests and the app's), and the type checks are clean: `npm run typecheck` checks the engine
   and the app, and the app twice (its interface as well, with `-p tsconfig.ui.json`). `typescript` and `@types/node` are dev
   dependencies of both packages and are not always installed in a checkout: `npm install` provides them (TypeScript 6). Without them,
   run any TypeScript 5.9 or later in each package folder (the checks here were also run with 5.9.3) and point it at a folder that has
   `@types/node`: `node <somewhere>/node_modules/typescript/bin/tsc --noEmit --typeRoots <somewhere>/node_modules/@types`, and in
   `packages/app` the same again with `-p tsconfig.ui.json`.
3. The gates, from `packages/assess` (the CLI's relative paths are relative to there):
   - `node --experimental-strip-types --no-warnings src/cli/index.ts score` (the import gate, 95 percent or better)
   - `... score ../../fixtures/publisher` and `... score ../../fixtures/publisher/pdf` when those private folders are on the machine
   - `... sheets gate` (no answer read wrong without a flag) and `... perf` (the speed budget)
   - `OPENASSESS_FUZZ_ROUNDS=6000 node --experimental-strip-types --no-warnings --test test/fuzz-import.test.ts`, a long damaged-file
     run (no crash). In PowerShell set the variable first: `$env:OPENASSESS_FUZZ_ROUNDS = "6000"`.
4. If the Word reader, the formatting or the tables changed: the `check:word-*` commands in `CLAUDE.md`, which need Word.
5. Plant each new fault, one at a time, in the code just written, and see a test fail for the right reason: write the faults of the
   release as a new list in this folder (`mutations-alpha-N-<name>.json`), run `node tools/release/mutate.mjs <list> --check` on it
   (a second, writes nothing), then the list itself, and after every merge `node tools/release/mutate-all.mjs`, which runs every list
   (a merge can quietly undo a test's bite). All of it, what the words it prints mean and how long it takes, is under "Planting
   faults" below. One fault is left out of the lists because it changes nothing: a width in a cross-reference stream above 8, since a
   width that large is longer than the data and the loop never runs. Each round of readers has found more than a dozen faults that the
   tests of the round before missed; the way to find the rest is to do this before they do.
6. Run both suites on a FRESH CLONE (`git clone` into an empty folder, then `npm test` there, or the `node --test` commands of each
   package's `test` script). A checkout on Windows makes every file CRLF, and three tests that matched text across lines failed on a
   fresh clone for months without anyone seeing it, because the working copy here is LF. Files in the private fixtures folders are not
   in a clone, so those tests skip.
7. The sweeps over real files (a folder of PDFs, Word files, spreadsheets, zips): read them again and compare file by file with the
   last release's, so that no real file reads differently; only the readers' own time limits (each file in its own process) are needed.

## Build and check the installer

1. In `packages/app/shell`: `npm install` (once; the shell is not part of the npm workspaces, so installing the repository does not
   fetch it). Then, from the root of the repository, raise `RELEASE` at the top of `tools/release/build_installer.py` to this
   release, and run `python -I tools/release/build_installer.py --node <node.exe> --sign`. `<node.exe>` is the Node to carry,
   24.22.3 or later (`prepare.mjs` refuses an older one); use the official Windows build, signed by the OpenJS Foundation. It needs
   Rust with the `x86_64-pc-windows-msvc` toolchain, the Visual Studio C++ build tools, the WebView2 runtime
   (`packages/app/shell/README.md` has the list), 7-Zip, and for `--sign` the signing account in the environment (the top of
   `tools/release/sign_windows.py` names the variables; set `OPENSTAGE_SIGN_PUBLISHER` to the name the signature must show).
   It takes a few minutes. It builds the window with this computer's folder names mapped out of it, stops if the window still
   names the user folder, stops unless the installer carries the web view's setup, signs the window, the installer's plugins,
   the uninstaller and the setup, unpacks the setup and checks every program in it (ours signed and timestamped by the publisher,
   `node.exe` and the web view's setup by their makers), and copies the setup and its SHA-256 file to `dist/release`. Without
   `--sign` it does the same and signs nothing. `python -I tools/release/build_installer.py --check <setup>` checks a setup
   made before.
2. `node tools/release/compare-installer-files.mjs`: every file in the folder the installer is built from (`resources/app`, which the build gathers) must be identical to the
   committed one, and every committed file it is meant to carry must be there. If a code commit landed after the build, build again.
3. `node tools/release/smoke-installed.mjs`: starts the app with the Node and the files the installer carries and drives it as the
   window would. Every line must start with `ok`. Each release adds a block for what it changed; add yours. To try the script itself
   against the committed files before there is a build, run it with `OPENASSESS_SMOKE_SOURCE=1` (that says nothing about an installer;
   in PowerShell set `$env:OPENASSESS_SMOKE_SOURCE = "1"` first). It uses port 47321.
4. The SHA-256 file is written by the build, as `<hash> *<installer file name>`, the hash in lower case. To check it by hand:
   `(Get-FileHash -Algorithm SHA256 '<installer>').Hash.ToLower()` in PowerShell.

## Publish

- Tag `vX.Y.Z-alpha.N` (the app's version, with the next N while nobody has run this installer by hand), a pre-release titled
  "OpenAssess X.Y.Z alpha N", created with the GitHub command-line tool against the full commit hash (`--target`):
  `gh release create vX.Y.Z-alpha.N <setup .exe> <.sha256.txt> --prerelease --target <full hash> --title "OpenAssess X.Y.Z alpha N" --notes-file <notes>`.
  Never reuse or move a tag. Attach the setup `.exe` and its `.sha256.txt`, and nothing else.
- The notes are plain words: what was fixed, the two file names, the full SHA-256, the commit it was built from, who signed it (or
  that it is unsigned, and Windows may say "unknown publisher"), what was checked (counts, not adjectives), and what has NOT been
  tried. Do not say nobody has
  run an installer if earlier ones were run; say this exact installer was not. No em dashes.

## Afterwards

Download the installer back (`gh release download <tag> --dir <an empty folder>`) and check its hash against the local file and
against the `digest` GitHub shows for the asset, check that the tag points at the commit the installer was built from, that the
release is marked as a pre-release and not a draft (`gh release view <tag> --json isPrerelease,isDraft,assets`), and that the
repository's visibility is what it should be. Say what was checked. (The `gh` commands in this file were written from the tool's
documented options and have not been run on the computer where the rest was checked.)

Then have someone who did not write the new code read it. Every round of that so far found a real fault in the previous round's fixes.

## Planting faults

`tools/release/mutate.mjs` plants one fault at a time in a tracked file, runs the tests that should notice, and puts the file back byte
for byte. `tools/release/mutate-all.mjs` runs every list. The test of both is `packages/assess/test/mutate-runner.test.ts`, which runs
them on small repositories of its own. A tool that says "every planted fault was caught" must not say it falsely, and readers have
proved it could: an empty list said it, a killed run left a file changed and the next run passed, a run in one checkout wrote its files
into another, and the signal handlers it had never ran.

### The lists

A list is a JSON array in this folder, `mutations-*.json`, the faults planted in the fixes of one release. One entry:

```
{ "label": "what the fault is", "file": "packages/assess/src/x.ts", "from": "text to find", "to": "text to put there", "tests": ["packages/assess/test/x.test.ts"] }
```

- `from` must be in `file` **exactly once**. A `from` that is not there is NOT APPLIED (a fault that is not there proves nothing); one
  that is in two places is AMBIGUOUS, and so is a problem: the first would be replaced and nothing would say which, and the first is not
  always the one meant (five entries of the lists were like that, and one of them, labelled for the run-length decoder, had its fault
  in the ASCII85 decoder above it). Make `from` longer, with the lines around the place, until it is one place. An empty `from` and a
  `from` equal to `to` are problems too.
- A line end in `from` or `to` is written `\n` and fits the file's line ends (a Windows checkout has some files CRLF and some LF).
- `tests` are the test files that should fail. They are run with Node's test runner, in one process for the whole list of an entry.
- The number of tests is compared with the baseline. A fault that stops a test file from loading makes its tests vanish and nothing
  fails, so "fewer tests ran" is how a fault that broke the tests is told from one a test noticed (BROKE LOADING, a problem). The same
  line comes up when the code the fault is planted in makes a test list (tests made from a table or from the files of a folder) and the
  fault changes how long the table is: the count changes by itself, the runner cannot tell, it says BROKE LOADING and counts a
  problem, and the answer is to plant the fault so that the table keeps its length, or to leave that fault out of the list.

### Checking a list

`node tools/release/mutate.mjs <list> --check` says, for every entry, whether its fault would go in: NOT APPLIED, AMBIGUOUS, EMPTY FROM,
NO CHANGE, BAD ENTRY (a field missing), NO SUCH FILE, CANNOT READ, NO TEST FILE. It runs no test, plants nothing and writes nothing
(not even what a killed run left; a file that a run which is going has changed is read as that run found it, from the copy that run
keeps). It takes a second or two. Run it after writing a list and after any merge that moved code. `node tools/release/mutate-all.mjs
--check` does it for all the lists, and `mutate-runner.test.ts` does it in `npm test`, so a source file that has moved a `from` is seen
there. The run itself makes the same check of every entry before it plants anything, so a list that is wrong says so at once and not an
hour in.

### Running

```
node tools/release/mutate.mjs tools/release/mutations-alpha-22-pdf.json             # one list
node tools/release/mutate.mjs tools/release/mutations-alpha-22-pdf.json "ascii85:"   # only the entries whose label has this text
node tools/release/mutate-all.mjs          # every mutations-*.json here, one after another; a table and a total at the end
node tools/release/mutate-all.mjs --list   # which lists, and how many faults in each; runs nothing
```

A run: puts back what a run that is gone left (see below); waits for an older run of this checkout if one is going (see below); checks
every entry; runs each distinct set of tests once with nothing planted (the baseline); then for each fault writes the original
outside the repository, plants the fault, runs the tests (at most 10 minutes), reads the result, and puts the file back.

What it prints at the start of a line. Each of these counts as a problem and makes the exit code 1, except `killed`, `baseline`,
`RESTORED`, `LEFT ALONE`, `WAITING` (and `BASELINE FAILS`, whose faults are counted one by one as `SKIPPED`):

| word | meaning |
| --- | --- |
| `killed` | a test failed with the fault in. This is the good result. |
| `SURVIVED` | the tests passed with the fault in. A test is missing or too weak. |
| `BROKE LOADING` | a different number of tests ran than in the baseline, which is not a test noticing the fault (see the lists above). |
| `TIMED OUT` | the tests did not finish within 10 minutes with the fault in. Its test run and everything it started is stopped. |
| `NOT APPLIED`, `AMBIGUOUS`, `EMPTY FROM`, `NO CHANGE`, `BAD ENTRY`, `NO SUCH FILE`, `CANNOT READ`, `NO TEST FILE` | the entry is wrong; nothing was planted for it. |
| `BASELINE FAILS` | the tests fail (or time out) before anything is planted. Every fault that needs them is then named `SKIPPED` and counted. |
| `RESTORED`, `NOT RESTORED` | a file that a run which was killed left changed was put back (or could not be). |
| `LEFT ALONE`, `WAITING`, `GAVE UP` | another run in this checkout; see "Two runs at once". |
| `STOPPED` | a signal ended the run. |

The last line is `every planted fault was caught (N)` or `N problem(s): see the lines above (planted, killed)`. The exit code:

- **0**: every planted fault was caught.
- **1**: a problem (a line counted as one in the table).
- **2**: nothing was planted because of how it was started: no list, a list that cannot be read or is not an array, **an empty list, a
  label filter that matches nothing** (the first version said "every planted fault was caught" and exited 0 for both), or a wait that
  was given up. With `--check` the same words say that nothing was checked.
- **130**: stopped by a signal.

### When it is stopped or killed

The original of every file is kept outside the repository, in `openassess-mutate-originals/<hash of the repository's path>-<process
id>/` in the temporary folder, before the file is changed. The runner is asynchronous (the test run is a child process it waits for
without blocking), so its signal handlers do run:

- On Ctrl-C, Ctrl-Break, closing the console window or a terminate signal (SIGINT, SIGBREAK, SIGHUP, SIGTERM) it stops the test run in
  flight and everything that run started (on Windows with `taskkill /T /F`, since `node --test` starts a process for each test file),
  puts every changed file back, removes its folder, prints `STOPPED` and exits 130. A first version waited for the tests in a call that
  does not return until they end, so a handler could never run, and by being installed it stopped Ctrl-C and Ctrl-Break from ending the
  process at all: the rest of the list was planted after the key was pressed.
- A kill that gives it no chance (End Task, `taskkill /F`, `Stop-Process`, a power cut) puts nothing back. On Windows the test run it
  started ends with it (Node's children do); elsewhere the run is left to end by itself. The next run of this checkout puts the files
  back before it does anything (`RESTORED`), because it finds the folder of a process that is gone. A process number can be taken by
  another program after a crash; a folder whose number is running is taken for a run that is going and is not touched (see below).
- Windows lets `GenerateConsoleCtrlEvent` send only Ctrl-C and Ctrl-Break, and Node cannot send a signal to a process on Windows (the
  call ends the process), so `mutate-runner.test.ts` reaches the same function through a hook: with `OA_MUTATE_TEST_SIGNAL` set to a
  file name, the runner takes the path a SIGINT takes when that file exists while a test run is in flight. The real keys were tried by
  hand on Windows, with `powershell -NoProfile -ExecutionPolicy Bypass -File tools\release\check-ctrl-break.ps1` (Ctrl-Break) and
  the same with `-CtrlC` at the end (Ctrl-C): it makes a small repository of its own in the temporary folder, starts the runner on it
  with a fault in, sends the key to the runner's console, and says whether the runner ended with 130, the file is back, no folder is
  left and no process is left. Run it after any change to how `mutate.mjs` handles a signal. SIGTERM and SIGHUP are handled the same
  way and have not been sent for real.
- The other settings the test uses are `OA_MUTATE_TIME_LIMIT_MS`, `OA_MUTATE_WAIT_LIMIT_MS`, `OA_MUTATE_POLL_MS` and
  `OA_MUTATE_MESSAGE_MS`. Do not set any of them for a real run.

### Two runs at once

Two runs in one checkout spoil each other: the second one's baseline has the first one's fault in it, and the first one's file is put
back under it. Each run keeps its own folder of originals, so nothing is written into the wrong file, but the results are still wrong.
So a run that finds an older run of this checkout going (a folder of the same repository whose process is running) **waits for it**:
it says `WAITING` at once and once a minute after, and goes on when the folder is gone or its process has ended. After three hours it
gives up (`GAVE UP`, exit 2) and plants nothing. Two runs that are both waiting do not wait for each other: the older folder goes
first. `--allow-overlap` does not wait (it says `LEFT ALONE` and goes on); use it only for runs whose faults are in different files and
whose tests do not read each other's files, or when you know the process it names is not a run (a number taken by another program).
Two starts in the very same instant can both go. Runs in different checkouts (a worktree is one) do not meet: the folders are told apart
by the path of the repository, so a run in one never puts a file back into another. `mutate-all.mjs` never starts two runs at once.

### How long it takes

A reader who ran the six lists of alpha 20 to 22 timed them with three runs going at once on a busy machine: `mutations-alpha-22-pdf.json`
(69 faults) about 60 minutes, `-alpha-22-office.json` (57) about 55, `-alpha-22-banks.json` (40) about 40, `-alpha-22-readers.json` (47)
about 17, `-alpha-20.json` (27) about 7 and `-alpha-21-app.json` (18) about 4. One after another on a quiet machine they take less than the
sum (about three hours); the reader's estimate was about two hours, and `mutate-all.mjs` is built to be left running for that long. A
single fault is a few seconds to a minute, what its tests take to run. `-alpha-23-office.json` (12 faults) and
`-alpha-23-tools.json` (12 faults in `mutate.mjs`, each noticed by `mutate-runner.test.ts`, about a minute each) have not been
timed as lists. The 12 were each planted and killed one at a time in a copy of the runner (by a second copy, never by the runner on
itself), but the list has not been run as a list. It and `X12` of the office list plant faults in the runner's own file: the process
that does it has already read its source, and the test copies the planted file into a small repository of its own. One fault of the
same kind was left out because no test can tell it on Windows: a timed-out test run that is left running (the children of a Node
process end with it there, so the run ends when the runner does). Nobody has timed all eight lists in one go.
