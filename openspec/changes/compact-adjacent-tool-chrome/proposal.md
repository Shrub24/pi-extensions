# Proposal

## Why

In `toolChrome: "outlines"`, each adjacent tool-call entry gets its own full-width top and bottom rule. A burst of calls therefore consumes many rows on repeated borders, obscuring the sequence and leaving less room for the results.

## What Changes

- Treat consecutive visible tool-call entries in the transcript as one visual chrome run: one outer top rule and one outer bottom rule, with each call's existing heading, status, and content retained inside.
- Remove the repeated separator spacing between entries in a run; keep the normal spacing outside the run, before the first tool and after the last.
- Keep isolated tool entries, hidden/empty entries, and non-outline chrome modes behaving as they do now.

## Capabilities

### New Capabilities
- `tool-entry-chrome`: Compact visual boundaries for adjacent tool-call entries without merging their content or identity.

### Modified Capabilities

None.

## Impact

- `pi-tool-renderer/extensions/tool-renderer/chrome.ts` and tool-chrome tests.
- The Pi TUI `Container.render` interception will use the parent container's ordered children to identify consecutive `ToolExecutionComponent` siblings; no Pi core patch or new dependency is intended.
- No tool-call data, execution order, message contents, or clipboard behavior changes.
