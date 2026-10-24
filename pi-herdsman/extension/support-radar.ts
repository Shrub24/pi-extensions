import { randomUUID } from "node:crypto";
import { chmodSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock } from "node:test";
import * as sdk from "pi-radar/client";
import type { RadarClient, RadarCloseOutcome, RadarSpawnEdge, RadarSpawnTopology, RadarLocation, RadarInventory } from "pi-radar/client";
import type { RadarPublicationClient } from "pi-radar/publication";
import {
  type RadarChannel, type RadarErrorCode,
  RADAR_EVENTS_CONTRACT, RADAR_MINIMUM_REVISION, RADAR_PROTOCOL_VERSION,
  RADAR_REGISTRY_CONTRACT, RADAR_REGISTRY_FACTS_CONTRACT,
  RADAR_SPAWN_CLOSE_CONTRACT, RADAR_SPAWN_CONTRACT, RADAR_SPAWN_LAUNCH_CONTEXT_CONTRACT,
} from "pi-radar/client";
import { RADAR_PUBLICATION_VERSION, radarBindingKey } from "pi-radar/publication";
import { RADAR_SUBJECT_SOURCE } from "pi-radar/execution";

// Select typed ports by a test-local address. No socket or wire envelope.
const clients = new Map<string, RadarClient>();
mock.module("pi-radar/client", { namedExports: {
  ...sdk,
  createRadarClient: (options?: Parameters<typeof sdk.createRadarClient>[0]) =>
    clients.get(options?.env?.RADAR_CONTROL_SOCKET ?? process.env.RADAR_CONTROL_SOCKET ?? "") ??
      sdk.createRadarClient(options),
} });
import type {
  ManagedAgentState,
  RequestAddress,
  RequestRecord,
} from "./mailbox.ts";
import { herdsmanDataRoot } from "./storage.ts";
/** The tmux server the fixture daemon addresses, and the lead's own pane on it. */
export const FIXTURE_TMUX_SERVER = "herdsman-fixture";
/** The workspace label this fake daemon reports for its own panes. */
export const FIXTURE_WORKSPACE = "herdsman-fixture";
export const FIXTURE_TMUX_ENV = `${FIXTURE_TMUX_SERVER},1,0`;
export const FIXTURE_LEAD_PANE = "%1";
export const FIXTURE_LEAD_SUBJECT_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
export const FIXTURE_AGENT_SUBJECT_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";


/**
 * The mailbox module is loaded on first use rather than at module scope: the
 * harness's fs mock is installed by `support.ts`, and importing the mailbox
 * while that module is still resolving its own imports would bind its file
 * access before the mock exists, leaving the fixture's mailbox hooks blind.
 */
let mailboxModule: typeof import("./mailbox.ts") | undefined;
const loadMailbox = async (): Promise<typeof import("./mailbox.ts")> =>
  (mailboxModule ??= await import("./mailbox.ts"));

/**
 * An isolated Agent Radar control plane for tests.
 *
 * Radar spawn creates a pane and starts a child process, which a test cannot
 * observe directly, so this daemon stands in for both ends: it answers the
 * control protocol, and after accepting a spawn it performs the child's own
 * share of a launch — registers the subject its launch token belongs to, writes
 * the binding sidecar the owner correlates it with, writes the child's mailbox
 * state, acknowledges its launch, and accepts the
 * assignment it is given.
 *
 * Every simulated step is switchable, because the interesting launch outcomes
 * are the ones where a step does not happen.
 */
export type RadarFakeSpawn = {
  request_id: string;
  parent: string;
  parent_session_id: string;
  executable: string;
  argv: string[];
  cwd?: string;
  env: Record<string, string>;
  managed?: { parent_subject_id?: string };
  pane: string;
  incarnation: string;
  agent_id?: string;
  /** The child's durable subject, granted with its first presence. */
  subject_id?: string;
  bound_at?: string;
  /** The Pi session the simulated child published as its current context. */
  session_id?: string;
  session_file?: string;
  /** The released child's subject this launch continues, when it does. */
  continues?: string;
  token: string;
  mailbox?: string;
  /**
   * `true` once a managed close confirmed the pane closed. The edge and its
   * binding stay, so topology reports a stale pane rather than a dead process.
   */
  closed?: boolean;
  /** `true` once the child's process stopped while its pane stayed. */
  processGone?: boolean;
};

export type RadarFakeOptions = {
  /** `false` leaves the edge unbound: no child registered with its token. */
  bind: boolean;
  standing?: "granted" | "duplicate" | "pending";
  /** `false` writes the child's state but never its startup acknowledgment. */
  acknowledge: boolean;
  /** `false` leaves each assignment unacknowledged in the child's mailbox. */
  acceptAssignments: boolean;
  /**
   * The incarnation of the process that answers this child's mailbox. The
   * default is the child the launch created; another value is a process that
   * replaced it in the same mailbox with the same managed tuple.
   */
  responderIncarnation?: string;
  /**
   * What the answering process echoes of an addressed request: the address it
   * was given, nothing at all, or another process's own address.
   */
  acknowledgeIdentity: "exact" | "omit" | "wrong";
  /** The session the simulated child reports for itself. */
  session: { id: string; file: string };
  /**
   * The pane the simulated child claims as its own. The default is the pane the
   * daemon created for it; a test sets another pane to drive a child whose
   * environment handed it coordinates that are not its own.
   */
  childPane?: string;
  /**
   * What this daemon's own inventory reports about the pane it recorded, which
   * is the evidence a spawn topology read derives `state` and `freshness` from.
   */
  locationEvidence: "present" | "absent" | "unavailable";
  /**
   * The canonical fleet observation this daemon answers `mux.observe` with.
   * The default is an empty but well-formed observation - no registered child
   * and no pane - and a test that needs a pane or a presenting child says which
   * one. Presented agents always come from the registry, never from a backend's
   * own records.
   */
  inventory?: { workspaces: unknown[]; tabs: unknown[]; panes: unknown[]; agents: unknown[] };
  /**
   * `true` refuses `mux.observe` with a backend error, as an unreadable topology
   * would: nothing was read, so nothing may be concluded from it.
   */
  observeUnavailable: boolean;
  /** The physical backend this daemon reports, and the server it addresses. */
  backend: string;
  instance: string | null;
  /**
   * What the edge records about the child's own process exit. `exited` is a
   * child whose pane can still be present, which is why an observation and a
   * reported pane have to be read separately.
   */
  exitObservation: "unknown" | "exited";
  /**
   * What a managed close answers. `already_exited` is the daemon's dead-pane
   * path: the pane command had exited, and the retained pane was cleaned up.
   * The pane's own exit is recorded on the edge separately, because the read
   * that proves a child and the close that removes its pane are separate
   * instants.
   */
  closeOutcome: "completed" | "already_exited";
  /**
   * The process verdict `agent.get` reports for the bound child. Unset, it is
   * `verified` until a managed close has removed the pane, then `absent`, as a
   * daemon that closed the pane would see its process gone.
   */
  processVerdict?: "verified" | "absent" | "mismatched" | "unavailable";
  /**
   * `false` leaves the bound child's registration without a process identity
   * claim, which makes it ineligible for `child.close`, and `agent.get` reports
   * its verdict as `unavailable`.
   */
  childProcessClaim: boolean;
  /**
   * `true` settles a close as `refused` before any pane effect instead of
   * closing it, as a backend refusing the close would.
   */
  refuseChildClose: boolean;
  /** Refuse `spawn` with this daemon error instead of creating an edge. */
  refuseSpawn?: { code: RadarErrorCode; message: string };
  /** Drop the `spawn` reply after creating the edge, as a lost reply would. */
  dropSpawnReply: boolean;
  /**
   * Drop the `child.close` reply after applying the close, as a lost reply
   * would: the pane is gone and this process never learned that it is.
   */
  dropCloseReply: boolean;
  /** The public contracts this daemon advertises. */
  contracts: string[];
  /** Throw inside the daemon while answering `spawn`. */
  crashSpawn: boolean;
};

/** A one-shot reply hold: whether its reply reached the socket, and its arrival. */
type ReplyHold = { written: boolean; arrive: () => void };

/**
 * The options of a child an earlier launch left running: the daemon's own store
 * already holds the edge it bound, so nothing here spawns a process.
 */
export type RetainedChildOptions = {
  label: string;
  runId: string;
  ownerSessionId: string;
  workspaceId: string;
  mailbox: string;
  /** The pane the earlier launch recorded for the child. */
  pane: string;
  definition?: string;
  cwd?: string;
};

/**
 * The durable launch record an adopted child's own launch would have left in
 * the owner's session, in the shape that session's readers hold it by.
 */
export type RetainedLaunchRecord = {
  stage: "bound";
  requestId: string;
  runId: string;
  label: string;
  ownerSessionId: string;
  workspaceId: string;
  mailbox: string;
  subjectId: string;
  piSessionId: string;
  paneId: string;
  agentDefinition: string;
};

export type FakeRadarDaemon = {
  socketPath: string;
  client: RadarClient;
  options: RadarFakeOptions;
  /**
   * The values this daemon was created with. A daemon that replaces another one
   * inherits these rather than the live settings object, whose mid-test changes
   * are that test's own and would otherwise become the replacement's creation
   * state, which its own reset would restore for every test that follows.
   */
  creationOptions(): RadarFakeOptions;
  /**
   * A child an earlier launch of this session left running: the daemon keeps the
   * edge it bound, and the child keeps the binding, mailbox state and
   * acknowledgment it wrote for itself. It is the evidence a retained worker is
   * held by, so a test that models one models exactly these facts.
   */
  adoptRetainedChild(options: RetainedChildOptions): Promise<RetainedLaunchRecord>;
  /** Every spawn this daemon accepted, in order. */
  spawns: RadarFakeSpawn[];
  /** Every registered subject, by agent id. */
  subjects: Map<string, Record<string, unknown>>;
  /** Every accepted channel publish. */
  published: Array<{
    agent_id: string;
    channel: RadarChannel;
    snapshot: unknown;
    observed_at?: string;
  }>;
  /**
   * The close outcome this daemon has recorded per close-operation UUID, which
   * is what a replayed `child.close` returns without a second effect.
   */
  closes: Map<string, Record<string, unknown>>;
  /** Every registration request this daemon accepted, in order. */
  registerCalls: Array<{ agent_id: string; params: Record<string, unknown> }>;
  /** Runs when the daemon starts a child, before it registers as itself. */
  onChildStart?: (spawn: RadarFakeSpawn) => void | Promise<void>;
  /**
   * Runs once the child's own mailbox state exists and before it acknowledges
   * startup: the stage at which a launch has a bound child but no readiness.
   */
  onChildState?: (spawn: RadarFakeSpawn) => void | Promise<void>;
  /** Runs inside the simulated child before it accepts an assignment. */
  onChildRequest?: (
    spawn: RadarFakeSpawn,
    request: RequestRecord,
  ) => void | Promise<void>;
  /** Runs inside the simulated child after it accepts an assignment. */
  onChildAccepted?: (request: RequestRecord) => void | Promise<void>;
  /**
   * The Pi session the simulated child reports for itself. Every fresh child
   * mints its own session, so a test that cares about the identity overrides
   * this; the default after the first spawn is distinct, exactly as separate
   * children would be.
   */
  childSession?: (
    spawn: RadarFakeSpawn,
    index: number,
  ) => { id: string; file: string } | undefined;
  /**
   * The fleet this daemon observes, when the fixture owns the model.
   *
   * A live daemon observes whatever panes and agents the mux actually holds, so
   * the fixture that models a Herdsman-managed fleet supplies its own observation
   * from the mailboxes a test has set up. It is consulted per read, and an
   * explicit `options.inventory` overrides it for a test that needs a topology of
   * its own - an absent pane, a contradiction, or an unreadable backend.
   */
  observeInventory?: () => {
    workspaces: unknown[];
    tabs: unknown[];
    panes: unknown[];
    agents: unknown[];
  };
  /**
   * Holds the next `mux.observe` reply until the returned handle is released.
   * The fleet is read when the request arrives, so the held reply reports the
   * topology as it stood then, and a refresh that is still waiting on it is
   * observably in flight. `replyWritten` reports whether the held reply has
   * reached the socket, so a test can tell a hold that is kept from one that
   * is merely late.
   */
  holdNextObserve(): { release(): void; replyWritten(): boolean };
  /**
   * The child's pane is gone and its process has stopped, with no close record:
   * the backend lost the pane, so the edge answers as a missing pane does.
   */
  vanishPane(spawn: RadarFakeSpawn): void;
  /**
   * The child's process stopped while its pane stayed, as a dead shell does. The
   * verdict reads it as absent and the consumer stops, so nothing answers for it.
   */
  exitProcess(spawn: RadarFakeSpawn): void;
  /**
   * Holds the next `spawn.close` reply. The close is applied when it arrives,
   * as the daemon does, and `arrived` resolves at that point, so a test can
   * act while the close is still unanswered.
   */
  holdNextClose(): {
    arrived: Promise<void>;
    release(): void;
    replyWritten(): boolean;
  };
  /** Append one journal event. A pointer carries its kind and subject only. */
  appendEvent(
    kind: string,
    subject?: { agent_id?: string; spawn?: string; request_id?: string },
  ): number;
  /** Start a new journal epoch, as an unclean daemon restart does. */
  restartJournal(epoch: string): void;
  /** Retention drops every journal event before `sequence`. */
  dropEventsBefore(sequence: number): void;
  reset(): void;
  close(): Promise<void>;
};

const DEFAULTS: RadarFakeOptions = {
  childProcessClaim: true,
  refuseChildClose: false,
  bind: true,
  acknowledge: true,
  acceptAssignments: true,
  acknowledgeIdentity: "exact",
  session: {
    id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    file: "/tmp/registered-agent.jsonl",
  },
  dropSpawnReply: false,
  dropCloseReply: false,
  locationEvidence: "present",
  observeUnavailable: false,
  backend: "tmux",
  instance: FIXTURE_TMUX_SERVER,
  exitObservation: "unknown",
  closeOutcome: "completed",
  contracts: [
    RADAR_REGISTRY_CONTRACT,
    RADAR_REGISTRY_FACTS_CONTRACT,
    RADAR_SPAWN_CONTRACT,
    RADAR_SPAWN_CLOSE_CONTRACT,
    RADAR_SPAWN_LAUNCH_CONTEXT_CONTRACT,
    RADAR_EVENTS_CONTRACT,
  ],
  crashSpawn: false,
};

/**
 * The literal command every spawn in this test asked Radar to run. A launch used
 * to appear in the Herdr calls that started its pane; it now appears here, once
 * per launch, which is the same evidence in the transport that replaced it.
 */
let observesStarted = 0;
let observesCompleted = 0;

/**
 * Observe calls the daemon has received. A test that drains in-flight scans reads
 * this against `radarObservesCompleted` to know none is still running.
 */
export function radarObservesStarted(): number {
  return observesStarted;
}

/**
 * Observe calls whose connection the client has closed. The client closes its socket
 * only after it has read the reply, so a count that reaches a target names one scan
 * the daemon answered and the client took in, across every daemon this process started.
 */
export function radarObservesCompleted(): number {
  return observesCompleted;
}

export function spawnedArgvs(daemon: FakeRadarDaemon): string[][] {
  return daemon.spawns.map((spawn) => [...spawn.argv]);
}

/** The environment overlay every spawn carried, as `KEY=value` assignments. */
export function spawnedEnvironmentAssignments(
  daemon: FakeRadarDaemon,
): string[] {
  return daemon.spawns.flatMap((spawn) =>
    Object.entries(spawn.env).map(([key, value]) => `${key}=${value}`),
  );
}

/** The child labels this test's spawns were asked for, in order. */
export function spawnedLabels(daemon: FakeRadarDaemon): string[] {
  return daemon.spawns.map((spawn) => spawn.env.PI_HERDSMAN_LABEL ?? "");
}

/** The canonical handle of the pane the daemon creates for spawn `count`. */
function paneFor(count: number): string {
  return `tmux:${FIXTURE_TMUX_SERVER}:%${count + 1}`;
}
/** The handle of the first spawn's pane, which most tests address. */
export const FIXTURE_CHILD_PANE = paneFor(1);

export async function startFakeRadarDaemon(
  options: Partial<RadarFakeOptions> = {},
  creation: Partial<RadarFakeOptions> = options,
): Promise<FakeRadarDaemon> {
  // The daemon reads its settings through the caller's own object, so a test
  // can change one mid-flight exactly as a live daemon's behaviour can change.
  // The caller's own values are captured first: the same object is both the
  // target and the last source here, so reading it as it is being filled would
  // let the defaults overwrite what the caller asked for.
  const overrides = { ...options };
  // A daemon that replaces another carries its live settings but keeps the
  // predecessor's creation state, so a mid-flight change stays in effect without
  // becoming the baseline a later reset restores for every test after it.
  const baseline = { ...creation };
  const settings: RadarFakeOptions = Object.assign(options, DEFAULTS, overrides);
  const initial: RadarFakeOptions = { ...DEFAULTS, ...baseline };
  const directory = mkdtempSync(join(tmpdir(), "pi-herdsman-radar-"));
  chmodSync(directory, 0o700);
  const socketPath = join(directory, "port-fixture");
  writeFileSync(socketPath, "typed SDK ports\n");
  const spawns: RadarFakeSpawn[] = [];
  const subjects = new Map<string, Record<string, unknown>>();
  const published: Array<{
    agent_id: string;
    channel: RadarChannel;
    snapshot: unknown;
    observed_at?: string;
  }> = [];
  const registrations = new Map<string, string>();
  const bound = new Set<string>();
  const closes = new Map<string, Record<string, unknown>>();
  let observeGate: Promise<void> | undefined;
  let observeHold: ReplyHold | undefined;
  let closeGate: Promise<void> | undefined;
  let closeHold: ReplyHold | undefined;
  let journal: {
    epoch: string;
    earliest: number;
    events: Array<Record<string, unknown>>;
  };
  let nextSequence = 1;
  const restartJournal = (epoch: string): void => {
    journal = { epoch, earliest: 1, events: [] };
    nextSequence = 1;
  };
  restartJournal("journal-1");
  const registerCalls: Array<{ agent_id: string; params: Record<string, unknown> }> = [];
  const closeContents = new Map<string, string>();
  const mailboxes = new Map<string, () => void>();
  /** Every simulated child this daemon started, ended by `reset`. */
  const children: Array<() => void> = [];
  const daemon: Pick<
    FakeRadarDaemon,
    | "onChildStart"
    | "onChildState"
    | "onChildRequest"
    | "onChildAccepted"
    | "childSession"
    | "observeInventory"
  > = {};

  const subjectId = (source: string, incarnation: string): string => {
    const key = `${source}\0${incarnation}`;
    let agentId = registrations.get(key);
    if (agentId === undefined) {
      agentId = randomUUID();
      registrations.set(key, agentId);
      subjects.set(agentId, { source, incarnation });
    }
    return agentId;
  };

  const writerOf = (
    agentId: string,
    channel: string,
  ): Record<string, unknown> => ({
    handle: randomUUID(),
    source: String(subjects.get(agentId)?.source ?? RADAR_SUBJECT_SOURCE),
    incarnation: String(subjects.get(agentId)?.incarnation ?? randomUUID()),
    generation: 1,
    sequence: 0,
    channel,
  });

  // A child's location is the pane the daemon created for it, on the server it runs.
  const locationOf = (spawn: RadarFakeSpawn): RadarLocation => ({
    backend: settings.backend,
    instance: settings.instance ?? undefined,
    pane: spawn.pane,
  });
  const edge = (spawn: RadarFakeSpawn): RadarSpawnEdge => {
    const isBound = bound.has(spawn.request_id) && spawn.agent_id !== undefined;
    return {
      request_id: spawn.request_id,
      parent: spawn.parent,
      created: "completed",
      launched: "completed",
      location: locationOf(spawn),
      ...(isBound
        ? {
            granted_at: new Date().toISOString(),
            bound: {
              source: RADAR_SUBJECT_SOURCE,
              incarnation: spawn.incarnation,
              registration_id: spawn.agent_id,
              subject_id: spawn.subject_id,
              bound_at: spawn.bound_at,
            },
          }
        : {}),
      exit_observation:
        settings.exitObservation === "exited"
          ? { state: "exited", code: 0, observed_at: new Date().toISOString() }
          : { state: "unknown" },
    };
  };

  /**
   * A topology read: the edge plus the daemon's own derived fields.
   *
   * The daemon's rule, so a test drives the same words a real read returns: an
   * inventory that does not report the recorded pane is `unresolved` and stale,
   * an inventory that could not be consulted is stale with the binding left
   * standing, and only a present pane is fresh.
   */
  const topology = (spawn: RadarFakeSpawn): RadarSpawnTopology => ({
    edge: edge(spawn),
    state: settings.locationEvidence === "absent" || spawn.closed ? "unresolved" :
      bound.has(spawn.request_id) ? "bound" : "unbound",
    freshness: settings.locationEvidence === "present" && !spawn.closed && !settings.observeUnavailable ? "fresh" : "stale",
  });

  /**
   * The child's own mailbox consumption: it reads the assignment it was given
   * and acknowledges it, exactly as the previous harness's consumer did.
   */
  const consume = async (
    spawn: RadarFakeSpawn,
    mailbox: string,
  ): Promise<void> => {
    const {
      readAgentState,
      readUnacknowledgedRequest,
      writeAgentState,
      sameRequestAddress,
    } = await loadMailbox();
    let seen: string | undefined;
    let processing = false;
    let stopped = false;
    // This process stops answering for the mailbox on its own retirement, and on
    // nothing else: the daemon's close confirmed its pane gone (`closed`) or its
    // process was proved absent (`processGone`). A later launch on the same label
    // proves nothing about this process, so a replacement that merely exists - or
    // one still waiting to bind - never retires a consumer that was never
    // answered for.
    const retired = (): boolean =>
      spawn.closed === true || spawn.processGone === true;
    const timer = setInterval(() => {
      if (stopped || processing) return;
      if (retired()) {
        stopped = true;
        clearInterval(timer);
        return;
      }
      try {
        const request = readUnacknowledgedRequest(mailbox);
        if (!request || request.requestId === seen) return;
        processing = true;
        Promise.resolve()
          .then(() => daemon.onChildRequest?.(spawn, request))
          .then(async () => {
            const state = readAgentState(mailbox);
            // The rule the worker itself applies: an addressed request is
            // accepted by the process it names or not at all. A process that
            // occupies the same mailbox with the same managed tuple is still not
            // the process an address names when its incarnation differs, so a
            // replacement refuses instead of running the assignment.
            const addressed = request.address;
            const accepted =
              addressed === undefined ||
              sameRequestAddress(addressed, childAddress(spawn));
            if (state && settings.acceptAssignments && accepted)
              writeAgentState(mailbox, {
                ...state,
                ...(request.kind === "task"
                  ? {
                      activeRequestId: request.requestId,
                      completedRequestId: undefined,
                      // The child records what it accepted, which is what makes
                      // the state a valid active V5 assignment.
                      ...(request.acceptedAssignment !== undefined
                        ? { acceptedAssignment: request.acceptedAssignment }
                        : {}),
                      ...(request.briefProfile !== undefined
                        ? { briefProfile: request.briefProfile }
                        : {}),
                    }
                  : {}),
                lastAck: {
                  requestId: request.requestId,
                  accepted: true,
                  ...(addressed !== undefined &&
                  settings.acknowledgeIdentity === "exact"
                    ? { identity: addressed }
                    : {}),
                  ...(addressed !== undefined &&
                  settings.acknowledgeIdentity === "wrong"
                    ? { identity: { ...addressed, incarnation: randomUUID() } }
                    : {}),
                  acknowledgedAt: Date.now(),
                },
                updatedAt: Date.now(),
              });
            if (state && settings.acceptAssignments && !accepted)
              writeAgentState(mailbox, {
                ...state,
                lastAck: {
                  requestId: request.requestId,
                  accepted: false,
                  code: "identity",
                  message:
                    "Request was addressed to another Radar process incarnation",
                  acknowledgedAt: Date.now(),
                },
                updatedAt: Date.now(),
              });
            seen = request.requestId;
            if (settings.acceptAssignments && accepted)
              await daemon.onChildAccepted?.(request);
          })
          .catch(() => undefined)
          .finally(() => {
            processing = false;
          });
      } catch {
        // A child leaves malformed requests where they are, like a live one.
      }
    }, 10);
    timer.unref?.();
    mailboxes.set(spawn.request_id, () => {
      stopped = true;
      clearInterval(timer);
    });
  };

  /**
   * The address the answering child can be held to: the subject its first
   * presence was granted. Without one there is no address, which is what a
   * process no launch produced has.
   */
  const childAddress = (spawn: RadarFakeSpawn): RequestAddress | undefined =>
    spawn.subject_id === undefined ? undefined : { subject: spawn.subject_id };

  /**
   * The child's share of the launch, performed against the same private stores
   * the real child process writes: its binding sidecar, its mailbox state and,
   * after startup, its acknowledgment.
   */
  /**
   * One simulated child, start to acknowledgment. `reset` ends it wherever it
   * stands: a child that outlives its fixture must not leave state behind for
   * the next one, because a label's mailbox path is the same in every fixture.
   */
  const runChild = async (spawn: RadarFakeSpawn): Promise<void> => {
    let cancelled = false;
    children.push(() => {
      cancelled = true;
    });
    const alive = () => !cancelled;
    const session =
      (spawn.session_id !== undefined && spawn.session_file !== undefined
        ? { id: spawn.session_id, file: spawn.session_file } : undefined) ??
      daemon.childSession?.(spawn, spawns.indexOf(spawn)) ??
      (spawns.indexOf(spawn) === 0
        ? settings.session
        : {
            id: randomUUID(),
            file: `/tmp/registered-agent-${spawns.indexOf(spawn) + 1}.jsonl`,
          });
    await daemon.onChildStart?.(spawn);
    if (!alive()) return;
    const env = spawn.env;
    const runId = env.PI_HERDSMAN_RUN_ID;
    const ownerSessionId = env.PI_HERDSMAN_OWNER_SESSION_ID;
    const workspaceId = env.PI_HERDSMAN_WORKSPACE_ID;
    const agentLabel = env.PI_HERDSMAN_LABEL;
    const mailbox = env.PI_HERDSMAN_MAILBOX;
    if (
      spawn.cwd === undefined ||
      runId === undefined ||
      ownerSessionId === undefined ||
      workspaceId === undefined ||
      agentLabel === undefined ||
      mailbox === undefined
    )
      return;
    spawn.mailbox = mailbox;
    spawn.agent_id = subjectId(RADAR_SUBJECT_SOURCE, spawn.incarnation);
    spawn.session_id = session.id;
    spawn.session_file = session.file;
    // The child registers the location its own TMUX_PANE names: this pane, and
    // publishes the session it runs as its current context.
    subjects.set(spawn.agent_id, {
      ...subjects.get(spawn.agent_id),
      location: locationOf(spawn),
      contextSession: session.id,
    });
    spawn.subject_id = subjectId("session", session.id);
    spawn.bound_at = new Date().toISOString();
    bound.add(spawn.request_id);
    const state: ManagedAgentState = {
      version: 5,
      runId,
      ownerSessionId,
      workspaceId,
      agentLabel,
      paneId: settings.childPane ?? spawn.env.TMUX_PANE,
      piSessionId: session.id,
      piSessionFile: session.file,
      agentDefinition: env.PI_HERDSMAN_AGENT_DEFINITION ?? "agent",
      cwd: spawn.cwd,
      updatedAt: Date.now(),
    };
    const { writeAgentState } = await loadMailbox();
    writeAgentState(mailbox, state);
    await consume(spawn, mailbox);
    await daemon.onChildState?.(spawn);
    if (!alive()) return;
  };

  /**
   * A retained child's own share, performed once for a launch that already
   * happened: the child registers with its launch's subject, writes the binding
   * and mailbox the owner holds it by, acknowledges its launch, and consumes
   * the assignments it is next given.
   */
  const adoptRetainedChild = async (
    options: RetainedChildOptions,
  ): Promise<RetainedLaunchRecord> => {
    const definition = options.definition ?? "agent";
    const spawn: RadarFakeSpawn = {
      request_id: randomUUID(),
      parent: options.ownerSessionId,
      parent_session_id: options.ownerSessionId,
      executable: "pi",
      argv: [],
      cwd: options.cwd ?? "/tmp",
      env: {
        PI_HERDSMAN_RUN_ID: options.runId,
        PI_HERDSMAN_OWNER_SESSION_ID: options.ownerSessionId,
        PI_HERDSMAN_WORKSPACE_ID: options.workspaceId,
        PI_HERDSMAN_LABEL: options.label,
        PI_HERDSMAN_MAILBOX: options.mailbox,
        PI_HERDSMAN_AGENT_DEFINITION: definition,
        // tmux sets TMUX_PANE in every pane it creates: the child's raw pane.
        TMUX_PANE: options.pane.slice(options.pane.lastIndexOf(":") + 1),
      },
      pane: options.pane,
      incarnation: randomUUID(),
      token: randomUUID(),
    };
    spawns.push(spawn);
    await runChild(spawn);
    if (spawn.agent_id === undefined)
      throw new Error("the retained child did not register with the daemon");
    return {
      stage: "bound",
      requestId: spawn.request_id,
      runId: options.runId,
      label: options.label,
      ownerSessionId: options.ownerSessionId,
      workspaceId: options.workspaceId,
      mailbox: options.mailbox,
      subjectId: spawn.subject_id!,
      piSessionId: spawn.session_id!,
      paneId: options.pane,
      agentDefinition: definition,
    };
  };

  /**
   * The mux this fixture models, observed as the daemon would observe it.
   *
   * A live daemon reports the pane a process is actually in, so the fixture
   * reports the pane this process's own environment names, with the containment
   * that environment carries. A test that needs a different topology - a pane
   * that is absent, or one the process is not in - sets `inventory` instead of
   * relying on this default.
   */
  /**
   * The fleet this daemon observes when the fixture models no fleet of its own.
   *
   * It is this process's own pane, which is where the terminal put it. A fixture
   * that owns a fleet - the Herdsman mailbox model, or a test's own topology -
   * supplies `observeInventory` or `options.inventory` instead.
   */
  function observedFleet(): {
    workspaces: unknown[];
    tabs: unknown[];
    panes: unknown[];
    agents: unknown[];
  } {
    const pane = process.env.TMUX_PANE?.trim();
    if (!pane) return { workspaces: [], tabs: [], panes: [], agents: [] };
    const handle = `tmux:${FIXTURE_TMUX_SERVER}:${pane}`;
    const workspace = FIXTURE_WORKSPACE;
    const tab = `${FIXTURE_WORKSPACE}:t1`;
    return {
      workspaces: [{ workspace_id: workspace }],
      tabs: [{ tab_id: tab, workspace_id: workspace }],
      panes: [{ location: { workspace_id: workspace, tab_id: tab, pane_id: handle } }],
      agents: [],
    };
  }

  const unavailable = () => ({ ok: false as const, code: "refused" as const, message: "port not configured by this test" });
  const publicationClient = {
    async ping() {
      return { ok: true as const, value: {
        protocol: RADAR_PROTOCOL_VERSION, revision: RADAR_MINIMUM_REVISION,
        backend: settings.backend, instance: settings.instance,
        contracts: settings.contracts, tasks: { available: true, error: null },
      } };
    },
    async presence(report) {
      const registration_id = report.registration_id ?? subjectId(report.source, report.incarnation);
      registerCalls.push({ agent_id: registration_id, params: { ...report } });
      subjects.set(registration_id, { source: report.source, incarnation: report.incarnation,
        session: report.session_id, location: report.location });
      const standing = settings.standing ?? "granted";
      return { ok: true as const, value: {
        registration_id, claim_id: report.claim_id, standing,
        ...(standing === "granted" ? { subject_id: subjectId("session", report.session_id) } : {}),
      } };
    },
    async releasePresence(request) {
      return { ok: true as const, value: {
        registration_id: request.registration_id, claim_id: request.claim_id, standing: "released" as const,
      } };
    },
    async acquire(request) {
      return { ok: true as const, value: {
        handle: randomUUID(), source: request.publisher.source,
        incarnation: request.publisher.incarnation, generation: 1, sequence: 0,
      } };
    },
    async publish(request) {
      published.push({ agent_id: request.registration_id, channel: request.channel,
        snapshot: request.snapshot, observed_at: request.observed_at });
      return { ok: true as const, value: { sequence: request.sequence } };
    },
    async retire() { return { ok: true as const, value: undefined }; },
  } satisfies RadarPublicationClient;

  function inventory(): RadarInventory {
    const raw = settings.inventory ?? daemon.observeInventory?.() ?? observedFleet();
    const location = (value: unknown) => {
      const row = value as { location?: RadarInventory["panes"][number] };
      return row.location ?? value as RadarInventory["panes"][number];
    };
    return {
      workspaces: raw.workspaces as RadarInventory["workspaces"],
      tabs: raw.tabs as RadarInventory["tabs"],
      panes: raw.panes.map(location),
      agents: raw.agents.map((value) => {
        const row = value as RadarInventory["agents"][number] & {
          location?: RadarInventory["panes"][number]; managed?: { label?: string; run?: string };
        };
        return { ...row, ...location(row), managed_label: row.managed?.label ?? row.managed_label,
          managed_run: row.managed?.run ?? row.managed_run };
      }),
    };
  }

  const client = {
    ...publicationClient,
    socketPath: () => socketPath,
    register: async () => unavailable(),
    context: async () => unavailable(),
    async spawn(request) {
      if (settings.crashSpawn) return { ok: false as const, code: "internal" as const, message: "fixture transport failed" };
      if (settings.refuseSpawn) return { ok: false as const, ...settings.refuseSpawn };
      const pane = paneFor(spawns.length + 1);
      const continued = request.continue_subject_id === undefined ? undefined :
        [...spawns].reverse().find((item) => item.subject_id === request.continue_subject_id);
      if (request.continue_subject_id !== undefined && continued === undefined)
        return { ok: false as const, code: "not_found" as const, message: "no released child has this subject" };
      const spawn: RadarFakeSpawn = {
        request_id: request.request_id, parent: request.parent,
        parent_session_id: request.parent_session_id, executable: request.executable,
        argv: request.argv, cwd: request.cwd, managed: request.managed,
        pane, incarnation: randomUUID(), token: "",
        env: { ...request.env, TMUX_PANE: pane.slice(pane.lastIndexOf(":") + 1),
          ...(request.managed?.parent_subject_id
            ? { PI_RADAR_MANAGED_PARENT_SUBJECT_ID: request.managed.parent_subject_id } : {}) },
      };
      if (continued !== undefined) {
        spawn.session_id = continued.session_id;
        spawn.session_file = continued.session_file;
        spawn.continues = continued.subject_id;
      }
      spawns.push(spawn);
      if (settings.bind) void runChild(spawn).catch(() => undefined);
      if (settings.dropSpawnReply) return { ok: false as const, code: "internal" as const, message: "reply lost" };
      return { ok: true as const, value: edge(spawn) };
    },
    async spawnGet(requestId) {
      const spawn = spawns.find((item) => item.request_id === requestId);
      return spawn ? { ok: true as const, value: topology(spawn) } :
        { ok: false as const, code: "not_found" as const, message: "unknown fixture launch" };
    },
    async spawnList() {
      return { ok: true as const, value: { next: null, spawns: spawns.map((spawn) => {
        const view = topology(spawn);
        return {
          ...view.edge, state: view.state ?? "unbound", freshness: view.freshness,
          version: 1, recorded_at: new Date().toISOString(),
          granted_at: view.edge.granted_at ?? null,
          withdrawn: view.edge.withdrawn ?? null,
          exit_observation: view.edge.exit_observation ?? null,
          bound: view.edge.bound ? { ...view.edge.bound, bound_at: spawn.bound_at } : null,
        };
      }) } } as never;
    },
    async restart(request) {
      const previous = [...spawns].reverse().find((item) => item.subject_id === request.subject_id);
      if (!previous) return { ok: false as const, code: "not_found" as const, message: "no live child has this subject" };
      previous.closed = true; mailboxes.get(previous.request_id)?.();
      const launch = randomUUID();
      const pane = paneFor(spawns.length + 1);
      const spawn: RadarFakeSpawn = { ...previous, request_id: launch, closed: false, processGone: false,
        executable: request.executable, argv: request.argv, cwd: request.cwd, pane,
        incarnation: randomUUID(), agent_id: undefined, subject_id: undefined,
        env: { ...previous.env, ...request.env, TMUX_PANE: pane.slice(pane.lastIndexOf(":") + 1) } };
      spawns.push(spawn);
      if (settings.bind) void runChild(spawn).catch(() => undefined);
      return { ok: true as const, value: { request_id: request.request_id, launch_request_id: launch } };
    },
    async agentGet(registrationId) {
      const registration = subjects.get(registrationId);
      if (!registration) return { ok: false as const, code: "not_found" as const, message: "unknown fixture child" };
      const spawn = spawns.find((item) => item.agent_id === registrationId);
      const execution = published.filter((entry) => entry.agent_id === registrationId && entry.channel === "execution").at(-1);
      const age = execution?.observed_at ? Date.now() - Date.parse(execution.observed_at) : Infinity;
      const activity = age >= 0 && age <= 30_000 ?
        (execution?.snapshot as { activity?: string } | undefined)?.activity : undefined;
      return { ok: true as const, value: {
        claimed: settings.childProcessClaim,
        verification: !settings.childProcessClaim ? "unavailable" as const :
          settings.processVerdict ?? (spawn?.closed || spawn?.processGone ? "absent" as const : "verified" as const),
        location: registration.location as RadarLocation | undefined,
        session: registration.session as string | undefined,
        contextSession: (registration.contextSession ?? registration.session) as string | undefined,
        activity,
      } };
    },
    async childGet(subjectId) {
      const spawn = [...spawns].reverse().find((item) => item.subject_id === subjectId);
      if (!spawn) return { ok: false as const, code: "not_found" as const, message: "unknown fixture child" };
      const ended = spawn.closed || spawn.processGone ||
        (settings.childProcessClaim && settings.processVerdict === "absent");
      const present = settings.locationEvidence === "present" && !settings.observeUnavailable;
      return { ok: true as const, value: {
        assignment: null, execution: null, facts: null,
        location: present && !spawn.closed ? (locationOf(spawn) as never) : null,
        managed: { label: spawn.mailbox, run: undefined },
        scoped: null, session_id: spawn.session_id ?? null,
        state: !bound.has(spawn.request_id) ? "starting" as const :
          ended ? "detached" as const :
          settings.childProcessClaim && settings.processVerdict !== "mismatched" &&
            settings.processVerdict !== "unavailable" ? "live" as const : "unknown" as const,
        subject_id: subjectId,
      } };
    },
    childInspect: async () => unavailable(),
    async subjectChildren(request) {
      const ids = [...new Set(spawns.map((spawn) => spawn.subject_id).filter((id): id is string => id !== undefined))];
      const subjects = [];
      for (const id of ids) {
        const read = await client.childGet(id);
        if (read.ok && (request.selection === undefined || request.selection === "all" ||
          (request.selection === "live" ? read.value.state === "live" : read.value.state === "detached")))
          subjects.push(read.value);
      }
      return { ok: true as const, value: { next: null, subjects } };
    },
    async observe() {
      observesStarted++;
      const gate = observeGate, hold = observeHold;
      observeGate = undefined; observeHold = undefined;
      const value = settings.observeUnavailable ? undefined : inventory();
      await gate;
      if (hold) hold.written = true;
      observesCompleted++;
      return value ? { ok: true as const, value } :
        { ok: false as const, code: "backend_unavailable" as const, message: "the backend could not be read" };
    },
    async childClose(request) {
      const gate = closeGate, hold = closeHold;
      closeGate = undefined; closeHold = undefined; hold?.arrive();
      const spawn = [...spawns].reverse().find((item) => item.subject_id === request.subject_id);
      const previous = closes.get(request.request_id);
      let value: RadarCloseOutcome;
      if (previous) value = previous as RadarCloseOutcome;
      else if (!settings.contracts.includes(RADAR_SPAWN_CLOSE_CONTRACT))
        return { ok: false as const, code: "backend_unavailable" as const, message: "managed close is unavailable" };
      else if (!spawn || !bound.has(spawn.request_id) ||
        !settings.childProcessClaim || settings.locationEvidence !== "present" || spawn.closed)
        return { ok: false as const, code: "refused" as const, message: "fixture child is not eligible for close" };
      else {
        value = settings.refuseChildClose ? { outcome: "refused", message: "the backend refused this close" } :
          { outcome: settings.closeOutcome, pane: spawn.pane,
            ...(settings.closeOutcome === "already_exited" ? {
              exit_observation: { state: "exited" as const, code: 0, observed_at: new Date().toISOString() },
            } : {}) };
        closes.set(request.request_id, { ...value, intent: request.intent });
        if (!settings.refuseChildClose) { spawn.closed = true; mailboxes.get(spawn.request_id)?.(); }
      }
      await gate;
      if (hold) hold.written = true;
      if (settings.dropCloseReply) return { ok: false as const, code: "outcome_unknown" as const, message: "reply lost" };
      return { ok: true as const, value };
    },
    async events(request) {
      const expired = (request.epoch !== undefined && request.epoch !== journal.epoch) || journal.earliest > request.after + 1;
      const sequence = nextSequence - 1;
      if (!expired && sequence <= request.after && request.wait_ms > 0)
        await new Promise<void>((resolve) => setTimeout(resolve, request.wait_ms).unref());
      return { ok: true as const, value: expired ?
        { kind: "expired" as const, epoch: journal.epoch, sequence } :
        { kind: "page" as const, epoch: journal.epoch, sequence, more: false } };
    },
    focus: async (request) => ({ ok: true as const, value: { request_id: request.request_id } }),
    output: async () => ({ ok: true as const, value: { text: "", truncated: false } }),
    processInfo: async () => ({ ok: true as const, value: { kind: "shell" as const } }),
    communicationPublish: async () => unavailable(),
    communicationInbox: async () => unavailable(),
    communicationGet: async () => unavailable(),
    communicationAck: async () => unavailable(),
  } satisfies RadarClient;
  clients.set(socketPath, client);

  return {
    socketPath,
    client,
    closes,
    registerCalls,
    options: settings,
    creationOptions: () => ({ ...initial }),
    spawns,
    subjects,
    published,
    adoptRetainedChild,
    appendEvent(kind, subject = {}) {
      const sequence = nextSequence++;
      journal.events.push({
        seq: sequence,
        kind,
        ...subject,
        at: new Date().toISOString(),
      });
      return sequence;
    },
    restartJournal,
    dropEventsBefore(sequence) {
      journal.earliest = sequence;
      journal.events = journal.events.filter(
        (event) => (event.seq as number) >= sequence,
      );
    },
    holdNextObserve() {
      const released = Promise.withResolvers<void>();
      const hold: ReplyHold = { written: false, arrive: () => undefined };
      observeGate = released.promise;
      observeHold = hold;
      return {
        release: () => released.resolve(),
        replyWritten: () => hold.written,
      };
    },
    vanishPane(spawn) {
      spawn.closed = true;
      mailboxes.get(spawn.request_id)?.();
    },
    exitProcess(spawn) {
      spawn.processGone = true;
      mailboxes.get(spawn.request_id)?.();
    },
    holdNextClose() {
      let release!: () => void;
      let arrive!: () => void;
      const arrived = new Promise<void>((resolve) => (arrive = resolve));
      const hold: ReplyHold = { written: false, arrive: () => arrive() };
      closeGate = new Promise<void>((resolve) => (release = resolve));
      closeHold = hold;
      return {
        arrived,
        release: () => release(),
        replyWritten: () => hold.written,
      };
    },
    get observeInventory() {
      return daemon.observeInventory;
    },
    set observeInventory(handler) {
      daemon.observeInventory = handler;
    },
    get onChildStart() {
      return daemon.onChildStart;
    },
    set onChildStart(handler) {
      daemon.onChildStart = handler;
    },
    get onChildState() {
      return daemon.onChildState;
    },
    set onChildState(handler) {
      daemon.onChildState = handler;
    },
    get onChildRequest() {
      return daemon.onChildRequest;
    },
    set onChildRequest(handler) {
      daemon.onChildRequest = handler;
    },
    get onChildAccepted() {
      return daemon.onChildAccepted;
    },
    set onChildAccepted(handler) {
      daemon.onChildAccepted = handler;
    },
    get childSession() {
      return daemon.childSession;
    },
    set childSession(session) {
      daemon.childSession = session;
    },
    reset() {
      // A test that changed one setting does not change the next one's daemon.
      // Settings a test added are dropped too: the defaults do not carry every
      // optional key, so assigning them over the caller's object would leave a
      // later test running with the previous one's pane.
      for (const key of Object.keys(settings))
        if (!(key in initial)) delete (settings as Record<string, unknown>)[key];
      Object.assign(settings, DEFAULTS, initial);
      for (const cancel of children) cancel();
      children.length = 0;
      for (const stop of mailboxes.values()) stop();
      mailboxes.clear();
      spawns.length = 0;
      observeGate = undefined;
      observeHold = undefined;
      restartJournal("journal-1");
      bound.clear();
      closes.clear();
      closeContents.clear();
      registerCalls.length = 0;
    },
    async close() {
      for (const cancel of children) cancel();
      children.length = 0;
      for (const stop of mailboxes.values()) stop();
      mailboxes.clear();
      clients.delete(socketPath);
    },
  };
}
