# Validate results against response contracts

## Decision

Each accepted assignment has an immutable outgoing response contract resolved from its effective role default or an explicit `response-contract/v1` override in the assignment brief. The contract is independent of the incoming delegation brief and governs inline text, a workspace artifact, or both; it may also require Markdown sections and registered structured metadata.

Before publishing a successful final result, Herdsman validates the actual worker response and any requested artifact. Artifact validation proves canonical containment and file identity, rejects unsafe or stale outputs, enforces byte limits, and checks the declared format and required structure. A pre-existing target is reusable only when the contract explicitly permits it and the file matches the recorded baseline. Invalid output becomes one terminal `invalid_response` or `artifact_error` result with bounded diagnostics; Herdsman does not silently repair or reprompt the worker.

The result retains framework-owned provenance: accepted brief and contract hashes, worker session identity, text origin, and observed artifact path, canonical identity, hash, size, and created/reused disposition. This provenance attests to output structure and artifact identity, not the truth of model-authored claims or proof that claimed checks ran.

## Rationale

A worker can produce a well-formed assignment handoff without satisfying the requested deliverable. Separating incoming work from outgoing format requirements lets the controller impose a narrow artifact contract without changing the role's assignment profile. Validation before success prevents malformed or stale artifacts from being mistaken for completed work, while one-shot failure avoids an implicit and unbounded repair loop.

## Alternatives rejected

- Treating any non-empty final assistant text as success: this cannot enforce a requested artifact or response structure.
- Deriving the response contract from the brief profile alone: callers sometimes need a narrower format without changing incoming assignment requirements.
- Trusting worker-authored file paths, hashes, or validation claims: these are not framework observations.
- Automatically requesting a repair after validation failure: this changes a bounded assignment into an implicit multi-turn protocol and obscures the failed result.

## Consequences

- Role definitions need explicit defaults for the expected response shape.
- Explicit artifact contracts must name a safe target and define whether a baseline file may be reused.
- Consumers can distinguish `completed`, `invalid_response`, and `artifact_error` and inspect bounded field diagnostics.
- Documentation must distinguish observed output provenance from evidence that a factual claim is true.

## See also

- [Assignment briefs](0015-require-versioned-assignment-briefs.md)
- [Handoffs and files](../guides/handoffs.md)
- [Agent tool reference](../reference/agent.md)
