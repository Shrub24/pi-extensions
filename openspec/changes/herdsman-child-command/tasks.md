# Tasks

## 1. Stage 1 — read and validate the launch input

- [ ] 1.1 Add one child-command read helper in `extension/herdr.ts` next to `validateEnvironment` that reads `PI_HERDSMAN_CHILD_COMMAND` from Herdsman's own process environment and returns unset, resolved, or invalid; verify in `extension/herdr.test.ts` that unset and empty both mean unconfigured, that an absolute path to an executable resolves, that a `PATH`-resolvable command name resolves, and that a relative non-resolving value and a non-executable file are each invalid.
- [ ] 1.2 Verify the invalid path fails the launch with a typed error naming the variable and that nothing is created: no tab, no pane, no child process, no agent record; assert the error text names `PI_HERDSMAN_CHILD_COMMAND` and that no fallback to the default executable occurs, using the existing start-failure suites.
- [ ] 1.3 Verify no configuration surface was added: `extension/config.test.ts` still passes unchanged, an unknown configuration field is still rejected, and no `/agents` menu item was added (`extension/extension-contract.test.ts`).

## 2. Stage 1 — transmission and launch identity

- [ ] 2.1 Export the resolved value in `prepareManagedWorkerLaunch` (`extension/index.ts:3277-3296`) as exactly one `PI_HERDSMAN_CHILD_COMMAND=<resolved>` assignment, and nothing when unconfigured; verify in `extension/herdr.test.ts` that a configured launch carries exactly one assignment with the resolved value and that an unconfigured launch is identical to the recorded pre-change environment.
- [ ] 2.2 Verify the assignment survives the pane-creation path unchanged (validation, reserved-name filter, `--env` placement), that `PI_SUBAGENT_CHILD` / `PI_SUBAGENT_PARENT_SESSION` / `PI_USE_STOCK` semantics are untouched, and that no new reserved name was added to `structuredTopologyEnvironment`, by extending the existing environment assertions.
- [ ] 2.3 Verify an inherited value is accepted: a worker that delegates reads the value it received and launches its own child with it, with no refusal and no default fallback; cover the case where the worker's own environment was never set by a shell.
- [ ] 2.4 Include the command in `resolveAgentLaunchInputs` (`extension/agent-definitions.ts:1035-1068`) and pass it at both fingerprint call sites (`extension/index.ts:3379-3381`, `:3421-3422`); verify the fingerprint changes when only the command changes, stays stable when it does not, and is absent-safe when unconfigured.
- [ ] 2.5 Verify the observable relaunch rule end to end: a retained worker whose recorded command differs (including set-versus-unset and unset-versus-set) is relaunched on its next assignment with the same session and label, while a matching command reuses the process; record in the same suite that a missing launch record is treated as a mismatch.
- [ ] 2.6 Document the launch input where the managed launch environment is described (`docs/reference/agent.md` covers managed agent behaviour; add a short section there or a dedicated page, and do not add it to `docs/reference/configuration.md`, which documents the configuration file only): the variable name, the accepted forms (absolute path, `PATH`-resolvable name, executable), the unset behaviour, the fail-fast rule, and that changing it needs a lead restart. Verify each documented form against the reader's tests.
- [ ] 2.7 Record the stage-1 limitation in the change (a `herdsman-control/v1` restart reuses the pane and does not apply a changed value) with a test that asserts the limitation, so stage 2 can flip the assertion.

## 3. Stage 1 — dotfiles handoff (dotfiles owner; outside this repository)

- [ ] 3.1 Hand the owner the contract: export `PI_HERDSMAN_CHILD_COMMAND=/home/saurabhj/.nix-profile/bin/pi-bolt-child` in the lead process's own environment (not the child's), the "unset or empty means unconfigured" rule for the reducer, and the note that the wrapper already exists in `~/.nix-profile/bin` while the earlier briefed premise said it did not.
- [ ] 3.2 Have the dotfiles owner export the variable for the lead and reduce the `pi` fish function to honouring it; verify one delegated worker's pane environment carries the assignment, and that a lead restarted with a different value relaunches a reused worker instead of reusing it. Do not edit dotfiles from this repository.

## 4. Probe — precondition for stage 2

- [ ] 4.1 Run the start-path probe in a throwaway pane (never a real worker pane) and record the installed Herdr version with: P1 whether `agent get` / `agent list` / `agent explain` report an agent started by `pane run` and what registers it; P2 whether `agent rename` applies the Herdsman alias afterwards and what the agent queries then report; P3 whether `agent wait --until idle --timeout` reaches readiness for such an agent and how long that takes; P4 how `pane run` handles a long argv containing spaces, quotes, `=` and newlines, and whether it takes a shell line or argv. Verification: a recorded transcript with exact commands and observed output, attached to this change.
- [ ] 4.2 Decide the stage-2 gate from the recorded outcome: proceed only if P1 and P2 succeed; if either fails, stop at stage 1, record the failing evidence, and keep the shell reducer. Verification: an explicit recorded decision naming the gate result, and no stage-2 edit before it exists.

## 5. Stage 2 — direct child start (blocked on group 4)

- [ ] 5.1 Add one start helper in `extension/herdr.ts` that runs the resolved command in the pane, polls bounded readiness, applies the alias, and returns the existing attempt shape; verify with focused tests that it sets `launchMayHaveStarted` only after delivery, captures the shell process before running, takes the command from the same group-1 read, and preserves the startup timeout budget.
- [ ] 5.2 Substitute the helper at the two `agent start` hunks (`extension/herdr.ts:1262-1312`, `:1484-1534`) and verify by test that with the variable unset the launch still uses `agent start` with identical arguments, and with it set the direct path is used.
- [ ] 5.3 Preserve failure and rollback parity: a run failure, a readiness timeout, and an alias mismatch each produce a structured failure naming the stage and roll back through `rollbackHerdrStart` with no orphan pane or stray agent record; verify each case as a focused test, including the crash-after-run case where the operation must not be retried blindly.
- [ ] 5.4 Verify readiness and alias observability: the launch is not reported successful before readiness is observed, the running child answers to its Herdsman alias in Herdr's agent queries, and Herdsman calls none of `report-agent`, `report-agent-session` or `release-agent` (the archived pane-metadata decision).
- [ ] 5.5 Verify the current command applies on a pane-reusing restart: with a different value after a lead restart, an owner-control restart of an idle retained worker runs the new command although the pane's creation-time environment is unchanged; flip task 2.7's assertion accordingly.
- [ ] 5.6 Update the launch documentation with the direct start path, the probe requirement for the installed Herdr version, and the rollback instruction ("unset the variable and restart the lead"). Verify the documented rollback by running it in the focused suite.

## 6. Integration verification

- [ ] 6.1 On the integrated tree run the parent-focused lifecycle and control suites, `npm run validate`, and `openspec validate herdsman-child-command --strict`; record actual exits and counts, with no source edits during the gate.
- [ ] 6.2 Verify one real delegated worker and one real owner-control restart in an installation with the variable set, recording the pane environment, the launch fingerprint entry, and the worker's identity across the restart; confirm no configuration-file, mailbox, control-protocol or delivery-ledger artifact changed.

## Coordination notes

- Stage 2 must not start before the group 4 decision is recorded; stage 1 is independently landable.
- The configuration-file surface is deliberately untouched: no `extension/config.ts` hunk, no `CONFIG_KEYS` entry, no `parseRawConfig`/`updateConfig` change and no `/agents` menu item.
- An upstream pre-extraction alignment is expected to rewrite `extension/index.ts` and `extension/herdr.ts`; keep to the named hunks in `design.md`, and prefer landing stage 1 first and stage 2 after the alignment.
- `extension/index.ts` and `extension/agent-runtime.test.ts` may be held by another worker; take explicit ownership before editing, and do not edit a held file.
