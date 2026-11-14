# Check for updates

Since 0.1.0 alpha 26, OpenAssess has **Help > Check for updates...**. It follows the pattern every tool of the suite uses for this
button.

## What it does

* **Only when chosen.** Nothing is checked at start-up or on a timer, and nothing runs in the background.
* **Notify only.** It says whether a newer release is published and, if so, links to that release's page on GitHub (what changed, the
  checksum, the signed setup). It downloads and installs nothing. Running the new setup updates the copy in place and keeps the banks.
* **Where it looks.** One HTTPS request, made by the app's own server, to
  `https://api.github.com/repos/jasonswrench-beep/openstage-assess/releases?per_page=30`. Node checks the certificate. No redirect is
  followed, at most 2 MB is read, and it gives up after 15 seconds. Pre-releases count, because every release so far is one; drafts
  never do. The request carries only a plain user agent (`OpenAssess-update-check`). Nothing about the person, their banks or their
  computer is sent.
* **What it compares.** The installed copy's exact release with the highest published tag (`vMAJOR.MINOR.PATCH`, or that with
  `-alpha.N`, `-beta.N` or `-rc.N`; a release sorts after its own pre-releases). The release is recorded when the window is built:
  `RELEASE` in `tools/release/build_installer.py` becomes `OPENASSESS_RELEASE`, which the window passes to the server as `--release`.
  Raise it for every release. A copy not made by the setup (the browser version, or a build made another way) is told which release
  is the newest.
* **Links.** Only a page of OpenAssess's releases (the list, or `.../releases/tag/v...`) is ever offered. The server builds the address,
  the page checks it again before showing it as a plain link, and the window opens it in the person's own browser and never inside
  itself. A browser opens it in a new tab.
* **Turning it off.** Set `OPENSTAGE_UPDATE_CHECK=off` in the environment, or put a file `update-check.txt` that says `off` beside
  `openassess-shell.exe` (the way an IT department turns it off for the copies it installs). `--no-update-check` does the same for
  the browser version. The answer then says that checking is turned off on this computer, and nothing is asked of the network.
* **Signing.** No update-signing key is needed, because nothing is installed automatically. The setup itself is signed with the
  publisher's code-signing certificate, and the release page carries its SHA-256.

## Code and tests

* `packages/app/src/updates.ts`: the comparison, the request and the answers. The route is `POST /api/updates/check` in
  `packages/app/src/api.ts`. It is a POST, so it needs the page's key and header like any other action. `--release` and
  `--no-update-check` are handled in `packages/app/src/main.ts`.
* `packages/app/ui/updates.js` and the Help menu in `packages/app/ui/frame.js`: the dialog, which shows the answer as text.
* `packages/app/shell/src-tauri/src/main.rs`: the release passed to the server, the switch, and the opening of a release page in the
  browser (`is_release_page`).
* `packages/app/test/updates.test.ts` covers the comparison, the answers, the links, the switch and the route. Nothing in it reaches the
  network except two tests that run only with `OPENASSESS_NETWORK_TESTS=1`: one reads the real list, and one checks that a redirect is
  refused. `cargo test` in `packages/app/shell/src-tauri` covers the window's address rules.
