# Validation and compatibility audit

Inspected 2026-10-22 against the working tree based on `e5b1486c`.
Runtime code and tests were not changed during this audit. Results below separate
reproduced defects, brittle assertions and unresolved reports.

## Notification patterns: purpose and remaining defect

`extensions/registrations.ts:165-170` exposes `notifyOnOutput` and
`notifyPattern`: a literal substring or `/regex/flags` gates output wakeups.
For example, `notifyOnOutput: true, notifyPattern: "listening"` wakes when a
server reports readiness; `/error|failed/i` can watch a test runner. The default
mode with a pattern is first-match-only. Exit notification is separate. Regex
matching is not command parsing, process supervision or completion detection.

`extensions/format.ts:74-109` compiles the regex once and computes the match
window. `extensions/background-tasks.ts:1821-1864` invokes it at output wake
dispatch, over retained output after `lastAnnouncedLength` plus 4 KiB overlap.

Two limits remain:

1. JavaScript regex execution is synchronous, with no execution deadline or
   pattern-length cap. A pathological pattern can block the extension event
   loop. A pattern-length cap alone cannot guarantee linear execution.
2. **Fixed 2026-10-22.** The earlier window change did not bound the scan in the
   production path: a rejected chunk left `lastAnnouncedLength` where it was, so
   each later check re-read all output since the last announcement, and a match
   re-delivered the rejected output in its `outputTail`. The no-match branch now
   advances the cursor, like the empty-output and suppressed branches already did.
   `tests/output-pattern-cursor.test.ts` drives the real output wake and failed
   before the change with `outputTail` of `noise-one\nnoise-two\nREADY`.
   One delta is still unbounded in size, so the regex execution hazard in (1)
   stands.

Direction (2026-10-22): notify-on-output is deprioritised. A watcher (Jev or
model) is expected to replace most of it, with a literal/regex watcher added
then if still wanted. Until then no pattern-size cap or regex engine change is
planned; if output wakes are dropped instead, the cursor fix stays valid for the
plain output path. A finite overlap cannot guarantee arbitrarily long
cross-chunk patterns, and no heuristic makes arbitrary JavaScript regex safe.

## Validation findings

### Bash schema: reproduced, descriptions only

Command:

    bun test pi-bash-processes/tests/bash-structured-output.test.ts

Observed: one failure and three passes. The failure at line 41 compares complete
schema objects. Field names, types and required fields match. Differences are:

- `output.description`: our generic truncation description versus the built-in
  head/tail and 1 MiB description;
- `full_output_path.description`: “Full output” versus “Temp file with the full
  output”;
- `truncated.description`: absent locally, present upstream.

Actual completed output, oversized head/tail output and signal-kill behaviour
pass in this file. This is not evidence of an incompatible structured result.
The earlier blanket label “Pi 1.2 schema drift” was insufficiently precise.

Suggested fix: test schema compatibility independently of documentation prose,
while retaining the behavioural output/truncation checks. Review our own
model-facing descriptions for accuracy; do not copy upstream limits if our
implementation differs. No runtime schema type change is established as needed.

### Renderer layout: full-suite failure plus a real cache defect

Commands:

    cd pi-tool-renderer && bun test
    bun test extensions/__tests__/user-message-layout.test.ts

Observed in this audit: full suite 207 pass/1 fail, twice; isolated file 3 pass.
The full-suite failure is line 33: reducing width from 60 to 40 did not increase
`highlightCode` calls. This assertion treats re-highlighting as proof of layout
invalidation, but highlighting may legitimately be cached across widths.
It does not directly test the rendered width/layout contract.

Separately, a deterministic probe establishes a production cache identity bug:
`extensions/tool-renderer/messages.ts:879-918` keys code highlights only by
language and source text, not the Markdown theme/highlighter. Calling
`__test.renderStyledCodeBlock` with the same unique code and two distinct
highlighters produced:

    FIRST theme:  highlighter calls = 1; output contains FIRST
    SECOND theme: highlighter calls = 0; output still contains FIRST

This is not a timing flake. Code highlighted under one theme can be reused under
another. `renderRawUserMessageLines` (`messages.ts:199-238`) checks outer theme
identity, but that does not fix the nested highlight cache.

Suggested fix: give highlights the correct theme/highlighter identity and an
explicit invalidation lifetime. Test observable rendered changes across themes
and host invalidation. For width changes, assert correct wrapping/width rather
than mandatory re-highlighting. The cross-file mechanism behind the suite-only
assertion failure has not been isolated; the cache probe does not prove it is
that failure's sole cause.

### Diff border: historical report, not reproduced in this audit

All three cases in `extensions/__tests__/diff-border.test.ts` passed in both
full renderer runs. They set global `COLUMNS` and render using `process.cwd()`
rather than an isolated settings world. Those are concrete dependencies worth
controlling, not proof of the earlier failure's cause. Do not mark the report
fixed or dismiss it as load-related without a reproducer.

### Completion batching: unresolved report, weak timing/isolation boundary

Command:

    bun test pi-bash-processes/tests/completion-dispatch.test.ts

Observed: 5 pass. The previously reported 5 s timeout did not reproduce here.
The file has one shared host across cases, a polling helper whose default budget
is 15 s and no explicit per-test timeout override. A default 5 s test timeout can
end a case before its own bounded wait finishes. Increasing it blindly would
not establish correctness.

The idle-batching test (`tests/completion-dispatch.test.ts:102-129`) also:

- configures `exitWakeBatchMs: 0` at file scope, despite its title claiming a
  single batched wake;
- explicitly permits separate or grouped deliveries;
- stops waiting once ANY new exit message exists, then checks BOTH task IDs;
- uses substring presence, not an assertion that each ID is delivered once.

That is a plausible partial-delivery race in the test oracle. It is not yet a
confirmed explanation of the historical timeout. Use a private host, a deliberate
batching window and a completion predicate covering every expected task. Assert
per-task delivery/acknowledgement, with controlled scheduling where practical.

The file also encodes held mid-run completion and repeating result-review
semantics, whereas the agreed direction is primary completion wakes queued as
steer during active runs and idle-only one-shot advisory result review. Coordinate
those changes with the lifecycle owner; the persistence migration must not
silently preserve an obsolete wake contract.

## Compatibility inventory and phase-out

This is a scoped inventory of inspected runtime names, not a claim that every
historical occurrence in the repository should be erased. Keep third-party
notices, copyright, import provenance and upstream issue references intact.

### Safe local cleanup

Rename local types/functions such as `kendexConfig`, `readkendexConfig`,
`kendexModalLock` and `acquirekendexModalLock`, comments and UI keys with all their
current callers. A TypeScript type name is NOT a cross-extension runtime
contract: the earlier suggestion that the type itself had to stay was wrong.
Generated CLI text in `extensions/pi-bg.ts:46,128` also still says kendex.

Systemd unit prefixes in `extensions/resource-control.ts:197,249` can change for
new tasks; preserve stored unit names for stop/reconcile of existing tasks.
The IPC directory (`extensions/settings.ts:91-94`) is process-scoped: new
processes may use the new name, while existing clients must continue using the
endpoint they were given rather than guessing a renamed path.

### Shared in-process registries: coordinate all participants

- Managed bash marker: `constants.ts:10` and renderer `tools.ts:54`.
- Modal lock: `constants.ts:11`, `render.ts:52-56`, renderer `overlay.ts:4`.
- Project trust: all four vendored `package-config.ts` copies, around line 137.
- Mini-dashboard stack: `stacked-widget.ts:36` and its fixture consumers.
- Renderer install/prototype-patch guards: `tool-renderer.ts:28`,
  `messages.ts:29-35`, `chrome.ts:36-39`, `overlay.ts:1`.
- Output-policy install guard: `output-policy.ts:10`.

A coordinated restart and package update permits a clean rename. If mixed old
and new packages in one process are supported, alias both symbol keys to one
object/guard for a transition; never create independent locks or trust maps.
Test duplicate installation and shared trust/lock behaviour. Do not add aliases
for hypothetical external consumers with no evidence they exist.

`activity.ts:29-81` is different: it consumes `kendex.pi.activity` from an
optional external publisher registry. Establish the deployed broker owner
before changing or removing it. Renaming only this reader silently loses events.

### Persisted formats: new writes, legacy reads

- Background custom state/event names: `constants.ts:6-7`; restore and message
  renderer registration in `background-tasks.ts:1275-1297,3069`.
- Router entries still retain the foreign scope:
  `pi-native-router/src/index.ts:72-82` names cache activity, thinking choice and
  physical pin. Preserve restore of user choices while switching writers.
- Diff result details: renderer `diff.ts:987` writes `kendexDiff` and
  `kendexDiffWasNewFile`; `tools.ts:242,294-298` reads them. Render old saved
  tool results with a legacy reader while new writes use owner-scoped fields.
- Output-policy details: `output-policy.ts:1089-1092` writes
  `kendexOutputPolicy` and `kendexOutputPolicySanitized`; update consumers without
  requiring old transcript rewrites.

Keep old event renderers/readers for historical sessions. Do not dual-write
full payloads merely to preserve old names. Lifecycle names can move with the
new persistence format.

### Filesystem paths and discovery boundaries

- Background sidecar: `persistence.ts:136-145` (migration in the persistence
  brief).
- Default logs: `settings.ts:47-49`; diagnostics independently use the old
  directory in `diagnostics.ts:11`. Output-policy knows the same default in
  `output-policy.ts:384-385`. Change these as one slice and honour existing
  absolute log paths.
- Output-policy artifacts: `output-policy.ts:170,1016` use
  `<agent>/kendex/sessions/...`; retain retrieval of old artifact paths and
  scoped old-root cleanup rather than orphaning files.
- `.kendex-lock.json`: `package-config.ts:124-130` treats it as a project-root
  stop marker. Removing it can change WHICH ancestor settings file is selected.
  This is a configuration/trust boundary, not a cosmetic rename. Add a boundary
  test and decide whether old kendex workspaces remain supported. The vendored
  pi-hooks fixture also uses this marker; do not rewrite vendor provenance as
  if the historical tool had a different contract.

## Recommended slices

1. Fix the schema assertion/documentation and the reproduced highlight-cache
   identity defect. Investigate completion scheduling with its actual oracle.
2. Local identifier cleanup and coordinated runtime-symbol rename, with the
   external activity broker explicitly checked.
3. Persistence rollout plus legacy sidecar/session reads and new lifecycle names.
4. New log/artifact roots, coordinated default-path consumers and old-root
   cleanup. Preserve absolute paths instead of bulk-moving live output.
5. Router entry/detail names with historical readers. Remove legacy readers only
   when the supported historical-session policy permits it.

No regex engine, persistence implementation or runtime-name migration was made
by this audit.
