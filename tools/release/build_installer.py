#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
"""Makes the OpenAssess installer for a release, on this computer.

  python -I tools/release/build_installer.py --node NODE            build the setup file (not signed), carrying the Node named
  python -I tools/release/build_installer.py --node NODE --sign     build it and sign every program of ours in it, and the setup itself
  python -I tools/release/build_installer.py --check SETUP          only check a setup made before: signatures, and no folder names of
                                                                    this computer

NODE is the node.exe to carry inside the installer (24.22.3 or later; `packages/app/shell/prepare.mjs` refuses an older one). Without
--node, OPENASSESS_NODE is used, and without that, the Node on the path.

What it does, in order:
  1. gathers the app's files and the Node into packages/app/shell/src-tauri/resources (prepare.mjs);
  2. builds the window and the installer with Tauri's build (packages/app/shell). The window is given --remap-path-prefix for the user
     folder, the Rust folders and this repository, and the linker is told to name the debug file by its name alone, so no folder name
     of this computer is written into it. It gets RELEASE (below) as OPENASSESS_RELEASE, which Check for updates compares with the
     published releases;
  3. checks the window for the user folder's name (as text and as UTF-16, either kind of slash), and stops if it is there;
  4. checks Tauri's installer script: the web view's setup must be inside the installer, never downloaded while installing;
  5. with --sign: Tauri signs, through its sign command (sign_windows.py, beside this file), the window, the installer's plugins, the
     uninstaller and the setup. Then the setup is unpacked with 7-Zip and every program in it, and the setup, must be signed and
     timestamped by the same publisher (OPENSTAGE_SIGN_PUBLISHER, when it is set). The Node and the web view's setup keep their makers'
     signatures, which must be valid;
  6. copies the setup to dist/release/, with its SHA-256 in a .sha256.txt beside it (`<hash> *<name>`, as tools/release/README.md says).

The signing account comes from the environment (the top of sign_windows.py says which variables); nothing about it is written into the
repository. tools/release/README.md says how a release is made with it.
"""

import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import tomllib
from pathlib import Path

# The release this build is. Raise it for every release: Check for updates compares it with the newest published tag.
RELEASE = "0.1.0-alpha.26"

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent
SHELL = REPO / "packages" / "app" / "shell"
TAURI = SHELL / "src-tauri"
APP_EXE = TAURI / "target" / "release" / "openassess-shell.exe"
NSIS_SCRIPT = TAURI / "target" / "release" / "nsis" / "x64" / "installer.nsi"
BUNDLE = TAURI / "target" / "release" / "bundle" / "nsis"
DIST = REPO / "dist"  # not in the repository
SIGN_SCRIPT = HERE / "sign_windows.py"
SEVEN_ZIP = Path(os.environ.get("OPENSTAGE_7ZIP", r"C:\Program Files\7-Zip\7z.exe"))
PROGRAM_FILES = (".exe", ".dll")
# Programs in the setup that their makers sign, which are never signed here: the Node that runs the app (the OpenJS Foundation's), and
# the web view's setup, carried for a computer without the web view (Microsoft's).
MAKERS_FILES = {"node.exe": "OpenJS Foundation", "microsoftedgewebview2setup.exe": "Microsoft"}


def say(text):
    print(text, flush=True)


def fail(text):
    say("STOPPED: " + text)
    sys.exit(1)


def folder_flags(crate):
    """The flags the window's build is given: the crate's own (a .cargo/config.toml, which an environment setting would otherwise replace),
    one --remap-path-prefix for each folder whose name should not be written into the program, and the linker's /PDBALTPATH, so the debug
    file is named without its folder. When several prefixes match, rustc takes the last, so the broadest (the user folder) comes first and
    the repository last. Passed as CARGO_ENCODED_RUSTFLAGS, which keeps a space in a path whole."""
    flags = []
    config = Path(crate) / ".cargo" / "config.toml"
    if config.is_file():
        settings = tomllib.loads(config.read_text(encoding="utf-8"))
        flags += settings.get("target", {}).get("x86_64-pc-windows-msvc", {}).get("rustflags", []) or settings.get("build", {}).get("rustflags", [])
    home = Path.home()
    for folder, name in [
        (home, "/home"),
        (Path(os.environ.get("CARGO_HOME") or home / ".cargo"), "/cargo"),
        (Path(os.environ.get("RUSTUP_HOME") or home / ".rustup"), "/rustup"),
        (REPO, "/openassess"),
    ]:
        flags.append(f"--remap-path-prefix={folder}={name}")
    flags.append("-Clink-arg=/PDBALTPATH:%_PDB%")
    return flags


def build_environment(node, **more):
    env = {k: v for k, v in os.environ.items() if k not in ("RUSTFLAGS", "CARGO_ENCODED_RUSTFLAGS")}
    env["CARGO_ENCODED_RUSTFLAGS"] = "\x1f".join(folder_flags(TAURI))
    if node:
        env["OPENASSESS_NODE"] = str(node)
    env.update(more)
    return env


def personal_paths(files):
    """The files among `files` that name the builder's user folder (as text or as UTF-16, either kind of slash, any case), with what was found."""
    home = str(Path.home())
    needles = {home.lower(), home.replace("\\", "/").lower()}
    found = []
    for f in files:
        data = Path(f).read_bytes().lower()
        hits = [n for n in needles if n.encode("utf-8") in data or n.encode("utf-16-le") in data]
        if hits:
            found.append((Path(f), hits[0]))
    return found


def run(command, cwd, env=None):
    say("  > " + " ".join(str(c) for c in command))
    done = subprocess.run([str(c) for c in command], cwd=cwd, env=env, shell=False)
    return done.returncode


def tool(name):
    """A program on the PATH, such as npx: on Windows it is a .cmd file, which has to be named in full."""
    found = shutil.which(name)
    if not found:
        fail(f"{name} was not found. packages/app/shell/README.md says what building the window needs.")
    return found


def sign_config(dist):
    """Tauri's sign command for this build, in a file Tauri reads with --config: this Python runs sign_windows.py on each file Tauri signs."""
    config = {"bundle": {"windows": {"signCommand": {"cmd": sys.executable, "args": [str(SIGN_SCRIPT), "--description", "OpenAssess", "%1"]}}}}
    path = dist / "signing" / "tauri-sign.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(config, indent=1) + "\n", encoding="utf-8")
    return path


def signatures(paths):
    sys.path.insert(0, str(SIGN_SCRIPT.parent))
    import sign_windows  # noqa: E402  (beside this file)
    return sign_windows.signatures(paths), sign_windows


def check_setup(setup):
    """Unpack the setup and check it and every program in it: ours signed, timestamped and all by the setup's own signer (or
    OPENSTAGE_SIGN_PUBLISHER), the makers' files validly signed by their makers, and no folder name of this computer in any of them.
    Returns the problems found."""
    setup = Path(setup).resolve()
    if not SEVEN_ZIP.is_file():
        return [f"7-Zip is not at {SEVEN_ZIP} (set OPENSTAGE_7ZIP), so the programs inside the setup could not be checked"]
    with tempfile.TemporaryDirectory(prefix="openassess-setup-check-") as d:
        d = Path(d)
        done = subprocess.run([str(SEVEN_ZIP), "x", "-y", f"-o{d}", str(setup)], capture_output=True, text=True, encoding="utf-8", errors="replace")
        if done.returncode != 0:
            return ["7-Zip could not unpack the setup: " + (done.stdout + done.stderr).strip()[-400:]]
        inside = sorted(p for p in d.rglob("*") if p.is_file() and p.suffix.lower() in PROGRAM_FILES)
        problems = [f"{p.relative_to(d).as_posix()} names this computer's user folder" for p, _ in personal_paths(inside)]
        if not any(p.name.lower() == "node.exe" for p in inside):
            problems.append("the setup carries no node.exe")
        found, sw = signatures([setup, *inside])
        publisher = os.environ.get("OPENSTAGE_SIGN_PUBLISHER") or found[0]["signer"]
        ours, theirs = [], []
        for info in found:
            name = Path(info["path"]).name
            where = "the setup file" if Path(info["path"]) == setup else Path(info["path"]).relative_to(d).as_posix()
            maker = MAKERS_FILES.get(name.lower())
            if maker:
                # Signed by its maker, and only checked to be validly signed, by that maker.
                if info["status"] != "Valid":
                    problems.append(f"{where}: its maker's signature is {info['status']}")
                elif maker not in (info["signer"] or ""):
                    problems.append(f"{where}: signed by {info['signer']}, not by {maker}")
                theirs.append(f"{name} (by {info['signer']})")
                continue
            why = sw.problem(info, publisher)
            if why:
                problems.append(f"{where}: {why}")
            ours.append(name)
        say(f"  {setup.name}: {len(ours)} files signed by {publisher} (the setup and {', '.join(ours[1:])}); kept their makers' signatures: {', '.join(theirs) or 'none'}")
        return problems


def webview_mode(script):
    """How Tauri's installer script gets the web view's setup: the value of `!define INSTALLWEBVIEW2MODE`. The script also holds the lines for
    the other modes, each inside an `!if` on this value, so only the value says what the installer does."""
    for line in script.splitlines():
        parts = line.strip().split(None, 2)
        if len(parts) == 3 and parts[0] == "!define" and parts[1] == "INSTALLWEBVIEW2MODE":
            return parts[2].strip().strip('"')
    return None


def value_after(argv, flag):
    if flag not in argv:
        return None
    at = argv.index(flag)
    if at + 1 >= len(argv):
        fail(f"{flag} needs a value after it.")
    return argv[at + 1]


def main(argv):
    if "--check" in argv:
        problems = check_setup(value_after(argv, "--check"))
        for p in problems:
            say("  PROBLEM " + p)
        say("PASSED" if not problems else f"{len(problems)} problems")
        return 1 if problems else 0
    sign = "--sign" in argv
    node = value_after(argv, "--node") or os.environ.get("OPENASSESS_NODE")
    if node and not Path(node).is_file():
        fail(f"the Node to carry is not there: {node}")
    say(f"OpenAssess {RELEASE}: building the installer{' and signing it' if sign else ''}.")
    if sign:
        sys.path.insert(0, str(SIGN_SCRIPT.parent))
        import sign_windows
        try:
            sign_windows.settings()
            sign_windows.find_signtool()
            sign_windows.find_dlib()
        except sign_windows.SignError as e:
            fail("signing is not ready: " + str(e))

    env = build_environment(node, OPENASSESS_RELEASE=f"v{RELEASE}")
    say("1. The app's files and the Node it runs on.")
    if run([tool("node"), "prepare.mjs"], SHELL, env) != 0:
        fail("the files were not gathered. What prepare.mjs said is above.")

    say("2. The window, and the installer.")
    for old in BUNDLE.glob("*.exe") if BUNDLE.is_dir() else []:
        old.unlink()
    command = [tool("npx"), "tauri", "build"]
    if sign:
        command += ["--config", str(sign_config(DIST))]
    if run(command, SHELL, env) != 0:
        fail("the installer was not made. What Tauri said is above.")
    setups = sorted(BUNDLE.glob("*.exe"))
    if len(setups) != 1:
        fail(f"expected one setup file in {BUNDLE}, found {len(setups)}.")
    setup = setups[0]

    say("3. Checks.")
    named = personal_paths([APP_EXE])
    if named:
        fail("the window names this computer's user folder: " + "; ".join(f"{p.name} ({hit})" for p, hit in named))
    say("  the window does not name this computer's user folder")
    script = NSIS_SCRIPT.read_text(encoding="utf-8", errors="replace") if NSIS_SCRIPT.is_file() else ""
    if not script:
        fail(f"Tauri's installer script was not found at {NSIS_SCRIPT}.")
    mode = webview_mode(script)
    if mode not in ("embedBootstrapper", "offlineInstaller"):
        fail(f"the installer would get the web view's setup by {mode or 'an unknown way'}, which downloads it while installing. tauri.conf.json must embed it.")
    say(f"  the installer carries the web view's setup ({mode}); it downloads nothing")
    if sign:
        problems = check_setup(setup)
        if problems:
            fail("the signed setup did not pass: " + "; ".join(problems))
        say("  the setup and every program of ours in it are signed and timestamped, and the makers' files keep their makers' signatures")

    out = DIST / "release"
    out.mkdir(parents=True, exist_ok=True)
    final = out / setup.name
    shutil.copy2(setup, final)
    digest = hashlib.sha256(final.read_bytes()).hexdigest()
    (out / (final.name + ".sha256.txt")).write_text(f"{digest} *{final.name}\n", encoding="utf-8", newline="\n")
    say(f"Done: {final} ({final.stat().st_size:,} bytes)\n  SHA-256 {digest}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
