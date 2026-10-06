# Idle transcript-reread loop: caller chain and cadence

Read-only trace of pi-herdsman. No production edits, no shared-file changes, no
live mailbox/transcript writes. All probes ran in isolated `/tmp` copies or as
read-only `/proc` observation.

Scope owned here: **recurrence + `isLeadSessionBoundary` caller behaviour**.
Persisted identity semantics and the mailbox inventory audit are the parent's.

## Verdict

A normal **lead** process with persisted mailbox state re-reads **one whole
session transcript twice every 2 s** while idle. It is not the
`stateAgentDefinition` fallback (all live states already carry
`agentDefinition`) and not `readPersistedSessionEntries`.

Verified recurring chain (single non-test caller of `isLeadSessionBoundary`):

```
statusTimer  setInterval(..., 2000)            index.ts:15639
  -> refreshStatus(ctx, generation)            index.ts:12703   (2 s)
    -> loadStatusSnapshot(ctx, signal)         index.ts:12570
      -> agentSnapshotView(..., proveLead=true)index.ts:12574 / 3701
        -> managedAgentSnapshots(..., proveLead=true)
                                               index.ts:3155-3168
          -> isLeadSessionBoundary(ownerAgent, ownerPanes[0], ownerSessionId)
                                               index.ts:3161
            -> SessionManager.open(session.value)   index.ts:2289  (full read #1)
            -> SessionManager.open(session.value)   index.ts:2291  (full read #2)
```

`SessionManager.open(existingPath)` is a **full-file read + parse + index**, so
one `isLeadSessionBoundary` call costs two transcript reads. Confirmed for both
runtimes in use (see Evidence A/B).

The read is **workspace-scoped and condition-gated**, not unconditional:
`isLeadSessionBoundary` only runs when a mailbox owner in `currentWorkspaceId`
has exactly one live `herdr:pi` agent whose `agent_session.kind === "path"`.
That condition holds for the live leads, so it fires every tick.

## Runtime evidence (measured)

### A. `SessionManager.open` = 1.00x full file read

Isolated copy of the live transcript, opened with the repo's pinned
`@earendil-works/pi-coding-agent@0.99.2`; bytes counted from `/proc/self/io`
`rchar`:

```
$ node /tmp/probe-open.mjs ~/.pi/agent/sessions/--home-saurabhj-Projects-dev-custom-pi-extensions--/2026-10-05T23-38-09-157Z_01a10e6e-...jsonl
transcript bytes on disk: 37981559
open#1: syscall-rchar=37985763, ratio=1.00x, ms=224.5, entries=9480
open#2: syscall-rchar=37985763, ratio=1.00x, ms=245.9, entries=9480
open#3: syscall-rchar=37985764, ratio=1.00x, ms=231.1, entries=9480
```

~38 MB and ~230 ms per open; two opens per tick = ~76 MB + ~0.46 s CPU per lead.
The 1.00x ratio is not a header scan: `loadEntriesFromFile` streams the whole file
(`session-manager.js:325`), reached from the `SessionManager` constructor
(`_setSessionFile`, `:668`) that `static open` always builds (`:1326`). The
bounded `readSessionHeader` pre-scan at `:1332` only covers the scan-limit
fallback. The same code is embedded in the running `pi-1.0.2` binary
(`loadEntriesFromFile` / `preloadedFileEntries` / `SessionHeaderScanLimitError`
present; `_setSessionFile` body identical).

### B. Isolated host trace: exactly 2 opens per status tick, from the boundary

Instrumented mock `SessionManager.open` in a `/tmp` copy of the extension
(`extension/support.ts`), lead scenario with a mailbox owned by the lead and a
live path agent for that owner; captured the 2 s timer callback and drove it:

```
$ node --experimental-test-module-mocks --import=./scripts/test-env.mjs \
    --test --test-timeout=20000 extension/probe.test.ts
PROBE opens after boot: 7
PROBE opens after tick1: 9 delta: 2
PROBE opens after tick2: 11 delta: 2
PROBE tick2 stack: ... at isLeadSessionBoundary (index.ts:2289:24)
                   <- managedAgentSnapshots (index.ts:3161:13)
                   <- agentSnapshotView (index.ts:3708:20)
                   <- loadStatusSnapshot (index.ts:12574:20)
PROBE tick2 stack: ... at isLeadSessionBoundary (index.ts:2291:36)  [same ancestors]
```

Both opens per tick, both from `isLeadSessionBoundary` (the two calls at
2289/2291). Boot opens (7) are one-time startup; no other caller opens on a tick.

### C. Live process sees the predicted cadence

Live lead process on workspace `wQ` (owner session `01a10e6e…`, pane `wQ:pC`):

```
$ tr '\0' ' ' < /proc/594602/cmdline
/nix/store/...-pi-1.0.2/libexec/pi/pi --session 01a10e6e-8f85-70a2-ad2f-afaff03ff4c4
$ tr '\0' '\n' < /proc/594602/environ | grep HERDR_WORKSPACE_ID
HERDR_WORKSPACE_ID=wQ
$ grep rchar /proc/594602/io   # sampled 6 s apart
delta = 243790339 bytes / 6 s ~= 38 MB/s
```

Its own transcript is 37,981,559 B, header `id = 01a10e6e…`. 38 MB/s ≈ 2 reads
(76 MB) per 2 s tick with small mailbox/other overhead. A 200 ms-sampled `rchar`
sawtooth shows ~38–80 MB bursts roughly every 2 s.

Why it fires: live `herdr agent list` shows `wQ:pC` has
`agent_session.kind="path"` with `value=<the 01a10e6e transcript>`, and the
workspace-`wQ` mailboxes (`51adc5a7…`, `c35486d3…`) both have
`ownerSessionId=01a10e6e…`. Exactly one live agent matches that owner and one
pane is in `wQ`, so `isLeadSessionBoundary` opens the lead's own transcript
twice per tick. Same owner/path shape holds for the `wG` lead (`01a100d9…`,
pane `wG:p1Z`).

## Answers to the investigation questions

**Q1 — Which recurring caller reaches transcript reads on an ordinary idle lead?**
The 2 s status refresh, via `managedAgentSnapshots(proveLead=true)` →
`isLeadSessionBoundary`, which opens the matching owner's path session twice.
`stateAgentDefinition` / `readPersistedSessionEntries` are **not** on this path
(verified: every live state carries `agentDefinition`; the definition readers are
reached only from explicit transcript/list tooling — source inference, §Non-burn
callers).

**Q2 — Does every tick resolve all-workspace agent definitions?**
No. `managedAgentSnapshots` builds `allMailboxes = listAgentStates()` but the
status path calls it with `allWorkspaces=false`, so `mailboxes` is filtered to
`state.workspaceId === currentWorkspaceId` (`index.ts:3009-3015`) before any
definition resolution or `proveLead` loop. The probe added a foreign-workspace
mailbox with **no** `agentDefinition` and a live path owner: the tick delta stayed
2, i.e. it was neither definition-resolved nor boundary-opened. (All-workspace
inventory *files* are still stat'd/read by `listAgentStates`, but state files are
KB-scale — not the burn.)

**Q3 — Does concurrent/coalesced refresh amplify the pass?**
Boundedly. `refreshStatus` coalesces (`index.ts:12709`, `12745-12748`): a tick
during an in-flight refresh only sets `statusRefresh`, which yields **one** trailing
re-run. So ticks cannot queue unboundedly — but if one refresh exceeds 2 s
(2×~230 ms parses + full JSON parse + `herdr` snapshot subprocess), every tick
arms the trailing re-run and refreshes run back-to-back with no idle gap,
turning the 2 s cadence into a continuous ~38 MB/s burn. Independent triggers also
call `requestStatusRefresh` (herdr lifecycle watcher `:15607`, state transitions,
herd-run finish), each adding a coalesced re-run. `refreshLeafStatus` has an
`leafStatusInFlight` guard but *drops* ticks rather than queueing
(`index.ts:16600-16613`).

## Bounding assessment (not implemented)

Semantics that bound the fix:

- `sessionAgentIdentity` scans **all** matching definition entries and throws on
  later conflicts; `retiredManagedSession` pairs it with `sessionContextRetired`.
  A "first header only" or first-entry-only shortcut is **not equivalent** and
  would silently accept a session that must be rejected.
- `isLeadSessionBoundary` has exactly one non-test caller, and `leadSessionIds`
  feeds only `statusBreadcrumb` ("herd" vs "?"). Supervision (chief/manager)
  refresh calls `managedAgentSnapshots(..., proveLead=false, allWorkspaces=true)`
  (`index.ts:11962`), so it does not depend on this branch.

Options, in decreasing confidence:

1. **Cache the boundary/identity result keyed by (path, mtimeMs, size)** for the
   duration the file is unchanged. While idle the transcript is not appended, so
   the cache hits and the burn disappears with no semantic change; any append
   (new turn) invalidates and preserves conflict/retire detection. Highest value:
   this also covers the legacy `stateAgentDefinition` fallback.
2. **Reuse `ctx.sessionManager` when `session.value` equals the current session
   file.** The lead reading *itself* is the dominant case; its entries are already
   in memory. Requires confirming the in-memory vs file-parse equivalence for
   conflict/retire semantics before adopting.
3. **Bounded reads**: use `readPiSessionHeaderId` (already used by
   `matchesExpectedSession`, `herdr.ts:1900`) for the id check and defer the full
   entries read. Removes open #1's full read but open #2 (identity scan) still
   needs every matching entry, so it does not remove the burn by itself.
4. **Compute `proveLead` less often / only for status consumers.** Cheapest, but
   the lead/herd breadcrumb would lag until the next compute; supervision
   consequences are limited to breadcrumb labelling (see above).

UI/supervision consequences to preserve for any of the above: breadcrumb
"herd"/"?" selection, `lost`/`unknown`/`stale` rows, and the
`herdRunStartedAt` finishing gate. A cache keyed on mtime/size does not stale
those (idle = unchanged file); a TTL cache could briefly mislabel a
just-defined lead.

## Non-burn callers (source inference, not runtime-measured as idle loops)

- `readPersistedSessionEntries` (`index.ts:1522`, one full `readFileSync`) is
  reached only by `readPersistedTranscript` ← `readAgentTranscript`
  (`:6895` tool execute) and `:14153` command path — explicit operator/agent
  actions, not a timer. The earlier "second full read at ~1533" is this path and
  does not explain the idle burn.
- `stateAgentDefinition` fallback `SessionManager.open` (`:1473-1485`) is only
  reached when `state.agentDefinition === undefined` (`agentDefinitionForRuntime`,
  `:4776-4786`); all six live states define it, so it is dormant. It would add one
  full read per legacy mailbox **per tick** if present — worth covering by
  option 1.
- `refreshSupervision` (`:12097`, 2 s, chief/manager only) uses
  `proveLead=false` → no boundary opens. `scanAgentHealth` (`:14862`, 30 s) uses
  `proveLead=false`.
- `persistedSessionName` / `loadSupervisionSnapshot` open whole files
  (`:2269`, supervision only) — out of the idle-lead status path.

## Limitations

- `/proc` `rchar` is whole-process and includes mailbox/index/other reads; the
  ~2x factor is inferred from the isolated ticks and the 1.00x `open` measurement,
  not from `strace` (ptrace is blocked: `kernel.yama.ptrace_scope=1`).
- The isolated host trace uses the mocked `SessionManager.open`; it proves the
  caller chain and cadence, while Evidence A/C prove the read cost.
- `pi-bolt-0.7.0` binaries were not separately disassembled; `pi-1.0.2` (the live
  lead's runtime) and the pinned `0.99.2` both show the full-load behaviour.
- Live inventory was a point-in-time snapshot; owner/path matches can change as
  leads restart.

## Reusable artifacts

- `/tmp/probe-open.mjs` — measures `SessionManager.open` bytes/time on a copy.
- `/tmp/php-probe/` — isolated extension copy with instrumented mock open.
- `/tmp/php-probe/extension/probe.test.ts` — lead-tick probe (2 opens/tick proof).

---

# Follow-up: conditional-proof validation (isolated) and upstream comparison

Read-only validation of the smallest possible lead-scope patch, plus comparison to
the upstream fix (PR #229). No production edits; all work in `/tmp/php-probe`.

## Candidate patch (one expression)

`extension/index.ts`, in `loadStatusSnapshot` (baseline line 12574):

```diff
@@ -12576,7 +12576,7 @@
         ctx,
         controllerScope,
         signal,
-        true,
+        controllerScope.kind !== "lead",
       );
```

Saved as `/tmp/lead-prove-patch.diff`; pristine copy preserved at
`/tmp/index.ts.baseline`. It is type-safe: `loadStatusSnapshot` lives inside the
`if (controllerScope)` block (`index.ts:10684`), so `controllerScope.kind` is
narrowed and always defined there.

Why it is safe: `loadStatusSnapshot` returns
`breadcrumb: controllerScope.kind === "lead" ? ["herd"] : statusBreadcrumb(view, ctx)`
(`index.ts:12648-12651`) — the lead breadcrumb never consults `leadSessionIds`.
`leadSessionIds` has exactly one consumer, `statusBreadcrumb` (`index.ts:3766`);
`listedAgentRecord`, `visibleAgentSnapshots` and `publishOwnerView` never read it.
The only `agentSnapshotView(..., proveLead=true)` call is this one (12574);
`refreshLeafStatus` calls `managedAgentSnapshots(..., true)` directly and is
untouched.

## Differential result (instrumented mock, stack-traced opens)

Two probes in the isolated copy: `extension/probe.test.ts` (lead scope) and
`extension/probe-worker.test.ts` (managed-leaf/worker scope).

| Probe | Baseline | Patched |
|---|---|---|
| Lead tick1 / tick2 opens | 2 / 2 | **0 / 0** |
| Lead boot opens | 7 | 3 |
| Lead breadcrumb | `● herd  1 lost` | `● herd  1 lost` (identical bytes) |
| Lead rendered rows stable across ticks | yes | yes |
| Worker (managed leaf) tick1 / tick2 opens | 2 / 2 | 2 / 2 (unchanged) |
| Worker breadcrumb | `● herd → agent:probe-leaf` | same (root proof retained) |

Commands:

```
$ node --experimental-test-module-mocks --import=./scripts/test-env.mjs \
    --test --test-timeout=20000 extension/probe.test.ts
PROBE_RESULT {...,"tick1Delta":2,"tick2Delta":2,"breadcrumb":"● herd  1 lost","rowsStable":true}
PROBE_RESULT {...,"tick1Delta":0,"tick2Delta":0,...}   # after patch
$ node ... extension/probe-worker.test.ts
PROBE_WORKER_RESULT {"tick1Delta":2,"tick2Delta":2,"breadcrumb":"● herd → agent:probe-leaf"}
```

The lead tick still runs `herdrSessionSnapshot` (subprocess) and mailbox reads;
the patch removes only the two `SessionManager.open` full-transcript reads. Boot still
has 3 one-time definition reads; none recur.

## Regression checks on the patched copy

| File | Result |
|---|---|
| `extension/commands.test.ts` (owns the lead TUI status path, incl. "TUI status refresh consumes the coherent Herdr session snapshot") | **79/79 pass** |
| `extension/controller-lifecycle.test.ts` | **66/66 pass** |

Only `extension/index.ts` (the one expression) and the `support.ts` mock
instrumentation differ from production in the copy (`diff -rq`).

## Remaining readers after this patch

- **Managed-leaf status** `refreshLeafStatus` (`index.ts:16608-16613`, `proveLead=true`,
  2 s) still opens 2 transcripts/tick per leaf. It needs root proof because the leaf
  breadcrumb uses `statusBreadcrumb` → `leadSessionIds`.
- **Supervision** `loadSupervisionSnapshot` → `persistedSessionName` (`index.ts:2271`)
  opens a whole transcript (`SessionManager.open` for `getSessionName`) per live
  `kind:"path"` agent while chief/manager is active (2 s). `refreshSupervision`
  itself uses `proveLead=false`.
- **Dormant legacy fallback** `agentDefinitionForRuntime` → `stateAgentDefinition`
  (`index.ts:1473-1485`) would open once per mailbox missing `agentDefinition`,
  per tick. Not triggered today (all live states define it).
- **Explicit paths**: `readAgentTranscript` tool execute (`:6895`),
  `readPersistedTranscript` command (`:14153`), stats/continuity opens — unchanged.

## Comparison with upstream PR #229 (v0.19.1)

Upstream chose a different contract, not a cache or a lead-only condition:

| Aspect | This patch | Upstream #229 |
|---|---|---|
| Lead periodic proof | Dropped for lead scope (breadcrumb already hardcoded) | Lead proof derived from `readLeadCoordinationState(supervisionRuntime(), ownerSessionId)?.role === "lead"` |
| `isLeadSessionBoundary` | Kept; still used by worker leaf status | **Deleted** (with `persistedSessionName`) |
| Worker leaf transcript opens | Still 2/tick | Removed (coordination-state proof) |
| Legacy definition fallback | Untouched (dormant) | `allowTranscriptDefinitionFallback=false` on periodic paths → `"unknown"` |
| Supervision refresh overlap | Untouched | Coalesced (`supervisionRefreshInFlight` + one trailing rerun) |
| Surface | 1 expression | ~125+/57- in `index.ts` + tests |
| Identity semantics | Unchanged everywhere | Periodic paths stop validating owner transcript; explicit/continuity paths keep `sessionAgentIdentity`/`retiredManagedSession` |

Decision-relevant reading: this patch removes exactly the measured lead burn with no
semantic change; upstream removes *all* periodic transcript opens (lead, worker,
supervision name, legacy fallback) by moving the periodic source of truth to
coordination state. If the fork ports #229, this one-line condition becomes
redundant (the whole predicate is replaced). If it does not, this is the smallest
safe local bound and the worker/supervision reads remain.

## Local coordination-state prerequisite for the upstream predicate

Upstream's `readLeadCoordinationState(...)?.role === "lead"` is satisfied locally:
the live lead owner sessions each have a coordinator record under
`~/.pi/agent/pi-herdsman/runtime/supervision-v2/<socketHash>/coordinators/<sha256(sessionId)>.json`:

```
01a10e6e-8f85-70a2-ad2f-afaff03ff4c4 -> a39e95…2133  {"version":1,"role":"lead","piSessionId":"01a10e6e-…",...}
01a100d9-68fa-706d-8d49-dd895857dd23 -> e816b4…6b1d  {"version":1,"role":"lead",...}
01a0b8bb-ee3a-7141-a5e3-c491dcbe6e38 -> 2fe30e…584b  {"version":1,"role":"lead",...}
```

So porting the upstream lead predicate would keep the lead breadcrumb `herd` for
current live leads, and (for workers) would resolve their owner's lead role without
opening the owner transcript. Two local caveats for the port: (1)
`readLeadCoordinationState` throws on malformed/oversized state, so the predicate
needs upstream's `try/catch` to degrade to `unknown` rather than failing the
refresh; (2) a lead that has not published coordination state would breadcrumb `?`
where the current transcript check could still say `herd` — the status path never
cares, but the worker leaf breadcrumb would.

## Limitations

- The differential uses the mocked `SessionManager.open`; it proves the caller
  chain and open count, while the earlier `/proc` + `probe-open.mjs` evidence
  proves per-open cost. No live process was reconfigured.
- Regression runs were the two most relevant test files on the isolated copy; the
  full package gate was excluded per scope.
- The upstream port assessment is the parent's; this file only reports the local
  prerequisite check and the observable differential.
- The patch was not applied to production; `git status --short pi-herdsman` is clean.

