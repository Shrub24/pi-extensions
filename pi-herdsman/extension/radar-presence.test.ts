import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createRadarClient, type RadarLocation } from "pi-radar/client";
import { createRadarPublication, type RadarPublication } from "pi-radar/publication";
import { RADAR_SUBJECT_SOURCE } from "pi-radar/execution";
import {
  FIXTURE_LEAD_PANE,
  FIXTURE_TMUX_SERVER,
  startFakeRadarDaemon,
  type FakeRadarDaemon,
} from "./support-radar.ts";

// Presence is the one path that grants every managed capability, so these two
// flows run on the fixture daemon's real presence contract: a managed session
// reports, publishes and releases, and a duplicate never gains a subject.

const HEARTBEAT_MS = 60_000;
const LOCATION: RadarLocation = {
  backend: "tmux",
  instance: FIXTURE_TMUX_SERVER,
  pane: FIXTURE_LEAD_PANE,
};

function publicationFor(
  daemon: FakeRadarDaemon,
  dataRoot: string,
  incarnation: string,
): RadarPublication {
  return createRadarPublication({
    dataRoot,
    client: createRadarClient({
      env: { ...process.env, RADAR_CONTROL_SOCKET: daemon.socketPath },
    }),
    registration: { source: RADAR_SUBJECT_SOURCE },
    incarnation,
    birth: { boot_id: randomUUID(), pid: process.pid, start_ticks: 1 },
    location: async () => ({
      state: "resolved",
      location: LOCATION,
    }),
    heartbeatMs: HEARTBEAT_MS,
  });
}

async function eventually(check: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!check()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function withPresenceDaemon(
  body: (daemon: FakeRadarDaemon, dataRoot: string) => Promise<void>,
): Promise<void> {
  const daemon = await startFakeRadarDaemon({});
  const dataRoot = mkdtempSync(join(tmpdir(), "radar-presence-"));
  try {
    await body(daemon, dataRoot);
  } finally {
    daemon.reset();
    await daemon.close();
    rmSync(dataRoot, { recursive: true, force: true });
  }
}

test("a managed session keeps its grant across replays, publishes facts, and reclaims the same subject after shutdown", async () => {
  await withPresenceDaemon(async (daemon, dataRoot) => {
    const session = publicationFor(daemon, dataRoot, "managed-incarnation");
    let subjectId: string | undefined;
    try {
      session.presence.report("session-managed");
      assert.notEqual(await session.presence.ensure(), undefined);

      const granted = session.presence.management();
      assert.equal(granted?.state, "managed");
      subjectId = granted?.state === "managed" ? granted.subject_id : undefined;
      assert.ok(subjectId, "a granted session carries its subject");

      // A repeat report with the same claim replays the same grant, not a second claim.
      assert.notEqual(await session.presence.ensure(), undefined);
      assert.deepEqual(session.presence.management(), { state: "managed", subject_id: subjectId });

      session.facts.update({ model: "model-a", provider: "provider-a", thinking: "off" });
      await eventually(
        () => daemon.published.some((entry) => entry.channel === "facts"),
        "the facts channel to publish",
      );

      await session.presence.release();
    } finally {
      session.stop();
    }

    // A fresh session load of the same session is granted again, with the same subject.
    const reloaded = publicationFor(daemon, dataRoot, "managed-incarnation-2");
    try {
      reloaded.presence.report("session-managed");
      await reloaded.presence.ensure();
      assert.deepEqual(reloaded.presence.management(), { state: "managed", subject_id: subjectId });
    } finally {
      reloaded.stop();
    }
  });
});

test("a duplicate session has no subject and stays duplicate after the incumbent releases", async () => {
  await withPresenceDaemon(async (daemon, dataRoot) => {
    const incumbent = publicationFor(daemon, dataRoot, "incumbent-incarnation");
    const duplicate = publicationFor(daemon, dataRoot, "duplicate-incarnation");
    try {
      incumbent.presence.report("session-contested");
      await incumbent.presence.ensure();
      assert.equal(incumbent.presence.management()?.state, "managed");

      duplicate.presence.report("session-contested");
      await duplicate.presence.ensure();
      assert.equal(duplicate.presence.management()?.state, "duplicate");

      // No subject means no parent for a launch or a handoff, so the duplicate's
      // subject carries no subject_id to launch or accept work under.
      assert.equal((await duplicate.subject())?.subject_id, undefined);

      await incumbent.presence.release();

      // The duplicate's claim is sticky: releasing the incumbent does not promote
      // it. Only a fresh session load may be reconsidered.
      await duplicate.presence.ensure();
      assert.equal(duplicate.presence.management()?.state, "duplicate");
      assert.equal((await duplicate.subject())?.subject_id, undefined);
    } finally {
      incumbent.stop();
      duplicate.stop();
    }
  });
});
