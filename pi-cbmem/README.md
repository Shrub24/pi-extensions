# pi-cbmem

The [codebase-memory](https://github.com/DeusData/codebase-memory-mcp) graph as native Pi tools, over MCP stdio.

## Why this exists

`codebase-memory-mcp install --clients=pi` writes `cbmem.ts`, an adapter that shells
out to `codebase-memory-mcp cli --json <tool>` once per call. That mode is documented
as "intentionally separate: it runs one command locally and never starts or connects
the coordination daemon, registers a daemon session, or starts watchers/UI" — so
`auto_index` and `auto_watch` can never fire through it, whatever the config says.
It also serves the server's own JSON Schema as the tool schema, and hides the admin
tools with a second extension (`cbm-toolbox.ts`) that filters the active tool list
after registration.

This extension replaces both. It speaks MCP stdio JSON-RPC to a real server child,
which is what makes the daemon, the auto-index, and the shared watcher work.

## What you get

- **Auto-index, per workspace.** Connecting is the trigger: on `initialize` the server
  derives the session project from its cwd, indexes it in the background, and
  registers it with the account-wide watcher. One child per Pi session, so a herdr
  pane, a subagent, and a second terminal each get their own project while the server
  dedupes the shared work.
- **No project ids to remember.** `project` is optional on every tool that takes one.
  When the model omits it, the session project is filled in — derived with the
  server's own algorithm (`cbm_project_name_from_path`) so the name always matches
  what was indexed. Pass `project` only to query another indexed project.
- **No admin surface.** `index_repository`, `delete_project`, `manage_adr`, and
  `ingest_traces` are not registered by default. The daemon indexes automatically; the
  rest are rare or destructive, and remain available by hand through
  `codebase-memory-mcp cli <tool>`.
- **A tool list that stays short.** Every tool carries a `promptSnippet`, so Pi's
  Available-tools section is one line per tool instead of the full description.
- **Self-healing calls.** A tool call rebuilds a failed or dead server before and
  during its attempt, so a deploy that kills the daemon mid-session costs one
  slow call (~5s), not a stuck session.
- **`/cbm status`** — the project the cwd resolved to, the server state and pid, and
  the tools this configuration registered. `/cbm config` adds the resolved settings,
  `/cbm server` the server's own `config list` and `daemon status`. `/cbm clean`
  deletes indexed projects whose root directory is gone — `/tmp` roots are deleted
  (pytest and opencode leftovers pile up), moved real repos are only reported;
  `--dry` previews.

## Install

```bash
pi install /mnt/LinuxData/Projects/dev/custom/pi-extensions/pi-cbmem
```

Then remove the generated adapter and its filter from the agent extensions directory,
so two sets of the same tools are not registered:

```bash
rm ~/.pi/agent/extensions/cbmem.ts ~/.pi/agent/extensions/cbm-toolbox.ts
```

`codebase-memory-mcp install --clients=pi` may write `cbmem.ts` again on update; it is
unreferenced at that point and safe to delete again. Nothing in this package is
generated.

## Configuration

Settings live in the user settings file under
`kendex.extensionManager.config["@vanillagreen/pi-cbmem"]` and are rendered by
`@vanillagreen/pi-extension-manager`. Project-scope settings are never read: the
binary path and the project decide where the agent looks, so a repository must not
be able to set them.

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Register the tools and start the server. |
| `binary` | `codebase-memory-mcp` | Server executable; a name resolves from PATH. |
| `project` | *(derived)* | Pin every query to one project instead of the session cwd. |
| `connectOnSessionStart` | `true` | Start the server (and the auto-index) when the session opens. |
| `adminTools` | `false` | Also register the four mutating tools. |
| `enabledTools` | `[]` | Allowlist of tool names, or `admin`. Empty means the default query surface. |
| `disabledTools` | `[]` | Names or groups to leave unregistered; applied after the allowlist. |
| `requestTimeoutMs` | `120000` | Per-call timeout; `0` disables it. |
| `notifyOnError` | `true` | One warning when the server cannot start or dies. |

Environment overrides for headless runs and tests: `PI_CBMEM_BINARY`,
`PI_CBMEM_PROJECT`, `PI_CBMEM_DISABLED`, `PI_CBMEM_TOOLS`, `PI_CBMEM_DISABLED_TOOLS`,
`PI_CBMEM_ADMIN_TOOLS`, `PI_CBMEM_CONNECT_ON_SESSION_START`,
`PI_CBMEM_REQUEST_TIMEOUT_MS`, `PI_CBMEM_NOTIFY`.

## Layout

| File | Contents |
|---|---|
| `extensions/cbmem.ts` | Entry point: lifecycle, tool registration, `/cbm`. |
| `extensions/config.ts` | Settings resolution and the project-name derivation port. |
| `extensions/server.ts` | MCP stdio client: handshake, calls, timeouts, one reconnect. |
| `extensions/tools.ts` | The 17-tool table, snippets, schema assembly, selection. |

`bun test ./tests` runs the suite. It needs no server: `tests/fixtures/fake-server.mjs`
speaks the protocol, including the crash paths.
