# Background-work registration: managed startup fix

## Confirmed cause

Managed pane creation succeeded, then Herdsman's task-admission handshake rejected the background-work provider reply as `stale-reply: reply does not match a current registration`. Startup rollback closed the pane.

Pi constructs a distinct `pi.events` facade for each extension over one underlying event bus (`pi-coding-agent/dist/core/extensions/loader.js`, `createExtensionAPI`). The background-work seam previously placed its shared identity only on the facade using a symbol; the consumer facade did not contain the provider's symbol slot. Our single-bus test fakes missed this boundary.

## Repair

Live registrations answer a synchronous registration-discovery channel. Consumers discover the identity through the shared event transport rather than assuming facade object identity. Existing reply identity, duplicate-provider, stale-reply, disposal and synchronous-query checks remain. Discovery subscriptions are removed when the registration is disposed. The provider's local slot remains evidence for a missing reply if its subscriptions disappear.

Rejected alternative: accepting a reply without validating its current registration would hide stale or disposed providers rather than fix the identity boundary. A Herdr integration plugin does not address this session-local handshake and is not needed for the repair.

## Verification

- Before repair: a regression loading two factories with Pi's real SDK failed with the exact production `stale-reply` error.
- After repair: background-work protocol suite, 34 pass / 0 fail. Covers cross-facade bind/protect/snapshot/duplicate-registration/disposal and existing fail-closed behavior.
- Isolated pi-bash-processes package suite: 341 pass / 0 fail, exit 0 (includes eight partial pane-facts tests; lifecycle wiring remains delegated work).
- Original managed startup probe accepted and completed: result:startup-probe#1. Worker session `01a10c18-e0dc-7459-925e-3dd377f53cef`, pane `wQ:pT`, same tab `wQ:tD`, workspace `wQ`. Durable probe artifact `.pi-herdsman/startup-probe.md`.

## Placement

Operator `spawnPlacement` was changed from the default subtree behavior to split during diagnosis. The successful probe stayed in the owner's tab. This is operator configuration, not a repository default change.

## Remaining work

Two separately scoped workers own background task pane facts and Herdsman awaited facts. The registry repair's source and test files are excluded from their edit scope. No separate Herdr publisher plugin is included.
