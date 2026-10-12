# Herdr removal from pi-herdsman: progress

## Checkpoint (a): preflight, role, location, child env (production edits landed; focused tests measured below)

Production changes (pi-herdsman/extension):
- radar-location.ts: tmux-only. `radarLocalPane(env)` reads TMUX_PANE (strict %N); `radarPaneHandle()` added; HERDR_* cross-checks and the Herdr fallback removed; non-tmux backend => absent.
- index.ts: `role()` lead = unmanaged session with TMUX_PANE; managed child env requires TMUX_PANE and compares its raw pane with the parent handle; mailbox paneId = TMUX_PANE; `herdrVersion` replaced by `radarPreflight()` (ping, backend tmux, spawn/observe contracts); `radarLeadWorkspace()` replaces HERDR_WORKSPACE_ID; refusal code renamed `not_running_inside_herdr` -> `not_running_in_radar_pane` (errors.ts, docs/reference/errors.md); inactive notice rewritten.

Measured: tsc (extension/*.ts, same command as tsc-check.sh, TS 5.9.3) 656 -> 661. All 5 new errors are in test files (parseHerdrVersion in extension-contract.test.ts; radar-location.test.ts two-arg radarLocalPane). Not yet fixed; tests not yet updated.

## Finding that blocks checkpoints (b)/(c): observe does not present Pi agents under tmux

Probe (/tmp/hfp/probe.mjs, pinned binary sha 62e6bf39..., disposable tmux server, harness-equivalent env):
- ping: backend tmux, instance <server>, capabilities as expected.
- observe: workspaces/tabs/panes populated; `agents: []`.
- register an operator with session UUID and location: ok, agent_id returned; observe `agents` still `[]`.
- same with a process claim: still `agents: []`.
So under the pinned tmux backend, mux.observe does not present registered Pi agents. The Herdr-era presence, Chief lookup, peer presence and focus code all read observed agent rows. Memory 5070 says the registry projection reaches observe under tmux; the pinned tree does not show it (collector.rs:375-381 is foreground evidence there).

## Checkpoint (a) measured counts

Focused suites, run per file with `node --test --experimental-test-module-mocks --import=./scripts/test-env.mjs`:
- radar-location.test.ts: 14 pass, 0 fail
- radar-client.test.ts: 44 pass, 0 fail
- radar-launch.test.ts: 23 pass, 0 fail
- radar-publication.test.ts: 22 pass, 0 fail
- extension-contract.test.ts: 5 pass, 40 fail. Same failure set as the pre-alignment lock tree (scratch copy, sibling pi-bash-processes linked), so this is not from the Pi 1.1.0 alignment. Committed-HEAD comparison: see the HEAD baseline below.

tsc (`extension/*.ts`, qmd-bundled TypeScript):
- after checkpoint (a) edits, before the Pi alignment: 655 errors (baseline at HEAD 656)
- after Pi 1.1.0 alignment: 657 errors. New vs pre-alignment: two TS2352 in commands.test.ts (`setTimeout`/`setInterval` cast) and a TS2739/TS2740 message change in presentation.ts. Attributed to Pi 1.1.0 types, not to the removal.

`npm run check` (authoritative, exit captured directly):
- pre-alignment lock, working tree: 1103 tests, 624 pass, 478 fail, exit 1. Failures are not the four pre-cutover names; the four named installer/runtime tests are among them.
- the scratch baseline first failed with a missing-sibling import (`../pi-bash-processes`). That was my harness error, fixed by symlinking the sibling package; numbers above are after the fix.

## Dependency alignment: Pi 1.1.0 (separate item, own commit)

Owner direction: align the dev graph to Pi 1.1.0 (Herdsman uses `agent_settled.aborted` from b27bf1dfd and the deployed Pi is 1.1.0). Not part of the Herdr removal.

Changes:
- package.json devDependencies unchanged (already 1.1.0); `piHerdsman.runtime.pi` 0.99.2 -> 1.1.0.
- package.json: `overrides: { "@earendil-works/pi-codemode": "1.1.0" }`. Reason: `npm install --package-lock-only` resolved pi-codemode 1.2.0, which dropped `MCP_TYPESCRIPT_PREAMBLE` (pi-coding-agent 1.1.0's `dist/extensions/codemode/tool.js` imports it), and every codemode-dependent test file failed to load. Pinned to the 1.1.0 release that pi-coding-agent 1.1.0 requires (`^1.1.0`).
- package-lock.json regenerated with `npm install --package-lock-only --no-workspaces` (workspace discovery fails on the sibling `workspace:*` dependency).

Lock diff summary (pi-herdsman, 262 -> 147 entries; the entry count drop is mostly flattening):
- @earendil-works/pi-ai 0.99.2 -> 1.1.0; pi-coding-agent 0.99.2 -> 1.1.0; pi-tui 0.99.2 -> 1.1.0; pi-telemetry 0.99.2 -> 1.2.0 (top-level, transitive of pi-coding-agent); pi-codemode (nested under pi-coding-agent) 1.1.0 by override.
- New top-level Pi transitives: chord 1.2.0, pi-agent-core 1.2.0 (with nested pi-ai 1.2.0), pi-mcp 1.2.0.
- Transitive moves: @anthropic-ai/sdk 0.124.0 -> 0.129.0 (dep of pi-ai), @babel/runtime 7.29.7 -> 7.29.10 (via json-schema-to-ts, from @anthropic-ai/sdk), plus shared utilities (diff 8.0.4, ignore 7.0.8, undici 8.10.2, yaml 2.9.0, quickjs-wasi 3.6.2 and others) that were hoisted from the Pi subtree.
- Everything moved is in the Pi dependency graph; nothing outside it.

Verification:
- scratch `npm ci --ignore-scripts` on the new lock: exit 0; installed pi-ai, pi-coding-agent, pi-tui all 1.1.0.
- working-tree `npm ci --no-workspaces`: exit 0.

Known issue to resolve: 478 failing test names in the working tree with this lock, identical to the set with the pre-alignment lock. Not caused by the alignment; these are the uncommitted cutover fixtures (the fake daemon's observe rows, see below).

HEAD baseline (`git archive HEAD pi-herdsman pi-bash-processes` into a scratch root, HEAD's own lock, `npm ci --ignore-scripts`, `npm run check`): exit 1, 1101 tests, 1096 pass, 4 fail. The four failures are settlement tests:
- a recovered worker settles with an unretrieved prior-request result named in its answer
- only unfinished work holds while unreviewed terminal results settle
- settlement publishes an unread terminal result without a post-review response
- unfinished background work holds settlement through a flush and late work
All four are also in the working tree's failure set, so the working tree adds 474 failing names over HEAD. The owner's expectation of "only the four pre-cutover failures" is not met; the 474 are cutover fixture fallout, not yet fixed.

## Child presence probe against the pinned Radar daemon (Option A correction)

Probe: a bound child under the pinned tmux backend (scripts/herdr-free-acceptance.mjs, temporary copy, deleted afterwards).
- `observe.agents`: `[]` after the child binds (pane reported, two panes). Confirmed: tmux observe never presents registered agents.
- `spawn.get` edge: bound, `agent_id` = child's registration, location pane `tmux:<server>:%1`, freshness fresh, state bound, `exit_observation.state` unknown.
- production `observeRadarChild` (radar-launch.ts) on that edge: `kind: live` with pane and agent_id, no observe read.
- `agent.get(agent_id)`: `verified`, claimed true.

Finding: a real child with a recorded spawn edge is presence-proved through `spawn.get`, not through observe. The observe fallback in `managedAgentPresence` (inventory.agents match) can never claim a child under tmux, so it always returns unknown when the spawn path does not prove. The spawn path does not yet call `agent.get` for the process verdict or compare the registration location to the stored one, which the Design A rule requires. The fake daemon still returns registered agents in observe rows, so its tests certify a shape the real daemon does not produce. Correction to Option A: identity is the registry's exact `agent_id` (spawn-bound, then `agent.get`), not the observed agent rows.

## Step 1 attribution: 474 extra failures (npm run check, working tree, 478 failing, 1103 tests)

Method: parsed the `failing tests` section of the check log into one row per test (file, name, first error line). 478 unique names; the four HEAD settlement names are among them.

| cause | count | evidence |
|---|---|---|
| G1 role not managed/lead: the fixture sets `HERDR_ENV`/`HERDR_PANE_ID` but no `TMUX_PANE`, so `isManagedAgentEnvironment()` is false and `role()` yields unmanaged; tools/handlers never register (`reading 'execute'`, `'0'`, `'runId'`, `'cwd'`, `'parameters'`, `'handler'`, `'data'`, `'sha256'`) | 379 | Diagnostic: adding `TMUX_PANE`+`TMUX` to the two shared fixture setups (support.ts `setAgentEnvironment`, `setLeadEnvironment`) moved the three extension-contract tests that reached a surface assertion from the missing-tool error to a real surface assertion. Reverted. |
| G2 inactive notice where tests expect commands/footer (`not running in a tmux pane`) | 9 | same as G1 (role) |
| G3 waitFor timeout / child never registered as a Radar subject | 7 | the fake child has no TMUX location (see below) |
| G4 test home ENOENT for `agents/*.md` | 3 | separate fixture path issue, not yet inspected |
| G5 other assertion failures | 80 | not yet attributed per test |

Diagnostic on extension-contract.test.ts (partial, killed at the 10-minute ceiling because one test hung): 4 pass, 3 fail. The three that reached a surface assertion now fail on the expected tool set, so G1 explains them. The hang is a separate finding, not yet attributed.

Root cause of G3 and of the child-presence test: the fake daemon (support-radar.ts) is Herdr-era. `backend: "herdr"`, `instance: null`, spawn edge locations `backend: "herdr"`, and free pane names such as `startup-pane`, `lead-pane`. A child can only publish its own location through `radarLocalPane` under a tmux backend, so the fake child registers with no location and presence cannot be proved. Fixing this needs the fake to be tmux-qualified (`tmux:<server>:%N` handles, `TMUX_PANE` set for lead and child). That renames roughly 150 pane references across about ten test files. This is the decision asked of the owner.

## Child presence (checkpoint e-prep): observeRadarChild verdict check

Done in extension/radar-launch.ts: after the bound edge is read, `client.agentGet(edge.bound.agent_id)` is called. Verdict `absent` or `mismatched` gives `gone`; a failed read or any verdict other than `verified` gives `unknown`; a registration location pane different from the stored `provenance.pane_id` gives `unknown`.

Done in extension/support-radar.ts: `agent.register` keeps `location` and `session` on the subject, so `agent.get` answers the registration the way the real daemon does.

Measured: radar-launch.test.ts 22 pass, 1 fail. The failing test ("a live child is proved by the daemon's current read of its own edge") now reports `registered on no pane` because its simulated child registers with no location, the G3 cause above. Not yet fixed; blocked on the fake-tmux decision.

Fixture state: support.ts and support-radar.ts are back to their pre-diagnostic content. The only support.ts changes left are the peer's footer-status `setStatus` lines (2 insertions), which I did not touch.

## Shared fixture change (tmux-qualified fake): measured

Changes:
- support.ts: `setLeadEnvironment` and `setAgentEnvironment` set `TMUX=herdsman-fixture,1,0` and `TMUX_PANE=%1` (FIXTURE_TMUX_ENV, FIXTURE_LEAD_PANE, imported from support-radar.ts); `HERDR_ENV` removed; `TMUX`/`TMUX_PANE` added to the cleared-key list.
- support-radar.ts: fake daemon default `backend: "tmux"`, `instance: "herdsman-fixture"`; observedFleet reports the lead pane as `tmux:herdsman-fixture:%1` from TMUX_PANE. Fixture constants defined here.
- Peer footer-status setStatus lines in support.ts untouched.

`npm run check` after this change: cut off by the 120 s suite deadline ("check: suite deadline exceeded while running tests"), so its counts are NOT authoritative (memory 5085). 911 of 1103 tests reported, 178 failing names reported before the cut. A `SyntaxError: Named export 'lstatSync'` also appears from radar-client.ts during the run, not yet attributed.

## extension-contract hang: found by name

Test "Lead startup publishes minimal peer presence before provenance resolves" (extension-contract.test.ts:836) never completes; `--test-timeout=20000` by name gives `test timed out after 20000ms`.

Cause: the test awaits `starting` (session start) before it resolves `releaseProvenance`, while session start awaits that gate. The gate is the peer provenance enrichment `workspacePresentationProvenance` (index.ts ~2619), which calls `runHerdr(["workspace","get", ...])`, a removed Herdr CLI call. At HEAD the Herdr path resolved; under the Radar lead path the enrichment is now reached and gated.

Classification: subject is a removed mechanism (Herdr `workspace get` peer provenance). Under memory 5069 the test is delete-or-rewrite, and the enrichment itself is a presentation decision (Radar has no workspace.get, so repo/branch/workspace label presentation has no source). Asked the owner before choosing.

## Owner ruling (A) applied: Herdr peer provenance enrichment removed

Owner: delete `workspacePresentationProvenance` and the Herdr enrichment; peers show cwd and pane; repo, branch and workspace label stay unknown (absent, never guessed). No local git read. Workspace label slot renders the workspace id or nothing. Facts may later come from Radar's facts channel (note #206), a separate slice.

Production changes:
- index.ts: `workspacePresentationProvenance` deleted (it called `runHerdr(["workspace","get",…])`); the peer-presence async enrichment block that wrote repo/branch/label is deleted (the synchronous minimal record remains); the `workspaceProvenance` call at lead projection and its argument deleted; `WorkspaceProvenance` import removed.
- supervision.ts: `workspaceProvenance` option removed; lead displayName is `${workspaceId}/${tabLabel or lead-…}`; branch and workspaceLabel no longer populated; `WorkspaceProvenance` type deleted.

Test changes (memory 5069; delete or compact rewrite only where the invariant still holds):
- supervision.test.ts: "supervision presentation preserves provenance and naming fallbacks" compactly rewritten as "supervision presentation names leads by workspace id and tab fallbacks" (naming fallbacks kept; provenance inputs removed). Result: supervision.test.ts 49 pass, 0 fail.
- extension-contract.test.ts: "Lead startup publishes minimal peer presence before provenance resolves" rewritten as "…without any enrichment" (keeps the minimal-record key set and no repo/branch/label). Deleted (subject = the Herdr enrichment race): "peer provenance enrichment never replaces the Lead cwd", "peer publication tolerates sender and target presentation enrichment during attachment preparation", "session shutdown prevents pending peer presence publication", "stale peer publication cannot replace a same-session lifecycle generation".
- commands.test.ts: deleted "Chief leave restores minimal peer presence before provenance resolves" (gated on the removed Herdr `workspace get`). Coverage gap, follow-up: Chief-leave restoring the minimal peer record is not covered by any remaining test; add a compact test if it matters.

## Hang finding (for the final report)

extension-contract "Lead startup publishes minimal peer presence before provenance resolves" hung for the whole suite. Its cause was a real dependency, not a fixture artifact: session start awaited the Herdr CLI `workspace get` (peer provenance enrichment), which a Herdr-absent run would also hit. The test awaited `starting` before releasing the gate. Resolved by removing the enrichment (owner ruling A), not by a timeout.

## Measured after these changes

- supervision.test.ts: 49 pass, 0 fail, exit 0.
- extension-contract.test.ts: 21 pass, 20 fail, exit 1, no hang (exit captured, --test-timeout 20000). The 20 failures are next-layer assertion mismatches (Chief/inspect/pane strings, one `no Radar registration named registered-pane`, one `This process's own pane is …` refusal). Not yet attributed per test.
- Full `npm run check`: not re-run successfully since the shared-fixture change. The earlier run was cut off by the 120 s suite deadline, so its counts are not authoritative.

## Not done in this slice (remaining work, not started)

- Residual failures: about 470 names in commands, recovery, agent-runtime, controller-lifecycle, controller-api, control-integration, worker-addressing and extension-contract. The "other" and ENOENT groups are unattributed beyond the first error line.
- Fake daemon: observe still does not return agents for tmux, which is correct now; the remaining fake pane names (`startup-pane`, `lead-pane`, `registered-pane`) are still free strings in about ten test files. Child location still cannot be proved in fixtures (radar-launch "live child" test fails with `registered on no pane`).
- herdr.ts (about 2600 lines), index.ts `runHerdr` callers (about 3 left), the Chief/peer/focus presence rewrite (checkpoints b and c), packaging deletions (d), and the image build, container smoke and real-child acceptance (e).
- `pi-codemode` override: still unproven. Needs the scratch `npm ci` without it to show the exact failure, or removal.
- `tsc` and package audit not re-run in this checkpoint.

## pi-codemode override: proven required (scratch copy, fresh lock)

Scratch /tmp/cm-check: package.json copied with `overrides` removed; lock deleted and regenerated with `npm install --package-lock-only --no-workspaces`. Fresh resolution puts `@earendil-works/pi-codemode` 1.2.0 at the top level (pi-coding-agent 1.1.0 declares `^1.1.0`, which 1.2.0 satisfies). `npm ci --ignore-scripts --no-workspaces` exit 0. Then:

    node -e 'import("@earendil-works/pi-coding-agent")'
    SyntaxError: The requested module '@earendil-works/pi-codemode/declarations' does not provide an export named 'MCP_TYPESCRIPT_PREAMBLE'

pi-coding-agent 1.1.0 dist/extensions/codemode/tool.js imports MCP_TYPESCRIPT_PREAMBLE from that path; pi-codemode 1.2.0 removed it. Decision: keep the override `"@earendil-works/pi-codemode": "1.1.0"` in package.json. Reason to keep in the package: upstream pins pi-coding-agent 1.1.0 to an export that 1.2.0 no longer has. Revisit when pi-coding-agent ships a release that matches pi-codemode 1.2.0.

(Note: an earlier scratch lock regenerated from the working-tree lock kept 1.1.0 only because the existing lock already pinned it; that run was not a fresh resolution and is not the evidence above.)

## Production (b)/(c)/(d-code) surface map (measured this pass, no edits yet)

Production Herdr mentions: herdr.ts 196, index.ts 115, support.ts 80 (fixture, not production), radar-execution.ts 5, support-radar.ts 4, presentation.ts 3, supervision.ts 2, radar-client.ts 1.

herdr.ts exports and their production consumers (outside herdr.ts):
- Dead (no consumer, delete with the file): startHerdrAgent, startHerdrAgentInPane, closeHerdrPane, stopHerdrAgentPreservingPane, rollbackHerdrStart, paneProcess (used only internally), worktreeGroupScope, structuredTopologyEnvironment, childLaunchPlan, childLaunchLine, sameObservedSessionPath, sameShellProcessOwner, sameRunningProcessOwner, captureStartupDiagnostic, startupTimeoutBudget, herdrReporterExtensionPath, listHerdrAgents.
- Live from index.ts (replacement needed): listAllHerdrAgents (Chief liveAgent/remoteChiefAgent, focus proof at ~11973, managed presence); runHerdr (remoteChiefAgent alias check ~10663, one more ~10797); inspectHerdrAgent (captureManagedInspection ~6096, ~12228, ~13671); herdrAgentAlias (9 refs, child alias naming); matchesExpectedSession/sessionIdentity/readPiSessionHeaderId (session matching, can stay if reworded); sameCwd; resolveChildCommand/CHILD_COMMAND_ENV (child launch command); STARTUP_TIMEOUT_MAX; types ExpectedSession, HerdrStartPlacement.

Radar replacement sources (pinned f87348032a80, docs/mux.md):
- Chief/peer identity and focus target proof: agent.get(agent_id) with verified verdict and matching location (Design A, owner-ruled).
- Inspect process: mux.process_info (foreground evidence; inconclusive is not proof of exit).
- Inspect recent output: mux.output (bounded, non-consuming snapshot).
- Focus: mux.focus. Input: mux.input.
- Herdsman's radar-client.ts wraps only observe, focus and request.get. mux.output, mux.process_info and mux.input need client wrappers before inspect can move. This is wiring, not a Radar contract gap.

Remaining work, in order: (1) radar-client wrappers for mux.output and mux.process_info; (2) inspect via Radar; (3) Chief remote proof, liveAgent and focus via agent.get; (4) delete herdr.ts dead exports and the live ones once replaced; (5) rename herdr-era helpers (alias, runtime herdrAgent fields) under the data-migration question below; (6) fixtures and one test pass; (7) image and container smoke; (8) real-child acceptance.

Open design question (for owner): the persisted runtime field `herdrAgent` and its alias naming are stored in mailbox/runtime state. Removing the alias means a migration or a rename. Not decided.

## Pass 3 (production step 1 of the removal): inspect via Radar, partial

Done and measured:
- radar-client.ts: `output(request)` (mux.output, source `recent_unwrapped`, lines) and `processInfo(request)` (mux.process_info, returns `{kind: shell|non_shell|inconclusive, pid?, name?, command?}`) added, each gated by its own capability (`RADAR_OUTPUT_CAPABILITY`, `RADAR_PROCESS_INFO_CAPABILITY`). Only these two; no other mux wrapper added.
- radar-client.test.ts: two new tests (decode + pane target; missing capability dispatches nothing). Suite 46 pass, 0 fail (was 44).
- support-radar.ts: fake daemon advertises both capabilities and answers both methods (shell foreground; empty output). Suite count unchanged by this.
- extension/radar-inspection.ts (new): `provedOnPane(client, agentId, paneId)` (verified verdict and registration location.pane === paneId), and `inspectRadarChild(client, {agentId, paneId})`: proof, output (80 lines / 16 KiB caps kept from the removed Herdr inspection), processInfo, proof again ("changed during capture" refusal). Returns `{capturedAt, recentOutputTruncated, recentOutput?, foreground?}`.
- index.ts: `captureManagedInspection(runtime)` now = `validateRadarChild` (local binding) + `inspectRadarChild`. Callers at the managed inspect action (tool result key `process` renamed `foreground`) and the stale-diagnostic path updated. The 2 s STALE_DIAGNOSTIC_TIMEOUT_MS signal removed (Radar client has its own timeout). The stale-diagnostic `normalizeHerdrLifecycleState(...) !== "working"` gate REMOVED: it has no pinned Radar source for Pi activity; replaced by the verified process proof plus the mailbox evidence already checked above it. FLAGGED FOR OWNER: this is a behaviour decision.
- presentation.ts: `SupervisionPeekEvidence.process` (Herdr PaneProcess) replaced by `foreground?: RadarForeground`; renderProcessEvidence rewritten to the non_shell shape. presentation.test.ts (lines ~596, ~618) still uses `process` and must be rewritten in the test pass.
- index.ts: `import { inspectRadarChild } from "./radar-inspection.ts"` added.

Type check (ad-hoc tsc, /tmp/mgr-rm/tsc-check.sh, same command as before): 653 `error TS` lines in the whole run (baseline comparison not redone this pass). Remaining errors from this pass: index.ts lead inspect (~12223) reads `inspection.foreground` from the still-Herdr `inspectHerdrAgent`, which is the next step to migrate.

NOT done (remaining, ordered):
1. Lead inspect (index.ts ~12200-12260 peek, ~13660-13700 inspect action) still on inspectHerdrAgent. Needs the lead's own agent_id. Design: add optional `agentId`, `paneId`, `tabId`, `workspaceId` to CoordinatorState (supervision.ts ~1464), written by persistLeadCoordination (index.ts ~10322) from the lead's own registration (cache the subject from publication, as radarLeadIdentity does at ~1783). Record without agentId = unprovable, refused.
2. Staff listing: supervision.ts builds SupervisedLead from observed `options.agents` rows (validAgents: sessionId, workspaceId, tabId, paneId, runtimeState, tabLabel, piSessionFile). Rewrite the input to the coordination records verified per entry by provedOnPane. Observation-driven rows are dead under tmux (`mux.observe` agents always []), so this is required, not optional.
3. Chief proof: remoteChiefAgent (~10658) and liveAgent/liveLead (~10627-10700) use listAllHerdrAgents and runHerdr alias (~10663). Replace with provedOnPane(descriptor.agentId, descriptor.paneId) + session cross-check (contextSession vs descriptor.piSessionId). authorizeChiefRecord (~10865) uses liveLead length===1: replace with per-record proof.
4. Focus: focusProvedLocation (~11930) takes Herdr-shaped `proves(agent)` predicates from listAllHerdrAgents (~11973, ~12005, ~12020, ~12542). Replace with provedOnPane then client.focus({pane_id: paneId}). observedSessionAsHerdr / herdrSessionId / herdrSessionsMatch (~2604-2680) deleted with it.
5. Runtime.herdrAgent field (index.ts ~811) and herdrAgentAlias sites (4034, 4125, 4355, 5992, 6006, 6074, 9122, 14049): delete. Decision already ruled (not persisted; ignore on read).
6. herdr.ts: delete the file after items 1-5. The 17 consumer-less exports are deleted with it. Remaining live imports from herdr.ts to move or delete: sessionIdentity, readPiSessionHeaderId, matchesExpectedSession (session identity helpers, used by Chief/peer session matching), resolveChildCommand + CHILD_COMMAND_ENV (child command resolution, used by launch), sameCwd, STARTUP_TIMEOUT_MAX, types ExpectedSession and HerdrStartPlacement. Pure helpers move to an appropriately named module (for example extension/session-identity.ts), not herdr-named.
7. Managed presence observe fallback (managedAgentPresence inventory.agents match) is dead under tmux; delete or keep only the bound spawn path (observeRadarChild already proves presence).
8. Remaining Herdr env reads: index.ts/support.ts HERDR_* fixture env (80 fixture mentions in support.ts), radar-execution.ts (5), support-radar.ts (4), presentation.ts (3, the Herdr status labels), supervision.ts (2), radar-client.ts (1 comment).
9. Then the single fixture and test pass, the image, the container smoke, and the real-child acceptance.

Gate status: nothing from the final bar has been run for this pass (npm run check, tsc accepted count, package audit, image, smoke, acceptance). No production claim of Herdr-absence is made yet.

## Pass 4: activity gate restored on the published Radar fact (done, measured)

- radar-client.ts `agentProcessAt`: `RadarAgentProcess.activity` is read from `agent.get` `execution.snapshot` (PublicSnapshotFacts) and set ONLY when `execution.snapshot.freshness === "fresh"`; the activity string is `execution.snapshot.snapshot.activity`. Stale, null or missing execution leaves it absent = unknown. Pinned shape: docs/agent-registration.md (snapshot fields) and src/control_plane/registry/publication.rs (PublicSnapshotFacts, Freshness fresh|stale), server.rs agent.get assembly.
- radar-inspection.ts: `inspectRadarChild` takes the activity from the POST-capture proof read (the same agent.get that proves the process; no extra read). `RadarInspection.activity` is set only when published fresh.
- index.ts stale diagnostic: gate restored as `if (diagnostic && diagnostic.activity !== "working") continue;` (unknown does not satisfy; no diagnostic = old behaviour). The earlier removal is reverted in substance.
- radar-client.test.ts: one compact test covering fresh working (activity "working"), stale (undefined), null execution (undefined). Suite: 47 pass, 0 fail.

Type check (ad-hoc tsc, /tmp/mgr-rm/tsc-check.sh, `error TS` lines over the whole run incl. ../pi-bash-processes): 654. NOT directly comparable to the earlier 656/657 baseline, which counted extension/*.ts only; recount with the baseline counting before the gate. Still open from this pass: index.ts ~12223 (lead inspect) reads `inspection.foreground` from the still-Herdr `inspectHerdrAgent` (type `AgentInspection`): fixed when the lead inspect moves to inspectRadarChild.

## EXACT STATE AT STOP (pass 4) and NEXT STEP

Not accepted. Not run: npm run check (authoritative), package audit, image build, container smoke, real-child acceptance, the single fixture/test pass. herdr.ts still exists and is still imported by index.ts. The Herdr-absence claim is not made.

Done so far (all passes): checkpoint (a); owner ruling (A) peer enrichment removal; pi-codemode override proven required; Radar client output/processInfo/agent.get activity; radar-inspection.ts; managed-child inspect via Radar; stale-diagnostic activity gate on the published fact; presentation foreground rendering.

Next, in order (unchanged from the ordered list above, with the owner's rulings applied):
1. Lead inspect at index.ts ~12200-12260 (peek) and ~13660-13700 (inspect action): replace inspectHerdrAgent with inspectRadarChild(radarClient, {agentId: lead.agentId, paneId: lead.paneId}); add the session cross-check via the registration's contextSession (or the session in the record) in the validate step; drop the Herdr validator.
2. Coordination-record identity (approved schema addition): CoordinatorState (supervision.ts ~1464) gets optional agentId, paneId, tabId, workspaceId; persistLeadCoordination (index.ts ~10322) writes them from the lead's own registration (cache the subject from publication, the same source radarLeadIdentity uses at ~1783). Missing agentId = unprovable, refused, never reconstructed. One compact test: a coordination record without agentId is refused.
3. Staff list (supervision.ts buildSupervisionSnapshot input, validAgents built from observed rows): rebuild the lead entries from the coordination records, each verified by agent.get: verdict verified, location.pane === record.paneId, and contextSession === record.piSessionId when present. One compact test: a staff entry is listed only when agent.get verifies it; a record that fails verification is not listed. Observed rows are not an input.
4. Chief proof: remoteChiefAgent (index.ts ~10658) and liveAgent/liveLead (~10627-10700) and authorizeChiefRecord (~10865, liveLead length===1) use listAllHerdrAgents and the runHerdr alias check (~10663). Replace with per-record provedOnPane on descriptor.agentId/paneId (+ session cross-check). Unavailable = unknown = refuse. Restore the Chief-leave minimal-peer test on this path (one compact test).
5. Focus: focusProvedLocation (index.ts ~11930) and its callers (~11973, ~12005, ~12020, ~12542): replace the observed-row predicates with provedOnPane and then client.focus({request_id, pane_id: record.paneId}). Delete observedSessionAsHerdr / herdrSessionId / herdrSessionsMatch (~2604-2680).
6. Runtime.herdrAgent (index.ts ~811) and the herdrAgentAlias sites (~4034, ~4125, ~4355, ~5992, ~6006, ~6074, ~9122, ~14049): delete. Not persisted (ruled); on read ignore.
7. Move the live helpers out of herdr.ts into named modules: sessionIdentity, readPiSessionHeaderId, matchesExpectedSession (session identity module); resolveChildCommand, CHILD_COMMAND_ENV (child command module); sameCwd (path helper); STARTUP_TIMEOUT_MAX and the ExpectedSession / HerdrStartPlacement types go with their consumers. The 17 consumer-less exports are deleted, not moved.
8. Delete herdr.ts. Remove the managed-presence observe fallback (dead under tmux; observeRadarChild is the bound-identity path). Remove HERDR_* reads (radar-execution.ts 5, support-radar.ts 4, presentation.ts 3 status labels, supervision.ts 2, radar-client.ts 1 comment).
9. Then the single fixture/test pass (presentation.test.ts still uses `process`; the ~470 failing names; fake pane names minted as canonical handles), per-file before/after counts recorded here, then image build and container smoke, real-child acceptance (provider stub), npm run check with the exit captured, tsc accepted count, package audit, binary SHA, the 'herdr' mention list, keep-the-why entries.

Keep-the-why entries owed (not yet landed): bundle-versus-host for Radar and tmux in the image; Radar pin by commit only (binary has no --version); pi-codemode 1.1.0 override with the MCP_TYPESCRIPT_PREAMBLE failure; activity gate on the published Radar fact (replaces the Herdr working state).

## Pass 5 (worker takeover): steps 1-5 done in production code; 6-8 NOT done

Done (files: pi-herdsman/extension/{index.ts, supervision.ts, radar-inspection.ts}):
- Step 1, lead inspect via Radar: peek and the inspect action call `inspectLeadRecord(lead)` (index.ts, beside captureManagedInspection), which calls `inspectRadarChild` with the lead's persisted `agentId`, `paneId` and session. The inspect result key is `foreground` (was `process`); the stale-diagnostic key is `foreground` too. Herdr predicates removed.
- Step 2, coordination-record identity: CoordinatorState (supervision.ts) gained optional `agentId`, `workspaceId`, `tabId`, `paneId`, validated by validLeadState. index.ts: `leadRadarRecord` is a session-scoped cache filled by publishPeerPresence (after radarLeadIdentity) and written by persistLeadCoordination. Records without `agentId` are unprovable and refused.
- Step 3, staff list: `provedLeads()` (index.ts, module level) enumerates `listLeadCoordinationStates` (supervision.ts, new; shares `leadStateFromText` with the single-record reader) and keeps only records whose `agentId` passes `provedRead` (verified verdict, location pane === record.paneId, contextSession === record.piSessionId). The projection (refreshSupervisionOnce) and `managedAgentSnapshots.leadSessionIds` use it. Observed rows are no longer an input. `SupervisedLead.agentId` carries the identity. Lead runtime state = the proof read's fresh activity (idle/working/blocked/done) else unknown. The observed diagnostic ("live Pi agents present but unresolvable") is removed with its input.
- Step 4, Chief: `remoteChiefAgent(descriptor)` = provedRead on descriptor.agentId/paneId/piSessionId. `liveLead(ctx, sessionId)` = proved lead records for that session, minus managed-agent sessions. `liveAgent` deleted. Callers updated (authorizeChiefRecord, focusExistingChief, the descriptor check).
- Step 5, focus: `focusProvedLocation({subject, hint, agentId, paneId, session})` proves via provedRead, then `radar.focus({pane_id})`; refusal notice kept for an unproved target. focusSupervisedLead and focusExistingChief use the persisted identity. The Running-view focus resolves the managed child's `agent_id` from `presence.evidence` (kind radar) and refuses otherwise.
- Removed as dead under tmux (observed-row consumers): the parentless branch of the managed-request refusal, `controlPaneIdentity`, the `liveAgents` snapshot field, and the resume conflict scan now reads proved leads instead of `liveAgents`.

NOT done (exact next steps, in order):
- Step 6: `Runtime.herdrAgent` (index.ts ~816) and every `herdrAgentAlias` site (index.ts ~4060, ~4151, ~4381, ~6018, ~6032, ~6100, ~9097-9108, ~13891) and `herdrAliasMatchesIfReported` (~2719). Blocked on step 7: `managedAgentPresence` (index.ts ~4359) and its observed-row helpers `canonicalAgentProves`, `canonicalAgentRelated`, `canonicalSessionMatches` (also used at ~2988 in the launch cross-check). Decision recorded for the next worker: when radar is undefined, managedAgentPresence must return `unknown` (never `lost`), because a child with no observation is not gone. Callers: canonicalPresence (~2797, passes undefined radar) and managedAgentSnapshots (~3499).
- Step 7: move live helpers out of herdr.ts (sessionIdentity, readPiSessionHeaderId, matchesExpectedSession -> session identity module; resolveChildCommand, CHILD_COMMAND_ENV -> child command module; sameCwd -> path helper; STARTUP_TIMEOUT_MAX and the ExpectedSession/HerdrStartPlacement types with their consumers). Delete the 17 consumer-less exports. Then delete herdr.ts. Remaining index.ts users of herdr.ts after step 5: herdrAgentAlias, herdrSessionId/herdrSessionsMatch/observedSessionAsHerdr (~2657-2700, still used by launch and resume paths, check first), runHerdr (~10663 earlier; grep again), expectedSession, sessionIdentity.
- Step 8: HERDR_* reads (radar-execution.ts 5, presentation.ts 3 status labels, supervision.ts 2, radar-client.ts 1 comment), Herdr socket/inbox paths, Herdr CLI calls, herdr smoke tooling and Herdr instructions in docs. Chief inbox: confirm its transport first (not checked this pass).
- Not fixed in this pass: canonicalPresence is still observed-row based and used for close, continue and launch checks; a Radar-only replacement is needed. Lead transcript action needs piSessionFile, which the coordination record does not carry (regression, follow-up: persist it or accept the loss).

Tests not yet written for the new behaviour: unprovable record refused; staff entry proved by agent.get and unavailable treated as unknown; Chief proof; focus proof. Tests broken by this pass were not repaired (test pass is the next slice).

tsc (ad-hoc, /tmp/mgr-rm/tsc-check.sh): 653 `error TS` lines across the whole run after steps 1-5 (the earlier count was 654 before this pass); this count still includes pre-existing non-Herdr errors. Not comparable to the 657 extension/*.ts baseline; recount with extension/*.ts only at the next checkpoint.

Pass 5 checks (after the edits above):
- New focused test: pi-herdsman/extension/radar-inspection.test.ts (1 test: a registration is proved only when verified, on its pane, publishing its session; absent, mismatched pane, other session, no session and unavailable are refused). Result: 1 pass, 0 fail, exit 0 (module-mock loader flags).
- Loader: `import('./extension/index.ts')` under the module-mock loader: LOAD_OK.
- tsc (/tmp/mgr-rm/tsc-check.sh, whole run): 651 `error TS` lines. No error names the identifiers this pass introduced (provedLeads, provedRead, leadRadarRecord, inspectLeadRecord, liveLead, remoteChiefAgent, focusProvedLocation, listLeadCoordinationStates). Remaining production errors are pre-existing (AgentControlState at index.ts ~5963, status rows at presentation.ts ~496).
- Test files this pass breaks (not repaired, test slice): presentation.test.ts (`process` field at ~596/618, supervision snapshot shape at ~139/186), supervision.test.ts ~724 (projectSupervision input contract); extension-contract, commands, recovery and controller tests depend on the observed-row lead path and the Herdr fixture and will fail until the fixture pass.
- Not run: npm run check, package audit, image, smoke, acceptance.

Next worker: start at Step 6 (see "NOT done" above). The first unblocker is managedAgentPresence/canonicalPresence (index.ts ~2797, ~4359): replace the observed-row fallback with `unknown` when no Radar observation exists, then delete canonicalAgentProves/canonicalAgentRelated, then the herdrAgent alias sites.

## Pass 6 (steps 6-8): investigation, NO production edits landed; stopped with exact map

Stop reason: the remaining step 6-7 change touches four presence callers and the Running/resume views, and the context budget for this slice was exhausted before the presence rewrite could be made and tested safely. Nothing in this pass was left half-edited.

Verified facts (measured this pass):
- Chief inbox does NOT ride the Herdr socket. supervision.ts `socketPath()` = radarControlSocketPath(...), and `supervisionRuntime()` keeps its inbox/descriptor/lock under herdsmanDataRoot()/runtime/supervision-v2/<hash>/ (Herdsman's own runtime store). So no owner decision is needed for the inbox. Stale wording to fix: supervision.ts:927 "HERDR_SOCKET_PATH is required" -> rename.
- `sessionIdentity` (herdr.ts:1995) accepts only `source === "herdr:pi"` and `agent === "pi"`. Session matching is therefore Herdr-shaped; the Radar replacement is the session UUID from agent.get context (ruling 2). Its callers: index.ts 2656 (isPiAgent), 3518 (managed snapshot), 2662/2664 (herdrSessionsMatch/herdrSessionId), 9686 (matchesExpectedSession on an observed agent_session in the Radar spawn path).
- `readPiSessionHeaderId`, `matchesExpectedSession`, `sameObservedSessionPath` (herdr.ts 1995-2110) depend only on node fs and each other (no runHerdr). They move to a session-identity module (name: pi-session-identity.ts), with sessionIdentity's source check replaced by the agent.get context check.
- `resolveChildCommand`/`executableCommand` (herdr.ts ~1714) and `CHILD_COMMAND_ENV` (herdr.ts 1623) move to a child-command module. `sameCwd` (herdr.ts 487) and `canonicalCwd` move to a path helper. `STARTUP_TIMEOUT_MAX` (herdr.ts 90) is only used by managedAgentPresence's observed-row branch (index.ts 4436), so it goes with that branch.
- `ExpectedSession` (herdr.ts 45) moves with the session module. `HerdrStartPlacement` (herdr.ts 656) is used by launch placement at index.ts 1846 and 7123; it needs a check of whether the Radar spawn path still constructs it before deciding to delete or keep it.
- `inspectHerdrAgent`, `listAllHerdrAgents` and `runHerdr` are imported by index.ts but no longer called (only the import line remains at 234-242). Delete the import and, for `runHerdr`, check the remaining callers via grep before removing it with herdr.ts.

Presence callers (step 6/7, all must change together, which is why this was not done in this pass):
- index.ts 2789 canonicalPresence (requireLivePresence at 3171, validateChild path for non-Radar children): observed rows only. Target: no radar observation => {kind:"unknown"} => target_ambiguous refusal.
- index.ts 3461 radarFleetInventory, used also by 5199 (managed close/continue path), 6719 (managed snapshot/status path), 11562 and 11626 (not yet read; check whether they are presence or observation of other facts).
- index.ts 3479-3499 managedAgentSnapshots(suppliedInventory): builds `agents` from `managedAgentPresence(state, inventory, radar, available)`; its lost/unknown/related output drives the Running view and resume.
- index.ts 4359 managedAgentPresence: delete the inventory branch (canonicalAgentProves 4314, canonicalAgentRelated 4328, canonicalSessionMatches 4350, unclaimedAliasDiagnostic, the STARTUP_TIMEOUT_MAX lost branch). Radar undefined => unknown. Radar gone => lost. Radar live => live.
- index.ts 2988 (validateIdentity-style observed session check on a live row) goes with the observed row.

Herdr-alias sites to delete with the presence change (herdrAgent runtime field, ruled not persisted; ignore on read): index.ts 816 (type), 4060, 4151, 4381, 6018, 6032, 6100, 9097-9108, 13891, and herdrAliasMatchesIfReported 2719.

Step 8 items still open (not started): 
- supervision.ts:927 "HERDR_SOCKET_PATH is required" wording.
- radar-execution.ts 5 Herdr mentions (not read this pass).
- radar-client.ts 1 (comment), radar-inspection.ts 1 (comment, check wording).
- presentation.ts 3 (Herdr status labels): footer-status behaviour is EXCLUDED from this slice; leave and report.
- support.ts 80 and support-radar.ts 4: fixture, next slice.

Measured this pass: tsc on extension/*.ts with /tmp/mgr-rm/tsc-check.sh (TS 5.9.3, --skipLibCheck, exit 2 expected with errors): 651 `error TS` lines. This is NOT the same tree as the 657 baseline (that was taken after the Pi 1.1.0 alignment and before passes 3-5 removed observed-row code and the fixture changes). Report it as 651 current against 657 historical, not as a regression or improvement.

Not run this pass: npm run check, focused test additions (none, since no new behaviour landed), index.ts load (unchanged since pass 5: LOAD_OK).

Tests known broken (for the next slice, unchanged from pass 5): presentation.test.ts (`process` ~596/618; snapshot shape ~139/186), supervision.test.ts ~724, extension-contract/commands/recovery/controller tests on the observed-row lead path and the Herdr fixture.

Exact next step (start here):
1. Presence: rewrite managedAgentPresence to take only the radar observation (unknown when undefined), delete canonicalAgentProves/Related/canonicalSessionMatches and the inventory branch, and make canonicalPresence return unknown for a mailbox without a radar child. Then read 5199, 6719, 11562, 11626 and update each caller. Add the focused presence test (bound child verified / absent / unavailable) at the observeRadarChild + managedAgentPresence seam.
2. Delete the herdrAgent alias sites and herdrAliasMatchesIfReported.
3. Move the helpers listed above to the three named modules; replace sessionIdentity's herdr:pi source check with agent.get context session; delete the 17 consumer-less exports; delete herdr.ts; delete the herdr imports.
4. Step 8 non-fixture items; then grep "herdr" (case-insensitive) in non-test extension .ts and list the justified remainder.

## Pass 7 (worker, presence on Radar bound identity): done, bounded

Changed (pi-herdsman/extension):
- index.ts `managedAgentPresence(radar?)` now takes only the child's Radar observation. Undefined (no observation this session) returns unknown; gone returns lost; live returns the radar kind. The observed-row branch (inventory matching, alias diagnostics, the startup-window lost rule) is deleted. Its parameters `state`, `inventory`, `available` are removed.
- index.ts deleted: `canonicalPresence`, `canonicalAgentProves`, `canonicalAgentRelated`, `unclaimedAliasDiagnostic`, and the `STARTUP_TIMEOUT_MAX` import. Kept: `canonicalSessionMatches` (used by `validateIdentity`), `radarFleetInventory`, `PresenceInventory` (the availability gates below).
- Legacy (no spawn record) refusal at the close/continue path now calls `requireLivePresence(managedAgentPresence())`, so it still fails with target_ambiguous.
- `managedAgentSnapshots` no longer takes `suppliedInventory` and no longer reads observe for presence. Callers updated: close/result-cleanup (~5199), managed close (~6719), refreshSupervisionOnce, directReports, and four `undefined, false` pairs.
- Kept observe (availability gate, not presence): the supervision publication in the `directReports`/refresh path still calls `radarFleetInventory()` and throws when unavailable, so an unreadable daemon does not publish an empty fleet as fresh.
- index.ts: `managedAgentPresence` is exported (precedent: agent-runtime.test.ts imports sessionContextRetired from ./index.ts).

Test (extension/radar-launch.test.ts, one compact test "managed presence takes only the bound child's Radar verdict"):
- absent verdict → lost (processGone absent); unavailable verdict → unknown; no observation → unknown.
- Result: the new test passes (1/1). The file: 23 pass, 1 fail. The failure is the pre-existing "a live child is proved by the daemon's current read of its own edge" (`registered on no pane`).

NOT verified by this slice: the bound child verified → live case. The fake child registers without a location (the fake spawn pane is the Herdr-era name `startup-pane`, and the child-side env carries no TMUX_PANE), so observeRadarChild returns unknown. This is a fixture defect (the canonical-handle fixture pass), not a Radar defect. The live assertion was removed from the new test rather than made to pass by a fixture hack.

Checks:
- tsc (extension/*.ts, /tmp/mgr-rm/tsc-check.sh): 651, the same error set as before this pass (diffed by message).
- index.ts loads under the module-mock loader (the new test imports it).

Dead consumers left for the next slice (the type union is intentionally unchanged to keep this slice bounded):
- ManagedAgentPresence `kind: "live"` (with `agent: any`) and `aliasUnclaimed` are never produced now. About 20 consumers still test them (requireLivePresence ~2805, managedAgentSnapshots ~3505/3532/3557/3584/3610/3695, close paths ~5231/5260, managed inspect ~6057/6067, ~6759, ~8450, ~9337, ~13937 validateIdentity with match.presence.agent). Remove the variant and its checks together.
- validateIdentity's `agent` branch (canonicalSessionMatches) is fed only by the dead live variant.
- The Herdr alias sites and herdr.ts imports (steps 6-7 of the earlier map) are unchanged.

Behaviour change to report: a Radar-launched child from an earlier session (no spawn entry this session) is now unknown, not lost, and close refuses until its spawn record is read. Under tmux the old observed-row branch could never prove it live either, so this removes the unsafe lost verdict without restoring the ability to close it.

Radar contract candidates (for the Radar peer, verify before forwarding):
- Under the tmux backend at pin f87348032a80, mux.observe does not present registered agents (`agents: []` after a successful agent.register with session and process claim; probe in the Finding section above). Memory #5070 describes the registry merge in a different tree. Need the pinned docs/mux.md statement on observe.agents before calling it a contract defect.

## Pass 8: Radar-only presence through live consumers; verified child proved live (done, measured)

- index.ts: `kind: "live"` (ManagedAgentPresence) and `aliasUnclaimed` removed with every consumer. `requireLivePresence`, `hasVerifiedPresence`, the Running view, close/cascade/restart/resume/extend/Chief paths now test `kind === "radar"` only. `canonicalSessionMatches`, `relatedAgents`, and the agent-row branches of `managedAgentSnapshots` and `validateIdentity` are deleted; `unprovablePresenceMessage` is replaced by the constant `UNPROVABLE_PRESENCE_MESSAGE`. The legacy "not launched through Radar" close branch is deleted (unreachable: no live presence exists).
- radar-launch.ts: the child's acknowledged pane is the raw `TMUX_PANE` (the child writes it), so readiness compares `radarPaneHandle(bound.pane_id)`; the claimed-pane message uses the same handle.
- support-radar.ts (fixture boundary): spawn panes are canonical `tmux:herdsman-fixture:%N`; the child env carries the raw `TMUX_PANE`; the subject registers the location of its spawn pane; the edge location is `{backend, instance, pane}` (no more `herdr`/`workspace`). Retained-child adoption sets `TMUX_PANE` to its declared pane.
- radar-launch.test.ts: the "managed presence takes only the bound child's Radar verdict" test now includes the bound, verified child → `radar` case. `startup-pane` literals replaced by `FIXTURE_CHILD_PANE` (`tmux:herdsman-fixture:%2`) and `%2`.

Measured (module-mock loader, `--test-timeout=20000`, per file; pre = before pass 8 changes, post = final):
- radar-launch: pre 23/1 → post 24/0 (exit 0)
- control-integration: pre 2/12 → post 2/12 (same failing set as the baseline comparison)
- controller-api: pre 19/51 → post 19/51 (same failing set)
- controller-lifecycle: 17/57 → 17/57 (measured pre and post in the comparison run)
- recovery: 18/86 → 18/86
- tsc (`/tmp/mgr-rm/tsc-check.sh`, extension/*.ts): 651 before and after, identical message set (`/tmp/mgr-rm/tsc-slice8-before.log` vs `tsc-slice8-final.log`).

Not run: `npm run check` (the tree is still red by design), package audit, image, smoke, acceptance.

Remaining removal handoff (not done in this pass):
- Herdr alias sites: `Runtime.herdrAgent` and `herdrAgentAlias` calls, `herdrAliasMatchesIfReported`.
- Session helpers: `sessionIdentity` (herdr:pi source check), `herdrSessionsMatch`/`herdrSessionId`/`observedSessionAsHerdr`, `isPiAgent`.
- Move live helpers out of herdr.ts (session identity, child command, sameCwd, STARTUP_TIMEOUT_MAX, ExpectedSession, HerdrStartPlacement) and delete herdr.ts with its 17 dead exports.
- Fixtures: the controller/recovery/control-integration failures are the legacy Herdr-era tests (memory 5069), to delete or compact-rewrite, not migrate.
- Radar contract: the observe `agents: []` candidate from pass 7 is withdrawn; Radar confirmed observe is physical inventory only at f87348032a80 and 55ff25d5. Memory 5070 is the record.

## Pass 9: alias and session-identity consumers removed; child session proved on the published context (done, measured)

- index.ts: `Runtime.herdrAgent` and all `herdrAgentAlias` sites deleted (derived names, not persisted). Deleted with no remaining caller: `expectedSession`, `isPiAgent`, `herdrSessionsMatch`, `herdrSessionId`, `observedPiSessionId`, `observedSessionAsHerdr`, `supervisedSessionFile`, `herdrAliasMatchesIfReported`. `publishRadarAssignments` lost its `agentSession` branch (no caller passed it). Dead imports removed: `listAllHerdrAgents`, `runHerdr`, `inspectHerdrAgent`, `sessionIdentity`, `readPiSessionHeaderId`, `matchesExpectedSession`, `herdrAgentAlias`, `ExpectedSession`.
- radar-client.ts: `agent.get` `contextSession` now reads the pinned nested shape `context.context.session`, and only while `context.context.freshness === "fresh"`. The previous read (`context.session`) did not match the pinned reply.
- radar-launch.ts `observeRadarChild`: a verified child on its pane is live only when the daemon's published session equals the mailbox session (`provenance.session_id`). An unrecorded session or a different one is unknown. Absent and mismatched verdicts remain gone without a session check.
- index.ts `radarChildProvenance`: `session_id` = the mailbox state's `piSessionId`. The spawn record persists no session, so the mailbox is the persisted per-run source.
- support-radar.ts: the simulated child publishes its session as its context (`contextSession`); `agent.get` answers the `context.context` shape. `RadarFakeSpawn.session_id` records it.
- Tests: radar-client.test.ts +1 (fresh/stale/null context session). radar-launch.test.ts: observe literals pass `session_id`; new test "a bound child is live only while it publishes the session its mailbox records" (matching → radar; contradicting → unknown; unrecorded → unknown).

Measured (module-mock loader, --test-timeout=20000, per file; pass 8 post-counts in brackets):
- radar-client: 48/0 (was 47/0 before this pass, +1 new test)
- radar-launch: 25/0 (was 24/0, +1 new test)
- radar-inspection: 1/0
- control-integration 2/12 [2/12]; controller-api 19/51 [19/51]; controller-lifecycle 17/57 [17/57]; recovery 18/86 [18/86]. Counts only; failing names not diffed.
- tsc (/tmp/mgr-rm/tsc-check.sh): 651 `error TS` lines, identical message set to the pre-slice save (/tmp/mgr-rm/tsc-slice9-before.log).

Remaining Herdr identifiers after this pass:
- herdr.ts (dead Herdr-era launch cluster and its helpers) is still imported by index.ts for `resolveChildCommand`, `CHILD_COMMAND_ENV`, `sameCwd`, `HerdrStartPlacement` (live). `herdrAgentAlias` is still exported for support.ts and recovery.test.ts fixture naming (legacy fixture pass). `sessionIdentity`, `matchesExpectedSession`, `readPiSessionHeaderId` are used only inside herdr.ts and herdr.test.ts now.
- index.ts user-facing wording not changed: "No exact Herdr agent identity matched" (managed lookup), "Manage Herdr agents" tool description, and HerdRun naming.

Follow-ups:
- Session freshness risk: if a child changes Pi session without rewriting its mailbox, a verified child is unknown until the mailbox is rewritten. Conservative, not unsafe; check against the session-switch path.
- Move `resolveChildCommand`/`CHILD_COMMAND_ENV`/`sameCwd`/`HerdrStartPlacement` out of herdr.ts, then delete the dead cluster and the file.

## Pass 10: surviving launch helpers extracted; herdr.ts and herdr.test.ts deleted (done, measured)

Changed (pi-herdsman/extension):
- New `child-command.ts`: `CHILD_COMMAND_ENV`, `ChildCommandLookup`, `resolveChildCommand` (verbatim from herdr.ts). Live consumers: the managed launch plan (env `PI_HERDSMAN_CHILD_COMMAND`), `childCommandIdentity` launch fingerprint, and the Radar spawn refusal.
- New `cwd.ts`: `sameCwd` (verbatim, with its private `canonicalCwd`). Live consumers: 9 sites in index.ts.
- New `child-command.test.ts` and `cwd.test.ts`: the two surviving subjects moved from herdr.test.ts unchanged.
- `index.ts`: imports repointed to the two modules; `HerdrStartPlacement` gone. The two Radar placement callers (`physicalPlacement`, `radarFreshPlacement`) read only `.paneId`, so both return `{ paneId: string }`. No union, no invented variants.
- `support.ts`: dropped the `herdrAgentAlias` re-export from herdr.ts, the `herdrAlias` helper, the alias-keyed `name`/`herdr_agent` fields, the `add()` `name` option, and the three alias match disjuncts in the legacy executors (matching is now pane-id based; `agent get` matches `[parent, ...children]` by paneId, and the snapshot lookup is plain `currentStateForPane`). No alias clone left behind.
- `recovery.test.ts`: dropped the alias import, the `observeFleet` `name` option and its three call-site `name` fields.
- `commands.test.ts` and `controller-api.test.ts`: dropped the `herdrAlias` import and 2 fields each; `controller-api.test.ts` also dropped its unused `import { STARTUP_TIMEOUT_MAX } from "./herdr.ts"`.
- Deleted `herdr.ts` (2599 lines) and `herdr.test.ts` (5271 lines, 74 top-level subjects: the Herdr launch/start/rollback cluster, reporter and worktree helpers, runHerdr/listAllHerdrAgents/listHerdrAgents, inspectHerdrAgent, the session matchers, process/shell ownership, startup diagnostics and the alias).
- Wording: "No exact managed agent identity matched" (managed lookup), "A chief is already active in this runtime.", "Manage managed agents" (tool description), the Chief charter's "across this runtime", and the misleading "only Herdr's pane identity remains unknown" comment removed. `HerdRun` / `herdRunStartedAt` naming untouched.

Measured:
- tsc (`/tmp/mgr-rm/tsc-check.sh`, extension/*.ts): 651 -> 650 `error TS`. The only removed message is one `TS2345` inside the deleted herdr.test.ts. All other per-file message counts identical (index.ts 61, support.ts 15, radar-launch.ts 8, ...). No error introduced.
- Focused suites, module-mock loader, `--test-timeout=20000`, per file, exit 0: child-command 1/0, cwd 1/0, radar-client 48/0, radar-launch 25/0, radar-inspection 1/0, radar-location 14/0.
- Legacy comparison (bounded `timeout 300` per file), pre -> post: idle-wake 6/0 -> 6/0, observation-refresh 0/4 -> 0/4, agent-cutover 5/1 -> 5/1, agent-runtime 67/23 -> 67/23, extension-contract 21/20 -> 21/20, control-integration 2/12 -> 2/12. No movement from this slice.
- Also compared, identical to the pass-9 baseline: controller-api 19/51 -> 19/51, controller-lifecycle 17/57 -> 17/57, recovery 18/86 -> 18/86.
- All nine legacy files compared; none moved.
- `commands.test.ts` is not usable for a count comparison: a `waitFor` poller (commands.test.ts:5752) held the loop open for 62 minutes before the file-level failure, with no per-test timeout firing. The two removed alias fields live in one subject ("Running keeps colliding display labels distinct and focuses the selected pane"), which was not re-measured.
- Not run: `npm run check`, package audit, image, smoke, acceptance.

Session-switch trace (conclusion: no gap, and no bypass):
- The only writer of a child's mailbox `piSessionId` is `envManagedAgent` (index.ts:2908), which reads the live session at session start.
- Managed children cancel native replacement: `session_before_switch` and `session_before_fork` return `{ cancel: true }` (index.ts:15907-15908), pinned by agent-runtime.test.ts "managed agents cancel native session replacement".
- A session start whose live session differs from a populated mailbox THROWS "agent session identity changed while state existed" (index.ts:15941 and 16010) rather than rewriting `piSessionId`. So a changed session refuses; it is never silently accepted.
- `session_info_changed` (index.ts:16609) is an empty handler.
- Recorded gap, no authority change made here: an out-of-band session change leaves the mailbox holding the old id and the child refusing to start, so presence reads unknown (conservative). This slice changed no comparison or refusal rule.

Remaining Herdr dependencies (report only, not this slice):
- `pi-herdsman/AGENTS.md:58` still documents `extension/herdr.ts` in its file map.
- `scripts/container-smoke.sh:47` reads `piHerdsman.runtime.herdr.version` from package.json (packaging).
- `supervision.ts:927` still throws "HERDR_SOCKET_PATH is required" (wording).
- `supervision.ts:1703` `normalizeHerdrLifecycleState` name, imported by index.ts:267.
- `radar-execution.ts:273` still listens on the `herdr:blocked` event name; radar-execution.ts has 5 Herdr mentions.
- `support-radar.ts:862-863` still reads `HERDR_WORKSPACE_ID`/`HERDR_TAB_ID`; `support.ts` still carries the HERDR_* fixture env and the legacy fake Herdr CLI executors (its remaining ~60 mentions are that fixture).
- `presentation.ts` 3 mentions are the HerdRun entry naming (excluded).

Next removal seam: the HERDR_* environment reads and the legacy fake Herdr CLI executors in support.ts/support-radar.ts, then the fixture/test pass over the red legacy suites (memory 5069: delete or compact-rewrite, do not migrate), then `npm run check`, image, smoke and real-child acceptance.

## Pass 11: Herdr runtime environment and fake-CLI fixtures removed (done, measured)

Scope: runtime environment reads, lifecycle vocabulary, the fake Herdr CLI executor cluster in the shared
fixtures, and the focused tests this boundary affects. Packaging, docs and whole-suite triage excluded.

Production:
- `supervision.ts`: `supervisionRuntime`'s guard no longer names a Herdr env var ("A Radar control socket
  path is required"). The guard stays: it is a parameter precondition, not an unreachable branch.
- `supervision.ts`: `normalizeHerdrLifecycleState` deleted. It read the Herdr observe-row field
  `agent_status`, and its only callers were `index.ts`'s import line and one supervision test: no production
  caller existed. `RuntimeState` and its other consumers are untouched.
- `radar-execution.ts`: the `herdr:blocked` listener and the `blockers` stack it fed are deleted. Producer
  audit: the only emitter anywhere in the repo was `radar-execution.test.ts` itself; no installed extension
  emits it, so the channel had no producer. The permission bridge (`permissions:ui_prompt`/`permissions:decision`)
  and the questionnaire bridge (`rpiv:ask-user:blocked`, produced by `question-waiting.ts` and wired at
  `index.ts:1099`) are preserved, including the shared `dialogLabel` bound they use. Reason resolution is now
  `questionnaire ?? (permissionPrompts.size > 0 ? "permission" : undefined)`.

Shared fixtures (support.ts 3311 -> 1575 lines, support-radar.ts):
- No HERDR_* runtime read or write remains. `setLeadEnvironment`/`setAgentEnvironment` still *clear*
  HERDR_PANE_ID/HERDR_TAB_ID/HERDR_SOCKET_PATH (that list is what keeps a Herdr environment from being
  inherited at all), but write none. `radarObservedFleet` takes its own pane from `TMUX_PANE`.
- `support-radar.ts`: the fake daemon reports `FIXTURE_WORKSPACE` instead of reading HERDR_WORKSPACE_ID/TAB_ID.
- Observed rows no longer carry the removed `kind: "reported", source: "herdr:pi"` session vocabulary; the
  uuid kind remains. `adoptRetainedChild` derives the child's raw `TMUX_PANE` from the recorded pane handle,
  as `spawn.create` already did for a fresh launch, so both paths register the same way.
- `fakePi` no longer answers Herdr CLI calls: the `herdr status --json` branch, its `status` option, and the
  Herdr-shaped defaults for `herdr agent list`/`herdr api snapshot` are gone. The generic default result is
  `{}`, as for any other command.
- Deleted fake Herdr CLI executors and their CLI-only helpers: `leadExec`, `agentFromState`,
  `agentControllerExecutor`, `delegatedLifecycleExecutor`, `cascadeExecutor`, `createStagedAssignmentFixture`,
  `writeMetadataTask`, `startupExecutor`, `assertRestrictiveManagedDefinition`, `HERDR_STATUS_RESPONSE`/
  `herdrStatusResult`, and the argument predicates `isAgentList`, `isApiSnapshot`, `isTabList`, `isPaneList`,
  `isTabClose`, `isPaneClose`, `isPreservePaneStop`, `isHerdrList`. Also removed as dead (zero consumers):
  `fleetFromRows`, `writeRequestRaw`, `writeAgentStateRaw`.

Focused tests:
- The 8 legacy suites that imported the deleted executors had only those specifiers pruned from their
  support.ts import list (agent-cutover, agent-runtime, commands, controller-api, controller-lifecycle,
  extension-contract, observation-refresh, recovery). No assertion was rewritten to accommodate a deletion.
- `radar-execution.test.ts`: "a nested dialog is the blocking reason until it is cleared" and "a questionnaire
  is one wait, not one wait per signal" deleted (subject = the removed dialog channel and its dedup against
  the questionnaire flag, which a single flag now makes structural); "a dialog label is bounded..." rewritten
  as "a blocking label is bounded and cannot blank the record" on the surviving questionnaire boundary.
- `supervision.test.ts`: the `normalizeHerdrLifecycleState` case deleted with its import.

Measured (module-mock loader, `--test-timeout=20000`, per file, bounded 300 s/file; pre = pass-10 post logs in
`/tmp/mgr-rm/s10/post2`, post = `/tmp/mgr-rm/s11/post2`):

| file | pre pass/fail | post pass/fail | fixed | new |
|---|---|---|---|---|
| idle-wake | 6/0 | 6/0 | 0 | 0 |
| observation-refresh | 0/4 | 0/4 | 0 | 0 |
| agent-cutover | 5/1 | 5/1 | 0 | 0 |
| agent-runtime | 67/23 | 66/24 | 0 | 1 |
| extension-contract | 21/20 | 30/11 | 10 | 1 |
| control-integration | 2/12 | 12/2 | 10 | 0 |
| controller-api | 19/51 | 23/48 | 6 | 2 |
| controller-lifecycle | 17/57 | 8/67 | 2 | 11 |
| recovery | 18/86 | 32/72 | 25 | 11 |
| supervision | 49/0 | 48/0 | one case deleted by design | 0 |
| supervision-malformed-cleanup | (no baseline) | 0/1 | - | - |
| worker-addressing | (no baseline) | 3/0 | - | - |

Focused suites: radar-launch 25/0, radar-client 48/0, radar-inspection 1/0, radar-location 14/0,
radar-execution 14/0 (16 before: two subjects deleted), child-command 1/0, cwd 1/0.

Failure attribution for the 26 new failures (name-level diff against the pass-10 logs):
- 25 are `ReferenceError: <deleted fixture> is not defined` in test bodies that still call the removed
  executors — one family, the triage slice's delete-or-rewrite list.
- 1 is a cascade, not a behaviour change: controller-api "list projects an unreadable current mailbox as
  non-actionable unknown" fails only in file order (passes in isolation) because the sibling test at
  controller-api.test.ts:1314 now aborts at `agentControllerExecutor is not defined` (line 1346) immediately
  after writing `{malformed` into a mailbox in `unrelated-workspace` (line 1339). That state is not
  enumerable, so `clearTestMailboxes` cannot remove it and the later `list` projects it as a second unknown
  agent (diagnostic: `SyntaxError: Expected property name`). Fix belongs to the triage rewrite of that sibling
  test, not to production.
- 53 tests are FIXED, most in control-integration/controller-api/recovery/extension-contract. Cause is
  bounded to the fixture boundary: the shared harness no longer answers Herdr CLI calls and the observed fleet
  no longer invents agent rows, so suites that asserted the absence of unrelated live agents now agree.

Types (same command, `/tmp/mgr-rm/tsc-check.sh`, extension/*.ts): 650 -> 866 messages. Every added message is
`TS2304 Cannot find name '<deleted fixture>'` in those 8 legacy test files (42 distinct file+symbol pairs, 216
occurrences); no runtime module gained an error, and no message type other than TS2304 was added. Two
pre-existing messages inside the deleted code disappeared.

Deliberate remnants with a reason:
- `listResponse` (support.ts) still builds the Herdr-era row shape (`agent_status`, `agent_session.source
  = "herdr:pi"`) and is consumed only by commands/controller-lifecycle/recovery. It is inert data for
  production (index.ts discards `agent_session` on read); rewriting its 35+ call sites is the legacy suites'
  triage, not this boundary.
- Test files still write HERDR_* env themselves (commands, controller-api, controller-lifecycle,
  extension-contract, recovery, supervision, observation-refresh, agent-runtime, control-integration). Those
  are the legacy suites' own fixtures; the runtime reads none of them.
- `rpiv:ask-user:blocked` and the permission events are approved bridges, kept.

Not run: `npm run check`, package audit, image, smoke, real-child acceptance.

Next seam for the triage owner: delete or compact-rewrite the tests that call the removed executors (25 newly
failing plus the retained ones), then the controller-api:1314 sibling so the order-dependent cascade goes, then
`npm run check`, image, smoke and real-child acceptance.


## Pass 12: mixed pane namespace fixed in production; controller-api repaired against Radar-only production (done, measured)

Assignment: repair `extension/controller-api.test.ts` against Radar-only production (the pass-11 triage handoff),
with the owner's authorization to fix production if a defect was proved. Both happened.

### The defect (Herdsman production, not Radar and not fixture fallout)

`Runtime.paneId` carried the daemon's qualified handle (`launch.pane_id`, `tmux:<server>:%N`) while the child's
own mailbox and startup acknowledgment carry the raw `TMUX_PANE` (`%N`). The launch join therefore compared a raw
value with a qualified one and could never agree: `validateIdentity` (index.ts:2858, called from index.ts:8741
with `pane_id: launch.pane_id`) refused every launch with
`Agent identity does not match managed state: paneId="%3" != "tmux:herdsman-fixture:%3"`. `radarChildProvenance`
held the same confusion the other way round: it compared the record's qualified handle with the mailbox's raw
pane and returned `pane_id: undefined`, which left every launch proof "without a pane this launch recorded for
it". Both were reachable in production, and earlier focused launch-helper passes did not cover this controller
join. The child-side convention is the faithful one: Radar's tmux backend formats handles as `tmux:<server>:%N`
(agent-radar src/tmux.rs:1183), Radar sets no `TMUX_PANE`, so tmux hands the child the raw `%N` (the fixture
already agreed: raw child env, raw mailbox pane).

### The fix (owner ruling: two namespaces, never reconstructed)

- `Runtime.radarSpawnPane` is the bound record's qualified handle, set where the record is read: the launch
  construction (`paneId: radarPaneHandle(launch.pane_id)`, `radarSpawnPane: launch.pane_id`), the reuse path, and
  the reload path (`radarSpawnFromEntries`). It is never rebuilt from the local environment.
- `Runtime.paneId` is the child's raw local pane and stays the mailbox/ack/claim namespace: acknowledgment
  (`ack.paneId`), mailbox state comparisons, lock ids, projection rows, and Pi-facing tool results.
- Canonical comparisons use the record handle: the `agent` branch of `validateIdentity` (holding a daemon row to
  `runtime.radarSpawnPane`) and `captureManagedInspection` (which now also refuses when no bound record exists).
- `radarChildProvenance` compares the mailbox's raw claim with the recorded handle's raw form and still returns
  the qualified handle, so the canonical proof downstream keeps the server in it.
- No fallback: a runtime whose bound record is missing or names no pane keeps `radarSpawnPane` undefined and a
  canonical comparison refuses. `runtimeIdentityMatches` was left comparing the raw projection row, which is the
  same namespace (an early attempt to move it to the qualified handle was wrong and was reverted).

### Regression evidence

- `extension/radar-launch.test.ts` gained one compact negative check: a recorded handle on another server with
  the same `%N` is not this launch's child. It passes, and it fails when the edge-location comparison is mutated
  to compare raw suffixes, so the check holds the server in the proof. Suite: 25/0 -> 26/0.
- The 11 controller-api relaunch/continuation/close subjects that refused at the launch join now pass
  (definition drift, changed child command, cleared child command, missing launch entry, proved-gone child,
  refused close, resume over an unacknowledged launch, session continuation x2, relaunch close reservation).

### controller-api stimulus repairs (classification rule, no new helper/executor family)

- 12 `startupExecutor` sites removed: the deleted Herdr-CLI child emulation is replaced by the real Radar seam
  (delegate launches through the fixture daemon), the child's mailbox is `agentMailboxPath(WORKSPACE, label)`,
  and there is no fixture consumer to stop.
- The parent-controller family (readiness, allowlists, same-cwd project children, foreign-workspace recovery,
  the malformed-mailbox sibling) failed because the mailbox they wrote used the fixture's free-string pane
  ("registered-pane") while the process's own environment declares `TMUX_PANE`; `sameManagedAgentIdentity`
  therefore refused and the controller never armed. Their written state now carries the process's own raw pane,
  and the deleted executors are gone.
- Two assertions were rewritten onto their still-true subject: the unrelated workspace's record is never listed
  or shown (it is no longer claimed that a written, unlaunched child has no diagnostic - it is honestly unknown),
  and the readiness test's second phase now asserts that no Radar launch happened instead of reading the deleted
  executor's call log.
- The malformed-mailbox cascade (pass 11) is closed: setup lives inside the try and the finally guards its
  optional fixture.

### Measured

- `controller-api.test.ts`: 71 tests, 23 pass / 48 fail -> 49 pass / 22 fail. 26 fixed, 0 new.
- `radar-launch.test.ts` 26/0, `radar-client.test.ts` 48/0, `radar-inspection.test.ts` 1/0.
- Type check (same command, `/tmp/mgr-rm/tsc-check.sh`, extension/*.ts): 866 -> 847 messages, zero new
  file+message pairs, `index.ts` 61 -> 61 and `radar-launch.ts` 8 -> 8, so the production fix added no type error.

### Remaining 22 failures, by cause (for the triage slice)

6 `leadExec` and 2 `agentControllerExecutor`/`agentFromState` subjects emulate daemon listings the deleted
fixture produced (registered-lead controls, Chief/lead steering of a blocked parent, question-wait projection);
3 `startupExecutor` callback sites need their child-text/argv capture moved to `onChildRequest`/`spawnedArgvs`;
2 "no active supervisor", 1 Chief supervision projection, 1 `waitFor` timeout, and 1 write-failure subject are
unrelated mechanisms; 2 assertion mismatches (direct-child controls, historical re-parenting) need their
children to be Radar-launched or adopted rather than written mailboxes; 1 close-outcome subject names a request
address refusal.

Not run: `npm run check`, package audit, image, smoke, real-child acceptance.


## Pass 13: shared managed-pane default corrected; controller-api 49/22 -> 54/17 (slice continues)

### Shared fixture truth (the owner-ruled correction)

`managedState`'s default identity came from `defaultFixtureIdentity`, whose `paneId` is the free string
"registered-pane". A managed process's own mailbox records the raw pane its environment declares, so any test
that wrote its own state through the default then started a session as that agent failed
`sameManagedAgentIdentity` (mailbox "registered-pane" vs `TMUX_PANE`) and its controller never armed.

`support.ts` now has `ownManagedIdentity()`: the configured fixture identity with the pane taken from
`process.env.TMUX_PANE ?? FIXTURE_LEAD_PANE`, read at construction (the environment is set per test, so there is
no import-time capture), and `managedState` defaults to it. `defaultFixtureIdentity` and `listResponse` keep the
explicit identity: they describe a daemon listing row, not this process's own claim. Historical and durable
mailboxes keep their explicit `recoveryIdentity` panes. The six per-site `{ ...state, paneId: process.env.TMUX_PANE! }`
workarounds added in pass 12 are removed as redundant.

Affected-suite comparison (read/run evidence only; no out-of-scope edits; before = the pass-11 post2 logs):
agent-runtime 11 names fixed, 0 new (49 -> 27 failing lines); recovery 4 fixed, 0 new (145 -> 141);
controller-lifecycle identical (135/135); extension-contract identical (23/23). No suite gained a failure.
`commands.test.ts` was not run (its pre-existing 62-minute `waitFor` hang).

### controller-api

- Fixed by the shared default: "acknowledgement state-write failures retain requests for durable retry" and
  "Chief preflight defers inbox delivery until agent_start".
- Fixed by stimulus translation (executors removed): "semantic result refs attach persisted output and preserve
  canonical file refs" (the child's received text now comes from the fixture's `onChildRequest`; the mailbox is
  `agentMailboxPath(WORKSPACE, label)`), "trusted same-cwd project assignment launches with native approval"
  (both phases; the launched argv now comes from `spawnedArgvs(radarDaemon)`), "untrusted assignments omit
  project approval" (same argv signal, asserting the flag is absent), "registered agent validates duplicate
  agents and selectors before lifecycle use".
- "agent_extend defers one worker's next digest and later windows revert": the `settleRadarObserves(observed + N)`
  arithmetic barriers are replaced by the existing `drainRadarObserves()` barrier and the extend calls now run
  with the session that owns the child. The test now reaches its positive digest assertions (it previously
  failed on the barrier arithmetic); the remaining cause is the digest delivery reaching the assertion before
  the scan's continuation, which needs a deterministic effect barrier (the digest itself) rather than a read
  count.
- Measured: 71 tests, 49 pass / 22 fail -> 54 pass / 17 fail. Executor references in the file: 22 -> 16.

### Types

Same command (`/tmp/mgr-rm/tsc-check.sh`, extension/*.ts): 847 -> 840 messages, no new file+message pair,
`index.ts` 61 -> 61 and `support.ts` 11 -> 11 (no runtime error added); controller-api 117 -> 110.

### Remaining 17 and what each needs

Radar-child stimulus rewrite (children are written mailboxes that Radar-only presence can never prove, so the
lead-side control/steering subjects must be rebuilt on a Radar-launched child):
- leadExec ReferenceError, exec not yet dropped: "session continuation rejects label overrides and occupied
  inherited labels", "registered lead exposes only explicit live controls", "successful controls persist their
  definition before runtime teardown", "assignment status normalization fails closed safely".
- agentControllerExecutor ReferenceError: "agent list projects an active user-question wait as blocked without
  owner reply", "lead steers a blocked parent waiting for direct-child work".
- Assertion mismatches on written-mailbox children: "parent controls only direct children and enforces session
  allowlists", "historical continuation re-parenting preserves every valid ownership path", "transcript projects
  persisted agent evidence without Herdr terminal reads".
- Lead/Chief supervision and routing: "unassigned Lead routes supervisor messages directly to Chief",
  "legacy Lead pendingAsk state is normalized and does not block messaging" (both "No active supervisor is
  available"), "a Chief's supervision lists a Lead only when the Radar observation proves it".

Radar-shaped tests with a narrower cause:
- "a close outcome decides retirement, never permission on its own" and "a refused close is not authority..."
  (both retainedRadarWorker-based; the refusal payload and the residue field are what need reading).
- "agent_extend defers one worker's next digest..." (barrier, above).

Not run: `npm run check`, package audit, image, smoke, real-child acceptance.


## Pass 14: extend-digest effect barrier; HERDR setup removed; two blockers demonstrated

Measured now: `controller-api.test.ts` 71 tests, **55 pass / 16 fail / 0 cancelled** (pass 13: 54/17).
Executor references left: 16. `HERDR` references: 0 (was 18). Type check (same command): 840 messages,
identical to pass 13, no new file+message pair.

Fixed this pass:
- "agent_extend defers one worker's next digest and later windows revert": the observe-drain barriers are
  replaced by the file's existing deterministic effect signal - `t.mock.timers.tick(30_000)` followed by a
  bounded `setImmediate` flush loop (the idiom already used by the loss-notice subject at 2652/2655). The
  subject now asserts the digests and soft-window entries themselves, at both the deferred and the reverted
  window. Green.
- All 18 `HERDR_*` writes and clears in this file are removed: the runtime reads no `HERDR_*` variable (only
  `support.ts`'s clear-list names them, to stop a Herdr environment being inherited), so they were inert setup.

"a refused close is not authority ..." - the stimulus was wrong, not the assertion: with
`radarDaemon.exitProcess` the continue path takes the retirement branch, which sends **no** `childClose` at all
(verified: zero `pi-herdsman-radar-close` entries were written, so `radarDaemon.spawns[0].closed` stayed
undefined and the `residue` lookup had nothing to find). The residue belongs to the relaunch decision, so the
subject now uses a changed definition (`launchedModel: "explicit/old"`) with `processVerdict: "mismatched"` and
`refuseChildClose: true`, which reaches the close-before-relaunch path.

### Blocker 1 (Herdsman production): the continued assignment is addressed to the previous incarnation

Reproduced independently twice, after a close plus relaunch: the relaunch happens
(`radarDaemon.spawns.length === 2`) and the relaunched child then **refuses the continued assignment** with
`target_not_found: "Request was addressed to another Radar process incarnation"`.
- Repro A: "a close outcome decides retirement, never permission on its own", case
  `{ closeOutcome: "already_exited", processVerdict: "absent", relaunches: true }` (fails in isolation too, so
  it is not leakage between the loop's cases).
- Repro B: "a refused close is not authority ..." with a changed definition, `processVerdict: "mismatched"`,
  `refuseChildClose: true`.
The sibling subject "a relaunch proceeds only on a proved absent or mismatched process" passes because it has no
close before the relaunch.
- Seam: the address carried by the continued assignment (`assignmentAddress`, index.ts:2994, built from
  `Runtime.radarAgentId` / `radarBoundProcess` / `radarLaunchGeneration`) as resolved after the relaunch branch
  (index.ts:8438-8460). `runtimeIdentityMatches` (index.ts:5541) compares runId, owner session, workspace, pane,
  session, session file and cwd but **not** the bound process or launch generation, so a runtime carrying the
  previous spawn's address still counts as a match; and a close whose outcome is `already_exited` or `refused`
  leaves the previous spawn's edge in place. The child is right to refuse: the address names another process.
  Not fixed here: production edits are outside this slice's scope.

### Blocker 2 (fixture capability, `support-radar.ts`, outside this slice's scope)

The fake daemon registers only agents a launch produced, and publishes no activity. So a Lead or Chief record
cannot carry its **own** registered identity (only a launched child's, which is explicitly ruled out), and no
subject can publish a blocked/working status the way production reads it (`agent.get` fresh snapshot/activity).
This blocks the truth-preserving rewrite of: "unassigned Lead routes supervisor messages directly to Chief",
"legacy Lead pendingAsk state is normalized and does not block messaging", "a Chief's supervision lists a Lead
only when the Radar observation proves it", and the status dimension of "assignment status normalization fails
closed safely".

Remaining 16 unique failures: the 2 close/relaunch subjects (blocker 1), the 4 Lead/Chief subjects above
(blocker 2), and 10 lead-side control/steering/extend/continuation subjects whose children are written
mailboxes; those 10 are expressible with the existing `retainedRadarWorker` seam (a Radar-launched child plus
its mailbox state), which is the recipe already used by the passing relaunch/continuation subjects.


## Pass 15: the relaunch-address defect was a fixture lifecycle race (owner-ruled diagnostic)

Owner authorized the narrow production fix only after distinguishing a stale address selection from the
old-fixture-consumer race. The diagnostic settled it: **the request carried the NEW binding and the OLD fake
consumer wrote the refusal**. Instrumenting the fixture's refusal branch printed, for both repros, a refuser on
pane `startup-pane` (the retained child: `gone=false closed=false`) whose own `childAddress` differed from the
request's address in subject, incarnation **and** generation. Nothing stale was selected in production: the
superseded child was still consuming the label's mailbox. No production edit was made.

Fixture fix (support-radar.ts, the smallest truthful lifecycle repair): `consume` now stops as soon as a later
spawn holds the same mailbox (`env.PI_HERDSMAN_MAILBOX`, later in `spawns`), because a label's mailbox has one
occupant - production retired that process and its request is not this one's to refuse. No durable old
spawn/close evidence, reservation, identity or dispatch id was touched.

The residue subject's stimulus was also wrong, in the same way as the earlier one: production retires a `lost`
child silently (no `childClose` at all - verified: daemon `closes` empty and no radar-close entry), so a refused
close can only precede a relaunch when the close is attempted while the process is still proved present and the
absence proof follows. The subject now holds the close (`holdNextClose`), sets the verdict to `mismatched` while
it is refused, releases, and asserts the relaunched result names the residue. Both relaunch subjects keep their
addressing assertions: a continued assignment must target the newly proved bound process.

Measured (module-mock loader, `--test-timeout=20000`, per file, real exits):
- controller-api: 71 tests, **57 pass / 14 fail / 0 cancelled** (pass 14: 55/16). The two close/relaunch
  subjects are green; the remaining 14 names reconcile exactly with the ten lead-side subjects plus the four
  Lead/Chief subjects (blocker 2: fixture needs a non-child registration + activity publication, authorized,
  not yet built).
- radar-launch 26/0, radar-client 48/0, radar-inspection 1/0 - zero new failing names around the shared fixture
  change.
- Type check (same command, extension/*.ts): 840 messages, no new file+message pair.
- Not run: `npm run check`, package audit, image, smoke, real-child acceptance.


## Pass 16: fake retirement semantics made per-spawn exact; capability reconnaissance

### The consume shutdown condition (the owner's constraint applied)

The pass-15 blanket `superseded()` rule (a later spawn on the same mailbox retires the older consumer) is
replaced by `retired()`, which stops a consumer only on that spawn's own facts: `spawn.closed === true` (the
daemon's close confirmed its pane gone, or the pane vanished) or `spawn.processGone === true` (its process was
proved absent / explicitly exited). A later spawn on the same label is never a reason to stop, so a replacement
that exists - or is still waiting to bind - cannot retire a consumer that was never answered for, and a
duplicate-spawn defect cannot be masked by making an older verified process disappear.

A global `settings.processVerdict` ground was tried and rejected: measured, it stops the replacement's consumer
too, which broke the no-close relaunch control (`Timed out waiting for agent state`). The verdict is modelled per
registration, so the tests now express their absence proof on the child's own record
(`radarDaemon.exitProcess(<the spawn holding this fixture's mailbox>)`) with the global override cleared, and the
replacement answers for itself.

Stimulus changes that follow from the same reasoning:
- "a close outcome decides retirement, never permission on its own": the loop no longer sets a global verdict;
  the `absent` case marks the child's own record, and the `verified` case sets the override.
- "a refused close is not authority...": while the close is held and refused, the child's own record is marked
  absent and the override cleared before release, so the absence proof - not the refusal - authorizes the
  relaunch and the replacement answers for itself.

### Measured

- Three relaunch controls plus the refusal path: "a relaunch proceeds only on a proved absent or mismatched
  process, and a refusal consumes nothing" PASS, "a close outcome decides retirement, never permission on its
  own" PASS, "a refused close is not authority..." PASS, "agent_extend rejects extra fields and every
  windowless worker" PASS. Both close/relaunch regressions are retained with their addressing assertions.
- Whole `controller-api.test.ts`: 71 tests, **57 pass / 14 fail / 0 cancelled** - identical to pass 15, so the
  fixture refinement adds zero failing names.

### The four named subjects: capability reconnaissance (not yet built)

- Standalone registration needs no new fixture mechanism: the existing `agent.register` wire case, called
  **without** `spawn_token`, records `{location, session}` for a minted `agent_id` and binds no edge - exactly a
  standalone Lead/Chief (own registration, process identity, canonical location, session; no fabricated child
  spawn edge and no launch generation). The daemon exposes `socketPath`, so a test can drive it through the real
  `RadarControlClient`, i.e. the same wire path the production adapter uses.
- Activity publication is genuinely absent: `agent.get` in the fixture has **no** `execution` field at all
  (`grep -n execution extension/support-radar.ts` matches only an import comment). The pinned shape
  (`execution.snapshot.snapshot.activity` with `execution.snapshot.freshness`, fresh/stale/missing) has to be
  added, sourced from the existing `agent.publish` wire case's recorded snapshots.
- These two are what the four subjects wait on: three of them ("unassigned Lead routes supervisor messages
  directly to Chief", "legacy Lead pendingAsk state is normalized and does not block messaging", "a Chief's
  supervision lists a Lead only when the Radar observation proves it") need a proved non-child Lead/Chief, and
  "assignment status normalization fails closed safely" needs the published activity dimension.

Not run this pass: affected-suite comparisons (controller-lifecycle, recovery, agent-runtime,
extension-contract), type comparison, `npm run check`, package audit, image, smoke, acceptance.


## Pass 17: standalone Radar proof/publication and four controller-api subjects

### Fixture execution projection

The fake daemon's `agent.get` now projects the latest recorded `agent.publish` execution snapshot in the pinned
shape: `execution.snapshot.{freshness,snapshot}`. It stores the wire `observed_at` value; an in-window publication
is `fresh`, an old/invalid timestamp is `stale`, and no publication omits `execution` entirely. The client
therefore exposes activity only for a fresh publication. Registration/session/location facts are retained from
the existing `agent.register` wire case; standalone registrations pass no `spawn_token` and create no spawn edge
or launch generation.

### Test rewrites

Added one small test helper in `controller-api.test.ts` that drives `createRadarClient` over the fixture socket:
registers with `RADAR_SUBJECT_SOURCE`, its own incarnation and `readProcessBirth()` process claim, current session,
and canonical `tmux:herdsman-fixture:%N` location; then reads the exact registration proof and, when requested,
acquires/publishes execution through the same wire client. No observed-row liveness injection or test-only spawn
is used.

- `unassigned Lead routes supervisor messages directly to Chief` and `legacy Lead pendingAsk state is normalized
  and does not block messaging` now use a client-registered Chief with its own persisted `agentId` proof; deleted
  the former fake Herdr CLI/observation emulations.
- Renamed `a Chief's supervision lists a Lead only when the Radar observation proves it` to say "Radar registry
  proves it". The positive Lead is registered at its persisted canonical pane; the refusal case has a real
  registration whose location contradicts the persisted record.
- `assignment status normalization fails closed safely` now exercises fresh supported activities, unsupported
  activity, stale publication and missing publication via the registered subject and production client decoder,
  then checks the existing fail-closed presentation classification. Removed its deleted-row-status and
  unrelated mailbox-eligibility emulation from this subject.

### Measured

- Four exact subjects together: **4/4 pass**.
- Whole `controller-api.test.ts`: **71 tests, 61 pass / 10 fail / 0 cancelled**. The remaining ten unique names:
  `agent_extend rejects extra fields and every windowless worker`; `agent list projects an active user-question
  wait as blocked without owner reply`; `Chief preflight defers inbox delivery until agent_start`;
  `historical continuation re-parenting preserves every valid ownership path`; `lead steers a blocked parent
  waiting for direct-child work`; `parent controls only direct children and enforces session allowlists`;
  `registered lead exposes only explicit live controls`; `session continuation rejects label overrides and
  occupied inherited labels`; `successful controls persist their definition before runtime teardown`;
  `transcript projects persisted agent evidence without Herdr terminal reads`.
- Focused Radar suites: radar-launch **26/0**, radar-client **48/0**, radar-inspection **1/0**.
- Same-command type comparison on `extension/*.ts`: **840 -> 838** errors; **no new file+message pairs** versus
  pass 15 (`/tmp/mgr-rm/tsc-s15.log`).
- `git diff --check` passed for the two edited extension files.

Not run: `npm run check`, package audit, image, smoke, acceptance, and broader controller-lifecycle/recovery/
agent-runtime/extension-contract comparisons (deferred to integration as assigned).

## Pass 18: cause table for the remaining ten controller-api names (no edits landed)

Baseline: controller-api 61 pass / 10 fail (bg-702 / s20 logs). Causes measured from the failure text, before any edit.

| name | cause class | evidence |
|---|---|---|
| registered lead exposes only explicit live controls | stale Herdr-era mechanism (leadExec) | ReferenceError: leadExec is not defined (line 3856) |
| successful controls persist their definition before runtime teardown | stale Herdr-era mechanism (leadExec) | ReferenceError: leadExec is not defined (line 4050) |
| session continuation rejects label overrides and occupied inherited labels | stale Herdr-era mechanism (leadExec) | ReferenceError: leadExec is not defined (line 2931) |
| agent list projects an active user-question wait as blocked without owner reply | stale mechanism (agentControllerExecutor) + written-mailbox child | ReferenceError (line 4110); child is a written mailbox, presence needs a Radar child |
| lead steers a blocked parent waiting for direct-child work | stale mechanism (agentControllerExecutor, herdr CLI predicates) | ReferenceError (line 4174); body still emulates herdr agent list/get |
| Chief preflight defers inbox delivery until agent_start | unclassified (waitFor timeout) | Error: waitFor() timed out, 2425 ms; not yet traced |
| parent controls only direct children and enforces session allowlists | written-mailbox child, assertion on a Radar-less presence | AssertionError strict equal; needs a Radar-launched child to be proved |
| historical continuation re-parenting preserves every valid ownership path | written-mailbox child, assertion mismatch | AssertionError strict equal (diff not yet read) |
| transcript projects persisted agent evidence without Herdr terminal reads | written-mailbox child, assertion mismatch | AssertionError strict equal at the first transcript assertion (diff not yet read) |
| agent_extend rejects extra fields and every windowless worker | fixture invented evidence: idle written mailbox | extend-idle got target_ambiguous ("No Radar observation of this child exists"), test expects agent_busy. Production refusal is the Radar-only truth for an unproven child; the expectation is stale, not the production gate |

Classification result: no production defect shown by any of the ten. Five are stale Herdr-era executor bodies (leadExec, agentControllerExecutor). The rest rely on written mailbox children that Radar-only presence cannot prove, so each needs a Radar-launched child (retainedRadarWorker) or a standalone registered lead, following the four passing Lead/Chief subjects. Deletion candidates need named canonical coverage first; none is proposed yet.

Next step (not done): rewrite the leadExec group first (three subjects) on standalone registration plus a persisted coordination record with agentId, then the agentControllerExecutor pair, then the four assertion subjects after reading their diffs. Affected-suite comparisons (controller-lifecycle, recovery, agent-runtime, extension-contract, commands, observation-refresh, supervision, presentation) and the type pair comparison were not run: nothing changed, so there is no new state to compare.

## Pass 19 (started, stopped before edits): step 1 scoped, nothing landed

State: controller-api unchanged at 61 pass / 10 fail (the pass 17 measured state; no edits in pass 18 or 19).

Step 1 scoping, measured from the test bodies:
- The three leadExec subjects ("session continuation rejects label overrides and occupied inherited labels",
  "registered lead exposes only explicit live controls", "successful controls persist their definition before
  runtime teardown") deliver steer/reply/inspect through the Herdr-era marker protocol: `leadExec(label, state,
  session, onMarker, ...)` answers pane-run calls carrying `__PI_HERDSMAN_AGENT_V5__:<requestId>` and their
  acknowledgement hooks write `lastAck` into the mailbox by hand, then tear down the session.
- The Radar equivalent of that delivery is the fixture child's consume/ack path. The seam is
  `retainedRadarWorker` (controller-api.test.ts ~2030, the file's existing Radar-launched child used by the
  passing relaunch subjects), plus `onChildRequest` for the child's received text and `drainRadarObserves` for
  the barrier. Each subject needs its acknowledgement moved from the marker hook to the Radar child, which
  has not been written or run.
- The "occupied inherited labels" half also depends on the `tab create` emulation in the same leadExec hook.
  Its first half (invalid label rejected, zero calls) already passes in isolation and is kept.

Not done: steps 1-5, the affected-suite unique-name comparisons, and the type pair comparison. The next worker
should start with "successful controls persist..." (three actions; the cheapest to read through the Radar child),
measure controller-api after each subject, then continue in the pass 18 order.

## Pass 20 (worker): controller-api ten-name repair, per-name counts

- 1/10 "successful controls persist their definition before runtime teardown" -> renamed "successful controls report the definition of the child they reached"; rewritten on retainedRadarWorker for steer, reply, inspect (the Herdr marker-ack teardown hook removed; the persist-before-teardown invariant had no other check). Name passes. controller-api whole file: 71 tests, 62 pass / 9 fail (exit 1). Failing: agent_extend windowless, agent list user-question wait, Chief preflight timeout, historical re-parenting, lead steers blocked parent, parent controls direct children, registered lead explicit controls, session continuation label overrides, transcript evidence.
- 2/10 "registered lead exposes only explicit live controls" -> rewritten on retainedRadarWorker (steer, interrupt, list). The retained Lead now registers its tools (`allTools: () => pi.tools`, one line in retainedRadarWorker: a real Lead's active-tool baseline is its registered set; the empty baseline was a fixture gap). Expectation for the child's available_tools now includes agent_transcript, which production adds when the child has a persisted session (the retained child has a real one). Name passes. Whole file: 71 tests, 63 pass / 8 fail.
- 3/10 "session continuation rejects label overrides and occupied inherited labels" -> dropped the Herdr `tab create` exec; the occupied-label refusal is a mailbox check and the launch that must not happen is asserted through `radarDaemon.spawns` (unchanged count). Name passes.
- 4/10 "agent list projects an active user-question wait as blocked without owner reply" -> rewritten on a retained Radar child (question-wait evidence on its mailbox). Name passes.
- 5/10 "lead steers a blocked parent waiting for direct-child work" -> DELETED. Subject was a ~500-line Herdr-tree (parent with steerable children, handoff settling, foreign workspace, emulated agent list/get). Canonical coverage of its invariants: steer reaches a waiting worker and interrupt is refused (agent-runtime.test.ts "a steer reaches a waiting worker without changing its assignment, while interrupt is refused"); background-waiting workers reject interrupt (recovery.test.ts "background-waiting workers keep digest/extend eligibility but reject interrupt"); reply listed, not interrupt (recovery.test.ts "a digest entry for a worker awaiting an answer lists reply, not interrupt"); settling counts (presentation.test.ts "Status widgets preserve parent families and settling counts"). Removed the now-unused observeRowStatus import. Whole file: 70 tests, 65 pass / 5 fail (exit 1).

### Pass 20 owner ruling (applied): delete the Herdr-era subjects, name coverage, no rewrites beyond a few lines

Per name (the ten from pass 18):
1. successful controls persist their definition before runtime teardown - DELETED. Behaviour: a steer/reply/inspect result reports the child's definition (presentation_agent_definition). Canonical coverage: none, follow-up. (An earlier rewrite on retainedRadarWorker passed and was deleted per ruling.)
2. registered lead exposes only explicit live controls - DELETED. Behaviour: the lead's active-tool baseline, the child's available_tools (inspect/steer/interrupt/close, transcript when a session exists), steer and interrupt delivery with acceptedAssignment. Canonical coverage: none, follow-up. (Earlier rewrite passed; deleted per ruling.)
3. session continuation rejects label overrides and occupied inherited labels - DELETED. Behaviour: an invalid label is rejected by the tool schema (invalid_request); an occupied inherited label refuses with agent_label_exists and launches nothing. Canonical coverage: none, follow-up.
4. agent list projects an active user-question wait as blocked without owner reply - DELETED. Behaviour: question-wait evidence lists the agent blocked with no reply or interrupt control. Partial coverage: recovery.test.ts "a digest entry for a worker awaiting an answer lists reply, not interrupt". Blocked-state projection itself: none, follow-up.
5. lead steers a blocked parent waiting for direct-child work - DELETED (earlier). Coverage: agent-runtime "a steer reaches a waiting worker without changing its assignment, while interrupt is refused"; recovery "background-waiting workers keep digest/extend eligibility but reject interrupt"; presentation "Status widgets preserve parent families and settling counts". Lead-side parent steer with direct children: partial, follow-up.
6. parent controls only direct children and enforces session allowlists - DELETED. Subject needs multiple Radar-launched children under a managed parent (not a few-line fix). Coverage: none for direct-child control gating and session allowlists. FOLLOW-UP (owner-relevant: ownership gating of agent controls is unverified by any current green test).
7. historical continuation re-parenting preserves every valid ownership path - DELETED. Coverage: partial, controller-lifecycle "a nested worker keeps the same child directory as its owner". Re-parenting across historical sessions: none, follow-up.
8. transcript projects persisted agent evidence without Herdr terminal reads - DELETED. Needs a Radar child with a populated persisted session (a rewrite, not a few-line fix). Coverage: none found by name for the transcript projection; follow-up.
9. agent_extend rejects extra fields and every windowless worker - FIXED, expectation only: an idle or resolved written mailbox with no Radar observation is target_ambiguous (presence unproven), not agent_busy. The extra-fields refusal and the other case (extend-other-owner, target_not_found) are unchanged.
10. Chief preflight defers inbox delivery until agent_start - DELETED. The subject is built on Herdr observed rows (herdr:pi sessions, workspace get, worktree list). Coverage: none found; Chief inbox deferral until agent_start is a follow-up.

Also removed as dead in this pass: the controller-api import of observeRowStatus (earlier), the dynamic writeQuestionWaitEvidence import (now unused).

Measured (module-mock loader, --test-timeout=20000):
- controller-api.test.ts: 71 tests at the start of pass 20 (62/9 after name 1 ... 65/5 after name 5); after the deletions 62 tests; before the agent_extend expectation fix 61 pass / 1 fail (the agent_extend name, extend-resolved case); after both expectation edits the subject passes on its own (exit 0).
- agent-runtime.test.ts: 90 tests, 77 pass / 13 fail (exit 1). The four HEAD baseline names are among the 13 ("a recovered worker settles with an unretrieved prior-request result named in its answer", "only unfinished work holds while unreviewed terminal results settle", "settlement publishes an unread terminal result without a post-review response", "unfinished background work holds settlement through a flush and late work"). The other nine are NOT the four baseline names: "active state plus matching durable result repairs to completed", "agent ask_owner blocks settlement and reply resumes the same assignment", "agent bounds result persistence failure and exposes owner recovery evidence", "agent rejects task replay while result persistence recovery is present", "message limits do not consult project trust", "owner ask delivery is branch-local and recovers on tree navigation", "owner ask resolved while busy is not delivered after settlement", "owner ask waits while busy and delivers once after settlement", "parent settlement waits for agent delivery and ignores result cleanup lag". This pass edited only controller-api.test.ts, which is a separate module from agent-runtime.test.ts, so this pass did not cause these nine. They trace to earlier passes' shared support.ts fixture changes (passes 11-13), not measured here against a pre-pass baseline. OPEN: the owner's "equals its four baseline names" is not met; needs a name-level comparison against the pre-pass-11 tree.
- Type pair comparison (same command, extension/*.ts), current tree 803 messages vs pass-15 baseline 840. Pairs removed: leadExec, agentControllerExecutor, agentFromState/isAgentList/isApiSnapshot counts reduced, and TS2554 60 -> 45 (deleted subjects). Pairs added versus pass 15: TS2339 "Property 'message' does not exist on type 'RadarResult<...>'" at controller-api.test.ts 94-118 (the pass-17 standalone registration helper, registerStandaloneRadarAgent, which reads .message on a RadarResult union member without narrowing) and TS2339 at 3378-3464 (test bodies of the historical/relaunch area). No production file gained an error (extension/index.ts and radar-launch.ts unchanged in the pair diff). These are test-only type errors; owed a follow-up to narrow the RadarResult reads.
- Not run this pass: npm run check, package audit, image, smoke, acceptance, and the other affected-suite comparisons (per ruling).
- FINAL controller-api.test.ts (module-mock loader, --test-timeout=20000): 62 tests, 62 pass, 0 fail, test exit 0 (after the two agent_extend expectation fixes). agent-runtime unchanged this pass: 90 tests, 77 pass, 13 fail (see the note above: four baseline names plus nine unexplained, not caused by this pass's file).
