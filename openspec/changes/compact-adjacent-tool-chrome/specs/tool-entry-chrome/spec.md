# Spec Delta

## Purpose

Keep consecutive tool calls visually distinct while reducing repeated full-width chrome and blank rows around their entries.

## ADDED Requirements

### Requirement: Consecutive tool entries share one outline with a rule between calls
In outline chrome mode, a consecutive run of visible tool-call entries SHALL render as one outline: a rule above each entry, which separates consecutive calls, and one bottom rule after the last entry. Each entry's title, status, and content SHALL remain in its original order and visibly associated with that entry.

#### Scenario: Several tool calls are adjacent in the transcript
- **WHEN** two or more visible tool-call entries are consecutive with no non-tool transcript entry between them
- **THEN** each entry has a rule above it, so a rule separates every pair of consecutive calls
- **AND** only the last entry has a bottom rule
- **AND** no blank row is inserted between entries
- **AND** each tool entry retains its own heading and content

#### Scenario: An ordinary message separates tool calls
- **WHEN** a non-tool message appears between two tool-call entries
- **THEN** each tool-call run receives its own outer top and bottom rules
- **AND** the ordinary message remains between the runs

#### Scenario: One tool entry is isolated
- **WHEN** a visible tool-call entry has no adjacent visible tool-call sibling
- **THEN** it retains both its top and bottom rules and the existing surrounding spacing

#### Scenario: A tool entry renders no rows
- **WHEN** an adjacent tool-call component is hidden or renders no visible content
- **THEN** it does not create an empty boundary or split the visible run

#### Scenario: Chrome mode is not outlines
- **WHEN** tool chrome is off or transparent
- **THEN** sibling grouping does not add or remove rules, rows, or content
