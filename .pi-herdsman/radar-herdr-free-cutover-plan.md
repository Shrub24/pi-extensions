# Herdr-free Herdsman cutover: verified scope

## Baseline and approval boundary

This scopes the user-supplied eleven-item list; no implementation or deployment is authorized by this artifact alone. Exact upstream examined: `8059aa39b1dc24fc79f0f8d2a8bc01f8666cf7fd`. Independent pinned contract verification: `result:radar-lifecycle-diagnosis#9`. No upstream build/tests/live mux actions were run for this verification.

Current Herdsman worker launch, addressed acceptance and close/reconciliation are uncommitted. Reviewed worker lifecycle has no remaining known blocker. Last retrieved full gate: 1189 tests, 1146 pass, 42 fail, 1 skipped. The older failure ledger is historical and must be regenerated; these failures are not a certified pristine baseline.

Manager worktree orchestration is out of the intended cutover's useful scope. Prefer removing its unused production surfaces and their tests together over implementing selected-existing-worktree-pane launch. Preserve ordinary Lead/worker ownership, nested delegation, owner routing and controls; do not equate removing Manager with removing supervision wholesale.

## Corrections to upstream outstanding list

### 1. Pin/capabilities

Protocol remains v1; `ping` cannot establish build/commit provenance. Pin the packaged source separately. Require `agent_registry`, `creation`, `launch`, `observe`, `close`, `events_v1`, `child_launch_context_v1` for the mandatory cwd/env worker path. Operation method names are not capability names.

Tmux is selected explicitly through daemon environment `RADAR_CONTROL_BACKEND=tmux` and `RADAR_TMUX_SERVER=<named-server>`. No tmux capability is advertised; `ping.backend` remains `runtime`. Never silently switch backend/server.

Refuse unsupported orchestration before physical effects. Keep generic reporting failure containment; missing daemon must not break extension initialization or unrelated Pi execution. Successful capability cache must be invalidated/rechecked across daemon reconnection/replacement rather than certifying a successor forever.

### 2. Events

Replace direct `watchHerdrLifecycle` in the health scanner with bounded `events.read` consumption. Events wake coalesced reads; mailbox/result facts still authorize assignment transitions. Refresh known exact `spawn.get`/`agent.get` records, not subjects selected by matching session strings.

Cursor expiry is a successful `cursor_expired` response. Handle epoch change, tail overflow and trimmed history with paginated `spawn.list`/`agent.list`, plus exact local pending-operation reconciliation. A clean daemon restart preserves journal epoch; publication serving epoch is separate.

**Pinned cursor hazard:** response cursor denotes journal tail even when limits return only a prefix. Advance from the last delivered event sequence, not blindly to tail. Before advancing beyond delivered events, complete an authoritative resync. Events do not carry trustworthy readiness/exit and do not guarantee every durable fact emitted a pointer. Keep a bounded fallback reconciliation cadence.

The ordinary `requests` list is limited to 200 and does not enumerate all managed-close evidence. Preserve exact locally stored close UUID/parameters.

### 3. Exit/relaunch

Read tmux `spawn.get.exit_observation` as sampled pane-command exit, not independently authenticated worker/process-group exit. Herdr remains unknown. Missing or unreadable pane remains unresolved. External same-pane respawn can overwrite an unsampled exit; persisted exits remain historical.

`agent.get` process verification distinguishes `verified`, `absent`, `mismatched`, `unavailable`. Only absent/mismatched positively establish that the claimed birth tuple is not currently present. Unavailable is unknown, including timeout, permission/capacity exhaustion and missing birth claim. Use the exact bound agent ID from the spawn edge, never a same-session replacement subject.

No atomic restart/replacement contract exists. Proposed interim new-pane relaunch is scoped as a durable sequence:

1. Verify directly owned idle assignment, retrieve/protect outstanding results, validate exact saved session/definition and acquire assignment lock.
2. Reconcile any stored exact close first. Admit a new close only against the daemon's live exact identity. Uncertain close stays unresolved.
3. Require completed pane close where a close was dispatched, and fresh positive absent/mismatched evidence for the old registered process before spawning the saved session in a new pane. A verified or unavailable answer refuses/defer relaunch.
4. Persist replacement intent and original/replacement operation IDs before dispatch; one unresolved replacement reserves the label. Fresh launch generation/incarnation and startup acknowledgment precede v6 first-task acceptance.
5. Never treat completed historical close, missing pane or old exit observation alone as permission to create a concurrent process on the same saved session.

**Separate gap:** new `child.close` refuses already-dead foreground identities. Cleanup/recovery of a dead retained pane therefore is not covered by simply calling close then spawn. Do not force close, reassign ownership or silently leave debris under a claimed successful close. Determine whether safe relaunch can intentionally leave the dead pane while reporting the residue, or obtain a daemon dead-pane cleanup contract. This remains a scope decision, not grounds to block fresh worker launch/adoption.

## Prioritized slices

### P0 — Herdr-free fresh-worker vertical slice (items 1, 5, 6, 7, 8, 9)

- Pin and typed required capabilities; add typed registry/operation/event decoders needed by later slices.
- Establish process location before immutable registration. Spawned children resolve their own qualified location from the bound launch edge using trusted bootstrap identity/token association; never invent a parent pane or register twice under changed immutable location. For operator/Lead bootstrap, a small tmux adapter qualifies `TMUX_PANE` with the configured server and validates it against `observe`. Raw `%N` is not the canonical qualified pane ID. Refuse wrong-server/conflicting pane evidence.
- Replace `HerdrSessionSnapshot` consumers with normalized registry plus observe reads. Registry supplies execution/assignment/owner/session-context/freshness; observe supplies panes, not agents. Preserve mailbox assignment/result authority, strict ownership and unknown/refusal behavior. Page all reads. No fabricated model/context values.
- Remove native Herdr reporter checks for ordinary workers; exact binding/startup acknowledgment already replaces them. Manager-specific checks disappear with its code.
- Restrict destructive close to daemon-spawn-owned subjects. Legacy/unbound subjects have no daemon close eligibility: return an explicit refusal, do not bypass birth checks. Remove Herdr close/restart transport only after consumers are cut over.
- Remove Herdr-only metadata/titles/awaited publishers and timers. Inspected awaited-facts module is a display projection; current token reads in status presentation provide role/task/model/context. Perform an exhaustive read-consumer audit before removal and migrate any real coordination fact to existing mailbox or supported assignment contract, without inventing public fields. Show unavailable model/context as unknown or use existing local known facts, not stale Herdr tokens.

Acceptance: an operator/Lead under an isolated named tmux server can register, spawn an ordinary child, bind, receive startup ack, accept addressed first task, deliver result and close, without executing or depending on Herdr. Existing direct-owner and replacement safety regressions remain.

### P1 — Event-driven authoritative reconciliation (item 2, observation part of 3)

Replace socket lifecycle subscription; coalesce event pointers into registry/spawn reads. Test paginated batches, last-event cursor advancement, cursor expiry, changed epoch, dropped connection, omitted pointers and session shutdown cancellation. Preserve periodic fallback reads and no transcript refresh regressions.

### P2 — Safe saved-session new-pane relaunch (item 4, exit part of 3)

Remove stop-and-preserve-pane dependency; implement only the confirmed-closure/positive-old-process-absence sequence described above. Rewrite eight retained/restart failure tests against behavior, not CLI shape. Reject still-verified/unavailable process; protect unread result and replacement generation; retain uncertain operation evidence across controller cache loss. Dead-pane cleanup decision stays separate.

### Parallel scope reduction — Manager removal (item 10)

Remove unused Manager worktree creation/adoption/relaunch/control/UI surfaces, config/docs and tests of the removed behavior. Preserve shared Lead/worker authority utilities still used. Do not merely delete 27 failing tests while leaving direct Herdr Manager code reachable. Keep Chief/supervision scope explicit rather than automatically removing it by association; any retained surface must use Radar-only reads or be deliberately removed too.

### Final acceptance and cleanup (items 10, 11)

Regenerate exact failure ledger after each slice; classify stale backend assertions versus real regression with reproducible evidence. Do not call all remaining failures baseline. Fresh-worker acceptance can precede relaunch; final release requires full package gate or explicitly approved exclusions/removals.

Run disposable tmux acceptance with unique named server, `-f /dev/null`, stripped inherited `TMUX`, private Radar state/socket, explicit backend/server, cleanup limited to that server. Prove no silent skip and no Herdr binary/socket/reporter dependency. Cover fresh launch, first task, result, eligible close, saved-session continuation and context publication. Add relaunch evidence tests when P2 is available.

After consumers pass, remove `herdr.ts`, `pane-metadata.ts`/`awaited-facts.ts` transports, imports, `HERDR_*` environment inputs, reporter checks/subscriptions, packaging/docs and smoke dependencies. Keep historical ADRs explanatory, not runtime instructions. Commit path-scoped; shared tree contains unrelated work.

## Existing local starting seams

- `index.ts:1070–1150`: execution publication bootstrap, Herdr-only location, registered spawn parent.
- `managedAgentSnapshots` (`index.ts:3669–3921`): mandatory Herdr snapshot and workspace filter plus Radar observations.
- `index.ts:7180–7370`: retained restart's direct Herdr pane/process/worktree/stop/start dependencies.
- `index.ts:17335–17380`: health-scanner lifecycle subscription and coalescing.
- `index.ts:14245–14310`: status display token consumers.
- `awaited-facts.ts`, `pane-metadata.ts`: direct Herdr display publication.
- `radar-client.ts:880–995`: protocol/capability handshake and successful cache.

Line numbers refer to the inspected working copy. The earlier handoff `.pi-herdsman/radar-adoption-handoff.md` remains baseline context; this document supersedes its Manager-placement-as-release-blocker framing.

## P0 status: protocol-2 wire migration (landed, uncommitted)

Stage as of this entry: the wire cutover and the consumer cutover are done;
everything below is uncommitted in the shared working copy. The consumer
correction after review (canonical topology decoding, observation-required
location, pending-vs-absent registration, daemon-sourced presence, legacy close
refusal, display/awaited/owner/lead publisher removal) is recorded in
`radar-v2-fresh-worker-progress.md`, including the claim it withdrew: the tmux
adapter's empty `agents` array does not mean its pane inventory is empty, and the
earlier environment-only containment fallback was wrong.

### Landed

`pi-herdsman/extension/radar-client.ts` speaks protocol 2 only:

- `RADAR_PROTOCOL_VERSION = 2`; every envelope is `{version: 2, id, method, params}`.
- Contracts, not version-1 capability names, are negotiated at `daemon.ping`:
  `registry.v1`, `spawn.v1`, `spawn.close.v1`, `spawn.launch_context.v1`, plus the
  backend capabilities `mux.observe` and `mux.focus`. An absent contract refuses
  locally with `unsupported` and dials nothing.
- Method names are the version-2 names: `daemon.ping`, `mux.observe`, `mux.focus`,
  `mux.request.get`, `spawn.create`, `spawn.close`, `spawn.get`.
- `spawn.get`/`spawn.list` decode the flattened edge (`result.spawn.bound.agent_id`;
  there is no nested `edge` object to read on this wire).
- `spawn.close` decodes `already_exited` and its exit observation, and the daemon's
  `outcome_unknown` is read as this client's existing `unknown` code, so no caller
  learns a dispatch-uncertainty word it does not already handle.
- `mux.observe` keeps the normalized `location` + `session` identity decoding the
  supervised-lead focus action already applies to observed agents.

`pi-herdsman/extension/support-radar.ts` (fake daemon) serves version 2 only:
`daemon.ping` with `instance`, `spawn.create`, `spawn.close` gated on the
`spawn.close.v1` contract, `mux.observe`, `mux.focus`, and a flattened `spawn.get`
topology.

`pi-herdsman/docs/reference/agent-registration.fixture.jsonl` is re-vendored
byte-for-byte from agent-radar `f87348032a808967c50a4e84b7e1c766a64ebfe3`
(`docs/agent-registration.fixture.jsonl`); the client suite replays it.

### Verified

- `radar-client.test.ts` 27/27 against the re-vendored pinned fixture.
- `radar-launch.test.ts` + `radar-publication.test.ts` + `radar-execution.test.ts`
  58/58.
- `controller-lifecycle.test.ts` + `recovery.test.ts` green in the same run as
  `radar-launch.test.ts` and `commands.test.ts`; the only failure there is the
  Manager worktree case this document already places outside P0.
- The package gate's own invocation (`node --experimental-test-module-mocks
  --import=./scripts/test-env.mjs --test`, default discovery) reports
  1189 tests, 1146 pass, 42 fail, 1 skipped: identical to the last recorded gate,
  with the same 42 failing names. No newly failing test.
- Disposable daemon check against the pinned build (script kept at
  `/tmp/radar-wire-check.mjs`;
  (`/var/tmp/radar-v2-build.nqEwCO/target/debug/radar daemon`, private
  `RADAR_CONTROL_STATE`/`RADAR_CONTROL_SOCKET` under `/tmp`, reads only, state
  removed afterwards): `ping` answered protocol 2 and advertised exactly the
  contracts this port negotiates; `agent.register` succeeded; `spawn.create` was
  refused by the daemon with "parent has no published session context" and
  `spawn.close` with "has no recorded edge" - both decoded as `refused`, which is
  the daemon confirming it validates the parent's context before any pane effect;
  `mux.observe` returned the real normalized inventory
  (`{workspace_id, tab_id, pane_id, session{kind,value,source}}`), the exact shape
  this port's observation decoder reads. The daemon selected its default Herdr
  backend, so no tmux-backend claim is made here.
- `git diff --check` clean.

### Not started, with the seam to start from

1. **tmux location bootstrap.** `radarProcessLocation()` (`index.ts:1123`)
   still reads `HERDR_PANE_ID`/`HERDR_WORKSPACE_ID`/`HERDR_TAB_ID`. The qualified
   pane id on this wire is `tmux:<server>:<%N>` — the tmux adapter renders
   `format!("{BACKEND}:{server}:{id}")` and its own test pins `tmux:probe:%3`
   (`agent-radar src/tmux.rs:752`, assertion at `:1264`) — so a raw `%N` is never
   the canonical location. What is still undecided is where the pi process learns
   the server the daemon drives: `RADAR_TMUX_SERVER` is the daemon's own
   environment, while the process sees only `TMUX`/`TMUX_PANE`. Validating against
   `mux.observe` before an immutable registration also moves registration behind a
   successful observation. Both need a decision before this is implemented.
2. **Registry-backed ordinary-worker snapshots.** `managedAgentSnapshots`
   (`index.ts:3669–3921`, its `herdrSessionSnapshot` read at `:3684`) still takes its rows from Herdr; the
   client has no `agent.get`/`agent.list` decoder yet, and the brief forbids adding
   one before a consumer exists.
3. **Deletions.** Native reporter readiness (`herdrReporterExtensionPath`, the
   check at `index.ts:9941`),
   `pane-metadata.ts`/`awaited-facts.ts` display publication, and the legacy close
   transport are all still reachable for ordinary workers.
4. **`already_exited` at the consumer.** `index.ts:6464` treats any close outcome
   other than `completed` as "no confirmed outcome" and retains edge, pane and
   mailbox. That is safe but strands a retained pane the daemon did clean up;
   handling it properly means extending `RadarCloseEntry.stage` and the
   `completedRadarClose`/`closeIsReconcilable` predicate this tree has just had
   validated, so it was left alone rather than half-changed.

### Decisions to record (owner to land)

- Herdsman's Radar port pins protocol 2 contracts (`registry.v1`, `spawn.v1`,
  `spawn.close.v1`, `spawn.launch_context.v1`) instead of version-1 capability
  names, and refuses an absent contract locally with `unsupported` before dialling.
  Rejected: keeping a capability-name check that lets a version-1-shaped request
  out to a daemon that answers `unknown_method`.
- The daemon's `outcome_unknown` is mapped to the client's `unknown` code at the
  decode boundary. Rejected: surfacing it as a new code, which would read as a
  hard refusal to every existing caller.

## P0 completion status: fresh-worker consumer cutover (landed, uncommitted)

Detail, evidence and decisions: `.pi-herdsman/radar-v2-fresh-worker-progress.md`.

Done in this slice, on top of the wire port:

- Location bootstrap: `extension/radar-location.ts` derives the backend and its
  server from `daemon.ping`, qualifies this process's own pane (`TMUX_PANE` for a
  tmux daemon, `HERDR_PANE_ID` otherwise), refuses an explicit local
  contradiction, and completes containment from `mux.observe` when that
  observation reports the pane.
- Placement: a fresh launch splits this process's own registered pane, and any
  other configured placement refuses before a placement lookup would consult the
  mux. `reusableLeadTab`/`leadTabLabel` and the unused placement revalidator are
  gone with that path.
- Registration timing: the adapter is still built at extension registration, so
  its listeners are registered with every other extension's; only the immutable
  registration record is built later, inside `ensureRegistration()`, so a
  negotiated location can still be arriving when the adapter starts.
- Presence inventory: read only for a mailbox whose presence actually needs the
  mux, and a failed read is `unavailable` (unknown presence), never an empty
  fleet.
- Close: `already_exited` is admitted by `confirmedRadarClose` as a confirmed
  physical cleanup, keeping the daemon's own word and the edge's exit evidence.

Still open from the P0 list, deliberately:

- Replacing the ordinary-worker presence read with `agent.list`/`agent.get`
  consumers. The registry offers process verification and publication freshness
  only, and the contract states neither is a liveness verdict, so the replacement
  needs a decision on what proves a legacy child's generation.
- Removing the display publishers and the native-reporter notice. The audit found
  live consumers: the Radar TUI still uses its existing observation path, so
  `pane-metadata.ts`/`awaited-facts.ts` and the reporter notice are still what
  make a worker visible and keep Herdr's own detection working.
- Legacy close/restart transport for non-Radar children, and the Manager paths
  (`refreshSupervisionOnce`, project/lead dashboard) that still read Herdr
  directly.
