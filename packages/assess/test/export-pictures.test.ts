/**
 * Pictures in an export.
 *
 * Moodle XML can carry a picture in the text of a question, as an image tag that points at `@@PLUGINFILE@@/name` and the file in
 * base64 beside the text; that is what is written when the bank's files are offered. A picture anywhere else in a question (an answer,
 * feedback, a matching pair) is written as words and counted, and so is a picture in any of the other formats, none of which has a
 * place for the file. What cannot be carried is never left out without the report saying so. No Moodle was asked about this file:
 * it follows the format as Moodle documents it, and importing it is on the list of things to try.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { parseXml } from "../src/import/docx/xml.ts";
import { exportMoodleXml } from "../src/export/moodle-xml.ts";
import { exportGift } from "../src/export/gift.ts";
import { exportQti12 } from "../src/export/qti12.ts";
import { createQuestion } from "../src/model/create.ts";
import { mediaPlaceholder, plainToRich, rich } from "../src/model/richtext.ts";
import type { Question } from "../src/model/question.ts";
import { jpeg, png } from "./support/images.ts";

const BLUE = png(40, 30);
const FILE = "media/p-aaaaaaaaaaaaaaaa.png";

function figure(options: { file?: string; alt?: string; inOption?: boolean; decorative?: boolean } = {}): Question {
  const file = options.file ?? FILE;
  const marker = mediaPlaceholder("m1");
  return createQuestion({
    type: "multipleChoice",
    stem: options.inOption ? plainToRich("Which one is blue?") : rich(`<p>Look at the figure. Which colour is it?</p><p>${marker}</p>`),
    body: {
      shuffle: false,
      options: [
        { id: "o0", content: options.inOption ? rich(`<p>Blue ${marker}</p>`) : plainToRich("Blue"), correct: true },
        { id: "o1", content: plainToRich("Red"), correct: false },
      ],
    } as never,
    media: [{ id: "m1", file, mime: "image/png", alt: options.alt ?? "A blue box", ...(options.decorative ? { decorative: true } : {}) }],
    by: "test",
    at: "2026-01-01T00:00:00.000Z",
  });
}

const run = (q: Question[], media?: Map<string, Uint8Array>) => exportMoodleXml(q, { name: "Figures", ...(media ? { media } : {}) });
const xmlOf = (result: ReturnType<typeof exportMoodleXml>): string => result.files[0]?.content ?? "";
const parses = (xml: string): void => void parseXml(xml.replace(/^<\?xml[^>]*\?>\s*/, ""));

describe("Moodle XML with the bank's pictures", () => {
  const result = run([figure()], new Map([[FILE, BLUE]]));
  const xml = xmlOf(result);

  test("writes a picture in the question text as an image tag and the file beside it", () => {
    assert.match(xml, /<img src="@@PLUGINFILE@@\/p-aaaaaaaaaaaaaaaa\.png" alt="A blue box" \/>/);
    const file = /<file name="p-aaaaaaaaaaaaaaaa\.png" path="\/" encoding="base64">([A-Za-z0-9+/=]+)<\/file>/.exec(xml);
    assert.ok(file, "the file is there");
    assert.deepEqual(new Uint8Array(Buffer.from(file[1] as string, "base64")), BLUE);
    assert.ok(xml.indexOf("<file ") > xml.indexOf("</text>") && xml.indexOf("<file ") < xml.indexOf("</questiontext>"), "inside questiontext, after its text");
  });

  test("is well formed, and the question is exported as written, with a note on what is carried", () => {
    assert.doesNotThrow(() => parses(xml));
    assert.equal(result.report.items[0]?.outcome, "exported");
    assert.ok(result.report.general.some((g) => /A picture in the text of a question is written into the file/.test(g)));
  });

  test("a description with quotation marks and angle brackets cannot break out of the tag or the file", () => {
    const hostile = run([figure({ alt: '"><script>alert(1)</script> & more' })], new Map([[FILE, BLUE]]));
    const text = xmlOf(hostile);
    assert.doesNotThrow(() => parses(text));
    assert.doesNotMatch(text.replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, ""), /<script>/);
    assert.match(text, /alt="&quot;&gt;&lt;script&gt;alert\(1\)&lt;\/script&gt; &amp; more"/);
  });

  test("a decorative picture has no description in its tag", () => {
    assert.match(xmlOf(run([figure({ decorative: true, alt: "" })], new Map([[FILE, BLUE]]))), /alt="" \/>/);
  });

  test("a JPEG kept in the bank under a .png name is written as a .jpg", () => {
    const j = jpeg(30, 20);
    const text = xmlOf(run([figure({ file: "media/photo.png" })], new Map([["media/photo.png", j]])));
    assert.match(text, /@@PLUGINFILE@@\/photo\.jpg/);
    assert.match(text, /<file name="photo\.jpg"/);
  });
});

describe("what Moodle XML does not carry is words, and said", () => {
  test("a picture in an answer", () => {
    const result = run([figure({ inOption: true })], new Map([[FILE, BLUE]]));
    assert.equal(result.report.items[0]?.outcome, "exportedWithLosses");
    assert.match(result.report.items[0]?.notes.join(" ") ?? "", /1 picture cannot be carried/);
    assert.match(xmlOf(result), /\[Picture: A blue box\]/);
    assert.ok(!xmlOf(result).includes("<file "), "and no file, since only the text of a question is given one");
  });

  test("a picture the bank does not hold, a file that is not a picture, and a name Moodle could not keep", () => {
    assert.match(run([figure()], new Map()).report.items[0]?.notes.join(" ") ?? "", /1 picture cannot be carried/);
    assert.match(run([figure()], new Map([[FILE, new TextEncoder().encode("<script>")]])).report.items[0]?.notes.join(" ") ?? "", /1 picture cannot be carried/);
    const odd = run([figure({ file: "media/my picture (1).png" })], new Map([["media/my picture (1).png", BLUE]]));
    assert.match(odd.report.items[0]?.notes.join(" ") ?? "", /1 picture cannot be carried/);
    assert.ok(!xmlOf(odd).includes("<file "));
  });

  test("with no pictures offered, the file and the note are as they always were", () => {
    const result = run([figure()]);
    assert.equal(result.report.items[0]?.notes[0], "1 picture cannot be carried. Each appears in the text as [Picture: its alternative text]; add the picture again in Moodle.");
    assert.ok(!xmlOf(result).includes("<file "));
    assert.ok(!result.report.general.some((g) => /written into the file/.test(g)));
  });

  test("the other formats have no place for a picture file, so they write words whether or not the files are offered", () => {
    const q = figure();
    const gift = exportGift([q], { name: "Figures" });
    assert.match(gift.report.items[0]?.notes.join(" ") ?? "", /1 picture cannot be carried/);
    const qti = exportQti12([q], { name: "Figures" });
    assert.match(qti.report.items[0]?.notes.join(" ") ?? "", /1 picture cannot be carried/);
  });
});
