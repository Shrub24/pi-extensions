## Why

Copying from the terminal copies screen rows. Those rows are wrapped to the viewport and carry the assistant gutter, borders and tints, so a copied answer is not the text the assistant wrote. Pi's `/copy` copies only the last assistant message as raw markdown.

## What Changes

- Add a new `pi-copy-mode` package with a `/copy-mode` command and a `ctrl+shift+y` shortcut.
- The command asks which assistant message to copy from (newest first), then opens an overlay that shows that message's raw markdown source, one logical line per row.
- Keys: `j`/`k` or arrows move, `PgUp`/`PgDn` page, `g`/`G` jump, `v` marks the start of a range, `Enter` or `y` copies the marked range (or the current line when nothing is marked), `Esc` or `q` cancels.
- Copied text is the raw source lines joined with newlines, passed to Pi's exported `copyToClipboard`. It has no gutter, borders, tints or wrap breaks.

## Non-goals

- Mouse selection mapping and clipboard rewriting (a later change, reusing the same source model).
- Object-bounded selection (paragraph, code block) and per-block copy.
- Changes to Pi core or to `pi-tool-renderer`.
- Activation in the dotfiles; wiring the package into the Home Manager switch is a separate step.

## Impact

- New package `pi-copy-mode/` (extension, tests, README, changelog).
- Root `package.json` workspaces and test script, and `nix/npm-packages.nix` / `nix/recipes.nix` package lists.
