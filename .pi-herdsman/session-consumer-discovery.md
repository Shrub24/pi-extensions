# Recon: discovery consequences of project-local Pi session storage (installed integrations)

Read-only. No production edits. Peer evidence reused from `.pi-herdsman/session-picker-recon.md`
(native Pi picker, `--session-dir` semantics, header/`custom` entry facts) — not repeated here.

Question set: does project-local storage (e.g. `<project>/.pi/sessions` with nested children)
break discovery for the installed integrations; what explicit-root configuration exists; is a
minimal project registry enough, or are adapter changes required.

## Method and evidence sources

- Memex: installed binary `~/.nix-profile/bin/memex` → `/nix/store/4hfqvi2pnbbskgal1r061an6bxs89sbm-memex-0.27.1/bin/{memex,.memex-wrapped}` (0.27.1; wrapper is a 278-byte bash script around a 45 MB Rust binary). Evidence: `--help` output, `strings` on the binary, and the indexed corpus itself (`memex sessions --source pi --format json --limit 300`, read-only).
- Magic Context: `~/.pi/agent/npm/node_modules/@cortexkit/pi-magic-context` v0.45.0 (`dist/index.js`, non-minified bundle) + `README.md` + local config `~/.config/cortexkit/magic-context.jsonc`.
- Pi native picker: prior recon (`.pi-herdsman/session-picker-recon.md`).
- Hindsight: `~/.pi/agent/hindsight.json` and the fleet service config `/nix/store/34p9bpcdgimlk5w7r3yqd9kmv6y1sgma-hindsight.yaml`. No local source found.

## 1. Memex (confirmed)

**Root resolution.** `memex index --help` "Sources:" exposes exactly one path option,
`--claude-path` (Claude only), plus `--only-source` / `--exclude-source` /
`--include-reasoning` / `--exclude <GLOB>`. The Pi root is fixed in the binary; its help string is:

```
Index Pi sessions from ~/.pi/agent/sessions or $PI_CODING_AGENT_DIR/sessions [default: true]
NO_PI / Skip indexing Pi sessions
```

i.e. **`${PI_CODING_AGENT_DIR}/sessions` if that env var is set, else `~/.pi/agent/sessions`**.
No project-local or "extra root" option exists. Binary strings also contain
`PI_CODING_AGENT_SESSION_DIR`, `.pi/agent/sessions`, `pi/agent/sessions`. **Resolved by experiment
(§9): `PI_CODING_AGENT_SESSION_DIR` IS honored by 0.27.1 and *replaces* the default root** — it is a
whole-root override, undocumented in `--help`, not an additional root.

**Observed behaviour on the live index** (300 most recent `pi` sessions):

| Check | Result |
|---|---|
| rows under `~/.pi/agent/sessions/--<encoded-cwd>--/` | 300 / 300 sampled (925 `pi` sessions indexed in total) |
| rows under any project-local `.pi/sessions/` | **0** |
| rows below the per-cwd directory (e.g. `…/<session-id>/forks/…`) | present → Memex **recurses** deeper than one level |
| per-row fields | `source, session_id, source_path, project, repo_project, cwd, git_root, started_at, last_at, message_count, label, conversation_kind, machine, resume_cmd` |
| `resume_cmd` for `pi` | `pi --session '/home/saurabhj/.pi/agent/sessions/--…--/<file>.jsonl'` (absolute path) |

**Config surface (UserConfig field names visible in the binary):** per-source `*_resume_cmd`
(including `pi_resume_cmd`), `herdr_resume`, `exclude_paths`, `multi_machine`, `mcp`, … — a
command template and an exclusion glob list, **no root/path add key**. `~/.memex/config.toml`
currently sets only `auto_index_on_search`, `index_service_mcp`, `[mcp] listen`.

Verdict: Memex enumerates one fixed root (agent dir), recursively; it can be told to *skip*
paths (`--exclude` / `exclude_paths`) but not to *read an additional root*.

## 2. Magic Context (confirmed)

Two distinct consumption modes, both relevant:

**a) Active session (unaffected).** Live features use the Pi host API
(`ctx.sessionManager`, `getBranch`) — they read the session the process is running in, wherever
that file lives.

**b) Historical enumeration (fixed root).** `dist/index.js`:

- `sessionFiles(directory, nested)` `:17496-17517` — flat `.jsonl` scan; recurses exactly one
  level when `nested` is true.
- `sessionHeaders(directory, nested)` `:17525` — reads only the first line, requires `type:"session"`.
- `createPiPrimerRawProviderFactory(deps = {})` `:17832-17853`: `directory = deps.sessionDir`;
  if absent → `join(mod.getAgentDir(), "sessions")`; then `findSession(directory, !deps.sessionDir, sessionId)`.
- `PiRetrospectiveRawProvider.listProjectSessions()` `:17864-17900`: same directory logic, then
  `deps.listSessions(directory)` or `sessionHeaders(directory, !deps.sessionDir)`, filtered to
  sessions whose header `cwd` resolves to the project dir.
- `loadDefaultPiSessionApi()` `:17732-17744` binds `listSessions = SessionManager.listAll`
  (i.e. **Pi's own listing**, agent-dir root, one level) and `loadEntriesFromFile`.
- **Wiring has no root override:** `:18096-18100` and `:18127-18131` construct both providers with
  only `{ projectCwd, contextDb }` — no `sessionDir`, no `listSessions`. So both fall back to
  `getAgentDir()/sessions`.
- **Startup backfill (not dreamer-gated):** `startPiMagicContextRuntime` `:40036-40075` (`runSessionProjectBackfill` call at `:40048`) calls
  `loadDefaultPiSessionApi()` then `api.listSessions()` **with no argument** → `SessionManager.listAll()`
  → `<agentDir>/sessions/*/` one level, feeding `runSessionProjectBackfill` (session→project/cwd
  mapping) and `backfillPiSessionActivity` (session id → path). Guarded only by
  `claimPiStartupMaintenance()`.

**Local configuration:** `~/.config/cortexkit/magic-context.jsonc` has keys
`$schema, cache_ttl, dreamer, embedding, execute_threshold_tokens, historian, memory, pi,
smart_drops, toast_duration_ms, todowrite`; the `pi` block only holds `subagent_extensions`.
`dreamer.disable = true` here, so the retrospective/primer directory scan is **dormant on this
machine**, while the startup backfill still runs.
`MAGIC_CONTEXT_STORAGE_DIR` and the shared DB (`~/.local/share/cortexkit/magic-context/context.db`)
affect only Magic Context's own storage — the README states it "does not change Pi's own
configuration or session directories".

Verdict: no supported way to point Magic Context at a project-local Pi session root. There is a
**dormant seam** (`deps.sessionDir` / `deps.listSessions`) that is never wired for Pi.

## 3. Native Pi picker (prior recon, restated in one line)

Default scope is one flat directory (`getDefaultSessionDir(cwd)`); the "All" scope with the
default `sessionDir` lists **one level under `<agentDir>/sessions`**, flat. Details and caveats
(cross-directory re-homing of `/new` after resume) in `.pi-herdsman/session-picker-recon.md` §3-§4.

## 4. Hindsight (absent evidence — do not assume)

- Config present: `~/.pi/agent/hindsight.json` =
  `{"banks":{"project":{"enabled":true,"derive":"manual","bankId":"dev"}},"hindsight":{"baseUrl":"http://home-forge:8888"}}`.
- Fleet service artifacts exist (`podman-hindsight` unit drvs, sops-encrypted
  `/nix/store/34p9bpcdgimlk5w7r3yqd9kmv6y1sgma-hindsight.yaml`) but that file contains only
  `llm`, `embeddings`, `mcp`, `roles` — **no ingestion/session-path configuration**.
- No installed Pi-side integration found: no `hindsight` package in
  `~/.pi/agent/npm/node_modules` or `~/.pi/agent/npm/package.json`, nothing in
  `~/.pi/agent/settings.json` `packages`, and no `hindsight` reference in any extension/package source under
  `~/.pi/agent/extensions|skills|agents|missions` (one unrelated permission-review *log* file matches
  the substring). Hindsight is not in `mcp.json` either.
- Conclusion: discovery behaviour cannot be assessed locally (ingestion is server-side). Nothing
  installed here would need changing; treat as an open risk if it later ingests by path.

## 5. Consumption-mode classification

| Consumer | Mode | Where its data comes from | Project-local storage effect |
|---|---|---|---|
| Pi `/resume` + `-r` picker | historical enumeration | active `sessionDir` (current scope) / `<agentDir>/sessions` one level (All scope) | current scope follows `sessionDir` (intended); All scope collapses to that one dir |
| Memex index + search | historical enumeration | one fixed root: `PI_CODING_AGENT_SESSION_DIR` (replaces) else `$PI_CODING_AGENT_DIR/sessions` else `~/.pi/agent/sessions`; recurses real dirs, ignores symlinks | **not discovered** — 0 of 300 indexed rows come from a project-local root |
| Memex `show/session` / `resume_cmd` | exact path | absolute `source_path` recorded at index time | unaffected once indexed; but paths only exist after discovery |
| Magic Context live tools (`ctx_*`, historian on the running turn) | active session | Pi host API of the current process | unaffected |
| Magic Context startup backfill (`session→project`, activity) | historical enumeration | `SessionManager.listAll()` → `<agentDir>/sessions/*/` one level | **not discovered** |
| Magic Context dreamer retrospective/primer | historical enumeration | `getAgentDir()/sessions`, one nested level | **not discovered**; dormant here (`dreamer.disable=true`) |
| Anything given an explicit session path | exact path | path argument | unaffected |

## 6. What a move to project-local storage actually requires

- **A project registry alone is not sufficient** for either installed consumer. Neither reads a
  registry: both walk a directory tree and parse the JSONL first line. A registry would only help
  new Radar-side picking code, and even then the *paths* it would hand out exist only if something
  discovers them.
- **Adapter changes needed** if historical discovery must cover project-local files:
  - Memex: add a Pi-root/extra-root option (or accept `--exclude`-style globs for roots). Only
    levers today: `PI_CODING_AGENT_DIR` (relocates the *entire* Pi agent dir — config, auth,
    extensions — so it is not a per-project option) and `exclude_paths` (removal only).
  - Magic Context: wire `deps.sessionDir` and/or `deps.listSessions` for the Pi providers (seam
    exists, currently hardcoded to the agent-dir root) — applies to the startup backfill too, which
    is not configurable.
- **No change needed:** all active-session consumption; exact-path retrieval; and anything that
  receives a path explicitly.
- **Symlink mitigation: DISPROVEN for Memex (tested, §9).** Memex 0.27.1 does not traverse
  directory *or* file symlinks under the Pi session root, even when the link target sits inside the
  same root. So symlinking a project's `.pi/sessions` into `<agentDir>/sessions/<name>` does **not**
  make those sessions indexable. (Magic Context's symlink behaviour was not tested here.)

## 7. Risks and nuances

- The two "compatible-looking" knobs are traps: `PI_CODING_AGENT_DIR` moves the whole agent dir,
  and `MAGIC_CONTEXT_STORAGE_DIR` moves only Magic Context's DB (explicitly not session dirs).
- Magic Context's backfill runs at every Pi startup under one process's lock, so silent gaps in
  `session→project` attribution accumulate without any user-visible error.
- Memex's `--exclude <GLOB>`/`exclude_paths` is the only first-class "keep this out of the index"
  mechanism; it cannot express "also look here".
- Memex already derives `project`, `repo_project`, `cwd`, `git_root`, `label`, `conversation_kind`
  and an absolute-path `resume_cmd` per session; a hand-maintained project registry would duplicate
  that derivation rather than replace it, unless the registry is what Radar needs for non-session
  project picking.
- Pi's `sessionDir` accepts project-relative paths (project `.pi/settings.json` `sessionDir:
  ".pi/sessions"`), and is read before trust — that is the mechanism the user's layout relies on;
  see the prior recon for picker/`--continue` consequences.

## 8. Open questions / unresolved

1. ~~Semantics of `PI_CODING_AGENT_SESSION_DIR`~~ — **RESOLVED (§9): honored, and it replaces the
   default root.**
2. Hindsight ingestion behaviour is server-side and not visible locally; needs the fleet repo, not
   this machine.
3. ~~Does Memex follow symlinked session directories?~~ — **RESOLVED (§9): no.** Neither directory
   nor file symlinks are traversed, including a link whose target is inside the same root.
4. Whether Magic Context's `listSessions` seam is intentionally pluggable upstream (no config key
   reaches it) — belongs to the Magic Context maintainers.

## 9. Isolated fixture experiments — resolutions (Memex 0.27.1)

Scope: resolve `PI_CODING_AGENT_SESSION_DIR` semantics and symlink traversal only. No Magic Context,
Hindsight, production or real-index work.

**Method.** Four synthetic 3-line Pi JSONL fixtures (header `{type:"session",version:3,id,timestamp,cwd}`
plus two `{type:"message",id,parentId,timestamp,message}` entries; filenames
`<ISO with :/./ ->_-><session-id>.jsonl`), each with a fixed distinct UUID, indexed into *fresh
isolated roots* with `env -i` passing only `PATH`, `HOME`, `XDG_*` (so no inherited `PI_*` reaches
memex) and `--only-source pi --no-embeddings --non-interactive --no-update-check --root <fresh>`.
`memex search` was never run, so auto-index-on-search could not fire.

Fixture UUIDs: **A** `1111…1111` control (flat, `<fixture HOME>/.pi/agent/sessions/--tmp-mx-control--/`);
**B** `2222…2222` (`/tmp/memex-exp/envroot/--tmp-mx-env--/`); **C** `3333…3333` (flat, external);
**D** `4444…4444` (nested `<C>/forks/`, external); **E** `5555…5555` (nested `<A>/forks/`, real dirs).

**Isolation proven before drawing conclusions (not assumed):**

- `memex index stats --root /tmp/memex-exp-probe` on a fresh empty dir printed
  `index: /tmp/memex-exp-probe/index`, `documents: 0` → `--root` is honored in-process; no delegation
  to the running `memex daemon run` (PID 1714553) and no read of the real corpus.
- Run 1 shows the fixture `HOME` is honored: only the fixture under
  `$HOME/.pi/agent/sessions/--tmp-mx-control--/` was scanned; the 925 real Pi sessions under
  `/home/saurabhj/.pi/agent/sessions` were untouched.
- Post-run no-touch invariant: `memex sessions --source-path /tmp/memex-exp --count --root ~/.memex`
  → `{"total":0}` (exit 0). The real index/config/db were never written (and `~/.memex/config.toml`
  is a read-only nix-store symlink). Note `~/.memex/{index,state}` mtimes move continuously because of
  the pre-existing daemon, so the count invariant — not mtime — is the evidence.

| Run | Extra env / setup | Exact result | Reading |
|---|---|---|---|
| 1 | control, `--root …/root1` | `indexed 2 records across 1 files (skipped 0)`, exit 0; 1 row = **A** at `<fixture HOME>/.../--tmp-mx-control--/…` | default root + fixture HOME work; isolation holds |
| 2 | `PI_CODING_AGENT_SESSION_DIR=/tmp/memex-exp/envroot --root …/root2` | `indexed 2 records across 1 files (skipped 0)`, exit 0; 1 row = **B only** — A was still present in the default root and was **not** indexed | **override honored; REPLACEMENT, not additive** |
| 3 | default root = real A + dir symlink `sessions/--tmp-mx-link--` → `/tmp/memex-exp/linktarget/--tmp-mx-link--` (flat C, nested D) | `indexed 2 records across 1 files`, exit 0; 1 row = **A only** | directory symlink not traversed |
| 4 | added E (`<A>/forks/`, real dirs), a canonical-named **file** symlink to C, and an **internal-target** dir symlink `--tmp-mx-linkin--` → `--tmp-mx-control--` | `indexed 4 records across 2 files`, exit 0; 2 rows = **A and E only** (`…/--tmp-mx-control--/<A-id>/forks/<E>.jsonl`) | recursion through real dirs works to depth 2; **file symlink and internal-target dir symlink both ignored** |

**Conclusions.**

1. **`PI_CODING_AGENT_SESSION_DIR` is honored by installed Memex 0.27.1 and replaces the default Pi
   root.** Setting it made the default-root fixture invisible while the env-root fixture was indexed —
   so the two roots are not scanned together. A project-local layout is therefore indexable *today*,
   per-invocation, by exporting that variable (or by changing the resolved root in our fork).
2. **Memex does not follow symlinks under the Pi session root** — neither directory links nor file
   links, and not even when the link target is inside the same root (so this is symlink avoidance, not
   a path-containment filter). Real-directory recursion is fine: `<per-cwd>/<session-id>/forks/<file>`
   is indexed, which is why run 3's miss is attributable to the symlink and not to depth.
3. Therefore the §6 symlink mitigation is **not** a working path for Memex.
4. Because the fork is ours, option 1 needs no upstream dependency; no workaround design is proposed
   here (parent owns recommendations).

**Not tested (explicitly out of scope):** symlink behaviour when the root comes from the env override;
file symlinks whose filename does not match the canonical pattern; precedence between
`PI_CODING_AGENT_SESSION_DIR` and `PI_CODING_AGENT_DIR` (only the former was ever set); Windows
reparse points; Magic Context equivalent behaviour (parent scope).

**Apparatus:** `/tmp/memex-exp/` holds the fixture tree, `run1.json`–`run4.json`, and isolated indexes
`root1`–`root4` (plus probe root `/tmp/memex-exp-probe`). `rm -rf /tmp/memex-exp /tmp/memex-exp-probe`
removes everything; nothing outside `/tmp` was written.
