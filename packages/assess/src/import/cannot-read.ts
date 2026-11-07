/**
 * Files this program does not read, known by their name, and what to do instead.
 *
 * Without this a file of another kind is handed to the plain-text reader, which decodes its bytes as text and reports a handful of
 * orphan blocks of junk and "the layout is not read": a person who saved a test bank from LibreOffice, or dragged in the little
 * shortcut file Google Drive keeps in place of a document, is left wondering what is wrong with their questions when nothing is
 * wrong with them. A message that says what the file is and how to get it into a form this reads costs nothing and loses nothing,
 * and it is the same message wherever a file is chosen (the app, `import`, `review`).
 *
 * Only a name is looked at. A file that is one of these inside and is named as something this reads (an old Word file called .docx)
 * is refused in words by the reader that meets it (`docx/package.ts` says so for one). A name that is not here is read as it always
 * was.
 */

const CANNOT_READ: Record<string, string> = {
  ".doc": "This is an older Word file (.doc). In Word, choose File, then Save As, and pick Word Document (*.docx).",
  ".xls": "This is an older Excel file (.xls). In Excel, choose File, then Save As, and pick Excel Workbook (*.xlsx) or CSV UTF-8.",
  ".odt": "This is an OpenDocument text file (.odt). In LibreOffice or OpenOffice, choose File, then Save As, and pick Word 2007-365 (*.docx).",
  ".ods": "This is an OpenDocument spreadsheet (.ods). In LibreOffice or OpenOffice, choose File, then Save As, and pick Excel 2007-365 (*.xlsx) or Text CSV (*.csv).",
  ".pages": "This is an Apple Pages file. In Pages, choose File, then Export To, then Word, and import the .docx it makes.",
  ".numbers": "This is an Apple Numbers file. In Numbers, choose File, then Export To, then Excel or CSV, and import what it makes.",
  ".gdoc": "This is only the shortcut Google Drive keeps in place of a document, and it holds no questions. In Google Docs, choose File, then Download, then Microsoft Word (.docx), and import that.",
  ".gsheet": "This is only the shortcut Google Drive keeps in place of a spreadsheet, and it holds no questions. In Google Sheets, choose File, then Download, then Microsoft Excel (.xlsx) or Comma Separated Values (.csv), and import that.",
  ".html": "This is a web page (.html). Copy the questions into a Word document and save it as .docx, or into a plain text file, and import that.",
  ".htm": "This is a web page (.htm). Copy the questions into a Word document and save it as .docx, or into a plain text file, and import that.",
  ".ppt": "This is a PowerPoint file. It holds slides, not a list of questions. Copy the questions into a Word document and import that.",
  ".pptx": "This is a PowerPoint file. It holds slides, not a list of questions. Copy the questions into a Word document and import that.",
};

/**
 * Word and Excel keep a file of 162 bytes beside a document that is open, whose name begins with "~$", to remember who has it open.
 * It looks like the document in a folder (it ends in .docx or .xlsx) and holds nothing. 31 of the 341 Word files in one real
 * downloads folder were these, and each was refused with "not a zip: no end-of-central-directory record", which says nothing to a person.
 */
const LOCK_FILE = 'This is not a document. Word and Excel keep a small file whose name starts with "~$" beside a document while it is open, to remember who has it open, and it holds nothing to read. Close the document and import the document itself, which is in the same folder with a name like this one without the "~$" at the start.';

/** What to tell a person about a file this cannot read, from its name, or undefined when the name is not one of those. */
export function cannotRead(path: string): string | undefined {
  const file = path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1);
  if (file.startsWith("~$")) return LOCK_FILE;
  const dot = file.lastIndexOf(".");
  if (dot === -1) return undefined;
  const extension = file.slice(dot).toLowerCase();
  // Every key starts with a dot, so no property an object inherits ("constructor", "__proto__") can be mistaken for one.
  return CANNOT_READ[extension];
}
