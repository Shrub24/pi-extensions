# pi-herdsman and pi-bash-processes: outstanding work

Updated 2026-10-06. Local `main` is ahead of upstream and not pushed; the push waits for the owner's word.
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
| 131 | **Fixed (pending commit).** `agent_continue` is refused at bind when the previous request left unread background results (`bg-*`), and the lead cannot reach a child-owned task | Known. `classifySettlementTasks` quarantines unassociated and unattributable tasks (`pi-bash-processes/extensions/background-tasks.ts`); no owner-side way to reconcile them | Admission carries a prior request's finished results into the new assignment, or an owner-side typed reconcile action. Live unattributable work still blocks. Verified workaround: open the exact session in an unmanaged Pi and `bg_task get` each id |
| 132 | A recovery turn that produces no assistant message leaves a held assignment with no further prompt | Known. The recovery prompt is sent once per request, and `freshResponse` stays false | Bound the prompt per request and fail typed when the provider reports the work resolved but the worker never answers; never while the provider reports work outstanding |
| 133 | `leak-fix2` published a `failed` result (empty response) while its pane was still working | Unknown, narrowed. Its session (`01a10e6d`) has no `length` stop and no keepalive-shaped turn: every `stop` carried text and it ended normally with a final answer, so this is not the empty-generation shape and not the no-first-message shape | Match the failed result's request id against the owner session's delivery record and the exact text the validator saw (`inline.text`); the worker session alone cannot show it |
| 134 | The provider (omniroute `coder-high`, about 268k context) returns keepalive-only streams with `stopReason: length` | Unknown, outside this repo. Herdsman now classifies it correctly (ADR 0019) | Raise with the provider owner; not ours to fix |

## Fixed this session (for provenance)

- Stale-reply registration handshake across per-extension `pi.events` facades.
- Empty generation misread as a truncated reply (`stopReason: length` with about zero output tokens).
- V5 brief-profile tolerance, now on every child-side read (ADR 0022). This was the cause of the launch
  timeouts; the failed launches' requests are archived under `.pi-herdsman/evidence/launch-timeouts/`.
- Session-activation reservation leak and the advertised `result:<label>#<index>` ref (`99b898c1`).
- `agent_extend` liveness guard, V5 request profile check, withheld-settlement retry (ADRs 0020, 0021).

## Queued work

1. `herdsman-control/v1` owner side (tasks 2.1 to 2.5 in `openspec/changes/herdsman-control/tasks.md`), run by
   the fork session, after #130 and #131 because all touch `extension/index.ts`. Task 2.3 must call the
   existing `agent_close` preflight, not a copy.
2. `herdr:blocked` raised from pi-herdsman while an operator question is outstanding (the pane reads
   `working` during `ask_user_question` today, by construction).
3. Generate the `SKILL.md` runtime-contract block from the injected constants, with a drift check (memory 4007).
4. Sweep worker prompt snapshots on process exit and at session shutdown (the temp root is never swept).
5. Tell Radar when the owner side of `herdsman-control/v1` has landed; its controls stay disabled until then.
6. The agent-definition / handoff-schema / system-prompt workshop, deferred.

## Hygiene

- `pi-reqcap` has uncommitted edits from another session; do not commit them.
- Commit by explicit file path while a worker is live. A directory pathspec swept a worker's in-progress
  test into `ba8faea3`; the tree is correct and only history is untidy.
