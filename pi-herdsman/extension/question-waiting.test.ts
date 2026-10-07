import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  clearQuestionWaitEvidence,
  readQuestionWaitEvidence,
  registerQuestionWaitReporter,
  RPIV_ASK_USER_BLOCKED_EVENT,
  writeQuestionWaitEvidence,
  type QuestionWaitScope,
} from "./question-waiting.ts";

function scope(): QuestionWaitScope {
  return {
    runId: randomUUID(),
    requestId: randomUUID(),
    piSessionId: randomUUID(),
  };
}

test("the rpiv blocked event writes and clears an assignment-scoped wait marker", () => {
  const mailbox = mkdtempSync(join(tmpdir(), "pi-herdsman-question-wait-"));
  let handler: ((payload: unknown) => void) | undefined;
  let current: QuestionWaitScope | undefined = scope();
  const errors: unknown[] = [];
  const unsubscribe = registerQuestionWaitReporter(
    {
      on(channel, listener) {
        assert.equal(channel, RPIV_ASK_USER_BLOCKED_EVENT);
        handler = listener;
        return () => undefined;
      },
    },
    mailbox,
    () => current,
    (error) => errors.push(error),
  );

  try {
    assert.ok(handler);
    handler({ active: true, futureField: "ignored" });
    assert.equal(readQuestionWaitEvidence(mailbox, current), "waiting");
    assert.equal(
      readQuestionWaitEvidence(mailbox, {
        ...current,
        requestId: randomUUID(),
      }),
      "clear",
      "a marker from another assignment is ignored",
    );

    current = undefined;
    handler({ active: true });
    assert.equal(
      readQuestionWaitEvidence(mailbox, undefined),
      "clear",
      "a wait without an active assignment clears stale evidence",
    );

    current = scope();
    handler({ active: true });
    assert.equal(readQuestionWaitEvidence(mailbox, current), "waiting");
    handler({ active: false });
    assert.equal(readQuestionWaitEvidence(mailbox, current), "clear");
    assert.deepEqual(errors, []);
    unsubscribe();
  } finally {
    clearQuestionWaitEvidence(mailbox);
    rmSync(mailbox, { recursive: true, force: true });
  }
});

test("question-wait evidence fails closed when malformed or for another run", () => {
  const mailbox = mkdtempSync(join(tmpdir(), "pi-herdsman-question-wait-"));
  const current = scope();
  try {
    writeQuestionWaitEvidence(mailbox, current);
    assert.equal(
      readQuestionWaitEvidence(mailbox, {
        ...current,
        runId: randomUUID(),
      }),
      "clear",
      "a stale generation cannot block a later run",
    );
    assert.equal(
      readQuestionWaitEvidence(mailbox, {
        ...current,
        piSessionId: randomUUID(),
      }),
      "clear",
      "a different Pi session cannot inherit the wait",
    );
    assert.equal(
      readQuestionWaitEvidence(mailbox, {
        ...current,
        requestId: randomUUID(),
      }),
      "clear",
      "a different assignment cannot inherit the wait",
    );

    writeFileSync(
      join(mailbox, "question-waiting.json"),
      JSON.stringify({ version: 1, ...current, extra: true }),
    );
    assert.equal(readQuestionWaitEvidence(mailbox, current), "invalid");

    writeFileSync(join(mailbox, "question-waiting.json"), "x".repeat(2049));
    assert.equal(readQuestionWaitEvidence(mailbox, current), "invalid");

    assert.throws(
      () =>
        writeQuestionWaitEvidence(mailbox, { ...current, requestId: "bad" }),
      /Invalid question-wait scope/u,
    );
  } finally {
    rmSync(mailbox, { recursive: true, force: true });
  }
});

test("clearing an absent question-wait marker is idempotent", () => {
  const mailbox = mkdtempSync(join(tmpdir(), "pi-herdsman-question-wait-"));
  try {
    clearQuestionWaitEvidence(mailbox);
    assert.equal(readQuestionWaitEvidence(mailbox, scope()), "clear");
  } finally {
    rmSync(mailbox, { recursive: true, force: true });
  }
});
