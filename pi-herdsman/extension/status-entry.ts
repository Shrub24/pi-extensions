/**
 * The footer entries a controller or managed session publishes through
 * `ctx.ui.setStatus`: one state glyph, and a separate work-count entry.
 *
 * States are checked in priority order: a blocking dialog, questionnaire or
 * permission prompt; an agent turn in progress; outstanding work; then idle.
 * Glyphs are Nerd Font codepoints from the Nerd Fonts glyph table
 * (blink-nerdfont.nvim, items.lua).
 */
export interface StatusEntryFacts {
  blocked: boolean;
  running: boolean;
  /** `undefined` when this session cannot observe its own background work. */
  backgroundTasks: number | undefined;
  /** `undefined` when the child count is unknown: it neither shows nor claims waiting. */
  subagents: number | undefined;
}

const GLYPH = {
  blocked: "\u{F02D7}", // nf-md-help_circle
  running: "\u{F04E6}", // nf-md-sync
  waiting: "\u{F051F}", // nf-md-timer_sand
  idle: "\u{F04B2}", // nf-md-sleep
  backgroundTasks: "\u{F018D}", // nf-md-console
  subagents: "\u{F06A9}", // nf-md-robot
} as const;

export const STATUS_ENTRY_KEY = "pi-herdsman";
export const WORK_ENTRY_KEY = "pi-herdsman-waiting";

export function statusEntryText(facts: StatusEntryFacts): string {
  if (facts.blocked) return GLYPH.blocked;
  if (facts.running) return GLYPH.running;
  if ((facts.backgroundTasks ?? 0) > 0 || (facts.subagents ?? 0) > 0)
    return GLYPH.waiting;
  return GLYPH.idle;
}

/** The counts of outstanding work, or `undefined` when there is none to show. */
export function workEntryText(facts: StatusEntryFacts): string | undefined {
  const counts: string[] = [];
  if ((facts.backgroundTasks ?? 0) > 0)
    counts.push(`${GLYPH.backgroundTasks} ${facts.backgroundTasks}`);
  if ((facts.subagents ?? 0) > 0)
    counts.push(`${GLYPH.subagents} ${facts.subagents}`);
  return counts.length > 0 ? counts.join("  ") : undefined;
}

/**
 * Publishes each entry only when its text changes, so an unchanged tick writes
 * nothing; clearing forgets the published text so the next publish writes again.
 */
export function createStatusEntries(
  setStatus: (key: string, text: string | undefined) => void,
): {
  publish(facts: StatusEntryFacts): void;
  clear(): void;
} {
  const published = new Map<string, string | undefined>();
  const set = (key: string, text: string | undefined): void => {
    if (published.get(key) === text) return;
    published.set(key, text);
    setStatus(key, text);
  };
  return {
    publish(facts) {
      set(STATUS_ENTRY_KEY, statusEntryText(facts));
      set(WORK_ENTRY_KEY, workEntryText(facts));
    },
    clear() {
      set(STATUS_ENTRY_KEY, undefined);
      set(WORK_ENTRY_KEY, undefined);
    },
  };
}
