import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  createQuestion,
  editQuestion,
  setStatus,
  dismissFinding,
  checkReferences,
} from "../src/model/create.ts";
import { validateQuestion } from "../src/model/schema.ts";
import { isId, newQuestionId, idTime, localId } from "../src/model/ids.ts";
import {
  sanitizeRichText,
  richTextToPlain,
  plainToRich,
  collectRefs,
  mediaPlaceholder,
  normalizeCharacters,
  foldTypography,
} from "../src/model/richtext.ts";
import { verdictFrom, finding } from "../src/model/findings.ts";
import { checkAnswerKey, hasUsableKey } from "../src/quality/answer-key.ts";
import { titleFromStem, MAX_TITLE_LENGTH } from "../src/model/question.ts";

function multipleChoice(overrides: Record<string, unknown> = {}) {
  return createQuestion({
    type: "multipleChoice",
    stem: "Who determined the exact speed of light?",
    body: {
      shuffle: true,
      options: [
        { id: "o1", content: plainToRich("Albert Einstein"), correct: false },
        { id: "o2", content: plainToRich("Albert Michelson"), correct: true },
      ],
    },
    at: "2026-01-01T00:00:00.000Z",
    by: "test",
    ...overrides,
  });
}

describe("ids", () => {
  test("a question id is recognised and sorts by creation time", () => {
    const early = newQuestionId(1_700_000_000_000);
    const late = newQuestionId(1_800_000_000_000);
    assert.ok(isId(early, "q"));
    assert.ok(early < late, "ids must sort by creation order");
    assert.equal(idTime(early), 1_700_000_000_000);
  });

  test("an id of the wrong prefix is rejected", () => {
    assert.equal(isId(newQuestionId(), "bank"), false);
    assert.equal(isId("not-an-id"), false);
  });

  test("local ids are one-based and readable", () => {
    assert.equal(localId("o", 0), "o1");
    assert.equal(localId("p", 3), "p4");
  });
});

describe("rich text", () => {
  test("keeps the subset and unwraps everything else, never losing the words", () => {
    const result = sanitizeRichText('<p>Keep <strong>this</strong> and <span class="x">that</span>.</p>');
    assert.equal(result.html, "<p>Keep <strong>this</strong> and that.</p>");
    assert.deepEqual(result.removedTags, ["span"]);
  });

  test("drops the content of a script, not just its tag", () => {
    const result = sanitizeRichText("<p>Before</p><script>alert(1)</script><p>After</p>");
    assert.equal(result.html, "<p>Before</p><p>After</p>");
    assert.ok(!result.html.includes("alert"));
  });

  test("strips attributes that are not on the allow list", () => {
    const result = sanitizeRichText('<td colspan="2" onclick="x()">cell</td>');
    assert.ok(result.html.includes('colspan="2"'));
    assert.ok(!result.html.includes("onclick"));
    assert.deepEqual(result.removedAttributes, ["td@onclick"]);
  });

  test("closes tags a source left open", () => {
    const result = sanitizeRichText("<p>Unclosed");
    assert.equal(result.html, "<p>Unclosed</p>");
  });

  test("cleans the character noise that arrives from Word and keeps what the author typed", () => {
    // A no-break space becomes a space, a soft hyphen and a zero-width space go, and a line ends one way. Curly quotes, the en dash,
    // the em dash and the ellipsis stay: they were once flattened here, and an em dash printed as two hyphens.
    const noisy = "“Smart” – quotes… and spaces­​\r\nnext — line";
    assert.equal(normalizeCharacters(noisy), "“Smart” – quotes… and spaces\nnext — line");
  });

  test("typography is folded to its flat form only when a comparison asks, and never in what is stored", () => {
    assert.equal(foldTypography("“Smart” – it’s… —"), '"Smart" - it\'s... --');
    // Two texts that differ only in how a quotation mark is drawn fold to the same text.
    assert.equal(foldTypography("don’t"), foldTypography("don't"));
    // The stored form of rich text is not folded.
    assert.equal(sanitizeRichText("<p>“Hamlet” — it’s…</p>").html, "<p>“Hamlet” — it’s…</p>");
  });

  test("a no-break space between the words of a line with typography becomes a space and nothing else changes", () => {
    const messy = "“Smart” – quotes… and spaces";
    assert.equal(normalizeCharacters(messy), "“Smart” – quotes… and spaces");
  });

  test("placeholders are found by collectRefs and ignored by the plain text", () => {
    const text = plainToRich("See the apparatus:");
    const withMedia = { ...text, content: `${text.content}<p>${mediaPlaceholder("m_1")}</p>` };
    assert.deepEqual(collectRefs(withMedia).media, ["m_1"]);
    assert.equal(richTextToPlain(withMedia), "See the apparatus:");
  });
});

describe("the question envelope", () => {
  test("a well-formed question validates", () => {
    assert.equal(validateQuestion(multipleChoice()).ok, true);
  });

  test("a delivery setting is refused with an explanation, not a bare unknown key", () => {
    const question = { ...multipleChoice(), attempts: 3 };
    const result = validateQuestion(question);
    assert.equal(result.ok, false);
    const issue = result.issues.find((i) => i.path === "attempts");
    assert.ok(issue, "attempts must be reported");
    assert.match(issue.message, /property of the quiz, not the item/);
  });

  test("other quiz behaviour is refused the same way", () => {
    for (const key of ["timeLimit", "showCorrectAnswers", "dueDate", "weight"]) {
      const result = validateQuestion({ ...multipleChoice(), [key]: 1 });
      assert.equal(result.ok, false, `${key} should be refused`);
      assert.match(result.issues.find((i) => i.path === key)?.message ?? "", /not allowed on a question/);
    }
  });

  test("the schema checks structure, not whether the answer key is sane", () => {
    // A half-written question has to be saveable, and an imported question
    // with no key has to be storable so it can be repaired beside its source.
    const question = multipleChoice();
    (question.body as { options: Array<{ correct: boolean }> }).options[1]!.correct = false;
    assert.equal(validateQuestion(question).ok, true);
  });

  test("ordering positions must be 1..n with no gaps", () => {
    const question = createQuestion({
      type: "ordering",
      stem: "Put these in order.",
      body: {
        items: [
          { id: "i1", content: plainToRich("First"), position: 1 },
          { id: "i2", content: plainToRich("Second"), position: 3 },
        ],
      },
    });
    assert.equal(validateQuestion(question).ok, false);
  });

  test("a hotspot question must carry an accessible alternative", () => {
    const question = createQuestion({
      type: "hotspot",
      stem: "Click the interferometer.",
      body: {
        mediaRef: "m_1",
        regions: [{ id: "r1", shape: "rect", coords: [0, 0, 10, 10], correct: true }],
        alternative: plainToRich(""),
      },
    });
    const result = validateQuestion(question);
    assert.equal(result.ok, false);
    assert.ok(result.issues.some((i) => i.path === "body.alternative.content"));
  });

  test("metadata.custom is the one escape hatch and it takes strings", () => {
    const question = multipleChoice();
    question.metadata.custom = { MSC: "Conceptual" };
    assert.equal(validateQuestion(question).ok, true);
  });

  test("an import profile id an older version wrote still validates, so a bank saved then still opens", () => {
    const question = { ...multipleChoice(), origin: { kind: "import", profile: "an-older-profile-id", at: "2026-01-01T00:00:00.000Z" } };
    assert.equal(validateQuestion(question).ok, true);
  });
});

describe("editing rules", () => {
  test("an edit bumps the version and writes history", () => {
    const original = multipleChoice();
    const edited = editQuestion(original, { points: 2 }, { by: "jason", at: "2026-02-01T00:00:00.000Z" });
    assert.equal(edited.version, original.version + 1);
    assert.equal(edited.history.at(-1)?.by, "jason");
    assert.equal(edited.history.at(-1)?.fromVersion, 1);
  });

  test("editing a reviewed question returns it to draft", () => {
    const reviewed = setStatus(multipleChoice(), "reviewed", { by: "jason" });
    assert.equal(reviewed.metadata.status, "reviewed");
    const edited = editQuestion(reviewed, { points: 3 }, { by: "jason" });
    assert.equal(edited.metadata.status, "draft");
  });

  test("setting the status is not itself an edit that demotes it", () => {
    const approved = setStatus(multipleChoice(), "approved", { by: "jason" });
    assert.equal(approved.metadata.status, "approved");
  });

  test("an empty edit changes nothing", () => {
    const original = multipleChoice();
    assert.equal(editQuestion(original, {}), original);
  });

  test("a dismissed finding stays dismissed", () => {
    const withFinding = {
      ...multipleChoice(),
      findings: [finding("quality.all-or-none-of-the-above", "warn", "uses none of the above")],
    };
    const dismissed = dismissFinding(withFinding, "quality.all-or-none-of-the-above", "jason");
    assert.equal(dismissed.findings[0]?.dismissed, true);
    assert.equal(verdictFrom(dismissed.findings), "parsed");
  });
});

describe("verdicts", () => {
  test("an error means failed, a warning means needs review, nothing means parsed", () => {
    assert.equal(verdictFrom([]), "parsed");
    assert.equal(verdictFrom([finding("x", "info", "note")]), "parsed");
    assert.equal(verdictFrom([finding("x", "warn", "guessed")]), "needsReview");
    assert.equal(verdictFrom([finding("x", "warn", "a"), finding("y", "error", "b")]), "failed");
  });
});

describe("titles", () => {
  test("a long stem gives a title that stops on a word boundary", () => {
    const stem = "Which of the following best describes the relationship between ether wind and relativity";
    const title = titleFromStem(stem);
    assert.ok(title.length <= MAX_TITLE_LENGTH);
    assert.ok(!title.endsWith(" "));
    assert.ok(stem.startsWith(title));
  });

  test("a short stem is used whole", () => {
    assert.equal(titleFromStem("Speed of light"), "Speed of light");
  });
});

describe("the answer key check", () => {
  test("no correct option is an error finding, not a schema failure", () => {
    const question = multipleChoice();
    (question.body as { options: Array<{ correct: boolean }> }).options[1]!.correct = false;
    const found = checkAnswerKey(question);
    assert.equal(found.length, 1);
    assert.equal(found[0]?.severity, "error");
    assert.match(found[0]?.message ?? "", /cannot be scored/);
  });

  test("two correct options on a single-answer question is an error finding", () => {
    const question = multipleChoice();
    (question.body as { options: Array<{ correct: boolean }> }).options[0]!.correct = true;
    const found = checkAnswerKey(question);
    assert.equal(found[0]?.code, "import.multiple-keys-on-single-answer");
  });

  test("a sound question raises nothing", () => {
    assert.deepEqual(checkAnswerKey(multipleChoice()), []);
    assert.equal(hasUsableKey(multipleChoice()), true);
  });

  test("every option correct on a multiple response is a warning, not a refusal", () => {
    const question = createQuestion({
      type: "multipleResponse",
      stem: "Which of these are prime?",
      body: {
        shuffle: true,
        partialCredit: true,
        options: [
          { id: "o1", content: plainToRich("2"), correct: true },
          { id: "o2", content: plainToRich("3"), correct: true },
        ],
      },
    });
    const found = checkAnswerKey(question);
    assert.equal(found[0]?.severity, "warn");
    assert.equal(hasUsableKey(question), true);
  });
});

describe("references", () => {
  test("a placeholder pointing at nothing is an error", () => {
    const question = multipleChoice();
    question.stem = { format: "rich", content: `<p>See ${mediaPlaceholder("m_missing")}</p>` };
    const found = checkReferences(question);
    assert.equal(found.length, 1);
    assert.equal(found[0]?.severity, "error");
  });

  test("a placeholder with its sidecar present is fine", () => {
    const question = multipleChoice();
    question.stem = { format: "rich", content: `<p>See ${mediaPlaceholder("m_1")}</p>` };
    question.media = [{ id: "m_1", file: "media/m_1.png", mime: "image/png", alt: "An interferometer" }];
    assert.deepEqual(checkReferences(question), []);
  });
});
