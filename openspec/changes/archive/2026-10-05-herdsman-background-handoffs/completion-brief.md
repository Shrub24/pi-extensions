# Completion brief — herdsman-background-handoffs

## Objective

Complete the remaining implementation tasks and final deterministic validation for `herdsman-background-handoffs`. One retained sequential writer implements the phases below; the parent verifies each delivery before the next phase. A separate fresh-context read-only reviewer performs the final independent logic review. The operator has authorized continuing to completion and wants interruptions only for issues or decisions, not routine progress requests.

## Context

Workspace: `/home/saurabhj/Projects/dev/custom/pi-extensions-herdsman`.

Required planning context: `proposal.md`, `design.md`, `tasks.md` and all three `specs/*/spec.md` files in this change. Also use `phase-01-result.md`, `phase-02-provenance.md`, `phase-02-result.md` for accepted source identities and limitations. `herdsman-lead-orchestration` is the implemented predecessor: its retained-worker/deadline controls must remain consistent, and its outstanding independent logic review belongs in the final review.

Observed starting state: 2/18 tasks complete; tasks 1.1 and 1.2 accepted. The phase-02 provider is deliberately staged: bind refused, existing tasks reconciling; replace that scaffolding with actual Group-2 semantics rather than preserve temporary behavior. No waiting consumer exists yet. Last recorded tests: pi-bash-processes 291/0; pi-herdsman 816/0 with 1 skip (earlier baseline, not rerun in phase 02).

Starting jj change: `zltswkvvzqxuyzoxyqqtpoonollxpuls`; checkpoint `ce37f8e843db93607cc3e321256413d4d3f12349`. Dirty baseline diff: `/tmp/herdsman-completion-start.patch`, SHA-256 `a2e32d79fd40a83433698dfd3ca4a40b698e85fd2a704c9b7c851f1c85cac2c5`. Preserve all prior edits. Canonical codemode-intent work was intentionally excluded; do not import its moving working copy.

## Phases and allowed scope

1. **phase-03, tasks 2.1–2.4:** authoritative assignment ownership, durable success/error result resolution and mandatory protected-assignment wakes. Own pi-bash-processes lifecycle/helper/types/result/CLI modules, their deterministic tests and package docs. Implement these together so binding and completed-history behavior do not depend on fictitious intermediate resolution heuristics. Test the public provider and delivery seams; no Herdsman consumer yet.
2. **phase-04, tasks 3.1–3.3:** persisted waiting evidence, binding/recovery, every result-publication guard, post-review final response, controls/projection/digest/extend. Own pi-herdsman extension modules, mailbox/core/presentation tests and relevant docs/ADRs. Minimal paired provider changes are allowed when essential to the already specified seam; explain them and retest the affected package.
3. **phase-05, tasks 4.1, 4.2, 5.1:** common/role typed brief parsing, definition profiles/fingerprints, independently typed response contracts and defaults/overrides. Own small schemas/modules, definition validation, built-ins, deterministic tests and canonical documented examples. Do not invent a DSL or executable caller validators.
4. **phase-06, tasks 4.3, 5.2:** pre-side-effect owner admission, worker revalidation, context snapshots, accepted-request metadata and frozen response requirements, warm/recovery/interrupt paths, fixtures/tool guidance/SKILL/examples. Own corresponding pi-herdsman implementation/tests/docs. Test fixtures must pass the real admission schema, not bypass it.
5. **phase-07, tasks 5.3, 5.4:** actual Markdown/metadata structure, safe bounded declared-artifact reads, fresh/reused identity, one-shot typed failures and framework-owned provenance. Own response/result/identity handling and safety/race tests/docs. No automatic corrective model loop.
6. **phase-08, task 6.1:** package checks/full deterministic suites, strict OpenSpec validation, exact terminal statuses/source identities and scenario-to-test mapping. Persist the final writer handoff and manifest/evidence in the bound output directory. This does not complete independent review task 6.2.

After these phases, the independent reviewer covers all three capabilities plus retained lifecycle/deadline behavior from `herdsman-lead-orchestration`. Reviewer findings return to the same writer for minimal corrections and required reverification. Parent owns review synthesis and final task completion.

## Constraints

- One writer; no child fanout, concurrent editing, new task registry, second wake loop or blocking await inside agent_settled. Use the existing seams and package patterns.
- Preserve notification acknowledgment semantics; delivered notifications do not resolve results. Failed CLI handoffs/early pipe closure remain unresolved. Explicit delivered unrecoverable errors resolve as failure, not certified capture or notification acceptance.
- Binding/request/process identity must be exact across warm reuse and recovery. Missing expected/broken providers fail closed; genuinely absent optional providers preserve normal lifecycle. Do not infer ownership from timestamps or ambient environment variables.
- Mandatory common brief requirements cannot be weakened by role/profile or response overrides. Snapshot required context before launch and freeze accepted policy. Steer/reply keep their existing semantics.
- Validate declared artifacts, not model-advertised paths. Observe bounded full bytes, safe descriptors, content identity and explicit reuse; model check claims are not execution evidence.
- No production configuration switch, live worker smoke harness, context-extension migration, VCS mutation, dependency/lockfile churn, archival or canonical-checkout edits.
- Known typecheck limitation: phase-02 integration strict compilation reports the same 23 inherited diagnostics before/after its edits; the helper strict check is clean. Evidence is in the phase-02 artifact directory's `typecheck-comparison.json`. A pinned TypeScript/Node/Bun environment exists at `/tmp/herdsman-typecheck-7dcaa5d6`; do not install a compiler into the workspace. Never relabel those failures as green. If a required final gate cannot be met without unrelated source/API/dependency changes, raise the concrete scope decision with the parent.
- Stop and ask the supervisor on genuine ambiguity, necessary scope/spec changes, infrastructure/model/quota failure or a gate blocker. Do not silently narrow requirements. Normal in-scope bugs should be fixed and retested without asking the operator.

## Acceptance and parent barriers

Every phase must implement all its listed task behaviors and verification clauses, not just add a module or fabricate data. Prefer deterministic race/recovery fixtures over sleeps or live models. Preserve complete test evidence and command exit status; a Running task is not success and pipeline tails do not prove the test command succeeded.

Before ending each phase, use the supervisor channel in its own tool turn to request parent acceptance. Include: phase/task IDs, changed paths, actual command statuses/counts, exact source checkpoint/hashes, bounded actionable findings, evidence paths and the next phase. Wait for the parent to inspect and approve; do not begin the next phase or check off tasks independently. If correction is requested, fix this same phase and resubmit. After acceptance, return the phase report headed exactly `STATUS: ready`. Otherwise report `STATUS: blocked` with the concrete condition; never emit ready on partial or failed gates.

No user confirmation is needed between accepted phases. Parent task checkboxes and final acceptance are separate from writer prose.

## Response contract

Each workflow stage binds its report through the tool's output field. Final response: concise Markdown headed `STATUS: ready` or `STATUS: blocked`, then Outcome, Changed files, Verification, Evidence, Residual risks and Next step. Keep logs out of the prose; link durable complete captures. Distinguish observed evidence from inference and preserve any first failed attempts relevant to the final claim.

The final independent review report must give its exact examined source checkpoint, evidence-backed actionable findings (severity/path/reproduction or failed invariant), remaining verification gaps and a clear merge verdict. Keep cosmetic suggestions separate from blockers. Only real reviewed evidence counts as final review completion.
