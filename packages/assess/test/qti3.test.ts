/**
 * QTI 3.0: the 2.1 package in 3.0's spelling, written and read through one renaming. Held here: the package is spelled as 3.0 (every
 * QTI element `qti-` and kebab case, the 3.0 namespace, templates and resource types, XHTML and MathML as they were), a 3.0 item written
 * from the specification is read with the key it states, and every fixture reads to the same questions from 3.0 as from 2.1. The
 * round trip of every fixture through the 3.0 exporter is in `import-qti.test.ts` beside the other QTI exporters.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { textEntry, unzipSync, zipSync } from "../src/container/zip.ts";
import { exportQti21 } from "../src/export/qti21.ts";
import { exportQti30, QTI30_ID } from "../src/export/qti30.ts";
import { fromQti3, QTI3_ITEM_TYPE, QTI3_NAMESPACE, toQti3, xmlText } from "../src/export/qti3.ts";
import { parseXml } from "../src/import/docx/xml.ts";
import { importerForContent, runImporter } from "../src/import/registry.ts";
import { verdictOf } from "../src/import/types.ts";
import type { Question } from "../src/model/question.ts";

const AT = "2026-01-01T00:00:00.000Z";
const fixtures = fileURLToPath(new URL("../../../fixtures/standard-format/", import.meta.url));
const load = (name: string) => {
  const bytes = new Uint8Array(readFileSync(join(fixtures, name)));
  return runImporter(importerForContent(name, bytes), bytes, { file: name, at: AT, author: "test" });
};
const read = (name: string, bytes: Uint8Array) => runImporter(importerForContent(name, bytes), bytes, { file: name, at: AT, author: "test" });

describe("the QTI 3.0 package", () => {
  const source = load("03-mixed-types.txt");
  const out = exportQti30(source.questions, { name: "Bank" });
  const files = unzipSync(out.files[0]?.bytes as Uint8Array);
  const text = (name: string) => new TextDecoder().decode(files.get(name));

  test("is named and reported as 3.0, and says to check the learning system reads it", () => {
    assert.equal(out.files[0]?.name, "Bank - QTI 3.0.zip");
    assert.equal(out.report.destination, QTI30_ID);
    assert.match(out.report.general[0] ?? "", /Check whether your learning system imports it/);
    assert.ok(out.report.items.every((i) => i.notes.every((n) => !n.includes("QTI 2.1"))));
  });

  test("spells every QTI element and attribute as 3.0, and leaves no 2.1 name behind", () => {
    const choice = [...files.keys()].find((n) => /^q\d+\.xml$/.test(n) && text(n).includes("<qti-choice-interaction")) as string;
    const item = text(choice);
    assert.match(item, /^<\?xml version="1\.0" encoding="UTF-8"\?>\n<qti-assessment-item xmlns="http:\/\/www\.imsglobal\.org\/xsd\/imsqtiasi_v3p0" xmlns:xsi=/);
    assert.match(item, /<qti-choice-interaction response-identifier="RESPONSE" [^>]*max-choices="\d+"/);
    assert.match(item, /<qti-response-processing template="https:\/\/purl\.imsglobal\.org\/spec\/qti\/v3p0\/rptemplates\/(match_correct|map_response)\.xml"\/>|<qti-response-processing>/);
    assert.match(item, /<qti-response-declaration identifier="RESPONSE" cardinality="[a-z]+" base-type="identifier">/);
    assert.match(item, /<qti-correct-response><qti-value>/);
    assert.doesNotMatch(item, /<(assessmentItem|responseDeclaration|choiceInteraction|simpleChoice|itemBody|value)[\s>/]/);
    assert.doesNotMatch(item, /\b(baseType|responseIdentifier|maxChoices)=/);
    assert.doesNotMatch(item, /imsqti_v2p1|qti_v2p1/);
    const test = text("assessmentTest.xml");
    assert.match(test, /<qti-assessment-test /);
    assert.match(test, /<qti-assessment-item-ref identifier="q1" href="q1\.xml"\/>/);
    const manifest = text("imsmanifest.xml");
    assert.match(manifest, new RegExp(`type="${QTI3_ITEM_TYPE}"`));
    assert.match(manifest, /<schemaversion>3\.0\.0<\/schemaversion>/);
    assert.doesNotMatch(manifest, /v2p1/);
  });

  test("the renaming goes back to the 2.1 it came from, and XHTML and MathML keep their names", () => {
    const xml21 = new TextDecoder().decode(unzipSync(exportQti21(source.questions, { name: "Bank" }).files[0]?.bytes as Uint8Array).get("q1.xml"));
    const tree = parseXml(xml21);
    // The reader keeps no namespace declarations, and the renaming writes them, so they are set aside to compare.
    const bare = (s: string): string => s.replace(/ xmlns(:[a-z]+)?="[^"]*"/g, "");
    assert.equal(bare(xmlText(fromQti3(toQti3(tree)))), bare(xmlText(tree)));
    const math = toQti3(parseXml('<assessmentItem xmlns="http://www.imsglobal.org/xsd/imsqti_v2p1"><itemBody><p>Solve <math xmlns="http://www.w3.org/1998/Math/MathML"><mi>x</mi><mo>=</mo><mn>2</mn></math> <img src="a.png" alt="A"/></p></itemBody></assessmentItem>'));
    assert.match(xmlText(math), /<qti-item-body><p>Solve <math xmlns="http:\/\/www\.w3\.org\/1998\/Math\/MathML"><mi>x<\/mi><mo>=<\/mo><mn>2<\/mn><\/math> <img src="a\.png" alt="A"\/><\/p><\/qti-item-body>/);
  });
});

describe("reading QTI 3.0", () => {
  test("a 3.0 item written from the specification is read with the key it states", () => {
    const item = `<?xml version="1.0" encoding="UTF-8"?>
<qti-assessment-item xmlns="${QTI3_NAMESPACE}" identifier="item1" title="Capitals" adaptive="false" time-dependent="false">
  <qti-response-declaration identifier="RESPONSE" cardinality="single" base-type="identifier">
    <qti-correct-response><qti-value>B</qti-value></qti-correct-response>
  </qti-response-declaration>
  <qti-outcome-declaration identifier="SCORE" cardinality="single" base-type="float"><qti-default-value><qti-value>0</qti-value></qti-default-value></qti-outcome-declaration>
  <qti-item-body>
    <qti-choice-interaction response-identifier="RESPONSE" shuffle="false" max-choices="1">
      <qti-prompt>Which city is the capital of France?</qti-prompt>
      <qti-simple-choice identifier="A">Lyon</qti-simple-choice>
      <qti-simple-choice identifier="B">Paris</qti-simple-choice>
      <qti-simple-choice identifier="C">Nice</qti-simple-choice>
    </qti-choice-interaction>
  </qti-item-body>
  <qti-response-processing template="https://purl.imsglobal.org/spec/qti/v3p0/rptemplates/match_correct.xml"/>
</qti-assessment-item>`;
    const back = read("item1.xml", new TextEncoder().encode(item));
    assert.equal(back.questions.length, 1);
    const q = back.questions[0] as Question & { body: { options: Array<{ correct: boolean }> } };
    assert.equal(q.type, "multipleChoice");
    assert.deepEqual(q.body.options.map((o) => o.correct), [false, true, false]);
    assert.equal(verdictOf(q), "parsed");
  });

  test("a 3.0 item with no correct response is read with no key, and says so", () => {
    const item = `<qti-assessment-item xmlns="${QTI3_NAMESPACE}" identifier="i" title="No key"><qti-response-declaration identifier="RESPONSE" cardinality="single" base-type="identifier"/><qti-item-body><qti-choice-interaction response-identifier="RESPONSE" max-choices="1"><qti-prompt>Pick one.</qti-prompt><qti-simple-choice identifier="A">One</qti-simple-choice><qti-simple-choice identifier="B">Two</qti-simple-choice></qti-choice-interaction></qti-item-body></qti-assessment-item>`;
    const q = read("i.xml", new TextEncoder().encode(item)).questions[0] as Question & { body: { options: Array<{ correct: boolean }> } };
    assert.ok(q.body.options.every((o) => !o.correct), "no key is guessed");
    assert.notEqual(verdictOf(q), "parsed");
  });

  test("a question that refers to a shared passage says so, and the passage is kept as text no question claimed (found by a review)", () => {
    const item = `<qti-assessment-item xmlns="${QTI3_NAMESPACE}" identifier="i1" title="With a passage"><qti-assessment-stimulus-ref identifier="s1" href="s1.xml"/><qti-response-declaration identifier="RESPONSE" cardinality="single" base-type="identifier"><qti-correct-response><qti-value>A</qti-value></qti-correct-response></qti-response-declaration><qti-item-body><qti-choice-interaction response-identifier="RESPONSE" max-choices="1"><qti-prompt>Pick one</qti-prompt><qti-simple-choice identifier="A">One</qti-simple-choice><qti-simple-choice identifier="B">Two</qti-simple-choice></qti-choice-interaction></qti-item-body></qti-assessment-item>`;
    const stimulus = `<qti-assessment-stimulus xmlns="${QTI3_NAMESPACE}" identifier="s1" title="Passage"><qti-stimulus-body><p>The river rose three metres in one night.</p></qti-stimulus-body></qti-assessment-stimulus>`;
    const zip = zipSync([textEntry("i1.xml", item), textEntry("s1.xml", stimulus)]);
    const back = read("passage.zip", zip);
    assert.equal(back.questions.length, 1);
    const q = back.questions[0] as Question;
    assert.equal(verdictOf(q), "needsReview");
    assert.ok(q.findings.some((f) => /refers to a passage kept in another file \(s1\.xml\)/.test(f.message)), q.findings.map((f) => f.message).join(" | "));
    assert.equal(back.orphans.length, 1);
    assert.match(back.orphans[0]?.text ?? "", /The river rose three metres in one night\./);
  });

  test("every fixture reads to the same questions from 3.0 as from 2.1", () => {
    let compared = 0;
    for (const name of readdirSync(fixtures).filter((n) => /\.(txt|docx)$/.test(n))) {
      const source = load(name);
      const a = exportQti21(source.questions, { name: "Bank" });
      const b = exportQti30(source.questions, { name: "Bank" });
      if (a.files.length === 0) {
        assert.equal(b.files.length, 0, name);
        continue;
      }
      const from21 = read("Bank.zip", a.files[0]?.bytes as Uint8Array);
      const from30 = read("Bank.zip", b.files[0]?.bytes as Uint8Array);
      const strip = (qs: Question[]) => qs.map((q) => ({ ...q, id: "", history: [], origin: undefined, findings: q.findings.map((f) => ({ ...f, id: "" })) }));
      assert.deepEqual(strip(from30.questions), strip(from21.questions), name);
      assert.deepEqual(b.report.items.map((i) => i.outcome), a.report.items.map((i) => i.outcome), name);
      compared += from30.questions.length;
    }
    assert.ok(compared >= 40, `only ${compared} questions compared`);
  });
});
