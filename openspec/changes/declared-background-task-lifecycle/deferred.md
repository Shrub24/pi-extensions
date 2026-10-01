# Deferred integrations

These are not implementation tasks for this change. Keep their constraints intact, but do not mutate their owning packages while implementing the local background-task model.

## 1. Subagent pending-work lifetime bridge

**Owner:** a later pi-bash-processes/pi-subagents integration change, explicitly deferred by the user.

**Known behavior:** a native child's `prompt()` resolving leads both foreground and background hosts to finish/dispose the child session. Pi-background-tasks' shutdown handler terminates owned running shell work. An idle wake arriving after disposal cannot rescue it. Native children currently bind extensions in `mode: "print"`, which is sufficient to retain the legacy wait surface without changing their lifetime.

**Existing seam:** `pi-subagents/src/api/background-work.ts` exposes the provider registry; `src/runs/shared/subagent-prompt-runtime.ts:505–518` performs `agent_end` background-work draining. Shell tasks are not registered there. The earlier lifecycle recon's durable reference is memory #3377; source anchors must be refreshed before implementation.

**Candidate:** register pending shell work with stable item and owning-session identity. Keep the child prompt alive while waiting for relevant events, not merely for a guessed remaining timeout. Multiple tasks wait concurrently. Expose parent activity as `running — waiting on N shell tasks`, not completed/detached. Release the hidden wait for a completion that needs reasoning, a progress review, steering/cancellation, or a child/run deadline, then re-enter it if work remains after continuation.

**Unverified details:** interruption behavior of the provider drain, exact child/session identity for foreground sessions sharing a process, bridge ownership across runners, the existing drain's cap versus child/task hard deadlines, and result-handoff ordering. Registry existence is not proof that the whole candidate works.

**Acceptance gate before removing compatibility wait:** deterministic foreground and async/workflow child fixtures start shell work, end the agent response, prove the session/task stays alive with parent-visible waiting activity, then prove completion resumes reasoning and produces one final result. Include multiple tasks, failed early task with a longer sibling, soft review, steering/cancellation, task/run deadline, and exit-before-flush races. Hold lifetime through result/message handoff, not merely process exit.

**Constraint on this change:** keep print/json/rpc/unknown-mode bounded wait callable. No provider registration, child driver edit, parent-status implementation, or claim of verified push-only child behavior belongs in the local work.

## 2. Selective cancellation of a custom message already queued in Pi

**Owner:** Pi host/core upstream work or a separately approved host fork; there is no writable Pi-core source target in this handoff.

**Known behavior (Pi 0.99.2):** ExtensionAPI.sendMessage returns void and exposes no selective message handle. AgentSession/Agent can clear queues wholesale, but extension custom messages are not safely editable through the user-input display arrays. Clearing/reconstructing steering/follow-up queues is unsafe. A message already included in an active model request cannot be made unseen without aborting the request.

**Candidate API contract, not an implementation assertion:** enqueue a custom steering/follow-up message and receive a stable handle; cancel that handle while the message is pending. Return distinct `cancelled`, `already-delivered`, and `not-found` outcomes without touching unrelated message ordering. Define pending to include deferred-settled actions if that is a queue placement used by sendMessage. Support both idle immediate delivery and streaming queues. Preserve source compatibility for existing callers that ignore the send result.

**Tests required in the owning host change:** cancel one message among user steering and unrelated extension messages; preserve order of survivors; cover steering, follow-up, deferred-settled enqueue, idle submission, and cancellation racing with dequeue. Once an active request consumes the message, cancellation must return already-delivered rather than silently aborting or rewriting history.

**Constraint on this change:** cancel only extension-held wakes and persist acknowledgment honestly. A queued Pi wake can still arrive after a terminal get/stop. Do not implement private-queue hacks, blanket clearing, transcript filtering presented as cancellation, or a false exactly-once host-delivery guarantee.
