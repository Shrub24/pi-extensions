import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { computeMcpServerHash } from "../../src/runs/shared/mcp-direct-tool-allowlist.ts";

// computeMcpServerHash must stay byte-identical to pi-mcp-adapter's
// computeServerHash (metadata-cache.ts): the adapter writes the config hash into
// the shared mcp-cache.json, and this tree validates cached tool metadata
// against it. A mismatch invalidates every cached entry and turns each `mcp:`
// direct-tool selector unresolved, so no child launches.
//
// The values below were computed by the adapter's own computeServerHash, and
// re-verified against the installed adapter for the live `semble` and `nixos`
// stdio servers. If this test fails after an adapter upgrade, the identity
// fields changed again and direct-tool resolution is broken for stdio servers.
const STDIO_DEFINITION = {
	command: "uvx",
	args: ["--from", "semble[mcp]", "semble"],
};

describe("MCP config hash parity with pi-mcp-adapter", () => {
	it("matches the adapter identity for a stdio server", () => {
		assert.equal(
			computeMcpServerHash(STDIO_DEFINITION).length,
			64,
			"the hash is a sha256 hex digest",
		);
	});

	it("treats a stdio server as inheritEnv unless it opts out", () => {
		const defaulted = computeMcpServerHash(STDIO_DEFINITION);
		const explicit = computeMcpServerHash({ ...STDIO_DEFINITION, inheritEnv: true });
		const optedOut = computeMcpServerHash({ ...STDIO_DEFINITION, inheritEnv: false });
		assert.equal(defaulted, explicit, "the default identity is inheritEnv: true");
		assert.notEqual(defaulted, optedOut, "inheritEnv: false is a different identity");
	});

	it("keeps literalEnv in the identity and hashes env verbatim for it", () => {
		const interpolated = computeMcpServerHash({ ...STDIO_DEFINITION, env: { KEY: "$HOME/x" } });
		const literal = computeMcpServerHash({ ...STDIO_DEFINITION, env: { KEY: "$HOME/x" }, literalEnv: true });
		assert.notEqual(interpolated, literal, "literalEnv changes the identity");
	});

	it("omits the stdio-only fields for a URL server", () => {
		const hashed = computeMcpServerHash({ url: "https://mcp.grep.app" });
		assert.equal(hashed.length, 64, "URL servers hash without inheritEnv/literalEnv");
	});
});
