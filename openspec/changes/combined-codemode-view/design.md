## Integration

Observe nested tool_execution_start/update/end using parentToolCallId and execution IDs. A per-root capture owns start-order records, not source statements: loops and parallel calls retain distinct rows. Register codemode renderers through registerToolRenderer, leaving execution untouched. The collapsed call slot yields to the combined result slot once execution starts; expansion retains Pi's source and script-output renderer.

## Data and storage

Pi does not persist nested results. Keep a bounded display record on the root result (kendexCodemode), containing short targets, status/timing, bounded output previews, integer mutation summaries and original edit patches. This preserves expanded diffs after resume without inventing changes from requested arguments. Per-call patch limit 64 KiB; total serialized display metadata limit 128 KiB; at most 128 retained calls. Omitted data carries a notice. Never store before/after content or computed diff line arrays. Active capture is released at root end and session shutdown. Live output is redrawn through the parent render context's invalidate callback.

## Presentation

Edits show path and actual counts, or a failure; expanded rows derive and cache structured diffs from original patches using the existing renderer. Non-edit calls use short key arguments and bounded result previews. Root script output remains separate because it can combine or transform nested results. Native output rendering retains image handling, errors and output-file notices. Old sessions without capture use Pi's runtime call summaries without guessed diffs.

## Prior art

pi-codemode-compact demonstrates the resolver seam and deferring source to expansion. pi-codemode-diff demonstrates nested-event capture keyed by root, including original edit patches. @npm-ken/pi-codemode-ui uses acorn for pseudocode; runtime call rows do not require a parser. No source is copied from these projects.
