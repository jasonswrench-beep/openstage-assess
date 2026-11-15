/**
 * Export as a QTI 3.0 package: the 2.1 package this program writes, renamed to 3.0 (`qti3.ts`) item by item, with a 3.0 manifest.
 *
 * What a question loses, and which questions are left out, is exactly what the 2.1 export says, since it is the same file spelled
 * another way; the report says so in 3.0's name. Its own reader reads it back (`import-qti.test.ts` holds every fixture to it).
 */

import { parseXml } from "../import/docx/xml.ts";
import { textEntry, unzipSync, zipSync, type ZipEntry } from "../container/zip.ts";
import type { Question } from "../model/question.ts";
import { exportQti21, QTI21_ITEM_TYPE, QTI21_TEST_TYPE, type Qti21Options } from "./qti21.ts";
import { QTI3_CP_NAMESPACE, QTI3_ITEM_TYPE, QTI3_TEST_TYPE, toQti3, xmlText } from "./qti3.ts";
import type { ExportResult } from "./types.ts";
import type { XmlElement, XmlNode } from "../import/docx/xml.ts";

export const QTI30_ID = "qti-3.0";
export const QTI30_LABEL = "QTI 3.0 package";

const CP_NAMESPACE = "http://www.imsglobal.org/xsd/imscp_v1p1";
const CP_SCHEMA = "http://www.imsglobal.org/xsd/imscp_v1p1.xsd";
const QTI3_CP_SCHEMA = "https://purl.imsglobal.org/spec/qti/v3p0/schema/xsd/imsqtiv3p0_imscpv1p2_v1p0.xsd";

/** The 2.1 manifest with 3.0's namespace, resource types and schema name. */
function manifest3(el: XmlElement): XmlElement {
  const swap: Record<string, string> = { [CP_NAMESPACE]: QTI3_CP_NAMESPACE, [`${CP_NAMESPACE} ${CP_SCHEMA}`]: `${QTI3_CP_NAMESPACE} ${QTI3_CP_SCHEMA}`, [QTI21_ITEM_TYPE]: QTI3_ITEM_TYPE, [QTI21_TEST_TYPE]: QTI3_TEST_TYPE };
  const attrs = Object.fromEntries(Object.entries(el.attrs).map(([k, v]) => [k, swap[v] ?? v]));
  let children: XmlNode[] = el.children.map((c) => (typeof c === "string" ? c : manifest3(c)));
  if (el.name === "schema") children = ["QTI Package"];
  if (el.name === "schemaversion") children = ["3.0.0"];
  return { name: el.name, attrs, children };
}

/** The manifest's root, which the XML reader gave back with no namespace declarations. */
const declaredManifest = (el: XmlElement): XmlElement => ({ ...el, attrs: { xmlns: QTI3_CP_NAMESPACE, "xmlns:xsi": "http://www.w3.org/2001/XMLSchema-instance", ...el.attrs } });

export function exportQti30(questions: readonly Question[], options: Qti21Options = {}): ExportResult {
  const base = exportQti21(questions, options);
  const say = (s: string): string => s.replace(/QTI 2\.1/g, "QTI 3.0");
  const from = base.files[0];
  const name = from ? from.name.replace(/ - QTI 2\.1\.zip$/, " - QTI 3.0.zip") : undefined;
  const report = {
    ...base.report,
    destination: QTI30_ID,
    label: QTI30_LABEL,
    files: name ? [name] : [],
    items: base.report.items.map((i) => ({ ...i, notes: i.notes.map(say) })),
    general: [
      "QTI 3.0 is the newest version of the format. Check whether your learning system imports it before you choose it: many read QTI 1.2 or 2.1 and not yet 3.0, and the other packages are there for them.",
      "It is the QTI 2.1 package in QTI 3.0's spelling, so what each question keeps and loses is the same as there.",
      ...base.report.general.filter((g) => !/^In (Canvas|Brightspace):/.test(g)).map(say),
    ],
  };
  if (!from?.bytes || !name) return { files: [], report };
  const entries: ZipEntry[] = [];
  for (const [path, data] of unzipSync(from.bytes)) {
    if (path === "imsmanifest.xml") entries.push(textEntry(path, xmlText(declaredManifest(manifest3(parseXml(new TextDecoder().decode(data)))))));
    else if (path.endsWith(".xml")) entries.push(textEntry(path, xmlText(toQti3(parseXml(new TextDecoder().decode(data))))));
    else entries.push({ name: path, data, store: true });
  }
  return { files: [{ name, content: "", bytes: zipSync(entries), questions: from.questions }], report };
}
