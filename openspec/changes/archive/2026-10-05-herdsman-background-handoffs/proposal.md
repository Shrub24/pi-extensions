# Proposal

## Why

A Herdsman worker currently publishes its last assistant text at `agent_settled`, even if it still owns background processes or unread results. Delegation also accepts unstructured task text, which cannot enforce the scope/context needed to keep workers focused or distinguish a task brief from its required response.

## What Changes

- Add an automatic settlement hold and public `waiting` state for managed background work. Keep the assignment and process alive until its work is resolved and the worker produces a final response; no blocking wait tool or process polling by the model.
- Expose assignment-scoped outstanding work from pi-bash-processes through a small public lifecycle interface. Reuse its task map, result readiness, snapshots and wake delivery. Notification acknowledgment alone is not result retrieval.
- While waiting, preserve inspect/transcript/steer and eligible extend controls; do not offer interrupt, continuation or idle cleanup.
- **BREAKING:** require a schema-valid, versioned Markdown delegation brief for every new `agent_delegate` assignment and every new task supplied to `agent_continue`. Common scope/context requirements cannot be disabled; role profiles add their own required context.
- Add a separate response contract, resolved from role defaults and explicit orchestrator overrides for each assignment. Enforce inline/file requirements and declared response structure before publishing a completed result.
- Record framework-owned request/session identities and artifact evidence separately from model-authored claims.
- Keep compile checks, deterministic tests and logic review as the agent acceptance gate. Runtime smokes are user-owned. Context-extension migration and a pi-jev consumer are not part of this change.

## Capabilities

### New Capabilities

- `herdsman-background-work`: assignment-scoped background work, automatic waiting, wake/resolution, recovery and settlement safety.
- `herdsman-delegation-briefs`: mandatory typed Markdown delegation briefs with common and role-specific requirements.
- `herdsman-response-contracts`: role defaults, orchestrator-controlled response requirements and validation before result publication.

### Modified Capabilities

None in the main capability inventory, which is currently empty. This change depends on the unarchived `herdsman-lead-orchestration` implementation; its retained-idle and soft-deadline rules remain valid except that an unresolved waiting assignment is not idle and remains eligible for advisory deadlines.

## Impact

- `pi-herdsman/extension/index.ts`: assignment submission/admission, managed worker settlement, request handling, recovery, scanner and available controls.
- `extension/core.ts`, `mailbox.ts`, `presentation.ts`, `agent-definitions.ts` and their tests: waiting projection, persisted per-assignment contract metadata, schema profiles and presentation.
- `pi-bash-processes/extensions/background-tasks.ts`, `types.ts`, `task-result.ts` and a small lifecycle interface: assignment binding and durable result-resolution observations, without a second task registry or wake loop.
- Existing delegation examples, built-in definitions, skill/reference/ADR documentation and task fixtures must adopt the new strict brief contract. Plain response text remains possible when the response contract permits it; plain delegation text does not.
- Dependency: the accepted declared-background-task lifecycle (`mqzsqmrowvuq` / `c6c37e3d0bc6`) has been integrated into this workspace; task 1.1 is complete. Source hashes, the test-isolation correction and the green baseline are recorded in `phase-02-provenance.md`. The newer canonical codemode-intent changes were excluded. Further implementation builds on this chosen prerequisite, not on the moving canonical working copy.
