# Phase 02 acceptance — settlement provider registration/query

## Outcome

Task 1.2 is accepted for the supervisor-approved staged adapter scope. The public helper, real provider registration/query lifecycle, integration tests and ownership docs are complete. Assignment binding, authoritative per-request outstanding work, result resolution and Herdsman waiting remain in Groups 2–3. This is not acceptance of a usable waiting mechanism.

The provider answers from the existing task map, registers/replaces on session start and disposes on shutdown. Successful restore with an empty map can answer ready for the exact active session; any task keeps the view reconciling, restore failure answers error, and bind is refused. The parent checked the implementation and focused tests against that contract. No new implementation finding was identified. This was parent logic review, not the independent final review required by task 6.2.

## Provenance

- Writer run: `6e8dd8e3-17da-44ad-a418-c725cfe74ba2`; same-session recovery: `c6f223c0-0d82-4025-b1bb-aa2d3a8d8128`.
- Pre-writer checkpoint: `9ef9bb4219f6827fb70f9a9913cb67e691341a13`; timeout checkpoint: `311a724c7712a04a4cef4818568bf5a079c4d12b`.
- Five delivered paths: `pi-bash-processes/extensions/background-tasks.ts`, `tests/fixtures/extension-host.ts`, `tests/background-work-provider.test.ts`, `README.md`, `DEVELOPMENT.md`. The phase-01 helper and tests are unchanged. Parent verified all seven source hashes against the writer report.
- `background-tasks.ts` SHA-256: `36d1e2f44d9058a617fd1b89d80c70a8fb2b67751c2a8c850187e2caba5ee3d1`.
- The timeout partial diff is `/tmp/herdsman-phase02-timeout-6e8dd8e3.patch`, SHA-256 `e78e2bdacb9507a87f313088520d7148b5400ad87aac6a4ba5f987fb5982e510`.

## Verification

| Gate | Result |
| --- | --- |
| Writer focused suite | 36 pass / 0 fail, exit 0; corrected one initially wrong test expectation about attached error snapshots |
| Parent focused suite | `bun test tests/background-work.test.ts tests/background-work-provider.test.ts`: 36 pass / 0 fail, 104 assertions, exit 0 |
| Writer full suite | `bun test ./tests ./extensions/__tests__`: 291 pass / 0 fail, 2000 assertions, 89 files, exit 0; complete retained log hash verified by parent |
| Public helper strict typecheck | Pinned TypeScript 5.9.3, strict/noEmit, ESNext/bundler, Node/Bun types: helper and helper tests clean, exit 0 |
| Integration type non-regression | Pre-writer and delivered trees each have the same 23 pre-existing strict diagnostics, exit 2. Normalized comparison introduces no diagnostic lines, exit 0 |
| OpenSpec | `openspec validate herdsman-background-handoffs --strict`: valid, exit 0 |

There is no pi-bash-processes check script. The strict integration compile is **not clean**: the inherited source/dependency diagnostics remain outside this phase's changes. The baseline comparison used the pre-writer background-tasks and fixture sources, identical dependency resolution and unchanged helper modules; the current check additionally included the new provider test. It normalized source locations and equivalent renderer paths, not diagnostic messages. This establishes no new integration type errors, not package-wide compile success. Final gates must report this limitation rather than claim a green full compile.

No pi-herdsman implementation changed; its earlier 816 pass / 0 fail / 1 skipped baseline was not rerun here. No live smokes, dependency changes or VCS mutations were performed in this phase.

## Durable evidence

Artifact directory:
`/home/saurabhj/.pi/agent/sessions/--home-saurabhj-Projects-dev-custom-pi-extensions--/subagent-artifacts/outputs/6e8dd8e3-17da-44ad-a418-c725cfe74ba2/`

- `herdsman-phase02-provider-result.md`: writer report with exact commands and source hashes.
- `herdsman-phase02-provider-focused.log`: SHA-256 `8468c0d30e8b901d0362098577a1587df7ea269179c0795f359005d1a632da6f`.
- `herdsman-phase02-provider-full-suite.log`: SHA-256 `fc0fa23b75482d5ca04ebdb30f7bae2b7c9288f8c02823e9cc03422ad3c0d5ef`.
- `parent-typecheck.py`, `typecheck-comparison.json`, `baseline-typecheck.log`, `current-typecheck.log`: parent comparison method and raw diagnostics. The script uses a temporary baseline and never modifies workspace sources.

## Next step

Task 2.1: durable assignment binding and restored ownership. Then 2.2–2.3: durable result resolution and delivered-error resolution. Do not enable a Herdsman settlement consumer before those semantics exist. Revision/change notification completeness and initial provider expectations must be verified with the later consumer and wake integration.
