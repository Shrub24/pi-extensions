# Design

## Contract and accepted host boundary

The user explicitly resolved the former host gate on 2026-10-23. Resumption is opt-in and off by default. Preexisting queued `nextTurn` messages intentionally join the resumed conversation. Public pending checks still defer active steering/follow-up. Programmatic idle `session.abort()` emits no observable extension event on Pi 1.2.0; explicit `/route-resume off`, terminal Escape/Ctrl+C where available, active-run abort and session/model/branch/shutdown events provide cancellation. Long idle gaps are acceptable. No host fix or empty hidden queue is a prerequisite.

The preserved parent proof `post-settlement custom continuation preserves completed tools after quota exhaustion` exercises real `AgentSession.sendCustomMessage(..., { triggerTurn: true })`. The production coordinator uses public `ExtensionAPI.sendMessage` with the same native custom-message continuation. The host exposes its intent/generation details in `before_agent_start`. A hidden custom control message is appended to existing history and becomes model-visible user content; no failed entry is removed and no completed tool request is replayed. The two original host-boundary tests remain as evidence of the accepted nextTurn and idle-abort semantics.

Unsafe partial text/thinking/tool output and unresolved tool calls cannot enter waiting. Normal immediate recovery remains authoritative. The full native-host production test runs a tool, exhausts all physical candidates, waits with fake time, resumes once with queued nextTurn content, and verifies that the completed tool ran exactly once.

## Runtime and scope

`src/resumption.ts` installs one finite session-local coordinator, simple command controls and an injectable timeout schedule. There is no scheduler service, process launcher, paid passive model poll or new dependency. `installRouter` provides the existing authenticated candidate loader, shared health, pin lookup, coordinated quota refresh and optional test runner/clock.

Phases are `armed -> waiting -> waking -> running`, with terminal `stopped` and inert `suspended` states. Arming can precede the next prompt; that first actual prompt attaches the task instead of cancelling permission. Arming during an active task attaches that task. A subsequent submitted user intent cancels it. `once` is consumed by resumed successful assistant progress; its scope remains enforced through the rest of that native run. `on` persists across further capacity stops until normal successful settlement, deadline or cancellation. Three unsuccessful actual wakes are allowed per pause; observations and failures never reset the budget. Successful resumed progress permits a fresh budget for a later pause. Each explicitly authorized wake begins a bounded native attempt, then ordinary retries/fallback retain their existing attempt counters. A safety-budget failure with otherwise usable capacity alone does not arm waiting.

Commands are `/route-resume once|on|off|status [--scope route|pin|provider:<id>[#account]|target:<provider>/<model>[#account]] [--until ISO]`. Default scope is route regardless of a pin, default deadline is 24 hours. Scope parsing validates an intersection with configured route candidates. `pin` snapshots its full exact target/account identity. Single-key and default-auth providers have no synthetic account. There is no picker or settings writer. Completions offer verbs, flags and configured scope examples.

Initial native recovery keeps its normal route policy. Once a delayed wake starts, both selection and fallback intersect the saved scope and per-candidate quota readiness. Automatic execution disables explicit pin health bypass. Existing strategy evaluation, authentication activation, fit checks, probe leases, usage accounting and awaited Magic Context transitions remain in charge. Direct calls are unaffected. Capacity lost before final route return produces a structured rejection and re-enters a bounded wait. New task routing has no leftover scope constraint.

## Terminal facts and capacity evidence

The route resolver records structured no-candidate rejection facts instead of parsing its displayed exhaustion diagnostic. Terminal settlement classifies empty physical quota errors and rate errors with explicit reset/retry hints; it also scans tool-call/result pairs. Physical failure observations are recorded even when immediate recovery budgets are exhausted. Authentication, invalid/partial output, missing fit/credentials and budget-only exhaustion cannot justify waiting.

Readiness reads all quota windows and health causes on every scoped usable candidate. A short reset does not erase a weekly exhausted window. A tracker-derived pause remembers the need for affirmative fresh authoritative capacity, including after an operator clears blocks or a failed fetch replaces a snapshot with unknown. Stale and estimated observations cannot establish restoration. Failure-derived cooldown expiry permits a normal leased attempt only without contradictory quota evidence.

Tracker snapshots carry the health revision captured before their fetch. A complete fresh authoritative healthy reading at or after the pause can clear only older quota/tracker-quota causes, never auth, outage, rate or a newer physical failure. The local quota mirror is cleared only after the shared revision-fenced deletion proves no quota cause remains. All non-capacity health remains binding. Normal shared admission still decides the physical attempt.

The existing five-minute quota interval triggers rechecks. One timeout per intent schedules the next relevant reset (minimum one second), five-minute bound, or deadline; unavailable data backs off five minutes. Timeout checks request the existing coordinated refresh using its four-minute shared fetch gate. They never use `force` or operator-clear semantics. Repeated observations are silent and cannot enqueue a second wake.

## Ownership, persistence and cancellation

The existing private SQLite health store gains `resume_intents` with atomic arm/replace/transition/claim operations. A unique partial index allows one active intent per session, which is stronger than per branch. Each explicit arm creates a new id and generation with a process owner. Claims compare owner, generation and prior phase under `BEGIN IMMEDIATE` and install a bounded wake lease. Another connection cannot claim the same waiting phase; replacement and explicit off revoke prior generations. An expired claim cannot start a deferred wake. Running permission is not expired mid-tool.

Only lifecycle identity, session/branch pointer, normalized scope, mode, deadline and short outcome enter intent records. Attempts, snapshots, prompts, credentials and raw errors are not persisted. Session custom entries hold only `{ id }`. Restoring an active pointer displays local suspended state and does not claim or run it; explicit re-arming replaces old permission. Explicit off can revoke a suspended pointer from an earlier process. Terminal retention is at most 100 records for seven days, pruned on lifecycle writes. Closed expired waiting permission is stopped during maintenance; no persisted row launches a process.

Before enqueueing, the coordinator synchronously validates generation/owner/claim, idle/pending status, selected route, session and conversation head, with no intervening await. Preference-only custom entries (pin/thinking) do not change the conversation head. Actual conversation edits do. `before_agent_start` recognizes router custom intent/generation metadata; the resolver captures that fence and checks it before selection and again after awaited transition/key activation, immediately before returning a physical model. A stale already-queued router wake cannot dispatch a provider call. The accepted native nextTurn queue may append its content between these two boundaries; it is intentionally retained.

Off, active abort, actual user input, model changes, session switch/fork/tree/compaction changes and shutdown invalidate permission and clean up timers. A non-consuming terminal hook observes Escape/Ctrl+C when supplied. Programmatic idle abort remains the accepted documented limitation. Deadlines authorize starting a wake and never forcibly kill an already running tool/request. Intent-store failure suspends automatic execution; ordinary routing keeps its existing local-health degradation behavior.

## Operator visibility and rollout

Transition notices announce arm/wait/resume/cancel/stop, without per-poll noise. `/route-resume status` includes phase, mode, scope, limiting windows, tracker freshness/source, next check, deadline, attempts and outcome. `native-router-resume` is a separate footer item visible when armed/waiting/waking/running; it never replaces physical identity. The README includes command/scope examples, status configuration, persistence/restart semantics, cancellation limitations and rollback via explicit off/removal. No dotfiles are changed.

## Validation evidence

Automated coverage uses injected schedules and tracker runners, real shared SQLite connections, and the installed Pi 1.2.0 native host with synthetic providers. It covers multi-window exhaustion and early restoration, unknown after manual clearing, revision fencing, duplicate observations/owners, expired claims, suspended restore, retention, three unsuccessful wakes, deadline behavior, first-prompt arming, actual user cancellation, terminal keys and lifecycle cancellation, stale queued dispatch fencing, scope-constrained fallback and exactly-once completed tools. No live provider requests, installs, commits or pushes were performed.

Final validation (2026-10-23):

- `bun test tests` from `pi-native-router`: **195 pass, 0 fail, 851 assertions across 17 files**. Includes the unchanged parent proof, six new production native-host scenarios, and 29 coordinator/store scenarios.
- Focused production/test typecheck: **pass**, using the command below. It excludes only `example-strategy.test.ts`, which imports the pre-existing affected example.
- `bun run typecheck`: **fails on the pre-existing** `examples/peak-quota-strategy.ts` import of `@vanillagreen/pi-native-router/strategy` and its consequent typing errors; no production/resumption typing errors. This unrelated alias was not changed.
- `openspec validate router-auto-resumption --strict`: **valid**, no warnings.
- `git diff --check -- pi-native-router openspec/changes/router-auto-resumption`: **pass**.

```bash
mapfile -t router_check_files < <(rg --files src tests -g '*.ts' -g '!example-strategy.test.ts')
./node_modules/.bin/tsc --noEmit --target ES2023 --module ESNext --moduleResolution Bundler --strict --skipLibCheck --types bun --allowImportingTsExtensions "${router_check_files[@]}"
```

Changed production files: `src/resumption.ts`, `src/index.ts`, `src/health-store.ts`, `src/policy.ts`, `src/quota.ts`. Tests: `tests/resumption.test.ts`, `tests/host.test.ts`. Documentation: package README and this change's proposal/design/spec/tasks. Edits are restricted to `pi-native-router/**` and `openspec/changes/router-auto-resumption/**`; unrelated concurrent workspace changes were left alone.

Live smoke (task 5.2) remains the only unchecked task. Automated evidence does not claim live provider quota timing, interactive terminal smoke or live usage accounting verification. Pi 1.2.0 programmatic idle abort is the accepted documented limitation; queued nextTurn content is intentional. Parent integration review additionally caught and fixed a fit regression: waiting now uses Pi's usage-aware context count, falling back to transcript estimation only when unavailable, matching normal routed dispatch. A regression test covers a long transcript whose authoritative count still fits. The footer status is compact (`resume armed`, `resume waiting`, etc.); full scope, blockers and timing remain in `/route-resume status`. Dotfiles `nix/modules/agents/pi.nix` wires this optional status key into the secondary Powerline row and parse-checks; that external configuration is uncommitted. No live provider smoke or deployment was performed.
