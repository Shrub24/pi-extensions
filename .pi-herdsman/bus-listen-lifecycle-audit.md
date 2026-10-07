# Bus-listen lifecycle audit — compaction, failure delivery, absent retained target

Read-only incident audit. No production, test, VCS, or runtime state was changed.
Written for the owner (session `01a10a58-c4c1-7570-a8ba-a8b0ca9e8d91`, pane `w19:p3`,
run `7a3447af-aad7-4317-ba5d-575b25ff23f3`, request `290455b8-0430-48bf-8e16-80a111bca83c`).

## 0. Evidence used (exact paths)

| Evidence | Path |
| --- | --- |
| Worker session | `/home/saurabhj/.pi/agent/sessions/--home-saurabhj-Projects-dev-agent-radar--/2026-10-05T14-28-43-244Z_01a10c77-8a6b-7035-8a0e-b1fa607bb507.jsonl` (10,218 lines, 32 MB) |
| Lead session | `/home/saurabhj/.pi/agent/sessions/--home-saurabhj-Projects-dev-agent-radar--/2026-10-05T04-35-52-129Z_01a10a58-c4c1-7570-a8ba-a8b0ca9e8d91.jsonl` (37 MB) |
| Worker mailbox (preserved, unchanged) | `/home/saurabhj/.pi/agent/pi-herdsman/runtime/mailboxes-v4/cec067250c3ffdec5396cd4ad83188e4/state.json` |
| Deployed config | `/home/saurabhj/.pi/agent/pi-herdsman/config.json` |
| Reported loaded source (`S33` below) | `/nix/store/33n2764a41giw4j2xg0l37iwaswpipgr-source/pi-herdsman` |
| Renewed store tree (`SBQ`) | `/nix/store/bq06k07kdqyyhafmk1321gb8xwaggz2v-source/pi-herdsman` |
| Currently configured tree (`SRH`) | `/nix/store/rhbn62chgsalg1sal31x9najf0gj4fj7-source/pi-herdsman` (also `/home/saurabhj/.pi/agent/settings.json:109`) |
| Checkout (not loaded) | `/home/saurabhj/Projects/dev/custom/pi-extensions/pi-herdsman` (18,726 lines; newer than all three store trees; clean tree at `4314ee925`) |

Reproduce the timeline with, from the worker session:

```
jq -r 'select(type=="object" and .type=="message" and .message.role=="assistant") | [.timestamp,.message.stopReason,(.message.usage.totalTokens//"-")] | @tsv' <worker.jsonl>
jq -c 'select(.type=="compaction") | {ts:.timestamp,tokensBefore,fromHook,details}' <worker.jsonl>
```

## 1. Correlated timeline (proven)

Request `290455b8-…` was created by the lead's `agent_continue` at `2026-10-07T09:09:03.624Z` (lead session, line 8746 area) and is the request in the mailbox
(`lastAck.requestId = 290455b8-…`, `acknowledgedAt = 1791364143905` = `09:09:03.905Z`).
Everything below is inside that one assignment.

| Time (UTC) | Event | Evidence |
| --- | --- | --- |
| 09:13:14.959 | worker completion, `stopReason=toolUse`, `totalTokens=208,205` (first over-budget tool boundary of the request) | worker JSONL |
| 09:13:15.156 | assistant message `stopReason=error`, `totalTokens=0` | worker JSONL |
| 09:13:15.192 | correction #1 delivered to worker — response-contract failure (`invalid_response`) | worker JSONL user message |
| 09:23:02.637 | worker completion `toolUse`, `totalTokens=266,864` (last tool boundary) | worker JSONL |
| 09:23:13.245 | worker completion `length` (reply cut off), `totalTokens=267,937`, truncated final text | worker JSONL |
| 09:23:13.277 | correction #2 delivered to worker — "cut off by the output limit" | worker JSONL user message |
| 09:23:16.785 | worker completion `length`, `output=1` token, no text, `totalTokens=267,980` | worker JSONL |
| 09:23:16.810 | durable `pi_herdsman_state_error`: "empty generation: the turn ended on the output limit with no response text and no generated tokens" | worker JSONL custom entry `e5d89901` |
| ~09:23:16.823 | mailbox state written (`updatedAt = 1791364996823`); later reads show `activeRequestId: null`, `completedRequestId: 290455b8-…` | mailbox `state.json` |
| 09:23:16.831 | **lead receives durable failure** `Agent result … status=failed` / `A nonempty inline response is required` / `- inline.text: A nonempty inline response is required` / "Worker bus-listen is retained and idle …" | lead session `custom_message` `pi-herdsman-agent-result` |
| 09:23:16.850 | **pi-vcc compaction committed**: `tokensBefore=267980`, `fromHook=true`, `details={compactor:"pi-vcc",reason:"manual",sourceMessageCount:301,previousSummaryUsed:true}`, `firstKeptEntryId=b86b9c96` | worker JSONL `compaction` entry `2b881e32` |
| 09:23:16.912 | **compaction continuation delivered to worker** (`CONTEXT_COMPACTION_CONTINUATION`) | worker JSONL user message `21d32af9` |
| 09:23:21.200 | worker continuation turn, `input=19,881` tokens (context actually shrank) | worker JSONL |
| 09:23:51.067 | worker writes `/home/saurabhj/Projects/dev/agent-radar/.pi-herdsman/variant-aware-binary-freshness/report.md` | worker JSONL tool result |
| 09:24:02.304 | worker produces a complete final answer ("Implemented the variant-aware binary freshness resolver …") | worker JSONL; **never delivered** — no second `pi-herdsman-agent-result` in the lead session |
| 10:13:22 | lead retrieves the report via `agent_transcript` | lead session |
| 10:14:06.870 | lead `agent_continue` on session `01a10c77-…` | lead session |
| 10:14:07.171 | **continue fails**: `Agent continue failed. / Category: internal_failure / Message: agent target bus-listen_da967b4689fde7f7 not found / Operation: close / Rollback occurred: false / Retry attempted: false / Identity: label=bus-listen, paneId=w19:p3` | lead session tool result `11858e26` |

Correlation is by request id and mailbox facts, not by display text: the failed
result, the empty-generation error, the compaction and the continuation all fall
within 145 ms.

## 2. Why the failure was delivered while the continuation still ran (proven)

All line numbers are `S33/extension/`.

1. The correction budget is shared between both correction kinds and capped at
   two per request: `MAX_RESPONSE_CORRECTIONS = 2` (`index.ts:443`), consumed in
   `requestCorrection` (`index.ts:18130-18143`). Correction #1 (contract,
   09:13:15.192) and correction #2 (cut off, 09:23:13.277) exhausted it, so the
   third correction — the contract correction for the empty generation — was
   refused (`index.ts:18137`).
2. With no correction left, `settleCurrentAgent` proceeds to build the result.
   `validateResponse({inlineText: latest})` with `latest === ""` throws
   `invalid_response / "A nonempty inline response is required"`
   (`response-validation.ts:574`), which becomes the delivered failure
   (`index.ts:18173-18196`, result record `index.ts:18227-18249`).
3. The compaction that pi-vcc committed 21 ms later was **not visible to that
   settlement**. The compaction hold is `awaitingContinuation` +
   `contextCompactionInFlight` (`index.ts:16594`, `18535-18556`, `18607-18633`),
   but `awaitingContinuation` is cleared by *any* assistant `message_end`
   (`index.ts:17713`), and `settleCurrentAgent` only guards on
   `awaitingContinuation` (`index.ts:18127`) — it never consults
   `contextCompactionInFlight`. Whatever turn ended the operation, the
   settlement was allowed to publish.
4. `compactManagedContext`'s `onComplete` sends the continuation unconditionally
   (`index.ts:18620-18627`), so the continuation turn started after the
   assignment had already been settled as failed. Its answer (09:24:02) hit
   `settleCurrentAgent`'s `if (!state?.activeRequestId …) return;` and was
   discarded; only the on-disk report survived. The final failure was also not
   retracted: the mailbox had no `activeRequestId` left.

**Interpretation (not proven):** the last response-correction refusal converted a
recoverable empty generation into a terminal `failed` result, and the compaction
that would have rescued the same request was allowed to run to completion
afterwards. The user-visible symptom ("failure while the correction ran") is
exactly this ordering.

## 3. Why the 200k trigger did not avoid 268k

### Proven

- The deployed ledger is present and active: `DEFAULT_WORKER_CONTEXT_BUDGET_TOKENS = 200_000`
  (`config.ts:27`), `DEFAULT_CONFIG.contextRetirement = false` (`config.ts:59-66`),
  and the deployed `/home/saurabhj/.pi/agent/pi-herdsman/config.json` sets neither
  `workerContextBudgetTokens` nor `contextRetirement`. `readConfig()` reads
  `~/.pi/agent/pi-herdsman/config.json` (`config.ts:243-253`, `storage.ts:9-15`),
  so budget = 200,000 and retirement is off.
- The trigger can only fire at a **tool-call** turn boundary:
  `pi.on("turn_end", …)` calls `compactManagedContextIfOverBudget(ctx, message.stopReason === "toolUse")`
  (`index.ts:17715-17734`), which returns immediately when the turn did not call
  tools, when retirement is on, when usage is unknown, when
  `usage.tokens < managedContextBudget(usage.contextWindow)`
  = `min(configured, contextWindow - 32_768)`, or when there is no
  `activeRequestId` (`index.ts:18585-18605`). A `length` or `stop` turn can never
  start a compaction.
- **267,980 is not the trigger usage.** It equals the last completion's
  `usage.totalTokens` (`input 267,979 + output 1`); the last tool boundary before
  it was 266,864. `mailbox.ts:137-141` documents the same property (Pi reports a
  size that can exceed the window just before compaction). So the displayed
  "Compacted 267980 tokens" describes the pre-compaction size at commit time,
  not the usage that satisfied the budget.
- The compaction worked: the continuation turn reads `input = 19,881`.

### Contradicted by observation — and left unproven

The deployed build demonstrably did **not** compact at 200k in this pane:

- `2026-10-05T23:10:01.529Z → 23:11:17.133Z` (worker session): 17 consecutive
  `toolUse` boundaries at 254,106 → 267,831 tokens with no compaction; the first
  compaction entry is `23:11:41.126Z` (`tokensBefore=268510`).
- `2026-10-06T05:47:02.673Z` boundary at 208,055 tokens produced none; the next
  compaction is `05:48:58.703Z` (`tokensBefore=236293`).
- In the incident request the first over-budget boundary was 09:13:14.959
  (208,205) and no compaction was recorded for the following ~9 minutes
  (boundaries 215k, 218k, 228k, 244k, 252k, 257k, 266k).

Counter-evidence from the second incident (§9): the ledger **does** fire. In
`01a115de-…` the compaction committed at `11:26:43.942Z`, 12.5 s after a
`toolUse` boundary at 210,987 tokens — i.e. the 200k budget was satisfied and
acted on in that request. So "200k never fires" is **not** the finding; the
finding is that firing and effect are decoupled in time, and that some earlier
boundaries above budget produced no compaction that read-only evidence can see.

For the old pane's non-firing windows, read-only session evidence cannot
distinguish between these (none proven):

1. The trigger fired but Pi/pi-vcc deferred or silently aborted the request: the
   compaction committed 13 s after the 09:23:02.637 boundary, but the Oct-6
   episodes show gaps of 6 s and ~100 s between the last plausible trigger
   boundary and the committed entry.
2. `ctx.getContextUsage().tokens` in this Pi build did not reflect the full
   prompt at those boundaries (the ledger only fires when it does).
3. The running build's budget differed from the deployed source (see §4 — the
   loaded build's identity is genuinely uncertain).

What is *proven* is the blind spot that prevents resolution: **nothing records a
trigger evaluation or a compaction failure.** `compactManagedContext`'s `onError`
only clears the in-flight flag (`index.ts:18551-18556`), so an issued-then-failed
compaction leaves no trace anywhere (session, mailbox, logs). ADR 0028 itself
notes the settle-time trigger was deferred pending live observation
(`S33/docs/adr/0028-compact-a-managed-workers-context-at-a-fixed-budget.md`,
"Decision", penultimate paragraph).

## 4. Loaded-source verification — the reported path is not the file the worker read

- Session `ps` evidence names `/nix/store/33n2764a41giw4j2xg0l37iwaswpipgr-source/pi-herdsman/extension/index.ts`
  as the Herdsman extension of the worker/child processes (3 mentions,
  08:50:59-08:53:59, e.g. `…-pi-bolt-child-0.7.1/lib/pi-bolt/pi --extension /nix/store/33n2764…/pi-herdsman/extension/index.ts`).
- But the pi-vcc compaction committed at `09:23:16.850Z` carries a system message
  whose pi-herdsman skill resolves from
  `/nix/store/bq06k07kdqyyhafmk1321gb8xwaggz2v-source/pi-herdsman/SKILL.md`
  — the renewed tree. Earlier compactions (Oct 5-6) recorded no store path at all.
- Only the incident compaction records a store path, and it records `SBQ`, not
  `S33`. The worker's own in-turn read at that instant matched code the file at
  `S33` does **not** contain (`PI_VCC_COMPACT_INSTRUCTION = "__pi_vcc__"`).
- Diff `S33` → `SBQ`/`SRH` is exactly two behaviour changes: the pi-vcc marker
  (`customInstructions: "/pi-vcc"` → `__pi_vcc__`, `S33/index.ts:18545`), and a
  typed `empty_result: "Background work resolved, but the worker produced no
  final response"` failure in the background-final-response recovery. Both trees
  carry the same 200k ledger and the same tool-use-only boundary.

**Conclusion (inference):** at the incident the loaded Herdsman was
`bq06k07…` (equivalently `rhbn62…`), i.e. the newer tree; the `S33` path came
from earlier `ps` output. Treat every `S33` line number in this audit as
"same code, possibly one minor revision behind the incident build". The audit's
conclusions do not depend on that difference (both variants share the ledger,
the boundary, the correction budget and the close path).

## 5. Absent retained target: trace of the close lookup

Path that produced the refusal (all in `S33/extension/`):

```
agent_continue tool (index.ts:16309-16334, params require `session`)
  → actionUnsafe (index.ts:6863-6868) → resume path (index.ts:7034-7041)
  → the resumed session's single managed representation is a provably lost generation
      isLostWorkerOf (index.ts:3493-3503)  → decision { kind: "recover" } (index.ts:7194-7197)
  → closeManagedSnapshot (index.ts:7218-7235; the "shared lost-close seam", defined at index.ts:5215)
      managedAgentPresence (index.ts:3505-3587) returned "live"
  → closeManagedAgent (index.ts:5196-5230) → closeLiveManagedExecution (index.ts:5094-5138)
  → closeHerdrPane(runtime.herdrAgent, …) (herdr.ts:2380-2432)
  → proveExactRunningAgent → runHerdr(["agent","get", herdrAgent]) (herdr.ts:2248-2250)
  → Herdr answers code `agent_not_found`, message `agent target bus-listen_da967b4689fde7f7 not found`
  → herdr.ts error() ⇒ category internal_failure (herdr.ts:132-141)
  → normalizeCloseFailure ⇒ operation rewritten to "close", rollbackOccurred preserved false (index.ts:5064-5086)
  → presented as "Operation: close / Rollback occurred: false" (presentation.ts:2178, 2199)
```

Alias identity is **not** the mismatch: `alias = <label[0:15]>_<sha256(workspaceId\0label\0runId)[0:16]>`
(`herdr.ts:482-491`), and `sha256("w19\0bus-listen\07a3447af-aad7-4317-ba5d-575b25ff23f3")`
= `da967b4689fde7f7` — exactly the alias in the error, matching the mailbox
state (`workspaceId w19`, `runId 7a3447af…`, `label bus-listen`). So the
extension computed the documented alias for the recorded generation; **Herdr had
no agent resolvable under that name at `agent get` time.**

Two conditions make this possible and are worth the owner's attention:

- **Presence vs. lookup asymmetry (observation):** presence may be judged "live"
  from the inventory where `herdrAliasMatchesIfReported` tolerates an *absent*
  player `name` (`index.ts:2284-2295`), while the close path requires
  `herdr agent get <alias>` to resolve. A record that is listed without its final
  name, or a list snapshot taken before the identity settles, yields "live"
  presence and then `agent_not_found` on close.
- **Fail-closed category (observation):** the refusal is `internal_failure`, not
  `target_not_found` (`herdr.ts:132`, `errors.ts:5`), so
  `executeControlRequest`/`CONTROL_REFUSAL_CATEGORIES` (`index.ts:5422-5428`,
  `5848-5865`) does not convert it into a named refusal — a control `restart` for
  this worker would end as `unknown`, never `refused`.

Not verified here: whether the pane/process still existed at 10:14. Read-only
scope excluded pane/process control and no process evidence was collected, so the
state of `w19:p3` at 10:14 is unproven. The "reproduced on two delivered workers"
claim is also unverified: across every `*.jsonl` in the agent-radar sessions
directory the missing-target text occurs only for `bus-listen` at 10:14:07.171
(repeated 5× inside that single tool result).

### Safe recovery proposal (not executed)

1. ~~Classify a close-path `agent_not_found` as lost presence and take the lost
   branch of `closeManagedSnapshot`.~~ **RETRACTED (2026-10-07, second
   incident) — this suggestion was unsafe and is withdrawn.** A missing Herdr
   alias is not evidence that the execution is gone. Observed: `w19:p3` after
   the bus-listen incident ran a *live* process (operator-mode lead PID 9885)
   belonging to the same saved session while the managed alias no longer
   resolved, and in §9 a live managed child (PID 152751, exact managed env,
   pane `w19:p4`) kept running for minutes after its mailbox had no
   `activeRequestId`. Reclassifying on the alias alone would have retired a
   mailbox — and possibly a live pane — whose process was still working, i.e.
   turned the current fail-closed behaviour into silent data loss.
   Corrected rule: take the lost branch only on *positive* evidence of absence —
   `managedAgentPresence` returning `lost`/the pane-survives-as-shell shape
   (`index.ts:3543-3588`, which requires no agent, no session and no activity
   record on the exact pane past `STARTUP_TIMEOUT_MAX`) or an equivalent
   out-of-band proof that the exact process for the exact saved session is gone.
   `agent_not_found` from one lookup is never that proof; keeping the refusal
   (even as `internal_failure`) is the safer behaviour until such proof exists.
2. Read-only operator checks before any recovery: `herdr agent list` and
   `herdr pane get w19:p3` to establish whether the generation is absent or merely
   unnamed; retrieve the durable result first (`hasDurableResult` refuses a close
   while an unretrieved result exists, `index.ts:5247-5252`, `5274-5279`).
3. Prefer `agent_close`'s refusal path (category `target_not_found`,
   `index.ts:5316`) when the intent is to abandon: it refuses *before* any Herdr
   mutation.

## 6. Distinct failure modes

| # | Mode | Where |
| --- | --- | --- |
| F1 | Route-clamp empty generation: `stopReason=length`, `output=1`, no text at ~268k on a 272k window | `index.ts:17701-17712` (`turnEmptyGeneration`); ADR 0028 records the same observation |
| F2 | Truncated reply at the output limit (`length` with text) | `index.ts:17700` (`turnCutOff`) → cut-off correction `index.ts:18148-18158` |
| F3 | Correction-budget exhaustion (`MAX_RESPONSE_CORRECTIONS=2`, shared between contract and cut-off kinds) publishing a terminal `failed` result | `index.ts:443`, `18130-18143`, `18222-18238` |
| F4 | Compaction/settlement race: settlement does not consult `contextCompactionInFlight`; `awaitingContinuation` is cleared by any `message_end`; `onComplete` continues even after a settled failure | `index.ts:17713`, `18127`, `18620-18627` |
| F5 | Continuation answer discarded (no `activeRequestId`) — silent loss of the real final response | `index.ts:17930-17936` |
| F6 | Lost generation that still looks live ⇒ close lookup `agent_not_found` ⇒ `internal_failure`/`close` on continue | `index.ts:3505-3587`, `5064-5086`, `herdr.ts:2238-2250` |
| F7 | Silent compaction failure / no trigger observability (no durable record on `onError`) | `index.ts:18551-18556` |

## 7. Minimal patch seams (owner decides)

1. `index.ts:18127` — add `contextCompactionInFlight` to the settlement guard
   (return early, as for `awaitingContinuation`) so a settlement cannot publish a
   failure while a compaction continuation is pending for the same request.
2. `index.ts:18620-18627` — before sending `CONTEXT_COMPACTION_CONTINUATION`,
   check that the compaction's `requestId` is still `state.activeRequestId`;
   otherwise the assignment is already settled and the continuation turn can only
   discard its answer.
3. `index.ts:18551-18556` — record `pi_herdsman_state_error` (or a dedicated
   diagnostic entry) on compaction error, and record one bounded line whenever
   the budget check decides (`tokens`, `contextWindow`, `budget`, fired/skipped
   reason). This is what would settle §3 without guesswork.
4. `index.ts:3493-3503` + `5064-5086` — treat close-path `agent_not_found` as
   lost presence (§5 recovery).
5. ADR 0028's deferred settle-time trigger remains the structural follow-up for
   the budget boundary (do not re-litigate it inside this incident).

## 8. Open questions

- Was `w19:p3`'s process alive at 10:14:06, and did Herdr ever carry the alias as
  the agent's `name`? (needs `herdr agent list` / `pane get`, read-only)
- Which build was actually loaded at the incident: `bq06k07…` (per the compaction
  system message) vs `33n2764…` (per earlier `ps` output)? §4 evidence favours
  `bq06k07…`; the `S33` file present today cannot have contained the marker the
  worker read.
- Did the same absent-target refusal occur for a second delivered worker? Not
  found in the files inspected; treat as owner-supplied until shown. (Note from
  §9: `result:bus-listen#30` at `10:48:51.735Z` shows bus-listen was later
  recovered and completed another assignment, so an absent alias there was
  recoverable, not proof of absence.)
- §9/§10: which of the request-bound guards below is the smallest sufficient set,
  and does pi-vcc's summary need a provenance stamp (assignment request id +
  attached-file digest) so an orphan turn cannot reconstruct a stale task?

## 9. Second incident — binary-details, successful result + orphan compaction continuation

Added 2026-10-07 from read-only evidence. This is a **different session and
request** from §1-§5: worker session
`/home/saurabhj/Projects/dev/agent-radar/.pi/sessions/children/2026-10-07T10-18-18-022Z_01a115de-fe26-7653-8434-ebabf994987a.jsonl`
(872 lines), mailbox `…/mailboxes-v4/8543d03fef03c61267f3bf556cc8a948/state.json`,
owner still `01a10a58-…`, run `147257bf-326c-465a-b1da-85205ee78576`,
pane `w19:p4`, label `binary-details`, alias `binary-details_b1515192161ba051`
(matches `sha256("w19\0binary-details\0147257bf-…")[0:16]`).

### Proven timeline

| Time (UTC) | Event | Evidence |
| --- | --- | --- |
| 11:24:23.546 | lead `agent_continue` on session `01a115de-…` creates request `023aac21-41ec-4a9a-a0dd-a575e89d9a80` | lead session, toolCall |
| 11:24:23.895 | mailbox accept (`lastAck.acknowledgedAt = 1791372263895`) | mailbox `state.json` |
| 11:24:23.911 | assignment prompt delivered to the child (attached `spec.md bytes="8826"`) | child session user message |
| 11:26:31.369 | last tool boundary of the request, `stopReason=toolUse`, `totalTokens=210,987` → **budget satisfied, compaction requested** | child session |
| 11:26:31.477 | completion `stopReason=error`, 0 tokens | child session |
| 11:26:31.495 | correction #1: `invalid_response: A nonempty inline response is required` | child session user message |
| 11:26:43.897 | **successful settlement** — completion `stopReason=stop`, `totalTokens=213,220`, nonempty report ("not started; nothing was written in this turn") | child session |
| 11:26:43.916 | mailbox written (`updatedAt = 1791372403916`); no `activeRequestId`, `completedRequestId=023aac21-…` | mailbox `state.json` |
| 11:26:43.942 | pi-vcc compaction commits: `tokensBefore=213220`, `fromHook=true`, `reason="manual"`, `sourceMessageCount=226`, `firstKeptEntryId=1afd2ee7` | child session `compaction` entry (the only one in this session) |
| 11:26:43.959 | **compaction continuation delivered** (`CONTEXT_COMPACTION_CONTINUATION`) — 17 ms after the compaction, 62 ms after the final answer | child session user message |
| 11:26:44.028 | **lead receives the durable result** `status=completed`, `Result ref: result:binary-details#2` — 69 ms *after* the continuation | lead session `pi-herdsman-agent-result` |
| 11:26:47.447 → 11:28:48.833 | **orphan continuation turn**: 25 further tool turns (26 assistant messages incl. the abort) with no `activeRequestId`; the child reasons about a stale task (see below) | child session |
| 11:27:06.519 → 11:27:06.812 | lead `agent_continue` refused: `agent_busy / The exact Pi session is already represented by active managed work / Operation: continue` | lead session tool result |
| 11:27:13.158 | `agent_inspect` shows the child is **live**: foreground `/nix/store/lly2cvdp1rlv2gsc3plz2jdz6b3v9702-pi-bolt-child-0.7.1/lib/pi-bolt/pi … --system-prompt /tmp/pi-herdsman-1000/prompts/… --append-system-prompt <active_agent name="worker"/>` | lead session tool result |
| 11:27:32.239 | `agent_interrupt` refused: `agent_busy / Agent has no interruptible active operation: unknown / Operation: interrupt` | lead session tool result |
| 11:27:41.393 | `agent_steer` refused: `agent_busy / Agent is not currently accepting steering: unknown / Operation: steer` | lead session tool result |
| 11:28:50.104 | child session records `stopReason=aborted` — the owner's single Escape in the exact pane | child session |
| ~11:28:56 | lead spawns `herdr agent wait binary-details_b1515192161ba051 --until idle` | lead session `bg_task` |

### Why this answers the brief's questions

**Does a successful settlement reproduce the same race? Yes — proven.** In §1 the
settlement published a `failed` result; here it published a **`completed`** one,
and the compaction continuation still fired 17 ms later and ran an
assignment-less turn for ~2 minutes. The coupling failure is therefore not about
the result status: `settleCurrentAgent` never consults the in-flight compaction
(§2 point 3), and `compactManagedContext`'s `onComplete` sends the continuation
unconditionally (`index.ts:18620-18627`). Both variants of the bug — premature
failure (§1) and ghost success + orphan turn (§9) — come from the same two seams.

**Stale provenance is real, not just confusion.** The compaction summary's
`[Session Goal]` quotes the attached `spec.md` with `bytes="8582"`, while the
assignment delivered at 11:24:23.911 attached `bytes="8826"` — the pre-existing
snapshot of an earlier assignment. The orphan turn then reconstructed the wrong
task, reported "context compacted twice" (the session records exactly **one**
compaction) and found `.pi-herdsman/tasks.md` fully ticked against a 15/15-complete
change. Treat the orphan's self-description as evidence of summary/assignment
provenance drift, not as fact.

**After `activeRequestId` is gone there is no in-process control path.** With no
active request the control state resolves to `unknown`
(`core.ts:512-546`: an `activeRequestId`-less worker that is not
`idle`/`done` falls through to `return "unknown"`), so
`steerAcceptanceAllowed` is false (`core.ts:555-…`) and interrupt requires
`controlState === "working"` (`index.ts:7992-7995`) — both refusals observed
verbatim. `agent_continue` is refused earlier because the live record is not
"idle" (`index.ts:7194-7206`, `7240-7253`). The only containment is a
**turn-level abort through the exact pane** (`aborted` at 11:28:50.104), which
requires exact identity proof and belongs to the operator/owner — consistent with
the task's account. pi-herdsman's own control plane being request-gated is the
reason `unknown` is the honest answer, not a bug to paper over.

## 10. Request-bound guards (proposal only — no code changed)

Minimal set, in the order that removes the most risk per line. Every seam is
session-global state today; each guard binds it to a request.

| # | Seam | Guard |
| --- | --- | --- |
| G1 | `index.ts:18617-18633` (`compactManagedContextIfOverBudget` → `compactManagedContext` `onComplete`) | Capture `requestId` (already known: `compactionContinuations` carries it) and skip `pi.sendUserMessage(CONTEXT_COMPACTION_CONTINUATION, …)` when `state?.activeRequestId !== requestId`. Release the hold either way. This alone prevents the orphan turn in both incidents. |
| G2 | `index.ts:17930-17936` (`settleCurrentAgent` entry) + `18127` | Make the hold request-bound: `awaitingContinuation: { requestId } \| undefined` instead of a boolean, cleared only by a `message_end` for the same request; and treat `contextCompactionInFlight.requestId === state.activeRequestId` as a settlement guard (defer, as the background-settlement hold already does at `18100-18126`). |
| G3 | `index.ts:18227-18249` (result flush) | Record the settled `requestId` (`settledRequestId`) and have every deferred callback (`onComplete`, correction retries, background final-response prompt at `18377-18405`) no-op when it does not match. |
| G4 | `index.ts:18551-18556` | Record a durable entry on compaction error and on each trigger decision (see §11) so G1-G3 are observable in the same evidence trail. |
| G5 | `index.ts:7194-7206`, `7240-7253`, `7970-7995` (control eligibility) | Do **not** widen these to accept an `activeRequestId`-less live worker. Instead surface the orphan explicitly: an `unknown`/`working`-without-request state already exists; expose it as an actionable operator signal (e.g. `available_tools` note "orphan turn running; abort through the pane") rather than as a controllable target. `agent_not_found` from one lookup must stay a fail-closed refusal (§5 correction). |
| G6 | pi-vcc summary provenance (outside this repo) | Stamp the compaction summary with the assignment `requestId` + attached-file digests, or have Herdsman re-assert the current assignment identity after a compaction the way it re-asserts session/definition entries (`reassertManagedIdentity`, `index.ts:18507-18524`). This is what makes a stale `[Session Goal]` detectable. |

## 11. 200k ledger — testable hypotheses and narrowly scoped telemetry

The two incidents together show the ledger **can** fire (210,987 → compaction
committed 12.5 s later) and **can** stay silent across many over-budget
boundaries (§3). Separating "did not fire" from "fired and had no effect" needs
one bounded record per evaluation; nothing in the product emits it today.

Proposed telemetry (one JSON line per decision, bounded, no prompts):

```
{ requestId, turnEndStopReason, tokens, contextWindow, budget,
  fired: boolean, skipReason: "notToolTurn" | "retirement" | "noUsage" |
  "underBudget" | "noRequest" | "capReached" | "inFlight" }
```

Plus one record for compaction outcomes: `outcome: "completed" | "error"`,
`requestId`, latency, and — at commit — the delta between the recorded
pre-compaction `tokensBefore` and the trigger-time `tokens`.

Then the hypotheses become decidable:

- **H1 "trigger fired but the effect lagged"** — testable by matching a `fired:true`
  record against the compaction entry's timestamp; predict 1 `fired` record per
  committed compaction and no committed entry for `fired:false` boundaries.
- **H2 "usage never reflected the prompt"** — testable by comparing the recorded
  `tokens` against the same turn's completion `usage.totalTokens` in the session.
  If `tokens` trails the completion's `totalTokens` by a turn, the ledger is
  always one boundary late.
- **H3 "the effective budget differed from the source"** — testable because
  `budget` is recorded; a value other than 200,000 (or a `contextWindow` that
  makes `min(configured, window - 32_768)` differ) names the culprit directly.
- **H4 "the request-level cap or an in-flight flag suppressed it"** — testable
  from `skipReason: "capReached" | "inFlight"`; `capReached` would show a third
  compaction per request being skipped, `inFlight` a leaked flag.

Narrow reproduction (no production edits): a single worker session driven to
cross the budget at tool boundaries while the harness records turn
`stopReason`/`totalTokens`, then one deliberate `length` completion and one
compaction — this is exactly the §9 shape and needs only the telemetry above to
stop being ambiguous.
