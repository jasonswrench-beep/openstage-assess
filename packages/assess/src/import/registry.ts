/**
 * The importers, and choosing one for a file.
 *
 * The harness and the command line both need to turn a file name into an importer
 * and a file's bytes into a result, and they must do it the same way, or a file
 * would score one way and import another. So it is done here, once.
 */

import { standardTextImporter } from "./standard-text.ts";
import type { Importer, ImportOptions, ImportResult } from "./types.ts";
import { wordImporter } from "./word.ts";

export const IMPORTERS: Importer[] = [standardTextImporter, wordImporter];

/** The importer that reads files with this name's extension, if there is one. */
export function importerFor(file: string): Importer | undefined {
  const dot = file.lastIndexOf(".");
  if (dot === -1) return undefined;
  const extension = file.slice(dot).toLowerCase();
  return IMPORTERS.find((importer) => importer.extensions.includes(extension));
}

/**
 * Run an importer on a file's bytes. A format that is not text is handed the
 * bytes; the others are decoded as UTF-8, keeping a byte order mark if there is
 * one, which is what reading the file as text always did.
 */
export function runImporter(importer: Importer, bytes: Uint8Array, options: ImportOptions = {}): ImportResult {
  if (importer.parseBytes) return importer.parseBytes(bytes, options);
  return importer.parse(Buffer.from(bytes).toString("utf8"), options);
}
