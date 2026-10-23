# Design

## Context

See `proposal.md` for motivation and `specs/assistant-message-layout/spec.md` for observable behavior. In `pi-tool-renderer`, `spacedAssistantRender` currently calls Pi's assistant renderer at the full width, then `assistantTextGutterLines` wraps each rendered line again to make room for the `agent` or `bar` gutter. Styled code blocks are already wrapped, padded, and backgrounded before that pass. Pi's `MarkdownTransformer` receives the assistant message type and available width. Box-drawn tables are plain text to Pi's Markdown renderer.

## Goals / Non-Goals

**Goals:**
- Allocate width once for assistant content and its optional gutter.
- Adapt only well-formed box-drawn tables that cannot fit as grids.
- Keep styled code rows intact through gutter rendering and preserve their intended background extent.

**Non-Goals:**
- Replace Pi's Markdown renderer or alter ordinary GFM table behavior.
- Change persisted/model-visible assistant text, clipboard selection semantics, or thinking-panel rendering.
- Remove the `agent` and `bar` styles.

## Decisions

### Normalize narrow box-drawn tables before Markdown rendering

Use Pi's Markdown transformer seam for assistant content, which supplies the current available width. Recognize only complete, rectangular Unicode box tables with consistent column boundaries. Leave tables that fit unchanged; when the grid cannot fit, transform rows into compact header/value blocks before Pi lays out the Markdown. If detection is incomplete or ambiguous, leave the text untouched rather than corrupting arbitrary box art. This keeps width-sensitive transformation in the render path and avoids changing transcript content.

A custom renderer for every table was considered and rejected: Pi already renders Markdown tables correctly when they fit, so taking ownership of all table parsing would duplicate behavior unnecessarily.

### Reserve gutter width before rendering, not by rewrapping output

Compute the final content width from the available width, existing right-margin guard, and the selected gutter width. Render assistant Markdown at that content width, then add the visual gutter without applying a second text-wrap pass. Preserve blank lines and ensure special full-width rows are not narrowed or prefixed incorrectly. This keeps Pi responsible for normal Markdown wrapping and prevents already-rendered structures from being split a second time.

Keeping the current full-width render and truncating or selectively rewrapping its output was rejected: it cannot reliably distinguish soft-wrapped prose from code rows, table borders, or intentional line breaks.

### Preserve code-block row identity through background painting

Treat styled code-block rows as preformatted output rather than inferring them from an empty background ANSI prefix. Wrap and pad code once to the final code content width, preserve syntax styles, and ensure the generic assistant gutter path does not split the painted row. Detect the code-row background token and paint the gutter prefix with the same background so the tint spans the full row after width is settled. Prefer explicit row metadata for gutter allocation over matching theme-specific ANSI sequences; remove internal markers before returning terminal output.

## Risks / Trade-offs

- [A box-art detector may match decorative borders or malformed tables] → Require complete top/header/separator/bottom structure and consistent column boundaries; leave uncertain matches unchanged.
- [Changing width allocation can affect other assistant child components] → Add full-render regression cases for prose, code blocks, blank rows, thinking panels, and tool-call messages at multiple widths.
- [Theme ANSI sequences can reset backgrounds inside highlighted code] → Test with nested syntax styles and resets; assert visible row width and background coverage rather than exact escape-string snapshots.
- [Very narrow viewports may leave too little room for a grid or a label/value block] → Keep every emitted line within the available width and allow values to wrap beneath their labels.

## Migration Plan

No data migration or configuration migration is required. Existing `assistantMessageStyle` values remain supported; the dotfiles change to `plain` is a temporary smoke-test setting and is not part of the renderer behavior change. Rollback is reverting the renderer commit; no stored messages are rewritten.
