import assert from "node:assert/strict";
import test from "node:test";
import {
  createStatusEntries,
  statusEntryText,
  workEntryText,
} from "./status-entry.ts";

// Nerd Fonts codepoints as checked against blink-nerdfont.nvim items.lua.
const blocked = "\u{F02D7}";
const running = "\u{F04E6}";
const waiting = "\u{F051F}";
const idle = "\u{F04B2}";
const terminal = "\u{F018D}";
const robot = "\u{F06A9}";

const none = {
  blocked: false,
  running: false,
  backgroundTasks: 0,
  subagents: 0,
};

test("blocked outranks running, waiting and idle", () => {
  assert.equal(
    statusEntryText({ ...none, blocked: true, running: true, backgroundTasks: 1, subagents: 1 }),
    blocked,
  );
});

test("running outranks waiting, and idle needs nothing outstanding", () => {
  assert.equal(statusEntryText({ ...none, running: true, subagents: 1 }), running);
  assert.equal(statusEntryText(none), idle);
});

test("waiting follows outstanding background work or subagents, not unknown background work", () => {
  assert.equal(statusEntryText({ ...none, backgroundTasks: 2 }), waiting);
  assert.equal(statusEntryText({ ...none, subagents: 1 }), waiting);
  assert.equal(statusEntryText({ ...none, backgroundTasks: undefined }), idle);
});

test("an unknown child count neither shows as zero nor claims waiting", () => {
  const unknownChildren = { ...none, subagents: undefined };
  assert.equal(statusEntryText({ ...unknownChildren, backgroundTasks: 1 }), waiting);
  assert.equal(statusEntryText(unknownChildren), idle);
  assert.equal(workEntryText({ ...unknownChildren, backgroundTasks: 1 }), `${terminal} 1`);
  assert.equal(workEntryText(unknownChildren), undefined);
});

test("the work entry shows only nonzero known counts, each with its own glyph", () => {
  assert.equal(
    workEntryText({ ...none, backgroundTasks: 2, subagents: 1 }),
    `${terminal} 2  ${robot} 1`,
  );
  assert.equal(workEntryText({ ...none, subagents: 1 }), `${robot} 1`);
  assert.equal(workEntryText({ ...none, backgroundTasks: 3 }), `${terminal} 3`);
  assert.equal(workEntryText({ ...none, backgroundTasks: undefined }), undefined);
  assert.equal(workEntryText(none), undefined);
});

test("entries publish only when their text changes and clear once", () => {
  const published: Array<[string, string | undefined]> = [];
  const entries = createStatusEntries((key, text) => published.push([key, text]));
  entries.publish({ ...none, running: true });
  entries.publish({ ...none, running: true });
  entries.publish({ ...none, backgroundTasks: 1 });
  entries.clear();
  entries.clear();
  assert.deepEqual(published, [
    ["pi-herdsman", running],
    ["pi-herdsman", waiting],
    ["pi-herdsman-waiting", `${terminal} 1`],
    ["pi-herdsman", undefined],
    ["pi-herdsman-waiting", undefined],
  ]);
});
