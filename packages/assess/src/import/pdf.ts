/**
 * The PDF importer: the text of a PDF, read as the Standard Format.
 *
 * A PDF is a page drawn, not a document written. It has no list numbers to rebuild and no styles, so the whole of what is known
 * about a question is the words on the page and where they stand. This reads those into paragraphs (pdf/reader.ts and
 * pdf/paragraphs.ts) and hands them to the same scanner that reads a Word file or a text file, so a question numbered by hand
 * (`1.`, `11)`), with lettered options and a key that is written down (`*b.`, `Answer: b`, an Answers list), reads the same
 * here as anywhere. Nothing is read from fonts: a bold or italic word is not taken for a mark, because the same option can be
 * set in bold for a reason that is not a key, and a key that was guessed from a font looks authored.
 *
 * What a PDF cannot say it does not. A question set in columns, a table, a picture or an equation that was drawn and not
 * written is not here as text, and the file says what it left out. The result always carries a note that the file was read from
 * a page and not from a document, and a question's source is the page it was on.
 */

import { finding, FindingCode, type Finding } from "../model/findings.ts";
import { assembleParagraphs } from "./pdf/paragraphs.ts";
import { PdfError } from "./pdf/objects.ts";
import { readPdfText } from "./pdf/reader.ts";
import { standardTextImporter } from "./standard-text.ts";
import type { Importer, ImportOptions, ImportResult, SourceBlock } from "./types.ts";

export const PDF_PROFILE_ID = "pdf";

/** Whether the bytes are a PDF, by what the file begins with. A PDF may have a few bytes of header before its own. */
export function looksLikePdf(bytes: Uint8Array): boolean {
  const head = Buffer.from(bytes.subarray(0, 1024)).toString("latin1");
  return head.includes("%PDF-");
}

export interface PdfBlocks {
  blocks: SourceBlock[];
  /** For each block, the page it stands on, to show beside a question. */
  pages: number[];
  findings: Finding[];
}

export function pdfToBlocks(bytes: Uint8Array): PdfBlocks {
  const text = readPdfText(bytes);
  const { paragraphs } = assembleParagraphs(text.pages);
  const blocks: SourceBlock[] = paragraphs.map((p, index) => ({ index, text: p.text, kind: "paragraph" }));
  const findings = text.notes.map((n) => finding(FindingCode.UnreadContent, n.severity, n.message));
  findings.unshift(
    finding(
      FindingCode.UnreadContent,
      "warn",
      "This file is a PDF, which is a page drawn and not a document written, so it was read from the words on the pages alone. There is no numbering, style or formatting in it to read, and an answer is read only where it is written down (an asterisk, an Answer line, a list of answers). A question set in columns or in a table, or with a picture or an equation, may have lost something. Check each question against the PDF, and the answers most of all.",
    ),
  );
  return { blocks, pages: paragraphs.map((p) => p.page), findings };
}

export const pdfImporter: Importer & { parseBytes: NonNullable<Importer["parseBytes"]> } = {
  id: PDF_PROFILE_ID,
  label: "PDF (its text)",
  extensions: [".pdf"],

  /** Blocks already made from a PDF. Text is not accepted: a PDF is bytes. */
  parse(input: string | SourceBlock[], options: ImportOptions = {}): ImportResult {
    if (typeof input === "string") throw new Error("The PDF importer reads a .pdf file as bytes. Use parseBytes, or pass source blocks.");
    return standardTextImporter.parse(input, { ...options, profile: PDF_PROFILE_ID, file: options.file ?? "input.pdf" });
  },

  parseBytes(bytes: Uint8Array, options: ImportOptions = {}): ImportResult {
    let made: PdfBlocks;
    try {
      made = pdfToBlocks(bytes);
    } catch (error) {
      if (error instanceof PdfError) throw error;
      throw new PdfError(`This PDF could not be read: ${(error as Error).message}`);
    }
    // Formatting is never read as a key from a PDF, whatever was asked: the blocks carry none.
    const { keyMark: _ignored, ...rest } = options;
    const result = standardTextImporter.parse(made.blocks, { ...rest, profile: PDF_PROFILE_ID, file: options.file ?? "input.pdf" });
    return {
      ...result,
      fileFindings: [...made.findings, ...result.fileFindings],
      sourceLines: made.blocks.map((b, i) => (b.text === "" ? "" : `[p${made.pages[i]}] ${b.text}`)),
    };
  },
};
