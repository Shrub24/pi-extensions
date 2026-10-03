# Implementation evidence

Workspace: `../pi-extensions-herdsman-metadata`, jj change `sopuwyrr`, parent `zwqwkkrxorsk` / `1aced15f5b99`. Only this metadata plan was restored from `herdsman@`; background-handoffs was not copied or edited. Parent feature acceptance is still distinct from this baseline.

Dependencies: untracked symlinks to canonical `node_modules` and `pi-herdsman/node_modules`; no lockfile changes.

Baseline: `npm run check` exit 0; `npm test` exit 0, 817 tests / 816 pass / 0 fail / 1 skip. Complete manager-certified command output: `/tmp/kendex-pi-bg/lanes/01a0ff9d-d487-7553-8c69-967c040d82cc/bg-50-1791018560926.log`. This package's `check` runs deterministic tests; it is not a strict TypeScript typecheck. The package build also passes after the initial production slice.

Placement: `startHerdrAgent` resolves `workspace(ctx)`, lists and creates tabs/panes only in that workspace and rejects a split pane from another workspace. `physicalPlacement` always splits a managed delegating worker in its own pane. Existing controller lifecycle tests exercise every placement mode.

Ownership: `actionUnsafe` creates assignments with `ctx.sessionManager.getSessionId()` as `ownerSessionId`; the worker launch serializes that field as `PI_HERDSMAN_OWNER_SESSION_ID`. Root forwarding uses the distinct `PI_SUBAGENT_PARENT_SESSION`; it does not change direct ownership.

Radar coordination: its owner confirmed the lineage names and that generic fields move to Herdsman after pi-herdr retirement. Radar consumes no new keys yet; no Radar source changes are included. A fixture review is pending. Anchor-placement avoidance is a separate follow-up, not part of this publisher change.

Publisher focused tests: 5 pass / 0 fail (formatting, latest-snapshot coalescing, outage retry, TTL refresh, source-local clear and shutdown cancellation).
