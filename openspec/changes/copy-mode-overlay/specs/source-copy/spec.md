# Spec Delta

## Purpose

This capability lets the user copy an assistant message's raw markdown source, selected by line range, without the terminal's wrapping, gutter, borders or tints.

## ADDED Requirements

### Requirement: Copy mode shows an assistant message's source
The copy mode SHALL present the raw markdown text of a chosen assistant message, one logical source line per row, and SHALL NOT present the rendered or wrapped form.

#### Scenario: A message is opened
- **WHEN** the user runs `/copy-mode` (or presses the copy-mode shortcut) and picks an assistant message
- **THEN** an overlay shows the message's text blocks as raw markdown source lines
- **AND** thinking blocks and tool calls are not included

#### Scenario: A message has no text
- **WHEN** no assistant message in the current branch has text content
- **THEN** copy mode reports that there is nothing to copy and does not open an overlay

### Requirement: Copy mode copies a marked source range
The copy mode SHALL copy the source lines from the mark to the cursor, inclusive, joined with newlines, or the current line when no mark is set, and SHALL close after copying.

#### Scenario: A range is marked and copied
- **WHEN** the user marks a line with `v`, moves the cursor, and presses `Enter` or `y`
- **THEN** the clipboard receives exactly those source lines with no gutter, border, tint or wrap break
- **AND** the overlay closes with a confirmation of the number of lines copied

#### Scenario: No mark is set
- **WHEN** the user presses `Enter` or `y` without marking
- **THEN** the current source line is copied

#### Scenario: The copy fails
- **WHEN** the clipboard write fails
- **THEN** the overlay stays open and shows the failure

### Requirement: Copy mode cancels without copying
The copy mode SHALL close without touching the clipboard when the user presses `Esc` or `q`.

#### Scenario: The user cancels
- **WHEN** the user presses `Esc` or `q`
- **THEN** the overlay closes and the clipboard is unchanged
