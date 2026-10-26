# Tasks

## 1. Source model

- [x] 1.1 Add pure helpers that extract an assistant message's text blocks as source lines and list the assistant messages in a session branch, newest first; verify thinking-only, tool-only and empty messages are excluded and the list order is newest first.
- [x] 1.2 Add the range helper that turns a mark and cursor into an inclusive line range, and the copied text for it; verify reversed ranges, no mark, and single-line ranges.

## 2. Overlay

- [x] 2.1 Add the copy-mode view with cursor, mark, paging and cancel keys; verify each key moves or marks as specified and that `Enter` copies only through the injected copy function.
- [x] 2.2 Render each source line truncated to the overlay width with the cursor and marked rows visible; verify every rendered row fits the width and the cursor row stays inside the viewport while scrolling.
- [x] 2.3 Show copy failures in the overlay and keep it open; verify a failing copy leaves the view open with a message.

## 3. Command and shortcut

- [x] 3.1 Register `/copy-mode` and `ctrl+shift+y`; pick the message with `ctx.ui.select` when more than one exists; verify the no-message path notifies without opening the overlay.
- [x] 3.2 Wire the copied result into a confirmation notice; verify the notice reports the copied line count.

## 4. Packaging and docs

- [x] 4.1 Add the package manifest, workspace entry, root test script entry and Nix package lists; verify `bun run test` in the package passes.
- [x] 4.2 Add the README and CHANGELOG entries describing the keys and the scope; verify they match the implemented keys.
