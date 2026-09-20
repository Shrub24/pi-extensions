import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { agentDir, defaultLogFile, DEFAULTS, readSettingsFile, readThresholds, resolveConfig } from "../extensions/config.js";

function writeSettings(config: Record<string, unknown>): NodeJS.ProcessEnv {
	const dir = mkdtempSync(join(tmpdir(), "pi-jev-"));
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, "settings.json"),
		JSON.stringify({ kendex: { extensionManager: { config: { "@vanillagreen/pi-jev": config } } } }),
		"utf8",
	);
	return { PI_CODING_AGENT_DIR: dir } as NodeJS.ProcessEnv;
}

test("defaults hold when there is no settings file, and a malformed file is not fatal", () => {
	const empty = resolveConfig({}, {} as NodeJS.ProcessEnv);
	expect(empty.mode).toBe("shadow");
	expect(empty.authorizerName).toBe("pi-jev");
	expect(empty.defaultThreshold).toBe(DEFAULTS.defaultThreshold);
	expect(empty.stateRetention).toBe("hash");
	expect(empty.maxRequestsPerSession).toBe(200);

	const dir = mkdtempSync(join(tmpdir(), "pi-jev-bad-"));
	writeFileSync(join(dir, "settings.json"), "{ not json", "utf8");
	const env = { PI_CODING_AGENT_DIR: dir } as NodeJS.ProcessEnv;
	expect(readSettingsFile(env)).toEqual({});
	expect(resolveConfig(readSettingsFile(env), env).mode).toBe("shadow");
});

test("settings resolve under the extension manager's config key", () => {
	const env = writeSettings({
		mode: "live",
		authorizerName: "semantic-judge",
		model: "jev-test-2",
		timeoutMs: 1_200,
		defaultThreshold: 0.95,
		stateRetention: "full",
		recentUserMessages: 3,
		recentToolCalls: 8,
		maxStateChars: 2_000,
		maxFieldChars: 300,
		maxRequestsPerSession: 25,
	});
	const config = resolveConfig(readSettingsFile(env), env);
	expect(config).toMatchObject({
		mode: "live",
		authorizerName: "semantic-judge",
		model: "jev-test-2",
		timeoutMs: 1_200,
		defaultThreshold: 0.95,
		stateRetention: "full",
		recentUserMessages: 3,
		recentToolCalls: 8,
		maxStateChars: 2_000,
		maxFieldChars: 300,
		maxRequestsPerSession: 25,
	});
	expect(config.logFile).toBe(join(env.PI_CODING_AGENT_DIR as string, "pi-jev", "decisions.jsonl"));
});

test("the environment overrides the file, and nonsense values fall back", () => {
	const env = { ...writeSettings({ mode: "shadow", model: "from-file", timeoutMs: 9_000 }), PI_JEV_MODE: "live", PI_JEV_MODEL: "from-env", PI_JEV_TIMEOUT_MS: "1500" } as NodeJS.ProcessEnv;
	const config = resolveConfig(readSettingsFile(env), env);
	expect(config.mode).toBe("live");
	expect(config.model).toBe("from-env");
	expect(config.timeoutMs).toBe(1_500);

	const nonsense = resolveConfig({ mode: "yolo", stateRetention: "everything", defaultThreshold: 0.5, maxStateChars: 10, timeoutMs: 5 }, {} as NodeJS.ProcessEnv);
	expect(nonsense.mode).toBe("shadow");
	expect(nonsense.stateRetention).toBe("hash");
	// A band edge of 0.5 would make the satisfied and violated bands meet.
	expect(nonsense.defaultThreshold).toBe(DEFAULTS.defaultThreshold);
	expect(nonsense.maxStateChars).toBe(DEFAULTS.maxStateChars);
	expect(nonsense.timeoutMs).toBe(DEFAULTS.timeoutMs);
});

test("the api key comes from settings or the environment, or is left to pi-typesafe", () => {
	// Settings key wins over the environment; absent both, the field is unset so
	// pi-typesafe resolves TYPESAFE_API_KEY / the stored key itself.
	const fromFile = resolveConfig({ apiKey: "  sk-file  " }, {} as NodeJS.ProcessEnv);
	expect(fromFile.apiKey).toBe("sk-file");
	const fromEnv = resolveConfig({ apiKey: "sk-file" }, { PI_JEV_API_KEY: "sk-env" } as unknown as NodeJS.ProcessEnv);
	expect(fromEnv.apiKey).toBe("sk-env");
	const unset = resolveConfig({}, {} as NodeJS.ProcessEnv);
	expect("apiKey" in unset).toBe(false);
});

test("per-question thresholds are kept only when they are usable", () => {
	expect(readThresholds({ a: 0.95, b: 0.4, c: "0.99", d: "nope", e: 1 }, {})).toEqual({ a: 0.95, c: 0.99, e: 1 });
	expect(readThresholds({ a: 0.95 }, { a: 0.8, keep: 0.7 })).toEqual({ a: 0.95, keep: 0.7 });
	expect(readThresholds("nope", { keep: 0.7 })).toEqual({ keep: 0.7 });
});

test("the log path follows the agent directory and the log override", () => {
	expect(agentDir({ PI_CODING_AGENT_DIR: "/tmp/agent" } as NodeJS.ProcessEnv)).toBe("/tmp/agent");
	expect(defaultLogFile({ PI_CODING_AGENT_DIR: "/tmp/agent" } as NodeJS.ProcessEnv)).toBe("/tmp/agent/pi-jev/decisions.jsonl");
	const env = { ...writeSettings({}), PI_JEV_LOG: "/tmp/custom.jsonl" } as NodeJS.ProcessEnv;
	expect(resolveConfig(readSettingsFile(env), env).logFile).toBe("/tmp/custom.jsonl");
});
