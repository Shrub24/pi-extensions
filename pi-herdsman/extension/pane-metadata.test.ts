import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  createMetadataPublisher,
  metadataArgs,
  metadataValue,
  sessionMetadata,
} from "./pane-metadata.ts";

const snapshot = (task: string) => ({
  paneId: "w:p2",
  source: "pi-herdsman:worker",
  tokens: { pi_herdsman_task: task, pi_herdsman_parent_session: "owner" },
});
const drain = () => new Promise<void>((resolve) => setImmediate(resolve));

test("session tokens sanitize and bound Unicode while clearing unavailable facts", () => {
  assert.equal(metadataValue("\x1b[31m red\x1b[0m\n"), "red");
  assert.equal([...metadataValue("🙂".repeat(81))!].length, 80);
  const tokens = sessionMetadata({ sessionId: "owner", contextPercent: 42.6 });
  assert.deepEqual(tokens, {
    model: null,
    provider: null,
    thinking: null,
    session: null,
    context_usage: "43%",
    pi_herdsman_session: "owner",
  });
  assert.equal(
    sessionMetadata({ sessionId: "owner", contextPercent: NaN }).context_usage,
    null,
  );
});

test("wire requests are display-only and clear only their own named tokens", () => {
  const args = metadataArgs(snapshot("task"), 1000);
  assert.deepEqual(args.slice(0, 7), [
    "pane",
    "report-metadata",
    "w:p2",
    "--source",
    "pi-herdsman:worker",
    "--ttl-ms",
    "1000",
  ]);
  assert.ok(args.includes("pi_herdsman_parent_session=owner"));
  assert.ok(
    !args.some((arg) => /^(sort_key|anchor|state_|title_|subagent_)/.test(arg)),
  );
});

test("a slow report coalesces newer snapshots and an outage retries the latest", async () => {
  const calls: string[][] = [];
  let release!: () => void;
  const publisher = createMetadataPublisher(async (args) => {
    calls.push(args);
    if (calls.length === 1)
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    if (calls.length === 2) throw new Error("offline");
  });
  const first = publisher.update(snapshot("first"));
  void publisher.update(snapshot("obsolete"));
  void publisher.update(snapshot("latest"));
  release();
  await first;
  assert.equal(calls.length, 2);
  assert.ok(calls[1].includes("pi_herdsman_task=latest"));
  await publisher.update(snapshot("latest"));
  assert.equal(calls.length, 3);
  await publisher.clear();
});

test("unchanged metadata refreshes before expiry; shutdown clears and stops refresh", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const calls: string[][] = [];
  const publisher = createMetadataPublisher(async (args) => {
    calls.push(args);
  }, 1000);
  await publisher.update(snapshot("task"));
  await publisher.update(snapshot("task"));
  assert.equal(calls.length, 1);
  t.mock.timers.tick(500);
  await drain();
  assert.equal(calls.length, 2);
  await publisher.clear();
  assert.ok(calls[2].includes("--clear-token"));
  assert.ok(calls[2].includes("pi_herdsman_task"));
  assert.ok(!calls[2].includes("anchor"));
  t.mock.timers.tick(2000);
  await publisher.update(snapshot("late"));
  assert.equal(calls.length, 3);
});

test("shutdown cancels a report before issuing the source-local clear", async () => {
  const calls: string[][] = [];
  const publisher = createMetadataPublisher(async (args, signal) => {
    calls.push(args);
    if (calls.length === 1)
      await new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
      );
  });
  void publisher.update(snapshot("task"));
  await publisher.clear();
  assert.equal(calls.length, 2);
  assert.ok(calls[1].includes("--clear-token"));
});

test("an update during promise cleanup is drained before callers resume", async () => {
  const calls: string[][] = [];
  const publisher = createMetadataPublisher(async (args) => {
    calls.push(args);
  });
  const first = publisher.update(snapshot("first"));
  await Promise.resolve();
  const last = publisher.update(snapshot("last"));
  await Promise.all([first, last]);
  assert.equal(calls.length, 2);
  assert.ok(calls[1].includes("pi_herdsman_task=last"));
  await publisher.clear();
});

test("Radar fixture preserves exact lineage and flattens only live source fields", () => {
  const fixture = JSON.parse(
    readFileSync(
      new URL("../docs/reference/pane-metadata.fixture.json", import.meta.url),
      "utf8",
    ),
  );
  const sessions = new Map(
    fixture.panes.map((pane) => {
      const self = pane.metadata.find(
        (slot) => !slot.source.startsWith("pi-herdsman:owner:"),
      );
      // The official reporter prefers the session file path, so identity joins on Herdsman's tokens only.
      assert.equal(pane.agent_session.kind, "path");
      assert.ok(
        pane.agent_session.value.endsWith(
          `${self.tokens.pi_herdsman_session}.jsonl`,
        ),
      );
      return [self.tokens.pi_herdsman_session, pane.pane_id];
    }),
  );
  for (const pane of fixture.panes) {
    const tokens = Object.assign(
      {},
      ...pane.metadata.map((slot) =>
        Object.fromEntries(
          Object.entries(slot.tokens).filter(([, value]) => value !== null),
        ),
      ),
    );
    assert.deepEqual(
      fixture.expected.agent_list.agents.find(
        (agent) => agent.pane_id === pane.pane_id,
      ).tokens,
      tokens,
    );
    if (tokens.pi_herdsman_parent_session)
      assert.equal(
        fixture.expected.parents[pane.pane_id],
        sessions.get(tokens.pi_herdsman_parent_session),
      );
    const expired = fixture.expected.owner_source_expired.agents.find(
      (agent) => agent.pane_id === pane.pane_id,
    );
    const { pi_herdsman_state: _state, ...selfTokens } = tokens;
    assert.deepEqual(expired.tokens, selfTokens);
  }
  assert.ok(
    metadataArgs(
      {
        paneId: "pane",
        source: "pi-herdsman:owner:run",
        tokens: { pi_herdsman_state: "waiting" },
      },
      30000,
    ).includes("pi_herdsman_state=waiting"),
  );
});
