# Independent plan review — declared-background-task-lifecycle

Role: independent READ-ONLY plan reviewer (alternate review model, run `86808c39-5431-4c8d-9761-6d1b796682ef`).
Mode: review only. No edits, tests, probes, commits, or nested agents. `review.md` provenance is not approval.
Scope reviewed: `proposal.md`, `design.md`, `specs/background-task-retrieval/spec.md`, `tasks.md`, `handoff.md`, `context.md`, `deferred.md`.
Verdict: **BLOCK** — no P0, two P1 contract conflicts that must be reconciled before implementation authorization.

## Method

Read all seven artifacts end to end. Verified only the claims the plan makes load-bearing for its own gates, with narrow source reads (no broad recon):

- `ctx.mode` exists and is `"tui" | "rpc" | "json" | "print"`; `hasUI` is true in TUI **and** RPC.
  `pi-bash-processes/node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts:212,216-218`.
- `before_agent_start` can contribute system-prompt text: event exposes readonly `systemPrompt`; result type `BeforeAgentStartEventResult.systemPrompt?: string` "Replace the complete system prompt for this turn." `…/types.d.ts:694-702,1085-1088,1164`. So the TUI-only push-wait contribution is implementable.
- Native child binds `mode: "print"` — `pi-subagents/src/runs/shared/child-session.ts:469`.
- `sendMessage` options are only `{triggerTurn, deliverAs}` — no selective-cancel handle. `…/types.d.ts:1211-1216`.
- Timeout settings: `defaultTimeoutSeconds` default `0` ("disables timeouts") at `pi-bash-processes/package.json:68`; `defaultSoftTimeoutMs` default `600000` ("soft reminder … never kill the process") at `package.json:77`.
- Shared guidance is a single packaged block: `package.json:18` `"appendSystem": "./instructions.md"`; the block names `bg_status` and `bg_task action:"wait"` and describes log-read consumption.
- Existing CLI is the generated `pi-bg path|peek|read` bash helper plus PATH read wrappers: `pi-bash-processes/extensions/read-shim.ts:53-84,28-50`.

Note on tooling: the configured `review-policy` skill is **absent** at its advertised path (`/home/saurabhj/.agents/skills/review-policy/SKILL.md`; `/home/saurabhj/.agents` → `/home/saurabhj/.dotfiles/apps/agents` has no `review-policy`). I applied the standard findings-first P0/P1/P2 severity ladder and evidence-over-severity discipline (see Residual risks).

## Findings

### P1-1 — `bg_status` is unaccounted for in the reduced TUI surface; the shared prompt still names it, so the target surface can ship a prompt/schema mismatch or a surviving live-log path

Anchors:
- `design.md` Decision 1: "Use `bg_task` with normal actions `spawn`, `get`, `stop`, `list`"; "Normal TUI registration/guidance excludes wait/log/extend/clear as workflow choices."
- `specs/background-task-retrieval/spec.md` Scenario "TUI guidance and tool schema are assembled": "the normal schema SHALL expose spawn/get/stop/list" (bg_status unmentioned).
- same spec, Scenario "Shared installed guidance is used by a noninteractive child": "retained bounded wait and **required `bg_status`** SHALL be callable" (compat modes only).
- `tasks.md` 4.1 ("verify both modes, unknown-mode fallback, required `bg_status`/bounded-wait availability"), 4.5 (update `instructions.md`), 4.2 ("Remove live-log advertisements … render/details/activity/dashboard paths").
- `pi-bash-processes/package.json:18` (`appendSystem: ./instructions.md`) and the block itself, which instructs the model to use `bg_status` and `bg_task action:"wait"`.
- `pi-bash-processes/extensions/registrations.ts:58-95`: `bg_status` is a separate model-facing tool with actions `list|log|stop`; its `log` action returns `formatTaskLog(...)` and `fullOutputPath` details.

Failure mechanism: `instructions.md` is one shared append-system block applied to **every** session, including TUI. The plan's TUI schema is `bg_task` spawn/get/stop/list and explicitly drops `wait`; it never states the TUI disposition of `bg_status`. Either outcome is unreconciled:

1. If TUI drops `bg_status`, the shared block still tells the TUI model to call an unregistered tool (`bg_status`) and an unregistered action (`bg_task action:"wait"`), producing a prompt/schema mismatch. The handoff's own acceptance matrix "Model surface" row requires checking the **effective assembled prompt AND model schema** together; this plan would fail that row.
2. If TUI keeps `bg_status` unchanged, its `log` action and `fullOutputPath` details still expose/retrieve live task output outside the shared `get`/acknowledgment path, contradicting the change's core "no live-log advertisement / acknowledge only on successful handoff" contract and task 4.2's advertisement removal.

Minimal correction: in `design.md` Decision 1 and the spec's TUI scenario, state the explicit TUI disposition — either (a) `bg_status` remains registered with only `list`/`stop` and its `log` action forwards to the shared `get` operation with no live-path advertisement, or (b) it is not registered in TUI — and reconcile the shared `instructions.md` block so it never names a tool/action that is absent in the receiving mode. Because the shared block cannot be mode-conditional, any `bg_status`/`wait` mention that is TUI-invalid must move into the TUI-only `before_agent_start` contribution (already available, see Method), leaving the installed block to mode-neutral statements.

### P1-2 — `proposal.md` says "no new stdout/stderr separation," contradicting the mandated CLI stdout/metadata-stderr split

Anchors:
- `proposal.md:31` (Impact): "No `pi-subagents` implementation changes, Pi core patch, Nix configuration edits, **or new stdout/stderr separation** are included."
- `proposal.md:11` (What Changes): "Emit complete output snapshots through ordinary CLI stdout (`pi-bg get ID --output`); metadata goes to stderr."
- `spec.md` Requirement "Full output uses ordinary stdout and stable artifacts": "`pi-bg get ID --output` SHALL emit the complete captured combined output snapshot to stdout and retrieval metadata to stderr."
- `design.md:60` Decision 3: "The CLI emits raw snapshot output on stdout and its status/partial/error metadata on stderr."
- `design.md:15` Non-goals lists "stream-separated logs" (the intended exclusion: not splitting captured command stdout/stderr).

Failure mechanism: `proposal.md` is the scope/approval narrative. A worker or reviewer reading its Impact clause as a scope boundary can legitimately conclude the CLI stream split is out of scope and reuse the single-stream helper shape (`read-shim.ts:53-84` prints path + tail to one stream). Then `pi-bg get ID --output > file` writes retrieval metadata into the redirected file and `|`-piped filters receive metadata, breaking the spec's "Shell redirection and filtering" scenario and the acceptance-matrix "CLI stdout/stderr" row.

Minimal correction: reword the clause to "stream-separated captured-command logs" (design's actual intent) or delete it. Keep the CLI stdout=output / stderr=metadata requirement in spec and design unchanged.

## Lower-severity issues (P2)

- **P2-a — "hard timeout"/"hard deadline" is not a named setting.** `design.md` Decision 6 and the spec Requirement "Hard deadlines remain absolute" treat a configured "hard timeout" as a first-class value, but no setting has that name. The process ceiling is `defaultTimeoutSeconds` (`package.json:68`, default 0) and the reminder is `defaultSoftTimeoutMs` (`package.json:77`); `instructions.md` itself calls `timeoutSeconds` the "hard runtime limit." The "default 0 (disabled)" mapping is correct, but the plan never names the key. Correction: name `defaultTimeoutSeconds` (process ceiling) and `defaultSoftTimeoutMs` (soft review) explicitly in Decision 6 and the hard-deadline requirement so a worker does not invent a setting or repurpose the soft value as the ceiling.
- **P2-b — POSIX-only bridge vs unconditional spec wording.** `design.md` Decision 4 scopes the socket + `pi-bg` adapter to supported POSIX hosts ("new Windows CLI support is not part of this change"), yet the spec states `pi-bg get ID --output` SHALL … with no platform qualifier. Correction: add the platform qualifier to the spec requirement.
- **P2-c — accepted-receipt retry vs abandoned-preparation expiry.** `design.md` Decision 4 says accepted receipts retry idempotently and "expire abandoned preparation without acknowledgment or review reset," but does not state that an **already-accepted** token remains resolvable (or returns a committed "already acknowledged" outcome) until the task is pruned. A lost post-acceptance confirmation could otherwise resurface as an "expired preparation" failure after the obligation was actually settled. Correction: one sentence distinguishing accepted-token retry from unaccepted-preparation expiry.

## Coherence and proportionality assessment

Overall the artifact set is coherent and internally reference-consistent: proposal → spec (acceptance authority) → design (mechanisms) → tasks (dependency-ordered) → handoff (ownership/gates) → context (anchors) → deferred (excluded integrations). The refined handoff contract matches the reviewer's stated target:

- TUI surface `spawn/get/stop/list`; `pi-bg get ID [--output]`; 20s foreground yield preserved as a soft window, not a termination deadline. ✓
- Running `get` = review/soft reset only; final `get` after flush acknowledges notification, not output deletion; same ID remains gettable after confirmed stop; immutable full output before truncation; stdout=output / stderr=metadata; `>` and pipes operate pre-truncation. ✓
- Soft interval measured since review; list and output chatter never reset; hard deadline absolute; disabled stays disabled. ✓
- Read-inference removal and live-log advertisement removal framed as behavioral scoping, not a filesystem security boundary. ✓
- Codemode foreground/structured-output/intent/no-bg-spawn preserved as mandatory regressions. ✓
- No `pi-subagents` mutation: print/json/rpc/unknown retain bounded wait; discriminator is public `ctx.mode`, native child binds `mode:"print"`; no private Pi queue mutation; submitted-wake limitation deferred and documented as at-least-once. ✓
- Foreground CLI success = requested stdout write completes before the internal success receipt; EPIPE/open/write/snapshot/disconnect before acceptance ⇒ no ack and no running-review reset; successful writes do not certify downstream reads; receipts idempotent. ✓

Feasibility of the load-bearing gates checks out: `ctx.mode` exists; `before_agent_start` can append/replace the system prompt for the TUI-only push-wait guidance; the canonical persisted log supports pre-truncation snapshotting; `finalizeTask`'s flush barrier (`context.md`) supports readiness; the socket transport can use built-in Node `net` with no new dependency. No gate is intrinsically unimplementable.

Proportionality: the change is large for one OpenSpec change — it bundles lifecycle/ack/review state, a new session-private IPC transport replacing the CLI, immutable snapshot artifacts, mode-selected schema/prompt, and removal of read shims + sleep interception + live-path env exports. It stays within the owner's stated target and does not widen scope (deferred items are explicitly fenced), but the IPC transport is the riskiest new seam and is only budgeted as an Assignment-B deliverable, not an explicit spike. Recommendation (not a blocker): add a small "bridge feasibility fixture" gate at the front of Assignment B (two-session socket request/response + managed-bash-invoked `pi-bg` without deadlock) before the receipt-based implementation is removed.

## Residual risks

- `review-policy` skill file is missing at its advertised path; severity labels follow the standard ladder, but the exact house thresholds could not be re-read.
- The plan removes PATH read shims, sleep interception, and consumption-env exports (a large destructive surface). Ordering is correct (remove only after declared acknowledgments pass, `tasks.md` 4.3), but three sequential assignments make it easy to remove inferred-read machinery before the CLI bridge is proven; the handoff's dependency ordering must be honored literally.
- Host-queued stale wakes can still arrive after terminal retrieval; the plan documents this honestly and defers selective cancellation. This is a known, accepted limitation, not a defect.
- Snapshot/artifact lifetime vs live-task pruning is addressed at design level; the "protect in-flight terminal retrieval from pruning" gate (task 1.4) is the likely source of subtle regressions under retention tests.
- Windows CLI is out of scope; P2-b should make that explicit in the spec to avoid an unsatisfiable requirement.

## Verdict

**BLOCK.** The design is sound and no gate is unimplementable, but two P1 contract conflicts (P1-1: unstated TUI disposition of `bg_status` versus the shared prompt that still names it; P1-2: proposal Impact contradicting the mandated CLI stdout/stderr split) can produce a shipped prompt/schema mismatch or break the primary retrieval contract if carried into implementation. Both are small documentation reconciliations, not design reversals. Reconcile P1-1 and P1-2 (and, cheaply, P2-a naming) in the artifacts, then re-verify the two affected acceptance-matrix rows ("Model surface", "CLI stdout/stderr"), and this plan is OK to implement.
