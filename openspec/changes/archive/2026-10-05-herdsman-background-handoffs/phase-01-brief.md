---
schema: delegation-brief/v1
profile: execution
phase: background-settlement-interface
objective: Define the public background settlement interface and its registration/query helpers only.
context:
  summary: Herdsman must eventually hold assignment completion while managed background work is outstanding. This increment defines the interface; it does not implement that lifecycle.
  inputs:
    - ref: design.md
      purpose: Decisions D1 and D2 define provider ownership and resolution semantics.
    - ref: specs/herdsman-background-work/spec.md
      purpose: Required observable behavior; most of it belongs to later increments.
    - ref: tasks.md
      purpose: This assignment is only the interface portion of task 1.2, not the full checklist.
scope:
  allowed:
    - pi-bash-processes/extensions/background-work.ts
    - pi-bash-processes/tests/background-work.test.ts
    - openspec/changes/herdsman-background-handoffs/phase-01-result.md
  excluded:
    - Existing production files, package manifests and lockfiles
    - Herdsman lifecycle, mailbox, controls and definition files
    - Task persistence, acknowledgment, retrieval and wake delivery
    - Delegation-brief and response-contract implementation
    - Other workspaces, configuration, live panes and runtime experiments
constraints:
  - One bounded increment; stop after these artifacts or a concrete blocker.
  - No test, build, typecheck, lint, validation or runtime-smoke execution by the worker.
  - No dependency installation, source integration, history mutation, nested delegation or background command spawning.
  - No task-checkbox edits or claims that implementation is verified.
acceptance:
  - A small dependency-light interface with no task registry or process ownership.
  - Registration/query behavior distinguishes absent, reconciling, ready and error states and rejects ambiguous or mismatched responses.
  - Tests are authored for the bounded interface behavior, but execution is explicitly left to the parent.
  - The result identifies exact changes, assumptions and any blocker; it does not claim broader lifecycle work is complete.
response:
  target: artifact
  path: openspec/changes/herdsman-background-handoffs/phase-01-result.md
  format: markdown
  requiredSections:
    - Outcome
    - Changes
    - Interface decisions
    - Unverified items
    - Next increment
---

# Phase 01 — background settlement interface only

This brief uses the proposed delegation format as a working convention. The schema engine itself is not implemented yet; do not build it in this assignment. Frontmatter context references are relative to this brief's directory; edit-allowlist paths are relative to the workspace root.

## Workspace and ownership

Work only in `/home/saurabhj/Projects/dev/custom/pi-extensions-herdsman`, jj workspace `herdsman`, change `zltswkvv`. The canonical checkout `/home/saurabhj/Projects/dev/custom/pi-extensions` belongs to other work and is read-only context. Keep every pre-existing edit intact. Do not commit, merge, restore, rebase, push or switch workspaces.

The parent owns prerequisite integration (task 1.1), all command-based verification and acceptance. This module-only increment is independent of the existing ManagedTask implementation. It MUST NOT be wired into production before that prerequisite and later integration increments are accepted. Do not mark task 1.2 complete: its real provider adapter and documentation are not this increment.

## Facts you need

- Existing Herdsman settlement builds a ResultRecord from its last assistant text at `pi-herdsman/extension/index.ts:16216-16248`, called by the managed `agent_settled` hook at `16362-16370`. No change to that file is permitted here.
- The canonical current background lifecycle is newer than the sibling workspace's copy. Known canonical references: `pi-bash-processes/extensions/types.ts:127-202` for task identity/readiness, and `extensions/background-tasks.ts:303-324,1562,2173,2198` for completion acknowledgment. These references explain semantics; do not import or copy their private implementation.
- Completion-notification acknowledgment is NOT proof of result retrieval. A task may be terminal but still flushing, or have delivered a notification without its result being resolved. A delivered unrecoverable result error must remain distinguishable from successful resolution.
- Background wakes already flush at `agent_settled` (`background-tasks.ts:2600-2607`). The future integration must return promptly from that hook, not await a process while preventing another listener from delivering its wake.
- Processes belong to a stable worker session/run, but work is scoped to the active assignment request. Warm reuse means launch-time request environment variables are not an assignment authority.
- Public `waiting`, suppression of interrupt, settlement holds, task binding/persistence and mandatory/coalesced resolution wakes are later increments. Do not implement them now.

## Required work

Create `extensions/background-work.ts` as the small interface seam between the provider and its consumers. Use the existing package's TypeScript style and current public Pi extension event mechanism. Read the relevant installed Pi documentation/types before using that mechanism; do not invent event methods or private host APIs.

The interface must support:

1. Explicit provider registration and disposal on a supplied session-local event bus. No global singleton, process handle, timer, task map or persisted registry.
2. Assignment binding and current-snapshot queries delegated to the registered provider; helpers do not decide task ownership themselves.
3. Bounded snapshot data carrying provider/version, session/request identities, revision, reconciliation state and outstanding task IDs/reasons. Represent running, flushing and awaiting-result-review separately where relevant.
4. Explicit absence versus a registered provider's reconciling/error state. A query that expects a previously known provider must not reinterpret its disappearance as an empty successful snapshot.
5. Identity checks and fail-closed handling of duplicate providers, malformed replies, provider exceptions and stale/disposed registrations. Do not silently choose the first reply.
6. A change-notification interface carrying the same identity/revision scope. It is metadata, not a second model-wake delivery path.

Keep helper policy minimal. Use callbacks/provider methods for the authoritative binding/snapshot work. No adapters into existing task state, no autonomous polling, and no generic plugin framework or custom schema language. Do not add speculative operations for future phases.

If the public event mechanism cannot satisfy these requirements within this scope, or an existing file has appeared at an allowed path, stop and report the exact obstacle via the supervisor. Do not widen the allowlist, replace another writer's work or invent a fallback protocol.

Author `tests/background-work.test.ts` with a tiny fake event bus/provider exercising the actual helper interface: absent provider, expected-but-missing provider, reconciling/error snapshots, ready snapshot, wrong session/request, duplicate/malformed response, provider exception, disposal and scoped change events. Follow nearby test conventions. These are tests for the interface only, not fake proofs that background settlement or Herdsman waiting works.

## Hard stop and reporting

Do not execute tests, npm/bun check commands, tsc, lint, OpenSpec validation, builds or live probes. Do not amend the other package or 'fix' unrelated typing errors. Parent review and test execution happen after you stop.

Write the requested result artifact with:

- **Outcome:** `implemented-unverified` or `blocked`; never `verified`.
- **Changes:** exact allowed files changed and what each contains.
- **Interface decisions:** concrete shapes, event names and disposal/error behavior; distinguish decisions from assumptions.
- **Unverified items:** explicitly state no tests/build/checks were run; list any known uncertainty without claiming success.
- **Next increment:** the single next integration step and any prerequisite the parent must resolve.

Return only a short pointer to that artifact and any immediate blocker. End the assignment. Do not continue to task binding, lifecycle wiring, waiting, briefs or response enforcement. The parent will inspect your diff, run the appropriate gate and resume this same worker with another bounded brief.
