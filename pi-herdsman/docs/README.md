# Pi Herdsman documentation

[Repository README](../README.md)

Choose the shortest path that matches what you are trying to do. Exact behavior
lives on one canonical concept or reference page so entry pages stay small and
do not drift into competing contracts.

## New to Pi Herdsman?

Start with [Getting started](getting-started.md).

It covers installation, the first asynchronous Agent delegation, `/agents`,
configuration, and where to go next.

## Orchestrate project work

Use [Project orchestration](guides/project-orchestration.md) to coordinate
independent branch-based work through Manager and multiple Leads.

Read [Coordination](concepts/coordination.md) when you need the underlying role,
authority, project-scope, and ownership model.

## Understand Agents

- [Agents and identity](concepts/agents.md)
- [Delegation](concepts/delegation.md)
- [Lifecycle](concepts/lifecycle.md)
- [Handoffs and files](guides/handoffs.md)
- [Recovery](guides/recovery.md)

## Customize Pi Herdsman

- [Agent definitions](guides/agent-definitions.md)
- [Customizing bundled Agents](guides/customizing-agents.md)
- [Agent-definition schema](reference/agent-definition-schema.md)
- [Configuration](reference/configuration.md)
- [Container deployment](guides/container-deployment.md)

## Use the coordination API

Start with [Coordination API](coordination-api.md), then use the focused
references for exact contracts:

- [Agent tools](reference/agent.md)
- [`ask_owner`](reference/ask-owner.md)
- [Staff tools](reference/staff.md)
- [Supervisor tools](reference/supervisor.md)
- [Peer tools](reference/peer.md)
- [Agent states](reference/agent-states.md)
- [Pane metadata and hierarchy](reference/pane-metadata.md)
- [Herdsman control](reference/herdsman-control.md)
- [Errors](reference/errors.md)

Human-facing surfaces are documented separately:

- [Commands](reference/commands.md)
- [Status widget](reference/status-widget.md)

## Develop Pi Herdsman

Maintainer-only material stays separate from product use:

- [Validation](development/validation.md)
- [Smoke testing](development/smoke-testing.md)
- [Documentation maintenance](development/documentation.md)
- [Instruction and interface design](development/instruction-interface-design.md)

## Architecture decisions

[Architecture decision records](adr/) capture decisions that constrain the
implementation, including the upstream behavior a fork decision supersedes.

- [0013 Retain workers across assignments](adr/0013-retain-workers-across-assignments.md)
- [0014 Advisory soft-deadline checkpoints](adr/0014-advisory-soft-deadline-checkpoints.md)
- [0015 Require versioned assignment briefs](adr/0015-require-versioned-assignment-briefs.md)
- [0016 Validate results against response contracts](adr/0016-validate-results-against-response-contracts.md)
- [0017 Publish pane facts without owning sidebar presentation](adr/0017-publish-pane-facts-without-owning-sidebar-presentation.md)
- [0018 Do not request constrained tool sampling](adr/0018-do-not-request-constrained-tool-sampling.md)
- [0019 Correct a finished answer before failing it](adr/0019-correct-a-finished-answer-before-failing-it.md)
- [0020 Gate an armed window on live presence](adr/0020-gate-an-armed-window-on-live-presence.md)
- [0021 Recover a held settlement without a wake](adr/0021-recover-a-held-settlement-without-a-wake.md)
- [0022 Accept an older owner's request shape](adr/0022-accept-an-older-owners-request-shape.md)
- [0023 Carry finished results into the next assignment](adr/0023-carry-finished-results-into-the-next-assignment.md)

The repository directories are organized by content type. The index is
task-first so readers do not need to understand that structure before finding
the right page.
