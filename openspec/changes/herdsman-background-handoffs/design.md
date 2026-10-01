# Design

## Context

See proposal.md for motivation. The source locations below are observations from the initial planning inspection, not current line-number guarantees. They determine the seams:

- In the isolated fork, `pi-herdsman/extension/index.ts:16216-16248` builds a result from `latest` once the active-request, pending-ask, pending-result, transition and delegated-child guards pass. The managed `agent_settled` handler calls it at lines 16362-16370. There is no background-work guard in that inspected path.
- `extension/core.ts:370-405` projects control state using active request, pending delivery and live lifecycle. The previous change added retained `idle`; background waiting needs its own projection, not another name for idle or settling.
- `extension/mailbox.ts:20-44,60-107` carries strict state, request and result envelopes. Waiting evidence and accepted briefing/response contracts need durable per-request metadata; the previous change's no-mailbox-change constraint does not apply to these new capabilities.
- `extension/agent-definitions.ts:27-63,75-101,133-145` defines supported frontmatter fields and uses Pi's existing frontmatter parser. Add profile/default fields through those same validation and composition paths.
- In the canonical checkout, `pi-bash-processes/extensions/types.ts:127-202` distinguishes process state, review state and flushed result readiness. `background-tasks.ts:303-324,1562,2173,2198` acknowledges completion notifications as well as retrieval. Therefore `exitNotified` or notification acknowledgment cannot establish that a worker reviewed its result.
- `background-tasks.ts:2600-2607` already flushes deferred exits at `agent_settled`; `:2610-2638` restores task snapshots and notification state. A blocking await inside a competing settled handler could deadlock the very wake that should release it.
- Task 1.1 is complete: the accepted declared-background-task lifecycle (`mqzsqmrowvuq` / `c6c37e3d0bc6`) is integrated here. `phase-02-provenance.md` records source hashes and the green baseline; newer canonical codemode-intent work was excluded. Task 1.2's helper, staged provider registration/query adapter and docs are accepted in `phase-02-result.md`; bind is refused and any task keeps the provider reconciling until Group 2 supplies ownership/resolution semantics.

## Goals / Non-Goals

**Goals:**

- One task authority, one wake scheduler, a small observable settlement interface.
- Make assignment completion depend on resolved work and a validated response, not merely stopped model streaming.
- Keep the mandatory incoming brief distinct from configurable outgoing response requirements.
- Preserve stable process/run identity and per-assignment request identity across retained reuse.
- Compile/type checks, deterministic race/recovery tests and independent logic review are the agent gate; runtime smoke belongs to the user.

**Non-Goals:**

- Discover arbitrary shell `&` processes, detached services or external providers that do not register managed work.
- A new orchestrator process, blocking wait tool, status-polling loop or automatic repair agent.
- Enforce the semantic truth of supplied context or model-authored test claims through Markdown validation.
- Arbitrary executable validators or an extensible workflow DSL.
- Manager/staff project work, magic-context integration, pi-vcc migration or a pi-jev consumer.

## Decisions

### D1. A provider-owned settlement view, not a second registry

Add a small public lifecycle interface in pi-bash-processes, consumed through the shared Pi extension event bus. Its operations are assignment binding/reconciliation, a current settlement snapshot, and change notifications. Snapshot data is bounded and includes provider identity/version, session/request identity, revision, outstanding task IDs, readiness/resolution reasons and reconciliation status. Keep types in a dependency-light module; do not expose ManagedTask, process handles or log writers.

The provider owns all task state. New tasks inherit the currently bound accepted assignment. Binding another request is refused while unresolved work exists. Persist the association in task snapshots so restore is not based on timestamps or ambient launch-time environment variables, which become stale during warm reuse. Completed history from earlier assignments cannot hold the next assignment. Running restored tasks without a provable association are quarantined for explicit reconciliation rather than silently adopted or ignored.

Registration/query is available before settlement. A registered but unrestored/broken provider is not the same as an absent provider: fail closed with an actionable condition. No-provider workers use the normal lifecycle. Provider listeners must unregister on disposal; stale registrations must not block unrelated sessions. A queued notification or a model prompt is not an authoritative snapshot.

**Rejected:** Herdsman reading task log files, PID guessing, scraping bg_task output, or importing pi-subagents' private registry. Each creates a second truth source or couples the new substrate to the one being replaced.

### D2. Result resolution is distinct from notification acknowledgment

Add a durable assignment-resolution observation to the existing task snapshot. Keep notification acknowledgment and its current replay semantics unchanged. Outstanding means running, capture-flushing, or terminal awaiting explicit result resolution.

Set the observation through the existing certified foreground result, terminal get/wait, declared CLI delivery and confirmed-stop paths. Running get/list, queued/delivered host wakes and failed handoffs do not resolve it. Both tool and CLI paths commit only after their existing delivery/readiness conditions hold. Do not retain completed snapshots with missing result evidence as though retrieval succeeded.

An irrecoverable capture/read error has an explicit terminal failure-delivery path: after that error is actually handed to the worker, record resolution-as-error so it cannot wait forever. This does not certify complete capture, change a failed retrieval into success, or acknowledge a notification that existing policy says remains owed. Task resolution and notification obligations remain separate.

**Rejected:** using exitNotified/completionOwed as a result-read flag; those fields can change on host notification alone.

### D3. Auto-hold is a nonblocking lifecycle transition

Immediately before constructing or retrying a result, query the bound provider. If unresolved, retain activeRequestId, invalidate the pre-wait completion candidate and persist a minimal waiting projection in ManagedAgentState: request identity, referenced task IDs and provider revision. The task data itself stays in pi-bash-processes. Result persistence remains guarded against stale request/process identity.

Waiting returns from agent_settled promptly so other settled listeners can flush wakes. Provider changes refresh the mailbox projection. Completion/readiness and reminders use the existing background notification scheduler; for a protected waiting assignment, a terminal resolution wake is mandatory even if ordinary notifyOnExit is false. Coalesce that obligation with an existing wake instead of sending a duplicate from Herdsman. Get/stop that resolves work before a held wake fires must cancel its now-obsolete obligation through the existing wake arbitration.

The next model turn is working, but the settlement guard remains active. When all tasks resolve, completion still requires a new assistant response after the last result review; an earlier 'done' or 'waiting' message is not revived as a final result. A final response that spawns another task is held again. Test interleavings and extension registration order deterministically.

**Rejected:** sleeping or awaiting process completion inside agent_settled; it hides waiting state and can prevent the background listener's wake flush.

### D4. Waiting keeps the assignment busy and forbids interrupt

Extend core state projection, listed records, renderers, widgets and runtime recovery with waiting. It remains unresolved for herd completion and retains its advisory window. Include it in digest/extend eligibility, still filtered by exact ownership and armed-window checks. Retention false is no exception to the outstanding-work hold.

Waiting controls are inspect/transcript/steer and eligible extend. No interrupt, continuation, task replacement or Clear idle. Pending owner questions keep their existing reply precedence. Direct calls revalidate the same conditions as listings. Steer can resume the model to get or stop its tasks; it does not silently abandon them. Ordinary explicit user/session shutdown remains cancellation, not proof of successful assignment completion, and retains the existing process-cleanup behavior.

Waiting metadata recovered by the lead is evidence of unresolved work, not a new independent registry. Worker restore reconciles it with the provider before allowing success. Lost processes and provider errors use existing error/attention handling, never counterfeit idle.

### D5. Incoming delegation uses strict typed Markdown

Keep the familiar task string, but require versioned YAML frontmatter plus a nonempty Markdown work body for every new assignment. Parse with the existing Pi parser and validate the resulting bounded data with the same runtime schema used by documented examples and admission. Add a small briefs module for parsing, normalization, profile selection, examples and error formatting.

Common fields:

- schema/version;
- objective;
- context summary (or explicit none) and context inputs with their purpose;
- scope.allowed and scope.excluded;
- constraints;
- acceptance criteria;
- response declaration (role defaults or explicit overrides).

Require meaningful nonempty scalar fields and acceptance, but allow explicitly empty input/exclusion/constraint lists where appropriate. Reject unknown fields, unsupported versions, wrong types and mismatched profiles within existing request byte limits. These checks cannot prove prose is genuinely well scoped; the orchestrator remains accountable for that judgment.

Definitions select a supported briefProfile. Start with common, investigation, research, execution and review. Map built-in scout/researcher/implementer/reviewer definitions appropriately; custom definitions default to common. Examples of profile additions: investigation questions/target locations, research questions/source constraints, execution affected area/validation expectations, review baseline/criteria. A request cannot select a weaker profile than its definition. Supported profiles extend one common schema; there is no separate bespoke parser for each role.

Resolve existing file/result references through snapshotTextFiles and the established attachment handling. Validate before creating a pane, request, context snapshot side effect or soft window. Then persist the normalized brief and effective response requirements with the accepted request. Revalidate at child admission; failure must not replace an active assignment. New task continuation and eligible interrupt replacement require fresh briefs; steer/reply remain ordinary scoped control messages.

**Rejected:** merely adding a prompt template, making good briefs optional, or treating response formatting as a substitute for a scoped incoming assignment.

### D6. Outgoing response requirements are separate and orchestrator-controlled

Represent a versioned ResponseContract independently from BriefProfile. Resolve role defaults plus validated per-assignment overrides at submission and freeze the effective contract. Do not let a role default defeat an explicit valid override or reuse a previous assignment's overrides.

Initial fields cover target (inline, artifact or both), format (text or Markdown), required sections, optional registered frontmatter schema, and artifact path/reuse permission when needed. Validate incompatible combinations up front. A plain inline one-line answer is valid when requested, even though its incoming delegation brief was strict Markdown. A file deliverable is mandatory only when the orchestrator asks for it. Schema references name supported validators, not executable caller code; section/path overrides provide normal flexibility without a new DSL.

Common and role-specific briefing requirements remain mandatory regardless of response overrides. Record response policy in accepted request metadata, rather than infer it by parsing incidental prose such as 'write a report'. Definition profile/default changes join the existing resolved launch fingerprint so retained workers with stale prompt policy are relaunched through the existing drift path. Per-assignment overrides do not change the launch fingerprint or force relaunch.

### D7. Validate the requested deliverable before success

After background and delegated work resolve, validate the final response using the accepted ResponseContract. For Markdown, parse actual headings/frontmatter instead of substring matching. For artifact targets, read the declared permitted path using existing file safety/byte-budget patterns, reject symlink/identity escapes and missing/nonregular files, and validate that file's content. Do not require the inline body to duplicate the file when the target is artifact only.

Capture required output-path existence/content identity at acceptance. Compare it with the final descriptor observation: without explicit allowExistingArtifact, an unchanged pre-existing artifact is not a newly produced output. Identical-content reuse is supported only when explicitly declared; record it as reused. Observe and hash the bounded final bytes without silently truncating a file and then claiming its full structure validated. A validator must not turn a task's prose scope declaration into an unimplemented filesystem sandbox.

Use existing ResultRecord transport identity and status. On validation failure, publish one failed record with a new typed invalid-response/artifact error and bounded field/path diagnostics; preserve diagnostic references. Do not mislabel it as persistence write_failure. No automatic unbounded corrective turns: the owner decides on a new valid correction assignment, optionally reusing the retained process. This resolves the failed assignment explicitly without counting it as a completed deliverable.

### D8. Separate evidence from claims

Framework metadata owns requestId, owner/session/run identity, effective contract version/hash and observed artifact descriptors/hashes. Do not accept model-supplied identity as authority. Keep model-authored check summaries distinguishable from any actual tool execution records linked by the framework. This change validates response structure and deliverable presence; it does not build a test-command execution tracker or certify arbitrary 'tests passed' prose.

### D9. Integration and migration

The lead-orchestration implementation is the substrate; its independent logic review remains outstanding. The accepted declared-background lifecycle (`c6c37e3d0bc6`) is the integrated prerequisite for readiness, result handoff and notification semantics. Task 1.1 is complete, with hashes and baseline results in `phase-02-provenance.md`: pi-bash-processes 282 pass / 0 fail; pi-herdsman 816 pass / 0 fail / 1 skipped. Task 1.2 is accepted as the staged registration/query interface and documented adapter (`phase-02-result.md`). Authoritative assignment binding/result resolution and Herdsman consumption remain in Groups 2–3. The parent recorded zero new integration type diagnostics, not a clean full strict compile.

Add typed metadata through mailbox validators and limits as one coherent protocol change. Define the wire-format update and explicit active-assignment migration together: already accepted legacy assignments can finish under the contract they were accepted with; all new delegations are strict. Do not retroactively invent a brief for old results or silently permit new plain-text delegation. If the current decoder cannot safely support that transition, pause legacy workers before upgrading instead of ad-hoc compatibility fallbacks.

Update definitions, fixture task constructors, tool help, examples and SKILL together. Verify every documented example with the actual validator. Preserve upstream semantics only for unaffected controls; waiting safety and strict new briefs are deliberate fork behavior, not opt-in exceptions.

## Risks / Trade-offs

- [Result delivery and wake acknowledgment currently share paths] -> add a distinct provider-owned resolution observation; tests protect the existing notification/replay contract.
- [Extension ordering, capture flushing and queued wakes race settlement] -> nonblocking snapshot guard, mandatory/coalesced resolution wake, both listener-order tests and identity revalidation.
- [Waiting could last forever after a broken capture or provider] -> explicit failure-delivery resolution and actionable provider reconciliation error; no false success.
- [Strict briefs make trivial tasks more verbose for the owner] -> canonical minimal examples and shared profile defaults; responses can still be one line.
- [Caller overrides could weaken the incoming brief] -> separate types and validators; overrides affect only responses.
- [Mailbox limits or stale artifacts could defeat validation] -> byte-bounded descriptor snapshots, accepted-path binding and explicit reuse permission.
- [Canonical source continues to change] -> use the recorded accepted prerequisite; later canonical work is not implicitly part of this integration.

## Migration Plan

1. Completed: integrate the accepted background lifecycle prerequisite with recorded provenance and establish the green baseline (task 1.1; `phase-02-provenance.md`).
2. Add the provider interface/resolution observations, then Herdsman waiting projection and settlement guard. Verify with fake task/wake dependencies and real public handlers, not long-lived model smokes.
3. Add the mandatory brief schemas/profiles and admission metadata, then independent response resolution/validation and artifact provenance.
4. Update tests, examples, skill and ADRs. Run package checks, all deterministic suites, strict OpenSpec validation and fresh read-only logic review.
5. Present the result and exact evidence to the user for their runtime smokes. No agent-owned smoke harness, automatic production switch or context-extension migration.

Rollback requires reverting the paired lifecycle/contract integration and disposing or explicitly reconciling active waiting work first. Never disable a hold around unresolved work just to force a final result.
