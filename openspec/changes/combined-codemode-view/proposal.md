## Why

Codemode shows dense JavaScript followed by truncated JSON summaries of the same calls. It obscures which file changed and whether each operation succeeded.

## What Changes

- Render one evolving row per actual nested execution, with tool, target, status and duration.
- Place bounded output beneath its owning call; edits show change counts collapsed and the existing diff view expanded.
- Keep source behind expansion and script-authored output separate from nested results.
- Capture bounded display metadata from execution events, including original edit patches, for resume. Never retain before/after snapshots or computed diff rows.

## Impact

Only pi-tool-renderer presentation and display metadata change. Tool execution, model-facing content, permissions and sandbox behaviour stay unchanged. No parser or new dependency is needed.
