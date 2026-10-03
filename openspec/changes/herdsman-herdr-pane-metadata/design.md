# Design

## Context (verified observations)

- Herdr has exactly one semantic-state authority per pane (`idle/working/blocked`, with derived `done`/`unknown`). Metadata (`pane report-metadata`: title, display agent, free-form `--token k=v`, optional TTL and `--seq`) is display-only, is keyed by `--source`, and never changes waits, notifications or rollups. Sidebar rows reference tokens as `$name`.
- The Herdr-installed Pi integration reports state and session identity only. pi-herdr 0.3.x additionally reports `model`, `provider`, `thinking`, `session`, `context_usage` (values bounded to 80 characters, 1 hour TTL refreshed every 30 minutes, root TUI sessions only, cleared on shutdown) and shows its own widget.
- Herdsman's `role()` resolves any Pi session with `HERDR_ENV=1` and no managed-worker environment to `lead`; a valid managed environment resolves to `managed-agent`. So Herdsman is already active in every Herdr pane.
- Managed workers publish their own pane's metadata from inside the worker process, using `PI_HERDSMAN_RUN_ID`, `PI_HERDSMAN_OWNER_SESSION_ID`, `PI_HERDSMAN_LABEL`, `PI_HERDSMAN_AGENT_DEFINITION` and `HERDR_PANE_ID` from the environment, under source `pi-herdsman:<runId>`. Leads publish `pi_herdsman_role=lead`, optional pending-ask and name tokens under `pi-herdsman:lead`.
- Workers are launched without extension discovery disabled, and also receive an explicit `--extension` for the Herdr-installed integration path. The launch environment is assembled in one place in `index.ts`.
- Prior art, unmerged: the `radar-publisher-durable` jj workspace (`../pi-extensions-radar-publisher`, `pi-subagents/src/integrations/herdr-child-rows.ts`, `herdr-status.ts`) publishes headless pi-subagents children as pre-rendered text slots `subagent_1..8` plus `subagent_more`, `summary` and `title-suffix` on the **parent's** pane, with tree furniture (marks, indent, depth cap 4) rendered by the publisher. That fits children that have no pane. Herdsman workers each own a pane and a Herdr agent row, so rows already exist and only the relation is missing.
- Herdsman's public projection states live in the owning lead (`agent_list`). A dead worker has no live reporter.

## Goals / Non-Goals

Goals: one state authority, one metadata publisher, no token-name collisions, hierarchy and projection visible to a sidebar, no presentation logic in Herdsman.
Non-goals: moving workers out of Herdr's agent registry or hiding them from Herdr (they stay real panes and agent records), pre-rendered child rows on a parent pane, workers placed outside their owner's workspace (not allowed by Herdsman; consumers may rely on it), ordering/sort keys, glyphs, colours or row layout (herdr-radar owns presentation); child lists on parents; modifying pi-herdr, Herdr or radar; a Herdr state override via `--state-label`; a second in-Pi widget (Herdsman's own widget is unchanged); headless or non-Herdr sessions.

## Decisions

### D1. State authority belongs to the official Herdr integration
Herdsman SHALL NOT call `pane report-agent`, `report-agent-session` or `release-agent`. pi-herdr is retired by the user rather than forked. The README names `herdr integration install pi` as a requirement. Rejected: forking pi-herdr (2K lines of widget, settings and observer code we would own to gain nothing the Herdsman publisher does not already provide).

### D2. Herdsman is the sole metadata publisher; one publisher per process
A process has one metadata source: the existing role-based ids (`pi-herdsman:lead`, `pi-herdsman:<runId>`). Session-self tokens and orchestration tokens are written through one queue, one diff and one shutdown clear, never from two code paths. Rejected: a separate sidecar extension, which would force Herdsman to hand hierarchy facts to another extension through an env/session contract, and would add a second loader to every worker.

### D3. Publisher module is delegation-independent
A new internal module owns token formatting, sanitising, bounds, snapshot equality, request construction and TTL/refresh timing. It takes plain inputs and a runner function and imports nothing from the delegation code, so it is testable without a Herdr and extractable later. pi-herdr's `herdr-metadata.ts` formatting rules are ported with an attribution note (MIT).

### D4. Token contract
Generic sidebar-compatible session tokens keep their existing names so existing row layouts continue to work: `model`, `provider`, `thinking`, `session`, `context_usage`. All orchestration facts use the `pi_herdsman_` prefix:
- `pi_herdsman_role`: `lead` or the managed worker's agent definition.
- `pi_herdsman_run`: the worker's run id (workers only).
- `pi_herdsman_session`: this process's Pi session id.
- `pi_herdsman_parent_session`: the direct owner's Pi session id (workers only).
- `pi_herdsman_task`, `pi_herdsman_request`, `pi_herdsman_started`: the active assignment (workers only; cleared when none).
- `pi_herdsman_ask`, `pi_herdsman_name`: existing lead tokens, unchanged (they already carry the prefix).
- `pi_herdsman_state`: the owner's view of a worker (D6), published from the owner, not the worker.
The old bare worker tokens (`managed`, `role`, `request`, `task`, `started`, `ctx`) are removed; `ctx` is superseded by `context_usage`. Titles and `--display-agent` stay as they are. Open: whether herdr-radar prefers different generic names; this is settled by the contract fixture, not by Herdsman.

### D5. Hierarchy is session-keyed, child-owned, one-way
Each pane publishes its own Pi session id. A managed worker also publishes `pi_herdsman_parent_session` from the `PI_HERDSMAN_OWNER_SESSION_ID` already in its environment. A consumer resolves a parent by matching that value against another pane's `pi_herdsman_session`, and derives children and depth by inversion and traversal. No new launch environment variable is needed. Rejected: parent pane ids, which are Herdr identifiers that can change when a pane moves; child lists, which go stale when children die or move; depth, which is derivable. Limitation: when a parent starts a new Pi session in the same pane, its children's recorded owner no longer matches until ownership is re-established, which is consistent with Herdsman's session-keyed ownership model.

### D6. The owner publishes the worker's projection state, time-bounded
Only the owning lead knows the full public projection (`idle`, `working`, `blocked`, `settling`, `unknown`, `lost`, and `waiting` once the background-handoffs change lands). The owner SHALL publish `pi_herdsman_state` onto each worker pane under a separate source (`pi-herdsman:owner:<runId>`) with a TTL, so a crashed owner's stale view expires and a worker's own source is never overwritten. It is display-only; the semantic Herdr state is untouched and no `--state-label` is used, because radar renders its own state tokens. Token values mirror the public state names exactly and new states are additive. `lost` is published when physical loss is proven, then left to expire or cleared when the record is closed.

### D7. Gating and failure behaviour
Publish only when role is `lead` or `managed-agent` (which already requires `HERDR_ENV=1`) and a pane id exists. All publication is best effort: failures never affect delegation, are bounded by a timeout, and drop superseded queued snapshots. Values are sanitised terminal text bounded to 80 characters. Unknown values are cleared rather than retained stale. Shutdown clears this process's tokens.

### D8. Reporter loading
Workers defined with `noExtensions` launch with `--no-extensions`, under which Pi loads only explicit `--extension` paths, and Herdr does not inject its reporter. Automatic discovery therefore cannot be relied on. Herdsman passes the installed reporter path explicitly whenever the file exists; Pi dedupes explicit and discovered paths by canonical path, so discovery and the explicit argument load it once. When the file is absent no argument is passed. Preflight SHOULD report a missing integration once, with the install command, rather than failing worker launch obscurely.

### D9. Two hierarchy encodings are deliberate, and Herdsman does not pre-render
The pi-subagents publisher pre-renders rows into the parent's pane because its children have none. Herdsman publishes relations and states as facts because its children are panes the renderer already lists. Herdsman MUST NOT emit `subagent_N`, `summary` or `title-suffix`. herdr-radar is expected to read both: pane-less children from parent slots, pane-backed children from `pi_herdsman_*` pointers. If pi-subagents is retired (as the Herdsman migration plans), the slot encoding retires with it; this change does not depend on that.

### D10. Workers stay Herdr agents; presentation is radar's choice
Evaluated and rejected: publishing workers as parent-rendered slots with the worker rows hidden. It still needs the hierarchy facts plus a hide filter, adds a second render path, loses per-child state, colour, notification and jump-to-pane on hidden rows, caps visible children, and orphans children if the parent dies. Herdsman's control plane also depends on workers being Herdr agent records (agent start, alias, list, inspect, retained resumable workers), so removing them would be a separate redesign. Herdsman therefore publishes facts (D4-D6); herdr-radar decides whether to nest rows, collapse them under the parent, or derive a child count. Radar is under the same owner and malleable, so ordering, grouping and any collapse mode are implemented there against the fixture. Because Herdsman keeps every worker in its owner's workspace, radar's tree is intra-workspace; a pointer to a session in another workspace is an orphan root.

## Risks / Trade-offs

- [Concurrent edits to `index.ts`] -> The metadata section and lead metadata queue are separable from the background-handoffs admission/settlement code, but both live in a 16K-line file. Implement in an isolated jj workspace and rebase, or sequence after the shared phases; see tasks 0.x.
- [Two sources on one worker pane] -> Different sources are Herdr's supported shape and own disjoint token names; verify against live Herdr that tokens from both sources render and that clearing one source does not clear the other. Note this is a runtime property; the user owns the live smoke.
- [Token rename breaks existing sidebar rows] -> Publish the contract and fixture first; radar adopts before Herdsman removes the old tokens, or both are changed in one release.
- [Stale parent after session replacement] -> Documented limitation; consumers treat an unmatched parent session as an orphan root.
- [Publisher bloat] -> Port only formatting, equality, bounds and refresh. Do not port the widget, observer, settings controller or state reporter.

## Migration

Install the official Pi integration, remove pi-herdr from Pi settings, update sidebar rows to the published tokens, then update Herdsman. Until the old tokens are removed the two publishers do not conflict on state; they only duplicate display tokens.

## Open Questions

- Do herdr-radar rows read `model`, `provider`, `session` or `context_usage` today, or only titles? Settled by the radar fixture.
- Does herdr include rows hidden by an agent-view filter in rollups and attention counts? Only relevant if radar adds a collapse mode; not a prerequisite here.
- Should Herdsman also publish radar's existing `summary`/`title-suffix` tokens so current radar rows work unchanged for Herdsman panes? Decided in task 0.2 with the radar developer; default is no, to keep one contract.
- Does a nested delegating worker's `PI_HERDSMAN_OWNER_SESSION_ID` identify its direct delegating parent rather than the root lead? Verify before relying on D5 for depth greater than one (task 4.1).
