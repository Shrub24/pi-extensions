import { describe, expect, test } from "bun:test";
import copyMode, { COPY_MODE_SHORTCUT } from "../extensions/copy-mode.js";

type Registered = { command?: (args: string, ctx: any) => Promise<void>; shortcut?: (ctx: any) => Promise<void> };

function loadExtension(copied: string[] = []): Registered {
	const registered: Registered = {};
	copyMode({
		registerCommand(name: string, options: { handler: (args: string, ctx: any) => Promise<void> }) {
			if (name === "copy-mode") registered.command = options.handler;
		},
		registerShortcut(key: string, options: { handler: (ctx: any) => Promise<void> }) {
			if (key === COPY_MODE_SHORTCUT) registered.shortcut = options.handler;
		},
	} as any, {
		copy: async (text: string) => {
			copied.push(text);
		},
	});
	return registered;
}

const assistant = (text: string, timestamp: number) => ({
	type: "message",
	message: { role: "assistant", content: [{ type: "text", text }], timestamp },
});

function fakeContext(options: { entries: unknown[]; choose?: string; hasUI?: boolean }) {
	const notices: string[] = [];
	const selects: string[][] = [];
	let component: any;
	const ctx = {
		hasUI: options.hasUI ?? true,
		sessionManager: { getBranch: () => options.entries },
		ui: {
			notify: (message: string) => notices.push(message),
			select: async (_title: string, labels: string[]) => {
				selects.push(labels);
				return options.choose ?? labels[0];
			},
			custom: (factory: any) =>
				new Promise((resolve) => {
					const theme = { bg: (_: string, text: string) => text, fg: (_: string, text: string) => text };
					component = factory({ requestRender() {} }, theme, undefined, resolve);
				}),
		},
	};
	return { ctx, notices, selects, press: (keys: string[]) => keys.forEach((key) => component.handleInput(key)) };
}

describe("copy mode extension wiring", () => {
	test("registers the copy-mode command and the ctrl+shift+y shortcut", () => {
		const registered = loadExtension();
		expect(COPY_MODE_SHORTCUT).toBe("ctrl+shift+y");
		expect(typeof registered.command).toBe("function");
		expect(typeof registered.shortcut).toBe("function");
	});

	test("without a UI nothing opens", async () => {
		const registered = loadExtension();
		const { ctx, notices, selects } = fakeContext({ entries: [assistant("hi", 1)], hasUI: false });
		await registered.command!("", ctx);
		expect(notices).toEqual([]);
		expect(selects).toEqual([]);
	});

	test("with no assistant text the user is told and no overlay opens", async () => {
		const registered = loadExtension();
		const { ctx, notices, selects } = fakeContext({ entries: [{ type: "message", message: { role: "user", content: [] } }] });
		await registered.command!("", ctx);
		expect(notices).toEqual(["No assistant text to copy in this session branch."]);
		expect(selects).toEqual([]);
	});

	test("a single assistant message opens the overlay directly and copies the marked source", async () => {
		const copied: string[] = [];
		const registered = loadExtension(copied);
		const { ctx, notices, selects, press } = fakeContext({ entries: [assistant("## Plan\nstep one\nstep two", 1)] });
		const pending = registered.command!("", ctx);
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(selects).toEqual([]);
		press(["j", "v", "j", "\r"]);
		await pending;
		expect(notices).toEqual(["Copied 2 source lines."]);
		expect(copied).toEqual(["step one\nstep two"]);
	});

	test("with several messages the picker lists the newest first and copies from the chosen one", async () => {
		const copied: string[] = [];
		const registered = loadExtension(copied);
		const older = assistant("older answer", Date.UTC(2026, 0, 1, 9, 0, 0));
		const newer = assistant("newer answer", Date.UTC(2026, 0, 1, 10, 0, 0));
		const { ctx, notices, selects, press } = fakeContext({ entries: [older, newer], choose: undefined });
		const pending = registered.command!("", ctx);
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(selects[0]![0]).toContain("newer answer");
		press(["\r"]);
		await pending;
		expect(notices).toEqual(["Copied 1 source line."]);
		expect(copied).toEqual(["newer answer"]);
	});

	test("cancelling the picker leaves everything closed", async () => {
		const registered = loadExtension();
		const older = assistant("older", 1);
		const newer = assistant("newer", 2);
		const { ctx, notices } = fakeContext({ entries: [older, newer] });
		ctx.ui.select = async () => undefined;
		await registered.command!("", ctx);
		expect(notices).toEqual([]);
	});
});
