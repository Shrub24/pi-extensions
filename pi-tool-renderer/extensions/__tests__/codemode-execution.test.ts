import { expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createFauxCore, fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { createAgentSession, createCodemodeExtension, DefaultResourceLoader, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { CODEMODE_DISPLAY_KEY, CodemodeCapture, installCodemodeCapture } from "../tool-renderer/codemode-capture.js";
import { useWorld } from "./helpers/world.js";

const world = useWorld();

test("real codemode execution captures the nested patch without replacing script output or nested tool behaviour", async () => {
	const { cwd, agent: agentDir } = world();
	writeFileSync(join(cwd, "sample.ts"), "const before = 1;\n");
	const core = createFauxCore({ api: "codemode-faux", provider: "codemode-faux", models: [{ id: "scripted", contextWindow: 200_000, maxTokens: 1000 }] });
	core.setResponses([
		() => fauxAssistantMessage([fauxToolCall("codemode", { code: 'text(await tools.edit({path:"sample.ts",oldText:"before",newText:"after"})); text("script marker");' })], { stopReason: "toolUse" }),
		() => fauxAssistantMessage([fauxText("done")]),
	]);
	const capture = new CodemodeCapture();
	const loader = new DefaultResourceLoader({
		cwd, agentDir, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
		extensionFactories: [createCodemodeExtension(), (pi) => {
			installCodemodeCapture(pi, capture);
			pi.registerProvider("codemode-faux", {
				api: core.api as never, baseUrl: "http://codemode-faux.invalid", apiKey: "unused", streamSimple: core.streamSimple as never,
				models: [{ id: "scripted", name: "scripted", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200_000, maxTokens: 1000 }],
			});
		}],
	});
	await loader.reload();
	expect(loader.getExtensions().errors).toEqual([]);
	const { session } = await createAgentSession({
		cwd, agentDir, resourceLoader: loader, sessionManager: SessionManager.inMemory(cwd),
		settingsManager: SettingsManager.inMemory({ compaction: { enabled: false } }), tools: ["edit", "codemode"],
	});
	try {
		await session.bindExtensions({});
		await session.setModel(session.modelRuntime.getModel("codemode-faux", "scripted")!);
		await session.prompt("Run it.");
		const message: any = session.messages.find((message) => message.role === "toolResult" && message.toolName === "codemode");
		expect(message?.isError).toBe(false);
		expect(readFileSync(join(cwd, "sample.ts"), "utf8")).toBe("const after = 1;\n");
		const output = message.content.filter((block: any) => block.type === "text").map((block: any) => block.text).join("\n");
		expect(output).toContain("Successfully replaced 1 block(s) in sample.ts.");
		expect(output).toContain("script marker");
		const display = message.details[CODEMODE_DISPLAY_KEY];
		expect(display.calls).toHaveLength(1);
		expect(display.calls[0].status).toBe("ok");
		expect(display.calls[0].patch).toContain("+const after = 1;");
		expect(capture.get(message.toolCallId)).toBeUndefined();
	} finally { session.dispose(); }
});
