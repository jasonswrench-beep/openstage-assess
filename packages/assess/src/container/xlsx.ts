/**
 * Writing an Excel workbook (.xlsx).
 *
 * Small on purpose: sheets of rows of text, numbers and TRUE or FALSE, with a bold row of names, column widths, a frozen top
 * row, wrapped text and, if asked, a drop-down list on a column. That is what a table of questions needs, for the blank one a
 * person fills in and for the samples. The text goes in shared strings, as Excel itself writes it, so that what this writes is
 * read by the same path as a file that Excel wrote.
 */

import { textEntry, zipSync, type ZipEntry } from "./zip.ts";

export type XlsxCell = string | number | boolean | null | undefined;

export interface XlsxSheet {
  name: string;
  rows: XlsxCell[][];
  /** Column widths in characters, from the first column. */
  widths?: number[];
  /** The first row names the columns: it is bold, shaded and stays in view when the sheet is scrolled. */
  header?: boolean;
  /** A drop-down list on a column (counting from 0), for the rows below the first. */
  dropdown?: { column: number; values: string[]; lastRow: number };
}

const NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

/** Text with what XML cannot hold taken out and what it treats as markup written as references. */
function escape(text: string): string {
  return text
    .replace(/[^\u0009\u000a\u000d -퟿-�\u{10000}-\u{10ffff}]/gu, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** A sheet name Excel accepts: at most 31 characters, none of []:*?/\ and not empty. */
export function sheetName(name: string): string {
  const clean = name.replace(/[[\]:*?/\\]/g, " ").replace(/\s+/g, " ").trim().slice(0, 31);
  return clean === "" ? "Sheet" : clean;
}

function columnLetters(index: number): string {
  let n = index + 1;
  let out = "";
  while (n > 0) {
    out = String.fromCharCode(65 + ((n - 1) % 26)) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

export function writeXlsx(sheets: readonly XlsxSheet[]): Uint8Array {
  if (sheets.length === 0) throw new Error("A workbook needs at least one sheet.");
  const strings: string[] = [];
  const index = new Map<string, number>();
  const shared = (text: string): number => {
    let at = index.get(text);
    if (at === undefined) {
      at = strings.length;
      strings.push(text);
      index.set(text, at);
    }
    return at;
  };

  const used = new Set<string>();
  const names = sheets.map((s) => {
    let name = sheetName(s.name);
    for (let n = 2; used.has(name.toLowerCase()); n++) name = `${sheetName(s.name).slice(0, 28)} ${n}`;
    used.add(name.toLowerCase());
    return name;
  });

  const sheetParts = sheets.map((sheet) => {
    const rows = sheet.rows
      .map((cells, r) => {
        const out = cells
          .map((value, c) => {
            if (value === null || value === undefined || value === "") return "";
            const ref = `${columnLetters(c)}${r + 1}`;
            const style = sheet.header && r === 0 ? ' s="1"' : typeof value === "string" && value.includes("\n") ? ' s="2"' : "";
            if (typeof value === "number") return `<c r="${ref}"${style}><v>${value}</v></c>`;
            if (typeof value === "boolean") return `<c r="${ref}"${style} t="b"><v>${value ? 1 : 0}</v></c>`;
            return `<c r="${ref}"${style} t="s"><v>${shared(value)}</v></c>`;
          })
          .join("");
        return out === "" ? "" : `<row r="${r + 1}">${out}</row>`;
      })
      .join("");
    const columns = sheet.widths && sheet.widths.length > 0 ? `<cols>${sheet.widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join("")}</cols>` : "";
    const view = sheet.header
      ? '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>'
      : '<sheetViews><sheetView workbookViewId="0"/></sheetViews>';
    const list = sheet.dropdown
      ? `<dataValidations count="1"><dataValidation type="list" allowBlank="1" showErrorMessage="0" sqref="${columnLetters(sheet.dropdown.column)}2:${columnLetters(sheet.dropdown.column)}${sheet.dropdown.lastRow}"><formula1>"${escape(sheet.dropdown.values.join(","))}"</formula1></dataValidation></dataValidations>`
      : "";
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="${NS}">${view}${columns}<sheetData>${rows}</sheetData>${list}</worksheet>`;
  });

  const entries: ZipEntry[] = [
    textEntry(
      "[Content_Types].xml",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${sheets
        .map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`)
        .join("")}<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/></Types>`,
    ),
    textEntry(
      "_rels/.rels",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    ),
    textEntry(
      "xl/workbook.xml",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<workbook xmlns="${NS}" xmlns:r="${REL}"><sheets>${names.map((n, i) => `<sheet name="${escape(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets></workbook>`,
    ),
    textEntry(
      "xl/_rels/workbook.xml.rels",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets
        .map((_, i) => `<Relationship Id="rId${i + 1}" Type="${REL}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`)
        .join("")}<Relationship Id="rId${sheets.length + 1}" Type="${REL}/styles" Target="styles.xml"/><Relationship Id="rId${sheets.length + 2}" Type="${REL}/sharedStrings" Target="sharedStrings.xml"/></Relationships>`,
    ),
    textEntry(
      "xl/styles.xml",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<styleSheet xmlns="${NS}"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFE8EEF7"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`,
    ),
    textEntry(
      "xl/sharedStrings.xml",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<sst xmlns="${NS}" count="${strings.length}" uniqueCount="${strings.length}">${strings
        .map((s) => `<si><t xml:space="preserve">${escape(s)}</t></si>`)
        .join("")}</sst>`,
    ),
    ...sheetParts.map((xml, i) => textEntry(`xl/worksheets/sheet${i + 1}.xml`, xml)),
  ];
  return zipSync(entries);
}
