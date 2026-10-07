# pi-herdsman and pi-bash-processes: outstanding work

Updated 2026-10-07. Local `main` equals upstream and the Nix pin; everything below is pushed. A peer
session develops pi-jev on top of `main` in this same working copy.
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
10. `pi-herdsman` under AOT (impending; the patch shape is already measured). It is a runtime `-e`
    extension today, so nothing is compiled and its imports resolve at runtime. Moving it into the AOT
    plugin set needs two `--replace-fail` patches, both for `import.meta.url`: `extension/index.ts:339`
    (`HERDSMAN_EXTENSION_PATH`, handed to children as `--extension`) and `extension/agent-definitions.ts:83`
    (`BUILTIN_AGENT_DIR`, read with `readdirSync`, which `$bunfs` cannot serve — point it at the pinned
    source instead). Dropping the child's extension argument is only correct while both binaries compile
    Herdsman in; a lead-only selection would launch children with no Herdsman at all. Neither known AOT
    patch class applies: no variable dynamic-import specifiers and no sibling-source import in the runtime
    graph (`extension/support.ts` is the test harness and nothing outside `*.test.ts` imports it). Open:
    the per-module ceiling (`BUN_JSC_maximumAOTCandidateBytecodeSize=352256`) against an 18,677-line
    `extension/index.ts`.

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
