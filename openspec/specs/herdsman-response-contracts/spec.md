# herdsman-response-contracts Specification

## Purpose
Enforce the response and artifact requirements of each assignment while allowing the orchestrator to tailor those requirements independently of the mandatory delegation brief.

## Requirements

### Requirement: Per-assignment response requirements

Each accepted assignment SHALL have an explicit effective response contract. Role defaults SHALL provide a starting point; validated orchestrator overrides SHALL control response format, required Markdown sections/metadata and whether an artifact file is required. The resolved contract SHALL be stored with the request and provided to the worker. It MUST NOT be inferred from a prose mention or inherited from an earlier assignment.

#### Scenario: Short inline answer
- **WHEN** the orchestrator requests a plain inline response with no file
- **THEN** a conforming short answer is accepted without imposing a report file or generic handoff sections

#### Scenario: Required report file
- **WHEN** the orchestrator requires a Markdown artifact at a specific path with particular sections
- **THEN** those requirements are presented to the worker and checked before successful publication

#### Scenario: Role default override
- **WHEN** a valid request overrides the role's default response requirements
- **THEN** the accepted override governs only that assignment while its mandatory briefing requirements remain unchanged

### Requirement: Structural and artifact enforcement

Before publishing a completed assignment result, the system SHALL validate the requested inline or file response, required structure and artifact presence. Required artifacts SHALL be regular files at the declared permitted paths; validation SHALL not accept arbitrary paths advertised by the worker, missing files, symlink escapes or stale artifacts as newly produced work. Reuse of an existing artifact SHALL require explicit permission in the response contract.

#### Scenario: Missing artifact
- **WHEN** the worker concludes but its required artifact does not exist
- **THEN** no completed result is accepted and the owner receives a precise contract failure

#### Scenario: Missing required section
- **WHEN** a required Markdown section is absent
- **THEN** validation reports that section instead of accepting a generic done message

#### Scenario: Stale artifact
- **WHEN** a required output merely points to a pre-existing artifact without declared reuse permission
- **THEN** it is rejected as evidence of a newly produced deliverable

#### Scenario: Permitted reuse
- **WHEN** the response contract explicitly permits an existing artifact and it passes the declared checks
- **THEN** the manifest records it as reused rather than newly produced

### Requirement: Failure is explicit and repair is owner-driven

Invalid responses SHALL produce a bounded failed-result record with typed field/path errors and available diagnostic evidence. They MUST NOT be silently treated as completed or trigger unlimited automatic repair turns. The owner SHALL be able to request a corrected assignment through the ordinary validated admission path.

#### Scenario: Invalid final response
- **WHEN** a final response fails its accepted contract after outstanding work is resolved
- **THEN** the assignment resolves once as failed with actionable validation diagnostics, not as a successful handoff

#### Scenario: Explicit correction
- **WHEN** the owner submits a valid correction assignment
- **THEN** the worker can repair the response under that assignment's stated requirements without implicit background retries

### Requirement: Framework-owned provenance

The result envelope SHALL carry framework-owned request, process/run and worker-session identities and observed artifact paths/hashes. Model-authored claims about tests or evidence SHALL remain distinguishable from observed execution/artifact records. A schema-valid assertion of passing checks MUST NOT itself certify that those checks ran or passed.

#### Scenario: Claimed identity mismatch
- **WHEN** a worker response claims a different request or session identity
- **THEN** the trusted result identity remains the actual accepted request and worker identity

#### Scenario: Claimed test pass
- **WHEN** a Markdown response claims tests passed without observed execution evidence
- **THEN** the claim remains model-authored rather than being labelled a verified check
