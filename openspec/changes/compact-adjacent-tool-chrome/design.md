# Design

## Context

Pi's interactive `chatContainer` is a `Container` whose ordered children include `ToolExecutionComponent` instances. Each component renders independently. `pi-tool-renderer` already patches `Container.render` and adds outline rules around each self-rendered tool component after removing its outer blank rows. See `proposal.md` and `specs/tool-entry-chrome/spec.md` for the motivation and observable contract.

## Goals / Non-Goals

**Goals:**
- Determine tool-run boundaries from the transcript parent's actual child order.
- Keep per-tool renderers, status, content, clicking/expansion, and call identity untouched.
- Change only `toolChrome: "outlines"` output.

**Non-Goals:**
- Merge tool result components, change execution behavior/order, or alter message content.
- Collapse tools separated by assistant/user/system messages or hidden components that contain no content.
- Change panel, transparent, or off chrome modes.

## Decisions

### Mark sibling boundaries from the parent container before rendering children

In the existing `Container.render` patch, inspect `this.children` before delegating to the original render. For direct visible `ToolExecutionComponent` children, identify contiguous runs and mark the first and last component. The tool's own patched render then adds a top rule only at the run start and a bottom rule only at the run end. Components with no rendered rows are excluded so they neither create blank boundaries nor break a run.

This uses the transcript's real order and requires no Pi core change. A global “previous tool” counter was rejected: rendering can revisit offscreen or cached components in a different order and does not reliably reveal transcript adjacency. Joining tool content into a single wrapper was also rejected because it would interfere with each component's mouse handling, expansion, and status state.

### Keep boundary state separate from component output cache

Store group-start/group-end flags on the tool component using a private symbol. The chrome render-cache key must include both flags so a run boundary changing after a new transcript child is inserted cannot reuse stale borders. A directly rendered tool component with no parent-assigned state defaults to an isolated run and retains both rules.

### Preserve existing omission for content-owned bottom borders

Every visible tool entry draws its top rule, so a rule separates it from the call above. Only the final tool in a run draws its bottom rule, and omits it when the core already contains a complete bottom border, using the existing check. Content-owned inner borders remain part of that call's output.

## Risks / Trade-offs

- [A non-transcript Container may contain adjacent tool components] → The same visual rule is still appropriate: only actual direct adjacent tool components form a run.
- [An empty tool component could accidentally separate a run] → Determine visibility from its current hidden state/rendered rows and ignore empty components when computing boundaries.
- [A new sibling changes cached boundaries] → Include boundary flags in the cache key and recompute flags on every parent render.
- [Nested or virtualized containers could make children order differ from visual order] → The patch only groups direct siblings in a single render pass; do not infer adjacency from global registration or call IDs.

## Migration Plan

No migration or configuration changes. Rollback is reverting the renderer change; the `toolChrome` setting and individual tool rows remain compatible.
