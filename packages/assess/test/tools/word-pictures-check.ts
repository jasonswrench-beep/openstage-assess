/**
 * Pictures in documents written by Word itself, read by the importer.
 *
 * The tests of the picture reader (test/pictures.test.ts) use documents from our own writer, which is not Word. This has Word write
 * a few with pictures in them (word-pictures.ps1): placed with a description, placed with none, the same picture twice, cropped,
 * floating, turned a quarter, and a text box. They hold the drawing XML Word really writes, so what the reader makes of each is the
 * nearest this project has to a real file with pictures in it: it is the check that the reader finds the description where Word puts
 * it, sees a crop and a turn where Word writes them, and keeps a floating picture.
 *
 * It needs Windows with Microsoft Word installed and is not part of `npm test`.
 * Run it with `npm run check:word-pictures --workspace packages/assess`.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { wordImporter } from "../../src/import/word.ts";
import { FindingCode } from "../../src/model/findings.ts";
import type { Question } from "../../src/model/question.ts";
import { png } from "../support/images.ts";
import { withoutAuthor } from "../support/word-authored.ts";
import { wordIsAvailable } from "./ask-word.ts";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "fixtures", "word-authored", "pictures");

const here = dirname(fileURLToPath(import.meta.url));
const OPTIONS = { file: "word.docx", at: "2026-01-01T00:00:00.000Z", author: "check" };

function main(): void {
  if (!wordIsAvailable()) {
    console.log("This check needs Windows with Microsoft Word installed. Nothing was run.");
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), "openassess-word-pictures-"));
  try {
    const out = join(dir, "authored");
    mkdirSync(out);
    const picture = join(dir, "blue.png");
    const picBytes = png(60, 40);
    writeFileSync(picture, picBytes);
    const quoted = (path: string): string => `'${path.replace(/'/g, "''")}'`;
    const script = `$Out = ${quoted(out)}\n$Pic = ${quoted(picture)}\n${readFileSync(join(here, "word-guard.ps1"), "utf8")}\n${readFileSync(join(here, "word-pictures.ps1"), "utf8")}`;
    const said = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "& ([scriptblock]::Create([Console]::In.ReadToEnd()))"], { input: script, encoding: "utf8", timeout: 600_000 });
    console.log(said.trim());

    const documents = new Map<string, Uint8Array>();
    for (const file of readdirSync(out)) if (file.endsWith(".docx")) documents.set(file.slice(0, -5), new Uint8Array(readFileSync(join(out, file))));

    let disagreements = 0;
    const say = (name: string, message: string): void => {
      console.log(`${name}: ${message}`);
      disagreements++;
    };
    const read = (name: string) => {
      const bytes = documents.get(name);
      if (!bytes) {
        say(name, "Word did not write it");
        return undefined;
      }
      return wordImporter.parseBytes(bytes, OPTIONS);
    };
    const refusals = (r: NonNullable<ReturnType<typeof read>>): string => r.fileFindings.filter((f) => /not kept|not read/.test(f.message)).map((f) => f.message).join(" | ");

    // Placed: three questions, the first and third with a description, the second without; one file in all.
    const placed = read("pictures-placed");
    if (placed) {
      const qs = placed.questions as Question[];
      if (qs.length !== 3) say("pictures-placed", `${qs.length} questions were read, not 3 (${refusals(placed)})`);
      else {
        if (qs[0]!.media[0]?.alt !== "A solid blue rectangle") say("pictures-placed", `the first picture's description is ${JSON.stringify(qs[0]!.media[0]?.alt)}`);
        if (qs[1]!.media.length !== 1 || qs[1]!.media[0]!.alt !== "") say("pictures-placed", "the second picture should be kept with no description");
        if (!qs[1]!.findings.some((f) => f.code === FindingCode.MissingAltText)) say("pictures-placed", "the second question should be flagged for having no description");
        if (new Set(qs.map((q) => q.media[0]?.file)).size !== 1) say("pictures-placed", "the same picture three times should be one file");
        if (placed.media?.size !== 1) say("pictures-placed", `${placed.media?.size} files came out, not 1`);
        const bytes = placed.media ? [...placed.media.values()][0] : undefined;
        // Word keeps the PNG it was given as it is, so the bytes are the ones written.
        if (!bytes || bytes.length !== picBytes.length || bytes.some((b, i) => b !== picBytes[i])) say("pictures-placed", "the picture's bytes are not the ones Word was given");
        if (qs[0]!.media[0]?.mime !== "image/png") say("pictures-placed", "the picture is not read as a PNG");
      }
    }

    // Cropped: not kept, and the reason is the crop.
    const cropped = read("pictures-cropped");
    if (cropped) {
      if ((cropped.questions[0] as Question).media.length !== 0) say("pictures-cropped", "a cropped picture should not be kept");
      if (!/cropped in Word/.test(refusals(cropped))) say("pictures-cropped", `the reason should be the crop: ${refusals(cropped) || "(no reason given)"}`);
    }

    // Floating: the one as it is is kept, with its description, and the flipped one is not, and says so. Word anchors a floating
    // picture where it likes (here, in a paragraph of its own), so which question it belongs to is not asked: that nothing is lost is.
    const floating = read("pictures-floating");
    if (floating) {
      const kept = [...(floating.questions as Question[]).flatMap((q) => q.media.map((m) => m.alt)), ...floating.orphans.map((o) => o.text)].join(" | ");
      if (!kept.includes("A floating picture")) say("pictures-floating", `the floating picture and its description should be somewhere: ${kept}`);
      if (/"A flipped picture"/.test(kept)) say("pictures-floating", "a flipped picture should not be kept");
      if (!/rotated or flipped/.test(refusals(floating))) say("pictures-floating", `the flipped picture should say so: ${refusals(floating) || "(no reason given)"}`);
      if (floating.media === undefined || floating.media.size !== 1) say("pictures-floating", `exactly the one kept picture should come out (${floating.media?.size ?? 0})`);
      // The tag must never stand in front of a question number: a floating picture is written after the words of its paragraph.
      if ((floating.questions as Question[]).length !== 2) say("pictures-floating", `both questions should still be read (${floating.questions.length})`);
    }

    // A text box is a text box.
    const box = read("pictures-text-box");
    if (box) {
      if ((box.questions[0] as Question | undefined)?.media.length) say("pictures-text-box", "a text box should not be taken for a picture");
      if (!/Text in a picture, shape or text box was not read/.test(box.fileFindings.map((f) => f.message).join(" | "))) say("pictures-text-box", "the text in the box should be said not to have been read");
    }

    console.log(`${documents.size} documents written by Word, ${disagreements} disagreements.`);
    if (disagreements > 0) process.exitCode = 1;
    // --keep <folder> saves what Word wrote to look at, whatever was found; --update-fixtures keeps it in the repository, when nothing was.
    const keep = process.argv.includes("--keep") ? process.argv[process.argv.indexOf("--keep") + 1] : undefined;
    if (keep) {
      mkdirSync(keep, { recursive: true });
      for (const [name, bytes] of documents) writeFileSync(join(keep, `${name}.docx`), bytes);
      console.log(`Kept in ${keep}`);
    }
    if (disagreements === 0 && process.argv.includes("--update-fixtures")) {
      mkdirSync(FIXTURES, { recursive: true });
      for (const [name, bytes] of documents) writeFileSync(join(FIXTURES, `${name}.docx`), withoutAuthor(bytes));
      console.log(`Kept in ${FIXTURES}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

main();
