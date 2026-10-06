# Recon: Pi session organization and picker capabilities (installed Pi 1.0.2)

Read-only investigation. No production code changed. Question set: can native pickers
hide/filter child or worker sessions; can external metadata classify sessions without
parsing transcripts; can `--session-dir` separate worker sessions without breaking
`--continue`/`--resume`; can an extension override `/resume` or supply another picker.

## Sources used (and why they are authoritative)

- Installed docs: `/nix/store/wbnhsmjknfb0bah6cvrhzykyrj9dq6qc-pi-1.0.2/libexec/pi/docs/`
- Installed source: the package that ships with the installed Pi —
  `/home/saurabhj/.pi/agent/npm/node_modules/@earendil-works/pi-coding-agent/` (`package.json` → `@earendil-works/pi-coding-agent@1.0.2`), non-minified `dist/*.js` + `dist/*.d.ts`.
- The 94 MB `/nix/store/...-pi-1.0.2/libexec/pi/pi` binary is a compiled bundle; spot checks
  (`grep -a`) confirmed it contains the same symbols as the 1.0.2 `dist` (`usesDefaultSessionDir`,
  `app.session.toggleNamedFilter`, `filterAndSortSessions`, `session_before_switch`). Cite the
  `dist` paths below; they are the same code, readable.
- Note: sibling extension packages in this repo pin older versions (0.84.4–0.99.2). Their
  `node_modules/@earendil-works/pi-coding-agent/dist` is **not** the installed Pi and must not be
  used to judge 1.0.2 behavior.

## 1. Storage model (confirmed)

- Default dir is per-cwd: `~/.pi/agent/sessions/--<cwd with /,\,: → ->--/`.
  `getDefaultSessionDirPath()` `dist/core/session-manager.js:290`.
- Precedence: `--session-dir` → `PI_CODING_AGENT_SESSION_DIR` → `sessionDir` setting.
  `dist/main.js:549-551` (`ENV_SESSION_DIR` = `PI_CODING_AGENT_SESSION_DIR`, `dist/config.js:439`).
  `--session-dir` parsed at `dist/cli/args.js:99`. Docs: `docs/sessions.md:50`, `docs/settings.md:64`
  (project-local `sessionDir` is read before trust, `docs/configuration.md:3`).
- File naming: `<ISO timestamp with : and . → ->_<session-id>.jsonl`; the session id is also inside
  the header and in the filename (`dist/core/session-manager.js:1241`, `:1396`). `--session-id` accepts
  `[A-Za-z0-9._-]` (`docs/cli.md` sessions section) — so a **prefix-based worker id scheme is natively expressible**.
- Listing is **flat, one directory, `.jsonl` files only**, no recursion:
  `listSessionsFromDir()` `dist/core/session-manager.js:594` (uses `readdirSync(dir)` + `.endsWith(".jsonl")`).
  - `SessionManager.list(cwd, sessionDir?)` `:1449` — one dir; if `sessionDir` is given and differs from
    the default for `cwd`, results are additionally filtered to sessions whose **header `cwd` matches**
    (`sessionCwdMatches`, `:441`; `filterCwd` logic `:1450-1452`).
  - `SessionManager.listAll(sessionDir?)` `:1460` — with no argument scans `getSessionsDir()`
    (`~/.pi/agent/sessions`) and reads **direct subdirectories only, one level deep** (`:1474-1481`);
    with an argument it scans that single dir flat (`:1472`). So `sessions/<anything>/x.jsonl` is visible
    to "All", but `sessions/a/b/x.jsonl` is not.
  - `findById` (`:1421`) searches only the given/derived dir, flat — no cross-dir ID lookup.
- Session header (`dist/core/session-manager.d.ts:6-13`): `{type:"session", version, id, timestamp, cwd, parentSession?}`.
  There is **no** role/child/owner field, no sessionDir field.
- Header is read cheaply and independently of the transcript: `readSessionHeader()` `dist/core/session-manager.js:385`
  reads the first line only (4 KiB buffer, hard 1 MiB scan cap → `SessionHeaderScanLimitError`).
- Header is preserved verbatim: `_loadEntries` keeps raw file entries (`:717`), `_rewriteFile` re-serializes
  them (`:754`). **Unknown extra header keys survive rewrites** (migration only rewrites when the version
  changes). Typed interface is narrower than runtime behavior — flagged as inference from code, not documented.
- `SessionInfo` (`dist/core/session-manager.d.ts:163-181`): `path, id, cwd, name?, parentSessionPath?,
  created, modified, messageCount, firstMessage, allMessagesText`. Built by `buildSessionInfo()` `:492`,
  which **streams the entire file** (all lines) to collect `messageCount`/`firstMessage`/`allMessagesText`.
  `session_info` entries → `name`; `custom`/`usage`/`label`/etc. are skipped entirely.

## 2. `parentSession` — precise native meaning (confirmed)

`parentSession` in the header means "this session file was **derived from** that session file". It is set by:

- `SessionManager.forkFrom()` (`:1374`, header written `:1398-1405`, `parentSession` `:1404`) → `parentSession: resolvedSourcePath` (used by `--fork`).
- New session created from a branch: `branchWithSummary`/new-file path writes
  `parentSession: this.persist ? previousSessionFile : undefined` (`:1248`).
- `SessionManager.create/open(...).newSession({parentSession})` (`NewSessionOptions`, `d.ts:15-18`), used by
  `AgentSessionRuntime.fork()` (`dist/core/agent-session-runtime.js:200-205`), by
  `newSession({parentSession})` (`:157-158`), and by RPC `new_session` with `parentSession`
  (`dist/modes/rpc/rpc-mode.js:335`, documented `docs/rpc-commands.md:138-140`).

It is **not** set by: interactive `/new` (`InteractiveMode.handleClearCommand` →
`runtimeHost.newSession()` with no options, `dist/modes/interactive/interactive-mode.js:5746-5750`;
`AgentSessionRuntime.newSession()` `:147-158`), CLI `--continue`/`--resume`, or a plain
`pi --session-id <id>` start (`dist/main.js:345-351`).

Consequences: `parentSession` is fork/clone/branch lineage, **not** "managed worker of". Herdsman could
still use it to mark worker sessions as children — via `--fork <coordinator-session>` (CLI-native) or the
SDK/extension `newSession({parentSession})` — but see the picker nesting caveat in §3.

## 3. Picker behavior (confirmed)

Both pickers are the same exported component: `SessionSelectorComponent` (public export,
`dist/index.d.ts:36`, implementation `dist/modes/interactive/components/session-selector.js`).

- In-session `/resume`: `dist/modes/interactive/interactive-mode.js:2634-2637` → `showSessionSelector()`
  `:4702-4720` with loaders
  - current scope → `SessionManager.list(cwd, this.sessionManager.getSessionDir(), …)`
  - all scope → `this.sessionManager.usesDefaultSessionDir() ? SessionManager.listAll() : SessionManager.listAll(getSessionDir())`
  - keybinding action `app.session.resume` → same handler (`:2425`).
- Startup `pi -r`: `dist/cli/session-picker.js:9-29`, wired in `dist/main.js:330` with
  `list(cwd, sessionDir)` / `listAll(sessionDir)`. This runs **before extensions load** (`createSessionManager`
  at `main.js:552` precedes runtime/extension creation at `:587+`), so extensions cannot influence it.
- Search semantics (`dist/modes/interactive/components/session-selector-search.js`):
  - search text = `${session.id} ${session.name ?? ""} ${session.allMessagesText} ${session.cwd}` (`:5-7`).
    `allMessagesText` is the joined text of every user/assistant message — i.e. the picker already
    full-scans transcripts, and search can match transcript content.
  - token fuzzy + "quoted phrase" + `re:<pattern>` regex mode (`:16-104`). **All matching is
    positive/inclusion-only — there is no negation, exclude list, glob-ignore, or directory filter.**
  - `NameFilter` = `"all" | "named"` (`hasSessionName`, `:8-10`) → the `ctrl+n` "named only" toggle. Also
    inclusion-only.
- Display: `name ?? firstMessage` (`session-selector.js:390`), with message count + age, optional cwd /
  path columns.
- Threaded sort is the **default** (`sortMode = "threaded"`, `:239`): with an empty query,
  `filterSessions()` (`:308-323`) builds a tree from `parentSessionPath` (`buildSessionTree` `:167-206`) and
  renders nesting with box-drawing prefixes (`buildTreePrefix` `:443-450`). Nesting happens only when the
  parent path is also in the listed set; otherwise the child is shown as a root.
  → **Marking workers via `parentSession` does not hide them; it visually groups them under the coordinator
  when the coordinator is in the same list.**
- Keybindings relevant to the picker (`docs/keybindings.md` Sessions table, `app.session.*`):
  `togglePath ctrl+p`, `toggleSort ctrl+s`, `toggleNamedFilter ctrl+n`, `rename ctrl+r`, `delete ctrl+d`,
  `deleteNoninvasive ctrl+backspace`. All are display/filter/sort/mutation — none is a filter predicate.

## 4. Native controls available today (answers Q1/Q2/Q3)

- **Hide/filter children: no.** No picker feature, no setting, no CLI flag filters by role, parent, path, or
  metadata. `pi --help` (run against the installed binary) lists only
  `-c/--continue, -r/--resume, --session, --session-id, --fork, --session-dir, --no-session, -n/--name`.
  `docs/sessions.md:18` lists search/rename/delete/paths/sort/named-only.
- **Directory separation: yes, and it is the strongest native lever.** Because the picker's default scope is a
  *single flat directory* (`getDefaultSessionDir(cwd)`) and listing never recurses, sessions written with
  `--session-dir <elsewhere>` do not appear in the operator's default "Current Folder" scope at all.
  Caveat: the "All" scope, when the operator is on the default dir, scans one level under
  `~/.pi/agent/sessions/` (`listAll()` `:1474-1481`) — so a worker dir placed *as a direct child of
  `~/.pi/agent/sessions/`* **is** visible there. Placing worker dirs outside `~/.pi/agent/sessions/`
  (e.g. `~/.pi/agent/herdsman/sessions/…`) hides them from both scopes.
- **Classify without parsing the transcript: partially, and cheaply.** For an external consumer the cheapest
  durable signals are the file name (session id) and the first line of JSONL (header):
  `id`, `cwd`, `timestamp`, `version`, `parentSession`. Name requires scanning for a `session_info` entry.
  `custom` entries (`dist/core/session-manager.d.ts:81-86`) are durable per-session metadata but are
  **invisible to `SessionInfo` and to the picker** (`buildSessionInfo` `:519-520` skips non-`message` entries after
  handling `session_info`); they are readable only by extensions via `ctx.sessionManager.getBranch()`/`getEntries()`
  or by an external file scan.
  So: yes for path/name/id conventions or header `parentSession`; no for anything surfaced by the native picker.
- **`--session-dir` and continuation (Q3): works, with documented caveats.**
  - The same resolved `sessionDir` drives listing, `--continue` and `--session` id lookup
    (`dist/main.js:342`, `:330`, `:188-219`, `createSessionManager` `:285-352`). To continue a worker session
    started with `--session-dir W`, the operator must pass `--session-dir W` (or an explicit
    `--session <abs path>`); a bare id prefix will not be found across directories.
  - `SessionManager.open(path, sessionDir?)` derives the manager's dir from **the opened file's parent dir**
    when `sessionDir` is omitted (`:1326-1346`); `continueRecent` uses the passed dir (`:1354-1361`).
  - `AgentSessionRuntime.switchSession()` calls `SessionManager.open(sessionPath, undefined, …)`
    (`dist/core/agent-session-runtime.js:134`). → **Resuming a session that lives in another directory
    silently re-homes the session manager to that directory**: later `/new` lands there, and
    `usesDefaultSessionDir()` becomes false, so the picker's "All" scope becomes
    `listAll(that dir)` (flat). This is the main cross-directory compatibility trap.
- **Confirmed: no extension hook exists for the session directory in 1.0.2.** A `session_directory`
  extension event existed historically and was removed:
  `CHANGELOG.md:2608` "Removed `session_directory` from extension and settings APIs." (0.65.0, breaking).
  It is absent from `dist/core/extensions/types.d.ts` and from the shipped binary.

## 5. Extension seams for a picker (answers Q4)

Confirmed APIs (present in 1.0.2 types and used by built-ins):

1. **Cannot shadow the builtin `/resume` in the TUI.** `setupEditorSubmitHandler`
   (`dist/modes/interactive/interactive-mode.js:2498-2652`) hard-codes builtin slash commands
   (`/resume` at `:2634`) *before* falling through to `this.session.prompt(text)`; extension commands are
   only resolved later via `_tryExecuteExtensionCommand` (`dist/core/agent-session.js:1600-1624`) /
   `isExtensionCommand` (`interactive-mode.js:3854-3861`). `BUILTIN_SLASH_COMMANDS`
   (`dist/core/slash-commands.js:1-27`) includes `resume`; no duplicate-name validation exists, so
   `registerCommand("resume", …)` is accepted but shadowed in the TUI.
   The `input` event (`InputEvent`/`InputEventResult`, `types.d.ts:873-893`, emitted only inside
   `AgentSession.prompt`, `agent-session.js:1440-1454`, `:1502`) therefore also never fires for `/resume`
   in the TUI.
2. **A separate, fully capable picker command is feasible.** All pieces are public exports:
   `SessionManager`, `SessionInfo` (`dist/index.d.ts:21`), `SessionSelectorComponent`
   (`dist/index.d.ts:36`), plus `ctx.ui.custom()` (`types.d.ts:121-131`),
   `ctx.sessionManager` (read-only, `types.d.ts:223`), and `ExtensionCommandContext.switchSession(path, {withSession})`
   (`types.d.ts:286-327`). A `/herdsman-sessions` command can: enumerate dirs/files itself, read only first
   lines for cheap classification, feed a filtered `SessionInfo[]` into `SessionSelectorComponent`'s loader
   callbacks, and switch with `ctx.switchSession()`.
3. **Keybinding entry point without touching `/resume`.** `registerShortcut(key, {handler})`
   (`types.d.ts:1196-1199`, `ExtensionShortcut` `:1520-1525`) + `getShortcuts` conflict rules
   (`dist/core/extensions/runner.js:9-50`, `:449-478`): only `app.interrupt/clear/exit/suspend`,
   `app.thinking.*`, `app.model.*`, `app.tools.expand`, `app.editor.external`, `app.message.copy/followUp`,
   `tui.input.submit`, `tui.select.confirm/cancel`, `tui.input.copy`,
   `tui.editor.deleteToLineEnd` are reserved (extension skipped). **`app.session.*` is not reserved**, so an
   extension shortcut on a key the user bound to `app.session.resume` wins, with a conflict warning.
   Dispatch: `interactive-mode.js:1683-1735`.
4. **Adjacent, weaker seams (confirmed but not substitutes):**
   - `session_before_switch` (`types.d.ts:567-573`, result `{cancel?: boolean}` `:1093-1095`, emitted from
     `agent-session-runtime.js:129`) can veto a switch *after* selection — not a list filter.
   - `session_start`/`session_shutdown`/`session_info_changed` events observe switches/naming.
   - `pi.setSessionName()` / `/name` → `session_info` entry, picker-visible and matched by the
     `ctrl+n` named-only toggle (`docs/session-format.md:207`, `CHANGELOG.md:3696`).
   - Proposed (inference, not verified by running): a custom editor via `ctx.ui.setEditorComponent()`
     that rewrites a submitted `/resume` into the extension's own command, or `ctx.ui.onTerminalInput()`
     (consume/rewrite raw keys, `types.d.ts:53-57`, wiring `interactive-mode.js:1985-2002`). Treat as
     hacky fallbacks; the builtin check happens in the editor's `onSubmit`, so text rewriting is the only
     lever there. Not needed given (2)+(3).

## 6. Risks / caveats for a Herdsman-side decision

- Transcript-heavy listing: `SessionManager.list*` streams every listed file to build `SessionInfo`
  (`buildSessionInfo` `:492-560`). A custom picker that only needs ids/paths/names should read first lines
  (`readSessionHeader` semantics) rather than reuse `list()` for large dirs.
- The native picker's search can match transcript content (`allMessagesText`), so an injected marker would
  make workers *findable* but never *excludable*.
- Placing worker sessions under `~/.pi/agent/sessions/<one-level>/` still shows them in the operator's "All"
  scope (Tab). Use a worker dir outside that root for full invisibility.
- Resuming across directories re-homes `/new` and the picker's "All" scope to the foreign dir (§4).
- Any Herdsman change to where worker sessions are written changes `--continue` semantics for those workers:
  a worker relaunch must reuse the exact `--session-dir` (or `--session <path>`).
- `parentSession` as a worker marker will surface workers as children in the default threaded view — it is
  metadata, not a hide.

## 7. Open questions (for the owner of the Herdsman side)

1. What session dir do Herdsman workers use today — default (per-cwd) or an explicit `--session-dir`?
   This determines whether any native picker change is needed at all. (Out of this recon's scope: Herdsman source.)
2. Is the desired classification durable and machine-readable (worker vs operator, role, parent), or only
   "keep workers out of my picker"? The first needs a convention (id prefix / dedicated dir / injected
   header key), the second is satisfied by directory separation.
3. If a custom picker extension is wanted, is it acceptable that it is a new command plus keybinding rather
   than a replacement of `/resume` (which is not replaceable in the TUI)?

## Start here

1. `dist/main.js:540-560` + `dist/core/session-manager.js:1449-1500` — exactly which directories each picker
   scope reads, and the sessionDir precedence. This is the whole "clutter" question.
2. `dist/modes/interactive/components/session-selector-search.js` — the complete filter surface (positive-only).
3. `dist/modes/interactive/interactive-mode.js:2498-2652` + `:4702-4720` — why `/resume` cannot be shadowed
   and how the in-session loaders are built.
4. `dist/core/extensions/types.d.ts:260-301`, `:1194-1199`, `dist/index.d.ts:21,36` — the confirmed extension
   API surface for an alternative picker.
