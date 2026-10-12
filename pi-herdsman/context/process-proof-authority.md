# Process proof authority

## Process proof decides relaunch and retirement

**Id:** b432ee41-ae77-4cec-8497-f13abce44f1c
**Type:** decision
**Status:** active
**Evidence:** confirmed
**Source:** owner rulings D1–D4 and the authority rule, relaunch slice (`.pi-herdsman/relaunch-slice.md`, sections 12–14); recorded as ADR 0035
**Revisit when:** the live disposable-tmux check disagrees with the fake daemon's verdicts, the Herdr removal changes how presence is read, or Radar changes what `agent.get` reports

Only a process verdict of `absent` or `mismatched` may relaunch a child or retire it
by close. Close outcomes and listing state never decide either way.

The gate exists to protect a process we cannot prove dead. A refused relaunch costs
a visible wait; a relaunch of a process that is still running can double the work,
and a listing or close record cannot tell the two apart. Where the proof cannot be
had, the child stays stuck, and the hint says so instead of offering close.

**Reason:** an earlier build let a stored close, a missing pane or a non-idle listing
decide, so a child could be relaunched or abandoned while its process was still
alive. A child whose presence could never be proved then sat with an outstanding
assignment and no notice, which is a permanent invisible dead end. A visible refusal
with the reason named is better than that.

**Rejected alternative:** let an unproved child with an outstanding assignment offer
`agent_close` as the way out. Close refuses there, so the hint would promise an
action the system refuses in exactly that state. The hint was corrected; the refusal
was not relaxed.
