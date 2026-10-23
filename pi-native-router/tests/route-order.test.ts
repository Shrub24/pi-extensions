import { expect, test } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { orderEditor, type OrderItem } from "../src/route-order";

test("editor moves the highlighted candidate, toggles its automatic eligibility, applies or cancels a draft", () => {
  const original = [{ target: "a/模型#one", enabled: true }, { target: "b/model#two", enabled: true }];
  let applied: OrderItem[] | undefined;
  const editor = orderEditor(original, value => { applied = value; }, () => {});
  editor.handleInput("\x1b[B"); // down
  editor.handleInput("\x1b[1;2A"); // shift up
  editor.handleInput(" ");
  expect(editor.render(12).every(line => visibleWidth(line) <= 12)).toBe(true);
  editor.handleInput("\r");
  expect(applied).toEqual([{ target: "b/model#two", enabled: false }, { target: "a/模型#one", enabled: true }]);
  expect(original.every(item => item.enabled)).toBe(true);
  const cancelled = orderEditor(original, value => { applied = value; }, () => {});
  cancelled.handleInput("\x1b[1;2B");
  cancelled.handleInput("\x1b[A");
  cancelled.handleInput("\x1b");
  expect(applied).toBeUndefined();
});
