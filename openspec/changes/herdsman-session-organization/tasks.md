# Tasks

## 1. Durable metadata module

- [x] 1.1 Add the version-1 `pi-herdsman-session-metadata` reader and idempotent append helper; verify operator/managed shapes, latest-record selection, role/owner updates, and malformed/unsupported current-record diagnostics with focused red/green tests.
- [x] 1.2 Prove session-ID isolation and JSONL persistence with real Pi SessionManager fixtures (include a message so the file is flushed); verify foreign copied records are ignored, repeated startup adds no duplicate, and the old agent-definition entry remains unchanged.
- [x] 1.3 Document entry fields, origin versus role, direct-owner semantics, chronological updates, and unavailable legacy metadata in a new `docs/reference/session-organization.md`; verify example JSON against the reader and add its docs index entry.

## 2. Launch and lifecycle integration

- [x] 2.1 After the peer explicitly releases `extension/index.ts`, add the fresh-launch child-directory override at the shared launch seam; verify fresh, nested, cross-cwd, and inherited-override cases through production launch tests, with no `children/children` path.
- [x] 2.2 Wire metadata into managed startup and operator startup/role restoration/transitions without adding a replacement lifecycle handler; verify definition/direct-owner records, role updates, fork isolation, and meaningful-update idempotence through the real extension test host.
- [x] 2.3 Preserve managed origin on manual resume, leave unknown legacy parentage unclassified, and surface metadata diagnostics without terminating the live session; verify these cases in lifecycle tests and document their reader behavior.
- [x] 2.4 Pin legacy and local saved paths through continuation, retained reuse, lost-session recovery, and owner-control restart; verify exact `--session` arguments and unchanged identity/control safeguards in focused integration tests.
- [x] 2.5 Verify fabricated metadata cannot grant continuation rights using an unowned-session regression; update the reference page with exact-path recovery, cwd/subdirectory semantics, picker behavior, backup limits, and deferred global discovery.

## 3. Operator deployment (dotfiles owner; outside this repository)

- [ ] 3.1 Have the dotfiles owner finalize native `sessionDir = ".pi/sessions"` in `modules/agents/pi.nix`; verify the rendered setting and run `nix flake check --no-build --no-write-lock-file`. Keep activation held until group 4 is ready.
- [ ] 3.2 Have the dotfiles owner finalize the narrow global ignore in `modules/dev-tools/cli.nix`; verify root and nested `.pi/sessions/` files are ignored while settings/skills are not, and commit only its two owned configuration hunks when authorized.

## 4. Integration and deployment verification

- [x] 4.1 On the integrated tree, run parent-focused lifecycle/control/metadata tests, `npm run validate`, and `openspec validate --all --strict`; record actual exits and counts, with no source edits during the full gate.
- [ ] 4.2 With explicit operator approval, activate the deployment and verify a fresh operator session and managed worker are stored in the two local directories with correct on-disk metadata; verify the native operator picker excludes child files. Record any live-smoke limitation instead of marking it complete.

## Coordination notes

- Registry, custom picker, external consumer adapters, and historical relocation/backfill are deferred; none is an acceptance dependency here.
- The metadata worker was paused before any production/test edit. Retain its session `01a11010-229c-7038-b8cf-d2c2e45d1f3c` for apply rather than starting a new worker.
- The recovery peer owns `extension/index.ts` until explicit release. Do not edit or restore it, even briefly.
- Dotfiles settings/ignore edits are staged and its no-build flake check passed, but this checklist does not claim them complete: rendered setting and nested ignore behavior still require verification, and no activation occurred.
