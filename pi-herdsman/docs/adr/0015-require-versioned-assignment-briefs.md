# Require versioned assignment briefs

## Decision

Every fresh `agent_delegate` assignment, `agent_continue` assignment, and eligible `agent_interrupt` replacement carries a complete `delegation-brief/v1` Markdown document. Admission validates the version, required common fields, selected role profile, and bounded structure before creating a pane, request, or advisory deadline. Plain task sentences are rejected with field-specific diagnostics.

The common profile requires an objective, context summary and inputs, allowed and excluded scope, constraints, acceptance criteria, and a response requirement. Built-in role profiles add fields; custom definitions use the common profile unless configured more strictly. Empty lists and an explicit no-context declaration remain visible rather than being inferred.

Brief context inputs are validated as strict text and snapshotted privately when the assignment is accepted. The accepted normalized brief and snapshot identities are bound to the request and revalidated by the worker and recovery path. `files` remains a separate channel for additional evidence. Steering and owner replies stay free-form because they do not establish a new assignment.

The brief's response requirement selects role defaults or an explicit response contract, but does not replace the incoming assignment contract.

## Rationale

A typed brief makes scope, context, constraints, and acceptance observable at the boundary where ownership transfers. A common versioned structure permits deterministic admission and targeted diagnostics while role profiles retain discipline specific to research, investigation, execution, and review. Snapshotting prevents a later file edit from silently changing the accepted assignment during worker startup or recovery.

## Alternatives rejected

- Plain prose-only task strings: they leave scope, context, and acceptance implicit and cannot be reliably validated before mutation.
- One unrelated schema per role: it duplicates common assignment semantics and complicates custom definitions.
- Re-reading context paths after acceptance: a changed file would alter the meaning of an already-accepted request.
- Requiring briefs for `agent_steer` and `agent_reply`: these operations do not transfer or replace assignment ownership.

## Consequences

- Existing callers and examples must send valid Markdown briefs; no automatic migration or prose wrapping occurs in production.
- Role defaults and tool guidance must publish the required profile and response behavior.
- Admission, recovery, and tests must preserve and verify the same normalized brief and private snapshot identities.
- The request keeps a stable brief hash for diagnostics and provenance.

## See also

- [Response contracts](0016-validate-results-against-response-contracts.md)
- [Handoffs and files](../guides/handoffs.md)
- [Agent tool reference](../reference/agent.md)
