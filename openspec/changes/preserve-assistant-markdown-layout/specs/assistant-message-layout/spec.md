# Spec Delta

## Purpose

This capability keeps assistant output readable at the active terminal width while preserving deliberate structures such as gutters, tables, and styled code blocks.

## ADDED Requirements

### Requirement: Assistant content is wrapped only to its final available width
When assistant output uses a message gutter, the renderer SHALL reserve that gutter space before laying out content and SHALL NOT rewrap already-rendered lines afterward.

#### Scenario: A word falls at the gutter boundary
- **WHEN** assistant prose wraps near the available width with the `agent` or `bar` style enabled
- **THEN** adding the gutter does not strand a word on its own line or create a second soft wrap
- **AND** each rendered line remains within the viewport width

### Requirement: Narrow box-drawn tables remain readable
When assistant output contains a well-formed Unicode box-drawn table that cannot fit its grid within the viewport, the renderer SHALL present its headers and cell values in a readable layout that fits the viewport without changing the stored message.

#### Scenario: A box-drawn table is wider than the viewport
- **WHEN** a rectangular box-drawn table has columns wider than the available viewport
- **THEN** its rows and header-to-value relationships remain understandable without broken border fragments or over-width lines

#### Scenario: A box-drawn table fits the viewport
- **WHEN** a well-formed box-drawn table fits within the available viewport
- **THEN** it remains displayed as a table with its row and column structure intact

### Requirement: Styled code-block backgrounds fill their available rows
With styled code blocks enabled, the background SHALL extend consistently across each code row's available width, and assistant gutter styling SHALL NOT split or shorten that background through an additional wrap.

#### Scenario: A short code line has trailing row space
- **WHEN** a short code line is rendered with a non-plain assistant message style
- **THEN** its background continues across the available code-block row behind the padding spaces

#### Scenario: A code line wraps at the viewport boundary
- **WHEN** code exceeds the available width in a styled code block
- **THEN** it wraps within the available code-block width once, and each resulting row has a consistent background without extending past the viewport
