// The edit renderer replaces Pi's edit tool definition. Pi's agent loop runs a
// definition's prepareArguments hook before schema validation, so the
// replacement must carry the original hook or the argument shapes Pi's own
// tool accepts (legacy oldText/newText, a single edit object) fail validation
// with the renderer active.

import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as agent from "@earendil-works/pi-coding-agent";

import { registerEdit } from "../tool-renderer/tools.js";

interface CapturedDef {
	name: string;
	prepareArguments?: (args: unknown) => unknown;
}

function registeredEdit(): CapturedDef {
	const tools: CapturedDef[] = [];
	const cwd = mkdtempSync(join(tmpdir(), "edit-prepare-"));
	registerEdit({ registerTool: (def: CapturedDef) => tools.push(def) } as any, agent, cwd);
	expect(tools.length).toBe(1);
	return tools[0]!;
}

test("registered edit definition forwards Pi's prepareArguments hook", () => {
	const def = registeredEdit();
	const original = agent.createEditTool(process.cwd()) as unknown as CapturedDef;
	expect(typeof original.prepareArguments).toBe("function");
	// The intent wrapper wraps Pi's shim: legacy args are normalized by Pi's
	// hook after the intent arg is stripped, so identity is not preserved but
	// behavior is. Verify the original hook still runs through the wrapper.
	expect(typeof def.prepareArguments).toBe("function");
	const legacy = { oldText: "a", newText: "b" };
	const prepared = (def.prepareArguments as (args: unknown) => unknown)({ path: "/tmp/x", ...legacy });
	expect(prepared).toEqual(original.prepareArguments({ path: "/tmp/x", oldText: "a", newText: "b" }));
});

test("legacy oldText/newText input is normalized before validation through the registered definition", () => {
	const def = registeredEdit();
	const prepared = def.prepareArguments!({ newText: "b", oldText: "a", path: "f.txt" }) as { edits?: unknown; path?: string };
	expect(prepared.path).toBe("f.txt");
	expect(prepared.edits).toEqual([{ newText: "b", oldText: "a" }]);
});
