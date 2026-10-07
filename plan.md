# pi-herdsman and pi-bash-processes: outstanding work

Updated 2026-10-06. Local `main` equals upstream and the Nix pin; everything below is pushed.
Every item names its root cause (known, partly known, unknown) and the path forward.

## Worker lifecycle (direction)

**Now (landed with this file):** guidance and a delivery nudge. The lead contract, tool descriptions,
`SKILL.md` and `docs/guides/handoffs.md` say to close a retained idle worker once its scope is finished,
and each delivered result reminds the lead of the worker's label, `agent_continue` and `agent_close`.

**Next, as an openspec change: retire by task state.** Retire the live pane and process while the worker
stays resumable, driven by the assignment's state and not by a lead's memory.
- Trigger: a delivered result has been retrieved and the worker has no awaited children, no unread
  background results and no pending owner ask. Retirement uses the existing close path with its preflight.
- Retained state: the Pi session file, the mailbox record and the label lineage. `agent_continue` relaunches
  it into a new process (the existing `relaunched` path, ADR 0013).
- Open questions: does the grace period reset on any pane activity or only on `agent_continue`; does
  `agent_list` show retired workers as resumable sessions; does Radar need a "retired, resumable" token.
- Depends on: #130 below, because a pane left as a shell must read `lost` for cleanup to be decidable.

## Known defects

| # | Defect | Root cause | Path forward |
|---|---|---|---|
| 130 | **Fixed.** A worker whose process was exited by hand read `unknown`, offered no control, and could not be terminalized | Known. `managedAgentPresence` (`extension/index.ts`) returns `lost` only when the expected pane is gone; a surviving shell pane fails closed as `unknown` | Landed: a pane with no agent, session or activity status that nothing else claims reads `lost` once older than `STARTUP_TIMEOUT_MAX`. Not tested: a pane with an active `agent_status` staying `unknown` (the fixture cannot set one) |
| 131 | **Fixed.** Finished prior-request background results blocked continuation | Known. `classifySettlementTasks` quarantined foreign-request work indiscriminately | `fa3c6d57` carries certified finished results without discarding them. Herdsman contract tests now pin holding settlement until retrieval and refusing running/uncertified foreign work. The classifier is tested separately in pi-bash-processes; no live recovery smoke claimed |
| 132 | A recovery turn that produces no assistant message leaves a held assignment with no further prompt | Known. The recovery prompt is sent once per request, and `freshResponse` stays false | Bound the prompt per request and fail typed when the provider reports the work resolved but the worker never answers; never while the provider reports work outstanding |
| 133 | **Fixed (`d196c011`).** Mid-turn background changes settled a tool-call message as a final answer | Known. `message_end` marked every assistant message fresh; retrieval could trigger settlement on empty text or commentary before the tool/turn finished | `toolUse` messages no longer qualify as final responses. Regressions cover empty text and nonempty commentary. Radar reproduced the same class in a long-lived worker; its loaded source revision remains unknown, so reload is required before claiming that fix was exercised there |
| 134 | The provider (omniroute `coder-high`, about 268k context) returns keepalive-only streams with `stopReason: length` | Unknown, outside this repo. Herdsman now classifies it correctly (ADR 0019) | Raise with the provider owner; not ours to fix |

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
2. `herdr:blocked` raised from pi-herdsman while an operator question is outstanding (the pane reads
   `working` during `ask_user_question` today, by construction).
3. Generate the `SKILL.md` runtime-contract block from the injected constants, with a drift check (memory 4007).
4. Sweep worker prompt snapshots on process exit and at session shutdown (the temp root is never swept).
5. Verify owner-routed control integration after reload, only with explicit approval for destructive smoke.
6. The agent-definition / handoff-schema / system-prompt workshop, deferred.
7. Make forking a session safe for herdsman and background tasks (Pi-native feature, currently unsupported by
   design). A fork replays the parent's session branch, so extension state that lives in branch entries is
   inherited as if the fork had produced it. Known so far: background-task snapshots came back as live in
   the child (partly mitigated in `0c4af53a`: foreign-session terminal snapshots restore as delivered and
   announced results are no longer advertised, but the restore still rewrites their `sessionId`, so the
   fork cannot tell them from its own). Not yet audited: herdsman owner state, retained-worker ownership,
   delivery ledger, result refs and the session-metadata record in a fork. Needed: classify every
   branch-resident extension entry as session-bound or inheritable, bind session-bound ones to the
   session id that wrote them, ignore foreign ones on restore, and add a fork regression per extension.
   Until then, do not fork a lead that owns workers or running tasks.
8. The upstream pre-extraction alignment waits on the owner's approval of
   `.pi-herdsman/pre-extraction-adoption-plan.md` (every fork divergence classified incidental or
   deliberate, deliberate ones kept behind a separable seam). It edits `index.ts` and `herdr.ts`, so it
   takes those two files alone. `herdsman-child-command` is landed (`73dc8bc3`, `37f2ec32`); open under it
   are the dotfiles-side pane-env verification and the model-driven delegated launch/restart smoke, whose
   harness needs a model reachable inside its isolated Pi directory.
9. `#258` exact-path lookup: a separate upstream improvement to the managed-Lead/worktree resolution
   (replaces another global session scan). Independent of the alignment.

## Hygiene

- The alignment plan at `.pi-herdsman/pre-extraction-adoption-plan.md` is deliberately uncommitted until the
alignment is approved. `.pi-herdsman/pre-extraction-restart-redelivery.md` was deleted: it designed a
queued-restart/redelivery lifecycle the owner rejected in favour of a refusal at the delegation boundary
plus Radar-owned restart.
- Commit by explicit file path while a worker is live. A directory pathspec swept a worker's in-progress
  test into `ba8faea3`; the tree is correct and only history is untidy.
- Uncommitted work left behind by a departed session is now `ac0628a2`: pi-reqcap's chain-aware
  attribution was finished (types, changelog, two regressions) and committed.
