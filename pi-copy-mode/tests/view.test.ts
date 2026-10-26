import { describe, expect, test } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { CopyModeView, type CopyResult } from "../extensions/view.js";

const LINES = Array.from({ length: 30 }, (_, index) => `line ${index + 1} with **markdown** and a long tail that keeps going`);

function harness(overrides: { copy?: (text: string) => Promise<void>; lines?: string[]; viewportRows?: number } = {}) {
	const copied: string[] = [];
	const results: (CopyResult | undefined)[] = [];
	let renders = 0;
	const view = new CopyModeView({
		title: "Copy mode",
		lines: overrides.lines ?? LINES,
		viewportRows: overrides.viewportRows ?? 5,
		copy:
			overrides.copy ??
			(async (text) => {
				copied.push(text);
			}),
		done: (result) => results.push(result),
		requestRender: () => {
			renders++;
		},
	});
	const press = (keys: string[]) => {
		for (const key of keys) view.handleInput(key);
	};
	return { view, copied, results, press, renders: () => renders };
}

const rowsOf = (view: CopyModeView, width = 60) => view.render(width);
const rowIndex = (rows: string[], needle: string) => rows.findIndex((row) => row.includes(needle));

describe("CopyModeView keys", () => {
	test("j and k move the cursor and clamp at the ends", () => {
		const { view, press } = harness();
		press(["k"]);
		expect(rowIndex(rowsOf(view), "line 1 ")).toBeGreaterThanOrEqual(0);
		press(["j", "j"]);
		expect(rowIndex(rowsOf(view), "›")).toBeGreaterThanOrEqual(0);
		expect(rowsOf(view).some((row) => row.includes("line 3 "))).toBe(true);
	});

	test("arrow keys behave like j and k", () => {
		const { view, press } = harness();
		press(["\x1b[B", "\x1b[B"]);
		expect(view.render(60).find((row) => row.startsWith("›"))).toContain("line 3 ");
		press(["\x1b[A"]);
		expect(view.render(60).find((row) => row.startsWith("›"))).toContain("line 2 ");
	});

	test("g and G jump to the first and last source lines", () => {
		const { view, press } = harness();
		press(["G"]);
		expect(view.render(60).at(-1)).toContain("line 30/30");
		press(["g"]);
		expect(view.render(60).at(-1)).toContain("line 1/30");
	});

	test("paging moves by the viewport height", () => {
		const { view, press } = harness({ viewportRows: 5 });
		press(["\x1b[6~"]);
		expect(view.render(60).at(-1)).toContain("line 6/30");
		press(["\x1b[5~"]);
		expect(view.render(60).at(-1)).toContain("line 1/30");
	});

	test("v marks the start, and a second v clears the mark", () => {
		const { view, press } = harness();
		press(["j", "j", "v"]);
		expect(view.render(60)[0]).toContain("1 marked");
		press(["j"]);
		expect(view.render(60)[0]).toContain("2 marked");
		press(["v"]);
		expect(view.render(60)[0]).toContain("no mark");
	});

	test("Enter copies the marked range through the injected copy function and closes", async () => {
		const { press, copied, results } = harness();
		press(["j", "v", "j", "j", "\r"]);
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(copied).toEqual([`${LINES[1]}\n${LINES[2]}\n${LINES[3]}`]);
		expect(results).toEqual([{ copied: 3 }]);
	});

	test("y without a mark copies only the current source line", async () => {
		const { press, copied, results } = harness();
		press(["j", "j", "y"]);
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(copied).toEqual([LINES[2]]);
		expect(results).toEqual([{ copied: 1 }]);
	});

	test("Esc and q cancel without copying", async () => {
		const first = harness();
		first.press(["\x1b"]);
		const second = harness();
		second.press(["q"]);
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(first.copied).toEqual([]);
		expect(first.results).toEqual([undefined]);
		expect(second.copied).toEqual([]);
		expect(second.results).toEqual([undefined]);
	});

	test("a failed copy keeps the view open with the reason and closes on retry", async () => {
		let attempts = 0;
		const { view, press, results } = harness({
			copy: async () => {
				attempts++;
				if (attempts === 1) throw new Error("no clipboard backend");
			},
		});
		press(["\r"]);
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(results).toEqual([]);
		expect(view.render(60).at(-1)).toContain("Copy failed: no clipboard backend");
		press(["\r"]);
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(results).toEqual([{ copied: 1 }]);
	});

	test("ignores keys after the view has closed", () => {
		const { press, results } = harness();
		press(["q", "j", "\r"]);
		expect(results).toEqual([undefined]);
	});
});

describe("CopyModeView rendering", () => {
	test("every rendered row fits the requested width, including long source lines", () => {
		const { view } = harness({ viewportRows: 6 });
		for (const width of [20, 40, 80]) {
			for (const row of view.render(width)) expect(visibleWidth(row)).toBeLessThanOrEqual(width);
		}
	});

	test("the cursor row stays inside the viewport while scrolling", () => {
		const { view, press } = harness({ viewportRows: 5 });
		press(["G"]);
		const rows = view.render(60);
		expect(rows.some((row) => row.startsWith("›") && row.includes("line 30 "))).toBe(true);
		expect(rows.some((row) => row.includes("line 1 "))).toBe(false);
	});

	test("a long source line wraps so its full text stays readable", () => {
		const long = "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda final-word";
		const { view } = harness({ lines: [long], viewportRows: 10 });
		const rows = view.render(30).join("\n");
		for (const word of ["alpha", "lambda", "final-word"]) expect(rows).toContain(word);
	});

	test("a wrapped line counts as several display rows when scrolling", () => {
		const wrapped = "word ".repeat(30).trim();
		const { view, press } = harness({ lines: [wrapped, "one", "two"], viewportRows: 4 });
		expect(view.render(30).some((row) => row.includes("word"))).toBe(true);
		press(["j"]);
		const rows = view.render(30);
		expect(rows.some((row) => row.startsWith("›") && row.includes("one"))).toBe(true);
		expect(rows.some((row) => row.includes("word"))).toBe(false);
	});

	test("the view shows raw source, not rendered markdown", () => {
		const { view } = harness({ lines: ["## Title", "Body **bold**"] });
		const rows = view.render(60).join("\n");
		expect(rows).toContain("## Title");
		expect(rows).toContain("**bold**");
	});

	test("tabs are expanded for display only", async () => {
		const copied: string[] = [];
		const view = new CopyModeView({
			title: "t",
			lines: ["a\tb"],
			copy: async (text) => {
				copied.push(text);
			},
			done: () => {},
			requestRender: () => {},
		});
		expect(view.render(40).join("\n")).toContain("a    b");
		view.handleInput("y");
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(copied).toEqual(["a\tb"]);
	});
});
