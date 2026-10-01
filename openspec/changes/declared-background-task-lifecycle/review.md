# Planning validation and review

## Structural validation

`openspec validate declared-background-task-lifecycle --strict` passed initially and again after the two corrections below. OpenSpec reports the four planning artifacts complete. This is artifact completeness, not implementation evidence; all task boxes remain unchecked.

## Independent review status

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

## Implementation evidence and next gate

None. No runtime implementation or live new-model tests were performed. The source-map's 160-pass baseline is child-reported evidence of existing code, not verification of this proposal.

The handoff is drafted and structurally validated, with reported concerns corrected. Independent review is complete and the planning handoff is ready for delegation. Implementation still requires authorization. Residual implementation risks are the new session-private bridge, output/retention races, safe removal ordering, and Pi's already-submitted wake limitation; they remain covered by the acceptance matrix or deferred scope, not claimed as implemented.
