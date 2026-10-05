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
  "spawnPlacement": "subtree",
  "contextRetirement": false,
  "retainWorkers": false,
  "softTimeoutMs": 300000,
  "inlineAttachmentLimitBytes": 131072,
  "mailboxPayloadLimitBytes": 131072,
  "disabledDefinitions": [],
  "modelScopes": {}
}
```

An absent file means these defaults:

| Field                        |            Default | Allowed values                                    |
| ---------------------------- | -----------------: | ------------------------------------------------- |
| `spawnPlacement`             |          `subtree` | `tab`, `subtree`, `split`                         |
| `contextRetirement`          |              false | boolean                                           |
| `retainWorkers`              |              false | boolean                                           |
| `softTimeoutMs`              |          `300000`  | integer from 0 (disabled) through 2147483647      |
| `inlineAttachmentLimitBytes` | `131072` (128 KiB) | integer from 1024 (1 KiB) through 1048576 (1 MiB) |
| `mailboxPayloadLimitBytes`   | `131072` (128 KiB) | integer from 1024 (1 KiB) through 1048576 (1 MiB) |
| `disabledDefinitions`        |                `[]` | unique definition names, at most 64              |
| `modelScopes`                |                `{}` | `allow` and `agents` lists of model patterns     |

Malformed JSON, a non-object root, unknown fields, and invalid known values
are errors. Reads do not create the directory or file. Configuration changes
through `/agents` update this single file atomically.

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
`/agents` → `Soft timeout` item or the config file.

`retainWorkers` controls whether a worker's process and pane survive after its
result is delivered. Left `false`, each managed worker receives exactly one
assignment and is cleaned up after delivery, which is the default lifecycle.
Set to `true`, a delivered worker stays running in the public `idle` state under
its agent label, and a later `agent_continue` for its session delivers the next
assignment into the same live process. Release an `idle` worker with
`agent_close` or the `/agents` → `Clear idle` action.

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

A definition that pins a model whose provider an extension registers while also
setting `noExtensions: true` fails immediately: the child cannot resolve a model
it is denied the extension for. Remove the denial, or pin a model a built-in
provider serves. Without this check the failure surfaces about two seconds later
as `Model "<id>" not found`, which reads as a missing model rather than as a
conflicting definition.

A nested agent inherits its managed parent's model, so a scope on the parent's
definition governs the model a grandchild inherits.

Placement affects future starts, not existing agents. `tab` uses one lead-owned
agents tab, `subtree` gives each lead-direct agent its own tab, and `split`
splits from the caller's pane. Nested delegation always splits in its owner's
current tab.

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
