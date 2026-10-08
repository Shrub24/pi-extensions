# Pi v1.1.0 lifecycle contracts relevant to worker coordination

Read-only upstream investigation. **Pinned source:** `earendil-works/pi` tag
`v1.1.0`, peeled commit `abe508e1b89912adde45528136c3221eb69acdd7`.
All paths and line numbers below are from that immutable commit; verify through
GitHub URLs of the form
`https://github.com/earendil-works/pi/blob/abe508e1b89912adde45528136c3221eb69acdd7/<path>#Lx-Ly`.
Do not substitute later `main`. No local project code was inspected, and no
production or runtime state was changed. PR issue linkage note: #10607 is an
issue, not a pull request; its repository issue comments describe implementation
commit `503c60552` (merge/commit details can be separately verified if needed).

## Owner assessment against the local implementation

The protocol-level warning below needs a narrower reading for this fork. Our
`compactionAbortedRun` marker is consumed inside `agent_settled`, not used to veto
Pi's continuation decision. In a verified 1.1.0 runtime, the new event's
`aborted` field can replace that particular before-settle inference. Source:
`agent-session.ts:1078-1085, 2434-2444, 2764-2767`; our current consumer is
`pi-herdsman/extension/index.ts:18920-18944`. This remains a proposed migration,
not an implemented or tested replacement. Interrupt replacement handling must
retain its priority, and an abort needs an explicit disposition rather than
being treated as successful assignment completion.

It cannot replace the separate captured-request comparison in compaction's
`onComplete`, outstanding-work/result validation, or generation identity checks.
Those decide whether an assignment can continue or complete, not whether Pi
aborted the run. The existing actionable before-settle boundary remains useful
for boundary decisions; it is not itself newly introduced by this release.

OSC status is suitable for the Radar/mux adapter's presentation observations.
Use direct Pi lifecycle events, correlated with a live process generation and
assignment, for execution reconciliation. Preserve the rpiv questionnaire relay:
custom extension UI is not universally reported as blocked by native Pi.

## Summary

`agent_settled.aborted` is a useful **final outcome discriminator**, but not a
replacement for a pre-settlement continuation veto: it is emitted only after Pi has
already decided no automatic retry, compaction recovery or queued continuation
will run. Its boolean reports whether abort was requested, not whether an
abort-shaped provider response occurred or whether a particular request is
still eligible for continuation. Preserve the local pre-settle/request-bound
guards; add the settled flag as an authoritative reconciliation signal only
for the completed session-run outcome.

Pi v1.1.0 also documents and exposes a final actionable `agent_before_settle`
boundary. It may append durable entries and request one continuation, while
`agent_settled` is notification-only. For a mux coordinator this makes a clean
separation: boundary to make/validate continuation decisions; settled to learn
that Pi will not continue automatically. OSC 7501 adds a separate human-facing
process-state signal (`idle`, `working`, `blocked`, `done`, `error`, `clear`),
not identity or assignment authority.

## Settlement semantics and event ordering

**Contract / public docs.** In JSON events, `agent_end` closes one low-level
agent run; automatic retries, overflow recovery, compaction retry, steering and
follow-up may still run afterward. `agent_settled` means Pi has no remaining
automatic work for that session-level run; `aborted` is true when it ended
because it was aborted (`packages/coding-agent/docs/json.md:43-56`). Extensions
likewise distinguish the final actionable `agent_before_settle` from final,
notification-only `agent_settled` (`docs/extensions.md:62-67`).

**Implementation order.** `_runAgentPrompt` resets abort state, runs `agent.prompt`,
then loops post-run handling, pre-settle boundary and `agent.continue`; its
`finally` flushes pending bash/custom messages before `_emitAgentSettled`
(`src/core/agent-session.ts:1822-1850`). Post-run handling gives abort priority;
otherwise tries retry, checks compaction, then considers queued work; comments
explicitly state that `agent_end`-handler queues require a fresh run before
pre-settle handlers (`:1853-1891`). The settled emitter snapshots
`_agentRunAbortRequested`, awaits extension handlers first, then emits the
session event; deferred actions requested by settled handlers execute after the
notification dispatch (`:1078-1095`; boundary test below). This ordering means
"settled" is not the right place to veto a continuation already selected.

- **Normal response/completion:** low-level agent run emits `agent_end`; Pi
  processes retry/compaction/queue conditions; if continuation is not needed,
  it invokes `agent_before_settle` if registered; absent newly queued work or
  accepted continuation, one terminal `agent_settled {aborted:false}` follows.
  A normal assistant success is not by itself final until this point.
- **Abort:** `abort()` sets `_agentRunAbortRequested` while active, aborts retry
  and compaction, marks `_abortDuringBeforeSettle` if currently in that boundary,
  then waits for idle (`:2436-2445`). Final emission reads the request flag at
  settled (`:1083-1085`). Test: a last successful assistant response followed by
  abort still yields `{type:"agent_settled", aborted:true}`
  (`test/suite/agent-session-boundaries.test.ts:726-736`). A separately tested
  streaming abort persists an assistant message with `stopReason:"aborted"`
  and emits agent_end then settled (`test/suite/agent-session-retry-events.test.ts:371-397`).
- **Retries:** each provider attempt can produce its own `agent_end`; `_handlePostAgentRun`
  retries eligible errors and returns true to continue. Only after retries and
  related recovery are exhausted does terminal settlement occur
  (`agent-session.ts:1864-1885`). The retry event test asserts a single settled
  notification after automatic retry; event order includes all attempts first
  (`test/suite/regressions/6363-agent-settled-event.test.ts:29-60`).
- **Compaction:** overflow recovery may compact then retry (`_checkCompaction`
  and `_runAutoCompaction`, `agent-session.ts:3011-3050, 3097-3217`); threshold
  compaction may occur without retry. Successful retrying compaction returns
  true; no-retry compaction checks queued messages and may continue
  (`:3205-3211`). Compaction abort/failure emits `compaction_end`; retrying
  recovery can continue after that event. Thus `compaction_end` is not a final
  session-run boundary. `agent_settled.aborted` marks user/requested run abort,
  while compaction has its own `aborted` property on `compaction_end`.
- **Queued steering/follow-up:** low-level loop drains queues before agent_end;
  queues can be created by agent_end handlers and force another run before
  pre-settle (`:1888-1890`). If no handlers exist, pre-settle simply checks
  queued messages (`:1893-1895`). During boundary, `result.continue || queued`
  controls continuation, but a fresh context validation must pass
  (`:1902-1911`). `agent_settled` handlers may schedule runs, but those actions
  are deferred until all settled handlers finish; test asserts both handlers see
  idle before next agent_start (`test/suite/agent-session-boundaries.test.ts:400-435`).
  Pending user prompts accepted as handled need not start a run: RPC docs require
  clients not to wait for settled when disposition is `handled`
  (`docs/rpc.md:60-71`).

**Does `aborted` replace a before-settle discriminator? No.** It distinguishes
an aborted final outcome from a non-aborted settled outcome, even when the last
assistant response succeeded. It does not run before settlement, does not carry
request identity, does not report why an abort happened, and does not guard an
extension's continuation decision. The extension API explicitly says settled is
final/notification-only. For coordination, use it to close/reconcile an already
observed run; retain a before-settle or equivalent request-bound discriminator
to stop stale continuation. Do not infer that `aborted:false` means successful
assignment completion: non-retryable errors also settle non-aborted.

## Extension, JSON and RPC availability

- **Extension API:** `AgentSettledEvent` is `{type:"agent_settled"; aborted:boolean}`
  (`src/core/extensions/types.ts:1004-1009`); `ExtensionAPI.on` registers
  `agent_before_settle` and `agent_settled` (`:1614-1620`). The latter is
  notification only; only before-settle returns entries/continue. `agent_end`
  carries `willRetry` for that low-level run (`agent-session.ts:198-205` and
  extension types `:989-1009`).
- **JSON and RPC event stream:** event union preserves `agent_settled` unchanged
  (`src/modes/json-event.ts:17-18, 46-60`). RPC serializes each session event
  (`src/modes/rpc/rpc-mode.ts:353-359`). Public JSON docs define the event
  (`docs/json.md:43-56`). RPC docs say subscribe/consume after prompt; `agent_end`
  is not final and clients needing terminal completion should wait for
  `agent_settled` (`docs/rpc.md:60-71`). RPC `waitForIdle` and `collectEvents`
  resolve on this event (`src/modes/rpc/rpc-client.ts:467-506`). `agent_settled`
  is not a prompt-command response and `disposition:handled` produces no run.
- **Limits:** `aborted` is boolean and run-scoped only; no request/assignment id,
  success/failure payload, active worker identity or persisted ownership token.
  A consumer must correlate an event with its own observed prompt/session run and
  account for commands that never started a run.

## OSC 7501 program status

**Contract/type.** `ProgramStatus` (`packages/tui/src/program-status.ts:8-17`)
  has `state: idle|working|blocked|done|error|clear`, optional `app`, `kind`
  (`permission|question|auth`), and one-line `message`. The encoder always emits
  `state`, accepts only app names matching `[A-Za-z0-9_.+-]{1,32}`, emits `kind`
  only for blocked, strips/replaces control characters, UTF-8 truncates message
  to 2048 bytes, base64-encodes `msg`, then wraps OSC 7501 (`:33-53`).
  Example wire format: `ESC ] 7501 ; state=blocked:app=pi:kind=permission:msg=<base64> ESC \\`.
  Feature probe query is `ESC ] 7501 ; ? ESC \\` (`:20-24`).
- **Interactive reporter / transition rules.** `ProgramStatusReporter`
  (`packages/coding-agent/src/modes/interactive/program-status-reporter.ts:11-110`)
  maps agent_start to working; assistant message_end updates current outcome to
  done or error (latest response wins, so successful retry clears earlier error);
  compaction_start remains working; compaction_end records idle on abort or
  error on failure, unless a later success updates outcome; settled maps aborted
  to idle, otherwise to latest run result (`:35-68`). Blocked dialogs override
  underlying state, most recently opened blocked source wins; clearing source
  restores underlying status (`:79-85, 103-109`). Compaction reports message
  "Compacting context"; working/done include session name; blocked uses dialog
  title or auth provider only; reporter states prompts and assistant output are
  never included (`:11-15`). Interactive mode sets blocked for extension dialogs
  and login flows (`interactive-mode.ts:2729-2742, 2810-2866, 6321-6334`), and
  routes session events to reporter (`:3412`).
- **Terminal API and transport:** `Terminal.setProgramStatus(status)` is required
  by the TUI interface (`packages/tui/src/terminal.ts:121-125`); implementations
  lacking support can no-op. `ProcessTerminal` retains latest status across stop
  and tracks support/query state (`:164-169`). It sends OSC query in the keyboard
  protocol startup batch, unless `PI_PROGRAM_STATUS=1|0`; auto-detection accepts
  status only when its reply arrives before DA1 (`terminal.ts:285-299, 302-329`).
  On stop it emits `state=clear` if supported and a status exists, then clears
  support flags (`:467-476`). Terminal tests cover query/reply ordering, explicit
  overrides, late replies/restart handling and clear/re-report (`packages/tui/test/terminal.test.ts:237-350`);
  encoding tests pin blocked/base64 and simple state output
  (`packages/tui/test/program-status.test.ts:10-48`).
- **JSON/RPC availability and limits:** no OSC 7501 field is added to the
  coding-agent JSON/RPC event protocol; program status is a TUI `Terminal` output
  side channel. The v1.1.0 public docs describe it for terminals/dashboards that
  support the escape sequence (`docs/terminal-setup.md:223-233`), and JSON/RPC
  docs independently expose lifecycle events. A headless RPC process may not
  have a terminal answering the probe; `PI_PROGRAM_STATUS=1` can force writes,
  but this is terminal escape output, not a structured RPC message. tmux and
  screen do not forward reports (`terminal-setup.md:233`). No identity, run id,
  assignment id, queue state, stable process identity, or durable completion
  semantics exist in the OSC payload. `done` is UI/process outcome, not proof a
  delegated task was accepted or completed. `idle` may mean startup/cancel; a
  blocked status may mask continuing underlying work. Values therefore support
  display/health hints only, never identity, ownership, or assignment authority.

## Other relevant v1.1.0 reconciliation changes and migration notes

1. **Final boundary and outcome:** `agent_before_settle` plus validated
   `continue` gives extensions the explicit last chance to commit durable
   context and schedule one more provider request (`agent-session.ts:999-1009,
   1893-1914`; `docs/extensions.md:66-67`). Migration: move decisions that
   suppress stale continuations before settled; use settled only to report final
   outcome. Treat an invalid continuation as rejected/error, not as completed
   assignment (`:1904-1910`).
2. **Retry-aware events:** `agent_end.willRetry` means one low-level run is not
   final; retry tests assert one final settled event only after retry sequence
   (`test/suite/regressions/6363-agent-settled-event.test.ts:29-60`). Migration:
   never close worker state solely on agent_end, even `willRetry:false` if queues,
   compaction or boundary continuation may follow.
3. **Queue/reconciliation visibility:** `queue_update` exposes pending steering
   and follow-up arrays (`agent-session.ts:204-208, 1045-1050`), but only a
   snapshot; continued delivery and settled remain lifecycle events. Migration:
   reconcile locally against the last queue_update, do not treat an earlier
   empty snapshot as authoritative after new events.
4. **Settled handler reentrancy:** scheduled runs are deferred until all settled
   handlers complete (`agent-session.ts:1089-1095`; boundaries test `:400-435`).
   Migration: do not assume a settled callback's scheduled prompt starts
   synchronously inside handler dispatch.
5. **Explicit prompt disposition:** RPC `started`, `queued`, or `handled`
   distinctions are needed before awaiting settled; a handled prompt starts no
   run (`docs/rpc.md:60-71`). Install event listener before sending prompts to
   avoid missing fast completion.

## Evidence and caveats

- **Pinned immutable ref:** tag `v1.1.0` = `abe508e1b89912adde45528136c3221eb69acdd7`.
- Changelog is used only to establish release grouping (`packages/coding-agent/CHANGELOG.md:7-21`);
  contracts above are grounded in source, tests and docs.
- Issue #10607 is closed, not a PR (`https://github.com/earendil-works/pi/issues/10607`).
  Repository issue comment records implementation commit `503c60552` and notes
  dialogs created by `ctx.ui.custom()` are not considered blocked because custom
  UI also hosts nonblocking loaders; that limitation is independently consistent
  with interactive reporter's explicit blocked call sites. The issue comment says
  the byte stream was tested under `script`, but not yet in a terminal displaying
  status. Treat third-party terminal rendering and support as nonportable.
- No later-main-only claims are used. Program status PR implementation may postdate
  or be absent from another snapshot; this report's source is exactly v1.1.0.
- No local Herdsman code was read or assessed; implications are protocol-level
  migration guidance for a backend-agnostic coordinator only.
