/**
 * A question that still holds the marker of something the reader could not read.
 *
 * The Word reader leaves "[picture]", "[equation]" or "[symbol]" where a picture it could not show as placed, an equation with a part it
 * does not know, or a character from a picture font stood, and the PDF reader leaves "[Picture]" where a page drew one. Each is counted in
 * the file's own warnings, and until now that was all: the question that held the marker came out as parsed, with the figure it depends on
 * gone, and a person who trusted the "parsed" count would hand out a question about a diagram with no diagram. The note here is on the
 * question itself, so it shows in the review beside the words and counts as needing a look.
 *
 * It is a warning and never an error, like every other check of the source: the question is kept and can be saved, and a person can write
 * the missing thing in words, add the picture in the editor, or say (dismiss the note) that the question stands without it. When the marker
 * is taken out of the text the note goes by itself (`withRecomputedFindings`), and it is raised only at import, since only an import can
 * leave a marker that stands for something real.
 *
 * Only the exact words are looked for. The editor's own "[picture 2]" and "[equation 1]" name something the question does carry, and are
 * not these.
 */

import { finding, FindingCode, type Finding } from "./findings.ts";
import type { SourceRef } from "./findings.ts";
import { richTextFields, richTextToPlain, type RichText } from "./richtext.ts";

/** The words a reader leaves where it could not read something. The PDF reader writes "[Picture]" with a capital. */
const MARKER = /\[(picture|equation|symbol)\]/gi;

export interface UnreadObjects {
  picture: number;
  equation: number;
  symbol: number;
  total: number;
}

/** Count the markers in every piece of text a question has. */
export function unreadObjects(question: { stem: RichText; feedback?: unknown; body: unknown }): UnreadObjects {
  const found: UnreadObjects = { picture: 0, equation: 0, symbol: 0, total: 0 };
  for (const [, text] of richTextFields({ stem: question.stem, feedback: question.feedback, body: question.body })) {
    for (const match of richTextToPlain(text).matchAll(MARKER)) {
      found[(match[1] as string).toLowerCase() as "picture" | "equation" | "symbol"]++;
      found.total++;
    }
  }
  return found;
}

function listed(found: UnreadObjects): string {
  const parts: string[] = [];
  if (found.picture > 0) parts.push(found.picture === 1 ? "one picture" : `${found.picture} pictures`);
  if (found.equation > 0) parts.push(found.equation === 1 ? "one equation" : `${found.equation} equations`);
  if (found.symbol > 0) parts.push(found.symbol === 1 ? "one symbol" : `${found.symbol} symbols`);
  return parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}` : (parts[0] ?? "");
}

/** The note for a question that holds a marker, or none. */
export function unreadObjectFindings(question: { stem: RichText; feedback?: unknown; body: unknown }, source?: SourceRef): Finding[] {
  const found = unreadObjects(question);
  if (found.total === 0) return [];
  const words = [found.picture > 0 ? "[picture]" : "", found.equation > 0 ? "[equation]" : "", found.symbol > 0 ? "[symbol]" : ""].filter((w) => w !== "").join(", ");
  return [
    finding(
      FindingCode.UnreadObject,
      "warn",
      `This question has ${listed(found)} in the source that could not be read, marked ${words} in the text where ${found.total === 1 ? "it" : "each"} stood. The question may not make sense without ${found.total === 1 ? "it" : "them"}. The file's own warnings say why. Write what it showed in words, or add the picture here in the editor and take the marker out; when no marker is left this note goes. If the question stands without it, dismiss the note.`,
      source ? { source } : {},
    ),
  ];
}
