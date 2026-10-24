# Configuration

[Documentation index](../README.md)

Pi Herdsman keeps its configuration in one flat, user-wide file:

```text
<Pi agent directory>/pi-herdsman/config.json
```

The default location is `~/.pi/agent/pi-herdsman/config.json`. Pi's native
`getAgentDir()` determines the agent directory, so setting
`PI_CODING_AGENT_DIR` relocates the file to
`$PI_CODING_AGENT_DIR/pi-herdsman/config.json`.

Project trust and project settings do not affect Herdsman configuration.
Agent definitions remain a separate feature and continue to use the bundled,
project-local, and user agent-definition locations described in the
[agent-definition guide](../guides/agent-definitions.md).

## Schema and defaults

The file contains only explicitly configured overrides. The accepted flat
schema is:

```json
{
  "spawnPlacement": "split",
  "contextRetirement": false,
  "retainWorkers": true,
  "softTimeoutMs": 300000,
  "workerContextBudgetTokens": 200000,
  "workerCompaction": true,
  "inlineAttachmentLimitBytes": 131072,
  "mailboxPayloadLimitBytes": 131072,
  "disabledDefinitions": [],
  "modelScopes": {}
}
```

An absent file means these defaults:

| Field                        |            Default | Allowed values                                    |
| ---------------------------- | -----------------: | ------------------------------------------------- |
| `spawnPlacement`             |            `split` | `tab`, `subtree`, `split`                         |
| `contextRetirement`          |              false | boolean                                           |
| `retainWorkers`              |               true | boolean                                           |
| `softTimeoutMs`              |          `300000`  | integer from 0 (disabled) through 2147483647      |
| `workerContextBudgetTokens`  |           `200000` | integer from 16384 through 1000000|
| `workerCompaction`           |               true | boolean                                           |
| `inlineAttachmentLimitBytes` | `131072` (128 KiB) | integer from 1024 (1 KiB) through 1048576 (1 MiB) |
| `mailboxPayloadLimitBytes`   | `131072` (128 KiB) | integer from 1024 (1 KiB) through 1048576 (1 MiB) |
| `disabledDefinitions`        |                `[]` | unique definition names, at most 64              |
| `commonChildExtensions`       |          not set | optional explicit child extension base, at most 64 |
| `modelScopes`                |                `{}` | `allow` and `agents` lists of model patterns     |

`commonChildExtensions` is optional and omitted from the defaults. When
configured (including as an empty array), it becomes the common explicit
extension set for managed children: Herdsman passes `--no-extensions` and loads
only this set plus each definition's additions, minus its exclusions. The
Herdsman extension and the required pi-radar baseline are injected separately
and are not part of this list. Excluding optional extensions cannot remove the
worker's registrar or assignment support.
If the field is absent, existing extension-discovery behavior is unchanged.

Malformed JSON, a non-object root, unknown fields, and invalid known values
are errors. Reads do not create the directory or file. Nix renders this file;
the extension only reads it, so no runtime path writes it.

`spawnPlacement` asks for the layout a fresh managed worker is placed in. The
shipped default is `split`: the Radar daemon spawns a worker beside its parent's
registered pane, which is the one placement it creates. `tab` and `subtree`
describe layouts the daemon cannot create yet, so an explicit setting of either
refuses before anything starts rather than silently taking a different pane.

`inlineAttachmentLimitBytes` applies per file. Eligible complete strict UTF-8
files are embedded only when the exact serialized mailbox record fits; other
files remain canonical references. `mailboxPayloadLimitBytes` limits the exact
serialized request, ask, or chief message record. Chief messages also retain
their fixed 8 KiB protocol ceiling.

When `contextRetirement` is enabled, automatic context pressure retires a
managed-agent session. Herdsman suppresses preventive threshold compaction
while the assignment finalizes and leaves Pi's overflow recovery available.
The session receives a finalization instruction, and its result requires a
fresh agent for follow-up. Disabled, it bypasses retirement completely,
including existing retirement markers, and leaves Pi's native compaction and
session reuse behavior untouched. This fork ships it disabled: managed agents
are persistent sessions that compact through the context stack their Pi
configuration loads, and `agent_continue` stays available after compaction.

`softTimeoutMs` is the length of the advisory soft-deadline window armed for
each accepted `agent_delegate` or `agent_continue` assignment, measured from the
worker's acknowledgement. When a window expires while the assignment is still
unresolved, the idle controller receives one advisory digest listing every due
worker with the controls it currently allows; the windows then re-arm. The
window is checked on the health-reconciliation cadence, so delivery can lag
expiry by up to one scan interval. `agent_extend` replaces one worker's next
window with a longer one. The window never aborts, steers, or closes anything,
and `0` disables soft windows entirely. Set the value from the
`softTimeoutMs` in this file.

`workerContextBudgetTokens` is the context budget of a managed worker. When a
worker's reported context reaches it at the end of a turn that called a tool,
Herdsman compacts the session at Pi's manual compaction boundary and continues
the same assignment, so the worker carries a summary plus a retained tail rather
than the largest context its window allows. The value is bounded by the model's
window minus a reply reserve, so a window smaller than the budget compacts
earlier, and one assignment is compacted at most three times. `contextRetirement`
suppresses it. The summary comes from whichever summarizer the worker's own Pi
configuration loads for compaction; this deployment's child build supplies one
without a model call. Pi's own threshold compaction stays off, because it is a
global setting that would also govern an operator session (see
[ADR 0028](../adr/0028-compact-a-managed-workers-context-at-a-fixed-budget.md)).

`workerCompaction` switches that compaction request off entirely. With it
`false`, a worker is never compacted at the budget and no continuation turn
follows one, so it answers on the context it has and its assignment settles the
way an under-budget one does.

`retainWorkers` controls whether a worker's process and pane survive after its
result is delivered. It defaults to `true`: a worker is a persistent session, so
a delivered worker, whether it succeeded or failed, stays running in the public
`idle` state under its agent label, and a later `agent_continue` for its session
delivers the next assignment into the same live process. A failure, including a
rejected answer or a model error, therefore never costs the pane or its context;
the owner can steer, continue or retry it. Release an `idle` worker with
`agent_close` or the `/agents` → `Clear idle` action. Set `false` for one-shot
workers whose process and pane are cleaned up after delivery; their Pi sessions
remain continuable through `agent_continue`.

`disabledDefinitions` takes definition names out of the offered roster. A
named definition disappears from the lead roster, the `/agents` menu, and every
owner-visible definition list, and delegation to it is rejected as disabled. It
still resolves, so another definition's `agents` reference to it keeps loading.
A name that matches no definition is an error, because a typo would otherwise
disable nothing while appearing to work.

This differs from `enabled: false` in a definition file, which also rejects
delegation and hides the definition from owner-visible lists but leaves it listed
in the lead roster. The configuration list is how an operator removes a bundled
role such as `generalist` or `implementer` from delegation entirely.

`modelScopes` constrains which models a delegated agent may run on. `allow` is
the global list, and `agents.<name>.allow` restricts one definition. A resolved
model must satisfy every scope that exists, so a per-definition list restricts
without exempting. A pattern is an exact `provider/model`, a trailing-wildcard
`provider/*`, or the reserved `$inherited`, which matches a model the launch
inherited rather than pinned — so `["$inherited"]` reads as "an unpinned agent
may follow the controller, a pinned model must be listed". A violation fails the
launch, naming the definition, the model, whether it was pinned or inherited,
and the scope that rejected it; no model is substituted. An absent
`modelScopes` leaves resolution exactly as it was.

A pinned model whose provider is supplied by an extension needs that provider's
extension in the selected child set. If `noExtensions: true` or
`commonChildExtensions` selects an empty set, Herdsman refuses a pinned
extension-provided model before launch. Include the provider extension in the
common or per-agent set; Herdsman cannot infer which providers arbitrary
extension specifiers register, so a wrong non-empty set can still fail with
`Model "<id>" not found`.

A nested agent inherits its managed parent's model, so a scope on the parent's
definition governs the model a grandchild inherits.

Placement affects future starts, not existing agents. `tab` uses one lead-owned
agents tab, `subtree` gives each lead-direct agent its own tab, and `split`
splits from the caller's pane. Nested delegation always splits in its owner's
current tab. Under Radar spawn only `split` is transportable: a `tab` or
`subtree` placement refuses before any effect rather than taking another pane.

## Reset

Stop active Pi and Herdsman processes first; running processes may recreate
runtime state. Then delete the complete Herdsman directory at this canonical
location:

```text
<resolved Pi agent directory>/pi-herdsman/
```

`<resolved Pi agent directory>` means the result of Pi's native
`getAgentDir()`. With a custom `PI_CODING_AGENT_DIR`, Pi resolves that value
(including values such as `~`) before appending `pi-herdsman`; do not construct
the path by concatenating the raw environment variable yourself. Use the
native file-management operation for the current platform to delete that
directory.

The next process starts with the defaults and recreates only the runtime state
it needs.

## See also

- [`/agents` commands](commands.md)
- [Getting started](../getting-started.md)
