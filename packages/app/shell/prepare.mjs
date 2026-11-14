// Gathers what the window carries with it, into src-tauri/resources: the app's source (the app runs from source, as the
// engine does, so there is nothing to build), and the Node that runs it, so that a computer needs nothing installed.
//
//   resources/app/package.json
//   resources/app/packages/app/{package.json,src,ui,samples}
//   resources/app/packages/assess/{package.json,src}
//   resources/node/node.exe
//
// Run by `npm run build` and `npm run dev`. The folder it fills is not kept in the repository.
//
// The Node carried is the one running this, or the one OPENASSESS_NODE names (the release build, tools/release/build_installer.py,
// names the copy it carries). Either way it must be NODE_AT_LEAST or later: an older one is refused, so that no installer carries a
// Node without the security fixes the release was checked with (the security review of 2026-11-13 asked for 24.22.3).

import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** The least Node an installer may carry. Raise it when a Node security release comes out. */
export const NODE_AT_LEAST = "24.22.3";

/** Whether version a ("v24.22.3" or "24.22.3") is b or later, by number. */
export function atLeast(a, b) {
  const parts = (v) => v.trim().replace(/^v/, "").split(".").map((n) => Number.parseInt(n, 10) || 0);
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  return true;
}

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..", "..");
const out = join(here, "src-tauri", "resources");

rmSync(out, { recursive: true, force: true });
const copy = (from, to) => {
  const source = join(repo, from);
  if (!existsSync(source)) throw new Error(`${from} is not where it should be: ${source}`);
  cpSync(source, join(out, "app", to), { recursive: true });
};
copy("package.json", "package.json");
copy("packages/app/package.json", "packages/app/package.json");
copy("packages/app/src", "packages/app/src");
copy("packages/app/ui", "packages/app/ui");
copy("packages/app/samples", "packages/app/samples");
copy("packages/assess/package.json", "packages/assess/package.json");
copy("packages/assess/src", "packages/assess/src");

// The Node that runs the app: the one OPENASSESS_NODE names, or the one running this. Its version is asked of the program itself.
const node = process.env.OPENASSESS_NODE || process.execPath;
if (!existsSync(node)) throw new Error(`OPENASSESS_NODE names ${node}, which is not there.`);
const version = node === process.execPath ? process.version : execFileSync(node, ["--version"], { encoding: "utf8" }).trim();
if (!atLeast(version, NODE_AT_LEAST)) {
  throw new Error(`The Node to carry is ${version}, and an installer must carry ${NODE_AT_LEAST} or later. Install a newer Node, or set OPENASSESS_NODE to one.`);
}
mkdirSync(join(out, "node"), { recursive: true });
const carried = join(out, "node", process.platform === "win32" ? "node.exe" : "node");
cpSync(node, carried);

const size = (path) => (statSync(path).size / 1024 / 1024).toFixed(1);
console.log(`Gathered the app and Node ${version} (${size(carried)} MB) into ${out}`);
