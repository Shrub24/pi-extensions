import assert from "node:assert/strict";
import { it } from "node:test";
import {
	CHILD_CONTEXT_BUDGET_CAP,
	CHILD_CONTEXT_BUDGET_RATIO,
	applyChildContextBudget,
	createChildContextBudgetState,
	formatChildCompactionNotice,
	resolveChildContextBudget,
} from "../../src/runs/shared/child-compaction.ts";

// Budget = min(ratio x window, cap), with a floor that keeps submission room for
// tiny windows. These are the values an operator reasons about when they ask
// "when does a child compact?", so they are pinned here.
it("resolves the child context budget as min(ratio x window, cap)", () => {
	const big = resolveChildContextBudget(1_000_000);
	assert.equal(big.budgetTokens, CHILD_CONTEXT_BUDGET_CAP);
	assert.equal(big.reserveTokens, 1_000_000 - CHILD_CONTEXT_BUDGET_CAP, "reserve is what pi subtracts from the window");
	assert.equal(big.contextWindow, 1_000_000);

	const mid = resolveChildContextBudget(400_000);
	assert.equal(mid.budgetTokens, Math.floor(400_000 * CHILD_CONTEXT_BUDGET_RATIO), "ratio governs below the cap");

	const small = resolveChildContextBudget(200_000);
	assert.equal(small.budgetTokens, 60_000);
	assert.ok(small.budgetTokens < small.contextWindow);
});

it("falls back to pi's assumed window when the model reports none", () => {
	const unknown = resolveChildContextBudget(undefined);
	assert.equal(unknown.contextWindow, 128_000);
	assert.equal(unknown.budgetTokens, Math.floor(128_000 * CHILD_CONTEXT_BUDGET_RATIO));
});

it("never lets the budget swallow the whole window", () => {
	// A window too small for the cap still yields to the ratio first; the
	// window-1 floor only bites when the ratio would exceed the window.
	const tiny = resolveChildContextBudget(1_500, { cap: 250_000 });
	assert.equal(tiny.budgetTokens, Math.floor(1_500 * CHILD_CONTEXT_BUDGET_RATIO));
	assert.equal(tiny.reserveTokens, 1_500 - tiny.budgetTokens);

	const absurd = resolveChildContextBudget(10, { ratio: 5, cap: 250_000 });
	assert.equal(absurd.budgetTokens, 9, "a ratio above the window still leaves room to answer");
	assert.equal(absurd.reserveTokens, 1);
});

it("arms pi's own threshold and keeps it in memory", () => {
	const overrides: Record<string, unknown>[] = [];
	const settings = { applyOverrides: (value: Record<string, unknown>) => { overrides.push(value); } };
	const state = createChildContextBudgetState();
	const applied = applyChildContextBudget(settings, { contextWindow: 1_000_000 }, state);
	assert.ok(applied);
	assert.equal(state.applied?.budgetTokens, CHILD_CONTEXT_BUDGET_CAP);
	assert.equal(overrides.length, 1);
	const compaction = overrides[0]?.compaction as { enabled?: boolean; reserveTokens?: number; keepRecentTokens?: number };
	assert.equal(compaction.enabled, true, "children opt into compaction even though the parent disables it");
	assert.equal(compaction.reserveTokens, 1_000_000 - CHILD_CONTEXT_BUDGET_CAP);
	assert.ok((compaction.keepRecentTokens ?? 0) > 0);
});

it("can be switched off for a session via the env escape hatch", () => {
	const settings = { applyOverrides: () => { throw new Error("must not arm when disabled"); } };
	const previous = process.env.PI_SUBAGENTS_CHILD_CONTEXT_BUDGET;
	process.env.PI_SUBAGENTS_CHILD_CONTEXT_BUDGET = "0";
	try {
		assert.equal(applyChildContextBudget(settings, { contextWindow: 1_000_000 }, createChildContextBudgetState()), undefined);
	} finally {
		if (previous === undefined) delete process.env.PI_SUBAGENTS_CHILD_CONTEXT_BUDGET;
		else process.env.PI_SUBAGENTS_CHILD_CONTEXT_BUDGET = previous;
	}
});

it("phrases the orchestrator notice with the numbers that prompt a decision", () => {
	const notice = formatChildCompactionNotice({ at: 1, tokensBefore: 251_004, budgetTokens: 250_000, reason: "threshold" }, "worker");
	assert.ok(notice.includes("worker"), notice);
	assert.ok(notice.includes("251,004"), notice);
	assert.ok(notice.includes("250,000"), notice);
	assert.ok(notice.includes("run continues"), notice);
});

/**
 * The budget only matters if it reaches a real session's settings manager. This
 * runs the real SDK (set PI_SUBAGENTS_NATIVE_SDK to an installed pi package) and
 * asserts the child comes up armed even though the user's settings disable
 * compaction — the state that makes pi's between-turn check fire at the budget.
 */
const sdkRoot = process.env.PI_SUBAGENTS_NATIVE_SDK;

it("arms a real child session's settings manager, not just a stub", { skip: !sdkRoot && "Set PI_SUBAGENTS_NATIVE_SDK to an installed pi package root" }, async () => {
	const { execFileSync } = await import("node:child_process");
	const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	const { createDefaultChildSessionFactory } = await import("../../src/runs/shared/child-session.ts");

	const entry = execFileSync(process.execPath, ["--input-type=module", "-e", "console.log(import.meta.resolve('@earendil-works/pi-coding-agent'))"], { cwd: sdkRoot, encoding: "utf8" }).trim();
	const pi = await import(entry);
	const cwd = mkdtempSync(join(tmpdir(), "child-budget-"));
	const agentDir = join(cwd, "agent");
	mkdirSync(agentDir);
	const previousDir = process.env.PI_CODING_AGENT_DIR;
	const previousPackageDir = process.env.PI_PACKAGE_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	// Builtin assets (themes) resolve relative to the package dir; on a Nix install
	// that path is the compiled single-file package, which has none.
	process.env.PI_PACKAGE_DIR = sdkRoot;
	// Mirrors the operator's own settings: compaction disabled globally because
	// the parent session is under magic-context's control.
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ compaction: { enabled: false } }));
	writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: { fixture: { baseUrl: "https://synthetic.invalid/v1", apiKey: "k", models: [{ id: "big", name: "big", api: "openai-completions", reasoning: false, input: ["text"], contextWindow: 1_000_000, maxTokens: 512, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } }));
	let observed: { enabled: boolean; reserveTokens: number } | undefined;
	const factory = createDefaultChildSessionFactory({ loadPiCodingAgent: async () => ({ ...pi, createAgentSession: async (options: unknown) => {
		const result = await pi.createAgentSession(options as never);
		observed = result.session.settingsManager.getCompactionSettings(result.session.model);
		return result;
	} }) });
	try {
		const child = await factory.create({
			cwd, storage: { kind: "memory" }, model: "fixture/big", tools: [], extensionPaths: [], ambientExtensions: false,
			noSkills: true, noContextFiles: true, runtime: {}, hooks: [], onExtensionError() {},
			contextBudget: createChildContextBudgetState(),
		} as never);
		await child.dispose();
		assert.ok(observed, "settings must be observable");
		assert.equal(observed.enabled, true, "children opt in although the operator's settings disable compaction");
		assert.equal(observed.reserveTokens, 1_000_000 - CHILD_CONTEXT_BUDGET_CAP, "the threshold lands at the configured budget");
	} finally {
		await factory.dispose();
		if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousDir;
		if (previousPackageDir === undefined) delete process.env.PI_PACKAGE_DIR; else process.env.PI_PACKAGE_DIR = previousPackageDir;
		rmSync(cwd, { recursive: true, force: true });
	}
});

it("honours childContextBudget from the subagents config", async () => {
	const { mkdtempSync, writeFileSync, rmSync, mkdirSync } = await import("node:fs");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	const agentDir = mkdtempSync(join(tmpdir(), "budget-config-"));
	const configDir = join(agentDir, "extensions", "subagent");
	mkdirSync(configDir, { recursive: true });
	const configFile = join(configDir, "config.json");
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	try {
		writeFileSync(configFile, JSON.stringify({ childContextBudget: { ratio: 0.5, capTokens: 150_000 } }));
		const onBigWindow = resolveChildContextBudget(1_000_000);
		assert.equal(onBigWindow.budgetTokens, 150_000, "the cap applies above cap/ratio");
		const onSmallWindow = resolveChildContextBudget(200_000);
		assert.equal(onSmallWindow.budgetTokens, 100_000, "the ratio applies below it");

		writeFileSync(configFile, JSON.stringify({}));
		assert.equal(resolveChildContextBudget(1_000_000).budgetTokens, CHILD_CONTEXT_BUDGET_CAP, "defaults return when the key is absent");
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
		rmSync(agentDir, { recursive: true, force: true });
	}
});
