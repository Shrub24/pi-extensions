# Design

- **Publisher ownership.** pi-radar's baseline extension owns the registrar and presence. Herdsman requests the memoized runtime from `pi.events`, retries at `session_start` if the baseline loads later, and degrades to no Radar capability when none is present. Herdsman keeps an SDK `RadarClient` only to pass to `launchRadarWorker`.
- **Child identity.** A child is its `subject_id`, an opaque string. Registration and claim ids never enter spawn entries, provenance or controls. Old entries are not migrated.
- **Readiness.** `ready` is Radar's granted first presence. `failed` releases admission; `unresolved` keeps its request id and is never retried under a new one. Herdsman's startup acknowledgment and launch generation are removed. Waiting for the ready child's own mailbox state is application initialization, not a second readiness verdict; assignment acceptance is a separate concern.
- **Control.** `children.list/observe/inspect/assignment/retire/restart/close` replace raw-client child control. Continue uses `launchRadarWorker` with `continues`. Restart uses `children.restart`, never close followed by continue; a refused restart leaves the mailbox and held assignment intact. Close retries reuse their durable request id.
- **Observations.** Recurring reads use one paged `children.list("all")` for launches backing current mailboxes. History remains available for continuation but produces no recurring reads. Missing subjects and failed pages are unknown, not gone.
- **Baseline activation.** Nix exposes `radar` as a plugin and the default build selects it with Herdsman. Dependency staging alone does not activate a registrar. Child launch and restart explicitly load the package's baseline entry even when optional extension discovery is disabled.
- **Lost capability to raise upstream.** The baseline does not pass the questionnaire blocking event or a managed binding to the execution adapter that Herdsman previously supplied.
- **Tests.** Test Herdsman's use of typed Radar ports, not the SDK or daemon implementation. An isolated real-daemon join checks the SDK and Herdsman's handoff adapter without touching the operator's daemon. Full Pi worker / agent_complete acceptance and deployment remain the operator's step.

## Suite ownership audit

Remove direct SDK launch, presence, location, inspection and close-guarantee tests. Radar owns registration, presence grants, readiness deadlines, binding, process verdicts, pane identity, broker durability and operation replay. Remove tests of the fixture's own mailbox consumer and of the retired startup acknowledgment or binding sidecar.

Retain Herdsman's decisions given those answers: correct launch inputs, subject storage, unresolved-label reservation, continuation selection, request addressing, completion dispositions, persist-before-ack, unread-result protection, delivery retry, subtree ownership, cascading cleanup, role/tool exposure, prompt transport and soft-deadline delivery. Preserve these even when their old fixtures fail. Duplicate scenarios may be consolidated only when the retained test exercises the same owned branch.

The first deletion pass incorrectly removed owned recovery, roster, inspect-presentation and question-delivery cases along with legacy fixtures. Those cases were restored; their fixture migration remains open. No failing case is removed merely to make a suite pass.
