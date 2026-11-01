/**
 * Reading a QTI package back, for the tests of the two exporters that write one (QTI 1.2 and Common Cartridge).
 *
 * `grade` is a small QTI 1.2 response processor. It takes the answers a student could give and works out the score the way the
 * standard says conditions are evaluated: in order, stopping at the first that is met unless one says to continue. It is written
 * apart from the exporters, so that a question is right only when exactly its key scores and nothing else does.
 */

import assert from "node:assert/strict";

import { unzipSync } from "../../src/container/zip.ts";
import { allText, elements, first, parseXml, type XmlElement } from "../../src/import/docx/xml.ts";

export interface Pack {
  files: Map<string, Uint8Array>;
  manifest: XmlElement;
  doc: XmlElement;
  text: (name: string) => string;
}

/** A package's bytes as its manifest and its questions file, read. */
export function readPackage(bytes: Uint8Array | undefined, docName: string): Pack {
  assert.ok(bytes, "a package has bytes");
  const files = unzipSync(bytes);
  const text = (n: string): string => Buffer.from(files.get(n) ?? new Uint8Array()).toString("utf8");
  return { files, manifest: parseXml(text("imsmanifest.xml")), doc: parseXml(text(docName)), text };
}

export const descend = (el: XmlElement, name: string): XmlElement[] => {
  const found: XmlElement[] = [];
  const walk = (e: XmlElement): void => {
    for (const c of elements(e)) {
      if (c.name === name) found.push(c);
      walk(c);
    }
  };
  walk(el);
  return found;
};

export const itemsOf = (pack: Pack): XmlElement[] => descend(pack.doc, "item");
export const attr = (el: XmlElement, name: string): string => el.attrs[name] ?? "";

/** The text of a mattext, as a person reads it: html with its tags taken out. */
export function mattext(el: XmlElement): { type: string; text: string; raw: string } {
  const m = descend(el, "mattext")[0] as XmlElement;
  const raw = allText(m);
  const type = attr(m, "texttype");
  return { type, raw, text: type === "text/html" ? raw.replace(/<[^>]+>/g, " ").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim() : raw };
}

/** What a student chose: for a response_lid the labels, for a response_str the typed words. */
export type Answers = Record<string, string[]>;

function holds(node: XmlElement, answers: Answers): boolean {
  switch (node.name) {
    case "varequal": {
      const given = answers[attr(node, "respident")] ?? [];
      const want = allText(node).trim();
      if (attr(node, "case") === "Yes") return given.includes(want);
      return given.some((g) => g.trim().toLowerCase() === want.toLowerCase());
    }
    case "and":
      return elements(node).every((c) => holds(c, answers));
    case "or":
      return elements(node).some((c) => holds(c, answers));
    case "not":
      return !holds(elements(node)[0] as XmlElement, answers);
    case "other":
      return true;
    default:
      throw new Error(`a condition this grader does not know: ${node.name}`);
  }
}

/** The score of a set of answers: conditions in order, stopping at the first met unless it says to continue. */
export function grade(item: XmlElement, answers: Answers): number {
  const processing = first(item, "resprocessing") as XmlElement;
  let score = Number(attr(descend(processing, "decvar")[0] as XmlElement, "defaultval") || 0);
  for (const c of elements(processing, "respcondition")) {
    if (!elements(first(c, "conditionvar") as XmlElement).every((n) => holds(n, answers))) continue;
    for (const sv of elements(c, "setvar")) score = attr(sv, "action") === "Add" ? score + Number(allText(sv)) : Number(allText(sv));
    if (attr(c, "continue") !== "Yes") break;
  }
  return Math.round(score * 100000) / 100000;
}

/** The most a question can score: the top of its SCORE. */
export const pointsOf = (item: XmlElement): number => Number(attr(descend(item, "decvar")[0] as XmlElement, "maxvalue"));

export const labelsOf = (item: XmlElement, respident?: string): Array<{ ident: string; text: string }> => {
  const lid = elements(first(item, "presentation") as XmlElement, "response_lid").find((l) => respident === undefined || attr(l, "ident") === respident) as XmlElement;
  return elements(first(lid, "render_choice") as XmlElement, "response_label").map((l) => ({ ident: attr(l, "ident"), text: mattext(l).text }));
};

export const subsets = <T,>(xs: T[]): T[][] => xs.reduce<T[][]>((acc, x) => acc.concat(acc.map((s) => [...s, x])), [[]]);
