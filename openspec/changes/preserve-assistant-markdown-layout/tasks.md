# Tasks

## 1. Reflow narrow box-drawn tables

- [x] 1.1 Add fixtures from the reported box-drawn table plus a fitting table and malformed border art; verify tests distinguish all three cases and assert output widths against the supplied viewport.
- [x] 1.2 Add conservative width-aware handling for complete rectangular box-drawn tables; verify narrow tables retain header/value associations in a readable layout, fitting tables keep their grid, and malformed art remains unchanged.
- [x] 1.3 Document the supported narrow box-table behavior in the renderer README; verify the example matches the implemented transformation and the documented assistant style settings remain accurate.

## 2. Allocate assistant gutter width once

- [x] 2.1 Add an assistant-render regression for the `but the` boundary case at narrow and wide widths; verify no word is stranded by a second wrap and every emitted line fits the viewport.
- [x] 2.2 Reserve gutter width before the assistant content is laid out and remove the post-render rewrap; verify the regression and existing agent/bar gutter tests pass while markers and blank lines remain correct.
- [x] 2.3 Add styled-code regressions for short padded lines, long wrapped lines, and ANSI syntax resets under a non-plain assistant style; verify background coverage stays consistent across each code row and visible widths remain within the viewport.
- [x] 2.4 Preserve styled code-block row identity through gutter rendering and apply background at the final code-row width; verify the new background regressions pass without changing code contents or syntax styling.

## 3. Validate message-render integration

- [x] 3.1 Add or extend integration coverage for ordinary prose, standard Markdown tables, code blocks, blank lines, and thinking-panel rows at multiple widths; verify Pi-owned Markdown tables and excluded thinking-panel behavior remain unchanged.
- [ ] 3.2 Run the focused message-render tests and the full `bun test ./extensions/__tests__` suite; verify all new regressions pass and record any unrelated baseline failure separately.

Validation note: focused assistant-layout tests pass. The full suite reports 214 pass and 1 failure in `diff-border.test.ts` (missing expected `┬` divider); the same failure reproduces when that file runs alone and is unchanged from before this change. Task remains open pending resolution or explicit acceptance of that suite baseline.
