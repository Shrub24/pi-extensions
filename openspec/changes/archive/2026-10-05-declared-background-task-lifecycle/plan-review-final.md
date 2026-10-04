# Final re-check — declared-background-task-lifecycle (same reviewer, run 86808c39)

Role: independent READ-ONLY reviewer. Bounded re-check of my already-captured inventory, not a new broad review.
No repo edits, no tests/live probes, no nested agents. One static validation command (`openspec validate`) was run to check the "strict validation passed" claim; nothing else was executed.

Prior full inventory (original verdict BLOCK, 2 P1 + 3 P2) is preserved verbatim in the repo at
`openspec/changes/declared-background-task-lifecycle/plan-review.md` (13,400 bytes, byte-identical to my prior artifact — verified by `diff`).

Sections read this pass: `proposal.md` (Impact), `design.md` Decisions 1/4/6 (plus adjacent context), affected spec scenarios,
`tasks.md` 2.3/2.4/4.1/4.5, `handoff.md` locked behavior + Model surface / CLI stdout-stderr gates. Correct severity ladder confirmed
against `/home/saurabhj/.pi/agent/skills/review-policy/SKILL.md` (P0 blocks merge; P1 before release; P2 notes).

## Disposition of prior findings

| Prior finding | Status | Evidence in corrected artifacts |
|---|---|---|
| **P1-1** TUI disposition of `bg_status` unstated; shared prompt named it | **Resolved (option b)** | `design.md` Decision 1: "In normal TUI, register only `bg_task` with spawn/get/stop/list; do not register the separate `bg_status` tool" … print/json/rpc/unknown "retain `bg_status` as a compatibility adapter: its list/stop/log actions use the shared observational inventory, confirmed-stop, and get operations respectively, with no live-log-path details or independent acknowledgment channel." `spec.md` TUI scenario: "bg_status SHALL NOT be registered in TUI, and neither bg_status nor bg_task action:\"wait\" SHALL be recommended by the TUI prompt … installed shared block SHALL be mode-neutral." Noninteractive scenario: compatibility `bg_status` list/stop/log "SHALL use the shared list/stop/get operations without live-log-path advertisements or a separate acknowledgment channel." `tasks.md` 4.1/4.5, `handoff.md` locked behavior and Model surface gate all align. The earlier ambiguity (keep-with-live-log vs drop-with-prompt-mismatch) is closed: dropped in TUI, and prompt names removed from the shared block. |
| **P1-2** Proposal Impact contradicted mandated CLI stdout/metadata-stderr split | **Resolved** | `proposal.md:31` now excludes only "stream-separated captured-command logs" and adds: "Command stdout/stderr remain combined; the CLI deliberately separates raw captured output (stdout) from retrieval metadata (stderr)." No contradiction remains with `proposal.md:11`, the spec's "Full output uses ordinary stdout and stable artifacts", or `design.md:60`. |
| **P2-a** "hard timeout" not a named setting | **Resolved** | `design.md` Decision 6 now names the keys: "`foregroundYieldMs` = 20,000 ms; `defaultSoftTimeoutMs` = 600,000 ms for reviews; `defaultTimeoutSeconds` = 0 (disabled) for the absolute process ceiling, overridden per task by the existing `timeoutSeconds` option," and states "'Hard deadline' is descriptive terminology for that ceiling, not a new setting." `spec.md` Hard-deadlines requirement names the same keys. |
| **P2-b** POSIX-only bridge vs unconditional spec CLI wording | **Resolved** | `spec.md`: "On supported POSIX hosts, `pi-bg get ID --output` SHALL … New Windows CLI support is out of scope; Pi-tool get/stop/list SHALL retain their existing platform support." `handoff.md` locked behavior: "on supported POSIX hosts … do not add a Windows CLI." |
| **P2-c** accepted-receipt retry vs abandoned-preparation expiry | **Resolved** | `design.md` Decision 4: "Expire only unaccepted abandoned preparations … Accepted tokens must return the committed outcome on retry through the owning task's retained lifetime (or an explicit task-expired outcome once it is pruned), never an unaccepted-preparation error that implies acknowledgment was rolled back." `spec.md` "Output preparation or delivery fails" scenario encodes the same two-step rule. |
| **Recommendation (non-blocking): early bridge fixture gate** | **Adopted** | `tasks.md` 2.3: "Establish this two-session/managed-bash bridge fixture before building the full CLI adapters or removing receipts." `handoff.md` Assignment B: "**Early feasibility gate:** first prove two-session socket request/response and managed-bash-invoked pi-bg without deadlock; do not remove the old receipt channel until the declared bridge and acknowledgments pass." |

## Cross-artifact coherence after correction

- Shared installed block is mode-neutral and, per spec + `tasks.md` 4.5 + `handoff.md`, names neither `bg_status` nor `bg_task action:"wait"`; both TUI push-wait and noninteractive named bounded-wait compatibility guidance come from the `before_agent_start` per-session contribution. I previously verified that hook can contribute system-prompt text (`types.d.ts:694-702,1085-1088,1164`), so the mechanism remains implementable.
- `ctx.mode === "tui"` remains the discriminator; unknown mode is conservative (compatibility path). Consistent across design, spec, tasks, handoff.
- Task handle resolution is by ID; the compatibility `bg_status log` adapter resolves its pid to the task and forwards to the shared `get`. No live-path inference is reintroduced, so the "IDs MUST NOT be inferred from a live file path" requirement is still honored.
- CLI acknowledgment commit point (requested stdout write completes before internal success receipt; EPIPE/open/write/disconnect before acceptance ⇒ no ack, no running-review reset) is unchanged and now consistent with accepted-token retry semantics.
- Hard deadline immutability, review-clock semantics, list observability, and codemode/foreground preservation show no new internal conflict introduced by the edits.

## New findings

**No issues found.**

No P0, P1, or P2 remains outstanding against this plan. The two P1 contract conflicts are closed without scope widening, and all three P2 notes are corrected. The previously supplied plan-review.md is a faithful verbatim copy of the original inventory, so no provenance drift.

## Residual risks (not findings)

- The plan remains large for one OpenSpec change (lifecycle/ack/review state + new POSIX IPC transport + immutable snapshot artifacts + mode-selected schema/prompt + removal of read shims and sleep interception). This is within the owner's stated target; the early bridge-feasibility gate now bounds the riskiest seam.
- Removal of the inferred-read channel is destroy-sensitive; ordering is correctly gated (`tasks.md` 4.3 after declared acknowledgments pass), but must be honored literally across three sequential assignments.
- Host-queued stale wakes can still arrive after terminal retrieval; honestly documented and deferred, not a defect.
- Retention/pruning protection for in-flight terminal retrieval (`tasks.md` 1.4) is the likely regression hotspot; its deterministic tests are required by Assignment A's gate.
- `handoff.md` / `review.md` status paragraphs correctly remain "review pending" until this verdict; per the owner's instruction this is bookkeeping, not a contract defect and not a blocker. This final re-check now supplies the missing verdict.

## Verdict

**OK.** All P1 contract conflicts are resolved (P1-1 option b, P1-2), all P2 notes are corrected, and the recommended early bridge fixture gate is adopted. `openspec validate declared-background-task-lifecycle --strict` returns "Change 'declared-background-task-lifecycle' is valid." Implementable as specified; the remaining items are implementation-gated risks already assigned to owners and acceptance rows.
