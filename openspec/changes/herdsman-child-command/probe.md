# Probe — direct child start via `herdr pane run` (tasks 4.1 / 4.2)

Recorded transcript for the stage-2 precondition (design D7). No production, test or docs
file was changed by this probe; the only repository artefacts are this file and the two
ticks in `tasks.md`.

## Environment

```
$ herdr --version
herdr 0.9.3

$ herdr status
client:
  version: 0.9.3
  channel: stable
  protocol: 22
  endpoint_protocol_generation: 1
server:
  status: running
  version: 0.9.3
  endpoint_compatible: yes
  private_protocol: 22
  private_protocol_compatible: yes
  socket: /home/saurabhj/.config/herdr/herdr.sock
update:
  restart_needed: no
  server_binary_stale: no
```

- `HERDR_BIN_PATH=/nix/store/awnbisva04i80m2hzkpzppnv6qwb6cq2-herdr-0.9.3/bin/herdr`
- Command under probe: `/home/saurabhj/.nix-profile/bin/pi-bolt-child` (the stage-1 value).
- The pane shell in a fresh Herdr tab is the operator's login shell — **fish** on this
  machine — so the text `pane run` types is parsed by that shell, not by `bash`.
- Raw transcript and fixtures: `/tmp/herdr-probe/` (`p1.txt`, `p2.txt`, `p3.txt`,
  `p3-rigorous.txt`, `p4.txt`, `p4-real.txt`, `cleanup.txt`, `*.out`, `dump.sh`,
  `launch.sh`). Outputs below are copied from those files; long JSON records are elided with
  `…` and terminal reads drop the pane's right-aligned timestamp column.

## Method and containment

Every pane used was a throwaway tab created by this probe in workspace `wQ` with
`herdr tab create --workspace wQ --cwd /tmp --label child-cmd-probeN --no-focus`:
`wQ:tR`(`wQ:p1Q`), `wQ:tS`(`wQ:p1R`), `wQ:tT`(`wQ:p1S`), `wQ:tV`(`wQ:p1T`),
`wQ:tW`(`wQ:p1V`), `wQ:tX`(`wQ:p1W`). No existing pane, worker or agent was touched. All six
tabs were closed by this probe and cleanup is verified in the last section.

Agent launches were argument lists passed to `pane run` exactly as stage 2 would pass them;
the launches were prompt-free except for one minimal prompt used to settle P1's session
question (P1d), which is called out where it appears.

For a deterministic argv measurement, `wQ:p1R` was switched to a plain shell with
`herdr pane run wQ:p1R 'exec bash --norc --noprofile'`; `p4-real.txt` repeats the decisive
case in the untouched fish pane `wQ:p1S`.

## P1 — is an agent started by `pane run` visible to the agent surface, and what registers it?

**Result: YES, visible.** Both with and without the reporter extension, and by every agent
query.

### P1a — reporter extension loaded (the normal Herdsman case)

```
$ herdr pane run wQ:p1S "/home/saurabhj/.nix-profile/bin/pi-bolt-child --no-extensions \
    -e builtin:mcp -e builtin:codemode \
    -e /home/saurabhj/.pi/agent/extensions/herdr-agent-state.ts --name herdr-probe-child-command"

$ herdr agent get wQ:p1S
{"id":"cli:agent:get","result":{"agent":{"agent":"pi",
  "agent_session":{"agent":"pi","kind":"path","source":"herdr:pi",
    "value":"/home/saurabhj/.pi/agent/sessions/--tmp--/2026-10-06T15-03-13-849Z_01a111bd-7eb9-75cd-9133-36104ae1aa1c.jsonl"},
  "agent_status":"idle","cwd":"/tmp","pane_id":"wQ:p1S","revision":15,
  "screen_detection_skipped":true,"state_change_seq":2417,"tab_id":"wQ:tT",
  "terminal_id":"term_65d2d48bb3f5797",
  "terminal_title":"π - herdr-probe-child-command - tmp", ...
```

```
$ herdr agent explain wQ:p1S --json
{"agent":"pi","evaluated_rules":[],"fallback_reason":null,"matched_rule":null,
 "screen_detection_skip_reason":"full_lifecycle_hook_authority",
 "screen_detection_skipped":true,"state":"idle","visible_blocker":false,
 "visible_idle":false,"visible_working":false,"warning":null}
```

Interpretation, evidence-backed: Herdr registers the agent and the child's reporter
extension (the file Herdsman passes at `herdr.ts:118-127`) supplies the session identity and
takes lifecycle authority for the pane; Herdr then skips its own screen detection for that
pane (`full_lifecycle_hook_authority`) and the `working`/`idle`/`blocked` state comes from
the child's `pane.report_agent` calls.

### P1b — reporter extension not loaded

```
$ herdr pane run wQ:p1T "/home/saurabhj/.nix-profile/bin/pi-bolt-child --no-extensions \
    -e builtin:mcp -e builtin:codemode --name herdr-probe-no-reporter"

# first poll that returned an agent record, 638 ms after the run
{'agent': 'pi', 'agent_status': 'unknown', 'pane_id': 'wQ:p1T',
 'terminal_title': '/home/saurabhj/.nix- /tmp'}
agent_session: None

$ herdr agent explain wQ:p1T --json
{"agent":"pi","evaluated_rules":[ {...,"id":"working_literal","matched":false},
  {...,"id":"working_border","matched":false} ],
 "fallback_reason":"default_known_agent_idle_fallback",
 "manifest_source":"remote:/home/saurabhj/.local/state/herdr/agent-detection/remote/pi.toml",
 "manifest_version":"2026.10.01.1","matched_rule":null,
 "screen_detection_skipped":false,"state":"idle", ...

$ herdr agent get wQ:p1T
{'agent': 'pi', 'agent_status': 'idle', 'cwd': '/tmp', 'pane_id': 'wQ:p1T',
 'terminal_title': 'π - herdr-probe-no-reporter - tmp', ...}   # no name, no agent_session
```

So Herdr detects the `pi` agent from the pane content alone (its remote detection manifest
plus the child's terminal title), and reports `idle` through
`default_known_agent_idle_fallback`; **without the reporter there is no `agent_session` and
no agent name**, and screen detection stays authoritative.

### P1c — is the reported `agent_session` path usable?

```
# prompt-free launch, wQ:p1W, reporter loaded
$ herdr agent get wQ:p1W | ... agent_session.value
/home/saurabhj/.pi/agent/sessions/--tmp--/2026-10-06T15-06-09-575Z_01a111c0-2d27-7047-b3d1-ca28c359e85e.jsonl
$ test -e "$value"  →  MISSING (no turn written yet)

# control: a live managed worker (pane wQ:p1P, started by `agent start`)
value=/home/saurabhj/Projects/dev/custom/pi-extensions/.pi/sessions/children/2026-10-06T14-58-46-830Z_01a111b9-6bae-7046-a75a-b95c7c492bc3.jsonl
EXISTS size=5591760
```

### P1d — one minimal prompt (the only prompt sent by this probe)

```
$ herdr agent prompt wQ:p1W 'Reply with the single word: ok' --wait --timeout 90000
exit=0 elapsed_ms=1918        # result.agent.agent_status = "done"

$ herdr agent get wQ:p1W | ... agent_session.value   → same path
EXISTS size=55961
```

Conclusion: the reported path is correct and becomes the real session file with the child's
first turn; the reporter reports it eagerly at `session_start`. Herdsman already tolerates a
not-yet-written file at that path — `readPiSessionHeaderId` returns `undefined` for `ENOENT`
and `matchesExpectedSession` treats it as "unresolved prospective file"
(`herdr.ts:1950-1956`), so this is not a new risk and is not stage-2 specific.

## P2 — does `agent rename` apply the Herdsman alias afterwards, and what do queries report?

**Result: YES.** `agent rename` works on a `pane run`-started agent, and the name is what the
agent queries report.

```
# reporter agent, live for a few seconds, THEN renamed
$ herdr agent rename wQ:p1S probe-cmd_0123456789ab
{"id":"cli:agent:rename","result":{"agent":{"agent":"pi","agent_status":"idle",
  "name":"probe-cmd_0123456789ab","pane_id":"wQ:p1S", ... }}}

$ herdr agent get probe-cmd_0123456789ab      # by alias
{"agent":"pi","name":"probe-cmd_0123456789ab","agent_status":"idle","pane_id":"wQ:p1S", ...}

$ herdr agent get wQ:p1S                      # by pane
{'agent': 'pi', 'name': 'probe-cmd_0123456789ab', 'agent_status': 'idle', ...}

$ herdr agent list | (pane wQ:p1S)
{'agent': 'pi', 'name': 'probe-cmd_0123456789ab', 'agent_status': 'idle', 'pane_id': 'wQ:p1S'}
```

Persistence and ordering:

- The reporter keeps sending `pane.report_agent` / `pane.report_agent_session` after the
  rename (its payloads carry `agent: "pi"`, a session ref and a state — **no name**), and the
  name survived: re-queried after ~60 s with the reporter active, `name` was unchanged
  (`probe-rep_0123456789ab`), and after ~12 s on the reporter-less agent
  (`probe-norep_0123456789ab`).
- Renaming **before** the agent record exists fails:

```
# 28 ms after `pane run`, agent record not yet present
$ herdr agent rename wQ:p1V probe-rep_0123456789ab
{"error":{"code":"agent_not_found","message":"agent target wQ:p1V not found"}, ...}
```

So the alias must be applied after the child is registered, exactly as design D4/D5 order
(readiness before rename).

- `agent get <target>` resolves an agent by its renamed name, by the pane id, and — for
  completeness — `agent wait` accepts both too (P3a/P3b).

## P3 — does `agent wait --until` reach readiness, and how long does readiness take?

**Result: YES for a registered agent; the wait cannot be issued before registration.**

```
$ herdr agent wait wQ:p1W --until idle --timeout 3000    # issued 10 ms after `pane run`
exit=1 {"error":{"code":"agent_not_found","message":"agent target wQ:p1W not found"}}
```

Rigorous run (`p3-rigorous.txt`), reporter loaded, pane `wQ:p1W`, 100 ms poll of `agent get`:

```
poll   1 t+  10 ms exit=1 agent_not_found
poll   2 t+ 117 ms exit=1 agent_not_found
poll   3 t+ 223 ms exit=1 agent_not_found
poll   4 t+ 331 ms exit=1 agent_not_found
poll   5 t+ 438 ms exit=1 agent_not_found
poll   6 t+ 546 ms exit=0 {"agent":"pi","agent_status":"unknown", ...}
agent wait --until idle exit=0 in 309 ms; total from pane run: 859 ms
final: {"agent":"pi","agent_status":"idle","agent_session":{...},"screen_detection_skipped":true}
```

Reporter-less run (pane `wQ:p1T`): first record at 638 ms, `agent wait --until idle`
succeeded in 112 ms — total ≈ 750 ms.

Wait semantics on a settled agent:

```
$ herdr agent wait probe-cmd_0123456789ab --timeout 5000          # settled defaults
exit=0 elapsed_ms=9
$ herdr agent wait wQ:p1S --until idle --timeout 5000
exit=0 elapsed_ms=3
$ herdr agent wait wQ:p1S --until working --timeout 3000
exit=1 {"error":{"code":"timeout","message":"timed out waiting for agent status"}} elapsed_ms=3009
$ herdr agent wait not-a-real-agent --timeout 2000
exit=1 {"error":{"code":"agent_not_found","message":"agent target not-a-real-agent not found"}}
```

Conclusion for stage 2: `agent wait --until idle --timeout` is a usable readiness gate
(fast, returns the full agent record, discriminates cleanly, honours the timeout), but the
helper must first wait for the record to exist — a bare `agent wait` immediately after the
run fails with `agent_not_found`. Observed readiness for `pi-bolt-child` on this machine is
0.55 s to first record and ~0.9 s to idle, well inside the existing
`childTimeout`/`totalTimeout` budget.

## P4 — how does `pane run` treat argv, and how must Herdsman quote?

**Result: `pane run <PANE_ID> <COMMAND>...` takes a variadic argument list but joins the
elements with single spaces and no quoting, and sends the joined string plus Enter as one
shell line. Herdsman must quote every element itself; a single argv element holding a
fully quoted line preserves the child's argv exactly.**

Fixture: `dump.sh` prints `ARG[<arg>]` per argument plus `COUNT=<n>` to a file.

### P4a — elements containing spaces, a quote, `=`, and a newline, passed as separate argv

```
$ herdr pane run wQ:p1Q /tmp/herdr-probe/dump.sh /tmp/herdr-probe/p4a.out \
    'a b' 'q"uote' 'k=v' $'nl\nline'

$ herdr pane read wQ:p1Q --source recent-unwrapped --lines 40
❯ /tmp/herdr-probe/dump.sh /tmp/herdr-probe/p4a.out a b q"uote k=v nl
  line
```

The elements were re-joined with spaces and typed as one line — spaces split, `=` and `"`
passed through raw, and the embedded newline **split the shell line in two**. The unmatched
`"` left the fish pane waiting at a continuation prompt, and every later `pane run` was
appended to that pending line instead of executing (observed in `p4a-pane.txt` and the pane
view that follows it). No output file was produced.

### P4b — one element containing spaces

```
$ herdr pane run wQ:p1R /tmp/herdr-probe/dump.sh /tmp/herdr-probe/p4b.out "single arg with spaces"
ARG[single] / ARG[arg] / ARG[with] / ARG[spaces] / COUNT=4
```

Confirms: no escaping is applied to elements by `pane run`; the shell re-splits them.

### P4c — shell metacharacters are live

```
$ herdr pane run wQ:p1R /tmp/herdr-probe/dump.sh ... 'meta=$(echo INJECTED)' 'semi;echo SPLIT' \
    'dq"uote' "sq'uote" 'back`tick`' 'star*glob' 'amp&bg' 'lt<redir' 'pipe|cat'

$ herdr pane read wQ:p1R --source recent-unwrapped
bash-5.3$ /tmp/herdr-probe/dump.sh /tmp/herdr-probe/p4c.out meta=$(echo INJECTED) semi;echo SPLIT dq"uote sq'uote back`tick` star*glob amp&bg lt<redir pipe|cat
>                                  # unmatched quote: the line is still open, nothing ran
```

Command substitution, `;`, backticks, globs, `&`, `<` and `|` all reach the pane shell as
live syntax.

### P4d/P4f/P4h — the caller-quoted single line (the safe form)

```
$ herdr pane run wQ:p1R "/tmp/herdr-probe/dump.sh /tmp/herdr-probe/p4d.out 'a b' 'dq\"uote' 'sq'\''uote' 'k=v' 'star*glob' 'semi;echo SPLIT' 'meta=\$(echo INJECTED)' 'back\`tick\`'"
ARG[a b] ARG[dq"uote] ARG[sq'uote] ARG[k=v] ARG[star*glob] ARG[semi;echo SPLIT]
ARG[meta=$(echo INJECTED)] ARG[back`tick`] COUNT=8
```

Realistic launch argv, unquoted join (P4e) versus caller-quoted (P4f), both in plain bash:

```
P4e  ... --system-prompt "/tmp/herdr-probe/prompts/my prompt.md" 'model=omniroute/coder-high'
ARG[/tmp/herdr-probe/prompts/my]      ← broken in two
ARG[prompt.md]
COUNT=12                              ← one extra argument

P4f  same argv, each element single-quoted into ONE shell line
ARG[/tmp/herdr-probe/prompts/my prompt.md] ... COUNT=11   ← exact
```

P4h repeats the caller-quoted realistic line in the untouched **fish** pane `wQ:p1S`
(`--extension <abs path>`, `--system-prompt '<path with spaces>'`, `model=omniroute/coder-high`,
`semi;echo SPLIT`): `COUNT=10` with every element byte-exact.

A literal newline inside a single-quoted element also survives in both shells (P4g in bash,
P4i-retry in fish: `ARG[nl1\nnl2]`, `COUNT=1`), because the shell stays inside the quote —
but that makes the typed text a multi-line input, and the probe caught a shell plugin
(`__abbr_tips_bind_newline` in the owner's fish config) aborting Enter evaluation on one
such line, so a newline-bearing element is the fragile case rather than the ordinary one.

Note: passing the child's own flags (`--no-extensions`, `-e builtin:mcp`, …) as `pane run`
arguments is accepted — `pane run` does not parse them as its options (P4e/P4f) — so no `--`
separator is required.

### P4j — the D6 script-file fallback, verified

```
$ cat /tmp/herdr-probe/launch.sh
#!/usr/bin/env bash
exec /tmp/herdr-probe/dump.sh /tmp/herdr-probe/p4j.out \
  '/home/saurabhj/.nix-profile/bin/pi-bolt-child' \
  '--no-extensions' '-e' 'builtin:mcp' \
  '--extension' '/home/saurabhj/.pi/agent/extensions/herdr-agent-state.ts' \
  '--system-prompt' '/tmp/herdr-probe/prompts/my prompt.md' \
  'model=omniroute/coder-high' 'semi;echo SPLIT' $'nl1\nnl2'

$ herdr pane run wQ:p1R /tmp/herdr-probe/launch.sh
ARG[/home/saurabhj/.nix-profile/bin/pi-bolt-child] ... ARG[nl1\nl2] COUNT=11   ← exact
```

The typed line contains one metacharacter-free path, and the argv — including spaces, `;`
and a newline — lives in the script. This works in any pane shell and is the shell-neutral
fallback design D6 names.

## Cleanup verification

```
$ herdr tab close wQ:tR / wQ:tS / wQ:tT / wQ:tV / wQ:tW / wQ:tX
{"id":"cli:tab:close","result":{"type":"ok"}}   (each)

$ herdr agent list
[('wG:p1Z', None), ('wH:p1', None), ('wW:p1', None), ('wQ:pC', None),
 ('wQ:p1P', 'start-probe_56ec3d05a7129348'), ('wQ:pD', None), ('wS:pW', None),
 ('w14:p1', None), ('w14:pQ', 'bus-listen_d9a3d33ce77f97df')]      # pre-probe set

$ herdr pane list | probe panes          → []
$ herdr tab list  | probe tabs           → []
$ herdr pane get wQ:p1Q…wQ:p1W           → pane_not_found (all six)
$ git status --short                     → only the pre-existing .pi-herdsman/ and
                                           pi-reqcap/ modifications, no probe file
```

Left behind outside the repository, deliberately not deleted (they are not pane, tab or agent
state and deleting them would touch files outside this task's scope): the pi session files
these probe children wrote under `~/.pi/agent/sessions/--tmp--/` and the matching
`~/.pi/agent/sessions/permission-forwarding/serving/<session-id>.json` records, plus the
scratch and transcript directory `/tmp/herdr-probe/`.

## Surprises, and how they read against design.md

1. **D5 / "Unverified, probe-gated": readiness cannot be one `agent wait`.** The wait issued
   immediately after `pane run` fails with `agent_not_found`; stage 2 needs an existence poll
   before (or a retry around) the state wait. Not a gate failure — an implementation
   constraint with measured numbers above.
2. **D5 / Context: the reporter extension, not Herdr's detection, owns the state.** With the
   reporter loaded Herdr reports `screen_detection_skip_reason: full_lifecycle_hook_authority`
   and derives `working`/`idle`/`blocked` from the child's own reports; without it, `idle`
   comes from `default_known_agent_idle_fallback` over screen content. Herdsman passes the
   reporter path when installed, so the reporter path is the normal case — and readiness
   therefore depends on the child's reporting cadence, not on screen scraping. The archived
   no-`report-agent` constraint is untouched: Herdsman still never calls those methods.
3. **P1c: the reported `agent_session` path is prospective.** It is reported at
   `session_start`, before the file exists; the file appears with the first turn. Herdsman's
   `readPiSessionHeaderId` already returns `undefined` for `ENOENT` and
   `matchesExpectedSession` treats that as unresolved (`herdr.ts:1950-1956`), and the same
   holds for the current `agent start` path, so no new behaviour is required. Worth stating
   in stage 2's docs so a future reader does not mistake it for a stage-2 regression.
4. **D6: the join is not argv-safe, and the pane shell is the operator's own.** The typed
   line is parsed by the pane's interactive shell (fish here), so `pane run` failures are
   shell-configuration-sensitive, not just quoting-sensitive. Both the quoted-line form and
   the script-file fallback were verified in the fish pane.
5. **P2: rename must follow registration.** `agent rename` before the record exists returns
   `agent_not_found`, so D4's ordering (readiness, then alias) is required, and an alias
   mismatch is a real failure mode for D5's identity check only if the rename is skipped.
6. No contradiction with stage 1 was found: a child launched by `pane run` with the stage-1
   environment reported exactly the same agent identity shape as an `agent start` child.

## Gate decision (task 4.2)

| Probe | Outcome |
|---|---|
| P1 — is a `pane run` agent visible to `agent get`/`agent list`/`agent explain`, and what registers it? | **Succeed.** Detected both with and without the reporter; the reporter supplies `agent_session` and lifecycle authority. |
| P2 — does `agent rename` apply the Herdsman alias, and what do queries report? | **Succeed.** `name` appears in `agent get` (by alias and by pane) and in `agent list`; persists with the reporter active. |
| P3 — does `agent wait --until` reach readiness, and how long does it take? | **Succeed.** ~0.9 s total from `pane run` to `idle`; needs an existence poll first. |
| P4 — how does `pane run` treat a long argv? | **Settled, not unfavourable.** It is a single shell line: Herdsman must single-quote each element (verified exact in bash and fish) or use the D6 script-file fallback (verified exact). |

**Decision: proceed with stage 2 (tasks group 5).** P1 and P2 both succeed, and the P4
outcome is the one D6 already anticipated — it constrains the implementation (quote the
elements, or write the launch line to a per-launch script and run its path) rather than
blocking it. No design decision is reversed by this probe.

Stage-2 implementation notes carried forward from the evidence:

- Order: `waitForShellMarker` → capture the shell process → `pane run <pane> <quoted line>`
  → poll `agent get <pane>` for the record → `agent wait <pane> --until idle --timeout`
  inside the existing budget → `agent rename <pane> <herdrAgentAlias>` → verify the alias
  through `agent get`. Set `launchMayHaveStarted` after the run reports delivery.
- Failure parity to preserve: `agent_not_found` while polling, `agent wait`'s `timeout`, a
  rename failure and an alias mismatch each need a structured `OperationError` naming the
  stage before `rollbackHerdrStart`.
- Keep the probe's environment note: restart-free rollback is "unset the variable and
  restart the lead"; the fallback for a fragile argv is the D6 script file.

## Stage-2 record (tasks 5.4, 6.1)

**Readiness as implemented.** The forward note above ordered `agent wait <pane> --until idle`
before the rename. Stage 2 issues no `agent wait`: a delegated child receives its assignment
at startup, so it is normally already `working` when the wait is issued, and the wait would
spend the startup budget on the first assignment instead of on startup. Readiness is instead
the record Herdr reports for the pane once it carries `agent_session` or a known
`agent_status`, then the alias is applied and verified. Live on this machine the record
arrived with `agent_session` present while `agent_status` was still `unknown` — the session
half of the predicate is the one that fires first. Decision, quoting rule and rejected
alternatives: `../../../pi-herdsman/docs/adr/0029-run-a-configured-child-in-its-pane.md`.

**Live re-verification (`.pi-herdsman/herdsman-child-command-smoke.mjs`, herdr 0.9.3,
throwaway tabs `wQ:tY`/`wQ:tZ`).** Production `childLaunchLine` output round-tripped
byte-exact through a
real fish pane (spaces, `"`, `'`, `$( )`, backticks, `;`, globs). A real `pi-bolt-child`
typed by `pane run` registered after 5 polls with `agent_session` present,
`agent_status: "unknown"`. `agent rename` applied the alias; `agent get <alias>` and
`agent list` both resolved it. Both tabs closed; no leftover pane or agent.

**Gate (task 6.1, re-run on the final tree).** `npm test` exit 0 (1038 tests / 1037 pass /
0 fail / 1 pre-existing Windows-only skip), `npm run validate` exit 0 (package audit passed,
132 files), `openspec validate --all --strict` exit 0 (18 passed, 0 failed).

**Newline argv (task 5.7, after the first handoff).** The script-file fallback now
covers the one argv quoting cannot carry: an element holding a newline. `childLaunchPlan`
types the quoted line when no element holds `\r` or `\n`, and otherwise writes
`exec <command> <args…>` (mode 0700) under `herdsmanTempRoot()/child-launch/` and types
that path, so the pane receives exactly one input line. The pane's shell reads the file
before the child can register, so the launch retires it in the scope that waits for
registration, on success and on failure alike.

Live (`.pi-herdsman/herdsman-child-command-smoke.mjs`, fish pane `wQ:t13`): the dump child
reported `ARG[a b] / ARG[nl1\nnl2] / ARG[after] / COUNT=3` byte-exact, the typed line held
no newline, the script and its directory were gone after the launch, and the same pane
answered a later readiness marker — nothing was left holding an unterminated command.
Red evidence: removing the newline branch fails "an argument holding a newline is run from
a script the pane types as one line" and "a launch script reproduces a newline argument
byte-exact".

**The isolated smoke cannot start on this machine (task 6.2, measured).** Two independent
prerequisites fail before any scenario runs. First, `scripts/smoke.mjs` calls
`pi auth check --model <model> --no-refresh` with a 30 s command timeout and retries it
once through a symlinked `auth.json`; the installed Pi 1.0.3 rejects `--no-refresh` as an
unknown option (exit 1), and with a temporary PATH shim stripping the flag the bare check
still had not returned after 60 s (exit 124) or 120 s (timeout). The repository's stated Pi
contract is 0.99.2, which is where that flag lives. Second, the candidate is launched with
`--no-extensions` in an isolated Pi agent directory, so the operator's `omniroute` provider
extension cannot load there and `--settings` supplies values only: `omniroute/coder-high`
is unresolvable inside the candidate. The model key `pi-herdsman.smoke-model` was therefore
never the blocker. The requested model needs either ambient-credential resolution inside
the isolated Pi directory or a harness change to its extension isolation; both are outside
this slice. No permanent configuration was changed while establishing this: the shim, the
wrapper and the candidate directory all live under `/tmp`.
