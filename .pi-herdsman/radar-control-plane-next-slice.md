# Radar control-plane adoption: next slice

## Recommendation

Implement one live, read-only vertical slice next: migrate `focusSupervisedLead` in `pi-herdsman/extension/index.ts` from direct `herdr agent focus` to Radar `observe` + `focus`, through typed methods on the existing `radar-client.ts` seam. Keep all current Herdr ownership verification before focusing. This is strictly narrower than replacing launch/close and can ship without changing assignment lifecycle or identity policy. It is a working consumer, not dormant client functionality.

This does not complete Herdr removal. It is a safe first physical-control adoption while the discovery integration changes remain under independent review. No production edits were made in this investigation.

## Current contract and capability inventory

**Contract pin verified:** Radar control-plane protocol v1 in `/home/saurabhj/Projects/dev/agent-radar/docs/control-plane.md` (current on disk) and the associated mux/registration contracts `docs/mux.md` and `docs/agent-registration.md`. Exact current mux methods/capabilities: `observe`/`observe`, `process_info`/`process_info`, `output`/`output`, `focus`/`focus`, `close`/`close`, `create`/`creation`, `input`/`input`, `report`/`reporting`; `spawn` requires `creation` + `launch`, and `child_launch_context_v1` for cwd/env. Registry methods use `agent_registry`; `events.read` uses `events_v1`. The daemon lists `agent_registry` and `events_v1` as additive irrespective of mux backend. No production tmux adapter is promised; current production adapter is Herdr (`control-plane.md` Capabilities; `mux.md` Two interfaces).

`pi-herdsman/extension/radar-client.ts` is still the existing transport seam: public client currently has ping, agent registry operations and `childClose`, not mux `observe`/`focus`/`output` etc. (RadarClient declaration around lines 292-360; implementations around 475-641). `index.ts` creates it for publication at lines 19300-19303. The current Herdr adapter calls `pi.exec("herdr", ...)` in `herdr.ts:321-378` and inspection has a separate direct Herdr exec at `:223-237`.

## Prior gaps, refreshed

| Earlier concern | Current finding |
|---|---|
| Launch cwd/environment transport absent | Closed for daemon `spawn`: request supports optional absolute `cwd` and environment overlay; capability `child_launch_context_v1` is required with cwd/env. Herdr adapter refuses unrepresentable command lines pre-create. (`control-plane.md` Durable operations > spawn; `mux.md` Launch and binding.) This does not add cwd/env to generic `create`. |
| Private child token registration and exact binding absent | Closed for daemon `spawn`: Radar provides `PI_RADAR_SPAWN_TOKEN`; exact child registration presents it, edge binds once, and flat `spawn.get` exposes bound agent id. Registration docs specify strict token correlation. Does not apply to `create` + arbitrary `input`; mux contract explicitly says that pair cannot mint token or managed-child edge. (`mux.md` Launch and binding; `agent-registration.md` Registration record.) |
| Readiness absent | Still open. Spawn binding is not application readiness. No shell-ready acknowledgment. Must retain a Herdsman/Pi-specific readiness predicate; do not infer it from binding, input acceptance, pane disappearance/closure, execution status, or process evidence. (`mux.md` Adapter duties, Launch and binding.) |
| Event subscription absent | Closed since prior inventory: `events.read` exists under `events_v1`, with bounded polling, epoch/cursor expiry and pointer-only events. It is not a state snapshot; reconcile exact referenced records and resync after cursor expiry. Events do not prove liveness/readiness. (`control-plane.md` Reads; `mux.md` Adapter duties.) |
| Process stop/resume/restart absent | Still open: no operation provides verified process stop, retained-session resume, lead restart, child replacement or post-owner-restart reconciliation. `child.close` reports pane closure only, not process exit. (`control-plane.md` intro and Managed child close; `mux.md` Unsupported lifecycle operations.) |
| Managed launch binding through generic create+input | Still open and not to be synthesized. The supported flow is `spawn`; generic `create` + `input` is explicitly not a substitute. If scope still disallows Radar spawn, launch migration remains blocked. (`mux.md` Physical operations, Launch and binding.) |
| Pane/workspace/tab and process identity | Partly available, not an equivalence: `observe` gives normalized inventory and `process_info` foreground evidence; locations are opaque backend-scoped handles. Existing Herdr aliases, session detection and shell/process ownership proofs need explicit replacement; never infer them from location or close. (`mux.md` Adapter duties; `control-plane.md` Reads.) |

## Why focus is executable now

`focusSupervisedLead` (index.ts:12609-12642) is a live UI action. It first reloads supervision state, validates coordination/session/instance identity, then finds exactly one matching Herdr agent by pane/tab/workspace, Pi kind and session id before issuing Herdr focus. Radar has a first-class focus operation and read-only observe. The next implementation must retain that exact cardinality/identity check and perform it on fresh Radar-observed facts before submitting the effect; it must not substitute the Radar registry for mux inventory. The Radar `focus` schema requires location id plus kind pane/workspace (`control-plane.md` Durable operations > focus).

## Implementation brief

**Files:**
- `pi-herdsman/extension/radar-client.ts`: add only typed mux `observe` and `focus` client methods, capability checks and strict response decoding needed by this slice. Follow existing transport/result conventions; pass a fresh operation UUID for focus and preserve it for reconciliation. Do not add unused methods in this slice.
- `pi-herdsman/extension/index.ts`: update only `focusSupervisedLead`; preserve Herdr verification for now, then obtain fresh Radar inventory and ensure the intended exact pane identity is still present before focusing. Resolve the observed opaque location handle, not an alias or synthesized ID.
- `pi-herdsman/extension/radar-client.test.ts`: method envelope, capability absence, response shape, durable outcome/readback behavior.
- Focus consumer test (locate existing index/action harness, likely `extension/commands.test.ts` or supervision/control tests): assert no focus call when fresh identity differs/ambiguous and exactly one Radar focus for a unique match.

**Seam:** small additions to `RadarClient` and the existing `focusSupervisedLead` consumer. No broad Herdr adapter rewrite, fallback router, event loop, or client method framework.

**Safety requirements:**
1. Check `ping` capability before use; capability absence is explicit unavailable, never a reason to perform another effect.
2. Keep current Herdr proof intact during this slice. Radar `observe` is a second, immediate location check, not authority to weaken the existing session/coordination proof.
3. Use exact opaque pane identity from fresh observation; refuse if absent, changed, ambiguous or not in expected topology. No alias-to-ID guessing.
4. `focus` is durable: on unknown/lost reply, keep operation UUID and query `request` (or `requests`) before reporting outcome. Never issue a new focus UUID or fallback to direct Herdr after uncertain dispatch. If capability/preflight is definitely absent before submission, preserve current clear failure behavior; decide separately whether static fallback is allowed, but this slice should not silently mask daemon outage.
5. Do not infer process exit, assignment completion or readiness from focus success.

**Tests:** fake Radar daemon verifies request method/params and capability negotiation; valid focus result; unsupported capability; malformed/lost response; operation readback retains exact UUID and does not re-dispatch; consumer rejects stale/duplicate/changed identity and only focuses the single expected pane. Run the focused tests and declared pi-herdsman suite/typecheck per repo testing conventions before landing.

## Deferred slices / hard blockers

1. **Observation/output/process-info consumers:** next after focus if consumer mappings are clear. Preserve uncertainty; `process_info` is not process-exit proof.
2. **Managed worker launch:** prefer Radar `spawn`, not create+input. Needs owner authorization to use spawn if still excluded by prior task scope, and caller executable/argv/env conversion; require `creation`, `launch`, and context capability as needed. Preserve registration token capture/removal, exact `spawn.get` bound agent ID, and explicit readiness gate. Spawn placement currently only exact parent-pane right split; no chosen tab/new workspace/custom anchor.
3. **Close/stop/restart:** no general close for managed Herdr children and no process stop. `close` is for positively unmanaged frozen identities; `child.close` only applies to exact daemon-spawned token-bound child and proves pane close, not process exit. Do not weaken existing lifecycle/identity rules.
4. **Herdr event watcher:** `events.read` can replace event transport only for journal pointers plus reconciliation; it cannot establish liveness. Separate from readiness and retained-worker recovery.
5. **Full daemon adoption:** runtime must explicitly start/own daemon; Radar itself does not. No tmux production backend yet, so this slice still exercises Herdr-backed daemon.

## Source references

- Radar wire contract v1: `/home/saurabhj/Projects/dev/agent-radar/docs/control-plane.md`, Capabilities; Reads; Durable operations (focus/create/input/spawn); Managed child close.
- Mux guarantees and explicit non-guarantees: `/home/saurabhj/Projects/dev/agent-radar/docs/mux.md`, Physical operations; Adapter duties; Launch and binding; Unsupported lifecycle operations; Herdsman cutover checklist.
- Spawn/token contract: `/home/saurabhj/Projects/dev/agent-radar/docs/agent-registration.md`, Registration record and managed-spawn sections.
- Existing Herdsman integration seam: `pi-herdsman/extension/radar-client.ts:292-360,475-641`; construction `extension/index.ts:19300-19303`; live focus consumer `extension/index.ts:12609-12642`; direct Herdr runner/inspection `extension/herdr.ts:223-237,321-378`.
