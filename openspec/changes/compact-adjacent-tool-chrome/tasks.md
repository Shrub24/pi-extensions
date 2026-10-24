# Tasks

## 1. Share outline boundaries across adjacent tool calls

- [x] 1.1 Add a parent-Container regression with three adjacent visible tool components and an intervening non-tool message; verify one top/bottom rule per consecutive run, preserved per-tool content/order, and no internal blank rows.
- [x] 1.2 Propagate first/last boundaries from direct visible ToolExecutionComponent siblings before child rendering; verify isolated entries keep both rules, hidden/empty components do not split runs, and non-outline modes remain unchanged.
- [x] 1.3 Include group boundaries in tool chrome cache invalidation; verify inserting/removing an adjacent transcript child updates the correct outer rules on the next render.
- [x] 1.4 Document the compact outline behavior and its scope in the pi-tool-renderer README; verify the setting description matches the implementation.

## 2. Validate transcript integration

- [ ] 2.1 Run focused tool-chrome tests and the full renderer test suite; verify new cases pass and record any unrelated existing failures separately.
- [x] 2.2 Bundle the pi-tool-renderer entrypoint and validate the OpenSpec change; verify the extension builds and all artifacts are valid.
