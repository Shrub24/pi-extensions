# @vanillagreen/pi-tool-renderer

Tool and message displays for Pi. It provides compact output, optional file diffs and a tool for grouped read operations.

![tool_batch composite result with Read/grep/Bash rows](https://raw.githubusercontent.com/vanillagreencom/kendex/main/pi-extensions/pi-tool-renderer/assets/tool-batch.png) ![Edit tool with side-by-side diff renderer](https://raw.githubusercontent.com/vanillagreencom/kendex/main/pi-extensions/pi-tool-renderer/assets/edit-diff.png)

> Extracted from [vanillagreencom/kendex](https://github.com/vanillagreencom/kendex). Reference remotes: `upstream` (kendex), `hisence` (credited efficiency patches); neither is tracked.

## Install

Requires Pi 0.99.0 or later for guarded batch execution.

- npm: `pi install npm:@vanillagreen/pi-tool-renderer`.
- kendex: add the declaration below to the project's `kendex.toml`, or to `~/.config/kendex/kendex.toml` for user scope. Run `kendex update-pi`.

```toml
[pi-extensions."@vanillagreen/pi-tool-renderer"]
source = "kendex"
```

Restart Pi after installation. Use `kendex update-pi --check` to preview the installation.

## Features

- Show compact tool rows with expandable output.
- Display file changes with side-by-side and word-level diffs.
- Group independent read operations into one result.
- Configure message layout and terminal symbols.

## How it works

Pi runs a tool and gives its call and result to the display extension. The extension formats those values using your settings. It shows a compact preview that you can expand. Optional diff views show changed files, and grouped read calls share one result display.

## Memory use

- User messages keep at most 256 weakly held Markdown layouts. Each keeps one width and at most 65,536 characters each of source text and rendered lines. Larger messages render without retention. The layouts do not keep message components alive and are cleared at session shutdown.
- Grouped tool calls are tracked only while `stackToolCalls` is on.
- At most 256 grouped calls are kept, in groups of at most 64; older groups are dropped. Each keeps at most 16,384 characters of its result for the preview: the start for read and search calls, the end for bash.
- A dropped call that Pi draws again (ctrl+o, a resize) is shown on its own and is not kept.
- Grouped calls and the list of tool displays to refresh are cleared when a session starts or ends. A tool display Pi no longer shows is not kept alive.
- Code blocks keep at most 120 highlighted results, keyed by language and source text. The entry count is capped, not the characters, so a few very large blocks are held until 120 newer ones displace them.

## Diagnostics

`/renderdebug` prints live draw diagnostics: frames in the last ten seconds, full redraws, render-time percentiles, and the assistant-gutter and tool-chrome cache hit rates. `/renderdebug reset` clears the counters.

`/renderdebug memory` prints memory instead. It reports `process.memoryUsage()` — `rss` is the whole Pi process, `heapUsed` is the JavaScript heap alone, and `external`/`arrayBuffers` cover off-heap buffers — and the live size of this package's strong stores: blink entries, the code-highlight cache's entries and characters, the stack store's items and kept result characters, and the built-in tool sets held per working directory.

The per-row render caches are `WeakMap`s keyed by Pi's own components. JavaScript cannot count a `WeakMap`'s live entries, so the report names them as not measured rather than showing a number that does not mean anything.

`/renderdebug memory gc` additionally runs a forced collection first, when the runtime exposes one (`Bun.gc`, or `global.gc` on a Node host started with `--expose-gc`), and prints the `heapUsed` change. Read that change as *reclaimed* heap — memory that became unreachable — never as this extension's retained set. Where no collector is exposed, the report says none was forced instead of showing a zero-byte result.

## Settings

The settings editor writes project values to `.pi/settings.json`. The default user file is `~/.pi/agent/settings.json`. `PI_CODING_AGENT_DIR` changes the user directory. Package values are stored under `kendex.extensionManager.config["@vanillagreen/pi-tool-renderer"]`.

Open `/extensions:settings`; settings appear under the **Tool Renderer** tab. Project settings in `.pi/settings.json` apply only after Pi marks the workspace trusted.

- `enabled`: package toggle.
- `glyphStyle`, `globalGlyphStyleOverride`, `treeStyle`: Unicode or ASCII symbols. The global override forces one style across every kendex Pi extension and leaves tool, model and user content alone.
- `registerBatchTool`, `batchMaxCalls`, `batchCallTimeoutMs`: the `tool_batch` tool and its limits.
- `readOutputMode`, `searchOutputMode`, `bashOutputMode`, `mcpOutputMode`, and the `*PreviewLines` and `bashLiveOutputDelayMs`, `bashLiveTailLines`, `bashCollapsedLines`, `commandPreviewChars`, `commandHeaderLines` budgets: how much of each result shows collapsed and expanded. Managed bash rows put status, task id, elapsed time and line count on their own header line, show the command beneath it, and expand to the full command plus the log path.
- `showReadImages`: images in `read` results; needs Pi's own `terminal.showImages` off.
- `renderMutationTools`, `splitDiffs`, `diffPreviewLines`, `diffExpandedLines`, `mutationCallPreview`, `mutationCallPreviewLines`, `shikiDiffs`, `wordDiffHighlights`, `diffBackgrounds`, `showDiffHunkMeta`: the edit and write diff view.
- Tool definitions may carry a short `intent` string (what the agent wants to achieve with the call). Unknown-tool rows display it after the summary; the classifier/drift-detection project reads the same field.
- `renderBashDiffs`, `renderVcsDiffCommandDiffs`, `applyPatchRenderer`, `applyPatchPreview`, `applyPatchPreviewLines`, `genericToolRenderers`: diffs and views for tools other than edit and write.
- `messageStamps`, `messageStampFormat`, `messageStampSeconds`: inline message timestamps (replaces the pi-stamp extension; no extra transcript rows).
- `compactUserMessages`, `userMessageTrailingBlankLine`, `compactCompactionMessages`, `compactSkillMessages`, `alignAssistantMessages`, `assistantMessageStyle` (`plain`/`bar`/`agent`), `assistantMessageMarker`, `assistantTurnRule`, `thinkingPanel`, `styledCodeBlocks`: message rendering. `agent` labels assistant text with a Nerd Font robot by default and hangs the block on its indent; `assistantTurnRule` closes the turn with a muted rule. `thinkingPanel` boxes assistant thinking blocks in a backgrounded section with a heading; thinking stays click-to-toggle.
- `toolChrome`, `fileHyperlinks`, `rightMarginGuard`, `pendingStatusAnimation`, `workingIndicator`, `maxLineWidth`: borders, OSC 8 file links and the hard cap on one rendered line. Set `fileHyperlinks` to `off` for terminals with slow link parsing.
- `stackToolCalls`, `stackChildDisplay`, `hideStackChildRows`: the stacking of consecutive native tool calls.

Maintainer notes are in [DEVELOPMENT.md](DEVELOPMENT.md).

## Fork delta

This package is a fork of kendex `pi-extensions/pi-tool-renderer`, kept current
through upstream `#3312`. The fork's own features, all in `extensions/tool-renderer/`:

- **Intent argument** (`intent.ts`) — read/edit/write/search rows accept an
  `intent` parameter describing why the tool is called; the renderer shows it on
  the tool row and batches carry it through to guard rules.
- **Managed bash row** (`managed-bash.ts`) — a dedicated renderer for the
  background-task bash tool, including the deferral interop guard that keeps
  pi-bash-processes rows stable across upstream's tool-registration timing.
- **Panel chrome** (`chrome.ts`, `settings-revision.ts`) — panel-mode rendering
  with revision-based cache invalidation shared across the renderers.
- **cbm/fff adapters** (`cbm.ts`, `fff.ts` and their `-patch` wrappers) —
  first-class rows for codebase-memory and fff tools.
- **Stamps** (`stamps.ts`) — marker decorations on rendered rows.
- **Structured content forwarding** — the `piToolContract` spread forwards
  `outputSchema`/`structuredContent` so Pi 0.99 codemode sees structured results
  through the wrapped tools (upstream fixed the same defect as KEN-2231; our
  forward predates it).
- **Bash failure verdicts honour `isError`** — the row derives failure from Pi's
  own `context.isError` rather than re-parsing output text for an exit code.
- **Registration deferred to `session_start`** — the bash tool registers after
  the session starts so earlier extension registration order cannot shadow it.
