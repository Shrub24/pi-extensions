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
  "mailboxPayloadLimitBytes": 131072
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
