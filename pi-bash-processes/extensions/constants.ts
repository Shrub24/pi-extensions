export const BG_COMMAND = "bg";
export const DEFAULT_BACKGROUND_BASH_SHORTCUT = "alt+.";
export const DEFAULT_BG_SHORTCUT = "alt+shift+h";
export const DEFAULT_WIDGET_TOGGLE_SHORTCUT = "alt+h";
export const CONFIG_ID = "@vanillagreen/pi-background-tasks";
export const BG_MESSAGE_TYPE = "kendex-background-tasks:event";
export const BG_STATE_TYPE = "kendex-background-tasks:state";
export const BG_WIDGET_KEY = "kendex-background-tasks";
export const BG_INSTALL_SYMBOL = Symbol.for("kendex.background-tasks.installed");
export const MANAGED_BASH_SYMBOL = Symbol.for("kendex.background-tasks.managed-bash");
export const KENDEX_MODAL_LOCK_SYMBOL = Symbol.for("kendex.pi.modal-lock");

// Nerd Font glyphs (Font Awesome subset). Status icons use these instead of
// unicode dingbats so chat output renders consistently regardless of any
// emoji-presentation fallback in the user's font stack.
export const ICONS = {
	check: "\uf00c", // nf-fa-check
	times: "\uf00d", // nf-fa-times
} as const;

export const DEFAULT_TIMEOUT_MS = 0;
// Soft progress reminder before a background task asks the agent to choose
// whether to continue, inspect, or stop. This never kills the process.
export const DEFAULT_SOFT_TIMEOUT_MS = 10 * 60 * 1_000;
// Soft wait before the model-facing bash tool yields a Running result. The
// command keeps running under the manager; this never kills the process.
export const DEFAULT_FOREGROUND_YIELD_MS = 20_000;
export const DEFAULT_OUTPUT_SETTLE_MS = 1_500;
export const DEFAULT_FORCE_KILL_GRACE_MS = 5_000;
export const DEFAULT_OUTPUT_BUFFER_MAX_CHARS = 1_000_000;
// Inline tail bytes attached to each wake message. Wakes are delivered as
// custom steer messages (pi.sendMessage), which bypass pi-output-policy, so
// the cap directly bounds how much of the transcript a single output wake
// adds. 2KB keeps a wake payload comfortably under 4KB total even with task
// metadata and matched pattern. Users with high-signal monitors
// can raise outputAlertMaxChars for verbose inline tails.
export const DEFAULT_OUTPUT_ALERT_MAX_CHARS = 2_000;
// Dashboard / log-action tail. The full log is always available on disk and
// referenced via logFile in the tool result, so the inline tail only needs to
// give a quick excerpt. 10KB stays well below pi-output-policy's spill
// threshold so repeated log inspections cannot grow the transcript.
export const DEFAULT_LOG_TAIL_MAX_CHARS = 10_000;

// Foreground bash streams its bounded tail at this cadence. Slow enough to
// avoid rerender storms, fast enough to look live.
export const MANAGED_BASH_PARTIAL_UPDATE_MS = 400;
export const DEFAULT_FORCED_BACKGROUND_WINDOW_MS = 5 * 60 * 1_000;
export const DEFAULT_WIDGET_FINISHED_RETENTION_MS = 15_000;
// Per-task output-wake budget. Once a task hits either the wake-count cap or
// the cumulative-inline-bytes cap, further output wakes are suppressed and a
// single concise "wake budget exhausted; inspect log" notice is emitted. Exit
// wakes are unaffected. Set either value to 0 to disable that arm of the
// guard.
export const DEFAULT_OUTPUT_WAKE_BUDGET_MAX_WAKES = 20;
export const DEFAULT_OUTPUT_WAKE_BUDGET_MAX_BYTES = 20_000;

// The viewer is the only way to read a long-running task's output, so it takes
// most of the terminal: width is computed from the terminal at open time
// (see dashboardWidthFor) and height is a fraction of the viewport.
export const DASHBOARD_WIDTH = 96;
export const DASHBOARD_MIN_WIDTH = 96;
export const DASHBOARD_MAX_WIDTH = 200;
export const DASHBOARD_WIDTH_FRACTION = 0.92;
export const DASHBOARD_MAX_HEIGHT = "92%";
/** Fraction of the viewport height the viewer frame may occupy. */
export const DASHBOARD_HEIGHT_FRACTION = 0.92;
export const DASHBOARD_PADDING_X = 2;
export const DASHBOARD_PADDING_Y = 1;
export const DASHBOARD_MIN_FRAME_ROWS = 18;
export const DASHBOARD_FRAME_VERTICAL_OVERHEAD = 2 + DASHBOARD_PADDING_Y * 2;
export const TASK_PANE_MIN_WIDTH = 30;
export const TASK_PANE_MAX_WIDTH = 64;
export const WIDGET_PADDING_X = 1;
export const TOOL_PREVIEW_TASKS = 3;
export const TOOL_PREVIEW_LINES = 12;
export const WIDGET_COMPACT_TASKS = 3;

const ANSI_GREEN_FG = "\x1b[32m";
const ANSI_YELLOW_FG = "\x1b[33m";
const ANSI_FG_RESET = "\x1b[39m";

export function ansiGreen(text: string): string {
	return `${ANSI_GREEN_FG}${text}${ANSI_FG_RESET}`;
}

export function ansiYellow(text: string): string {
	return `${ANSI_YELLOW_FG}${text}${ANSI_FG_RESET}`;
}

export function clamp(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, value));
}
