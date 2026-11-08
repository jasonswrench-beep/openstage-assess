// Runs the app exactly as the installer carries it (its own node.exe, its own copy of the files) and takes a Word file with a picture and
// curly quotes through import, save, the bank's picture route, print and export, as the window would.
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const res = join(repo, "packages/app/shell/src-tauri/resources");
// By default this runs what the installer carries: its own node.exe and its own copy of the files, as built by `npm run build` in
// packages/app/shell. To try the script itself against the committed files before a build, set OPENASSESS_SMOKE_SOURCE=1 (this
// computer's Node and the repository's files); that says nothing about an installer.
const fromSource = process.env.OPENASSESS_SMOKE_SOURCE === "1";
const nodeExe = fromSource ? process.execPath : join(res, "node/node.exe");
const main = fromSource ? join(repo, "packages/app/src/main.ts") : join(res, "app/packages/app/src/main.ts");
const home = mkdtempSync(join(tmpdir(), "oa-smoke-"));
const { docx, paragraph, run } = await import(pathToFileURL(join(repo, "packages/assess/test/support/docx-writer.ts")).href);
const { drawing, pictureParts, png } = await import(pathToFileURL(join(repo, "packages/assess/test/support/images.ts")).href);

const BLUE = png(40, 30);
const body = [
  paragraph(run("1. Look at the figure \u2014 which colour is it? It\u2019s \u201Cblue\u201D\u2026")),
  `<w:p><w:r>${drawing("rId10", { alt: "A solid blue rectangle" })}</w:r></w:p>`,
  paragraph(run("a) Blue")),
  paragraph(run("b) Red")),
  paragraph(run("Answer: a")),
].join("");
const file = Buffer.from(docx({ body, ...pictureParts([{ rId: "rId10", part: "word/media/image1.png", bytes: BLUE }]) }));

const child = spawn(nodeExe, ["--experimental-strip-types", "--no-warnings", main, "--home", home, "--port", "47321"], { stdio: ["ignore", "pipe", "pipe"] });
let out = "";
child.stdout.on("data", (d) => (out += d));
child.stderr.on("data", (d) => (out += d));
const results = [];
const check = (label, ok, detail = "") => results.push(`${ok ? "ok  " : "FAIL"} ${label}${detail ? ` (${detail})` : ""}`);

try {
  let entry;
  for (let i = 0; i < 100 && !entry; i++) {
    await new Promise((r) => setTimeout(r, 200));
    entry = /(http:\/\/127\.0\.0\.1:\d+\/[^\s]*)/.exec(out)?.[1];
  }
  if (!entry) throw new Error("the app did not say where it is. Output: " + out.slice(0, 500));
  const base = new URL(entry).origin;
  const first = await fetch(entry, { redirect: "manual" });
  const cookie = (first.headers.getSetCookie()[0] ?? "").split(";")[0];
  check("the app answered at its address with a key", first.status === 200 || first.status === 302, String(first.status));
  const send = (method, path, data) =>
    fetch(base + path, { method, headers: { cookie, ...(method !== "GET" ? { "x-openassess": "1" } : {}), ...(data && !(data instanceof Uint8Array) ? { "content-type": "application/json" } : {}) }, ...(data ? { body: data instanceof Uint8Array ? data : JSON.stringify(data) } : {}) });

  const noKey = await fetch(base + "/api/banks");
  check("a request with no key is turned away", noKey.status >= 400, String(noKey.status));

  const imp = await (await send("POST", "/api/import?name=figures.docx", new Uint8Array(file))).json();
  check("the Word file with a picture imported", imp.counts?.total === 1, JSON.stringify(imp.counts));
  const q = (await (await send("GET", `/api/sessions/${imp.id}/questions/0`)).json()).question;
  check("the stem keeps the dash, the curly quotes and the ellipsis", q.stem.includes("\u2014 which colour is it? It\u2019s \u201Cblue\u201D\u2026"), JSON.stringify(q.stem).slice(0, 120));
  check("the picture is there with its description, as [picture 1]", q.pictures.length === 1 && q.pictures[0].alt === "A solid blue rectangle" && /\[picture 1\]/.test(q.stem));
  const shown = await send("GET", `/api/sessions/${imp.id}/media/${q.pictures[0].file}`);
  check("the import review serves the picture as a PNG", shown.status === 200 && shown.headers.get("content-type") === "image/png" && Buffer.compare(Buffer.from(await shown.arrayBuffer()), Buffer.from(BLUE)) === 0);

  const saved = await (await send("POST", `/api/sessions/${imp.id}/save`, { title: "Smoke" })).json();
  check("saved into a new bank", saved.added === 1, JSON.stringify(saved).slice(0, 100));
  const bank = encodeURIComponent(saved.bank);
  const listing = await (await send("GET", `/api/banks/${bank}`)).json();
  check("the bank says nothing is missing", listing.problems.pictures === null && listing.problems.unreadable.length === 0);
  const served = await send("GET", `/api/banks/${bank}/media/${q.pictures[0].file}`);
  check("the bank serves the picture", served.status === 200 && served.headers.get("content-type") === "image/png");

  const printed = await (await send("POST", `/api/banks/${bank}/print`, { kinds: ["student"], formats: ["docx", "pdf"] })).json();
  const word = printed.written?.find((w) => w.format === "docx");
  const pdf = printed.written?.find((w) => w.format === "pdf");
  check("printed as Word and PDF", Boolean(word && pdf && existsSync(word.path) && existsSync(pdf.path)));
  if (pdf) check("the PDF holds an image", readFileSync(pdf.path).toString("latin1").includes("/Subtype /Image"));
  if (word) check("the Word file holds the picture", readFileSync(word.path).includes(Buffer.from("word/media/image1.png")));

  const moodle = await (await send("POST", `/api/banks/${bank}/export`, { destination: "moodle-xml" })).json();
  const xml = moodle.written?.[0] ? readFileSync(moodle.written[0].path, "utf8") : "";
  check("the Moodle file carries the picture and the dash", /<file name="p-[0-9a-f]{16}\.png"/.test(xml) && xml.includes("\u2014"));
  // New in alpha 5: a picture added by hand, Word's decoration mark, and filing several questions at once.
  const RED = png(20, 20, { color: [200, 30, 30] });
  const qid = listing.questions[0].id;
  const addedByHand = await send("POST", `/api/banks/${bank}/questions/${qid}/pictures`, new Uint8Array(RED));
  const added = (await addedByHand.json()).question;
  check("a picture was added by hand, at the end of the text, with no description yet", addedByHand.status === 200 && added.pictures.length === 2 && added.pictures[1].alt === "" && /\[picture 2\]/.test(added.stem), String(addedByHand.status));
  const notPicture = await send("POST", `/api/banks/${bank}/questions/${qid}/pictures`, new TextEncoder().encode("<script>alert(1)</script>"));
  check("a file that is not a picture is refused in words", notPicture.status === 400 && /not a PNG, JPEG or GIF/.test((await notPicture.json()).error ?? ""));
  const folder = (await (await send("POST", `/api/banks/${bank}/folders`, { name: "Chapter 1" })).json()).folder;
  const filed = await (await send("POST", `/api/banks/${bank}/filing`, { folderId: folder, questionIds: [qid] })).json();
  check("several questions can be filed at once", filed.filed === 1 && filed.unfiled === 0, JSON.stringify(filed).slice(0, 80));
  const deco = readFileSync(join(repo, "fixtures/word-authored/pictures/pictures-decorative.docx"));
  const decoSession = await (await send("POST", "/api/import?name=decorative.docx", new Uint8Array(deco))).json();
  const dq = (await (await send("GET", `/api/sessions/${decoSession.id}/questions/0`)).json()).question;
  check("a picture Word marked as decoration needs no description", dq.pictures.length === 1 && dq.pictures[0].decorative === true && dq.verdict === "parsed", JSON.stringify(dq.pictures[0] ?? {}).slice(0, 80));
  // New in alpha 6: a Word equation (a file real Word wrote) read, shown, moved, printed as an equation and written to Moodle; Symbol characters.
  const { unzipSync } = await import(pathToFileURL(join(repo, "packages/assess/src/container/zip.ts")).href);
  const eqFile = readFileSync(join(repo, "fixtures/word-authored/equations/equations-display.docx"));
  const eqSession = await (await send("POST", "/api/import?name=equation.docx", new Uint8Array(eqFile))).json();
  const eq = (await (await send("GET", `/api/sessions/${eqSession.id}/questions/0`)).json()).question;
  check("the equation Word wrote is read, with its LaTeX and MathML, and stands in the text as a token", eq.equations?.length === 1 && eq.equations[0].latex === "\\frac{x}{2}" && eq.equations[0].mathml.startsWith("<math ") && /\[equation 1\]/.test(eq.stem) && eq.verdict === "parsed", JSON.stringify(eq.equations?.[0] ?? {}).slice(0, 80));
  const eqSaved = await (await send("POST", `/api/sessions/${eqSession.id}/save`, { title: "Maths" })).json();
  const eqBank = encodeURIComponent(eqSaved.bank);
  const eqPrinted = await (await send("POST", `/api/banks/${eqBank}/print`, { kinds: ["student"], formats: ["docx", "pdf"] })).json();
  const eqWord = eqPrinted.written?.find((w) => w.format === "docx");
  const eqDocument = eqWord ? Buffer.from(unzipSync(new Uint8Array(readFileSync(eqWord.path))).get("word/document.xml")).toString("utf8") : "";
  check("the printed Word file holds the equation as an equation, and not as words", eqDocument.includes("<m:oMath") && eqDocument.includes("<m:f>") && !eqDocument.includes("[Equation"));
  const eqPdf = eqPrinted.written?.find((w) => w.format === "pdf");
  const { inflateSync } = await import("node:zlib");
  const pdfBytes = eqPdf ? readFileSync(eqPdf.path) : Buffer.alloc(0);
  let pdfText = pdfBytes.toString("latin1");
  for (const m of pdfText.matchAll(/stream\r?\n/g)) {
    const start = m.index + m[0].length;
    const end = pdfBytes.indexOf("endstream", start);
    try { pdfText += inflateSync(pdfBytes.subarray(start, end)).toString("latin1"); } catch { /* not a compressed stream */ }
  }
  check("the PDF prints the words of the equation", Boolean(eqPdf) && /Equation: \\\\?frac/.test(pdfText), pdfText.match(/\(?Equation[^)]{0,40}/)?.[0] ?? "no words found");
  const eqMoodle = await (await send("POST", `/api/banks/${eqBank}/export`, { destination: "moodle-xml" })).json();
  const eqXml = eqMoodle.written?.[0] ? readFileSync(eqMoodle.written[0].path, "utf8") : "";
  check("the Moodle file writes the equation as LaTeX between the delimiters", eqXml.includes("\\(\\frac{x}{2}\\)"));
  const eqEdit = await send("PUT", `/api/banks/${eqBank}/questions/${(await (await send("GET", `/api/banks/${eqBank}`)).json()).questions[0].id}`, { input: { type: eq.type, title: eq.title, stem: "Solve this: [equation 1]", points: eq.points, feedback: eq.feedback, metadata: eq.metadata, body: eq.body }, expectVersion: 1 });
  const eqEdited = (await eqEdit.json()).question;
  check("the equation is moved by editing its token", eqEdit.status === 200 && eqEdited?.stem === "Solve this: [equation 1]" && eqEdited.equations[0].placed === true, String(eqEdit.status));
  const sym = readFileSync(join(repo, "fixtures/word-authored/symbols/symbols-insert.docx"));
  const symSession = await (await send("POST", "/api/import?name=symbols.docx", new Uint8Array(sym))).json();
  const sq = (await (await send("GET", `/api/sessions/${symSession.id}/questions/0`)).json()).question;
  check("Symbol-font characters are the Greek letter and the sign they show", sq.stem === "Is the angle α and the error ± small?", JSON.stringify(sq.stem));
  // New in alpha 7: a question that holds something the reader could not read says so, a data table inside a stem says so, and Greek
  // letters print in the PDF.
  const { table } = await import(pathToFileURL(join(repo, "packages/assess/test/support/docx-writer.ts")).href);
  const croppedBody = [
    paragraph(run("1. Look at the figure. Which colour is it? ") + `<w:r>${drawing("rId10", { alt: "A rectangle", crop: { l: 20000 } })}</w:r>`),
    paragraph(run("a) Blue")), paragraph(run("b) Red")), paragraph(run("Answer: a")),
  ].join("");
  const croppedFile = Buffer.from(docx({ body: croppedBody, ...pictureParts([{ rId: "rId10", part: "word/media/image1.png", bytes: BLUE }]) }));
  const croppedSession = await (await send("POST", "/api/import?name=cropped.docx", new Uint8Array(croppedFile))).json();
  const cq = (await (await send("GET", `/api/sessions/${croppedSession.id}/questions/0`)).json()).question;
  const unread = cq.findings.filter((f) => f.code === "import.unread-object");
  check("a question holding a picture that could not be kept says so, and needs a look", unread.length === 1 && unread[0].severity === "warn" && /one picture/.test(unread[0].message) && croppedSession.counts?.needsReview === 1, JSON.stringify(croppedSession.counts));
  const tableBody = [
    paragraph(run("1. Use the table to find the mean of the scores.")),
    table([["Student", "Score"], ["Ana", "80"], ["Ben", "90"]].map((row) => row.map((c) => paragraph(run(c))))),
    paragraph(run("a) 80")), paragraph(run("b) 85")), paragraph(run("Answer: b")),
  ].join("");
  const tableSession = await (await send("POST", "/api/import?name=table.docx", new Uint8Array(Buffer.from(docx({ body: tableBody }))))).json();
  const tq = (await (await send("GET", `/api/sessions/${tableSession.id}/questions/0`)).json()).question;
  check("a data table inside a stem is kept as a table (it was read cell by cell before alpha 8), and the question is not said to have lost anything", tq.tables?.length === 1 && /\[table 1\]/.test(tq.stem) && !tq.findings.some((f) => f.code === "import.table-flattened"), JSON.stringify(tq.findings.map((f) => f.code)));
  const greekFile = Buffer.from(docx({ body: [paragraph(run("1. Is α ≤ β when λ = 5?")), paragraph(run("a) Yes")), paragraph(run("b) No")), paragraph(run("Answer: a"))].join("") }));
  const greekSession = await (await send("POST", "/api/import?name=greek.docx", new Uint8Array(greekFile))).json();
  const greekSaved = await (await send("POST", `/api/sessions/${greekSession.id}/save`, { title: "Greek" })).json();
  const greekBank = encodeURIComponent(greekSaved.bank);
  const greekPrinted = await (await send("POST", `/api/banks/${greekBank}/print`, { kinds: ["student"], formats: ["pdf"] })).json();
  const greekPdf = greekPrinted.written?.find((w) => w.format === "pdf");
  const greekBytes = greekPdf ? readFileSync(greekPdf.path) : Buffer.alloc(0);
  let greekText = greekBytes.toString("latin1");
  for (const m of greekText.matchAll(/stream\r?\n/g)) {
    const start = m.index + m[0].length;
    const end = greekBytes.indexOf("endstream", start);
    try { greekText += inflateSync(greekBytes.subarray(start, end)).toString("latin1"); } catch { /* not a compressed stream */ }
  }
  check("the PDF draws the Greek letters in its Symbol font and says nothing was replaced", /\/BaseFont \/Symbol/.test(greekText) && /\/F6 \d+ Tf/.test(greekText) && !(greekPrinted.reports?.student?.general ?? []).some((g) => /cannot be drawn/.test(g)), JSON.stringify(greekPrinted.reports?.student?.general ?? []).slice(0, 120));
  // New in alpha 8: a data table inside a question is kept as a table (a file real Word wrote), shown, moved by its token, kept in a
  // bank, printed as a table in Word and as lines in a PDF.
  const tableFile = readFileSync(join(repo, "fixtures/word-authored/tables/tables-header.docx"));
  const headerSession = await (await send("POST", "/api/import?name=table-header.docx", new Uint8Array(tableFile))).json();
  const tq2 = (await (await send("GET", `/api/sessions/${headerSession.id}/questions/0`)).json()).question;
  check("the table Word wrote is kept as a table of the question, with its header row, and stands in the text as a token", tq2.tables?.length === 1 && tq2.tables[0].rows.length === 3 && tq2.tables[0].rows[0].every((c) => c.header) && /\[table 1\]/.test(tq2.stem) && !tq2.findings.some((f) => f.code === "import.table-flattened"), JSON.stringify(tq2.tables?.[0]?.rows?.[0] ?? {}).slice(0, 100));
  const movedStem = "[table 1]\nUse the table to find the mean of the scores.";
  const tableEdit = await send("PUT", `/api/sessions/${headerSession.id}/questions/0`, { input: { type: tq2.type, title: tq2.title, stem: movedStem, points: tq2.points, feedback: tq2.feedback, metadata: tq2.metadata, body: tq2.body }, expectVersion: tq2.version });
  const tableEdited = (await tableEdit.json()).question;
  check("the table is moved by editing its token, and is still a table", tableEdit.status === 200 && tableEdited?.stem === movedStem && tableEdited.tables.length === 1, String(tableEdit.status));
  const headerSaved = await (await send("POST", `/api/sessions/${headerSession.id}/save`, { title: "Tables" })).json();
  const headerBank = encodeURIComponent(headerSaved.bank);
  const tablePrinted = await (await send("POST", `/api/banks/${headerBank}/print`, { kinds: ["student"], formats: ["docx", "pdf"] })).json();
  const tableWord = tablePrinted.written?.find((w) => w.format === "docx");
  const tableXml = tableWord ? Buffer.from(unzipSync(new Uint8Array(readFileSync(tableWord.path))).get("word/document.xml")).toString("utf8") : "";
  check("the printed Word file holds the table as a table, with its header row marked to repeat", tableXml.includes("<w:tbl>") && tableXml.includes("<w:tblHeader/>") && !tableXml.includes("Student | Score"));
  const tablePdf = tablePrinted.written?.find((w) => w.format === "pdf");
  const tablePdfBytes = tablePdf ? readFileSync(tablePdf.path) : Buffer.alloc(0);
  let tablePdfText = tablePdfBytes.toString("latin1");
  for (const m of tablePdfText.matchAll(/stream\r?\n/g)) {
    const start = m.index + m[0].length;
    const end = tablePdfBytes.indexOf("endstream", start);
    try { tablePdfText += inflateSync(tablePdfBytes.subarray(start, end)).toString("latin1"); } catch { /* not a compressed stream */ }
  }
  check("the PDF draws the table as lines, a row to a line", /Student \| Score/.test(tablePdfText) && /Ana \| 80/.test(tablePdfText));
  const tableMoodle = await (await send("POST", `/api/banks/${headerBank}/export`, { destination: "moodle-xml" })).json();
  const tableMoodleXml = tableMoodle.written?.[0] ? readFileSync(tableMoodle.written[0].path, "utf8") : "";
  check("the Moodle file carries the table as markup", /<table><thead><tr><th scope="col">Student<\/th>/.test(tableMoodleXml));
  // New in alpha 9: files from other learning systems come in (Moodle XML, QTI 1.2 and 2.1), a QTI 2.1 package goes out, a stored recipe
  // for a test, and the editor no longer writes the word null between its panels.
  const destinations = (await (await send("GET", "/api/destinations")).json()).destinations.map((d) => d.id);
  check("the export screen offers a QTI 2.1 package", destinations.includes("qti-2.1"), destinations.join(", "));
  const moodleSample = readFileSync(join(repo, "fixtures/moodle-xml/moodle-sample.xml"));
  const moodleImport = await (await send("POST", "/api/import?name=moodle-sample.xml", new Uint8Array(moodleSample))).json();
  check("a Moodle XML file is read: eight questions, a cloze kept as text that fails, a description left over", moodleImport.profile === "moodle-xml" && moodleImport.counts?.parsed === 8 && moodleImport.counts?.failed === 1 && moodleImport.counts?.orphans === 1, JSON.stringify(moodleImport.counts));
  const figure = moodleImport.questions.findIndex((x) => x.title === "Look at the figure");
  const mq = (await (await send("GET", `/api/sessions/${moodleImport.id}/questions/${figure}`)).json()).question;
  const mpicture = await send("GET", `/api/sessions/${moodleImport.id}/media/${mq.pictures[0].file}`);
  check("the picture in the Moodle file is kept and served as a PNG", mq.pictures.length === 1 && mq.pictures[0].alt === "A blue box" && mpicture.status === 200 && mpicture.headers.get("content-type") === "image/png");
  const qtiOut = await (await send("POST", `/api/banks/${bank}/export`, { destination: "qti-2.1" })).json();
  const qtiFile = qtiOut.written?.[0];
  check("the bank was written as a QTI 2.1 package", Boolean(qtiFile) && /QTI 2\.1\.zip$/.test(qtiFile.name) && readFileSync(qtiFile.path).subarray(0, 2).toString("latin1") === "PK", qtiFile?.name);
  const qtiBack = await (await send("POST", "/api/import?name=" + encodeURIComponent(qtiFile.name), new Uint8Array(readFileSync(qtiFile.path)))).json();
  // The question in this bank has a picture added by hand that has no description, so reading it back says so and nothing else.
  const onlyAltNote = async (session) => {
    const q = (await (await send("GET", `/api/sessions/${session.id}/questions/0`)).json()).question;
    return q.findings.every((f) => f.code === "a11y.missing-alt-text") && q.pictures.length === 2;
  };
  check("and that package was read back as the same question, both pictures and its key, flagged only for the picture with no description", qtiBack.profile === "qti" && qtiBack.counts?.total === 1 && qtiBack.counts?.failed === 0 && (await onlyAltNote(qtiBack)), JSON.stringify(qtiBack.counts));
  const qti12Out = await (await send("POST", `/api/banks/${bank}/export`, { destination: "qti-1.2" })).json();
  const qti12Back = await (await send("POST", "/api/import?name=" + encodeURIComponent(qti12Out.written[0].name), new Uint8Array(readFileSync(qti12Out.written[0].path)))).json();
  const q12 = (await (await send("GET", `/api/sessions/${qti12Back.id}/questions/0`)).json()).question;
  check("a QTI 1.2 package is read back too, its pictures as words since that format carries none, and its key", qti12Back.profile === "qti" && qti12Back.counts?.total === 1 && qti12Back.counts?.failed === 0 && /\[Picture/.test(q12.stem), JSON.stringify(qti12Back.counts));
  const refused = await (await send("POST", "/api/import?name=broken.xml", new TextEncoder().encode("<quiz><question"))).json();
  check("a broken XML file is read as nothing and says why", refused.counts?.total === 0 && /not well formed XML/.test((refused.fileFindings ?? []).map((f) => f.message).join(" ")));
  const bp = `/api/sheets/${bank}/blueprints`;
  const made = await send("POST", bp, { name: "Smoke recipe", rules: [{ axis: "type", value: "multipleChoice", count: 1 }] });
  const madeBody = await made.json();
  check("a recipe for a test was kept in the bank", made.status === 200 && madeBody.blueprint?.name === "Smoke recipe", String(made.status));
  const drawn = await (await send("POST", `${bp}/${madeBody.blueprint?.id}/draw`, { chosen: [] })).json();
  check("and drawing it took the question, short of nothing", drawn.ids?.length === 1 && drawn.short === 0, JSON.stringify(drawn).slice(0, 120));
  const editorJs = await (await fetch(base + "/editor.js", { headers: { cookie } })).text();
  check("the editor adds its optional panels with put, so no stray null is written", /put\(\s*element,/.test(editorJs) && !/element\.append\(\s*headerHost/.test(editorJs));
  // New in alpha 10: a blueprint rule may ask for values on several axes, a Brightspace question library and a Common Cartridge file
  // (.imscc) are read, and the home screen says so.
  const bp10 = `/api/sheets/${bank}/blueprints`;
  const cell = await send("POST", bp10, { name: "Smoke cells", rules: [{ axis: "type", value: "multipleChoice", count: 1, and: [{ axis: "status", value: "draft" }] }, { axis: "type", value: "essay", count: 2, and: [{ axis: "status", value: "draft" }] }] });
  const cellBody = await cell.json();
  check("a recipe with a rule on two axes was kept, with its other value shown", cell.status === 200 && JSON.stringify(cellBody.blueprint?.rules?.[0]?.and) === JSON.stringify([{ axis: "status", value: "draft" }]) && cellBody.blueprint?.rules?.[1]?.count === 2, String(cell.status) + " " + JSON.stringify(cellBody).slice(0, 160));
  const cellDraw = await (await send("POST", `${bp10}/${cellBody.blueprint?.id}/draw`, { chosen: [] })).json();
  check("drawing it took the one cell that has a question, and said which cell came out short", cellDraw.ids?.length === 1 && cellDraw.short === 2 && /type essay and status draft: wanted 2, took 0/.test((cellDraw.notes ?? []).join(" ")) && JSON.stringify(cellDraw.rules?.[0]?.and) === JSON.stringify([{ axis: "status", value: "draft" }]), JSON.stringify(cellDraw).slice(0, 220));
  const impossible = await send("POST", bp10, { name: "Smoke impossible", rules: [{ axis: "chapter", value: "1", count: 1, and: [{ axis: "chapter", value: "2" }] }] });
  check("a rule that could never take a question is refused in words and nothing is kept", impossible.status === 400 && /one chapter.*could never take a question/.test((await impossible.json()).error ?? ""), String(impossible.status));
  const kept10 = await (await send("GET", bp10)).json();
  check("and the bank holds only the recipes that were good", JSON.stringify((kept10.blueprints ?? []).map((b) => b.name).sort()) === JSON.stringify(["Smoke cells", "Smoke recipe"]), JSON.stringify((kept10.blueprints ?? []).map((b) => b.name)));

  const { zipSync, textEntry } = await import(pathToFileURL(join(res, "app/packages/assess/src/container/zip.ts")).href);
  const d2lItem = `<item d2l_2p0:id="2" ident="OBJ_1002" label="QUES_1001" title="Which planet is closest to the Su" ><itemmetadata><qtimetadata><qti_metadatafield><fieldlabel>qmd_questiontype</fieldlabel><fieldentry>Multiple Choice</fieldentry></qti_metadatafield><qti_metadatafield><fieldlabel>qmd_weighting</fieldlabel><fieldentry>2.0000</fieldentry></qti_metadatafield></qtimetadata></itemmetadata><presentation><flow><material><mattext texttype="text/html"><![CDATA[Which planet is closest to the Sun?]]></mattext></material><response_lid ident="QUES_1001_LID" rcardinality="Multiple"><render_choice shuffle="no"><flow_label class="Block"><response_label ident="QUES_1001_A1"><flow_mat><material><mattext texttype="text/html"><![CDATA[Venus]]></mattext></material></flow_mat></response_label></flow_label><flow_label class="Block"><response_label ident="QUES_1001_A2"><flow_mat><material><mattext texttype="text/html"><![CDATA[Mercury]]></mattext></material></flow_mat></response_label></flow_label></render_choice></response_lid></flow></presentation><resprocessing><respcondition title="C1"><conditionvar><varequal respident="QUES_1001_LID">QUES_1001_A1</varequal></conditionvar><setvar action="Set">0.0000</setvar></respcondition><respcondition title="C2"><conditionvar><varequal respident="QUES_1001_LID">QUES_1001_A2</varequal></conditionvar><setvar action="Set">100.0000</setvar></respcondition></resprocessing></item>`;
  const library = zipSync([textEntry("imsmanifest.xml", '<manifest xmlns:d2l_2p0="http://desire2learn.com/xsd/d2lcp_v2p0" xmlns="http://www.imsglobal.org/xsd/imscp_v1p1"><resources><resource identifier="res_question_library" type="webcontent" d2l_2p0:material_type="d2lquestionlibrary" href="questiondb.xml" /></resources></manifest>'), textEntry("questiondb.xml", '<?xml version="1.0" encoding="UTF-8"?><questestinterop><objectbank ident="QLIB_1" xmlns:d2l_2p0="http://desire2learn.com/xsd/d2lcp_v2p0"><section ident="SECT_1" title="Section-Test">' + d2lItem + "</section></objectbank></questestinterop>")]);
  const lib = await (await send("POST", "/api/import?name=questiondb.zip", new Uint8Array(library))).json();
  check("a Brightspace question library was read: one question, parsed, with its note about Brightspace's settings absent here", lib.profile === "qti" && lib.counts?.parsed === 1 && lib.counts?.failed === 0, JSON.stringify(lib.counts));
  const libQ = (await (await send("GET", `/api/sessions/${lib.id}/questions/0`)).json()).question;
  check("its points are the weighting, its title is the question's own words and not the cut one", libQ.points === 2 && libQ.title === "Which planet is closest to the Sun?", JSON.stringify({ points: libQ.points, title: libQ.title }));
  const cc = await (await send("POST", `/api/banks/${bank}/export`, { destination: "common-cartridge" })).json();
  const ccFile = cc.written?.[0];
  check("the bank was written as a Common Cartridge file (.imscc)", Boolean(ccFile) && /\.imscc$/.test(ccFile.name), ccFile?.name);
  const ccBack = await (await send("POST", "/api/import?name=" + encodeURIComponent(ccFile.name), new Uint8Array(readFileSync(ccFile.path)))).json();
  check("and that .imscc file was read back as a package of one question", ccBack.profile === "qti" && ccBack.counts?.total === 1 && ccBack.counts?.failed === 0, JSON.stringify(ccBack.counts));
  const homeJs = await (await fetch(base + "/home.js", { headers: { cookie } })).text();
  check("the home screen offers .imscc files and says Common Cartridge", /\.imscc/.test(homeJs) && /Common Cartridge file here/.test(homeJs));
  const bpJs = await (await fetch(base + "/blueprints.js", { headers: { cookie } })).text();
  check("the blueprint screen has the button that adds another value to a rule", /Also ask for another value/.test(bpJs));
  // New in alpha 11: tables that put the right answer in a column of its own, answer columns named by number, columns a bank is organised
  // by, a Brightspace question library CSV (and this program's own file read back), files of kinds that are not read, a named dialog.
  const importText = async (name, text) => (await send("POST", `/api/import?name=${encodeURIComponent(name)}`, new Uint8Array(Buffer.from(text, "utf8")))).json();
  const itemOf = async (id, n = 0) => (await (await send("GET", `/api/sessions/${id}/questions/${n}`)).json()).question;
  const rightFirst = await importText("radio.txt", "question_id;question_english;correct_answer_english;incorrect_answer_1_english;incorrect_answer_2_english;question_french;correct_answer_french;incorrect_answer_1_french;incorrect_answer_2_french\nA-001;Which is cold?;Ice;Fire;Lava;Lequel est froid?;La glace;Le feu;La lave\nA-002;Which is hot?;Fire;Ice;Snow;Lequel est chaud?;Le feu;La glace;La neige");
  check("a table with the right answer in a column of its own was read as a table, two questions, both parsed", rightFirst.profile === "spreadsheet" && rightFirst.counts?.parsed === 2, JSON.stringify(rightFirst.counts));
  const rf0 = await itemOf(rightFirst.id, 0);
  const rf1 = await itemOf(rightFirst.id, 1);
  const rightOf = (q) => (q.body?.options ?? []).filter((o) => o.correct).map((o) => o.text);
  check("the right answer is the one in its column, whatever place the mixing put it in", JSON.stringify(rightOf(rf0)).includes("Ice") && JSON.stringify(rightOf(rf1)).includes("Fire"), JSON.stringify([rightOf(rf0), rightOf(rf1)]));
  check("the second language is said to be left out and the mixing is said", (rightFirst.fileFindings ?? []).some((f) => /repeat one already read/.test(f.message)) && (rightFirst.fileFindings ?? []).some((f) => /were mixed/.test(f.message)) || JSON.stringify(rightFirst).includes("mixed"), JSON.stringify(rightFirst.notes ?? rightFirst.fileFindings ?? "").slice(0, 200));

  const numbered = await importText("numbered.csv", "Question,Option 1,Option 2,Option 3,Correct,Chapter,Difficulty\nWhich is the capital of France?,Rome,Paris,Madrid,2,Chapter 3,Hard");
  const nq = await itemOf(numbered.id, 0);
  check("answer columns named by number were read, the number in Correct is the key, and the chapter and difficulty are the question's own", numbered.counts?.parsed === 1 && JSON.stringify(rightOf(nq)) === JSON.stringify(["Paris"]) && nq.metadata?.chapter === "Chapter 3" && nq.metadata?.difficulty === "hard", JSON.stringify({ counts: numbered.counts, right: rightOf(nq), meta: nq.metadata }).slice(0, 200));

  const d2lLib = await importText("library.csv", "// a comment\r\nNewQuestion,MC,\r\nQuestionText,Which planet is closest to the Sun?,\r\nPoints,2,\r\nOption,0,Venus,\r\nOption,100,Mercury,\r\nNewQuestion,TF,\r\nQuestionText,The Sun is a planet.,\r\nTRUE,0,\r\nFALSE,100,\r\n");
  check("a Brightspace question library CSV was read as one, two questions, parsed", d2lLib.profile === "d2l-csv" && d2lLib.counts?.parsed === 2, `${d2lLib.profile} ${JSON.stringify(d2lLib.counts)}`);
  const d2lQ = await itemOf(d2lLib.id, 0);
  check("its multiple choice key is the option worth the whole of the points, and its points are read", JSON.stringify(rightOf(d2lQ)) === JSON.stringify(["Mercury"]) && d2lQ.points === 2, JSON.stringify({ right: rightOf(d2lQ), points: d2lQ.points }));

  const d2lOut = await (await send("POST", `/api/banks/${bank}/export`, { destination: "d2l-csv" })).json();
  const d2lFile = d2lOut.written?.[0];
  check("the bank was written as a Brightspace CSV", Boolean(d2lFile) && /Brightspace\.csv$/.test(d2lFile.name), d2lFile?.name);
  const d2lBack = await importText(d2lFile.name, readFileSync(d2lFile.path, "utf8"));
  check("and that file reads back as a Brightspace library with no failure", d2lBack.profile === "d2l-csv" && d2lBack.counts?.failed === 0 && d2lBack.counts?.total >= 1, `${d2lBack.profile} ${JSON.stringify(d2lBack.counts)}`);

  const odt = await send("POST", "/api/import?name=exam.odt", new Uint8Array(Buffer.from("x")));
  const odtBody = await odt.json();
  check("an .odt file is refused in words, with what to do", odt.status === 400 && /OpenDocument text.*Save As.*docx/.test(odtBody.error ?? ""), `${odt.status} ${odtBody.error ?? ""}`.slice(0, 120));
  const gdoc = await send("POST", "/api/import?name=exam.gdoc", new Uint8Array(Buffer.from("{}")));
  check("a Google Drive shortcut is said to be only a shortcut", gdoc.status === 400 && /shortcut/.test((await gdoc.json()).error ?? ""));

  // New in alpha 12: the names of controls and what is spoken, high contrast, and three notes that were wrong on real questions.
  const text = async (p) => (await fetch(base + p, { headers: { cookie } })).text();
  const domJs = await text("/dom.js");
  check("the screens carry the helper that names a tick box by its words and describes it by its explanation", /export function checkRow/.test(domJs) && /aria-describedby/.test(domJs) && /aria-labelledby/.test(domJs));
  const css = await text("/style.css");
  check("the stylesheet has a forced-colours block, and an empty message line stays in the page", /forced-colors: active/.test(css) && /\.toast:empty/.test(css));
  const indexHtml = await text("/");
  check("the message line is in the page and is not hidden", /id="status"[^>]*role="status"/.test(indexHtml) && !/id="status"[^>]*hidden/.test(indexHtml));
  const homeScript = await text("/home.js");
  check("the home screen says which bank each link is for and which sample each button is for", /Open \$\{b\.title\}/.test(homeScript) && /Try it: \$\{s\.title\}/.test(homeScript));
  const scoringJs = await text("/scoring.js");
  check("the score review names each Look button for its sheet, and says what it did from one place that stays in the page", /Look at"} sheet/.test(scoringJs) && /announcer/.test(scoringJs));
  const exportJs = await text("/export.js");
  check("the export screen names each destination by its words, not its whole blurb", /checkRow\(radio/.test(exportJs));

  const parallel = "Question,A,B,C,D,Correct\nThe ripple frequency produced by a full-wave power supply connected to a normal household circuit is:,120 Hz,60 Hz,90 Hz,30 Hz,A\nThe ripple frequency produced by a half-wave power supply connected to a normal household circuit is:,120 Hz,60 Hz,90 Hz,30 Hz,B\nWhich of the following is not a fruit?,Apple,Pear,Stone,Plum,C\nDarlene is concerned that she will not appear honest because her speech is about a product. What aspect of credibility is she concerned about?,Trust,Cost,Size,Hue,A\nWhat is the alternative form of the ideal gas law using moles?,PV = nRT,PV = NkT,PV = nKT,PV = NRt,A\nWhich word repeats?,Alpha,Beta,Alpha,Gamma,B";
  const qimport = await importText("quality.csv", parallel);
  const qsaved = await (await send("POST", `/api/sessions/${qimport.id}/save`, { title: "Smoke quality" })).json();
  const qrun = await (await send("POST", `/api/banks/${encodeURIComponent(qsaved.bank)}/quality`, {})).json();
  const noteOf = (start) => ((qrun.questions ?? []).find((q) => q.title.startsWith(start))?.notes ?? []).map((n) => n.code);
  check("two parallel questions with a different right answer are not called alike", (qrun.duplicates ?? []).length === 0, JSON.stringify(qrun.duplicates ?? []).slice(0, 160));
  check("a stem that asks which is not something is still noted", noteOf("Which of the following is not").some((c) => /negative-stem/.test(c)), JSON.stringify(noteOf("Which of the following is not")));
  check("a story that says not before a question that does not is not noted", !noteOf("Darlene").some((c) => /negative-stem/.test(c)), JSON.stringify(noteOf("Darlene")));
  check("options that differ only in a capital inside them (nRT, NRt) are not called repeated", !noteOf("What is the alternative").some((c) => /duplicate-option/.test(c)), JSON.stringify(noteOf("What is the alternative")));
  check("an option written twice is still noted", noteOf("Which word repeats").some((c) => /duplicate-option/.test(c)), JSON.stringify(noteOf("Which word repeats")));

  // New in alpha 13: choosing a question in a long list marks the row in place; a game board's Value column and repeated numbers are
  // said as information; and what an independent review of the alpha 12 changes proved.
  const listJs = await text("/list.js");
  check("the list helper marks the chosen row in place and names each row by its key", /export function markSelected/.test(listJs) && /data-key/.test(listJs));
  const reviewScript = await text("/review.js");
  const bankScript = await text("/bank.js");
  check("choosing a question marks the row and does not draw every row again, in the review and in the bank", /markSelected\(list, index\)/.test(reviewScript) && /markSelected\(list, id\)/.test(bankScript));
  const scoringScript = await text("/scoring.js");
  check("the score review cancels the timer of an older announcement", /clearTimeout\(sayTimer\)/.test(scoringScript));
  const cssText = await text("/style.css");
  check("in forced colours a chosen row that has focus keeps its focus ring", /\.qrow\[aria-current="true"\]:focus-visible/.test(cssText));

  const board = await importText("board.csv", "Category,Value,Type,Question,A,B,C,Correct,Feedback if right,Feedback if wrong\nColour,100,MC,Which is warm?,Red,Blue,Green,A,Yes,No");
  const boardNote = (board.fileFindings ?? []).find((f) => /Value/.test(f.message));
  check("a game board's Value column is said as information that it was not used, and Category is a tag", boardNote?.severity === "info" && /game board/.test(boardNote.message) && (await itemOf(board.id)).metadata?.tags?.includes("Colour"), JSON.stringify(boardNote));
  const otherValue = await importText("value.csv", "Question,A,B,Correct,Value\nWhich is warm?,Red,Blue,A,100");
  check("a Value column in any other table keeps the warning", (otherValue.fileFindings ?? []).some((f) => f.severity === "warn" && /These columns were not used: Value/.test(f.message)));

  const sections = await importText("sections.txt", "1) First?\n*a. x\nb. y\n2) Second?\na. x\n*b. y\n\n1) Third?\n*a. p\nb. q\n2) Fourth?\na. p\n*b. q\n");
  const repeatInfo = (sections.fileFindings ?? []).find((f) => /Question numbers repeat/.test(f.message));
  check("sections that start again at 1 with asterisk answers are said as information, with every answer read", repeatInfo?.severity === "info" && sections.counts?.parsed === 4, JSON.stringify({ sev: repeatInfo?.severity, counts: sections.counts }));
  const listFirst = await importText("listfirst.txt", "Answers:\n1. A\n2. B\n\n1) First?\na. x\nb. y\n2) Second?\na. x\nb. y\n\n1) Third?\na. p\nb. q\n2) Fourth?\na. p\nb. q\n");
  const repeatWarn = (listFirst.fileFindings ?? []).find((f) => /Question numbers repeat/.test(f.message));
  check("an Answers list placed before repeated numbers keeps the warning", repeatWarn?.severity === "warn", JSON.stringify({ sev: repeatWarn?.severity, counts: listFirst.counts }));

  const q13 = [
    "Question,A,B,C,D,Correct",
    "When should a nurse not administer this drug?,Always,Never,Sometimes,Daily,B",
    "Select the statement that is not true. Choose one answer.,Cats purr,Dogs bark,Fish fly,Cows moo,C",
    '"Which of these statements about a 2"" pipe is not true for a 4"" pipe?",One,Two,Three,Four,A',
    "Darlene is concerned that she will not appear honest because her speech is about a product. What aspect of credibility is she concerned about?,Trust,Cost,Size,Hue,A",
    "Which one of the following gases makes up most of the Earth's atmosphere by volume at sea level under standard conditions of temperature and pressure?,Nitrogen,Oxygen,Argon,Neon,A",
    "Which of the following gases makes up most of the Earth's atmosphere by volume at sea level under standard conditions of temperature and pressure?,Nitrogen gas,Oxygen,Argon,Neon,A",
    "The ripple frequency produced by a full-wave power supply connected to a normal household circuit is:,120 Hz,60 Hz,90 Hz,30 Hz,A",
    "The ripple frequency produced by a half-wave power supply connected to a normal household circuit is:,120 Hz,60 Hz,90 Hz,30 Hz,B",
  ].join("\n");
  const q13import = await importText("review13.csv", q13);
  const q13saved = await (await send("POST", `/api/sessions/${q13import.id}/save`, { title: "Smoke review13" })).json();
  const q13run = await (await send("POST", `/api/banks/${encodeURIComponent(q13saved.bank)}/quality`, {})).json();
  const notes13 = (start) => ((q13run.questions ?? []).find((q) => q.title.startsWith(start))?.notes ?? []).map((n) => n.code);
  const negative13 = (start) => notes13(start).some((c) => /negative-stem/.test(c));
  check("a when that opens a question, an instruction after a sentence and an inch mark are noted as negative stems", negative13("When should a nurse") && negative13("Select the statement") && negative13("Which of these statements about a 2"), JSON.stringify([notes13("When should a nurse"), notes13("Select the statement"), notes13("Which of these statements about a 2")]));
  check("a story that says not before a question that does not is still not noted", !negative13("Darlene"));
  const dups13 = q13run.duplicates ?? [];
  check("the near-copy with a small word dropped is said, and the full-wave and half-wave parallels are not", dups13.length === 1 && /gases/i.test(JSON.stringify(dups13)) && !/ripple/i.test(JSON.stringify(dups13)), JSON.stringify(dups13).slice(0, 200));

  // New in alpha 14: long lists in pages, Check quality that stays quick on a long bank, a numbered running title in a PDF, a lock file and a
  // file that is too large said in words.
  const listJs14 = await text("/list.js");
  check("the list helper draws a long list in pages with a line that says how many are not drawn", /export function fillRows/.test(listJs14) && /Show all/.test(listJs14) && /export const ROWS_AT_FIRST = 1000/.test(listJs14));
  const reviewJs14 = await text("/review.js");
  const bankJs14 = await text("/bank.js");
  check("the import review and the bank draw their rows through it", /fillRows\(list, /.test(reviewJs14) && /fillRows\(list, /.test(bankJs14));

  const rows1500 = ["Question,A,B,C,D,Correct"];
  for (let i = 1; i <= 1500; i++) rows1500.push(`"Question number ${i} about the topic of the unit: which of the following statements is most accurate in the case above?","The first statement for ${i}","The second statement for ${i}","The third statement for ${i}","The fourth statement for ${i}",${"ABCD"[i % 4]}`);
  const long14 = await importText("long.csv", rows1500.join("\n"));
  check("a table of 1500 questions was read, every one parsed", long14.counts?.total === 1500 && long14.counts?.parsed === 1500, JSON.stringify(long14.counts));
  const long14saved = await (await send("POST", `/api/sessions/${long14.id}/save`, { title: "Smoke long" })).json();
  const t14 = Date.now();
  const long14run = await (await send("POST", `/api/banks/${encodeURIComponent(long14saved.bank)}/quality`, {})).json();
  check("Check quality on the 1500 questions took a few seconds at most and found no copies among questions that differ in a number", Date.now() - t14 < 8000 && (long14run.duplicates ?? []).length === 0 && long14run.checked === 1500, `${Date.now() - t14} ms, ${JSON.stringify(long14run.duplicates ?? []).slice(0, 80)}`);

  const { at: at14, buildPdf: buildPdf14 } = await import(pathToFileURL(join(repo, "packages/assess/test/support/pdf-builder.ts")).href);
  const widths14 = Array.from({ length: 224 }, () => 500);
  const quizPages = [1, 2, 3, 4].map((n) => at14(36, 700, 12, `${n}. A question that has an answer?`) + at14(36, 686, 12, "a. one") + at14(36, 672, 12, "b. two") + at14(36, 770, 12, `8. AI IN EVERYDAY LIFE  |  ${530 + n}`));
  const quizPdf = buildPdf14({ pages: quizPages, fonts: { F1: { kind: "simple", base: "Helvetica", widths: widths14 }, F2: { kind: "simple", base: "Helvetica-Bold", widths: widths14 } } });
  const pdf14bytes = await (await send("POST", "/api/import?name=quiz.pdf", new Uint8Array(quizPdf))).json();
  const stems14 = [];
  for (let n = 0; n < (pdf14bytes.counts?.total ?? 0); n++) stems14.push((await itemOf(pdf14bytes.id, n)).stem);
  check("a PDF whose pages each begin with a numbered running title has four questions and not five, and none of them is the title", pdf14bytes.counts?.total === 4 && !stems14.some((s) => /AI IN EVERYDAY LIFE/.test(s)), JSON.stringify({ counts: pdf14bytes.counts, stems: stems14.map((s) => s.slice(0, 30)) }));
  check("and the file says the lines at the edges were left out", (pdf14bytes.fileFindings ?? []).some((f) => /left out/.test(f.message) && /AI IN EVERYDAY LIFE/.test(f.message)));

  const lock = await send("POST", "/api/import?name=" + encodeURIComponent("~$exam.docx"), new Uint8Array(Buffer.alloc(162, 1)));
  const lockBody = await lock.json();
  check("Word's lock file is said to hold nothing, in words", lock.status === 400 && /not a document.*"~\$".*import the document itself/.test(lockBody.error ?? ""), `${lock.status} ${lockBody.error ?? ""}`.slice(0, 140));

  const { request: httpRequest14 } = await import("node:http");
  const tooBig = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ status: -1, text: "" }), 4000);
    const req = httpRequest14({ host: "127.0.0.1", port: new URL(base).port, path: "/api/import?name=bank.docx", method: "POST", headers: { cookie, "x-openassess": "1", "content-type": "application/octet-stream", "content-length": "999999999" } }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => { clearTimeout(timer); resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString("utf8") }); req.destroy(); });
    });
    req.on("error", () => undefined);
    req.write("{");
  });
  check("a file claiming to be 954 MB is refused saying how large it is, what the most is, and what to do", tooBig.status === 413 && /That is 954 MB, and the most this takes at once is 80 MB\. A file of questions is far smaller/.test(tooBig.text), `${tooBig.status} ${tooBig.text}`.slice(0, 160));

  // New in alpha 15: Blackboard's upload file is read, a table whose column names carry a description is read, a file that may not be a bank
  // says so, and Show all is offered only up to 5000.
  const T15 = "\t";
  const bb = ["MC\tWhich is cold?\tIce\tcorrect\tFire\tincorrect\tLava\tincorrect", "TF\tIce is cold.\ttrue", "FIB\tCapital of France?\tParis\tparis", "MAT\tMatch.\tFrance\tParis\tItaly\tRome", "ORD\tPut in order.\tFirst\tSecond\tThird", "ESS\tExplain.\tBecause."].join("\r\n") + "\r\n";
  const bb15 = await importText("upload.txt", bb);
  check("a Blackboard upload file was told by what it holds, and its six rows are six questions, none failed", bb15.profile === "blackboard-upload" && bb15.counts?.total === 6 && bb15.counts?.failed === 0, JSON.stringify({ p: bb15.profile, c: bb15.counts }));
  const bbQ = await itemOf(bb15.id, 0);
  check("its key is the answer marked correct", JSON.stringify(rightOf(bbQ)) === JSON.stringify(["Ice"]), JSON.stringify(rightOf(bbQ)));
  const bbBad = await importText("upload2.txt", "MC\tWhich?\ta\tcorrect\tb\tmaybe\r\nTF\tIce is cold.\ttrue\r\n");
  check("a row whose word is neither correct nor incorrect is kept as an essay and fails", bbBad.counts?.failed === 1 && (await itemOf(bbBad.id, 0)).type === "essay", JSON.stringify(bbBad.counts));
  const bbOut = await (await send("POST", `/api/banks/${bank}/export`, { destination: "blackboard-upload" })).json();
  const bbFile = bbOut.written?.[0];
  const bbBack = await importText(bbFile.name, readFileSync(bbFile.path, "utf8"));
  check("the bank written as Blackboard's upload file reads back as that, with no failure", bbBack.profile === "blackboard-upload" && bbBack.counts?.failed === 0 && bbBack.counts?.total >= 1, `${bbBack.profile} ${JSON.stringify(bbBack.counts)}`);

  const game15 = await importText("game.csv", ['Question - max 95 characters,Answer 1 - max 60 characters,Answer 2 - max 60 characters,Answer 3 - max 60 characters,"Time limit (sec) - 5, 10, 20",Correct answer(s) - choose at least one', '"Which planet is closest to the Sun?",Venus,Mercury,Earth,20,2'].join("\n"));
  const gameQ = await itemOf(game15.id, 0);
  check("a table whose column names carry a description is read, and the number in the last column names the answer", game15.counts?.parsed === 1 && JSON.stringify(rightOf(gameQ)) === JSON.stringify(["Mercury"]), JSON.stringify({ c: game15.counts, right: rightOf(gameQ) }));

  const outline = await importText("outline.txt", Array.from({ length: 6 }, (_, i) => `${i + 1}. Discuss the idea number ${i + 1} in two paragraphs.`).join("\n"));
  check("a file whose every question is a guess at an essay says it may not be a test bank, once, as information", (outline.fileFindings ?? []).filter((f) => /may not be a test bank/.test(f.message)).length === 1 && (outline.fileFindings ?? []).find((f) => /may not be a test bank/.test(f.message)).severity === "info");
  const listJs15 = await text("/list.js");
  check("Show all is offered only up to 5000 questions", /export const SHOW_ALL_UP_TO = 5000/.test(listJs15) && /items\.length <= SHOW_ALL_UP_TO/.test(listJs15));

  // After an independent review of those changes: a column of wrong answers is not the key, a Blackboard file with an unlisted type is still
  // read as one, text that shows nothing is empty, a long run of spaces is quick, banks that named a type are not told they may not be banks,
  // Blackboard's own pool export is named, and the home screen has real buttons for choosing a file.
  const wrongCol = await importText("wrongcol.csv", "Question,A,B,C,D,Answer - wrong,Correct\nWhich is cold?,Ice,Fire,Lava,Sun,Fire,A\n");
  check("a column called Answer - wrong is not the key, and is said not to be used", JSON.stringify(rightOf(await itemOf(wrongCol.id, 0))) === JSON.stringify(["Ice"]) && (wrongCol.fileFindings ?? []).some((f) => /not used: Answer - wrong/.test(f.message)), JSON.stringify(wrongCol.counts));
  const oddType = await importText("odd.tsv", ["MC\tWhich is cold 1?\tIce\tcorrect\tFire\tincorrect\tLava\tincorrect", "MC\tWhich is cold 2?\tFire\tincorrect\tSnow\tcorrect", "TF\tIce is cold.\ttrue", "FIB_PLUS\tThe [x] is [y]\tx\tcat\ty\tmat"].join("\r\n") + "\r\n");
  const oddFirst = await itemOf(oddType.id, 0);
  check("a Blackboard file with one row of an unlisted type is still read as one, the odd row kept and failed", oddType.profile === "blackboard-upload" && oddType.counts?.total === 4 && oddType.counts?.failed === 1 && JSON.stringify(rightOf(oddFirst)) === JSON.stringify(["Ice"]), JSON.stringify({ p: oddType.profile, c: oddType.counts, r: rightOf(oddFirst) }));
  const zw = String.fromCharCode(0x200b);
  const blank = await importText("blank.txt", `MC\t${zw}\ta\tcorrect\tb\tincorrect\r\nTF\tOk?\ttrue\r\n`);
  check("a stem that shows nothing is an empty stem and fails", blank.counts?.failed === 1, JSON.stringify(blank.counts));
  const t0 = Date.now();
  const spaces = await importText("spaces.txt", " ".repeat(100000) + "\n1. Which?\na. x\n*b. y\n");
  check("a text file that begins with 100,000 spaces is read in under two seconds", Date.now() - t0 < 2000 && spaces.counts?.total === 1, `${Date.now() - t0} ms`);
  const namedType = await importText("named.txt", Array.from({ length: 5 }, (_, i) => `Type: SA\n${i + 1}. What is the capital of country ${i + 1}?\nAnswer: City${i + 1}`).join("\n\n"));
  check("five questions that name a Type the importer does not know are not told they may not be a bank", !(namedType.fileFindings ?? []).some((f) => /may not be a test bank/.test(f.message)), JSON.stringify(namedType.counts));
  const { zipSync: zip15, textEntry: entry15 } = await import(pathToFileURL(join(repo, "packages/assess/src/container/zip.ts")).href);
  const pool = zip15([entry15("imsmanifest.xml", '<manifest xmlns:bb="http://www.blackboard.com/content-packaging/"><resources><resource bb:file="res00001.dat" type="assessment/x-bb-pool" identifier="res00001"/></resources></manifest>'), entry15("res00001.dat", "<POOL/>")]);
  const poolRes = await (await send("POST", "/api/import?name=pool.zip", new Uint8Array(pool))).json();
  check("Blackboard's own pool export is named as what it is", (poolRes.fileFindings ?? []).some((f) => /package that Blackboard exports for its own use/.test(f.message)), JSON.stringify(poolRes).slice(0, 160));
  const homeJs15 = await text("/home.js");
  check("the home screen's file choosers are real buttons, and the hidden inputs are out of the keyboard order", /h\("button", \{ type: "button", class: "button primary", text: "Choose a file"/.test(homeJs15) && (homeJs15.match(/tabIndex: -1, attrs: \{ "aria-hidden": "true" \}/g) ?? []).length === 2);

  // New in alpha 16, after a second independent review: a Blackboard type word of any length, stray lines among the rows, a header that is cut
  // at the wrong dash, a bare Answer that limits a text, a stem of an invisible filler, and Blackboard's pool export told from a course export.
  const jumbled = await importText("jumbled.tsv", ["MC\tWhich is cold 1?\tIce\tcorrect\tFire\tincorrect\tLava\tincorrect", "MC\tWhich is cold 2?\tFire\tincorrect\tSnow\tcorrect", "TF\tIce is cold.\ttrue", "JUMBLED_SENTENCE\tPut in order.\ta\tb"].join("\r\n") + "\r\n");
  const jumbledFirst = await itemOf(jumbled.id, 0);
  check("a Blackboard file with a type word of 16 characters is read as one, and its key is Ice", jumbled.profile === "blackboard-upload" && jumbled.counts?.failed === 1 && JSON.stringify(rightOf(jumbledFirst)) === JSON.stringify(["Ice"]), JSON.stringify({ p: jumbled.profile, c: jumbled.counts, r: rightOf(jumbledFirst) }));
  const strays = await importText("strays.tsv", ["MC\tWhich is cold 1?\tIce\tcorrect\tFire\tincorrect\tLava\tincorrect", "MC\tWhich is cold 2?\tFire\tincorrect\tSnow\tcorrect", "TF\tIce is cold.\ttrue", "ESS\tExplain.\tBecause.", "Total questions: 4"].join("\r\n") + "\r\n");
  check("a stray line at the end does not turn a Blackboard file into a table, and is kept and said", strays.profile === "blackboard-upload" && strays.counts?.total + strays.counts?.orphans >= 4 && JSON.stringify(rightOf(await itemOf(strays.id, 0))) === JSON.stringify(["Ice"]), JSON.stringify({ p: strays.profile, c: strays.counts }));
  const fourth = await importText("fourth.csv", "Question,Answer - 1 - max 60 characters,Answer - 2 - max 60 characters,Answer - 3 - max 60 characters,Answer - 4 - max 60 characters,Correct answer(s) - choose at least one\nWhat is 1+1?,2,3,4,5,1\n");
  check("answer columns whose names carry a number and a limit are the answers, and the key is the first", JSON.stringify(rightOf(await itemOf(fourth.id, 0))) === JSON.stringify(["2"]) && fourth.counts?.parsed === 1, JSON.stringify(fourth.counts));
  const bareLimit = await importText("barelimit.csv", "Question,A,B,C,D,Answer - max 60 characters,Correct\nWhich is cold?,Ice,Fire,Lava,Sun,Fire,A\n");
  check("a bare Answer limited like a text is not the key", JSON.stringify(rightOf(await itemOf(bareLimit.id, 0))) === JSON.stringify(["Ice"]) && (bareLimit.fileFindings ?? []).some((f) => /not used: Answer - max 60 characters/.test(f.message)), JSON.stringify(bareLimit.counts));
  const filler = await importText("filler.txt", `MC\t${String.fromCharCode(0x3164)}\ta\tcorrect\tb\tincorrect\r\nTF\tOk?\ttrue\r\n`);
  check("a stem of only a Hangul filler is an empty stem and fails", filler.counts?.failed === 1, JSON.stringify(filler.counts));
  const course = zip15([entry15("imsmanifest.xml", '<manifest xmlns:bb="http://www.blackboard.com/content-packaging/"><resources><resource type="resource/x-bb-document" bb:file="res00001.dat"/></resources></manifest>'), entry15("res00001.dat", "<DOC/>")]);
  const courseRes = await (await send("POST", "/api/import?name=course.zip", new Uint8Array(course))).json();
  check("a course export with no assessment in it is not called a pool", !(courseRes.fileFindings ?? []).some((f) => /Blackboard exports for its own use/.test(f.message)), JSON.stringify(courseRes).slice(0, 120));

  // New in alpha 17, after a third independent review: a Blackboard-shaped row whose answers are the words themselves is flagged when it is read
  // as a table, a first question with the answer Stem is not a header, Correct answer with a limit is the key, and the pool message is read from XML.
  const claimRow = await importText("claim.csv", "MC,Is the claim that ice is cold correct?,Correct,correct,Incorrect,incorrect,Unsure,incorrect\n");
  check("a Blackboard row whose answers are the words Correct and Incorrect, read as a table, is not called parsed", claimRow.counts?.parsed === 0 && claimRow.counts?.total === 1, JSON.stringify(claimRow.counts));
  const stemAnswer = await importText("stem.tsv", ["MC\tWhich word names the question text?\tStem\tcorrect\tAnswer\tincorrect", "TF\tIce is cold.\ttrue", "MC\tWhich is cold?\tIce\tcorrect\tFire\tincorrect"].join("\r\n") + "\r\n");
  check("a Blackboard file whose first question has the answer Stem is read as one, all three questions parsed", stemAnswer.profile === "blackboard-upload" && stemAnswer.counts?.parsed === 3, JSON.stringify({ p: stemAnswer.profile, c: stemAnswer.counts }));
  const correctLimit = await importText("correctlimit.csv", "Question,A,B,C,Correct answer - max 60 characters\nWhich?,x,y,z,B\n");
  check("a column called Correct answer with a limit is the key", JSON.stringify(rightOf(await itemOf(correctLimit.id, 0))) === JSON.stringify(["y"]), JSON.stringify(correctLimit.counts));
  const xsiPool = zip15([entry15("imsmanifest.xml", '<manifest><resources><resource xsi:type="assessment/x-bb-pool" type="webcontent" href="res00001.dat"/></resources></manifest>'), entry15("res00001.dat", "<POOL/>")]);
  const xsiRes = await (await send("POST", "/api/import?name=xsi.zip", new Uint8Array(xsiPool))).json();
  check("a manifest that names a pool only in another attribute is not called Blackboard's pool", !(xsiRes.fileFindings ?? []).some((f) => /Blackboard exports for its own use/.test(f.message)), JSON.stringify(xsiRes).slice(0, 120));

  // New in alpha 18, after a round trip of random questions through every exporter: GIFT keeps a stem that begins // and leaves out an answer
  // with an arrow, a Correct cell that is also a list is not guessed at, a number with an exponent is read, a Moodle answer that looks like a tag stays.
  const giftSource = await importText("gift-source.txt", ["1. // Given the code above, what does x equal?", "a. 1", "*b. 2", "c. 3", "", "2. Which is the contrapositive of p -> q?", "*a. NOT q -> NOT p", "b. q -> p", "", "3. What is 2+2?", "a. 3", "*b. 4"].join("\n") + "\n");
  const giftBank = await (await send("POST", `/api/sessions/${giftSource.id}/save`, { title: "Round trip" })).json();
  const giftOut = await (await send("POST", `/api/banks/${encodeURIComponent(giftBank.bank)}/export`, { destination: "gift" })).json();
  const giftText = giftOut.written?.[0] ? readFileSync(giftOut.written[0].path, "utf8") : "";
  check("a stem that begins // is written after a [plain] tag, so GIFT does not read it as a comment", /\[plain\]\/\/ Given the code above/.test(giftText), giftText.slice(0, 120));
  check("a question with an arrow in an answer is left out of the GIFT file, and the others are written", !giftText.includes("->") && /What is 2\+2\?/.test(giftText), JSON.stringify(giftOut.report?.items?.map((i) => i.outcome)));
  const listCell = await importText("listcell.csv", 'Type,Question,A,B,C,D,Correct\nMR,Select all the valid answers.,A,"A, B",B,Neither,"A, B"\n');
  check("a Correct cell that is the words of an answer and also a list of answers marks nothing", listCell.counts?.parsed === 0 && listCell.counts?.failed === 1, JSON.stringify(listCell.counts));
  const exponent = await importText("exponent.gift", "What is G? {#6.67e-11}\n\nHow big? {#1E+21}\n");
  check("a GIFT number with an exponent is read", exponent.counts?.parsed === 2 && exponent.counts?.total === 2, JSON.stringify(exponent.counts));
  const tagXml = '<?xml version="1.0"?><quiz><question type="matching"><name><text>M</text></name><questiontext format="html"><text>Match.</text></questiontext><shuffleanswers>1</shuffleanswers>' + [["Line break", "&lt;br&gt; inserts a line break"], ["Paragraph", "&lt;p&gt; starts a paragraph"], ["Bold", "&lt;b&gt; makes text bold"]].map(([l, r]) => `<subquestion format="html"><text>${l}</text><answer><text>${r}</text></answer></subquestion>`).join("") + "</question></quiz>";
  const tagged = await importText("tags.xml", tagXml);
  check("a Moodle matching answer that looks like a tag is kept as written", JSON.stringify(await itemOf(tagged.id, 0)).includes("<br> inserts a line break") && tagged.counts?.parsed === 1, JSON.stringify(tagged.counts));
  const sideCells = await importText("sidecells.csv", "Type,Question,A,B,Correct\nMC,What is 2+2?,3,4,B,SECRET EXTRA,MORE\n");
  check("text past the last named column is said, and the question needs a look", sideCells.counts?.parsed === 0 && sideCells.counts?.needsReview === 1, JSON.stringify(sideCells.counts));

  // New in alpha 19, after a fifth reader and a tester of pictures, equations and fields: a large picture in a Moodle file is read, a letter that
  // is also the words of another answer is not guessed, plain-text answers keep their tags, and a GIFT file keeps what it is given.
  const bigPicture = Buffer.concat([Buffer.from(png(20, 20)), Buffer.alloc(6_000_000, 7)]).toString("base64");
  const bigXml = `<?xml version="1.0"?><quiz><question type="multichoice"><name><text>Photo</text></name><questiontext format="html"><text><![CDATA[<p>What does it show? <img src="@@PLUGINFILE@@/big.png" alt="A photograph"></p>]]></text><file name="big.png" path="/" encoding="base64">${bigPicture}</file></questiontext><single>true</single><answer fraction="100" format="html"><text>A bridge</text></answer><answer fraction="0" format="html"><text>A tower</text></answer></question></quiz>`;
  const bigRes = await send("POST", "/api/import?name=photo.xml", new Uint8Array(Buffer.from(bigXml, "utf8")));
  const bigBody = await bigRes.json();
  check("a Moodle file with a picture of 6 MB is read and not refused with an error", bigRes.status === 200 && bigBody.counts?.total === 1, `${bigRes.status} ${JSON.stringify(bigBody.counts ?? bigBody).slice(0, 100)}`);
  const letterWords = await importText("letterwords.csv", "Type,Question,A,B,C,D,Correct\nMC,Which?,D,A,C,B,A\n");
  check("a letter that is also the words of another answer marks nothing", letterWords.counts?.failed === 1 && letterWords.counts?.parsed === 0, JSON.stringify(letterWords.counts));
  const plainAnswers = await importText("plain.xml", '<?xml version="1.0"?><quiz><question type="shortanswer"><name><text>S</text></name><questiontext format="html"><text>Greet.</text></questiontext><usecase>0</usecase><answer fraction="100" format="plain_text"><text>&lt;p&gt;Hello&lt;/p&gt;</text></answer></question></quiz>');
  check("a short answer written as plain text keeps the tags that are in it", JSON.stringify(await itemOf(plainAnswers.id, 0)).includes("<p>Hello</p>"), JSON.stringify(plainAnswers.counts));

  // New in alpha 20, after two review methods (a security one and an interface one) were tried on the whole app: each copy names its own
  // key cookie, a PDF whose rows have no width is answered and does not hold the program, a long bank title exports and prints under a
  // name cut to fit, and the screens that fix the skip link and the Save dialog are carried.
  check("the key cookie is named for this copy's port, so a second copy on the same host does not take its key", cookie.split("=")[0] === `oa_key_${new URL(base).port}`, cookie.split("=")[0]);
  const rowsPdf = buildPdf14({ pages: [at14(36, 700, 12, "Page one is fine."), at14(36, 700, 12, "Page two is the bad one."), at14(36, 700, 12, "Page three is fine.")], compress: true, parmsPage: 1, decodeParms: "<< /Predictor 2 /Columns 0 >>", fonts: { F1: { kind: "simple", base: "Helvetica", widths: widths14 } } });
  let rowsStatus = 0;
  let rowsText = "";
  try {
    const rowsReply = await fetch(base + "/api/import?name=rows.pdf", { method: "POST", headers: { cookie, "x-openassess": "1" }, body: new Uint8Array(rowsPdf), signal: AbortSignal.timeout(20000) });
    rowsStatus = rowsReply.status;
    rowsText = await rowsReply.text();
  } catch (error) {
    rowsText = String(error);
  }
  check("a PDF whose rows have no width is answered within 20 seconds, with that page said to be unreadable", rowsStatus === 200 && /could not be read[^"]*page 2|cannot be right/.test(rowsText), `${rowsStatus} ${rowsText.slice(0, 100)}`);
  check("and the app is still answering afterwards", (await send("GET", "/api/state")).status === 200);
  const longTitle = "Psychology Chapter Three Test Bank Fall Section 002 ".repeat(2).slice(0, 70).replace(/ $/, "x");
  const longSession = await importText("long.txt", "1. What is 2+2?\na. 3\n*b. 4\n\n");
  const longSaved = await (await send("POST", `/api/sessions/${longSession.id}/save`, { title: longTitle })).json();
  const longBank = `/api/banks/${encodeURIComponent(longSaved.bank)}`;
  const longExport = await send("POST", `${longBank}/export`, { destination: "common-cartridge" });
  const longExported = await longExport.json();
  check("a bank with a 70-character title exports to Common Cartridge under a name cut to fit", longExport.status === 200 && (longExported.written?.[0]?.name.length ?? 999) <= 80, `${longExport.status} ${JSON.stringify(longExported).slice(0, 120)}`);
  const longPrint = await send("POST", `${longBank}/print`, { kinds: ["student", "key"], formats: ["docx"] });
  const longPrinted = await longPrint.json();
  check("and prints under names cut to fit", longPrint.status === 200 && (longPrinted.written ?? []).length === 2 && longPrinted.written.every((w) => w.name.length <= 80), `${longPrint.status} ${JSON.stringify(longPrinted).slice(0, 120)}`);
  const appJs = await text("/app.js");
  const saveFieldsJs = await text("/save-fields.js");
  check("the skip link is wired to move focus, and not left to the address", /skipTo\(/.test(appJs) && domJs.includes("export function skipTo") && /event\.preventDefault\(\)/.test(domJs));
  check("the Save dialog's fields are named, and a save that leaves questions out says which", saveFieldsJs.includes("export function saveFields") && saveFieldsJs.includes('"aria-label": NEW') && saveFieldsJs.includes("export function notSavedBody"));

  const dialogsJs = await (await fetch(base + "/dialogs.js", { headers: { cookie } })).text();
  check("the question dialog is named by its heading", /aria-labelledby/.test(dialogsJs) && /dialog-title/.test(dialogsJs));
  const page = await (await fetch(base + "/math.js", { headers: { cookie } })).text();
  check("the page serves the equation drawer", page.includes("export function drawMath"));
  check("the library folders were made", ["Banks", "Exports", "Deleted"].every((d) => existsSync(join(home, d))), readdirSync(home).join(", "));
} catch (error) {
  results.push("FAIL " + (error instanceof Error ? error.message : String(error)));
} finally {
  child.kill();
}
console.log(results.join("\n"));
process.exitCode = results.some((r) => r.startsWith("FAIL")) ? 1 : 0;
