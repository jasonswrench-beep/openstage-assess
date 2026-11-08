// Compares every file in the folder the installer is built from (src-tauri/resources/app, which the build gathers) with the committed tree at HEAD, line endings aside.
// It reads that staging folder, not the finished installer, and does not look at the Node program that is bundled beside it.
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const root = join(repo, "packages/app/shell/src-tauri/resources/app");
const walk = (dir) => readdirSync(dir).flatMap((name) => (statSync(join(dir, name)).isDirectory() ? walk(join(dir, name)) : [join(dir, name)]));
const files = walk(root);
const lf = (buf) => Buffer.from(buf.toString("latin1").replace(/\r\n/g, "\n"), "latin1");
let same = 0;
const differ = [];
for (const file of files) {
  const rel = relative(root, file).split("\\").join("/");
  let committed;
  try {
    committed = execFileSync("git", ["-C", repo, "show", `HEAD:${rel}`], { maxBuffer: 1 << 28 });
  } catch {
    differ.push(`${rel}: not in the committed tree`);
    continue;
  }
  if (lf(committed).equals(lf(readFileSync(file)))) same++;
  else differ.push(`${rel}: differs from the committed file`);
}
console.log(`${files.length} files gathered: ${same} identical to HEAD, ${differ.length} not`);
for (const d of differ) console.log(`  ${d}`);
// And the other way: every committed file the installer is meant to carry is there.
const wanted = execFileSync("git", ["-C", repo, "ls-files", "package.json", "packages/app/package.json", "packages/app/src", "packages/app/ui", "packages/app/samples", "packages/assess/package.json", "packages/assess/src"], { encoding: "utf8" }).split("\n").filter(Boolean);
const have = new Set(files.map((f) => relative(root, f).split("\\").join("/")));
const missing = wanted.filter((w) => !have.has(w));
console.log(`${wanted.length} committed files should be carried, ${missing.length} missing${missing.length ? ": " + missing.join(", ") : ""}`);
