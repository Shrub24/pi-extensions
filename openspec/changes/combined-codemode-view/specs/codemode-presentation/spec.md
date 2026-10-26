## ADDED Requirements

### Requirement: Combined runtime call view
Codemode SHALL present actual nested calls in execution-start order, with readable targets, individual status and output below the owning call. Raw JavaScript SHALL be available on expansion rather than occupying the collapsed preview.

#### Scenario: Parallel calls finish out of order
- **WHEN** multiple nested tools execute concurrently
- **THEN** their rows retain start order and each completion updates only its own row

#### Scenario: Script output combines results
- **WHEN** a script prints or returns transformed results
- **THEN** that output remains separate from individual nested outputs

### Requirement: Edit rows show actual changes
Collapsed successful edit rows SHALL show actual change counts when available. Expanded edit rows SHALL use the existing diff renderer on the actual returned patch. Failed edits SHALL display their error without showing the requested edit as successful.

#### Scenario: Edit completes and the session resumes
- **WHEN** a successful nested edit returned a patch within the display budget
- **THEN** expansion shows its diff live and after resume
- **AND** no before/after snapshot or computed diff rows are persisted

### Requirement: Bounded presentation metadata
Display capture SHALL preserve model-facing results and execution behaviour, bound retained data, release active state at root completion or shutdown, and identify unavailable details without reconstructing results from arguments.

#### Scenario: Display budget is exceeded
- **WHEN** nested results exceed the display budget
- **THEN** the UI reports omitted details while the tool result and file mutation remain unchanged
