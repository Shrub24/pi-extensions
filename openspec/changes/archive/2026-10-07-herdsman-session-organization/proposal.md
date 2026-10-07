# Proposal

## Why

Managed-worker sessions currently occupy the same native session-picker directory as operator conversations. Their own JSONL files record a definition and label, but not the parent session, so offline consumers cannot reconstruct the orchestration hierarchy without joining transient mailboxes and owner result history.

## What Changes

- Configure this operator's Pi installation to store new operator sessions in `<cwd>/.pi/sessions/` through native `sessionDir` settings, with only generated session data ignored by Git/Jujutsu.
- Start new managed sessions in `<target-cwd>/.pi/sessions/children/`, including nested workers, using an explicit child-only session-directory override.
- Persist a versioned, session-ID-bound `pi-herdsman-session-metadata` custom entry containing operator/managed classification, role, and managed-worker definition, label, and direct parent session ID.
- Record metadata at startup and meaningful role/owner changes, without duplicating unchanged entries or conflating orchestration parentage with Pi's native fork lineage.
- Preserve exact paths for all historical sessions and resumed workers. Do not migrate, rename, delete or bulk-backfill existing session files.
- Document that new local sessions are outside existing global historical-discovery scans until the later registry/consumer work.

## Capabilities

### New Capabilities

- `herdsman-session-organization`: local operator/child storage separation and durable session-local classification and direct-owner metadata.

### Modified Capabilities

None. Existing retention, continuation, authorization, native fork lineage, and pane metadata requirements remain in force.

## Impact

Herdsman worker launch/startup/role-transition wiring in `extension/index.ts`, a focused session-metadata module and regression tests, and a session-organization reference page. The deployment setting and ignore rule belong to the dotfiles owner (`modules/agents/pi.nix` and `modules/dev-tools/cli.nix`), not this repository's implementation scope. No new dependency or control wire.

## Non-goals

Project registry, alternative picker, Memex/Magic Context/Hindsight adapters, historical-session relocation or backfill, Git-root discovery, worktree-history sharing, portable relocation of absolute provenance paths, and changes to live activity/control state.
