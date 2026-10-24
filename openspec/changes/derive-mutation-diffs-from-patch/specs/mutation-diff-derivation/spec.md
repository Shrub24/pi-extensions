# Spec Delta

## Purpose

Define how mutation rows obtain their diff, and bound what a mutation result may persist.

## ADDED Requirements

### Requirement: Mutation results persist integers, never diff rows
An `edit` or `write` result SHALL persist only integer metadata about the change, plus a created flag for writes. It SHALL NOT persist materialized diff rows or file contents. An `edit` persists the file's line count; a `write` persists its additions, removals, hunk count and line count.

#### Scenario: A large multi-hunk edit is committed
- **WHEN** an `edit` applies a change that spans several hunks of a 12,000-line file
- **THEN** the stored result contains no row list
- **AND** the stored payload for that result stays within a few hundred bytes regardless of the file's size

#### Scenario: A write replaces a whole file
- **WHEN** a `write` replaces the contents of a file
- **THEN** the stored result contains the integer summary only, no rows and no contents

### Requirement: Edit rows are derived from the unified patch at render time
An `edit` row's diff SHALL be derived from the unified patch Pi stores on the result, parsed when the row renders. Rendering SHALL NOT read the file from disk.

#### Scenario: Live and resumed edit rows render identically
- **WHEN** the same `edit` result is rendered during the session and after the session is resumed
- **THEN** both renders show the same additions, removals, hunk count, line numbers and content rows

#### Scenario: The change has several hunks
- **WHEN** a patch contains several hunks separated by unchanged regions
- **THEN** each unchanged gap is shown as a single collapsed separator that accounts for its skipped lines
- **AND** the trailing unchanged region after the last hunk is accounted for by the stored line count

#### Scenario: A result has no patch
- **WHEN** an `edit` result carries no unified patch, such as a failed edit
- **THEN** the row renders its failure state and no diff rows

### Requirement: A write row renders from its summary
A `write` row SHALL render from the stored integer summary and the written line count, because Pi persists no patch for a write.

#### Scenario: Resumed write row
- **WHEN** a `write` result is rendered after a session resume
- **THEN** the row shows the file path, the written line count and the stored additions/removals
- **AND** no diff rows are shown

### Requirement: Diff computation is bounded
Any diff computed from two texts SHALL run under a time budget and SHALL degrade to counts rather than block or exhaust memory.

#### Scenario: Two unrelated large files are compared
- **WHEN** a preview compares two large texts with almost nothing in common
- **THEN** the computation stops at its budget
- **AND** the row reports the change without row detail instead of waiting for the diff to finish

### Requirement: Multi-hunk changes report only changed lines
The diff of two texts SHALL report the lines that actually changed, including when the changes are far apart in a large file.

#### Scenario: Two one-line edits far apart
- **WHEN** two single lines 6,000 lines apart differ between the compared texts
- **THEN** the diff reports two changes, not the whole span between them
