import { expect, test } from "bun:test";
import * as agent from "@earendil-works/pi-coding-agent";

import { registerBashOnSessionStart } from "../tool-renderer/tools.js";

const MANAGED_BASH_SYMBOL = Symbol.for("kendex.background-tasks.managed-bash");

function fixture() {
	const handlers: Array<() => void> = [];
	const tools: Array<{ name: string }> = [];
	const pi = {
		on(event: string, handler: () => void) {
			if (event === "session_start") handlers.push(handler);
		},
		registerTool(tool: { name: string }) {
			tools.push(tool);
		},
	};
	return { handlers, pi, tools };
}

test("managed Bash registered after the renderer loads causes no duplicate tool", () => {
	const interop = globalThis as unknown as Record<PropertyKey, unknown>;
	const previous = interop[MANAGED_BASH_SYMBOL];
	delete interop[MANAGED_BASH_SYMBOL];
	try {
		const { handlers, pi, tools } = fixture();
		registerBashOnSessionStart(pi as any, agent, process.cwd());
		expect(tools).toEqual([]);

		interop[MANAGED_BASH_SYMBOL] = true;
		handlers[0]!();
		expect(tools).toEqual([]);
	} finally {
		if (previous === undefined) delete interop[MANAGED_BASH_SYMBOL];
		else interop[MANAGED_BASH_SYMBOL] = previous;
	}
});

test("native Bash renderer registers once at session start without managed Bash", () => {
	const interop = globalThis as unknown as Record<PropertyKey, unknown>;
	const previous = interop[MANAGED_BASH_SYMBOL];
	delete interop[MANAGED_BASH_SYMBOL];
	try {
		const { handlers, pi, tools } = fixture();
		registerBashOnSessionStart(pi as any, agent, process.cwd());
		expect(tools).toEqual([]);
		handlers[0]!();
		handlers[0]!();
		expect(tools.map((tool) => tool.name)).toEqual(["bash"]);
	} finally {
		if (previous === undefined) delete interop[MANAGED_BASH_SYMBOL];
		else interop[MANAGED_BASH_SYMBOL] = previous;
	}
});
