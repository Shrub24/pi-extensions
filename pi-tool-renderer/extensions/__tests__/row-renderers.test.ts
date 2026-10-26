import { expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { installRowRenderers } from "../tool-renderer/row-renderers.js";
import { registerReadOnly } from "../tool-renderer/tools.js";
import { useWorld } from "./helpers/world.js";

const world = useWorld();

type Resolver = (toolName: string, next: () => any) => any;

function fakePi() {
	const state: { resolver?: Resolver; tools: any[] } = { tools: [] };
	const pi = {
		registerTool: (tool: any) => { state.tools.push(tool); },
		registerToolRenderer: (resolver: Resolver) => { state.resolver = resolver; },
	};
	return { pi: pi as unknown as ExtensionAPI, state };
}

const host = {
	createGrepTool: () => ({ description: "grep", parameters: {}, execute: async () => ({ content: [] }) }),
	createFindTool: () => ({ description: "find", parameters: {}, execute: async () => ({ content: [] }) }),
	createLsTool: () => ({ description: "ls", parameters: {}, execute: async () => ({ content: [] }) }),
	createReadTool: () => ({ description: "read", parameters: {}, execute: async () => ({ content: [] }) }),
	createBashTool: () => ({ description: "bash", parameters: {}, execute: async () => ({ content: [] }) }),
	createEditTool: () => ({ description: "edit", parameters: {}, execute: async () => ({ content: [] }) }),
	createWriteTool: () => ({ description: "write", parameters: {}, execute: async () => ({ content: [] }) }),
};

const foreign = () => ({ renderCall: () => "foreign call", renderResult: () => "foreign result" });

test("the resolver draws our grep row even when another extension owns the name", () => {
	const { pi, state } = fakePi();
	registerReadOnly(pi, host, `${world().cwd}/resolver-grep`, "grep");
	installRowRenderers(pi);
	const drawn = state.resolver!("grep", foreign);
	expect(drawn.renderShell).toBe("self");
	expect(drawn.renderCall).not.toBe(foreign().renderCall);
	expect(drawn.renderResult).not.toBe(foreign().renderResult);
});

test("the resolver keeps another extension's renderers and adds our chrome shell", () => {
	const { pi, state } = fakePi();
	installRowRenderers(pi);
	const base = foreign();
	const drawn = state.resolver!("some_other_tool", () => base);
	expect(drawn).not.toBe(base);
	expect(drawn.renderShell).toBe("self");
	expect(drawn.renderCall).toBe(base.renderCall);
	expect(drawn.renderResult).toBe(base.renderResult);
});

const todoBase = () => ({
	renderCall: (args: any) => ({ text: `todo → ${args.subject}` }),
	renderResult: () => ({ text: "● completed" }),
});

test("a pending todo call keeps the package's call line", () => {
	const { pi, state } = fakePi();
	installRowRenderers(pi);
	const drawn = state.resolver!("todo", todoBase);
	expect(drawn.renderShell).toBe("self");
	expect(drawn.renderCall({ subject: "Fix" }, {}, { isPartial: true }).text).toBe("todo → Fix");
});

test("a finished todo call draws nothing, and its result draws the call and status on one line", () => {
	const { pi, state } = fakePi();
	installRowRenderers(pi);
	const drawn = state.resolver!("todo", todoBase);
	expect(drawn.renderCall({ subject: "Fix" }, {}, { isPartial: false }).render(40)).toEqual([]);
	const row = drawn.renderResult({ content: [], details: {} }, {}, {}, { args: { subject: "Fix" }, isPartial: false });
	expect(row.text).toBe("todo → Fix  ● completed");
});

test("a tool with no renderer from anyone gets the generic row", () => {
	const { pi, state } = fakePi();
	installRowRenderers(pi);
	const drawn = state.resolver!("todo", () => undefined);
	expect(drawn.renderShell).toBe("self");
	expect(typeof drawn.renderCall).toBe("function");
	expect(typeof drawn.renderResult).toBe("function");
});

test("fff's search tools keep their names and get our row shell", () => {
	const { pi, state } = fakePi();
	installRowRenderers(pi);
	const drawn = state.resolver!("ffgrep", foreign);
	expect(drawn.renderShell).toBe("self");
	expect(drawn.renderCall).not.toBe(foreign().renderCall);
});

test("Pi without a renderer seam registers nothing and does not throw", () => {
	const pi = { registerTool: () => {} } as unknown as ExtensionAPI;
	expect(() => installRowRenderers(pi)).not.toThrow();
});
