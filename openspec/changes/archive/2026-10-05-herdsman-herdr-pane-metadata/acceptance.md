# Pane metadata verification

Status: package gates and openspec validation pass after review fixes. Re-review of the fixes was not run; the parent verified them by tests. User-owned live smokes remain. No live Herdr smoke or integration into the background-handoffs workspace was performed.

## Source and receipts

- Workspace: `../pi-extensions-herdsman-metadata`, change `sopuwyrruprp`, off `zwqwkkrxorsk` / `1aced15f5b99`. The requested shared parent remains unchanged.
- Code/fixture snapshot for the final package gate and review: `01a2543fac77bfe22788e68068019204084bd54c`.
- Baseline: `npm run check` and `npm test`, exit 0; 817 total, 816 pass, 0 fail, 1 skipped. Certified receipt: `/tmp/kendex-pi-bg/lanes/01a0ff9d-d487-7553-8c69-967c040d82cc/bg-50-1791018560926.log`.
- Final: `npm run build && npm run check`, exit 0; 822 total, 821 pass, 0 fail, 1 skipped. Certified receipt: `/tmp/kendex-pi-bg/lanes/01a0ff9d-d487-7553-8c69-967c040d82cc/bg-96-1791023570306.log`.
- Count change: seven publisher/fixture tests added; two obsolete tests of the retired worker metadata builder removed.
- The build is bundler compilation, not a strict `tsc --noEmit` check. No claim is made about inherited strict TypeScript diagnostics.
- `openspec validate herdsman-herdr-pane-metadata --strict`: exit 0.
- Radar owner accepted the flattened fixture, identity shape, lineage and disjoint Radar-source preservation (intercom `499ff22c-09a0-4c67-b415-2ae0623d4d12`). This is consumer-contract verification, not a live merge check.

Dependencies were initially linked from canonical at root and package level. The unused root link was removed; only ignored `pi-herdsman/node_modules` remains linked. No lockfile changed.

The first review run `f369957b-81a8-40d1-95d5-93b710e20ab6` failed with provider `503 SERVICE_UNAVAILABLE`, `Server is shutting down`, correlation `12b71923-39d6-4179-8c93-059d07e8c875`. The source diff was captured at `/tmp/herdsman-metadata-review-blocker-f369.diff`; the same reviewer resumed as `393b6a44-3c80-44d4-90c8-8482398f79c2`, without a model or protocol switch.

## Scenario map

Paths below are relative to `pi-herdsman/extension/`. These checks establish publication requests and deterministic lifecycle behavior; actual Herdr source merging and extension loading remain user-smoke boundaries.

| Spec scenario | Evidence |
| --- | --- |
| Metadata only | `pane-metadata.test.ts`: wire requests are display-only; owner integration asserts no `report-agent`/`report-session`. |
| Worker publishes once | `agent-runtime.test.ts`: startup/completion metadata; one shared publisher queue in the worker seam. |
| Unknown usage | `pane-metadata.test.ts`: session tokens clear unavailable facts. |
| Oversized or control text | Same test: Unicode bounds and control-text sanitization. |
| Worker token set | `agent-runtime.test.ts`: exact idle/active token keys and absence of legacy bare orchestration keys. |
| Refresh before expiry | `pane-metadata.test.ts`: unchanged metadata refreshes before expiry. |
| Other publishers' names survive | Clear requests name only the publisher's own keys; fixture preserves self/native/Radar facts in its expired-owner projection. Herdr stores one flat map, so this holds only through disjoint names (design risks). |
| Report size | `agent-runtime.test.ts` asserts the worker report is at most 16 keys (12 today); the lead report has 9. |
| Not in Herdr | `extension-contract.test.ts`: managed non-TUI session makes no metadata calls; Herdr/pane gates are explicit in each wiring seam. |
| Publication failure | Publisher coalescing/outage test and existing worker completion-clear failure/retry tests. |
| Contract matches behaviour | Fixture consistency test, exact worker token checks, and Radar's accepted mechanical projection check. |
| Single load | `herdr.test.ts`: the reporter path is passed once, conditionally on installation, including alongside `--no-extensions`. Actual load count: user smoke. |
| Session replaced | Shared full-snapshot session fields; Lead session-name lifecycle test, worker context-switch/teardown tests, publisher rapid-update tests. Live replacement: user smoke. |
| Worker under a lead | Exact worker session/parent token assertions in `agent-runtime.test.ts`. |
| Consumer derives the tree | Fixture consistency test verifies direct pointers; Radar verified parent mapping/preorder. |
| No presentation data | Worker exact token set excludes Radar keys; owner publication asserts no title/display-agent fields. |
| Delegating worker | `controller-lifecycle.test.ts`: parent delegates two same-definition children with exact ownership, including the nested launch environment. Same-workspace placement is enforced in the launch path, as recorded in `implementation.md`. |
| State change | Existing shared list/status projection supplies the owner token; sibling recovery integration compares published token with listed state. |
| Worker is lost | Sibling recovery integration removes live worker evidence and verifies `lost`, 30-second TTL and record-removal clear. |
| Owner crashes | Publisher expiry/refresh constants and source-local shutdown tests; fixture expires the owner key without removing other publishers' keys. Actual crash/expiry: user smoke. |
| Semantic state untouched | Owner integration and request-builder test forbid semantic-state reporting; only `pi_herdsman_state` is emitted by the owner. |
| Non-owned descendant | Owner publication filters exact `ownerSessionId`; nested ownership test establishes the direct owner. No descendant ownership is inferred from visibility. |

Waiting is additive: owner publication forwards the projection string without a second state-name set; the wire/fixture test accepts `waiting`.

## Remaining user boundaries

- Official integration loaded exactly once in live panes.
- Herdsman, Radar and other publishers writing one pane against actual Herdr. The Radar owner's probe on Herdr 0.9.3 already established the flat-map behaviour, that cross-pane writes by explicit pane id work, and the key limits.
- Lead, worker, nested worker, loss and owner-expiry presentation in Radar. Sibling/orphan/cycle ordering belongs to Radar consumer tests, not this publisher.

## Independent review and fixes

Reviewer run `393b6a44-3c80-44d4-90c8-8482398f79c2` (resume of `f369957b`), read-only, static. Output: `~/.pi/agent/sessions/--home-saurabhj-Projects-dev-custom-pi-extensions--/subagent-artifacts/outputs/f369957b-81a8-40d1-95d5-93b710e20ab6/metadata-logic-review.md`. Verdict: request changes, one P1 and two P2. The publisher queue, source/token isolation, TTL/refresh, gating and owner-view freshness were reviewed without findings.

- P1 (parent-verified against source): `--no-extensions` workers would lose the official reporter once the explicit path was removed. Fixed: the path is passed whenever the file exists (`herdrReporterExtensionPath`), covered by the launch-argv test including `--no-extensions` and a presence/absence test. Design D8, the spec requirement and task 5.1 were corrected.
- P2: the worker shutdown clear was not awaited. Fixed: the handler awaits it; new test `agent shutdown resolves only after its metadata clear completes`.
- P2: the spec's role-change clear was broader than the code. Spec and tasks narrowed to the role token.

Post-fix gate: `npm run build && npm run check`, exit 0; 824 total, 823 pass, 0 fail, 1 skipped. `openspec validate --strict` passes. The reviewer's smoke prediction (lead-ready handshake fails when `--no-extensions` workers lack the reporter) is no longer expected.
