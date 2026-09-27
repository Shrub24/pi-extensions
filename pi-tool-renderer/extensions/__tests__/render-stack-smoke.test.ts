import { expect, test } from "bun:test";
import { Container } from "@earendil-works/pi-tui";

import { installToolChromePatch } from "../tool-renderer/chrome.js";
import { installAssistantMessageRenderer } from "../tool-renderer/messages.js";

/**
 * Reproduces the crash shape: the chrome patch wraps Container.prototype.render,
 * so a tool row containing an assistant message renders through
 * patchedToolChromeRender -> spacedAssistantRender. The assistant patch used to
 * reach for a scoped `state` there and threw ReferenceError on session load.
 */
test("tool chrome wrapping an assistant message renders without throwing", () => {
	installToolChromePatch();
	const pi: any = { on: () => {} };
	const assistantProto: any = {
		render() {
			return ["# Heading", "", "body text"];
		},
		updateContent() {},
		invalidate() {},
	};
	installAssistantMessageRenderer(pi, { prototype: assistantProto });

	const assistant = Object.create(assistantProto);
	assistant.lastMessage = { role: "assistant", content: [{ type: "text", text: "body text" }], timestamp: Date.now() };
	assistant.hasToolCalls = false;

	const container = new Container();
	container.addChild(assistant as never);
	const lines = (container as any).render(70);
	expect(Array.isArray(lines)).toBe(true);
	expect(lines.length).toBeGreaterThan(0);
});
