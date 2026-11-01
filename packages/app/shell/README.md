# The OpenAssess window

A Tauri shell around the app. Everything OpenAssess does is done by its local server, which is
Node running the app's own code (`../src/main.ts`). This folder is only the window: it starts that
server, waits for it to say where it is listening, and points the window at it. It has no commands
for the page to call, and the page it shows is given no access to the machine beyond what the
server allows it.

It is **not part of the npm workspaces**, so installing the repository never fetches the Tauri
tools, and the engine and the app keep their rule of no third-party runtime dependencies. The
window is the one place that has them, and it is not needed to use OpenAssess: the browser
version runs with only Node installed (`Open OpenAssess.cmd`).

One thing the page cannot do for itself is ask where to save a file: the page's own save dialog
(`showSaveFilePicker`) is offered by the window and never opens. So the shell answers a download
of one of the app's own files, `/files/...` on its own server, with the system's Save dialog
(the `rfd` crate, on Windows). The page has no command for this: the shell shows the dialog when
the window starts a download, which is the one place a person asks for a file to be saved.

## What it needs to build

- Node.js (the same one the app runs on; a copy of it is carried inside the installer)
- Rust, with the `x86_64-pc-windows-msvc` toolchain, and the Visual Studio C++ build tools
- The Microsoft Edge WebView2 runtime (Windows 11 has it; where it is missing, Tauri's installer
  fetches Microsoft's bootstrapper for it)

## Building

```
cd packages/app/shell
npm install
npm run build:exe     # the window on its own: src-tauri/target/release/openassess-shell.exe
npm run build         # the installer too: src-tauri/target/release/bundle/nsis/
```

`prepare.mjs` runs first and gathers the app's source and a copy of the Node that is running it
into `src-tauri/resources`, which the build carries. The first build compiles a few hundred Rust
crates and takes several minutes. The first installer build downloads the NSIS tools from GitHub.

The icons in `src-tauri/icons` come from the app's own `ui/icon.svg`. To make them again, from this
folder: `npx tauri icon ../ui/icon.svg -o <an empty folder>`, then copy `32x32.png`, `128x128.png`,
`128x128@2x.png`, `icon.png` and `icon.ico` into `src-tauri/icons`. Look at them afterwards: a first
set was made from a picture that had failed to load and was a broken-image symbol in every size.

The setup file and the uninstaller have to be given the icon on their own: `installerIcon` and `uninstallerIcon` in
`tauri.conf.json`. `bundle.icon` reaches only the program, and without them Windows shows NSIS's own install icon on the
setup file. To see what Windows shows, extract the icon of the file with `System.Drawing.Icon.ExtractAssociatedIcon` and look
at it; a build that ran without an error says nothing about it.

## Finding out why a start went wrong

Set `OPENASSESS_SHELL_LOG` to a file name before starting the window, and every line the server
prints, with one line for each request it answers, is appended to that file. The keys never appear
in it: a request is logged without its query. A download is logged too: that one was asked for, the
place that was chosen for it, or that the Save dialog was closed.

The installer is not signed, so Windows will say that it does not know the publisher the first
time it is run. That is a decision for the person who publishes it (a signing certificate costs
money), not something the build can settle.
