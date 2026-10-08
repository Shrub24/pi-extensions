# Compact a managed worker's context at a fixed budget

## Decision

Pi Herdsman compacts a managed worker's context itself, at a fixed token budget
rather than at a reserve below the model's window.

The budget is the `workerContextBudgetTokens` configuration value (default
200000), bounded by the model's window minus a fixed reply reserve so that a
window smaller than the budget still compacts early enough to leave room for an
answer. A worker whose reported context reaches its budget is compacted at the
end of a turn that called a tool, and only there: such a turn is followed by
another one, whereas a turn that produced an answer has nothing to continue and
a result that would be settled from the history a summary replaces.

The compaction is requested through Pi's manual compaction, carrying the
`__pi_vcc__` marker, so the summary is produced by whichever summarizer the child's
Pi configuration loads for `session_before_compact`. Manual compaction aborts
the running operation, and Pi reports that run as aborted on `agent_settled`;
Herdsman reads that report rather than inferring the abort from which boundary a
run reached. The settlement of a run this worker's own compaction aborted
publishes nothing while its continuation is still pending, and once the
compaction completes the same assignment continues with a follow-up message that
triggers a new turn. That hold is released by the settlement which ends the
aborted run, not by the send of the continuation: both orders are reachable, and
a hold released on send would let the aborted run's later settlement publish the
very turn the compaction replaces. An aborted run with no such continuation pending is still
judged as the answer it is: an abort ends a turn, it does not cancel the
assignment, and withholding it would leave the assignment held with no wake. The
session classification and Agent-definition entries are re-asserted afterwards,
because a summary replaces the history those entries live in.

That continuation is sent only while the assignment that requested it is still
active. A compaction can commit after the assignment has settled its result — the
observed incident recorded exactly that order — and a continuation sent then
resumes a worker that has no request to answer, unsupervised, while anything
published from that turn retracts or duplicates a result the owner already has.
When the requesting request id is no longer the active one, the continuation is
withheld, the settlement hold the request installed is cleared, and the skip is
recorded as a durable `pi_herdsman_state_compaction_continuation_skipped` entry
naming the request and its reason, so a worker that never resumed is diagnosable
from the session's own records.

The marker must be pi-vcc's `PI_VCC_COMPACT_INSTRUCTION`, not the `/pi-vcc`
command name. In pi-vcc 0.9.0, an unrecognized instruction is treated as a
follow-up prompt and sent as a user message after compaction. That adds a second
resume turn alongside Herdsman's continuation and can wake an already-settled
worker. The marker keeps summarization silent; Herdsman alone owns continuation.

One assignment may be compacted and continued at most three times, so a worker
whose summary leaves it over budget cannot compact without end. Context
retirement and an unknown token count both suppress compaction entirely.

Pi's own threshold compaction remains disabled for this deployment, and a lower
settle-time trigger is deferred until the turn-boundary behaviour has been
observed in a live pane.

## Rationale

The failure this addresses was observed, not theoretical. On a 272k-token
window, the model route clamps the completion budget as the prompt approaches
the window and answers with a single token and a `length` stop: an empty
generation, not a truncated reply. Because Pi's threshold compaction is disabled
in this deployment and the installed summarizer had nothing to act on, the worker
kept its oversized context, spent its response-correction budget on the empty
generations, and finally published a response-contract failure while it was
still working. The context has to shrink before the ceiling, not after it.

A fixed budget is the honest expression of the requirement. The purpose is a
lean working context for the whole assignment: the operator has deliberately
turned Pi's preventive threshold off, and a worker should not carry the maximum
its window allows into its next step. The budget is also the value an operator
can reason about and set, whereas a window-relative reserve is a property of the
route's advertised context length. The window bound is kept because it is the
property the earlier design got right: a model with a smaller window must compact
earlier, or the route's clamp returns an empty generation.

The turn boundary is the earliest place where this can be done safely. Pi emits
`turn_end` after the assistant turn and all of its tool results have been
persisted, so nothing of the current step is lost when the operation is aborted,
and a tool-call turn is one the loop would have continued anyway. Any earlier
boundary would cut work in progress.

Letting the loaded context stack summarize, rather than vendoring a summarizer,
keeps one owner for that behaviour: the child build already carries the
summarizer that owns `session_before_compact`, and a vendored copy would be a
second implementation in the same process, drifting from the compiled one.

## Alternatives considered

- Compact only a settled worker (the previous design): rejected on its own,
  because it compacts between assignments and leaves a long assignment to reach
  the window clamp mid-turn. A lower settle-time trigger for the lean-context
  case is deferred rather than rejected.
- Rely on Pi's threshold compaction (`compaction.enabled` plus a reserve):
  rejected because the setting is global to the process, so it would also govern
  the operator session, which is compacted by its own context stack.
- Reuse the in-process child budget that pi-subagents applies through
  `SettingsManager.applyOverrides`: impossible for a worker, which is a separate
  Pi process. Pi exposes no settings write to an extension, no CLI flag and no
  environment variable carries a compaction setting, and a project settings file
  would govern the lead in the same working directory.
- Vendor the summarizer, as pi-subagents did for its in-process children:
  rejected because this deployment's child build already loads it, and the
  vendored copy would compete with the compiled one.
- Chain a compaction draft from the turn boundary (`compaction` with
  `continue: true`): rejected because Pi appends that draft's summary directly
  and does not emit `session_before_compact`, so the installed summarizer would
  be bypassed.
- Ask the route for a smaller advertised window per role: rejected because a
  per-model reserve can shape Pi's threshold but cannot enable it, and this
  budget is the worker policy Herdsman owns rather than the provider's limit.

## Consequences

A worker's context now shrinks mid-assignment, so its working continuity is a
summary plus the retained tail. Judgments that read session entries must rely on
entries that survive a compaction: the identity entries are re-asserted, and
delivered-result evidence is read from live child state.

Every compaction costs one extra model turn for the continuation, bounded by the
per-assignment cap.

An assignment that previously died at the route's clamp now continues on a
compacted context. The clamp classification stays in place for the cases the
budget cannot cover, such as a single turn that crosses the window.

The trigger is exercised by the runtime tests against the fake Agent (budget,
answered turn, unknown usage, in-flight compaction, the per-assignment cap, a
window smaller than the budget, context retirement, a compaction that cannot
start, and a compaction that commits after its assignment settled), and remains
to be observed live: a real worker crossing its budget in a pane, and the
worker's context reading in the widget afterwards.
