# Cutover regressions: progress

Status: uncommitted in the shared pi-extensions working copy. Not accepted as a
whole; the commands file still has one failure in the full-file run.

## Settled

- **bg-132 contradiction.** Re-run whole with the exit code captured directly
  (bg-133): `EXIT=0`, `controller-lifecycle.test.ts` 75 pass / 0 fail / 0
  cancelled, no post-summary failure. The earlier `failed (exit 1)` came from a
  trailing no-match `grep | cut | head` in my own shell line, not from node.

## Decisions to record (ADR pass)

1. **Ruling 1: the cascade revalidation test is deleted; its coverage is
   `control-integration.test.ts` "a generation replaced after the request is
   resolved is refused untouched" (1/1 alone).** That assertion proves the
   parent generation is revalidated under its assignment lock: a generation
   replaced after the close request is resolved is refused without mutation.
   The `agent_close` tool path passes no `expected` snapshot, so this revalidation
   is reachable only from the control-request close (`index.ts` `expected:
   snapshot.state`).
2. **Ruling 2: a cached `unknown` definition is never a resolution.** A negative
   produced by a recurring tick records only that the transcript was not read
   then. `agentDefinitionForRuntime` ignores a cached `unknown`, so an explicit
   call re-resolves; ticks still never open a transcript.
3. **Identity cwd gate (Option A consequence).** `runtimeIdentityMatches`
   compares cwd only when both sides report one. Before this, a canonical live
   row with no cwd threw inside `sameCwd` and was reported as `unknown`.

## Changed in this pass

- `extension/controller-lifecycle.test.ts`: none this pass (cascade test removed
  in the prior pass).
- `extension/observation-refresh.test.ts`: explicit-legacy test rewritten to
  assert the ruled behaviour; FIXME removed. 4/4.
- `extension/index.ts` (hand-edited): cached-`unknown` guard in
  `agentDefinitionForRuntime`; cwd-optional `runtimeIdentityMatches`. Probes
  removed; a scan finds no `DIAG*` marker.
- `extension/support-radar.ts`: `holdNextObserve()` (test-local): holds the next
  `mux.observe` reply until released; cleared by `reset()`.
- `extension/commands.test.ts`: `zero-runtime reconciliation requests one status
  refresh` and `lead status refreshes keep one in-flight refresh and one trailing
  rerun` rewritten onto `holdNextObserve()`; daemon fleet replaces the Herdr exec.

## Validation

| Run | Result |
|---|---|
| `controller-lifecycle.test.ts`, whole, exit captured | 75/75, `EXIT=0` |
| `observation-refresh.test.ts`, whole | 4/4 |
| `zero-runtime reconciliation…`, alone | pass |
| `lead status refreshes keep one in-flight refresh…`, alone | pass |
| `observation-refresh.test.ts`, whole (pass 2) | 4/4, exit 0 |
| `commands.test.ts`, whole (bg-221, exit 1) | 84 tests, 81 pass, 2 fail, 1 cancelled |
| mutation: guard removed in a /tmp copy | explicit-read test red (`definition unknown`, no transcript read) |

Failures in the whole-file commands run (bg-221):

- `active Manager supervision refreshes serialize and coalesce concurrent
  requests`: cancelled at its 60 s timeout. Manager path, outside this slice.
- `Manager delegate persists an exact worktree Lead assignment`: Manager path,
  still reads Herdr directly. Outside this slice.
- `fresh assignment refreshes the widget after validation`: order-dependent,
  passes alone. Outside this slice, not attributed in this pass.

`zero-runtime reconciliation requests one status refresh` and `lead status
refreshes keep one in-flight refresh and one trailing rerun` both pass in the
whole-file run.

## Changed in pass 2

- `extension/commands.test.ts`: the zero-runtime test drops the `herd unavailable`
  label and asserts that the held read changes no render, then reconciles on
  release.
- `extension/observation-refresh.test.ts`: the explicit-listing test's transcript
  body fails on its first read (a test-local `manager.open` wrapper), so the
  session start caches the automatic negative. The test asserts a tick opens no
  transcript, and an explicit listing does open one and resolves `worker`.
- No production file changed in this pass. `index.ts` was not edited by this
  worker; its checksum changed after my backup because the Manager removal worker
  now holds it.

## Mutation evidence

Removing the `cached.agentDefinition !== "unknown"` guard, in a copy of the
package under `/tmp` (not the shared tree), turns the explicit-listing test red:
the explicit listing returns `unknown` and opens nothing. The unmutated copy
passes.

## Open

- `fresh assignment refreshes the widget after validation` remains order-dependent
  and outside this pass.
- The two Manager-path failures and the cancelled one are outside this slice.

## Release

`extension/index.ts` is released to the next worker. The Manager removal may
start.
