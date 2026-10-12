# Family A: the RadarResult narrowing cause

Status: cause reproduced and written before any edit. The edits that follow this
report are recorded at the end.

## The symptom

About 60 of the working tree's 73 `RadarResult`-related type errors. Two shapes:

- `Property 'code' / 'message' does not exist on type 'RadarResult<unknown>'`, at
  sites that read the failure fields after `if (!x.ok)`.
- `Type 'RadarResult<unknown>' is not assignable to type 'RadarResult<X>'`, at
  typed wrapper methods (`register`, `acquire`, `publish`, `observe`, the `spawn.*`
  and `registry.*` methods) whose body returns the result of a generic helper.

## The cause

**Truthiness narrowing on the `ok` discriminant does not narrow under the
repository's compiler flags.** `RadarResult<T>` is a discriminated union on a
boolean literal, `{ ok: true; value: T } | { ok: false; code; message }`. Without
`strictNullChecks`, `if (!r.ok)` and `if (r.ok)` leave `r` as the whole union.
The explicit comparisons `r.ok === false` and `r.ok === true` narrow correctly
under the same flags.

The flags are the ones every measurement in this slice uses (no `--strict`, no
tsconfig; the package gate never type-checks). With `--strict` the family
shrinks, which is the evidence that the cause is the flag set and not the union:
the `RadarResult` union has 73 related errors under the repository flags and 3
under `--strict`.

This is neither a wrong generic bound nor a spread that widens the union. The
union, the generic bounds and the spreads are all sound. The only fault is the
narrowing form.

## The mechanism, verified

Probes in `/tmp/mgr-rm/narrow` under the repository's exact compiler flags:

1. `probe.ts`: `if (!ready.ok) return ready;` in a function declared to return
   `RadarResult<string>`, with `ready: RadarResult<{n: number}>`, reports
   `Type 'R<{ n: number; }>' is not assignable to type 'R<string>'`. The
   narrowing failed, so the whole union was returned.
2. `probe2.ts`: `if (x.ok === false) return x.code` narrows; `if (!r.ok) return
   r.message` does not. The explicit form works, the truthiness form does not.
3. `probe4.ts`: the chain that produces the wrapper errors. A generic wrapper
   `wrap<T>(operation: () => Promise<R<T>>): Promise<R<T>>` is called with a
   callback that returns the un-narrowed failure (`if (!answer.ok) return answer;`)
   and a success literal. The generic infers `T` from the union of the callback's
   returns, and the failure arm carries `R<unknown>`, so `T` becomes `unknown`.
   The wrapper then returns `R<unknown>`, which is not assignable to `R<{agent_id}>`.
   The explicit form (`answer.ok === false`) narrows the failure arm to a `T`-free
   object, `T` is inferred from the success literal, and the error goes.

So there is one root cause. Most of the family is its downstream effect:

- The `.code`/`.message` reads (the 'does not exist on type' group) are the direct
  effect: the narrowing did not happen.
- The typed-wrapper mismatches (`register` at 1116, and the `acquire`, `publish`,
  `spawnCreate`, `observe` and related sites) are the generic-inference effect: the
  un-narrowed failure arm makes `T` `unknown`.

The earlier failed attempt (copying the failure arm into a fresh
`{ ok: false, code, message }` literal) did not work because the narrowing was
still the truthiness form. The literal still reached the same `!ready.ok` branch
and was never narrowed, so the literal was not the fix.

## Why the wrapper's success type is not the problem

Under `--strict` the `register` wrapper at 1116 is not an error. Its success
literal is `{ ok: true, value: { agent_id } }`, which matches. The mismatch exists
only because the failure arm, through the un-narrowed return, drags `unknown` into
`T`.

## The fix, and what it changes at runtime

Replace each truthiness check on a `RadarResult` with the explicit comparison:

- `if (!x.ok) return x;` becomes `if (x.ok === false) return x;`
- `if (!x.ok) ...` becomes `if (x.ok === false) ...`
- `if (x.ok) ...` becomes `if (x.ok === true) ...`
- `!x.ok && rest` becomes `x.ok === false && rest`

Runtime behaviour: identical whenever `ok` is a boolean. Every `RadarResult` in
this code is constructed with a literal `ok: true` or `ok: false`, either in
`radar-client.ts` itself or in the wrapper that returns it. So `!x.ok` and
`x.ok === false` select the same branch for every value we produce. The
evidence is the suite counts, which must be identical before and after.

The one residual risk: a `RadarResult` value that arrives without an `ok` field
(for example `undefined` from a path that does not construct one). Under the
repository's flags the type checker would not flag such a value, because it does
not check truthiness narrowing at all. I found no such path by reading the
construction sites, but the reading covers the constructions, not every runtime
source. Noted, not tested.

## Alternatives rejected

- **Add `--strictNullChecks` to our ad-hoc compiler command, or add a tsconfig.**
  This would close the family without touching the code, but it changes the gate,
  which is an owner decision (the gate has never type-checked). It would also
  surface unrelated strict errors in the same run (763 under `--strict` in total).
  Not done here. The owner should decide whether the gate should run a strict
  check; the report recommends it.
- **Cast the wrapper results (`as RadarResult<X>`).** Rejected: it hides the
  problem and the owner has ruled against casts on this slice.
- **Change `call()`'s signature to a typed generic.** Rejected: `call()` returns the
  decoded envelope and its `unknown` is the honest type of an untyped reply. The
  narrowing is the defect, not `call()`.

## Is the union itself the defect? No

`RadarResult<T>` is declared with literal discriminants (`radar-client.ts` 99–101):
`{ ok: true; value: T } | { ok: false; code: RadarErrorCode; message: string }`. The arms are
`true` and `false`, not a plain `boolean`. So the union is well formed and the
explicit comparison is the complete fix. Reshaping the union would not change the result.

## Caveat: every count in this slice is non-strict

The ad-hoc gate runs with no tsconfig and therefore without `strictNullChecks`. Every
number in this slice is a non-strict count: 748 before this pass, 674 after, and HEAD's
822. A real build with strict checks would change both the totals and possibly this class
of error. This narrowing class exists only because of the non-strict flag set. It is one
input to the `tsc`-in-validate decision, not a reason to change the fix.

## Result of the fix

The explicit comparisons were applied to every `RadarResult` read in the four radar
source files (`radar-client.ts`, `radar-location.ts`, `radar-publication.ts`,
`radar-launch.ts`), the three flagged `index.ts` reads, and the twelve flagged
`radar-client.test.ts` ternaries. The one non-mechanical edit was a return-type annotation
on the `spawn.close` callback at `radar-client.ts` 1295. Its inferred `T` came from the first
success arm (`outcome: "completed"`), so the `already_exited` arm failed to fit. The
annotation `Promise<RadarResult<RadarCloseOutcome>>` gives the generic the declared type.

No runtime value changes: each `RadarResult` is built with a literal `ok`, so `!x.ok` and
`x.ok === false` select the same branch for every value the code produces. The suite
counts are the evidence, and they are in the measurement section below.

## Not closed, and why

- `radar-execution.test.ts` 51 and `radar-publication.test.ts` 68 (TS2739): the typed fake
  client is missing members. This is a fixture completeness gap, not narrowing. It is named,
  not fixed, because adding stubs to those fakes is a test-fixture change outside this
  brief's narrowing scope.
- Not family A, left alone: the `RadarLaunchOutcome` vs `BoundChild` errors (`radar-launch.ts`
  429–492), the `ResolvedAssignmentSession` site, and the `index.ts` skill/launch-plan/started
  checks, which are not `RadarResult` values.
- `radar-client.ts` 1140, 1157 and 1176 (TS2719, `RadarChannel` name collision) cleared as a
  side effect of the wrapper typing. I did not verify that mechanism separately.

## The three control-socket leaks

`commands.test.ts` lines 1222, 3859 and 4290 each `delete RADAR_CONTROL_SOCKET` in
cleanup. Changed to `await ensureRadarDaemon()`, the same owned restore the two
earlier leak fixes use. Test-only; no production change.

## Notes for the Herdr removal slice (recorded, not acted on)

- `herdr:pi` target shape. The literal is neither ours nor a daemon contract value.
  It originates in the Herdr backend (Radar `src/herdr.rs` `session_identity`,
  which copies the `source` of Herdr's own `agent_session` record into
  `SessionIdentity::Reported`). The gate on a reported path reference in
  `observedPiSessionId` should depend on the session association's **kind** (a
  reported path, as opposed to a daemon-observed identity) and on the agent being
  Pi, and never on a backend's name. Not renamed in this pass.
- `focusProvedLocation`'s "Radar could not confirm" branch is kept. The supervision
  load and the focus re-proof are taken at different times, so a disagreement is
  reachable, and refusing on disagreement is the fail-closed behaviour.

## Measurement: identical counts before and after

Suite counts came from one background run per file, with `--test-concurrency=1
--test-timeout=60000` and the flags before the filename. Exit codes were taken from the
run's own summary, per file.

| Suite | Before (tests/pass/fail/cancelled) | After | Exit (before / after) |
| --- | --- | --- | --- |
| commands | 78 / 78 / 0 / 0 | 78 / 78 / 0 / 0 | 0 / 0 |
| controller-api | 66 / 47 / 18 / 1 | 66 / 47 / 18 / 1 | 1 / 1 |
| supervision | 49 / 49 / 0 / 0 | 49 / 49 / 0 / 0 | 0 / 0 |
| control-integration | 7 / 7 / 0 / 0 | 7 / 7 / 0 / 0 | 0 / 0 |
| presentation | 68 / 68 / 0 / 0 | 68 / 68 / 0 / 0 | 0 / 0 |
| extension-contract | 47 / 43 / 4 / 0 | 47 / 43 / 4 / 0 | 1 / 1 |
| session-metadata | 8 / 8 / 0 / 0 | 8 / 8 / 0 / 0 | 0 / 0 |
| radar-client.test.ts | not measured before | 31 / 31 / 0 / 0 | n/a / 0 |

Every count is identical. The failing names are identical too, for `controller-api`
(20 lines) and `extension-contract` (5 lines), and `commands` has none. No file's count moved, so
nothing needs attributing to family A.

The pre-edit baseline's `extension-contract` 43/47 is not a change from this pass. Four
stale-refresh tests fail before and after, because they force the refresh to fail with an
absent Herdr socket, which the refresh no longer reads. That is the earlier supervision
slice, not family A. The file is outside this brief's scope.

`radar-client.test.ts` has no pre-edit run, so its 31 passing is a post-edit fact only. Its
edits are type-only ternary rewrites.

## Type count, same command

| Point | Errors | RadarResult-related |
| --- | --- | --- |
| Before this pass | 748 | 73 |
| After this pass | 674 | 2 |
| Delta | -74 (74 removed, 0 added) | -71 |

The 74 removed errors are all family A or its direct consequence. The count is the
same after the final `commands.test.ts` cleanup edit, so the figure is stable.

The remaining two RadarResult errors are fixture mocks in `radar-execution.test.ts` (51)
and `radar-publication.test.ts` (68). They are missing members on the typed fake client,
not narrowing.

## Answer: the arms carry literal discriminants

`RadarResult<T>` (`radar-client.ts` 99–101) declares its arms with literal `ok: true` and
`ok: false`, not `boolean`. So the union is well formed. The underlying defect is the
narrowing form, not the union's shape.

## Non-strict caveat

The ad-hoc gate runs without a tsconfig and so without `strictNullChecks`. Every count in
this report is a non-strict count, including HEAD's 822. A strict build would change the
totals and possibly this error class: under `--strict`, this tree's RadarResult-related
errors were 3 rather than 73. So this narrowing class exists only because the gate is
non-strict. That is one input to the `tsc`-in-validate decision, not a reason to change the
fix. The owner should decide whether validate runs a strict check.
