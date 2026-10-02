// The codemode root purpose and the required-intent guard.
//
// A codemode script states its purpose as one leading `// intent: ...` comment —
// a comment inside the `code` the native tool already takes, never a new
// argument — and the root row shows it as that row's intent. The intent
// argument itself is an optional schema property for every caller, so a script's
// nested call (which no model wrote an intent for) still validates; the required
// policy is enforced per call by the `tool_call` guard this package installs.

import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Container, Text } from "@earendil-works/pi-tui";
import * as agent from "@earendil-works/pi-coding-agent";

import { attachCodemodePurpose, withCodemodePurpose } from "../tool-renderer/codemode.js";
import { clearPackageConfigCache } from "../tool-renderer/package-config.js";
import {
	codemodePurposeRefusal,
	installIntentGuard,
	missingIntentRefusal,
	parseCodemodePurpose,
	type IntentGuardCallEvent,
} from "../tool-renderer/intent.js";
import { CONFIG_ID } from "../tool-renderer/settings.js";
import { registerRead } from "../tool-renderer/tools.js";
import { useWorld } from "./helpers/world.js";

const world = useWorld();
const theme = {
	bold: (text: string) => text,
	fg: (_color: string, text: string) => text,
} as never;

/** Write this package's settings for the test world, then drop the memoized read. */
function configure(config: Record<string, unknown>): void {
	const { agent } = world();
	writeFileSync(join(agent, "settings.json"), JSON.stringify({
		kendex: { extensionManager: { config: { [CONFIG_ID]: { enabled: true, ...config } } } },
	}));
	clearPackageConfigCache();
}

/** The `tool_call` handler the extension installs, on a fake `pi`. */
function guardHandler(options: { tools: string[]; codemodePurpose?: boolean }) {
	const handlers: ((event: IntentGuardCallEvent, ctx?: { cwd?: string }) => unknown)[] = [];
	installIntentGuard({ on: (event, handler) => { if (event === "tool_call") handlers.push(handler as never); } }, options);
	expect(handlers.length).toBe(1);
	return handlers[0]!;
}

test("a purpose is the one leading comment, after the native options line when present", () => {
	expect(parseCodemodePurpose("// intent: check the failing build\nawait tools.bash({ command: \"x\" })")).toBe("check the failing build");
	// The native `// @options:` header stays first and its line is still the tool's.
	expect(parseCodemodePurpose("// @options: {\"maxCalls\":2}\n// intent: gather failures\nreturn 1")).toBe("gather failures");
	// A leading blank line is not executable code.
	expect(parseCodemodePurpose("\n// intent: after a blank line\nreturn 1")).toBe("after a blank line");
	// Case and spacing of the marker are the comment's, not a grammar change.
	expect(parseCodemodePurpose("//   Intent:  Mixed marker  \nreturn 1")).toBe("Mixed marker");
});

test("a purpose-looking string, a late comment, or an ambiguous pair is not a purpose", () => {
	expect(parseCodemodePurpose("const note = \"// intent: not a comment\";\nawait tools.bash({})")).toBeUndefined();
	expect(parseCodemodePurpose("await tools.bash({});\n// intent: too late")).toBeUndefined();
	expect(parseCodemodePurpose("// intent: first\n// intent: second\nreturn 1")).toBeUndefined();
	expect(parseCodemodePurpose("// intent:\nreturn 1")).toBeUndefined();
	expect(parseCodemodePurpose("// intent: ab\nreturn 1")).toBeUndefined();
	expect(parseCodemodePurpose("// @options: {}\nawait tools.bash({})")).toBeUndefined();
	expect(parseCodemodePurpose(undefined)).toBeUndefined();
});

test("the intent argument is optional in a registered tool's schema, for every mode", () => {
	const { cwd } = world();
	configure({ intentMode: "required" });
	const tools: { name: string; parameters: { required?: string[]; properties: Record<string, unknown> } }[] = [];
	registerRead({ registerTool: (definition: never) => tools.push(definition) } as never, agent, cwd);
	expect(tools.length).toBe(1);
	const parameters = tools[0]!.parameters;
	expect(Object.keys(parameters.properties)).toContain("intent");
	// Pi validates a nested call against this schema before any hook runs, so a
	// required property here would fail a codemode script's own call.
	expect(parameters.required ?? []).not.toContain("intent");
});

test("the guard refuses only a model-issued call that omits a required intent", () => {
	const { cwd } = world();
	configure({ intentMode: "required" });
	const handler = guardHandler({ tools: ["read"], codemodePurpose: true });
	const call = (overrides: Partial<IntentGuardCallEvent> & { input?: unknown }): IntentGuardCallEvent =>
		({ toolName: "read", toolCallId: "call-1", ...overrides });

	// The model's own call, with and without the intent.
	expect(handler(call({ input: { path: "a.ts" } }), { cwd })).toEqual({
		block: true,
		reason: expect.stringContaining("missing its required \"intent\""),
	});
	expect(handler(call({ input: { path: "a.ts", intent: "read the failing test" } }), { cwd })).toBeUndefined();
	// A call another tool made: nothing wrote these arguments but the tool.
	expect(handler(call({ toolCallId: "cm-1/1", parentToolCallId: "cm-1", input: { path: "a.ts" } }), { cwd })).toBeUndefined();
	// A tool the guard does not own is left to its own package.
	expect(handler({ toolName: "bash", toolCallId: "call-2", input: { command: "x" } }, { cwd })).toBeUndefined();
});

test("optional and off modes never refuse an ordinary call", () => {
	const { cwd } = world();
	const handler = guardHandler({ tools: ["read"], codemodePurpose: true });
	configure({ intentMode: "optional" });
	expect(handler({ toolName: "read", toolCallId: "call-1", input: { path: "a.ts" } }, { cwd })).toBeUndefined();
	configure({ intentMode: "off" });
	expect(handler({ toolName: "read", toolCallId: "call-2", input: { path: "a.ts" } }, { cwd })).toBeUndefined();
	// A per-tool override still decides for that tool alone.
	configure({ intentMode: "optional", intentModeOverrides: "{\"read\":\"required\"}" });
	expect(handler({ toolName: "read", toolCallId: "call-3", input: { path: "a.ts" } }, { cwd })).toMatchObject({ block: true });
});

test("a root codemode call needs its purpose only in required mode, and only from the model", () => {
	const { cwd } = world();
	const handler = guardHandler({ tools: ["read"], codemodePurpose: true });
	const root = (input: unknown): IntentGuardCallEvent => ({ toolName: "codemode", toolCallId: "cm-1", input });

	configure({ intentMode: "required" });
	expect(handler(root({ code: "await tools.bash({ command: \"x\" })" }), { cwd })).toEqual({
		block: true,
		reason: expect.stringContaining("missing its purpose"),
	});
	expect(handler(root({ code: "// intent: run the check\nawait tools.bash({ command: \"x\" })" }), { cwd })).toBeUndefined();
	// A script made this call: exempt, like any other tool-issued call.
	expect(handler({ toolName: "codemode", toolCallId: "cm-1/1", parentToolCallId: "cm-1", input: { code: "return 1" } }, { cwd })).toBeUndefined();

	configure({ intentMode: "optional" });
	expect(handler(root({ code: "return 1" }), { cwd })).toBeUndefined();
	configure({ intentMode: "off" });
	expect(handler(root({ code: "return 1" }), { cwd })).toBeUndefined();
});

test("the guard's host only owns the tools it registered and the codemode purpose it presents", () => {
	const { cwd } = world();
	configure({ intentMode: "required" });
	// Tool-package host: it does not present the codemode row, so it does not judge it.
	const handler = guardHandler({ tools: ["bash"] });
	expect(handler({ toolName: "codemode", toolCallId: "cm-1", input: { code: "return 1" } }, { cwd })).toBeUndefined();
	expect(handler({ toolName: "bash", toolCallId: "b-1", input: { command: "x" } }, { cwd })).toMatchObject({ block: true });
});

test("a clean event set stays clean: the exemption is provenance, not stored ancestry", () => {
	const { cwd } = world();
	configure({ intentMode: "required" });
	const handler = guardHandler({ tools: ["read"], codemodePurpose: true });
	// Interleaved concurrent calls cannot contaminate each other: the decision
	// reads only the event, so a nested call never inherits a root's requirement
	// and a root never inherits a nested call's exemption.
	const root = { toolName: "codemode", toolCallId: "cm-a", input: { code: "return 1" } } as const;
	const nested = { toolName: "codemode", toolCallId: "cm-a/1", parentToolCallId: "cm-a", input: { code: "return 1" } } as const;
	expect(handler(root, { cwd })).toMatchObject({ block: true });
	expect(handler(nested, { cwd })).toBeUndefined();
	expect(handler(root, { cwd })).toMatchObject({ block: true });
	// A finished root leaves nothing behind to release: the same call id judged
	// again is judged the same way.
	expect(missingIntentRefusal("read", { toolName: "read", toolCallId: "cm-a/1", parentToolCallId: "cm-a", input: {} }, cwd)).toBeUndefined();
	expect(codemodePurposeRefusal({ toolName: "codemode", toolCallId: "cm-a", input: { code: "return 1" } }, cwd)).toMatchObject({ block: true });
});

test("the codemode row shows the purpose as its intent and keeps the native code row", () => {
	// The shape Pi's codemode renderer builds: a title line, then the script.
	const native = new Container();
	native.addChild(new Text("codemode", 0, 0));
	native.addChild(new Text("await tools.bash({ command: \"x\" })", 0, 0));

	const withPurpose = attachCodemodePurpose(native, { code: "// intent: run the check\nawait tools.bash({ command: \"x\" })" }, theme);
	expect(withPurpose).toBe(native);
	expect(withPurpose.render(80).join("\n")).toContain("codemode — run the check");
	// The code row and the result presentation are the native ones.
	expect(withPurpose.render(80).join("\n")).toContain("await tools.bash({ command: \"x\" })");
});

test("a codemode call without a purpose leaves the native row untouched", () => {
	const native = new Container();
	native.addChild(new Text("codemode", 0, 0));
	const rendered = attachCodemodePurpose(native, { code: "await tools.bash({ command: \"x\" })" }, theme);
	expect(rendered).toBe(native);
	expect(rendered.render(80).join("\n")).not.toContain("—");
});

test("the wrapped native codemode renderer is the one that builds the row", () => {
	const calls: unknown[] = [];
	const nativeRenderCall = (args: { code?: string }) => {
		calls.push(args);
		const component = new Container();
		component.addChild(new Text("codemode", 0, 0));
		component.addChild(new Text(args.code ?? "", 0, 0));
		return component;
	};
	const renderCall = withCodemodePurpose(nativeRenderCall as never);
	const component = renderCall({ code: "// intent: inspect the log\nreturn 1" }, theme, {});
	// Pi's renderer received the call's own code: no argument was added or rewritten.
	expect(calls).toEqual([{ code: "// intent: inspect the log\nreturn 1" }]);
	expect(component.render(80).join("\n")).toContain("codemode — inspect the log");
	expect(component.render(80).join("\n")).toContain("// intent: inspect the log");
});
