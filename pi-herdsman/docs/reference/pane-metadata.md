# Herdr pane metadata

The official Herdr Pi integration owns semantic state and session reporting. Herdsman writes display metadata only. Remove `@narumitw/pi-herdr` before enabling this publisher; running both is unsupported. Herdsman's widget is unchanged.

Each TUI session in Herdr publishes under `pi-herdsman:lead` (ordinary Lead, Manager or Chief) or `pi-herdsman:<runId>` (managed worker). Headless and non-Herdr sessions publish nothing. Tokens expire after one hour and refresh halfway through. Missing values are cleared; text is terminal-safe and bounded to 80 Unicode characters.

Herdr applies `--ttl-ms` per updated key, so short-lived facts on the same pane use their own source slots: Herdsman publishes the pane's awaited set under `pi-herdsman:awaited`, and `pi-bash-processes` publishes its background task facts under `pi-bash-processes`. Both slots expire after 30 seconds and refresh halfway through, and a pane with nothing outstanding publishes neither.

| Token                        | Value                                        | When present             |
| ---------------------------- | -------------------------------------------- | ------------------------ |
| `model`                      | provider/model id                            | Model is known           |
| `provider`                   | Provider id                                  | Model is known           |
| `thinking`                   | Thinking level                               | Level is known           |
| `session`                    | Human session name, **not an identity**      | Named session            |
| `context_usage`              | Rounded percentage, e.g. `43%`               | Usage is known           |
| `pi_herdsman_session`        | Exact Pi session UUID                        | Every session            |
| `pi_herdsman_role`           | Lead/Manager/Chief role or worker definition | Active role              |
| `pi_herdsman_label`          | Worker runtime label                         | Managed worker           |
| `pi_herdsman_run`            | Worker run UUID                              | Managed worker           |
| `pi_herdsman_parent_session` | Direct owner's exact Pi session UUID         | Managed worker           |
| `pi_herdsman_request`        | Request UUID                                 | Active worker assignment |
| `pi_herdsman_task`           | Assignment's display text                    | Active worker assignment |
| `pi_herdsman_started`        | Unix milliseconds                            | Active worker assignment |
| `pi_herdsman_name`           | Lead session name                            | Named Lead               |
| `pi_herdsman_ask`            | Pending ask UUID                             | Lead with pending ask    |
| `pi_herdsman_awaited`        | Awaited items, comma-separated               | Anything outstanding     |
| `pi_bg_running`              | Running background task count                | A task is running        |
| `pi_bg_tasks`                | Running task ids, comma-separated            | A task is running        |
| `pi_bg_started`              | Oldest running task's ISO 8601 start         | A task is running        |

An owner separately publishes `pi_herdsman_state` on each directly owned worker pane under `pi-herdsman:owner:<runId>`. Its value is the same public projection used by `agent_list`, not Herdr's semantic state. This source expires after 30 seconds, refreshes halfway through, and clears when the record disappears or the owner shuts down. A dead owner cannot leave a permanent state override. Lost workers can be reported by the owner even when their own publisher is gone. Herdsman preserves the existing projection: absent pane evidence is `lost`; ambiguous evidence is `unknown`. Writes to an already removed pane can fail harmlessly; this contract does not create ghost rows. A pane proved to belong to another session receives no old-owner state.

## Awaited facts

`pi_herdsman_awaited` lists what the pane is waiting on: `agent:<label>` for each outstanding direct child, and `owner` while its own `ask_owner` reply is outstanding. A Lead lists its outstanding workers; a worker lists its outstanding nested children. A child is outstanding while it has an active request, an undelivered result or a durable result error, so a delivered, resolved or retained idle child is not awaited. The value is capped at eight entries and 80 Unicode characters, holds only labels and the literal `owner`, and never carries task text, commands, output or paths. Each `agent:<label>` is the child's runtime label — the same name that pane publishes as `pi_herdsman_label`.

The set describes outstanding work, not the agent: it is published while the pane is working and while it is stopped, it follows every membership change, and it is cleared when the last item resolves. It is not `pi_herdsman_state`, which stays the owner's assignment projection; `settling`, `delivered` and `lost` keep their control meaning.

## Background task facts

`pi-bash-processes` owns three more keys on the same pane for the background tasks it manages: `pi_bg_running` (exact count of running tasks), `pi_bg_tasks` (their ids, comma-separated, capped at six) and `pi_bg_started` (the oldest running task's ISO 8601 start). They carry presence and identity only and are cleared on the last exit.

## Deriving a pane's activity state

A consumer derives one activity state from the facts on the pane. No publisher exports it, because no single key can express a pane awaiting two tasks and one agent at once.

1. A live `pi_herdsman_state=lost` from the owner wins: the pane is lost; an expired owner value is not used.
2. Otherwise a working native Herdr state stays working, awaited items included.
3. A native state that is unknown or missing stays unknown.
4. Otherwise a non-empty union of awaited facts is waiting.
5. Otherwise the native state stands: idle, blocked or done.

The union spans publishers, because `pi_herdsman_awaited` and the `pi_bg_*` background facts have different owners and the contract forbids one key with two publishers. The owner's assignment projection is never a second authority for this state.

## Herdr storage model and limits

Herdr 0.9.3 keeps one flat token map per pane. `--token k=v` patches a key, `--clear-token k` removes it, the latest write to a key wins regardless of `--source`, and a clear removes the key even if another source wrote it. `--source` does not isolate publishers. Coexistence is safe only because **every token name has exactly one publisher**: Herdsman owns the generic tokens above and every `pi_herdsman_*` name, Radar owns `anchor`, `sort_key`, workspace/tab keys, glyphs and row tokens, and other extensions own their own names. Herdsman clears only names it publishes. A new Herdsman name must not collide with any other publisher's.

Limits, both all-or-nothing (the whole report is rejected, nothing is evicted): at most 16 token keys per report and 32 retained keys per pane. A worker report carries 13 keys, a Lead report 9, the owner report 1, the awaited report 1 and the background-facts report 3. With Radar and other tools already writing, a worker pane is estimated at about 30 of 32, so new names need headroom. TTL applies per updated key. Token metadata is not restored after a Herdr server restart; the next refresh (at most 30 minutes, or 15 seconds for the short-lived owner, awaited and background keys) republishes it.

`pane report-metadata` takes an explicit pane id and works from any pane, so the owner's write onto a worker's pane is supported. Owner state is polled about every 2 seconds while the owner lives; after an owner crash the 30-second TTL is the effective window. Shutdown clears this process's names; failed clears expire through TTL.

## Tree reconstruction

Within each workspace, map `pi_herdsman_session` to the pane, then match each worker's `pi_herdsman_parent_session` to that map. Compare identities exactly; do not use the human `session` token or infer ownership from tab position. An unmatched parent is an orphan root. Consumers should bound traversal and treat malformed cycles as roots.

Workers remain real Herdr agents, with their own focusable panes. Their direct children launch in the same workspace. Radar owns tree ordering, indentation, collapse and row state; these tokens are facts, not presentation. There are no depth fields, sort keys, pre-rendered slots, `summary` or `title-suffix`, and the awaited set names what is outstanding rather than listing a tree.

The companion [fixture](pane-metadata.fixture.json) includes Herdr identities (`agent_session.kind` is `path`, as the official reporter prefers the session file; the UUID lives only in `pi_herdsman_session`), source ownership, nested direct-parent pointers and expected tree order. Radar needs a consumer change to render these facts; existing Radar versions ignore them. The fixture labels its per-source entries as publication input and includes expected flattened `agent list` records: nulls/clears remove keys, while disjoint live sources contribute their keys. Its expired-owner case removes only `pi_herdsman_state`; the proposed consumer fallback is native `agent_status`, not the stale owner value. These are the intended consumer contract, not an executed live Herdr merge check.

## Migration

Install the official reporter with `herdr integration install pi`, retire pi-herdr, then update Herdsman and Radar together. Bare worker `managed`, `role`, `request`, `task`, `started` and `ctx` tokens are removed. `ctx` becomes `context_usage` with a percent suffix. Generic `model` and `thinking` remain, now owned by Herdsman's single session publisher.
