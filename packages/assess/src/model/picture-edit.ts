/**
 * Adding, replacing and removing a picture of a question by hand.
 *
 * An import keeps the pictures it can show exactly as the author placed them and refuses the rest (cropped, turned, drawn on), and a
 * question written in the app has none. This is how a person puts one in: a PNG, JPEG or GIF chosen from the computer, read by its own
 * bytes and never by its name, named by a hash of them (so adding the same picture twice is one file), with no description until one
 * is written, and placed at the end of the question's text unless the person says otherwise.
 *
 * Each function answers with an edit for `editQuestion` or `Bank.update` to apply, and the file to store, and does not change the
 * question itself, so the caller keeps its own rules about versions, history and validity. Nothing here throws on bytes that are not a
 * picture: it says so in words.
 */

import { createHash } from "node:crypto";

import { sniffImage } from "./image.ts";
import { localId } from "./ids.ts";
import type { QuestionEdit } from "./create.ts";
import type { MediaRef, Question } from "./question.ts";
import { collectRefs, mediaPlaceholder, plainToRich, richTextFields, type RichText } from "./richtext.ts";

/** A picture the person asked for that cannot be done, with the words to say why. */
export class PictureError extends Error {}

/** The most pictures one question carries. More is a mistake or an attempt to fill a bank. */
export const MAX_PICTURES_PER_QUESTION = 40;

export interface PictureEdit {
  edit: QuestionEdit;
  /** The picture's path in the bank (media/p-<hash>.<ext>), whose bytes the caller stores. */
  file: string;
  /** What to write in the history. */
  change: string;
}

function readPicture(bytes: Uint8Array): { file: string; mime: MediaRef["mime"]; width: number; height: number } {
  const info = sniffImage(bytes);
  if (info === undefined) {
    throw new PictureError("That file is not a PNG, JPEG or GIF picture, or it is damaged or larger than 25 MB. Save the picture in one of those forms and try again.");
  }
  const hash = createHash("sha256").update(bytes).digest("hex").slice(0, 16);
  return { file: `media/p-${hash}.${info.ext}`, mime: info.mime, width: info.width, height: info.height };
}

/** The ids of the pictures that some text of the question has in place. */
export function placedPictures(question: Question): Set<string> {
  const placed = new Set<string>();
  for (const [, text] of richTextFields({ stem: question.stem, feedback: question.feedback, body: question.body })) {
    for (const ref of collectRefs(text).media) placed.add(ref);
  }
  return placed;
}

/** The stem with a picture in place after its words, as a paragraph of its own. */
function stemWith(stem: RichText, id: string): RichText {
  const base = stem.format === "plain" ? plainToRich(stem.content) : stem;
  return { ...base, content: `${base.content}<p>${mediaPlaceholder(id)}</p>` };
}

/**
 * A picture added to a question. With `place` (the default) it is put at the end of the question's text, so it shows at once; without,
 * it is carried and not shown until the person writes it into a text. The same picture added again is not a second one: it is the
 * same file, and is placed if it was not.
 */
export function addPicture(question: Question, bytes: Uint8Array, options: { place?: boolean } = {}): PictureEdit | undefined {
  const picture = readPicture(bytes);
  const place = options.place !== false;
  const held = question.media.find((m) => m.file === picture.file);
  if (held === undefined && question.media.length >= MAX_PICTURES_PER_QUESTION) {
    throw new PictureError(`A question carries at most ${MAX_PICTURES_PER_QUESTION} pictures.`);
  }

  let id = held?.id;
  let media: MediaRef[] | undefined;
  if (held === undefined) {
    const taken = new Set(question.media.map((m) => m.id));
    let n = 0;
    while (taken.has(localId("m", n))) n++;
    id = localId("m", n);
    media = [...question.media, { id, file: picture.file, mime: picture.mime, alt: "", width: picture.width, height: picture.height }];
  }
  const needsPlacing = place && id !== undefined && !placedPictures(question).has(id);
  if (media === undefined && !needsPlacing) return undefined;
  return {
    edit: { ...(media ? { media } : {}), ...(needsPlacing && id ? { stem: stemWith(question.stem, id) } : {}) },
    file: picture.file,
    change: held === undefined ? "added a picture" : "put a picture in the text",
  };
}

/** One picture of a question given other bytes: its place in the text, its description and its mark as decoration are kept. */
export function replacePicture(question: Question, pictureId: string, bytes: Uint8Array): PictureEdit | undefined {
  const held = question.media.find((m) => m.id === pictureId);
  if (held === undefined) throw new PictureError("This question has no such picture.");
  const picture = readPicture(bytes);
  if (picture.file === held.file) return undefined;
  const { width: _w, height: _h, ...rest } = held;
  const media = question.media.map((m) => (m.id === pictureId ? { ...rest, file: picture.file, mime: picture.mime, width: picture.width, height: picture.height } : m));
  return { edit: { media }, file: picture.file, change: "replaced a picture" };
}

/**
 * A picture taken away from a question. Only one that no text has in place: taking one out from under the words that show it would
 * leave a reference that points at nothing, so the person takes its token out of the text first. The file stays in the bank, since
 * another question may use it.
 */
export function removePicture(question: Question, pictureId: string): PictureEdit {
  const held = question.media.find((m) => m.id === pictureId);
  if (held === undefined) throw new PictureError("This question has no such picture.");
  if (placedPictures(question).has(pictureId)) {
    throw new PictureError("That picture is in the text of the question. Take its [picture] words out of the text and save, and then it can be removed.");
  }
  return { edit: { media: question.media.filter((m) => m.id !== pictureId) }, file: held.file, change: "removed a picture" };
}
