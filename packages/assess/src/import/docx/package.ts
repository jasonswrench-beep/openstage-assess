/**
 * Opening a .docx.
 *
 * A .docx is a zip of XML parts joined by relationships (the Open Packaging
 * Conventions). This opens the zip, finds the part that holds the document body,
 * and reads parts as XML on request. Everything else about a Word file is built on
 * top of it.
 *
 * It is the first code to see a file the user did not write, so it is strict about
 * what it was given and kind about what it says. A file that is really an older
 * .doc, a Rich Text file or a PDF is named as such, with the way out, instead of
 * being reported as a broken zip.
 */

import { safeEntryName, unzipSync } from "../../container/zip.ts";
import { elements, parseXml, XmlError, type XmlElement, type XmlLimits } from "./xml.ts";

/** Expanded size beyond which a .docx is not read. Far more than any test bank. */
export const DOCX_MAX_BYTES = 256 * 1024 * 1024;

export class DocxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DocxError";
  }
}

export interface DocxLimits {
  /** Total size of all parts once expanded. */
  maxBytes?: number;
  xml?: XmlLimits;
}

export interface DocxPackage {
  /** Part names, as stored. */
  names: string[];
  /** The part holding the document body, for example "word/document.xml". */
  mainDocument: string;
  has(name: string): boolean;
  bytes(name: string): Uint8Array | undefined;
  /** A part read as XML, or undefined if it is not there. A part that is not valid XML throws a DocxError that names it. */
  xml(name: string): XmlElement | undefined;
  /**
   * The part the main document is related to by a relationship whose type ends in
   * `/kind`, for example "numbering" or "styles". Undefined when there is none or it
   * points at a part that is not in the file.
   */
  related(kind: string): string | undefined;
}

const OLE_MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

function startsWith(bytes: Uint8Array, text: string): boolean {
  if (bytes.length < text.length) return false;
  for (let i = 0; i < text.length; i++) if (bytes[i] !== text.charCodeAt(i)) return false;
  return true;
}

/** A clear message for the files that are commonly mistaken for a .docx. */
function wrongKindOfFile(bytes: Uint8Array): string | undefined {
  if (bytes.length === 0) return "This file is empty.";
  if (OLE_MAGIC.every((byte, i) => bytes[i] === byte)) {
    return (
      "This is an older Word file (.doc), or a Word file protected by a password. OpenAssess reads .docx. " +
      "In Word, choose File, then Save As, pick Word Document (*.docx), and make sure no password is set."
    );
  }
  if (startsWith(bytes, "{\\rtf")) {
    return "This is a Rich Text file (.rtf), not a .docx. In Word, choose File, then Save As, and pick Word Document (*.docx).";
  }
  if (startsWith(bytes, "%PDF")) return "This is a PDF, not a Word document.";
  return undefined;
}

/** XML parts are UTF-8 in practice. UTF-16 with a byte order mark is allowed by the standard, so it is read. */
function decodeXml(bytes: Uint8Array, part: string): string {
  let text: string;
  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    text = Buffer.from(bytes.subarray(2)).toString("utf16le");
  } else if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    const body = Buffer.from(bytes.subarray(2));
    text = body.subarray(0, body.length - (body.length % 2)).swap16().toString("utf16le");
  } else {
    text = Buffer.from(bytes).toString("utf8");
  }
  const declared = /^﻿?\s*<\?xml[^>]*\sencoding\s*=\s*["']([^"']+)["']/i.exec(text.slice(0, 300));
  const encoding = declared?.[1]?.toLowerCase();
  if (encoding && !["utf-8", "utf8", "utf-16", "utf16"].includes(encoding)) {
    throw new DocxError(`The part "${part}" says it is written in ${declared?.[1]}, which this reader does not read. Word writes UTF-8.`);
  }
  return text;
}

export function openDocx(input: Uint8Array, limits: DocxLimits = {}): DocxPackage {
  const wrong = wrongKindOfFile(input);
  if (wrong) throw new DocxError(wrong);

  let parts: Map<string, Uint8Array>;
  try {
    parts = unzipSync(input, { maxTotalBytes: limits.maxBytes ?? DOCX_MAX_BYTES });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new DocxError(`This file could not be opened as a Word document. ${reason}`);
  }

  // Part names are compared without regard to case in this format, so two names
  // that differ only in case are one part twice, and which is real is unknowable.
  const byLowerCase = new Map<string, string>();
  for (const name of parts.keys()) {
    const key = name.toLowerCase();
    const earlier = byLowerCase.get(key);
    if (earlier !== undefined) {
      throw new DocxError(`This Word file holds "${earlier}" and "${name}", which are the same part under the format's rules, so which one is real cannot be known.`);
    }
    byLowerCase.set(key, name);
  }

  const lookup = (name: string): string | undefined => byLowerCase.get(name.toLowerCase());

  const read = (name: string): Uint8Array | undefined => {
    const stored = lookup(name);
    return stored === undefined ? undefined : parts.get(stored);
  };

  const readXml = (name: string): XmlElement | undefined => {
    const stored = lookup(name);
    const data = stored === undefined ? undefined : parts.get(stored);
    if (data === undefined) return undefined;
    try {
      return parseXml(decodeXml(data, name), limits.xml);
    } catch (error) {
      if (error instanceof DocxError) throw error;
      if (error instanceof XmlError) throw new DocxError(`The part "${name}" of this Word file is not valid XML. ${error.message}`);
      throw error;
    }
  };

  const mainDocument = findMainDocument(readXml, lookup);
  if (mainDocument === undefined) {
    throw new DocxError(
      "This zip is not a Word document: it has no main document part. " +
        "A .docx holds its text in word/document.xml.",
    );
  }

  const related = (kind: string): string | undefined => {
    const slash = mainDocument.lastIndexOf("/");
    const folder = slash === -1 ? "" : mainDocument.slice(0, slash + 1);
    const rels = readXml(`${folder}_rels/${mainDocument.slice(slash + 1)}.rels`);
    if (!rels) return undefined;
    for (const rel of elements(rels, "Relationship")) {
      const target = rel.attrs["Target"];
      if (!target || rel.attrs["TargetMode"] === "External" || !(rel.attrs["Type"] ?? "").endsWith(`/${kind}`)) continue;
      const name = resolveTarget(folder, target);
      const stored = name === undefined ? undefined : lookup(name);
      if (stored !== undefined) return stored;
    }
    return undefined;
  };

  return {
    names: [...parts.keys()],
    mainDocument,
    has: (name) => lookup(name) !== undefined,
    bytes: read,
    xml: readXml,
    related,
  };
}

/** A relationship target as a part name: absolute, or relative to the folder of the part that holds it. */
function resolveTarget(folder: string, target: string): string | undefined {
  const segments = (target.startsWith("/") ? target.slice(1) : folder + target).split("/");
  const resolved: string[] = [];
  for (const segment of segments) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (resolved.pop() === undefined) return undefined; // climbs out of the package
    } else resolved.push(segment);
  }
  try {
    return safeEntryName(resolved.join("/"));
  } catch {
    return undefined;
  }
}

/** Where the package says the document body is, falling back to the usual place. */
function findMainDocument(
  readXml: (name: string) => XmlElement | undefined,
  lookup: (name: string) => string | undefined,
): string | undefined {
  const rels = readXml("_rels/.rels");
  if (rels) {
    for (const rel of elements(rels, "Relationship")) {
      const type = rel.attrs["Type"] ?? "";
      const target = rel.attrs["Target"];
      if (!target || !/\/officeDocument$/.test(type)) continue;
      let name: string;
      try {
        name = safeEntryName(target.replace(/^\/+/, ""));
      } catch {
        continue; // a target that climbs out of the package is not followed
      }
      const stored = lookup(name);
      if (stored !== undefined) return stored;
    }
  }
  return lookup("word/document.xml");
}
