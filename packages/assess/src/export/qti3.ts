/**
 * QTI 3.0, as a renaming of QTI 2.1.
 *
 * QTI 3.0 keeps 2.1's model of an item (a response declaration that states the correct response, an item body with interactions,
 * response processing) and changes how it is spelled: every QTI element gets the prefix `qti-` and is written in lower case with
 * hyphens (`choiceInteraction` is `qti-choice-interaction`), its attributes are written the same way (`responseIdentifier` is
 * `response-identifier`), the namespace and the response processing templates have new addresses, and the package's resource types
 * say 3.0. The XHTML of an item's text and MathML are as they were.
 *
 * So the exporter writes 2.1 with the 2.1 writer and renames it, and the reader renames 3.0 back and reads it as 2.1. One renaming,
 * used both ways, means the key a 3.0 file states is read exactly as the same 2.1 file's would be, and the 2.1 writer's rules (a
 * question worth no points written as worth 1, and the rest) hold for 3.0 without being written twice. Anything with a `:` in its name
 * (`xml:lang`, `xsi:schemaLocation`, `xmlns:m`) and anything inside `math` is left alone.
 *
 * Written from the QTI 3.0 specification (1EdTech, final release), not from a file a learning system wrote: no system here has been
 * given one yet (`TESTING-TODO.md`).
 */

import type { XmlElement, XmlNode } from "../import/docx/xml.ts";

export const QTI3_NAMESPACE = "http://www.imsglobal.org/xsd/imsqtiasi_v3p0";
export const QTI3_SCHEMA = "https://purl.imsglobal.org/spec/qti/v3p0/schema/xsd/imsqti_asiv3p0_v1p0.xsd";
export const QTI3_CP_NAMESPACE = "http://www.imsglobal.org/xsd/qti/qtiv3p0/imscp_v1p1";
export const QTI3_ITEM_TYPE = "imsqti_item_xmlv3p0";
export const QTI3_TEST_TYPE = "imsqti_test_xmlv3p0";

const QTI21_NAMESPACE = "http://www.imsglobal.org/xsd/imsqti_v2p1";
const QTI21_SCHEMA = "http://www.imsglobal.org/xsd/qti/qtiv2p1/imsqti_v2p1.xsd";

/** The response processing templates, 2.1 and 3.0. */
const TEMPLATES: ReadonlyArray<readonly [string, string]> = ["match_correct", "map_response", "map_response_point"].map((t) => [`http://www.imsglobal.org/question/qti_v2p1/rptemplates/${t}`, `https://purl.imsglobal.org/spec/qti/v3p0/rptemplates/${t}.xml`] as const);

/** The elements of an item's text that are XHTML, which keep their names in 3.0. */
const XHTML = new Set("a abbr address b big blockquote br caption cite code col colgroup dd dfn div dl dt em h1 h2 h3 h4 h5 h6 hr i img kbd li object ol p param pre q samp small span strong sub sup table tbody td tfoot th thead tr tt u ul var".split(" "));

const kebab = (name: string): string => name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
const camel = (name: string): string => name.replace(/-([a-z0-9])/g, (_m, c: string) => c.toUpperCase());

const XSI = "http://www.w3.org/2001/XMLSchema-instance";
const MATHML = "http://www.w3.org/1998/Math/MathML";

/**
 * The XML reader keeps no namespace declarations (it gives each element its name as written), so a tree written out again has to
 * declare them: the document's own on the root, and MathML's on each equation. Without them the file is not well formed, which is
 * how the first version of this exporter wrote a package its own reader refused.
 */
function declared(el: XmlElement, own: string | undefined): XmlElement {
  const attrs: Record<string, string> = {};
  if (own !== undefined) {
    attrs["xmlns"] = own;
    if (Object.keys(el.attrs).some((k) => k.startsWith("xsi:"))) attrs["xmlns:xsi"] = XSI;
  }
  return { ...el, attrs: { ...attrs, ...el.attrs } };
}

function withMathNamespace(el: XmlElement): XmlElement {
  const colon = el.name.indexOf(":");
  const key = colon < 0 ? "xmlns" : `xmlns:${el.name.slice(0, colon)}`;
  return el.attrs[key] !== undefined ? el : { ...el, attrs: { [key]: MATHML, ...el.attrs } };
}

function rename(el: XmlElement, element: (name: string) => string | undefined, attribute: (name: string) => string, value: (name: string, v: string) => string): XmlElement {
  if (el.name === "math" || el.name.endsWith(":math")) return withMathNamespace(el);
  const renamed = element(el.name);
  const attrs: Record<string, string> = {};
  for (const [k, v] of Object.entries(el.attrs)) {
    const key = renamed !== undefined && !k.includes(":") && k !== "xmlns" ? attribute(k) : k;
    attrs[key] = value(key, v);
  }
  const children: XmlNode[] = el.children.map((c) => (typeof c === "string" ? c : rename(c, element, attribute, value)));
  return { name: renamed ?? el.name, attrs, children };
}

const swapValue = (pairs: ReadonlyArray<readonly [string, string]>) => (_key: string, v: string): string => pairs.find(([from]) => from === v)?.[1] ?? v;

/** A 2.1 document as 3.0. */
export function toQti3(root: XmlElement): XmlElement {
  const pairs: Array<readonly [string, string]> = [[QTI21_NAMESPACE, QTI3_NAMESPACE], [`${QTI21_NAMESPACE} ${QTI21_SCHEMA}`, `${QTI3_NAMESPACE} ${QTI3_SCHEMA}`], ...TEMPLATES];
  return declared(rename(root, (n) => (XHTML.has(n) || n.includes(":") ? undefined : `qti-${kebab(n)}`), kebab, swapValue(pairs)), QTI3_NAMESPACE);
}

/** Part of a 2.1 tree spelled as 3.0, with no namespace declared: what a reader is shown beside a question read from a 3.0 file. */
export function qti3Names(el: XmlElement): XmlElement {
  return rename(el, (n) => (XHTML.has(n) || n.includes(":") ? undefined : `qti-${kebab(n)}`), kebab, (_k, v) => v);
}

/** A 3.0 document as 2.1, for the 2.1 reader. Only `qti-` elements are renamed, so XHTML and MathML pass through. */
export function fromQti3(root: XmlElement): XmlElement {
  const pairs: Array<readonly [string, string]> = [[QTI3_NAMESPACE, QTI21_NAMESPACE], [`${QTI3_NAMESPACE} ${QTI3_SCHEMA}`, `${QTI21_NAMESPACE} ${QTI21_SCHEMA}`], ...TEMPLATES.map(([a, b]) => [b, a] as const)];
  return rename(root, (n) => (n.startsWith("qti-") ? camel(n.slice(4)) : undefined), camel, swapValue(pairs));
}

/** Whether a document's root is a QTI 3.0 item or test. */
export const isQti3Root = (root: XmlElement): boolean => root.name === "qti-assessment-item" || root.name === "qti-assessment-test";

const escapeText = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escapeAttr = (s: string): string => escapeText(s).replace(/"/g, "&quot;");

/** A tree as XML text, every character of its text kept, with the XML declaration. */
export function xmlText(root: XmlElement): string {
  const out: string[] = ['<?xml version="1.0" encoding="UTF-8"?>\n'];
  // A stack and not recursion, so a deep tree cannot run out of stack.
  const stack: Array<XmlNode | { close: string }> = [root];
  while (stack.length > 0) {
    const node = stack.pop() as XmlNode | { close: string };
    if (typeof node === "string") {
      out.push(escapeText(node));
      continue;
    }
    if ("close" in node) {
      out.push(node.close);
      continue;
    }
    const attrs = Object.entries(node.attrs).map(([k, v]) => ` ${k}="${escapeAttr(v)}"`).join("");
    if (node.children.length === 0) {
      out.push(`<${node.name}${attrs}/>`);
      continue;
    }
    out.push(`<${node.name}${attrs}>`);
    stack.push({ close: `</${node.name}>` });
    for (let i = node.children.length - 1; i >= 0; i--) stack.push(node.children[i] as XmlNode);
  }
  out.push("\n");
  return out.join("");
}
