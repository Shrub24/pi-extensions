# Accept an older owner's request shape at the mailbox boundary

## Decision

A V5 task or interrupt request that carries no `briefProfile` is accepted, and
the accepted assignment is validated against the profile the worker was launched
with (`PI_HERDSMAN_BRIEF_PROFILE`) instead of being rejected. A profile that is
present but unknown is still rejected, a brief claiming less than the profile in
force is still rejected, and the write boundary stays strict: an owner writing a
request always states the profile.

## Rationale

A worker loads the extension from the checkout when it launches, while an owner
keeps the code it started with. Requiring the field at the receiving boundary
therefore made every launch from an already-running owner a rejected request.
Observed live: an owner started hours earlier wrote requests without the field,
each freshly launched worker rejected them, and because the rejection recorded no
acknowledgement the owner saw only `Timed out waiting for agent state`, a
rollback and a lost generation. A required field at this boundary is a breaking
change for every owner already running, and it fails invisibly.

## Alternatives rejected

- Require the field and reload the owner: a lead session runs for hours or days,
  so every launch in that window fails, and the failure does not explain itself.
- Bump the mailbox protocol version: both sides report V5, so the version cannot
  distinguish the two shapes; refusing the older owner's whole protocol is a
  larger break for the same problem.
- Fall back to `common` whenever the field is missing: that would let a legacy
  request claim less than the worker was launched with. The worker's own launch
  profile is available and is the honest floor.
- Trust the accepted assignment's own profile instead: the assignment is written
  by the same owner, so it repeats the claim rather than corroborating it.

## Consequences

- A request from an older owner cannot state its profile, and also cannot lower
  the floor: when no profile is stated, the floor is the profile the worker was
  launched with, so the guarantee is at least as strong as it was before the
  field existed.
- The write boundary keeps its check, so a current owner still states the profile
  and a mismatch between a request and its assignment is still caught.
- The same rule governs any field added to a mailbox request later. A required
  field is only safe when both sides are reloaded together, which a long-lived
  owner makes impossible.
- A rejection is never silent. A rejected request whose acknowledgement cannot be
  written is now recorded durably, and the rejection message carries the real
  reason, because an unacknowledged rejection reaches the owner as a bare
  timeout.
- The floor applies to every child-side read of a request, not only the final
  delivery read. The first fix covered the control-marker handler alone; the
  startup pump reads through `readUnacknowledgedRequest`, which had no fallback,
  so a profile-less request was never delivered, no first message was sent and
  the owner timed out. Any new child-side reader must take the same option.

## See also

- [Require versioned assignment briefs](0015-require-versioned-assignment-briefs.md)
- [Validate results against response contracts](0016-validate-results-against-response-contracts.md)
- [Retain workers across assignments](0013-retain-workers-across-assignments.md)
