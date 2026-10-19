import { randomUUID } from "node:crypto";
import { chmodSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type RadarChannel,
  type RadarErrorCode,
  RADAR_EVENTS_CONTRACT,
  RADAR_MINIMUM_REVISION,
  RADAR_PROTOCOL_VERSION,
  RADAR_REGISTRY_CONTRACT,
  RADAR_REGISTRY_FACTS_CONTRACT,
  RADAR_SPAWN_CLOSE_CONTRACT,
  RADAR_SPAWN_CONTRACT,
  RADAR_SPAWN_LAUNCH_CONTEXT_CONTRACT,
} from "pi-radar/client";
import {
  RADAR_PUBLICATION_VERSION,
  radarBindingKey,
} from "pi-radar/publication";
import { RADAR_SUBJECT_SOURCE } from "pi-radar/execution";
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
 * state, acknowledges the launch generation it was spawned with, and accepts the
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
  /** The Pi session the simulated child published as its current context. */
  session_id?: string;
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
  /** The launch generation the child acknowledged; minted when omitted. */
  generation?: string;
};

/**
 * The durable launch record an adopted child's own launch would have left in
 * the owner's session, in the shape that session's readers hold it by.
 */
export type RetainedLaunchRecord = {
  stage: "bound";
  requestId: string;
  generation: string;
  runId: string;
  label: string;
  ownerSessionId: string;
  workspaceId: string;
  mailbox: string;
  agentId: string;
  paneId: string;
  agentDefinition: string;
};

export type FakeRadarDaemon = {
  socketPath: string;
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
  const socketPath = join(directory, "control.sock");
  const spawns: RadarFakeSpawn[] = [];
  const subjects = new Map<string, Record<string, unknown>>();
  const published: Array<{
    agent_id: string;
    channel: RadarChannel;
    snapshot: unknown;
    observed_at?: string;
  }> = [];
  const registrations = new Map<string, string>();
  const tokens = new Map<string, RadarFakeSpawn>();
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
  const locationOf = (spawn: RadarFakeSpawn) => ({
    backend: settings.backend,
    instance: settings.instance ?? undefined,
    pane: spawn.pane,
  });
  const edge = (spawn: RadarFakeSpawn): Record<string, unknown> => {
    const isBound = bound.has(spawn.request_id) && spawn.agent_id !== undefined;
    return {
      version: 2,
      request_id: spawn.request_id,
      parent: spawn.parent,
      parent_session_id: spawn.parent_session_id,
      recorded_at: new Date().toISOString(),
      created: "completed",
      launched: "completed",
      location: locationOf(spawn),
      ...(isBound
        ? {
            bound: {
              source: RADAR_SUBJECT_SOURCE,
              incarnation: spawn.incarnation,
              agent_id: spawn.agent_id,
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
  const topology = (spawn: RadarFakeSpawn): Record<string, unknown> => {
    const isBound = bound.has(spawn.request_id) && spawn.agent_id !== undefined;
    const absent =
      settings.locationEvidence === "absent" || spawn.closed === true;
    // Version 2 flattens the edge into the read and adds only what the read
    // itself derived, so the two derived fields sit beside the record.
    return {
      ...edge(spawn),
      state: absent ? "unresolved" : isBound ? "bound" : "unbound",
      // An unreadable backend inventory leaves every recorded location stale, as
      // the daemon reports it, even where the pane itself is not in question.
      freshness:
        settings.locationEvidence === "present" &&
        !absent &&
        !settings.observeUnavailable
          ? "fresh"
          : "stale",
    };
  };

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
   * The address the answering process can be held to: the subject this child's
   * registration produced, the source its registration names, the incarnation
   * its own process holds - another one when a test says another process answers
   * this mailbox - and the generation its launch exported. Without a subject or a
   * generation there is no address, which is what a process no launch produced
   * has.
   */
  const childAddress = (spawn: RadarFakeSpawn): RequestAddress | undefined => {
    const generation = spawn.env.PI_HERDSMAN_LAUNCH_GENERATION;
    if (spawn.agent_id === undefined || generation === undefined)
      return undefined;
    return {
      subject: spawn.agent_id,
      source: RADAR_SUBJECT_SOURCE,
      incarnation: settings.responderIncarnation ?? spawn.incarnation,
      generation,
    };
  };

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
    const generation = env.PI_HERDSMAN_LAUNCH_GENERATION;
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
    // The child registers the location its own TMUX_PANE names: this pane, and
    // publishes the session it runs as its current context.
    subjects.set(spawn.agent_id, {
      ...subjects.get(spawn.agent_id),
      location: locationOf(spawn),
      contextSession: session.id,
    });
    bound.add(spawn.request_id);
    const bindings = join(herdsmanDataRoot(), "radar", "bindings");
    // The publication store validates the directory it reads from, so the
    // child's sidecar has to live in the same private namespace the owner reads
    // rather than merely at the same path.
    mkdirSync(bindings, { recursive: true, mode: 0o700 });
    chmodSync(bindings, 0o700);
    writeFileSync(
      join(bindings, `${radarBindingKey(runId, ownerSessionId, agentLabel)}.json`),
      `${JSON.stringify({
        version: RADAR_PUBLICATION_VERSION,
        agent_id: spawn.agent_id,
        incarnation: spawn.incarnation,
        run: runId,
        owner: ownerSessionId,
        label: agentLabel,
        observed_at: new Date().toISOString(),
      })}\n`,
      // The owner's store validates the record it reads: same private mode it
      // writes, or the child's sidecar is not a record the owner can use.
      { mode: 0o600 },
    );
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
    const { writeAgentState, writeStartupAck } = await loadMailbox();
    writeAgentState(mailbox, state);
    await consume(spawn, mailbox);
    await daemon.onChildState?.(spawn);
    if (!alive()) return;
    if (generation === undefined || !settings.acknowledge) return;
    try {
      writeStartupAck(mailbox, {
        generation,
        runId,
        ownerSessionId,
        workspaceId,
        agentLabel,
        paneId: settings.childPane ?? spawn.env.TMUX_PANE,
        piSessionId: session.id,
        acknowledgedAt: Date.now(),
      });
    } catch {
      // A child whose acknowledgment cannot be written has not acknowledged
      // startup, which is a launch outcome tests drive through this fixture.
    }
  };

  /**
   * A retained child's own share, performed once for a launch that already
   * happened: the child registers with its launch's subject, writes the binding
   * and mailbox the owner holds it by, acknowledges its generation, and consumes
   * the assignments it is next given.
   */
  const adoptRetainedChild = async (
    options: RetainedChildOptions,
  ): Promise<RetainedLaunchRecord> => {
    const generation = options.generation ?? randomUUID();
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
        PI_HERDSMAN_LAUNCH_GENERATION: generation,
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
      generation,
      runId: options.runId,
      label: options.label,
      ownerSessionId: options.ownerSessionId,
      workspaceId: options.workspaceId,
      mailbox: options.mailbox,
      agentId: spawn.agent_id,
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

  const answer = (
    method: string,
    params: Record<string, unknown>,
    requestId: string,
  ): { result?: unknown; error?: { code: string; message: string } } => {
    switch (method) {
      case "daemon.ping":
        return {
          result: {
            protocol: RADAR_PROTOCOL_VERSION,
            revision: RADAR_MINIMUM_REVISION,
            backend: settings.backend,
            instance: settings.instance,
            contracts: settings.contracts,
            tasks: { available: true, error: null },
          },
        };
      case "agent.register": {
        const source = String(params.source);
        const incarnation = String(params.incarnation);
        const agentId = subjectId(source, incarnation);
        // A child presents the one-use token its spawn minted; that token is the
        // only thing that binds the edge to this exact registration.
        registerCalls.push({ agent_id: agentId, params: { ...params } });
        // The registry keeps the location and session a subject registered with;
        // agent.get answers the registration from them.
        subjects.set(agentId, {
          ...subjects.get(agentId),
          location: params.location,
          session: params.session,
        });
        const token = params.spawn_token;
        if (typeof token === "string") {
          const spawn = tokens.get(token);
          if (spawn === undefined)
            return {
              error: { code: "refused", message: "unknown or spent spawn token" },
            };
          tokens.delete(token);
          spawn.agent_id = agentId;
          bound.add(spawn.request_id);
        }
        return { result: { registration: { agent_id: agentId } } };
      }
      case "agent.acquire":
      case "agent.context": {
        const agentId = String(params.agent_id);
        if (!subjects.has(agentId))
          return { error: { code: "not_found", message: "unknown agent" } };
        return {
          result: {
            writer: writerOf(agentId, String(params.channel ?? "context")),
          },
        };
      }
      case "agent.publish": {
        const agentId = String(params.agent_id);
        published.push({
          agent_id: agentId,
          channel: String(params.channel) as RadarChannel,
          snapshot: params.snapshot,
          ...(typeof params.observed_at === "string"
            ? { observed_at: params.observed_at }
            : {}),
        });
        return {
          result: {
            channel: {
              writer: { ...writerOf(agentId, String(params.channel)) },
            },
          },
        };
      }
      case "agent.retire":
        return { result: { retired: true } };
      case "spawn.create": {
        if (settings.crashSpawn) throw new Error("daemon crashed mid-spawn");
        const request = params.request as Record<string, unknown>;
        if (settings.refuseSpawn !== undefined)
          return { error: settings.refuseSpawn };
        const pane = paneFor(spawns.length + 1);
        const spawn: RadarFakeSpawn = {
          // The envelope id is the caller's durable key, exactly as the daemon's
          // own spawn record keeps it.
          request_id: requestId,
          parent: String(request.parent),
          parent_session_id: String(request.parent_session_id),
          executable: String(request.executable),
          argv: (request.argv as string[]) ?? [],
          ...(request.cwd !== undefined ? { cwd: String(request.cwd) } : {}),
          ...(typeof request.managed === "object" && request.managed !== null
            ? {
                managed: {
                  ...(typeof (request.managed as Record<string, unknown>).parent_subject_id === "string"
                    ? { parent_subject_id: String((request.managed as Record<string, unknown>).parent_subject_id) }
                    : {}),
                },
              }
            : {}),
          pane,
          // tmux sets TMUX_PANE in every pane it creates: the child's raw pane.
          env: {
            ...((request.env ?? {}) as Record<string, string>),
            ...(typeof (request.managed as Record<string, unknown> | undefined)?.parent_subject_id === "string"
              ? { PI_RADAR_MANAGED_PARENT_SUBJECT_ID: String((request.managed as Record<string, unknown>).parent_subject_id) }
              : {}),
            TMUX_PANE: pane.slice(pane.lastIndexOf(":") + 1),
          },
          incarnation: randomUUID(),
          token: randomUUID(),
        };
        tokens.set(spawn.token, spawn);
        spawns.push(spawn);
        if (settings.bind) void runChild(spawn).catch(() => undefined);
        if (settings.dropSpawnReply)
          return { error: { code: "internal", message: "reply lost" } };
        return { result: { spawn: edge(spawn) } };
      }
      case "spawn.get": {
        const spawn = spawns.find(
          (candidate) => candidate.request_id === String(params.request_id),
        );
        if (spawn === undefined)
          return { error: { code: "not_found", message: "unknown spawn" } };
        return { result: { spawn: topology(spawn) } };
      }
      case "spawn.list":
        return { result: { spawns: spawns.map((spawn) => topology(spawn)) } };
      case "agent.get": {
        const agentId = String(params.agent_id);
        const registration = subjects.get(agentId);
        if (registration === undefined)
          return { error: { code: "not_found", message: "unknown agent" } };
        const spawn = spawns.find((candidate) => candidate.agent_id === agentId);
        const verification = !settings.childProcessClaim
          ? "unavailable"
          : (settings.processVerdict ??
            (spawn?.closed === true || spawn?.processGone === true
              ? "absent"
              : "verified"));
        const executionPublication = published
          .filter((entry) => entry.agent_id === agentId && entry.channel === "execution")
          .at(-1);
        const publicationAge = executionPublication?.observed_at === undefined
          ? undefined
          : Date.now() - Date.parse(executionPublication.observed_at);
        const executionFreshness = executionPublication === undefined
          ? undefined
          : publicationAge !== undefined && publicationAge >= 0 && publicationAge <= 30_000
            ? "fresh"
            : "stale";
        return {
          result: {
            agent: {
              registration,
              process: { claimed: settings.childProcessClaim, verification },
              context:
                (registration.contextSession ?? registration.session) === undefined
                  ? null
                  : {
                      version: 1,
                      agent_id: agentId,
                      context: {
                        freshness: "fresh",
                        session: registration.contextSession ?? registration.session,
                      },
                    },
              ...(executionPublication === undefined
                ? {}
                : {
                    execution: {
                      snapshot: {
                        freshness: executionFreshness,
                        snapshot: executionPublication.snapshot,
                      },
                    },
                  }),
            },
          },
        };
      }
      case "mux.observe":
        if (settings.observeUnavailable)
          return {
            error: {
              code: "backend_unavailable",
              message: "the backend could not be read",
            },
          };
        return {
          result: {
            inventory: settings.inventory ?? daemon.observeInventory?.() ?? observedFleet(),
          },
        };
      case "spawn.close": {
        // The daemon's own rule: a backend that cannot observe the pane's
        // foreground process, or cannot close it, refuses here rather than being
        // trusted on pane presence alone.
        if (!settings.contracts.includes(RADAR_SPAWN_CLOSE_CONTRACT))
          return {
            error: {
              code: "backend_unavailable",
              message: "the backend cannot verify and close a managed pane",
            },
          };
        const spawn = spawns.find(
          (candidate) =>
            candidate.request_id === String(params.spawn_request_id),
        );
        const source = String(params.source);
        const incarnation = String(params.incarnation);
        const intent = String(params.intent);
        // The caller's own UUID keys the durable record. An identical replay
        // returns the stored outcome without re-verification or a second
        // effect; different content under the same id refuses.
        const content = JSON.stringify([
          String(params.spawn_request_id),
          source,
          incarnation,
          intent,
        ]);
        const recorded = closes.get(requestId);
        if (recorded !== undefined)
          return closeContents.get(requestId) === content
            ? { result: { close: recorded } }
            : {
                error: {
                  code: "bad_request",
                  message: "this close id already carries another request",
                },
              };
        // Eligibility is the daemon's own: a bound edge, that exact child, its
        // process claim, and current evidence for the pane it recorded. Every
        // refusal lands before any pane effect, exactly as the contract puts it.
        if (spawn === undefined || !bound.has(spawn.request_id))
          return {
            error: {
              code: "refused",
              message: "the spawn edge is not bound to a child",
            },
          };
        if (
          spawn.agent_id !== subjectId(source, incarnation) ||
          spawn.incarnation !== incarnation
        )
          return {
            error: {
              code: "refused",
              message: "the edge is not bound to that child",
            },
          };
        if (!settings.childProcessClaim)
          return {
            error: {
              code: "refused",
              message: "the bound child has no process identity claim",
            },
          };
        if (settings.locationEvidence !== "present" || spawn.closed === true)
          return {
            error: {
              code: "refused",
              message: "no current foreground evidence for the recorded pane",
            },
          };
        if (settings.refuseChildClose) {
          const close = {
            outcome: "refused",
            intent,
            message: "the backend refused this close",
          };
          closes.set(requestId, close);
          closeContents.set(requestId, content);
          return { result: { close } };
        }
        // The daemon's dead-pane path: a pane whose command had exited has no
        // occupant to protect, so its retained pane is cleaned up and answered
        // with the exit the edge held. That is a pane fact, never a verdict on
        // the registered process.
        if (settings.closeOutcome === "already_exited") {
          const close = {
            outcome: "already_exited",
            intent,
            pane: spawn.pane,
            exit_observation: {
              state: "exited",
              code: 0,
              observed_at: new Date().toISOString(),
            },
          };
          closes.set(requestId, close);
          closeContents.set(requestId, content);
          spawn.closed = true;
          mailboxes.get(spawn.request_id)?.();
          if (settings.dropCloseReply)
            return { error: { code: "outcome_unknown", message: "reply lost" } };
          return { result: { close } };
        }
        const close = { outcome: "completed", intent, pane: spawn.pane };
        closes.set(requestId, close);
        closeContents.set(requestId, content);
        spawn.closed = true;
        mailboxes.get(spawn.request_id)?.();
        if (settings.dropCloseReply)
          return { error: { code: "outcome_unknown", message: "reply lost" } };
        return { result: { close } };
      }
      case "events.read": {
        const after = Number(params.after ?? 0);
        const tail = nextSequence - 1;
        if (
          (params.epoch !== undefined && params.epoch !== journal.epoch) ||
          journal.earliest > after + 1
        )
          return {
            result: {
              cursor_expired: {
                epoch: journal.epoch,
                cursor: { epoch: journal.epoch, sequence: tail },
                earliest: journal.earliest,
              },
            },
          };
        const events = journal.events
          .filter((event) => (event.seq as number) > after)
          .slice(0, Number(params.limit ?? 100));
        const last = events.length
          ? (events[events.length - 1].seq as number)
          : after;
        return {
          result: {
            epoch: journal.epoch,
            events,
            cursor: { epoch: journal.epoch, sequence: last },
            tail,
            more: last < tail,
            earliest: journal.earliest,
          },
        };
      }
      case "mux.focus": {
        return { result: { request_id: params.request_id, outcome: "completed" } };
      }
      case "mux.process_info":
        return { result: { evidence: { kind: "shell" } } };
      case "mux.output":
        return { result: { output: { text: "", truncated: false } } };
      default:
        return {
          error: { code: "not_found", message: `unknown method ${method}` },
        };
    }
  };

  const server: Server = createServer((socket) => {
    let buffer = "";
    let servedObserve = false;
    socket.on("close", () => {
      if (servedObserve) observesCompleted++;
    });
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let end = buffer.indexOf("\n");
      while (end >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        end = buffer.indexOf("\n");
        let reply: Record<string, unknown>;
        let gate: Promise<void> | undefined;
        let hold: ReplyHold | undefined;
        try {
          const envelope = JSON.parse(line) as {
            id?: unknown;
            method?: unknown;
            params?: unknown;
          };
          if (envelope.method === "mux.observe") {
            servedObserve = true;
            observesStarted++;
            gate = observeGate;
            hold = observeHold;
            observeGate = undefined;
            observeHold = undefined;
          }
          if (envelope.method === "spawn.close") {
            gate = closeGate;
            hold = closeHold;
            closeGate = undefined;
            closeHold = undefined;
            hold?.arrive();
          }
          const outcome = answer(
            String(envelope.method),
            (envelope.params ?? {}) as Record<string, unknown>,
            String(envelope.id),
          );
          reply =
            outcome.error !== undefined
              ? { id: envelope.id, error: outcome.error }
              : { id: envelope.id, result: outcome.result };
          // A long poll holds its empty page for the requested wait, as the daemon
          // does. An event appended during the hold reaches the next read.
          const wait = Number((envelope.params as { wait_ms?: unknown })?.wait_ms ?? 0);
          const page = outcome.result as { events?: unknown[] } | undefined;
          if (envelope.method === "events.read" && wait > 0 && page?.events?.length === 0)
            gate = new Promise<void>((resolve) => setTimeout(resolve, wait).unref());
        } catch (error) {
          reply = {
            id: undefined,
            error: { code: "internal", message: String(error) },
          };
        }
        const write = () => {
          try {
            socket.write(`${JSON.stringify(reply)}\n`);
            if (hold) hold.written = true;
          } catch {
            // A client that stopped reading has its own failure to report.
          }
        };
        if (gate) void gate.then(write);
        else write();
      }
    });
    socket.on("error", () => undefined);
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  // A test daemon must never be the reason a suite cannot exit.
  server.unref();

  return {
    socketPath,
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
      tokens.clear();
      closes.clear();
      closeContents.clear();
      registerCalls.length = 0;
    },
    async close() {
      for (const cancel of children) cancel();
      children.length = 0;
      for (const stop of mailboxes.values()) stop();
      mailboxes.clear();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
