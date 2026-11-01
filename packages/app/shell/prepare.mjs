// Gathers what the window carries with it, into src-tauri/resources: the app's source (the app runs from source, as the
// engine does, so there is nothing to build), and the Node that runs it, so that a computer needs nothing installed.
//
//   resources/app/package.json
//   resources/app/packages/app/{package.json,src,ui}
//   resources/app/packages/assess/{package.json,src}
//   resources/node/node.exe
//
// Run by `npm run build` and `npm run dev`. The folder it fills is not kept in the repository.

import { cpSync, existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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
copy("packages/assess/package.json", "packages/assess/package.json");
copy("packages/assess/src", "packages/assess/src");

// The Node that is running this is the Node the app was written against, and it is the one carried.
mkdirSync(join(out, "node"), { recursive: true });
cpSync(process.execPath, join(out, "node", process.platform === "win32" ? "node.exe" : "node"));

const size = (path) => (statSync(path).size / 1024 / 1024).toFixed(1);
console.log(`Gathered the app and Node ${process.version} (${size(join(out, "node", process.platform === "win32" ? "node.exe" : "node"))} MB) into ${out}`);
