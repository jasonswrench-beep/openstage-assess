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
  UnsupportedType: "import.unsupported-type",
  UnreadContent: "import.unread-content",
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
  NumberOutOfSequence: "import.number-out-of-sequence",
  MetadataLineContinued: "import.metadata-line-continued",
  RationaleRead: "import.rationale-read",
  TypeLineQuestions: "import.type-line-questions",
  TypeLineMissing: "import.type-line-missing",
  TypeLineAmongOptions: "import.type-line-among-options",
  TypeFromEvidence: "import.type-from-evidence",
  AcceptedAnswersSplit: "import.accepted-answers-split",
  PairLeftOut: "import.pair-left-out",

  // Item quality. Advisory by design; authors may dismiss any of them.
  AllOrNoneOfTheAbove: "quality.all-or-none-of-the-above",
  LongestOptionCorrect: "quality.longest-option-correct",
  NegativeStemNotEmphasised: "quality.negative-stem-not-emphasised",
  GrammaticalCue: "quality.grammatical-cue",
  DuplicateQuestion: "quality.duplicate-question",
  NearDuplicateQuestion: "quality.near-duplicate-question",
  KeyImbalance: "quality.key-imbalance",
  ReadingLevelHigh: "quality.reading-level-high",

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
