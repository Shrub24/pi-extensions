# Herdsman lifecycle fixes — result

Task: close the two remaining lifecycle defects recorded from the pi-herdsman
reviews, plus the third finding (worker-side V5 request profile check).
Repo: `/home/saurabhj/Projects/dev/custom/pi-extensions` (pi-herdsman).
Scope executed: `pi-herdsman/extension`, `pi-herdsman/docs`, `openspec/specs`.
No `jj`/`git` commands were run.

Status: implementation complete; full-suite + validate results appended below.

---

## Fix 1 — `agent_extend` refuses a non-live worker

### Seam
`pi-herdsman/extension/index.ts`, `agent_control` `p.action === "extend"` branch
(failure string `Agent has no armed soft window`), reached through
`resolveRuntime` (locate by `async function resolveRuntime`).

### Change
- `resolveRuntime` now returns the target's `presence` (`ManagedAgentPresence`)
  in addition to `runtime`/`agent`/`state`/`controlState`.
- The extend branch refuses with the existing typed category `agent_busy` when
  `resolved.presence.kind !== "live"`, before it touches the window. The message
  mirrors the steer/interrupt guards: `Agent is not currently live: <state>`,
  with a `nextAction` pointing at `available_tools`.

### Red observation (before the fix)
`extension/recovery.test.ts` — new regression
`agent_extend refuses a non-live worker's recovered window`:

```
node --experimental-test-module-mocks --import=./scripts/test-env.mjs --test \
  --test-timeout=20000 --test-name-pattern="agent_extend refuses a non-live worker" \
  extension/recovery.test.ts
✖ agent_extend refuses a non-live worker's recovered window
  AssertionError: Expected values to be strictly equal: true !== false
  at .../recovery.test.ts:7144:10   (assert.equal(attempted.details.ok, false))
```

i.e. the extend succeeded, rewrote the recovered window and would have appended
a durable `extended: true` entry.

### Green observation (after the fix)
Same command: `✔ agent_extend refuses a non-live worker's recovered window`.
The test also asserts `attempted.details.error.category === "agent_busy"`, that
`available_tools` never offered `agent_extend`, and that no durable
`pi-herdsman-soft-window` entry with `extended: true` was appended. The existing
`agent_list offers agent_extend only for a windowed live assignment` test
confirms a live working worker still extends successfully.

### Decision this brief did not specify (seam correction — important)
The recorded F1 premise ("a direct `agent_extend` on a *lost* worker succeeds")
does **not** reproduce on current `main`. Empirically (scratch probe, deleted
afterwards), a lost worker is already refused in `resolveRuntime` by
`validateIntegration`: a lost presence means the pane is gone, so
`herdr agent get <paneId>` fails and the call returns
`invalid_request` — *before* the extend branch runs. The existing
`a proven lost assignment drops agent_extend from available_tools` test already
covers that refusal (and now also asserts no `extended` entry).

The reachable, genuinely unprotected non-live case is a **`recovery_only` /
`unknown`** presence: the pane still exists (so `agent get` succeeds and
resolution completes), but the inventory no longer proves the worker's exact
identity. `recoverControllerRuntimes` arms and keeps that worker's window, and
the health scan only drops windows for `lost`, so the window stays armed. The
regression fixture uses that state. The fix still covers `lost` defensively.

The check is `presence.kind !== "live"` (exactly the advertised-controls gate)
rather than the digest pass's full `working`/`waiting`/`blocked` triad: the
advertised gate includes live non-idle states, so replicating the triad would
create a new advertisement/enforcement divergence for a live `settling` worker.
The recovery-only `unknown` state is what the gate actually excludes and what
the guard now enforces.

---

## Fix 2 — V5 request profile check agrees with the persisted-state check

### Seam
`pi-herdsman/extension/mailbox.ts`, V5 `kind === "request"` validation
(`validateAcceptedAssignmentContract(... minimumProfile: "common")`).

### Change
- `RequestRecord` gains `briefProfile?: BriefProfile`.
- The request field allowlist gains `briefProfile`; V4 request records reject it
  as V5 assignment metadata.
- V5 task/interrupt requests must now carry a valid `briefProfile`
  (`BRIEF_PROFILES`); the value is passed as `minimumProfile` to
  `validateAcceptedAssignmentContract`, so a weaker claimed brief profile is
  rejected. Steer/reply requests must not carry the field.
- Writer side: `submit` requires the profile for task/interrupt and rejects a
  missing one with `invalid_request`; `index.ts` passes
  `roleLaunchInputs.briefProfile` on both task paths and the interrupt path.
  Byte accounting (`requestRecordBytesFor`, `prospectiveAssignmentFits`) counts
  the new field. The persisted-state validator at `mailbox.ts:454` is untouched.

### Red observation (before the fix)
`extension/mailbox.test.ts` — new regression
`V5 task and interrupt requests carry and enforce the definition's brief profile`,
run against pre-fix validator semantics (temporarily restored, then re-applied):

```
✖ V5 task and interrupt requests carry and enforce the definition's brief profile
  AssertionError: Missing expected exception.
  actual: undefined  expected: /require a valid brief profile/
  at .../mailbox.test.ts:243:10
```

i.e. a V5 assignment request with no brief profile was accepted, and the
`minimumProfile: "common"` no-op let a common brief pass for a stronger request
profile.

### Green observation (after the fix)
Same test passes: a missing profile is rejected, a `briefProfile: "review"`
request wrapping a `common` accepted assignment is rejected with
`requires review`, and matching task and interrupt requests round-trip.

### Decision
No new typed error code was added. The mailbox boundary throws its existing
bounded `Error` diagnostics; the owner-side writer reuses the existing
`invalid_request` category. The pump admission at `index.ts` still validates
against `state.briefProfile` exactly as before, so the persisted-state path is
unchanged and now agrees with the request boundary because both derive from the
same `roleLaunchInputs.briefProfile`.

---

## Fix 3 — a withheld settlement retries without a provider wake

### Seam
`pi-herdsman/extension/index.ts`: the withhold branch in `settleCurrentAgent`
(durable record `background settlement withheld completion`), the
`watchBackgroundWorkChanges` subscription into `refreshBackgroundWaitingEvidence`,
and the `flush`/`agent_settled` publication path.

### Change
- New bounded backstop `SETTLEMENT_BACKSTOP_MS = 5000` (`settlementBackstopTimer`).
  `ensureSettlementBackstop(ctx)` arms it when a hold is recorded (withhold
  branch) or recovered (`watchBackgroundWorkChanges` with persisted
  `backgroundWaiting`); each tick re-runs `settleCurrentAgent` while the
  assignment is still held, and the timer stops itself when the assignment is no
  longer held.
- The change subscription now also re-runs settlement when a fresh answer is
  already pending (`freshResponse`), so a notification can let settlement
  publish without waiting for the backstop.
- The timer is stopped explicitly in `finalizeStateTransition`, the
  result-write-failure recovery, and `session_shutdown`.

### Invariants and how they are satisfied
- **Exactly one result per assignment**: only `settleCurrentAgent` publishes; its
  entry guard (`pendingResult`, `pendingStateTransition`) prevents concurrent
  runs, `flush` clears `pendingResult` after the single write, and
  `finalizeStateTransition` clears `activeRequestId`, after which every retry
  returns immediately.
- **No busy loop / bounded cadence**: one 5 s interval, `unref`ed, that stops on
  first unsafe tick and is stopped on settle/reuse/close.
- **Notification still never resolves a result**: the subscription only
  refreshes evidence and, when a fresh answer is pending, re-runs settlement;
  publication stays inside settlement.
- **Genuinely outstanding work is still held, durable record still written**:
  the test asserts the worker stays held (no result, no prompt) across backstop
  ticks while work is outstanding, and asserts the durable
  `pi_herdsman_state_error` record containing
  `background settlement withheld completion`.

### Red observation (before the fix)
`extension/agent-runtime.test.ts` — new regression
`a withheld settlement retries without a provider wake`:

```
node --experimental-test-module-mocks --import=./scripts/test-env.mjs --test \
  --test-timeout=30000 --test-name-pattern="a withheld settlement retries without a provider wake" \
  extension/agent-runtime.test.ts
✖ a withheld settlement retries without a provider wake
  AssertionError: the backstop requests a fresh final response
  0 !== 1
  at .../agent-runtime.test.ts:702:12
```

i.e. after the provider resolved atomically with no notification and no wake,
nothing re-ran settlement and the worker stayed held forever.

### Green observation (after the fix)
Same command passes. The test then delivers the fresh answer and asserts the
result is published once, and that a further 30 s of ticks neither duplicates
the result nor re-prompts.

---

## Verification commands and results

Full-suite runs must be executed with the invoking shell's managed-agent
variables unset: this work ran from inside a pi-herdsman worker, whose
`PI_HERDSMAN_*` / `PI_SUBAGENT_*` environment makes the role probe report
`managed-agent` and breaks tests that assume a default lead shell (for example
`the documented agent_extend schema matches the registered tool`). That test
defect is environmental, not a repository regression; it passes with the
variables unset. The scrubbed environment used for every result below is:

```
env -u PI_HERDSMAN_AGENT_DEFINITION -u PI_HERDSMAN_ALLOWED_AGENT_DEFINITIONS \
  -u PI_HERDSMAN_BRIEF_PROFILE -u PI_HERDSMAN_LABEL -u PI_HERDSMAN_MAILBOX \
  -u PI_HERDSMAN_OWNER_SESSION_ID -u PI_HERDSMAN_RUN_ID -u PI_HERDSMAN_WORKSPACE_ID \
  -u PI_SUBAGENT_CHILD -u PI_SUBAGENT_PARENT_SESSION
```

(results appended below)

- `npm test` (scrubbed env, `node --experimental-test-module-mocks --import=./scripts/test-env.mjs --test --test-timeout=30000`, bg-86): exit 0 — tests 951, pass 950, fail 0, cancelled 0, skipped 1, duration 85.8s.
- `npm run validate` (same run, bg-86): exit 0 — `package audit passed: 112 files`.

Log: `/tmp/kendex-pi-bg/lanes/01a10ca9-ee3a-7501-8a16-256a19940e06/bg-86-1791216360248.log`

## Files changed

Implementation:
- `pi-herdsman/extension/index.ts` — extend liveness guard + `resolveRuntime` presence,
  V5 request `briefProfile` plumbing, settlement backstop/notification re-run.
- `pi-herdsman/extension/mailbox.ts` — request allowlist, `RequestRecord.briefProfile`,
  V5 task/interrupt profile requirement and enforcement.

Test fixtures / regressions:
- `pi-herdsman/extension/support.ts` — request helper fills `briefProfile`.
- `pi-herdsman/extension/mailbox.test.ts` — helper + Fix 2 regression.
- `pi-herdsman/extension/agent-runtime.test.ts` — helper + Fix 3 regression.
- `pi-herdsman/extension/recovery.test.ts` — Fix 1 regression; lost-worker
  extension now asserts no durable extension entry.

Docs / specs:
- `pi-herdsman/docs/reference/agent.md`
- `pi-herdsman/docs/reference/agent-states.md`
- `pi-herdsman/docs/concepts/delegation.md`
- `openspec/specs/herdsman-soft-deadline/spec.md`
- `openspec/specs/herdsman-background-work/spec.md`
- `openspec/specs/herdsman-delegation-briefs/spec.md`
