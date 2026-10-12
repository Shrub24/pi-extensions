# Publish pane facts without owning sidebar presentation

Status: superseded by [ADR 0031](0031-publish-agent-facts-to-the-radar-daemon-registry.md)

The official Herdr Pi integration owns semantic state and session reporting. Herdsman absorbs pi-herdr's session metadata and publishes delegation facts under its own sources. pi-herdr is retired, not forked; Herdsman's widget stays intact.

Workers remain Herdr agents. Each advertises its exact session and direct owner session. The owner separately advertises its public worker projection with a short TTL, including loss that a dead worker cannot report. No parent-held child lists or pre-rendered rows are needed.

Herdr-radar owns ordering, grouping and rendering. Herdsman neither writes nor clears Radar's tokens. The contract and fixture that defined that seam were removed with the publisher.

## Superseded

The pane-metadata publisher this ADR introduced no longer exists. Terminal
metadata was a display projection of facts that live in the mailbox and the
registry, and the Herdr-free cutover removed the publisher, its tokens and its
contract document rather than keep a Herdr-only mirror of assignment facts. The
facts themselves are unchanged; where they are published is
[ADR 0031](0031-publish-agent-facts-to-the-radar-daemon-registry.md).
