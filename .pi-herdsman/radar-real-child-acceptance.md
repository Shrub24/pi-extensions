# Radar real-child acceptance (Herdr absent, model turn stubbed)

Status: **blocked at the tool-driven close stage**. Stages 1 and the startup
evidence passed; close, saved-session continuation, child context readback and
watcher resync were not completed.

## Identities

- Image: local ID `16ef0ab74d750e38a6da892aef64470c4ed69fddc5fa89a71905fd042bbc4417`
  (certified; not rebuilt). Radar `f87348032a808967c50a4e84b7e1c766a64ebfe3`,
  protocol 2. Pi `1.1.0`. tmux `3.7c`. Herdr absent (`command -v herdr` empty).
- Disposable container: `podman run -d --network none` from that image, entrypoint
  overridden to `/acceptance/seed/start.sh` (seed, then the image's own
  `/usr/local/bin/container-entrypoint`). Env: `PI_HERDSMAN_CHILD_COMMAND=/usr/local/bin/pi`.
  Current container name is in `/tmp/ph-real-child.K7VzMH/container.name` and is
  still running.
- Harness directory: `/tmp/ph-real-child.K7VzMH` (`provider.py`, `seed/`).

## Provider boundary

Only the model turn is stubbed. `provider.py` is an OpenAI-compatible
`/v1/chat/completions` SSE server on `127.0.0.1:24731`, in the container
(`--network none`, so no external traffic is reachable). Selected through
`models.json`/`settings.json` written by the seed script. It returns a real tool call
(`agent_delegate`, `agent_close`, `agent_continue`) for a parent prompt that
carries a per-stage nonce, and a text reply for child turns that carry
`CHILD_TASK_ONE=<nonce>` / `CHILD_TASK_TWO=<nonce>`. Pi's tools, the Herdsman
extension, Radar and tmux are all real. No proxy or daemon fake is used.

## Stage results

| Stage | Result | Evidence |
| --- | --- | --- |
| Herdr absent | pass | `command -v herdr` empty in the container |
| Parent Pi and Herdsman | pass | pane `%0` `cmd=pi`; parent registered (`state/agents/*.json`, context and execution publications) |
| Delegate through real `agent_delegate` | pass | parent turn issued `agent_delegate`; child pane `%1` `cmd=pi`; child registration bound (`spawns/*.json` `bound.agent_id=3c020a03…`, pane `tmux:herdsman:%1`, `created/launched/bound=completed`) |
| Child startup acknowledgement, bound to agent and generation | pass | child mailbox `startupAck` written by child `session_start`: generation `9522369a…`, pane `%1`, label `acceptance-child`; equals child env `PI_HERDSMAN_LAUNCH_GENERATION` and the parent session entry `generation` |
| First assignment, real result delivery | pass | child answered `RESULT_ONE::s1n1791880026` (nonce matches stage 1); parent shows `● herd → generalist:acceptance-child` and the result; worker `retained and idle` |
| Tool-driven close (`agent_close`) | **blocked** | parent's real `agent_close` refused: `Agent acceptance-child has not acknowledged this launch's startup` (index.ts:2696 `validateRadarChild`, and the identical check at index.ts:6243) |
| Saved-session continuation in a new pane, second result | not run | depends on close |
| Child-authored context publication readback | not run | not reached |
| Herdsman events watcher resync (cursor expiry or epoch change) | not run | not reached |

Stage 1 result is real: the startup ack and the first result both come from the
child process, and the stub's only contribution is the model reply text.

## Blocker (for owner decision)

- Source identity: image above; production Herdsman as shipped in that image at
  `/opt/pi-herdsman/extension/index.ts` (not modified).
- Smallest reproducer: stage 1 delegate (above), wait for the first result, then
  `agent_close` on `acceptance-child`. Refused with the startup-acknowledgement
  message on every attempt (two refusals visible on the parent screen).
- What is consistent on disk at close time: child `startupAck` generation =
  env generation = parent session-entry generation (`9522369a…`); acknowledged pane
  `%1` = `radarPaneHandle("tmux:herdsman:%1")`; binding agent_id matches the spawn
  edge.
- What I could not observe: the parent's in-memory `runtime.paneId` and
  `runtime.radarLaunchGeneration` at the comparison in `validateRadarChild`
  (index.ts:2688-2697). Reading them needs production instrumentation.
- Not established: whether this is a production defect (for example, the parent's
  runtime pane held in a different form, or the generation restored from a
  different entry) or a harness artifact. The durable state is consistent, so the
  mismatch is in the parent's runtime, not in the child's acknowledgement.

## Harness note (fixed in the harness, not production)

The stub re-issued `agent_close` three times instead of recognising its own earlier
tool call in the message history, so the close was requested repeatedly. This does
not change the refusal, but it means the stub's "already called" detection is
wrong and must be fixed before the close stage can be re-run cleanly.

## Discarded runs

- Run 1 (`ph-real-child-1791879724`, removed): brief lacked the child marker, so the
  child replied `unscripted-local-stub-reply`. Discarded.
- Run 2: stub crashed on nonce extraction (leading space) and returned a dropped
  connection; parent showed `Connection error`. Discarded; provider fixed, not reused.
- Log retained as `/tmp/ph-real-child.K7VzMH/provider-turns.discarded-run1.jsonl`.

## Not validated

Context publication readback, watcher resync, saved-session continuation, cleanup
of the disposable container, and any production edits (none were made).

## Recommended next step

Owner decision on the close blocker: either authorise a read-only observation of the
parent's runtime values at the `validateRadarChild` comparison (a temporary probe in
a disposable copy, not production), or assign the parent-runtime pane/generation
derivation to the Herdsman runtime owner with this reproducer.
