# Proposal

## Why

Herdr's sidebar can show rich agent rows, but Herdsman advertises little: its workers publish a few display tokens, leads publish role tokens, and nothing tells Herdr how agents relate. Herdsman's own states (settling, lost, retained idle, waiting) and its parent/child delegation structure exist only inside Pi, so a custom sidebar (herdr-radar) cannot show them.

Today three writers also overlap on one pane. The Herdr-installed Pi integration is the semantic-state authority. pi-herdr (third party) additionally writes `model`, `provider`, `thinking`, `session` and `context_usage` tokens. Herdsman's workers write bare `model` and `thinking` tokens of their own, so the same token names come from two sources. Herdsman also hard-codes the path of the Herdr-installed extension while the documented install step is not done on every machine.

## What Changes

- Make the **official Herdr Pi integration the only semantic-state and session authority**. Herdsman never reports `idle/working/blocked` itself. The user retires pi-herdr; this change does not modify pi-herdr.
- Make **Herdsman the only display-metadata publisher** for Pi panes it runs in. Port pi-herdr's session-self metadata (model, provider, thinking, session name, context usage) into one internal, delegation-independent publisher module (MIT, with attribution) used by both lead and managed-worker roles. Remove the overlapping worker `model`, `thinking` and `ctx` tokens in favour of it.
- Publish **hierarchy facts as one-way child-to-parent pointers** using stable Pi session identities: each pane publishes its own session id and, when it is a managed worker, its direct owner's session id. No child lists, no depth, no ordering or glyphs. Consumers derive the tree.
- Publish the **owner's view of each worker** (the public projection state, including `lost`) onto the worker's pane under a separate, time-bounded source, because a dead worker cannot report its own loss.
- Put all orchestration facts under a `pi_herdsman_` token prefix and document the full contract, including a radar-side fixture, so herdr-radar can render the tree and presentation.
- Stop depending on the hard-coded Herdr extension path where Pi's own extension discovery already loads the installed integration, after verifying the launch arguments.
- **BREAKING (token names):** bare worker tokens `managed`, `role`, `request`, `task`, `started`, `ctx`, `model`, `thinking` are renamed or removed. Consumers (herdr-radar, sidebar row layouts) must follow the published contract.

## Capabilities

### New Capabilities

- `herdsman-pane-metadata`: one Herdsman-owned metadata publisher per pane with a documented token contract, session-self tokens, gating, bounded/refreshed publication and shutdown clearing, and the retirement of overlapping publishers.
- `herdsman-agent-hierarchy`: parent/child identity tokens from stable session identities and owner-published projection state, including loss, without presentation concerns.

### Modified Capabilities

None. The main capability inventory is empty. This change depends on the lead-orchestration implementation (worker projection states, lead role, retained workers) and interacts with `herdsman-background-handoffs`, which adds a public `waiting` projection state.

## Impact

- `pi-herdsman/extension/herdr.ts` (lead metadata arguments, launch arguments) and `extension/index.ts` (worker metadata state/flush at the metadata section, lead metadata queue, role resolution, shutdown clear, owner scanner). `index.ts` is the file the background-handoffs implementation is editing now; see design sequencing.
- A new small module under `pi-herdsman/extension/` for session-self metadata and token formatting, with deterministic tests that stub the Herdr runner.
- Docs: README install step (official integration required; pi-herdr retirement), token contract reference, agent-states reference cross-link, and an ADR recording state/metadata ownership.
- herdr-radar (separate fork, developed alongside): consumes the contract. Radar changes are not part of this change; only the contract and a fixture are.
- No Pi-core, Herdr or herdr-radar source changes. Runtime smokes (a live Herdr sidebar) are user-owned.
