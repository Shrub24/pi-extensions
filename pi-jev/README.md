# @vanillagreen/pi-jev

A substrate for [Jev](https://typesafe.ai/) decisions in the Pi coding agent, plus two consumers that use it.

The substrate is a small one: a *core*, one per session, to which consumers register the questions they want about a **subject**. A subject is the work under judgement — one call, one child, one session state — and it is the unit both of batching and of delivery. Each consumer either **queues** (it wants answers eventually and nothing now) or **sends**, which asks immediately and flushes everything already queued for that subject with it.

A flush builds the **context blocks** its questions name — `ask`, `user_intent`, `plan`, `tool_history`, `toolbox`, `authority`, `child_work` — once each, at fire time, and sends them under those names in **one request**. So two consumers asking about the same call ride one request, and a question that arrives after the flush is served from what the first one paid for. Two triggers onto the *same* call share the subject: its `tool_call` hook and its permission ask both key on Pi's tool call id, which is why a queued plan-alignment question is answered by the gate's flush rather than a second one at the turn boundary.

Subjects stay apart on purpose. An orchestrator's check-in about a child and a permission ask about that child's call are different work at different moments: they flush separately, so an unrelated nudge never arrives stacked on a gate's decision, and a check-in is never asked mid-call where its answer would be stale by the next tool result.

The two consumers shipped here:

- **`permission-authorizer`** — the blocking one. A link in [@gotgenes/pi-permission-system](https://github.com/gotgenes/pi-packages)'s authorizer chain: an ask reaches it, it answers `allow`, `deny`, or `defer` from the pack's deterministic composition, and the permission system stays authoritative. It starts in **shadow mode**, recording what it would have decided while deferring every ask to the prompt you would have seen anyway.
- **`tool-intent`** — the riding one. It never gates anything. It watches tool calls, and when a call contradicts the plan the agent stated a moment earlier, it says so as a nudge. It queues rather than sends, so it costs nothing until some other consumer asks about that action.

The two are separate extension entries: either loads without the other, and the registry is what keeps them on one core when both are present.

### Subagent work: two triggers, one question set

The subagent questions are: does this work serve what the orchestrator is trying to accomplish, and does it stay inside the agent's role? Both are advisory — a subagent question never denies, because revoking a child's tool on a guess strands work the parent cannot see. They ride two triggers:

**A forwarded ask.** The permission system forwards a subagent's ask to the session that spawned it, and the forwarded facts carry the child's name. The action's own group is what the gate composes over; these two questions are the orchestrator's, and the permission consumer deliberately does not include them — an unresolved advisory in that composition would defer every forwarded ask. A violation becomes a steering sentence for the orchestrator, the party that can redirect or retire the child.

**A check-in on the fleet.** pi-subagents already marks a step `active_long_running` or `needs_attention` on an elapsed-time threshold and appends a `subagent_control_notice` to the session. With `orchestratorCheckInMs` set, pi-jev scans those notices at each turn boundary and when the agent settles, asks the same two questions about each child the notice names, and — on a violation — wakes the orchestrator with `followUp` + `triggerTurn`, carrying the findings in one message. That wake *is* the keep-alive: a check-in costs nothing until a child looks off, so a quiet fleet is silent and a busy one is read at most once per notice. A notice already read is never read again.

Set `orchestratorCheckInMs` (0 disables; env `PI_JEV_CHECK_IN_MS`) to the cadence you want the fleet read at — a few minutes is the useful range, since the notices themselves are already elapsed-time gated by pi-subagents.

## Install

- npm: `pi install npm:@vanillagreen/pi-jev` (both entries load).
- From this repo: `pi -e /path/to/pi-jev/extensions/permission-authorizer.ts -e /path/to/pi-jev/extensions/tool-intent.ts`. Either entry alone works.

For the permission link, name it in the permission system's configuration:

```jsonc
{
  "authorizerChain": ["pi-jev"]
}
```

Registration alone grants no authority. Until the name appears in `authorizerChain` the link decides nothing, and the judge is never called.

The judge needs a TypeSafe key: install [pi-typesafe](https://github.com/DevMortimer/pi-typesafe) and run `/typesafe login`, or set `TYPESAFE_API_KEY`.

## The substrate

```ts
core.queueDecisions({ action, actionKey, consumer, questions })   // costs nothing, asks nothing
core.sendDecisions ({ action, actionKey, consumer, questions })   // asks now, and flushes the queue with it
```

- A **send** takes the action's whole queue, plus every active consumer's standing questions, plus the caller's own, groups them by the state they read, and asks one request per group in parallel. Each consumer is handed only its own readings back.
- Answers are cached per action and question, and concurrent sends for one action share one in-flight request. A consumer that arrives after the flush pays no request and no latency — which is how “ask everything about this action at once” works inside hooks that fire in an order nobody controls.
- A queued question is answered by the next send for that action, or at the turn boundary (`turn_end`), or — if `queueFlushGapMs` is set — after that many milliseconds. A timer flush never runs outside a turn: an idle session has no action left to gate and nobody to nudge.
- Whole consumer question sets are packed into chunks greedily and never split, so a failed request means no consumer in it holds half its answers; other groups still answer.

A third consumer needs to add a file that calls `acquireCore` and registers itself. Nothing in the core knows about permissions.

### Tool choice and the policy file

The intent entry also runs a second consumer: **tool choice**. A policy file at `~/.pi/agent/pi-jev/tool-policy.yaml` (user-owned, like the settings file — a project cannot steer it) says which tool you would rather see for what:

```yaml
preferences:
  - tool: grep
    match: "rg "           # only when the call's value contains this
    reason: ripgrep is faster for content search and streams matches
margin: 0.2                # how clearly the judge must prefer it before a nudge
```

When a tool call matches a preference, the consumer queues `tool.choice` — a single choice question naming the tool in use and the policy's alternative. The judge answers with the tool it would pick and per-option probabilities; when its pick is the policy's alternative with a margin at or above `margin`, the nudge quotes the policy's reason: *"your policy prefers grep for `rg 'retry' src/`: ripgrep is faster for content search. Use it, or say why this call needs the tool it chose."* A pick without a clear margin stays quiet, and a judge that picks the tool in use stays quiet — the nudge fires only when the judge endorses the policy's alternative against the call that was made.

No policy file, or an unreadable one, means no choice question and a one-time notice.

## The question pack

| question | kind | role | refuses when |
| --- | --- | --- | --- |
| `safety.no_material_harm` | noul | veto | the action destroys data, moves private data off the machine, or reaches beyond the working tree |
| `safety.reversibility` | score, 4 levels | veto, unmeasured | level 3: the action cannot be undone at all |
| `intent.conflicts_with_user` | noul | veto | the user's instruction forbids what the call does |
| `intent.matches_plan` | noul | advisory | the call contradicts what the agent said it would do |
| `scope.supports_active_task` | noul | advisory | the call serves nothing the user asked for |
| `tool.fit` | noul | advisory, unmeasured | another available tool fits the intent plainly better |
| `tool.choice` | choice | advisory, unmeasured | the judge picks the policy's preferred alternative with a clear margin |
| `orchestrator.intent_alignment` | noul | advisory, unmeasured | the work serves what the orchestrator is trying to accomplish |
| `agent.role_adherence` | noul | advisory, unmeasured | the work stays inside the role the agent was given |

Every question names the blocks it reads, and only those are built and sent. The permission link's questions read the ask, the instruction, the plan, the tool history and the toolbox; harm and reversibility read the ask alone, because they are properties of the call rather than of the session.

- Answers are composed by one rule: a **measured** veto band that is violated refuses the ask, every question satisfied allows it, and anything else — including a missing answer — defers.
- An **unmeasured** veto may not refuse: it defers and raises a notice instead. A bar with no labelled samples behind it has no evidence for holding your work, and pi-warden's four candidate questions all landed at the base rate.
- Each question names three cases, not two — the user asked for it, the user ruled it out, or the user did not mention it. Only an outright conflict refuses an action; silence lands in the middle band and reaches you as a prompt.
- Every request record carries the whole ask's reading: each question's band, its probability or level, the edge it was read against, and whether that edge is measured.

## What it does

- Answers a permission `ask` from the pack above, in `defer` unless the composition decides otherwise, and reports once per session when it cannot reach the judge instead of deferring silently forever.
- Records one JSONL record per request and one per permission resolution, joined by `requestId`, plus a lifecycle record when a link is registered or removed — so “did it register?” is answerable from the log rather than from a session that looked quiet.
- Nudges the agent when an advisory band is violated, recorded always and delivered only when a delivery switch is on. Veto findings belong to the permission consumer, advisories to the intent consumer: one signal, one sentence.

## Settings

Open `/extensions:settings`; values live under `kendex.extensionManager.config["@vanillagreen/pi-jev"]` in `~/.pi/agent/settings.json`. Only the user file is read: a project must not be able to put the judge into `live`, move a band edge, or redirect its decision log.

- `mode`: `shadow` (default) or `live`.
- `authorizerName`: the link name for `authorizerChain`; default `pi-jev`.
- `defaultThreshold`: the veto band edge, default `0.9`; `advisoryThreshold`: the advisory edge, default `0.85`. A per-question `thresholds` map in the settings file overrides either once a question has been measured.
- `model`, `timeoutMs` (default 3000), `maxRequestsPerSession` (default 200).
- `stateRetention`: `hash` (default) or `full`.
- `recentUserMessages` (2), `recentToolCalls` (5), `maxPlanChars` (500), `maxToolbox` (12), `maxStateChars` (4000).
- `deliverNudges` (default false): send the permission consumer's veto findings to the agent as a steer. `deliverIntentNudges` (default false) is the same switch for the intent consumer's advisories. `deliverSubagentNudges` (default false) sends the orchestrator's steering sentences when a forwarded ask departs from its dispatch or its role. All off until the log shows how often a nudge would fire on your own sessions.
- `queueFlushGapMs` (default 0): how long a queued question may wait with no send before it is asked anyway, in milliseconds. 0 leaves it to the next send or the turn boundary.
- `logFile`: default `<agent dir>/pi-jev/decisions.jsonl`.

Environment overrides, for headless runs and tests: `PI_JEV_MODE`, `PI_JEV_MODEL`, `PI_JEV_TIMEOUT_MS`, `PI_JEV_THRESHOLD`, `PI_JEV_AUTHORIZER_NAME`, `PI_JEV_STATE_RETENTION`, `PI_JEV_API_KEY`, `PI_JEV_LOG`. TypeSafe's own caps (`PI_TYPESAFE_MAX_*`) apply underneath and can only lower this judge's budget.

The key: a settings `apiKey` wins, then `PI_JEV_API_KEY` in the environment, then pi-typesafe's own resolution (`TYPESAFE_API_KEY`, then the key `/typesafe login` stored). On a shared machine prefer the env var — a key in the settings file is read by every process that loads the entry.

## Nudges

A band that is violated but may not decide anything becomes a nudge — a sentence naming the question, its reading, and the mismatch — recorded in the decision log always and delivered to the agent only when its consumer's switch is on. Delivery is a steer, so it lands after the current tool batch and shapes the next call. Each signal belongs to exactly one consumer: a veto finding to the permission link, an advisory to the intent consumer, so one action never produces two sentences about the same thing.

The defaults are off for the same reason the mode defaults to shadow: a nudge spends the agent's attention, and pi-warden's own numbers show what a miscalibrated advisory costs — 52 of 67 steers over two days were credential warnings, 51 of them about fixture values read from a test file, and the fix was to stop announcing them. `bun scripts/report.ts` prints each advisory's fire rate so the threshold is chosen from your sessions rather than from this file.

## Shadow mode, then calibration

Run normally for a while. Every ask the judge sees is recorded with its probabilities, and the permission system's own resolution of that ask — which is usually a person's answer — is recorded beside it. Then:

```bash
bun scripts/report.ts
```

The report prints how often the would-be verdict matched the human, how many would-allows the human refused, each question's band counts, and per-question separation (AUC and a threshold sweep via `pi-typesafe/calibrate`, when it is installed). The numbers that matter differ by role: a veto edge is a precision question (how many denies you would have approved), an advisory edge is a recall question (how often the nudge fires on something worth mentioning, and how often it stays quiet when it should not).

Move a question's threshold only after its samples say where the edge belongs, and keep `stateRetention: "hash"` while measuring — the probabilities and the labels are enough for the decision-level numbers, and a state kept is conversation content kept. Switch to `full` only when you want to replay states through a reworded question.

## Limits, stated plainly

- `safety.reversibility` and `tool.fit` have no labelled samples behind their bars yet, and say so in the log, the deny text, and the report.
- The intent consumer's nudge can be late. A call nothing gated is read at the turn boundary, which is too late to steer that turn; a gated call is nudged while the human is already being asked. `queueFlushGapMs` is the middle ground, and the reading is recorded either way.
- The judge sees the conversation at the node that adjudicates the ask. A forwarded ask from a subagent is judged against the serving session's instruction, which is the one that carried the authority to ask.
- It never reads file contents, diffs, or tool output; the state is the ask, the user's messages, and a line per recent tool call.
- Jev knows only what those fields say. Deterministic policy remains the outer boundary: the permission system caps an `allow` on its `external_directory` and `path` surfaces to `defer`, whatever the judge says.
- A question that has not been calibrated has no measured edge. The defaults are band settings, not results.

Maintainer notes are in [DEVELOPMENT.md](DEVELOPMENT.md).
