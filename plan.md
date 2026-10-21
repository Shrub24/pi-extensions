# pi-herdsman and pi-bash-processes: outstanding work

Reviewed 2026-10-21. Supersedes the 2026-10-08 review; fixed defects and landed
slices from that one are dropped here and remain in git history.

Local `main` no longer tracks `upstream/main`. The forks report through
`scripts/upstream.sh`, whose commit count is an upper bound: three of the
eleven commits it calls untaken (KEN-2187, KEN-2242, part of KEN-2161) are
already in this tree by content.

## Follow-up briefs (2026-10-22)

- [Background-task persistence rollout](pi-bash-processes/docs/persistence-rollout-brief.md): scope, owner-store authority, legacy restore, retention and acceptance evidence.
- [Validation and compatibility audit](pi-bash-processes/docs/validation-and-compatibility-audit.md): notification-pattern cursor defect, exact schema mismatch, reproduced highlight-cache defect, unresolved test failures and runtime/storage name migration.

These findings supersede earlier claims that matching was bounded per chunk or
that the renderer/completion failures were proven load flakes. No runtime fix
was made in this audit.

## Settings: file-managed, no editor

Decided 2026-10-21: there is no in-session settings editor and nothing writes a
settings file from inside a session. Settings are the file, rendered by Nix or
edited by hand; only session- and process-local choices (such as hiding the
widget for this run) stay in memory.

The shared `package-config.ts`, carried byte-identical in `pi-bash-processes`,
`pi-output-policy`, `pi-tool-renderer` and `pi-tool-renderer`'s vendored
`pi-hooks` copy, now reads each package's own top-level key instead of walking
`kendex.extensionManager.config`. The manager's `settings-changed` event and the
`events` member it needed are gone; the 1 s read window plus the session
lifecycle is what applies an edit, so `installLiveSettingsRefresh` in
`pi-tool-renderer` now clears its cache and its tracked components at session
start and shutdown instead of refreshing on the event.

Done, all six packages (2026-10-21, `e5b1486c` on main): every package is named
after its directory, reads its own top-level settings key, and carries no
`@vanillagreen` scope, kendex settings schema, foreign author/repository
metadata or kendex asset links. `pi-bash-processes` inlines `intent.ts` and
treats the renderer as an optional peer for the presentation row only. The three
packages with their own readers (`pi-jev`, `pi-cbmem`, `pi-native-router`) read
`settings[<name>]` directly instead of walking the manager namespace.

The deployed dotfiles pin is bumped to that revision, with the four settings
blocks moved to top-level keys and the `extension-manager` extension row
dropped, so nothing in a deployed configuration reads or writes the manager
namespace any more.

Deliberately not renamed yet, because each needs one coordinated step rather
than a silent change:

- the `kendex.*` `Symbol.for` interop registry and `kendexModalLock` (symbol
  identity is the cross-extension contract; every extension must move together);
- `BG_STATE_TYPE` and `BG_MESSAGE_TYPE` session entry names (renaming orphans
  live session restore);
- the `kendex-pi-bg` default task directory (old trees in `/tmp` would be
  abandoned instead of pruned).

## Session persistence and idle work

Agreed posture (memory 6346): session entries are bounded transition records;
live state is memory; durable state is the owner's store written atomically on
transitions; counters are never persisted; finished history lives in the
owner's store under an explicit retention rule; caches are keyed by content
identity. Separate file per domain, not one shared database.

Measured state before the cleanup below: 88,824 full `kendex-background-tasks:state`
snapshots held 2.05M task records at 2.77 GB, 41% of 7.4 GB of session bytes,
of which repeated JSON keys were about 46%, `command` 20% and `title` 19%.
`cache-activity` was 151,458 records for 40 MB. Wake history was under 1%.

### Findings to fix

1. **Duplicate snapshot scan.** The status timer and the supervision timer both
   run every 2 s and each calls `managedAgentSnapshots` independently, so
   `scanAgentStates` (`extension/mailbox.ts:300`) performs a `readdirSync`, one
   `statSync` per entry and one `readFileSync` plus `JSON.parse` per mailbox
   twice per tick. That is 2N reads and 2N parses per second for N agents where
   N would do. Neither timer shares its result with the other.
2. **Entry rescan per tick.** `radarChildObservations`
   (`extension/index.ts:4144`) calls `sessionManager.getEntries()` and
   `radarSpawnFromEntries` walks the whole entry array on every tick, and the
   walk is repeated for `standingRadarLaunch`. Cost is O(entries) per tick with
   no I/O, so it grows with session length even though the transcript is never
   parsed. A spawn map cached against the last entry id removes it.
3. **Radar observation fan-out.** `radarChildObservations` observes every
   `radar-spawn` entry the session has ever recorded, not the live children:
   `radarSpawnFromEntries` (`:1217`) never prunes a launch when it closes or
   records an outcome, and `observeRadarChild` is called per spawn, with a
   possible second call through `gonePastUnproved`. At 1-3 live children the
   cost follows the session's launch history instead, so it grows over a long
   lead session.
4. **Persistence rollout.** `pi-bash-processes` still writes a full task
   snapshot per structural change (bounded at 64 KB and deduped by a
   fingerprint that includes volatile output fields), and Herdsman still
   rewrites `pi-herdsman-lead-state` and `pi-herdsman-agent-definitions`. Both
   are small in bytes today (Herdsman totals about 1.1 MB) but are the pattern
   the rules replace.

### Takes from upstream

- **KEN-2161 notification-pattern bounds (`dcaa634`), highest value.** Our
  `parseOutputMatcher` compiles once, then `background-tasks.ts:1832` runs
  `task.matcher(unseenOutput) || task.matcher(output)` per chunk against a
  buffer of up to `DEFAULT_OUTPUT_BUFFER_MAX_CHARS` (1,000,000 chars), with no
  execution bound and no pattern-size cap. The substring branch also allocates
  a lowercased copy of the buffer per chunk. A pathological pattern stalls the
  event loop in the extension that delivers wakes. Upstream bounds compilation
  and execution and reports an over-budget pattern once while keeping exit
  notifications. Its dashboard layout cache is cosmetic and lower priority.
- **KEN-2170 stat-before-read (`3eb8dc5`).** `diff.ts:970` checks
  `Buffer.byteLength(text) <= MAX_DIFF_INPUT_BYTES` after the text is
  materialised, so a large file is read in full and then discarded, per
  mutation render. Upstream stats first and takes edit diffs from
  `EditToolDetails.patch`. Verify `renderMutationTools`' default first.
- **Closed:** `#258` global session discovery is not applicable (our tree has no
  session-directory enumeration, and the fix edits `lead-runtime.ts` and
  `supervision.ts`, which this fork does not have). The pre-extraction upstream
  alignment is obsolete: its target is v0.19.1 plus two docs commits and it
  edits `index.ts` and `herdr.ts`, against an architecture whose Herdr half we
  removed and whose identity and transport moved to Radar. The adoption plan
  stays as provenance only. KEN-2344 shipped defaults, KEN-2779 and the kendex
  docs commits are deliberately not taken.

## Worker lifecycle (direction)

**Now (landed):** guidance and a delivery nudge. The lead contract, tool
descriptions, `SKILL.md` and `docs/guides/handoffs.md` say to close a retained
idle worker once its scope is finished, and each delivered result reminds the
lead of the worker's label, `agent_continue` and `agent_close`.

**Live retention is off (owner decision, 2026-10-07).** `retainWorkers = false`
in the dotfiles Herdsman config and in the live
`~/.pi/agent/pi-herdsman/config.json`. Persisting a live pane or process past
delivery increases exposure to post-delivery lifecycle races. The configured
policy is: delivery closes the live execution, and the saved Pi session and
caller-side result provenance survive. `agent_continue` relaunches that saved
session (ADR 0013). `retainWorkers` is read at process start, so a running lead
keeps the old behaviour until it reloads.

**Next: advertise resumable workers from the durable record, not a live pane.**
A lead should discover directly owned saved workers after their execution
closes, with the label, saved session, last result and continuation route.
Mailbox deletion, not inventory-only discovery, explains the missing row; the
missing slice is discovery and guidance. See
`.pi-herdsman/resumable-worker-discovery-scope.md`. Discovery must suppress a
saved-session candidate when any workspace has a mailbox representation, and
must never advertise a deliberately closed generation, a proven loss or an
uncertain occupant as safe to resume.

## Herdr independence (state)

Herdr owns the pane container and the agent record, not the work. What is
already ours: the mailbox and assignment lock, ownership records and the launch
fingerprint, settlement and result files, the `herdsman-control/v1` one-shot
request/result transport, and the pane facts `pi-bash-processes` publishes. No
part of the control contract calls Herdr.

Target shape: our own pane and process provisioning and command execution;
readiness and identity from the worker's own extensions rather than a
screen-scraped status; presence and liveness for a pane we did not create; and
a backend seam that keeps the Herdr implementation selectable until it retires.
Radar owning pane detection and restart is the same split from the other side.
`herdr-removal-scope.md` and `manager-removal-scope.md` carry the slice scopes.

## Known defects

| # | Defect | Root cause | Path forward |
|---|---|---|---|
| 134 | The provider (omniroute `coder-high`, about 268k context) returns keepalive-only streams with `stopReason: length` | Unknown, outside this repo. Herdsman classifies it correctly (ADR 0019) | Raise with the provider owner; not ours to fix |

## Queued work

1. `herdsman-control/v1` owner side is committed (`92e52f0e43a1`) with the shared
   close preflight and locked generation checks. Radar's consumer is
   independently gated. Existing owners require reload; live owner-routed
   control smoke remains unverified.
2. Generate the `SKILL.md` runtime-contract block from the injected constants,
   with a drift check (memory 4007).
3. Sweep worker prompt snapshots on process exit and at session shutdown (the
   temp root is never swept).
4. Verify owner-routed control integration after reload, only with explicit
   approval for destructive smoke.
5. The agent-definition / handoff-schema / system-prompt workshop, deferred.
6. Fork safety. A fork replays the parent's session branch, so extension state
   in branch entries is inherited as if the fork had produced it. Background
   snapshots are filtered at the single restore ingestion point (`4edca82d`),
   and `pi-herdsman-role` / `pi-herdsman-lead-state` name their writer
   (`supervision.sessionOwnership`, `entryOwnedBySession`, `581744d6`). The fork
   surface is `fork-in` (`/fork-in-herdr`). Not yet classified: retained-worker
   ownership, the delivery ledger and result refs. The same discipline applies
   to any transition record the persistence rollout introduces, and the record
   should name its writer for the same reason. Until then, do not fork a lead
   that owns workers.
7. `pi-herdsman` AOT integration is implemented and build-verified in dotfiles
   at source pin `305068ec`; both lead and child compile it in the adopted
   Pi-Bolt deployment. The staging recipe pins `HERDSMAN_EXTENSION_PATH` and
   `BUILTIN_AGENT_DIR` to readable source paths and maps the background-work
   import to the staged bash-processes sibling. Both package builds pass with
   the measured AOT ceiling `367961`. A separate AOT-specific launch/compaction
   observation is not established.
8. Live residuals of the landed worker-lifecycle fixes. Landed and gate-green
   but not observed in a real session: the aborted-run fact and its hold
   (`043bb041`), the continuation guard (`a2da5b9e`), provider error text in a
   failure result (`34506f46`), and the unclaimed-alias refusal (`3fcdfeb3`).
   Each needs the shape that produced it: a budget crossing with the assignment
   settling mid-compaction, a real provider failure, and a pane whose occupant
   does not claim its alias.
9. Residuals from the stale-generation slice (`3fcdfeb3`). The guard lives in
   `managedAgentPresence`, so an unclaimed alias is refused everywhere, but
   nothing in the product can resolve the nameless-pane shape:
   `proveExactRunningAgent` reports `agent_not_found`, so an operator must
   inspect the pane by hand. A diagnosis inside that lookup (resolve by pane id,
   then classify) is the only route to in-product recovery. Related: durable
   launch-time pane-process provenance, and a test that leaves a mailbox in a
   `${WORKSPACE}-replacement` workspace that `clearTestMailboxes()` does not
   remove.
10. Pi 1.2.0 pins are aligned across `pi-herdsman`, `pi-native-router` and
    `pi-otel` (resolved 2026-10-15). Install the matching runtime through the
    Nix input before deploying.
11. Radar daemon publication adoption (landed, live adoption unverified).
    Herdsman publishes Pi execution facts and owner assignment facts to Radar's
    control-socket registry and each process's current session as the daemon's
    mutable context record. ADR 0031 records identity, containment and read
    boundary decisions. Remaining: controlled live assignment in a deployed lead
    and child; Radar-side registry pruning (records accumulate per incarnation,
    and a vanished target's assignment writer retries one acquire per heartbeat
    until that child closes); Radar-side retention is a separate daemon change.
    Mutable session context is not yet exercised against a disposable daemon.
12. Radar ownership of background-bash lifecycle is future scope. Today Radar
    receives its state and owns no lifecycle for it. When that moves, the
    owning extension's durable writer moves with it; a mirror is not the shape.

## pi-jev: native classifier and AOT

- Replace the runtime pi-typesafe client with Pi's native classifier API. Drop
  daily request limits rather than replacing pi-typesafe's persistent ledger.
  Preserve the configured model, session limits, timeouts and decision
  semantics; adapt `noul` questions and answers to Pi's `bool`/`probability`
  representation.
- Keep the permission-system sibling-source import patch in the Pi-Bolt staging
  recipe, not in the portable extension source. The staged import itself must
  have a literal specifier.
- Deferred: assess the utility of `pi-typesafe/calibrate` in
  `pi-jev/scripts/report.ts`. Calibration is outside the runtime migration and
  must not pull pi-typesafe into the AOT graph.

## Hygiene

- Bash schema equality fails on description strings only; field types and
  required fields match. Actual structured-result tests pass. Fix the assertion
  boundary and review our descriptions, rather than changing compatible fields.
- Renderer layout fails in the full suite and passes alone. A separate direct
  probe proves the highlight cache reuses the first theme's output under a
  second theme. Width assertions also depend on highlighter call counts rather
  than layout. Do not dismiss this as a load flake.
- Completion-dispatch passes alone; its earlier timeout remains unexplained.
  The idle-batch test disables batching and waits for any exit before checking
  every task. Its helper budget exceeds the default per-test timeout.
- The earlier diff-border failure was not reproduced in this audit. Control
  global COLUMNS and settings inputs before assigning a cause. Full evidence and
  next slices are in the validation audit linked above.

- In a shared working copy a bare `jj commit` / `jj new` finalizes whichever
  commit is checked out and sweeps in every other session's uncommitted files.
  Path-scope the commit, or check the tree first.
- Commit by explicit file path while a worker is live. A directory pathspec once
  swept a worker's in-progress test into `ba8faea3`.
- `pi-subagents` is retired from this workspace; its mirrors are removed and its
  abort-recovery follow-up is out of scope unless it is reintroduced.
