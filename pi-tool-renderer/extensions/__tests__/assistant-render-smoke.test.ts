import { expect, test } from "bun:test";

import { installAssistantMessageRenderer } from "../tool-renderer/messages.js";

function fakeComponent() {
	const proto: any = {
		render(_width: number) {
			return ["# Heading", "", "body text"];
		},
		updateContent() {},
		invalidate() {},
	};
	const pi: any = { on: () => {} };
	return { proto, pi };
}

test("assistant render runs without reaching for scoped state", () => {
	const { proto, pi } = fakeComponent();
	installAssistantMessageRenderer(pi, { prototype: proto });
	const instance = Object.create(proto);
	instance.lastMessage = { role: "assistant", content: [{ type: "text", text: "body text" }], timestamp: Date.now() };
	instance.hasToolCalls = false;
	const lines = instance.render(60);
	expect(Array.isArray(lines)).toBe(true);
	expect(lines.length).toBeGreaterThan(0);
	// Second render takes the memoized path and must be stable.
	expect(instance.render(60)).toEqual(lines);
});

test("streaming content changes invalidate the render memo", () => {
	const { proto, pi } = fakeComponent();
	let body = "first";
	proto.render = () => [body];
	installAssistantMessageRenderer(pi, { prototype: proto });
	const instance = Object.create(proto);
	instance.lastMessage = { role: "assistant", content: [{ type: "text", text: "first" }], timestamp: Date.now() };
	instance.hasToolCalls = false;
	const before = instance.render(60);
	body = "second";
	instance.lastMessage = { role: "assistant", content: [{ type: "text", text: "second" }], timestamp: Date.now() };
	const after = instance.render(60);
	expect(after).not.toEqual(before);
});
