# Phase 02 — complete the background settlement provider interface

## Objective

Finish the remaining portion of OpenSpec task 1.2: connect the public settlement interface to the real pi-bash-processes lifecycle, verify registration/query behavior, and document the interface and ownership rules. Do not implement later task groups or claim automatic Herdsman waiting is complete.

## Context

- Workspace: `/home/saurabhj/Projects/dev/custom/pi-extensions-herdsman`; jj change `zltswkvvzqxuyzoxyqqtpoonollxpuls`, launch checkpoint `9ef9bb4219f6827fb70f9a9913cb67e691341a13` (before this brief).
- The workspace is intentionally dirty. Existing changes include lead orchestration, all planning artifacts, the phase-01 interface and a test-isolation correction. Preserve them. No VCS mutations, commits, rebase, restore or reset are authorized.
- Read `proposal.md`, `design.md`, `tasks.md` and all three specs in this change, plus `phase-01-result.md` and `phase-02-provenance.md`. These are the approved contracts. Source line references in design are historical, not current line guarantees.
- Task 1.1 is complete. Accepted lifecycle prerequisite: `mqzsqmrowvuq` / `c6c37e3d0bc6`. Canonical's newer codemode-intent work is deliberately excluded. Do not import from the moving canonical checkout.
- The public helper exists at `pi-bash-processes/extensions/background-work.ts`; its tests are `tests/background-work.test.ts`. It already handles bounded protocol data, cross-module registration and fail-closed errors. Preserve those corrections.
- Phase 01 left the real provider adapter and docs outstanding. Background ownership/resolution persistence is specified in tasks 2.1–2.3 and Herdsman acceptance/settlement in Group 3; do not invent substitute heuristics to bypass those stages.
- Verified baseline: pi-bash-processes 282 pass / 0 fail; pi-herdsman 816 pass / 0 fail / 1 skipped. Local pi-bash-processes Pi dependency resolves to 0.99.2 via an untracked symlink. Do not change dependency manifests, installs or lockfiles.

## Allowed scope

One writer owns the pi-bash-processes provider-registration/query seam. Allowed edits:

- `pi-bash-processes/extensions/background-tasks.ts`
- `pi-bash-processes/extensions/background-work.ts` only where necessary to integrate the existing protocol
- Closely related lifecycle source helpers only if directly necessary; explain each added path before editing
- `pi-bash-processes/tests/` focused interface/provider integration tests and fixtures
- `pi-bash-processes/README.md` and `DEVELOPMENT.md` for public interface and ownership documentation

No pi-herdsman implementation edits, no renderer/output-policy edits, no canonical checkout edits. Do not edit planning artifacts or task checkboxes; parent owns acceptance and tracking.

## Constraints

Reuse the authoritative task map, snapshot restore and lifecycle/disposal paths. No second task registry, polling timer or wake loop. Distinguish absent provider from registered-but-reconciling/error. Do not equate notification acknowledgment with result resolution. Preserve ordinary tool/CLI behavior and mode-specific schemas/guidance.

If a truthful real-provider adapter cannot be completed without the durable assignment-binding or result-resolution work explicitly scheduled in Group 2, stop and ask the parent to approve the concrete scope adjustment. Do not return empty success for unassociated work, introduce timestamp ownership heuristics, or claim task 1.2 complete on helper-only tests.

No runtime smoke harness, production settings changes, long live Pi agent experiments or automatic repair loops.

## Acceptance criteria

- Actual extension lifecycle registers the provider and disposes/replaces it correctly; tests exercise public runtime handlers, not only manually registered fake providers.
- Bounded, exact-identity query behavior covers presence, absence, stale/disposed registrations, wrong-session queries and restoration/reconciliation failures.
- Existing phase-01 cross-module, pre-mutation identity and bounded-reply tests remain green.
- Documentation states the interface/version, task authority, assignment ownership, fail-closed behavior and which later integration remains unimplemented.
- Run focused tests plus full pi-bash-processes suite. Run applicable checks (there is no pi-bash-processes `check` script; report that rather than invent one). Record actual exit statuses, not a pipeline's final grep/tail status. Keep complete command output available in a durable artifact.
- Report only evidence observed. An outstanding background command is not completed verification.

## Response contract

Return the report through the parent-bound subagent output artifact. Use Markdown sections: Outcome (`ready`, `partial`, or `blocked`), Changed files, Contract coverage, Verification (exact commands/status/counts), Residual risks, Next step. Include source hashes/checkpoint and retained run identity. If blocked, name the smallest required scope/decision and leave work recoverable. Final acceptance and task completion belong to the parent.
