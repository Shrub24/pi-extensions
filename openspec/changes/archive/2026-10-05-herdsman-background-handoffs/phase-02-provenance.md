# Task 1.1 provenance classification

The initial classification below was computed with `jj diff` against the canonical repo on 2026-10-02 before any integration. The later sections record the owner-approved rebase, baseline and test-isolation correction; task 1.1 is now complete.

## Identities

| Role | jj change | commit |
| --- | --- | --- |
| Shared base (herdsman import point, `pi-herdsman` fork at 156b1c66) | `xormplzlxysq` | `8c320862bd2b` |
| Accepted declared-lifecycle snapshot | `mqzsqmrowvuq` | `c6c37e3d0bc6de387dcdb0b2b1516e3be73469e8` |
| Newer canonical work (root codemode intent) | `xlxszuzzrpto` | `89640957266f` |
| Herdsman workspace head | `zltswkvvzqxu` | `d7b5a9e7c18419471d6de325cfa31f9c4a473154` |

`mqzsqmro` and the herdsman chain are siblings on `xormplzlxysq`.

`c6c37e3d` is identical to the verified lifecycle snapshot `4d3fe9d3a316` for `pi-bash-processes`, `pi-tool-renderer` and `pi-output-policy` (`jj diff --from 4d3fe9d3a316 --to mqzsqmro` = 0 files). It is the accepted prerequisite recorded in `openspec/changes/declared-background-task-lifecycle/review.md`.

## Classification of the 54 differing paths (herdsman vs canonical `@`, `pi-bash-processes`)

- **Accepted lifecycle, take (51 paths).** Base to `mqzsqmro`: 17 `extensions/`, 30 `tests/`, `README.md`, `CHANGELOG.md`, `DEVELOPMENT.md`, `instructions.md`. Includes the 3 deletions `extensions/read-shim.ts`, `extensions/sleep-intercept.ts`, `tests/sleep-intercept.test.ts`. Herdsman never touched any of them.
- **Newer canonical work, exclude (3 pbp paths).** `mqzsqmro` to `xlxszuzz`: `README.md`, `extensions/background-tasks.ts` (7 lines), `tests/codemode-bash-intent.test.ts` (new vs base, not in the 51). This is codemode intent, not part of the accepted lifecycle. It also needs the `pi-tool-renderer` changes in the same commit.
- **Herdsman-owned, keep (2 paths, shown as canonical-side deletions).** `extensions/background-work.ts` and `tests/background-work.test.ts` (phase-01 interface). Only imports `node:crypto`; no dependency on any lifecycle file.

Count check: 52 canonical-changed paths (the 51 lifecycle paths plus `tests/codemode-bash-intent.test.ts`, which differs from base only in `xlxszuzz`) plus the 2 herdsman-only files = 54. `README.md` and `background-tasks.ts` are in both the lifecycle set and the codemode set.

## Key source hashes (sha256)

- `background-tasks.ts` @ `c6c37e3d` = `4ac91f088b4f25399c795bcdd861955402d08d00ee696cedfe292fd48b6ad19b`
- `background-tasks.ts` @ `89640957` (not wanted) = `890198fda155caf68640883f1f240a57249a5325aa55c7784b296ce85acbed12`
- `types.ts` @ `c6c37e3d` = `e30f5500fcf926878b50b9feff2b37afefde355749861009085e3183c3b405ab`
- `task-result.ts` @ `c6c37e3d` = `0e4c3ecd6e7ac96df0721b2223ab1d1937f1f85b9995d75d2197d123e0f3f654`

## Conflict assessment

Herdsman's diff from base touches only `pi-herdsman/`, `herdsman-*` openspec dirs and the 2 `background-work` files. `mqzsqmro` touches only `pi-bash-processes/`, `pi-tool-renderer/` and 2 `openspec/changes` paths of the lifecycle change. The path sets are disjoint, so rebasing the herdsman chain onto `mqzsqmro` is conflict-free and carries the 6 `pi-tool-renderer` files the accepted suites were run against.

## Initial integration proposal (subsequently approved and executed)

In the herdsman workspace: `jj rebase -s nxuuuxwvvlnm -d mqzsqmro`, then verify the three hashes above, run `npm test` and `npm run check` in `pi-bash-processes` and `pi-herdsman`, and record the baseline. Task 1.1 stays open until that runs.

## Integration and baseline — executed

`jj rebase -s nxuuuxwvvlnm -d mqzsqmro` in the herdsman workspace: 3 commits rebased, no conflicts. Herdsman head is now `zltswkvvzqxu` / `a8e44fb87a30`, on `dc5cfb440f64` and `c4c393e0efb7`, on `c6c37e3d0bc6`. The sha256 of `background-tasks.ts`, `types.ts` and `task-result.ts` match the accepted `c6c37e3d` values above. `background-work.ts` and its test are retained.

### Environment fix (untracked)

`pi-bash-processes/node_modules/@earendil-works/pi-coding-agent` in this workspace resolved to Pi 0.87.0 (the package declares Pi only as a `*` peer), which failed 7 tests that need the 0.99 `bash` outputSchema. The symlink was re-pointed to the 0.99.2 entry already in `node_modules/.bun`, matching canonical's 0.99.2 install. No tracked file, lockfile or source changed.

### Results

| Package | Command | Result |
| --- | --- | --- |
| `pi-herdsman` | `npm run check`, `npm test` | 817 tests, 816 pass, 0 fail, 1 skipped |
| `pi-bash-processes` | `bun test ./tests ./extensions/__tests__` | 282 tests, 280 pass, 2 fail |

### The 2 pi-bash-processes failures — pre-existing, order-dependent

Failing: both tests in `tests/task-details.test.ts`. They pass alone (2/2, twice). `renderTaskDetails` reads the module-global `liveSnapshots` (`extensions/snapshot.ts`) by task id, the test uses id `bg-1`, and `tests/codemode-bash.test.ts` leaves a real `bg-1` there (`sleep 0.4; echo late`, stopped by session-shutdown). Running just `codemode-bash.test.ts` then `task-details.test.ts` fails the same way in the canonical checkout (`/home/saurabhj/Projects/dev/custom/pi-extensions`, 6 pass / 2 fail). At this gate both files were identical to the accepted `c6c37e3d` tree, so this was not a rebase or herdsman regression. The canonical full suite (258 pass / 0 fail) did not expose the order-dependent collision. The subsequent owner-approved correction and green rerun are recorded below.

### Resolution

`tests/task-details.test.ts` fixture id changed from `bg-1` to `bg-details-fixture` (id and log path only; no assertion changed), so it no longer collides with the task `codemode-bash.test.ts` leaves in `liveSnapshots`. Full `pi-bash-processes` suite after the change: 282 pass / 0 fail. This is the one deliberate divergence from the accepted `c6c37e3d` tree; canonical still carries the latent collision and should take the same one-line fixture change.
