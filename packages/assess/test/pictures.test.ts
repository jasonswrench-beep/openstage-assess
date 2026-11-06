/**
 * Pictures in a Word file.
 *
 * A picture used to be the text "[picture]" and its bytes were never looked at, so a test bank with figures came in with the figures
 * gone. A picture that can be shown as the author placed it is now kept, with the description Word holds for it; one that cannot
 * (cropped, rotated, drawn on, in a format this program does not read, a text box) is not kept, says why, and leaves the marker where
 * it stood. Nothing here is a real Word file: the writer is the test suite's own, so what Word itself writes is on the list of things
 * to try by hand.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { describeUnreadImage, MAX_PICTURE_BYTES, sniffImage } from "../src/model/image.ts";
import { wordImporter } from "../src/import/word.ts";
import { FindingCode, verdictFrom } from "../src/model/findings.ts";
import type { Question } from "../src/model/question.ts";
import { collectRefs, richTextToPlain } from "../src/model/richtext.ts";
import { docx, paragraph, run } from "./support/docx-writer.ts";
import { drawing, emf, gif, jpeg, png, pictureParts, type PictureSpec } from "./support/images.ts";

const OPTIONS = { file: "t.docx", at: "2026-01-01T00:00:00.000Z", author: "test" };
const sha = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex").slice(0, 16);

const BLUE = png(40, 30);
const RED = png(20, 20, { color: [200, 30, 30] });
const spec = (rId: string, name: string, bytes: Uint8Array): PictureSpec => ({ rId, part: `word/media/${name}`, bytes });

/** A document of paragraphs. A paragraph given as {drawing} holds a picture in its own run. */
function document(lines: Array<string | { text?: string; draw: string }>, pictures: PictureSpec[]): Uint8Array {
  const body = lines
    .map((l) => (typeof l === "string" ? paragraph(run(l)) : paragraph((l.text ? run(l.text) : "") + `<w:r>${l.draw}</w:r>`)))
    .join("");
  return docx({ body, ...pictureParts(pictures) });
}
const read = (bytes: Uint8Array) => wordImporter.parseBytes(bytes, OPTIONS);
const plain = (rich: Parameters<typeof richTextToPlain>[0]): string => richTextToPlain(rich).replace(/\s+/g, " ").trim();
const has = (q: Question, code: string): boolean => q.findings.some((f) => f.code === code);

const FIGURE = [
  "1. Look at the figure. Which colour is it?",
  { draw: drawing("rId10", { alt: "A solid blue rectangle" }) },
  "a) Blue",
  "b) Red",
  "Answer: a",
] as const;

describe("a picture that can be kept", () => {
  const result = read(document([...FIGURE], [spec("rId10", "image1.png", BLUE)]));
  const q = result.questions[0] as Question;

  test("is a media entry of the question that holds it, named by what it is", () => {
    assert.equal(result.questions.length, 1);
    assert.equal(q.media.length, 1);
    const ref = q.media[0]!;
    assert.equal(ref.file, `media/p-${sha(BLUE)}.png`);
    assert.equal(ref.mime, "image/png");
    assert.equal(ref.alt, "A solid blue rectangle");
  });

  test("stands in the stem as a media placeholder, with the words around it", () => {
    assert.deepEqual(collectRefs(q.stem).media, [q.media[0]!.id]);
    assert.equal(plain(q.stem), "Look at the figure. Which colour is it?");
  });

  test("comes out of the import as bytes under the same path, identical to what the file held", () => {
    assert.ok(result.media);
    assert.deepEqual([...result.media.keys()], [q.media[0]!.file]);
    assert.deepEqual(result.media.get(q.media[0]!.file), BLUE);
  });

  test("leaves a question with a description clean: the key is read, and nothing needs a look", () => {
    assert.equal(verdictFrom(q.findings), "parsed");
    assert.ok(!has(q, FindingCode.MissingAltText));
    assert.ok(result.fileFindings.some((f) => /1 picture was read and kept/.test(f.message) && f.severity === "info"));
    assert.ok(!result.fileFindings.some((f) => /not read|not kept/.test(f.message)), "and no warning that one was lost");
  });

  test("keeps a picture without a description, and flags it on its question so that a description is added", () => {
    const bare = read(document([FIGURE[0], { draw: drawing("rId10") }, FIGURE[2], FIGURE[3], FIGURE[4]], [spec("rId10", "image1.png", BLUE)]));
    const bq = bare.questions[0] as Question;
    assert.equal(bq.media.length, 1, "kept");
    assert.equal(bq.media[0]!.alt, "");
    assert.ok(has(bq, FindingCode.MissingAltText));
    assert.equal(verdictFrom(bq.findings), "needsReview");
  });

  test("takes the description from the title when there is no description, and cleans a description's quotation marks and line breaks", () => {
    const titled = read(document([FIGURE[0], { draw: drawing("rId10", { title: "A blue box" }) }, FIGURE[2], FIGURE[3], FIGURE[4]], [spec("rId10", "image1.png", BLUE)]));
    assert.equal((titled.questions[0] as Question).media[0]!.alt, "A blue box");
    const messy = read(document([FIGURE[0], { draw: drawing("rId10", { alt: 'A "blue"\n  box' }) }, FIGURE[2], FIGURE[3], FIGURE[4]], [spec("rId10", "image1.png", BLUE)]));
    assert.equal((messy.questions[0] as Question).media[0]!.alt, "A 'blue' box");
  });

  test("is one file when it is used twice, and two files when two pictures differ", () => {
    const lines = [
      "1. First figure?",
      { draw: drawing("rId10", { alt: "blue", id: 1 }) },
      "a) Yes",
      "b) No",
      "Answer: a",
      "2. Second figure?",
      { draw: drawing("rId11", { alt: "blue again", id: 2 }) },
      "a) Yes",
      "b) No",
      "Answer: b",
      "3. Third figure?",
      { draw: drawing("rId12", { alt: "red", id: 3 }) },
      "a) Yes",
      "b) No",
      "Answer: a",
    ] as const;
    const two = read(document([...lines], [spec("rId10", "image1.png", BLUE), spec("rId11", "image2.png", BLUE), spec("rId12", "image3.png", RED)]));
    assert.equal(two.questions.length, 3);
    assert.equal(two.media?.size, 2, "the same bytes under two part names are one file");
    const files = two.questions.map((x) => x.media[0]!.file);
    assert.equal(files[0], files[1]);
    assert.notEqual(files[0], files[2]);
  });

  test("works in an option, where a picture is the whole of the answer", () => {
    const lines = [
      "1. Which is the red one?",
      { text: "a) ", draw: drawing("rId10", { alt: "blue box" }) },
      { text: "b) ", draw: drawing("rId11", { alt: "red box", id: 2 }) },
      "Answer: b",
    ];
    const r = read(document(lines, [spec("rId10", "image1.png", BLUE), spec("rId11", "image2.png", RED)]));
    const oq = r.questions[0] as Question;
    assert.equal(oq.media.length, 2);
    const options = (oq.body as { options: Array<{ content: Parameters<typeof collectRefs>[0]; correct?: boolean }> }).options;
    assert.equal(options.length, 2);
    assert.deepEqual(options.map((o) => collectRefs(o.content).media.length), [1, 1]);
    assert.deepEqual(options.map((o) => o.correct === true), [false, true]);
    assert.ok(!oq.findings.some((f) => f.code === FindingCode.DuplicateOption), "two picture options are not the same option");
  });

  test("reads a JPEG and a GIF as well, and names each by its own type", () => {
    const j = jpeg(64, 48);
    const g = gif(10, 12);
    const r = read(document([...FIGURE], [spec("rId10", "image1.jpeg", j)]));
    assert.equal((r.questions[0] as Question).media[0]!.file, `media/p-${sha(j)}.jpg`);
    assert.equal((r.questions[0] as Question).media[0]!.mime, "image/jpeg");
    const r2 = read(document([...FIGURE], [spec("rId10", "image1.gif", g)]));
    assert.equal((r2.questions[0] as Question).media[0]!.file, `media/p-${sha(g)}.gif`);
    assert.equal((r2.questions[0] as Question).media[0]!.mime, "image/gif");
  });

  test("is named by the bytes and not by the part's name: a PNG stored as image1.jpg is a PNG", () => {
    const r = read(document([...FIGURE], [spec("rId10", "image1.jpg", BLUE)]));
    assert.equal((r.questions[0] as Question).media[0]!.file, `media/p-${sha(BLUE)}.png`);
  });

  test("is found in the older and the newer drawing wrappers alike", () => {
    const wrapped = `<mc:AlternateContent><mc:Choice Requires="wps">${drawing("rId10", { alt: "boxed" })}</mc:Choice><mc:Fallback><w:pict/></mc:Fallback></mc:AlternateContent>`;
    const r = read(docx({ body: paragraph(run("1. Q?")) + `<w:p><w:r>${wrapped}</w:r></w:p>` + paragraph(run("a) Yes")) + paragraph(run("b) No")) + paragraph(run("Answer: a")), ...pictureParts([spec("rId10", "image1.png", BLUE)]) }));
    assert.equal((r.questions[0] as Question).media.length, 1);
    assert.equal(r.media?.size, 1);
    assert.ok(!r.fileFindings.some((f) => /not read|not kept/.test(f.message)));
  });

  test("a floating picture, anchored in the text, is kept like an inline one", () => {
    const r = read(document([FIGURE[0], { draw: drawing("rId10", { alt: "floating", anchor: true }) }, FIGURE[2], FIGURE[3], FIGURE[4]], [spec("rId10", "image1.png", BLUE)]));
    assert.equal((r.questions[0] as Question).media.length, 1);
  });
});

describe("a picture that cannot be shown as the author placed it", () => {
  const unkept = (draw: string, pictures: PictureSpec[] = [spec("rId10", "image1.png", BLUE)]) =>
    read(document([FIGURE[0], { draw }, FIGURE[2], FIGURE[3], FIGURE[4]], pictures));

  const reasonOf = (r: ReturnType<typeof read>): string => r.fileFindings.filter((f) => /not kept/.test(f.message)).map((f) => f.message).join("\n");

  function assertNotKept(r: ReturnType<typeof read>, why: RegExp): void {
    const q = r.questions[0] as Question;
    assert.equal(q.media.length, 0, "no picture is attached");
    assert.equal(r.media, undefined, "and no bytes come out");
    assert.match(plain(q.stem), /\[picture\]/, "the marker stays where it stood");
    assert.match(reasonOf(r), why);
    const finding = r.fileFindings.find((f) => /not kept/.test(f.message));
    assert.equal(finding?.severity, "warn", "and it is a warning, so it is looked at");
    assert.match(finding?.message ?? "", /nothing was guessed/);
  }

  test("a picture cropped in Word", () => {
    assertNotKept(unkept(drawing("rId10", { alt: "x", crop: { l: 20000 } })), /1 picture was not kept: a picture cropped in Word/);
  });

  test("a picture with a crop of zero is not cropped", () => {
    const r = unkept(drawing("rId10", { alt: "x", crop: { l: 0, t: 0 } }));
    assert.equal((r.questions[0] as Question).media.length, 1);
  });

  test("a picture rotated or flipped in Word", () => {
    assertNotKept(unkept(drawing("rId10", { alt: "x", rotation: 5400000 })), /rotated or flipped/);
    assertNotKept(unkept(drawing("rId10", { alt: "x", flipH: true })), /rotated or flipped/);
  });

  test("a picture with a shape drawn on it, which would be left off", () => {
    assertNotKept(unkept(drawing("rId10", { alt: "x", inside: '<wps:wsp xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"><wps:cNvSpPr/></wps:wsp>' })), /shapes drawn on it/);
  });

  test("several pictures grouped together", () => {
    const grouped = drawing("rId10", { alt: "x", inside: '<a:blip r:embed="rId11"/>' });
    assertNotKept(unkept(grouped, [spec("rId10", "image1.png", BLUE), spec("rId11", "image2.png", RED)]), /several pictures grouped/);
  });

  test("a picture in a format that is not read, named", () => {
    assertNotKept(unkept(drawing("rId10", { alt: "x" }), [spec("rId10", "image1.emf", emf())]), /format that is not read \(EMF\)/);
  });

  test("a file named .png that is not one", () => {
    assertNotKept(unkept(drawing("rId10", { alt: "x" }), [spec("rId10", "image1.png", new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34]))]), /PNG, but damaged/);
  });

  test("a picture the relationships do not provide (linked from outside, or gone from the file)", () => {
    assertNotKept(unkept(drawing("rId99", { alt: "x" })), /linked from outside the file, or missing from it/);
  });

  test("a text box with a picture in it is a text box: its text is not read, and it says so as before", () => {
    const box = drawing("rId10", { alt: "x", inside: "<w:txbxContent><w:p><w:r><w:t>A label</w:t></w:r></w:p></w:txbxContent>" });
    const r = unkept(box);
    const q = r.questions[0] as Question;
    assert.equal(q.media.length, 0);
    assert.match(plain(q.stem), /\[picture\]/);
    assert.ok(r.fileFindings.some((f) => /not read\. Each is marked \[picture\]/.test(f.message)));
    assert.ok(r.fileFindings.some((f) => /Text in a picture, shape or text box was not read/.test(f.message)));
  });

  test("an object with no picture at all (a chart, a shape) is counted as before", () => {
    const shape = `<w:drawing><wp:inline><wp:docPr id="5" name="Shape"/><a:graphic><a:graphicData uri="x"><wps:wsp xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"/></a:graphicData></a:graphic></wp:inline></w:drawing>`;
    const r = unkept(shape);
    assert.match(plain((r.questions[0] as Question).stem), /\[picture\]/);
    assert.ok(r.fileFindings.some((f) => /1 picture, shape or text box was not read/.test(f.message)));
    assert.ok(!r.fileFindings.some((f) => /not kept/.test(f.message)));
  });

  test("one unusable picture does not stop another from being kept", () => {
    const lines = ["1. First?", { draw: drawing("rId10", { alt: "ok" }) }, "a) Y", "b) N", "Answer: a", "2. Second?", { draw: drawing("rId11", { alt: "no", id: 2, rotation: 100 }) }, "a) Y", "b) N", "Answer: b"] as const;
    const r = read(document([...lines], [spec("rId10", "image1.png", BLUE), spec("rId11", "image2.png", RED)]));
    assert.equal((r.questions[0] as Question).media.length, 1);
    assert.equal((r.questions[1] as Question).media.length, 0);
    assert.equal(r.media?.size, 1);
  });
});

describe("a file without pictures", () => {
  test("has no media, and its text is exactly what it was", () => {
    const r = read(document(["1. Which?", "a) A", "b) B", "Answer: a"], []));
    assert.equal(r.media, undefined);
    assert.equal(r.questions.length, 1);
  });
});

describe("what a picture's bytes are", () => {
  test("a PNG, a JPEG and a GIF are read for their size", () => {
    assert.deepEqual({ ...sniffImage(png(40, 30)), png: undefined }, { mime: "image/png", ext: "png", width: 40, height: 30, png: undefined });
    assert.equal(sniffImage(png(7, 9, { colorType: 6 }))?.png?.colorType, 6);
    assert.equal(sniffImage(png(7, 9, { interlaced: true }))?.png?.interlaced, true);
    const j = sniffImage(jpeg(640, 480));
    assert.deepEqual([j?.mime, j?.width, j?.height, j?.jpeg?.components, j?.jpeg?.progressive], ["image/jpeg", 640, 480, 3, false]);
    assert.equal(sniffImage(jpeg(10, 10, { progressive: true }))?.jpeg?.progressive, true);
    assert.equal(sniffImage(jpeg(10, 10, { components: 1 }))?.jpeg?.components, 1);
    assert.deepEqual([sniffImage(gif(21, 22))?.width, sniffImage(gif(21, 22))?.height], [21, 22]);
  });

  test("anything else, anything cut short and anything with no size is not a picture, and never throws", () => {
    for (const bytes of [new Uint8Array(0), new Uint8Array([0x89, 0x50, 0x4e, 0x47]), emf(), new Uint8Array(200).fill(0xff), new TextEncoder().encode("GIF89a")]) {
      assert.equal(sniffImage(bytes), undefined);
    }
    // Cut at every length, a good file is never read as something it is not and never throws.
    for (const whole of [png(5, 5), jpeg(5, 5), gif(5, 5)]) {
      for (let n = 0; n < whole.length; n++) {
        const info = sniffImage(whole.subarray(0, n));
        if (info) assert.deepEqual([info.width, info.height], [5, 5], `cut at ${n}`);
      }
    }
    assert.equal(sniffImage(png(0, 5)), undefined, "a width of zero");
    assert.equal(sniffImage(png(40000, 5)), undefined, "a side too large to be a picture");
    assert.equal(sniffImage(new Uint8Array(MAX_PICTURE_BYTES + 1)), undefined);
  });

  test("a format is named for a person when it is not read", () => {
    assert.equal(describeUnreadImage(emf(), "word/media/image1.emf"), "EMF");
    assert.equal(describeUnreadImage(new Uint8Array([0x42, 0x4d, 0, 0]), "x.bmp"), "BMP");
    assert.equal(describeUnreadImage(undefined, "word/media/image2.tiff"), "TIFF");
    assert.equal(describeUnreadImage(new Uint8Array([1, 2, 3, 4]), "x.png"), "PNG, but damaged");
    assert.equal(describeUnreadImage(new Uint8Array([1, 2, 3, 4]), "x.zzz"), "an unknown format");
  });
});
