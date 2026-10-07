import { expect, test } from "bun:test";
import { TOOL_PREVIEW_LINES } from "../extensions/constants.js";
import { runSpawnFixture, SPAWN_FIXTURE_TIMEOUT_MS } from "./fixtures/spawn-child-runner.js";

interface FallbackResult {
	bashRegistered: boolean;
	presentationImportError?: string;
	call: string[];
	blockedBeforeExecution: string[];
	denied: string[];
	successCollapsed: string[];
	successExpanded: string[];
}

// The `bash` tool declares `renderShell: "self"`, so a renderer that returns
// nothing removes the row instead of deferring to Pi. When the optional
// presentation module is missing, the degradation has to cost the rich row and
// not the row: the command and its result stay visible.
function runFallback(): FallbackResult {
	return runSpawnFixture("managed-bash-fallback.ts", {}) as FallbackResult;
}

test("a missing presentation module costs the rich row, not the row", () => {
	const result = runFallback();
	expect(result.presentationImportError, "the fixture must be the missing-module path").toContain("Cannot find package '@vanillagreen/pi-tool-renderer/managed-bash'");
	expect(result.bashRegistered).toBe(true);

	const call = result.call.join("\n");
	expect(call, "the command is visible while the call is pending").toContain("nix build .#pi-bolt --no-link --print-out-paths");
	expect(result.call.length).toBe(1);

	// A call refused before execution has no task and no output: the row is the
	// command and Pi's own verdict.
	const blocked = result.blockedBeforeExecution.join("\n");
	expect(blocked, "a blocked call still shows what was asked for").toContain("nix build .#pi-bolt --no-link --print-out-paths");
	expect(blocked, "a refusal does not read as a success").toContain("failed");

	const denied = result.denied.join("\n");
	expect(denied, "the refusal itself is the useful text, and it survives").toContain("Permission denied: bash requires approval for this command");
	expect(denied).toContain("nix build .#pi-bolt --no-link --print-out-paths");
});

test("the fallback bounds collapsed output and expands to more", () => {
	const result = runFallback();
	const collapsed = result.successCollapsed;
	const expanded = result.successExpanded;
	expect(collapsed.length, "collapsed output is bounded: header, marker, and the preview window").toBeLessThanOrEqual(TOOL_PREVIEW_LINES + 2);
	expect(collapsed.join("\n"), "the newest output is the useful end of a success").toContain("out-line-199");
	expect(collapsed.join("\n"), "collapsed is a window, not the capture").not.toContain("out-line-0");
	expect(expanded.length, "expansion shows more of the result").toBeGreaterThan(collapsed.length);
	expect(expanded.join("\n")).toContain("out-line-199");
	// A failure leads with its reason, so its window is the head of the text.
	expect(result.denied.join("\n"), "a failed result keeps its first line").toContain("Permission denied");
}, SPAWN_FIXTURE_TIMEOUT_MS);
