import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve, sep } from "node:path";
import { homedir, tmpdir } from "node:os";
import { EventEmitter } from "node:events";
import { after, mock, test } from "node:test";
import { Value } from "typebox/value";
import type {
  AskRecord,
  RequestRecord,
  ResultRecord,
  ManagedAgentState,
} from "./mailbox.ts";
import {
  DELEGATION_BRIEF_EXAMPLES,
  parseDelegationBrief,
  type BriefProfile,
} from "./briefs.ts";
import {
  radarObservesCompleted,
  radarObservesStarted,
  spawnedArgvs,
  spawnedEnvironmentAssignments,
  spawnedLabels,
  FIXTURE_LEAD_PANE,
  FIXTURE_TMUX_ENV,
  FIXTURE_TMUX_SERVER,
  startFakeRadarDaemon,
} from "./support-radar.ts";

export { spawnedArgvs, spawnedEnvironmentAssignments, spawnedLabels };
import { radarProcessSlot } from "./radar-publication.ts";
import { herdsmanDataRoot } from "./storage.ts";
import { DEFAULT_RESPONSE_CONTRACT } from "./response-contracts.ts";
import { claimProcessLock } from "./lock.ts";
import { OperationError } from "./errors.ts";
import { herdsmanTempRoot } from "./storage.ts";

export const watchedResultPaths = new Map<string, Function>();
export const projectContextCwds: string[] = [];
export const nativeSessions = new Map<
  string,
  {
    id: string;
    path: string;
    entries?: unknown[];
    contextEntries?: unknown[];
    cwd?: string;
    sessionName?: string;
  }
>();
export let sessionOpenError: unknown;
export let failNextMailboxWrite = false;
export let failNextRequestRemoval = false;
export let failNextResultRemoval = false;
export let resultRemovalAttempts = 0;
export let agentDefinitionReadCount = 0;
// Saved-session listing must not reopen a child session body; recording every
// open path keeps that check attributable to the read it forbids.
export const openedSessionPaths: string[] = [];
export let configReadHook: (() => void) | undefined;
export let agentStateReadHook: ((path: string) => void) | undefined;

export type WidgetComponent = {
  render(width: number): string[];
  invalidate(): void;
};
export type WidgetContent =
  | undefined
  | string[]
  | ((tui: { requestRender(): void }, theme: unknown) => WidgetComponent);

function assertWidgetContent(content: unknown): void {
  if (content === undefined) return;
  if (Array.isArray(content)) {
    assert.ok(content.every((line) => typeof line === "string"));
    return;
  }
  assert.equal(typeof content, "function", "invalid widget content");
  const component = (
    content as (
      tui: { requestRender(): void },
      theme: unknown,
    ) => WidgetComponent
  )(
    { requestRender: () => undefined },
    { fg: (_color: string, text: string) => text },
  );
  assert.equal(typeof component?.render, "function");
  assert.equal(typeof component?.invalidate, "function");
  assert.ok(Array.isArray(component.render(80)));
  component.invalidate();
}
export const realFs = await import("node:fs");
export const testTmpRoot = realFs.mkdtempSync(
  join(tmpdir(), "pi-herdsman-test-"),
);
process.env.TMPDIR = testTmpRoot;
const {
  Key: tuiKey,
  fuzzyFilter: tuiFuzzyFilter,
  matchesKey: tuiMatchesKey,
  visibleWidth: tuiVisibleWidth,
} = await import("@earendil-works/pi-tui");
export { tuiVisibleWidth };
export const PI_AGENT_ROOT = realFs.mkdtempSync(
  join(tmpdir(), "pi-herdsman-pi-agent-"),
);
process.env.PI_CODING_AGENT_DIR = PI_AGENT_ROOT;
export const PI_AGENTS_DIR = join(PI_AGENT_ROOT, "agents");
realFs.mkdirSync(PI_AGENTS_DIR);
realFs.writeFileSync(
  join(PI_AGENTS_DIR, "agent.md"),
  "---\nname: agent\n---\nagent instructions\n",
);
const {
  buildContextEntries: nativeBuildContextEntries,
  buildSessionProjection: nativeBuildSessionProjection,
  CURRENT_SESSION_VERSION: nativeCurrentSessionVersion,
  parseFrontmatter: nativeParseFrontmatter,
  parseSessionEntries: nativeParseSessionEntries,
  truncateTail: nativeTruncateTail,
} = await import("@earendil-works/pi-coding-agent");
after(() => realFs.rmSync(testTmpRoot, { recursive: true, force: true }));

/**
 * The Radar control plane every suite runs against. Radar spawn creates panes
 * and child processes, which a test cannot observe directly, so the daemon also
 * performs the child's own share of a launch.
 */
export let radarDaemon = await startFakeRadarDaemon();
radarDaemon.observeInventory = radarObservedFleet;
process.env.RADAR_CONTROL_SOCKET = radarDaemon.socketPath;
after(() => radarDaemon.close());

/**
 * The shared daemon a test dials, replaced when its socket no longer exists.
 *
 * The socket lives in a temporary directory outside this suite's control and
 * does not survive every test in a file, so a test that needs a reachable
 * daemon asks for one instead of trusting the module-load instance.
 */
export async function ensureRadarDaemon(): Promise<void> {
  // This socket is the only one the extension dials. A test that pointed the
  // environment at a daemon of its own would otherwise leave this session
  // registering nowhere, which reads as a process with no Radar registration.
  process.env.RADAR_CONTROL_SOCKET = radarDaemon.socketPath;
  if (realFs.existsSync(radarDaemon.socketPath)) return;
  const {
    onChildStart,
    onChildState,
    onChildRequest,
    onChildAccepted,
    childSession,
  } = radarDaemon;
  const stale = radarDaemon;
  // The replacement keeps the superseded daemon's live settings but starts from
  // that daemon's own creation state: a setting a test changed mid-flight is
  // that test's own and must not become the baseline its own reset restores for
  // every test that follows.
  radarDaemon = await startFakeRadarDaemon(
    stale.options,
    stale.creationOptions(),
  );
  process.env.RADAR_CONTROL_SOCKET = radarDaemon.socketPath;
  Object.assign(radarDaemon, {
    onChildStart,
    onChildState,
    onChildRequest,
    onChildAccepted,
    childSession,
    observeInventory: radarObservedFleet,
  });
  // The superseded daemon is left alone: its socket is already gone, and closing
  // it would end the mailbox consumers and simulated children the test that
  // caused the replacement is still holding.
}


/**
 * The fleet the shared daemon observes for this fixture.
 *
 * A live daemon reports whatever its mux holds: this process's own pane, and one
 * pane per mailbox this session owns, with the managed label, run and session
 * identity the owner recorded. That is what this fixture's daemon answers
 * `mux.observe` with, so a presence decision reads the same canonical rows a real
 * daemon reports. A test that needs a topology of its own - a pane that is
 * absent, a contradiction, or a backend carrying no agent facts - sets
 * `radarDaemon.options.inventory` instead.
 */
/** The daemon qualifies the panes it reports; a mailbox pane is raw `%N`. */
function fixturePaneHandle(pane: string): string {
  return `tmux:${FIXTURE_TMUX_SERVER}:${pane}`;
}

export function radarObservedFleet(): {
  workspaces: unknown[];
  tabs: unknown[];
  panes: unknown[];
  agents: unknown[];
} {
  const workspaces = new Map<string, unknown>();
  const tabs = new Map<string, unknown>();
  const panes: unknown[] = [];
  const agents: unknown[] = [];
  const add = (
    workspaceId: string,
    tabId: string,
    rawPane: string,
    agent?: {
      label?: string;
      run?: string;
      session?: { id?: string };
      status?: string;
    },
  ): void => {
    if (!rawPane) return;
    const paneId = fixturePaneHandle(rawPane);
    workspaces.set(workspaceId, { workspace_id: workspaceId });
    tabs.set(tabId, { tab_id: tabId, workspace_id: workspaceId });
    panes.push({
      location: { workspace_id: workspaceId, tab_id: tabId, pane_id: paneId },
    });
    if (!agent) return;
    agents.push({
      location: { workspace_id: workspaceId, tab_id: tabId, pane_id: paneId },
      ...(agent.status !== undefined ? { status: agent.status } : {}),
      ...(agent.label !== undefined || agent.run !== undefined
        ? {
            facts: {
              ...(agent.label !== undefined ? { label: agent.label } : {}),
              ...(agent.run !== undefined ? { run: agent.run } : {}),
            },
          }
        : {}),
      ...(agent.session?.id !== undefined
        ? { session: { kind: "uuid", value: agent.session.id } }
        : {}),
    });
  };
  const ownPane = process.env.TMUX_PANE?.trim();
  if (ownPane) add(WORKSPACE, `${WORKSPACE}:t1`, ownPane);
  for (const { state } of listAgentStates()) {
    if (state.paneId === ownPane) continue;
    add(state.workspaceId, `${state.agentLabel}-tab`, state.paneId, {
      label: state.agentLabel,
      run: state.runId,
      session: { id: state.piSessionId },
      // A child waiting on background work is not executing a turn; claiming it
      // is working would let the observation overrule the mailbox's projection.
      status:
        state.activeRequestId && !state.backgroundWaiting ? "working" : "idle",
    });
  }
  return {
    workspaces: [...workspaces.values()],
    tabs: [...tabs.values()],
    panes,
    agents,
  };
}

/**
 * Makes the daemon's observation of one child carry the lifecycle status a test
 * sets, as a live backend reports it. The fleet otherwise derives status from the
 * mailbox alone. An unrecognised word is the contract's `other` variant.
 */
export function observeRowStatus(
  label: string,
  status: string | { other: string } | undefined,
): void {
  radarDaemon.observeInventory = () => {
    const fleet = radarObservedFleet();
    return {
      ...fleet,
      agents: fleet.agents.map((row: any) =>
        row.facts?.label === label ? { ...row, status } : row,
      ),
    };
  };
}

export function resetRadarState(): void {
  realFs.rmSync(join(herdsmanDataRoot(), "radar"), {
    recursive: true,
    force: true,
  });
  const slot = radarProcessSlot();
  slot.publications.clear();
  slot.incarnation = undefined;
  radarDaemon.reset();
  radarDaemon.observeInventory = radarObservedFleet;
  radarDaemon.onChildStart = undefined;
  radarDaemon.onChildState = undefined;
  radarDaemon.onChildRequest = undefined;
  radarDaemon.onChildAccepted = undefined;
  radarDaemon.childSession = undefined;
}
mock.module("node:fs", {
  namedExports: {
    accessSync: realFs.accessSync,
    constants: realFs.constants,
    closeSync: realFs.closeSync,
    chmodSync: realFs.chmodSync,
    existsSync: (path: string) => {
      if (path === join(PI_AGENT_ROOT, "pi-herdsman", "config.json"))
        configReadHook?.();
      return realFs.existsSync(path);
    },
    fstatSync: realFs.fstatSync,
    fsyncSync: realFs.fsyncSync,
    lstatSync: realFs.lstatSync,
    mkdirSync: realFs.mkdirSync,
    openSync: (...args: any[]) => {
      return realFs.openSync(...args);
    },
    readFileSync: (...args: any[]) => {
      if (args[0] === join(PI_AGENT_ROOT, "pi-herdsman", "config.json"))
        configReadHook?.();
      if (
        typeof args[0] === "string" &&
        args[0].startsWith(`${PI_AGENTS_DIR}${sep}`)
      )
        agentDefinitionReadCount++;
      const result = realFs.readFileSync(...args);
      if (typeof args[0] === "string" && args[0].endsWith(`${sep}state.json`))
        agentStateReadHook?.(args[0]);
      return result;
    },
    readSync: (...args: any[]) => {
      return realFs.readSync(...args);
    },
    readdirSync: realFs.readdirSync,
    realpathSync: realFs.realpathSync,
    renameSync: realFs.renameSync,
    rmSync: realFs.rmSync,
    rmdirSync: realFs.rmdirSync,
    statSync: realFs.statSync,
    unlinkSync: (path: string) => {
      const name = basename(path);
      if (failNextRequestRemoval && name.startsWith("request-")) {
        failNextRequestRemoval = false;
        throw new Error("injected request removal failure");
      }
      if (failNextResultRemoval && name.startsWith("result-")) {
        resultRemovalAttempts++;
        failNextResultRemoval = false;
        throw new Error("injected result removal failure");
      }
      if (name.startsWith("result-")) resultRemovalAttempts++;
      return realFs.unlinkSync(path);
    },
    writeFileSync: realFs.writeFileSync,
    writeSync: (...args: any[]) => {
      if (failNextMailboxWrite) {
        failNextMailboxWrite = false;
        throw new Error("injected mailbox state write failure");
      }
      return realFs.writeSync(...args);
    },
    watch: realFs.watch,
    watchFile: (path: string, _options: unknown, listener: Function) => {
      watchedResultPaths.set(path, listener);
    },
    unwatchFile: (path: string, listener: Function) => {
      if (watchedResultPaths.get(path) === listener)
        watchedResultPaths.delete(path);
    },
  },
});

export const {
  controlMarker,
  listAgentStates,
  readPendingAsk,
  readUnacknowledgedRequest,
  readRequest,
  readResult,
  readAgentState,
  removeAsk,
  removeRequest,
  removeResult,
  MAILBOX_PROTOCOL_LIMIT_BYTES,
  resetAgentMailbox,
  agentMailboxPath,
  writeAsk,
  writeRequest: writeMailboxRequest,
  writeResult,
  writeAgentState: writeMailboxAgentState,
} = await import("./mailbox.ts");
const { createAcceptedAssignmentContract } =
  await import("./response-validation.ts");

function fixtureAcceptedAssignment(
  requestId: string,
  profile: BriefProfile = "common",
) {
  return createAcceptedAssignmentContract(
    requestId,
    parseDelegationBrief(DELEGATION_BRIEF_EXAMPLES[profile]),
    DEFAULT_RESPONSE_CONTRACT,
    "/tmp",
    1024 * 1024,
  );
}

export function writeAgentState(
  mailbox: string,
  state: ManagedAgentState,
): void {
  if (
    state.version === 5 &&
    !state.activeRequestId &&
    state.acceptedAssignment
  ) {
    const inactive = { ...state };
    delete inactive.acceptedAssignment;
    state = inactive;
  }
  if (
    state.version === 5 &&
    state.activeRequestId &&
    !state.legacyAcceptedRequestIds?.includes(state.activeRequestId) &&
    (!state.briefProfile ||
      !state.acceptedAssignment ||
      state.acceptedAssignment.requestId !== state.activeRequestId)
  ) {
    const profile =
      state.briefProfile ?? state.acceptedAssignment?.brief.profile ?? "common";
    state = {
      ...state,
      briefProfile: profile,
      acceptedAssignment:
        state.acceptedAssignment?.requestId === state.activeRequestId
          ? state.acceptedAssignment
          : fixtureAcceptedAssignment(state.activeRequestId, profile),
    };
  }
  writeMailboxAgentState(mailbox, state);
}

export function writeRequest(mailbox: string, request: RequestRecord): void {
  if (
    request.version === 5 &&
    (request.kind === "task" || request.kind === "interrupt")
  ) {
    const state = readAgentState(mailbox);
    const acceptedAssignment =
      request.acceptedAssignment ??
      fixtureAcceptedAssignment(
        request.kind === "task"
          ? request.requestId
          : (state?.activeRequestId ??
              state?.completedRequestId ??
              request.requestId),
        state?.briefProfile ?? "common",
      );
    request = {
      ...request,
      acceptedAssignment,
      briefProfile: request.briefProfile ?? acceptedAssignment.brief.profile,
    };
  }
  writeMailboxRequest(mailbox, request);
}

mock.module("@earendil-works/pi-coding-agent", {
  namedExports: {
    DynamicBorder: class {
      private readonly color: (text: string) => string;
      constructor(color = (text: string) => text) {
        this.color = color;
      }
      invalidate() {}
      render(width: number) {
        return [this.color("─".repeat(width))];
      }
    },
    DEFAULT_MAX_BYTES: 50 * 1024,
    DEFAULT_MAX_LINES: 2000,
    formatSize: (n: number) => `${n} B`,
    getMarkdownTheme: () => ({}),
    truncateHead: (
      text: string,
      options: { maxBytes?: number; maxLines?: number },
    ) => {
      const lines = text.split("\n");
      const maxLines = options.maxLines ?? lines.length;
      const content = lines.slice(0, maxLines).join("\n");
      return {
        content,
        truncated: content !== text,
        totalLines: lines.length,
        outputLines: content ? content.split("\n").length : 0,
      };
    },
    truncateTail: nativeTruncateTail,
    truncateLine: (text: string) => ({ text, wasTruncated: false }),
    CONFIG_DIR_NAME: ".pi",
    buildContextEntries: nativeBuildContextEntries,
    buildSessionProjection: nativeBuildSessionProjection,
    CURRENT_SESSION_VERSION: nativeCurrentSessionVersion,
    getAgentDir: () => PI_AGENT_ROOT,
    parseFrontmatter: nativeParseFrontmatter,
    parseSessionEntries: nativeParseSessionEntries,
    loadProjectContextFiles: ({ cwd }: { cwd: string }) => {
      projectContextCwds.push(cwd);
      return [];
    },
    SessionManager: {
      listAll: async () =>
        [...nativeSessions.values()].map((session) => ({
          id: session.id,
          cwd: session.cwd,
        })),
      open: (path: string) => {
        openedSessionPaths.push(path);
        if (sessionOpenError !== undefined) throw sessionOpenError;
        const session = [...nativeSessions.values()].find(
          (item) =>
            item.path === path ||
            (realFs.existsSync(item.path) &&
              realFs.realpathSync(item.path) === path),
        );
        return {
          getSessionId: () => session?.id ?? DEFAULT_PI_SESSION_ID,
          getSessionFile: () => session?.path,
          getHeader: () => (session ? { cwd: session.cwd } : null),
          getCwd: () => resolve(session?.cwd || process.cwd()),
          getSessionName: () => session?.sessionName,
          getEntries: () =>
            session?.entries ?? [
              {
                type: "custom",
                customType: "pi-herdsman-agent-definition",
                data: {
                  sessionId: session?.id ?? DEFAULT_PI_SESSION_ID,
                  definition: "agent",
                  label: "agent",
                },
              },
            ],
          buildContextEntries: () =>
            session?.contextEntries ??
            session?.entries ?? [
              {
                type: "custom",
                customType: "pi-herdsman-agent-definition",
                data: {
                  sessionId: session?.id ?? DEFAULT_PI_SESSION_ID,
                  definition: "agent",
                  label: "agent",
                },
              },
            ],
        };
      },
    },
  },
});
mock.module("@earendil-works/pi-tui", {
  namedExports: {
    Container: class {
      children: any[] = [];
      addChild(child: any) {
        this.children.push(child);
      }
      clear() {
        this.children = [];
      }
      invalidate() {}
      render(width: number) {
        return this.children.flatMap((child) => child.render(width));
      }
    },
    Box: class {
      private readonly children: any[] = [];
      private readonly paddingX: number;
      private readonly paddingY: number;
      private readonly bgFn: (text: string) => string;
      constructor(
        paddingX = 0,
        paddingY = 0,
        bgFn: (text: string) => string = (text) => text,
      ) {
        this.paddingX = paddingX;
        this.paddingY = paddingY;
        this.bgFn = bgFn;
      }
      addChild(child: any) {
        this.children.push(child);
      }
      render(width: number) {
        const innerWidth = Math.max(0, width - this.paddingX * 2);
        const content = this.children.flatMap((child) =>
          child.render(innerWidth),
        );
        const blank = "".padEnd(Math.max(0, innerWidth));
        return [
          ...Array.from({ length: this.paddingY }, () =>
            this.bgFn(blank.padEnd(width)),
          ),
          ...content.map((line: string) =>
            this.bgFn(
              `${"".padEnd(this.paddingX)}${line}${"".padEnd(this.paddingX)}`,
            ),
          ),
          ...Array.from({ length: this.paddingY }, () =>
            this.bgFn(blank.padEnd(width)),
          ),
        ];
      }
    },
    Text: class {
      text: string;
      constructor(text: string) {
        this.text = text;
      }
      render(_width: number) {
        return this.text.split("\n");
      }
    },
    Input: class {
      private value = "";
      focused = false;
      onSubmit?: (value: string) => void;
      onEscape?: () => void;
      getValue() {
        return this.value;
      }
      setValue(value: string) {
        this.value = value;
      }
      handleInput(data: string) {
        if (tuiMatchesKey(data, tuiKey.enter)) this.onSubmit?.(this.value);
        else if (tuiMatchesKey(data, tuiKey.escape)) this.onEscape?.();
        else if (data === "\u007f") this.value = this.value.slice(0, -1);
        else if (data.length === 1 && data >= " ") this.value += data;
      }
      invalidate() {}
      render(_width: number) {
        return [this.value];
      }
    },
    Markdown: class {
      private readonly text: string;
      constructor(text: string) {
        this.text = text;
      }
      invalidate() {}
      render(_width: number) {
        return this.text.split("\n");
      }
    },
    Spacer: class {
      private readonly height: number;
      constructor(height = 1) {
        this.height = height;
      }
      invalidate() {}
      render(_width: number) {
        return Array.from({ length: this.height }, () => "");
      }
    },
    SelectList: class {
      private index = 0;
      private readonly items: any[];
      onSelect?: (item: any) => void;
      onCancel?: () => void;
      onSelectionChange?: (item: any) => void;
      constructor(items: any[]) {
        this.items = items;
      }
      setSelectedIndex(index: number) {
        this.index = Math.max(0, Math.min(index, this.items.length - 1));
      }
      getSelectedItem() {
        return this.items[this.index] ?? null;
      }
      invalidate() {}
      render(_width: number) {
        return this.items.map(
          (item, index) => `${index === this.index ? "→ " : "  "}${item.label}`,
        );
      }
      handleInput(data: string) {
        if (tuiMatchesKey(data, tuiKey.enter))
          this.onSelect?.(this.getSelectedItem());
        else if (tuiMatchesKey(data, tuiKey.escape)) this.onCancel?.();
        else if (tuiMatchesKey(data, tuiKey.down)) {
          this.index = Math.min(this.items.length - 1, this.index + 1);
          this.onSelectionChange?.(this.getSelectedItem());
        } else if (tuiMatchesKey(data, tuiKey.up)) {
          this.index = Math.max(0, this.index - 1);
          this.onSelectionChange?.(this.getSelectedItem());
        }
      }
    },
    fuzzyFilter: tuiFuzzyFilter,
    truncateToWidth: (text: string, width: number) => text.slice(0, width),
    Key: tuiKey,
    matchesKey: tuiMatchesKey,
    visibleWidth: tuiVisibleWidth,
  },
});
mock.module("@earendil-works/pi-ai", {
  namedExports: {
    contentText: (
      content: string | readonly { type: string; text: string }[],
      separator = "\n",
    ) =>
      typeof content === "string"
        ? content
        : content
            .filter((block) => block.type === "text")
            .map((block) => block.text)
            .join(separator),
    StringEnum: (values: readonly string[]) => ({
      type: "string",
      enum: [...values],
    }),
    getSupportedThinkingLevels: (model: { reasoning: boolean }) =>
      model.reasoning ? ["off", "minimal", "low", "medium", "high"] : ["off"],
  },
});
mock.module("typebox", {
  namedExports: {
    Type: {
      Object: (
        properties: Record<string, { "~optional"?: boolean }>,
        options: unknown = {},
      ) => {
        const required = Object.keys(properties).filter(
          (key) => !properties[key]?.["~optional"],
        );
        return {
          type: "object",
          ...(required.length ? { required } : {}),
          properties,
          ...(options as object),
        };
      },
      Optional: (value: object) =>
        Object.defineProperty({ ...value }, "~optional", { value: true }),
      String: (options: unknown = {}) => ({ type: "string", ...options }),
      Boolean: (options: unknown = {}) => ({ type: "boolean", ...options }),
      Number: (options: unknown = {}) => ({ type: "number", ...options }),
      Integer: (options: unknown = {}) => ({ type: "integer", ...options }),
      Array: (items: unknown, options: unknown = {}) => ({
        type: "array",
        items,
        ...options,
      }),
    },
  },
});

const extension = await import("./index.ts");
export const registerExtension = extension.default;
export const {
  sessionAgentIdentity,
  sessionContextRetired,
  resolveAssignmentSession,
  visibleAgentDefinitionMetadata,
} = extension;
export const {
  StatusWidget,
  formatAgentDefinitions,
  buildStatusRows,
  renderRunningOptions,
  truncateModelText,
  visibleWidth,
} = await import("./presentation.ts");
export const {
  agentDefinitionMetadata,
  discoverAgent,
  discoverAgentDefinitions,
} = await import("./agent-definitions.ts");

export type Context = {
  cwd: string;
  hasUI: boolean;
  mode: "tui" | "rpc";
  isProjectTrusted: () => boolean;
  isIdle: () => boolean;
  abort: () => void;
  getContextUsage: () => { tokens: number; contextWindow: number };
  compact?: (options?: {
    customInstructions?: string;
    onComplete?: () => void;
    onError?: (error: Error) => void;
  }) => void;
  sessionManager: {
    getSessionId: () => string;
    getSessionFile: () => string;
    getEntries: () => unknown[];
    getBranch: () => unknown[];
  };
  ui: {
    notify: () => void;
    select: () => Promise<string>;
    setWidget?: (key: string, content: WidgetContent) => void;
    custom?: (...args: unknown[]) => Promise<unknown>;
  };
};

export const WORKSPACE = `registered-test-workspace-${randomUUID()}`;
export const LEAD_SESSION_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
export const NON_PI_AGENT = "legacy-root";
export const AGENT_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
export const REQUEST_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
export const DEFAULT_PI_SESSION_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
export const PARENT_SESSION_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
export const CHILD_SESSION_ID = "ffffffff-ffff-4fff-8fff-ffffffffffff";

export type FixtureIdentity = {
  paneId: string;
  tabId: string;
  piSessionId: string;
  piSessionFile: string;
};

export const defaultFixtureIdentity: FixtureIdentity = {
  paneId: "registered-pane",
  tabId: "registered-tab",
  piSessionId: DEFAULT_PI_SESSION_ID,
  piSessionFile: "/tmp/registered-agent.jsonl",
};

/**
 * The identity of the managed process a test is itself simulating. Its mailbox
 * records the raw pane its own environment declares (`TMUX_PANE`, which the
 * shared environment setup writes), because that is the pane the child's startup
 * acknowledgment carries and the one production compares against. Read at
 * construction, not at import: the environment is set per test.
 * `defaultFixtureIdentity` stays the explicit identity for records that are not
 * this process's own claim - a daemon listing row, or a historical mailbox.
 */
export function ownManagedIdentity(): FixtureIdentity {
  return {
    ...defaultFixtureIdentity,
    paneId: process.env.TMUX_PANE ?? FIXTURE_LEAD_PANE,
  };
}

export function recoveryIdentity(label: string): FixtureIdentity {
  return {
    paneId: `${label}-pane`,
    tabId: `${label}-tab`,
    piSessionId: DEFAULT_PI_SESSION_ID,
    piSessionFile: `/tmp/${label}-agent.jsonl`,
  };
}

export function delegationLockPathForTest(
  workspaceId: string,
  parentSessionId: string,
): string {
  return join(
    herdsmanTempRoot(),
    "locks",
    "delegation-" +
      createHash("sha256")
        .update(workspaceId + "\0" + parentSessionId)
        .digest("hex"),
  );
}

export function assignmentLockPathForTest(mailbox: string): string {
  return join(
    herdsmanTempRoot(),
    "locks",
    "assignment-" + createHash("sha256").update(mailbox).digest("hex"),
  );
}

export function fakeContext(
  entries: unknown[] = [],
  branch: unknown[] = entries,
): Context {
  return {
    cwd: "/tmp",
    hasUI: false,
    mode: "tui",
    abort: () => undefined,
    isProjectTrusted: () => true,
    isIdle: () => true,
    getContextUsage: () => ({ tokens: 2, contextWindow: 10, percent: null }),
    sessionManager: {
      getSessionId: () => LEAD_SESSION_ID,
      getSessionFile: () => "/tmp/root.jsonl",
      getSessionName: () => undefined,
      getEntries: () => entries,
      getBranch: () => branch,
    },
    ui: {
      notify: () => undefined,
      select: async () => "tab",
      confirm: async () => true,
      setStatus: () => undefined,
      setWidget: (_key: string, content: WidgetContent) =>
        assertWidgetContent(content),
      custom: async () => undefined,
    },
  };
}
export function fakeAgentContext(
  entries: unknown[] = [],
  branch: unknown[] = entries,
): Context {
  const context = fakeContext(entries, branch);
  context.sessionManager = {
    ...context.sessionManager,
    getSessionId: () => "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    getSessionFile: () => "/tmp/registered-agent.jsonl",
  };
  return context;
}

export type ExecResult = {
  stdout: string;
  stderr: string;
  code: number;
  killed?: boolean;
};
export type ExecHandler = (
  command: string,
  args: string[],
  options?: { timeout?: number; signal?: AbortSignal },
) => ExecResult | Promise<ExecResult>;

export function fakePi(
  options: {
    exec?: ExecHandler;
    sendMessage?: (message: unknown) => void | Promise<void>;
    sendUserMessage?: (content: unknown, options?: unknown) => void;
    entries?: unknown[];
    activeTools?: string[] | (() => string[]);
    autoActivateRegisteredTools?: boolean;
    persistMessages?: boolean;
    sessionName?: string;
    thinkingLevel?: string;
    allTools?: unknown[] | (() => unknown[]);
  } = {},
) {
  const events = new Map<string, ((event: any, ctx: Context) => unknown)[]>();
  // Mirrors Pi's extension EventBus: synchronous emit, synchronous listener
  // mutations of the payload, and a listener that throws isolated per handler.
  const busEmitter = new EventEmitter();
  const eventBus = {
    emit(channel: string, data: unknown) {
      busEmitter.emit(channel, data);
    },
    on(channel: string, handler: (data: unknown) => void) {
      const safeHandler = (data: unknown) => {
        try {
          handler(data);
        } catch {
          // Pi's EventBus logs and swallows listener errors.
        }
      };
      busEmitter.on(channel, safeHandler);
      return () => busEmitter.off(channel, safeHandler);
    },
  };
  const commands: string[] = [];
  const commandOptions = new Map<string, any>();
  const entryRenderers: { customType: string; renderer: unknown }[] = [];
  const messageRenderers: { customType: string; renderer: unknown }[] = [];
  const tools: any[] = [];
  const calls: string[][] = [];
  const callResults: { args: string[]; succeeded: boolean; code?: number }[] =
    [];
  const execOptions: { timeout?: number; signal?: AbortSignal }[] = [];
  const entries = options.entries ?? [];
  const sent: unknown[] = [];
  const sentMessageCalls: { message: unknown; options?: unknown }[] = [];
  const sentUsers: unknown[] = [];
  const sentUserCalls: { content: unknown; options?: unknown }[] = [];
  let activeTools: string[] | undefined =
    typeof options.activeTools === "function"
      ? undefined
      : [...(options.activeTools ?? [])];
  const pi = {
    events: eventBus,
    on(name: string, handler: (event: any, ctx: Context) => unknown) {
      events.set(name, [...(events.get(name) ?? []), handler]);
    },
    registerCommand(name: string, options: any) {
      commands.push(name);
      commandOptions.set(name, options);
    },
    registerTool(tool: unknown) {
      tools.push(tool);
      if (options.autoActivateRegisteredTools && (tool as any)?.name) {
        activeTools = [
          ...new Set([...this.getActiveTools(), (tool as any).name]),
        ];
      }
    },
    registerMessageRenderer(customType: string, renderer: unknown) {
      messageRenderers.push({ customType, renderer });
    },
    registerEntryRenderer(customType: string, renderer: unknown) {
      entryRenderers.push({ customType, renderer });
    },
    getActiveTools() {
      return activeTools
        ? [...activeTools]
        : (options.activeTools as () => string[])();
    },
    setActiveTools(next: string[]) {
      activeTools = [...next];
    },
    getAllTools() {
      return typeof options.allTools === "function"
        ? options.allTools()
        : (options.allTools ?? []);
    },
    getSessionName() {
      return options.sessionName;
    },
    getThinkingLevel() {
      return options.thinkingLevel ?? "medium";
    },
    async exec(
      command: string,
      args: string[],
      execOptionsValue: { timeout?: number; signal?: AbortSignal } = {},
    ) {
      calls.push(args);
      execOptions.push(execOptionsValue);
      try {
        const result = await (options.exec?.(command, args, execOptionsValue) ?? {
          stdout: "{}",
          stderr: "",
          code: 0,
        });
        callResults.push({
          args,
          succeeded: result.code === 0,
          code: result.code,
        });
        return result;
      } catch (error) {
        callResults.push({ args, succeeded: false });
        throw error;
      }
    },
    appendEntry(customType: string, data: unknown) {
      entries.push({ type: "custom", customType, data });
    },
    sendMessage(message: unknown, sendOptions?: unknown) {
      sent.push(message);
      sentMessageCalls.push({ message, options: sendOptions });
      if (options.persistMessages) entries.push(message);
      return options.sendMessage?.(message);
    },
    sendUserMessage(content: unknown, sendOptions?: unknown) {
      sentUsers.push(content);
      sentUserCalls.push({ content, options: sendOptions });
      options.sendUserMessage?.(content, sendOptions);
    },
  };
  return {
    pi,
    events,
    commands,
    commandOptions,
    entryRenderers,
    messageRenderers,
    tools,
    calls,
    callResults,
    execOptions,
    entries,
    sent,
    sentMessageCalls,
    sentUsers,
    sentUserCalls,
  };
}

export function stopSummary(pi: ReturnType<typeof fakePi>): string {
  const message = [...pi.sentMessageCalls]
    .reverse()
    .find(
      (candidate: any) =>
        candidate?.message?.customType === "pi-herdsman-stop-summary",
    )?.message as { details?: { summary?: unknown } } | undefined;
  return typeof message?.details?.summary === "string"
    ? message.details.summary
    : "";
}

/** A real executable a launch can run, outside the repository. */
export const testChildCommand = join(testTmpRoot, "child-command");
realFs.writeFileSync(testChildCommand, "#!/bin/sh\n", { mode: 0o755 });

/**
 * The launch configuration a fresh worker is started with.
 *
 * Radar spawn places a child beside its parent's registered pane and runs an
 * executable the caller resolved, so a delegating session needs both: the pane
 * its own environment reports, and a child command. It also makes the supported
 * placement the harness default; the placement tests set their own.
 */
export function configureSupportedLaunch(): void {
  process.env.PI_HERDSMAN_CHILD_COMMAND = testChildCommand;
  realFs.writeFileSync(testChildCommand, "#!/bin/sh\n", { mode: 0o755 });
  const configPath = join(PI_AGENT_ROOT, "pi-herdsman", "config.json");
  realFs.mkdirSync(join(PI_AGENT_ROOT, "pi-herdsman"), { recursive: true });
  // The suite sets per-test configuration (for example `retainWorkers`) before
  // each test runs, so the placement this fixture needs is merged into it.
  const configured = realFs.existsSync(configPath)
    ? (JSON.parse(realFs.readFileSync(configPath, "utf8")) as Record<
        string,
        unknown
      >)
    : {};
  realFs.writeFileSync(
    configPath,
    JSON.stringify({ ...configured, spawnPlacement: "split" }),
  );
}

/**
 * The durable Radar launch records this session kept, read exactly as the
 * production readers do (`radarSpawnFromEntries`): custom entries under the
 * extension's own type, keyed by the mailbox and run each was created for.
 */
export function radarSpawnRecords(pi: ReturnType<typeof fakePi>): unknown[] {
  return pi.entries.filter(
    (entry: any) =>
      entry?.type === "custom" &&
      entry.customType === "pi-herdsman-radar-spawn",
  );
}

/**
 * Start the fixture session, which is what registers this process with the
 * daemon. A launch needs that registration naming its own pane, and the real
 * extension registers during session start, so a fixture that delegates has to
 * start a session too.
 */
/**
 * Waits until every observe the daemon received has completed. A scan left running by
 * an earlier test can finish during the next one, so a test drains first and takes its
 * count only once the daemon has nothing in flight.
 */
export { radarObservesCompleted };

export async function drainRadarObserves(): Promise<number> {
  for (let turn = 0; turn < 1000; turn++) {
    if (radarObservesStarted() === radarObservesCompleted())
      return radarObservesCompleted();
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error("Radar observes never drained");
}

/**
 * Waits until the fake daemon has completed `target` observes. After
 * `drainRadarObserves`, `target` is the drained count plus the observes the trigger
 * starts, so only that trigger's own scans can satisfy it.
 */
export async function settleRadarObserves(target: number): Promise<void> {
  for (let turn = 0; turn < 1000; turn++) {
    if (radarObservesCompleted() >= target) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error(
    `Radar scan did not complete: ${radarObservesCompleted()} of ${target} observes`,
  );
}

export async function startRadarSession(
  pi: ReturnType<typeof fakePi>,
  context: ReturnType<typeof fakeContext> = fakeContext(),
): Promise<void> {
  await ensureRadarDaemon();
  for (const handler of pi.events.get("session_start") ?? [])
    await handler(undefined, context);
}

/** A delegation brief with the assignment detail a test varies, as the tool requires. */
export const testBrief = (task: string) =>
  `${DELEGATION_BRIEF_EXAMPLES.common.trimEnd()}\n\nAssignment-specific detail:\n${task}`;

/**
 * Delegates one assignment through the production launch edge and returns the
 * mailbox state the daemon's own simulated launch wrote for the child. The
 * child is Radar-bound: its record carries the agent id the spawn returned.
 */
export async function delegateRadarChild(
  pi: ReturnType<typeof fakePi>,
  label: string,
  task = "placement",
): Promise<ManagedAgentState> {
  const tool = pi.tools.find(
    (candidate) => candidate.name === "agent_delegate",
  )!;
  const result = await tool.execute(
    `delegate-${label}`,
    { definition: "agent", label, task: testBrief(task) },
    undefined,
    undefined,
    fakeContext(),
  );
  assert.equal(result.details.ok, true, JSON.stringify(result.details));
  return readAgentState(agentMailboxPath(WORKSPACE, label))!;
}

export function setLeadEnvironment(): void {
  resetRadarState();
  clearTestMailboxes();
  realFs.mkdirSync(PI_AGENTS_DIR, { recursive: true });
  for (const entry of realFs.readdirSync(PI_AGENTS_DIR))
    if (entry.endsWith(".md")) realFs.rmSync(join(PI_AGENTS_DIR, entry));
  realFs.writeFileSync(
    join(PI_AGENTS_DIR, "agent.md"),
    "---\nname: agent\n---\nagent instructions\n",
  );
  realFs.writeFileSync(
    join(PI_AGENTS_DIR, "child.md"),
    "---\nname: child\n---\nchild\n",
  );
  for (const key of [
    "PI_HERDSMAN_MAILBOX",
    "PI_HERDSMAN_RUN_ID",
    "PI_HERDSMAN_OWNER_SESSION_ID",
    "PI_HERDSMAN_LABEL",
    "PI_HERDSMAN_WORKSPACE_ID",
    "PI_HERDSMAN_AGENT_DEFINITION",
    "PI_HERDSMAN_BRIEF_PROFILE",
    "PI_HERDSMAN_ALLOWED_AGENT_DEFINITIONS",
    "HERDR_PANE_ID",
    "TMUX",
    "TMUX_PANE",
    "HERDR_TAB_ID",
    "HERDR_SOCKET_PATH",
    "PI_HERDSMAN_CHILD_COMMAND",
    "PI_HERDSMAN_LAUNCH_GENERATION",
    "PI_HERDSMAN_PARENT_PANE_ID",
  ])
    delete process.env[key];
  configureSupportedLaunch();
  process.env.TMUX = FIXTURE_TMUX_ENV;
  process.env.TMUX_PANE = FIXTURE_LEAD_PANE;
}

export function setAgentEnvironment(
  label = "registered-agent",
  allowedAgentDefinitions?: string[],
): string {
  resetRadarState();
  clearTestMailboxes();
  for (const entry of realFs.readdirSync(PI_AGENTS_DIR))
    if (entry.endsWith(".md")) realFs.rmSync(join(PI_AGENTS_DIR, entry));
  realFs.writeFileSync(
    join(PI_AGENTS_DIR, "agent.md"),
    "---\nname: agent\n---\nagent instructions\n",
  );
  realFs.writeFileSync(
    join(PI_AGENTS_DIR, "child.md"),
    "---\nname: child\n---\nchild\n",
  );
  const workspace = WORKSPACE;
  const mailbox = agentMailboxPath(workspace, label);
  process.env.PI_HERDSMAN_MAILBOX = mailbox;
  process.env.PI_HERDSMAN_RUN_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  process.env.PI_HERDSMAN_OWNER_SESSION_ID =
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  process.env.PI_HERDSMAN_LABEL = label;
  process.env.PI_HERDSMAN_WORKSPACE_ID = workspace;
  process.env.PI_HERDSMAN_AGENT_DEFINITION = "agent";
  process.env.PI_HERDSMAN_BRIEF_PROFILE = "common";
  process.env.TMUX = FIXTURE_TMUX_ENV;
  process.env.TMUX_PANE = FIXTURE_LEAD_PANE;
  delete process.env.PI_HERDSMAN_LAUNCH_GENERATION;
  delete process.env.PI_HERDSMAN_PARENT_PANE_ID;
  if (allowedAgentDefinitions === undefined)
    delete process.env.PI_HERDSMAN_ALLOWED_AGENT_DEFINITIONS;
  else
    process.env.PI_HERDSMAN_ALLOWED_AGENT_DEFINITIONS = JSON.stringify(
      allowedAgentDefinitions,
    );
  configureSupportedLaunch();
  resetAgentMailbox(mailbox);
  return mailbox;
}

function clearTestMailboxes(): void {
  // The daemon's observation is derived from the mailbox store, so a state an
  // earlier test left in any workspace would present itself as a live child of
  // the next one. This fixture owns the whole store, so it empties it.
  for (const { path } of listAgentStates())
    realFs.rmSync(path, { recursive: true, force: true });
  realFs.rmSync(join(herdsmanDataRoot(), "completions"), { recursive: true, force: true });
}

export function managedState(
  label: string,
  activeRequestId?: string,
  identity: FixtureIdentity = ownManagedIdentity(),
): ManagedAgentState {
  return {
    version: 5,
    runId: AGENT_ID,
    ownerSessionId: LEAD_SESSION_ID,
    workspaceId: WORKSPACE,
    agentLabel: label,
    paneId: identity.paneId,
    piSessionId: identity.piSessionId,
    piSessionFile: identity.piSessionFile,
    cwd: "/tmp",
    ...(activeRequestId
      ? {
          briefProfile: "common" as const,
          activeRequestId,
          acceptedAssignment: fixtureAcceptedAssignment(activeRequestId),
        }
      : {}),
    updatedAt: Date.now(),
  };
}

export function resultEntryDetails(
  state: ManagedAgentState,
  requestId: string,
) {
  return {
    runId: state.runId,
    requestId,
    ownerSessionId: state.ownerSessionId,
    workspaceId: state.workspaceId,
    agentLabel: state.agentLabel,
    paneId: state.paneId,
    cwd: state.cwd,
    piSessionId: state.piSessionId,
    ...(state.piSessionFile !== undefined
      ? { piSessionFile: state.piSessionFile }
      : {}),
  };
}

export function listResponse(
  label: string,
  status: "idle" | "working" | "done" = "idle",
  sessionId: string | null = DEFAULT_PI_SESSION_ID,
  identity: FixtureIdentity = defaultFixtureIdentity,
  useAgentStatus = false,
  agentStatus: unknown = status,
  runId = AGENT_ID,
): string {
  const agent = {
    agent_status: useAgentStatus ? agentStatus : status,
    ...(useAgentStatus ? { interactive_ready: agentStatus === "done" } : {}),
    cwd: "/tmp",
    workspace_id: WORKSPACE,
    pane_id: identity.paneId,
    tab_id: identity.tabId,
    tab_label: "agents",
    ...(sessionId
      ? {
          agent_session: {
            source: "herdr:pi",
            agent: "pi",
            kind: "id",
            value: sessionId,
          },
          session_path: identity.piSessionFile,
        }
      : {}),
  };
  return JSON.stringify({
    action: "list",
    workspace_id: WORKSPACE,
    tab: "",
    tabs: [],
    agents: [agent],
    available_panes: [],
    agent_definitions: [],
  });
}

export function requestRecordBytes(
  agentLabel: string,
  paneId: string,
  text: string,
): number {
  return Buffer.byteLength(
    JSON.stringify({
      version: 5,
      runId: AGENT_ID,
      requestId: REQUEST_ID,
      ownerSessionId: LEAD_SESSION_ID,
      workspaceId: WORKSPACE,
      agentLabel,
      paneId,
      kind: "task",
      text,
      createdAt: 1_700_000_000_000,
    }),
    "utf8",
  );
}

export function testGate<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

export function consumeMailboxRequest(
  mailbox: string,
  onRequest: (request: RequestRecord) => void | Promise<void>,
): () => void {
  let seen: string | undefined;
  let stopped = false;
  let mailboxInitialized = false;
  let processing = false;
  const poll = () => {
    if (stopped || processing) return;
    try {
      if (readAgentState(mailbox)) mailboxInitialized = true;
      else if (mailboxInitialized) {
        stopped = true;
        clearInterval(timer);
        return;
      }
      const request = readUnacknowledgedRequest(mailbox);
      if (!request || request.requestId === seen) return;
      processing = true;
      Promise.resolve()
        .then(() => onRequest(request))
        .then(() => {
          seen = request.requestId;
        })
        .catch(() => {})
        .finally(() => {
          processing = false;
        });
    } catch {
      // Controller tests retain malformed requests just like a live child.
    }
  };
  const timer = setInterval(poll, 10);
  timer.unref?.();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

function acceptMailboxRequest(mailbox: string, request: RequestRecord): void {
  const state = readAgentState(mailbox);
  if (!state) return;
  writeAgentState(mailbox, {
    ...state,
    ...(request.kind === "task"
      ? { activeRequestId: request.requestId, completedRequestId: undefined }
      : {}),
    lastAck: {
      requestId: request.requestId,
      accepted: true,
      // An addressed request is answered by the process it names, and that
      // process's own echo is what the owner holds the acceptance to. The
      // fixture answers as the child it stands in for, exactly as a real one
      // does; an unaddressed request echoes nothing, which is the legacy form.
      ...(request.address !== undefined ? { identity: request.address } : {}),
      acknowledgedAt: Date.now(),
    },
    updatedAt: Date.now(),
  });
}

export function skillBlock(skill: string, name: string): string {
  const start = `<!-- pi-herdsman-runtime-${name}:start -->`;
  const end = `<!-- pi-herdsman-runtime-${name}:end -->`;
  const from = skill.indexOf(start);
  const to = skill.indexOf(end);
  assert.notEqual(from, -1, `missing ${start}`);
  assert.notEqual(to, -1, `missing ${end}`);
  assert.ok(to > from, `${name} markers out of order`);
  return skill
    .slice(from + start.length, to)
    .trim()
    .replaceAll(/\s+/g, " ");
}

export function promptLaunchContents(args: string[]): string[] {
  const contents: string[] = [];
  for (let index = 0; index < args.length; index++) {
    if (
      args[index] === "--system-prompt" ||
      args[index] === "--append-system-prompt"
    ) {
      const input = args[index + 1]!;
      contents.push(
        input.startsWith("<active_agent ")
          ? input
          : readFileSync(input, "utf8"),
      );
    }
  }
  return contents;
}

export function promptLaunchPaths(args: string[]): string[] {
  const paths: string[] = [];
  for (let index = 0; index < args.length; index++) {
    if (
      args[index] === "--system-prompt" ||
      args[index] === "--append-system-prompt"
    )
      paths.push(args[index + 1]!);
  }
  return paths;
}

export function writePromptDefinition(
  path: string,
  name: string,
  promptPath: string,
): void {
  realFs.writeFileSync(
    path,
    `---\nname: ${name}\n---\ndefinition body\n@${promptPath}\n`,
  );
}

export default {
  get openedSessionPaths() {
    return openedSessionPaths;
  },
  get sessionOpenError() {
    return sessionOpenError;
  },
  set sessionOpenError(value: unknown) {
    sessionOpenError = value;
  },
  get failNextMailboxWrite() {
    return failNextMailboxWrite;
  },
  set failNextMailboxWrite(value: boolean) {
    failNextMailboxWrite = value;
  },
  get failNextRequestRemoval() {
    return failNextRequestRemoval;
  },
  set failNextRequestRemoval(value: boolean) {
    failNextRequestRemoval = value;
  },
  get failNextResultRemoval() {
    return failNextResultRemoval;
  },
  set failNextResultRemoval(value: boolean) {
    failNextResultRemoval = value;
  },
  get resultRemovalAttempts() {
    return resultRemovalAttempts;
  },
  set resultRemovalAttempts(value: number) {
    resultRemovalAttempts = value;
  },
  get agentDefinitionReadCount() {
    return agentDefinitionReadCount;
  },
  set agentDefinitionReadCount(value: number) {
    agentDefinitionReadCount = value;
  },
  get configReadHook() {
    return configReadHook;
  },
  set configReadHook(value: typeof configReadHook) {
    configReadHook = value;
  },
  get agentStateReadHook() {
    return agentStateReadHook;
  },
  set agentStateReadHook(value: typeof agentStateReadHook) {
    agentStateReadHook = value;
  },
};
