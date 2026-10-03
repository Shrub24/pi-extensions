# Herdr pane metadata

The official Herdr Pi integration owns semantic state and session reporting. Herdsman writes display metadata only. Remove `@narumitw/pi-herdr` before enabling this publisher; running both is unsupported. Herdsman's widget is unchanged.

Each TUI session in Herdr publishes under `pi-herdsman:lead` (ordinary Lead, Manager or Chief) or `pi-herdsman:<runId>` (managed worker). Headless and non-Herdr sessions publish nothing. Tokens expire after one hour and refresh halfway through. Missing values are cleared; text is terminal-safe and bounded to 80 Unicode characters.

| Token | Value | When present |
|---|---|---|
| `model` | provider/model id | Model is known |
| `provider` | Provider id | Model is known |
| `thinking` | Thinking level | Level is known |
| `session` | Human session name, **not an identity** | Named session |
| `context_usage` | Rounded percentage, e.g. `43%` | Usage is known |
| `pi_herdsman_session` | Exact Pi session UUID | Every session |
| `pi_herdsman_role` | Lead/Manager/Chief role or worker definition | Active role |
| `pi_herdsman_run` | Worker run UUID | Managed worker |
| `pi_herdsman_parent_session` | Direct owner's exact Pi session UUID | Managed worker |
| `pi_herdsman_request` | Request UUID | Active worker assignment |
| `pi_herdsman_task` | Assignment's display text | Active worker assignment |
| `pi_herdsman_started` | Unix milliseconds | Active worker assignment |
| `pi_herdsman_name` | Lead session name | Named Lead |
| `pi_herdsman_ask` | Pending ask UUID | Lead with pending ask |

An owner separately publishes `pi_herdsman_state` on each directly owned worker pane under `pi-herdsman:owner:<runId>`. Its value is the same public projection used by `agent_list`, not Herdr's semantic state. This source expires after 30 seconds, refreshes halfway through, and clears when the record disappears or the owner shuts down. A dead owner cannot leave a permanent state override. Lost workers can be reported by the owner even when their own publisher is gone. Herdsman preserves the existing projection: absent pane evidence is `lost`; ambiguous evidence is `unknown`. Writes to an already removed pane can fail harmlessly; this contract does not create ghost rows. A pane proved to belong to another session receives no old-owner state.

Clears name only this source's fields, never Radar's `anchor`, `sort_key`, workspace/tab keys, glyphs or row tokens. Shutdown clears this process's publication; failed clears expire through TTL.

## Tree reconstruction

Within each workspace, map `pi_herdsman_session` to the pane, then match each worker's `pi_herdsman_parent_session` to that map. Compare identities exactly; do not use the human `session` token or infer ownership from tab position. An unmatched parent is an orphan root. Consumers should bound traversal and treat malformed cycles as roots.

Workers remain real Herdr agents, with their own focusable panes. Their direct children launch in the same workspace. Radar owns tree ordering, indentation, collapse and row state; these tokens are facts, not presentation. There are no child lists, depth fields, sort keys, pre-rendered slots, `summary` or `title-suffix`.

The companion [fixture](pane-metadata.fixture.json) includes Herdr identities, source ownership, nested direct-parent pointers and expected tree order. Radar needs a consumer change to render these facts; existing Radar versions ignore them. The fixture labels its source-scoped entries as publication input and includes expected flattened `agent list` records: nulls/clears remove keys, while disjoint live sources contribute their keys. Its expired-owner case removes only `pi_herdsman_state`; the proposed consumer fallback is native `agent_status`, not the stale owner value. These are the intended consumer contract, not an executed live Herdr merge check.

## Migration

Install the official reporter with `herdr integration install pi`, retire pi-herdr, then update Herdsman and Radar together. Bare worker `managed`, `role`, `request`, `task`, `started` and `ctx` tokens are removed. `ctx` becomes `context_usage` with a percent suffix. Generic `model` and `thinking` remain, now owned by Herdsman's single session publisher.
