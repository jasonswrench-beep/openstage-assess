/**
 * PDFs put together the way real programs put them together and the builder does not: a file saved again with the new object after the
 * old and a table that points back at the older one, a hybrid file whose table lists some objects in a stream of its own, and a file with
 * bytes in front of its header. Each says the word it shows in its one line of text, so that a reader that reads the wrong revision shows it.
 */

import { assemble, assembleWith, buffer, helloPieces, packed, streamObj, type Piece } from "./hostile-pdf.ts";

export const say = (word: string): string => `BT /F1 12 Tf 72 700 Td (${word}) Tj ET`;

/** The number after the last `startxref` of a file. */
export function lastTable(file: Buffer): number {
  return Number(/startxref\n(\d+)\n%%EOF\n$/.exec(file.toString("latin1"))?.[1]);
}

/**
 * Two revisions. The first is a whole file whose content says `oldWord`, with its table; the second adds a new object 4 (the content,
 * saying `newWord`) and a table that lists that object alone and points back (`/Prev`) at the first table for all the rest.
 */
export function savedAgain(oldWord: string, newWord: string): Buffer {
  const first = assemble(helloPieces(buffer(say(oldWord))));
  const added = streamObj(4, "", buffer(say(newWord)));
  const secondTable = first.length + added.length;
  const row = `${String(first.length).padStart(10, "0")} 00000 n \n`;
  return Buffer.concat([first, added, buffer(`xref\n0 1\n0000000000 65535 f \n4 1\n${row}trailer\n<< /Size 6 /Root 1 0 R /Prev ${lastTable(first)} >>\nstartxref\n${secondTable}\n%%EOF\n`)]);
}

/** A file saved again once more: a third revision on the file given, which must end in the table of its last revision. */
export function savedOnceMore(file: Buffer, word: string): Buffer {
  const added = streamObj(4, "", buffer(say(word)));
  return Buffer.concat([
    file,
    added,
    buffer(`xref\n4 1\n${String(file.length).padStart(10, "0")} 00000 n \ntrailer\n<< /Size 6 /Root 1 0 R /Prev ${lastTable(file)} >>\nstartxref\n${file.length + added.length}\n%%EOF\n`),
  ]);
}

/** The same file with the last start-of-table pointing at nothing, so that the objects are found by searching. */
export const withTableLost = (file: Buffer): Buffer => buffer(file.toString("latin1").replace(/startxref\n\d+\n%%EOF\n$/, "startxref\n99999999\n%%EOF\n"));

const PAGE = "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>";

/**
 * A hybrid file. The page, object 3, is in an object stream; the old table lists it as free (a reader that knows only the old table sees
 * no page), and the stream of entries that `/XRefStm` names says where it is.
 */
export function hybridPdf(): Buffer {
  const pieces: Piece[] = [
    { num: 1, body: "<< /Type /Catalog /Pages 2 0 R >>" },
    { num: 2, body: "<< /Type /Pages /Kids [3 0 R] /Count 1 >>" },
    { num: 4, dict: "", data: buffer(say("Hello")) },
    { num: 5, body: "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>" },
    { num: 6, dict: "/Type /ObjStm /N 1 /First 4", data: buffer(`3 0 ${PAGE}`) },
    { num: 7, dict: "/Type /XRef /Size 8 /W [1 3 1] /Index [3 1]", data: packed([[2, 6, 0]], [1, 3, 1]) },
  ];
  return assembleWith(pieces, (offsets, size) => {
    const row = (n: number): string => `${String(offsets.get(n)).padStart(10, "0")} 00000 n \n`;
    return `xref\n0 7\n0000000000 65535 f \n${row(1)}${row(2)}0000000000 00000 f \n${row(4)}${row(5)}${row(6)}trailer\n<< /Size 8 /Root 1 0 R /XRefStm ${offsets.get(7)} >>\nstartxref\n${size}\n%%EOF\n`;
  });
}

/** A file with bytes in front of its header, and a table that counts from the header. */
export const prefixedPdf = (): Buffer => assembleWith(helloPieces(), undefined, "Content-Type: application/pdf\r\n\r\n");
