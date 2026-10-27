/**
 * Tests for the contract OpenStage Author and OpenStage Scroll depend on.
 *
 * These are the tests that stop a change to the engine quietly breaking the
 * other two tools. If one of these has to change, both consumers need telling
 * first and the contract version moves.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { Bank } from "../src/bank/store.ts";
import { createQuestion, editQuestion } from "../src/model/create.ts";
import { plainToRich } from "../src/model/richtext.ts";
import { localId } from "../src/model/ids.ts";
import {
  READ_CONTRACT_VERSION,
  assertContract,
  getQuestion,
  linkTo,
  listQuestions,
  openBankFromBytes,
  resolveLink,
  supportedTypes,
  toDeliveryPayload,
  type BankHandle,
} from "../src/read/index.ts";
import type { Question } from "../src/model/question.ts";

function choice(stem: string): Question {
  return createQuestion({
    type: "multipleChoice",
    stem,
    points: 2,
    metadata: { objective: "LO 3.2", chapter: "3", bloom: "understand", tags: ["optics"], status: "reviewed" },
    body: {
      shuffle: true,
      options: [0, 1, 2].map((j) => ({
        id: localId("o", j),
        content: plainToRich(`Option ${j + 1}`),
        correct: j === 1,
      })),
    },
    at: "2026-01-01T00:00:00.000Z",
    by: "test",
  });
}

function matching(): Question {
  return createQuestion({
    type: "matching",
    stem: "Match the name to the discovery.",
    body: {
      pairs: [
        { id: "p1", left: plainToRich("Michelson"), right: "Speed of light" },
        { id: "p2", left: plainToRich("Einstein"), right: "Relativity" },
      ],
      distractors: ["Radio waves"],
      shuffle: true,
    },
    at: "2026-01-01T00:00:00.000Z",
    by: "test",
  });
}

function bankWith(questions: Question[]): { handle: BankHandle; bank: Bank } {
  const bank = Bank.createEmpty("Optics bank", { at: "2026-01-01T00:00:00.000Z" });
  const folder = bank.addFolder("Chapter 3");
  for (const q of questions) bank.add(q, { folderId: folder.id });
  return { handle: openBankFromBytes(bank.toBytes()), bank };
}

describe("the six operations", () => {
  test("openBank reports metadata, folders and tags without exposing the file", () => {
    const { handle } = bankWith([choice("Who measured the speed of light?")]);
    assert.equal(handle.title, "Optics bank");
    assert.equal(handle.questionCount, 1);
    assert.deepEqual(handle.tags, ["optics"]);
    assert.equal(handle.folders[0]?.name, "Chapter 3");
    assert.equal(handle.folders[0]?.questionCount, 1);
  });

  test("listQuestions returns pickable summaries, not whole questions", () => {
    const { handle } = bankWith([choice("Who measured the speed of light?")]);
    const [summary] = listQuestions(handle);
    assert.ok(summary);
    assert.equal(summary.type, "multipleChoice");
    assert.equal(summary.stemPreview, "Who measured the speed of light?");
    assert.equal(summary.objective, "LO 3.2");
    assert.equal(summary.findingCount, 0);
    assert.equal("body" in summary, false, "a summary must not carry the body");
  });

  test("listQuestions takes the same query shape the rest of the engine uses", () => {
    const { handle } = bankWith([choice("First question"), choice("Second question")]);
    assert.equal(listQuestions(handle, { chapter: ["3"] }).length, 2);
    assert.equal(listQuestions(handle, { chapter: ["9"] }).length, 0);
    assert.equal(listQuestions(handle, { text: "second" }).length, 1);
  });

  test("getQuestion returns the whole question or nothing", () => {
    const q = choice("Who measured the speed of light?");
    const { handle } = bankWith([q]);
    assert.equal(getQuestion(handle, q.id)?.id, q.id);
    assert.equal(getQuestion(handle, "q_NOTHERE"), undefined);
  });
});

describe("links and embeds", () => {
  test("a link that matches the bank is current", () => {
    const q = choice("Who measured the speed of light?");
    const { handle } = bankWith([q]);
    const result = resolveLink(linkTo(handle, q), handle);
    assert.equal(result.status, "current");
    assert.equal(result.usingSnapshot, false);
  });

  test("a link behind the bank is stale and says which version", () => {
    const q = choice("Who measured the speed of light?");
    const { handle, bank } = bankWith([q]);
    const link = linkTo(handle, q);

    bank.update(q.id, { points: 5 }, { by: "jason" });
    const fresh = openBankFromBytes(bank.toBytes());

    const result = resolveLink(link, fresh);
    assert.equal(result.status, "stale");
    assert.equal(result.storedVersion, 1);
    assert.equal(result.currentVersion, 2);
    assert.match(result.message, /newer version/);
  });

  test("a missing bank falls back to the snapshot and says so", () => {
    const q = choice("Who measured the speed of light?");
    const { handle } = bankWith([q]);
    const link = linkTo(handle, q);

    const result = resolveLink(link, undefined);
    assert.equal(result.status, "bank-missing");
    assert.equal(result.usingSnapshot, true);
    assert.equal(result.question?.id, q.id);
  });

  test("a missing bank with no snapshot renders nothing, and never silently", () => {
    const q = choice("Who measured the speed of light?");
    const { handle } = bankWith([q]);
    const result = resolveLink(linkTo(handle, q, { embed: false }), undefined);
    assert.equal(result.status, "bank-missing");
    assert.equal(result.question, undefined);
    assert.match(result.message, /cannot be shown/);
  });

  test("a question removed from the bank is reported, not silently dropped", () => {
    const q = choice("Who measured the speed of light?");
    const { handle, bank } = bankWith([q]);
    const link = linkTo(handle, q);
    bank.remove(q.id);

    const result = resolveLink(link, openBankFromBytes(bank.toBytes()));
    assert.equal(result.status, "question-missing");
    assert.equal(result.usingSnapshot, true);
  });

  test("a link from a different bank is not matched against this one", () => {
    const q = choice("Who measured the speed of light?");
    const { handle } = bankWith([q]);
    const other = bankWith([choice("Another question")]);
    const result = resolveLink(linkTo(handle, q), other.handle);
    assert.equal(result.status, "bank-mismatch");
  });

  test("an edit in the bank is what makes a link stale, including a type change", () => {
    const q = choice("Who measured the speed of light?");
    const edited = editQuestion(q, { points: 9 }, { by: "jason" });
    assert.equal(edited.version, 2);
    assert.equal(edited.metadata.status, "draft", "editing a reviewed question returns it to draft");
  });
});

describe("what each consumer can deliver", () => {
  test("Author takes every release 1 type", () => {
    const capability = supportedTypes("openstage-author");
    for (const type of ["multipleChoice", "matching", "ordering", "essay", "numeric"]) {
      assert.ok(capability.supports.includes(type as never), `Author should deliver ${type}`);
    }
  });

  test("Scroll declines matching and ordering, with a reason", () => {
    const capability = supportedTypes("openstage-scroll");
    assert.equal(capability.supports.includes("matching"), false);
    assert.match(capability.fallbacks.matching?.note ?? "", /design decision/);
  });

  test("an unknown consumer is a loud error, not a silent default", () => {
    assert.throws(() => supportedTypes("openstage-nothing" as never), /Unknown consumer/);
  });
});

describe("the delivery payload", () => {
  test("carries what a player renders and nothing a player should not see", () => {
    const q = choice("Who measured the speed of light?");
    const result = toDeliveryPayload(q, "openstage-author");
    assert.equal(result.delivered, true);

    const payload = result.payload!;
    assert.equal(payload.id, q.id);
    assert.equal(payload.version, q.version);
    assert.equal(payload.points, 2);
    assert.equal(payload.interaction.kind, "choice");

    // No instructor-facing data reaches a published course.
    const keys = Object.keys(payload);
    for (const forbidden of ["metadata", "history", "findings", "origin", "status"]) {
      assert.equal(keys.includes(forbidden), false, `${forbidden} must not be in a delivery payload`);
    }
    assert.equal(JSON.stringify(payload).includes("LO 3.2"), false, "the objective must not leak into delivery");
  });

  test("a matching question delivers to Author and is refused by Scroll with its reason", () => {
    const q = matching();
    const author = toDeliveryPayload(q, "openstage-author");
    assert.equal(author.delivered, true);
    assert.equal(author.payload?.interaction.kind, "matching");

    const scroll = toDeliveryPayload(q, "openstage-scroll");
    assert.equal(scroll.delivered, false);
    assert.match(scroll.reason ?? "", /design decision/);
  });

  test("a short answer delivers as a text interaction with its accepted answers", () => {
    const q = createQuestion({
      type: "shortAnswer",
      stem: "Who is known as the father of television?",
      body: { caseSensitive: false, accepted: ["Zworykin", "Vladimir Zworykin"] },
    });
    const result = toDeliveryPayload(q, "openstage-scroll");
    assert.equal(result.delivered, true);
    const interaction = result.payload!.interaction;
    assert.equal(interaction.kind, "text");
    if (interaction.kind === "text") {
      assert.deepEqual(interaction.blanks[0]?.accepted, ["Zworykin", "Vladimir Zworykin"]);
    }
  });

  test("a type with no honest conversion is withheld with a reason, never delivered hollow", () => {
    // This used to deliver as multiple choice with options reading "Region 1"
    // and "Region 2", which ask nothing once the image is gone. Refusing and
    // saying why is the behaviour the destination check is built on.
    const q = createQuestion({
      type: "hotspot",
      stem: "Click the interferometer.",
      body: {
        mediaRef: "m_1",
        regions: [
          { id: "r1", shape: "rect", coords: [0, 0, 10, 10], correct: true },
          { id: "r2", shape: "rect", coords: [20, 0, 30, 10], correct: false },
        ],
        alternative: plainToRich("Which instrument split the beam?"),
      },
    });
    const result = toDeliveryPayload(q, "openstage-author");
    assert.equal(result.delivered, false);
    assert.equal(result.payload, undefined);
    assert.ok((result.reason ?? "").length > 0, "a refusal has to say why");
  });

  test("a calculated question is withheld rather than scored against a made-up answer", () => {
    const q = createQuestion({
      type: "calculated",
      stem: "A car travels {d} km in {t} hours. What is its average speed?",
      body: {
        formula: "d / t",
        variables: [
          { name: "d", min: 100, max: 200, decimals: 0 },
          { name: "t", min: 2, max: 4, decimals: 0 },
        ],
        tolerance: 0.5,
        toleranceIsPercent: false,
      },
    });
    const result = toDeliveryPayload(q, "openstage-author");
    assert.equal(result.delivered, false, "delivering value 0 would mark a wrong answer correct");
    assert.ok((result.reason ?? "").length > 0);
  });

  test("a true or false question with no key is not delivered as False", () => {
    const q = createQuestion({
      type: "trueFalse",
      stem: "The speed of light is constant in a vacuum.",
      body: {},
    });
    const result = toDeliveryPayload(q, "openstage-author");
    assert.equal(result.delivered, false, "an absent key is not the answer False");
  });
});

describe("the contract version", () => {
  test("a consumer asking for this major version is accepted", () => {
    assert.doesNotThrow(() => assertContract(READ_CONTRACT_VERSION));
    assert.doesNotThrow(() => assertContract("1.4.2"));
  });

  test("a consumer asking for a different major version is told plainly", () => {
    assert.throws(() => assertContract("2.0.0"), /major version difference/);
  });
});
