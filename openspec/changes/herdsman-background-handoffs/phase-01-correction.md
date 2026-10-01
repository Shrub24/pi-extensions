# Phase 01 correction — same writer, same three-file scope

## Objective

Correct the specific parent-observed interface failures below. This is a correction to your completed phase 01, not permission to start provider integration or later lifecycle work.

## Context and evidence

Workspace: `/home/saurabhj/Projects/dev/custom/pi-extensions-herdsman`, jj workspace `herdsman`. Your original brief remains applicable except that your two new files now exist and are the intended correction targets. All earlier edits and reserved intent paths remain protected.

Parent reviewed `extensions/background-work.ts` at SHA-256 `f69995ccaec6d9b65c29cd05ef916a74132b5b653ee60ac629499ee607393127` and authored tests. Parent executed `bun test tests/background-work.test.ts`: **17 pass, 1 fail**. The failing assertion is at test line 153: Bun's array toMatchObject requires matching array length, but the assertion specifies one outstanding task against a three-task snapshot. Production returned the expected three tasks; correct the assertion, not the snapshot behavior.

Parent's deterministic probe is `/tmp/herdsman-phase01-review-89155873.ts` (read-only evidence). It imports identical helper source as two distinct modules and shares one EventBus; it also exercises wrong-provider binding and excessive snapshot data. Observed results:

- Register/query through the same module returns ready. Query through the other module returns stale-reply, and that consumer receives zero valid change notifications. The module-private WeakMap is not shared across independently loaded extensions. This is a deterministic module-boundary test, not a live Pi smoke result.
- bind with expectedProviderId:different calls the actual provider, returns bound, and increments its mutation counter. Snapshot queries enforce expectation, but bind does not; checking only after invoking bind would still be too late.
- A ready snapshot containing 10,000 tasks and task IDs of 10,002 characters is accepted. Capping reason strings alone does not make the snapshot bounded.

No typecheck has passed. The parent could not resolve a local compiler/type package in this workspace. Do not install dependencies or try to repair this environment; the parent owns that gate separately.

## Exact allowed edits

1. `pi-bash-processes/extensions/background-work.ts`
2. `pi-bash-processes/tests/background-work.test.ts`
3. `openspec/changes/herdsman-background-handoffs/phase-01-result.md`

No other edits, history operations, source integration, configuration, manifests, live sessions or runtime wiring.

## Required corrections

1. **Independent consumers:** remove the requirement that provider and consumer share the same module-private WeakMap. Registration/disposal/stale identity must work for independently instantiated helper modules sharing the supplied bus, including change delivery and duplicate registration rejection. Keep registration metadata session-bus-owned, not task state. Prefer a minimal explicit versioned bus-owned metadata slot if that fits the public bus contract; do not add a registry framework, timer, polling or private host API. If this requires a material incompatible interface decision, ask the supervisor rather than inventing another protocol. Add an actual independent-module regression, not another test where all helpers share one module instance.
2. **Expected identity before mutation:** reject an unexpected provider before calling its bind method. Cover both returned failure and zero mutation count. Honor the same expected identity in change subscriptions; do not deliver notifications from a different provider. Preserve ordinary binding/refusal behavior.
3. **Real size bounds:** define and enforce explicit finite limits for outstanding-task count and identity fields (provider/session/request/registration/query/task IDs as applicable). Keep reason limits. Reject oversized or malformed payloads with an actionable fail-closed error; never truncate the outstanding list or an identity and then report ready. Bound collection of replies too, while still detecting ambiguity. Add tests at and beyond each limit. Keep limits documented in the module; do not claim an aggregate byte bound unless actually enforced or derived correctly.
4. **Existing assertion:** check the complete expected outstanding list or separately check its length/items instead of relying on a one-item partial array assertion. Do not weaken the provider-error snapshot behavior.

While touching malformed async handling, ensure a rejected Promise returned by a misbehaving provider cannot create an unhandled rejection after the helper reports provider-malformed. Do not wait on the Promise or introduce async resolution; consume its rejection safely and add the narrow regression.

Keep the implementation smaller where the above changes remove redundant machinery; no speculative APIs or lifecycle changes. The parent will judge both correctness and complexity.

## Parent-owned acceptance — do not execute

The parent will rerun the interface tests, the deterministic regression probe and appropriate compile/package checks after inspecting your corrected diff. You must NOT run tests, typechecks, build/lint/validation commands, probes or dependency installs. Author the regressions only. Do not mark task 1.2 complete.

## Response and stopping point

Update phase-01-result.md with outcome implemented-unverified (or blocked), exact changes for this correction, interface decisions and remaining uncertainties. Label 17/1 and the probe results as PRIOR PARENT observations, not checks you ran or a current pass. Explicitly say you ran no verification commands. Return its pointer and stop; no next-phase work.
