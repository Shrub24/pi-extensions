# Session organization (herdsman-session-organization) — groups 1–2

Status: implemented; groups 1–2 complete and checked off; focused verification green
(see "Commands and results"). No commit, no package-wide gate (parent owns it).
Worker session `01a11010-229c-7038-b8cf-d2c2e45d1f3c`, resumed from the earlier
BLOCKED handoff at the same path.

## Files changed

- `pi-herdsman/extension/session-metadata.ts` (new) — versioned classification module.
- `pi-herdsman/extension/session-metadata.test.ts` (new) — module + real SessionManager JSONL tests.
- `pi-herdsman/extension/index.ts` — fresh-launch `--session-dir`, startup/role wiring, reader helpers.
- `pi-herdsman/docs/reference/session-organization.md` (new) + `pi-herdsman/docs/README.md` index entry.
- Focused test updates: `extension-contract.test.ts`, `controller-lifecycle.test.ts`,
  `control-integration.test.ts`, `agent-runtime.test.ts` (see "Expectation updates").

## Module API (for the parent's launch/lifecycle wiring)

`extension/session-metadata.ts` — no imports from `index.ts`, so it can be reused
by any future consumer:

```ts
export const SESSION_METADATA_ENTRY = "pi-herdsman-session-metadata";
export const SESSION_METADATA_VERSION = 1;
export const OPERATOR_ROLES = ["lead", "manager", "chief"] as const;

export type SessionMetadata =
  | { version: 1; sessionId: string; kind: "operator"; role: OperatorRole }
  | { version: 1; sessionId: string; kind: "managed"; role: string;
      parentSessionId: string; definition: string; label: string };

export type SessionMetadataRead =
  | { status: "absent" }
  | { status: "available"; metadata: SessionMetadata }
  | { status: "unavailable"; reason: string };

export type SessionMetadataUpdate =
  | { status: "appended" | "unchanged"; metadata: SessionMetadata }
  | { status: "preserved"; metadata: SessionMetadata }   // managed origin kept
  | { status: "unavailable"; reason: string };

export function readSessionMetadata(entries: readonly unknown[], sessionId: string): SessionMetadataRead;
export function updateSessionMetadata(
  entries: readonly unknown[],
  metadata: SessionMetadata,
  append: (data: SessionMetadata) => void,
): SessionMetadataUpdate;
```

Semantics: strict version-1 payloads (exact field sets, trimmed non-empty text,
UUID-shaped `parentSessionId`, managed `role === definition`); records for another
session are skipped before payload validation; the latest matching record wins and
an unreadable latest record yields `unavailable` (never an earlier fallback);
`updateSessionMetadata` appends only on a meaningful change and refuses to
overwrite a current-session managed classification with an operator one.

`index.ts` coupling is three small call sites:
`persistSessionMetadata(pi, ctx, metadata)`, `recordOperatorSessionMetadata(pi, ctx, role)`
(legacy-identity guard inside) and `recordManagedSessionMetadata(pi, ctx)`, plus a
durable diagnostic under `pi_herdsman_session_metadata_error`.

## Production changes

1. **Fresh managed launch directory** (`prepareManagedWorkerLaunch`): when
   `inputs.resumed` is false the shared launch args gain
   `--session-dir <resolve(target cwd, ".pi/sessions/children")>`. The restart
   path passes `resumed: true`, and every continue/resume path keeps its exact
   `--session <path>`, so nothing is ever rehomed. Storage depends only on the
   target cwd — never on delegation depth or the owner's session directory.
2. **Managed startup** (`session_start`, managed branch): after
   `ensureAgentIdentity`, records kind `managed`, role = effective definition,
   `parentSessionId` = `PI_HERDSMAN_OWNER_SESSION_ID`, definition and label. A
   legitimate owner change appends; the identity entry is untouched.
3. **Operator startup**: the Lead branch records kind `operator` with the
   effective role (`roleSuspended ? persistedRole : activeRole()`), skipped when
   the persisted role entry was unreadable.
4. **Operator role transitions**: `persistRole(role)` also records metadata, so
   Lead/Manager/Chief changes append through the existing single write seam.

## Expectation updates (behavior-required, not re-baselining)

- `controller-lifecycle.test.ts` "parent delegation lock…": `parentPi.entries.length === 0`
  → the only entry is now the classification record (identity is still reused, no state error).
- `agent-runtime.test.ts` "agent persists one identity entry…" and "a forked session
  establishes identity…": expected entry lists now include the classification record
  appended after the identity entry (rename to mention classification).
- `control-integration.test.ts` restart test and `controller-lifecycle.test.ts`
  continuation test: added assertions that the exact `--session` path is used and
  `--session-dir` is absent.

## Commands and results

Environment: `pi-herdsman` (node v24.21.0). No package-wide gate run (parent owns it).

| Command (in `pi-herdsman/`) | Result |
| --- | --- |
| `node --experimental-test-module-mocks --import=./scripts/test-env.mjs --test --test-timeout=10000 extension/session-metadata.test.ts` (red, before the module existed) | FAIL — `ERR_MODULE_NOT_FOUND .../extension/session-metadata.ts` (expected red) |
| same, after implementing the module | PASS 6/6 |
| same, after adding the doc-example test | PASS 7/7 |
| `node ... --test-timeout=20000 extension/extension-contract.test.ts` | PASS 48/48 (includes the six new metadata lifecycle tests) |
| `node ... --test-timeout=20000 extension/controller-lifecycle.test.ts` | PASS 66/66 (fresh/nested/owner-cwd `--session-dir`, local exact-path continue, no `--session-dir` on continue, fabricated-metadata refusal) |
| `node ... --test-timeout=20000 extension/control-integration.test.ts` | PASS 8/8 (owner-control restart keeps the exact `--session` path and adds no `--session-dir`) |
| `node ... --test-timeout=30000 extension/agent-runtime.test.ts extension/commands.test.ts extension/controller-api.test.ts extension/supervision.test.ts extension/recovery.test.ts extension/agent-cutover.test.ts extension/idle-wake.test.ts` | PASS 421/421 (includes the two updated managed-startup entry-list expectations) |
| `openspec validate herdsman-session-organization --strict` (repo root) | PASS — "Change 'herdsman-session-organization' is valid" |

Red/green for the module: the first run failed on the missing module; the
operator/managed round trip, foreign-record, malformed/unsupported-version,
idempotence/managed-origin, doc-example and real-SessionManager tests all pass now.

Real persistence proof (`session-metadata.test.ts`): a real `SessionManager.create`
writes the identity entry, classification records and a user message, then
`SessionManager.open` reads them back from disk. Asserts session-scoped reads,
two persisted records after a repeated start plus an owner change, the exact
persisted key set (no pane/process/path/transcript keys), an unchanged
three-key `pi-herdsman-agent-definition` entry, and a fork whose copied
foreign record classifies nothing until it writes its own.

Lifecycle proof (`extension-contract.test.ts`): operator startup records role
`lead`; a repeated start appends nothing; a restored Chief role records `chief`
with kind still `operator`; a managed file opened as an operator keeps its
managed origin; a legacy identity without metadata stays unclassified; an
unreadable current record produces exactly one `pi_herdsman_session_metadata_error`
and no classification while the session keeps its tools; managed startup records
the direct owner and appends on owner change.

## Deviations and notes

- `--test-name-pattern` filtering cannot be used with these files (a pre-existing
  harness quirk: the filtered run fails on a missing temp `agents` directory), so
  each file is run whole.
- The restart assertion is in `control-integration.test.ts` because
  `controlWorkerFixture` is local to that file.
- Role changes are exercised through the single `persistRole` seam and the
  restored-Chief startup path rather than a Manager/Chief command flow, which
  needs pane/tab/socket scaffolding and manager leases.

## Not run (explicitly)

- `npm run check` / `npm run validate` / `openspec validate --all --strict` — parent runs the package gate.
- Any live/Herdesman-pane smoke or Nix/dotfiles deployment work (group 3–4).
- Historical migration and registry/picker work (out of scope).

## Follow-ups

- Manager-mode suspension currently records the persisted role rather than a
  suspended marker; revisit if consumers need a suspension signal.
- A registry/index could cache these reads later; the scan stays discovery-only.

## Coordination

- `openspec/changes/herdsman-session-organization/tasks.md` groups 1–2 checked off
  (3.x = dotfiles owner, 4.x = parent gate/activation).
- Only these paths changed: `pi-herdsman/extension/session-metadata.ts`,
  `.../session-metadata.test.ts`, `.../index.ts`, `.../docs/README.md`,
  `.../docs/reference/session-organization.md`, the four focused test files, this
  artifact and the change's tasks.md. `pi-reqcap/*` modifications are the peer's,
  untouched here. No commit.

## Decisions to record (keep-the-why, owner lands)

1. A separate versioned custom entry rather than extending
   `pi-herdsman-agent-definition` (its reader requires exactly three keys and it
   answers admission identity); metadata is discovery-only and never grants
   continuation. Revisit if a registry makes identity+classification one record.
2. `--session-dir` only on fresh managed launches (gated on `resumed`), never on
   resume/restart/recovery, so saved paths are never rehomed. Revisit only with an
   explicit migration change.
3. Records are append-only with the latest current-session record authoritative;
   a fork's copied foreign records are ignored before validation, and an
   unreadable latest record is diagnosed rather than replaced or guessed.

## Last verification (post-artifact tweak)

`session-metadata.test.ts` re-run after the doc edits and the constant-consumer
change: PASS 7/7. `tasks.md` checkbox edits validated by
`openspec validate herdsman-session-organization --strict` → valid.
