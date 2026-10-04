# Validation and review

## Structural validation

`openspec validate declared-background-task-lifecycle --strict` passed initially and again after the two corrections below. OpenSpec reports the four planning artifacts complete. This was planning-artifact completeness, not runtime evidence; no implementation task was complete at that gate. Final implementation acceptance is recorded below.

## Independent planning review status

**Complete — independent final verdict: OK. No issues found.** The original report is preserved verbatim in `plan-review.md`; the final re-check is preserved in `plan-review-final.md`. Both P1 contract conflicts and all three P2 refinements were independently confirmed resolved. This approves the planning handoff, not an unimplemented runtime or an implementation launch.

- Recon workflow: `28b8ea73-eed2-4228-bedc-cf7d9cf22c6f`; source-map child: `a75f0214-4f0c-451b-8ae7-92b6b1f745c5`. Durable source copy is `context.md`.
- Initial oracle `4f0cb532-0b22-4019-ad3a-72ca4b1fc7f0` returned a not-reviewed readiness checkpoint.
- Resumed oracle `cc21ae5e-8d17-47e9-82a6-b4321a19cb6e` reported reading all seven artifacts and raised the CLI pipe boundary and mode-specific prompt concerns via supervisor dialogue. It returned another waiting checkpoint, not findings plus a verdict.
- The next same-role resume `22008fe4-6df9-42e8-b5bb-a883450eeb0f` failed before returning the verdict. Status confirms `failed`, process terminal observed, acceptance rejected. Exact provider error: **“The ChatGPT user has reached their Subscription Sharing usage limit. Ask the user to try again after their usage limit resets or use an API key instead.”**
- Failed run directory: `/tmp/pi-subagents-uid-1000/async-subagent-runs/22008fe4-6df9-42e8-b5bb-a883450eeb0f`. Bound report path: `/home/saurabhj/.pi/agent/sessions/--home-saurabhj-Projects-dev-custom-pi-extensions--/subagent-artifacts/outputs/28b8ea73-eed2-4228-bedc-cf7d9cf22c6f/background-task-plan-review.md`; its existing checkpoint text is **not** a final review report.
- Owner explicitly selected **Different review model** through the review-gate question. A fresh oracle request for `omniroute/cheaperinference/claude-opus-5.5-high` was rejected before launch by global `modelScope`; `omniroute/coder-high` on oracle was then rejected by `modelScope.agents.oracle`, which permits only `openai/gpt-6.1-sol`. Neither rejected request launched a child. The partial jj diff was captured before the same-protocol retry.
- The approved alternate review ran as **delegate configured for a read-only plan-review role**, model `omniroute/coder-high`, fresh context, run `86808c39-5431-4c8d-9761-6d1b796682ef`, bound report `background-task-plan-alternate-review.md`. This changes the configured agent label, not the protocol or review goal; there are no agent-config edits or external/foreground runner fallbacks. Its actual output and same-role final re-check have now been consumed; see the dispositions below.

## Alternate-model findings and disposition

Reviewer `86808c39-5431-4c8d-9761-6d1b796682ef` returned a substantive review, labeled BLOCK with no P0, two P1 contract conflicts, and three P2 refinements. In this planning gate, the parent requires concrete P1 contradictions resolved before authorizing implementation. The report is preserved unchanged in `plan-review.md` and is superseded only by the re-check outcome, not rewritten as an initial pass.

- **P1-1:** explicit TUI disposition of bg_status and effective prompt/schema agreement. Corrected in design/spec/tasks/handoff: TUI registers only bg_task spawn/get/stop/list, not bg_status. Other modes retain bg_status compatibility through shared operations. Shared installed guidance names neither absent bg_status nor wait action; supported mode-specific session guidance supplies TUI push waiting and other modes' named bounded-wait compatibility.
- **P1-2:** proposal's broad “no stdout/stderr separation” clause contradicted raw-output stdout/metadata stderr. Corrected to exclude only stream-separated captured-command logs; CLI separation explicitly required.
- **P2-a:** named existing foregroundYieldMs, defaultTimeoutSeconds/timeoutSeconds, defaultSoftTimeoutMs. No new setting/default.
- **P2-b:** spec now qualifies pi-bg for supported POSIX hosts and preserves existing Pi-tool platforms; no new Windows CLI.
- **P2-c:** accepted-token retry reports committed outcome through task retention, then explicit task expiry; only unaccepted preparation expires without ack/review.
- Added the recommended early two-session/managed-bash CLI bridge fixture gate before replacing the receipt channel.
- Reviewer could not find the review-policy skill at its advertised .agents path; the parent read the installed house policy at `/home/saurabhj/.pi/agent/skills/review-policy/SKILL.md` and supplied that correction for the re-check. This is a reviewer-environment note, not a repo defect.

Same-reviewer authoritative resume for the bounded final re-check: `8eb7397e-26dd-4ab2-bd8d-254e04185d87`. The returned verdict is **OK**, with **No issues found**. It confirmed all five prior findings resolved and the bridge fixture recommendation adopted; it also independently ran strict OpenSpec validation. The parent consumed the result and preserved its bound output as `plan-review-final.md`. No new broad review or runtime tests were launched by the parent.

## Earlier reported concerns and parent disposition

These are captured supervisor concerns, not a reconstructed or fabricated final oracle verdict.

### CLI successful-handoff boundary — corrected

Concern: `design.md` successful-handoff prose and the full-output spec left `pi-bg get ID --output | head` ambiguous. A worker could acknowledge before completing the output, losing a completion obligation after EPIPE.

Decision: finish the requested stdout write/stream without detected error before sending the internal success receipt. EPIPE, snapshot/open/write failure, or disconnect before receipt acceptance does not acknowledge completion or reset a running review clock. A short stream successfully written before the consumer closes is successful delivery; no consumer-read certification is claimed. Accepted receipts retry idempotently; an ambiguous confirmation is not a distributed exactly-once guarantee.

Applied to `design.md` decisions 3–4, full-output scenarios in `specs/background-task-retrieval/spec.md`, task 2.4, and the handoff's locked contract/CLI acceptance row. Covers both preview and full output.

### Shared guidance could break current child waiting — corrected

Concern: retaining a callable legacy wait alone is insufficient if the shared installed `instructions.md` tells every caller to end its response and await a wake. Current children can dispose the session with shell work still pending.

Decision: use `ctx.mode`, not hasUI, for mode-specific schema and guidance. Shared append-system text remains mode-neutral with the child/headless compatibility exception; TUI push-wait recommendations use a supported per-session prompt contribution. Do not dynamically rewrite a shared user instruction file. Test the effective prompt AND model-visible schema for tui/print/json/rpc/unknown.

Applied to `design.md` decision 1, compatibility scenarios in the spec, task 4.5, and the handoff contract/model-surface acceptance row. No pi-subagents runtime changes are included.

## Repo/cwd and partial-diff evidence

Repository/cwd: `/home/saurabhj/Projects/dev/custom/pi-extensions`; existing jj workspace, no extra worktree. Baseline captured before planning: commit `e932b20d310d`, change `srsuqtxkqllk`. Latest validation capture after corrections: same change, commit `9b8d69851f0c1b43285dc9d346f79dbe35afd225`, no bookmark on `@`. This commit identity is a snapshot and changes as files are authored.

At that capture, `jj --no-pager diff --from e932b20d310d --to @ --summary` contained only nine added files under this change directory. The original and final independent review reports were subsequently added in the same directory. Existing owner bash/codemode/OpenSpec scaffolding remains untouched. The working copy is intentionally not clean; no reset, commit, or push was performed. Recheck the actual diff before a retry or implementation because other sessions can change this shared workspace.

## Implementation acceptance — 2026-10-02

**Accepted by the parent: OK with notes, no P0/P1 blockers. All 27 tasks are verified.**
The initial implementation review returned BLOCK; its concrete corrections and the
previously missing current-host/codemode evidence were independently rechecked before
5.4 was marked complete. The planning approval above is not used as runtime evidence.

- Dirty implementation INPUT: `d5a595a3a4c39e6cf408b5404585fd1795777272`.
- Pre-fix capture: `a6e0d76cb9e2a95ba18eeed75d7141753c72bd2c`.
- Interrupted correction snapshot: `07bfef9767dd0c2f96ffaedd508adcadf8a101d9`.
- Verified working-copy snapshot: `4d3fe9d3a316a660eb61c7c888a3a37c38e8cc53`, jj change
  `mqzsqmrowvuq`. Subsequent parent changes are acceptance/provenance documentation only;
  the tested implementation has not changed.
- Final native workflow: `c93646dc-813a-4c64-ae0c-bd42b0749fb4`.
- Current-profile recovery writer: `3d25a0a4-7da5-4d27-ba22-9c83106e6c44`.
- Fresh read-only reviewer: `e00f8a49-c1bf-48bd-8603-f0072b0cfbaf`, verdict **OK with notes**.
  The owner approved fresh profiles after the retained worker's obsolete `mcp:semble`
  contract was rejected before launch; no MCP/profile/global configuration was changed.

### Bound reports and raw evidence

Artifact root:
`/home/saurabhj/.pi/agent/sessions/--home-saurabhj-Projects-dev-custom-pi-extensions--/subagent-artifacts/outputs/c93646dc-813a-4c64-ae0c-bd42b0749fb4/`.

- `background-task-current-profile-recovery.md`: correction/acceptance-matrix evidence.
- `background-task-current-profile-independent-recheck.md`: independent findings and verdict.
- Corresponding `.original.md` files preserve the authored reports before parent provenance
  corrections; no verdict or test result was rewritten.
- `evidence-final/manifest.json`: source fingerprints, host identity, and SHA-256/byte counts
  for 50 retained native records, harness files, and suite logs. These copies preserve the
  evidence independently of the original `/tmp` paths.

Both writer and reviewer obtained these terminal results on the unchanged implementation:

| Suite | Pass | Fail | Exit |
| --- | ---: | ---: | ---: |
| pi-bash-processes | 255 | 0 | 0 |
| pi-output-policy | 42 | 0 | 0 |
| pi-tool-renderer | 176 | 0 | 0 |

Strict change validation passed. The parent also checked the terminal structured workflow
gates, parsed the retained counts/exits, and confirmed no scoped drift from the verified
snapshot. Renderer changes belong to another owner and were not edited by this lane.

### Current-host evidence and provenance corrections

Host: `/nix/store/qmnwmkpw9ajnq824vqmy7s9lbmfi4ql3-pi-0.99.2/bin/pi`, version `0.99.2`.
The local scripted provider drove genuine root model calls with `builtin:codemode`
explicitly loaded; the SDK, sandbox, tool pipeline and extension were real. Records prove
structured foreground bash, intent validation, refusal of script-managed spawn with no
second task, yield/get, bounded compatibility waiting, progress/completion wakes, confirmed
stop, and cleanup. This tests the runtime, not an actual model's adherence.

Real TUI registry/prompt records show exactly spawn/get/stop/list and no bg_status; json
retains the compatibility surface, with print/rpc/unknown covered by fixtures. TUI tool
execution itself was not driven interactively; real-process behaviour was exercised in
json mode. That limit is not represented as a manual TUI pass.

Two reporting errors were corrected without rerunning valid experiments: the source freeze
includes `wake-events.ts` at 02:42:33 local (UTC+10), before the first probe at 02:46:42;
and the pre-fix bundle identity is `a6e0d76c…`, not the later `07bfef97…` interruption.
Original reports remain available above.

### Nonblocking notes and deferred scope

- No direct TUI-mode user_bash acknowledgement assertion; mode selection and helper text
  are covered separately. The reviewer classified this as a P2 coverage note, not a bug.
- Already-submitted Pi messages cannot be selectively withdrawn through the extension API;
  only extension-held wakes are cancelled.
- Crash/receipt-acceptance and retention-expiry limits remain documented; this is not a
  distributed exactly-once guarantee.
- The bounded compiler check has zero free-identifier diagnostics, not a strict-clean
  package typecheck. No typecheck framework was added.
- Child/headless bounded waiting remains callable. The pending-shell/subagent lifetime
  bridge and Pi-core selective message cancellation remain deferred; neither was implemented.

The implementation scope is pi-bash-processes plus this change's documentation. No
pi-subagents/Pi-core/Nix change, dependency repair, commit, push, or archive was performed.
Restart Pi to load the changed extension into an existing session.
