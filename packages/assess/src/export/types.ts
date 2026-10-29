/**
 * The destination check.
 *
 * Every exporter answers the same question before it writes anything: of these
 * questions, which will arrive as they are, which will arrive with something
 * lost, and which cannot go at all. The answer is a report rather than a
 * warning dialog, so that the command line, the desktop app and the tests all
 * read the same thing.
 *
 * Two rules from the project apply here. A question that cannot be exported is
 * left out and said so; it is never exported as something it is not, and no
 * answer key is ever guessed to make it fit. And whatever is lost on the way is
 * listed against the question that lost it, not summarised away.
 */

/**
 * exported            arrived as written.
 * exportedWithLosses  arrived, but something did not survive. The notes say what.
 * leftOut             could not be exported. The notes say why.
 */
export type Outcome = "exported" | "exportedWithLosses" | "leftOut";

export interface ReportItem {
  /** One-based position in the list that was exported, so the author can find it. */
  position: number;
  questionId: string;
  title: string;
  outcome: Outcome;
  /** When the question arrived as a different kind, the destination's name for it. */
  asType?: string;
  /** What did not survive, or why the question was left out. Empty when nothing was lost. */
  notes: string[];
}

export interface DestinationReport {
  /** A short stable id, for example "openstage-spreadsheet". */
  destination: string;
  /** What to call it in front of a person. */
  label: string;
  total: number;
  exported: number;
  exportedWithLosses: number;
  leftOut: number;
  /** The names of the files that will be written, in order. */
  files: string[];
  /** Things true of every exported question, said once. */
  general: string[];
  /** One entry for every question, in order. */
  items: ReportItem[];
}

export interface ExportedFile {
  name: string;
  content: string;
  /** How many questions are in this file. */
  questions: number;
}

export interface ExportResult {
  files: ExportedFile[];
  report: DestinationReport;
}

/** How many questions are named under one note before the rest are only numbered. */
const MAX_LISTED = 8;

function shortTitle(title: string): string {
  const flat = title.replace(/\s+/g, " ").trim();
  return flat.length > 50 ? `${flat.slice(0, 49)}...` : flat;
}

/** The report as lines of plain text, for the command line. */
export function formatReport(report: DestinationReport): string[] {
  const lines: string[] = [];
  lines.push(`Destination check: ${report.label}`);
  lines.push(
    `  ${report.total} question(s): ${report.exported} exported as written, ` +
      `${report.exportedWithLosses} exported with something lost, ${report.leftOut} left out.`,
  );
  if (report.files.length > 0) lines.push(`  File(s): ${report.files.join(", ")}`);
  for (const note of report.general) lines.push(`  Note: ${note}`);

  // The same note on many questions is said once, with the questions listed
  // under it. A bank of 500 would otherwise print the same line hundreds of times
  // and bury the one question that has something different to say.
  const section = (heading: string, outcome: Outcome): void => {
    const items = report.items.filter((item) => item.outcome === outcome);
    if (items.length === 0) return;
    lines.push("", `  ${heading}`);

    const groups = new Map<string, ReportItem[]>();
    for (const item of items) {
      for (const note of item.notes) {
        const group = groups.get(note);
        if (group) group.push(item);
        else groups.set(note, [item]);
      }
    }
    for (const [note, members] of groups) {
      lines.push(`    ${note}`);
      for (const member of members.slice(0, MAX_LISTED)) {
        lines.push(`        #${member.position} "${shortTitle(member.title)}"`);
      }
      if (members.length > MAX_LISTED) {
        const rest = members.slice(MAX_LISTED).map((member) => `#${member.position}`);
        lines.push(`        and ${rest.length} more: ${rest.join(", ")}`);
      }
    }
  };
  section("Left out", "leftOut");
  section("Exported, with something lost", "exportedWithLosses");
  return lines;
}
