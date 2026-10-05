# Proposal

## Why

Herdsman's health attention catches only *inactive* workers: a worker that spends half an hour in productive-looking discovery never wakes its lead, and a lead idling on long assignments lets its prompt cache lapse with no checkpoint to steer drift. Separately, every managed worker is torn down after one assignment, so the persistent, compacting workers this fork is built around (`contextRetirement: false`) lose their live process, pane, and warm state between assignments.

## What Changes

- **Lead soft deadline.** Each accepted assignment (`agent_delegate`, `agent_continue`) arms an elapsed-time window (`softTimeoutMs`, default 300000; `0` disables). When windows expire, the idle lead receives one digest per health scan listing every overdue worker, with the controls each currently allows. Windows re-arm after every digest, so a long assignment yields a checkpoint every window until it resolves. The deadline is advisory: it never aborts, steers, or closes anything.
- **`agent_extend`.** A new controller tool that sets a longer next window for one working worker, listed in `available_tools` only while that worker has an armed window.
- **Soft-deadline event seam.** Before each digest is delivered, Herdsman emits it on Pi's extension event bus so another extension can annotate the digest. No consumer ships in this change.
- **Retained workers.** A `retainWorkers` setting keeps a worker's process and pane alive after its result is delivered, bound to its agent label, in a new public `idle` state. `agent_continue` on that worker's session sends the next assignment into the same live process. If the worker's effective definition changed since launch, Herdsman instead closes it and continues the session in a fresh process, and says so in the result.
- **Release.** `agent_close` releases an idle retained worker; `/agents` gains a `Clear idle` action that closes every idle retained worker the lead owns.
- **BREAKING (fork contract):** with `retainWorkers` enabled, a managed process may serve more than one assignment. Upstream's "one generation receives exactly one assignment" and "continuation never assigns work to an existing agent" no longer hold for retained workers; the docs and SKILL guidance are rewritten accordingly. With the setting off, behaviour is upstream's.

## Capabilities

### New Capabilities

- `herdsman-soft-deadline`: elapsed-time assignment windows on the owning controller, digest delivery to an idle lead, periodic re-arming, `agent_extend`, restart durability, and the pre-delivery event seam.
- `herdsman-retained-workers`: post-result retention of live workers, the `idle` public state, same-process continuation, definition-drift fallback, release through `agent_close` and `/agents`, and restart recovery of retained workers.

### Modified Capabilities

None. The OpenSpec capability inventory has no Herdsman specs yet.

## Impact

All code changes are in `pi-herdsman/extension/`: `index.ts` (health scanner, result cleanup path, `agent_continue` admission, child task admission, tool registrations, `/agents` menu, controller recovery), `config.ts` (two keys), `core.ts` (`idle` projection), `presentation.ts` (digest renderer, `idle` glyph), and their tests. Docs: `docs/concepts/lifecycle.md`, `docs/concepts/agents.md`, `docs/reference/{agent,agent-states,configuration,commands,status-widget}.md`, `docs/guides/{recovery,handoffs}.md`, `SKILL.md`, and a fork ADR. No mailbox schema change, no new dependency, no Pi or Herdr patch. `pi-jev` is not modified.
