# Supervision live-agent fix: trace before edit

Status: trace written before any edit in this pass. Scope and rulings are in the
assignment brief; this records what the code does, field by field.

## Pin check (canonical checkout)

`/home/saurabhj/Projects/dev/agent-radar` has commit `f87348032a808967c50a4e84b7e1c766a64ebfe3`
(`f8734803 Standardize daemon protocol v2 and fence dead-pane cleanup`) as HEAD,
detached. The checkout has 52 uncommitted files, so the working tree is not the
pin. Hash comparison of the contract documents, committed pin against
`/tmp/radar-head` (which was the earlier pin evidence):

| file | pin | /tmp/radar-head | working tree |
| --- | --- | --- | --- |
| docs/control-plane.md | 24551595 | 24551595 | e71c968b (differs) |
| docs/mux.md | fd5c9ca3 | fd5c9ca3 | e24b0438 (differs) |
| docs/daemon.md | ad3e2aa3 | ad3e2aa3 | 516ca309 (differs) |
| docs/agent-registration.md | 6a2d3a49 | 6a2d3a49 | 0fc0f4d3 (differs) |
| docs/agent-registration.fixture.jsonl | 8ebf41b3 | 8ebf41b3 | 295581be (differs) |
| docs/control-plane.fixture.jsonl | bfb5be05 | bfb5be05 | 9fca559c (differs) |
| src/model.rs | 723bf850 | 723bf850 | 19be0b65 (differs) |

So the contract documents this pass checks against (`/tmp/radar-head` and the
vendored fixture) are the pinned ones, byte-for-byte. The canonical working tree
is not: it carries uncommitted Radar edits, and the contract I rely on is the
committed one. Stated plainly: the pin is verified, the working tree is not the pin.

## The call chain, and where it actually drops

Two facts from `index.ts` change the picture from the earlier type-pass reading.

1. `activeRole()` is `"chief"` whenever Chief mode is on (`index.ts`, `chiefMode === "inactive" ? "lead" : "chief"`).
2. `refreshSupervisionOnce` only runs while Chief mode is active.

So, for every refresh:

```
refreshSupervisionOnce                       index.ts:11459
  inventory = radarFleetInventory()           Radar observe  (RadarInventory)   :11460
  agents    = managedAgentSnapshots(.., {inventory, available})                :11461
  loadSupervisionSnapshot(ctx, inventory, agents)                              :11477
    if activeRole()==="chief" && !includeAll                                    :11351
      return { leads: directReports(ctx) }     <- the Radar inventory is discarded here
        directReports(ctx)                                                       :11451
          loadSupervisionSnapshot(ctx, undefined, undefined, true)             :11456
            inventory = herdrSessionSnapshot(pi, ctx)  = `herdr api snapshot`   :11353
            live = inventory.agents             <- Herdr rows
            live.flatMap: herdrSessionId / isPiAgent / supervisedSessionFile / tokens / herdrName
            projectSupervision(...)
```

Consequences, verified by reading:

- **The Chief's live list is read from Herdr, not Radar.** The Radar inventory
  passed at `:11477` never reaches the loop. The earlier reading (that the loop
  receives Radar rows and drops them for lacking `agent_session`) was on a branch
  the Chief never takes. The defect is the source, not only the row shape.
- Under the cutover, `herdr api snapshot` cannot succeed on a Herdr-free machine.
  `runHerdr` (`herdr.ts`) runs `pi.exec("herdr", ...)`, which throws, so
  `directReports` throws, and `refreshSupervisionOnce`'s catch marks the snapshot
  stale. The Chief therefore never gets a fresh supervision list.
- The focus path (`index.ts:11679`, `loadSupervisionSnapshot(ctx)`, no inventory)
  reaches the same Herdr read.

## Field-by-field: what the loop reads, and what a Radar row carries

The loop (`index.ts:11377–11403`) builds a `LiveAgent` (`supervision.ts:1499`).

| LiveAgent field | Herdr source read at HEAD | Radar `RadarObservedAgent` | Fix |
| --- | --- | --- | --- |
| `sessionId` | `herdrSessionId(agent)` ← `agent_session` (`index.ts:2670`) | `observedPiSessionId(agent)` (`index.ts:2688`), from `session` (`uuid`, or `reported` with `source: herdr:pi`, header read) | use `observedPiSessionId` |
| admission | `isPiAgent(agent)` ← `agent_session` (`index.ts:2571`) | `session` present and `observedPiSessionId` defined | drop `isPiAgent` from this loop |
| `piSessionFile` | `supervisedSessionFile(agent, id)` ← `agent_session` + `agent.cwd` (`index.ts:2712`) | `session` (path form only); no `cwd` | resolve only the reported-path form; a uuid has no file without a cwd |
| `workspaceId` | `workspace_id` | `workspace_id` | same |
| `tabId` | `tab_id` | `tab_id` | same |
| `paneId` | `pane_id` | `pane_id` | same |
| `workspaceCwd` | `cwd` | absent | field loses its producer |
| `herdrName` | `name` | `name` is the reported agent name (`pi`), not the lead's name | field loses its producer; must not be fed `pi` |
| `tokens` | `tokens` (Herdr token map; `pi_herdsman_name`) | absent | field loses its producer |
| `runtimeState` | `normalizeHerdrLifecycleState` ← `agent_status` (`supervision.ts:1658`) | `radarLifecycleState(agent)` ← `status` (`radar-client.ts`) | use `radarLifecycleState` |
| diagnostic | `agent.agent === "pi"` / `agent_session.agent` | `name === "pi"` with no resolvable session | rewritten to the Radar shape |

Shape differences that matter:

- A Radar row has **no `agent_session` key**, so `isPiAgent` and `herdrSessionId`
  read nothing from it. This is the earlier "drops every row" finding, and it is
  real, but it is not reached on the Chief path today.
- A Radar row has **no `cwd`**. A uuid-kind Pi session cannot be mapped to a
  transcript file without one, so a uuid Lead has no `piSessionFile` from the row.
  This is a known limit; the mailbox state has `piSessionFile`, but this loop does
  not read the mailbox.
- A Radar row's `name` is documented (`radar-client.ts`, `RadarObservedAgent`) as
  the reported agent name and "never the managed worker's label". It is not a
  Lead display name, so it must not be mapped to `herdrName`.

## Why the Radar row is the right source

`radar-client.ts` documents `RadarInventory.agents` as "the set the daemon presents
as facts, projected from its registry for every backend", with backend-own records
moved to containment evidence. So a row in `inventory.agents` is the canonical
registry projection: presence is proven by the row being there, not by reading a
Herdr field. `managedAgentPresence` (`index.ts:4290`) already proves a child's
presence this way (`canonicalAgentProves` against `inventory.agents`).

The `observe` reply is `{ok, value}` or a failure. An unavailable observation must
not look like an empty fleet: `radarFleetInventory` returns `available: false` and
`NO_INVENTORY`, and the existing rule is that unreadable inventory proves no
absence (`managedAgentPresence` returns `unknown`). The Chief refresh must keep
that: an unavailable observation marks the snapshot stale, it does not produce an
empty fresh list.

## Planned change (no edit made yet)

1. `loadSupervisionSnapshot` takes the Radar observation (`PresenceInventory`,
   the shape `radarFleetInventory` already returns) instead of
   `HerdrSessionSnapshot`. The parameter type changes to the source it reads; it
   is not widened and no optional field is added.
2. The Chief early return passes the observation through `directReports`, so the
   refresh's Radar read is the one that is used, with no second Herdr read. An
   unavailable observation throws, so the existing catch marks the snapshot stale.
3. The loop reads `inventory.agents` (Radar rows) with the Radar fields in the
   table above. `herdrSessionId` and `isPiAgent` keep their other callers and
   survive; this loop no longer calls them.
4. The focus path (`index.ts:11679`) reads the same observation.
5. Orphaned, to delete with their callers:
   - `herdrSessionSnapshot` (herdr.ts) and its import at `index.ts:222`: its only caller was the loop's Herdr default.
   - `LiveAgent.herdrName`, `LiveAgent.tokens`, `LiveAgent.workspaceCwd` and their
     reads in `supervision.ts` (`tokensName`, the `herdrName` branch, the
     `workspaceCwd` fallback). Each loses its only producer.
   - `supervisedSessionFile` if the new resolution does not use it.
6. Survivors, each with a live caller: `herdrSessionId` (`index.ts` 10378, 11702,
   11963, 13399), `isPiAgent` (10378, 10396, 10420, 11701, 11960, 13398),
   `normalizeHerdrLifecycleState` (14517), `observedPiSessionId`, `observedSessionAsHerdr`,
   `tabLabel` (already no producer at HEAD; not orphaned by this change, left and reported).
7. `workspacePresentationProvenance` still calls Herdr `workspace get`. It catches
   the failure and falls back to the supplied cwd map, which is now empty, so the
   row keeps its workspace id as its label. This is a remaining Herdr call on the
   refresh path and is out of this slice; it is reported, not changed.

## Known limits this change accepts (for the owner)

- A uuid-kind Lead has no `piSessionFile`, because the Radar row carries no cwd.
- A Lead's display name falls back to `lead-<8 chars of session>`. Its Herdr name
  and `pi_herdsman_name` token are gone. A Radar-side name for a Lead does not exist
  in the observation.
- A Lead's workspace label is its workspace id, not the repository/branch label,
  until `workspacePresentationProvenance` stops calling Herdr.

## Acceptance test plan

- Positive: a Chief active, `radarDaemon.observeInventory` returns a Radar row for a
  registered Pi Lead (uuid session, pane, tab, workspace). The Chief's
  `before_agent_start` supervision message must name that session.
- Negative: an observed row whose session is not a Pi identity (for example a
  reported path with another source), and an unavailable observation. Neither may
  produce a lead in the message, and the unavailable case must not report a fresh
  empty list.
- The existing Herdr-based Chief test (`commands.test.ts` 470, "Chief staff and
  ambient supervision include unclaimed Leads") reads `herdr api snapshot`. It will
  stop passing once the Chief reads Radar. That file is outside this slice's
  allowed list, so it is reported, not edited.

## Outcome (after the edit)

Edits landed in `index.ts` (`loadSupervisionSnapshot`, `directReports`,
`refreshSupervision`, `supervisedSessionFile`, the `herdrSessionSnapshot` import),
`supervision.ts` (`LiveAgent` loses `herdrName`, `tokens`, `workspaceCwd`; the name
chain is `tabLabel` then `lead-<8 chars>`), `supervision.test.ts` (the naming test
amended to the Radar-era inputs; the token-precedence block deleted),
`controller-api.test.ts` (one new test). No parameter was widened and no optional
field added.

What the code now does: the Chief's list is built from the observation the refresh
already read. The loader's `live` is `observation.inventory.agents`; a row joins the
list only when `observedPiSessionId` proves a Pi session (a uuid, or a reported
reference with source `herdr:pi` whose header carries the id). An unavailable
observation throws, so the snapshot is marked stale and never published as an empty
fresh fleet.

Deleted with their only callers: `herdrSessionSnapshot`'s import (the function
stays in herdr.ts because `herdr.test.ts` tests it directly and that file is out of
scope), the `LiveAgent` fields `herdrName`, `tokens`, `workspaceCwd`, and the
`supervisedSessionFile` Herdr branch. Survivors with live callers: `herdrSessionId`,
`isPiAgent`, `normalizeHerdrLifecycleState`, `observedPiSessionId`.

Tests proving the fix:
- `controller-api.test.ts` "a Chief's supervision lists a Lead only when the Radar
  observation proves it": a Radar-observed uuid Lead appears in the Chief's
  `before_agent_start` supervision message; a row whose reported source is not
  `herdr:pi` does not. Checked by mutation: making a uuid identity prove nothing turns
  it red; reverted and green again.
- The unprovable case is therefore covered by the non-Pi row. The unavailable
  observation throw is not covered by a test; noted as a gap.

Measured (whole files, `--test-concurrency=1 --test-timeout=60000`, flags before the file):
- supervision 49/49, exit 0 (49/49 before the edit too: the naming test is one test, and the amendment removed a block inside it, not a test).
- control-integration 7/7, exit 0.
- presentation 68/68, exit 0.
- controller-api 66 tests, 47 pass, 18 fail, 1 cancelled, exit 1: the new test passes; the
  18 failing names and the cancelled one are identical to the last recorded run.
- commands 78 tests, 74 pass, 4 fail, exit 1 (was 78/78). See below.

Regression left in place, reported not edited: four `commands.test.ts` tests fail
because their Chief and focus fixtures put Leads in `herdr api snapshot`, which the
supervision path no longer reads. They are "Chief staff and ambient supervision include
unclaimed Leads" (470), "a changed, moved, or duplicated observed identity focuses
nothing" (2649), "an unavailable Radar control plane fails the focus without a Herdr
fallback" (2743), and "Chief overview redraws identical herds when freshness
changes" (2863). All four build their Leads through `openChiefOverview` or a direct
`isApiSnapshot` fixture. They describe the removed Herdr source, so they need
rewriting on Radar fixtures (or deleting where covered by the new test). This needs
`commands.test.ts` released to this slice, which the brief does not give.

Pin: verified. The canonical checkout (`/home/saurabhj/Projects/dev/agent-radar`) is at
`f8734803`, detached. Its working tree has 52 uncommitted files and differs from the pin for
every contract document (`docs/control-plane.md`, `docs/mux.md`, `docs/daemon.md`,
`docs/agent-registration.md`, both fixtures, `src/model.rs`). The documents this slice checked
against are the committed pin's, matched byte-for-byte through `/tmp/radar-head`. The canonical
working tree is not the pin.

## Follow-up pass: commands green, stale-not-empty, `herdr:pi` origin

**`commands.test.ts` is green again: 78/78 (was 74/78; the count is unchanged, no test deleted).**
Rewritten on Radar fixtures:

- "Chief staff and ambient supervision include unclaimed Leads": the lead is observed through
  Radar, not a Herdr snapshot.
- "a changed, moved, or duplicated observed identity focuses nothing": the notice is now
  "Lead changed; reopen staff.". The supervision load refuses a changed observation before the
  focus re-proof runs, so the re-proof's "Radar could not confirm" notice is no longer the one
  shown. The refusal and the no-focus assertion are unchanged.
- "an unavailable Radar control plane fails the focus without a Herdr fallback": renamed to
  "an unavailable Radar observation refuses the focus rather than reading as an empty fleet". It
  is the focus-side stale-not-empty test: it asserts the exact unavailable notice, which an
  empty fleet would replace with "Lead changed".
- "Chief overview redraws identical herds when freshness changes": passes. Its failure came
  from leaked state (below), not from its own assertions.

Other changes in the file:

- The overview fixture supplies the Herdr agent-list row the focus identity proof still reads
  (`herdrLeadRow`). Production focus runs `listAllHerdrAgents`, `isPiAgent` and
  `herdrSessionId` before the Radar re-proof, and the brief excludes the Herdr removal. The row
  does not supply the lead's identity or location, which come from the Radar observation.
- Leaked state: "a lost focus reply" and "a daemon without the focus capability" cleared
  `RADAR_CONTROL_SOCKET` with `delete`. Later Chief tests then dialled the default path, which
  read as "unavailable". The Chief overview did not read Radar before the supervision fix, so
  the leak was latent. Both now call `ensureRadarDaemon()`, the owned restore in `support.ts`,
  and so does the focus helper's cleanup.
- "registered chief widget obeys registration, refresh, and teardown contracts": the refresh
  now reads the daemon over its socket, so the test waits for the repaint, as the redraw test
  already does, instead of one `setImmediate`.

**Stale-not-empty is covered by two tests.** The focus side is the exact-notice test above, and
the overview side is "Chief overview redraws identical herds when freshness changes", which
asserts `1 herd · stale` after a failed refresh. An empty snapshot would render `0 herds` and
fail it.

**`herdr:pi` origin: neither ours nor a daemon contract value.** The pinned docs
(`docs/control-plane.md`) define `applies_to_source` but never define the literal `herdr:pi`.
The label originates in the Herdr backend. `src/herdr.rs` `session_identity` (line 361) copies
the `source` of Herdr's own `agent_session` record into `SessionIdentity::Reported`, and the
pinned Herdr tests use the literal (`src/herdr.rs:1398`, `tests/fixtures/herdsman_pane_metadata.json`).
The daemon forwards it verbatim. Our `observedPiSessionId` (`index.ts`) gates a reported *path*
reference on that literal, and a uuid identity does not depend on it. Left unchanged: renaming
it would change which path references are accepted. Owner decision: whether the path-reference
rule survives the Herdr removal, or is kept as a Radar-side rule under a name Radar owns.

**Measured (whole files, `--test-concurrency=1 --test-timeout=60000`, exit captured):**

- commands 78/78, exit 0. controller-api 66 tests, 47 pass, 18 fail, 1 cancelled, exit 1: the same
  19 relaunch/continuation and ordinary names as before, no new failure.
- supervision 49/49, control-integration 7/7, presentation 68/68, all exit 0.
- Mutation: making `loadSupervisionSnapshot` treat an unavailable observation as an empty fleet
  turns both stale-not-empty tests red ("Lead changed" in place of the unavailable notice; "0 herds"
  in place of "1 herd · stale"). Restored byte-identical.
- Type check, same command: 748, unchanged, and the normalised error set is identical to the
  previous pass. The one error in the new controller-api test (line 422, the untyped
  `session_shutdown` call) still stands.
- `commands.test.ts` is 6,042 lines; it was 6,132 before this pass.

**Left for the owner:**

- The focus action still depends on Herdr for its identity proof (`focusSupervisedLead` →
  `listAllHerdrAgents`). The Herdr removal slice must replace it.
- `focusProvedLocation`'s "Radar could not confirm" branch (`observed.length !== 1`) is now reached
  only if the supervision load and the re-proof disagree. It may be an unreachable guard under
  the rule that unreachable guards are deleted (#5079). Not deleted here.
