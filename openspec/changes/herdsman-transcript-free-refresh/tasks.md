# Tasks

## 1. Recurring lead and worker-leaf proof without transcript bodies

- [ ] 1.1 Delete the recurring owner-transcript body load (`isLeadSessionBoundary`, `pi-herdsman/extension/index.ts:2280`) and route `managedAgentSnapshots(proveLead=true)` lead authority through the published coordination state for the owner session; verify `npm test` passes for the extension tests and `grep -n 'isLeadSessionBoundary' pi-herdsman/extension/*.ts` returns no hits.
- [ ] 1.2 Guard the coordination-state authority read so malformed, unreadable, oversized or missing state yields `unknown` instead of throwing and instead of reporting `herd`; verify a focused test feeding malformed and absent coordinator records asserts `unknown` for both and that the refresh still completes.
- [ ] 1.3 Add a focused regression asserting zero `SessionManager.open` calls and no transcript body load across recurring lead status and worker-leaf status ticks; verify by running the extension test file with the instrumented mock and asserting a `0` delta on two consecutive ticks, while the existing bounded-header identity assertion (`matchesExpectedSession` / bounded header read) still passes unchanged.
- [ ] 1.4 Verify the independent loss projection is untouched: missing coordinator evidence leaves owner lead classification unresolved without changing independently observed activity or presence, and existing proven-lost and expired-`stale` fixtures still project `lost` and `stale`.
- [ ] 1.5 Confirm a lead's own breadcrumb and status rows are byte-identical before/after (lead breadcrumb is hardcoded, not proof-derived) and record the worker-leaf `?`-for-legacy-lead consequence in tests; verify the lead/worker fixture outputs match the recorded expectations.
- [ ] 1.6 Document the recurring observation contract in the pi-herdsman docs (per-role authority source, permitted bounded header identity checks, `unknown` for missing/malformed evidence, the legacy-lead `?` difference); verify the documented statements match what the tests assert.

## 2. Recurring naming and definition resolution

- [ ] 2.1 Remove the transcript-derived name read (`persistedSessionName`, `pi-herdsman/extension/index.ts:2269`) from the supervision snapshot (`:10897`) and resolve names from the already-published pane-name fact (`pi_herdsman_name`, `pi-herdsman/extension/supervision.ts:2355`) with already-available observation fields as fallback; verify supervision tests covering named, unnamed and unnamed-with-token agents pass with no `SessionManager.open` on the snapshot path.
- [ ] 2.2 Gate the legacy definition fallback out of recurring paths only (`allowTranscriptDefinitionFallback=false` through `agentDefinitionForRuntime`/`stateAgentDefinition`), keeping it for explicit and continuity callers; verify the recurring-path test reports `unknown` with zero opens while an explicit-caller test still resolves the legacy definition.
- [ ] 2.3 Prove an `unknown` observation is displayable but never authoritative: verify a periodic refresh over an undefined mailbox shows the unresolved definition without failing, and that a later explicit resolution of that same legacy definition returns the resolved value and is not shadowed by the earlier periodic `unknown` (cache-poisoning regression).
- [ ] 2.4 Add the same recurring-path regressions for the health-scan path; verify a health scan tick asserts zero transcript body loads and that an `unknown` result there does not infer `lost`.

## 3. Refresh overlap, generation safety and shutdown

- [ ] 3.1 Add an in-flight guard plus at most one pending rerun to the supervision refresh (`pi-herdsman/extension/index.ts:11943`); verify a test that holds one refresh open across two intervals observes exactly one in-flight refresh, at most one queued rerun, and no two concurrent refreshes of that kind.
- [ ] 3.2 Verify sustained fresh triggers are not prohibited but stay bounded: a test delivering triggers during an in-flight refresh shows later runs only after it finishes and a pending queue that never exceeds one.
- [ ] 3.3 Keep the existing generation/role guard authoritative so a superseded refresh publishes nothing; verify a test that changes the generation or role mid-refresh observes no publication from the stale completion.
- [ ] 3.4 Verify shutdown safety: a test that shuts down or replaces the session while a refresh is in flight shows the pending rerun cleared and no refresh started afterwards.
- [ ] 3.5 Verify the status refresh's existing overlap bound still holds after the change (one in-flight, one trailing rerun, no queue growth) by running its existing regression plus one overlap assertion.

## 4. Preserved explicit and continuity validation

- [ ] 4.1 Verify explicit transcript reads still load the transcript body and return contents (agent transcript tool, `readPersistedTranscript` command); run their existing tests and confirm unchanged pass counts.
- [ ] 4.2 Verify bounded header identity checks remain unchanged: exact-path `matchesExpectedSession` rejects a mismatched header and preserves its existing `ENOENT` exact-path fallback; run `extension/herdr.test.ts` and confirm the existing matching/error cases pass.
- [ ] 4.3 Verify conflict and retirement checks still fail closed on explicit, continuation and settlement paths (`sessionAgentIdentity` conflicting entries, `sessionContextRetired`, `retiredManagedSession`); run their existing tests and add one case proving a conflicting/retired session is still rejected.
- [ ] 4.4 Verify exact-generation lifecycle behaviour and retained-worker reuse/relaunch are unchanged by running `extension/controller-lifecycle.test.ts` and `extension/commands.test.ts` and confirming no new failures.

## 5. Integration verification on the deployed extension

- [ ] 5.1 Run the real package gates and record the exact commands and results: `npm test` and `npm run validate`, plus `openspec validate herdsman-transcript-free-refresh --strict`.
- [ ] 5.2 Sample live idle read rate before and after on deployed leads (per-lead `rchar` over a quiet window, plus a session reload) and confirm the recurring transcript body-load burn is gone while status/supervision output still renders; record the measured numbers.
- [ ] 5.3 Confirm no lingering recurring `SessionManager.open` call sites remain on lead/worker/health/supervision paths (source sweep) and record any remaining open sites with why they are not recurring.
