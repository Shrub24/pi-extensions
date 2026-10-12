import { expect, test } from "bun:test";
import { healthReport } from "../src/health-report";
import type { CauseRecord, LeaseRecord } from "../src/health-store";

const now = Date.parse("2026-01-01T00:00:00Z");
const state: { revision: number; causes: CauseRecord[]; leases: LeaseRecord[] } = {
  revision: 7,
  causes: [
    { key: "opencode-go#go-a", kind: "quota", until: now + 60_000, revision: 3, reason: "quota" },
    { key: "opencode-go", kind: "transient", until: now - 1, revision: 2, reason: "transient" },
  ],
  leases: [{ key: "opencode-go#go-a", holder: "secret-holder-id", expires: now + 30_000, revision: 3 }],
};

test("the report names its coordination mode and the reason and expiry of each cause", () => {
  const lines = healthReport(state, now, "shared");
  expect(lines[0]).toBe("native-router health (shared across same-user processes; revision 7)");
  expect(lines).toContain("  opencode-go#go-a: quota until 2026-01-01T00:01:00.000Z [quota]");
  expect(lines).toContain("  opencode-go: transient until 2025-12-31T23:59:59.999Z (expired, probe eligible) [transient]");
  expect(lines).toContain("  probe opencode-go#go-a: held until 2026-01-01T00:00:30.000Z");
});

test("a degraded or local-only process cannot be mistaken for shared coordination", () => {
  const empty = { revision: 0, causes: [] as CauseRecord[], leases: [] as LeaseRecord[] };
  expect(healthReport(empty, now, "degraded-local")[0]).toContain("DEGRADED: shared store unavailable");
  expect(healthReport(empty, now, "local-only")[0]).toContain("sharedHealth is disabled");
  expect(healthReport(empty, now, "shared")).toEqual([
    "native-router health (shared across same-user processes; revision 0)",
    "  no active causes",
  ]);
});

test("the report never prints lease holder identities", () => {
  expect(healthReport(state, now, "shared").join("\n")).not.toContain("secret-holder-id");
});
