# Tasks

Implemented in `../pi-extensions-herdsman-metadata` and landed on `main` as
`sopuwyrr` (publisher, hierarchy, owner state) and `xlyvuzsx` (the contract
correction from the Herdr probe). The package gate is green at the settled head
(824 tests, 823 pass, 0 fail, 1 skipped), `openspec validate --strict` passes,
and one fresh-context read-only review ran; its P1 (reporter loading under
`--no-extensions`) and two P2s (shutdown clear, role-change wording) are fixed
and retested. Live Herdr and herdr-radar smokes are user-owned and outstanding.

## 0. Sequencing and contract first

- [x] 0.1 Create the implementation workspace. Decision: a new jj workspace (e.g. `../pi-extensions-herdsman-metadata`), not narrow edits in the shared one, because the metadata section and lead queue sit in the same 16K-line `index.ts` that background-handoffs phases 02-06 are editing and that file's working copy is uncommitted. Base it on the shared parent `main` / `zwqwkkrxorsk` (`1aced15f5b99`, the linearized soft-deadline and retained-worker lead features; its independent final review is still outstanding, so record that in the baseline), not on the herdsman WIP change `zltswkvv` that carries background-handoffs, and rebase onto the settled head before the final gates. Carry this whole OpenSpec directory into the new workspace's history when the change starts. The workspace needs its own dependencies; link or install them before the baseline and record how. Keep this OpenSpec root in the herdsman workspace. Verify: the base builds and its pi-herdsman tests pass before any edit, with the baseline recorded.
- [x] 0.2 Write the token contract reference and the machine-readable fixture (lead, worker, owner view) and hand it to the herdr-radar developer. Settle with them the D4 names and the `summary`/`title-suffix` question, and that radar reads both hierarchy encodings (D9). Verify: fixture parses and covers every token in the specs; radar's owner confirms or amends names.
- [x] 0.2b Verify, rather than assume, that every managed worker is placed in its owner's Herdr workspace (the same-workspace invariant D10 relies on) and record the code path that enforces it. Verify: a test or documented enforcement point; if any placement can cross workspaces, stop and report instead of widening the contract.
- [x] 0.3 Verify D5's open point: what `PI_HERDSMAN_OWNER_SESSION_ID` holds for a worker launched by a delegating worker. Verify: a deterministic test of the launch environment builder.

## 1. Publisher module

- [x] 1.1 Add the delegation-independent publisher module: sanitise, 80-character bound, whole-number context percentage, snapshot equality, request builders, TTL and refresh timing, clear snapshot. Port pi-herdr's formatting rules with an attribution note. Verify: unit tests for bounds, control text, unknown-value clearing, equality, refresh and clear.
- [x] 1.2 Define the publisher interface (inputs, injected runner, abort signal; native timers are virtualized in tests) so lead and worker wiring and the owner view share it. Verify: the module imports nothing from the delegation code (checked during logic review).

## 2. Lead and worker wiring

- [x] 2.1 Route worker publication through the module: session-self tokens plus `pi_herdsman_*` orchestration tokens, remove legacy bare tokens, keep titles and display agent. Verify: tests assert the exact token set for idle and active workers, and that legacy tokens are never emitted.
- [x] 2.2 Route lead publication through the same module: session-self tokens plus role, pending ask and name. Verify: tests for lead tokens, ask set/clear and name set/clear.
- [x] 2.3 One queue, drop superseded snapshots, bounded timeout, best-effort failure, clear on shutdown/session replacement (awaited), and clear the role token on role exit, without touching other sources. Verify: race tests including rapid updates, failure then recovery, and shutdown mid-flight.

## 3. Hierarchy

- [x] 3.1 Publish `pi_herdsman_session` for leads and workers and `pi_herdsman_parent_session` for workers from existing environment. Verify: tests for session replacement and for lead-without-parent.
- [x] 3.2 Confirm nested delegation yields the direct owner (0.3) and add a regression test.

## 4. Owner-published projection state

- [x] 4.1 Add the owner view: publish `pi_herdsman_state` per directly owned worker under `pi-herdsman:owner:<runId>` with TTL and refresh, from the existing projection function. Verify: tests per public state including `lost`, no publication for non-owned descendants, refresh before TTL, and expiry on owner stop.
- [x] 4.2 Clear the owner-view token when a record is closed or removed. Verify: close, recovery and cleanup tests.
- [x] 4.3 Confirm `waiting` is accepted additively once the background-handoffs change adds it. Verify: the state-name set is derived from the projection, not duplicated.

## 5. Reporter ownership and docs

- [x] 5.1 Pass the installed Herdr reporter explicitly (conditional on the file existing) so `--no-extensions` workers still load it once; discovery dedupes. Add a one-time missing-integration notice with the install command. Verify: argument-list tests; the actual double-load behaviour is a user smoke.
- [x] 5.2 Update README install guidance (official integration required, pi-herdr retired), add the token contract reference and agent-states cross-link, and add an ADR recording state and metadata ownership. Verify: documentation tests/lint used by the package.

## 6. Final gates

- [x] 6.1 Run package typecheck/check and the full deterministic suites; compare against the baseline without claiming a clean compile if inherited diagnostics remain. Verify: recorded exit statuses.
- [x] 6.2 Run `openspec validate herdsman-herdr-pane-metadata --strict` and map each spec scenario to a test. Verify: strict validation passes and no scenario is unmapped.
- [x] 6.3 Independent logic review of publisher race handling, source isolation and clearing, and the token contract against the fixture. Verify: no unresolved P0/P1 finding.
- [ ] 6.4 User-owned smoke: live Herdr with herdr-radar showing lead, worker, nested worker and a lost worker. Not performed by agents.
