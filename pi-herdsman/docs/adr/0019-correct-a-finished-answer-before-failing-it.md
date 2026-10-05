# Correct a finished answer before failing it

## Decision

When a worker's final answer cannot be accepted, Herdsman asks that worker to fix it in its own session before publishing a terminal result. Two cases share one budget of **two corrections per assignment**:

- the reply ended on the model's output limit (`stopReason: length`), so there is no complete answer yet;
- a finished answer fails its response contract (`invalid_response`, `artifact_error`, empty text).

The correction is an ordinary visible follow-up message in the worker's transcript. It names the deficiency (the typed code and up to four field diagnostics) and tells the worker to fix exactly that without redoing finished work. Validation runs again, unchanged, on whatever the worker then produces. When the budget is spent the result is the same one-shot typed failure as before, carrying the last attempt's diagnostics. Only an answer the worker actually gave is corrected; a wait that resolved with no new answer is not.

This supersedes the part of [ADR 0016](0016-validate-results-against-response-contracts.md) that rejected reprompting after a validation failure. Everything else in 0016 stands: the contract is immutable, validation is framework-observed, and success proves structure and artifact identity, not the truth of claims.

## Rationale

A delegated worker is an expensive, context-loaded session. Failing it over a missing heading or an output-limit cutoff discards that context, spends a full owner model turn and a new brief on recovery, and surfaces as a worker that "just died" with a result the caller cannot act on. Most such misses are mechanical, and the worker can fix them in one cheap turn.

ADR 0016 objected that repair would be silent, unbounded and would not make a claim more true. A visible, capped correction is neither silent nor unbounded, and re-running identical validation means no guarantee weakens. Deficiencies that need judgement (scope disputes, a wrong approach, a question for the owner) never reach this path, since they are not contract failures.

## Alternatives rejected

- Keep failing at once and rely on the owner: the observed cost was real, with workers lost to a length cutoff before writing any text.
- Repair without a bound: an assignment would become an open-ended conversation.
- Retry at the provider layer: it cannot name a contract deficiency, and the worker's own transcript is the right place for a correction to be visible.

## Consequences

- A worker may take up to two extra turns before a failure is published; assignments that fail do so later.
- The correction prompts live in the worker's session log; the published result is unchanged.
- Corrections are not recorded on the result itself; add that if an owner needs to see that one occurred.

## See also

- [Validate results against response contracts](0016-validate-results-against-response-contracts.md)
- [Assignment briefs](0015-require-versioned-assignment-briefs.md)
