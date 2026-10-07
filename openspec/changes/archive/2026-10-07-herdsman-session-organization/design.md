# Design

## Context

See `proposal.md` for motivation. Installed Pi 1.0.2 supports `sessionDir` (relative to cwd), `--session-dir`, and explicit `--session <path>`. Native listing is flat: the project picker reads its active session directory and the default global picker scans one project-directory level. A `children/` subdirectory is therefore omitted from operator picking.

Today `prepareManagedWorkerLaunch` constructs shared launch arguments for delegation and relaunch. Worker startup calls `ensureAgentIdentity`, which persists `pi-herdsman-agent-definition` with `sessionId`, `definition`, and `label`. `persistRole` separately records Lead/Manager/Chief transitions. `resolveAssignmentSession` relies on recorded exact session paths and completed-result provenance; those remain authoritative for admission.

Relevant evidence is in `.pi-herdsman/session-picker-recon.md` and `.pi-herdsman/session-consumer-discovery.md`. Existing hierarchy and retained-worker specs were read; this change adds offline discovery facts without changing their authority or continuation requirements. The retained-worker spec still says default `false` although the implementation now defaults to `true`; that pre-existing documentation inconsistency is not repaired by this change.

## Goals / Non-Goals

**Goals:** separate new operator/managed files, make session classification and direct-owner hierarchy recoverable from JSONL alone, preserve historical paths and continuation safeguards.

**Non-goals:** those in the proposal; additionally, no undocumented Pi header fields, UUID-prefix convention, sidecar authority, topology-dependent directory nesting, or inferred project/Git root.

## Decisions

### D1. Native operator configuration, not an extension directory hook

The dotfiles owner sets `programs.pi-coding-agent.settings.sessionDir = ".pi/sessions"` in `modules/agents/pi.nix`. Pi resolves this from each launch cwd. Native CLI/environment overrides keep their normal precedence for operator sessions. Herdsman does not rewrite an already-open operator session or monkey-patch `/resume`.

Alternative: an extension-owned session-directory hook. Pi 1.0.2 has no such hook. Alternative: duplicate per-repository settings. A user-level default achieves the requested deployment without editing every project.

The dotfiles owner's global ignore must cover generated `.pi/sessions/` directories, including when Pi runs below a repository root, without ignoring versioned `.pi/settings.json`, skills, or other resources. Verify both root and nested-cwd examples before accepting the rule.

### D2. One explicit local child directory per target cwd

For **fresh managed sessions**, the shared launch plan adds `--session-dir <absolute target-cwd>/.pi/sessions/children`. This intentionally overrides inherited operator settings/environment for managed launches. It does not create `children/children` when a worker delegates: storage depends on the target cwd, not the parent session file's directory. A worker launched with a different cwd writes in that cwd's local child directory.

The fixed convention is the approved project-local layout, not a general configurable-root feature. Operator overrides can place operators elsewhere; managed fresh sessions still follow this convention. Supporting arbitrary shared roots can be revisited with registry work.

Alternative: append `children` to the caller's current session directory. That nests directories on managed-parent launches and misroutes cross-cwd workers. Alternative: partition by definition or parent ID. Role changes and nested ownership belong in metadata, not a deep path hierarchy.

### D3. Never rehome a saved session

All resume/restart/recovery paths continue to pass the saved session's exact `--session` path. Fresh-session directory selection does not relocate an existing file. Preserve the shared preflight, identity locks, activation reservations, unread-result reconciliation, and control restart behavior. Retained reuse needs no filesystem change. Test legacy global and new local sessions through continuation and owner-control restart, not only a path helper.

Alternative: move old worker files to achieve immediate picker cleanup. That invalidates absolute paths held in result provenance and external indexes. No migration is included.

### D4. A new, versioned custom metadata entry

Use supported Pi `custom` entries with `customType: "pi-herdsman-session-metadata"`. Version 1 data:

```json
{"version":1,"sessionId":"<uuid>","kind":"operator","role":"lead"}
```

```json
{"version":1,"sessionId":"<uuid>","kind":"managed","role":"worker","parentSessionId":"<direct-owner-uuid>","definition":"worker","label":"impl"}
```

`kind` records operator versus managed-session origin, not process liveness. Operator roles follow Lead/Manager/Chief transitions; normal managed roles follow the effective definition name, matching current pane facts. `parentSessionId` is the **current direct owner**, consistent with `pi_herdsman_parent_session`, not the root lead or Pi's fork parent. The chronological entries preserve previous ownership if a legitimate continuation updates it.

Keep the existing `pi-herdsman-agent-definition` entry unchanged: its reader strictly expects three keys, and it participates in continuation identity checks. The new metadata is discovery information, not admission/control authority. No copied header, run/pane/process identity, live state, absolute path, or child list is needed.

Alternative: undocumented header keys or a sidecar. Header extension has no supported Pi API; a sidecar introduces another authoritative copy. Alternative: extend the strict old identity entry. Older workers/readers would reject the extra keys.

### D5. Session-scoped reads, append-only meaningful updates

Readers consider the full chronological entry list, selecting the latest matching-session-ID metadata record. Ignore foreign-session records **before** validating their payload. A fork copying its parent's custom entries cannot inherit that parent's managed classification. Emit a new record at session startup and effective role/owner changes only when meaningful fields differ; native entry timestamps suffice.

Validate matching records at the persistence boundary. Malformed or unknown-version current records yield an explicit metadata diagnostic, not a fabricated operator classification. Discovery-metadata failure must not kill a live session or alter assignment authority. Report the error through the existing durable diagnostic surface and leave the ambiguous metadata unresolved.

### D6. Preserve managed origin on manual resume and legacy records

A current-session managed record must not become operator merely because the file is opened without managed launch environment. Preserve its kind and owner/definition/label; an effective operator role transition can update only its role. For a legacy current-session `pi-herdsman-agent-definition` without a known parent, do not invent parentage or label it operator. Write full managed metadata when resumed under a verified managed launch environment. No scan of all historical files is required.

This makes new-session startup, legacy continuation, and fork behavior distinct instead of guessing from the directory name alone. Missing historical metadata means unclassified until a supported observation supplies it.

### D7. Stage configuration until worker override and tests are ready

The operator setting and ignore rule are deployment changes owned and validated by the dotfiles session. They are currently staged, uncommitted, and inactive; its `nix flake check --no-build --no-write-lock-file` passed. Keep activation held while Herdsman wiring is unfinished. Coordinate source ownership: the peer's recovery worker currently holds `extension/index.ts`; no edit there until explicit release.

## Risks / Trade-offs

- **New local sessions are not globally discovered by existing pickers/indexers** → disclose the gap; registry and consumer adapters are a later change. Memex honors one replacement discovery root but skips symlinks. Magic Context live-session operation remains supported; historical discovery is separate.
- **Subdirectory launches make their own local session roots** → document cwd semantics; do not silently introduce Git-root discovery.
- **Gitignored data can be lost with a deleted project/worktree** → document backup/export responsibility; a clone does not include ignored sessions.
- **Absolute provenance paths are not relocatable** → do not promise seamless continuation after a directory move.
- **Metadata remains a custom-entry scan, not a header-only lookup** → keep it small and near startup; a later registry/index can cache discovery without becoming authoritative.
- **Mixed long-lived builds** → retain old identity entries and saved paths; use only native launch flags supported by installed Pi; old processes need reload to emit the new metadata.

## Migration Plan

1. Review these artifacts; keep partial implementation and staged deployment inactive until apply is authorized.
2. Implement metadata module and shared launch/start/role wiring after file ownership releases; gate focused and full suites against the current peer changes.
3. Dotfiles owner verifies narrow ignore behavior and commits its configuration separately. Do not switch/restart panes implicitly.
4. Activate with operator approval. Fresh sessions use the new organization; resumed sessions keep their original path. Verify one fresh operator and managed launch on disk.
5. Rollback configuration/wiring for future launches if needed. Leave local session files intact and resume by exact path; do not delete history.
