/**
 * Findings.
 *
 * A finding is anything the engine noticed about a question: an import that
 * had to guess, a missing answer key, an item-quality warning, an
 * accessibility problem. Findings live on the question, carry a severity, and
 * can be dismissed by an author, so a decision that an item deliberately uses
 * "none of the above" survives the next check.
 *
 * The three import verdicts in the plan are derived from severities, not
 * stored separately: an error means failed, a warning means needs review,
 * nothing means parsed. One source of truth.
 */

export type Severity = "error" | "warn" | "info";

/** Where in a source document a finding or a question came from. */
export interface SourceRef {
  /** The file as the user named it, not an absolute path. */
  file: string;
  /** Zero-based index of the first source block this covers. */
  firstBlock: number;
  /** Zero-based index of the last source block this covers, inclusive. */
  lastBlock: number;
}

export interface Finding {
  code: string;
  severity: Severity;
  message: string;
  /** Dotted path into the question, for example body.options.2.content. */
  field?: string;
  source?: SourceRef;
  dismissed?: boolean;
  dismissedBy?: string;
  dismissedAt?: string;
}

/**
 * Finding codes. Grouped by the stage that raises them so a reader can tell
 * at a glance whether a problem came from the file or from the item itself.
 */
export const FindingCode = {
  // Import: the parser could not build the question.
  NoAnswerKey: "import.no-answer-key",
  KeyLetterMissing: "import.key-letter-missing",
  MultipleKeysOnSingleAnswer: "import.multiple-keys-on-single-answer",
  NoOptions: "import.no-options",
  TooFewOptions: "import.too-few-options",
  EmptyOption: "import.empty-option",
  EmptyStem: "import.empty-stem",
  UnparsedBlock: "import.unparsed-block",

  // Import: the parser had to guess, and a human should look.
  TypeInferred: "import.type-inferred",
  /** Said of a whole file: every question in it was a guess at an essay, which is what a document that is not a test bank reads as. */
  NotLikelyABank: "import.not-likely-a-bank",
  UnsupportedType: "import.unsupported-type",
  UnreadContent: "import.unread-content",
  UnreadObject: "import.unread-object",
  TableFlattened: "import.table-flattened",
  TableLayout: "import.table-layout",
  AmbiguousFeedback: "import.ambiguous-feedback",
  UnknownMetadataLabel: "import.unknown-metadata-label",
  MetadataKeptAsNote: "import.metadata-kept-as-note",
  OptionWithoutLetter: "import.option-without-letter",
  TitleTruncated: "import.title-truncated",
  PointsAssumed: "import.points-assumed",
  TrackedChangesPresent: "import.tracked-changes-present",
  MarkupRemoved: "import.markup-removed",
  EquationAsImage: "import.equation-as-image",
  DuplicateQuestionNumber: "import.duplicate-question-number",
  OptionLetterGap: "import.option-letter-gap",
  DuplicateOptionLetter: "import.duplicate-option-letter",
  DuplicateMetadataLabel: "import.duplicate-metadata-label",
  StemSpansBlankLine: "import.stem-spans-blank-line",
  OptionFeedbackNotKept: "import.option-feedback-not-kept",
  OptionNotKept: "import.option-not-kept",
  KeyTextNotUsed: "import.key-text-not-used",
  KeysDisagree: "import.keys-disagree",
  FormattingKeyUsed: "import.formatting-key-used",
  FormattingKeyUnclear: "import.formatting-key-unclear",
  FormattingKeyBroken: "import.formatting-key-broken",
  StarAfterLetterKeyUsed: "import.star-after-letter-key-used",
  StarAfterLetterKeyUnclear: "import.star-after-letter-key-unclear",
  AnswerKeyPart: "import.answer-key-part",
  AnswerFromUnlabelledLine: "import.answer-from-unlabelled-line",
  RepeatedQuestionsFolded: "import.repeated-questions-folded",
  BlankCountMismatch: "import.blank-count-mismatch",
  StemFromHeading: "import.stem-from-heading",
  OptionsSplitFromLine: "import.options-split-from-line",
  AnswerEndsLine: "import.answer-ends-line",
  UnlabelledGroups: "import.unlabelled-groups",
  MarkAtEndOfOption: "import.mark-at-end-of-option",
  NumberOutOfSequence: "import.number-out-of-sequence",
  MetadataLineContinued: "import.metadata-line-continued",
  RationaleRead: "import.rationale-read",
  TypeLineQuestions: "import.type-line-questions",
  TypeLineMissing: "import.type-line-missing",
  TypeLineAmongOptions: "import.type-line-among-options",
  TypeFromEvidence: "import.type-from-evidence",
  AcceptedAnswersSplit: "import.accepted-answers-split",
  PairLeftOut: "import.pair-left-out",
  WeightsNotKept: "import.weights-not-kept",
  MoreThanOneRight: "import.more-than-one-right",

  // Item quality. Advisory by design; authors may dismiss any of them.
  AllOrNoneOfTheAbove: "quality.all-or-none-of-the-above",
  LongestOptionCorrect: "quality.longest-option-correct",
  NegativeStemNotEmphasised: "quality.negative-stem-not-emphasised",
  GrammaticalCue: "quality.grammatical-cue",
  DuplicateOption: "quality.duplicate-option",
  DuplicateQuestion: "quality.duplicate-question",
  NearDuplicateQuestion: "quality.near-duplicate-question",
  KeyImbalance: "quality.key-imbalance",
  ReadingLevelHigh: "quality.reading-level-high",
  TypedAnswerTypography: "quality.typed-answer-typography",

  // Accessibility.
  MissingAltText: "a11y.missing-alt-text",
  AltTextGivesAnswer: "a11y.alt-text-gives-answer",
  EquationNotMathML: "a11y.equation-not-mathml",
  ColourOnlyMeaning: "a11y.colour-only-meaning",
  LongMatchingList: "a11y.long-matching-list",

  // Model: the question does not satisfy the schema.
  SchemaInvalid: "model.schema-invalid",
  DanglingMediaRef: "model.dangling-media-ref",
  DanglingMathRef: "model.dangling-math-ref",
} as const;

export type FindingCodeValue = (typeof FindingCode)[keyof typeof FindingCode];

export function finding(
  code: string,
  severity: Severity,
  message: string,
  extra: Partial<Finding> = {},
): Finding {
  return { code, severity, message, ...extra };
}

/**
 * The most findings of one kind (one code) a question lists. A line of answers with 130,000 words that name no option made one finding
 * for each, and a list that long is of no use to the person who has to read it (and was 650 KB of text from a 650 KB file).
 */
export const MOST_FINDINGS_OF_A_KIND = 25;

/** What the finding that counts the rest says after the number, and before the words of the first of them. */
const CAP_SUMMARY_WORDS = "more findings of this kind were not listed. The first of them was: ";

/**
 * Whether a finding is the one `capFindings` makes to count the findings of its kind that were not listed. It stands for several, so
 * the code that settles findings one at a time (a placeholder that has been written over) has to know it from the others: its `field`
 * is only the place of the first of them.
 */
export function isCapSummary(f: Finding): boolean {
  const space = f.message.indexOf(" ");
  return space > 0 && /^\d+$/.test(f.message.slice(0, space)) && f.message.startsWith(CAP_SUMMARY_WORDS, space + 1);
}

/**
 * The findings with no more than `limit` of any one code. The ones past it are not dropped without a word: one finding of the same code
 * and the highest severity of those left out says how many there were and where the first of them was, so a person fixing the question
 * knows that the list is cut. A dismissal of the kind (`replaceFileKeyProblems` dismisses a code at a time) reaches it with the rest.
 * The order is kept, and the list is returned as it is when nothing is over.
 *
 * Every question is made by `createQuestion`, which cuts its findings here, so an importer that makes a finding for each entry of a file
 * (a Moodle short answer with 100,000 answers that earn part credit made 100,000) cannot list more than this however it loops. A list
 * that has been cut once is not cut again: the finding that counts the rest is not one of the findings it counts.
 */
export function capFindings(findings: readonly Finding[], limit = MOST_FINDINGS_OF_A_KIND): Finding[] {
  const seen = new Map<string, number>();
  const kept: Finding[] = [];
  const over = new Map<string, { count: number; first: Finding; severity: Severity }>();
  const rank: Record<Severity, number> = { info: 0, warn: 1, error: 2 };
  for (const f of findings) {
    if (isCapSummary(f)) {
      kept.push(f);
      continue;
    }
    const n = (seen.get(f.code) ?? 0) + 1;
    seen.set(f.code, n);
    if (n <= limit) {
      kept.push(f);
      continue;
    }
    const held = over.get(f.code);
    if (held === undefined) over.set(f.code, { count: 1, first: f, severity: f.severity });
    else {
      held.count++;
      if (rank[f.severity] > rank[held.severity]) held.severity = f.severity;
    }
  }
  if (over.size === 0) return findings.slice();
  for (const [code, held] of over) {
    kept.push(
      finding(code, held.severity, `${held.count} ${CAP_SUMMARY_WORDS}${held.first.message}`, {
        ...(held.first.field !== undefined ? { field: held.first.field } : {}),
        ...(held.first.source !== undefined ? { source: held.first.source } : {}),
      }),
    );
  }
  return kept;
}

/** Findings an author has not dismissed. */
export function liveFindings(findings: readonly Finding[]): Finding[] {
  return findings.filter((f) => !f.dismissed);
}

export function highestSeverity(findings: readonly Finding[]): Severity | undefined {
  const live = liveFindings(findings);
  if (live.some((f) => f.severity === "error")) return "error";
  if (live.some((f) => f.severity === "warn")) return "warn";
  if (live.length > 0) return "info";
  return undefined;
}

export type Verdict = "parsed" | "needsReview" | "failed";

/**
 * The verdict that the accuracy target counts. Only "parsed" counts toward the
 * 95 percent, which is the honest way to count it.
 */
export function verdictFrom(findings: readonly Finding[]): Verdict {
  const severity = highestSeverity(findings);
  if (severity === "error") return "failed";
  if (severity === "warn") return "needsReview";
  return "parsed";
}
