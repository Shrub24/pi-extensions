import { afterAll, beforeEach, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { BG_STATE_TYPE } from "../extensions/constants.js";
import { sidecarStatePath } from "../extensions/persistence.js";
import { startExtensionHost } from "./fixtures/extension-host.js";
import { fakeSnapshot } from "./fixtures/lifecycle.js";

const host = await startExtensionHost();
afterAll(() => host.dispose());

const legacyTask = (id: string) => fakeSnapshot({
	id, status: "completed", exitCode: 0, exitNotified: true, resultReady: true,
	sessionId: host.ctx.sessionManager.getSessionId(), pid: undefined as never, logFile: `${host.root}/${id}.log`,
});
const legacyEntry = (...ids: string[]) => ({ type: "custom", customType: BG_STATE_TYPE, data: { version: 1, tasks: ids.map(legacyTask), updatedAt: 1 } });
const sidecarFile = () => sidecarStatePath(host.ctx);
const ids = async () => (await host.listTasks()).map((task) => task.id).sort();
const restart = async () => { await host.dispatch("session_shutdown"); await host.dispatch("session_start"); };

beforeEach(async () => {
	await host.dispatch("session_shutdown");
	host.entries.length = 0;
	host.branch.length = 0;
	rmSync(dirname(sidecarFile()), { recursive: true, force: true });
	await host.dispatch("session_start");
});

test("a session with no sidecar restores its legacy snapshots once and writes the sidecar", async () => {
	await host.dispatch("session_shutdown");
	rmSync(dirname(sidecarFile()), { recursive: true, force: true });
	host.branch.push(legacyEntry("bg-7"));
	await host.dispatch("session_start");
	expect(await ids()).toEqual(["bg-7"]);
	const migrated = JSON.parse(readFileSync(sidecarFile(), "utf8")) as { version: number; sessionId: string; tasks: { id: string }[] };
	expect({ version: migrated.version, ids: migrated.tasks.map((task) => task.id) }).toEqual({ version: 2, ids: ["bg-7"] });
	expect(migrated.sessionId).toBe(host.ctx.sessionManager.getSessionId());
});

test("a loaded sidecar wins over every older snapshot in the branch", async () => {
	const result = await host.tools.get("bg_task")!.execute("auth-spawn", { action: "spawn", command: "sleep 30" });
	const id = (result.details.task as { id: string }).id;
	host.branch.push(legacyEntry("bg-ghost"));
	await restart();
	expect(await ids(), "the old roster does not add a task the sidecar lacks").toEqual([id]);
	await host.tools.get("bg_task")!.execute("auth-stop", { action: "stop", id: "all" });
});

test("an empty sidecar is authoritative: removed tasks do not come back from the branch", async () => {
	await host.dispatch("session_shutdown");
	rmSync(dirname(sidecarFile()), { recursive: true, force: true });
	host.branch.push(legacyEntry("bg-7"));
	await host.dispatch("session_start");
	expect(await ids()).toEqual(["bg-7"]);
	await host.clearFinished();
	expect(await ids()).toEqual([]);
	await restart();
	expect(await ids(), "the branch still holds the old snapshot; the empty store wins").toEqual([]);
});

test("an unreadable sidecar is kept aside and reported, and the legacy branch rebuilds the roster", async () => {
	await host.dispatch("session_shutdown");
	writeFileSync(sidecarFile(), "{ not json");
	host.branch.push(legacyEntry("bg-9"));
	const before = host.notifications.length;
	await host.dispatch("session_start");
	expect(await ids(), "corruption is not an empty roster").toEqual(["bg-9"]);
	const kept = readdirSync(dirname(sidecarFile())).filter((name) => name.startsWith("state.json.corrupt-"));
	expect(kept, "the unreadable file is preserved for recovery").toHaveLength(1);
	expect(readFileSync(`${dirname(sidecarFile())}/${kept[0]}`, "utf8")).toBe("{ not json");
	expect(String(host.notifications.slice(before).flat().join(" "))).toContain("could not be read");
	expect(existsSync(sidecarFile()), "a fresh sidecar replaces it").toBe(true);
});
