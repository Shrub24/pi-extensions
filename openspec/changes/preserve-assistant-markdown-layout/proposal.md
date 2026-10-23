# Proposal

## Why

Assistant Markdown can lose its intended layout when the renderer wraps already-wrapped lines a second time. This strands short words, distorts box-drawn tables, and can break the full-width background on styled code blocks; the output should remain readable at the actual viewport width.

## What Changes

- Recognize supported Unicode box-drawn tables in assistant output and render them readably when their grid cannot fit the viewport, without changing the stored message.
- Prevent the assistant gutter from rewrapping content that Pi or the styled-code renderer has already laid out; reserve gutter width before the initial render instead.
- Preserve the intended full-row background on styled code blocks when assistant gutter styling is enabled.
- Leave ordinary Markdown tables to Pi's existing renderer. Keep wrap-aware clipboard behavior and the separate thinking-panel background issue out of scope.

## Capabilities

### New Capabilities
- `assistant-message-layout`: Responsive assistant Markdown layout, including box-drawn tables, gutter spacing, and styled code-block backgrounds.

### Modified Capabilities

None.

## Impact

- `pi-tool-renderer/extensions/tool-renderer/messages.ts` and its message/code-block rendering tests.
- Renderer documentation for assistant message styles if the supported behavior or settings description changes.
- No new dependencies or changes to message content, Pi's clipboard behavior, or the thinking-panel renderer.
