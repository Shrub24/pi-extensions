# Herdsman → Radar daemon publication — adoption recon

Read-only recon. No production, test, config, runtime, daemon or VCS state was
changed; the only write is this file. Nothing was executed against a live daemon
or a live Pi session, so every verdict below is a source-read verdict.

## Scope correction applied (owner, this task)

Publication target is **Radar only**. No Herdr compatibility mirroring is built
in this port unless a concrete, indispensable current dependency is proven. The
native Herdr Pi reporter is inventoried to **preserve behaviour**, not to keep
its transport. Physical launch/stop/resume stays outside the port and is not a
publication concern. `pi-subagents` is excluded.

Consequence: Herdsman's existing Herdr pane-metadata mirror is **not** a template
and is **not** duplicated; every Herdr read in this document appears only as a
transition gap that the port must not break.

## Owner corrections after recon

Radar owner clarified against implementation pin `92ea9d37` (reference correction pushed as
`4af0ff6b`, docs only): `agent.list` already supports `after`/`next` pagination, so claims below that
its 100-row bound makes full discovery unavailable are retracted. Registration pruning remains deferred.
For a live process that switches sessions, register stable process facts and omit mutable session/context
fields; do not mint a fictitious process incarnation. Mutable source-labelled context is a real follow-up
gap. Passing exact agent_id plus birth/run identity through a Herdsman-local sidecar is confirmed.
The owner's adoption plan in this directory incorporates these corrections and supersedes the proposals
below where they conflict.

## Pins and verification

| Item | Value |
| --- | --- |
| Radar repo | `/home/saurabhj/Projects/dev/agent-radar`, HEAD `92ea9d37fdabafae88b1b41dfc7964b657d6c911` ("Add mux daemon, direct agent registry and consumer contracts"), working tree clean |
| Attached Radar docs | Verified to be the pinned commit's docs: `git diff --stat HEAD -- docs` is empty, so `docs/daemon.md`, `docs/agent-registration.md`, `docs/agent-registration.fixture.jsonl`, `docs/control-plane.md`, `examples/agent-publisher/publisher.py` match the attachment byte-for-byte |
| Fork under change | `pi-extensions` @ `b27bf1dfd`; `pi-herdsman` 0.18.0 (59 modules in `pi-herdsman/extension/`) |
| Native reporter (deployed) | `/home/saurabhj/.pi/agent/extensions/herdr-agent-state.ts` — byte-identical (`diff` empty) to `/nix/store/aw00v1q07zw716ynzkaqih5wi7mnbc0q-herdr-0.9.3/share/herdr/integrations/pi/herdr-agent-state.ts`; header `HERDR_INTEGRATION_ID=pi`, `HERDR_INTEGRATION_VERSION=9` |
| Daemon implementation | `src/control_plane/registry.rs`, `registry/publication.rs`, `registry/process.rs`, `server.rs`, `ops.rs`, `protocol.rs`; model in `src/model.rs`, procfs in `src/procfs.rs` |

## 1. Native Herdr Pi reporter inventory

One file, one process lifetime, no persistence, fire-and-forget over Herdr's own
Unix socket (`HERDR_SOCKET_PATH`), never Radar.

| Behaviour | Anchor (deployed file) | Wire effect into Herdr |
| --- | --- | --- |
| Enable gate | `:22-26` | `HERDR_ENV === "1" && HERDR_SOCKET_PATH && HERDR_PANE_ID`; otherwise the extension is inert |
| Transport | `:28-56` | JSON line to the Herdr socket, 500 ms attempt then one 1500 ms retry, `unref`'d timer, all failures swallowed |
| Session report | `:110-127`, `:88-108` | `pane.report_agent_session {pane_id, source:"herdr:pi", agent:"pi", seq, session_start_source?, agent_session_path \| agent_session_id}` |
| Activity report | `:129-141` | `pane.report_agent {pane_id, source, agent:"pi", state, message?, seq, agent_session_*}` with `state ∈ {working, blocked, idle}` |
| Sequence | `:63-79` | `Date.now() * 1000`, monotonic per process — Herdr's sequence domain, unrelated to Radar's per-generation sequence |
| State precedence | `:172-193` | `blocked (count>0, last label) > working > idle`; identical `state+message` is not re-sent |
| Dialog blocking | `:195-215` | Hooks `herdr:blocked` `{active, label}`; counts nested dialogs, only for the root (TUI) session |
| Session start | `:217-232` | Gate `ctx.mode === "tui"` (comment: RPC/JSON/print are headless but still report `hasUI`); `rootSession = true`; reports the session, then `agentActive = ctx.isIdle() === false` and force-publishes, so an extension reload mid-run still reads working |
| Agent start | `:234-241` | Refresh session ref, report session, `working` |
| Agent settled | `:243-251` | Only when `ctx.isIdle() === true`: `idle`. (A non-idle settle — queued work, compaction continuation — stays `working`, which matches Pi 1.1.0's "settled is final, `agent_end` is not", recorded in `.pi-herdsman/pi-1.1.0-lifecycle-upstream.md`) |

**What the reporter does not publish:** task text, assignment/request identity,
run id, label, owner session, launch spec, process identity, model/context usage,
result or outcome, close/exit. Those facts exist only in Herdsman and are the
content of this port.

**Population it covers:** every Pi TUI session inside Herdr — operator leads,
unmanaged/standalone sessions and managed workers alike. It is not Herdsman-scoped.

## 2. Consumers of reporter facts today → transition gaps that block removal

These are the proven, indispensable dependencies; they are transition gaps, not
a mandate to mirror.

| Reporter fact | Consumer in this fork | Anchor |
| --- | --- | --- |
| `agent_session` on the Herdr agent record (from `report_agent_session`) | **Presence/identity proof**: the exact-match liveness test, session identity resolution, inspection | `index.ts:3574` `managedAgentPresence` (uses `matchesExpectedSession(agent.agent_session)` and pane `agent_session`); `herdr.ts:2101` `sessionIdentity`; `herdr.ts:2197` `matchesExpectedSession`; `herdr.ts:194-259` `inspectHerdrAgent`. 28 `agent_session` references in `index.ts`, 14 in `herdr.ts` |
| Registering at all (child appears in Herdr's registry) | **Launch readiness**: launch polls `herdr agent get <paneId>` until a registered agent exists and otherwise fails with "did not register with Herdr" | `herdr.ts:1543-1566` `waitForChildRegistration`, called from `runChildCommand` `herdr.ts:1512`; the reporter path is injected into the child argv at `herdr.ts:1491-1494` (`herdrReporterArgs`), resolved by `herdr.ts:122-125` |
| `agent_status ∈ {idle,working,blocked,done}` (from `report_agent`) | **Control state**: lifecycle word feeding the safe-control projection and therefore settlement/ownership decisions and the operator surface | `supervision.ts:2309-2317` `normalizeHerdrLifecycleState`; consumed via `index.ts:3060` (`lifecycleState`), `core.ts:514-549` `agentControlState`; three `agent_status` references in `index.ts`, four in `herdr.ts` |
| Reported state + Herdr metadata tokens | Operator surfaces: the Herdr sidebar/table plugin (`herdr-radar`), and Herdsman's own warning path when the reporter is missing | `index.ts:8508-8520` `preparePaneMetadata` notifies "Install the official Herdr Pi reporter…" |

**Removal verdict:** the reporter cannot be dropped in this port. Launch
readiness, presence proof and the control-state word all resolve through Herdr's
agent record; Radar has no equivalent consumable yet, and building one is an
execution-layer change (owner: out of scope). The port must therefore publish
*alongside*, be independent of the reporter's presence, and never read Herdr
registry facts back as publication authority.

## 3. Existing Herdsman publication surfaces and their disposition

| Surface | Transport | Disposition |
| --- | --- | --- |
| Durable mailbox state `ManagedAgentState` (`mailbox.ts:28-65`): `runId`, `ownerSessionId`, `workspaceId`, `agentLabel`, `paneId`, `piSessionId`/`piSessionFile`, `agentDefinition`, `cwd`, `activeRequestId`, `completedRequestId`, `pendingAskId`, `resultError`, `backgroundWaiting`, `lastActivityAt`, `updatedAt` | private files | **In port** — the identity/fact source. Read via `readAgentState` (`mailbox.ts:992`), `scanAgentStates` (`:221`) |
| Herdr pane-metadata mirror: worker `reportMetadata` `index.ts:2626-2678`, owner projection `publishOwnerStates` `index.ts:8432-8494`, lead role `publishLeadRole` `index.ts:9067-9098`, awaited facts, `pane-metadata.ts` (`METADATA_TTL_MS` 1 h, `OWNER_METADATA_TTL_MS` 30 s) | `herdr pane report-metadata` | **Out of port** (owner correction). Left untouched; used below only as evidence of which facts exist |
| `herdsman-control/v1` close/restart requests | filesystem only, `~/.pi/agent/pi-herdsman/control/<ownerSessionId>/{inbox,results}` (`control.ts:1-15`, `docs/reference/herdsman-control.md`) | Untouched. Remains the authority for managed close/restart; the Radar registry confers no lifecycle authority |
| Radar **bus** (per-task background detail) | `radar.sock`, `hello`/`tasks` stream, no ids (`pi-bash-processes/extensions/radar-bus.ts:1-90`, contract `agent-radar/docs/radar-bus.md`) | Untouched and **not the same socket**: bus resolves `RADAR_SOCKET` → `$XDG_RUNTIME_DIR/agent-radar/radar.sock`; the daemon control socket is `RADAR_CONTROL_SOCKET` → `…/agent-radar/control.sock`. Reuse its *discipline* (trust check, one connection, latest-only write, backoff, never blocking a turn), never its path resolver |
| Herdr adapter (launch `pane run` typed line, alias `agent rename`, presence `agent get`, events `events.subscribe` `herdr.ts:652-736`) | `herdr` CLI/socket | Stays for the duration of this port |

Prior accepted work worth reading before implementing: `.pi-herdsman/radar-publisher-result.md`
(bus publisher; the transport-discipline precedent and the vendored-fixture rule).

## 4. Fact → channel matrix for the first port

Evidence-based mapping only; every fact exists in Herdsman today.

| Fact | Herdsman source | Channel | Radar wire field | Gap / note |
| --- | --- | --- | --- | --- |
| Subject identity | `workspaceId`, `runId`, `agentLabel`, `ownerSessionId`, `piSessionId/File`, `paneId`, `cwd`, `agentDefinition` (`mailbox.ts:28-65`); `StartedHerdrAgent` for `tabId`/`terminalId`/`shellProcess` (`herdr.ts:53-67`) | registration | `session`, `owner`, `run`, `label`, `location.{backend,workspace,tab,pane}` | `tab` is known only in the lead's launch attempt; the worker does not know its tab → needs lead-side input in the registration content |
| Launch spec | `startHerdrAgent` argv (`herdr.ts:1487-1494`), resolved child command (`herdr.ts:1820-1834`), cwd, session uuid/path | registration | `launch.{executable,argv,cwd,session,provenance:"herdsman",revision}` | Herdsman's on-the-wire launch is a *shell-quoted single line* (`childLaunchLine` `herdr.ts:1774-1792`); register the semantic `(command, argv)` instead — flag as a decision, do not paste the typed line |
| Launch configuration identity | `agentLaunchFingerprint` (`agent-definitions.ts:1085-1096`) | registration | `launch.revision` | Natural stable revision string |
| Process birth identity | **none** — no procfs reader exists in the extension (no `boot_id`/`starttime`/`/proc` reads anywhere in `pi-herdsman/extension`) | registration | `process.{boot_id,pid,start_ticks}` | Gap G4 |
| Assignment/activity state | `managedAgentSnapshots` projection `index.ts:2984-3110`, `listed.state`, `agentControlState` (`core.ts:514-549`) | `assignment` (owner) | `activity` | Vocabulary decision G5 |
| Waiting reason | `readQuestionWaitEvidence` (`question-waiting.ts`; used at `index.ts:3044-3062`), `pendingAskId`, `backgroundWaiting` | both | `waiting_reason` | Herdsman's own evidence outranks lifecycle `blocked` today (`index.ts:3060-3072`) |
| Outcome | `ResultRecord.status ∈ {completed,failed}`, `error.code`, `responseValidation` (`mailbox.ts:88-130`) | both | `last_outcome.{result,detail}` | Bounded 1 KiB; a failure result also carries the provider error text (plan.md #136) |
| Advertised actions | `available_tools` snapshot in the listed projection (`docs/reference/agent-states.md`) | both | `actions` (≤16) | Gap G6 |
| Retire | `finalizeDeliveredRoot` `index.ts:4269-4369` (retain vs close), `closeLiveManagedExecution` `index.ts:5175`, `removeAgentMailbox` `mailbox.ts:957` | both | `agent.retire` | Retained worker keeps its agent_id; closed worker retires its writers and drops local state |

## 5. Identity, writer, channel, persistence and reconnect requirements (pinned fixture)

Wire envelope (`docs/agent-registration.fixture.jsonl:1-2`): one request
`{"version":1,"id":"<canonical uuid>","method":"agent.register","params":{…}}`
per line, exactly one response with the same `id`; `ping` first to check protocol
`1` and the `agent_registry` capability (`docs/daemon.md`, `docs/control-plane.md`
capability table).

Exact shapes read from the fixture and the daemon source:

- `agent.register` params (`registry.rs:187-212`): `source` (publisher's own name), `incarnation` (UUID), optional `session`, `owner`, `run`, `label`, `location{backend,instance?,workspace?,tab?,pane?}`, `process{boot_id,pid,start_ticks}` (**strict** on this wire: `deny_unknown_fields`, `registry.rs:214-233`), `launch{executable,argv≤256,cwd,session{uuid?,path?},provenance,revision}`. Bounds: 64 KiB record, 1 KiB text, `MAX_ARGV` 256 (`registry.rs:39-54`).
- Response `registration`: `version`, `agent_id`, `registered_at`, the immutable request fields echoed, `process_claimed: bool`, `launch{available, revision?}`. The public projection has **no** argv/cwd/session-path fields.
- `agent.acquire` (`publication.rs:170-190`): `{agent_id, channel:"execution"|"assignment", publisher:{source, incarnation, reporting_owner?}, replace?{generation,handle}}` → `writer{handle, source, incarnation, reporting_owner?, generation, sequence:0}`.
- `agent.publish` (`publication.rs:491-501`): `{agent_id, channel, writer_handle, sequence≥1, lease_ms? 1..300000, observed_at?, snapshot:{activity, waiting_reason?, last_outcome?{result,detail?}, actions?≤16}}` → `channel` with `snapshot{…, freshness}`.
- `agent.retire`: `{agent_id, channel, writer_handle}` → channel with `writer.retired_at`.
- `agent.get {agent_id}` → `{agent:{registration, process{claimed, verification}, execution, assignment}}`; `agent.list {limit?}` capped at 100 (`MAX_LISTED`, `registry.rs:54`).

Rules the client must implement (all source-verified):

1. **Registration content is immutable per `(source, incarnation)`.** `register` scans every record for the same source+incarnation (`registry.rs:628-637`) and returns the existing record only when the request is byte-identical; otherwise it **refuses** (`registry.rs:583-607`). So a *new process* needs a *new incarnation UUID* and therefore a new `agent_id` — a relaunch/continuation must never re-register a changed process under the previous incarnation. Persist the immutable request content, not just the incarnation.
2. **Persist the binding.** Store `agent_id`, `writer.handle`, `generation`, `channel`, the last accepted `sequence` and the last accepted snapshot content, in a private file (`0600`) under a private directory. Reconnect = identical `register`, then `acquire` **without** `replace` by the same publisher incarnation; a different publisher is refused (`replacement is explicit`), and implicit takeover is never allowed.
3. **Sequence discipline.** Strictly newer sequence for changed content or any heartbeat; equal sequence + identical content is an idempotent replay that does **not** extend the lease; equal sequence with different content, and older sequence, refuse. Failed writes consume no sequence.
4. **Freshness is server-side.** After a daemon restart (or a fresh serving epoch) persisted snapshots read `stale` until a newer publish; `stale`/`retired` never mean exited, completed or restart-safe.
5. **One subject per process incarnation, session is not identity.** Two registrations may share a session UUID; a continued/resumed worker is a new process with a new `agent_id`. The client's durable key should be `(workspaceId, runId, label)` → generation record, and the *caller* must be re-pointed at the new `agent_id` after a continuation.
6. **Failure is never blocking.** No absent daemon, refused register, fenced writer or timeout may fail, delay or alter a delegation, a turn, a result or a control path (mirrors the bus publisher's stated non-interference and the constraint "no absent daemon blocking normal assignments").
7. **Writer succession across an extension reload.** A lead that reloads mid-turn is a new publisher incarnation; the old handle stays incumbent until retired or lease-expired, so a reconnect must retire-then-acquire with the persisted incumbent, or accept the refusal and reconcile. Needs a stated policy (G8).

## 6. First port: module boundary, changed files, regression seams

Boundary (single seam, one module, injected deps — nothing duplicated):

```
pi-herdsman/extension/radar.ts            NEW
  radarControlSocketPath(env, uid)         → RADAR_CONTROL_SOCKET → $XDG_RUNTIME_DIR/agent-radar/control.sock → /tmp/agent-radar-<uid>/control.sock
  trustedControlSocket(path)               → parent real dir + uid + mode 0700 + non-symlink; socket is a socket owned by uid
  createRadarClient({dial, socketPath, timeoutMs≤2000, clock})
        .ping()                            → cached; requires protocol 1 + agent_registry
        .register(immutableRequest)        → {agent_id}
        .acquire(agentId, channel, publisher, replace?)
        .publish(agentId, channel, handle, sequence, snapshot, leaseMs?)
        .retire(agentId, channel, handle)
        .get(agentId) / .list(limit)
  createPublicationStore(root)             → herdsmanDataRoot()/radar, dir 0700, files 0600, atomic sibling-temp writes
  createSubjectPublisher({client, store, identity, clock})
        → register-once, acquire, publish-changed+heartbeat, retire-on-close; returns diagnostics, never throws
```

Every call is one connection, one request, one response, canonical UUID id, 1 MiB
line bound, short timeout, and a discriminated result. No timer that outlives the
session; no publication after `session_shutdown`.

Wiring points (anchors verified in `index.ts`):

| Purpose | Site |
| --- | --- |
| Worker self-publication init | worker `session_start` `index.ts:17241-17300` (after `state = candidate`, before the request pump starts) |
| Worker activity/outcome change | `turn_end` `index.ts:17916`, `agent_settled` `index.ts:18919`, the `writeAgentState` sites (`16691-16700`, `17002`, `17170`, `17352`, `17603`, `18544-18691`) |
| Worker retire/clear | worker `session_shutdown` `index.ts:18949-18990` |
| Owner (assignment) publication | lead `session_start` `index.ts:15875`, the existing projection push `publishOwnerView` → `publishOwnerStates` `index.ts:8494-8506`, settlement path `agent_settled` `index.ts:14901` |
| Lead/controller retire | lead `session_shutdown` `index.ts:16131-16160` |
| Registration inputs (tab, launch argv, process) | launch `index.ts:7627` (`startHerdrAgent`), in-pane variants `index.ts:5854`, `index.ts:11918` |
| Retire on close | `finalizeDeliveredRoot` `index.ts:4269-4369`, `closeLiveManagedExecution` `index.ts:5175`, `removeAgentMailbox` `mailbox.ts:957` |
| Config seam (only if the owner wants a key) | `config.ts` (`readConfig`); otherwise enable from socket presence |

Other changed files: `pi-herdsman/docs/reference/radar-publication.md` (new),
a vendored copy of `agent-radar/docs/agent-registration.fixture.jsonl` under
`pi-herdsman/docs/reference/` (vendoring precedent: `radar-bus.fixture.json` is
byte-identical vendored, per `.pi-herdsman/radar-publisher-result.md`), and a
`docs/reference/agent-states.md` cross-reference line.

Regression seams (no real socket, no runtime state):

- `pi-herdsman/extension/radar.test.ts` — injected `dial` against an in-process
  fake, template `pi-bash-processes/extensions/__tests__/radar-bus.test.ts`.
  Must pin: identical-register idempotency; changed-content-with-same-incarnation
  refusal; rotation on a new process incarnation; acquire-without-replace
  returning the same binding; strictly-newer sequence; equal-sequence replay not
  extending the lease; retire; socket absent / refused / timeout →
  publication disabled, no throw, no delay, no leaked timer.
- Fixture contract test — replay the vendored fixture's request shapes (exact
  field names) so a wire drift fails without a daemon.
- Existing suites for wiring: `extension-contract.test.ts`, `agent-runtime.test.ts`,
  `controller-lifecycle.test.ts` (they fabricate mailbox state and result entries,
  so publication must be inert in those fixtures).
- One explicit test for the constraint: **an absent daemon does not block a
  delegation** (assert the launch/assignment path completes with the socket path
  pointing at a nonexistent file).

## 7. Extension placement options (evidence-based)

| Option | Coverage | Evidence | Assessment |
| --- | --- | --- | --- |
| A. New module inside `pi-herdsman` (recommended, with C's seam) | Managed workers, lead/controller sessions, and any session that loads pi-herdsman including `role() === "unmanaged"` | `index.ts:8335` single entry; role gates and per-role hooks already exist (`15875`, `17241`) | No duplicated lifecycle listener, identity comes from live in-process state, launch/close inputs available. Does not cover plain Pi sessions that never load pi-herdsman |
| B. Separate extension package / a file beside `herdr-agent-state.ts` | **Every** Pi TUI session in Herdr, managed or not | The reporter itself is such a file and is explicitly injected into managed workers (`herdr.ts:1491-1494`); `readAgentState`/`scanAgentStates` are exported (`mailbox.ts:992`, `:221`) | The only route to non-managed sessions, but it cannot author owner assignment facts (the owner projection lives in the lead process), must re-derive identity from env + Herdr + its own pid, and introduces a second identity authority. Reading another session's mailbox files is not ownership |
| C. Split-by-channel with an extractable seam | — | — | Recommended *shape* for A: `radar.ts` takes `(identity resolver, dial, clock)` as injected deps; the execution publisher becomes liftable into its own extension later without touching the controller |

Non-managed-session coverage needs two Radar-side answers first, and must not be
invented: who mints `label`/`run` for a session with no Herdsman record, and
whether a registration without `run`/`label`/`owner` is actionable in Radar's
operator surface. Defer.

## 8. Contract gaps and unsettled choices (need Radar owner or Herdsman owner)

- **G1 — no registration lifecycle.** No delete/forget/prune exists in the
  registry (`registry.rs`/`publication.rs` remove only temp files, `:668`, `:671`,
  `:830`), `agent.list` is capped at 100, and `find_incarnation` scans every
  record. One registration per worker incarnation, over months, is unbounded
  growth and a growing scan. Ask Radar for a retention/forget rule or accept a
  client-side rotation policy.
- **G2 — no push/event surface.** `observe` is poll-only; Herdsman's
  `events.subscribe` (`herdr.ts:652-736`, `:676`) has no analogue. Not needed by
  the first port; needed before any reconciliation that replaces presence.
- **G3 — registry facts are not yet visible in the Radar TUI** ("The current
  Radar TUI still uses its existing observation path", `docs/daemon.md`).
  Acceptance for the port must therefore be daemon reads (`agent.get`/`agent.list`),
  not operator-visible rows. Do not claim operator value yet.
- **G4 — process claim source.** Herdsman holds no `boot_id`/`start_ticks`.
  Options: (a) omit `process` (⇒ `process_claimed:false`, verification
  `unavailable`, and the contract explicitly says no claim is not evidence of
  absence) — zero new code; (b) read Radar's own `process_info`, whose
  `ForegroundEvidence::NonShell.local.resources.identity` is exactly
  `{boot_id,pid,start_ticks}` from the daemon's collector (`model.rs:586-672`,
  `procfs.rs:1195-1196`) — requires the mux capability and a taken sample;
  (c) a new child-side `/proc/self` reader. (b) is the only option that needs no
  new reader and is verifier-compatible; (a) is the lean default. Decide.
- **G5 — activity vocabulary.** Publish Herdsman's exact words
  (`idle|working|waiting|blocked|settling|unknown|lost`) or a Radar-normalized
  subset? Radar preserves unknown vocabulary, so either works on the wire; the
  operator mapping is Radar's.
- **G6 — `actions`.** The contract states advertised actions certify neither
  completion nor restart eligibility. Proposal: advertise `available_tools`
  verbatim (bounded to 16 — it can exceed that, so it would be truncated) or
  advertise nothing. Decide.
- **G7 — lead change over a live worker.** `agent_continue` under a different
  owner, or a re-created lead, makes the assignment writer a different publisher
  against an existing `agent_id`. The contract requires an exact
  generation/handle replacement. Decide whether Herdsman performs it or leaves the
  channel to the previous writer until retirement.
- **G8 — publisher incarnation across reload.** Persist the lead's publisher
  incarnation per session and rotate on `session_shutdown`; state the
  retire-then-acquire policy for a reload that leaves the old handle incumbent.

## 9. What remains Herdr-dependent after the first port

Pane create/split; typing the child command (`pane run` + `childLaunchPlan`);
shell readiness proof (`pane process-info`, `proveShellReady`); taking the alias
(`agent rename`); readiness/registration wait (`agent get` polling,
`waitForChildRegistration`); presence and identity (`agent get/list` +
`agent_session`/`agent_status`); lifecycle events (`events.subscribe`); managed
close/terminate (`agent send-keys ctrl+c ctrl+d`, pane close); the pane-metadata
mirror; env injection (`HERDR_*`, `PI_HERDSMAN_*`). Radar's physical surface
covers `observe`, `process_info`, `output`, `focus`, `create`, `input` and
guarded unmanaged `close` only — no launch, readiness, alias, subscription or
managed close. The publication port touches none of it.

## 10. Evidence index and limits

Primary sources read: deployed `herdr-agent-state.ts` (and its diff against the
Herdr 0.9.3 store payload); `pi-herdsman/extension/{index.ts,herdr.ts,mailbox.ts,core.ts,supervision.ts,pane-metadata.ts,control.ts,agent-definitions.ts}`;
`pi-herdsman/docs/reference/{agent-states.md,herdsman-control.md}`;
`pi-bash-processes/extensions/radar-bus.ts`; `agent-radar/src/control_plane/*`
and `src/model.rs`; `agent-radar/docs/*`; `.pi-herdsman/radar-publisher-result.md`;
`.pi-herdsman/pi-1.1.0-lifecycle-upstream.md`.

Limits: no test was run (the Herdsman suite writes to the real mailbox root and
the daemon smoke needs a live daemon); the daemon binary was not executed; the
Herdr upstream repository was not fetched — the store payload shipped with Herdr
0.9.3 is the canonical artifact for the deployed reporter, and the deployed file
is byte-identical to it; every wire bound cited is read from the daemon's Rust
source or the pinned fixture, not observed.
