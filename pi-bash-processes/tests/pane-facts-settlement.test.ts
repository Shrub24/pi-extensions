import { afterAll, expect, test } from "bun:test";
import { bindBackgroundWorkAssignment, protectBackgroundWorkAssignment, queryBackgroundWorkSnapshot } from "../extensions/background-work.js";
import { startExtensionHost } from "./fixtures/extension-host.js";

const host = await startExtensionHost({ mode: "tui", settings: { exitWakeDebounceMs: 0, exitWakeBatchMs: 0, defaultSoftTimeoutMs: 0 } });
process.env.HERDR_PANE_ID = "pane-settlement-test";
afterAll(async () => { delete process.env.HERDR_PANE_ID; await host.dispose(); });
const scope = { sessionId: host.ctx.sessionManager.getSessionId(), requestId: "pane-settlement-request" };

async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!predicate() && Date.now() < deadline) await Bun.sleep(5);
  expect(predicate()).toBe(true);
}

const writes = () => host.execCalls.filter(({ command }) => command === "herdr");
const latest = () => writes().at(-1)?.args ?? [];
const reminders = () => host.userMessages.filter((message) => JSON.stringify(message).includes("Assignment completion is held"));

test("an unread completed result remains an advertised dependency and gets one actionable recovery turn", async () => {
  expect(bindBackgroundWorkAssignment(host.events, scope)).toStrictEqual({ state: "bound" });
  expect(protectBackgroundWorkAssignment(host.events, scope, true)).toStrictEqual({ state: "bound" });
  await host.dispatch("before_agent_start");
  const tool = host.tools.get("bg_task")!;
  const spawned = await tool.execute("settlement-spawn", { action: "spawn", command: "printf 'certified result\\n'" });
  const id = (spawned.details.task as { id: string }).id;
  await host.settledTask(id);
  await host.dispatch("agent_settled");
  const state = queryBackgroundWorkSnapshot(host.events, scope);
  expect(state.state).toBe("ready");
  if (state.state !== "ready") throw new Error("provider not ready");
  expect(state.snapshot.outstanding).toMatchObject([{ taskId: id, state: "awaiting-result-review" }]);
  await until(() => writes().length > 0);
  expect(latest()).toContain(`pi_bg_tasks=${id}:review`);
  expect(latest()).toContain("pi_bg_running=0");
  expect(reminders()).toHaveLength(0);

  // A second final turn without retrieving the handle is the observed stall.
  await host.dispatch("before_agent_start");
  await host.dispatch("agent_settled");
  expect(reminders()).toHaveLength(1);
  expect(JSON.stringify(reminders()[0])).toContain(id);
  expect(JSON.stringify(reminders()[0])).toContain("bg_task");
  await host.dispatch("agent_settled");
  expect(reminders(), "no automatic reminder loop").toHaveLength(1);

  await tool.execute("settlement-get", { action: "get", id, output: "full" });
  await until(() => latest().includes("--clear-token"));
  const resolved = queryBackgroundWorkSnapshot(host.events, scope);
  expect(resolved.state === "ready" && resolved.snapshot.outstanding).toStrictEqual([]);
  await host.dispatch("agent_settled");
  expect(reminders()).toHaveLength(1);
});
