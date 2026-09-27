import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { stripAnsi } from "../tool-renderer/ansi.js";
import { recordProjectTrust } from "../tool-renderer/settings.js";
import { readCallText, readOnlyCallText, renderToolPathText } from "../tool-renderer/text.js";

const theme = {
	bold(text: string) {
		return `\x1b[1m${text}\x1b[22m`;
	},
	fg(_token: string, text: string) {
		return `\x1b[36m${text}\x1b[39m`;
	},
};

describe("file path hyperlinks", () => {
	test("renderToolPathText wraps paths in OSC 8 file links when supported", () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-tool-renderer-links-"));
		const rendered = renderToolPathText("src/main.ts", theme, cwd, undefined, true);
		const href = pathToFileURL(resolve(cwd, "src/main.ts")).href;

		expect(rendered).toContain(`\x1b]8;;${href}`);
		expect(stripAnsi(rendered)).toBe("src/main.ts");
	});

	test("renderToolPathText leaves plain styled paths when hyperlinks are unsupported", () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-tool-renderer-links-"));
		const rendered = renderToolPathText("src/main.ts", theme, cwd, undefined, false);

		expect(rendered).not.toContain("\x1b]8;;");
		expect(stripAnsi(rendered)).toBe("src/main.ts");
	});

	test("fileHyperlinks=off disables detected terminal hyperlinks", () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-tool-renderer-links-"));
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({
			kendex: { extensionManager: { config: { "@vanillagreen/pi-tool-renderer": { fileHyperlinks: "off" } } } },
		}));
		recordProjectTrust({ cwd, isProjectTrusted: () => true });

		const rendered = renderToolPathText("src/main.ts", theme, cwd);
		expect(rendered).not.toContain("\x1b]8;;");
		expect(stripAnsi(rendered)).toBe("src/main.ts");
	});

	test("readCallText links only the file path, keeping line range outside href", () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-tool-renderer-links-"));
		const rendered = readCallText({ path: "README.md", offset: 2, limit: 3 }, theme, cwd, true);
		const href = pathToFileURL(resolve(cwd, "README.md")).href;

		expect(rendered).toContain(`\x1b]8;;${href}`);
		expect(stripAnsi(rendered)).toContain("Read README.md:2-4");
	});

	test("ls call text links its target path", () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-tool-renderer-links-"));
		const rendered = readOnlyCallText("ls", { path: "pi-extensions" }, theme, cwd, true);
		const href = pathToFileURL(resolve(cwd, "pi-extensions")).href;

		expect(rendered).toContain(`\x1b]8;;${href}`);
		expect(stripAnsi(rendered)).toContain("ls pi-extensions");
	});
});
