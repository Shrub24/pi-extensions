# pi-herdsman and pi-bash-processes: outstanding work

Updated 2026-10-07. Local `main` equals upstream plus six unpushed commits; the Nix pin is at the last
push. A peer session develops pi-jev on top of `main` in this same working copy.
Every item names its root cause (known, partly known, unknown) and the path forward.

## Worker lifecycle (direction)

**Now (landed):** guidance and a delivery nudge. The lead contract, tool descriptions, `SKILL.md` and
`docs/guides/handoffs.md` say to close a retained idle worker once its scope is finished, and each
delivered result reminds the lead of the worker's label, `agent_continue` and `agent_close`.

**Live retention is off (owner decision, 2026-10-07).** `retainWorkers = false` in the dotfiles Herdsman
config and in the live `~/.pi/agent/pi-herdsman/config.json`. Persisting a live pane/process past delivery
makes every lifecycle defect reachable — the orphan continuation turn could only exist because a settled
worker still had a running session — so the default is now: delivery closes the live execution, the
mailbox, result file, label lineage and Pi session survive, and `agent_continue` relaunches the saved
session into a new process (ADR 0013). The toggle and its seam stay; they can be reduced or removed once
the replacement proves out. `retainWorkers` is read at process start, so a running lead keeps the old
behaviour until it reloads.

**Next: advertise resumable workers from the durable record, not a live pane.** With retention off, a
delivered worker no longer appears in the inventory, so a lead that would have continued it respawns
instead — the capability survives in the mailbox and session, but nothing advertises it. The fix is to
list owned closed generations as resumable (label, last result, `agent_continue`) and let `agent_continue`
relaunch them. This is what makes retention-off strictly better than retention-on rather than merely safer.
- Open questions: does the grace period reset on any pane activity or only on `agent_continue`; does
  Radar need a "retired, resumable" token.
- Depends on: #130 below, because a pane left as a shell must read `lost` for cleanup to be decidable.

## Herdr independence (direction)

Herdr owns the pane container and the agent record, not the work. Replace both, and keep the lifecycle and
reporting ours. This is direction, not a scheduled change, and the worker-retirement and control items
above land first.

What Herdr supplies today:

- **Container and topology:** `tab create` / `pane split` / `pane list` / `pane get`, the cwd, and the
  `--env` list a pane is born with, which is how a worker receives `PI_HERDSMAN_*`. Closing the pane is
  the only way we terminate a worker's shell.
- **Process start:** `agent start --kind pi` types the canonical `pi` into the pane's shell, so the shell
  resolves the binary; `pane run` types a line we composed. After `herdsman-child-command` the second is
  the configured path, which is the first step out.
- **The agent record:** `agent get` / `list` / `rename` / `wait`, plus the official Herdr Pi reporter
  extension that supplies `agent_session` and lifecycle authority, with Herdr's screen detection as a
  status fallback when no reporter is loaded. Presence, `lost` and the alias we address a worker by all
  read from that record, and Herdr #3208 forced the fresh-shell `agent_pane_busy` retry we carry.

What is already ours: the mailbox and assignment lock, ownership records and the launch fingerprint,
settlement and the result files, the `herdsman-control/v1` one-shot request/result transport, and the pane
facts `pi-bash-processes` publishes. No part of the control contract calls Herdr.

Target shape: our own pane and process provisioning and command execution; readiness and identity taken
from the worker's own extensions rather than a screen-scraped status; presence and liveness for a pane we
did not create; and a backend seam that keeps the Herdr implementation selectable until it is retired.
Radar owning pane detection and restart is the same split from the other side.

## Known defects

| # | Defect | Root cause | Path forward |
|---|---|---|---|
| 130 | **Fixed.** A worker whose process was exited by hand read `unknown`, offered no control, and could not be terminalized | Known. `managedAgentPresence` (`extension/index.ts`) returns `lost` only when the expected pane is gone; a surviving shell pane fails closed as `unknown` | Landed: a pane with no agent, session or activity status that nothing else claims reads `lost` once older than `STARTUP_TIMEOUT_MAX`. Not tested: a pane with an active `agent_status` staying `unknown` (the fixture cannot set one) |
| 131 | **Fixed.** Finished prior-request background results blocked continuation | Known. `classifySettlementTasks` quarantined foreign-request work indiscriminately | `fa3c6d57` carries certified finished results without discarding them. Herdsman contract tests now pin holding settlement until retrieval and refusing running/uncertified foreign work. The classifier is tested separately in pi-bash-processes; no live recovery smoke claimed |
| 132 | **Fixed.** An empty recovery turn left a resolved-work assignment held indefinitely | Known. The single recovery prompt was spent but `freshResponse` stayed false | Fail with `empty_result` only after the prompted run starts and settles without a fresh answer, with all dependencies resolved. Preserve ordinary result-write retries. Runtime suite: 86/86; no live recovery smoke claimed |
| 133 | **Fixed (`d196c011`).** Mid-turn background changes settled a tool-call message as a final answer | Known. `message_end` marked every assistant message fresh; retrieval could trigger settlement on empty text or commentary before the tool/turn finished | `toolUse` messages no longer qualify as final responses. Regressions cover empty text and nonempty commentary. Radar reproduced the same class in a long-lived worker; its loaded source revision remains unknown, so reload is required before claiming that fix was exercised there |
| 134 | The provider (omniroute `coder-high`, about 268k context) returns keepalive-only streams with `stopReason: length` | Unknown, outside this repo. Herdsman now classifies it correctly (ADR 0019) | Raise with the provider owner; not ours to fix |
| 135 | **Fixed (`1863bc41`, `a2da5b9e`, `043bb041`).** A worker's compaction could publish a result from the very turn it replaced, or resume an assignment that had already settled, unsupervised | Known. Settlement eligibility was inferred from which settle boundary a run reached, and the compaction continuation was sent unconditionally once it committed | Pi 1.1.0 reports how the settled run ended, so the aborted run is read from `agent_settled.aborted` rather than inferred; a settlement withholds only while this worker's own compaction continuation is still pending, and the continuation goes out only while the request that asked for it is still active (otherwise the skip is recorded durably). Not yet observed live: needs a real worker crossing its budget |
| 136 | **Fixed (`34506f46`).** A worker that ended on a provider error reported only the response-contract failure | Known. The failure message was composed from the validation outcome and the provider's own error text was dropped | An `error` stop's `errorMessage` now prefixes the failure message, so the owner sees the provider's text. Nothing is inferred from an empty answer, and an error stop that still yields contract-valid text publishes `completed`. Not yet observed live: no real provider failure has passed through it |

## Fixed this session (for provenance)

- Stale-reply registration handshake across per-extension `pi.events` facades.
- Empty generation misread as a truncated reply (`stopReason: length` with about zero output tokens).
- V5 brief-profile tolerance, now on every child-side read (ADR 0022). This was the cause of the launch
  timeouts; the failed launches' requests are archived under `.pi-herdsman/evidence/launch-timeouts/`.
- Session-activation reservation leak and the advertised `result:<label>#<index>` ref (`99b898c1`).
- `agent_extend` liveness guard, V5 request profile check, withheld-settlement retry (ADRs 0020, 0021).

## Recovery through the tools

`agent_continue` now recovers a proven lost, directly owned generation using the exact saved Pi session,
without a close-first step or manual mailbox removal. It uses the shared locked close preflight to retire
the stale record, preserves unread durable results, and relaunches under the same label. A surviving shell
is left untouched; uncertain identity still refuses. `agent_close` retires resources without deleting the
Pi session. Routine guidance speaks in workers and sessions; transport details remain diagnostic.

Verification: vanished-pane and surviving-shell recovery regressions, uncertainty and unread-result
refusals, plus carried-background-result settlement contract tests. No live recovery smoke claimed.

## Queued work

1. `herdsman-control/v1` owner side is committed (`92e52f0e43a1`) with the shared close preflight and locked
   generation checks. Radar's consumer is independently gated. Existing owners require reload; live
   owner-routed control smoke remains unverified.
2. ~~`herdr:blocked` raised from pi-herdsman while an operator question is outstanding~~ — landed
   (`9972d951`): a worker-side `rpiv:ask-user:blocked` bridge persists a run/session/request-scoped sidecar
   that the managed projection reads ahead of lifecycle `working`. Nothing synthesizes `pendingAskId`, and
   health attention still keys on the raw Herdr lifecycle. A live questionnaire has not been observed
   through it yet.
3. Generate the `SKILL.md` runtime-contract block from the injected constants, with a drift check (memory 4007).
4. Sweep worker prompt snapshots on process exit and at session shutdown (the temp root is never swept).
5. Verify owner-routed control integration after reload, only with explicit approval for destructive smoke.
6. The agent-definition / handoff-schema / system-prompt workshop, deferred.
7. Make forking a session safe for herdsman and background tasks. A fork replays the parent's session
   branch, so extension state that lives in branch entries is inherited as if the fork had produced it.
   Session-bound state is now bound to the session that wrote it and ignored on a fork: background-task
   snapshots are filtered at the single restore ingestion point (`4edca82d`), so a foreign snapshot is
   neither restored nor re-advertised, and `pi-herdsman-role` / `pi-herdsman-lead-state` name their writer
   (`supervision.sessionOwnership`, `entryOwnedBySession`, `581744d6`), so a fork starts without its
   parent's role, coordinator generation or chief activation. The session-metadata record and the
   worker/agent identities were already scoped this way. The fork surface is `fork-in`
   (`/fork-in-herdr`), which copies the session JSONL with a fresh id and a `parentSession` pointer; that
   pointer is the signal the fork check reads, so no marker of our own is needed. Not yet audited:
   retained-worker ownership, the delivery ledger and result refs. Needed: the same classification for
   those surfaces, and a live fork smoke. Until then, do not fork a lead that owns workers.
8. The upstream pre-extraction alignment waits on the owner's approval of
   `.pi-herdsman/pre-extraction-adoption-plan.md` (every fork divergence classified incidental or
   deliberate, deliberate ones kept behind a separable seam). It edits `index.ts` and `herdr.ts`, so it
   takes those two files alone. `herdsman-child-command` is landed (`73dc8bc3`, `37f2ec32`); open under it
   are the dotfiles-side pane-env verification and the model-driven delegated launch/restart smoke, whose
   harness needs a model reachable inside its isolated Pi directory.
9. `#258` exact-path lookup: a separate upstream improvement to the managed-Lead/worktree resolution
   (replaces another global session scan). Independent of the alignment.
10. `pi-herdsman` AOT integration is implemented and build-verified in dotfiles at source pin
    `305068ec`; activation is pending the coordinated host switch. Both lead and child compile it.
    The staging recipe pins `HERDSMAN_EXTENSION_PATH` and `BUILTIN_AGENT_DIR` to readable source paths,
    and maps the background-work import to the staged bash-processes sibling. The recipe stages that
    dependency even if it is not registered. No portable runtime-source patch is needed.
    Both package builds pass with the measured AOT ceiling `367961`. Isolated RPC startup smokes load
    compiled Herdsman with discovery disabled; the configured child launcher also drops a redundant
    herdsman extension path. No live delegated-launch/compaction smoke is claimed.
    Planned packaging change (owner, 2026-10-07): the profile-level bash wrapper may go, with the
    entrypoints (`pi`, `pi-bolt`, `pi-bolt-child`) provided by the store derivation itself. That removes
    the wrapper-to-payload hop for consumers — PATH resolves straight into the derivation, so family and
    version are exact — which is exactly the bridge Radar's strict-literal launcher resolver was built for,
    and it retires that parser instead of documenting it. What must survive the move: the per-user
    `$HOME/.pi/agent/npm/...` extension flags and the conditional herdr extension (a runtime test inside the
    store script), the child's `-e` filtering plus its `--no-extensions -e builtin:mcp -e builtin:codemode`
    injection, and `PI_HERDSMAN_CHILD_COMMAND` (a bare PATH name or the store path; herdsman records the
    resolved absolute path either way). Still worth emitting from the build even then: an identity stamp
    (`$out/nix-support/pi-bolt-identity.json` — family, version, Pi version, compiled plugins, herdsman
    revision), because a store path cannot say which plugins are compiled in and under AOT it is the only
    build identity a process can report. Radar consumes both. Note also that `pi` is now the pi-bolt lead
    launcher, so `pi` and `pi-bolt` distinguish nothing — family must come from the store root or the env.
11. Live residuals of the landed worker-lifecycle fixes. Landed and gate-green but not yet observed in a
    real session: the aborted-run fact and the hold belonging to it (`043bb041` — Pi 1.1.0 reports how the
    settled run ended, so Herdsman reads `agent_settled.aborted` instead of inferring it from which boundary
    a run reached, and withholds a settlement only while this worker's own compaction continuation is still
    pending; an aborted run with no continuation is judged as its answer. Supersedes the `1863bc41`
    boundary-order marker and deletes the `agent_before_settle` handler), the continuation guard
    (`a2da5b9e` — a continuation is withheld
    once its assignment settled, recorded as `pi_herdsman_state_compaction_continuation_skipped`), provider
    error text in a failure result (`34506f46`), and the unclaimed-alias refusal (`3fcdfeb3`). Each needs
    the shape that produced it: a budget crossing with the assignment settling mid-compaction, a real
    provider failure, and a pane whose occupant does not claim its alias. Retention-off (below) is what
    makes the orphan-continuation class unreachable rather than merely guarded.
12. Residuals from the stale-generation slice (`3fcdfeb3`). The guard lives in `managedAgentPresence`, so
    an unclaimed alias is refused everywhere, but nothing in the product can *resolve* the nameless-pane
    shape: `proveExactRunningAgent` still reports `agent_not_found` for it, so an operator has to inspect
    the pane and resolve the occupant by hand. A diagnosis inside that lookup (resolve by pane id, then
    classify) is the only route to an in-product recovery, and it was deliberately left out of the slice
    because no managed control reaches it today. Related: durable launch-time pane-process provenance would
    prove the same generation without the alias, and an existing test leaves a mailbox in a
    `${WORKSPACE}-replacement` workspace that `clearTestMailboxes()` does not remove, which can skew any
    future test that filters global states by session id.
13. The Pi type pin has drifted behind the deployed runtime. `pi-herdsman` and `pi-bash-processes` pin
    `@earendil-works/pi-{ai,coding-agent,tui}` at 0.99.2 in devDependencies while the deployed pi-bolt is
    Pi 1.1.0 (Pi-Bolt 0.7.2, adopted 2026-10-08). The installed types cannot catch fields added since
    0.99.2: `AgentSettledEvent` carries no `aborted` at 0.99.2 and gains it at 1.1.0, and our handlers are
    typed `(event: unknown)`, so a wrong new field name still compiles — which is why the 1.1.0 migration
    (`043bb041`) had to pin the read with a test rather than rely on the type. Bumping the pin is its own
    change, because it moves every type assertion in the suites at once. The session-header surface the
    fork ownership check reads is stable across both tags (`parentSession`, `getSessionId`, `getHeader`),
    so that check does not depend on the bump.
14. The same abort migration applies to `pi-subagents`. Its `src/runs/shared/abort-recovery.ts` infers a
    terminal abort from the terminal assistant message's `stopReason` (plus a provider-abort error text)
    and feeds it into `planAbortRecovery`, to decide whether a compaction-induced child abort may be
    resumed. `agent_settled.aborted` is the direct fact for that question. Check first whether the path
    receives settled events in this deployment. Not started; no owner assigned.

## pi-jev: native classifier and AOT

- Replace the runtime pi-typesafe client with Pi's native classifier API. Drop daily request
  limits rather than replacing pi-typesafe's persistent ledger. Preserve the configured model,
  session limits, timeouts and decision semantics; adapt `noul` questions and answers to Pi's
  `bool`/`probability` representation.
- Keep the permission-system sibling-source import patch in the Pi-Bolt staging recipe, not
  in the portable extension source. The staged import itself must have a literal specifier.
- Deferred: assess the utility of `pi-typesafe/calibrate` in `pi-jev/scripts/report.ts` later.
  Calibration is outside the runtime migration and must not pull pi-typesafe into the AOT graph.

## Hygiene

- The revised alignment plan at `.pi-herdsman/pre-extraction-adoption-plan.md` stays out of `main` until
the alignment is approved: it is parked in a local commit, not merged.
`.pi-herdsman/pre-extraction-restart-redelivery.md` was deleted: it designed a queued-restart/redelivery
lifecycle the owner rejected in favour of a refusal at the delegation boundary plus Radar-owned restart.
- In a shared working copy a bare `jj commit` / `jj new` finalizes whichever commit is checked out and
sweeps in every other session's uncommitted files. One such `jj new` carried a deliberately-held file and
a peer's plan section into an undescribed commit, and detaching that peer's commit from it later dropped
the section from `main`. Path-scope the commit, or check the tree first.
- Commit by explicit file path while a worker is live. A directory pathspec swept a worker's in-progress
  test into `ba8faea3`; the tree is correct and only history is untidy.
- Uncommitted work left behind by a departed session is now `ac0628a2`: pi-reqcap's chain-aware
  attribution was finished (types, changelog, two regressions) and committed.
