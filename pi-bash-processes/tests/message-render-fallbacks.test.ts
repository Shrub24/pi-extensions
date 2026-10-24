import { expect, test } from "bun:test";

import { renderBgToolResult, renderTaskEventMessage } from "../extensions/render.js";

const theme = {
	bold: (text: string) => `**${text}**`,
	fg: (token: string, text: string) => `<${token}>${text}</${token}>`,
} as never;

const task = {
	command: "npm test",
	cwd: "/repo",
	exitCode: null,
	id: "bg-68",
	pid: 4242,
	softTimeoutMs: 600_000,
	startedAt: 1_000,
	status: "running",
	title: "tests",
	updatedAt: 2_000,
} as any;

test("bg_task extend result uses the generic styled tool-result renderer", () => {
	const result = {
		content: [{ type: "text", text: "Soft reminder for bg-68 extended: it will ask again in 10m. Hard timeout is unchanged." }],
		details: { action: "extend", task },
	};
	const rendered = renderBgToolResult(result, {}, theme, { args: { action: "extend", id: "bg-68" }, cwd: "/repo" }).render(120).join("\n");
	const plain = rendered.replace(/\n/g, " ");
	expect(plain).toContain("Soft reminder extended");
	expect(plain).toContain("<accent>bg-68</accent>");
	expect(plain).toContain("next reminder in 10m");
	expect(plain).toContain("hard timeout unchanged");
	expect(plain).not.toContain("<dim>Soft reminder for bg-68 extended");
});

test("unknown background event messages use themed generic chrome", () => {
	const rendered = renderTaskEventMessage({
		content: "Background task bg-68 output wake budget exhausted.\nInspect it with bg_task action:get id: bg-68.",
		details: { eventType: "output-budget-exhausted", task },
	}, false, theme).render(120).join("\n");
	expect(rendered).toContain("<toolTitle>**Background task output limit reached**</toolTitle>");
	expect(rendered).toContain("<dim>Background task bg-68 output wake budget exhausted.</dim>");
	expect(rendered).toContain("<borderMuted>");
});

test("grouped completion notices that lack a specialized shape still get generic styled chrome", () => {
	const rendered = renderTaskEventMessage({
		content: "Background tasks finished:\n• bg-68 · exit 0",
		details: { grouped: true, tasks: [task] },
	}, false, theme).render(120).join("\n");
	expect(rendered).toContain("<toolTitle>**Background task update**</toolTitle>");
	expect(rendered).toContain("<dim>Background tasks finished:</dim>");
	expect(rendered).toContain("<borderMuted>");
});
