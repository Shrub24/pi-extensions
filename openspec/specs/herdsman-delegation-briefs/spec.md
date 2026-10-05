# herdsman-delegation-briefs Specification

## Purpose
Require the orchestrator to supply a well-scoped, typed Markdown delegation brief, with enough task and role context to constrain worker discovery and execution.

## Requirements

### Requirement: Mandatory typed delegation brief

Every new delegated assignment SHALL have a schema-valid, versioned Markdown brief. The common contract SHALL require an objective, relevant context or an explicit no-context declaration, allowed and excluded scope, constraints, acceptance criteria and a response requirement. Lists that are intentionally empty SHALL be explicitly present. The orchestrator MUST NOT disable this common contract.

#### Scenario: Plain task text
- **WHEN** a caller submits only an unstructured task sentence
- **THEN** delegation is rejected with field-specific guidance before any pane, request or advisory window is created

#### Scenario: Incomplete context
- **WHEN** a brief omits its context or required scope information
- **THEN** validation identifies the missing fields and creates no assignment

#### Scenario: Small task
- **WHEN** a small task supplies a valid minimal brief with explicit scope and acceptance
- **THEN** it can delegate without requiring an output file or a verbose worker response

### Requirement: Role-specific briefing requirements

The effective worker definition SHALL select a briefing profile. Every profile SHALL include the common contract and SHALL enforce its required role-specific context. Built-in investigation, research, execution and review profiles SHALL be documented; custom definitions SHALL use the common profile unless they select a supported stricter profile. An assignment MUST NOT bypass its definition's profile by claiming a weaker one.

#### Scenario: Review baseline missing
- **WHEN** a review-profile brief omits its comparison baseline or review criteria
- **THEN** the assignment is rejected before launch

#### Scenario: Execution acceptance
- **WHEN** an execution-profile brief supplies the affected area, validation expectations and common fields
- **THEN** its normalized brief is accepted for that definition

#### Scenario: Profile downgrade
- **WHEN** a caller names the common profile for a definition that requires research context
- **THEN** the request is rejected instead of silently dropping research requirements

### Requirement: Context snapshots and admission consistency

Validated context references SHALL use the existing supported attachment/result-reference mechanisms and their snapshot, permission and size rules. The brief and its resolved response contract SHALL be bound to the accepted request. Owner-side and worker-side admission SHALL agree on the validated contract. A V5 task or interrupt request SHALL carry the definition's briefing profile, and the request boundary SHALL enforce that profile as the assignment's floor rather than accepting a weaker claimed profile; a request without a valid profile SHALL be rejected. Warm continuation with a new task and interrupt replacement when otherwise eligible SHALL require a fresh valid brief; recovery of an existing assignment SHALL use its already accepted contract.

#### Scenario: Warm continuation
- **WHEN** an idle retained worker receives a new task
- **THEN** the new brief is validated and bound to a new request without inheriting the previous task's scope or response overrides

#### Scenario: Missing referenced context
- **WHEN** a brief refers to an unavailable required context input
- **THEN** admission fails with a concrete reference error instead of directing the worker to rediscover it broadly

#### Scenario: Existing assignment recovery
- **WHEN** an accepted assignment recovers after restart
- **THEN** it retains the accepted brief and response requirements rather than resolving mutable current defaults again

#### Scenario: Weaker profile at the request boundary
- **WHEN** a task or interrupt request carries a definition brief profile that is stronger than the profile its accepted assignment claims
- **THEN** the request is rejected at the mailbox boundary instead of admitting the weaker claim

### Requirement: Canonical examples and useful errors

The same contract SHALL govern tool guidance, role defaults, accepted Markdown examples and admission checks. Unsupported schema versions, malformed metadata and incompatible role fields SHALL produce bounded, actionable errors. Validation establishes structural completeness, not that supplied context is true or that prose guarantees sound scope.

#### Scenario: Unsupported version
- **WHEN** a caller submits an unsupported brief version
- **THEN** it receives the supported version and invalid field paths with no execution side effects

#### Scenario: Documented example
- **WHEN** the documented example for a built-in profile is validated
- **THEN** it passes the same checks used for real delegation
