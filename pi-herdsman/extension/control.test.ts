import assert from "node:assert/strict";
import test from "node:test";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  CONTROL_DIRECTORY_MODE,
  CONTROL_FILE_MODE,
  CONTROL_REQUEST_LIMIT_BYTES,
  controlClaimPath,
  controlDirectory,
  controlInbox,
  controlRequestPath,
  controlResultPath,
  controlStateOf,
  deriveControlState,
  parseControlRequest,
  readControlResult,
  startControlOwner,
  trustControlDirectory,
  writeControlRequest,
  type ControlOperation,
  type ControlOperationOutcome,
  type ControlOwner,
  type ControlRequest,
} from "./control.ts";

const AGENT = "implementer-1";

const temporary = (): { root: string; cleanup: () => void } => {
  const root = mkdtempSync(join(tmpdir(), "herdsman-control-"));
  return {
    root,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
};

const request = (
  overrides: Partial<ControlRequest> = {},
  operation: ControlOperation = "close",
): ControlRequest => {
  const runId = overrides.runId ?? randomUUID();
  return {
    version: 1,
    requestId: randomUUID(),
    operation,
    agent: AGENT,
    runId,
    confirmation: { operation, label: AGENT, runId },
    requestedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 30_000).toISOString(),
    requester: "agent-radar",
    ...overrides,
  };
};

const closed: ControlOperationOutcome = {
  outcome: "closed",
  effects: ["process_ended", "pane_closed"],
  message: "Closed implementer-1.",
};

/** The written file name is the request id the owner answers. */
const writtenId = (
  written: { ok: true; path: string } | { ok: false; reason: string },
): string => {
  assert.equal(written.ok, true, written.ok ? "" : written.reason);
  if (!written.ok) throw new Error(written.reason);
  return written.path.split("/").at(-1)!.replace(/\.json$/u, "");
};

const executor = (): {
  outcome: ControlOperationOutcome;
  calls: ControlRequest[];
  execute: (request: ControlRequest) => Promise<ControlOperationOutcome>;
} => {
  const calls: ControlRequest[] = [];
  return {
    outcome: closed,
    calls,
    execute: async (received) => {
      calls.push(received);
      return closed;
    },
  };
};

/** The watcher is real, so a result appears asynchronously after the event. */
const waitForResult = async (
  directory: string,
  requestId: string,
  timeoutMs = 5_000,
) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = readControlResult(directory, requestId);
    if (result) return result;
    if (Date.now() > deadline) return undefined;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

const start = (
  root: string,
  ownerSessionId: string,
  execute: (request: ControlRequest) => Promise<ControlOperationOutcome>,
  extra: {
    onResult?: (request: ControlRequest, result: never) => void;
  } = {},
): { owner: ControlOwner; directory: string } => {
  const started = startControlOwner({
    root,
    ownerSessionId,
    execute,
    ...(extra.onResult
      ? { onResult: extra.onResult as never }
      : {}),
  });
  assert.equal(started.ok, true, !started.ok ? started.reason : "");
  if (!started.ok) throw new Error(started.reason);
  return { owner: started.owner, directory: started.owner.directory };
};

test("an untrusted control directory refuses the write", () => {
  const { root, cleanup } = temporary();
  const owner = randomUUID();
  const directory = controlDirectory(owner, root);
  try {
    // A symlinked session directory is refused even when it points at a
    // directory that would pass on its own.
    const real = join(root, "elsewhere");
    mkdirSync(join(real, "inbox"), { recursive: true, mode: 0o700 });
    mkdirSync(join(real, "results"), { recursive: true, mode: 0o700 });
    mkdirSync(join(root, "control"), { recursive: true, mode: 0o700 });
    symlinkSync(real, directory);
    assert.equal(trustControlDirectory(directory).trusted, false);
    const refused = writeControlRequest(request(), owner, root);
    assert.equal(refused.ok, false);
    assert.match(
      refused.ok ? "" : refused.reason,
      /is a symlink/,
      "the requester reports the untrusted directory",
    );
    assert.deepEqual(
      readdirSync(join(real, "inbox")),
      [],
      "the requester wrote nothing",
    );

    // A directory readable by the group is not private enough to attribute.
    rmSync(directory, { force: true });
    mkdirSync(join(directory, "inbox"), { recursive: true, mode: 0o700 });
    mkdirSync(join(directory, "results"), { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o770);
    assert.equal(trustControlDirectory(directory).trusted, false);
    assert.equal(writeControlRequest(request(), owner, root).ok, false);

    // The owner creates its own directory, mode 0700, when one is absent.
    rmSync(directory, { recursive: true, force: true });
    const ownerCreated = start(root, owner, executor().execute);
    ownerCreated.owner.stop();
    assert.equal(
      lstatSync(directory).mode & 0o777,
      CONTROL_DIRECTORY_MODE,
      "the owner-created directory is 0700",
    );
    assert.equal(trustControlDirectory(directory).trusted, true);
  } finally {
    cleanup();
  }
});

test("a request is read tolerantly and only an unspoken version is refused", () => {
  const requestId = randomUUID();
  const valid = request({ requestId });
  assert.deepEqual(parseControlRequest(JSON.parse(JSON.stringify(valid)), requestId), {
    ok: true,
    request: valid,
  });

  // Version 1 never gains a required field and unknown fields are ignored.
  const tolerant = { ...valid, briefProfile: "execution" };
  const parsedTolerant = parseControlRequest(tolerant, requestId);
  assert.equal(parsedTolerant.ok, true);
  const { paneId: _pane, piSessionId: _session, ...withoutChecks } = valid;
  assert.equal(
    parseControlRequest(withoutChecks, requestId).ok,
    true,
    "every cross-check is optional",
  );

  const version = parseControlRequest({ ...valid, version: 2 }, requestId);
  assert.equal(version.ok, false);
  assert.equal(version.ok ? undefined : version.operation, "close");
  assert.match(
    version.ok ? "" : version.message,
    /version 2 is not supported/,
  );

  const confirmation = parseControlRequest(
    { ...valid, confirmation: undefined },
    requestId,
  );
  assert.equal(confirmation.ok, false);

  const mismatchedFile = parseControlRequest(valid, randomUUID());
  assert.equal(mismatchedFile.ok, false);
  assert.match(
    mismatchedFile.ok ? "" : mismatchedFile.message,
    /does not match its file name/,
  );

  const malformed = parseControlRequest({ hello: "world" }, requestId);
  assert.equal(malformed.ok, false);
  assert.equal(
    malformed.ok ? undefined : malformed.operation,
    undefined,
    "a request with no readable operation writes no result",
  );
});

test("a live owner executes a request written into its inbox", async () => {
  const { root, cleanup } = temporary();
  const ownerSessionId = randomUUID();
  const executorPort = executor();
  const results: unknown[] = [];
  try {
    const { owner, directory } = start(root, ownerSessionId, executorPort.execute, {
      onResult: (_request, result) => results.push(result),
    });
    try {
      const written = writeControlRequest(
        request({ paneId: "w1:p3", piSessionId: randomUUID() }),
        ownerSessionId,
        root,
      );
      const requestId = writtenId(written);
      const result = await waitForResult(directory, requestId);
      assert.ok(result, "the watcher produced a result");
      assert.equal(result.outcome, "closed");
      assert.deepEqual(result.effects, ["process_ended", "pane_closed"]);
      assert.equal(executorPort.calls.length, 1);
      assert.equal(
        executorPort.calls[0]!.paneId,
        "w1:p3",
        "the request reaches the executor with its cross-checks",
      );
      assert.equal(executorPort.calls[0]!.requestId, requestId);
      assert.ok(
        statSync(controlClaimPath(directory, requestId)).isFile(),
        "execution created its claim",
      );
      assert.equal(
        statSync(controlResultPath(directory, requestId)).mode & 0o777,
        CONTROL_FILE_MODE,
        "the result file is 0600",
      );
      assert.equal(results.length, 1);
    } finally {
      owner.stop();
    }
  } finally {
    cleanup();
  }
});

test("two owners race one request and exactly one executes it", async () => {
  const { root, cleanup } = temporary();
  const ownerSessionId = randomUUID();
  const first = executor();
  const second = executor();
  try {
    const one = start(root, ownerSessionId, first.execute);
    const two = start(root, ownerSessionId, second.execute);
    try {
      const written = writeControlRequest(request(), ownerSessionId, root);
      const requestId = writtenId(written);
      // Both owners handle the same file, as two live watchers would.
      await Promise.all([
        one.owner.handle(requestId),
        two.owner.handle(requestId),
      ]);
      assert.equal(first.calls.length + second.calls.length, 1);
      const result = readControlResult(one.directory, requestId);
      assert.equal(result?.outcome, "closed");
    } finally {
      one.owner.stop();
      two.owner.stop();
    }
  } finally {
    cleanup();
  }
});

test("a claim without a result becomes unknown at the next start and is never repeated", async () => {
  const { root, cleanup } = temporary();
  const ownerSessionId = randomUUID();
  try {
    const first = start(root, ownerSessionId, executor().execute);
    first.owner.stop();
    const value = request();
    writeControlRequest(value, ownerSessionId, root);
    // The owner died after claiming: the claim survives with no result.
    writeFileSync(
      controlClaimPath(first.directory, value.requestId),
      JSON.stringify({
        operation: "close",
        requestedAt: value.requestedAt,
        claimedAt: new Date().toISOString(),
      }),
      { mode: CONTROL_FILE_MODE },
    );
    const second = executor();
    const restarted = start(root, ownerSessionId, second.execute);
    try {
      const result = readControlResult(restarted.directory, value.requestId);
      assert.equal(result?.outcome, "unknown");
      assert.deepEqual(result?.effects, []);
      assert.equal(
        second.calls.length,
        0,
        "a claimed request is never executed again",
      );
      // The late scan must not repeat it either.
      await restarted.owner.handle(value.requestId);
      assert.equal(second.calls.length, 0);
    } finally {
      restarted.owner.stop();
    }
  } finally {
    cleanup();
  }
});

test("an expired request is refused without a claim", async () => {
  const { root, cleanup } = temporary();
  const ownerSessionId = randomUUID();
  const executorPort = executor();
  try {
    const { owner, directory } = start(root, ownerSessionId, executorPort.execute);
    try {
      const value = request({
        expiresAt: new Date(Date.now() - 1_000).toISOString(),
      });
      assert.equal(writeControlRequest(value, ownerSessionId, root).ok, true);
      const result = await owner.handle(value.requestId);
      assert.equal(result?.outcome, "refused");
      assert.equal(result?.category, "invalid_request");
      assert.equal(executorPort.calls.length, 0);
      assert.equal(
        statSync(controlClaimPath(directory, value.requestId), {
          throwIfNoEntry: false,
        }),
        undefined,
        "an expired request leaves no claim",
      );
      assert.equal(
        controlStateOf(directory, value.requestId, value.expiresAt),
        "result",
      );
    } finally {
      owner.stop();
    }
  } finally {
    cleanup();
  }
});

test("a request that outlives its owner derives not_executed", () => {
  const { root, cleanup } = temporary();
  try {
    const expiresAt = new Date(Date.now() - 1_000).toISOString();
    assert.equal(
      deriveControlState({ result: false, claim: false, expiresAt }),
      "not_executed",
    );
    assert.equal(
      deriveControlState({
        result: false,
        claim: false,
        expiresAt: new Date(Date.now() + 10_000).toISOString(),
      }),
      "pending",
    );
    // A claim outranks expiry, and a result outranks a claim.
    assert.equal(
      deriveControlState({ result: false, claim: true, expiresAt }),
      "started",
    );
    assert.equal(
      deriveControlState({ result: true, claim: true, expiresAt }),
      "result",
    );
    const directory = controlDirectory(randomUUID(), root);
    assert.equal(
      controlStateOf(directory, randomUUID(), expiresAt),
      "not_executed",
    );
  } finally {
    cleanup();
  }
});

test("the owner prunes old results and never a claim without one", async () => {
  const { root, cleanup } = temporary();
  const ownerSessionId = randomUUID();
  try {
    const first = start(root, ownerSessionId, executor().execute);
    const directory = first.directory;
    first.owner.stop();
    const old = randomUUID();
    const recent = randomUUID();
    const claimed = randomUUID();
    for (const id of [old, recent])
      writeFileSync(
        controlResultPath(directory, id),
        JSON.stringify({
          version: 1,
          requestId: id,
          operation: "close",
          outcome: "closed",
          message: "closed",
          effects: [],
          completedAt: new Date().toISOString(),
        }),
        { mode: CONTROL_FILE_MODE },
      );
    const yesterday = new Date(Date.now() - 25 * 60 * 60 * 1_000);
    utimesSync(controlResultPath(directory, old), yesterday, yesterday);
    writeFileSync(
      controlClaimPath(directory, claimed),
      JSON.stringify({
        operation: "close",
        requestedAt: new Date().toISOString(),
        claimedAt: new Date().toISOString(),
      }),
      { mode: CONTROL_FILE_MODE },
    );
    const second = executor();
    const restarted = start(root, ownerSessionId, second.execute);
    try {
      assert.equal(
        statSync(controlResultPath(directory, old), { throwIfNoEntry: false }),
        undefined,
        "a result older than 24 hours is pruned",
      );
      assert.ok(
        statSync(controlResultPath(directory, recent), { throwIfNoEntry: false }),
        "a recent result is retained",
      );
      // The orphaned claim is finalized, never pruned back to no answer.
      assert.equal(
        readControlResult(directory, claimed)?.outcome,
        "unknown",
      );
      assert.ok(
        statSync(controlClaimPath(directory, claimed), { throwIfNoEntry: false }),
        "the claim that had no result is still there",
      );
    } finally {
      restarted.owner.stop();
    }
  } finally {
    cleanup();
  }
});

test("a request over the size limit is refused before it is written", () => {
  const { root, cleanup } = temporary();
  const ownerSessionId = randomUUID();
  try {
    const started = start(root, ownerSessionId, executor().execute);
    started.owner.stop();
    const oversized = request({
      requester: "x".repeat(CONTROL_REQUEST_LIMIT_BYTES),
    });
    const refused = writeControlRequest(oversized, ownerSessionId, root);
    assert.equal(refused.ok, false);
    assert.match(refused.ok ? "" : refused.reason, /exceeds/);
  } finally {
    cleanup();
  }
});

test("a confirmation that names another target is refused before the claim", async () => {
  const { root, cleanup } = temporary();
  const ownerSessionId = randomUUID();
  const executorPort = executor();
  try {
    const { owner, directory } = start(root, ownerSessionId, executorPort.execute);
    try {
      const value = request();
      value.confirmation = {
        operation: "close",
        label: "implementer-2",
        runId: value.runId,
      };
      assert.equal(writeControlRequest(value, ownerSessionId, root).ok, true);
      const result = await owner.handle(value.requestId);
      assert.equal(result?.outcome, "refused");
      assert.equal(result?.category, "invalid_request");
      assert.equal(executorPort.calls.length, 0);
      assert.equal(
        statSync(controlClaimPath(directory, value.requestId), {
          throwIfNoEntry: false,
        }),
        undefined,
      );
    } finally {
      owner.stop();
    }
  } finally {
    cleanup();
  }
});

test("an owner reports an unavailable directory instead of watching it", () => {
  const { root, cleanup } = temporary();
  try {
    const ownerSessionId = randomUUID();
    const directory = controlDirectory(ownerSessionId, root);
    mkdirSync(join(root, "control"), { recursive: true, mode: 0o700 });
    mkdirSync(join(directory, "inbox"), { recursive: true, mode: 0o700 });
    mkdirSync(join(directory, "results"), { recursive: true, mode: 0o700 });
    chmodSync(join(directory, "inbox"), 0o755);
    const started = startControlOwner({
      root,
      ownerSessionId,
      execute: async () => closed,
    });
    assert.equal(started.ok, false);
    assert.match(started.ok ? "" : started.reason, /mode 755/);
  } finally {
    cleanup();
  }
});

test("the inbox path is the one a requester writes", () => {
  const { root, cleanup } = temporary();
  const ownerSessionId = randomUUID();
  try {
    const started = start(root, ownerSessionId, executor().execute);
    started.owner.stop();
    const value = request();
    const written = writeControlRequest(value, ownerSessionId, root);
    assert.equal(
      written.ok ? written.path : "",
      controlRequestPath(started.directory, value.requestId),
    );
    assert.equal(writtenId(written), value.requestId);
    assert.equal(
      written.ok ? written.path : "",
      join(controlInbox(started.directory), `${value.requestId}.json`),
    );
  } finally {
    cleanup();
  }
});
