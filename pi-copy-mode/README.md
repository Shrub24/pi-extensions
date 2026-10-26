# pi-copy-mode

Copy the raw markdown source of an assistant message from an overlay.

Terminal selection copies the screen rows: wrapped to the viewport, with the assistant gutter, borders and tints in the text. Copy mode copies the message as the assistant wrote it.

## Use

- `/copy-mode`, or `ctrl+shift+y`, opens the message picker when the session has more than one assistant message. It lists the newest first.
- The overlay shows the message's text blocks as raw markdown source, one logical line per row. Thinking blocks and tool calls are not included.

| Key | Action |
| --- | --- |
| `j` / `k`, arrows | Move the cursor |
| `PgUp` / `PgDn` | Move by a page |
| `g` / `G` | First / last line |
| `v` | Mark the start of a range; press again to clear |
| `Enter` or `y` | Copy the marked range, or the current line when nothing is marked |
| `Esc` or `q` | Cancel without copying |

Long source lines wrap for display only; the cursor, marks and copies stay on whole source lines. Copied text is the source lines joined with newlines. It has no gutter, borders, tints or wrap breaks. A failed clipboard write keeps the overlay open with the reason.

## Scope

Copy mode only copies whole source lines by range. Mouse selection, object-bounded selection (a paragraph or code block) and copying a selection back as source are not part of this package.

## Install

The package is a Pi extension. It uses Pi's exported `copyToClipboard`, and `@earendil-works/pi-tui` for keys and truncation.
