# Design

## Context

See `proposal.md` — Why. The current mechanism, read from the tree at HEAD:

- `herdr agent start <name> --kind pi --pane <id> --timeout <ms> -- <pi args…>` is the only
  way a managed child starts. The installed Herdr CLI documents `--kind` as
  "Supported agent kind and canonical executable" with no override for the executable, so
  the child binary is whatever the pane shell resolves for `pi`.
- Those two call sites are `startHerdrAgent` (fresh delegation, `herdr.ts:1262-1312`) and
  `startHerdrAgentInPane` (owner-control restart, `herdr.ts:1484-1534`). Both retry on
  Herdr's `agent_pane_busy`, set `attempt.launchMayHaveStarted`, and are rolled back by
  `rollbackHerdrStart` (`herdr.ts:2262`) driven by the attempt record and the recorded
  shell process.
- Child environment is assigned at **pane creation** only: `startHerdrAgent` validates
  `options.env` (`herdr.ts:1027`, `validateEnvironment` `:1577-1595`), folds it through
  `structuredTopologyEnvironment` (`:437-470`) and passes it to `tab create` / `pane split`
  as repeated `--env` (`:1118`, `:1177`). `startHerdrAgentInPane` passes no env at all, so
  an owner-control restart inherits the pane's creation-time environment.
- The launch environment itself is assembled in `prepareManagedWorkerLaunch`
  (`index.ts:3277-3296`) and returned with the launch args and fingerprint (`:3384`); the
  fresh-launch caller passes it to `startHerdrAgent` (`index.ts:7490`).
- The launch configuration fingerprint is `agentLaunchFingerprint(resolveAgentLaunchInputs(
  definition, { cwd }))` (`agent-definitions.ts:1075-1085`, `:1035-1068`), recorded with the
  launch (`index.ts:3379-3381` → `WORKER_LAUNCH_ENTRY` `:5757`/`:7614`) and recomputed before
  reuse by `resolveIdleWorker` (`index.ts:3405`), which returns `{kind:"relaunch"}` on drift
  (ADR 0013).
- Herdsman's own process environment is already the input for several launch decisions, and
  the child launch environment is explicit: the `env` array is a fixed list of assignments,
  not an inheritance of the parent's environment.
- A prior accepted decision constrains this design: Herdsman SHALL NOT call
  `pane report-agent`, `report-agent-session` or `release-agent`; Herdr's official Pi
  integration owns agent state
  (`openspec/changes/archive/2026-10-05-herdsman-herdr-pane-metadata/design.md`, D1). Herdsman
  passes that reporter's extension path to the child when installed (`herdr.ts:118-127`).
- `pane run <PANE_ID> <COMMAND>...` already exists in the CLI and is already used by
  `waitForShellMarker` as a single shell line (`herdr.ts:1718`).

## Goals / Non-Goals

**Goals:** the operator's own environment is the single source of truth for the child
command; the choice is validated at launch time and recorded with the launch so a worker
launched under a different choice is detected; the choice applies on every launch including
a pane-reusing restart; no shell function required in the steady state.

**Non-Goals:** a configuration key or settings-menu exposure, removing Herdr, a tmux
backend, Radar work, per-definition overrides, parallel start mechanisms,
mailbox/control-protocol changes, and any change to `PI_SUBAGENT_CHILD` /
`PI_SUBAGENT_PARENT_SESSION` / `PI_USE_STOCK` semantics.

## Verified and unverified facts

- **Verified in-tree:** the call sites, env wiring, fingerprint inputs and rollback seams
  above; `validateEnvironment` and `structuredTopologyEnvironment` as the only validation of
  launch-environment assignments (`herdr.ts:437-470`, `:1577-1595`); the reporter-extension
  hand-off (`herdr.ts:118-127`); the no-`report-agent` constraint.
- **Verified from the installed CLI's help output:** the `agent start` / `agent rename` /
  `agent wait` / `agent get` / `agent explain` / `pane run` surface and option names.
- **Verified from the filesystem:** `~/.nix-profile/bin/{pi,pi-bolt,pi-bolt-child}` all
  exist and resolve into the Nix store; `pi-bolt-child` is a bash wrapper that filters
  `--extension` arguments and injects `--no-extensions -e builtin:mcp -e builtin:codemode`
  before exec'ing `pi-bolt`. This value is the confirmed input for this change, and it
  **contradicts the earlier briefed premise** that `pi-bolt` and `pi-bolt-child` are absent
  from `~/.nix-profile/bin` (see Dotfiles-facing contract).
- **Unverified, probe-gated:** whether Herdr detects or lists an agent whose process was
  started by `pane run` rather than `agent start`; whether the agent alias can be applied
  after such a start; how `pane run` treats long argv and quoting; whether the child's
  reporter extension is what registers the agent record. Stage 2 exists only if the probe
  resolves these favourably (D7).

## Decisions

### D1. The environment variable is the only input, read and validated at launch time

`PI_HERDSMAN_CHILD_COMMAND` is read from Herdsman's own `process.env` when a launch plan is
built, through one helper. Unset or empty means "no command configured" and the launch is
unchanged. A set value must be either an absolute path or a command name resolvable on the
launch `PATH`, and must name an executable; anything else fails the launch with a typed
error naming the variable, before any pane or process is created. There is no configuration
key, no settings-menu entry and no fallback to a second source. Alternatives rejected: a
config key (an extra surface and another file for the same fact), a menu entry (the value is
a path, not a toggle), silent fallback to `pi` on an invalid value (it would hide a typo
behind a whole fleet launched with the wrong build).

### D2. The value reaches the child as one launch-environment assignment

When set and valid, `prepareManagedWorkerLaunch` appends
`PI_HERDSMAN_CHILD_COMMAND=<resolved value>` to the existing `env` array, exactly once. That
array already flows to pane creation, so no new transport is introduced, and an unset
variable produces a byte-identical launch to today. The reserved-name filter inside
`structuredTopologyEnvironment` (`herdr.ts:451-462`) is left untouched, so
`PI_SUBAGENT_CHILD` / `PI_SUBAGENT_PARENT_SESSION` semantics cannot change.

What the child receives, per stage: in **stage 1** the assignment is exported to the pane
environment so an existing wrapper (today the `pi-bolt-child` bash wrapper, reached through
the `pi` shell function) may still honour it — nothing else changes for the child. In **stage
2** the launch uses the value directly, so the child no longer needs it for dispatch and the
assignment becomes informational consistency for the pane.

A worker that delegates a further worker reads the value it inherited. An **inherited value
in a worker is acceptable**: the worker is running the same build the fleet launched with, so
its own children should run that build too. The alternative — refusing to use an inherited
value — would make nested delegation depend on a variable nobody exports in the child.

### D3. The value is part of what the launch fingerprint covers

`resolveAgentLaunchInputs` gains an optional `launchCommand` input and includes it in the
returned inputs when set, so `agentLaunchFingerprint` hashes it without a second hash path.
Both call sites pass it: the launch plan (`index.ts:3379-3381`) and the reuse check
(`index.ts:3421-3422`). The fingerprint therefore compares **the value read at launch** with
the value read now: a worker whose recorded value differs from the current one is relaunched
rather than reused, which is ADR 0013's existing drift rule applied to a new input — no new
state, no new durable record.

Because the value comes from the lead's own environment, it is **fixed for the lead process
lifetime**: a live lead cannot observe a changed variable, so changing the value needs a lead
restart. The recorded-value comparison still earns its place: it keeps the launch record
honest across lead restarts and resumed owner sessions, it makes a worker reused under an
owner whose environment differs relaunch instead of silently running the old build, and it
costs nothing.

Known stage-1 limitation, stated rather than hidden: the owner-control restart path
(`startHerdrAgentInPane`) passes no environment and reuses the pane, so under stage 1 a
changed value reaches a worker through a continuation-triggered relaunch (which creates a
pane through `startHerdrAgent`, applying `--env`) or a fresh launch, not through a
`herdsman-control/v1` restart. Stage 2 removes the limitation by using the value on every
launch.

### D4. Stage 2 replaces the start call, not the topology code

Inside the two existing `agent start` hunks, stage 2 substitutes one call to a new helper
that (a) requires the same shell-marker readiness the current code already waits for, (b)
runs `<child command> <pi args…>` in the pane, (c) applies the Herdsman alias afterwards,
(d) polls bounded readiness, and (e) returns the same `StartedHerdrAgent`-shaped attempt, so
`rollbackHerdrStart` and every caller stay unchanged. `attempt.launchMayHaveStarted` is set
only after the run reports delivery (text typed) so rollback still distinguishes "may have
started" from "never started"; `attempt.shellProcess` is still captured before the run. The
helper takes the command from the same D1 read, so stage 2 has one input, not two.

### D5. Readiness, alias and failure parity are Herdsman-side

`agent start`'s `--timeout` readiness wait becomes a bounded poll using `agent get` /
`agent explain --json` and/or `agent wait --until idle --timeout`, inside the existing
`startupTimeoutBudget` (`childTimeout`/`totalTimeout`). The alias that `agent start` set as
its first positional argument is applied with `agent rename <target> <alias>` after the
child is registered, then verified through the same identity checks callers already perform
(`started.herdrAgent === herdrAgentAlias(...)`, `herdrAliasMatchesIfReported`). Failures keep
the existing shape: a structured `OperationError` naming the stage, wrapped in
`HerdrStartFailure` with the attempt record, then the existing rollback. Per the archived
constraint above, stage 2 adds **no** `report-agent` / `report-agent-session` /
`release-agent` call: readiness is read from Herdr, never reported to it by Herdsman.

**Implemented as a registration poll.** Stage 2 accepts readiness as the record Herdr reports for
the pane once it carries a reported session or a known status (`idle` / `working` /
`blocked` / `done`), then applies the alias and verifies it. The probe's
`agent wait <pane> --until idle` gate was rejected: a delegated child receives its
assignment at startup, so it is usually already `working` when the wait is issued and the
wait would spend the startup budget on the first assignment instead of on startup. Live on
this machine the record arrived with `agent_session` present while `agent_status` was still
`unknown`, so the session half of the predicate is the one that fires first.
[ADR 0029](../../../pi-herdsman/docs/adr/0029-run-a-configured-child-in-its-pane.md)
records the decision, the quoting rule and the rejected alternatives.

### D6. argv handling has a script fallback

If `pane run` takes a single shell line, Herdsman must quote the full child argv itself; if
it takes argv, Herdsman must not rely on re-splitting. The probe settles which. The named
fallback for a long or fragile argv is to write the launch line to a private per-launch
script and run the script's path, which removes quoting from the critical path.

### D7. Stage 2 is gated on a recorded probe in a throwaway pane

The probe runs before any stage-2 implementation edit and records, for the installed Herdr
version: P1 whether `agent get` / `agent list` / `agent explain` show an agent started by
`pane run` (and what registers it); P2 whether `agent rename` applies the alias afterwards
and what the agent queries then report; P3 whether `agent wait --until` reaches `idle` for
such an agent and how long readiness takes; P4 how `pane run` splits and quotes a long argv
containing spaces, quotes, `=`, and newlines. Any unfavourable P1-P4 outcome stops stage 2
and leaves stage 1 (read, validate, export, fingerprint) as the terminal state, with the
shell dispatcher retained.

### D8. The dotfiles side converges to the environment, not dispatch

Stage 1 lets the shell function stop keying on `PI_HERDSMAN_MAILBOX` / `PI_SUBAGENT_CHILD`
and reduce to honouring the variable; stage 2 deletes the function. Both stages leave the
`pi-bolt-child` wrapper itself in place — it is the child build, not the dispatcher.

### D9. No new module, no new durable state, no wire change

Stage 1 is one read helper plus a few lines in files that already own the concept; stage 2 is
one start helper plus two call-site substitutions. Nothing is added to the configuration
file, the mailbox, the control protocol or the delivery ledger.

## Dotfiles-facing contract (owned by the dotfiles repository; not edited here)

1. **Set the variable for the lead.** The dotfiles owner exports
   `PI_HERDSMAN_CHILD_COMMAND=/home/saurabhj/.nix-profile/bin/pi-bolt-child` in the lead's
   own environment (the shell/session that starts the lead Pi process), not in the child's.
   Herdsman reads it from its own process; children receive it from the launch, not from the
   shell. That path exists today as a profile symlink into the Nix store (verified above), so
   it survives rebuilds as long as the profile entry stays.
2. **The fish function.** Today it is the routing layer: `pi` → `pi-bolt-child` when
   `PI_HERDSMAN_MAILBOX` or `PI_SUBAGENT_CHILD` is set. After stage 1 it reduces to honouring
   `PI_HERDSMAN_CHILD_COMMAND` when set and otherwise keeping its previous behaviour — with
   "unset or empty means unconfigured" as the rule. After stage 2 it disappears, because
   Herdr is no longer asked to type `pi`.
3. **Contradiction to record.** The briefed premise was that these binaries are absent from
   `~/.nix-profile/bin` and need a new dotfiles entry; the filesystem shows `pi`, `pi-bolt`
   and `pi-bolt-child` present. If the wrapper is not declared in the dotfiles Nix
   configuration, declaring it there makes the path reproducible — a note for that
   repository, not this one.
4. **Herdr dependency.** Stage 2 still requires Herdr for panes, placement, lifecycle events
   and the agent registry; it removes the need for Herdr to launch the child. This is a
   dependency reduction, not removal.

## Concurrency and merge seam (upstream pre-extraction alignment)

An upstream alignment change is expected to rewrite large parts of `index.ts` and
`herdr.ts`. Keep this change to the following named hunks and land stage 1 independently:

| Stage | File | Hunk |
|---|---|---|
| 1 | `extension/herdr.ts` | new child-command read/validate helper next to `validateEnvironment` `:1577-1595`; no change to `structuredTopologyEnvironment` `:437-470` |
| 1 | `extension/index.ts` | env array in `prepareManagedWorkerLaunch` `:3277-3296`; fingerprint call sites `:3379-3381`, `:3421-3422` |
| 1 | `extension/agent-definitions.ts` | `resolveAgentLaunchInputs` `:1035-1068` (and its input type) |
| 1 | launch documentation | the managed launch environment page (see tasks) |
| 2 | `extension/herdr.ts` | the `agent start` hunk in `startHerdrAgent` `:1262-1312`; the `agent start` hunk in `startHerdrAgentInPane` `:1484-1534`; one new helper; reuse of `waitForShellMarker` `:1718` and `rollbackHerdrStart` `:2262` |

Removing the configuration key removes the whole `extension/config.ts` and
`docs/reference/configuration.md` surface from this change: stage 1 no longer touches the
configuration schema, the `CONFIG_KEYS` set, `parseRawConfig`, `updateConfig` or the
`/agents` menu. Stage 1 changes no start path, no pane behaviour and no rollback, so it can
land before, during or after the alignment; stage 2 should wait until the alignment has
landed, because it rewrites exactly the hunk that is being moved.

## Risks / Trade-offs

- **Probe invalidates stage 2** → keep stage 1; the shell dispatcher stays one line and no
  capability is lost.
- **The value is fixed for the lead's lifetime** → changing it needs a lead restart; the
  fingerprint comparison makes the stale case visible as a relaunch rather than a silent
  reuse.
- **An invalid value fails every launch for that lead** → the failure is typed and names the
  variable, and clearing or fixing the variable needs only a lead restart; no fleet-wide
  silent fallback to the wrong binary.
- **`pane run` quoting or argv splitting mangles a long child argv** → D6 script fallback.
- **Alias/registration ordering** → readiness poll before rename, verification after rename,
  and a structured failure if the alias never matches; the existing caller checks remain the
  backstop.
- **A command from the environment is a code-execution surface** → the value is the
  operator's own environment, validated as an executable path or resolvable name, with no
  shell metacharacter expansion by Herdsman.
- **An inherited value in a worker** → accepted by design (D2); the worker runs the build the
  fleet launched with, so its children should match.
- **Herdr version drift changes `--kind`, rename or wait semantics** → the probe records the
  version, and the readiness/alias code is one helper, so a version-specific fix is local.

## Migration Plan

1. Review these artifacts; keep stage 2 unavailable until the probe is recorded.
2. Land stage 1 (read and validate at launch time, export the assignment, fingerprint
   participation, docs) with its tests.
3. The dotfiles owner exports `PI_HERDSMAN_CHILD_COMMAND` for the lead process and reduces
   the fish function to honouring it; verify one delegated worker's pane environment carries
   the assignment and that a lead restarted with a different value relaunches a reused worker
   rather than reusing it.
4. Run the throwaway-pane probe and record P1-P4 with the Herdr version.
5. If the probe is favourable, land stage 2: it uses the same variable, so rollback is
   "unset the variable and restart the lead".
6. If unfavourable, stop at stage 1 and record why in this change.

## Open Questions

None outstanding. The former questions are resolved by this revision: the `/agents` menu
question is void (no key), the former question about guarding against an inherited
variable is void (that variable is the input), and the intended value is confirmed as
`/home/saurabhj/.nix-profile/bin/pi-bolt-child`.
