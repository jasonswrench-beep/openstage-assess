/**
 * Reading a QTI 2.1 package back, for the tests of the exporter that writes one.
 *
 * `grade` is a small QTI 2.1 response processor. It takes the values a student could give and runs the item's response processing the
 * way the standard says: the operators the exporter writes (match, mapResponse, isNull, and, or, not, sum) and nothing else, so an
 * operator it does not know stops the test and does not score. `problems` reads a package against the structure the standard and the
 * IMS packaging rules describe. Both are written apart from the exporter, so that a question is right only when exactly its key
 * scores and nothing else does.
 */

import assert from "node:assert/strict";

import { unzipSync } from "../../src/container/zip.ts";
import { allText, elements, first, parseXml, type XmlElement } from "../../src/import/docx/xml.ts";

export interface Pack21 {
  files: Map<string, Uint8Array>;
  manifest: XmlElement;
  test: XmlElement;
  /** The items, in the order the test lists them, each read from the file the test's reference names. */
  items: Array<{ ref: XmlElement; doc: XmlElement; href: string }>;
  text: (name: string) => string;
}

export function readPackage21(bytes: Uint8Array | undefined): Pack21 {
  assert.ok(bytes, "a package has bytes");
  const files = unzipSync(bytes);
  const text = (n: string): string => Buffer.from(files.get(n) ?? new Uint8Array()).toString("utf8");
  const test = parseXml(text("assessmentTest.xml"));
  // A reference to a file that is not in the zip reads as an element with that name, so that the structure check can say so.
  const items = descend(test, "assessmentItemRef").map((ref) => ({ ref, href: attr(ref, "href"), doc: files.has(attr(ref, "href")) ? parseXml(text(attr(ref, "href"))) : { name: "(missing)", attrs: {}, children: [] } }));
  return { files, manifest: parseXml(text("imsmanifest.xml")), test, items, text };
}

export const attr = (el: XmlElement, name: string): string => el.attrs[name] ?? "";

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

export const subsets = <T,>(xs: T[]): T[][] => xs.reduce<T[][]>((acc, x) => acc.concat(acc.map((s) => [...s, x])), [[]]);

/** The words of a piece of XHTML or MathML, as a person reads them. */
export const wordsOf = (el: XmlElement): string => allText(el).replace(/\s+/g, " ").trim();

// ---------------------------------------------------------------------------
// The response processor
// ---------------------------------------------------------------------------

type Value =
  | { t: "container"; card: string; base: string; values: string[] }
  | { t: "number"; n: number }
  | { t: "bool"; b: boolean }
  | null;

/** What a student gave: for each response, the values. An empty list is no response. */
export type Given = Record<string, string[]>;

const declaration = (item: XmlElement, id: string): XmlElement => {
  const found = elements(item, "responseDeclaration").find((d) => attr(d, "identifier") === id);
  assert.ok(found, `a variable ${id} that no responseDeclaration declares`);
  return found;
};

const valuesOf = (el: XmlElement | undefined): string[] => (el ? elements(el, "value").map((v) => allText(v).trim()) : []);

/** Whether two values mean the same under a mapping entry's case rule. */
const sameKey = (given: string, key: string, caseSensitive: boolean): boolean => (caseSensitive ? given === key : given.toLowerCase() === key.toLowerCase());

function mapResponse(item: XmlElement, id: string, given: Given): number {
  const d = declaration(item, id);
  const mapping = first(d, "mapping");
  assert.ok(mapping, `mapResponse on ${id}, which has no mapping`);
  const dflt = Number(attr(mapping, "defaultValue") || 0);
  const values = given[id] ?? [];
  if (values.length === 0) return dflt;
  const entries = elements(mapping, "mapEntry");
  const one = (v: string): number => {
    // The first entry that matches is the one used, as the standard says.
    const hit = entries.find((e) => sameKey(v, attr(e, "mapKey"), attr(e, "caseSensitive") === "" ? true : attr(e, "caseSensitive") === "true"));
    return hit ? Number(attr(hit, "mappedValue")) : dflt;
  };
  // A value that is in a container twice is counted once.
  const total = attr(d, "cardinality") === "single" ? one(values[0] as string) : [...new Set(values)].reduce((sum, v) => sum + one(v), 0);
  const low = attr(mapping, "lowerBound") === "" ? -Infinity : Number(attr(mapping, "lowerBound"));
  const high = attr(mapping, "upperBound") === "" ? Infinity : Number(attr(mapping, "upperBound"));
  return Math.min(high, Math.max(low, total));
}

function evaluate(node: XmlElement, item: XmlElement, given: Given, outcomes: Map<string, number>): Value {
  switch (node.name) {
    case "variable": {
      const id = attr(node, "identifier");
      if (outcomes.has(id)) return { t: "number", n: outcomes.get(id) as number };
      const d = declaration(item, id);
      const values = given[id] ?? [];
      return values.length === 0 ? null : { t: "container", card: attr(d, "cardinality"), base: attr(d, "baseType"), values };
    }
    case "correct": {
      const d = declaration(item, attr(node, "identifier"));
      const values = valuesOf(first(d, "correctResponse"));
      return values.length === 0 ? null : { t: "container", card: attr(d, "cardinality"), base: attr(d, "baseType"), values };
    }
    case "baseValue":
      return { t: "number", n: Number(allText(node).trim()) };
    case "mapResponse":
      return { t: "number", n: mapResponse(item, attr(node, "identifier"), given) };
    case "isNull": {
      const v = evaluate(elements(node)[0] as XmlElement, item, given, outcomes);
      return { t: "bool", b: v === null };
    }
    case "match": {
      const [a, b] = elements(node).map((c) => evaluate(c, item, given, outcomes));
      if (a === null || b === null || a === undefined || b === undefined) return null;
      assert.ok(a.t === "container" && b.t === "container", "match compares two containers or two single values");
      if (a.card !== b.card) return { t: "bool", b: false };
      // Multiple containers are compared without regard to order, ordered ones in order, as the standard says.
      const x = a.card === "ordered" ? a.values : [...a.values].sort();
      const y = b.card === "ordered" ? b.values : [...b.values].sort();
      return { t: "bool", b: x.length === y.length && x.every((v, i) => v === y[i]) };
    }
    case "and":
    case "or": {
      const vs = elements(node).map((c) => evaluate(c, item, given, outcomes));
      const truth = vs.map((v) => v !== null && v.t === "bool" && v.b);
      return { t: "bool", b: node.name === "and" ? truth.every(Boolean) : truth.some(Boolean) };
    }
    case "not": {
      const v = evaluate(elements(node)[0] as XmlElement, item, given, outcomes);
      return v === null ? null : { t: "bool", b: !(v.t === "bool" && v.b) };
    }
    case "sum":
      return { t: "number", n: elements(node).reduce((s, c) => s + ((evaluate(c, item, given, outcomes) as { n: number } | null)?.n ?? 0), 0) };
    default:
      throw new Error(`an operator this response processor does not know: ${node.name}`);
  }
}

function runRules(rules: XmlElement[], item: XmlElement, given: Given, outcomes: Map<string, number>): void {
  for (const rule of rules) {
    if (rule.name === "setOutcomeValue") {
      const v = evaluate(elements(rule)[0] as XmlElement, item, given, outcomes);
      assert.ok(v !== null && v.t === "number", "setOutcomeValue sets a number");
      outcomes.set(attr(rule, "identifier"), v.n);
    } else if (rule.name === "responseCondition") {
      for (const branch of elements(rule)) {
        if (branch.name === "responseElse") {
          runRules(elements(branch), item, given, outcomes);
          break;
        }
        const [test, ...body] = elements(branch);
        const v = evaluate(test as XmlElement, item, given, outcomes);
        if (v !== null && v.t === "bool" && v.b) {
          runRules(body, item, given, outcomes);
          break;
        }
      }
    } else {
      throw new Error(`a rule this response processor does not know: ${rule.name}`);
    }
  }
}

/** The score of the values a student gave, worked out by the item's own response processing. An item with none scores its default. */
export function grade(item: XmlElement, given: Given): number {
  const outcomes = new Map<string, number>();
  for (const o of elements(item, "outcomeDeclaration")) outcomes.set(attr(o, "identifier"), Number(allText(o).trim() || 0));
  const processing = first(item, "responseProcessing");
  if (processing) {
    assert.equal(attr(processing, "template"), "", "a template is a processing this processor does not run");
    runRules(elements(processing), item, given, outcomes);
  }
  return Math.round((outcomes.get("SCORE") ?? 0) * 100000) / 100000;
}

/** The most a question can score: the top of its SCORE. */
export const pointsOf = (item: XmlElement): number => Number(attr(elements(item, "outcomeDeclaration").find((o) => attr(o, "identifier") === "SCORE") as XmlElement, "normalMaximum"));

export interface Choice {
  id: string;
  text: string;
  fixed: boolean;
}

/** The choices of the one choiceInteraction, with the words of each. */
export const choicesOf = (item: XmlElement): Choice[] =>
  descend(first(item, "itemBody") as XmlElement, "simpleChoice").map((c) => ({ id: attr(c, "identifier"), text: wordsOf(c), fixed: attr(c, "fixed") === "true" }));

/** The two lists of the one matchInteraction. */
export const setsOf = (item: XmlElement): Array<Array<{ id: string; text: string; matchMax: number }>> =>
  descend(first(item, "itemBody") as XmlElement, "simpleMatchSet").map((s) => elements(s, "simpleAssociableChoice").map((c) => ({ id: attr(c, "identifier"), text: wordsOf(c), matchMax: Number(attr(c, "matchMax")) })));

// ---------------------------------------------------------------------------
// The structure
// ---------------------------------------------------------------------------

const NCNAME = /^[A-Za-z_][A-Za-z0-9_.-]*$/;
const INTERACTIONS = ["choiceInteraction", "textEntryInteraction", "extendedTextInteraction", "matchInteraction"];
const XHTML = new Set(["div", "p", "br", "strong", "em", "sub", "sup", "code", "pre", "ul", "ol", "li", "blockquote", "table", "thead", "tbody", "tr", "th", "td", "img", "math"]);
const QTI_PARTS = new Set(["choiceInteraction", "simpleChoice", "textEntryInteraction", "extendedTextInteraction", "matchInteraction", "simpleMatchSet", "simpleAssociableChoice"]);
const OPERATORS = new Set(["match", "mapResponse", "isNull", "and", "or", "not", "sum", "variable", "correct", "baseValue"]);

/** What the standard and the packaging rules say is wrong with a package, which is nothing for one that follows them. */
export function problems(pack: Pack21): string[] {
  const found: string[] = [];

  // The package: a manifest at the root, a test and an item resource for each question, and every file accounted for.
  const m = pack.manifest;
  if (m.name !== "manifest") found.push(`the manifest's root is ${m.name}`);
  if (!attr(m, "identifier")) found.push("the manifest has no identifier");
  const resources = descend(m, "resource");
  const ids = new Set<string>();
  const listed = new Set<string>(["imsmanifest.xml"]);
  for (const r of resources) {
    const id = attr(r, "identifier");
    if (!NCNAME.test(id) || ids.has(id)) found.push(`the resource identifier ${id} is not a valid, single identifier`);
    ids.add(id);
    if (!["imsqti_test_xmlv2p1", "imsqti_item_xmlv2p1"].includes(attr(r, "type"))) found.push(`the resource ${id} has the type ${attr(r, "type")}`);
    const files = elements(r, "file").map((f) => attr(f, "href"));
    if (!files.includes(attr(r, "href"))) found.push(`the resource ${id} does not list its own file`);
    for (const f of files) {
      listed.add(f);
      if (!pack.files.has(f)) found.push(`the file ${f} is listed and is not in the zip`);
    }
  }
  const tests = resources.filter((r) => attr(r, "type") === "imsqti_test_xmlv2p1");
  const itemResources = resources.filter((r) => attr(r, "type") === "imsqti_item_xmlv2p1");
  if (tests.length !== 1) found.push(`${tests.length} test resources, not one`);
  else {
    const needs = elements(tests[0] as XmlElement, "dependency").map((d) => attr(d, "identifierref"));
    for (const need of needs) if (!itemResources.some((r) => attr(r, "identifier") === need)) found.push(`the test depends on ${need}, which is not an item resource`);
    for (const r of itemResources) if (!needs.includes(attr(r, "identifier"))) found.push(`the item resource ${attr(r, "identifier")} is not a dependency of the test`);
  }
  for (const name of pack.files.keys()) {
    if (name.startsWith("/") || name.includes("..") || name.includes("\\")) found.push(`the entry name ${name} is not a plain relative path`);
    if (!listed.has(name)) found.push(`the file ${name} is in the zip and no resource lists it`);
  }

  // The test.
  const t = pack.test;
  if (t.name !== "assessmentTest") found.push(`the test's root is ${t.name}`);
  if (!NCNAME.test(attr(t, "identifier")) || attr(t, "title") === "") found.push("the test has no valid identifier and title");
  const parts = elements(t, "testPart");
  if (parts.length < 1) found.push("the test has no testPart");
  for (const p of parts) {
    if (!["linear", "nonlinear"].includes(attr(p, "navigationMode")) || !["individual", "simultaneous"].includes(attr(p, "submissionMode"))) found.push("a testPart's modes are not the standard's");
    if (elements(p, "assessmentSection").length < 1) found.push("a testPart has no section");
  }
  const refs = descend(t, "assessmentItemRef");
  if (refs.length !== itemResources.length) found.push(`${refs.length} item references and ${itemResources.length} item resources`);
  const seen = new Set<string>();
  for (const ref of refs) {
    const id = attr(ref, "identifier");
    if (!NCNAME.test(id) || seen.has(id)) found.push(`the item reference ${id} is not a valid, single identifier`);
    seen.add(id);
    if (!itemResources.some((r) => attr(r, "href") === attr(ref, "href"))) found.push(`the reference ${id} names ${attr(ref, "href")}, which no item resource has`);
  }
  if (!first(t, "outcomeProcessing")) found.push("the test has no outcome processing to add the scores");

  for (const { ref, doc } of pack.items) found.push(...itemProblems(doc, attr(ref, "identifier"), pack));
  return found;
}

function itemProblems(item: XmlElement, expected: string, pack: Pack21): string[] {
  const found: string[] = [];
  const where = `item ${expected}`;
  if (item.name !== "assessmentItem") return [`${where}: the root is ${item.name}`];
  if (attr(item, "identifier") !== expected) found.push(`${where}: its identifier is ${attr(item, "identifier")}, not what the test refers to`);
  if (attr(item, "title") === "") found.push(`${where}: no title`);
  if (attr(item, "adaptive") !== "false" || attr(item, "timeDependent") !== "false") found.push(`${where}: adaptive and timeDependent are false`);

  // The order of the parts: declarations, then the body, then the processing.
  const order = elements(item).map((c) => c.name);
  const rank = (n: string): number => ["responseDeclaration", "outcomeDeclaration", "itemBody", "responseProcessing"].indexOf(n);
  if (order.some((n) => rank(n) < 0) || order.some((n, i) => i > 0 && rank(n) < rank(order[i - 1] as string))) found.push(`${where}: the parts are not in the standard's order (${order.join(", ")})`);

  const decls = elements(item, "responseDeclaration");
  const response = decls[0];
  if (decls.length !== 1 || !response || attr(response, "identifier") !== "RESPONSE") return [...found, `${where}: one responseDeclaration named RESPONSE`];
  const card = attr(response, "cardinality");
  const base = attr(response, "baseType");
  if (!["single", "multiple", "ordered"].includes(card)) found.push(`${where}: cardinality ${card}`);
  if (!["identifier", "string", "directedPair"].includes(base)) found.push(`${where}: baseType ${base}`);

  const score = elements(item, "outcomeDeclaration").find((o) => attr(o, "identifier") === "SCORE");
  if (!score || attr(score, "baseType") !== "float" || attr(score, "cardinality") !== "single") found.push(`${where}: SCORE is a single float`);
  else if (!(Number(attr(score, "normalMaximum")) > 0) || Number(attr(score, "normalMinimum")) !== 0) found.push(`${where}: SCORE's normal range is 0 to the points`);

  const body = first(item, "itemBody");
  if (!body) return [...found, `${where}: no itemBody`];
  const interactions = descend(body, "choiceInteraction").concat(descend(body, "textEntryInteraction"), descend(body, "extendedTextInteraction"), descend(body, "matchInteraction"));
  if (interactions.length !== 1) return [...found, `${where}: ${interactions.length} interactions, not one`];
  const interaction = interactions[0] as XmlElement;
  if (attr(interaction, "responseIdentifier") !== "RESPONSE") found.push(`${where}: the interaction answers ${attr(interaction, "responseIdentifier")}`);
  if (!INTERACTIONS.includes(interaction.name)) found.push(`${where}: ${interaction.name}`);

  // The markup of the question: the XHTML the standard allows, closed, with its pictures in the package and described.
  const walk = (el: XmlElement): void => {
    for (const c of elements(el)) {
      if (c.name === "math") continue; // MathML is checked as a whole below
      if (!XHTML.has(c.name) && !QTI_PARTS.has(c.name)) found.push(`${where}: <${c.name}> is not markup a QTI 2.1 question may hold`);
      if (c.name === "img") {
        const src = attr(c, "src");
        if (!pack.files.has(src)) found.push(`${where}: a picture at ${src}, which is not in the zip`);
        if (!("alt" in c.attrs)) found.push(`${where}: a picture with no alt attribute`);
      }
      walk(c);
    }
  };
  walk(body);
  for (const math of descend(body, "math")) if (math.children.length === 0) found.push(`${where}: an empty equation`);

  // The interaction against the declaration.
  const correct = valuesOf(first(response, "correctResponse"));
  const mapKeys = elements(first(response, "mapping") ?? response, "mapEntry").map((e) => attr(e, "mapKey"));
  if (interaction.name === "choiceInteraction") {
    const choices = elements(interaction, "simpleChoice").map((c) => attr(c, "identifier"));
    if (base !== "identifier" || !["single", "multiple"].includes(card)) found.push(`${where}: a choice is a single or multiple identifier`);
    if (new Set(choices).size !== choices.length || choices.some((c) => !NCNAME.test(c))) found.push(`${where}: choice identifiers are not unique, valid ones`);
    if (choices.length < 2) found.push(`${where}: fewer than two choices`);
    if ((attr(interaction, "maxChoices") === "1") !== (card === "single")) found.push(`${where}: maxChoices does not agree with the cardinality`);
    for (const v of [...correct, ...mapKeys]) if (!choices.includes(v)) found.push(`${where}: ${v} is declared and not offered`);
    if (card === "single" && correct.length !== 1) found.push(`${where}: a single response has ${correct.length} correct values`);
    if (correct.length < 1) found.push(`${where}: no correct response`);
    if (attr(interaction, "shuffle") !== "true" && elements(interaction, "simpleChoice").some((c) => attr(c, "fixed") === "true")) found.push(`${where}: an answer is fixed in a list that is not mixed`);
  } else if (interaction.name === "textEntryInteraction") {
    if (base !== "string" || card !== "single") found.push(`${where}: a text box is a single string`);
    if (correct.length < 1 || mapKeys.length < 1) found.push(`${where}: a text box with no accepted answer`);
    if (new Set(mapKeys.map((k) => k)).size !== mapKeys.length) found.push(`${where}: the same key twice in the mapping`);
  } else if (interaction.name === "extendedTextInteraction") {
    if (base !== "string" || card !== "single") found.push(`${where}: an essay is a single string`);
    if (first(response, "correctResponse") || first(response, "mapping")) found.push(`${where}: an essay with a correct response`);
  } else {
    const sets = elements(interaction, "simpleMatchSet").map((s) => elements(s, "simpleAssociableChoice"));
    if (sets.length !== 2) found.push(`${where}: a match has two lists`);
    if (base !== "directedPair" || card !== "multiple") found.push(`${where}: a match is a multiple directedPair`);
    const idsOf = (s: XmlElement[] | undefined): string[] => (s ?? []).map((c) => attr(c, "identifier"));
    const all = [...idsOf(sets[0]), ...idsOf(sets[1])];
    if (new Set(all).size !== all.length || all.some((c) => !NCNAME.test(c))) found.push(`${where}: choice identifiers are not unique, valid ones`);
    for (const c of sets.flat()) if (!(Number(attr(c, "matchMax")) >= 1)) found.push(`${where}: a choice with no matchMax of at least 1`);
    for (const v of [...correct, ...mapKeys]) {
      const [l, r] = v.split(" ");
      if (!idsOf(sets[0]).includes(l ?? "") || !idsOf(sets[1]).includes(r ?? "")) found.push(`${where}: ${v} is not a pair of a left choice and a right choice`);
    }
    const uses = new Map<string, number>();
    for (const v of correct) uses.set(v.split(" ")[1] as string, (uses.get(v.split(" ")[1] as string) ?? 0) + 1);
    for (const c of sets[1] ?? []) if ((uses.get(attr(c, "identifier")) ?? 0) > Number(attr(c, "matchMax"))) found.push(`${where}: a right choice used more often than its matchMax`);
    if (Number(attr(interaction, "maxAssociations")) < correct.length) found.push(`${where}: maxAssociations is fewer than the pairs`);
  }

  // The mapping.
  const mapping = first(response, "mapping");
  if (mapping) {
    for (const e of elements(mapping, "mapEntry")) if (Number.isNaN(Number(attr(e, "mappedValue")))) found.push(`${where}: a mappedValue that is not a number`);
    if (Number.isNaN(Number(attr(mapping, "defaultValue")))) found.push(`${where}: a mapping default that is not a number`);
  }

  // The processing: only the operators the standard has, naming variables that exist.
  const processing = first(item, "responseProcessing");
  if (interaction.name === "extendedTextInteraction" && processing) found.push(`${where}: an essay with response processing`);
  if (interaction.name !== "extendedTextInteraction" && !processing) found.push(`${where}: no response processing`);
  if (processing) {
    const walkOps = (el: XmlElement): void => {
      for (const c of elements(el)) {
        if (["responseCondition", "responseIf", "responseElseIf", "responseElse", "setOutcomeValue"].includes(c.name)) {
          if (c.name === "setOutcomeValue" && attr(c, "identifier") !== "SCORE") found.push(`${where}: setOutcomeValue on ${attr(c, "identifier")}`);
        } else if (!OPERATORS.has(c.name)) found.push(`${where}: the operator ${c.name}`);
        if (["variable", "correct", "mapResponse"].includes(c.name) && attr(c, "identifier") !== "RESPONSE") found.push(`${where}: ${c.name} of ${attr(c, "identifier")}`);
        if (c.name === "mapResponse" && !mapping) found.push(`${where}: mapResponse with no mapping`);
        walkOps(c);
      }
    };
    walkOps(processing);
  }
  return found;
}
